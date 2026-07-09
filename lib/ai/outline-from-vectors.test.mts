import { test } from "node:test";
import assert from "node:assert/strict";

import { extractBuildingOutline, deriveVectorScale, type Pt } from "./outline-from-vectors.ts";

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

/** Same, tagged with a stroke weight (the 5th tuple element selectSegments emits). */
function wring(corners: [number, number][], w: number): number[][] {
  return ring(corners).map((s) => [...s, w]);
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

test("garage-jog with a DOOR GAP + interior walls → clean articulated outline (not a 40-corner staircase)", () => {
  // Main body 1152×792 + garage wing on the right; the long bottom wall has a
  // ~54pt (3ft) DOOR GAP; interior partitions are noise — like a real floor plan.
  const base: [number, number][] = [[0, 0], [1152, 0], [1152, 220], [1750, 220], [1750, 792], [0, 792]];
  const segs: number[][] = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[i];
    const b = base[(i + 1) % base.length];
    if (i === 4) {
      const mx = (a[0] + b[0]) / 2;
      segs.push([a[0], a[1], mx + 27, b[1]]);
      segs.push([mx - 27, a[1], b[0], b[1]]);
    } else segs.push([a[0], a[1], b[0], b[1]]);
  }
  segs.push([500, 30, 500, 760]);
  segs.push([30, 400, 1100, 400]);
  const out = extractBuildingOutline(segs);
  assert.ok(out, "recovers an outline despite the door gap + interior walls");
  // The garage jog survives (>4 corners), but the door dimple + grid stair-steps
  // are snapped away → a clean handful of corners, not a 30-40 corner staircase.
  assert.ok(out!.polygon.length >= 6 && out!.polygon.length <= 12, `clean articulated outline (${out!.polygon.length} corners)`);
  assert.equal(pointInPoly({ x: 1450, y: 100 }, out!.polygon), false, "the notch above the garage stays outside");
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

test("width-tiering peels the surrounding dimension lattice off the real walls", () => {
  // A dimensioned plan: the flood-fill's outermost closed contour is the thin
  // DIMENSION-LINE lattice ring (w=0.3) around the building, with a heavy sheet
  // FRAME (w=3.0) outside that; the real WALLS (w=1.5) sit inside. Without
  // stroke weight the trace grabs the outer lattice/frame (Woodinville's 80×80
  // ft ring). With weights the structural tier is isolated and the true inner
  // building is recovered.
  const frame = wring([[0, 0], [760, 0], [760, 760], [0, 760]], 3.0);
  const lattice = wring([[40, 40], [720, 40], [720, 720], [40, 720]], 0.3);
  // Inner building: an L (so we can prove it's the building, not a box copy).
  const walls = wring([[180, 200], [560, 200], [560, 380], [400, 380], [400, 540], [180, 540]], 1.5);
  const segs = [...frame, ...lattice, ...walls];

  // Weightless (legacy rows): the outer lattice/frame wins — the pre-fix behavior.
  const legacy = extractBuildingOutline(segs.map((s) => s.slice(0, 4)));
  assert.ok(legacy, "legacy path still returns something");
  const legacyBB = bbox(legacy!.polygon);
  assert.ok(legacyBB.x1 - legacyBB.x0 > 640, "weightless trace grabs the wide outer ring");

  // With weights: the inner building walls (380×340) are recovered, not the ring.
  const out = extractBuildingOutline(segs);
  assert.ok(out, "width-tiered outline");
  const bb = bbox(out!.polygon);
  assert.ok(Math.abs(bb.x1 - bb.x0 - 380) < 40, `inner building width ~380 (got ${(bb.x1 - bb.x0).toFixed(0)})`);
  assert.ok(Math.abs(bb.y1 - bb.y0 - 340) < 40, `inner building depth ~340 (got ${(bb.y1 - bb.y0).toFixed(0)})`);
  assert.ok(out!.polygon.length >= 6, "keeps the L notch");
  assert.equal(pointInPoly({ x: 500, y: 500 }, out!.polygon), false, "the L's bite stays outside");
});

test("width-tiering is strictly additive — uniform weights or missing widths fall back to base", () => {
  // A plain box drawn at one weight: no tier to peel → same as today's trace.
  const uniform = wring([[0, 0], [600, 0], [600, 480], [0, 480]], 1.0);
  const out = extractBuildingOutline(uniform);
  assert.ok(out, "still traces the box");
  const bb = bbox(out!.polygon);
  assert.ok(Math.abs(bb.x1 - bb.x0 - 600) < 16 && Math.abs(bb.y1 - bb.y0 - 480) < 16, "unchanged box");
});

// ── deriveVectorScale — anchor point-space outline to real feet ──────────────
test("deriveVectorScale anchors to the printed overall dimension and snaps to a sheet scale", () => {
  // 1152pt-wide outline, printed 64'-0 overall → 1152/64 = 18 pt/ft = 1/4\"=1'-0\".
  const outline: Pt[] = [
    { x: 100, y: 100 }, { x: 1252, y: 100 }, { x: 1252, y: 1120 }, { x: 100, y: 1120 },
  ];
  const s = deriveVectorScale(outline, "dimensioned wall — 64'-0 OVERALL foundation width vs ~1843 px roof-plan trace");
  assert.ok(s, "derived a scale");
  assert.equal(s!.ptPerFt, 18, "snapped to 18 pt/ft (1/4\" scale)");
  assert.ok(Math.abs(s!.ftPerPt - 1 / 18) < 1e-9, "ftPerPt is the reciprocal");
});

test("deriveVectorScale fails safe when no overall dimension is parseable or the scale is implausible", () => {
  const outline: Pt[] = [
    { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 800 }, { x: 0, y: 800 },
  ];
  assert.equal(deriveVectorScale(outline, "no dimensions here"), null, "no dim → null");
  assert.equal(deriveVectorScale(outline, ""), null, "empty source → null");
  // 1000pt / 3ft = 333 pt/ft — nowhere near a standard scale → reject.
  assert.equal(deriveVectorScale(outline, "3'-0 OVERALL"), null, "implausible → null");
});

test("deriveVectorScale finds the overall dim wherever the model wrote it (notes, not just scale.source)", () => {
  const outline: Pt[] = [
    { x: 0, y: 0 }, { x: 1152, y: 0 }, { x: 1152, y: 1020 }, { x: 0, y: 1020 },
  ]; // 1152pt / 64ft = 18 pt/ft
  // Gemini regression: scale.source has no dimension, but a note does. The
  // caller passes a joined blob of scale.source + notes.
  const blob = "Scale derived from multiple dimensioned walls due to X/Y inconsistencies. | overall building width 64'-0\" per foundation plan. | Kitchen 12'-0\".";
  const s = deriveVectorScale(outline, blob);
  assert.ok(s, "found the dim in the notes");
  assert.equal(s!.ptPerFt, 18, "snapped to 18 pt/ft");
  // A room-only dimension must NOT anchor the scale (12ft → 96 pt/ft, no snap).
  assert.equal(deriveVectorScale(outline, "Kitchen 12'-0\" wide; hallway 4'-0\"."), null, "room dims don't anchor");
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
