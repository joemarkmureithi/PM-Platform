// Vercel entry point for /api/standup-pptx -- a thin adapter over the same
// handler netlify/functions/standup-pptx.js exports for Netlify (see api/_adapt.js
// for why this is a wrapper rather than a second copy of the logic).
const { adapt } = require("./_adapt");
const { handle } = require("../netlify/functions/standup-pptx");
module.exports = adapt(handle);
