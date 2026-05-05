import "server-only";
import { fromArrayBuffer, type GeoTIFFImage } from "geotiff";
import proj4 from "proj4";
import { getActiveApiKey } from "@/lib/api-keys";

export type SolarMaskOutcome =
  | {
      ok: true;
      /** Binary mask: 1 = building, 0 = background. Row-major. */
      mask: Uint8Array;
      width: number;
      height: number;
      /** Detected CRS label (for diagnostic display). */
      crsLabel: string;
      /** Top-left corner of the (0,0) pixel in the mask's native CRS. */
      origin: { x: number; y: number };
      /** Per-pixel size in the native CRS (y is signed; usually negative). */
      pixelSize: { x: number; y: number };
      /** Convert a native-CRS point into WGS84 lat/lng. */
      toLatLng: (x: number, y: number) => { lat: number; lng: number };
      /** Coverage stat for diagnostics. */
      areaFraction: number;
    }
  | { ok: false; reason: string };

/**
 * Fetches Google Solar API's pre-segmented building mask for the given
 * lat/lng. This is dramatically more reliable than running our own
 * segmentation (SAM 2 via fal.ai) because Google has already produced
 * a verified building footprint server-side using their proprietary
 * pipeline.
 *
 * Two API calls:
 *   1. `dataLayers:get` — returns metadata + a maskUrl pointing at a
 *      GeoTIFF file with the binary building mask.
 *   2. The maskUrl GeoTIFF — needs Solar API key appended; we decode
 *      with geotiff.js to get the raw pixel grid + georeferencing.
 *
 * Returns the mask as a Uint8Array along with the lat/lng origin and
 * pixel-size so the caller can map mask pixels to any other coordinate
 * system (e.g., the Static Maps tile we'll display).
 */
export async function getRoofMaskFromSolar(
  lat: number,
  lng: number,
  /** Search radius in meters around the point (default 50 covers most homes). */
  radiusMeters = 50,
): Promise<SolarMaskOutcome> {
  const key =
    (await getActiveApiKey("GOOGLE_SOLAR")) ??
    (await getActiveApiKey("GOOGLE_MAPS"));
  if (!key) {
    return { ok: false, reason: "no GOOGLE_SOLAR/GOOGLE_MAPS key in vault" };
  }

  // 1. Get the mask URL from dataLayers:get
  const dlUrl =
    `https://solar.googleapis.com/v1/dataLayers:get?` +
    `location.latitude=${lat}` +
    `&location.longitude=${lng}` +
    `&radiusMeters=${radiusMeters}` +
    `&view=FULL_LAYERS` +
    `&requiredQuality=LOW` +
    `&pixelSizeMeters=0.5` +
    `&key=${encodeURIComponent(key)}`;

  type DataLayersResponse = {
    maskUrl?: string;
    imageryQuality?: string;
    error?: { message?: string };
  };

  let dlData: DataLayersResponse;
  try {
    const res = await fetch(dlUrl, { cache: "no-store" });
    if (!res.ok) {
      return {
        ok: false,
        reason: `Solar dataLayers HTTP ${res.status}`,
      };
    }
    dlData = (await res.json()) as DataLayersResponse;
  } catch (e) {
    return {
      ok: false,
      reason: `Solar dataLayers network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!dlData.maskUrl) {
    return {
      ok: false,
      reason: dlData.error?.message ?? "Solar dataLayers returned no maskUrl",
    };
  }

  // 2. Fetch the GeoTIFF mask. Solar's maskUrl needs the API key
  // appended as a query param.
  const sep = dlData.maskUrl.includes("?") ? "&" : "?";
  const maskUrl = `${dlData.maskUrl}${sep}key=${encodeURIComponent(key)}`;

  let tiffBytes: ArrayBuffer;
  try {
    const res = await fetch(maskUrl, { cache: "no-store" });
    if (!res.ok) {
      return { ok: false, reason: `mask GeoTIFF HTTP ${res.status}` };
    }
    tiffBytes = await res.arrayBuffer();
  } catch (e) {
    return {
      ok: false,
      reason: `mask GeoTIFF fetch error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 3. Decode with geotiff.js
  let image: GeoTIFFImage;
  let raster: Uint8Array;
  try {
    const tiff = await fromArrayBuffer(tiffBytes);
    image = await tiff.getImage();
    const rasters = await image.readRasters();
    // The mask raster is single-channel; readRasters returns it as the
    // first array. Coerce to Uint8Array for consistency.
    const first = Array.isArray(rasters) ? rasters[0] : rasters;
    raster = first instanceof Uint8Array ? first : new Uint8Array(first as ArrayLike<number>);
  } catch (e) {
    return {
      ok: false,
      reason: `GeoTIFF decode failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const width = image.getWidth();
  const height = image.getHeight();

  // 4. Extract georeferencing.
  let originX: number;
  let originY: number;
  let pxX: number;
  let pxY: number;
  let crsLabel: string;
  let toLatLng: (x: number, y: number) => { lat: number; lng: number };
  try {
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    originX = origin[0];
    originY = origin[1];
    pxX = resolution[0];
    pxY = resolution[1];

    // Get the actual EPSG code from the GeoTIFF's GeoKeys. Solar API
    // returns local UTM zones (e.g. EPSG:32610 for Lake Stevens / WA in
    // UTM Zone 10N) for sub-meter local accuracy — NOT Web Mercator.
    const geoKeys = (image.getGeoKeys() ?? {}) as {
      ProjectedCSTypeGeoKey?: number;
      GeographicTypeGeoKey?: number;
    };
    const epsg = geoKeys.ProjectedCSTypeGeoKey ?? geoKeys.GeographicTypeGeoKey;

    if (!epsg) {
      crsLabel = "unknown";
      toLatLng = (x, y) => ({ lat: y, lng: x }); // assume WGS84
    } else if (epsg === 4326) {
      crsLabel = "WGS84";
      toLatLng = (x, y) => ({ lat: y, lng: x });
    } else {
      crsLabel = `EPSG:${epsg}`;
      // proj4 ships definitions for common EPSGs (4326, 3857, all UTM zones).
      // For an arbitrary EPSG we'd need to register a definition; try
      // the canonical name first and if proj4 doesn't recognize it we
      // fall back to a Web Mercator inverse (good enough as a sanity-
      // check rendering even if slightly off).
      const epsgName = `EPSG:${epsg}`;
      try {
        // proj4(from, to) returns a converter; calling it on [x,y] gives [lng,lat].
        const converter = proj4(epsgName, "EPSG:4326");
        toLatLng = (x, y) => {
          const [lng, lat] = converter.forward([x, y]);
          return { lat, lng };
        };
      } catch {
        // Fallback: treat as Web Mercator
        const R = 6378137;
        const RAD_TO_DEG = 180 / Math.PI;
        toLatLng = (x, y) => ({
          lng: (x / R) * RAD_TO_DEG,
          lat:
            (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * RAD_TO_DEG,
        });
        crsLabel = `${epsgName} (proj4 unknown — using Web Mercator fallback)`;
      }
    }
  } catch (e) {
    return {
      ok: false,
      reason: `GeoTIFF georef missing: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Count foreground pixels for diagnostics
  let fgCount = 0;
  for (let i = 0; i < raster.length; i++) {
    if (raster[i] > 0) fgCount++;
  }
  const totalPx = width * height;
  if (fgCount === 0) {
    return {
      ok: false,
      reason: `Solar mask has no foreground pixels (${width}×${height}, all background)`,
    };
  }
  if (fgCount / totalPx > 0.95) {
    return {
      ok: false,
      reason: `Solar mask is ~all foreground (${((fgCount / totalPx) * 100).toFixed(1)}%) — segmentation failed`,
    };
  }

  return {
    ok: true,
    mask: raster,
    width,
    height,
    crsLabel,
    origin: { x: originX, y: originY },
    pixelSize: { x: pxX, y: pxY },
    toLatLng,
    areaFraction: fgCount / totalPx,
  };
}
