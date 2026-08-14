/**
 * Pure node tests for the blueprint best-of geometry-quality gate. Run:
 *   npx tsx --test lib/ai/blueprint-trace-quality.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  geometryQualityPenalty,
  footprintPerimeterFt,
  eaveLfFt,
} from "./blueprint-trace-quality.ts";
import type { BlueprintAnalysis } from "./blueprint-from-plans.ts";

// A 1000×400 px rectangle → 2800 px perimeter. Runs carry length_ft at a
// consistent 0.1 ft/px, so perimeter = 280 ft.
const RECT = [
  { x: 0, y: 0 },
  { x: 1000, y: 0 },
  { x: 1000, y: 400 },
  { x: 0, y: 400 },
];
function run(ax: number, ay: number, bx: number, by: number, lenFt: number) {
  return { start: { x: ax, y: ay }, end: { x: bx, y: by }, length_ft: lenFt };
}
function analysis(footprint: { x: number; y: number }[], runs: unknown[]): BlueprintAnalysis {
  return { building_footprint: footprint, gutter_runs: runs } as unknown as BlueprintAnalysis;
}

test("perimeter is computed in feet from the trace's own scale", () => {
  const a = analysis(RECT, [run(0, 0, 1000, 0, 100)]); // 1000 px → 100 ft ⇒ 0.1 ft/px
  assert.equal(Math.round(footprintPerimeterFt(a) ?? 0), 280);
});

test("a HEALTHY trace (78% of perimeter guttered) gets no penalty", () => {
  // eave LF 218 / perim 280 = 0.78.
  const a = analysis(RECT, [
    run(0, 0, 1000, 0, 100),
    run(0, 400, 1000, 400, 100),
    run(0, 0, 180, 0, 18),
  ]);
  assert.equal(Math.round(eaveLfFt(a)), 218);
  assert.equal(geometryQualityPenalty(a), 0);
});

test("an UNDER-trace (37% of perimeter) is demoted hard — the 120-on-326 case", () => {
  // eave LF 100 / perim 280 = 0.36 (mirrors 120 LF on a 326 ft perimeter).
  const under = analysis(RECT, [run(0, 0, 1000, 0, 100)]);
  const healthy = analysis(RECT, [
    run(0, 0, 1000, 0, 100),
    run(0, 400, 1000, 400, 100),
    run(0, 0, 180, 0, 18),
  ]);
  const pUnder = geometryQualityPenalty(under);
  assert.ok(pUnder > 25, `under-trace penalty should be steep, got ${pUnder}`);
  // The whole point of #2a: the under-trace scores strictly worse.
  assert.ok(pUnder > geometryQualityPenalty(healthy));
});

test("a legitimately gable-dominant trace (~58% of perimeter) is NOT penalized", () => {
  // eave LF 163 / perim 280 = 0.58 (the true ~190-on-326 ratio) — above the
  // 0.5 floor, so #2a leaves it alone (picking it over an over-trace is #2b).
  const a = analysis(RECT, [
    run(0, 0, 1000, 0, 100),
    run(0, 400, 630, 400, 63),
  ]);
  assert.equal(geometryQualityPenalty(a), 0);
});

// ── round-5: run-scale dispersion — runs disagreeing with each other on ft/px ─

test("a trace whose runs disagree on ft/px is demoted; the single-scale sibling wins", () => {
  // Two runs at 0.1 ft/px + one 400 px run priced 56 ft (0.14 ft/px — 40%
  // hot, the 1168G "g14 prices 30% hotter per pixel" class). Coverage and
  // shape are healthy, so ONLY dispersion separates the siblings.
  const hot = analysis(RECT, [
    run(0, 0, 1000, 0, 100),
    run(0, 400, 1000, 400, 100),
    run(0, 0, 0, 400, 56), // 400 px → 56 ft: internally inconsistent
  ]);
  const consistent = analysis(RECT, [
    run(0, 0, 1000, 0, 100),
    run(0, 400, 1000, 400, 100),
    run(0, 0, 0, 400, 40), // 400 px → 40 ft: same 0.1 ft/px as the rest
  ]);
  const pHot = geometryQualityPenalty(hot);
  const pConsistent = geometryQualityPenalty(consistent);
  assert.equal(pConsistent, 0, "single-scale trace pays nothing");
  assert.ok(pHot >= 10, `dispersion penalty should bite, got ${pHot}`);
});

test("dispersion is scale-LABEL-agnostic — a uniformly mislabeled scale pays nothing", () => {
  // Every run at a (wrong but uniform) 0.2 ft/px: absolute scale errors are
  // the area gate's job; dispersion must stay silent.
  const uniform = analysis(RECT, [
    run(0, 0, 1000, 0, 200),
    run(0, 400, 1000, 400, 200),
    run(0, 0, 0, 400, 80),
  ]);
  assert.equal(geometryQualityPenalty(uniform), 0);
});

test("a self-intersecting (bow-tie) footprint is fatally demoted", () => {
  const bowtie = [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
    { x: 100, y: 0 },
    { x: 0, y: 100 },
  ];
  const a = analysis(bowtie, [run(0, 0, 100, 0, 10)]);
  assert.equal(geometryQualityPenalty(a), 40);
});

// ── round-4: rectilinearity — a diagonal-heavy roll loses to a clean sibling ─

test("a diagonal-heavy trace of square geometry is demoted; the clean sibling wins", () => {
  // ~38% of this ring's perimeter is diagonal (the bad 1168G roll shape class).
  const arrow = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 700, y: 300 },
    { x: 400, y: 600 },
    { x: 0, y: 600 },
  ];
  // Healthy runs on both (≈62% of perimeter guttered → checks 2/3 quiet).
  const arrowRuns = [
    run(0, 0, 400, 0, 40),
    run(0, 600, 400, 600, 40),
    run(0, 0, 0, 600, 60),
  ];
  const diag = geometryQualityPenalty(analysis(arrow, arrowRuns));
  const cleanRuns = [
    run(0, 0, 1000, 0, 100),
    run(0, 400, 1000, 400, 100),
    run(0, 0, 0, 400, 40),
  ];
  const clean = geometryQualityPenalty(analysis(RECT, cleanRuns));
  assert.equal(clean, 0);
  assert.ok(diag >= 15, `diagonal-heavy penalty ${diag}`);
});

test("a small clipped corner (≤10% off-axis) pays no rectilinearity penalty", () => {
  const clipped = [
    { x: 0, y: 0 },
    { x: 950, y: 0 },
    { x: 1000, y: 50 },
    { x: 1000, y: 400 },
    { x: 0, y: 400 },
  ];
  const runs = [
    run(0, 0, 950, 0, 95),
    run(0, 400, 1000, 400, 100),
    run(0, 0, 0, 400, 40),
  ];
  assert.equal(geometryQualityPenalty(analysis(clipped, runs)), 0);
});
