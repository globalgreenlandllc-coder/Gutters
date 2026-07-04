/**
 * Pure node tests for the deterministic per-face MERGE (no model calls). Run:
 *   npx tsx --test lib/ai/read-elevations.test.mts
 *
 * The model calls in read-elevations.ts are fail-safe I/O and can't be unit
 * tested without spending tokens; the merge — which enforces no-symmetry,
 * lists unreadable faces, and defaults projection cues to flush — is pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFaceReadings, type FaceReadingRaw } from "./face-merge.ts";

function face(over: Partial<FaceReadingRaw>): FaceReadingRaw {
  return {
    face: "north",
    readable: true,
    unreadable_reason: null,
    gable_count: 0,
    continuous_eave: true,
    gables: [],
    projection_cues: [],
    confidence: "high",
    ...over,
  };
}

test("opposite faces with different gable counts → 'read separately, NOT mirrored' flag; symmetry never assumed", () => {
  const merged = mergeFaceReadings(
    [
      face({ face: "south", gable_count: 4 }), // busy cross-gable front
      face({ face: "north", gable_count: 0 }), // plain hip rear
    ],
    ["south", "north"],
  );
  assert.equal(merged.symmetry_assumed, false);
  assert.ok(merged.review_flags.some((f) => /NOT mirrored/.test(f) && /south shows 4/.test(f) && /north shows 0/.test(f)));
  assert.deepEqual(merged.elevation_unreadable, []);
});

test("unreadable and missing faces are listed with a flag", () => {
  const merged = mergeFaceReadings(
    [face({ face: "south", gable_count: 2 }), face({ face: "east", readable: false, unreadable_reason: "muddy crop" })],
    ["south", "east", "west"], // west never read
  );
  assert.ok(merged.elevation_unreadable.includes("east"));
  assert.ok(merged.elevation_unreadable.includes("west"));
  assert.ok(merged.review_flags.some((f) => /elevation_unreadable: east/.test(f) && /muddy crop/.test(f)));
  assert.ok(merged.review_flags.some((f) => /west elevation not read/.test(f)));
});

test("emits a 4-face coverage summary listing which faces were read", () => {
  const merged = mergeFaceReadings(
    [face({ face: "north", gable_count: 2 }), face({ face: "south", gable_count: 1 })],
    ["north", "south", "east", "west"],
  );
  const summary = merged.review_flags.find((f) => /4-face check/.test(f));
  assert.ok(summary, "should emit a coverage summary");
  assert.ok(/north 2 gable\(s\)/.test(summary!) && /south 1 gable\(s\)/.test(summary!));
  // The two faces sharing sheets that weren't read are surfaced, not skipped.
  assert.ok(merged.elevation_unreadable.includes("east") && merged.elevation_unreadable.includes("west"));
  assert.ok(merged.review_flags.some((f) => /east elevation not read/.test(f)));
});

test("a projection cue defaults to flush and flags for confirmation (posts ⇒ likely porch)", () => {
  const merged = mergeFaceReadings(
    [
      face({
        face: "south",
        gable_count: 1,
        gables: [
          {
            id: "entry",
            span_ft: 8,
            pitch: 6,
            eave_condition_guess: "flush",
            supported_on: "posts",
            shows_projection_cue: true,
            notes: "entry gable on wrapped posts",
          },
        ],
      }),
    ],
    ["south"],
  );
  const flag = merged.review_flags.find((f) => /Gable 'entry'/.test(f));
  assert.ok(flag, "should flag the cued gable");
  assert.ok(/likely a projecting porch/.test(flag!), "posts ⇒ likely porch");
  assert.ok(/Defaulted to FLUSH/.test(flag!), "no gutter added on a guess");
});

test("no cues, matching readable opposite faces → only the coverage summary, no spurious flags", () => {
  const merged = mergeFaceReadings(
    [face({ face: "east", gable_count: 1 }), face({ face: "west", gable_count: 1 })],
    ["east", "west"],
  );
  // Coverage summary is always present; nothing else.
  assert.equal(merged.review_flags.length, 1);
  assert.ok(/4-face check/.test(merged.review_flags[0]));
  assert.ok(!merged.review_flags.some((f) => /NOT mirrored/.test(f)));
  assert.equal(merged.symmetry_assumed, false);
});
