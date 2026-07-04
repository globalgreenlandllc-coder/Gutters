/**
 * Pure node tests for the legacy BlueprintAnalysis → engine validation bridge.
 * Run with: npx tsx --test lib/ai/to-masses.test.mts
 * No DB / AI / network — hand-authored analysis + classification literals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBlueprintGeometry, parseScheduleAreaFt2 } from "./to-masses.ts";
import type { BlueprintAnalysis, BlueprintRun } from "./blueprint-from-plans.ts";
import type { PlanClassification } from "./classify-plans.ts";

// 100×80 px footprint; at 0.5 ft/px that's 50×40 ft = 2000 ft².
const FOOTPRINT = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 80 },
  { x: 0, y: 80 },
];

function run(side: BlueprintRun["side"], a: [number, number], b: [number, number]): BlueprintRun {
  return {
    id: `${side}`,
    side,
    start: { x: a[0], y: a[1] },
    end: { x: b[0], y: b[1] },
    length_ft: Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.5,
    length_px: Math.hypot(b[0] - a[0], b[1] - a[1]),
    drains_to: [],
    tier: "upper",
  };
}

function analysis(over: Partial<BlueprintAnalysis> = {}): BlueprintAnalysis {
  return {
    scale: { feet_per_unit: 0.5, unit: "pixels", source: "test" },
    building_footprint: FOOTPRINT,
    gutter_runs: [
      run("back", [0, 0], [100, 0]),
      run("right", [100, 0], [100, 80]),
      run("front", [100, 80], [0, 80]),
      run("left", [0, 80], [0, 0]),
    ],
    downspouts: [],
    excluded_edges: [],
    totals: { linear_feet_gutter: 180, downspout_count: 0, outside_corner_miters: 4, inside_corner_miters: 0 },
    confidence: "high",
    notes: [],
    ...over,
  };
}

function classification(width: number | null, depth: number | null): PlanClassification {
  return {
    sheets: [],
    roof_plan_page: 1,
    elevation_coverage: { north: true, south: true, east: true, west: true },
    building_dimensions: { width_ft: width, depth_ft: depth, footprint_perimeter_ft: null },
    roof_scale: null,
    gutter_tiers: { lower_tier_ft: null, upper_tier_ft: null },
    min_expected_gutter_runs: null,
    min_expected_downspouts: null,
    global_rules: [],
  };
}

test("scaled area within tolerance → area_gate info OK, all 4 edges classified eave", () => {
  const v = validateBlueprintGeometry(analysis(), classification(50, 40)); // 2000 ft² stated
  assert.equal(v.scaleFtPerPx, 0.5);
  const ag = v.reviewFlags.find((f) => f.code === "area_gate");
  assert.ok(ag && ag.severity === "info", "area gate should pass within 15%");
  assert.ok(v.mass);
  assert.equal(v.mass!.edges.length, 4);
  assert.equal(v.mass!.edges.filter((e) => e.gutter).length, 4);
});

test("scaled area far off → area_gate warn", () => {
  const v = validateBlueprintGeometry(analysis(), classification(80, 40)); // 3200 ft² stated vs 2000
  const ag = v.reviewFlags.find((f) => f.code === "area_gate");
  assert.ok(ag && ag.severity === "warn", "area gate should flag a >15% miss");
});

test("no independent scale → no_schedule, plus scale-free aspect flag when aspect is wrong", () => {
  const noScale = analysis({ scale: { feet_per_unit: null, unit: "unknown", source: "test" } });
  // footprint aspect = 100/80 = 1.25; stated 40/50 = 0.8 → ratio 1.5625 > 1.35.
  const v = validateBlueprintGeometry(noScale, classification(40, 50));
  assert.ok(v.reviewFlags.some((f) => f.code === "no_schedule"));
  assert.ok(v.reviewFlags.some((f) => f.code === "area_gate" && f.severity === "warn"));
});

test("an excluded rake edge is classified rake, not eave", () => {
  const a = analysis({
    gutter_runs: [
      run("back", [0, 0], [100, 0]),
      run("right", [100, 0], [100, 80]),
      run("front", [100, 80], [0, 80]),
      // left edge has NO gutter run
    ],
    excluded_edges: [{ kind: "rake", start: { x: 0, y: 80 }, end: { x: 0, y: 0 }, reason: "gable end" }],
  });
  const v = validateBlueprintGeometry(a, classification(50, 40));
  assert.ok(v.mass);
  const eaves = v.mass!.edges.filter((e) => e.gutter).length;
  const rakes = v.mass!.edges.filter((e) => e.type === "rake").length;
  assert.equal(eaves, 3);
  assert.equal(rakes, 1);
});

test("parseScheduleAreaFt2: pulls a plausible area, prefers floor/footprint over roof, bounds junk", () => {
  assert.deepEqual(parseScheduleAreaFt2("TOTAL FLOOR AREA: 2,902 SF"), { areaFt2: 2902, label: "floor/footprint area" });
  assert.deepEqual(parseScheduleAreaFt2("ROOF AREA 3,450 SQ. FT."), { areaFt2: 3450, label: "roof area" });
  // Both present → floor/footprint wins over roof.
  const both = parseScheduleAreaFt2("ROOF AREA = 3450 SF   MAIN FLOOR 2416 SF");
  assert.equal(both?.areaFt2, 2416);
  // Below/above the plausible building range → ignored.
  assert.equal(parseScheduleAreaFt2("WINDOW DETAIL 12 SF"), null);
  assert.equal(parseScheduleAreaFt2("SITE AREA 60000 SF"), null);
  assert.equal(parseScheduleAreaFt2("no area callouts here"), null);
  // A number embedded in a larger token must not masquerade as an area.
  assert.equal(parseScheduleAreaFt2("CALL 555-1234 SF OFFICE"), null); // phone-ish
  assert.equal(parseScheduleAreaFt2("MALFORMED 1,2,345 SF"), null); // bad comma grouping
  // But a well-formed comma-grouped area still parses.
  assert.equal(parseScheduleAreaFt2("FLOOR AREA 12,480 SF")?.areaFt2, 12480);
});

test("title-block schedule area is preferred over classifier width×depth", () => {
  // Footprint polygon = 2000 ft² (50×40). Classifier says 80×40 = 3200 (wrong),
  // but the title block says 2000 → area gate should pass and cite the title block.
  const v = validateBlueprintGeometry(analysis(), classification(80, 40), {
    statedScheduleAreaFt2: 2000,
    scheduleLabel: "floor/footprint area (p3)",
  });
  const ag = v.reviewFlags.find((f) => f.code === "area_gate");
  assert.ok(ag && ag.severity === "info", "should pass using the title-block area");
  assert.ok(/title-block/.test(ag!.message), "flag should cite the title-block source");
});

test("degenerate footprint → no mass, no throw", () => {
  const v = validateBlueprintGeometry(analysis({ building_footprint: [{ x: 0, y: 0 }] }), classification(50, 40));
  assert.equal(v.mass, null);
  assert.deepEqual(v.reviewFlags, []);
});
