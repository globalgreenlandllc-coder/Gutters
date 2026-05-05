import "server-only";
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
  const minPitch = options.minPitchDeg ?? 8;
  const minArea = options.minAreaM2 ?? 6;

  const out: SegmentRidge[] = [];
  segments.forEach((seg, i) => {
    if (seg.pitchDegrees < minPitch) return;
    if (seg.areaMeters2 < minArea) return;
    if (!seg.center || !seg.boundingBoxNE || !seg.boundingBoxSW) return;

    const center = latLngToImagePixel(
      seg.center.lat,
      seg.center.lng,
      geocoded.lat,
      geocoded.lng,
      zoom,
      imageWidth,
      imageHeight,
    );
    const ne = latLngToImagePixel(
      seg.boundingBoxNE.lat,
      seg.boundingBoxNE.lng,
      geocoded.lat,
      geocoded.lng,
      zoom,
      imageWidth,
      imageHeight,
    );
    const sw = latLngToImagePixel(
      seg.boundingBoxSW.lat,
      seg.boundingBoxSW.lng,
      geocoded.lat,
      geocoded.lng,
      zoom,
      imageWidth,
      imageHeight,
    );

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

  return out;
}
