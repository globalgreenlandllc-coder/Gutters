import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineEdges } from "./plan-overlay.ts";
import {
  buildRoofLayout,
  extractPlanDiagonals,
  crossCheckDiagonals,
} from "./roof-layout.ts";
import type { EdgeClass } from "./edge-takeoff.ts";

// 400×200pt rectangle in PDF pt space (y down).
const RECT = [
  { x: 0, y: 0 },
  { x: 400, y: 0 },
  { x: 400, y: 200 },
  { x: 0, y: 200 },
];

const classesFor = (
  outline: { x: number; y: number }[],
  cls: (id: string) => "eave" | "rake" | "unknown",
): EdgeClass[] =>
  outlineEdges(outline).map((e) => ({
    id: e.id,
    edge_class: cls(e.id),
    tier: null,
    feature: null,
    evidence: [],
  }));

const totalLen = (segs: { p1: { x: number; y: number }; p2: { x: number; y: number } }[]) =>
  segs.reduce((s, l) => s + Math.hypot(l.p2.x - l.p1.x, l.p2.y - l.p1.y), 0);

test("roof layout: all-eave rectangle = hip roof (1 ridge, 4 hips)", () => {
  const layout = buildRoofLayout({
    outline: RECT,
    edges: outlineEdges(RECT),
    classes: classesFor(RECT, () => "eave"),
  });
  assert.equal(layout.ok, true);
  assert.equal(layout.valleys.length, 0);
  assert.equal(layout.hips.length, 4);
  assert.equal(layout.gableCount, 0);
  // Ridge along the long axis, midline y=100, from ~(100,100) to ~(300,100).
  const ridgeLen = totalLen(layout.ridges);
  assert.ok(Math.abs(ridgeLen - 200) < 20, `ridge length ${ridgeLen} ≉ 200`);
  for (const r of layout.ridges) {
    assert.ok(Math.abs(r.p1.y - 100) < 2 && Math.abs(r.p2.y - 100) < 2);
  }
  // Hips run corner→ridge at 45°, each ≈ 141.
  for (const h of layout.hips) {
    const len = Math.hypot(h.p2.x - h.p1.x, h.p2.y - h.p1.y);
    assert.ok(Math.abs(len - Math.hypot(100, 100)) < 15, `hip length ${len}`);
  }
});

test("roof layout: rectangle with two rake ends = gable roof, ridge wall-to-wall", () => {
  // E2 (right vertical) and E4 (left vertical) are gable end walls.
  const layout = buildRoofLayout({
    outline: RECT,
    edges: outlineEdges(RECT),
    classes: classesFor(RECT, (id) => (id === "E2" || id === "E4" ? "rake" : "eave")),
  });
  assert.equal(layout.ok, true);
  assert.equal(layout.gableCount, 2);
  assert.deepEqual(layout.rakeEdgeIds.sort(), ["E2", "E4"]);
  // Stationary gable walls: no hips, no valleys, ridge spans the full 400.
  assert.equal(layout.hips.length, 0, `hips: ${JSON.stringify(layout.hips)}`);
  assert.equal(layout.valleys.length, 0);
  const ridgeLen = totalLen(layout.ridges);
  assert.ok(Math.abs(ridgeLen - 400) < 20, `ridge length ${ridgeLen} ≉ 400`);
  const xs = layout.ridges.flatMap((r) => [r.p1.x, r.p2.x]);
  assert.ok(Math.min(...xs) < 10 && Math.max(...xs) > 390, "ridge reaches both gable walls");
});

test("roof layout: L-shape grows a valley at the reflex corner", () => {
  const L = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 180 },
    { x: 160, y: 180 },
    { x: 160, y: 320 },
    { x: 0, y: 320 },
  ];
  const layout = buildRoofLayout({
    outline: L,
    edges: outlineEdges(L),
    classes: classesFor(L, () => "eave"),
  });
  assert.equal(layout.ok, true);
  assert.ok(layout.valleys.length >= 1, "expected a valley");
  const touchesReflex = layout.valleys.some(
    (v) =>
      Math.hypot(v.p1.x - 160, v.p1.y - 180) < 2 ||
      Math.hypot(v.p2.x - 160, v.p2.y - 180) < 2,
  );
  assert.ok(touchesReflex, "valley anchors at the reflex corner (160,180)");
  assert.ok(layout.ridges.length >= 1, "L roof has ridge(s)");
});

test("roof layout: unknown edges draw as eaves and are noted", () => {
  const layout = buildRoofLayout({
    outline: RECT,
    edges: outlineEdges(RECT),
    classes: classesFor(RECT, (id) => (id === "E2" || id === "E4" ? "unknown" : "eave")),
  });
  assert.equal(layout.ok, true);
  assert.equal(layout.gableCount, 0);
  assert.equal(layout.hips.length, 4); // unknowns sloped like eaves → hip roof
  assert.ok(layout.notes[0].includes("unknown edge(s) drawn as eaves"));
});

test("roof layout: non-rectilinear outline fails loud, draws nothing", () => {
  const PENT = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 200 },
    { x: 200, y: 330 }, // diagonal edges
    { x: 0, y: 200 },
  ];
  const layout = buildRoofLayout({
    outline: PENT,
    edges: outlineEdges(PENT),
    classes: classesFor(PENT, () => "eave"),
  });
  assert.equal(layout.ok, false);
  assert.equal(layout.ridges.length + layout.hips.length + layout.valleys.length, 0);
  assert.ok(layout.notes[0].includes("not drawn"));
});

test("plan diagonals: 45° strokes inside the outline, deduped; axis/short/outside rejected", () => {
  const segments = [
    [0, 0, 100, 100], // hip-like diagonal (matches the RECT hip corner→ridge)
    [2, 0, 102, 100], // double-stroke of the same line → merged
    [400, 200, 300, 100], // opposite corner hip (slope +1)
    [50, 50, 250, 50], // axis-aligned → rejected
    [10, 10, 22, 22], // too short → rejected
    [500, 500, 600, 600], // midpoint outside the outline → rejected
  ];
  const diags = extractPlanDiagonals(segments, RECT);
  assert.equal(diags.length, 2, JSON.stringify(diags));
});

test("review fix: pure-gable ridge survives 45° noise strokes (no vacuous discard)", () => {
  // 600×200 rect with both ends gabled → ridge only, zero skeleton diagonals.
  // Three short diagonal strokes (hatching / section arrows) must NOT discard it.
  const R = [
    { x: 0, y: 0 },
    { x: 600, y: 0 },
    { x: 600, y: 200 },
    { x: 0, y: 200 },
  ];
  const noise = [
    [40, 40, 90, 88],
    [140, 140, 190, 92],
    [240, 40, 290, 88],
  ];
  const layout = buildRoofLayout({
    outline: R,
    edges: outlineEdges(R),
    classes: classesFor(R, (id) => (id === "E2" || id === "E4" ? "rake" : "eave")),
    segments: noise,
  });
  assert.equal(layout.ok, true);
  const ridgeLen = totalLen(layout.ridges);
  assert.ok(ridgeLen > 550, `full gable ridge survives (got ${ridgeLen})`);
  assert.ok(
    !layout.notes.some((n) => n.includes("contradict")),
    "no discard note for a diagonal-free skeleton",
  );
});

test("review fix: confidence never exceeds 1.0 when a stroke overlaps a hip", () => {
  // A sheet stroke collinear with a hip: matched via the reverse midpoint
  // test — it must count as matched OR adopted, never both.
  const layout = buildRoofLayout({
    outline: RECT,
    edges: outlineEdges(RECT),
    classes: classesFor(RECT, () => "eave"),
    segments: [[30, 30, 200, 200]],
  });
  assert.equal(layout.ok, true);
  assert.ok(layout.confidence <= 1, `confidence ${layout.confidence} <= 1`);
  assert.equal(layout.diag!.matchedPlan + layout.diag!.adopted, 1, "matched XOR adopted");
});

test("review fix: valleys ENDING on the main ridge don't chop it; ambiguous banks draw no phantom", () => {
  // All-eave 600×300 rect: the hip skeleton HAS diagonals, and two V-pairs
  // in the middle match none of them → discard gate fires, valleys adopted,
  // ridge synthesis runs. The V tops all align on y=100; each V's feet
  // converge to a single apex (span 0 → no foot cluster). The ridge must
  // span the full top cluster UNCHOPPED even though valleys END on it.
  const R = [
    { x: 0, y: 0 },
    { x: 600, y: 0 },
    { x: 600, y: 300 },
    { x: 0, y: 300 },
  ];
  const vPairs = [
    [150, 100, 250, 220],
    [250, 220, 350, 100], // V1 apex (250,220)
    [350, 100, 420, 240],
    [420, 240, 490, 100], // V2 apex (420,240)
  ];
  const layout = buildRoofLayout({
    outline: R,
    edges: outlineEdges(R),
    classes: classesFor(R, () => "eave"),
    segments: vPairs,
  });
  assert.equal(layout.ok, true);
  const ridgeAt100 = layout.ridges.filter(
    (r) => Math.abs(r.p1.y - 100) < 12 && Math.abs(r.p2.y - 100) < 12,
  );
  const len100 = totalLen(ridgeAt100);
  assert.ok(len100 >= 320, `ridge on the valley-top line spans ${len100} (endpoint touches must not chop it)`);
  const footRidges = layout.ridges.filter(
    (r) => r.p1.y > 200 && r.p2.y > 200 && Math.abs(r.p1.y - r.p2.y) < 12,
  );
  assert.equal(footRidges.length, 0, "no phantom ridge along the valley feet");

  // AMBIGUOUS bank: one mirrored V whose tops AND feet both align across the
  // same two valleys — plan geometry can't tell ridge from foot. Draw neither.
  const mirrored = [
    [210, 140, 260, 90],
    [340, 90, 390, 140],
    [240, 200, 290, 250], // unrelated third diagonal to arm the discard gate
  ];
  const amb = buildRoofLayout({
    outline: R,
    edges: outlineEdges(R),
    classes: classesFor(R, () => "eave"),
    segments: mirrored,
  });
  assert.equal(amb.ok, true);
  const horizontals = amb.ridges.filter(
    (r) => Math.abs(r.p1.y - r.p2.y) < 6 && Math.abs(r.p1.y - 140) < 12,
  );
  assert.equal(horizontals.length, 0, "no phantom foot-line ridge from the mirrored V");
});

test("cross-check: matching diagonals confirm; unmatched sheet diagonals get ADOPTED", () => {
  const edges = outlineEdges(RECT);
  const classes = classesFor(RECT, () => "eave");
  // Sheet draws exactly the two left-side hips the skeleton computes.
  const matching = [
    [0, 0, 100, 100],
    [0, 200, 100, 100],
  ];
  const good = buildRoofLayout({ outline: RECT, edges, classes, segments: matching });
  assert.equal(good.ok, true);
  assert.ok(good.diag, "diag stats present");
  assert.equal(good.diag!.planDiagonals, 2);
  assert.equal(good.diag!.matchedPlan, 2);
  assert.equal(good.diag!.adopted, 0, "matched lines are not re-adopted");
  assert.ok(good.confidence >= 0.8, `confidence ${good.confidence}`);

  // Sheet draws long diagonals the skeleton has NO counterpart for (a pitch
  // break / tier valley) → they are adopted verbatim as valleys.
  const foreign = [
    [180, 20, 260, 95],
    [180, 180, 260, 105],
  ];
  const withForeign = buildRoofLayout({ outline: RECT, edges, classes, segments: foreign });
  assert.equal(withForeign.ok, true);
  assert.equal(withForeign.diag!.matchedPlan, 0);
  assert.equal(withForeign.diag!.adopted, 2);
  assert.equal(withForeign.valleys.length, 2, "adopted sheet diagonals drawn as valleys");
  const adoptedNote = withForeign.notes.some((n) => n.includes("2 adopted from the sheet"));
  assert.ok(adoptedNote, `notes: ${JSON.stringify(withForeign.notes)}`);

  // crossCheckDiagonals directly: symmetric counts.
  const stats = crossCheckDiagonals(
    { hips: good.hips, valleys: good.valleys.slice(0, 0) },
    extractPlanDiagonals(matching, RECT),
    RECT,
  );
  assert.equal(stats.matchedSkel, 2);
  assert.equal(stats.skeletonDiagonals, 4);
});

test("organizeInterior: a near-miss endpoint snaps onto the ridge", async () => {
  const { organizeInterior } = await import("./roof-layout.ts");
  const OUT = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 200 },
    { x: 0, y: 200 },
  ];
  const frame = [{ p1: { x: 100, y: 100 }, p2: { x: 300, y: 100 } }];
  const r = organizeInterior({
    adopted: [{ p1: { x: 0, y: 0 }, p2: { x: 95, y: 95 } }],
    frame,
    outline: OUT,
    span: 400,
  });
  assert.equal(r.kept.length, 1);
  assert.equal(r.dropped, 0);
  assert.equal(r.connected, 1);
  assert.ok(Math.hypot(r.kept[0].p2.x - 100, r.kept[0].p2.y - 100) < 1e-6);
});

test("organizeInterior: a hanging end extends along its own direction to the frame", async () => {
  const { organizeInterior } = await import("./roof-layout.ts");
  const OUT = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 200 },
    { x: 0, y: 200 },
  ];
  const frame = [{ p1: { x: 100, y: 100 }, p2: { x: 300, y: 100 } }];
  const r = organizeInterior({
    adopted: [{ p1: { x: 0, y: 0 }, p2: { x: 60, y: 60 } }],
    frame,
    outline: OUT,
    span: 400,
  });
  assert.equal(r.kept.length, 1);
  assert.ok(
    Math.hypot(r.kept[0].p2.x - 100, r.kept[0].p2.y - 100) < 1e-6,
    `extended to the ridge, got ${JSON.stringify(r.kept[0].p2)}`,
  );
});

test("organizeInterior: a stroke floating free of the whole frame is dropped", async () => {
  const { organizeInterior } = await import("./roof-layout.ts");
  const OUT = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 200 },
    { x: 0, y: 200 },
  ];
  const r = organizeInterior({
    adopted: [{ p1: { x: 150, y: 50 }, p2: { x: 200, y: 50 } }],
    frame: [{ p1: { x: 100, y: 100 }, p2: { x: 300, y: 100 } }],
    outline: OUT,
    span: 400,
  });
  assert.equal(r.kept.length, 0);
  assert.equal(r.dropped, 1);
});
