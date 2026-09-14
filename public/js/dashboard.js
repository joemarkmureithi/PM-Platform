(async function () {
  const KPI_ORDER = [
    { key: "active", label: "Active Projects", dotClass: "active" },
    { key: "delayed", label: "Delayed Projects", dotClass: "delayed" },
    { key: "atRisk", label: "At Risk", dotClass: "atRisk" },
    { key: "completed", label: "Completed", dotClass: "completed" },
  ];

  const HEALTH_LABEL = { active: "Active", delayed: "Delayed", atRisk: "At Risk", completed: "Completed" };
  // Real "Stage Gate" dropdown values, confirmed against live ClickUp data
  // (2026-08-21) rather than assumed. "Launch" is included even though no
  // current task uses it, so the chart stays correctly ordered once one does.
  const GATE_ORDER = ["Project Kickoff", "Scoping & Feasibility", "Preliminary Design", "Detailed Design", "Launch", "Post Launch Improvements"];
  // By Stage Gate kanban only: Kickoff and Scoping & Feasibility collapse into
  // one column (requested by the user to cut down on left/right scrolling --
  // these two early stages are short-lived enough that splitting them wasn't
  // earning its own column). Every other view (Overview's gate bar chart, the
  // project detail stage bar, Upcoming Gates) keeps the real six-stage
  // GATE_ORDER untouched.
  const KICKOFF_SCOPING_LABEL = "Kickoff & Scoping/Feasibility";
  const GATE_COLUMN_ORDER = [KICKOFF_SCOPING_LABEL, "Preliminary Design", "Detailed Design", "Launch", "Post Launch Improvements"];
  const WINDOW_DAYS_BACK = 30;
  const WINDOW_DAYS_FWD = 90;

  // ---- state -------------------------------------------------------------
  let allProjects = [];
  let healthFilter = null; // set by clicking a KPI tile, or the register's Health column filter
  let noOwnerFilter = false; // set by clicking the "No Owner" KPI tile, or choosing "Unassigned" in the register's Owner column filter
  let ownerFilter = ""; // register's Owner column filter -- a specific person's name
  let gateFilter = ""; // register's Stage Gate column filter
  let riskOnlyFilter = false; // register's Risk column filter ("Needs intervention")
  let searchTerm = "";
  let categoryFilter = "";
  let viewingProjectId = ""; // set by the "VIEWING" selector
  let periodDays = 0; // 0 = all time, N = due within N days, -1 = overdue
  let sortKey = "targetGateDate";
  let sortDir = "asc";
  let fieldOptions = {}; // dropdown options for the Decisions & Gaps inline editors
  let members = []; // real ClickUp workspace members (from getListMembers) -- kept for a future native-assignee fallback UI; the "owner" gap editor itself now sources its options from fieldOptions.assignee instead
  let weeklyLoaded = false; // Weekly Activity is lazy-loaded on first tab visit
  let weeklyData = null; // last /api/weekly payload, cached so the status filter can re-render without refetching
  let weeklyStatusFilter = ""; // "" = all statuses; otherwise one of the real ClickUp status names seen on subtasks (Ongoing/On Hold/To Do/etc.)
  let calendarMonthOffset = 0; // 0 = current month, set by the Calendar tab's prev/next/today controls
  let ganttScrolledToToday = false; // one-time auto-scroll, done on first visit to the Gantt tab (see setupTabs)
  let ganttTodayLeftPx = null; // last-computed "today" x-offset within the Gantt timeline, null when today falls outside the plotted range

  // ---- helpers -------------------------------------------------------------
  // Always includes the year -- the planner routinely spans across year
  // boundaries (a project kicked off this year with a launch date next
  // year), and a bare "17 Aug" is ambiguous about which one it means once
  // that's true. Used everywhere a date is shown (Project Register,
  // Gantt, Checklists' milestone line, Tooling/Lab, Upcoming Gates, …), so
  // fixing it here fixes it everywhere at once.
  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function relativeLabel(iso) {
    if (!iso) return "";
    const days = Math.round((Date.parse(iso) - Date.now()) / (1000 * 60 * 60 * 24));
    if (days < 0) return `Overdue ${Math.abs(days)}d`;
    if (days === 0) return "Today";
    return `In ${days}d`;
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Monday-Sunday label for whatever "this week" is right now -- Weekly
  // Activity is a live snapshot, not a stored history, so there's no real
  // "previous week" to page back to; this just makes clear which week the
  // snapshot you're looking at actually is.
  function currentWeekRangeLabel() {
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `Week of ${fmt(monday)} – ${fmt(sunday)}`;
  }

  function dueLabelFor(ms) {
    const days = Math.round((ms - Date.now()) / 86400000);
    if (days < 0) return `Overdue ${Math.abs(days)}d`;
    if (days === 0) return "Due today";
    if (days <= 7) return `Due in ${days}d`;
    return `Due ${fmtDate(new Date(ms).toISOString())}`;
  }

  function matchesPeriod(targetGateDate) {
    if (periodDays === 0) return true;
    if (!targetGateDate) return false;
    const days = (Date.parse(targetGateDate) - Date.now()) / 86400000;
    if (periodDays === -1) return days < 0;
    return days >= 0 && days <= periodDays;
  }

  // ---- tabs -------------------------------------------------------------
  function setupTabs() {
    document.querySelectorAll(".tab[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab[data-tab]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const target = btn.dataset.tab;
        document.querySelectorAll(".tab-panel").forEach((panel) => {
          panel.hidden = panel.id !== `tab-panel-${target}`;
        });
        // Resources' "This week's load" panel is sourced from the same
        // /api/weekly data Weekly Activity uses, so whichever of the two
        // tabs is opened first triggers the (still one-time) fetch.
        if ((target === "weekly" || target === "resourcing") && !weeklyLoaded) loadWeekly();
        // The very first render happens while this tab is still hidden
        // (display:none collapses its width to 0), so any attempt to scroll
        // it there silently no-ops -- defer the one-time auto-scroll-to-today
        // until the tab actually becomes visible, same reasoning as Weekly
        // Activity's lazy load above.
        if (target === "gantt" && !ganttScrolledToToday) {
          const scroll = document.getElementById("gantt-scroll");
          if (scroll && ganttTodayLeftPx != null) {
            scroll.scrollLeft = Math.max(0, ganttTodayLeftPx - scroll.clientWidth / 3);
          }
          ganttScrolledToToday = true;
        }
      });
    });
  }

  // ---- Nav tabs: drag-and-drop reordering ----------------------------------
  // Lets a PM put the tab bar in whatever order matches how they actually
  // walk through a review/story (e.g. Checklists right after Overview,
  // Risks & Issues up front) instead of the fixed build order. Plain HTML5
  // drag-and-drop on the tab buttons themselves, same technique as the
  // Tooling tab's row reordering -- a saved order of `data-tab` keys in
  // localStorage, re-applied (and merged with any new tab that wasn't in a
  // previously-saved order) on every load.
  function tabOrderStorageKey() {
    return "pm-dashboard-tab-order";
  }

  function getTabOrder() {
    try {
      const raw = localStorage.getItem(tabOrderStorageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function setTabOrder(order) {
    try {
      localStorage.setItem(tabOrderStorageKey(), JSON.stringify(order));
    } catch {
      /* storage unavailable -- won't persist across reloads */
    }
  }

  // Reorders the actual DOM buttons to match any saved order -- run once at
  // startup, before setupTabs() wires up click handlers, so those handlers
  // attach to buttons already in their saved positions. A tab not present in
  // a previously-saved order (e.g. this dashboard added a new one since you
  // last dragged) is appended at the end, in its original relative order,
  // rather than being lost or jumping to the front.
  function applyTabOrder() {
    const bar = document.getElementById("tab-bar");
    if (!bar) return;
    const saved = getTabOrder();
    if (saved.length === 0) return;
    const tabs = [...bar.querySelectorAll(".tab[data-tab]")];
    const byKey = new Map(tabs.map((t) => [t.dataset.tab, t]));
    const ordered = [];
    saved.forEach((key) => {
      const el = byKey.get(key);
      if (el) {
        ordered.push(el);
        byKey.delete(key);
      }
    });
    byKey.forEach((el) => ordered.push(el));
    ordered.forEach((el) => bar.appendChild(el));
  }

  function wireTabDragReorder() {
    const bar = document.getElementById("tab-bar");
    if (!bar) return;
    bar.querySelectorAll(".tab[data-tab]").forEach((t) => { t.draggable = true; });

    function afterElement(x) {
      const candidates = [...bar.querySelectorAll(".tab[data-tab]:not(.dragging)")];
      return candidates.reduce(
        (closest, child) => {
          const box = child.getBoundingClientRect();
          const offset = x - box.left - box.width / 2;
          if (offset < 0 && offset > closest.offset) return { offset, element: child };
          return closest;
        },
        { offset: Number.NEGATIVE_INFINITY, element: null }
      ).element;
    }

    bar.addEventListener("dragstart", (e) => {
      const tab = e.target.closest(".tab[data-tab]");
      if (!tab) return;
      tab.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", tab.dataset.tab || "");
    });
    bar.addEventListener("dragover", (e) => {
      const dragging = bar.querySelector(".tab.dragging");
      if (!dragging) return;
      e.preventDefault();
      const after = afterElement(e.clientX);
      if (!after) bar.appendChild(dragging);
      else bar.insertBefore(dragging, after);
    });
    bar.addEventListener("dragend", () => {
      const dragging = bar.querySelector(".tab.dragging");
      if (dragging) dragging.classList.remove("dragging");
      const order = [...bar.querySelectorAll(".tab[data-tab]")].map((t) => t.dataset.tab);
      setTabOrder(order);
    });
  }

  // Generic sub-nav switcher for any tab that groups several panels behind
  // a segmented control (currently just Risks & Issues: Live Signals / Risk
  // Register / Issues Register / Lessons Learnt) -- keeps a long tab from
  // being one flat vertical stack of nine panels a PM has to scroll past to
  // find the one they want.
  function setupSubtabs() {
    document.querySelectorAll(".subnav").forEach((nav) => {
      const container = nav.parentElement;
      nav.querySelectorAll(".subtab[data-subtab]").forEach((btn) => {
        btn.addEventListener("click", () => {
          nav.querySelectorAll(".subtab").forEach((b) => {
            b.classList.remove("active");
            b.setAttribute("aria-selected", "false");
          });
          btn.classList.add("active");
          btn.setAttribute("aria-selected", "true");
          const target = btn.dataset.subtab;
          container.querySelectorAll(":scope > [data-subtab-panel]").forEach((panel) => {
            panel.hidden = panel.dataset.subtabPanel !== target;
          });
        });
      });
    });
  }

  // ---- KPI tiles -------------------------------------------------------------
  // The first 4 tiles are the mutually-exclusive health buckets (these also
  // feed the Portfolio Mix donut via KPI_ORDER, and drive the Projects table's
  // healthFilter) -- everything after them is a cross-cutting count that
  // doesn't fit that donut (a project can be both "active" and "flagged as a
  // risk", so these aren't additional slices of the same pie) but is still
  // worth a tile since these are exactly the reference-dashboard-style
  // headline numbers (total, needs intervention, no owner, open gaps).
  function renderKpis(data) {
    const counts = data?.counts;
    const row = document.getElementById("kpi-row");
    row.innerHTML = "";
    KPI_ORDER.forEach(({ key, label, dotClass }) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "stat-tile" + (healthFilter === key ? " selected" : "");
      tile.dataset.kpi = dotClass;
      tile.setAttribute("aria-pressed", String(healthFilter === key));
      tile.innerHTML = `
        <div class="stat-label"><span class="status-dot ${dotClass}"></span>${label}</div>
        <div class="stat-value">${counts?.[key] ?? 0}</div>
      `;
      tile.addEventListener("click", () => {
        healthFilter = healthFilter === key ? null : key;
        noOwnerFilter = false;
        ownerFilter = "";
        gateFilter = "";
        riskOnlyFilter = false;
        document.querySelector('.tab[data-tab="projects"]').click();
        renderAll();
      });
      row.appendChild(tile);
    });

    const totalTile = document.createElement("div");
    totalTile.className = "stat-tile stat-tile-static";
    totalTile.innerHTML = `
      <div class="stat-label">Total Projects</div>
      <div class="stat-value">${counts?.total ?? 0}</div>
    `;
    row.appendChild(totalTile);

    const riskCount = data?.risks?.length ?? 0;
    const riskTile = document.createElement("button");
    riskTile.type = "button";
    riskTile.className = "stat-tile";
    riskTile.dataset.kpi = "atRisk";
    riskTile.innerHTML = `
      <div class="stat-label"><span class="status-dot atRisk"></span>Needs Intervention</div>
      <div class="stat-value">${riskCount}</div>
    `;
    riskTile.addEventListener("click", () => document.querySelector('.tab[data-tab="risks"]').click());
    row.appendChild(riskTile);

    const noOwnerCount = data?.decisions?.gapTotals?.noAssignee ?? 0;
    const noOwnerTile = document.createElement("button");
    noOwnerTile.type = "button";
    noOwnerTile.className = "stat-tile" + (noOwnerFilter ? " selected" : "");
    noOwnerTile.setAttribute("aria-pressed", String(noOwnerFilter));
    noOwnerTile.innerHTML = `
      <div class="stat-label">No Owner</div>
      <div class="stat-value">${noOwnerCount}</div>
    `;
    noOwnerTile.addEventListener("click", () => {
      noOwnerFilter = !noOwnerFilter;
      healthFilter = null;
      ownerFilter = "";
      gateFilter = "";
      riskOnlyFilter = false;
      document.querySelector('.tab[data-tab="projects"]').click();
      renderAll();
    });
    row.appendChild(noOwnerTile);

    const gapsCount = data?.decisions?.totalFlagged ?? 0;
    const gapsTile = document.createElement("button");
    gapsTile.type = "button";
    gapsTile.className = "stat-tile";
    gapsTile.dataset.kpi = "gaps";
    gapsTile.innerHTML = `
      <div class="stat-label">Open Gaps</div>
      <div class="stat-value">${gapsCount}</div>
    `;
    gapsTile.addEventListener("click", () => document.querySelector('.tab[data-tab="decisions"]').click());
    row.appendChild(gapsTile);
  }

  // ---- Portfolio Mix charts (hand-rolled SVG/HTML, no chart library) -----

  function buildDonut(counts) {
    const segments = KPI_ORDER.map(({ key, label, dotClass }) => ({ value: counts?.[key] ?? 0, label, dotClass }));
    const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
    const r = 15.9155; // circumference ~= 100, so percentages map directly to dasharray units
    const circumference = 2 * Math.PI * r;
    let offsetAccum = 0;
    const colorOf = (dotClass) => `var(--${{
      active: "series-1", delayed: "status-warning", atRisk: "status-critical", completed: "status-good",
    }[dotClass]})`;

    // Each real segment is a .donut-slice -- same interactive-hover class
    // the Resources tab's workload donut already uses (grow + brighten on
    // hover, wired up by setupDonutHoverTooltip below), so this chart
    // finally matches the rest of the app's charts instead of being the
    // one static one. The hover GROWTH itself is scoped to #health-donut
    // in CSS rather than sharing the workload donut's exact stroke-width,
    // since this donut's viewBox (and base 6px stroke) is much smaller --
    // the same absolute hover width would swallow the whole chart.
    const circles = segments
      .filter((seg) => seg.value > 0)
      .map((seg) => {
        const fraction = seg.value / total;
        const dash = fraction * circumference;
        const gap = circumference - dash;
        const pct = (fraction * 100).toFixed(1);
        const circle = `<circle class="donut-slice" data-name="${escapeHtml(seg.label)}" data-value="${seg.value}" data-pct="${pct}" r="${r}" cx="21" cy="21" fill="transparent" stroke="${colorOf(seg.dotClass)}" stroke-width="6" stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}" stroke-dashoffset="${(-offsetAccum).toFixed(2)}"><title>${escapeHtml(seg.label)}: ${seg.value} (${pct}%)</title></circle>`;
        offsetAccum += dash;
        return circle;
      })
      .join("");

    return `
      <svg id="health-donut-svg" width="140" height="140" viewBox="0 0 42 42" role="img" aria-label="Health distribution donut chart">
        <circle r="${r}" cx="21" cy="21" fill="transparent" stroke="var(--gridline)" stroke-width="6" />
        ${circles}
        <text x="21" y="19.5" text-anchor="middle" font-size="7" font-weight="700" fill="var(--text-primary)">${total}</text>
        <text x="21" y="25.5" text-anchor="middle" font-size="3" fill="var(--text-muted)">projects</text>
      </svg>
    `;
  }

  function renderHealthChart(counts) {
    document.getElementById("health-donut").innerHTML = buildDonut(counts);
    const legend = document.getElementById("health-legend");
    legend.innerHTML = "";
    KPI_ORDER.forEach(({ key, label, dotClass }) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="swatch status-dot ${dotClass}"></span>${label}<span class="legend-value">${counts?.[key] ?? 0}</span>`;
      legend.appendChild(li);
    });
    // Unlike the workload donut (whose root container is never itself
    // replaced wholesale -- only its svg/legend/center children are), this
    // donut's own wrapper (#health-donut) just had its ENTIRE innerHTML
    // swapped in above, taking any previously-appended tooltip element and
    // event listeners with it. So this re-wires hover on every render
    // instead of once at init -- setupDonutHoverTooltip is idempotent
    // either way (it only creates a tooltip element if one isn't already
    // there), so this is just as cheap as it looks.
    setupDonutHoverTooltip("health-donut", "health-donut-svg", healthDonutTooltipLabel);
  }

  function renderGateChart(byGate) {
    const container = document.getElementById("gate-bar-chart");
    const entries = Object.entries(byGate || {});
    if (entries.length === 0) {
      container.innerHTML = '<div class="empty-state">No stage gate data yet.</div>';
      return;
    }
    entries.sort((a, b) => {
      // "Unclassified" represents missing data, not a stage -- it always
      // sorts last regardless of count, same convention as the Kanban board.
      if (a[0] === "Unclassified") return 1;
      if (b[0] === "Unclassified") return -1;
      const ai = GATE_ORDER.indexOf(a[0]);
      const bi = GATE_ORDER.indexOf(b[0]);
      if (ai === -1 && bi === -1) return b[1] - a[1];
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    const max = Math.max(...entries.map(([, v]) => v), 1);
    container.innerHTML = entries
      .map(([label, value], i) => {
        const opacity = (0.35 + 0.65 * (i / Math.max(entries.length - 1, 1))).toFixed(2);
        // The base opacity gradient above is a deliberate ranking cue
        // (busier stages read more solid), so hover doesn't touch opacity
        // directly -- instead --bar-fill-opacity carries that per-row value
        // through to CSS, which hover can override to "spotlight" whichever
        // row's actually under the cursor without fighting the inline style.
        return `
        <div class="bar-row" title="${escapeHtml(label)}: ${value} project${value === 1 ? "" : "s"}">
          <div class="bar-label">${escapeHtml(label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(value / max) * 100}%; background:var(--series-1); --bar-fill-opacity:${opacity};"></div></div>
          <div class="bar-value">${value}</div>
        </div>`;
      })
      .join("");
  }

  // ---- Timeline & gates -------------------------------------------------------------

  function renderTimeline(gates) {
    const fill = document.getElementById("timeline-fill");
    const track = document.getElementById("timeline-track");
    const labels = document.getElementById("timeline-labels");

    const windowStart = Date.now() - WINDOW_DAYS_BACK * 86400000;
    const windowEnd = Date.now() + WINDOW_DAYS_FWD * 86400000;
    const totalSpan = windowEnd - windowStart;
    const todayPct = ((Date.now() - windowStart) / totalSpan) * 100;

    fill.style.width = `${todayPct.toFixed(1)}%`;

    track.querySelectorAll(".timeline-marker").forEach((el) => el.remove());
    (gates || []).forEach((g) => {
      const t = Date.parse(g.date);
      if (!Number.isFinite(t) || t < windowStart || t > windowEnd) return;
      const marker = document.createElement("div");
      marker.className = "timeline-marker";
      marker.style.left = `${(((t - windowStart) / totalSpan) * 100).toFixed(1)}%`;
      marker.title = `${g.project}: ${g.gate || ""} (${fmtDate(g.date)})`;
      track.appendChild(marker);
    });

    labels.innerHTML = `
      <span>${fmtDate(new Date(windowStart).toISOString())}</span>
      <span>Today</span>
      <span>${fmtDate(new Date(windowEnd).toISOString())}</span>
    `;
  }

  function renderGates(upcomingGates) {
    const list = document.getElementById("gate-list");
    list.innerHTML = "";
    // Callers already pass a list scoped to the current VIEWING selection
    // (see gatesForContext() in renderAll) -- this only applies the
    // DUE WITHIN period filter on top of that.
    let gates = (upcomingGates || []).filter((g) => matchesPeriod(g.date));

    if (gates.length === 0) {
      list.innerHTML = '<li class="empty-state">No upcoming gates match the current filters.</li>';
      return;
    }
    gates.forEach((g) => {
      const days = Math.round((Date.parse(g.date) - Date.now()) / 86400000);
      const dotClass = days < 0 ? "overdue" : days <= 7 ? "soon" : "";
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="gate-dot ${dotClass}"></span>
        <span class="gate-project">${escapeHtml(g.project)}</span>
        <span class="gate-name">${escapeHtml(g.gate || "")}</span>
        <span class="gate-date">${fmtDate(g.date)} · ${relativeLabel(g.date)}</span>
      `;
      list.appendChild(li);
    });
  }

  // ---- filters -------------------------------------------------------------

  function populateViewingSelect(projects) {
    const select = document.getElementById("viewing-select");
    const existing = new Set(Array.from(select.options).map((o) => o.value));
    projects.forEach((p) => {
      if (!existing.has(p.id)) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        select.appendChild(opt);
      }
    });
  }

  function populateCategoryFilter(projects) {
    const select = document.getElementById("product-category-filter");
    const existing = new Set(Array.from(select.options).map((o) => o.value));
    const categories = [...new Set(projects.map((p) => p.productCategory).filter(Boolean))].sort();
    categories.forEach((cat) => {
      if (!existing.has(cat)) {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        select.appendChild(opt);
      }
    });
  }

  function populateOwnerFilter(projects) {
    const select = document.getElementById("owner-filter");
    if (!select) return;
    const existing = new Set(Array.from(select.options).map((o) => o.value));
    const names = [...new Set(projects.flatMap((p) => (p.assignees || []).map((a) => a.name)).filter(Boolean))].sort();
    names.forEach((name) => {
      if (!existing.has(name)) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      }
    });
  }

  function populateGateFilter(projects) {
    const select = document.getElementById("gate-filter");
    if (!select) return;
    const existing = new Set(Array.from(select.options).map((o) => o.value));
    const gates = [...new Set(projects.map((p) => p.currentGate || p.gatePhase).filter(Boolean))];
    gates.sort((a, b) => {
      const ai = GATE_ORDER.indexOf(a);
      const bi = GATE_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    gates.forEach((gate) => {
      if (!existing.has(gate)) {
        const opt = document.createElement("option");
        opt.value = gate;
        opt.textContent = gate;
        select.appendChild(opt);
      }
    });
  }

  function populateIdeaCategoryOptions(projects) {
    const datalist = document.getElementById("idea-category-options");
    if (!datalist) return;
    const existing = new Set(Array.from(datalist.options).map((o) => o.value));
    const categories = [...new Set(projects.map((p) => p.productCategory).filter(Boolean))].sort();
    categories.forEach((cat) => {
      if (!existing.has(cat)) {
        const opt = document.createElement("option");
        opt.value = cat;
        datalist.appendChild(opt);
      }
    });
  }

  function getFilteredSortedProjects() {
    let rows = allProjects.slice();

    if (viewingProjectId) rows = rows.filter((p) => p.id === viewingProjectId);
    if (healthFilter) rows = rows.filter((p) => p.healthBucket === healthFilter);
    if (noOwnerFilter) {
      rows = rows.filter((p) => !p.assignees || p.assignees.length === 0);
    } else if (ownerFilter) {
      rows = rows.filter((p) => (p.assignees || []).some((a) => a.name === ownerFilter));
    }
    if (gateFilter) rows = rows.filter((p) => (p.currentGate || p.gatePhase) === gateFilter);
    if (riskOnlyFilter) rows = rows.filter((p) => !!p.risk);
    if (categoryFilter) rows = rows.filter((p) => p.productCategory === categoryFilter);
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      rows = rows.filter((p) => (p.name || "").toLowerCase().includes(term));
    }
    rows = rows.filter((p) => matchesPeriod(p.targetGateDate));

    rows.sort((a, b) => {
      let av;
      let bv;
      if (sortKey === "targetGateDate") {
        av = a.targetGateDate ? Date.parse(a.targetGateDate) : Infinity;
        bv = b.targetGateDate ? Date.parse(b.targetGateDate) : Infinity;
      } else if (sortKey === "progressPercent") {
        av = a.progressPercent ?? -1;
        bv = b.progressPercent ?? -1;
      } else if (sortKey === "owners") {
        av = (a.assignees && a.assignees.length ? a.assignees.map((x) => x.name).join(", ") : "").toLowerCase();
        bv = (b.assignees && b.assignees.length ? b.assignees.map((x) => x.name).join(", ") : "").toLowerCase();
      } else if (sortKey === "riskReason") {
        av = (a.risk?.reason || "").toLowerCase();
        bv = (b.risk?.reason || "").toLowerCase();
      } else if (sortKey === "currentGate") {
        av = (a.currentGate || a.gatePhase || "").toLowerCase();
        bv = (b.currentGate || b.gatePhase || "").toLowerCase();
      } else {
        av = (a[sortKey] ?? "").toString().toLowerCase();
        bv = (b[sortKey] ?? "").toString().toLowerCase();
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return rows;
  }

  // Shared scoping for the By Category / By Stage Gate tabs --
  // these follow the global VIEWING + DUE WITHIN context bar (same as the
  // Timeline/Upcoming Gates widgets) but don't have their own search/category
  // filter controls, unlike the Projects tab's flat table.
  function getContextProjects() {
    let rows = allProjects.slice();
    if (viewingProjectId) rows = rows.filter((p) => p.id === viewingProjectId);
    rows = rows.filter((p) => matchesPeriod(p.targetGateDate));
    return rows;
  }

  // ---- project deep dive (Scope / Timeline / Cost & Resource / Impact /
  // Priority) ---------------------------------------------------------------
  // Opened by clicking a project card (By Category, By Stage Gate, the
  // Resources board). Everything in it is edited and saved to localStorage
  // per project id -- deliberately NOT synced to ClickUp, since the ask was
  // for a place to hold the "true north" reference for a product's project
  // (scope/timeline/cost-resource/impact/priority) with items left open
  // until someone fills them in, not another ClickUp field. Cookware-category
  // projects are seeded with real content pulled from the Premium Cookware
  // product-development deck and the Hardware roadmap, so the feature shows
  // up with real substance the first time it's opened rather than a blank
  // shell; every other project starts blank with guiding placeholders.
  const DEEPDIVE_CATEGORY_ICON = {
    Cookware: "🍳",
    "Charcoal Stove": "🔥",
    "Wood Stove": "🪵",
    "Electric Stove": "⚡",
    Electric: "⚡",
    LPG: "🛢️",
    Institutional: "🏫",
  };
  const DEEPDIVE_ICON_CHOICES = ["🍳", "🔥", "🪵", "⚡", "🛢️", "🏫", "🧪", "📦", "🛠️", "🌍", "💡", "✨", "🔧", "🥘", "🔋", "🚰", "🧊", "🧵", "🏭", "🚀", "📐", "🧯", "🔩", "🌡️"];
  const DEEPDIVE_TABS = [
    { key: "scope", label: "Scope", icon: "🗺️" },
    { key: "timeline", label: "Timeline", icon: "📅" },
    { key: "costResource", label: "Cost & Resource", icon: "💰" },
    { key: "impact", label: "Impact", icon: "📈" },
    { key: "priority", label: "Priority", icon: "🎯" },
  ];

  function deepDiveKey(projectId) { return `pm-dashboard-deepdive-${projectId}`; }
  function deepDiveRowId() { return `dd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`; }
  function findProject(id) { return allProjects.find((p) => p.id === id); }

  function emptyDeepDive() {
    return {
      icon: null, // { emoji } or { photo: dataURL } -- null = category default
      coverPhoto: null, // dataURL of a larger banner photo, separate from the small header icon -- null = no cover set
      scope: { notes: "", rows: [] }, // rows: { id, feature, stage, rationale, lift }
      timeline: { notes: "", phases: [] }, // phases: { id, label, window, status: upcoming|active|done }
      costResource: { notes: "", rows: [] }, // rows: { id, role, effort, notes }
      impact: { notes: "", stats: [] }, // stats: { id, label, value }
      priority: { score: null, notes: "", questions: [] }, // questions: { id, text, resolved }
    };
  }

  // Seeded from Premium_Cookware_Product_Development.pdf (Aug-Sep 2026
  // Amazon best-seller research + the premiumization roadmap) and the
  // BURN_Roadmaps_Hardware_Software.xlsx Hardware sheet's Cookware rows.
  // Meant as a realistic starting point, not a fixed truth -- every field
  // here is exactly as editable as a blank one.
  function cookwareDeepDiveSeed() {
    const row = (feature, stage, rationale, lift) => ({ id: deepDiveRowId(), feature, stage, rationale, lift });
    const phase = (label, window, status) => ({ id: deepDiveRowId(), label, window, status });
    const cost = (role, effort, notes) => ({ id: deepDiveRowId(), role, effort, notes });
    const stat = (label, value) => ({ id: deepDiveRowId(), label, value });
    const q = (text) => ({ id: deepDiveRowId(), text, resolved: false });
    return {
      icon: { emoji: "🍳" },
      scope: {
        notes: "Seeded from the Premium Cookware product-development deck (Aug-Sep 2026 Amazon best-seller research) and the Hardware roadmap's Cookware rows. Edit freely -- this is the working scope, not a ClickUp field.",
        rows: [
          row("2L pot", "Preproduction (jigs machining for volume)", "Rounds out the set at the entry size", "Low"),
          row("Sandwich change: 2x0.4mm aluminium + 1.2mm CRCA", "Detailed design -- gate decision imminent", "Cost-down; consumes dead-stock CRCA, no retooling needed", "Medium"),
          row("Weld stain elimination", "Detailed design", "Visible quality defect on welded joins", "Medium"),
          row("Mirror finish", "Detailed design", "64% of US best-sellers are mirror-polished -- a live premium cue", "Medium"),
          row("Handle relocation + in-house handles", "DOE", "Pots stick on stacking; handles detach on separation (QA issue)", "Medium"),
          row("Larger set (8L / 6L / 4L / 2L + frying pan)", "Scoping & feasibility", "Rounds out the premium set beyond the current core sizes", "High"),
          row("New packaging -- shelf appeal + kit separation", "Scoping & feasibility", "GS1 code scanning interference between duplicate codes at installation", "Medium"),
        ],
      },
      timeline: {
        notes: "Phased path from the deck's \"Premiumization and market expansion path\" -- each phase unlocks new SKUs and a new market; a 10-14 month compliance clock runs alongside each regional entry.",
        phases: [
          phase("Critical groundwork -- 2L pot, weld stain fix, mirror finish, handle relocation, larger set, new packaging", "Now, ~0.8yr -- 2 new SKUs", "active"),
          phase("Premium Africa + Budget Europe range -- in-house 3mm handle, thicker base, AFR+EU packaging, new box sizes", "Following phase -- 10 new SKUs", "upcoming"),
          phase("Europe compliance -- EN 12983-1, EDQM metals, per-country rules", "0.8-1.5yr, ~$130K", "upcoming"),
          phase("Premium Europe + Mid USA range -- forged off-the-shelf handles, riveted handles, glass lid, EU+USA premium packaging", "Following phase -- 10 new SKUs", "upcoming"),
          phase("USA compliance -- FDA, California AB 1200, PFAS", "0.8-1.5yr, ~$110K", "upcoming"),
        ],
      },
      costResource: {
        notes: "Team utilization pulled from the Q4 2026 product roadmap's Cookware page. Regional compliance budget (Europe ~$130K, USA ~$110K) is carried on the Timeline tab against the phase it gates.",
        rows: [
          cost("NPD (mechanical)", "5 hrs/wk", "2L pot DOE, BOM development"),
          cost("NPI", "40 hrs/wk", "Packaging, containerization, drawing development"),
          cost("QC", "40 hrs/wk", ""),
          cost("Tooling", "40 hrs/wk", "Pot handle welding jig for 6L/8L pots"),
          cost("Market research, PME, product manager, industrial design", "Ongoing", "Cookware premiumization research"),
        ],
      },
      impact: {
        notes: "US saucepans run $38/pc, sets $175 -- the open lane is a branded premium stainless set at $150-350, between Cuisinart and All-Clad. Fully-clad construction (+$64) and a 10-yr+ warranty (+$33) are the two real premiums buyers pay for; \"18/10\" grade and polish are table-stakes, not differentiators.",
        stats: [
          stat("TAM (EU + US stainless)", "$2.6bn"),
          stat("SAM (mid-premium, online first)", "$0.5-1.2bn"),
          stat("Unknown-brand SOM", "$0.5-2.5m/yr"),
          stat("Established-brand SOM", "$12-36m/yr"),
          stat("Private-label SOM (per programme won)", "$5-30m"),
        ],
      },
      priority: {
        score: 3,
        notes: "Ranked 3/5 on the Hardware roadmap for the cost-down sandwich change; premiumization itself sits at 0.5/5 pending the B2B strategy question below.",
        questions: [
          q("Premiumization is a B2B/private-label play -- we do B2C mainly today via the electric bundle. What's the opportunity, and can we review the supply-deal strategy? Does a unique SKU eat into electric B2C margins?"),
          q("Why are we making a chapati pan?"),
          q("Construction fork -- Europe: encapsulated disc (MVP) vs. fully clad (premium upsell, only if chasing the Fissler tier). America: full-cap aluminium-core disc (MVP, proven by Farberware) vs. fully clad (premium build)."),
        ],
      },
    };
  }

  function seedDeepDiveFor(project) {
    const isCookware = (project.productCategory || "").toLowerCase() === "cookware" || /cookware/i.test(project.name || "") || /cookware/i.test(project.product || "");
    return isCookware ? cookwareDeepDiveSeed() : emptyDeepDive();
  }

  function loadDeepDive(project) {
    let raw = null;
    try { raw = localStorage.getItem(deepDiveKey(project.id)); } catch { /* ignore */ }
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        return { ...emptyDeepDive(), ...parsed };
      } catch { /* fall through to a fresh seed below */ }
    }
    return seedDeepDiveFor(project);
  }

  function saveDeepDive(projectId, data) {
    try { localStorage.setItem(deepDiveKey(projectId), JSON.stringify(data)); } catch { /* quota or private mode -- edits still work for the rest of this session */ }
  }

  // `data` is optional -- pass the already-loaded deep dive when rendering
  // the open modal's header (avoids a redundant localStorage read); card
  // renderers omit it and this loads it directly, which is a cheap
  // localStorage.getItem per visible card and keeps a card's mini-icon in
  // sync with whatever custom icon/photo was set from inside the modal.
  // `coverPhoto` is the single source of truth for a project's image --
  // set once in the Deep Dive header, it's what shows up everywhere this is
  // called (project cards, kanban, etc.), not just inside the modal.
  // `icon.photo` is only read as a fallback for data saved before this
  // became one unified image.
  function deepDiveIconHtml(project, data) {
    const d = data || loadDeepDive(project);
    if (d && d.coverPhoto) return `<img src="${escapeHtml(d.coverPhoto)}" alt="" />`;
    if (d && d.icon && d.icon.photo) return `<img src="${escapeHtml(d.icon.photo)}" alt="" />`;
    if (d && d.icon && d.icon.emoji) return escapeHtml(d.icon.emoji);
    return escapeHtml(DEEPDIVE_CATEGORY_ICON[project.productCategory] || "📦");
  }

  // ---- modal state + open/close -------------------------------------------
  let deepDiveState = null; // { project, data, activeTab }
  let cropState = null; // { naturalW, naturalH, viewportSize, baseScale, scale, tx, ty, dragging, startX, startY, startTx, startTy }

  function openDeepDive(projectId) {
    const project = findProject(projectId);
    if (!project) return;
    const data = loadDeepDive(project);
    deepDiveState = { project, data, activeTab: "scope" };
    renderDeepDiveHeader();
    renderDeepDiveCover();
    renderDeepDiveTabs();
    renderDeepDiveBody();
    // The Timeline tab's "Live from ClickUp" feed reads weeklyData, which is
    // otherwise only fetched on first visiting Weekly Activity/Resources --
    // kick it off here too so opening a Deep Dive straight from, say, By
    // Category still gets live data instead of the "give it a moment" note.
    // Guarded so it only re-renders if this same project's Timeline tab is
    // still open once the (possibly slow) fetch resolves.
    if (!weeklyLoaded) {
      loadWeekly().then(() => {
        if (deepDiveState && deepDiveState.project.id === projectId && deepDiveState.activeTab === "timeline") {
          renderDeepDiveBody();
        }
      });
    }
    document.getElementById("deepdive-overlay").hidden = false;
    document.body.classList.add("deepdive-open");
  }

  function closeDeepDive() {
    const overlay = document.getElementById("deepdive-overlay");
    if (overlay) overlay.hidden = true;
    const picker = document.getElementById("deepdive-icon-picker");
    if (picker) picker.hidden = true;
    document.body.classList.remove("deepdive-open");
    // A cover-photo/emoji change made just now (deepDiveIconHtml reads it
    // straight from localStorage) is otherwise invisible until the next full
    // data refresh -- re-render every card grid that shows this project's
    // thumbnail so closing the modal shows it applied immediately.
    if (typeof renderGroupedTabs === "function") renderGroupedTabs();
    if (typeof renderWorkloadKanban === "function" && window.__portfolioData) {
      renderWorkloadKanban(window.__portfolioData.workload, weeklyData);
    }
    deepDiveState = null;
  }

  function persistDeepDiveState() {
    if (!deepDiveState) return;
    saveDeepDive(deepDiveState.project.id, deepDiveState.data);
  }

  function renderDeepDiveHeader() {
    const { project, data } = deepDiveState;
    document.getElementById("deepdive-eyebrow").textContent = project.productCategory || "Uncategorized";
    document.getElementById("deepdive-title").textContent = project.name;
    const gate = project.currentGate || project.gatePhase;
    document.getElementById("deepdive-meta").innerHTML = `
      <span class="health-pill"><span class="status-dot ${project.healthBucket}"></span>${escapeHtml(HEALTH_LABEL[project.healthBucket] || project.healthBucket)}</span>
      ${gate ? `<span class="checklist-gate-pill">${escapeHtml(gate)}</span>` : ""}`;
    const link = document.getElementById("deepdive-clickup-link");
    link.style.display = project.url ? "" : "none";
    link.href = project.url || "#";

    // Quick facts -- a snapshot of this project's own Cost & Resource /
    // Priority tabs, surfaced right in the header (see .deepdive-quick-facts
    // in style.css) so a PM scanning between projects sees "who's on this
    // and what's the live call" without clicking into either tab. Same
    // source data the weekly export already reuses (priorityColumnText,
    // costResource.rows) -- nothing new to maintain.
    const factsEl = document.getElementById("deepdive-quick-facts");
    if (factsEl) {
      const teamRows = (data.costResource && data.costResource.rows) || [];
      const teamChips = teamRows
        .filter((r) => r.role)
        .map((r) => `<span class="deepdive-fact-chip">${escapeHtml(r.role)}${r.effort ? ` · ${escapeHtml(r.effort)}` : ""}</span>`)
        .join("");
      const priorityText = priorityColumnText(data);
      if (!teamChips && !priorityText) {
        factsEl.innerHTML = `<div class="deepdive-fact-empty">Fill in Cost &amp; Resource / Priority to see a quick summary here.</div>`;
      } else {
        factsEl.innerHTML = `
          ${teamChips ? `<div class="deepdive-fact-group">${teamChips}</div>` : ""}
          ${priorityText ? `<div class="deepdive-fact-priority">${escapeHtml(priorityText)}</div>` : ""}`;
      }
    }
  }

  // The one square photo/emoji tile -- serves as both this project's cover
  // and, via deepDiveIconHtml, its thumbnail everywhere else in the
  // dashboard. Shows the photo when set; otherwise a large emoji (the
  // project's own choice, or the category default) fills the same square.
  function renderDeepDiveCover() {
    const { project, data } = deepDiveState;
    const img = document.getElementById("deepdive-cover-img");
    const emojiEl = document.getElementById("deepdive-cover-emoji");
    const removeBtn = document.getElementById("deepdive-cover-remove");
    const recropBtn = document.getElementById("deepdive-cover-recrop");
    const zoomHint = document.getElementById("deepdive-cover-zoom-hint");
    // Icon-only now (see deepdive-cover-actions in index.html) -- the label
    // itself carries the tooltip text that used to be spelled out next to
    // the 📷, rather than the icon span's own text.
    const uploadLabel = document.getElementById("deepdive-cover-upload-label");
    if (!img || !emojiEl || !removeBtn) return;
    if (data.coverPhoto) {
      img.src = data.coverPhoto;
      img.hidden = false;
      emojiEl.hidden = true;
      removeBtn.hidden = false;
      if (recropBtn) recropBtn.hidden = false;
      if (zoomHint) zoomHint.hidden = false;
      if (uploadLabel) uploadLabel.title = "Change photo";
    } else {
      img.hidden = true;
      img.removeAttribute("src");
      emojiEl.hidden = false;
      emojiEl.textContent = (data.icon && data.icon.emoji) || DEEPDIVE_CATEGORY_ICON[project.productCategory] || "📦";
      removeBtn.hidden = true;
      if (recropBtn) recropBtn.hidden = true;
      if (zoomHint) zoomHint.hidden = true;
      if (uploadLabel) uploadLabel.title = "Add photo";
    }
    // Only offer the emoji picker when there's no photo to choose between --
    // once a photo is set, it wins in deepDiveIconHtml regardless of any
    // emoji choice, so picking one then would silently do nothing.
    const emojiBtn = document.getElementById("deepdive-cover-emoji-btn");
    if (emojiBtn) emojiBtn.hidden = !!data.coverPhoto;
  }

  function deepDiveTabHasOpenItems(tabKey, data) {
    if (tabKey === "priority") return (data.priority.questions || []).some((q) => !q.resolved);
    return false;
  }

  function renderDeepDiveTabs() {
    const { data, activeTab } = deepDiveState;
    document.getElementById("deepdive-tabs").innerHTML = DEEPDIVE_TABS.map((t) => `
      <button type="button" class="deepdive-tab${t.key === activeTab ? " active" : ""}${deepDiveTabHasOpenItems(t.key, data) ? " has-open" : ""}" data-tab="${t.key}">
        <span class="deepdive-tab-icon">${t.icon}</span>${escapeHtml(t.label)}<span class="deepdive-tab-flag" title="Has open items"></span>
      </button>`).join("");
  }

  function renderDeepDiveBody() {
    const { data, activeTab, project } = deepDiveState;
    const body = document.getElementById("deepdive-body");
    if (activeTab === "scope") body.innerHTML = deepDiveScopeHtml(data.scope);
    else if (activeTab === "timeline") body.innerHTML = deepDiveTimelineHtml(data.timeline, project);
    else if (activeTab === "costResource") body.innerHTML = deepDiveCostHtml(data.costResource);
    else if (activeTab === "impact") body.innerHTML = deepDiveImpactHtml(data.impact);
    else if (activeTab === "priority") body.innerHTML = deepDivePriorityHtml(data.priority);
  }

  function deepDiveScopeHtml(scope) {
    return `
      <p class="deepdive-section-intro">The product's working feature list -- what, its current stage, and why -- in the same Feature / Stage / Rationale / Lift shape used in product-development decks. Leave any cell blank until it's known.</p>
      <table class="deepdive-table">
        <thead><tr><th style="width:26%">Feature</th><th style="width:22%">Stage</th><th style="width:32%">Rationale</th><th style="width:12%">Lift</th><th></th></tr></thead>
        <tbody>
          ${(scope.rows || []).map((r) => `
            <tr data-row-id="${r.id}">
              <td><input type="text" data-field="feature" value="${escapeHtml(r.feature)}" placeholder="e.g. 2L pot" /></td>
              <td><input type="text" data-field="stage" value="${escapeHtml(r.stage)}" placeholder="e.g. Detailed design" /></td>
              <td><input type="text" data-field="rationale" value="${escapeHtml(r.rationale)}" placeholder="Why this, why now" /></td>
              <td><input type="text" data-field="lift" value="${escapeHtml(r.lift)}" placeholder="Low/Med/High" /></td>
              <td><button type="button" class="deepdive-row-remove" data-remove-row="${r.id}" title="Remove">&times;</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
      <button type="button" class="deepdive-add-row-btn" data-add-row="scope">+ Add scope item</button>
      <div class="deepdive-field-block" style="margin-top:16px;">
        <label class="deepdive-field-label">Notes</label>
        <textarea class="deepdive-textarea" data-field="notes" placeholder="Open scope questions, constraints, links to specs...">${escapeHtml(scope.notes)}</textarea>
      </div>`;
  }

  // Read-only, straight off /api/weekly's per-project openTasks (the same
  // data Resources' workload board reads) -- never edited here, unlike the
  // hand-curated phases below. Deliberately kept separate: this shows
  // "what's actually happening in ClickUp right now," the phases list is
  // the PM's own higher-level roadmap read on the project, and conflating
  // the two would mean losing one or the other on every edit.
  //
  // Split into two views rather than one flat list: a near-term list (this
  // week -- the stuff a PM actually needs to act on right now) and a
  // comprehensive mini Gantt below it showing every dated open task on one
  // timeline, so the full shape of the project's remaining work is visible
  // without scrolling a long list. Was 30 days, which routinely surfaced 90+
  // tasks -- not "near-term" by any useful reading of the word; a flat
  // "next N days" rolling window was the next attempt, but that meant
  // Weekly Activity's "this week" and the Deep Dive's "near-term" meant two
  // different date ranges for the exact same phrase. Now both mean the
  // literal same Monday-through-Sunday window (see currentWeekBoundsMs) --
  // one definition of "this week" for the whole app, not a second one
  // invented here.
  const DEEPDIVE_NEAR_TERM_LABEL = "this week";

  // Monday 00:00 (local) through the following Monday 00:00, exclusive --
  // the same week boundary Weekly Activity already uses (see
  // currentWeekRangeLabel/isIsoInCurrentWeek above), just returned as
  // {startMs, endMs} instead of a label or an ISO-string-only check, so the
  // Deep Dive's near-term filter (which compares against epoch-ms numbers,
  // not ISO strings -- see the Date.parse-vs-new-Date note below) can reuse
  // the exact same "this week" definition instead of its own rolling
  // N-days-from-now window.
  function currentWeekBoundsMs(now = new Date()) {
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    monday.setDate(monday.getDate() - ((now.getDay() + 6) % 7));
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);
    return { startMs: monday.getTime(), endMs: nextMonday.getTime() };
  }

  // `project` is the full portfolio project (not just its id) so the
  // comprehensive timeline below can plot the project's own target gate
  // date as a second "important day" marker alongside today -- see
  // gateInfo below and deepDiveMiniGanttHtml's GATE marker.
  function deepDiveClickupLiveHtml(project) {
    const projectId = project.id;
    const wp = weeklyData && Array.isArray(weeklyData.projects) ? weeklyData.projects.find((p) => p.id === projectId) : null;
    if (!wp) {
      return `<div class="deepdive-clickup-live-note">Live ClickUp activity will appear here once Weekly Activity data has loaded — give it a moment and reopen this tab.</div>`;
    }
    const gateDateMs = project.targetGateDate ? new Date(project.targetGateDate).getTime() : NaN;
    const gateInfo = Number.isFinite(gateDateMs)
      ? { label: project.currentGate || project.gatePhase || "Gate", dateMs: gateDateMs }
      : null;
    const allOpen = (wp.openTasks || []).filter((t) => t.statusType !== "done");
    if (allOpen.length === 0) {
      return `<div class="deepdive-clickup-live-note">No open ClickUp subtasks found for this project.</div>`;
    }

    // openTasks' startDate/dueDate come through as epoch-ms numbers (see
    // flattenOpenTasks in transform.js), not ISO strings -- new Date(x)
    // handles both a number and a string correctly, where Date.parse(x)
    // would silently return NaN on a number (it coerces to a string first,
    // which isn't a parseable date format).
    // Both bounds now apply -- "this week" means literally this Monday
    // through Sunday, nothing outside it. An earlier version left the lower
    // bound open ("anything overdue belongs in this week regardless of how
    // long ago it was due"), which in practice meant a task due back at
    // kickoff, months ago, that ClickUp still marked open would sit at the
    // top of "near-term (this week)" forever. Old overdue work like that is
    // still visible -- it's just in the comprehensive timeline below, not
    // this "act on it this week" list.
    const { startMs: nearTermStartMs, endMs: nearTermCutoffMs } = currentWeekBoundsMs();
    const nearTerm = allOpen
      .filter((t) => {
        const ms = t.dueDate ? new Date(t.dueDate).getTime() : t.startDate ? new Date(t.startDate).getTime() : NaN;
        return Number.isFinite(ms) && ms >= nearTermStartMs && ms < nearTermCutoffMs;
      })
      .sort((a, b) => new Date(a.dueDate || a.startDate).getTime() - new Date(b.dueDate || b.startDate).getTime());

    const shown = nearTerm.slice(0, 20);
    const rows = shown
      .map((t) => {
        const dateLabel = t.dueDate
          ? `Due ${fmtDate(new Date(t.dueDate).toISOString())}`
          : t.startDate
          ? `Starts ${fmtDate(new Date(t.startDate).toISOString())}`
          : "No date set";
        return `
          <li class="deepdive-clickup-live-item">
            <span class="status-dot active"></span>
            <span class="deepdive-clickup-live-name">${escapeHtml(t.name)}</span>
            <span class="deepdive-clickup-live-status">${escapeHtml(t.status || "")}</span>
            <span class="deepdive-clickup-live-date">${escapeHtml(dateLabel)}</span>
          </li>`;
      })
      .join("");
    const moreNote = nearTerm.length > shown.length ? `<div class="deepdive-clickup-live-more">+ ${nearTerm.length - shown.length} more in the ${DEEPDIVE_NEAR_TERM_LABEL}</div>` : "";
    const nearTermBody = nearTerm.length
      ? `<ul class="deepdive-clickup-live-list">${rows}</ul>${moreNote}`
      : `<div class="deepdive-clickup-live-note">Nothing starting or due in the ${DEEPDIVE_NEAR_TERM_LABEL}.</div>`;

    const datedTasks = allOpen.filter((t) => t.startDate || t.dueDate);
    const undatedCount = allOpen.length - datedTasks.length;
    const undatedNote = undatedCount > 0
      ? `<div class="deepdive-clickup-live-more">+ ${undatedCount} more open with no date set — see Weekly Activity's Product Backlog</div>`
      : "";

    return `
      <div class="deepdive-clickup-live">
        <div class="deepdive-clickup-live-title">Near-term (${DEEPDIVE_NEAR_TERM_LABEL}) <span class="deepdive-clickup-live-count">${nearTerm.length} open</span></div>
        ${nearTermBody}
      </div>
      <div class="deepdive-gantt-block">
        <div class="deepdive-clickup-live-title">Comprehensive timeline <span class="deepdive-clickup-live-count">${datedTasks.length} dated task${datedTasks.length === 1 ? "" : "s"}</span></div>
        ${deepDiveMiniGanttHtml(datedTasks, gateInfo)}
        ${undatedNote}
      </div>`;
  }

  // Task-level counterpart to renderGantt() (which plots one bar per
  // project) -- same visual language (quarter + month header, shaded
  // bands, dashed "assumed" bars when only a due date is known) but scoped
  // to one project's own open tasks and returned as a markup string, since
  // the Deep Dive body is re-rendered wholesale rather than owning a
  // persistent container the way the Gantt tab does. Reuses the Gantt
  // tab's own constants/helpers (GANTT_PX_PER_DAY, quarterStart,
  // monthStart, etc. -- defined once, below, in the same module) rather
  // than duplicating that math.
  //
  // Borrows two ideas straight from how the PM roadmap decks (the kind
  // exported as PPTX elsewhere in this app) lay out a timeline: a month
  // row under the quarter row so a bar's rough date reads at a glance
  // without hovering, and "important day" markers -- not just today, but
  // this project's own next stage gate -- called out as a labeled vertical
  // line rather than left for the viewer to eyeball against the axis.
  // `gateInfo` is optional ({ label, dateMs }, see deepDiveClickupLiveHtml)
  // -- omitted or outside the visible range, the gate marker just doesn't
  // render.
  const DEEPDIVE_GANTT_LABEL_WIDTH = 170;
  function deepDiveMiniGanttHtml(tasks, gateInfo) {
    const bars = tasks
      .map((t) => {
        // Same epoch-ms-not-ISO-string shape as the near-term filter above
        // -- new Date(x), not Date.parse(x).
        const dueMs = t.dueDate ? new Date(t.dueDate).getTime() : NaN;
        const realStartMs = t.startDate ? new Date(t.startDate).getTime() : NaN;
        let endMs = Number.isFinite(dueMs) ? dueMs : realStartMs;
        let startMs = Number.isFinite(realStartMs) ? realStartMs : dueMs;
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
        const assumed = !Number.isFinite(realStartMs);
        if (startMs > endMs) startMs = endMs;
        return { t, startMs, endMs, assumed };
      })
      .filter(Boolean)
      .sort((a, b) => a.startMs - b.startMs);

    if (bars.length === 0) {
      return `<div class="deepdive-clickup-live-note">No dated tasks yet to plot on a timeline.</div>`;
    }

    const LABEL_WIDTH = DEEPDIVE_GANTT_LABEL_WIDTH;
    const earliestStart = new Date(Math.min(...bars.map((b) => b.startMs)));
    const latestEnd = new Date(Math.max(...bars.map((b) => b.endMs)));
    const rangeStart = quarterStart(earliestStart);
    const rangeEnd = quarterEndExclusive(latestEnd);
    const rangeStartMs = rangeStart.getTime();
    const totalDays = Math.max(1, Math.round((rangeEnd.getTime() - rangeStartMs) / DAY_MS));
    const timelineWidth = totalDays * GANTT_PX_PER_DAY;

    const QUARTER_LABEL = ["Q1", "Q2", "Q3", "Q4"];
    const quarters = [];
    let cursor = new Date(rangeStart);
    while (cursor.getTime() < rangeEnd.getTime()) {
      const qStart = new Date(cursor);
      const qEnd = quarterEndExclusive(qStart);
      const days = Math.round((qEnd.getTime() - qStart.getTime()) / DAY_MS);
      quarters.push({
        label: `${QUARTER_LABEL[quarterOf(qStart)]} ${qStart.getFullYear()}`,
        leftPx: ((qStart.getTime() - rangeStartMs) / DAY_MS) * GANTT_PX_PER_DAY,
        widthPx: days * GANTT_PX_PER_DAY,
      });
      cursor = qEnd;
    }
    const quartersHtml = quarters
      .map((q, i) => `<div class="gantt-quarter${i % 2 === 1 ? " gantt-quarter-shaded" : ""}" style="left:${q.leftPx}px;width:${q.widthPx}px;">${escapeHtml(q.label)}</div>`)
      .join("");
    const quarterBandsHtml = quarters
      .map((q, i) => (i % 2 === 1 ? `<div class="gantt-quarter-band" style="left:${q.leftPx}px;width:${q.widthPx}px;"></div>` : ""))
      .join("");

    // Second, finer header row -- same axis, labeled by month -- exactly
    // the two-tier pattern renderGantt() already uses on the main Gantt
    // tab (reusing its monthStart/monthEndExclusive + .gantt-months/
    // .gantt-month styling rather than inventing a second look here).
    const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const months = [];
    cursor = new Date(rangeStart);
    while (cursor.getTime() < rangeEnd.getTime()) {
      const mStart = new Date(cursor);
      const mEnd = monthEndExclusive(mStart);
      const days = Math.round((mEnd.getTime() - mStart.getTime()) / DAY_MS);
      months.push({
        label: `${MONTH_LABEL[mStart.getMonth()]} ${mStart.getFullYear()}`,
        leftPx: ((mStart.getTime() - rangeStartMs) / DAY_MS) * GANTT_PX_PER_DAY,
        widthPx: days * GANTT_PX_PER_DAY,
      });
      cursor = mEnd;
    }
    const monthsHtml = months
      .map((m) => `<div class="gantt-month" style="left:${m.leftPx}px;width:${m.widthPx}px;">${escapeHtml(m.label)}</div>`)
      .join("");

    // "Important day" markers: today, always, plus this project's own next
    // stage gate when it falls inside the plotted range -- a labeled
    // vertical line each, not just today's plain rule, so the one date
    // that actually matters most for THIS project (not just "now") is
    // called out the same way a roadmap deck would flag it.
    const inRange = (ms) => ms >= rangeStartMs && ms <= rangeEnd.getTime();
    const markerHtml = (ms, label, kind) =>
      inRange(ms)
        ? `<div class="deepdive-gantt-marker deepdive-gantt-marker-${kind}" style="left:${LABEL_WIDTH + ((ms - rangeStartMs) / DAY_MS) * GANTT_PX_PER_DAY}px;"><span class="deepdive-gantt-marker-tag">${escapeHtml(label)}</span></div>`
        : "";
    const nowMs = Date.now();
    const markersHtml =
      markerHtml(nowMs, "Today", "today") +
      (gateInfo ? markerHtml(gateInfo.dateMs, gateInfo.label, "gate") : "");

    const rowsHtml = bars
      .map(({ t, startMs, endMs, assumed }) => {
        const leftPx = ((startMs - rangeStartMs) / DAY_MS) * GANTT_PX_PER_DAY;
        const widthPx = Math.max(((endMs - startMs) / DAY_MS) * GANTT_PX_PER_DAY, GANTT_MIN_BAR_PX);
        const statusClass = t.statusType === "done" || t.statusType === "closed" ? "completed" : "active";
        const startLabel = assumed ? `~${fmtDate(new Date(startMs).toISOString())} (assumed from due date)` : fmtDate(new Date(startMs).toISOString());
        const tooltip = `${t.name} — ${startLabel} → ${fmtDate(new Date(endMs).toISOString())}${t.status ? ` · ${t.status}` : ""}`;
        return `
          <div class="gantt-row">
            <div class="gantt-row-label">
              <span class="deepdive-clickup-live-name">${escapeHtml(t.name)}</span>
            </div>
            <div class="gantt-row-track" style="width:${timelineWidth}px;">
              <div class="gantt-bar ${statusClass}${assumed ? " gantt-bar-assumed" : ""}" style="left:${leftPx}px;width:${widthPx}px;" title="${escapeHtml(tooltip)}"></div>
            </div>
          </div>`;
      })
      .join("");

    return `
      <div class="deepdive-gantt-scroll">
        <div class="gantt-inner">
          <div class="gantt-header" style="width:${LABEL_WIDTH + timelineWidth}px;">
            <div class="gantt-header-row">
              <div class="gantt-header-spacer" style="width:${LABEL_WIDTH}px;"></div>
              <div class="gantt-quarters" style="width:${timelineWidth}px;">${quartersHtml}</div>
            </div>
            <div class="gantt-header-row gantt-header-row-months">
              <div class="gantt-header-spacer" style="width:${LABEL_WIDTH}px;"></div>
              <div class="gantt-months" style="width:${timelineWidth}px;">${monthsHtml}</div>
            </div>
          </div>
          <div class="gantt-body" style="width:${LABEL_WIDTH + timelineWidth}px;">
            <div class="gantt-quarter-bands" style="left:${LABEL_WIDTH}px;width:${timelineWidth}px;">${quarterBandsHtml}</div>
            ${rowsHtml}
          </div>
          ${markersHtml}
        </div>
      </div>`;
  }

  function deepDiveTimelineHtml(timeline, project) {
    return `
      ${deepDiveClickupLiveHtml(project)}
      <p class="deepdive-section-intro">The phases this project actually moves through -- each with a rough window and a status. Not a synced Gantt; just enough structure to see what's next.</p>
      <div class="deepdive-timeline">
        ${(timeline.phases || []).map((ph) => `
          <div class="deepdive-phase" data-row-id="${ph.id}">
            <input type="text" data-field="label" value="${escapeHtml(ph.label)}" placeholder="Phase / milestone" />
            <input type="text" data-field="window" value="${escapeHtml(ph.window)}" placeholder="e.g. Q1 27, or 0.8-1.5yr" />
            <select data-field="status" class="deepdive-phase-status-${ph.status || "upcoming"}">
              <option value="upcoming"${ph.status === "upcoming" || !ph.status ? " selected" : ""}>Upcoming</option>
              <option value="active"${ph.status === "active" ? " selected" : ""}>In progress</option>
              <option value="done"${ph.status === "done" ? " selected" : ""}>Done</option>
            </select>
            <button type="button" class="deepdive-row-remove" data-remove-row="${ph.id}" title="Remove">&times;</button>
          </div>`).join("")}
      </div>
      <button type="button" class="deepdive-add-row-btn" data-add-row="timeline">+ Add phase</button>
      <div class="deepdive-field-block" style="margin-top:16px;">
        <label class="deepdive-field-label">Notes</label>
        <textarea class="deepdive-textarea" data-field="notes" placeholder="Sequencing notes, dependencies, what's blocking the next phase...">${escapeHtml(timeline.notes)}</textarea>
      </div>`;
  }

  function deepDiveCostHtml(costResource) {
    return `
      <p class="deepdive-section-intro">Who this needs and how much of them -- team hours per week, or a budget line, per function. Matches the "Team Utilization/Week" shape used in the roadmap decks.</p>
      <table class="deepdive-table">
        <thead><tr><th style="width:30%">Role / function</th><th style="width:20%">Effort or cost</th><th style="width:42%">Notes</th><th></th></tr></thead>
        <tbody>
          ${(costResource.rows || []).map((r) => `
            <tr data-row-id="${r.id}">
              <td><input type="text" data-field="role" value="${escapeHtml(r.role)}" placeholder="e.g. NPD (mechanical)" /></td>
              <td><input type="text" data-field="effort" value="${escapeHtml(r.effort)}" placeholder="e.g. 20 hrs/wk, or $130K" /></td>
              <td><input type="text" data-field="notes" value="${escapeHtml(r.notes)}" placeholder="What they're doing" /></td>
              <td><button type="button" class="deepdive-row-remove" data-remove-row="${r.id}" title="Remove">&times;</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
      <button type="button" class="deepdive-add-row-btn" data-add-row="costResource">+ Add line</button>
      <div class="deepdive-field-block" style="margin-top:16px;">
        <label class="deepdive-field-label">Notes</label>
        <textarea class="deepdive-textarea" data-field="notes" placeholder="Budget caveats, funding source, what's still an estimate...">${escapeHtml(costResource.notes)}</textarea>
      </div>`;
  }

  function deepDiveImpactHtml(impact) {
    return `
      <p class="deepdive-section-intro">Why this matters -- market size, revenue potential, or whatever number makes the case. Add as many stat cards as are relevant; leave the value blank until there's a real one.</p>
      <div class="deepdive-impact-stats">
        ${(impact.stats || []).map((s) => `
          <div class="deepdive-impact-stat" data-row-id="${s.id}">
            <label>
              <input type="text" data-field="label" value="${escapeHtml(s.label)}" placeholder="Stat label" style="font-weight:600;font-size:11px;text-transform:none;letter-spacing:0;color:var(--text-secondary);" />
            </label>
            <input type="text" data-field="value" value="${escapeHtml(s.value)}" placeholder="—" />
            <button type="button" class="deepdive-row-remove" data-remove-row="${s.id}" title="Remove" style="margin-top:6px;">&times;</button>
          </div>`).join("")}
      </div>
      <button type="button" class="deepdive-add-row-btn" data-add-row="impact">+ Add stat</button>
      <div class="deepdive-field-block" style="margin-top:16px;">
        <label class="deepdive-field-label">Notes</label>
        <textarea class="deepdive-textarea" data-field="notes" placeholder="What the numbers mean, sources, caveats...">${escapeHtml(impact.notes)}</textarea>
      </div>`;
  }

  function deepDivePriorityHtml(priority) {
    const score = priority.score == null ? 3 : priority.score;
    return `
      <p class="deepdive-section-intro">How urgently this needs attention right now, plus the open questions standing between here and a clear plan -- check one off once it's answered. This is the "true north" view: different projects need different, dynamic attention, and that's fine.</p>
      <div class="deepdive-field-block">
        <label class="deepdive-field-label">Priority (0 = someday, 5 = do this now)</label>
        <div class="deepdive-priority-score">
          <input type="range" min="0" max="5" step="0.5" value="${escapeHtml(String(score))}" data-field="score" />
          <span class="deepdive-priority-score-value" id="deepdive-priority-score-value">${score}</span>
        </div>
      </div>
      <div class="deepdive-questions">
        ${(priority.questions || []).map((q) => `
          <div class="deepdive-question${q.resolved ? " resolved" : ""}" data-row-id="${q.id}">
            <input type="checkbox" data-field="resolved" ${q.resolved ? "checked" : ""} title="Resolved" />
            <span class="deepdive-question-text"><input type="text" data-field="text" value="${escapeHtml(q.text)}" placeholder="An open question standing in the way..." /></span>
            <button type="button" class="deepdive-row-remove" data-remove-row="${q.id}" title="Remove">&times;</button>
          </div>`).join("")}
      </div>
      <button type="button" class="deepdive-add-row-btn" data-add-row="priority">+ Add open question</button>
      <div class="deepdive-field-block" style="margin-top:16px;">
        <label class="deepdive-field-label">Notes</label>
        <textarea class="deepdive-textarea" data-field="notes" placeholder="Why this priority, what would change it...">${escapeHtml(priority.notes)}</textarea>
      </div>`;
  }

  // Section key -> the array field on data[activeTab] that rows/phases/etc
  // live in, so add/remove handlers stay generic across all four row-shaped
  // tabs (priority's rows are called "questions", everyone else's "rows"/
  // "phases").
  const DEEPDIVE_LIST_FIELD = { scope: "rows", timeline: "phases", costResource: "rows", impact: "stats", priority: "questions" };

  function deepDiveAddRow(sectionKey) {
    const { data } = deepDiveState;
    const section = data[sectionKey];
    const listField = DEEPDIVE_LIST_FIELD[sectionKey];
    let blank;
    if (sectionKey === "scope") blank = { id: deepDiveRowId(), feature: "", stage: "", rationale: "", lift: "" };
    else if (sectionKey === "timeline") blank = { id: deepDiveRowId(), label: "", window: "", status: "upcoming" };
    else if (sectionKey === "costResource") blank = { id: deepDiveRowId(), role: "", effort: "", notes: "" };
    else if (sectionKey === "impact") blank = { id: deepDiveRowId(), label: "", value: "" };
    else if (sectionKey === "priority") blank = { id: deepDiveRowId(), text: "", resolved: false };
    section[listField].push(blank);
    persistDeepDiveState();
    renderDeepDiveBody();
    renderDeepDiveTabs();
  }

  function deepDiveRemoveRow(sectionKey, rowId) {
    const { data } = deepDiveState;
    const section = data[sectionKey];
    const listField = DEEPDIVE_LIST_FIELD[sectionKey];
    section[listField] = section[listField].filter((r) => r.id !== rowId);
    persistDeepDiveState();
    renderDeepDiveBody();
    renderDeepDiveTabs();
  }

  // Wired once at startup -- all events inside the modal are delegated
  // through these three listeners rather than re-bound on every render.
  function setupDeepDive() {
    const overlay = document.getElementById("deepdive-overlay");
    if (!overlay) return;

    // Delegated at the document level (rather than bound per-card) since
    // every kanban board that uses `.deepdive-card` re-renders its cards
    // wholesale on every refresh -- a per-element listener would need
    // rebinding every time. The title link inside a card still opens
    // ClickUp normally; only a click elsewhere on the card opens the modal.
    document.addEventListener("click", (e) => {
      const card = e.target.closest(".deepdive-card");
      if (!card || e.target.closest("a")) return;
      openDeepDive(card.dataset.projectId);
    });

    document.getElementById("deepdive-close").addEventListener("click", closeDeepDive);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDeepDive(); });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      // Innermost overlay closes first -- Escape on the crop tool or
      // lightbox shouldn't also drop the whole Deep Dive underneath it.
      const cropOverlay = document.getElementById("crop-overlay");
      const lightbox = document.getElementById("cover-lightbox-overlay");
      if (cropOverlay && !cropOverlay.hidden) { closeCoverCropper(); return; }
      if (lightbox && !lightbox.hidden) { closeCoverLightbox(); return; }
      if (deepDiveState) closeDeepDive();
    });

    document.getElementById("deepdive-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".deepdive-tab");
      if (!btn || !deepDiveState) return;
      deepDiveState.activeTab = btn.dataset.tab;
      renderDeepDiveTabs();
      renderDeepDiveBody();
    });

    // Emoji picker: "Choose emoji instead" (only shown when there's no cover
    // photo -- see renderDeepDiveCover) opens a small popover with a curated
    // emoji grid. Photo upload lives entirely in the cover-actions row now
    // (one image, not a separate icon-photo path) -- this picker only ever
    // sets/clears data.icon.emoji.
    const emojiBtn = document.getElementById("deepdive-cover-emoji-btn");
    const picker = document.getElementById("deepdive-icon-picker");
    if (emojiBtn) {
      emojiBtn.addEventListener("click", () => {
        if (!deepDiveState) return;
        if (!picker.hidden) { picker.hidden = true; return; }
        picker.innerHTML = `
          <div class="deepdive-icon-grid">
            ${DEEPDIVE_ICON_CHOICES.map((e) => `<button type="button" class="deepdive-icon-option" data-icon-emoji="${escapeHtml(e)}">${e}</button>`).join("")}
          </div>
          <div class="deepdive-icon-picker-row">
            <button type="button" class="deepdive-icon-reset-btn" id="deepdive-icon-reset">Use category default</button>
          </div>`;
        picker.hidden = false;
      });
    }
    picker.addEventListener("click", (e) => {
      const emojiOption = e.target.closest("[data-icon-emoji]");
      if (emojiOption) {
        deepDiveState.data.icon = { emoji: emojiOption.dataset.iconEmoji };
        persistDeepDiveState();
        renderDeepDiveHeader();
        renderDeepDiveCover();
        picker.hidden = true;
        return;
      }
      if (e.target.id === "deepdive-icon-reset") {
        deepDiveState.data.icon = null;
        persistDeepDiveState();
        renderDeepDiveHeader();
        renderDeepDiveCover();
        picker.hidden = true;
      }
    });

    // Cover photo -- the one image for this project. A fresh upload (or
    // "Recrop" on the existing photo) opens the crop tool (wireCoverCropper
    // below) rather than saving a plain resize immediately; that tool's own
    // "Save photo" is what actually writes deepDiveState.data.coverPhoto,
    // rendered at a 1600x1600 cap. This same file is what's reused
    // everywhere else as the thumbnail (deepDiveIconHtml).
    const coverFile = document.getElementById("deepdive-cover-file");
    const coverRemoveBtn = document.getElementById("deepdive-cover-remove");
    const coverRecropBtn = document.getElementById("deepdive-cover-recrop");
    if (coverFile) {
      coverFile.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file || !deepDiveState) return;
        const reader = new FileReader();
        reader.onload = () => {
          openCoverCropper(reader.result);
          coverFile.value = "";
        };
        reader.readAsDataURL(file);
      });
    }
    if (coverRecropBtn) {
      coverRecropBtn.addEventListener("click", () => {
        if (!deepDiveState || !deepDiveState.data.coverPhoto) return;
        openCoverCropper(deepDiveState.data.coverPhoto);
      });
    }
    if (coverRemoveBtn) {
      coverRemoveBtn.addEventListener("click", () => {
        if (!deepDiveState) return;
        deepDiveState.data.coverPhoto = null;
        persistDeepDiveState();
        renderDeepDiveCover();
      });
    }

    // Clicking the cover (when a photo is set -- emoji fallback isn't worth
    // a lightbox) opens it full-size instead of squeezed into the ~180px
    // header tile.
    const coverBtn = document.getElementById("deepdive-cover");
    if (coverBtn) {
      coverBtn.addEventListener("click", () => {
        if (!deepDiveState || !deepDiveState.data.coverPhoto) return;
        openCoverLightbox(deepDiveState.data.coverPhoto);
      });
    }
    wireCoverLightbox();
    wireCoverCropper();

    const body = document.getElementById("deepdive-body");
    body.addEventListener("click", (e) => {
      const addBtn = e.target.closest("[data-add-row]");
      if (addBtn) { deepDiveAddRow(addBtn.dataset.addRow); return; }
      const removeBtn = e.target.closest("[data-remove-row]");
      if (removeBtn) {
        const sectionKey = deepDiveState.activeTab;
        deepDiveRemoveRow(sectionKey, removeBtn.dataset.removeRow);
      }
    });

    // Plain field edits (text/select/checkbox/range/notes textarea) update
    // the in-memory model and persist on every change, but deliberately
    // don't trigger a full re-render -- that would drop focus/cursor
    // position mid-keystroke. Structural changes (add/remove row, tab
    // switch) above re-render explicitly instead.
    function applyFieldEdit(e) {
      if (!deepDiveState) return;
      const field = e.target.dataset.field;
      if (!field) return;
      const sectionKey = deepDiveState.activeTab;
      const section = deepDiveState.data[sectionKey];
      const rowEl = e.target.closest("[data-row-id]");
      if (rowEl) {
        const listField = DEEPDIVE_LIST_FIELD[sectionKey];
        const row = section[listField].find((r) => r.id === rowEl.dataset.rowId);
        if (!row) return;
        if (field === "resolved") {
          row.resolved = e.target.checked;
          rowEl.classList.toggle("resolved", row.resolved);
          renderDeepDiveTabs();
        } else if (field === "status") {
          row.status = e.target.value;
          e.target.className = `deepdive-phase-status-${row.status}`;
        } else {
          row[field] = e.target.value;
        }
      } else if (field === "score") {
        section.score = Number(e.target.value);
        const label = document.getElementById("deepdive-priority-score-value");
        if (label) label.textContent = section.score;
      } else {
        section[field] = e.target.value;
      }
      persistDeepDiveState();
    }
    body.addEventListener("input", applyFieldEdit);
    body.addEventListener("change", applyFieldEdit);
  }

  // ---- Cover photo lightbox -------------------------------------------

  function openCoverLightbox(dataUrl) {
    const overlay = document.getElementById("cover-lightbox-overlay");
    const img = document.getElementById("cover-lightbox-img");
    if (!overlay || !img) return;
    img.src = dataUrl;
    overlay.hidden = false;
  }
  function closeCoverLightbox() {
    const overlay = document.getElementById("cover-lightbox-overlay");
    if (overlay) overlay.hidden = true;
  }
  function wireCoverLightbox() {
    const overlay = document.getElementById("cover-lightbox-overlay");
    const closeBtn = document.getElementById("cover-lightbox-close");
    if (!overlay) return;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeCoverLightbox(); });
    if (closeBtn) closeBtn.addEventListener("click", closeCoverLightbox);
  }

  // ---- Cover photo crop tool -------------------------------------------
  // A minimal drag-to-reposition + slider-to-zoom cropper: no library, just
  // pointer events on a fixed square viewport (#crop-viewport) and a CSS
  // transform (translate + scale, transform-origin 0 0) on the <img> inside
  // it. cropState tracks the current transform in *displayed* pixels so
  // drag/zoom math stays simple; "Save photo" converts that back into the
  // image's natural pixel coordinates to render the actual crop.

  function cropClamp(tx, ty, scale) {
    const dw = cropState.naturalW * scale;
    const dh = cropState.naturalH * scale;
    const v = cropState.viewportSize;
    // Image always covers the viewport at every zoom level (baseScale
    // guarantees that at zoom 1), so tx/ty only ever need to keep the
    // image's edges outside the viewport's edges -- never centered gaps.
    return {
      tx: Math.min(0, Math.max(v - dw, tx)),
      ty: Math.min(0, Math.max(v - dh, ty)),
    };
  }

  function cropApplyTransform() {
    const img = document.getElementById("crop-img");
    if (!img || !cropState) return;
    img.style.width = `${cropState.naturalW}px`;
    img.style.height = `${cropState.naturalH}px`;
    img.style.transform = `translate(${cropState.tx}px, ${cropState.ty}px) scale(${cropState.scale})`;
  }

  function openCoverCropper(sourceDataUrl) {
    const overlay = document.getElementById("crop-overlay");
    const img = document.getElementById("crop-img");
    const zoomInput = document.getElementById("crop-zoom");
    const viewport = document.getElementById("crop-viewport");
    if (!overlay || !img || !viewport) return;
    overlay.hidden = false;
    img.removeAttribute("style");

    let done = false;
    const finishSetup = () => {
      if (done) return; // guard against both the cache-hit check below AND a load event firing
      done = true;
      const naturalW = img.naturalWidth;
      const naturalH = img.naturalHeight;
      if (!naturalW || !naturalH) {
        // A corrupt/unreadable file can still fire "load" with zero
        // dimensions rather than "error" -- bail out cleanly instead of
        // dividing by zero into an Infinity scale.
        closeCoverCropper();
        window.alert("That file couldn't be read as an image. Try a different photo.");
        return;
      }
      const viewportSize = viewport.clientWidth || 320;
      const baseScale = viewportSize / Math.min(naturalW, naturalH);
      cropState = {
        naturalW,
        naturalH,
        viewportSize,
        baseScale,
        scale: baseScale,
        tx: (viewportSize - naturalW * baseScale) / 2,
        ty: (viewportSize - naturalH * baseScale) / 2,
        dragging: false,
      };
      const clamped = cropClamp(cropState.tx, cropState.ty, cropState.scale);
      cropState.tx = clamped.tx;
      cropState.ty = clamped.ty;
      if (zoomInput) zoomInput.value = "1";
      cropApplyTransform();
    };
    img.onload = finishSetup;
    img.src = sourceDataUrl;
    // Re-opening the cropper on the exact same dataURL (e.g. "Recrop" on an
    // already-saved photo, opened twice in one session) can mean the <img>
    // element's src doesn't actually change, and some browsers won't refire
    // "load" for that -- so if the image is already fully decoded by the
    // time we get here, run setup immediately instead of waiting for an
    // event that may never come. finishSetup's own guard keeps this from
    // double-running if onload does still fire.
    if (img.complete && img.naturalWidth > 0) finishSetup();
  }

  function closeCoverCropper() {
    const overlay = document.getElementById("crop-overlay");
    if (overlay) overlay.hidden = true;
    cropState = null;
  }

  function wireCoverCropper() {
    const overlay = document.getElementById("crop-overlay");
    const viewport = document.getElementById("crop-viewport");
    const zoomInput = document.getElementById("crop-zoom");
    const cancelBtn = document.getElementById("crop-cancel");
    const saveBtn = document.getElementById("crop-save");
    if (!overlay || !viewport) return;

    viewport.addEventListener("pointerdown", (e) => {
      if (!cropState) return;
      cropState.dragging = true;
      cropState.startX = e.clientX;
      cropState.startY = e.clientY;
      cropState.startTx = cropState.tx;
      cropState.startTy = cropState.ty;
      viewport.classList.add("crop-dragging");
      viewport.setPointerCapture(e.pointerId);
    });
    viewport.addEventListener("pointermove", (e) => {
      if (!cropState || !cropState.dragging) return;
      const dx = e.clientX - cropState.startX;
      const dy = e.clientY - cropState.startY;
      const clamped = cropClamp(cropState.startTx + dx, cropState.startTy + dy, cropState.scale);
      cropState.tx = clamped.tx;
      cropState.ty = clamped.ty;
      cropApplyTransform();
    });
    const endDrag = (e) => {
      if (!cropState) return;
      cropState.dragging = false;
      viewport.classList.remove("crop-dragging");
      if (e && e.pointerId != null && viewport.hasPointerCapture && viewport.hasPointerCapture(e.pointerId)) {
        viewport.releasePointerCapture(e.pointerId);
      }
    };
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);

    if (zoomInput) {
      zoomInput.addEventListener("input", () => {
        if (!cropState) return;
        const z = Number(zoomInput.value) || 1;
        const newScale = cropState.baseScale * z;
        // Zoom around the viewport's center rather than its top-left corner
        // -- keeps whatever's currently centered roughly in place instead
        // of jumping toward the image's origin on every zoom step.
        const v = cropState.viewportSize;
        const centerImgX = (v / 2 - cropState.tx) / cropState.scale;
        const centerImgY = (v / 2 - cropState.ty) / cropState.scale;
        const newTx = v / 2 - centerImgX * newScale;
        const newTy = v / 2 - centerImgY * newScale;
        const clamped = cropClamp(newTx, newTy, newScale);
        cropState.scale = newScale;
        cropState.tx = clamped.tx;
        cropState.ty = clamped.ty;
        cropApplyTransform();
      });
    }

    if (cancelBtn) cancelBtn.addEventListener("click", closeCoverCropper);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeCoverCropper(); });

    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        if (!cropState || !deepDiveState) return;
        const img = document.getElementById("crop-img");
        const OUTPUT = 1600;
        const sx = -cropState.tx / cropState.scale;
        const sy = -cropState.ty / cropState.scale;
        const sSize = cropState.viewportSize / cropState.scale;
        const canvas = document.createElement("canvas");
        canvas.width = OUTPUT;
        canvas.height = OUTPUT;
        canvas.getContext("2d").drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT, OUTPUT);
        deepDiveState.data.coverPhoto = canvas.toDataURL("image/jpeg", 0.88);
        persistDeepDiveState();
        renderDeepDiveCover();
        closeCoverCropper();
      });
    }
  }

  // ---- projects: table -------------------------------------------

  // Clicking anywhere on the card opens its Project Deep Dive (see the deep
  // dive module above); the title link still opens ClickUp directly and is
  // exempted via the document-level delegated handler below (setupDeepDive
  // wires the tab/icon-picker internals, but this card-open listener lives
  // with card rendering since every card renderer needs the same behavior).
  function projectCardHtml(p) {
    const pct = p.progressPercent ?? 0;
    return `
      <div class="kanban-card deepdive-card" data-project-id="${escapeHtml(p.id)}">
        <div class="deepdive-card-head">
          <span class="deepdive-icon">${deepDiveIconHtml(p)}</span>
          <a class="card-title" href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>
        </div>
        <div class="mini-progress" style="margin-bottom:6px;">
          <div class="track"><div class="fill" style="width:${pct}%"></div></div>
          <div class="pct">${p.progressPercent != null ? pct + "%" : "—"}</div>
        </div>
        <div class="card-meta">
          <span class="health-pill"><span class="status-dot ${p.healthBucket}"></span>${HEALTH_LABEL[p.healthBucket] || p.healthBucket}</span>
          ${p.riskStatus ? `<span class="reason-chip">${escapeHtml(p.riskStatus)}</span>` : ""}
        </div>
      </div>`;
  }

  // `mode` is one of "productCategory" | "gate" -- shared by the Projects
  // table's old grouping concept, now split out into the two dedicated By
  // Category / By Stage Gate tabs. (A third mode, "healthBucket", backed a
  // By Health tab that was removed as redundant with the Health column
  // filter already on the Project Register.)
  function groupKeyFor(p, mode) {
    if (mode === "productCategory") return p.productCategory || "Unclassified";
    if (mode === "gate") {
      const g = p.currentGate || p.gatePhase;
      if (!g) return "Unclassified";
      return g === "Project Kickoff" || g === "Scoping & Feasibility" ? KICKOFF_SCOPING_LABEL : g;
    }
    return "All";
  }

  // Renders a kanban board grouped by `mode` into `containerId`, toggling
  // `emptyId` when there's nothing to show. Reused by the By Category / By
  // Stage Gate tabs -- each just points at its own container.
  function renderGroupedBoard(containerId, emptyId, rows, mode) {
    const board = document.getElementById(containerId);
    const emptyState = document.getElementById(emptyId);
    if (!board) return;
    emptyState.hidden = rows.length > 0;
    if (rows.length === 0) {
      board.innerHTML = "";
      return;
    }

    const groups = {};
    rows.forEach((p) => {
      const key = groupKeyFor(p, mode);
      (groups[key] = groups[key] || []).push(p);
    });

    let keys = Object.keys(groups);
    if (mode === "gate") {
      keys.sort((a, b) => {
        const ai = GATE_COLUMN_ORDER.indexOf(a);
        const bi = GATE_COLUMN_ORDER.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    } else {
      keys.sort((a, b) => (a === "Unclassified" ? 1 : b === "Unclassified" ? -1 : a.localeCompare(b)));
    }

    board.innerHTML = keys
      .map(
        (key) => `
        <div class="kanban-column">
          <div class="kanban-column-header">${escapeHtml(key)}<span class="count">${groups[key].length}</span></div>
          ${groups[key].map(projectCardHtml).join("")}
        </div>`
      )
      .join("");
  }

  function renderGroupedTabs() {
    const rows = getContextProjects();
    renderGroupedBoard("board-by-category", "by-category-empty", rows, "productCategory");
    renderGroupedBoard("board-by-gate", "by-gate-empty", rows, "gate");
  }

  // Keeps the register's four filter-row <select>s in sync with the actual
  // filter state -- necessary because that state can also be changed from
  // outside the register itself (an Overview KPI tile, the clear button),
  // and a dropdown left showing a stale value would be misleading.
  function syncTableFilterControls() {
    const ownerSelect = document.getElementById("owner-filter");
    if (ownerSelect) ownerSelect.value = noOwnerFilter ? "__unassigned__" : ownerFilter;
    const gateSelect = document.getElementById("gate-filter");
    if (gateSelect) gateSelect.value = gateFilter;
    const healthSelect = document.getElementById("health-filter-select");
    if (healthSelect) healthSelect.value = healthFilter || "";
    const riskSelect = document.getElementById("risk-filter-select");
    if (riskSelect) riskSelect.value = riskOnlyFilter ? "atrisk" : "";
  }

  // Avatar initials + a fixed gradient rotation for "who" cells across the
  // Projects register and Resources tab -- purely decorative identity color,
  // not meaningful data, so a plain index-based cycle (not a data-driven
  // palette) is fine here per the dataviz skill's categorical-color rule.
  const AVATAR_GRADIENTS = [
    "linear-gradient(145deg,#ffab5c,#cf6408)",
    "linear-gradient(145deg,#7a6cf0,#4a3fc0)",
    "linear-gradient(145deg,#6fd39b,#249055)",
    "linear-gradient(145deg,#6ba4ee,#2f6fd0)",
  ];
  function initialsFor(name) {
    if (!name || name === "Unassigned") return "?";
    return name.split(/[\s,]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  }
  function avatarHtml(name, i) {
    const gradient = AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length];
    return `<span class="avatar" style="background:${gradient}">${escapeHtml(initialsFor(name))}</span>`;
  }
  function firstNameOf(name) {
    if (!name) return "";
    return name.trim().split(/\s+/)[0];
  }
  // Real ClickUp assignee lists can run much longer than the 1-2 name mock
  // data -- render owners as small wrapping chips (first name only, one
  // avatar each) and "cut" past a visible cap into a "+N" chip that reveals
  // the full list on hover, so the Projects register stays compact instead
  // of one long comma-joined string stretching the row.
  const OWNER_CHIP_CAP = 3;
  function ownerChipsHtml(assignees) {
    const names = (assignees || []).map((a) => a.name).filter(Boolean);
    if (!names.length) {
      return `<div class="who-cell who-cell-empty">${avatarHtml("Unassigned", 0)}<span class="owner-name">Unassigned</span></div>`;
    }
    const visible = names.slice(0, OWNER_CHIP_CAP);
    const overflowNames = names.slice(OWNER_CHIP_CAP);
    const chips = visible
      .map(
        (n, i) => `
      <span class="owner-chip" title="${escapeHtml(n)}">${avatarHtml(n, i)}<span class="owner-name">${escapeHtml(firstNameOf(n))}</span></span>
    `
      )
      .join("");
    const overflowChip = overflowNames.length
      ? `<span class="owner-chip owner-chip-more" title="${escapeHtml(overflowNames.join(", "))}">+${overflowNames.length}</span>`
      : "";
    return `<div class="who-cell" title="${escapeHtml(names.join(", "))}">${chips}${overflowChip}</div>`;
  }

  function renderTable() {
    const rows = getFilteredSortedProjects();
    const emptyState = document.getElementById("projects-empty");
    const clearBtn = document.getElementById("clear-filter");

    const anyFilterActive = !!(healthFilter || noOwnerFilter || ownerFilter || gateFilter || riskOnlyFilter);
    clearBtn.hidden = !anyFilterActive;
    clearBtn.textContent = "Clear filters ✕";
    emptyState.hidden = rows.length > 0;

    syncTableFilterControls();

    const tbody = document.getElementById("projects-tbody");
    tbody.innerHTML = "";
    rows.forEach((p, i) => {
      const tr = document.createElement("tr");
      const pct = p.progressPercent ?? 0;
      const riskReason = p.risk ? p.risk.reason : "—";
      tr.innerHTML = `
        <td><span class="status-dot ${p.healthBucket}" style="margin-right:8px;"></span><a class="project-link" href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a></td>
        <td>${escapeHtml(p.productCategory || "—")}</td>
        <td>${ownerChipsHtml(p.assignees)}</td>
        <td>${escapeHtml(p.currentGate || p.gatePhase || "—")}</td>
        <td><span class="health-pill health-pill-${p.healthBucket}">${HEALTH_LABEL[p.healthBucket] || p.healthBucket}</span></td>
        <td>${p.risk ? `<span class="reason-chip${p.risk.needsMitigation ? " reason-chip-warn" : ""}">${escapeHtml(riskReason)}</span>` : "—"}</td>
        <td>
          <div class="mini-progress">
            <div class="track"><div class="fill" style="width:${pct}%"></div></div>
            <div class="pct">${p.progressPercent != null ? pct + "%" : "—"}</div>
          </div>
        </td>
        <td>${fmtDate(p.targetGateDate)}</td>
      `;
      tbody.appendChild(tr);
    });

    document.querySelectorAll("#projects-table thead tr.label-row th[data-sort]").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.sort === sortKey);
      th.classList.toggle("asc", th.dataset.sort === sortKey && sortDir === "asc");
    });

    document.getElementById("tab-count-projects").textContent = String(rows.length);
  }

  // ---- Decisions & Data Gaps ------------------------------------------------

  function renderDecisions(decisions) {
    const summary = document.getElementById("gap-summary");
    const list = document.getElementById("decisions-list");
    const badge = document.getElementById("tab-count-decisions");
    if (!decisions) return;

    badge.textContent = String(decisions.totalFlagged || 0);

    const gapEntries = Object.entries(decisions.gapTotals || {});
    summary.innerHTML = gapEntries.length
      ? gapEntries.map(([code, count]) => {
          const flaggedSample = decisions.flagged.find((f) => f.gaps.some((g) => g.code === code));
          const label = flaggedSample?.gaps.find((g) => g.code === code)?.label || code;
          return `<span class="gap-chip"><strong>${count}</strong> ${escapeHtml(label)}</span>`;
        }).join("")
      : '<span class="gap-chip">No planning gaps detected — nice work.</span>';

    if (!decisions.flagged || decisions.flagged.length === 0) {
      list.innerHTML = '<li class="empty-state">Nothing needs attention right now.</li>';
      return;
    }
    list.innerHTML = decisions.flagged
      .map(
        (f) => `
        <li>
          <a class="decision-title" href="${escapeHtml(f.url || "#")}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>
          <div class="decision-reasons">
            ${f.gaps.map((g) => gapEditorHtml(f.id, g)).join("")}
          </div>
        </li>`
      )
      .join("");
    wireGapEditors();
  }

  // ---- Decisions & Gaps: fill-the-gap inline editors (write to ClickUp) --

  // Not every gap has a field it can write to yet (progress is a native
  // ClickUp "manual_progress" field this dashboard doesn't attempt to set) --
  // those fall through to a plain, non-interactive chip.
  function gapEditorHtml(taskId, gap) {
    const label = escapeHtml(gap.label);
    const id = escapeHtml(taskId);

    if (gap.code === "noDueDate") {
      return `
        <div class="gap-editor" data-task="${id}" data-field="dueDate">
          <span class="gap-editor-label">${label}</span>
          <input type="date" class="gap-input" />
          <span class="gap-editor-status"></span>
        </div>`;
    }
    if (gap.code === "noAssignee") {
      // Sourced from fieldOptions.assignee (the "Assigned To (Multi)" field's
      // own option list) rather than `members` -- the write now targets that
      // same custom field by matching this picked name back to its option,
      // so the dropdown has to offer exactly that field's real choices.
      const opts = (fieldOptions.assignee || []).map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
      return `
        <div class="gap-editor" data-task="${id}" data-field="assignee">
          <span class="gap-editor-label">${label}</span>
          <select class="gap-input"><option value="">Choose owner…</option>${opts}</select>
          <span class="gap-editor-status"></span>
        </div>`;
    }
    if (gap.code === "noCategory") {
      const opts = (fieldOptions.productCategory || []).map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
      return `
        <div class="gap-editor" data-task="${id}" data-field="productCategory">
          <span class="gap-editor-label">${label}</span>
          <select class="gap-input"><option value="">Choose category…</option>${opts}</select>
          <span class="gap-editor-status"></span>
        </div>`;
    }
    if (gap.code === "noGate") {
      const opts = (fieldOptions.gatePhase || []).map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
      return `
        <div class="gap-editor" data-task="${id}" data-field="gatePhase">
          <span class="gap-editor-label">${label}</span>
          <select class="gap-input"><option value="">Choose stage gate…</option>${opts}</select>
          <span class="gap-editor-status"></span>
        </div>`;
    }
    if (gap.code === "openRiskNoMitigation") {
      // Risk Status is already "Open" here (that's why the gap fired) --
      // the only thing missing is the mitigation plan text, so that's the
      // only control offered. Free text gets an explicit Save rather than
      // saving on every keystroke.
      return `
        <div class="gap-editor gap-editor-text" data-task="${id}" data-field="mitigationStrategy">
          <span class="gap-editor-label">${label}</span>
          <input type="text" class="gap-input" placeholder="Mitigation plan…" />
          <button type="button" class="gap-save-btn action-btn">Save</button>
          <span class="gap-editor-status"></span>
        </div>`;
    }
    return `<span class="reason-chip">${label}</span>`;
  }

  function wireGapEditors() {
    document.querySelectorAll(".gap-editor").forEach((el) => {
      const taskId = el.dataset.task;
      const field = el.dataset.field;
      const input = el.querySelector(".gap-input");
      const statusEl = el.querySelector(".gap-editor-status");
      const saveBtn = el.querySelector(".gap-save-btn");
      if (saveBtn) {
        saveBtn.addEventListener("click", () => saveGapField(taskId, field, input.value, statusEl));
      } else {
        input.addEventListener("change", () => saveGapField(taskId, field, input.value, statusEl));
      }
    });
  }

  async function saveGapField(taskId, field, value, statusEl) {
    if (!value) return;
    statusEl.textContent = "Saving…";
    statusEl.className = "gap-editor-status";
    try {
      const res = await fetch("/api/gap-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, field, value }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Save failed");
      if (data.preview) {
        statusEl.textContent = "Preview mode — not saved";
        statusEl.className = "gap-editor-status gap-status-info";
        return;
      }
      statusEl.textContent = "Saved ✓";
      statusEl.className = "gap-editor-status gap-status-ok";
      // Refetch so the gap chip disappears and every dependent view (KPIs,
      // charts, workload) picks up the new field -- simplest way to stay
      // consistent given how many places a single field feeds into.
      await load();
    } catch (err) {
      statusEl.textContent = err.message || "Save failed";
      statusEl.className = "gap-editor-status gap-status-error";
    }
  }

  // ---- Weekly Activity (live subtasks per active project) ---------------

  function weeklyUpdateItemHtml(u) {
    const isDone = u.statusType === "done" || u.statusType === "closed";
    // Not every subtask carries its own due date in ClickUp -- most don't,
    // since the project's own target date is usually where that's tracked
    // -- so this is shown only when present rather than filtering the list
    // down to "due this week" and risking an empty view for everyone else.
    const dueBadge = u.dueDate ? `<span class="weekly-update-due">${escapeHtml(dueLabelFor(u.dueDate))}</span>` : "";
    return `
      <li class="weekly-update-item">
        <span class="status-dot ${isDone ? "completed" : "active"}"></span>
        <span class="weekly-update-name">${escapeHtml(u.name)}</span>
        ${dueBadge}
        <span class="weekly-update-status">${escapeHtml(u.status || "")}</span>
      </li>`;
  }

  // Nested work-breakdown-structure rendering for a project's `tree` (parent
  // -> child -> grandchild, to whatever depth ClickUp actually has -- see
  // buildWeekTree()/pruneToWeekWork() in netlify/functions/weekly.js). Each
  // node reuses the same look as a flat update row; a node with children
  // gets an extra "parent" treatment (bold name, no status dot) since it's
  // there for structure -- most parents are phases/buckets, not something a
  // PM checks off directly -- while a leaf renders exactly like the old
  // flat list did.
  function weeklyTreeNodeHtml(node) {
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const isDone = node.statusType === "done" || node.statusType === "closed";
    const dueBadge = node.dueDate ? `<span class="weekly-update-due">${escapeHtml(dueLabelFor(node.dueDate))}</span>` : "";
    const rowHtml = hasChildren
      ? `<span class="wbs-node-name">${escapeHtml(node.name)}</span>${dueBadge}`
      : `<span class="status-dot ${isDone ? "completed" : "active"}"></span><span class="weekly-update-name">${escapeHtml(node.name)}</span>${dueBadge}<span class="weekly-update-status">${escapeHtml(node.status || "")}</span>`;
    const childrenHtml = hasChildren
      ? `<ul class="wbs-children">${node.children.map(weeklyTreeNodeHtml).join("")}</ul>`
      : "";
    return `
      <li class="wbs-node${hasChildren ? " wbs-node-parent" : ""}">
        <div class="weekly-update-item">${rowHtml}</div>
        ${childrenHtml}
      </li>`;
  }

  function weeklyTreeHtml(tree) {
    return `<ul class="wbs-tree weekly-update-list">${tree.map(weeklyTreeNodeHtml).join("")}</ul>`;
  }

  // When a status filter is active, a card only shows the updates matching
  // it -- and if a project has none matching, the whole card is left out
  // rather than shown empty, so filtering by "On Hold" surfaces only the
  // projects that actually have something on hold right now.
  function weeklyCardHtml(p) {
    const healthLabel = HEALTH_LABEL[p.healthBucket] || p.healthBucket;
    const updates = weeklyStatusFilter
      ? (p.updates || []).filter((u) => u.status === weeklyStatusFilter)
      : p.updates || [];
    if (weeklyStatusFilter && updates.length === 0) return null;

    // With no status filter, show the real parent -> child -> grandchild
    // structure (a true work-breakdown-structure view) instead of a flat
    // list, whenever ClickUp actually has that structure for this project.
    // A status filter falls back to the flat list instead -- that's the
    // exact set of items the filter is built from, and a single status
    // describes one task, not a whole branch of the tree.
    const hasTree = !weeklyStatusFilter && Array.isArray(p.tree) && p.tree.length > 0;
    const bodyHtml = hasTree
      ? weeklyTreeHtml(p.tree)
      : `<ul class="weekly-update-list">${
          updates.length ? updates.map(weeklyUpdateItemHtml).join("") : '<li class="empty-state">Nothing starting or due this week yet.</li>'
        }</ul>`;

    return `
      <div class="weekly-card">
        <div class="weekly-card-header">
          <a href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener" class="weekly-card-title">${escapeHtml(p.name)}</a>
          <div class="weekly-card-meta">
            <span class="status-dot ${p.healthBucket}"></span>${escapeHtml(healthLabel)}
            ${p.gate ? ` · ${escapeHtml(p.gate)}` : ""}
            ${p.progressPercent != null ? ` · ${p.progressPercent}%` : ""}
          </div>
        </div>
        ${bodyHtml}
      </div>`;
  }

  // Status pills are built from whatever real ClickUp status names actually
  // appear on this week's subtasks -- not a hardcoded list -- so they match
  // however the list's statuses are actually named (Ongoing/To Do/On Hold/
  // Complete, or whatever a workspace has customized them to).
  function weeklyStatusOptions(data) {
    const set = new Set();
    (data.projects || []).forEach((p) => (p.updates || []).forEach((u) => { if (u.status) set.add(u.status); }));
    return [...set].sort();
  }

  function renderWeeklyStatusFilters(data) {
    const row = document.getElementById("weekly-status-filters");
    if (!row) return;
    const options = weeklyStatusOptions(data);
    if (options.length === 0) {
      row.innerHTML = "";
      return;
    }
    const pills = ["", ...options].map((status) => {
      const label = status || "All activity";
      const active = weeklyStatusFilter === status;
      return `<button type="button" class="pill${active ? " active" : ""}" data-status="${escapeHtml(status)}">${escapeHtml(label)}</button>`;
    });
    row.innerHTML = pills.join("");
    row.querySelectorAll(".pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        weeklyStatusFilter = btn.dataset.status;
        renderWeekly(weeklyData);
      });
    });
  }

  // ---- Resources: "This week's load", sourced straight from Weekly
  // Activity's data -- deliberately distinct from the all-time workload
  // donut/board/cards above (which reflect every live project's
  // overall assignment regardless of timing). This answers "who actually
  // has something starting or due THIS week," using the exact same
  // week-scoped subtask data the Weekly Activity tab shows (including its
  // per-subtask assignee resolution), so the two tabs never disagree about
  // what "this week" means or who owns what.
  function computeWeeklyLoad(data) {
    const byPerson = new Map();
    (data?.projects || []).forEach((p) => {
      (p.updates || []).forEach((u) => {
        const owners = u.assignees && u.assignees.length > 0 ? u.assignees : [{ id: "unassigned", name: "Unassigned" }];
        owners.forEach((owner) => {
          if (!byPerson.has(owner.id)) {
            byPerson.set(owner.id, { id: owner.id, name: owner.name, count: 0, projects: new Set() });
          }
          const entry = byPerson.get(owner.id);
          entry.count += 1;
          entry.projects.add(p.name);
        });
      });
    });
    return Array.from(byPerson.values())
      .map((e) => ({ ...e, projects: Array.from(e.projects) }))
      .sort((a, b) => b.count - a.count);
  }

  function renderWeeklyLoadPanel() {
    const root = document.getElementById("weekly-load-root");
    if (!root) return;
    if (!weeklyData) {
      root.innerHTML = '<div class="empty-state">Loading this week&rsquo;s activity&hellip;</div>';
      return;
    }
    const rows = computeWeeklyLoad(weeklyData);
    if (rows.length === 0) {
      root.innerHTML = '<div class="empty-state">Nothing starting or due this week yet.</div>';
      return;
    }
    const max = Math.max(...rows.map((r) => r.count), 1);
    root.innerHTML = rows
      .map(
        (r) => `
      <div class="weekly-load-card">
        <div class="weekly-load-header">
          <span class="weekly-load-name">${escapeHtml(r.name)}</span>
          <span class="weekly-load-count">${r.count} item${r.count === 1 ? "" : "s"} this week</span>
        </div>
        <div class="mini-progress"><div class="track"><div class="fill" style="width:${(r.count / max) * 100}%"></div></div></div>
        <div class="weekly-load-projects">${r.projects.map((n) => escapeHtml(n)).join(", ")}</div>
      </div>`
      )
      .join("");
  }

  function renderWeekly(data) {
    const list = document.getElementById("weekly-list");
    const empty = document.getElementById("weekly-empty");
    const total = document.getElementById("weekly-total");
    const weekLabel = document.getElementById("weekly-week-label");
    if (!data || !data.projects) return;
    weeklyData = data;
    renderWeeklyLoadPanel();
    // The Resources kanban board rendered with weekly still null (its
    // per-card task breakdown showing "Loading tasks…") the first time
    // renderAll() ran, if this is the first time weekly data has arrived --
    // refresh it now that openTasks is actually available.
    if (window.__portfolioData) renderWorkloadKanban(window.__portfolioData.workload, weeklyData);
    if (weekLabel) weekLabel.textContent = currentWeekRangeLabel();
    renderWeeklyStatusFilters(data);

    // Projects with actual movement this week (a WBS tree or a flat update)
    // float to the top, ahead of ones showing "Nothing starting or due this
    // week yet" -- so a PM scanning for team-prioritization decisions sees
    // the projects that need attention first instead of hunting past a wall
    // of empty cards. A stable sort keeps ClickUp's own ordering within each
    // group rather than re-shuffling projects that are equally "busy."
    const hasWeekContent = (p) => (Array.isArray(p.tree) && p.tree.length > 0) || (Array.isArray(p.updates) && p.updates.length > 0);
    const orderedProjects = [...data.projects].sort((a, b) => Number(hasWeekContent(b)) - Number(hasWeekContent(a)));

    const cards = orderedProjects.map(weeklyCardHtml).filter(Boolean);
    const filterNote = weeklyStatusFilter ? ` · filtered to "${weeklyStatusFilter}"` : "";
    total.textContent = weeklyStatusFilter
      ? `${cards.length} of ${data.totalActive} active project${data.totalActive === 1 ? "" : "s"}${filterNote}`
      : `${data.totalActive} active project${data.totalActive === 1 ? "" : "s"}`;

    if (cards.length === 0) {
      list.innerHTML = "";
      empty.hidden = false;
      empty.textContent = weeklyStatusFilter ? `No projects have a "${weeklyStatusFilter}" item right now.` : "No active projects.";
      return;
    }
    empty.hidden = true;
    list.innerHTML = cards.join("");
  }

  // ---- Weekly Activity: local (non-ClickUp) dated items --------------------
  // Tooling/Lab tasks and Checklist items are local-only (they never touch
  // ClickUp), and Idea Dumps lives in its own separate ClickUp intake list --
  // none of that shows up in the ClickUp-sourced /api/weekly response above.
  // This scans every project's local task/checklist storage for anything
  // carrying a due date inside the current Monday-Sunday window, plus fetches
  // Idea Dumps submissions and filters the same way, so "what's open this
  // week" isn't limited to what happens to live on the Active ClickUp list.
  function isIsoInCurrentWeek(iso) {
    if (!iso) return false;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return false;
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    monday.setDate(monday.getDate() - ((now.getDay() + 6) % 7));
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);
    return ms >= monday.getTime() && ms < nextMonday.getTime();
  }

  // Tooling and Lab tasks used to arrive here tagged with one glued-together
  // "Tooling/Lab" source, even though they're two quite different kinds of
  // work (see the Tooling/Lab tabs themselves) -- a task now carries its own
  // `category` ("tooling" | "lab", set when it's added -- see
  // addProjectTask) so the two can be split apart into their own groups
  // below. A task created before that field existed has no category; it's
  // bucketed under Tooling, the more common case, since there's no way to
  // recover which tab it actually came from.
  function collectLocalWeeklyItems() {
    const items = [];
    allProjects.forEach((p) => {
      getProjectTasks(p.id).forEach((t) => {
        if (!t.done && isIsoInCurrentWeek(t.dueDate)) {
          items.push({ source: t.category === "lab" ? "Lab" : "Tooling", projectName: p.name, text: t.text, dueDate: t.dueDate });
        }
      });
      const checklistData = getCustomChecklistData(p.id);
      Object.keys(checklistData).forEach((sectionKey) => {
        (checklistData[sectionKey] || []).forEach((it) => {
          if (!it.checked && isIsoInCurrentWeek(it.dueDate)) {
            items.push({ source: "Checklist", projectName: p.name, text: it.text, dueDate: it.dueDate });
          }
        });
      });
    });
    return items;
  }

  async function loadIdeaWeeklyItems() {
    try {
      const res = await fetch("/api/ideas");
      const data = await res.json();
      const ideas = data.ideas || [];
      return ideas
        .filter((idea) => isIsoInCurrentWeek(idea.dueDate))
        .map((idea) => ({ source: "Idea Dump", projectName: null, text: idea.name, dueDate: idea.dueDate }));
    } catch {
      return [];
    }
  }

  function weeklyOtherItemHtml(item) {
    const urgency = item.dueDate ? dateUrgencyInfo(item.dueDate) : null;
    return `
      <li class="weekly-other-item">
        ${item.projectName ? `<span class="weekly-other-project">${escapeHtml(item.projectName)}</span>` : ""}
        <span class="weekly-other-text">${escapeHtml(item.text)}</span>
        ${urgency ? `<span class="reason-chip ${urgency.cls}">${escapeHtml(urgency.label)}</span>` : ""}
      </li>`;
  }

  // Fixed group order, source label -> matching the Tooling/Lab/Checklists/
  // Idea Dumps tabs by name -- only groups that actually have an item this
  // week render at all, so an all-clear week doesn't show four empty
  // headings.
  const WEEKLY_OTHER_GROUP_ORDER = ["Tooling", "Lab", "Checklist", "Idea Dump"];

  async function renderWeeklyOtherItems() {
    const panel = document.getElementById("weekly-other-panel");
    const groupsEl = document.getElementById("weekly-other-groups");
    const countEl = document.getElementById("weekly-other-count");
    if (!panel || !groupsEl) return;
    const local = collectLocalWeeklyItems();
    const ideaItems = await loadIdeaWeeklyItems();
    const all = [...local, ...ideaItems].sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate));
    if (all.length === 0) {
      panel.hidden = true;
      groupsEl.innerHTML = "";
      return;
    }
    panel.hidden = false;
    if (countEl) countEl.textContent = String(all.length);
    groupsEl.innerHTML = WEEKLY_OTHER_GROUP_ORDER.map((source) => {
      const groupItems = all.filter((item) => item.source === source);
      if (!groupItems.length) return "";
      return `
        <div class="weekly-other-group">
          <div class="weekly-other-group-title">${escapeHtml(source)} <span class="tab-badge">${groupItems.length}</span></div>
          <ul class="weekly-other-list">${groupItems.map(weeklyOtherItemHtml).join("")}</ul>
        </div>`;
    }).join("");
  }

  // Product Backlog -- open ClickUp tasks with NEITHER a start_date NOR a
  // due_date, per project. These can never land on a weekly card (nothing to
  // scope them into a week) or in "Other open items this week" (nothing
  // dated), so without this they were simply invisible on Weekly Activity --
  // sourced from the same per-project openTasks /api/weekly already returns
  // (see flattenOpenTasks in transform.js, which now carries dueDate/
  // startDate through). Collapsed by default since a real backlog can run
  // long; the count badge on the summary gives the total without opening it.
  // Local-only star/highlight so a PM can flag which backlog items actually
  // matter without writing anything to ClickUp -- these are, by definition,
  // tasks nobody has scheduled yet, so a flag here is a note-to-self, not a
  // status change. Starred items sort to the top of their project group.
  const BACKLOG_STARS_KEY = "pm-dashboard-backlog-stars";
  function loadBacklogStars() {
    try {
      return new Set(JSON.parse(localStorage.getItem(BACKLOG_STARS_KEY) || "[]"));
    } catch {
      return new Set();
    }
  }
  function saveBacklogStars(set) {
    try {
      localStorage.setItem(BACKLOG_STARS_KEY, JSON.stringify([...set]));
    } catch {
      // Storage can be unavailable (private browsing, quota) -- starring
      // just won't persist across reloads in that case, nothing to surface.
    }
  }

  function renderWeeklyBacklog(data) {
    const panel = document.getElementById("weekly-backlog-panel");
    const groupsEl = document.getElementById("weekly-backlog-groups");
    const countEl = document.getElementById("weekly-backlog-count");
    if (!panel || !groupsEl) return;
    const stars = loadBacklogStars();
    const projects = (data && data.projects) || [];
    const groups = projects
      .map((p) => {
        const items = (p.openTasks || []).filter((t) => t.statusType !== "done" && !t.dueDate && !t.startDate);
        items.sort((a, b) => Number(stars.has(b.id)) - Number(stars.has(a.id)));
        return { name: p.name, items };
      })
      .filter((g) => g.items.length > 0);
    const total = groups.reduce((sum, g) => sum + g.items.length, 0);
    if (countEl) countEl.textContent = String(total);
    if (total === 0) {
      panel.hidden = true;
      groupsEl.innerHTML = "";
      return;
    }
    panel.hidden = false;
    groupsEl.innerHTML = groups
      .map(
        (g) => `
      <div class="weekly-backlog-group">
        <div class="weekly-backlog-group-title">${escapeHtml(g.name)}</div>
        <ul class="weekly-backlog-list">
          ${g.items
            .map((t) => {
              const starred = stars.has(t.id);
              return `
              <li class="weekly-backlog-item${starred ? " weekly-backlog-item-starred" : ""}">
                <button type="button" class="weekly-backlog-star" data-star-task="${escapeHtml(t.id)}" aria-pressed="${starred}" title="${starred ? "Unstar" : "Star as a priority"}">${starred ? "★" : "☆"}</button>
                <span class="weekly-backlog-item-name">${escapeHtml(t.name)}</span>
                <span class="weekly-backlog-date-form" data-task="${escapeHtml(t.id)}">
                  <input type="date" class="weekly-backlog-date-input" aria-label="Set a date for ${escapeHtml(t.name)}" />
                  <button type="button" class="weekly-backlog-date-save action-btn">Set date</button>
                  <span class="weekly-backlog-status"></span>
                </span>
              </li>`;
            })
            .join("")}
        </ul>
      </div>`
      )
      .join("");
    wireWeeklyBacklogControls();
  }

  function wireWeeklyBacklogControls() {
    document.querySelectorAll("#weekly-backlog-groups .weekly-backlog-star").forEach((btn) => {
      btn.addEventListener("click", () => {
        const taskId = btn.dataset.starTask;
        const stars = loadBacklogStars();
        if (stars.has(taskId)) stars.delete(taskId);
        else stars.add(taskId);
        saveBacklogStars(stars);
        renderWeeklyBacklog(weeklyData);
      });
    });
    document.querySelectorAll("#weekly-backlog-groups .weekly-backlog-date-form").forEach((form) => {
      const taskId = form.dataset.task;
      const input = form.querySelector(".weekly-backlog-date-input");
      const saveBtn = form.querySelector(".weekly-backlog-date-save");
      const statusEl = form.querySelector(".weekly-backlog-status");
      saveBtn.addEventListener("click", () => saveBacklogDate(taskId, input.value, statusEl));
    });
  }

  // Setting a date here writes the real ClickUp task's due date (via the
  // same /api/gap-update endpoint the Decisions & Gaps tab already uses --
  // see saveGapField), which is what makes it "not undated" -- so on
  // success it naturally drops out of this backlog and starts showing up in
  // Weekly Activity / the Deep Dive Timeline feed instead. Re-runs
  // loadWeekly() (not the full load()) since Product Backlog and Weekly
  // Activity both come from /api/weekly and nothing else needs refreshing.
  async function saveBacklogDate(taskId, value, statusEl) {
    if (!value) return;
    statusEl.textContent = "Saving…";
    statusEl.className = "weekly-backlog-status";
    try {
      const res = await fetch("/api/gap-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, field: "dueDate", value }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Save failed");
      if (data.preview) {
        statusEl.textContent = "Preview mode — not saved";
        statusEl.className = "weekly-backlog-status weekly-backlog-status-info";
        return;
      }
      statusEl.textContent = "Saved ✓ moving to Weekly Activity…";
      statusEl.className = "weekly-backlog-status weekly-backlog-status-ok";
      await loadWeekly();
    } catch (err) {
      statusEl.textContent = err.message || "Save failed";
      statusEl.className = "weekly-backlog-status weekly-backlog-status-error";
    }
  }

  async function loadWeekly() {
    const total = document.getElementById("weekly-total");
    total.textContent = "Loading…";
    try {
      const res = await fetch("/api/weekly");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      renderWeekly(data);
      renderWeeklyOtherItems();
      renderWeeklyBacklog(data);
      weeklyLoaded = true;
    } catch (err) {
      total.textContent = "Error loading weekly activity";
      console.error(err);
    }
  }

  // ---- Weekly standup summary export (HTML + slides) -----------------------
  // The full standup picture, built once as plain data (buildStandupSummaryData)
  // and then rendered two ways: a self-contained styled HTML page for a
  // quick read (opens instantly in any browser, no app association issues --
  // unlike the Markdown file this used to download as), and an actual
  // PowerPoint deck (via the standup-pptx Netlify function) for screen-sharing
  // live in the standup. Both cover the same three things: this week's
  // activity (the same WBS tree the tab shows, where a project has one),
  // every open risk (the same merged list Live Risk Signals shows -- see
  // mergeChecklistRisks -- so the client-only "gate nearing, checklist
  // incomplete" signal is included even though it's never touched ClickUp),
  // and every project with a planning gap flagged under Decisions & Gaps.

  function currentWeekMondayIso() {
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }

  // Flattens a WBS tree node into one row per node (parent and leaf alike),
  // carrying its own depth so either renderer (HTML indentation, PPTX
  // indentLevel) can lay it out without re-walking the tree itself.
  function flattenWeekTree(nodes, depth) {
    const out = [];
    (nodes || []).forEach((n) => {
      const hasChildren = Array.isArray(n.children) && n.children.length > 0;
      out.push({
        depth,
        text: n.name,
        done: n.statusType === "done" || n.statusType === "closed",
        due: n.dueDate ? dueLabelFor(n.dueDate) : "",
        status: !hasChildren ? n.status || "" : "",
        isParent: hasChildren,
      });
      if (hasChildren) out.push(...flattenWeekTree(n.children, depth + 1));
    });
    return out;
  }

  // Re-encodes a dataURL image at a smaller size/quality -- used to shrink
  // full-size (1600px-edge) cover photos before they're embedded in the
  // PPTX export payload, since that deck only ever shows them at ~0.6in
  // and sending several full-size photos in one POST body would bloat it
  // for no visible benefit. Falls back to the original dataURL if decoding
  // fails for any reason (e.g. a corrupt/unsupported image), so a bad photo
  // never blocks the export.
  function downscaleDataUrl(dataUrl, maxEdge, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function buildStandupSummaryData() {
    const portfolio = window.__portfolioData;
    const weeklyProjects = weeklyData?.projects || [];
    const activeCards = weeklyProjects.filter((p) => (p.tree && p.tree.length) || (p.updates && p.updates.length));

    const projects = activeCards.map((p) => {
      const lines = p.tree && p.tree.length
        ? flattenWeekTree(p.tree, 0)
        : (p.updates || []).map((u) => ({
            depth: 0,
            text: u.name,
            done: u.statusType === "done" || u.statusType === "closed",
            due: u.dueDate ? dueLabelFor(u.dueDate) : "",
            status: u.status || "",
            isParent: false,
          }));
      // Pulled from this project's own Deep Dive -- Cost & Resource rows
      // (team utilization by function) and a one-line Priority summary --
      // shown above the task list below so the export carries the same
      // "who's on this and what's the live call" context the (now-removed)
      // Weekly Priorities tab used to show as a separate table.
      const fullProject = findProject(p.id);
      const deepData = fullProject ? loadDeepDive(fullProject) : null;
      const teamRows = deepData && deepData.costResource ? deepData.costResource.rows || [] : [];
      const priorityText = deepData ? priorityColumnText(deepData) : "";
      // Same square photo used as this project's cover/thumbnail everywhere
      // else (see deepDiveIconHtml) -- carried into the PPTX export too so
      // the deck is recognizable at a glance instead of text-only.
      const coverPhoto = deepData && deepData.coverPhoto ? deepData.coverPhoto : null;
      return { name: p.name, gate: p.gate || "", lines, teamRows, priorityText, coverPhoto };
    });

    const { risks } = mergeChecklistRisks(portfolio);
    const riskRows = risks.map((r) => ({
      name: r.name,
      reason: r.reason,
      health: HEALTH_LABEL[r.healthBucket] || r.healthBucket,
      plan: r.needsMitigation ? "Needs a mitigation plan" : "Has a mitigation plan",
    }));

    const flagged = portfolio?.decisions?.flagged || [];
    const gapRows = flagged.map((f) => ({ name: f.name, gaps: (f.gaps || []).map((g) => g.label).join(", ") }));

    return {
      weekLabel: currentWeekRangeLabel(),
      generatedAt: new Date().toLocaleString(),
      projects,
      risks: riskRows,
      gaps: gapRows,
    };
  }

  function standupLineHtml(l) {
    const indent = (l.depth || 0) * 20;
    const checkbox = l.isParent ? "" : `<span class="chk">${l.done ? "☑" : "☐"}</span> `;
    const dueBadge = l.due ? ` <span class="due">${escapeHtml(l.due)}</span>` : "";
    const statusText = !l.isParent && l.status ? ` <span class="status">${escapeHtml(l.status)}</span>` : "";
    return `<div class="line${l.isParent ? " parent" : ""}" style="margin-left:${indent}px">${checkbox}<span class="name">${escapeHtml(l.text)}</span>${dueBadge}${statusText}</div>`;
  }

  // Base64 copy of public/assets/ecoa-mark-header.png (the wordmark-only
  // crop -- see .brand-logo in style.css for why), embedded so this
  // exported file stays a single, fully self-contained HTML document (no
  // relative asset path that would break once it's saved/emailed
  // elsewhere).
  const ECOA_LOGO_DATA_URI =
    "data:image/png;base64,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";

  function renderStandupSummaryHtml(data) {
    // A number-only "how big a week is this" strip up top -- the previous
    // version made a reader open every project card to find out whether
    // this was a quiet week or a loaded one. Purely derived from what's
    // already in `data`, nothing new fetched.
    const statsHtml = `
      <div class="stat-strip">
        <div class="stat"><span class="stat-value">${data.projects.length}</span><span class="stat-label">Active project${data.projects.length === 1 ? "" : "s"} this week</span></div>
        <div class="stat"><span class="stat-value">${data.risks.length}</span><span class="stat-label">Open risk${data.risks.length === 1 ? "" : "s"}</span></div>
        <div class="stat"><span class="stat-value">${data.gaps.length}</span><span class="stat-label">Planning gap${data.gaps.length === 1 ? "" : "s"}</span></div>
      </div>`;

    const projectsHtml = data.projects.length
      ? data.projects
          .map((p) => {
            const teamHtml = p.teamRows.length
              ? `<div class="team-info">${p.teamRows.map((r) => `<span class="team-chip">${escapeHtml(r.role || "—")}${r.effort ? ` · ${escapeHtml(r.effort)}` : ""}</span>`).join("")}</div>`
              : "";
            const priorityHtml = p.priorityText ? `<div class="priority-info">${escapeHtml(p.priorityText)}</div>` : "";
            // Same square cover photo used as this project's thumbnail
            // everywhere else in the dashboard (and in the PPTX export) --
            // see resolveExportPhotos for why a photo can be null here even
            // when the project has one set.
            const coverHtml = p.coverPhoto ? `<img class="project-cover" src="${p.coverPhoto}" alt="" />` : "";
            return `
      <div class="project">
        ${coverHtml}
        <div class="project-body">
          <h3>${escapeHtml(p.name)}${p.gate ? ` <span class="gate">${escapeHtml(p.gate)}</span>` : ""}</h3>
          ${teamHtml}
          ${priorityHtml}
          ${p.lines.map(standupLineHtml).join("")}
        </div>
      </div>`;
          })
          .join("")
      : `<p class="empty">Nothing starting or due this week across any active project.</p>`;

    const risksHtml = data.risks.length
      ? `<ul>${data.risks
          .map((r) => `<li><strong>${escapeHtml(r.name)}</strong> — ${escapeHtml(r.reason)} <span class="tag">${escapeHtml(r.health)}</span> <span class="tag">${escapeHtml(r.plan)}</span></li>`)
          .join("")}</ul>`
      : `<p class="empty">No open risks flagged right now.</p>`;

    const gapsHtml = data.gaps.length
      ? `<ul>${data.gaps.map((g) => `<li><strong>${escapeHtml(g.name)}</strong> — ${escapeHtml(g.gaps)}</li>`).join("")}</ul>`
      : `<p class="empty">No planning gaps detected.</p>`;

    // A plain downloaded/emailed document, not the live glass dashboard --
    // so this keeps the ecoa brand (logo, orange accent, Plus Jakarta Sans /
    // Outfit type, rounded pill tags) without backdrop-filter blur, which
    // most mail clients and PDF-print pipelines don't render anyway.
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Weekly Standup Summary — ${escapeHtml(data.weekLabel)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --brand-accent: #f58220;
    --brand-accent-deep: #cf6408;
    --brand-tint: rgba(245, 130, 32, 0.1);
    --text-primary: #15171c;
    --text-secondary: #4d535f;
    --text-muted: #868d9b;
    --border: rgba(21, 23, 28, 0.1);
    --border-soft: rgba(21, 23, 28, 0.06);
    --card-bg: #ffffff;
    --page-bg: #f6f3ef;
    --status-warning: #e0a020;
    --status-warning-ink: #8a5f05;
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Plus Jakarta Sans', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    max-width: 760px;
    margin: 0 auto;
    padding: 0 20px 60px;
    color: var(--text-primary);
    background: var(--page-bg);
  }
  .doc-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 -20px 28px;
    padding: 22px 20px;
    background: linear-gradient(135deg, #fff5ec, #fdeadb 60%, #fbf7f2);
    border-bottom: 3px solid var(--brand-accent);
  }
  /* ECOA_LOGO_DATA_URI is now a wordmark-only crop (~500x117, no forced
     square box) -- the old 34x34 square squished the previous 2.5:1 lockup
     image into an illegible smear. height:auto + a fixed width keeps its
     real proportions. */
  .doc-header img { width: 118px; height: auto; flex: none; }
  .doc-header .brand-text { display: flex; flex-direction: column; line-height: 1.15; }
  .doc-header .brand-name {
    font-family: 'Outfit', 'Plus Jakarta Sans', system-ui, sans-serif;
    font-weight: 800;
    font-size: 15px;
    letter-spacing: .02em;
    color: var(--text-primary);
  }
  .doc-header .brand-tagline { font-size: 11px; color: var(--text-muted); font-weight: 600; }
  h1 {
    font-family: 'Outfit', 'Plus Jakarta Sans', system-ui, sans-serif;
    font-size: 23px;
    font-weight: 800;
    margin: 0 0 4px;
    color: var(--text-primary);
  }
  .meta { color: var(--text-muted); font-size: 13px; margin-bottom: 6px; font-weight: 600; }
  .stat-strip { display: flex; gap: 10px; margin: 14px 0 6px; flex-wrap: wrap; }
  .stat {
    flex: 1 1 140px;
    background: var(--card-bg);
    border: 1px solid var(--border-soft);
    border-radius: 14px;
    padding: 10px 14px;
    box-shadow: 0 4px 16px rgba(21, 23, 28, 0.05);
  }
  .stat-value {
    display: block;
    font-family: 'Outfit', 'Plus Jakarta Sans', system-ui, sans-serif;
    font-size: 24px;
    font-weight: 800;
    color: var(--brand-accent-deep);
    line-height: 1.1;
  }
  .stat-label { font-size: 11.5px; color: var(--text-muted); font-weight: 600; }
  h2 {
    font-family: 'Outfit', 'Plus Jakarta Sans', system-ui, sans-serif;
    font-size: 15px;
    font-weight: 700;
    color: var(--brand-accent-deep);
    border-bottom: 2px solid var(--brand-accent);
    display: inline-block;
    padding-bottom: 6px;
    margin: 34px 0 14px;
  }
  .project {
    display: flex;
    gap: 14px;
    background: var(--card-bg);
    border: 1px solid var(--border-soft);
    border-radius: 16px;
    padding: 14px 18px;
    margin-bottom: 12px;
    box-shadow: 0 4px 16px rgba(21, 23, 28, 0.05);
  }
  .project-cover {
    flex: none;
    width: 56px;
    height: 56px;
    border-radius: 12px;
    object-fit: cover;
    border: 1px solid var(--border-soft);
    background: #fff;
  }
  .project-body { flex: 1; min-width: 0; }
  h3 { font-size: 14px; font-weight: 700; margin: 0 0 8px; color: var(--text-primary); }
  .gate {
    font-weight: 700;
    color: var(--brand-accent-deep);
    background: var(--brand-tint);
    font-size: 11px;
    border-radius: 100px;
    padding: 2px 9px;
    margin-left: 4px;
  }
  .team-info { margin-bottom: 6px; }
  .team-chip {
    display: inline-block;
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--page-bg);
    border: 1px solid var(--border-soft);
    border-radius: 100px;
    padding: 2px 9px;
    margin: 0 4px 4px 0;
  }
  .priority-info {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--brand-accent-deep);
    background: var(--brand-tint);
    border-radius: 8px;
    padding: 5px 10px;
    margin-bottom: 8px;
  }
  .line { font-size: 13px; padding: 3px 0; color: var(--text-secondary); }
  .line.parent { font-weight: 700; color: var(--text-primary); }
  .chk { font-family: var(--mono, ui-monospace, monospace); color: var(--brand-accent-deep); }
  .due {
    color: var(--status-warning-ink);
    font-size: 11px;
    background: color-mix(in srgb, var(--status-warning) 14%, #fff);
    border-radius: 100px;
    padding: 1px 8px;
    font-weight: 700;
  }
  .status { color: var(--text-muted); font-size: 11px; font-family: ui-monospace, monospace; }
  ul { padding-left: 20px; margin: 0; }
  li { font-size: 13px; margin-bottom: 8px; color: var(--text-secondary); }
  .tag {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    color: var(--brand-accent-deep);
    background: var(--brand-tint);
    border-radius: 100px;
    padding: 1px 9px;
    margin-left: 4px;
  }
  .empty { color: var(--text-muted); font-size: 13px; font-style: italic; }
  .risks-card, .gaps-card {
    background: var(--card-bg);
    border: 1px solid var(--border-soft);
    border-radius: 16px;
    padding: 14px 18px;
    box-shadow: 0 4px 16px rgba(21, 23, 28, 0.05);
  }
</style>
</head>
<body>
  <div class="doc-header">
    <img src="${ECOA_LOGO_DATA_URI}" alt="ecoa logo" />
    <div class="brand-text">
      <span class="brand-name">ecoa</span>
      <span class="brand-tagline">Biomass Portfolio Intelligence</span>
    </div>
  </div>
  <h1>Weekly Standup Summary</h1>
  <div class="meta">${escapeHtml(data.weekLabel)} · Generated ${escapeHtml(data.generatedAt)}</div>
  ${statsHtml}
  <h2>This week's activity</h2>
  ${projectsHtml}
  <h2>Open risks</h2>
  <div class="risks-card">${risksHtml}</div>
  <h2>Decisions &amp; gaps needing attention</h2>
  <div class="gaps-card">${gapsHtml}</div>
</body>
</html>`;
  }

  function downloadTextFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Opens generated HTML straight in a new tab via a blob: URL instead of
  // saving a file -- lets a PM check what the export actually looks like
  // before deciding it's worth downloading, without leaving a throwaway
  // file behind every time. Same mechanism as downloadTextFile just above,
  // minus the <a download> step.
  function previewHtmlInNewTab(html) {
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // A project's cover photo always comes out of the crop tool as a fixed
  // 1600x1600 canvas (see OUTPUT in wireCoverCropper) regardless of the
  // source file's own resolution, so a genuinely blurry upload can't be
  // told apart from a sharp one just by measuring the saved data URI's
  // pixel dimensions -- that would always read 1600x1600 either way. This
  // is the honest version of "skip it if it's low-res": it confirms the
  // image actually decodes and isn't some degenerate sliver (a corrupt
  // data URI, or a stray 1x1 placeholder), and leaves it out of the export
  // rather than embedding a broken image if it doesn't clear that bar.
  const MIN_EXPORT_PHOTO_PX = 80;
  function coverPhotoOkForExport(dataUri) {
    return new Promise((resolve) => {
      if (!dataUri) { resolve(false); return; }
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth >= MIN_EXPORT_PHOTO_PX && img.naturalHeight >= MIN_EXPORT_PHOTO_PX);
      img.onerror = () => resolve(false);
      img.src = dataUri;
    });
  }

  // Confirms every project's cover photo (if any) actually decodes before
  // handing `data` to either export -- see coverPhotoOkForExport. Mutates
  // and returns the same `data` object for convenience at the call site.
  async function resolveExportPhotos(data) {
    await Promise.all(
      data.projects.map(async (p) => {
        if (p.coverPhoto && !(await coverPhotoOkForExport(p.coverPhoto))) {
          p.coverPhoto = null;
        }
      })
    );
    return data;
  }

  async function downloadStandupSlides(btn) {
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Building…";
    try {
      const data = buildStandupSummaryData();
      // Shrink cover photos before they go into the POST body -- the deck
      // only shows them small (see standup-pptx.js), so there's no reason
      // to ship each project's full 1600px-edge upload.
      if (data.projects && data.projects.length) {
        await Promise.all(
          data.projects.map(async (p) => {
            if (p.coverPhoto) p.coverPhoto = await downscaleDataUrl(p.coverPhoto, 300, 0.82);
          })
        );
      }
      const res = await fetch("/api/standup-pptx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Server returned ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `standup-summary-${currentWeekMondayIso()}.pptx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      // A missing `npm install` (pptxgenjs is only needed for this one
      // feature) is the most likely cause locally -- surfaced plainly
      // rather than as a silent failure.
      window.alert(`Couldn't build slides: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // ---- Risk Register -------------------------------------------------------
  // Built from data.risks / data.riskCounts (see riskSignal() in
  // netlify/functions/lib/transform.js): every non-completed project that
  // either has an explicit ClickUp risk flag ("flagged") or has simply
  // fallen behind schedule ("schedule") -- schedule slippage counts as a
  // real risk on its own here, not just once a PM has also tagged it.
  const RISK_SOURCE_LABEL = {
    flagged: "Flagged in ClickUp",
    schedule: "Behind schedule (auto)",
    checklist: "Gate nearing, checklist incomplete (auto)",
  };

  // "Total at risk" used to sit as one tile among five same-size tiles,
  // several of which (Gate nearing, Needs mitigation plan) could show the
  // same number as the total -- reading as a mix-up rather than a
  // breakdown. Now it's a single hero stat with a share-of-live-projects
  // ring (the same radial-gauge language the workload donut uses), and the
  // reasons underneath are real proportional bars sized as a breakdown of
  // THAT number (which can overlap, not competing counts of their own) --
  // and each bar is a button: clicking it highlights exactly which rows on
  // the At-risk projects table below it's counting (see
  // applyRiskReasonFilter). `counts` is data.counts from the portfolio
  // summary (active/delayed/atRisk/completed/total) -- used only to size
  // the ring as "at risk" share of live (non-completed) projects; renders
  // fine without a fill if it's ever missing.
  const RISK_REASON_MATCHERS = {
    schedule: (r) => r.source === "schedule",
    flagged: (r) => r.source === "flagged",
    // The checklist signal is computed client-side (see
    // checklistGateRiskFor) and, when merged into an existing flagged row,
    // survives only as appended text in `reason` (" · <gate> gate ...,
    // checklist N/M complete") -- there's no separate boolean for it the
    // way there is for needsMitigation, so matching the literal word is
    // the same signal renderRisksTable already displays in that column.
    checklist: (r) => /checklist/i.test(r.reason || ""),
    needsMitigation: (r) => !!r.needsMitigation,
  };
  const RISK_REASON_LABELS = {
    schedule: "Behind schedule",
    flagged: "Flagged in ClickUp",
    checklist: "Gate nearing, checklist incomplete",
    needsMitigation: "Needs a mitigation plan",
  };
  let latestRisks = [];
  let activeRiskFilter = null;

  function renderRiskKpis(risks, riskCounts, counts) {
    const heroValue = document.getElementById("risk-hero-value");
    const reasonRow = document.getElementById("risk-reason-row");
    const ringFill = document.getElementById("risk-hero-ring-fill");
    if (!heroValue || !reasonRow) return;
    latestRisks = risks;
    heroValue.textContent = String(risks.length);

    if (ringFill) {
      const R = 52;
      const CIRC = 2 * Math.PI * R;
      const liveTotal = counts ? Math.max(0, (counts.total || 0) - (counts.completed || 0)) : 0;
      const pct = liveTotal > 0 ? Math.min(1, risks.length / liveTotal) : 0;
      ringFill.setAttribute("stroke-dasharray", `${CIRC}`);
      ringFill.setAttribute("stroke-dashoffset", `${CIRC * (1 - pct)}`);
    }

    const reasons = [
      { key: "schedule", label: RISK_REASON_LABELS.schedule + " (auto)", value: riskCounts.schedule || 0, dotClass: "delayed" },
      { key: "flagged", label: RISK_REASON_LABELS.flagged, value: riskCounts.flagged || 0, dotClass: "atRisk" },
      { key: "checklist", label: RISK_REASON_LABELS.checklist + " (auto)", value: riskCounts.checklist || 0, dotClass: "delayed" },
      { key: "needsMitigation", label: RISK_REASON_LABELS.needsMitigation, value: riskCounts.needsMitigation || 0, dotClass: "atRisk" },
    ];
    const scaleMax = Math.max(1, risks.length);
    reasonRow.innerHTML = reasons
      .map((r) => {
        const pct = Math.round((r.value / scaleMax) * 100);
        const isActive = activeRiskFilter === r.key;
        return `
        <button type="button" class="risk-reason-bar${isActive ? " risk-reason-bar-active" : ""}" data-reason-key="${r.key}" aria-pressed="${isActive}">
          <span class="risk-reason-bar-top">
            <span class="risk-reason-bar-label"><span class="status-dot ${r.dotClass}"></span>${escapeHtml(r.label)}</span>
            <span class="risk-reason-bar-value">${r.value}</span>
          </span>
          <span class="risk-reason-bar-track"><span class="risk-reason-bar-fill ${r.dotClass}" style="width:${pct}%;"></span></span>
        </button>`;
      })
      .join("");
    // Bars are active/pressed-state-correct as of this render; the table
    // itself is re-highlighted by renderRisks once it rebuilds the rows
    // (see applyRiskReasonFilter's reapply call there) since this runs
    // before renderRisksTable does on every renderRisks() pass.
  }

  // Clicking a reason bar highlights (not filters out) exactly the rows on
  // the At-risk projects table it's counting -- "captured by this reason"
  // stays visible in context, just visually receded for the rest, so a PM
  // can literally see where a number came from instead of just reading it.
  // Clicking the same bar again clears the highlight; opts.toggle:false
  // (used by the re-render re-apply above and the Clear button) sets the
  // filter directly instead of toggling it off.
  function applyRiskReasonFilter(key, opts = {}) {
    const toggle = opts.toggle !== false;
    activeRiskFilter = toggle ? (activeRiskFilter === key ? null : key) : key;

    document.querySelectorAll(".risk-reason-bar").forEach((btn) => {
      const isActive = !!activeRiskFilter && btn.dataset.reasonKey === activeRiskFilter;
      btn.classList.toggle("risk-reason-bar-active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });

    const banner = document.getElementById("risk-filter-banner");
    const bannerText = document.getElementById("risk-filter-banner-text");
    const tbody = document.getElementById("risks-tbody");
    const rows = tbody ? Array.from(tbody.querySelectorAll("tr[data-risk-id]")) : [];

    if (!activeRiskFilter) {
      rows.forEach((row) => row.classList.remove("risk-row-match", "risk-row-dim"));
      if (banner) banner.hidden = true;
      return;
    }

    const matcher = RISK_REASON_MATCHERS[activeRiskFilter];
    const byId = new Map(latestRisks.map((r) => [String(r.id), r]));
    rows.forEach((row) => {
      const r = byId.get(row.dataset.riskId);
      const match = !!(r && matcher(r));
      row.classList.toggle("risk-row-match", match);
      row.classList.toggle("risk-row-dim", !match);
    });

    if (banner && bannerText) {
      bannerText.textContent = `Highlighting projects captured by "${RISK_REASON_LABELS[activeRiskFilter]}"`;
      banner.hidden = false;
    }
    if (opts.scroll !== false) {
      document.getElementById("risk-filter-banner")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function setupRiskReasonFilter() {
    const row = document.getElementById("risk-reason-row");
    const clearBtn = document.getElementById("risk-filter-clear");
    if (row) {
      row.addEventListener("click", (e) => {
        const btn = e.target.closest(".risk-reason-bar");
        if (!btn) return;
        applyRiskReasonFilter(btn.dataset.reasonKey);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener("click", () => applyRiskReasonFilter(null, { toggle: false }));
    }
  }

  // A small horizontal bar chart, one bar per health bucket represented
  // among the at-risk projects -- reuses the same active/delayed/atRisk
  // status colors as the rest of the app (see .status-dot in style.css)
  // rather than introducing a new categorical palette for what's really
  // still "health," just filtered to the subset that needs attention.
  function renderRiskHealthChart(risks) {
    const container = document.getElementById("risk-health-chart");
    if (!container) return;
    const order = ["atRisk", "delayed", "active"];
    const counts = { atRisk: 0, delayed: 0, active: 0 };
    risks.forEach((r) => { if (counts[r.healthBucket] != null) counts[r.healthBucket] += 1; });
    const max = Math.max(1, ...order.map((k) => counts[k]));

    const present = order.filter((k) => counts[k] > 0);
    if (present.length === 0) {
      container.innerHTML = '<div class="empty-state">Nothing to chart yet.</div>';
      return;
    }
    container.innerHTML = present
      .map((key) => {
        const pct = (counts[key] / max) * 100;
        return `
          <div class="hbar-row">
            <div class="hbar-label"><span class="status-dot ${key}"></span>${escapeHtml(HEALTH_LABEL[key] || key)}</div>
            <div class="hbar-track"><div class="hbar-fill ${key}" style="width:${pct}%;"><span class="hbar-value">${counts[key]}</span></div></div>
          </div>`;
      })
      .join("");
  }

  function renderRisksTable(risks) {
    const tbody = document.getElementById("risks-tbody");
    const empty = document.getElementById("risks-empty");
    const badge = document.getElementById("tab-count-risks");
    if (!tbody) return;
    if (badge) badge.textContent = String(risks.length);
    empty.hidden = risks.length > 0;
    if (risks.length === 0) {
      tbody.innerHTML = "";
      return;
    }
    tbody.innerHTML = risks
      .map(
        (r) => `
        <tr data-risk-id="${escapeHtml(String(r.id))}">
          <td><a class="project-link" href="${escapeHtml(r.url || "#")}" target="_blank" rel="noopener">${escapeHtml(r.name)}</a></td>
          <td>${escapeHtml(r.reason)}</td>
          <td><span class="health-pill"><span class="status-dot ${r.healthBucket}"></span>${escapeHtml(HEALTH_LABEL[r.healthBucket] || r.healthBucket)}</span></td>
          <td>${escapeHtml(r.owners)}</td>
          <td>${escapeHtml(r.gate || "—")}</td>
          <td>${fmtDate(r.dueDate)}</td>
          <td>${r.needsMitigation ? '<span class="reason-chip reason-chip-warn">Needs plan</span>' : '<span class="reason-chip">Has plan</span>'}</td>
        </tr>`
      )
      .join("");
  }

  // ---- Client-side risk signal: gate nearing + checklist incomplete -------
  // The stage-gate checklist (Checklists tab) lives only in this browser's
  // localStorage, so ClickUp itself has no way to flag "this gate is close
  // and the checklist isn't done" -- riskSignal() in
  // netlify/functions/lib/transform.js can't see it. So this is computed
  // here instead, client-side, and folded into the Risk Register's list
  // alongside the server-provided risks (a project already flagged there
  // gets this reason appended rather than a duplicate row; one not
  // otherwise flagged gets a new row of its own). A project counts as at
  // risk this way once its own target gate date is within
  // CHECKLIST_RISK_WINDOW_DAYS and its checklist isn't 100% checked off --
  // close enough to the gate that an incomplete checklist is a real risk to
  // the date, not just "still in progress as expected."
  const CHECKLIST_RISK_WINDOW_DAYS = 14;

  // Same counting as checklistCardHtml's own totals, but with no HTML built
  // and no `defaultOpen` state to track -- just the numbers, for a project
  // that isn't necessarily even visible on the Checklists tab right now.
  function checklistProgressForProject(p) {
    const gate = p.currentGate || p.gatePhase;
    const gateIndex = GATE_ORDER.indexOf(gate);
    let totalItems = 0;
    let totalChecked = 0;
    if (gateIndex !== -1) {
      CHECKLIST_SECTION_ORDER
        .filter((key) => {
          const threshold = checklistGateThreshold(key);
          return threshold !== -1 && threshold <= gateIndex;
        })
        .forEach((key) => {
          // Same auto-check-past-gates default as checklistCardHtml, so the
          // "checklist incomplete" risk signal doesn't flag a project purely
          // because an already-passed gate was never manually ticked off.
          const threshold = checklistGateThreshold(key);
          const autoCheckDefault = threshold < gateIndex;
          const nested = key === "Packaging & Product Launch" ? packagingSubsectionsHtml(p, autoCheckDefault) : null;
          const section = checklistSectionHtml(p, key, null, null, false, nested, autoCheckDefault);
          totalItems += section.total;
          totalChecked += section.checked;
        });
    }
    const followups = checklistSectionHtml(p, "_followups", "Follow-ups & add-ons", "checklist-section-custom", false);
    totalItems += followups.total;
    totalChecked += followups.checked;
    return { totalItems, totalChecked, pct: totalItems > 0 ? totalChecked / totalItems : null };
  }

  function checklistGateRiskFor(p) {
    if (!p.targetGateDate || p.healthBucket === "completed") return null;
    const days = Math.ceil((Date.parse(p.targetGateDate) - Date.now()) / 86400000);
    if (days > CHECKLIST_RISK_WINDOW_DAYS) return null;
    const { totalItems, totalChecked, pct } = checklistProgressForProject(p);
    if (totalItems === 0 || pct === 1) return null;
    const gate = p.currentGate || p.gatePhase || "current gate";
    const whenLabel = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "due today" : `${days}d away`;
    return {
      id: p.id,
      name: p.name,
      url: p.url,
      reason: `${gate} gate ${whenLabel}, checklist ${totalChecked}/${totalItems} complete`,
      source: "checklist",
      needsMitigation: true,
      owners: ownersLabel(p),
      gate,
      dueDate: p.targetGateDate,
      healthBucket: p.healthBucket,
    };
  }

  // Merges the server's risks (data.risks/data.riskCounts) with this
  // client-only checklist signal. A project the server already flagged
  // keeps its one row, with the checklist reason appended so nothing about
  // it is lost; a project the server didn't flag gets a new row of its own.
  // riskCounts.checklist is always incremented for the KPI tile even when a
  // row was merged rather than added, so the tile reflects every project
  // this signal caught, not just the ones that got their own row.
  function mergeChecklistRisks(data) {
    const risks = (data?.risks || []).map((r) => ({ ...r }));
    const riskCounts = { ...(data?.riskCounts || {}) };
    const byId = new Map(risks.map((r) => [r.id, r]));
    (allProjects || []).forEach((p) => {
      const flag = checklistGateRiskFor(p);
      if (!flag) return;
      riskCounts.checklist = (riskCounts.checklist || 0) + 1;
      const existing = byId.get(p.id);
      if (existing) {
        existing.reason = `${existing.reason} · ${flag.reason}`;
        if (flag.needsMitigation && !existing.needsMitigation) {
          existing.needsMitigation = true;
          riskCounts.needsMitigation = (riskCounts.needsMitigation || 0) + 1;
        }
      } else {
        risks.push(flag);
        byId.set(p.id, flag);
        riskCounts.needsMitigation = (riskCounts.needsMitigation || 0) + (flag.needsMitigation ? 1 : 0);
      }
    });
    risks.sort((a, b) => (b.needsMitigation === a.needsMitigation ? 0 : b.needsMitigation ? 1 : -1));
    return { risks, riskCounts };
  }

  function renderRisks(data) {
    const { risks, riskCounts } = mergeChecklistRisks(data);
    renderRiskKpis(risks, riskCounts, data?.counts);
    renderRiskHealthChart(risks);
    renderRisksTable(risks);
    // The table just got rebuilt from scratch, so any highlight/dim state
    // an active filter had applied to the old rows is gone -- reapply it
    // to the fresh ones rather than leaving the filter "on" with nothing
    // visibly marked.
    if (activeRiskFilter) applyRiskReasonFilter(activeRiskFilter, { toggle: false, scroll: false });
  }

  // ---- Resourcing: workload by person ------------------------------------

  function workloadCardHtml(person) {
    const isUnassigned = person.id === "unassigned";
    const buckets = [
      { key: "active", label: "Active" },
      { key: "delayed", label: "Delayed" },
      { key: "atRisk", label: "At Risk" },
    ].filter((b) => person[b.key] > 0);

    const projectRows = person.projects
      .filter((p) => p.healthBucket !== "completed")
      .map(
        (p) => `
        <li>
          <a href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>
          <span class="status-dot ${p.healthBucket}"></span>
        </li>`
      )
      .join("");

    return `
      <div class="workload-card${isUnassigned ? " workload-card-unassigned" : ""}${person.total >= 5 ? " workload-card-heavy" : ""}">
        <div class="workload-card-header">
          <span class="workload-name">${escapeHtml(person.name)}</span>
          <span class="workload-total">${person.total} active</span>
        </div>
        <div class="workload-breakdown">
          ${buckets.length
            ? buckets.map((b) => `<span class="workload-chip"><span class="status-dot ${b.key}"></span>${person[b.key]} ${b.label}</span>`).join("")
            : '<span class="workload-chip">All caught up</span>'}
        </div>
        <ul class="workload-projects">${projectRows || '<li class="empty-state">No open projects</li>'}</ul>
      </div>`;
  }

  function renderWorkload(workload) {
    const grid = document.getElementById("workload-grid");
    if (!grid) return;
    if (!workload || workload.length === 0) {
      grid.innerHTML = '<div class="empty-state">No workload data yet.</div>';
      return;
    }
    // "Unassigned" is a data gap, not a person -- always show it last so real
    // people's workload is the first thing a PM scans.
    const sorted = [...workload].sort((a, b) => {
      if (a.id === "unassigned") return 1;
      if (b.id === "unassigned") return -1;
      return b.total - a.total;
    });
    grid.innerHTML = sorted.map(workloadCardHtml).join("");
  }

  // ---- Resourcing: workload donut -----------------------------------------
  // A donut showing each person's share of live (active/delayed/at-risk)
  // projects, top 6 named people by fixed categorical slot + "Unassigned" +
  // "Others" -- built off the same data.workload the cards above (and the
  // per-person kanban board below) use.
  // Palette + roles follow the dataviz skill's reference instance
  // (references/palette.md): categorical slots 1-6 in rank order, slot 8
  // (red) deliberately reused for "Unassigned" as an attention color for the
  // ownership gap, and a neutral gray for the non-identity "Others" bucket.
  const DONUT_PALETTE_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
  const DONUT_PALETTE_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];
  const DONUT_UNASSIGNED = { light: "#e34948", dark: "#e66767" };

  function isDarkMode() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  // Splits workload into donut slices: "Unassigned" (if it carries any live
  // load) stays its own slice in the attention color; named people are
  // ranked by total descending, the top 6 get an individual categorical
  // slot, and everyone past that is folded into one "Others" slice so the
  // chart never seats a 7th+ identity color (series-count ladder, palette.md).
  // Every real person gets their OWN slice/arc here -- nobody is merged
  // into a combined "Others" wedge, since a lumped ballpark figure hides
  // exactly who's carrying what. Only the fixed 6-slot categorical palette
  // (plus the reserved Unassigned red) can be spent on distinct COLORS
  // without breaking the dataviz rule against generating new hues per
  // series, so past the top 6 named people every remaining person's slice
  // shares one neutral "long tail" color and is summarized as one legend
  // row -- but each of them still gets a real, individually-hoverable arc
  // sized to their own project count, not folded into anyone else's.
  // Long-tail slices past the top 6 each get their own distinct hue instead
  // of one flat "Others" gray -- an explicit ask ("even if a person falls
  // under others, it's better that way"), and a deliberate departure from
  // the dataviz skill's usual fixed-6-slot/no-generated-hues rule for this
  // one chart, since the alternative (everyone past #6 painted identically)
  // is exactly the "ballpark figure" this feature was built to avoid.
  // Golden-angle spacing (~137.5 degrees per step) spreads any number of
  // hues around the wheel with no visible clustering, however many people
  // fall into the long tail. Kept in the same lightness/saturation band as
  // the fixed 6-slot palette so it still reads as one coherent chart rather
  // than two different styles glued together.
  function longTailColor(index, dark) {
    const hue = (index * 137.508) % 360;
    return dark ? `hsl(${hue.toFixed(1)}, 55%, 60%)` : `hsl(${hue.toFixed(1)}, 62%, 46%)`;
  }

  function donutSlices(workload) {
    const dark = isDarkMode();
    const palette = dark ? DONUT_PALETTE_DARK : DONUT_PALETTE_LIGHT;
    const unassignedColor = dark ? DONUT_UNASSIGNED.dark : DONUT_UNASSIGNED.light;

    const list = workload || [];
    const unassigned = list.find((p) => p.id === "unassigned");
    const named = list.filter((p) => p.id !== "unassigned" && p.total > 0).sort((a, b) => b.total - a.total);

    const slices = [];
    if (unassigned && unassigned.total > 0) {
      slices.push({ id: unassigned.id, label: unassigned.name, value: unassigned.total, color: unassignedColor, ownLegendRow: true });
    }
    named.forEach((p, i) => {
      const isTop = i < 6;
      slices.push({
        id: p.id,
        label: p.name,
        value: p.total,
        color: isTop ? palette[i] : longTailColor(i - 6, dark),
        ownLegendRow: isTop,
      });
    });
    return slices;
  }

  function renderWorkloadDonut(workload) {
    const svg = document.getElementById("workload-donut-svg");
    const legend = document.getElementById("workload-donut-legend");
    const center = document.getElementById("workload-donut-center");
    if (!svg || !legend) return;

    const slices = donutSlices(workload);
    const total = slices.reduce((sum, s) => sum + s.value, 0);

    if (center) {
      // This is a SUM OF ASSIGNMENTS, not a project count: a project with 3
      // owners contributes 1 to each of their totals, so it's counted 3
      // times here even though it's 1 project. Labeling it "live projects"
      // was misleading once a real portfolio showed the gap plainly (65
      // here vs. 18 actual projects tracked) -- "assignments" is the
      // accurate word for what's actually being summed.
      center.innerHTML = total > 0
        ? `<span class="donut-center-value">${total}</span><span class="donut-center-label">assignment${total === 1 ? "" : "s"}</span>`
        : "";
    }

    if (total === 0) {
      svg.innerHTML = "";
      legend.innerHTML = '<li class="empty-state">No live projects to chart yet.</li>';
      return;
    }

    // Shared-cx/cy/r multi-circle donut: each slice is a full-circle stroke
    // whose dasharray length is its share of the circumference, offset by
    // the running total of everything before it, rotated -90deg so the
    // first slice starts at 12 o'clock. A small GAP is subtracted from each
    // slice's own dash length (not from its offset) to leave a thin visual
    // seam between segments without shifting the following slice's start --
    // this matters more now that a long tail of 1-project people can each
    // be a sliver right next to another sliver of the same color, and the
    // gap is what keeps them visually distinguishable/hoverable as separate
    // arcs instead of reading as one blob.
    const R = 70;
    const STROKE = 32;
    const CIRC = 2 * Math.PI * R;
    const GAP = slices.length > 1 ? 1.5 : 0;

    let offset = 0;
    const circles = slices
      .map((s) => {
        const rawLen = (s.value / total) * CIRC;
        const len = Math.max(rawLen - GAP, 0.001);
        const dasharray = `${len} ${CIRC - len}`;
        const dashoffset = -offset;
        offset += rawLen;
        const pct = ((s.value / total) * 100).toFixed(1);
        return `<circle class="donut-slice" data-name="${escapeHtml(s.label)}" data-value="${s.value}" data-pct="${pct}" cx="100" cy="100" r="${R}" fill="none" stroke="${s.color}" stroke-width="${STROKE}" stroke-dasharray="${dasharray}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 100 100)"><title>${escapeHtml(s.label)}: ${s.value} (${pct}%)</title></circle>`;
      })
      .join("");
    svg.innerHTML = circles;

    // Legend stays capped to the top 6 + Unassigned + one "Others" summary
    // row so it doesn't sprawl to 30+ lines -- this is purely a LEGEND
    // display choice; the chart itself (built above) already gave every
    // one of those "Others" people their own real slice.
    const legendRows = [];
    let othersCount = 0;
    let othersTotal = 0;
    const othersColors = [];
    slices.forEach((s) => {
      if (s.ownLegendRow) legendRows.push(s);
      else {
        othersCount += 1;
        othersTotal += s.value;
        othersColors.push(s.color);
      }
    });
    if (othersTotal > 0) {
      // The summary row's swatch is a gradient sampling a few of the actual
      // long-tail colors, not one flat gray, so the legend itself hints
      // that this row stands in for many distinctly-colored slices rather
      // than one uniform group.
      const sample = othersColors.filter((_, i) => i % Math.max(1, Math.floor(othersColors.length / 5)) === 0).slice(0, 5);
      const gradient = sample.length > 1 ? `linear-gradient(90deg, ${sample.join(", ")})` : sample[0] || "var(--gridline)";
      legendRows.push({ label: `Others (${othersCount} ${othersCount === 1 ? "person" : "people"})`, value: othersTotal, color: gradient });
    }

    legend.innerHTML = legendRows
      .map((s) => {
        const pct = ((s.value / total) * 100).toFixed(1);
        return `<li class="viz-legend-item"><span class="viz-legend-swatch" style="background:${s.color};"></span><span class="viz-legend-label">${escapeHtml(s.label)}</span><span class="viz-legend-value">${s.value} · ${pct}%</span></li>`;
      })
      .join("");
  }

  // Custom fast hover tooltip for the donut's per-person slices -- the
  // native SVG <title> tooltip (still present as a fallback/accessibility
  // aid) is slow to appear and unstyled, so this gives an immediate,
  // themed readout of exactly who a sliver belongs to, even when many
  // slivers share the same "long tail" color.
  // Generalized so both the Resources tab's workload donut AND the
  // Overview tab's Portfolio Mix health donut get the exact same
  // hover-grows-and-shows-a-tooltip treatment (see .donut-slice's CSS)
  // instead of the health donut being the one static chart. `formatLabel`
  // gets the hovered slice's dataset (name/value/pct) and returns the
  // tooltip's inner HTML, since the two donuts describe their slices
  // differently ("N live projects" vs. "N projects", one bucket-labeled by
  // health status rather than by person). The tooltip element itself is
  // looked up (and created) PER ROOT now, not via one shared global id --
  // calling this twice for two different roots with the same id would
  // silently hand the second donut's hover events the first donut's
  // tooltip element.
  function setupDonutHoverTooltip(rootId, svgId, formatLabel) {
    const root = document.getElementById(rootId);
    const svg = document.getElementById(svgId);
    if (!root || !svg) return;
    let tooltip = root.querySelector(":scope > .donut-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "donut-tooltip";
      tooltip.hidden = true;
      root.appendChild(tooltip);
    }

    const show = (slice, evt) => {
      tooltip.innerHTML = formatLabel(slice.dataset);
      tooltip.hidden = false;
      move(evt);
    };
    const move = (evt) => {
      const rootRect = root.getBoundingClientRect();
      tooltip.style.left = `${evt.clientX - rootRect.left + 14}px`;
      tooltip.style.top = `${evt.clientY - rootRect.top + 14}px`;
    };
    const hide = () => { tooltip.hidden = true; };

    svg.addEventListener("mouseover", (e) => {
      const slice = e.target.closest(".donut-slice");
      if (slice) show(slice, e);
    });
    svg.addEventListener("mousemove", (e) => {
      const slice = e.target.closest(".donut-slice");
      if (slice) move(e);
    });
    svg.addEventListener("mouseout", (e) => {
      if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest(".donut-slice")) hide();
    });
  }

  const workloadDonutTooltipLabel = (ds) =>
    `<strong>${escapeHtml(ds.name)}</strong><br>${escapeHtml(ds.value)} live project${ds.value === "1" ? "" : "s"} · ${escapeHtml(ds.pct)}%`;
  const healthDonutTooltipLabel = (ds) =>
    `<strong>${escapeHtml(ds.name)}</strong><br>${escapeHtml(ds.value)} project${ds.value === "1" ? "" : "s"} · ${escapeHtml(ds.pct)}%`;

  // ---- Resourcing: board by person ---------------------------------------
  // A kanban board -- one column per assignee, one card per live
  // (non-completed) project they're on -- reusing the exact same
  // .kanban-board/.kanban-column/.kanban-card markup and CSS as the By
  // Category / By Stage Gate tabs (see renderGroupedBoard) rather than
  // introducing a new visual style. Replaced the old "weekly hours by
  // project" stacked-bar chart, which tried to translate ClickUp Estimate
  // data (often missing) into an hours-per-week readout that was more
  // confusing than useful; this just shows, plainly, who's on what.
  // `tasks` is one of: null (weekly data hasn't loaded yet -- unknown, not
  // "none"), [] (loaded, genuinely nothing subtask-level logged for this
  // person on this project -- ownership only known at the project level),
  // or a real list of that person's own open items on this project. Showing
  // all three states distinctly matters here: every card used to say the
  // same thing (project name + health) in every column it appeared in, so
  // there was no way to tell what a specific person was actually doing on a
  // shared project without opening ClickUp.
  const KANBAN_TASK_CAP = 4;
  function personKanbanCardHtml(proj, tasks, errorMsg) {
    let tasksHtml;
    if (tasks === null) {
      tasksHtml = `<div class="kanban-card-tasks-empty">Loading tasks…</div>`;
    } else if (errorMsg) {
      // Distinct from the normal "nothing logged" empty state -- this means
      // the per-project task lookup actually threw server-side (see
      // weekly.js's diagnostics.projectErrors), so it's worth flagging
      // instead of silently reading the same as "no work exists here."
      tasksHtml = `<div class="kanban-card-tasks-empty kanban-card-tasks-error" title="${escapeHtml(errorMsg)}">⚠ Couldn't load tasks for this project</div>`;
    } else if (tasks.length === 0) {
      tasksHtml = `<div class="kanban-card-tasks-empty">No specific tasks logged yet</div>`;
    } else {
      const visible = tasks.slice(0, KANBAN_TASK_CAP);
      const overflow = tasks.length - visible.length;
      tasksHtml = `<ul class="kanban-card-tasks">${visible.map((t) => `<li>${escapeHtml(t.name)}</li>`).join("")}${overflow > 0 ? `<li class="kanban-card-tasks-more">+${overflow} more</li>` : ""}</ul>`;
    }
    const fullProject = findProject(proj.id) || proj;
    return `
      <div class="kanban-card deepdive-card" data-project-id="${escapeHtml(proj.id)}">
        <div class="deepdive-card-head">
          <span class="deepdive-icon">${deepDiveIconHtml(fullProject)}</span>
          <a class="card-title" href="${escapeHtml(proj.url || "#")}" target="_blank" rel="noopener">${escapeHtml(proj.name)}</a>
        </div>
        <div class="card-meta">
          <span class="health-pill"><span class="status-dot ${proj.healthBucket}"></span>${escapeHtml(HEALTH_LABEL[proj.healthBucket] || proj.healthBucket)}</span>
        </div>
        ${tasksHtml}
      </div>`;
  }

  // `weekly` is the cached /api/weekly payload (see loadWeekly/weeklyData) --
  // its per-project `openTasks` (every still-open subtask at any depth, not
  // just this week's, see flattenOpenTasks in lib/transform.js) is what lets
  // each card show a specific person's own items on that project instead of
  // just repeating the project's name and health. `weekly` is often still
  // null the first time this renders (it's lazy-loaded only once the
  // Weekly Activity or Resources tab is opened) -- callers re-render this
  // board once it arrives (see renderWeekly).
  function renderWorkloadKanban(workload, weekly) {
    const board = document.getElementById("board-by-person");
    const emptyState = document.getElementById("board-by-person-empty");
    if (!board) return;

    const tasksByProject = new Map((weekly?.projects || []).map((p) => [p.id, p.openTasks || []]));
    const weeklyProjectErrorById = new Map((weekly?.projects || []).filter((p) => p.updatesError).map((p) => [p.id, p.updatesError]));
    // Person identity can legitimately arrive from two different ClickUp
    // sources for the same real human -- their native Assignee field on one
    // task, the "Assigned To (Multi)" custom field on another -- and those
    // two sources hand back different id shapes (a numeric ClickUp user id
    // vs. a Labels-field option uuid). The workload roster (built by
    // computeWorkload, one entry per id it happened to see first) and this
    // project's own openTasks (resolved independently, per task) can end up
    // on opposite sides of that split for the very same person, so an id-only
    // `===` compare can go to zero for everyone even though the underlying
    // data is there -- match on id OR on name (case/whitespace-insensitive)
    // so either source is enough to connect a task back to its person.
    const personNameById = new Map((workload || []).map((p) => [String(p.id), String(p.name || "").trim().toLowerCase()]));
    function assigneeMatchesPerson(assignee, personId) {
      if (String(assignee.id) === String(personId)) return true;
      const personName = personNameById.get(String(personId));
      const assigneeName = String(assignee.name || "").trim().toLowerCase();
      return !!personName && !!assigneeName && personName === assigneeName;
    }
    function tasksForPerson(projectId, personId) {
      if (!weekly) return null;
      const tasks = tasksByProject.get(projectId) || [];
      if (personId === "unassigned") return tasks.filter((t) => !(t.assignees && t.assignees.length));
      return tasks.filter((t) => (t.assignees || []).some((a) => assigneeMatchesPerson(a, personId)));
    }

    const people = (workload || [])
      .map((p) => ({ ...p, liveProjects: (p.projects || []).filter((proj) => proj.healthBucket !== "completed") }))
      .filter((p) => p.liveProjects.length > 0);

    if (emptyState) emptyState.hidden = people.length > 0;
    if (people.length === 0) {
      board.innerHTML = "";
      return;
    }

    // Same ordering as the workload card grid above: "Unassigned" is a data
    // gap, not a person, so it always sits last regardless of its count.
    const sorted = [...people].sort((a, b) => {
      if (a.id === "unassigned") return 1;
      if (b.id === "unassigned") return -1;
      return b.liveProjects.length - a.liveProjects.length;
    });

    board.innerHTML = sorted
      .map(
        (p) => `
        <div class="kanban-column">
          <div class="kanban-column-header">${escapeHtml(p.name)}<span class="count">${p.liveProjects.length}</span></div>
          ${p.liveProjects.map((proj) => personKanbanCardHtml(proj, tasksForPerson(proj.id, p.id), weeklyProjectErrorById.get(proj.id))).join("")}
        </div>`
      )
      .join("");
  }

  // ---- Calendar (projects plotted on their target/due date) --------------

  const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function calendarChipHtml(p, hasGap) {
    return `
      <a class="calendar-chip${hasGap ? " calendar-chip-gap" : ""}" href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener" title="${escapeHtml(p.name)}${hasGap ? " — has an open planning gap" : ""}">
        <span class="status-dot ${p.healthBucket}"></span>${escapeHtml(p.name)}${hasGap ? '<span class="calendar-chip-gap-dot" aria-hidden="true"></span>' : ""}
      </a>`;
  }

  // Every project actually PLOTTED on the calendar this month (i.e. it has
  // a due date that falls in the visible month -- not just "in the VIEWING
  // scope," which used to include every project regardless of whether it
  // could even appear on this grid) that also shows up in Decisions & Gaps
  // -- soonest target date first -- so a PM has a ready-made agenda for the
  // Thursday NPD meeting without cross-referencing two tabs. Reuses the
  // gaps Decisions & Gaps already computed rather than inventing a second
  // definition of "needs a decision."
  function calendarAgendaItemHtml(f) {
    return `
      <li>
        <a class="decision-title" href="${escapeHtml(f.url || "#")}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>
        <div class="decision-reasons">${f.gaps.map((g) => `<span class="reason-chip">${escapeHtml(g.label)}</span>`).join("")}</div>
      </li>`;
  }

  function renderCalendarAgenda(data, visibleIds) {
    const list = document.getElementById("calendar-agenda-list");
    const empty = document.getElementById("calendar-agenda-empty");
    if (!list || !data || !data.decisions) return;

    const flagged = (data.decisions.flagged || []).filter((f) => visibleIds.has(f.id));
    const ranked = flagged
      .map((f) => {
        const project = allProjects.find((p) => p.id === f.id);
        const dateMs = project?.targetGateDate ? Date.parse(project.targetGateDate) : Infinity;
        return { f, dateMs };
      })
      .sort((a, b) => a.dateMs - b.dateMs);

    empty.hidden = ranked.length > 0;
    if (ranked.length === 0) {
      list.innerHTML = "";
      return;
    }

    const CAP = 8;
    const shown = ranked.slice(0, CAP).map(({ f }) => calendarAgendaItemHtml(f));
    if (ranked.length > CAP) {
      shown.push(`<li class="empty-state">+${ranked.length - CAP} more — see Decisions &amp; Gaps</li>`);
    }
    list.innerHTML = shown.join("");
  }

  function renderCalendar() {
    const data = window.__portfolioData;
    const grid = document.getElementById("calendar-grid");
    const label = document.getElementById("calendar-month-label");
    const note = document.getElementById("calendar-nodate-note");
    if (!grid) return;

    const base = new Date();
    base.setDate(1);
    base.setMonth(base.getMonth() + calendarMonthOffset);
    const year = base.getFullYear();
    const month = base.getMonth();

    label.textContent = base.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    // Calendar tab intentionally ignores the DUE WITHIN pills (browsing by
    // month is the point) but still respects the VIEWING scope selector, so
    // scoping to one project shows just that project's date.
    let rows = allProjects.slice();
    if (viewingProjectId) rows = rows.filter((p) => p.id === viewingProjectId);

    const gappedIds = new Set((data?.decisions?.flagged || []).map((f) => f.id));

    const byDay = {};
    let noDateCount = 0;
    rows.forEach((p) => {
      if (!p.targetGateDate) { noDateCount += 1; return; }
      const d = new Date(p.targetGateDate);
      if (d.getFullYear() === year && d.getMonth() === month) {
        const day = d.getDate();
        (byDay[day] = byDay[day] || []).push(p);
      }
    });

    // Only projects genuinely PLOTTED on this month's grid (has a due date
    // that actually falls in the visible month) are eligible for "Needs a
    // decision" -- computed from byDay (above), not from the raw viewing-
    // scoped list, so a project with no date at all (which can't appear on
    // any calendar) never shows up here duplicating what Decisions & Gaps
    // already lists.
    renderCalendarAgenda(data, new Set(Object.values(byDay).flat().map((p) => p.id)));

    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayKey = new Date();
    const isCurrentMonth = todayKey.getFullYear() === year && todayKey.getMonth() === month;

    // Monday-Sunday range containing a given date -- used so hovering ANY
    // day (not just Thursday) can surface "here's what needs discussing
    // this week," aggregated across the whole week rather than just that
    // single day, since a gap's target date landing on a Tuesday is just as
    // relevant to the Thursday NPD meeting as one landing on the Thursday
    // itself.
    function weekRangeFor(date) {
      const d = new Date(date);
      const dow = d.getDay();
      const monday = new Date(d);
      monday.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
      monday.setHours(0, 0, 0, 0);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      sunday.setHours(23, 59, 59, 999);
      return { monday, sunday };
    }

    // What needs discussing THIS WEEK, regardless of which day it's plotted
    // on -- reuses the same gappedIds/rows Decisions & Gaps already flags,
    // so this is a hover-surfaced view of that same list, not a new
    // definition of "needs a decision."
    function weekAgendaText(monday, sunday) {
      const items = rows.filter((p) => {
        if (!gappedIds.has(p.id) || !p.targetGateDate) return false;
        const t = new Date(p.targetGateDate).getTime();
        return t >= monday.getTime() && t <= sunday.getTime();
      });
      if (items.length === 0) return "";
      return `Needs a decision this week: ${items.map((p) => p.name).join("; ")}`;
    }

    const cells = [];
    for (let i = 0; i < firstWeekday; i++) cells.push('<div class="calendar-cell calendar-cell-blank"></div>');
    for (let day = 1; day <= daysInMonth; day++) {
      const isToday = isCurrentMonth && todayKey.getDate() === day;
      // Thursdays keep a light badge because that's the weekly NPD meeting,
      // but the highlighting a PM actually needs -- "does anything here
      // need a decision" -- isn't limited to Thursday, so every day whose
      // week has an open gap gets its own highlight + hover summary too.
      const isThursday = new Date(year, month, day).getDay() === 4;
      const dayProjects = byDay[day] || [];
      const { monday, sunday } = weekRangeFor(new Date(year, month, day));
      const weekAgenda = weekAgendaText(monday, sunday);
      cells.push(`
        <div class="calendar-cell${isToday ? " calendar-cell-today" : ""}${isThursday ? " calendar-cell-thursday" : ""}${weekAgenda ? " calendar-cell-discuss" : ""}"${weekAgenda ? ` title="${escapeHtml(weekAgenda)}"` : ""}>
          <div class="calendar-day-number">${day}${isThursday ? '<span class="calendar-npd-badge" title="NPD weekly meeting">NPD</span>' : ""}</div>
          ${dayProjects.map((p) => calendarChipHtml(p, gappedIds.has(p.id))).join("")}
        </div>`);
    }
    // Pad the final week so the grid stays a clean rectangle.
    while (cells.length % 7 !== 0) cells.push('<div class="calendar-cell calendar-cell-blank"></div>');

    grid.innerHTML =
      WEEKDAY_LABELS.map((d) => `<div class="calendar-weekday${d === "Thu" ? " calendar-weekday-thursday" : ""}">${d}</div>`).join("") +
      cells.join("");

    note.textContent = noDateCount > 0
      ? `${noDateCount} project${noDateCount === 1 ? "" : "s"} ${noDateCount === 1 ? "has" : "have"} no target/due date, so they can't appear here — see Decisions & Gaps.`
      : "";
  }

  // ---- New Idea intake ---------------------------------------------------

  let lastLoadedIdeas = [];
  let editingIdeaId = null; // set while a card's inline edit form is open

  function ideaCardHtml(idea, opts = {}) {
    const created = idea.createdAt ? fmtDate(idea.createdAt) : "—";
    if (idea.id === editingIdeaId) {
      return `
        <li>
          <form class="idea-edit-form" data-idea-id="${escapeHtml(idea.id)}">
            <div class="form-grid">
              <label class="form-field">
                <span class="form-label">Title <span class="required">*</span></span>
                <input type="text" class="idea-edit-title" value="${escapeHtml(idea.name || "")}" required />
              </label>
              <label class="form-field">
                <span class="form-label">Product / Model <span class="required">*</span></span>
                <input type="text" class="idea-edit-product" value="${escapeHtml(idea.product || "")}" required />
              </label>
              <label class="form-field">
                <span class="form-label">Product Category <span class="required">*</span></span>
                <input type="text" class="idea-edit-category" list="idea-category-options" value="${escapeHtml(idea.productCategory || "")}" required />
              </label>
              <label class="form-field">
                <span class="form-label">Target date <span class="optional">(optional)</span></span>
                <input type="date" class="idea-edit-target-date" value="${escapeHtml((idea.dueDate || "").slice(0, 10))}" />
              </label>
            </div>
            <label class="form-field form-field-wide">
              <span class="form-label">Description <span class="required">*</span></span>
              <textarea class="idea-edit-description" rows="4" required>${escapeHtml(idea.descriptionText != null ? idea.descriptionText : idea.description || "")}</textarea>
            </label>
            <div class="form-actions">
              <button type="submit" class="action-btn action-btn-primary">Save changes</button>
              <button type="button" class="action-btn idea-edit-cancel">Cancel</button>
              <span class="form-status idea-edit-status"></span>
            </div>
          </form>
        </li>`;
    }
    // Local-only backups (see saveLocalBackupEntry) aren't real ClickUp
    // tasks, so they skip the Edit flow (nothing to PUT to) and get a
    // dismiss control plus the same "saved locally" badge the registers use.
    const localBits = idea.localOnly
      ? `<span class="local-backup-badge" title="The ClickUp intake list isn't configured yet -- kept safe in this browser instead">Saved locally only</span>
         <button type="button" class="local-backup-dismiss" data-local-dismiss data-kind="idea" data-id="${escapeHtml(idea.id)}" title="Remove this local backup">&times;</button>`
      : `<button type="button" class="idea-edit-btn" data-idea-edit="${escapeHtml(idea.id)}" title="Edit this submission">Edit</button>`;
    return `
      <li${idea.localOnly ? ' class="local-backup-item"' : ""}>
        <a class="idea-title" href="${escapeHtml(idea.url || "#")}" target="_blank" rel="noopener">${escapeHtml(idea.name)}</a>
        ${localBits}
        <div class="idea-meta">Submitted ${created}${idea.dueDate ? ` · Target ${fmtDate(idea.dueDate)}` : ""}</div>
        ${idea.description ? `<div class="idea-desc">${escapeHtml(idea.description)}</div>` : ""}
        ${opts.mockNote ? `<span class="idea-mock-note">${escapeHtml(opts.mockNote)}</span>` : ""}
      </li>`;
  }

  function renderIdeas(ideas) {
    lastLoadedIdeas = ideas || [];
    const list = document.getElementById("ideas-list");
    const empty = document.getElementById("ideas-empty");
    const all = [...getLocalBackupEntries("idea"), ...(ideas || [])].sort(
      (a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)
    );
    if (all.length === 0) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = all.map((idea) => ideaCardHtml(idea)).join("");
  }

  async function loadIdeas() {
    try {
      const res = await fetch("/api/ideas");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      renderIdeas(data.ideas || []);
    } catch (err) {
      console.error(err);
      renderIdeas([]);
    }
  }

  // ---- Redundant local save for Risks / Issues / Lessons / Ideas ----------
  // Each of these four forms POSTs to a dedicated ClickUp list; when that
  // list isn't configured yet (see registers.js/ideas.js's "mock" response)
  // the server has nowhere durable to put what was submitted, and the same
  // is true if the request fails outright (offline, server error). Either
  // way, without this the entry would simply be gone on reload -- typed in,
  // "submitted," then lost. This keeps one browser-local backup copy per
  // kind ("risk" | "issue" | "lesson" | "idea") so nothing logged through
  // these forms disappears just because ClickUp isn't wired up yet. It's a
  // safety net, not a second source of truth: a submission that actually
  // reaches ClickUp (source: "clickup") never touches this store, and once
  // the real list is configured, new submissions stop accumulating here --
  // existing local backups just sit alongside the real entries until
  // someone re-enters them in ClickUp and dismisses the local copy.
  function localBackupStorageKey(kind) {
    return `pm-dashboard-local-backup:${kind}`;
  }
  function getLocalBackupEntries(kind) {
    try {
      const raw = localStorage.getItem(localBackupStorageKey(kind));
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function saveLocalBackupEntry(kind, entry) {
    try {
      const entries = getLocalBackupEntries(kind);
      entries.unshift({ ...entry, id: entry.id || `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, localOnly: true });
      localStorage.setItem(localBackupStorageKey(kind), JSON.stringify(entries));
    } catch {
      // Storage unavailable (private browsing, quota) -- there's genuinely
      // nowhere left to keep this safe in that case.
    }
  }
  function removeLocalBackupEntry(kind, id) {
    try {
      localStorage.setItem(localBackupStorageKey(kind), JSON.stringify(getLocalBackupEntries(kind).filter((e) => e.id !== id)));
    } catch {
      /* no-op */
    }
  }
  // One delegated dismiss handler covers every list that can show a local
  // backup badge (the three registers' lists + Ideas) -- removes it from
  // this browser's backup store and re-renders that one list.
  function wireLocalBackupDismiss(containerId, kind, rerender) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-local-dismiss]");
      if (!btn) return;
      removeLocalBackupEntry(kind, btn.dataset.id);
      rerender();
    });
  }

  // ---- Risk / Issues / Lessons Learnt registers ---------------------------
  // Three near-identical logbook forms on the "Risks & Issues" tab, all
  // driven by the same generic logic against /api/registers?type=X (see
  // registers.js) -- this config just says which DOM ids and payload fields
  // each type's form/list uses, mirroring the New Idea intake above.
  const REGISTER_UI = {
    risk: {
      listId: "risk-list", emptyId: "risk-list-empty", formId: "risk-form",
      statusId: "risk-form-status", btnId: "risk-submit-btn",
      fields: ["title", "project", "likelihood", "impact", "owner", "targetDate", "mitigation", "description"],
    },
    issue: {
      listId: "issue-list", emptyId: "issue-list-empty", formId: "issue-form",
      statusId: "issue-form-status", btnId: "issue-submit-btn",
      fields: ["title", "project", "severity", "owner", "targetDate", "description"],
    },
    lesson: {
      listId: "lesson-list", emptyId: "lesson-list-empty", formId: "lesson-form",
      statusId: "lesson-form-status", btnId: "lesson-submit-btn",
      fields: ["title", "project", "category", "owner", "description"],
    },
  };

  function registerEntryHtml(entry, type) {
    const created = entry.createdAt ? fmtDate(entry.createdAt) : "—";
    const localBits = entry.localOnly
      ? `<span class="local-backup-badge" title="ClickUp isn't connected for this register yet -- kept safe in this browser instead">Saved locally only</span>
         <button type="button" class="local-backup-dismiss" data-local-dismiss data-kind="${escapeHtml(type)}" data-id="${escapeHtml(entry.id)}" title="Remove this local backup">&times;</button>`
      : "";
    return `
      <li class="${entry.localOnly ? "local-backup-item" : ""}">
        <a class="idea-title" href="${escapeHtml(entry.url || "#")}" target="_blank" rel="noopener">${escapeHtml(entry.name)}</a>
        ${localBits}
        <div class="idea-meta">Logged ${created}${entry.dueDate ? ` · ${fmtDate(entry.dueDate)}` : ""}</div>
        ${entry.description ? `<div class="idea-desc">${escapeHtml(entry.description)}</div>` : ""}
      </li>`;
  }

  function renderRegisterList(type, entries) {
    const ui = REGISTER_UI[type];
    const list = document.getElementById(ui.listId);
    const empty = document.getElementById(ui.emptyId);
    if (!list) return;
    // Local backups (see saveLocalBackupEntry) always merge in, newest
    // first alongside whatever the server returned -- a PM shouldn't have
    // to remember a submission only "took" locally to go find it.
    const all = [...getLocalBackupEntries(type), ...(entries || [])].sort(
      (a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)
    );
    if (all.length === 0) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = all.map((entry) => registerEntryHtml(entry, type)).join("");
  }

  async function loadRegister(type) {
    try {
      const res = await fetch(`/api/registers?type=${type}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      renderRegisterList(type, data.entries || []);
    } catch (err) {
      console.error(err);
      // Even the GET failed (offline, server down) -- still show whatever
      // local backups exist rather than an empty list.
      renderRegisterList(type, []);
    }
  }

  // Shared by all three registers' "Project / Product" datalist -- offers
  // real project names as suggestions without forcing the field to only
  // ever reference an existing project (risks/issues/lessons aren't always
  // tied to one).
  function populateProjectNameOptions(datalistId, projects) {
    const datalist = document.getElementById(datalistId);
    if (!datalist) return;
    const existing = new Set(Array.from(datalist.options).map((o) => o.value));
    const names = [...new Set(projects.map((p) => p.name).filter(Boolean))].sort();
    names.forEach((name) => {
      if (!existing.has(name)) {
        const opt = document.createElement("option");
        opt.value = name;
        datalist.appendChild(opt);
      }
    });
  }

  function wireRegisterForm(type) {
    const ui = REGISTER_UI[type];
    const form = document.getElementById(ui.formId);
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById(ui.btnId);
      const status = document.getElementById(ui.statusId);
      const payload = {};
      ui.fields.forEach((key) => {
        const elId = `${type}-${key === "targetDate" ? "target-date" : key}`;
        const el = document.getElementById(elId);
        if (el) payload[key] = (el.value || "").trim();
      });

      btn.disabled = true;
      status.textContent = "Submitting…";
      status.className = "form-status";

      try {
        const res = await fetch(`/api/registers?type=${type}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Submission failed");

        if (data.source === "clickup") {
          status.textContent = "Saved to ClickUp ✓";
          status.className = "form-status success";
        } else {
          // Not connected -- the server could only preview this, so back it
          // up locally rather than let it vanish once the form resets.
          if (data.entry) saveLocalBackupEntry(type, data.entry);
          status.textContent = `${data.note || "Previewed only — this register's ClickUp list isn't configured yet."} Kept a local backup so it isn't lost.`;
          status.className = "form-status info";
        }
        form.reset();
        await loadRegister(type);
      } catch (err) {
        // The request itself failed (offline, server error) -- still back
        // up what was typed in from `payload` directly, since there's no
        // server response to pull an entry from this time.
        saveLocalBackupEntry(type, {
          name: payload.title || "(untitled)",
          description: payload.description || "",
          dueDate: payload.targetDate || null,
          createdAt: new Date().toISOString(),
          url: "#",
        });
        await loadRegister(type);
        status.textContent = `Couldn't submit: ${err.message}. Kept a local backup so it isn't lost.`;
        status.className = "form-status error";
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---- Checklists: stage-gate exit criteria per project -------------------
  // Static exit-criteria templates per stage gate (GATE_ORDER above), plus a
  // launch-adjacent "Packaging & Product Launch" section that isn't itself a
  // stage gate. Not sourced from ClickUp -- there's no checklist-shaped
  // custom field on this list -- so check-state lives client-side only, in
  // this browser's localStorage (same reasoning as the theme toggle: this
  // app runs from a locally-opened page, not the in-chat preview, so
  // localStorage is safe to rely on). That means checked-off items are local
  // to whoever's browser checked them, not synced to ClickUp or shared
  // across teammates.
  //
  // CUMULATIVE by design: a project at "Detailed Design" shows every section
  // from "Project Kickoff" through "Detailed Design", not just the current
  // gate's own items -- so an earlier item that never got checked off stays
  // visible (and trackable) instead of silently disappearing the moment the
  // project moves to the next gate.
  const STAGE_GATE_CHECKLISTS = {
    "Project Kickoff": [
      "Project charter / one-pager approved",
      "Executive sponsor assigned",
      "Preliminary budget estimate logged",
      "Cross-functional team assigned (Eng, Ops, Supply Chain)",
    ],
    "Scoping & Feasibility": [
      "Technical feasibility assessment complete",
      "Target cost (BOM) estimated",
      "Market / customer need validated",
      "Supply chain risk review done",
      "Go/no-go decision documented",
    ],
    "Preliminary Design": [
      "Concept design finalized",
      "Preliminary BOM created",
      "Key suppliers identified for critical components",
      "Design review held with stakeholders",
    ],
    "Detailed Design": [
      "Final BOM locked",
      "Engineering drawings / specs released",
      "Prototype built and tested",
      "Field / pilot test plan approved",
    ],
    "Launch": [
      "Pilot/field test results reviewed and signed off",
      "Production tooling and line readiness confirmed",
      "Quality / safety certification complete",
      "Launch marketing & distribution plan ready",
    ],
    "Packaging & Product Launch": [
      "Retail/shipping packaging design finalized",
      "Packaging drop, transit & stacking tests passed",
      "Labeling, compliance marks & instructions finalized",
      "Packaging supplier tooling & lead time confirmed",
      "First production run packaged and ready to ship",
    ],
    // The Box Artwork Review checklist, in from the "Box Artwork Review
    // Checklist — Mapped to the 5-Page Drawing Set" doc, one section per its
    // own 9 categories rather than one 57-item wall -- each folds
    // independently, same as every other section here, so a category that
    // doesn't apply to a given box (e.g. no multi-language requirement) is
    // easy to spot and prune with its own × per item. All nine thread in at
    // the same point Packaging & Product Launch does (see
    // checklistGateThreshold below), not as separate gates of their own.
    "Box Artwork: Title Block & Documentation": [
      "Part number matches file name, consistent across all sheets — Pages 1, 2, 3, 4, 5",
      "Revision letter/version consistent across title block, model file callout, and revision table — Pages 1, 2, 3, 4 (Page 5 uses its own version, e.g. \"V4\" — confirm it matches)",
      "\"Model File:\" callout matches actual title (name, part no, rev) — Pages 1, 2",
      "Revision history table complete (description, date, approver) — Pages 1, 2, 3, 4",
      "Approval names/dates present (Drawn, NPD, NPI, Commercial, Creative/Marketing, Q.A.) — Pages 1, 2",
      "\"Sheet X of Y\" numbering correct and sequential — Pages 1, 2 (labelled Sheet 1 of 2 / 2 of 2 — note Pages 3–5 aren't numbered into this sequence, worth flagging)",
      "Scale noted or \"DO NOT SCALE DRAWING\" disclaimer present — Pages 1, 2",
      "Confidentiality/ownership statement present — Pages 1, 2, 3, 4",
      "Keyline ownership note present (e.g. \"keyline dimensions supplied and owned by Allpack\") — Page 4 (also referenced in notes on Page 3)",
      "Disclaimer that a graphics sheet is \"for visual reference only, not for dimensional checking\" — Pages 3, 4",
    ],
    "Box Artwork: Dimensions & Construction": [
      "OD (L x W x H) called out with tolerance — Page 1",
      "OD in notes matches OD in the diagram — Page 1 (cross-check against Page 4 panel dimensions and Page 5 \"SIZE\" field)",
      "Material thickness specified — Page 1",
      "Ply count / paper quality specified — Page 1 (repeated as \"PAPER QUALITY\" on Page 5)",
      "Box style specified (RSC-Flexo) — Page 1 (repeated on Page 5 \"STYLE\")",
      "Flute direction indicated — Page 5 only",
      "Printing direction indicated — Page 5 only",
      "\"Outside dimensions critical for container loading\" note present — Page 1",
      "\"3D model is representational only\" disclaimer present — Page 1",
    ],
    "Box Artwork: Dieline / Keyline / Tape Marks": [
      "Cut lines vs. crease lines clearly differentiated — Page 4 (also visible under-laid on Pages 3, 5)",
      "Panel widths/heights sum correctly to stated OD — Page 4",
      "Tape mark guide dimensions specified, marked \"Do Not Print\" — Page 4",
      "Barcode zone reserved, sized, positioned per spec — Pages 3, 4, 5",
      "\"Supplier Name\" placeholder present, marked \"Do Not Print\" — Pages 3, 4",
      "Keyline disclaimer present (in-house reference vs. supplier's official keyline) — Pages 3, 4",
    ],
    "Box Artwork: BCT/ECT & Performance Specs": [
      "Net weight specified — Pages 1, 2",
      "Estimated stacking (no. of boxes) specified — Pages 1, 2",
      "BCT value specified or marked N/A — Pages 1, 2",
      "ECT value specified or marked N/A — Pages 1, 2",
      "Note on when ECT/BCT values are due — Pages 1, 2",
      "Kraft paper sourcing note present — Pages 1, 2",
    ],
    "Box Artwork: Branding & Graphics Content": [
      "Logo correctly placed, correct version/lockup, consistent sizing — Pages 3, 4, 5",
      "Product imagery accurate to current product version — Pages 3, 4, 5",
      "Headline claims consistent across all language panels — Pages 3, 4, 5",
      "Numeric claims match approved values — Pages 3, 4, 5",
      "\"Made in [Country]\" mark correct — Pages 3, 4, 5",
      "Country/market-specific branding correct, not mixed up with another market's box — Pages 3, 4, 5",
    ],
    "Box Artwork: Multi-Language & Localization": [
      "All required languages present per market — Pages 3, 4, 5",
      "Translations reviewed by native speaker — Pages 3, 4, 5",
      "Language order/panel assignment consistent with convention — Pages 3, 4, 5",
      "Local contact details correct for target market — Pages 3, 4 (also in Page 5 company/contact block)",
      "Local-language taglines/warranty text on correct panel — Pages 3, 4, 5",
    ],
    "Box Artwork: Compliance, Certification & Legal Marks": [
      "Required certification marks present (KEBS, ISO, etc.) — Pages 3, 4, 5",
      "Certification mark artwork is current/approved version — Pages 3, 4, 5",
      "Barcode present, correctly formatted, matches assigned GTIN/UPC — Pages 3, 4, 5",
      "Warranty statement present, correct duration, all languages — Pages 3, 4, 5",
      "Copyright/reproduction restriction notice present — Pages 3, 4 (notes box)",
      "Manufacturer legal entity/address correct — Pages 1, 2 (title block) and Page 3 (company contact panel)",
      "Correct registration/SM number referenced — Pages 3, 4, 5 (printed on box graphic)",
    ],
    "Box Artwork: Cross-Check Against Previous Revision": [
      "Diff artwork against prior approved revision — Pages 3, 4 (compare graphics), Pages 1, 2 (compare notes/spec changes)",
      "Confirm nothing accidentally reverted/dropped — Pages 3, 4",
      "Confirm updated graphics didn't shift fixed elements (tape marks, barcode, cert marks) — Page 4 (dimensioned version makes this easiest to check)",
    ],
    "Box Artwork: Final Sign-Off": [
      "Proof reviewed against physical/handcut sample if available — Page 5",
      "\"Approved\" status stamp/label present — Page 3 (stamp shown), Page 5 (signature block)",
      "Sales rep / client approval section signed and dated — Page 5 only",
      "Design/production dates logged (completed, approved, approver name) — Page 5",
      "File sent to supplier matches exact approved revision — All pages (cross-check rev/version consistency)",
    ],
    "Post Launch Improvements": [
      "Post-launch performance review scheduled",
      "Customer feedback loop established",
      "Lessons learnt logged (see Risks & Issues tab)",
      "Cost-down / iteration roadmap defined",
    ],
  };

  // Render order for the cumulative sections. "Packaging & Product Launch"
  // isn't a GATE_ORDER stage, so it's threaded in right after "Launch" (see
  // checklistGateThreshold below) rather than appearing as its own gate.
  const CHECKLIST_SECTION_ORDER = [
    "Project Kickoff",
    "Scoping & Feasibility",
    "Preliminary Design",
    "Detailed Design",
    "Launch",
    "Packaging & Product Launch",
    "Post Launch Improvements",
  ];

  // The 9 Box Artwork Review categories are no longer siblings of Packaging
  // & Product Launch in the section list above -- each was its own
  // top-level fold, so a card at Launch/Post-Launch showed 9 extra header
  // rows before you'd opened a single one of them. They're now rendered as
  // nested sub-checklists INSIDE the Packaging & Product Launch section
  // itself (see packagingSubsectionsHtml() below) -- genuine tasks/subtasks
  // under one parent, same shape as the Weekly Activity WBS tree, and only
  // one header row shows on the card until you open it. The storage key for
  // each (still exactly these strings) is unchanged, so nothing already
  // checked off or removed under the old flat layout is lost.
  const BOX_ARTWORK_SUBSECTIONS = [
    "Box Artwork: Title Block & Documentation",
    "Box Artwork: Dimensions & Construction",
    "Box Artwork: Dieline / Keyline / Tape Marks",
    "Box Artwork: BCT/ECT & Performance Specs",
    "Box Artwork: Branding & Graphics Content",
    "Box Artwork: Multi-Language & Localization",
    "Box Artwork: Compliance, Certification & Legal Marks",
    "Box Artwork: Cross-Check Against Previous Revision",
    "Box Artwork: Final Sign-Off",
  ];

  function checklistGateThreshold(sectionKey) {
    if (sectionKey === "Packaging & Product Launch") return GATE_ORDER.indexOf("Launch");
    return GATE_ORDER.indexOf(sectionKey);
  }

  // Builds the 9 Box Artwork sub-checklists (each its own nested, always-
  // collapsed <details>) and rolls their combined checked/total counts up
  // for the caller to fold into Packaging & Product Launch's own count --
  // so that section's badge reads as "everything under it," not just its
  // own 5 items.
  function packagingSubsectionsHtml(p, autoCheckDefault) {
    let itemsHtml = "";
    let checked = 0;
    let total = 0;
    BOX_ARTWORK_SUBSECTIONS.forEach((subKey) => {
      // These 9 sub-checklists live inside "Packaging & Product Launch," so
      // they inherit that parent section's own auto-check default (based on
      // the Launch gate's position, not their own key -- they aren't in
      // GATE_ORDER) rather than computing one of their own.
      const sub = checklistSectionHtml(p, subKey, null, "checklist-subsection", false, null, autoCheckDefault);
      itemsHtml += sub.html;
      checked += sub.checked;
      total += sub.total;
    });
    return { html: `<div class="checklist-subsections">${itemsHtml}</div>`, checked, total };
  }

  function checklistStorageKey(projectId, gate, index) {
    return `pm-dashboard-checklist:${projectId}:${gate}:${index}`;
  }

  // Tri-state, not boolean: no saved value ("unset") reads back as
  // `defaultChecked` (see checklistCardHtml -- true for any gate strictly
  // before the project's current one, since it's reasonable to assume an
  // already-passed gate's standard exit criteria were met), an explicit "1"
  // or "0" always wins over that default. Untouched items used to just be
  // absent from storage and read back as unconditionally false; now the
  // default itself varies by gate, so "untouched" and "explicitly
  // unchecked" have to be distinguishable -- a PM who un-ticks something on
  // an already-complete earlier gate (because it genuinely wasn't done)
  // needs that to stick, not silently revert back to checked next render.
  function isChecklistItemChecked(projectId, gate, index, defaultChecked) {
    try {
      const raw = localStorage.getItem(checklistStorageKey(projectId, gate, index));
      if (raw === "1") return true;
      if (raw === "0") return false;
      return !!defaultChecked;
    } catch {
      return !!defaultChecked;
    }
  }

  function setChecklistItemChecked(projectId, gate, index, checked) {
    try {
      localStorage.setItem(checklistStorageKey(projectId, gate, index), checked ? "1" : "0");
    } catch {
      /* storage unavailable (private browsing, etc.) -- just won't persist across reloads */
    }
  }

  // ---- Per-project checklist customization: drop a standard item, add
  // your own to any section --------------------------------------------
  // "Make it dynamic, not fixed" -- a PM can hide a standard exit-criteria
  // item that doesn't apply to THIS project (e.g. no field/pilot test
  // needed for a cosmetic-only change) and add a project-specific
  // requirement directly into whichever gate section it actually belongs
  // to, not just one generic bucket. Both are per-project and local-
  // browser-only -- same storage model as the checked-state above, since
  // there's no ClickUp field to write any of this back to. This is a PM-
  // side customization only: it changes what THIS BROWSER shows for this
  // project, not the template every other project still starts from.
  function removedItemsStorageKey(projectId) {
    return `pm-dashboard-checklist-removed:${projectId}`;
  }

  function getRemovedStandardItems(projectId) {
    try {
      const raw = localStorage.getItem(removedItemsStorageKey(projectId));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function setRemovedStandardItems(projectId, keys) {
    try {
      localStorage.setItem(removedItemsStorageKey(projectId), JSON.stringify(keys));
    } catch {
      /* storage unavailable -- won't persist across reloads */
    }
  }

  function isStandardItemRemoved(projectId, sectionKey, index) {
    return getRemovedStandardItems(projectId).includes(`${sectionKey}::${index}`);
  }

  function removeStandardItem(projectId, sectionKey, index) {
    const key = `${sectionKey}::${index}`;
    const keys = getRemovedStandardItems(projectId);
    if (!keys.includes(key)) setRemovedStandardItems(projectId, [...keys, key]);
  }

  function restoreAllRemovedItems(projectId) {
    setRemovedStandardItems(projectId, []);
  }

  // Storage shape: { [sectionKey]: [{ id, text, checked }, ...] } -- keyed
  // by the same section key a standard item's checkbox uses, so an added
  // item files under the gate it was actually added to. "_followups" is
  // the generic bucket for anything not tied to a specific gate. An older
  // version stored this as one flat array (everything in an implicit
  // follow-ups bucket) -- migrated transparently on read.
  function customChecklistStorageKey(projectId) {
    return `pm-dashboard-checklist-custom:${projectId}`;
  }

  function getCustomChecklistData(projectId) {
    try {
      const raw = localStorage.getItem(customChecklistStorageKey(projectId));
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return { _followups: parsed };
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function setCustomChecklistData(projectId, data) {
    try {
      localStorage.setItem(customChecklistStorageKey(projectId), JSON.stringify(data));
    } catch {
      /* storage unavailable -- won't persist across reloads */
    }
  }

  function getCustomItemsForSection(projectId, sectionKey) {
    return getCustomChecklistData(projectId)[sectionKey] || [];
  }

  function addCustomChecklistItem(projectId, sectionKey, text, dueDate) {
    const data = getCustomChecklistData(projectId);
    const list = data[sectionKey] || [];
    list.push({ id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, checked: false, dueDate: dueDate || "" });
    data[sectionKey] = list;
    setCustomChecklistData(projectId, data);
  }

  // Used by the click-to-edit affordance on checklist items (see
  // wireChecklistItemEdit) -- updates text and/or dueDate in place without
  // touching checked state or id.
  function editCustomChecklistItem(projectId, sectionKey, itemId, changes) {
    const data = getCustomChecklistData(projectId);
    const list = data[sectionKey] || [];
    const item = list.find((it) => it.id === itemId);
    if (!item) return;
    if (changes.text !== undefined) item.text = changes.text;
    if (changes.dueDate !== undefined) item.dueDate = changes.dueDate;
    data[sectionKey] = list;
    setCustomChecklistData(projectId, data);
  }

  function toggleCustomChecklistItem(projectId, sectionKey, itemId, checked) {
    const data = getCustomChecklistData(projectId);
    const list = data[sectionKey] || [];
    const item = list.find((it) => it.id === itemId);
    if (item) item.checked = checked;
    data[sectionKey] = list;
    setCustomChecklistData(projectId, data);
  }

  function removeCustomChecklistItem(projectId, sectionKey, itemId) {
    const data = getCustomChecklistData(projectId);
    data[sectionKey] = (data[sectionKey] || []).filter((it) => it.id !== itemId);
    setCustomChecklistData(projectId, data);
  }

  // Renders one section: whichever standard template items still apply
  // (minus any this project has dropped), plus this project's own added
  // items filed under the same section, plus a small "add an item here"
  // input. Every item -- standard or custom -- gets a remove control now,
  // since the whole point is that this is editable per project, not fixed.
  function checklistSectionHtml(p, sectionKey, titleOverride, extraClass, defaultOpen, nested, autoCheckDefault) {
    const isFollowups = sectionKey === "_followups";
    const standardItems = (STAGE_GATE_CHECKLISTS[sectionKey] || [])
      .map((text, i) => ({ text, index: i }))
      .filter(({ index }) => !isStandardItemRemoved(p.id, sectionKey, index));
    const customItems = getCustomItemsForSection(p.id, sectionKey);

    // `nested` (only ever set for "Packaging & Product Launch", see
    // packagingSubsectionsHtml) folds a set of child sub-checklists' counts
    // into this section's own badge/total, and their markup gets rendered
    // inside this section's <details>, after this section's own items.
    const nestedHtml = nested ? nested.html : "";
    const checked =
      standardItems.filter(({ index }) => isChecklistItemChecked(p.id, sectionKey, index, autoCheckDefault)).length +
      customItems.filter((it) => it.checked).length +
      (nested ? nested.checked : 0);
    const total = standardItems.length + customItems.length + (nested ? nested.total : 0);

    const standardHtml = standardItems
      .map(({ text, index }) => {
        const isChecked = isChecklistItemChecked(p.id, sectionKey, index, autoCheckDefault);
        return `
            <li class="checklist-item${isChecked ? " checklist-item-done" : ""}">
              <label>
                <input type="checkbox" data-project="${escapeHtml(p.id)}" data-gate="${escapeHtml(sectionKey)}" data-index="${index}" ${isChecked ? "checked" : ""} />
                <span>${escapeHtml(text)}</span>
              </label>
              <button type="button" class="checklist-remove-btn" data-project="${escapeHtml(p.id)}" data-remove-standard-section="${escapeHtml(sectionKey)}" data-remove-standard-index="${index}" title="Not applicable to this project" aria-label="Remove this item for this project">&times;</button>
            </li>`;
      })
      .join("");

    const customHtml = customItems
      .map((it) => {
        const urgency = it.dueDate ? dateUrgencyInfo(it.dueDate) : null;
        return `
            <li class="checklist-item${it.checked ? " checklist-item-done" : ""}">
              <label>
                <input type="checkbox" data-project="${escapeHtml(p.id)}" data-section="${escapeHtml(sectionKey)}" data-custom-id="${escapeHtml(it.id)}" ${it.checked ? "checked" : ""} />
                <span class="checklist-item-text" data-project="${escapeHtml(p.id)}" data-section="${escapeHtml(sectionKey)}" data-custom-id="${escapeHtml(it.id)}" data-editable-text title="Click to edit">${escapeHtml(it.text)}</span>
              </label>
              ${urgency ? `<span class="reason-chip ${urgency.cls}">${escapeHtml(urgency.label)}</span>` : ""}
              <button type="button" class="checklist-remove-btn" data-project="${escapeHtml(p.id)}" data-remove-custom-section="${escapeHtml(sectionKey)}" data-remove-custom-id="${escapeHtml(it.id)}" title="Remove this item" aria-label="Remove this item">&times;</button>
            </li>`;
      })
      .join("");

    const emptyMessage = isFollowups ? "No follow-up items added yet." : "No items in this section for this project.";
    const noneHtml = total === 0 ? `<li class="checklist-item checklist-item-none">${emptyMessage}</li>` : "";

    // A <details>/<summary> pair, not a custom div+button toggle -- native
    // fold state, keyboard-accessible for free, and its open/closed state
    // survives the innerHTML rebuild on the next render only insofar as
    // defaultOpen recomputes it the same way each time (see checklistCardHtml).
    return {
      html: `
        <details class="checklist-section${extraClass ? ` ${extraClass}` : ""}"${defaultOpen ? " open" : ""}>
          <summary class="checklist-section-title">${escapeHtml(titleOverride || sectionKey)} <span class="checklist-section-count">${checked}/${total}</span></summary>
          <ul class="checklist-items">${standardHtml}${customHtml}${noneHtml}</ul>
          <form class="checklist-add-form" data-project="${escapeHtml(p.id)}" data-section="${escapeHtml(sectionKey)}">
            <input type="text" class="checklist-add-input" placeholder="Add an item to this section and press Enter…" maxlength="200" />
            <input type="date" class="checklist-add-date" aria-label="Optional due date" />
          </form>
          ${nestedHtml}
        </details>`,
      checked,
      total,
    };
  }

  // Red-to-green "heat map" meter, literally hue 0 (red) at 0% complete
  // sweeping through amber/yellow up to hue 120 (green) at 100% -- a
  // continuous encoding of the exact fraction already shown as text
  // ("N / M complete") right next to it, not a stand-alone color-only
  // signal.
  function checklistHeatColor(pct) {
    const hue = Math.round(Math.max(0, Math.min(1, pct)) * 120);
    return `hsl(${hue}, 62%, 42%)`;
  }

  function checklistCardHtml(p) {
    const gate = p.currentGate || p.gatePhase;
    const gateIndex = GATE_ORDER.indexOf(gate);
    // Scoping the VIEWING selector to exactly this one project is read as
    // "I want everything about this project" -- so every section opens up
    // instead of making you click through each one. Otherwise, only the
    // section matching the project's actual current gate opens by default
    // (earlier, already-passed gates and the follow-ups bucket start
    // collapsed) -- cuts a full grid of cards down to the one thing most
    // relevant to each, without hiding the history entirely.
    const isScopedToThisProject = viewingProjectId === p.id;

    let sectionsHtml = "";
    let totalItems = 0;
    let totalChecked = 0;

    if (gateIndex === -1) {
      const message = gate
        ? `No standard checklist defined for "${escapeHtml(gate)}" yet.`
        : `This project has no stage gate set yet — see Decisions &amp; Gaps.`;
      sectionsHtml += `<div class="checklist-section"><ul class="checklist-items"><li class="checklist-item checklist-item-none">${message}</li></ul></div>`;
    } else {
      CHECKLIST_SECTION_ORDER
        .filter((key) => {
          const threshold = checklistGateThreshold(key);
          return threshold !== -1 && threshold <= gateIndex;
        })
        .forEach((key) => {
          const threshold = checklistGateThreshold(key);
          const defaultOpen = isScopedToThisProject || threshold === gateIndex;
          // A gate strictly before the project's current one is assumed
          // already met -- its standard items default to checked, so the
          // card only asks for attention on the gate the project is
          // actually at. Any item a PM has explicitly toggled (checked OR
          // un-checked) always overrides this default -- see
          // isChecklistItemChecked's tri-state storage.
          const autoCheckDefault = threshold < gateIndex;
          // Packaging & Product Launch carries the 9 Box Artwork Review
          // categories nested inside it as nested sub-checklists (each its
          // own always-collapsed <details>, 57 items total) -- genuine
          // tasks/subtasks under one parent instead of 9 extra sibling
          // header rows on the card, and their combined count folds into
          // this section's own badge.
          const nested = key === "Packaging & Product Launch" ? packagingSubsectionsHtml(p, autoCheckDefault) : null;
          const section = checklistSectionHtml(p, key, null, null, defaultOpen, nested, autoCheckDefault);
          sectionsHtml += section.html;
          totalItems += section.total;
          totalChecked += section.checked;
        });
    }

    const followups = checklistSectionHtml(p, "_followups", "Follow-ups & add-ons", "checklist-section-custom", isScopedToThisProject);
    sectionsHtml += followups.html;
    totalItems += followups.total;
    totalChecked += followups.checked;

    const removedCount = getRemovedStandardItems(p.id).length;
    const pct = totalItems > 0 ? totalChecked / totalItems : 0;
    const heatColor = totalItems > 0 ? checklistHeatColor(pct) : null;
    const urgency = p.targetGateDate ? dateUrgencyInfo(p.targetGateDate) : null;

    return `
      <div class="checklist-card"${heatColor ? ` style="border-left-color:${heatColor};"` : ""}>
        <div class="checklist-card-header">
          <a class="checklist-card-title" href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>
          <span class="checklist-gate-pill">${escapeHtml(gate || "No gate set")}</span>
        </div>
        ${urgency ? `<div class="checklist-milestone">Target: ${fmtDate(p.targetGateDate)} <span class="reason-chip ${urgency.cls}">${escapeHtml(urgency.label)}</span></div>` : ""}
        ${totalItems > 0 ? `
        <div class="checklist-progress-row">
          <div class="checklist-progress">${totalChecked} / ${totalItems} complete</div>
          <div class="checklist-heat-track"><div class="checklist-heat-fill" style="width:${(pct * 100).toFixed(0)}%;background:${heatColor};"></div></div>
          <button type="button" class="checklist-fold-toggle" data-project="${escapeHtml(p.id)}" data-fold-action="expand">Expand all</button>
          <button type="button" class="checklist-fold-toggle" data-project="${escapeHtml(p.id)}" data-fold-action="collapse">Collapse all</button>
        </div>` : ""}
        ${sectionsHtml}
        ${removedCount > 0 ? `<button type="button" class="checklist-reset-removed" data-project="${escapeHtml(p.id)}">Restore ${removedCount} hidden item${removedCount === 1 ? "" : "s"}</button>` : ""}
      </div>`;
  }

  function renderChecklists() {
    const grid = document.getElementById("checklist-grid");
    const empty = document.getElementById("checklists-empty");
    if (!grid) return;
    const rows = getContextProjects().filter((p) => p.healthBucket !== "completed");
    if (rows.length === 0) {
      grid.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    grid.innerHTML = rows.map(checklistCardHtml).join("");
  }

  // Reused by the Weekly standup export (see buildStandupSummaryData /
  // renderStandupSummaryHtml below) to summarize a project's Deep Dive
  // Priority tab in one line: the first unresolved open question if there is
  // one (the live "what to choose" decision), else the priority score/notes,
  // else nothing.
  function priorityColumnText(data) {
    const unresolved = ((data.priority && data.priority.questions) || []).filter((q) => !q.resolved);
    const scoreLabel = data.priority && data.priority.score ? `Priority ${data.priority.score}/5` : "";
    if (unresolved.length > 0) {
      return `${scoreLabel ? scoreLabel + " — " : ""}Needs a call: ${unresolved[0].text}`;
    }
    if (scoreLabel) return `${scoreLabel}${data.priority.notes ? " — " + data.priority.notes : ""}`;
    return "";
  }

  // ---- Tooling: projects with a live tooling requirement ------------------
  // Scans every non-completed project's own ClickUp "Tooling" field (Yes/No)
  // -- there's no separate "needs tooling" list in ClickUp, so this tab is
  // built by filtering the same portfolio data every other tab reads, not a
  // second data source. Priority is local-only (no ClickUp field for it
  // either): a simple High/Medium/Low tag a PM sets here to sequence
  // tooling spend across projects, persisted the same way checklist state is.
  const TOOLING_PRIORITY_ORDER = { high: 0, medium: 1, low: 2, "": 3 };

  function hasToolingRequirement(p) {
    const v = (p.tooling || "").toString().trim().toLowerCase();
    return v !== "" && v !== "no" && v !== "n/a" && v !== "none";
  }

  function toolingPriorityStorageKey(projectId) {
    return `pm-dashboard-tooling-priority:${projectId}`;
  }

  function getToolingPriority(projectId) {
    try {
      return localStorage.getItem(toolingPriorityStorageKey(projectId)) || "";
    } catch {
      return "";
    }
  }

  function setToolingPriority(projectId, value) {
    try {
      if (value) localStorage.setItem(toolingPriorityStorageKey(projectId), value);
      else localStorage.removeItem(toolingPriorityStorageKey(projectId));
    } catch {
      /* storage unavailable -- won't persist across reloads */
    }
  }

  function ownersLabel(p) {
    return p.assignees && p.assignees.length ? p.assignees.map((a) => a.name).join(", ") : "Unassigned";
  }

  // ---- Tooling & Lab tables: Excel-like manual column resize ---------------
  // Real ClickUp owner lists run much longer than the mock data used while
  // building the reskin, and with no column-width control the browser's
  // default table layout just kept stretching the whole row to fit one long
  // name cell on a single line. Pairing table-layout:fixed (see the
  // <colgroup> in index.html + base cell rules in style.css) with a small
  // drag handle on each header lets a name wrap inside its column instead,
  // and lets the PM widen a column by hand when they want to -- persisted
  // per-browser like every other layout preference on this dashboard.
  const RESIZABLE_TABLES = {
    "tooling-table": "pm-dashboard-colwidths:tooling",
    "lab-table": "pm-dashboard-colwidths:lab",
  };
  const MIN_COL_WIDTH = 50;

  function getStoredColWidths(key) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function setStoredColWidths(key, widths) {
    try {
      localStorage.setItem(key, JSON.stringify(widths));
    } catch {
      /* storage unavailable -- resize just won't persist across reloads */
    }
  }

  function initResizableTable(tableId, storageKey) {
    const table = document.getElementById(tableId);
    if (!table || table.dataset.resizeInit) return;
    const cols = [...table.querySelectorAll(":scope > colgroup > col")];
    const ths = [...table.querySelectorAll(":scope > thead > tr > th")];
    if (!cols.length || cols.length !== ths.length) return;
    table.dataset.resizeInit = "true";

    const stored = getStoredColWidths(storageKey);
    if (stored && stored.length === cols.length) {
      cols.forEach((col, i) => {
        if (stored[i]) col.style.width = `${stored[i]}px`;
      });
    }

    function persistWidths() {
      setStoredColWidths(
        storageKey,
        cols.map((c) => Math.round(c.getBoundingClientRect().width || parseFloat(c.style.width) || 0))
      );
    }

    ths.forEach((th, i) => {
      // The drag-handle-col (row-reorder grip) and the very last column
      // don't get a resize handle -- nothing meaningful to drag them
      // against, and the last column just fills whatever space is left.
      if (i === ths.length - 1 || th.classList.contains("drag-handle-col")) return;
      th.classList.add("resizable-th");
      const handle = document.createElement("span");
      handle.className = "col-resize-handle";
      handle.setAttribute("aria-hidden", "true");
      th.appendChild(handle);

      let startX = 0;
      let startWidth = 0;

      function onPointerMove(e) {
        const next = Math.max(MIN_COL_WIDTH, startWidth + (e.clientX - startX));
        cols[i].style.width = `${next}px`;
      }
      function onPointerUp(e) {
        handle.classList.remove("resizing");
        try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        handle.removeEventListener("pointermove", onPointerMove);
        handle.removeEventListener("pointerup", onPointerUp);
        persistWidths();
      }
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startWidth = cols[i].getBoundingClientRect().width;
        handle.classList.add("resizing");
        handle.setPointerCapture(e.pointerId);
        handle.addEventListener("pointermove", onPointerMove);
        handle.addEventListener("pointerup", onPointerUp);
      });
      // Double-click a handle to reset that one column back to its default
      // width (clears just that column's stored override).
      handle.addEventListener("dblclick", () => {
        cols[i].style.width = "";
        const stored2 = getStoredColWidths(storageKey) || [];
        stored2[i] = null;
        setStoredColWidths(storageKey, stored2);
      });
    });
  }

  function initAllResizableTables() {
    Object.entries(RESIZABLE_TABLES).forEach(([tableId, key]) => initResizableTable(tableId, key));
  }

  // Manual drag-and-drop order for the Tooling table -- a single global
  // (not per-project) localStorage list of project IDs in the PM's chosen
  // order. Rows without a saved position fall back to the existing
  // priority-then-date sort, so a new tooling need slots in sensibly instead
  // of jumping to the top or bottom until it's dragged somewhere on purpose.
  function toolingOrderStorageKey() {
    return "pm-dashboard-tooling-order";
  }

  function getToolingOrder() {
    try {
      const raw = localStorage.getItem(toolingOrderStorageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function setToolingOrder(order) {
    try {
      localStorage.setItem(toolingOrderStorageKey(), JSON.stringify(order));
    } catch {
      /* storage unavailable -- won't persist across reloads */
    }
  }

  // Merges the priority/date sort with any manual order the PM has dragged
  // into place. Rows already positioned keep their saved relative order
  // (Array#sort is stable, and rows arrive already priority/date-sorted, so
  // ties -- i.e. rows with no saved position -- keep that order as a
  // fallback). The merged order is re-persisted on every render so it stays
  // correct as projects drop off the list or new ones appear on it.
  function effectiveToolingOrder(rows) {
    const savedIndex = new Map(getToolingOrder().map((id, i) => [id, i]));
    const ordered = rows.slice().sort((a, b) => {
      const ia = savedIndex.has(a.id) ? savedIndex.get(a.id) : Infinity;
      const ib = savedIndex.has(b.id) ? savedIndex.get(b.id) : Infinity;
      return ia - ib;
    });
    setToolingOrder(ordered.map((p) => p.id));
    return ordered;
  }

  const TOOLING_TABLE_COLSPAN = 8;

  function toolingRowHtml(p) {
    const priority = getToolingPriority(p.id);
    return `
      <tr data-project="${escapeHtml(p.id)}" draggable="true">
        <td class="drag-handle-cell"><span class="drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span></td>
        <td><a class="project-link" href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a></td>
        <td><span class="health-pill"><span class="status-dot ${p.healthBucket}"></span>${escapeHtml(HEALTH_LABEL[p.healthBucket] || p.healthBucket)}</span></td>
        <td>${escapeHtml(p.currentGate || p.gatePhase || "—")}</td>
        <td>${escapeHtml(ownersLabel(p))}</td>
        <td>${fmtDate(p.targetGateDate)}</td>
        <td>
          <select class="tooling-priority-select" data-project="${escapeHtml(p.id)}">
            <option value=""${priority === "" ? " selected" : ""}>Not set</option>
            <option value="high"${priority === "high" ? " selected" : ""}>High</option>
            <option value="medium"${priority === "medium" ? " selected" : ""}>Medium</option>
            <option value="low"${priority === "low" ? " selected" : ""}>Low</option>
          </select>
        </td>
        <td>${tasksToggleButtonHtml(p)}</td>
      </tr>${projectTasksRowHtml(p.id, TOOLING_TABLE_COLSPAN)}`;
  }

  function renderTooling() {
    const tbody = document.getElementById("tooling-tbody");
    const empty = document.getElementById("tooling-empty");
    const badge = document.getElementById("tab-count-tooling");
    if (!tbody) return;
    const rows = effectiveToolingOrder(
      getContextProjects()
        .filter((p) => p.healthBucket !== "completed" && hasToolingRequirement(p))
        .sort((a, b) => {
          const pa = TOOLING_PRIORITY_ORDER[getToolingPriority(a.id)] ?? 3;
          const pb = TOOLING_PRIORITY_ORDER[getToolingPriority(b.id)] ?? 3;
          if (pa !== pb) return pa - pb;
          const da = a.targetGateDate ? Date.parse(a.targetGateDate) : Infinity;
          const db = b.targetGateDate ? Date.parse(b.targetGateDate) : Infinity;
          return da - db;
        })
    );
    if (badge) badge.textContent = String(rows.length);
    if (rows.length === 0) {
      tbody.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    tbody.innerHTML = rows.map(toolingRowHtml).join("");
  }

  // ---- Lab: projects whose current stage gate implies live lab work -------
  // No ClickUp field marks a task as "lab work" -- instead this infers it
  // from where a project currently sits in the stage-gate sequence, since
  // these three gates are exactly the phases that involve bench/lab testing
  // before a project can move on (the same heuristic used nowhere else on
  // this dashboard, since every other tab has a real field to read). "Closes
  // by" is the project's own next-gate target date (the same Roadmap field
  // the Gantt tab reads) -- lab work has to wrap before that date, not a
  // separate date of its own -- and the countdown is computed fresh from
  // "now" every render, so it counts down week on week without any extra
  // state to maintain.
  const LAB_GATES = new Set(["Scoping & Feasibility", "Preliminary Design", "Detailed Design"]);

  function isLabGateProject(p) {
    return LAB_GATES.has(p.currentGate || p.gatePhase);
  }

  // Shared countdown-chip logic -- used by Lab, Checklists' milestone line,
  // and the per-project Tooling/Lab task due dates, so "3d left" / "2d
  // overdue" always means the same thing and is styled the same way
  // wherever it shows up.
  function dateUrgencyInfo(dateIso) {
    if (!dateIso) return { label: "No date set", cls: "" };
    const days = Math.ceil((Date.parse(dateIso) - Date.now()) / 86400000);
    if (days < 0) return { label: `${Math.abs(days)}d overdue`, cls: "reason-chip-warn" };
    if (days === 0) return { label: "Due today", cls: "reason-chip-warn" };
    if (days <= 7) return { label: `${days}d left`, cls: "reason-chip-warn" };
    const weeks = Math.round(days / 7);
    return { label: `${weeks} week${weeks === 1 ? "" : "s"} left`, cls: "" };
  }

  // ---- Per-project manual task list (Tooling & Lab tabs) -------------------
  // Neither tab has a real ClickUp list backing it -- Tooling is filtered off
  // a single Yes/No field, Lab is inferred from stage gate -- so there's
  // nowhere to hang the individual tooling/lab tasks a project can actually
  // have (e.g. several outstanding tooling tasks on one project, like Sahel
  // Stove). This gives each project a small, freeform, add/check/remove task
  // list with an optional due date per task, stored locally like every other
  // PM-only annotation on this dashboard (checklist custom items, tooling
  // priority) -- not synced to ClickUp.
  function projectTasksStorageKey(projectId) {
    return `pm-dashboard-tasks:${projectId}`;
  }

  function getProjectTasks(projectId) {
    try {
      const raw = localStorage.getItem(projectTasksStorageKey(projectId));
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function setProjectTasks(projectId, tasks) {
    try {
      localStorage.setItem(projectTasksStorageKey(projectId), JSON.stringify(tasks));
    } catch {
      /* storage unavailable -- won't persist across reloads */
    }
  }

  // `category` ("tooling" | "lab") records which tab a task was added from,
  // since a single project can appear in both the Tooling and Lab tables at
  // once and its task list is one shared store per project (see above) --
  // without a tag on the task itself there'd be no way to tell "Other open
  // items this week" apart into separate Tooling and Lab groups. Tasks
  // created before this field existed have no category; callers treat a
  // missing category as "tooling" (see collectLocalWeeklyItems) since that
  // was the more common case in practice -- there's no way to recover which
  // tab they actually came from after the fact.
  function addProjectTask(projectId, text, dueDate, category) {
    const tasks = getProjectTasks(projectId);
    tasks.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, done: false, dueDate: dueDate || "", category: category || "tooling" });
    setProjectTasks(projectId, tasks);
  }

  function toggleProjectTask(projectId, taskId, done) {
    const tasks = getProjectTasks(projectId);
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.done = done;
      setProjectTasks(projectId, tasks);
    }
  }

  function removeProjectTask(projectId, taskId) {
    setProjectTasks(projectId, getProjectTasks(projectId).filter((t) => t.id !== taskId));
  }

  function editProjectTask(projectId, taskId, text) {
    const tasks = getProjectTasks(projectId);
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.text = text;
      setProjectTasks(projectId, tasks);
    }
  }

  // A task's date is never optional after creation either -- the add form
  // requires one up front (see wireProjectTasksPanel's submit handler), and
  // editing it the same way (see beginInlineDateEdit) refuses to save an
  // empty value rather than clearing the date back out.
  function editProjectTaskDate(projectId, taskId, dueDate) {
    if (!dueDate) return;
    const tasks = getProjectTasks(projectId);
    const task = tasks.find((t) => t.id === taskId);
    if (task) {
      task.dueDate = dueDate;
      setProjectTasks(projectId, tasks);
    }
  }

  function projectTasksSummary(projectId) {
    const tasks = getProjectTasks(projectId);
    return { total: tasks.length, open: tasks.filter((t) => !t.done).length };
  }

  function tasksToggleButtonHtml(p) {
    const { total, open } = projectTasksSummary(p.id);
    const label = total ? `Tasks (${open}/${total})` : "Tasks";
    return `<button type="button" class="tasks-toggle-btn" data-tasks-toggle data-project="${escapeHtml(p.id)}" aria-expanded="false">${escapeHtml(label)}</button>`;
  }

  function projectTaskItemHtml(projectId, task) {
    const urgency = dateUrgencyInfo(task.dueDate);
    return `
      <li class="checklist-item${task.done ? " checklist-item-done" : ""}">
        <label>
          <input type="checkbox" data-task-toggle data-project="${escapeHtml(projectId)}" data-task-id="${escapeHtml(task.id)}"${task.done ? " checked" : ""} />
          <span class="checklist-item-text" data-project="${escapeHtml(projectId)}" data-task-id="${escapeHtml(task.id)}" data-editable-text title="Click to edit">${escapeHtml(task.text)}</span>
        </label>
        <button type="button" class="reason-chip task-date-chip ${urgency.cls}" data-task-date-edit data-project="${escapeHtml(projectId)}" data-task-id="${escapeHtml(task.id)}" data-date="${escapeHtml(task.dueDate || "")}" title="Click to change the date">${escapeHtml(urgency.label)}</button>
        <button type="button" class="checklist-remove-btn" data-task-remove data-project="${escapeHtml(projectId)}" data-task-id="${escapeHtml(task.id)}" title="Remove task" aria-label="Remove task">&times;</button>
      </li>`;
  }

  // ---- Shared click-to-edit for task/checklist item text -------------------
  // One delegated helper used by both the Tooling/Lab task list and the
  // Checklist custom items below -- clicking an item's text swaps it for an
  // inline input; Enter or blur commits via `onSave(newText)`, Escape
  // cancels without saving. `onSave` is responsible for persisting and
  // re-rendering.
  function beginInlineTextEdit(span, onSave) {
    if (!span || span.dataset.editing) return;
    const original = span.textContent;
    span.dataset.editing = "true";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-edit-input";
    input.value = original;
    input.maxLength = 200;
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    function commit(save) {
      if (done) return;
      done = true;
      const newText = input.value.trim();
      if (save && newText && newText !== original) {
        onSave(newText);
      } else {
        span.dataset.editing = "";
        input.replaceWith(span);
      }
    }
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
  }

  // Same click-to-edit interaction as beginInlineTextEdit, but for a task's
  // date chip: the input is a native date picker instead of a text field,
  // and -- since a Tooling/Lab task must always have a date -- clearing it
  // and leaving it blank cancels the edit and reverts to the previous chip,
  // rather than saving an empty date the way an emptied text field would
  // just be rejected further up.
  function beginInlineDateEdit(chipEl, currentValue, onSave) {
    if (!chipEl || chipEl.dataset.editing) return;
    chipEl.dataset.editing = "true";
    const input = document.createElement("input");
    input.type = "date";
    input.className = "inline-edit-date-input";
    if (currentValue) input.value = currentValue;
    chipEl.replaceWith(input);
    input.focus();
    let done = false;
    function commit(save) {
      if (done) return;
      done = true;
      if (save && input.value) {
        onSave(input.value);
      } else {
        chipEl.dataset.editing = "";
        input.replaceWith(chipEl);
      }
    }
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("change", () => commit(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
  }

  function projectTasksRowHtml(projectId, colspan) {
    const tasks = getProjectTasks(projectId);
    const itemsHtml = tasks.length
      ? tasks.map((t) => projectTaskItemHtml(projectId, t)).join("")
      : `<li class="checklist-item-none">No tasks yet — add one below.</li>`;
    return `
      <tr class="project-tasks-row" data-project="${escapeHtml(projectId)}" hidden>
        <td colspan="${colspan}">
          <div class="project-tasks-panel">
            <ul class="checklist-items">${itemsHtml}</ul>
            <form class="project-task-add-form" data-project="${escapeHtml(projectId)}">
              <input type="text" class="checklist-add-input project-task-add-input" placeholder="Add a task…" maxlength="200" />
              <input type="date" class="project-task-add-date" aria-label="Due date" required title="A due date is required" />
              <button type="submit" class="project-task-add-btn">Add</button>
              <span class="project-task-add-status" aria-live="polite"></span>
            </form>
          </div>
        </td>
      </tr>`;
  }

  // Refreshes one project's task panel in place (item list + toggle badge)
  // without touching any other row or re-rendering the table -- keeps the
  // panel's open/closed state and the rest of the table's scroll position
  // untouched after adding/checking/removing a task.
  function refreshProjectTasksUI(tbody, projectId) {
    const row = tbody.querySelector(`tr.project-tasks-row[data-project="${CSS.escape(projectId)}"]`);
    if (row) {
      const list = row.querySelector(".checklist-items");
      const tasks = getProjectTasks(projectId);
      if (list) {
        list.innerHTML = tasks.length
          ? tasks.map((t) => projectTaskItemHtml(projectId, t)).join("")
          : `<li class="checklist-item-none">No tasks yet — add one below.</li>`;
      }
      const form = row.querySelector(".project-task-add-form");
      if (form) form.reset();
    }
    const toggleBtn = tbody.querySelector(`.tasks-toggle-btn[data-project="${CSS.escape(projectId)}"]`);
    if (toggleBtn) {
      const { total, open } = projectTasksSummary(projectId);
      toggleBtn.textContent = total ? `Tasks (${open}/${total})` : "Tasks";
    }
  }

  // Shared click/change/submit wiring for the Tooling and Lab tables' task
  // panels -- identical behavior in both, so one listener setup covers both
  // tbody elements rather than duplicating it. `category` ("tooling" |
  // "lab") tags every task added through this panel so "Other open items
  // this week" can later split them back apart -- see addProjectTask.
  function wireProjectTasksPanel(tbody, category) {
    if (!tbody) return;
    tbody.addEventListener("click", (e) => {
      const toggleBtn = e.target.closest(".tasks-toggle-btn[data-tasks-toggle]");
      if (toggleBtn) {
        const row = tbody.querySelector(`tr.project-tasks-row[data-project="${CSS.escape(toggleBtn.dataset.project)}"]`);
        if (row) {
          row.hidden = !row.hidden;
          toggleBtn.setAttribute("aria-expanded", String(!row.hidden));
        }
        return;
      }
      const removeBtn = e.target.closest("[data-task-remove]");
      if (removeBtn) {
        removeProjectTask(removeBtn.dataset.project, removeBtn.dataset.taskId);
        refreshProjectTasksUI(tbody, removeBtn.dataset.project);
        return;
      }
      const dateChip = e.target.closest("[data-task-date-edit]");
      if (dateChip) {
        const { project, taskId, date } = dateChip.dataset;
        beginInlineDateEdit(dateChip, date, (newDate) => {
          editProjectTaskDate(project, taskId, newDate);
          refreshProjectTasksUI(tbody, project);
        });
        return;
      }
      const editSpan = e.target.closest("[data-editable-text][data-task-id]");
      if (editSpan) {
        // Prevent the surrounding <label>'s native click-forwarding from
        // also toggling the checkbox -- otherwise clicking the text to edit
        // it would flip the task's done state at the same time.
        e.preventDefault();
        const { project, taskId } = editSpan.dataset;
        beginInlineTextEdit(editSpan, (newText) => {
          editProjectTask(project, taskId, newText);
          refreshProjectTasksUI(tbody, project);
        });
      }
    });
    tbody.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-task-toggle]");
      if (!cb) return;
      toggleProjectTask(cb.dataset.project, cb.dataset.taskId, cb.checked);
      const li = cb.closest(".checklist-item");
      if (li) li.classList.toggle("checklist-item-done", cb.checked);
      refreshProjectTasksUI(tbody, cb.dataset.project);
    });
    tbody.addEventListener("submit", (e) => {
      const form = e.target.closest(".project-task-add-form");
      if (!form) return;
      e.preventDefault();
      const input = form.querySelector(".project-task-add-input");
      const dateInput = form.querySelector(".project-task-add-date");
      const statusEl = form.querySelector(".project-task-add-status");
      const text = (input?.value || "").trim();
      if (!text) return;
      // A task is never saved without a date -- the input already carries
      // `required`, but that only blocks a native form submit when the
      // button itself triggers validation; belt-and-braces here too so a
      // programmatic submit can't slip an undated task through either.
      if (!dateInput || !dateInput.value) {
        if (dateInput) dateInput.reportValidity();
        if (statusEl) statusEl.textContent = "Add a due date to save this task.";
        return;
      }
      if (statusEl) statusEl.textContent = "";
      addProjectTask(form.dataset.project, text, dateInput.value, category);
      const row = form.closest("tr.project-tasks-row");
      if (row) row.hidden = false;
      refreshProjectTasksUI(tbody, form.dataset.project);
    });
  }

  const LAB_TABLE_COLSPAN = 7;

  function labRowHtml(p) {
    const urgency = p.targetGateDate ? dateUrgencyInfo(p.targetGateDate) : { label: "No target date set", cls: "" };
    return `
      <tr>
        <td><a class="project-link" href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a></td>
        <td><span class="health-pill"><span class="status-dot ${p.healthBucket}"></span>${escapeHtml(HEALTH_LABEL[p.healthBucket] || p.healthBucket)}</span></td>
        <td>${escapeHtml(p.currentGate || p.gatePhase || "—")}</td>
        <td>${escapeHtml(ownersLabel(p))}</td>
        <td>${fmtDate(p.targetGateDate)}</td>
        <td><span class="reason-chip ${urgency.cls}">${escapeHtml(urgency.label)}</span></td>
        <td>${tasksToggleButtonHtml(p)}</td>
      </tr>${projectTasksRowHtml(p.id, LAB_TABLE_COLSPAN)}`;
  }

  function renderLab() {
    const tbody = document.getElementById("lab-tbody");
    const empty = document.getElementById("lab-empty");
    const badge = document.getElementById("tab-count-lab");
    if (!tbody) return;
    const rows = getContextProjects()
      .filter((p) => p.healthBucket !== "completed" && isLabGateProject(p))
      .sort((a, b) => {
        const da = a.targetGateDate ? Date.parse(a.targetGateDate) : Infinity;
        const db = b.targetGateDate ? Date.parse(b.targetGateDate) : Infinity;
        return da - db;
      });
    if (badge) badge.textContent = String(rows.length);
    if (rows.length === 0) {
      tbody.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    tbody.innerHTML = rows.map(labRowHtml).join("");
  }

  // stageBarHtml is also used by the single-project detail view (see
  // projectDetailHtml below).
  function stageBarHtml(stages, currentStage, confirmed) {
    return `<div class="stage-bar">${stages
      .map((s) => {
        const isCurrent = s === currentStage;
        const cls = isCurrent ? `current ${confirmed ? "confirmed" : "unconfirmed"}` : "";
        return `<div class="stage-step ${cls}">${escapeHtml(s)}</div>`;
      })
      .join("")}</div>`;
  }

  // ---- Gantt ---------------------------------------------------------------
  // A hand-rolled timeline: one horizontal bar per project, start-to-due,
  // against a shared date axis. Quarters get alternating shading (the
  // business plans in quarters, so that's the natural way to scan this),
  // and a vertical line marks today. Respects the VIEWING + DUE WITHIN
  // context bar, same as Timeline/Calendar/the grouped boards.
  const GANTT_PX_PER_DAY = 5.5;
  const GANTT_MIN_BAR_PX = 14;
  const GANTT_LABEL_WIDTH = 220;
  const DAY_MS = 86400000;

  function quarterOf(date) {
    return Math.floor(date.getMonth() / 3);
  }
  function quarterStart(date) {
    return new Date(date.getFullYear(), quarterOf(date) * 3, 1);
  }
  function quarterEndExclusive(date) {
    return new Date(date.getFullYear(), quarterOf(date) * 3 + 3, 1);
  }
  function monthStart(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }
  function monthEndExclusive(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 1);
  }

  // Every project with a due date gets a bar. Its "start" prefers ClickUp's
  // real Start Date field; when that's not set, falls back to the task's
  // creation date (always present) rather than excluding the project --
  // rendered dashed/"assumed" so it's clear which is which, same convention
  // as the Resources tab's hours chart.
  function ganttBarsData(rows) {
    return rows
      .filter((p) => p.targetGateDate)
      .map((p) => {
        const endMs = Date.parse(p.targetGateDate);
        const realStartMs = p.startDate ? Date.parse(p.startDate) : NaN;
        let startMs = Number.isFinite(realStartMs) ? realStartMs : Date.parse(p.createdDate || p.targetGateDate);
        const assumed = !Number.isFinite(realStartMs);
        if (!Number.isFinite(startMs) || startMs > endMs) startMs = endMs;
        return { p, startMs, endMs, assumed };
      })
      .filter((r) => Number.isFinite(r.startMs) && Number.isFinite(r.endMs));
  }

  function renderGantt(rows) {
    const inner = document.getElementById("gantt-inner");
    const empty = document.getElementById("gantt-empty");
    const note = document.getElementById("gantt-nodate-note");
    if (!inner) return;

    const bars = ganttBarsData(rows);
    const noDateCount = rows.length - bars.length;
    note.textContent = noDateCount > 0
      ? `${noDateCount} project${noDateCount === 1 ? "" : "s"} ${noDateCount === 1 ? "has" : "have"} no due date, so ${noDateCount === 1 ? "it can't" : "they can't"} be plotted here — see Decisions & Gaps.`
      : "";

    empty.hidden = bars.length > 0;
    if (bars.length === 0) {
      inner.innerHTML = "";
      ganttTodayLeftPx = null;
      return;
    }

    // Range = the first day of the quarter containing the earliest bar
    // start, through the last day of the quarter containing the latest bar
    // end -- so the timeline always shows whole quarters, never a sliver of
    // one at either edge.
    const earliestStart = new Date(Math.min(...bars.map((b) => b.startMs)));
    const latestEnd = new Date(Math.max(...bars.map((b) => b.endMs)));
    const rangeStart = quarterStart(earliestStart);
    const rangeEnd = quarterEndExclusive(latestEnd);
    const rangeStartMs = rangeStart.getTime();
    const totalDays = Math.max(1, Math.round((rangeEnd.getTime() - rangeStartMs) / DAY_MS));
    const timelineWidth = totalDays * GANTT_PX_PER_DAY;

    const QUARTER_LABEL = ["Q1", "Q2", "Q3", "Q4"];
    const quarters = [];
    let cursor = new Date(rangeStart);
    while (cursor.getTime() < rangeEnd.getTime()) {
      const qStart = new Date(cursor);
      const qEnd = quarterEndExclusive(qStart);
      const days = Math.round((qEnd.getTime() - qStart.getTime()) / DAY_MS);
      quarters.push({
        label: `${QUARTER_LABEL[quarterOf(qStart)]} ${qStart.getFullYear()}`,
        leftPx: ((qStart.getTime() - rangeStartMs) / DAY_MS) * GANTT_PX_PER_DAY,
        widthPx: days * GANTT_PX_PER_DAY,
      });
      cursor = qEnd;
    }

    const quartersHtml = quarters
      .map(
        (q, i) => `<div class="gantt-quarter${i % 2 === 1 ? " gantt-quarter-shaded" : ""}" style="left:${q.leftPx}px;width:${q.widthPx}px;">${escapeHtml(q.label)}</div>`
      )
      .join("");
    const quarterBandsHtml = quarters
      .map((q, i) => (i % 2 === 1 ? `<div class="gantt-quarter-band" style="left:${q.leftPx}px;width:${q.widthPx}px;"></div>` : ""))
      .join("");

    // A second, finer-grained header row underneath the quarters -- same
    // shared date axis, just labeled by month so a bar's exact start/end can
    // be read without hovering for the tooltip.
    const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const months = [];
    cursor = new Date(rangeStart);
    while (cursor.getTime() < rangeEnd.getTime()) {
      const mStart = new Date(cursor);
      const mEnd = monthEndExclusive(mStart);
      const days = Math.round((mEnd.getTime() - mStart.getTime()) / DAY_MS);
      months.push({
        label: `${MONTH_LABEL[mStart.getMonth()]} ${mStart.getFullYear()}`,
        leftPx: ((mStart.getTime() - rangeStartMs) / DAY_MS) * GANTT_PX_PER_DAY,
        widthPx: days * GANTT_PX_PER_DAY,
      });
      cursor = mEnd;
    }
    const monthsHtml = months
      .map((m) => `<div class="gantt-month" style="left:${m.leftPx}px;width:${m.widthPx}px;">${escapeHtml(m.label)}</div>`)
      .join("");

    const nowMs = Date.now();
    const todayHtml =
      nowMs >= rangeStartMs && nowMs <= rangeEnd.getTime()
        ? `<div class="gantt-today-line" style="left:${GANTT_LABEL_WIDTH + ((nowMs - rangeStartMs) / DAY_MS) * GANTT_PX_PER_DAY}px;"></div>`
        : "";

    const rowsHtml = bars
      .map(({ p, startMs, endMs, assumed }) => {
        const leftPx = ((startMs - rangeStartMs) / DAY_MS) * GANTT_PX_PER_DAY;
        const widthPx = Math.max(((endMs - startMs) / DAY_MS) * GANTT_PX_PER_DAY, GANTT_MIN_BAR_PX);
        const gate = p.currentGate || p.gatePhase || "—";
        const startLabel = assumed ? `~${fmtDate(new Date(startMs).toISOString())} (assumed)` : fmtDate(new Date(startMs).toISOString());
        const tooltip = `${p.name} — ${startLabel} → ${fmtDate(p.targetGateDate)} · ${HEALTH_LABEL[p.healthBucket] || p.healthBucket}${p.progressPercent != null ? ` · ${p.progressPercent}%` : ""}`;
        return `
          <div class="gantt-row">
            <div class="gantt-row-label">
              <a class="project-link" href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>
              <div class="gantt-row-sub">${escapeHtml(gate)} · Due ${fmtDate(p.targetGateDate)}</div>
            </div>
            <div class="gantt-row-track" style="width:${timelineWidth}px;">
              <div class="gantt-bar ${p.healthBucket}${assumed ? " gantt-bar-assumed" : ""}" style="left:${leftPx}px;width:${widthPx}px;" title="${escapeHtml(tooltip)}">
                <span class="gantt-bar-label">${p.progressPercent != null ? p.progressPercent + "%" : ""}</span>
              </div>
            </div>
          </div>`;
      })
      .join("");

    inner.innerHTML = `
      <div class="gantt-header" style="width:${GANTT_LABEL_WIDTH + timelineWidth}px;">
        <div class="gantt-header-row">
          <div class="gantt-header-spacer" style="width:${GANTT_LABEL_WIDTH}px;"></div>
          <div class="gantt-quarters" style="width:${timelineWidth}px;">${quartersHtml}</div>
        </div>
        <div class="gantt-header-row gantt-header-row-months">
          <div class="gantt-header-spacer" style="width:${GANTT_LABEL_WIDTH}px;"></div>
          <div class="gantt-months" style="width:${timelineWidth}px;">${monthsHtml}</div>
        </div>
      </div>
      <div class="gantt-body" style="width:${GANTT_LABEL_WIDTH + timelineWidth}px;">
        <div class="gantt-quarter-bands" style="left:${GANTT_LABEL_WIDTH}px;width:${timelineWidth}px;">${quarterBandsHtml}</div>
        ${rowsHtml}
      </div>
      ${todayHtml}
    `;
    // Recorded here (not applied here) so setupTabs() can do the actual
    // one-time auto-scroll once the tab is visible -- see the comment there
    // for why this can't just scroll the container directly on every render.
    ganttTodayLeftPx = nowMs >= rangeStartMs && nowMs <= rangeEnd.getTime() ? (nowMs - rangeStartMs) / DAY_MS * GANTT_PX_PER_DAY : null;
  }

  // ---- meta / context -------------------------------------------------------

  function renderContextHint() {
    const hint = document.getElementById("viewing-hint");
    if (viewingProjectId) {
      hint.textContent = "scoped to 1 project — clear to see the full portfolio";
    } else {
      hint.textContent = `${allProjects.length} project${allProjects.length === 1 ? "" : "s"} tracked`;
    }
  }

  // ---- single-project view (VIEWING selector scoped to one project) ----

  function projectDetailHtml(p) {
    const gate = p.currentGate || p.gatePhase;
    const gateConfirmed = !!gate && GATE_ORDER.includes(gate);
    const healthLabel = HEALTH_LABEL[p.healthBucket] || p.healthBucket;
    const assigneeNames = (p.assignees || []).map((a) => a.name).join(", ") || "Unassigned";

    return `
      <section class="panel project-detail-card">
        <div class="project-detail-header">
          <div>
            <h2><a href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a></h2>
            <div class="project-detail-meta">
              <span class="status-dot ${p.healthBucket}"></span>${escapeHtml(healthLabel)}
              ${p.productCategory ? ` · ${escapeHtml(p.productCategory)}` : ""}
              ${p.product ? ` · ${escapeHtml(p.product)}` : ""}
            </div>
          </div>
          ${p.progressPercent != null
            ? `<div class="project-detail-progress"><div class="project-detail-progress-value">${p.progressPercent}%</div><div class="project-detail-progress-label">progress</div></div>`
            : ""}
        </div>
        ${stageBarHtml(GATE_ORDER, gateConfirmed ? gate : null, gateConfirmed)}
        <div class="project-detail-grid">
          <div><span class="project-detail-label">Target date</span><span>${p.targetGateDate ? `${fmtDate(p.targetGateDate)} · ${relativeLabel(p.targetGateDate)}` : "Not set"}</span></div>
          <div><span class="project-detail-label">Owner(s)</span><span>${escapeHtml(assigneeNames)}</span></div>
          <div><span class="project-detail-label">Risk status</span><span>${escapeHtml(p.riskStatus || "Not set")}</span></div>
        </div>
        ${p.gaps && p.gaps.length
          ? `<div class="decision-reasons">${p.gaps.map((g) => `<span class="reason-chip">${escapeHtml(g.label)}</span>`).join("")}</div>`
          : ""}
      </section>`;
  }

  function renderProjectDetail(project) {
    document.getElementById("project-detail-card").innerHTML = project ? projectDetailHtml(project) : "";
  }

  // Toggles the Overview tab between the portfolio-wide widgets (KPIs, mix
  // charts) and the single-project detail card -- a donut/bar chart over one
  // project isn't meaningful, so we swap the whole top section rather than
  // trying to "filter" charts down to n=1.
  function toggleOverviewMode(scopedProject) {
    document.getElementById("project-detail-card").hidden = !scopedProject;
    document.getElementById("kpi-row").hidden = !!scopedProject;
    document.getElementById("portfolio-mix-panel").hidden = !!scopedProject;
  }

  // Upcoming Gates / Timeline should reflect whatever the VIEWING selector
  // is scoped to. The backend's upcomingGates is a portfolio-wide top-6 --
  // when scoped to one project we compute straight from that project's own
  // data instead, so a project outside the global top-6 still shows its date.
  function gatesForContext(data, scopedProject) {
    if (scopedProject) {
      if (!scopedProject.targetGateDate) return [];
      return [{
        project: scopedProject.name,
        gate: scopedProject.currentGate || scopedProject.gatePhase,
        date: scopedProject.targetGateDate,
      }];
    }
    return data.upcomingGates || [];
  }

  function renderMeta(data) {
    const badge = document.getElementById("source-badge");
    const updated = document.getElementById("updated-at");
    const isLive = data.source === "clickup";
    badge.textContent = isLive ? "Live · ClickUp" : "Preview · mock data";
    badge.className = "badge " + (isLive ? "live" : "mock");
    updated.textContent = data.generatedAt
      ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`
      : "";
  }

  function renderAll() {
    const data = window.__portfolioData;
    if (!data) return;

    const scopedProject = viewingProjectId ? allProjects.find((p) => p.id === viewingProjectId) : null;
    toggleOverviewMode(scopedProject);
    if (scopedProject) {
      renderProjectDetail(scopedProject);
    } else {
      renderKpis(data);
      renderHealthChart(data.counts);
      renderGateChart(data.byGate);
    }

    const gates = gatesForContext(data, scopedProject);
    renderTimeline(gates);
    renderGates(gates);
    renderTable();
    renderGroupedTabs();
    renderGantt(getContextProjects());
    renderCalendar();
    renderDecisions(data.decisions);
    renderRisks(data);
    renderWorkload(data.workload);
    renderWorkloadDonut(data.workload);
    renderWorkloadKanban(data.workload, weeklyData);
    renderChecklists();
    renderTooling();
    renderLab();
    renderContextHint();
  }

  // ---- data load -------------------------------------------------------------
  async function load() {
    try {
      const res = await fetch("/api/portfolio");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      window.__portfolioData = data;
      allProjects = data.projects || [];
      fieldOptions = data.fieldOptions || {};
      members = data.members || [];
      renderMeta(data);
      populateViewingSelect(allProjects);
      populateCategoryFilter(allProjects);
      populateOwnerFilter(allProjects);
      populateGateFilter(allProjects);
      populateIdeaCategoryOptions(allProjects);
      populateProjectNameOptions("risk-project-options", allProjects);
      populateProjectNameOptions("issue-project-options", allProjects);
      populateProjectNameOptions("lesson-project-options", allProjects);
      renderAll();
      if (window.__dismissSplash) window.__dismissSplash();
    } catch (err) {
      document.getElementById("source-badge").textContent = "Error loading data";
      console.error(err);
      if (window.__dismissSplash) window.__dismissSplash();
    }
  }

  // ---- wiring -------------------------------------------------------------
  applyTabOrder();
  setupTabs();
  wireTabDragReorder();
  setupSubtabs();
  setupDonutHoverTooltip("workload-donut-root", "workload-donut-svg", workloadDonutTooltipLabel);
  setupRiskReasonFilter();
  initAllResizableTables();
  setupDeepDive();

  // Light mode is the true default regardless of OS/browser preference --
  // the CSS no longer auto-switches on prefers-color-scheme, so the only way
  // into dark mode is this button. The last choice is remembered locally
  // (this app runs from a file the user opens directly, not the in-chat
  // preview, so localStorage is safe to rely on here) so a returning visit
  // keeps whichever mode was picked instead of resetting to light every time.
  // Sun (light mode active, offer to switch to dark) / moon (dark mode
  // active, offer to switch to light) icon paths for the header toggle --
  // matching icon set as the rest of the chrome (Feather-style stroke
  // icons), swapped alongside the button's text label.
  const THEME_ICON_SUN = "M20 14.5A8 8 0 0 1 9.5 4 8.2 8.2 0 1 0 20 14.5z";
  const THEME_ICON_MOON = "M12 3v2M12 19v2M5 12H3M21 12h-2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8";
  function applyThemeButton(theme) {
    document.getElementById("theme-toggle-label").textContent = theme === "dark" ? "Light mode" : "Dark mode";
    document.getElementById("theme-toggle-icon").querySelector("path").setAttribute("d", theme === "dark" ? THEME_ICON_MOON : THEME_ICON_SUN);
  }

  (function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem("pm-dashboard-theme"); } catch { /* ignore */ }
    const theme = saved === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    applyThemeButton(theme);
  })();

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const root = document.documentElement;
    const isDark = root.getAttribute("data-theme") === "dark";
    const next = isDark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    applyThemeButton(next);
    try { localStorage.setItem("pm-dashboard-theme", next); } catch { /* ignore */ }
    // The donut's slice colors are painted as inline SVG attributes (not CSS
    // custom properties), since stroke-dasharray math and per-slice color
    // both live in the same JS pass -- so a theme flip needs a re-render to
    // pick up the other mode's step. The hours chart's segment colors are
    // plain CSS classes and repaint on their own.
    const data = window.__portfolioData;
    if (data) renderWorkloadDonut(data.workload);
  });

  // ---- splash screen ---------------------------------------------------------
  // A brief branded loading screen on every page load, matching the design's
  // timing (bar fills, then the whole thing fades once real data starts
  // rendering rather than on a fixed clock, so a slow ClickUp fetch is never
  // hidden behind a splash that already dismissed itself).
  (function splash() {
    const el = document.getElementById("splash");
    const bar = document.getElementById("splash-bar-fill");
    if (!el || !bar) return;
    requestAnimationFrame(() => { bar.style.width = "85%"; });
    const dismiss = () => {
      bar.style.width = "100%";
      el.classList.add("fade");
      setTimeout(() => el.remove(), 700);
    };
    // Fires once real portfolio data has rendered at least once; falls back
    // to a fixed delay if load() never resolves (offline preview, error).
    window.__dismissSplash = dismiss;
    setTimeout(dismiss, 2600);
  })();

  document.getElementById("refresh-btn").addEventListener("click", () => load());

  document.getElementById("weekly-refresh-btn").addEventListener("click", () => loadWeekly());

  document.getElementById("weekly-summary-preview-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Opening…";
    try {
      const data = await resolveExportPhotos(buildStandupSummaryData());
      previewHtmlInNewTab(renderStandupSummaryHtml(data));
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  document.getElementById("weekly-summary-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Building…";
    try {
      const data = await resolveExportPhotos(buildStandupSummaryData());
      const html = renderStandupSummaryHtml(data);
      downloadTextFile(`standup-summary-${currentWeekMondayIso()}.html`, html, "text/html");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  document.getElementById("weekly-slides-btn").addEventListener("click", (e) => downloadStandupSlides(e.currentTarget));

  document.getElementById("viewing-select").addEventListener("change", (e) => {
    viewingProjectId = e.target.value;
    renderAll();
  });

  document.querySelectorAll("#period-pills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#period-pills .pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      periodDays = Number(pill.dataset.days);
      renderAll();
    });
  });

  document.getElementById("project-search").addEventListener("input", (e) => {
    searchTerm = e.target.value;
    renderTable();
  });

  document.getElementById("product-category-filter").addEventListener("change", (e) => {
    categoryFilter = e.target.value;
    renderTable();
  });

  document.getElementById("calendar-prev").addEventListener("click", () => {
    calendarMonthOffset -= 1;
    renderCalendar();
  });
  document.getElementById("calendar-next").addEventListener("click", () => {
    calendarMonthOffset += 1;
    renderCalendar();
  });
  document.getElementById("calendar-today").addEventListener("click", () => {
    calendarMonthOffset = 0;
    renderCalendar();
  });

  document.getElementById("clear-filter").addEventListener("click", () => {
    healthFilter = null;
    noOwnerFilter = false;
    ownerFilter = "";
    gateFilter = "";
    riskOnlyFilter = false;
    renderAll();
  });

  document.getElementById("owner-filter").addEventListener("change", (e) => {
    const value = e.target.value;
    noOwnerFilter = value === "__unassigned__";
    ownerFilter = noOwnerFilter ? "" : value;
    renderTable();
  });

  document.getElementById("gate-filter").addEventListener("change", (e) => {
    gateFilter = e.target.value;
    renderTable();
  });

  document.getElementById("health-filter-select").addEventListener("change", (e) => {
    healthFilter = e.target.value || null;
    renderTable();
  });

  document.getElementById("risk-filter-select").addEventListener("change", (e) => {
    riskOnlyFilter = e.target.value === "atrisk";
    renderTable();
  });

  // Scoped to the sortable label-row cells only -- the thead also has a
  // group-row (section headers, no data-sort) and a filter-row (holds the
  // <select> filter controls, also no data-sort) above/below it, and binding
  // this to every <th> in the table would set sortKey to undefined when
  // either of those rows is clicked.
  document.querySelectorAll("#projects-table thead tr.label-row th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = "asc";
      }
      renderTable();
    });
  });

  document.getElementById("idea-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = document.getElementById("idea-submit-btn");
    const status = document.getElementById("idea-form-status");

    const payload = {
      title: document.getElementById("idea-title").value.trim(),
      product: document.getElementById("idea-product").value.trim(),
      productCategory: document.getElementById("idea-category").value.trim(),
      description: document.getElementById("idea-description").value.trim(),
      targetDate: document.getElementById("idea-target-date").value || null,
    };

    btn.disabled = true;
    status.textContent = "Submitting…";
    status.className = "form-status";

    try {
      const res = await fetch("/api/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Submission failed");

      if (data.source === "clickup") {
        status.textContent = "Saved to ClickUp ✓";
        status.className = "form-status success";
      } else {
        if (data.idea) saveLocalBackupEntry("idea", data.idea);
        status.textContent = `${data.note || "Previewed only — ClickUp intake list isn't configured yet."} Kept a local backup so it isn't lost.`;
        status.className = "form-status info";
      }
      form.reset();
      await loadIdeas();
    } catch (err) {
      saveLocalBackupEntry("idea", {
        name: payload.title || "(untitled idea)",
        description: payload.description || "",
        product: payload.product || "",
        productCategory: payload.productCategory || "",
        dueDate: payload.targetDate || null,
        createdAt: new Date().toISOString(),
        url: "#",
      });
      await loadIdeas();
      status.textContent = `Couldn't submit: ${err.message}. Kept a local backup so it isn't lost.`;
      status.className = "form-status error";
    } finally {
      btn.disabled = false;
    }
  });

  // Edit an already-submitted idea in place -- clicking "Edit" on a card
  // swaps just that card for a form pre-filled from the fields ideas.js
  // parsed back out of the ClickUp task's description (see
  // parseIdeaDescription), saving on submit via PUT /api/ideas.
  const ideasListEl = document.getElementById("ideas-list");
  if (ideasListEl) {
    ideasListEl.addEventListener("click", (e) => {
      const editBtn = e.target.closest("[data-idea-edit]");
      if (editBtn) {
        editingIdeaId = editBtn.dataset.ideaEdit;
        renderIdeas(lastLoadedIdeas);
        return;
      }
      const cancelBtn = e.target.closest(".idea-edit-cancel");
      if (cancelBtn) {
        editingIdeaId = null;
        renderIdeas(lastLoadedIdeas);
      }
    });
    ideasListEl.addEventListener("submit", async (e) => {
      const form = e.target.closest(".idea-edit-form");
      if (!form) return;
      e.preventDefault();
      const status = form.querySelector(".idea-edit-status");
      const payload = {
        id: form.dataset.ideaId,
        title: form.querySelector(".idea-edit-title").value.trim(),
        product: form.querySelector(".idea-edit-product").value.trim(),
        productCategory: form.querySelector(".idea-edit-category").value.trim(),
        description: form.querySelector(".idea-edit-description").value.trim(),
        targetDate: form.querySelector(".idea-edit-target-date").value || null,
      };
      status.textContent = "Saving…";
      status.className = "form-status idea-edit-status";
      try {
        const res = await fetch("/api/ideas", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Save failed");
        if (data.source === "clickup") {
          editingIdeaId = null;
          await loadIdeas();
        } else {
          // Mock/preview mode has no backing store to write the edit into --
          // GET always returns the same static list -- so closing the form
          // here would silently look like the edit was dropped. Leave it
          // open with the same note the create form shows, and let the user
          // dismiss it with Cancel once they've read it.
          status.textContent = data.note || "Previewed only — ClickUp intake list isn't configured yet, so this edit wasn't saved.";
          status.className = "form-status idea-edit-status info";
        }
      } catch (err) {
        status.textContent = `Couldn't save: ${err.message}`;
        status.className = "form-status idea-edit-status error";
      }
    });
  }

  Object.keys(REGISTER_UI).forEach((type) => {
    wireRegisterForm(type);
    wireLocalBackupDismiss(REGISTER_UI[type].listId, type, () => loadRegister(type));
  });
  wireLocalBackupDismiss("ideas-list", "idea", () => renderIdeas(lastLoadedIdeas));

  // Setting a project's tooling priority -- re-sorts the table in place
  // (rather than a full renderAll) so picking a priority doesn't reset
  // scroll position or steal focus mid-selection.
  const toolingTbody = document.getElementById("tooling-tbody");
  if (toolingTbody) {
    toolingTbody.addEventListener("change", (e) => {
      const select = e.target.closest(".tooling-priority-select");
      if (!select) return;
      setToolingPriority(select.dataset.project, select.value);
      renderTooling();
    });
  }

  // Tooling drag-and-drop reordering -- native HTML5 DnD via the "⠿" handle
  // in each row's first cell. A drag moves the actual <tr> (paired with its
  // own task-detail row so a dragged project keeps its open/closed task
  // panel) and persists the DOM's final order directly -- no re-render, so
  // nothing else on the table (an open task panel, an unsaved priority
  // selection) is disturbed by dragging.
  function toolingDragAfterElement(container, y) {
    const candidates = [...container.querySelectorAll('tr[draggable="true"]:not(.dragging)')];
    return candidates.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset, element: child };
        return closest;
      },
      { offset: Number.NEGATIVE_INFINITY, element: null }
    ).element;
  }

  if (toolingTbody) {
    toolingTbody.addEventListener("dragstart", (e) => {
      const row = e.target.closest('tr[draggable="true"]');
      if (!row) return;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.dataset.project || "");
    });
    toolingTbody.addEventListener("dragover", (e) => {
      const dragging = toolingTbody.querySelector("tr.dragging");
      if (!dragging) return;
      e.preventDefault();
      const afterElement = toolingDragAfterElement(toolingTbody, e.clientY);
      const tasksRow = dragging.nextElementSibling && dragging.nextElementSibling.classList.contains("project-tasks-row") ? dragging.nextElementSibling : null;
      const pairNodes = [dragging, tasksRow].filter(Boolean);
      if (!afterElement) {
        pairNodes.forEach((node) => toolingTbody.appendChild(node));
      } else {
        pairNodes.forEach((node) => toolingTbody.insertBefore(node, afterElement));
      }
    });
    toolingTbody.addEventListener("dragend", () => {
      const dragging = toolingTbody.querySelector("tr.dragging");
      if (dragging) dragging.classList.remove("dragging");
      const newOrder = [...toolingTbody.querySelectorAll('tr[draggable="true"]')].map((tr) => tr.dataset.project).filter(Boolean);
      if (newOrder.length) setToolingOrder(newOrder);
    });
  }

  // Per-project task panels (Tasks toggle + add/check/remove list) -- same
  // wiring on both the Tooling and Lab tables.
  wireProjectTasksPanel(toolingTbody, "tooling");
  wireProjectTasksPanel(document.getElementById("lab-tbody"), "lab");

  // Event delegation for every checklist checkbox (Checklists tab) -- one
  // listener on the grid container rather than one per checkbox, since the
  // grid's innerHTML is fully rebuilt on every renderAll(). Updates the
  // clicked item + its card's progress count directly instead of
  // re-rendering the whole grid, so a click doesn't reset scroll position.
  // Updates a card's progress text, heat bar/border, and one checklist item
  // in place -- avoids a full re-render on every checkbox click so it
  // doesn't reset scroll position, same reasoning as before this project
  // added the heat-map coloring.
  function updateChecklistCardHeat(card) {
    const total = card.querySelectorAll(".checklist-item:not(.checklist-item-none)").length;
    const done = card.querySelectorAll(".checklist-item-done").length;
    const progress = card.querySelector(".checklist-progress");
    if (progress) progress.textContent = `${done} / ${total} complete`;
    if (total > 0) {
      const pct = done / total;
      const color = checklistHeatColor(pct);
      card.style.borderLeftColor = color;
      const fill = card.querySelector(".checklist-heat-fill");
      if (fill) {
        fill.style.width = `${(pct * 100).toFixed(0)}%`;
        fill.style.background = color;
      }
    }
  }

  document.getElementById("checklist-grid").addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-project]');
    if (!cb) return;
    const { project, gate, index, section, customId } = cb.dataset;
    if (customId) {
      toggleCustomChecklistItem(project, section, customId, cb.checked);
    } else {
      setChecklistItemChecked(project, gate, Number(index), cb.checked);
    }
    const item = cb.closest(".checklist-item");
    if (item) item.classList.toggle("checklist-item-done", cb.checked);
    const card = cb.closest(".checklist-card");
    if (card) updateChecklistCardHeat(card);
  });

  // Adding an item to a specific section -- Enter in that section's
  // add-input submits its form (one per section, event-delegated since the
  // whole grid is rebuilt on every render). Re-renders the grid so the new
  // item's checkbox/remove button are wired up like any other.
  document.getElementById("checklist-grid").addEventListener("submit", (e) => {
    const form = e.target.closest(".checklist-add-form");
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector(".checklist-add-input");
    const text = (input?.value || "").trim();
    if (!text) return;
    const dateInput = form.querySelector(".checklist-add-date");
    addCustomChecklistItem(form.dataset.project, form.dataset.section, text, dateInput?.value || "");
    renderChecklists();
  });

  // Removing an item -- a custom one added earlier, or a standard template
  // item this project doesn't need -- and restoring every standard item
  // this project has hidden, in one click.
  document.getElementById("checklist-grid").addEventListener("click", (e) => {
    const editSpan = e.target.closest("[data-editable-text][data-custom-id]");
    if (editSpan) {
      // Same reasoning as the Tooling/Lab task list -- stop the enclosing
      // <label> from also toggling the checkbox on this same click.
      e.preventDefault();
      const { project, section, customId } = editSpan.dataset;
      beginInlineTextEdit(editSpan, (newText) => {
        editCustomChecklistItem(project, section, customId, { text: newText });
        renderChecklists();
      });
      return;
    }
    const customBtn = e.target.closest(".checklist-remove-btn[data-remove-custom-id]");
    if (customBtn) {
      removeCustomChecklistItem(customBtn.dataset.project, customBtn.dataset.removeCustomSection, customBtn.dataset.removeCustomId);
      renderChecklists();
      return;
    }
    const standardBtn = e.target.closest(".checklist-remove-btn[data-remove-standard-section]");
    if (standardBtn) {
      removeStandardItem(standardBtn.dataset.project, standardBtn.dataset.removeStandardSection, Number(standardBtn.dataset.removeStandardIndex));
      renderChecklists();
      return;
    }
    const resetBtn = e.target.closest(".checklist-reset-removed");
    if (resetBtn) {
      restoreAllRemovedItems(resetBtn.dataset.project);
      renderChecklists();
      return;
    }
    // Expand/collapse all of one card's sections at once -- pure UI state,
    // no data change, so this flips the <details> elements directly rather
    // than going through a full re-render.
    const foldBtn = e.target.closest(".checklist-fold-toggle[data-fold-action]");
    if (foldBtn) {
      const card = foldBtn.closest(".checklist-card");
      if (card) {
        const shouldOpen = foldBtn.dataset.foldAction === "expand";
        card.querySelectorAll("details.checklist-section").forEach((d) => { d.open = shouldOpen; });
      }
    }
  });

  // ---- Add Project (Tooling & Lab tabs) ------------------------------------
  // Tooling and Lab only ever showed projects ClickUp already had -- there
  // was no way to get a brand new one in front of either tab without going
  // to create it in ClickUp first. This opens one shared modal (see
  // #add-project-overlay in index.html) from either tab's "+ Add project"
  // button and POSTs to /api/project-create, which creates a real task on
  // the Active list (so the new project shows up everywhere else in the
  // dashboard too, not just here) and best-effort sets its Product
  // Category/Stage Gate/Tooling custom fields. When ClickUp isn't
  // configured (or the request fails outright), it falls back to the same
  // local-backup safety net as Risks/Issues/Lessons/Ideas above.
  function populateAddProjectGateOptions() {
    const select = document.getElementById("add-project-gate");
    if (!select || select.options.length > 1) return;
    GATE_ORDER.forEach((gate) => {
      const opt = document.createElement("option");
      opt.value = gate;
      opt.textContent = gate;
      select.appendChild(opt);
    });
  }

  function renderLocalBackupProjects() {
    const entries = getLocalBackupEntries("project");
    ["tooling-local-projects", "lab-local-projects"].forEach((id) => {
      const list = document.getElementById(id);
      if (!list) return;
      if (!entries.length) {
        list.hidden = true;
        list.innerHTML = "";
        return;
      }
      list.hidden = false;
      list.innerHTML = entries
        .map(
          (p) => `
        <li>
          <span class="idea-title">${escapeHtml(p.name)}</span>
          <span class="local-backup-badge" title="ClickUp isn't connected yet -- kept safe in this browser instead">Saved locally only</span>
          <button type="button" class="local-backup-dismiss" data-local-dismiss data-kind="project" data-id="${escapeHtml(p.id)}" title="Remove this local backup">&times;</button>
          <div class="idea-meta">Not yet in ClickUp -- re-enter it there when the Active list is connected, then remove this local copy.</div>
        </li>`
        )
        .join("");
    });
  }
  wireLocalBackupDismiss("tooling-local-projects", "project", renderLocalBackupProjects);
  wireLocalBackupDismiss("lab-local-projects", "project", renderLocalBackupProjects);

  function openAddProjectModal(fromTab) {
    populateAddProjectGateOptions();
    const overlay = document.getElementById("add-project-overlay");
    const hint = document.getElementById("add-project-hint");
    const toolingCb = document.getElementById("add-project-tooling");
    if (!overlay) return;
    // A steer, not a lock -- opened from Lab, "Needs tooling" starts
    // unchecked (and vice versa from Tooling, checked), but either can be
    // changed before submitting since plenty of projects need both.
    if (toolingCb) toolingCb.checked = fromTab === "tooling";
    if (hint) {
      hint.textContent =
        fromTab === "lab"
          ? "Creates a real project on the Active portfolio list, not just a local note -- it'll show up everywhere else in the dashboard too, not only in Lab."
          : "Creates a real project on the Active portfolio list, not just a local note -- it'll show up everywhere else in the dashboard too, not only in Tooling.";
    }
    overlay.hidden = false;
  }
  function closeAddProjectModal() {
    const overlay = document.getElementById("add-project-overlay");
    const form = document.getElementById("add-project-form");
    const status = document.getElementById("add-project-status");
    if (overlay) overlay.hidden = true;
    if (form) form.reset();
    if (status) { status.textContent = ""; status.className = "form-status"; }
  }
  document.querySelectorAll("[data-add-project]").forEach((btn) => {
    btn.addEventListener("click", () => openAddProjectModal(btn.dataset.addProject));
  });
  const addProjectCancelBtn = document.getElementById("add-project-cancel");
  if (addProjectCancelBtn) addProjectCancelBtn.addEventListener("click", closeAddProjectModal);
  document.addEventListener("keydown", (e) => {
    const overlay = document.getElementById("add-project-overlay");
    if (e.key === "Escape" && overlay && !overlay.hidden) closeAddProjectModal();
  });

  const addProjectForm = document.getElementById("add-project-form");
  if (addProjectForm) {
    addProjectForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("add-project-submit-btn");
      const status = document.getElementById("add-project-status");
      const payload = {
        name: document.getElementById("add-project-name").value.trim(),
        productCategory: document.getElementById("add-project-category").value.trim(),
        owners: document.getElementById("add-project-owners").value.trim(),
        currentGate: document.getElementById("add-project-gate").value,
        targetGateDate: document.getElementById("add-project-target-date").value || "",
        tooling: document.getElementById("add-project-tooling").checked,
        scope: document.getElementById("add-project-scope").value.trim(),
        timeline: document.getElementById("add-project-timeline").value.trim(),
        costResource: document.getElementById("add-project-cost-resource").value.trim(),
        impact: document.getElementById("add-project-impact").value.trim(),
        priority: document.getElementById("add-project-priority").value.trim(),
      };
      if (!payload.name) return;

      btn.disabled = true;
      status.textContent = "Adding…";
      status.className = "form-status";

      try {
        const res = await fetch("/api/project-create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Couldn't add project");

        if (data.source === "clickup") {
          status.textContent = "Added to ClickUp ✓ — Refresh to see it across the dashboard.";
          status.className = "form-status success";
          closeAddProjectModal();
          load();
        } else {
          saveLocalBackupEntry("project", data.project);
          renderLocalBackupProjects();
          status.textContent = `${data.note || "Previewed only — the Active list isn't configured yet."} Kept a local backup so it isn't lost.`;
          status.className = "form-status info";
        }
      } catch (err) {
        saveLocalBackupEntry("project", {
          name: payload.name,
          description: `Product Category: ${payload.productCategory || "(not specified)"}\nOwner(s): ${payload.owners || "(not specified)"}\nStage Gate: ${payload.currentGate || "(not specified)"}`,
          createdAt: new Date().toISOString(),
          url: "#",
        });
        renderLocalBackupProjects();
        status.textContent = `Couldn't add project: ${err.message}. Kept a local backup so it isn't lost.`;
        status.className = "form-status error";
      } finally {
        btn.disabled = false;
      }
    });
  }
  renderLocalBackupProjects();

  load();
  loadIdeas();
  loadRegister("risk");
  loadRegister("issue");
  loadRegister("lesson");
  setInterval(load, 120000); // background refresh every 2 minutes
})();
