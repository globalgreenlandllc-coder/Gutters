// Pure math (no keys, no fetch) — importable from tests and other pure
// modules. The Mercator-tile entry point below is one projector choice;
// the solar-first engine injects a UTM-grid projector instead.
import type { RoofSegment } from "./solar";
import { latLngToImagePixel } from "./geometry";

export type SegmentRidge = {
  id: string;
  /** Endpoints in image-pixel space (1280×1280 satellite tile). */
  a: { x: number; y: number };
  b: { x: number; y: number };
  /** 0–1, derived from the segment's pitch and area. */
  confidence: number;
};

/**
 * Build deterministic ridge lines from the Solar API's per-segment
 * stats. Each `roofSegmentStats[i]` reports a centroid (lat/lng), an
 * axis-aligned lat/lng bounding box, and the azimuth — the compass
 * direction the slope FACES. The ridge of a single planar slope is:
 *
 *   - anchored at the centroid,
 *   - oriented PERPENDICULAR to the azimuth (the slope's drop direction),
 *   - bounded by the bbox dimension along that perpendicular.
 *
 * Why this beats the GPT-4o roof-structure call: the model was placing
 * RIDGE labels in the yard or on the wrong roof plane. Solar's segment
 * data is georeferenced and not subject to vision hallucination — every
 * ridge ends up on a real roof plane, anchored at its real centroid.
 *
 * Ignores segments below `minPitchDeg` (flat patches that aren't
 * actually peaked roofs) and below `minAreaM2` (specks of noise).
 */
export function buildSegmentRidges(
  segments: RoofSegment[],
  geocoded: { lat: number; lng: number },
  zoom: number,
  imageWidth: number,
  imageHeight: number,
  options: { minPitchDeg?: number; minAreaM2?: number } = {},
): SegmentRidge[] {
  return buildSegmentRidgesProjected(
    segments,
    (lat, lng) =>
      latLngToImagePixel(
        lat,
        lng,
        geocoded.lat,
        geocoded.lng,
        zoom,
        imageWidth,
        imageHeight,
      ),
    options,
  );
}

/**
 * Projector-agnostic core: the caller supplies lat/lng → pixel-space
 * mapping. The Mercator-tile wrapper above uses latLngToImagePixel; the
 * solar-first engine uses the dataLayers UTM grid (uniform meters/px),
 * where the same ridge math is exact instead of approximate.
 *
 * NOTE the azimuth→direction conversion below assumes the pixel grid is
 * north-up (x → east, y → south). Both current projectors satisfy that.
 */
export function buildSegmentRidgesProjected(
  segments: RoofSegment[],
  project: (lat: number, lng: number) => { x: number; y: number },
  options: { minPitchDeg?: number; minAreaM2?: number } = {},
): SegmentRidge[] {
  const minPitch = options.minPitchDeg ?? 8;
  const minArea = options.minAreaM2 ?? 6;

  const out: SegmentRidge[] = [];
  segments.forEach((seg, i) => {
    if (seg.pitchDegrees < minPitch) return;
    if (seg.areaMeters2 < minArea) return;
    if (!seg.center || !seg.boundingBoxNE || !seg.boundingBoxSW) return;

    const center = project(seg.center.lat, seg.center.lng);
    const ne = project(seg.boundingBoxNE.lat, seg.boundingBoxNE.lng);
    const sw = project(seg.boundingBoxSW.lat, seg.boundingBoxSW.lng);

    // Bounding box width/height in IMAGE PIXELS. SW.y > NE.y in image
    // space because image-y grows downward but lat grows northward.
    const bboxW = Math.abs(ne.x - sw.x);
    const bboxH = Math.abs(sw.y - ne.y);

    // Convert azimuth (compass, north-up, clockwise-positive) to a
    // direction vector in image-pixel space. Image-y flips north/south,
    // so we negate the y component.
    //   azimuth 0  → slope faces north → ridge runs east-west
    //   azimuth 90 → slope faces east  → ridge runs north-south
    // The RIDGE direction is azimuth + 90°.
    const ridgeRad = ((seg.azimuthDegrees + 90) * Math.PI) / 180;
    const dirX = Math.sin(ridgeRad); // unit east
    const dirY = -Math.cos(ridgeRad); // unit south (image-down for north)

    // Length: project the bbox onto the ridge direction. For an
    // axis-aligned bbox in image-pixel space, |dx|*|dirX| + |dy|*|dirY|
    // is the chord length along the ridge axis. Cap to bbox diagonal
    // so a tiny pitch error can't blow up the line.
    const rawLen = bboxW * Math.abs(dirX) + bboxH * Math.abs(dirY);
    const diag = Math.hypot(bboxW, bboxH);
    const len = Math.min(rawLen, diag);
    if (len < 12) return; // < ~3 ft on the ground, not worth labeling

    const half = len / 2;
    const a = {
      x: Math.round(center.x - dirX * half),
      y: Math.round(center.y - dirY * half),
    };
    const b = {
      x: Math.round(center.x + dirX * half),
      y: Math.round(center.y + dirY * half),
    };

    // Confidence: steeper pitch + larger area = higher confidence.
    // Saturates at 30° pitch and 40 m² area.
    const pitchConf = Math.min(1, seg.pitchDegrees / 30);
    const areaConf = Math.min(1, seg.areaMeters2 / 40);
    const confidence = Math.round((0.6 * pitchConf + 0.4 * areaConf) * 100) / 100;

    out.push({ id: `solar-ridge-${i}`, a, b, confidence });
  });

  return mergeCollinearRidges(out);
}

/**
 * Adjacent Solar roof segments share a ridge: the top edge where their
 * two slopes meet is one physical ridge but appears once per segment in
 * the per-segment ridge list (a hip roof's 4 segments → 4 nearly
 * coincident ridge candidates). Merge any group of ridges that are
 *   - parallel (within ~6° of each other),
 *   - within ~16 px (≈ 0.8 m) perpendicular distance, and
 *   - whose projections onto the shared axis overlap or are within ~30 px
 *     (≈ 1.5 m) of each other along the axis.
 * Replaces them with a single ridge spanning the full extent.
 */
function mergeCollinearRidges(ridges: SegmentRidge[]): SegmentRidge[] {
  const ANGLE_TOL_RAD = (6 * Math.PI) / 180;
  const PERP_DIST_PX = 16;
  const GAP_PX = 30;

  const remaining = [...ridges];
  const out: SegmentRidge[] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const group: SegmentRidge[] = [seed];
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const cand = remaining[i];
        if (
          group.some((g) =>
            isCollinearAndOverlapping(
              g,
              cand,
              ANGLE_TOL_RAD,
              PERP_DIST_PX,
              GAP_PX,
            ),
          )
        ) {
          group.push(cand);
          remaining.splice(i, 1);
          changed = true;
        }
      }
    }
    out.push(mergeRidgeGroup(group));
  }
  return out;
}

function isCollinearAndOverlapping(
  a: SegmentRidge,
  b: SegmentRidge,
  angleTol: number,
  perpTol: number,
  gapTol: number,
): boolean {
  const aLen = Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y);
  const bLen = Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y);
  if (aLen < 1 || bLen < 1) return false;
  const aDirX = (a.b.x - a.a.x) / aLen;
  const aDirY = (a.b.y - a.a.y) / aLen;
  const bDirX = (b.b.x - b.a.x) / bLen;
  const bDirY = (b.b.y - b.a.y) / bLen;

  // Angle between unit vectors via |cross|; folded mod 180° (direction
  // sign doesn't matter — a "←" ridge is parallel to a "→" ridge).
  const sinAng = Math.abs(aDirX * bDirY - aDirY * bDirX);
  if (sinAng > Math.sin(angleTol)) return false;

  // Perpendicular distance from b's midpoint to a's infinite line.
  const aMidX = (a.a.x + a.b.x) / 2;
  const aMidY = (a.a.y + a.b.y) / 2;
  const bMidX = (b.a.x + b.b.x) / 2;
  const bMidY = (b.a.y + b.b.y) / 2;
  const dx = bMidX - aMidX;
  const dy = bMidY - aMidY;
  const perp = Math.abs(-aDirY * dx + aDirX * dy);
  if (perp > perpTol) return false;

  // Project each ridge onto a's axis through its midpoint; check that
  // the two intervals overlap or are within `gapTol` of each other.
  const project = (p: { x: number; y: number }) =>
    aDirX * (p.x - aMidX) + aDirY * (p.y - aMidY);
  const aT1 = project(a.a);
  const aT2 = project(a.b);
  const bT1 = project(b.a);
  const bT2 = project(b.b);
  const aMin = Math.min(aT1, aT2);
  const aMax = Math.max(aT1, aT2);
  const bMin = Math.min(bT1, bT2);
  const bMax = Math.max(bT1, bT2);
  const gap = Math.max(0, Math.max(aMin - bMax, bMin - aMax));
  return gap <= gapTol;
}

function mergeRidgeGroup(group: SegmentRidge[]): SegmentRidge {
  if (group.length === 1) return group[0];
  // Use the longest ridge as the reference axis — it's the most stable
  // direction estimate for the group.
  const longest = group.reduce((best, r) => {
    const lr = Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y);
    const lb = Math.hypot(best.b.x - best.a.x, best.b.y - best.a.y);
    return lr > lb ? r : best;
  });
  const lLen = Math.hypot(longest.b.x - longest.a.x, longest.b.y - longest.a.y);
  const dirX = (longest.b.x - longest.a.x) / lLen;
  const dirY = (longest.b.y - longest.a.y) / lLen;
  const midX = (longest.a.x + longest.b.x) / 2;
  const midY = (longest.a.y + longest.b.y) / 2;

  let tMin = Infinity;
  let tMax = -Infinity;
  let perpSum = 0;
  let perpCount = 0;
  for (const r of group) {
    for (const p of [r.a, r.b]) {
      const t = dirX * (p.x - midX) + dirY * (p.y - midY);
      const perp = -dirY * (p.x - midX) + dirX * (p.y - midY);
      perpSum += perp;
      perpCount++;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  // Centerline shifted by the average perpendicular offset of all
  // endpoints — biases the merged ridge toward the cluster center
  // rather than sticking to the longest member's exact line.
  const perpAvg = perpSum / Math.max(1, perpCount);
  const newMidX = midX + -dirY * perpAvg;
  const newMidY = midY + dirX * perpAvg;
  const a = {
    x: Math.round(newMidX + dirX * tMin),
    y: Math.round(newMidY + dirY * tMin),
  };
  const b = {
    x: Math.round(newMidX + dirX * tMax),
    y: Math.round(newMidY + dirY * tMax),
  };
  const conf =
    group.reduce((s, r) => s + r.confidence, 0) / group.length;

  return {
    id: `solar-ridge-merged-${group[0].id}`,
    a,
    b,
    confidence: Math.round(conf * 100) / 100,
  };
}
