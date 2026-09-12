#!/usr/bin/env node
// Zero-dependency local preview: serves public/ and proxies /api/portfolio to
// the real function handler, using only Node's built-in http module. No
// Netlify CLI, no login, no extra installs beyond Node itself.
//
// Usage:
//   node scripts/preview-server.js
// Then open the URL it prints (don't double-click public/index.html directly
// -- opening it as a file:// page skips this server entirely and the
// dashboard's data fetch has nothing to talk to).
//
// Reads the same .env file the real Netlify deployment will use, so if
// CLICKUP_API_TOKEN and CLICKUP_LIST_ID are set there, this hits your real
// ClickUp data -- otherwise it falls back to mock data automatically.

const http = require("http");
const fs = require("fs");
const path = require("path");

// Minimal .env loader (no dependency needed for just KEY=VALUE lines).
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8")
    .split("\n")
    .forEach((line) => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2] ? match[2].replace(/^["']|["']$/g, "") : "";
      }
    });
}

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const FUNCTIONS_DIR = path.join(__dirname, "..", "netlify", "functions");
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript" };
const PORT = process.env.PREVIEW_PORT || 8877;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

// Generic /api/<name> -> netlify/functions/<name>.js proxy, mirroring the
// `/api/*` -> `/.netlify/functions/:splat` redirect in netlify.toml. Any new
// function file just works here with no changes to this server.
async function handleApi(req, res) {
  const fnName = req.url.slice("/api/".length).split("?")[0];
  const fnPath = path.join(FUNCTIONS_DIR, `${fnName}.js`);
  if (!fs.existsSync(fnPath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `No function for ${req.url}` }));
    return;
  }
  const body = await readBody(req);
  try {
    const { handler } = require(fnPath);
    const result = await handler({ httpMethod: req.method, body, headers: req.headers, path: req.url });
    res.writeHead(result.statusCode, result.headers || {});
    // Mirrors real Netlify Functions' contract: a function that returns
    // binary data (e.g. standup-pptx.js's generated .pptx) sets
    // isBase64Encoded and hands back its body as a base64 string, which
    // Netlify decodes before it reaches the browser. This preview server
    // has to do that decoding itself, or a base64-text body gets written
    // straight through as if it were the raw bytes -- which corrupts any
    // binary response (a valid .pptx becomes an unopenable file).
    res.end(result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

http
  .createServer(async (req, res) => {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    const filePath = path.join(PUBLIC_DIR, req.url === "/" ? "index.html" : req.url);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "text/plain" });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`\nPreview running at http://localhost:${PORT}`);
    console.log(
      process.env.CLICKUP_API_TOKEN && process.env.CLICKUP_LIST_ID
        ? "Using live ClickUp data (token + list ID found in .env).\n"
        : "Using mock data (.env missing CLICKUP_API_TOKEN / CLICKUP_LIST_ID).\n"
    );
  });
