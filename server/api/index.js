// Vercel Serverless Function Handler
// This file is the entry point for Vercel's serverless functions
// It properly exports the Express app for Vercel to handle requests

try {
    const app = require('../index');
    module.exports = app;
} catch (error) {
    console.error('❌ Failed to load app:', error);
    
    // Fallback: return a minimal Express app if main app fails
    const express = require('express');
    const cors = require('cors');
    const fallbackApp = express();
    
    fallbackApp.use(cors());
    fallbackApp.get('/health', (req, res) => {
        res.json({ 
            status: 'fallback', 
            message: 'App initialization failed, using fallback',
            error: error.message
        });
    });
    fallbackApp.post('/predict', (req, res) => {
        res.status(503).json({ 
            error: 'Service temporarily unavailable',
            message: error.message
        });
    });
    
    module.exports = fallbackApp;
}
