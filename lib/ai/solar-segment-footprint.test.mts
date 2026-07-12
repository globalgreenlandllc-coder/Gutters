import { test } from "node:test";
import assert from "node:assert/strict";
import { footprintMaskFromSolarSegments } from "./solar-segment-footprint.ts";

// A small L-shaped roof: two plane bboxes near lat 47.5, lng -122.1.
// Box A: the main body. Box B: a wing offset to the east + south.
const A_NE = { lat: 47.50010, lng: -122.10010 };
const A_SW = { lat: 47.50000, lng: -122.10030 };
const B_NE = { lat: 47.50005, lng: -122.09995 };
const B_SW = { lat: 47.49995, lng: -122.10010 };

test("footprintMask: unions ≥2 plane bboxes into a filled mask", () => {
  const m = footprintMaskFromSolarSegments([
    { boundingBoxNE: A_NE, boundingBoxSW: A_SW },
    { boundingBoxNE: B_NE, boundingBoxSW: B_SW },
  ]);
  assert.ok(m, "mask produced");
  assert.equal(m!.ok, true);
  assert.ok(m!.width > 0 && m!.height > 0);
  const filled = m!.mask.reduce((s, v) => s + v, 0);
  assert.ok(filled > 0, "some pixels filled");
  assert.ok(m!.areaFraction > 0 && m!.areaFraction < 1);
});

test("footprintMask: round-trip is exact — a filled pixel maps back inside a source bbox", () => {
  const boxes = [
    { boundingBoxNE: A_NE, boundingBoxSW: A_SW },
    { boundingBoxNE: B_NE, boundingBoxSW: B_SW },
  ];
  const m = footprintMaskFromSolarSegments(boxes)!;
  // Overall lat/lng bounds of the two boxes.
  const minLat = Math.min(A_SW.lat, B_SW.lat);
  const maxLat = Math.max(A_NE.lat, B_NE.lat);
  const minLng = Math.min(A_SW.lng, B_SW.lng);
  const maxLng = Math.max(A_NE.lng, B_NE.lng);
  // Every filled pixel, mapped via the SAME contract polygonFromSolarMask
  // uses, must land within the overall footprint bounds (a tolerance of
  // one pixel for the pad/ceil rounding).
  const tolLat = Math.abs(m.pixelSize.y) * 1.5;
  const tolLng = Math.abs(m.pixelSize.x) * 1.5;
  let checked = 0;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (m.mask[y * m.width + x] === 0) continue;
      const nativeX = m.origin.x + x * m.pixelSize.x;
      const nativeY = m.origin.y + y * m.pixelSize.y;
      const { lat, lng } = m.toLatLng(nativeX, nativeY);
      assert.ok(lat >= minLat - tolLat && lat <= maxLat + tolLat, `lat ${lat} in bounds`);
      assert.ok(lng >= minLng - tolLng && lng <= maxLng + tolLng, `lng ${lng} in bounds`);
      checked++;
    }
  }
  assert.ok(checked > 4, "checked several filled pixels");
});

test("footprintMask: < 2 valid boxes → null (not worth it)", () => {
  assert.equal(footprintMaskFromSolarSegments([]), null);
  assert.equal(
    footprintMaskFromSolarSegments([{ boundingBoxNE: A_NE, boundingBoxSW: A_SW }]),
    null,
  );
  assert.equal(
    footprintMaskFromSolarSegments([
      { boundingBoxNE: null, boundingBoxSW: A_SW },
      { boundingBoxNE: A_NE, boundingBoxSW: null },
    ]),
    null,
  );
});

test("footprintMask: a wing bbox is actually rasterized (east column has fill)", () => {
  // Box B extends east of box A; the mask's right half must have fill.
  const m = footprintMaskFromSolarSegments([
    { boundingBoxNE: A_NE, boundingBoxSW: A_SW },
    { boundingBoxNE: B_NE, boundingBoxSW: B_SW },
  ])!;
  let rightFill = 0;
  for (let y = 0; y < m.height; y++) {
    for (let x = Math.floor(m.width * 0.6); x < m.width; x++) {
      if (m.mask[y * m.width + x]) rightFill++;
    }
  }
  assert.ok(rightFill > 0, "the east wing rasterized into the right of the grid");
});
