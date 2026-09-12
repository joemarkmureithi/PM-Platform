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
  const logoPath = path.join(__dirname, "..", "..", "public", "assets", "ecoa-logo.png");
  logoDataUri = `image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`;
} catch {
  // Logo is a nice-to-have on the title slide only -- if it's ever missing
  // (e.g. a stripped-down deploy), the deck still builds fine without it.
  logoDataUri = null;
}

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
  if (logoDataUri) {
    slide.addImage({ data: logoDataUri, x: 0.5, y: 0.45, w: 0.55, h: 0.55 });
  }
  slide.addText("ecoa", {
    x: logoDataUri ? 1.15 : 0.5,
    y: 0.45,
    w: 3,
    h: 0.3,
    fontSize: 14,
    bold: true,
    color: ACCENT_DEEP,
    charSpacing: 1,
  });
  slide.addText("Biomass Portfolio Intelligence", {
    x: logoDataUri ? 1.15 : 0.5,
    y: 0.75,
    w: 4,
    h: 0.25,
    fontSize: 10,
    color: MUTED,
  });
  slide.addText("Weekly Standup Summary", { x: 0.5, y: 2.05, w: 9, h: 0.8, fontSize: 32, bold: true, color: INK });
  slide.addText(data.weekLabel || "", { x: 0.5, y: 2.85, w: 9, h: 0.5, fontSize: 16, color: MUTED });
  slide.addText(`Generated ${data.generatedAt || ""}`, { x: 0.5, y: 3.3, w: 9, h: 0.4, fontSize: 12, color: MUTED });
  accentRule(slide, 5.57);
}

function projectSlide(pptx, p) {
  const slide = pptx.addSlide();
  slide.background = { color: SLIDE_BG };
  slide.addText(p.name || "Untitled project", { x: 0.4, y: 0.3, w: 9.2, h: 0.5, fontSize: 20, bold: true, color: INK });
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
  if (lines.length) {
    slide.addText(lines, { x: 0.5, y: 1.4, w: 9, h: 3.9, valign: "top" });
  } else {
    slide.addText("Nothing starting or due this week.", { x: 0.5, y: 1.4, w: 9, h: 0.5, fontSize: 13, italic: true, color: MUTED });
  }
  accentRule(slide, 5.57);
}

function bulletSlide(pptx, title, rows, emptyText) {
  const slide = pptx.addSlide();
  slide.background = { color: SLIDE_BG };
  slide.addText(title, { x: 0.4, y: 0.3, w: 9.2, h: 0.5, fontSize: 20, bold: true, color: ACCENT_DEEP });
  accentRule(slide, 0.9);
  if (rows.length) {
    const lines = rows.map((text) => ({ text, options: { bullet: true, fontSize: 13, breakLine: true, color: "333333" } }));
    slide.addText(lines, { x: 0.5, y: 1.15, w: 9, h: 4.15, valign: "top" });
  } else {
    slide.addText(emptyText, { x: 0.5, y: 1.15, w: 9, h: 0.5, fontSize: 13, italic: true, color: MUTED });
  }
  accentRule(slide, 5.57);
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
