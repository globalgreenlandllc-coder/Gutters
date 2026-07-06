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
