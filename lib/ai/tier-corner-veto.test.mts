/**
 * Pure node tests for the cross-view tier-corner veto (the 1168G wrong-corner
 * porch). Run: npx tsx --test lib/ai/tier-corner-veto.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tierCornerVeto, viewerPositionToPlanDir } from "./tier-corner-veto.ts";
import type { BlueprintAnalysis, BlueprintRun } from "./blueprint-from-plans.ts";
import type { FaceProjection, FaceReadingRaw } from "./face-merge.ts";

// ── the fixed viewer→plan convention (place-gables rightDir, y-down) ─────────
// MUST hold before anything relies on the mapping: elevations are drawn from
// OUTSIDE the house, so the rear view mirrors left↔right relative to the
// front view, and each side view runs front↔rear along its width.

test("fixed convention: viewer-frame positions map to plan halves (front-at-bottom, y-down)", () => {
  // Rear elevation: viewer stands BEHIND the house → their LEFT end is the
  // HOUSE-RIGHT side (+x).
  assert.deepEqual(viewerPositionToPlanDir("rear", "left_end"), { x: 1, y: 0 });
  assert.deepEqual(viewerPositionToPlanDir("rear", "right_end"), { x: -1, y: 0 });
  // Right elevation: viewer stands on the house-right → their RIGHT end is
  // the REAR (−y; front = bottom = +y).
  assert.deepEqual(viewerPositionToPlanDir("right", "right_end"), { x: 0, y: -1 });
  assert.deepEqual(viewerPositionToPlanDir("right", "left_end"), { x: 0, y: 1 });
  // Front elevation: viewer on the street → right_end = house-right.
  assert.deepEqual(viewerPositionToPlanDir("front", "right_end"), { x: 1, y: 0 });
  // Left elevation: viewer on the house-left → left_end = rear.
  assert.deepEqual(viewerPositionToPlanDir("left", "left_end"), { x: 0, y: -1 });
  // Unpinnable positions map to nothing.
  assert.equal(viewerPositionToPlanDir("rear", "center"), null);
  assert.equal(viewerPositionToPlanDir("rear", "unknown"), null);
  assert.equal(viewerPositionToPlanDir("rear", undefined), null);
  assert.equal(viewerPositionToPlanDir("bogus-face", "left_end"), null);
});

// ── fixtures ────────────────────────────────────────────────────────────────

// 200×120 ring; front = bottom (+y). Rear-right plan corner = (200, 0).
const FOOT = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 120 },
  { x: 0, y: 120 },
];

function run(
  id: string,
  a: [number, number],
  b: [number, number],
  over: Partial<BlueprintRun> = {},
): BlueprintRun {
  return {
    id,
    side: "front",
    start: { x: a[0], y: a[1] },
    end: { x: b[0], y: b[1] },
    length_ft: Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.2 * 10) / 10, // 0.2 ft/px
    length_px: Math.hypot(b[0] - a[0], b[1] - a[1]),
    drains_to: [],
    tier: "upper",
    ...over,
  };
}

function analysis(runs: BlueprintRun[]): BlueprintAnalysis {
  return {
    scale: { feet_per_unit: null, unit: "pixels", source: "test" },
    building_footprint: FOOT.map((p) => ({ ...p })),
    gutter_runs: runs,
    downspouts: [],
    excluded_edges: [],
    totals: { linear_feet_gutter: 100, downspout_count: 0, outside_corner_miters: 0, inside_corner_miters: 0 },
    confidence: "medium",
    notes: [],
  };
}

function faceRead(
  face: FaceReadingRaw["face"],
  projections: FaceProjection[],
): FaceReadingRaw {
  return {
    face,
    readable: true,
    unreadable_reason: null,
    roof_form: "hipped",
    gable_count: 0,
    continuous_eave: false,
    gables: [],
    projections,
    projection_cues: [],
    stories_visible: 1,
    confidence: "high",
  };
}

const proj = (over: Partial<FaceProjection> = {}): FaceProjection => ({
  kind: "patio",
  depth_ft: 13,
  position: "left_end",
  eave_below_main: true,
  notes: "",
  ...over,
});

/** The 1168G evidence: rear elevation shows the lower wing at the viewer's
 *  LEFT end (= house-right), the right elevation at its RIGHT end (= rear)
 *  → pinned plan corner REAR-RIGHT. */
const PIN_REAR_RIGHT = {
  rear: faceRead("rear", [proj({ position: "left_end" })]),
  right: faceRead("right", [proj({ position: "right_end", depth_ft: 13 })]),
  front: faceRead("front", []),
  left: faceRead("left", []),
};

test("veto: perpendicular reads pin REAR-RIGHT and retier a front-right lower porch run — LF unchanged", () => {
  // The trace put the lower "porch" loop on the FRONT-RIGHT (garage) corner:
  // front = +y = the y=120 edge.
  const porch = run("g5", [200, 90], [200, 120], { tier: "lower", feature: "porch", side: "right" });
  const main1 = run("g1", [0, 0], [200, 0]);
  const main2 = run("g2", [0, 120], [160, 120]);
  const a = analysis([main1, main2, porch]);
  const lfBefore = a.gutter_runs.reduce((s, r) => s + (r.length_ft ?? 0), 0);

  const v = tierCornerVeto({ analysis: a, perFace: PIN_REAR_RIGHT });
  assert.ok(v.pinned, "corner pinned");
  assert.equal(v.pinned!.corner, "rear-right");
  assert.deepEqual(v.vetoedRunIds, ["g5"]);

  const g5 = v.analysis.gutter_runs.find((r) => r.id === "g5")!;
  assert.equal(g5.tier, "upper", "retiered to the MAIN tier");
  assert.equal(g5.feature, undefined, "phantom porch label cleared");
  // LF-neutral: lengths, endpoints and totals byte-identical.
  assert.equal(
    v.analysis.gutter_runs.reduce((s, r) => s + (r.length_ft ?? 0), 0),
    lfBefore,
  );
  assert.deepEqual(g5.start, porch.start);
  assert.deepEqual(g5.end, porch.end);
  assert.deepEqual(v.analysis.totals, a.totals);
  assert.deepEqual(v.analysis.building_footprint, a.building_footprint);
  // Loud, specific note.
  const note = v.notes.find((n) => n.includes("PORCH LOCATION CONFLICT"));
  assert.ok(note, "conflict note present");
  assert.match(note!, /front-right/);
  assert.match(note!, /rear-right/);
  assert.match(note!, /rear \+ right elevations/);
  assert.match(note!, /Kept the run priced at the MAIN tier/);
  // A run already AT the pinned corner is never vetoed.
  const atCorner = run("ok1", [140, 0], [200, 0], { tier: "lower", feature: "patio" });
  const v2 = tierCornerVeto({ analysis: analysis([main1, atCorner]), perFace: PIN_REAR_RIGHT });
  assert.deepEqual(v2.vetoedRunIds, []);
  assert.equal(v2.analysis.gutter_runs.find((r) => r.id === "ok1")!.tier, "lower");
});

test("ADVERSARIAL: contradictory pins → NO retier, flag-only 'could not be pinned' note", () => {
  // rear:left_end pins house-RIGHT; front:left_end pins house-LEFT → conflict.
  const contradictory = {
    rear: faceRead("rear", [proj({ position: "left_end" })]),
    front: faceRead("front", [proj({ position: "left_end", kind: "porch" })]),
    right: faceRead("right", [proj({ position: "right_end" })]),
  };
  const porch = run("g5", [200, 90], [200, 120], { tier: "lower", feature: "porch" });
  const a = analysis([run("g1", [0, 0], [200, 0]), porch]);
  const v = tierCornerVeto({ analysis: a, perFace: contradictory });
  assert.equal(v.pinned, null);
  assert.deepEqual(v.vetoedRunIds, []);
  assert.equal(v.analysis.gutter_runs.find((r) => r.id === "g5")!.tier, "lower", "tier untouched");
  const note = v.notes.find((n) => n.includes("could not be pinned"));
  assert.ok(note, "flag-only note present");
  assert.match(note!, /verify/);
  assert.equal(v.suggestedReturn, null);

  // Fewer than 2 usable perpendicular reads (one axis only) degrades the same.
  const oneAxis = { rear: faceRead("rear", [proj({ position: "left_end" })]) };
  const v2 = tierCornerVeto({ analysis: a, perFace: oneAxis });
  assert.deepEqual(v2.vetoedRunIds, []);
  assert.ok(v2.notes.some((n) => n.includes("could not be pinned")));
  // …and stays SILENT when no lower porch run exists to worry about.
  const noPorch = analysis([run("g1", [0, 0], [200, 0])]);
  const v3 = tierCornerVeto({ analysis: noPorch, perFace: oneAxis });
  assert.deepEqual(v3.notes, []);
});

test("old stored reads (no position fields) → analysis unchanged, no note", () => {
  const oldReads = {
    rear: faceRead("rear", [{ kind: "patio", depth_ft: 13, notes: "" }]),
    right: faceRead("right", [{ kind: "patio", depth_ft: 12, notes: "" }]),
  };
  const porch = run("g5", [200, 90], [200, 120], { tier: "lower", feature: "porch" });
  const a = analysis([run("g1", [0, 0], [200, 0]), porch]);
  const v = tierCornerVeto({ analysis: a, perFace: oldReads });
  assert.equal(v.analysis, a, "same object — byte-identical passthrough");
  assert.deepEqual(v.notes, []);
  assert.deepEqual(v.vetoedRunIds, []);
  assert.equal(v.pinned, null);
  assert.equal(v.suggestedReturn, null);
  // No perFace at all behaves the same.
  const v2 = tierCornerVeto({ analysis: a, perFace: null });
  assert.equal(v2.analysis, a);
  assert.deepEqual(v2.notes, []);
});

test("F4: rear-corner pin + straight traced rear edge → unpriced suggested return, sized from the profile depth", () => {
  // Rear edge (y=0) is one straight 200-px run; the elevations pin a lower
  // wing at rear-right with depth 13 ft (right elevation, in profile).
  const a = analysis([
    run("g1", [0, 0], [200, 0]), // 0.2 ft/px scale anchor
    run("g2", [0, 120], [200, 120]),
  ]);
  const v = tierCornerVeto({ analysis: a, perFace: PIN_REAR_RIGHT });
  assert.ok(v.pinned && v.pinned.corner === "rear-right");
  assert.equal(v.pinned!.depthFt, 13, "depth from the perpendicular (right) face's profile read");
  assert.ok(v.suggestedReturn, "suggested return present");
  const { start, end, note } = v.suggestedReturn!;
  // depth 13 ft @ 0.2 ft/px = 65 px: starts ON the rear edge 65 px in from the
  // rear-right corner (200,0), runs 65 px INTO the ring (+y).
  assert.ok(Math.abs(start.x - 135) < 1e-6 && Math.abs(start.y - 0) < 1e-6, `start ${JSON.stringify(start)}`);
  assert.ok(Math.abs(end.x - 135) < 1e-6 && Math.abs(end.y - 65) < 1e-6, `end ${JSON.stringify(end)}`);
  assert.match(note, /ROOF STEPS HERE/);
  assert.match(note, /rear-right/);
  assert.match(note, /tap-add/);

  // A rear edge that ALREADY steps near the pinned corner → nothing suggested.
  const stepped = analysis([run("g1", [105, 0], [200, 0]), run("g2", [0, 120], [200, 120])]);
  stepped.building_footprint = [
    { x: 0, y: 4 },
    { x: 105, y: 4 },
    { x: 105, y: 0 }, // the drawn outward step, 95 px (19 ft) from the corner
    { x: 200, y: 0 },
    { x: 200, y: 120 },
    { x: 0, y: 120 },
  ];
  const v2 = tierCornerVeto({ analysis: stepped, perFace: PIN_REAR_RIGHT });
  assert.ok(v2.pinned, "still pinned");
  assert.equal(v2.suggestedReturn, null, "step already drawn — no suggestion");

  // A FRONT-corner pin never fires the rear-step channel.
  const pinFrontRight = {
    rear: faceRead("rear", []),
    front: faceRead("front", [proj({ position: "right_end", kind: "porch" })]),
    right: faceRead("right", [proj({ position: "left_end" })]), // left_end = front
  };
  const v3 = tierCornerVeto({ analysis: a, perFace: pinFrontRight });
  assert.ok(v3.pinned && v3.pinned.corner === "front-right");
  assert.equal(v3.suggestedReturn, null);
});

// ── round-4: an entry portal can never PIN the corner ────────────────────────

test("entry-portal reads can NOT pin a corner — degrade to the honest could-not-pin note", () => {
  // The 1168G misfire: the recessed front entry read as a 'lower mass at the
  // left end' of the front elevation, a weak right-side 'entry' read agreed,
  // and the pin confidently named the WRONG corner (front-left). Entry kinds
  // are excluded from pinning now — with nothing else, there is NO pin.
  const perFace = {
    front: faceRead("front", [proj({ kind: "entry", position: "left_end" })]),
    right: faceRead("right", [proj({ kind: "entry", position: "left_end" })]),
    rear: faceRead("rear", []),
    left: faceRead("left", []),
  };
  const porch = run("g5", [200, 90], [200, 120], { tier: "lower", feature: "porch", side: "right" });
  const a = analysis([run("g1", [0, 0], [200, 0]), porch]);
  const v = tierCornerVeto({ analysis: a, perFace });
  assert.equal(v.pinned, null, "entry reads must not pin");
  assert.deepEqual(v.vetoedRunIds, []);
  const g5 = v.analysis.gutter_runs.find((r) => r.id === "g5")!;
  assert.equal(g5.tier, "lower", "run untouched without a pin");
  assert.ok(
    v.notes.some((n) => n.includes("could not be pinned")),
    `honest degrade note (got: ${v.notes.join(" | ")})`,
  );
});

test("a porch read still pins even when an entry read disagrees (entry is ignored, not counted)", () => {
  const perFace = {
    rear: faceRead("rear", [proj({ position: "left_end" })]), // patio → house-right
    right: faceRead("right", [proj({ position: "right_end" })]), // patio → rear
    front: faceRead("front", [proj({ kind: "entry", position: "left_end" })]), // noise
    left: faceRead("left", []),
  };
  const porch = run("g5", [200, 90], [200, 120], { tier: "lower", feature: "porch", side: "right" });
  const a = analysis([run("g1", [0, 0], [200, 0]), porch]);
  const v = tierCornerVeto({ analysis: a, perFace });
  assert.ok(v.pinned, "patio/porch reads still pin");
  assert.equal(v.pinned!.corner, "rear-right");
});
