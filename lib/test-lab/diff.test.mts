/**
 * Pure node tests for the admin-lab diff classifier. Run with:
 *   npx tsx --test lib/test-lab/diff.test.mts
 * No DB, no AI, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLabDiff, type LabGeometry } from "./diff.ts";
import { buildFeedback, type LabTag } from "./feedback.ts";

const PX_PER_FT = 2; // 2 px = 1 ft → easy mental math

const line = (id: string, kind: "eave" | "rake", pts: [number, number][]) => ({
  id,
  kind,
  points: pts.map(([x, y]) => ({ x, y })),
});
const ds = (id: string, x: number, y: number) => ({ id, x, y, heightFt: 20 });

const geom = (over: Partial<LabGeometry> = {}): LabGeometry => ({
  eaves: [
    line("e1", "eave", [[0, 0], [100, 0]]), // 50 ft
    line("e2", "eave", [[0, 40], [100, 40]]), // 50 ft
  ],
  rakes: [line("r1", "rake", [[0, 0], [0, 40]])],
  downspouts: [ds("d1", 0, 0), ds("d2", 100, 40)],
  ...over,
});

test("identical geometry → clean diff", () => {
  const d = computeLabDiff(geom(), geom(), PX_PER_FT);
  assert.equal(d.isClean, true);
  assert.equal(d.changes.length, 0);
  assert.equal(d.downspoutChanges.length, 0);
  assert.equal(d.eaveLFBefore, 100);
  assert.equal(d.eaveLFAfter, 100);
});

test("deleted eave classified with LF and midpoint", () => {
  const after = geom({ eaves: [line("e1", "eave", [[0, 0], [100, 0]])] });
  const d = computeLabDiff(geom(), after, PX_PER_FT);
  assert.equal(d.isClean, false);
  assert.equal(d.changes.length, 1);
  const c = d.changes[0];
  assert.equal(c.action, "deleted");
  assert.equal(c.key, "eave:e2");
  assert.equal(c.lengthFt, 50);
  assert.deepEqual(c.at, { x: 50, y: 40 });
  assert.equal(d.lfDeltaFt, -50);
  assert.equal(d.lfDeltaPct, -50);
});

test("added + moved eaves, moved downspout", () => {
  const after = geom({
    eaves: [
      line("e1", "eave", [[0, 0], [110, 0]]), // stretched +5 ft
      line("e2", "eave", [[0, 40], [100, 40]]),
      line("drawn-1", "eave", [[0, 80], [40, 80]]), // new 20 ft
    ],
    downspouts: [ds("d1", 0, 0), ds("d2", 100, 60)], // d2 moved 10 ft
  });
  const d = computeLabDiff(geom(), after, PX_PER_FT);
  const byAction = Object.fromEntries(d.changes.map((c) => [c.action, c]));
  assert.equal(byAction.moved.id, "e1");
  assert.equal(byAction.moved.lfDeltaFt, 5);
  assert.equal(byAction.moved.maxShiftFt, 5);
  assert.equal(byAction.added.id, "drawn-1");
  assert.equal(byAction.added.lengthFt, 20);
  assert.equal(d.downspoutChanges.length, 1);
  assert.equal(d.downspoutChanges[0].action, "moved");
  assert.equal(d.downspoutChanges[0].shiftFt, 10);
});

test("eave⇄rake reclassify detected by id crossing pools", () => {
  const before = geom();
  const after = geom({
    eaves: [line("e1", "eave", [[0, 0], [100, 0]])],
    rakes: [
      line("r1", "rake", [[0, 0], [0, 40]]),
      line("e2", "rake", [[0, 40], [100, 40]]), // e2 became a gable edge
    ],
  });
  const d = computeLabDiff(before, after, PX_PER_FT);
  assert.equal(d.changes.length, 1);
  assert.equal(d.changes[0].action, "reclassified");
  assert.equal(d.changes[0].id, "e2");
});

test("sub-epsilon jitter is not a move", () => {
  const after = geom({
    eaves: [
      line("e1", "eave", [[0.3, 0.2], [100.4, 0.1]]),
      line("e2", "eave", [[0, 40], [100, 40]]),
    ],
  });
  const d = computeLabDiff(geom(), after, PX_PER_FT);
  assert.equal(d.isClean, true);
});

test("feedback groups deleted LF by tag and reads causes", () => {
  const after = geom({ eaves: [] , downspouts: []});
  const d = computeLabDiff(geom(), after, PX_PER_FT);
  const tags: LabTag[] = [
    { key: "eave:e1", tag: "screen_enclosure" },
    { key: "eave:e2", tag: "screen_enclosure", note: "pool cage on the south side" },
  ];
  const fb = buildFeedback(d, tags);
  assert.match(fb.headline, /correction/);
  const lanai = fb.items.find((i) => i.category === "screen_enclosure");
  assert.ok(lanai, "expected a screened-enclosure read");
  assert.match(lanai.detail, /100 LF/);
  assert.match(lanai.detail, /pool cage on the south side/);
});

test("clean diff → clean-pass headline", () => {
  const fb = buildFeedback(computeLabDiff(geom(), geom(), PX_PER_FT), []);
  assert.match(fb.headline, /Clean pass/);
  assert.equal(fb.items.length, 0);
});
