import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";

export type RoofSegment = {
  pitchDegrees: number;
  /** Compass direction the slope FACES (0 = north, 90 = east). Ridge runs
   *  perpendicular to this. */
  azimuthDegrees: number;
  areaMeters2: number;
  /** Geographic center of the segment. Used to anchor ridge lines on
   *  the correct roof plane. */
  center: { lat: number; lng: number } | null;
  /** Lat/lng axis-aligned bounding box of the segment — gives us the
   *  ridge length (the perpendicular-to-azimuth dimension of the bbox). */
  boundingBoxNE: { lat: number; lng: number } | null;
  boundingBoxSW: { lat: number; lng: number } | null;
  /** Plane height at center (m). Lets us pick the highest segment as the
   *  primary ridge when buildings have multiple gable masses. */
  planeHeightMeters: number | null;
};

export type BuildingInsights = {
  boundingBoxNE: { lat: number; lng: number };
  boundingBoxSW: { lat: number; lng: number };
  roofSegments: RoofSegment[];
  totalRoofAreaMeters2: number;
  source: "google_solar";
};

type LatLngLiteral = { latitude?: number; longitude?: number };
type RawSolarResponse = {
  boundingBox?: {
    ne: { latitude: number; longitude: number };
    sw: { latitude: number; longitude: number };
  };
  solarPotential?: {
    wholeRoofStats?: { areaMeters2?: number };
    roofSegmentStats?: Array<{
      pitchDegrees?: number;
      azimuthDegrees?: number;
      stats?: { areaMeters2?: number };
      center?: LatLngLiteral;
      boundingBox?: { ne?: LatLngLiteral; sw?: LatLngLiteral };
      planeHeightAtCenterMeters?: number;
    }>;
  };
};

function latLngFromLiteral(
  l: LatLngLiteral | undefined,
): { lat: number; lng: number } | null {
  if (
    !l ||
    typeof l.latitude !== "number" ||
    typeof l.longitude !== "number"
  ) {
    return null;
  }
  return { lat: l.latitude, lng: l.longitude };
}

export async function getBuildingInsights(
  lat: number,
  lng: number,
): Promise<BuildingInsights | null> {
  const key =
    (await getActiveApiKey("GOOGLE_SOLAR")) ??
    (await getActiveApiKey("GOOGLE_MAPS"));
  if (!key) return null;

  const url =
    `https://solar.googleapis.com/v1/buildingInsights:findClosest?` +
    `location.latitude=${lat}&location.longitude=${lng}` +
    `&requiredQuality=LOW&key=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      // Solar API isn't available for many regions — silent fallback
      return null;
    }
    const data = (await res.json()) as RawSolarResponse;
    if (!data.boundingBox) return null;

    return {
      boundingBoxNE: {
        lat: data.boundingBox.ne.latitude,
        lng: data.boundingBox.ne.longitude,
      },
      boundingBoxSW: {
        lat: data.boundingBox.sw.latitude,
        lng: data.boundingBox.sw.longitude,
      },
      roofSegments: (data.solarPotential?.roofSegmentStats ?? []).map((s) => ({
        pitchDegrees: s.pitchDegrees ?? 0,
        azimuthDegrees: s.azimuthDegrees ?? 0,
        areaMeters2: s.stats?.areaMeters2 ?? 0,
        center: latLngFromLiteral(s.center),
        boundingBoxNE: latLngFromLiteral(s.boundingBox?.ne),
        boundingBoxSW: latLngFromLiteral(s.boundingBox?.sw),
        planeHeightMeters:
          typeof s.planeHeightAtCenterMeters === "number"
            ? s.planeHeightAtCenterMeters
            : null,
      })),
      totalRoofAreaMeters2: data.solarPotential?.wholeRoofStats?.areaMeters2 ?? 0,
      source: "google_solar",
    };
  } catch {
    return null;
  }
}

/**
 * Heuristic story estimate from Solar API building insights.
 *
 * The Solar API doesn't return building height directly (DSM tiles do, but
 * we don't fetch those — they're heavy). We infer stories from roof
 * footprint area: a single-family home with a small footprint relative to
 * its eave length is more likely to be 2-story (vertical extension), while
 * a sprawling footprint with low pitch is more likely to be 1-story.
 *
 * Contractors can override per-downspout via the height popover, so this
 * just sets a sensible starting default.
 */
export function estimateStoriesFromInsights(
  insights: { totalRoofAreaMeters2: number; roofSegments: { pitchDegrees: number }[] } | null,
): 1 | 2 | 3 {
  // Single-story is the majority case for US single-family homes (Census
  // ACS data: ~62% of detached SFR are 1-story). Defaulting to 2 was
  // mis-classifying every roof we couldn't read confidently and inflating
  // downspout drop heights downstream.
  if (!insights || insights.totalRoofAreaMeters2 === 0) return 1;
  const areaSqFt = insights.totalRoofAreaMeters2 * 10.7639;
  const avgPitch =
    insights.roofSegments.length > 0
      ? insights.roofSegments.reduce((s, r) => s + r.pitchDegrees, 0) /
        insights.roofSegments.length
      : 25;

  // Vertical stacking (2+ stories) leaves a much smaller roof footprint
  // than the living-area sqft would suggest, AND modern multi-story
  // homes typically run a steeper pitch (≥6/12 = 26.6°) for shedding
  // and curb appeal. Both signals together are the signal.
  if (areaSqFt < 800 && avgPitch > 30) return 3; // tall narrow w/ steep pitch
  if (areaSqFt < 1200 && avgPitch > 25) return 2; // small footprint + steep
  return 1; // default to 1-story — contractor can override per downspout
}
