const express = require("express");
const cors = require("cors");
const axios = require("axios");
const {
  initSoils,
  getSoilProperties,
  detectSoilType,
} = require("./soilRaster");

const app = express();

// Initialize soil rasters in background (non-blocking)
// App continues to work even if this fails
if (process.env.NODE_ENV !== "test") {
  initSoils().catch((err) => {
    console.warn("⚠️ Soil initialization failed, using defaults:", err.message);
  });
}

// ===== CORS CONFIGURATION =====
// Allow all origins for Vercel
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "X-Requested-With",
    ],
    credentials: true,
    maxAge: 86400,
    optionsSuccessStatus: 200,
  }),
);

// Explicit OPTIONS handler for preflight
app.use(cors());

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// ===== HEALTH CHECK - RESPONDS IMMEDIATELY =====
app.get("/health", (req, res) => {
  res.json({
    status: "operational",
    version: "2.0",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "unknown",
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "Landslide Detector Backend API",
    status: "running",
    version: "2.0",
    endpoints: {
      health: "/health",
      predict: "/predict",
      corsTest: "/cors-test",
    },
    environment: process.env.NODE_ENV || "unknown",
  });
});

// CORS test endpoint
app.get("/cors-test", (req, res) => {
  res.json({
    message: "CORS is working!",
    origin: req.get("origin") || "no-origin",
    timestamp: new Date().toISOString(),
  });
});

// ===== DEBUG MIDDLEWARE =====
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  if (req.method === "OPTIONS") {
    console.log("  ↳ Preflight request detected");
  }
  next();
});

// --- 1. ENHANCED DATA FETCHING ---

const fetchWeather = async (lat, lon) => {
  try {
    // Fetch current + 7-day forecast for rainfall history
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&past_days=7&forecast_days=1`;
    const response = await axios.get(url);
    const current = response.data.current;
    const daily = response.data.daily;

    // Calculate 7-day cumulative rainfall
    const rainfall_7day = daily.precipitation_sum
      .slice(0, 7)
      .reduce((a, b) => a + (b || 0), 0);

    return {
      temp: current.temperature_2m,
      temp_max: daily.temperature_2m_max[0],
      temp_min: daily.temperature_2m_min[0],
      humidity: current.relative_humidity_2m,
      rain_current: current.precipitation,
      rain_7day: rainfall_7day,
      wind_speed: current.wind_speed_10m,
      code: current.weather_code,
    };
  } catch (e) {
    console.error("⚠️ Weather API Error:", e.message);
    return {
      temp: 15,
      temp_max: 20,
      temp_min: 10,
      humidity: 50,
      rain_current: 0,
      rain_7day: 0,
      wind_speed: 0,
      code: 0,
    };
  }
};

const fetchSoil = async (lat, lon, depth = 2.5) => {
  try {
    // Use GeoTIFF raster-based soil properties
    const soilProps = getSoilProperties(lat, lon, depth);

    return {
      bulk_density: (soilProps.gamma / 9.81) * 100,
      clay: soilProps.clay,
      sand: soilProps.sand,
      silt: soilProps.silt,
      ph: 7.0,
      organic_carbon: 1.5,
      isWater: false,
      raw: true,
      soilType: soilProps.soilType,
      cohesion: soilProps.c,
      friction_angle: soilProps.phi,
      permeability: soilProps.permeability,
    };
  } catch (e) {
    console.error("⚠️ GeoTIFF Raster Read Error (Using fallback):", e.message);

    // Fallback to location-based defaults
    const absLat = Math.abs(lat);
    const noise = Math.abs(lat * lon) % 13;

    let clay, sand, silt;
    if (absLat > 60) {
      clay = 15 + noise;
      sand = 55 + noise;
      silt = 30 - noise;
    } else if (absLat < 23) {
      clay = 40 + noise;
      sand = 25 + noise;
      silt = 35 - noise;
    } else {
      clay = 30 + noise;
      sand = 35 + noise;
      silt = 35 - noise;
    }

    return {
      bulk_density: 140 + noise,
      clay,
      sand,
      silt,
      ph: 6.5,
      organic_carbon: 2,
      isWater: false,
      raw: false,
      soilType: "loamy",
      cohesion: 20,
      friction_angle: 28,
      permeability: 5.0,
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

    // Ocean detection baseline
    if (h0 === 0 && hNorth === 0 && hEast === 0) {
      return { elevation: 0, slope: 0, aspect: 0 };
    }

    const dist = 333; // ~333m for 0.003 degrees
    const dz_dx = (hEast - h0) / dist;
    const dz_dy = (hNorth - hSouth) / (2 * dist);
    const rise = Math.sqrt(dz_dx * dz_dx + dz_dy * dz_dy);
    const slopeDeg = Math.atan(rise) * (180 / Math.PI);

    // Calculate aspect (direction of slope)
    const aspect = Math.atan2(dz_dx, dz_dy) * (180 / Math.PI);

    return {
      elevation: h0,
      slope: parseFloat(slopeDeg.toFixed(2)),
      aspect: parseFloat(aspect.toFixed(0)),
    };
  } catch (e) {
    console.error("⚠️ Elevation API Error:", e.message);
    return { elevation: 0, slope: 0, aspect: 0 };
  }
};

// --- 2. CLIMATE CLASSIFICATION ---

const getKoppenClimate = (lat, temp, temp_max, temp_min, rain_7day) => {
  const absLat = Math.abs(lat);
  const avgTemp = (temp_max + temp_min) / 2;

  // Simplified Köppen classification
  if (absLat > 66) {
    return {
      zone: "Polar (ET/EF)",
      vegetation: "minimal",
      permafrost: temp < 0,
    };
  } else if (absLat > 60) {
    return {
      zone: "Subarctic (Dfc/Dfd)",
      vegetation: "sparse",
      permafrost: temp < -5,
    };
  } else if (avgTemp < 0) {
    return { zone: "Cold (Df/Dw)", vegetation: "moderate", permafrost: false };
  } else if (avgTemp > 18 && rain_7day > 50) {
    return { zone: "Tropical (Af/Am)", vegetation: "dense", permafrost: false };
  } else if (avgTemp > 18) {
    return {
      zone: "Arid/Semi-arid (BWh/BSh)",
      vegetation: "sparse",
      permafrost: false,
    };
  } else if (temp_max > 22) {
    return {
      zone: "Temperate (Cfa/Cfb)",
      vegetation: "moderate",
      permafrost: false,
    };
  } else {
    return {
      zone: "Continental (Dfa/Dfb)",
      vegetation: "moderate",
      permafrost: false,
    };
  }
};

// --- 3. SOIL TEXTURE CLASSIFICATION (USDA) ---

const classifySoilTexture = (clay, sand, silt) => {
  if (clay < 0 || sand < 0 || silt < 0) {
    throw new Error("Inputs cannot be negative");
  }

  const sum = clay + sand + silt;
  if (sum === 0) return "Unknown";

  const nClay = (clay / sum) * 100;
  const nSand = (sand / sum) * 100;
  const nSilt = (silt / sum) * 100;

  if (nClay >= 40) {
    if (nSilt >= 40) return "Silty Clay";
    if (nSand <= 45) return "Clay";
    return "Silty Clay";
  }

  if (nClay >= 35 && nSand >= 45) {
    return "Sandy Clay";
  }

  if (nClay >= 27) {
    if (nSand <= 20) return "Silty Clay Loam";
    if (nSand <= 45) return "Clay Loam";
    return "Sandy Clay Loam";
  }

  if (nClay >= 20) {
    if (nSilt < 28 && nSand > 45) return "Sandy Clay Loam";
    if (nSilt >= 50) return "Silt Loam";
    return "Loam";
  }

  if (nSilt >= 80 && nClay < 12) {
    return "Silt";
  }

  if (nSilt >= 50) {
    return "Silt Loam";
  }

  if (nSilt + 1.5 * nClay < 15) {
    return "Sand";
  }

  if (nSilt + 2 * nClay < 30) {
    return "Loamy Sand";
  }

  if (nSand > 52 || (nClay < 7 && nSilt < 50)) {
    return "Sandy Loam";
  }

  return "Loam";
};

// --- 4. ENHANCED RISK CALCULATION ---

function calculateLandslideRisk(features) {
    const {
        slope,
        elevation,
        rain_7day,
        clay,
        sand,
        soilType,
        depth
    } = features;

    /* -------------------------------
       1. FACTOR RATINGS (GSI STYLE)
       ------------------------------- */

    // SLOPE (MOST IMPORTANT FACTOR)
    let slopeScore = 0;
    if (slope < 10) slopeScore = 1;
    else if (slope < 20) slopeScore = 2;
    else if (slope < 30) slopeScore = 3;
    else if (slope < 40) slopeScore = 4;
    else slopeScore = 5;

    // RAINFALL (ANTECEDENT, NOT INTENSITY)
    let rainScore = 0;
    if (rain_7day < 50) rainScore = 1;
    else if (rain_7day < 100) rainScore = 2;
    else if (rain_7day < 150) rainScore = 3;
    else if (rain_7day < 250) rainScore = 4;
    else rainScore = 5;

    // SOIL / REGOLITH
    let soilScore = 0;
    if (soilType.includes("Clay")) soilScore = 5;
    else if (soilType.includes("Silt")) soilScore = 4;
    else if (soilType.includes("Loam")) soilScore = 3;
    else if (soilType.includes("Sand")) soilScore = 2;
    else soilScore = 3;

    // WEATHERED DEPTH (FAILURE PLANE PROXY)
    let depthScore = 0;
    if (depth < 1) depthScore = 1;
    else if (depth < 3) depthScore = 2;
    else if (depth < 5) depthScore = 3;
    else if (depth < 10) depthScore = 4;
    else depthScore = 5;

    /* -------------------------------
       2. WEIGHTED OVERLAY (AHP-LIKE)
       ------------------------------- */

    const WEIGHTS = {
        slope: 0.40,
        rainfall: 0.30,
        soil: 0.20,
        depth: 0.10
    };

    const LSI =
        slopeScore * WEIGHTS.slope +
        rainScore * WEIGHTS.rainfall +
        soilScore * WEIGHTS.soil +
        depthScore * WEIGHTS.depth;

    /* -------------------------------
       3. SUSCEPTIBILITY CLASS
       ------------------------------- */

    let level = "Low";
    if (LSI < 1.8) level = "Very Low";
    else if (LSI < 2.6) level = "Low";
    else if (LSI < 3.4) level = "Moderate";
    else if (LSI < 4.2) level = "High";
    else level = "Very High";

    /* -------------------------------
       4. OPTIONAL FoS (SECONDARY)
       ------------------------------- */

    let FoS = 3.0;
    if (level === "Very High") FoS = 0.9;
    else if (level === "High") FoS = 1.2;
    else if (level === "Moderate") FoS = 1.6;
    else FoS = 2.5;

    /* -------------------------------
       5. OUTPUT (HONEST & DEFENSIBLE)
       ------------------------------- */

    return {
        level,
        susceptibility_index: Number(LSI.toFixed(2)),
        environment: "Hill Slope Terrain",
        soil_type: soilType,
        reason: `
Slope class score: ${slopeScore},
Rainfall class score: ${rainScore},
Soil class score: ${soilScore},
Depth class score: ${depthScore}
→ Weighted Landslide Susceptibility Index = ${LSI.toFixed(2)}
`.trim(),
        details: {
            FoS,
            note: "FoS is indicative only. Primary result is susceptibility class.",
            depth
        }
    };
}


  // --- STEP 2: SOIL CLASSIFICATION ---

  const soilTexture = classifySoilTexture(clay, sand, silt);

  // --- STEP 3: ADVANCED GEOTECHNICAL PARAMETERS ---

  const fClay = clay / 100;
  const fSand = sand / 100;
  const fSilt = silt / 100;

  let c_base = fClay * 45 + fSilt * 12 + fSand * 0.5;
  let c_organic = Math.min(organic_carbon * 2, 10);
  let c_dry = c_base + c_organic;

  const saturation = Math.min(rain_7day / 100, 1.0);
  let c = c_dry * (1 - saturation * fClay * 0.4);

  let phi_base = fSand * 38 + fSilt * 32 + fClay * 18;
  let phi = phi_base + (bulk_density / 1000) * 5;

  if (!Number.isFinite(phi)) {
    phi = 30;
  }

  let root_cohesion = 0;
  if (climate.vegetation === "dense") root_cohesion = 15;
  else if (climate.vegetation === "moderate") root_cohesion = 8;
  else if (climate.vegetation === "sparse") root_cohesion = 3;

  c += root_cohesion;

  const rainfall_intensity = rain_current * 10;
  const antecedent_moisture = Math.min(rain_7day / 150, 1.0);

  let infiltration_rate = fSand * 30 + fSilt * 10 + fClay * 2;
  const excess_rain = Math.max(0, rainfall_intensity - infiltration_rate);

  const gamma = (bulk_density / 100) * 9.81;
  const beta = slope * (Math.PI / 180);

  const sigma = gamma * z * Math.pow(Math.cos(beta), 2);
  const tau_driving = gamma * z * Math.sin(beta) * Math.cos(beta);

  let u = 0;
  const base_saturation = antecedent_moisture * 0.5;
  const intensity_factor = Math.min(excess_rain / 20, 0.5);
  const clay_retention = fClay * 0.3;

  u = sigma * (base_saturation + intensity_factor + clay_retention);
  u = Math.min(u, sigma * 0.9);
  if (!Number.isFinite(u)) u = 0;

  const sigma_effective = Math.max(0, sigma - u);
  const tanPhi = Math.tan(phi * (Math.PI / 180));
  const tau_resisting = c + sigma_effective * tanPhi;

  let FoS = tau_resisting / (tau_driving + 0.01);
  if (!Number.isFinite(FoS)) FoS = 15;

  let probability = 0;

  if (slope < 5) {
    FoS = 15.0;
    probability = 0.0;
  } else if (slope < 15) {
    if (FoS < 1.0) probability = 0.6;
    else if (FoS < 1.5) probability = 0.25;
    else probability = 0.05;
  } else if (slope < 30) {
    if (FoS < 1.0) probability = 0.9;
    else if (FoS < 1.3) probability = 0.7;
    else if (FoS < 1.7) probability = 0.35;
    else probability = 0.1;
  } else {
    if (FoS < 1.0) probability = 0.98;
    else if (FoS < 1.2) probability = 0.85;
    else if (FoS < 1.5) probability = 0.55;
    else probability = 0.2;
  }

  if (rainfall_intensity > 30) probability = Math.min(probability * 1.4, 0.99);
  if (rain_7day > 150) probability = Math.min(probability * 1.3, 0.99);

  let level = "Low";
  if (probability > 0.75) level = "Extreme";
  else if (probability > 0.5) level = "High";
  else if (probability > 0.25) level = "Medium";

  let factors = [];

  if (slope > 45)
    factors.push(
      `⚠️ Very steep slope (${slope.toFixed(1)}°) - Highly unstable`,
    );
  else if (slope > 30)
    factors.push(`Steep slope (${slope.toFixed(1)}°) increases risk`);
  else if (slope < 8)
    factors.push(`Gentle slope (${slope.toFixed(1)}°) - Stable terrain`);
  else factors.push(`Moderate slope (${slope.toFixed(1)}°)`);

  factors.push(
    `Soil: ${soilTexture} (${clay.toFixed(0)}% clay, ${sand.toFixed(0)}% sand)`,
  );

  if (soilTexture.includes("Clay") && rain_7day > 50) {
    factors.push(`Clay soil retains water - Reduced friction`);
  } else if (soilTexture.includes("Sand") && rain_7day > 100) {
    factors.push(`Sandy soil drains quickly but lacks cohesion`);
  }

  if (rainfall_intensity > 40) {
    factors.push(
      `🌧️ Extreme rainfall intensity (${rain_current.toFixed(1)} mm/hr)`,
    );
  } else if (rain_7day > 150) {
    factors.push(
      `💧 Prolonged rainfall (${rain_7day.toFixed(0)}mm over 7 days) - Saturated soil`,
    );
  } else if (rain_7day > 75) {
    factors.push(`Moderate cumulative rainfall (${rain_7day.toFixed(0)}mm)`);
  }

  if (root_cohesion > 10) {
    factors.push(
      `🌳 Dense vegetation provides root reinforcement (+${root_cohesion.toFixed(0)} kPa)`,
    );
  }

  if (FoS < 1.0) {
    factors.push(
      `❌ FAILURE IMMINENT (FoS: ${FoS.toFixed(2)}) - Slope cannot support itself`,
    );
  } else if (FoS < 1.3) {
    factors.push(
      `⚠️ Critical stability (FoS: ${FoS.toFixed(2)}) - High failure risk`,
    );
  } else if (FoS < 1.7) {
    factors.push(
      `⚡ Marginal stability (FoS: ${FoS.toFixed(2)}) - Vulnerable to triggers`,
    );
  } else {
    factors.push(`✓ Stable conditions (FoS: ${FoS.toFixed(2)})`);
  }

  const reason = factors.join(" • ");

  const sigmaSafe = sigma > 0 && Number.isFinite(sigma) ? sigma : 1;
  const porePct = Number.isFinite(u / sigmaSafe) ? (u / sigmaSafe) * 100 : 0;

  return {
    level,
    reason,
    environment: climate.zone,
    soil_type: soilTexture,
    details: {
      FoS: parseFloat(FoS.toFixed(2)),
      probability: parseFloat((probability * 100).toFixed(1)),
      cohesion: parseFloat(c.toFixed(1)),
      friction_angle: Number.isFinite(phi) ? parseFloat(phi.toFixed(1)) : 30.0,
      shear_strength: parseFloat(tau_resisting.toFixed(1)),
      shear_stress: parseFloat(tau_driving.toFixed(1)),
      pore_pressure: parseFloat(porePct.toFixed(0)),
      saturation: parseFloat((antecedent_moisture * 100).toFixed(0)),
      infiltration_rate: parseFloat(infiltration_rate.toFixed(1)),
      root_cohesion: parseFloat(root_cohesion.toFixed(1)),
      depth: parseFloat(z.toFixed(2)),
    },
  };
// --- 5. MAIN ROUTE ---

app.post("/predict", async (req, res) => {
  const { lat, lng, manualRain, depth } = req.body;
  console.log(
    `\n📍 Analysis: ${lat}, ${lng} | Rain Override: ${manualRain ?? "Live"} | Depth: ${depth ?? "default"}`,
  );

  try {
    const depthVal = depth ?? 2.5;
    const [weather, soil, topo] = await Promise.all([
      fetchWeather(lat, lng),
      fetchSoil(lat, lng, depthVal),
      calculateSlope(lat, lng),
    ]);

    let features = { ...weather, ...soil, ...topo, depth: depthVal };
    let isSimulated = false;

    if (manualRain !== null && manualRain !== undefined) {
      features.rain_current = manualRain;
      features.rain_7day = manualRain * 7;
      isSimulated = true;
    }

    const climate = getKoppenClimate(
      lat,
      features.temp,
      features.temp_max,
      features.temp_min,
      features.rain_7day,
    );

    const prediction = calculateLandslideRisk(features, climate);

    console.log(
      `🌍 Climate: ${climate.zone} | Vegetation: ${climate.vegetation}`,
    );
    console.log(
      `🏔️ Topography: ${features.elevation}m elevation, ${features.slope}° slope`,
    );
    console.log(
      `🧪 Soil: ${prediction.soil_type} (Clay: ${features.clay?.toFixed?.(0) ?? "N/A"}%, Sand: ${features.sand?.toFixed?.(0) ?? "N/A"}%) | Source: ${features.soilType ?? "default"}`,
    );
    console.log(
      `💧 Rainfall: Current ${features.rain_current}mm | 7-day: ${features.rain_7day.toFixed(0)}mm`,
    );
    console.log(
      `📊 Result: ${prediction.level} Risk (FoS: ${prediction.details.FoS}, Probability: ${prediction.details.probability}%)`,
    );

    res.json({
      location: { lat, lng },
      climate: climate,
      data: features,
      prediction: prediction,
      isSimulated: isSimulated,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Analysis Failed:", error);
    res.status(500).json({ error: "Analysis failed", message: error.message });
  }
});

// ===== EXPORTS & SERVER START =====

// Export app for Vercel serverless
module.exports = app;

// Listen only if running locally
const PORT = process.env.PORT || 5000;
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`✅ Enhanced Landslide Prediction Engine v2.0`);
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(
      `📡 Features: Climate Classification | USDA Soil Texture | Advanced Physics`,
    );
    console.log(`🔗 CORS enabled for all origins`);
  });
}
