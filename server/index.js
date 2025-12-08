const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// --- 1. ENHANCED DATA FETCHING ---

const fetchWeather = async (lat, lon) => {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&past_days=7&forecast_days=1`;
        const response = await axios.get(url);
        const current = response.data.current;
        const daily = response.data.daily;
        
        const rainfall_7day = daily.precipitation_sum.slice(0, 7).reduce((a, b) => a + (b || 0), 0);
        
        return { 
            temp: current.temperature_2m,
            temp_max: daily.temperature_2m_max[0],
            temp_min: daily.temperature_2m_min[0],
            humidity: current.relative_humidity_2m,
            rain_current: current.precipitation,
            rain_7day: rainfall_7day,
            wind_speed: current.wind_speed_10m,
            code: current.weather_code
        }; 
    } catch (e) {
        console.error("⚠️ Weather API Error:", e.message);
        return { temp: 15, temp_max: 20, temp_min: 10, humidity: 50, rain_current: 0, rain_7day: 0, wind_speed: 0, code: 0 }; 
    }
};

const fetchSoil = async (lat, lon) => {
    try {
        const url = `https://rest.isric.org/soilgrids/v2.0/properties/query?lat=${lat}&lon=${lon}&property=bdod&property=clay&property=sand&property=silt&property=phh2o&property=ocd&depth=0-5cm`;
        
        const response = await axios.get(url, { timeout: 8000 });
        const layers = response.data.properties.layers;
        
        const getVal = (name) => {
            const layer = layers.find(l => l.name === name);
            if (!layer || !layer.depths || !layer.depths[0]) return null;
            return layer.depths[0].values['mean'];
        };

        let clay = getVal('clay');
        let sand = getVal('sand');
        let silt = getVal('silt');
        let bulk_density = getVal('bdod');
        let ph = getVal('phh2o');
        let organic_carbon = getVal('ocd');

        // Check for nulls (Water/Urban)
        if (clay === null || sand === null || bulk_density === null) {
            console.log("⚠️ Soil API returned nulls (Water/Ocean/Urban)");
            // Return safe defaults so friction calculation doesn't fail
            return { bulk_density: 0, clay: 0, sand: 0, silt: 0, ph: 7, organic_carbon: 0, isWater: true, raw: false };
        }

        // Convert units
        clay = clay / 10; // g/kg to %
        sand = sand / 10;
        silt = silt ? silt / 10 : (100 - clay - sand);
        
        // Normalize
        const total = clay + sand + silt;
        if (total > 0) {
            clay = (clay / total) * 100;
            sand = (sand / total) * 100;
            silt = (silt / total) * 100;
        }

        ph = ph ? ph / 10 : 7;
        organic_carbon = organic_carbon ? organic_carbon / 10 : 0;

        return { bulk_density, clay, sand, silt, ph, organic_carbon, isWater: false, raw: true };

    } catch (e) {
        console.error("⚠️ Soil API Failed (Using Location-based fallback):", e.message);
        
        const absLat = Math.abs(lat);
        const noise = (Math.abs(lat * lon) % 13);
        
        let clay, sand, silt;
        // Simple fallback logic
        if (absLat > 60) { clay = 15 + noise; sand = 55 + noise; silt = 30 - noise; }
        else if (absLat < 23) { clay = 40 + noise; sand = 25 + noise; silt = 35 - noise; }
        else { clay = 30 + noise; sand = 35 + noise; silt = 35 - noise; }
        
        return { 
            bulk_density: 140 + noise, // Default bulk density ~1.4 g/cm3
            clay, sand, silt,
            ph: 6.5,
            organic_carbon: 2,
            isWater: false,
            raw: false
        }; 
    }
};

const calculateSlope = async (lat, lon) => {
    try {
        const offset = 0.003; 
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat},${lat + offset},${lat - offset},${lat}&longitude=${lon},${lon},${lon},${lon + offset}`;
        const response = await axios.get(url);
        const elevations = response.data.elevation;

        const h0 = elevations[0];     
        const hNorth = elevations[1]; 
        const hSouth = elevations[2]; 
        const hEast = elevations[3];  
        
        if (h0 === 0 && hNorth === 0 && hEast === 0) {
            return { elevation: 0, slope: 0, aspect: 0 };
        }

        const dist = 333; 
        const dz_dx = (hEast - h0) / dist;
        const dz_dy = (hNorth - hSouth) / (2 * dist);
        const rise = Math.sqrt(dz_dx*dz_dx + dz_dy*dz_dy);
        const slopeDeg = Math.atan(rise) * (180 / Math.PI);
        const aspect = Math.atan2(dz_dx, dz_dy) * (180 / Math.PI);

        return { 
            elevation: h0, 
            slope: parseFloat(slopeDeg.toFixed(2)),
            aspect: parseFloat(aspect.toFixed(0))
        };
    } catch (e) {
        return { elevation: 0, slope: 0, aspect: 0 };
    }
};

// --- 2. CLIMATE & SOIL CLASSIFICATION ---

const getKoppenClimate = (lat, temp, temp_max, temp_min, rain_7day) => {
    const absLat = Math.abs(lat);
    const avgTemp = (temp_max + temp_min) / 2;
    
    if (absLat > 66) return { zone: "Polar (ET/EF)", vegetation: "minimal", permafrost: temp < 0 };
    if (absLat > 60) return { zone: "Subarctic (Dfc/Dfd)", vegetation: "sparse", permafrost: temp < -5 };
    if (avgTemp < 0) return { zone: "Cold (Df/Dw)", vegetation: "moderate", permafrost: false };
    if (avgTemp > 18 && rain_7day > 50) return { zone: "Tropical (Af/Am)", vegetation: "dense", permafrost: false };
    if (avgTemp > 18) return { zone: "Arid/Semi-arid (BWh/BSh)", vegetation: "sparse", permafrost: false };
    if (temp_max > 22) return { zone: "Temperate (Cfa/Cfb)", vegetation: "moderate", permafrost: false };
    return { zone: "Continental (Dfa/Dfb)", vegetation: "moderate", permafrost: false };
};

const classifySoilTexture = (clay, sand, silt) => {
    if (silt + 1.5 * clay < 15) return "Sand";
    if (silt + 1.5 * clay >= 15 && silt + 2 * clay < 30) return "Loamy Sand";
    if (clay >= 7 && clay < 20 && sand > 52 && silt + 2 * clay >= 30) return "Sandy Loam";
    if (clay >= 7 && clay < 27 && sand >= 28 && sand < 52 && silt >= 28 && silt < 50) return "Loam";
    if (silt >= 50 && clay >= 12 && clay < 27) return "Silt Loam";
    if (silt >= 80 && clay < 12) return "Silt";
    if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return "Sandy Clay Loam";
    if (clay >= 27 && clay < 40 && sand >= 20 && sand < 45) return "Clay Loam";
    if (clay >= 27 && clay < 40 && sand < 20) return "Silty Clay Loam";
    if (clay >= 35 && sand > 45) return "Sandy Clay";
    if (clay >= 40 && silt >= 40) return "Silty Clay";
    if (clay >= 40 && sand < 45 && silt < 40) return "Clay";
    return "Loam"; 
};

// --- 3. RISK CALCULATION ---

const calculateLandslideRisk = (features, climate) => {
    // 1. Destructure with Defaults to prevent undefined errors
    const { 
        rain_current = 0, rain_7day = 0, slope = 0, 
        clay = 0, sand = 0, silt = 0, 
        elevation = 0, temp = 0, code = 0, isWater = false, 
        organic_carbon = 0
    } = features;

    // Ensure bulk_density has a fallback if undefined
    const bulk_density = features.bulk_density || 130; // Default 1.3 g/cm3 if missing

    // --- ENVIRONMENT CHECKS ---
    if (slope === 0 && elevation === 0) {
        return {
            level: "Safe", reason: "🌊 Sea / Water Body Detected", environment: "Water Body", soil_type: "Water",
            details: { FoS: 100, probability: 0, cohesion: 0, friction_angle: 0, shear_strength: 0, shear_stress: 0, pore_pressure: 0, saturation: 0, infiltration_rate: 0, root_cohesion: 0 }
        };
    }
    if (temp <= 0) {
        return {
            level: "High", reason: "🧊 Ice Detected", environment: "Ice / Frozen Surface", soil_type: "Ice",
            details: { FoS: 0.9, probability: 85.0, cohesion: 0, friction_angle: 0, shear_strength: 0, shear_stress: 0, pore_pressure: 0, saturation: 0, infiltration_rate: 0, root_cohesion: 0 }
        };
    }
    if (isWater) {
        return {
            level: "Safe", reason: "🌊 Ocean or Water Body", environment: "Water Body", soil_type: "N/A",
            details: { FoS: 100, probability: 0, cohesion: 0, friction_angle: 0, shear_strength: 0, shear_stress: 0, pore_pressure: 0, saturation: 0, infiltration_rate: 0, root_cohesion: 0 }
        };
    }

    const soilTexture = classifySoilTexture(clay, sand, silt);
    
    // --- GEOTECHNICAL PARAMETERS ---

    const fClay = clay / 100;
    const fSand = sand / 100;
    const fSilt = silt / 100;

    // Cohesion
    let c_base = (fClay * 45) + (fSilt * 12) + (fSand * 0.5);
    let c_organic = Math.min(organic_carbon * 2, 10);
    let c_dry = c_base + c_organic;
    const saturation = Math.min(rain_7day / 100, 1.0);
    let c = c_dry * (1 - saturation * fClay * 0.4);

    // --- FIX: FRICTION ANGLE CALCULATION ---
    // Ensure bulk_density is a number. 
    // Typical bulk density (bdod) from soilgrids is 0-200 (cg/cm3). 
    // 100 cg/cm3 = 1.0 g/cm3.
    // If bulk_density is missing, default to 130.
    const safe_bd = (typeof bulk_density === 'number' && !isNaN(bulk_density)) ? bulk_density : 130;

    let phi_base = (fSand * 38) + (fSilt * 32) + (fClay * 18);
    // Add density factor: denser soil = higher friction
    // safe_bd / 1000 is likely too small if bd is ~140. 
    // Assuming bd is in cg/cm3 (e.g., 140 = 1.4 g/cm3).
    // Let's use (safe_bd / 100) * 2 to add 2-3 degrees for density.
    let phi = phi_base + ((safe_bd / 100) * 2); 

    // Cap phi to realistic values (15 to 45 degrees)
    phi = Math.min(Math.max(phi, 15), 45);

    // Root Cohesion
    let root_cohesion = 0;
    if (climate.vegetation === "dense") root_cohesion = 15;
    else if (climate.vegetation === "moderate") root_cohesion = 8;
    else if (climate.vegetation === "sparse") root_cohesion = 3;
    c += root_cohesion;

    // --- PHYSICS ---
    const rainfall_intensity = rain_current * 10;
    const antecedent_moisture = Math.min(rain_7day / 150, 1.0);
    let infiltration_rate = (fSand * 30) + (fSilt * 10) + (fClay * 2);
    const excess_rain = Math.max(0, rainfall_intensity - infiltration_rate);

    const gamma = (safe_bd / 100) * 9.81; // Unit weight kN/m3
    const z = 2.5;
    const beta = slope * (Math.PI / 180);

    const sigma = gamma * z * Math.pow(Math.cos(beta), 2);
    const tau_driving = gamma * z * Math.sin(beta) * Math.cos(beta);

    let u = 0;
    const base_saturation = antecedent_moisture * 0.5;
    const intensity_factor = Math.min(excess_rain / 20, 0.5);
    const clay_retention = fClay * 0.3;
    
    u = sigma * (base_saturation + intensity_factor + clay_retention);
    u = Math.min(u, sigma * 0.9);

    const sigma_effective = Math.max(0, sigma - u);
    const tanPhi = Math.tan(phi * (Math.PI / 180));
    const tau_resisting = c + (sigma_effective * tanPhi);
    
    let FoS = tau_resisting / (tau_driving + 0.01);

    // --- PROBABILITY & RISK ---
    let probability = 0;
    if (slope < 5) { FoS = 15.0; probability = 0.0; } 
    else if (slope < 15) { probability = FoS < 1.0 ? 0.60 : (FoS < 1.5 ? 0.25 : 0.05); }
    else if (slope < 30) { probability = FoS < 1.0 ? 0.90 : (FoS < 1.3 ? 0.70 : (FoS < 1.7 ? 0.35 : 0.10)); } 
    else { probability = FoS < 1.0 ? 0.98 : (FoS < 1.2 ? 0.85 : (FoS < 1.5 ? 0.55 : 0.20)); }

    if (rainfall_intensity > 30) probability = Math.min(probability * 1.4, 0.99);
    if (rain_7day > 150) probability = Math.min(probability * 1.3, 0.99);

    let level = "Low";
    if (probability > 0.75) level = "Extreme";
    else if (probability > 0.50) level = "High";
    else if (probability > 0.25) level = "Medium";

    let factors = [];
    if (slope > 30) factors.push(`Steep slope (${slope.toFixed(1)}°)`);
    factors.push(`Soil: ${soilTexture}`);
    if (FoS < 1.3) factors.push(`⚠️ Critical stability (FoS: ${FoS.toFixed(2)})`);
    else factors.push(`✓ Stable (FoS: ${FoS.toFixed(2)})`);

    return {
        level,
        reason: factors.join(" • "),
        environment: climate.zone,
        soil_type: soilTexture,
        details: {
            FoS: parseFloat(FoS.toFixed(2)),
            probability: parseFloat((probability * 100).toFixed(1)),
            cohesion: parseFloat(c.toFixed(1)),
            friction_angle: parseFloat(phi.toFixed(1)), // Ensure this is fixed
            shear_strength: parseFloat(tau_resisting.toFixed(1)),
            shear_stress: parseFloat(tau_driving.toFixed(1)),
            pore_pressure: parseFloat((u / sigma * 100).toFixed(0)),
            saturation: parseFloat((antecedent_moisture * 100).toFixed(0)),
            infiltration_rate: parseFloat(infiltration_rate.toFixed(1)),
            root_cohesion: parseFloat(root_cohesion.toFixed(1))
        }
    };
};

// --- 4. MAIN ROUTE ---

app.post('/predict', async (req, res) => {
    const { lat, lng, manualRain } = req.body; 
    console.log(`\n📍 Analysis: ${lat}, ${lng} | Rain: ${manualRain ?? 'Live'}`);

    try {
        const [weather, soil, topo] = await Promise.all([
            fetchWeather(lat, lng),
            fetchSoil(lat, lng),
            calculateSlope(lat, lng)
        ]);

        let features = { ...weather, ...soil, ...topo };
        let isSimulated = false;

        if (manualRain !== null && manualRain !== undefined) {
            features.rain_current = manualRain;
            features.rain_7day = manualRain * 7; 
            isSimulated = true;
        }

        const climate = getKoppenClimate(lat, features.temp, features.temp_max, features.temp_min, features.rain_7day);
        const prediction = calculateLandslideRisk(features, climate);
        
        console.log(`📊 Result: ${prediction.level} Risk | FoS: ${prediction.details.FoS} | Phi: ${prediction.details.friction_angle}°`);

        res.json({
            location: { lat, lng },
            climate: climate,
            data: features,
            prediction: prediction,
            isSimulated: isSimulated,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error("❌ Analysis Failed:", error);
        res.status(500).json({ error: "Analysis failed", message: error.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'operational', version: '2.0.1' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Landslide Engine v2.0.1 (Friction Fixed)`);
    console.log(`🚀 Server running on port ${PORT}`);
});