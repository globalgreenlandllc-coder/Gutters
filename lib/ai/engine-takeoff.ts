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
import { runRoofEngine, type MassInput, type RoofTakeoff } from "../roof-engine";
import { cleanRing, isFinitePt, type Pt } from "../roof-skeleton";
import { placeGablesFromFaces } from "./place-gables";
import type { FaceReadingRaw } from "./face-merge";
import type { RoofMassArea } from "./to-masses";

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

/**
 * Build the engine takeoff for a stored analysis. Returns null (⇒ the flag
 * no-ops, current pricing stands) when there is no footprint or no independent
 * scale — the engine can't produce real-feet LF without one. Never throws.
 */
export function buildEngineTakeoff(
  analysis: BlueprintAnalysis,
  perFace?: Record<string, FaceReadingRaw> | null,
  roofMasses?: RoofMassArea[] | null,
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

    // Classify each footprint edge as a guttered eave via gutter_run coverage.
    const gutterSegs = (analysis.gutter_runs ?? [])
      .map((r) => ({ a: r.start as Pt, b: r.end as Pt }))
      .filter((s) => isFinitePt(s.a) && isFinitePt(s.b));
    const eaveTol = Math.max(2, span * 0.02);
    const eaveEdges: number[] = [];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      const covered = gutterSegs.reduce((m, s) => Math.max(m, edgeCoverage(a, b, s, eaveTol)), 0) > 0.5;
      if (covered) eaveEdges.push(i);
    }
    // No footprint edge aligns with a gutter run — the engine can't price this
    // trace. Return null so the flag no-ops rather than showing 0 LF.
    if (eaveEdges.length === 0) return null;

    // Place the per-face gables on the outline (posts/beam ⇒ projecting pop-outs
    // with guttered side eaves + ridges/valleys; the rest flush). Without a
    // per-face read this is empty and the engine draws the perimeter only.
    const placed = placeGablesFromFaces(perFace, outline, 1 / ftPerPx, { roofMasses });

    const massInputs: MassInput[] = [
      { name: "main", outline, statedArea: null, eaveEdges, gables: placed.gables },
    ];
    const takeoff = runRoofEngine(massInputs);
    const eaveLfFt = round1(takeoff.totalEaveLf * ftPerPx);

    return {
      takeoff,
      ftPerPx,
      eaveLfFt,
      outlinePx: outline,
      massInputs,
      placementNotes: placed.notes,
    };
  } catch {
    return null;
  }
}
