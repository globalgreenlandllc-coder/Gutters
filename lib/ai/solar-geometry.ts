/**
 * solar-geometry.ts — PURE geometry for the solar-first estimate engine.
 *
 * Everything here operates on the dataLayers pixel grid: a projected UTM
 * raster where 1 px = a fixed number of METERS in both axes (north-up,
 * x → east, y → south). That uniformity is the whole point — lengths are
 * `pixels × metersPerPixel`, offsets are planar, and there is no Mercator
 * latitude correction anywhere.
 *
 * No "server-only", no fetch, no keys: the node test suite drives these
 * functions with synthetic masks and DSMs.
 */

import { simplify, orthogonalizePolygon, polygonSelfIntersects, ensureCCW } from "./geometry";
import { symmetricHausdorffPx } from "./roof-geom";

export type Pt = { x: number; y: number };

/* ------------------------------------------------------------------ */
/*  Mask cleanup: morphological close                                  */
/* ------------------------------------------------------------------ */

/**
 * Close (dilate then erode, square kernel) the building mask. The Solar
 * mask traces WALLS, so where two wings meet at a reentrant notch the
 * walls step in even though the ROOFS above merge — the traced footprint
 * then grows sub-meter notch edges that render as floating gutter stubs
 * on top of the visible roof. Closing bridges gaps up to ~2·radius and
 * leaves genuine courtyards/steps (wider than that) alone.
 *
 * Separable implementation: two 1-D dilate passes then two 1-D erode
 * passes — O(W·H·r), fine at 1000×1000 / r≈9.
 *
 * CALLER MUST GUARD against bridging to a NEIGHBOR building (the reason
 * an earlier morphological close was reverted in the legacy path): pick
 * the center component before/after and compare areas — a big jump means
 * the close swallowed something that isn't this house.
 */
export function closeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radiusPx: number,
): Uint8Array {
  const r = Math.max(0, Math.round(radiusPx));
  if (r === 0) return mask.slice();

  const pass = (
    src: Uint8Array,
    horizontal: boolean,
    op: "max" | "min",
  ): Uint8Array => {
    const out = new Uint8Array(width * height);
    const outer = horizontal ? height : width;
    const inner = horizontal ? width : height;
    for (let o = 0; o < outer; o++) {
      for (let i = 0; i < inner; i++) {
        let v = op === "max" ? 0 : 1;
        const lo = Math.max(0, i - r);
        const hi = Math.min(inner - 1, i + r);
        for (let k = lo; k <= hi; k++) {
          const idx = horizontal ? o * width + k : k * width + o;
          const s = src[idx] > 0 ? 1 : 0;
          if (op === "max") {
            if (s === 1) {
              v = 1;
              break;
            }
          } else if (s === 0) {
            v = 0;
            break;
          }
        }
        out[horizontal ? o * width + i : i * width + o] = v;
      }
    }
    return out;
  };

  let m = pass(mask, true, "max");
  m = pass(m, false, "max");
  m = pass(m, true, "min");
  m = pass(m, false, "min");
  return m;
}

/* ------------------------------------------------------------------ */
/*  Mask → footprint boundary                                          */
/* ------------------------------------------------------------------ */

/**
 * Trace the building footprint from a binary mask: pick the connected
 * component nearest the grid center (the requested address), BFS it,
 * Moore-trace its boundary. Returns null when there's no usable region.
 *
 * `touchesEdge` reports whether the traced component reaches the raster
 * border — i.e. the building may extend beyond the requested radius and
 * the caller should degrade trust (or re-fetch wider).
 */
export function traceMaskFootprint(
  mask: Uint8Array,
  width: number,
  height: number,
): { boundary: Pt[]; areaPx: number; touchesEdge: boolean } | null {
  const isFg = (x: number, y: number) => mask[y * width + x] > 0;

  const seed = findSeedNearCenter(width, height, isFg);
  if (!seed) return null;

  // BFS the seed's component: top-left start pixel for the Moore walk,
  // component pixel count, and whether it touches the raster border.
  const visited = new Uint8Array(width * height);
  const queue: number[] = [seed.y * width + seed.x];
  visited[queue[0]] = 1;
  let head = 0;
  let bestX = seed.x;
  let bestY = seed.y;
  let count = 0;
  let touchesEdge = false;
  const compMask = new Uint8Array(width * height);
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;
    count++;
    compMask[idx] = 1;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      touchesEdge = true;
    }
    if (y < bestY || (y === bestY && x < bestX)) {
      bestX = x;
      bestY = y;
    }
    if (x > 0 && !visited[idx - 1] && isFg(x - 1, y)) {
      visited[idx - 1] = 1;
      queue.push(idx - 1);
    }
    if (x < width - 1 && !visited[idx + 1] && isFg(x + 1, y)) {
      visited[idx + 1] = 1;
      queue.push(idx + 1);
    }
    if (y > 0 && !visited[idx - width] && isFg(x, y - 1)) {
      visited[idx - width] = 1;
      queue.push(idx - width);
    }
    if (y < height - 1 && !visited[idx + width] && isFg(x, y + 1)) {
      visited[idx + width] = 1;
      queue.push(idx + width);
    }
  }

  const compFg = (x: number, y: number) => compMask[y * width + x] === 1;
  const boundary = traceMooreNeighbor(width, height, compFg, {
    x: bestX,
    y: bestY,
  });
  if (boundary.length < 8) return null;
  return { boundary, areaPx: count, touchesEdge };
}

function findSeedNearCenter(
  width: number,
  height: number,
  isFg: (x: number, y: number) => boolean,
): Pt | null {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  if (isFg(cx, cy)) return { x: cx, y: cy };
  let nearest: Pt | null = null;
  let nearestDist = Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isFg(x, y)) continue;
      const dx = x - cx;
      const dy = y - cy;
      const d = dx * dx + dy * dy;
      if (d < nearestDist) {
        nearestDist = d;
        nearest = { x, y };
      }
    }
  }
  return nearest;
}

function traceMooreNeighbor(
  width: number,
  height: number,
  isFg: (x: number, y: number) => boolean,
  start: Pt,
): Pt[] {
  if (!isFg(start.x, start.y)) return [];
  const dirs: ReadonlyArray<readonly [number, number]> = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];
  const boundary: Pt[] = [{ x: start.x, y: start.y }];
  let cx = start.x;
  let cy = start.y;
  let backtrackDir = 6; // entered from the west
  const maxIters = width * height * 2;
  for (let iter = 0; iter < maxIters; iter++) {
    let found = false;
    for (let i = 0; i < 8; i++) {
      const dirIdx = (backtrackDir + 1 + i) % 8;
      const nx = cx + dirs[dirIdx][0];
      const ny = cy + dirs[dirIdx][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (isFg(nx, ny)) {
        backtrackDir = (dirIdx + 4) % 8;
        cx = nx;
        cy = ny;
        boundary.push({ x: cx, y: cy });
        found = true;
        break;
      }
    }
    if (!found) break;
    if (boundary.length > 8 && cx === start.x && cy === start.y) break;
  }
  if (
    boundary.length > 1 &&
    boundary[boundary.length - 1].x === boundary[0].x &&
    boundary[boundary.length - 1].y === boundary[0].y
  ) {
    boundary.pop();
  }
  return boundary;
}

/* ------------------------------------------------------------------ */
/*  Boundary cleanup: downsample → Douglas-Peucker → ortho snap        */
/* ------------------------------------------------------------------ */

export type CleanedFootprint = {
  points: Pt[];
  cleanup:
    | { kind: "ortho"; vertCount: number }
    | { kind: "simplified"; vertCount: number; reason: string };
};

/**
 * Collapse a raw boundary trace (one point per mask pixel) into an
 * architectural outline. Tolerances are given in METERS and converted
 * with the grid's uniform scale — the same numbers work at 0.1 and
 * 0.25 m/px.
 */
export function cleanFootprint(
  boundary: Pt[],
  metersPerPixel: number,
  opts?: {
    simplifyEpsM?: number;
    orthoMaxDriftM?: number;
  },
): CleanedFootprint | null {
  const epsPx = (opts?.simplifyEpsM ?? 0.45) / metersPerPixel;
  const maxDriftPx = (opts?.orthoMaxDriftM ?? 2) / metersPerPixel;

  const downsampled =
    boundary.length > 800
      ? boundary.filter((_, i) => i % Math.ceil(boundary.length / 800) === 0)
      : boundary;
  if (downsampled.length < 8) return null;

  const simplified = simplify(downsampled, epsPx);
  if (simplified.length < 4) return null;

  const ortho = orthogonalizePolygon(simplified);
  const orthoArea = polygonArea(ortho) / Math.max(1, polygonArea(simplified));
  const orthoOk =
    ortho.length >= 4 &&
    !polygonSelfIntersects(ortho) &&
    orthoArea >= 0.85 &&
    orthoArea <= 1.15 &&
    symmetricHausdorffPx(simplified, ortho) <= maxDriftPx;

  if (orthoOk) {
    return { points: ortho, cleanup: { kind: "ortho", vertCount: ortho.length } };
  }
  if (!polygonSelfIntersects(simplified)) {
    return {
      points: simplified,
      cleanup: {
        kind: "simplified",
        vertCount: simplified.length,
        reason:
          ortho.length < 4
            ? "ortho degenerate"
            : polygonSelfIntersects(ortho)
              ? "ortho self-intersected"
              : orthoArea < 0.85 || orthoArea > 1.15
                ? `ortho area ${(orthoArea * 100).toFixed(0)}%`
                : "ortho drifted",
      },
    };
  }
  return null;
}

export function polygonArea(points: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/* ------------------------------------------------------------------ */
/*  Planar outward offset (roof overhang)                              */
/* ------------------------------------------------------------------ */

/**
 * Offset a simple polygon outward by `offsetPx` — the roof/gutter line
 * sits past the wall the mask traces. Classic edge-translate + line
 * re-intersection with a miter cap; on the uniform UTM grid this is an
 * exact planar operation (the old path detoured through turf lat/lng
 * buffering).
 *
 * Falls back to the input when the offset degenerates (self-intersection
 * or area moving the wrong way) — an unbuffered footprint is a slightly
 * conservative gutter line, never garbage.
 */
export function offsetPolygonOutward(points: Pt[], offsetPx: number): Pt[] {
  if (points.length < 3 || offsetPx <= 0) return points;
  const ccw = ensureCCW(points);
  const n = ccw.length;

  // For a CCW polygon in y-down coords the interior is to the LEFT of
  // travel, so the outward normal of edge (a→b) is the RIGHT normal:
  // (-dy, dx) normalized... verify orientation via area growth below and
  // flip once if needed (cheaper than re-deriving conventions).
  const build = (sign: 1 | -1): Pt[] | null => {
    const out: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const prev = ccw[(i - 1 + n) % n];
      const curr = ccw[i];
      const next = ccw[(i + 1) % n];

      const off = (a: Pt, b: Pt) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return null;
        const nx = (sign * -dy) / len;
        const ny = (sign * dx) / len;
        return {
          a: { x: a.x + nx * offsetPx, y: a.y + ny * offsetPx },
          b: { x: b.x + nx * offsetPx, y: b.y + ny * offsetPx },
        };
      };
      const e1 = off(prev, curr);
      const e2 = off(curr, next);
      if (!e1 || !e2) continue;
      const inter = lineIntersection(e1.a, e1.b, e2.a, e2.b);
      // Miter cap at 2× the offset: covers a right angle (√2×) with
      // margin, but bevels acute corners — where wings meet at odd
      // angles a longer miter shoots a spike past the real roof corner
      // (the "eave endpoint hanging over the driveway" artifact).
      if (
        inter &&
        Math.hypot(inter.x - curr.x, inter.y - curr.y) <= offsetPx * 2
      ) {
        out.push(inter);
      } else {
        out.push({
          x: (e1.b.x + e2.a.x) / 2,
          y: (e1.b.y + e2.a.y) / 2,
        });
      }
    }
    return out.length >= 3 ? out : null;
  };

  const first = build(1);
  const grew = first && polygonArea(first) > polygonArea(ccw);
  const candidate = grew ? first : build(-1);
  if (!candidate) return points;
  if (polygonArea(candidate) <= polygonArea(ccw)) return points;
  if (polygonSelfIntersects(candidate)) return points;
  return candidate;
}

function lineIntersection(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/* ------------------------------------------------------------------ */
/*  DSM edge classification (eave vs rake)                             */
/* ------------------------------------------------------------------ */

export type DsmSampler = (x: number, y: number) => number | null;

export type EdgeVerdict = {
  kind: "eave" | "rake" | "unknown";
  reason: string;
};

/**
 * Classify one perimeter edge from the height field.
 *
 * Physical truth this encodes: a gutter hangs on an edge that water
 * drains TO — at each point along it, the roof surface RISES going
 * inward (upslope). A rake (gable edge) climbs from eave corner to ridge
 * corner along its run, and moving inward from it travels PARALLEL to
 * the ridge, so the surface does not rise.
 *
 * The verdict is a per-station VOTE, not a single whole-edge judgment:
 * a straight wall that fronts two roof tiers at different heights (very
 * common on custom homes) steps in height along the edge — judging the
 * edge by its total climb would misread that stepped eave as a rake and
 * silently drop real gutter. Stations vote independently on "does the
 * interior rise here"; the along-edge climb only calls RAKE when it is
 * MONOTONIC (a real slope, not tier steps).
 *
 * Sampling is inset toward the interior so we read shingles, not the
 * wall/ground discontinuity; each station takes the median of three
 * inset depths to shrug off DSM noise, vents and gutter shadows.
 * Interior samples that leave the building mask are discarded (narrow
 * wings would otherwise vote with the neighbor's lawn).
 *
 * All thresholds in meters; conversion uses the grid's uniform scale.
 */
export function classifyEdgeByDsm(
  a: Pt,
  b: Pt,
  interiorSign: { nx: number; ny: number },
  sample: DsmSampler,
  metersPerPixel: number,
  opts?: {
    alongSlopeMaxM?: number;
    interiorRiseMinM?: number;
    /** Restrict interior samples to the building mask when provided. */
    insideMask?: (x: number, y: number) => boolean;
  },
): EdgeVerdict {
  const alongSlopeMaxM = opts?.alongSlopeMaxM ?? 0.9;
  const interiorRiseMinM = opts?.interiorRiseMinM ?? 0.35;
  const insideMask = opts?.insideMask;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenPx = Math.hypot(dx, dy);
  const lenM = lenPx * metersPerPixel;
  if (lenM < 0.5) return { kind: "unknown", reason: "edge <0.5m" };

  const insetDepthsM = [0.5, 0.8, 1.1];
  // Stations along the edge, keeping clear of the corners (corner pixels
  // straddle two roof planes / the rake return).
  const stationCount = Math.max(3, Math.min(11, Math.round(lenM / 1.2)));
  const stations: number[] = [];
  for (let i = 0; i < stationCount; i++) {
    stations.push(0.15 + (0.7 * i) / Math.max(1, stationCount - 1));
  }

  const heightAt = (t: number): number | null => {
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const vals: number[] = [];
    for (const dM of insetDepthsM) {
      const dPx = dM / metersPerPixel;
      const v = sample(px + interiorSign.nx * dPx, py + interiorSign.ny * dPx);
      if (v != null && Number.isFinite(v)) vals.push(v);
    }
    if (vals.length === 0) return null;
    vals.sort((x, y) => x - y);
    return vals[Math.floor(vals.length / 2)];
  };

  // Per-station: near-edge height + interior rise vote.
  type Station = { t: number; h: number; rise: number | null };
  const profile: Station[] = [];
  for (const t of stations) {
    const h = heightAt(t);
    if (h == null) continue;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const interiorVals: number[] = [];
    for (const dM of [2.0, 2.8]) {
      const dPx = dM / metersPerPixel;
      const ix = px + interiorSign.nx * dPx;
      const iy = py + interiorSign.ny * dPx;
      if (insideMask && !insideMask(ix, iy)) continue;
      const v = sample(ix, iy);
      if (v != null && Number.isFinite(v)) interiorVals.push(v);
    }
    profile.push({
      t,
      h,
      rise: interiorVals.length > 0 ? median(interiorVals) - h : null,
    });
  }
  if (profile.length < 3) {
    return { kind: "unknown", reason: "DSM no-data along edge" };
  }

  const votes = profile.filter((s) => s.rise != null);
  const eaveVotes = votes.filter((s) => (s.rise as number) > 0.3).length;
  const eaveVoteFrac = votes.length > 0 ? eaveVotes / votes.length : 0;

  // Along-edge climb: robust spread between the low and high thirds…
  const hs = profile.map((p) => p.h).sort((x, y) => x - y);
  const third = Math.max(1, Math.floor(hs.length / 3));
  const alongDelta =
    median(hs.slice(hs.length - third)) - median(hs.slice(0, third));
  // …and whether that climb is MONOTONIC (real slope) or stepped (tiers).
  let up = 0;
  let down = 0;
  for (let i = 1; i < profile.length; i++) {
    const d = profile[i].h - profile[i - 1].h;
    if (d > 0.08) up++;
    else if (d < -0.08) down++;
  }
  const dominant = Math.max(up, down);
  const monoFrac =
    up + down > 0 ? dominant / (up + down) : 1;

  // 1. Most of the edge drains here → gutter, even when the wall steps
  //    across tiers or the total climb is large.
  if (votes.length >= 2 && eaveVoteFrac >= 0.6) {
    return {
      kind: "eave",
      reason: `interior rises at ${eaveVotes}/${votes.length} stations`,
    };
  }

  // 2. Real climb along the edge → rake.
  if (alongDelta > alongSlopeMaxM && monoFrac >= 0.7) {
    return {
      kind: "rake",
      reason: `climbs ${alongDelta.toFixed(2)}m monotonically along the edge`,
    };
  }

  // 3. Non-monotonic height change along the edge. Two very different
  //    roofs produce it, and the drainage votes tell them apart:
  //      • stepped tiers on one wall, both draining here → EAVE
  //      • a full-width gable end (tent profile: climbs to the ridge
  //        point then falls, nothing drains toward the wall) → RAKE
  if (alongDelta > alongSlopeMaxM) {
    if (votes.length >= 2 && eaveVoteFrac >= 0.4) {
      return {
        kind: "eave",
        reason: `stepped tiers, ${eaveVotes}/${votes.length} stations drain here`,
      };
    }
    if (votes.length >= 2 && eaveVoteFrac <= 0.15) {
      return {
        kind: "rake",
        reason: `${alongDelta.toFixed(2)}m height change along the edge, no stations drain here`,
      };
    }
    return {
      kind: "unknown",
      reason: `stepped ${alongDelta.toFixed(2)}m, drainage mixed (${eaveVotes}/${votes.length})`,
    };
  }

  // 4. Level edge: fall back to the aggregate interior rise.
  const riseVals = votes.map((s) => s.rise as number);
  if (riseVals.length === 0) {
    return { kind: "unknown", reason: "DSM no-data toward interior" };
  }
  const rise = median(riseVals);
  if (rise > interiorRiseMinM) {
    return {
      kind: "eave",
      reason: `level (Δ${alongDelta.toFixed(2)}m), interior +${rise.toFixed(2)}m`,
    };
  }
  if (rise < -interiorRiseMinM) {
    // Interior FALLS away — this edge is higher than the roof behind it
    // (upper tier's back edge / parapet-ish). Not a gutter line.
    return {
      kind: "rake",
      reason: `level but interior drops ${(-rise).toFixed(2)}m`,
    };
  }
  return {
    kind: "unknown",
    reason: `level, interior flat (${rise >= 0 ? "+" : ""}${rise.toFixed(2)}m)`,
  };
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Compass azimuth (0=N, 90=E) of an edge's outward normal, on the
 * north-up grid (x → east, y → south). `interiorSign` is the unit normal
 * pointing INWARD; the outward is its negation.
 */
export function outwardNormalAzimuthDeg(interiorSign: {
  nx: number;
  ny: number;
}): number {
  const ox = -interiorSign.nx; // east component
  const oy = -interiorSign.ny; // south component (grid y)
  // North component = -oy.
  const deg = (Math.atan2(ox, -oy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Unit normal of edge (a→b) pointing toward the polygon interior
 *  (approximated by the centroid — fine for building footprints). */
export function interiorNormal(a: Pt, b: Pt, centroid: Pt): { nx: number; ny: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if (nx * (centroid.x - mx) + ny * (centroid.y - my) < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { nx, ny };
}

export function polygonCentroid(points: Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

/* ------------------------------------------------------------------ */
/*  Stories from the DSM                                               */
/* ------------------------------------------------------------------ */

/**
 * Estimate eave height above ground:
 *   eave  = median DSM just inside the perimeter (the gutter line)
 *   ground = low percentile of DSM in a ring OUTSIDE the footprint
 *            (mask-negative pixels only, so a neighbor's roof or a
 *            parked RV doesn't read as "ground")
 * Returns null when either sample set is too thin.
 */
export function eaveHeightAboveGroundM(args: {
  ring: Pt[];
  mask: Uint8Array;
  width: number;
  height: number;
  sample: DsmSampler;
  metersPerPixel: number;
}): number | null {
  const { ring, mask, width, height, sample, metersPerPixel } = args;
  if (ring.length < 3) return null;
  const centroid = polygonCentroid(ring);

  // Eave-line heights: inset 0.7 m inside each edge midpointish stations.
  const eaveHs: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const nrm = interiorNormal(a, b, centroid);
    const dPx = 0.7 / metersPerPixel;
    for (const t of [0.3, 0.5, 0.7]) {
      const v = sample(
        a.x + (b.x - a.x) * t + nrm.nx * dPx,
        a.y + (b.y - a.y) * t + nrm.ny * dPx,
      );
      if (v != null && Number.isFinite(v)) eaveHs.push(v);
    }
  }
  if (eaveHs.length < 4) return null;
  // 25th percentile ≈ the LOW eave line (upper-story eaves and ridgey
  // samples pull the median up; gutters hang at the low line).
  eaveHs.sort((a, b) => a - b);
  const eaveH = eaveHs[Math.floor(eaveHs.length * 0.25)];

  // Ground ring: sample a band 2–8 m outside the polygon bbox edges,
  // keeping only mask-negative pixels.
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const bandPx = 8 / metersPerPixel;
  const stepPx = Math.max(1, Math.round(1 / metersPerPixel));
  const groundHs: number[] = [];
  const tryGround = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
    if (mask[yi * width + xi] > 0) return;
    const v = sample(xi, yi);
    if (v != null && Number.isFinite(v)) groundHs.push(v);
  };
  for (let x = minX - bandPx; x <= maxX + bandPx; x += stepPx) {
    for (const y of [minY - bandPx / 2, maxY + bandPx / 2, minY - bandPx, maxY + bandPx]) {
      tryGround(x, y);
    }
  }
  for (let y = minY - bandPx; y <= maxY + bandPx; y += stepPx) {
    for (const x of [minX - bandPx / 2, maxX + bandPx / 2, minX - bandPx, maxX + bandPx]) {
      tryGround(x, y);
    }
  }
  if (groundHs.length < 12) return null;
  groundHs.sort((a, b) => a - b);
  // 15th percentile: below the median of bushes/cars, above DSM voids.
  const groundH = groundHs[Math.floor(groundHs.length * 0.15)];

  const h = eaveH - groundH;
  if (!Number.isFinite(h) || h < 1 || h > 20) return null;
  return h;
}

/* ------------------------------------------------------------------ */
/*  Raster crop                                                        */
/* ------------------------------------------------------------------ */

export type CropWindow = { x: number; y: number; width: number; height: number };

/** Clamped crop window around a bbox with margin (all in px). */
export function cropWindowAround(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  marginPx: number,
  width: number,
  height: number,
): CropWindow {
  const x0 = Math.max(0, Math.floor(bbox.minX - marginPx));
  const y0 = Math.max(0, Math.floor(bbox.minY - marginPx));
  const x1 = Math.min(width, Math.ceil(bbox.maxX + marginPx));
  const y1 = Math.min(height, Math.ceil(bbox.maxY + marginPx));
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

export function cropUint8(
  src: Uint8Array,
  width: number,
  win: CropWindow,
  channels = 1,
): Uint8Array {
  const out = new Uint8Array(win.width * win.height * channels);
  for (let y = 0; y < win.height; y++) {
    const srcStart = ((win.y + y) * width + win.x) * channels;
    out.set(src.subarray(srcStart, srcStart + win.width * channels), y * win.width * channels);
  }
  return out;
}

export function cropFloat32(
  src: Float32Array,
  width: number,
  win: CropWindow,
): Float32Array {
  const out = new Float32Array(win.width * win.height);
  for (let y = 0; y < win.height; y++) {
    const srcStart = (win.y + y) * width + win.x;
    out.set(src.subarray(srcStart, srcStart + win.width), y * win.width);
  }
  return out;
}
