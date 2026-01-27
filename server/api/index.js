// Vercel Serverless Function Handler
// This ensures the app works correctly on Vercel's serverless platform

const app = require('./index');

// Export the Express app as the default export for Vercel
module.exports = app;
