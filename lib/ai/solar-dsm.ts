import "server-only";
import { fromArrayBuffer } from "geotiff";
import proj4 from "proj4";
import { getActiveApiKey } from "@/lib/api-keys";
import { AI_TIMEOUTS, fetchWithTimeout } from "./http";

export type DsmOutcome =
  | {
      ok: true;
      /** Heights in meters (above some reference, typically WGS84 ellipsoid). */
      heights: Float32Array;
      width: number;
      height: number;
      crsLabel: string;
      origin: { x: number; y: number };
      pixelSize: { x: number; y: number };
      /** Native CRS (lat/lng → x/y). Use this to find the DSM pixel for any latlng. */
      latLngToNative: (lat: number, lng: number) => { x: number; y: number };
      /** Sentinel value used by the DSM when no data exists at that pixel. */
      noDataValue: number;
    }
  | { ok: false; reason: string };

/**
 * Fetches the Google Solar API's Digital Surface Model (DSM) GeoTIFF for
 * the given lat/lng. The DSM gives per-pixel heights in meters, letting
 * us distinguish between flat eaves (where gutters go) and sloped rakes
 * (where they don't) by sampling elevation at line endpoints.
 *
 * Same fetch flow as the mask but pulls dsmUrl instead of maskUrl.
 */
export async function getDsmFromSolar(
  lat: number,
  lng: number,
  radiusMeters = 50,
): Promise<DsmOutcome> {
  const key =
    (await getActiveApiKey("GOOGLE_SOLAR")) ??
    (await getActiveApiKey("GOOGLE_MAPS"));
  if (!key) {
    return { ok: false, reason: "no GOOGLE_SOLAR/GOOGLE_MAPS key in vault" };
  }

  const dlUrl =
    `https://solar.googleapis.com/v1/dataLayers:get?` +
    `location.latitude=${lat}` +
    `&location.longitude=${lng}` +
    `&radiusMeters=${radiusMeters}` +
    `&view=FULL_LAYERS` +
    `&requiredQuality=LOW` +
    `&pixelSizeMeters=0.5` +
    `&key=${encodeURIComponent(key)}`;

  let dlData: { dsmUrl?: string; error?: { message?: string } };
  try {
    const res = await fetchWithTimeout(dlUrl, { cache: "no-store" }, AI_TIMEOUTS.solarDsm);
    if (!res.ok) {
      return { ok: false, reason: `Solar dataLayers HTTP ${res.status}` };
    }
    dlData = (await res.json()) as { dsmUrl?: string };
  } catch (e) {
    return {
      ok: false,
      reason: `Solar dataLayers network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!dlData.dsmUrl) {
    return {
      ok: false,
      reason: dlData.error?.message ?? "no dsmUrl in dataLayers response",
    };
  }

  const sep = dlData.dsmUrl.includes("?") ? "&" : "?";
  const dsmUrl = `${dlData.dsmUrl}${sep}key=${encodeURIComponent(key)}`;
  let tiffBytes: ArrayBuffer;
  try {
    const r = await fetchWithTimeout(dsmUrl, { cache: "no-store" }, AI_TIMEOUTS.solarDsm);
    if (!r.ok) return { ok: false, reason: `DSM HTTP ${r.status}` };
    tiffBytes = await r.arrayBuffer();
  } catch (e) {
    return {
      ok: false,
      reason: `DSM fetch error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  try {
    const tiff = await fromArrayBuffer(tiffBytes);
    const image = await tiff.getImage();
    const rasters = await image.readRasters();
    const first = Array.isArray(rasters) ? rasters[0] : rasters;
    const heights =
      first instanceof Float32Array
        ? first
        : new Float32Array(first as ArrayLike<number>);

    const width = image.getWidth();
    const height = image.getHeight();
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    const originX = origin[0];
    const originY = origin[1];
    const pxX = resolution[0];
    const pxY = -Math.abs(resolution[1]); // standard image-down/world-up

    const geoKeys = (image.getGeoKeys() ?? {}) as {
      ProjectedCSTypeGeoKey?: number;
      GeographicTypeGeoKey?: number;
      GDAL_NODATA?: string;
    };
    const epsg = geoKeys.ProjectedCSTypeGeoKey ?? geoKeys.GeographicTypeGeoKey;
    const fileDir = image.getFileDirectory() as { GDAL_NODATA?: string };
    const noDataStr = fileDir.GDAL_NODATA;
    const noDataValue = noDataStr ? parseFloat(noDataStr) : -9999;

    let crsLabel: string;
    let latLngToNative: (lat: number, lng: number) => { x: number; y: number };
    if (!epsg || epsg === 4326) {
      crsLabel = "WGS84";
      latLngToNative = (lat, lng) => ({ x: lng, y: lat });
    } else {
      crsLabel = `EPSG:${epsg}`;
      try {
        const converter = proj4("EPSG:4326", `EPSG:${epsg}`);
        latLngToNative = (lat, lng) => {
          const [x, y] = converter.forward([lng, lat]);
          return { x, y };
        };
      } catch {
        // unknown EPSG — assume identity
        latLngToNative = (lat, lng) => ({ x: lng, y: lat });
      }
    }

    return {
      ok: true,
      heights,
      width,
      height,
      crsLabel,
      origin: { x: originX, y: originY },
      pixelSize: { x: pxX, y: pxY },
      latLngToNative,
      noDataValue,
    };
  } catch (e) {
    return {
      ok: false,
      reason: `DSM decode failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Sample the DSM at a lat/lng. Returns null if outside the DSM bounds
 *  or if the pixel is no-data. */
export function sampleDsmAtLatLng(
  dsm: Extract<DsmOutcome, { ok: true }>,
  lat: number,
  lng: number,
): number | null {
  const { x: nativeX, y: nativeY } = dsm.latLngToNative(lat, lng);
  // Reverse the origin + pixelSize math from solar-mask
  const px = (nativeX - dsm.origin.x) / dsm.pixelSize.x;
  const py = (nativeY - dsm.origin.y) / dsm.pixelSize.y;
  const ix = Math.round(px);
  const iy = Math.round(py);
  if (ix < 0 || ix >= dsm.width || iy < 0 || iy >= dsm.height) return null;
  const v = dsm.heights[iy * dsm.width + ix];
  if (!Number.isFinite(v) || Math.abs(v - dsm.noDataValue) < 0.001) return null;
  return v;
}
