/**
 * Pure node tests for placeGablesFromFaces. Run:
 *   npx tsx --test lib/ai/place-gables.test.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeGablesFromFaces } from "./place-gables.ts";
import type { FaceReadingRaw, FaceGableRead } from "./face-merge.ts";
import { runRoofEngine } from "../roof-engine.ts";

// 640×510 px outline; at 10 px/ft that's 64×51 ft (the Woodinville overall).
const OUTLINE = [
  { x: 0, y: 0 },
  { x: 640, y: 0 },
  { x: 640, y: 510 },
  { x: 0, y: 510 },
];
const PX_PER_FT = 10;

function g(over: Partial<FaceGableRead>): FaceGableRead {
  return {
    id: "g",
    kind: "other",
    span_ft: 12,
    pitch: 6,
    position_frac: 0.5,
    eave_condition_guess: "flush",
    supported_on: "wall",
    shows_projection_cue: false,
    notes: "",
    ...over,
  };
}
function face(over: Partial<FaceReadingRaw>): FaceReadingRaw {
  return {
    face: "north",
    readable: true,
    unreadable_reason: null,
    gable_count: null,
    continuous_eave: true,
    gables: [],
    projections: [],
    projection_cues: [],
    confidence: "high",
    ...over,
  };
}

test("places a gable at its position along the correct outline edge, facing outward", () => {
  // South face (y = 510 in this y-down frame), one gable at 25% from the left.
  const perFace = {
    south: face({ face: "south", gables: [g({ id: "s1", position_frac: 0.25, span_ft: 16 })] }),
  };
  const { gables } = placeGablesFromFaces(perFace, OUTLINE, PX_PER_FT);
  assert.equal(gables.length, 1);
  const gb = gables[0];
  assert.equal(gb.facing, "S");
  // On the south edge → y = 510. Flush (wall) → projection 0.
  assert.equal(gb.baseCenter.y, 510);
  assert.equal(gb.projection, 0);
  // span 16 ft × 10 px/ft = 160 px.
  assert.equal(gb.span, 160);
});

test("Case 2: a set-back read (set_back_ft) becomes a dormer — setbackFt in px, roof_mounted, no gutter", () => {
  const perFace = {
    north: face({ face: "north", gables: [g({ id: "dormer", set_back_ft: 5, span_ft: 12 })] }),
  };
  const { gables } = placeGablesFromFaces(perFace, OUTLINE, PX_PER_FT);
  assert.equal(gables.length, 1);
  const gb = gables[0];
  assert.equal(gb.setbackFt, 50); // 5 ft × 10 px/ft
  assert.equal(gb.eaveCondition, "roof_mounted"); // treated as a dormer
  assert.equal(gb.projection, 0); // still zero gutter — the eave runs whole in front
});

test("Case 2: a normal at-eave gable has no setbackFt and stays flush", () => {
  const perFace = { north: face({ face: "north", gables: [g({ id: "n1" })] }) };
  const { gables } = placeGablesFromFaces(perFace, OUTLINE, PX_PER_FT);
  assert.equal(gables[0].setbackFt, undefined);
  assert.equal(gables[0].eaveCondition, "flush");
});

test("posts/beam gable is promoted to PROJECTING with a schematic depth + flag", () => {
  const perFace = {
    north: face({ face: "north", gables: [g({ id: "porch", supported_on: "posts", span_ft: 10 })] }),
  };
  const { gables, notes } = placeGablesFromFaces(perFace, OUTLINE, PX_PER_FT);
  assert.equal(gables[0].facing, "N");
  assert.equal(gables[0].eaveCondition, "projecting");
  assert.ok(gables[0].projection > 0, "posts ⇒ projecting depth > 0");
  assert.ok(notes.some((n) => /porch/.test(n) && /verify/.test(n)));
});

test("depth comes from the PLAN (roof area ÷ span) when a matching roof mass is stated", () => {
  const perFace = {
    north: face({
      face: "north",
      gables: [g({ id: "porch", kind: "porch", supported_on: "posts", span_ft: 12 })],
    }),
  };
  // PORCH ROOF = 180 sf, span 12 ft ⇒ depth 15 ft (= 150 px at 10 px/ft).
  const { gables, notes } = placeGablesFromFaces(perFace, OUTLINE, PX_PER_FT, {
    roofMasses: [{ label: "porch", areaFt2: 180 }, { label: "patio", areaFt2: 228 }],
  });
  assert.equal(gables[0].projection, 15 * PX_PER_FT);
  assert.ok(notes.some((n) => /porch roof area 180 sf ÷ 12 ft span/.test(n)));
  // An entry porch shares the "porch" roof-area label.
  const entry = placeGablesFromFaces(
    { north: face({ face: "north", gables: [g({ id: "e", kind: "entry", supported_on: "posts", span_ft: 12 })] }) },
    OUTLINE,
    PX_PER_FT,
    { roofMasses: [{ label: "porch", areaFt2: 180 }] },
  );
  assert.equal(entry.gables[0].projection, 15 * PX_PER_FT);
});

test("two-angle rule: a FRONT porch's depth comes from the PERPENDICULAR (side) elevation", () => {
  // Front (north) porch on posts; the WEST side elevation sees it in profile and
  // measures its depth = 8 ft. That side-elevation depth wins over roof-area.
  const perFace = {
    north: face({ face: "north", gables: [g({ id: "porch", kind: "porch", supported_on: "posts", span_ft: 12 })] }),
    west: face({ face: "west", projections: [{ kind: "porch", depth_ft: 8, notes: "porch in profile" }] }),
  };
  const { gables, notes } = placeGablesFromFaces(perFace, OUTLINE, PX_PER_FT, {
    roofMasses: [{ label: "porch", areaFt2: 180 }], // ÷12 = 15 ft (the cross-check)
  });
  // Side-elevation depth (8 ft) wins, not the 15 ft from roof-area÷span.
  assert.equal(gables[0].projection, 8 * PX_PER_FT);
  assert.ok(notes.some((n) => /side \(perpendicular\) elevation/.test(n)));
  // The two sources disagree by >35% (8 vs 15) → a verify note.
  assert.ok(notes.some((n) => /8 ft from the side elevation vs 15 ft/.test(n)));
});

test("roof-area÷span is used when NO perpendicular projection is available", () => {
  const perFace = {
    north: face({ face: "north", gables: [g({ id: "porch", kind: "porch", supported_on: "posts", span_ft: 12 })] }),
    // no readable side elevation reporting the porch in profile
  };
  const { gables, notes } = placeGablesFromFaces(perFace, OUTLINE, PX_PER_FT, {
    roofMasses: [{ label: "porch", areaFt2: 180 }],
  });
  assert.equal(gables[0].projection, 15 * PX_PER_FT); // 180 ÷ 12
  assert.ok(notes.some((n) => /roof area 180 sf ÷ 12 ft span/.test(n)));
});

test("unread / empty faces contribute nothing; no scale ⇒ nothing", () => {
  assert.equal(
    placeGablesFromFaces({ east: face({ face: "east", readable: false }) }, OUTLINE, PX_PER_FT).gables.length,
    0,
  );
  assert.equal(placeGablesFromFaces({}, OUTLINE, PX_PER_FT).gables.length, 0);
  assert.equal(placeGablesFromFaces({ north: face({ gables: [g({})] }) }, OUTLINE, 0).gables.length, 0);
});

test("jogged front: gables route to the correct sub-edge (bay vs wall), not one principal edge", () => {
  // South (front) face has 3 sub-edges: left wall (y=510), a projecting bay
  // (y=560) in the middle, right wall (y=510). The old single-principal-edge
  // logic squeezed EVERY front gable onto the furthest-out bay; now each gable
  // lands on the sub-edge its position_frac maps to across the full face width.
  const OUTLINE_JOG = [
    { x: 0, y: 0 },
    { x: 640, y: 0 },
    { x: 640, y: 510 },
    { x: 440, y: 510 },
    { x: 440, y: 560 },
    { x: 200, y: 560 },
    { x: 200, y: 510 },
    { x: 0, y: 510 },
  ];
  const perFace = {
    south: face({
      face: "south",
      gables: [
        g({ id: "mid", position_frac: 0.5, span_ft: 12 }), // over the bay
        g({ id: "left", position_frac: 0.05, span_ft: 12 }), // over a wall segment
      ],
    }),
  };
  const { gables } = placeGablesFromFaces(perFace, OUTLINE_JOG, PX_PER_FT);
  assert.equal(gables.length, 2);
  const mid = gables.find((gg) => gg.name === "mid")!;
  const left = gables.find((gg) => gg.name === "left")!;
  // Middle gable sits on the projecting bay edge (y=560); the near-end gable on a
  // flush wall segment (y=510) — proof each routed to its own sub-edge instead of
  // all landing on the single furthest-out edge.
  assert.equal(mid.baseCenter.y, 560);
  assert.equal(left.baseCenter.y, 510);
});

test("end-to-end: placed gables drive the engine → front porch adds guttered side eaves + a valley", () => {
  const perFace = {
    north: face({
      face: "north",
      gable_count: 2,
      gables: [
        g({ id: "front_gable", position_frac: 0.3, span_ft: 14 }), // flush
        g({ id: "front_porch", position_frac: 0.5, span_ft: 10, supported_on: "posts" }), // projecting
      ],
    }),
    south: face({ face: "south", gable_count: 1, gables: [g({ id: "rear_gable", position_frac: 0.5, span_ft: 16 })] }),
  };
  const { gables } = placeGablesFromFaces(perFace, OUTLINE, PX_PER_FT);
  assert.equal(gables.length, 3);

  const res = runRoofEngine([
    { name: "main", outline: OUTLINE, statedArea: null, eaveEdges: [0, 1, 2, 3], gables },
  ]);
  // Only the projecting porch contributes guttered SIDE EAVES (the two flush
  // gable-ends add zero gutter) — but every gable, flush or projecting, draws a
  // ridge-back + two valleys, so all 3 placed gables contribute 6 gable valleys.
  assert.equal(res.masses[0].edges.filter((e) => e.gutter && e.source === "gable:front_porch").length, 2);
  assert.equal(res.masses[0].interior.filter((e) => e.type === "valley" && e.source?.startsWith("gable:")).length, 6);
  assert.equal(res.reviewFlags.filter((f) => f.code === "gable_flush").length, 2);
});
