/**
 * Pure node tests for the legacy BlueprintAnalysis → engine validation bridge.
 * Run with: npx tsx --test lib/ai/to-masses.test.mts
 * No DB / AI / network — hand-authored analysis + classification literals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateBlueprintGeometry,
  parseScheduleAreaFt2,
  parseRoofMasses,
  parseOverallDimsFt,
  crossCheckStatedBox,
} from "./to-masses.ts";
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

test("an ARTICULATED footprint vs width×depth (bounding box) does NOT false-flag a missing plane", () => {
  // An L-shape fills only ~60% of its 64×44 ft bounding box. Comparing the
  // POLYGON area to width×depth would flag a phantom ~40% "missing plane" — but
  // the trace spans the full extent, so the gate reads OK (articulation, not loss).
  const L = [
    { x: 0, y: 0 }, { x: 128, y: 0 }, { x: 128, y: 30 },
    { x: 50, y: 30 }, { x: 50, y: 88 }, { x: 0, y: 88 },
  ];
  const v = validateBlueprintGeometry(analysis({ building_footprint: L }), classification(64, 44));
  const ag = v.reviewFlags.find((f) => f.code === "area_gate");
  assert.ok(ag, "area gate runs");
  assert.equal(ag!.severity, "info", "articulation vs a bounding box is not a missing plane");
  assert.ok(!/may be missing/.test(ag!.message), "must not blame a missing plane");
});

test("no independent scale → no_schedule, plus scale-free shape flag when elongation is wrong", () => {
  const noScale = analysis({ scale: { feet_per_unit: null, unit: "unknown", source: "test" } });
  // footprint elongation = 100/80 = 1.25; stated 100×25 → elongation 4.0 (off).
  const v = validateBlueprintGeometry(noScale, classification(100, 25));
  assert.ok(v.reviewFlags.some((f) => f.code === "no_schedule"));
  assert.ok(v.reviewFlags.some((f) => f.code === "area_gate" && f.severity === "warn"));
});

test("shape check is rotation-invariant: a 90° portrait/landscape difference does NOT flag", () => {
  const noScale = analysis({ scale: { feet_per_unit: null, unit: "unknown", source: "test" } });
  // footprint 100×80 (elong 1.25) vs stated 40×50 (elong 1.25) — same shape, rotated.
  const v = validateBlueprintGeometry(noScale, classification(40, 50));
  assert.ok(v.reviewFlags.some((f) => f.code === "no_schedule"));
  assert.ok(!v.reviewFlags.some((f) => f.code === "area_gate"), "rotation alone must not flag shape");
});

test("huge area miss is diagnosed as a SCALE MISMATCH, not a missing plane; measured LF called out as safe when shape matches", () => {
  // footprint 100×80 px @ 0.5 ft/px = 2000 sf; stated 200×160 = 32000 (16× off,
  // same 1.25 elongation) → declared scale is wrong, but the shape is fine.
  const v = validateBlueprintGeometry(analysis(), classification(200, 160));
  const ag = v.reviewFlags.find((f) => f.code === "area_gate");
  assert.ok(ag && ag.severity === "warn");
  assert.ok(/SCALE MISMATCH/.test(ag!.message), "should name a scale mismatch");
  assert.ok(/reconciles/.test(ag!.message), "self-consistent re-scale reconciles the area");
  assert.ok(/priced LF.*unaffected/.test(ag!.message), "measured LF is unaffected");
  assert.ok(!/may be missing/.test(ag!.message), "must NOT use the old 'a plane may be missing' blame");
});

test("huge area miss where even the self-consistent re-scale doesn't match → flags a possible missing wing", () => {
  const v = validateBlueprintGeometry(analysis(), classification(200, 50));
  const ag = v.reviewFlags.find((f) => f.code === "area_gate");
  assert.ok(ag && ag.severity === "warn");
  assert.ok(/SCALE MISMATCH/.test(ag!.message));
  assert.ok(/wing.*missing|re-check the footprint/.test(ag!.message));
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

test("parseScheduleAreaFt2: prefers ROOF over a 2-story floor total; bounds junk", () => {
  assert.deepEqual(parseScheduleAreaFt2("ROOF AREA 3,450 SQ. FT."), { areaFt2: 3450, label: "roof area" });
  // A 2-story total is deprioritized behind a roof area (spec: compare the
  // roof-edge polygon to a ROOF-area schedule, not a 2-floor sum).
  const both = parseScheduleAreaFt2("ROOF AREA = 3450 SF   MAIN FLOOR 2416 SF");
  assert.equal(both?.areaFt2, 3450);
  assert.equal(both?.label, "roof area");
  // "TOTAL FLOOR AREA" is a multi-story aggregate → tier 4 label.
  assert.equal(parseScheduleAreaFt2("TOTAL FLOOR AREA: 2,902 SF")?.label, "total/conditioned area");
  // Below/above the plausible building range → ignored.
  assert.equal(parseScheduleAreaFt2("WINDOW DETAIL 12 SF"), null);
  assert.equal(parseScheduleAreaFt2("SITE AREA 60000 SF"), null);
  assert.equal(parseScheduleAreaFt2("no area callouts here"), null);
  // A number embedded in a larger token must not masquerade as an area.
  assert.equal(parseScheduleAreaFt2("CALL 555-1234 SF OFFICE"), null); // phone-ish
  assert.equal(parseScheduleAreaFt2("MALFORMED 1,2,345 SF"), null); // bad comma grouping
  assert.equal(parseScheduleAreaFt2("FLOOR AREA 12,480 SF")?.areaFt2, 12480);
});

test("parseScheduleAreaFt2: real Woodinville callouts — rejects site/coverage/partial, prefers the roof area", () => {
  // Individual callouts straight off the plan.
  assert.equal(parseScheduleAreaFt2("LOT AREA: 21001 SF"), null); // site area
  assert.equal(parseScheduleAreaFt2("TOTAL LOT COV'G AREA: 9346 SF"), null); // coverage
  assert.equal(parseScheduleAreaFt2("GARAGE AREA: 674 SF"), null); // partial structure
  assert.equal(parseScheduleAreaFt2("BUILDING FOOTPRINT: 2408 SF")?.label, "footprint area");
  assert.equal(parseScheduleAreaFt2("Roof Area 2902 s.f.")?.areaFt2, 2902);
  // A roof area under an IMPERVIOUS section header is still a roof area.
  assert.equal(parseScheduleAreaFt2("IMPERVIOUS AREA ROOF & GUTTERS AREA: 4018 SF")?.label, "roof area");

  // The whole jumble → picks the largest ROOF area, not the lot (21001) or the
  // 2-story CONDITIONED FLOOR total (4667).
  const blob =
    "STRUC LOT COV'GS LOT AREA: 21001 SF BUILDING FOOTPRINT: 2408 SF TOTAL LOT COV'G AREA: 9346 SF " +
    "IMPERVIOUS AREA ROOF & GUTTERS AREA: 4018 SF GARAGE AREA: 674 SF CONDITIONED FLOOR AREA 4667 SF " +
    "Roof Area 2902 s.f. Roof Area 228 s.f. Roof Area 180 s.f.";
  const hit = parseScheduleAreaFt2(blob);
  assert.ok(hit);
  assert.equal(hit!.label, "roof area");
  assert.equal(hit!.areaFt2, 4018);
});

test("parseRoofMasses: pulls per-mass roof areas from the roof-vent schedule (real Woodinville)", () => {
  const text =
    "ROOF VENTILATION Standard Truss / Scissor Truss Roof Framing Assembly: UPPER ROOF " +
    "Roof Area 2902 s.f. Ventilation Required 2902 s.f. x 144 / 300 = 1392.96 s.i. " +
    "ROOF VENTILATION PATIO ROOF Roof Area 228 s.f. Ventilation Required 228 s.f. " +
    "ROOF VENTILATION PORCH ROOF Roof Area 180 s.f. Ventilation Required 180 s.f.";
  const masses = parseRoofMasses(text);
  const byLabel = Object.fromEntries(masses.map((m) => [m.label, m.areaFt2]));
  assert.equal(byLabel.upper, 2902);
  assert.equal(byLabel.patio, 228);
  assert.equal(byLabel.porch, 180);
  // depth = area ÷ span (LAW 2): a 180 sf porch roof over a 12 ft span ⇒ 15 ft.
  assert.equal(180 / 12, 15);
  // The "ROOF & GUTTERS AREA" aggregate is NOT a labelled roof mass.
  assert.equal(parseRoofMasses("IMPERVIOUS AREA ROOF & GUTTERS AREA: 4018 SF").length, 0);
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

test("OVERSIZED trace vs width×depth box → verdict names the oversize, not 'may not cover'", () => {
  // Trace box = 2000 ft² (50×40 at 0.5 ft/px) vs stated 42×36 = 1512 ft² —
  // 32% over. The old absolute-diff message claimed "the trace may not cover
  // the full building", the exact opposite of an inflated trace/scale (the
  // 1168G raster set: 4876 sf envelope vs a 3264 sf stated box).
  const v = validateBlueprintGeometry(analysis(), classification(42, 36));
  const ag = v.reviewFlags.find((f) => f.code === "area_gate");
  assert.ok(ag && ag.severity === "warn", "a 32% oversize still flags");
  assert.ok(/OVERSIZED/.test(ag!.message), "verdict should name the oversize direction");
  assert.ok(!/may not cover/.test(ag!.message), "must not claim under-coverage on an oversized trace");
});

test("UNDERSIZED trace vs width×depth box keeps the under-coverage verdict", () => {
  // Trace box 2000 ft² vs stated 80×40 = 3200 ft² → 37.5% under.
  const v = validateBlueprintGeometry(analysis(), classification(80, 40));
  const ag = v.reviewFlags.find((f) => f.code === "area_gate");
  assert.ok(ag && ag.severity === "warn");
  assert.ok(/may not cover/.test(ag!.message), "under-coverage verdict preserved");
  assert.ok(!/OVERSIZED/.test(ag!.message));
});

// ---------------------------------------------------------------------------
// crossCheckStatedBox — the stated width×depth is a VISION read; printed
// dimension evidence (text overalls / dim-chip reads) corrects it before it
// becomes the area-gate baseline. Real failure: Woodinville stated 64×71.5
// (4576 sf) vs printed overalls 64'-0"/51'-0" → a good trace flagged 35% off.
// ---------------------------------------------------------------------------

test("crossCheckStatedBox: Woodinville — misread depth 71.5' corrected to the printed 51' (baseline 3264)", () => {
  const c = crossCheckStatedBox(64, 71.5, [64, 51]);
  assert.equal(c.corrected, true);
  assert.equal(c.widthFt, 64);
  assert.equal(c.depthFt, 51);
  assert.equal(c.widthFt * c.depthFt, 3264);
  assert.ok(c.note && /printed 64' × 51' overalls/.test(c.note), "note cites the printed pair");
  assert.ok(/vision-read depth 71\.5' looked wrong/.test(c.note!), "note names the bad axis + value");
});

test("crossCheckStatedBox: agreeing stated box is untouched (incl. a 90° width↔depth swap)", () => {
  assert.deepEqual(crossCheckStatedBox(64, 51, [64, 51]), { widthFt: 64, depthFt: 51, corrected: false, note: null });
  // Reads pair to the SWAPPED axes — greedy anchoring is orientation-agnostic.
  assert.equal(crossCheckStatedBox(51, 64, [64, 51]).corrected, false);
});

test("crossCheckStatedBox: conservative gates — one read, no anchor, or junk reads keep the stated box", () => {
  // A single read can't both anchor the pairing and contradict an axis.
  assert.equal(crossCheckStatedBox(64, 71.5, [64]).corrected, false);
  // Neither axis agrees with any read → the reads aren't this box's overalls.
  assert.equal(crossCheckStatedBox(100, 30, [64, 51]).corrected, false);
  // A porch/garage sub-dim (24') is not building-scale next to a 50×52 box —
  // it must not hijack the depth even though the 51' read anchors the width.
  assert.equal(crossCheckStatedBox(50, 52, [51, 24]).corrected, false);
  // No reads at all.
  assert.equal(crossCheckStatedBox(64, 71.5, []).corrected, false);
  assert.equal(crossCheckStatedBox(64, 71.5, null).corrected, false);
});

test("crossCheckStatedBox: out-of-band values (lot line, detail dims) are filtered before pairing", () => {
  // 640' and 6' are outside 20-250; 120' is not within 0.6-1.4× of either axis
  // (a lot line) — the surviving {64, 51} pair still corrects the depth.
  const c = crossCheckStatedBox(64, 71.5, [640, 120, 64, 51, 6]);
  assert.equal(c.corrected, true);
  assert.equal(c.widthFt, 64);
  assert.equal(c.depthFt, 51);
  // Near-duplicate overalls (the same chain printed twice) dedupe first.
  const d = crossCheckStatedBox(64, 71.5, [64.2, 64, 51]);
  assert.equal(d.depthFt, 51);
});

test("crossCheckStatedBox: a within-tolerance depth read does not fire (15% is the contradiction bar)", () => {
  // Stated 64×45 vs printed {64, 51}: depth is 11.8% off the 51' read → agree.
  assert.equal(crossCheckStatedBox(64, 45, [64, 51]).corrected, false);
});

test("parseOverallDimsFt: reads printed OVERALL callouts only, both word orders, feet-inches", () => {
  assert.deepEqual(parseOverallDimsFt(`64'-0" OVERALL ... 51'-0" OVERALL`), [64, 51]);
  assert.deepEqual(parseOverallDimsFt("OVERALL: 64'-6\""), [64.5]);
  // No OVERALL keyword → not an overall (interior dims / lot lines can't leak).
  assert.deepEqual(parseOverallDimsFt(`24'-0" GARAGE 120'-0" PROPERTY LINE`), []);
  // Out of the 20-250 ft building band.
  assert.deepEqual(parseOverallDimsFt(`12'-0" OVERALL 264'-0" OVERALL`), []);
  assert.deepEqual(parseOverallDimsFt(""), []);
  // Duplicate callouts (same overall on two sheets' worth of text) dedupe.
  assert.deepEqual(parseOverallDimsFt(`64'-0" OVERALL 64'-0" OVERALL`), [64]);
});

test("area-gate baseline: printed overalls fix the phantom 'may not cover' flag (Woodinville-shaped)", () => {
  // Footprint 128×102 px @ 0.5 ft/px = 64×51 ft → a 3264 sf trace envelope.
  // Stage-1 vision read the depth as 71.5' → stated box 4576 sf → 28.7% under
  // → warn FLAG on a perfectly good trace.
  const rect = [
    { x: 0, y: 0 },
    { x: 128, y: 0 },
    { x: 128, y: 102 },
    { x: 0, y: 102 },
  ];
  const before = validateBlueprintGeometry(analysis({ building_footprint: rect }), classification(64, 71.5));
  const agBefore = before.reviewFlags.find((f) => f.code === "area_gate");
  assert.ok(agBefore && agBefore.severity === "warn", "without evidence the phantom box flags");
  assert.ok(/may not cover/.test(agBefore!.message));

  // With the printed overalls {64, 51}, the baseline becomes 64×51 = 3264 and
  // the gate passes — annotated so the contractor sees WHY the box changed.
  const after = validateBlueprintGeometry(analysis({ building_footprint: rect }), classification(64, 71.5), {
    printedDimsFt: [64, 51],
  });
  const ag = after.reviewFlags.find((f) => f.code === "area_gate");
  assert.ok(ag && ag.severity === "info", "corrected baseline passes the gate");
  assert.ok(/3264 sf width×depth box/.test(ag!.message), "baseline is the printed 64×51 box");
  assert.ok(/printed 64' × 51' overalls/.test(ag!.message), "note cites the printed overalls");
  assert.ok(/vision-read depth 71\.5' looked wrong/.test(ag!.message), "note names the misread axis");
  // Flag-only: geometry, edges, and scale are byte-identical to the uncorrected run.
  assert.equal(after.scaleFtPerPx, before.scaleFtPerPx);
  assert.deepEqual(after.mass!.outline, before.mass!.outline);
  assert.deepEqual(after.mass!.edges, before.mass!.edges);
});

test("area-gate baseline: agreeing evidence leaves the stated box and message unchanged", () => {
  const opts = { printedDimsFt: [50, 40] };
  const v = validateBlueprintGeometry(analysis(), classification(50, 40), opts); // 2000 ft² stated, trace 2000
  const ag = v.reviewFlags.find((f) => f.code === "area_gate");
  assert.ok(ag && ag.severity === "info");
  assert.ok(!/looked wrong/.test(ag!.message), "no correction note when the box agrees");
});

test("area-gate baseline: no-scale path — a corrected box silences the shape flag LOUDLY, not silently", () => {
  const noScale = analysis({ scale: { feet_per_unit: null, unit: "unknown", source: "test" } });
  // Footprint 100×80 px (elongation 1.25); vision box 50×25 (elongation 2.0)
  // would shape-flag, but the printed {50, 40} overalls correct the depth →
  // no shape flag, and the no_schedule line carries the annotation.
  const v = validateBlueprintGeometry(noScale, classification(50, 25), { printedDimsFt: [50, 40] });
  assert.ok(!v.reviewFlags.some((f) => f.code === "area_gate"), "corrected proportions pass the shape check");
  const ns = v.reviewFlags.find((f) => f.code === "no_schedule");
  assert.ok(ns && /printed 50' × 40' overalls/.test(ns.message), "the correction is still noted");
});
