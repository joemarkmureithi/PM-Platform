const { client } = require("./lib/clickupClient");
const fieldMapping = require("../../config/fieldMapping.json");

// POST /api/gap-update  { taskId, field, value }
// Writes a single field back to ClickUp from the Decisions & Gaps tab, so a
// PM can close a flagged gap without leaving the dashboard. Deliberately one
// field per call (not a generic "update this task" endpoint) -- keeps the
// write surface small and each gap chip maps to exactly one call.
//
// "field" is one of: dueDate, assignee, productCategory, gatePhase,
// riskStatus, mitigationStrategy. dueDate is a native ClickUp task field;
// productCategory/gatePhase/riskStatus/mitigationStrategy are custom fields
// resolved through config/fieldMapping.json. "assignee" writes to whatever
// config/fieldMapping.json's "assignee" key resolves to -- on this list
// that's a Labels-type custom field ("Assigned To (Multi)"), confirmed live
// 2026-09-11; it falls back to ClickUp's native assignee field if that
// mapped field isn't found or isn't a Labels field.
//
// NOTE: this has only been exercised against mock data in development --
// this sandbox's network egress blocks api.clickup.com, so the live-write
// path (the actual PUT/POST calls to ClickUp below) could not be tested
// against a real account here. Test on one project first before relying on
// it across the whole portfolio.

const CUSTOM_FIELD_KEYS = {
  productCategory: "productCategory",
  gatePhase: "gatePhase",
  riskStatus: "riskStatus",
  mitigationStrategy: "mitigationStrategy",
};

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if ((event.httpMethod || "POST") !== "POST") {
    return jsonResponse(405, { error: "Use POST" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const { taskId, field, value } = payload;
  if (!taskId || !field || value === undefined || value === null || value === "") {
    return jsonResponse(400, { error: "taskId, field, and a non-empty value are all required" });
  }

  const token = process.env.CLICKUP_API_TOKEN;
  const listId = process.env.CLICKUP_LIST_ID;

  if (!token || !listId) {
    return jsonResponse(200, {
      ok: true,
      preview: true,
      message: "Preview mode — ClickUp isn't connected, so this wasn't actually saved. Add CLICKUP_API_TOKEN / CLICKUP_LIST_ID to .env to save for real.",
    });
  }

  try {
    const cu = client(token);

    if (field === "dueDate") {
      const ms = Date.parse(`${value}T00:00:00Z`);
      if (!Number.isFinite(ms)) throw new Error(`"${value}" isn't a valid date`);
      await cu.updateTask(taskId, { due_date: ms, due_date_time: false });
      return jsonResponse(200, { ok: true });
    }

    if (field === "assignee") {
      const assigneeFieldName = fieldMapping.assignee;
      let assigneeFieldDef = null;
      if (assigneeFieldName) {
        const fields = await cu.getListFields(listId);
        assigneeFieldDef = fields.find((f) => f.name === assigneeFieldName) || null;
      }

      if (assigneeFieldDef && assigneeFieldDef.type === "labels") {
        // Confirmed live (2026-09-11, via a real /api/portfolio debug
        // response): "Assigned To (Multi)" is a ClickUp Labels field, not a
        // People field -- its values are ids into the field's own
        // type_config.options, and per ClickUp's documented convention for
        // writing a Labels field, the value is the full array of selected
        // option ids (a replace, not an add/rem diff like native
        // assignees). `value` here is the option's display name (matching
        // the productCategory/gatePhase pattern) -- resolve it back to that
        // option's id. Replacing outright is safe: the "No owner assigned"
        // gap that renders this editor only fires when nobody is tagged in
        // this field anywhere yet, so there's nothing existing to clobber.
        // Still unverified against live ClickUp (see file header) -- test
        // on one project first.
        const option = (assigneeFieldDef.type_config?.options || []).find(
          (o) => String(o.label ?? o.name).toLowerCase() === String(value).toLowerCase()
        );
        if (!option) {
          throw new Error(`"${value}" isn't one of "${assigneeFieldName}"'s options in ClickUp`);
        }
        await cu.setCustomFieldValue(taskId, assigneeFieldDef.id, [option.id]);
        return jsonResponse(200, { ok: true });
      }

      // Fallback when "assignee" isn't mapped to a Labels field (or isn't
      // mapped at all) -- ClickUp's native assignee field, using the picked
      // value as a workspace-member id (see /api/portfolio's `members` list).
      const userId = Number(value);
      if (!Number.isFinite(userId)) throw new Error(`"${value}" isn't a valid user id`);
      await cu.updateTask(taskId, { assignees: { add: [userId], rem: [] } });
      return jsonResponse(200, { ok: true });
    }

    const mappingKey = CUSTOM_FIELD_KEYS[field];
    const fieldName = mappingKey ? fieldMapping[mappingKey] : null;
    if (!fieldName) {
      return jsonResponse(400, { error: `Unknown field "${field}"` });
    }

    const fields = await cu.getListFields(listId);
    const fieldDef = fields.find((f) => f.name === fieldName);
    if (!fieldDef) {
      throw new Error(`Your ClickUp list has no custom field named "${fieldName}" — check config/fieldMapping.json`);
    }

    let writeValue = value;
    if (fieldDef.type === "drop_down") {
      // Confirmed against live data (2026-08-21): drop_down fields read back
      // (and, per ClickUp's docs, are written) using the option's
      // orderindex, not its id -- see getCustomField() in transform.js.
      const option = (fieldDef.type_config?.options || []).find(
        (o) => String(o.name).toLowerCase() === String(value).toLowerCase()
      );
      if (!option) {
        throw new Error(`"${value}" isn't one of "${fieldName}"'s options in ClickUp`);
      }
      writeValue = option.orderindex;
    }

    await cu.setCustomFieldValue(taskId, fieldDef.id, writeValue);
    return jsonResponse(200, { ok: true });
  } catch (err) {
    return jsonResponse(502, { error: err.message });
  }
};
