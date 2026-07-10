/**
 * Pure node tests for roof-geom helpers. Run with:
 *   npx tsx --test lib/ai/roof-geom.test.mts
 * No DB, no AI, no network — deterministic functions only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  symmetricHausdorffPx,
  polygonAreaAbs,
  isArchitecturalCorner,
  countOpenEaveEnds,
  largestConnectedComponent,
} from "./roof-geom.ts";

const rect = (w: number, h: number, ox = 0, oy = 0) => [
  { x: ox, y: oy },
  { x: ox + w, y: oy },
  { x: ox + w, y: oy + h },
  { x: ox, y: oy + h },
];

test("symmetricHausdorffPx: vertex-count difference does not matter when shape agrees", () => {
  const clean = rect(100, 60);
  // Same rectangle but with extra collinear midpoints — this is the shape
  // the ortho regularizer produces (fewer verts) vs the DP polygon (more).
  // They trace the SAME walls, so Hausdorff must be ~0 despite 4 vs 8.
  const withMidpoints = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 30 },
    { x: 100, y: 60 },
    { x: 50, y: 60 },
    { x: 0, y: 60 },
    { x: 0, y: 30 },
  ];
  assert.ok(symmetricHausdorffPx(clean, withMidpoints) < 1e-6);
  assert.equal(clean.length !== withMidpoints.length, true);
});

test("symmetricHausdorffPx: disagreeing shapes report a large distance", () => {
  const a = rect(100, 60);
  const b = rect(100, 60, 100, 0); // translated fully off the original
  assert.ok(symmetricHausdorffPx(a, b) > 40);
});

test("polygonAreaAbs: shoelace on a rectangle", () => {
  assert.equal(polygonAreaAbs(rect(2, 3)), 6);
  assert.equal(polygonAreaAbs(rect(10, 10)), 100);
});

test("isArchitecturalCorner: gates jitter and hairpins, keeps real corners", () => {
  const p = { x: 0, y: 0 };
  // 90° corner
  assert.equal(isArchitecturalCorner({ x: -10, y: 0 }, p, { x: 0, y: 10 }), true);
  // 45° chamfer
  assert.equal(isArchitecturalCorner({ x: -10, y: 0 }, p, { x: 10, y: 10 }), true);
  // near-straight (~3° jitter) — not a corner
  assert.equal(
    isArchitecturalCorner({ x: -100, y: 0 }, p, { x: 100, y: 5 }),
    false,
  );
  // near-180° hairpin spike — not a corner
  assert.equal(
    isArchitecturalCorner({ x: -100, y: 0 }, p, { x: -100, y: 2 }),
    false,
  );
});

test("countOpenEaveEnds: L of two eaves has two open ends (the far tips)", () => {
  const lines = [
    { kind: "eave", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    { kind: "eave", points: [{ x: 100, y: 0 }, { x: 100, y: 80 }] },
  ];
  // The shared (100,0) corner is closed; the two far tips are open.
  assert.equal(countOpenEaveEnds(lines), 2);
});

test("countOpenEaveEnds: closed rectangle of 4 eaves has zero open ends", () => {
  const lines = [
    { kind: "eave", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    { kind: "eave", points: [{ x: 100, y: 0 }, { x: 100, y: 100 }] },
    { kind: "eave", points: [{ x: 100, y: 100 }, { x: 0, y: 100 }] },
    { kind: "eave", points: [{ x: 0, y: 100 }, { x: 0, y: 0 }] },
  ];
  assert.equal(countOpenEaveEnds(lines), 0);
});

test("countOpenEaveEnds: a short isolated stub is not falsely closed by its own sibling endpoint", () => {
  // Endpoints 10px apart, below tol=14 — a naive same-line comparison
  // would mark both as 'closed' (0 caps). The sibling exclusion keeps them
  // open: a lone gutter run has two caps.
  const lines = [{ kind: "eave", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }];
  assert.equal(countOpenEaveEnds(lines), 2);
});

test("largestConnectedComponent: keeps the big blob, drops a detached speck", () => {
  const W = 10;
  const H = 10;
  // 3×3 block at (1..3,1..3) plus a lone speck at (8,8).
  const isFg = (x: number, y: number) =>
    (x >= 1 && x <= 3 && y >= 1 && y <= 3) || (x === 8 && y === 8);
  const { mask, count } = largestConnectedComponent(W, H, isFg);
  assert.equal(count, 9);
  assert.equal(mask[1 * W + 1], 1);
  assert.equal(mask[8 * W + 8], 0); // speck excluded
});

test("largestConnectedComponent: 8-connectivity keeps a diagonally-pinched pixel", () => {
  const W = 10;
  const H = 10;
  // 3×3 block plus (4,4) touching (3,3) only diagonally.
  const isFg = (x: number, y: number) =>
    (x >= 1 && x <= 3 && y >= 1 && y <= 3) || (x === 4 && y === 4);
  const { mask, count } = largestConnectedComponent(W, H, isFg);
  assert.equal(count, 10);
  assert.equal(mask[4 * W + 4], 1);
});
