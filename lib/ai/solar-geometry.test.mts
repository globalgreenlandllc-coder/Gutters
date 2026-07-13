import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEdgeByDsm,
  cleanFootprint,
  closeMask,
  cropFloat32,
  cropUint8,
  cropWindowAround,
  eaveHeightAboveGroundM,
  interiorNormal,
  offsetPolygonOutward,
  outwardNormalAzimuthDeg,
  polygonArea,
  polygonCentroid,
  traceMaskFootprint,
  type DsmSampler,
  type Pt,
} from "./solar-geometry.ts";

/* ------------------------------------------------------------------ */
/*  Synthetic-raster helpers                                           */
/* ------------------------------------------------------------------ */

function rectMask(
  W: number,
  H: number,
  rects: { x: number; y: number; w: number; h: number }[],
): Uint8Array {
  const m = new Uint8Array(W * H);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        m[y * W + x] = 1;
      }
    }
  }
  return m;
}

/* ------------------------------------------------------------------ */
/*  Footprint tracing                                                  */
/* ------------------------------------------------------------------ */

test("traceMaskFootprint traces the center component, not a detached shed", () => {
  const W = 200;
  const H = 200;
  // House at center, shed in the corner.
  const mask = rectMask(W, H, [
    { x: 70, y: 70, w: 60, h: 50 },
    { x: 5, y: 5, w: 20, h: 20 },
  ]);
  const traced = traceMaskFootprint(mask, W, H);
  assert.ok(traced, "traced a footprint");
  assert.equal(traced.touchesEdge, false);
  assert.equal(traced.areaPx, 60 * 50);
  // Every boundary point must belong to the central rect, not the shed.
  for (const p of traced.boundary) {
    assert.ok(p.x >= 69 && p.x <= 130 && p.y >= 69 && p.y <= 120);
  }
});

test("traceMaskFootprint flags a component that touches the raster edge", () => {
  const W = 100;
  const H = 100;
  const mask = rectMask(W, H, [{ x: 0, y: 40, w: 60, h: 30 }]);
  const traced = traceMaskFootprint(mask, W, H);
  assert.ok(traced);
  assert.equal(traced.touchesEdge, true);
});

test("cleanFootprint collapses a pixel-staircase L-shape to ~6 corners", () => {
  const W = 300;
  const H = 300;
  // L-shape: 120×100 with a 60×50 notch removed from the top-right.
  const mask = rectMask(W, H, [
    { x: 90, y: 90, w: 120, h: 100 },
  ]);
  // carve the notch
  for (let y = 90; y < 140; y++) {
    for (let x = 150; x < 210; x++) {
      mask[y * W + x] = 0;
    }
  }
  const traced = traceMaskFootprint(mask, W, H);
  assert.ok(traced);
  const cleaned = cleanFootprint(traced.boundary, 0.1);
  assert.ok(cleaned);
  assert.ok(
    cleaned.points.length >= 6 && cleaned.points.length <= 8,
    `expected ~6 corners, got ${cleaned.points.length}`,
  );
  // Area preserved within 10%.
  const expected = 120 * 100 - 60 * 50;
  const got = polygonArea(cleaned.points);
  assert.ok(
    Math.abs(got - expected) / expected < 0.1,
    `area ${got} vs expected ${expected}`,
  );
});

/* ------------------------------------------------------------------ */
/*  Morphological close                                                */
/* ------------------------------------------------------------------ */

test("closeMask bridges a sub-meter wall notch but not a real courtyard", () => {
  const W = 200;
  const H = 200;
  // Two 40-wide wings joined at the back, separated in front by a
  // 12 px notch (1.2 m at 0.1 m/px) — the wings' roofs would merge.
  const mask = rectMask(W, H, [
    { x: 40, y: 40, w: 120, h: 40 }, // back bar (joins the wings)
    { x: 40, y: 80, w: 54, h: 60 }, // left wing
    { x: 106, y: 80, w: 54, h: 60 }, // right wing (12 px gap: 94..106)
  ]);
  const closed = closeMask(mask, W, H, 9); // 0.9 m at 0.1 m/px
  // A pixel in the middle of the notch is now foreground.
  assert.equal(closed[110 * W + 100], 1, "notch bridged");

  // A 30 px (3 m) courtyard must survive.
  const mask2 = rectMask(W, H, [
    { x: 40, y: 40, w: 120, h: 40 },
    { x: 40, y: 80, w: 45, h: 60 },
    { x: 115, y: 80, w: 45, h: 60 }, // 30 px gap: 85..115
  ]);
  const closed2 = closeMask(mask2, W, H, 9);
  assert.equal(closed2[110 * W + 100], 0, "courtyard preserved");
});

test("closeMask can merge neighbors — the engine's area guard must catch it", () => {
  const W = 120;
  const H = 120;
  // House + shed 10 px (1 m) apart: a 9 px close bridges them.
  const mask = rectMask(W, H, [
    { x: 30, y: 30, w: 40, h: 40 },
    { x: 80, y: 30, w: 20, h: 40 },
  ]);
  const closed = closeMask(mask, W, H, 9);
  const before = traceMaskFootprint(mask, W, H);
  const after = traceMaskFootprint(closed, W, H);
  assert.ok(before && after);
  // Merged component is far bigger than the raw center component —
  // exactly the signal the engine's 1.12× guard rejects.
  assert.ok(after.areaPx > before.areaPx * 1.12);
});

/* ------------------------------------------------------------------ */
/*  Outward offset                                                     */
/* ------------------------------------------------------------------ */

test("offsetPolygonOutward grows a square by the offset on every side", () => {
  const sq: Pt[] = [
    { x: 10, y: 10 },
    { x: 110, y: 10 },
    { x: 110, y: 110 },
    { x: 10, y: 110 },
  ];
  const out = offsetPolygonOutward(sq, 8);
  assert.equal(out.length, 4);
  const xs = out.map((p) => p.x);
  const ys = out.map((p) => p.y);
  assert.ok(Math.abs(Math.min(...xs) - 2) < 0.01);
  assert.ok(Math.abs(Math.max(...xs) - 118) < 0.01);
  assert.ok(Math.abs(Math.min(...ys) - 2) < 0.01);
  assert.ok(Math.abs(Math.max(...ys) - 118) < 0.01);
});

test("offsetPolygonOutward keeps an L-shape simple (no self-intersection)", () => {
  const L: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 40 },
    { x: 50, y: 40 },
    { x: 50, y: 100 },
    { x: 0, y: 100 },
  ];
  const out = offsetPolygonOutward(L, 5);
  assert.equal(out.length, 6);
  assert.ok(polygonArea(out) > polygonArea(L));
});

test("offsetPolygonOutward bevels acute corners instead of spiking", () => {
  // Sharp 26° wedge: a full miter at the tip would land ~4.4× the
  // offset away. The 2× cap must bevel it.
  const wedge: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 0, y: 50 },
  ];
  const out = offsetPolygonOutward(wedge, 6);
  for (const p of out) {
    const nearest = Math.min(
      ...wedge.map((w) => Math.hypot(w.x - p.x, w.y - p.y)),
    );
    assert.ok(
      nearest <= 6 * 2 + 1e-6,
      `vertex spiked ${nearest.toFixed(1)}px from the polygon (cap is 12)`,
    );
  }
});

test("offsetPolygonOutward is winding-agnostic", () => {
  const ccw: Pt[] = [
    { x: 10, y: 10 },
    { x: 110, y: 10 },
    { x: 110, y: 110 },
    { x: 10, y: 110 },
  ];
  const cw = [...ccw].reverse();
  const a = polygonArea(offsetPolygonOutward(ccw, 6));
  const b = polygonArea(offsetPolygonOutward(cw, 6));
  assert.ok(Math.abs(a - b) < 1e-6);
  assert.ok(a > polygonArea(ccw));
});

/* ------------------------------------------------------------------ */
/*  DSM edge classification                                            */
/* ------------------------------------------------------------------ */

/** Gable roof running east-west: ridge along the horizontal centerline,
 *  planes sloping down to the north and south edges. At 0.1 m/px. */
function gableSampler(ringTop: number, ringBottom: number): DsmSampler {
  const ridgeY = (ringTop + ringBottom) / 2;
  return (x, y) => {
    // 30% slope: drops 0.03 m per px away from the ridge.
    const d = Math.abs(y - ridgeY);
    return 108 - d * 0.03;
  };
}

test("gable roof: level bottom/top edges are eaves, climbing side edges are rakes", () => {
  const mpp = 0.1;
  // 20m × 12m footprint at 0.1 m/px → 200×120 px.
  const ring: Pt[] = [
    { x: 20, y: 20 },
    { x: 220, y: 20 },
    { x: 220, y: 140 },
    { x: 20, y: 140 },
  ];
  const centroid = polygonCentroid(ring);
  const sample = gableSampler(20, 140);

  const verdicts = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const nrm = interiorNormal(a, b, centroid);
    verdicts.push(classifyEdgeByDsm(a, b, nrm, sample, mpp));
  }
  // Edge 0: top (north eave), edge 1: right rake, edge 2: bottom (south
  // eave), edge 3: left rake.
  assert.equal(verdicts[0].kind, "eave", `top: ${verdicts[0].reason}`);
  assert.equal(verdicts[1].kind, "rake", `right: ${verdicts[1].reason}`);
  assert.equal(verdicts[2].kind, "eave", `bottom: ${verdicts[2].reason}`);
  assert.equal(verdicts[3].kind, "rake", `left: ${verdicts[3].reason}`);
});

test("hip roof: all four edges are eaves", () => {
  const mpp = 0.1;
  const ring: Pt[] = [
    { x: 20, y: 20 },
    { x: 220, y: 20 },
    { x: 220, y: 140 },
    { x: 20, y: 140 },
  ];
  const centroid = polygonCentroid(ring);
  // Pyramid: height falls with Chebyshev-ish distance from center.
  const sample: DsmSampler = (x, y) => {
    const dx = Math.abs(x - centroid.x) / 200;
    const dy = Math.abs(y - centroid.y) / 120;
    return 110 - Math.max(dx, dy) * 6;
  };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const nrm = interiorNormal(a, b, centroid);
    const v = classifyEdgeByDsm(a, b, nrm, sample, mpp);
    assert.equal(v.kind, "eave", `edge ${i}: ${v.reason}`);
  }
});

test("stepped multi-tier wall still reads as an eave (not a rake)", () => {
  const mpp = 0.1;
  // One straight 24 m south wall fronting TWO tiers: the left 12 m is a
  // 1-story wing (eave surface ~104), the right 12 m is the 2-story main
  // (eave surface ~107). Both tiers drain to this wall — the interior
  // rises everywhere — but the height STEPS 3 m mid-edge, which a
  // whole-edge climb test would misread as a rake.
  const a: Pt = { x: 20, y: 140 };
  const b: Pt = { x: 260, y: 140 };
  const nrm = { nx: 0, ny: -1 }; // interior is north (up in image coords)
  const sample: DsmSampler = (x, y) => {
    const base = x < 140 ? 104 : 107;
    const depth = 140 - y; // px inward from the wall
    return base + Math.max(0, depth) * 0.03; // rises going inward
  };
  const v = classifyEdgeByDsm(a, b, nrm, sample, mpp);
  assert.equal(v.kind, "eave", v.reason);
});

test("interior samples outside the mask don't poison a narrow wing's eave", () => {
  const mpp = 0.1;
  // 3 m-deep porch wing: interior samples at 2.0/2.8 m inset land past
  // the far wall (mask 0, ground at 100 m). With the mask filter they're
  // discarded and the near-edge rise still reads eave-ish via the level
  // fallback; without it the ground samples would fake "interior drops".
  const a: Pt = { x: 20, y: 100 };
  const b: Pt = { x: 120, y: 100 };
  const nrm = { nx: 0, ny: -1 };
  const wingDepthPx = 30; // 3 m
  const insideMask = (x: number, y: number) =>
    y <= 100 && y >= 100 - wingDepthPx;
  const sample: DsmSampler = (x, y) => {
    if (!insideMask(x, y)) return 100; // ground
    const depth = 100 - y;
    return 103 + depth * 0.05;
  };
  const withMask = classifyEdgeByDsm(a, b, nrm, sample, mpp, { insideMask });
  assert.notEqual(withMask.kind, "rake", withMask.reason);
});

test("no-data DSM returns unknown, not a guess", () => {
  const ring: Pt[] = [
    { x: 10, y: 10 },
    { x: 110, y: 10 },
    { x: 110, y: 70 },
    { x: 10, y: 70 },
  ];
  const centroid = polygonCentroid(ring);
  const v = classifyEdgeByDsm(
    ring[0],
    ring[1],
    interiorNormal(ring[0], ring[1], centroid),
    () => null,
    0.1,
  );
  assert.equal(v.kind, "unknown");
});

/* ------------------------------------------------------------------ */
/*  Outward-normal azimuth                                             */
/* ------------------------------------------------------------------ */

test("outwardNormalAzimuthDeg: grid is north-up (x east, y south)", () => {
  // Interior is to the WEST → outward normal points EAST → azimuth 90.
  assert.ok(
    Math.abs(outwardNormalAzimuthDeg({ nx: -1, ny: 0 }) - 90) < 1e-9,
  );
  // Interior to the SOUTH (ny=+1 is down/south) → outward NORTH → 0.
  assert.ok(Math.abs(outwardNormalAzimuthDeg({ nx: 0, ny: 1 }) - 0) < 1e-9);
  // Interior to the NORTH → outward SOUTH → 180.
  assert.ok(
    Math.abs(outwardNormalAzimuthDeg({ nx: 0, ny: -1 }) - 180) < 1e-9,
  );
  // Interior to the EAST → outward WEST → 270.
  assert.ok(
    Math.abs(outwardNormalAzimuthDeg({ nx: 1, ny: 0 }) - 270) < 1e-9,
  );
});

/* ------------------------------------------------------------------ */
/*  Stories from DSM                                                   */
/* ------------------------------------------------------------------ */

test("eaveHeightAboveGroundM reads a 2-story eave height", () => {
  const W = 300;
  const H = 300;
  const mpp = 0.1;
  const mask = rectMask(W, H, [{ x: 100, y: 100, w: 100, h: 80 }]);
  const ring: Pt[] = [
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 200, y: 180 },
    { x: 100, y: 180 },
  ];
  // Ground at 100 m elevation; roof surface at eave 105.8 m (≈19 ft),
  // rising toward the interior.
  const centroid = polygonCentroid(ring);
  const sample: DsmSampler = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return null;
    if (mask[yi * W + xi] > 0) {
      const dx = Math.abs(x - centroid.x) / 100;
      const dy = Math.abs(y - centroid.y) / 80;
      return 105.8 + (1 - Math.max(dx, dy)) * 2;
    }
    return 100;
  };
  const h = eaveHeightAboveGroundM({
    ring,
    mask,
    width: W,
    height: H,
    sample,
    metersPerPixel: mpp,
  });
  assert.ok(h != null, "sampled a height");
  // Samples sit 0.7 m inside the drip edge, so they read the shingle
  // surface slightly above the true eave line — the 1/2/3-story buckets
  // (≤14 / ≤24 ft) absorb that overshoot by design.
  const ft = h / 0.3048;
  assert.ok(ft > 18 && ft < 24, `expected a 2-story reading, got ${ft.toFixed(1)} ft`);
});

/* ------------------------------------------------------------------ */
/*  Crop helpers                                                       */
/* ------------------------------------------------------------------ */

test("cropWindowAround clamps to raster bounds", () => {
  const win = cropWindowAround(
    { minX: 5, minY: 5, maxX: 95, maxY: 95 },
    20,
    100,
    100,
  );
  assert.deepEqual(win, { x: 0, y: 0, width: 100, height: 100 });
});

test("cropUint8/cropFloat32 extract the right window (multi-channel too)", () => {
  const W = 4;
  const src = Uint8Array.from([
    0, 1, 2, 3,
    10, 11, 12, 13,
    20, 21, 22, 23,
    30, 31, 32, 33,
  ]);
  const win = { x: 1, y: 1, width: 2, height: 2 };
  assert.deepEqual([...cropUint8(src, W, win)], [11, 12, 21, 22]);
  const f = Float32Array.from(src);
  assert.deepEqual([...cropFloat32(f, W, win)], [11, 12, 21, 22]);

  // 3-channel: pixel (x,y) value = (y*10+x) repeated per channel.
  const rgb = new Uint8Array(W * W * 3);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) rgb[(y * W + x) * 3 + c] = y * 10 + x + c;
    }
  }
  const cropped = cropUint8(rgb, W, win, 3);
  assert.deepEqual([...cropped.slice(0, 6)], [11, 12, 13, 12, 13, 14]);
});
