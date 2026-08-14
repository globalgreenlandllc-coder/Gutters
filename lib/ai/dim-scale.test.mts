import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crossCheckScaleAgainstOveralls,
  anchorSolvedScale,
  findDimSpanCandidates,
} from "./dim-scale.ts";

// 1152×918 pt outline. At the TRUE 18 pt/ft (1/4"=1'-0") that is 64×51 ft —
// matching the sheet's printed "64'-0"" overall.
const outline = [
  { x: 0, y: 0 },
  { x: 1152, y: 0 },
  { x: 1152, y: 918 },
  { x: 0, y: 918 },
];
const dims = [`64'-0"`, `51'-0"`, `24'-6"`, `12'-0"`];

test("crossCheckScaleAgainstOveralls: correct solve is consistent with the printed overall", () => {
  const r = crossCheckScaleAgainstOveralls(18, outline, dims);
  assert.equal(r.checked, true);
  assert.equal(r.consistent, true);
  assert.equal(r.bestOverallFt, 64);
});

test("crossCheckScaleAgainstOveralls: an inflated solve (wrong printed value read) is flagged", () => {
  // 23.27 pt/ft on the same outline reads 49.5 ft where the sheet prints 64'.
  const r = crossCheckScaleAgainstOveralls(23.27, outline, dims);
  assert.equal(r.checked, true);
  assert.equal(r.consistent, false);
  assert.ok(Math.abs(r.impliedWFt - 49.5) < 0.2);
  assert.ok((r.mismatchPct ?? 0) >= 15);
});

test("crossCheckScaleAgainstOveralls: no building-sized dims → unchecked, never flags", () => {
  const r = crossCheckScaleAgainstOveralls(18, outline, [`4'-0"`, `3:12`]);
  assert.equal(r.checked, false);
  assert.equal(r.consistent, true);
});

// ---------------------------------------------------------------------------
// anchorSolvedScale — the post-solve standard-scale anchor gate.
// ---------------------------------------------------------------------------

// Woodinville-shaped roof outline: ~1222×~1030 pt. At the true 18 pt/ft
// (1/4"=1') that is 67.9×57.2 ft — the printed 64' overall + roof overhang.
const roofOutline = [
  { x: 0, y: 0 },
  { x: 1222, y: 0 },
  { x: 1222, y: 1030 },
  { x: 0, y: 1030 },
];

test("anchorSolvedScale: Woodinville — 23.27 solve fails the 64' anchor, exactly one standard scale (18) passes → corrected", () => {
  const r = anchorSolvedScale(23.27, roofOutline, [64, 51]);
  assert.equal(r.checked, true);
  assert.equal(r.verdict, "corrected");
  assert.equal(r.ptPerFt, 18);
  assert.equal(r.anchorFt, 64);
  assert.ok(Math.abs((r.solvedLongFt ?? 0) - 52.5) < 0.2); // what 23.27 reads
  assert.ok(Math.abs((r.correctedLongFt ?? 0) - 67.9) < 0.2);
  assert.deepEqual(r.anchoredStandards, [18]);
});

test("anchorSolvedScale: correct solve (18) is anchored → kept, no correction", () => {
  const r = anchorSolvedScale(18, roofOutline, [64, 51]);
  assert.equal(r.checked, true);
  assert.equal(r.verdict, "kept");
  assert.equal(r.ptPerFt, 18);
});

test("anchorSolvedScale: NO dim reads → unchecked, solve untouched", () => {
  const r = anchorSolvedScale(23.27, roofOutline, []);
  assert.equal(r.checked, false);
  assert.equal(r.verdict, "kept");
  assert.equal(r.ptPerFt, 23.27);
  const r2 = anchorSolvedScale(23.27, roofOutline, [null, null]);
  assert.equal(r2.checked, false);
  assert.equal(r2.ptPerFt, 23.27);
});

test("anchorSolvedScale: unusual-but-right solve stays kept (1/6\" sheet at 12 pt/ft)", () => {
  // 800×600 pt at 12 pt/ft = 66.7×50 ft — matches the printed 64' overall.
  const small = [
    { x: 0, y: 0 },
    { x: 800, y: 0 },
    { x: 800, y: 600 },
    { x: 0, y: 600 },
  ];
  const r = anchorSolvedScale(12, small, [64, 51]);
  assert.equal(r.verdict, "kept");
  assert.equal(r.ptPerFt, 12);
});

test("anchorSolvedScale: zero standard scales anchored → solve KEPT + flagged (unanchored)", () => {
  // 1000×990 pt, anchor 64': solved 20 reads 50 ft (fails); no standard
  // scale lands within 12% of 64' on EITHER axis (18 → 55.6/55.0, 13.5 →
  // 74.1/73.3, …) — nothing fits.
  const odd = [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 990 },
    { x: 0, y: 990 },
  ];
  const r = anchorSolvedScale(20, odd, [64, 51]);
  assert.equal(r.checked, true);
  assert.equal(r.verdict, "unanchored");
  assert.equal(r.ptPerFt, 20); // never mutates on a murky verdict
  assert.deepEqual(r.anchoredStandards, []);
});

test("anchorSolvedScale: multiple standards anchored → solve KEPT + flagged (ambiguous)", () => {
  // 1626 pt long axis, anchor 64': both 27 (60.2 ft) and 24 (67.8 ft) land
  // within 12% — ambiguity always keeps the solve.
  const two = [
    { x: 0, y: 0 },
    { x: 1626, y: 0 },
    { x: 1626, y: 1300 },
    { x: 0, y: 1300 },
  ];
  const r = anchorSolvedScale(10, two, [64]);
  assert.equal(r.verdict, "ambiguous");
  assert.equal(r.ptPerFt, 10);
  assert.deepEqual(r.anchoredStandards, [27, 24]);
});

test("anchorSolvedScale: multiple anchored standards are NEVER narrowed to a correction (tie-break removed)", () => {
  // The old short-axis tie-break converted this ambiguity into a false
  // correction (27) — two plausible standards must keep the solve + flag.
  const two = [
    { x: 0, y: 0 },
    { x: 1626, y: 0 },
    { x: 1626, y: 1377 },
    { x: 0, y: 1377 },
  ];
  const r = anchorSolvedScale(10, two, [64, 51]);
  assert.equal(r.verdict, "ambiguous");
  assert.equal(r.ptPerFt, 10);
  assert.deepEqual(r.anchoredStandards, [27, 24]);
});

// —— Anchor-eligibility regressions (adversarial findings): a read the solve
// itself rejected, or a tick-to-tick SUB-SPAN chip, must never anchor. ——

// 64'×51' rectangle at the TRUE 18 pt/ft — wall bbox 1152×918 pt.
const rect18 = [
  { x: 0, y: 0 },
  { x: 1152, y: 0 },
  { x: 1152, y: 918 },
  { x: 0, y: 918 },
];

test("anchorSolvedScale: a lone sub-span chip read (16 ft garage door) can never anchor — correct solve untouched", () => {
  // Vision nulled every overall and read one 288-pt tick sub-span as 16 ft;
  // the solve (288/16 = 18) is CORRECT. Blind max-read anchoring corrected
  // this to 72 pt/ft (LF ÷4).
  const r = anchorSolvedScale(18, rect18, [
    { feet: null, spanPt: 1152, axis: "h" },
    { feet: null, spanPt: 918, axis: "v" },
    { feet: 16, spanPt: 288, axis: "h" },
  ]);
  assert.equal(r.checked, false, "no eligible overall read — nothing to check");
  assert.equal(r.ptPerFt, 18);
});

test("anchorSolvedScale: a bare small read (<24 ft) can never anchor even without chip spans", () => {
  const r = anchorSolvedScale(18, rect18, [null, null, 16]);
  assert.equal(r.checked, false);
  assert.equal(r.ptPerFt, 18);
});

test("anchorSolvedScale: a misread sub-span chip (10'-4\" read as 104) cannot overturn true overalls", () => {
  // 64/51 are true full-rail overalls corroborating 18 exactly; 104 is one
  // misread 186-pt sub-span chip the solve's outlier filter rejected. Blind
  // max-read anchoring crowned 104 → corrected to 12 (LF ×1.5).
  const r = anchorSolvedScale(18, rect18, [
    { feet: 64, spanPt: 1152, axis: "h" },
    { feet: 51, spanPt: 918, axis: "v" },
    { feet: 104, spanPt: 186, axis: "h" },
  ]);
  assert.equal(r.checked, true);
  assert.equal(r.verdict, "kept");
  assert.equal(r.ptPerFt, 18);
});

test("anchorSolvedScale: a single short-axis overall (51') keeps a correct solve — either bbox axis may anchor", () => {
  // Only the depth overall read; it matches the bbox SHORT axis at 18.
  const r = anchorSolvedScale(18, rect18, [{ feet: 51, spanPt: 918, axis: "v" }]);
  assert.equal(r.verdict, "kept");
  assert.equal(r.ptPerFt, 18);
});

test("anchorSolvedScale: Woodinville PRICED outline (projections stretch the depth axis) still corrects 23.27 → 18", () => {
  // The real priced outline: 1304.6 (depth incl. rear patio + entry porch)
  // × 1235.2 pt. At 18 the WIDTH axis reads 68.6 ft ≈ the printed 64'
  // overall; the long axis alone matches nothing (72.5 ft vs 64 = 13.3%).
  const priced = [
    { x: 0, y: 0 },
    { x: 1235.2, y: 0 },
    { x: 1235.2, y: 1304.6 },
    { x: 0, y: 1304.6 },
  ];
  const r = anchorSolvedScale(23.27, priced, [64, 51]);
  assert.equal(r.verdict, "corrected");
  assert.equal(r.ptPerFt, 18);
});

test("anchorSolvedScale: overall missing + sub-span reads (true 18, reads {51,32,24,22,20}) → ambiguous, solve KEPT", () => {
  // The e2e DANGER case: without the 64' read the gate used to 'correct' a
  // TRUE 18 to 24 (LF −25%). Sub-span chips are ineligible; the 51' rail
  // anchors [27, 24] — ambiguous keeps the solve.
  const priced = [
    { x: 0, y: 0 },
    { x: 1235.2, y: 0 },
    { x: 1235.2, y: 1304.6 },
    { x: 0, y: 1304.6 },
  ];
  const r = anchorSolvedScale(18, priced, [
    { feet: 51, spanPt: 1187, axis: "v" },
    { feet: 32, spanPt: 576, axis: "v" },
    { feet: 24, spanPt: 432, axis: "v" },
    { feet: 22, spanPt: 396, axis: "h" },
    { feet: 20, spanPt: 360, axis: "h" },
  ]);
  assert.equal(r.verdict, "ambiguous");
  assert.equal(r.ptPerFt, 18);
});

// ---------------------------------------------------------------------------
// findDimSpanCandidates — tick-to-tick sub-span splitting.
// ---------------------------------------------------------------------------

// 1152×918 pt outline (64×51 ft at 18 pt/ft), dimension rail below it.
const RAIL = [0, 980, 1152, 980, 0.3];
const tickAt = (x: number) => [x, 968, x, 992, 0.3];

test("findDimSpanCandidates: tick crossings split a merged chain rail into sub-span chips (full rail kept)", () => {
  const segs = [
    RAIL,
    tickAt(400),
    tickAt(700),
    // wall stroke inside the building — heavy tier, never a tick
    [0, 450, 1152, 450, 1.44],
  ];
  const dims = findDimSpanCandidates(segs, outline);
  // D1 = the full rail; D2..D4 = the 452/400/300 pt tick-to-tick sub-spans.
  assert.equal(dims.length, 4);
  assert.ok(Math.abs(dims[0].spanPt - 1152) < 2);
  const subSpans = dims.slice(1).map((d) => Math.round(d.spanPt)).sort((a, b) => a - b);
  assert.deepEqual(subSpans, [300, 400, 452]);
  for (const d of dims) {
    assert.equal(d.axis, "h");
    assert.ok(Math.abs(d.p1.y - 980) < 1);
  }
});

test("findDimSpanCandidates: a rail with no tick crossings stays a single chip", () => {
  const dims = findDimSpanCandidates([RAIL], outline);
  assert.equal(dims.length, 1);
  assert.ok(Math.abs(dims[0].spanPt - 1152) < 2);
});

test("findDimSpanCandidates: sub-spans below building scale are dropped", () => {
  // A tick 30 pt from the rail end makes a 30-pt sliver — not a building dim.
  const segs = [RAIL, tickAt(30), tickAt(400), tickAt(700)];
  const dims = findDimSpanCandidates(segs, outline);
  assert.ok(dims.every((d) => d.spanPt > 50), "no sliver chips");
  const spans = dims.map((d) => Math.round(d.spanPt)).sort((a, b) => a - b);
  assert.deepEqual(spans, [300, 370, 452, 1152]);
});
