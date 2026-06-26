import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readRoofFromVectors,
  classifyGableLabel,
  type RoofLabel,
} from "./roof-from-vectors.ts";
import type { Pt } from "./outline-from-vectors.ts";

/** Wall/roof-edge segments for a closed rectilinear ring (consecutive corners). */
function ring(corners: [number, number][]): number[][] {
  const segs: number[][] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    segs.push([a[0], a[1], b[0], b[1]]);
  }
  return segs;
}

/** A cross-gabled / L ring with > 4 corners (a real footprint, not a box). */
const L_CORNERS: [number, number][] = [
  [0, 0],
  [600, 0],
  [600, 200],
  [350, 200],
  [350, 400],
  [0, 400],
];

function bboxOf(poly: Pt[]) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

/** Find the perimeter edge index whose endpoints best match a target edge. */
function edgeNear(perimeter: Pt[], aTgt: Pt, bTgt: Pt): number {
  let best = -1;
  let bestD = Infinity;
  const n = perimeter.length;
  for (let i = 0; i < n; i++) {
    const a = perimeter[i];
    const b = perimeter[(i + 1) % n];
    const dFwd = Math.hypot(a.x - aTgt.x, a.y - aTgt.y) + Math.hypot(b.x - bTgt.x, b.y - bTgt.y);
    const dRev = Math.hypot(a.x - bTgt.x, a.y - bTgt.y) + Math.hypot(b.x - aTgt.x, b.y - aTgt.y);
    const d = Math.min(dFwd, dRev);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

test("truss-noise survival: heavy ring survives sparse interior truss strokes", () => {
  const roof = ring(L_CORNERS);
  const trusses: number[][] = [
    [120, 120, 140, 120],
    [260, 120, 280, 120],
    [120, 300, 140, 300],
    [200, 320, 220, 320],
  ];
  const out = readRoofFromVectors([], [...roof, ...trusses]);
  assert.ok(out, "got a roof read despite truss noise");
  assert.ok(out!.perimeter.length > 4, `keeps the L's articulation (${out!.perimeter.length} corners)`);
  const bb = bboxOf(out!.perimeter);
  const cell = 600 / 200;
  assert.ok(Math.abs(bb.x1 - bb.x0 - 600) < cell * 8, "bbox width tracks the ring");
  assert.ok(Math.abs(bb.y1 - bb.y0 - 400) < cell * 8, "bbox depth tracks the ring");
  assert.ok(out!.gableFlags.every((g) => g === false), "no labels → no gables");
  assert.ok(out!.confidence > 0, "confidence still positive");
});

test("gable label flags the RIGHT edge only", () => {
  const roof = ring(L_CORNERS);
  const labels: RoofLabel[] = [{ s: "GABLE END TRUSS", x: 300, y: 360 }];
  const out = readRoofFromVectors(labels, roof);
  assert.ok(out, "got a roof read");
  const frontIdx = edgeNear(out!.perimeter, { x: 0, y: 400 }, { x: 600, y: 400 });
  assert.ok(frontIdx >= 0, "found the front edge");
  assert.equal(out!.gableFlags[frontIdx], true, "front edge flagged gable");
  const others = out!.gableFlags.filter((_, i) => i !== frontIdx);
  assert.ok(others.every((g) => g === false), "no other edge flagged");
});

test("label between two PARALLEL walls flags ONLY the nearer one (best-edge)", () => {
  const roof = ring([
    [0, 0],
    [220, 0],
    [220, -150],
    [380, -150],
    [380, 0],
    [600, 0],
    [600, 400],
    [0, 400],
  ]);
  const labels: RoofLabel[] = [{ s: "GABLE END", x: 300, y: 360 }];
  const out = readRoofFromVectors(labels, roof);
  assert.ok(out, "got a roof read");
  const frontIdx = edgeNear(out!.perimeter, { x: 0, y: 400 }, { x: 600, y: 400 });
  const backIdx = edgeNear(out!.perimeter, { x: 380, y: 0 }, { x: 600, y: 0 });
  assert.equal(out!.gableFlags[frontIdx], true, "front (nearer) edge flagged");
  assert.equal(out!.gableFlags[backIdx], false, "back (far) parallel wall NOT flagged");
  const flagged = out!.gableFlags.filter((g) => g).length;
  assert.equal(flagged, 1, "exactly one edge flagged — one label cannot flag two walls");
});

test("stray label far inside (beyond the inward band) flags NO edge", () => {
  const roof = ring(L_CORNERS);
  const labels: RoofLabel[] = [{ s: "GABLE END TRUSS", x: 175, y: 200 }];
  const out = readRoofFromVectors(labels, roof);
  assert.ok(out, "got a roof read");
  assert.ok(out!.gableFlags.every((g) => g === false), "no edge flagged for a stray label");
  assert.ok(out!.confidence > 0, "confidence still positive (marker present)");
});

test("a GABLE label OUTSIDE the outline (below the eave) flags NO edge", () => {
  // The symmetric-band bug: a 'GABLE' note printed a truss-depth BELOW the front
  // eave (outside the building) must NOT flag that eave. point-in-polygon fixes it.
  const roof = ring(L_CORNERS);
  const labels: RoofLabel[] = [{ s: "GABLE END TRUSS", x: 300, y: 450 }]; // y>400 = outside
  const out = readRoofFromVectors(labels, roof);
  assert.ok(out, "got a roof read");
  assert.ok(out!.gableFlags.every((g) => g === false), "outside label flags nothing");
});

test("open / broken outline → null (fallback)", () => {
  const broken = [
    [0, 0, 600, 0],
    [600, 0, 600, 400],
  ];
  assert.equal(readRoofFromVectors([], broken), null);
  assert.equal(
    readRoofFromVectors([], [
      [0, 0, 10, 0],
      [100, 100, 110, 100],
      [200, 200, 210, 200],
      [300, 300, 310, 300],
    ]),
    null,
  );
});

test("plain rectangle → null (<=4 corners, no better than today)", () => {
  const box = ring([
    [0, 0],
    [640, 0],
    [640, 520],
    [0, 520],
  ]);
  assert.equal(readRoofFromVectors([], box), null);
});

test("ANTI-JUNK: a wide ribbon (aspect > 4) → null even with > 4 corners", () => {
  // A truss-blob the floodfill happened to enclose as a long thin ribbon.
  const ribbon = ring([
    [0, 0],
    [1200, 0],
    [1200, 200],
    [800, 200],
    [800, 100],
    [0, 100],
  ]); // bbox 1200×200 → aspect 6
  assert.equal(readRoofFromVectors([], ribbon), null);
});

test("ANTI-JUNK: expectedAspect rejects a shape too different from the footprint", () => {
  // aspect-3 articulated shape: passes the no-reference guard (3 < 4)…
  const wide = ring([
    [0, 0],
    [900, 0],
    [900, 300],
    [600, 300],
    [600, 150],
    [0, 150],
  ]); // bbox 900×300 → aspect 3
  assert.ok(readRoofFromVectors([], wide), "accepted without a reference aspect");
  // …but is rejected when the known footprint is ~square (64×51 ≈ 1.25).
  assert.equal(readRoofFromVectors([], wide, { expectedAspect: 64 / 51 }), null);
});

test("garbage / empty / thin-only input → null, never throws", () => {
  assert.equal(readRoofFromVectors([], []), null);
  assert.equal(readRoofFromVectors([], [[0, 0, 10, 0]]), null);
  assert.equal(
    readRoofFromVectors([], [
      [NaN, NaN, NaN, NaN],
      [NaN, 0, 0, NaN],
      [0, 0, NaN, 0],
      [NaN, NaN, 0, 0],
    ]),
    null,
  );
  assert.doesNotThrow(() =>
    readRoofFromVectors(undefined as unknown as RoofLabel[], []),
  );
});

test("classifyGableLabel keyword pinning", () => {
  assert.equal(classifyGableLabel("GABLE END TRUSS"), true);
  assert.equal(classifyGableLabel("STRUCT. GABLE END TRUSS"), true);
  assert.equal(classifyGableLabel("GABLE"), true);
  assert.equal(classifyGableLabel("gable end"), true);
  assert.equal(classifyGableLabel("RIDGE"), false);
  assert.equal(classifyGableLabel("MAIN VALLEY"), false);
  assert.equal(classifyGableLabel("VALLEY"), false);
  assert.equal(classifyGableLabel("HIP"), false);
  assert.equal(classifyGableLabel("GIRDER TRUSS"), false);
  assert.equal(classifyGableLabel("COMMON TRUSS"), false);
  assert.equal(classifyGableLabel("SCISSOR TRUSS"), false);
});
