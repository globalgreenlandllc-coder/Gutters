/**
 * Pure node tests for the ELEVATIONS-FIRST eave-step reconcile. Run:
 *   npx tsx --test lib/ai/eave-step-reconcile.test.mts
 *
 * Doctrine under test: suggest-don't-carve (geometry + priced LF byte-
 * untouched in EVERY branch), loud flags, old stored reads → byte-identical.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileEaveSteps, elevationStepsForVectorGate } from "./eave-step-reconcile.ts";
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
