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

test("buildEngineTakeoff: a side EXPLICITLY marked a rake is excluded from LF", () => {
  const b = buildEngineTakeoff(
    analysis({
      // The left edge (x=0, 80px) is an excluded rake → not guttered. (Merely
      // lacking a gutter_run no longer excludes an edge — see the dropped-eave
      // test below.)
      excluded_edges: [{ kind: "rake", start: { x: 0, y: 80 }, end: { x: 0, y: 0 }, reason: "gable end" }],
    }),
  );
  assert.ok(b);
  // 3 sides: 100+80+100 px = 280 px = 140 ft.
  assert.equal(b!.eaveLfFt, 140);
  assert.equal(b!.takeoff.masses[0].edges.filter((e) => e.gutter).length, 3);
});

test("buildEngineTakeoff: a DROPPED eave (no gutter run, not a rake) is STILL counted", () => {
  // Only one gutter run (for scale); the AI dropped the other three eaves and
  // marked no rakes. All four perimeter edges still price as guttered eaves —
  // this is the ~13% under-count fix (default eave unless explicitly a rake).
  const b = buildEngineTakeoff(analysis({ gutter_runs: [run([0, 0], [100, 0])] }));
  assert.ok(b);
  assert.equal(b!.takeoff.masses[0].edges.filter((e) => e.gutter).length, 4);
  assert.equal(b!.eaveLfFt, 180);
});

test("buildEngineTakeoff: px/ft comes from the runs, so a null declared scale still works", () => {
  // Runs carry length_ft/length_px, so real feet are derivable even with no
  // declared scale — more robust than trusting scale.feet_per_unit.
  const b = buildEngineTakeoff(analysis({ scale: { feet_per_unit: null, unit: "unknown", source: "t" } }));
  assert.ok(b, "run-derived px/ft should still produce a takeoff");
  assert.equal(b!.ftPerPx, 0.5);
  assert.equal(b!.eaveLfFt, 180);
});

test("buildEngineTakeoff: null when NEITHER the runs nor the scale give real feet", () => {
  const noFeet = analysis({
    scale: { feet_per_unit: null, unit: "unknown", source: "t" },
    gutter_runs: [
      run([0, 0], [100, 0]),
      run([100, 0], [100, 80]),
      run([100, 80], [0, 80]),
      run([0, 80], [0, 0]),
    ].map((r) => ({ ...r, length_ft: null })),
  });
  assert.equal(buildEngineTakeoff(noFeet), null);
});

test("buildEngineTakeoff: null on a degenerate footprint; never throws", () => {
  assert.equal(buildEngineTakeoff(analysis({ building_footprint: [{ x: 0, y: 0 }] })), null);
});

test("buildEngineTakeoff: null when EVERY edge is marked a rake (nothing to price)", () => {
  const allRakes = analysis({
    excluded_edges: [
      { kind: "rake", start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, reason: "" },
      { kind: "rake", start: { x: 100, y: 0 }, end: { x: 100, y: 80 }, reason: "" },
      { kind: "rake", start: { x: 100, y: 80 }, end: { x: 0, y: 80 }, reason: "" },
      { kind: "rake", start: { x: 0, y: 80 }, end: { x: 0, y: 0 }, reason: "" },
    ],
  });
  assert.equal(buildEngineTakeoff(allRakes), null);
});
