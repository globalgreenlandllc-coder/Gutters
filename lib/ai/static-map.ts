import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";
import { AI_TIMEOUTS, fetchWithTimeout } from "./http";

export type SatImage = {
  base64: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  zoom: number;
  centerLat: number;
  centerLng: number;
  /** Which provider actually served this tile. Surfaced in run notes for
   *  diagnostics — when imagery looks wrong, the first thing to check is
   *  whether we got Mapbox (Maxar Vivid, refreshed annually) or Google
   *  Static Maps (variable freshness, often older in suburbs). */
  source: "mapbox" | "google";
  /** When the primary provider failed and we fell back, this captures the
   *  reason. null when the primary served the tile successfully. */
  primaryFailureReason: string | null;
};

export type SatImageOutcome =
  | { ok: true; image: SatImage }
  | { ok: false; reason: string };

/**
 * Fetch a satellite tile centered on (lat, lng). Tries GOOGLE first,
 * falls back to Mapbox. (This order was flipped 2026-07: side-by-side
 * checks across Lake Stevens / Monroe / Snohomish WA showed Google's
 * Airbus/aerial layer consistently sharper AND fresher — Mapbox's
 * Maxar tile at the owner's own new-construction address was a blurry
 * upsample still showing the previous structure.)
 *
 * Both providers return the same effective resolution at scale=2 /
 * @2x: a requested 640×640 tile arrives as 1280×1280 pixels. Downstream
 * `metersPerPixel(lat, zoom)` math hard-codes the scale=2 factor, so
 * the two providers are interchangeable from the geometry pipeline's
 * point of view.
 */
export async function fetchSatelliteImage(
  lat: number,
  lng: number,
  opts: { zoom?: number; size?: number } = {},
): Promise<SatImageOutcome> {
  const zoom = opts.zoom ?? 20;
  const size = opts.size ?? 640;

  const googleOutcome = await fetchFromGoogle(lat, lng, zoom, size);
  if (googleOutcome.ok) return googleOutcome;

  const mapboxOutcome = await fetchFromMapbox(lat, lng, zoom, size);
  if (mapboxOutcome.ok) {
    // Stamp the Google failure reason on the Mapbox result so the run
    // notes can show *why* we silently fell back — otherwise the only
    // signal is the source label and the user is left guessing
    // (invalid key? quota? API not enabled?).
    return {
      ok: true,
      image: { ...mapboxOutcome.image, primaryFailureReason: googleOutcome.reason },
    };
  }

  return {
    ok: false,
    reason: `Google: ${googleOutcome.reason}; Mapbox: ${mapboxOutcome.reason}`,
  };
}

/* ------------------------------------------------------------------ */
/*   Mapbox Static Images API — primary                               */
/* ------------------------------------------------------------------ */
async function fetchFromMapbox(
  lat: number,
  lng: number,
  zoom: number,
  size: number,
): Promise<SatImageOutcome> {
  const token = await getActiveApiKey("MAPBOX");
  if (!token) return { ok: false, reason: "no MAPBOX key in vault" };

  // Mapbox Static Images API. Note coordinate order is {lng},{lat} —
  // GeoJSON convention, opposite of Google. The @2x suffix doubles the
  // returned pixel density so a 640×640 request returns 1280×1280 PNG.
  // attribution=false + logo=false strips the watermark overlay from
  // the rendered tile (the contractor doesn't need the Mapbox logo on
  // their roof crop, and the legal license is satisfied separately).
  const url =
    `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
    `${lng},${lat},${zoom}/${size}x${size}@2x` +
    `?attribution=false&logo=false` +
    `&access_token=${encodeURIComponent(token)}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, { cache: "no-store" }, AI_TIMEOUTS.imagery);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("[mapbox-static] Fetch failed:", reason);
    return { ok: false, reason: `network error: ${reason}` };
  }
  if (!res.ok) {
    // Mapbox returns a JSON {message} body on 4xx. Pull it through so the
    // run-notes strip can surface "invalid token" vs "out of quota" etc.
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) detail = ` — ${body.message}`;
    } catch {
      // not JSON
    }
    const reason = `Mapbox HTTP ${res.status}${detail}`;
    console.warn(`[mapbox-static] ${reason}`);
    return { ok: false, reason };
  }
  const contentType = res.headers.get("content-type") ?? "";
  const mimeType: SatImage["mimeType"] = contentType.includes("jpeg")
    ? "image/jpeg"
    : "image/png";
  const buf = await res.arrayBuffer();
  return {
    ok: true,
    image: {
      base64: Buffer.from(buf).toString("base64"),
      mimeType,
      width: size * 2,
      height: size * 2,
      zoom,
      centerLat: lat,
      centerLng: lng,
      source: "mapbox",
      primaryFailureReason: null,
    },
  };
}

/* ------------------------------------------------------------------ */
/*   Google Static Maps — fallback                                    */
/* ------------------------------------------------------------------ */
async function fetchFromGoogle(
  lat: number,
  lng: number,
  zoom: number,
  size: number,
): Promise<SatImageOutcome> {
  const key = await getActiveApiKey("GOOGLE_MAPS");
  if (!key) return { ok: false, reason: "no GOOGLE_MAPS key in vault" };

  // scale=2 returns a 2× density PNG (640 × 2 = 1280 actual pixels).
  // Downstream geometry assumes scale=2 — do not change without also
  // updating metersPerPixel() in geometry.ts.
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
    const res = await fetchWithTimeout(url, { cache: "no-store" }, AI_TIMEOUTS.imagery);
    if (!res.ok) {
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
        source: "google",
        primaryFailureReason: null,
      },
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("[static-map] Fetch failed:", reason);
    return { ok: false, reason };
  }
}
