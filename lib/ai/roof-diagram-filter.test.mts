import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterRoofDiagramLines,
  segmentsCross,
} from "./roof-diagram-filter.ts";

type Pt = { x: number; y: number };
const L = (a: Pt, b: Pt, id = "") => ({ id, points: [a, b] });
// 100×60 footprint, y down (canvas space).
const PERIM: Pt[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 0, y: 60 },
];

test("segmentsCross: proper crossings only — shared endpoints and T-joins don't count", () => {
  assert.ok(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }));
  // Shared endpoint (hip pair meeting at an apex).
  assert.ok(!segmentsCross({ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 10, y: 0 }));
  // T-join (ridge ending ON another ridge).
  assert.ok(!segmentsCross({ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 10 }));
  // Disjoint.
  assert.ok(!segmentsCross({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 }, { x: 6, y: 6 }));
});

test("crossing fans: the LONGER of a crossing pair is dropped, the shorter survives", () => {
  // A short valid ridge crossed by a whole-body fan hip.
  const ridge = L({ x: 40, y: 0 }, { x: 40, y: 20 }); // anchored to top wall
  const fan = L({ x: 0, y: 60 }, { x: 90, y: 2 }); // long diagonal, crosses ridge
  const out = filterRoofDiagramLines(
    { ridges: [ridge], valleys: [], hips: [fan] },
    PERIM,
  );
  assert.deepEqual(out.ridges, [ridge]);
  assert.deepEqual(out.hips, []);
});

test("length cap: hips/valleys spanning >40% of the footprint are dropped; ridges are exempt", () => {
  // 100-unit span → cap at 40. All lines anchored (endpoints on walls).
  const longHip = L({ x: 0, y: 0 }, { x: 50, y: 30 }); // ~58 units
  const longRidge = L({ x: 0, y: 30 }, { x: 100, y: 30 }); // gable-to-gable, 100 units
  const shortValley = L({ x: 100, y: 30 }, { x: 80, y: 30 }); // 20 units
  const out = filterRoofDiagramLines(
    { ridges: [longRidge], valleys: [shortValley], hips: [longHip] },
    PERIM,
  );
  assert.deepEqual(out.ridges, [longRidge]);
  assert.deepEqual(out.valleys, [shortValley]);
  assert.deepEqual(out.hips, []);
});

test("anchoring: floating stubs are dropped; junction-anchored chains survive", () => {
  // Ridge stub floating dead-center: neither endpoint near the perimeter
  // (tol = 2 on a 100 span) nor near any other line.
  const stub = L({ x: 48, y: 30 }, { x: 55, y: 30 });
  // A hip from a corner + a ridge anchored ONLY via that hip's apex.
  const hip = L({ x: 0, y: 0 }, { x: 20, y: 20 });
  const ridgeViaJunction = L({ x: 20, y: 20 }, { x: 38, y: 20 });
  const out = filterRoofDiagramLines(
    { ridges: [stub, ridgeViaJunction], valleys: [], hips: [hip] },
    PERIM,
  );
  assert.deepEqual(out.ridges, [ridgeViaJunction]);
  assert.deepEqual(out.hips, [hip]);
});

test("anchoring cascades: dropping an unanchored line unanchors its dependents", () => {
  // B floats; C anchors only to B; both must go once B goes.
  const b = L({ x: 40, y: 28 }, { x: 50, y: 28 });
  const c = L({ x: 50, y: 28 }, { x: 60, y: 28 });
  const out = filterRoofDiagramLines(
    { ridges: [b, c], valleys: [], hips: [] },
    PERIM,
  );
  assert.deepEqual(out.ridges, []);
});

test("degenerate inputs: no perimeter → nothing drawn; bad points dropped", () => {
  const good = L({ x: 0, y: 0 }, { x: 10, y: 10 });
  const empty = filterRoofDiagramLines(
    { ridges: [good], valleys: [], hips: [] },
    [],
  );
  assert.deepEqual(empty.ridges, []);
  const nan = { id: "", points: [{ x: NaN, y: 0 }, { x: 10, y: 10 }] };
  const out = filterRoofDiagramLines(
    { ridges: [nan], valleys: [], hips: [good] },
    PERIM,
  );
  assert.deepEqual(out.ridges, []);
  assert.deepEqual(out.hips, [good]);
});
