/**
 * solar-geometry.ts — PURE geometry for the solar-first estimate engine.
 *
 * Everything here operates on the dataLayers pixel grid: a projected UTM
 * raster where 1 px = a fixed number of METERS in both axes (north-up,
 * x → east, y → south). That uniformity is the whole point — lengths are
 * `pixels × metersPerPixel`, offsets are planar, and there is no Mercator
 * latitude correction anywhere.
 *
 * No "server-only", no fetch, no keys: the node test suite drives these
 * functions with synthetic masks and DSMs.
 */

import { simplify, orthogonalizePolygon, polygonSelfIntersects, ensureCCW, pointInPolygon } from "./geometry";
import { symmetricHausdorffPx } from "./roof-geom";

export type Pt = { x: number; y: number };

/* ------------------------------------------------------------------ */
/*  Mask cleanup: morphological close                                  */
/* ------------------------------------------------------------------ */

/**
 * Close (dilate then erode, square kernel) the building mask. The Solar
 * mask traces WALLS, so where two wings meet at a reentrant notch the
 * walls step in even though the ROOFS above merge — the traced footprint
 * then grows sub-meter notch edges that render as floating gutter stubs
 * on top of the visible roof. Closing bridges gaps up to ~2·radius and
 * leaves genuine courtyards/steps (wider than that) alone.
 *
 * Separable implementation: two 1-D dilate passes then two 1-D erode
 * passes — O(W·H·r), fine at 1000×1000 / r≈9.
 *
 * CALLER MUST GUARD against bridging to a NEIGHBOR building (the reason
 * an earlier morphological close was reverted in the legacy path): pick
 * the center component before/after and compare areas — a big jump means
 * the close swallowed something that isn't this house.
 */
function morphPass(
  src: Uint8Array,
  width: number,
  height: number,
  r: number,
  horizontal: boolean,
  op: "max" | "min",
): Uint8Array {
  const out = new Uint8Array(width * height);
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  for (let o = 0; o < outer; o++) {
    for (let i = 0; i < inner; i++) {
      let v = op === "max" ? 0 : 1;
      const lo = Math.max(0, i - r);
      const hi = Math.min(inner - 1, i + r);
      for (let k = lo; k <= hi; k++) {
        const idx = horizontal ? o * width + k : k * width + o;
        const s = src[idx] > 0 ? 1 : 0;
        if (op === "max") {
          if (s === 1) {
            v = 1;
            break;
          }
        } else if (s === 0) {
          v = 0;
          break;
        }
      }
      out[horizontal ? o * width + i : i * width + o] = v;
    }
  }
  return out;
}

/** Separable square dilation. */
export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radiusPx: number,
): Uint8Array {
  const r = Math.max(0, Math.round(radiusPx));
  if (r === 0) return mask.slice();
  return morphPass(
    morphPass(mask, width, height, r, true, "max"),
    width,
    height,
    r,
    false,
    "max",
  );
}

export function closeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radiusPx: number,
): Uint8Array {
  const r = Math.max(0, Math.round(radiusPx));
  if (r === 0) return mask.slice();
  let m = dilateMask(mask, width, height, r);
  m = morphPass(m, width, height, r, true, "min");
  m = morphPass(m, width, height, r, false, "min");
  return m;
}

/* ------------------------------------------------------------------ */
/*  Mask → footprint boundary                                          */
/* ------------------------------------------------------------------ */

/**
 * Trace the building footprint from a binary mask: pick the connected
 * component nearest the grid center (the requested address), BFS it,
 * Moore-trace its boundary. Returns null when there's no usable region.
 *
 * `touchesEdge` reports whether the traced component reaches the raster
 * border — i.e. the building may extend beyond the requested radius and
 * the caller should degrade trust (or re-fetch wider).
 */
export function traceMaskFootprint(
  mask: Uint8Array,
  width: number,
  height: number,
): {
  boundary: Pt[];
  areaPx: number;
  touchesEdge: boolean;
  /** 1 = pixel belongs to the traced (center) component. */
  componentMask: Uint8Array;
} | null {
  const isFg = (x: number, y: number) => mask[y * width + x] > 0;

  const seed = findSeedNearCenter(width, height, isFg);
  if (!seed) return null;

  // BFS the seed's component: top-left start pixel for the Moore walk,
  // component pixel count, and whether it touches the raster border.
  const visited = new Uint8Array(width * height);
  const queue: number[] = [seed.y * width + seed.x];
  visited[queue[0]] = 1;
  let head = 0;
  let bestX = seed.x;
  let bestY = seed.y;
  let count = 0;
  let touchesEdge = false;
  const compMask = new Uint8Array(width * height);
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;
    count++;
    compMask[idx] = 1;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      touchesEdge = true;
    }
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

  const compFg = (x: number, y: number) => compMask[y * width + x] === 1;
  const boundary = traceMooreNeighbor(width, height, compFg, {
    x: bestX,
    y: bestY,
  });
  if (boundary.length < 8) return null;
  return { boundary, areaPx: count, touchesEdge, componentMask: compMask };
}

/* ------------------------------------------------------------------ */
/*  Ground height + attached-roof (porch/carport) recovery             */
/* ------------------------------------------------------------------ */

/**
 * Ground elevation near the building: low percentile of DSM samples in a
 * band outside the component's bbox, mask-negative pixels only (so a
 * neighbor's roof or a parked RV doesn't read as "ground").
 */
export function estimateGroundHeightM(args: {
  mask: Uint8Array;
  dsm: Float32Array;
  dsmNoData: number;
  width: number;
  height: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  metersPerPixel: number;
}): number | null {
  const { mask, dsm, dsmNoData, width, height, bbox, metersPerPixel } = args;
  const bandPx = 8 / metersPerPixel;
  const stepPx = Math.max(1, Math.round(1 / metersPerPixel));
  const vals: number[] = [];
  const take = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
    if (mask[yi * width + xi] > 0) return;
    const v = dsm[yi * width + xi];
    if (!Number.isFinite(v) || Math.abs(v - dsmNoData) < 0.001) return;
    if (v < -450 || v > 9000) return;
    vals.push(v);
  };
  for (let x = bbox.minX - bandPx; x <= bbox.maxX + bandPx; x += stepPx) {
    for (const y of [
      bbox.minY - bandPx / 2,
      bbox.maxY + bandPx / 2,
      bbox.minY - bandPx,
      bbox.maxY + bandPx,
    ]) {
      take(x, y);
    }
  }
  for (let y = bbox.minY - bandPx; y <= bbox.maxY + bandPx; y += stepPx) {
    for (const x of [
      bbox.minX - bandPx / 2,
      bbox.maxX + bandPx / 2,
      bbox.minX - bandPx,
      bbox.maxX + bandPx,
    ]) {
      take(x, y);
    }
  }
  if (vals.length < 12) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.15)];
}

/**
 * Recover attached roofs the building mask missed. Google's mask maps
 * the HEATED footprint — porches, covered entries and carports routinely
 * fall outside it even though their roofs need gutters.
 *
 * A pixel is a candidate when it is
 *   • outside the mask,
 *   • 1.8–7.5 m above ground (roof-height band: above cars/fences,
 *     below the tree canopy's upper story),
 *   • NOT vegetation-green in the orthophoto, and
 *   • locally SMOOTH in the DSM (roofs are planar; tree crowns are not).
 *
 * Candidate components are kept only when they are ≥3 m² and ≤90 m²,
 * sit within `adjacencyM` of the main footprint (porches attach; the
 * neighbor's house doesn't), and don't touch the raster edge. Total
 * added area is capped at half the main footprint as a sanity brake.
 */
export function recoverAttachedRoofs(args: {
  mask: Uint8Array;
  componentMask: Uint8Array;
  dsm: Float32Array;
  dsmNoData: number;
  rgb: Uint8Array;
  width: number;
  height: number;
  metersPerPixel: number;
  groundHeightM: number;
  adjacencyM?: number;
}): { mask: Uint8Array; addedAreasM2: number[]; addedPx: number } {
  const {
    mask,
    componentMask,
    dsm,
    dsmNoData,
    rgb,
    width,
    height,
    metersPerPixel,
    groundHeightM,
  } = args;
  const adjacencyPx = (args.adjacencyM ?? 0.7) / metersPerPixel;
  const m2PerPx = metersPerPixel * metersPerPixel;

  const validH = (v: number) =>
    Number.isFinite(v) && Math.abs(v - dsmNoData) > 0.001 && v > -450 && v < 9000;

  // Per-pixel candidate test.
  const candidates = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask[i] > 0) continue;
      const h = dsm[i];
      if (!validH(h)) continue;
      const above = h - groundHeightM;
      if (above < 1.8 || above > 7.5) continue;
      // Vegetation: green-dominant in the orthophoto. Slightly loose on
      // purpose — shadowed foliage barely reads green, so the DSM
      // roughness + RGB texture tests below carry those cases.
      const r = rgb[i * 3];
      const g = rgb[i * 3 + 1];
      const b = rgb[i * 3 + 2];
      if (g > r + 6 && g > b + 6) continue;
      // Roughness: local 3×3 height range. A porch roof is planar — even
      // a 45° pitch only changes ~0.3 m across the window; hedge/tree
      // crowns (including dark SHADOWED ones the green test misses) jump
      // half a meter or more.
      let lo = h;
      let hi = h;
      let bad = false;
      for (let dy = -1; dy <= 1 && !bad; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = dsm[(y + dy) * width + (x + dx)];
          if (!validH(v)) {
            bad = true;
            break;
          }
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (bad || hi - lo > 0.5) continue;
      // Photo texture: roof surfaces are tonally uniform; canopy is
      // speckled even in shadow. Local 3×3 luminance spread.
      let lLo = 255;
      let lHi = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = ((y + dy) * width + (x + dx)) * 3;
          const lum = (rgb[j] + rgb[j + 1] + rgb[j + 2]) / 3;
          if (lum < lLo) lLo = lum;
          if (lum > lHi) lHi = lum;
        }
      }
      if (lHi - lLo > 52) continue;
      candidates[i] = 1;
    }
  }

  // Adjacency zone: main footprint dilated.
  const nearMain = dilateMask(componentMask, width, height, adjacencyPx);

  // Connected components over the candidates; accept porch-sized ones
  // that touch the adjacency zone and stay off the raster edge.
  const out = mask.slice();
  const visited = new Uint8Array(width * height);
  const addedAreasM2: number[] = [];
  let mainArea = 0;
  for (let i = 0; i < componentMask.length; i++) mainArea += componentMask[i];
  let addedTotalPx = 0;

  for (let start = 0; start < candidates.length; start++) {
    if (candidates[start] === 0 || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let head = 0;
    const px: number[] = [];
    let touchesMain = false;
    let touchesEdge = false;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      px.push(idx);
      const x = idx % width;
      const y = (idx - x) / width;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2) {
        touchesEdge = true;
      }
      if (nearMain[idx] > 0) touchesMain = true;
      const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
      for (const n of neighbors) {
        if (n < 0 || n >= candidates.length) continue;
        if (candidates[n] === 0 || visited[n]) continue;
        visited[n] = 1;
        queue.push(n);
      }
    }
    const areaM2 = px.length * m2PerPx;
    if (!touchesMain || touchesEdge) continue;
    if (areaM2 < 3 || areaM2 > 90) continue;
    // Shape: porches/carports are compact rectangles. A hedge row or a
    // tree line that survived the pixel tests reads long, thin and
    // sparse — low bbox fill, extreme aspect.
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const bboxFill = px.length / (bw * bh);
    const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    if (bboxFill < 0.55 || aspect > 5) continue;
    if (addedTotalPx + px.length > mainArea * 0.5) continue;
    addedTotalPx += px.length;
    addedAreasM2.push(Math.round(areaM2));
    for (const idx of px) out[idx] = 1;
  }

  return { mask: out, addedAreasM2, addedPx: addedTotalPx };
}

/* ------------------------------------------------------------------ */
/*  DSM footprint growth — the "zoomed-in eave" tracer                 */
/* ------------------------------------------------------------------ */

/**
 * Grow the building mask along the HEIGHT data to the true drip edge.
 *
 * Google's mask is an ML footprint product: stepped corners get smoothed
 * into long diagonals and the boundary sits near the walls. The DSM is
 * sharper truth — the roof surface ends in a ~3 m cliff at the eave, and
 * that cliff carries every jog and square corner the mask blurred away.
 * Starting from the mask (so we can't wander onto a neighbor), BFS-grow
 * into adjacent pixels that read as ROOF (elevated, planar, not
 * vegetation, tonally uniform), up to `maxGrowM` from the original mask.
 *
 * The grown boundary IS the drip edge, so the caller should use a much
 * smaller overhang offset when growth applies.
 */
export function growRoofMask(args: {
  mask: Uint8Array;
  dsm: Float32Array;
  dsmNoData: number;
  rgb: Uint8Array;
  width: number;
  height: number;
  metersPerPixel: number;
  groundHeightM: number;
  maxGrowM?: number;
}): { mask: Uint8Array; grownPx: number } {
  const { mask, dsm, dsmNoData, rgb, width, height, metersPerPixel, groundHeightM } = args;
  const maxSteps = Math.max(1, Math.round((args.maxGrowM ?? 3) / metersPerPixel));

  const validH = (v: number) =>
    Number.isFinite(v) && Math.abs(v - dsmNoData) > 0.001 && v > -450 && v < 9000;

  const roofLike = (x: number, y: number): boolean => {
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return false;
    const i = y * width + x;
    const h = dsm[i];
    if (!validH(h)) return false;
    const above = h - groundHeightM;
    if (above < 2.0 || above > 13) return false;
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    if (g > r + 6 && g > b + 6) return false; // vegetation
    let lo = h;
    let hi = h;
    let lLo = 255;
    let lHi = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const j = (y + dy) * width + (x + dx);
        const v = dsm[j];
        if (!validH(v)) return false;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        const lum = (rgb[j * 3] + rgb[j * 3 + 1] + rgb[j * 3 + 2]) / 3;
        if (lum < lLo) lLo = lum;
        if (lum > lHi) lHi = lum;
      }
    }
    if (hi - lo > 0.55) return false; // tree crowns / cliffs
    if (lHi - lLo > 52) return false; // canopy speckle
    return true;
  };

  const out = mask.slice();
  // Multi-source BFS from the mask boundary with a step budget.
  let frontier: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask[i] === 0) continue;
      if (
        mask[i - 1] === 0 ||
        mask[i + 1] === 0 ||
        mask[i - width] === 0 ||
        mask[i + width] === 0
      ) {
        frontier.push(i);
      }
    }
  }
  let grownPx = 0;
  let maskArea = 0;
  for (let i = 0; i < mask.length; i++) maskArea += mask[i];
  const growCap = Math.round(maskArea * 0.45);

  for (let step = 0; step < maxSteps && frontier.length > 0; step++) {
    const next: number[] = [];
    for (const idx of frontier) {
      const x = idx % width;
      const y = (idx - x) / width;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        const ni = ny * width + nx;
        if (nx < 1 || ny < 1 || nx >= width - 1 || ny >= height - 1) continue;
        if (out[ni] > 0) continue;
        if (!roofLike(nx, ny)) continue;
        out[ni] = 1;
        grownPx++;
        if (grownPx > growCap) return { mask, grownPx: 0 }; // runaway — distrust
        next.push(ni);
      }
    }
    frontier = next;
  }
  return { mask: out, grownPx };
}

/* ------------------------------------------------------------------ */
/*  Interior tier edges — real "roof above a roof" eave lines           */
/* ------------------------------------------------------------------ */

/**
 * Find the eave lines of UPPER roof tiers from the DSM: pixels inside
 * the footprint where the surface steps DOWN ≥ `minStepM` onto more roof
 * (both sides in-mask, so the outer perimeter doesn't count). Elongated
 * runs of such pixels are fitted to straight segments via PCA — the
 * result lands exactly on the upper roof's drip line, unlike the old
 * Solar-segment bbox chords.
 */
export function findTierEdges(args: {
  mask: Uint8Array;
  dsm: Float32Array;
  dsmNoData: number;
  width: number;
  height: number;
  metersPerPixel: number;
  minStepM?: number;
}): { a: Pt; b: Pt }[] {
  const { mask, dsm, dsmNoData, width, height, metersPerPixel } = args;
  const minStep = args.minStepM ?? 1.0;
  const validH = (v: number) =>
    Number.isFinite(v) && Math.abs(v - dsmNoData) > 0.001 && v > -450 && v < 9000;

  // Step pixels: on the HIGH side of an interior height cliff.
  const step = new Uint8Array(width * height);
  const reachPx = Math.max(2, Math.round(0.4 / metersPerPixel));
  for (let y = reachPx; y < height - reachPx; y++) {
    for (let x = reachPx; x < width - reachPx; x++) {
      const i = y * width + x;
      if (mask[i] === 0) continue;
      const h = dsm[i];
      if (!validH(h)) continue;
      for (const [dx, dy] of [
        [reachPx, 0],
        [-reachPx, 0],
        [0, reachPx],
        [0, -reachPx],
      ] as const) {
        const j = (y + dy) * width + (x + dx);
        if (mask[j] === 0) continue; // perimeter, not interior
        const v = dsm[j];
        if (!validH(v)) continue;
        if (h - v >= minStep) {
          step[i] = 1;
          break;
        }
      }
    }
  }

  // Connected components → PCA line fit for elongated ones.
  const visited = new Uint8Array(width * height);
  const out: { a: Pt; b: Pt }[] = [];
  const minLenPx = 1.8 / metersPerPixel;
  for (let start = 0; start < step.length && out.length < 8; start++) {
    if (step[start] === 0 || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let head = 0;
    const px: Pt[] = [];
    while (head < queue.length) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      px.push({ x, y });
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (step[ni] === 0 || visited[ni]) continue;
          visited[ni] = 1;
          queue.push(ni);
        }
      }
    }
    if (px.length < minLenPx) continue;
    // PCA: dominant direction + spread.
    let mx = 0;
    let my = 0;
    for (const p of px) {
      mx += p.x;
      my += p.y;
    }
    mx /= px.length;
    my /= px.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const p of px) {
      const ux = p.x - mx;
      const uy = p.y - my;
      sxx += ux * ux;
      sxy += ux * uy;
      syy += uy * uy;
    }
    const tr = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l2 = tr - l1;
    if (l2 > 0 && l1 / Math.max(1e-6, l2) < 6) continue; // blobby, not a line
    const ang = Math.atan2(l1 - sxx, sxy) === 0 && sxy === 0
      ? (sxx >= syy ? 0 : Math.PI / 2)
      : Math.atan2(l1 - sxx, sxy);
    const dx = Math.cos(ang);
    const dyv = Math.sin(ang);
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const p of px) {
      const t = (p.x - mx) * dx + (p.y - my) * dyv;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    if (tMax - tMin < minLenPx) continue;
    out.push({
      a: { x: mx + dx * tMin, y: my + dyv * tMin },
      b: { x: mx + dx * tMax, y: my + dyv * tMax },
    });
  }
  return out;
}

/**
 * Decompose the roof into HEIGHT TIERS and return each substantial
 * tier's cleaned boundary ring. A ≥`minStepM` cliff inside the footprint
 * separates tiers (an upper roof mass over a lower one); each region's
 * ring goes through the same DP → ortho/de-chamfer cleanup as the outer
 * perimeter, so tier outlines come back with square corners.
 *
 * The caller decides which ring edges become PRICED interior eaves:
 * edges far from the outer perimeter whose inside sits ≥~0.8 m above
 * the outside are the upper roof's drip lines.
 */
export function tierRegionRings(args: {
  mask: Uint8Array;
  dsm: Float32Array;
  dsmNoData: number;
  width: number;
  height: number;
  metersPerPixel: number;
  minStepM?: number;
  minAreaM2?: number;
}): { ring: Pt[]; areaM2: number }[] {
  const { mask, dsm, dsmNoData, width, height, metersPerPixel } = args;
  const minStep = args.minStepM ?? 1.0;
  const minAreaPx =
    (args.minAreaM2 ?? 10) / (metersPerPixel * metersPerPixel);
  const validH = (v: number) =>
    Number.isFinite(v) && Math.abs(v - dsmNoData) > 0.001 && v > -450 && v < 9000;

  // Barrier band on the HIGH side of every interior cliff (same detection
  // as findTierEdges) — excluding it splits the footprint into tiers.
  const barrier = new Uint8Array(width * height);
  const reachPx = Math.max(2, Math.round(0.4 / metersPerPixel));
  for (let y = reachPx; y < height - reachPx; y++) {
    for (let x = reachPx; x < width - reachPx; x++) {
      const i = y * width + x;
      if (mask[i] === 0) continue;
      const h = dsm[i];
      if (!validH(h)) continue;
      for (const [dx, dy] of [
        [reachPx, 0],
        [-reachPx, 0],
        [0, reachPx],
        [0, -reachPx],
      ] as const) {
        const j = (y + dy) * width + (x + dx);
        if (mask[j] === 0) continue;
        const v = dsm[j];
        if (!validH(v)) continue;
        if (h - v >= minStep) {
          barrier[i] = 1;
          break;
        }
      }
    }
  }

  // Connected components of footprint minus barrier.
  const visited = new Uint8Array(width * height);
  const out: { ring: Pt[]; areaM2: number }[] = [];
  for (let start = 0; start < mask.length && out.length < 6; start++) {
    if (mask[start] === 0 || barrier[start] === 1 || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let head = 0;
    const regionMask = new Uint8Array(width * height);
    let count = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      regionMask[idx] = 1;
      count++;
      const x = idx % width;
      const y = (idx - x) / width;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (mask[ni] === 0 || barrier[ni] === 1 || visited[ni]) continue;
        visited[ni] = 1;
        queue.push(ni);
      }
    }
    if (count < minAreaPx) continue;
    const traced = traceMaskFootprint(regionMask, width, height);
    if (!traced) continue;
    const cleaned = cleanFootprint(traced.boundary, metersPerPixel);
    if (!cleaned || cleaned.points.length < 4) continue;
    out.push({
      ring: cleaned.points,
      areaM2: count * metersPerPixel * metersPerPixel,
    });
  }
  return out;
}

/** Distance from a point to the nearest edge of a closed ring (px). */
export function distToRing(p: Pt, ring: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 > 0
        ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
        : 0;
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/*  Per-edge photo snapping                                            */
/* ------------------------------------------------------------------ */

/**
 * Slide each wall line independently onto the photo's roof edge, then
 * rebuild every corner as the INTERSECTION of its two refined walls.
 * Fixes what a single global shift can't (per-edge residual error from
 * the mask) and re-squares corners by construction — the intersection
 * of two perpendicular refined lines is a true 90° corner.
 *
 * Same roof-aware scoring as the global registration: a candidate
 * offset only scores where the pixel just inside still looks like this
 * roof. Guards: per-edge slide ≤ maxSlideM, corners move ≤ 2.5 m,
 * polygon stays simple, area within ±12% — else the input is returned.
 */
export function refineEdgesToPhoto(args: {
  ring: Pt[];
  rgb: Uint8Array;
  mask?: Uint8Array;
  width: number;
  height: number;
  metersPerPixel: number;
  maxSlideM?: number;
}): { ring: Pt[]; refined: number } {
  const { ring, rgb, mask, width, height, metersPerPixel } = args;
  if (ring.length < 4) return { ring, refined: 0 };
  const maxSlidePx = Math.max(2, Math.round((args.maxSlideM ?? 0.9) / metersPerPixel));

  // Shared luminance / gradient / roof-tone prep (small vs the search).
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    lum[i] = (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3;
  }
  const grad = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      grad[i] =
        Math.abs(lum[i + 1] - lum[i - 1]) +
        Math.abs(lum[i + width] - lum[i - width]);
    }
  }
  let roofLum: number | null = null;
  if (mask) {
    const vals: number[] = [];
    const stepPx = Math.max(1, Math.floor(Math.sqrt((width * height) / 4000)));
    const e = Math.max(2, Math.round(0.5 / metersPerPixel));
    for (let y = e; y < height - e; y += stepPx) {
      for (let x = e; x < width - e; x += stepPx) {
        const i = y * width + x;
        if (
          mask[i] > 0 &&
          mask[i - e] > 0 &&
          mask[i + e] > 0 &&
          mask[i - e * width] > 0 &&
          mask[i + e * width] > 0
        ) {
          vals.push(lum[i]);
        }
      }
    }
    if (vals.length >= 40) roofLum = median(vals);
  }

  const centroid = polygonCentroid(ring);
  const n = ring.length;
  const insidePx = 0.7 / metersPerPixel;

  // Refine each edge's perpendicular offset.
  type Line = { p: Pt; d: Pt };
  const lines: Line[] = [];
  let refined = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const d = { x: (b.x - a.x) / (len || 1), y: (b.y - a.y) / (len || 1) };
    if (len * metersPerPixel < 1.6) {
      lines.push({ p: a, d });
      continue;
    }
    const nrm = interiorNormal(a, b, centroid); // inward
    const stations = Math.max(3, Math.min(14, Math.round((len * metersPerPixel) / 1.2)));
    const scoreAt = (o: number): number => {
      let s = 0;
      for (let k = 0; k < stations; k++) {
        const t = 0.12 + (0.76 * k) / Math.max(1, stations - 1);
        const px = a.x + (b.x - a.x) * t - nrm.nx * o;
        const py = a.y + (b.y - a.y) * t - nrm.ny * o;
        const x = Math.round(px);
        const y = Math.round(py);
        if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
        let g = grad[y * width + x];
        if (roofLum != null && g > 0) {
          const ix = Math.round(px + nrm.nx * insidePx);
          const iy = Math.round(py + nrm.ny * insidePx);
          if (ix >= 0 && iy >= 0 && ix < width && iy < height) {
            const dL = Math.abs(lum[iy * width + ix] - roofLum);
            g *= dL <= 34 ? 1 : 0.2;
          }
        }
        s += g;
      }
      return s / (1 + 0.03 * Math.abs(o));
    };
    const zero = scoreAt(0);
    let bestO = 0;
    let best = zero;
    for (let o = -maxSlidePx; o <= maxSlidePx; o++) {
      if (o === 0) continue;
      const s = scoreAt(o);
      if (s > best) {
        best = s;
        bestO = o;
      }
    }
    if (bestO !== 0 && best >= zero * 1.12) {
      lines.push({
        p: { x: a.x - nrm.nx * bestO, y: a.y - nrm.ny * bestO },
        d,
      });
      refined++;
    } else {
      lines.push({ p: a, d });
    }
  }
  if (refined === 0) return { ring, refined: 0 };

  // Rebuild corners as neighbor-line intersections.
  const maxCornerMovePx = 2.5 / metersPerPixel;
  const next: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i - 1 + n) % n];
    const curr = lines[i];
    const inter = lineIntersection(
      prev.p,
      { x: prev.p.x + prev.d.x, y: prev.p.y + prev.d.y },
      curr.p,
      { x: curr.p.x + curr.d.x, y: curr.p.y + curr.d.y },
    );
    if (inter && Math.hypot(inter.x - ring[i].x, inter.y - ring[i].y) <= maxCornerMovePx) {
      next.push(inter);
    } else {
      // Near-parallel neighbors (collinear walls) — project the old
      // corner onto the current refined line instead.
      const t =
        (ring[i].x - curr.p.x) * curr.d.x + (ring[i].y - curr.p.y) * curr.d.y;
      next.push({ x: curr.p.x + curr.d.x * t, y: curr.p.y + curr.d.y * t });
    }
  }
  const areaRatio = polygonArea(next) / Math.max(1, polygonArea(ring));
  if (areaRatio < 0.88 || areaRatio > 1.12) return { ring, refined: 0 };
  if (polygonSelfIntersects(next)) return { ring, refined: 0 };
  return { ring: next, refined };
}

/* ------------------------------------------------------------------ */
/*  Photo-lean registration                                            */
/* ------------------------------------------------------------------ */

/**
 * Google's mask/DSM are TRUE-POSITION (orthorectified to the ground),
 * but the RGB orthophoto is rectified with a ground-level terrain model
 * — so a 4–6 m-tall ROOF renders displaced from its true position by
 * height × tan(off-nadir), commonly ~1 m. A geometrically-correct trace
 * therefore floats just off the photo's roof, which reads as "wrong" to
 * a contractor even though the lengths are right.
 *
 * Estimate that apparent shift by sliding the footprint ring over the
 * photo's edge-energy map (|∇luminance|) and keeping the offset that
 * maximizes edge agreement. Small-shift prior + a do-nothing floor keep
 * it from chasing noise. The caller applies the shift to DRAWN geometry
 * only — measurement math stays in true meters.
 */
export function estimateRenderShift(args: {
  rgb: Uint8Array;
  width: number;
  height: number;
  ring: Pt[];
  metersPerPixel: number;
  /** True-position building mask (same crop) — anchors the roof's
   *  appearance so the search can't lock onto a sidewalk/driveway edge
   *  (bright pavement borders out-gradient real rooflines). */
  mask?: Uint8Array;
  maxShiftM?: number;
}): { dx: number; dy: number } {
  const { rgb, width, height, ring, metersPerPixel, mask } = args;
  if (ring.length < 3) return { dx: 0, dy: 0 };
  const S = Math.max(2, Math.round((args.maxShiftM ?? 1.5) / metersPerPixel));

  // Edge-energy map: |∇| of luminance, central differences.
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    lum[i] = (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3;
  }
  const grad = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      grad[i] =
        Math.abs(lum[i + 1] - lum[i - 1]) +
        Math.abs(lum[i + width] - lum[i - width]);
    }
  }

  // What does THIS roof look like? Median luminance over the mask
  // interior (2-neighborhood erosion so boundary mixels don't dilute).
  let roofLum: number | null = null;
  if (mask) {
    const vals: number[] = [];
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4000)));
    const e = Math.max(2, Math.round(0.5 / metersPerPixel));
    for (let y = e; y < height - e; y += step) {
      for (let x = e; x < width - e; x += step) {
        const i = y * width + x;
        if (
          mask[i] > 0 &&
          mask[i - e] > 0 &&
          mask[i + e] > 0 &&
          mask[i - e * width] > 0 &&
          mask[i + e * width] > 0
        ) {
          vals.push(lum[i]);
        }
      }
    }
    if (vals.length >= 40) roofLum = median(vals);
  }

  // Densify the ring into sample stations (~ every 3 px), each carrying
  // its inward normal so we can ask "is there ROOF just inside here?".
  const centroid = polygonCentroid(ring);
  const samples: { x: number; y: number; nx: number; ny: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nrm = interiorNormal(a, b, centroid);
    const n = Math.max(1, Math.floor(len / 3));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      samples.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        nx: nrm.nx,
        ny: nrm.ny,
      });
    }
  }
  if (samples.length < 24) return { dx: 0, dy: 0 };

  const insidePx = 0.7 / metersPerPixel;
  const scoreAt = (dx: number, dy: number): number => {
    let s = 0;
    for (const p of samples) {
      const x = Math.round(p.x + dx);
      const y = Math.round(p.y + dy);
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
      let g = grad[y * width + x];
      if (roofLum != null && g > 0) {
        // Down-weight stations whose INSIDE pixel doesn't look like this
        // roof — a sidewalk border has a strong edge but pavement, not
        // shingle, inside it.
        const ix = Math.round(p.x + dx + p.nx * insidePx);
        const iy = Math.round(p.y + dy + p.ny * insidePx);
        if (ix >= 0 && iy >= 0 && ix < width && iy < height) {
          const dLum = Math.abs(lum[iy * width + ix] - roofLum);
          g *= dLum <= 34 ? 1 : 0.2;
        }
      }
      s += g;
    }
    // Small-shift prior: prefer staying near true position when edge
    // evidence is comparable.
    return s / (1 + 0.02 * Math.hypot(dx, dy));
  };

  const zero = scoreAt(0, 0);
  let bestDx = 0;
  let bestDy = 0;
  let best = zero;
  for (let dy = -S; dy <= S; dy++) {
    for (let dx = -S; dx <= S; dx++) {
      if (dx === 0 && dy === 0) continue;
      const s = scoreAt(dx, dy);
      if (s > best) {
        best = s;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  // Do-nothing floor: only move when the aligned position is clearly
  // better than true position.
  if (best < zero * 1.1) return { dx: 0, dy: 0 };
  return { dx: bestDx, dy: bestDy };
}

/**
 * Liang-Barsky segment clip to the rect [0,W]×[0,H]. Solar-segment
 * derived decorations (tier-break suggestions, ridges) come from plane
 * bboxes that can poke past the cropped image — clip them so nothing
 * lands outside the client canvas. Returns null when fully outside.
 */
export function clipSegmentToRect(
  a: Pt,
  b: Pt,
  width: number,
  height: number,
): { a: Pt; b: Pt } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a.x], // x >= 0
    [dx, width - a.x], // x <= width
    [-dy, a.y], // y >= 0
    [dy, height - a.y], // y <= height
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return {
    a: { x: a.x + t0 * dx, y: a.y + t0 * dy },
    b: { x: a.x + t1 * dx, y: a.y + t1 * dy },
  };
}

/* ------------------------------------------------------------------ */
/*  Crop-window aspect normalization                                   */
/* ------------------------------------------------------------------ */

/**
 * Expand a crop window to a target aspect ratio (w/h), centered, clamped
 * to the raster. The engine's aerial crop becomes the client's 900×580
 * COVER-fit canvas background — when the crop aspect matches the canvas,
 * cover-fit ≡ contain-fit, so no traced geometry can land outside the
 * canvas (which clipped the proposal diagram) and the photo fills the
 * frame with no letterbox bands.
 */
export function expandWindowToAspect(
  win: CropWindow,
  aspect: number,
  width: number,
  height: number,
): CropWindow {
  let w = win.width;
  let h = win.height;
  if (w / h < aspect) {
    w = Math.min(width, Math.ceil(h * aspect));
    // Raster too narrow for the aspect at this height → shrink height
    // toward the aspect instead of silently keeping a tall window.
    if (w / h < aspect) h = Math.max(win.height, Math.ceil(w / aspect));
    h = Math.min(h, height);
  } else {
    h = Math.min(height, Math.ceil(w / aspect));
    if (w / h > aspect) w = Math.max(win.width, Math.ceil(h * aspect));
    w = Math.min(w, width);
  }
  let x = Math.round(win.x + win.width / 2 - w / 2);
  let y = Math.round(win.y + win.height / 2 - h / 2);
  x = Math.max(0, Math.min(width - w, x));
  y = Math.max(0, Math.min(height - h, y));
  return { x, y, width: w, height: h };
}

function findSeedNearCenter(
  width: number,
  height: number,
  isFg: (x: number, y: number) => boolean,
): Pt | null {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  if (isFg(cx, cy)) return { x: cx, y: cy };
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

function traceMooreNeighbor(
  width: number,
  height: number,
  isFg: (x: number, y: number) => boolean,
  start: Pt,
): Pt[] {
  if (!isFg(start.x, start.y)) return [];
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
  const boundary: Pt[] = [{ x: start.x, y: start.y }];
  let cx = start.x;
  let cy = start.y;
  let backtrackDir = 6; // entered from the west
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
    if (boundary.length > 8 && cx === start.x && cy === start.y) break;
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

/* ------------------------------------------------------------------ */
/*  Boundary cleanup: downsample → Douglas-Peucker → ortho snap        */
/* ------------------------------------------------------------------ */

export type CleanedFootprint = {
  points: Pt[];
  /** Chamfered corners squared away by dechamferPolygon. */
  squaredCorners: number;
  cleanup:
    | { kind: "ortho"; vertCount: number }
    | { kind: "simplified"; vertCount: number; reason: string };
};

/**
 * Collapse a raw boundary trace (one point per mask pixel) into an
 * architectural outline. Tolerances are given in METERS and converted
 * with the grid's uniform scale — the same numbers work at 0.1 and
 * 0.25 m/px.
 */
export function cleanFootprint(
  boundary: Pt[],
  metersPerPixel: number,
  opts?: {
    simplifyEpsM?: number;
    orthoMaxDriftM?: number;
  },
): CleanedFootprint | null {
  const epsPx = (opts?.simplifyEpsM ?? 0.45) / metersPerPixel;
  const maxDriftPx = (opts?.orthoMaxDriftM ?? 2) / metersPerPixel;

  const downsampled =
    boundary.length > 800
      ? boundary.filter((_, i) => i % Math.ceil(boundary.length / 800) === 0)
      : boundary;
  if (downsampled.length < 8) return null;

  const simplified = simplify(downsampled, epsPx);
  if (simplified.length < 4) return null;

  const ortho = orthogonalizePolygon(simplified);
  const orthoArea = polygonArea(ortho) / Math.max(1, polygonArea(simplified));
  const orthoOk =
    ortho.length >= 4 &&
    !polygonSelfIntersects(ortho) &&
    orthoArea >= 0.85 &&
    orthoArea <= 1.15 &&
    symmetricHausdorffPx(simplified, ortho) <= maxDriftPx;

  if (orthoOk) {
    // Global right-angle snap succeeded — corners are already square.
    return {
      points: ortho,
      squaredCorners: 0,
      cleanup: { kind: "ortho", vertCount: ortho.length },
    };
  }
  if (!polygonSelfIntersects(simplified)) {
    // Global snap failed (mixed-angle building) — square away the LOCAL
    // chamfers the mask's rounded corners left behind, keeping genuine
    // diagonal walls.
    const dech = dechamferPolygon(simplified, metersPerPixel);
    return {
      points: dech.points,
      squaredCorners: dech.squared,
      cleanup: {
        kind: "simplified",
        vertCount: dech.points.length,
        reason:
          ortho.length < 4
            ? "ortho degenerate"
            : polygonSelfIntersects(ortho)
              ? "ortho self-intersected"
              : orthoArea < 0.85 || orthoArea > 1.15
                ? `ortho area ${(orthoArea * 100).toFixed(0)}%`
                : "ortho drifted",
      },
    };
  }
  return null;
}

export function polygonArea(points: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Square away CHAMFERED corners. The mask's corners are rounded (pixel
 * grid + Google's own smoothing); after Douglas-Peucker that rounding
 * survives as a short diagonal "cut" across what is really a 90° corner
 * — contractors immediately flag it ("this corner is 45° but should be
 * square"). Replace each short edge whose NEIGHBORS meet at roughly a
 * right angle with the neighbors' true intersection point.
 *
 * Deliberately conservative so real architecture survives:
 *   • only edges shorter than `maxChamferPx` are candidates — a genuine
 *     45° wall (angled garage wing, long bay facet) is longer and stays;
 *   • the neighbors must meet at 55–125° (extending them produces a
 *     believable corner, not a spike);
 *   • the new corner must land within `maxExtendPx` of the chamfer;
 *   • the polygon must stay simple (no self-intersection).
 * Runs to fixpoint (max 4 passes). Returns the squared count for notes.
 */
export function dechamferPolygon(
  points: Pt[],
  metersPerPixel: number,
  opts?: { maxChamferM?: number; maxExtendM?: number },
): { points: Pt[]; squared: number } {
  const maxChamferPx = (opts?.maxChamferM ?? 2.2) / metersPerPixel;
  const maxExtendPx = (opts?.maxExtendM ?? 2.6) / metersPerPixel;
  let pts = points;
  let squared = 0;
  let stale = 0;
  for (let pass = 0; pass < 6 && stale < 2; pass++) {
    // Rotate so a chamfer sitting across the array seam lands mid-array
    // on some pass (the splice below never wraps). Two consecutive
    // no-change passes — i.e. two different rotations — mean fixpoint.
    if (pass > 0 && pts.length > 4) {
      const third = Math.max(1, Math.floor(pts.length / 3));
      pts = [...pts.slice(third), ...pts.slice(0, third)];
    }
    let changed = false;
    for (let i = 1; i < pts.length - 1 && pts.length > 4; i++) {
      const n = pts.length;
      const p0 = pts[i - 1];
      const a = pts[i];
      const b = pts[i + 1];
      const p3 = pts[(i + 2) % n];
      const chamferLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (chamferLen > maxChamferPx || chamferLen < 1e-6) continue;

      // Direction of the neighbor edges.
      const d1x = a.x - p0.x;
      const d1y = a.y - p0.y;
      const d2x = p3.x - b.x;
      const d2y = p3.y - b.y;
      const l1 = Math.hypot(d1x, d1y);
      const l2 = Math.hypot(d2x, d2y);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      // Neighbors must themselves be substantial walls, or we'd square
      // pixel noise into pixel noise.
      if (l1 < chamferLen || l2 < chamferLen) continue;
      const cosAng = (d1x * d2x + d1y * d2y) / (l1 * l2);
      const angDeg = (Math.acos(Math.max(-1, Math.min(1, cosAng))) * 180) / Math.PI;
      if (angDeg < 55 || angDeg > 125) continue;

      const inter = lineIntersection(p0, a, b, p3);
      if (!inter) continue;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (Math.hypot(inter.x - mid.x, inter.y - mid.y) > maxExtendPx) continue;

      const next = [...pts.slice(0, i), inter, ...pts.slice(i + 2)];
      // Splice across the ring seam leaves <4 pts or broken order — guard.
      if (next.length < 4) continue;
      if (polygonSelfIntersects(next)) continue;
      pts = next;
      squared++;
      changed = true;
      i--; // re-examine around the new corner
    }
    stale = changed ? 0 : stale + 1;
  }
  return { points: pts, squared };
}

/* ------------------------------------------------------------------ */
/*  Planar outward offset (roof overhang)                              */
/* ------------------------------------------------------------------ */

/**
 * Offset a simple polygon outward by `offsetPx` — the roof/gutter line
 * sits past the wall the mask traces. Classic edge-translate + line
 * re-intersection with a miter cap; on the uniform UTM grid this is an
 * exact planar operation (the old path detoured through turf lat/lng
 * buffering).
 *
 * Falls back to the input when the offset degenerates (self-intersection
 * or area moving the wrong way) — an unbuffered footprint is a slightly
 * conservative gutter line, never garbage.
 */
export function offsetPolygonOutward(points: Pt[], offsetPx: number): Pt[] {
  if (points.length < 3 || offsetPx <= 0) return points;
  const ccw = ensureCCW(points);
  const n = ccw.length;

  // For a CCW polygon in y-down coords the interior is to the LEFT of
  // travel, so the outward normal of edge (a→b) is the RIGHT normal:
  // (-dy, dx) normalized... verify orientation via area growth below and
  // flip once if needed (cheaper than re-deriving conventions).
  const build = (sign: 1 | -1): Pt[] | null => {
    const out: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const prev = ccw[(i - 1 + n) % n];
      const curr = ccw[i];
      const next = ccw[(i + 1) % n];

      const off = (a: Pt, b: Pt) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return null;
        const nx = (sign * -dy) / len;
        const ny = (sign * dx) / len;
        return {
          a: { x: a.x + nx * offsetPx, y: a.y + ny * offsetPx },
          b: { x: b.x + nx * offsetPx, y: b.y + ny * offsetPx },
        };
      };
      const e1 = off(prev, curr);
      const e2 = off(curr, next);
      if (!e1 || !e2) continue;
      const inter = lineIntersection(e1.a, e1.b, e2.a, e2.b);
      // Miter cap at 2× the offset: covers a right angle (√2×) with
      // margin, but bevels acute corners — where wings meet at odd
      // angles a longer miter shoots a spike past the real roof corner
      // (the "eave endpoint hanging over the driveway" artifact).
      if (
        inter &&
        Math.hypot(inter.x - curr.x, inter.y - curr.y) <= offsetPx * 2
      ) {
        out.push(inter);
      } else {
        out.push({
          x: (e1.b.x + e2.a.x) / 2,
          y: (e1.b.y + e2.a.y) / 2,
        });
      }
    }
    return out.length >= 3 ? out : null;
  };

  const first = build(1);
  const grew = first && polygonArea(first) > polygonArea(ccw);
  const candidate = grew ? first : build(-1);
  if (!candidate) return points;
  if (polygonArea(candidate) <= polygonArea(ccw)) return points;
  if (polygonSelfIntersects(candidate)) return points;
  return candidate;
}

function lineIntersection(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

/* ------------------------------------------------------------------ */
/*  DSM edge classification (eave vs rake)                             */
/* ------------------------------------------------------------------ */

export type DsmSampler = (x: number, y: number) => number | null;

export type EdgeVerdict = {
  kind: "eave" | "rake" | "unknown";
  reason: string;
};

/**
 * Classify one perimeter edge from the height field.
 *
 * Physical truth this encodes: a gutter hangs on an edge that water
 * drains TO — at each point along it, the roof surface RISES going
 * inward (upslope). A rake (gable edge) climbs from eave corner to ridge
 * corner along its run, and moving inward from it travels PARALLEL to
 * the ridge, so the surface does not rise.
 *
 * The verdict is a per-station VOTE, not a single whole-edge judgment:
 * a straight wall that fronts two roof tiers at different heights (very
 * common on custom homes) steps in height along the edge — judging the
 * edge by its total climb would misread that stepped eave as a rake and
 * silently drop real gutter. Stations vote independently on "does the
 * interior rise here"; the along-edge climb only calls RAKE when it is
 * MONOTONIC (a real slope, not tier steps).
 *
 * Sampling is inset toward the interior so we read shingles, not the
 * wall/ground discontinuity; each station takes the median of three
 * inset depths to shrug off DSM noise, vents and gutter shadows.
 * Interior samples that leave the building mask are discarded (narrow
 * wings would otherwise vote with the neighbor's lawn).
 *
 * All thresholds in meters; conversion uses the grid's uniform scale.
 */
export function classifyEdgeByDsm(
  a: Pt,
  b: Pt,
  interiorSign: { nx: number; ny: number },
  sample: DsmSampler,
  metersPerPixel: number,
  opts?: {
    alongSlopeMaxM?: number;
    interiorRiseMinM?: number;
    /** Restrict interior samples to the building mask when provided. */
    insideMask?: (x: number, y: number) => boolean;
  },
): EdgeVerdict {
  const alongSlopeMaxM = opts?.alongSlopeMaxM ?? 0.9;
  const interiorRiseMinM = opts?.interiorRiseMinM ?? 0.35;
  const insideMask = opts?.insideMask;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenPx = Math.hypot(dx, dy);
  const lenM = lenPx * metersPerPixel;
  if (lenM < 0.5) return { kind: "unknown", reason: "edge <0.5m" };

  const insetDepthsM = [0.5, 0.8, 1.1];
  // Stations along the edge, keeping clear of the corners (corner pixels
  // straddle two roof planes / the rake return).
  const stationCount = Math.max(3, Math.min(11, Math.round(lenM / 1.2)));
  const stations: number[] = [];
  for (let i = 0; i < stationCount; i++) {
    stations.push(0.15 + (0.7 * i) / Math.max(1, stationCount - 1));
  }

  const heightAt = (t: number): number | null => {
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const vals: number[] = [];
    for (const dM of insetDepthsM) {
      const dPx = dM / metersPerPixel;
      const v = sample(px + interiorSign.nx * dPx, py + interiorSign.ny * dPx);
      if (v != null && Number.isFinite(v)) vals.push(v);
    }
    if (vals.length === 0) return null;
    vals.sort((x, y) => x - y);
    return vals[Math.floor(vals.length / 2)];
  };

  // Per-station: near-edge height + interior rise vote.
  type Station = { t: number; h: number; rise: number | null };
  const profile: Station[] = [];
  for (const t of stations) {
    const h = heightAt(t);
    if (h == null) continue;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const interiorVals: number[] = [];
    for (const dM of [2.0, 2.8]) {
      const dPx = dM / metersPerPixel;
      const ix = px + interiorSign.nx * dPx;
      const iy = py + interiorSign.ny * dPx;
      if (insideMask && !insideMask(ix, iy)) continue;
      const v = sample(ix, iy);
      if (v != null && Number.isFinite(v)) interiorVals.push(v);
    }
    profile.push({
      t,
      h,
      rise: interiorVals.length > 0 ? median(interiorVals) - h : null,
    });
  }
  if (profile.length < 3) {
    return { kind: "unknown", reason: "DSM no-data along edge" };
  }

  const votes = profile.filter((s) => s.rise != null);
  const eaveVotes = votes.filter((s) => (s.rise as number) > 0.3).length;
  const eaveVoteFrac = votes.length > 0 ? eaveVotes / votes.length : 0;

  // Along-edge climb: robust spread between the low and high thirds…
  const hs = profile.map((p) => p.h).sort((x, y) => x - y);
  const third = Math.max(1, Math.floor(hs.length / 3));
  const alongDelta =
    median(hs.slice(hs.length - third)) - median(hs.slice(0, third));
  // …and whether that climb is MONOTONIC (real slope) or stepped (tiers).
  let up = 0;
  let down = 0;
  for (let i = 1; i < profile.length; i++) {
    const d = profile[i].h - profile[i - 1].h;
    if (d > 0.08) up++;
    else if (d < -0.08) down++;
  }
  const dominant = Math.max(up, down);
  const monoFrac =
    up + down > 0 ? dominant / (up + down) : 1;

  // 0. NEAR-TOTAL continuous climb → rake, checked BEFORE the drainage
  //    votes. On a gable-end drip line (post drip-edge growth the traced
  //    edge is the rake overhang itself) the surface just inside RISES
  //    toward the ridge, so the votes read "eave" — but EVERY station
  //    also climbs ALONG the edge, which no gutter line does. The gate
  //    is deliberately strict (≥85% of stations rising, none falling):
  //    a stepped two-tier wall, a hip TRANSITION between tiers, or a
  //    DSM-smeared step climbs only through its middle section and has
  //    flat plateaus, so it falls through to the votes and stays an
  //    eave (adversarial review: the looser 60% version silently
  //    flipped ~30 LF perimeter eaves to rake with no resurface path).
  const steps = Math.max(1, profile.length - 1);
  // ≥75% rising with at most ONE falling station: strict enough that a
  // tier transition with flat plateaus (rising ~60-70%) stays an eave,
  // loose enough that one noisy DSM station can't hide a true gable.
  if (alongDelta > 1.2 && up >= 4 && down <= 1 && up / steps >= 0.75) {
    return {
      kind: "rake",
      reason: `climbs ${alongDelta.toFixed(2)}m continuously (${up}/${steps} stations rising)`,
    };
  }

  // 1. Most of the edge drains here → gutter, even when the wall steps
  //    across tiers or the total climb is large.
  if (votes.length >= 2 && eaveVoteFrac >= 0.6) {
    return {
      kind: "eave",
      reason: `interior rises at ${eaveVotes}/${votes.length} stations`,
    };
  }

  // 2. Real climb along the edge → rake.
  if (alongDelta > alongSlopeMaxM && monoFrac >= 0.7) {
    return {
      kind: "rake",
      reason: `climbs ${alongDelta.toFixed(2)}m monotonically along the edge`,
    };
  }

  // 3. Non-monotonic height change along the edge. Two very different
  //    roofs produce it, and the drainage votes tell them apart:
  //      • stepped tiers on one wall, both draining here → EAVE
  //      • a full-width gable end (tent profile: climbs to the ridge
  //        point then falls, nothing drains toward the wall) → RAKE
  if (alongDelta > alongSlopeMaxM) {
    if (votes.length >= 2 && eaveVoteFrac >= 0.4) {
      return {
        kind: "eave",
        reason: `stepped tiers, ${eaveVotes}/${votes.length} stations drain here`,
      };
    }
    if (votes.length >= 2 && eaveVoteFrac <= 0.15) {
      return {
        kind: "rake",
        reason: `${alongDelta.toFixed(2)}m height change along the edge, no stations drain here`,
      };
    }
    return {
      kind: "unknown",
      reason: `stepped ${alongDelta.toFixed(2)}m, drainage mixed (${eaveVotes}/${votes.length})`,
    };
  }

  // 4. Level edge: fall back to the aggregate interior rise.
  const riseVals = votes.map((s) => s.rise as number);
  if (riseVals.length === 0) {
    return { kind: "unknown", reason: "DSM no-data toward interior" };
  }
  const rise = median(riseVals);
  if (rise > interiorRiseMinM) {
    return {
      kind: "eave",
      reason: `level (Δ${alongDelta.toFixed(2)}m), interior +${rise.toFixed(2)}m`,
    };
  }
  if (rise < -interiorRiseMinM) {
    // Interior FALLS away — this edge is higher than the roof behind it
    // (upper tier's back edge / parapet-ish). Not a gutter line.
    return {
      kind: "rake",
      reason: `level but interior drops ${(-rise).toFixed(2)}m`,
    };
  }
  return {
    kind: "unknown",
    reason: `level, interior flat (${rise >= 0 ? "+" : ""}${rise.toFixed(2)}m)`,
  };
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Compass azimuth (0=N, 90=E) of an edge's outward normal, on the
 * north-up grid (x → east, y → south). `interiorSign` is the unit normal
 * pointing INWARD; the outward is its negation.
 */
export function outwardNormalAzimuthDeg(interiorSign: {
  nx: number;
  ny: number;
}): number {
  const ox = -interiorSign.nx; // east component
  const oy = -interiorSign.ny; // south component (grid y)
  // North component = -oy.
  const deg = (Math.atan2(ox, -oy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Unit normal of edge (a→b) pointing toward the polygon interior
 *  (approximated by the centroid — fine for building footprints). */
export function interiorNormal(a: Pt, b: Pt, centroid: Pt): { nx: number; ny: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if (nx * (centroid.x - mx) + ny * (centroid.y - my) < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { nx, ny };
}

/**
 * Inward unit normal of edge (a→b) for an arbitrary (possibly CONCAVE)
 * ring: probe both candidate normals with a point-in-polygon test at two
 * depths. The centroid heuristic (interiorNormal) points the wrong way on
 * U/L-shaped rings whose centroid falls outside the region — which
 * inverted the tier engine's inside-vs-outside height test.
 */
export function inwardNormalForRing(
  a: Pt,
  b: Pt,
  ringPoly: Pt[],
  probePx = 4,
): { nx: number; ny: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const n1 = { nx: -dy / len, ny: dx / len };
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  let score1 = 0;
  let score2 = 0;
  for (const d of [probePx, probePx * 2.5]) {
    if (pointInPolygon({ x: mx + n1.nx * d, y: my + n1.ny * d }, ringPoly)) score1++;
    if (pointInPolygon({ x: mx - n1.nx * d, y: my - n1.ny * d }, ringPoly)) score2++;
  }
  if (score1 === score2) {
    // Degenerate (needle region) — fall back to the centroid heuristic.
    return interiorNormal(a, b, polygonCentroid(ringPoly));
  }
  return score1 > score2 ? n1 : { nx: -n1.nx, ny: -n1.ny };
}

/** Distance from a point to the nearest segment of an OPEN polyline
 *  (no phantom closing edge — use distToRing for closed rings). */
export function distToPolyline(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 > 0
        ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
        : 0;
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

export function polygonCentroid(points: Pt[]): Pt {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

/* ------------------------------------------------------------------ */
/*  Stories from the DSM                                               */
/* ------------------------------------------------------------------ */

/**
 * Estimate eave height above ground:
 *   eave  = median DSM just inside the perimeter (the gutter line)
 *   ground = low percentile of DSM in a ring OUTSIDE the footprint
 *            (mask-negative pixels only, so a neighbor's roof or a
 *            parked RV doesn't read as "ground")
 * Returns null when either sample set is too thin.
 */
export function eaveHeightAboveGroundM(args: {
  ring: Pt[];
  mask: Uint8Array;
  width: number;
  height: number;
  sample: DsmSampler;
  metersPerPixel: number;
}): number | null {
  const { ring, mask, width, height, sample, metersPerPixel } = args;
  if (ring.length < 3) return null;
  const centroid = polygonCentroid(ring);

  // Eave-line heights: inset 0.7 m inside each edge midpointish stations.
  const eaveHs: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    // Probe-based: the centroid heuristic flips on concave footprints.
    const nrm = inwardNormalForRing(a, b, ring, 0.4 / metersPerPixel);
    const dPx = 0.7 / metersPerPixel;
    for (const t of [0.3, 0.5, 0.7]) {
      const v = sample(
        a.x + (b.x - a.x) * t + nrm.nx * dPx,
        a.y + (b.y - a.y) * t + nrm.ny * dPx,
      );
      if (v != null && Number.isFinite(v)) eaveHs.push(v);
    }
  }
  if (eaveHs.length < 4) return null;
  // 18th percentile ≈ the LOW eave line (upper-story eaves and ridgey
  // samples pull the median up; gutters hang at the LOW line — and the
  // story bucket that prices downspout drops should follow it, not the
  // tall entry gables).
  eaveHs.sort((a, b) => a - b);
  const eaveH = eaveHs[Math.floor(eaveHs.length * 0.18)];

  // Ground ring: sample a band 2–8 m outside the polygon bbox edges,
  // keeping only mask-negative pixels.
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const bandPx = 8 / metersPerPixel;
  const stepPx = Math.max(1, Math.round(1 / metersPerPixel));
  const groundHs: number[] = [];
  const tryGround = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
    if (mask[yi * width + xi] > 0) return;
    const v = sample(xi, yi);
    if (v != null && Number.isFinite(v)) groundHs.push(v);
  };
  for (let x = minX - bandPx; x <= maxX + bandPx; x += stepPx) {
    for (const y of [minY - bandPx / 2, maxY + bandPx / 2, minY - bandPx, maxY + bandPx]) {
      tryGround(x, y);
    }
  }
  for (let y = minY - bandPx; y <= maxY + bandPx; y += stepPx) {
    for (const x of [minX - bandPx / 2, maxX + bandPx / 2, minX - bandPx, maxX + bandPx]) {
      tryGround(x, y);
    }
  }
  if (groundHs.length < 12) return null;
  groundHs.sort((a, b) => a - b);
  // 15th percentile: below the median of bushes/cars, above DSM voids.
  const groundH = groundHs[Math.floor(groundHs.length * 0.15)];

  const h = eaveH - groundH;
  if (!Number.isFinite(h) || h < 1 || h > 20) return null;
  return h;
}

/* ------------------------------------------------------------------ */
/*  Raster crop                                                        */
/* ------------------------------------------------------------------ */

export type CropWindow = { x: number; y: number; width: number; height: number };

/** Clamped crop window around a bbox with margin (all in px). */
export function cropWindowAround(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  marginPx: number,
  width: number,
  height: number,
): CropWindow {
  const x0 = Math.max(0, Math.floor(bbox.minX - marginPx));
  const y0 = Math.max(0, Math.floor(bbox.minY - marginPx));
  const x1 = Math.min(width, Math.ceil(bbox.maxX + marginPx));
  const y1 = Math.min(height, Math.ceil(bbox.maxY + marginPx));
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/**
 * Pad cropped rasters to an exact aspect ratio when the source raster
 * couldn't supply enough pixels (building near the dataLayers window
 * edge). The pad is inert data — RGB gets a dark neutral, DSM gets
 * no-data, mask gets background — and `offX/offY` tell the caller how
 * far the original crop shifted inside the padded frame. Guarantees the
 * cover-fit ≡ contain-fit invariant that keeps traced geometry inside
 * the client's 900×580 canvas.
 */
export function padToAspect(args: {
  rgb: Uint8Array;
  dsm: Float32Array;
  mask: Uint8Array;
  width: number;
  height: number;
  aspect: number;
  dsmNoData: number;
}): {
  rgb: Uint8Array;
  dsm: Float32Array;
  mask: Uint8Array;
  width: number;
  height: number;
  offX: number;
  offY: number;
} {
  const { width, height, aspect, dsmNoData } = args;
  const cur = width / height;
  if (Math.abs(cur - aspect) / aspect < 0.01) {
    return { ...args, offX: 0, offY: 0 };
  }
  const W = cur < aspect ? Math.ceil(height * aspect) : width;
  const H = cur < aspect ? height : Math.ceil(width / aspect);
  const offX = Math.floor((W - width) / 2);
  const offY = Math.floor((H - height) / 2);

  const rgb = new Uint8Array(W * H * 3);
  // Dark neutral — reads as "beyond imagery", not as content.
  for (let i = 0; i < W * H; i++) {
    rgb[i * 3] = 16;
    rgb[i * 3 + 1] = 22;
    rgb[i * 3 + 2] = 28;
  }
  const dsm = new Float32Array(W * H).fill(dsmNoData);
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < height; y++) {
    rgb.set(
      args.rgb.subarray(y * width * 3, (y + 1) * width * 3),
      ((y + offY) * W + offX) * 3,
    );
    dsm.set(
      args.dsm.subarray(y * width, (y + 1) * width),
      (y + offY) * W + offX,
    );
    mask.set(
      args.mask.subarray(y * width, (y + 1) * width),
      (y + offY) * W + offX,
    );
  }
  return { rgb, dsm, mask, width: W, height: H, offX, offY };
}

export function cropUint8(
  src: Uint8Array,
  width: number,
  win: CropWindow,
  channels = 1,
): Uint8Array {
  const out = new Uint8Array(win.width * win.height * channels);
  for (let y = 0; y < win.height; y++) {
    const srcStart = ((win.y + y) * width + win.x) * channels;
    out.set(src.subarray(srcStart, srcStart + win.width * channels), y * win.width * channels);
  }
  return out;
}

export function cropFloat32(
  src: Float32Array,
  width: number,
  win: CropWindow,
): Float32Array {
  const out = new Float32Array(win.width * win.height);
  for (let y = 0; y < win.height; y++) {
    const srcStart = (win.y + y) * width + win.x;
    out.set(src.subarray(srcStart, srcStart + win.width), y * win.width);
  }
  return out;
}
