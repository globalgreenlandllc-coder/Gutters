import { test } from "node:test";
import assert from "node:assert/strict";

import { segmentsFromOps, selectSegments } from "./pdf-segments.ts";

// Op codes for the RUNNING engine (unpdf's bundled pdfjs v5), confirmed from
// node_modules/unpdf/dist/pdfjs.mjs. Path-buffer sub-ops: 0 move,1 line,2 cubic,
// 3 quad,4 close. Paints are FUSED into constructPath's first arg.
const OPS = {
  setLineWidth: 2,
  setGState: 9,
  save: 10,
  restore: 11,
  transform: 12,
  constructPath: 91,
  stroke: 20,
  fill: 22,
} as Record<string, number>;

// v5 constructPath args = [paintOp, subPaths, minMax]; subPaths = [flat[op,x,y,…]].
const path = (pts: [number, number][], paint: number) => {
  const flat: number[] = [];
  pts.forEach(([x, y], i) => flat.push(i === 0 ? 0 : 1, x, y)); // move then line*
  return [paint, [flat], [0, 0, 0, 0]];
};

type Op = [number, unknown];
const ops = (list: Op[]) => ({
  fnArray: list.map((o) => o[0]),
  argsArray: list.map((o) => o[1]),
});
const cp = (pts: [number, number][], paint = OPS.stroke): Op => [
  OPS.constructPath,
  path(pts, paint),
];
const seglen = (s: number[]) => Math.hypot(s[2] - s[0], s[3] - s[1]);

/** Thick (2.5) box of 4 axis edges + many thin (0.5) diagonal trusses. */
function fixture() {
  const list: Op[] = [[OPS.setLineWidth, [2.5]]];
  list.push(cp([[0, 0], [400, 0]]), cp([[0, 0], [0, 300]]));
  list.push(cp([[400, 0], [400, 300]]), cp([[0, 300], [400, 300]]));
  list.push([OPS.setLineWidth, [0.5]]);
  for (let i = 1; i < 12; i++) list.push(cp([[0, 0], [400, i * 20]]));
  return ops(list);
}

test("width tracked: thick ≈2.5, thin ≈0.5 (paint fused in constructPath[0])", () => {
  const raw = segmentsFromOps(fixture(), OPS);
  const ws = raw.map((r) => r.w);
  assert.ok(ws.some((w) => w !== null && Math.abs(w - 2.5) < 1e-6), "has thick");
  assert.ok(ws.some((w) => w !== null && Math.abs(w - 0.5) < 1e-6), "has thin");
});

test("bold filter keeps thick roof lines, drops thin truss lines", () => {
  const raw = segmentsFromOps(fixture(), OPS);
  const bold = selectSegments(raw, true);
  const all = selectSegments(raw, false);
  assert.equal(bold.length, 4, "kept exactly the 4 bold box edges");
  assert.ok(bold.length < all.length, "dropped thin truss noise");
  for (const s of bold) {
    const diag = Math.abs(s[2] - s[0]) > 1.5 && Math.abs(s[3] - s[1]) > 1.5;
    assert.equal(diag, false, "no thin diagonal survived");
  }
});

test("3-tier: truss 0.25 / outline 0.5 / ridge 1.5 → KEEPS the outline (not ridge-only)", () => {
  const list: Op[] = [];
  // outline: 4 long box edges at 0.5 (the load-bearing footprint).
  list.push([OPS.setLineWidth, [0.5]]);
  list.push(cp([[0, 0], [400, 0]]), cp([[0, 0], [0, 300]]));
  list.push(cp([[400, 0], [400, 300]]), cp([[0, 300], [400, 300]]));
  // ridge/hip: 4 medium lines at 1.5 (heaviest).
  list.push([OPS.setLineWidth, [1.5]]);
  for (let i = 0; i < 4; i++) list.push(cp([[100, 50 + i * 10], [300, 50 + i * 10]]));
  // truss: 6 thin axis lines at 0.25 (noise to drop).
  list.push([OPS.setLineWidth, [0.25]]);
  for (let i = 0; i < 6; i++) list.push(cp([[10, 200 + i * 8], [70, 200 + i * 8]]));
  const raw = segmentsFromOps(ops(list), OPS);
  const bold = selectSegments(raw, true);
  // The bold tier must contain the OUTLINE (a 300-long edge) — the old
  // largest-gap cut would have dropped it and kept only the 1.5 ridges.
  assert.ok(
    bold.some((s) => Math.abs(seglen(s) - 400) < 2 || Math.abs(seglen(s) - 300) < 2),
    "outline edges survived",
  );
  assert.ok(bold.some((s) => Math.abs(seglen(s) - 200) < 2), "ridges survived");
  // …and the thin 60-long truss noise is gone.
  assert.ok(!bold.some((s) => Math.abs(seglen(s) - 60) < 2), "truss dropped");
});

test("save/restore reverts width across q…Q (paint fused)", () => {
  const raw = segmentsFromOps(
    ops([
      [OPS.setLineWidth, [0.5]],
      [OPS.save, null],
      [OPS.setLineWidth, [2.5]],
      cp([[0, 0], [400, 0]]),
      [OPS.restore, null],
      cp([[0, 50], [400, 50]]),
    ]),
    OPS,
  );
  assert.equal(raw[0].w, 2.5);
  assert.equal(raw[1].w, 0.5);
});

test("CTM transform scales device width (0.5 × 2× → 1.0)", () => {
  const raw = segmentsFromOps(
    ops([
      [OPS.transform, [2, 0, 0, 2, 0, 0]],
      [OPS.setLineWidth, [0.5]],
      cp([[0, 0], [100, 0]]),
    ]),
    OPS,
  );
  assert.ok(Math.abs(raw[0].w! - 1.0) < 1e-6);
});

test("fill-only path → null width, never bold", () => {
  const raw = segmentsFromOps(
    ops([
      [OPS.setLineWidth, [9]],
      cp([[0, 0], [400, 0], [400, 300], [0, 300]], OPS.fill),
    ]),
    OPS,
  );
  assert.ok(raw.every((r) => r.w === null), "fill path → null width");
});

test("curve sub-ops are skipped to their endpoint (path stays connected)", () => {
  // move(0,0) → cubic ending at (100,0) → line to (200,0). The lineTo segment
  // must be emitted from the curve endpoint, not lost.
  const flat = [0, 0, 0, 2, 10, 20, 50, 20, 100, 0, 1, 200, 0];
  const raw = segmentsFromOps(
    ops([[OPS.constructPath, [OPS.stroke, [flat], [0, 0, 0, 0]]]]),
    OPS,
  );
  assert.equal(raw.length, 1, "one straight segment after the curve");
  assert.deepEqual(raw[0].seg, [100, 0, 200, 0]);
});

test("empty path subpaths=[null] does not throw", () => {
  const raw = segmentsFromOps(
    ops([[OPS.constructPath, [OPS.stroke, [null], null]]]),
    OPS,
  );
  assert.deepEqual(raw, []);
});

test("width via ExtGState (setGState LW) is tracked", () => {
  const raw = segmentsFromOps(
    ops([[OPS.setGState, [[["LW", 3.0]]]], cp([[0, 0], [400, 0]])]),
    OPS,
  );
  assert.equal(raw[0].w, 3.0);
});

test("FALLBACK: all-equal widths → bold == length-only", () => {
  const list: Op[] = [[OPS.setLineWidth, [1.0]]];
  for (let i = 0; i < 8; i++) list.push(cp([[0, i * 20], [400, i * 20]]));
  const raw = segmentsFromOps(ops(list), OPS);
  assert.deepEqual(selectSegments(raw, true), selectSegments(raw, false));
});

test("FALLBACK: width missing on >50% (fill paths) → length-only", () => {
  const list: Op[] = [[OPS.setLineWidth, [2.5]]];
  for (let i = 0; i < 4; i++) list.push(cp([[0, i * 20], [400, i * 20]], OPS.stroke));
  for (let i = 0; i < 6; i++) list.push(cp([[0, 100 + i * 20], [400, 100 + i * 20]], OPS.fill));
  const raw = segmentsFromOps(ops(list), OPS);
  assert.deepEqual(selectSegments(raw, true), selectSegments(raw, false));
});
