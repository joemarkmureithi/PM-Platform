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

function toIdeaSummary(task) {
  const dueMs = Number(task.due_date);
  const createdMs = Number(task.date_created);
  return {
    id: task.id,
    name: task.name,
    description: task.description || task.text_content || "",
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
      return {
        statusCode: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          source: "mock",
          idea: {
            id: `mock-${Date.now()}`,
            name: payload.title || "(untitled idea)",
            description: buildDescription(payload),
            dueDate: payload.targetDate || null,
            createdAt: new Date().toISOString(),
            url: "#",
          },
          note: "CLICKUP_INTAKE_LIST_ID isn't configured yet, so this was previewed only -- nothing was saved to ClickUp.",
        }),
      };
    }
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ source: "mock", ideas: mockIdeas }) };
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
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: err.message, source: "clickup-error" }) };
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
    return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: err.message, source: "clickup-error" }) };
  }
};

// Also exposed as `handle` (not just `handler`) so api/*.js on Vercel can
// import and call the exact same logic through a thin req/res adapter --
// see api/_adapt.js. Netlify still finds this via `exports.handler` as
// before; this is an additional reference to the same function, not a
// behavior change.
exports.handle = exports.handler;
