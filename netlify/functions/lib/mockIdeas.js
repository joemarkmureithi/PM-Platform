// Fallback data for the "New Idea" intake tab, used when
// CLICKUP_INTAKE_LIST_ID / CLICKUP_API_TOKEN aren't set yet. Same shape the
// real /api/ideas endpoint returns (see ideas.js toIdeaSummary()).

const now = Date.now();
function daysAgo(n) {
  return new Date(now - n * 24 * 60 * 60 * 1000).toISOString();
}

module.exports = [
  {
    id: "mock-idea-1",
    name: "Modular lid clip redesign",
    description:
      "Product / Model: ECOA Char Black\nProduct Category: Charcoal Stove\n\nField reports show the lid clip detaching after repeated cycles -- worth a quick redesign spike before the next production run.",
    dueDate: null,
    createdAt: daysAgo(2),
    url: "#",
  },
  {
    id: "mock-idea-2",
    name: "Solar-assisted ignition attachment",
    description:
      "Product / Model: Senegal Stove\nProduct Category: Wood Stove\n\nExploring a clip-on solar ignition assist for faster light-up during the damp season -- needs a feasibility pass.",
    dueDate: null,
    createdAt: daysAgo(6),
    url: "#",
  },
];
