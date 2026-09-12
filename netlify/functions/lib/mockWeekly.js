// Mock payload for the Weekly Activity tab -- same shape /api/weekly returns
// for live data, built from mockData's existing projects so preview mode
// demonstrates the real layout (active projects + their subtasks-as-updates)
// without needing a ClickUp connection.

const { currentWeekRange, flattenOpenTasks } = require("./transform");
const mockData = require("./mockData");

const activeProjects = mockData.projects.filter((p) => p.healthBucket !== "completed");
const amara = { id: "u1", name: "Amara O." };
const dan = { id: "u2", name: "Dan K." };
const priya = { id: "u3", name: "Priya N." };

// A couple of projects get sample subtasks so the "updates" list has
// something to show; the rest deliberately show the empty state, since
// that's a real possibility with live data too (a project with no subtasks
// logged yet in ClickUp). Deliberately mixes items inside vs. outside the
// current week (and one with no date at all) so preview mode demonstrates
// the same "limited to this week" filtering /api/weekly applies to real
// data, rather than just always showing everything.
const inDays = (n) => Date.now() + n * 86400000;

const SAMPLE_UPDATES = {
  1: [
    { id: "s1", name: "Finalize black-coating supplier trial", status: "in progress", statusType: "custom", startDate: null, dueDate: inDays(2), assignees: [amara] }, // this week
    { id: "s2", name: "Submit updated BOM", status: "complete", statusType: "done", startDate: null, dueDate: inDays(-1), assignees: [amara] }, // this week
  ],
  2: [
    // Due date falls outside this week, but it STARTED this week -- still
    // shown, since either date landing in the current week counts.
    { id: "s3", name: "Field test unit #4 — Dakar", status: "in progress", statusType: "custom", startDate: inDays(1), dueDate: inDays(9), assignees: [dan] },
    // No date at all -- can't be placed in a week, so filtered out, same as
    // real data would be.
    { id: "s4", name: "Collect week-2 usage log", status: "to do", statusType: "open", startDate: null, dueDate: null, assignees: [dan] },
  ],
  6: [
    // Both dates land well outside this week -- filtered out, demonstrating
    // that "active project" alone doesn't guarantee its subtasks show here.
    { id: "s5", name: "Lab efficiency retest", status: "to do", statusType: "open", startDate: inDays(8), dueDate: inDays(10), assignees: [priya] },
  ],
  4: [
    { id: "s6", name: "Confirm tooling supplier quote", status: "in progress", statusType: "custom", startDate: inDays(-1), dueDate: inDays(3), assignees: [priya] }, // this week
  ],
};

const { start: weekStart, end: weekEnd } = currentWeekRange();
const inThisWeek = (ms) => ms != null && ms >= weekStart && ms <= weekEnd;

// Builds one tree node the same way /api/weekly's real buildWeekTree() does
// (inThisWeek/hasWeekWork computed, not hand-set), so preview mode exercises
// the exact same rendering the live nested WBS tree does -- including a
// parent kept for structure even though its own dates miss this week,
// solely because one of its children qualifies.
function node(id, name, status, statusType, startDate, dueDate, assignees, children = []) {
  const n = {
    id,
    name,
    status,
    statusType,
    startDate,
    dueDate,
    assignees,
    children,
  };
  n.inThisWeek = inThisWeek(n.startDate) || inThisWeek(n.dueDate);
  n.hasWeekWork = n.inThisWeek || n.children.some((c) => c.hasWeekWork);
  return n;
}

// A couple of projects get a real parent -> child -> grandchild sample so
// preview mode can demonstrate the work-breakdown-structure tree, not just
// a flat "updates" list -- e.g. a "Box Development" task with its own
// sub-steps, one of which (Artwork) has a grandchild of its own.
const SAMPLE_TREE = {
  1: [
    node("t1", "Box Development", "in progress", "custom", null, null, [amara], [
      node("s1", "Finalize black-coating supplier trial", "in progress", "custom", null, inDays(2), [amara]),
      node("t1a", "Artwork", "in progress", "custom", null, inDays(20), [amara], [
        node("s2", "Submit updated BOM", "complete", "done", null, inDays(-1), [amara]),
      ]),
    ]),
  ],
  2: [
    node("t2", "Field Validation", "in progress", "custom", null, null, [dan], [
      node("s3", "Field test unit #4 — Dakar", "in progress", "custom", inDays(1), inDays(9), [dan]),
      node("s4", "Collect week-2 usage log", "to do", "open", null, null, [dan]),
    ]),
  ],
  4: [
    node("t6", "Tooling readiness", "in progress", "custom", null, null, [priya, amara], [
      node("s6", "Confirm tooling supplier quote", "in progress", "custom", inDays(-1), inDays(3), [priya]),
      node("s7", "Sign off on fixture drawings", "to do", "open", null, inDays(12), [amara]),
    ]),
  ],
  6: [
    node("t7", "Lab validation", "to do", "open", null, null, [priya], [
      node("s5", "Lab efficiency retest", "to do", "open", inDays(8), inDays(10), [priya]),
    ]),
  ],
};

function pruneToWeekWork(nodes) {
  return nodes
    .filter((n) => n.hasWeekWork)
    .map((n) => ({ ...n, children: pruneToWeekWork(n.children) }));
}

module.exports = {
  source: "mock",
  generatedAt: new Date().toISOString(),
  totalActive: activeProjects.length,
  projects: activeProjects.map((p) => ({
    id: p.id,
    name: p.name,
    url: p.url,
    healthBucket: p.healthBucket,
    gate: p.currentGate || p.gatePhase,
    progressPercent: p.progressPercent,
    updates: (SAMPLE_UPDATES[p.id] || []).filter((u) => inThisWeek(u.startDate) || inThisWeek(u.dueDate)),
    tree: pruneToWeekWork(SAMPLE_TREE[p.id] || []),
    openTasks: flattenOpenTasks(SAMPLE_TREE[p.id] || []),
  })),
};
