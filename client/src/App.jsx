import React, { useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from 'react-leaflet';
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

    const predictRisk = async (latlng) => {
        setLoading(true);
        setResult(null);
        try {
            const response = await axios.post('https://landslide-detector-backend.vercel.app/predict', {
                lat: latlng.lat,
                lng: latlng.lng
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

                {/* Loading */}
                {loading && (
                    <div className="bg-cyan-600 text-white p-4 rounded-xl shadow-lg animate-pulse flex items-center gap-3">
                        <div className="w-5 h-5 border-4 border-white border-t-transparent rounded-full animate-spin"></div>
                        <span className="font-bold text-sm">Calculating Factor of Safety...</span>
                    </div>
                )}

                {/* RESULTS */}
                {result && !loading && (
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
<div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
    
    {/* AI Reason Box */}
    <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
        <p className="text-[10px] text-slate-400 uppercase font-bold mb-1">AI Reasoning</p>
        <p className="text-sm font-medium text-slate-700 leading-snug">{result.prediction.reason}</p>
    </div>

    {/* Section 1: Live Weather */}
    <div>
        <h3 className="text-xs font-bold text-slate-400 uppercase mb-2">Live Weather Conditions</h3>
        <div className="grid grid-cols-3 gap-2">
            <StatBox label="Temp" value={`${result.data.temp}°C`} />
            <StatBox label="Humidity" value={`${result.data.humidity}%`} />
            <StatBox label="Rainfall" value={`${result.data.precip_real} mm`} />
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
    
    {/* Footer Stats */}
    <div className="pt-2 border-t border-slate-100 flex justify-between text-[10px] text-slate-400 font-mono">
        <span>FoS: {result.prediction.details.FoS.toFixed(2)}</span>
        <span>Shear Strength: {result.prediction.details.shear_strength.toFixed(1)}</span>
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