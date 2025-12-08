import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import axios from 'axios';
import L from 'leaflet';
import icon from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

let DefaultIcon = L.icon({ iconUrl: icon, shadowUrl: iconShadow, iconAnchor: [12, 41] });
L.Marker.prototype.options.icon = DefaultIcon;

function MapClickHandler({ setMarker, predictRisk }) {
    useMapEvents({
        click(e) {
            setMarker(e.latlng);
            predictRisk(e.latlng);
        },
    });
    return null;
}

function App() {
    const [marker, setMarker] = useState(null);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [simMode, setSimMode] = useState(false);
    const [rainValue, setRainValue] = useState(0);
    const [searchQuery, setSearchQuery] = useState('');
    const [depth, setDepth] = useState(2.5); // failure depth in meters

    const getFrictionDisplay = (res) => {
        if (!res || !res.prediction || !res.prediction.details) return '—';
        const details = res.prediction.details;
        const val = details.friction_angle ?? details.friction ?? null;
        return val !== null && val !== undefined ? `${val}°` : '—';
    };

    const getRainDisplay = (res) => {
        if (!res || !res.data) return '—';
        const d = res.data;
        const val = (d.rain_current ?? d.precip_real ?? d.rain) ?? null;
        return val !== null && val !== undefined ? `${parseFloat(val).toFixed(1)} mm` : '—';
    };

    // Re-run when rain slider moves in sim mode
    useEffect(() => {
        if (marker && simMode) {
            const timer = setTimeout(() => {
                predictRisk(marker, rainValue);
            }, 500);
            return () => clearTimeout(timer);
        }
    }, [rainValue, simMode]);

    // Re-run when depth changes (if there's already a selected location)
    useEffect(() => {
        if (marker) {
            const timer = setTimeout(() => {
                predictRisk(marker);
            }, 400);
            return () => clearTimeout(timer);
        }
    }, [depth]);

    const predictRisk = async (latlng, manualRainOverride = null) => {
        setLoading(true);
        try {
            const rainToSend = (simMode && manualRainOverride !== null) ? manualRainOverride : (simMode ? rainValue : null);

            const response = await axios.post('https://landslide-detector-backend.vercel.app/predict', {
                lat: latlng.lat,
                lng: latlng.lng,
                manualRain: rainToSend,
                depth: Number(depth) || 2.5
            });
            setResult(response.data);
        } catch (error) {
            console.error(error);
            alert("Server Error. Make sure the backend is running!");
        } finally {
            setLoading(false);
        }
    };

    // Manual location search using Nominatim
    const handleLocationSearch = async () => {
        const q = searchQuery.trim();
        if (!q) return;
        try {
            setLoading(true);
            const res = await axios.get('https://nominatim.openstreetmap.org/search', {
                params: {
                    q,
                    format: 'json',
                    limit: 1
                },
                headers: {
                    // Nominatim wants some identification; from browser this is best effort
                    'Accept-Language': 'en'
                }
            });

            if (!res.data || res.data.length === 0) {
                alert("Location not found. Try a more specific name.");
                return;
            }

            const loc = res.data[0];
            const lat = parseFloat(loc.lat);
            const lng = parseFloat(loc.lon);

            const latlng = { lat, lng };
            setMarker(latlng);
            predictRisk(latlng);
        } catch (err) {
            console.error(err);
            alert("Location search failed.");
        } finally {
            setLoading(false);
        }
    };

        const handleUseMyLocation = () => {
        if (!navigator.geolocation) {
            alert("Geolocation is not supported in this browser.");
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                const latlng = { lat, lng };
                setMarker(latlng);
                predictRisk(latlng);
            },
            (err) => {
                console.error(err);
                alert("Failed to get location. Make sure location permission is allowed.");
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 60000,
            }
        );
    };


    const getEnvironmentIcon = (env) => {
        const icons = {
            "Water Body": "🌊",
            "River/Stream": "🏞️",
            "Polar/Glacier": "❄️",
            "Snow-Covered": "⛷️",
            "Desert": "🏜️",
            "Rock Outcrop": "⛰️",
            "Land Surface": "🏔️"
        };
        return icons[env] || "📍";
    };

    return (
        <div className="relative h-screen w-screen bg-slate-900 font-sans text-slate-800">
            
            <div className="absolute top-4 left-4 z-[1000] w-80 md:w-96 flex flex-col gap-4 max-h-[calc(100vh-2rem)] overflow-y-auto">
                
                <div className="bg-white/95 backdrop-blur-md p-5 rounded-2xl shadow-xl border-l-8 border-cyan-500">
                    <h1 className="text-2xl font-extrabold text-slate-800">LAP <span className="text-cyan-500">SUS</span></h1>
                    <p className="text-xs text-slate-500 mt-1">Real-time Landslide Analysis System</p>
                </div>

                {/* Manual location search + depth input */}
                                {/* Manual location search + depth input */}
                <div className="bg-white/95 backdrop-blur-md p-4 rounded-xl shadow-lg space-y-3">
                    <div className="space-y-1.5">
                        <p className="text-xs font-bold uppercase text-slate-500">Location</p>

                        {/* Search bar */}
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search place (eg. Munnar, Kerala)"
                                className="flex-1 px-2 py-1.5 text-xs border rounded-lg border-slate-300 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                            />
                            <button
                                onClick={handleLocationSearch}
                                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-600 text-white hover:bg-cyan-700"
                            >
                                Go
                            </button>
                        </div>

                        {/* Auto location button */}
                        <button
                            onClick={handleUseMyLocation}
                            className="w-full mt-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-emerald-500 text-emerald-700 hover:bg-emerald-50 flex items-center justify-center gap-1"
                        >
                            <span>Use My Current Location</span>
                        </button>
                    </div>


                    <div>
                        <div className="flex justify-between items-center mb-1">
                            <span className="text-xs font-bold uppercase text-slate-500">Failure Depth</span>
                            <span className="text-[11px] text-slate-600">{depth} m</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                type="range"
                                min="0.5"
                                max="15"
                                step="0.5"
                                value={depth}
                                onChange={(e) => setDepth(Number(e.target.value))}
                                className="flex-1 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                            />
                            <input
                                type="number"
                                min="0.5"
                                max="15"
                                step="0.5"
                                value={depth}
                                onChange={(e) => setDepth(Number(e.target.value) || 2.5)}
                                className="w-16 px-2 py-1 text-xs border rounded-lg border-slate-300 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                            />
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1">Approximate depth of potential failure plane.</p>
                    </div>
                </div>

                <div className="bg-white/95 backdrop-blur-md p-4 rounded-xl shadow-lg">
                    <div className="flex justify-between items-center mb-3">
                        <span className="text-xs font-bold uppercase text-slate-500">Simulation Mode</span>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input type="checkbox" checked={simMode} onChange={(e) => setSimMode(e.target.checked)} className="sr-only peer" />
                            <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-cyan-500"></div>
                        </label>
                    </div>

                    {simMode ? (
                        <div>
                            <div className="flex justify-between text-xs font-bold text-slate-600 mb-1">
                                <span>Rainfall Amount</span>
                                <span className="text-cyan-600">{rainValue} mm</span>
                            </div>
                            <input 
                                type="range" 
                                min="0" 
                                max="200" 
                                step="5"
                                value={rainValue} 
                                onChange={(e) => setRainValue(Number(e.target.value))}
                                className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                            />
                            <p className="text-[10px] text-slate-400 mt-1 text-center">Test extreme weather scenarios</p>
                        </div>
                    ) : (
                        <p className="text-xs text-slate-400 italic">Using Live Weather Data</p>
                    )}
                </div>

                {loading && (
                    <div className="bg-cyan-600 text-white p-4 rounded-xl shadow-lg animate-pulse flex items-center gap-3">
                        <div className="w-5 h-5 border-4 border-white border-t-transparent rounded-full animate-spin"></div>
                        <span className="font-bold text-sm">Analyzing Terrain...</span>
                    </div>
                )}

                {result && (
                    <div className="bg-white/95 backdrop-blur-md rounded-2xl shadow-2xl overflow-hidden transition-all duration-500">
                        
                        <div className={`p-5 text-white flex justify-between items-center ${
                            result.prediction.level === 'High' ? 'bg-red-600' :
                            result.prediction.level === 'Medium' ? 'bg-orange-500' : 'bg-green-600'
                        }`}>
                            <div>
                                <p className="text-xs uppercase font-bold opacity-80">Risk Level</p>
                                <h2 className="text-3xl font-bold">{result.prediction.level}</h2>
                                <p className="text-xs opacity-90 mt-1">
                                    {getEnvironmentIcon(result.prediction.environment)} {result.prediction.environment}
                                </p>
                            </div>
                            <div className="text-right">
                                <p className="text-xs opacity-80">Safety Factor</p>
                                <p className="text-2xl font-mono">{result.prediction.details.FoS.toFixed(2)}</p>
                                <p className="text-[10px] opacity-70 mt-1">
                                    {result.prediction.details.FoS < 1 ? "FAILURE" : 
                                     result.prediction.details.FoS < 1.5 ? "UNSTABLE" : "STABLE"}
                                </p>
                            </div>
                        </div>

                        <div className="p-5 space-y-4 max-h-[50vh] overflow-y-auto">
                            
                            <div className="bg-gradient-to-br from-slate-50 to-slate-100 p-4 rounded-lg border-l-4 border-cyan-500">
                                <p className="text-[10px] text-slate-500 uppercase font-bold mb-2 flex items-center gap-1">
                                    <span>🧠</span> AI Analysis
                                </p>
                                <p className="text-sm font-medium text-slate-700 leading-relaxed">{result.prediction.reason}</p>
                            </div>

                            {/* FIX: soil_type instead of soilType */}
                            {result.prediction.soil_type && (
                                <div className="bg-amber-50 p-3 rounded-lg border border-amber-200">
                                    <p className="text-[10px] text-amber-700 uppercase font-bold mb-1">Soil Classification</p>
                                    <p className="text-lg font-bold text-amber-900">{result.prediction.soil_type}</p>
                                    <p className="text-xs text-amber-600 mt-1">
                                        Clay: {result.data.clay.toFixed(0)}% | Sand: {result.data.sand.toFixed(0)}% | Silt: {result.data.silt.toFixed(0)}%
                                    </p>
                                </div>
                            )}

                            <div>
                                <h3 className="text-xs font-bold text-slate-400 uppercase mb-2 flex items-center gap-1">
                                    {result.isSimulated ? "⚗️ Simulated Weather" : "🌤️ Live Weather"}
                                </h3>
                                <div className="grid grid-cols-3 gap-2">
                                    <StatBox label="Temp" value={`${result.data.temp}°C`} />
                                    <StatBox label="Humidity" value={`${result.data.humidity}%`} />
                                    <div className={`p-2 rounded border ${result.isSimulated ? 'bg-cyan-50 border-cyan-300' : 'bg-slate-50 border-slate-200'}`}>
                                        <p className={`text-[10px] uppercase tracking-wide font-bold ${result.isSimulated ? 'text-cyan-600' : 'text-slate-400'}`}>Rainfall</p>
                                        <p className={`text-lg font-bold ${result.isSimulated ? 'text-cyan-700' : 'text-slate-700'}`}>{getRainDisplay(result)}</p>
                                    </div>
                                </div>
                            </div>

                            <div>
                                <h3 className="text-xs font-bold text-slate-400 uppercase mb-2 flex items-center gap-1">
                                    ⛰️ Terrain Analysis
                                </h3>
                                <div className="grid grid-cols-2 gap-2">
                                    <StatBox 
                                        label="Slope Angle" 
                                        value={`${result.data.slope}°`} 
                                        warning={result.data.slope > 25}
                                    />
                                    <StatBox label="Elevation" value={`${Math.round(result.data.elevation)}m`} />
                                </div>
                            </div>

                            <div>
                                <h3 className="text-xs font-bold text-slate-400 uppercase mb-2 flex items-center gap-1">
                                    🔬 Soil Physics
                                </h3>
                                <div className="grid grid-cols-2 gap-2">
                                    <StatBox label="Cohesion (c)" value={`${result.prediction.details.cohesion} kPa`} />
                                    <StatBox label="Friction (φ)" value={getFrictionDisplay(result)} />
                                    <StatBox 
                                        label="Shear Strength" 
                                        value={`${result.prediction.details.shear_strength} kPa`}
                                        highlight={true}
                                    />
                                    <StatBox 
                                        label="Shear Stress" 
                                        value={`${result.prediction.details.shear_stress} kPa`}
                                        warning={parseFloat(result.prediction.details.shear_stress) > parseFloat(result.prediction.details.shear_strength)}
                                    />
                                </div>
                                {result.prediction.details.depth && (
                                    <p className="text-[10px] text-slate-500 mt-1">
                                        Failure depth used: {result.prediction.details.depth} m
                                    </p>
                                )}
                            </div>

                            <div className="bg-blue-50 p-3 rounded-lg border border-blue-200">
                                <p className="text-[10px] text-blue-600 uppercase font-bold mb-1">📍 Location</p>
                                <p className="text-xs text-blue-800 font-mono">
                                    {result.location.lat.toFixed(4)}°N, {result.location.lng.toFixed(4)}°E
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <MapContainer center={[10.8505, 76.2711]} zoom={8} scrollWheelZoom={true} className="h-full w-full z-0">
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                <MapClickHandler setMarker={setMarker} predictRisk={predictRisk} />
                {marker && <Marker position={marker} />}
            </MapContainer>
        </div>
    );
}

function StatBox({ label, value, warning = false, highlight = false }) {
    return (
        <div className={`p-2 rounded border ${
            warning ? 'bg-red-50 border-red-300' : 
            highlight ? 'bg-green-50 border-green-300' :
            'bg-slate-50 border-slate-200'
        }`}>
            <p className={`text-[10px] uppercase tracking-wide font-bold ${
                warning ? 'text-red-600' : 
                highlight ? 'text-green-600' :
                'text-slate-400'
            }`}>{label}</p>
            <p className={`text-lg font-bold ${
                warning ? 'text-red-700' : 
                highlight ? 'text-green-700' :
                'text-slate-700'
            }`}>{value}</p>
        </div>
    );
}

export default App;