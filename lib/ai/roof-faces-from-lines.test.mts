import { test } from "node:test";
import assert from "node:assert/strict";
import { facesFromRoofLines } from "./roof-faces-from-lines.ts";

type Pt = { x: number; y: number };

const polyArea = (poly: readonly Pt[]): number => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
};

const totalArea = (faces: { polygon: Pt[] }[]): number =>
  faces.reduce((s, f) => s + polyArea(f.polygon), 0);

// 400×200 rectangle, y down (PDF pt space).
const RECT = [
  { x: 0, y: 0 },
  { x: 400, y: 0 },
  { x: 400, y: 200 },
  { x: 0, y: 200 },
];

test("faces: rect + wall-to-wall ridge = 2 planes draining to opposite eaves", () => {
  const faces = facesFromRoofLines(RECT, [
    { p1: { x: 0, y: 100 }, p2: { x: 400, y: 100 } },
  ]);
  assert.ok(faces, "arrangement validates");
  assert.equal(faces.length, 2);
  assert.ok(Math.abs(totalArea(faces) - 80000) < 80, "full tiling");
  // One plane drains up (toward y=0), the other down (toward y=200).
  const dys = faces.map((f) => Math.sign(f.downhill.y)).sort();
  assert.deepEqual(dys, [-1, 1]);
  for (const f of faces) {
    assert.ok(Math.abs(Math.hypot(f.downhill.x, f.downhill.y) - 1) < 1e-6, "unit downhill");
  }
});

test("faces: Woodinville-like 16-corner outline + ridge/valley net tiles 100%", () => {
  // Articulated 16-corner rectilinear outline: front bump (the entry), an
  // L-stepped right side, rear jogs — the shape class the straight skeleton
  // degenerates on.
  const OUT = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: -60 },
    { x: 320, y: -60 },
    { x: 320, y: 0 },
    { x: 640, y: 0 },
    { x: 640, y: 240 },
    { x: 520, y: 240 },
    { x: 520, y: 380 },
    { x: 300, y: 380 },
    { x: 300, y: 300 },
    { x: 160, y: 300 },
    { x: 160, y: 380 },
    { x: 60, y: 380 },
    { x: 60, y: 240 },
    { x: 0, y: 240 },
  ];
  const outArea = polyArea(OUT);
  // Interior: a long ridge collinear with two perimeter stubs (the y=240
  // line), the bump's V valleys meeting an apex, and its ridge dying into
  // the long ridge (T-junction) — crossings, T-junctions, and collinear
  // overlap in one net, like a sheet-adopted layout.
  const interior = [
    { p1: { x: 0, y: 240 }, p2: { x: 640, y: 240 } },
    { p1: { x: 200, y: 0 }, p2: { x: 260, y: 60 } },
    { p1: { x: 320, y: 0 }, p2: { x: 260, y: 60 } },
    { p1: { x: 260, y: 60 }, p2: { x: 260, y: 240 } },
    { p1: { x: 640, y: 0 }, p2: { x: 520, y: 120 } },
  ];
  const faces = facesFromRoofLines(OUT, interior);
  assert.ok(faces, "arrangement validates");
  assert.ok(faces.length >= 4, `expected several planes, got ${faces.length}`);
  const cover = totalArea(faces);
  assert.ok(
    Math.abs(cover - outArea) / outArea < 0.01,
    `full coverage: ${cover} vs outline ${outArea}`,
  );
});

test("faces: interior line overshooting the outline still tiles (outside slivers dropped)", () => {
  const faces = facesFromRoofLines(RECT, [
    { p1: { x: -50, y: 100 }, p2: { x: 450, y: 100 } },
  ]);
  assert.ok(faces, "arrangement validates");
  assert.equal(faces.length, 2);
  assert.ok(Math.abs(totalArea(faces) - 80000) < 80);
});

test("faces: floating stub is pruned, footprint still tiles as one plane", () => {
  const faces = facesFromRoofLines(RECT, [
    { p1: { x: 150, y: 80 }, p2: { x: 250, y: 120 } }, // touches nothing
  ]);
  assert.ok(faces, "arrangement validates");
  assert.equal(faces.length, 1, "stub can't bound a plane — one face");
  assert.ok(Math.abs(totalArea(faces) - 80000) < 80);
});

test("faces: degenerate inputs return null (never a partial shading)", () => {
  // Self-intersecting bowtie — no well-defined interior.
  const BOWTIE = [
    { x: 0, y: 0 },
    { x: 400, y: 200 },
    { x: 400, y: 0 },
    { x: 0, y: 200 },
  ];
  assert.equal(facesFromRoofLines(BOWTIE, []), null);
  // Sub-polygon outline.
  assert.equal(facesFromRoofLines([{ x: 0, y: 0 }, { x: 10, y: 0 }], []), null);
  // Near-zero-area ring (collinear soup).
  assert.equal(
    facesFromRoofLines(
      [
        { x: 0, y: 0 },
        { x: 200, y: 0.01 },
        { x: 400, y: 0 },
      ],
      [],
    ),
    null,
  );
});
