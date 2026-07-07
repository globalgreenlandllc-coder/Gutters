/**
 * render-woodinville-oriented.mts — END-TO-END check of the whole fix on the
 * REAL plan set: A9 roof outline from the fixed vector walk (the footprint the
 * production swap will now use), per-face reads like the stored 4-face read
 * (north 3 / south 1 / east 1 / west 1, titles FRONT/NORTH etc.), orientation
 * derived from the titles, gables placed with the derived normals, tiers
 * decomposed, engine run — rendered as SVG the way the canvas would draw it.
 * Compare each face against its elevation: front (canvas BOTTOM, = north) 3
 * gables, rear (top) 1 patio gable, west (canvas RIGHT) gable end.
 * Run: npx tsx scripts/render-woodinville-oriented.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { segmentsFromOps, selectSegments } from "../lib/ai/pdf-segments.ts";
import { readRoofFromVectors } from "../lib/ai/roof-from-vectors.ts";
import { deriveOrientationFromFaceTitles } from "../lib/ai/plan-orientation.ts";
import { placeGablesFromFaces } from "../lib/ai/place-gables.ts";
import { decomposeMasses, matchTierAreas } from "../lib/roof-mass-decompose.ts";
import { runRoofEngine, polyArea, type MassInput, type Edge } from "../lib/roof-engine.ts";
import type { FaceReadingRaw, FaceGableRead } from "../lib/ai/face-merge.ts";
import type { Pt } from "../lib/roof-skeleton.ts";

// ── 1. Real A9 roof outline through the production vector path ──────────────
const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const pdf = await getDocumentProxy(new Uint8Array(readFileSync(PDF)));
const page = await pdf.getPage(11);
const { OPS } = await getResolvedPDFJS();
const segs = selectSegments(segmentsFromOps(await page.getOperatorList(), OPS), true);
const roof = readRoofFromVectors([], segs, { expectedAspect: 1.0 });
if (!roof) throw new Error("A9 read rejected — expected it to activate");
const outline: Pt[] = roof.perimeter.map((p) => ({ x: p.x, y: p.y }));
console.log(`A9 outline: ${outline.length} corners`);

// ── 2. Per-face reads as the stored 4-face read shape (with sheet titles) ────
const g = (over: Partial<FaceGableRead>): FaceGableRead => ({
  id: "g",
  kind: "other",
  span_ft: 14,
  pitch: 5,
  position_frac: 0.5,
  eave_condition_guess: "flush",
  supported_on: "wall",
  shows_projection_cue: false,
  notes: "",
  ...over,
});
const face = (over: Partial<FaceReadingRaw>): FaceReadingRaw => ({
  face: "north",
  readable: true,
  unreadable_reason: null,
  gable_count: null,
  continuous_eave: true,
  gables: [],
  projections: [],
  projection_cues: [],
  confidence: "high",
  ...over,
});
const perFace: Record<string, FaceReadingRaw> = {
  north: face({
    face: "north",
    sheet_title: "FRONT/NORTH ELEVATION",
    gables: [
      g({ id: "master gable", kind: "main", span_ft: 16, position_frac: 0.82 }),
      g({ id: "cov. entry", kind: "entry", span_ft: 10, position_frac: 0.5, supported_on: "posts", eave_condition_guess: "projecting" }),
      g({ id: "great room", kind: "main", span_ft: 18, pitch: 6, position_frac: 0.2 }),
    ],
  }),
  south: face({
    face: "south",
    sheet_title: "REAR/SOUTH ELEVATION",
    gables: [g({ id: "cov. patio", kind: "patio", span_ft: 22, position_frac: 0.5, supported_on: "posts", eave_condition_guess: "projecting" })],
    projections: [{ kind: "porch", depth_ft: 7, notes: "" }],
  }),
  east: face({
    face: "east",
    sheet_title: "LEFT/EAST ELEVATION",
    gables: [g({ id: "east gable", kind: "main", span_ft: 14, position_frac: 0.5 })],
    projections: [{ kind: "patio", depth_ft: 12, notes: "" }],
  }),
  west: face({
    face: "west",
    sheet_title: "RIGHT/WEST ELEVATION",
    continuous_eave: false, // gable end — no gutter across that face
    gables: [g({ id: "west gable end", kind: "main", span_ft: 20, position_frac: 0.5 })],
    projections: [{ kind: "porch", depth_ft: 7, notes: "" }],
  }),
};

// ── 3. Orientation from the titles (what estimate.ts now does) ───────────────
const orientation = deriveOrientationFromFaceTitles(perFace);
if (!orientation) throw new Error("expected orientation from titles");
console.log(orientation.note);

// ── 4. Place gables + decompose + engine (mirrors buildEngineTakeoff) ────────
const PX_PER_FT = 18; // 1/4" = 1' plot → 18 pt per ft (placement-only)
const placed = placeGablesFromFaces(perFace, outline, PX_PER_FT, {
  faceNormals: orientation.normals,
  roofMasses: [
    { label: "patio", areaFt2: 228 },
    { label: "porch", areaFt2: 180 },
  ],
});
for (const note of placed.notes) console.log(`  ${note}`);
const eaveEdges = outline.map((_, i) => i);
const masses: MassInput[] = decomposeMasses(outline, eaveEdges);
const matched = matchTierAreas(
  masses.map((m) => polyArea(m.outline) / (PX_PER_FT * PX_PER_FT)),
  [{ label: "upper", areaFt2: 2902 }, { label: "patio", areaFt2: 228 }, { label: "porch", areaFt2: 180 }],
);
masses.forEach((m, i) => {
  m.gables = [];
  if (matched[i]) m.statedArea = matched[i]!.areaFt2;
});
const minDist = (p: Pt, poly: Pt[]): number => {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
};
for (const gb of placed.gables) {
  let best = masses[0], bd = Infinity;
  for (const m of masses) {
    const d = minDist(gb.baseCenter, m.outline);
    if (d < bd) { bd = d; best = m; }
  }
  (best.gables ??= []).push(gb);
}
const takeoff = runRoofEngine(masses, { pxPerFt: PX_PER_FT });
console.log(`tiers: ${takeoff.masses.map((m) => m.name).join(", ")}; eave LF(px): ${takeoff.totalEaveLf.toFixed(0)}`);

// ── 5. SVG render (canvas orientation, y down) ───────────────────────────────
const pts: Pt[] = [];
for (const m of takeoff.masses) {
  for (const e of m.edges) pts.push(e.p1, e.p2);
  for (const e of m.interior) pts.push(e.p1, e.p2);
  for (const p of m.outline) pts.push(p);
}
const minX = Math.min(...pts.map((p) => p.x)), minY = Math.min(...pts.map((p) => p.y));
const maxX = Math.max(...pts.map((p) => p.x)), maxY = Math.max(...pts.map((p) => p.y));
const S = 1100 / (maxX - minX), PAD = 70;
const W = (maxX - minX) * S + PAD * 2, H = (maxY - minY) * S + PAD * 2 + 40;
const X = (x: number) => (x - minX) * S + PAD;
const Y = (y: number) => (y - minY) * S + PAD; // PDF-pixel y-down = canvas y-down
const COL: Record<string, string> = { eave: "#0284c7", rake: "#94a3b8", ridge: "#dc2626", hip: "#0891b2", valley: "#9333ea" };
const parts: string[] = [`<rect width="${W}" height="${H}" fill="#f8fafc"/>`];
const line = (a: Pt, b: Pt, c: string, w: number, dash?: boolean) =>
  `<line x1="${X(a.x).toFixed(1)}" y1="${Y(a.y).toFixed(1)}" x2="${X(b.x).toFixed(1)}" y2="${Y(b.y).toFixed(1)}" stroke="${c}" stroke-width="${w}" ${dash ? 'stroke-dasharray="7 5"' : ""} stroke-linecap="round"/>`;
for (const m of takeoff.masses) for (const e of m.interior) parts.push(line(e.p1, e.p2, COL[e.type] ?? "#000", e.type === "ridge" ? 2.6 : 1.9, e.type === "valley"));
for (const m of takeoff.masses) for (const e of m.edges as Edge[]) parts.push(line(e.p1, e.p2, e.gutter ? COL.eave : COL.rake, e.gutter ? 3.6 : 2.2, !e.gutter));
for (const m of takeoff.masses)
  for (const gb of m.gables ?? [])
    parts.push(
      `<text x="${X(gb.baseCenter.x).toFixed(1)}" y="${(Y(gb.baseCenter.y) + (gb.facing === "S" ? 16 : gb.facing === "N" ? -8 : 0)).toFixed(1)}" font-family="ui-sans-serif" font-size="13" fill="#0f172a" text-anchor="middle">▲ ${gb.name}</text>`,
    );
parts.push(`<text x="${PAD}" y="28" font-family="ui-sans-serif" font-size="15" font-weight="700" fill="#0f172a">Woodinville — A9 vector outline + title-derived orientation (front = NORTH = canvas BOTTOM)</text>`);
parts.push(`<text x="${W - PAD}" y="${H - 14}" font-family="ui-sans-serif" font-size="13" fill="#334155" text-anchor="end">⌂ FRONT (north) — expect: great room · cov. entry · master</text>`);
parts.push(`<text x="${W - PAD}" y="46" font-family="ui-sans-serif" font-size="13" fill="#334155" text-anchor="end">REAR (south) — expect: cov. patio</text>`);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
writeFileSync("scripts/woodinville-oriented.html", `<!doctype html><meta charset="utf-8"><body style="margin:0">${svg}</body>`);
console.log("wrote scripts/woodinville-oriented.html");
