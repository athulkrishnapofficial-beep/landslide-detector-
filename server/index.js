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
        // Added 'weather_code' to detect Snow/Storms
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code`;
        const response = await axios.get(url);
        const current = response.data.current;
        
        return { 
            temp: current.temperature_2m, 
            humidity: current.relative_humidity_2m, 
            rain: current.precipitation * 10, // Scaled for physics
            precip_real: current.precipitation,
            code: current.weather_code // WMO Weather code (0=Clear, 71=Snow, etc.)
        }; 
    } catch (e) {
        console.error("Weather API Error", e.message);
        return { temp: 25, humidity: 50, rain: 0, precip_real: 0, code: 0 }; 
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

        // If SoilGrids returns null/zeros, it's likely water or solid rock
        let clay = getVal('clay');
        let sand = getVal('sand');
        let bulk_density = getVal('bdod'); 

        // Check if data is missing (Ocean usually has 0 soil density)
        if (!clay && !sand && !bulk_density) {
            return { bulk_density: 0, clay: 0, sand: 0, silt: 0, isWater: true };
        }

        // Convert to standard units
        clay = clay / 10;
        sand = sand / 10;
        let silt = 100 - clay - sand;
        if (silt < 0) silt = 0;

        return { bulk_density, clay, sand, silt, isWater: false };
    } catch (e) {
        // If API fails completely, assume standard soil but mark uncertain
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
        
        // Calculate Slope
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

// --- 2. INTELLIGENT REASONING ENGINE ---

const calculateLandslideRisk = (features) => {
    const { rain, slope, clay, sand, silt, bulk_density, elevation, temp, code, isWater } = features;

    // --- STEP 1: ENVIRONMENT DETECTION ---

    // A. Sea / Water Body Check
    // If elevation is 0 (or below) AND soil data is missing/zero
    if (isWater || (elevation <= 1 && bulk_density < 10)) {
        return {
            level: "Safe",
            reason: "🌊 Ocean/Water Body Detected. This is not land surface.",
            details: { FoS: 100, cohesion: 0, friction: 0, shear_strength: 0, shear_stress: 0 }
        };
    }

    // B. Snow / Ice Check
    // WMO Codes: 71, 73, 75 (Snow), 77 (Grain), 85, 86 (Snow Showers)
    const isSnow = [71, 73, 75, 77, 85, 86].includes(code) || temp < -1;
    if (isSnow) {
        return {
            level: slope > 30 ? "High" : "Medium",
            reason: "❄️ Ice/Snow detected. Risk is predominantly from Avalanche or Thaw-Slump, not typical soil shear.",
            details: { FoS: slope > 30 ? 0.9 : 1.5, cohesion: 50, friction: 10, shear_strength: 0, shear_stress: 0 }
        };
    }

    // --- STEP 2: SOIL PHYSICS CALCULATION ---

    const fClay = clay / 100;
    const fSand = sand / 100;
    const fSilt = silt / 100;

    let c = (fClay * 35) + (fSilt * 10) + (fSand * 1);
    let phi = (fSand * 34) + (fSilt * 28) + (fClay * 18);

    const gamma = (bulk_density / 100) * 9.81; 
    const z = 3.0; 
    const beta = slope * (Math.PI / 180); 

    const sigma = gamma * z * Math.pow(Math.cos(beta), 2); 
    const tau_driving = gamma * z * Math.sin(beta) * Math.cos(beta); 

    // Rain Saturation Logic
    let u = 0;
    if (rain > 800) u = sigma * 0.5; 
    else if (rain > 400) u = sigma * 0.3; 
    else if (rain > 100) u = sigma * 0.1; 

    const sigma_effective = Math.max(0, sigma - u);
    const tanPhi = Math.tan(phi * (Math.PI / 180));
    const tau_resisting = c + (sigma_effective * tanPhi);
    
    let FoS = tau_resisting / (tau_driving + 0.001);

    // --- STEP 3: RISK MAPPING ---
    
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

    // --- STEP 4: NATURAL LANGUAGE GENERATOR ---

    let sentences = [];

    // Soil Description
    if (fClay > 0.45) sentences.push(`The terrain is Clay-rich (${clay.toFixed(0)}%), which is cohesive but slippery when wet.`);
    else if (fSand > 0.6) sentences.push(`The terrain is Sandy (${sand.toFixed(0)}%), which is loose and prone to washout.`);
    else sentences.push(`The soil is a Loam mixture (Sand/Silt/Clay), providing moderate stability.`);

    // Slope Description
    if (slope > 35) sentences.push(`The slope is extremely steep (${slope}°), making it naturally unstable.`);
    else if (slope < 5) sentences.push(`The land is flat (${slope}°), significantly reducing landslide risk.`);

    // Weather Impact
    if (rain > 400) sentences.push(`⚠️ CRITICAL: Heavy rainfall is saturating the ground, reducing friction.`);
    else if (rain > 100) sentences.push(`Moderate rain detected. Pore pressure is increasing.`);
    
    // Combine sentences
    let reason = sentences.join(" ");

    return {
        level,
        reason,
        details: {
            FoS: FoS,
            cohesion: c.toFixed(2),
            friction: phi.toFixed(2),
            shear_strength: tau_resisting,
            shear_stress: tau_driving
        }
    };
};

// --- 3. ROUTE ---

app.post('/predict', async (req, res) => {
    const { lat, lng, manualRain } = req.body; 
    console.log(`\n📍 Analysis: ${lat}, ${lng} | Rain Override: ${manualRain ?? 'None'}`);

    try {
        const [weather, soil, topo] = await Promise.all([
            fetchWeather(lat, lng),
            fetchSoil(lat, lng),
            calculateSlope(lat, lng)
        ]);

        let features = { ...weather, ...soil, ...topo };
        let isSimulated = false;

        // Apply Rain Override (for slider)
        if (manualRain !== null && manualRain !== undefined) {
            features.precip_real = manualRain;
            features.rain = manualRain * 10; 
            isSimulated = true;
        }

        const prediction = calculateLandslideRisk(features);
        
        console.log(`📊 Result: ${prediction.level} | ${prediction.reason}`);

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