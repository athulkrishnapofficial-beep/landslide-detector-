// API Configuration
const API_URL = import.meta.env.VITE_API_URL || 'https://landslide-detector-backend.vercel.app';

export const apiConfig = {
    baseURL: API_URL,
    endpoints: {
        predict: `${API_URL}/predict`,
        health: `${API_URL}/health`
    }
};

export default apiConfig;
