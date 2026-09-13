// Vercel entry point for /api/portfolio -- a thin adapter over the same
// handler netlify/functions/portfolio.js exports for Netlify (see api/_adapt.js
// for why this is a wrapper rather than a second copy of the logic).
const { adapt } = require("./_adapt");
const { handle } = require("../netlify/functions/portfolio");
module.exports = adapt(handle);
