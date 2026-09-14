const { client } = require("./lib/clickupClient");
const mockIdeas = require("./lib/mockIdeas");

// GET  /api/ideas  -> list submissions from the intake list, newest first.
// POST /api/ideas  -> create a new submission (title, product, productCategory,
//                     description, optional targetDate).
//
// Intake submissions live in their OWN ClickUp list (CLICKUP_INTAKE_LIST_ID),
// separate from the Active portfolio list -- so dumping a raw idea in never
// skews the Active project counts/gate charts. A PM can promote a promising
// idea into Active manually once it's vetted.
//
// We deliberately do not try to map product/category onto ClickUp custom
// fields on the intake list, since those field IDs vary per list and can't
// be verified without live API access. Instead every submitted value is
// folded into the task description as labeled plain text, so nothing
// submitted is ever silently dropped -- the ClickUp task is still fully
// readable and searchable, just not backed by dropdown fields on this list.

// Pulls the product/category/free-text-description fields back out of the
// labeled-plain-text block buildDescription() wrote them into, so the "edit
// my past submissions" view (see index.html/dashboard.js) can populate its
// form fields individually instead of just showing one big text blob.
// Best-effort: if the description doesn't match the expected shape (an
// older submission, or one edited by hand in ClickUp), everything falls
// back into the free-text field and product/category come back blank --
// still editable, just starting from less pre-filled context.
function parseIdeaDescription(raw) {
  const text = raw || "";
  const productMatch = text.match(/^Product \/ Model:\s*(.*)$/m);
  const categoryMatch = text.match(/^Product Category:\s*(.*)$/m);
  const product = productMatch ? productMatch[1].trim() : "";
  const productCategory = categoryMatch ? categoryMatch[1].trim() : "";
  const marker = "— submitted via PM Intelligence intake form";
  let body = text;
  if (productMatch || categoryMatch) {
    const lines = text.split("\n");
    const startIdx = lines.findIndex((l) => /^Target date requested:/.test(l)) + 1 || lines.findIndex((l) => /^Product Category:/.test(l)) + 1;
    body = lines.slice(startIdx).join("\n").trim();
  }
  body = body.replace(marker, "").trim();
  return {
    product: product === "(not specified)" ? "" : product,
    productCategory: productCategory === "(not specified)" ? "" : productCategory,
    description: body,
  };
}

function toIdeaSummary(task) {
  const dueMs = Number(task.due_date);
  const createdMs = Number(task.date_created);
  const rawDescription = task.description || task.text_content || "";
  const parsed = parseIdeaDescription(rawDescription);
  return {
    id: task.id,
    name: task.name,
    description: rawDescription,
    product: parsed.product,
    productCategory: parsed.productCategory,
    descriptionText: parsed.description,
    dueDate: Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : null,
    createdAt: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : null,
    url: task.url,
  };
}

function buildDescription(payload) {
  const lines = [
    `Product / Model: ${payload.product || "(not specified)"}`,
    `Product Category: ${payload.productCategory || "(not specified)"}`,
  ];
  if (payload.targetDate) lines.push(`Target date requested: ${payload.targetDate}`);
  lines.push("", payload.description || "", "", "— submitted via PM Intelligence intake form");
  return lines.join("\n");
}

function parseBody(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch (err) {
    return null;
  }
}

// ClickUp's own error text is usually specific enough to act on (a missing
// field, a bad date), so it's passed straight through by default. The one
// case worth rewriting is a 401 "Team not authorized" (OAUTH_027) response --
// that always means the token can't see whatever list CLICKUP_INTAKE_LIST_ID
// points to (most commonly: the env var is still the placeholder value from
// .env.example, or it names a list in a different ClickUp workspace than the
// token belongs to), not a bug in what was submitted. Surfacing that
// distinction in the message itself saves a trip through the Netlify/Vercel
// function logs to figure out what's actually wrong.
function friendlyClickupError(err) {
  const msg = err.message || String(err);
  if (/team not authorized/i.test(msg) || /OAUTH_027/i.test(msg) || /ClickUp API 401/.test(msg)) {
    return "ClickUp rejected this request with \"Team not authorized\" (401). This means the CLICKUP_API_TOKEN configured for this deployment does not have access to the list CLICKUP_INTAKE_LIST_ID points to -- double-check that env var is set to your real Idea Dumps intake list's ID (not the 123456789 placeholder from .env.example) and that it belongs to the same ClickUp workspace as the token.";
  }
  return msg;
}

// Shared between the live-ClickUp path and the mock preview path, so the
// mock path exercises the exact same validation the real one enforces
// instead of silently accepting incomplete submissions.
function missingFields(payload) {
  return ["title", "product", "productCategory", "description"].filter(
    (key) => !String(payload[key] || "").trim()
  );
}

exports.handler = async (event) => {
  const token = process.env.CLICKUP_API_TOKEN;
  const listId = process.env.CLICKUP_INTAKE_LIST_ID;
  const method = event.httpMethod || "GET";
  const jsonHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store" };

  // --- Not configured yet: mock read, mock (unsaved) preview of a write ---
  if (!token || !listId) {
    if (method === "POST" || method === "PUT") {
      const payload = parseBody(event);
      if (!payload) {
        return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid JSON body" }) };
      }
      const missing = missingFields(payload);
      if (missing.length) {
        return {
          statusCode: 400,
          headers: jsonHeaders,
          body: JSON.stringify({ error: `Missing required field(s): ${missing.join(", ")}` }),
        };
      }
      return {
        statusCode: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          source: "mock",
          idea: {
            id: payload.id || `mock-${Date.now()}`,
            name: payload.title || "(untitled idea)",
            description: buildDescription(payload),
            product: payload.product || "",
            productCategory: payload.productCategory || "",
            descriptionText: payload.description || "",
            dueDate: payload.targetDate || null,
            createdAt: new Date().toISOString(),
            url: "#",
          },
          note: "CLICKUP_INTAKE_LIST_ID isn't configured yet, so this was previewed only -- nothing was saved to ClickUp.",
        }),
      };
    }
    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        source: "mock",
        ideas: mockIdeas.map((idea) => {
          const parsed = parseIdeaDescription(idea.description);
          return { ...idea, product: parsed.product, productCategory: parsed.productCategory, descriptionText: parsed.description };
        }),
      }),
    };
  }

  const cu = client(token);

  // --- POST: create a new intake task in ClickUp ---
  if (method === "POST") {
    const payload = parseBody(event);
    if (!payload) {
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid JSON body" }) };
    }

    const missing = missingFields(payload);
    if (missing.length) {
      return {
        statusCode: 400,
        headers: jsonHeaders,
        body: JSON.stringify({ error: `Missing required field(s): ${missing.join(", ")}` }),
      };
    }

    const taskPayload = {
      name: payload.title.trim(),
      description: buildDescription(payload),
    };
    if (payload.targetDate) {
      const ms = Date.parse(payload.targetDate);
      if (!Number.isNaN(ms)) {
        taskPayload.due_date = ms;
        taskPayload.due_date_time = false;
      }
    }

    try {
      const created = await cu.createTask(listId, taskPayload);
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ source: "clickup", idea: toIdeaSummary(created) }) };
    } catch (err) {
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: friendlyClickupError(err), source: "clickup-error" }) };
    }
  }

  // --- PUT: edit a previously-submitted idea (title/product/category/
  // description/targetDate) -- same field-folding-into-description shape as
  // POST, just re-sent as a full update rather than a new task. `id` is the
  // ClickUp task id returned by the original POST/GET.
  if (method === "PUT") {
    const payload = parseBody(event);
    if (!payload || !payload.id) {
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Missing id of the idea to edit" }) };
    }
    const missing = missingFields(payload);
    if (missing.length) {
      return {
        statusCode: 400,
        headers: jsonHeaders,
        body: JSON.stringify({ error: `Missing required field(s): ${missing.join(", ")}` }),
      };
    }
    const taskPayload = {
      name: payload.title.trim(),
      description: buildDescription(payload),
    };
    if (payload.targetDate) {
      const ms = Date.parse(payload.targetDate);
      if (!Number.isNaN(ms)) {
        taskPayload.due_date = ms;
        taskPayload.due_date_time = false;
      }
    }
    try {
      const updated = await cu.updateTask(payload.id, taskPayload);
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ source: "clickup", idea: toIdeaSummary(updated) }) };
    } catch (err) {
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: friendlyClickupError(err), source: "clickup-error" }) };
    }
  }

  // --- GET: list existing submissions, newest first ---
  try {
    const tasks = await cu.getListTasks(listId);
    const ideas = tasks
      .map(toIdeaSummary)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ source: "clickup", ideas }) };
  } catch (err) {
    return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: friendlyClickupError(err), source: "clickup-error" }) };
  }
};

// Also exposed as `handle` (not just `handler`) so api/*.js on Vercel can
// import and call the exact same logic through a thin req/res adapter --
// see api/_adapt.js. Netlify still finds this via `exports.handler` as
// before; this is an additional reference to the same function, not a
// behavior change.
exports.handle = exports.handler;
