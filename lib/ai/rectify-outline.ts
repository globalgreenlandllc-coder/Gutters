/**
 * rectify-outline.ts — snap a slightly-wobbly traced roof outline onto the
 * house's TRUE wall lines ("a little off? guess it").
 *
 * A SAM/mask trace of a rectilinear house comes back with small offsets:
 * jittered vertices, stair-steps, walls a few degrees off their real angle.
 * Houses in satellite tiles are also rotated arbitrarily (nothing aligns to
 * the pixel grid). This pass:
 *   1. estimates the house's DOMINANT ORIENTATION (edge-length-weighted,
 *      mod 90° — the Manhattan assumption),
 *   2. rotates the outline into that frame,
 *   3. clusters near-equal coordinates and snaps every vertex to the cluster
 *      line — the "guessed" true wall position — which forces clean 90°
 *      corners and merges stair-step wobble,
 *   4. rotates back.
 *
 * SAFETY: it bails (returns the input unchanged, applied=false) when the
 * shape isn't actually Manhattan (≥28% of the perimeter off-axis — bay
 * windows/diagonal wings keep their true geometry), when snapping collapses
 * the ring (<4 corners), or when the area drifts >8% (the snap must clean the
 * trace, never reshape the roof).
 *
 * PURE (no server-only / DOM) — node-testable, browser-safe.
 */

export type RPt = { x: number; y: number };

export type RectifyResult = {
  points: RPt[];
  /** True when the snap was applied; false = input returned unchanged. */
  applied: boolean;
  /** Dominant orientation (degrees, mod 90) that was rectified against. */
  angleDeg: number;
  /** Why the pass bailed, when applied === false. */
  reason?: string;
};

const polyArea = (pts: RPt[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

/** Cluster near-equal values (within tol) to their mean — the "guessed" line. */
function clusterReps(vals: number[], tol: number): number[] {
  const sorted = [...vals].sort((a, b) => a - b);
  const reps: number[] = [];
  let group: number[] = [];
  for (const v of sorted) {
    if (group.length === 0 || v - group[group.length - 1] <= tol) group.push(v);
    else {
      reps.push(group.reduce((s, x) => s + x, 0) / group.length);
      group = [v];
    }
  }
  if (group.length) reps.push(group.reduce((s, x) => s + x, 0) / group.length);
  return reps;
}

const nearestRep = (reps: number[], v: number): number =>
  reps.reduce((best, r) => (Math.abs(r - v) < Math.abs(best - v) ? r : best), reps[0]);

/**
 * Rectify a traced outline. `snapTolPx` is how far a vertex may be moved onto
 * its guessed wall line — pass ≈2–3 ft in pixels at the tile's scale.
 * Accepts an open or closed ring (first==last); always returns an OPEN ring.
 */
export function rectifyOutline(pointsIn: RPt[], opts: { snapTolPx: number }): RectifyResult {
  const noop = (reason: string): RectifyResult => ({
    points: pointsIn,
    applied: false,
    angleDeg: 0,
    reason,
  });
  try {
    // Drop a closing duplicate so the ring is open.
    let pts = pointsIn;
    if (
      pts.length >= 2 &&
      Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-9 &&
      Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-9
    ) {
      pts = pts.slice(0, -1);
    }
    if (pts.length < 4) return noop("fewer than 4 corners");
    if (!pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return noop("non-finite point");
    const tol = opts.snapTolPx;
    if (!(tol > 0)) return noop("bad tolerance");

    // 1. Dominant orientation, mod 90°: length-weighted mean of 4θ on the
    //    unit circle (standard Manhattan-orientation estimate — a wall at θ
    //    and one at θ+90° reinforce the same 4θ direction).
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const th = Math.atan2(dy, dx);
      sx += len * Math.cos(4 * th);
      sy += len * Math.sin(4 * th);
    }
    if (Math.hypot(sx, sy) < 1e-9) return noop("no dominant orientation");
    const theta = Math.atan2(sy, sx) / 4;

    // 2. Rotate into the house frame (about the centroid).
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const cos = Math.cos(-theta);
    const sin = Math.sin(-theta);
    const rot = pts.map((p) => ({
      x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
      y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
    }));

    // 3. Manhattan check: enough of the perimeter must run within ~12° of an
    //    axis in this frame, else the house genuinely isn't rectilinear.
    const AX = Math.tan((12 * Math.PI) / 180);
    let axisLen = 0;
    let totalLen = 0;
    for (let i = 0; i < rot.length; i++) {
      const a = rot[i];
      const b = rot[(i + 1) % rot.length];
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      const len = Math.hypot(dx, dy);
      totalLen += len;
      if (dy <= dx * AX || dx <= dy * AX) axisLen += len;
    }
    if (!(totalLen > 0) || axisLen / totalLen < 0.72) return noop("outline is not rectilinear enough");

    // 4. Snap every vertex to its clustered "guessed" wall line.
    const xs = clusterReps(rot.map((p) => p.x), tol);
    const ys = clusterReps(rot.map((p) => p.y), tol);
    let snapped = rot.map((p) => ({ x: nearestRep(xs, p.x), y: nearestRep(ys, p.y) }));
    // Drop consecutive duplicates (a snapped-away stair-step collapses).
    snapped = snapped.filter((p, i) => {
      const q = snapped[(i - 1 + snapped.length) % snapped.length];
      return Math.abs(p.x - q.x) > 1e-6 || Math.abs(p.y - q.y) > 1e-6;
    });
    // Collapse collinear runs → corners only.
    const corners: RPt[] = [];
    for (let i = 0; i < snapped.length; i++) {
      const a = snapped[(i - 1 + snapped.length) % snapped.length];
      const b = snapped[i];
      const c = snapped[(i + 1) % snapped.length];
      const collinear = (b.x - a.x) * (c.y - b.y) === (b.y - a.y) * (c.x - b.x);
      if (!collinear) corners.push(b);
    }
    if (corners.length < 4) return noop("snap collapsed the ring");

    // 5. Area guard: cleaning, not reshaping.
    const a0 = polyArea(rot);
    const a1 = polyArea(corners);
    if (!(a0 > 0) || Math.abs(a1 - a0) / a0 > 0.08) return noop("snap changed the area too much");

    // 6. Rotate back.
    const cosB = Math.cos(theta);
    const sinB = Math.sin(theta);
    const out = corners.map((p) => ({
      x: cx + (p.x - cx) * cosB - (p.y - cy) * sinB,
      y: cy + (p.x - cx) * sinB + (p.y - cy) * cosB,
    }));
    return { points: out, applied: true, angleDeg: (theta * 180) / Math.PI };
  } catch {
    return noop("rectify threw");
  }
}
