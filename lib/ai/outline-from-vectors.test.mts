import { test } from "node:test";
import assert from "node:assert/strict";

import { extractBuildingOutline, type Pt } from "./outline-from-vectors.ts";

/** Wall segments for a closed rectilinear ring (consecutive corners). */
function ring(corners: [number, number][]): number[][] {
  const segs: number[][] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    segs.push([a[0], a[1], b[0], b[1]]);
  }
  return segs;
}

function bbox(poly: Pt[]) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

test("rectangle of walls → ~4-corner outline matching the bbox", () => {
  const segs = ring([
    [0, 0],
    [640, 0],
    [640, 520],
    [0, 520],
  ]);
  const out = extractBuildingOutline(segs);
  assert.ok(out, "got an outline");
  // Rectilinear rectangle should collapse to ~4 corners (allow a couple slop).
  assert.ok(out!.polygon.length >= 4 && out!.polygon.length <= 6, `~4 corners (${out!.polygon.length})`);
  const bb = bbox(out!.polygon);
  // The recovered outline tracks the real extents within ~1 grid cell.
  const cell = 640 / 200;
  assert.ok(Math.abs(bb.x1 - bb.x0 - 640) < cell * 4, "width ~640");
  assert.ok(Math.abs(bb.y1 - bb.y0 - 520) < cell * 4, "depth ~520");
});

test("L-shape → recovers the notch (more than 4 corners)", () => {
  // An L: main body 600x400 with a 250x200 bite out of the bottom-right.
  const segs = ring([
    [0, 0],
    [600, 0],
    [600, 200],
    [350, 200],
    [350, 400],
    [0, 400],
  ]);
  const out = extractBuildingOutline(segs);
  assert.ok(out, "got an outline");
  // The reflex corner means it can't be a plain rectangle.
  assert.ok(out!.polygon.length >= 6, `L keeps its notch (${out!.polygon.length} corners)`);
  // It must NOT cover the bitten-out corner: the far bottom-right is exterior.
  const inPoly = pointInPoly({ x: 520, y: 360 }, out!.polygon);
  assert.equal(inPoly, false, "the L's missing corner stays outside the outline");
});

test("interior walls are ignored — outer perimeter only", () => {
  const outer = ring([
    [0, 0],
    [500, 0],
    [500, 500],
    [0, 500],
  ]);
  // A cross of interior partition walls inside the box (noise).
  const interior = [
    [250, 20, 250, 480],
    [20, 250, 480, 250],
  ];
  const out = extractBuildingOutline([...outer, ...interior]);
  assert.ok(out, "got an outline");
  assert.ok(out!.polygon.length >= 4 && out!.polygon.length <= 6, "still ~4 corners despite interior walls");
});

test("garbage / non-enclosing input → null (caller falls back)", () => {
  assert.equal(extractBuildingOutline([]), null);
  assert.equal(extractBuildingOutline([[0, 0, 10, 0]]), null); // a lone stroke
});

/** Ray-cast point-in-polygon for the test assertions. */
function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
