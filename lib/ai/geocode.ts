import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";

export type GeocodeResult = {
  formatted: string;
  lat: number;
  lng: number;
  source: "google" | "mock";
  /**
   * When source is "mock", explains *why* we fell back. Surfaced into
   * the estimate notes so contractors can self-diagnose ("API not
   * enabled", "REQUEST_DENIED", "no key in vault", etc.) without
   * needing to read server logs.
   */
  fallbackReason?: string;
};

export async function geocodeAddress(
  address: string,
): Promise<GeocodeResult> {
  const key = await getActiveApiKey("GOOGLE_MAPS");
  if (!key) {
    return mockGeocode(address, "no GOOGLE_MAPS key in vault");
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
      address,
    )}&key=${encodeURIComponent(key)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Geocoding HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      status: string;
      error_message?: string;
      results?: Array<{
        formatted_address: string;
        geometry: { location: { lat: number; lng: number } };
      }>;
    };
    if (data.status !== "OK") {
      throw new Error(
        `Geocoding API: ${data.status}${
          data.error_message ? ` — ${data.error_message}` : ""
        }`,
      );
    }
    const r = data.results?.[0];
    if (!r) throw new Error("Geocoding returned no results");
    return {
      formatted: r.formatted_address,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      source: "google",
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(
      "[geocode] Falling back to mock — Google API call failed:",
      reason,
    );
    return mockGeocode(address, reason);
  }
}

function mockGeocode(address: string, fallbackReason: string): GeocodeResult {
  let h = 0;
  for (let i = 0; i < address.length; i++) {
    h = ((h << 5) - h + address.charCodeAt(i)) | 0;
  }
  const lat = 30 + ((h & 0xff) / 255) * 12;
  const lng = -100 + (((h >> 8) & 0xff) / 255) * 30;
  return {
    formatted: address,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    source: "mock",
    fallbackReason,
  };
}
