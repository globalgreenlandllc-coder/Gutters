/**
 * Pure node tests for reconcileEaves. Run with: npx tsx --test lib/ai/reconcile-eaves.test.mts
 * No DB, no AI, no network — operates on hand-authored BlueprintAnalysis literals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileEaves } from "./reconcile-eaves.ts";
import type { BlueprintAnalysis, BlueprintRun } from "./blueprint-from-plans.ts";

function run(
  side: BlueprintRun["side"],
  a: [number, number],
  b: [number, number],
  lengthFt: number,
): BlueprintRun {
  return {
    id: `${side}-${a[0]}`,
    side,
    start: { x: a[0], y: a[1] },
    end: { x: b[0], y: b[1] },
    length_ft: lengthFt,
    length_px: Math.hypot(b[0] - a[0], b[1] - a[1]),
    drains_to: [],
    tier: "lower",
  };
}

function base(over: Partial<BlueprintAnalysis>): BlueprintAnalysis {
  return {
    scale: { feet_per_unit: null, unit: "pixels", source: "test" },
    building_footprint: [],
    gutter_runs: [],
    downspouts: [],
    excluded_edges: [],
    totals: { linear_feet_gutter: 0, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
    confidence: "medium",
    notes: [],
    ...over,
  };
}

// A symmetric "H/U" house: 200 wide × 120 tall rectangle. Top (front) and
// bottom (rear) walls each carry an eave. We simulate the AI guttering the
// FRONT wall but DROPPING the symmetric REAR wall.
const FOOT: BlueprintAnalysis["building_footprint"] = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 120 },
  { x: 0, y: 120 },
];

test("symmetric drop: re-adds the missing rear eave, copies twin length_ft", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 40), // front (top) guttered
      run("left", [0, 0], [0, 120], 24),
      run("right", [200, 0], [200, 120], 24),
      // rear (bottom) intentionally DROPPED
    ],
    excluded_edges: [],
    totals: { linear_feet_gutter: 88, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis, reconcileNotes } = reconcileEaves(a);
  assert.equal(analysis.gutter_runs.length, 4, "one run added");
  const added = analysis.gutter_runs[3];
  assert.equal(added.length_ft, 40, "copies front twin's length_ft exactly");
  assert.equal(added.side, "back", "mirrored side front->back");
  assert.equal(analysis.totals.linear_feet_gutter, 128, "total += 40");
  assert.ok(reconcileNotes.some((n) => /Auto-added/.test(n)));
});

test("no-op when every wall is already guttered or raked", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 40),
      run("back", [0, 120], [200, 120], 40),
    ],
    excluded_edges: [
      { kind: "rake", start: { x: 0, y: 0 }, end: { x: 0, y: 120 }, reason: "gable" },
      { kind: "rake", start: { x: 200, y: 0 }, end: { x: 200, y: 120 }, reason: "gable" },
    ],
    totals: { linear_feet_gutter: 80, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis } = reconcileEaves(a);
  assert.equal(analysis.gutter_runs.length, 2, "nothing added");
  assert.equal(analysis.totals.linear_feet_gutter, 80, "total unchanged");
});

test("asymmetric uncovered wall: NOT priced, only flagged", () => {
  // Front guttered; rear is a real gable rake but UNMARKED (no excluded_edge),
  // and there is NO guttered twin (left/right are short rakes, not mirrors of
  // the long rear wall). Should flag, not add.
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [run("front", [0, 0], [200, 0], 40)],
    excluded_edges: [],
    totals: { linear_feet_gutter: 40, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis, reconcileNotes } = reconcileEaves(a);
  // rear wall's twin IS the front (guttered, parallel, same length) -> it WILL
  // be auto-added. left/right have no guttered twin -> flagged. So expect rear
  // added (1) and left+right flagged.
  const added = analysis.gutter_runs.filter((r) => r.id.startsWith("recon-"));
  assert.equal(added.length, 1, "only the symmetric rear is added");
  assert.equal(added[0].side, "back");
  assert.ok(reconcileNotes.some((n) => /Closure check: 2 exterior wall/.test(n)), "left+right flagged");
});

test("malformed footprint (<4 pts) -> unchanged", () => {
  const a = base({ building_footprint: [{ x: 0, y: 0 }, { x: 10, y: 0 }], gutter_runs: [run("front", [0, 0], [10, 0], 10)] });
  const { analysis, reconcileNotes } = reconcileEaves(a);
  assert.equal(analysis.gutter_runs.length, 1);
  assert.equal(reconcileNotes.length, 0);
});

test("NaN coords in footprint don't crash; degrade safely", () => {
  const a = base({
    building_footprint: [
      { x: 0, y: 0 },
      { x: NaN, y: 0 },
      { x: 200, y: 120 },
      { x: 0, y: 120 },
    ],
    gutter_runs: [run("front", [0, 0], [200, 0], 40)],
  });
  const { analysis } = reconcileEaves(a);
  assert.ok(Array.isArray(analysis.gutter_runs));
});

test("shallow recess survives the smaller tolerance", () => {
  // 300-wide house, front wall steps in 6px (a shallow porch recess) between
  // two segments. The recessed center edge is guttered on the FRONT; the
  // mirror on the REAR is dropped. Skeleton's 3% tol (=9px) would snap the 6px
  // recess away; reconcile's 1.2% tol (=3.6px) keeps it.
  const foot = [
    { x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 6 }, { x: 180, y: 6 }, { x: 180, y: 0 }, { x: 300, y: 0 },
    { x: 300, y: 120 }, { x: 180, y: 120 }, { x: 180, y: 114 }, { x: 120, y: 114 }, { x: 120, y: 120 }, { x: 0, y: 120 },
  ];
  const a = base({
    building_footprint: foot,
    gutter_runs: [
      run("front", [120, 6], [180, 6], 12), // the recessed front-center eave
      run("front", [0, 0], [120, 0], 24),
      run("front", [180, 0], [300, 0], 24),
      run("left", [0, 0], [0, 120], 24),
      run("right", [300, 0], [300, 120], 24),
      run("back", [0, 120], [120, 120], 24),
      run("back", [180, 120], [300, 120], 24),
      // rear recessed center [120,114]-[180,114] DROPPED
    ],
    totals: { linear_feet_gutter: 156, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis } = reconcileEaves(a);
  const added = analysis.gutter_runs.filter((r) => r.id.startsWith("recon-"));
  assert.ok(added.some((r) => r.side === "back" && r.length_ft === 12), "recessed rear-center eave re-added with copied 12 ft");
});

// ── closeVectorPerimeter — the vector-authoritative closure ──────────────────
import { closeVectorPerimeter } from "./reconcile-eaves.ts";

test("vector closure: unclassified edges price as eaves at the runs' own scale (with elevation evidence)", () => {
  // 200×120 vector footprint; the AI traced only front + left (0.5 ft/px).
  // A readable elevation (continuous eave) provides the classification
  // EVIDENCE that makes the "@ all eaves" default safe to apply.
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 100), // 200 px → 0.5 ft/px
      run("left", [0, 0], [0, 120], 60),
    ],
    totals: { linear_feet_gutter: 160, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis, reconcileNotes } = closeVectorPerimeter(a, {
    perFace: { north: { readable: true, continuous_eave: true } },
  });
  assert.equal(analysis.gutter_runs.length, 4, "right + rear added");
  const added = analysis.gutter_runs.slice(2);
  const bySide = Object.fromEntries(added.map((r) => [r.side, r]));
  // Side words follow the canvas convention (bottom = front, orientation-anchor).
  assert.equal(bySide.front?.length_ft, 100, "bottom edge = 200 px × 0.5");
  assert.equal(bySide.right?.length_ft, 60, "right edge = 120 px × 0.5");
  assert.equal(analysis.totals.linear_feet_gutter, 320);
  assert.ok(reconcileNotes.some((n) => /Vector closure/.test(n)));
});

test("vector closure: NO evidence (all elevations failed, no rakes marked) → adds NOTHING, flags for review", () => {
  // The Woodinville credits-outage regression: every per-face read errored and
  // the trace marked no rakes. Defaulting "unclassified ⇒ eave" would price the
  // whole perimeter blind (223 → 520 LF). The closure must skip instead.
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 100),
      run("left", [0, 0], [0, 120], 60),
    ],
    totals: { linear_feet_gutter: 160, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  // No opts at all (no perFace, no excluded_edges) = zero evidence.
  const r = closeVectorPerimeter(a);
  assert.equal(r.analysis.gutter_runs.length, 2, "nothing priced");
  assert.equal(r.analysis.totals.linear_feet_gutter, 160, "total unchanged");
  assert.ok(r.reconcileNotes.some((n) => /SKIPPED/.test(n) && /UNPRICED for review/.test(n)));
  // Faces present but ALL unreadable is the same as no faces.
  const r2 = closeVectorPerimeter(a, {
    perFace: { north: { readable: false }, south: { readable: false } },
  });
  assert.equal(r2.analysis.gutter_runs.length, 2, "unreadable faces are not evidence");
  // A rake classification on the trace is NOT enough on its own: it proves some
  // edge is a gable end but can't tell which UNCLASSIFIED edges are eaves, and
  // there is no readable face to suppress gable ends. With every elevation
  // failed, closure must skip + flag rather than price the perimeter blind
  // (the exact credits-outage over-count). A readable face is required.
  const withRake = base({
    building_footprint: FOOT,
    gutter_runs: [run("front", [0, 0], [200, 0], 100), run("left", [0, 0], [0, 120], 60)],
    excluded_edges: [{ id: "x1", kind: "rake", start: { x: 200, y: 0 }, end: { x: 200, y: 120 }, reason: "gable end" }],
  });
  const r3 = closeVectorPerimeter(withRake);
  assert.equal(r3.analysis.gutter_runs.length, 2, "rake classification alone does NOT unlock closure (no readable face)");
  assert.ok(r3.reconcileNotes.some((n) => /SKIPPED/.test(n)), "skips + flags for review");
  // But a readable face DOES unlock it, still honoring the explicit rake edge.
  const r4 = closeVectorPerimeter(withRake, {
    perFace: { north: { readable: true, continuous_eave: true } },
  });
  assert.ok(r4.analysis.gutter_runs.length > 2, "a readable face unlocks the closure");
  assert.ok(
    r4.analysis.gutter_runs.every((g) => !(g.id.startsWith("vclose") && g.side === "right")),
    "the rake-classified right edge stays unguttered",
  );
});

test("vector closure: a remapped run slightly OFF its wall still counts as coverage (no double-price)", () => {
  // The AI runs are bbox-remapped onto the vector outline, so they sit near
  // their walls, not on them. A front run floating 5px inside (2.5% of the
  // 200px span) must still cover the front edge — re-pricing it would double
  // count the same wall.
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 5], [200, 5], 100), // 5px inside the y=0 front wall
      run("left", [5, 0], [5, 120], 60), // 5px inside the x=0 left wall
      run("right", [195, 0], [195, 120], 60),
      run("back", [0, 115], [200, 115], 100),
    ],
    totals: { linear_feet_gutter: 320, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis } = closeVectorPerimeter(a, {
    perFace: { north: { readable: true, continuous_eave: true } },
  });
  assert.equal(analysis.gutter_runs.length, 4, "all four walls already covered — nothing re-priced");
  assert.equal(analysis.totals.linear_feet_gutter, 320);
});

test("vector closure: a gable-end face read (continuous_eave=false) keeps its edge unguttered", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 100),
      run("left", [0, 0], [0, 120], 60),
    ],
  });
  const { analysis, reconcileNotes } = closeVectorPerimeter(a, {
    // default orientation: east = +x = the right edge
    perFace: { east: { readable: true, continuous_eave: false } },
  });
  assert.equal(analysis.gutter_runs.length, 3, "only the bottom edge added — east edge is a gable end");
  assert.equal(analysis.gutter_runs[2].side, "front");
  assert.ok(reconcileNotes.some((n) => /gable-end/.test(n)));
});

test("vector closure: excluded (rake) edges and covered edges are not re-priced; no runs → no-op", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 100),
      run("left", [0, 0], [0, 120], 60),
      run("right", [200, 0], [200, 120], 60),
    ],
    excluded_edges: [
      { id: "x1", kind: "rake", start: { x: 0, y: 120 }, end: { x: 200, y: 120 }, reason: "gable end" },
    ],
  });
  const r1 = closeVectorPerimeter(a);
  assert.equal(r1.analysis.gutter_runs.length, 3, "everything classified — nothing added");
  // No measured runs at all → no independent scale → untouched.
  const r2 = closeVectorPerimeter(base({ building_footprint: FOOT }));
  assert.equal(r2.analysis.gutter_runs.length, 0);
  assert.equal(r2.reconcileNotes.length, 0);
});

// ── trace-hip closure — raster AI trace, unanimously hipped elevations ────────

/** All four faces readable, continuous eave, zero gables — unanimous hip. */
const HIP_FACES = Object.fromEntries(
  ["front", "rear", "left", "right"].map((f) => [
    f,
    { readable: true, continuous_eave: true, gable_count: 0, gables: [] },
  ]),
);

test("trace-hip closure: unguttered walls on a hip-unanimous raster trace price as UPPER eaves", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 40),
      run("left", [0, 0], [0, 120], 24),
      run("right", [200, 0], [200, 120], 24),
      // rear (bottom) wall unguttered — on a hip roof that's a missed eave.
    ],
  });
  const { analysis, reconcileNotes } = closeVectorPerimeter(a, {
    perFace: HIP_FACES,
    mode: "trace-hip",
  });
  assert.equal(analysis.gutter_runs.length, 4, "rear wall priced");
  const added = analysis.gutter_runs[3];
  assert.ok(added.id.startsWith("hclose-"), "trace-hip run id");
  assert.equal(added.tier, "upper", "main-ring wall lands on the upper tier");
  assert.equal(added.length_ft, 40, "priced at the runs' own ft/px scale (0.2 × 200)");
  assert.ok(
    reconcileNotes.some((n) => /Hip closure/.test(n) && /ZERO gables/.test(n)),
    "note explains the hip-unanimity evidence",
  );
});

test("trace-hip closure: cap trips when closing would exceed the ring's own perimeter", () => {
  // A phantom double-traced run (10 px claiming 60 ft — its ratio is an
  // outlier, so the median scale stays honest at 0.2 ft/px) already inflates
  // the upper-tier total to 148 ft on a 128 ft perimeter. Closing the rear
  // wall (+40 ft) would land at 188 ft ≫ perimeter × 1.1 — leave it unpriced
  // instead of stacking auto-LF on top of a broken trace.
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      { ...run("front", [0, 0], [200, 0], 40), tier: "upper" },
      { ...run("left", [0, 0], [0, 120], 24), tier: "upper" },
      { ...run("right", [200, 0], [200, 120], 24), tier: "upper" },
      { ...run("front", [90, 0], [100, 0], 60), id: "phantom", tier: "upper" },
    ],
  });
  const { analysis, reconcileNotes } = closeVectorPerimeter(a, {
    perFace: HIP_FACES,
    mode: "trace-hip",
  });
  assert.equal(analysis.gutter_runs.length, 4, "nothing auto-priced past the cap");
  assert.ok(
    reconcileNotes.some((n) => /Hip closure CAPPED/.test(n)),
    "cap emits a loud capped note",
  );
});

test("vector mode is unchanged: same fixture keeps the vclose id and unknown tier", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 40),
      run("left", [0, 0], [0, 120], 24),
      run("right", [200, 0], [200, 120], 24),
    ],
  });
  const { analysis } = closeVectorPerimeter(a, { perFace: HIP_FACES });
  assert.equal(analysis.gutter_runs.length, 4);
  assert.ok(analysis.gutter_runs[3].id.startsWith("vclose-"));
  assert.equal(analysis.gutter_runs[3].tier, "unknown");
});

// ── excludeEdges — the deep-notch audit's suspect legs stay UNPRICED ─────────

/** Front + left guttered; the RIGHT and REAR (bottom) walls are unguttered.
 *  0.2 ft/px scale from the runs' own measurements. */
const twoOpenWalls = () =>
  base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 40),
      run("left", [0, 0], [0, 120], 24),
    ],
    totals: { linear_feet_gutter: 64, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });

test("trace-hip closure with excludeEdges: suspect notch legs SKIPPED + noted UNPRICED; other walls still close", () => {
  const { analysis, reconcileNotes } = closeVectorPerimeter(twoOpenWalls(), {
    perFace: HIP_FACES,
    mode: "trace-hip",
    // The right wall is a suspect pocket leg (deep-notch audit) — never price it.
    excludeEdges: [{ a: { x: 200, y: 0 }, b: { x: 200, y: 120 } }],
  });
  // Only the bottom (rear) wall was auto-priced; the excluded right wall was not.
  assert.equal(analysis.gutter_runs.length, 3, "one wall closed, one excluded");
  const added = analysis.gutter_runs[2];
  assert.ok(added.id.startsWith("hclose-"));
  assert.equal(added.length_ft, 40, "bottom wall at the runs' own 0.2 ft/px");
  assert.ok(
    !analysis.gutter_runs.some(
      (r) => r.id.startsWith("hclose-") && Math.abs(r.start.x - 200) < 1 && Math.abs(r.end.x - 200) < 1,
    ),
    "the excluded right wall got NO run",
  );
  assert.equal(analysis.totals.linear_feet_gutter, 104, "64 + 40 — the 24 LF suspect leg is NOT billed");
  const note = reconcileNotes.find((n) => /Hip closure/.test(n));
  assert.ok(note, "closure note present");
  assert.match(note!, /1 suspect notch leg\(s\) \(~24 LF\) left UNPRICED per the deep-notch audit/);
  assert.match(note!, /verify\/edit the outline/);
});

test("trace-hip closure with excludeEdges: nothing else to close still notes the skipped legs (never silent)", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 40),
      run("left", [0, 0], [0, 120], 24),
      run("back", [0, 120], [200, 120], 40),
    ],
  });
  const { analysis, reconcileNotes } = closeVectorPerimeter(a, {
    perFace: HIP_FACES,
    mode: "trace-hip",
    excludeEdges: [{ a: { x: 200, y: 0 }, b: { x: 200, y: 120 } }],
  });
  assert.equal(analysis.gutter_runs.length, 3, "nothing auto-priced");
  assert.ok(
    reconcileNotes.some((n) => /Hip closure:/.test(n) && /UNPRICED per the deep-notch audit/.test(n)),
    "a skipped leg is still reported when no other wall closes",
  );
});

test("trace-hip closure WITHOUT excludeEdges is byte-identical to today (pinned totals)", () => {
  const { analysis, reconcileNotes } = closeVectorPerimeter(twoOpenWalls(), {
    perFace: HIP_FACES,
    mode: "trace-hip",
  });
  // Both open walls close, ring-walk order: right (24) then bottom (40).
  assert.equal(analysis.gutter_runs.length, 4);
  const [addedRight, addedBottom] = analysis.gutter_runs.slice(2);
  assert.equal(addedRight.id, "hclose-1");
  assert.equal(addedRight.length_ft, 24);
  assert.equal(addedRight.tier, "upper");
  assert.equal(addedBottom.id, "hclose-2");
  assert.equal(addedBottom.length_ft, 40);
  assert.equal(analysis.totals.linear_feet_gutter, 128, "64 + 24 + 40");
  assert.equal(reconcileNotes.length, 1);
  assert.match(reconcileNotes[0], /^Hip closure: every readable elevation shows a continuous eave/);
  assert.ok(!/notch/.test(reconcileNotes[0]), "no notch wording without excludes");
  // Empty excludeEdges array behaves exactly like the option being absent.
  const empty = closeVectorPerimeter(twoOpenWalls(), {
    perFace: HIP_FACES,
    mode: "trace-hip",
    excludeEdges: [],
  });
  assert.deepEqual(empty.analysis, analysis);
  assert.deepEqual(empty.reconcileNotes, reconcileNotes);
});

// ── House-relative perFace keys in closeVectorPerimeter ──────────────────────
// Modern read-elevations rows key faces "front"/"rear"/"left"/"right". The old
// gable-end loop iterated cardinal names only, so a house-relative full-wall
// gable read was INVISIBLE and the closure priced gutter straight across a
// gable end. Doctrine: never bill across a gable end.

test("HOUSE-RELATIVE full-wall gable read suppresses closure pricing on that wall (LF lower, note names it)", () => {
  const fixture = () =>
    base({
      building_footprint: FOOT,
      gutter_runs: [
        run("front", [0, 0], [200, 0], 100),
        run("left", [0, 0], [0, 120], 60),
      ],
    });
  // WITHOUT the gable read: both open walls close (right 60 + rear 100).
  const open = closeVectorPerimeter(fixture(), {
    perFace: { front: { readable: true, continuous_eave: true } },
  });
  assert.equal(open.analysis.gutter_runs.length, 4, "baseline: right + rear both priced");
  // WITH a house-relative RIGHT face reading a full-wall gable end: the right
  // wall must stay unpriced.
  const withGable = closeVectorPerimeter(fixture(), {
    perFace: {
      front: { readable: true, continuous_eave: true },
      right: { readable: true, continuous_eave: false },
    },
  });
  assert.equal(withGable.analysis.gutter_runs.length, 3, "only the rear wall priced");
  assert.ok(
    !withGable.analysis.gutter_runs.some(
      (r) => r.id.startsWith("vclose") && Math.abs(r.start.x - 200) < 1 && Math.abs(r.end.x - 200) < 1,
    ),
    "the right (gable-end) wall got NO run",
  );
  const totalOf = (a: typeof open.analysis) =>
    a.gutter_runs.reduce((s, r) => s + (r.length_ft ?? 0), 0);
  assert.ok(totalOf(withGable.analysis) < totalOf(open.analysis), "priced LF is LOWER with the gable read");
  assert.ok(
    withGable.reconcileNotes.some((n) => /gable-end/.test(n) && /right/.test(n)),
    "the note names the suppressed face",
  );
  // EXACT parity with the legacy cardinal key: an "east" read must suppress the
  // same wall with identical priced runs (only the note's face word differs).
  const cardinal = closeVectorPerimeter(fixture(), {
    perFace: {
      front: { readable: true, continuous_eave: true },
      east: { readable: true, continuous_eave: false },
    },
  });
  assert.deepEqual(withGable.analysis, cardinal.analysis, "house-relative ≡ cardinal suppression");
});

test("all-hip read (no gables): closure byte-identical under house-relative vs cardinal keys", () => {
  const cardinalHip = Object.fromEntries(
    ["north", "south", "east", "west"].map((f) => [
      f,
      { readable: true, continuous_eave: true, gable_count: 0, gables: [] },
    ]),
  );
  for (const mode of ["trace-hip", "vector"] as const) {
    const hr = closeVectorPerimeter(twoOpenWalls(), { perFace: HIP_FACES, mode });
    const cd = closeVectorPerimeter(twoOpenWalls(), { perFace: cardinalHip, mode });
    assert.deepEqual(hr.analysis, cd.analysis, `${mode}: identical analysis`);
    assert.deepEqual(hr.reconcileNotes, cd.reconcileNotes, `${mode}: identical notes`);
  }
});

// ── round-6: per-sub-span coverage + the cap→suggestions channel ─────────────

test("closure prices a MID-WALL gap the binary coverage test used to swallow", () => {
  // Rear wall (200 px) covered only at its corners: two 60-px runs leave an
  // 80-px (40 ft… at 0.5 ft/px → 40 ft) unguttered middle. The old >50%
  // whole-edge test skipped the wall entirely.
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 100),
      run("left", [0, 0], [0, 120], 60),
      run("right", [200, 0], [200, 120], 60),
      run("back", [0, 120], [60, 120], 30), // rear left corner only
      run("back", [140, 120], [200, 120], 30), // rear right corner only
    ],
    totals: { linear_feet_gutter: 280, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis, reconcileNotes } = closeVectorPerimeter(a, {
    perFace: { north: { readable: true, continuous_eave: true } },
  });
  const added = analysis.gutter_runs.slice(5);
  assert.equal(added.length, 1, "exactly the mid-wall gap");
  assert.equal(added[0].length_ft, 40, "80 px × 0.5 ft/px");
  // Geometry sits on the gap, not the whole wall.
  const xs = [added[0].start.x, added[0].end.x].sort((p, q) => p - q);
  assert.ok(Math.abs(xs[0] - 60) <= 12 && Math.abs(xs[1] - 140) <= 12, `gap span (got ${xs})`);
  assert.equal(analysis.totals.linear_feet_gutter, 320);
  assert.ok(reconcileNotes.length > 0);
});

test("closure ignores sub-6-ft mid-wall gaps (label noise), keeps 2-ft floor for whole edges", () => {
  // Rear wall covered except a 10-px (5 ft) sliver — noise, not gutter.
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 100),
      run("left", [0, 0], [0, 120], 60),
      run("right", [200, 0], [200, 120], 60),
      run("back", [0, 120], [110, 120], 55),
      run("back", [120, 120], [200, 120], 40),
    ],
    totals: { linear_feet_gutter: 315, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis } = closeVectorPerimeter(a, {
    perFace: { north: { readable: true, continuous_eave: true } },
  });
  assert.equal(analysis.gutter_runs.length, 5, "5-ft sliver not priced");
});

// ── ELEVATION-EAVE-WINS — a zero-gable continuous-eave face overrides rakes ──
// The 1168G production failure: two of four elevation reads died on Anthropic
// 529 overloaded_error; the trace's hallucinated "gable ends on the left and
// right" stood as excluded_edges, permanently unpricing both long walls (151
// LF priced vs ~269 true). The faces that DID read (left, right) both reported
// one continuous eave and ZERO gables — that evidence must win over the rake.

/** Trace rakes on the left (x=0) and right (x=200) walls. */
const LR_RAKES = [
  { id: "x-left", kind: "rake", start: { x: 0, y: 0 }, end: { x: 0, y: 120 }, reason: "gable end (hallucinated)" },
  { id: "x-right", kind: "rake", start: { x: 200, y: 0 }, end: { x: 200, y: 120 }, reason: "gable end (hallucinated)" },
];

/** Front+rear guttered (0.2 ft/px); left/right walls claimed as rakes. */
const the1168G = () =>
  base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 40),
      run("back", [0, 120], [200, 120], 40),
    ],
    excluded_edges: LR_RAKES,
    totals: { linear_feet_gutter: 80, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });

/** left/right read fine (continuous, zero gables); front/rear died on 529s. */
const LR_ONLY_FACES = {
  left: { readable: true, continuous_eave: true, gable_count: 0, gables: [] },
  right: { readable: true, continuous_eave: true, gable_count: 0, gables: [] },
  front: { readable: false },
  rear: { readable: false },
};

test("1168G scenario: readable zero-gable faces restore BOTH rake-claimed walls; note names both; totals grow", () => {
  for (const mode of ["trace-hip", "vector"] as const) {
    const { analysis, reconcileNotes, suggestedRuns } = closeVectorPerimeter(the1168G(), {
      perFace: LR_ONLY_FACES,
      mode,
    });
    // Both long walls priced (120 px × 0.2 ft/px = 24 ft each) — or, if a cap
    // ever refused, surfaced as suggestions. Here the cap clears (128 ft ring).
    const added = analysis.gutter_runs.filter((r) => r.id.startsWith(mode === "trace-hip" ? "hclose" : "vclose"));
    assert.equal(added.length, 2, `${mode}: both rake-claimed walls priced`);
    const xs = added.map((r) => r.start.x).sort((p, q) => p - q);
    assert.ok(Math.abs(xs[0] - 0) < 1 && Math.abs(xs[1] - 200) < 1, `${mode}: runs sit on the left+right walls`);
    for (const r of added) assert.equal(r.length_ft, 24, `${mode}: 120 px at the runs' own 0.2 ft/px`);
    assert.equal(analysis.totals.linear_feet_gutter, 128, `${mode}: 80 + 24 + 24`);
    assert.equal(suggestedRuns, undefined, `${mode}: nothing left to suggest`);
    // Loud note per restored face, naming the face and the override.
    for (const face of ["left", "right"]) {
      assert.ok(
        reconcileNotes.some(
          (n) => n.includes(`🧭 ${face} wall restored`) && n.includes("ZERO gables") && n.includes("VERIFY on the canvas"),
        ),
        `${mode}: restoration note names the ${face} face (got: ${reconcileNotes.join(" | ")})`,
      );
    }
  }
});

test("a face reading 1 gable NEVER restores its wall (suppression semantics intact)", () => {
  const { analysis, reconcileNotes } = closeVectorPerimeter(the1168G(), {
    perFace: {
      ...LR_ONLY_FACES,
      right: {
        readable: true,
        continuous_eave: true,
        gable_count: 1,
        gables: [{ is_hip_end: false }],
      },
    },
    mode: "trace-hip",
  });
  const added = analysis.gutter_runs.filter((r) => r.id.startsWith("hclose"));
  assert.equal(added.length, 1, "only the left wall restored");
  assert.ok(Math.abs(added[0].start.x - 0) < 1, "the priced run is the LEFT wall");
  assert.ok(
    !reconcileNotes.some((n) => n.includes("right wall restored")),
    "no restoration note for the gabled right face",
  );
  // gable_count alone (no entries array) also blocks.
  const counted = closeVectorPerimeter(the1168G(), {
    perFace: { ...LR_ONLY_FACES, right: { readable: true, continuous_eave: true, gable_count: 2 } },
    mode: "trace-hip",
  });
  assert.equal(counted.analysis.gutter_runs.filter((r) => r.id.startsWith("hclose")).length, 1);
});

test("unreadable / missing / ambiguous faces never restore", () => {
  // Unreadable face.
  const unreadable = closeVectorPerimeter(the1168G(), {
    perFace: { ...LR_ONLY_FACES, left: { readable: false }, right: { readable: false }, front: { readable: true, continuous_eave: true, gable_count: 0, gables: [] } },
    mode: "trace-hip",
  });
  assert.equal(
    unreadable.analysis.gutter_runs.filter((r) => r.id.startsWith("hclose")).length,
    0,
    "unreadable left/right faces restore nothing (front's principal edge is already guttered)",
  );
  assert.ok(!unreadable.reconcileNotes.some((n) => n.includes("wall restored")));
  // A broken eave line (continuous_eave false, zero gables) is NOT unambiguous.
  const broken = closeVectorPerimeter(the1168G(), {
    perFace: { ...LR_ONLY_FACES, left: { readable: true, continuous_eave: false, gable_count: 0, gables: [] } },
    mode: "trace-hip",
  });
  assert.ok(
    !broken.analysis.gutter_runs.some((r) => r.id.startsWith("hclose") && Math.abs(r.start.x - 0) < 1),
    "continuous_eave=false face does not restore its wall",
  );
  // LEGACY read objects (no gable info at all) degrade to today: no restore.
  const legacy = closeVectorPerimeter(the1168G(), {
    perFace: { left: { readable: true, continuous_eave: true }, right: { readable: true, continuous_eave: true } },
    mode: "trace-hip",
  });
  assert.equal(legacy.analysis.gutter_runs.filter((r) => r.id.startsWith("hclose")).length, 0, "no explicit zero-gable evidence → no restoration");
  assert.ok(!legacy.reconcileNotes.some((n) => n.includes("wall restored")));
  // roof_form "gabled"/"mixed" vetoes even with an empty gables array.
  const contradictory = closeVectorPerimeter(the1168G(), {
    perFace: { ...LR_ONLY_FACES, left: { readable: true, continuous_eave: true, gable_count: 0, gables: [], roof_form: "mixed" } },
    mode: "trace-hip",
  });
  assert.ok(
    !contradictory.analysis.gutter_runs.some((r) => r.id.startsWith("hclose") && Math.abs(r.start.x - 0) < 1),
    "a contradictory roof_form stays conservative",
  );
});

test("restoration past the trace-hip cap → tap-to-add suggestions, not priced runs (note still fires)", () => {
  // One hot run (0.75 ft/px vs the 0.2 median) inflates the upper total so the
  // cap refuses the restored walls — they must surface as suggestions.
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      { ...run("front", [0, 0], [200, 0], 40), tier: "upper" as const },
      { ...run("back", [0, 120], [200, 120], 40), tier: "upper" as const },
      { ...run("front", [90, 0], [100, 0], 60), id: "phantom", tier: "upper" as const },
    ],
    excluded_edges: LR_RAKES,
    totals: { linear_feet_gutter: 140, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const r = closeVectorPerimeter(a, { perFace: LR_ONLY_FACES, mode: "trace-hip" });
  assert.equal(r.analysis.gutter_runs.length, 3, "nothing auto-priced past the cap");
  assert.equal(r.analysis.totals.linear_feet_gutter, 140, "priced total untouched");
  assert.ok(r.suggestedRuns && r.suggestedRuns.length === 2, "both restored walls surfaced as suggestions");
  assert.ok(r.reconcileNotes.some((n) => n.includes("CAPPED") && n.includes("tap-to-add")));
  assert.ok(
    r.reconcileNotes.some((n) => n.includes("left wall restored")) &&
      r.reconcileNotes.some((n) => n.includes("right wall restored")),
    "restoration notes still fire on the suggestion path",
  );
});

test("deep-notch excludeEdges are NEVER restored, even on a zero-gable face", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 40),
      run("back", [0, 120], [200, 120], 40),
    ],
    // The right wall is ALSO rake-claimed, but the notch audit owns the left wall.
    excluded_edges: [LR_RAKES[1]],
    totals: { linear_feet_gutter: 80, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis, reconcileNotes } = closeVectorPerimeter(a, {
    perFace: LR_ONLY_FACES,
    mode: "trace-hip",
    excludeEdges: [{ a: { x: 0, y: 0 }, b: { x: 0, y: 120 } }],
  });
  const added = analysis.gutter_runs.filter((r) => r.id.startsWith("hclose"));
  assert.equal(added.length, 1, "only the rake-claimed right wall restored");
  assert.ok(Math.abs(added[0].start.x - 200) < 1, "the notch-audited left wall got NO run");
  assert.equal(analysis.totals.linear_feet_gutter, 104, "80 + 24 — the notch leg is NOT billed");
  assert.ok(
    reconcileNotes.some((n) => /suspect notch leg\(s\).*left UNPRICED per the deep-notch audit/.test(n)),
    "notch skip still noted",
  );
  assert.ok(
    !reconcileNotes.some((n) => n.includes("left wall restored")),
    "no restoration note for the notch-audited wall",
  );
});

test("restoration is a no-op when the rake-claimed wall is already fully guttered (no phantom note)", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      run("front", [0, 0], [200, 0], 40),
      run("back", [0, 120], [200, 120], 40),
      run("left", [0, 0], [0, 120], 24),
      run("right", [200, 0], [200, 120], 24),
    ],
    excluded_edges: LR_RAKES, // contradictory rakes over guttered walls
    totals: { linear_feet_gutter: 128, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const { analysis, reconcileNotes } = closeVectorPerimeter(a, {
    perFace: LR_ONLY_FACES,
    mode: "trace-hip",
  });
  assert.equal(analysis.gutter_runs.length, 4, "nothing added");
  assert.equal(analysis.totals.linear_feet_gutter, 128, "total unchanged");
  assert.ok(!reconcileNotes.some((n) => n.includes("wall restored")), "no restoration note when nothing changed");
});

// ── FIX 1 source-text guard — read-elevations.ts is `server-only`, so its
// retry helper can't be imported under node (the package throws on import
// outside a React server context). Following the repo's precedent
// (read-elevations.test.mts "source-text check"), pin the load-bearing
// markers of the transient-retry contract instead; runtime behavior is
// verified manually (see the implementation notes in read-elevations.ts).
test("per-face elevation reads carry a bounded transient retry (source-text check — module is server-only)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./read-elevations.ts", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.ok(src.includes("TRANSIENT_RETRY_DELAYS_MS = [2000, 5000]"), "bounded 2s/5s backoff schedule");
  assert.ok(src.includes("status === 529"), "retries Anthropic 529 overloaded");
  assert.ok(/overloaded_error/.test(src), "recognizes overloaded_error bodies");
  assert.ok(src.includes("status >= 500 && status <= 599"), "retries 5xx");
  assert.ok(src.includes("status === 429"), "retries rate limits");
  assert.ok(src.includes("must fail fast"), "4xx auth/billing documented as fail-fast (no retry)");
  assert.ok(src.includes("(after ${retries}"), "final failure appends '(after N retries)' to the unreadable note");
  assert.ok(src.includes("withTransientRetries(() => client.messages.create("), "the per-face vision call is wrapped");
});

test("trace-hip cap: blocked additions become unpriced tap-to-add suggestions, never silent", () => {
  // Runs already total 350 LF on a ring whose perimeter is 320 ft at the
  // runs' own scale — the cap must refuse to add the uncovered rear wall,
  // but the wall must surface as a suggestion.
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      // ONE hot run (0.75 ft/px vs the 0.5 median) — internal inconsistency
      // is what the cap detects; a uniformly-hot read scales the perimeter
      // estimate with it and sails through.
      { ...run("front", [0, 0], [200, 0], 150), tier: "upper" as const },
      { ...run("left", [0, 0], [0, 120], 60), tier: "upper" as const },
      { ...run("right", [200, 0], [200, 120], 60), tier: "upper" as const },
    ],
    totals: { linear_feet_gutter: 270, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const r = closeVectorPerimeter(a, {
    mode: "trace-hip",
    perFace: { north: { readable: true, continuous_eave: true } },
  });
  assert.equal(r.analysis.gutter_runs.length, 3, "nothing auto-priced past the cap");
  assert.equal(r.analysis.totals.linear_feet_gutter, 270, "priced total untouched");
  assert.ok(r.suggestedRuns && r.suggestedRuns.length >= 1, "uncovered wall surfaced");
  assert.ok(
    r.reconcileNotes.some((n) => n.includes("CAPPED") && n.includes("tap-to-add")),
    `cap note names the suggestions (got: ${r.reconcileNotes.join(" | ")})`,
  );
});

// ── round-9: an overridden phantom rake LEAVES the analysis ──────────────────

test("restoration REMOVES the overridden rake exclusion — downstream passes can't resurrect the phantom gable", () => {
  // Trace claims a rake on the right wall; the right face reads continuous
  // eave + zero gables. The wall must price AND the rake exclusion must be
  // gone from excluded_edges (the run-vs-rake dedupe was deleting restored
  // runs to "keep" the phantom). The unrelated ridge exclusion survives.
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      { ...run("front", [0, 0], [200, 0], 100), tier: "upper" as const },
      { ...run("left", [0, 0], [0, 120], 60), tier: "upper" as const },
      { ...run("back", [0, 120], [200, 120], 100), tier: "upper" as const },
    ],
    excluded_edges: [
      { kind: "rake", start: { x: 200, y: 0 }, end: { x: 200, y: 120 } },
      { kind: "ridge", start: { x: 40, y: 60 }, end: { x: 160, y: 60 } },
    ] as BlueprintAnalysis["excluded_edges"],
    totals: { linear_feet_gutter: 260, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const r = closeVectorPerimeter(a, {
    mode: "trace-hip",
    perFace: {
      right: {
        readable: true,
        continuous_eave: true,
        gable_count: 0,
        gables: [],
        roof_form: "hipped",
      } as never,
    },
  });
  const right = r.analysis.gutter_runs.find((x) => x.id.startsWith("hclose"));
  assert.ok(right, "right wall priced back");
  const kinds = (r.analysis.excluded_edges ?? []).map((e) => e.kind);
  assert.ok(!kinds.includes("rake"), "overridden rake removed from excluded_edges");
  assert.ok(kinds.includes("ridge"), "unrelated exclusion kept");
  assert.ok(
    r.reconcileNotes.some((n) => n.includes("rake mark was removed")),
    "note says the mark was removed",
  );
});

test("no restoration → excluded_edges byte-identical (rake on a face that read a gable)", () => {
  const a = base({
    building_footprint: FOOT,
    gutter_runs: [
      { ...run("front", [0, 0], [200, 0], 100), tier: "upper" as const },
      { ...run("left", [0, 0], [0, 120], 60), tier: "upper" as const },
      { ...run("back", [0, 120], [200, 120], 100), tier: "upper" as const },
    ],
    excluded_edges: [
      { kind: "rake", start: { x: 200, y: 0 }, end: { x: 200, y: 120 } },
    ] as BlueprintAnalysis["excluded_edges"],
    totals: { linear_feet_gutter: 260, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
  });
  const r = closeVectorPerimeter(a, {
    mode: "trace-hip",
    perFace: {
      right: { readable: true, continuous_eave: false, gable_count: 1 } as never,
    },
  });
  assert.deepEqual(r.analysis.excluded_edges, a.excluded_edges, "exclusions untouched");
});
