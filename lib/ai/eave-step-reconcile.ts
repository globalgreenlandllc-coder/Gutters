/**
 * eave-step-reconcile.ts — the ELEVATIONS-FIRST roof-jog cross-check.
 *
 * OWNER DOCTRINE: gutters hang on the ROOF edge, so every jog in the gutter
 * line must come from the ROOF shape. The ROOF-PLAN page (when the set prints
 * one) is the layout truth and its located fascia steps OUTRANK the
 * elevations' eave-line reads; the elevations are the fallback; a
 * wall/footprint jog alone proves nothing (the roof often bridges it).
 * Roof-page steps arrive pre-converted to the VIEWER frame via
 * read-roof-layout's roofPlanViewerSteps (`roofPlanSteps` arg). Concretely:
 *   - a traced roof jog the elevation CONFIRMS (an eave-line break at the same
 *     position) → tagged "roof-verified", nothing changes;
 *   - an eave-line break the trace MISSED → CARVED into the outline (owner
 *     escalation round 3 — "if the roof source shows a jog, there IS a jog"):
 *     a pair of steps becomes a recessed inset (notch) between them, a single
 *     step an L-step to the nearer face corner, always recessed INWARD so the
 *     envelope never grows. Runs riding the recessed span move (and split)
 *     with it, Σ length_ft preserved exactly; the new return walls price or
 *     suggest through the downstream closure pass like any other uncovered
 *     span. A step the carve gates decline falls back to the old
 *     suggest-don't-carve tap-to-add return (estimated — verify);
 *   - a traced wall jog under an elevation that read a STRAIGHT eave → the
 *     roof wins: loud flag, but the run is never deleted or unpriced;
 *   - under a HIP tier step the gutter also returns INSIDE — the inner leg is
 *     emitted as a second unpriced suggestion (skipped when a lower-tier run
 *     already covers it).
 *
 * Degradation contract (doctrine: old stored reads → byte-identical): when NO
 * face carries an `eave_steps` key at all AND no roof-page side carries
 * located steps (older analyses, stale prompt overrides), the input is
 * returned unchanged — the same `sawPositionField` pattern as
 * tier-corner-veto.ts. An unreadable face, or a face without the field,
 * contributes nothing (silent skip). The returned `analysis` is ALWAYS the
 * caller's own object, geometry and priced LF byte-untouched — every output
 * rides the notes / suggestion channels.
 *
 * Viewer→plan mapping uses the SAME rightDir convention as place-gables.ts /
 * tier-corner-veto.ts (rightDir = (n.y, −n.x), y-down canvas, house-relative
 * faces on the front-at-bottom drafting convention) via the exported
 * viewerPositionToPlanDir.
 *
 * PURE + never throws — mirrors reconcile-eaves.ts: any failure returns the
 * input analysis unchanged.
 */

import type { BlueprintAnalysis, BlueprintRun } from "./blueprint-from-plans";
import type { FaceEaveStep, FaceReadingRaw } from "./face-merge";
import { medianFtPerUnit, viewerPositionToPlanDir } from "./tier-corner-veto";
import type { FaceNormals } from "./plan-orientation";
import { isFinitePt } from "../roof-skeleton";
import type { EaveTier } from "../types";

type Pt = { x: number; y: number };

export type EaveStepSuggestion = {
  /** Two-point unpriced segment in ANALYSIS space (same space as
   *  building_footprint / gutter_runs) — the assembler projects it. */
  points: [Pt, Pt];
  tier?: EaveTier;
};

/** Owner escalation: when the roof-plan page rules a side's layout and the
 *  traced footprint carries jogs the page contradicts, straighten them into
 *  the diagram instead of only flagging — "everything should be jogged on
 *  the diagram only if it's jogged on the roof layout." Two passes share
 *  this switch: the whole-side flush splice (page ruled `[]`) and the
 *  per-jog phantom flatten (flattenPhantomJogs — page-matched steps kept,
 *  uncorroborated ones ≤ ~8 ft pressed flat, followers carried). Default
 *  ON; BLUEPRINT_EAVE_STEP_STRAIGHTEN=0 restores flag-only behavior. */
export function eaveStepStraightenEnabled(override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  return process.env.BLUEPRINT_EAVE_STEP_STRAIGHTEN !== "0";
}

/** Owner escalation round 3 — the missing half of the straighten passes:
 *  where a ruling roof source (roof-plan page first, elevation eave line
 *  second) locates a fascia step the trace MISSED, the jog is CARVED into
 *  the outline instead of only suggested — "everything jogs on the diagram
 *  exactly where it jogs on the roof." Default ON;
 *  BLUEPRINT_EAVE_STEP_CARVE=0 restores suggest-don't-carve. */
export function eaveStepCarveEnabled(override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  return process.env.BLUEPRINT_EAVE_STEP_CARVE !== "0";
}

/** A carved recess never goes deeper than this — anything deeper is a real
 *  building mass a schematic carve must not invent (same ceiling as the
 *  phantom-flatten shift cap). */
const MAX_CARVE_DEPTH_FT = 8;

export type EaveStepReconcileResult = {
  /** The caller's analysis object. Σ PRICED LF (total length_ft, totals) is
   *  preserved in every branch — byte-untouched except where a carve splits a
   *  run into proportional pieces (sum exact). Geometry is touched only by
   *  the carve escalation (eaveStepCarveEnabled — recessed jogs pressed INTO
   *  the outline where the ruling roof source locates them) and the two
   *  straightening escalations (see eaveStepStraightenEnabled): the
   *  flush-face splice (building_footprint loses the jog's interior
   *  vertices; stale excluded_edges on them dropped; runs untouched) and
   *  the per-jog phantom flatten (sub-edges pressed onto the dominant
   *  fascia line, with run/downspout/excluded-edge COORDINATES riding the
   *  shifted sub-edges — length_ft never rewritten, length_px recomputed).
   *  Any newly-exposed gap is priced or suggested by the normal downstream
   *  perimeter-closure pass, same as any other mid-wall gap. */
  analysis: BlueprintAnalysis;
  /** Roof-verified confirmations + suggest-don't-carve notes (loud). */
  notes: string[];
  /** Unpriced tap-to-add returns for eave steps the trace missed (+ hip
   *  inner-return legs). Never summed into priced LF. */
  suggestedEaves: EaveStepSuggestion[];
  /** Traced jogs an elevation eave-line break confirmed ("face@frac"). */
  verifiedJogIds: string[];
  /** Ruling-source steps the trace missed that were CARVED into the outline
   *  ("face@frac") — see eaveStepCarveEnabled. Σ length_ft is preserved
   *  exactly (runs shift/split proportionally, never resized in total). */
  carvedJogIds: string[];
  /** Traced jogs the same face's elevation CONTRADICTS (straight eave read
   *  where the trace steps) — flag-only, nothing deleted or unpriced. */
  wallJogFlags: string[];
};

/** The two faces perpendicular to a face — where this face's pop-out depths
 *  are measurable in profile. House-relative words first (the per-face reads'
 *  keys); compass kept for compass-keyed legacy reads. */
const PERP: Record<string, string[]> = {
  front: ["left", "right"],
  rear: ["left", "right"],
  back: ["left", "right"],
  left: ["front", "rear"],
  right: ["front", "rear"],
  north: ["east", "west"],
  south: ["east", "west"],
  east: ["north", "south"],
  west: ["north", "south"],
};

const plausibleDepthFt = (d: unknown): d is number =>
  typeof d === "number" && Number.isFinite(d) && d >= 2 && d <= 40;

/** Schematic return depth when no perpendicular profile measured one. */
const SCHEMATIC_DEPTH_FT = 4;

// ————————————————————————————————————————————————————————————————————————
// Face geometry — adapted from place-gables.ts faceEdges/faceU (copied, not
// imported: those helpers are module-private there and place-gables is owned
// by another concern). Same math, same conventions.
// ————————————————————————————————————————————————————————————————————————

/** Along-face scalar that increases to the viewer's RIGHT. */
const faceU = (p: Pt, rd: Pt): number => p.x * rd.x + p.y * rd.y;

/** Coordinate-tolerance point match (excluded_edges carry independently-
 *  parsed {x,y}, never ring object references). */
const near = (a: Pt, b: Pt, tol: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

type FaceEdge = { L: Pt; R: Pt; uL: number; uR: number; out: number };

/** Every outline edge on the side with outward normal `n`, oriented viewer
 *  left→right and sorted by uL — recessed/projecting jog sub-edges included,
 *  the opposite (back) half excluded. Mirrors place-gables.ts faceEdges. */
function faceEdges(poly: Pt[], n: Pt, rd: Pt): FaceEdge[] {
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p.x;
    cy += p.y;
  }
  cx /= poly.length;
  cy /= poly.length;
  const centroidProj = cx * n.x + cy * n.y;
  const edges: FaceEdge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= 0) continue;
    // Skip edges running ALONG the normal — those are the step connectors /
    // perpendicular sides, not this face's eave sub-edges.
    if (Math.abs((dx / len) * n.x + (dy / len) * n.y) > 0.5) continue;
    const out = ((a.x + b.x) / 2) * n.x + ((a.y + b.y) / 2) * n.y;
    if (out < centroidProj) continue; // opposite (back) half
    const [L, R] = faceU(a, rd) <= faceU(b, rd) ? [a, b] : [b, a];
    edges.push({ L, R, uL: faceU(L, rd), uR: faceU(R, rd), out });
  }
  edges.sort((e1, e2) => e1.uL - e2.uL);
  return edges;
}

/** The outline point at along-face position `u`, on the OUTERMOST sub-edge
 *  covering it (falling back to the nearest sub-edge in a gap) — where a
 *  suggested return anchors on the drawn eave. */
function pointAtU(edges: FaceEdge[], u: number, eps = 1e-6): Pt {
  const covers = edges.filter(
    (e) => u >= Math.min(e.uL, e.uR) - eps && u <= Math.max(e.uL, e.uR) + eps,
  );
  const pool = covers.length ? covers : edges;
  let pick = pool[0];
  for (const e of pool) {
    if (covers.length) {
      if (e.out > pick.out) pick = e;
    } else {
      const d = Math.min(Math.abs(u - e.uL), Math.abs(u - e.uR));
      const dp = Math.min(Math.abs(u - pick.uL), Math.abs(u - pick.uR));
      if (d < dp) pick = e;
    }
  }
  const denom = pick.uR - pick.uL;
  const s = denom !== 0 ? Math.max(0, Math.min(1, (u - pick.uL) / denom)) : 0;
  return { x: pick.L.x + (pick.R.x - pick.L.x) * s, y: pick.L.y + (pick.R.y - pick.L.y) * s };
}

/**
 * Collapse a face's jogged sub-edges into ONE straight edge — the flush-face
 * escalation's core geometry op. Only fires on a genuine "one flush plane +
 * a recessed notch(es)" shape: the face's two OUTERMOST sub-edges (edges[0]
 * and the last one, both already sorted by uL) must sit at the same depth
 * within `depthTolU`, so the new edge is one sensible flush line rather than
 * a forced diagonal across what might actually be a real multi-level
 * staircase.
 *
 * edges[0].R and edges[1].L are usually NOT the same ring vertex — a real
 * notch has a PERPENDICULAR connector edge (the jog's own return leg)
 * sitting between them, which faceEdges() deliberately excludes from `edges`
 * (it runs along the normal, not across the face). So this walks the RING
 * by index span from edges[0].L to edges[last].R, trying BOTH winding
 * directions — picking "whichever is shorter" is not safe on its own (a
 * short-way-around through an UNRELATED part of the building can beat the
 * jog's own longer local detour), so the accepted direction is instead the
 * one whose interior vertices actually CONTAIN every intermediate sub-edge's
 * own L/R points (edges[1..last-1]), confirming the walk passes through this
 * face's own jog and nothing else. A sanity cap keeps the removed span
 * small and local even then. Returns null (no-op) on anything short of
 * that; the caller falls back to flag-only.
 */
function spliceStraightFace(
  ring: readonly Pt[],
  edges: readonly FaceEdge[],
  depthTolU: number,
): { ring: Pt[]; removedSubEdges: { a: Pt; b: Pt }[] } | null {
  if (edges.length < 2) return null;
  if (Math.abs(edges[0].out - edges[edges.length - 1].out) > depthTolU) return null;
  const n = ring.length;
  const headIdx = ring.indexOf(edges[0].L);
  const tailIdx = ring.indexOf(edges[edges.length - 1].R);
  if (headIdx < 0 || tailIdx < 0 || headIdx === tailIdx) return null;
  const mustContain = new Set<Pt>();
  for (let i = 0; i + 1 < edges.length; i++) {
    mustContain.add(edges[i].R);
    mustContain.add(edges[i + 1].L);
  }
  for (const dir of [1, -1] as const) {
    const span =
      dir === 1
        ? (((tailIdx - headIdx) % n) + n) % n
        : (((headIdx - tailIdx) % n) + n) % n;
    if (span < 1 || span > n - 2 || span > Math.max(6, edges.length * 3)) continue;
    const interiorIdx: number[] = [];
    for (let k = 1; k < span; k++) interiorIdx.push((((headIdx + dir * k) % n) + n) % n);
    const interiorSet = new Set(interiorIdx.map((i) => ring[i]));
    let ok = mustContain.size > 0;
    for (const p of mustContain) {
      if (!interiorSet.has(p)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const dropIdx = new Set(interiorIdx);
    const spliced: Pt[] = [];
    for (let i = 0; i < n; i++) if (!dropIdx.has(i)) spliced.push(ring[i]);
    return {
      ring: spliced,
      removedSubEdges: edges.map((e) => ({ a: e.L, b: e.R })),
    };
  }
  return null;
}

/**
 * PER-JOG PHANTOM FLATTENING (owner escalation round 2 — the 1168G BIDSET
 * canvas: nine "WALL JOG, STRAIGHT ROOF" flags drew nine random pop-outs the
 * roof plan contradicts, and flag-only left the diagram "totally wrong").
 * Doctrine: the diagram jogs ONLY where the roof layout jogs. On a
 * roof-page-ruled side, every traced step the page does NOT corroborate is
 * flattened INDIVIDUALLY: the face's sub-edges are grouped between REAL
 * (page-matched) steps / physical gaps, and each group containing a phantom
 * step is pressed onto its dominant fascia line (the depth carrying the most
 * width in the group). Page-matched steps sit on group boundaries, so they
 * survive untouched.
 *
 * Safety gates, all bail-to-flag-only:
 *  - only roof-page-ruled sides (the elevations alone never flatten);
 *  - per-edge shift capped at `maxShiftU` (~8 ft) — a deep step is a real
 *    mass, not a trace pop-out, even if the page missed it;
 *  - a group whose ANY edge exceeds the cap is left whole.
 *
 * Followers ride along (the rectifyPlanFootprint pattern): run endpoints,
 * downspout marks and excluded-edge endpoints sitting ON a shifted sub-edge
 * move by the same perpendicular delta — length_ft (the priced value) is
 * never touched, only the drawn coordinates.
 */
function flattenPhantomJogs(args: {
  ring: readonly Pt[];
  edges: readonly FaceEdge[];
  n: Pt;
  /** Sanitized roof-page step positions on this face's u axis. */
  roofUs: readonly number[];
  tolU: number;
  minDepthU: number;
  gapTolU: number;
  maxShiftU: number;
}): {
  ring: Pt[];
  /** Old sub-edge span + the normal delta it moved by (follower carry). */
  moved: { a: Pt; b: Pt; delta: number }[];
  /** Along-face fractions (0..1) of the flattened phantom steps. */
  flattenedU: number[];
} | null {
  const { edges, n, roofUs, tolU, minDepthU, gapTolU, maxShiftU } = args;
  if (edges.length < 2) return null;

  // Group boundaries: a physical gap or a page-corroborated (REAL) step ends
  // the group; a phantom step (or a flush continuation) keeps it open.
  type Group = { idx: number[]; phantomUs: number[] };
  const groups: Group[] = [];
  let cur: Group = { idx: [0], phantomUs: [] };
  for (let i = 0; i + 1 < edges.length; i++) {
    const e1 = edges[i];
    const e2 = edges[i + 1];
    const contiguous = Math.abs(e2.uL - e1.uR) <= gapTolU;
    const depthU = Math.abs(e2.out - e1.out);
    const isStep = contiguous && depthU >= minDepthU;
    const stepU = (e1.uR + e2.uL) / 2;
    const isReal = isStep && roofUs.some((u) => Math.abs(u - stepU) <= tolU);
    if (!contiguous || isReal) {
      groups.push(cur);
      cur = { idx: [i + 1], phantomUs: [] };
    } else {
      if (isStep) cur.phantomUs.push(stepU);
      cur.idx.push(i + 1);
    }
  }
  groups.push(cur);

  const deltaByPt = new Map<Pt, number>();
  const moved: { a: Pt; b: Pt; delta: number }[] = [];
  const flattenedU: number[] = [];
  for (const g of groups) {
    if (g.phantomUs.length === 0 || g.idx.length < 2) continue;
    // Dominant fascia line: cluster the group's depths, weight by u-width.
    const clusterTol = Math.max(minDepthU / 2, 1e-9);
    const members = g.idx.map((i) => edges[i]);
    const clusters: { out: number; weight: number; edges: FaceEdge[] }[] = [];
    for (const e of members) {
      const w = Math.abs(e.uR - e.uL);
      const c = clusters.find((cl) => Math.abs(cl.out - e.out) <= clusterTol);
      if (c) {
        c.out = (c.out * c.weight + e.out * w) / (c.weight + w || 1);
        c.weight += w;
        c.edges.push(e);
      } else {
        clusters.push({ out: e.out, weight: w, edges: [e] });
      }
    }
    clusters.sort((a, b) => b.weight - a.weight);
    const target = clusters[0].out;
    // Cap: any member needing a deeper shift than maxShiftU = real mass, bail
    // on the WHOLE group (it stays flag-only downstream).
    if (members.some((e) => Math.abs(target - e.out) > maxShiftU)) continue;
    for (const e of members) {
      const d = target - e.out;
      if (Math.abs(d) < 1e-9) continue;
      deltaByPt.set(e.L, d);
      deltaByPt.set(e.R, d);
      moved.push({ a: { ...e.L }, b: { ...e.R }, delta: d });
    }
    flattenedU.push(...g.phantomUs);
  }
  if (moved.length === 0) return null;

  // Apply the shifts, then collapse the connectors that became zero-length.
  const shifted = args.ring.map((p) => {
    const d = deltaByPt.get(p);
    return d !== undefined ? { x: p.x + n.x * d, y: p.y + n.y * d } : { x: p.x, y: p.y };
  });
  const dedupeTol = Math.max(1e-9, minDepthU * 0.05);
  const out: Pt[] = [];
  for (const p of shifted) {
    const prev = out[out.length - 1];
    if (prev && near(prev, p, dedupeTol)) continue;
    out.push(p);
  }
  while (out.length > 1 && near(out[0], out[out.length - 1], dedupeTol)) out.pop();
  if (out.length < 4) return null;
  return { ring: out, moved, flattenedU };
}

/** Point-to-segment distance — the follower "sits on this sub-edge" test. */
function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

// ————————————————————————————————————————————————————————————————————————
// ROOF-JOG CARVE (owner escalation round 3, eaveStepCarveEnabled) — the
// geometry ops that press a ruling-source step INTO the outline. Both shapes
// are strictly local and strictly INWARD (the envelope never grows):
//   notch — two steps bracketing a recessed middle: the covering sub-edge
//           gains 4 vertices (outer → inner → inner → outer);
//   lstep — one step whose recessed span reaches the face corner: the corner
//           vertex slides inward and the step's two vertices are inserted,
//           which also shortens the perpendicular face's edge (that IS the
//           real geometry of a corner recess).
// ————————————————————————————————————————————————————————————————————————

type CarveOp =
  | { kind: "notch"; u1: number; u2: number }
  | { kind: "lstep"; u: number; side: "after" | "before" };

/** Locate a face sub-edge in the ring as a consecutive index pair (either
 *  winding). faceEdges keeps ring object references, so identity works. */
function ringEdgeIndex(
  ring: readonly Pt[],
  E: FaceEdge,
): { i: number; forward: boolean } | null {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (a === E.L && b === E.R) return { i, forward: true };
    if (a === E.R && b === E.L) return { i, forward: false };
  }
  return null;
}

/**
 * Carve one op into the ring. Returns the new ring plus the OLD outer span
 * the recess replaced (the follower-carry anchor) and its u-extent; null on
 * any gate miss (the caller falls back to suggest-don't-carve):
 *  - the step position(s) must sit on ONE straight covering sub-edge with
 *    `marginU` of room (a step already at a corner has nothing to carve);
 *  - an lstep's covering sub-edge must actually REACH the face corner on the
 *    recessed side (its far endpoint is the face extreme — otherwise the
 *    "span to the corner" would cross other structure).
 */
function carveIntoRing(args: {
  ring: readonly Pt[];
  edges: readonly FaceEdge[];
  n: Pt;
  op: CarveOp;
  depthU: number;
  marginU: number;
  uMin: number;
  uMax: number;
}): { ring: Pt[]; span: { a: Pt; b: Pt }; uSpan: [number, number] } | null {
  const { edges, n, op, depthU, marginU, uMin, uMax } = args;
  const v = { x: -n.x * depthU, y: -n.y * depthU };
  const at = (E: FaceEdge, u: number): Pt => {
    const denom = E.uR - E.uL;
    const s = denom !== 0 ? (u - E.uL) / denom : 0;
    return { x: E.L.x + (E.R.x - E.L.x) * s, y: E.L.y + (E.R.y - E.L.y) * s };
  };
  const add = (p: Pt): Pt => ({ x: p.x + v.x, y: p.y + v.y });

  if (op.kind === "notch") {
    const E = edges.find((e) => op.u1 >= e.uL + marginU && op.u2 <= e.uR - marginU);
    if (!E) return null;
    const idx = ringEdgeIndex(args.ring, E);
    if (!idx) return null;
    const P1 = at(E, op.u1);
    const P2 = at(E, op.u2);
    const ins = idx.forward
      ? [P1, add(P1), add(P2), P2]
      : [P2, add(P2), add(P1), P1];
    const ring = [...args.ring.slice(0, idx.i + 1), ...ins, ...args.ring.slice(idx.i + 1)];
    return { ring, span: { a: { ...P1 }, b: { ...P2 } }, uSpan: [op.u1, op.u2] };
  }

  // lstep — the recessed span runs from the step to the face corner.
  const cornerEnd = op.side === "after" ? uMax : uMin;
  const E = edges.find(
    (e) =>
      op.u >= e.uL + marginU &&
      op.u <= e.uR - marginU &&
      (op.side === "after" ? e.uR >= cornerEnd - marginU : e.uL <= cornerEnd + marginU),
  );
  if (!E) return null;
  const idx = ringEdgeIndex(args.ring, E);
  if (!idx) return null;
  const cornerPt = op.side === "after" ? E.R : E.L;
  const Pu = at(E, op.u);
  const cornerNew = add(cornerPt);
  const base = args.ring.map((p) => (p === cornerPt ? cornerNew : p));
  // Insert the step pair between the kept-outer half and the recessed corner,
  // ordered by the ring's own winding.
  // Winding decides which of the pair comes first; the pair always sits
  // between ring[i] and ring[i+1] (verified for all four side×winding cases).
  const stepPair =
    (op.side === "after") === idx.forward ? [Pu, add(Pu)] : [add(Pu), Pu];
  const ring = [...base.slice(0, idx.i + 1), ...stepPair, ...base.slice(idx.i + 1)];
  return {
    ring,
    span: { a: { ...Pu }, b: { x: cornerPt.x, y: cornerPt.y } },
    uSpan: op.side === "after" ? [op.u, E.uR] : [E.uL, op.u],
  };
}

/**
 * Carry the followers through one carve: runs lying ALONG the old outer span
 * shift into the recess — split at the recess boundary when they cross it
 * (pieces share the parent's Σ length_ft EXACTLY: proportional by px,
 * rounded to 0.1, remainder on the last piece; the LONGEST piece keeps the
 * parent id so downspout from_gutter refs stay live). A perpendicular run or
 * downspout TOUCHING the moved span carries its endpoint the same way the
 * phantom-flatten carries its followers. Priced length_ft is never resized
 * in total.
 */
function carryCarveFollowers<
  D extends { at?: Pt },
  X extends { start: Pt; end: Pt },
>(args: {
  runs: BlueprintRun[];
  dss: D[];
  excluded: X[];
  span: { a: Pt; b: Pt };
  n: Pt;
  rd: Pt;
  depthU: number;
  uSpan: [number, number];
  snapTol: number;
  minOverlapU: number;
}): {
  runs: BlueprintRun[];
  dss: D[];
  excluded: X[];
  touched: boolean;
} {
  const { span, n, rd, depthU, uSpan, snapTol, minOverlapU } = args;
  const v = { x: -n.x * depthU, y: -n.y * depthU };
  const [uA, uB] = uSpan;
  const lineDist = (p: Pt): number =>
    Math.abs((p.x - span.a.x) * n.x + (p.y - span.a.y) * n.y);
  const shift = (p: Pt): Pt => ({ x: p.x + v.x, y: p.y + v.y });
  let touched = false;

  const round1 = (x: number): number => Math.round(x * 10) / 10;
  const runsOut: BlueprintRun[] = [];
  for (const r of args.runs) {
    if (!isFinitePt(r.start as Pt) || !isFinitePt(r.end as Pt)) {
      runsOut.push(r);
      continue;
    }
    const dx = r.end.x - r.start.x;
    const dy = r.end.y - r.start.y;
    const len = Math.hypot(dx, dy);
    const parallel =
      len > 0 && Math.abs((dx / len) * rd.x + (dy / len) * rd.y) > 0.9;
    const onLine =
      lineDist(r.start) <= snapTol && lineDist(r.end) <= snapTol;
    if (parallel && onLine) {
      const u0 = faceU(r.start, rd);
      const u1 = faceU(r.end, rd);
      const lo = Math.min(u0, u1);
      const hi = Math.max(u0, u1);
      const ovLo = Math.max(lo, uA);
      const ovHi = Math.min(hi, uB);
      if (ovHi - ovLo <= minOverlapU) {
        runsOut.push(r); // touches at most a sliver — leave it
        continue;
      }
      if (lo >= uA - minOverlapU && hi <= uB + minOverlapU) {
        // fully inside the recess — the whole run rides inward
        touched = true;
        runsOut.push({ ...r, start: shift(r.start), end: shift(r.end) });
        continue;
      }
      // crosses a recess boundary — split at the boundary t's
      const ts = [0, 1];
      const denomU = u1 - u0;
      for (const ub of [ovLo, ovHi]) {
        const t = denomU !== 0 ? (ub - u0) / denomU : 0;
        if (t > 1e-6 && t < 1 - 1e-6) ts.push(t);
      }
      ts.sort((a, b) => a - b);
      const pieces: { start: Pt; end: Pt; px: number; inside: boolean }[] = [];
      for (let i = 0; i + 1 < ts.length; i++) {
        const pA = {
          x: r.start.x + dx * ts[i],
          y: r.start.y + dy * ts[i],
        };
        const pB = {
          x: r.start.x + dx * ts[i + 1],
          y: r.start.y + dy * ts[i + 1],
        };
        const midU = faceU({ x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 }, rd);
        pieces.push({
          start: pA,
          end: pB,
          px: Math.hypot(pB.x - pA.x, pB.y - pA.y),
          inside: midU > ovLo && midU < ovHi,
        });
      }
      const real = pieces.filter((p) => p.px > 1e-6);
      if (real.length < 2) {
        runsOut.push(r);
        continue;
      }
      touched = true;
      const totalPx = real.reduce((s, p) => s + p.px, 0);
      const totalFt = typeof r.length_ft === "number" ? r.length_ft : null;
      const longest = real.reduce((m, p) => (p.px > m.px ? p : m), real[0]);
      let ftLeft = totalFt ?? 0;
      real.forEach((p, i) => {
        const last = i === real.length - 1;
        const ft =
          totalFt == null
            ? undefined
            : last
              ? round1(ftLeft)
              : round1((totalFt * p.px) / totalPx);
        if (ft != null) ftLeft = round1(ftLeft - ft);
        const start = p.inside ? shift(p.start) : p.start;
        const end = p.inside ? shift(p.end) : p.end;
        runsOut.push({
          ...r,
          id: p === longest ? r.id : `${r.id}_c${i + 1}`,
          start,
          end,
          length_px: Math.hypot(end.x - start.x, end.y - start.y),
          ...(ft != null ? { length_ft: ft } : {}),
        });
      });
      continue;
    }
    // Not a same-line run — carry an endpoint that TOUCHES the moved span
    // (the perpendicular neighbor at a recessed corner).
    const s2 = distToSeg(r.start, span.a, span.b) <= snapTol ? shift(r.start) : r.start;
    const e2 = distToSeg(r.end, span.a, span.b) <= snapTol ? shift(r.end) : r.end;
    if (s2 === r.start && e2 === r.end) {
      runsOut.push(r);
      continue;
    }
    touched = true;
    runsOut.push({
      ...r,
      start: s2,
      end: e2,
      length_px: Math.hypot(e2.x - s2.x, e2.y - s2.y),
    });
  }

  const dssOut = args.dss.map((d) => {
    if (!d || !isFinitePt(d.at as Pt)) return d;
    if (distToSeg(d.at as Pt, span.a, span.b) > snapTol) return d;
    touched = true;
    return { ...d, at: shift(d.at as Pt) };
  });
  const exclOut = args.excluded.map((ee) => {
    if (!isFinitePt(ee.start as Pt) || !isFinitePt(ee.end as Pt)) return ee;
    const s2 = distToSeg(ee.start, span.a, span.b) <= snapTol ? shift(ee.start) : ee.start;
    const e2 = distToSeg(ee.end, span.a, span.b) <= snapTol ? shift(ee.end) : ee.end;
    return s2 === ee.start && e2 === ee.end ? ee : { ...ee, start: s2, end: e2 };
  });

  return { runs: runsOut, dss: dssOut, excluded: exclOut, touched };
}

/** A TRACED roof step on one face: two same-face sub-edges meeting (in u) at
 *  different depths — the perpendicular connector between them is the jog the
 *  footprint already carries. */
type TracedStep = {
  /** Along-face position of the step (viewer frame u). */
  u: number;
  /** Depth of the jog, in ring units. */
  depthU: number;
  /** The step's corner on the INNER (closer to the house core) sub-edge. */
  innerPt: Pt;
};

function tracedStepsOf(edges: FaceEdge[], minDepthU: number, gapTolU: number): TracedStep[] {
  const out: TracedStep[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const e1 = edges[i];
    const e2 = edges[i + 1];
    if (Math.abs(e2.uL - e1.uR) > gapTolU) continue; // not contiguous along the face
    const depthU = Math.abs(e2.out - e1.out);
    if (!(depthU >= minDepthU)) continue;
    out.push({
      u: (e1.uR + e2.uL) / 2,
      depthU,
      innerPt: e1.out <= e2.out ? { ...e1.R } : { ...e2.L },
    });
  }
  return out;
}

// ————————————————————————————————————————————————————————————————————————
// Segment-coverage test — replicates reconcile-eaves.ts coveredFraction (a
// module-private helper there) so a hip inner-return suggestion is skipped
// when an existing lower-tier run already covers that segment.
// ————————————————————————————————————————————————————————————————————————

function segCoveredFraction(a: Pt, b: Pt, runs: readonly BlueprintRun[], tol: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return 0;
  const ux = dx / len;
  const uy = dy / len;
  const perp = (p: Pt) => Math.abs((p.x - a.x) * -uy + (p.y - a.y) * ux);
  const t = (p: Pt) => ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
  const ivals: [number, number][] = [];
  for (const r of runs) {
    if (!isFinitePt(r.start as Pt) || !isFinitePt(r.end as Pt)) continue;
    if (perp(r.start) > tol || perp(r.end) > tol) continue;
    let t0 = t(r.start);
    let t1 = t(r.end);
    if (t0 > t1) [t0, t1] = [t1, t0];
    const lo = Math.max(0, t0);
    const hi = Math.min(1, t1);
    if (hi > lo) ivals.push([lo, hi]);
  }
  if (ivals.length === 0) return 0;
  ivals.sort((p, q) => p[0] - q[0]);
  let total = 0;
  let curLo = ivals[0][0];
  let curHi = ivals[0][1];
  for (let i = 1; i < ivals.length; i++) {
    const [lo, hi] = ivals[i];
    if (lo <= curHi) curHi = Math.max(curHi, hi);
    else {
      total += curHi - curLo;
      curLo = lo;
      curHi = hi;
    }
  }
  total += curHi - curLo;
  return total;
}

/** First plausible profiled depth (ft) a readable PERPENDICULAR face measured
 *  — how a suggested return is sized (never from offset_ft: that's vertical). */
function perpendicularDepthFt(
  face: string,
  perFace: Partial<Record<string, FaceReadingRaw | undefined>>,
): number | null {
  for (const pf of PERP[face] ?? []) {
    const r = perFace[pf];
    if (!r || r.readable === false) continue;
    for (const p of r.projections ?? []) {
      if (p && plausibleDepthFt(p.depth_ft)) return p.depth_ft as number;
    }
  }
  return null;
}

/**
 * MIRROR CHECK (pure, flag-only): for the front/rear sides, does the trace's
 * own step pattern line up with the roof page's pattern significantly better
 * under a left-right MIRROR? A canvas x-flip flips the VIEWER fraction of
 * every front/rear step (the left/right faces instead SWAP under a mirror,
 * so they can't be compared this way). Compares the total |frac diff| both
 * ways across ≥2 steps on each side; per-step average must improve by >15%
 * of the side's length AND the flipped fit must actually land (<10% avg).
 * Returns ONE loud note naming the qualifying side(s), or null. NEVER flips
 * geometry — verification is the owner's job.
 */
export function detectStepMirror(
  entries: { face: string; roofFracs: number[]; tracedFracs: number[] }[],
): string | null {
  try {
    const flagged: string[] = [];
    for (const e of entries) {
      if (e.face !== "front" && e.face !== "rear") continue;
      const roof = e.roofFracs.filter((f) => Number.isFinite(f) && f >= 0 && f <= 1);
      const traced = e.tracedFracs.filter((f) => Number.isFinite(f));
      if (roof.length < 2 || traced.length < 2) continue; // 1-step: too weak
      const avgCost = (fr: number[]): number =>
        fr.reduce((s, f) => s + Math.min(...traced.map((t) => Math.abs(t - f))), 0) /
        fr.length;
      const direct = avgCost(roof);
      const mirrored = avgCost(roof.map((f) => 1 - f));
      if (mirrored < 0.1 && direct - mirrored > 0.15) flagged.push(e.face);
    }
    if (flagged.length === 0) return null;
    return (
      `🪞 TRACE MAY BE MIRRORED left-right — the roof page's fascia steps on the ` +
      `${flagged.join(" + ")} side${flagged.length > 1 ? "s" : ""} line up with the ` +
      `trace only when flipped; verify the canvas orientation against the plan.`
    );
  } catch {
    return null;
  }
}

/**
 * Cross-check every readable face's eave-line breaks (`eave_steps`) — and,
 * when the roof-plan page located its fascia steps, THOSE (they outrank the
 * elevation where both report a side) — against the traced footprint's
 * same-face jogs. The returned analysis is always the caller's own object;
 * Σ priced LF is preserved in every branch (see EaveStepReconcileResult), and
 * geometry moves only under the carve/straighten escalations.
 */
export function reconcileEaveSteps(args: {
  analysis: BlueprintAnalysis;
  perFace: Partial<Record<string, FaceReadingRaw | undefined>> | null | undefined;
  /** Compass→canvas normals for compass-keyed reads; house-relative keys use
   *  the fixed front-at-bottom drafting convention regardless. */
  faceNormals?: FaceNormals | null;
  /** Roof-plan page fascia steps, ALREADY converted to the viewer frame per
   *  face (read-roof-layout.ts roofPlanViewerSteps — the one converter that
   *  owns the plan-frame → viewer-frame convention). Where a face appears
   *  here it OUTRANKS that face's elevation eave_steps; `[]` = an explicit
   *  straight side (arms the wall-jog flag); null/absent = no roof-page
   *  positions → byte-identical legacy behavior. */
  roofPlanSteps?: Partial<Record<string, FaceEaveStep[] | undefined>> | null;
}): EaveStepReconcileResult {
  const unchanged: EaveStepReconcileResult = {
    analysis: args.analysis,
    notes: [],
    suggestedEaves: [],
    verifiedJogIds: [],
    carvedJogIds: [],
    wallJogFlags: [],
  };
  try {
    // perFace may be absent while the roof page still located steps — the
    // page alone is a valid source (it outranks the elevations anyway).
    const perFace = args.perFace ?? {};

    // Roof-page located steps (viewer frame, pre-converted). A face present
    // here OUTRANKS that face's elevation eave_steps.
    const roofFaces = Object.entries(args.roofPlanSteps ?? {}).filter(
      (e): e is [string, FaceEaveStep[]] => Array.isArray(e[1]),
    );

    // 1. DEGRADATION — no face anywhere carries the eave_steps key AND the
    //    roof page located no steps (old stored reads / stale prompt
    //    override) → byte-identical passthrough.
    const entries = Object.entries(perFace).filter(
      (e): e is [string, FaceReadingRaw] => !!e[1],
    );
    const sawField =
      entries.some(([, r]) => Array.isArray(r.eave_steps)) || roofFaces.length > 0;
    if (!sawField) return unchanged;

    let ring = (args.analysis.building_footprint ?? [])
      .filter((p) => isFinitePt(p as Pt))
      .map((p) => ({ x: p.x, y: p.y }));
    if (ring.length < 4) return unchanged;
    // Flush-face straightening escalation (see eaveStepStraightenEnabled):
    // tracked separately from `ring` above/below so a bail anywhere keeps
    // building_footprint/excluded_edges byte-identical, same as every other
    // guard in this file.
    let excludedEdges = (args.analysis.excluded_edges ?? []).slice();
    let footprintTouched = false;
    // Follower working copies for the per-jog flatten (runs/downspouts ride a
    // shifted sub-edge like rectifyPlanFootprint's followers). Written back
    // only when a flatten actually fired.
    let runsW = (args.analysis.gutter_runs ?? []).slice();
    let dssW = (args.analysis.downspouts ?? []).slice();
    let followersTouched = false;
    const straightenOn = eaveStepStraightenEnabled();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const ringSpan = Math.max(maxX - minX, maxY - minY);
    if (!(Number.isFinite(ringSpan) && ringSpan > 0)) return unchanged;
    // Coordinate-match tolerance for excluded_edges cleanup (they carry
    // independently-parsed {x,y}, not ring object references).
    const vTol = Math.max(1, ringSpan * 0.002);

    const ftPerUnit = medianFtPerUnit(args.analysis.gutter_runs);
    const ftToU = (ft: number): number =>
      ftPerUnit != null && ftPerUnit > 0 ? ft / ftPerUnit : ringSpan * 0.015 * ft;
    // (no-scale fallback: ~1.5% of the span per foot ≈ a 65 ft building)

    const notes: string[] = [];
    const suggestedEaves: EaveStepSuggestion[] = [];
    const verifiedJogIds: string[] = [];
    const carvedJogIds: string[] = [];
    const wallJogFlags: string[] = [];
    /** front/rear step patterns for the mirror check (roof-page-ruled only —
     *  the elevations ARE viewer-frame by definition, only the plan-frame
     *  page can expose a flipped canvas). */
    const mirrorEntries: { face: string; roofFracs: number[]; tracedFracs: number[] }[] = [];

    // Union of faces: every elevation face + every roof-page side with
    // located steps (a side the elevations never read can still be checked).
    const perFaceMap = new Map(entries);
    const roofMap = new Map(roofFaces);
    const faces = [...new Set([...perFaceMap.keys(), ...roofMap.keys()])];

    for (const face of faces) {
      const r = perFaceMap.get(face);
      const roofArr = roofMap.get(face);
      const fromRoofPlan = roofArr !== undefined;

      let stepsRaw: FaceEaveStep[];
      if (fromRoofPlan) {
        // PRIORITY: the roof page located this side's steps — it rules, even
        // over a readable elevation's own eave_steps (note says which ruled).
        stepsRaw = roofArr;
        if (r && r.readable !== false && Array.isArray(r.eave_steps)) {
          notes.push(
            `📄 Roof-plan page fascia steps ruled the ${face} side — the page's located steps outrank the ${face} elevation's eave-step read (both sources reported this side).`,
          );
        }
      } else {
        // (6) unreadable face, or the field absent on THIS face → silent skip.
        if (!r || r.readable === false) continue;
        if (!Array.isArray(r.eave_steps)) continue;
        stepsRaw = r.eave_steps;
      }

      // (2) resolve this face's outline sub-edges + along-face u axis.
      const rd = viewerPositionToPlanDir(face, "right_end", args.faceNormals);
      if (!rd) continue; // unknown face word — can't map, skip silently
      const n = { x: -rd.y + 0, y: rd.x + 0 }; // inverse of rd = (n.y, −n.x)
      let edges = faceEdges(ring, n, rd);
      if (edges.length === 0) continue;
      const uMin = Math.min(...edges.map((e) => Math.min(e.uL, e.uR)));
      const uMax = Math.max(...edges.map((e) => Math.max(e.uL, e.uR)));
      const width = uMax - uMin;
      if (!(width > 0)) continue;

      // Traced roof jogs on this face (perpendicular connectors between
      // same-face sub-edges at different depths).
      const minDepthU = Math.max(ftToU(2), ringSpan * 0.02); // ≥ ~2 ft, noise-floored

      // FLUSH-FACE STRAIGHTENING (owner escalation, eaveStepStraightenEnabled):
      // the roof-plan page's strongest signal — a WHOLE side ruled flush,
      // stepsRaw.length === 0 — outranks a traced jog outright here, instead
      // of only flagging it. Only a genuine "one flush plane + notch" shape
      // qualifies (spliceStraightFace's own depth/contiguity gates); anything
      // messier falls through to the existing flag-only path below.
      if (straightenOn && fromRoofPlan && stepsRaw.length === 0 && edges.length > 1) {
        const spliced = spliceStraightFace(ring, edges, minDepthU / 2);
        if (spliced) {
          ring = spliced.ring;
          footprintTouched = true;
          const before = excludedEdges.length;
          excludedEdges = excludedEdges.filter(
            (ee) =>
              !spliced.removedSubEdges.some(
                (s) =>
                  (near(ee.start as Pt, s.a, vTol) && near(ee.end as Pt, s.b, vTol)) ||
                  (near(ee.start as Pt, s.b, vTol) && near(ee.end as Pt, s.a, vTol)),
              ),
          );
          const droppedRakes = before - excludedEdges.length;
          notes.push(
            `📄 JOG STRAIGHTENED — the roof-plan page shows one flush fascia plane across the ${face} side; the traced jog there (${edges.length - 1} step${edges.length - 1 === 1 ? "" : "s"}) was straightened out of the diagram.` +
              (droppedRakes > 0
                ? ` ${droppedRakes} stale no-gutter mark${droppedRakes === 1 ? "" : "s"} on the removed span cleared too.`
                : "") +
              ` Any newly-exposed span prices (or suggests) the same as any other uncovered wall gap.`,
          );
          continue; // this face's jog is gone — nothing left to trace/flag
        }
      }

      const gapTolU = Math.max(width * 0.03, 1e-6);
      const tolU = Math.max(ftToU(4), width * 0.06);

      // Sanitized elevation steps: a position_frac outside [0,1] (adversarial
      // garbage like 3.7) is DROPPED — no carve, no clamped phantom.
      const elevSteps = stepsRaw.filter(
        (s): s is FaceEaveStep =>
          !!s &&
          typeof s === "object" &&
          typeof s.position_frac === "number" &&
          Number.isFinite(s.position_frac) &&
          s.position_frac >= 0 &&
          s.position_frac <= 1,
      );

      // Mirror-check inputs (front/rear, roof-page-ruled sides only) — the
      // PRE-flatten traced pattern, so a flipped canvas is still detectable
      // after its mirrored jogs get flattened below.
      const tracedPre = tracedStepsOf(edges, minDepthU, gapTolU);
      if (fromRoofPlan && (face === "front" || face === "rear")) {
        mirrorEntries.push({
          face,
          roofFracs: elevSteps.map((s) => s.position_frac as number),
          tracedFracs: tracedPre.map((t) => (t.u - uMin) / width),
        });
      }

      // PER-JOG PHANTOM FLATTENING (owner escalation round 2, same
      // eaveStepStraightenEnabled switch): on a roof-page-ruled side, every
      // traced step the page does NOT corroborate is pressed flat — the
      // diagram jogs only where the roof layout jogs. Page-matched steps and
      // anything deeper than the ~8 ft cap survive untouched (flag-only).
      // A face whose step pattern fits the page better MIRRORED is never
      // flattened — those "phantoms" are likely real steps on a flipped
      // canvas; the mirror note asks the owner to verify instead.
      const mirrorSuspect =
        (face === "front" || face === "rear") &&
        detectStepMirror([
          {
            face,
            roofFracs: elevSteps.map((s) => s.position_frac as number),
            tracedFracs: tracedPre.map((t) => (t.u - uMin) / width),
          },
        ]) !== null;
      if (straightenOn && fromRoofPlan && !mirrorSuspect && edges.length > 1) {
        const roofUs = elevSteps.map((s) => uMin + (s.position_frac as number) * width);
        const flat = flattenPhantomJogs({
          ring,
          edges,
          n,
          roofUs,
          tolU,
          minDepthU,
          gapTolU,
          maxShiftU: ftToU(8),
        });
        if (flat) {
          // Carry followers sitting ON a shifted sub-edge by the same delta.
          const snapTol = Math.max(vTol, ftToU(0.5));
          const shiftPt = (p: Pt): Pt => {
            for (const m of flat.moved) {
              if (distToSeg(p, m.a, m.b) <= snapTol) {
                return { x: p.x + n.x * m.delta, y: p.y + n.y * m.delta };
              }
            }
            return p;
          };
          runsW = runsW.map((rr) => {
            if (!isFinitePt(rr.start as Pt) || !isFinitePt(rr.end as Pt)) return rr;
            const s = shiftPt(rr.start);
            const e2 = shiftPt(rr.end);
            if (s === rr.start && e2 === rr.end) return rr;
            followersTouched = true;
            // length_ft (the priced value) is deliberately untouched.
            return { ...rr, start: s, end: e2, length_px: Math.hypot(e2.x - s.x, e2.y - s.y) };
          });
          dssW = dssW.map((d) => {
            if (!d || !isFinitePt(d.at as Pt)) return d;
            const at = shiftPt(d.at);
            if (at === d.at) return d;
            followersTouched = true;
            return { ...d, at };
          });
          excludedEdges = excludedEdges.map((ee) => {
            if (!isFinitePt(ee.start as Pt) || !isFinitePt(ee.end as Pt)) return ee;
            const s = shiftPt(ee.start);
            const e2 = shiftPt(ee.end);
            return s === ee.start && e2 === ee.end ? ee : { ...ee, start: s, end: e2 };
          });
          ring = flat.ring;
          footprintTouched = true;
          const fracList = flat.flattenedU
            .map((u) => `${Math.round(((u - uMin) / width) * 100)}%`)
            .join(", ");
          notes.push(
            `📄 JOG FLATTENED (roof-plan page) — the traced outline stepped at ~${fracList} across the ${face} side where the page shows no fascia step; ${
              flat.flattenedU.length === 1 ? "that phantom jog was" : "those phantom jogs were"
            } pressed flat onto the side's main fascia line (gutters carried along; priced LF unchanged). Steps the page located are kept.`,
          );
          edges = faceEdges(ring, n, rd);
          if (edges.length === 0) continue;
        }
      }

      const traced = tracedStepsOf(edges, minDepthU, gapTolU);

      const hipped = r?.roof_form === "hipped";
      const matchedTraced = new Set<number>();

      // (7) HIP INNER RETURN — under a hip tier step the gutter also returns
      // INSIDE. Emitted for matched, carved AND suggested steps alike, unless
      // an existing run already covers that segment.
      const emitHipLeg = (
        s: FaceEaveStep,
        frac: number,
        anchor: { innerPt: Pt; depthU: number },
      ): void => {
        const lowerDir: Pt | null =
          s.direction === "down"
            ? { x: rd.x, y: rd.y }
            : s.direction === "up"
              ? { x: -rd.x, y: -rd.y }
              : null;
        if (!hipped || !lowerDir) return;
        const legLen = anchor.depthU;
        if (!(legLen > 0)) return;
        const a = anchor.innerPt;
        const b: Pt = { x: a.x + lowerDir.x * legLen, y: a.y + lowerDir.y * legLen };
        const covTol = Math.max(ringSpan * 0.02, ftToU(1));
        if (segCoveredFraction(a, b, runsW, covTol) > 0.5) return;
        suggestedEaves.push({ points: [a, b], tier: "lower" });
        notes.push(
          `HIP TIER STEP — gutter returns inside under the hip tier step on the ${face} face (~${Math.round(frac * 100)}% across); an unpriced inner return leg is available to tap-add — verify.`,
        );
      };

      // Phase A — MATCH each ruling-source step against the traced jogs.
      type PendingStep = { s: FaceEaveStep; frac: number; u: number; carved: boolean };
      const pending: PendingStep[] = [];
      for (const s of elevSteps) {
        const frac = s.position_frac as number;
        const u = uMin + frac * width;
        let hit = -1;
        let hitDist = Infinity;
        traced.forEach((t, ti) => {
          const d = Math.abs(t.u - u);
          if (d <= tolU && d < hitDist) {
            hit = ti;
            hitDist = d;
          }
        });
        if (hit >= 0) {
          // (3) MATCHED — the trace already carries this roof jog. Tag it.
          matchedTraced.add(hit);
          verifiedJogIds.push(`${face}@${frac.toFixed(2)}`);
          notes.push(
            fromRoofPlan
              ? `ROOF-VERIFIED JOG — the roof-plan page's fascia line breaks at ~${Math.round(frac * 100)}% across the ${face} side, matching the traced roof step there. Geometry and priced LF unchanged.`
              : `ROOF-VERIFIED JOG — the ${face} elevation's eave line breaks at ~${Math.round(frac * 100)}% across, matching the traced roof step there${
                  s.kind === "tier_drop" ? " (tier change)" : ""
                }. Geometry and priced LF unchanged.`,
          );
          emitHipLeg(s, frac, { innerPt: traced[hit].innerPt, depthU: traced[hit].depthU });
        } else {
          pending.push({ s, frac, u, carved: false });
        }
      }

      // Phase B — CARVE the missed steps into the outline (owner escalation
      // round 3, eaveStepCarveEnabled): adjacent pairs that read as a
      // recessed middle become an inset notch; a lone step becomes an L-step
      // to the nearer corner. Always inward. The roof page's plan_offset
      // picks the recessed side; unknown → the SHORTER side recedes. A
      // mirror-suspect face never carves (its step positions may be flipped).
      const carveOn = eaveStepCarveEnabled();
      if (carveOn && pending.length > 0 && !mirrorSuspect) {
        const perpFt = perpendicularDepthFt(face, perFace);
        const carveDepthFt = Math.min(perpFt ?? SCHEMATIC_DEPTH_FT, MAX_CARVE_DEPTH_FT);
        const carveDepthU = Math.min(ftToU(carveDepthFt), ringSpan * 0.45);
        const marginU = Math.max(gapTolU, ftToU(1));
        const minOverlapU = Math.max(gapTolU, ftToU(1));
        const snapTol = Math.max(vTol, ftToU(0.5));
        const minSpanU = ftToU(2);
        const maxSpanU = width * 0.6;

        // Plan the ops: greedy left-to-right pairing, leftovers as L-steps.
        const ordered = pending.slice().sort((p, q) => p.u - q.u);
        const ops: { steps: PendingStep[]; op: CarveOp }[] = [];
        let pi = 0;
        while (pi < ordered.length) {
          const a = ordered[pi];
          const b = ordered[pi + 1];
          const offA = a.s.plan_offset ?? null;
          const offB = b?.s.plan_offset ?? null;
          // A recessed middle needs "in" on the left step and "out" on the
          // right one (unknowns pass); an outward-first pair would be a
          // PROJECTING middle — growing the envelope is never carved.
          const pairOk =
            !!b &&
            b.u - a.u >= minSpanU &&
            b.u - a.u <= maxSpanU &&
            offA !== "outward" &&
            offB !== "inward";
          if (pairOk) {
            ops.push({ steps: [a, b], op: { kind: "notch", u1: a.u, u2: b.u } });
            pi += 2;
            continue;
          }
          let side: "after" | "before" | null =
            offA === "inward" ? "after" : offA === "outward" ? "before" : null;
          if (side === null) side = a.u - uMin <= uMax - a.u ? "before" : "after";
          const spanU = side === "before" ? a.u - uMin : uMax - a.u;
          if (spanU >= minSpanU && spanU <= maxSpanU) {
            ops.push({ steps: [a], op: { kind: "lstep", u: a.u, side } });
          }
          pi += 1;
        }

        if (carveDepthU > 0) {
          for (const o of ops.slice(0, 3)) {
            const freshEdges = faceEdges(ring, n, rd);
            const res = carveIntoRing({
              ring,
              edges: freshEdges,
              n,
              op: o.op,
              depthU: carveDepthU,
              marginU,
              uMin,
              uMax,
            });
            if (!res) continue; // gates declined — falls back to suggest below
            ring = res.ring;
            footprintTouched = true;
            const carry = carryCarveFollowers({
              runs: runsW,
              dss: dssW,
              excluded: excludedEdges,
              span: res.span,
              n,
              rd,
              depthU: carveDepthU,
              uSpan: res.uSpan,
              snapTol,
              minOverlapU,
            });
            runsW = carry.runs;
            dssW = carry.dss;
            excludedEdges = carry.excluded;
            if (carry.touched) followersTouched = true;
            const fracs = o.steps.map((st) => `${Math.round(st.frac * 100)}%`);
            for (const st of o.steps) {
              st.carved = true;
              carvedJogIds.push(`${face}@${st.frac.toFixed(2)}`);
              // Hip inner leg anchors at the carved inner corner under the step.
              const uA2 = faceU(res.span.a, rd);
              const uB2 = faceU(res.span.b, rd);
              const t =
                uB2 !== uA2 ? Math.max(0, Math.min(1, (st.u - uA2) / (uB2 - uA2))) : 0;
              const outer: Pt = {
                x: res.span.a.x + (res.span.b.x - res.span.a.x) * t,
                y: res.span.a.y + (res.span.b.y - res.span.a.y) * t,
              };
              emitHipLeg(st.s, st.frac, {
                innerPt: { x: outer.x - n.x * carveDepthU, y: outer.y - n.y * carveDepthU },
                depthU: carveDepthU,
              });
            }
            notes.push(
              `🔧 ROOF JOG CARVED (${fromRoofPlan ? "roof-plan page" : "elevations"}) — the ${face} side's fascia ${
                o.op.kind === "notch"
                  ? `steps in at ~${fracs[0]} and back out at ~${fracs[1]}`
                  : `steps at ~${fracs[0]}`
              }, but the traced roof edge ran straight there; a ~${Math.round(carveDepthFt)} ft ${
                o.op.kind === "notch" ? "inset" : "corner recess"
              } was carved into the outline (${
                perpFt != null ? "sized from the perpendicular elevation's profile" : "schematic depth"
              } — verify on the canvas). Gutters follow the new edge with Σ priced LF preserved; the recess's return walls price or suggest through the closure pass like any other uncovered span.`,
            );
          }
        }
      }

      // Phase C — anything the carve declined keeps the legacy behavior:
      // (4) suggest-don't-carve, ONE unpriced perpendicular return at u,
      // sized from a perpendicular face's measured profile depth (never
      // offset_ft — that's vertical), else a 4 ft schematic.
      for (const p of pending) {
        if (p.carved) continue;
        const { s, frac, u } = p;
        const perpFt = perpendicularDepthFt(face, perFace);
        const depthFt = perpFt ?? SCHEMATIC_DEPTH_FT;
        const depthU = Math.min(ftToU(depthFt), ringSpan * 0.45); // sanity cap
        if (!(depthU > 0)) continue;
        const curEdges = footprintTouched ? faceEdges(ring, n, rd) : edges;
        if (curEdges.length === 0) continue;
        const base = pointAtU(curEdges, u);
        const inner: Pt = { x: base.x - n.x * depthU, y: base.y - n.y * depthU };
        suggestedEaves.push({
          points: [base, inner],
          ...(s.kind === "tier_drop" || hipped ? { tier: "lower" as const } : {}),
        });
        notes.push(
          fromRoofPlan
            ? `ROOF STEPS HERE (roof-plan page) — the roof-plan page's fascia line breaks at ~${Math.round(frac * 100)}% across the ${face} side, but the traced roof edge runs straight there. Step NOT carved into the priced outline; an unpriced ~${Math.round(depthFt)} ft return (${
                perpFt != null ? "sized from the perpendicular elevation's profile" : "schematic"
              }, estimated — verify) is available to tap-add.`
            : `ROOF STEPS HERE (elevations-first) — the ${face} elevation's eave line breaks at ~${Math.round(frac * 100)}% across, but the traced roof edge runs straight there. Step NOT carved into the priced outline; an unpriced ~${Math.round(depthFt)} ft return (${
                perpFt != null ? "sized from the perpendicular elevation's profile" : "schematic"
              }, estimated — verify) is available to tap-add.`,
        );
        emitHipLeg(s, frac, { innerPt: inner, depthU });
      }

      // (5) TRACED jog with NO step from the ruling source, on a side that
      // actually reported the field (even []) → the roof wins: loud flag,
      // run kept. A roof-page `[]` is the strongest form — the page shows
      // one flush fascia plane across the whole side.
      const unmatched = traced.filter((_, ti) => !matchedTraced.has(ti));
      for (const t of unmatched.slice(0, 3)) {
        const frac = Math.round(((t.u - uMin) / width) * 100);
        wallJogFlags.push(
          fromRoofPlan
            ? `WALL JOG, STRAIGHT ROOF — the traced outline steps on the ${face} face (~${frac}% across), but the roof-plan page shows no fascia step there${
                stepsRaw.length === 0 ? " (one flush fascia plane across the side)" : ""
              }; the roof may bridge the wall jog — verify. Nothing was removed or unpriced.`
            : `WALL JOG, STRAIGHT ROOF — the traced outline steps on the ${face} face (~${frac}% across), but the ${face} elevation shows a straight eave line there; the roof may bridge the wall jog — verify. Nothing was removed or unpriced.`,
        );
      }
    }

    // 🪞 MIRROR CHECK — one loud note when the roof page's front/rear step
    // patterns fit the trace significantly better flipped left-right.
    const mirrorNote = detectStepMirror(mirrorEntries);
    if (mirrorNote) notes.push(mirrorNote);

    // Flush-face straightening writes back onto the CALLER's own analysis
    // object (same reference args.analysis === the caller's `analysis`) —
    // every other pass in this file mutates analysis.notes the same way, so
    // this needs no new plumbing at the call site. gutter_runs is
    // deliberately never touched (see the type doctrine comment above).
    if (footprintTouched) {
      args.analysis.building_footprint = ring;
      args.analysis.excluded_edges = excludedEdges;
      if (followersTouched) {
        args.analysis.gutter_runs = runsW;
        args.analysis.downspouts = dssW;
      }
    }

    return {
      analysis: args.analysis,
      notes,
      suggestedEaves,
      verifiedJogIds,
      carvedJogIds,
      wallJogFlags,
    };
  } catch {
    return unchanged;
  }
}

/**
 * Adapter for the VECTOR-path gate (roof-from-vectors.ts adoptFootprintJogs):
 * the per-face eave-step reads flattened to the minimal per-face shape the
 * pure geometry module understands. Only READABLE faces that actually
 * REPORTED the field are included — an absent field must leave that face on
 * legacy behavior, and no reads at all returns null (legacy everywhere).
 */
export function elevationStepsForVectorGate(
  perFace: Partial<Record<string, FaceReadingRaw | undefined>> | null | undefined,
): {
  face: string;
  steps: { position_frac: number | null; direction?: "up" | "down" | null }[];
  continuous_eave: boolean;
}[] | null {
  try {
    if (!perFace) return null;
    const out: {
      face: string;
      steps: { position_frac: number | null; direction?: "up" | "down" | null }[];
      continuous_eave: boolean;
    }[] = [];
    for (const [face, r] of Object.entries(perFace)) {
      if (!r || r.readable === false) continue;
      if (!Array.isArray(r.eave_steps)) continue;
      out.push({
        face,
        continuous_eave: r.continuous_eave !== false,
        steps: r.eave_steps
          .filter((s) => !!s && typeof s === "object")
          .map((s) => ({
            position_frac:
              typeof s.position_frac === "number" && Number.isFinite(s.position_frac)
                ? s.position_frac
                : null,
            direction: s.direction === "up" || s.direction === "down" ? s.direction : null,
          })),
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
