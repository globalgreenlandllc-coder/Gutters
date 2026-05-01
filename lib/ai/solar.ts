import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";

export type RoofSegment = {
  pitchDegrees: number;
  azimuthDegrees: number;
  areaMeters2: number;
};

export type BuildingInsights = {
  boundingBoxNE: { lat: number; lng: number };
  boundingBoxSW: { lat: number; lng: number };
  roofSegments: RoofSegment[];
  totalRoofAreaMeters2: number;
  source: "google_solar";
};

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
    }>;
  };
};

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
  if (!insights || insights.totalRoofAreaMeters2 === 0) return 2;
  const areaSqFt = insights.totalRoofAreaMeters2 * 10.7639;
  const avgPitch =
    insights.roofSegments.length > 0
      ? insights.roofSegments.reduce((s, r) => s + r.pitchDegrees, 0) /
        insights.roofSegments.length
      : 25;

  // Tiny footprint (<1100 sqft) with steep pitch (>22°) → likely 2+ story
  // Huge footprint (>2400 sqft) with low pitch (<18°) → likely 1 story
  if (areaSqFt < 900 && avgPitch > 25) return 3;
  if (areaSqFt < 1500 && avgPitch > 20) return 2;
  if (areaSqFt > 2400 && avgPitch < 22) return 1;
  return 2;
}
