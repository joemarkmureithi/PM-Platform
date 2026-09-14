const { client } = require("./lib/clickupClient");
const mockRegisters = require("./lib/mockRegisters");

// GET  /api/registers?type=risk|issue|lesson  -> list submissions, newest first.
// POST /api/registers?type=risk|issue|lesson  -> create a new submission.
//
// Three simple logbook-style registers on the "Risks & Issues" tab: a Risk
// Register, an Issues Register, and a Lessons Learnt Register. Each type is
// its OWN dedicated ClickUp list (mirrors ideas.js's "New Idea" intake
// pattern exactly) so logging a risk/issue/lesson never touches the Active
// portfolio list, and each register stays separate from the others.
//
// As with ideas.js, we don't try to map fields onto ClickUp custom fields on
// these lists (field IDs vary per list and can't be verified without live
// API access) -- every submitted value is folded into the task description
// as labeled plain text instead, so nothing submitted is ever silently
// dropped.

const REGISTER_TYPES = {
  risk: {
    envVar: "CLICKUP_RISK_LIST_ID",
    label: "Risk Register",
    requiredFields: ["title", "description", "likelihood", "impact"],
    descriptionFields: [
      { key: "project", label: "Project / Product" },
      { key: "likelihood", label: "Likelihood" },
      { key: "impact", label: "Impact" },
      { key: "mitigation", label: "Mitigation plan" },
      { key: "owner", label: "Owner" },
    ],
  },
  issue: {
    envVar: "CLICKUP_ISSUE_LIST_ID",
    label: "Issues Register",
    requiredFields: ["title", "description", "severity"],
    descriptionFields: [
      { key: "project", label: "Project / Product" },
      { key: "severity", label: "Severity" },
      { key: "owner", label: "Owner" },
    ],
  },
  lesson: {
    envVar: "CLICKUP_LESSON_LIST_ID",
    label: "Lessons Learnt Register",
    requiredFields: ["title", "description", "category"],
    descriptionFields: [
      { key: "project", label: "Project / Product" },
      { key: "category", label: "Category" },
      { key: "owner", label: "Owner" },
    ],
  },
};

function toEntrySummary(task) {
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

function buildDescription(config, payload) {
  const lines = [];
  config.descriptionFields.forEach(({ key, label }) => {
    if (payload[key]) lines.push(`${label}: ${payload[key]}`);
  });
  lines.push("", payload.description || "", "", `— submitted via PM Intelligence ${config.label}`);
  return lines.join("\n");
}

function parseBody(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch (err) {
    return null;
  }
}

function missingFields(config, payload) {
  return config.requiredFields.filter((key) => !String(payload[key] || "").trim());
}

// Real Netlify hands query params as event.queryStringParameters; the local
// preview server (see scripts/preview-server.js) instead passes the raw
// req.url (with query string) as event.path -- support both so this works
// identically in both environments.
function getType(event) {
  if (event.queryStringParameters && event.queryStringParameters.type) {
    return event.queryStringParameters.type;
  }
  const path = event.path || "";
  const qIndex = path.indexOf("?");
  if (qIndex >= 0) {
    return new URLSearchParams(path.slice(qIndex + 1)).get("type");
  }
  return null;
}

exports.handler = async (event) => {
  const jsonHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const type = getType(event);
  const config = REGISTER_TYPES[type];

  if (!config) {
    return {
      statusCode: 400,
      headers: jsonHeaders,
      body: JSON.stringify({ error: `Unknown or missing register type "${type}" -- expected one of: ${Object.keys(REGISTER_TYPES).join(", ")}` }),
    };
  }

  const token = process.env.CLICKUP_API_TOKEN;
  const listId = process.env[config.envVar];
  const method = event.httpMethod || "GET";

  // --- Not configured yet: mock read, mock (unsaved) preview of a write ---
  if (!token || !listId) {
    if (method === "POST") {
      const payload = parseBody(event);
      if (!payload) {
        return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid JSON body" }) };
      }
      const missing = missingFields(config, payload);
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
          entry: {
            id: `mock-${Date.now()}`,
            name: payload.title || "(untitled)",
            description: buildDescription(config, payload),
            dueDate: payload.targetDate || null,
            createdAt: new Date().toISOString(),
            url: "#",
          },
          note: `${config.envVar} isn't configured yet, so this was previewed only -- nothing was saved to ClickUp.`,
        }),
      };
    }
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ source: "mock", entries: mockRegisters[type] || [] }) };
  }

  const cu = client(token);

  // --- POST: create a new task in this register's dedicated ClickUp list ---
  if (method === "POST") {
    const payload = parseBody(event);
    if (!payload) {
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid JSON body" }) };
    }
    const missing = missingFields(config, payload);
    if (missing.length) {
      return {
        statusCode: 400,
        headers: jsonHeaders,
        body: JSON.stringify({ error: `Missing required field(s): ${missing.join(", ")}` }),
      };
    }

    const taskPayload = {
      name: payload.title.trim(),
      description: buildDescription(config, payload),
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
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ source: "clickup", entry: toEntrySummary(created) }) };
    } catch (err) {
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: err.message, source: "clickup-error" }) };
    }
  }

  // --- GET: list existing entries, newest first ---
  try {
    const tasks = await cu.getListTasks(listId);
    const entries = tasks
      .map(toEntrySummary)
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ source: "clickup", entries }) };
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
