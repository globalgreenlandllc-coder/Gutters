/**
 * Pure node tests for the raster-plan takeoff rectifier. Run:
 *   npx tsx --test lib/ai/rectify-plan-takeoff.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rectifyPlanFootprint, type RPt } from "./rectify-plan-takeoff.ts";

const area = (pts: RPt[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

/** Distance from p to the closed ring (min over all edges). */
function distToRing(p: RPt, ring: RPt[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/** How far off horizontal/vertical the worst edge is, in degrees. */
function worstAxisDeg(pts: RPt[]): number {
  let worst = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const ang = (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
    worst = Math.max(worst, Math.min(ang, 90 - ang));
  }
  return worst;
}

test("the 1168G failure: one wall traced 6° off squares to true horizontal", () => {
  // A rectangular house whose BACK wall (top edge) was traced slanting down
  // ~6° left-to-right — the exact defect the raster trace produced.
  const footprint: RPt[] = [
    { x: 0, y: 0 }, // top-left
    { x: 960, y: 100 }, // top-right — should be y≈0, traced 100px low
    { x: 960, y: 800 }, // bottom-right
    { x: 0, y: 800 }, // bottom-left
  ];
  // A gutter run along that back wall, in the same skewed space.
  const backRun = { start: { x: 0, y: 0 }, end: { x: 960, y: 100 } };
  // A downspout the model floated well inside the roof instead of on an eave.
  const strayDs = { x: 500, y: 250 };
  const followers = [backRun.start, backRun.end, strayDs];

  const r = rectifyPlanFootprint(footprint, followers);
  assert.equal(r.applied, true, r.reason);

  // Every wall is now axis-aligned.
  assert.ok(worstAxisDeg(r.footprint) < 0.01, `worst edge ${worstAxisDeg(r.footprint)}°`);

  // The back run's endpoints now share a y → the run is horizontal.
  const [ns, ne] = r.followers;
  assert.ok(Math.abs(ns.y - ne.y) < 0.5, `back run not level: ${ns.y} vs ${ne.y}`);

  // The stray downspout snapped onto the perimeter (some wall), not floating.
  const ds = r.followers[2];
  assert.ok(distToRing(ds, r.footprint) < 0.5, `downspout still floating at (${ds.x}, ${ds.y})`);

  // Area barely moved — cleaned, not reshaped.
  assert.ok(Math.abs(area(r.footprint) - area(footprint)) / area(footprint) < 0.1);
});

test("an L-shaped jog with a skewed wall keeps its jog and squares up", () => {
  const footprint: RPt[] = [
    { x: 0, y: 0 },
    { x: 600, y: 20 }, // slightly skewed top
    { x: 600, y: 400 },
    { x: 1000, y: 400 },
    { x: 1000, y: 800 },
    { x: 0, y: 800 },
  ];
  const r = rectifyPlanFootprint(footprint, []);
  assert.equal(r.applied, true, r.reason);
  assert.ok(worstAxisDeg(r.footprint) < 0.01);
  // Still an articulated 6-corner L (jog preserved, not flattened to a box).
  assert.equal(r.footprint.length, 6);
});

test("a genuinely diagonal roof is LEFT UNCHANGED (no false squaring)", () => {
  // A house with a real 35° angled wing — squaring would destroy it.
  const footprint: RPt[] = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 700, y: 300 }, // 45° diagonal wall
    { x: 700, y: 600 },
    { x: 0, y: 600 },
  ];
  const r = rectifyPlanFootprint(footprint, []);
  assert.equal(r.applied, false);
  assert.deepEqual(r.footprint, footprint);
});

test("a rotated-in-frame rectangle (whole trace tilted 10°) still squares", () => {
  // The entire footprint is tilted 10° — dominant orientation is 10°, and
  // squaring in that frame yields a clean (tilted) rectangle. This is the
  // Manhattan case: all walls parallel/perpendicular, just rotated.
  const base: RPt[] = [
    { x: 0, y: 0 },
    { x: 800, y: 0 },
    { x: 800, y: 500 },
    { x: 0, y: 500 },
  ];
  const t = (10 * Math.PI) / 180;
  const tilted = base.map((p) => ({
    x: p.x * Math.cos(t) - p.y * Math.sin(t),
    y: p.x * Math.sin(t) + p.y * Math.cos(t),
  }));
  // Add small jitter so it's not already perfect.
  tilted[1].x += 6;
  tilted[1].y -= 4;
  const r = rectifyPlanFootprint(tilted, []);
  assert.equal(r.applied, true, r.reason);
  // In the 10° frame the corners are right angles again — check via dominant
  // frame: opposite edges parallel, adjacent perpendicular.
  assert.equal(r.footprint.length, 4);
});

test("clean rectangle stays a clean rectangle (idempotent, no drift)", () => {
  const footprint: RPt[] = [
    { x: 0, y: 0 },
    { x: 800, y: 0 },
    { x: 800, y: 500 },
    { x: 0, y: 500 },
  ];
  const r = rectifyPlanFootprint(footprint, [{ x: 400, y: 0 }]);
  assert.equal(r.applied, true, r.reason);
  assert.ok(Math.abs(area(r.footprint) - area(footprint)) < 1);
  // The follower on the top wall stays on the top wall.
  assert.ok(Math.abs(r.followers[0].y - 0) < 0.5);
});

test("fewer than 4 corners → passthrough, never throws", () => {
  const tri: RPt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 50, y: 80 },
  ];
  const r = rectifyPlanFootprint(tri, [{ x: 1, y: 1 }]);
  assert.equal(r.applied, false);
  assert.deepEqual(r.footprint, tri);
  assert.deepEqual(r.followers, [{ x: 1, y: 1 }]);
});

test("non-finite input → passthrough, never throws", () => {
  const bad: RPt[] = [
    { x: 0, y: 0 },
    { x: NaN, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const r = rectifyPlanFootprint(bad, []);
  assert.equal(r.applied, false);
});

// ── auditNotches — deep-notch flag-not-carve (the 1168G phantom pocket) ──────
import { auditNotches } from "./rectify-plan-takeoff.ts";

test("auditNotches: an 8-ft deep, 8-ft mouth pocket → exactly 1 suspect with its legs", () => {
  // 60×40 ft house (ftPerUnit 1); an 8×8 pocket carved into the top (rear)
  // edge — the 1168G shape: deep AND narrow-mouthed (mouth < 1.5× depth).
  const ring: RPt[] = [
    { x: 0, y: 0 }, { x: 26, y: 0 }, { x: 26, y: 8 }, { x: 34, y: 8 },
    { x: 34, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 },
  ];
  const before = JSON.stringify(ring);
  const suspects = auditNotches(ring, 1);
  assert.equal(suspects.length, 1, "exactly one suspect");
  const s = suspects[0];
  assert.ok(Math.abs(s.depthFt - 8) < 0.2, `depth ≈8 ft, got ${s.depthFt}`);
  assert.ok(Math.abs(s.mouthFt - 8) < 0.2, `mouth ≈8 ft, got ${s.mouthFt}`);
  assert.equal(s.edges.length, 3, "the pocket's three legs are returned");
  assert.deepEqual(s.edgeIndices, [1, 2, 3]);
  assert.equal(s.where, "rear", "pocket located on the top (rear) half");
  assert.equal(JSON.stringify(ring), before, "flag-not-carve: the ring is never mutated");

  // Scale derivation path (median ft/px over the runs, like reconcile-eaves).
  const derived = auditNotches(ring, null, { runs: [{ length_ft: 26, length_px: 26 }] });
  assert.equal(derived.length, 1);
  // No scale at all → the 6-ft threshold is unjudgeable → degrade to none.
  assert.deepEqual(auditNotches(ring, null), []);
});

test("auditNotches ADVERSARIAL: a real 2-ft rear step is NOT flagged", () => {
  // The 1168G rear edge really does step ~2 ft near the outdoor living —
  // flagging it would train the owner to ignore the note.
  const ring: RPt[] = [
    { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 2 }, { x: 60, y: 2 },
    { x: 60, y: 40 }, { x: 0, y: 40 },
  ];
  assert.deepEqual(auditNotches(ring, 1), []);
});

test("auditNotches ADVERSARIAL: a wide shallow recess (12-ft mouth × 4-ft deep) is not a suspect", () => {
  // A recessed entry/porch: wide and shallow — a real architectural feature.
  const ring: RPt[] = [
    { x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 4 }, { x: 36, y: 4 },
    { x: 36, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 },
  ];
  assert.deepEqual(auditNotches(ring, 1), []);
  // …and a deep-but-wide courtyard (20 mouth × 10 deep) is an L/U shape, not
  // a carve: mouth ≥ 1.5× depth keeps it.
  const courtyard: RPt[] = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 40, y: 10 },
    { x: 40, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 },
  ];
  assert.deepEqual(auditNotches(courtyard, 1), []);
});

test("auditNotches: squaring output is unchanged by the audit (audit is pure, read-only)", () => {
  const footprint: RPt[] = [
    { x: 0, y: 0 },
    { x: 960, y: 100 }, // the 1168G skewed wall
    { x: 960, y: 800 },
    { x: 0, y: 800 },
  ];
  const r1 = rectifyPlanFootprint(footprint, [{ x: 500, y: 250 }]);
  assert.equal(r1.applied, true);
  const snapshot = JSON.stringify(r1.footprint);
  auditNotches(r1.footprint, 0.1);
  assert.equal(JSON.stringify(r1.footprint), snapshot, "audit did not mutate the squared ring");
  const r2 = rectifyPlanFootprint(footprint, [{ x: 500, y: 250 }]);
  assert.deepEqual(r2.footprint, r1.footprint, "squaring is deterministic with the audit in play");
  assert.deepEqual(r2.followers, r1.followers);
});
