const { client } = require("./lib/clickupClient");
const fieldMapping = require("../../config/fieldMapping.json");

// POST /api/project-create -> add a brand new project straight from the
// Tooling or Lab tab, instead of only ever being able to work with whatever
// projects ClickUp already has. Creates one task on the same Active list
// every other tab reads (CLICKUP_LIST_ID) -- so once created, the project
// shows up everywhere else in the dashboard too, not just Tooling/Lab.
//
// Every field the request form asks for (the same shape as a Deep Dive's
// Scope/Timeline/Cost & Resource/Impact/Priority tabs, condensed into one
// form) is folded into the task's description as labeled text first, same
// as registers.js/ideas.js -- that's the guaranteed part, nothing typed in
// is ever lost. Product Category / Stage Gate / Tooling are ALSO
// best-effort written as real custom fields (see writeCustomFields below)
// so the new project is correctly filtered into Tooling/Lab/By Category
// right away rather than needing someone to go set those by hand in
// ClickUp afterward -- but if a field can't be found on the live list (an
// unexpected workspace field name, or the list flat out isn't reachable),
// creation still succeeds on the description alone rather than failing the
// whole submission over a field write.

const REQUIRED_FIELDS = ["name"];

function buildDescription(payload) {
  const lines = [
    `Product Category: ${payload.productCategory || "(not specified)"}`,
    `Owner(s): ${payload.owners || "(not specified)"}`,
    `Stage Gate: ${payload.currentGate || "(not specified)"}`,
    `Tooling needed: ${payload.tooling ? "Yes" : "No"}`,
    "",
    "Scope",
    payload.scope || "(none provided)",
    "",
    "Timeline",
    payload.timeline || "(none provided)",
    "",
    "Cost & Resource",
    payload.costResource || "(none provided)",
    "",
    "Impact",
    payload.impact || "(none provided)",
    "",
    "Priority",
    payload.priority || "(none provided)",
    "",
    "— submitted via PM Intelligence Add Project (Tooling/Lab)",
  ];
  return lines.join("\n");
}

function parseBody(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    return null;
  }
}

function missingFields(payload) {
  return REQUIRED_FIELDS.filter((key) => !String(payload[key] || "").trim());
}

// Best-effort: looks up each target custom field's live id (and, for a
// dropdown, its option id by name) via getListFields, then writes it with
// setCustomFieldValue. Any field that isn't found, or any write that fails,
// is silently skipped -- the task itself is already created and its
// description already has everything, so a partial field-write failure
// here should never look like the whole submission failed.
async function writeCustomFields(cu, listId, taskId, payload) {
  const written = [];
  let fields;
  try {
    fields = await cu.getListFields(listId);
  } catch {
    return written;
  }
  const targets = [
    { key: "productCategory", value: payload.productCategory },
    { key: "currentGate", value: payload.currentGate },
    { key: "tooling", value: payload.tooling ? "Yes" : "No" },
    { key: "assigneeTextFallback", value: payload.owners },
  ];
  for (const t of targets) {
    if (!t.value) continue;
    const fieldName = fieldMapping[t.key];
    const field = fields.find((f) => f.name === fieldName);
    if (!field) continue;
    let value = t.value;
    if (field.type === "drop_down" && field.type_config?.options) {
      const opt = field.type_config.options.find(
        (o) => String(o.name).toLowerCase() === String(t.value).toLowerCase()
      );
      // No matching option (e.g. a Stage Gate name this list doesn't
      // actually have configured) -- skip rather than write a nonsense
      // index; the description still records what was asked for.
      if (!opt) continue;
      value = opt.orderindex;
    }
    try {
      await cu.setCustomFieldValue(taskId, field.id, value);
      written.push(t.key);
    } catch {
      // Field exists but the write failed -- move on, the task itself is
      // already safely created.
    }
  }
  return written;
}

exports.handler = async (event) => {
  const jsonHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if ((event.httpMethod || "GET") !== "POST") {
    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const payload = parseBody(event);
  if (!payload) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }
  const missing = missingFields(payload);
  if (missing.length) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: `Missing required field(s): ${missing.join(", ")}` }) };
  }

  const token = process.env.CLICKUP_API_TOKEN;
  const listId = process.env.CLICKUP_LIST_ID;

  if (!token || !listId) {
    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        source: "mock",
        project: {
          id: `mock-${Date.now()}`,
          name: payload.name,
          description: buildDescription(payload),
          url: "#",
          createdAt: new Date().toISOString(),
        },
        note: "CLICKUP_LIST_ID isn't configured yet, so this was previewed only -- nothing was saved to ClickUp.",
      }),
    };
  }

  const cu = client(token);
  try {
    const created = await cu.createTask(listId, { name: payload.name.trim(), description: buildDescription(payload) });
    const fieldsWritten = await writeCustomFields(cu, listId, created.id, payload);
    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        source: "clickup",
        project: { id: created.id, name: created.name, url: created.url, createdAt: new Date().toISOString() },
        fieldsWritten,
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: err.message, source: "clickup-error" }) };
  }
};

exports.handle = exports.handler;
