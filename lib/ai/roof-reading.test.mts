/**
 * Pure node tests for the reading contract → engine lowering. Run with:
 *   npx tsx --test lib/ai/roof-reading.test.mts
 *
 * The load-bearing behavior is Correction 2: a gable is FLUSH unless a side
 * view / roof plan confirmed the projection. `resolveProjectionFt` enforces
 * that in code, so a face-view read can never silently add side eaves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readingToMassInputs,
  resolveProjectionFt,
  type GableReading,
  type RoofReading,
} from "./roof-reading.ts";
import { runRoofEngine } from "../roof-engine.ts";

function gableReading(over: Partial<GableReading>): GableReading {
  return {
    id: "g1",
    face: "front",
    facing: "S",
    base_center: { x: 10, y: 44 },
    span_ft: 12,
    pitch: 4,
    projecting: false,
    projection_ft: 0,
    projection_source: "none",
    eave_condition: "flush",
    anchored_to_eave: true,
    confidence: "medium",
    ...over,
  };
}

test("resolveProjectionFt: flush by default, projecting only when a view confirms", () => {
  // Default flush.
  assert.equal(resolveProjectionFt(gableReading({})), 0);
  // Marked projecting but no confirming source ⇒ still flush.
  assert.equal(resolveProjectionFt(gableReading({ projecting: true, projection_ft: 6, projection_source: "none" })), 0);
  // Marked projecting but zero depth ⇒ flush.
  assert.equal(
    resolveProjectionFt(gableReading({ projecting: true, projection_ft: 0, projection_source: "side_elevation" })),
    0,
  );
  // Confirmed from the side elevation with real depth ⇒ projects.
  assert.equal(
    resolveProjectionFt(gableReading({ projecting: true, projection_ft: 6, projection_source: "side_elevation" })),
    6,
  );
  // Confirmed from the roof plan ⇒ projects.
  assert.equal(
    resolveProjectionFt(gableReading({ projecting: true, projection_ft: 4, projection_source: "roof_plan" })),
    4,
  );
});

test("readingToMassInputs → engine: an unconfirmed 'projecting' gable adds NO side eaves", () => {
  const reading: RoofReading = {
    scale: { units_per_ft: 1, confidence: "high", source: "test" },
    symmetry_assumed: false,
    elevation_unreadable: [],
    review_flags: [],
    per_face: {
      front: { face: "front", readable: true, gable_count: 1, continuous_eave: true, gables: [], projections_confirmed: [], confidence: "high" },
      rear: { face: "rear", readable: true, gable_count: 0, continuous_eave: true, gables: [], projections_confirmed: [], confidence: "high" },
      left: { face: "left", readable: true, gable_count: 0, continuous_eave: true, gables: [], projections_confirmed: [], confidence: "high" },
      right: { face: "right", readable: true, gable_count: 0, continuous_eave: true, gables: [], projections_confirmed: [], confidence: "high" },
    },
    masses: [
      {
        name: "main",
        outline_polygon: [
          { x: 0, y: 0 },
          { x: 64, y: 0 },
          { x: 64, y: 44 },
          { x: 0, y: 44 },
        ],
        stated_area_ft2: 2816,
        eave_edge_indices: [0, 1, 2, 3],
        gables: [
          // Model *claimed* projecting but the face view can't prove it → flush.
          gableReading({ id: "unconfirmed", base_center: { x: 32, y: 44 }, projecting: true, projection_ft: 6, projection_source: "none" }),
        ],
      },
    ],
  };

  const inputs = readingToMassInputs(reading);
  assert.equal(inputs[0].gables?.[0].projection, 0);

  const res = runRoofEngine(inputs);
  // Perimeter eaves only (64+44+64+44 = 216); no gable side eaves added.
  assert.equal(res.eaveLfByMass.main, 216);
  assert.ok(res.reviewFlags.some((f) => f.code === "gable_flush"));
});

test("readingToMassInputs → engine: a roof-plan-confirmed projection DOES add side eaves", () => {
  const reading: RoofReading = {
    scale: { units_per_ft: 1, confidence: "high", source: "test" },
    symmetry_assumed: false,
    elevation_unreadable: [],
    review_flags: [],
    per_face: {
      front: { face: "front", readable: true, gable_count: 1, continuous_eave: true, gables: [], projections_confirmed: ["p"], confidence: "high" },
      rear: { face: "rear", readable: true, gable_count: 0, continuous_eave: true, gables: [], projections_confirmed: [], confidence: "high" },
      left: { face: "left", readable: true, gable_count: 0, continuous_eave: true, gables: [], projections_confirmed: [], confidence: "high" },
      right: { face: "right", readable: true, gable_count: 0, continuous_eave: true, gables: [], projections_confirmed: [], confidence: "high" },
    },
    masses: [
      {
        name: "main",
        outline_polygon: [
          { x: 0, y: 0 },
          { x: 64, y: 0 },
          { x: 64, y: 44 },
          { x: 0, y: 44 },
        ],
        stated_area_ft2: 2816,
        eave_edge_indices: [0, 1, 2, 3],
        gables: [
          gableReading({ id: "p", base_center: { x: 32, y: 44 }, span_ft: 12, projecting: true, projection_ft: 5, projection_source: "roof_plan", eave_condition: "projecting" }),
        ],
      },
    ],
  };
  const res = runRoofEngine(readingToMassInputs(reading));
  // 216 perimeter + two 5 ft side eaves = 226.
  assert.equal(res.eaveLfByMass.main, 226);
});
