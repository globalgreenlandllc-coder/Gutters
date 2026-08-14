import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveOrientation,
  DEFAULT_FACE_NORMALS,
  facingLetterOf,
} from "./plan-orientation.ts";

const page = (page: number, text: string) => ({ page, text });

test("Woodinville-style titles (front=north) → compass rotated 180°", () => {
  const o = deriveOrientation([
    page(13, "… FRONT/NORTH ELEVATION … RIGHT/WEST ELEVATION …"),
    page(14, "… REAR/SOUTH ELEVATION … LEFT/EAST ELEVATION …"),
  ]);
  assert.ok(o, "derived an orientation");
  assert.equal(o!.rotationQuarterTurns, 2);
  // Front-at-bottom ⇒ north points DOWN the canvas, west to the RIGHT.
  assert.deepEqual(o!.normals.north, { x: 0, y: 1 });
  assert.deepEqual(o!.normals.south, { x: 0, y: -1 });
  assert.deepEqual(o!.normals.west, { x: 1, y: 0 });
  assert.deepEqual(o!.normals.east, { x: -1, y: 0 });
  assert.equal(o!.pairs.front, "north");
});

test("front=south set → identity (north stays up)", () => {
  const o = deriveOrientation([page(9, "FRONT/SOUTH ELEVATION and LEFT/WEST ELEVATION")]);
  assert.ok(o);
  assert.equal(o!.rotationQuarterTurns, 0);
  assert.deepEqual(o!.normals, DEFAULT_FACE_NORMALS);
});

test("compass-first title order is accepted", () => {
  const o = deriveOrientation([page(5, "NORTH/FRONT ELEVATION")]);
  assert.ok(o);
  assert.equal(o!.rotationQuarterTurns, 2);
});

test("front=east set → quarter turn", () => {
  const o = deriveOrientation([page(3, "FRONT/EAST ELEVATION")]);
  assert.ok(o);
  // front(bottom) = east ⇒ north points to the RIGHT of the canvas.
  assert.deepEqual(o!.normals.east, { x: 0, y: 1 });
  assert.deepEqual(o!.normals.north, { x: 1, y: 0 });
});

test("no titled pairs → null (caller keeps the default)", () => {
  assert.equal(deriveOrientation([page(1, "SITE PLAN 1\" = 10'-0\"")]), null);
  assert.equal(deriveOrientation([]), null);
});

test("inconsistent pairs → null (don't guess)", () => {
  // front=north AND right=east is a mirror, not a rotation — reject.
  const o = deriveOrientation([page(13, "FRONT/NORTH ELEVATION … RIGHT/EAST ELEVATION")]);
  assert.equal(o, null);
});

test("conflicting duplicate word → null", () => {
  const o = deriveOrientation([
    page(13, "FRONT/NORTH ELEVATION"),
    page(14, "FRONT/SOUTH ELEVATION"),
  ]);
  assert.equal(o, null);
});

test("facingLetterOf maps canvas normals to engine letters", () => {
  assert.equal(facingLetterOf({ x: 0, y: -1 }), "N");
  assert.equal(facingLetterOf({ x: 0, y: 1 }), "S");
  assert.equal(facingLetterOf({ x: 1, y: 0 }), "E");
  assert.equal(facingLetterOf({ x: -1, y: 0 }), "W");
});

// ── sideOfPerimeterEdge — geometric orientation-chip sides ──────────────

test("sideOfPerimeterEdge: rectangle edges map bottom→front, top→back, left/right (y-down canvas)", async () => {
  const { sideOfPerimeterEdge } = await import("./plan-orientation.ts");
  // 100×60 rectangle, y grows down (canvas/PDF-pixel space).
  const fp = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 0, y: 60 },
  ];
  // Bottom edge (max y) — outward normal points +y (down) = FRONT.
  assert.equal(sideOfPerimeterEdge({ x: 0, y: 60 }, { x: 100, y: 60 }, fp), "front");
  // Top edge — outward -y = BACK. Direction of travel must not matter.
  assert.equal(sideOfPerimeterEdge({ x: 100, y: 0 }, { x: 0, y: 0 }, fp), "back");
  assert.equal(sideOfPerimeterEdge({ x: 0, y: 0 }, { x: 100, y: 0 }, fp), "back");
  // Left / right walls.
  assert.equal(sideOfPerimeterEdge({ x: 0, y: 0 }, { x: 0, y: 60 }, fp), "left");
  assert.equal(sideOfPerimeterEdge({ x: 100, y: 60 }, { x: 100, y: 0 }, fp), "right");
});

test("sideOfPerimeterEdge: notch edges face by OUTWARD normal, not by position on the plan", async () => {
  const { sideOfPerimeterEdge } = await import("./plan-orientation.ts");
  // U-shape opening downward (front courtyard): the notch's inner-left wall
  // sits in the LEFT half of the plan but its outward normal points +x —
  // it faces RIGHT (into the courtyard). Centroid heuristics get this wrong;
  // the point-in-polygon probe must not.
  const fp = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 70, y: 60 },
    { x: 70, y: 30 },
    { x: 30, y: 30 },
    { x: 30, y: 60 },
    { x: 0, y: 60 },
  ];
  // Notch inner-left wall x=30 (interior of the U is to its LEFT, outside the
  // polygon is the courtyard to its... let's check: polygon material is where?
  // Points (29, 45) is inside the left leg; (31, 45) is in the courtyard.
  assert.equal(sideOfPerimeterEdge({ x: 30, y: 30 }, { x: 30, y: 60 }, fp), "right");
  // Notch inner-right wall x=70 faces LEFT into the courtyard.
  assert.equal(sideOfPerimeterEdge({ x: 70, y: 60 }, { x: 70, y: 30 }, fp), "left");
  // The notch's back wall (y=30, courtyard below it) faces +y = FRONT.
  assert.equal(sideOfPerimeterEdge({ x: 30, y: 30 }, { x: 70, y: 30 }, fp), "front");
});

test("sideOfPerimeterEdge: degenerate inputs → null", async () => {
  const { sideOfPerimeterEdge } = await import("./plan-orientation.ts");
  const fp = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];
  assert.equal(sideOfPerimeterEdge({ x: 5, y: 5 }, { x: 5, y: 5 }, fp), null);
  assert.equal(sideOfPerimeterEdge({ x: 0, y: 0 }, { x: 10, y: 0 }, []), null);
  assert.equal(
    sideOfPerimeterEdge({ x: 0, y: 0 }, { x: 10, y: 0 }, [fp[0], fp[1]]),
    null,
  );
});
