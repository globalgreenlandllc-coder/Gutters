/**
 * Pure node tests for the ELEVATIONS-FIRST eave-step reconcile. Run:
 *   npx tsx --test lib/ai/eave-step-reconcile.test.mts
 *
 * Doctrine under test (owner escalation round 3): a ruling-source roof jog
 * the trace missed is CARVED into the outline (inset notch / corner recess,
 * always inward, Σ priced LF preserved exactly — runs ride and split
 * proportionally); loud flags; old stored reads → byte-identical;
 * BLUEPRINT_EAVE_STEP_CARVE=0 restores the legacy suggest-don't-carve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileEaveSteps, elevationStepsForVectorGate, detectStepMirror } from "./eave-step-reconcile.ts";
import type { BlueprintAnalysis, BlueprintRun } from "./blueprint-from-plans.ts";
import type { FaceEaveStep, FaceReadingRaw } from "./face-merge.ts";

type Pt = { x: number; y: number };

// ————————————————————————————— fixtures —————————————————————————————
// Analysis space: y-down canvas, front-at-bottom (front = max-y side) — the
// tier-corner-veto HOUSE_NORMALS convention. Scale: 0.5 ft per ring unit.

/** Plain 100×60 rectangle (50×30 ft). */
const RECT: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 0, y: 60 },
];

/** Same building with a REAL traced roof jog on the FRONT face: y=60 for
 *  x∈[60,100], stepping back to y=50 for x∈[0,60] (step at u=60, frac 0.6). */
const STEPPED: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 60, y: 60 },
  { x: 60, y: 50 },
  { x: 0, y: 50 },
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

function rectRuns(): BlueprintRun[] {
  return [
    run({ x: 0, y: 60 }, { x: 100, y: 60 }),
    run({ x: 0, y: 0 }, { x: 100, y: 0 }, { side: "back" }),
    run({ x: 0, y: 0 }, { x: 0, y: 60 }, { side: "left" }),
    run({ x: 100, y: 0 }, { x: 100, y: 60 }, { side: "right" }),
  ];
}

function steppedRuns(): BlueprintRun[] {
  return [
    run({ x: 60, y: 60 }, { x: 100, y: 60 }),
    run({ x: 0, y: 50 }, { x: 60, y: 50 }),
    run({ x: 60, y: 50 }, { x: 60, y: 60 }),
    run({ x: 0, y: 0 }, { x: 100, y: 0 }, { side: "back" }),
  ];
}

function analysisOf(fp: Pt[], runs: BlueprintRun[]): BlueprintAnalysis {
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

function face(
  over: Partial<FaceReadingRaw> & { face: FaceReadingRaw["face"] },
): FaceReadingRaw {
  return {
    readable: true,
    unreadable_reason: null,
    gable_count: 0,
    continuous_eave: true,
    gables: [],
    projections: [],
    projection_cues: [],
    confidence: "high",
    ...over,
  };
}

function step(frac: number | null, direction: "up" | "down" | null = "down", over?: Partial<FaceEaveStep>): FaceEaveStep {
  return { position_frac: frac, direction, offset_ft: null, kind: "unknown", notes: "", ...over };
}

const lfSum = (a: BlueprintAnalysis) =>
  a.gutter_runs.reduce((s, r) => s + (r.length_ft ?? 0), 0);

/** Invariant every branch must hold: geometry + priced LF byte-untouched. */
function assertUntouched(input: BlueprintAnalysis, snapshot: BlueprintAnalysis, out: { analysis: BlueprintAnalysis }) {
  assert.equal(out.analysis, input, "returns the caller's analysis object");
  assert.deepEqual(input, snapshot, "analysis byte-untouched");
  assert.equal(lfSum(out.analysis), lfSum(snapshot), "Σ length_ft identical");
  assert.deepEqual(out.analysis.totals, snapshot.totals, "totals identical");
}

// ————————————————————————————— tests —————————————————————————————

test("(1) degradation — no face carries an eave_steps key → byte-identical passthrough", () => {
  const a = analysisOf(STEPPED, steppedRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: {
      front: face({ face: "front" }), // old-schema read: no eave_steps key
      rear: face({ face: "rear" }),
    },
  });
  assertUntouched(a, snap, out);
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.suggestedEaves, []);
  assert.deepEqual(out.wallJogFlags, []);
  assert.deepEqual(out.verifiedJogIds, []);

  // null perFace degrades the same way
  const out2 = reconcileEaveSteps({ analysis: a, perFace: null });
  assertUntouched(a, snap, out2);
  assert.deepEqual(out2.notes, []);
});

test("(2) unreadable face / field-absent face contributes nothing", () => {
  const a = analysisOf(STEPPED, steppedRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: {
      // unreadable face DOES carry steps — must be skipped silently
      front: face({ face: "front", readable: false, eave_steps: [step(0.25)] }),
      // readable face without the field — skipped silently
      rear: face({ face: "rear" }),
    },
  });
  assertUntouched(a, snap, out);
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.suggestedEaves, []);
  assert.deepEqual(out.wallJogFlags, []);
});

test("(3) ADVERSARIAL garbage step (frac 3.7, negative offset) → nothing carved, no suggestion", () => {
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: {
      front: face({
        face: "front",
        eave_steps: [
          step(3.7, "down", { offset_ft: -9 }),
          step(-0.4, "up"),
          step(null, "down"),
          step(Number.NaN, "down"),
        ],
      }),
    },
  });
  assertUntouched(a, snap, out);
  assert.deepEqual(out.suggestedEaves, [], "garbage fracs are dropped, never clamped into phantom returns");
  assert.deepEqual(out.notes, []);
});

test("(4) matched step → roof-verified note, NO suggestion, LF sum identical", () => {
  const a = analysisOf(STEPPED, steppedRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: {
      front: face({ face: "front", continuous_eave: false, eave_steps: [step(0.6, "down", { kind: "tier_drop" })] }),
    },
  });
  assertUntouched(a, snap, out);
  assert.equal(out.suggestedEaves.length, 0, "a traced jog needs no suggestion");
  assert.equal(out.verifiedJogIds.length, 1);
  assert.match(out.verifiedJogIds[0], /front@0\.60/);
  const verified = out.notes.filter((n) => /ROOF-VERIFIED/.test(n));
  assert.equal(verified.length, 1);
  assert.match(verified[0], /front/);
  assert.deepEqual(out.wallJogFlags, [], "a verified jog is not a wall-jog conflict");
});

test("(5) unmatched step (straight traced front, step at 0.25) → CARVED corner recess: shorter side recedes inward, runs split with Σ LF preserved", () => {
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { front: face({ face: "front", eave_steps: [step(0.25, "down")] }) },
  });
  assert.equal(out.analysis, a, "returns the caller's analysis object");
  // Front face (y=60), frac 0.25 → x=25; unknown recess side → the SHORTER
  // side (x<25) recedes by the 4 ft schematic (8 units, −y): the (0,60)
  // corner slides to (0,52) and the step pair (25,60)/(25,52) is inserted.
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 25, y: 60 },
      { x: 25, y: 52 },
      { x: 0, y: 52 },
    ],
    "corner recess carved into the outline",
  );
  assert.deepEqual(out.carvedJogIds, ["front@0.25"]);
  assert.deepEqual(out.suggestedEaves, [], "carved — no tap-to-add fallback left");
  const carveNotes = out.notes.filter((n) => /ROOF JOG CARVED/.test(n));
  assert.equal(carveNotes.length, 1);
  assert.match(carveNotes[0], /front/);
  assert.match(carveNotes[0], /verify/i);
  // The front run split at the step: recessed piece rides to y=52, the
  // outer piece keeps the parent id (it's longer); Σ length_ft exact.
  const frontRuns = out.analysis.gutter_runs.filter((r) => r.side === "front");
  assert.equal(frontRuns.length, 2, "front run split into two pieces");
  const recessed = frontRuns.find((r) => r.start.y === 52 && r.end.y === 52);
  const outer = frontRuns.find((r) => r.start.y === 60 && r.end.y === 60);
  assert.ok(recessed && outer, `expected one recessed + one outer piece, got ${JSON.stringify(frontRuns)}`);
  assert.equal(recessed!.length_ft, 12.5);
  assert.equal(outer!.length_ft, 37.5);
  assert.equal(outer!.id, snap.gutter_runs[0].id, "longest piece keeps the parent id");
  // The left run's corner endpoint rides into the recess; its priced LF doesn't.
  const left = out.analysis.gutter_runs.find((r) => r.side === "left")!;
  assert.deepEqual(left.end, { x: 0, y: 52 }, "perpendicular neighbor endpoint carried");
  assert.equal(left.length_ft, snap.gutter_runs[2].length_ft, "perpendicular run's priced LF untouched");
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
  assert.deepEqual(out.analysis.totals, snap.totals, "totals untouched");
});

test("(5b) kill switch BLUEPRINT_EAVE_STEP_CARVE=0 → legacy suggest-don't-carve, byte-identical geometry", () => {
  const prev = process.env.BLUEPRINT_EAVE_STEP_CARVE;
  try {
    process.env.BLUEPRINT_EAVE_STEP_CARVE = "0";
    const a = analysisOf(RECT, rectRuns());
    const snap = structuredClone(a);
    const out = reconcileEaveSteps({
      analysis: a,
      perFace: { front: face({ face: "front", eave_steps: [step(0.25, "down")] }) },
    });
    assertUntouched(a, snap, out);
    assert.equal(out.suggestedEaves.length, 1, "exactly one suggestion");
    const [p0, p1] = out.suggestedEaves[0].points;
    assert.ok(Math.abs(p0.x - 25) < 1e-6 && Math.abs(p0.y - 60) < 1e-6, `base on the front eave at x=25, got ${JSON.stringify(p0)}`);
    assert.ok(Math.abs(p1.x - 25) < 1e-6 && Math.abs(p1.y - 52) < 1e-6, `return heads inward 8 units, got ${JSON.stringify(p1)}`);
    const stepNotes = out.notes.filter((n) => /ROOF STEPS HERE/.test(n));
    assert.equal(stepNotes.length, 1);
    assert.match(stepNotes[0], /NOT carved/);
    assert.deepEqual(out.carvedJogIds, []);
  } finally {
    if (prev === undefined) delete process.env.BLUEPRINT_EAVE_STEP_CARVE;
    else process.env.BLUEPRINT_EAVE_STEP_CARVE = prev;
  }
});

test("(4b) carve depth comes from a perpendicular face's profile (capped at 8 ft), NEVER offset_ft", () => {
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: {
      front: face({ face: "front", eave_steps: [step(0.25, "down", { offset_ft: 30 })] }),
      // perpendicular (left) face measured the pop-out 10 ft deep in profile
      left: face({ face: "left", eave_steps: [], projections: [{ kind: "porch", depth_ft: 10, notes: "" }] }),
    },
  });
  // 10 ft profile is clamped to the 8 ft carve ceiling = 16 units (NOT the
  // 30 ft vertical offset_ft = 60 units, and NOT beyond the cap).
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 25, y: 60 },
      { x: 25, y: 44 },
      { x: 0, y: 44 },
    ],
    "recess sized from the perpendicular profile, capped at 8 ft",
  );
  const carve = out.notes.find((n) => /ROOF JOG CARVED/.test(n));
  assert.ok(carve);
  assert.match(carve!, /perpendicular/);
  assert.match(carve!, /~8 ft/);
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

test("(6) traced jog + straight readable read → wall-jog flag, run NOT deleted", () => {
  const a = analysisOf(STEPPED, steppedRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { front: face({ face: "front", eave_steps: [], continuous_eave: true }) },
  });
  assertUntouched(a, snap, out);
  assert.equal(out.wallJogFlags.length, 1);
  assert.match(out.wallJogFlags[0], /WALL JOG/);
  assert.match(out.wallJogFlags[0], /front/);
  assert.match(out.wallJogFlags[0], /verify/i);
  assert.match(out.wallJogFlags[0], /Nothing was removed/);
  assert.equal(out.analysis.gutter_runs.length, snap.gutter_runs.length, "no run deleted");
  assert.deepEqual(out.suggestedEaves, []);
});

test("(7) ADVERSARIAL — wall-jog flag must NOT fire when the face is unreadable or the field is absent", () => {
  const a = analysisOf(STEPPED, steppedRuns());
  const snap = structuredClone(a);
  // front (the face with the traced jog) never reported the field; rear did.
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: {
      front: face({ face: "front" }),
      rear: face({ face: "rear", eave_steps: [] }),
    },
  });
  assertUntouched(a, snap, out);
  assert.deepEqual(out.wallJogFlags, [], "no flag from a face that never reported eave_steps");

  // front unreadable (even with an empty field) → still no flag
  const out2 = reconcileEaveSteps({
    analysis: a,
    perFace: {
      front: face({ face: "front", readable: false, eave_steps: [] }),
      rear: face({ face: "rear", eave_steps: [] }),
    },
  });
  assertUntouched(a, snap, out2);
  assert.deepEqual(out2.wallJogFlags, []);
});

test("(8) viewer-frame mapping — a rear-face frac carves on the correct plan half", () => {
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { rear: face({ face: "rear", eave_steps: [step(0.25, "down")] }) },
  });
  // REAR viewer's left = house-RIGHT: frac 0.25 → x = 100 − 25 = 75, and the
  // shorter (viewer-left) side x∈[75,100] recedes inward (+y) by 8 units.
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 75, y: 0 },
      { x: 75, y: 8 },
      { x: 100, y: 8 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ],
    "rear frac 0.25 carves the plan's right half inward",
  );
  assert.deepEqual(out.carvedJogIds, ["rear@0.25"]);
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

test("(9) hip inner return emitted on a hipped face after the carve; suppressed when a lower run covers it", () => {
  // Unsuppressed: rear hipped, step at frac 0.25, direction 'down' (lower to
  // the viewer's right = house-left = −x). The step itself is CARVED (same
  // geometry as test 8); the hip inner leg stays an unpriced suggestion
  // anchored at the carved inner corner.
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { rear: face({ face: "rear", roof_form: "hipped", eave_steps: [step(0.25, "down")] }) },
  });
  assert.deepEqual(out.carvedJogIds, ["rear@0.25"], "the step carves");
  assert.equal(out.suggestedEaves.length, 1, "inner hip leg only — the return itself is carved geometry now");
  const leg = out.suggestedEaves[0];
  assert.equal(leg.tier, "lower");
  const [l0, l1] = leg.points;
  assert.ok(Math.abs(l0.x - 75) < 1e-6 && Math.abs(l0.y - 8) < 1e-6, `leg starts at the carved inner corner, got ${JSON.stringify(l0)}`);
  assert.ok(Math.abs(l1.x - 67) < 1e-6 && Math.abs(l1.y - 8) < 1e-6, `leg heads toward the lower side (−x), got ${JSON.stringify(l1)}`);
  assert.ok(out.notes.some((n) => /returns inside under the hip tier step/.test(n)));
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");

  // Suppressed: an existing lower-tier run already covers the inner leg.
  const runsCovered = [...rectRuns(), run({ x: 60, y: 8 }, { x: 80, y: 8 }, { tier: "lower" })];
  const b = analysisOf(RECT, runsCovered);
  const snapB = structuredClone(b);
  const out2 = reconcileEaveSteps({
    analysis: b,
    perFace: { rear: face({ face: "rear", roof_form: "hipped", eave_steps: [step(0.25, "down")] }) },
  });
  assert.deepEqual(out2.suggestedEaves, [], "inner leg suppressed — a run already covers it");
  assert.ok(!out2.notes.some((n) => /returns inside/.test(n)));
  assert.equal(lfSum(out2.analysis), lfSum(snapB), "Σ priced LF identical");
});

test("(12) invariant — Σ length_ft and totals identical pre/post in EVERY branch (carving included)", () => {
  const scenarios: { fp: Pt[]; runs: () => BlueprintRun[]; perFace: Partial<Record<string, FaceReadingRaw>> }[] = [
    { fp: STEPPED, runs: steppedRuns, perFace: { front: face({ face: "front" }) } },
    { fp: STEPPED, runs: steppedRuns, perFace: { front: face({ face: "front", eave_steps: [step(0.6)] }) } },
    { fp: RECT, runs: rectRuns, perFace: { front: face({ face: "front", eave_steps: [step(0.25)] }) } }, // carves
    { fp: STEPPED, runs: steppedRuns, perFace: { front: face({ face: "front", eave_steps: [] }) } },
    { fp: RECT, runs: rectRuns, perFace: { rear: face({ face: "rear", roof_form: "hipped", eave_steps: [step(0.25, "down")] }) } }, // carves
    { fp: RECT, runs: rectRuns, perFace: { front: face({ face: "front", eave_steps: [step(3.7)] }) } },
  ];
  for (const s of scenarios) {
    const a = analysisOf(s.fp, s.runs());
    const snap = structuredClone(a);
    const out = reconcileEaveSteps({ analysis: a, perFace: s.perFace });
    assert.equal(out.analysis, a, "returns the caller's analysis object");
    assert.equal(lfSum(out.analysis), lfSum(snap), "Σ length_ft identical");
    assert.deepEqual(out.analysis.totals, snap.totals, "totals identical");
    // Geometry may only change when something was carved.
    if (out.carvedJogIds.length === 0) {
      assert.deepEqual(a, snap, "no carve → analysis byte-untouched");
    }
  }
});

test("reconcileEaveSteps never throws on garbage analysis", () => {
  assert.doesNotThrow(() => {
    const bad = {
      building_footprint: [{ x: NaN, y: NaN }],
      gutter_runs: [{}],
      totals: {},
      notes: [],
    } as unknown as BlueprintAnalysis;
    const out = reconcileEaveSteps({
      analysis: bad,
      perFace: { front: face({ face: "front", eave_steps: [step(0.5)] }) },
    });
    assert.equal(out.analysis, bad);
  });
});

// ————————————————— roof-page steps (steps_detail channel) —————————————————
// roofPlanSteps arrive PRE-CONVERTED to the viewer frame (read-roof-layout's
// roofPlanViewerSteps owns the plan→viewer convention; tested there).

/** A viewer-frame roof-page step (direction always null — plan view). */
function roofStep(frac: number | null): FaceEaveStep {
  return { position_frac: frac, direction: null, offset_ft: null, kind: "unknown", notes: "roof-plan page fascia step" };
}

test("(R1) roofPlanSteps absent/null → byte-identical with the legacy call (deep-equal pin)", () => {
  const a1 = analysisOf(STEPPED, steppedRuns());
  const a2 = structuredClone(a1);
  const perFace = { front: face({ face: "front", continuous_eave: false, eave_steps: [step(0.6, "down")] }) };
  const legacy = reconcileEaveSteps({ analysis: a1, perFace });
  const withNull = reconcileEaveSteps({ analysis: a2, perFace: structuredClone(perFace), roofPlanSteps: null });
  assert.deepEqual(withNull.notes, legacy.notes);
  assert.deepEqual(withNull.suggestedEaves, legacy.suggestedEaves);
  assert.deepEqual(withNull.verifiedJogIds, legacy.verifiedJogIds);
  assert.deepEqual(withNull.wallJogFlags, legacy.wallJogFlags);
});

test("(R2) roof-page steps OUTRANK the elevation's — matched at the page's frac, the elevation's phantom frac ignored, note names the ruling source", () => {
  const a = analysisOf(STEPPED, steppedRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: {
      // the elevation misread the step at 0.2 — alone it would emit an
      // unmatched unpriced suggestion there
      front: face({ face: "front", continuous_eave: false, eave_steps: [step(0.2, "down")] }),
    },
    roofPlanSteps: { front: [roofStep(0.6)] }, // the page pins it where the trace steps
  });
  assertUntouched(a, snap, out);
  assert.equal(out.verifiedJogIds.length, 1, "the page's step matches the traced jog");
  assert.match(out.verifiedJogIds[0], /front@0\.60/);
  assert.deepEqual(out.suggestedEaves, [], "the elevation's 0.2 step never ran — outranked");
  const ruled = out.notes.find((n) => /outrank/.test(n));
  assert.ok(ruled, "note names which source ruled");
  assert.match(ruled!, /Roof-plan page fascia steps ruled the front side/);
  const verified = out.notes.find((n) => /ROOF-VERIFIED JOG/.test(n));
  assert.ok(verified);
  assert.match(verified!, /roof-plan page's fascia line/, "verified note cites the page, not the elevation");
  assert.deepEqual(out.wallJogFlags, []);
});

test("(R3) roof-page step on a side with NO elevation read at all → still CARVED (page alone is a source)", () => {
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: null,
    roofPlanSteps: { front: [roofStep(0.25)] },
  });
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 25, y: 60 },
      { x: 25, y: 52 },
      { x: 0, y: 52 },
    ],
    "page-located step carved without any elevation read",
  );
  assert.deepEqual(out.carvedJogIds, ["front@0.25"]);
  const note = out.notes.find((n) => /ROOF JOG CARVED/.test(n));
  assert.ok(note);
  assert.match(note!, /roof-plan page/);
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

test("(R4) traced jog vs a STRAIGHT roof-page side (steps_detail []) → the phantom jog is FLATTENED (owner round 2), runs carried, priced LF untouched", () => {
  const a = analysisOf(STEPPED, steppedRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { front: face({ face: "front" }) }, // elevation never reported the field
    roofPlanSteps: { front: [] }, // the page: one flush fascia plane
  });
  // The 5 ft jog is pressed onto the dominant fascia line (the wider y=50
  // sub-edge wins): the y=60 span drops to y=50, the connector collapses.
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 60, y: 50 },
      { x: 0, y: 50 },
    ],
    "phantom jog flattened onto the dominant fascia line",
  );
  assert.deepEqual(out.wallJogFlags, [], "corrected, not just flagged");
  const note = out.notes.find((n) => /JOG FLATTENED/.test(n));
  assert.ok(note, `expected a JOG FLATTENED note, got: ${JSON.stringify(out.notes)}`);
  assert.match(note!, /front/);
  assert.match(note!, /priced LF unchanged/);
  // Followers rode along: the front run on the moved sub-edge shifted to
  // y=50; every run's PRICED length_ft is byte-identical.
  const movedRun = out.analysis.gutter_runs.find((r) => r.start.x === 60 && r.end.x === 100);
  assert.ok(movedRun && movedRun.start.y === 50 && movedRun.end.y === 50, "run carried onto the flattened edge");
  assert.deepEqual(
    out.analysis.gutter_runs.map((r) => r.length_ft),
    snap.gutter_runs.map((r) => r.length_ft),
    "no run's length_ft changed",
  );
  assert.equal(out.analysis.gutter_runs.length, snap.gutter_runs.length, "no run deleted");
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

// ————————————————— flush-face straightening (owner escalation) —————————————————

/** A real "gable dips in" shape: front face is flush at y=60 on BOTH the left
 *  (x 0-30) and right (x 70-100) main-wall pieces, with a recessed gable
 *  wall at y=50 (x 30-70) in between — the exact shape a roof-plan page
 *  ruling "one flush fascia plane" for the whole side contradicts. */
const NOTCHED: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 70, y: 60 },
  { x: 70, y: 50 },
  { x: 30, y: 50 },
  { x: 30, y: 60 },
  { x: 0, y: 60 },
];

function notchedRuns(): BlueprintRun[] {
  return [
    run({ x: 0, y: 60 }, { x: 30, y: 60 }), // main-left (flanking, already guttered)
    run({ x: 70, y: 60 }, { x: 100, y: 60 }), // main-right (flanking, already guttered)
    run({ x: 0, y: 0 }, { x: 100, y: 0 }, { side: "back" }),
    run({ x: 0, y: 0 }, { x: 0, y: 60 }, { side: "left" }),
    run({ x: 100, y: 0 }, { x: 100, y: 60 }, { side: "right" }),
    // No run for the gable (30,50)-(70,50) or its two connectors — matches
    // real AI output: a face read as gable-only never gets a gutter there.
  ];
}

test("(R6) flush-face straightening — roof-page rules the WHOLE front flush, the traced notch is removed from the footprint", () => {
  const a = analysisOf(NOTCHED, notchedRuns());
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { front: face({ face: "front", continuous_eave: false }) },
    roofPlanSteps: { front: [] }, // the page: one flush fascia plane, no steps
  });
  // The jog is GONE — a straight edge from (0,60) to (100,60), no interior
  // corners left. wallJogFlags must be empty (nothing left to flag) and the
  // straightening note fires instead.
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ],
    "the notch's 4 interior vertices are gone; the face is one flush edge",
  );
  assert.deepEqual(out.wallJogFlags, [], "nothing left to flag — the jog was corrected, not just noted");
  const straightened = out.notes.find((n) => /JOG STRAIGHTENED/.test(n));
  assert.ok(straightened, `expected a JOG STRAIGHTENED note, got: ${JSON.stringify(out.notes)}`);
  assert.match(straightened!, /front/);
  // Every existing run's own length_ft is untouched (sum-preserving; no run
  // was deleted, moved, or resized here) — only the shape changed.
  assert.deepEqual(
    out.analysis.gutter_runs.map((r) => r.length_ft),
    a.gutter_runs.map((r) => r.length_ft),
    "no run's length_ft changed",
  );
  // The gable had no run at all, so nothing to preserve there — this pass
  // never invents one; that's the downstream perimeter-closure pass's job
  // (same as any other uncovered wall gap), not this reconcile.
  assert.equal(out.analysis.gutter_runs.length, notchedRuns().length, "run COUNT unchanged");
});

test("(R6b) flush-face straightening is OFF when BLUEPRINT_EAVE_STEP_STRAIGHTEN=0 — falls back to flag-only", () => {
  const prev = process.env.BLUEPRINT_EAVE_STEP_STRAIGHTEN;
  try {
    process.env.BLUEPRINT_EAVE_STEP_STRAIGHTEN = "0";
    const a = analysisOf(NOTCHED, notchedRuns());
    const snap = structuredClone(a);
    const out = reconcileEaveSteps({
      analysis: a,
      perFace: { front: face({ face: "front", continuous_eave: false }) },
      roofPlanSteps: { front: [] },
    });
    assertUntouched(a, snap, out);
    assert.ok(out.wallJogFlags.length > 0, "kill switch restores the old flag-only behavior");
    assert.ok(!out.notes.some((n) => /JOG STRAIGHTENED/.test(n)));
  } finally {
    if (prev === undefined) delete process.env.BLUEPRINT_EAVE_STEP_STRAIGHTEN;
    else process.env.BLUEPRINT_EAVE_STEP_STRAIGHTEN = prev;
  }
});

test("(R6c) a DEEP step (> ~8 ft) never flattens — that's a real mass, flag-only survives", () => {
  // 10 ft step (20 ring units): even under a page-ruled flush side, a step
  // deeper than the ~8 ft cap is a real building mass the page likely
  // mis-read — the cap bails the whole group and flag-only remains.
  const DEEP: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 60, y: 60 },
    { x: 60, y: 40 },
    { x: 0, y: 40 },
  ];
  const deepRuns = [
    run({ x: 60, y: 60 }, { x: 100, y: 60 }),
    run({ x: 0, y: 40 }, { x: 60, y: 40 }),
    run({ x: 0, y: 0 }, { x: 100, y: 0 }, { side: "back" }),
  ];
  const a = analysisOf(DEEP, deepRuns);
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { front: face({ face: "front" }) },
    roofPlanSteps: { front: [] },
  });
  assertUntouched(a, snap, out);
  assert.equal(out.wallJogFlags.length, 1, "deep step stays flag-only — the cap correctly declines");
  assert.ok(!out.notes.some((n) => /JOG FLATTENED/.test(n)));
});

test("(R6d) 1168G staircase — a flush-ruled side with TWO phantom steps flattens onto the dominant fascia line", () => {
  // The whole-face splice bails here (the two outermost sub-edges sit at
  // DIFFERENT depths — 60 vs 56), which is exactly how the 1168G BIDSET's
  // nine pop-outs survived as flag-only. The per-jog flatten presses every
  // uncorroborated step onto the widest depth (y=52).
  const STAIR: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 56 },
    { x: 80, y: 56 },
    { x: 80, y: 52 },
    { x: 20, y: 52 },
    { x: 20, y: 60 },
    { x: 0, y: 60 },
  ];
  const stairRuns = [
    run({ x: 0, y: 60 }, { x: 20, y: 60 }),
    run({ x: 20, y: 52 }, { x: 80, y: 52 }),
    run({ x: 80, y: 56 }, { x: 100, y: 56 }),
    run({ x: 0, y: 0 }, { x: 100, y: 0 }, { side: "back" }),
  ];
  const a = analysisOf(STAIR, stairRuns);
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { front: face({ face: "front" }) },
    roofPlanSteps: { front: [] },
  });
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 52 },
      { x: 80, y: 52 },
      { x: 20, y: 52 },
      { x: 0, y: 52 },
    ],
    "both staircase pop-outs pressed onto the dominant y=52 line",
  );
  assert.deepEqual(out.wallJogFlags, []);
  // All three front runs now sit on the flattened line; priced LF untouched.
  for (const r of out.analysis.gutter_runs) {
    if (r.side !== "back") {
      assert.equal(r.start.y, 52, `run ${r.id} carried`);
      assert.equal(r.end.y, 52, `run ${r.id} carried`);
    }
  }
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

test("(R6e) mixed side — the page-located step is KEPT, the phantom one flattens, downspout rides along", () => {
  const a = analysisOf(TWO_STEP, twoStepRuns());
  a.downspouts = [
    {
      id: "d1",
      at: { x: 90, y: 60 },
      from_gutter: "r1",
      drop_direction: "front",
      reason: "outside_corner",
    } as (typeof a.downspouts)[number],
  ];
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: null,
    roofPlanSteps: { front: [roofStep(0.45)] }, // page corroborates ONLY the 0.45 step
  });
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 52 },
      { x: 80, y: 52 },
      { x: 45, y: 52 },
      { x: 45, y: 44 },
      { x: 0, y: 44 },
    ],
    "the verified 45% step survives; the phantom 80% pop-out is flattened",
  );
  assert.equal(out.verifiedJogIds.length, 1);
  assert.match(out.verifiedJogIds[0], /front@0\.45/);
  assert.deepEqual(out.wallJogFlags, [], "the phantom was corrected, not flagged");
  assert.ok(out.notes.some((n) => /JOG FLATTENED/.test(n)));
  // Followers on the moved span rode along; priced LF untouched.
  const movedRun = out.analysis.gutter_runs.find((r) => r.end.x === 100 && r.side === "front");
  assert.ok(movedRun && movedRun.start.y === 52 && movedRun.end.y === 52, "run on the flattened span carried");
  assert.equal(out.analysis.downspouts[0].at.y, 52, "downspout carried with its edge");
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

test("(R5) roof-page steps never emit the hip inner-return leg (direction is null by design)", () => {
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { rear: face({ face: "rear", roof_form: "hipped" }) },
    roofPlanSteps: { rear: [roofStep(0.75)] },
  });
  // The step itself carves (rear viewer frac 0.75 → x=25, shorter side
  // x∈[0,25] recedes), but WITHOUT a height direction no inner leg is
  // guessed — that would aim gutter at an unknown side.
  assert.deepEqual(out.carvedJogIds, ["rear@0.75"]);
  assert.deepEqual(out.suggestedEaves, [], "no inner leg without a height direction");
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

// ————————————————— roof-jog carve (owner escalation round 3) —————————————————

/** A viewer-frame roof-page step WITH the recess-side signal. */
function roofStepDir(frac: number, plan_offset: "inward" | "outward" | null): FaceEaveStep {
  return { position_frac: frac, direction: null, offset_ft: null, kind: "unknown", plan_offset, notes: "roof-plan page fascia step" };
}

test("(C1) 1168G shape — a page step PAIR reading in-then-out carves a recessed INSET (notch) with the run split around it", () => {
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: null,
    roofPlanSteps: { front: [roofStepDir(0.25, "inward"), roofStepDir(0.75, "outward")] },
  });
  // The middle [25,75] recedes 8 units: outer → inner → inner → outer.
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 75, y: 60 },
      { x: 75, y: 52 },
      { x: 25, y: 52 },
      { x: 25, y: 60 },
      { x: 0, y: 60 },
    ],
    "inset carved between the paired steps",
  );
  assert.deepEqual(out.carvedJogIds, ["front@0.25", "front@0.75"]);
  assert.deepEqual(out.suggestedEaves, []);
  const carveNotes = out.notes.filter((n) => /ROOF JOG CARVED/.test(n));
  assert.equal(carveNotes.length, 1, "one note for the pair");
  assert.match(carveNotes[0], /steps in at ~25% and back out at ~75%/);
  assert.match(carveNotes[0], /inset/);
  // The front run split into three; the recessed middle rides to y=52 and
  // Σ length_ft is exactly the original 50.
  const frontRuns = out.analysis.gutter_runs.filter((r) => r.side === "front");
  assert.equal(frontRuns.length, 3, "run split into outer + recessed + outer");
  const mid = frontRuns.find((r) => r.start.y === 52 && r.end.y === 52);
  assert.ok(mid, `expected a recessed middle piece, got ${JSON.stringify(frontRuns)}`);
  assert.equal(mid!.length_ft, 25, "middle keeps its proportional 25 ft");
  assert.equal(mid!.id, snap.gutter_runs[0].id, "longest piece keeps the parent id");
  assert.equal(
    frontRuns.reduce((s, r) => s + (r.length_ft ?? 0), 0),
    snap.gutter_runs[0].length_ft,
    "split preserves the parent's priced LF exactly",
  );
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
  assert.deepEqual(out.analysis.totals, snap.totals, "totals untouched");
});

test("(C2) out-then-in pair (projecting middle) never grows the envelope — both flanks carve inward as corner recesses instead", () => {
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: null,
    roofPlanSteps: { front: [roofStepDir(0.25, "outward"), roofStepDir(0.75, "inward")] },
  });
  // A projecting middle = both FLANKS recessed relative to the traced
  // envelope: two L-steps, corners (0,60) and (100,60) slide to y=52.
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 52 },
      { x: 75, y: 52 },
      { x: 75, y: 60 },
      { x: 25, y: 60 },
      { x: 25, y: 52 },
      { x: 0, y: 52 },
    ],
    "both flanks recede; the middle keeps the outer line (envelope never grows)",
  );
  assert.deepEqual(out.carvedJogIds, ["front@0.25", "front@0.75"]);
  assert.equal(out.notes.filter((n) => /ROOF JOG CARVED/.test(n)).length, 2, "two corner recesses");
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

test("(C4) fragmented fascia — collinear sub-edge chain reads as ONE plane, the inset still carves across it", () => {
  // The flatten pass (and real traces) leave collinear interior vertices on
  // a straight fascia; the carve must merge the chain, not bail per-fragment.
  const FRAG: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 60, y: 60 },
    { x: 30, y: 60 },
    { x: 0, y: 60 },
  ];
  const a = analysisOf(FRAG, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: null,
    roofPlanSteps: { front: [roofStep(0.25), roofStep(0.75)] },
  });
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 75, y: 60 },
      { x: 75, y: 52 },
      { x: 25, y: 52 },
      { x: 25, y: 60 },
      { x: 0, y: 60 },
    ],
    "chain merged (collinear fragments dropped) and the inset carved",
  );
  assert.deepEqual(out.carvedJogIds, ["front@0.25", "front@0.75"]);
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

test("(C5) a DEEP real jog between the pair — the inset can't span it, so BOTH steps degrade to corner recesses", () => {
  // 50×60 ft house. Front face: [0,39] at y=120, a REAL 9 ft jog at 39%
  // down to y=102 for [39,100] — the 1168G shape (deep recesses the trace
  // carries, page steps the trace missed). The pair (20%, 75%) straddles the
  // deep jog: no shared chain → each step carves its own corner recess; the
  // deep jog survives.
  const DEEPJOG: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 102 },
    { x: 39, y: 102 },
    { x: 39, y: 120 },
    { x: 0, y: 120 },
  ];
  const djRuns = [
    run({ x: 0, y: 120 }, { x: 39, y: 120 }),
    run({ x: 39, y: 102 }, { x: 100, y: 102 }),
    run({ x: 0, y: 0 }, { x: 100, y: 0 }, { side: "back" }),
  ];
  const a = analysisOf(DEEPJOG, djRuns);
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: null,
    roofPlanSteps: { front: [roofStep(0.2), roofStep(0.75)] },
  });
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 94 },
      { x: 75, y: 94 },
      { x: 75, y: 102 },
      { x: 39, y: 102 },
      { x: 39, y: 120 },
      { x: 20, y: 120 },
      { x: 20, y: 112 },
      { x: 0, y: 112 },
    ],
    "two corner recesses on either side of the surviving deep jog",
  );
  assert.deepEqual(out.carvedJogIds, ["front@0.20", "front@0.75"]);
  assert.equal(out.notes.filter((n) => /ROOF JOG CARVED/.test(n)).length, 2);
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

test("(C6) lstep to an EXISTING roof step — the recess ends at the traced jog, whose connector absorbs the depth", () => {
  // Chain [0,60] at y=60 ends at a real deep jog down to y=36. A page step
  // at 30% marked inward recesses [30,60]: the boundary vertex slides in and
  // the jog's connector shortens by the carve depth (24 ≥ 8 — safe).
  const STEPEND: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 36 },
    { x: 60, y: 36 },
    { x: 60, y: 60 },
    { x: 0, y: 60 },
  ];
  const seRuns = [
    run({ x: 0, y: 60 }, { x: 60, y: 60 }),
    run({ x: 60, y: 36 }, { x: 100, y: 36 }),
    run({ x: 0, y: 0 }, { x: 100, y: 0 }, { side: "back" }),
  ];
  const a = analysisOf(STEPEND, seRuns);
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: null,
    roofPlanSteps: { front: [roofStepDir(0.3, "inward")] },
  });
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 36 },
      { x: 60, y: 36 },
      { x: 60, y: 52 },
      { x: 30, y: 52 },
      { x: 30, y: 60 },
      { x: 0, y: 60 },
    ],
    "recess carved from the step to the existing jog boundary",
  );
  assert.deepEqual(out.carvedJogIds, ["front@0.30"]);
  // The upper-plane run split at 30% and its recessed piece rode inward; the
  // lower-plane run is untouched, and every priced length is sum-preserved.
  const frontRuns = out.analysis.gutter_runs.filter((r) => r.side === "front");
  assert.equal(frontRuns.length, 3, "upper run split into outer + recessed pieces");
  const recessed = frontRuns.find((r) => r.start.y === 52 && r.end.y === 52);
  assert.ok(recessed, `expected a recessed piece at y=52, got ${JSON.stringify(frontRuns)}`);
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

test("(F1) flatten group-split — a shallow phantom NEXT TO a deep real jog still flattens (deep jog is a boundary, not a bail)", () => {
  // 50×60 ft house. Front: [0,20] y=120 (shallow 4 ft pop-out), [20,50]
  // y=112, then a DEEP 9 ft drop to y=94 for [50,100]. Page rules the side
  // flush ([]). Round-2 behavior bailed the WHOLE group on the deep member;
  // now the deep step bounds the group, the shallow phantom presses flat,
  // the deep jog survives as flag-only.
  const STAIR2: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 94 },
    { x: 50, y: 94 },
    { x: 50, y: 112 },
    { x: 20, y: 112 },
    { x: 20, y: 120 },
    { x: 0, y: 120 },
  ];
  const stairRuns = [
    run({ x: 0, y: 120 }, { x: 20, y: 120 }),
    run({ x: 20, y: 112 }, { x: 50, y: 112 }),
    run({ x: 50, y: 94 }, { x: 100, y: 94 }),
    run({ x: 0, y: 0 }, { x: 100, y: 0 }, { side: "back" }),
  ];
  const a = analysisOf(STAIR2, stairRuns);
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { front: face({ face: "front" }) },
    roofPlanSteps: { front: [] },
  });
  assert.deepEqual(
    out.analysis.building_footprint,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 94 },
      { x: 50, y: 94 },
      { x: 50, y: 112 },
      { x: 20, y: 112 },
      { x: 0, y: 112 },
    ],
    "shallow phantom pressed onto the dominant line; the deep jog untouched",
  );
  assert.ok(out.notes.some((n) => /JOG FLATTENED/.test(n)), "flatten fired despite the deep neighbor");
  assert.equal(out.wallJogFlags.length, 1, "the deep jog stays flag-only");
  assert.match(out.wallJogFlags[0], /50%/);
  assert.equal(lfSum(out.analysis), lfSum(snap), "Σ priced LF identical");
});

test("(C3) carve gates decline near a corner / on a jogged span → falls back to suggest-don't-carve", () => {
  // A step at frac 0.01 sits INSIDE the 1-ft corner margin — nothing to
  // carve there (the face corner IS the step); legacy suggestion survives.
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { front: face({ face: "front", eave_steps: [step(0.01, "down")] }) },
  });
  assertUntouched(a, snap, out);
  assert.deepEqual(out.carvedJogIds, []);
  assert.equal(out.suggestedEaves.length, 1, "fallback tap-to-add suggestion");
  assert.ok(out.notes.some((n) => /ROOF STEPS HERE/.test(n)));
});

// ————————————————— plan-ink footprint (ink wins) —————————————————

test("(I1) footprintIsPlanInk — a page-straight summary NEVER flattens/flags the ink's own jog (byte-identical)", () => {
  // The footprint IS the roof-plan page's printed outline (raster swap
  // applied). The per-side summary says "flush" — but the ink shows a step.
  // The ink outranks the summary: no flatten, no splice, no wall-jog flag.
  const a = analysisOf(STEPPED, steppedRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { front: face({ face: "front" }) },
    roofPlanSteps: { front: [] },
    footprintIsPlanInk: true,
  });
  assertUntouched(a, snap, out);
  assert.deepEqual(out.wallJogFlags, [], "ink jogs are roof jogs — never flagged against the summary");
  assert.ok(!out.notes.some((n) => /JOG FLATTENED|JOG STRAIGHTENED/.test(n)));
  assert.deepEqual(out.carvedJogIds, []);
});

test("(I2) footprintIsPlanInk — a summary step the ink lacks suggests (unpriced) but NEVER carves; matches still verify", () => {
  const a = analysisOf(STEPPED, steppedRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: null,
    // 0.6 matches the ink's real step (verified); 0.2 is a summary step the
    // ink doesn't show — with ink it stays an unpriced tap-to-add.
    roofPlanSteps: { front: [roofStep(0.6), roofStep(0.2)] },
    footprintIsPlanInk: true,
  });
  assertUntouched(a, snap, out);
  assert.equal(out.verifiedJogIds.length, 1, "ink jog matching the summary still verifies");
  assert.deepEqual(out.carvedJogIds, [], "never carved into plan ink");
  assert.equal(out.suggestedEaves.length, 1, "missed summary step degrades to the unpriced suggestion");
  assert.ok(out.notes.some((n) => /ROOF STEPS HERE/.test(n)));
});

// ————————————————— mirror check —————————————————

/** Footprint with TWO real front-face steps at u=45 and u=80 (fracs 0.45, 0.8). */
const TWO_STEP: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 80, y: 60 },
  { x: 80, y: 52 },
  { x: 45, y: 52 },
  { x: 45, y: 44 },
  { x: 0, y: 44 },
];

function twoStepRuns(): BlueprintRun[] {
  return [
    run({ x: 80, y: 60 }, { x: 100, y: 60 }),
    run({ x: 45, y: 52 }, { x: 80, y: 52 }),
    run({ x: 0, y: 44 }, { x: 45, y: 44 }),
    run({ x: 0, y: 0 }, { x: 100, y: 0 }, { side: "back" }),
  ];
}

test("(M1) detectStepMirror — fires only when the flipped fit is decisively better across ≥2 steps", () => {
  // mirrored fixture: roof fracs {0.2, 0.45} vs traced {0.55, 0.8} — flipped they land exactly.
  const note = detectStepMirror([
    { face: "front", roofFracs: [0.2, 0.45], tracedFracs: [0.55, 0.8] },
  ]);
  assert.ok(note, "fires on the flipped fixture");
  assert.match(note!, /TRACE MAY BE MIRRORED left-right/);
  assert.match(note!, /front side/);
  assert.match(note!, /verify the canvas orientation/);

  // aligned → silent
  assert.equal(
    detectStepMirror([{ face: "front", roofFracs: [0.45, 0.8], tracedFracs: [0.45, 0.8] }]),
    null,
  );
  // 1 step → silent (too weak either way)
  assert.equal(
    detectStepMirror([{ face: "front", roofFracs: [0.2], tracedFracs: [0.8, 0.55] }]),
    null,
  );
  assert.equal(
    detectStepMirror([{ face: "front", roofFracs: [0.2, 0.45], tracedFracs: [0.8] }]),
    null,
  );
  // absent → silent
  assert.equal(detectStepMirror([]), null);
  // left/right faces are excluded (a left-right mirror SWAPS them instead)
  assert.equal(
    detectStepMirror([{ face: "left", roofFracs: [0.2, 0.45], tracedFracs: [0.55, 0.8] }]),
    null,
  );
});

test("(M2) mirror note flows through reconcileEaveSteps on a flipped roof-page read; silent when aligned", () => {
  const a = analysisOf(TWO_STEP, twoStepRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: null,
    // traced front steps sit at fracs {0.45, 0.8}; the page reads {0.2, 0.55}
    // — flipped ({0.8, 0.45}) they land exactly, direct they don't.
    roofPlanSteps: { front: [roofStep(0.2), roofStep(0.55)] },
  });
  assertUntouched(a, snap, out);
  const mirror = out.notes.filter((n) => /TRACE MAY BE MIRRORED/.test(n));
  assert.equal(mirror.length, 1, "exactly ONE loud mirror note");
  assert.equal(out.analysis.gutter_runs.length, snap.gutter_runs.length, "flag-only — geometry never flipped");

  // aligned read on the same footprint → no mirror note
  const b = analysisOf(TWO_STEP, twoStepRuns());
  const snapB = structuredClone(b);
  const out2 = reconcileEaveSteps({
    analysis: b,
    perFace: null,
    roofPlanSteps: { front: [roofStep(0.45), roofStep(0.8)] },
  });
  assertUntouched(b, snapB, out2);
  assert.ok(!out2.notes.some((n) => /TRACE MAY BE MIRRORED/.test(n)));
  assert.equal(out2.verifiedJogIds.length, 2, "aligned page steps verify both traced jogs");
});

test("elevationStepsForVectorGate — old reads → null; readable reads flatten; unreadable dropped", () => {
  assert.equal(elevationStepsForVectorGate(null), null);
  assert.equal(
    elevationStepsForVectorGate({ front: face({ face: "front" }) }),
    null,
    "no face reported the field → null (legacy everywhere)",
  );
  const out = elevationStepsForVectorGate({
    front: face({ face: "front", eave_steps: [step(0.4, "down"), step(9, "up")] }),
    rear: face({ face: "rear", eave_steps: [], continuous_eave: true }),
    left: face({ face: "left", readable: false, eave_steps: [step(0.5)] }),
  });
  assert.ok(out);
  assert.equal(out!.length, 2, "unreadable left face dropped");
  const front = out!.find((f) => f.face === "front")!;
  assert.equal(front.steps.length, 2, "entries pass through; validity is the gate's job");
  assert.equal(front.steps[0].position_frac, 0.4);
  const rear = out!.find((f) => f.face === "rear")!;
  assert.deepEqual(rear.steps, []);
  assert.equal(rear.continuous_eave, true);
});
