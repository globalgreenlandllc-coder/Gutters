import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineEdges } from "./plan-overlay.ts";
import { reconcileEdgeClasses } from "./reconcile-edge-classes.ts";
import type { EdgeClass } from "./edge-takeoff.ts";
import type { FaceReadingRaw } from "./face-merge.ts";

// Synthetic Woodinville-in-miniature (pt, y down, front at canvas bottom):
// main 400×200 body + rear patio stub (top) + front porch stub (bottom).
const OUTLINE = [
  { x: 0, y: 0 },
  { x: 280, y: 0 },
  { x: 280, y: -60 },
  { x: 360, y: -60 },
  { x: 360, y: 0 },
  { x: 400, y: 0 },
  { x: 400, y: 200 },
  { x: 250, y: 200 },
  { x: 250, y: 260 },
  { x: 150, y: 260 },
  { x: 150, y: 200 },
  { x: 0, y: 200 },
];
// E1 back-left h · E2 patio-left v · E3 patio-end h (rear GABLE) ·
// E4 patio-right v · E5 back-right h · E6 right v · E7 front-right h ·
// E8 porch-right v · E9 porch-front h (entry GABLE) · E10 porch-left v ·
// E11 front-left h · E12 left v

const PT_PER_FT = 10;

const face = (
  name: "north" | "south" | "east" | "west",
  title: string,
  gables: Partial<FaceReadingRaw["gables"][number]>[],
  over?: Partial<FaceReadingRaw>,
): FaceReadingRaw => ({
  face: name,
  sheet_title: title,
  readable: true,
  unreadable_reason: null,
  gable_count: gables.length,
  continuous_eave: true,
  gables: gables.map((g, i) => ({
    id: `g${i}`,
    kind: "other",
    span_ft: null,
    pitch: null,
    position_frac: null,
    eave_condition_guess: "flush",
    supported_on: "unknown",
    shows_projection_cue: false,
    set_back_ft: 0,
    notes: "",
    ...g,
  })),
  projections: [],
  projection_cues: [],
  confidence: "high",
  ...over,
});

// The production run-2 failure, in miniature: one global truss direction →
// every horizontal edge eave, every vertical edge rake.
const invertedClasses = (): EdgeClass[] =>
  outlineEdges(OUTLINE).map((e) => ({
    id: e.id,
    edge_class: e.axis === "h" ? "eave" : "rake",
    tier: null,
    feature: null,
    evidence: ["truss_direction"],
  }));

// Woodinville titles: front=NORTH (plan-north points down the sheet).
const PER_FACE = {
  north: face("north", "FRONT/NORTH ELEVATION", [
    { kind: "entry", span_ft: 10, position_frac: 0.5, supported_on: "posts" },
  ]),
  south: face("south", "REAR/SOUTH ELEVATION", [
    // Viewed from behind the house the patio (x≈320) sits at u≈0.2.
    { kind: "patio", span_ft: 8, position_frac: 0.2 },
  ]),
  east: face("east", "LEFT/EAST ELEVATION", []),
  west: face("west", "RIGHT/WEST ELEVATION", []),
};

test("reconcile: the inverted production read gets corrected by the elevations", () => {
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(),
    perFace: PER_FACE,
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  // The entry-porch front (E9) and patio end (E3) become gables…
  assert.equal(cls.get("E9"), "rake", "entry porch front promoted to rake");
  assert.equal(cls.get("E3"), "rake", "patio end promoted to rake");
  // …and every side wall the elevations show as continuous eave gets its
  // gutter back.
  for (const id of ["E2", "E4", "E6", "E8", "E10", "E12"]) {
    assert.equal(cls.get(id), "eave", `${id} demoted rake→eave`);
  }
  // Untouched true eaves stay eaves.
  for (const id of ["E1", "E5", "E7", "E11"]) {
    assert.equal(cls.get(id), "eave", `${id} unchanged`);
  }
  assert.equal(r.promoted, 2);
  assert.equal(r.demoted, 6);
  assert.ok(r.notes.some((n) => n.includes("Edge↔elevation reconcile")));
});

test("reconcile: a printed GABLE END TRUSS label is never demoted", () => {
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E6" ? { ...c, evidence: ["gable_end_truss_label"] } : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: PER_FACE,
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E6"), "rake", "labeled rake kept");
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("verify")),
    "conflict with the elevation is noted",
  );
});

test("reconcile: a gable spanning part of a long wall goes UNKNOWN, not rake", () => {
  const edges = outlineEdges(OUTLINE);
  const perFace = {
    ...PER_FACE,
    north: face(
      "north",
      "FRONT/NORTH ELEVATION",
      // 4 ft gable mapped onto the 15 ft front-left wall (E11). The face's
      // eave is NOT continuous (a wall-plane gable interrupts it).
      [{ kind: "dormer", span_ft: 4, position_frac: 0.15 }],
      { continuous_eave: false },
    ),
  };
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(),
    perFace,
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E11"), "unknown", "partial gable → unknown (unpriced)");
  assert.ok(r.notes.some((n) => n.includes("partial gable")));
});

test("reconcile: set-back gables never consume a perimeter edge", () => {
  const edges = outlineEdges(OUTLINE);
  const perFace = {
    ...PER_FACE,
    east: face("east", "LEFT/EAST ELEVATION", [
      { kind: "main", span_ft: 16, position_frac: 0.5, set_back_ft: 5 },
    ]),
  };
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(),
    perFace,
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  // The frame-over gable sits above the lower roof — the east-facing walls
  // (canvas left) still carry their gutters.
  assert.equal(cls.get("E12"), "eave");
  assert.equal(cls.get("E10"), "eave");
});

test("reconcile: on a continuous-eave face, a gable with UNKNOWN set-back is a frame-over (wall keeps its gutter)", () => {
  const edges = outlineEdges(OUTLINE);
  const perFace = {
    ...PER_FACE,
    east: face("east", "LEFT/EAST ELEVATION", [
      // The live-run failure: the reader saw the upper frame-over gable but
      // never reported set_back_ft — with a continuous eave those can't be
      // wall-plane gables.
      { kind: "main", span_ft: 16, position_frac: 0.5, set_back_ft: null },
    ]),
  };
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(),
    perFace,
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E12"), "eave", "side wall keeps the gutter");
  assert.equal(cls.get("E10"), "eave");
  assert.ok(r.notes.some((n) => n.includes("frame-over")));
});

test("reconcile: a posts-supported gable never consumes a base-line house wall", () => {
  const edges = outlineEdges(OUTLINE);
  const perFace = {
    ...PER_FACE,
    north: face(
      "north",
      "FRONT/NORTH ELEVATION",
      // A projecting porch roof read at a position with NO protruding stub —
      // it maps onto the plain front wall E11, which must keep its gutter.
      // Non-continuous face so the posts guard itself is what fires.
      [{ kind: "porch", span_ft: 10, position_frac: 0.1, supported_on: "posts" }],
      { continuous_eave: false },
    ),
  };
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(),
    perFace,
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E11"), "eave", "base wall untouched");
  assert.ok(
    r.notes.some((n) => n.includes("projects beyond this wall")),
    "the projecting roof is surfaced for review",
  );
});

test("reconcile: a truss-field parallel hint promotes when the face shows a gable", () => {
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    // E11 (front-left wall) read as eave; the sheet's framing says gable end.
    classes: invertedClasses(),
    perFace: PER_FACE,
    ptPerFt: PT_PER_FT,
    fieldParallel: new Set(["E11"]),
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E11"), "rake", "sheet gable promoted");
  assert.ok(r.notes.some((n) => n.includes("E11") && n.includes("📐")));
});

test("reconcile: a truss-field bearing wall (fieldEave) can't be re-promoted by a mapped gable", () => {
  const edges = outlineEdges(OUTLINE);
  const classes = outlineEdges(OUTLINE).map((e) => ({
    id: e.id,
    edge_class: "eave" as const,
    tier: null,
    feature: null,
    evidence: ["truss_field_perpendicular"],
  }));
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: PER_FACE,
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E9"]),
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E9"), "eave", "bearing wall keeps the gutter");
  assert.ok(r.notes.some((n) => n.includes("E9") && n.includes("frame-over")));
});

test("reconcile: a gable the mapping missed raises a budget warning", () => {
  const edges = outlineEdges(OUTLINE);
  const perFace = {
    ...PER_FACE,
    north: face("north", "FRONT/NORTH ELEVATION", [
      { kind: "entry", span_ft: 10, position_frac: 0.5, supported_on: "posts" },
      // A second flush gable whose position doesn't land on any wall span.
      { kind: "main", span_ft: 12, position_frac: null },
    ]),
  };
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(),
    perFace,
    ptPerFt: PT_PER_FT,
  });
  assert.ok(
    r.notes.some((n) => n.includes("⚠") && n.includes("north")),
    "deficit surfaced",
  );
});

test("reconcile: a continuous-eave face needs SHEET corroboration to consume a wall — even with set-back 0", () => {
  // The run-4 failure: the side elevations' frame-over gables came back with
  // an explicit set_back of 0, defeating the unknown-set-back gate, and
  // CONFIRMED the raw rake calls on the side walls (E13/E3 tents).
  const edges = outlineEdges(OUTLINE);
  const perFace = {
    ...PER_FACE,
    east: face("east", "LEFT/EAST ELEVATION", [
      // 14 ft on a 20 ft wall — a frame-over-sized claim (the real
      // Woodinville reads were ~73% of the wall). A near-full-width claim
      // (>=80%) would pierce the gate as a true wall-plane gable.
      { kind: "main", span_ft: 14, position_frac: 0.5, set_back_ft: 0 },
    ]),
  };
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(), // side walls arrive as raw rakes
    perFace,
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E12"), "eave", "side wall demoted, not confirmed");
  assert.equal(cls.get("E10"), "eave");
  assert.ok(
    r.notes.some((n) => n.includes("continuous eave/gutter line across this side")),
    "the hard gate explains itself",
  );
});

test("reconcile: sheet evidence pierces the continuous-eave gate", () => {
  // Same face, but the wall the gable maps onto carries gable-end framing
  // (fieldParallel) — the gate's escape lets the mapping land. E12 arrives
  // as EAVE so only the gate escape + mapping can make it rake.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E12" ? { ...c, edge_class: "eave" as const } : c,
  );
  const perFace = {
    ...PER_FACE,
    east: face("east", "LEFT/EAST ELEVATION", [
      // u 0.5 maps onto E12 (the fieldParallel'd wall).
      { kind: "main", span_ft: 14, position_frac: 0.5, set_back_ft: 0 },
    ]),
  };
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace,
    ptPerFt: PT_PER_FT,
    fieldParallel: new Set(["E12"]),
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E12"), "rake", "field-backed gable survives the gate");
  assert.ok(
    r.notes.some((n) => n.includes("E12") && n.includes("RAKE")),
    "promotion is noted",
  );
});

test("reconcile: a near-full-width gable claim pierces the gate (true wall-plane gable)", () => {
  // Rectangle-gable-house protection: the reader sloppily says
  // continuous_eave=true but reads the REAL gable spanning ~the whole wall.
  const edges = outlineEdges(OUTLINE);
  const perFace = {
    ...PER_FACE,
    east: face("east", "LEFT/EAST ELEVATION", [
      { kind: "main", span_ft: 19, position_frac: 0.5, set_back_ft: 0 },
    ]),
  };
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(),
    perFace,
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E12"), "rake", "full-width gable stays a gable");
});

test("reconcile: no per-face reads → untouched", () => {
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(),
    perFace: null,
    ptPerFt: PT_PER_FT,
  });
  assert.equal(r.promoted + r.demoted + r.unknowns, 0);
  assert.deepEqual(
    r.classes.map((c) => c.edge_class),
    invertedClasses().map((c) => c.edge_class),
  );
});

test("reconcile: a label-vs-field conflict on a continuous-eave face gets its gutter back", () => {
  // The Woodinville run-5 failure: E5/E11 (long side walls) carried a stray
  // GABLE END TRUSS label, the field read perpendicular (conflict → unknown),
  // and the side's elevation read one continuous gutter line — the wall
  // shipped UNPRICED. Two sheet reads outvote the stray label.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E6"
      ? {
          ...c,
          edge_class: "unknown" as const,
          evidence: ["gable_end_truss_label", "truss_field_conflict"],
        }
      : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: PER_FACE,
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E6"), "eave", "gutter restored");
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("outvote")),
    "recovery says why",
  );
});

test("reconcile: the conflict recovery needs a continuous eave read — else it stays UNPRICED", () => {
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E6"
      ? {
          ...c,
          edge_class: "unknown" as const,
          evidence: ["gable_end_truss_label", "truss_field_conflict"],
        }
      : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      ...PER_FACE,
      west: face("west", "RIGHT/WEST ELEVATION", [], { continuous_eave: false }),
    },
    ptPerFt: PT_PER_FT,
  });
  assert.equal(
    new Map(r.classes.map((c) => [c.id, c.edge_class])).get("E6"),
    "unknown",
    "one corroboration is not enough",
  );
});

test("reconcile: a conflict edge a gable also claims stays a tie (UNPRICED)", () => {
  // Label + mapped elevation gable vs field + continuous eave: 2-2 — human
  // review, never auto-priced either way.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E6"
      ? {
          ...c,
          edge_class: "unknown" as const,
          evidence: ["gable_end_truss_label", "truss_field_conflict"],
        }
      : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      ...PER_FACE,
      west: face("west", "RIGHT/WEST ELEVATION", [
        { kind: "other", span_ft: 10, position_frac: 0.5 },
      ]),
    },
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E6"]),
  });
  assert.equal(
    new Map(r.classes.map((c) => [c.id, c.edge_class])).get("E6"),
    "unknown",
    "2-2 evidence tie is a human call",
  );
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("frame-over")),
    "the blocked gable is noted",
  );
});

test("reconcile: a FLOATING gable on the side vetoes the conflict recovery (null position)", () => {
  // Adversarial-review variant A: the elevation DID report a gable on this
  // side but its position didn't read — it never claims any wall, so it
  // could be the conflicted label's gable. The tie must stand.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E6"
      ? {
          ...c,
          edge_class: "unknown" as const,
          evidence: ["gable_end_truss_label", "truss_field_conflict"],
        }
      : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      ...PER_FACE,
      west: face("west", "RIGHT/WEST ELEVATION", [
        { kind: "other", span_ft: 12, position_frac: null },
      ]),
    },
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E6"]),
  });
  assert.equal(
    new Map(r.classes.map((c) => [c.id, c.edge_class])).get("E6"),
    "unknown",
    "unpinned gable could be the label's gable — stays UNPRICED",
  );
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("couldn't be pinned")),
  );
});

test("reconcile: a FLOATING gable vetoes the recovery (null set-back on a continuous face)", () => {
  // Adversarial-review variant B: set_back_ft:null on a continuous-eave face
  // drops the gable to frame-over BEFORE mapping — it must still veto.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E6"
      ? {
          ...c,
          edge_class: "unknown" as const,
          evidence: ["gable_end_truss_label", "truss_field_conflict"],
        }
      : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      ...PER_FACE,
      west: face("west", "RIGHT/WEST ELEVATION", [
        {
          kind: "other",
          span_ft: 20,
          position_frac: 0.5,
          set_back_ft: null as unknown as number,
        },
      ]),
    },
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E6"]),
  });
  assert.equal(
    new Map(r.classes.map((c) => [c.id, c.edge_class])).get("E6"),
    "unknown",
    "a full-width gable guess must not be priced away",
  );
});

test("reconcile: gables pinned to OTHER walls do not veto the recovery", () => {
  // The Woodinville run-5 shape: the side's one gable maps onto a different
  // wall (frame-over there) — nothing floats, so the conflicted side wall
  // still gets its gutter back.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E6"
      ? {
          ...c,
          edge_class: "unknown" as const,
          evidence: ["gable_end_truss_label", "truss_field_conflict"],
        }
      : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: PER_FACE, // west face: no gables at all
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E6"]),
  });
  assert.equal(
    new Map(r.classes.map((c) => [c.id, c.edge_class])).get("E6"),
    "eave",
    "clean side — recovery still fires",
  );
});

test("reconcile: a gable rising BEHIND a running eave (stepped face) keeps the wall guttered", () => {
  // Run-8 failure: the side elevations honestly read continuous_eave:false
  // (stepped eave heights), so the hard gate never fired and the side gable
  // tented E13/E3-style walls. eave_passes_in_front is the decisive signal.
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(), // E6 arrives as rake (truss_direction only)
    perFace: {
      ...PER_FACE,
      west: face(
        "west",
        "RIGHT/WEST ELEVATION",
        [
          {
            kind: "main",
            span_ft: 12,
            position_frac: 0.5,
            eave_passes_in_front: true,
          } as never,
        ],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E6"), "eave", "wall under the frame-over keeps gutter");
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("BEHIND a running eave")),
  );
});

test("reconcile: an unknown edge flanking a gable end becomes its side eave", () => {
  // E9 (porch front) is the promoted entry gable; E8 (porch right return,
  // perpendicular ring neighbor) arrives UNKNOWN with no evidence — the
  // gable roof sheds onto it, so it carries the gutter.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E8"
      ? { ...c, edge_class: "unknown" as const, evidence: ["truss_direction"] }
      : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: PER_FACE,
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E9"), "rake", "entry gable still promoted");
  assert.equal(cls.get("E8"), "eave", "flanking return priced as side eave");
  assert.ok(
    r.notes.some((n) => n.includes("E8") && n.includes("flanks the gable end E9")),
  );
});

test("reconcile: gable-side rescue skips labeled and conflict-parked edges", () => {
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) => {
    if (c.id === "E8")
      return {
        ...c,
        edge_class: "unknown" as const,
        evidence: ["gable_end_truss_label"],
      };
    if (c.id === "E10")
      return {
        ...c,
        edge_class: "unknown" as const,
        evidence: ["truss_field_conflict"],
      };
    return c;
  });
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    // E10's face reads stepped (continuous false) so the 2b recovery cannot
    // fire — this isolates pass 4, which must leave both edges parked.
    perFace: {
      ...PER_FACE,
      east: face("east", "LEFT/EAST ELEVATION", [], { continuous_eave: false }),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E8"), "unknown", "printed label stays parked");
  assert.equal(cls.get("E10"), "unknown", "conflict tie stays parked");
});

test("reconcile: a frame-over pinned to one wall never demotes its neighbor (exclusive pin)", () => {
  // Adversarial review (c3a2385): the fo test matched ANY rake span within
  // loose tolerances — a frame-over belonging to the porch span demoted the
  // neighboring wall's true gable end. Pinning is exclusive now.
  const edges = outlineEdges(OUTLINE);
  // Front side spans: E11 u 0–0.375 · E9 (porch) u 0.375–0.625 · E7 u 0.625–1.
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    // E7 rake; its ring neighbors E6/E8 forced eave so pass 4 (gable-side
    // adjacency) cannot fire — this isolates the frame-over pin logic.
    classes: invertedClasses().map((c) =>
      c.id === "E7"
        ? { ...c, edge_class: "rake" as const }
        : c.id === "E6" || c.id === "E8"
          ? { ...c, edge_class: "eave" as const }
          : c,
    ),
    perFace: {
      ...PER_FACE,
      north: face(
        "north",
        "FRONT/NORTH ELEVATION",
        [
          {
            kind: "other",
            span_ft: 8,
            position_frac: 0.6, // inside the PORCH span, near E7's boundary
            eave_passes_in_front: true,
          } as never,
        ],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.notEqual(
    cls.get("E7"),
    "eave",
    "the neighbor wall must not be priced off a frame-over pinned elsewhere",
  );
});

test("reconcile: a full-width gable stays a wall plane even with eave_passes_in_front misread", () => {
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(), // E6 arrives rake
    perFace: {
      ...PER_FACE,
      west: face(
        "west",
        "RIGHT/WEST ELEVATION",
        [
          {
            kind: "main",
            span_ft: 20, // == E6's full 20 ft — the wall plane itself
            position_frac: 0.5,
            eave_passes_in_front: true,
          } as never,
        ],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  assert.equal(
    new Map(r.classes.map((c) => [c.id, c.edge_class])).get("E6"),
    "rake",
    "a gable as wide as the whole wall cannot be a frame-over",
  );
});

test("reconcile: pass 4 never prices a wall whose framing field reads a gable-end array", () => {
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E8"
      ? { ...c, edge_class: "unknown" as const, evidence: ["truss_direction"] }
      : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: PER_FACE,
    ptPerFt: PT_PER_FT,
    fieldParallel: new Set(["E8"]),
  });
  assert.equal(
    new Map(r.classes.map((c) => [c.id, c.edge_class])).get("E8"),
    "unknown",
    "sheet-marked gable end stays parked, never priced by adjacency",
  );
});

test("reconcile: a gable WIDER than its wall is an overframe — never tented (run-10 E3)", () => {
  // The west read claimed a 24ft gable on the 20ft side wall E6 — a gable
  // wider than its wall cannot be that wall's plane (its roof spans past:
  // the sections print these as FRAME-OVER PER PLAN). The wall must ship
  // UNPRICED, not tented. Protruding stubs stay exempt (covered by the
  // porch-promote tests, whose stub gables read wider than the inset wall).
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(), // E6 arrives rake (truss_direction only)
    perFace: {
      ...PER_FACE,
      west: face(
        "west",
        "RIGHT/WEST ELEVATION",
        [{ kind: "main", span_ft: 24, position_frac: 0.5 } as never],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E6"), "unknown", "over-wide gable claim parks the wall");
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("overframe")),
    "the overframe note explains it",
  );
});
