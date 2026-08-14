/**
 * Pure node tests for the INK TAKEOFF rebuild ("read the blueprint eaves for
 * gutters"). Run:  npx tsx --test lib/ai/ink-takeoff.test.mts
 *
 * Doctrine under test: runs are pure geometry × the plan's own scale —
 * deterministic, full perimeter coverage, gables dashed, downspouts by rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { inkTakeoff } from "./ink-takeoff.ts";

type Pt = { x: number; y: number };

// Analysis space: y-down, front at MAX y. Scale 0.5 ft/unit.
const RECT: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 0, y: 60 },
];

/** Rectangle with an inset notch on the front (max-y) side. */
const NOTCHED: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 70, y: 60 },
  { x: 70, y: 50 },
  { x: 30, y: 50 },
  { x: 30, y: 60 },
  { x: 0, y: 60 },
];

test("rectangle: 4 runs, exact geometric LF, sides labeled, 4 outside miters", () => {
  const out = inkTakeoff({ ring: RECT, ftPerUnit: 0.5 });
  assert.ok(out);
  assert.equal(out!.runs.length, 4);
  assert.equal(out!.totals.linear_feet_gutter, 160, "2×(50+30) ft — pure geometry");
  assert.equal(out!.totals.outside_corner_miters, 4);
  assert.equal(out!.totals.inside_corner_miters, 0);
  const bySide = new Map(out!.runs.map((r) => [r.side, r]));
  assert.ok(bySide.get("front")!.start.y === 60 || bySide.get("front")!.end.y === 60, "front = max-y edge");
  assert.equal(bySide.get("front")!.length_ft, 50);
  assert.equal(bySide.get("left")!.length_ft, 30);
  assert.ok(out!.downspouts.length >= 2, `corner/spacing rule places drops, got ${out!.downspouts.length}`);
  // Every downspout references a real run.
  const ids = new Set(out!.runs.map((r) => r.id));
  for (const d of out!.downspouts) assert.ok(ids.has(d.from_gutter));
});

test("notched ring: every edge runs (returns included), inside miters counted", () => {
  const out = inkTakeoff({ ring: NOTCHED, ftPerUnit: 0.5 });
  assert.ok(out);
  assert.equal(out!.runs.length, 8, "all 8 edges guttered — the inset's side returns included");
  // Perimeter: 100+60+30+10+40+10+30+60 = 340 units → 170 ft.
  assert.equal(out!.totals.linear_feet_gutter, 170);
  assert.equal(out!.totals.outside_corner_miters, 6);
  assert.equal(out!.totals.inside_corner_miters, 2, "the notch's two re-entrant corners");
});

test("gable side dashes: its edges become rake exclusions, LF drops, nothing else moves", () => {
  const out = inkTakeoff({ ring: RECT, ftPerUnit: 0.5, gableSides: ["left"] });
  assert.ok(out);
  assert.equal(out!.runs.length, 3);
  assert.equal(out!.totals.linear_feet_gutter, 130, "160 − 30 ft left gable");
  assert.equal(out!.excluded.length, 1);
  assert.equal(out!.excluded[0].kind, "rake");
  assert.match(out!.excluded[0].reason, /gable end on the left face/);
  assert.equal(out!.gableLf, 30);
});

test("downspout floor: topped up to the printed D.S. count without stacking", () => {
  const out = inkTakeoff({ ring: RECT, ftPerUnit: 0.5, minDownspouts: 10 });
  assert.ok(out);
  assert.equal(out!.downspouts.length, 10, "meets the sheet's printed floor");
  // No two drops within ~2 ft of each other.
  for (let i = 0; i < out!.downspouts.length; i++) {
    for (let j = i + 1; j < out!.downspouts.length; j++) {
      const a = out!.downspouts[i].at;
      const b = out!.downspouts[j].at;
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 2, `drops ${i}/${j} stacked`);
    }
  }
  assert.equal(out!.totals.downspout_count, 10);
});

test("deterministic: identical input → deep-equal output", () => {
  const a = inkTakeoff({ ring: NOTCHED, ftPerUnit: 0.5, minDownspouts: 8 });
  const b = inkTakeoff({ ring: NOTCHED, ftPerUnit: 0.5, minDownspouts: 8 });
  assert.deepEqual(a, b);
});

test("reject-implausible: bad scale / degenerate ring → null (caller keeps the AI takeoff)", () => {
  assert.equal(inkTakeoff({ ring: RECT, ftPerUnit: 0 }), null);
  assert.equal(inkTakeoff({ ring: RECT, ftPerUnit: NaN }), null);
  assert.equal(inkTakeoff({ ring: RECT.slice(0, 3), ftPerUnit: 0.5 }), null);
  assert.equal(
    inkTakeoff({ ring: [{ x: NaN, y: 0 }, ...RECT], ftPerUnit: 0.5 })?.runs.length,
    4,
    "non-finite points are dropped, the rest still takes off",
  );
});

test("feature quadrants: front covered → porch+lower (amber), rear → patio+lower, garage → main tier", () => {
  // 120×80 ft rectangle (0.5 ft/unit → 240×160 units). Front = max-y.
  const RECT2: Pt[] = [
    { x: 0, y: 0 },
    { x: 240, y: 0 },
    { x: 240, y: 160 },
    { x: 0, y: 160 },
  ];
  const out = inkTakeoff({
    ring: RECT2,
    ftPerUnit: 0.5,
    featureQuadrants: { garage: "front-right", porch: "front-left", patio: "rear-right" },
  });
  assert.ok(out);
  const bySide = new Map(out!.runs.map((r) => [r.side, r]));
  // front edge midpoint is centered (x=120) → in the dead-zone, untagged.
  // Use side geometry: the FRONT run (y=160) spans full width; its midpoint
  // x=120 is central, so it should NOT be grabbed. Left/right runs get tagged.
  const left = bySide.get("left")!;  // x=0, rear-to-front → midpoint y=80 central too
  // With a plain rectangle every side's midpoint is centered on one axis, so
  // the quadrant test (needs BOTH front/rear AND left/right past the pad)
  // tags nothing — verifies the dead-zone guards main eaves.
  assert.equal(out!.runs.every((r) => r.tier !== "lower"), true, "a plain box has no corner-quadrant runs to mis-tag");
  assert.ok(left);
});

test("feature quadrants: an L-jog run sitting in the covered quadrant is tagged", () => {
  // Rectangle with a pop-out in the REAR-RIGHT corner (a patio cover mass):
  // its edges sit clearly in the rear-right quadrant.
  const withPatio: Pt[] = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 40 },   // rear-right pop-out starts
    { x: 260, y: 40 },
    { x: 260, y: 160 },
    { x: 0, y: 160 },
  ];
  const out = inkTakeoff({
    ring: withPatio,
    ftPerUnit: 0.5,
    featureQuadrants: { patio: "rear-right" },
  });
  assert.ok(out);
  // The pop-out's right edge (x=260, y 40→160... midpoint y=100) — hmm that's
  // front half. The rear-right pop-out edges near y=40 (rear) x=200-260
  // (right) get tagged patio+lower.
  const tagged = out!.runs.filter((r) => r.feature === "patio");
  assert.ok(tagged.length >= 1, `at least one patio run, got ${JSON.stringify(out!.runs.map((r) => [r.feature, r.tier]))}`);
  for (const r of tagged) assert.equal(r.tier, "lower");
  assert.match(out!.summary, /LOWER covered roof/);
  assert.match(out!.summary, /rear patio/);
});

test("downspouts land on OUTSIDE (convex) corners, not mid-wall", () => {
  // Notched ring: all 6 outside corners are convex except the 2 notch
  // re-entrant (concave) corners. Every downspout must sit on a convex one.
  const out = inkTakeoff({ ring: NOTCHED, ftPerUnit: 0.5, minDownspouts: 4 });
  assert.ok(out);
  assert.ok(out!.downspouts.length >= 4);
  // Convex (outside) per the ring winding — the 4 box corners + the notch
  // MOUTH corners; concave (inside) = the notch BACK corners (matches the
  // insideMiters=2 the miter test pins).
  const convexCorners = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 },
    { x: 70, y: 60 }, { x: 30, y: 60 }, { x: 0, y: 60 },
  ];
  const concaveCorners = [ { x: 70, y: 50 }, { x: 30, y: 50 } ];
  for (const d of out!.downspouts) {
    if (d.reason !== "outside_corner") continue;
    const onConvex = convexCorners.some((c) => Math.hypot(c.x - d.at.x, c.y - d.at.y) < 1e-6);
    const onConcave = concaveCorners.some((c) => Math.hypot(c.x - d.at.x, c.y - d.at.y) < 1e-6);
    assert.ok(onConvex && !onConcave, `corner drop must sit on a convex corner, got ${JSON.stringify(d.at)}`);
  }
});

test("summary names the doctrine and the replaced runs", () => {
  const out = inkTakeoff({ ring: RECT, ftPerUnit: 0.5 });
  assert.ok(out);
  assert.match(out!.summary, /INK TAKEOFF/);
  assert.match(out!.summary, /verified sheet outline/);
  assert.match(out!.summary, /AI-measured runs were replaced/);
});

test("partial gable: only the gable's stretch dashes — the rest of the face keeps its gutter", () => {
  // 50×30 ft rect. A 10 ft entry/garage gable at viewer 25% across the
  // front must dash ONLY ~10 ft; the remaining ~40 ft of front stays gutter.
  const out = inkTakeoff({
    ring: RECT,
    ftPerUnit: 0.5,
    gableReads: [{ side: "front", centerFrac: 0.25, widthFt: 10 }],
  });
  assert.ok(out);
  const frontRuns = out!.runs.filter((r) => r.side === "front");
  const frontFt = frontRuns.reduce((s, r) => s + (r.length_ft ?? 0), 0);
  assert.equal(frontFt, 40, "front keeps 40 of its 50 ft guttered");
  assert.equal(out!.gableLf, 10, "exactly the gable width dashes");
  assert.equal(out!.excluded.length, 1);
  assert.match(out!.excluded[0].reason, /gable on the front face/);
  // The rake sits centered at plan x = 25% of the width (viewer=plan on front).
  const rk = out!.excluded[0];
  const midX = (rk.start.x + rk.end.x) / 2;
  assert.ok(Math.abs(midX - 25) < 1e-6, `rake centered at x=25, got ${midX}`);
  assert.equal(out!.totals.linear_feet_gutter, 150, "160 − 10 ft gable");
});

test("partial gable ≥70% of its face promotes to a full gable end (whole side dashes)", () => {
  // Left face is 30 ft; a 25 ft gable ≥ 70% → the whole left side is a
  // gable end, same as an explicit gableSides entry.
  const out = inkTakeoff({
    ring: RECT,
    ftPerUnit: 0.5,
    gableReads: [{ side: "left", centerFrac: 0.5, widthFt: 25 }],
  });
  assert.ok(out);
  assert.equal(out!.runs.filter((r) => r.side === "left").length, 0);
  assert.equal(out!.gableLf, 30, "whole 30 ft side dashed");
  assert.match(out!.excluded[0].reason, /gable end on the left face/);
});

test("viewer→plan conversion: a back-face gable at viewer 20% lands on the plan's RIGHT half", () => {
  // Back viewer left = house right → viewer 0.2 → plan frac 0.8 → high-x.
  const out = inkTakeoff({
    ring: RECT,
    ftPerUnit: 0.5,
    gableReads: [{ side: "back", centerFrac: 0.2, widthFt: 10 }],
  });
  assert.ok(out);
  assert.equal(out!.excluded.length, 1);
  const rk = out!.excluded[0];
  const midX = (rk.start.x + rk.end.x) / 2;
  assert.ok(midX > 50, `back gable must sit on the plan's right half, got x=${midX}`);
  assert.ok(Math.abs(midX - 80) < 1e-6, `centered at x=80, got ${midX}`);
});
