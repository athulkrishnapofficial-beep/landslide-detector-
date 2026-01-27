# Vercel Deployment Configuration

## Overview
This document outlines all the fixes applied for proper Vercel deployment of the Landslide Detector application.

## Changes Made

### 1. **Backend Server Configuration** (`server/index.js`)

#### CORS Setup
```javascript
const corsOptions = {
    origin: [
        'https://landslide-detector-frontents.vercel.app',
        'http://localhost:3000',
        'http://localhost:5173'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
};

app.use(cors(corsOptions));
```

#### Dynamic PORT Configuration
```javascript
const PORT = process.env.PORT || 5000;
```

#### Additional Middleware
- Added `express.urlencoded({ extended: true })` for form data handling

#### Server Startup
- Removed hardcoded `'0.0.0.0'` binding
- Added health check endpoint at `/health`
- Added root endpoint `/` returning status JSON

### 2. **Backend Vercel Configuration** (`server/vercel.json`)

```json
{
 "$schema": "https://openapi.vercel.sh/vercel.json",
 "version": 2,
 "env": {
    "PORT": "5000"
 },
 "builds": [
   {
     "src": "index.js",
     "use": "@vercel/node"
   }
 ],
 "routes": [
   {
     "src": "/(.*)",
     "dest": "index.js"
   }
 ]
}
```

### 3. **Frontend Environment Variables**

#### Production (`.env.production`)
```
VITE_API_URL=https://landslide-detector-backend.vercel.app
VITE_FRONTEND_URL=https://landslide-detector-frontents.vercel.app
```

#### Development (`.env.development`)
```
VITE_API_URL=http://localhost:5000
VITE_FRONTEND_URL=http://localhost:5173
```

### 4. **API Configuration Module** (`client/src/config.js`)

```javascript
const API_URL = import.meta.env.VITE_API_URL || 'https://landslide-detector-backend.vercel.app';

export const apiConfig = {
    baseURL: API_URL,
    endpoints: {
        predict: `${API_URL}/predict`,
        health: `${API_URL}/health`
    }
};
```

### 5. **Frontend Application Updates** (`client/src/App.jsx`)

#### Import Configuration
```javascript
import { apiConfig } from './config';
```

#### API Call with Error Handling
```javascript
const response = await axios.post(apiConfig.endpoints.predict, {
    lat: latlng.lat,
    lng: latlng.lng,
    manualRain: rainToSend,
    depth: Number(depth) || 2.5
}, {
    headers: {
        'Content-Type': 'application/json'
    },
    timeout: 30000
});
```

#### Enhanced Error Handling
```javascript
catch (error) {
    console.error('Prediction error:', error);
    const errorMsg = error.response?.data?.message || error.message || 'Server Error';
    alert(`Server Error: ${errorMsg}. Backend URL: ${apiConfig.endpoints.predict}`);
}
```

### 6. **Frontend Vercel Configuration** (`client/vercel.json`)

```json
{
    "buildCommand": "npm run build",
    "outputDirectory": "dist",
    "rewrites": [
        {
             "source": "/(.*)", 
        "destination": "/" 
        }
    ]
}
```

### 7. **Vite Configuration** (`client/vite.config.js`)

Added development proxy for local testing:
```javascript
server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
```

## Deployment URLs

- **Frontend**: https://landslide-detector-frontents.vercel.app/
- **Backend**: https://landslide-detector-backend.vercel.app/

## API Endpoints

### Health Check
```bash
GET https://landslide-detector-backend.vercel.app/health
```

### Landslide Prediction
```bash
POST https://landslide-detector-backend.vercel.app/predict
Content-Type: application/json

{
    "lat": 10.5,
    "lng": 76.2,
    "depth": 2.5,
    "manualRain": null
}
```

## Local Development

### Prerequisites
- Node.js v18+
- npm or yarn

### Setup

1. **Backend Setup**
```bash
cd server
npm install
npm start
# Server runs on http://localhost:5000
```

2. **Frontend Setup**
```bash
cd client
npm install
npm run dev
# App runs on http://localhost:5173
```

The frontend will automatically proxy API calls to the local backend.

### Environment Variables
- Automatically loaded from `.env.development` during dev
- Automatically loaded from `.env.production` during build

## Troubleshooting

### CORS Issues
If you see CORS errors:
1. Verify the frontend URL is in the `corsOptions.origin` array in `server/index.js`
2. Check that CORS headers are being sent correctly
3. Ensure the backend is properly deployed on Vercel

### API Endpoint Not Found
1. Check that the backend is deployed and accessible
2. Verify `VITE_API_URL` environment variable is set correctly
3. Check browser console for the actual API URL being used

### Build Failures
1. Ensure all dependencies are installed: `npm install`
2. Check `package.json` scripts
3. Verify `vercel.json` configuration

## Key Files Modified

- `server/index.js` - CORS and PORT configuration
- `server/vercel.json` - Backend deployment config
- `server/package.json` - Dependencies unchanged
- `client/src/App.jsx` - API endpoint usage
- `client/src/config.js` - New configuration module
- `client/.env.production` - Production environment
- `client/.env.development` - Development environment
- `client/vite.config.js` - Development proxy
- `client/vercel.json` - Frontend deployment config

## Notes

- The application uses dynamic environment variables for flexibility
- CORS is properly configured for both development and production
- Error messages now include the API URL being used for debugging
- All HTTP calls include appropriate headers and timeouts
- The backend includes health check endpoints for monitoring
