/**
 * Pure node tests for the roof-plan layout read's deterministic parts (no
 * model calls). Run:
 *   npx tsx --test lib/ai/read-roof-layout.test.mts
 *
 * The vision call in readRoofPlanLayout is fail-safe I/O (dynamically
 * imported server deps, degrades to readable:false) and can't be unit tested
 * without spending tokens; everything around it — the defensive parser, the
 * per-face evidence conversion, the PRIORITY merge (roof page > elevations),
 * the unanimity + D.S.-floor derivations — is pure and tested here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRoofPlanReading,
  emptyRoofPlanReading,
  roofPlanAsFaceEvidence,
  mergeLayoutEvidence,
  roofPlanUnanimousHip,
  roofPlanDsFloor,
  roofPlanFracToViewerFrac,
  roofPlanViewerSteps,
  describeRoofPlanReading,
  hasNoPerSideVerdict,
  ROOF_PLAN_SIDES,
  type RoofPlanReading,
  type RoofPlanSide,
  type RoofPlanSideName,
} from "./read-roof-layout.ts";
import { viewerPositionToPlanDir } from "./tier-corner-veto.ts";
import { explainUnanimousHip, type FaceReadingRaw } from "./face-merge.ts";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function side(over: Partial<RoofPlanSide> = {}): RoofPlanSide {
  return {
    eave_continuous: null,
    gable_end: null,
    steps: null,
    ds_marks: null,
    steps_detail: null,
    ...over,
  };
}

function hipSide(over: Partial<RoofPlanSide> = {}): RoofPlanSide {
  return side({ eave_continuous: true, gable_end: false, steps: 0, ...over });
}

/** The 1168G page-6 shape: full hip, D.S. dots printed. */
function fullHipReading(over: Partial<RoofPlanReading> = {}): RoofPlanReading {
  return {
    readable: true,
    unreadable_reason: null,
    sides: {
      front: hipSide({ ds_marks: 2 }),
      rear: hipSide({ ds_marks: 2 }),
      left: hipSide({ ds_marks: 1 }),
      right: hipSide({ ds_marks: 1 }),
    },
    hips_at_corners: true,
    total_ds_marks: 6,
    flat_sections: false,
    confidence: "high",
    notes: [],
    ...over,
  };
}

function elevFace(over: Partial<FaceReadingRaw>): FaceReadingRaw {
  return {
    face: "front",
    sheet_title: null,
    readable: true,
    unreadable_reason: null,
    roof_form: "hipped",
    gable_count: 0,
    continuous_eave: true,
    gables: [],
    projections: [],
    projection_cues: [],
    stories_visible: null,
    confidence: "high",
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* parser                                                              */
/* ------------------------------------------------------------------ */

test("parseRoofPlanReading: non-objects → null (treated as 'no roof page')", () => {
  assert.equal(parseRoofPlanReading(null), null);
  assert.equal(parseRoofPlanReading(undefined), null);
  assert.equal(parseRoofPlanReading("hip roof"), null);
  assert.equal(parseRoofPlanReading(42), null);
  assert.equal(parseRoofPlanReading([1, 2, 3]), null);
});

test("parseRoofPlanReading: garbage fields coerce to nulls, never crash", () => {
  const r = parseRoofPlanReading({
    readable: "yes", // wrong type → default true (readable !== false)
    unreadable_reason: 7,
    sides: {
      front: { eave_continuous: "true", gable_end: 1, steps: -3, ds_marks: 2.6 },
      rear: null,
      left: "gable",
      // right missing entirely
    },
    hips_at_corners: "maybe",
    total_ds_marks: Number.NaN,
    flat_sections: [],
    confidence: "certain",
    notes: ["real note", 5, null, "", "second"],
  });
  assert.ok(r);
  assert.equal(r.readable, true);
  assert.equal(r.unreadable_reason, null);
  assert.equal(r.sides.front.eave_continuous, null); // "true" string is not a verdict
  assert.equal(r.sides.front.gable_end, null);
  assert.equal(r.sides.front.steps, null); // negative rejected
  assert.equal(r.sides.front.ds_marks, 3); // rounded
  assert.deepEqual(r.sides.rear, side());
  assert.deepEqual(r.sides.left, side());
  assert.deepEqual(r.sides.right, side());
  assert.equal(r.hips_at_corners, null);
  assert.equal(r.total_ds_marks, null);
  assert.equal(r.flat_sections, null);
  assert.equal(r.confidence, "low");
  assert.deepEqual(r.notes, ["real note", "second"]);
});

test("parseRoofPlanReading: a clean full-hip blob round-trips", () => {
  const r = parseRoofPlanReading(fullHipReading());
  assert.ok(r);
  assert.equal(r.readable, true);
  assert.equal(r.hips_at_corners, true);
  assert.equal(r.total_ds_marks, 6);
  assert.equal(r.sides.left.eave_continuous, true);
  assert.equal(r.sides.left.gable_end, false);
});

test("parseRoofPlanReading: readable:false survives (stored unreadable stash)", () => {
  const r = parseRoofPlanReading(emptyRoofPlanReading("529 upstream"));
  assert.ok(r);
  assert.equal(r.readable, false);
  assert.equal(r.unreadable_reason, "529 upstream");
});

/* ------------------------------------------------------------------ */
/* roofPlanAsFaceEvidence                                              */
/* ------------------------------------------------------------------ */

test("roofPlanAsFaceEvidence: full hip → four readable zero-gable continuous-eave faces", () => {
  const ev = roofPlanAsFaceEvidence(fullHipReading());
  for (const f of ["front", "rear", "left", "right"] as const) {
    const face = ev[f];
    assert.ok(face, `${f} present`);
    assert.equal(face.readable, true);
    assert.equal(face.continuous_eave, true);
    assert.equal(face.gable_count, 0);
    assert.deepEqual(face.gables, []);
    assert.equal(face.roof_form, "hipped");
    // Deliberately NO eave_steps key — a count without positions must degrade
    // every eave-step consumer to its legacy "not read" behavior.
    assert.equal("eave_steps" in face, false);
  }
});

test("roofPlanAsFaceEvidence: gable end → 'gabled' face; verdict-less side omitted; unreadable → empty", () => {
  const reading = fullHipReading({
    sides: {
      front: hipSide(),
      rear: side({ eave_continuous: false, gable_end: true }),
      left: side(), // no verdict at all
      right: hipSide(),
    },
    hips_at_corners: false,
  });
  const ev = roofPlanAsFaceEvidence(reading);
  assert.equal(ev.rear?.roof_form, "gabled");
  assert.equal(ev.rear?.gable_count, 1);
  assert.equal(ev.rear?.continuous_eave, false);
  assert.equal(ev.left, undefined);
  // hips_at_corners false → a no-gable side is "unknown" form, still an eave
  assert.equal(ev.front?.roof_form, "unknown");
  assert.equal(ev.front?.gable_count, 0);

  assert.deepEqual(roofPlanAsFaceEvidence(emptyRoofPlanReading("scan too faint")), {});
  assert.deepEqual(roofPlanAsFaceEvidence(null), {});
});

/* ------------------------------------------------------------------ */
/* mergeLayoutEvidence — the priority                                   */
/* ------------------------------------------------------------------ */

test("mergeLayoutEvidence: both absent → empty map, no notes, roof plan unused", () => {
  const m = mergeLayoutEvidence(null, null);
  assert.deepEqual(m.perFace, {});
  assert.deepEqual(m.notes, []);
  assert.equal(m.usedRoofPlan, false);
});

test("mergeLayoutEvidence: no roof page → elevations pass through untouched", () => {
  const front = elevFace({ face: "front" });
  const m = mergeLayoutEvidence(null, { front });
  assert.equal(m.perFace.front, front); // same object, not a copy
  assert.equal(m.usedRoofPlan, false);
  assert.deepEqual(m.notes, []);
});

test("mergeLayoutEvidence: unreadable roof page → elevations pass through untouched", () => {
  const front = elevFace({ face: "front" });
  const m = mergeLayoutEvidence(emptyRoofPlanReading("too faint"), { front });
  assert.equal(m.perFace.front, front);
  assert.equal(m.usedRoofPlan, false);
});

test("mergeLayoutEvidence: roof page FILLS degraded/missing faces and the note names the source (the 529 outage)", () => {
  // 1168G: front + rear elevations read fine (hip); left + right died with 529s.
  const perFace = {
    front: elevFace({ face: "front" }),
    rear: elevFace({ face: "rear" }),
    left: elevFace({
      face: "left",
      readable: false,
      unreadable_reason: "read failed: 529 upstream overload",
      continuous_eave: false,
      roof_form: null,
      gable_count: null,
    }),
    // right never stored at all
  };
  const m = mergeLayoutEvidence(fullHipReading(), perFace);
  assert.equal(m.usedRoofPlan, true);
  // untouched readable faces stay the same objects
  assert.equal(m.perFace.front, perFace.front);
  assert.equal(m.perFace.rear, perFace.rear);
  // degraded + missing faces filled from the roof page
  assert.equal(m.perFace.left.readable, true);
  assert.equal(m.perFace.left.continuous_eave, true);
  assert.equal(m.perFace.left.gable_count, 0);
  assert.equal(m.perFace.right.readable, true);
  assert.equal(m.perFace.right.continuous_eave, true);
  // notes name the ruling source and why
  const leftNote = m.notes.find((n) => n.includes("the left side"));
  assert.ok(leftNote, "left fill noted");
  assert.match(leftNote, /^📄 Roof-plan page:/);
  assert.match(leftNote, /used as the layout source/);
  assert.match(leftNote, /left elevation degraded/);
  const rightNote = m.notes.find((n) => n.includes("the right side"));
  assert.ok(rightNote, "right fill noted");
  assert.match(rightNote, /no right elevation was read/);

  // ...and the merged map now clears the elevation unanimity bar too:
  assert.equal(explainUnanimousHip(m.perFace).unanimous, true);
});

test("mergeLayoutEvidence: roof page WINS over a readable elevation's conflicting eave read", () => {
  const perFace = {
    front: elevFace({ face: "front", continuous_eave: false }),
  };
  const m = mergeLayoutEvidence(fullHipReading(), perFace);
  assert.equal(m.perFace.front.continuous_eave, true); // overridden
  assert.equal(m.perFace.front.readable, true);
  assert.equal(m.perFace.front.confidence, "high"); // rest of the face kept
  const note = m.notes.find((n) => n.includes("the front side"));
  assert.ok(note);
  assert.match(note, /overrules the front elevation/);
});

test("mergeLayoutEvidence: a roof-page gable end vetoes a hip claim on that face (no-overbilling direction)", () => {
  const perFace = {
    rear: elevFace({ face: "rear", roof_form: "hipped" }),
  };
  const reading = fullHipReading({
    sides: {
      front: hipSide(),
      rear: side({ eave_continuous: false, gable_end: true }),
      left: hipSide(),
      right: hipSide(),
    },
    hips_at_corners: false,
  });
  const m = mergeLayoutEvidence(reading, perFace);
  assert.equal(m.perFace.rear.roof_form, "gabled");
  assert.equal(m.perFace.rear.continuous_eave, false);
  assert.equal(explainUnanimousHip(m.perFace).unanimous, false);
});

test("mergeLayoutEvidence: gable_end=false vs an elevation's gables = dormer-compatible — gables kept, note only", () => {
  const gable = {
    id: "g1",
    kind: "dormer" as const,
    span_ft: 8,
    pitch: 6,
    position_frac: 0.4,
    eave_condition_guess: "flush" as const,
    supported_on: "wall" as const,
    shows_projection_cue: false,
    notes: "",
  };
  const perFace = {
    front: elevFace({ face: "front", gable_count: 1, gables: [gable], roof_form: "gabled" }),
  };
  const m = mergeLayoutEvidence(fullHipReading(), perFace);
  assert.equal(m.perFace.front.gables.length, 1); // elevation detail preserved
  assert.equal(m.perFace.front.roof_form, "gabled"); // not stripped
  const note = m.notes.find((n) => n.includes("dormer/frame-over"));
  assert.ok(note, "dormer-compatibility note emitted");
});

/* ------------------------------------------------------------------ */
/* unanimity derivation                                                */
/* ------------------------------------------------------------------ */

test("roofPlanUnanimousHip: full-hip reading → unanimous even with ZERO readable elevations", () => {
  assert.equal(roofPlanUnanimousHip(fullHipReading()), true);
  // sanity: elevations alone could never have formed it
  assert.equal(explainUnanimousHip({}).unanimous, false);
});

test("roofPlanUnanimousHip: any weakening breaks it", () => {
  assert.equal(roofPlanUnanimousHip(null), false);
  assert.equal(roofPlanUnanimousHip(emptyRoofPlanReading("faint")), false);
  assert.equal(roofPlanUnanimousHip(fullHipReading({ hips_at_corners: false })), false);
  assert.equal(roofPlanUnanimousHip(fullHipReading({ hips_at_corners: null })), false);
  const oneGable = fullHipReading();
  oneGable.sides.left = side({ eave_continuous: true, gable_end: true });
  assert.equal(roofPlanUnanimousHip(oneGable), false);
  const oneUnknownEave = fullHipReading();
  oneUnknownEave.sides.rear = side({ eave_continuous: null, gable_end: false });
  assert.equal(roofPlanUnanimousHip(oneUnknownEave), false);
});

test("roofPlanUnanimousHip: gable_end null tolerated only under a required continuous eave", () => {
  const r = fullHipReading();
  r.sides.right = side({ eave_continuous: true, gable_end: null });
  assert.equal(roofPlanUnanimousHip(r), true);
});

/* ------------------------------------------------------------------ */
/* D.S. floor                                                          */
/* ------------------------------------------------------------------ */

test("roofPlanDsFloor: printed marks below the takeoff count → null (no note)", () => {
  assert.equal(roofPlanDsFloor(fullHipReading(), 6), null);
  assert.equal(roofPlanDsFloor(fullHipReading(), 9), null);
});

test("roofPlanDsFloor: printed marks above the takeoff count → floor + tap-add note", () => {
  const ds = roofPlanDsFloor(fullHipReading(), 4);
  assert.ok(ds);
  assert.equal(ds.floor, 6);
  assert.match(ds.note, /^💧/);
  assert.match(ds.note, /6 downspout mark\(s\)/);
  assert.match(ds.note, /carries 4/);
  assert.match(ds.note, /2 missing/);
});

test("roofPlanDsFloor: per-side sum backs up a missing total; no marks / unreadable → null", () => {
  const noTotal = fullHipReading({ total_ds_marks: null });
  const ds = roofPlanDsFloor(noTotal, 3);
  assert.ok(ds);
  assert.equal(ds.floor, 6); // 2+2+1+1 summed from the sides

  const noMarks = fullHipReading({
    total_ds_marks: null,
    sides: { front: hipSide(), rear: hipSide(), left: hipSide(), right: hipSide() },
  });
  assert.equal(roofPlanDsFloor(noMarks, 0), null);
  assert.equal(roofPlanDsFloor(emptyRoofPlanReading("faint"), 0), null);
  assert.equal(roofPlanDsFloor(null, 0), null);
});

test("roofPlanDsFloor: garbage current count treated as 0", () => {
  const ds = roofPlanDsFloor(fullHipReading(), Number.NaN);
  assert.ok(ds);
  assert.equal(ds.floor, 6);
  assert.match(ds.note, /carries 0/);
});

/* ------------------------------------------------------------------ */
/* describe (panel note)                                               */
/* ------------------------------------------------------------------ */

test("describeRoofPlanReading: readable summary names hips, eaves, steps and marks", () => {
  const withSteps = fullHipReading();
  withSteps.sides.front = hipSide({ steps: 2, ds_marks: 2 });
  const s = describeRoofPlanReading(withSteps);
  assert.match(s, /hips at every corner/);
  assert.match(s, /continuous eave on front\/rear\/left\/right/);
  assert.match(s, /2 fascia step\(s\) on front/);
  assert.match(s, /6 printed downspout mark\(s\)/);
});

test("describeRoofPlanReading: unreadable states the reason and the fallback", () => {
  const s = describeRoofPlanReading(emptyRoofPlanReading("529 upstream"));
  assert.match(s, /unreadable \(529 upstream\)/);
  assert.match(s, /fell back to the elevations/);
});

/* ------------------------------------------------------------------ */
/* hasNoPerSideVerdict — gates the bounded re-ask                      */
/* ------------------------------------------------------------------ */

test("hasNoPerSideVerdict: readable but every field null/empty → true (the exact 'no per-side verdicts' case)", () => {
  const empty: RoofPlanReading = {
    readable: true,
    unreadable_reason: null,
    sides: { front: side(), rear: side(), left: side(), right: side() },
    hips_at_corners: null,
    total_ds_marks: null,
    flat_sections: null,
    confidence: "low",
    notes: [],
  };
  assert.equal(hasNoPerSideVerdict(empty), true);
  // Cross-check against the panel string it's meant to predict.
  assert.match(describeRoofPlanReading(empty), /no per-side verdicts could be made out/);
});

test("hasNoPerSideVerdict: unreadable is a DIFFERENT case, never triggers the re-ask", () => {
  assert.equal(hasNoPerSideVerdict(emptyRoofPlanReading("too low-res")), false);
});

test("hasNoPerSideVerdict: any single real verdict flips it false", () => {
  const base = () => ({
    readable: true,
    unreadable_reason: null,
    sides: { front: side(), rear: side(), left: side(), right: side() },
    hips_at_corners: null,
    total_ds_marks: null,
    flat_sections: null,
    confidence: "low",
    notes: [],
  }) as RoofPlanReading;

  assert.equal(hasNoPerSideVerdict({ ...base(), hips_at_corners: true }), false, "hips_at_corners alone counts");
  const eave = base();
  eave.sides.front = side({ eave_continuous: true });
  assert.equal(hasNoPerSideVerdict(eave), false, "one eave_continuous:true counts");
  const gable = base();
  gable.sides.left = side({ gable_end: true });
  assert.equal(hasNoPerSideVerdict(gable), false, "one gable_end:true counts");
  const stepped = base();
  stepped.sides.rear = side({ steps: 1 });
  assert.equal(hasNoPerSideVerdict(stepped), false, "a positive step count counts");
  assert.equal(hasNoPerSideVerdict({ ...base(), total_ds_marks: 0 }), false, "even 0 marks is a real (non-null) verdict");
  assert.equal(hasNoPerSideVerdict({ ...base(), flat_sections: true }), false, "flat_sections:true counts");
  // eave_continuous:false / gable_end:false are still real verdicts the
  // summary just doesn't happen to list — but they're not what
  // hasNoPerSideVerdict checks (it mirrors describeRoofPlanReading's exact
  // "nothing to say" condition, which only lists TRUE eaves/gables) — a
  // side that's ALL false everywhere legitimately still re-asks, since nothing
  // positive was confirmed.
  const allFalse = base();
  for (const f of ROOF_PLAN_SIDES) allFalse.sides[f] = side({ eave_continuous: false, gable_end: false });
  assert.equal(hasNoPerSideVerdict(allFalse), true);
});

/* ------------------------------------------------------------------ */
/* steps_detail — parser garbage tolerance                             */
/* ------------------------------------------------------------------ */

test("parseRoofPlanReading: steps_detail — near-miss clamped, wild frac → null, garbage entries dropped, non-array → null", () => {
  const r = parseRoofPlanReading({
    readable: true,
    sides: {
      front: {
        eave_continuous: true,
        gable_end: false,
        steps: 3,
        steps_detail: [
          { position_frac: 0.25, direction: "outward" },
          { position_frac: 1.03, direction: "inward" }, // near miss → clamp to 1
          { position_frac: -0.02, direction: "sideways" }, // clamp to 0, direction coerced
          { position_frac: 3.7, direction: "outward" }, // wild → null, NEVER clamped into a corner
          { position_frac: "0.5", direction: "outward" }, // wrong type → null frac
          "garbage", // non-object entry dropped
          null,
        ],
      },
      rear: { eave_continuous: true, gable_end: false, steps_detail: [] },
      left: { eave_continuous: true, gable_end: false, steps_detail: "flat" },
      right: { eave_continuous: true, gable_end: false },
    },
    hips_at_corners: true,
    confidence: "high",
  });
  assert.ok(r);
  assert.deepEqual(r.sides.front.steps_detail, [
    { position_frac: 0.25, direction: "outward" },
    { position_frac: 1, direction: "inward" },
    { position_frac: 0, direction: "unknown" },
    { position_frac: null, direction: "outward" },
    { position_frac: null, direction: "outward" },
  ]);
  assert.deepEqual(r.sides.rear.steps_detail, [], "explicit [] survives (load-bearing straight side)");
  assert.equal(r.sides.left.steps_detail, null, "non-array → null (positions not read)");
  assert.equal(r.sides.right.steps_detail, null, "absent → null");
});

/* ------------------------------------------------------------------ */
/* feature_quadrants — parser garbage tolerance                        */
/* ------------------------------------------------------------------ */

test("parseRoofPlanReading: feature_quadrants — valid kept, garbage → null per key, non-object/absent → null", () => {
  const r = parseRoofPlanReading({
    readable: true,
    sides: {},
    hips_at_corners: true,
    confidence: "high",
    feature_quadrants: {
      garage: "front-right",
      porch: "middle", // not a quadrant word → null
      patio: 42,
      outdoor_living: "center",
    },
  });
  assert.ok(r);
  assert.deepEqual(r.feature_quadrants, {
    garage: "front-right",
    porch: null,
    patio: null,
    outdoor_living: "center",
  });

  const absent = parseRoofPlanReading({ readable: true, sides: {}, hips_at_corners: true, confidence: "high" });
  assert.equal(absent!.feature_quadrants, null, "absent → null (old stashes degrade)");
  const garbage = parseRoofPlanReading({
    readable: true, sides: {}, hips_at_corners: true, confidence: "high",
    feature_quadrants: ["front-right"],
  });
  assert.equal(garbage!.feature_quadrants, null, "array → null");
  assert.equal(emptyRoofPlanReading("x").feature_quadrants, null);
});

/* ------------------------------------------------------------------ */
/* roofPlanFracToViewerFrac — the fixed-convention converter           */
/* ------------------------------------------------------------------ */

test("roofPlanFracToViewerFrac: fixed convention on all four sides", () => {
  // front: plan house-LEFT→RIGHT is exactly the viewer's left→right.
  assert.equal(roofPlanFracToViewerFrac("front", 0.25), 0.25);
  // rear: facing the rear elevation the viewer's left is the house's RIGHT.
  assert.equal(roofPlanFracToViewerFrac("rear", 0.25), 0.75);
  // left: plan REAR→FRONT is the viewer's left→right on the left elevation.
  assert.equal(roofPlanFracToViewerFrac("left", 0.25), 0.25);
  // right: plan REAR→FRONT reverses — the viewer's left is the house FRONT.
  assert.equal(roofPlanFracToViewerFrac("right", 0.25), 0.75);
  // the mapping is an involution: converting twice returns the input
  for (const s of ROOF_PLAN_SIDES) {
    const twice = roofPlanFracToViewerFrac(s, roofPlanFracToViewerFrac(s, 0.3));
    assert.ok(Math.abs(twice - 0.3) < 1e-12, `${s} involution, got ${twice}`);
  }
});

test("roofPlanFracToViewerFrac: agrees with viewerPositionToPlanDir on every side (same rightDir convention)", () => {
  // Plan-frame frac 1 means: house-RIGHT end for front/rear, FRONT end for
  // left/right. Whatever viewer end that converts to, the tier-corner-veto's
  // own viewer→plan mapping must point that end at the SAME plan direction.
  const planDirOfFrac1: Record<RoofPlanSideName, { x: number; y: number }> = {
    front: { x: 1, y: 0 }, // house-right (+x)
    rear: { x: 1, y: 0 },
    left: { x: 0, y: 1 }, // front (+y, y-down front-at-bottom)
    right: { x: 0, y: 1 },
  };
  for (const s of ROOF_PLAN_SIDES) {
    const vf = roofPlanFracToViewerFrac(s, 1);
    assert.ok(vf === 0 || vf === 1, `frac 1 maps to a viewer end on ${s}`);
    const end = vf === 1 ? "right_end" : "left_end";
    assert.deepEqual(
      viewerPositionToPlanDir(s, end, null),
      planDirOfFrac1[s],
      `${s}: viewer ${end} must be the plan direction of plan-frac 1`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* roofPlanViewerSteps — the adapter                                    */
/* ------------------------------------------------------------------ */

test("roofPlanViewerSteps: no steps_detail anywhere / unreadable / absent → null (byte-identical degrade)", () => {
  assert.equal(roofPlanViewerSteps(null), null);
  assert.equal(roofPlanViewerSteps(undefined), null);
  assert.equal(roofPlanViewerSteps(emptyRoofPlanReading("faint")), null);
  assert.equal(roofPlanViewerSteps(fullHipReading()), null, "count-only sides (steps_detail absent) → null");
});

test("roofPlanViewerSteps: converts to the viewer frame, preserves [], nulls direction, keeps null fracs", () => {
  const reading = fullHipReading();
  reading.sides.front = hipSide({
    steps: 2,
    steps_detail: [
      { position_frac: 0.2, direction: "outward" },
      { position_frac: null, direction: "unknown" },
    ],
  });
  reading.sides.rear = hipSide({ steps: 1, steps_detail: [{ position_frac: 0.25, direction: "inward" }] });
  reading.sides.right = hipSide({ steps: 0, steps_detail: [] });
  const out = roofPlanViewerSteps(reading);
  assert.ok(out);
  assert.equal(out.front!.length, 2);
  assert.equal(out.front![0].position_frac, 0.2, "front is identity");
  assert.equal(out.front![0].direction, null, "plan outward/inward never guessed into up/down");
  assert.equal(out.front![0].offset_ft, null);
  assert.equal(out.front![0].kind, "unknown");
  assert.equal(out.front![1].position_frac, null, "unplaceable step passes through as null");
  assert.equal(out.rear![0].position_frac, 0.75, "rear flips (viewer left = house right)");
  assert.deepEqual(out.right, [], "explicit straight side preserved");
  assert.equal("left" in out, false, "side without the field omitted");
});
