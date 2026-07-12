/**
 * solar-segment-footprint.ts — synthesize a building-footprint mask from
 * Google Solar's per-plane roof SEGMENTS, for the case where SAM 2 fails
 * AND the Solar raster MASK is too sparse to trace.
 *
 * The Solar `buildingInsights` response gives an axis-aligned lat/lng
 * bounding box per roof plane (22 of them on a big house). Those boxes
 * collectively cover the WHOLE roof even when the separate dataLayers mask
 * GeoTIFF rasterized only a fraction of it. Unioning them into a filled
 * mask gives a deterministic, image-INDEPENDENT footprint we can trace
 * with the exact same machinery as the real mask (polygonFromSolarMask),
 * with WGS84 as the mask's native CRS so the round-trip is identity.
 *
 * COARSE BY CONSTRUCTION: each box is a north-aligned AABB of an angled
 * plane, so the union over-approximates the true footprint (blocky, and
 * up to ~half a plane's diagonal past the real eave). It is therefore a
 * LAST RESORT the caller must mark low trace-quality on — never a trusted
 * "ok". PURE — no server-only / network; node-testable.
 */

type LatLng = { lat: number; lng: number };

export type SegmentBox = {
  boundingBoxNE: LatLng | null;
  boundingBoxSW: LatLng | null;
};

/** Structurally matches Extract<SolarMaskOutcome, { ok: true }> so the
 *  result drops straight into polygonFromSolarMask. */
export type SegmentFootprintMask = {
  ok: true;
  mask: Uint8Array;
  width: number;
  height: number;
  crsLabel: string;
  origin: { x: number; y: number };
  pixelSize: { x: number; y: number };
  toLatLng: (x: number, y: number) => { lat: number; lng: number };
  areaFraction: number;
};

export function footprintMaskFromSolarSegments(
  segments: readonly SegmentBox[],
  opts?: { targetMetersPerPx?: number; maxGrid?: number; padPx?: number },
): SegmentFootprintMask | null {
  const boxes = segments
    .filter((s) => s.boundingBoxNE && s.boundingBoxSW)
    .map((s) => ({ ne: s.boundingBoxNE!, sw: s.boundingBoxSW! }))
    .filter(
      (b) =>
        Number.isFinite(b.ne.lat) &&
        Number.isFinite(b.ne.lng) &&
        Number.isFinite(b.sw.lat) &&
        Number.isFinite(b.sw.lng),
    );
  // Two planes minimum — a single box is just a rectangle SAM/mask would
  // already have handled, and the whole point here is unioning wings.
  if (boxes.length < 2) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const b of boxes) {
    minLat = Math.min(minLat, b.sw.lat, b.ne.lat);
    maxLat = Math.max(maxLat, b.sw.lat, b.ne.lat);
    minLng = Math.min(minLng, b.sw.lng, b.ne.lng);
    maxLng = Math.max(maxLng, b.sw.lng, b.ne.lng);
  }
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  if (!(latSpan > 0) || !(lngSpan > 0)) return null;

  const midLat = (minLat + maxLat) / 2;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((midLat * Math.PI) / 180);
  const target = opts?.targetMetersPerPx ?? 0.5;
  const maxGrid = opts?.maxGrid ?? 384;
  const pad = Math.max(1, opts?.padPx ?? 4);

  const gw = Math.max(16, Math.min(maxGrid, Math.round((lngSpan * mPerDegLng) / target)));
  const gh = Math.max(16, Math.min(maxGrid, Math.round((latSpan * mPerDegLat) / target)));

  // Degrees per inner-grid pixel.
  const dLng = lngSpan / gw;
  const dLat = latSpan / gh;

  // Pad the grid with a background border so the boundary trace never runs
  // off the edge (polygonFromSolarMask needs 0s around the shape).
  const W = gw + pad * 2;
  const H = gh + pad * 2;
  // Top-left corner of pixel (0,0), including the pad.
  const originLng = minLng - pad * dLng;
  const originLat = maxLat + pad * dLat;

  const mask = new Uint8Array(W * H);
  let filled = 0;
  for (const b of boxes) {
    const bMinLng = Math.min(b.ne.lng, b.sw.lng);
    const bMaxLng = Math.max(b.ne.lng, b.sw.lng);
    const bMinLat = Math.min(b.ne.lat, b.sw.lat);
    const bMaxLat = Math.max(b.ne.lat, b.sw.lat);
    const x0 = Math.max(0, Math.floor((bMinLng - originLng) / dLng));
    const x1 = Math.min(W - 1, Math.ceil((bMaxLng - originLng) / dLng));
    // Row grows downward as latitude decreases.
    const y0 = Math.max(0, Math.floor((originLat - bMaxLat) / dLat));
    const y1 = Math.min(H - 1, Math.ceil((originLat - bMinLat) / dLat));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (mask[i] === 0) {
          mask[i] = 1;
          filled++;
        }
      }
    }
  }
  if (filled === 0) return null;

  return {
    ok: true,
    mask,
    width: W,
    height: H,
    crsLabel: "WGS84 (segment bboxes)",
    // Native CRS IS lat/lng, so origin/pixelSize are in degrees and the
    // reverse map is the identity — an exact round-trip through
    // polygonFromSolarMask (nativeX = origin.x + px·pixelSize.x, etc).
    origin: { x: originLng, y: originLat },
    pixelSize: { x: dLng, y: -dLat },
    toLatLng: (x, y) => ({ lat: y, lng: x }),
    areaFraction: filled / (W * H),
  };
}
