/**
 * rectify-plan-takeoff.ts — square up a RASTER-plan vision takeoff.
 *
 * When a plan set is a scanned / flattened PDF (every page is one image, zero
 * vector linework — the "FOR PRICING PURPOSES ONLY" export), the precise
 * vector engine can't run and the footprint is a pure VISION trace. That trace
 * comes back nearly-rectilinear but with one or two walls a few degrees off —
 * which renders as a "totally wrong" diagonal eave even when the total LF is in
 * range. Because the gutter runs and downspouts are traced in the SAME point
 * space as that footprint, they inherit the same skew.
 *
 * This pass squares the footprint onto true horizontal/vertical walls and
 * carries every follower point (gutter-run endpoints, excluded-edge endpoints,
 * downspouts) along by projecting each onto the cleaned perimeter — so a run on
 * the fixed wall becomes straight and a stray downspout snaps back onto the
 * gutter line instead of floating mid-canvas.
 *
 * HARD-GATED so it only ever cleans, never reshapes:
 *   - bails unless the outline is already ≥80% axis-aligned (a genuinely
 *     diagonal roof / angled wing keeps its true geometry — we don't square a
 *     shape that isn't meant to be square),
 *   - bails if squaring drifts the area >10% or shoves any corner >15% of the
 *     bbox diagonal (that's a reshape, not a cleanup).
 *
 * Mirrors the per-edge forcing in geometry.ts `orthogonalizePolygon` (used on
 * the satellite path) but is self-contained and PURE (no server-only / DOM) so
 * it is node-testable and safe to reason about in isolation. Intended ONLY for
 * the raw-vision footprint fallback — the vector-derived outlines (v2 / A9 / A4)
 * are already clean and must not be touched.
 */

export type RPt = { x: number; y: number };

const polyArea = (pts: RPt[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

/** Drop a closing duplicate vertex so the ring is open (first !== last). */
function openRing(pts: RPt[]): RPt[] {
  if (
    pts.length >= 2 &&
    Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-9 &&
    Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-9
  ) {
    return pts.slice(0, -1);
  }
  return pts;
}

/** Dominant orientation (radians, folded to [0, π/2)) — the Manhattan angle of
 *  the outline. Uses the MODE, not the mean: a length-weighted histogram picks
 *  the peak bin (so one outlier wall can't tilt the whole house), then refines
 *  θ as the circular mean of just the edges inside that peak (the true axis
 *  walls), excluding the outlier. Returns null if there's no orientation. */
function dominantAngle(pts: RPt[]): number | null {
  const HALF_PI = Math.PI / 2;
  const BINS = 180; // 0.5° resolution over [0, π/2)
  const buckets = new Array<number>(BINS).fill(0);
  let anyLen = false;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    anyLen = true;
    const ang = ((Math.atan2(b.y - a.y, b.x - a.x) % HALF_PI) + HALF_PI) % HALF_PI;
    buckets[Math.min(BINS - 1, Math.floor((ang / HALF_PI) * BINS))] += len;
  }
  if (!anyLen) return null;
  let peak = 0;
  for (let i = 1; i < BINS; i++) if (buckets[i] > buckets[peak]) peak = i;
  const coarse = ((peak + 0.5) / BINS) * HALF_PI;

  // Refine: circular mean of 4θ over edges within 3° of the peak — the axis
  // walls reinforce each other; the off-axis outlier is excluded.
  const TOL = (3 * Math.PI) / 180;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const ang = ((Math.atan2(b.y - a.y, b.x - a.x) % HALF_PI) + HALF_PI) % HALF_PI;
    // Circular distance to the coarse peak on the [0, π/2) ring.
    let d = Math.abs(ang - coarse);
    d = Math.min(d, HALF_PI - d);
    if (d <= TOL) {
      sx += len * Math.cos(4 * ang);
      sy += len * Math.sin(4 * ang);
    }
  }
  if (Math.hypot(sx, sy) < 1e-9) return coarse;
  const refined = Math.atan2(sy, sx) / 4;
  return ((refined % HALF_PI) + HALF_PI) % HALF_PI;
}

const rotateAbout = (p: RPt, cx: number, cy: number, cos: number, sin: number): RPt => ({
  x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
  y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
});

/** Fraction of the perimeter that runs within `tolDeg` of an axis, measured in
 *  the ring's own dominant frame. 1.0 = perfectly rectilinear. */
function axisAlignedFraction(rot: RPt[], tolDeg: number): number {
  const AX = Math.tan((tolDeg * Math.PI) / 180);
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
  return totalLen > 0 ? axisLen / totalLen : 0;
}

/** Force a nearly-rectilinear ring (already rotated into its axis frame) onto
 *  true H/V walls. Merges near-collinear same-class edges, then snaps each
 *  H edge to a shared y and each V edge to a shared x. Returns null if it
 *  collapses below 4 corners. `keptIdx[j]` is the ORIGINAL index of surviving
 *  corner j — so a follower sitting on an original corner can be sent to the
 *  same corner after squaring, instead of projected onto whichever wall is
 *  nearest. */
function snapAxisRing(rotIn: RPt[]): { ring: RPt[]; keptIdx: number[] } | null {
  const rot = rotIn.map((p) => ({ ...p }));
  const keptIdx = rotIn.map((_, i) => i);
  const classify = (a: RPt, b: RPt): "H" | "V" =>
    Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? "H" : "V";

  // Merge adjacent same-class edges (a slight kink split into two H segments is
  // noise) by dropping the shared vertex. Repeat until stable.
  let changed = true;
  while (changed && rot.length > 4) {
    changed = false;
    for (let i = 0; i < rot.length; i++) {
      const prev = rot[(i - 1 + rot.length) % rot.length];
      const curr = rot[i];
      const next = rot[(i + 1) % rot.length];
      if (classify(prev, curr) === classify(curr, next)) {
        rot.splice(i, 1);
        keptIdx.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (rot.length < 4) return null;

  for (let i = 0; i < rot.length; i++) {
    const a = rot[i];
    const b = rot[(i + 1) % rot.length];
    if (classify(a, b) === "H") {
      const y = (a.y + b.y) / 2;
      a.y = y;
      b.y = y;
    } else {
      const x = (a.x + b.x) / 2;
      a.x = x;
      b.x = x;
    }
  }
  return { ring: rot, keptIdx };
}

/** Nearest point on segment a→b to p, plus the squared distance. */
function nearestOnSeg(p: RPt, a: RPt, b: RPt): { pt: RPt; d2: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const pt = { x: a.x + t * dx, y: a.y + t * dy };
  const ex = p.x - pt.x;
  const ey = p.y - pt.y;
  return { pt, d2: ex * ex + ey * ey };
}

/** Nearest point on the closed ring to p. */
function nearestOnRing(ring: RPt[], p: RPt): RPt {
  let best = { x: p.x, y: p.y };
  let bestD2 = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const { pt, d2 } = nearestOnSeg(p, a, b);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = pt;
    }
  }
  return best;
}

export type RectifyPlanResult = {
  /** True when the squaring was applied; false = inputs returned unchanged. */
  applied: boolean;
  /** Dominant orientation (degrees, mod 90) that was squared against. */
  angleDeg: number;
  /** Why it bailed, when applied === false. */
  reason?: string;
  /** The squared footprint (or the input, unchanged, when applied === false). */
  footprint: RPt[];
  /** Followers projected onto the squared perimeter, in input order
   *  (or the inputs, unchanged, when applied === false). */
  followers: RPt[];
};

/**
 * Square up a raw-vision plan footprint and carry its follower points onto the
 * cleaned perimeter. `followers` are every point traced in the same space as
 * the footprint that must stay on the perimeter after squaring — flatten your
 * gutter-run endpoints, excluded-edge endpoints, and downspout positions into
 * this list and unflatten the result in the same order.
 */
export function rectifyPlanFootprint(
  footprintIn: RPt[],
  followers: RPt[],
  opts?: {
    /** Minimum axis-aligned perimeter fraction to act (default 0.80). */
    minAxisFrac?: number;
    /** Max area drift allowed (default 0.10 = 10%). */
    maxAreaDriftFrac?: number;
    /** Max single-corner move, as a fraction of the bbox diagonal (default 0.15). */
    maxCornerDriftFrac?: number;
    /** Off-axis tolerance for the rectilinear test, degrees (default 14). */
    axisTolDeg?: number;
  },
): RectifyPlanResult {
  const passthrough = (reason: string): RectifyPlanResult => ({
    applied: false,
    angleDeg: 0,
    reason,
    footprint: footprintIn,
    followers,
  });
  try {
    const minAxisFrac = opts?.minAxisFrac ?? 0.8;
    const maxAreaDriftFrac = opts?.maxAreaDriftFrac ?? 0.1;
    const maxCornerDriftFrac = opts?.maxCornerDriftFrac ?? 0.15;
    const axisTolDeg = opts?.axisTolDeg ?? 14;

    const fp = openRing(footprintIn);
    if (fp.length < 4) return passthrough("fewer than 4 corners");
    if (!fp.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
      return passthrough("non-finite footprint point");

    let theta = dominantAngle(fp);
    if (theta == null) return passthrough("no dominant orientation");
    // Plans are drawn SQUARE to the page — a plan sheet is never rotated, so a
    // dominant angle within ~2° of the raw axes is vision noise, not a tilted
    // house. Snap it to exactly 0 so every wall is forced to true horizontal /
    // vertical (a lone 6°-off wall included), instead of tilting the whole
    // outline to split the difference. A genuinely tilted trace keeps its angle.
    const devFromAxis = Math.min(theta, Math.PI / 2 - theta);
    if (devFromAxis < (2 * Math.PI) / 180) theta = 0;

    const cx = fp.reduce((s, p) => s + p.x, 0) / fp.length;
    const cy = fp.reduce((s, p) => s + p.y, 0) / fp.length;
    const cosN = Math.cos(-theta);
    const sinN = Math.sin(-theta);
    const rot = fp.map((p) => rotateAbout(p, cx, cy, cosN, sinN));

    // GATE 1: only square shapes that are already meant to be square.
    const axisFrac = axisAlignedFraction(rot, axisTolDeg);
    if (axisFrac < minAxisFrac)
      return passthrough(`only ${Math.round(axisFrac * 100)}% axis-aligned — kept diagonal geometry`);

    const snapped = snapAxisRing(rot);
    if (!snapped) return passthrough("squaring collapsed the ring");

    // Rotate the squared ring back to the original frame.
    const cosB = Math.cos(theta);
    const sinB = Math.sin(theta);
    const squared = snapped.ring.map((p) => rotateAbout(p, cx, cy, cosB, sinB));
    // origIdx (into fp) → squared position, for surviving corners.
    const cornerFor = new Map<number, RPt>();
    snapped.keptIdx.forEach((oi, j) => cornerFor.set(oi, squared[j]));

    // GATE 2: area must be preserved — cleaning, not reshaping.
    const a0 = polyArea(fp);
    const a1 = polyArea(squared);
    if (!(a0 > 0)) return passthrough("degenerate footprint area");
    if (Math.abs(a1 - a0) / a0 > maxAreaDriftFrac)
      return passthrough(`squaring drifted area ${Math.round((Math.abs(a1 - a0) / a0) * 100)}%`);

    // GATE 3: no corner may be shoved more than a fraction of the bbox diagonal.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of fp) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const bboxDiag = Math.hypot(x1 - x0, y1 - y0);
    if (bboxDiag > 0) {
      let maxMove = 0;
      for (const s of squared) {
        let nearest = Infinity;
        for (const o of fp) nearest = Math.min(nearest, Math.hypot(s.x - o.x, s.y - o.y));
        maxMove = Math.max(maxMove, nearest);
      }
      if (maxMove / bboxDiag > maxCornerDriftFrac)
        return passthrough(`squaring moved a corner ${Math.round((maxMove / bboxDiag) * 100)}% of the bbox`);
    }

    // Carry every follower onto the squared perimeter. A follower sitting on an
    // original CORNER (gutter-run endpoint, corner downspout) follows that
    // corner to its squared position — so a run keeps its two endpoints on the
    // right walls. A mid-wall follower (a run ending mid-eave, a long-run-relief
    // downspout, a stray misread) projects onto the nearest squared wall.
    const cornerTol = bboxDiag * 0.025;
    const outFollowers = followers.map((f) => {
      if (!Number.isFinite(f?.x) || !Number.isFinite(f?.y)) return f;
      let bestI = -1;
      let bestD = Infinity;
      for (let i = 0; i < fp.length; i++) {
        const d = Math.hypot(f.x - fp[i].x, f.y - fp[i].y);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      const corner = bestI >= 0 ? cornerFor.get(bestI) : undefined;
      if (corner && bestD <= cornerTol) return { x: corner.x, y: corner.y };
      return nearestOnRing(squared, f);
    });

    return {
      applied: true,
      angleDeg: ((theta * 180) / Math.PI + 360) % 90,
      footprint: squared,
      followers: outFollowers,
    };
  } catch {
    return passthrough("rectify threw");
  }
}
