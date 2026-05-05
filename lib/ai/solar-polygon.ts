import "server-only";
import buffer from "@turf/buffer";
import { polygon as turfPolygon } from "@turf/helpers";
import type { SolarMaskOutcome } from "./solar-mask";
import {
  imagePixelToLatLng,
  latLngToImagePixel,
  orthogonalizePolygon,
  simplify,
} from "./geometry";
import type { RoofPolygon } from "./sam";

/** Roof overhang from wall (typical residential = 12-18in). Used to expand
 *  the building footprint mask to the actual gutter line position. */
const ROOF_OVERHANG_METERS = 0.45;

export type SolarPolygonResult = {
  /** RoofPolygon in satellite-tile pixel space — what canvas + downstream
   *  geometry consume. */
  polygon: RoofPolygon;
  /** Same polygon but as lat/lng vertices (closed ring, first === last)
   *  — used by the DSM edge classifier so it can sample heights in the
   *  DSM's native coordinate system. */
  ringLatLng: Array<{ lat: number; lng: number }>;
};

type Pt = { x: number; y: number };

/**
 * Convert a Google Solar API building mask into a polygon in our satellite
 * tile's pixel coordinate system. This replaces SAM 2 + Moore-Neighbor
 * tracing for cases where the Solar API has coverage (most US homes).
 *
 * Steps:
 *   1. Trace the binary mask boundary in mask-pixel space (Moore-Neighbor)
 *   2. For each boundary pixel, compute its lat/lng using the mask's
 *      georeferencing
 *   3. Project each lat/lng to our satellite tile's pixel space using
 *      the existing latLngToImagePixel helper
 *   4. Downsample to ≤400 points so downstream Douglas-Peucker is fast
 */
export function polygonFromSolarMask(
  mask: Extract<SolarMaskOutcome, { ok: true }>,
  satelliteCenter: { lat: number; lng: number },
  satelliteZoom: number,
  satelliteWidth: number,
  satelliteHeight: number,
): SolarPolygonResult | null {
  // 1. Trace boundary in mask-pixel space.
  //
  // The Solar API's dataLayers tile is centered on the requested lat/lng,
  // but the mask can include neighbors' rooftops within the search radius.
  // A naive top-down/left-right scan finds the topmost-leftmost foreground
  // pixel — which can be a NEIGHBOR's roof (rendering the polygon hundreds
  // of pixels off the actual building). Pick the connected component
  // containing the pixel nearest the mask center instead.
  const isFg = (x: number, y: number) => mask.mask[y * mask.width + x] > 0;
  const seed = findSeedNearCenter(mask.width, mask.height, isFg);
  if (!seed) return null;
  const traceStart = findComponentTopLeft(mask.width, mask.height, isFg, seed);
  const boundary = traceMooreNeighbor(
    mask.width,
    mask.height,
    isFg,
    traceStart,
  );
  if (boundary.length < 8) return null;

  // 2. Project each boundary pixel to lat/lng. We stay in lat/lng for
  // the buffer step so Turf can do correct great-circle expansion.
  const ringLatLng: Array<[number, number]> = boundary.map((p) => {
    const nativeX = mask.origin.x + p.x * mask.pixelSize.x;
    const nativeY = mask.origin.y + p.y * mask.pixelSize.y;
    const { lat, lng } = mask.toLatLng(nativeX, nativeY);
    return [lng, lat]; // GeoJSON convention: [lng, lat]
  });
  // Close the ring (GeoJSON requires first === last)
  if (
    ringLatLng.length &&
    (ringLatLng[0][0] !== ringLatLng[ringLatLng.length - 1][0] ||
      ringLatLng[0][1] !== ringLatLng[ringLatLng.length - 1][1])
  ) {
    ringLatLng.push(ringLatLng[0]);
  }

  // 3. Buffer the polygon outward to account for the roof overhang.
  // Solar API masks trace the WALL footprint; the actual roof (and
  // gutter line) extends ~12-18in beyond the wall.
  let bufferedRing = ringLatLng;
  try {
    const inputPoly = turfPolygon([ringLatLng]);
    const buffered = buffer(inputPoly, ROOF_OVERHANG_METERS / 1000, {
      units: "kilometers",
    });
    if (buffered && buffered.geometry.type === "Polygon") {
      bufferedRing = buffered.geometry.coordinates[0] as Array<
        [number, number]
      >;
    }
  } catch {
    // Buffer failed (degenerate polygon, etc.) — fall through with the
    // unbuffered ring. The eaves will sit slightly inside the actual
    // gutter line but still be useful.
  }

  // 4. Project the (possibly buffered) lat/lng ring to satellite tile
  // pixel space.
  const projected: Pt[] = bufferedRing.map(([lng, lat]) =>
    latLngToImagePixel(
      lat,
      lng,
      satelliteCenter.lat,
      satelliteCenter.lng,
      satelliteZoom,
      satelliteWidth,
      satelliteHeight,
    ),
  );

  // 4. Downsample (raw boundary can be 2000+ points)
  const downsampled =
    projected.length > 400
      ? projected.filter(
          (_, i) => i % Math.ceil(projected.length / 400) === 0,
        )
      : projected;

  if (downsampled.length < 8) return null;

  // 5. Architectural cleanup. The raw boundary follows mask pixels (0.5m
  // squares) and looks jagged — Gemini-style clean rectilinear lines come
  // from two passes:
  //   a) Douglas–Peucker collapses near-colinear noise. Epsilon ≈ 0.3m in
  //      image-pixel space (6 px at zoom-20 ≈ 0.3m on the ground): keeps
  //      architectural corners — bays, garage steps, dormers — while
  //      dropping sub-foot mask zigzag.
  //   b) Orthogonal regularization: snap edges to the dominant building
  //      axis ± 90° so walls become straight, like an architectural plan.
  const SIMPLIFY_EPSILON_PX = 6;
  const simplified = simplify(downsampled, SIMPLIFY_EPSILON_PX);
  const cleaned =
    simplified.length >= 4
      ? orthogonalizePolygon(simplified)
      : simplified;
  if (cleaned.length < 4) return null;

  // bbox + area in satellite tile space
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of cleaned) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const polygon: RoofPolygon = {
    points: cleaned,
    bbox: {
      x: Math.round(minX),
      y: Math.round(minY),
      width: Math.round(maxX - minX),
      height: Math.round(maxY - minY),
    },
    areaFraction: mask.areaFraction,
  };

  // Project the *cleaned* polygon back to lat/lng so the DSM edge
  // classifier samples elevation at the same vertices we're rendering —
  // otherwise classifier and renderer would disagree on which edges exist.
  const ringObjects = cleaned.map((p) =>
    imagePixelToLatLng(
      p.x,
      p.y,
      satelliteCenter.lat,
      satelliteCenter.lng,
      satelliteZoom,
      satelliteWidth,
      satelliteHeight,
    ),
  );
  // Close the ring (DSM walker iterates ring[i]→ring[i+1])
  if (
    ringObjects.length > 0 &&
    (ringObjects[0].lat !== ringObjects[ringObjects.length - 1].lat ||
      ringObjects[0].lng !== ringObjects[ringObjects.length - 1].lng)
  ) {
    ringObjects.push(ringObjects[0]);
  }

  return { polygon, ringLatLng: ringObjects };
}

/* ------------------------------------------------------------------ */
/*   Moore-Neighbor boundary tracing (same as sam.ts but inlined to   */
/*   avoid pulling pngjs import into this module)                     */
/* ------------------------------------------------------------------ */
/**
 * Find a foreground pixel close to the mask's center. The Solar API
 * centers the dataLayers tile on the requested lat/lng, so the user's
 * own building should be at (or near) the center of the mask. If the
 * exact center pixel is foreground, use it; otherwise spiral outward.
 */
function findSeedNearCenter(
  width: number,
  height: number,
  isFg: (x: number, y: number) => boolean,
): Pt | null {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  if (cx >= 0 && cx < width && cy >= 0 && cy < height && isFg(cx, cy)) {
    return { x: cx, y: cy };
  }
  let nearest: Pt | null = null;
  let nearestDist = Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isFg(x, y)) continue;
      const dx = x - cx;
      const dy = y - cy;
      const d = dx * dx + dy * dy;
      if (d < nearestDist) {
        nearestDist = d;
        nearest = { x, y };
      }
    }
  }
  return nearest;
}

/**
 * BFS the connected component containing `seed` and return its
 * top-left-most pixel — the natural Moore-Neighbor trace start.
 */
function findComponentTopLeft(
  width: number,
  height: number,
  isFg: (x: number, y: number) => boolean,
  seed: Pt,
): Pt {
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  const seedIdx = seed.y * width + seed.x;
  visited[seedIdx] = 1;
  queue.push(seedIdx);
  let bestX = seed.x;
  let bestY = seed.y;
  while (queue.length > 0) {
    const idx = queue.shift()!;
    const x = idx % width;
    const y = (idx - x) / width;
    if (y < bestY || (y === bestY && x < bestX)) {
      bestX = x;
      bestY = y;
    }
    if (x > 0 && !visited[idx - 1] && isFg(x - 1, y)) {
      visited[idx - 1] = 1;
      queue.push(idx - 1);
    }
    if (x < width - 1 && !visited[idx + 1] && isFg(x + 1, y)) {
      visited[idx + 1] = 1;
      queue.push(idx + 1);
    }
    if (y > 0 && !visited[idx - width] && isFg(x, y - 1)) {
      visited[idx - width] = 1;
      queue.push(idx - width);
    }
    if (y < height - 1 && !visited[idx + width] && isFg(x, y + 1)) {
      visited[idx + width] = 1;
      queue.push(idx + width);
    }
  }
  return { x: bestX, y: bestY };
}

function traceMooreNeighbor(
  width: number,
  height: number,
  isFg: (x: number, y: number) => boolean,
  start: Pt,
): Pt[] {
  const startX = start.x;
  const startY = start.y;
  if (!isFg(startX, startY)) return [];

  const dirs: ReadonlyArray<readonly [number, number]> = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];

  const boundary: Pt[] = [{ x: startX, y: startY }];
  let cx = startX;
  let cy = startY;
  let backtrackDir = 6; // we entered the start from the west

  const maxIters = width * height * 2;
  for (let iter = 0; iter < maxIters; iter++) {
    let found = false;
    for (let i = 0; i < 8; i++) {
      const dirIdx = (backtrackDir + 1 + i) % 8;
      const nx = cx + dirs[dirIdx][0];
      const ny = cy + dirs[dirIdx][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (isFg(nx, ny)) {
        backtrackDir = (dirIdx + 4) % 8;
        cx = nx;
        cy = ny;
        boundary.push({ x: cx, y: cy });
        found = true;
        break;
      }
    }
    if (!found) break;
    if (boundary.length > 8 && cx === startX && cy === startY) break;
  }

  if (
    boundary.length > 1 &&
    boundary[boundary.length - 1].x === boundary[0].x &&
    boundary[boundary.length - 1].y === boundary[0].y
  ) {
    boundary.pop();
  }
  return boundary;
}
