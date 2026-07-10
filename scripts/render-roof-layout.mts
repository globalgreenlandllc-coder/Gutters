/**
 * Prove the v2 roof-layout engine on the real Woodinville A9 sheet.
 *
 * Outline comes from the sheet's vectors (same extraction production uses).
 * Edge classes are HAND-READ here from the sheet's own labels (GABLE END
 * TRUSS / gutter callouts) — in production the classifier supplies them.
 * The layout (ridges/hips/valleys) is COMPUTED by the straight skeleton and
 * scored against the 45° lines the sheet itself draws.
 *
 * Run:  npx tsx scripts/render-roof-layout.mts
 * Writes scripts/roof-layout.svg / .png (gitignored render outputs).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import sharp from "sharp";
import { segmentsFromOps, selectSegments } from "../lib/ai/pdf-segments.ts";
import { readRoofFromVectors } from "../lib/ai/roof-from-vectors.ts";
import { outlineEdges } from "../lib/ai/plan-overlay.ts";
import { buildRoofLayout, extractPlanDiagonals } from "../lib/ai/roof-layout.ts";
import type { EdgeClass } from "../lib/ai/edge-takeoff.ts";

const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const ROOF_PAGE = 11;

// Hand-read from A9's own labels (see edge-map.png for the E-ids), matching
// the elevations' own count — north (front) 3 gables + south (patio) 1:
//   E16 patio stub end   — GABLE END TRUSS (rear/south gable)
//   E8  entry porch front — gable end (front/north elevation, center)
//   E6  garage front      — gable end (front/north elevation, right)
//   E10 great-room front  — gable end (front/north elevation, left)
const RAKE_IDS = new Set(["E16", "E8", "E6", "E10"]);

const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const { OPS } = await getResolvedPDFJS();
const page = await pdf.getPage(ROOF_PAGE);
const opList = await page.getOperatorList();
const segs = selectSegments(segmentsFromOps(opList, OPS), true);

const roof = readRoofFromVectors([], segs);
if (!roof || roof.perimeter.length <= 4) {
  console.log("outline rejected");
  process.exit(1);
}
const outline = roof.perimeter;
const edges = outlineEdges(outline);
const classes: EdgeClass[] = edges.map((e) => ({
  id: e.id,
  edge_class: RAKE_IDS.has(e.id) ? "rake" : "eave",
  tier: null,
  feature: null,
  evidence: [],
}));

const layout = buildRoofLayout({ outline, edges, classes, segments: segs });
console.log(`ok=${layout.ok} reason=${layout.reason ?? "-"}`);

// The estimate path runs the drawn lines through the roof-plan invariants
// (no crossings, length caps, junction anchoring) — prove they survive.
const { filterRoofDiagramLines } = await import("../lib/ai/roof-diagram-filter.ts");
const asLines = (arr: { p1: { x: number; y: number }; p2: { x: number; y: number } }[]) =>
  arr.map((s) => ({ points: [s.p1, s.p2] }));
const filtered = filterRoofDiagramLines(
  { ridges: asLines(layout.ridges), valleys: asLines(layout.valleys), hips: asLines(layout.hips) },
  outline,
);
console.log(
  `after diagram filter: ridges ${filtered.ridges.length}/${layout.ridges.length}, ` +
    `valleys ${filtered.valleys.length}/${layout.valleys.length}, hips ${filtered.hips.length}/${layout.hips.length}`,
);
console.log(
  `ridges=${layout.ridges.length} hips=${layout.hips.length} valleys=${layout.valleys.length} gables=${layout.gableCount} confidence=${layout.confidence}`,
);
if (layout.diag) console.log("diag:", JSON.stringify(layout.diag));
for (const n of layout.notes) console.log(n);

// ── Render ──
const xs = outline.map((p) => p.x);
const ys = outline.map((p) => p.y);
const minX = Math.min(...xs), maxX = Math.max(...xs);
const minY = Math.min(...ys), maxY = Math.max(...ys);
const span = Math.max(maxX - minX, maxY - minY, 1);
const pad = span * 0.1;
const S = 1600 / (span + 2 * pad);
const W = Math.round((maxX - minX + 2 * pad) * S);
const H = Math.round((maxY - minY + 2 * pad) * S) + 60;
const X = (x: number) => ((x - minX + pad) * S).toFixed(1);
const Y = (y: number) => ((y - minY + pad) * S + 60).toFixed(1);

const parts: string[] = [];
parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
parts.push(
  `<text x="16" y="28" font-family="Helvetica" font-size="22" font-weight="bold" fill="#111827">COMPUTED ROOF LAYOUT vs A9 — teal ridge · orange hip · blue valley · red gable end · magenta = sheet's own 45° lines</text>`,
);
for (const s of segs) {
  if (!Array.isArray(s) || s.length < 4) continue;
  parts.push(
    `<line x1="${X(s[0])}" y1="${Y(s[1])}" x2="${X(s[2])}" y2="${Y(s[3])}" stroke="#9ca3af" stroke-width="1" opacity="0.4"/>`,
  );
}
// Sheet's own diagonals (the evidence) — magenta.
for (const d of extractPlanDiagonals(segs, outline)) {
  parts.push(
    `<line x1="${X(d.p1.x)}" y1="${Y(d.p1.y)}" x2="${X(d.p2.x)}" y2="${Y(d.p2.y)}" stroke="#d946ef" stroke-width="7" opacity="0.45"/>`,
  );
}
// Outline ring.
const ring = outline.map((p, i) => `${i ? "L" : "M"}${X(p.x)},${Y(p.y)}`).join(" ");
parts.push(`<path d="${ring} Z" fill="none" stroke="#1e3a8a" stroke-width="5" stroke-linejoin="round"/>`);
// Rake edges — red dashed.
for (const e of edges) {
  if (!RAKE_IDS.has(e.id)) continue;
  parts.push(
    `<line x1="${X(e.p1.x)}" y1="${Y(e.p1.y)}" x2="${X(e.p2.x)}" y2="${Y(e.p2.y)}" stroke="#dc2626" stroke-width="7" stroke-dasharray="14 8"/>`,
  );
}
const drawSegs = (
  segsIn: { p1: { x: number; y: number }; p2: { x: number; y: number } }[],
  stroke: string,
  width: number,
  dash?: string,
) => {
  for (const s of segsIn) {
    parts.push(
      `<line x1="${X(s.p1.x)}" y1="${Y(s.p1.y)}" x2="${X(s.p2.x)}" y2="${Y(s.p2.y)}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
    );
  }
};
drawSegs(layout.ridges, "#0f766e", 6);
drawSegs(layout.hips, "#ea580c", 5);
drawSegs(layout.valleys, "#2563eb", 5, "10 6");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
writeFileSync("scripts/roof-layout.svg", svg);
writeFileSync("scripts/roof-layout.png", await sharp(Buffer.from(svg)).png().toBuffer());
console.log(`wrote scripts/roof-layout.png (${W}x${H})`);
