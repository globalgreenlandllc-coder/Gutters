/**
 * engine-takeoff.ts — build the deterministic roof-engine takeoff from a stored
 * BlueprintAnalysis, so it can OPTIONALLY drive the priced result (behind the
 * BLUEPRINT_ENGINE_TAKEOFF flag) instead of the raw gutter_runs sum.
 *
 * What the engine gives the pricing path when enabled:
 *  - eave LF from the footprint's guttered perimeter edges + any PROJECTING
 *    gable's side eaves (LAW 2), in real feet via the independent px→ft scale;
 *  - rule-based downspouts (1 per continuous run + 1 per 40 ft);
 *  - the gate review flags, now attached to the priced result.
 *
 * Correction 2 is why this is safe to flip on: gables default to FLUSH, so the
 * engine NEVER adds side-eave gutter for a projection it can't prove. Today the
 * stored analysis carries no confirmed gable projections, so the engine takeoff
 * equals the guttered perimeter — a clean, rule-based recomputation. The moment
 * a confirmed projecting gable is fed in (enriched reading), its side eaves flow
 * into the priced LF here with no further wiring.
 *
 * PURE (no server-only / DOM) so it is node-testable; blueprint-to-estimate.ts
 * (server-only) imports it.
 */

import type { BlueprintAnalysis } from "./blueprint-from-plans";
import { polyArea, runRoofEngine, type MassInput, type RoofTakeoff } from "../roof-engine";
import { decomposeMasses, matchTierAreas } from "../roof-mass-decompose";
import { cleanRing, isFinitePt, type Pt } from "../roof-skeleton";
import { placeGablesFromFaces } from "./place-gables";
import { isUnanimousHip, type FaceReadingRaw } from "./face-merge";
import type { RoofMassArea } from "./to-masses";
import { DEFAULT_FACE_NORMALS, type FaceNormals } from "./plan-orientation";

export type EngineTakeoffBundle = {
  takeoff: RoofTakeoff;
  /** feet per PDF-pixel used for LF conversion. */
  ftPerPx: number;
  /** total guttered eave length in REAL feet. */
  eaveLfFt: number;
  /** cleaned footprint ring in PDF-pixel space (same space as gutter_runs, so
   *  it projects with the estimate canvas's transform). */
  outlinePx: Pt[];
  massInputs: MassInput[];
  /** Notes from placing per-face gables (schematic-depth warnings, etc.). */
  placementNotes: string[];
};

/** Flag: the engine drives pricing only when BLUEPRINT_ENGINE_TAKEOFF=1 (or an
 *  explicit override is passed). Default OFF — this is opt-in scaffolding. */
export function engineTakeoffEnabled(override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  return process.env.BLUEPRINT_ENGINE_TAKEOFF === "1";
}

/** Flag: DRAW the engine's roof geometry (gables + pop-outs from the 4-face
 *  reads, and the clean straight-skeleton) on the canvas WITHOUT letting it
 *  drive pricing — the "clean diagram, not priced yet" mode. DEFAULT ON: the
 *  engine draw is the standard plan render now; disable only with an explicit
 *  BLUEPRINT_ENGINE_DRAW=0. Pricing always stays on the measured-run path
 *  (buildEngineTakeoff returns null with no footprint/scale → falls back to the
 *  AI trace, so this is safe by construction). */
export function engineDrawEnabled(override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  return process.env.BLUEPRINT_ENGINE_DRAW !== "0";
}

/** Flag: PERIMETER-ONLY render. A gutter takeoff needs the footprint perimeter
 *  + which edges are eaves (gutter) vs rakes (gable end, no gutter) — NOT the
 *  interior roof geometry (hips/ridges/valleys/tier masses), which is decorative,
 *  never priced, and the sole source of the fanned/tangled garbage renders (the
 *  engine skeleton fan, the grid-skeleton fallback, tier over-decomposition).
 *  When ON (DEFAULT) we keep the engine's deterministic per-edge eave/rake
 *  classification but DRAW only the perimeter, color-coded — nothing to fan or
 *  reject. Disable with BLUEPRINT_PERIMETER_ONLY=0 to restore the interior draw. */
export function perimeterOnlyEnabled(override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  return process.env.BLUEPRINT_PERIMETER_ONLY !== "0";
}

/**
 * feet-per-pixel for the CURRENT coordinate space. Derived from the runs' own
 * `length_px / length_ft` (each run carries both, and after any re-spacing the
 * ratio still matches the outline) — self-consistent and immune to the stale/
 * unreliable declared `scale.feet_per_unit`. Falls back to the declared scale,
 * then null.
 */
function ftPerPxOf(analysis: BlueprintAnalysis): number | null {
  const ratios: number[] = [];
  for (const r of analysis?.gutter_runs ?? []) {
    const lf = r.length_ft;
    const lp = r.length_px;
    if (typeof lf === "number" && lf > 0 && typeof lp === "number" && lp > 0) ratios.push(lf / lp);
  }
  if (ratios.length > 0) {
    ratios.sort((a, b) => a - b);
    return ratios[Math.floor(ratios.length / 2)]; // median ft/px
  }
  const s = analysis?.scale;
  if (s && s.unit === "pixels" && typeof s.feet_per_unit === "number" && s.feet_per_unit > 0 && Number.isFinite(s.feet_per_unit))
    return s.feet_per_unit;
  return null;
}

/** Fraction of edge a→b covered by segment s (on-line within tol + overlap). */
function edgeCoverage(a: Pt, b: Pt, s: { a: Pt; b: Pt }, tol: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len <= 0) return 0;
  const ux = dx / len;
  const uy = dy / len;
  const perp = (p: Pt) => Math.abs((p.x - a.x) * -uy + (p.y - a.y) * ux);
  if (perp(s.a) > tol || perp(s.b) > tol) return 0;
  const t = (p: Pt) => ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
  let t0 = t(s.a);
  let t1 = t(s.b);
  if (t0 > t1) [t0, t1] = [t1, t0];
  return Math.max(0, Math.min(1, t1) - Math.max(0, t0));
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

const FACE_NAMES = ["north", "south", "east", "west"] as const;

/** Index of the outline's principal edge on the side facing `n` (roughly
 *  perpendicular to n, furthest out that way), or -1. */
function principalEdgeIndex(poly: Pt[], n: Pt): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= 0) continue;
    if (Math.abs((dx / len) * n.x + (dy / len) * n.y) > 0.5) continue;
    const score = ((a.x + b.x) / 2) * n.x + ((a.y + b.y) / 2) * n.y;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Min distance from a point to a polygon's boundary — used to assign a placed
 *  gable to the tier mass whose eave it sits on after decomposition. */
function minDistToOutline(p: Pt, outline: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Build the engine takeoff for a stored analysis. Returns null (⇒ the flag
 * no-ops, current pricing stands) when there is no footprint or no independent
 * scale — the engine can't produce real-feet LF without one. Never throws.
 */
export function buildEngineTakeoff(
  analysis: BlueprintAnalysis,
  perFace?: Record<string, FaceReadingRaw> | null,
  roofMasses?: RoofMassArea[] | null,
  faceNormals?: FaceNormals | null,
): EngineTakeoffBundle | null {
  try {
    const ftPerPx = ftPerPxOf(analysis);
    if (!ftPerPx) return null;

    const rawFp = (analysis?.building_footprint ?? []).filter(isFinitePt);
    if (rawFp.length < 4) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of rawFp) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const span = Math.max(maxX - minX, maxY - minY);
    if (!(span > 0)) return null;
    const tol = Math.max(2, span * 0.012);
    const outline = cleanRing(rawFp, tol);
    if (outline.length < 4) return null;

    // Eave-vs-rake classification. DEFAULT every perimeter edge to a guttered
    // EAVE, and exclude it only when it's explicitly a RAKE / no-gutter edge
    // (an excluded_edge of kind rake / dormer_rake / eave_no_gutter). A
    // hip-dominant roof gutters its whole perimeter, and the AI's gutter_runs
    // routinely DROP eaves (and never mark the eave that continues BENEATH a
    // cross-gable) — keying off gutter_run coverage under-counted the LF. This
    // matches the spec's "default to including every eave; flag the exceptions".
    // UNANIMOUS HIP: elevations are the gable budget. When every readable
    // face reads a continuous eave line with NO gable, the roof has no gable
    // ends at all — so ignore any rake edges the freehand trace marked. On a
    // vectorless (raster) plan the AI trace mis-tags diagonal hip/ridge
    // strokes as rakes and the draw sprouts phantom gable wings on a plain
    // hip roof (the 1168G-DA BIDSET). Key-agnostic (works for compass OR
    // house-relative perFace keys); needs ≥3 readable faces so a partial read
    // can't force it.
    const unanimousHip = isUnanimousHip(perFace);
    const rakeSegs = unanimousHip
      ? []
      : (analysis.excluded_edges ?? [])
          .filter((e) => e.kind === "rake" || e.kind === "dormer_rake" || e.kind === "eave_no_gutter")
          .map((e) => ({ a: e.start as Pt, b: e.end as Pt }))
          .filter((s) => isFinitePt(s.a) && isFinitePt(s.b));
    const eaveTol = Math.max(2, span * 0.02);
    const eaveEdges: number[] = [];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      const isRake = rakeSegs.reduce((m, s) => Math.max(m, edgeCoverage(a, b, s, eaveTol)), 0) > 0.5;
      if (!isRake) eaveEdges.push(i);
    }

    // A face read as a FULL GABLE END (continuous_eave === false) has NO gutter
    // across it — the roof slopes to the two perpendicular sides, so its
    // footprint edge is a rake. The AI marks the diagonal gable rakes, which
    // don't cover that horizontal edge, so default-eave would wrongly count it;
    // the per-face read is the reliable signal. Drop that edge from the eaves.
    if (perFace) {
      for (const face of FACE_NAMES) {
        const n = faceNormals?.[face] ?? DEFAULT_FACE_NORMALS[face];
        const r = perFace[face];
        if (r && r.readable !== false && r.continuous_eave === false) {
          const idx = principalEdgeIndex(outline, n);
          const pos = idx >= 0 ? eaveEdges.indexOf(idx) : -1;
          if (pos >= 0) eaveEdges.splice(pos, 1);
        }
      }
    }

    // Every edge classified as a rake (degenerate) — nothing to price.
    if (eaveEdges.length === 0) return null;

    // Place the per-face gables on the outline (posts/beam ⇒ projecting pop-outs
    // with guttered side eaves + ridges/valleys; the rest flush). Without a
    // per-face read this is empty and the engine draws the perimeter only.
    const placed = placeGablesFromFaces(perFace, outline, 1 / ftPerPx, { roofMasses, faceNormals });

    // Decompose the footprint into its tier MASSES (main body + garage/porch/
    // patio jogs) so each tier draws its own clean hip, instead of one whole-
    // house straight-skeleton degenerating into a rejected centroid fan (the
    // Woodinville garage-jog bug). decomposeMasses is AREA-preserving and gutter-
    // LF-NEUTRAL, and returns a single "main" mass UNCHANGED whenever it can't
    // split cleanly (noisy trace, non-rectilinear, any doubt) — so this only ever
    // equals or improves the single-mass path, never inflates LF. Each placed
    // gable then rides on whichever tier carries its base eave.
    const massInputs: MassInput[] = decomposeMasses(outline, eaveEdges);
    for (const m of massInputs) m.gables = [];
    for (const g of placed.gables) {
      let best = massInputs[0];
      let bestD = Infinity;
      for (const m of massInputs) {
        const d = minDistToOutline(g.baseCenter, m.outline);
        if (d < bestD) {
          bestD = d;
          best = m;
        }
      }
      (best.gables ??= []).push(g);
    }

    // Per-tier AREA GATE: match each tier to a stated roof-schedule area (UPPER /
    // GARAGE / PATIO …) so the engine validates each mass against the plan
    // instead of leaving it unverified. Only once we've actually split into
    // tiers AND have a schedule — a single "main" mass keeps statedArea null
    // (identical to before), and an unmatched tier stays null (honest
    // no_schedule, never a force-fit label).
    if (massInputs.length > 1 && roofMasses && roofMasses.length) {
      const tierAreasFt2 = massInputs.map((m) => polyArea(m.outline) * ftPerPx * ftPerPx);
      const matched = matchTierAreas(tierAreasFt2, roofMasses);
      massInputs.forEach((m, i) => {
        if (matched[i]) m.statedArea = matched[i]!.areaFt2;
      });
    }
    // The engine runs on the PIXEL outline (so its geometry registers with the
    // canvas). pxPerFt lets its ft-based gates (long-run, reentrant valley, area,
    // downspout spacing) convert pixel lengths → feet, instead of comparing
    // pixels to feet thresholds (the 450 ft edges / 74 downspouts bug).
    const takeoff = runRoofEngine(massInputs, { pxPerFt: 1 / ftPerPx });
    const eaveLfFt = round1(takeoff.totalEaveLf * ftPerPx);

    return {
      takeoff,
      ftPerPx,
      eaveLfFt,
      outlinePx: outline,
      massInputs,
      placementNotes: unanimousHip
        ? [
            ...placed.notes,
            "⚙ All four elevations read a continuous eave with no gable — drawn all-hip; the freehand trace's rake marks were ignored (elevations are the gable budget).",
          ]
        : placed.notes,
    };
  } catch {
    return null;
  }
}
