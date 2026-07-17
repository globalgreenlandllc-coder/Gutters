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
  describeRoofPlanReading,
  type RoofPlanReading,
  type RoofPlanSide,
} from "./read-roof-layout.ts";
import { explainUnanimousHip, type FaceReadingRaw } from "./face-merge.ts";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function side(over: Partial<RoofPlanSide> = {}): RoofPlanSide {
  return { eave_continuous: null, gable_end: null, steps: null, ds_marks: null, ...over };
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
