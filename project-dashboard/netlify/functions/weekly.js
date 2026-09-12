const { client } = require("./lib/clickupClient");
const { toPortfolioSummary, currentWeekRange, resolveTaskAssignees, flattenOpenTasks } = require("./lib/transform");
const mockWeekly = require("./lib/mockWeekly");
const fieldMapping = require("../../config/fieldMapping.json");

// GET /api/weekly
// "Every active project right now, with what's actually moving underneath
// it THIS WEEK" -- pulls each non-completed project's live ClickUp subtasks,
// then keeps only the ones whose Start Date or Due Date (straight off
// ClickUp -- the same "Roadmap" fields the Gantt tab reads) falls inside the
// current Monday-Sunday window. A subtask with neither date set can't be
// placed in a week at all, so it's left out rather than shown regardless --
// same reasoning as the Gantt tab excluding projects with no due date at
// all. Deliberately a live snapshot, not a week-over-week diff: the
// dashboard has no history/snapshot layer yet to compare against last week,
// so "weekly" here means "what a PM checks this week," not "what changed
// since last week." A true diff is a natural follow-up once there's
// somewhere to store last week's snapshot.
//
// Each project carries BOTH a flat `updates` list (its direct-child subtasks
// due/starting this week -- unchanged shape from before, still what "This
// week's load" on Resources and the status-filter pills read) AND a nested
// `tree` (parent -> child -> grandchild, to any depth ClickUp actually has).
// The tree is a true work-breakdown-structure view: built from ONE bulk
// fetch of the whole list including every subtask at every level
// (getListTasksWithSubtasks -- same technique already used in portfolio.js
// for the assignee rollup, and for the same reason: the per-task
// `include_subtasks` endpoint doesn't reliably carry full custom_fields on
// nested subtasks, so this reuses the Get Tasks (list) endpoint instead),
// then pruned so only branches with at least one this-week item survive --
// an ancestor is kept for structure even when its own dates aren't this
// week, but a sibling branch with nothing happening this week is dropped,
// so the WBS view stays scoped to "this week" rather than dumping a
// project's entire task history into one tab.
const MAX_TREE_DEPTH = 8; // guards against any unexpected parent cycle in the data

exports.handler = async () => {
  const jsonHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const token = process.env.CLICKUP_API_TOKEN;
  const listId = process.env.CLICKUP_LIST_ID;

  if (!token || !listId) {
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(mockWeekly) };
  }

  try {
    const cu = client(token);

    // Resolve assignees the same way every other assignee-aware view on this
    // dashboard does (Resources, the Decisions & Gaps editors), so both the
    // project-level fallback below AND the per-subtask resolution used for
    // the "This week's load" panel can attribute work to a real person
    // instead of just ClickUp's native assignee field. Only the member list
    // is needed here (not getListFields) -- customFieldAssignees()/
    // textFieldAssignees() read each field's type/options straight off the
    // task's own embedded custom_fields entry, not a separate list-level
    // field definition. Fetched once, not per-project.
    const members = await cu.getListMembers(listId).catch(() => []);
    const memberLookup = {};
    members.forEach((m) => { memberLookup[String(m.id)] = m.name; });
    const assigneeFieldName = fieldMapping.assignee;
    const assigneeTextFieldName = fieldMapping.assigneeTextFallback;

    // One bulk fetch of the whole list INCLUDING every subtask at every
    // depth, instead of one getListTasks() call plus one getSubtasks() call
    // per active project -- fewer requests, and it's what feeds the nested
    // tree below (getSubtasks only ever returns direct children).
    const allTasks = await cu.getListTasksWithSubtasks(listId);
    const projectTasks = allTasks.filter((t) => !t.parent);
    const byParent = new Map();
    allTasks.forEach((t) => {
      if (!t.parent) return;
      if (!byParent.has(t.parent)) byParent.set(t.parent, []);
      byParent.get(t.parent).push(t);
    });

    const summary = toPortfolioSummary(projectTasks, { assigneeFieldName, memberLookup, assigneeTextFieldName, members });
    // Same "active" definition as the Resources workload view: everything
    // that isn't wrapped up yet, not just the narrow "active" health bucket.
    const activeProjects = summary.projects.filter((p) => p.healthBucket !== "completed");
    const { start: weekStart, end: weekEnd } = currentWeekRange();
    const inThisWeek = (ms) => ms != null && ms >= weekStart && ms <= weekEnd;

    // Shared per-task mapping used for both the flat `updates` list and
    // every node of the nested `tree` -- so a subtask looks the same however
    // it's being displayed. `fallbackAssignees` is the project's own
    // assignee list, used only when this particular task has nobody set at
    // all, so a week-scoped item still counts against someone rather than
    // vanishing into "unassigned" purely because it wasn't re-tagged at the
    // subtask level.
    function mapNode(t, fallbackAssignees) {
      return {
        id: t.id,
        name: t.name,
        status: t.status?.status || null,
        statusType: t.status?.type || null,
        // ClickUp returns both as epoch-ms strings (or null).
        startDate: t.start_date ? Number(t.start_date) : null,
        dueDate: t.due_date ? Number(t.due_date) : null,
        assignees: (() => {
          const resolved = resolveTaskAssignees(t, assigneeFieldName, memberLookup, assigneeTextFieldName, members);
          return resolved.length > 0 ? resolved : fallbackAssignees || [];
        })(),
      };
    }

    function buildWeekTree(taskId, fallbackAssignees, depth) {
      if (depth > MAX_TREE_DEPTH) return [];
      const children = byParent.get(taskId) || [];
      return children.map((t) => {
        const node = mapNode(t, fallbackAssignees);
        node.inThisWeek = inThisWeek(node.startDate) || inThisWeek(node.dueDate);
        node.children = buildWeekTree(t.id, fallbackAssignees, depth + 1);
        node.hasWeekWork = node.inThisWeek || node.children.some((c) => c.hasWeekWork);
        return node;
      });
    }

    // Drops any branch with nothing happening this week, at any depth, but
    // keeps an ancestor whose own dates miss this week as long as one of its
    // descendants qualifies -- so the tree reads as "this week's slice of
    // the real structure," not just a flat filtered list wearing indentation.
    function pruneToWeekWork(nodes) {
      return nodes
        .filter((n) => n.hasWeekWork)
        .map((n) => ({ ...n, children: pruneToWeekWork(n.children) }));
    }

    // Diagnostics for the "why no specific tasks logged yet" question --
    // cheap to compute, never shown in the UI, but lets `curl /api/weekly`
    // (or a Netlify function log) show exactly where the pipeline came up
    // empty on real data instead of leaving it a silent mystery. Mirrors the
    // debug-field pattern already used by /api/portfolio's subtaskDiagnostics.
    let projectsWithOpenTasks = 0;
    let projectsWithZeroOpenTasks = 0;
    const projectErrors = [];
    let sampleOpenTask = null;
    let sampleDescendantCount = null;

    const withUpdates = activeProjects.map((p) => {
      const base = {
        id: p.id,
        name: p.name,
        url: p.url,
        healthBucket: p.healthBucket,
        gate: p.currentGate || p.gatePhase,
        progressPercent: p.progressPercent,
      };
      try {
        const directChildren = byParent.get(p.id) || [];
        // Limited to this week: either date landing inside Mon-Sun counts,
        // since a subtask that STARTS this week is just as relevant to
        // "what's moving this week" as one due this week. A subtask with
        // neither date set has no way to place it in a week, so it's
        // excluded rather than shown unconditionally.
        const updates = directChildren
          .map((t) => mapNode(t, p.assignees))
          .filter((u) => inThisWeek(u.startDate) || inThisWeek(u.dueDate));
        // Built once, used two ways: pruned down to "this week" for the tree
        // Weekly Activity renders, and flattened (unpruned, so every open
        // subtask regardless of date) for openTasks -- what Resources' board
        // by person reads to show a specific person's actual open items on
        // a project, not just that they're on it.
        const fullTree = buildWeekTree(p.id, p.assignees, 0);
        const tree = pruneToWeekWork(fullTree);
        const openTasks = flattenOpenTasks(fullTree);

        if (openTasks.length > 0) {
          projectsWithOpenTasks += 1;
          if (!sampleOpenTask) {
            sampleOpenTask = { project: p.name, ...openTasks[0] };
            sampleDescendantCount = (byParent.get(p.id) || []).length; // direct children only, just a sanity number
          }
        } else {
          projectsWithZeroOpenTasks += 1;
        }

        return { ...base, updates, tree, openTasks };
      } catch (err) {
        // Previously swallowed into `updatesError` with nothing logged
        // server-side -- if this throws for every project on real data,
        // that's exactly the "no specific tasks logged yet" bug, and it was
        // invisible in both the Netlify function log and the API response's
        // headline shape. Logging + collecting it here means a Netlify log
        // tail (or a `curl /api/weekly | jq .diagnostics`) shows the real
        // cause instead of a symptom.
        console.error(`weekly.js: openTasks pipeline failed for project "${p.name}" (${p.id}):`, err);
        projectErrors.push({ project: p.name, id: p.id, error: err.message });
        return { ...base, updates: [], tree: [], openTasks: [], updatesError: err.message };
      }
    });

    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        source: "clickup",
        generatedAt: new Date().toISOString(),
        totalActive: activeProjects.length,
        projects: withUpdates,
        diagnostics: {
          totalTasksFetched: allTasks.length,
          totalTasksWithParent: allTasks.filter((t) => !!t.parent).length,
          assigneeFieldName: assigneeFieldName || null,
          memberCount: members.length,
          projectsWithOpenTasks,
          projectsWithZeroOpenTasks,
          projectErrors,
          sampleOpenTask, // one real resolved openTasks[0], so its .assignees[].id shape is visible directly
          sampleDescendantCount,
        },
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: err.message, source: "clickup-error" }) };
  }
};
