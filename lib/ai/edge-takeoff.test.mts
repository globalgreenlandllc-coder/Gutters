import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineEdges, renderEdgeMapSvg } from "./plan-overlay.ts";
import { findDimSpanCandidates, solvePtPerFt } from "./dim-scale.ts";
import { buildEdgeTakeoff } from "./edge-takeoff.ts";

// 120×90pt rectangle, y down (PDF pt space). At 1.5 pt/ft that's 80×60 ft.
const RECT = [
  { x: 0, y: 0 },
  { x: 120, y: 0 },
  { x: 120, y: 90 },
  { x: 0, y: 90 },
];

test("outlineEdges: ring order, ids, axis tags, lengths", () => {
  const edges = outlineEdges(RECT);
  assert.equal(edges.length, 4);
  assert.deepEqual(edges.map((e) => e.id), ["E1", "E2", "E3", "E4"]);
  assert.equal(edges[0].axis, "h");
  assert.equal(edges[1].axis, "v");
  assert.equal(edges[0].lenPt, 120);
  assert.equal(edges[1].lenPt, 90);
});

test("renderEdgeMapSvg: every edge chip + dim chip lands in the SVG", () => {
  const dims = [
    { id: "D1", p1: { x: 0, y: -20 }, p2: { x: 120, y: -20 }, spanPt: 120, axis: "h" as const },
  ];
  const { svg, edges } = renderEdgeMapSvg({ outline: RECT, dims });
  for (const e of edges) assert.ok(svg.includes(`>${e.id}</text>`), `${e.id} chip present`);
  assert.ok(svg.includes(">D1</text>"), "dim chip present");
  assert.ok(svg.includes("EDGE MAP"), "instruction banner present");
});

test("findDimSpanCandidates: picks long thin spans OUTSIDE the outline, skips wall-tier strokes", () => {
  const segs = [
    // dimension line above the building (thin, spans the width)
    [0, -18, 120, -18, 0.3],
    // duplicate of the same dim (chain re-draw) — must dedupe
    [1, -18.5, 119, -18.5, 0.3],
    // wall stroke INSIDE (thick) — never a dim
    [0, 45, 120, 45, 1.44],
    // thick frame line outside — wrong stroke tier
    [0, -30, 120, -30, 2.5],
    // short tick outside — too short
    [0, -18, 30, -18, 0.3],
  ];
  const dims = findDimSpanCandidates(segs, RECT);
  assert.equal(dims.length, 1);
  assert.equal(dims[0].id, "D1");
  assert.equal(dims[0].axis, "h");
  assert.ok(Math.abs(dims[0].spanPt - 120) < 2);
});

test("solvePtPerFt: median of consistent reads; inconsistent/absent → null", () => {
  const dims = [
    { id: "D1", p1: { x: 0, y: 0 }, p2: { x: 120, y: 0 }, spanPt: 120, axis: "h" as const },
    { id: "D2", p1: { x: 0, y: 0 }, p2: { x: 0, y: 90 }, spanPt: 90, axis: "v" as const },
  ];
  const solved = solvePtPerFt(dims, [
    { id: "D1", feet: 80 }, // 1.5 pt/ft
    { id: "D2", feet: 60 }, // 1.5 pt/ft
  ]);
  assert.ok(solved);
  assert.ok(Math.abs(solved!.ptPerFt - 1.5) < 1e-9);
  assert.deepEqual(solved!.used.sort(), ["D1", "D2"]);
  // A wildly-off read is voted out by the consistent one... with only two
  // conflicting pairs the median still resolves to one of them; a lone
  // unreadable set returns null.
  assert.equal(solvePtPerFt(dims, [{ id: "D1", feet: null }]), null);
  assert.equal(solvePtPerFt(dims, []), null);
});

test("buildEdgeTakeoff: eaves priced exactly, rakes excluded, unknown UNPRICED (no default)", () => {
  const edges = outlineEdges(RECT);
  const classes = [
    { id: "E1", edge_class: "eave" as const, tier: "upper" as const, evidence: ["gutter_callout"] },
    { id: "E2", edge_class: "rake" as const, evidence: ["gable_end_truss_label"] },
    { id: "E3", edge_class: "eave" as const, tier: "lower" as const, feature: "patio" as const, evidence: ["elevation_eave"] },
    { id: "E4", edge_class: "unknown" as const, evidence: [] },
  ];
  const t = buildEdgeTakeoff({
    outline: RECT,
    edges,
    classes,
    ptPerFt: 1.5,
    downspouts: [{ edge_id: "E1", frac: 0.25 }],
  });
  // E1 = 120pt/1.5 = 80 ft, E3 = 80 ft → 160 LF. E4 (90pt) NOT priced.
  assert.equal(t.totals.eave_lf, 160);
  assert.equal(t.gutter_runs.length, 2);
  assert.equal(t.gutter_runs[0].side, "back"); // top edge, y-down canvas
  assert.equal(t.gutter_runs[1].tier, "lower");
  assert.equal(t.gutter_runs[1].feature, "patio");
  assert.equal(t.excluded_edges.filter((e) => e.kind === "rake").length, 1);
  assert.deepEqual(t.unpricedIds, ["E4"]);
  assert.ok(t.notes.some((n) => /UNPRICED/i.test(n) && /E4/.test(n)));
  // Downspout at 25% along E1 (top edge, left→right): x=30, y=0; upper tier → 20 ft.
  assert.equal(t.downspouts.length, 1);
  assert.ok(Math.abs(t.downspouts[0].at.x - 30) < 1e-9);
  assert.equal(t.downspouts[0].drop_height_ft, 20);
  // Corners: only eave↔eave pairs miter. E1-E2 (eave-rake) no; E3-E4 no;
  // E2-E3 no; E4-E1 no → zero miters on this classification.
  assert.equal(t.totals.outside_corner_miters + t.totals.inside_corner_miters, 0);
});

test("buildEdgeTakeoff: all-eave rectangle counts 4 outside corners regardless of winding", () => {
  const classes = (ids: string[]) =>
    ids.map((id) => ({ id, edge_class: "eave" as const, evidence: [] }));
  for (const ring of [RECT, [...RECT].reverse()]) {
    const edges = outlineEdges(ring);
    const t = buildEdgeTakeoff({
      outline: ring,
      edges,
      classes: classes(edges.map((e) => e.id)),
      ptPerFt: 1.5,
    });
    assert.equal(t.totals.outside_corner_miters, 4);
    assert.equal(t.totals.inside_corner_miters, 0);
    assert.equal(t.totals.eave_lf, 280); // 2×(80+60)
  }
});
