import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeProjectionGutterLF } from "./projection-lf.ts";
import type { DroppedProjection } from "./reconcile-edge-classes.ts";

// Same widening projection-lf uses internally: the reconcile can attach the
// cover's roof form and the traced stub's return depth.
type Drop = DroppedProjection & {
  form?: "gable" | "hip" | "shed" | null;
  stubReturnFt?: number | null;
};

const drop = (over: Partial<Drop> = {}): Drop => ({
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

test("synthesis: an ENTRY cover matches the schedule's 'porch' mass (kind normalization)", () => {
  // place-gables normalizes entry→porch for the same area÷span law; the
  // synthesis must agree or entry porches price $0 forever.
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "entry", spanFt: 20 })],
    [{ label: "porch", areaFt2: 189 }], // 189/20 ≈ 9.5 ft deep → 2 sides ≈ 19 LF
  );
  assert.equal(r.addedLF, 19);
  assert.match(r.notes[0], /entry/i);
  assert.match(r.notes[0], /VERIFY/);
});

test("synthesis: an ENTRY cover still matches a literal 'COVERED ENTRY' schedule label", () => {
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "entry", spanFt: 20 })],
    [{ label: "COVERED ENTRY", areaFt2: 189 }],
  );
  assert.equal(r.addedLF, 19, "raw kind matches before the porch synonym");
});

test("synthesis: Woodinville entry SHORTFALL — stub returns already priced, only the overhang is added", () => {
  // Schedule porch 189 sf, span 20 → depth ≈ 9.5 ft; the traced wall bump
  // returns only 5 ft → shortfall 2 × (9.5 − 5) ≈ 9 LF, never the full 19.
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "entry", spanFt: 20, stubReturnFt: 5 })],
    [{ label: "porch", areaFt2: 189 }],
  );
  assert.equal(r.addedLF, 9, "shortfall only — stub sides not double-counted");
  assert.match(r.notes[0], /returns only 5 ft/);
  assert.match(r.notes[0], /VERIFY/);
});

test("synthesis: a stub as deep as the roof → zero shortfall, no LF, no note", () => {
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "porch", spanFt: 20, stubReturnFt: 12 })], // depth 9.45 < stub 12
    [{ label: "porch", areaFt2: 189 }],
  );
  assert.equal(r.addedLF, 0, "clamped ≥ 0 — never negative, never noise");
  assert.equal(r.notes.length, 0);
});

test("synthesis: HIPPED cover wraps — 2 sides plus the outer face", () => {
  // 288 sf / 18 ft span = 16 ft deep → 2×16 + 18 = 50 LF.
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "patio", form: "hip", spanFt: 18 })],
    [{ label: "PATIO ROOF", areaFt2: 288 }],
  );
  assert.equal(r.addedLF, 50);
  assert.match(r.notes[0], /hipped cover/);
  assert.match(r.notes[0], /VERIFY/);
});

test("synthesis: SHED cover gutters the low edge only — span, not 2×depth", () => {
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "porch", form: "shed", spanFt: 12 })],
    [{ label: "PORCH", areaFt2: 120 }], // depth 10 plausible, but shed ⇒ 12 LF
  );
  assert.equal(r.addedLF, 12);
  assert.match(r.notes[0], /low edge/);
});

test("synthesis: SHED cover over a traced stub adds nothing (the low edge is already on the bump)", () => {
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "porch", form: "shed", spanFt: 12, stubReturnFt: 4 })],
    [{ label: "PORCH", areaFt2: 120 }],
  );
  assert.equal(r.addedLF, 0, "span-length low edge already priced on the stub outer edge");
  assert.equal(r.notes.length, 0);
});

test("synthesis: 'main' stays hard-rejected even when a form is attached (hip-ranch non-regression)", () => {
  // A hip ranch's main roof read on beams must never synthesize porch LF.
  const r = synthesizeProjectionGutterLF(
    [drop({ kind: "main", form: "hip", spanFt: 40 })],
    [{ label: "MAIN ROOF", areaFt2: 2400 }],
  );
  assert.equal(r.addedLF, 0);
  assert.equal(r.notes.length, 0);
});
