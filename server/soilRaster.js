const fs = require('fs');
const path = require('path');

// GeoTIFF is optional - app works without it
let GeoTIFF;
try {
    GeoTIFF = require('geotiff');
} catch (e) {
    GeoTIFF = null;
}

// Cache for loaded GeoTIFF data
let soilDataCache = {
    clayey: null,
    clayskeletal: null,
    loamy: null,
    sandy: null,
    metadata: null,
    initialized: true, // Default to true - no blocking initialization
    available: false // Whether TIFFs are actually loaded
};

// Default soil property mappings for different soil types
const SOIL_PROPERTIES = {
    clayey: {
        clay: 55,
        sand: 15,
        silt: 30,
        cohesion_kPa: 45,
        friction_angle_deg: 18,
        bulk_density: 150,
        permeability: 0.1
    },
    clayskeletal: {
        clay: 50,
        sand: 20,
        silt: 30,
        cohesion_kPa: 35,
        friction_angle_deg: 22,
        bulk_density: 160,
        permeability: 0.2
    },
    loamy: {
        clay: 27,
        sand: 40,
        silt: 33,
        cohesion_kPa: 20,
        friction_angle_deg: 28,
        bulk_density: 140,
        permeability: 5.0
    },
    sandy: {
        clay: 5,
        sand: 85,
        silt: 10,
        cohesion_kPa: 0.5,
        friction_angle_deg: 35,
        bulk_density: 130,
        permeability: 25.0
    }
};

/**
 * Load all GeoTIFF files into memory (non-blocking, optional)
 */
async function initSoils() {
    // Skip initialization - use defaults
    // GeoTIFF files are optional for Vercel deployment
    if (!GeoTIFF) {
        console.log('ℹ️ GeoTIFF unavailable - using default soil parameters');
        soilDataCache.initialized = true;
        soilDataCache.available = false;
        return;
    }

    try {
        const tifFiles = {
            clayey: path.join(__dirname, 'fclayey.tif'),
            clayskeletal: path.join(__dirname, 'fclayskeletal.tif'),
            loamy: path.join(__dirname, 'floamy.tif'),
            sandy: path.join(__dirname, 'fsandy.tif')
        };

        let loadedCount = 0;
        // Load each GeoTIFF file
        for (const [soilType, filePath] of Object.entries(tifFiles)) {
            if (fs.existsSync(filePath)) {
                try {
                    const buffer = fs.readFileSync(filePath);
                    const tiff = await GeoTIFF.fromArrayBuffer(buffer);
                    const image = await tiff.getImage();
                    const data = await image.readRasters();
                    
                    soilDataCache[soilType] = {
                        image: image,
                        data: data[0],
                        width: image.getWidth(),
                        height: image.getHeight(),
                        bbox: image.getBoundingBox()
                    };
                    loadedCount++;
                    console.log(`✓ Loaded ${soilType}.tif (${image.getWidth()}x${image.getHeight()})`);
                } catch (err) {
                    console.warn(`⚠️ Failed to load ${soilType}.tif:`, err.message);
                }
            }
        }

        if (loadedCount > 0) {
            soilDataCache.available = true;
            console.log(`✅ Loaded ${loadedCount}/4 soil rasters`);
        } else {
            console.log('⚠️ No soil rasters loaded, using defaults');
        }
    } catch (error) {
        console.warn('⚠️ Soil raster initialization skipped:', error.message);
    }
    
    soilDataCache.initialized = true;
}

/**
 * Get pixel value from a GeoTIFF at given lat/lon
 */
function getPixelValueAtLocation(tiffData, lat, lon) {
    if (!tiffData || !tiffData.data) return null;

    const [minX, minY, maxX, maxY] = tiffData.bbox;
    
    // Normalize lat/lon to pixel coordinates
    const pixelX = Math.floor(((lon - minX) / (maxX - minX)) * tiffData.width);
    const pixelY = Math.floor(((maxY - lat) / (maxY - minY)) * tiffData.height);

    // Check bounds
    if (pixelX < 0 || pixelX >= tiffData.width || pixelY < 0 || pixelY >= tiffData.height) {
        return null;
    }

    const pixelIndex = pixelY * tiffData.width + pixelX;
    return tiffData.data[pixelIndex];
}

/**
 * Detect soil type based on GeoTIFF values at location
 * Returns which TIF has the highest value (indicating presence of that soil type)
 */
function detectSoilType(lat, lon) {
    const values = {
        clayey: 0,
        clayskeletal: 0,
        loamy: 0,
        sandy: 0
    };

    // Get values from each soil type raster
    for (const [soilType, tiffData] of Object.entries(soilDataCache)) {
        if (soilType === 'metadata') continue;
        
        const value = getPixelValueAtLocation(tiffData, lat, lon);
        if (value !== null && value !== undefined) {
            values[soilType] = value;
        }
    }

    // Find the soil type with the highest value (dominant soil class)
    let dominantType = 'loamy'; // Default fallback
    let maxValue = 0;

    for (const [soilType, value] of Object.entries(values)) {
        if (value > maxValue) {
            maxValue = value;
            dominantType = soilType;
        }
    }

    console.log(`🧪 Detected soil type at (${lat.toFixed(3)}, ${lon.toFixed(3)}): ${dominantType} (value: ${maxValue})`);
    return dominantType;
}

/**
 * Get soil properties from GeoTIFF-based classification
 * This replaces the CSV lookup with raster-based data
 */
function getSoilPropertiesFromRaster(lat, lon, depth) {
    // Detect dominant soil type at this location
    const soilType = detectSoilType(lat, lon);
    const baseProperties = SOIL_PROPERTIES[soilType] || SOIL_PROPERTIES.loamy;

    // Depth adjustment: deeper soils tend to have slightly less cohesion
    const depthFactor = Math.max(0.8, 1 - (depth / 20) * 0.2);
    const adjustedCohesion = baseProperties.cohesion_kPa * depthFactor;

    return {
        soilType: soilType,
        clay: baseProperties.clay,
        sand: baseProperties.sand,
        silt: baseProperties.silt,
        c: adjustedCohesion,
        phi: baseProperties.friction_angle_deg,
        gamma: baseProperties.bulk_density,
        permeability: baseProperties.permeability,
        raw_data: baseProperties
    };
}

/**
 * Get properties from either raster or default based on availability
 */
function getSoilProperties(lat, lon, depth = 2.5) {
    // Try raster-based approach first
    const soilType = detectSoilType(lat, lon);
    
    if (soilType && SOIL_PROPERTIES[soilType]) {
        return getSoilPropertiesFromRaster(lat, lon, depth);
    }

    // Fallback to defaults
    console.warn(`⚠️ No raster data available, using defaults for location`);
    return {
        soilType: 'loamy',
        clay: 27,
        sand: 40,
        silt: 33,
        c: 20,
        phi: 28,
        gamma: 140,
        permeability: 5.0,
        raw_data: SOIL_PROPERTIES.loamy
    };
}

module.exports = {
    initSoils,
    detectSoilType,
    getSoilProperties,
    getSoilPropertiesFromRaster,
    SOIL_PROPERTIES
};
