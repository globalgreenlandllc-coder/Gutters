/**
 * Render what the CANVAS will draw for the latest stored Woodinville row after
 * the perimeter-only diagram changes: A9 vector swap → closure → engine →
 * outer-boundary filter + geometric chip sides + engine interior skeleton +
 * unlabeled gable tents. Mimics aerial-canvas/aerial-shared styling (tactical)
 * so the eyeball check matches the app.
 * Run:  npx tsx scripts/render-woodinville-diagram.mts
 * Writes scripts/woodinville-diagram.svg / .html (gitignored render outputs).
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, writeFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { buildEngineTakeoff } from "../lib/ai/engine-takeoff.ts";
import {
  deriveOrientationFromFaceTitles,
  sideOfPerimeterEdge,
} from "../lib/ai/plan-orientation.ts";
import { readRoofFromVectors } from "../lib/ai/roof-from-vectors.ts";
import { deriveVectorScale } from "../lib/ai/outline-from-vectors.ts";
import { closeVectorPerimeter } from "../lib/ai/reconcile-eaves.ts";
import { segmentsFromOps, selectSegments } from "../lib/ai/pdf-segments.ts";
import { filterRoofDiagramLines } from "../lib/ai/roof-diagram-filter.ts";

type Pt = { x: number; y: number };
const db = new PrismaClient();
const row = await db.planAnalysis.findFirst({
  where: { filename: { contains: "WOODINVILLE" }, status: "SUCCEEDED" },
  orderBy: { createdAt: "desc" },
});
await db.$disconnect();
if (!row) { console.log("no WOODINVILLE PlanAnalysis found"); process.exit(0); }
const analysis = row.analysisJson as any;

// ── A9 vectors FRESH from the PDF (local rows predate the 5-tuple widths;
//    extraction is deterministic, so this matches what production stored) ──
const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const ROOF_PAGE = 11; // A9 roof-framing plan (Stage-1 classifier's pick)
const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const page = await pdf.getPage(ROOF_PAGE);
const content = await page.getTextContent();
const rlabels: { s: string; x: number; y: number }[] = [];
for (const raw of content.items as Array<{ str?: string; transform?: number[] }>) {
  const s = (raw.str ?? "").trim();
  if (!s || s.length > 40) continue;
  const tx = raw.transform ?? [];
  const x = Math.round(Number(tx[4]) || 0);
  const y = Math.round(Number(tx[5]) || 0);
  const isDim = /\d/.test(s) && /['"′″]|\bft\b|\bLF\b|\d\s*[-:]\s*\d|\d\/\d/i.test(s);
  if (!isDim && s.length <= 24 && /[A-Za-z0-9]/.test(s) && rlabels.length < 90) rlabels.push({ s, x, y });
}
const { OPS } = await getResolvedPDFJS();
const opList = await page.getOperatorList();
const rsegs = selectSegments(segmentsFromOps(opList, OPS), true);
console.log(`A9 fresh extraction: ${rsegs.length} segs (tuple ${rsegs[0]?.length}), ${rlabels.length} labels`);

// ── Replicate the estimate-time A9 vector swap (app/actions/estimate.ts) ──
const scaleAnchorText = [analysis.scale?.source, ...(analysis.notes ?? [])]
  .filter(Boolean)
  .join(" | ");
if (!Array.isArray(rsegs) || rsegs.length < 4) {
  console.log("no A9 roof vector segments — extraction failed");
  process.exit(0);
}
const fp0 = analysis.building_footprint ?? [];
let expectedAspect: number | undefined;
if (fp0.length >= 3) {
  const xs = fp0.map((p: Pt) => p.x), ys = fp0.map((p: Pt) => p.y);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  if (w > 0 && h > 0) expectedAspect = Math.max(w, h) / Math.min(w, h);
}
const roof = readRoofFromVectors(rlabels, rsegs, expectedAspect ? { expectedAspect } : undefined);
if (!roof || roof.perimeter.length <= 4 || roof.perimeter.length > 60) {
  console.log("A9 read rejected — nothing to render");
  process.exit(0);
}
const poly: Pt[] = roof.perimeter;
const pbb = roof.bbox;
const aiPts = [
  ...analysis.gutter_runs.flatMap((r: any) => [r.start, r.end]),
  ...(analysis.excluded_edges ?? []).flatMap((e: any) => [e.start, e.end]),
].filter((p: Pt) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;
for (const p of aiPts) { ax0 = Math.min(ax0, p.x); ay0 = Math.min(ay0, p.y); ax1 = Math.max(ax1, p.x); ay1 = Math.max(ay1, p.y); }
const sx = (pbb.x1 - pbb.x0) / Math.max(1e-6, ax1 - ax0);
const sy = (pbb.y1 - pbb.y0) / Math.max(1e-6, ay1 - ay0);
const T = (p: Pt) => ({ x: pbb.x0 + (p.x - ax0) * sx, y: pbb.y0 + (p.y - ay0) * sy });
analysis.building_footprint = poly.map((p) => ({ x: p.x, y: p.y }));
analysis.gutter_runs = analysis.gutter_runs.map((r: any) => ({
  ...r, start: T(r.start), end: T(r.end),
  length_px: Math.hypot(T(r.end).x - T(r.start).x, T(r.end).y - T(r.start).y),
}));
analysis.excluded_edges = (analysis.excluded_edges ?? []).map((e: any) => ({ ...e, start: T(e.start), end: T(e.end) }));
analysis.downspouts = (analysis.downspouts ?? []).map((d: any) => ({ ...d, at: T(d.at) }));
// GABLE-label demotion (nearest run → rake, distance-capped)
const span0 = Math.max(pbb.x1 - pbb.x0, pbb.y1 - pbb.y0);
const cap = 0.15 * span0;
const mid = (p: Pt, q: Pt) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
for (let i = 0; i < poly.length; i++) {
  if (!roof.gableFlags[i]) continue;
  const em = mid(poly[i], poly[(i + 1) % poly.length]);
  let best = -1, bestD = Infinity;
  analysis.gutter_runs.forEach((r: any, ri: number) => {
    const d = Math.hypot(mid(r.start, r.end).x - em.x, mid(r.start, r.end).y - em.y);
    if (d < bestD) { bestD = d; best = ri; }
  });
  if (best >= 0 && bestD <= cap) {
    const r = analysis.gutter_runs[best];
    analysis.gutter_runs.splice(best, 1);
    analysis.excluded_edges = [...(analysis.excluded_edges ?? []), { kind: "rake", start: r.start, end: r.end, reason: "A9 GABLE label" }];
  }
}
const vscale = deriveVectorScale(poly, scaleAnchorText);
if (vscale) {
  analysis.scale = { unit: "pixels", feet_per_unit: vscale.ftPerPt, source: vscale.source };
  analysis.gutter_runs = analysis.gutter_runs.map((r: any) => ({
    ...r,
    length_ft: r.length_px != null && Number.isFinite(r.length_px)
      ? Math.round(r.length_px * vscale.ftPerPt * 10) / 10
      : r.length_ft,
  }));
  console.log(`scale re-anchored: ${vscale.ptPerFt} pt/ft (${vscale.source})`);
}

// ── Orientation + closure + engine (estimate.ts order) ──
const perFace = analysis._perFace?.per_face ?? null;
const orientation = deriveOrientationFromFaceTitles(perFace) ?? analysis._engine?.orientation ?? null;
if (orientation?.note) console.log("orientation:", orientation.note);
const closed = closeVectorPerimeter(analysis, {
  faceNormals: orientation?.normals ?? null,
  perFace,
});
if (closed.reconcileNotes.length > 0) {
  analysis.gutter_runs = closed.analysis.gutter_runs;
  analysis.totals = closed.analysis.totals;
  console.log(`closure: ${closed.reconcileNotes.length} note(s)`);
}
const b = buildEngineTakeoff(analysis, perFace, analysis._engine?.roofMasses ?? [], orientation?.normals ?? null);
if (!b) { console.log("engine returned null"); process.exit(0); }
const takeoff: any = b.takeoff;
console.log(`engine: ${takeoff.masses.length} masses, eave LF ${b.eaveLfFt}`);

// ── Replicate blueprint-to-estimate's DRAW layer (perimeter-only) ──
const outerFp: Pt[] = analysis.building_footprint;
const oxs = outerFp.map((p) => p.x), oys = outerFp.map((p) => p.y);
const span = Math.max(Math.max(...oxs) - Math.min(...oxs), Math.max(...oys) - Math.min(...oys));
const outerBoundaryTol = Math.max(span * 0.02, 2);
const distToSeg = (p: Pt, a: Pt, bq: Pt) => {
  const dx = bq.x - a.x, dy = bq.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
const distToPoly = (p: Pt) => {
  let best = Infinity;
  for (let i = 0; i < outerFp.length; i++) best = Math.min(best, distToSeg(p, outerFp[i], outerFp[(i + 1) % outerFp.length]));
  return best;
};
const onOuter = (e: any) => distToPoly(mid(e.p1, e.p2)) <= outerBoundaryTol;
const allEdges = takeoff.masses.flatMap((m: any) => m.edges);
const eaves = allEdges.filter((e: any) => e.gutter && onOuter(e)).map((e: any) => ({
  ...e, side: sideOfPerimeterEdge(e.p1, e.p2, outerFp),
}));
const rakes = allEdges.filter((e: any) => e.type === "rake" && onOuter(e));
const interior = takeoff.masses.flatMap((m: any) => m.interior);
const skel = interior.filter((e: any) => e.source === "skeleton");
const gable = interior.filter((e: any) => typeof e.source === "string" && e.source.startsWith("gable:"));
const engineDrewSkeleton = skel.length > 0;
const rawInterior = engineDrewSkeleton ? [...skel, ...gable] : gable;
// Same roof-plan invariants the app applies (lib/ai/roof-diagram-filter.ts):
// no crossings, hip/valley length cap, boundary-reachable anchoring.
const asLine = (e: any) => ({ e, points: [e.p1, e.p2] });
const byKind = (k: string) => rawInterior.filter((e: any) => e.type === k).map(asLine);
const filtered = filterRoofDiagramLines(
  { ridges: byKind("ridge"), valleys: byKind("valley"), hips: byKind("hip") },
  outerFp,
);
const drawnInterior = [...filtered.ridges, ...filtered.valleys, ...filtered.hips].map((l) => l.e);
console.log(`diagram filter: ${rawInterior.length} → ${drawnInterior.length} interior lines`);
console.log(`draw: ${eaves.length} eaves, ${rakes.length} rakes, interior ${drawnInterior.length} (skeleton ${skel.length}, gable ${gable.length})`);
const sideLF: Record<string, number> = {};
for (const e of eaves) {
  const lf = Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y) * (vscale?.ftPerPt ?? 1);
  sideLF[e.side ?? "?"] = (sideLF[e.side ?? "?"] ?? 0) + lf;
}
console.log("side LF:", Object.entries(sideLF).map(([s, v]) => `${s}=${Math.round(v)}`).join("  "));

// ── SVG (tactical canvas look) ──
const S = 1000 / span;
const PAD = 90;
const minX = Math.min(...oxs), minY = Math.min(...oys);
const W = (Math.max(...oxs) - minX) * S + PAD * 2;
const H = (Math.max(...oys) - minY) * S + PAD * 2;
const X = (x: number) => (x - minX) * S + PAD;
const Y = (y: number) => (y - minY) * S + PAD;
const parts: string[] = [`<rect width="${W}" height="${H}" fill="#0b1424"/>`];
// grid
for (let gx = 0; gx < W; gx += 56) parts.push(`<line x1="${gx}" y1="0" x2="${gx}" y2="${H}" stroke="rgba(148,163,184,0.07)" stroke-width="1"/>`);
for (let gy = 0; gy < H; gy += 56) parts.push(`<line x1="0" y1="${gy}" x2="${W}" y2="${gy}" stroke="rgba(148,163,184,0.07)" stroke-width="1"/>`);
const pathOf = (pts: Pt[], close: boolean) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ") + (close ? " Z" : "");
// filled roof mass + perimeter
parts.push(`<path d="${pathOf(outerFp, true)}" fill="rgba(148,163,184,0.10)" stroke="none"/>`);
// interior skeleton (aerial-shared styling: ridge light solid, hip sky, valley violet dashed)
const intStyle: Record<string, { c: string; w: number; dash: boolean }> = {
  ridge: { c: "rgba(203,213,225,0.85)", w: 2.4, dash: false },
  hip: { c: "rgba(125,211,252,0.85)", w: 2.6, dash: false },
  valley: { c: "rgba(196,181,253,0.9)", w: 2.6, dash: true },
};
for (const e of drawnInterior) {
  const st = intStyle[e.type];
  if (!st) continue;
  parts.push(`<line x1="${X(e.p1.x).toFixed(1)}" y1="${Y(e.p1.y).toFixed(1)}" x2="${X(e.p2.x).toFixed(1)}" y2="${Y(e.p2.y).toFixed(1)}" stroke="${st.c}" stroke-width="${st.w}" ${st.dash ? 'stroke-dasharray="8 5.5"' : ""} stroke-linecap="round"/>`);
}
parts.push(`<path d="${pathOf(outerFp, true)}" fill="none" stroke="rgba(226,232,240,0.95)" stroke-width="3.4" stroke-linejoin="round"/>`);
// rakes + unlabeled tents
let ccx = 0, ccy = 0;
for (const p of outerFp) { ccx += p.x; ccy += p.y; }
ccx /= outerFp.length; ccy /= outerFp.length;
for (const e of rakes) {
  const a = e.p1, q = e.p2;
  const len = Math.hypot(q.x - a.x, q.y - a.y);
  const mxp = (a.x + q.x) / 2, myp = (a.y + q.y) / 2;
  if (len * S >= 12) {
    let nx = -(q.y - a.y) / len, ny = (q.x - a.x) / len;
    if ((ccx - mxp) * nx + (ccy - myp) * ny < 0) { nx = -nx; ny = -ny; }
    const h = Math.min(len * 0.32, 24 / S);
    const px = mxp + nx * h, py = myp + ny * h;
    parts.push(`<polygon points="${X(a.x).toFixed(1)},${Y(a.y).toFixed(1)} ${X(px).toFixed(1)},${Y(py).toFixed(1)} ${X(q.x).toFixed(1)},${Y(q.y).toFixed(1)}" fill="rgba(148,163,184,0.14)" stroke="rgba(148,163,184,0.55)" stroke-width="1.8" stroke-linejoin="round"/>`);
  }
  parts.push(`<line x1="${X(a.x).toFixed(1)}" y1="${Y(a.y).toFixed(1)}" x2="${X(q.x).toFixed(1)}" y2="${Y(q.y).toFixed(1)}" stroke="#94a3b8" stroke-width="3" stroke-dasharray="9 7.5" stroke-linecap="round" opacity="0.75"/>`);
}
// eaves (teal)
for (const e of eaves) {
  parts.push(`<line x1="${X(e.p1.x).toFixed(1)}" y1="${Y(e.p1.y).toFixed(1)}" x2="${X(e.p2.x).toFixed(1)}" y2="${Y(e.p2.y).toFixed(1)}" stroke="#2dd4bf" stroke-width="4.4" stroke-linecap="round"/>`);
}
// downspouts
for (const d of takeoff.downspouts) parts.push(`<circle cx="${X(d.at.x).toFixed(1)}" cy="${Y(d.at.y).toFixed(1)}" r="6" fill="#f0abfc" stroke="#0b1424" stroke-width="2"/>`);
// orientation chips — length-weighted eave midpoints per side, clamped to bbox edge
const chipFor = (side: string): Pt | null => {
  const ms = eaves.filter((e: any) => e.side === side);
  if (!ms.length) return null;
  let sw = 0, sxx = 0, syy = 0;
  for (const e of ms) {
    const len = Math.hypot(e.p2.x - e.p1.x, e.p2.y - e.p1.y);
    sw += len; sxx += ((e.p1.x + e.p2.x) / 2) * len; syy += ((e.p1.y + e.p2.y) / 2) * len;
  }
  const m = { x: sxx / sw, y: syy / sw };
  if (side === "front") return { x: X(m.x), y: H - PAD + 42 };
  if (side === "back") return { x: X(m.x), y: PAD - 42 };
  if (side === "left") return { x: PAD - 48, y: Y(m.y) };
  return { x: W - PAD + 48, y: Y(m.y) };
};
for (const side of ["front", "back", "left", "right"]) {
  const at = chipFor(side);
  if (!at) { console.log(`chip ${side}: NO EAVES with this side`); continue; }
  const label = side.toUpperCase();
  const cw = label.length * 9.5 + 22;
  parts.push(`<rect x="${(at.x - cw / 2).toFixed(1)}" y="${(at.y - 13).toFixed(1)}" width="${cw}" height="26" rx="6" fill="rgba(2,6,23,0.78)" stroke="rgba(148,163,184,0.45)" stroke-width="1.4"/>`);
  parts.push(`<text x="${at.x.toFixed(1)}" y="${(at.y + 5).toFixed(1)}" font-family="ui-sans-serif,Arial" font-size="14" font-weight="700" letter-spacing="1.5" fill="#e2e8f0" text-anchor="middle">${label}</text>`);
}
parts.push(`<text x="${PAD}" y="34" font-family="ui-sans-serif,Arial" font-size="17" font-weight="700" fill="#e2e8f0">Woodinville — perimeter diagram + engine skeleton (what the canvas will draw)</text>`);
parts.push(`<text x="${PAD}" y="56" font-family="ui-sans-serif,Arial" font-size="12.5" fill="#94a3b8">teal=gutter eave · dashed slate=gable end (tent, no label) · light=ridge · sky=hip · violet dashed=valley · sides from outward normals</text>`);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}">${parts.join("")}</svg>`;
writeFileSync("scripts/woodinville-diagram.svg", svg);
writeFileSync("scripts/woodinville-diagram.html", `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0b1424">${svg}</body>`);
console.log(`wrote scripts/woodinville-diagram.svg (${W.toFixed(0)}x${H.toFixed(0)})`);
