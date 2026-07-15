import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineEdges, downspoutMarksFromLabels } from "./plan-overlay.ts";

// A 100×60 pt rectangle at 2 pt/ft → 50×30 ft building.
const rect = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 0, y: 60 },
];
const edges = outlineEdges(rect);

test("downspoutMarksFromLabels: snaps printed D.S. strings to the nearest edge with the right fraction", () => {
  const marks = downspoutMarksFromLabels(
    [
      { s: "D.S.", x: 25, y: -6 }, // 3 ft above the top edge (leader offset)
      { s: "DS", x: 104, y: 45 }, // right edge, lower quarter
      { s: "d.s.", x: 50, y: 66 }, // bottom edge, centered
    ],
    edges,
    2,
  );
  assert.equal(marks.length, 3);
  assert.equal(marks[0].edge_id, edges[0].id);
  assert.ok(Math.abs(marks[0].frac - 0.25) < 0.01);
  assert.equal(marks[1].edge_id, edges[1].id);
  assert.equal(marks[2].edge_id, edges[2].id);
  assert.ok(Math.abs(marks[2].frac - 0.5) < 0.01);
});

test("downspoutMarksFromLabels: a legend/schedule 'D.S.' far from the perimeter is ignored; non-DS labels never match", () => {
  const marks = downspoutMarksFromLabels(
    [
      { s: "D.S.", x: 300, y: 300 }, // legend box, way off the building
      { s: "DSGN", x: 50, y: -4 }, // not a downspout mark
      { s: "GABLE END TRUSS", x: 50, y: 4 },
    ],
    edges,
    2,
  );
  assert.equal(marks.length, 0);
});

test("downspoutMarksFromLabels: duplicate extractions of one printed mark dedupe to a single downspout", () => {
  const marks = downspoutMarksFromLabels(
    [
      { s: "D.S.", x: 25, y: -6 },
      { s: "D.S.", x: 26, y: -5 }, // same mark, extracted twice
    ],
    edges,
    2,
  );
  assert.equal(marks.length, 1);
});
