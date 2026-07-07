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
