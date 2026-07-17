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
 *   - an eave-line break the trace MISSED → suggest, don't carve: ONE unpriced
 *     tap-to-add return at that position (estimated — verify);
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

/** Owner escalation: when the roof-plan page rules a WHOLE side flush
 *  (stepsRaw.length === 0 — its strongest possible signal, "one flush
 *  fascia plane across the side") and the traced footprint still carries a
 *  jog there, straighten it into the diagram instead of only flagging it —
 *  "everything should be jogged on the diagram only if it's jogged on the
 *  roof layout." Default ON; BLUEPRINT_EAVE_STEP_STRAIGHTEN=0 restores the
 *  old flag-only behavior. */
export function eaveStepStraightenEnabled(override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  return process.env.BLUEPRINT_EAVE_STEP_STRAIGHTEN !== "0";
}

export type EaveStepReconcileResult = {
  /** The caller's analysis object. Geometry and priced LF are byte-untouched
   *  EXCEPT for the narrow flush-face straightening escalation (see
   *  eaveStepStraightenEnabled): there, building_footprint loses the jog's
   *  interior vertices and excluded_edges loses any rake entry that sat on
   *  them — gutter_runs are NEVER rewritten here (their coordinates already
   *  sit correctly on the new straight edge; any newly-exposed gap is priced
   *  or suggested by the normal downstream perimeter-closure pass, same as
   *  any other mid-wall gap). Straightening notes name the LF as unchanged
   *  BY THIS PASS; closure may still add real footage for the newly-exposed
   *  span, exactly like any other uncovered wall gap. */
  analysis: BlueprintAnalysis;
  /** Roof-verified confirmations + suggest-don't-carve notes (loud). */
  notes: string[];
  /** Unpriced tap-to-add returns for eave steps the trace missed (+ hip
   *  inner-return legs). Never summed into priced LF. */
  suggestedEaves: EaveStepSuggestion[];
  /** Traced jogs an elevation eave-line break confirmed ("face@frac"). */
  verifiedJogIds: string[];
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
 * same-face jogs. Notes/suggestions only — the returned analysis is the
 * input object, geometry and priced LF untouched.
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
      const edges = faceEdges(ring, n, rd);
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

      const traced = tracedStepsOf(edges, minDepthU, Math.max(width * 0.03, 1e-6));
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

      const hipped = r?.roof_form === "hipped";
      const matchedTraced = new Set<number>();

      // Mirror-check inputs (front/rear, roof-page-ruled sides only).
      if (fromRoofPlan && (face === "front" || face === "rear")) {
        mirrorEntries.push({
          face,
          roofFracs: elevSteps.map((s) => s.position_frac as number),
          tracedFracs: traced.map((t) => (t.u - uMin) / width),
        });
      }

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

        // Direction → which side of the step is the LOWER tier (viewer frame:
        // "down" = drops scanning left→right → lower to the RIGHT = +rd).
        const lowerDir: Pt | null =
          s.direction === "down"
            ? { x: rd.x, y: rd.y }
            : s.direction === "up"
              ? { x: -rd.x, y: -rd.y }
              : null;

        let hipAnchor: { innerPt: Pt; depthU: number } | null = null;

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
          hipAnchor = { innerPt: traced[hit].innerPt, depthU: traced[hit].depthU };
        } else {
          // (4) UNMATCHED — the elevation shows a roof step the trace missed.
          // Suggest, don't carve: ONE unpriced perpendicular return at u,
          // sized from a perpendicular face's measured profile depth (never
          // offset_ft — that's vertical), else a 4 ft schematic.
          const perpFt = perpendicularDepthFt(face, perFace);
          const depthFt = perpFt ?? SCHEMATIC_DEPTH_FT;
          const depthU = Math.min(ftToU(depthFt), ringSpan * 0.45); // sanity cap
          if (!(depthU > 0)) continue;
          const base = pointAtU(edges, u);
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
          hipAnchor = { innerPt: inner, depthU };
        }

        // (7) HIP INNER RETURN — under a hip tier step the gutter also returns
        // INSIDE. Emit the inner leg as a second unpriced suggestion, unless an
        // existing run already covers that segment.
        if (hipped && hipAnchor && lowerDir) {
          const legLen = hipAnchor.depthU;
          if (legLen > 0) {
            const a = hipAnchor.innerPt;
            const b: Pt = { x: a.x + lowerDir.x * legLen, y: a.y + lowerDir.y * legLen };
            const covTol = Math.max(ringSpan * 0.02, ftToU(1));
            const covered = segCoveredFraction(a, b, args.analysis.gutter_runs ?? [], covTol);
            if (covered <= 0.5) {
              suggestedEaves.push({ points: [a, b], tier: "lower" });
              notes.push(
                `HIP TIER STEP — gutter returns inside under the hip tier step on the ${face} face (~${Math.round(frac * 100)}% across); an unpriced inner return leg is available to tap-add — verify.`,
              );
            }
          }
        }
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
    }

    return { analysis: args.analysis, notes, suggestedEaves, verifiedJogIds, wallJogFlags };
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
