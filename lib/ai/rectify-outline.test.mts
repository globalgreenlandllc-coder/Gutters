/**
 * Pure node tests for the outline rectifier. Run:
 *   npx tsx --test lib/ai/rectify-outline.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rectifyOutline, type RPt } from "./rectify-outline.ts";

/** Rotate points by deg around (cx, cy). */
function rot(pts: RPt[], deg: number, cx = 0, cy = 0): RPt[] {
  const t = (deg * Math.PI) / 180;
  return pts.map((p) => ({
    x: cx + (p.x - cx) * Math.cos(t) - (p.y - cy) * Math.sin(t),
    y: cy + (p.x - cx) * Math.sin(t) + (p.y - cy) * Math.cos(t),
  }));
}

/** Deterministic pseudo-random jitter in [-amp, amp]. */
function jitter(pts: RPt[], amp: number): RPt[] {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648) * 2 - 1;
  };
  return pts.map((p) => ({ x: p.x + rnd() * amp, y: p.y + rnd() * amp }));
}

const area = (pts: RPt[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

/** Max |cos| between consecutive edges — 0 means perfect right angles. */
function worstCorner(pts: RPt[]): number {
  let worst = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const b = pts[i];
    const c = pts[(i + 1) % pts.length];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const cos = Math.abs(((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (l1 * l2));
    worst = Math.max(worst, cos);
  }
  return worst;
}

const RECT: RPt[] = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 120 },
  { x: 0, y: 120 },
];

// An L with a garage jog (like a real footprint).
const L: RPt[] = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 60 },
  { x: 120, y: 60 },
  { x: 120, y: 120 },
  { x: 0, y: 120 },
];

test("a rotated, jittered rectangle snaps back to 4 clean right-angle corners", () => {
  const noisy = jitter(rot(RECT, 17, 100, 60), 3);
  const r = rectifyOutline(noisy, { snapTolPx: 8 });
  assert.ok(r.applied, `applied (got: ${r.reason})`);
  assert.equal(r.points.length, 4, "back to 4 corners");
  assert.ok(worstCorner(r.points) < 0.02, `right angles restored (worst cos ${worstCorner(r.points).toFixed(3)})`);
  assert.ok(Math.abs(area(r.points) - area(RECT)) / area(RECT) < 0.06, "area preserved");
  // Recovered the ~17° dominant orientation (mod 90).
  const a = ((r.angleDeg % 90) + 90) % 90;
  assert.ok(Math.abs(a - 17) < 3, `dominant angle ≈17° (got ${a.toFixed(1)})`);
});

test("a rotated, jittered L keeps its jog (6 corners) with square corners", () => {
  const noisy = jitter(rot(L, 33, 100, 60), 2.5);
  const r = rectifyOutline(noisy, { snapTolPx: 7 });
  assert.ok(r.applied, `applied (got: ${r.reason})`);
  assert.equal(r.points.length, 6, "the jog survives");
  assert.ok(worstCorner(r.points) < 0.02, "square corners");
  assert.ok(Math.abs(area(r.points) - area(L)) / area(L) < 0.06, "area preserved");
});

test("stair-step wobble along one wall merges into the guessed straight line", () => {
  // A rectangle whose top wall zig-zags ±2px every 20px (mask stair-steps).
  const steps: RPt[] = [];
  for (let x = 0; x <= 200; x += 20) steps.push({ x, y: x % 40 === 0 ? 0 : 2 });
  const shape: RPt[] = [...steps, { x: 200, y: 120 }, { x: 0, y: 120 }];
  const r = rectifyOutline(shape, { snapTolPx: 6 });
  assert.ok(r.applied, `applied (got: ${r.reason})`);
  assert.equal(r.points.length, 4, `stair-steps merged (got ${r.points.length} corners)`);
});

test("a genuinely non-rectilinear shape is left UNCHANGED (no false snapping)", () => {
  // A big diagonal wing — nearly half the perimeter off-axis.
  const diag: RPt[] = [
    { x: 0, y: 0 },
    { x: 120, y: 0 },
    { x: 220, y: 90 }, // long diagonal
    { x: 120, y: 180 }, // long diagonal
    { x: 0, y: 180 },
  ];
  const r = rectifyOutline(diag, { snapTolPx: 8 });
  assert.equal(r.applied, false);
  assert.deepEqual(r.points, diag, "input returned untouched");
});

test("degenerate input degrades safely", () => {
  assert.equal(rectifyOutline([], { snapTolPx: 5 }).applied, false);
  assert.equal(rectifyOutline([{ x: 0, y: 0 }, { x: 1, y: 0 }], { snapTolPx: 5 }).applied, false);
  assert.equal(
    rectifyOutline([{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], { snapTolPx: 5 }).applied,
    false,
  );
});

test("closed ring input (first==last) is handled and returned open", () => {
  const closed = [...RECT, { x: 0, y: 0 }];
  const r = rectifyOutline(jitter(rot(closed, 10, 100, 60), 2), { snapTolPx: 7 });
  assert.ok(r.applied);
  assert.equal(r.points.length, 4);
});
