const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

// --- 1. DATA FETCHING ---

// Updated Weather Fetcher (Gets Temp, Humidity, Rain)
const fetchWeather = async (lat, lon) => {
    try {
        // Requesting specific current variables: Temp, Humidity, Rain, Weather Code
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code`;
        
        const response = await axios.get(url);
        const current = response.data.current;
        
        // Extract values
        const temp = current.temperature_2m;       // degrees Celsius
        const humidity = current.relative_humidity_2m; // percent %
        const precip = current.precipitation;      // mm
        const code = current.weather_code;

        // Determine Rain Intensity for Physics Engine
        let rainIntensity = 0;
        if (precip > 0) rainIntensity = precip * 10; // Simple scaling for physics
        if (code >= 95) rainIntensity = 100;         // Storm override

        return { 
            temp, 
            humidity, 
            rain: rainIntensity, 
            precip_real: precip // Actual mm value for display
        }; 
    } catch (e) {
        console.error("Weather API Error", e.message);
        return { temp: 30, humidity: 70, rain: 0, precip_real: 0 }; // Fallback
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

        // SoilGrids returns integer values (e.g. 350 = 35.0%)
        // We convert them to proper percentages (0-100) or decimal fractions (0.0-1.0)
        let clay = getVal('clay') / 10;
        let sand = getVal('sand') / 10;
        let bulk_density = getVal('bdod'); // cg/cm3

        // Calculate Silt (Total - Clay - Sand)
        let silt = 100 - clay - sand;
        if (silt < 0) silt = 0;

        return { bulk_density, clay, sand, silt };
    } catch (e) {
        return { bulk_density: 130, clay: 33, sand: 33, silt: 34 }; 
    }
};

// Updated Slope Calculator using Open-Meteo (Global Coverage)
const calculateSlope = async (lat, lon) => {
    try {
        const offset = 0.002; // ~220m gap for better slope detection
        
        // Open-Meteo Elevation API
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat},${lat + offset},${lat}&longitude=${lon},${lon},${lon + offset}`;
        
        const response = await axios.get(url);
        const elevations = response.data.elevation; // Array of 3 elevations

        const h0 = elevations[0];     // Center
        const hNorth = elevations[1]; // North
        const hEast = elevations[2];  // East

        // Calculate Gradient
        const dist = 220; // meters (approx for 0.002 deg)
        const dz_dx = (hEast - h0) / dist;
        const dz_dy = (hNorth - h0) / dist;
        const rise = Math.sqrt(dz_dx*dz_dx + dz_dy*dz_dy);
        
        const slopeRad = Math.atan(rise);
        const slopeDeg = slopeRad * (180 / Math.PI);

        return { elevation: h0, slope: parseFloat(slopeDeg.toFixed(1)) };
    } catch (e) {
        console.error("Elevation API Error", e.message);
        return { elevation: 10, slope: 0 };
    }
};

// --- 2. ADVANCED PHYSICS ENGINE ---

const calculateLandslideRisk = (features) => {
    const { rain, slope, clay, sand, silt, bulk_density } = features;

    // --- A. DYNAMIC GEOTECH MAPPING ---
    // Instead of constants, we mix values based on soil percentage.
    
    // Fractions (0.0 to 1.0)
    const fClay = clay / 100;
    const fSand = sand / 100;
    const fSilt = silt / 100;

    // 1. Calculate Cohesion (c) in kPa
    // Clay is sticky (High c), Sand is loose (Low c).
    // Pure Clay ≈ 35 kPa, Pure Silt ≈ 10 kPa, Pure Sand ≈ 1 kPa
    let c = (fClay * 35) + (fSilt * 10) + (fSand * 1);

    // 2. Calculate Friction Angle (phi) in Degrees
    // Sand locks together (High phi), Clay slides (Low phi).
    // Pure Sand ≈ 34°, Pure Silt ≈ 28°, Pure Clay ≈ 18°
    let phi = (fSand * 34) + (fSilt * 28) + (fClay * 18);

    // --- B. PHYSICS (Mohr-Coulomb) ---
    
    const gamma = (bulk_density / 100) * 9.81; // Unit Weight
    const z = 3.0; // Assume deeper slip surface for realistic landslide (3m)
    const beta = slope * (Math.PI / 180); // Slope in Radians

    // Forces
    const sigma = gamma * z * Math.pow(Math.cos(beta), 2); // Normal Stress
    const tau_driving = gamma * z * Math.sin(beta) * Math.cos(beta); // Shear Stress (Driving)

    // Rainfall Logic (Pore Pressure)
    // Rain creates uplift (u) which reduces friction
    let u = 0;
    if (rain > 80) u = sigma * 0.5;      // Fully saturated
    else if (rain > 40) u = sigma * 0.3; // Partially saturated
    else if (rain > 10) u = sigma * 0.1; // Wet

    const sigma_effective = Math.max(0, sigma - u);

    // Resisting Strength
    const tanPhi = Math.tan(phi * (Math.PI / 180));
    const tau_resisting = c + (sigma_effective * tanPhi);

    // Factor of Safety (FoS)
    let FoS = tau_resisting / (tau_driving + 0.001);

    // --- C. RISK CLASSIFICATION ---
    
    // Convert FoS to a Percentage Probability (0% to 100%)
    // FoS 1.0 = 50% chance of failure roughly. FoS < 1.0 = High prob.
    // We use a simple inversion mapping.
    
    let probability = 0;
    
    if (slope < 1) { // Only force safe if slope is LESS than 1 degree
    FoS = 20.0;
        probability = 0.01;
    } else {
        // Map FoS range [0.5 ... 3.0] to Probability [1.0 ... 0.0]
        if (FoS < 1.0) probability = 0.95; // Very High
        else if (FoS < 1.2) probability = 0.75; // High
        else if (FoS < 1.5) probability = 0.40; // Medium
        else if (FoS < 2.0) probability = 0.20; // Low
        else probability = 0.05; // Very Low
    }

    let level = "Low";
    if (probability > 0.7) level = "High";
    else if (probability > 0.3) level = "Medium";

    // Dynamic Reasoning Text
    let reason = `Soil is ${fClay > fSand ? 'Clay-heavy' : 'Sandy'} (${clay.toFixed(0)}% Clay). `;
    if (level === "High") {
        if (rain > 40) reason += "Rainfall destabilized the slope.";
        else reason += "Slope is too steep for this soil type.";
    } else if (level === "Medium") {
        reason += "Monitor closely during rain.";
    } else {
        reason += "Terrain is stable.";
    }

    return {
        level,
        reason,
        probability,
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
    const { lat, lng } = req.body;
    console.log(`\n📍 Analysis: ${lat}, ${lng}`);
    try {
        const [weather, soil, topo] = await Promise.all([
            fetchWeather(lat, lng),
            fetchSoil(lat, lng),
            calculateSlope(lat, lng)
        ]);

        const features = { ...weather, ...soil, ...topo };
        const prediction = calculateLandslideRisk(features);
        
        console.log(`📊 Result: ${prediction.level} (FoS: ${prediction.details.FoS.toFixed(2)})`);

        res.json({
            location: { lat, lng },
            data: features,
            prediction: prediction
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed" });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Accurate Physics Engine running on port ${PORT}`);
});