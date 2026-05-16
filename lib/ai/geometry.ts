import "server-only";
import type { SegmentedEavePolyline } from "./vision";
import type { RoofPolygon } from "./sam";
import { STORY_HEIGHT_FT } from "@/lib/types";
import type { EditableLine, Downspout, Measurements, Stories } from "@/lib/types";

const METERS_PER_FOOT = 0.3048;

type Pt = { x: number; y: number };

// Mercator scale for Google Static Maps. The image is rendered at scale=2
// so the effective meters-per-pixel is half the standard formula.
export function metersPerPixel(lat: number, zoom: number, scale = 2): number {
  return (
    (156543.03392 * Math.cos((lat * Math.PI) / 180)) /
    Math.pow(2, zoom) /
    scale
  );
}

export function pixelLengthToFeet(
  pixels: number,
  lat: number,
  zoom: number,
): number {
  const meters = pixels * metersPerPixel(lat, zoom);
  return meters / METERS_PER_FOOT;
}

/**
 * Convert a lat/lng pair into image-pixel coordinates within a Static Maps
 * tile centered at (centerLat, centerLng). Used to project the Solar API's
 * building bounding box onto the satellite image so we can point SAM at the
 * actual house (not the geocoded parcel centroid, which can be 50–100 ft off).
 */
export function latLngToImagePixel(
  lat: number,
  lng: number,
  centerLat: number,
  centerLng: number,
  zoom: number,
  imageWidth: number,
  imageHeight: number,
): Pt {
  const mpp = metersPerPixel(centerLat, zoom);
  // Earth approximations — good enough at zoom 20 over a single building.
  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const dxMeters = (lng - centerLng) * metersPerLng;
  const dyMeters = (lat - centerLat) * metersPerLat;
  return {
    x: Math.round(imageWidth / 2 + dxMeters / mpp),
    // Image Y axis grows downward; latitude grows northward → invert.
    y: Math.round(imageHeight / 2 - dyMeters / mpp),
  };
}

/**
 * Inverse of `latLngToImagePixel` — recover lat/lng from a pixel coord
 * inside the same Static Maps tile. Used after orthogonal regularization
 * (which happens in image-pixel space) so the DSM edge classifier can
 * still receive lat/lng inputs.
 */
export function imagePixelToLatLng(
  x: number,
  y: number,
  centerLat: number,
  centerLng: number,
  zoom: number,
  imageWidth: number,
  imageHeight: number,
): { lat: number; lng: number } {
  const mpp = metersPerPixel(centerLat, zoom);
  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos((centerLat * Math.PI) / 180);
  const dxMeters = (x - imageWidth / 2) * mpp;
  const dyMeters = -(y - imageHeight / 2) * mpp;
  return {
    lat: centerLat + dyMeters / metersPerLat,
    lng: centerLng + dxMeters / metersPerLng,
  };
}

export function polylineLengthPx(points: { x: number; y: number }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

const CANVAS_W = 900;
const CANVAS_H = 580;

/**
 * Vision returns coordinates in the source image's pixel space (e.g. 1280×1280).
 * Our SVG canvas uses a 900×580 viewBox and renders the satellite tile with
 * preserveAspectRatio="xMidYMid slice" — i.e. the image is scaled to COVER the
 * viewBox (cropping excess) rather than fit inside it. We mirror that exact
 * transform here so eave/downspout coords land on the displayed roof rather
 * than offset from it.
 */
export function transformToCanvas(
  pts: { x: number; y: number }[],
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number }[] {
  const scale = Math.max(CANVAS_W / imageWidth, CANVAS_H / imageHeight);
  const offsetX = (CANVAS_W - imageWidth * scale) / 2;
  const offsetY = (CANVAS_H - imageHeight * scale) / 2;
  return pts.map((p) => ({
    x: Math.round(p.x * scale + offsetX),
    y: Math.round(p.y * scale + offsetY),
  }));
}

/**
 * Merge consecutive eaves whose endpoints touch and whose directions are
 * within `angleToleranceDeg` of each other. A long architectural wall
 * traced through 3 near-collinear vertices reads as 3 short eaves in
 * the canvas; collapsing those into one continuous run matches how a
 * contractor would actually quote the job (one 38-ft drop, not three
 * 12/13/13-ft segments).
 *
 * Pass-through behavior:
 *   - Lines with a non-"eave" kind are kept as-is (we don't merge rakes).
 *   - Multi-vertex polylines (3+ points) are kept as-is.
 *   - Lines whose endpoints don't connect to a neighbor are kept.
 */
export function mergeCollinearEaves(
  lines: EditableLine[],
  endpointTolerancePx = 8,
  angleToleranceDeg = 10,
): EditableLine[] {
  if (lines.length < 2) return lines;

  // Only attempt merge on simple 2-vertex eaves. Anything else passes
  // through unchanged.
  const merged: EditableLine[] = [];
  const consumed = new Set<number>();
  const angleToleranceRad = (angleToleranceDeg * Math.PI) / 180;

  const angleOf = (a: Pt, b: Pt) => Math.atan2(b.y - a.y, b.x - a.x);
  const distSq = (a: Pt, b: Pt) =>
    (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
  const tolSq = endpointTolerancePx * endpointTolerancePx;

  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    const line = lines[i];
    if (line.kind !== "eave" || line.points.length !== 2) {
      merged.push(line);
      continue;
    }
    // Greedy merge: extend this line by chaining downstream eaves that
    // touch its endpoint and share its direction.
    let chain = [line.points[0], line.points[1]] as [Pt, Pt];
    consumed.add(i);
    let changed = true;
    while (changed) {
      changed = false;
      const head = chain[0];
      const tail = chain[1];
      const tailAngle = angleOf(head, tail);
      for (let j = 0; j < lines.length; j++) {
        if (consumed.has(j)) continue;
        const cand = lines[j];
        if (cand.kind !== "eave" || cand.points.length !== 2) continue;
        const candA = cand.points[0];
        const candB = cand.points[1];
        const candAngle = angleOf(candA, candB);
        let diff = Math.abs(((tailAngle - candAngle + Math.PI) % (2 * Math.PI)) - Math.PI);
        // Eaves are directional but a continuous run can be drawn
        // either direction — accept 180° flips by folding to [0, π/2].
        if (diff > Math.PI / 2) diff = Math.PI - diff;
        if (diff > angleToleranceRad) continue;
        // Endpoint connectivity: does candA or candB touch our tail?
        if (distSq(candA, tail) <= tolSq) {
          chain = [head, candB];
          consumed.add(j);
          changed = true;
          break;
        }
        if (distSq(candB, tail) <= tolSq) {
          chain = [head, candA];
          consumed.add(j);
          changed = true;
          break;
        }
        // Or the head — extend backward.
        if (distSq(candB, head) <= tolSq) {
          chain = [candA, tail];
          consumed.add(j);
          changed = true;
          break;
        }
        if (distSq(candA, head) <= tolSq) {
          chain = [candB, tail];
          consumed.add(j);
          changed = true;
          break;
        }
      }
    }
    merged.push({
      id: line.id, // keep the seed line's id so selection state survives a re-merge
      kind: "eave",
      points: [chain[0], chain[1]],
    });
  }
  return merged;
}

export function buildEditableLines(
  segs: SegmentedEavePolyline[],
  imageWidth: number,
  imageHeight: number,
): EditableLine[] {
  return segs.map((s) => ({
    id: s.id,
    kind: "eave",
    points: transformToCanvas(s.points, imageWidth, imageHeight),
  }));
}

/**
 * Douglas–Peucker line simplification. Collapses near-colinear vertices so a
 * noisy SAM polygon (often 30–80 verts) becomes a clean architectural outline
 * (typically 6–14 verts that match the actual roof corners).
 */
export function simplify(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points;
  let maxDist = 0;
  let index = 0;
  const last = points.length - 1;
  for (let i = 1; i < last; i++) {
    const d = perpendicularDistance(points[i], points[0], points[last]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const left = simplify(points.slice(0, index + 1), epsilon);
    const right = simplify(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[last]];
}

/**
 * Test whether a closed polygon's edges cross each other. After ortho
 * regularization on a complex hip+gable roof the snap-to-axis pass can
 * produce self-folding polygons (an inside corner of one wing collides
 * with another wing). Detected via O(n²) edge-pair intersection — n is
 * tiny here (rarely above 30 verts) so a smarter sweep would be wasted.
 */
export function polygonSelfIntersects(points: Pt[]): boolean {
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip adjacent edges and the wrap-around edge that shares a vertex.
      if (j === i + 1) continue;
      if (i === 0 && j === n - 1) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function segmentsIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = cross(p4.x - p3.x, p4.y - p3.y, p1.x - p3.x, p1.y - p3.y);
  const d2 = cross(p4.x - p3.x, p4.y - p3.y, p2.x - p3.x, p2.y - p3.y);
  const d3 = cross(p2.x - p1.x, p2.y - p1.y, p3.x - p1.x, p3.y - p1.y);
  const d4 = cross(p2.x - p1.x, p2.y - p1.y, p4.x - p1.x, p4.y - p1.y);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/**
 * Point-in-polygon test (ray-cast). Used to filter out ridge/valley
 * labels that fall outside the building's perimeter — those almost
 * always mean the vision model placed the line in the yard.
 */
export function pointInPolygon(p: Pt, polygon: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (
      (a.y > p.y) !== (b.y > p.y) &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Snap a closed polygon to its dominant rectilinear grid. Most residential
 * roofs sit on perpendicular wall axes — the raw mask boundary is jagged
 * because mask pixels are 0.5m squares but the building wall is typically
 * straighter than that. After Douglas–Peucker simplifies away most of the
 * jaggedness, this regularizer:
 *
 *   1. Finds the dominant edge angle θ (mod 90°) — every edge is either
 *      "along θ" or "perpendicular to θ".
 *   2. Rotates the polygon so θ becomes horizontal.
 *   3. Merges adjacent same-axis edges (a 5° kink between two horizontals
 *      is just simplification noise; collapse it to a single horizontal).
 *   4. For each horizontal edge, forces its two endpoints to share a y
 *      (the average of their original ys). Mirrors that for vertical
 *      edges. Each vertex is the corner of exactly one H and one V edge,
 *      so x and y constraints don't conflict.
 *   5. Rotates back.
 *
 * Result: the building outline becomes a clean staircase of right angles,
 * which is what residential roofs actually look like from above.
 */
export function orthogonalizePolygon(points: Pt[]): Pt[] {
  if (points.length < 4) return points;

  // 1. Dominant angle: histogram of edge angles modulo π/2 (i.e. fold
  // four-fold-symmetric bins). Weight each angle by its edge length so
  // long walls dominate over short noise edges.
  const BINS = 90;
  const buckets = new Array<number>(BINS).fill(0);
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    let ang = Math.atan2(dy, dx);
    // Fold to [0, π/2) — we don't care about direction, only orientation.
    ang = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    const bin = Math.min(BINS - 1, Math.floor((ang / (Math.PI / 2)) * BINS));
    buckets[bin] += len;
  }
  let peakBin = 0;
  for (let i = 1; i < BINS; i++) {
    if (buckets[i] > buckets[peakBin]) peakBin = i;
  }
  const theta = ((peakBin + 0.5) / BINS) * (Math.PI / 2);

  // 2. Rotate around centroid by -θ.
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;
  const cosT = Math.cos(-theta);
  const sinT = Math.sin(-theta);
  let rotated: Pt[] = points.map((p) => ({
    x: cx + (p.x - cx) * cosT - (p.y - cy) * sinT,
    y: cy + (p.x - cx) * sinT + (p.y - cy) * cosT,
  }));

  // 3. Classify each edge as H (horizontal-ish) or V; merge adjacent
  // same-class edges by dropping the shared vertex. Repeat until stable —
  // a single pass can leave runs of 3+ same-class edges if simplification
  // produced near-collinear segments.
  const classify = (a: Pt, b: Pt): "H" | "V" =>
    Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? "H" : "V";
  let changed = true;
  while (changed && rotated.length > 4) {
    changed = false;
    for (let i = 0; i < rotated.length; i++) {
      const prev = rotated[(i - 1 + rotated.length) % rotated.length];
      const curr = rotated[i];
      const next = rotated[(i + 1) % rotated.length];
      const c1 = classify(prev, curr);
      const c2 = classify(curr, next);
      if (c1 === c2) {
        rotated.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (rotated.length < 4) {
    // Degenerate (ortho regularization collapsed it) — return original
    // simplified polygon, the caller will still get usable edges.
    return points;
  }

  // 4. Snap each H edge to a constant y (avg of endpoints), each V edge
  // to a constant x. Apply in two passes so each vertex's x and y are
  // both set independently by their respective H/V edges.
  const snapped = rotated.map((p) => ({ ...p }));
  for (let i = 0; i < snapped.length; i++) {
    const a = snapped[i];
    const b = snapped[(i + 1) % snapped.length];
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

  // 5. Rotate back by +θ around centroid.
  const cosTb = Math.cos(theta);
  const sinTb = Math.sin(theta);
  return snapped.map((p) => ({
    x: cx + (p.x - cx) * cosTb - (p.y - cy) * sinTb,
    y: cy + (p.x - cx) * sinTb + (p.y - cy) * cosTb,
  }));
}

function perpendicularDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  return Math.hypot(p.x - px, p.y - py);
}

/**
 * Convert a SAM 2 roof polygon into one EditableLine per perimeter edge.
 *
 * On a top-down satellite view the polygon outline IS the gutter perimeter —
 * every outer edge of the roof's footprint is an eave (rakes are sloped
 * surfaces visible only from the side and don't show in the footprint
 * outline). So we walk the simplified polygon and emit one straight eave
 * segment per side.
 */
export function eavesFromRoofPolygon(
  polygon: RoofPolygon,
  imageWidth: number,
  imageHeight: number,
): EditableLine[] {
  // 1. Map polygon points from image-pixel space to canvas space
  const pts = transformToCanvas(polygon.points, imageWidth, imageHeight);
  if (pts.length < 3) return [];

  // 2. Simplify to architectural corners. epsilon=6px works well for roofs
  // segmented at zoom-20 satellite tiles.
  const simplified = simplify(pts, 6);
  if (simplified.length < 3) return [];

  // 3. Drop edges shorter than ~3 ft of canvas distance (noise from
  // serrated roof lines or imperfect masking).
  const MIN_EDGE_PX = 18;
  const lines: EditableLine[] = [];
  for (let i = 0; i < simplified.length; i++) {
    const a = simplified[i];
    const b = simplified[(i + 1) % simplified.length];
    if (Math.hypot(a.x - b.x, a.y - b.y) < MIN_EDGE_PX) continue;
    lines.push({
      id: `sam-eave-${i}`,
      kind: "eave",
      points: [a, b],
    });
  }
  return lines;
}

/**
 * Normalize a polygon to counter-clockwise winding so all downstream
 * geometric math (corner classification, outward-normal computation)
 * has a deterministic input regardless of how the polygon arrived.
 *
 * NOTE: image coords have y pointing DOWN, so the shoelace sign is
 * INVERTED from the math-class convention (where y points up).
 *   - Shoelace > 0 in y-down → polygon is CLOCKWISE on screen
 *   - Shoelace < 0 in y-down → polygon is COUNTER-CLOCKWISE on screen
 * The previous corner classifier got this backwards and reported
 * inside/outside in reverse — e.g. a normal hip+gable house showed
 * "2 outside, 9 inside" when the real ratio was 9 outside, 2 inside.
 */
export function ensureCCW<T extends Pt>(polygon: T[]): T[] {
  if (polygon.length < 3) return polygon;
  let signedArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    signedArea += (b.x - a.x) * (b.y + a.y);
  }
  // In y-down image coords, shoelace > 0 means clockwise → reverse it.
  return signedArea > 0 ? [...polygon].reverse() : polygon;
}

/**
 * Count outside vs inside corners on the building polygon by signed
 * cross-product at each vertex. Outside = convex (polygon turns
 * outward, e.g. the four corners of a rectangular wing), inside =
 * concave (polygon turns inward, e.g. the notch where an L-shape
 * meets). Replaces the prior 70/30 heuristic with the actual geometric
 * truth — matters for trim/coupler pricing where outside and inside
 * corners use different parts.
 *
 * Fix vs prior version: normalize to CCW first, then for a CCW polygon
 * in y-down screen coords, cross < 0 → right turn → OUTSIDE corner.
 * The previous version flipped that sign and reported the counts
 * inverted on every real house we tested.
 */
export function classifyPolygonCorners(
  polygon: RoofPolygon,
  imageWidth: number,
  imageHeight: number,
): { outside: number; inside: number } {
  const pts = ensureCCW(
    simplify(
      transformToCanvas(polygon.points, imageWidth, imageHeight),
      6,
    ),
  );
  if (pts.length < 3) return { outside: 0, inside: 0 };

  let outside = 0;
  let inside = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const curr = pts[i];
    const next = pts[(i + 1) % pts.length];
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const cross = v1x * v2y - v1y * v2x;
    if (Math.abs(cross) < 1e-6) continue; // collinear — not a corner
    // CCW polygon, y-down screen coords:
    //   cross < 0 → right turn at this vertex → OUTSIDE corner
    //   cross > 0 → left turn → INSIDE corner (concave)
    if (cross < 0) outside++;
    else inside++;
  }
  return { outside, inside };
}

/**
 * Walk a polygon's vertices and return only the convex (outside) corners.
 * Convex = the polygon turns "outward" at that vertex when walked clockwise.
 * Outside corners are where downspouts naturally drop.
 */
export function convexCornersOf(
  polygon: RoofPolygon,
  imageWidth: number,
  imageHeight: number,
): Pt[] {
  const pts = simplify(
    transformToCanvas(polygon.points, imageWidth, imageHeight),
    6,
  );
  if (pts.length < 3) return [];

  // Determine winding order — sum signed area; positive = counter-clockwise
  // in screen coords (y-down), negative = clockwise. We'll mirror the
  // convexity check accordingly.
  let signedArea = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    signedArea += (b.x - a.x) * (b.y + a.y);
  }
  const cwSign = signedArea > 0 ? 1 : -1;

  const corners: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const curr = pts[i];
    const next = pts[(i + 1) % pts.length];
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const cross = v1x * v2y - v1y * v2x;
    if (cross * cwSign > 0) corners.push(curr);
  }
  return corners;
}

/**
 * Place downspouts along a roof's eave perimeter at roughly one per
 * 30 LF, biased toward outside corners (where rainwater naturally
 * concentrates from two adjacent runs).
 *
 * Earlier behavior was "one downspout per convex corner of the polygon"
 * — fine for a 4-corner box but produced 16+ downspouts on a complex
 * 16-corner hip+gable roof, which is far more than any contractor
 * actually installs. Real homes use 4–8 downspouts on strategic corners.
 *
 * Algorithm:
 *   1. Target count = max(2, round(totalEaveLF / 30)).
 *   2. Score every outside corner by the length of its longer adjacent
 *      eave run; corners flanked by long runs catch more water.
 *   3. Pick the top N by score with a min-spacing constraint so we don't
 *      cluster two downspouts within 60 px of each other.
 *   4. If we still need more (rare — only when a single uninterrupted
 *      eave is longer than 35 LF), drop a mid-run downspout there.
 */
export function placeDownspoutsOnPolygon(
  polygon: RoofPolygon,
  eaveLines: EditableLine[],
  imageWidth: number,
  imageHeight: number,
  defaultStories: Stories = 2,
  pxPerFt = 2.4,
  /** Canvas-space valley polylines from the roof-structure overlay.
   *  When supplied, each valley's lower endpoint (the higher y in screen
   *  coords) becomes a high-priority downspout location — valleys
   *  concentrate flow from two adjacent roof planes, and the bottom of
   *  the V is where the contractor would naturally drop a leader. */
  valleys: { points: Pt[] }[] = [],
): Downspout[] {
  const heightFt = STORY_HEIGHT_FT[defaultStories];
  const placed: Downspout[] = [];

  // Valley discharge points come first — they're driven by water
  // physics, not optimization. Pick the LOWER endpoint of each valley
  // (higher y in screen-down coords) and snap it onto the nearest eave
  // so the marker visually sits on the gutter line, not floating mid-
  // roof.
  let valleyIdx = 0;
  for (const v of valleys) {
    if (v.points.length < 2) continue;
    const a = v.points[0];
    const b = v.points[v.points.length - 1];
    const lower = a.y > b.y ? a : b;
    // Snap to nearest eave endpoint within 40 px so the downspout
    // visually attaches to the gutter run that catches the discharge.
    let snapped = lower;
    let snapDist = 40;
    for (const line of eaveLines) {
      if (line.points.length < 2) continue;
      for (const ep of [
        line.points[0],
        line.points[line.points.length - 1],
      ]) {
        const d = Math.hypot(ep.x - lower.x, ep.y - lower.y);
        if (d < snapDist) {
          snapDist = d;
          snapped = ep;
        }
      }
    }
    placed.push({
      id: `ds-valley-${++valleyIdx}`,
      x: Math.round(snapped.x),
      y: Math.round(snapped.y),
      heightFt,
    });
  }

  let totalEaveFt = 0;
  for (const line of eaveLines) {
    if (line.points.length < 2) continue;
    const a = line.points[0];
    const b = line.points[line.points.length - 1];
    totalEaveFt += Math.hypot(b.x - a.x, b.y - a.y) / pxPerFt;
  }
  const targetCount = Math.max(2, Math.round(totalEaveFt / 30));

  // Score outside corners: each corner scores by the longer of its two
  // adjacent eave run lengths. Corners that join a long wall to a short
  // jog score about as well as corners between two long walls — both
  // need a downspout — but two short stubs together don't.
  const corners = convexCornersOf(polygon, imageWidth, imageHeight);
  type Scored = { x: number; y: number; score: number };
  const scored: Scored[] = corners.map((c) => {
    let bestRunPx = 0;
    for (const line of eaveLines) {
      if (line.points.length < 2) continue;
      const a = line.points[0];
      const b = line.points[line.points.length - 1];
      const lengthPx = Math.hypot(b.x - a.x, b.y - a.y);
      const distA = Math.hypot(a.x - c.x, a.y - c.y);
      const distB = Math.hypot(b.x - c.x, b.y - c.y);
      if (distA < 16 || distB < 16) bestRunPx = Math.max(bestRunPx, lengthPx);
    }
    return { x: c.x, y: c.y, score: bestRunPx };
  });
  scored.sort((a, b) => b.score - a.score);

  const MIN_SPACING_PX = 60;
  let i = 0;
  for (const cand of scored) {
    if (placed.length >= targetCount) break;
    const tooClose = placed.some(
      (p) => Math.hypot(p.x - cand.x, p.y - cand.y) < MIN_SPACING_PX,
    );
    if (tooClose) continue;
    placed.push({
      id: `ds-corner-${++i}`,
      x: cand.x,
      y: cand.y,
      heightFt,
    });
  }

  // Mid-run downspouts only when a single eave is genuinely too long
  // for one drain at each end (>35 ft uninterrupted run).
  const MAX_RUN_FT = 35;
  for (const line of eaveLines) {
    if (placed.length >= targetCount + 2) break;
    if (line.points.length < 2) continue;
    const a = line.points[0];
    const b = line.points[line.points.length - 1];
    const lengthFt = Math.hypot(b.x - a.x, b.y - a.y) / pxPerFt;
    if (lengthFt <= MAX_RUN_FT) continue;
    const midX = Math.round((a.x + b.x) / 2);
    const midY = Math.round((a.y + b.y) / 2);
    const tooClose = placed.some(
      (p) => Math.hypot(p.x - midX, p.y - midY) < MIN_SPACING_PX,
    );
    if (tooClose) continue;
    placed.push({
      id: `ds-mid-${line.id}`,
      x: midX,
      y: midY,
      heightFt,
    });
  }

  return placed;
}

/**
 * Heuristic downspout placement: 1 per ~35 LF, dropped at the endpoints
 * of the longest eave runs. Spread evenly along the perimeter so we don't
 * cluster too many on one wall.
 */
export function placeDownspouts(
  lines: EditableLine[],
  totalEaveLF: number,
  defaultStories: Stories = 2,
): Downspout[] {
  if (lines.length === 0 || totalEaveLF === 0) return [];

  const target = Math.max(2, Math.round(totalEaveLF / 35));

  // Score each line endpoint as a candidate
  const candidates: { x: number; y: number; weight: number }[] = [];
  for (const l of lines) {
    if (l.points.length < 2) continue;
    const start = l.points[0];
    const end = l.points[l.points.length - 1];
    const len = polylineLengthPx(l.points);
    candidates.push({ x: start.x, y: start.y, weight: len });
    candidates.push({ x: end.x, y: end.y, weight: len });
  }

  // Take the `target` highest-weighted candidates, but spaced (no two
  // candidates within 60px of each other).
  candidates.sort((a, b) => b.weight - a.weight);
  const chosen: { x: number; y: number }[] = [];
  for (const c of candidates) {
    if (chosen.length >= target) break;
    const tooClose = chosen.some(
      (k) => Math.hypot(k.x - c.x, k.y - c.y) < 60,
    );
    if (!tooClose) chosen.push({ x: c.x, y: c.y });
  }

  const heightFt = STORY_HEIGHT_FT[defaultStories];
  return chosen.map((c, i) => ({
    id: `ds-${i + 1}`,
    x: c.x,
    y: c.y,
    heightFt,
  }));
}

export function measurementsFromVision(args: {
  eaveLF: number;
  downspoutCount: number;
  cornerCount: number;
  stories?: Stories;
  /** When available, pre-computed outside/inside corner counts from the
   *  polygon geometry (via classifyPolygonCorners). When absent we fall
   *  back to a 70/30 split of cornerCount — kept for the vision and
   *  mock fallback paths where we don't have a polygon. */
  outsideCorners?: number;
  insideCorners?: number;
}): Measurements {
  return {
    eaveLF: Math.round(args.eaveLF),
    rakeLF: Math.round(args.eaveLF * 0.6),
    outsideCorners:
      args.outsideCorners ?? Math.max(4, Math.round(args.cornerCount * 0.7)),
    insideCorners:
      args.insideCorners ?? Math.max(0, Math.round(args.cornerCount * 0.3)),
    endCaps: Math.max(2, Math.round(args.eaveLF / 60)),
    downspoutCount: args.downspoutCount,
    stories: args.stories ?? 2,
    wasteFactorPct: 8,
  };
}

/**
 * Count corners by detecting where polylines meet at endpoints (within a
 * tolerance). A meeting point shared by 2+ lines = a corner.
 */
export function countCorners(lines: EditableLine[], tolerancePx = 14): number {
  const endpoints: { x: number; y: number }[] = [];
  for (const l of lines) {
    if (l.points.length === 0) continue;
    endpoints.push(l.points[0]);
    endpoints.push(l.points[l.points.length - 1]);
  }
  let corners = 0;
  const seen = new Set<number>();
  for (let i = 0; i < endpoints.length; i++) {
    if (seen.has(i)) continue;
    let cluster = 0;
    for (let j = i; j < endpoints.length; j++) {
      if (seen.has(j)) continue;
      if (
        Math.hypot(endpoints[i].x - endpoints[j].x, endpoints[i].y - endpoints[j].y) <
        tolerancePx
      ) {
        seen.add(j);
        cluster++;
      }
    }
    if (cluster >= 2) corners++;
  }
  return corners;
}
