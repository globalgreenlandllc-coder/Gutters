/**
 * Round-trip tests for the SolarLayers snapshot format. Run with:
 *   npx tsx --test lib/test-lab/layers-io.test.mts
 * proj4 only — no DB, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGridTransforms,
  deserializeSolarLayers,
  serializeSolarLayers,
} from "./layers-io.ts";
import type { SolarLayers } from "../ai/solar-layers";

function syntheticLayers(): SolarLayers {
  const width = 40;
  const height = 30;
  // A real UTM zone 10N grid near Seattle-ish coordinates.
  const gridData = {
    width,
    height,
    originX: 550_000,
    originY: 5_275_000,
    pxX: 0.1,
    pxY: -0.1,
    metersPerPixel: 0.1,
    crsLabel: "EPSG:32610",
  };
  const transforms = buildGridTransforms(gridData, 47.6);
  const mask = new Uint8Array(width * height);
  const dsm = new Float32Array(width * height);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = i % 7 === 0 ? 1 : 0;
    dsm[i] = 100 + Math.sin(i) * 5;
    rgb[i * 3] = i % 256;
    rgb[i * 3 + 1] = (i * 2) % 256;
    rgb[i * 3 + 2] = (i * 3) % 256;
  }
  return {
    grid: { ...gridData, ...transforms },
    mask,
    dsm,
    dsmNoData: -9999,
    rgb,
    imageryQuality: "HIGH",
    imageryDate: "2024-05-01",
  };
}

test("serialize → deserialize round-trips rasters and metadata exactly", () => {
  const original = syntheticLayers();
  const packed = serializeSolarLayers(original);
  assert.equal(typeof packed, "string");
  const restored = deserializeSolarLayers(packed);

  assert.deepEqual([...restored.mask], [...original.mask]);
  assert.deepEqual([...restored.rgb], [...original.rgb]);
  assert.equal(restored.dsm.length, original.dsm.length);
  for (let i = 0; i < original.dsm.length; i++) {
    assert.ok(Math.abs(restored.dsm[i] - original.dsm[i]) < 1e-6);
  }
  assert.equal(restored.dsmNoData, -9999);
  assert.equal(restored.imageryQuality, "HIGH");
  assert.equal(restored.imageryDate, "2024-05-01");
  assert.equal(restored.grid.width, original.grid.width);
  assert.equal(restored.grid.crsLabel, "EPSG:32610");
});

test("rebuilt CRS transforms match the originals", () => {
  const original = syntheticLayers();
  const restored = deserializeSolarLayers(serializeSolarLayers(original));
  for (const [x, y] of [[0, 0], [20, 15], [39.5, 29.5]] as const) {
    const a = original.grid.toLatLng(x, y);
    const b = restored.grid.toLatLng(x, y);
    assert.ok(Math.abs(a.lat - b.lat) < 1e-9, `lat @ ${x},${y}`);
    assert.ok(Math.abs(a.lng - b.lng) < 1e-9, `lng @ ${x},${y}`);
    // And the inverse lands back on the same pixel.
    const px = restored.grid.fromLatLng(b.lat, b.lng);
    assert.ok(Math.abs(px.x - x) < 1e-6 && Math.abs(px.y - y) < 1e-6);
  }
});

test("WGS84 degenerate grid round-trips too", () => {
  const original = syntheticLayers();
  const wgs: SolarLayers = {
    ...original,
    grid: {
      ...original.grid,
      originX: -122.3,
      originY: 47.61,
      pxX: 0.000001,
      pxY: -0.000001,
      crsLabel: "WGS84",
      ...buildGridTransforms(
        { ...original.grid, originX: -122.3, originY: 47.61, pxX: 0.000001, pxY: -0.000001, crsLabel: "WGS84" },
        47.61,
      ),
    },
  };
  const restored = deserializeSolarLayers(serializeSolarLayers(wgs));
  const a = wgs.grid.toLatLng(10, 10);
  const b = restored.grid.toLatLng(10, 10);
  assert.ok(Math.abs(a.lat - b.lat) < 1e-12);
  assert.ok(Math.abs(a.lng - b.lng) < 1e-12);
});
