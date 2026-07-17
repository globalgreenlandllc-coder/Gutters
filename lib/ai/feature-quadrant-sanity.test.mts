/**
 * Pure node tests for the roof-page feature-quadrant sanity pass. Run:
 *   npx tsx --test lib/ai/feature-quadrant-sanity.test.mts
 *
 * Doctrine under test: LF-neutral RELABEL only (geometry/lengths/tier/totals
 * byte-untouched), ONE aggregated loud note per feature, and byte-identical
 * degrade when the roof page located no features (old stashes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { featureQuadrantSanity } from "./feature-quadrant-sanity.ts";
import type { BlueprintAnalysis, BlueprintRun } from "./blueprint-from-plans.ts";

type Pt = { x: number; y: number };

// Analysis space: y-down canvas, front-at-bottom (front = max-y half) — the
// tier-corner-veto HOUSE_NORMALS convention. 100×60 outline, center (50,30).
const RECT: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 0, y: 60 },
];

let seq = 0;
function run(a: Pt, b: Pt, over?: Partial<BlueprintRun>): BlueprintRun {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return {
    id: `r${++seq}`,
    side: "front",
    start: { ...a },
    end: { ...b },
    length_ft: Math.round(len * 0.5 * 10) / 10,
    length_px: len,
    drains_to: [],
    ...over,
  };
}

function analysisOf(runs: BlueprintRun[], fp: Pt[] = RECT): BlueprintAnalysis {
  return {
    scale: { feet_per_unit: 0.5, unit: "pixels", source: "test" },
    building_footprint: fp.map((p) => ({ ...p })),
    gutter_runs: runs,
    downspouts: [],
    excluded_edges: [],
    totals: {
      linear_feet_gutter: runs.reduce((s, r) => s + (r.length_ft ?? 0), 0),
      downspout_count: 0,
      outside_corner_miters: 0,
      inside_corner_miters: 0,
    },
    confidence: "high",
    notes: [],
  };
}

const lfSum = (a: BlueprintAnalysis) =>
  a.gutter_runs.reduce((s, r) => s + (r.length_ft ?? 0), 0);

// Quadrant sample midpoints (well outside the 8% center bands):
// rear-left run: x∈[0,20] y=0 → mid (10,0). front-right: x∈[80,100] y=60.
const rearLeftRun = (over?: Partial<BlueprintRun>) =>
  run({ x: 0, y: 0 }, { x: 20, y: 0 }, { side: "back", ...over });
const frontRightRun = (over?: Partial<BlueprintRun>) =>
  run({ x: 80, y: 60 }, { x: 100, y: 60 }, over);

test("degrade — no feature_quadrants → the caller's OWN analysis object, byte-identical", () => {
  const a = analysisOf([rearLeftRun({ feature: "garage", tier: "lower" })]);
  const snap = structuredClone(a);
  for (const fq of [null, undefined] as const) {
    const out = featureQuadrantSanity({ analysis: a, featureQuadrants: fq });
    assert.equal(out.analysis, a, "same object reference");
    assert.deepEqual(a, snap, "input byte-untouched");
    assert.deepEqual(out.notes, []);
    assert.deepEqual(out.clearedRunIds, []);
  }
});

test("contradiction — garage run at rear-left vs a front-right read → label cleared, tier + LF + totals byte-identical, aggregated note", () => {
  const garage = rearLeftRun({ feature: "garage", tier: "lower" });
  const main = frontRightRun({ feature: "main" });
  const a = analysisOf([garage, main]);
  const snap = structuredClone(a);

  const out = featureQuadrantSanity({
    analysis: a,
    featureQuadrants: { garage: "front-right", porch: null, patio: null, outdoor_living: null },
  });

  // input analysis never mutated (new object returned instead)
  assert.deepEqual(a, snap, "caller's analysis byte-untouched");
  assert.notEqual(out.analysis, a);

  const cleared = out.analysis.gutter_runs[0];
  assert.equal("feature" in cleared, false, "feature key removed");
  assert.equal(cleared.tier, "lower", "tier untouched");
  assert.equal(cleared.length_ft, garage.length_ft, "LF untouched");
  assert.deepEqual(cleared.start, garage.start);
  assert.deepEqual(cleared.end, garage.end);
  assert.equal(out.analysis.gutter_runs[1], main, "untouched run keeps object identity");
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ length_ft identical");
  assert.deepEqual(out.analysis.totals, snap.totals, "totals identical");
  assert.deepEqual(out.clearedRunIds, [garage.id]);

  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /^🏷 1 run label\(s\) moved off garage/);
  assert.match(out.notes[0], /roof plan puts the garage at the front-right/);
  assert.match(out.notes[0], /those runs sit at rear-left/);
  assert.match(out.notes[0], /Lengths and pricing unchanged/);
  assert.match(out.notes[0], /labels cleared to UPPER ROOF/);
});

test("agreement — a run in the READ quadrant keeps its label (same object); multiple offenders aggregate into ONE note", () => {
  const goodGarage = frontRightRun({ feature: "garage" });
  const badGarage1 = rearLeftRun({ feature: "garage" });
  const badGarage2 = run({ x: 0, y: 60 }, { x: 15, y: 60 }, { feature: "garage" }); // front-left
  const a = analysisOf([goodGarage, badGarage1, badGarage2]);
  const snap = structuredClone(a);

  const out = featureQuadrantSanity({
    analysis: a,
    featureQuadrants: { garage: "front-right" },
  });
  assert.deepEqual(a, snap);
  assert.equal(out.analysis.gutter_runs[0], goodGarage, "correct-quadrant run untouched, identity kept");
  assert.equal(out.analysis.gutter_runs[0].feature, "garage");
  assert.equal("feature" in out.analysis.gutter_runs[1], false);
  assert.equal("feature" in out.analysis.gutter_runs[2], false);
  assert.equal(out.notes.length, 1, "one AGGREGATED note per feature");
  assert.match(out.notes[0], /2 run label\(s\) moved off garage/);
  assert.match(out.notes[0], /rear-left \/ front-left|front-left \/ rear-left/);
  assert.equal(out.clearedRunIds.length, 2);
});

test("'center' read / null read / unchecked features → no action", () => {
  const a = analysisOf([
    rearLeftRun({ feature: "garage" }),
    frontRightRun({ feature: "deck" }), // deck is not quadrant-checked
  ]);
  const snap = structuredClone(a);
  const out = featureQuadrantSanity({
    analysis: a,
    featureQuadrants: { garage: "center", porch: null, outdoor_living: "front-left" },
  });
  assert.equal(out.analysis, a, "no verdict → same object");
  assert.deepEqual(a, snap);
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.clearedRunIds, []);
});

test("dead band — a midpoint near a center line can't contradict (label kept)", () => {
  // Midpoint (52, 0): x within 8% of center x=50 (band ±8) → ambiguous.
  const nearCenter = run({ x: 42, y: 0 }, { x: 62, y: 0 }, { side: "back", feature: "garage" });
  const a = analysisOf([nearCenter]);
  const snap = structuredClone(a);
  const out = featureQuadrantSanity({
    analysis: a,
    featureQuadrants: { garage: "front-right" },
  });
  assert.equal(out.analysis, a);
  assert.deepEqual(a, snap);
  assert.deepEqual(out.notes, []);
});

test("porch + patio are checked independently; per-feature notes", () => {
  const porch = rearLeftRun({ feature: "porch" });
  const patio = frontRightRun({ feature: "patio" });
  const a = analysisOf([porch, patio]);
  const out = featureQuadrantSanity({
    analysis: a,
    featureQuadrants: { porch: "front-left", patio: "rear-right" },
  });
  assert.equal(out.clearedRunIds.length, 2);
  assert.equal(out.notes.length, 2, "one aggregated note PER feature");
  assert.ok(out.notes.some((n) => /moved off porch/.test(n)));
  assert.ok(out.notes.some((n) => /moved off patio/.test(n)));
});

test("never throws — garbage footprint/runs degrade unchanged", () => {
  assert.doesNotThrow(() => {
    const bad = {
      building_footprint: [{ x: NaN, y: NaN }],
      gutter_runs: [{ id: "x", start: { x: NaN, y: NaN }, end: { x: NaN, y: NaN }, feature: "garage" }],
      totals: {},
      notes: [],
    } as unknown as BlueprintAnalysis;
    const out = featureQuadrantSanity({
      analysis: bad,
      featureQuadrants: { garage: "front-right" },
    });
    assert.equal(out.analysis, bad, "degenerate space → unchanged");
    assert.deepEqual(out.notes, []);
  });

  // empty runs / missing arrays
  const empty = featureQuadrantSanity({
    analysis: {} as unknown as BlueprintAnalysis,
    featureQuadrants: { garage: "front-right" },
  });
  assert.deepEqual(empty.notes, []);
});
