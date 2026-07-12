import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeProjectionGutterLF } from "./projection-lf.ts";
import type { DroppedProjection } from "./reconcile-edge-classes.ts";

const drop = (over: Partial<DroppedProjection> = {}): DroppedProjection => ({
  face: "front",
  kind: "garage",
  supportedOn: "beam",
  spanFt: 24,
  ...over,
});

test("synthesis: a garage roof beyond the wall recovers ~2×(area÷span) LF, tagged verify", () => {
  // 480 sf garage roof / 24 ft span = 20 ft deep → two 20 ft side returns = 40 LF.
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "garage", spanFt: 24 })],
    [{ label: "GARAGE ROOF", areaFt2: 480 }],
  );
  assert.equal(r.addedLF, 40, "two side returns of the 20 ft depth");
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /VERIFY/, "flagged estimated, not a hard number");
  assert.match(r.notes[0], /garage/i);
});

test("synthesis: no matching roof-area mass → no LF added (keeps note-only behavior)", () => {
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "garage" })],
    [{ label: "MAIN ROOF", areaFt2: 2400 }], // no garage mass in the schedule
  );
  assert.equal(r.addedLF, 0);
  assert.equal(r.notes.length, 0);
});

test("synthesis: label matches a porch to a covered-porch mass by containment", () => {
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "porch", spanFt: 12 })],
    [{ label: "COVERED PORCH", areaFt2: 120 }], // 120/12 = 10 ft deep → 20 LF
  );
  assert.equal(r.addedLF, 20);
});

test("synthesis: an implausible depth (area÷span out of bounds) stays note-only", () => {
  // 3000 sf / 10 ft = 300 ft deep — absurd; must NOT price.
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "garage", spanFt: 10 })],
    [{ label: "GARAGE", areaFt2: 3000 }],
  );
  assert.equal(r.addedLF, 0, "clamped out — no phantom LF");
});

test("synthesis: the same named mass seen from two elevations is counted once", () => {
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "garage", face: "front", spanFt: 24 }), drop({ kind: "garage", face: "left", spanFt: 24 })],
    [{ label: "GARAGE", areaFt2: 480 }],
  );
  assert.equal(r.addedLF, 40, "not double-counted across elevations");
});

test("synthesis: no span read → cannot compute depth → note-only", () => {
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "garage", spanFt: null })],
    [{ label: "GARAGE", areaFt2: 480 }],
  );
  assert.equal(r.addedLF, 0);
});

test("synthesis: empty inputs are a no-op", () => {
  assert.deepEqual(synthesizeProjectionGutterLF([], []), { addedLF: 0, notes: [] });
  assert.deepEqual(synthesizeProjectionGutterLF(null, null), { addedLF: 0, notes: [] });
  assert.deepEqual(
    synthesizeProjectionGutterLF([drop()], null),
    { addedLF: 0, notes: [] },
  );
});
