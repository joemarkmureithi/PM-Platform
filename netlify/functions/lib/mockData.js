// Fallback data with the EXACT shape the real /portfolio endpoint returns,
// so the frontend never has to know whether it's looking at ClickUp or a
// preview. Used automatically when CLICKUP_API_TOKEN / CLICKUP_LIST_ID are
// not set. Field names mirror netlify/functions/lib/transform.js's toProject().
// Reuses computeGaps() from transform.js so the mock preview demonstrates the
// same data-quality flags real data would surface, instead of drifting out
// of sync with the real logic.

const { computeGaps, computeWorkload, riskSignal } = require("./transform");

const today = new Date();
function daysFromNow(n) {
  const d = new Date(today);
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

const amara = { id: "u1", name: "Amara O." };
const dan = { id: "u2", name: "Dan K." };
const priya = { id: "u3", name: "Priya N." };

const rawProjects = [
  { id: "1", name: "ECOA Char Black", healthBucket: "active", nativeStatus: "ongoing", currentGate: "Detailed Design", gatePhase: null, progressPercent: 55, product: "ECOA", productCategory: "Charcoal Stove", tooling: "Yes", riskStatus: "Mitigating", mitigationStrategy: "Second supplier qualified", targetGateDate: daysFromNow(9), startDate: daysFromNow(-90), createdDate: daysFromNow(-95), assignees: [amara], url: "#" },
  { id: "2", name: "Senegal Stove Pilot", healthBucket: "atRisk", nativeStatus: "ongoing", currentGate: "Preliminary Design", gatePhase: null, progressPercent: 40, product: "Senegal Stove", productCategory: "Wood Stove", tooling: "Yes", riskStatus: "Open", mitigationStrategy: null, targetGateDate: daysFromNow(3), startDate: daysFromNow(-60), createdDate: daysFromNow(-65), assignees: [dan], url: "#" },
  // No real Start Date set in ClickUp -- the Gantt tab falls back to
  // createdDate for this one (rendered dashed/"assumed"), same convention
  // as the hours chart's estimate fallback.
  { id: "3", name: "NCW Cost Reduction", healthBucket: "delayed", nativeStatus: "on hold", currentGate: "Launch", gatePhase: null, progressPercent: 78, product: "NCW Low Cost", productCategory: "Charcoal Stove", tooling: "Yes", riskStatus: "Open", mitigationStrategy: "Escalated to supplier QA", targetGateDate: daysFromNow(7), startDate: null, createdDate: daysFromNow(-120), assignees: [amara], url: "#" },
  { id: "4", name: "Ghana Charcoal Efficiency", healthBucket: "active", nativeStatus: "ongoing", currentGate: "Detailed Design", gatePhase: null, progressPercent: 60, product: "Ghana Charcoal", productCategory: "Charcoal Stove", tooling: "Yes", riskStatus: "Mitigated", mitigationStrategy: "Resolved", targetGateDate: daysFromNow(12), startDate: daysFromNow(-45), createdDate: daysFromNow(-50), assignees: [amara, priya], url: "#" },
  { id: "5", name: "Kenya Biomass Retrofit", healthBucket: "completed", nativeStatus: "complete", currentGate: "Post Launch Improvements", gatePhase: null, progressPercent: 100, product: "Kenya Biomass", productCategory: "Wood Stove", tooling: "Yes", riskStatus: "Closed", mitigationStrategy: null, targetGateDate: daysFromNow(-40), startDate: daysFromNow(-200), createdDate: daysFromNow(-210), assignees: [dan], url: "#" },
  { id: "6", name: "Uganda Fuel Efficiency v2", healthBucket: "active", nativeStatus: "ongoing", currentGate: "Scoping & Feasibility", gatePhase: null, progressPercent: 15, product: "Uganda v2", productCategory: "Wood Stove", tooling: "No", riskStatus: "Mitigating", mitigationStrategy: "Lab test scheduled", targetGateDate: daysFromNow(21), startDate: null, createdDate: daysFromNow(-30), assignees: [priya], url: "#" },
  { id: "7", name: "MMX SS NCW", healthBucket: "active", nativeStatus: "ongoing", currentGate: "Preliminary Design", gatePhase: null, progressPercent: 48, product: "MMX SS NCW", productCategory: "Cookware", tooling: "Yes", riskStatus: "Mitigated", mitigationStrategy: "Resolved", targetGateDate: daysFromNow(18), startDate: daysFromNow(-75), createdDate: daysFromNow(-80), assignees: [amara], url: "#" },
  { id: "8", name: "Big Mouth Pan", healthBucket: "completed", nativeStatus: "complete", currentGate: "Post Launch Improvements", gatePhase: null, progressPercent: 100, product: "Big Mouth", productCategory: "Cookware", tooling: "Yes", riskStatus: "Closed", mitigationStrategy: null, targetGateDate: daysFromNow(-60), startDate: daysFromNow(-150), createdDate: daysFromNow(-155), assignees: [priya], url: "#" },
  // Deliberately messy rows -- these demonstrate the "Decisions & Data Gaps" tab.
  // #9 has no due date at all, so it's also a good test case for the Gantt
  // tab's "can't plot without a due date" exclusion note.
  { id: "9", name: "Review Sahel packaging artwork", healthBucket: "active", nativeStatus: "to do", currentGate: null, gatePhase: null, progressPercent: null, product: null, productCategory: null, tooling: null, riskStatus: null, mitigationStrategy: null, targetGateDate: null, startDate: null, createdDate: daysFromNow(-5), assignees: [], url: "#" },
  { id: "10", name: "Draft box artwork design", healthBucket: "active", nativeStatus: "ongoing", currentGate: null, gatePhase: null, progressPercent: 0, product: null, productCategory: null, tooling: null, riskStatus: null, mitigationStrategy: null, targetGateDate: daysFromNow(2), startDate: null, createdDate: daysFromNow(-10), assignees: [], url: "#" },
];

const projects = rawProjects.map((p) => {
  const withGaps = { ...p, gaps: computeGaps(p) };
  withGaps.risk = riskSignal(withGaps);
  return withGaps;
});

const counts = projects.reduce(
  (acc, p) => ({ ...acc, [p.healthBucket]: (acc[p.healthBucket] || 0) + 1 }),
  { active: 0, delayed: 0, atRisk: 0, completed: 0, total: projects.length }
);

const upcomingGates = projects
  .filter((p) => p.targetGateDate && Date.parse(p.targetGateDate) >= Date.now() - 1000 * 60 * 60 * 24)
  .sort((a, b) => Date.parse(a.targetGateDate) - Date.parse(b.targetGateDate))
  .map((p) => ({ project: p.name, gate: p.currentGate || p.gatePhase, date: p.targetGateDate }));

function tally(items, keyFn) {
  const out = {};
  items.forEach((item) => {
    const key = keyFn(item) || "Unclassified";
    out[key] = (out[key] || 0) + 1;
  });
  return out;
}

const byCategory = tally(projects, (p) => p.productCategory);
const byGate = tally(projects, (p) => p.currentGate || p.gatePhase);

const flagged = projects.filter((p) => p.gaps.length > 0).map((p) => ({ id: p.id, name: p.name, url: p.url, gaps: p.gaps }));
const gapTotals = {};
flagged.forEach((f) => f.gaps.forEach((g) => { gapTotals[g.code] = (gapTotals[g.code] || 0) + 1; }));

const risks = projects
  .filter((p) => p.risk)
  .map((p) => ({
    id: p.id,
    name: p.name,
    url: p.url,
    reason: p.risk.reason,
    source: p.risk.source,
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

module.exports = {
  source: "mock",
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
