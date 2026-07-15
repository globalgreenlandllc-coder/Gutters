/**
 * Pure node tests for the per-face merge, focused on Stage 3 asymmetric-jog
 * detection. Run:
 *   npx tsx --test lib/ai/face-merge.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFaceReadings, type FaceReadingRaw, type FaceGableRead } from "./face-merge.ts";

function face(over: Partial<FaceReadingRaw> & { face: FaceReadingRaw["face"] }): FaceReadingRaw {
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

function gable(kind: FaceGableRead["kind"]): FaceGableRead {
  return {
    id: kind,
    kind,
    span_ft: 12,
    pitch: 4,
    position_frac: 0.5,
    eave_condition_guess: "flush",
    supported_on: "wall",
    shows_projection_cue: false,
    notes: "",
  };
}

const asymFlags = (flags: string[]) => flags.filter((f) => f.startsWith("ASYMMETRIC"));

test("asymmetric garage seen on east (in profile) but not west → one left↔right flag", () => {
  const reads: FaceReadingRaw[] = [
    face({ face: "east", gable_count: 1, projections: [{ kind: "garage", depth_ft: 22, notes: "" }] }),
    face({ face: "west", gable_count: 1, projections: [] }),
    face({ face: "north", gable_count: 2 }),
    face({ face: "south", gable_count: 1 }),
  ];
  const m = mergeFaceReadings(reads, ["north", "south", "east", "west"]);
  const asym = asymFlags(m.review_flags);
  assert.equal(asym.length, 1, "exactly one asymmetry flag");
  assert.match(asym[0], /left↔right/);
  assert.match(asym[0], /garage/);
  assert.match(asym[0], /the east elevation shows a garage/);
});

test("a porch gable-end on north but not south → one front↔rear flag", () => {
  const reads: FaceReadingRaw[] = [
    face({ face: "north", gable_count: 1, gables: [gable("porch")] }),
    face({ face: "south", gable_count: 0, gables: [] }),
  ];
  const m = mergeFaceReadings(reads, ["north", "south"]);
  const asym = asymFlags(m.review_flags);
  assert.equal(asym.length, 1);
  assert.match(asym[0], /front↔rear/);
  assert.match(asym[0], /porch/);
});

test("matching jogs on BOTH opposite faces raise NO asymmetry flag", () => {
  const reads: FaceReadingRaw[] = [
    face({ face: "east", projections: [{ kind: "patio", depth_ft: 10, notes: "" }] }),
    face({ face: "west", projections: [{ kind: "patio", depth_ft: 10, notes: "" }] }),
  ];
  const m = mergeFaceReadings(reads, ["east", "west"]);
  assert.equal(asymFlags(m.review_flags).length, 0);
});

test("a jog on the ONLY readable side is not called asymmetric (need both sides read)", () => {
  const reads: FaceReadingRaw[] = [
    face({ face: "east", gable_count: 1, gables: [gable("garage")] }),
    face({ face: "west", readable: false, unreadable_reason: "too low-res" }),
  ];
  const m = mergeFaceReadings(reads, ["east", "west"]);
  assert.equal(asymFlags(m.review_flags).length, 0);
});

test("entry normalizes to porch, so an entry vs porch across faces is NOT flagged asymmetric", () => {
  const reads: FaceReadingRaw[] = [
    face({ face: "north", gable_count: 1, gables: [gable("entry")] }),
    face({ face: "south", gable_count: 1, gables: [gable("porch")] }),
  ];
  const m = mergeFaceReadings(reads, ["north", "south"]);
  assert.equal(asymFlags(m.review_flags).length, 0);
});

test("two DIFFERENT one-sided jogs (garage east-only, patio west-only) → two flags, one per side", () => {
  const reads: FaceReadingRaw[] = [
    face({ face: "east", projections: [{ kind: "garage", depth_ft: 22, notes: "" }] }),
    face({ face: "west", projections: [{ kind: "patio", depth_ft: 10, notes: "" }] }),
  ];
  const m = mergeFaceReadings(reads, ["east", "west"]);
  const asym = asymFlags(m.review_flags);
  assert.equal(asym.length, 2);
  assert.ok(asym.some((f) => /garage/.test(f) && /the east elevation/.test(f)));
  assert.ok(asym.some((f) => /patio/.test(f) && /the west elevation/.test(f)));
});

// ── isUnanimousHip — the shared hip-unanimity predicate ──────────────────────
import { isUnanimousHip } from "./face-merge.ts";

const hipFace = (face: string): FaceReadingRaw => ({
  face: face as FaceReadingRaw["face"],
  readable: true,
  unreadable_reason: null,
  roof_form: "hipped",
  gable_count: 0,
  continuous_eave: true,
  gables: [],
  projections: [],
  projection_cues: [],
  confidence: "high",
});

test("isUnanimousHip: 4 hip faces → true; one gable breaks it; <3 readable → false", () => {
  const four = Object.fromEntries(
    ["front", "rear", "left", "right"].map((f) => [f, hipFace(f)]),
  );
  assert.equal(isUnanimousHip(four), true);

  const withGable = { ...four, front: { ...hipFace("front"), gable_count: 1 } };
  assert.equal(isUnanimousHip(withGable), false, "any gable kills unanimity");

  const twoReadable = {
    front: hipFace("front"),
    rear: hipFace("rear"),
    left: { ...hipFace("left"), readable: false },
    right: { ...hipFace("right"), readable: false },
  };
  assert.equal(isUnanimousHip(twoReadable), false, "needs ≥3 readable faces");
  assert.equal(isUnanimousHip(null), false);
  assert.equal(isUnanimousHip({}), false);
});

// ── explainUnanimousHip — stepped eaves, hip-end gables, roof_form veto ──────
import { explainUnanimousHip } from "./face-merge.ts";

test("unanimous hip: stepped eave (continuous_eave=false) does NOT veto — clerestory prairie roofs read broken eave lines honestly", () => {
  const four = Object.fromEntries(
    ["front", "rear", "left", "right"].map((f) => [
      f,
      { ...hipFace(f), continuous_eave: f === "front" ? false : true },
    ]),
  );
  assert.equal(isUnanimousHip(four), true);
});

test("unanimous hip: a gables[] entry with is_hip_end=true is a hip, not a gable — does not veto, and gable_count is discounted by it", () => {
  const hipEndGable = {
    id: "g1",
    kind: "main",
    span_ft: 20,
    pitch: null,
    position_frac: 0.5,
    eave_condition_guess: "flush",
    supported_on: "wall",
    shows_projection_cue: false,
    is_hip_end: true,
    notes: "hip end recorded through the gable channel",
  };
  const four = Object.fromEntries(
    ["front", "rear", "left", "right"].map((f) => [f, hipFace(f)]),
  );
  const withHipEnd = {
    ...four,
    front: { ...hipFace("front"), gable_count: 1, gables: [hipEndGable] },
  };
  assert.equal(isUnanimousHip(withHipEnd), true);

  // A REAL gable alongside the hip end still vetoes.
  const withReal = {
    ...four,
    front: {
      ...hipFace("front"),
      gable_count: 2,
      gables: [hipEndGable, { ...hipEndGable, id: "g2", is_hip_end: false }],
    },
  };
  const v = explainUnanimousHip(withReal);
  assert.equal(v.unanimous, false);
  assert.match(v.reason ?? "", /front face reads/);
});

test("unanimous hip: roof_form 'gabled'/'mixed' vetoes even with an empty gables array (contradictory read stays conservative)", () => {
  const four = Object.fromEntries(
    ["front", "rear", "left", "right"].map((f) => [f, hipFace(f)]),
  );
  const mixed = { ...four, left: { ...hipFace("left"), roof_form: "mixed" as const } };
  const v = explainUnanimousHip(mixed);
  assert.equal(v.unanimous, false);
  assert.match(v.reason ?? "", /left face reads roof_form "mixed"/);
});

test("explainUnanimousHip reasons: missing reads and too-few faces name the problem", () => {
  assert.match(explainUnanimousHip(null).reason ?? "", /no per-face/);
  const two = {
    front: hipFace("front"),
    rear: hipFace("rear"),
    left: { ...hipFace("left"), readable: false },
  };
  assert.match(explainUnanimousHip(two).reason ?? "", /only 2 readable/);
});

// ── Projection-cue flag: schedule-backed side-eave estimate (note-8 reword) ──

test("projection cue with a NAMED porch mass states the estimated side-eave LF instead of 'no gutter added'", () => {
  const reads: FaceReadingRaw[] = [
    face({
      face: "north",
      gable_count: 1,
      gables: [
        {
          ...gable("entry"), // entry normalizes to porch for the mass match
          span_ft: 20,
          supported_on: "beam",
          shows_projection_cue: true,
        },
      ],
    }),
  ];
  const m = mergeFaceReadings(reads, ["north"], [{ label: "PORCH ROOF", areaFt2: 189 }]);
  const cue = m.review_flags.find((f) => f.includes("projection cue"));
  assert.ok(cue, "cue flag present");
  // 189 sf ÷ 20 ft ≈ 9 ft deep → 2 side returns ≈ 19 LF.
  assert.match(cue!, /≈19 LF/);
  assert.match(cue!, /estimated — verify/);
  assert.ok(!cue!.includes("Defaulted to FLUSH"), "the bare no-gutter wording is replaced");
});

test("projection cue WITHOUT a matching mass keeps the flush default wording", () => {
  const reads: FaceReadingRaw[] = [
    face({
      face: "north",
      gable_count: 1,
      gables: [{ ...gable("porch"), span_ft: 20, shows_projection_cue: true }],
    }),
  ];
  const m = mergeFaceReadings(reads, ["north"]);
  const cue = m.review_flags.find((f) => f.includes("projection cue"));
  assert.ok(cue);
  assert.match(cue!, /Defaulted to FLUSH \(no gutter added\)/);
});

test("a garage projection cue never claims the schedule estimate (porch/patio covers only)", () => {
  const reads: FaceReadingRaw[] = [
    face({
      face: "north",
      gable_count: 1,
      gables: [{ ...gable("garage"), span_ft: 20, shows_projection_cue: true }],
    }),
  ];
  const m = mergeFaceReadings(reads, ["north"], [{ label: "GARAGE", areaFt2: 874 }]);
  const cue = m.review_flags.find((f) => f.includes("projection cue"));
  assert.ok(cue);
  assert.match(cue!, /Defaulted to FLUSH/);
});
