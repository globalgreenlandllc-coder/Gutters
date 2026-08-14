/**
 * Pure node tests for the RASTER roof-outline extraction. Run:
 *   npx tsx --test lib/ai/raster-outline.test.mts
 *
 * Doctrine under test: strong quality gates; when they fail, behavior is
 * byte-identical (deep-equal pins); when they pass, geometry moves but every
 * run's priced length_ft is untouched. All fixtures are synthetic Uint8Array
 * grayscale bitmaps — no PDF, no network, no vision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  traceRasterOutline,
  scaleAndGate,
  applyRasterOutline,
  nearestOnRing,
  orthogonalizeRing,
  type RasterBitmap,
  type RasterOutlineStash,
} from "./raster-outline.ts";

type Pt = { x: number; y: number };

// ───────────────────────── synthetic bitmap helpers ─────────────────────────

/** White (255) single-channel bitmap. */
function makeBitmap(width: number, height: number): RasterBitmap {
  return { data: new Uint8Array(width * height).fill(255), width, height, channels: 1 };
}

function putPx(bm: RasterBitmap, x: number, y: number, v: number) {
  if (x < 0 || y < 0 || x >= bm.width || y >= bm.height) return;
  (bm.data as Uint8Array)[y * bm.width + x] = v;
}

/** Thick Bresenham-ish line (axis-aligned or diagonal). */
function drawLine(bm: RasterBitmap, x0: number, y0: number, x1: number, y1: number, v = 0, thick = 3) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  const r = Math.floor(thick / 2);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) putPx(bm, x + dx, y + dy, v);
  }
}

/** Stroke a closed polygon. */
function strokePoly(bm: RasterBitmap, pts: Pt[], v = 0, thick = 3) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    drawLine(bm, a.x, a.y, b.x, b.y, v, thick);
  }
}

/** Hollow rectangle stroke (the sheet frame). */
function strokeRect(bm: RasterBitmap, x0: number, y0: number, x1: number, y1: number, v = 0, thick = 3) {
  strokePoly(bm, [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ], v, thick);
}

/** The reference roof outline used across fixtures: an 8-corner rectilinear
 *  ring with TWO jogs (a top step-out and a bottom-left step-in). Drawn in a
 *  400×300 sheet; bbox (60,60)–(340,240). */
const ROOF: Pt[] = [
  { x: 60, y: 60 },
  { x: 200, y: 60 },
  { x: 200, y: 90 },
  { x: 340, y: 90 },
  { x: 340, y: 240 },
  { x: 120, y: 240 },
  { x: 120, y: 200 },
  { x: 60, y: 200 },
];

function roofSheet(): RasterBitmap {
  const bm = makeBitmap(400, 300);
  strokePoly(bm, ROOF, 0, 3);
  return bm;
}

const bboxOf = (pts: Pt[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
};

const hasCornerNear = (ring: Pt[], c: Pt, tol: number) =>
  ring.some((p) => Math.hypot(p.x - c.x, p.y - c.y) <= tol);

const distToRing = (ring: Pt[], p: Pt) => {
  const q = nearestOnRing(ring, p);
  return Math.hypot(p.x - q.x, p.y - q.y);
};

// ───────────────────────────── traceRasterOutline ───────────────────────────

test("recovers a jogged outline; sheet frame, interior clutter and outside speckles are ignored", () => {
  const bm = roofSheet();
  // Sheet frame just inside the border — must be dropped (border band).
  strokeRect(bm, 5, 5, 394, 294, 0, 3);
  // Interior clutter connected to the outline (ridge + valley strokes).
  drawLine(bm, 60, 150, 340, 150, 0, 3);
  drawLine(bm, 200, 90, 260, 150, 0, 3);
  // Outside speckles (dimension-tick debris) — smaller components.
  for (const [sx, sy] of [[30, 270], [370, 40], [30, 40], [365, 270], [230, 30]]) {
    drawLine(bm, sx, sy, sx + 4, sy + 4, 0, 3);
  }

  const t = traceRasterOutline(bm);
  assert.ok(t, "trace must succeed");
  assert.equal(t.downsampleStride, 1);
  assert.ok(t.closes, "ring must close");
  assert.ok(t.axisFrac >= 0.97, `rectilinear ring expected, got axisFrac=${t.axisFrac}`);

  // The frame (bbox ≈ 5..394) must NOT be the traced component.
  const bb = bboxOf(t.ring);
  assert.ok(Math.abs(bb.x0 - 60) <= 5 && Math.abs(bb.x1 - 340) <= 5, `bbox x ${bb.x0}..${bb.x1}`);
  assert.ok(Math.abs(bb.y0 - 60) <= 5 && Math.abs(bb.y1 - 240) <= 5, `bbox y ${bb.y0}..${bb.y1}`);

  // BOTH jogs survive: every one of the 8 true corners has a ring vertex nearby
  // (outer contour of a 3px stroke sits ~2px outside the centerline).
  for (const c of ROOF) {
    assert.ok(hasCornerNear(t.ring, c, 6), `corner (${c.x},${c.y}) missing from ${JSON.stringify(t.ring)}`);
  }
  assert.ok(t.ring.length >= 8 && t.ring.length <= 14, `corner count ${t.ring.length}`);
  assert.equal(t.quality.corners, t.ring.length);
});

test("a dangling leader line (downspout callout, one free end) doesn't become a fake jog", () => {
  const bm = roofSheet();
  // A callout/leader stub: one end ON the outline (a true corner), the other
  // end FREE in open space — unlike a ridge/valley chord, nothing else is
  // attached to its far tip. This is the shape a downspout leader arrow or a
  // dimension extension line actually draws on a roof-plan sheet.
  drawLine(bm, 340, 90, 300, 40, 0, 3);

  const t = traceRasterOutline(bm);
  assert.ok(t, "trace must succeed");
  assert.ok(t.axisFrac >= 0.9, `dangle must not survive to drag down axisFrac, got ${t.axisFrac}`);
  for (const c of ROOF) {
    assert.ok(hasCornerNear(t.ring, c, 6), `corner (${c.x},${c.y}) missing from ${JSON.stringify(t.ring)}`);
  }
  // No vertex survives near the free tip — the dangle was stripped, not kept
  // as a phantom jog.
  assert.ok(
    !t.ring.some((p) => Math.hypot(p.x - 300, p.y - 40) <= 8),
    `phantom vertex near the leader's free tip: ${JSON.stringify(t.ring)}`,
  );
});

test("light-gray watermark diagonal thresholds away", () => {
  // Mascord-style watermark: light gray (200), corner-to-corner, printed
  // UNDER the ink (drawn first — real ink overprints the watermark). At the
  // default threshold (<128 = ink) it must not register at all — neither as
  // its own component nor by merging the outline into the border.
  const bm = makeBitmap(400, 300);
  drawLine(bm, 0, 0, 399, 299, 200, 5);
  strokePoly(bm, ROOF, 0, 3);
  const t = traceRasterOutline(bm);
  assert.ok(t, "trace must succeed with the watermark present");
  const bb = bboxOf(t.ring);
  assert.ok(Math.abs(bb.x0 - 60) <= 5 && Math.abs(bb.x1 - 340) <= 5);
  // Raising the threshold above the watermark gray makes it ink — an opt.
  const dark = traceRasterOutline(bm, { threshold: 230 });
  // The watermark connects the outline to the border → component dropped →
  // nothing plausible remains (or something much smaller wins). Either way
  // the roof bbox must no longer be reported as a clean trace.
  if (dark) {
    const dbb = bboxOf(dark.ring);
    assert.ok(
      Math.abs(dbb.x0 - 60) > 5 || Math.abs(dbb.x1 - 340) > 5 || !dark.closes || dark.axisFrac < 0.9,
      "threshold=230 must not yield the same clean roof ring",
    );
  }
});

test("noise speckles: largest component wins", () => {
  const bm = roofSheet();
  // Deterministic speckle field (LCG) away from the border band.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 60; i++) {
    const x = 20 + Math.floor(rnd() * 360);
    const y = 20 + Math.floor(rnd() * 260);
    putPx(bm, x, y, 0);
    putPx(bm, x + 1, y, 0);
    putPx(bm, x, y + 1, 0);
  }
  const t = traceRasterOutline(bm);
  assert.ok(t);
  const bb = bboxOf(t.ring);
  assert.ok(Math.abs(bb.x0 - 60) <= 6 && Math.abs(bb.x1 - 340) <= 6, "roof outline must out-vote speckles");
});

test("degenerate inputs return null: blank sheet, open stroke, tiny bitmap", () => {
  assert.equal(traceRasterOutline(makeBitmap(400, 300)), null, "blank sheet");
  const line = makeBitmap(400, 300);
  drawLine(line, 60, 150, 340, 150, 0, 3); // a single open stroke, not a ring
  const t = traceRasterOutline(line);
  // An open stroke traces as a flat out-and-back sliver — either rejected
  // outright (null) or so thin the scale gates must kill it downstream.
  if (t) {
    const g = scaleAndGate(t.ring, [66.5, 48], 66.5 * 48);
    assert.equal(g.ok, false, "an open stroke must never pass the gates");
  }
  assert.equal(traceRasterOutline({ data: new Uint8Array(16), width: 4, height: 4, channels: 1 }), null);
  assert.equal(traceRasterOutline(null), null);
});

test("downsampling: a large sheet strides down and the ring returns in ORIGINAL px", () => {
  // 2000×1500 sheet (stride 2 → 1000 grid), same roof shape scaled 5×.
  const bm = makeBitmap(2000, 1500);
  const roof5 = ROOF.map((p) => ({ x: p.x * 5, y: p.y * 5 }));
  strokePoly(bm, roof5, 0, 7);
  const t = traceRasterOutline(bm);
  assert.ok(t);
  assert.ok(t.downsampleStride >= 2, `stride ${t.downsampleStride}`);
  const bb = bboxOf(t.ring);
  assert.ok(Math.abs(bb.x0 - 300) <= 12 && Math.abs(bb.x1 - 1700) <= 12, `bbox x ${bb.x0}..${bb.x1} in original px`);
  for (const c of roof5) assert.ok(hasCornerNear(t.ring, c, 16), `corner (${c.x},${c.y})`);
});

// ─────────────────────────────── scaleAndGate ───────────────────────────────

/** The ROOF ring itself as a clean traced ring (bbox 280×180 px). */
const CLEAN_RING: Pt[] = ROOF.map((p) => ({ ...p }));

test("scale solve + gates pass on a matching printed overall", () => {
  // 280 px major span anchored to 70 ft → 0.25 ft/px; minor 180 px → 45 ft.
  // Ring area = 280*180 - 140*30 - 60*40 = 43800 px² → 2737.5 sf; box 70×45=3150 → 13% off. OK.
  const g = scaleAndGate(CLEAN_RING, [70, 45], 70 * 45);
  assert.equal(g.ok, true, g.reasons.join("; "));
  assert.ok(Math.abs((g.ftPerPx ?? 0) - 0.25) < 1e-9);
});

test("scale gates fail loudly: depth mismatch, area mismatch, no dims, too-simple, bow-tie, diagonal", () => {
  // Depth cross-check: minor span 45 ft vs printed 30' → ~50% off.
  const depth = scaleAndGate(CLEAN_RING, [70, 30], null);
  assert.equal(depth.ok, false);
  assert.ok(depth.reasons.some((r) => /over the printed 30'/.test(r)), depth.reasons.join("; "));
  // Overhang asymmetry: +10% over the printed wall dim is roof overhang
  // (LEGAL); −10% under is trace-error territory (refused).
  const over10 = scaleAndGate(CLEAN_RING, [70, 45 * (70 / 280) * 0 + 41], null); // minor 45ft vs printed 41' → +9.8% over
  assert.equal(over10.reasons.some((r) => /over the printed/.test(r)), false, "overhang-sized overage passes");
  // The real 1168G case: roof depth 19% over the printed wall depth (2'-6"
  // overhangs + the covered-patio roof extension). Must PASS — the old +18%
  // ceiling threw the exact ink outline away by one percent.
  const over19 = scaleAndGate(CLEAN_RING, [70, 37.8], null); // minor 45ft vs printed 37.8' → +19% over
  assert.equal(over19.reasons.some((r) => /over the printed/.test(r)), false, "overhang + patio-extension overage passes");
  const over35 = scaleAndGate(CLEAN_RING, [70, 33], null); // minor 45ft vs printed 33' → +36% over
  assert.ok(over35.reasons.some((r) => /over the printed 33'/.test(r)), "wild oversize still refused");
  const under10 = scaleAndGate(CLEAN_RING, [70, 50], null); // minor 45ft vs printed 50' → 10% under
  assert.ok(under10.reasons.some((r) => /under the printed 50'/.test(r)), "undersize stays refused");

  // Area gate: stated box wildly larger than the ring.
  const area = scaleAndGate(CLEAN_RING, [70], 70 * 45 * 2);
  assert.equal(area.ok, false);
  assert.ok(area.reasons.some((r) => /stated .* sf box/.test(r)), area.reasons.join("; "));

  // No printed dims at all.
  const none = scaleAndGate(CLEAN_RING, [], null);
  assert.equal(none.ok, false);
  assert.ok(none.reasons.some((r) => /no printed overall dimension/.test(r)));

  // A 4-corner box adds nothing over the trace.
  const box = scaleAndGate(
    [{ x: 0, y: 0 }, { x: 280, y: 0 }, { x: 280, y: 180 }, { x: 0, y: 180 }],
    [70, 45],
    70 * 45,
  );
  assert.equal(box.ok, false);
  assert.ok(box.reasons.some((r) => /too simple/.test(r)));

  // Bow-tie self-intersection.
  const bowtie = scaleAndGate(
    [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: -20, y: 60 }, { x: -20, y: 30 }],
    [70, 45],
    null,
  );
  assert.equal(bowtie.ok, false);
  assert.ok(bowtie.reasons.some((r) => /self-intersects/.test(r)));

  // A genuinely diagonal ring fails the 90% axis gate.
  const diamond = scaleAndGate(
    [
      { x: 100, y: 0 }, { x: 200, y: 100 }, { x: 180, y: 120 }, { x: 100, y: 200 },
      { x: 0, y: 100 }, { x: 20, y: 80 },
    ],
    [70, 45],
    null,
  );
  assert.equal(diamond.ok, false);
  assert.ok(diamond.reasons.some((r) => /axis-aligned/.test(r)), diamond.reasons.join("; "));
});

// ───────────────────────────── applyRasterOutline ───────────────────────────

/** Analysis-space fixture: the trace read the house as a plain 100×64 box
 *  (UNDERSIZED and jog-flattened), runs on its edges at 0.5 ft/unit. */
const TRACE_FP: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 64 },
  { x: 0, y: 64 },
];
const TRACE_RUNS = [
  { id: "r1", start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, length_px: 100, length_ft: 50, tier: "upper" },
  { id: "r2", start: { x: 100, y: 0 }, end: { x: 100, y: 64 }, length_px: 64, length_ft: 32, tier: "upper" },
  { id: "r3", start: { x: 100, y: 64 }, end: { x: 0, y: 64 }, length_px: 100, length_ft: 50, tier: "upper" },
];
const TRACE_EDGES = [{ kind: "rake", start: { x: 0, y: 64 }, end: { x: 0, y: 0 } }];
const TRACE_DS = [{ id: "d1", at: { x: 50, y: -3 } }];

/** The sheet's ink ring in bitmap px: the true jogged outline. At 0.1 ft/px
 *  it is 56×36 ft — the 50×32 ft trace is ~16% undersized per axis. */
const SHEET_RING_PX: Pt[] = [
  { x: 1000, y: 1000 },
  { x: 1280, y: 1000 },
  { x: 1280, y: 1060 },
  { x: 1560, y: 1060 },
  { x: 1560, y: 1360 },
  { x: 1120, y: 1360 },
  { x: 1120, y: 1280 },
  { x: 1000, y: 1280 },
];
const OK_STASH: RasterOutlineStash = {
  ok: true,
  page: 6,
  ring: SHEET_RING_PX,
  ftPerPx: 0.1,
  reasons: [],
};

const cloneInput = () => ({
  footprint: TRACE_FP.map((p) => ({ ...p })),
  runs: TRACE_RUNS.map((r) => ({ ...r, start: { ...r.start }, end: { ...r.end } })),
  excludedEdges: TRACE_EDGES.map((e) => ({ ...e, start: { ...e.start }, end: { ...e.end } })),
  downspouts: TRACE_DS.map((d) => ({ ...d, at: { ...d.at } })),
});

test("apply replaces the footprint at TRUE scale, snaps followers, and never touches length_ft", () => {
  const input = cloneInput();
  const res = applyRasterOutline({ ...input, raster: OK_STASH });
  assert.ok(res.applied, !res.applied ? res.reasons.join("; ") : "");
  if (!res.applied) return;

  // The new footprint is the sheet ring at TRUE size (56 ft / 0.5 ft-per-unit
  // = 112 units wide), anchored at the trace's bbox center (50, 32) — NOT
  // squeezed onto the undersized trace bbox.
  const bb = bboxOf(res.footprint);
  assert.ok(Math.abs(bb.x1 - bb.x0 - 112) < 1e-6, `width ${bb.x1 - bb.x0} units (must be 112, not 100)`);
  assert.ok(Math.abs(bb.y1 - bb.y0 - 72) < 1e-6, `depth ${bb.y1 - bb.y0} units (must be 72, not 64)`);
  assert.ok(Math.abs((bb.x0 + bb.x1) / 2 - 50) < 1e-6 && Math.abs((bb.y0 + bb.y1) / 2 - 32) < 1e-6, "anchored at the trace bbox center");
  assert.equal(res.footprint.length, 8, "both jogs survive");
  assert.equal(res.flip, "none");
  assert.equal(res.ftPerUnit, 0.5);
  // Trace box 1600 sf vs sheet-ink polygon 1752 sf (jogs subtract from the
  // 56×36 bbox) → ~-9%; verdict must read UNDERSIZED (negative).
  assert.ok(res.traceAreaDeltaPct < -5, `traceAreaDeltaPct ${res.traceAreaDeltaPct}`);

  // Followers: every endpoint + the downspout lands ON the new perimeter…
  for (const r of res.runs) {
    assert.ok(distToRing(res.footprint, r.start) < 1e-6, `run ${r.id} start on ring`);
    assert.ok(distToRing(res.footprint, r.end) < 1e-6, `run ${r.id} end on ring`);
  }
  for (const e of res.excludedEdges) {
    assert.ok(distToRing(res.footprint, e.start) < 1e-6 && distToRing(res.footprint, e.end) < 1e-6);
  }
  assert.ok(distToRing(res.footprint, res.downspouts[0].at) < 1e-6, "downspout on ring");
  // …with length_ft byte-identical (priced LF unchanged) and length_px refreshed.
  for (let i = 0; i < res.runs.length; i++) {
    assert.equal(res.runs[i].length_ft, TRACE_RUNS[i].length_ft);
    assert.equal(res.runs[i].tier, TRACE_RUNS[i].tier);
    assert.ok(
      Math.abs(
        (res.runs[i].length_px ?? 0) -
          Math.hypot(res.runs[i].end.x - res.runs[i].start.x, res.runs[i].end.y - res.runs[i].start.y),
      ) < 1e-9,
    );
  }
  // Inputs were not mutated (pure).
  assert.deepEqual(input.footprint, TRACE_FP);
  assert.deepEqual(input.runs, TRACE_RUNS);
});

test("SHEET ORIENTATION WINS — a misoriented trace can never flip the ink outline (flip stays 'none' whenever it passes the gate)", () => {
  // The stash ring is the sheet truth. Feed a mirrored stash: under the old
  // best-flip-vs-trace rule the placement would mirror it back to match the
  // trace — exactly how the upside-down 1168G gemini trace flipped a CORRECT
  // outline. Now "none" wins because it still passes the disagreement gate;
  // the sheet's own front-at-bottom convention is the truth, the trace is not.
  const mirrored = SHEET_RING_PX.map((p) => ({ x: 3000 - p.x, y: p.y }));
  const res = applyRasterOutline({
    ...cloneInput(),
    raster: { ...OK_STASH, ring: mirrored },
  });
  assert.ok(res.applied, !res.applied ? res.reasons.join("; ") : "");
  if (!res.applied) return;
  assert.equal(res.flip, "none", "sheet orientation is authoritative");
});

test("no flip search — a mirror 'none' can't align is REFUSED, never silently re-flipped", () => {
  // A ring the no-flip placement genuinely can't match (tight gate) is
  // refused outright — the swap is skipped and the vision trace kept. The
  // old code would have flipped it to fit; that flip is exactly the bug (a
  // misoriented trace flipping the correct outline), so it's gone.
  const mirrored = SHEET_RING_PX.map((p) => ({ x: 3000 - p.x, y: p.y }));
  const res = applyRasterOutline({
    ...cloneInput(),
    raster: { ...OK_STASH, ring: mirrored },
    maxDisagreementFrac: 0.02, // 'none' on the mirrored ring exceeds this
  });
  assert.equal(res.applied, false, "refused rather than re-flipped");
  if (res.applied) return;
  assert.ok(res.reasons.some((r) => /sheet's own orientation/.test(r)), res.reasons.join("; "));
});

test("apply refuses a ring that resembles the trace in no orientation", () => {
  // A long skinny sliver at true scale — nothing like the 100×64 trace.
  const sliver: Pt[] = [
    { x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 20 }, { x: 2000, y: 20 },
    { x: 2000, y: 40 }, { x: 0, y: 40 },
  ];
  const res = applyRasterOutline({
    ...cloneInput(),
    raster: { ...OK_STASH, ring: sliver },
  });
  assert.equal(res.applied, false);
  if (!res.applied) {
    assert.ok(res.reasons.some((r) => /resemble/.test(r)), res.reasons.join("; "));
  }
});

test("gates-fail path is byte-identical (deep-equal pin) and carries the stored reasons", () => {
  const input = cloneInput();
  const before = JSON.parse(JSON.stringify(input));
  const res = applyRasterOutline({
    ...input,
    raster: { ok: false, page: 6, reasons: ["scaled depth 61.2 ft is 28% off the printed 48' (need ±10%)"] },
  });
  assert.equal(res.applied, false);
  if (!res.applied) {
    assert.deepEqual(res.reasons, ["scaled depth 61.2 ft is 28% off the printed 48' (need ±10%)"]);
  }
  // The caller only writes on applied — but the apply itself must also never
  // have mutated its inputs.
  assert.deepEqual(JSON.parse(JSON.stringify(input)), before);
});

test("apply bails cleanly on missing stash / malformed ring / no usable scale", () => {
  const noStash = applyRasterOutline({ ...cloneInput(), raster: null });
  assert.equal(noStash.applied, false);

  const badRing = applyRasterOutline({
    ...cloneInput(),
    raster: { ...OK_STASH, ring: [{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }, { x: 5, y: 5 }] },
  });
  assert.equal(badRing.applied, false);

  const noScaleRuns = TRACE_RUNS.map((r) => ({ ...r, length_ft: null as number | null }));
  const noScale = applyRasterOutline({
    footprint: TRACE_FP,
    runs: noScaleRuns,
    excludedEdges: [],
    downspouts: [],
    raster: OK_STASH,
  });
  assert.equal(noScale.applied, false);
  if (!noScale.applied) {
    assert.ok(noScale.reasons.some((r) => /no run-derived scale/.test(r)));
  }
  // …but analysis.scale.feet_per_unit rescues it as the fallback.
  const rescued = applyRasterOutline({
    footprint: TRACE_FP,
    runs: noScaleRuns,
    excludedEdges: [],
    downspouts: [],
    raster: OK_STASH,
    scaleFeetPerUnit: 0.5,
  });
  assert.ok(rescued.applied, !rescued.applied ? rescued.reasons.join("; ") : "");
});

// ─────────────────── end-to-end: bitmap → trace → gate → apply ──────────────

test("full pipeline on a synthetic scan lands the sheet shape in analysis space", () => {
  const bm = makeBitmap(800, 600);
  strokeRect(bm, 8, 8, 791, 591, 0, 3); // frame
  const roof2 = ROOF.map((p) => ({ x: p.x * 2, y: p.y * 2 })); // 560×360 px
  strokePoly(bm, roof2, 0, 5);
  const t = traceRasterOutline(bm);
  assert.ok(t);
  // Printed overalls: 70 × 45 ft on a 560 px major span.
  const g = scaleAndGate(t.ring, [70, 45], 70 * 45);
  assert.equal(g.ok, true, g.reasons.join("; "));
  const stash: RasterOutlineStash = { ok: true, page: 3, ring: t.ring, ftPerPx: g.ftPerPx, reasons: [] };
  const res = applyRasterOutline({ ...cloneInput(), raster: stash });
  assert.ok(res.applied, !res.applied ? res.reasons.join("; ") : "");
  if (!res.applied) return;
  // True size: 70 ft / 0.5 ft-per-unit = 140 units wide (± stroke thickness).
  const bb = bboxOf(res.footprint);
  assert.ok(Math.abs(bb.x1 - bb.x0 - 140) < 4, `width ${bb.x1 - bb.x0}`);
  assert.ok(res.footprint.length >= 8, "jogs preserved end-to-end");
});

// ── hip-ink repair: orthogonalizeRing ──────────────────────────────────────

test("orthogonalizeRing: a 45° corner chamfer (hip ink) is replaced by the true corner", () => {
  // 200×120 rectangle whose top-right corner is cut by a 20-px hip diagonal.
  const ring = [
    { x: 0, y: 0 },
    { x: 180, y: 0 },
    { x: 200, y: 20 }, // chamfer — hip ink
    { x: 200, y: 120 },
    { x: 0, y: 120 },
  ];
  const res = orthogonalizeRing(ring);
  assert.equal(res.removedDiagonals, 1);
  assert.deepEqual(res.ring, [
    { x: 200, y: 0 },
    { x: 200, y: 120 },
    { x: 0, y: 120 },
    { x: 0, y: 0 },
  ]);
});

test("orthogonalizeRing: an inward hip V-detour (in-and-out at a corner) collapses to the true corner", () => {
  // The tracer left the top edge early, dove inward along one hip line and
  // came back out along another, then resumed down the right side.
  const ring = [
    { x: 0, y: 0 },
    { x: 170, y: 0 },
    { x: 185, y: 15 }, // hip in
    { x: 200, y: 2 },  // hip back out (near the missed corner)
    { x: 200, y: 120 },
    { x: 0, y: 120 },
  ];
  const res = orthogonalizeRing(ring);
  assert.equal(res.removedDiagonals, 2);
  assert.deepEqual(res.ring, [
    { x: 200, y: 0 },
    { x: 200, y: 120 },
    { x: 0, y: 120 },
    { x: 0, y: 0 },
  ]);
});

test("orthogonalizeRing: a diagonal spanning a whole side between parallel edges gets a mid-span connector", () => {
  // Top edge at y=0, bottom edge at y=120, right side traced as one long
  // slightly-tilted... no — a genuine diagonal connecting the two H edges.
  const ring = [
    { x: 0, y: 0 },
    { x: 195, y: 0 },
    { x: 205, y: 120 }, // whole right side is off-axis ink
    { x: 0, y: 120 },
  ];
  const res = orthogonalizeRing(ring);
  assert.equal(res.removedDiagonals, 0, "an 85°-steep side is ALREADY axis ink (within 20°) — untouched");

  const ring2 = [
    { x: 0, y: 0 },
    { x: 160, y: 0 },
    { x: 240, y: 120 }, // 34° off vertical — hip ink bridging two H edges
    { x: 0, y: 120 },
  ];
  const res2 = orthogonalizeRing(ring2);
  assert.equal(res2.removedDiagonals, 1);
  // Connector at the midpoint x of the removed span (160+240)/2 = 200.
  assert.deepEqual(res2.ring, [
    { x: 200, y: 0 },
    { x: 200, y: 120 },
    { x: 0, y: 120 },
    { x: 0, y: 0 },
  ]);
});

test("orthogonalizeRing: jogs survive the repair (only the diagonal goes)", () => {
  // Rectangle with a real 30×20 inset notch on the top edge AND a chamfered
  // top-right corner: the notch must survive verbatim, the chamfer goes.
  const ring = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 20 },
    { x: 90, y: 20 },
    { x: 90, y: 0 },
    { x: 180, y: 0 },
    { x: 200, y: 20 }, // chamfer
    { x: 200, y: 120 },
    { x: 0, y: 120 },
  ];
  const res = orthogonalizeRing(ring);
  assert.equal(res.removedDiagonals, 1);
  assert.deepEqual(res.ring, [
    { x: 60, y: 0 },
    { x: 60, y: 20 },
    { x: 90, y: 20 },
    { x: 90, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 120 },
    { x: 0, y: 120 },
    { x: 0, y: 0 },
  ]);
});

test("orthogonalizeRing: bails unchanged on a genuinely diagonal shape and on clean rings", () => {
  // Diamond — 100% diagonal perimeter → untouched (existing gates decide).
  const diamond = [
    { x: 100, y: 0 },
    { x: 200, y: 100 },
    { x: 100, y: 200 },
    { x: 0, y: 100 },
  ];
  const d = orthogonalizeRing(diamond);
  assert.equal(d.removedDiagonals, 0);
  assert.deepEqual(d.ring, diamond);

  // Clean rectilinear ring → byte-equal passthrough.
  const clean = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 120 },
    { x: 0, y: 120 },
  ];
  const c = orthogonalizeRing(clean);
  assert.equal(c.removedDiagonals, 0);
  assert.deepEqual(c.ring, clean);
});

test("orthogonalizeRing: an out-and-back NEEDLE is scrubbed; real small jogs survive", () => {
  // Clean rectilinear rectangle with a sub-foot needle poking off the right
  // edge (out to x=203 and straight back to ~the same point) — stray tick
  // ink, never fascia. Span 200 → spurTol = 200×0.006 = 1.2 units.
  const ring = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 60 },
    { x: 203, y: 60 },   // needle out…
    { x: 200, y: 60.5 }, // …and straight back (A ≈ C, ~0.5 apart)
    { x: 200, y: 120 },
    { x: 0, y: 120 },
  ];
  const res = orthogonalizeRing(ring);
  assert.deepEqual(res.ring, [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 60 },
    { x: 200, y: 120 },
    { x: 0, y: 120 },
  ], "the needle collapsed to the clean right edge; every real corner survives");

  // A REAL small jog (a ~3-unit-wide inset with two distinct base corners)
  // must NOT be mistaken for a needle — its bases are 3 units apart, wider
  // than spurTol, so it passes through untouched.
  const smallJog = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 103, y: 60 },
    { x: 103, y: 66 },
    { x: 100, y: 66 },
    { x: 100, y: 120 },
    { x: 0, y: 120 },
  ];
  assert.deepEqual(orthogonalizeRing(smallJog).ring, smallJog, "a real small jog is preserved");

  // The NOTCHED fixture (30×20 inset) is untouched.
  const notched = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 20 },
    { x: 90, y: 20 },
    { x: 90, y: 0 },
    { x: 180, y: 0 },
    { x: 180, y: 120 },
    { x: 0, y: 120 },
  ];
  assert.deepEqual(orthogonalizeRing(notched).ring, notched, "real jogs pass through untouched");
});
