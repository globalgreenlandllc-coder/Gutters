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

test("buildEngineTakeoff: a face read as a FULL GABLE END (continuous_eave false) drops that edge", () => {
  const perFace = {
    east: {
      face: "east",
      readable: true,
      unreadable_reason: null,
      gable_count: 1,
      continuous_eave: false, // full gable end — no gutter across this face
      gables: [],
      projections: [],
      projection_cues: [],
      confidence: "high",
    },
  } as Record<string, import("./face-merge.ts").FaceReadingRaw>;
  const b = buildEngineTakeoff(analysis(), perFace);
  assert.ok(b);
  // Footprint 100×80: the east edge (x=100, 80px) is the gable end → excluded.
  // eaves = top(100) + bottom(100) + left(80) = 280 px × 0.5 = 140 ft.
  assert.equal(b!.eaveLfFt, 140);
  assert.equal(b!.takeoff.masses[0].edges.filter((e) => e.gutter).length, 3);
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

test("buildEngineTakeoff: a FLUSH cross-gable draws ridge-back + 2 valleys, zero gutter (Stage 1 end-to-end)", () => {
  // A plain gable read on the north face (NOT on posts/beam, no projection cue)
  // is placed FLUSH by place-gables. The engine must still draw it as a real
  // cross-gable — a ridge-back + two valleys (source "gable:…") — while adding
  // ZERO gutter. This is the AI-independent proof of Stage 1: the placement →
  // engine interior geometry the canvas renders (as engine-gable-* lines) is
  // present and pricing-neutral, without any model call.
  const perFace = {
    north: {
      face: "north",
      readable: true,
      unreadable_reason: null,
      gable_count: 1,
      continuous_eave: true, // eave runs whole beneath the flush gable
      gables: [
        {
          id: "front_gable",
          kind: "main",
          span_ft: 20,
          pitch: 6,
          position_frac: 0.5,
          eave_condition_guess: "flush",
          supported_on: "wall",
          shows_projection_cue: false,
          notes: "",
        },
      ],
      projections: [],
      projection_cues: [],
      confidence: "high",
    },
  } as Record<string, import("./face-merge.ts").FaceReadingRaw>;

  const b = buildEngineTakeoff(analysis(), perFace);
  assert.ok(b, "bundle builds with a footprint + scale");
  const interior = b!.takeoff.masses.flatMap((m) => m.interior);
  const gableValleys = interior.filter((e) => e.type === "valley" && e.source?.startsWith("gable:"));
  const gableRidges = interior.filter((e) => e.type === "ridge" && e.source?.startsWith("gable:"));
  assert.equal(gableValleys.length, 2, "flush cross-gable draws two valleys (the Stage 1 fix)");
  assert.equal(gableRidges.length, 1, "flush cross-gable draws one ridge-back");
  // Pricing-safe: the flush gable adds NO guttered side eaves, so LF stays the
  // clean perimeter (180 ft) — identical to the no-gable case.
  assert.equal(b!.eaveLfFt, 180);
  const gableEaves = b!.takeoff.masses
    .flatMap((m) => m.edges)
    .filter((e) => e.gutter && e.source?.startsWith("gable:"));
  assert.equal(gableEaves.length, 0, "flush gable contributes zero gutter");
});

test("buildEngineTakeoff: a garage-jog footprint decomposes into main + garage (clean tiers), LF-neutral", () => {
  // Main body 64×44 with a garage jog out the right side (24×30 at y∈[10,40]).
  const GARAGE_FP = [
    { x: 0, y: 0 },
    { x: 64, y: 0 },
    { x: 64, y: 10 },
    { x: 88, y: 10 },
    { x: 88, y: 40 },
    { x: 64, y: 40 },
    { x: 64, y: 44 },
    { x: 0, y: 44 },
  ];
  const b = buildEngineTakeoff(
    analysis({
      building_footprint: GARAGE_FP,
      gutter_runs: [run([0, 0], [64, 0])], // one run ⇒ ftPerPx = 0.5; every edge defaults to an eave
    }),
  );
  assert.ok(b);
  assert.equal(b!.ftPerPx, 0.5);
  // Two tiers now, not one whole-house mass.
  assert.equal(b!.takeoff.masses.length, 2, "main + garage");
  // Each tier drew a CLEAN straight-skeleton — the whole-house fan reject is gone.
  for (const m of b!.takeoff.masses) {
    assert.ok(m.interior.some((e) => e.source === "skeleton"), `${m.name} has a clean skeleton`);
  }
  assert.equal(
    b!.takeoff.reviewFlags.filter((f) => f.code === "skeleton_rejected").length,
    0,
    "no tier's skeleton is rejected",
  );
  // LF-neutral: full guttered perimeter 264 px × 0.5 = 132 ft — the shared
  // main↔garage wall is an interior cut, guttered on NEITHER tier.
  assert.equal(b!.eaveLfFt, 132);
});

test("buildEngineTakeoff: with a roof schedule, each decomposed tier gets its own area gate", () => {
  // Models the real post-swap analysis: building_footprint is the exact jogged
  // vector outline (main 2816 px² → 704 ft², garage 720 px² → 180 ft² at 0.5
  // ft/px), and a roof schedule is present. Each tier should match a schedule
  // area and be gated against it — the per-tier validation the single mass never got.
  const GARAGE_FP = [
    { x: 0, y: 0 },
    { x: 64, y: 0 },
    { x: 64, y: 10 },
    { x: 88, y: 10 },
    { x: 88, y: 40 },
    { x: 64, y: 40 },
    { x: 64, y: 44 },
    { x: 0, y: 44 },
  ];
  const b = buildEngineTakeoff(
    analysis({ building_footprint: GARAGE_FP, gutter_runs: [run([0, 0], [64, 0])] }),
    null,
    [
      { label: "upper", areaFt2: 700 },
      { label: "garage", areaFt2: 185 },
    ],
  );
  assert.ok(b);
  assert.equal(b!.takeoff.masses.length, 2);
  assert.ok(b!.takeoff.masses.every((m) => m.statedArea != null), "each tier got a stated area");
  const ag = b!.takeoff.reviewFlags.filter((f) => f.code === "area_gate");
  assert.equal(ag.length, 2, "one area gate per tier");
  assert.equal(b!.takeoff.reviewFlags.filter((f) => f.code === "no_schedule").length, 0);
  assert.ok(ag.every((f) => f.severity === "info"), "both tiers reconcile with the schedule");
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
