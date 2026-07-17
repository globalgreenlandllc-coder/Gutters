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
import type { FaceNormals } from "./plan-orientation";
import { resolveFaceSlots } from "./place-gables";

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

/**
 * Complement of coveredFraction: the UNCOVERED [t0,t1] intervals of edge `e`
 * (0..1 along it) after merging every overlapping segment's projection. A
 * wall the runs only cover at its corners returns its mid-wall GAP — the
 * span the binary >50% coverage test used to swallow whole (runs covering
 * 60% of a rear wall hid a ~17 ft unguttered middle on a fully-hipped roof).
 */
function uncoveredIntervals(e: Edge, segs: Seg[], tol: number): [number, number][] {
  const ivals: [number, number][] = [];
  const t = (p: Pt) => ((p.x - e.a.x) * e.ux + (p.y - e.a.y) * e.uy) / e.len;
  for (const s of segs) {
    if (overlapFraction(e, s, tol) <= 0) continue;
    let t0 = t(s.a);
    let t1 = t(s.b);
    if (t0 > t1) [t0, t1] = [t1, t0];
    ivals.push([Math.max(0, t0), Math.min(1, t1)]);
  }
  ivals.sort((p, q) => p[0] - q[0]);
  const gaps: [number, number][] = [];
  let cursor = 0;
  for (const [lo, hi] of ivals) {
    if (lo > cursor) gaps.push([cursor, lo]);
    cursor = Math.max(cursor, hi);
  }
  if (cursor < 1) gaps.push([cursor, 1]);
  return gaps;
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
  /** Uncovered wall spans the closure could NOT price (the trace-hip cap
   *  tripped — the runs and the ring disagree on total LF). Surfaced as
   *  unpriced tap-to-add suggestions instead of being silently dropped.
   *  Absent on every path that priced (or found) nothing. */
  suggestedRuns?: {
    start: { x: number; y: number };
    end: { x: number; y: number };
    lengthFt: number;
  }[];
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

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * The minimal slice of a FaceReadingRaw the closure consumes. Widened (from
 * `{ readable, continuous_eave }`) so the ELEVATION-EAVE-WINS restoration can
 * see the gable info — the runtime objects every caller passes are full
 * FaceReadingRaw, so no call-site change is needed; legacy objects without
 * gable fields simply never qualify for restoration (today's behavior).
 */
type ClosureFaceRead = {
  readable?: boolean;
  continuous_eave?: boolean;
  gable_count?: number | null;
  gables?: readonly ({ is_hip_end?: boolean | null } | null | undefined)[] | null;
  roof_form?: string | null;
};

/**
 * ELEVATION-EAVE-WINS gate: does this face read UNAMBIGUOUSLY say
 * "one continuous eave, ZERO gables"? Only such a read may override the
 * trace's rake claims on its wall (a face with no gable end has an eave on
 * that wall — a rake there is a hallucination). Mirrors explainUnanimousHip's
 * hip-end discounting (an `is_hip_end:true` entry is a hip recorded through
 * the gable channel, not a gable) so the two hip features stay consistent.
 *
 *  - a face reading ANY gable NEVER qualifies (suppression semantics intact);
 *  - unreadable / missing faces never qualify;
 *  - roof_form "gabled"/"mixed" vetoes even with an empty gables array;
 *  - an EXPLICIT zero is required (gables: [] or gable_count: 0) — legacy
 *    reads without gable info degrade to today's no-restoration behavior.
 */
function readsZeroGableContinuousEave(r: ClosureFaceRead | undefined | null): boolean {
  if (!r || r.readable === false) return false;
  if (r.continuous_eave !== true) return false;
  if (r.roof_form === "gabled" || r.roof_form === "mixed") return false;
  const entries = Array.isArray(r.gables)
    ? r.gables.filter((g): g is NonNullable<typeof g> => !!g && typeof g === "object")
    : null;
  const hipEnds = entries ? entries.filter((g) => g.is_hip_end === true).length : 0;
  const listed = entries ? entries.length - hipEnds : null;
  const counted =
    typeof r.gable_count === "number" ? Math.max(0, r.gable_count - hipEnds) : null;
  if ((listed ?? 0) > 0 || (counted ?? 0) > 0) return false;
  return listed === 0 || counted === 0;
}

/**
 * VECTOR-footprint closure — a stronger pass than reconcileEaves, valid ONLY
 * when building_footprint is the plan's own vector outline (the estimate-time
 * A9/A4 swap applied), not an AI freehand trace.
 *
 * reconcileEaves refuses to price an unclassified wall without a symmetric
 * guttered twin, because on a freehand trace an unmatched edge may simply be
 * mis-drawn. A vector outline changes the evidence: every edge IS a real roof/
 * wall edge from the CAD linework, and residential sets default to
 * "CONTINUOUS GUTTERS & DOWNSPOUTS @ ALL EAVES, TYP." — so an exterior edge
 * with no gutter run and no rake/ridge classification is a missed EAVE, not
 * a guess (Woodinville: the AI traced 7 runs = 189 LF on a ~240 LF perimeter,
 * leaving 6 walls silently unpriced).
 *
 * Rules:
 *  - length_ft = edge px × the median ft/px of the AI's own runs (their
 *    printed-dimension lengths ÷ remapped pixels — cross-validated scale);
 *  - a face read as a FULL GABLE END (continuous_eave === false) keeps its
 *    principal edge unguttered (same rule as the engine), respecting the
 *    derived compass orientation;
 *  - ELEVATION-EAVE-WINS (the inverse): a face read as readable + one
 *    CONTINUOUS eave + ZERO gables overrides the trace's rake claims on its
 *    principal edge — the rake is a hallucination there, so those exclusions
 *    are dropped from the covered set and the wall prices as eave (or, past
 *    the trace-hip cap, surfaces as a tap-to-add suggestion). Loud note;
 *    deep-notch excludeEdges always keep winning;
 *  - sub-2-ft slivers are skipped;
 *  - everything added is flagged loudly for review.
 * Pure + never throws.
 */
export function closeVectorPerimeter(
  analysis: BlueprintAnalysis,
  opts?: {
    faceNormals?: FaceNormals | null;
    perFace?: Record<string, ClosureFaceRead | undefined> | null;
    /** "vector": the footprint is the plan's own CAD outline (default — the
     *  original behavior). "trace-hip": the footprint is a squared AI trace on
     *  a raster plan, allowed ONLY because the caller verified the elevations
     *  are UNANIMOUSLY hip (isUnanimousHip) — a hip roof carries an eave on
     *  every exterior wall, so "unmarked gable rake" is ruled out. Trace mode
     *  additionally caps the closed total at the footprint's own perimeter
     *  (+10%), since a freehand ring is less trustworthy than CAD linework. */
    mode?: "vector" | "trace-hip";
    /** Ring legs the closure must NEVER auto-price — the deep-notch audit's
     *  suspect pocket edges (auditNotches): a carved pocket the elevations
     *  don't support would otherwise be BILLED as upper eave by the trace-hip
     *  closure (the 1168G phantom front-right notch). Skipped legs are
     *  counted and noted UNPRICED. Absent/empty → byte-identical behavior. */
    excludeEdges?: readonly { a: { x: number; y: number }; b: { x: number; y: number } }[] | null;
  },
): ReconcileResult {
  const notes: string[] = [];
  const mode = opts?.mode ?? "vector";
  try {
    const rawPoly = (analysis?.building_footprint ?? [])
      .map(asPt)
      .filter((p): p is Pt => p !== null);
    if (rawPoly.length < 4) return { analysis, reconcileNotes: notes };

    // Independent scale: median ft/px over the AI's measured runs.
    const ratios: number[] = [];
    for (const r of analysis.gutter_runs ?? []) {
      if (typeof r.length_ft === "number" && r.length_ft > 0 && typeof r.length_px === "number" && r.length_px > 0)
        ratios.push(r.length_ft / r.length_px);
    }
    if (ratios.length === 0) return { analysis, reconcileNotes: notes };
    ratios.sort((a, b) => a - b);
    const ftPerPx = ratios[Math.floor(ratios.length / 2)];

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

    const ring = cleanRing(rawPoly, tol);
    if (ring.length < 4) return { analysis, reconcileNotes: notes };
    const centroid = {
      x: ring.reduce((s, p) => s + p.x, 0) / ring.length,
      y: ring.reduce((s, p) => s + p.y, 0) / ring.length,
    };

    const edges: Edge[] = [];
    for (let i = 0; i < ring.length; i++) {
      const e = makeEdge(ring[i], ring[(i + 1) % ring.length]);
      if (e && e.len > tol) edges.push(e);
    }
    if (edges.length === 0) return { analysis, reconcileNotes: notes };

    // Outward normal per edge: the perpendicular that points away from the
    // centroid (good enough to pick a cardinal side word / gable-end face).
    const outwardOf = (e: Edge): Pt => {
      const n1 = { x: e.uy, y: -e.ux };
      const away = (e.mid.x - centroid.x) * n1.x + (e.mid.y - centroid.y) * n1.y;
      return away >= 0 ? n1 : { x: -n1.x, y: -n1.y };
    };

    // Principal edge of each face read as a full gable end → keep unguttered.
    // resolveFaceSlots tries the modern HOUSE-RELATIVE keys first (cardinal
    // fallback for old rows) — a cardinal-only loop couldn't see modern reads,
    // so a full-wall gable end was silently priced by the closure. NEVER bill
    // across a gable end.
    const gableEndEdges = new Set<number>();
    const gableEndFaces: string[] = [];
    if (opts?.perFace) {
      for (const slot of resolveFaceSlots(opts.perFace, opts.faceNormals)) {
        const r = opts.perFace[slot.key];
        if (!r || r.readable === false || r.continuous_eave !== false) continue;
        const n = slot.normal;
        let best = -1;
        let bestScore = -Infinity;
        edges.forEach((e, i) => {
          if (Math.abs(e.ux * n.x + e.uy * n.y) > 0.5) return; // runs along n
          const score = e.mid.x * n.x + e.mid.y * n.y;
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        });
        if (best >= 0) {
          gableEndEdges.add(best);
          gableEndFaces.push(slot.key);
        }
      }
    }

    // ── ELEVATION-EAVE-WINS restoration (inverse of the suppression above) ──
    // The closure treats the trace's excluded_edges (rake claims) as COVERED
    // spans, so a HALLUCINATED rake permanently unprices a wall. When a face's
    // elevation read is readable, reads one CONTINUOUS eave, and reports ZERO
    // gables, a rake claim on that face's principal edge is contradicted by
    // the stronger evidence — a roof with no gable on a face carries an eave
    // on that wall (the 1168G failure: transient-529 front/rear reads left the
    // trace's invented "gable ends on the left and right" standing, drawing
    // both long walls as no-gutter dashes — 151 LF priced vs ~269 true).
    // Same slot → principal-edge mapping as the gable-end suppression, so the
    // two features stay symmetric. The deep-notch excludeEdges are NEVER
    // dropped (audited pocket legs stay unpriced), and the trace-hip cap still
    // applies downstream (capped spans surface as tap-to-add suggestions).
    const restoreEdges = new Map<number, string>();
    if (opts?.perFace) {
      for (const slot of resolveFaceSlots(opts.perFace, opts.faceNormals)) {
        if (!readsZeroGableContinuousEave(opts.perFace[slot.key])) continue;
        const n = slot.normal;
        let best = -1;
        let bestScore = -Infinity;
        edges.forEach((e, i) => {
          if (Math.abs(e.ux * n.x + e.uy * n.y) > 0.5) return; // runs along n
          const score = e.mid.x * n.x + e.mid.y * n.y;
          if (score > bestScore) {
            bestScore = score;
            best = i;
          }
        });
        // A gable-end edge (some OTHER face read a full-wall gable there)
        // must never be restored — suppression always wins.
        if (best >= 0 && !gableEndEdges.has(best)) restoreEdges.set(best, slot.key);
      }
    }

    // ── EVIDENCE GATE ────────────────────────────────────────────────────
    // "Unclassified exterior edge ⇒ eave" is only a safe default when a
    // READABLE elevation face confirms the eave-vs-gable-end split for that
    // side. A rake classification on the plan-view trace was previously enough
    // on its own, but it only proves that SOME edge is a gable end — it cannot
    // tell which of the UNCLASSIFIED edges are eaves vs gable ends, and the
    // gable-end suppression below needs face reads it doesn't have. The
    // Woodinville credits-outage run is the failure: every elevation 400-errored
    // yet a lone trace rake unlocked +204 LF of blind gutter, some of it priced
    // straight across gable ends. With no readable face: add nothing, flag for
    // review, keep pricing on the AI's own runs (an unpriced edge is visible to
    // the contractor; invented gutter across a gable end is not).
    const readableFaces = opts?.perFace
      ? Object.values(opts.perFace).filter((f) => f && f.readable !== false).length
      : 0;
    const hasEvidence = readableFaces > 0;

    const gutterSegs: Seg[] = (analysis.gutter_runs ?? [])
      .map((r) => ({ a: asPt(r.start), b: asPt(r.end) }))
      .filter((s): s is Seg => s.a !== null && s.b !== null);
    const exclusionSegs: Seg[] = (analysis.excluded_edges ?? [])
      .map((x) => ({ a: asPt(x.start), b: asPt(x.end) }))
      .filter((s): s is Seg => s.a !== null && s.b !== null);
    // Suspect notch legs (deep-notch audit) — never auto-priced, counted +
    // noted UNPRICED instead. Empty on every legacy call site.
    const notchSegs: Seg[] = (opts?.excludeEdges ?? [])
      .map((x) => ({ a: asPt(x.a), b: asPt(x.b) }))
      .filter((s): s is Seg => s.a !== null && s.b !== null);
    const COVER = 0.5;
    // The AI runs/exclusions were BBOX-remapped onto the vector outline, so
    // they sit NEAR their walls, not exactly on them. Deduping with the tight
    // ring tolerance misses those matches and re-prices walls the AI already
    // priced (double count). Coverage gets a looser tolerance; the ring
    // cleaning + sliver filter keep the tight one.
    const covTol = Math.max(tol * 2.5, span * 0.03);

    const sideOf = (n: Pt): Side =>
      Math.abs(n.x) >= Math.abs(n.y) ? (n.x >= 0 ? "right" : "left") : n.y >= 0 ? "front" : "back";

    const newRuns: BlueprintRun[] = [];
    let uncoveredFt = 0;
    let uncoveredCount = 0;
    let skippedGableEnd = 0;
    const gableSkipCounted = new Set<number>();
    let notchSkipped = 0;
    let notchSkippedFt = 0;
    const restoredFacesNoted = new Set<string>();
    edges.forEach((e, i) => {
      // Mostly-notch edges stay a whole-edge skip: counted + noted UNPRICED.
      if (notchSegs.length > 0 && coveredFraction(e, notchSegs, covTol) > COVER) {
        notchSkipped++;
        notchSkippedFt += round1(e.len * ftPerPx);
        return;
      }
      // ELEVATION-EAVE-WINS: on a restore-qualified edge (its face reads one
      // continuous eave, zero gables) drop the trace's rake exclusions from
      // the covered set — but ONLY when doing so actually uncovers span
      // (otherwise the covered set, and every output byte, is unchanged).
      // Real gutter runs and the deep-notch legs always keep covering.
      const restoreFace = restoreEdges.get(i);
      let covSegs: Seg[] = [...gutterSegs, ...exclusionSegs, ...notchSegs];
      let restoredHere = false;
      if (restoreFace && exclusionSegs.some((s) => overlapFraction(e, s, covTol) > 0)) {
        const withoutExclusions: Seg[] = [...gutterSegs, ...notchSegs];
        if (
          coveredFraction(e, withoutExclusions, covTol) <
          coveredFraction(e, covSegs, covTol) - 1e-9
        ) {
          covSegs = withoutExclusions;
          restoredHere = true;
        }
      }
      // Per-SUB-SPAN coverage. The old binary test (>50% covered → done)
      // swallowed real mid-wall gaps: two corner runs covering 60% of a rear
      // wall hid an unguttered ~17 ft middle on a fully-hipped roof. Price
      // (or count) each uncovered gap instead.
      const gaps = uncoveredIntervals(e, covSegs, covTol);
      for (const [t0, t1] of gaps) {
        const frac = t1 - t0;
        const lenFt = round1(frac * e.len * ftPerPx);
        // A fully-uncovered edge keeps the historic 2 ft floor; a PARTIAL
        // mid-wall gap uses a 6 ft floor — smaller gaps are trace/label
        // noise at the run ends, not missing gutter.
        const floor = frac > 0.98 ? 2 : 6;
        if (lenFt < floor) continue;
        if (!hasEvidence) {
          uncoveredFt += lenFt;
          uncoveredCount++;
          continue;
        }
        if (gableEndEdges.has(i)) {
          if (!gableSkipCounted.has(i)) {
            gableSkipCounted.add(i);
            skippedGableEnd++;
          }
          continue;
        }
        // A restored span is about to be priced (or suggested past the cap) —
        // that face gets its loud restoration note exactly once.
        if (restoredHere && restoreFace) restoredFacesNoted.add(restoreFace);
        newRuns.push({
          id: `${mode === "trace-hip" ? "hclose" : "vclose"}-${newRuns.length + 1}`,
          side: sideOf(outwardOf(e)),
          start: { x: e.a.x + e.ux * e.len * t0, y: e.a.y + e.uy * e.len * t0 },
          end: { x: e.a.x + e.ux * e.len * t1, y: e.a.y + e.uy * e.len * t1 },
          length_ft: lenFt,
          length_px: round1(e.len * frac),
          drains_to: [],
          // Trace-hip closes MAIN-ring walls (the footprint is the upper roof);
          // vector mode keeps the honest "unknown".
          tier: mode === "trace-hip" ? "upper" : "unknown",
        });
      }
    });

    // ELEVATION-EAVE-WINS notes — one per restored face, LOUD, and pushed
    // before the closure/cap note so the reader sees WHY those spans exist.
    // Fires only when a restored span actually priced (or will be surfaced as
    // a cap suggestion) — a dropped rake that changed nothing stays silent.
    for (const face of restoredFacesNoted) {
      notes.push(
        `🧭 ${face} wall restored — the ${face} elevation reads one continuous eave with ZERO gables, overriding the trace's rake there (a hip roof carries gutter on every exterior wall). VERIFY on the canvas.`,
      );
    }

    // The skipped-notch tail rides on whichever closure note fires (or stands
    // alone when closure would otherwise return silently) — an unpriced leg
    // must be VISIBLE, never a silent skip.
    const notchSentence =
      notchSkipped > 0
        ? ` ${notchSkipped} suspect notch leg(s) (~${round1(notchSkippedFt)} LF) left UNPRICED per the deep-notch audit — a carved pocket the elevations don't support; verify/edit the outline before pricing them.`
        : "";

    if (!hasEvidence && uncoveredCount > 0) {
      notes.push(
        `Vector closure SKIPPED — no readable elevation face, so unclassified exterior edges can't be told apart as eaves vs gable ends. ${uncoveredCount} exterior edge(s) (~${round1(uncoveredFt)} LF) left UNPRICED for review; the total stays on the AI's measured runs.` +
          notchSentence,
      );
      return { analysis, reconcileNotes: notes };
    }
    if (newRuns.length === 0) {
      if (notchSentence) {
        notes.push(
          `${mode === "trace-hip" ? "Hip" : "Vector"} closure:${notchSentence}`,
        );
      }
      return { analysis, reconcileNotes: notes };
    }

    // Trace-hip cap: on a squared AI trace the closed UPPER-tier total must not
    // exceed the footprint's own perimeter (+10% slack for coverage overlap) —
    // lower-tier porch/patio runs sit inside the ring, so they're excluded from
    // the comparison. If the cap trips, the ring and the runs disagree too much
    // to auto-price; leave the edges for review instead of forcing LF in.
    if (mode === "trace-hip") {
      const perimeterFt = edges.reduce((s, e) => s + e.len, 0) * ftPerPx;
      const upperPricedFt = (analysis.gutter_runs ?? []).reduce(
        (s, r) => s + (r.tier !== "lower" && r.length_ft != null && r.length_ft > 0 ? r.length_ft : 0),
        0,
      );
      const addFt = newRuns.reduce((s, r) => s + (r.length_ft ?? 0), 0);
      if (upperPricedFt + addFt > perimeterFt * 1.1) {
        // The cap means the RUNS are already hot against the ring's own
        // perimeter (an inflated scale read) — auto-pricing more would
        // compound it. But the uncovered walls are still real geometry on a
        // fully-hipped roof: surface them as unpriced TAP-TO-ADD suggestions
        // instead of a silent drop, so the owner sees exactly which spans
        // carry no gutter and decides.
        notes.push(
          `Hip closure CAPPED — adding ${round1(addFt)} LF would push the upper-tier total (${round1(upperPricedFt)} LF) past the footprint's own ~${round1(perimeterFt)} ft perimeter; the run lengths and the ring disagree (a hot scale read inflates every run). ${newRuns.length} unguttered wall span(s) left UNPRICED — each is available on the canvas as a tap-to-add suggestion; verify the scale before quoting.` +
            notchSentence,
        );
        return {
          analysis,
          reconcileNotes: notes,
          suggestedRuns: newRuns.map((r) => ({
            start: r.start,
            end: r.end,
            lengthFt: r.length_ft ?? 0,
          })),
        };
      }
    }

    const addedFt = round1(newRuns.reduce((s, r) => s + (r.length_ft ?? 0), 0));
    const gutter_runs = [...analysis.gutter_runs, ...newRuns];
    const prevTotal = analysis.totals?.linear_feet_gutter;
    const totals =
      prevTotal != null && Number.isFinite(prevTotal)
        ? { ...analysis.totals, linear_feet_gutter: round1(prevTotal + addedFt) }
        : analysis.totals;

    notes.push(
      (mode === "trace-hip"
        ? `Hip closure: every readable elevation shows a continuous eave with ZERO gables (fully hipped roof), so the footprint's ${
            newRuns.length
          } unguttered exterior wall(s) priced as eaves (+${addedFt} LF at the runs' own ${(1 / ftPerPx).toFixed(1)} px/ft scale) — a hip roof carries gutter on every exterior wall. VERIFY each on the canvas.`
        : `Vector closure: the footprint is the plan's own vector outline, so its ${
            newRuns.length
          } unclassified exterior edge(s) priced as eaves (+${addedFt} LF at the runs' own ${(1 / ftPerPx).toFixed(1)} px/ft scale) per the "continuous gutters @ all eaves" default — VERIFY each against the elevations.${
            skippedGableEnd > 0
              ? ` ${skippedGableEnd} gable-end edge(s) (${gableEndFaces.join("/")}) left unguttered per the elevation read.`
              : ""
          }`) + notchSentence,
    );

    return { analysis: { ...analysis, gutter_runs, totals }, reconcileNotes: notes };
  } catch {
    return { analysis, reconcileNotes: notes };
  }
}
