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

// ── Downspout synthesis (zero D.S. marks → 1-per-40 ft spacing rule) ──

const allEave = (outline: { x: number; y: number }[]) =>
  outlineEdges(outline).map((e) => ({
    id: e.id,
    edge_class: "eave" as const,
    tier: null,
    feature: null,
  }));

test("downspout synthesis: zero marks → ceil(LF/40) per chain, loudly noted", () => {
  // 80×60 ft all-eave ring = 280 LF → ceil(280/40) = 7 drops.
  const edges = outlineEdges(RECT);
  const r = buildEdgeTakeoff({
    outline: RECT,
    edges,
    classes: allEave(RECT),
    ptPerFt: 1.5,
    downspouts: [],
  });
  assert.equal(r.totals.downspouts, 7);
  assert.ok(
    r.notes.some(
      (n) => n.includes("outside corners") && n.includes("1-per-40 ft"),
    ),
  );
});

test("downspout synthesis: marked downspouts suppress synthesis; a short read is warned", () => {
  const edges = outlineEdges(RECT);
  const r = buildEdgeTakeoff({
    outline: RECT,
    edges,
    classes: allEave(RECT),
    ptPerFt: 1.5,
    downspouts: [{ edge_id: "E1", frac: 0.2 }],
  });
  assert.equal(r.totals.downspouts, 1, "marks are authoritative");
  assert.ok(
    !r.notes.some((n) => n.includes("spacing rule")),
    "no synthesis note",
  );
  assert.ok(
    r.notes.some((n) => n.includes("Review for missed marks")),
    "1 mark for 280 LF is warned",
  );
});

test("downspout synthesis: a duplicated outline vertex never splits a chain", () => {
  // Same physical top wall, one drawn with a duplicate consecutive vertex.
  const clean = [
    { x: 0, y: 0 },
    { x: 35, y: 0 },
    { x: 35, y: 20 },
    { x: 0, y: 20 },
  ];
  const dup = [
    { x: 0, y: 0 },
    { x: 25, y: 0 },
    { x: 25, y: 0 },
    { x: 35, y: 0 },
    { x: 35, y: 20 },
    { x: 0, y: 20 },
  ];
  const run = (outline: { x: number; y: number }[]) => {
    const edges = outlineEdges(outline);
    // Only the top wall is eave; the rest are rakes (isolated chain).
    const classes = edges.map((e) => ({
      id: e.id,
      edge_class:
        e.axis === "h" && Math.abs(e.mid.y) < 1e-6
          ? ("eave" as const)
          : ("rake" as const),
      tier: null,
      feature: null,
    }));
    return buildEdgeTakeoff({
      outline,
      edges,
      classes,
      ptPerFt: 1,
      downspouts: [],
    });
  };
  const a = run(clean);
  const b = run(dup);
  assert.equal(a.totals.eave_lf, b.totals.eave_lf, "same LF either way");
  assert.equal(
    b.totals.downspouts,
    a.totals.downspouts,
    "degenerate vertex is transparent to chains",
  );
});

test("downspout synthesis: ptPerFt of 0 can't hang or synthesize garbage", () => {
  const edges = outlineEdges(RECT);
  const r = buildEdgeTakeoff({
    outline: RECT,
    edges,
    classes: allEave(RECT),
    ptPerFt: 0,
    downspouts: [],
  });
  assert.equal(r.totals.downspouts, 0);
});

test("downspout synthesis: tiny isolated stubs don't each mint a drop", () => {
  // A 40×20 ft body whose top wall is eave, plus a 3 ft eave jog isolated
  // between rakes on the bottom — the jog gets no drop of its own.
  const outline = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 25, y: 20 },
    { x: 25, y: 23 },
    { x: 22, y: 23 },
    { x: 22, y: 20 },
    { x: 0, y: 20 },
  ];
  const edges = outlineEdges(outline);
  const eaveIds = new Set(["E1", "E5"]); // top wall (40ft) + the 3ft jog
  const classes = edges.map((e) => ({
    id: e.id,
    edge_class: eaveIds.has(e.id) ? ("eave" as const) : ("rake" as const),
    tier: null,
    feature: null,
  }));
  const r = buildEdgeTakeoff({
    outline,
    edges,
    classes,
    ptPerFt: 1,
    downspouts: [],
  });
  assert.equal(r.totals.downspouts, 1, "only the real wall gets a drop");
});

test("buildEdgeTakeoff: partial-gable edge prices the complement and skips the gable-end miter", () => {
  const edges = outlineEdges(RECT);
  const classes = [
    // Gable occupies the LAST quarter of E1 — gutter runs [0, 0.75].
    { id: "E1", edge_class: "eave" as const, partial_gables: [{ u0: 0.75, u1: 1 }] },
    { id: "E2", edge_class: "eave" as const },
    { id: "E3", edge_class: "eave" as const },
    { id: "E4", edge_class: "eave" as const },
  ];
  const t = buildEdgeTakeoff({ outline: RECT, edges, classes, ptPerFt: 1.5 });
  // Full ring = 280 ft; the 20 ft gable span comes out of E1.
  assert.equal(t.totals.eave_lf, 260);
  const e1runs = t.gutter_runs.filter((r) => r.id.startsWith("edge-E1"));
  assert.equal(e1runs.length, 1, "one trimmed run on the partial edge");
  assert.equal(e1runs[0].length_ft, 60);
  // The trimmed run's geometry stops where the gable starts.
  assert.ok(Math.abs(e1runs[0].end.x - 90) < 1e-6, "run ends at u=0.75");
  // Corner E1→E2 sits under the gable — no miter there; the other 3 stay.
  assert.equal(t.totals.outside_corner_miters, 3);
  assert.ok(
    t.excluded_edges.some(
      (x) => x.kind === "rake" && x.reason.includes("Flush gable"),
    ),
    "gable interval excluded as rake",
  );
});

test("buildEdgeTakeoff: partial-gable slivers under 2 ft are not priced", () => {
  const edges = outlineEdges(RECT);
  const classes = [
    // Gable eats nearly the whole edge — 1.6 ft + 1.2 ft slivers remain.
    { id: "E1", edge_class: "eave" as const, partial_gables: [{ u0: 0.02, u1: 0.985 }] },
    { id: "E2", edge_class: "eave" as const },
    { id: "E3", edge_class: "eave" as const },
    { id: "E4", edge_class: "eave" as const },
  ];
  const t = buildEdgeTakeoff({ outline: RECT, edges, classes, ptPerFt: 1.5 });
  assert.equal(
    t.gutter_runs.filter((r) => r.id.startsWith("edge-E1")).length,
    0,
    "slivers dropped",
  );
  assert.equal(t.totals.eave_lf, 200);
  // Neither corner of E1 carries gutter → both miters suppressed.
  assert.equal(t.totals.outside_corner_miters, 2);
});

test("buildEdgeTakeoff: synthesized downspouts measure guttered length only and never land on a gable span", () => {
  // One long front eave (E3) with a big mid-wall gable; no D.S. marks read.
  // At 1.5 pt/ft the ring is 280 ft; E3 alone is 80 ft with a ~30 ft gable
  // carved out of the middle → ~50 ft guttered on that edge.
  const edges = outlineEdges(RECT);
  const classes = [
    { id: "E1", edge_class: "eave" as const },
    { id: "E2", edge_class: "rake" as const, evidence: ["gable_end_truss_label"] },
    // E3 = 120pt = 80ft; gable [0.3,0.86] ≈ 45ft → 35ft guttered.
    { id: "E3", edge_class: "eave" as const, partial_gables: [{ u0: 0.3, u1: 0.86 }] },
    { id: "E4", edge_class: "rake" as const, evidence: ["gable_end_truss_label"] },
  ];
  const t = buildEdgeTakeoff({ outline: RECT, edges, classes, ptPerFt: 1.5 });
  const dsOnE3 = t.downspouts.filter((d) => d.edge_id === "E3");
  // Guttered 35 ft → ceil(35/40)=1, NOT the 2 the full 80 ft would force.
  assert.equal(dsOnE3.length, 1, "count uses guttered length, not full edge");
  for (const d of dsOnE3) {
    // Map the drop back to its fraction along E3 and assert it's on gutter.
    const e3 = edges.find((e) => e.id === "E3")!;
    const f = (d.at.x - e3.p1.x) / (e3.p2.x - e3.p1.x);
    assert.ok(
      f <= 0.3 + 1e-6 || f >= 0.86 - 1e-6,
      `drop at f=${f.toFixed(3)} must sit on gutter, not the [0.3,0.86] gable`,
    );
  }
});

test("downspout synthesis: a single drop lands AT the run's outside corner, not mid-wall", () => {
  // 20×20 ft body, top + right walls eave (one L-chain, 40 ft → 1 drop),
  // bottom + left rakes. The drop must sit at the top-right corner where
  // the gutter turns down — not floating in the middle of a wall.
  const outline = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ];
  const edges = outlineEdges(outline);
  const classes = edges.map((e) => ({
    id: e.id,
    edge_class:
      e.id === "E1" || e.id === "E2" ? ("eave" as const) : ("rake" as const),
    tier: null,
    feature: null,
  }));
  const r = buildEdgeTakeoff({ outline, edges, classes, ptPerFt: 1, downspouts: [] });
  assert.equal(r.totals.downspouts, 1);
  const d = r.downspouts[0];
  assert.ok(
    Math.hypot(d.at.x - 20, d.at.y - 0) < 2,
    `drop should sit at the (20,0) corner, got ${JSON.stringify(d.at)}`,
  );
  assert.ok(r.notes.some((n) => n.includes("outside corners")));
});
