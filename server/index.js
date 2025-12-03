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
            rain: current.precipitation * 10, // Physics scaling
            precip_real: current.precipitation,
            code: current.weather_code
        }; 
    } catch (e) {
        console.error("Weather API Error", e.message);
        return { temp: 30, humidity: 70, rain: 0, precip_real: 0 }; 
    }
};

const fetchSoil = async (lat, lon) => {
    try {
        const url = `https://rest.isric.org/soilgrids/v2.0/properties/query?lat=${lat}&lon=${lon}&property=bdod&property=clay&property=sand&depth=0-5cm`;
        const response = await axios.get(url);
        
        const layers = response.data.properties.layers;
        const getVal = (name) => {
            const layer = layers.find(l => l.name === name);
            return layer ? layer.depths[0].values.mean : 0;
        };

        let clay = getVal('clay') / 10;
        let sand = getVal('sand') / 10;
        let bulk_density = getVal('bdod'); 

        let silt = 100 - clay - sand;
        if (silt < 0) silt = 0;

        return { bulk_density, clay, sand, silt };
    } catch (e) {
        return { bulk_density: 130, clay: 33, sand: 33, silt: 34 }; 
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
        return { elevation: 10, slope: 0 };
    }
};

// --- 2. ADVANCED PHYSICS ENGINE ---

const calculateLandslideRisk = (features) => {
    const { rain, slope, clay, sand, silt, bulk_density } = features;

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

    // --- RAIN INFLUENCE ---
    // Higher rain = higher pore pressure (u)
    let u = 0;
    // Note: rain here is "intensity" (mm * 10)
    if (rain > 800) u = sigma * 0.5; // Extreme
    else if (rain > 400) u = sigma * 0.3; 
    else if (rain > 100) u = sigma * 0.1; 

    const sigma_effective = Math.max(0, sigma - u);
    const tanPhi = Math.tan(phi * (Math.PI / 180));
    const tau_resisting = c + (sigma_effective * tanPhi);
    
    let FoS = tau_resisting / (tau_driving + 0.001);

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

    // Dynamic Reasoning
    let reason = `Soil is ${fClay > fSand ? 'Clay-heavy' : 'Sandy'} (${clay.toFixed(0)}% Clay). `;
    if (level === "High") {
        if (rain > 400) reason += "HEAVY RAINFALL destabilized the slope!";
        else reason += "Slope is too steep for this soil type.";
    } else if (level === "Medium") {
        reason += "Monitor closely.";
    } else {
        reason += "Stable conditions.";
    }

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
    // 1. Get manualRain from body
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

        // --- OVERRIDE LOGIC ---
        // If user sent a manual rain value (even 0), we use it.
        if (manualRain !== null && manualRain !== undefined) {
            features.precip_real = manualRain;
            features.rain = manualRain * 10; // Apply physics scaling (mm -> intensity unit)
            isSimulated = true;
        }

        const prediction = calculateLandslideRisk(features);
        
        console.log(`📊 Result: ${prediction.level} (FoS: ${prediction.details.FoS.toFixed(2)})`);

        res.json({
            location: { lat, lng },
            data: features,
            prediction: prediction,
            isSimulated: isSimulated // Tell frontend we faked the weather
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed" });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Accurate Physics Engine running on port ${PORT}`);
});