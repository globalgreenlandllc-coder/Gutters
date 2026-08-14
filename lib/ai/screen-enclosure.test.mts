import { test } from "node:test";
import assert from "node:assert/strict";
import { detectScreenEnclosures } from "./screen-enclosure.ts";

/**
 * Synthetic Sarasota-in-miniature at 0.1 m/px. World: 200×200 px (20 m).
 * Ground plane at 1.0 m DSM, lawn-green orthophoto. Optional pieces are
 * painted by each test:
 *   house — pink tile roof, DSM 8 m, mask=1
 *   cage  — attached screen enclosure, DSM 4.5 m (flat), mask=1;
 *           white frame grid over gray deck with a pool-blue patch
 */
const W = 200;
const H = 200;
const MPP = 0.1;

type World = {
  mask: Uint8Array;
  dsm: Float32Array;
  rgb: Uint8Array;
};

function makeWorld(): World {
  const mask = new Uint8Array(W * H);
  const dsm = new Float32Array(W * H).fill(1.0);
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    rgb[i * 3] = 80;
    rgb[i * 3 + 1] = 140;
    rgb[i * 3 + 2] = 60;
  }
  return { mask, dsm, rgb };
}

function paint(
  w: World,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opts: {
    mask?: boolean;
    heightM?: number | ((x: number, y: number) => number);
    color?: [number, number, number] | ((x: number, y: number) => [number, number, number]);
  },
) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      if (opts.mask) w.mask[i] = 1;
      if (opts.heightM !== undefined) {
        w.dsm[i] =
          typeof opts.heightM === "function" ? opts.heightM(x, y) : opts.heightM;
      }
      if (opts.color) {
        const c =
          typeof opts.color === "function" ? opts.color(x, y) : opts.color;
        w.rgb[i * 3] = c[0];
        w.rgb[i * 3 + 1] = c[1];
        w.rgb[i * 3 + 2] = c[2];
      }
    }
  }
}

const PINK_TILE: [number, number, number] = [230, 180, 170];
const POOL_BLUE: [number, number, number] = [60, 110, 180];
const DECK_GRAY: [number, number, number] = [150, 150, 150];
const FRAME_WHITE: [number, number, number] = [245, 245, 245];

/** House 10×10 m in the top-left quadrant. */
function paintHouse(w: World) {
  paint(w, 20, 20, 120, 120, { mask: true, heightM: 8, color: PINK_TILE });
}

/** Cage 8×7 m attached to the house's right wall: white frame beams
 *  every 3 m (real cage bay spacing) over gray deck, 4×4 m pool-blue
 *  patch in the middle. */
function paintCage(w: World) {
  paint(w, 120, 30, 200, 100, {
    mask: true,
    heightM: 4.5,
    color: (x, y) =>
      x % 30 === 0 || y % 30 === 0
        ? FRAME_WHITE
        : x >= 140 && x < 180 && y >= 45 && y < 85
          ? POOL_BLUE
          : DECK_GRAY,
  });
}

function detect(w: World) {
  return detectScreenEnclosures({
    mask: w.mask,
    dsm: w.dsm,
    dsmNoData: -9999,
    rgb: w.rgb,
    width: W,
    height: H,
    metersPerPixel: MPP,
    groundHeightM: 1.0,
  });
}

test("cage attached to the house is vetoed; the house is not", () => {
  const w = makeWorld();
  paintHouse(w);
  paintCage(w);
  const det = detect(w);
  // The frame beams slice the synthetic pool into quadrants; only the
  // largest clears the 6 m² component floor.
  assert.ok(det.poolSeedM2 >= 6, `pool seeds found (${det.poolSeedM2} m²)`);
  // Whole cage (≈56 m² of mask) removed, within tolerance for frame fringe.
  assert.ok(
    det.vetoMaskM2 >= 40,
    `most of the cage vetoed (${det.vetoMaskM2} m²)`,
  );
  // Not one house-roof pixel may be vetoed — the roof sits above the
  // cage-top height cap AND matches the palette.
  for (let y = 20; y < 120; y++) {
    for (let x = 20; x < 120; x++) {
      assert.equal(det.veto[y * W + x], 0, `roof pixel (${x},${y}) vetoed`);
    }
  }
});

test("house without a pool is a no-op", () => {
  const w = makeWorld();
  paintHouse(w);
  const det = detect(w);
  assert.equal(det.vetoPx, 0);
  assert.equal(det.poolSeedM2, 0);
});

test("blue tarp draped on a pitched roof is refused (slope gate)", () => {
  const w = makeWorld();
  paintHouse(w);
  // Roof slopes 4 m → 9 m across the house; tarp covers 5×5 m of slope.
  paint(w, 20, 20, 120, 120, {
    heightM: (x) => 4 + ((x - 20) / 100) * 5,
  });
  paint(w, 40, 40, 90, 90, {
    color: POOL_BLUE,
  });
  const det = detect(w);
  assert.equal(det.vetoPx, 0, "tarp on slope must not veto");
});

test("opaque flat blue roof section is refused (no frame-grid speckle)", () => {
  const w = makeWorld();
  paintHouse(w);
  // Attached flat blue metal roof at cage-like height, uniform color.
  paint(w, 120, 30, 190, 100, { mask: true, heightM: 4.5, color: POOL_BLUE });
  const det = detect(w);
  assert.equal(det.vetoPx, 0, "uniform blue roof must not veto");
});

test("veto that would consume most of the mask is dropped (brake)", () => {
  const w = makeWorld();
  // Tiny "house": one 5×5 m flat cage-like structure with a pool —
  // removing it would leave < 45 m² of mask.
  paint(w, 80, 80, 130, 130, {
    mask: true,
    heightM: 4.5,
    color: (x, y) =>
      x % 10 === 0 || y % 10 === 0 ? FRAME_WHITE : POOL_BLUE,
  });
  const det = detect(w);
  assert.equal(det.vetoPx, 0, "brake must drop a house-consuming veto");
});
