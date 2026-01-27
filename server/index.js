// server.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { initSoils, getSoilProperties, detectSoilType } = require("./soilRaster");

const app = express();

// Init soil rasters (best-effort)
if (process.env.NODE_ENV !== "test") {
  initSoils().catch((err) => {
    console.warn("⚠️ Soil initialization failed, using defaults:", err.message);
  });
}

// CORS + middleware
app.use(cors({ origin: true, methods: ["GET","POST","OPTIONS","PUT","DELETE"], credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Health & meta
app.get("/health", (req, res) => {
  res.json({ status: "operational", version: "2.0", timestamp: new Date().toISOString(), environment: process.env.NODE_ENV || "unknown" });
});
app.get("/", (req, res) => {
  res.json({ message: "Landslide Detector Backend API", status: "running", version: "2.0", environment: process.env.NODE_ENV || "unknown" });
});

/* -------------------------------
   Helpers: external data fetches
   ------------------------------- */

// Weather: open-meteo (current + daily precipitation for antecedent)
const fetchWeather = async (lat, lon) => {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&past_days=7&forecast_days=1`;
    const response = await axios.get(url, { timeout: 7000 });
    const current = response.data.current || {};
    const daily = response.data.daily || {};
    const rainfall_7day = (daily.precipitation_sum || []).slice(0,7).reduce((a,b) => a + (b||0), 0);
    return {
      temp: current.temperature_2m ?? null,
      temp_max: (daily.temperature_2m_max || [null])[0],
      temp_min: (daily.temperature_2m_min || [null])[0],
      humidity: current.relative_humidity_2m ?? null,
      rain_current: current.precipitation ?? 0,
      rain_7day: rainfall_7day,
      wind_speed: current.wind_speed_10m ?? null,
      code: current.weather_code ?? null
    };
  } catch (e) {
    console.warn("Weather fetch failed:", e.message);
    return { temp: null, temp_max: null, temp_min: null, humidity: null, rain_current: 0, rain_7day: 0, wind_speed: null, code: null };
  }
};

// Soil: from GeoTIFF raster via soilRaster.getSoilProperties (fallbacks handled there)
const fetchSoil = async (lat, lon, depth = 2.5) => {
  try {
    const soilProps = getSoilProperties(lat, lon, depth); // may throw or return fallback
    return {
      bulk_density: soilProps.bulk_density ?? soilProps.gamma ?? 16, // best-effort
      clay: soilProps.clay ?? 30,
      sand: soilProps.sand ?? 35,
      silt: soilProps.silt ?? 35,
      organic_carbon: soilProps.organic_carbon ?? 1.5,
      ph: soilProps.ph ?? 6.5,
      soilType: soilProps.soilType ?? (detectSoilType ? detectSoilType(soilProps) : "Loam"),
      cohesion: soilProps.c ?? null,
      friction_angle: soilProps.phi ?? null,
      permeability: soilProps.permeability ?? null,
      raw: !!soilProps.raw
    };
  } catch (e) {
    console.warn("Soil fetch failed, using inferred defaults:", e.message);
    // sensible tropical defaults
    return {
      bulk_density: 16, // kN/m3 typical
      clay: 35,
      sand: 30,
      silt: 35,
      organic_carbon: 1.5,
      ph: 6.5,
      soilType: "Loam",
      cohesion: null,
      friction_angle: null,
      permeability: null,
      raw: false
    };
  }
};

// Simple DEM-derived slope using open-meteo elevation endpoint (coarse but OK for point-based app)
const calculateSlope = async (lat, lon) => {
  try {
    const offset = 0.003; // ~300m sampling
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat},${lat + offset},${lat - offset},${lat}&longitude=${lon},${lon},${lon},${lon + offset}`;
    const response = await axios.get(url, { timeout: 7000 });
    const elev = response.data.elevation || [];
    if (!Array.isArray(elev) || elev.length < 4) return { elevation: 0, slope: 0, aspect: 0 };
    const h0 = elev[0], hN = elev[1], hS = elev[2], hE = elev[3];
    const dist = 333; // approximate meters for offset
    const dz_dx = (hE - h0) / dist;
    const dz_dy = (hN - hS) / (2 * dist);
    const rise = Math.sqrt(dz_dx*dz_dx + dz_dy*dz_dy);
    const slopeDeg = Math.atan(rise) * (180 / Math.PI);
    const aspect = Math.atan2(dz_dx, dz_dy) * (180 / Math.PI);
    return { elevation: h0 ?? 0, slope: parseFloat(slopeDeg.toFixed(2)), aspect: Number.isFinite(aspect) ? Math.round(aspect) : 0 };
  } catch (e) {
    console.warn("Elevation fetch failed:", e.message);
    return { elevation: 0, slope: 0, aspect: 0 };
  }
};

/* -------------------------------
   Soil texture classifier (USDA-like)
   ------------------------------- */
const classifySoilTexture = (clay, sand, silt) => {
  const sum = (clay||0) + (sand||0) + (silt||0);
  if (sum === 0) return "Unknown";
  const nClay = (clay / sum) * 100;
  const nSand = (sand / sum) * 100;
  const nSilt = (silt / sum) * 100;
  if (nClay >= 40) {
    if (nSilt >= 40) return "Silty Clay";
    if (nSand <= 45) return "Clay";
    return "Silty Clay";
  }
  if (nClay >= 35 && nSand >= 45) return "Sandy Clay";
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
  if (nSilt >= 80 && nClay < 12) return "Silt";
  if (nSilt >= 50) return "Silt Loam";
  if ((nSilt + 1.5 * nClay) < 15) return "Sand";
  if ((nSilt + 2 * nClay) < 30) return "Loamy Sand";
  if (nSand > 52 || (nClay < 7 && nSilt < 50)) return "Sandy Loam";
  return "Loam";
};

/* -------------------------------
   Climate quick classifier (simple)
   ------------------------------- */
const getKoppenClimate = (lat, temp, temp_max, temp_min, rain_7day) => {
  const absLat = Math.abs(lat);
  const avgTemp = ( (temp_max || temp || 20) + (temp_min || temp || 10) ) / 2;
  if (absLat > 66) return { zone: "Polar", vegetation: "minimal", permafrost: temp < 0 };
  if (avgTemp > 18 && (rain_7day || 0) > 50) return { zone: "Tropical", vegetation: "dense", permafrost: false };
  if (avgTemp > 18) return { zone: "Warm", vegetation: "sparse", permafrost: false };
  return { zone: "Temperate", vegetation: "moderate", permafrost: false };
};

/* -------------------------------
   MAIN: Hybrid Landslide Risk (GSI-style LSI + optional FoS)
   ------------------------------- */
function calculateLandslideRisk(features) {
  // features: slope, elevation, rain_7day, rain_current, clay, sand, silt, soilType, cohesion, friction_angle, bulk_density, depth, climate (optional)
  const slope = Number.isFinite(features.slope) ? features.slope : 0;
  const rain7 = Number.isFinite(features.rain_7day) ? features.rain_7day : 0;
  const clay = Number.isFinite(features.clay) ? features.clay : (features.soil ? features.soil.clay : 30);
  const sand = Number.isFinite(features.sand) ? features.sand : (features.soil ? features.soil.sand : 35);
  const silt = Number.isFinite(features.silt) ? features.silt : Math.max(0, 100 - clay - sand);
  const depth = Number.isFinite(features.depth) ? features.depth : 2.5;
  const soilType = features.soilType || classifySoilTexture(clay, sand, silt);

  // 1) Factor scores (GSI-inspired bins)
  let slopeScore = 1;
  if (slope < 10) slopeScore = 1;
  else if (slope < 20) slopeScore = 2;
  else if (slope < 30) slopeScore = 3;
  else if (slope < 40) slopeScore = 4;
  else slopeScore = 5;

  let rainScore = 1;
  if (rain7 < 50) rainScore = 1;
  else if (rain7 < 100) rainScore = 2;
  else if (rain7 < 150) rainScore = 3;
  else if (rain7 < 250) rainScore = 4;
  else rainScore = 5;

  let soilScore = 3;
  if (/Clay/i.test(soilType)) soilScore = 5;
  else if (/Silt/i.test(soilType)) soilScore = 4;
  else if (/Loam/i.test(soilType)) soilScore = 3;
  else if (/Sand/i.test(soilType)) soilScore = 2;

  let depthScore = 1;
  if (depth < 1) depthScore = 1;
  else if (depth < 3) depthScore = 2;
  else if (depth < 5) depthScore = 3;
  else if (depth < 10) depthScore = 4;
  else depthScore = 5;

  // 2) Weighted overlay (AHP-like weights - can be tuned regionally)
  const WEIGHTS = { slope: 0.40, rainfall: 0.30, soil: 0.20, depth: 0.10 };
  const LSI = slopeScore * WEIGHTS.slope + rainScore * WEIGHTS.rainfall + soilScore * WEIGHTS.soil + depthScore * WEIGHTS.depth;

  // 3) Convert to susceptibility class
  let level = "Low";
  if (LSI < 1.8) level = "Very Low";
  else if (LSI < 2.6) level = "Low";
  else if (LSI < 3.4) level = "Moderate";
  else if (LSI < 4.2) level = "High";
  else level = "Very High";

  // 4) Optional, simplified FoS (infinite-slope style) - only if we have reasonable soil strength values
  let FoS = null;
  let FoS_note = "Not computed (insufficient geotechnical inputs)";
  try {
    // need some values: cohesion (c), friction angle (phi), bulk_density (gamma)
    const hasC = Number.isFinite(features.cohesion);
    const hasPhi = Number.isFinite(features.friction_angle);
    const hasGamma = Number.isFinite(features.bulk_density);
    // adopt safe default estimates (indicative only)
    const c = hasC ? features.cohesion : ( /Clay/i.test(soilType) ? 20 : /Loam|Silt/i.test(soilType) ? 10 : 5 );
    const phi = hasPhi ? features.friction_angle : ( /Sand/i.test(soilType) ? 30 : /Clay/i.test(soilType) ? 20 : 26 );
    // bulk density in kN/m3 if available else fallback 18 kN/m3
    let gamma_kN = hasGamma ? Number(features.bulk_density) : 18; // typical 16-20 kN/m3
    // Convert to consistent units: use kN/m3 for gamma, depth in m
    const beta = slope * (Math.PI / 180);
    // pore-pressure proxy: antecedent saturation from rain7 (0..1)
    const saturation = Math.min(rain7 / 200, 1.0);
    const u = gamma_kN * depth * saturation * 0.4; // very approximate pore-pressure (kN/m2)
    // normal effective stress approx:
    const sigma = gamma_kN * depth * Math.pow(Math.cos(beta), 2);
    const sigma_eff = Math.max(0.0, sigma - u);
    const tanPhi = Math.tan(phi * Math.PI / 180);
    const tau_resist = c + sigma_eff * tanPhi;
    const tau_drive = gamma_kN * depth * Math.sin(beta) * Math.cos(beta);
    if (tau_drive <= 0) {
      FoS = 999; // flat surface
      FoS_note = "Flat or negligible driving stress";
    } else {
      FoS = tau_resist / (tau_drive + 1e-6);
      FoS_note = "Indicative infinite-slope FoS (simplified)";
    }
    FoS = Number.isFinite(FoS) ? Number(FoS.toFixed(2)) : null;
  } catch (err) {
    FoS = null;
    FoS_note = "FoS calculation failed";
  }

  // 5) Short reason text (concise, useful for UI)
  const reasons = [];
  reasons.push(`Slope: ${slope.toFixed(1)}° (score ${slopeScore})`);
  reasons.push(`7-day rain: ${rain7.toFixed(0)} mm (score ${rainScore})`);
  reasons.push(`Soil: ${soilType} (score ${soilScore})`);
  reasons.push(`Depth proxy: ${depth} m (score ${depthScore})`);
  reasons.push(`LSI: ${LSI.toFixed(2)} → ${level}`);

  return {
    level,
    susceptibility_index: Number(LSI.toFixed(2)),
    soil_type: soilType,
    reason: reasons.join(" • "),
    details: {
      FoS,
      FoS_note,
      depth,
      slope,
      rain_7day: rain7,
      clay, sand, silt
    }
  };
}

/* -------------------------------
   Main /predict route
   ------------------------------- */
app.post("/predict", async (req, res) => {
  const { lat, lng, manualRain, depth } = req.body || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat and lng required (numeric)" });
  }

  const depthVal = Number.isFinite(depth) ? depth : 2.5;
  try {
    const [weather, soil, topo] = await Promise.all([
      fetchWeather(lat, lng),
      fetchSoil(lat, lng, depthVal),
      calculateSlope(lat, lng)
    ]);

    // Apply manual rain override if simulation mode
    if (manualRain !== null && manualRain !== undefined && !Number.isNaN(Number(manualRain))) {
      weather.rain_current = Number(manualRain);
      weather.rain_7day = Number(manualRain) * 7;
    }

    const climate = getKoppenClimate(lat, weather.temp, weather.temp_max, weather.temp_min, weather.rain_7day);

    // Compose features for risk function
    const features = {
      slope: topo.slope,
      elevation: topo.elevation,
      rain_current: weather.rain_current,
      rain_7day: weather.rain_7day,
      temp: weather.temp,
      clay: soil.clay,
      sand: soil.sand,
      silt: soil.silt,
      soilType: soil.soilType,
      cohesion: soil.cohesion,
      friction_angle: soil.friction_angle,
      bulk_density: soil.bulk_density,
      depth: depthVal,
      climate
    };

    const prediction = calculateLandslideRisk(features);

    // Log concise info for debugging
    console.log(`[PREDICT] ${lat},${lng} | slope=${topo.slope}° elev=${topo.elevation}m rain7=${weather.rain_7day}mm soil=${features.soilType} LSI=${prediction.susceptibility_index} level=${prediction.level}`);

    // Return full structured response
    return res.json({
      location: { lat, lng },
      timestamp: new Date().toISOString(),
      climate,
      data: { weather, soil: { ...soil }, topo },
      prediction,
      isSimulated: !!(manualRain !== null && manualRain !== undefined)
    });
  } catch (err) {
    console.error("Predict failed:", err);
    return res.status(500).json({ error: "Analysis failed", message: err.message });
  }
});

// Export & start (local)
module.exports = app;
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`✅ Landslide Prediction API running on port ${PORT}`);
  });
}
