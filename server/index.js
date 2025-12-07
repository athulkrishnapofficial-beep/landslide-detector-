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
        const url = `https://rest.isric.org/soilgrids/v2.0/properties/query?lat=${lat}&lon=${lon}&property=bdod&property=clay&property=sand&depth=0-5cm`;
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

        if (!clay && !sand && !bulk_density) {
            return { bulk_density: 0, clay: 0, sand: 0, silt: 0, isWater: true };
        }

        clay = clay / 10;
        sand = sand / 10;
        let silt = 100 - clay - sand;
        if (silt < 0) silt = 0;

        return { bulk_density, clay, sand, silt, isWater: false };
    } catch (e) {
        return { bulk_density: 130, clay: 33, sand: 33, silt: 34, isWater: false }; 
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
    // USDA Soil Texture Triangle Classification
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
    // WMO Weather interpretation codes
    if (code === 0) return { desc: "Clear sky", severity: 0 };
    if ([1, 2, 3].includes(code)) return { desc: "Partly cloudy", severity: 0 };
    if ([45, 48].includes(code)) return { desc: "Fog", severity: 1 };
    if ([51, 53, 55, 56, 57].includes(code)) return { desc: "Drizzle", severity: 1 };
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { desc: "Rain", severity: 2 };
    if ([71, 73, 75, 77, 85, 86].includes(code)) return { desc: "Snow", severity: 3 };
    if ([95, 96, 99].includes(code)) return { desc: "Thunderstorm", severity: 4 };
    return { desc: "Unknown", severity: 0 };
};

// --- 3. INTELLIGENT REASONING ENGINE ---

const calculateLandslideRisk = (features) => {
    const { rain, slope, clay, sand, silt, bulk_density, elevation, temp, code, isWater, windSpeed } = features;

    // Classify soil type
    const soilType = classifySoilType(clay, sand, silt);
    const weather = interpretWeatherCode(code);

    // --- ENVIRONMENT DETECTION ---

    // 1. OCEAN / SEA / LARGE WATER BODIES
    if (isWater || (elevation <= 2 && bulk_density < 20)) {
        return {
            level: "Safe",
            reason: "🌊 This location is a water body (Ocean/Sea/Lake). No land surface detected, therefore landslide analysis is not applicable. Soil density is negligible, indicating open water.",
            details: { FoS: 999, cohesion: 0, friction: 0, shear_strength: 0, shear_stress: 0 },
            environment: "Water Body"
        };
    }

    // 2. RIVER / STREAM DETECTION (Low elevation + very high slope variance + low bulk density)
    if (elevation < 100 && slope > 0 && slope < 3 && bulk_density < 80) {
        return {
            level: "Medium",
            reason: "🏞️ This appears to be a river valley or stream bed. While not prone to traditional landslides, riverbank erosion and flash flooding can cause sudden ground failure, especially during heavy rainfall. The loose, water-saturated sediments provide minimal stability.",
            details: { FoS: 1.8, cohesion: 5, friction: 20, shear_strength: 0, shear_stress: 0 },
            environment: "River/Stream"
        };
    }

    // 3. POLAR / ICE CAP DETECTION
    const isPolar = Math.abs(features.lat || 0) > 66.5; // Arctic/Antarctic circles
    const isSnow = [71, 73, 75, 77, 85, 86].includes(code) || temp < -1;
    const isGlacier = (temp < -5 && elevation > 2000) || (isPolar && temp < 0);

    if (isGlacier || (isPolar && temp < -10)) {
        const avalancheRisk = slope > 25 ? "High" : (slope > 15 ? "Medium" : "Low");
        return {
            level: avalancheRisk,
            reason: `❄️ Polar/Glacial Region detected (${temp}°C). This is a permanent ice zone where traditional soil landslides don't occur. However, ${slope > 25 ? "the steep slope creates EXTREME avalanche risk" : slope > 15 ? "avalanche risk exists on this moderate slope" : "avalanche risk is low on this gentle slope"}. Ice calving, crevasse formation, and glacial melt are the primary hazards here.`,
            details: { FoS: slope > 25 ? 0.7 : 1.5, cohesion: 100, friction: 5, shear_strength: 0, shear_stress: 0 },
            environment: "Polar/Glacier"
        };
    }

    // 4. SNOW-COVERED TERRAIN (Temporary)
    if (isSnow && !isGlacier) {
        const avalancheRisk = slope > 30 ? "High" : (slope > 20 ? "Medium" : "Low");
        return {
            level: avalancheRisk,
            reason: `⛷️ Active snowfall detected (${weather.desc}). The area is currently snow-covered (${temp}°C). ${slope > 30 ? "CRITICAL: Slope angle exceeds 30° - prime avalanche terrain!" : slope > 20 ? "Moderate avalanche risk on this 20-30° slope" : "Low avalanche risk, but snow melt could trigger underlying soil instability"}. When snow melts, check again for soil-based landslide risk.`,
            details: { FoS: slope > 30 ? 0.8 : 1.4, cohesion: 50, friction: 12, shear_strength: 0, shear_stress: 0 },
            environment: "Snow-Covered"
        };
    }

    // 5. DESERT / ARID REGION (Very low humidity + high temp + sandy soil)
    if (temp > 30 && features.humidity < 20 && sand > 70 && rain < 10) {
        return {
            level: "Low",
            reason: `🏜️ Arid desert environment detected. The soil is ${soilType} (${sand.toFixed(0)}% sand) with extremely low moisture (${features.humidity}% humidity). While the loose sand is inherently unstable, the absence of rainfall means no pore pressure buildup. However, rare flash floods can trigger debris flows.`,
            details: { FoS: 2.5, cohesion: 1, friction: 32, shear_strength: 0, shear_stress: 0 },
            environment: "Desert"
        };
    }

    // 6. ROCK OUTCROP / BEDROCK (Very high bulk density, minimal soil)
    if (bulk_density > 180 && clay < 10 && sand < 10) {
        return {
            level: slope > 45 ? "Medium" : "Low",
            reason: `⛰️ Bedrock or rock outcrop detected. The extremely high soil density (${bulk_density} kg/m³) indicates solid rock with minimal soil cover. ${slope > 45 ? "The steep rock face could experience rockfall or rock avalanche" : "Stable rock structure with low landslide risk"}. Traditional soil-based landslides are unlikely here.`,
            details: { FoS: 5.0, cohesion: 200, friction: 45, shear_strength: 0, shear_stress: 0 },
            environment: "Rock Outcrop"
        };
    }

    // --- SOIL-BASED LANDSLIDE PHYSICS ---

    const fClay = clay / 100;
    const fSand = sand / 100;
    const fSilt = silt / 100;

    // Cohesion (kPa) - soil binding strength
    let c = (fClay * 35) + (fSilt * 10) + (fSand * 1);
    
    // Friction angle (degrees) - internal friction
    let phi = (fSand * 34) + (fSilt * 28) + (fClay * 18);

    // Adjust for organic content (lower bulk density = more organic = weaker)
    if (bulk_density < 100) {
        c *= 0.7;
        phi *= 0.9;
    }

    const gamma = (bulk_density / 100) * 9.81; 
    const z = 3.0; 
    const beta = slope * (Math.PI / 180); 

    const sigma = gamma * z * Math.pow(Math.cos(beta), 2); 
    const tau_driving = gamma * z * Math.sin(beta) * Math.cos(beta); 

    // Pore water pressure from rainfall
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

    // --- RISK CLASSIFICATION ---
    
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

    // --- DETAILED REASONING GENERATION ---

    let sentences = [];

    // Soil characteristics
    sentences.push(`📍 Location Analysis: The terrain consists of ${soilType} soil (${clay.toFixed(0)}% clay, ${sand.toFixed(0)}% sand, ${silt.toFixed(0)}% silt).`);
    
    if (fClay > 0.45) {
        sentences.push(`The high clay content makes the soil cohesive (${c.toFixed(1)} kPa) but extremely slippery when saturated with water - it behaves like lubricating gel under pressure.`);
    } else if (fSand > 0.6) {
        sentences.push(`The sandy composition provides high internal friction (${phi.toFixed(1)}°) but very low cohesion (${c.toFixed(1)} kPa), making it prone to erosion and washout during heavy rainfall.`);
    } else {
        sentences.push(`This balanced soil mixture provides moderate stability with cohesion of ${c.toFixed(1)} kPa and friction angle of ${phi.toFixed(1)}°.`);
    }

    // Slope analysis
    if (slope > 40) {
        sentences.push(`⚠️ EXTREME HAZARD: The slope is exceptionally steep at ${slope}° (normal hillsides are 10-20°). Gravity forces are overwhelming the soil's shear strength.`);
    } else if (slope > 25) {
        sentences.push(`⚠️ The slope angle of ${slope}° is in the critical range where landslides frequently occur, especially when combined with rainfall.`);
    } else if (slope > 15) {
        sentences.push(`The ${slope}° slope is moderately steep - stable under dry conditions but vulnerable during prolonged rain.`);
    } else if (slope < 5) {
        sentences.push(`The land is nearly flat (${slope}°), which naturally prevents landslides as gravitational shear stress is minimal.`);
    } else {
        sentences.push(`The ${slope}° slope is gentle and typically stable.`);
    }

    // Weather impact
    if (rain > 500) {
        sentences.push(`🌧️ CRITICAL ALERT: Extreme rainfall (${features.precip_real} mm) is actively saturating the soil. Pore water pressure is ${saturation}, which reduces effective stress and destroys inter-particle friction. This creates a near-liquid state in the soil mass.`);
    } else if (rain > 200) {
        sentences.push(`🌧️ Heavy rainfall (${features.precip_real} mm) detected. The soil is ${saturation}, significantly reducing its shear strength. Water is filling void spaces and increasing weight while decreasing friction.`);
    } else if (rain > 50) {
        sentences.push(`🌧️ Moderate rain (${features.precip_real} mm) is present. The soil is ${saturation}, which is beginning to reduce stability through increased pore pressure.`);
    } else if (rain > 5) {
        sentences.push(`Light precipitation (${features.precip_real} mm) detected. Soil remains mostly stable but monitor for increasing rainfall.`);
    } else {
        sentences.push(`Weather conditions are dry (${features.precip_real} mm rainfall). Soil is stable with no pore pressure buildup.`);
    }

    // Weather condition
    if (weather.severity >= 4) {
        sentences.push(`⛈️ Thunderstorm activity detected - lightning, strong winds (${windSpeed} km/h), and intense rainfall can rapidly destabilize slopes.`);
    } else if (weather.severity >= 2) {
        sentences.push(`Current conditions: ${weather.desc} with ${temp}°C temperature.`);
    }

    // Safety Factor interpretation
    if (FoS < 1.0) {
        sentences.push(`🚨 FAILURE IMMINENT: Factor of Safety is ${FoS.toFixed(2)} (below 1.0 = active failure). The shear stress (${tau_driving.toFixed(1)} kPa) EXCEEDS the soil's shear strength (${tau_resisting.toFixed(1)} kPa). Evacuation recommended.`);
    } else if (FoS < 1.5) {
        sentences.push(`⚠️ UNSTABLE: Factor of Safety is ${FoS.toFixed(2)} (marginally stable). Any additional rainfall or ground disturbance could trigger failure.`);
    } else if (FoS < 2.5) {
        sentences.push(`Factor of Safety: ${FoS.toFixed(2)} - Currently stable but vulnerable to changing conditions.`);
    } else {
        sentences.push(`✅ Factor of Safety: ${FoS.toFixed(2)} - Terrain is well within stable limits.`);
    }

    let reason = sentences.join(" ");

    return {
        level,
        reason,
        details: {
            FoS: FoS,
            cohesion: c.toFixed(2),
            friction: phi.toFixed(2),
            shear_strength: tau_resisting.toFixed(2),
            shear_stress: tau_driving.toFixed(2)
        },
        environment: "Land Surface",
        soilType: soilType
    };
};

// --- 4. ROUTE ---

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
        
        console.log(`📊 Result: ${prediction.level} | ${prediction.environment}`);

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