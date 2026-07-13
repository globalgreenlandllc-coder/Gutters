/**
 * Pure node tests for the multi-tier downgrade in assessSatelliteTrace.
 * Run with: npx tsx --test lib/ai/trace-quality.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessSatelliteTrace } from "./trace-quality.ts";
import type { EditableLine } from "@/lib/types";

// A trace that scores a clean "ok": all points inside the footprint bbox,
// LF-to-√area ratio 180/√3600 = 3 (zero penalty band).
const okEaves: EditableLine[] = [
  { id: "e1", kind: "eave", points: [{ x: 100, y: 100 }, { x: 300, y: 100 }] },
  { id: "e2", kind: "eave", points: [{ x: 300, y: 100 }, { x: 300, y: 300 }] },
];
const okArgs = {
  source: "ai" as const,
  eaves: okEaves,
  totalEaveLF: 180,
  footprintAreaFt2: 3600,
  footprintBboxCanvas: { minX: 0, minY: 0, maxX: 900, maxY: 580 },
};

test("no tiers → trace stays 'ok'", () => {
  const q = assessSatelliteTrace({ ...okArgs, interiorTiersDetected: 0 });
  assert.equal(q.status, "ok");
  assert.equal(q.reasons.length, 0);
});

test("interior tiers floor an otherwise-ok trace to 'low' with an add-gutters reason", () => {
  const q = assessSatelliteTrace({ ...okArgs, interiorTiersDetected: 3 });
  assert.equal(q.status, "low");
  assert.ok(q.reasons.some((r) => /tier/i.test(r) && /interior gutter/i.test(r)));
});

test("tiers never rescue an 'unusable' mock trace", () => {
  const q = assessSatelliteTrace({
    source: "mock",
    eaves: [],
    totalEaveLF: 0,
    footprintAreaFt2: null,
    footprintBboxCanvas: null,
    interiorTiersDetected: 5,
  });
  assert.equal(q.status, "unusable");
});

test("tiers never rescue a degenerate (too-short) trace", () => {
  const q = assessSatelliteTrace({
    source: "ai",
    eaves: okEaves,
    totalEaveLF: 3, // below MIN_USABLE_LF
    footprintAreaFt2: 3600,
    footprintBboxCanvas: { minX: 0, minY: 0, maxX: 900, maxY: 580 },
    interiorTiersDetected: 2,
  });
  assert.equal(q.status, "unusable");
});

// --- vision-fallback provenance guardrail (the 6220 Lake Stevens case) ---

test("non-vision trace with the same signals stays 'ok' (no false alarm)", () => {
  const q = assessSatelliteTrace({ ...okArgs, segmentCount: 6 });
  assert.equal(q.status, "ok");
});

test("vision fallback on a SIMPLE roof floors an ok trace to 'low' with a verify reason", () => {
  const q = assessSatelliteTrace({
    ...okArgs,
    segmentCount: 2,
    fromVisionFallback: true,
  });
  assert.equal(q.status, "low");
  assert.ok(q.reasons.some((r) => /vision/i.test(r) && /double-check|verify/i.test(r)));
  assert.ok(q.confidence <= 0.7);
});

test("vision fallback on a COMPLEX roof (>=5 Solar segments) → 'unusable' + draw-it reason", () => {
  const q = assessSatelliteTrace({
    ...okArgs,
    segmentCount: 6,
    fromVisionFallback: true,
  });
  assert.equal(q.status, "unusable");
  assert.ok(q.reasons.some((r) => /draw the outline/i.test(r)));
  assert.ok(q.confidence <= 0.3);
});

test("vision fallback + vision-reported multi-level → 'unusable' even with few segments", () => {
  const q = assessSatelliteTrace({
    ...okArgs,
    segmentCount: 2,
    fromVisionFallback: true,
    roofLevelsMulti: true,
  });
  assert.equal(q.status, "unusable");
});

test("vision fallback + interior tiers → 'unusable' (complex)", () => {
  const q = assessSatelliteTrace({
    ...okArgs,
    segmentCount: 2,
    fromVisionFallback: true,
    interiorTiersDetected: 1,
  });
  assert.equal(q.status, "unusable");
});

test("vision flag never rescues a mock/degenerate trace back up", () => {
  const q = assessSatelliteTrace({
    source: "mock",
    eaves: [],
    totalEaveLF: 0,
    footprintAreaFt2: null,
    footprintBboxCanvas: null,
    fromVisionFallback: true,
    segmentCount: 2, // simple → would be "low", must stay "unusable"
  });
  assert.equal(q.status, "unusable");
});

test("coarse Solar-segment footprint downgrades 'ok' → 'low' with a verify nudge (cardinal roof; inflated case is escalated by the caller)", () => {
  const q = assessSatelliteTrace({ ...okArgs, interiorTiersDetected: 0, coarseFootprint: true });
  assert.equal(q.status, "low");
  assert.ok(
    q.reasons.some((r) => /roof-plane data/i.test(r) && /check the edges/i.test(r)),
    "explains the coarse plane-box outline and says to verify",
  );
});
