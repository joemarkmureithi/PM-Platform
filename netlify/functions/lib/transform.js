const fieldMapping = require("../../../config/fieldMapping.json");

// ClickUp returns custom fields as an array on each task:
// task.custom_fields = [{ name, type, value, type_config: { options: [...] } }, ...]
// This resolves a field by its human-readable name (as configured in
// config/fieldMapping.json) and normalizes dropdown/label fields to their
// readable text instead of a raw option index/id.
function getCustomField(task, fieldName) {
  const field = (task.custom_fields || []).find((f) => f.name === fieldName);
  if (!field || field.value === undefined || field.value === null) return null;

  if (field.type === "drop_down" && field.type_config?.options) {
    // ClickUp drop_down values come back as the option's orderindex (a number),
    // not its id -- but we defensively check both in case that ever changes.
    const opt = field.type_config.options.find(
      (o) => o.orderindex === field.value || o.id === field.value
    );
    return opt ? opt.name : field.value;
  }
  if (field.type === "labels" && Array.isArray(field.value) && field.type_config?.options) {
    return field.value
      .map((id) => field.type_config.options.find((o) => o.id === id)?.label || id)
      .join(", ");
  }
  if (field.type === "manual_progress" && field.value && typeof field.value === "object") {
    const pct = field.value.percent_completed;
    if (typeof pct !== "number") return null;
    // Confirmed against live data (2026-08-21): this field reports a 0-1
    // fraction (e.g. 0.9 for 90%), not 0-100. Normalize so the UI shows the
    // right number -- a real "1%" is an acceptable, rare misread here.
    return Math.round(pct > 0 && pct <= 1 ? pct * 100 : pct);
  }
  if (field.type === "date") {
    const ms = Number(field.value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : field.value;
  }
  return field.value;
}

function mapped(task, key) {
  const fieldName = fieldMapping[key];
  return fieldName ? getCustomField(task, fieldName) : null;
}

// Native ClickUp fields (due_date, status) live on the task object directly,
// not in custom_fields.
function nativeDueDate(task) {
  // Confirmed against live data (2026-08-21): tasks with no due date at all
  // return due_date as null/undefined -- Number(null) is 0, which used to
  // slip through as a "valid" epoch date (1970-01-01), masking every
  // missing-date task as if it had a real one. Guard against that first.
  if (!task.due_date) return null;
  const ms = Number(task.due_date);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Same shape as nativeDueDate, for ClickUp's native Start Date field -- most
// lists leave this unset (it's a separate, optional field from Due Date), so
// callers that need a start (the Gantt tab) fall back to nativeCreatedDate
// below rather than treating "no Start Date" as "can't plot this project."
function nativeStartDate(task) {
  if (!task.start_date) return null;
  const ms = Number(task.start_date);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// A task's creation date is always present on every ClickUp task (unlike
// Start Date, which has to be explicitly set) -- used as the Gantt tab's
// fallback "start" for a project nobody has given a real Start Date, so a
// project still gets a bar instead of being silently excluded from the
// chart. Rendered visually distinct (dashed, "assumed") from a real Start
// Date, same convention as the Resources tab's hours chart.
function nativeCreatedDate(task) {
  if (!task.date_created) return null;
  const ms = Number(task.date_created);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Buckets each task into the four portfolio KPI categories. Prefers the
// "Project Health" custom field once it exists on a task (create it as a
// dropdown: Active / Delayed / At Risk / Completed). Until then, falls back
// to a best-effort read of the list's native status plus Risk Status, so the
// dashboard is useful from day one and gets more accurate as PMs adopt the
// dedicated field.
function bucketHealth(task) {
  const explicitHealth = String(mapped(task, "projectHealth") || "").toLowerCase();
  if (/at.?risk/.test(explicitHealth)) return "atRisk";
  if (/delay/.test(explicitHealth)) return "delayed";
  if (/complete|done/.test(explicitHealth)) return "completed";
  if (/active/.test(explicitHealth)) return "active";

  // Fallback heuristic (no "Project Health" field set yet on this task).
  // Confirmed against live data (2026-08-21): this list's only native status
  // LABELS are "to do" / "ongoing" -- "complete" and "on hold" never occur,
  // so checking for those alone left every task defaulting to "active".
  // ClickUp separately tracks a status TYPE ("open" | "custom" | "closed" |
  // "done") independent of the label text -- that's a more reliable signal
  // for "this is actually finished" than guessing at label wording.
  const statusType = String(task.status?.type || "").toLowerCase();
  const status = String(task.status?.status || "").toLowerCase();
  const riskStatus = String(mapped(task, "riskStatus") || "").toLowerCase();

  if (statusType === "closed" || statusType === "done" || status === "complete") return "completed";
  if (status === "on hold") return "delayed";
  if (riskStatus === "open") return "atRisk";

  // No explicit risk/health signal on this list yet -- an overdue target
  // date on a task that isn't done is still a legitimate "delayed" signal
  // on its own, so use it rather than defaulting everything to "active".
  const dueMs = Number(task.due_date);
  if (task.due_date && Number.isFinite(dueMs) && dueMs < Date.now()) return "delayed";

  return "active";
}

// PMI-flavored data-quality checks. Each returns a short reason string when
// the gap exists, or null when the project is clean on that dimension. This
// is deliberately conservative -- it flags genuine planning gaps (no gate,
// no date, no category, an open risk with no mitigation) rather than trying
// to second-guess PM judgment calls.
function computeGaps(p) {
  const gaps = [];
  if (!p.productCategory) gaps.push({ code: "noCategory", label: "No product category" });
  if (!p.currentGate && !p.gatePhase) gaps.push({ code: "noGate", label: "No stage gate set" });
  if (!p.targetGateDate) gaps.push({ code: "noDueDate", label: "No target/due date" });
  if (p.riskStatus === "Open" && !p.mitigationStrategy) {
    gaps.push({ code: "openRiskNoMitigation", label: "Open risk with no mitigation plan" });
  }
  if ((p.progressPercent == null || p.progressPercent === 0) && p.nativeStatus === "ongoing") {
    gaps.push({ code: "noProgressLogged", label: "Marked ongoing but 0% progress logged" });
  }
  if (!p.assignees || p.assignees.length === 0) {
    gaps.push({ code: "noAssignee", label: "No owner assigned" });
  }
  return gaps;
}

// Decides whether a project needs risk intervention -- and, per an explicit
// product decision, this is broader than just ClickUp's manually-set Risk
// Status field (which is empty on every task today, so a risk view built on
// that alone would show nothing). A project counts as "at risk" either
// because someone has explicitly flagged it (Risk Status = "Open", or an
// explicit "Project Health" field already reading "at risk"), OR simply
// because it's fallen behind schedule and isn't done yet -- schedule
// slippage is a real risk signal on its own, and shouldn't have to wait for
// a PM to also go tag it in ClickUp. Returns null for anything that doesn't
// need attention (including anything already completed -- a wrapped-up
// project's history doesn't need intervention anymore).
function riskSignal(p) {
  if (p.healthBucket === "completed") return null;

  const needsMitigation = !p.mitigationStrategy;
  if (String(p.riskStatus || "").toLowerCase() === "open") {
    return {
      reason: needsMitigation ? "Open risk in ClickUp — no mitigation plan yet" : "Open risk in ClickUp",
      source: "flagged",
      needsMitigation,
    };
  }
  if (p.healthBucket === "atRisk") {
    return { reason: "Marked at risk", source: "flagged", needsMitigation };
  }
  if (p.healthBucket === "delayed") {
    return { reason: "Behind schedule — past its target date and not yet complete", source: "schedule", needsMitigation };
  }
  return null;
}

// ClickUp always returns a task's assignees as a native array (no custom
// field needed) -- [{ id, username, email, profilePicture }, ...]. We only
// keep the bits the UI needs (a stable id to group by, plus a display name).
function nativeAssignees(task) {
  return (task.assignees || []).map((a) => ({
    id: a.id,
    name: a.username || a.email || `User ${a.id}`,
  }));
}

// This list's real ownership signal turned out (from a live screenshot,
// 2026-09-11) to be a separate custom field -- "Assigned To (Multi)" -- not
// ClickUp's built-in Assignee. `fieldName` comes from
// config/fieldMapping.json's "assignee" key. Confirmed against a real
// /api/portfolio debug response (2026-09-11): this field is actually
// ClickUp's **Labels** custom field type, repurposed to tag ownership --
// NOT a "users"/People field. That matters because a Labels field's value
// is an array of ids pointing into the field's OWN fixed option list
// (`type_config.options`, embedded on every task that carries the field),
// not real ClickUp user/workspace-member ids -- resolving those ids against
// `memberLookup` (workspace members) was the bug that produced raw-UUID
// names like "User ed689c9b-...". Handles the Labels shape as the primary
// case, with a fallback for a "users"-type field (bare ids or full user
// objects, resolved via `memberLookup`) in case a different list uses that
// instead.
function customFieldAssignees(task, fieldName, memberLookup = {}) {
  if (!fieldName) return [];
  // Uses the same lenient, prefer-the-populated-one lookup as the free-text
  // fallback -- this field is ALSO confirmed duplicated on this list (two
  // fields both named "Assigned To (Multi)"), so a plain `.find()` here has
  // the exact same risk of grabbing an empty duplicate over a populated one.
  const field = findFieldLenient(task.custom_fields, fieldName);
  if (!field || field.value == null) return [];
  const raw = Array.isArray(field.value) ? field.value : [field.value];

  if (field.type === "labels" && field.type_config?.options) {
    return raw
      .map((id) => {
        const opt = field.type_config.options.find((o) => o.id === id);
        return opt ? { id: opt.id, name: opt.label || opt.name || `Label ${opt.id}` } : null;
      })
      .filter(Boolean);
  }

  return raw
    .map((entry) => {
      if (entry && typeof entry === "object") {
        const id = entry.id ?? entry.user?.id;
        if (id == null) return null;
        const name =
          entry.username || entry.email || entry.user?.username || entry.user?.email || memberLookup[String(id)] || `User ${id}`;
        return { id, name };
      }
      if (entry == null) return null;
      return { id: entry, name: memberLookup[String(entry)] || `User ${entry}` };
    })
    .filter(Boolean);
}

// Fallback for ownership recorded as plain typed-in text rather than picked
// from the "Assigned To (Multi)" Labels field. Confirmed live (2026-09-11)
// via the Diagnostics panel's full custom-fields dump: a subtask can have
// BOTH copies of the (duplicated) "Assigned To (Multi)" field empty while a
// separate field literally named "Assigned to" (a short_text field, not a
// Labels/People field) holds a real name that matches what ClickUp's
// Roadmap view displays for that same task. Only used when the structured
// field found nothing -- a free-typed name can't be matched to a real
// ClickUp member as reliably as a fixed option list can (misspellings,
// nicknames, or several names separated inconsistently are all real risks
// here), so the structured field stays the preferred source whenever it has
// anything at all.
// Normalizes a field name for comparison (trims whitespace, lowercases).
// ClickUp field names can carry an invisible trailing/leading space that
// renders identically in a screenshot or in the Diagnostics panel but fails
// a strict `===` match -- confirmed as a real risk here (see
// config/fieldMapping.json's comment on "assigneeTextFallback"), so the
// free-text fallback field is looked up this way rather than by exact
// string equality.
function normalizeFieldName(name) {
  return String(name || "").trim().toLowerCase();
}

// True when a custom field actually carries something -- the same
// non-null/non-empty-array check used throughout this file and
// portfolio.js's diagnostics, factored out so "prefer the populated one"
// logic below can reuse it exactly.
function fieldHasValue(f) {
  return !!(f && f.value != null && (!Array.isArray(f.value) || f.value.length > 0));
}

// Looks up a field by name, tolerating a hidden whitespace mismatch without
// over-correcting into a WORSE bug: a case-insensitive match alone can
// conflate two genuinely different fields that just happen to differ only
// in case (confirmed live here -- "Assigned to", a short_text field, vs.
// "Assigned To", an unrelated drop_down field, both normalize to the same
// string). So this tries a trimmed-but-case-SENSITIVE match first (catches
// a stray leading/trailing space, the original bug found here), and only
// falls back to the fully case-insensitive match if nothing at all shares
// that exact spelling -- keeping two same-named-but-differently-cased
// fields distinguishable whenever an exact-case candidate exists.
//
// Within whichever tier matches, if MORE THAN ONE field shares that same
// name (confirmed live here -- a single task's own custom_fields array can
// carry two entries both literally named "Assigned to", with different
// field ids, one populated and one not), prefers whichever one actually has
// a value instead of blindly taking the first array element: `.find()`
// alone picks whatever ClickUp happened to list first regardless of which
// copy holds the real data, which was exactly the remaining bug here.
function findFieldLenient(customFields, fieldName) {
  const list = customFields || [];
  const pickBest = (candidates) => candidates.find(fieldHasValue) || candidates[0] || null;

  const trimmedWanted = String(fieldName || "").trim();
  const exactMatches = list.filter((f) => String(f.name || "").trim() === trimmedWanted);
  if (exactMatches.length > 0) return pickBest(exactMatches);

  const normWanted = normalizeFieldName(fieldName);
  const normMatches = list.filter((f) => normalizeFieldName(f.name) === normWanted);
  return pickBest(normMatches);
}

function textFieldAssignees(task, fieldName, members = []) {
  if (!fieldName) return [];
  const field = findFieldLenient(task.custom_fields, fieldName);
  if (!field || field.value == null) return [];
  const raw = typeof field.value === "string" ? field.value : String(field.value);
  const names = raw
    .split(/[,/;&]| and /i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return [];

  return names.map((name) => {
    const match = members.find((m) => m.name && m.name.toLowerCase() === name.toLowerCase());
    // A matched real member gets their real id (so they still correctly
    // dedupe/aggregate with anything else attributed to them elsewhere);
    // otherwise this typed name gets a stable id of its own so at least it
    // dedupes consistently with itself across tasks, rather than being
    // dropped or merged into "Unassigned".
    return match ? { id: match.id, name: match.name } : { id: `text:${name.toLowerCase()}`, name };
  });
}

// A trimmed, case/whitespace-insensitive key for "is this the same real
// person" -- used wherever two different ClickUp sources can name the
// exact same human under two different id shapes (see customFieldAssignees
// above: the native Assignee field's real numeric user id vs. the
// "Assigned To (Multi)" Labels field's own fixed-option id). Both sources
// still agree on the person's actual name, so normalized name is the
// reliable second key once id alone can't be trusted to mean "one person."
function normalizePersonName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Merges assignee lists from multiple sources (native field, custom field,
// rolled-up subtasks) and drops duplicates. Two entries with the same id
// are the obvious case; two entries with DIFFERENT ids but the same
// normalized name are the less obvious one this list is confirmed to hit
// live -- a single task's native Assignee field and its "Assigned To
// (Multi)" Labels field can both list the same real person under two
// different id shapes (see normalizePersonName above), which used to
// survive as two separate assignee entries for what's really one human.
// Keeps the first entry seen for a given id/name either way.
function dedupeAssignees(list) {
  const seen = new Map(); // id -> assignee
  const byName = new Map(); // normalized name -> id already kept
  list.forEach((a) => {
    if (!a || a.id == null) return;
    const idKey = String(a.id);
    if (seen.has(idKey)) return;
    const nameKey = normalizePersonName(a.name);
    if (nameKey && byName.has(nameKey)) return;
    seen.set(idKey, a);
    if (nameKey) byName.set(nameKey, idKey);
  });
  return Array.from(seen.values());
}

// Resolves a single task's assignees the exact same way toProject() and the
// subtask rollup in portfolio.js do: native assignees + the structured
// custom field first, falling back to the free-text field ONLY when
// neither found anything. Factored out so hoursByAssigneeForProject below
// (and the rollup itself) can't drift out of sync with who "owns" a task
// everywhere else in the app -- two different answers to "who is this
// task's assignee" would make the hours chart disagree with the workload
// cards for no good reason.
function resolveTaskAssignees(task, assigneeFieldName, memberLookup, assigneeTextFieldName, members) {
  const structured = [...nativeAssignees(task), ...customFieldAssignees(task, assigneeFieldName, memberLookup)];
  return structured.length > 0 ? structured : textFieldAssignees(task, assigneeTextFieldName, members || []);
}

// Converts ClickUp's native per-task time_estimate (milliseconds) into
// hours. Unset (null/undefined) and non-positive both come back as `null`,
// not 0 -- a task nobody has estimated yet needs to read as "no data",
// never as "this genuinely needs zero hours."
function taskEstimateHours(task) {
  if (!task || task.time_estimate == null) return null;
  const hours = Number(task.time_estimate) / 3600000;
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

// Rolls up real hour ESTIMATES (not project counts) per assignee for one
// project: the project's own task plus every one of its descendant
// subtasks (any depth), but ONLY from tasks that actually have ClickUp's
// native Estimate field filled in -- everything else contributes nothing,
// so a project with no estimates anywhere returns an empty map rather than
// a misleading all-zero one. A task estimated at Xh with N assignees
// splits its estimate evenly across them (X/N each): ClickUp only supports
// true per-assignee estimates on some plans, so an even split is the
// closest thing to "hours needed" for this task that works everywhere.
function hoursByAssigneeForProject(projectTask, descendantTasks, opts = {}) {
  const { assigneeFieldName, memberLookup, assigneeTextFieldName, members } = opts;
  const totals = new Map();
  const add = (task) => {
    const hours = taskEstimateHours(task);
    if (hours == null) return;
    const assignees = resolveTaskAssignees(task, assigneeFieldName, memberLookup, assigneeTextFieldName, members);
    if (assignees.length === 0) return;
    const share = hours / assignees.length;
    assignees.forEach((a) => {
      if (a == null || a.id == null) return;
      totals.set(a.id, (totals.get(a.id) || 0) + share);
    });
  };
  add(projectTask);
  (descendantTasks || []).forEach(add);
  return totals;
}

// Finds the best available "start" for the Gantt tab's bar, for one project.
// A project's own top-level task very often has no native Start Date set
// even when its subtasks do (the exact same pattern already confirmed for
// ownership -- see the assignee rollup above and the comment on it in
// portfolio.js) -- ClickUp's own Roadmap/Gantt views can show a spread-out
// date range for a project because THEY roll dates up from subtasks, while
// the raw project task's own start_date field stays null. Reading only that
// raw field (as toProject() does on its own) makes almost every bar fall
// back to the task's creation date instead, which -- if a whole list of
// projects was bulk-created/imported on the same day, as this one was
// (see the "3. Custom fields" README section's discovery date) -- collapses
// nearly every bar to a sliver clustered on that one day, since a real due
// date that already predates the creation date fails the
// "start must be <= due" guard the frontend applies. This rolls up through
// every descendant subtask (any depth) the exact same way hours/assignees
// already do, in three tiers:
//   1. The EARLIEST real start_date anywhere in the tree (the project's own
//      task, or any descendant) -- `real: true`, renders as a solid bar.
//   2. No start_date anywhere -- the earliest due_date among DESCENDANTS
//      only (never the project's own due_date, which is this bar's END) --
//      subtasks often carry real due dates spread across months even when
//      nothing in the tree has an explicit Start Date.
//   3. Last resort: the project's own task creation date, same as before.
// Tiers 2 and 3 both come back as `real: false` (an assumed start, rendered
// dashed) -- only tier 1 is a genuine ClickUp Start Date.
function ganttStartInfo(projectTask, descendantTasks) {
  const tasks = [projectTask, ...(descendantTasks || [])].filter(Boolean);

  const startCandidates = tasks
    .map((t) => (t.start_date ? Number(t.start_date) : null))
    .filter((ms) => Number.isFinite(ms));
  if (startCandidates.length > 0) {
    return { startMs: Math.min(...startCandidates), real: true };
  }

  const dueCandidates = (descendantTasks || [])
    .map((t) => (t.due_date ? Number(t.due_date) : null))
    .filter((ms) => Number.isFinite(ms));
  if (dueCandidates.length > 0) {
    return { startMs: Math.min(...dueCandidates), real: false };
  }

  const createdMs = projectTask && projectTask.date_created ? Number(projectTask.date_created) : null;
  return { startMs: Number.isFinite(createdMs) ? createdMs : null, real: false };
}

// Monday 00:00:00 through Sunday 23:59:59.999 of the current week (server
// local time) -- shared by /api/weekly (real data) and mockWeekly.js
// (preview data) so both apply the exact same "this week" boundary the
// Weekly Activity tab's own header already displays.
function currentWeekRange(now = new Date()) {
  const DAY_MS = 86400000;
  const day = (now.getDay() + 6) % 7; // 0 = Monday ... 6 = Sunday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  const sundayEnd = new Date(monday.getTime() + 7 * DAY_MS - 1);
  return { start: monday.getTime(), end: sundayEnd.getTime() };
}

// `opts.assigneeFieldName` / `opts.memberLookup` are optional -- omitting
// them (e.g. in mock/preview mode) just falls back to native assignees only.
// `opts.assigneeTextFieldName` / `opts.members` enable the free-text
// fallback (see textFieldAssignees above) for tasks where neither the
// native assignee field nor the structured custom field has anything.
function toProject(task, opts = {}) {
  const structuredAssignees = dedupeAssignees([
    ...nativeAssignees(task),
    ...customFieldAssignees(task, opts.assigneeFieldName, opts.memberLookup),
  ]);
  const assignees =
    structuredAssignees.length > 0
      ? structuredAssignees
      : dedupeAssignees(textFieldAssignees(task, opts.assigneeTextFieldName, opts.members));
  const p = {
    id: task.id,
    name: task.name,
    healthBucket: bucketHealth(task),
    nativeStatus: task.status?.status || null,
    currentGate: mapped(task, "currentGate"),
    gatePhase: mapped(task, "gatePhase"),
    progressPercent: mapped(task, "progress"),
    product: mapped(task, "product"),
    productCategory: mapped(task, "productCategory"),
    tooling: mapped(task, "tooling"),
    riskStatus: mapped(task, "riskStatus"),
    riskScore: mapped(task, "riskScore"),
    probability: mapped(task, "probability"),
    impact: mapped(task, "impact"),
    mitigationStrategy: mapped(task, "mitigationStrategy"),
    targetGateDate: nativeDueDate(task),
    startDate: nativeStartDate(task),
    createdDate: nativeCreatedDate(task),
    assignees,
    url: task.url,
  };
  p.gaps = computeGaps(p);
  p.risk = riskSignal(p);
  return p;
}

// Workload-by-person: groups active work by assignee so a PM can see who's
// carrying the most projects at a glance. Deliberately counts "active" +
// "delayed" + "atRisk" projects as live workload and excludes "completed" --
// a wrapped-up project shouldn't count against someone's current load.
// Unassigned projects are rolled into a single "Unassigned" bucket so that
// gap is visible here too, not just in Decisions & Gaps.
//
// Grouped by normalized name (see normalizePersonName), not raw id: two
// different projects can hand back the exact same real person under two
// different ClickUp id shapes (the native Assignee field vs. the "Assigned
// To (Multi)" Labels field's own option ids -- see customFieldAssignees),
// and dedupeAssignees only catches that split within a single task's own
// assignee list, not across the whole portfolio. Without this, that one
// person showed up as two separate rows here -- a duplicate slice in the
// workload donut/legend, and the SAME project double-counted against what
// was really one person's total (this is the same id-vs-name split
// dashboard.js's renderWorkloadKanban already had to work around when
// matching tasks back to a person -- fixed here at the source instead).
function computeWorkload(projects) {
  const byPerson = new Map(); // consolidation key -> entry
  const keyByName = new Map(); // normalized name -> consolidation key already in use
  const ensure = (id, name) => {
    const nameKey = id === "unassigned" ? null : normalizePersonName(name);
    const key = nameKey && keyByName.has(nameKey) ? keyByName.get(nameKey) : id;
    if (nameKey && !keyByName.has(nameKey)) keyByName.set(nameKey, key);
    if (!byPerson.has(key)) {
      byPerson.set(key, { id: key, name, active: 0, delayed: 0, atRisk: 0, completed: 0, total: 0, projects: [] });
    }
    return byPerson.get(key);
  };

  projects.forEach((p) => {
    const owners = p.assignees && p.assignees.length > 0 ? p.assignees : [{ id: "unassigned", name: "Unassigned" }];
    owners.forEach((owner) => {
      const entry = ensure(owner.id, owner.name);
      entry[p.healthBucket] = (entry[p.healthBucket] || 0) + 1;
      if (p.healthBucket !== "completed") entry.total += 1;
      // `hours` is a real ClickUp Estimate-derived number for this specific
      // person on this specific project when one exists (see
      // hoursByAssigneeForProject in portfolio.js), or null when nobody's
      // estimated any of this project's tasks yet -- callers decide how to
      // display "no data" rather than this silently becoming 0.
      const hours = p.hoursByAssignee && p.hoursByAssignee[owner.id] != null ? p.hoursByAssignee[owner.id] : null;
      // Belt-and-suspenders against this same project being pushed twice
      // for one consolidated person -- shouldn't happen once dedupeAssignees
      // has already collapsed a single task's own owner list, but costs
      // nothing to guarantee here too.
      if (!entry.projects.some((existing) => existing.id === p.id)) {
        entry.projects.push({ id: p.id, name: p.name, healthBucket: p.healthBucket, url: p.url, hours });
      }
    });
  });

  return Array.from(byPerson.values()).sort((a, b) => b.total - a.total);
}

function tally(items, keyFn) {
  const out = {};
  items.forEach((item) => {
    const key = keyFn(item) || "Unclassified";
    out[key] = (out[key] || 0) + 1;
  });
  return out;
}

// Split out from toPortfolioSummary so callers that need to enrich projects
// after the fact (e.g. portfolio.js rolling up subtask assignees, which
// needs its own async ClickUp calls per project) can build the `projects`
// array themselves, mutate it, and still get the same summary shape back.
function summarizeProjects(projects) {
  const counts = { active: 0, delayed: 0, atRisk: 0, completed: 0, total: projects.length };
  projects.forEach((p) => {
    counts[p.healthBucket] = (counts[p.healthBucket] || 0) + 1;
  });

  const now = Date.now();
  const upcomingGates = projects
    .filter((p) => p.targetGateDate && !Number.isNaN(Date.parse(p.targetGateDate)))
    .filter((p) => Date.parse(p.targetGateDate) >= now - 1000 * 60 * 60 * 24) // allow "today"
    .sort((a, b) => Date.parse(a.targetGateDate) - Date.parse(b.targetGateDate))
    .slice(0, 6)
    .map((p) => ({
      project: p.name,
      gate: p.currentGate || p.gatePhase,
      date: p.targetGateDate,
    }));

  const byCategory = tally(projects, (p) => p.productCategory);
  const byGate = tally(projects, (p) => p.currentGate || p.gatePhase);

  const flagged = projects
    .filter((p) => p.gaps.length > 0)
    .map((p) => ({ id: p.id, name: p.name, url: p.url, gaps: p.gaps }));

  const gapTotals = {};
  flagged.forEach((f) => f.gaps.forEach((g) => { gapTotals[g.code] = (gapTotals[g.code] || 0) + 1; }));

  // The Risk Register: every project riskSignal() flagged (see above),
  // shaped for direct rendering -- name/owner/gate/date already resolved so
  // the frontend doesn't need to re-derive any of it from raw project
  // fields. Sorted so the projects most in need of a mitigation plan lead.
  const risks = projects
    .filter((p) => p.risk)
    .map((p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      reason: p.risk.reason,
      source: p.risk.source, // "flagged" (ClickUp Risk Status/Project Health) or "schedule" (auto-derived from a missed due date)
      needsMitigation: p.risk.needsMitigation,
      owners: p.assignees && p.assignees.length > 0 ? p.assignees.map((a) => a.name).join(", ") : "Unassigned",
      gate: p.currentGate || p.gatePhase || null,
      dueDate: p.targetGateDate || null,
      healthBucket: p.healthBucket,
    }))
    .sort((a, b) => (b.needsMitigation === a.needsMitigation ? 0 : b.needsMitigation ? 1 : -1));

  const riskCounts = { flagged: 0, schedule: 0, needsMitigation: 0 };
  risks.forEach((r) => {
    riskCounts[r.source] = (riskCounts[r.source] || 0) + 1;
    if (r.needsMitigation) riskCounts.needsMitigation += 1;
  });

  return {
    source: "clickup",
    generatedAt: new Date().toISOString(),
    counts,
    projects,
    upcomingGates,
    byCategory,
    byGate,
    workload: computeWorkload(projects),
    decisions: { flagged, gapTotals, totalFlagged: flagged.length },
    risks,
    riskCounts,
  };
}

function toPortfolioSummary(tasks, opts = {}) {
  const projects = tasks.map((t) => toProject(t, opts));
  return summarizeProjects(projects);
}

// Flattens a project's full subtask tree (every depth, NOT pruned to "this
// week" -- see weekly.js's buildWeekTree, called before its own
// pruneToWeekWork) into one flat list of still-open items, each carrying its
// own resolved assignees (already defaulted to the project's own assignees
// when a given subtask has nobody set -- see mapNode's fallbackAssignees).
// Used by the Resources "board by person" kanban to show what a specific
// person is actually doing on a project, instead of just repeating the
// project name in every column it appears in. A parent/grouping task is
// included alongside its children (not just leaves) since ClickUp doesn't
// distinguish "pure folder" tasks from actionable ones structurally -- a
// parent with no explicit assignee of its own still inherits the project's
// assignees via the same fallback, so it isn't dropped for looking
// unowned.
function flattenOpenTasks(nodes) {
  const out = [];
  (nodes || []).forEach((n) => {
    // ClickUp's status TYPE is "open" | "custom" | "closed" | "done" --
    // a custom status like "Complete" can carry type "closed" rather than
    // literally "done" (see bucketHealth above, which already treats both
    // the same way). Checking only "done" here let those tasks slip through
    // as still-open, which is why "near-term (this week)" and the
    // comprehensive timeline could show tasks that were actually finished
    // months ago. "closed" means finished exactly like "done" does.
    if (n.statusType !== "done" && n.statusType !== "closed") {
      // startDate/dueDate carried through (both epoch-ms or null, same shape
      // weekly.js's mapNode sets on every node) so callers can tell a task
      // scheduled into some week apart from one sitting in the backlog with
      // neither date set -- see the Deep Dive Timeline tab's live ClickUp
      // feed and Weekly Activity's Product Backlog panel in dashboard.js.
      out.push({ id: n.id, name: n.name, status: n.status, statusType: n.statusType, assignees: n.assignees || [], startDate: n.startDate ?? null, dueDate: n.dueDate ?? null });
    }
    out.push(...flattenOpenTasks(n.children));
  });
  return out;
}

module.exports = {
  toProject,
  toPortfolioSummary,
  summarizeProjects,
  getCustomField,
  nativeDueDate,
  nativeStartDate,
  nativeCreatedDate,
  computeGaps,
  riskSignal,
  computeWorkload,
  nativeAssignees,
  customFieldAssignees,
  textFieldAssignees,
  normalizeFieldName,
  findFieldLenient,
  dedupeAssignees,
  resolveTaskAssignees,
  taskEstimateHours,
  hoursByAssigneeForProject,
  ganttStartInfo,
  currentWeekRange,
  flattenOpenTasks,
};
