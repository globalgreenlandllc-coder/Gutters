/**
 * tier-corner-veto.ts — cross-view corner binding for the LOWER covered mass
 * on SCANNED/raster plans (the 1168G failure).
 *
 * THE BUG THIS FIXES: on a raster set the Stage-2 vision trace ships its
 * tier/feature labels verbatim — 1168G placed the lower-tier "covered outdoor
 * living" gutter at the FRONT-RIGHT corner, where the plan has the GARAGE,
 * while the real lower tier sits at the REAR-RIGHT (the rear elevation shows
 * the lower wing at the viewer's LEFT end = house-right; the right-side
 * elevation shows it at the viewer's RIGHT end = rear).
 *
 * The deterministic cross-check: each elevation's `projections[]` now carries
 * `position` (left_end / center / right_end, VIEWER frame) and
 * `eave_below_main`. A front/rear face's position read pins the mass along the
 * left↔right axis; a side face's pins it along the front↔rear axis — two
 * perpendicular faces agreeing pin the plan CORNER. A drawn run claiming
 * tier "lower" + feature porch/patio in a DIFFERENT quadrant is then RETIERED
 * to "upper" (LF and geometry untouched — LF-neutral) with a loud note; the
 * geometry is never moved and no gutter is invented at the pinned corner.
 *
 * Viewer→plan mapping uses the SAME rightDir convention as place-gables.ts
 * (rightDirOf = (n.y, −n.x), y-down): the viewer stands outside looking along
 * −n, so e.g. on the REAR elevation the viewer's LEFT end is the HOUSE-RIGHT
 * side, and on the RIGHT elevation the viewer's RIGHT end is the REAR.
 *
 * Degrades gracefully (doctrine): old stored reads without the new fields →
 * input returned unchanged, no note; fewer than 2 usable perpendicular reads
 * or contradictory pins → NO retier, flag-only note when a lower porch run
 * exists anyway.
 *
 * Also derives the F4 "rear step evidence": when the pin lands on a REAR
 * corner but the traced rear edge runs straight past it (no step drawn), an
 * UNPRICED suggested return (tap-to-add) is emitted, sized from the
 * perpendicular face's measured projection depth.
 *
 * PURE + never throws — mirrors reconcile-eaves.ts: any failure returns the
 * input analysis unchanged.
 */

import type { BlueprintAnalysis, BlueprintRun } from "./blueprint-from-plans";
import type { FaceProjection, FaceReadingRaw } from "./face-merge";
import {
  DEFAULT_FACE_NORMALS,
  type FaceName,
  type FaceNormals,
  type Pt,
} from "./plan-orientation";
import { isFinitePt } from "../roof-skeleton";

/** Canvas normals of the HOUSE-RELATIVE faces (drafting convention: front of
 *  the house at the BOTTOM of the sheet, y-down) — the same fixed mapping as
 *  plan-orientation's WORD_NORMALS. Compass-keyed reads resolve through the
 *  derived orientation (or the north-up default) instead. */
const HOUSE_NORMALS: Record<string, Pt> = {
  front: { x: 0, y: 1 },
  rear: { x: 0, y: -1 },
  back: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function normalOf(face: string, compass?: FaceNormals | null): Pt | null {
  const house = HOUSE_NORMALS[face];
  if (house) return house;
  const n = (compass ?? DEFAULT_FACE_NORMALS)[face as FaceName];
  return n ?? null;
}

/**
 * Map a VIEWER-frame position read ("where along this face, as you look at
 * the elevation") to the PLAN-space direction of that end of the face.
 * Fixed convention (place-gables.ts rightDirOf, y-down): rightDir = (n.y, −n.x).
 * Examples (front-at-bottom default): rear-face "left_end" → {x:1,y:0} =
 * house-RIGHT; right-face "right_end" → {x:0,y:-1} = REAR. Returns null for
 * center/unknown/absent positions (they can't pin a corner).
 */
export function viewerPositionToPlanDir(
  face: string,
  position: FaceProjection["position"],
  faceNormals?: FaceNormals | null,
): Pt | null {
  if (position !== "left_end" && position !== "right_end") return null;
  const n = normalOf(face, faceNormals);
  if (!n) return null;
  const rightDir = { x: n.y, y: -n.x }; // viewer's left→right, y-down
  const d = position === "right_end" ? rightDir : { x: -rightDir.x, y: -rightDir.y };
  return { x: d.x + 0, y: d.y + 0 }; // normalize IEEE −0 for clean equality
}

/** Plan-space half words in the HOUSE frame (front = +y, right = +x). */
const xWord = (dir: 1 | -1): string => (dir > 0 ? "right" : "left");
const yWord = (dir: 1 | -1): string => (dir > 0 ? "front" : "rear");
const cornerWordOf = (xDir: 1 | -1, yDir: 1 | -1): string => `${yWord(yDir)}-${xWord(xDir)}`;

export type PinnedCorner = {
  /** Sign along the plan x-axis (+1 = house-right) / y-axis (+1 = front). */
  xDir: 1 | -1;
  yDir: 1 | -1;
  /** Human words, e.g. "rear-right". */
  corner: string;
  /** The elevation faces whose position reads established the pin. */
  faces: string[];
  /** The perpendicular (side) face's measured projection depth, ft. */
  depthFt: number | null;
};

export type TierCornerVetoResult = {
  analysis: BlueprintAnalysis;
  notes: string[];
  /** The pinned corner of the lower covered mass, when established. */
  pinned: PinnedCorner | null;
  vetoedRunIds: string[];
  /** F4: unpriced tap-to-add return at the pinned rear corner when the traced
   *  rear edge runs straight through it (analysis space). Null when the pin
   *  is not a rear corner, a step IS drawn, or no scale is derivable. */
  suggestedReturn: { start: Pt; end: Pt; note: string } | null;
};

type Pin = {
  face: string;
  axis: "x" | "y";
  dir: 1 | -1;
  depthFt: number | null;
};

// Kinds whose elevation profile may PIN the lower covered mass to a corner.
// "entry" is deliberately EXCLUDED from pinning: on hip/prairie plans the
// entry is a recessed portal UNDER the main eave, and a vision read of that
// recess as a "lower mass at the left end" of the front elevation is exactly
// how the pin once named the wrong corner (front-left) for a rear-right
// outdoor living. Entry runs can still be vetoed — they just can't pin.
const LOWER_COVER_KINDS = new Set(["porch", "patio"]);

/** Median ft-per-ring-unit from the AI's own measured runs — the same
 *  cross-validated scale closeVectorPerimeter uses. Null when underivable. */
function medianFtPerUnit(runs: readonly BlueprintRun[] | undefined | null): number | null {
  const ratios: number[] = [];
  for (const r of runs ?? []) {
    if (
      typeof r.length_ft === "number" &&
      r.length_ft > 0 &&
      typeof r.length_px === "number" &&
      r.length_px > 0
    )
      ratios.push(r.length_ft / r.length_px);
  }
  if (ratios.length === 0) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

export function tierCornerVeto(args: {
  analysis: BlueprintAnalysis;
  perFace: Partial<Record<string, FaceReadingRaw | undefined>> | null | undefined;
  /** Compass→canvas normals for compass-keyed reads; house-relative keys
   *  (front/rear/left/right) use the fixed drafting convention regardless. */
  faceNormals?: FaceNormals | null;
}): TierCornerVetoResult {
  const unchanged: TierCornerVetoResult = {
    analysis: args.analysis,
    notes: [],
    pinned: null,
    vetoedRunIds: [],
    suggestedReturn: null,
  };
  try {
    const analysis = args.analysis;
    if (!args.perFace) return unchanged;

    // 1. Collect viewer-frame position pins on lower covered masses.
    let sawPositionField = false;
    const pins: Pin[] = [];
    for (const [face, r] of Object.entries(args.perFace)) {
      if (!r || r.readable === false) continue;
      for (const p of r.projections ?? []) {
        if (!p || typeof p !== "object") continue;
        if ("position" in p) sawPositionField = true; // new-schema read
        if (!LOWER_COVER_KINDS.has(p.kind)) continue;
        if (p.eave_below_main !== true) continue; // the LOWER covered mass only
        const dir = viewerPositionToPlanDir(face, p.position, args.faceNormals);
        if (!dir) continue;
        const axis: "x" | "y" = Math.abs(dir.x) >= Math.abs(dir.y) ? "x" : "y";
        pins.push({
          face,
          axis,
          dir: (axis === "x" ? dir.x : dir.y) >= 0 ? 1 : -1,
          depthFt:
            typeof p.depth_ft === "number" && Number.isFinite(p.depth_ft) && p.depth_ft > 0
              ? p.depth_ft
              : null,
        });
      }
    }
    // Old stored reads (no `position` anywhere) → byte-identical passthrough.
    if (!sawPositionField) return unchanged;

    // 2. Resolve one direction per plan axis; any disagreement = contradictory.
    const resolveAxis = (list: Pin[]): 1 | -1 | 0 | null => {
      if (list.length === 0) return null;
      return list.every((p) => p.dir === list[0].dir) ? list[0].dir : 0; // 0 = conflict
    };
    const xPins = pins.filter((p) => p.axis === "x");
    const yPins = pins.filter((p) => p.axis === "y");
    const xr = resolveAxis(xPins);
    const yr = resolveAxis(yPins);
    const contradictory = xr === 0 || yr === 0;
    const havePin = !contradictory && xr != null && yr != null;

    // Footprint ring + candidate runs (needed by every branch below).
    const ring = (analysis.building_footprint ?? []).filter((p) => isFinitePt(p as Pt));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const span = Math.max(maxX - minX, maxY - minY);
    const ringOk = ring.length >= 4 && Number.isFinite(span) && span > 0;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const band = ringOk ? span * 0.03 : 0; // dead-band: a mid-line run pins no quadrant

    type Candidate = { run: BlueprintRun; xHalf: 1 | -1 | 0; yHalf: 1 | -1 | 0; claimed: string };
    const candidates: Candidate[] = [];
    for (const r of analysis.gutter_runs ?? []) {
      if (r.tier !== "lower") continue;
      if (!(r.feature === "porch" || r.feature === "patio")) continue;
      if (!isFinitePt(r.start as Pt) || !isFinitePt(r.end as Pt)) continue;
      const mid = { x: (r.start.x + r.end.x) / 2, y: (r.start.y + r.end.y) / 2 };
      const dx = mid.x - cx;
      const dy = mid.y - cy;
      const xHalf: 1 | -1 | 0 = !ringOk ? 0 : dx > band ? 1 : dx < -band ? -1 : 0;
      const yHalf: 1 | -1 | 0 = !ringOk ? 0 : dy > band ? 1 : dy < -band ? -1 : 0;
      const claimed =
        xHalf !== 0 && yHalf !== 0
          ? cornerWordOf(xHalf, yHalf)
          : xHalf !== 0
            ? xWord(xHalf)
            : yHalf !== 0
              ? yWord(yHalf)
              : "center";
      candidates.push({ run: r, xHalf, yHalf, claimed });
    }

    // 3. Degrade: no corner pin → flag-only when a lower porch run exists.
    if (!havePin) {
      if (candidates.length === 0) return unchanged;
      const claimed = [...new Set(candidates.map((c) => c.claimed))].join(" / ");
      return {
        ...unchanged,
        notes: [
          `PORCH LOCATION — a lower porch/outdoor-living gutter is drawn at the ${claimed}, but the lower covered area could not be pinned from the elevations` +
            (contradictory ? " (the elevation position reads disagree)" : "") +
            " — verify its location on the canvas.",
        ],
      };
    }

    const xDir = xr as 1 | -1;
    const yDir = yr as 1 | -1;
    const facesUsed = [...new Set(pins.map((p) => p.face))];
    const pinned: PinnedCorner = {
      xDir,
      yDir,
      corner: cornerWordOf(xDir, yDir),
      faces: facesUsed,
      // The perpendicular (side) face measures the wing's depth in profile —
      // that's the y-axis pin on a front/rear-cornered mass.
      depthFt: yPins.find((p) => p.depthFt != null)?.depthFt ?? pins.find((p) => p.depthFt != null)?.depthFt ?? null,
    };

    // 4. Veto: a lower porch/patio run whose quadrant CLEARLY differs from the
    //    pinned corner is retiered to the MAIN tier. LF, geometry, downspouts
    //    and totals untouched — LF-neutral by construction.
    const notes: string[] = [];
    const vetoedIds = new Set<string>();
    const claims: string[] = [];
    for (const c of candidates) {
      const differs =
        (c.xHalf !== 0 && c.xHalf !== xDir) || (c.yHalf !== 0 && c.yHalf !== yDir);
      if (differs) {
        vetoedIds.add(c.run.id);
        if (!claims.includes(c.claimed)) claims.push(c.claimed);
      }
    }
    let next = analysis;
    if (vetoedIds.size > 0) {
      next = {
        ...analysis,
        gutter_runs: analysis.gutter_runs.map((r) =>
          vetoedIds.has(r.id) ? { ...r, tier: "upper" as const, feature: undefined } : r,
        ),
      };
      const many = vetoedIds.size > 1;
      notes.push(
        `PORCH LOCATION CONFLICT — the trace put a lower porch/outdoor-living gutter${many ? ` (${vetoedIds.size} runs)` : ""} at the ${claims.join(" / ")}, but the ${facesUsed.join(" + ")} elevations place the lower covered area at the ${pinned.corner}. Kept the run${many ? "s" : ""} priced at the MAIN tier; verify the porch at the ${pinned.corner} on the canvas.`,
      );
    }

    // 5. F4 — rear step evidence: pin on a REAR corner + the traced rear edge
    //    runs straight through it → suggest an unpriced return (tap-to-add).
    let suggestedReturn: TierCornerVetoResult["suggestedReturn"] = null;
    if (yDir === -1 && ringOk) {
      suggestedReturn = suggestRearStepReturn(ring, {
        xDir,
        depthFt: pinned.depthFt ?? 10,
        ftPerUnit: medianFtPerUnit(analysis.gutter_runs),
        facesUsed,
        corner: pinned.corner,
        cx,
        span,
      });
    }

    return { analysis: next, notes, pinned, vetoedRunIds: [...vetoedIds], suggestedReturn };
  } catch {
    return unchanged;
  }
}

/**
 * The rear boundary near the pinned corner: is it ONE straight run (no step
 * vertex between ~4 ft past the corner and the lateral center)? If so the
 * tier boundary the elevations prove is NOT drawn — return the suggested
 * return: perpendicular to the rear edge, into the ring, sized by the
 * perpendicular face's measured depth. Null when a step IS drawn (within the
 * pinned half), the rear boundary can't be found, or no scale exists.
 */
function suggestRearStepReturn(
  ring: { x: number; y: number }[],
  args: {
    xDir: 1 | -1;
    depthFt: number;
    ftPerUnit: number | null;
    facesUsed: string[];
    corner: string;
    cx: number;
    span: number;
  },
): { start: Pt; end: Pt; note: string } | null {
  if (!(args.ftPerUnit != null && Number.isFinite(args.ftPerUnit) && args.ftPerUnit > 0)) return null;
  const n = ring.length;
  const centroid = {
    x: ring.reduce((s, p) => s + p.x, 0) / n,
    y: ring.reduce((s, p) => s + p.y, 0) / n,
  };
  const tol = Math.max(2, args.span * 0.012);
  type E = { a: Pt; b: Pt; mid: Pt; len: number; out: Pt };
  const rearEdges: E[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(len > tol)) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const n1 = { x: uy, y: -ux };
    const away = (mid.x - centroid.x) * n1.x + (mid.y - centroid.y) * n1.y;
    const out = away >= 0 ? n1 : { x: -n1.x, y: -n1.y };
    // rear = outward normal within ~45° of {0,-1} (front-at-bottom convention)
    if (-out.y > 0.7) rearEdges.push({ a, b, mid, len, out });
  }
  if (rearEdges.length === 0) return null;

  // Pinned-side extreme vertex of the rear boundary.
  let V0: Pt | null = null;
  let host: E | null = null;
  for (const e of rearEdges) {
    for (const v of [e.a, e.b]) {
      if (!V0 || v.x * args.xDir > V0.x * args.xDir) {
        V0 = v;
        host = e;
      }
    }
  }
  if (!V0 || !host) return null;

  // A STEP is drawn when any rear-boundary vertex sits between ~4 ft past the
  // corner (closer = corner noise) and the lateral center — the articulation
  // the elevations prove already exists on the trace, so nothing to suggest.
  const noise = 4 / args.ftPerUnit;
  const halfSpan = Math.abs(args.cx - V0.x);
  for (const e of rearEdges) {
    for (const v of [e.a, e.b]) {
      const along = Math.abs(v.x - V0.x);
      if (along > noise && along <= halfSpan) return null;
    }
  }

  // Suggest: a return perpendicular to the rear edge, INTO the ring, at
  // depth-from-corner (square-ish default for the unknown wing width).
  const other = host.a === V0 ? host.b : host.a;
  const dirLen = Math.hypot(other.x - V0.x, other.y - V0.y);
  if (!(dirLen > 0)) return null;
  const dir = { x: (other.x - V0.x) / dirLen, y: (other.y - V0.y) / dirLen };
  const depthU = args.depthFt / args.ftPerUnit;
  const offset = Math.min(depthU, dirLen * 0.9);
  const start = { x: V0.x + dir.x * offset, y: V0.y + dir.y * offset };
  const inward = { x: -host.out.x, y: -host.out.y };
  const end = { x: start.x + inward.x * depthU, y: start.y + inward.y * depthU };
  return {
    start,
    end,
    note: `ROOF STEPS HERE — the ${args.facesUsed.join(" + ")} elevations show the ${args.corner} covered area at a LOWER eave, but the traced rear edge runs straight. Step/tier boundary not drawn — verify; a suggested lower return is available to tap-add.`,
  };
}
