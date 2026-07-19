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

test("summary names the doctrine and the replaced runs", () => {
  const out = inkTakeoff({ ring: RECT, ftPerUnit: 0.5 });
  assert.ok(out);
  assert.match(out!.summary, /INK TAKEOFF/);
  assert.match(out!.summary, /verified sheet outline/);
  assert.match(out!.summary, /AI-measured runs were replaced/);
});
