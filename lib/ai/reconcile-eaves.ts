/**
 * Deterministic eave closure + symmetry reconcile pass.
 *
 * THE BUG THIS FIXES: the AI emits the building outline (building_footprint)
 * and the gutters (gutter_runs) as two SEPARATE freehand outputs. The
 * footprint is reliable and symmetric, but the gutters are not — the model
 * routinely guttters the eave between the two FRONT gables (a covered porch)
 * and silently drops the mirror-image eave between the two REAR gables (a
 * covered patio). `<perimeter_closure>` told the model to cover every wall,
 * but nothing ever ENFORCED that in code — so a dropped eave just vanished.
 *
 * This pass closes that gap deterministically, AFTER the AI returns:
 *   1. Walk the footprint polygon's exterior edges.
 *   2. An edge is UNCLASSIFIED when it's covered by NEITHER a gutter_run NOR
 *      an excluded_edge (rake/ridge/hip/valley/eave_no_gutter). That's a wall
 *      the AI said nothing about — the silent drop.
 *   3. For each unclassified edge, look for a SYMMETRIC TWIN: the mirror of
 *      this edge across the footprint centroid that IS covered by a gutter.
 *      If found, the dropped edge almost certainly carries the same eave —
 *      synthesize a gutter_run for it, COPYING the twin's measured length_ft
 *      (never measuring raw pixels — that keeps pricing exact and scale-safe).
 *   4. Unclassified edges with no symmetric confirmation are NOT priced — they
 *      get a loud review note instead (a visible warning replaces a silent
 *      miss). We never fabricate a priced gutter on a guess.
 *
 * Design rules (mirror deriveRoofSkeleton):
 *   - PURE + directive-free (no "server-only", no DOM, no React) so it runs in
 *     the browser bundle AND under `node`/`tsx` for tests.
 *   - NEVER throws — any error returns the input analysis unchanged, so a bug
 *     in this pass can never break a takeoff (worst case = today's behavior).
 *   - Operates in raw PDF-pixel space (the same space as gutter_runs.start/end
 *     and building_footprint) so no projection/scale is invented here.
 */

import type {
  BlueprintAnalysis,
  BlueprintPoint,
  BlueprintRun,
} from "./blueprint-from-plans";
import { cleanRing, isFinitePt, type Pt } from "../roof-skeleton";

type Edge = {
  a: Pt;
  b: Pt;
  mid: Pt;
  len: number;
  /** Unit direction a->b. */
  ux: number;
  uy: number;
};

type Seg = { a: Pt; b: Pt };

function asPt(p: BlueprintPoint | undefined | null): Pt | null {
  return isFinitePt(p as Pt) ? { x: p!.x, y: p!.y } : null;
}

function makeEdge(a: Pt, b: Pt): Edge | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len <= 0) return null;
  return { a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, len, ux: dx / len, uy: dy / len };
}

/** Are two directions parallel (or anti-parallel) within ~10°? */
function isParallel(e: Edge, s: Seg): boolean {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const l = Math.hypot(dx, dy);
  if (l <= 0) return false;
  const cross = Math.abs(e.ux * (dy / l) - e.uy * (dx / l));
  return cross < 0.18; // sin(~10.4°)
}

/**
 * Fraction of edge `e` that segment `s` overlaps: `s` must lie ON the edge's
 * line (both endpoints within `tol` perpendicular distance) and its parametric
 * span along the edge intersects [0,1]. Returns 0 when off-line or disjoint.
 */
function overlapFraction(e: Edge, s: Seg, tol: number): number {
  // Perpendicular distance of each seg endpoint from the edge's infinite line.
  const perp = (p: Pt) => Math.abs((p.x - e.a.x) * -e.uy + (p.y - e.a.y) * e.ux);
  if (perp(s.a) > tol || perp(s.b) > tol) return 0;
  // Parametric positions along the edge (0 at a, len at b), normalized.
  const t = (p: Pt) => ((p.x - e.a.x) * e.ux + (p.y - e.a.y) * e.uy) / e.len;
  let t0 = t(s.a);
  let t1 = t(s.b);
  if (t0 > t1) [t0, t1] = [t1, t0];
  const lo = Math.max(0, t0);
  const hi = Math.min(1, t1);
  return Math.max(0, hi - lo);
}

/** Total covered fraction of an edge across many segments (merged intervals). */
function coveredFraction(e: Edge, segs: Seg[], tol: number): number {
  const ivals: [number, number][] = [];
  const t = (p: Pt) => ((p.x - e.a.x) * e.ux + (p.y - e.a.y) * e.uy) / e.len;
  for (const s of segs) {
    if (overlapFraction(e, s, tol) <= 0) continue;
    let t0 = t(s.a);
    let t1 = t(s.b);
    if (t0 > t1) [t0, t1] = [t1, t0];
    ivals.push([Math.max(0, t0), Math.min(1, t1)]);
  }
  if (ivals.length === 0) return 0;
  ivals.sort((p, q) => p[0] - q[0]);
  let total = 0;
  let curLo = ivals[0][0];
  let curHi = ivals[0][1];
  for (let i = 1; i < ivals.length; i++) {
    const [lo, hi] = ivals[i];
    if (lo <= curHi) curHi = Math.max(curHi, hi);
    else {
      total += curHi - curLo;
      curLo = lo;
      curHi = hi;
    }
  }
  total += curHi - curLo;
  return total;
}

/** Reflect a point across the centroid on the chosen axis. */
function reflect(p: Pt, c: Pt, axis: "x" | "y" | "both"): Pt {
  return {
    x: axis === "x" || axis === "both" ? 2 * c.x - p.x : p.x,
    y: axis === "y" || axis === "both" ? 2 * c.y - p.y : p.y,
  };
}

type Side = BlueprintRun["side"];
function mirrorSide(side: Side, axis: "x" | "y" | "both"): Side {
  const flipX = (s: Side): Side => (s === "left" ? "right" : s === "right" ? "left" : s);
  const flipY = (s: Side): Side => (s === "front" ? "back" : s === "back" ? "front" : s);
  if (axis === "x") return flipX(side);
  if (axis === "y") return flipY(side);
  return flipY(flipX(side));
}

export type ReconcileResult = {
  analysis: BlueprintAnalysis;
  reconcileNotes: string[];
};

/**
 * Close the gutter coverage of a blueprint analysis against its own footprint.
 * Adds a gutter_run for any silently-dropped eave that a symmetric twin
 * confirms; flags the rest. Pure + never throws.
 */
export function reconcileEaves(analysis: BlueprintAnalysis): ReconcileResult {
  const notes: string[] = [];
  try {
    const rawPoly = (analysis?.building_footprint ?? [])
      .map(asPt)
      .filter((p): p is Pt => p !== null);
    if (rawPoly.length < 4) return { analysis, reconcileNotes: notes };

    // Bounding span -> tolerances. SMALLER snap tol than the skeleton's 3%
    // so a shallow recess (a porch set back only a few feet) survives.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of rawPoly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const span = Math.max(maxX - minX, maxY - minY);
    if (!Number.isFinite(span) || span <= 0) return { analysis, reconcileNotes: notes };
    const tol = Math.max(2, span * 0.012);
    const posTol = Math.max(tol * 2, span * 0.04);

    const ring = cleanRing(rawPoly, tol);
    if (ring.length < 4) return { analysis, reconcileNotes: notes };
    const centroid = {
      x: ring.reduce((s, p) => s + p.x, 0) / ring.length,
      y: ring.reduce((s, p) => s + p.y, 0) / ring.length,
    };

    // Footprint edges (skip degenerate slivers).
    const edges: Edge[] = [];
    for (let i = 0; i < ring.length; i++) {
      const e = makeEdge(ring[i], ring[(i + 1) % ring.length]);
      if (e && e.len > tol) edges.push(e);
    }
    if (edges.length === 0) return { analysis, reconcileNotes: notes };

    const gutterSegs: Seg[] = (analysis.gutter_runs ?? [])
      .map((r) => ({ a: asPt(r.start), b: asPt(r.end) }))
      .filter((s): s is Seg => s.a !== null && s.b !== null);
    const exclusionSegs: Seg[] = (analysis.excluded_edges ?? [])
      .map((x) => ({ a: asPt(x.start), b: asPt(x.end) }))
      .filter((s): s is Seg => s.a !== null && s.b !== null);

    const COVER = 0.5; // an edge counts as addressed at >50% coverage
    const isGuttered = (e: Edge) => coveredFraction(e, gutterSegs, tol) > COVER;
    const isExcluded = (e: Edge) => coveredFraction(e, exclusionSegs, tol) > COVER;

    const newRuns: BlueprintRun[] = [];
    let flagged = 0;

    for (const e of edges) {
      if (isGuttered(e) || isExcluded(e)) continue; // classified — leave it

      // Unclassified wall. Hunt for a symmetric twin that IS guttered.
      let twin: { run: BlueprintRun; axis: "x" | "y" | "both"; lenFt: number } | null =
        null;
      for (const axis of ["y", "x", "both"] as const) {
        const rMid = reflect(e.mid, centroid, axis);
        // The twin is the guttered run whose body mirrors this edge: nearest
        // midpoint to the reflected point, parallel, similar length, priced.
        let best: { run: BlueprintRun; dist: number } | null = null;
        for (const r of analysis.gutter_runs ?? []) {
          const a = asPt(r.start);
          const b = asPt(r.end);
          if (!a || !b) continue;
          if (r.length_ft == null || !(r.length_ft > 0)) continue;
          const seg = { a, b };
          const segMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const segLen = Math.hypot(b.x - a.x, b.y - a.y);
          const d = Math.hypot(segMid.x - rMid.x, segMid.y - rMid.y);
          if (d > posTol) continue;
          if (!isParallel(e, seg)) continue;
          if (Math.abs(segLen - e.len) > Math.max(tol * 2, e.len * 0.15)) continue;
          if (!best || d < best.dist) best = { run: r, dist: d };
        }
        if (best) {
          twin = { run: best.run, axis, lenFt: best.run.length_ft as number };
          break;
        }
      }

      if (twin) {
        const id = `recon-${newRuns.length + 1}-${Math.round(e.mid.x)}-${Math.round(e.mid.y)}`;
        newRuns.push({
          id,
          side: mirrorSide(twin.run.side, twin.axis),
          start: { x: e.a.x, y: e.a.y },
          end: { x: e.b.x, y: e.b.y },
          length_ft: twin.lenFt,
          length_px: e.len,
          drains_to: [],
          tier: twin.run.tier ?? "unknown",
        });
        notes.push(
          `Auto-added a ${twin.lenFt} ft eave on the ${mirrorSide(twin.run.side, twin.axis)} side: the footprint shows this exterior wall but no gutter was placed on it, and its symmetric ${twin.run.side}-side twin IS guttered (likely a dropped between-gables / porch-patio eave). Field-verify.`,
        );
      } else {
        flagged++;
      }
    }

    if (newRuns.length === 0 && flagged === 0) {
      return { analysis, reconcileNotes: notes };
    }

    let next: BlueprintAnalysis = analysis;
    if (newRuns.length > 0) {
      const gutter_runs = [...analysis.gutter_runs, ...newRuns];
      // Recompute the priced total only when it was a real number to begin
      // with (don't fabricate a number where the AI returned null).
      const prevTotal = analysis.totals?.linear_feet_gutter;
      const addedFt = newRuns.reduce((s, r) => s + (r.length_ft ?? 0), 0);
      const totals =
        prevTotal != null && Number.isFinite(prevTotal)
          ? { ...analysis.totals, linear_feet_gutter: Math.round((prevTotal + addedFt) * 10) / 10 }
          : analysis.totals;
      next = { ...analysis, gutter_runs, totals };
    }

    if (flagged > 0) {
      notes.push(
        `Closure check: ${flagged} exterior wall(s) on the footprint have no gutter and no rake/ridge classification, and no symmetric guttered twin to confirm an eave. Not priced — review whether these are missed eaves or unmarked gable rakes.`,
      );
    }

    return { analysis: next, reconcileNotes: notes };
  } catch {
    // Fail-safe: never break a takeoff over a reconcile bug.
    return { analysis, reconcileNotes: notes };
  }
}
