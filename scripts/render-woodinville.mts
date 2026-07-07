/**
 * render-woodinville.mts — draw the Woodinville roof (D.A. HOMES M4415A3F-6R)
 * with the REAL committed engine, from the FULL plan set.
 * Footprint traced from A4 (foundation) / A6 (main floor); roof schedule from
 * A2.1 (roof ventilation); gable/eave reads from A11-A12 (elevations) + A9 (roof
 * framing). Approximate (raster trace, not the vector layer) but plan-grounded.
 *   - main body + GARAGE wing on the east  → Stage-2 decomposition into 2 tiers
 *   - covered REAR PATIO gable on posts (creates the "MAIN VALLEY" on A9)
 *   - covered ENTRY porch gable on posts
 *   - a flush FRONT gable                  → Stage-1 ridge+valley
 *   - roof schedule UPPER 2902 / PATIO 228 / PORCH 180 sf → per-tier area gate
 * Run: npx tsx scripts/render-woodinville.mts
 */
import { runRoofEngine, polyArea, type Gable, type MassInput, type Edge } from "../lib/roof-engine.ts";
import { decomposeMasses, matchTierAreas } from "../lib/roof-mass-decompose.ts";
import { writeFileSync } from "node:fs";

type Pt = { x: number; y: number };

// Footprint in FEET (x = east, y = south → north is UP in the drawing).
// Main body 64×40 + garage wing 24×32 on the SE (≈768 sf), stepped so the
// garage projects past the main south wall (SE corner), like A6.
const outline: Pt[] = [
  { x: 0, y: 0 },
  { x: 64, y: 0 },
  { x: 64, y: 12 }, // step in to the garage's north wall
  { x: 88, y: 12 },
  { x: 88, y: 44 }, // garage east wall (projects deeper than the main body)
  { x: 64, y: 44 },
  { x: 64, y: 40 }, // step back to the main south wall
  { x: 0, y: 40 },
];
// Gable ends (rakes): the WEST wall (edge 7) is the main 4:12 gable end from the
// RIGHT/WEST elevation. Everything else is a guttered eave ("continuous gutters
// @ all eaves", elevation note 7).
const eaveEdges = [0, 1, 2, 3, 4, 5, 6];

const gables: Gable[] = [
  // Covered REAR PATIO — projecting, on posts (A9 gable-end truss + 8x8 posts).
  { baseCenter: { x: 32, y: 0 }, span: 22, pitch: 4, projection: 12, facing: "N", name: "cov. patio", eaveCondition: "projecting", supportedOn: "posts" },
  // Covered ENTRY porch — projecting, on posts.
  { baseCenter: { x: 14, y: 40 }, span: 12, pitch: 4, projection: 8, facing: "S", name: "cov. entry", eaveCondition: "projecting", supportedOn: "posts" },
  // Front cross-gable — flush (Stage-1 ridge+valley).
  { baseCenter: { x: 50, y: 0 }, span: 16, pitch: 6, projection: 0, facing: "N", name: "front gable (flush)" },
];

// A2.1 roof-ventilation schedule (note: NO garage-roof entry, so the garage
// tier correctly gets `no_schedule`).
const roofMasses = [
  { label: "upper", areaFt2: 2902 },
  { label: "patio", areaFt2: 228 },
  { label: "porch", areaFt2: 180 },
];

const minDist = (p: Pt, poly: Pt[]): number => {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
};

// Stage 2: decompose into tiers; assign the roof-schedule area to each tier;
// ride each gable on its nearest tier.
const masses: MassInput[] = decomposeMasses(outline, eaveEdges);
const matched = matchTierAreas(masses.map((m) => polyArea(m.outline)), roofMasses);
masses.forEach((m, i) => {
  m.gables = [];
  if (matched[i]) m.statedArea = matched[i]!.areaFt2;
});
for (const g of gables) {
  let best = masses[0];
  let bd = Infinity;
  for (const m of masses) {
    const d = minDist(g.baseCenter, m.outline);
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  (best.gables ??= []).push(g);
}

const takeoff = runRoofEngine(masses);
console.log(`tiers: ${takeoff.masses.map((m) => `${m.name}(${polyArea(m.outline).toFixed(0)} sf)`).join(", ")}`);
console.log(`total eave LF: ${takeoff.totalEaveLf} ft; downspouts: ${takeoff.downspouts.length}`);
for (const f of takeoff.reviewFlags) console.log(`  [${f.severity}] ${f.code}: ${f.message.slice(0, 110)}`);

// ── SVG render ─────────────────────────────────────────────────────────────
const S = 10;
const PAD = 64;
const pts: Pt[] = [];
for (const m of takeoff.masses) {
  for (const e of m.edges) pts.push(e.p1, e.p2);
  for (const e of m.interior) pts.push(e.p1, e.p2);
  for (const p of m.outline) pts.push(p);
}
for (const d of takeoff.downspouts) pts.push(d.at);
const minX = Math.min(...pts.map((p) => p.x));
const minY = Math.min(...pts.map((p) => p.y));
const maxX = Math.max(...pts.map((p) => p.x));
const maxY = Math.max(...pts.map((p) => p.y));
const W = (maxX - minX) * S + PAD * 2;
const H = (maxY - minY) * S + PAD * 2 + 96;
const X = (x: number) => (x - minX) * S + PAD;
const Y = (y: number) => (y - minY) * S + PAD;

const COL: Record<string, string> = { eave: "#0284c7", rake: "#94a3b8", ridge: "#dc2626", hip: "#0891b2", valley: "#9333ea" };
const parts: string[] = [`<rect width="${W}" height="${H}" fill="#f8fafc"/>`];
const fills = ["rgba(59,130,246,0.08)", "rgba(16,185,129,0.10)"];
takeoff.masses.forEach((m, i) => {
  const d = m.outline.map((p, j) => `${j ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ") + " Z";
  parts.push(`<path d="${d}" fill="${fills[i % fills.length]}" stroke="none"/>`);
});
const line = (a: Pt, b: Pt, c: string, w: number, dash?: boolean) =>
  `<line x1="${X(a.x).toFixed(1)}" y1="${Y(a.y).toFixed(1)}" x2="${X(b.x).toFixed(1)}" y2="${Y(b.y).toFixed(1)}" stroke="${c}" stroke-width="${w}" ${dash ? 'stroke-dasharray="7 5"' : ""} stroke-linecap="round"/>`;
for (const m of takeoff.masses) for (const e of m.interior) parts.push(line(e.p1, e.p2, COL[e.type] ?? "#000", e.type === "ridge" ? 2.6 : 1.9, e.type === "valley"));
for (const m of takeoff.masses) for (const e of m.edges as Edge[]) parts.push(line(e.p1, e.p2, e.gutter ? COL.eave : COL.rake, e.gutter ? 3.6 : 2.2, !e.gutter));
for (const d of takeoff.downspouts) parts.push(`<circle cx="${X(d.at.x).toFixed(1)}" cy="${Y(d.at.y).toFixed(1)}" r="5" fill="#0f172a"/>`);
for (const m of takeoff.masses)
  for (const g of m.gables ?? [])
    parts.push(
      `<text x="${X(g.baseCenter.x).toFixed(1)}" y="${(Y(g.baseCenter.y) + (g.facing === "N" ? 15 : -9)).toFixed(1)}" font-family="ui-sans-serif,Arial" font-size="12" fill="#334155" text-anchor="middle">▲ ${g.name}</text>`,
    );
// tier labels at centroids
takeoff.masses.forEach((m) => {
  let cx = 0, cy = 0;
  for (const p of m.outline) { cx += p.x; cy += p.y; }
  cx /= m.outline.length; cy /= m.outline.length;
  parts.push(`<text x="${X(cx).toFixed(1)}" y="${Y(cy).toFixed(1)}" font-family="ui-sans-serif,Arial" font-size="13" font-weight="700" fill="#1e293b" text-anchor="middle" opacity="0.55">${m.name}${m.statedArea ? ` · ${m.statedArea} sf` : ""}</text>`);
});
parts.push(`<text x="${PAD}" y="30" font-family="ui-sans-serif,Arial" font-size="16" font-weight="700" fill="#0f172a">Engine roof — D.A. Homes Woodinville M4415A3F-6R</text>`);
parts.push(`<text x="${PAD}" y="48" font-family="ui-sans-serif,Arial" font-size="12" fill="#64748b">footprint from A4/A6 · roof schedule from A2.1 · reads from A9/A11-A12 · drawn by lib/roof-engine + roof-mass-decompose</text>`);
parts.push(`<text x="${W - PAD}" y="30" font-family="ui-sans-serif,Arial" font-size="13" fill="#64748b" text-anchor="end">N ↑  (E →)</text>`);
const legend: [string, string][] = [["eave (gutter)", COL.eave], ["rake / gable end", COL.rake], ["ridge", COL.ridge], ["hip", COL.hip], ["valley", COL.valley], ["downspout ●", "#0f172a"]];
let lx = PAD;
const ly = H - 44;
for (const [label, c] of legend) {
  parts.push(`<line x1="${lx}" y1="${ly}" x2="${lx + 28}" y2="${ly}" stroke="${c}" stroke-width="3.6" stroke-linecap="round"/>`);
  parts.push(`<text x="${lx + 34}" y="${ly + 4}" font-family="ui-sans-serif,Arial" font-size="12.5" fill="#334155">${label}</text>`);
  lx += 34 + label.length * 7.2 + 26;
}
parts.push(`<text x="${PAD}" y="${H - 16}" font-family="ui-sans-serif,Arial" font-size="12" fill="#64748b">${takeoff.masses.length} tiers · ${takeoff.totalEaveLf} eave LF · ${takeoff.downspouts.length} downspouts · gables draw ridge+valleys (Stage 1), garage splits to its own tier (Stage 2)</text>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
writeFileSync("scripts/woodinville-engine.svg", svg);
writeFileSync("scripts/woodinville-engine.html", `<!doctype html><meta charset="utf-8"><body style="margin:0">${svg}</body>`);
console.log(`\nwrote scripts/woodinville-engine.svg (${W}×${H})`);
