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
    const segments = KPI_ORDER.map(({ key, dotClass }) => ({ value: counts?.[key] ?? 0, dotClass }));
    const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
    const r = 15.9155; // circumference ~= 100, so percentages map directly to dasharray units
    const circumference = 2 * Math.PI * r;
    let offsetAccum = 0;
    const colorOf = (dotClass) => `var(--${{
      active: "series-1", delayed: "status-warning", atRisk: "status-critical", completed: "status-good",
    }[dotClass]})`;

    const circles = segments
      .filter((seg) => seg.value > 0)
      .map((seg) => {
        const fraction = seg.value / total;
        const dash = fraction * circumference;
        const gap = circumference - dash;
        const circle = `<circle r="${r}" cx="21" cy="21" fill="transparent" stroke="${colorOf(seg.dotClass)}" stroke-width="6" stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}" stroke-dashoffset="${(-offsetAccum).toFixed(2)}" />`;
        offsetAccum += dash;
        return circle;
      })
      .join("");

    return `
      <svg width="140" height="140" viewBox="0 0 42 42" role="img" aria-label="Health distribution donut chart">
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
        return `
        <div class="bar-row">
          <div class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(value / max) * 100}%; background:var(--series-1); opacity:${opacity}"></div></div>
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
  function deepDiveIconHtml(project, data) {
    const d = data || loadDeepDive(project);
    if (d && d.icon && d.icon.photo) return `<img src="${escapeHtml(d.icon.photo)}" alt="" />`;
    if (d && d.icon && d.icon.emoji) return escapeHtml(d.icon.emoji);
    return escapeHtml(DEEPDIVE_CATEGORY_ICON[project.productCategory] || "📦");
  }

  // ---- modal state + open/close -------------------------------------------
  let deepDiveState = null; // { project, data, activeTab }

  function openDeepDive(projectId) {
    const project = findProject(projectId);
    if (!project) return;
    const data = loadDeepDive(project);
    deepDiveState = { project, data, activeTab: "scope" };
    renderDeepDiveHeader();
    renderDeepDiveTabs();
    renderDeepDiveBody();
    document.getElementById("deepdive-overlay").hidden = false;
    document.body.classList.add("deepdive-open");
  }

  function closeDeepDive() {
    const overlay = document.getElementById("deepdive-overlay");
    if (overlay) overlay.hidden = true;
    const picker = document.getElementById("deepdive-icon-picker");
    if (picker) picker.hidden = true;
    document.body.classList.remove("deepdive-open");
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
    document.getElementById("deepdive-icon-btn").innerHTML = deepDiveIconHtml(project, data);
    const link = document.getElementById("deepdive-clickup-link");
    link.style.display = project.url ? "" : "none";
    link.href = project.url || "#";
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
    const { data, activeTab } = deepDiveState;
    const body = document.getElementById("deepdive-body");
    if (activeTab === "scope") body.innerHTML = deepDiveScopeHtml(data.scope);
    else if (activeTab === "timeline") body.innerHTML = deepDiveTimelineHtml(data.timeline);
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

  function deepDiveTimelineHtml(timeline) {
    return `
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
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && deepDiveState) closeDeepDive(); });

    document.getElementById("deepdive-tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".deepdive-tab");
      if (!btn || !deepDiveState) return;
      deepDiveState.activeTab = btn.dataset.tab;
      renderDeepDiveTabs();
      renderDeepDiveBody();
    });

    // Icon picker: click the header icon to open a small popover with a
    // curated emoji grid plus a photo upload (resized client-side before
    // being stored, so a phone photo doesn't blow past localStorage's quota).
    const iconBtn = document.getElementById("deepdive-icon-btn");
    const picker = document.getElementById("deepdive-icon-picker");
    iconBtn.addEventListener("click", () => {
      if (!deepDiveState) return;
      if (!picker.hidden) { picker.hidden = true; return; }
      picker.innerHTML = `
        <div class="deepdive-icon-grid">
          ${DEEPDIVE_ICON_CHOICES.map((e) => `<button type="button" class="deepdive-icon-option" data-icon-emoji="${escapeHtml(e)}">${e}</button>`).join("")}
        </div>
        <div class="deepdive-icon-picker-row">
          <label class="deepdive-icon-upload-label">📷 Upload photo<input type="file" id="deepdive-icon-file" accept="image/*" hidden /></label>
          <button type="button" class="deepdive-icon-reset-btn" id="deepdive-icon-reset">Use category default</button>
        </div>`;
      picker.hidden = false;
    });
    picker.addEventListener("click", (e) => {
      const emojiBtn = e.target.closest("[data-icon-emoji]");
      if (emojiBtn) {
        deepDiveState.data.icon = { emoji: emojiBtn.dataset.iconEmoji };
        persistDeepDiveState();
        renderDeepDiveHeader();
        picker.hidden = true;
        return;
      }
      if (e.target.id === "deepdive-icon-reset") {
        deepDiveState.data.icon = null;
        persistDeepDiveState();
        renderDeepDiveHeader();
        picker.hidden = true;
      }
    });
    picker.addEventListener("change", (e) => {
      if (e.target.id !== "deepdive-icon-file" || !e.target.files[0]) return;
      const file = e.target.files[0];
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => {
        img.onload = () => {
          // Downscale to a small square thumbnail before storing -- a raw
          // phone photo easily runs 3-5MB, which would blow through
          // localStorage's ~5-10MB-per-origin quota after a handful of
          // projects; 160px is plenty for a card/header icon.
          const size = 160;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          const scale = Math.max(size / img.width, size / img.height);
          const w = img.width * scale, h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          deepDiveState.data.icon = { photo: canvas.toDataURL("image/jpeg", 0.82) };
          persistDeepDiveState();
          renderDeepDiveHeader();
          picker.hidden = true;
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });

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

    const cards = data.projects.map(weeklyCardHtml).filter(Boolean);
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

  async function loadWeekly() {
    const total = document.getElementById("weekly-total");
    total.textContent = "Loading…";
    try {
      const res = await fetch("/api/weekly");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      renderWeekly(data);
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
      return { name: p.name, gate: p.gate || "", lines };
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

  // Base64 copy of public/assets/ecoa-logo.png, embedded so this exported
  // file stays a single, fully self-contained HTML document (no relative
  // asset path that would break once it's saved/emailed elsewhere).
  const ECOA_LOGO_DATA_URI =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAfQAAADICAYAAAAeGRPoAAAWfmNhQlgAABZ+anVtYgAAAB5qdW1kYzJwYQARABCAAACqADibcQNjMnBhAAAAFlhqdW1iAAAAR2p1bWRjMm1hABEAEIAAAKoAOJtxA3VybjpjMnBhOjNjMzk4ZWRmLTNlODctNDJiOS1hMzdmLTQwN2IwODI4MjQ4YQAAAAOTanVtYgAAAClqdW1kYzJhcwARABCAAACqADibcQNjMnBhLmFzc2VydGlvbnMAAAAAuGp1bWIAAABEanVtZGNib3IAEQAQgAAAqgA4m3ETYzJwYS5pbmdyZWRpZW50LnYzAAAAABhjMnNoHnQCuPy5XcyVF48QY3snhAAAAGxjYm9yo2lkYzpmb3JtYXRpaW1hZ2UvcG5namluc3RhbmNlSUR4LHhtcDppaWQ6ZjcyNDhiNTYtM2QzZC00YzNlLWEyN2YtZDU0NTA2NjJiMTNmbHJlbGF0aW9uc2hpcGhwYXJlbnRPZgAAAeJqdW1iAAAAQWp1bWRjYm9yABEAEIAAAKoAOJtxE2MycGEuYWN0aW9ucy52MgAAAAAYYzJzaPG5JT/025l+LKFVhZm3g+AAAAGZY2JvcqJnYWN0aW9uc4KiZmFjdGlvbmtjMnBhLm9wZW5lZGpwYXJhbWV0ZXJzoWtpbmdyZWRpZW50c4GiY3VybHgtc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5pbmdyZWRpZW50LnYzZGhhc2hYIE4HNmLzGjzzFB6yVz+ld/3zQsvDZhEWiTLTtEnqq60upGZhY3Rpb254HWNvbS5hbnRocm9waWMuY2xhdWRlLnByb3ZpZGVkanBhcmFtZXRlcnOheB9jb20uYW50aHJvcGljLm9yaWdpbi1jb25maWRlbmNlZ3Vua25vd25rZGVzY3JpcHRpb254ZkNsYXVkZSBwcm92aWRlZCB0aGlzIGZpbGUgYXQgdGhlIHJlcXVlc3Qgb2YgYSB1c2VyIGFuZCBtYXkgaGF2ZSBjcmVhdGVkIG9yIG1vZGlmaWVkIHRoZSBmaWxlIGNvbnRlbnRzLm1zb2Z0d2FyZUFnZW50oWRuYW1lZkNsYXVkZXJhbGxBY3Rpb25zSW5jbHVkZWT1AAAAyGp1bWIAAABAanVtZGNib3IAEQAQgAAAqgA4m3ETYzJwYS5oYXNoLmRhdGEAAAAAGGMyc2homGyzGiqE93PVRR0sFLGmAAAAgGNib3KlY2FsZ2ZzaGEyNTZjcGFkTQAAAAAAAAAAAAAAAABkaGFzaFggZNbC/h8uPCbvTPiDvyB9/QTd9Y/1aT3TbTjok7pwLOdkbmFtZW5qdW1iZiBtYW5pZmVzdGpleGNsdXNpb25zgaJlc3RhcnQYIWZsZW5ndGgZFooAAAI+anVtYgAAACdqdW1kYzJjbAARABCAAACqADibcQNjMnBhLmNsYWltLnYyAAAAAg9jYm9ypWNhbGdmc2hhMjU2aXNpZ25hdHVyZXhNc2VsZiNqdW1iZj0vYzJwYS91cm46YzJwYTozYzM5OGVkZi0zZTg3LTQyYjktYTM3Zi00MDdiMDgyODI0OGEvYzJwYS5zaWduYXR1cmVqaW5zdGFuY2VJRHgseG1wOmlpZDo5MjNjNTJkZS1kMDhmLTRkZWMtOWYzYy0yMDg2ZGFhZjA5MzdyY3JlYXRlZF9hc3NlcnRpb25zg6JjdXJseC1zZWxmI2p1bWJmPWMycGEuYXNzZXJ0aW9ucy9jMnBhLmluZ3JlZGllbnQudjNkaGFzaFggTgc2YvMaPPMUHrJXP6V3/fNCy8NmERaJMtO0SeqrrS6iY3VybHgqc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5hY3Rpb25zLnYyZGhhc2hYIIbFeLJuhavOjqS/assVYMx5eoLRG3zfY/uqENVDWWeWomN1cmx4KXNlbGYjanVtYmY9YzJwYS5hc3NlcnRpb25zL2MycGEuaGFzaC5kYXRhZGhhc2hYIP/DFozqhjOyLPmwT9jEcL0xLFzQlvB2ni8j5aei+gM4dGNsYWltX2dlbmVyYXRvcl9pbmZvo2RuYW1lb0FudGhyb3BpYyBGaWxlc2d2ZXJzaW9uZTEuMC4wa3NwZWNWZXJzaW9uZTIuNC4wAAAQOGp1bWIAAAAoanVtZGMyY3MAEQAQgAAAqgA4m3EDYzJwYS5zaWduYXR1cmUAAAAQCGNib3LShFkCEqIBJhghWQIKMIICBjCCAY2gAwIBAgIUQOWgCu7COdC+uIP6BkIFPWdVEwAwCgYIKoZIzj0EAwMwSTEXMBUGA1UEChMOQW50aHJvcGljLCBQQkMxLjAsBgNVBAMTJUFudGhyb3BpYyBDb250ZW50IENyZWRlbnRpYWxzIFJvb3QgQ0EwHhcNMjYwODA3MTg0MzU2WhcNMjgwODA2MTk0MzU2WjBEMRcwFQYDVQQKEw5BbnRocm9waWMsIFBCQzEpMCcGA1UEAxMgQW50aHJvcGljIENsYXVkZSBDb250ZW50IFNpZ25pbmcwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASYegpry1AYBRTVNL1CpTlbROnY3dey+UrsF9C3phYrATN3ZHf93Mo8RQN0KOUuOn19P4oWNFWe5n2/She9N7eTo1gwVjAOBgNVHQ8BAf8EBAMCB4AwFQYDVR0lBA4wDAYKKwYBBAGD6F4CATAMBgNVHRMBAf8EAjAAMB8GA1UdIwQYMBaAFM5R4gSBTmRbI/jjxM+aPpzB11zCMAoGCCqGSM49BAMDA2cAMGQCMDFzHRSeAXrSy1WOzkbhPZ6Km2wGTmZ/2gK18k8BQGXyqz88Rdrz6CTX9flAnYNVxgIwcF9c3fVhqmJKpi+UhasNUMko69cyX6STPfta3Q8EjyzDjzoyrol46FP6VFHhvUcJoWNwYWRZDZ4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2WEAsy6sqzKJzOQTv8EnUvRgth7SfNMdCrnmlzKojRtRaa/hUJAxYglKqPNBv0WshI+EmaBlwa30rFa9SshhAE5bFkPJi9wAAAAlwSFlzAAAOxAAADsQBlSsOGwAABPRpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADx4OnhtcG1ldGEgeG1sbnM6eD0nYWRvYmU6bnM6bWV0YS8nPgogICAgICAgIDxyZGY6UkRGIHhtbG5zOnJkZj0naHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyc+CgogICAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PScnCiAgICAgICAgeG1sbnM6ZGM9J2h0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvJz4KICAgICAgICA8ZGM6dGl0bGU+CiAgICAgICAgPHJkZjpBbHQ+CiAgICAgICAgPHJkZjpsaSB4bWw6bGFuZz0neC1kZWZhdWx0Jz5PbmxpbmUgU2hvcCAtIDI8L3JkZjpsaT4KICAgICAgICA8L3JkZjpBbHQ+CiAgICAgICAgPC9kYzp0aXRsZT4KICAgICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KCiAgICAgICAgPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9JycKICAgICAgICB4bWxuczpBdHRyaWI9J2h0dHA6Ly9ucy5hdHRyaWJ1dGlvbi5jb20vYWRzLzEuMC8nPgogICAgICAgIDxBdHRyaWI6QWRzPgogICAgICAgIDxyZGY6U2VxPgogICAgICAgIDxyZGY6bGkgcmRmOnBhcnNlVHlwZT0nUmVzb3VyY2UnPgogICAgICAgIDxBdHRyaWI6Q3JlYXRlZD4yMDI0LTEwLTE3PC9BdHRyaWI6Q3JlYXRlZD4KICAgICAgICA8QXR0cmliOkV4dElkPjgzNGI0ZDA4LWMzMjMtNGViZi1hZGExLWViMmU5OWIwZWE4MjwvQXR0cmliOkV4dElkPgogICAgICAgIDxBdHRyaWI6RmJJZD41MjUyNjU5MTQxNzk1ODA8L0F0dHJpYjpGYklkPgogICAgICAgIDxBdHRyaWI6VG91Y2hUeXBlPjI8L0F0dHJpYjpUb3VjaFR5cGU+CiAgICAgICAgPC9yZGY6bGk+CiAgICAgICAgPC9yZGY6U2VxPgogICAgICAgIDwvQXR0cmliOkFkcz4KICAgICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KCiAgICAgICAgPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9JycKICAgICAgICB4bWxuczpwZGY9J2h0dHA6Ly9ucy5hZG9iZS5jb20vcGRmLzEuMy8nPgogICAgICAgIDxwZGY6QXV0aG9yPlJ1aGkgU3V0dGFyd2FsYTwvcGRmOkF1dGhvcj4KICAgICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KCiAgICAgICAgPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9JycKICAgICAgICB4bWxuczp4bXA9J2h0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8nPgogICAgICAgIDx4bXA6Q3JlYXRvclRvb2w+Q2FudmEgKFJlbmRlcmVyKTwveG1wOkNyZWF0b3JUb29sPgogICAgICAgIDwvcmRmOkRlc2NyaXB0aW9uPgogICAgICAgIAogICAgICAgIDwvcmRmOlJERj4KICAgICAgICA8L3g6eG1wbWV0YT5MMl9KAABSlklEQVR4nOydeXjcxPnHvw0xSAmhVlJa1oA1mKuUAgFaSJDQiqsUig0FCiXUiehFKVdDD/X8YUhKK46mlHIWqJIthKsF1hQo5dAKLYQ7nC1XGBGwaSGWgRAtYOjv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";

  function renderStandupSummaryHtml(data) {
    const projectsHtml = data.projects.length
      ? data.projects
          .map(
            (p) => `
      <div class="project">
        <h3>${escapeHtml(p.name)}${p.gate ? ` <span class="gate">${escapeHtml(p.gate)}</span>` : ""}</h3>
        ${p.lines.map(standupLineHtml).join("")}
      </div>`
          )
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
  .doc-header img { width: 34px; height: 34px; border-radius: 9px; flex: none; }
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
    background: var(--card-bg);
    border: 1px solid var(--border-soft);
    border-radius: 16px;
    padding: 14px 18px;
    margin-bottom: 12px;
    box-shadow: 0 4px 16px rgba(21, 23, 28, 0.05);
  }
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

  async function downloadStandupSlides(btn) {
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Building…";
    try {
      const data = buildStandupSummaryData();
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

  function renderRiskKpis(risks, riskCounts) {
    const row = document.getElementById("risk-kpi-row");
    if (!row) return;
    const tiles = [
      { label: "Total at risk", value: risks.length, dotClass: "atRisk" },
      { label: "Behind schedule (auto)", value: riskCounts.schedule || 0, dotClass: "delayed" },
      { label: "Flagged in ClickUp", value: riskCounts.flagged || 0, dotClass: "atRisk" },
      { label: "Gate nearing, checklist incomplete (auto)", value: riskCounts.checklist || 0, dotClass: "delayed" },
      { label: "Needs a mitigation plan", value: riskCounts.needsMitigation || 0, dotClass: "atRisk" },
    ];
    row.innerHTML = tiles
      .map(
        (t) => `
        <div class="stat-tile stat-tile-static">
          <div class="stat-label"><span class="status-dot ${t.dotClass}"></span>${escapeHtml(t.label)}</div>
          <div class="stat-value">${t.value}</div>
        </div>`
      )
      .join("");
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
        <tr>
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
    renderRiskKpis(risks, riskCounts);
    renderRiskHealthChart(risks);
    renderRisksTable(risks);
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
  function setupDonutHoverTooltip() {
    const root = document.getElementById("workload-donut-root");
    const svg = document.getElementById("workload-donut-svg");
    if (!root || !svg) return;
    let tooltip = document.getElementById("donut-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = "donut-tooltip";
      tooltip.className = "donut-tooltip";
      tooltip.hidden = true;
      root.appendChild(tooltip);
    }

    const show = (slice, evt) => {
      tooltip.innerHTML = `<strong>${escapeHtml(slice.dataset.name)}</strong><br>${escapeHtml(slice.dataset.value)} live project${slice.dataset.value === "1" ? "" : "s"} · ${escapeHtml(slice.dataset.pct)}%`;
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

  function ideaCardHtml(idea, opts = {}) {
    const created = idea.createdAt ? fmtDate(idea.createdAt) : "—";
    return `
      <li>
        <a class="idea-title" href="${escapeHtml(idea.url || "#")}" target="_blank" rel="noopener">${escapeHtml(idea.name)}</a>
        <div class="idea-meta">Submitted ${created}${idea.dueDate ? ` · Target ${fmtDate(idea.dueDate)}` : ""}</div>
        ${idea.description ? `<div class="idea-desc">${escapeHtml(idea.description)}</div>` : ""}
        ${opts.mockNote ? `<span class="idea-mock-note">${escapeHtml(opts.mockNote)}</span>` : ""}
      </li>`;
  }

  function renderIdeas(ideas) {
    const list = document.getElementById("ideas-list");
    const empty = document.getElementById("ideas-empty");
    if (!ideas || ideas.length === 0) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = ideas.map((idea) => ideaCardHtml(idea)).join("");
  }

  async function loadIdeas() {
    try {
      const res = await fetch("/api/ideas");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      renderIdeas(data.ideas || []);
    } catch (err) {
      console.error(err);
    }
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

  function registerEntryHtml(entry) {
    const created = entry.createdAt ? fmtDate(entry.createdAt) : "—";
    return `
      <li>
        <a class="idea-title" href="${escapeHtml(entry.url || "#")}" target="_blank" rel="noopener">${escapeHtml(entry.name)}</a>
        <div class="idea-meta">Logged ${created}${entry.dueDate ? ` · ${fmtDate(entry.dueDate)}` : ""}</div>
        ${entry.description ? `<div class="idea-desc">${escapeHtml(entry.description)}</div>` : ""}
      </li>`;
  }

  function renderRegisterList(type, entries) {
    const ui = REGISTER_UI[type];
    const list = document.getElementById(ui.listId);
    const empty = document.getElementById(ui.emptyId);
    if (!list) return;
    if (!entries || entries.length === 0) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = entries.map(registerEntryHtml).join("");
  }

  async function loadRegister(type) {
    try {
      const res = await fetch(`/api/registers?type=${type}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      renderRegisterList(type, data.entries || []);
    } catch (err) {
      console.error(err);
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
          status.textContent = data.note || "Previewed only — this register's ClickUp list isn't configured yet.";
          status.className = "form-status info";
        }
        form.reset();
        await loadRegister(type);
      } catch (err) {
        status.textContent = `Couldn't submit: ${err.message}`;
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

  function addCustomChecklistItem(projectId, sectionKey, text) {
    const data = getCustomChecklistData(projectId);
    const list = data[sectionKey] || [];
    list.push({ id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, checked: false });
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
      .map(
        (it) => `
            <li class="checklist-item${it.checked ? " checklist-item-done" : ""}">
              <label>
                <input type="checkbox" data-project="${escapeHtml(p.id)}" data-section="${escapeHtml(sectionKey)}" data-custom-id="${escapeHtml(it.id)}" ${it.checked ? "checked" : ""} />
                <span>${escapeHtml(it.text)}</span>
              </label>
              <button type="button" class="checklist-remove-btn" data-project="${escapeHtml(p.id)}" data-remove-custom-section="${escapeHtml(sectionKey)}" data-remove-custom-id="${escapeHtml(it.id)}" title="Remove this item" aria-label="Remove this item">&times;</button>
            </li>`
      )
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

  function addProjectTask(projectId, text, dueDate) {
    const tasks = getProjectTasks(projectId);
    tasks.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, done: false, dueDate: dueDate || "" });
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
    const urgency = task.dueDate ? dateUrgencyInfo(task.dueDate) : null;
    return `
      <li class="checklist-item${task.done ? " checklist-item-done" : ""}">
        <label>
          <input type="checkbox" data-task-toggle data-project="${escapeHtml(projectId)}" data-task-id="${escapeHtml(task.id)}"${task.done ? " checked" : ""} />
          <span>${escapeHtml(task.text)}</span>
        </label>
        ${urgency ? `<span class="reason-chip ${urgency.cls}">${escapeHtml(urgency.label)}</span>` : ""}
        <button type="button" class="checklist-remove-btn" data-task-remove data-project="${escapeHtml(projectId)}" data-task-id="${escapeHtml(task.id)}" title="Remove task" aria-label="Remove task">&times;</button>
      </li>`;
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
              <input type="date" class="project-task-add-date" aria-label="Optional due date" />
              <button type="submit" class="project-task-add-btn">Add</button>
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
  // tbody elements rather than duplicating it.
  function wireProjectTasksPanel(tbody) {
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
      const text = (input?.value || "").trim();
      if (!text) return;
      addProjectTask(form.dataset.project, text, dateInput?.value || "");
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
  setupDonutHoverTooltip();
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

  document.getElementById("weekly-summary-btn").addEventListener("click", () => {
    const html = renderStandupSummaryHtml(buildStandupSummaryData());
    downloadTextFile(`standup-summary-${currentWeekMondayIso()}.html`, html, "text/html");
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
        status.textContent = data.note || "Previewed only — ClickUp intake list isn't configured yet.";
        status.className = "form-status info";
      }
      form.reset();
      await loadIdeas();
    } catch (err) {
      status.textContent = `Couldn't submit: ${err.message}`;
      status.className = "form-status error";
    } finally {
      btn.disabled = false;
    }
  });

  Object.keys(REGISTER_UI).forEach((type) => wireRegisterForm(type));

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
  wireProjectTasksPanel(toolingTbody);
  wireProjectTasksPanel(document.getElementById("lab-tbody"));

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
    addCustomChecklistItem(form.dataset.project, form.dataset.section, text);
    renderChecklists();
  });

  // Removing an item -- a custom one added earlier, or a standard template
  // item this project doesn't need -- and restoring every standard item
  // this project has hidden, in one click.
  document.getElementById("checklist-grid").addEventListener("click", (e) => {
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

  load();
  loadIdeas();
  loadRegister("risk");
  loadRegister("issue");
  loadRegister("lesson");
  setInterval(load, 120000); // background refresh every 2 minutes
})();
