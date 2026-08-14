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

// REPLAY OF PRODUCTION RUN 2 (2026-07-10): the classifier applied one global
// truss direction — every horizontal edge eave, every vertical edge rake —
// inverting half the perimeter (front gables priced, guttered sides tented).
// The reconciler corrects it using the per-face elevation reads below (the
// values the production run itself reported: north 3 gables, south 1,
// east/west 1 set-back frame-over each, continuous eaves everywhere).
const SIMULATE_RUN2_INVERSION = true;

const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const { OPS } = await getResolvedPDFJS();
const page = await pdf.getPage(ROOF_PAGE);
const opList = await page.getOperatorList();
// Raster-convention space (y-down like the printed sheet) — same as production.
const vpT = page.getViewport({ scale: 1 }).transform as [number, number, number, number, number, number];
const rawSegs = segmentsFromOps(opList, OPS, vpT);
const segs = selectSegments(rawSegs, true);

const roof = readRoofFromVectors([], segs);
if (!roof || roof.perimeter.length <= 4) {
  console.log("outline rejected");
  process.exit(1);
}
const outline = roof.perimeter;
const edges = outlineEdges(outline);
const { reconcileEdgeClasses } = await import("../lib/ai/reconcile-edge-classes.ts");
const PT_PER_FT = 23.27; // run 2's dimension-line solve

// Run-5 conditions: global inversion PLUS printed GABLE END TRUSS labels
// attached by the vision read to both patio sides (E1/E15) AND both long
// side walls (E5/E11 — run-5 shipped those UNPRICED as label-vs-field
// conflicts; the reconcile recovery must return them to eave off the
// east/west continuous-eave reads).
const LABELED_SIDES = new Set(["E1", "E15"]); // run-8: labels on patio sides only
const rawClasses: EdgeClass[] = edges.map((e) => ({
  id: e.id,
  edge_class: SIMULATE_RUN2_INVERSION ? (e.axis === "h" ? "eave" : "rake") : "eave",
  tier: null,
  feature: null,
  evidence: LABELED_SIDES.has(e.id)
    ? ["gable_end_truss_label"]
    : ["truss_direction"],
}));

// Truss-field arbiter — the sheet's own framing arrays, no AI.
const { deriveTrussField, applyTrussFieldDemotions } = await import(
  "../lib/ai/truss-field.ts"
);
const { selectFieldSegments } = await import("../lib/ai/pdf-segments.ts");
const fieldSegs = selectFieldSegments(rawSegs);
const field = deriveTrussField({
  outline,
  edges,
  segments: fieldSegs,
  ptPerFt: PT_PER_FT,
});
console.log(
  "field verdicts:",
  [...field.entries()].map(([id, v]) => `${id}:${v.verdict[0] === "p" && v.verdict === "parallel" ? "∥" : "⊥"}`).join(" "),
);
const fieldPass = applyTrussFieldDemotions({ classes: rawClasses, field, edges });
for (const n of fieldPass.notes) console.log(n);
const fieldEave = new Set(
  [...field.entries()]
    .filter(([, v]) => v.verdict === "perpendicular")
    .map(([id]) => id),
);

const gable = (kind: string, span_ft: number, position_frac: number, set_back_ft = 0) => ({
  id: kind, kind: kind as never, span_ft, pitch: 6, position_frac,
  eave_condition_guess: "flush" as const, supported_on: "unknown" as const,
  shows_projection_cue: false, set_back_ft, notes: "",
});
const face = (f: string, title: string, gables: ReturnType<typeof gable>[]) => ({
  face: f as never, sheet_title: title, readable: true, unreadable_reason: null,
  gable_count: gables.length, continuous_eave: true, gables,
  projections: [], projection_cues: [], confidence: "high" as const,
});
// Per-face reads as production reported them (positions estimated from the
// elevations: great-room left, entry center, garage right; patio centered on
// the rear; east/west show one frame-over gable each ABOVE the lower eave).
const PER_FACE = {
  // Run-8's actual reads: main claim at u0.35 span 24 (landed on the entry
  // wall), garage gable properly at u0.85 span 20. Three wall-plane gables
  // interrupt the front fascia → NOT continuous.
  north: {
    ...face("north", "FRONT/NORTH ELEVATION", [
      gable("main", 24, 0.35), // strictly inside E10 (great room)
      { ...gable("entry", 10, 0.45), supported_on: "posts" as const }, // E8 stub
      gable("garage", 20, 0.85), // strictly inside E6
    ]),
    continuous_eave: false,
  },
  south: face("south", "REAR/SOUTH ELEVATION", [
    { ...gable("patio", 18, 0.45), supported_on: "posts" as const },
  ]),
  // Run-8's killer: the side faces honestly read STEPPED (continuous false —
  // eave heights change), so the continuous hard gate never fired and the
  // side frame-over gables tented the walls. eave_passes_in_front is the
  // decisive signal: the gable rises BEHIND a running (lower) eave line.
  east: face("east", "LEFT/EAST ELEVATION", [
    { ...gable("main", 16, 0.4), set_back_ft: null as unknown as number, eave_passes_in_front: true } as never,
  ]),
  west: face("west", "RIGHT/WEST ELEVATION", [
    // viewer-u runs the opposite way on the west face: the upper side wall
    // (E3, plan-u 0.16-0.55) reads at viewer-u ~0.6 from this side.
    { ...gable("main", 16, 0.6), set_back_ft: null as unknown as number, eave_passes_in_front: true } as never,
  ]),
};
(PER_FACE.east as { continuous_eave: boolean }).continuous_eave = false;
(PER_FACE.west as { continuous_eave: boolean }).continuous_eave = false;

const rec = reconcileEdgeClasses({
  outline, edges, classes: fieldPass.classes, perFace: PER_FACE, ptPerFt: PT_PER_FT,
  fieldParallel: fieldPass.parallelIds, fieldEave,
});
for (const n of rec.notes) console.log(n);
const classes = rec.classes;
const RAKE_IDS = new Set(classes.filter((c) => c.edge_class === "rake").map((c) => c.id));
console.log(
  `reconciled: rakes=[${[...RAKE_IDS].join(",")}] eaves=${classes.filter((c) => c.edge_class === "eave").length} unknown=${classes.filter((c) => c.edge_class === "unknown").length}`,
);
const eaveLF = edges
  .filter((e) => classes.find((c) => c.id === e.id)?.edge_class === "eave")
  .reduce((s, e) => s + e.lenPt / PT_PER_FT, 0);
console.log(`eave LF at ${PT_PER_FT} pt/ft: ${Math.round(eaveLF)} (run 3 shipped 121; sheet truth ≈ 165)`);

// Takeoff stage — downspout synthesis must fire (run 4 read 0 D.S. marks).
const { buildEdgeTakeoff } = await import("../lib/ai/edge-takeoff.ts");
const takeoff = buildEdgeTakeoff({
  outline, edges, classes, ptPerFt: PT_PER_FT, downspouts: [],
});
console.log(
  `takeoff: ${takeoff.totals.eave_lf} LF, ${takeoff.totals.downspouts} downspout(s), ` +
    `${takeoff.unpricedIds.length} unpriced`,
);
for (const n of takeoff.notes) console.log(n);

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

// Debug: which valleys did the estimate-path filter drop?
{
  const kept = new Set(
    filtered.valleys.map((l) => JSON.stringify(l.points.map((p) => [Math.round(p.x), Math.round(p.y)]))),
  );
  for (const v of layout.valleys) {
    const key = JSON.stringify([v.p1, v.p2].map((p) => [Math.round(p.x), Math.round(p.y)]));
    console.log(`valley ${key} ${kept.has(key) ? "kept" : "DROPPED"}`);
  }
}
