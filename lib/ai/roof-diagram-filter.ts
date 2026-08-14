/**
 * roof-diagram-filter.ts — make the engine's interior roof lines safe to DRAW
 * on the perimeter-only takeoff diagram.
 *
 * The engine's tier masses OVERLAP in plan (an upper roof sits over a lower
 * one), so flat-mapping every mass's skeleton draws stacked forms on top of
 * each other: whole-body hip fans that cross, and ridge stubs floating in the
 * middle of the canvas. A real architect's roof plan obeys three invariants,
 * and enforcing them deterministically keeps every line that LOOKS like a
 * roof and drops every line that reads as garbage:
 *
 *   1. NO CROSSINGS — interior roof lines never properly intersect (they may
 *      share endpoints / T-join). On a proper crossing, drop the LONGER line
 *      (the whole-body fan) and re-check until cross-free.
 *   2. HIP/VALLEY LENGTH — a hip or valley's plan length is ~half its mass's
 *      width; one spanning >40% of the footprint span is a mis-derived fan
 *      line. Ridges are exempt (a long ridge is legitimate).
 *   3. ANCHORING — every line must trace back to the roof edge: keep only
 *      lines REACHABLE (via endpoint junctions) from a line that touches the
 *      perimeter. Two floating stubs touching each other don't anchor each
 *      other — reachability is seeded at the boundary, not mutual.
 *
 * Purely decorative: runs only on the DRAWN structure lines, never touches
 * eaves/rakes or priced LF. PURE (no server-only / DOM) — node-testable.
 */

export type DiagramPt = { x: number; y: number };
export type DiagramLine = { points: DiagramPt[] };

const HIP_VALLEY_MAX_SPAN_FRAC = 0.4;

function endpoints(l: DiagramLine): [DiagramPt, DiagramPt] | null {
  if (!l.points || l.points.length < 2) return null;
  const a = l.points[0];
  const b = l.points[l.points.length - 1];
  if (
    !Number.isFinite(a.x) || !Number.isFinite(a.y) ||
    !Number.isFinite(b.x) || !Number.isFinite(b.y)
  ) {
    return null;
  }
  return [a, b];
}

function lineLen(l: DiagramLine): number {
  const e = endpoints(l);
  return e ? Math.hypot(e[1].x - e[0].x, e[1].y - e[0].y) : 0;
}

/** Proper segment crossing — shared endpoints / touching (T-joins) do NOT count. */
export function segmentsCross(
  a1: DiagramPt, a2: DiagramPt, b1: DiagramPt, b2: DiagramPt,
): boolean {
  const d = (p: DiagramPt, q: DiagramPt, r: DiagramPt) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const eps = 1e-9;
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return (
    ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
    ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
  );
}

function distToSegment(p: DiagramPt, a: DiagramPt, b: DiagramPt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
    : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distToPolygonBoundary(p: DiagramPt, poly: readonly DiagramPt[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    best = Math.min(best, distToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return best;
}

/**
 * Apply the three roof-plan invariants to the DRAWN interior lines. Input
 * arrays are per kind so the hip/valley length rule knows which lines it
 * applies to; each returned array preserves its input's order and objects.
 *
 * `opts.strictAnchor` (the raster/engine path) adds two stricter rules:
 *   4. RIDGES must anchor at BOTH endpoints — each endpoint must terminate on
 *      the perimeter, on another KEPT line, or at a junction. A ridge stub
 *      that died into a HIDDEN interior cut wall (scanned all-hip plans with
 *      clerestories) floats at one end and reads as a random dash — drop it.
 *   5. TINY SURVIVING SET — if fewer than 2 lines survive, or only fragments
 *      do, the interior is not evidenced enough to draw at all: emit EMPTY
 *      arrays and set `interiorOmitted` so the caller can say so in a note.
 *      Doctrine: prefer drawing NOTHING over fabricated fragments.
 */
export function filterRoofDiagramLines<T extends DiagramLine>(
  lines: { ridges: T[]; valleys: T[]; hips: T[] },
  perimeter: readonly DiagramPt[],
  opts?: {
    /** Raster-path strictness: both-endpoint ridge anchoring + the
     *  tiny-set → empty rule. Off by default (v-line callers keep the
     *  original single-anchor reachability behavior). */
    strictAnchor?: boolean;
  },
): { ridges: T[]; valleys: T[]; hips: T[]; interiorOmitted: boolean } {
  if (!perimeter || perimeter.length < 3) {
    return { ridges: [], valleys: [], hips: [], interiorOmitted: false };
  }
  const xs = perimeter.map((p) => p.x);
  const ys = perimeter.map((p) => p.y);
  const span = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  );
  if (!Number.isFinite(span) || span <= 0) {
    return { ridges: [], valleys: [], hips: [], interiorOmitted: false };
  }
  const tol = Math.max(span * 0.02, 2);

  type Tagged = { line: T; kind: "ridge" | "valley" | "hip" };
  let pool: Tagged[] = [
    ...lines.ridges.map((line) => ({ line, kind: "ridge" as const })),
    ...lines.valleys.map((line) => ({ line, kind: "valley" as const })),
    ...lines.hips.map((line) => ({ line, kind: "hip" as const })),
  ].filter((t) => endpoints(t.line) !== null);
  const inputCount = pool.length;

  // 1. NO CROSSINGS — drop the longest line involved in any proper crossing,
  //    re-check (bounded: each pass removes one line).
  for (let guard = pool.length; guard > 0; guard--) {
    let worst: Tagged | null = null;
    let worstLen = -1;
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const ea = endpoints(pool[i].line)!;
        const eb = endpoints(pool[j].line)!;
        if (!segmentsCross(ea[0], ea[1], eb[0], eb[1])) continue;
        const cand =
          lineLen(pool[i].line) >= lineLen(pool[j].line) ? pool[i] : pool[j];
        const len = lineLen(cand.line);
        if (len > worstLen) {
          worstLen = len;
          worst = cand;
        }
      }
    }
    if (!worst) break;
    pool = pool.filter((t) => t !== worst);
  }

  // 2. HIP/VALLEY LENGTH cap (ridges exempt).
  pool = pool.filter(
    (t) => t.kind === "ridge" || lineLen(t.line) <= span * HIP_VALLEY_MAX_SPAN_FRAC,
  );

  // 3. ANCHORING — BFS from boundary-touching seeds through junctions;
  //    anything unreachable is a floating stub (or an island of stubs
  //    propping each other up) and gets dropped.
  const ends = pool.map((t) => endpoints(t.line)!);
  const distToLine = (p: DiagramPt, [a, b]: readonly [DiagramPt, DiagramPt]) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
  };
  // Connected = endpoint meets endpoint OR endpoint dies into the other
  // line's span (a T-junction — a gable ridge ending on a valley, a valley
  // ending on a ridge — is a physical roof connection, not a float).
  const touches = (i: number, j: number): boolean => {
    for (const p of ends[i]) if (distToLine(p, ends[j]) <= tol) return true;
    for (const q of ends[j]) if (distToLine(q, ends[i]) <= tol) return true;
    return false;
  };
  const reachable = new Array<boolean>(pool.length).fill(false);
  const queue: number[] = [];
  for (let i = 0; i < pool.length; i++) {
    if (ends[i].some((p) => distToPolygonBoundary(p, perimeter) <= tol)) {
      reachable[i] = true;
      queue.push(i);
    }
  }
  while (queue.length > 0) {
    const i = queue.pop()!;
    for (let j = 0; j < pool.length; j++) {
      if (!reachable[j] && touches(i, j)) {
        reachable[j] = true;
        queue.push(j);
      }
    }
  }
  pool = pool.filter((_, i) => reachable[i]);

  // 4. STRICT RIDGE ANCHORING (raster path only) — a ridge must terminate on
  //    the perimeter, another KEPT line, or a junction at BOTH endpoints.
  //    Single-anchor reachability (rule 3) keeps a ridge stub whose far end
  //    died into a hidden interior cut wall; those float mid-canvas on
  //    scanned all-hip plans. Iterate to a fixpoint: dropping one ridge can
  //    unanchor another (the result is the unique greatest both-anchored set,
  //    independent of drop order).
  if (opts?.strictAnchor) {
    for (;;) {
      const endsNow = pool.map((t) => endpoints(t.line)!);
      const anchored = (p: DiagramPt, self: number): boolean =>
        distToPolygonBoundary(p, perimeter) <= tol ||
        endsNow.some((e, j) => j !== self && distToLine(p, e) <= tol);
      const idx = pool.findIndex(
        (t, i) =>
          t.kind === "ridge" && !endsNow[i].every((p) => anchored(p, i)),
      );
      if (idx < 0) break;
      pool.splice(idx, 1);
    }
  }

  // 5. TINY SURVIVING SET (raster path only) — fewer than 2 survivors, or
  //    fragments only, isn't an evidenced roof interior; draw nothing and
  //    tell the caller (the perimeter + tier steps still carry the picture).
  let interiorOmitted = false;
  if (opts?.strictAnchor && inputCount > 0) {
    const fragLen = span * 0.15;
    const tiny =
      pool.length < 2 || pool.every((t) => lineLen(t.line) < fragLen);
    if (tiny) {
      interiorOmitted = true;
      pool = [];
    }
  }

  const keep = new Set(pool.map((t) => t.line));
  return {
    ridges: lines.ridges.filter((l) => keep.has(l)),
    valleys: lines.valleys.filter((l) => keep.has(l)),
    hips: lines.hips.filter((l) => keep.has(l)),
    interiorOmitted,
  };
}

// ── Pure decision helpers for the blueprint→estimate bridge ────────────────
// blueprint-to-estimate.ts is server-only (not node-testable), so the two
// view-time decisions it makes about interior geometry live here as pure
// functions with tests: which priced gutter runs are INTERIOR (and must still
// draw), and which mass-boundary edges are tier STEPS (and get their own
// drawn channel). Neither touches priced LF — display classification only.

export type RunPlacement = "perimeter" | "interior" | "invalid";

/**
 * Classify a priced gutter run against the footprint perimeter. "interior"
 * = the run's midpoint sits farther than `tol` from every footprint edge
 * (e.g. a clerestory rectangle mid-roof) — it must be APPENDED to the drawn
 * eaves in perimeter-only mode or its LF silently smears onto the perimeter
 * pills via the uniform correction. "invalid" = non-finite coords (never
 * draw those — garbage points collapse to the viewBox center). A missing /
 * degenerate footprint or a non-finite tol classifies as "perimeter": with
 * no boundary to test against, nothing can be called interior.
 */
export function classifyRunPlacement(
  run: {
    start?: DiagramPt | null;
    end?: DiagramPt | null;
  },
  footprint: readonly DiagramPt[],
  tol: number,
): RunPlacement {
  const s = run.start;
  const e = run.end;
  if (
    !s || !e ||
    !Number.isFinite(s.x) || !Number.isFinite(s.y) ||
    !Number.isFinite(e.x) || !Number.isFinite(e.y)
  ) {
    return "invalid";
  }
  if (!footprint || footprint.length < 3 || !Number.isFinite(tol)) {
    return "perimeter";
  }
  const mid = { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 };
  return distToPolygonBoundary(mid, footprint) > tol ? "interior" : "perimeter";
}

export type StepEdgeSource<T> = { edge: T; massName?: string };

/**
 * Tier steps are only a real drawing element on a MULTI-LEVEL roof — one
 * where at least one gutter run sits on a LOWER tier. On a single-level roof
 * the mass decomposition still slices the footprint into rectangles, but its
 * seams are geometry bookkeeping, not roof steps — drawing them painted
 * full-height "step" lines across an all-hip, all-upper rambler that has no
 * steps at all. Pure gate for the steps channel.
 */
export function shouldDrawTierSteps(
  runs: readonly { tier?: string | null }[] | undefined | null,
): boolean {
  return (runs ?? []).some((r) => r?.tier === "lower");
}

/**
 * Select the tier-STEP edges to draw: interior mass-boundary edges (midpoint
 * farther than `tol` from the footprint perimeter) with finite, non-degenerate
 * geometry, deduplicated across masses (two tier masses SHARE their boundary,
 * so the same step edge arrives once per mass). Order-preserving; keeps the
 * first occurrence (its mass name becomes the step's label). Pure and
 * LF-neutral: never mutates inputs, never touches gutter flags or lengths —
 * these edges are already EXCLUDED from the drawn eaves/rakes by the
 * perimeter-only filter, this only routes them to a display channel.
 */
/** tan(12°) — an edge within ~12° of horizontal or vertical counts as
 *  axis-aligned. Mirrors the same tolerance raster-outline.ts's
 *  pageAxisAlignedFraction uses for the same judgment call elsewhere. */
const AXIS_TOL_TAN = 0.2126;

/** A real tier boundary in this codebase's domain model (rectilinear
 *  buildings) is always horizontal or vertical. A mass-decomposition seam
 *  that comes out diagonal is decomposition noise — residual footprint
 *  skew, an irregular mass shape the decomposer couldn't cleanly split —
 *  not an actual architectural step; drawing it reads as a random slash
 *  across the roof. Display-only gate, mirrors pageAxisAlignedFraction's
 *  tolerance. */
function isAxisAligned(p1: DiagramPt, p2: DiagramPt): boolean {
  const dx = Math.abs(p2.x - p1.x);
  const dy = Math.abs(p2.y - p1.y);
  return dy <= dx * AXIS_TOL_TAN || dx <= dy * AXIS_TOL_TAN;
}

export function collectStepEdges<T extends { p1: DiagramPt; p2: DiagramPt }>(
  edges: readonly StepEdgeSource<T>[],
  footprint: readonly DiagramPt[],
  tol: number,
): StepEdgeSource<T>[] {
  if (!footprint || footprint.length < 3 || !Number.isFinite(tol)) return [];
  const finite = (p: DiagramPt | null | undefined): p is DiagramPt =>
    !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const dedupTol = Math.max(tol * 0.5, 1);
  const samePt = (a: DiagramPt, b: DiagramPt) =>
    Math.hypot(a.x - b.x, a.y - b.y) <= dedupTol;
  const out: StepEdgeSource<T>[] = [];
  for (const s of edges) {
    const { p1, p2 } = s.edge;
    if (!finite(p1) || !finite(p2)) continue;
    if (Math.hypot(p2.x - p1.x, p2.y - p1.y) <= dedupTol) continue;
    if (!isAxisAligned(p1, p2)) continue;
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    if (distToPolygonBoundary(mid, footprint) <= tol) continue;
    const dup = out.some(
      (o) =>
        (samePt(o.edge.p1, p1) && samePt(o.edge.p2, p2)) ||
        (samePt(o.edge.p1, p2) && samePt(o.edge.p2, p1)),
    );
    if (dup) continue;
    out.push(s);
  }
  return out;
}
