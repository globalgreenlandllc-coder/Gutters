/**
 * Pure trace-quality scoring for the blueprint best-of selection. NO server-only,
 * NO DOM, NO "@/" imports — importable under node/tsx so the validity gate is
 * unit-testable (scoreBlueprintAnalysis in blueprint-from-plans.ts is server-only
 * and can't be imported by the test runner; this holds the testable logic).
 *
 * All three checks are REJECT-IMPLAUSIBLE, never fabricate: they only ever
 * DEMOTE a trace that contradicts the reliable footprint, so a cleaner/fuller
 * trace wins. They never invent or price geometry.
 */

import type { BlueprintAnalysis } from "./blueprint-from-plans";
import type { PlanClassification } from "./classify-plans";
import { polygonCloses, polyArea } from "../roof-engine";
import { cleanRing, isFinitePt, type Pt } from "../roof-skeleton";
import { scheduleAreaFt2, selfConsistentAreaFt2 } from "./to-masses";
import { footprintAxisAlignedFraction } from "./rectify-plan-takeoff";

/** Cleaned footprint ring in pixel space, or [] if it can't form a polygon. */
export function footprintRingPx(a: BlueprintAnalysis): Pt[] {
  const raw = (a.building_footprint ?? []).filter((p) => isFinitePt(p as Pt));
  if (raw.length < 4) return [];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of raw) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(maxX - minX, maxY - minY);
  return cleanRing(raw as Pt[], Math.max(2, span * 0.012));
}

/** Self-consistent feet-per-pixel from the priced runs (median = robust). Null
 *  when no run carries both a pixel length and a real length_ft. */
export function medianFtPerPx(a: BlueprintAnalysis): number | null {
  const rs: number[] = [];
  for (const r of a.gutter_runs ?? []) {
    if (!isFinitePt(r.start as Pt) || !isFinitePt(r.end as Pt)) continue;
    if (r.length_ft == null || !(r.length_ft > 0)) continue;
    const px = Math.hypot(r.end.x - r.start.x, r.end.y - r.start.y);
    if (px > 0) rs.push(r.length_ft / px);
  }
  if (rs.length === 0) return null;
  rs.sort((x, y) => x - y);
  return rs[Math.floor(rs.length / 2)];
}

/** Footprint perimeter in feet, via the trace's own scale. Null if unknowable. */
export function footprintPerimeterFt(
  a: BlueprintAnalysis,
  ring?: Pt[],
): number | null {
  const r = ring ?? footprintRingPx(a);
  if (r.length < 3) return null;
  const ftPerPx = medianFtPerPx(a);
  if (!ftPerPx || ftPerPx <= 0) return null;
  let px = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const q = r[(i + 1) % r.length];
    px += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return px * ftPerPx;
}

/** Sum of priced eave LF (feet) across valid runs. */
export function eaveLfFt(a: BlueprintAnalysis): number {
  return (a.gutter_runs ?? []).reduce(
    (t, r) =>
      t +
      (isFinitePt(r.start as Pt) &&
      isFinitePt(r.end as Pt) &&
      r.length_ft != null &&
      r.length_ft > 0
        ? r.length_ft
        : 0),
    0,
  );
}

/**
 * Total geometry-quality PENALTY (>= 0) to subtract from a trace's best-of
 * score. Three reject-implausible checks:
 *
 *   1. INTEGRITY — a self-intersecting / collapsed footprint is the root of the
 *      centroid-fan skeleton + mis-placed gables. Fatal (short-circuits at 40).
 *   2. STATED-AREA shortfall — the footprint area (measured SCALE-FREE from its
 *      own geometry) falls far under the plan's stated schedule area → a missing
 *      wing/mass. Scale-free, so a mere px→ft mislabel is NOT penalized.
 *   3. PERIMETER-plausibility — the priced eave LF is an implausibly SMALL
 *      fraction (<50%) of the footprint perimeter → an under-trace that dropped
 *      whole eaves (e.g. 120 LF on a 326 ft perimeter = 37%). Only the LOW side
 *      is penalized; over-trace is bounded elsewhere by the envelope clamp, and
 *      the 50% threshold sits below a legitimately gable-dominant roof (~58%).
 *   4. RECTILINEARITY — residential footprints are overwhelmingly rectilinear;
 *      off-axis perimeter beyond a small allowance (clipped corners, a bay) is
 *      almost always trace error, and a diagonal-heavy trace also defeats the
 *      downstream squaring repair. A clean read pays nothing (≤10% off-axis is
 *      free); the 22%-off-axis roll that once shipped diagonal walls on a
 *      fully-orthogonal rambler pays ~12 — enough to lose to a clean sibling.
 *   5. RUN-SCALE DISPERSION — every run's own ft-per-pixel should agree with
 *      the trace's median (one drawing, one scale). LF sitting on runs that
 *      price >30% hotter/colder per pixel than the median is internally
 *      inconsistent (the 1168G gemini roll: one 17 LF run 30% hot, priced
 *      total 44% over its own drawn geometry) — a consistent sibling wins.
 */
export function geometryQualityPenalty(
  a: BlueprintAnalysis,
  classification?: PlanClassification | null,
): number {
  const ring = footprintRingPx(a);
  // 1. integrity — degenerate outline; nothing else matters.
  if (ring.length < 4 || !polygonCloses(ring) || Math.abs(polyArea(ring)) < 1) {
    return 40;
  }
  let pen = 0;

  // 2. scale-free stated-area shortfall.
  if (classification) {
    const stated = scheduleAreaFt2(classification);
    const selfArea = selfConsistentAreaFt2(ring, classification);
    if (stated && stated > 0 && selfArea && selfArea > 0) {
      const dev = Math.abs(selfArea - stated) / stated;
      if (dev > 0.15) pen += Math.min(20, (dev - 0.15) * 40);
    }
  }

  // 3. perimeter-plausibility (under-trace).
  const perimFt = footprintPerimeterFt(a, ring);
  if (perimFt && perimFt > 0) {
    const ratio = eaveLfFt(a) / perimFt;
    if (ratio < 0.5) pen += Math.min(40, (0.5 - ratio) * 250);
  }

  // 4. rectilinearity (diagonal-heavy trace of square geometry).
  const offAxis = 1 - footprintAxisAlignedFraction(ring);
  pen += Math.min(25, Math.max(0, offAxis - 0.1) * 100);

  // 5. run-scale dispersion (runs disagreeing with EACH OTHER on ft/px).
  pen += runScaleDispersionPenalty(a);

  return pen;
}

/**
 * Penalty (>= 0) for internally-inconsistent run scales. Computes each priced
 * run's own ft-per-pixel against the trace's median: the LF-weighted share
 * sitting on runs deviating >30% earns up to 20, and a high LF-weighted mean
 * absolute deviation (drift across the whole read, not one outlier) earns up
 * to 10 more. A single-scale trace pays 0 regardless of its absolute scale —
 * this is dispersion-only, deliberately scale-label-agnostic.
 */
export function runScaleDispersionPenalty(a: BlueprintAnalysis): number {
  const med = medianFtPerPx(a);
  if (!med || med <= 0) return 0;
  let totalLf = 0;
  let outlierLf = 0;
  let weightedDev = 0;
  for (const r of a.gutter_runs ?? []) {
    if (!isFinitePt(r.start as Pt) || !isFinitePt(r.end as Pt)) continue;
    if (r.length_ft == null || !(r.length_ft > 0)) continue;
    const px = Math.hypot(r.end.x - r.start.x, r.end.y - r.start.y);
    if (!(px > 0)) continue;
    const dev = Math.abs((r.length_ft / px) / med - 1);
    totalLf += r.length_ft;
    weightedDev += dev * r.length_ft;
    if (dev > 0.3) outlierLf += r.length_ft;
  }
  if (!(totalLf > 0)) return 0;
  const outlierShare = outlierLf / totalLf;
  const mad = weightedDev / totalLf;
  return (
    Math.min(20, outlierShare * 70) + Math.min(10, Math.max(0, mad - 0.08) * 60)
  );
}
