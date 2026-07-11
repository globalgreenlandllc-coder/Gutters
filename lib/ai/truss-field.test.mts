import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineEdges } from "./plan-overlay.ts";
import { applyTrussFieldDemotions, deriveTrussField } from "./truss-field.ts";
import type { EdgeClass } from "./edge-takeoff.ts";

// 40ft x 20ft rectangle at 10 pt/ft. Ring: E1 top (back), E2 right, E3
// bottom (front), E4 left.
const OUTLINE = [
  { x: 0, y: 0 },
  { x: 400, y: 0 },
  { x: 400, y: 200 },
  { x: 0, y: 200 },
];
const PT_PER_FT = 10;
const edges = () => outlineEdges(OUTLINE);

/** Vertical truss array: x 40..360 step 20 (24" o.c.), spanning the mass. */
const verticalTrusses = (): number[][] => {
  const out: number[][] = [];
  for (let x = 40; x <= 360; x += 20) out.push([x, 10, x, 190]);
  return out;
};
/** Horizontal truss array: y 20..180 step 20, spanning the mass. */
const horizontalTrusses = (): number[][] => {
  const out: number[][] = [];
  for (let y = 20; y <= 180; y += 20) out.push([20, y, 380, y]);
  return out;
};

const classesOf = (
  spec: Partial<Record<string, EdgeClass["edge_class"]>>,
  evidence: Partial<Record<string, string[]>> = {},
): EdgeClass[] =>
  edges().map((e) => ({
    id: e.id,
    edge_class: spec[e.id] ?? "eave",
    tier: null,
    feature: null,
    evidence: evidence[e.id] ?? ["truss_direction"],
  }));

test("truss-field: an array drawn INTO a wall reads perpendicular (bearing eave)", () => {
  const field = deriveTrussField({
    outline: OUTLINE,
    edges: edges(),
    segments: verticalTrusses(),
    ptPerFt: PT_PER_FT,
  });
  assert.equal(field.get("E1")?.verdict, "perpendicular", "top wall bears");
  assert.equal(field.get("E3")?.verdict, "perpendicular", "bottom wall bears");
  // The same members run parallel to the side walls but never 3+ deep in the
  // side strips — no verdict there.
  assert.equal(field.get("E2"), undefined);
  assert.equal(field.get("E4"), undefined);
});

test("truss-field: an array ALONG a wall reads parallel (gable end)", () => {
  const field = deriveTrussField({
    outline: OUTLINE,
    edges: edges(),
    segments: horizontalTrusses(),
    ptPerFt: PT_PER_FT,
  });
  assert.equal(field.get("E1")?.verdict, "parallel", "gable end at top");
  assert.equal(field.get("E3")?.verdict, "parallel", "gable end at bottom");
  assert.equal(field.get("E2")?.verdict, "perpendicular", "side bears");
  assert.equal(field.get("E4")?.verdict, "perpendicular", "side bears");
});

test("truss-field: a clustered pocket of regular lines is NOT a bearing family (spread gate)", () => {
  // Window jambs: 3 long verticals 1.5ft apart in one pocket of a 40ft wall
  // (the Woodinville E2 false positive).
  const jambs = [
    [100, 10, 100, 190],
    [115, 10, 115, 190],
    [130, 10, 130, 190],
  ];
  const field = deriveTrussField({
    outline: OUTLINE,
    edges: edges(),
    segments: jambs,
    ptPerFt: PT_PER_FT,
  });
  assert.equal(field.get("E1"), undefined, "pocket rejected");
  assert.equal(field.get("E3"), undefined);
});

test("truss-field: short parallel scraps never make a gable (overlap gate)", () => {
  // Wall/plate scraps: 3 short horizontals near the bottom wall.
  const scraps = [
    [20, 185, 120, 185],
    [20, 170, 120, 170],
    [20, 155, 120, 155],
  ];
  const field = deriveTrussField({
    outline: OUTLINE,
    edges: edges(),
    segments: scraps,
    ptPerFt: PT_PER_FT,
  });
  assert.equal(field.get("E3"), undefined);
});

test("truss-field demotions: perpendicular flips a label-less rake, conflicts a printed label to unknown", () => {
  const field = deriveTrussField({
    outline: OUTLINE,
    edges: edges(),
    segments: verticalTrusses(),
    ptPerFt: PT_PER_FT,
  });
  const r = applyTrussFieldDemotions({
    classes: classesOf(
      { E1: "rake", E3: "rake" },
      { E3: ["gable_end_truss_label"] },
    ),
    field,
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E1"), "eave", "label-less rake returned to eave");
  assert.equal(cls.get("E3"), "unknown", "printed label conflict → unpriced");
  assert.equal(r.demoted, 1);
  assert.ok(r.notes.some((n) => n.includes("E1")));
  assert.ok(r.notes.some((n) => n.includes("E3") && n.includes("verify")));
});

test("truss-field demotions: a conflicting label re-attributes to an adjacent parallel gable", () => {
  // The Woodinville patio: its printed GABLE END TRUSS label got attached to
  // the patio SIDES (perpendicular field) while the true gable is the
  // adjacent end wall (parallel field) — the sides keep their gutters.
  const field = new Map([
    ["E1", { verdict: "parallel" as const, par: 5, perp: 0 }],
    ["E2", { verdict: "perpendicular" as const, par: 0, perp: 4 }],
  ]);
  const r = applyTrussFieldDemotions({
    classes: classesOf({ E2: "rake" }, { E2: ["gable_end_truss_label"] }),
    field,
    edges: edges(),
  });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E2"), "eave", "label re-attributed, gutter kept");
  assert.ok(
    r.notes.some((n) => n.includes("E2") && n.includes("belongs to the adjacent gable end E1")),
  );
  // Without a parallel neighbor the conflict still goes unknown.
  const r2 = applyTrussFieldDemotions({
    classes: classesOf({ E2: "rake" }, { E2: ["gable_end_truss_label"] }),
    field: new Map([["E2", { verdict: "perpendicular" as const, par: 0, perp: 4 }]]),
    edges: edges(),
  });
  assert.equal(
    new Map(r2.classes.map((c) => [c.id, c.edge_class])).get("E2"),
    "unknown",
  );
});

test("truss-field demotions: parallel verdicts come back as hints, not applied", () => {
  const field = deriveTrussField({
    outline: OUTLINE,
    edges: edges(),
    segments: horizontalTrusses(),
    ptPerFt: PT_PER_FT,
  });
  const r = applyTrussFieldDemotions({ classes: classesOf({}), field });
  const cls = new Map(r.classes.map((c) => [c.id, c.edge_class]));
  assert.equal(cls.get("E1"), "eave", "parallel not applied directly");
  assert.ok(r.parallelIds.has("E1"));
  assert.ok(r.parallelIds.has("E3"));
});

test("truss-field: no field segments → no verdicts (safe no-op)", () => {
  const field = deriveTrussField({
    outline: OUTLINE,
    edges: edges(),
    segments: [],
    ptPerFt: PT_PER_FT,
  });
  assert.equal(field.size, 0);
});
