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
 * Drop a downspout at every outside corner of the polygon, then add extra
 * downspouts in the middle of any single eave longer than 35 LF.
 */
export function placeDownspoutsOnPolygon(
  polygon: RoofPolygon,
  eaveLines: EditableLine[],
  imageWidth: number,
  imageHeight: number,
  defaultStories: Stories = 2,
  pxPerFt = 2.4,
): Downspout[] {
  const heightFt = STORY_HEIGHT_FT[defaultStories];
  const placed: Downspout[] = [];

  // 1. One per outside corner
  const corners = convexCornersOf(polygon, imageWidth, imageHeight);
  for (let i = 0; i < corners.length; i++) {
    placed.push({
      id: `ds-corner-${i + 1}`,
      x: corners[i].x,
      y: corners[i].y,
      heightFt,
    });
  }

  // 2. Mid-eave downspouts for long runs (>35 LF)
  const MAX_RUN_FT = 35;
  for (const line of eaveLines) {
    if (line.points.length < 2) continue;
    const a = line.points[0];
    const b = line.points[line.points.length - 1];
    const lengthPx = Math.hypot(b.x - a.x, b.y - a.y);
    const lengthFt = lengthPx / pxPerFt;
    if (lengthFt > MAX_RUN_FT) {
      placed.push({
        id: `ds-mid-${line.id}`,
        x: Math.round((a.x + b.x) / 2),
        y: Math.round((a.y + b.y) / 2),
        heightFt,
      });
    }
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
}): Measurements {
  return {
    eaveLF: Math.round(args.eaveLF),
    rakeLF: Math.round(args.eaveLF * 0.6),
    outsideCorners: Math.max(4, Math.round(args.cornerCount * 0.7)),
    insideCorners: Math.max(0, Math.round(args.cornerCount * 0.3)),
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
