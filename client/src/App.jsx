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
            predictRisk(e.latlng); // Pass location, use current slider state inside parent
        },
    });
    return null;
}

function App() {
    const [marker, setMarker] = useState(null);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);

    // --- NEW: Rain Simulation State ---
    const [simMode, setSimMode] = useState(false);
    const [rainValue, setRainValue] = useState(0);

    // Trigger prediction when slider moves (if a marker exists)
    useEffect(() => {
        if (marker && simMode) {
            // Debounce slightly to prevent too many requests
            const timer = setTimeout(() => {
                predictRisk(marker, rainValue);
            }, 500);
            return () => clearTimeout(timer);
        }
    }, [rainValue, simMode]);

    const predictRisk = async (latlng, manualRainOverride = null) => {
        setLoading(true);
        // Keep previous result visible while loading new simulation
        // setResult(null); 
        try {
            // Determine if we are sending manual rain or null (for live weather)
            const rainToSend = (simMode && manualRainOverride !== null) ? manualRainOverride : (simMode ? rainValue : null);

            const response = await axios.post('https://landslide-detector-backend.vercel.app/predict', {
                lat: latlng.lat,
                lng: latlng.lng,
                manualRain: rainToSend // Send the slider value to backend
            });
            setResult(response.data);
        } catch (error) {
            alert("Server Error. Make sure Node.js is running!");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="relative h-screen w-screen bg-slate-900 font-sans text-slate-800">
            
            {/* --- SIDE PANEL --- */}
            <div className="absolute top-4 left-4 z-[1000] w-80 md:w-96 flex flex-col gap-4">
                
                {/* Title */}
                <div className="bg-white/95 backdrop-blur-md p-5 rounded-2xl shadow-xl border-l-8 border-cyan-500">
                    <h1 className="text-2xl font-extrabold text-slate-800">LAP <span className="text-cyan-500">SUS</span></h1>
                    <p className="text-xs text-slate-500 mt-1">Real-time Landslide Analysiser</p>
                </div>

                {/* --- NEW: RAIN SIMULATION CONTROLS --- */}
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
                            <p className="text-[10px] text-slate-400 mt-1 text-center">Drag slider to test extreme weather scenarios</p>
                        </div>
                    ) : (
                        <p className="text-xs text-slate-400 italic">Using Live Open-Meteo Weather Data</p>
                    )}
                </div>

                {/* Loading */}
                {loading && (
                    <div className="bg-cyan-600 text-white p-4 rounded-xl shadow-lg animate-pulse flex items-center gap-3">
                        <div className="w-5 h-5 border-4 border-white border-t-transparent rounded-full animate-spin"></div>
                        <span className="font-bold text-sm">Running Physics Engine...</span>
                    </div>
                )}

                {/* RESULTS */}
                {result && (
                    <div className="bg-white/95 backdrop-blur-md rounded-2xl shadow-2xl overflow-hidden transition-all duration-500">
                        
                        {/* Risk Header */}
                        <div className={`p-5 text-white flex justify-between items-center ${
                            result.prediction.level === 'High' ? 'bg-red-600' :
                            result.prediction.level === 'Medium' ? 'bg-orange-500' : 'bg-green-600'
                        }`}>
                            <div>
                                <p className="text-xs uppercase font-bold opacity-80">Risk Level</p>
                                <h2 className="text-3xl font-bold">{result.prediction.level}</h2>
                            </div>
                            <div className="text-right">
                                <p className="text-xs opacity-80">Safety Factor</p>
                                <p className="text-2xl font-mono">{result.prediction.details.FoS.toFixed(2)}</p>
                            </div>
                        </div>

                        {/* Details Grid */}
                        <div className="p-5 space-y-4 max-h-[50vh] overflow-y-auto">
                            
                            {/* AI Reason Box */}
                            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                                <p className="text-[10px] text-slate-400 uppercase font-bold mb-1">Reasoning</p>
                                <p className="text-sm font-medium text-slate-700 leading-snug">{result.prediction.reason}</p>
                            </div>

                            {/* Section 1: Weather (Live or Simulated) */}
                            <div>
                                <h3 className="text-xs font-bold text-slate-400 uppercase mb-2">
                                    {result.isSimulated ? "Simulated Weather" : "Live Weather Conditions"}
                                </h3>
                                <div className="grid grid-cols-3 gap-2">
                                    <StatBox label="Temp" value={`${result.data.temp}°C`} />
                                    <StatBox label="Humidity" value={`${result.data.humidity}%`} />
                                    {/* Highlight Rain Box if Simulated */}
                                    <div className={`p-2 rounded border ${result.isSimulated ? 'bg-cyan-50 border-cyan-200' : 'bg-slate-50 border-slate-200'}`}>
                                        <p className={`text-[10px] uppercase tracking-wide ${result.isSimulated ? 'text-cyan-600' : 'text-slate-400'}`}>Rainfall</p>
                                        <p className={`text-lg font-bold ${result.isSimulated ? 'text-cyan-700' : 'text-slate-700'}`}>{result.data.precip_real} mm</p>
                                    </div>
                                </div>
                            </div>

                            {/* Section 2: Terrain Data */}
                            <div>
                                <h3 className="text-xs font-bold text-slate-400 uppercase mb-2">Terrain Analysis</h3>
                                <div className="grid grid-cols-2 gap-2">
                                    <StatBox label="Slope Angle" value={`${result.data.slope}°`} />
                                    <StatBox label="Elevation" value={`${Math.round(result.data.elevation)}m`} />
                                </div>
                            </div>

                            {/* Section 3: Soil Physics */}
                            <div>
                                <h3 className="text-xs font-bold text-slate-400 uppercase mb-2">Geotech Physics</h3>
                                <div className="grid grid-cols-2 gap-2">
                                    <StatBox label="Cohesion (c)" value={`${result.prediction.details.cohesion} kPa`} />
                                    <StatBox label="Friction (φ)" value={`${result.prediction.details.friction}°`} />
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* MAP */}
            <MapContainer center={[10.8505, 76.2711]} zoom={8} scrollWheelZoom={true} className="h-full w-full z-0">
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                <MapClickHandler setMarker={setMarker} predictRisk={predictRisk} />
                {marker && <Marker position={marker} />}
            </MapContainer>
        </div>
    );
}

function StatBox({ label, value }) {
    return (
        <div className="bg-slate-50 p-2 rounded border border-slate-200">
            <p className="text-[10px] text-slate-400 uppercase tracking-wide">{label}</p>
            <p className="text-lg font-bold text-slate-700">{value}</p>
        </div>
    );
}

export default App;