import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineEdges } from "./plan-overlay.ts";
import { reconcileEdgeClasses } from "./reconcile-edge-classes.ts";
import { deriveHipCorners } from "./truss-field.ts";
import type { EdgeClass } from "./edge-takeoff.ts";
import type { FaceReadingRaw } from "./face-merge.ts";

// A plain rectangular hip roof (front at canvas bottom, y down).
// E1 top-h · E2 right-v · E3 bottom-h · E4 left-v (outlineEdges order).
const RECT = [
  { x: 0, y: 0 },
  { x: 400, y: 0 },
  { x: 400, y: 200 },
  { x: 0, y: 200 },
];
const PT_PER_FT = 10;

// House-relative face read (front/rear/left/right) — NO compass, as the
// Mascord 1168G set is titled. A fully-hipped face: roof_form hipped,
// continuous eave, zero gables.
const hipFace = (
  name: "front" | "rear" | "left" | "right",
  over?: Partial<FaceReadingRaw>,
): FaceReadingRaw => ({
  face: name,
  sheet_title: `${name.toUpperCase()} ELEVATION`,
  readable: true,
  unreadable_reason: null,
  roof_form: "hipped",
  gable_count: 0,
  continuous_eave: true,
  gables: [],
  projections: [],
  projection_cues: [],
  confidence: "high",
  ...over,
});

// The classifier's raw call BEFORE reconcile: the front + right walls got
// mis-tagged rake (the phantom-front-gable failure), the rest eave.
const misclassified = (): EdgeClass[] =>
  outlineEdges(RECT).map((e) => ({
    id: e.id,
    edge_class: e.id === "E2" || e.id === "E3" ? "rake" : "eave",
    tier: null,
    feature: null,
    evidence: ["truss_direction"],
  }));

test("hip: a compass-less FRONT/REAR/LEFT/RIGHT set is consumed (reconcile does not no-op)", () => {
  const edges = outlineEdges(RECT);
  const r = reconcileEdgeClasses({
    outline: RECT,
    edges,
    classes: misclassified(),
    perFace: {
      front: hipFace("front"),
      rear: hipFace("rear"),
      left: hipFace("left"),
      right: hipFace("right"),
    },
    ptPerFt: PT_PER_FT,
  });
  // It ran: the continuous-eave demote restored the mis-tagged rakes to eave.
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E2"), "eave", "right wall restored to eave on a hip");
  assert.equal(cls.get("E3"), "eave", "front wall restored to eave on a hip");
  assert.ok(
    r.notes.some((n) => /demoted to eave|hip/i.test(n)),
    "reconcile acted on the house-relative reads",
  );
});

test("hip: a hipped face VETOes an elevation-gable promotion (keeps the front eave)", () => {
  const edges = outlineEdges(RECT);
  // The front face is hipped but ALSO reports a phantom garage 'gable' — the
  // hip veto must keep the front (E3) eave rather than promote it to rake.
  const front = hipFace("front", {
    gable_count: 1,
    gables: [
      {
        id: "g0",
        kind: "garage",
        span_ft: 20,
        pitch: null,
        position_frac: 0.5,
        eave_condition_guess: "flush",
        supported_on: "wall",
        shows_projection_cue: false,
        set_back_ft: 0,
        notes: "",
      },
    ],
  });
  const r = reconcileEdgeClasses({
    outline: RECT,
    edges,
    classes: outlineEdges(RECT).map((e) => ({
      id: e.id,
      edge_class: "eave" as const,
      tier: null,
      feature: null,
      evidence: [],
    })),
    perFace: { front, rear: hipFace("rear"), left: hipFace("left"), right: hipFace("right") },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E3"), "eave", "hip veto kept the front eave over the phantom garage gable");
  assert.ok(
    r.notes.some((n) => /HIP end/i.test(n)),
    "the veto is surfaced as a note",
  );
});

test("hip: a REAL gable (not a hip) still promotes to rake — no under-count regression", () => {
  const edges = outlineEdges(RECT);
  // Rear face is genuinely gabled (roof_form gabled), a full-width gable end.
  const rear = hipFace("rear", {
    roof_form: "gabled",
    continuous_eave: false,
    gable_count: 1,
    gables: [
      {
        id: "g0",
        kind: "main",
        span_ft: 40, // ~full 400pt/10 = 40ft wall
        pitch: null,
        position_frac: 0.5,
        eave_condition_guess: "flush",
        supported_on: "wall",
        shows_projection_cue: false,
        set_back_ft: 0,
        eave_passes_in_front: false,
        notes: "",
      },
    ],
  });
  const r = reconcileEdgeClasses({
    outline: RECT,
    edges,
    classes: outlineEdges(RECT).map((e) => ({
      id: e.id,
      edge_class: "eave" as const,
      tier: null,
      feature: null,
      evidence: [],
    })),
    perFace: { front: hipFace("front"), rear, left: hipFace("left"), right: hipFace("right") },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  // E1 is the rear (top) wall — a real gable end must NOT keep its gutter.
  assert.notEqual(cls.get("E1"), "eave", "a genuine gable end is still promoted off eave");
});

test("deriveHipCorners: hips at all 4 outside corners mark all 4 edges as eaves", () => {
  const edges = outlineEdges(RECT);
  // Four ~45° hip diagonals, one springing inward from each corner.
  const segments = [
    [0, 0, 40, 40],
    [400, 0, 360, 40],
    [400, 200, 360, 160],
    [0, 200, 40, 160],
  ];
  const hint = deriveHipCorners({ outline: RECT, edges, segments, ptPerFt: PT_PER_FT });
  assert.equal(hint.size, 4, "all four perimeter edges flanked by a hip");
  for (const id of ["E1", "E2", "E3", "E4"]) assert.ok(hint.has(id), `${id} hinted`);
});

test("deriveHipCorners: a valley off an INSIDE (reflex) corner is ignored", () => {
  // L-shaped footprint with one reflex (inside) corner at (200,100).
  const L = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
    { x: 400, y: 100 },
    { x: 400, y: 300 },
    { x: 0, y: 300 },
  ];
  const edges = outlineEdges(L);
  // A diagonal springing from the reflex corner (200,100) inward — a VALLEY.
  const segments = [[200, 100, 240, 140]];
  const hint = deriveHipCorners({ outline: L, edges, segments, ptPerFt: PT_PER_FT });
  assert.equal(hint.size, 0, "valley at a reflex corner produces no eave hint");
});

test("hip: the HIP VETO fires before the beam gate — a beam-read garage 'gable' on a hipped face never removes the gutter", () => {
  // Non-regression for the Woodinville beam-gate change: on a 1168G-shaped
  // hip home a phantom 'garage gable on beams' whose span matches the front
  // wall must NOT become a rake (the beam gate would remove real LF) — the
  // hip veto still wins, and nothing is recorded or dropped.
  const edges = outlineEdges(RECT);
  const front = hipFace("front", {
    gable_count: 1,
    gables: [
      {
        id: "g0",
        kind: "garage",
        span_ft: 40, // == the full 40ft front wall (wall ≈ span)
        pitch: null,
        position_frac: 0.5,
        eave_condition_guess: "flush",
        supported_on: "beam",
        shows_projection_cue: false,
        set_back_ft: 0,
        notes: "",
      },
    ],
  });
  const r = reconcileEdgeClasses({
    outline: RECT,
    edges,
    classes: outlineEdges(RECT).map((e) => ({
      id: e.id,
      edge_class: "eave" as const,
      tier: null,
      feature: null,
      evidence: [],
    })),
    perFace: { front, rear: hipFace("rear"), left: hipFace("left"), right: hipFace("right") },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E3"), "eave", "hip veto keeps the front gutter");
  assert.ok(r.notes.some((n) => /HIP end/i.test(n)), "the veto is surfaced");
  assert.equal(r.droppedProjections.length, 0, "nothing routed off-outline");
  assert.equal(r.frameOverEnds.length, 0, "no phantom gable recorded for drawing");
});

test("hip: the continuous-eave demote still restores mis-tagged rakes and records no frame-over ends", () => {
  // The original 1168G shape must be byte-for-byte unaffected by the new
  // frame-over channel: demotes happen, frameOverEnds stays empty.
  const edges = outlineEdges(RECT);
  const r = reconcileEdgeClasses({
    outline: RECT,
    edges,
    classes: misclassified(),
    perFace: {
      front: hipFace("front"),
      rear: hipFace("rear"),
      left: hipFace("left"),
      right: hipFace("right"),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E2"), "eave");
  assert.equal(cls.get("E3"), "eave");
  assert.equal(r.frameOverEnds.length, 0);
  assert.equal(r.droppedProjections.length, 0);
});
