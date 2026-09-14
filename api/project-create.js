// Vercel entry point for /api/project-create -- a thin adapter over the same
// handler netlify/functions/project-create.js exports for Netlify (see
// api/_adapt.js for why this is a wrapper rather than a second copy of the
// logic).
const { adapt } = require("./_adapt");
const { handle } = require("../netlify/functions/project-create");
module.exports = adapt(handle);
