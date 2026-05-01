import "server-only";
import type { SegmentedEavePolyline } from "./vision";
import { STORY_HEIGHT_FT } from "@/lib/types";
import type { EditableLine, Downspout, Measurements, Stories } from "@/lib/types";

const METERS_PER_FOOT = 0.3048;

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
 * Vision returns coordinates in the source image's pixel space (e.g. 640×640).
 * Our SVG canvas uses a 900×580 viewBox. Map vision coords into canvas coords
 * preserving aspect ratio (image fits centered).
 */
export function transformToCanvas(
  pts: { x: number; y: number }[],
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number }[] {
  const scale = Math.min(CANVAS_W / imageWidth, CANVAS_H / imageHeight);
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
