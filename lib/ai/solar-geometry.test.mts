import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEdgeByDsm,
  cleanFootprint,
  closeMask,
  cropFloat32,
  cropUint8,
  cropWindowAround,
  dechamferPolygon,
  expandWindowToAspect,
  estimateGroundHeightM,
  estimateRenderShift,
  inwardNormalForRing,
  regularizeRing,
  distToPolyline,
  tierRegionRings,
  distToRing,
  refineEdgesToPhoto,
  trimMaskToRoofPlanes,
  growRoofMask,
  findTierEdges,
  recoverAttachedRoofs,
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
  // The rectilinear L must take the per-wall straightening path.
  assert.equal(cleaned.cleanup.kind, "regularized");
});

/* ------------------------------------------------------------------ */
/*  regularizeRing — per-wall straightening                            */
/* ------------------------------------------------------------------ */

/** Interior turn angle at each vertex (deg) — 90 for a square corner. */
function cornerAngles(ring: Pt[]): number[] {
  const out: number[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n];
    const c = ring[i];
    const q = ring[(i + 1) % n];
    const v1x = c.x - p.x;
    const v1y = c.y - p.y;
    const v2x = q.x - c.x;
    const v2y = q.y - c.y;
    const cos =
      (v1x * v2x + v1y * v2y) /
      (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
    out.push((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
  }
  return out;
}

test("regularizeRing straightens a wavy wall to one segment (4 corners)", () => {
  // 40×30 m rectangle at 0.1 m/px whose top wall waves ±0.3 m — the
  // DP-survivor pattern the owner screenshots as "wavy like a rope".
  const ring: Pt[] = [
    { x: 0, y: 0 },
    { x: 80, y: 3 },
    { x: 160, y: -3 },
    { x: 240, y: 2 },
    { x: 320, y: -2 },
    { x: 400, y: 0 },
    { x: 400, y: 300 },
    { x: 0, y: 300 },
  ];
  const reg = regularizeRing(ring, 0.1);
  assert.equal(reg.changed, true, `expected change, got ${reg.reason}`);
  assert.equal(reg.points.length, 4, `got ${reg.points.length} corners`);
  for (const a of cornerAngles(reg.points)) {
    assert.ok(Math.abs(a - 90) < 1.5, `corner ${a.toFixed(1)}° not square`);
  }
  const area = polygonArea(reg.points);
  assert.ok(Math.abs(area - 400 * 300) / (400 * 300) < 0.05, `area ${area}`);
});

test("regularizeRing squares a rotated house (30°) with noisy walls", () => {
  const base: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 2.5 },
    { x: 200, y: -2.5 },
    { x: 300, y: 0 },
    { x: 300, y: 2 + 200 }, // slight mid-wall kink target below
    { x: 0, y: 200 },
  ];
  const rot = (p: Pt): Pt => {
    const t = (30 * Math.PI) / 180;
    return {
      x: 150 + (p.x - 150) * Math.cos(t) - (p.y - 100) * Math.sin(t),
      y: 100 + (p.x - 150) * Math.sin(t) + (p.y - 100) * Math.cos(t),
    };
  };
  const reg = regularizeRing(base.map(rot), 0.1);
  assert.equal(reg.changed, true, `expected change, got ${reg.reason}`);
  assert.equal(reg.points.length, 4, `got ${reg.points.length} corners`);
  for (const a of cornerAngles(reg.points)) {
    assert.ok(Math.abs(a - 90) < 1.5, `corner ${a.toFixed(1)}° not square`);
  }
});

test("regularizeRing keeps a real 0.9 m jog as two square corners", () => {
  const ring: Pt[] = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 9 },
    { x: 400, y: 9 },
    { x: 400, y: 300 },
    { x: 0, y: 300 },
  ];
  const reg = regularizeRing(ring, 0.1);
  assert.equal(reg.changed, true, `expected change, got ${reg.reason}`);
  assert.equal(reg.points.length, 6, `got ${reg.points.length} corners`);
  for (const a of cornerAngles(reg.points)) {
    assert.ok(Math.abs(a - 90) < 1.5, `corner ${a.toFixed(1)}° not square`);
  }
  // The step corners stay where the roof steps.
  const near = (x: number, y: number) =>
    reg.points.some((p) => Math.hypot(p.x - x, p.y - y) < 2);
  assert.ok(near(200, 0) && near(200, 9), "jog corners moved");
});

test("regularizeRing keeps a genuine 45° wall as a diagonal", () => {
  const ring: Pt[] = [
    { x: 0, y: 0 },
    { x: 340, y: 0 },
    { x: 400, y: 60 },
    { x: 400, y: 300 },
    { x: 0, y: 300 },
  ];
  const reg = regularizeRing(ring, 0.1);
  assert.equal(reg.changed, true, `expected change, got ${reg.reason}`);
  assert.equal(reg.points.length, 5, `got ${reg.points.length} corners`);
  // Find the diagonal edge and check its angle stayed ~45°.
  let sawDiag = false;
  for (let i = 0; i < reg.points.length; i++) {
    const a = reg.points[i];
    const b = reg.points[(i + 1) % reg.points.length];
    let ang =
      (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
    if (ang > 20 && ang < 70) {
      sawDiag = true;
      assert.ok(Math.abs(ang - 45) < 1, `diagonal drifted to ${ang.toFixed(1)}°`);
    }
  }
  assert.ok(sawDiag, "diagonal wall was destroyed");
});

test("regularizeRing straightens waves on a CONCAVE (L) ring, courtyard corner intact", () => {
  const ring: Pt[] = [
    { x: 0, y: 0 },
    { x: 130, y: 3 },
    { x: 260, y: -2 },
    { x: 400, y: 0 },
    { x: 400, y: 150 },
    { x: 250, y: 150 },
    { x: 250, y: 300 },
    { x: 0, y: 300 },
  ];
  const reg = regularizeRing(ring, 0.1);
  assert.equal(reg.changed, true, `expected change, got ${reg.reason}`);
  assert.equal(reg.points.length, 6, `got ${reg.points.length} corners`);
  for (const a of cornerAngles(reg.points)) {
    assert.ok(Math.abs(a - 90) < 1.5, `corner ${a.toFixed(1)}° not square`);
  }
  const near = (x: number, y: number) =>
    reg.points.some((p) => Math.hypot(p.x - x, p.y - y) < 2.5);
  assert.ok(near(400, 150) && near(250, 150) && near(250, 300), "L notch moved");
});

test("regularizeRing straightens a rambler whose walls are each 1-3° off (proportional shape)", () => {
  // The 6220 case: a plain rectangle traced with every wall slightly
  // off-angle and micro-debris at the top-edge junction. Result must be
  // ONE straight top edge and four exactly-square corners — not walls
  // that are almost-but-not-quite parallel ("wavy, not proportional").
  const ring: Pt[] = [
    { x: 0, y: 0 },
    { x: 130, y: -5 }, // top run A (≈ -2.2°)
    { x: 134, y: -4 }, // 0.4 m micro-debris at the junction
    { x: 300, y: -6 }, // top run B (≈ -0.7°)
    { x: 302, y: 200 }, // right wall (≈ 0.6° off vertical)
    { x: 2, y: 204 }, // bottom (≈ 0.8°)
  ];
  const reg = regularizeRing(ring, 0.1);
  assert.equal(reg.changed, true, `expected change, got ${reg.reason}`);
  assert.equal(reg.points.length, 4, `got ${reg.points.length} corners`);
  for (const a of cornerAngles(reg.points)) {
    assert.ok(Math.abs(a - 90) < 0.5, `corner ${a.toFixed(2)}° not square`);
  }
  assert.equal(reg.kept, 0, "every wall of a rectangle should snap to frame");
});

test("regularizeRing frame estimate ignores a true 45° wing (two-pass θ)", () => {
  // Rectilinear body + one long diagonal wall. The diagonal must not
  // drag the frame: body corners stay exactly 90°, diagonal stays 45°.
  const ring: Pt[] = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 150 },
    { x: 120, y: 230 },
    { x: 0, y: 230 },
  ];
  const reg = regularizeRing(ring, 0.1);
  assert.equal(reg.changed, true, `expected change, got ${reg.reason}`);
  assert.equal(reg.points.length, 5, `got ${reg.points.length} corners`);
  const angles = cornerAngles(reg.points).map((a) => Math.round(a));
  const squares = angles.filter((a) => Math.abs(a - 90) < 1).length;
  const diags = angles.filter((a) => Math.abs(a - 45) < 1).length;
  assert.ok(
    squares === 3 && diags === 2,
    `expected 3×90° + 2×45°, got ${angles.join(",")}`,
  );
});

test("regularizeRing leaves a long genuinely-bent wall alone (gate)", () => {
  // Two 20 m arms meeting at 160° — architecture, not noise. The corner
  // turn (20°) is under cornerMinDeg? No: 180-160=20 < 28 → same-run fit
  // fails (bow ≈ 17 px) → runs split, bevel keeps the bend. Nothing
  // should snap this to one straight wall (drift gate).
  const ring: Pt[] = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 396, y: 35 }, // ~10° down-slope arm
    { x: 396, y: 300 },
    { x: 0, y: 300 },
  ];
  const reg = regularizeRing(ring, 0.1);
  // Whether gated or bevel-kept, the bend must survive within 1 m.
  const near = (x: number, y: number) =>
    reg.points.some((p) => Math.hypot(p.x - x, p.y - y) < 10);
  assert.ok(near(200, 0), "the real mid-wall bend vertex was erased");
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
/*  Attached-roof (porch) recovery                                     */
/* ------------------------------------------------------------------ */

function porchFixture() {
  const W = 300;
  const H = 300;
  const mpp = 0.1;
  // Main house 20×12 m; ground at 100 m; roof surface ~104.
  const mask = rectMask(W, H, [{ x: 60, y: 60, w: 200, h: 120 }]);
  const dsm = new Float32Array(W * H).fill(100);
  const rgb = new Uint8Array(W * H * 3);
  // Neutral gray everywhere.
  for (let i = 0; i < W * H; i++) {
    rgb[i * 3] = 120;
    rgb[i * 3 + 1] = 118;
    rgb[i * 3 + 2] = 115;
  }
  for (let y = 60; y < 180; y++) {
    for (let x = 60; x < 260; x++) dsm[y * W + x] = 104;
  }
  return { W, H, mpp, mask, dsm, rgb };
}

test("recoverAttachedRoofs picks up a porch the mask missed, skips trees and detached sheds", () => {
  const { W, H, mpp, mask, dsm, rgb } = porchFixture();
  // PORCH: 6×4 m smooth roof at 102.6 m, 0.4 m gap below the south wall.
  for (let y = 184; y < 224; y++) {
    for (let x = 100; x < 160; x++) dsm[y * W + x] = 102.6;
  }
  // TREE: elevated + smooth-ish center but GREEN, west of the house.
  for (let y = 80; y < 130; y++) {
    for (let x = 10; x < 50; x++) {
      dsm[y * W + x] = 103.5;
      const i = y * W + x;
      rgb[i * 3] = 60;
      rgb[i * 3 + 1] = 110;
      rgb[i * 3 + 2] = 55;
    }
  }
  // DETACHED SHED: smooth gray roof 3 m from the house (not adjacent).
  for (let y = 214; y < 254; y++) {
    for (let x = 200; x < 240; x++) dsm[y * W + x] = 102.8;
  }

  const traced = traceMaskFootprint(mask, W, H)!;
  const ground = estimateGroundHeightM({
    mask,
    dsm,
    dsmNoData: -9999,
    width: W,
    height: H,
    bbox: { minX: 60, minY: 60, maxX: 260, maxY: 180 },
    metersPerPixel: mpp,
  });
  assert.ok(ground != null && Math.abs(ground - 100) < 0.2, `ground=${ground}`);

  const rec = recoverAttachedRoofs({
    mask,
    componentMask: traced.componentMask,
    dsm,
    dsmNoData: -9999,
    rgb,
    width: W,
    height: H,
    metersPerPixel: mpp,
    groundHeightM: ground!,
  });
  assert.equal(rec.addedAreasM2.length, 1, `added: ${rec.addedAreasM2.join(",")}`);
  assert.ok(
    rec.addedAreasM2[0] >= 18 && rec.addedAreasM2[0] <= 26,
    `porch ≈ 24 m², got ${rec.addedAreasM2[0]}`,
  );
  // Porch pixels joined the mask; tree + shed pixels did not.
  assert.equal(rec.mask[200 * W + 130], 1, "porch recovered");
  assert.equal(rec.mask[100 * W + 30], 0, "tree rejected");
  assert.equal(rec.mask[230 * W + 220], 0, "detached shed rejected");
});

/* ------------------------------------------------------------------ */
/*  DSM drip-edge growth                                               */
/* ------------------------------------------------------------------ */

test("growRoofMask recovers the square jog the mask smoothed away", () => {
  const W = 300;
  const H = 300;
  const mpp = 0.1;
  // TRUE roof (DSM): L-shape — main 16×10 m plus a 6×4 m jog SE.
  const dsm = new Float32Array(W * H).fill(100);
  const roofAt = (x: number, y: number) =>
    (x >= 60 && x < 220 && y >= 60 && y < 160) ||
    (x >= 160 && x < 220 && y >= 160 && y < 200);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (roofAt(x, y)) dsm[y * W + x] = 104;
    }
  }
  // MASK: only the main rectangle — the jog was smoothed off.
  const mask = rectMask(W, H, [{ x: 60, y: 60, w: 160, h: 100 }]);
  const rgb = new Uint8Array(W * H * 3).fill(120);

  const grown = growRoofMask({
    mask,
    dsm,
    dsmNoData: -9999,
    rgb,
    width: W,
    height: H,
    metersPerPixel: mpp,
    groundHeightM: 100,
  });
  assert.ok(grown.grownPx > 1500, `grew ${grown.grownPx}px`);
  // Middle of the jog is now footprint; yard is not.
  assert.equal(grown.mask[180 * W + 190], 1, "jog recovered");
  assert.equal(grown.mask[180 * W + 100], 0, "yard untouched");
});

test("growRoofMask refuses runaway growth (bad ground estimate)", () => {
  const W = 200;
  const H = 200;
  // Everything reads "elevated": ground estimate way off.
  const dsm = new Float32Array(W * H).fill(104);
  const mask = rectMask(W, H, [{ x: 80, y: 80, w: 40, h: 40 }]);
  const rgb = new Uint8Array(W * H * 3).fill(120);
  const grown = growRoofMask({
    mask,
    dsm,
    dsmNoData: -9999,
    rgb,
    width: W,
    height: H,
    metersPerPixel: 0.1,
    groundHeightM: 100,
  });
  assert.equal(grown.grownPx, 0, "runaway growth must be rejected");
});

/* ------------------------------------------------------------------ */
/*  Interior tier edges                                                */
/* ------------------------------------------------------------------ */

test("findTierEdges traces the upper roof's drop line onto the lower roof", () => {
  const W = 300;
  const H = 200;
  const mpp = 0.1;
  const mask = rectMask(W, H, [{ x: 40, y: 40, w: 220, h: 120 }]);
  // Left half of the roof is 3 m higher — the drop line runs vertically
  // at x = 150.
  const dsm = new Float32Array(W * H).fill(100);
  for (let y = 40; y < 160; y++) {
    for (let x = 40; x < 260; x++) {
      dsm[y * W + x] = x < 150 ? 107 : 104;
    }
  }
  const edges = findTierEdges({
    mask,
    dsm,
    dsmNoData: -9999,
    width: W,
    height: H,
    metersPerPixel: mpp,
  });
  assert.equal(edges.length, 1, `found ${edges.length}`);
  const e = edges[0];
  // Vertical line near x=150 spanning most of the roof depth.
  assert.ok(Math.abs(e.a.x - 150) < 6 && Math.abs(e.b.x - 150) < 6, JSON.stringify(e));
  assert.ok(Math.abs(e.b.y - e.a.y) > 80, "spans the tier break");
});

test("findTierEdges ignores the outer perimeter and flat roofs", () => {
  const W = 200;
  const H = 200;
  const mask = rectMask(W, H, [{ x: 60, y: 60, w: 80, h: 80 }]);
  const dsm = new Float32Array(W * H).fill(100);
  for (let y = 60; y < 140; y++) {
    for (let x = 60; x < 140; x++) dsm[y * W + x] = 105;
  }
  const edges = findTierEdges({
    mask,
    dsm,
    dsmNoData: -9999,
    width: W,
    height: H,
    metersPerPixel: 0.1,
  });
  assert.equal(edges.length, 0);
});

/* ------------------------------------------------------------------ */
/*  Review regressions                                                 */
/* ------------------------------------------------------------------ */

test("gradual hip-transition between tiers stays an EAVE (case 0 must not fire)", () => {
  // 10 m wall: 1-story wing (104.3 m) and 2-story main (107 m) joined by
  // a gradual transition over the middle 4 m — flats at both ends. The
  // interior rises at EVERY station (unanimous eave votes). The looser
  // climb check flipped this to rake and silently under-billed ~33 LF.
  const mpp = 0.1;
  const a: Pt = { x: 20, y: 100 };
  const b: Pt = { x: 120, y: 100 };
  const nrm = { nx: 0, ny: -1 };
  const sample: DsmSampler = (x, y) => {
    const t = Math.max(0, Math.min(1, (x - 20) / 100));
    const base =
      t < 0.3 ? 104.3 : t > 0.7 ? 107.0 : 104.3 + ((t - 0.3) / 0.4) * 2.7;
    const depth = 100 - y;
    return base + Math.max(0, depth) * 0.03; // interior rises everywhere
  };
  const v = classifyEdgeByDsm(a, b, nrm, sample, mpp);
  assert.equal(v.kind, "eave", v.reason);
});

test("full continuous climb (gable-end drip line) is still a RAKE", () => {
  const mpp = 0.1;
  const a: Pt = { x: 20, y: 100 };
  const b: Pt = { x: 120, y: 100 };
  const nrm = { nx: 0, ny: -1 };
  // Climbs the whole run: 10 m at ~28% slope; interior also rises (the
  // votes would say eave — exactly the case the climb check exists for).
  const sample: DsmSampler = (x, y) => {
    const base = 104 + ((x - 20) / 100) * 2.8;
    const depth = 100 - y;
    return base + Math.max(0, depth) * 0.04;
  };
  const v = classifyEdgeByDsm(a, b, nrm, sample, mpp);
  assert.equal(v.kind, "rake", v.reason);
});

test("inwardNormalForRing points INTO a concave (U-shaped) ring where the centroid lies outside", () => {
  // U-shape: two 30-wide arms around a 40-wide courtyard.
  const U: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 80 },
    { x: 70, y: 80 },
    { x: 70, y: 30 },
    { x: 30, y: 30 },
    { x: 30, y: 80 },
    { x: 0, y: 80 },
  ];
  // Edge on the RIGHT arm's inner (courtyard) side: (70,80)→(70,30).
  const n = inwardNormalForRing({ x: 70, y: 80 }, { x: 70, y: 30 }, U, 3);
  // Interior of the right arm is at x > 70 → inward normal must point +x.
  assert.ok(n.nx > 0.9, `normal points ${n.nx},${n.ny} — expected +x into the arm`);
});

test("distToPolyline measures segment distance without a phantom closing edge", () => {
  const chain: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  assert.ok(Math.abs(distToPolyline({ x: 50, y: 5 }, chain) - 5) < 1e-9);
  // distToRing on the same points would wrap 100,0 → 0,0 (same segment
  // here) — the polyline version must handle midpoints of long straight
  // runs, which the vertex-only test missed.
  assert.ok(distToPolyline({ x: 50, y: 0 }, chain) < 1e-9);
});

/* ------------------------------------------------------------------ */
/*  Tier decomposition                                                 */
/* ------------------------------------------------------------------ */

test("tierRegionRings splits a two-tier roof into two clean rings", () => {
  const W = 300;
  const H = 200;
  const mpp = 0.1;
  const mask = rectMask(W, H, [{ x: 40, y: 40, w: 220, h: 120 }]);
  const dsm = new Float32Array(W * H).fill(100);
  for (let y = 40; y < 160; y++) {
    for (let x = 40; x < 260; x++) {
      dsm[y * W + x] = x < 150 ? 107 : 104; // upper tier on the left
    }
  }
  const regions = tierRegionRings({
    mask,
    dsm,
    dsmNoData: -9999,
    width: W,
    height: H,
    metersPerPixel: mpp,
  });
  assert.equal(regions.length, 2, `got ${regions.length} regions`);
  // The upper region's ring has an edge along x≈150 far from the outer
  // ring — the interior drip line the engine prices.
  const outer = [
    { x: 40, y: 40 },
    { x: 260, y: 40 },
    { x: 260, y: 160 },
    { x: 40, y: 160 },
  ];
  const interiorEdges = regions.flatMap((r) =>
    r.ring
      .map((a, i) => {
        const b = r.ring[(i + 1) % r.ring.length];
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      })
      .filter((m) => distToRing(m, outer) > 9),
  );
  assert.ok(interiorEdges.length >= 1, "found an interior tier edge");
  for (const m of interiorEdges) {
    assert.ok(Math.abs(m.x - 150) < 8, `interior edge at x=${m.x}, want ≈150`);
  }
});

/* ------------------------------------------------------------------ */
/*  Per-edge photo snapping                                            */
/* ------------------------------------------------------------------ */

test("refineEdgesToPhoto slides one offset wall onto the photo edge and keeps corners square", () => {
  const W = 300;
  const H = 200;
  const mpp = 0.1;
  // Photo: bright roof rectangle 80..220 × 50..140.
  const rgb = new Uint8Array(W * H * 3).fill(60);
  for (let y = 50; y <= 140; y++) {
    for (let x = 80; x <= 220; x++) {
      const i = (y * W + x) * 3;
      rgb[i] = 170;
      rgb[i + 1] = 165;
      rgb[i + 2] = 160;
    }
  }
  const mask = rectMask(W, H, [{ x: 80, y: 50, w: 140, h: 90 }]);
  // Ring: correct except the WEST wall sits 6 px too far west.
  const ring: Pt[] = [
    { x: 74, y: 50 },
    { x: 220, y: 50 },
    { x: 220, y: 140 },
    { x: 74, y: 140 },
  ];
  const r = refineEdgesToPhoto({
    ring,
    rgb,
    mask,
    width: W,
    height: H,
    metersPerPixel: mpp,
  });
  assert.ok(r.refined >= 1, "refined the west wall");
  const westXs = r.ring.filter((p) => p.x < 150).map((p) => p.x);
  for (const x of westXs) {
    assert.ok(Math.abs(x - 80) <= 2, `west wall at ${x}, expected ≈80`);
  }
  // Corners stay square: every vertex y is ≈50 or ≈140.
  for (const p of r.ring) {
    assert.ok(
      Math.abs(p.y - 50) <= 2 || Math.abs(p.y - 140) <= 2,
      `corner drifted: ${JSON.stringify(p)}`,
    );
  }
});

test("refineEdgesToPhoto offRoof veto keeps a wall off the walkway edge", () => {
  const W = 300;
  const H = 200;
  const mpp = 0.1;
  // Roof 80..220 × 50..140 (lum 170); concrete WALKWAY strip 71..79
  // (lum 165 — within the roof-tone window, so tone can't save us);
  // lawn (lum 60) beyond. The strongest photo edge is walkway/lawn.
  const rgb = new Uint8Array(W * H * 3).fill(60);
  const paint = (x0: number, x1: number, l: number) => {
    for (let y = 40; y <= 150; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) * 3;
        rgb[i] = l;
        rgb[i + 1] = l - 5;
        rgb[i + 2] = l - 10;
      }
    }
  };
  paint(80, 220, 170);
  paint(71, 79, 165);
  const mask = rectMask(W, H, [{ x: 80, y: 50, w: 140, h: 90 }]);
  // DSM: roof at 5 m, everything else ground (0 m).
  const dsm = new Float32Array(W * H).fill(0);
  for (let y = 50; y <= 140; y++) {
    for (let x = 80; x <= 220; x++) dsm[y * W + x] = 5;
  }
  const ring: Pt[] = [
    { x: 80, y: 50 },
    { x: 220, y: 50 },
    { x: 220, y: 140 },
    { x: 80, y: 140 },
  ];
  const offRoof = (x: number, y: number): boolean => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return false;
    return dsm[yi * W + xi] < 1.2;
  };
  const r = refineEdgesToPhoto({
    ring,
    rgb,
    mask,
    width: W,
    height: H,
    metersPerPixel: mpp,
    offRoof,
  });
  // Without the veto the west wall chases the walkway/lawn gradient out
  // to ≈71; with it the wall must stay on the roof edge.
  const westXs = r.ring.filter((p) => p.x < 150).map((p) => p.x);
  for (const x of westXs) {
    assert.ok(x >= 78, `west wall slid onto the walkway: x=${x.toFixed(1)}`);
  }
});

/* ------------------------------------------------------------------ */
/*  Roof-plane mask trim                                               */
/* ------------------------------------------------------------------ */

test("trimMaskToRoofPlanes cuts canopy/lawn inside the padded shell, keeps roof + dormer", () => {
  const W = 260;
  const H = 200;
  const mpp = 0.1;
  const noData = -9999;
  // Simple west-facing plane: core bbox 60..160 × 60..140, center
  // (110,100), h(center)=5, pitch 20°, downhill = -x (faces west).
  const seg = {
    cx: 110,
    cy: 100,
    hCenterM: 5,
    pitchDeg: 20,
    downhill: { x: -1, y: 0 },
    x0: 60,
    y0: 60,
    x1: 160,
    y1: 140,
  };
  const slope = Math.tan((20 * Math.PI) / 180);
  const dsm = new Float32Array(W * H).fill(0.2); // ground everywhere
  const planeH = (x: number) => 5 - slope * (x - 110) * -1 * mpp;
  // Mask: the true roof + a canopy bulge and a lawn bulge in the shell
  // (161..175 is inside the 2 m padded box, outside the core).
  const mask = new Uint8Array(W * H);
  for (let y = 60; y <= 140; y++) {
    for (let x = 60; x <= 160; x++) {
      mask[y * W + x] = 1;
      dsm[y * W + x] = planeH(x);
    }
  }
  // Dormer bump INSIDE the core: +2 m off the plane — must survive.
  for (let y = 95; y <= 105; y++) {
    for (let x = 100; x <= 112; x++) dsm[y * W + x] = planeH(x) + 2;
  }
  // Canopy blob in the shell: mask says building, DSM says treetop.
  for (let y = 70; y <= 95; y++) {
    for (let x = 161; x <= 175; x++) {
      mask[y * W + x] = 1;
      dsm[y * W + x] = 9;
    }
  }
  // Lawn blob in the shell: mask says building, DSM says grass.
  for (let y = 110; y <= 130; y++) {
    for (let x = 161; x <= 175; x++) {
      mask[y * W + x] = 1;
      dsm[y * W + x] = 0.2;
    }
  }
  // Real eave overhang in the shell: ON the plane — must survive.
  for (let y = 60; y <= 140; y++) {
    for (let x = 55; x <= 59; x++) {
      mask[y * W + x] = 1;
      dsm[y * W + x] = planeH(x);
    }
  }
  // Far blob outside every padded box → AABB layer cuts it.
  for (let y = 20; y <= 30; y++) {
    for (let x = 20; x <= 30; x++) mask[y * W + x] = 1;
  }
  const out = trimMaskToRoofPlanes({
    mask,
    dsm,
    dsmNoData: noData,
    width: W,
    height: H,
    metersPerPixel: mpp,
    segs: [seg],
  });
  const at = (x: number, y: number) => out.mask[y * W + x];
  assert.equal(at(80, 100), 1, "core roof trimmed");
  assert.equal(at(57, 100), 1, "real eave overhang on the plane trimmed");
  assert.equal(at(168, 80), 0, "canopy blob survived the plane veto");
  assert.equal(at(168, 120), 0, "lawn blob survived the plane veto");
  assert.equal(at(25, 25), 0, "far blob survived the AABB layer");
  assert.ok(out.cutPlanePx > 0 && out.cutOutsidePx > 0, "both counters move");
  // The dormer deviates from the plane and gets holed — but interior
  // holes must NOT damage the outer boundary the footprint trace uses.
  assert.equal(at(106, 100), 0, "dormer px holed (interior, harmless)");
  const traced = traceMaskFootprint(out.mask, W, H);
  assert.ok(traced, "trimmed mask still traces");
  for (const p of traced.boundary) {
    assert.ok(
      p.x >= 54 && p.x <= 161 && p.y >= 59 && p.y <= 141,
      `boundary escaped the true roof: ${JSON.stringify(p)}`,
    );
  }
  const bxs = traced.boundary.map((p) => p.x);
  assert.ok(Math.max(...bxs) >= 159 && Math.min(...bxs) <= 56, "roof extent lost");
  // allowMask is the padded shell (growth cap).
  assert.equal(out.allowMask[100 * W + 165], 1);
  assert.equal(out.allowMask[25 * W + 25], 0);
});

test("refineEdgesToPhoto caps OUTWARD slides (cast-shadow edge can't drag the wall out)", () => {
  const W = 300;
  const H = 200;
  const mpp = 0.1;
  // Roof 80..220 (lum 170); same-tone strip 74..79 (the roof's cast
  // shadow / walkway); dark beyond. Strongest gradient sits 6–7 px
  // OUTSIDE the true edge — within the old ±9 slide range, beyond the
  // new 0.35 m outward cap.
  const rgb = new Uint8Array(W * H * 3).fill(60);
  const paint = (x0: number, x1: number, l: number) => {
    for (let y = 40; y <= 150; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) * 3;
        rgb[i] = l;
        rgb[i + 1] = l - 5;
        rgb[i + 2] = l - 10;
      }
    }
  };
  paint(80, 220, 170);
  paint(74, 79, 165);
  const mask = rectMask(W, H, [{ x: 80, y: 50, w: 140, h: 90 }]);
  const ring: Pt[] = [
    { x: 80, y: 50 },
    { x: 220, y: 50 },
    { x: 220, y: 140 },
    { x: 80, y: 140 },
  ];
  const r = refineEdgesToPhoto({
    ring,
    rgb,
    mask,
    width: W,
    height: H,
    metersPerPixel: mpp,
  });
  const westXs = r.ring.filter((p) => p.x < 150).map((p) => p.x);
  for (const x of westXs) {
    assert.ok(x >= 76, `west wall chased the shadow edge out to x=${x.toFixed(1)}`);
  }
});

test("dechamferPolygon squares a TWO-edge rounded arc corner", () => {
  const mpp = 0.1;
  // Rounded top-right corner: two short edges (three vertices) where the
  // real roof has one 90° corner near (139, 20).
  const pts: Pt[] = [
    { x: 20, y: 20 },
    { x: 124, y: 20 },
    { x: 133, y: 23 },
    { x: 139, y: 31 },
    { x: 140, y: 100 },
    { x: 20, y: 100 },
  ];
  const out = dechamferPolygon(pts, mpp);
  assert.ok(out.squared >= 1, "arc was not squared");
  assert.ok(
    out.points.some((p) => Math.hypot(p.x - 139, p.y - 20) < 3),
    `no square corner near (139,20): ${JSON.stringify(out.points)}`,
  );
  assert.ok(
    !out.points.some((p) => Math.hypot(p.x - 133, p.y - 23) < 1),
    "arc midpoint survived",
  );
});

/* ------------------------------------------------------------------ */
/*  De-chamfer                                                         */
/* ------------------------------------------------------------------ */

test("dechamferPolygon squares a mask-rounded corner cut", () => {
  // 12 m × 8 m rectangle whose top-right corner is chamfered by a 1.4 m
  // diagonal (the classic DP leftover of a rounded mask corner).
  const mpp = 0.1;
  const pts: Pt[] = [
    { x: 20, y: 20 },
    { x: 130, y: 20 }, // chamfer start
    { x: 140, y: 30 }, // chamfer end (≈1.4 m cut)
    { x: 140, y: 100 },
    { x: 20, y: 100 },
  ];
  const r = dechamferPolygon(pts, mpp);
  assert.equal(r.squared, 1);
  assert.equal(r.points.length, 4);
  // The squared corner is the neighbors' intersection: (140, 20).
  assert.ok(
    r.points.some((p) => Math.abs(p.x - 140) < 0.01 && Math.abs(p.y - 20) < 0.01),
    `corner not squared: ${JSON.stringify(r.points)}`,
  );
});

test("dechamferPolygon leaves a genuine 45° wing alone", () => {
  const mpp = 0.1;
  // Rectangle with a LONG diagonal wall (6 m — a real angled wing).
  const pts: Pt[] = [
    { x: 20, y: 20 },
    { x: 100, y: 20 },
    { x: 160, y: 80 }, // 6 m diagonal — architecture, not a chamfer
    { x: 160, y: 140 },
    { x: 20, y: 140 },
  ];
  const r = dechamferPolygon(pts, mpp);
  assert.equal(r.squared, 0);
  assert.equal(r.points.length, 5);
});

test("dechamferPolygon squares a chamfer sitting across the ring seam", () => {
  const mpp = 0.1;
  // Same rectangle+chamfer, rotated so the chamfer spans indices n-1 → 0.
  const pts: Pt[] = [
    { x: 140, y: 30 }, // chamfer end (index 0)
    { x: 140, y: 100 },
    { x: 20, y: 100 },
    { x: 20, y: 20 },
    { x: 130, y: 20 }, // chamfer start (index n-1)
  ];
  const r = dechamferPolygon(pts, mpp);
  assert.equal(r.squared, 1);
  assert.equal(r.points.length, 4);
});

test("porch recovery height band excludes ground-level decks", () => {
  const { W, H, mpp, mask, dsm, rgb } = porchFixture();
  // Unroofed DECK: smooth wood surface 0.4 m above grade, hugging the
  // south wall. Below the 1.8 m roof-height floor → must not be added.
  for (let y = 184; y < 224; y++) {
    for (let x = 100; x < 160; x++) dsm[y * W + x] = 100.4;
  }
  const traced = traceMaskFootprint(mask, W, H)!;
  const rec = recoverAttachedRoofs({
    mask,
    componentMask: traced.componentMask,
    dsm,
    dsmNoData: -9999,
    rgb,
    width: W,
    height: H,
    metersPerPixel: mpp,
    groundHeightM: 100,
  });
  assert.equal(rec.addedAreasM2.length, 0, "deck must not be recovered");
});

/* ------------------------------------------------------------------ */
/*  Photo-lean registration                                            */
/* ------------------------------------------------------------------ */

function leanFixture() {
  const W = 300;
  const H = 200;
  const mpp = 0.1;
  // True-position ring + mask (what Google's data says).
  const ring = [
    { x: 80, y: 50 },
    { x: 220, y: 50 },
    { x: 220, y: 140 },
    { x: 80, y: 140 },
  ];
  const mask = rectMask(W, H, [{ x: 80, y: 50, w: 140, h: 90 }]);
  // Photo: the roof rectangle rendered LEANING +7 px east, +5 px south.
  const rgb = new Uint8Array(W * H * 3).fill(60);
  for (let y = 55; y <= 145; y++) {
    for (let x = 87; x <= 227; x++) {
      const i = (y * W + x) * 3;
      rgb[i] = 170;
      rgb[i + 1] = 165;
      rgb[i + 2] = 160;
    }
  }
  return { W, H, mpp, ring, mask, rgb };
}

test("estimateRenderShift finds the photo's roof displaced from true position", () => {
  const { W, H, mpp, ring, mask, rgb } = leanFixture();
  const s = estimateRenderShift({ rgb, width: W, height: H, ring, mask, metersPerPixel: mpp });
  assert.ok(Math.abs(s.dx - 7) <= 1 && Math.abs(s.dy - 5) <= 1, `got ${s.dx},${s.dy}`);
});

test("estimateRenderShift ignores a bright sidewalk border stronger than the roofline", () => {
  const { W, H, mpp, ring, mask, rgb } = leanFixture();
  // Bright concrete walkway strip 1.2 m west of the true wall — a much
  // stronger luminance edge than roof-vs-ground, but PAVEMENT inside.
  for (let y = 40; y <= 150; y++) {
    for (let x = 60; x <= 68; x++) {
      const i = (y * W + x) * 3;
      rgb[i] = 235;
      rgb[i + 1] = 235;
      rgb[i + 2] = 230;
    }
  }
  const s = estimateRenderShift({ rgb, width: W, height: H, ring, mask, metersPerPixel: mpp });
  // Must still lock onto the ROOF's lean (+7,+5), not slide west to the
  // walkway edge (negative dx).
  assert.ok(s.dx >= 0, `slid onto the sidewalk: dx=${s.dx}`);
  assert.ok(Math.abs(s.dx - 7) <= 2 && Math.abs(s.dy - 5) <= 2, `got ${s.dx},${s.dy}`);
});

test("estimateRenderShift stays put on a featureless photo", () => {
  const W = 200;
  const H = 140;
  const rgb = new Uint8Array(W * H * 3).fill(90);
  const ring = [
    { x: 50, y: 40 },
    { x: 150, y: 40 },
    { x: 150, y: 100 },
    { x: 50, y: 100 },
  ];
  const mask = rectMask(W, H, [{ x: 50, y: 40, w: 100, h: 60 }]);
  const s = estimateRenderShift({ rgb, width: W, height: H, ring, mask, metersPerPixel: 0.1 });
  assert.deepEqual(s, { dx: 0, dy: 0 });
});

/* ------------------------------------------------------------------ */
/*  Aspect window                                                      */
/* ------------------------------------------------------------------ */

test("expandWindowToAspect widens a tall window to the canvas aspect", () => {
  const win = expandWindowToAspect(
    { x: 400, y: 300, width: 200, height: 300 },
    900 / 580,
    1000,
    1000,
  );
  assert.ok(Math.abs(win.width / win.height - 900 / 580) < 0.02, `${win.width}×${win.height}`);
  // Original window stays inside the expanded one.
  assert.ok(win.x <= 400 && win.x + win.width >= 600);
  assert.ok(win.y <= 300 && win.y + win.height >= 600);
  assert.ok(win.x >= 0 && win.y >= 0 && win.x + win.width <= 1000 && win.y + win.height <= 1000);
});

test("expandWindowToAspect clamps at the raster edge without losing the subject", () => {
  const win = expandWindowToAspect(
    { x: 0, y: 0, width: 180, height: 300 },
    900 / 580,
    500,
    320,
  );
  assert.ok(win.x >= 0 && win.y >= 0);
  assert.ok(win.x + win.width <= 500 && win.y + win.height <= 320);
  // Still contains the original subject horizontally.
  assert.ok(win.x <= 0 + 1 && win.x + win.width >= 180);
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

test("trimChainEndOvershoot: end past a run pulls back to the intersection", async () => {
  const { trimChainEndOvershoot } = await import("./solar-geometry.ts");
  // Vertical chain overshooting 4px past a horizontal run at y=50.
  const chain = [{ x: 20, y: 10 }, { x: 20, y: 54 }];
  const runs = [{ a: { x: 0, y: 50 }, b: { x: 100, y: 50 } }];
  const out = trimChainEndOvershoot(chain, runs, 8);
  assert.ok(Math.abs(out[1].y - 50) < 1e-6, `end y=${out[1].y}, want 50`);
  assert.equal(out[1].x, 20);
  assert.deepEqual(out[0], { x: 20, y: 10 }); // other end untouched
});

test("trimChainEndOvershoot: big mid-chain crossing is NOT trimmed", async () => {
  const { trimChainEndOvershoot } = await import("./solar-geometry.ts");
  // Chain crosses the run 30px before its end — beyond maxTrim, keep as-is.
  const chain = [{ x: 20, y: 10 }, { x: 20, y: 80 }];
  const runs = [{ a: { x: 0, y: 50 }, b: { x: 100, y: 50 } }];
  const out = trimChainEndOvershoot(chain, runs, 8);
  assert.deepEqual(out[1], { x: 20, y: 80 });
});

test("trimChainEndOvershoot: trims BOTH ends independently", async () => {
  const { trimChainEndOvershoot } = await import("./solar-geometry.ts");
  const chain = [{ x: 20, y: 46 }, { x: 20, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 47 }];
  const runs = [{ a: { x: 0, y: 44 }, b: { x: 100, y: 44 } }];
  const out = trimChainEndOvershoot(chain, runs, 8);
  assert.ok(Math.abs(out[0].y - 44) < 1e-6);
  assert.ok(Math.abs(out[out.length - 1].y - 44) < 1e-6);
});

test("trimChainEndOvershoot: no crossing → untouched; degenerate safe", async () => {
  const { trimChainEndOvershoot } = await import("./solar-geometry.ts");
  const chain = [{ x: 20, y: 10 }, { x: 20, y: 40 }];
  const runs = [{ a: { x: 0, y: 50 }, b: { x: 100, y: 50 } }];
  assert.deepEqual(trimChainEndOvershoot(chain, runs, 8), chain);
  assert.deepEqual(trimChainEndOvershoot([{ x: 1, y: 1 }], runs, 8), [{ x: 1, y: 1 }]);
});

test("collapseTaperWedges: step + long taper collapses to the wall chord", async () => {
  const { collapseTaperWedges } = await import("./solar-geometry.ts");
  // Sarasota shape: wall (272,139)->(403,143), step up to (404,125),
  // taper down to (634,146), then the rest of a plausible ring (CW in
  // screen coords = negative area; matches the traced winding).
  const ring = [
    { x: 266, y: 334 },
    { x: 272, y: 139 },
    { x: 403, y: 143 },
    { x: 404, y: 125 },
    { x: 634, y: 146 },
    { x: 630, y: 287 },
    { x: 627, y: 472 },
    { x: 483, y: 467 },
    { x: 487, y: 341 },
  ];
  const out = collapseTaperWedges(ring, 0.1);
  assert.equal(out.collapsed, 1);
  assert.equal(out.points.length, ring.length - 2);
  assert.ok(!out.points.some((p) => p.x === 404 && p.y === 125), "apex still present");
  assert.ok(!out.points.some((p) => p.x === 403 && p.y === 143), "step base still present");
});

test("collapseTaperWedges: mirrored winding (taper first) also collapses", async () => {
  const { collapseTaperWedges } = await import("./solar-geometry.ts");
  const ring = [
    { x: 266, y: 334 },
    { x: 272, y: 139 },
    { x: 403, y: 143 },
    { x: 404, y: 125 },
    { x: 634, y: 146 },
    { x: 630, y: 287 },
    { x: 627, y: 472 },
    { x: 483, y: 467 },
    { x: 487, y: 341 },
  ].reverse();
  const out = collapseTaperWedges(ring, 0.1);
  assert.equal(out.collapsed, 1);
});

test("collapseTaperWedges: a REAL bump-out (step out, parallel run, step back) is kept", async () => {
  const { collapseTaperWedges } = await import("./solar-geometry.ts");
  // Clerestory-style bump: steps out 1.5m, runs PARALLEL to the wall,
  // steps back — the long middle edge lands ~15px off the wall line at
  // its far end (not ≤6px), so it must survive.
  const ring = [
    { x: 0, y: 200 },
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: -15 },
    { x: 200, y: -15 },
    { x: 200, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 200 },
  ];
  const out = collapseTaperWedges(ring, 0.1);
  assert.equal(out.collapsed, 0);
  assert.equal(out.points.length, ring.length);
});

test("collapseTaperWedges: INWARD taper notch is never collapsed (would add roof)", async () => {
  const { collapseTaperWedges } = await import("./solar-geometry.ts");
  const ring = [
    { x: 266, y: 334 },
    { x: 272, y: 139 },
    { x: 403, y: 143 },
    { x: 404, y: 161 }, // step INWARD (down into the roof)
    { x: 634, y: 146 },
    { x: 630, y: 287 },
    { x: 627, y: 472 },
    { x: 483, y: 467 },
    { x: 487, y: 341 },
  ];
  const out = collapseTaperWedges(ring, 0.1);
  assert.equal(out.collapsed, 0);
});

test("convexCornersOf: returns OUTSIDE corners for both windings", async () => {
  const { convexCornersOf } = await import("./geometry.ts");
  // L-shape, visually clockwise in y-down coords. 5 convex + 1 reflex.
  const L = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
    { x: 100, y: 100 },
    { x: 100, y: 200 },
    { x: 0, y: 200 },
  ];
  for (const ring of [L, [...L].reverse()]) {
    const corners = convexCornersOf(
      { points: ring, bbox: { x: 0, y: 0, width: 200, height: 200 }, areaFraction: 0.1 },
      900,
      580,
    );
    assert.equal(corners.length, 5, `got ${corners.length} corners`);
    // The reflex inner-L corner must NOT be in the list.
    assert.ok(
      !corners.some((c) => Math.hypot(c.x - 100, c.y - 100) < 30),
      "reflex corner returned",
    );
  }
});
