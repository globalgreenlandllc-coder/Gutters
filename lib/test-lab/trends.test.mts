/**
 * Pure node tests for lab trends + calibration. Run with:
 *   npx tsx --test lib/test-lab/trends.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryTrends, dailyScoreTrend, type TrendRunInput } from "./trends.ts";
import {
  computeLabCalibration,
  type LabCalibrationInput,
} from "./lab-calibration.ts";

/* ---------------- score trend ---------------- */

test("dailyScoreTrend groups by day, averages, tracks clean rate", () => {
  const pts = [
    { scorePct: 80, clean: false, engineVersion: "aaa1111", createdAt: "2026-07-01T10:00:00Z" },
    { scorePct: 90, clean: true, engineVersion: "aaa1111", createdAt: "2026-07-01T11:00:00Z" },
    { scorePct: 96, clean: true, engineVersion: "bbb2222", createdAt: "2026-07-08T09:00:00Z" },
  ];
  const trend = dailyScoreTrend(pts);
  assert.equal(trend.length, 2);
  assert.deepEqual(trend[0], {
    day: "2026-07-01",
    avgScorePct: 85,
    cleanRate: 0.5,
    n: 2,
    versions: ["aaa1111"],
  });
  assert.equal(trend[1].avgScorePct, 96);
  assert.equal(trend[1].versions[0], "bbb2222");
});

/* ---------------- category trend ---------------- */

const run = (
  iso: string,
  changes: { key: string; action: string; lengthFt?: number }[],
  tags: { key: string; tag: string }[] = [],
): TrendRunInput => ({
  createdAt: iso,
  tags: tags as TrendRunInput["tags"],
  diff: { changes, downspoutChanges: [] },
});

test("categoryTrends: tagged lanai deletions dying off reads as improving", () => {
  // Prior era: lanai deletions on most runs. Recent era: none.
  const prior = [1, 2, 3, 4].map((i) =>
    run(
      `2026-06-0${i}T00:00:00Z`,
      [{ key: `eave:e${i}`, action: "deleted", lengthFt: 30 }],
      [{ key: `eave:e${i}`, tag: "screen_enclosure" }],
    ),
  );
  const recent = [1, 2, 3, 4].map((i) => run(`2026-07-0${i}T00:00:00Z`, []));
  const rows = categoryTrends([...prior, ...recent], 4);
  const lanai = rows.find((r) => r.category === "screen_enclosure");
  assert.ok(lanai);
  assert.equal(lanai.priorCount, 4);
  assert.equal(lanai.recentCount, 0);
  assert.equal(lanai.trend, "improving");
  assert.equal(lanai.lfPrior, 120);
});

test("categoryTrends: untagged edits get implied categories", () => {
  const rows = categoryTrends(
    [
      run("2026-07-01T00:00:00Z", [
        { key: "eave:a", action: "added", lengthFt: 12 },
        { key: "eave:b", action: "moved", lengthFt: 20 },
        { key: "eave:c", action: "deleted", lengthFt: 8 },
      ]),
    ],
    10,
  );
  const cats = rows.map((r) => r.category).sort();
  assert.deepEqual(cats, ["missing_gutter", "untagged", "wrong_length"]);
  assert.ok(rows.every((r) => r.trend === "new"));
});

/* ---------------- calibration ---------------- */

const corrected = (before: number, after: number): LabCalibrationInput => ({
  status: "CORRECTED",
  eaveLFBefore: before,
  eaveLFAfter: after,
});
const approved: LabCalibrationInput = {
  status: "APPROVED",
  eaveLFBefore: 200,
  eaveLFAfter: 200,
};

test("calibration: consistent short-draw bias is flagged actionable", () => {
  const cal = computeLabCalibration([
    corrected(200, 204),
    corrected(150, 153),
    corrected(300, 305),
    corrected(180, 184),
    corrected(220, 223),
  ]);
  assert.equal(cal.sampleCount, 5);
  assert.equal(cal.actionable, true);
  assert.ok(cal.medianLfDeltaFt >= 3 && cal.medianLfDeltaFt <= 5);
});

test("calibration: below sample floor is never actionable", () => {
  const cal = computeLabCalibration([corrected(200, 210), corrected(150, 158)]);
  assert.equal(cal.actionable, false);
});

test("calibration: approvals vote for zero and can kill actionability", () => {
  const cal = computeLabCalibration([
    corrected(200, 208),
    approved,
    approved,
    approved,
    corrected(150, 156),
  ]);
  assert.equal(cal.sampleCount, 5);
  assert.equal(cal.medianLfDeltaFt, 0);
  assert.equal(cal.actionable, false);
});

test("calibration: structural blowouts are excluded, not averaged in", () => {
  const cal = computeLabCalibration([
    corrected(200, 80), // lanai-sized removal — structural, excluded
    corrected(200, 203),
    corrected(180, 182),
    corrected(160, 163),
    corrected(240, 242),
    corrected(210, 212),
  ]);
  assert.equal(cal.excludedCount, 1);
  assert.equal(cal.sampleCount, 5);
  assert.ok(cal.medianLfDeltaFt > 0);
});

test("calibration: negative (over-draw) bias reports a negative median", () => {
  const cal = computeLabCalibration([
    corrected(200, 197),
    corrected(150, 148),
    corrected(300, 296),
    corrected(180, 177),
    corrected(220, 218),
  ]);
  assert.equal(cal.actionable, true);
  assert.ok(cal.medianLfDeltaFt < 0);
});
