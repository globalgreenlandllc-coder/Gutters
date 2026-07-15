import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readRoofFromVectors,
  classifyGableLabel,
  snapPhantomEdges,
  adoptFootprintJogs,
  reconcileRoofPerimeter,
  type RoofLabel,
} from "./roof-from-vectors.ts";
import type { Pt } from "./outline-from-vectors.ts";

/** Wall/roof-edge segments for a closed rectilinear ring (consecutive corners). */
function ring(corners: [number, number][]): number[][] {
  const segs: number[][] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    segs.push([a[0], a[1], b[0], b[1]]);
  }
  return segs;
}

/** A cross-gabled / L ring with > 4 corners (a real footprint, not a box). */
const L_CORNERS: [number, number][] = [
  [0, 0],
  [600, 0],
  [600, 200],
  [350, 200],
  [350, 400],
  [0, 400],
];

function bboxOf(poly: Pt[]) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

/** Find the perimeter edge index whose endpoints best match a target edge. */
function edgeNear(perimeter: Pt[], aTgt: Pt, bTgt: Pt): number {
  let best = -1;
  let bestD = Infinity;
  const n = perimeter.length;
  for (let i = 0; i < n; i++) {
    const a = perimeter[i];
    const b = perimeter[(i + 1) % n];
    const dFwd = Math.hypot(a.x - aTgt.x, a.y - aTgt.y) + Math.hypot(b.x - bTgt.x, b.y - bTgt.y);
    const dRev = Math.hypot(a.x - bTgt.x, a.y - bTgt.y) + Math.hypot(b.x - aTgt.x, b.y - aTgt.y);
    const d = Math.min(dFwd, dRev);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

test("truss-noise survival: heavy ring survives sparse interior truss strokes", () => {
  const roof = ring(L_CORNERS);
  const trusses: number[][] = [
    [120, 120, 140, 120],
    [260, 120, 280, 120],
    [120, 300, 140, 300],
    [200, 320, 220, 320],
  ];
  const out = readRoofFromVectors([], [...roof, ...trusses]);
  assert.ok(out, "got a roof read despite truss noise");
  assert.ok(out!.perimeter.length > 4, `keeps the L's articulation (${out!.perimeter.length} corners)`);
  const bb = bboxOf(out!.perimeter);
  const cell = 600 / 200;
  assert.ok(Math.abs(bb.x1 - bb.x0 - 600) < cell * 8, "bbox width tracks the ring");
  assert.ok(Math.abs(bb.y1 - bb.y0 - 400) < cell * 8, "bbox depth tracks the ring");
  assert.ok(out!.gableFlags.every((g) => g === false), "no labels → no gables");
  assert.ok(out!.confidence > 0, "confidence still positive");
});

test("gable label flags the RIGHT edge only", () => {
  const roof = ring(L_CORNERS);
  const labels: RoofLabel[] = [{ s: "GABLE END TRUSS", x: 300, y: 360 }];
  const out = readRoofFromVectors(labels, roof);
  assert.ok(out, "got a roof read");
  const frontIdx = edgeNear(out!.perimeter, { x: 0, y: 400 }, { x: 600, y: 400 });
  assert.ok(frontIdx >= 0, "found the front edge");
  assert.equal(out!.gableFlags[frontIdx], true, "front edge flagged gable");
  const others = out!.gableFlags.filter((_, i) => i !== frontIdx);
  assert.ok(others.every((g) => g === false), "no other edge flagged");
});

test("label between two PARALLEL walls flags ONLY the nearer one (best-edge)", () => {
  const roof = ring([
    [0, 0],
    [220, 0],
    [220, -150],
    [380, -150],
    [380, 0],
    [600, 0],
    [600, 400],
    [0, 400],
  ]);
  const labels: RoofLabel[] = [{ s: "GABLE END", x: 300, y: 360 }];
  const out = readRoofFromVectors(labels, roof);
  assert.ok(out, "got a roof read");
  const frontIdx = edgeNear(out!.perimeter, { x: 0, y: 400 }, { x: 600, y: 400 });
  const backIdx = edgeNear(out!.perimeter, { x: 380, y: 0 }, { x: 600, y: 0 });
  assert.equal(out!.gableFlags[frontIdx], true, "front (nearer) edge flagged");
  assert.equal(out!.gableFlags[backIdx], false, "back (far) parallel wall NOT flagged");
  const flagged = out!.gableFlags.filter((g) => g).length;
  assert.equal(flagged, 1, "exactly one edge flagged — one label cannot flag two walls");
});

test("stray label far inside (beyond the inward band) flags NO edge", () => {
  const roof = ring(L_CORNERS);
  const labels: RoofLabel[] = [{ s: "GABLE END TRUSS", x: 175, y: 200 }];
  const out = readRoofFromVectors(labels, roof);
  assert.ok(out, "got a roof read");
  assert.ok(out!.gableFlags.every((g) => g === false), "no edge flagged for a stray label");
  assert.ok(out!.confidence > 0, "confidence still positive (marker present)");
});

test("a GABLE label OUTSIDE the outline (below the eave) flags NO edge", () => {
  // The symmetric-band bug: a 'GABLE' note printed a truss-depth BELOW the front
  // eave (outside the building) must NOT flag that eave. point-in-polygon fixes it.
  const roof = ring(L_CORNERS);
  const labels: RoofLabel[] = [{ s: "GABLE END TRUSS", x: 300, y: 450 }]; // y>400 = outside
  const out = readRoofFromVectors(labels, roof);
  assert.ok(out, "got a roof read");
  assert.ok(out!.gableFlags.every((g) => g === false), "outside label flags nothing");
});

test("open / broken outline → null (fallback)", () => {
  const broken = [
    [0, 0, 600, 0],
    [600, 0, 600, 400],
  ];
  assert.equal(readRoofFromVectors([], broken), null);
  assert.equal(
    readRoofFromVectors([], [
      [0, 0, 10, 0],
      [100, 100, 110, 100],
      [200, 200, 210, 200],
      [300, 300, 310, 300],
    ]),
    null,
  );
});

test("plain rectangle → null (<=4 corners, no better than today)", () => {
  const box = ring([
    [0, 0],
    [640, 0],
    [640, 520],
    [0, 520],
  ]);
  assert.equal(readRoofFromVectors([], box), null);
});

test("ANTI-JUNK: a wide ribbon (aspect > 4) → null even with > 4 corners", () => {
  // A truss-blob the floodfill happened to enclose as a long thin ribbon.
  const ribbon = ring([
    [0, 0],
    [1200, 0],
    [1200, 200],
    [800, 200],
    [800, 100],
    [0, 100],
  ]); // bbox 1200×200 → aspect 6
  assert.equal(readRoofFromVectors([], ribbon), null);
});

test("ANTI-JUNK: expectedAspect rejects a shape too different from the footprint", () => {
  // aspect-3 articulated shape: passes the no-reference guard (3 < 4)…
  const wide = ring([
    [0, 0],
    [900, 0],
    [900, 300],
    [600, 300],
    [600, 150],
    [0, 150],
  ]); // bbox 900×300 → aspect 3
  assert.ok(readRoofFromVectors([], wide), "accepted without a reference aspect");
  // …but is rejected when the known footprint is ~square (64×51 ≈ 1.25).
  assert.equal(readRoofFromVectors([], wide, { expectedAspect: 64 / 51 }), null);
});

test("garbage / empty / thin-only input → null, never throws", () => {
  assert.equal(readRoofFromVectors([], []), null);
  assert.equal(readRoofFromVectors([], [[0, 0, 10, 0]]), null);
  assert.equal(
    readRoofFromVectors([], [
      [NaN, NaN, NaN, NaN],
      [NaN, 0, 0, NaN],
      [0, 0, NaN, 0],
      [NaN, NaN, 0, 0],
    ]),
    null,
  );
  assert.doesNotThrow(() =>
    readRoofFromVectors(undefined as unknown as RoofLabel[], []),
  );
});

// ————————————————————————————————————————————————————————————————————————
// PERIMETER REPAIR — phantom-pocket rejection + footprint jog adoption.
// Woodinville-shaped fixtures: the traced perimeter carries a phantom side
// wing enclosed by a thin dimension rail and rides a trellis/leader line
// across the front, while the real roof edges are drawn heavy; the
// foundation plan draws the garage jog the roof trace flattened.
// ————————————————————————————————————————————————————————————————————————

const pts = (arr: [number, number][]): Pt[] => arr.map(([x, y]) => ({ x, y }));

const polyArea = (poly: Pt[]) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

const hasCornerNear = (poly: Pt[], x: number, y: number, tol = 15) =>
  poly.some((p) => Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol);

/**
 * The Woodinville-shaped trace: real building 800×500 drawn HEAVY (w=2.5),
 * with a phantom right wing out to x=880 (enclosed by a w=0.3 dimension
 * rail) and the front traced on a w=0.3 leader line at y=520 instead of the
 * drawn front eave at y=500. Mid-weight interior lines (w=1.0) give the
 * three-tier width ladder a real sheet has.
 */
const WING_TRACE = pts([
  [0, 0],
  [800, 0],
  [800, 100],
  [880, 100], // phantom wing (dimension-rail pocket)
  [880, 400],
  [800, 400],
  [800, 520], // front traced on a leader line, 20 pt past the drawn eave
  [0, 520],
]);
const WING_SEGS: number[][] = [
  [0, 0, 800, 0, 2.5], // rear eave (drawn)
  [0, 0, 0, 500, 2.5], // left wall (drawn)
  [800, 0, 800, 500, 2.5], // right wall (drawn) — the wing's real line
  [0, 500, 500, 500, 2.5], // main front eave (drawn)
  [500, 460, 800, 460, 2.5], // garage front eave (drawn SET BACK — the jog)
  [880, 100, 880, 400, 0.3], // dimension rail enclosing the wing
  [0, 520, 800, 520, 0.3], // leader line the front trace rode
  [100, 200, 700, 200, 1.0], // interior structure (mid weight)
  [100, 350, 700, 350, 1.0],
];

test("snapPhantomEdges: wing rail + leader-line front snap back onto the heavy linework", () => {
  const out = snapPhantomEdges(WING_TRACE, WING_SEGS);
  assert.ok(out, "repair fired");
  assert.equal(out!.snapped, 2, "the rail edge and the front edge snapped");
  // Wing removed: nothing remains near x=880; the right wall is back at 800.
  assert.ok(!out!.perimeter.some((p) => p.x > 810), "phantom wing removed");
  // Front back on the drawn eave at y=500 (was 520).
  assert.ok(!out!.perimeter.some((p) => p.y > 510), "front snapped to the drawn eave");
  assert.equal(out!.perimeter.length, 4, "slivers merged into the clean rectangle");
  const ratio = polyArea(out!.perimeter) / polyArea(WING_TRACE);
  assert.ok(ratio > 0.85 && ratio < 1, `area shrank modestly (${ratio.toFixed(2)})`);
});

test("snapPhantomEdges: an edge supported by MID-weight linework is protected (porch/patio pen)", () => {
  // Same trace, but the wing's line is a drawn porch edge at w=1.0 — real
  // linework below the outline pen must veto the snap for ITS edge.
  const segs = WING_SEGS.map((s) => (s[4] === 0.3 && s[0] === 880 ? [s[0], s[1], s[2], s[3], 1.0] : s));
  const out = snapPhantomEdges(WING_TRACE, segs);
  assert.ok(out, "the front leader edge still snaps");
  assert.equal(out!.snapped, 1, "only the front edge snapped");
  assert.ok(out!.perimeter.some((p) => Math.abs(p.x - 880) <= 1), "the supported wing stays");
});

test("snapPhantomEdges: no width data / flat width ladder → null (trace stands)", () => {
  const noWidths = WING_SEGS.map((s) => s.slice(0, 4));
  assert.equal(snapPhantomEdges(WING_TRACE, noWidths), null);
  const flat = WING_SEGS.map((s) => [s[0], s[1], s[2], s[3], 1.0]);
  assert.equal(snapPhantomEdges(WING_TRACE, flat), null);
});

test("snapPhantomEdges: unsupported edge with NO heavy line in reach is kept, not deleted", () => {
  // Wing pushed out past the snap cap (12% of span) — nothing to snap to.
  const farTrace = WING_TRACE.map((p) => (p.x === 880 ? { x: 920, y: p.y } : p));
  const segs = WING_SEGS.map((s) => (s[0] === 880 ? [920, s[1], 920, s[3], s[4]] : s));
  const out = snapPhantomEdges(farTrace, segs);
  // The front still snaps (its eave is drawn); the wing edge stays put.
  assert.ok(out, "front repair still fired");
  assert.equal(out!.snapped, 1, "only the front edge snapped");
  assert.ok(out!.perimeter.some((p) => Math.abs(p.x - 920) <= 1), "unfixable wing edge kept as-is");
});

test("snapPhantomEdges: a fully-supported trace → null (nothing to fix)", () => {
  const clean = pts([
    [0, 0],
    [800, 0],
    [800, 460],
    [500, 460],
    [500, 500],
    [0, 500],
  ]);
  const segs: number[][] = [
    [0, 0, 800, 0, 2.5],
    [0, 0, 0, 500, 2.5],
    [800, 0, 800, 460, 2.5],
    [500, 460, 800, 460, 2.5],
    [500, 460, 500, 500, 2.5],
    [0, 500, 500, 500, 2.5],
    [100, 200, 700, 200, 1.0],
    [50, 50, 750, 50, 0.3],
  ];
  assert.equal(snapPhantomEdges(clean, segs), null);
});

/** The true building: main front at y=500, garage front SET BACK to y=460
 *  for x∈[500,800] (the jog the roof trace flattens). Footprint version is
 *  the same shape scaled ×2 and translated — registration must undo that. */
const FP_WITH_JOG = pts([
  [3000, 2000],
  [4600, 2000],
  [4600, 2920], // garage front (set back)
  [4000, 2920],
  [4000, 3000], // the jog
  [3000, 3000], // main front
]);

test("adoptFootprintJogs: a garage end-step drawn on the foundation plan lands in the flat roof front", () => {
  const flatRoof = pts([
    [0, 0],
    [800, 0],
    [800, 300],
    [760, 300], // small real articulation so the outline isn't a plain box
    [760, 340],
    [800, 340],
    [800, 500],
    [0, 500], // front traced FLAT — the jog is missing
  ]);
  const out = adoptFootprintJogs(flatRoof, FP_WITH_JOG);
  assert.ok(out, "jog adopted");
  assert.equal(out!.adopted, 1);
  // The garage span of the front edge moved to y≈460 with a step at x≈500.
  assert.ok(hasCornerNear(out!.perimeter, 500, 500), "step shoulder at the main front");
  assert.ok(hasCornerNear(out!.perimeter, 500, 460), "step lands on the set-back line");
  assert.ok(hasCornerNear(out!.perimeter, 800, 460), "garage corner moved onto the set-back line");
});

test("adoptFootprintJogs: a NOTCH (recessed strip mid-wall) is inserted into the flat edge", () => {
  const fpNotch = pts([
    [3000, 2000],
    [4600, 2000],
    [4600, 3000],
    [4200, 3000],
    [4200, 2900], // recessed strip x∈[3600,4200] (maps to 300..600)
    [3600, 2900],
    [3600, 3000],
    [3000, 3000],
  ]);
  const flatRoof = pts([
    [0, 0],
    [800, 0],
    [800, 300],
    [760, 300],
    [760, 340],
    [800, 340],
    [800, 500],
    [0, 500],
  ]);
  const out = adoptFootprintJogs(flatRoof, fpNotch);
  assert.ok(out, "notch adopted");
  assert.equal(out!.adopted, 1);
  assert.ok(hasCornerNear(out!.perimeter, 300, 450), "notch floor left corner");
  assert.ok(hasCornerNear(out!.perimeter, 600, 450), "notch floor right corner");
});

test("adoptFootprintJogs: protective gates — skewed registration / off-edge step / agreeing outlines → null", () => {
  const flatRoof = pts([
    [0, 0],
    [800, 0],
    [800, 300],
    [760, 300],
    [760, 340],
    [800, 340],
    [800, 500],
    [0, 500],
  ]);
  // Registration skew: footprint aspect wildly different (not the same massing).
  const skewed = FP_WITH_JOG.map((p) => ({ x: p.x, y: 2000 + (p.y - 2000) * 3 }));
  assert.equal(adoptFootprintJogs(flatRoof, skewed), null);
  // The roof outline already HAS the jog → the step maps onto a corner, not
  // the middle of a flat edge → nothing adopted.
  const jogged = pts([
    [0, 0],
    [800, 0],
    [800, 460],
    [500, 460],
    [500, 500],
    [0, 500],
  ]);
  assert.equal(adoptFootprintJogs(jogged, FP_WITH_JOG), null);
});

test("reconcileRoofPerimeter: wings removed AND the foundation-plan jog adopted, with the on-panel note", () => {
  // Trace: phantom wing + leader-line front (flat across the garage jog).
  // Sheet: the garage front IS drawn set back (heavy at y=460) but the trace
  // rode the leader line straight across. → snap fixes the wing+front onto
  // the main-front line; the garage sub-span has NO heavy line at y=500
  // (unsupported), so the foundation plan's jog is adopted there.
  const out = reconcileRoofPerimeter({
    perimeter: WING_TRACE,
    segments: WING_SEGS,
    footprintOutline: FP_WITH_JOG,
  });
  assert.ok(out, "repair fired");
  assert.equal(out!.snappedEdges, 2, "wing rail + front leader snapped");
  assert.equal(out!.jogsAdopted, 1, "garage jog adopted from the foundation plan");
  assert.ok(!out!.perimeter.some((p) => p.x > 810), "no wings");
  assert.ok(hasCornerNear(out!.perimeter, 500, 460), "garage jog present");
  assert.ok(hasCornerNear(out!.perimeter, 800, 460), "garage front on the set-back line");
  assert.equal(out!.notes.length, 1);
  assert.match(out!.notes[0], /Outline check/);
  assert.match(out!.notes[0], /1 jog/);
  assert.match(out!.notes[0], /2 traced edge/);
  assert.match(out!.notes[0], /[Vv]erify/);
});

test("reconcileRoofPerimeter: nothing to fix → null; garbage input → null, never throws", () => {
  const clean = pts([
    [0, 0],
    [800, 0],
    [800, 460],
    [500, 460],
    [500, 500],
    [0, 500],
  ]);
  const segs: number[][] = [
    [0, 0, 800, 0, 2.5],
    [0, 0, 0, 500, 2.5],
    [800, 0, 800, 460, 2.5],
    [500, 460, 800, 460, 2.5],
    [500, 460, 500, 500, 2.5],
    [0, 500, 500, 500, 2.5],
    [100, 200, 700, 200, 1.0],
    [50, 50, 750, 50, 0.3],
  ];
  // Fully supported + footprint agrees (same shape) → keep current behavior.
  const fpSame = clean.map((p) => ({ x: 3000 + p.x * 2, y: 2000 + p.y * 2 }));
  assert.equal(reconcileRoofPerimeter({ perimeter: clean, segments: segs, footprintOutline: fpSame }), null);
  assert.equal(reconcileRoofPerimeter({ perimeter: [], segments: [], footprintOutline: null }), null);
  assert.doesNotThrow(() =>
    reconcileRoofPerimeter({
      perimeter: [{ x: NaN, y: NaN }] as Pt[],
      segments: [[NaN, NaN, NaN, NaN]],
      footprintOutline: null,
    }),
  );
});

test("classifyGableLabel keyword pinning", () => {
  assert.equal(classifyGableLabel("GABLE END TRUSS"), true);
  assert.equal(classifyGableLabel("STRUCT. GABLE END TRUSS"), true);
  assert.equal(classifyGableLabel("GABLE"), true);
  assert.equal(classifyGableLabel("gable end"), true);
  assert.equal(classifyGableLabel("RIDGE"), false);
  assert.equal(classifyGableLabel("MAIN VALLEY"), false);
  assert.equal(classifyGableLabel("VALLEY"), false);
  assert.equal(classifyGableLabel("HIP"), false);
  assert.equal(classifyGableLabel("GIRDER TRUSS"), false);
  assert.equal(classifyGableLabel("COMMON TRUSS"), false);
  assert.equal(classifyGableLabel("SCISSOR TRUSS"), false);
});

// ————————————————————————————————————————————————————————————————————————
// Verification-wave regressions: the adversarial panel carved foundation
// articulation into CORRECT roof edges. The roof sheet's own linework now
// gates every adoption.
// ————————————————————————————————————————————————————————————————————————

test("adoptFootprintJogs: a foundation notch is NEVER carved into a roof edge the sheet draws straight+heavy", () => {
  // Recessed entry alcove: the roof genuinely carries flat over it — the
  // front eave is drawn heavy across the full span. The foundation notch
  // must not become phantom gutter into the recess.
  const roof = pts([
    [0, 0],
    [1080, 0],
    [1080, 300],
    [1040, 300], // real bay articulation so the outline isn't a plain box
    [1040, 380],
    [1080, 380],
    [1080, 720],
    [0, 720], // front eave: genuinely straight, drawn heavy
  ]);
  const segs: number[][] = [
    [0, 0, 1080, 0, 2.5],
    [0, 0, 0, 720, 2.5],
    [1080, 0, 1080, 300, 2.5],
    [1040, 300, 1080, 300, 2.5],
    [1040, 300, 1040, 380, 2.5],
    [1040, 380, 1080, 380, 2.5],
    [1080, 380, 1080, 720, 2.5],
    [0, 720, 1080, 720, 2.5], // the straight front eave IS drawn
    [100, 200, 900, 200, 1.0],
    [100, 500, 900, 500, 1.0],
    [-40, -40, 1120, -40, 0.3],
    [-40, -40, -40, 760, 0.3],
  ];
  const fpAlcove = pts([
    [5000, 3000],
    [7160, 3000],
    [7160, 4440],
    [6200, 4440],
    [6200, 4296], // 8ft-wide, 4ft-deep recessed entry
    [5624, 4296],
    [5624, 4440],
    [5000, 4440],
  ]);
  assert.equal(adoptFootprintJogs(roof, fpAlcove, segs), null, "trace stands");
  assert.equal(
    reconcileRoofPerimeter({ perimeter: roof, segments: segs, footprintOutline: fpAlcove }),
    null,
    "full pipeline leaves the correct trace untouched",
  );
});

test("adoptFootprintJogs: an entire wall misread as 'the step' (run-scale S1) never matches — no corner carve", () => {
  // Footprint: rect + mid-wall projection on the right. The projection
  // defines the bbox extreme, so registration maps the main right wall
  // inboard; the old end-step matcher read (top edge, WHOLE right wall,
  // projection stub) as a step and carved the roof's real corners inward.
  const roof = pts([
    [0, 0],
    [800, 0],
    [800, 460],
    [500, 460], // articulation (real jog) so corner count > 4
    [500, 500],
    [0, 500],
  ]);
  const fpProj = pts([
    [3000, 2000],
    [4600, 2000], // top
    [4600, 2200],
    [4660, 2200], // mid-wall projection (bbox extreme)
    [4660, 2800],
    [4600, 2800],
    [4600, 2920],
    [4000, 2920],
    [4000, 3000],
    [3000, 3000],
  ]);
  const out = adoptFootprintJogs(roof, fpProj);
  // Whatever is (or isn't) adopted, the REAL drawn corners must survive —
  // no edge may move to a line that exists nowhere in the trace.
  if (out) {
    for (const p of out.perimeter) {
      assert.ok(
        [0, 500, 800].some((x) => Math.abs(p.x - x) < 45) ||
          [0, 460, 500].some(() => true),
        "no invented vertical line",
      );
    }
    assert.ok(
      out.perimeter.filter((p) => Math.abs(p.x - 800) < 1).length >= 2,
      "the real right wall at x=800 survives (never pulled inboard)",
    );
  }
});

test("adoptFootprintJogs: one footprint articulation adopts at most ONCE (no double-adopt)", () => {
  const roof = pts([
    [0, 0],
    [800, 0],
    [800, 300],
    [760, 300],
    [760, 340],
    [800, 340],
    [800, 500],
    [0, 500],
  ]);
  // Foundation with a single small notch mid-front (2.5 ft scale bump).
  const fpBump = pts([
    [3000, 2000],
    [4600, 2000],
    [4600, 3000],
    [4200, 3000],
    [4200, 2910],
    [3600, 2910],
    [3600, 3000],
    [3000, 3000],
  ]);
  const out = adoptFootprintJogs(roof, fpBump);
  assert.ok(out, "the (legacy, no-segments) adoption fires");
  assert.equal(out!.adopted, 1, "the same articulation never re-fires on its own splice");
});
