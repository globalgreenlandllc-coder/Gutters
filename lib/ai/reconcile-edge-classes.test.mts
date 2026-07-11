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
    north: face("north", "FRONT/NORTH ELEVATION", [
      // 4 ft gable mapped onto the 15 ft front-left wall (E11).
      { kind: "dormer", span_ft: 4, position_frac: 0.15 },
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
