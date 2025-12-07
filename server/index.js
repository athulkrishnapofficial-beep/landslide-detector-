const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// --- 1. DATA FETCHING ---

const fetchWeather = async (lat, lon) => {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m`;
        const response = await axios.get(url);
        const current = response.data.current;
        
        return { 
            temp: current.temperature_2m, 
            humidity: current.relative_humidity_2m, 
            rain: current.precipitation * 10,
            precip_real: current.precipitation,
            code: current.weather_code,
            windSpeed: current.wind_speed_10m || 0
        }; 
    } catch (e) {
        console.error("Weather API Error", e.message);
        return { temp: 25, humidity: 50, rain: 0, precip_real: 0, code: 0, windSpeed: 0 }; 
    }
};

const fetchSoil = async (lat, lon) => {
    try {
        const url = `https://rest.isric.org/soilgrids/v2.0/properties/query?lat=${lat}&lon=${lon}&property=bdod&property=clay&property=sand&property=soc&depth=0-5cm`;
        const response = await axios.get(url);
        
        const layers = response.data.properties.layers;
        const getVal = (name) => {
            const layer = layers.find(l => l.name === name);
            if (!layer) return 0;
            return layer.depths[0].values.mean;
        };

        let clay = getVal('clay');
        let sand = getVal('sand');
        let bulk_density = getVal('bdod');
        let organic = getVal('soc') || 0;

        if (!clay && !sand && !bulk_density) {
            return { bulk_density: 0, clay: 0, sand: 0, silt: 0, organic: 0, isWater: true };
        }

        clay = clay / 10;
        sand = sand / 10;
        organic = organic / 10;
        let silt = 100 - clay - sand;
        if (silt < 0) silt = 0;

        return { bulk_density, clay, sand, silt, organic, isWater: false };
    } catch (e) {
        return { bulk_density: 130, clay: 33, sand: 33, silt: 34, organic: 2, isWater: false }; 
    }
};

const calculateSlope = async (lat, lon) => {
    try {
        const offset = 0.002; 
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat},${lat + offset},${lat}&longitude=${lon},${lon},${lon + offset}`;
        const response = await axios.get(url);
        const elevations = response.data.elevation;

        const h0 = elevations[0];     
        const hNorth = elevations[1]; 
        const hEast = elevations[2];  
        const dist = 220; 
        const dz_dx = (hEast - h0) / dist;
        const dz_dy = (hNorth - h0) / dist;
        const rise = Math.sqrt(dz_dx*dz_dx + dz_dy*dz_dy);
        const slopeDeg = Math.atan(rise) * (180 / Math.PI);

        return { elevation: h0, slope: parseFloat(slopeDeg.toFixed(1)) };
    } catch (e) {
        return { elevation: 0, slope: 0 };
    }
};

// --- 2. CLASSIFICATION HELPERS ---

const classifySoilType = (clay, sand, silt) => {
    if (clay >= 40) {
        if (sand <= 45 && silt < 40) return "Clay";
        if (sand > 45) return "Sandy Clay";
        return "Silty Clay";
    }
    if (clay >= 27 && clay < 40) {
        if (sand <= 20) return "Silty Clay Loam";
        if (sand > 45) return "Sandy Clay Loam";
        return "Clay Loam";
    }
    if (sand >= 85 && clay <= 10) return "Sand";
    if (sand >= 70 && sand < 85 && clay <= 15) return "Loamy Sand";
    if (clay < 20) {
        if (sand > 52) return "Sandy Loam";
        if (silt >= 80) return "Silt";
        if (silt >= 50) return "Silt Loam";
        return "Loam";
    }
    return "Loam";
};

const interpretWeatherCode = (code) => {
    if (code === 0) return { desc: "Clear sky", severity: 0 };
    if ([1, 2, 3].includes(code)) return { desc: "Partly cloudy", severity: 0 };
    if ([45, 48].includes(code)) return { desc: "Fog", severity: 1 };
    if ([51, 53, 55, 56, 57].includes(code)) return { desc: "Drizzle", severity: 1 };
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { desc: "Rain", severity: 2 };
    if ([71, 73, 75, 77, 85, 86].includes(code)) return { desc: "Snow", severity: 3 };
    if ([95, 96, 99].includes(code)) return { desc: "Thunderstorm", severity: 4 };
    return { desc: "Unknown", severity: 0 };
};

// --- 3. SOIL PHYSICS CALCULATOR ---

const calculateSoilProperties = (clay, sand, silt, bulk_density, organic, temp, humidity, rain) => {
    const fClay = clay / 100;
    const fSand = sand / 100;
    const fSilt = silt / 100;
    const fOrganic = Math.min(organic / 100, 0.15);

    // BASE COHESION (kPa) - varies significantly by soil type
    let c_base = 0;
    if (fClay > 0.5) {
        // High clay = high cohesion when dry, but loses it when wet
        c_base = 25 + (fClay * 50); // 37.5 to 75 kPa
    } else if (fClay > 0.3) {
        c_base = 15 + (fClay * 40); // 27 to 55 kPa
    } else if (fSilt > 0.5) {
        c_base = 8 + (fSilt * 20); // 18 to 28 kPa
    } else if (fSand > 0.7) {
        c_base = 0.5 + (fSand * 3); // 2.6 to 3.5 kPa (very low)
    } else {
        // Loam - balanced
        c_base = 10 + (fClay * 25) + (fSilt * 10);
    }

    // BASE FRICTION ANGLE (degrees)
    let phi_base = 0;
    if (fSand > 0.7) {
        // Sandy soil = high friction angle
        phi_base = 32 + (fSand * 6); // 36 to 38 degrees
    } else if (fClay > 0.5) {
        // Clay = low friction angle
        phi_base = 12 + (fClay * 12); // 18 to 24 degrees
    } else if (fSilt > 0.5) {
        // Silt = medium friction
        phi_base = 24 + (fSilt * 8); // 28 to 32 degrees
    } else {
        // Mixed soil
        phi_base = (fSand * 35) + (fSilt * 28) + (fClay * 15);
    }

    // MOISTURE EFFECTS - Critical factor!
    let moisture_factor_c = 1.0;
    let moisture_factor_phi = 1.0;

    if (rain > 800) {
        // Saturated soil - massive reduction especially for clay
        moisture_factor_c = fClay > 0.4 ? 0.2 : 0.4; // Clay loses 80% cohesion
        moisture_factor_phi = 0.6; // 40% friction loss
    } else if (rain > 400) {
        moisture_factor_c = fClay > 0.4 ? 0.4 : 0.6;
        moisture_factor_phi = 0.75;
    } else if (rain > 100) {
        moisture_factor_c = fClay > 0.4 ? 0.6 : 0.8;
        moisture_factor_phi = 0.85;
    } else if (rain > 20) {
        moisture_factor_c = 0.9;
        moisture_factor_phi = 0.95;
    } else if (humidity < 30 && temp > 25) {
        // Desert conditions - dry and hot increases effective stress
        moisture_factor_c = 1.1;
        moisture_factor_phi = 1.05;
    }

    // TEMPERATURE EFFECTS
    let temp_factor = 1.0;
    if (temp < 0) {
        // Frozen soil = much higher strength
        temp_factor = 2.5;
    } else if (temp < 5) {
        // Cold soil = slightly stronger
        temp_factor = 1.3;
    } else if (temp > 35) {
        // Hot and dry can increase effective stress
        temp_factor = 1.1;
    }

    // ORGANIC CONTENT EFFECTS (reduces strength)
    let organic_factor = 1.0 - (fOrganic * 0.4);

    // BULK DENSITY EFFECTS (lower density = weaker)
    let density_factor = 1.0;
    if (bulk_density < 100) {
        density_factor = 0.7; // Very loose/organic soil
    } else if (bulk_density < 120) {
        density_factor = 0.85;
    } else if (bulk_density > 160) {
        density_factor = 1.2; // Dense, compacted soil
    }

    // FINAL VALUES
    let c = c_base * moisture_factor_c * temp_factor * organic_factor * density_factor;
    let phi = phi_base * moisture_factor_phi * temp_factor;

    // Ensure realistic bounds
    c = Math.max(0.1, Math.min(c, 200));
    phi = Math.max(5, Math.min(phi, 45));

    return { c, phi };
};

// --- 4. INTELLIGENT REASONING ENGINE ---

const calculateLandslideRisk = (features) => {
    const { rain, slope, clay, sand, silt, bulk_density, elevation, temp, code, isWater, windSpeed, organic, humidity } = features;

    const soilType = classifySoilType(clay, sand, silt);
    const weather = interpretWeatherCode(code);

    // --- ENVIRONMENT DETECTION ---

    // 1. OCEAN / SEA
    if (isWater || (elevation <= 2 && bulk_density < 20)) {
        return {
            level: "Safe",
            reason: "🌊 This location is a water body (Ocean/Sea/Lake). No land surface detected - soil analysis not applicable. Water has zero cohesion and cannot experience soil landslides.",
            details: { FoS: 999, cohesion: "0.0", friction: "0.0", shear_strength: "0.0", shear_stress: "0.0" },
            environment: "Water Body"
        };
    }

    // 2. RIVER / STREAM
    if (elevation < 100 && slope > 0 && slope < 3 && bulk_density < 80) {
        return {
            level: "Medium",
            reason: "🏞️ River valley or floodplain detected. Loose alluvial sediments (cohesion ~3-5 kPa) are prone to erosion and bank collapse during flooding. Saturated riverbank soil loses almost all strength.",
            details: { FoS: 1.8, cohesion: "4.2", friction: "22.5", shear_strength: "15.3", shear_stress: "8.5" },
            environment: "River/Stream"
        };
    }

    // 3. POLAR / GLACIER
    const isPolar = Math.abs(features.lat || 0) > 66.5;
    const isSnow = [71, 73, 75, 77, 85, 86].includes(code) || temp < -1;
    const isGlacier = (temp < -5 && elevation > 2000) || (isPolar && temp < 0);

    if (isGlacier || (isPolar && temp < -10)) {
        const avalancheRisk = slope > 25 ? "High" : (slope > 15 ? "Medium" : "Low");
        const ice_c = 150 + (temp < -20 ? 100 : 0); // Colder = stronger ice
        const ice_phi = 8 + Math.abs(temp) * 0.3; // Friction increases with cold
        return {
            level: avalancheRisk,
            reason: `❄️ Permanent ice zone (${temp}°C). Ice has very high cohesion (${ice_c.toFixed(0)} kPa) but extremely low friction angle (${ice_phi.toFixed(1)}°). ${slope > 25 ? "CRITICAL avalanche risk on this steep slope!" : slope > 15 ? "Moderate avalanche potential" : "Low avalanche risk"}. Glacial mechanics, not soil physics, govern stability here.`,
            details: { FoS: slope > 25 ? 0.7 : 1.5, cohesion: ice_c.toFixed(1), friction: ice_phi.toFixed(1), shear_strength: "245.0", shear_stress: slope > 25 ? "320.0" : "150.0" },
            environment: "Polar/Glacier"
        };
    }

    // 4. SNOW-COVERED (Temporary)
    if (isSnow && !isGlacier) {
        const avalancheRisk = slope > 30 ? "High" : (slope > 20 ? "Medium" : "Low");
        const snow_c = 15 + (temp < -5 ? 35 : 20); // Fresh vs. wet snow
        const snow_phi = 18 + (temp < -5 ? 8 : 0);
        return {
            level: avalancheRisk,
            reason: `⛷️ Active snowfall (${weather.desc}, ${temp}°C). Snow layer has cohesion of ~${snow_c.toFixed(0)} kPa and friction angle ~${snow_phi}°. ${slope > 30 ? "EXTREME avalanche danger - slope exceeds critical angle!" : slope > 20 ? "Avalanche possible on this incline" : "Low avalanche risk, but monitor for melt-induced instability"}.`,
            details: { FoS: slope > 30 ? 0.8 : 1.4, cohesion: snow_c.toFixed(1), friction: snow_phi.toFixed(1), shear_strength: "52.0", shear_stress: slope > 30 ? "68.0" : "32.0" },
            environment: "Snow-Covered"
        };
    }

    // 5. DESERT / ARID
    if (temp > 30 && humidity < 20 && sand > 70 && rain < 10) {
        const desert_c = 0.8 + (clay * 0.15); // Very low cohesion
        const desert_phi = 34 + (sand * 0.05); // High friction angle
        return {
            level: "Low",
            reason: `🏜️ Arid desert conditions. ${soilType} (${sand.toFixed(0)}% sand) has minimal cohesion (${desert_c.toFixed(1)} kPa) but high friction angle (${desert_phi.toFixed(1)}°) due to extreme dryness. No rainfall = no pore pressure = stable. Flash floods are the only real threat.`,
            details: { FoS: 2.8, cohesion: desert_c.toFixed(1), friction: desert_phi.toFixed(1), shear_strength: "125.0", shear_stress: "42.0" },
            environment: "Desert"
        };
    }

    // 6. ROCK OUTCROP / BEDROCK
    if (bulk_density > 180 && clay < 10 && sand < 10) {
        const rock_c = 200 + (bulk_density - 180) * 2; // Massive cohesion
        const rock_phi = 42 + (bulk_density - 180) * 0.1;
        return {
            level: slope > 45 ? "Medium" : "Low",
            reason: `⛰️ Solid bedrock outcrop (density: ${bulk_density} kg/m³). Rock has extreme cohesion (${rock_c.toFixed(0)} kPa) and friction angle (${rock_phi.toFixed(1)}°). ${slope > 45 ? "Risk is rockfall/toppling, not soil sliding" : "Extremely stable - effectively immune to landslides"}.`,
            details: { FoS: 8.5, cohesion: rock_c.toFixed(1), friction: rock_phi.toFixed(1), shear_strength: "1850.0", shear_stress: "220.0" },
            environment: "Rock Outcrop"
        };
    }

    // --- NORMAL SOIL-BASED ANALYSIS ---

    // Calculate location-specific soil properties
    const { c, phi } = calculateSoilProperties(clay, sand, silt, bulk_density, organic, temp, humidity, rain);

    const gamma = (bulk_density / 100) * 9.81; 
    const z = 3.0; 
    const beta = slope * (Math.PI / 180); 

    const sigma = gamma * z * Math.pow(Math.cos(beta), 2); 
    const tau_driving = gamma * z * Math.sin(beta) * Math.cos(beta); 

    // Pore water pressure
    let u = 0;
    let saturation = "dry";
    if (rain > 800) { u = sigma * 0.6; saturation = "critically saturated"; }
    else if (rain > 400) { u = sigma * 0.4; saturation = "highly saturated"; }
    else if (rain > 100) { u = sigma * 0.2; saturation = "moderately saturated"; }
    else if (rain > 20) { u = sigma * 0.05; saturation = "slightly wet"; }

    const sigma_effective = Math.max(0, sigma - u);
    const tanPhi = Math.tan(phi * (Math.PI / 180));
    const tau_resisting = c + (sigma_effective * tanPhi);
    
    let FoS = tau_resisting / (tau_driving + 0.001);

    // Risk classification
    let probability = 0;
    if (slope < 1) { 
        FoS = 20.0;
        probability = 0.01;
    } else {
        if (FoS < 1.0) probability = 0.95; 
        else if (FoS < 1.2) probability = 0.75; 
        else if (FoS < 1.5) probability = 0.40; 
        else if (FoS < 2.0) probability = 0.20; 
        else probability = 0.05; 
    }

    let level = "Low";
    if (probability > 0.7) level = "High";
    else if (probability > 0.3) level = "Medium";

    // --- DETAILED REASONING ---

    let sentences = [];

    const fClay = clay / 100;
    const fSand = sand / 100;

    sentences.push(`📍 Location: ${soilType} soil (${clay.toFixed(0)}% clay, ${sand.toFixed(0)}% sand, ${silt.toFixed(0)}% silt). Cohesion: ${c.toFixed(1)} kPa, Friction angle: ${phi.toFixed(1)}°.`);
    
    if (fClay > 0.45) {
        sentences.push(`High clay content provides strong cohesion when dry, but ${rain > 100 ? "current rainfall has reduced it by " + ((1 - (rain > 800 ? 0.2 : rain > 400 ? 0.4 : 0.6)) * 100).toFixed(0) + "%" : "becomes slippery gel when saturated"}.`);
    } else if (fSand > 0.6) {
        sentences.push(`Sandy soil has high friction (${phi.toFixed(1)}°) but very low cohesion (${c.toFixed(1)} kPa) - easily eroded by water.`);
    } else {
        sentences.push(`Balanced soil mixture provides moderate stability.`);
    }

    if (slope > 40) {
        sentences.push(`⚠️ EXTREME: ${slope}° slope generates enormous shear stress (${tau_driving.toFixed(1)} kPa).`);
    } else if (slope > 25) {
        sentences.push(`⚠️ Critical slope angle (${slope}°) - landslides common here when wet.`);
    } else if (slope > 15) {
        sentences.push(`Moderate ${slope}° slope - vulnerable during heavy rain.`);
    } else if (slope < 5) {
        sentences.push(`Nearly flat (${slope}°) - gravity cannot overcome soil strength.`);
    }

    if (rain > 500) {
        sentences.push(`🌧️ CRITICAL: Extreme rainfall (${features.precip_real} mm). Soil is ${saturation}. Pore pressure has reduced effective stress by ${((u/sigma) * 100).toFixed(0)}%, destroying inter-particle friction.`);
    } else if (rain > 200) {
        sentences.push(`🌧️ Heavy rain (${features.precip_real} mm). Soil ${saturation}, shear strength reduced significantly.`);
    } else if (rain > 50) {
        sentences.push(`🌧️ Moderate rain (${features.precip_real} mm) increasing pore pressure.`);
    } else {
        sentences.push(`Dry conditions (${features.precip_real} mm) - soil at maximum strength.`);
    }

    if (temp < 5 && temp > 0) {
        sentences.push(`Cold temperature (${temp}°C) slightly increases soil strength.`);
    }

    if (FoS < 1.0) {
        sentences.push(`🚨 FAILURE: FoS = ${FoS.toFixed(2)} < 1.0. Shear stress (${tau_driving.toFixed(1)} kPa) EXCEEDS strength (${tau_resisting.toFixed(1)} kPa). EVACUATE!`);
    } else if (FoS < 1.5) {
        sentences.push(`⚠️ UNSTABLE: FoS = ${FoS.toFixed(2)}. Marginally stable - any disturbance could trigger failure.`);
    } else if (FoS < 2.5) {
        sentences.push(`Factor of Safety: ${FoS.toFixed(2)} - Currently stable but monitor conditions.`);
    } else {
        sentences.push(`✅ Factor of Safety: ${FoS.toFixed(2)} - Well within safe limits.`);
    }

    return {
        level,
        reason: sentences.join(" "),
        details: {
            FoS: FoS,
            cohesion: c.toFixed(1),
            friction: phi.toFixed(1),
            shear_strength: tau_resisting.toFixed(1),
            shear_stress: tau_driving.toFixed(1)
        },
        environment: "Land Surface",
        soilType: soilType
    };
};

// --- 5. ROUTE ---

app.post('/predict', async (req, res) => {
    const { lat, lng, manualRain } = req.body; 
    console.log(`\n🔍 Analysis: ${lat}, ${lng} | Rain Override: ${manualRain ?? 'None'}`);

    try {
        const [weather, soil, topo] = await Promise.all([
            fetchWeather(lat, lng),
            fetchSoil(lat, lng),
            calculateSlope(lat, lng)
        ]);

        let features = { ...weather, ...soil, ...topo, lat, lng };
        let isSimulated = false;

        if (manualRain !== null && manualRain !== undefined) {
            features.precip_real = manualRain;
            features.rain = manualRain * 10; 
            isSimulated = true;
        }

        const prediction = calculateLandslideRisk(features);
        
        console.log(`📊 ${prediction.level} | C:${prediction.details.cohesion} φ:${prediction.details.friction}`);

        res.json({
            location: { lat, lng },
            data: features,
            prediction: prediction,
            isSimulated: isSimulated
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed" });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Intelligent Physics Engine running on port ${PORT}`);
});