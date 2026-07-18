/**
 * Pure node tests for the ELEVATIONS-FIRST eave-step reconcile. Run:
 *   npx tsx --test lib/ai/eave-step-reconcile.test.mts
 *
 * Doctrine under test: suggest-don't-carve (geometry + priced LF byte-
 * untouched in EVERY branch), loud flags, old stored reads → byte-identical.
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

test("(5) unmatched step (straight traced front, step at 0.25) → exactly ONE unpriced suggestion, footprint unmutated", () => {
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { front: face({ face: "front", eave_steps: [step(0.25, "down")] }) },
  });
  assertUntouched(a, snap, out);
  assert.equal(out.suggestedEaves.length, 1, "exactly one suggestion");
  const [p0, p1] = out.suggestedEaves[0].points;
  // Front face (y=60), frac 0.25 → x=25; 4 ft schematic = 8 units inward (−y).
  assert.ok(Math.abs(p0.x - 25) < 1e-6 && Math.abs(p0.y - 60) < 1e-6, `base on the front eave at x=25, got ${JSON.stringify(p0)}`);
  assert.ok(Math.abs(p1.x - 25) < 1e-6 && Math.abs(p1.y - 52) < 1e-6, `return heads inward 8 units, got ${JSON.stringify(p1)}`);
  const stepNotes = out.notes.filter((n) => /ROOF STEPS HERE/.test(n));
  assert.equal(stepNotes.length, 1);
  assert.match(stepNotes[0], /NOT carved/);
  assert.match(stepNotes[0], /verify/i);
});

test("(4b) suggestion depth comes from a perpendicular face's profile, NEVER offset_ft", () => {
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
  assertUntouched(a, snap, out);
  assert.equal(out.suggestedEaves.length, 1);
  const [, p1] = out.suggestedEaves[0].points;
  // 10 ft = 20 units (NOT the 30 ft vertical offset_ft = 60 units).
  assert.ok(Math.abs(p1.y - 40) < 1e-6, `sized from perpendicular profile (10 ft → y=40), got ${JSON.stringify(p1)}`);
  assert.match(out.notes.find((n) => /ROOF STEPS HERE/.test(n)) ?? "", /perpendicular/);
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

test("(8) viewer-frame mapping — a rear-face frac lands on the correct plan half", () => {
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { rear: face({ face: "rear", eave_steps: [step(0.25, "down")] }) },
  });
  assertUntouched(a, snap, out);
  assert.equal(out.suggestedEaves.length, 1);
  const [p0, p1] = out.suggestedEaves[0].points;
  // REAR viewer's left = house-RIGHT: frac 0.25 → x = 100 − 25 = 75 (right half).
  assert.ok(p0.x > 50, `rear frac 0.25 must land on the plan's right half, got ${JSON.stringify(p0)}`);
  assert.ok(Math.abs(p0.x - 75) < 1e-6 && Math.abs(p0.y - 0) < 1e-6, `base at (75,0), got ${JSON.stringify(p0)}`);
  assert.ok(Math.abs(p1.y - 8) < 1e-6, `return heads inward (+y), got ${JSON.stringify(p1)}`);
});

test("(9) hip inner return emitted on a hipped face; suppressed when a lower run covers it", () => {
  // Unsuppressed: rear hipped, step at frac 0.25, direction 'down' (lower to
  // the viewer's right = house-left = −x).
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: { rear: face({ face: "rear", roof_form: "hipped", eave_steps: [step(0.25, "down")] }) },
  });
  assertUntouched(a, snap, out);
  assert.equal(out.suggestedEaves.length, 2, "perpendicular return + inner hip leg");
  const leg = out.suggestedEaves[1];
  assert.equal(leg.tier, "lower");
  const [l0, l1] = leg.points;
  assert.ok(Math.abs(l0.x - 75) < 1e-6 && Math.abs(l0.y - 8) < 1e-6, `leg starts at the inner corner, got ${JSON.stringify(l0)}`);
  assert.ok(Math.abs(l1.x - 67) < 1e-6 && Math.abs(l1.y - 8) < 1e-6, `leg heads toward the lower side (−x), got ${JSON.stringify(l1)}`);
  assert.ok(out.notes.some((n) => /returns inside under the hip tier step/.test(n)));

  // Suppressed: an existing lower-tier run already covers the inner leg.
  const runsCovered = [...rectRuns(), run({ x: 60, y: 8 }, { x: 80, y: 8 }, { tier: "lower" })];
  const b = analysisOf(RECT, runsCovered);
  const snapB = structuredClone(b);
  const out2 = reconcileEaveSteps({
    analysis: b,
    perFace: { rear: face({ face: "rear", roof_form: "hipped", eave_steps: [step(0.25, "down")] }) },
  });
  assertUntouched(b, snapB, out2);
  assert.equal(out2.suggestedEaves.length, 1, "inner leg suppressed — a run already covers it");
  assert.ok(!out2.notes.some((n) => /returns inside/.test(n)));
});

test("(12) invariant — Σ length_ft and totals identical pre/post in EVERY branch", () => {
  const scenarios: { fp: Pt[]; runs: () => BlueprintRun[]; perFace: Partial<Record<string, FaceReadingRaw>> }[] = [
    { fp: STEPPED, runs: steppedRuns, perFace: { front: face({ face: "front" }) } },
    { fp: STEPPED, runs: steppedRuns, perFace: { front: face({ face: "front", eave_steps: [step(0.6)] }) } },
    { fp: RECT, runs: rectRuns, perFace: { front: face({ face: "front", eave_steps: [step(0.25)] }) } },
    { fp: STEPPED, runs: steppedRuns, perFace: { front: face({ face: "front", eave_steps: [] }) } },
    { fp: RECT, runs: rectRuns, perFace: { rear: face({ face: "rear", roof_form: "hipped", eave_steps: [step(0.25, "down")] }) } },
    { fp: RECT, runs: rectRuns, perFace: { front: face({ face: "front", eave_steps: [step(3.7)] }) } },
  ];
  for (const s of scenarios) {
    const a = analysisOf(s.fp, s.runs());
    const snap = structuredClone(a);
    const out = reconcileEaveSteps({ analysis: a, perFace: s.perFace });
    assertUntouched(a, snap, out);
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

test("(R3) roof-page step on a side with NO elevation read at all → suggestion still emitted (page alone is a source)", () => {
  const a = analysisOf(RECT, rectRuns());
  const snap = structuredClone(a);
  const out = reconcileEaveSteps({
    analysis: a,
    perFace: null,
    roofPlanSteps: { front: [roofStep(0.25)] },
  });
  assertUntouched(a, snap, out);
  assert.equal(out.suggestedEaves.length, 1);
  const [p0] = out.suggestedEaves[0].points;
  assert.ok(Math.abs(p0.x - 25) < 1e-6 && Math.abs(p0.y - 60) < 1e-6, `base at (25,60), got ${JSON.stringify(p0)}`);
  const note = out.notes.find((n) => /ROOF STEPS HERE/.test(n));
  assert.ok(note);
  assert.match(note!, /roof-plan page/);
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
  assertUntouched(a, snap, out);
  assert.equal(out.suggestedEaves.length, 1, "perpendicular return only — no inner leg without a height direction");
  assert.equal(out.suggestedEaves[0].tier, "lower", "hipped face still tags the return lower");
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
