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

export type SatImageOutcome =
  | { ok: true; image: SatImage }
  | { ok: false; reason: string };

export async function fetchSatelliteImage(
  lat: number,
  lng: number,
  opts: { zoom?: number; size?: number } = {},
): Promise<SatImageOutcome> {
  const key = await getActiveApiKey("GOOGLE_MAPS");
  if (!key) return { ok: false, reason: "no GOOGLE_MAPS key in vault" };

  const zoom = opts.zoom ?? 20;
  const size = opts.size ?? 640;
  // We always request scale=2 — Google returns a 2× density PNG (so a
  // requested 640×640 actually arrives as 1280×1280 pixels). Downstream
  // consumers (vision prompts, SAM center-point, canvas transform) need
  // the *real* pixel dimensions of what GPT-4o / SAM 2 actually see, not
  // the size we requested.
  const scale = 2;
  const url =
    `https://maps.googleapis.com/maps/api/staticmap?` +
    `center=${lat},${lng}` +
    `&zoom=${zoom}` +
    `&size=${size}x${size}` +
    `&scale=${scale}` +
    `&maptype=satellite` +
    `&key=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      // Static Maps returns errors as a small image with the message
      // baked in — try to surface the textual hint where possible.
      let detail = "";
      const errHeader = res.headers.get("x-staticmap-api-warning");
      if (errHeader) detail = ` — ${errHeader}`;
      const reason = `Static Maps HTTP ${res.status}${detail}`;
      console.warn(`[static-map] ${reason}`);
      return { ok: false, reason };
    }
    const buf = await res.arrayBuffer();
    return {
      ok: true,
      image: {
        base64: Buffer.from(buf).toString("base64"),
        mimeType: "image/png",
        width: size * scale,
        height: size * scale,
        zoom,
        centerLat: lat,
        centerLng: lng,
      },
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("[static-map] Fetch failed:", reason);
    return { ok: false, reason };
  }
}
