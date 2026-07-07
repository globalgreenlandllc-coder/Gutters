/**
 * Pure node tests for reconcileEaves. Run with: npx tsx --test lib/ai/reconcile-eaves.test.mts
 * No DB, no AI, no network — operates on hand-authored BlueprintAnalysis literals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileEaves } from "./reconcile-eaves.ts";
import type { BlueprintAnalysis, BlueprintRun } from "./blueprint-from-plans.ts";

function run(
  side: BlueprintRun["side"],
  a: [number, number],
  b: [number, number],
  lengthFt: number,
): BlueprintRun {
  return {
    id: `${side}-${a[0]}`,
    side,
    start: { x: a[0], y: a[1] },
    end: { x: b[0], y: b[1] },
    length_ft: lengthFt,
    length_px: Math.hypot(b[0] - a[0], b[1] - a[1]),
    drains_to: [],
    tier: "lower",
  };
}

function base(over: Partial<BlueprintAnalysis>): BlueprintAnalysis {
  return {
    scale: { feet_per_unit: null, unit: "pixels", source: "test" },
    building_footprint: [],
    gutter_runs: [],
    downspouts: [],
    excluded_edges: [],
    totals: { linear_feet_gutter: 0, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
    confidence: "medium",
    notes: [],
    ...over,
  };
}

// A symmetric "H/U" house: 200 wide × 120 tall rectangle. Top (front) and
// bottom (rear) walls each carry an eave. We simulate the AI guttering the
// FRONT wall but DROPPING the symmetric REAR wall.
const FOOT: BlueprintAnalysis["building_footprint"] = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 120 },
  { x: 0, y: 120 },
];

test("symmetric drop: re-adds the missing rear eave, copies twin length_ft", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 40), // front (top) guttered
      run("left", [0, 0], [0, 120], 24),
      run("right", [200, 0], [200, 120], 24),
      // rear (bottom) intentionally DROPPED
    ],
    excluded_edges: [],
    totals: { linear_feet_gutter: 88, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis, reconcileNotes } = reconcileEaves(a);
  assert.equal(analysis.gutter_runs.length, 4, "one run added");
  const added = analysis.gutter_runs[3];
  assert.equal(added.length_ft, 40, "copies front twin's length_ft exactly");
  assert.equal(added.side, "back", "mirrored side front->back");
  assert.equal(analysis.totals.linear_feet_gutter, 128, "total += 40");
  assert.ok(reconcileNotes.some((n) => /Auto-added/.test(n)));
});

test("no-op when every wall is already guttered or raked", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 40),
      run("back", [0, 120], [200, 120], 40),
    ],
    excluded_edges: [
      { kind: "rake", start: { x: 0, y: 0 }, end: { x: 0, y: 120 }, reason: "gable" },
      { kind: "rake", start: { x: 200, y: 0 }, end: { x: 200, y: 120 }, reason: "gable" },
    ],
    totals: { linear_feet_gutter: 80, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis } = reconcileEaves(a);
  assert.equal(analysis.gutter_runs.length, 2, "nothing added");
  assert.equal(analysis.totals.linear_feet_gutter, 80, "total unchanged");
});

test("asymmetric uncovered wall: NOT priced, only flagged", () => {
  // Front guttered; rear is a real gable rake but UNMARKED (no excluded_edge),
  // and there is NO guttered twin (left/right are short rakes, not mirrors of
  // the long rear wall). Should flag, not add.
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [run("front", [0, 0], [200, 0], 40)],
    excluded_edges: [],
    totals: { linear_feet_gutter: 40, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis, reconcileNotes } = reconcileEaves(a);
  // rear wall's twin IS the front (guttered, parallel, same length) -> it WILL
  // be auto-added. left/right have no guttered twin -> flagged. So expect rear
  // added (1) and left+right flagged.
  const added = analysis.gutter_runs.filter((r) => r.id.startsWith("recon-"));
  assert.equal(added.length, 1, "only the symmetric rear is added");
  assert.equal(added[0].side, "back");
  assert.ok(reconcileNotes.some((n) => /Closure check: 2 exterior wall/.test(n)), "left+right flagged");
});

test("malformed footprint (<4 pts) -> unchanged", () => {
  const a = base({ building_footprint: [{ x: 0, y: 0 }, { x: 10, y: 0 }], gutter_runs: [run("front", [0, 0], [10, 0], 10)] });
  const { analysis, reconcileNotes } = reconcileEaves(a);
  assert.equal(analysis.gutter_runs.length, 1);
  assert.equal(reconcileNotes.length, 0);
});

test("NaN coords in footprint don't crash; degrade safely", () => {
  const a = base({
    building_footprint: [
      { x: 0, y: 0 },
      { x: NaN, y: 0 },
      { x: 200, y: 120 },
      { x: 0, y: 120 },
    ],
    gutter_runs: [run("front", [0, 0], [200, 0], 40)],
  });
  const { analysis } = reconcileEaves(a);
  assert.ok(Array.isArray(analysis.gutter_runs));
});

test("shallow recess survives the smaller tolerance", () => {
  // 300-wide house, front wall steps in 6px (a shallow porch recess) between
  // two segments. The recessed center edge is guttered on the FRONT; the
  // mirror on the REAR is dropped. Skeleton's 3% tol (=9px) would snap the 6px
  // recess away; reconcile's 1.2% tol (=3.6px) keeps it.
  const foot = [
    { x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 6 }, { x: 180, y: 6 }, { x: 180, y: 0 }, { x: 300, y: 0 },
    { x: 300, y: 120 }, { x: 180, y: 120 }, { x: 180, y: 114 }, { x: 120, y: 114 }, { x: 120, y: 120 }, { x: 0, y: 120 },
  ];
  const a = base({
    building_footprint: foot,
    gutter_runs: [
      run("front", [120, 6], [180, 6], 12), // the recessed front-center eave
      run("front", [0, 0], [120, 0], 24),
      run("front", [180, 0], [300, 0], 24),
      run("left", [0, 0], [0, 120], 24),
      run("right", [300, 0], [300, 120], 24),
      run("back", [0, 120], [120, 120], 24),
      run("back", [180, 120], [300, 120], 24),
      // rear recessed center [120,114]-[180,114] DROPPED
    ],
    totals: { linear_feet_gutter: 156, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis } = reconcileEaves(a);
  const added = analysis.gutter_runs.filter((r) => r.id.startsWith("recon-"));
  assert.ok(added.some((r) => r.side === "back" && r.length_ft === 12), "recessed rear-center eave re-added with copied 12 ft");
});

// ── closeVectorPerimeter — the vector-authoritative closure ──────────────────
import { closeVectorPerimeter } from "./reconcile-eaves.ts";

test("vector closure: unclassified edges price as eaves at the runs' own scale", () => {
  // 200×120 vector footprint; the AI traced only front + left (0.5 ft/px).
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 100), // 200 px → 0.5 ft/px
      run("left", [0, 0], [0, 120], 60),
    ],
    totals: { linear_feet_gutter: 160, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis, reconcileNotes } = closeVectorPerimeter(a);
  assert.equal(analysis.gutter_runs.length, 4, "right + rear added");
  const added = analysis.gutter_runs.slice(2);
  const bySide = Object.fromEntries(added.map((r) => [r.side, r]));
  // Side words follow the canvas convention (bottom = front, orientation-anchor).
  assert.equal(bySide.front?.length_ft, 100, "bottom edge = 200 px × 0.5");
  assert.equal(bySide.right?.length_ft, 60, "right edge = 120 px × 0.5");
  assert.equal(analysis.totals.linear_feet_gutter, 320);
  assert.ok(reconcileNotes.some((n) => /Vector closure/.test(n)));
});

test("vector closure: a gable-end face read (continuous_eave=false) keeps its edge unguttered", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 100),
      run("left", [0, 0], [0, 120], 60),
    ],
  });
  const { analysis, reconcileNotes } = closeVectorPerimeter(a, {
    // default orientation: east = +x = the right edge
    perFace: { east: { readable: true, continuous_eave: false } },
  });
  assert.equal(analysis.gutter_runs.length, 3, "only the bottom edge added — east edge is a gable end");
  assert.equal(analysis.gutter_runs[2].side, "front");
  assert.ok(reconcileNotes.some((n) => /gable-end/.test(n)));
});

test("vector closure: excluded (rake) edges and covered edges are not re-priced; no runs → no-op", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 100),
      run("left", [0, 0], [0, 120], 60),
      run("right", [200, 0], [200, 120], 60),
    ],
    excluded_edges: [
      { id: "x1", kind: "rake", start: { x: 0, y: 120 }, end: { x: 200, y: 120 }, reason: "gable end" },
    ],
  });
  const r1 = closeVectorPerimeter(a);
  assert.equal(r1.analysis.gutter_runs.length, 3, "everything classified — nothing added");
  // No measured runs at all → no independent scale → untouched.
  const r2 = closeVectorPerimeter(base({ building_footprint: FOOT }));
  assert.equal(r2.analysis.gutter_runs.length, 0);
  assert.equal(r2.reconcileNotes.length, 0);
});
