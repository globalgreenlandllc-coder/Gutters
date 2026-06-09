import "server-only";
import type { RoofSegment } from "./solar";

/**
 * Tier-break eave detection.
 *
 * The outer-perimeter classifier only finds eaves along the building
 * footprint — the edges where the roof meets open sky. But many real
 * houses have multiple roof tiers stacked on top of each other: a 1-
 * story garage wing attached to a 2-story main mass, a dormer rising
 * out of a hip roof, a second-story addition built over a porch, etc.
 *
 * Wherever an upper roof tier *ends* over a lower tier's surface, the
 * upper tier's eave needs its own gutter to catch the runoff before it
 * blows up shingle felt on the roof below. The current outer-perimeter
 * trace misses every one of these "interior" eaves.
 *
 * We have everything we need to find them from Solar's per-segment
 * data, which gives us:
 *   • `planeHeightMeters`  — the height of each plane at its center
 *   • `boundingBoxNE/SW`   — the lat/lng bbox of each plane
 *   • `azimuthDegrees`     — the compass direction water flows down
 *                            (perpendicular to the plane's ridge)
 *
 * The algorithm:
 *   1. Compute a baseline height = median of all segment `planeHeightMeters`.
 *   2. A segment is "elevated" when its plane height is more than
 *      `TIER_STEP_M` above the baseline (default 0.45m = ~18", roughly
 *      one story step on a residential roof).
 *   3. For each elevated segment, walk its bbox edges and pick the one
 *      whose midpoint sits furthest in the segment's azimuth direction
 *      from the segment center — that's the downhill edge, i.e. where
 *      water spills off the plane.
 *   4. That edge is a candidate interior eave.
 *   5. Filter candidates that fall within `dedupeRadiusM` of an existing
 *      perimeter eave — those are already covered by the outer trace.
 *
 * Returns the candidate eaves in lat/lng so the upstream pipeline can
 * project them into image-pixel space alongside the perimeter eaves.
 */

const TIER_STEP_M = 0.3; // ~12 inches — minimum perceptible tier drop
const DEFAULT_DEDUPE_RADIUS_M = 1.5; // skip candidates within ~5 ft of an existing eave

type LatLng = { lat: number; lng: number };
type Edge = { a: LatLng; b: LatLng };

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Percentile (0..1) of a numeric sample. Used so we can pick a low
 * baseline (e.g. 25th percentile) — that way a roof where most planes
 * are LOWER than a few tall ridges still flags those ridges as
 * elevated, instead of letting the median sit halfway up and miss
 * both ends.
 */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(s.length - 1, Math.floor(p * (s.length - 1))));
  return s[idx];
}

function metersPerDegree(lat: number): { mLat: number; mLng: number } {
  return {
    mLat: 110_540,
    mLng: 111_320 * Math.cos((lat * Math.PI) / 180),
  };
}

function midpoint(e: Edge): LatLng {
  return { lat: (e.a.lat + e.b.lat) / 2, lng: (e.a.lng + e.b.lng) / 2 };
}

function distMeters(p: LatLng, q: LatLng): number {
  const { mLat, mLng } = metersPerDegree((p.lat + q.lat) / 2);
  return Math.hypot((p.lat - q.lat) * mLat, (p.lng - q.lng) * mLng);
}

/** Distance from point P to segment AB, in meters. */
function pointToEdgeMeters(p: LatLng, e: Edge): number {
  const { mLat, mLng } = metersPerDegree(p.lat);
  const ax = e.a.lng * mLng;
  const ay = e.a.lat * mLat;
  const bx = e.b.lng * mLng;
  const by = e.b.lat * mLat;
  const px = p.lng * mLng;
  const py = p.lat * mLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Given an azimuth (compass degrees, 0 = north, 90 = east), return the
 * unit vector pointing in that direction in (Δlng, Δlat) at the given
 * latitude.
 */
function azimuthToVector(
  azimuthDeg: number,
  lat: number,
): { vLng: number; vLat: number } {
  const rad = (azimuthDeg * Math.PI) / 180;
  // North = +lat (vLat = +1), East = +lng (vLng = +1).
  const { mLat, mLng } = metersPerDegree(lat);
  return {
    vLng: Math.sin(rad) / mLng, // east component per meter
    vLat: Math.cos(rad) / mLat, // north component per meter
  };
}

export type TierBreakCandidate = {
  edge: Edge;
  /** Plane height step (meters) — how much higher this tier sits above baseline. */
  stepMeters: number;
  /** Segment id (index) this eave belongs to. */
  segmentIndex: number;
};

export type TierBreakDiagnostics = {
  segmentsTotal: number;
  segmentsWithHeight: number;
  heightMin: number | null;
  heightMax: number | null;
  heightMedian: number | null;
  baselineUsed: number | null;
  stepThresholdM: number;
  /** Segments that cleared the minStep threshold (regardless of dedup). */
  elevatedCount: number;
};

export function detectTierBreakEaves(
  segments: RoofSegment[],
  perimeterEaves: Edge[],
  options: {
    minStepMeters?: number;
    dedupeRadiusM?: number;
    minSegmentAreaM2?: number;
    minPitchDeg?: number;
    /** Percentile (0..1) to anchor the baseline. Lower = catches more
     *  tiers as "elevated". 0.25 is a good default — uses the bottom
     *  quartile so a roof with a few low porch wings doesn't drag the
     *  median up and make the entire main mass look "flat". */
    baselinePercentile?: number;
  } = {},
): { candidates: TierBreakCandidate[]; diag: TierBreakDiagnostics } {
  const minStep = options.minStepMeters ?? TIER_STEP_M;
  const dedupeR = options.dedupeRadiusM ?? DEFAULT_DEDUPE_RADIUS_M;
  const minArea = options.minSegmentAreaM2 ?? 6;
  const minPitch = options.minPitchDeg ?? 5;
  const baselinePct = options.baselinePercentile ?? 0.25;

  const heights: number[] = [];
  for (const s of segments) {
    if (s.planeHeightMeters != null) heights.push(s.planeHeightMeters);
  }

  const diag: TierBreakDiagnostics = {
    segmentsTotal: segments.length,
    segmentsWithHeight: heights.length,
    heightMin: heights.length > 0 ? Math.min(...heights) : null,
    heightMax: heights.length > 0 ? Math.max(...heights) : null,
    heightMedian: heights.length > 0 ? median(heights) : null,
    baselineUsed: null,
    stepThresholdM: minStep,
    elevatedCount: 0,
  };

  if (heights.length === 0) {
    return { candidates: [], diag };
  }

  // Use the bottom quartile as the baseline so even moderate elevation
  // qualifies. A house with a 2-story main and a 1-story garage will
  // have ~50% of segments low + ~50% high; with the median as baseline
  // every high segment would be a hair-thin step. Anchoring at the 25th
  // percentile pushes the "ground tier" definition down to the low
  // porches/wings, so the main mass cleanly counts as elevated.
  const baseline = percentile(heights, baselinePct);
  diag.baselineUsed = baseline;

  const candidates: TierBreakCandidate[] = [];

  segments.forEach((seg, i) => {
    if (seg.planeHeightMeters == null) return;
    if (seg.areaMeters2 < minArea) return;
    if (seg.pitchDegrees < minPitch) return;
    if (!seg.center || !seg.boundingBoxNE || !seg.boundingBoxSW) return;
    const step = seg.planeHeightMeters - baseline;
    if (step < minStep) return;
    diag.elevatedCount++;

    // The four bbox corners (NE / NW / SE / SW).
    const ne = seg.boundingBoxNE;
    const sw = seg.boundingBoxSW;
    const nw = { lat: ne.lat, lng: sw.lng };
    const se = { lat: sw.lat, lng: ne.lng };

    // The four bbox edges. The downhill edge is the one whose midpoint
    // sits furthest along the segment's azimuth from the center.
    const edges: Edge[] = [
      { a: nw, b: ne }, // N
      { a: ne, b: se }, // E
      { a: se, b: sw }, // S
      { a: sw, b: nw }, // W
    ];

    const { vLng, vLat } = azimuthToVector(seg.azimuthDegrees, seg.center.lat);
    // We want the edge midpoint whose offset from center has the
    // largest positive dot-product with the azimuth vector.
    let bestEdge: Edge | null = null;
    let bestScore = -Infinity;
    for (const e of edges) {
      const m = midpoint(e);
      const dLng = m.lng - seg.center.lng;
      const dLat = m.lat - seg.center.lat;
      const score = dLng * vLng + dLat * vLat;
      if (score > bestScore) {
        bestScore = score;
        bestEdge = e;
      }
    }
    if (!bestEdge) return;

    // Skip if this candidate is already covered by the outer perimeter
    // trace (a perimeter eave runs along the same wall — adding a
    // duplicate would double-count the linear footage).
    const m = midpoint(bestEdge);
    let coveredByPerimeter = false;
    for (const pe of perimeterEaves) {
      if (pointToEdgeMeters(m, pe) <= dedupeR) {
        coveredByPerimeter = true;
        break;
      }
    }
    if (coveredByPerimeter) return;

    // Skip degenerate (~zero-length) bbox edges.
    if (distMeters(bestEdge.a, bestEdge.b) < 0.5) return;

    candidates.push({
      edge: bestEdge,
      stepMeters: step,
      segmentIndex: i,
    });
  });

  return { candidates, diag };
}
