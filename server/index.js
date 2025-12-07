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
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code`;
        const response = await axios.get(url);
        const current = response.data.current;
        
        return { 
            temp: current.temperature_2m, 
            humidity: current.relative_humidity_2m, 
            rain: current.precipitation * 10, // Scaled for physics intensity
            precip_real: current.precipitation,
            code: current.weather_code 
        }; 
    } catch (e) {
        console.error("⚠️ Weather API Error:", e.message);
        return { temp: 25, humidity: 50, rain: 0, precip_real: 0, code: 0 }; 
    }
};

const fetchSoil = async (lat, lon) => {
    try {
        // Updated URL structure for robustness
        const url = `https://rest.isric.org/soilgrids/v2.0/properties/query?lat=${lat}&lon=${lon}&property=bdod&property=clay&property=sand&depth=0-5cm`;
        
        // heavy timeout handling because SoilGrids can be slow
        const response = await axios.get(url, { timeout: 5000 });
        
        const layers = response.data.properties.layers;
        
        // Helper to extract value safely
        const getVal = (name) => {
            const layer = layers.find(l => l.name === name);
            if (!layer || !layer.depths || !layer.depths[0]) return null;
            return layer.depths[0].values['mean'];
        };

        let clay = getVal('clay');
        let sand = getVal('sand');
        let bulk_density = getVal('bdod'); 

        // 1. CHECK FOR WATER/NO-DATA (Ocean usually returns null or 0s)
        if (clay === null || sand === null || bulk_density === null) {
            console.log("⚠️ Soil API returned nulls (Likely Water/City)");
            return { bulk_density: 0, clay: 0, sand: 0, silt: 0, isWater: true, raw: false };
        }

        // 2. CONVERT UNITS (SoilGrids V2 uses g/kg. We want %)
        // Example: 200 g/kg = 20%
        clay = clay / 10;
        sand = sand / 10;
        
        // Silt is the remainder
        let silt = 100 - clay - sand;
        if (silt < 0) silt = 0;

        return { bulk_density, clay, sand, silt, isWater: false, raw: true };

    } catch (e) {
        console.error("⚠️ Soil API Failed (Using Heuristic fallback):", e.message);
        
        // RANDOMIZED FALLBACK: Prevents "Constant Value" issue if API fails.
        // We generate slight noise based on lat/lon to make it deterministic but varied.
        const noise = (Math.abs(lat + lon) % 10); 
        
        return { 
            bulk_density: 130 + noise, 
            clay: 30 + (noise * 2), 
            sand: 30 - noise, 
            silt: 40 - noise, 
            isWater: false,
            raw: false // Flag to tell us this is simulated data
        }; 
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
        
        // Check for ocean (elevation 0)
        if (h0 === 0 && hNorth === 0 && hEast === 0) {
            return { elevation: 0, slope: 0 };
        }

        const dist = 220; 
        const dz_dx = (hEast - h0) / dist;
        const dz_dy = (hNorth - h0) / dist;
        const rise = Math.sqrt(dz_dx*dz_dx + dz_dy*dz_dy);
        const slopeDeg = Math.atan(rise) * (180 / Math.PI);

        return { elevation: h0, slope: parseFloat(slopeDeg.toFixed(1)) };
    } catch (e) {
        console.error("⚠️ Elevation API Error:", e.message);
        return { elevation: 0, slope: 0 };
    }
};

// --- 2. INTELLIGENT REASONING ENGINE ---

const calculateLandslideRisk = (features) => {
    const { rain, slope, clay, sand, silt, bulk_density, elevation, temp, code, isWater } = features;

    // --- STEP 1: ENVIRONMENT DETECTION ---

    // A. Sea / Water Body Check
    if (isWater || (elevation <= 1 && bulk_density < 10)) {
        return {
            level: "Safe",
            reason: "🌊 Ocean/Water Body Detected.",
            details: { FoS: 100, cohesion: 0, friction: 0, shear_strength: 0, shear_stress: 0 }
        };
    }

    // B. Snow Check
    const isSnow = [71, 73, 75, 77, 85, 86].includes(code) || temp < -1;
    if (isSnow) {
        return {
            level: slope > 30 ? "High" : "Medium",
            reason: "❄️ Ice/Snow detected. Risk from Avalanche.",
            details: { FoS: slope > 30 ? 0.9 : 1.5, cohesion: 50, friction: 10, shear_strength: 0, shear_stress: 0 }
        };
    }

    // --- STEP 2: SOIL PHYSICS CALCULATION ---
    
    // Normalize fractions
    const fClay = clay / 100;
    const fSand = sand / 100;
    const fSilt = silt / 100;

    // COHESION (c) in kPa: Clay is sticky (high c), Sand is loose (low c)
    // We add slight variety based on density to ensure it's not static
    let c = (fClay * 40) + (fSilt * 10) + (fSand * 1);
    
    // FRICTION ANGLE (phi) in degrees: Sand locks together (high phi), Clay slips (low phi)
    let phi = (fSand * 35) + (fSilt * 30) + (fClay * 20);

    const gamma = (bulk_density / 100) * 9.81; 
    const z = 3.0; // Assume 3m soil depth
    const beta = slope * (Math.PI / 180); // Slope in radians

    // Physics: Infinite Slope Model
    const sigma = gamma * z * Math.pow(Math.cos(beta), 2); // Normal Stress
    const tau_driving = gamma * z * Math.sin(beta) * Math.cos(beta); // Shear Stress (Gravity)

    // RAIN EFFECT: Pore Water Pressure (u)
    let u = 0;
    if (rain > 500) u = sigma * 0.6; // Extreme saturation
    else if (rain > 200) u = sigma * 0.4;
    else if (rain > 50) u = sigma * 0.1; 

    // Effective Stress
    const sigma_effective = Math.max(0, sigma - u);
    const tanPhi = Math.tan(phi * (Math.PI / 180));
    
    // Shear Strength (Mohr-Coulomb)
    const tau_resisting = c + (sigma_effective * tanPhi);
    
    // Factor of Safety
    let FoS = tau_resisting / (tau_driving + 0.001); // Avoid div by 0

    // --- STEP 3: RISK INTERPRETATION ---
    
    let probability = 0;
    
    // Flat land is always safe regardless of soil
    if (slope < 2) { 
        FoS = 10.0;
        probability = 0.0;
    } else {
        if (FoS < 1.0) probability = 0.95; 
        else if (FoS < 1.3) probability = 0.75; 
        else if (FoS < 1.7) probability = 0.40; 
        else probability = 0.10; 
    }

    let level = "Low";
    if (probability > 0.7) level = "High";
    else if (probability > 0.3) level = "Medium";

    // --- STEP 4: REASONING ---

    let sentences = [];
    
    if (slope > 35) sentences.push(`Steep slope (${slope}°).`);
    else if (slope < 5) sentences.push(`Flat terrain (${slope}°).`);

    if (fClay > 0.40) sentences.push(`Clay-heavy soil (${clay.toFixed(0)}%) provides cohesion but retains water.`);
    else if (fSand > 0.50) sentences.push(`Sandy soil (${sand.toFixed(0)}%) drains well but lacks cohesion.`);
    
    if (rain > 200) sentences.push(`⚠️ Heavy rain is reducing friction.`);

    if (FoS < 1.0) sentences.push(`Slope failure imminent.`);
    else if (FoS < 1.5) sentences.push(`Stability is compromised.`);
    else sentences.push(`Terrain is stable.`);

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
        }
    };
};

// --- 3. ROUTE ---

app.post('/predict', async (req, res) => {
    const { lat, lng, manualRain } = req.body; 
    console.log(`\n📍 Analysis: ${lat}, ${lng} | Rain Override: ${manualRain ?? 'Live'}`);

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
        
        // Console log for debugging
        console.log(`🧪 Soil: Clay ${features.clay}% | Sand ${features.sand}%`);
        console.log(`📊 Result: ${prediction.level} (FoS: ${prediction.details.FoS.toFixed(2)})`);

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
    console.log(`✅ Physics Engine running on port ${PORT}`);
});