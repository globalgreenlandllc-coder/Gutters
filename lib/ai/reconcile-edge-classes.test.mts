import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineEdges } from "./plan-overlay.ts";
import { reconcileEdgeClasses } from "./reconcile-edge-classes.ts";
import { buildEdgeTakeoff, type EdgeClass } from "./edge-takeoff.ts";
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

test("reconcile: a gable spanning part of a long wall carves the span out — gutter kept on the remainder", () => {
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
  const e11 = r.classes.find((c) => c.id === "E11")!;
  // Never the whole wall as rake — and no longer $0 either: the wall stays
  // an eave with exactly the gable's interval carved out.
  assert.equal(e11.edge_class, "eave", "partial-gable wall keeps its gutter");
  assert.equal(e11.partial_gables?.length, 1, "one gable interval recorded");
  const g = e11.partial_gables![0];
  // 4 ft of the 15 ft wall — interval width ≈ 4/15.
  assert.ok(Math.abs(g.u1 - g.u0 - 4 / 15) < 0.02, "interval spans the gable width");
  assert.ok(
    r.notes.some((n) => n.includes("gutter kept on the remaining ~11ft")),
    "remainder note present",
  );
});

// Simple 40×20 ft rectangle (400×200 pt at 10 pt/ft), front at the bottom.
const RECT_OUTLINE = [
  { x: 0, y: 0 },
  { x: 400, y: 0 },
  { x: 400, y: 200 },
  { x: 0, y: 200 },
];
// E1 back h · E2 right v · E3 front h (400pt = 40ft) · E4 left v

test("reconcile: two gables sharing one rake wall flag the unpriced remainder (missing jog signature)", () => {
  const edges = outlineEdges(RECT_OUTLINE);
  const classes: EdgeClass[] = edges.map((e) => ({
    id: e.id,
    edge_class: "eave",
    tier: null,
    feature: null,
    evidence: ["truss_direction"],
  }));
  const perFace = {
    ...PER_FACE,
    north: face(
      "north",
      "FRONT/NORTH ELEVATION",
      [
        { kind: "main", span_ft: 25, position_frac: 0.5 },
        { kind: "garage", span_ft: 5, position_frac: 0.9 },
      ],
      { continuous_eave: false },
    ),
    south: face("south", "REAR/SOUTH ELEVATION", []),
  };
  const r = reconcileEdgeClasses({
    outline: RECT_OUTLINE,
    edges,
    classes,
    perFace,
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E3"), "rake", "the 25ft main gable tents the wall");
  assert.ok(
    r.notes.some(
      (n) => n.includes("share this 40ft wall") && n.includes("UNPRICED"),
    ),
    "multi-gable remainder flagged",
  );
});

test("reconcile: a proven offset jog with a straight footprint side gets the footprint↔elevation flag", () => {
  const edges = outlineEdges(RECT_OUTLINE);
  const classes: EdgeClass[] = edges.map((e) => ({
    id: e.id,
    edge_class: "eave",
    tier: null,
    feature: null,
    evidence: ["truss_direction"],
  }));
  const perFace = {
    ...PER_FACE,
    // North proves a garage; south (readable) shows none → offset jog on
    // the north side. The rectangle's north side is one straight line.
    north: face(
      "north",
      "FRONT/NORTH ELEVATION",
      [{ kind: "garage", span_ft: 25, position_frac: 0.5 }],
      { continuous_eave: false },
    ),
    south: face("south", "REAR/SOUTH ELEVATION", []),
  };
  const r = reconcileEdgeClasses({
    outline: RECT_OUTLINE,
    edges,
    classes,
    perFace,
    ptPerFt: PT_PER_FT,
  });
  assert.ok(
    r.notes.some(
      (n) =>
        n.includes("footprint↔elevation") &&
        n.includes("garage") &&
        n.includes("no step"),
    ),
    "jog-contradiction flag present",
  );
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
  // NEW: the drop is now also emitted as a structured signal so the estimate
  // assembler can synthesize an estimated gutter line instead of losing the LF.
  assert.equal(r.droppedProjections.length, 1, "one dropped projection recorded");
  assert.equal(r.droppedProjections[0].kind, "porch");
  assert.equal(r.droppedProjections[0].supportedOn, "posts");
  assert.equal(r.droppedProjections[0].spanFt, 10);
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

test("reconcile: a conflict gable with NO mappable span on a stepped face still parks the wall (ladder d)", () => {
  // Resolution-ladder round: label + field conflict + a pinned gable whose
  // SPAN didn't read, on a face with no continuous eave line — none of the
  // ladder's rungs can resolve it deterministically, so today's park stands
  // (UNPRICED, human review). This is the only shape that still parks.
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
      west: face(
        "west",
        "RIGHT/WEST ELEVATION",
        [{ kind: "other", span_ft: null, position_frac: 0.5 }],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E6"]),
  });
  assert.equal(
    new Map(r.classes.map((c) => [c.id, c.edge_class])).get("E6"),
    "unknown",
    "spanless conflict gable is a human call",
  );
  assert.ok(
    r.notes.some(
      (n) => n.includes("E6") && n.includes("stays under review (UNPRICED)"),
    ),
    "the park is noted",
  );
  // An unresolved park is NOT a placed gable — the budget check still warns.
  assert.ok(
    r.notes.some(
      (n) =>
        n.includes("west") &&
        n.includes("only 0 gable wall(s)/frame-over(s) placed"),
    ),
    "unresolved conflict still raises the placement warning",
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

test("reconcile: an ABOVE-EAVE floater (null set-back on a continuous face) no longer vetoes the recovery — gutter restored, gable drawn", () => {
  // Un-poisoned 2b (was adversarial variant B): a gable the continuous-eave
  // filter dropped sits ABOVE the face's one gutter line BY DEFINITION — it
  // cannot be the conflicted label's wall plane. The framing + the unbroken
  // fascia outvote the stray label (gutter restored) and the floater is
  // recorded to frameOverEnds so the drawing still gains the side gable.
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
    "eave",
    "framing + continuous eave outvote the label; the floater is above the line",
  );
  const fo = r.frameOverEnds.find((f) => f.edgeId === "E6");
  assert.ok(fo, "the above-eave gable is recorded for drawing");
  assert.equal(fo!.source, "truss-conflict");
  assert.equal(fo!.spanFt, 20);
  assert.equal(fo!.u, 0.5);
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("outvote")),
    "the recovery says why",
  );
  assert.ok(
    !r.notes.some((n) => n.includes("couldn't be pinned")),
    "the old park note is gone",
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

test("reconcile: an UNKNOWN base wall with a partial gable stays UNKNOWN — never promoted to priced eave", () => {
  const edges = outlineEdges(RECT_OUTLINE);
  // Front wall (E3) base-classed UNKNOWN — the classifier couldn't decide.
  const classes: EdgeClass[] = edges.map((e) => ({
    id: e.id,
    edge_class: e.id === "E3" ? "unknown" : "eave",
    tier: null,
    feature: null,
    evidence: [],
  }));
  const perFace = {
    ...PER_FACE,
    north: face(
      "north",
      "FRONT/NORTH ELEVATION",
      [{ kind: "dormer", span_ft: 6, position_frac: 0.5 }], // 6ft on 40ft wall
      { continuous_eave: false },
    ),
    south: face("south", "REAR/SOUTH ELEVATION", []),
  };
  const r = reconcileEdgeClasses({
    outline: RECT_OUTLINE,
    edges,
    classes,
    perFace,
    ptPerFt: PT_PER_FT,
  });
  const e3 = r.classes.find((c) => c.id === "E3")!;
  assert.equal(e3.edge_class, "unknown", "unknown base stays unpriced — no partial carve");
  assert.equal(e3.partial_gables, undefined, "no gutter interval priced");
});

// ── Woodinville fix round: overframe note truth, frame-over channel, ─────────
// ── span-aware pinning, beam-gate plausibility, budget dedupe, shortfall ─────

test("reconcile: overframe on an EAVE-base wall keeps the gutter and says so (no false UNPRICED)", () => {
  // Production notes 16/18 claimed E13/E3 shipped UNPRICED while both walls
  // stayed priced eaves. The note must tell the truth — and the rejected
  // gable is recorded for drawing (frameOverEnds), never as a class change.
  const edges = outlineEdges(OUTLINE);
  const classes: EdgeClass[] = edges.map((e) => ({
    id: e.id,
    edge_class: "eave",
    tier: null,
    feature: null,
    evidence: ["truss_direction"],
  }));
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
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
  assert.equal(cls.get("E6"), "eave", "priced eave stays priced");
  const note = r.notes.find((n) => n.includes("E6") && n.includes("frame-over"));
  assert.ok(note, "overframe note present");
  assert.ok(note!.includes("keeps its gutter"), "note says the wall stays priced");
  assert.ok(!note!.includes("UNPRICED"), "no false UNPRICED claim on an eave base");
  const fo = r.frameOverEnds.find((f) => f.edgeId === "E6");
  assert.ok(fo, "rejected gable recorded for drawing");
  assert.equal(fo!.source, "overframe");
  assert.equal(fo!.spanFt, 24);
});

test("reconcile: overframe on a RAKE base still parks the wall UNPRICED (wording unchanged)", () => {
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
        [{ kind: "main", span_ft: 24, position_frac: 0.5 } as never],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E6"), "unknown", "rake base parks for review");
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("UNPRICED")),
    "the rake→unknown branch keeps its UNPRICED wording",
  );
  assert.equal(r.frameOverEnds.filter((f) => f.edgeId === "E6").length, 1);
});

test("reconcile: eave-in-front + span WIDER than the wall stays a frame-over (ordering fix) — gutter restored, gable recorded", () => {
  // The S8 failure: eave_passes_in_front:true with span 32ft on a 22ft wall
  // pierced the >=0.8× forced-flush exemption, went FLUSH, and the overframe
  // gate then discarded the gable entirely — no gable end drawn, wing
  // rendered as a hip. Now >1.08× stays in the frame-over channel.
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
        [
          {
            kind: "main",
            span_ft: 32, // 320pt on the 200pt E6 — clearly wider
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
  assert.equal(cls.get("E6"), "eave", "wall under the frame-over keeps its gutter");
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("BEHIND a running eave")),
    "the frame-over demote explains itself",
  );
  const fo = r.frameOverEnds.find((f) => f.edgeId === "E6");
  assert.ok(fo, "the frame-over gable is recorded for drawing");
  assert.equal(fo!.source, "forced-flush");
});

test("reconcile: span-aware pinning — a gable far wider than the stub at its position floats instead of consuming it (E8)", () => {
  // The Woodinville E8: a 20-ft garage gable pinned by position alone onto
  // the 8-ft entry stub and deleted its gutter. Now it floats (nothing
  // tented) and the budget check reports the deficit honestly.
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: invertedClasses(), // E9 (10ft porch front) arrives eave
    perFace: {
      ...PER_FACE,
      north: face(
        "north",
        "FRONT/NORTH ELEVATION",
        [{ kind: "garage", span_ft: 20, position_frac: 0.5 }],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E9"), "eave", "the stub keeps its gutter");
  assert.ok(
    r.notes.some((n) => n.includes("left unplaced")),
    "the floating gable is noted",
  );
  assert.ok(
    r.notes.some(
      (n) =>
        n.includes("north") &&
        n.includes("0 gable wall(s)/frame-over(s) placed"),
    ),
    "budget deficit surfaced honestly",
  );
});

test("reconcile: span-aware pinning — a same-side wall matching the span takes the gable instead of the stub", () => {
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    // E11 (15ft front-left) arrives eave; the 16ft gable at u=0.42 pins the
    // 10ft porch stub by position but E11's length matches the span.
    classes: invertedClasses(),
    perFace: {
      ...PER_FACE,
      north: face(
        "north",
        "FRONT/NORTH ELEVATION",
        [{ kind: "garage", span_ft: 16, position_frac: 0.42 }],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E11"), "rake", "the span-matched wall takes the gable");
  assert.equal(cls.get("E9"), "eave", "the stub keeps its gutter");
  assert.ok(r.notes.some((n) => n.includes("placed there instead")));
});

test("reconcile: a MAIN gable on decorative beams whose wall matches the span IS the gable end — gutter comes off, loudly", () => {
  // The Woodinville garage front: kind 'main', supported_on 'beam' (trellis
  // beams drawn under a real gable end) — the old gate shipped it to
  // droppedProjections (kind main synthesizes $0) and left 20 LF of phantom
  // gutter across the gable. Deterministic gate: main/garage kind + beam +
  // base-line wall ≈ span (0.7–1.6×).
  const edges = outlineEdges(OUTLINE);
  const classes: EdgeClass[] = edges.map((e) => ({
    id: e.id,
    edge_class: "eave",
    tier: null,
    feature: null,
    evidence: [],
  }));
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      north: face(
        "north",
        "FRONT/NORTH ELEVATION",
        [
          {
            kind: "main",
            span_ft: 15, // == E11's 15ft — the wall IS the gable end
            position_frac: 0.15,
            supported_on: "beam",
          },
        ],
        { continuous_eave: false },
      ),
      south: face("south", "REAR/SOUTH ELEVATION", []),
      east: face("east", "LEFT/EAST ELEVATION", []),
      west: face("west", "RIGHT/WEST ELEVATION", []),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E11"), "rake", "the beam-read gable end is placed");
  assert.equal(r.promoted, 1);
  assert.equal(r.droppedProjections.length, 0, "not routed off-outline");
  assert.ok(
    r.notes.some((n) => n.includes("decorative beams/trellis")),
    "the LF removal is loud",
  );
});

test("reconcile: a beam-supported GARAGE gable the roof schedule NAMES still projects beyond the wall (dropped, wall priced)", () => {
  const edges = outlineEdges(OUTLINE);
  const classes: EdgeClass[] = edges.map((e) => ({
    id: e.id,
    edge_class: "eave",
    tier: null,
    feature: null,
    evidence: [],
  }));
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      north: face(
        "north",
        "FRONT/NORTH ELEVATION",
        [
          {
            kind: "garage",
            span_ft: 15, // fits the wall — the schedule name is what routes it
            position_frac: 0.15,
            supported_on: "beam",
          },
        ],
        { continuous_eave: false },
      ),
      south: face("south", "REAR/SOUTH ELEVATION", []),
      east: face("east", "LEFT/EAST ELEVATION", []),
      west: face("west", "RIGHT/WEST ELEVATION", []),
    },
    ptPerFt: PT_PER_FT,
    roofMasses: [{ label: "GARAGE", areaFt2: 874 }],
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E11"), "eave", "wall keeps its gutter");
  assert.equal(r.droppedProjections.length, 1);
  assert.equal(r.droppedProjections[0].kind, "garage");
  const fo = r.frameOverEnds.find((f) => f.edgeId === "E11");
  assert.ok(fo && fo.source === "beam", "projecting gable recorded for drawing");
});

test("reconcile: a beam-supported main gable whose wall does NOT match the span stays a dropped projection (wall priced)", () => {
  const edges = outlineEdges(OUTLINE);
  const classes: EdgeClass[] = edges.map((e) => ({
    id: e.id,
    edge_class: "eave",
    tier: null,
    feature: null,
    evidence: [],
  }));
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      north: face(
        "north",
        "FRONT/NORTH ELEVATION",
        // 8ft span on the 15ft E11 — wall/span 1.875× is outside 0.7–1.6×.
        [{ kind: "main", span_ft: 8, position_frac: 0.15, supported_on: "beam" }],
        { continuous_eave: false },
      ),
      south: face("south", "REAR/SOUTH ELEVATION", []),
      east: face("east", "LEFT/EAST ELEVATION", []),
      west: face("west", "RIGHT/WEST ELEVATION", []),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E11"), "eave", "no rake without the wall≈span gate");
  assert.equal(r.droppedProjections.length, 1, "kept as a dropped projection");
});

test("reconcile: budget dedupe — one gable can't tent both the bump-out AND the wall behind it (E16 phantom)", () => {
  // The Woodinville rear: the face's single patio gable owned the patio stub
  // (E3, correct) but ALSO confirmed a rake on the parent rear wall behind
  // it. The parent wall keeps its gutter; the gable is placed on the stub.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E1" || c.id === "E3" ? { ...c, edge_class: "rake" as const } : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      ...PER_FACE,
      south: face(
        "south",
        "REAR/SOUTH ELEVATION",
        // Position reads on the parent wall (u 0.42) but the span window
        // covers the protruding patio stub (u 0.1–0.3) that is already rake.
        [{ kind: "patio", span_ft: 18, position_frac: 0.42 }],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E1"), "eave", "parent wall gets its gutter back");
  assert.equal(cls.get("E3"), "rake", "the stub keeps the gable end");
  assert.ok(
    r.notes.some((n) => n.includes("E1") && n.includes("can't tent two walls")),
    "the dedupe explains itself",
  );
  assert.ok(
    !r.notes.some((n) => n.includes("south elevation shows")),
    "no phantom budget deficit — the one gable is placed on the stub",
  );
});

test("reconcile: budget dedupe does NOT fire when the face shows two gables (each owns its wall)", () => {
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E1" || c.id === "E3" ? { ...c, edge_class: "rake" as const } : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      ...PER_FACE,
      south: face(
        "south",
        "REAR/SOUTH ELEVATION",
        [
          { kind: "patio", span_ft: 8, position_frac: 0.2 },
          { kind: "other", span_ft: 6, position_frac: 0.8 },
        ],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E1"), "rake", "two gables — the parent wall keeps its own");
  assert.equal(cls.get("E3"), "rake");
});

// A wider body with a 20ft front porch stub whose returns are only 5ft deep —
// the roof schedule says the porch roof runs ~9.5ft deep, so ~4.5ft of side
// gutter per return sits beyond the traced outline.
const STUB_OUTLINE = [
  { x: 0, y: 0 },
  { x: 500, y: 0 },
  { x: 500, y: 200 },
  { x: 350, y: 200 },
  { x: 350, y: 250 },
  { x: 150, y: 250 },
  { x: 150, y: 200 },
  { x: 0, y: 200 },
];

test("reconcile: a porch gable on a SHALLOW stub emits a shortfall drop (schedule deeper than the traced returns)", () => {
  const edges = outlineEdges(STUB_OUTLINE);
  const classes: EdgeClass[] = edges.map((e) => ({
    id: e.id,
    edge_class: "eave",
    tier: null,
    feature: null,
    evidence: [],
  }));
  const r = reconcileEdgeClasses({
    outline: STUB_OUTLINE,
    edges,
    classes,
    perFace: {
      north: face(
        "north",
        "FRONT/NORTH ELEVATION",
        [{ kind: "porch", span_ft: 20, position_frac: 0.5, supported_on: "posts" }],
        { continuous_eave: false },
      ),
      south: face("south", "REAR/SOUTH ELEVATION", []),
      east: face("east", "LEFT/EAST ELEVATION", []),
      west: face("west", "RIGHT/WEST ELEVATION", []),
    },
    ptPerFt: PT_PER_FT,
    roofMasses: [{ label: "PORCH ROOF", areaFt2: 189 }],
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E5"), "rake", "the stub gable still promotes");
  assert.equal(r.droppedProjections.length, 1, "shortfall drop emitted");
  const d = r.droppedProjections[0];
  assert.equal(d.kind, "porch");
  assert.equal(d.spanFt, 20);
  assert.equal(d.stubReturnFt, 5, "traced return depth recorded — synthesis adds ONLY the difference");
  assert.equal(d.form, "gable");
});

test("reconcile: NO shortfall drop when the traced returns already cover the schedule depth", () => {
  // Same stub but with 9ft returns — 189sf ÷ 20ft ≈ 9.5ft deep, difference
  // under 3ft is not material.
  const deep = STUB_OUTLINE.map((p) => (p.y === 250 ? { ...p, y: 290 } : p));
  const edges = outlineEdges(deep);
  const classes: EdgeClass[] = edges.map((e) => ({
    id: e.id,
    edge_class: "eave",
    tier: null,
    feature: null,
    evidence: [],
  }));
  const r = reconcileEdgeClasses({
    outline: deep,
    edges,
    classes,
    perFace: {
      north: face(
        "north",
        "FRONT/NORTH ELEVATION",
        [{ kind: "porch", span_ft: 20, position_frac: 0.5, supported_on: "posts" }],
        { continuous_eave: false },
      ),
      south: face("south", "REAR/SOUTH ELEVATION", []),
      east: face("east", "LEFT/EAST ELEVATION", []),
      west: face("west", "RIGHT/WEST ELEVATION", []),
    },
    ptPerFt: PT_PER_FT,
    roofMasses: [{ label: "PORCH ROOF", areaFt2: 189 }],
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E5"), "rake");
  assert.equal(r.droppedProjections.length, 0, "no drop — nothing material missing");
});

test("reconcile: a label-kept rake with gables on the face is noted AND excluded from the placed count", () => {
  // The silent-keep masking: a printed GABLE END TRUSS label kept E7 rake and
  // counted it 'placed' while the face's second gable floated — the budget
  // check reported no deficit. Now both surface.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E7"
      ? { ...c, edge_class: "rake" as const, evidence: ["gable_end_truss_label"] }
      : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      ...PER_FACE,
      north: face("north", "FRONT/NORTH ELEVATION", [
        { kind: "entry", span_ft: 10, position_frac: 0.5, supported_on: "posts" },
        // A second flush gable that never pins to a wall.
        { kind: "main", span_ft: 12, position_frac: null },
      ]),
      south: face("south", "REAR/SOUTH ELEVATION", []),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E7"), "rake", "the printed label still wins");
  assert.ok(
    r.notes.some(
      (n) => n.includes("E7") && n.includes("no elevation gable maps to this wall"),
    ),
    "the label keep is no longer silent",
  );
  assert.ok(
    r.notes.some(
      (n) =>
        n.includes("north") &&
        n.includes("only 1 gable wall(s)/frame-over(s) placed"),
    ),
    "honest budget accounting — the label keep doesn't count as placed",
  );
});

// ————————————————————————————————————————————————————————————————————————
// Verification-wave regressions: the adversarial panel demonstrated each of
// these as a real LF mutation on the first cut of the span-pin / dedupe /
// beam gates. Pin the protective behavior.
// ————————————————————————————————————————————————————————————————————————

test("reconcile: a floated span-gate stub that arrived RAKE stays RAKE (step-2 demote can't re-class it)", () => {
  // 10ft porch stub E9 arrives rake; the face's gable reads 16ft (an honest
  // overhang span, >1.5× the stub), dead-center on the stub; the face
  // sloppily reads continuous_eave. No same-side wall matches 16ft within
  // ±25% near it. The gable floats — and the stub must keep its own reading:
  // flipping it to eave bills gutter across a real gable end.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E9" ? { ...c, edge_class: "rake" as const } : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      ...PER_FACE,
      north: face(
        "north",
        "FRONT/NORTH ELEVATION",
        [{ kind: "entry", span_ft: 16, position_frac: 0.5 }],
        { continuous_eave: true },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E9"), "rake", "the bump-out keeps its own reading");
  assert.ok(
    !r.notes.some((n) => n.includes("E9 rake→EAVE")),
    "no step-2 demote on the protected stub",
  );
});

test("reconcile: budget dedupe never fires when the gable span matches the parent wall (perfect fit wins)", () => {
  // E1 (28ft rear wall) arrives rake with a matching 28ft gable read pinned
  // to it; the 8ft patio stub E3 is also rake on the same side. The first
  // cut attributed the 28ft gable to the 8ft stub and priced 28 LF of
  // gutter across a true gable end.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E1" || c.id === "E3" ? { ...c, edge_class: "rake" as const } : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      ...PER_FACE,
      south: face(
        "south",
        "REAR/SOUTH ELEVATION",
        [{ kind: "main", span_ft: 28, position_frac: 0.6 }],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E1"), "rake", "the span-matched parent wall IS the gable end");
  assert.ok(
    !r.notes.some((n) => n.includes("can't tent two walls")),
    "dedupe stays quiet on a perfect-fit parent",
  );
});

test("reconcile: budget dedupe never preempts the overframe gate (span wider than the parent wall)", () => {
  // A 39ft gable pinned to the 28ft rear wall E1 with the rake patio stub E3
  // on the face: the overframe doctrine parks E1 UNPRICED for review — the
  // dedupe must not convert it into a billed eave.
  const edges = outlineEdges(OUTLINE);
  const classes = invertedClasses().map((c) =>
    c.id === "E1" || c.id === "E3" ? { ...c, edge_class: "rake" as const } : c,
  );
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      ...PER_FACE,
      south: face(
        "south",
        "REAR/SOUTH ELEVATION",
        [{ kind: "main", span_ft: 39, position_frac: 0.6 }],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E1"), "unknown", "overframe parks the wall UNPRICED");
  assert.ok(
    r.notes.some((n) => n.includes("E1") && n.includes("overframe")),
    "the overframe gate speaks, not the dedupe",
  );
});

test("reconcile: the beam gate never strips a wall for a kind-'other' gable (the prompt's mandated unlabelled kind)", () => {
  // An unlabelled projecting porch reads kind 'other' on posts with a
  // projection cue — the first cut promoted the base wall to rake (−LF) and
  // cascaded. It must route to droppedProjections; the wall keeps gutter.
  const edges = outlineEdges(OUTLINE);
  const classes: EdgeClass[] = edges.map((e) => ({
    id: e.id,
    edge_class: "eave",
    tier: null,
    feature: null,
    evidence: [],
  }));
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      north: face(
        "north",
        "FRONT/NORTH ELEVATION",
        [
          {
            kind: "other",
            span_ft: 15, // == E11 — inside the 0.7–1.6× wall≈span window
            position_frac: 0.15,
            supported_on: "posts",
            shows_projection_cue: true,
          },
        ],
        { continuous_eave: false },
      ),
      south: face("south", "REAR/SOUTH ELEVATION", []),
      east: face("east", "LEFT/EAST ELEVATION", []),
      west: face("west", "RIGHT/WEST ELEVATION", []),
    },
    ptPerFt: PT_PER_FT,
    roofMasses: [{ label: "PORCH ROOF", areaFt2: 180 }],
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E11"), "eave", "wall keeps its gutter");
  assert.equal(r.droppedProjections.length, 1, "projection recorded for the LF synthesis");
});

test("reconcile: a MAIN gable on beams with a projection cue is NOT the trellis case — wall keeps its gutter", () => {
  const edges = outlineEdges(OUTLINE);
  const classes: EdgeClass[] = edges.map((e) => ({
    id: e.id,
    edge_class: "eave",
    tier: null,
    feature: null,
    evidence: [],
  }));
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      north: face(
        "north",
        "FRONT/NORTH ELEVATION",
        [
          {
            kind: "main",
            span_ft: 15,
            position_frac: 0.15,
            supported_on: "beam",
            eave_condition_guess: "projecting",
          },
        ],
        { continuous_eave: false },
      ),
      south: face("south", "REAR/SOUTH ELEVATION", []),
      east: face("east", "LEFT/EAST ELEVATION", []),
      west: face("west", "RIGHT/WEST ELEVATION", []),
    },
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E11"), "eave", "projection evidence beats the trellis promotion");
  assert.equal(r.droppedProjections.length, 1);
});

// ————————————————————————————————————————————————————————————————————————
// Field-conflict RESOLUTION LADDER (Woodinville E3/E9: ~106 LF of side wall
// parked UNPRICED because the old fieldEave check acted on nothing) + the
// front-gabled entry-stub enforcement (E6 priced eave + D.S. while its side
// returns were raked — inverted). Money paths: every rung pinned, plus the
// adversarial variants that must NOT fire.
// ————————————————————————————————————————————————————————————————————————

/** All-eave ring with ONE conflict-parked wall (label vs truss field). */
const conflictClasses = (id: string): EdgeClass[] =>
  outlineEdges(OUTLINE).map((e) => ({
    id: e.id,
    edge_class: e.id === id ? "unknown" : "eave",
    tier: null,
    feature: null,
    evidence:
      e.id === id ? ["gable_end_truss_label", "truss_field_conflict"] : [],
  }));

const quietFaces = {
  north: face("north", "FRONT/NORTH ELEVATION", []),
  south: face("south", "REAR/SOUTH ELEVATION", []),
  east: face("east", "LEFT/EAST ELEVATION", []),
};

test("ladder (a): a conflict gable ABOVE the eave line (eave_passes_in_front) prices the wall FULL and draws the gable above it", () => {
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: conflictClasses("E6"),
    perFace: {
      ...quietFaces,
      west: face(
        "west",
        "RIGHT/WEST ELEVATION",
        [
          {
            kind: "main",
            span_ft: 19,
            position_frac: 0.5,
            set_back_ft: 0,
            eave_passes_in_front: true,
          },
        ],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E6"]),
  });
  const e6 = r.classes.find((c) => c.id === "E6")!;
  assert.equal(e6.edge_class, "eave", "gutter priced");
  assert.equal(e6.partial_gables, undefined, "FULL wall — no carve");
  assert.ok((e6.evidence ?? []).includes("field_conflict_frame_over"));
  assert.ok(
    r.classes.every((c) => c.edge_class !== "unknown"),
    "no unknowns shipped",
  );
  const fo = r.frameOverEnds.find((f) => f.edgeId === "E6");
  assert.ok(fo, "the gable is recorded for drawing");
  assert.equal(fo!.source, "truss-conflict");
  assert.equal(fo!.spanFt, 19);
  assert.ok(
    r.notes.some(
      (n) => n.includes("E6 unknown→EAVE") && n.includes("gutter priced full"),
    ),
    "the resolution is loud",
  );
  // End-to-end money: the wall prices its full 20 ft.
  const t = buildEdgeTakeoff({
    outline: OUTLINE,
    edges,
    classes: r.classes,
    ptPerFt: PT_PER_FT,
  });
  const e6run = t.gutter_runs.find((x) => x.id === "edge-E6");
  assert.ok(e6run && Math.abs(e6run.length_ft - 20) < 0.1, "20 LF priced on E6");
  // Plan test 9: a ladder-resolved gable counts as placed — no false alarm.
  assert.ok(
    !r.notes.some((n) => n.includes("review gable placement")),
    "no placement warning on a resolved side",
  );
});

test("ladder (a): a pinned conflict gable on a CONTINUOUS-eave face prices the wall full (continuous evidence, not eave_passes)", () => {
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: conflictClasses("E6"),
    perFace: {
      ...quietFaces,
      // continuous_eave defaults TRUE in the factory; the gable is pinned
      // (set_back 0) and clearly narrower than the wall — (a) still outranks
      // (b): the face's one gutter line runs full width by definition.
      west: face("west", "RIGHT/WEST ELEVATION", [
        { kind: "main", span_ft: 12, position_frac: 0.5, set_back_ft: 0 },
      ]),
    },
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E6"]),
  });
  const e6 = r.classes.find((c) => c.id === "E6")!;
  assert.equal(e6.edge_class, "eave");
  assert.equal(e6.partial_gables, undefined, "no carve on a continuous face");
  const fo = r.frameOverEnds.find((f) => f.edgeId === "E6");
  assert.ok(fo && fo.source === "truss-conflict");
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("gutter priced full")),
  );
  assert.ok(
    !r.notes.some((n) => n.includes("stays under review")),
    "the old park note is gone",
  );
});

// 54-ft-front rectangle for the split rungs (10 pt/ft).
const RECT54 = [
  { x: 0, y: 0 },
  { x: 540, y: 0 },
  { x: 540, y: 300 },
  { x: 0, y: 300 },
];
// E1 back 54ft · E2 right 30ft · E3 front 54ft · E4 left 30ft

const rect54Conflict = (): EdgeClass[] =>
  outlineEdges(RECT54).map((e) => ({
    id: e.id,
    edge_class: e.id === "E3" ? "unknown" : "eave",
    tier: null,
    feature: null,
    evidence:
      e.id === "E3" ? ["gable_end_truss_label", "truss_field_conflict"] : [],
  }));

const rect54Faces = (gable: Partial<FaceReadingRaw["gables"][number]>) => ({
  north: face("north", "FRONT/NORTH ELEVATION", [gable], {
    continuous_eave: false,
  }),
  south: face("south", "REAR/SOUTH ELEVATION", []),
  east: face("east", "LEFT/EAST ELEVATION", []),
  west: face("west", "RIGHT/WEST ELEVATION", []),
});

test("ladder (b): a 28-ft conflict gable on a 54-ft wall splits — rake over the span, ≈26 LF priced on the remainder (end-to-end)", () => {
  const edges = outlineEdges(RECT54);
  const r = reconcileEdgeClasses({
    outline: RECT54,
    edges,
    classes: rect54Conflict(),
    perFace: rect54Faces({
      kind: "main",
      span_ft: 28,
      position_frac: 0.5,
      set_back_ft: 0,
      eave_passes_in_front: false,
    }),
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E3"]),
  });
  const e3 = r.classes.find((c) => c.id === "E3")!;
  assert.equal(e3.edge_class, "eave", "remainder priced");
  assert.equal(e3.partial_gables?.length, 1, "one gable interval carved");
  const iv = e3.partial_gables![0];
  assert.ok(
    Math.abs(iv.u0 - 0.241) < 0.02 && Math.abs(iv.u1 - 0.759) < 0.02,
    `interval ≈[0.24,0.76], got [${iv.u0.toFixed(3)},${iv.u1.toFixed(3)}]`,
  );
  assert.ok((e3.evidence ?? []).includes("field_conflict_split"));
  assert.ok(
    r.notes.some(
      (n) =>
        n.includes("E3") && n.includes("gutter kept on the remaining ~26ft"),
    ),
    "the split says both sides of the money",
  );
  // Plan test 9: the split counts as placed.
  assert.ok(!r.notes.some((n) => n.includes("review gable placement")));
  // END-TO-END MONEY: ≈26 LF priced on E3, the 28-ft interval excluded.
  const t = buildEdgeTakeoff({
    outline: RECT54,
    edges,
    classes: r.classes,
    ptPerFt: PT_PER_FT,
  });
  const e3lf = t.gutter_runs
    .filter((x) => x.id.startsWith("edge-E3"))
    .reduce((s, x) => s + x.length_ft, 0);
  assert.ok(Math.abs(e3lf - 26) < 0.3, `≈26 LF on E3, got ${e3lf}`);
  assert.ok(Math.abs(t.totals.eave_lf - 140) < 0.3, "54+30+30+26 priced");
  assert.equal(
    t.excluded_edges.filter((x) => x.kind === "rake").length,
    1,
    "the gable interval is excluded as rake",
  );
});

test("ladder (b) adversarial: the split NEVER double-prices — priced + excluded LF == wall length ±0.2 (off-center gable)", () => {
  const edges = outlineEdges(RECT54);
  const r = reconcileEdgeClasses({
    outline: RECT54,
    edges,
    classes: rect54Conflict(),
    perFace: rect54Faces({
      kind: "main",
      span_ft: 28,
      position_frac: 0.35,
      set_back_ft: 0,
      eave_passes_in_front: false,
    }),
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E3"]),
  });
  const t = buildEdgeTakeoff({
    outline: RECT54,
    edges,
    classes: r.classes,
    ptPerFt: PT_PER_FT,
  });
  const priced = t.gutter_runs
    .filter((x) => x.id.startsWith("edge-E3"))
    .reduce((s, x) => s + x.length_ft, 0);
  const excluded = t.excluded_edges
    .filter((x) => x.kind === "rake")
    .reduce(
      (s, x) =>
        s + Math.hypot(x.end.x - x.start.x, x.end.y - x.start.y) / PT_PER_FT,
      0,
    );
  assert.ok(
    Math.abs(priced + excluded - 54) <= 0.2,
    `priced ${priced} + excluded ${excluded} must equal the 54-ft wall`,
  );
});

test("ladder (c): a 0.95×-wall conflict gable at the eave line tents the wall — rake, 0 LF", () => {
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: conflictClasses("E6"),
    perFace: {
      ...quietFaces,
      west: face(
        "west",
        "RIGHT/WEST ELEVATION",
        [
          {
            kind: "main",
            span_ft: 19,
            position_frac: 0.5,
            set_back_ft: 0,
            eave_passes_in_front: false,
          },
        ],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E6"]),
  });
  const e6 = r.classes.find((c) => c.id === "E6")!;
  assert.equal(e6.edge_class, "rake", "label + full-wall gable outvote the truss read");
  assert.ok((e6.evidence ?? []).includes("elevation_gable_mapped"));
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("outvote the truss read")),
  );
  const t = buildEdgeTakeoff({
    outline: OUTLINE,
    edges,
    classes: r.classes,
    ptPerFt: PT_PER_FT,
  });
  assert.ok(
    !t.gutter_runs.some((x) => x.id.startsWith("edge-E6")),
    "0 LF on the tented wall",
  );
});

test("ladder (c) adversarial: a TRUE full-wall gable (span == wall, eave_passes false, continuous false) lands rake — NO eave, NO frameOverEnds", () => {
  const edges = outlineEdges(OUTLINE);
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes: conflictClasses("E6"),
    perFace: {
      ...quietFaces,
      west: face(
        "west",
        "RIGHT/WEST ELEVATION",
        [
          {
            kind: "main",
            span_ft: 20, // == the whole 20-ft wall
            position_frac: 0.5,
            set_back_ft: 0,
            eave_passes_in_front: false,
          },
        ],
        { continuous_eave: false },
      ),
    },
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E6"]),
  });
  const e6 = r.classes.find((c) => c.id === "E6")!;
  assert.equal(e6.edge_class, "rake", "a real gable end is never billed");
  assert.equal(e6.partial_gables, undefined, "no split invented");
  assert.equal(r.frameOverEnds.length, 0, "nothing drawn above a wall-plane gable");
});

test("ladder (hip-first) adversarial: a hip read + truss bearing keeps the eave and draws NOTHING above it", () => {
  const edges = outlineEdges(OUTLINE);
  // Production-normal arrival: the field already returned the wall to eave.
  const classes: EdgeClass[] = outlineEdges(OUTLINE).map((e) => ({
    id: e.id,
    edge_class: "eave",
    tier: null,
    feature: null,
    evidence: e.id === "E6" ? ["truss_field_perpendicular"] : [],
  }));
  const r = reconcileEdgeClasses({
    outline: OUTLINE,
    edges,
    classes,
    perFace: {
      ...quietFaces,
      west: face(
        "west",
        "RIGHT/WEST ELEVATION",
        [
          {
            kind: "main",
            span_ft: 19,
            position_frac: 0.5,
            set_back_ft: 0,
            is_hip_end: true,
          },
        ],
        { roof_form: "hipped" },
      ),
    },
    ptPerFt: PT_PER_FT,
    fieldEave: new Set(["E6"]),
  });
  const e6 = r.classes.find((c) => c.id === "E6")!;
  assert.equal(e6.edge_class, "eave", "eave kept per framing");
  assert.equal(r.frameOverEnds.length, 0, "no phantom gable drawn on a hip");
  assert.ok(
    !(e6.evidence ?? []).includes("field_conflict_frame_over"),
    "the (a) rung never fired",
  );
  assert.ok(
    r.notes.some((n) => n.includes("E6") && n.includes("hip end")),
    "the hip call is noted",
  );
});

// ————————————————————————————————————————————————————————————————————————
// Pass 4b — front-gabled entry/porch stub enforcement.
// A 50-ft body with a front entry stub: outer 10.3 ft, returns 9.1 / 6.9 ft
// (UNEQUAL returns off front walls at different depths — the production
// Woodinville shape isProtrusion fails on; the depth test must carry it).
// E1 back · E2 right · E3 front-right 19.5ft · E4 stub right return 9.1ft ·
// E5 stub outer 10.3ft · E6 stub left return 6.9ft · E7 front-left 20.2ft ·
// E8 left 22.2ft
// ————————————————————————————————————————————————————————————————————————
const ENTRY_OUTLINE = [
  { x: 0, y: 0 },
  { x: 500, y: 0 },
  { x: 500, y: 200 },
  { x: 305, y: 200 },
  { x: 305, y: 291 },
  { x: 202, y: 291 },
  { x: 202, y: 222 },
  { x: 0, y: 222 },
];

/** The production inversion: outer stub edge priced EAVE, returns raked. */
const entryClasses = (over?: (c: EdgeClass) => EdgeClass): EdgeClass[] =>
  outlineEdges(ENTRY_OUTLINE).map((e) => {
    const base: EdgeClass = {
      id: e.id,
      edge_class: e.id === "E4" || e.id === "E6" ? "rake" : "eave",
      tier: null,
      feature: null,
      evidence:
        e.id === "E4" || e.id === "E6"
          ? ["truss_direction"]
          : e.id === "E5"
            ? ["gutter_callout"]
            : [],
    };
    return over ? over(base) : base;
  });

const entryFaces = (
  gable: Partial<FaceReadingRaw["gables"][number]> | null,
) => ({
  north: face("north", "FRONT/NORTH ELEVATION", gable ? [gable] : [], {
    continuous_eave: false,
  }),
  south: face("south", "REAR/SOUTH ELEVATION", []),
  // Side elevations unreadable so the returns arrive at pass 4b untouched.
  east: face("east", "LEFT/EAST ELEVATION", [], { readable: false }),
  west: face("west", "RIGHT/WEST ELEVATION", [], { readable: false }),
});

const ENTRY_GABLE = {
  kind: "entry",
  span_ft: 10,
  position_frac: 0.5,
  supported_on: "posts",
  shows_projection_cue: true,
  set_back_ft: 0,
  cover_form: "front_gabled",
} as const;

test("entry stub: a front-gabled entry cover flips the production inversion — outer RAKE, side returns EAVE, net LF said out loud", () => {
  const edges = outlineEdges(ENTRY_OUTLINE);
  const r = reconcileEdgeClasses({
    outline: ENTRY_OUTLINE,
    edges,
    classes: entryClasses(),
    perFace: entryFaces(ENTRY_GABLE),
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c]));
  assert.equal(cls.get("E5")!.edge_class, "rake", "the peak faces front — no gutter there");
  assert.ok((cls.get("E5")!.evidence ?? []).includes("front_gabled_cover"));
  assert.equal(cls.get("E4")!.edge_class, "eave", "right return carries the gutter");
  assert.equal(cls.get("E6")!.edge_class, "eave", "left return carries the gutter");
  assert.ok((cls.get("E4")!.evidence ?? []).includes("cover_side_eave"));
  assert.ok((cls.get("E6")!.evidence ?? []).includes("cover_side_eave"));
  const note = r.notes.find((n) => n.includes("front-gabled entry cover"));
  assert.ok(note, "the flip is loud");
  assert.ok(note!.includes("E4+E6"), "side returns named");
  assert.ok(note!.includes("Net +5.7 LF"), `net LF stated, got: ${note}`);
});

test("entry stub: the flip SUPERSEDES the same-face entry droppedProjection (no projection-LF double-count)", () => {
  const edges = outlineEdges(ENTRY_OUTLINE);
  const r = reconcileEdgeClasses({
    outline: ENTRY_OUTLINE,
    edges,
    classes: entryClasses(),
    perFace: entryFaces(ENTRY_GABLE),
    ptPerFt: PT_PER_FT,
  });
  // The posts gate routed the entry gable to droppedProjections first;
  // pass 4b priced the stub's own returns, so the drop must be gone.
  assert.equal(r.droppedProjections.length, 0, "superseded — never double-counted");
});

test("entry stub adversarial: a garage stub is untouched", () => {
  const edges = outlineEdges(ENTRY_OUTLINE);
  const r = reconcileEdgeClasses({
    outline: ENTRY_OUTLINE,
    edges,
    classes: entryClasses((c) =>
      c.id === "E4" ? { ...c, feature: "garage" } : c,
    ),
    perFace: entryFaces(ENTRY_GABLE),
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E5"), "eave", "garage front keeps its reading");
  assert.equal(cls.get("E4"), "rake");
  assert.equal(cls.get("E6"), "rake");
  assert.ok(!r.notes.some((n) => n.includes("front-gabled entry cover")));
});

test("entry stub adversarial: a HIPPED porch cover keeps its front gutter (note-only veto)", () => {
  const edges = outlineEdges(ENTRY_OUTLINE);
  const r = reconcileEdgeClasses({
    outline: ENTRY_OUTLINE,
    edges,
    classes: entryClasses((c) =>
      c.id === "E5" ? { ...c, feature: "porch" } : c,
    ),
    perFace: entryFaces({
      ...ENTRY_GABLE,
      kind: "porch",
      cover_form: "hipped",
    }),
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E5"), "eave", "a hipped cover's front edge IS guttered");
  assert.equal(cls.get("E4"), "rake", "returns untouched");
  assert.equal(cls.get("E6"), "rake");
  assert.ok(
    r.notes.some((n) => n.includes("E5") && n.includes("as hipped")),
    "the veto explains itself",
  );
});

test("entry stub: a classifier 'entry' feature tag alone (no elevation read) still flips the stub", () => {
  const edges = outlineEdges(ENTRY_OUTLINE);
  const r = reconcileEdgeClasses({
    outline: ENTRY_OUTLINE,
    edges,
    classes: entryClasses((c) =>
      c.id === "E5" ? { ...c, feature: "entry" } : c,
    ),
    perFace: entryFaces(null),
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E5"), "rake");
  assert.equal(cls.get("E4"), "eave");
  assert.equal(cls.get("E6"), "eave");
});

test("entry stub: a side return with a printed gable label keeps its RAKE (noted) while the rest of the flip proceeds", () => {
  const edges = outlineEdges(ENTRY_OUTLINE);
  const r = reconcileEdgeClasses({
    outline: ENTRY_OUTLINE,
    edges,
    classes: entryClasses((c) =>
      c.id === "E4"
        ? { ...c, evidence: ["gable_end_truss_label"] }
        : c.id === "E5"
          ? { ...c, feature: "entry" }
          : c,
    ),
    perFace: entryFaces(null),
    ptPerFt: PT_PER_FT,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E5"), "rake", "outer still flips");
  assert.equal(cls.get("E4"), "rake", "the printed label outranks the pattern");
  assert.equal(cls.get("E6"), "eave", "the clean return still prices");
  assert.ok(
    r.notes.some((n) => n.includes("E4") && n.includes("keeps its RAKE")),
  );
});

test("entry stub adversarial: sheet evidence respected — fieldEave outer never flips; a >16-ft outer is silent", () => {
  // (i) The framing bears INTO the outer edge — the rule stands down.
  {
    const edges = outlineEdges(ENTRY_OUTLINE);
    const r = reconcileEdgeClasses({
      outline: ENTRY_OUTLINE,
      edges,
      classes: entryClasses((c) =>
        c.id === "E5" ? { ...c, feature: "entry" } : c,
      ),
      perFace: entryFaces(null),
      ptPerFt: PT_PER_FT,
      fieldEave: new Set(["E5"]),
    });
    const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
    assert.equal(cls.get("E5"), "eave", "framing wins — no flip");
    assert.equal(cls.get("E4"), "rake");
    assert.equal(cls.get("E6"), "rake");
    assert.ok(!r.notes.some((n) => n.includes("front-gabled entry cover")));
  }
  // (ii) A 17-ft outer is not an entry cover — the rule is silent.
  {
    const WIDE = ENTRY_OUTLINE.map((p) =>
      p.x === 202 ? { ...p, x: 135 } : p,
    );
    const edges = outlineEdges(WIDE);
    const classes: EdgeClass[] = edges.map((e) => ({
      id: e.id,
      edge_class: e.id === "E4" || e.id === "E6" ? "rake" : "eave",
      tier: null,
      feature: e.id === "E5" ? "entry" : null,
      evidence: [],
    }));
    const r = reconcileEdgeClasses({
      outline: WIDE,
      edges,
      classes,
      perFace: entryFaces(null),
      ptPerFt: PT_PER_FT,
    });
    const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
    assert.equal(cls.get("E5"), "eave", "17-ft outer: rule silent");
    assert.equal(cls.get("E4"), "rake");
    assert.equal(cls.get("E6"), "rake");
    assert.ok(!r.notes.some((n) => n.includes("front-gabled entry cover")));
  }
});
