import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRunPlacement,
  collectStepEdges,
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

// ── strictAnchor (raster path) ──────────────────────────────────────────────

test("strictAnchor: floating ridge dropped under the both-endpoint rule; connected envelope kept", () => {
  // A clean hip envelope: 4 corner hips + a junction-anchored main ridge.
  const hips = [
    L({ x: 0, y: 0 }, { x: 25, y: 30 }),
    L({ x: 0, y: 60 }, { x: 25, y: 30 }),
    L({ x: 100, y: 0 }, { x: 75, y: 30 }),
    L({ x: 100, y: 60 }, { x: 75, y: 30 }),
  ];
  const mainRidge = L({ x: 25, y: 30 }, { x: 75, y: 30 });
  // A ridge stub whose far end dies into a HIDDEN interior cut wall: one
  // endpoint T-joins the main ridge (single-anchor reachable → the default
  // rule keeps it), the other floats mid-roof.
  const stub = L({ x: 50, y: 30 }, { x: 50, y: 45 });

  const lax = filterRoofDiagramLines(
    { ridges: [mainRidge, stub], valleys: [], hips },
    PERIM,
  );
  assert.deepEqual(lax.ridges, [mainRidge, stub], "default keeps the reachable stub");
  assert.equal(lax.interiorOmitted, false);

  const strict = filterRoofDiagramLines(
    { ridges: [mainRidge, stub], valleys: [], hips },
    PERIM,
    { strictAnchor: true },
  );
  assert.deepEqual(strict.ridges, [mainRidge], "both-endpoint rule drops the stub");
  assert.deepEqual(strict.hips, hips, "the connected envelope survives intact");
  assert.equal(strict.interiorOmitted, false);
});

test("strictAnchor: tiny surviving set (fragments only) → EMPTY interior + interiorOmitted flag", () => {
  // Two corner-anchored hip fragments (len ~11 on a 100 span; frag cap 15).
  const fragA = L({ x: 0, y: 0 }, { x: 8, y: 8 });
  const fragB = L({ x: 100, y: 0 }, { x: 92, y: 8 });
  const lax = filterRoofDiagramLines(
    { ridges: [], valleys: [], hips: [fragA, fragB] },
    PERIM,
  );
  assert.deepEqual(lax.hips, [fragA, fragB], "default keeps anchored fragments");
  assert.equal(lax.interiorOmitted, false);

  const strict = filterRoofDiagramLines(
    { ridges: [], valleys: [], hips: [fragA, fragB] },
    PERIM,
    { strictAnchor: true },
  );
  assert.deepEqual(strict.ridges, []);
  assert.deepEqual(strict.valleys, []);
  assert.deepEqual(strict.hips, [], "fragments-only interior draws NOTHING");
  assert.equal(strict.interiorOmitted, true, "caller gets the omit-note flag");
});

test("strictAnchor: fewer than 2 survivors → empty + flag; empty input → no flag", () => {
  // One clean ridge survives everything, but a lone line isn't an evidenced
  // interior — omitted under strict.
  const lone = L({ x: 0, y: 30 }, { x: 100, y: 30 });
  const strict = filterRoofDiagramLines(
    { ridges: [lone], valleys: [], hips: [] },
    PERIM,
    { strictAnchor: true },
  );
  assert.deepEqual(strict.ridges, []);
  assert.equal(strict.interiorOmitted, true);

  const empty = filterRoofDiagramLines(
    { ridges: [], valleys: [], hips: [] },
    PERIM,
    { strictAnchor: true },
  );
  assert.equal(empty.interiorOmitted, false, "nothing was omitted — nothing existed");
});

// ── classifyRunPlacement (interior-run partition for the bridge) ────────────

test("classifyRunPlacement: clerestory rectangle run mid-roof is interior; wall runs are perimeter", () => {
  const tol = 2;
  // On the top wall.
  assert.equal(
    classifyRunPlacement({ start: { x: 10, y: 0 }, end: { x: 60, y: 0 } }, PERIM, tol),
    "perimeter",
  );
  // Clerestory box edge dead-center (midpoint 20 units from every wall).
  assert.equal(
    classifyRunPlacement({ start: { x: 30, y: 20 }, end: { x: 70, y: 20 } }, PERIM, tol),
    "interior",
  );
});

test("classifyRunPlacement: garbage coords are invalid (never drawn); no boundary → perimeter", () => {
  assert.equal(
    classifyRunPlacement({ start: { x: NaN, y: 0 }, end: { x: 10, y: 10 } }, PERIM, 2),
    "invalid",
  );
  assert.equal(classifyRunPlacement({ start: null, end: { x: 1, y: 1 } }, PERIM, 2), "invalid");
  // Infinity tol (perimeter-only OFF) and a degenerate footprint both mean
  // "cannot call anything interior".
  assert.equal(
    classifyRunPlacement({ start: { x: 30, y: 20 }, end: { x: 70, y: 20 } }, PERIM, Infinity),
    "perimeter",
  );
  assert.equal(
    classifyRunPlacement({ start: { x: 30, y: 20 }, end: { x: 70, y: 20 } }, [], 2),
    "perimeter",
  );
});

test("drawn set = priced set → the LF correction factor lands at exactly 1", () => {
  // The bridge's decision: perimeter runs draw as engine edges, interior
  // runs are APPENDED — so the drawn LF sum equals the priced LF sum.
  const runs = [
    { start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, length_ft: 100 },
    { start: { x: 30, y: 20 }, end: { x: 70, y: 20 }, length_ft: 40 }, // clerestory
  ];
  const priced = runs.reduce((s, r) => s + r.length_ft, 0);
  const drawn = runs
    .filter((r) => classifyRunPlacement(r, PERIM, 2) !== "invalid")
    .reduce((s, r) => s + r.length_ft, 0);
  assert.equal(priced / drawn, 1);
  // A garbage-coord interior run is invalid → excluded from the drawn set.
  const garbage = { start: { x: NaN, y: 20 }, end: { x: 70, y: 20 }, length_ft: 40 };
  assert.equal(classifyRunPlacement(garbage, PERIM, 2), "invalid");
});

// ── collectStepEdges (tier-step emission for the bridge) ────────────────────

test("collectStepEdges: interior mass boundaries kept + deduped across the two masses that share them; perimeter/degenerate/garbage dropped", () => {
  const tol = 2;
  const shared = { p1: { x: 30, y: 20 }, p2: { x: 70, y: 20 } };
  const edges = [
    // Mass A's copy of the shared tier boundary…
    { edge: { ...shared }, massName: "upper" },
    // …and mass B's copy, reversed.
    { edge: { p1: { x: 70, y: 20 }, p2: { x: 30, y: 20 } }, massName: "main" },
    // On the perimeter → already drawn as an eave/rake, not a step.
    { edge: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 } }, massName: "main" },
    // Degenerate + garbage → never drawn.
    { edge: { p1: { x: 50, y: 30 }, p2: { x: 50, y: 30 } }, massName: "main" },
    { edge: { p1: { x: NaN, y: 30 }, p2: { x: 60, y: 30 } }, massName: "main" },
  ];
  const out = collectStepEdges(edges, PERIM, tol);
  assert.equal(out.length, 1);
  assert.equal(out[0].massName, "upper", "first occurrence wins — its mass names the step");
  assert.deepEqual(out[0].edge, shared);
  // Infinity tol (perimeter-only OFF) → no steps at all.
  assert.deepEqual(collectStepEdges(edges, PERIM, Infinity), []);
});

test("collectStepEdges: a DIAGONAL mass-decomposition seam is dropped — real tier boundaries are always H/V", () => {
  const tol = 2;
  const edges = [
    // A genuine axis-aligned tier boundary — kept.
    { edge: { p1: { x: 30, y: 20 }, p2: { x: 70, y: 20 } }, massName: "upper" },
    // Decomposition noise: a 45° diagonal "seam" between two masses —
    // no real architectural tier step ever runs diagonally. Midpoint is
    // still well clear of PERIM so it isn't dropped as perimeter/eave.
    { edge: { p1: { x: 20, y: 30 }, p2: { x: 60, y: 70 } }, massName: "lower" },
    // Near-axis (within the ~12° tolerance) still counts as aligned.
    { edge: { p1: { x: 10, y: 15 }, p2: { x: 90, y: 22 } }, massName: "lower" },
  ];
  const out = collectStepEdges(edges, PERIM, tol);
  assert.equal(out.length, 2, "the 45° diagonal seam is excluded; the H edge and the near-axis edge survive");
  assert.ok(!out.some((o) => o.massName === "lower" && o.edge.p2.y === 70), "the diagonal seam never appears");
  assert.ok(out.some((o) => o.massName === "upper"));
  assert.ok(out.some((o) => o.edge.p1.x === 10 && o.edge.p1.y === 15), "near-axis edge treated as aligned");
});

test("collectStepEdges is LF-neutral: inputs are not mutated and mass eave sums are unchanged", () => {
  const mkEdges = () => [
    { edge: { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, gutter: true }, massName: "main" },
    { edge: { p1: { x: 30, y: 20 }, p2: { x: 70, y: 20 }, gutter: true }, massName: "upper" },
  ];
  const edges = mkEdges();
  const lfOf = (es: ReturnType<typeof mkEdges>) =>
    es
      .filter((s) => s.edge.gutter)
      .reduce((sum, s) => sum + Math.hypot(s.edge.p2.x - s.edge.p1.x, s.edge.p2.y - s.edge.p1.y), 0);
  const before = lfOf(edges);
  collectStepEdges(edges, PERIM, 2);
  assert.equal(lfOf(edges), before, "gutter LF sum untouched");
  assert.deepEqual(edges, mkEdges(), "input objects untouched");
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

// ── round-6: tier-step gate ──────────────────────────────────────────────────

test("shouldDrawTierSteps: only a real multi-level roof draws step lines", async () => {
  const { shouldDrawTierSteps } = await import("./roof-diagram-filter.ts");
  assert.equal(shouldDrawTierSteps([{ tier: "upper" }, { tier: "lower" }]), true);
  // All-upper (the 310-LF 1168G roll that painted full-height seams): no steps.
  assert.equal(shouldDrawTierSteps([{ tier: "upper" }, { tier: "upper" }]), false);
  assert.equal(shouldDrawTierSteps([{ tier: "unknown" }, {}]), false);
  assert.equal(shouldDrawTierSteps([]), false);
  assert.equal(shouldDrawTierSteps(null), false);
  assert.equal(shouldDrawTierSteps(undefined), false);
});
