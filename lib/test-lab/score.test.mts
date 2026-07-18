/**
 * Pure node tests for the replay scorer. Run with:
 *   npx tsx --test lib/test-lab/score.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAgainstTruth, type ScoreSide } from "./score.ts";

const rect = (w: number, h: number, ox = 0, oy = 0): { points: { x: number; y: number }[] }[] => [
  { points: [{ x: ox, y: oy }, { x: ox + w, y: oy }] },
  { points: [{ x: ox + w, y: oy }, { x: ox + w, y: oy + h }] },
  { points: [{ x: ox + w, y: oy + h }, { x: ox, y: oy + h }] },
  { points: [{ x: ox, y: oy + h }, { x: ox, y: oy }] },
];

const side = (over: Partial<ScoreSide> = {}): ScoreSide => ({
  eaves: rect(100, 60), // 2 px/ft → 50×30 ft home, 160 LF
  downspouts: [{ x: 0, y: 0 }, { x: 100, y: 60 }],
  pxPerFt: 2,
  ...over,
});

test("identical geometry scores 100 and clean", () => {
  const s = scoreAgainstTruth(side(), side());
  assert.equal(s.scorePct, 100);
  assert.equal(s.clean, true);
  assert.equal(s.eaveF1, 1);
  assert.equal(s.downspouts.matched, 2);
});

test("pure translation (different crop) still scores 100", () => {
  // Same roof, but the replayed engine cropped differently: every canvas
  // coordinate shifted by (300, 200). Normalization must absorb it.
  const s = scoreAgainstTruth(side({ eaves: rect(100, 60, 300, 200), downspouts: [{ x: 300, y: 200 }, { x: 400, y: 260 }] }), side());
  assert.equal(s.scorePct, 100);
  assert.equal(s.clean, true);
});

test("different pxPerFt on each side is handled (feet-space compare)", () => {
  // Engine side drawn at 4 px/ft — same 50×30 ft roof, twice the pixels.
  const s = scoreAgainstTruth(
    side({ eaves: rect(200, 120), pxPerFt: 4, downspouts: [{ x: 0, y: 0 }, { x: 200, y: 120 }] }),
    side(),
  );
  assert.equal(s.scorePct, 100);
});

test("phantom gutter hurts precision, not recall", () => {
  // Engine drew the true rectangle PLUS a 50 ft phantom run far away
  // (a shed). Recall stays 1; precision ≈ 160/210.
  const engine = side({ eaves: [...rect(100, 60), { points: [{ x: 400, y: 0 }, { x: 500, y: 0 }] }] });
  const s = scoreAgainstTruth(engine, side());
  assert.equal(s.eaveRecall, 1);
  assert.ok(s.eavePrecision < 0.85, `precision ${s.eavePrecision}`);
  assert.equal(s.clean, false);
});

test("missed run hurts recall", () => {
  // Engine missed one 50 ft wall.
  const engine = side({ eaves: rect(100, 60).slice(0, 3) });
  const s = scoreAgainstTruth(engine, side(), { tolFt: 1 });
  assert.ok(s.eaveRecall < 0.85, `recall ${s.eaveRecall}`);
  assert.ok(s.scorePct < 97);
});

test("empty engine output vs real truth → floor score", () => {
  const s = scoreAgainstTruth(side({ eaves: [], downspouts: [] }), side());
  assert.equal(s.eaveF1, 0);
  assert.equal(s.clean, false);
  assert.ok(s.scorePct <= 15);
});

test("downspout mismatch blocks clean even with perfect eaves", () => {
  const s = scoreAgainstTruth(side({ downspouts: [{ x: 0, y: 0 }] }), side());
  assert.equal(s.eaveF1, 1);
  assert.equal(s.clean, false);
  assert.ok(s.scorePct < 100);
});

test("lfErrorPct reports magnitude of length bias", () => {
  // Engine rectangle 10% longer on the two horizontal walls.
  const engine = side({
    eaves: [
      { points: [{ x: 0, y: 0 }, { x: 110, y: 0 }] },
      { points: [{ x: 110, y: 0 }, { x: 110, y: 60 }] },
      { points: [{ x: 110, y: 60 }, { x: 0, y: 60 }] },
      { points: [{ x: 0, y: 60 }, { x: 0, y: 0 }] },
    ],
  });
  const s = scoreAgainstTruth(engine, side());
  assert.ok(s.lfErrorPct > 5 && s.lfErrorPct < 8, `lfErrorPct ${s.lfErrorPct}`);
});
