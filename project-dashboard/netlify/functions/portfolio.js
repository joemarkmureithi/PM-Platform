const { client } = require("./lib/clickupClient");
const { toProject, summarizeProjects, computeGaps, normalizeFieldName, findFieldLenient, dedupeAssignees, resolveTaskAssignees, hoursByAssigneeForProject, ganttStartInfo } = require("./lib/transform");
const mockData = require("./lib/mockData");
const fieldMapping = require("../../config/fieldMapping.json");

// Preview-mode stand-ins for the dropdown options / assignable members the
// Decisions & Gaps inline editors need. Mirrors the real shape so the write
// -back UI is fully clickable in preview -- it just reports "preview mode,
// not actually saved" instead of calling ClickUp (see gap-update.js).
const MOCK_FIELD_OPTIONS = {
  productCategory: ["Charcoal Stove", "Wood Stove", "Cookware"],
  gatePhase: ["Project Kickoff", "Scoping & Feasibility", "Preliminary Design", "Detailed Design", "Launch", "Post Launch Improvements"],
  riskStatus: ["Open", "Mitigating", "Mitigated", "Closed"],
  assignee: ["Amara O.", "Dan K.", "Priya N."],
};
const MOCK_MEMBERS = [
  { id: "u1", name: "Amara O." },
  { id: "u2", name: "Dan K." },
  { id: "u3", name: "Priya N." },
];

// Resolves the dropdown option lists for the three custom fields the
// Decisions & Gaps editors can write to, using each field's real ClickUp
// name from config/fieldMapping.json rather than hardcoding them here.
// Also reports, per key, whether the field was found at all vs. found but
// with zero options -- those are different problems (a name mismatch in
// fieldMapping.json vs. a genuinely-empty dropdown in ClickUp) and the
// first one is silent and easy to miss otherwise.
function buildFieldOptions(fields) {
  const wanted = {
    productCategory: fieldMapping.productCategory,
    gatePhase: fieldMapping.gatePhase,
    riskStatus: fieldMapping.riskStatus,
    assignee: fieldMapping.assignee,
  };
  const out = {};
  const debug = {};
  Object.entries(wanted).forEach(([key, fieldName]) => {
    const f = fields.find((x) => x.name === fieldName);
    // drop_down options carry a display name in `.name`; a "labels" field
    // (the shape "Assigned To (Multi)" turned out to be, confirmed live
    // 2026-09-11) carries it in `.label` instead -- support both so this
    // stays correct if a differently-typed field is ever mapped here.
    out[key] = (f?.type_config?.options || []).map((o) => o.name ?? o.label);
    debug[key] = f ? `found field "${fieldName}" with ${out[key].length} option(s)` : `no field named "${fieldName}" in this list's fields`;
  });
  return { options: out, debug };
}

// ClickUp's "Get List Members" response has been seen in more than one
// shape in the wild (flat user fields vs. nested under `.user`) -- try both
// rather than assuming, so a member list that "succeeds" but shows nothing
// but "User 12345" fallback names is easy to tell apart from one that's
// genuinely empty.
function memberName(m) {
  const u = m.user || m;
  return u.username || u.email || null;
}

// GET /.netlify/functions/portfolio  (aliased to /api/portfolio via netlify.toml)
// Returns the Portfolio Overview payload: KPI counts, upcoming gates, the
// full project list, and (for the Decisions & Gaps inline editors) the
// dropdown option lists and assignable members pulled live from ClickUp.
// Falls back to mock data when ClickUp isn't configured yet, so the
// dashboard is always renderable.
exports.handler = async () => {
  const token = process.env.CLICKUP_API_TOKEN;
  const listId = process.env.CLICKUP_LIST_ID;

  if (!token || !listId) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ...mockData, fieldOptions: MOCK_FIELD_OPTIONS, members: MOCK_MEMBERS }),
    };
  }

  try {
    const cu = client(token);
    // Fields/members are fetched separately from the main task list on
    // purpose: a failure here (permissions, an unexpected response shape)
    // shouldn't take down the whole dashboard, just degrade the gap
    // editors -- so failures are caught individually and reported in
    // `debug` rather than left to silently produce empty dropdowns with no
    // way to tell why.
    const [tasks, fieldsResult, membersResult] = await Promise.all([
      cu.getListTasks(listId),
      cu.getListFields(listId).then((v) => ({ ok: true, value: v })).catch((err) => ({ ok: false, error: err.message })),
      cu.getListMembers(listId).then((v) => ({ ok: true, value: v })).catch((err) => ({ ok: false, error: err.message })),
    ]);

    const fields = fieldsResult.ok ? fieldsResult.value : [];
    const { options: fieldOptions, debug: fieldOptionsDebug } = buildFieldOptions(fields);

    const rawMembers = membersResult.ok ? membersResult.value : [];
    const members = rawMembers.map((m) => {
      const u = m.user || m;
      const id = u.id ?? m.id;
      return { id, name: memberName(m) || `User ${id}` };
    });
    const memberLookup = {};
    members.forEach((m) => { memberLookup[String(m.id)] = m.name; });

    const assigneeFieldName = fieldMapping.assignee;
    const assigneeField = fields.find((f) => f.name === assigneeFieldName);
    const assigneeFieldDebug = !assigneeFieldName
      ? 'no "assignee" key set in config/fieldMapping.json'
      : assigneeField
      ? `found field "${assigneeFieldName}" (type: ${assigneeField.type})`
      : `no field named "${assigneeFieldName}" in this list's fields -- check config/fieldMapping.json's "assignee" value against the real column name in ClickUp`;

    // Checks for a field-name COLLISION -- if ClickUp has more than one field
    // literally named "Assigned To (Multi)" on this list (e.g. one at the
    // list level, one inherited from its Space/Folder), `fields.find()`
    // above silently picks whichever comes first, which may not be the one
    // actually populated and shown in views like Roadmap. Two field ids here
    // would fully explain the API reading empty while ClickUp's own UI shows
    // real values for the same tasks.
    const assigneeFieldNameMatches = assigneeFieldName
      ? fields
          .filter((f) => f.name === assigneeFieldName)
          .map((f) => ({ id: f.id, type: f.type, optionCount: f.type_config?.options?.length ?? null }))
      : [];

    // Confirmed live (2026-09-11): when the structured "Assigned To (Multi)"
    // field is empty, some tasks instead carry a real owner's name typed
    // directly into a separate free-text field named "Assigned to" -- and
    // that field is what ClickUp's Roadmap view was actually showing for
    // those tasks. Used only as a fallback (see textFieldAssignees in
    // transform.js) -- the structured field stays authoritative whenever it
    // has anything at all.
    const assigneeTextFieldName = fieldMapping.assigneeTextFallback;

    // Surfaces hidden whitespace/case differences in a field name that would
    // otherwise silently defeat an exact-string match -- confirmed as a real
    // risk here: a field can render as "Assigned to" in every screenshot and
    // in this very panel while its actual raw name carries an invisible
    // trailing space, which fails `===` but not this normalized comparison.
    // `JSON.stringify` on each raw name is what makes that kind of thing
    // visible (a trailing space shows up inside the quotes) when it
    // wouldn't in plain rendered text.
    // Also flags WHICH one findFieldLenient() would actually pick (prefers
    // a trimmed-but-case-sensitive match; only falls back to fully
    // case-insensitive if nothing shares the exact spelling) -- confirmed
    // live here that this matters: "Assigned to" (short_text, real data)
    // and "Assigned To" (drop_down, unrelated) both normalize to the same
    // string but are genuinely different fields, and a naive
    // case-insensitive-only match could silently pick the wrong one.
    const assigneeTextFieldCloseMatches = assigneeTextFieldName
      ? (() => {
          const matches = fields.filter((f) => normalizeFieldName(f.name) === normalizeFieldName(assigneeTextFieldName));
          const picked = findFieldLenient(matches, assigneeTextFieldName);
          return matches.map((f) => ({
            rawName: JSON.stringify(f.name),
            id: f.id,
            type: f.type,
            exactMatch: f.name === assigneeTextFieldName,
            willUse: picked ? f.id === picked.id : false,
          }));
        })()
      : [];

    // Raw sample of the assignee custom field exactly as ClickUp returned it
    // (not the parsed {id,name} shape) -- lets a single /api/portfolio fetch
    // reveal the real value shape for a "users"-type field, which has never
    // been confirmed live, instead of another guess-fix-retest round trip.
    const rawProjectAssigneeFieldSample = assigneeFieldName
      ? tasks.map((t) => findFieldLenient(t.custom_fields, assigneeFieldName)).find((f) => f && f.value != null) ||
        tasks.map((t) => findFieldLenient(t.custom_fields, assigneeFieldName)).find(Boolean) ||
        null
      : null;

    let projects = tasks.map((t) => toProject(t, { assigneeFieldName, memberLookup, assigneeTextFieldName, members }));

    // Ownership on this list is often only set at the subtask level, not on
    // the project's own top-level task (confirmed from a live screenshot,
    // 2026-09-11) -- so a project can show no owner here even though its
    // subtasks (at any depth) do. Roll those up into the project's
    // effective assignee list.
    //
    // This fetches the WHOLE list including subtasks in ONE call
    // (getListTasksWithSubtasks), rather than one getSubtasks() call per
    // project as an earlier version did. That earlier version was silently
    // under-counting: a live screenshot (2026-09-11) showed subtask owners
    // in ClickUp that it never picked up, which points at Get Task's
    // `include_subtasks` response not reliably carrying full custom_fields
    // on nested subtasks. getListTasksWithSubtasks reuses the same Get
    // Tasks (list) endpoint/shape as the main project fetch instead, so
    // custom_fields are guaranteed complete -- and it's one call instead of
    // ~N, so this is also faster than the version it replaced.
    //
    // One failure here degrades gracefully: projects just keep whatever
    // assignees they already had from their own task/custom field, rather
    // than blanking out the whole portfolio.
    let rawSubtaskAssigneeFieldSample = null;
    let subtaskRollupError = null;
    let subtaskDiagnostics = null;
    try {
      const allTasks = await cu.getListTasksWithSubtasks(listId);

      const byParent = new Map();
      allTasks.forEach((t) => {
        if (!t.parent) return;
        if (!byParent.has(t.parent)) byParent.set(t.parent, []);
        byParent.get(t.parent).push(t);
      });

      if (assigneeFieldName) {
        // Carries which task this came from (id/name/parent) now, not just
        // the bare field -- a raw field value alone doesn't say whether it
        // belongs to a project that's already otherwise-assigned (so the
        // rollup finding it changes nothing visible) or to a genuinely
        // unassigned one.
        const subtaskWithValue = allTasks.find((t) => {
          if (!t.parent) return false;
          const f = findFieldLenient(t.custom_fields, assigneeFieldName);
          return !!(f && f.value != null);
        });
        if (subtaskWithValue) {
          const field = findFieldLenient(subtaskWithValue.custom_fields, assigneeFieldName);
          rawSubtaskAssigneeFieldSample = {
            ...field,
            __fromTaskId: subtaskWithValue.id,
            __fromTaskName: subtaskWithValue.name,
            __fromTaskParent: subtaskWithValue.parent,
          };
        }
      }

      // Every descendant at any depth under a project, not just its direct
      // children -- e.g. project -> "Box Development" -> "Artwork" all roll
      // up to the top-level project.
      function collectDescendants(taskId) {
        const out = [];
        const queue = [...(byParent.get(taskId) || [])];
        while (queue.length) {
          const t = queue.shift();
          out.push(t);
          (byParent.get(t.id) || []).forEach((child) => queue.push(child));
        }
        return out;
      }

      const rawTaskById = new Map(tasks.map((t) => [t.id, t]));

      projects = projects.map((p) => {
        const descendants = collectDescendants(p.id);
        const rawProjectTask = rawTaskById.get(p.id);
        let next = p;

        // Ownership/hours rollups only matter for current workload -- a
        // wrapped-up project's assignees/estimates don't feed anything else,
        // so skip them for completed projects (unchanged from before).
        if (p.healthBucket !== "completed") {
          const subAssignees = descendants.flatMap((st) =>
            resolveTaskAssignees(st, assigneeFieldName, memberLookup, assigneeTextFieldName, members)
          );
          if (subAssignees.length > 0) {
            next = { ...p, assignees: dedupeAssignees([...p.assignees, ...subAssignees]) };
            next.gaps = computeGaps(next);
          }

          // Real hours-needed data, per person, for this project -- see
          // hoursByAssigneeForProject in lib/transform.js. Only ever set when
          // ClickUp's native Estimate field is actually filled in somewhere
          // on the project's own task or one of its subtasks; otherwise the
          // project carries no hoursByAssignee at all, and the Resources tab
          // falls back to an even-split assumption for anyone on it.
          const hoursMap = hoursByAssigneeForProject(rawProjectTask, descendants, {
            assigneeFieldName,
            memberLookup,
            assigneeTextFieldName,
            members,
          });
          if (hoursMap.size > 0) {
            next = next === p ? { ...p } : next;
            next.hoursByAssignee = Object.fromEntries(hoursMap);
          }
        }

        // Gantt start-date rollup -- unlike the above, this runs for EVERY
        // project regardless of completion, since a finished project's bar
        // should still plot correctly. See ganttStartInfo() in transform.js
        // for why this is needed at all: most project-level tasks here have
        // no native Start Date of their own.
        const ganttStart = ganttStartInfo(rawProjectTask, descendants);
        if (ganttStart.startMs != null) {
          next = next === p ? { ...p } : next;
          if (ganttStart.real) {
            next.startDate = new Date(ganttStart.startMs).toISOString();
          } else {
            next.createdDate = new Date(ganttStart.startMs).toISOString();
          }
        }

        return next;
      });

      // Extra diagnostics so a still-mostly-"Unassigned" Workload view is
      // self-diagnosing without another screenshot round trip. In
      // particular: for one project that's STILL unassigned after the
      // rollup, this shows exactly what ClickUp's API returned as its direct
      // children -- which tells us definitively whether the gap is "this
      // task genuinely has no subtasks in this list" (e.g. because the
      // nesting a person sees in ClickUp's Roadmap view isn't real
      // parent/subtask nesting, or the child tasks live in a different
      // list) vs. "it has subtasks but none of them carry this field."
      // A ClickUp "labels" field comes back as `value: []` (not null) on a
      // task where nothing's been picked -- so "has a value" must also check
      // the array isn't empty, or every untouched task reads as "assigned."
      // Shared by both the aggregate count below and each child's
      // hasAssigneeFieldValue flag, which is exactly the check that was
      // inconsistent here before and made the diagnostics say a subtask
      // "has owner" when its value was really just [].
      // Reflects the SAME effective source the real rollup above now uses:
      // the structured Labels field if it has anything, otherwise the
      // free-text "Assigned to" fallback -- so a subtask that's only really
      // owned via the fallback field doesn't wrongly show as "no owner"
      // here the way it would if this only checked the structured field.
      const hasStructuredAssigneeValue = (task) => {
        // Same lenient, prefer-populated lookup as the rollup itself uses
        // (via customFieldAssignees) -- this list has two fields both
        // literally named "Assigned To (Multi)", so a plain `.find()` here
        // could disagree with what the rollup actually read.
        const f = findFieldLenient(task.custom_fields, assigneeFieldName);
        return !!(f && f.value != null && (!Array.isArray(f.value) || f.value.length > 0));
      };
      const hasTextFallbackValue = (task) => {
        if (!assigneeTextFieldName) return false;
        const f = findFieldLenient(task.custom_fields, assigneeTextFieldName);
        if (!f || f.value == null) return false;
        if (typeof f.value === "string") return f.value.trim().length > 0;
        // A non-string value here (e.g. this list's field turns out to be a
        // different type than expected) still counts as "has something" --
        // textFieldAssignees() coerces it to a string rather than skipping
        // it, so this diagnostic should agree rather than under-report.
        return Array.isArray(f.value) ? f.value.length > 0 : true;
      };
      const hasRealAssigneeValue = (task) => hasStructuredAssigneeValue(task) || hasTextFallbackValue(task);
      const allSubtasks = allTasks.filter((t) => t.parent);
      const subtasksWithAssigneeValue = assigneeFieldName ? allSubtasks.filter(hasStructuredAssigneeValue).length : null;
      const subtasksWithTextFallbackValue = assigneeTextFieldName
        ? allSubtasks.filter((t) => !hasStructuredAssigneeValue(t) && hasTextFallbackValue(t)).length
        : null;
      const stillUnassigned = projects.find((p) => p.healthBucket !== "completed" && p.assignees.length === 0);
      subtaskDiagnostics = {
        totalTasksFetchedIncludingSubtasks: allTasks.length,
        totalSubtasksAnyDepth: allSubtasks.length,
        subtasksWithAssigneeFieldValueSet: subtasksWithAssigneeValue,
        subtasksWithTextFallbackValueSet: subtasksWithTextFallbackValue,
        sampleStillUnassignedProjectAfterRollup: stillUnassigned
          ? {
              id: stillUnassigned.id,
              name: stillUnassigned.name,
              directChildCount: (byParent.get(stillUnassigned.id) || []).length,
              directChildSample: (byParent.get(stillUnassigned.id) || []).slice(0, 5).map((t) => ({
                id: t.id,
                name: t.name,
                parent: t.parent,
                hasAssigneeFieldValue: assigneeFieldName ? hasRealAssigneeValue(t) : null,
              })),
            }
          : null,
      };

      // Full custom_fields dump for ONE sample child subtask -- not just
      // whatever field config/fieldMapping.json's "assignee" value says to
      // look for. If the real assignment data ClickUp's Roadmap view shows
      // actually lives under a DIFFERENTLY-named field (a near-duplicate
      // name, different casing, trailing whitespace, or a field that just
      // looks similar in that view but isn't literally "Assigned To
      // (Multi)"), this is what would reveal it -- every check above only
      // ever looked for a field matching that one exact name, so it could
      // never have found a differently-named field even if that's where the
      // real data is.
      const sampleChildForFullDump = stillUnassigned
        ? (byParent.get(stillUnassigned.id) || [])[0]
        : null;
      subtaskDiagnostics.fullCustomFieldDumpForOneSampleChild = sampleChildForFullDump
        ? {
            taskId: sampleChildForFullDump.id,
            taskName: sampleChildForFullDump.name,
            allCustomFields: (sampleChildForFullDump.custom_fields || []).map((f) => ({
              name: f.name,
              type: f.type,
              hasValue: f.value != null && (!Array.isArray(f.value) || f.value.length > 0),
              value: f.value,
            })),
          }
        : null;

      // Closes the loop completely on THIS exact sample child: shows
      // exactly what findFieldLenient() found (if anything), the field's
      // raw value's JS type (a lossy display like "has value: X" can't
      // distinguish a plain string from a one-item array -- typeof/
      // Array.isArray here can), and what hasTextFallbackValue() computed
      // for it -- so there's no remaining ambiguity about why a subtask
      // that visibly "has a value" in the full dump above either did or
      // didn't get picked up by the fallback.
      if (sampleChildForFullDump && assigneeTextFieldName) {
        const matchedField = findFieldLenient(sampleChildForFullDump.custom_fields, assigneeTextFieldName);
        subtaskDiagnostics.textFallbackCheckForSampleChild = {
          fieldFound: !!matchedField,
          matchedFieldId: matchedField ? matchedField.id : null,
          rawValueType: matchedField ? (Array.isArray(matchedField.value) ? "array" : typeof matchedField.value) : null,
          rawValueJSON: matchedField ? JSON.stringify(matchedField.value) : null,
          hasTextFallbackValueResult: hasTextFallbackValue(sampleChildForFullDump),
          hasStructuredAssigneeValueResult: hasStructuredAssigneeValue(sampleChildForFullDump),
        };
      }

      // One more targeted check for that same sample project: fetch it a
      // SECOND way -- ClickUp's single-task "Get Task" endpoint
      // (include_subtasks=true), not the bulk "Get Tasks" (list) endpoint
      // the rest of this rollup is built on -- and see if IT reports real
      // assignee values for the same children the bulk list endpoint above
      // just said were empty. If ClickUp's own UI shows real owners for
      // these subtasks (confirmed live) but the bulk list endpoint reports
      // them empty, this tells us whether the single-task endpoint agrees
      // with the UI (meaning the bulk list endpoint is what's unreliable
      // here, and the fix is to fetch this data a different way) or also
      // comes back empty (meaning something else is going on -- e.g. the
      // value shown in that ClickUp view isn't actually stored as this
      // field's value on the subtask itself). Best-effort: any failure here
      // just omits this comparison rather than breaking the rollup.
      if (stillUnassigned) {
        try {
          const detail = await cu.getTaskDetail(stillUnassigned.id);
          const directChildrenViaSingleFetch = (detail.subtasks || []).filter((t) => t.parent === stillUnassigned.id);
          subtaskDiagnostics.singleTaskFetchComparison = {
            note: "Same project, fetched via GET /task/{id}?include_subtasks=true instead of the bulk list endpoint above.",
            directChildCount: directChildrenViaSingleFetch.length,
            directChildSample: directChildrenViaSingleFetch.slice(0, 5).map((t) => ({
              id: t.id,
              name: t.name,
              hasAssigneeFieldValue: assigneeFieldName ? hasRealAssigneeValue(t) : null,
            })),
          };
        } catch (err) {
          subtaskDiagnostics.singleTaskFetchComparison = { error: err.message };
        }
      }
    } catch (err) {
      subtaskRollupError = err.message;
    }

    const summary = summarizeProjects(projects);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        ...summary,
        fieldOptions,
        members,
        // Not used by the UI -- included so a fresh /api/portfolio fetch is
        // self-diagnosing for the "dropdowns are empty / show odd values"
        // class of problem without needing extra round-trips.
        debug: {
          fieldOptions: fieldOptionsDebug,
          fieldsCallError: fieldsResult.ok ? null : fieldsResult.error,
          membersCallError: membersResult.ok ? null : membersResult.error,
          rawMemberCount: rawMembers.length,
          rawMemberSample: rawMembers[0] || null,
          assigneeField: assigneeFieldDebug,
          assigneeFieldNameMatches,
          assigneeTextFieldCloseMatches,
          subtaskRollupError,
          subtaskDiagnostics,
          rawProjectAssigneeFieldSample,
          rawSubtaskAssigneeFieldSample,
        },
      }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message, source: "clickup-error" }),
    };
  }
};
