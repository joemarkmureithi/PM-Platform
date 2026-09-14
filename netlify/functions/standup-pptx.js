const PptxGenJS = require("pptxgenjs");
const fs = require("fs");
const path = require("path");

// POST /api/standup-pptx
// Builds an actual PowerPoint deck from the same standup-summary data the
// "Download summary" HTML export uses (buildStandupSummaryData() in
// dashboard.js) -- the caller POSTs that already-assembled JSON (which
// includes the client-only "gate nearing, checklist incomplete" risk
// signal; this backend has no way to compute that itself, since checklist
// state lives only in the browser's localStorage) and this just lays it
// out as slides: a title slide, one slide per active project's this-week
// activity (indented to reflect the WBS tree), a risks slide, and a
// decisions/gaps slide. Meant to be screen-shared directly in the standup,
// which the downloadable HTML/Markdown export doesn't really suit.
//
// Colors mirror the dashboard's ecoa reskin (public/css/style.css :root) so
// a deck built here reads as the same product, not a different tool --
// --brand-accent, --brand-accent-deep, --text-primary/--text-muted, and a
// warm tint approximating --brand-tint over white. PowerPoint has no
// backdrop-filter/glass equivalent, so the "glass" language translates here
// as a soft tint band + a thin accent rule instead.
const ACCENT = "F58220";
const ACCENT_DEEP = "CF6408";
const ACCENT_TINT = "FDEADB";
const INK = "15171C";
const MUTED = "868D9B";
const SLIDE_BG = "FBF9F6";

let logoDataUri = null;
try {
  // Wordmark-only crop (ecoa-mark-header.png), not the full ecoa-logo.png
  // lockup -- the full asset's "stoves for life" tagline is illegible at
  // title-slide size, and its generous vertical padding was previously
  // forced into a 0.55x0.55in SQUARE box (see LOGO_H/LOGO_W below), which
  // squished the ~2.5:1 image noticeably. The crop's own aspect ratio is
  // used instead so nothing gets stretched.
  const logoPath = path.join(__dirname, "..", "..", "public", "assets", "ecoa-mark-header.png");
  logoDataUri = `image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`;
} catch {
  // Logo is a nice-to-have on the title slide only -- if it's ever missing
  // (e.g. a stripped-down deploy), the deck still builds fine without it.
  logoDataUri = null;
}
// ecoa-mark-header.png is 500x117 -- fix the display height and derive the
// width from that real ratio rather than hardcoding both.
const LOGO_H = 0.4;
const LOGO_W = LOGO_H * (500 / 117);

// Thin accent rule used under slide titles and as a footer bar, so every
// slide carries the same brand mark instead of relying on a title color
// alone.
function accentRule(slide, y) {
  slide.addShape("rect", { x: 0, y, w: 10, h: 0.06, fill: { color: ACCENT } });
}

function titleSlide(pptx, data) {
  const slide = pptx.addSlide();
  slide.background = { color: SLIDE_BG };
  slide.addShape("rect", { x: 0, y: 0, w: 10, h: 1.75, fill: { color: ACCENT_TINT } });
  const textX = logoDataUri ? 0.5 + LOGO_W + 0.2 : 0.5;
  if (logoDataUri) {
    slide.addImage({ data: logoDataUri, x: 0.5, y: 0.6 - LOGO_H / 2, w: LOGO_W, h: LOGO_H });
  } else {
    // Fallback when the asset is missing -- the wordmark crop already
    // reads as "ecoa" on its own, so this text label only needs to exist
    // when there's no image to carry that.
    slide.addText("ecoa", {
      x: textX,
      y: 0.45,
      w: 3,
      h: 0.3,
      fontSize: 14,
      bold: true,
      color: ACCENT_DEEP,
      charSpacing: 1,
    });
  }
  slide.addText("Biomass Portfolio Intelligence", {
    x: textX,
    y: 0.75,
    w: 4,
    h: 0.25,
    fontSize: 10,
    color: MUTED,
  });
  slide.addText("Weekly Standup Summary", { x: 0.5, y: 2.05, w: 9, h: 0.8, fontSize: 32, bold: true, color: INK });
  slide.addText(data.weekLabel || "", { x: 0.5, y: 2.85, w: 9, h: 0.5, fontSize: 16, color: MUTED });
  slide.addText(`Generated ${data.generatedAt || ""}`, { x: 0.5, y: 3.3, w: 9, h: 0.4, fontSize: 12, color: MUTED });

  // Same "how big a week is this" numbers the HTML export leads with (see
  // the .stat-strip in dashboard.js's renderStandupSummaryHtml) -- so a
  // reader flipping straight to the title slide in a screen-share gets the
  // same at-a-glance read the HTML version opens with, instead of having
  // to click through every project slide first to find out.
  const stats = [
    { value: (data.projects || []).length, label: "Active projects" },
    { value: (data.risks || []).length, label: "Open risks" },
    { value: (data.gaps || []).length, label: "Planning gaps" },
  ];
  const statW = 2.6;
  stats.forEach((s, i) => {
    const x = 0.5 + i * (statW + 0.2);
    slide.addShape("roundRect", { x, y: 3.85, w: statW, h: 1.0, fill: { color: "FFFFFF" }, line: { color: ACCENT_TINT, width: 1 }, rectRadius: 0.08 });
    slide.addText(String(s.value), { x, y: 3.95, w: statW, h: 0.5, fontSize: 24, bold: true, color: ACCENT_DEEP, align: "center" });
    slide.addText(s.label, { x, y: 4.45, w: statW, h: 0.3, fontSize: 10.5, color: MUTED, align: "center" });
  });

  accentRule(slide, 5.57);
}

// Truncates to a max length on a word boundary -- used for the team/priority
// lines below so a long Deep Dive entry can't wrap into (and visually
// collide with) the task list underneath it, given pptxgenjs auto-wraps
// text boxes without a strict height clamp.
function truncate(text, max) {
  if (!text || text.length <= max) return text || "";
  return `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

function projectSlide(pptx, p) {
  const slide = pptx.addSlide();
  slide.background = { color: SLIDE_BG };
  // Same square cover photo used as this project's thumbnail everywhere
  // else in the dashboard (see deepDiveIconHtml/buildStandupSummaryData) --
  // shown top-right so the deck is recognizable per-project at a glance.
  // Title width is trimmed to leave it clear rather than risk overlap.
  const hasCover = !!p.coverPhoto;
  const titleWidth = hasCover ? 8.0 : 9.2;
  slide.addText(p.name || "Untitled project", { x: 0.4, y: 0.3, w: titleWidth, h: 0.5, fontSize: 20, bold: true, color: INK });
  if (hasCover) {
    try {
      slide.addShape("roundRect", { x: 8.58, y: 0.26, w: 0.62, h: 0.62, fill: { color: "FFFFFF" }, line: { color: ACCENT_TINT, width: 1 }, rectRadius: 0.06 });
      slide.addImage({ data: p.coverPhoto.replace(/^data:/, ""), x: 8.62, y: 0.3, w: 0.54, h: 0.54, sizing: { type: "contain", w: 0.54, h: 0.54 } });
    } catch {
      // A malformed coverPhoto dataURL shouldn't take down the whole
      // export -- the slide just renders without the thumbnail.
    }
  }
  if (p.gate) {
    slide.addText(p.gate, {
      x: 0.4,
      y: 0.78,
      w: 3,
      h: 0.32,
      fontSize: 11,
      bold: true,
      color: ACCENT_DEEP,
      fill: { color: ACCENT_TINT },
      align: "center",
      valign: "middle",
      rectRadius: 0.06,
      shape: "roundRect",
    });
  }
  accentRule(slide, 1.18);

  // Team utilization + priority, pulled from this project's own Deep Dive
  // (see buildStandupSummaryData/priorityColumnText in dashboard.js) --
  // shown above the task list so the deck carries the same "who's on this
  // and what's the live call" context the standalone Weekly Priorities
  // table used to, without a separate slide/tab to keep in sync.
  let cursorY = 1.3;
  if (p.teamRows && p.teamRows.length) {
    const teamText = truncate(
      p.teamRows.map((r) => `${r.role || "—"}${r.effort ? ` (${r.effort})` : ""}`).join("   ·   "),
      150
    );
    slide.addText(`Team: ${teamText}`, { x: 0.5, y: cursorY, w: 9, h: 0.3, fontSize: 11, color: MUTED });
    cursorY += 0.34;
  }
  if (p.priorityText) {
    slide.addText(truncate(p.priorityText, 140), {
      x: 0.5,
      y: cursorY,
      w: 9,
      h: 0.32,
      fontSize: 11.5,
      bold: true,
      color: ACCENT_DEEP,
      fill: { color: ACCENT_TINT },
      align: "left",
      valign: "middle",
      rectRadius: 0.05,
      shape: "roundRect",
      inset: 0.08,
    });
    cursorY += 0.42;
  }

  const lines = (p.lines || []).map((l) => ({
    text: `${l.isParent ? "" : l.done ? "☑ " : "☐ "}${l.text}${l.due ? `  (${l.due})` : ""}${!l.isParent && l.status ? `  — ${l.status}` : ""}`,
    options: {
      bullet: !l.isParent,
      indentLevel: l.depth || 0,
      fontSize: l.isParent ? 14 : 13,
      bold: !!l.isParent,
      color: l.isParent ? INK : "333333",
      breakLine: true,
    },
  }));
  const linesY = cursorY;
  const linesH = Math.max(1.0, 5.3 - linesY);
  if (lines.length) {
    slide.addText(lines, { x: 0.5, y: linesY, w: 9, h: linesH, valign: "top" });
  } else {
    slide.addText("Nothing starting or due this week.", { x: 0.5, y: linesY, w: 9, h: 0.5, fontSize: 13, italic: true, color: MUTED });
  }
  accentRule(slide, 5.57);
}

// A PowerPoint text box has a fixed height and does not auto-shrink its
// text or scroll the way the HTML export's <ul> does -- a risks/gaps list
// longer than what fits in one box used to just run off the bottom of the
// slide and disappear, with nothing on screen suggesting there was more.
// Splitting across as many slides as needed (continuing the same title)
// means everything the HTML export shows, the deck shows too. 10 rows is a
// conservative estimate for how many single-ish-line 13pt bullets fit in
// the 4.15in-tall box below the title -- a long-text row can still wrap to
// two lines and use more of that room, so this errs toward more slides
// rather than risking a repeat of the original overflow.
const BULLET_ROWS_PER_SLIDE = 10;

function bulletSlide(pptx, title, rows, emptyText) {
  if (!rows.length) {
    const slide = pptx.addSlide();
    slide.background = { color: SLIDE_BG };
    slide.addText(title, { x: 0.4, y: 0.3, w: 9.2, h: 0.5, fontSize: 20, bold: true, color: ACCENT_DEEP });
    accentRule(slide, 0.9);
    slide.addText(emptyText, { x: 0.5, y: 1.15, w: 9, h: 0.5, fontSize: 13, italic: true, color: MUTED });
    accentRule(slide, 5.57);
    return;
  }
  const chunks = [];
  for (let i = 0; i < rows.length; i += BULLET_ROWS_PER_SLIDE) {
    chunks.push(rows.slice(i, i + BULLET_ROWS_PER_SLIDE));
  }
  chunks.forEach((chunk, idx) => {
    const slide = pptx.addSlide();
    slide.background = { color: SLIDE_BG };
    const slideTitle = chunks.length > 1 ? `${title} (${idx + 1}/${chunks.length})` : title;
    slide.addText(slideTitle, { x: 0.4, y: 0.3, w: 9.2, h: 0.5, fontSize: 20, bold: true, color: ACCENT_DEEP });
    accentRule(slide, 0.9);
    const lines = chunk.map((text) => ({ text, options: { bullet: true, fontSize: 13, breakLine: true, color: "333333" } }));
    slide.addText(lines, { x: 0.5, y: 1.15, w: 9, h: 4.15, valign: "top" });
    accentRule(slide, 5.57);
  });
}

exports.handler = async (event) => {
  const jsonHeaders = { "Content-Type": "application/json" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: "POST only" }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (err) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  try {
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "STANDUP", width: 10, height: 5.63 });
    pptx.layout = "STANDUP";

    titleSlide(pptx, data);

    const projects = data.projects || [];
    if (projects.length === 0) {
      bulletSlide(pptx, "This week's activity", [], "Nothing starting or due this week across any active project.");
    } else {
      projects.forEach((p) => projectSlide(pptx, p));
    }

    bulletSlide(
      pptx,
      "Open risks",
      (data.risks || []).map((r) => `${r.name} — ${r.reason} (${r.health}, ${r.plan})`),
      "No open risks flagged right now."
    );

    bulletSlide(
      pptx,
      "Decisions & gaps needing attention",
      (data.gaps || []).map((g) => `${g.name} — ${g.gaps}`),
      "No planning gaps detected."
    );

    const base64 = await pptx.write({ outputType: "base64" });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": 'attachment; filename="standup-summary.pptx"',
      },
      body: base64,
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: err.message }) };
  }
};

// Also exposed as `handle` (not just `handler`) so api/*.js on Vercel can
// import and call the exact same logic through a thin req/res adapter --
// see api/_adapt.js. Netlify still finds this via `exports.handler` as
// before; this is an additional reference to the same function, not a
// behavior change.
exports.handle = exports.handler;
