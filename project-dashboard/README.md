# PM Intelligence Platform — Portfolio Overview (MVP)

ClickUp is the single source of truth. This repo is the first slice of the full
platform: a live Portfolio Overview dashboard, deployable to Netlify, backed
by a Netlify Function that reads ClickUp and falls back to mock data when
ClickUp isn't configured yet.

## How it's wired

```
ClickUp API
     │
     ▼
netlify/functions/portfolio.js   ← serverless function, reads CLICKUP_API_TOKEN
     │                              + CLICKUP_LIST_ID from environment vars
     ▼
public/index.html + js/dashboard.js   ← fetches /api/portfolio, renders KPIs,
                                         timeline, upcoming gates
```

No database yet — this MVP reads ClickUp live on every request. (We'll add a
lightweight cache/history layer once we're ready for trend charts across the
other dashboards.) The whole dashboard also re-fetches in the background
every **2 minutes** (`setInterval(load, 120000)` in `public/js/dashboard.js`)
so it stays current without a manual refresh; the **Refresh** button in the
header still triggers an immediate one on demand.

**The tab bar itself can be dragged into any order** — click and hold a tab,
drag it left or right, drop it where you want it (`applyTabOrder()` /
`wireTabDragReorder()` in `dashboard.js`, same plain HTML5 drag-and-drop the
Tooling tab's row reordering uses — see section 14). Useful if you walk
through the tabs in a specific order for a recurring review and want that to
just be the order they're already in. Saved per browser in `localStorage`
(`pm-dashboard-tab-order`), same local-only reasoning as everything else
customizable on this page — not synced or shared with anyone else looking at
the same dashboard.

## 1. Generate a ClickUp API token

1. Log into ClickUp in your browser.
2. Click your avatar in the bottom-left corner → **Settings**.
3. In the settings sidebar, click **Apps**.
4. Under **API Token**, click **Generate** (or **Regenerate** if one already exists).
5. Copy the token — it starts with `pk_`. Treat it like a password: don't
   commit it, don't paste it into ClickUp tasks/comments, etc.

## 2. Find your List ID

Every project in the portfolio should live as a task in one ClickUp List.
Once you have a token:

```bash
npm install
CLICKUP_API_TOKEN=pk_your_token_here npm run discover
```

This prints your whole workspace tree (Team → Space → Folder → List) with IDs.
Copy the ID of the List that holds your portfolio's project tasks.

## 3. Custom fields — what already exists vs. what to add

Discovered directly from your Biomass > Active list (23 project tasks) via
the ClickUp API on 2026-08-21. Most of what the dashboard needs is already
there:

| Dashboard needs | ClickUp field | Status |
|---|---|---|
| Current gate | **Stage Gate** (Concept → Feasibility → Development → Testing → Launch → Post-Launch) | ✅ exists |
| Progress % | **Progress** (native percent-complete) | ✅ exists |
| Gate/milestone due date | native task **Due Date** | ✅ exists (not a custom field) |
| Risk info (feeds the Risks tab — see section 6b) | **Risk Status**, **Risk Score**, **Probability**, **💣 Impact**, **Mitigation Strategy** | ✅ exist |
| Product / category (for filtering) | **Product**, **Product Category**, **Business Unit** | ✅ exist |
| Portfolio health bucket (Active/Delayed/At Risk/Completed) | **Project Health** | ❌ doesn't exist yet |

Only one field is missing for the Portfolio Overview MVP. Until it's added,
`bucketHealth()` in `netlify/functions/lib/transform.js` falls back to a
best-effort guess from the task's native status + Risk Status, so the
dashboard works today — it just gets more accurate once PMs start setting
the real field.

**To add it:** open the Active list in ClickUp, scroll to the end of the
column headers, click **+** to add a field, name it `Project Health`, set
type **Dropdown**, and add four options: `Active`, `Delayed`, `At Risk`,
`Completed`. Then set it on each of the 23 tasks (worth doing as a batch
during your next portfolio review, rather than all at once).

If your real field names differ from the table above, edit
`config/fieldMapping.json` — nothing else in the code needs to change.

## 4. Run it locally

**Important: don't double-click `public/index.html`.** It's not a static
page — it fetches live data from a small server piece, so opening it
directly as a file gives you "Error loading data" with nothing else on
screen. You need something serving it over `http://localhost`.

**Easiest option — no installs beyond Node.js itself:**

```bash
# Windows PowerShell / Mac / Linux, from inside the project-dashboard folder
copy .env.example .env      # Mac/Linux: cp .env.example .env
# edit .env in a text editor, filling in your real CLICKUP_API_TOKEN and CLICKUP_LIST_ID
node scripts/preview-server.js
```

It prints a URL (e.g. `http://localhost:8877`) — open THAT in your browser,
not the HTML file on disk. This script only uses Node's built-ins, so no
`npm install` is required for this step. Leave `.env` missing/empty and it
falls back to realistic mock data automatically — handy for checking layout
changes without hitting the real API.

**One exception:** the Weekly Activity tab's "Download slides (.pptx)" button
(section 11b) is served by a function that uses `pptxgenjs` to build a real
PowerPoint file — the one dependency this project has. Run `npm install`
once (in this same folder) before using that button; everything else,
including the rest of the dashboard and the "Download summary (HTML)"
button next to it, works with zero installs as described above, and that
one button just shows an error until you've installed it.

**Production-parity option** (matches Netlify's actual runtime more closely,
useful right before deploying):

```bash
npm install
npx netlify dev
```

## 5. Deploy to Netlify (you keep control of the account)

1. Push this repo to GitHub (or GitLab/Bitbucket).
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
   Build settings are already defined in `netlify.toml` (publish = `public`,
   functions = `netlify/functions`) — no build command needed.
3. In **Site settings → Environment variables**, add:
   - `CLICKUP_API_TOKEN` = your token
   - `CLICKUP_LIST_ID` = your list ID
   - `CLICKUP_INTAKE_LIST_ID` = your intake list ID (see section 7) — optional,
     but the "Idea Dumps" tab runs in preview-only mode without it
   - `CLICKUP_RISK_LIST_ID`, `CLICKUP_ISSUE_LIST_ID`, `CLICKUP_LESSON_LIST_ID`
     = your three register list IDs (see section 6d) — same deal, each
     optional, each register runs in preview-only mode without its own ID
4. Deploy. Your token never touches the git repo — it only lives in Netlify's
   environment variable store and your local `.env` (gitignored).

## 6. By Category / By Stage Gate, Portfolio Mix charts, Decisions & Gaps

Grouped views are top-level tabs now (**Category**, **Stage Gate** — the nav
labels drop the "By" prefix each used to carry, since the tab bar reads
cleaner without it repeated on every grouped view), not a dropdown buried in
the Projects tab — each renders the same
Kanban-style board, scoped to whatever the VIEWING and DUE WITHIN context bar
is currently set to. This mirrors how you already group things in ClickUp's
own Product Category and Stage Gate Pipeline boards, but without the
sub-task granularity. The Projects tab itself is back to being a plain,
sortable/searchable table.

**"By Health" was removed as its own tab** (it duplicated the Overview KPI
tiles' health filter and the Project Register's own Health column filter —
click a KPI tile, or use the register's Health filter, to get the same
grouping without a dedicated Kanban board for it).

The **Calendar** view now lives inside the **Decisions & Gaps** tab (merged
in, rather than being its own top-level nav item) — the two are closely
related (both are "what needs a PM's attention this month"), so Decisions &
Gaps opens with the gap list, then the calendar grid right below it, with
its own Prev/Next/Today controls. It follows the VIEWING selector (so
scoping to one project shows just that project's date) but deliberately
ignores the DUE WITHIN pills, since browsing month-to-month is the point of
a calendar. Projects with no due date can't appear on it — they're called
out in a note below the grid. Every **Thursday** is highlighted (an "NPD"
badge plus a tinted cell, in both the weekday header and every cell that
falls on one) since that's the weekly NPD meeting day. It's a pure
date-of-week highlight, not a second data source — if a different day
becomes the meeting day, change the one `=== 4` check (`getDay()`'s
Thursday) in `renderCalendar()` in `public/js/dashboard.js`.

**"Needs a decision" no longer duplicates itself.** The agenda list above
the grid used to be scoped to every project in the current VIEWING context,
including ones with no due date at all — so a project like "Review Sahel
packaging artwork" (no target date, so it can never appear on any calendar
month) still showed up in "Needs a decision," identical to entries already
listed in the gap chips above it. It's now scoped to only the projects that
are genuinely plotted on the visible month's grid (`byDay` is computed
first in `renderCalendar()`, and that's what gets passed to
`renderCalendarAgenda()`), so a date-less project can no longer duplicate
itself between the two panels.

**Highlighting isn't limited to Thursday either.** Any day whose
Monday–Sunday week contains a project that still needs a decision gets a
dashed amber border and an amber dot next to its day number — hovering that
day (or any other day in the same week) shows a native tooltip naming
exactly which project(s) and why, aggregated across the whole week rather
than just the one day a date happens to fall on (`weekRangeFor()`/
`weekAgendaText()` in `renderCalendar()`). Thursday's own NPD badge is
unchanged and can still combine with this on the same cell.

The **By Stage Gate** board collapses "Project Kickoff" and "Scoping &
Feasibility" into a single column ("Kickoff & Scoping/Feasibility") to cut
down on horizontal scrolling — those two early stages tend to be short-lived
enough that giving each its own column wasn't earning its keep. This merge
is local to that one Kanban view (`groupKeyFor()`/`GATE_COLUMN_ORDER` in
`public/js/dashboard.js`); the Overview gate bar chart, the project detail
stage bar, and Upcoming Gates all still use the real six-stage
`GATE_ORDER` untouched.

The flat **Projects** table's Stage Gate column now falls back to
`p.gatePhase` when `p.currentGate` isn't set, matching every other view
(`groupKeyFor`, the project detail stage bar) — it used to show "—" for a
project even when the By Stage Gate board correctly grouped that same
project, because only the table was missing the fallback. A project that
still shows "—" genuinely has neither field set in ClickUp — see
Decisions & Gaps' "No stage gate set" gap.

The "SMT View" placeholder tab was removed — it wasn't built yet and just
added clutter to the tab bar; add it back the same way as the tabs above
once there's a real view to ship. **Risks** and **Gantt** used to be
placeholders in that same list — both are now real tabs (see 6b below and
section 8).

The Overview tab's **Portfolio Mix** panel adds a health donut and a
stage-gate bar chart for a quick-glance read.

The **Decisions & Gaps** tab is new: it flags projects with planning gaps a
PM should look at — no product category, no stage gate, no target/due date,
an open risk with no mitigation plan, or a project marked "ongoing" with 0%
progress logged. This is computed in `computeGaps()` in
`netlify/functions/lib/transform.js` — tune the rules there if your team's
definition of "needs attention" differs.

### 6a. Overview KPI row — Total / Needs Intervention / No Owner / Open Gaps

The Overview tab's KPI row now has 8 tiles instead of 4. The original four
(Active / Delayed / At Risk / Completed) are unchanged — they're still
mutually exclusive health buckets, they still feed the Portfolio Mix donut,
and clicking one still filters the Project Register to that health bucket.
Four more were added alongside them, each a cross-cutting count that
doesn't fit that same donut (a project can be both "active" and "flagged as
a risk" at once, so these aren't additional pie slices, they're a different
question):

- **Total Projects** — a plain count, not clickable.
- **Needs Intervention** — the same count as the Risk Register's "Total at
  risk" tile (see 6b). Click it to jump straight to the Risks tab.
- **No Owner** — projects with nobody assigned. Click it to jump to the
  Project Register filtered to unassigned projects (same effect as picking
  "Unassigned" in the register's own Owner filter — see 6c).
- **Open Gaps** — the same count as the Decisions & Gaps badge. Click it to
  jump to that tab.

All of this is built in `renderKpis()` in `public/js/dashboard.js`.

**A note on the Overview tab's Timeline bar:** its date window is a **fixed
rolling window from "now"** — 30 days back, 90 days forward
(`WINDOW_DAYS_BACK` / `WINDOW_DAYS_FWD` in `dashboard.js`), recomputed every
time the page loads. It is not derived from your projects' own dates, so it
always spans "about a month ago" to "about three months from now" regardless
of what's actually due — that's why it can look like it stretches
surprisingly far into the future (or past) depending on the day you load it.
If you'd rather it hugged your actual portfolio's earliest/latest relevant
dates instead of a fixed window, that's a small, well-contained change to
those two constants plus the function that reads them.

### 6b. Live Risk Signals — auto-detected risk, not just self-reported

The **Risks & Issues** tab (renamed from "Risks" once the three logbook
registers below were added to it, to reflect everything it now covers) opens
with a "Live Risk Signals" panel that answers one question: which projects
need intervention right now, and why? It has a small KPI row, a horizontal
bar chart of at-risk projects by health status, and a table (project,
reason, health, owner(s), stage gate, due date, whether a mitigation plan
already exists). Nothing here is manually logged — see 6d below for that.

The important part is **how "at risk" gets decided** — this is
`riskSignal()` in `netlify/functions/lib/transform.js`, and it does not
wait for someone to manually flag a project in ClickUp:

- Any non-completed project whose ClickUp **Risk Status** is "Open" is
  flagged (`source: "flagged"`).
- Any non-completed project explicitly marked **At Risk** by
  `bucketHealth()` (its own Project Health field, or an unresolved open
  risk) is flagged the same way.
- **Any non-completed project that has simply fallen behind schedule — past
  its target/due date and not yet closed out — is flagged too**
  (`source: "schedule"`), even if nobody has touched the Risk Status field
  in ClickUp at all. This is the rule that was explicitly requested: risk
  shouldn't depend on a PM remembering to tag it — a project that's overdue
  and still open is, by definition, something that needs a look.
- Completed projects are never flagged, regardless of any of the above.
- Every flagged project also carries `needsMitigation` — true whenever it
  has no mitigation plan text yet — shown in the table as a "Needs plan" /
  "Has plan" chip, and rolled up into its own KPI tile.

If a project matches more than one rule (e.g. it's both flagged in ClickUp
*and* overdue), the explicit ClickUp flag wins for the `reason` text shown,
since a PM who already tagged it deserves to see their own words rather
than the auto-derived one — but either condition alone is enough to appear
in this list.

**A fourth signal is computed in the browser, not in ClickUp:** a project
whose next stage gate is within **14 days** while its stage-gate checklist
(see section 13) still isn't 100% checked off gets flagged too, with a
reason like `Detailed Design gate 9d away, checklist 0/17 complete`. This
one can't live in `riskSignal()` on the backend, because the checklist
itself is saved only in this browser's `localStorage` — ClickUp has no way
to know how close to "done" a project's checklist actually is. It's
computed in `dashboard.js` (`checklistGateRiskFor()` /
`mergeChecklistRisks()`) and merged into the same list at render time: a
project ClickUp already flagged gets this reason appended to its existing
row rather than a duplicate one, while a project not otherwise flagged gets
a new row of its own. Its own KPI tile ("Gate nearing, checklist incomplete
(auto)") counts every project this signal catches, whether or not it got
its own row.

### 6c. Project Register — the redesigned Projects tab

The **Projects** tab (now titled **Project Register** in the panel itself)
replaced its single search box + one dropdown with a filterable column
header: a group-header row (Identification / Ownership / Status & Health /
Progress / Schedule), the real sortable column labels underneath it, and a
row of per-column filter dropdowns below that — Category, Owner (including
an "Unassigned" option), Stage Gate, Health, and Risk ("Needs intervention"
vs. everything else). Every filter combines with every other one (and with
the free-text search box and the global VIEWING / DUE WITHIN context bar
above the tab), so you can, for example, filter to one person's overdue,
at-risk cookware projects all at once.

The table itself grew two columns: **Owner** (every assignee, comma
joined; "Unassigned" when nobody's on it) and **Risk** (the same reason
text `riskSignal()` computes for the Risks tab, shown as a chip and colored
the same way when it still needs a mitigation plan — "—" for anything not
currently at risk).

**Every date shown anywhere now includes the year** (`fmtDate()` in
`dashboard.js`, shared by this Schedule column and every other date on the
dashboard — Gantt, Checklists' milestone line, Tooling/Lab, Upcoming Gates).
A bare "17 Aug" was ambiguous once a project's own schedule spans a year
boundary, which this portfolio's planning horizon genuinely does.

A single **Clear filters** button clears every one of the register's own
filters (Category, Owner, Stage Gate, Health, Risk) in one click — search
text and the global VIEWING/DUE WITHIN context are left alone, since those
live above the panel and aren't part of "this table's filters." Clicking an
Overview KPI tile still works the same way it always has: it jumps to this
tab and applies the matching filter, clearing whichever of the register's
own filters would otherwise conflict with it.

### 6d. Risk Register / Issues Register / Lessons Learnt Register — populatable logbooks

The Risks & Issues tab is arranged behind a small segmented control at the
top of the tab (**Live Risk Signals** / **Risk Register** / **Issues
Register** / **Lessons Learnt**, `setupSubtabs()` in `public/js/dashboard.js`,
CSS in the "sub-nav" block of `style.css`) instead of nine panels stacked in
one long scroll — pick one and only its panels show. This is the first tab
to use that pattern; it's generic enough (`.subnav` / `[data-subtab-panel]`)
to reuse on any other tab that outgrows a flat vertical stack.

Each of the three logbook forms is backed by its **own dedicated ClickUp
list** (same pattern as the Idea Dumps intake list in section 7 — kept apart
from `CLICKUP_LIST_ID` and from each other, so logging one never touches
your Active portfolio counts):

- **Risk Register** — title, project/product, likelihood, impact,
  mitigation plan, owner, review-by date, description.
- **Issues Register** — title, project/product, severity, owner, resolve-by
  date, description.
- **Lessons Learnt Register** — title, project/product, category (What went
  well / What went wrong / Recommendation), owner, description.

All three are served by one shared function
(`netlify/functions/registers.js`, `/api/registers?type=risk|issue|lesson`)
so the same read/write/preview-fallback logic isn't tripled across three
files — only the field list and target ClickUp list differ per type (see
`REGISTER_TYPES` in that file). As with Idea Dumps, no attempt is made to
map fields onto ClickUp custom fields on these lists (field IDs are
list-specific and unverifiable without live access) — every submitted value
is written into the task's description as labeled text instead, so nothing
submitted is ever silently dropped.

**To set them up:** create three new lists in ClickUp (e.g. **Risk
Register**, **Issues Register**, **Lessons Learnt Register**), find each
List ID the same way as `CLICKUP_LIST_ID`, and add `CLICKUP_RISK_LIST_ID`,
`CLICKUP_ISSUE_LIST_ID`, `CLICKUP_LESSON_LIST_ID` to `.env` (and to Netlify's
environment variables once you deploy). Each one is independent — set only
the ones you want live; any left unset just runs that one register in
preview-only mode (the form still works, but submissions aren't saved, and
it tells you so after each submit).

**Preview mode ships with genuinely empty registers**
(`netlify/functions/lib/mockRegisters.js` exports `{ risk: [], issue: [],
lesson: [] }`) rather than one fabricated sample entry per type. An earlier
version shipped a sample risk/issue/lesson so preview mode had something to
show, but that meant a fake entry (e.g. a made-up supplier risk) could still
appear even while the rest of the dashboard was reading real ClickUp data —
any of the three list IDs above left unset falls back to this same mock
regardless of whether `CLICKUP_LIST_ID` itself is live. Preview mode now
shows the real "nothing logged yet" empty state instead, exactly as a
freshly created ClickUp list would, so nothing here is ever mistaken for an
actual risk, issue, or lesson.

## 7. "Idea Dumps" intake tab

The Idea Dumps tab (originally "New Idea" — renamed once the nav bar grew
several other logbook-style tabs, to keep naming consistent) lets anyone
dump a project idea (title, product/model, category, description, optional
target date) straight into ClickUp, kept in its **own dedicated list** —
separate from `CLICKUP_LIST_ID` — so a raw idea never skews your Active
portfolio's counts or charts. Once vetted, move the task from the intake
list into Active yourself in ClickUp.

**To set it up:**

1. In ClickUp, create a new list for intake (e.g. inside the same Biomass
   folder, name it something like **Ideas / Intake**).
2. Find its List ID the same way you found `CLICKUP_LIST_ID` — call
   `GET /space/{space_id}/folder` (or `/folder/{folder_id}/list`) with your
   token and look for the new list's `id` in the response.
3. Add `CLICKUP_INTAKE_LIST_ID=<that id>` to your `.env` (and to Netlify's
   environment variables once you deploy).

Until that's set, the tab still works end-to-end for testing — submissions
just aren't saved anywhere, and the form tells you so after each submit.

Note on custom fields: submissions don't try to map Product/Category onto
ClickUp dropdown fields on the intake list, since those field IDs are
list-specific and would need to be verified against your real list to wire
up correctly. Instead every submitted value is written into the task's
description as labeled text, so nothing is lost — the task is still fully
readable and searchable in ClickUp. If you'd like real dropdown fields
populated instead, add matching custom fields to the intake list and share
their names/IDs and we can wire that up as a follow-up.

## 8. "Gantt" tab — start-to-due timeline, shaded by quarter

The Gantt tab replaced the earlier "Projects Update" AI-narrative tab (that
one drafted free-text deck sections from ClickUp data — useful, but a
separate concern from visualizing the schedule, and this was a more
frequently requested view). Everything that tab needed
(`generate-update.js`, `anthropicClient.js`, `mockNarrative.js`,
`stageMapping.js`, the `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` env vars) has
been removed — if you still want that narrative-drafting workflow, it's
recoverable from git history.

This tab plots every project with a due date as a horizontal bar from its
start date to that due date, all against one shared timeline — the same
idea as ClickUp's own Gantt view, but with things added because this
business specifically plans in quarters: **alternating quarter shading**
behind the whole chart (every other quarter gets a subtly tinted band, both
in the header and behind the bars, so it's easy to tell at a glance which
quarter a bar's start/end falls in), a second header row underneath the
quarters showing the **month and year** for finer-grained reading without
losing the quarter context, and a vertical **today line** so what's
upcoming vs. already past is obvious without reading dates. It follows the
VIEWING and DUE WITHIN context bar, same as Decisions & Gaps/the grouped
boards.

**Where "start" comes from — a 3-tier fallback, not just Start Date or
creation date.** The first version of this tab fell straight back to the
project task's own **creation date** whenever ClickUp's native Start Date
field wasn't set on it — but on lists that were bulk-imported into ClickUp
on a single day, every project's creation date clusters on that one day,
often landing *after* the project's real due date and collapsing its bar to
a sliver. `ganttStartInfo()` in `netlify/functions/lib/transform.js` fixes
this with a roll-up, same idea as the Resources tab's hours roll-up (section
9): (1) the earliest real Start Date anywhere in the project's own task or
any of its subtasks, at any depth; (2) if none exists anywhere, the earliest
**due date among the project's subtasks** (never the project's own due
date, which is the bar's end) — since a project usually has real subtask
due dates spread across its actual timeline even when nobody's filled in
Start Date yet; (3) true last resort, the project task's own creation date.
Rendering stays the same two-way distinction as before: a solid bar is a
real Start Date (tier 1); a dashed bar (in the health color, not filled) is
either fallback (tier 2 or 3) — explained in the tab's own caption. Hover
any bar for the exact dates, health, and progress.

Each bar is colored by the project's health bucket (the same
active/delayed/at-risk/completed colors used everywhere else in this
dashboard, via `.gantt-bar.<healthBucket>` in `style.css`), and the number
inside it is the project's progress percent. A project with no due date at
all can't be plotted (there's nothing to draw a bar to) — the tab counts
these below the chart and points you at Decisions & Gaps.

**To get real Start Dates showing up as solid bars:** fill in ClickUp's
native Start Date field (next to Due Date on each task) for whichever
projects matter most — no new custom field or setup needed, this reads a
field ClickUp already has.

## 9. "Resources" tab — workload by person

**Resources now sits right after Weekly Activity in the nav bar** (it used
to come later, after the two grouped Kanban views) — the two are closely
related now that Resources also reads Weekly Activity's own data (see 9b),
so they sit next to each other in the tab order.

This groups every non-completed project by owner. Ownership on this list
actually comes from three places, checked and merged together: ClickUp's
native **assignee** field, a custom field (mapped as `"assignee"` in
`config/fieldMapping.json` — `"Assigned To (Multi)"`), and, when a
project's own task has neither, a roll-up of whoever's assigned anywhere
among that project's subtasks — at ANY depth, not just direct children
(e.g. project → "Box Development" → "Artwork" all roll up to the project).
Each card shows a person's active/delayed/at-risk count and their project
list; "Unassigned" collects anything with nobody set as owner anywhere, and
a new **"No owner assigned"** gap now also shows up in Decisions & Gaps for
the same reason. A card gets a highlighted left border once someone is
carrying 5+ live projects — tune that threshold in `workloadCardHtml()` in
`dashboard.js` if 5 isn't the right line for your team.

The subtask roll-up fetches the whole list including subtasks in one call
(`getListTasksWithSubtasks()` in `netlify/functions/lib/clickupClient.js`),
not one call per project. An earlier version called `getSubtasks()`
per-project (the same helper Weekly Activity uses), which turned out to
silently under-count: a live screenshot (2026-09-11) showed subtask owners
in ClickUp it never picked up, pointing at Get Task's `include_subtasks`
response not reliably carrying full `custom_fields` on nested subtasks.
Fetching the list with `subtasks: true` instead reuses the same endpoint/
shape as the main project fetch, so `custom_fields` are guaranteed complete
— and it's one call instead of ~N, so it's faster too.

Confirmed live (2026-09-11, via a real `/api/portfolio` debug response):
"Assigned To (Multi)" is a ClickUp **Labels** custom field, not a
"users"/People field — its values are ids into the field's own fixed list
of person-named options (`type_config.options`), not real ClickUp
user/workspace-member ids. `customFieldAssignees()` in
`netlify/functions/lib/transform.js` resolves that case first, falling back
to a "users"-field shape for any other list that maps `"assignee"`
differently. If Workload still shows more "Unassigned" than expected, fetch
`/api/portfolio` and check `debug.assigneeField` (confirms the field name
matches) and `debug.rawProjectAssigneeFieldSample` /
`rawSubtaskAssigneeFieldSample` (the raw field ClickUp returned, including
its `type`) — that's enough to diagnose any further mismatch without a
guess-and-retest round trip.

The inline "assignee" editor in Decisions & Gaps still only writes to
ClickUp's *native* assignee field, not the "Assigned To (Multi)" Labels
field — now that the real field type is confirmed, writing to it is likely
just `{"value": [optionId, ...]}` (the same option ids used to read it), but
that's still unverified against live ClickUp from this environment, so it
hasn't been wired up without confirmation first.

**Update, 2026-09-11 — the "Roadmap shows an owner but the API doesn't" mystery, solved.**
A real investigation on this list turned up two separate problems, both now
handled automatically:

1. **A field-name collision.** This list actually has *two different*
   custom fields both literally named `"Assigned To (Multi)"` (one likely
   at the list level, one inherited from its Space/Folder). `fields.find()`
   only ever sees whichever one the API lists first, which isn't
   necessarily the one shown in a given ClickUp view.
2. **The real data was in a different field.** On the tasks this was
   diagnosed against, both copies of the Labels field were genuinely empty
   — but a separate field literally named `"Assigned to"` (a plain
   free-text field, not a Labels/People field) held the owner's name typed
   in directly, and that's what ClickUp's Roadmap view was actually
   displaying. Confirmed by adding a "dump every custom field on one sample
   subtask" diagnostic, which showed `"Assigned to" (short_text): has
   value: "Guy Armstrong"` sitting right next to two empty `"Assigned To
   (Multi)"` entries on the same task.

The fix: `textFieldAssignees()` in `netlify/functions/lib/transform.js`
parses that free-text field (splitting on commas/`/`/`&`/`and`) and is used
as a **fallback only** — both `toProject()` and the subtask roll-up in
`portfolio.js` try the native assignee field and the structured Labels field
first, and only reach for the free-text field when neither found anything.
A typed name that matches a real ClickUp workspace member gets that
member's real id (so it aggregates correctly); an unmatched typed name
still surfaces rather than being dropped, just without a stable ClickUp
identity behind it. Map your own list's fallback field name via
`"assigneeTextFallback"` in `config/fieldMapping.json` (or delete that key
if you don't need one). Read-only: the inline gap editors still only write
to the structured field, never to this free-text one.

3. **The deepest layer: a single task can carry two `custom_fields` entries
   with the exact same name** (identical string, same case, same
   whitespace) but different underlying field ids — one empty, one holding
   the real value, in no guaranteed order. Neither a plain `.find()` nor an
   exact-name match alone can tell them apart; both looked equally like
   "the field named X." `findFieldLenient()` in
   `netlify/functions/lib/transform.js` fixes this at the root: within
   whichever name-matching tier succeeds (exact name, then
   case/whitespace-insensitive as a fallback), it always prefers whichever
   candidate actually has a value (`fieldHasValue()`), only falling back to
   the first candidate if none are populated. This is applied uniformly to
   both the structured "Assigned To (Multi)" lookup and the free-text
   fallback lookup, since the same ClickUp data-quality issue was confirmed
   to affect both.

With all three layers fixed, Workload by person now attributes real owners
across the whole list (confirmed live, 2026-09-11) instead of defaulting
most subtasks to "Unassigned." The Resources tab's old Diagnostics panel —
built specifically to chase this down field-by-field from a screenshot —
has been removed now that it's served its purpose; see §9a below for what
replaced it.

### 9a. Workload charts — "Live workload share" and "Weekly hours by project"

Both charts now render **above** the per-person workload cards (they used to
sit below) — the charts give the at-a-glance read of who's carrying what,
and the cards are the drill-down detail once you've spotted something worth
a closer look, so leading with the charts matches how the tab is actually
used. Two charts sit at the top, built from the same
`data.workload` the cards use (see `computeWorkload()` in
`netlify/functions/lib/transform.js`), following the project's dataviz
skill (fixed 8-slot categorical palette, validated for both light and dark
mode; see `--series-1` … `--series-6` and the `--series-unassigned` /
`--series-others` tokens in `public/css/style.css`).

- **Live workload share** is a donut of everyone's share of all
  active/delayed/at-risk projects right now. The busiest 6 named people get
  their own slice in rank order (categorical slots 1–6); "Unassigned" gets
  its own slice in the reserved red slot (an intentional attention color for
  the ownership gap) whenever it carries any live load; everyone past the
  top 6 is folded into a single neutral-gray "Others" slice so the chart
  never has to seat a 7th+ identity color. The center of the donut shows the
  total live-project count.
- **Weekly hours by project** is a horizontal stacked-bar chart, one row per
  person (sorted by live project count, "Unassigned" excluded since hours
  can't be allocated to nobody). Each project segment prefers a REAL number
  — ClickUp's own native per-task **Estimate** field (`time_estimate`,
  milliseconds, converted to hours) — and falls back to an even 40-hour/week
  split only for whichever of a person's projects have no estimate set at
  all yet. Segments render differently depending on which: a solid segment
  is a real ClickUp estimate; a dashed segment (labeled with a trailing
  `*`) is the flat-split placeholder, shown so an unestimated project still
  shows up rather than silently vanishing. All rows share one x-axis
  (`node scripts/preview-server.js` renders it live), so bar lengths are
  directly comparable, and a dashed vertical reference line marks 40 hours
  (one full week) — a bar that extends past it means that person is
  estimated at more than a full week's work. Each segment is hoverable
  (project name, hours, and whether it's a real estimate or an assumed
  placeholder) and shows its hours value directly on the bar; a person
  whose projects are all completed shows "Fully wrapped up" instead of an
  empty bar.

**Where the real hours come from:** `hoursByAssigneeForProject()` in
`netlify/functions/lib/transform.js` sums `time_estimate` across a
project's own task plus every one of its descendant subtasks (any depth),
attributed to whichever assignee(s) *that specific task* resolves to (via
the same `resolveTaskAssignees()` used everywhere else ownership is
determined) — not the project's overall rolled-up assignee list, since two
different subtasks on the same project can have two different owners with
two different estimates. A task with more than one assignee splits its
estimate evenly across them (ClickUp only supports true per-assignee
estimates on some plans, so an even split is the closest thing to "hours
needed" that works regardless of plan). A task with `time_estimate` unset
or zero contributes nothing — never misread as "this genuinely needs 0
hours" — so a project only ever shows real numbers once someone has
actually estimated at least one of its tasks in ClickUp; until then, it
keeps using the flat-split placeholder it always has. No new ClickUp setup
is required to start: just fill in the existing "Estimate" field (the small
clock icon next to a task, the same one ClickUp's own time-tracking reports
already use) on whichever tasks matter most, and this chart picks it up
automatically on the next refresh.

Both charts are rendered in `renderWorkloadDonut()` / `renderWorkloadHoursChart()`
in `public/js/dashboard.js` and re-render on theme toggle (the donut's slice
colors are painted as inline SVG attributes, so a light/dark flip needs a
fresh render to pick up the other mode's palette step; the hours chart's
segment colors are plain CSS classes and repaint on their own).

Real headcount planning (is someone at 60% or 150% capacity, not just "how
many projects") still has one more piece ClickUp doesn't have yet: a way to
say which team/function is doing the work (PME vs. Lab vs. Manufacturing,
matching the divider structure the Projects Update tab already uses) so
capacity can be sliced by team, not just by individual. Once that exists as
a custom field, this tab is the natural place to add a team-level
capacity-vs-allocation view on top of the per-person one that already
exists.

### 9b. Every person gets a real slice, plus "This week's load"

**Live workload share's donut no longer summarizes anyone into a ballpark
figure.** Every person who carries any live load gets their own genuine
slice sized to their real share (`donutSlices()` in `public/js/dashboard.js`)
— there's no rounding a smaller contributor into "roughly some"; the
dataviz skill's fixed 6-slot categorical palette just means only the
busiest 6 (plus "Unassigned") get their own named legend row and color,
while everyone past that is grouped into one neutral "Others (N people)"
legend row for readability — but each of those people still has their own
real arc in the chart, they just share the same neutral color and aren't
individually named in the legend. Hovering **any** slice — including the
long-tail ones sharing the neutral color — pops a small themed tooltip
naming that exact person, their live project count, and their percentage
(`setupDonutHoverTooltip()`), so nobody is truly anonymous just because they
didn't make the top 6.

**"This week's load" is a new panel above the donut**, sourced from the same
data Weekly Activity itself uses rather than a separate fetch —
`/api/weekly`'s subtask list now carries a resolved `assignees` array per
subtask (falling back to the project's own owner when a subtask has nobody
set), and `computeWeeklyLoad()` groups those into one card per person: who
has something starting or due this Monday–Sunday, and which project(s). It's
additive, not a replacement — the existing all-time donut and hours charts
below it are unchanged, since "what's moving this week" and "overall
assignment regardless of timing" answer two different questions. It's
lazy-loaded the first time you open **either** Weekly Activity or Resources
(whichever you open first triggers the one fetch; the other reuses it).

**The number in the middle of the donut is a count of assignments, not
projects.** Because a project with several owners contributes to each of
their slices, that center number sums to more than the portfolio's actual
project count the moment any project has more than one owner (a live
example: 65 there vs. 18 projects on the Projects tab, since quite a few
projects here have 3+ owners). The label reads "assignments" for exactly
this reason — it was previously (and misleadingly) labeled "live projects."

## Data completeness — what to add in ClickUp for a sharper dashboard

Based on the live data pulled from your Active list, a few fields are
either missing entirely or unused across all 23 tasks. None of these block
the dashboard — everything above already falls back gracefully — but
filling them in is what turns the "generic-looking" KPIs into a real signal:

- **Risk Status, Risk Score, Probability, Impact, Mitigation Strategy** —
  present as fields but empty on every task in the last data pull. Right
  now "At Risk: 0" on the Overview tab is structurally guaranteed to read
  low, because the only signal feeding it is an overdue due date, not
  actual risk judgment. Worth checking directly in ClickUp whether these
  fields are just unfilled, or whether your team is tracking risk under
  different field names than `config/fieldMapping.json` currently expects
  ("Risk Status", "Risk Score", "Probability", "💣 Impact", "Mitigation
  Strategy") — if the names differ, that's a one-line fix in that file.
- **Product** — also empty on every task in that pull, even though
  Product Category is populated. If per-model (not just per-category)
  filtering matters to you, this is worth setting.
- **Stage Gate vs. Gate Phase** — you have two gate fields. "Gate Phase" is
  the one actually populated and is what the dashboard uses; "Stage Gate"
  has never been set on any task. Worth either retiring "Stage Gate" so
  PMs aren't unsure which one to fill in, or deciding it should be the
  canonical one and migrating "Gate Phase" values into it.
- **~6 of 23 projects have no gate set at all** (they show as
  "Unclassified" in the Portfolio Mix stage-gate chart) — worth a pass to
  assign these, since they're currently invisible to any gate-based view.
- **Due dates** — after fixing a bug where a missing due date was silently
  read as a fake 1970 date, the honest picture is that very few tasks have
  a real due date set. This feeds the Timeline, Upcoming Gates, and the
  "No target/due date" gap — without it, none of those can say anything
  useful about a project.
- **Project Health** (see section 3) is still worth adding if you want the
  four KPI buckets to reflect a PM's actual judgment call instead of the
  status/overdue-date heuristic.

None of this requires re-reading the whole portfolio to check — pasting a
fresh `/api/portfolio` JSON response here (or just telling me what you see
on the relevant ClickUp fields) is enough for a fast follow-up pass.

## 10. "Decisions & Gaps" — fill gaps in place, without opening ClickUp

Every gap chip that has an obvious fix now renders as a small inline
control instead of a dead-end label: "No target/due date" becomes a date
picker, "No owner assigned" becomes a dropdown of the "Assigned To (Multi)"
field's real options (see section 9 above — it writes there, not to
ClickUp's native assignee field), "No product category" / "No stage gate
set" become dropdowns of your real ClickUp options, and "Open risk with no
mitigation plan" becomes
a text field for the mitigation plan (Risk Status itself is left alone
here, since it's already "Open" — that's why the gap fired). Changing a
value saves immediately — there's no separate confirm step — then the
dashboard refetches so the gap chip disappears the moment it's actually
resolved in ClickUp. One gap is deliberately still read-only: "Marked
ongoing but 0% progress logged" isn't wired up, since ClickUp's Progress
field is a different kind of field (`manual_progress`) that's out of scope
for this pass — update that one directly in ClickUp for now.

This writes real data back to ClickUp (`netlify/functions/gap-update.js`),
which is a meaningfully bigger claim than everything else in this app —
everywhere else only ever reads. Two things worth knowing:

- **This has only been exercised against mock/preview data during
  development**, not against a live ClickUp account — the sandbox this was
  built in blocks outbound requests to `api.clickup.com`, so the actual
  write calls could not be tested end-to-end before shipping. The read
  side of this app has been solid against your real data, and the write
  code follows ClickUp's documented API shapes closely, but **test it on
  one project first** before relying on it across the whole portfolio, and
  keep an eye on that project in ClickUp to confirm the value landed as
  expected.
- **"Stage Gate" isn't editable here on purpose** — only "Gate Phase" is,
  since that's the field actually in use (see the "Stage Gate vs. Gate
  Phase" note above). If you decide to retire "Stage Gate" entirely, no
  change is needed here; if you decide to make it the canonical field
  instead, this editor (and `config/fieldMapping.json`) would need to
  point at it instead.

## 11. "Weekly Activity" — live subtasks per active project, limited to this week

A live snapshot, not a diff: every project that isn't marked completed,
each with its current ClickUp subtasks listed underneath as its "updates,"
plus a Total Active Projects count at the top. It's lazy-loaded the first
time you open the tab, with a manual Refresh after that. It used to make one
ClickUp call per active project to pull each one's subtasks; it now makes
**one bulk call for the whole list, including subtasks at every depth**
(`getListTasksWithSubtasks()`, the same technique `portfolio.js` already
used for the assignee rollup), which also feeds the nested tree described
next.

**Updates are now limited to the current Monday-Sunday week** — a subtask
only shows up here if its Start Date *or* Due Date (the same Roadmap fields
the Gantt tab reads) falls inside the week that's happening right now.
Previously every subtask showed regardless of date, which buried "what's
actually moving this week" under everything else a project has ever had
logged. A subtask with neither date set can't be placed in a week at all, so
it's excluded rather than shown unconditionally — same reasoning as the
Gantt tab excluding projects with no due date. This is computed by
`currentWeekRange()` in `netlify/functions/lib/transform.js`, shared between
the live path (`weekly.js`) and the mock preview path (`mockWeekly.js`) so
both apply the identical week window.

A **status filter** sits above the list — pills for "All activity" plus every
real ClickUp status name actually seen on this week's subtasks (so it's
whatever a workspace has customized, not a hardcoded "Ongoing/On Hold/To Do"
list). Picking one narrows each card down to just its updates in that
status, and hides any project that has none in that status — so "On Hold"
shows only the projects with something genuinely on hold right now, not
every project with an empty "on hold" section. This filters client-side
against the already-loaded snapshot (`weeklyStatusOptions()`/
`renderWeeklyStatusFilters()` in `public/js/dashboard.js`), so switching
pills doesn't re-fetch from ClickUp.

A genuine week-over-week digest — what's new, what moved, what got
completed since last week, not just what's true right now — needs
somewhere to store last week's snapshot to compare against, which this app
doesn't have yet (every view here reads ClickUp live, with no history
layer). That's a natural next build once this simpler version is proving
useful; it would need a small persistence layer this project doesn't
currently have any of (a scheduled snapshot job + somewhere to store it).
The status filter above ships now as the "filter today's view" half of the
user's ask; the diff is intentionally left as that next build.

### 11a. Work-breakdown-structure tree — parent → child → grandchild

Each card now shows this week's activity as a real nested tree instead of a
flat list, wherever ClickUp actually has that structure (a project task with
its own sub-steps, one of which has a sub-step of its own, and so on to
whatever depth ClickUp has). A parent is shown bold with no status dot — it's
there for structure, usually a phase or bucket, not something checked off on
its own — while a leaf renders exactly like the old flat rows did (status
dot, name, due badge, status text).

The tree is built server-side in `weekly.js` (`buildWeekTree()`), from the
same bulk `getListTasksWithSubtasks()` fetch mentioned above, grouped by
`parent` id. It's then pruned (`pruneToWeekWork()`) so only branches with at
least one this-week item survive — a parent is kept for context even when
its own dates miss this week, as long as one of its descendants qualifies,
but a sibling branch with nothing happening this week is dropped. This keeps
the view scoped to "this week's slice of the real structure" instead of
dumping a project's entire task history into the tab. The flat `updates`
list (direct children only) still ships alongside the tree, unchanged —
it's what "This week's load" on Resources and the status-filter pills
read — so picking a status filter falls back to that flat list rather than
showing an unfiltered tree.

### 11b. Download standup summary — HTML and slides

Two buttons next to Refresh build the same full standup picture — this
week's activity (the same WBS tree above), every open risk (the same merged
list Live Risk Signals shows — see 6b — so the checklist-gate signal is
included), and every project with a planning gap flagged under Decisions &
Gaps — assembled once as plain data (`buildStandupSummaryData()` in
`dashboard.js`, no extra ClickUp call) and rendered two ways:

- **Download summary (HTML)** — a self-contained, styled HTML page
  (`renderStandupSummaryHtml()`), downloaded as
  `standup-summary-<monday's date>.html`. Opens instantly in any browser
  with a double-click — no markdown app or file-association issue, unlike
  the plain `.md` file this used to be.
- **Download slides (.pptx)** — an actual PowerPoint deck: a title slide,
  one slide per active project's this-week activity (indented to match the
  WBS tree), an open-risks slide, and a decisions/gaps slide. Built
  server-side by a new function, `netlify/functions/standup-pptx.js`, using
  `pptxgenjs` — the dashboard's one and only npm dependency (see section 4
  for the one-time `npm install` this needs locally). The button POSTs the
  same data the HTML export uses to that function and downloads whatever
  comes back; if `pptxgenjs` isn't installed yet, it shows the actual error
  rather than failing silently.

## 12. Theme — light by default, dark by choice

Light mode is the true default now, regardless of the browser/OS's own
dark-mode preference — earlier this auto-switched to dark via
`@media (prefers-color-scheme: dark)`, which meant anyone with a dark OS
theme saw dark mode even before touching the toggle. That media query is
gone; the **Dark mode** button in the header is now the only way in
(`initTheme()`/the `theme-toggle` handler in `public/js/dashboard.js`). The
last choice is remembered in the browser's `localStorage` (this is a file
you run locally, not the in-chat preview, so that's safe to rely on here),
so a returning visit keeps whichever mode was picked instead of resetting
to light every time — clear that key (`pm-dashboard-theme`) or use a private
window to see the true first-visit default.

## 13. "Checklists" — stage-gate exit criteria per project

Every non-completed project gets a card showing exit-criteria items for
whatever stage gate(s) it currently sits at (`STAGE_GATE_CHECKLISTS` in
`public/js/dashboard.js` — one item list per stage, e.g. "Final BOM locked" /
"Prototype built and tested" for Detailed Design). Check items off as
they're actually done; a progress count ("2 / 4 complete") updates live. A
project with no stage gate set yet shows a note pointing at Decisions &
Gaps instead of an empty checklist.

**Checklists are now cumulative, not just the current gate's own list.** A
project at Detailed Design shows every section from Project Kickoff through
Detailed Design, not only Detailed Design's own four items
(`CHECKLIST_SECTION_ORDER` + `checklistGateThreshold()` in
`public/js/dashboard.js`) — so an earlier item that never got checked off
stays visible and trackable instead of silently disappearing the moment the
project advances to its next gate. Each gate's items render under their own
small section header within the card.

**A "Packaging & Product Launch" section was added**, threaded in alongside
Launch (it isn't itself one of the six `GATE_ORDER` stages, so it becomes
relevant at the same point Launch does, not as a separate gate of its own):
retail/shipping packaging design, drop/transit/stacking tests, labeling and
compliance marks, packaging supplier tooling and lead time, and the first
packaged production run.

**A full Box Artwork Review checklist was added inside Packaging & Product
Launch**, from a real internal checklist doc ("Box Artwork Review Checklist
— Mapped to the 5-Page Drawing Set"): 57 items across 9 categories (Title
Block & Documentation, Dimensions & Construction, Dieline/Keyline/Tape
Marks, BCT/ECT & Performance Specs, Branding & Graphics Content,
Multi-Language & Localization, Compliance/Certification & Legal Marks,
Cross-Check Against Previous Revision, Final Sign-Off). These are **nested
sub-checklists inside the single "Packaging & Product Launch" section**,
not nine more top-level sections of their own — Packaging & Product Launch
still shows as exactly one header row on the card (with a combined
"checked / total" count that folds all 62 of its own + Box Artwork's items
together), and the 9 Box Artwork categories only appear once that one
section is expanded (`BOX_ARTWORK_SUBSECTIONS` +
`packagingSubsectionsHtml()` in `public/js/dashboard.js`, passed as the
`nested` checklist into `checklistSectionHtml()`; each category is still its
own `"Box Artwork: <category>"` entry in `STAGE_GATE_CHECKLISTS` under the
hood, so per-item add/remove/× and progress tracking all work exactly like
any other section). A category that doesn't apply to a particular box is
still easy to spot and prune with its own ×.

**All nine Box Artwork subsections stay collapsed by default, always** —
independent of whatever state their parent Packaging & Product Launch
section is in. A project's current gate being Launch still auto-opens
Packaging & Product Launch itself, and scoping VIEWING to one project still
auto-opens every other top-level section on its card, but opening Packaging
& Product Launch (by either of those, or by hand) never auto-opens the nine
nested Box Artwork subsections inside it — 57 items is a lot to have pop
open unasked-for. They're still fully openable by hand, or via the card's
own "Expand all," which cascades into them too.

**Every list is now editable per project, not fixed.** Every item — a
standard template item or something you added — has a small × next to it
(`checklistSectionHtml()` in `public/js/dashboard.js`). Clicking it on a
standard item doesn't delete the template for every project; it just hides
that one item for this one project (e.g. a field/pilot test that genuinely
doesn't apply to a cosmetic-only change), so future projects still start
from the full standard list. Whenever a project has anything hidden, a
"Restore N hidden items" link appears at the bottom of its card to undo all
of it in one click.

**Items can now be added into any section, not just one catch-all.** Each
gate's section (and the Packaging & Product Launch section) has its own
small "Add an item to this section…" input at the bottom, so a
project-specific requirement files under the gate it actually belongs to —
the old single "Follow-ups & add-ons" bucket at the bottom of the card still
exists for anything that isn't tied to a specific gate, and behaves exactly
as it did before. Every added item can be checked off like any other, or
removed entirely with its own ×.

**A red-to-green "heat map" now colors each card as it fills in.** The
card's left border and a thin progress bar under the "N / M complete" count
both shift color as a continuous sweep from red (nothing checked) through
amber/yellow to green (everything checked) — `checklistHeatColor()` in
`public/js/dashboard.js` maps the exact completion fraction to a hue, so a
whole grid of project cards reads at a glance without opening any of them,
and the color is always backed by the literal count sitting right next to
it, never color alone.

**All of this is still intentionally local-only, not ClickUp-backed** — same
as before: there's no checklist-shaped custom field on this list to read
from or write to, so checked-off state, hidden standard items, and any
items you've added are all saved in this browser's `localStorage` only
(same reasoning as the theme toggle in section 12). That means every
customization here — what's hidden, what's been added, what's checked — is
local to whoever's browser it was done in, not synced to ClickUp or shared
across teammates; a project shown to two different people in two different
browsers can show two different checklists. If you want any of this shared
across the team, the natural next step is a small persistence layer (the
same missing piece called out in section 11's week-over-week note) or a
ClickUp-native checklist per task that this tab reads instead of the static
template.

**Sections now fold, so a full grid of projects doesn't mean endless
scrolling.** Each gate's section is a native `<details>`/`<summary>` element
— only the section matching the project's *current* gate opens by default;
everything else (earlier, already-passed gates, and the follow-ups bucket)
starts collapsed, with a small count badge in its header so you can still
see "3/5" without opening it. Every card also gets its own "Expand
all"/"Collapse all" pair. Scoping the VIEWING selector above the grid to one
specific project is read as "show me everything about this project" — every
section on its card opens automatically, no clicking required.

**Each card now shows its own next milestone** — the project's target gate
date plus the same countdown-chip styling Lab already used (`Xd left` /
`Due today` / `Xd overdue`), via a shared `dateUrgencyInfo()` helper
extracted from what used to be Lab-only code. That date is also what feeds
the new checklist-driven risk signal described in section 6b: once a
project's own countdown here gets inside 14 days while the checklist above
it still isn't 100%, that project starts showing up on Live Risk Signals
too — so this tab and the Risk Register never disagree about what "close to
the gate" means.

## 14. "Tooling" tab — projects with a live tooling requirement

A new tab that scans the same portfolio data every other tab reads (no
second data source) for every non-completed project whose ClickUp
**Tooling** field is set to anything other than "No"/empty
(`hasToolingRequirement()` in `public/js/dashboard.js`; the field itself
already existed — mapped as `"tooling"` → `"Tooling"` in
`config/fieldMapping.json` — it just didn't have a dedicated view before).
Each row shows the project, health, stage gate, owner(s), and target date.

**Priority is a local-only picker** (Not set / High / Medium / Low, a plain
`<select>` per row) since there's no ClickUp field for it either — set one
to sequence tooling spend across the portfolio, and the table re-sorts by
priority first, then by soonest target date. Saved in this browser's
`localStorage`, same local-only reasoning as Checklists (section 13) and the
theme toggle (section 12).

**Rows can now also be dragged into your own order**, via the "⠿" handle in
each row's first cell — a plain HTML5 drag-and-drop (no library), wired in
`dashboard.js` (`toolingDragAfterElement()` + the `dragstart`/`dragover`/
`dragend` listeners on `#tooling-tbody`). The priority sort above still runs
first for anything you haven't manually repositioned; a row you've dragged
keeps that saved position from then on (`pm-dashboard-tooling-order` in
`localStorage`, merged with the priority/date order every render by
`effectiveToolingOrder()`), and a brand-new tooling need still slots in by
priority/date until you drag it somewhere on purpose.

**Both Tooling and Lab rows now have a "Tasks" button** that opens a small
per-project task list right under that row — add a task, give it an
optional due date, check it off, or remove it, the same add/check/remove
pattern as the Checklists tab's follow-ups (section 13), reusing its visual
language. This exists because neither tab is backed by a real ClickUp
list — Tooling is one Yes/No field, Lab is inferred from stage gate — so
there was nowhere to track a project's *actual* individual tooling or lab
tasks (a project can easily have several, e.g. more than one open tooling
task on the same stove). Saved per project in `localStorage`
(`pm-dashboard-tasks:<projectId>`), same local-only reasoning as everything
else on this page — not synced to ClickUp.

## 15. "Lab" tab — projects whose current gate implies live lab work

A second scan-based tab, this one inferring "needs lab work" from **stage
gate** rather than a dedicated field, per the same reasoning the user
confirmed when this was built: there's no "lab" custom field in ClickUp at
all, so this can't read a real flag the way Tooling does. Instead, every
non-completed project currently at **Scoping & Feasibility**, **Preliminary
Design**, or **Detailed Design** — the three gates that actually involve
bench/lab testing before a project can move on — shows up automatically
(`isLabGateProject()` / `LAB_GATES` in `public/js/dashboard.js`).

Each row shows the project, health, gate, owner(s), and a **"closes by"**
date — the project's own next-gate target date (the same Roadmap field
Gantt and every other date-aware tab reads), since lab work has to wrap
before that date rather than having some separate date of its own. A
**"time left"** chip counts down from it (days, then weeks, once there's
more than a week left) and is recomputed fresh from "now" every time the
tab renders — so as the weeks run on, the countdown just keeps counting
down without anything needing to be updated by hand. Rows are sorted
soonest-closing first.

## 16. The "ecoa" visual design — branding, theme, splash

The whole dashboard's look was redone to match a design mockup ecoa's design
team produced (a static, hand-built HTML/CSS reference covering the
Overview, Projects, Risks, and Resources tabs, plus explicit design-system
tokens for every other tab). This was a **pure re-skin**: every ClickUp
field, Netlify function, and piece of app behavior described elsewhere in
this README is unchanged — only `public/css/style.css`, the header/nav/splash
markup in `public/index.html`, and a handful of small additive JS helpers in
`public/js/dashboard.js` (avatar initials, the theme-icon swap, the splash
dismiss hook) changed.

**Branding.** The ecoa "stoves for life" logo (`public/assets/ecoa-logo.png`,
extracted from the design file) now appears in the header and the splash
screen; the page title and header text read "Biomass Portfolio
Intelligence"; the chrome accent color is ecoa's exact logo orange
(`--brand-accent: #f58220` in `style.css`, both light and dark themes).
Fonts are Plus Jakarta Sans (body) and Outfit (headings), loaded from Google
Fonts in `index.html` — that's the one new external dependency this reskin
adds; if the machine running this has no internet access, the browser falls
back to the system sans-serif font stack and everything still works, just
with a different typeface.

**Glassmorphism.** Every panel, card, table, and pill button is a translucent
"glass" surface (`--surface-1`/`--surface-2` are now `rgba(...)` values, not
solid colors) with `backdrop-filter: blur(...)`, layered over three fixed,
slowly-drifting blurred color blobs behind everything (`.bg-blobs` in
`index.html`/`style.css`) — this is why panels pick up a soft color glow
rather than sitting on a flat white/black background. Chart *data* colors
(the validated categorical palette — `--series-1` through `--series-6`) were
deliberately left untouched by this reskin; only the chrome/branding accent
and surface treatment changed, per the dataviz skill's rule that data colors
stay validated independent of brand color.

**Dark mode** already existed (section 12) — the reskin only retuned what
color each theme's tokens resolve to (and added the sun/moon icon swap on
the toggle button), it didn't change the light/dark mechanism itself.

**Splash screen.** A ~2 second branded loading screen (logo, spinner,
progress bar, "BIOMASS PORTFOLIO INTELLIGENCE" tagline) shows on every page
load and fades out once the first ClickUp fetch resolves (or after a 2.6s
fallback if it's slow) — see the `splash()` IIFE near the bottom of
`dashboard.js` and `#splash`/`.splash-*` in `style.css`. It's purely
cosmetic and never blocks or delays the real data load underneath it.

**Nav tabs** are now icon + label pill buttons instead of underlined text
tabs (same 13 tabs, same ids, same drag-to-reorder from section "How it's
wired") — icons are inline SVGs matching the design file's icon set.

**Four tabs were rebuilt to match the mockup layout closely**: Overview's
KPI row (now glass cards with a radial color glow per health bucket),
Projects' register (avatar-initial "who" cells, tinted health pills, gradient
progress bars), Risks & Issues' top stat cards, and Resources' load-by-person
bars. The other nine tabs (Weekly Activity, Category, Stage Gate, Decisions &
Gaps, Gantt, Tooling, Lab, Checklists, Idea Dumps) didn't have an exact mockup
to follow, so they picked up the same design language automatically through
shared CSS classes (`.panel`, `.pill`, `.action-btn`, `.chip-clear`, table
styles, card radii/shadows) rather than being rebuilt tab-by-tab — every one
of them was screenshotted and regression-tested (drag-reorder, checklist
nesting/expand-collapse, per-project tasks, standup HTML/pptx export, theme
persistence) to confirm nothing broke in the process.

## 17. Real-ClickUp-data fixes to the ecoa reskin

Section 16's reskin was built and regression-tested against the mock data
set, whose owner lists are always 1-2 short names. Testing it against real
ClickUp data surfaced four rough edges that only show up with longer,
messier real-world lists — all four are fixed, pure refinements on top of
the same reskin (nothing in section 16 changed conceptually).

**Owner cells (Projects register).** `renderTable()` in `dashboard.js` used
to join every assignee's full name into one long comma-separated string next
to a single avatar — fine for "Amara" or "Dan, Priya," unreadable for a real
5-name ClickUp assignee list. It now renders each owner as its own small
chip (`ownerChipsHtml()`): one avatar + **first name only** per chip, chips
wrap onto multiple lines inside the cell instead of stretching the row
(`.who-cell { flex-wrap: wrap }` in `style.css`), and past the third owner
the rest collapse into a single `+N` chip. Hovering either an individual
chip or the `+N` chip (or the cell itself) shows the full name(s) in a
native tooltip, so nothing is actually lost, just not all shown by default.

**Gantt translucency.** `.gantt-header`, `.gantt-header-spacer`, and
`.gantt-row-label` (the sticky month header and the sticky project-name
column) used to share the same translucent glass background as every other
panel (`--surface-1`). That's fine for a card sitting still, but these three
scroll directly over the colored Gantt bars underneath them, so the bars
visibly bled through the text as you scrolled — worse with real longer
project-name lists that scroll further. All three now use the fully opaque
page background (`--page-plane`) instead, in both light and dark themes, so
project names and month labels always stay legible over whatever's
scrolling behind them. Nothing else on the Gantt (the bars, the outer
`.gantt-scroll` card, quarter shading) changed.

**Tooling & Lab column resize.** Neither `#tooling-table` nor `#lab-table`
had any explicit column widths before (no CSS targeted them at all) — the
browser's default table layout just kept stretching the whole row wide
enough to fit one long owner-name cell on a single line rather than
wrapping it, which looked especially bad with real multi-name lists. Both
tables now get a `<colgroup>` of fixed-width `<col>`s (`table-layout: fixed`
in `style.css`) so long text wraps in place instead of stretching the row,
plus base header/cell styling to match the rest of the dashboard (borders,
padding, hover tint) that they'd never actually had. A thin drag handle on
the right edge of each resizable header (`initResizableTable()` in
`dashboard.js`, `.col-resize-handle` in `style.css`) lets you widen or
narrow any column by hand, Excel-style — drag to resize, double-click a
handle to reset that column back to its default width. Widths persist
per-browser in localStorage (`pm-dashboard-colwidths:tooling` /
`:lab`), same as every other layout preference on this dashboard, so your
sizing survives a reload.

**Standup HTML & PPTX exports now match the ecoa theme.** Both were still
using their pre-reskin plain styling (`renderStandupSummaryHtml()` in
`dashboard.js`, and `netlify/functions/standup-pptx.js`, previously
hardcoded to a different orange-red, `#E5522D`). Both now use the dashboard's
actual ecoa palette (`#f58220` / `#cf6408`), Plus Jakarta Sans / Outfit type,
and the ecoa logo:
- The downloaded HTML summary embeds the logo as a base64 data URI (so the
  file stays a single, fully self-contained document — no broken relative
  image path once it's saved or emailed elsewhere), with a branded header
  band, rounded card panels for each project/risk/gap section, and orange
  pill tags/badges in place of the old plain gray ones.
- The PPTX deck (built server-side with `pptxgenjs`) gets the same accent
  colors, a title slide with the embedded logo and an orange tint band, and
  a thin orange accent rule under every slide title and along the bottom of
  every slide — PowerPoint has no glass/blur equivalent, so the "glass"
  language translates here as a soft tint + accent rule instead of
  backdrop-filter.

All four were verified with Playwright against a modified mock feed with a
deliberately long, multi-name assignee list (to simulate real ClickUp data)
plus the existing full regression suite (theme persistence, tab/tooling
drag-reorder, checklist nesting, standup exports, viewing/period filters) —
all passed with zero console errors.

## 18. Checklists polish, auto-checked past gates, and a Resources kanban board

A follow-up round of feedback on the ecoa reskin (section 16) and the
real-data fixes (section 17): the Checklists tab still had one real styling
bug and a UX gap, and the Resources tab's hours chart wasn't earning its
keep.

**Checklist card title was an unstyled browser link.** The anchor wrapping
each project's name on a checklist card carried a stray `card-title` class
that (outside `.kanban-card`, where that class actually has a rule) matched
no CSS at all — it rendered as a plain blue underlined link, the one place
on the dashboard that didn't pick up the ecoa look. It now has its own
`.checklist-card-title` rule (`style.css`): Outfit heading font, bold,
`--text-primary`, no underline, orange on hover — matching every other card
title on the dashboard. The gate pill next to it also picked up the same
orange brand tint every other pill/badge uses (it was still plain gray
before). The card grid's minimum column width went from 280px to 320px so
long project names wrap less awkwardly, and the panel's description was
trimmed from one long paragraph to two sentences.

**Earlier gates auto-check as complete.** Previously every checklist item
defaulted to unchecked regardless of how far along the project actually
was, so a project sitting at Detailed Design still showed its Kickoff and
Scoping sections at 0% until someone went back and manually ticked
everything off. Standard items in any gate section strictly before the
project's current gate now default to checked, so a card only asks for
attention on the gate the project is actually at — Kickoff/Scoping/
Preliminary Design might show "4/4," "5/5," "4/4" (collapsed, nothing to
do) while Detailed Design shows "0/4" (open, the actual work). This
required changing the checklist storage from a simple boolean (present key
= checked, absent = unchecked) to a tri-state scheme (`isChecklistItemChecked()`
in `dashboard.js`): an explicit "1" or "0" always wins, and only a genuinely
untouched item falls back to the computed default — so a PM who deliberately
un-checks something on an already-"complete" earlier gate has that stick,
rather than it reverting back to checked on the next render. The same
default logic was applied to `checklistProgressForProject()`, which feeds
the Risk Register's "gate nearing, checklist incomplete" signal — so that
signal no longer fires purely because an already-passed gate was never
manually ticked off. Nothing about the removable-standard-item or
custom-added-item mechanics changed.

**Resources tab: "Weekly hours by project" replaced with a per-person kanban
board.** That chart tried to turn ClickUp's Estimate field into an
hours-per-week readout, but Estimate is inconsistently filled in, so most of
the chart was assumed 40-hour placeholder splits rather than real numbers —
more confusing than useful. It's gone (`renderWorkloadHoursChart()` and its
`.hours-*` CSS removed entirely), replaced with "Board by person": one
kanban column per assignee, one card per live (non-completed) project they're
on, "Unassigned" last if it carries any load — built with the exact same
`.kanban-board`/`.kanban-column`/`.kanban-card` markup and CSS the By
Category / By Stage Gate tabs already use (`renderWorkloadKanban()`), rather
than inventing a new visual pattern. The workload donut and the "Workload by
person" project-count grid above it are unchanged.

**Kanban cards show a person's own tasks, not just the project.** A first
version of the board only repeated the project's name and health pill in
every column it appeared in — three people all sharing a project saw three
identical-looking cards, with no way to tell what any of them specifically
had to do without opening ClickUp. Each card now lists that person's own
open subtasks on the project (small bulleted list, capped at 4 with a "+N
more"), sourced from `/api/weekly`'s per-project subtask tree — which was
already being fetched for Weekly Activity and "This week's load" but, until
now, only exposed items falling inside the current Monday–Sunday window.
`flattenOpenTasks()` (`netlify/functions/lib/transform.js`) flattens that
same tree, unpruned, into every still-open item at any depth, each already
carrying its own resolved assignee (falling back to the project's own
assignees when a given subtask has nobody set, same as everywhere else on
this dashboard); `weekly.js` exposes it per project as `openTasks`, and
`renderWorkloadKanban()` filters that list to each card's specific person. A
card can land in one of three honest states rather than guessing: "Loading
tasks…" while `/api/weekly` hasn't resolved yet (it's lazy-loaded only once
Weekly Activity or Resources is opened), "No specific tasks logged yet" when
ownership is only known at the project level (no subtask carries that
person), or the real list once it's available.

All four were verified with Playwright against the mock data (title link
color/decoration, section-by-section checked counts and open/closed state
across projects at different gates, kanban column/card counts, per-person
task lists including the loading/empty/populated states) plus the existing
full regression suite — zero console errors, both light and dark mode.

## 19. Fixing "no specific tasks logged yet" against real ClickUp data, and the Project Deep Dive

Two follow-ups after the Resources kanban board shipped: the per-person task
breakdown (section 18) came back empty for every card against the user's
real ClickUp workspace despite deep, real subtask/assignee data existing
there, and a request for a per-project "deep dive" page — Scope, Timeline,
Cost/Resource, Impact, Priority — reachable by clicking a project card.

**The "no specific tasks logged yet" bug.** `/api/weekly`'s per-project
`openTasks` (workload.js's `flattenOpenTasks`) and `/api/portfolio`'s
workload roster (`computeWorkload`) resolve assignees through the exact same
`resolveTaskAssignees()` helper, but from two independent ClickUp fetches —
so if the same real person is tagged via ClickUp's native Assignee field on
one task and the custom "Assigned To (Multi)" Labels field on another, the
two paths can hand back different `id` shapes (a numeric ClickUp user id vs.
a Labels-field option uuid) for the same human, and a strict `id === id`
match then silently returns zero matches everywhere. Since this sandbox has
no live ClickUp connection to reproduce the bug directly, the fix is two
layers: (1) `weekly.js` now returns a `diagnostics` object (total tasks
fetched, how many projects came back with/without `openTasks`, any
per-project errors — now also `console.error`'d instead of silently
swallowed, so a Netlify function log shows them — and a sample resolved
task's `assignees` shape) so a `curl /api/weekly | jq .diagnostics` on the
real deployment shows exactly where it's coming up empty; (2) `dashboard.js`'s
`tasksForPerson()` now matches a task's assignee to a workload person by id
**or** by case/whitespace-insensitive name, so either ClickUp source is
enough to connect a task back to its person even when the id spaces don't
line up. Verified against the mock-data regression suite (unchanged
behavior, zero console errors) since live ClickUp data isn't reachable from
here — the diagnostics field is what turns the next real-data check into a
five-second lookup instead of another guess.

**Project Deep Dive.** Clicking any project card (Projects by Category, By
Stage Gate, or the Resources board-by-person) now opens a full-screen modal
with five tabs — Scope, Timeline, Cost & Resource, Impact, Priority — each
freely editable and saved to `localStorage` per project id
(`pm-dashboard-deepdive-<id>`), deliberately not synced to ClickUp: this is
meant as the "true north" reference for a product's project that a ClickUp
field has no room for, with any item left blank until it's known. Scope is a
Feature/Stage/Rationale/Lift table (matching the shape used in product-dev
decks); Timeline is a short list of phases with a window and a status;
Cost & Resource is a role/effort/notes table (matching the "Team
Utilization/Week" shape from the roadmap decks); Impact is a set of add-your-
own stat cards (TAM/SAM/SOM or whatever number makes the case) plus notes;
Priority is a 0–5 slider plus a checklist of open questions — a tab with any
unresolved question gets a small dot flag. Every project gets an icon (a
default emoji by product category, e.g. 🍳 for Cookware, 🔥 for Charcoal
Stove — click it to pick a different emoji from a curated set, or upload a
photo, resized client-side to a 160px thumbnail before being stored so it
doesn't blow past `localStorage`'s quota) shown both on the card and in the
modal header. Projects categorized as "Cookware" are seeded with real
starting content pulled from the Premium Cookware product-development deck
(Aug–Sep 2026 Amazon best-seller research, the premiumization roadmap, the
construction-fork decision) and the Hardware roadmap spreadsheet's Cookware
rows — including its two live open questions (the B2B/private-label
strategy question, and "why are we making a chapati pan?") — so the feature
demos with real substance rather than an empty shell; every other project
starts blank with placeholder text guiding what to fill in. Verified via
Playwright against the mock data: opening a seeded (Cookware) and a blank
project, switching every tab, adding/removing rows, resolving a priority
question (strikethrough + tab flag clears), changing the icon (emoji and
upload), and confirming edits persist across a close/reopen — zero console
errors, both light and dark mode.

## 20. Deploying to Vercel (in addition to Netlify)

This project was originally Netlify-only: `netlify.toml` + `netlify/functions/*.js`
using the Lambda-style `exports.handler = async (event) => ({statusCode,
headers, body})` contract, with a `/api/*` → `/.netlify/functions/:splat`
redirect that only Netlify understands. Deployed to Vercel as-is, `/api/*`
resolves to nothing — Vercel expects serverless functions under an `/api`
directory using its own `(req, res)` calling convention — so every
`fetch("/api/...")` call fails and the dashboard shows "Error loading data"
with every count at zero. That's what was happening; nothing was wrong with
the ClickUp integration itself.

Fixed by adding real Vercel support alongside the existing Netlify path,
without forking any endpoint's logic into two copies that could drift:

- Each `netlify/functions/*.js` file now also exports its handler as
  `exports.handle` (in addition to the `exports.handler` Netlify looks for)
  — a second name for the same function, not a behavior change.
- A new `api/` directory holds one thin wrapper per endpoint
  (`api/portfolio.js`, `api/weekly.js`, `api/ideas.js`, `api/registers.js`,
  `api/gap-update.js`, `api/standup-pptx.js`), each importing the matching
  `netlify/functions/*.js`'s `handle` and adapting Vercel's `(req, res)` call
  into the Netlify-shaped `event` object that logic already expects (see
  `api/_adapt.js` for the shared adapter — query string parsing, JSON body
  round-tripping, and `isBase64Encoded` handling for the pptx export).
- `vercel.json` sets `outputDirectory: "public"` so the static frontend
  serves from the project root the same way Netlify's `publish = "public"`
  does.

Netlify deploys are unaffected — same files, same `exports.handler` entry
point, same redirect. To deploy to Vercel: push/redeploy this project as-is
(Vercel auto-detects the `api/*.js` functions and `vercel.json`'s output
directory, zero extra config), then set the same environment variables
`.env` would hold locally — `CLICKUP_API_TOKEN`, `CLICKUP_LIST_ID`, and
optionally `CLICKUP_INTAKE_LIST_ID` / `CLICKUP_RISK_LIST_ID` /
`CLICKUP_ISSUE_LIST_ID` / `CLICKUP_LESSON_LIST_ID` (see `.env.example`) —
under the Vercel project's Settings → Environment Variables. Without those
set, the dashboard now falls back to mock/preview data cleanly (matching
local/Netlify behavior with no `.env`) rather than erroring.

Verified locally: each `api/*.js` wrapper invoked directly with a stubbed
`(req, res)` — GET endpoints (portfolio, weekly, ideas, registers) return
200 with the expected mock payload, a missing `?type=` on registers returns
its real 400 validation error, and POST-only endpoints (gap-update,
standup-pptx) correctly 405 on GET — plus the full existing regression
suite still passes against the local preview server with zero console
errors.

## 21. Team-prioritization pass: Weekly Activity sort, Deep Dive maximize + cover photo, Weekly Priorities, cross-tab dated items, editable tasks, Idea Dumps edit

A follow-up batch aimed at making Weekly Activity and the Deep Dive actually
drive team prioritization, plus a round of smaller fixes:

- **Weekly Activity sort order** — projects with real movement this week (a
  WBS tree or flat updates) now sort above ones showing "Nothing starting or
  due this week yet," so a PM scanning for prioritization decisions sees the
  busy projects first (`renderWeekly` in `dashboard.js`).
- **Deep Dive opens maximized** — `.deepdive-panel` fills the viewport
  instead of floating as an 880px-wide centered dialog; closing it reverts to
  the normal dashboard underneath, same as before.
- **Deep Dive cover photo** — a new, larger per-project banner image
  (`data.coverPhoto`, downscaled client-side to a 1600px long edge before
  storing), separate from the existing small 56×56 header icon/emoji. Shown
  at the top of the modal with its own upload/remove controls.
- **Checklist items can now carry a due date** — the checklist item add-form
  gained a date input (matching Tooling/Lab's task-add form), stored as
  `dueDate` on each custom checklist item.
- **"Other open items this week" panel** (Weekly Activity tab) — aggregates
  anything with a due date in the current Monday–Sunday window from local
  Tooling/Lab tasks, Checklist items, and Idea Dumps submissions (via
  `/api/ideas`), none of which live in the ClickUp-sourced `/api/weekly`
  response. Shown as its own list above the per-project cards, since Idea
  Dumps items aren't tied to any one project.
- **New "Weekly Priorities" tab** — a live table styled after the CRCA
  Diffuser / Sahel Stove roadmap slides (Key Function / Team
  Utilization-per-Week / Activities / Priority), grouped by project. Rows
  come straight from each project's own Deep Dive **Cost & Resource** tab
  (`role` → Key Function, `effort` → Team Utilization/Week, `notes` →
  Activities) and the **Priority** column pulls from that project's Deep Dive
  Priority tab (the first unresolved open question if there is one, else the
  priority score/notes) — so filling in a project's Deep Dive is what
  populates this table, rather than re-typing the same content twice. A
  project with no Cost & Resource rows yet shows a prompt linking straight
  into its Deep Dive. Includes a "Download table (HTML)" export in the same
  layout.
- **Click-to-edit task/checklist text** — Tooling/Lab task items and
  Checklist custom items can now be edited in place by clicking their text
  (swaps to an inline input; Enter/blur saves, Escape cancels). Standard
  (non-custom) checklist template items are unaffected, matching how removal
  already worked.
- **Idea Dumps: edit past submissions** — each submitted idea now has an
  "Edit" button that opens an inline form (title/product/category/target
  date/description, pre-filled from the fields the backend parses back out
  of the ClickUp task's description) and saves via a new `PUT /api/ideas`
  endpoint (`ideas.js`'s `updateTask` path). Works against the mock/preview
  data too when `CLICKUP_INTAKE_LIST_ID` isn't configured yet.
- **Idea Dumps "Team not authorized" (401 / OAUTH_027) errors** — `ideas.js`
  now rewrites that specific ClickUp error into an actionable message: it
  means `CLICKUP_API_TOKEN` doesn't have access to whatever list
  `CLICKUP_INTAKE_LIST_ID` points to. The most common cause is that env var
  still being set to the `123456789` placeholder from `.env.example`, or
  pointing at a list in a different ClickUp workspace than the token
  belongs to — check both under Vercel/Netlify's environment variable
  settings. This is a deployment-configuration issue, not a code bug: the
  create/list/update request logic itself was verified correct.
- **ecoa logo "compression" in exports** — investigated and found no
  re-encoding/resizing in either export path: both the HTML weekly summary
  and the PPTX slides embed `public/assets/ecoa-logo.png`'s raw bytes as
  base64, unmodified. The blurriness traced back to the source asset itself
  (500×200px, generated rather than the real brand file) — replace
  `public/assets/ecoa-logo.png` with a real high-resolution logo and both
  exports will pick it up as-is, with zero re-processing.

## What's next: product lifecycle & project management

The direction for this platform is a full **product lifecycle and project
management** tool, not just a portfolio status board — tracking every
project from idea intake through stage-gate development to launch and
post-launch improvement, with the resourcing and risk picture to manage it
along the way. What's shipped so far already covers a fair amount of that
ground: idea intake (Idea Dumps), the stage-gate pipeline itself (Portfolio
Mix, the Kanban board's Stage Gate grouping, and cumulative per-gate exit
criteria in Checklists — section 13, now including a Packaging & Product
Launch section and editable follow-up items), a start-to-due schedule view
(Gantt, section 8), planning-gap detection and in-place remediation merged
with a calendar view that highlights whichever weeks still need a decision
(Decisions & Gaps, section 6), risk detection that doesn't wait on manual
tagging plus populatable Risk/Issues/Lessons Learnt logbooks behind their own
sub-nav (Risks & Issues, sections 6b/6d), workload by person including a
this-week view and a genuine per-person donut (Resources, sections 9/9b),
live week-scoped activity (Weekly Activity), and two gate/field-driven scans
that surface work that doesn't have its own tab anywhere else in ClickUp
(Tooling and Lab, sections 14/15).

The rest of the phases described in our original brainstorm build on the
same pattern (`netlify/functions/lib/clickupClient.js` + `transform.js` —
one more custom field mapping and one more frontend page each) and fill in
the lifecycle picture further: Project Detail, SMT Executive, Resource
Allocation (capacity vs. workload, not just project counts — the team/
function slicing called out at the end of section 9), Gate
Review (a real stage-gate advancement workflow — the sign-off a project
needs to move from one gate to the next, not just displaying which gate
it's in), Manufacturing Readiness, Cost Savings, Action Tracker, and the
PPTX/PDF exporters.
