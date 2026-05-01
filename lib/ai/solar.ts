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
