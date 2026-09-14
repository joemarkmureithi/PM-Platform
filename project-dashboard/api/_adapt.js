// Shared Netlify -> Vercel adapter.
//
// Every function under netlify/functions/*.js is written for Netlify's
// AWS-Lambda-style contract: `exports.handler = async (event) => ({
// statusCode, headers, body })`, reading `event.httpMethod` /
// `event.queryStringParameters` / `event.headers` / `event.body`. Vercel's
// Node.js serverless runtime instead calls `(req, res)` and expects the
// handler to write the response onto `res` itself.
//
// Rather than forking the actual endpoint logic into two copies that could
// drift apart, each file under api/*.js is a thin wrapper that imports the
// SAME `handle` function a Netlify function exports (see the `exports.handle
// = exports.handler` line added to the bottom of each netlify/functions/*.js
// file) and adapts one calling convention to the other. Both platforms end
// up running the exact same code path.
function bodyToString(req) {
  if (req.body === undefined || req.body === null || req.body === "") return "";
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  // Vercel's Node runtime parses a JSON request body into an object before
  // the handler runs; re-stringify it so the wrapped handler's own
  // `JSON.parse(event.body || "{}")` still works unchanged.
  return JSON.stringify(req.body);
}

function getQuery(req) {
  if (req.query && typeof req.query === "object") return req.query;
  const qIndex = (req.url || "").indexOf("?");
  const out = {};
  if (qIndex === -1) return out;
  new URLSearchParams(req.url.slice(qIndex + 1)).forEach((value, key) => { out[key] = value; });
  return out;
}

function toNetlifyEvent(req) {
  return {
    httpMethod: req.method,
    path: req.url || "/",
    headers: req.headers || {},
    queryStringParameters: getQuery(req),
    body: bodyToString(req),
  };
}

// Wraps a Netlify-style `handle(event)` function into a Vercel `(req, res)`
// handler.
function adapt(handle) {
  return async (req, res) => {
    try {
      const event = toNetlifyEvent(req);
      const result = await handle(event);
      res.status(result.statusCode || 200);
      Object.entries(result.headers || {}).forEach(([key, value]) => res.setHeader(key, value));
      if (result.isBase64Encoded) {
        res.send(Buffer.from(result.body || "", "base64"));
      } else {
        res.send(result.body ?? "");
      }
    } catch (err) {
      res.status(500).json({ error: err.message || "Internal error" });
    }
  };
}

module.exports = { adapt };
