/**
 * layers-io.ts — serialize/rebuild the SolarLayers raster stack so an
 * admin-lab run can be replayed offline (layersOverride) months later,
 * against a NEWER engine, without re-hitting Google. gzip keeps the
 * Postgres row reasonable (~1 MB for a typical 400×400 tile).
 *
 * The only non-data members of SolarLayers are the two CRS transform
 * closures; they're rebuilt from the stored EPSG label with the same
 * proj4 the fetcher uses (and the same local-meters approximation for
 * the degenerate WGS84 case, anchored at the tile center latitude).
 */
import { gzipSync, gunzipSync } from "node:zlib";
import proj4 from "proj4";
import type { SolarGrid, SolarLayers } from "../ai/solar-layers";

const FORMAT_VERSION = 1;

type SerializedLayers = {
  v: number;
  grid: Omit<SolarGrid, "toLatLng" | "fromLatLng">;
  /** Tile-center latitude — only used by the WGS84 fallback transforms. */
  anchorLat: number;
  dsmNoData: number;
  imageryQuality: string;
  imageryDate: string | null;
  mask: string; // base64
  dsm: string; // base64 of Float32Array bytes (little-endian platform order)
  rgb: string; // base64
};

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Decode into a fresh, 4-byte-aligned buffer (base64 Buffers may not be). */
function fromB64(s: string): Uint8Array {
  const raw = Buffer.from(s, "base64");
  const copy = new Uint8Array(raw.length);
  copy.set(raw);
  return copy;
}

export function buildGridTransforms(
  grid: Omit<SolarGrid, "toLatLng" | "fromLatLng">,
  anchorLat: number,
): Pick<SolarGrid, "toLatLng" | "fromLatLng"> {
  const { originX, originY, pxX, pxY, crsLabel } = grid;
  if (crsLabel === "WGS84") {
    return {
      toLatLng: (x, y) => ({ lat: originY + y * pxY, lng: originX + x * pxX }),
      fromLatLng: (la, ln) => ({ x: (ln - originX) / pxX, y: (la - originY) / pxY }),
    };
  }
  const converter = proj4(crsLabel, "EPSG:4326");
  void anchorLat; // WGS84-only; kept in the payload for forward-compat
  return {
    toLatLng: (x, y) => {
      const [lng2, lat2] = converter.forward([originX + x * pxX, originY + y * pxY]);
      return { lat: lat2, lng: lng2 };
    },
    fromLatLng: (la, ln) => {
      const [nx, ny] = converter.inverse([ln, la]);
      return { x: (nx - originX) / pxX, y: (ny - originY) / pxY };
    },
  };
}

export function serializeSolarLayers(layers: SolarLayers): string {
  const { toLatLng: _t, fromLatLng: _f, ...gridData } = layers.grid;
  const anchorLat = layers.grid.toLatLng(
    layers.grid.width / 2,
    layers.grid.height / 2,
  ).lat;
  const payload: SerializedLayers = {
    v: FORMAT_VERSION,
    grid: gridData,
    anchorLat,
    dsmNoData: layers.dsmNoData,
    imageryQuality: layers.imageryQuality,
    imageryDate: layers.imageryDate,
    mask: b64(layers.mask),
    dsm: b64(
      new Uint8Array(layers.dsm.buffer, layers.dsm.byteOffset, layers.dsm.byteLength),
    ),
    rgb: b64(layers.rgb),
  };
  return gzipSync(Buffer.from(JSON.stringify(payload), "utf8")).toString("base64");
}

export function deserializeSolarLayers(data: string): SolarLayers {
  const json = gunzipSync(Buffer.from(data, "base64")).toString("utf8");
  const p = JSON.parse(json) as SerializedLayers;
  if (p.v !== FORMAT_VERSION) {
    throw new Error(`unsupported layers snapshot version ${p.v}`);
  }
  const transforms = buildGridTransforms(p.grid, p.anchorLat);
  const dsmBytes = fromB64(p.dsm);
  return {
    grid: { ...p.grid, ...transforms },
    mask: fromB64(p.mask),
    dsm: new Float32Array(dsmBytes.buffer, 0, dsmBytes.byteLength / 4),
    dsmNoData: p.dsmNoData,
    rgb: fromB64(p.rgb),
    imageryQuality: p.imageryQuality,
    imageryDate: p.imageryDate,
  };
}
