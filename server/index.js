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

// ... existing imports and fetch functions remain the same ...

// --- 2. ADVANCED PHYSICS ENGINE & REASONING ---

const calculateLandslideRisk = (features) => {
    const { rain, slope, clay, sand, silt, bulk_density } = features;

    // --- A. GEOTECH PARAMETERS ---
    // Normalize percentages
    const fClay = clay / 100;
    const fSand = sand / 100;
    const fSilt = silt / 100;

    // 1. Cohesion (c) & Friction (phi)
    // We use weighted averages based on soil composition
    let c = (fClay * 35) + (fSilt * 10) + (fSand * 1); 
    let phi = (fSand * 34) + (fSilt * 28) + (fClay * 20); 

    // --- B. PHYSICS (Infinite Slope Model) ---
    const gamma = (bulk_density / 100) * 9.81; // Unit Weight (kN/m3)
    const z = 4.0; // Slip depth (meters)
    const beta = slope * (Math.PI / 180); // Slope in Radians

    // Forces
    const sigma = gamma * z * Math.pow(Math.cos(beta), 2); // Normal Stress
    const tau_driving = gamma * z * Math.sin(beta) * Math.cos(beta); // Shear Stress

    // --- C. HYDROLOGY (Pore Water Pressure) ---
    // Rain intensity (rain) is passed as scaled units from the route.
    // We calculate 'm', the saturation ratio (0 to 1).
    let m = 0; 
    if (rain > 1000) m = 1.0;       // Fully saturated (Flood/Storm)
    else if (rain > 500) m = 0.6;   // Heavy Rain
    else if (rain > 100) m = 0.2;   // Light Rain

    // Pore water pressure (u) reduces friction
    // u = m * unit_weight_water * z * cos^2(beta)
    const gamma_w = 9.81; 
    const u = m * gamma_w * z * Math.pow(Math.cos(beta), 2);

    // Effective Normal Stress (The actual grip of the soil)
    const sigma_effective = Math.max(0, sigma - u);

    // Resisting Strength (Coulomb Equation)
    const tanPhi = Math.tan(phi * (Math.PI / 180));
    const tau_resisting = c + (sigma_effective * tanPhi);

    // --- D. FACTOR OF SAFETY (FoS) ---
    let FoS = tau_resisting / (tau_driving + 0.0001); // Avoid div by 0

    // Handle flat terrain edge case
    if (slope < 2) FoS = 10; 

    // --- E. INTELLIGENT REASONING GENERATOR ---
    // This logic determines *WHY* the FoS is low/high
    
    let contributors = [];
    let state = "";

    // 1. Analyze Slope
    if (slope > 40) contributors.push("critically steep slope");
    else if (slope > 30) contributors.push("steep terrain");

    // 2. Analyze Soil
    if (fClay > 0.4) contributors.push("weak clay soil");
    else if (fSand > 0.6 && slope > 30) contributors.push("loose sandy soil");

    // 3. Analyze Water
    if (m > 0.5) contributors.push("high pore water pressure");
    else if (m > 0.1) contributors.push("soil saturation");

    // Construct the sentence
    if (FoS < 1.0) {
        state = "CRITICAL FAILURE.";
        if (m > 0.5 && slope > 25) {
            state += " Rain has liquefied the slope.";
        } else if (slope > phi) {
            state += " Slope angle exceeds soil friction angle.";
        }
    } else if (FoS < 1.3) {
        state = "Unstable.";
        if (m > 0) state += " Rainfall is reducing soil grip.";
        else state += " Near equilibrium limit.";
    } else {
        state = "Stable.";
    }

    // Join contributors naturally
    let cause = contributors.length > 0 
        ? `Driven by ${contributors.join(" and ")}.` 
        : "Conditions are within safety limits.";

    const reason = `${state} ${cause} (FoS: ${FoS.toFixed(2)})`;

    // Calculate Risk Level for UI
    let level = "Low";
    if (FoS < 1.0) level = "High";
    else if (FoS < 1.3) level = "Medium";

    return {
        level,
        reason, // This is now the detailed string
        details: {
            FoS: FoS,
            cohesion: c.toFixed(2),
            friction: phi.toFixed(2),
            saturation: (m * 100).toFixed(0) + "%"
        }
    };
};

app.post('/predict', async (req, res) => {
    const { lat, lng, manualRain } = req.body;
    console.log(`\n📍 Analysis: ${lat}, ${lng} | Rain Override: ${manualRain}`);

    try {
        const [weather, soil, topo] = await Promise.all([
            fetchWeather(lat, lng),
            fetchSoil(lat, lng),
            calculateSlope(lat, lng)
        ]);

        let features = { ...weather, ...soil, ...topo };
        let isSimulated = false;

        // Apply Manual Rain Override
        if (manualRain !== null && manualRain !== undefined) {
            features.precip_real = manualRain;
            features.rain = manualRain * 10; 
            isSimulated = true;
        }

        const prediction = calculateLandslideRisk(features);
        
        console.log(`📊 AI Reason: ${prediction.reason}`);

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