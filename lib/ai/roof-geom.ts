/**
 * Pure roof-geometry helpers — NO `import "server-only"` so they can run
 * under `npx tsx --test` (same convention as reconcile-eaves.ts). The
 * server-only modules (geometry.ts, solar-polygon.ts, sam.ts) import from
 * here; the tests import from here directly.
 *
 * Everything in this file is a deterministic function of its inputs: no
 * network, no DB, no API keys, no image decoding.
 */

export type Pt = { x: number; y: number };

/** Distance from point p to segment ab. */
function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Max over `verts` of the min distance to any edge of closed polygon `poly`. */
function directedHausdorff(verts: Pt[], poly: Pt[]): number {
  if (verts.length === 0 || poly.length < 2) return Infinity;
  let worst = 0;
  for (const v of verts) {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const d = pointToSegment(v, a, b);
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

/**
 * Symmetric Hausdorff distance (px) between two closed polygons: the
 * larger of the two one-sided distances. Unlike a vertex-index pairing
 * (maxPairwiseDist), this is well-defined even when the polygons have
 * DIFFERENT vertex counts — which is exactly what orthogonal
 * regularization produces when it merges collinear runs (24 → 10). Small
 * value ⇒ the two outlines describe the same wall, regardless of how many
 * vertices each uses.
 */
export function symmetricHausdorffPx(a: Pt[], b: Pt[]): number {
  return Math.max(directedHausdorff(a, b), directedHausdorff(b, a));
}

/** Unsigned polygon area (shoelace). */
export function polygonAreaAbs(points: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Is the turn at `curr` (between edges prev→curr and curr→next) a real
 * architectural corner, or just simplification jitter / a mask hairpin?
 *
 * The deviation angle from collinear is atan2(|cross|, dot):
 *   ~0°   → straight run (colinear noise)          → NOT a corner
 *   45°   → chamfer / bay corner                    → corner
 *   90°   → square corner                           → corner
 *   ~180° → hairpin spike (mask noise)              → NOT a corner
 *
 * Gate: 25° ≤ |turn| ≤ 155°. The lower bound stays conservative so real
 * 30–45° bays still count; the upper bound rejects the near-reversal
 * spikes a jaggy 0.5 m Solar mask produces.
 */
export function isArchitecturalCorner(prev: Pt, curr: Pt, next: Pt): boolean {
  const v1x = curr.x - prev.x;
  const v1y = curr.y - prev.y;
  const v2x = next.x - curr.x;
  const v2y = next.y - curr.y;
  if ((v1x === 0 && v1y === 0) || (v2x === 0 && v2y === 0)) return false;
  const cross = v1x * v2y - v1y * v2x;
  const dot = v1x * v2x + v1y * v2y;
  const turn = Math.atan2(Math.abs(cross), dot); // 0..π deviation from straight
  const LOW = (25 * Math.PI) / 180;
  const HIGH = (155 * Math.PI) / 180;
  return turn >= LOW && turn <= HIGH;
}

/**
 * Count "open" eave-run terminations — endpoints that don't meet another
 * eave. Each open end is where a gutter run stops in mid-air and needs an
 * end cap; endpoints that touch a DIFFERENT eave are corners, not caps.
 *
 * Critically, an endpoint is compared only against endpoints of OTHER
 * lines: a near-minimum-length eave has both of its own endpoints within
 * `tol` of each other, so including the sibling would wrongly mark a
 * legitimate short stub as closed.
 */
export function countOpenEaveEnds(
  lines: { kind?: string; points: Pt[] }[],
  tol = 14,
): number {
  const ends: { x: number; y: number; li: number }[] = [];
  lines.forEach((l, li) => {
    if (!l.points || l.points.length < 2) return;
    if (l.kind && l.kind !== "eave") return;
    ends.push({ ...l.points[0], li });
    ends.push({ ...l.points[l.points.length - 1], li });
  });
  const tol2 = tol * tol;
  let open = 0;
  for (let i = 0; i < ends.length; i++) {
    let closed = false;
    for (let j = 0; j < ends.length; j++) {
      if (i === j || ends[i].li === ends[j].li) continue;
      const dx = ends[i].x - ends[j].x;
      const dy = ends[i].y - ends[j].y;
      if (dx * dx + dy * dy <= tol2) {
        closed = true;
        break;
      }
    }
    if (!closed) open++;
  }
  return open;
}

/**
 * 8-connected largest-component extraction over a foreground predicate.
 * Returns a mask (row-major, 1 = keep) for the single biggest blob plus
 * its pixel count.
 *
 * SAM's area-fraction gate counts ALL foreground islands, but the
 * Moore-Neighbor tracer walks exactly one boundary starting from the
 * first row-scanned foreground pixel — so a detached speck can capture
 * the trace while the gate is satisfied by the real roof. Restricting the
 * trace (and the reported area) to the largest 8-connected component
 * makes the gate and the traced polygon describe the SAME pixels.
 *
 * Uses 8-connectivity to match traceMooreNeighbor exactly (a blob joined
 * only by a 1px diagonal pinch must stay whole).
 */
export function largestConnectedComponent(
  width: number,
  height: number,
  isFg: (x: number, y: number) => boolean,
): { mask: Uint8Array; count: number } {
  const label = new Uint8Array(width * height); // 0 = unvisited, 1 = seen
  const best = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let bestCount = 0;

  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      const sIdx = sy * width + sx;
      if (label[sIdx] || !isFg(sx, sy)) continue;
      // BFS this component, recording its member indices.
      let head = 0;
      let tail = 0;
      queue[tail++] = sIdx;
      label[sIdx] = 1;
      const members: number[] = [];
      while (head < tail) {
        const idx = queue[head++];
        members.push(idx);
        const x = idx % width;
        const y = (idx - x) / width;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const nIdx = ny * width + nx;
            if (label[nIdx] || !isFg(nx, ny)) continue;
            label[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
      }
      if (members.length > bestCount) {
        bestCount = members.length;
        best.fill(0);
        for (const m of members) best[m] = 1;
      }
    }
  }
  return { mask: best, count: bestCount };
}
