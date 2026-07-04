/**
 * Pure node tests for the engine-takeoff bundle. Run:
 *   npx tsx --test lib/ai/engine-takeoff.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEngineTakeoff, engineTakeoffEnabled } from "./engine-takeoff.ts";
import type { BlueprintAnalysis, BlueprintRun } from "./blueprint-from-plans.ts";

// 100×80 px footprint; 0.5 ft/px → 50×40 ft, perimeter 180 ft.
const FOOTPRINT = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 80 },
  { x: 0, y: 80 },
];

function run(a: [number, number], b: [number, number]): BlueprintRun {
  return {
    id: `${a[0]}-${a[1]}`,
    side: "front",
    start: { x: a[0], y: a[1] },
    end: { x: b[0], y: b[1] },
    length_ft: Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.5,
    length_px: Math.hypot(b[0] - a[0], b[1] - a[1]),
    drains_to: [],
  };
}

function analysis(over: Partial<BlueprintAnalysis> = {}): BlueprintAnalysis {
  return {
    scale: { feet_per_unit: 0.5, unit: "pixels", source: "test" },
    building_footprint: FOOTPRINT,
    gutter_runs: [
      run([0, 0], [100, 0]),
      run([100, 0], [100, 80]),
      run([100, 80], [0, 80]),
      run([0, 80], [0, 0]),
    ],
    downspouts: [],
    excluded_edges: [],
    totals: { linear_feet_gutter: 180, downspout_count: 0, outside_corner_miters: 4, inside_corner_miters: 0 },
    confidence: "high",
    notes: [],
    ...over,
  };
}

test("engineTakeoffEnabled: default off, override wins", () => {
  assert.equal(engineTakeoffEnabled(false), false);
  assert.equal(engineTakeoffEnabled(true), true);
});

test("safety valve: engineTakeoffEnabled() is OFF unless BLUEPRINT_ENGINE_TAKEOFF=1", () => {
  const prev = process.env.BLUEPRINT_ENGINE_TAKEOFF;
  try {
    delete process.env.BLUEPRINT_ENGINE_TAKEOFF;
    assert.equal(engineTakeoffEnabled(), false, "unset ⇒ off (the default)");
    process.env.BLUEPRINT_ENGINE_TAKEOFF = "0";
    assert.equal(engineTakeoffEnabled(), false, "'0' ⇒ off");
    process.env.BLUEPRINT_ENGINE_TAKEOFF = "true";
    assert.equal(engineTakeoffEnabled(), false, "only the literal '1' enables it");
    process.env.BLUEPRINT_ENGINE_TAKEOFF = "1";
    assert.equal(engineTakeoffEnabled(), true, "'1' ⇒ on");
  } finally {
    if (prev === undefined) delete process.env.BLUEPRINT_ENGINE_TAKEOFF;
    else process.env.BLUEPRINT_ENGINE_TAKEOFF = prev;
  }
});

test("buildEngineTakeoff: all-guttered footprint → LF = real perimeter (180 ft), downspouts placed", () => {
  const b = buildEngineTakeoff(analysis());
  assert.ok(b, "bundle should build with a scale + footprint");
  assert.equal(b!.ftPerPx, 0.5);
  // 4 guttered perimeter edges = 360 px = 180 ft.
  assert.equal(b!.eaveLfFt, 180);
  assert.ok(b!.takeoff.downspouts.length >= 1, "rule downspouts placed on the perimeter run");
  // Every guttered edge is present as an eave in the assembled mass.
  const eaves = b!.takeoff.masses[0].edges.filter((e) => e.gutter);
  assert.equal(eaves.length, 4);
});

test("buildEngineTakeoff: a non-guttered (rake) side is excluded from LF", () => {
  const b = buildEngineTakeoff(
    analysis({
      // Drop the left run → that edge isn't guttered.
      gutter_runs: [run([0, 0], [100, 0]), run([100, 0], [100, 80]), run([100, 80], [0, 80])],
    }),
  );
  assert.ok(b);
  // 3 sides: 100+80+100 px = 280 px = 140 ft.
  assert.equal(b!.eaveLfFt, 140);
  assert.equal(b!.takeoff.masses[0].edges.filter((e) => e.gutter).length, 3);
});

test("buildEngineTakeoff: null without an independent scale (can't produce real feet)", () => {
  assert.equal(buildEngineTakeoff(analysis({ scale: { feet_per_unit: null, unit: "unknown", source: "t" } })), null);
});

test("buildEngineTakeoff: null on a degenerate footprint; never throws", () => {
  assert.equal(buildEngineTakeoff(analysis({ building_footprint: [{ x: 0, y: 0 }] })), null);
});

test("buildEngineTakeoff: null when no footprint edge aligns with a gutter run (flag no-ops, no 0 LF)", () => {
  // Gutter runs far from the footprint → zero coverage.
  const b = buildEngineTakeoff(
    analysis({
      gutter_runs: [run([1000, 1000], [1100, 1000])],
    }),
  );
  assert.equal(b, null);
});
