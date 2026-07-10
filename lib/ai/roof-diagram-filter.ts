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
 */
export function filterRoofDiagramLines<T extends DiagramLine>(
  lines: { ridges: T[]; valleys: T[]; hips: T[] },
  perimeter: readonly DiagramPt[],
): { ridges: T[]; valleys: T[]; hips: T[] } {
  if (!perimeter || perimeter.length < 3) {
    return { ridges: [], valleys: [], hips: [] };
  }
  const xs = perimeter.map((p) => p.x);
  const ys = perimeter.map((p) => p.y);
  const span = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  );
  if (!Number.isFinite(span) || span <= 0) {
    return { ridges: [], valleys: [], hips: [] };
  }
  const tol = Math.max(span * 0.02, 2);

  type Tagged = { line: T; kind: "ridge" | "valley" | "hip" };
  let pool: Tagged[] = [
    ...lines.ridges.map((line) => ({ line, kind: "ridge" as const })),
    ...lines.valleys.map((line) => ({ line, kind: "valley" as const })),
    ...lines.hips.map((line) => ({ line, kind: "hip" as const })),
  ].filter((t) => endpoints(t.line) !== null);

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

  const keep = new Set(pool.map((t) => t.line));
  return {
    ridges: lines.ridges.filter((l) => keep.has(l)),
    valleys: lines.valleys.filter((l) => keep.has(l)),
    hips: lines.hips.filter((l) => keep.has(l)),
  };
}
