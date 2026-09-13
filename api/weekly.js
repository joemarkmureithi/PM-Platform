// Vercel entry point for /api/weekly -- a thin adapter over the same
// handler netlify/functions/weekly.js exports for Netlify (see api/_adapt.js
// for why this is a wrapper rather than a second copy of the logic).
const { adapt } = require("./_adapt");
const { handle } = require("../netlify/functions/weekly");
module.exports = adapt(handle);
