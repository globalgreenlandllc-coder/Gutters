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
