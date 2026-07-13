import "server-only";
import { fromArrayBuffer, type GeoTIFFImage } from "geotiff";
import proj4 from "proj4";
import { getActiveApiKey } from "@/lib/api-keys";
import { AI_TIMEOUTS, fetchWithTimeout } from "./http";

/**
 * solar-layers.ts — the imagery backbone of the solar-first estimate
 * engine.
 *
 * ONE `dataLayers:get` call (flat-priced per call, regardless of how many
 * GeoTIFFs we then download) returns three co-registered rasters:
 *
 *   maskUrl — building mask (1 = roof) at up to 0.1 m/px
 *   dsmUrl  — digital surface model, heights in meters, 0.1 m/px
 *   rgbUrl  — the aerial ORTHOPHOTO Google derived the mask/DSM from
 *
 * All three share one projected grid (a local UTM zone), captured on the
 * SAME date. That property is what the old pipeline never exploited: it
 * traced a blurry Mapbox tile from a different capture and then tried to
 * reconcile it with Solar-derived geometry. Here the footprint, the
 * heights, and the photo the contractor sees are the same acquisition —
 * aligned by construction, with a uniform meters-per-pixel scale (no
 * Mercator latitude correction, no double-scale traps).
 *
 * The previous code fetched the mask at pixelSizeMeters=0.5 (25× fewer
 * pixels than the API offers) and never fetched the RGB at all — the
 * root of both the "blobby footprint" and the "bad satellite picture"
 * complaints.
 */

export type SolarGrid = {
  width: number;
  height: number;
  /** Top-left corner of pixel (0,0) in the native (projected) CRS. */
  originX: number;
  originY: number;
  /** Per-pixel step in native units. pxY is negative (y grows south). */
  pxX: number;
  pxY: number;
  /** Uniform ground resolution of the grid, meters per pixel. */
  metersPerPixel: number;
  crsLabel: string;
  /** Pixel (col,row) → WGS84. Accepts fractional pixels. */
  toLatLng: (x: number, y: number) => { lat: number; lng: number };
  /** WGS84 → pixel (col,row), fractional. */
  fromLatLng: (lat: number, lng: number) => { x: number; y: number };
};

export type SolarLayers = {
  grid: SolarGrid;
  /** Row-major; >0 = building. Same dims as grid. */
  mask: Uint8Array;
  /** Row-major heights in meters. Same dims as grid. */
  dsm: Float32Array;
  dsmNoData: number;
  /** Interleaved RGB bytes (3 per pixel). Same dims as grid. */
  rgb: Uint8Array;
  imageryQuality: string;
  /** ISO date of the underlying aerial capture, when reported. */
  imageryDate: string | null;
};

export type SolarLayersOutcome =
  | { ok: true; layers: SolarLayers }
  | { ok: false; reason: string };

type DataLayersResponse = {
  imageryDate?: { year?: number; month?: number; day?: number };
  imageryQuality?: string;
  dsmUrl?: string;
  rgbUrl?: string;
  maskUrl?: string;
  error?: { message?: string; status?: string };
};

type DecodedTiff = {
  image: GeoTIFFImage;
  width: number;
  height: number;
  originX: number;
  originY: number;
  pxX: number;
  pxY: number;
  epsg: number | null;
  noData: number;
};

async function decodeTiff(buf: ArrayBuffer): Promise<DecodedTiff> {
  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const geoKeys = (image.getGeoKeys() ?? {}) as {
    ProjectedCSTypeGeoKey?: number;
    GeographicTypeGeoKey?: number;
  };
  const fileDir = image.getFileDirectory() as { GDAL_NODATA?: string };
  const noDataStr = fileDir.GDAL_NODATA;
  return {
    image,
    width: image.getWidth(),
    height: image.getHeight(),
    originX: origin[0],
    originY: origin[1],
    pxX: resolution[0],
    // Convention: image y grows down, world y grows up. Some encoders
    // store the pixel scale unsigned; force the sign.
    pxY: -Math.abs(resolution[1]),
    epsg: geoKeys.ProjectedCSTypeGeoKey ?? geoKeys.GeographicTypeGeoKey ?? null,
    noData: noDataStr ? parseFloat(noDataStr) : -9999,
  };
}

async function fetchTiff(
  url: string,
  key: string,
  label: string,
): Promise<ArrayBuffer> {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetchWithTimeout(
    `${url}${sep}key=${encodeURIComponent(key)}`,
    { cache: "no-store" },
    AI_TIMEOUTS.solarLayers,
  );
  if (!res.ok) throw new Error(`${label} GeoTIFF HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** Grids must agree for pixel-space geometry to be shared across layers.
 *  Tolerance: 1e-6 native units on origin, 1e-9 on pixel size. */
function sameGrid(a: DecodedTiff, b: DecodedTiff): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    Math.abs(a.originX - b.originX) < 1e-6 &&
    Math.abs(a.originY - b.originY) < 1e-6 &&
    Math.abs(a.pxX - b.pxX) < 1e-9 &&
    Math.abs(a.pxY - b.pxY) < 1e-9
  );
}

/**
 * Fetch the co-registered mask+DSM+RGB stack around a point.
 *
 * `radiusMeters` should comfortably cover the building (caller derives it
 * from the buildingInsights bbox). pixelSizeMeters=0.1 is the API default
 * and its finest step; coarser-native areas simply come back coarser —
 * we read the actual grid resolution off the GeoTIFF rather than trusting
 * the request parameter.
 */
export async function fetchSolarLayers(
  lat: number,
  lng: number,
  radiusMeters = 50,
): Promise<SolarLayersOutcome> {
  const key =
    (await getActiveApiKey("GOOGLE_SOLAR")) ??
    (await getActiveApiKey("GOOGLE_MAPS"));
  if (!key) {
    return { ok: false, reason: "no GOOGLE_SOLAR/GOOGLE_MAPS key in vault" };
  }
  return fetchSolarLayersWithKey(key, lat, lng, radiusMeters);
}

/** Key-injected variant so verification scripts can bypass the DB vault. */
export async function fetchSolarLayersWithKey(
  key: string,
  lat: number,
  lng: number,
  radiusMeters = 50,
): Promise<SolarLayersOutcome> {
  // IMAGERY_LAYERS = DSM + RGB + mask; skips the flux/shade products we
  // don't use. requiredQuality=LOW means "LOW or better" — return the
  // best available (exactQualityRequired defaults false).
  const dlUrl =
    `https://solar.googleapis.com/v1/dataLayers:get?` +
    `location.latitude=${lat}` +
    `&location.longitude=${lng}` +
    `&radiusMeters=${Math.round(radiusMeters)}` +
    `&view=IMAGERY_LAYERS` +
    `&requiredQuality=LOW` +
    `&pixelSizeMeters=0.1` +
    `&key=${encodeURIComponent(key)}`;

  let dl: DataLayersResponse;
  try {
    const res = await fetchWithTimeout(dlUrl, { cache: "no-store" }, AI_TIMEOUTS.solar);
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as DataLayersResponse;
        if (body.error?.message) detail = ` — ${body.error.message}`;
      } catch {
        // not JSON
      }
      return { ok: false, reason: `dataLayers HTTP ${res.status}${detail}` };
    }
    dl = (await res.json()) as DataLayersResponse;
  } catch (e) {
    return {
      ok: false,
      reason: `dataLayers network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!dl.maskUrl || !dl.dsmUrl || !dl.rgbUrl) {
    return {
      ok: false,
      reason:
        dl.error?.message ??
        `dataLayers missing layer URLs (mask:${!!dl.maskUrl} dsm:${!!dl.dsmUrl} rgb:${!!dl.rgbUrl})`,
    };
  }

  // Download + decode the three GeoTIFFs in parallel.
  let maskT: DecodedTiff;
  let dsmT: DecodedTiff;
  let rgbT: DecodedTiff;
  let maskRaster: Uint8Array;
  let dsmRaster: Float32Array;
  let rgbRaster: Uint8Array;
  try {
    const [maskBuf, dsmBuf, rgbBuf] = await Promise.all([
      fetchTiff(dl.maskUrl, key, "mask"),
      fetchTiff(dl.dsmUrl, key, "DSM"),
      fetchTiff(dl.rgbUrl, key, "RGB"),
    ]);
    [maskT, dsmT, rgbT] = await Promise.all([
      decodeTiff(maskBuf),
      decodeTiff(dsmBuf),
      decodeTiff(rgbBuf),
    ]);

    const maskR = await maskT.image.readRasters();
    const m0 = Array.isArray(maskR) ? maskR[0] : maskR;
    maskRaster =
      m0 instanceof Uint8Array ? m0 : new Uint8Array(m0 as ArrayLike<number>);

    const dsmR = await dsmT.image.readRasters();
    const d0 = Array.isArray(dsmR) ? dsmR[0] : dsmR;
    dsmRaster =
      d0 instanceof Float32Array
        ? d0
        : new Float32Array(d0 as ArrayLike<number>);

    // Interleaved RGB(A?) — normalize to tight 3-byte RGB.
    const rgbR = (await rgbT.image.readRasters({
      interleave: true,
    })) as ArrayLike<number> & { length: number };
    const samples = rgbT.image.getSamplesPerPixel();
    const pxCount = rgbT.width * rgbT.height;
    rgbRaster = new Uint8Array(pxCount * 3);
    if (samples === 3) {
      rgbRaster.set(
        rgbR instanceof Uint8Array
          ? rgbR
          : Uint8Array.from(rgbR as ArrayLike<number>),
      );
    } else {
      for (let i = 0; i < pxCount; i++) {
        rgbRaster[i * 3] = rgbR[i * samples] as number;
        rgbRaster[i * 3 + 1] = rgbR[i * samples + 1] as number;
        rgbRaster[i * 3 + 2] = rgbR[i * samples + 2] as number;
      }
    }
  } catch (e) {
    return {
      ok: false,
      reason: `layer fetch/decode failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // The whole engine assumes one shared grid — refuse to guess if the
  // API ever returns mismatched extents/resolutions.
  if (!sameGrid(maskT, dsmT) || !sameGrid(maskT, rgbT)) {
    return {
      ok: false,
      reason: `layer grids disagree (mask ${maskT.width}×${maskT.height} @${maskT.pxX}, dsm ${dsmT.width}×${dsmT.height} @${dsmT.pxX}, rgb ${rgbT.width}×${rgbT.height} @${rgbT.pxX})`,
    };
  }

  // Georeferencing: Solar returns a projected local UTM zone (meters).
  const epsg = maskT.epsg;
  if (!epsg) {
    return { ok: false, reason: "GeoTIFF carries no EPSG code" };
  }
  let toLatLng: SolarGrid["toLatLng"];
  let fromLatLng: SolarGrid["fromLatLng"];
  let crsLabel: string;
  let metersPerPixel: number;
  const { originX, originY, pxX, pxY } = maskT;
  if (epsg === 4326) {
    // Degenerate (never observed from Solar, but cheap to support):
    // approximate local meters-per-degree at this latitude.
    crsLabel = "WGS84";
    const mLat = 110_540;
    const mLng = 111_320 * Math.cos((lat * Math.PI) / 180);
    metersPerPixel = Math.abs(pxX) * mLng;
    toLatLng = (x, y) => ({
      lat: originY + y * pxY,
      lng: originX + x * pxX,
    });
    fromLatLng = (la, ln) => ({
      x: (ln - originX) / pxX,
      y: (la - originY) / pxY,
    });
  } else {
    crsLabel = `EPSG:${epsg}`;
    let converter: proj4.Converter;
    try {
      converter = proj4(`EPSG:${epsg}`, "EPSG:4326");
    } catch {
      // proj4 ships all UTM zones; an unknown code here means something
      // unexpected — bail rather than render offset geometry.
      return { ok: false, reason: `unknown CRS EPSG:${epsg}` };
    }
    metersPerPixel = Math.abs(pxX);
    toLatLng = (x, y) => {
      const [lng2, lat2] = converter.forward([
        originX + x * pxX,
        originY + y * pxY,
      ]);
      return { lat: lat2, lng: lng2 };
    };
    fromLatLng = (la, ln) => {
      const [nx, ny] = converter.inverse([ln, la]);
      return { x: (nx - originX) / pxX, y: (ny - originY) / pxY };
    };
  }

  // Sanity: a mask with nothing (or everything) foreground is unusable.
  let fg = 0;
  for (let i = 0; i < maskRaster.length; i++) if (maskRaster[i] > 0) fg++;
  if (fg === 0) {
    return { ok: false, reason: "building mask is empty (no roof pixels)" };
  }
  if (fg / maskRaster.length > 0.95) {
    return { ok: false, reason: "building mask is ~all foreground" };
  }

  const d = dl.imageryDate;
  const imageryDate =
    d?.year && d?.month && d?.day
      ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
      : null;

  return {
    ok: true,
    layers: {
      grid: {
        width: maskT.width,
        height: maskT.height,
        originX,
        originY,
        pxX,
        pxY,
        metersPerPixel,
        crsLabel,
        toLatLng,
        fromLatLng,
      },
      mask: maskRaster,
      dsm: dsmRaster,
      dsmNoData: dsmT.noData,
      rgb: rgbRaster,
      imageryQuality: dl.imageryQuality ?? "UNKNOWN",
      imageryDate,
    },
  };
}
