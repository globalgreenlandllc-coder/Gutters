import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";

export type SatImage = {
  base64: string;
  mimeType: "image/png";
  width: number;
  height: number;
  zoom: number;
  centerLat: number;
  centerLng: number;
};

export async function fetchSatelliteImage(
  lat: number,
  lng: number,
  opts: { zoom?: number; size?: number } = {},
): Promise<SatImage | null> {
  const key = await getActiveApiKey("GOOGLE_MAPS");
  if (!key) return null;

  const zoom = opts.zoom ?? 20;
  const size = opts.size ?? 640;
  const url =
    `https://maps.googleapis.com/maps/api/staticmap?` +
    `center=${lat},${lng}` +
    `&zoom=${zoom}` +
    `&size=${size}x${size}` +
    `&scale=2` +
    `&maptype=satellite` +
    `&key=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.warn(`[static-map] HTTP ${res.status}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    return {
      base64: Buffer.from(buf).toString("base64"),
      mimeType: "image/png",
      width: size,
      height: size,
      zoom,
      centerLat: lat,
      centerLng: lng,
    };
  } catch (e) {
    console.warn(
      "[static-map] Fetch failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
