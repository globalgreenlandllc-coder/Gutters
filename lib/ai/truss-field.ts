/**
 * Truss-field evidence — the roof FRAMING sheet's own linework, read per
 * perimeter edge, with no AI in the loop.
 *
 * Physics of a framing plan: trusses are drawn along their span, as PERIODIC
 * ARRAYS (16/24" o.c.) of LONG members. A wall that bears trusses (an eave)
 * has the array running PERPENDICULAR into it; a gable-end wall has it
 * running PARALLEL (the gable end truss and its neighbors).
 *
 * What a naive "which orientation dominates the strip" test gets wrong (all
 * observed on the Woodinville A9):
 *   - wall/plate/header lines lie PARALLEL just inside every wall → periodic
 *     family test (≥3 members at regular joist spacing) rejects pairs;
 *   - gable-end OVERHANG JACKS are perpendicular right at a gable wall →
 *     minimum member length (8 ft) rejects them;
 *   - on a two-tier side wall the upper roof's trusses can run parallel while
 *     the gutter rides a lower fascia → PARALLEL is therefore only a HINT for
 *     the elevation reconciler to corroborate, never a unilateral rake call.
 * PERPENDICULAR stays strong: long periodic members bearing into a wall mean
 * that wall carries their eave — safe to demote a label-less rake call.
 *
 * Pure module — no AI, no server-only imports; runs under node --test.
 */

import type { OutlineEdge, OverlayPt } from "./plan-overlay";
import type { EdgeClass } from "./edge-takeoff";

export type TrussFieldVerdict = {
  verdict: "parallel" | "perpendicular";
  /** periodic-family member counts found inside the strip */
  par: number;
  perp: number;
};

/** Printed-on-the-sheet rake evidence the field never overrides silently. */
const STRONG_RAKE_EVIDENCE = new Set([
  "gable_end_truss_label",
  "barge_or_rake_callout",
]);

const NEAR_FT = 0.75; // strip starts just inside the wall line
const DEPTH_FT = 7; // ~3 trusses at 24" o.c.
const END_SHRINK = 0.12; // stay clear of corner returns
const MIN_MEMBER_FT = 8; // real trusses/rafters; excludes jacks & glyphs
const MIN_CROSS_FT = 0.5; // member must genuinely enter the strip
const CLUSTER_FT = 0.6; // double-strokes of one member merge
const SPACING_MIN_FT = 1.2; // 16" o.c. with slack
const SPACING_MAX_FT = 4.5; // 48" o.c. girder bays
const MIN_MEMBERS = 3; // an array, not a wall pair
const MIN_REGULAR_GAPS = 2;

function pointInPolygon(p: OverlayPt, poly: readonly OverlayPt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

/** 1-D overlap length of [a1,a2] with [b1,b2]. */
const overlap = (a1: number, a2: number, b1: number, b2: number): number =>
  Math.max(
    0,
    Math.min(Math.max(a1, a2), Math.max(b1, b2)) -
      Math.max(Math.min(a1, a2), Math.min(b1, b2)),
  );

/**
 * Detect a periodic framing family from cross-axis positions: merge
 * double-strokes into members, then require a run of regular joist-spaced
 * gaps. Returns member count and the family's positional spread — a REAL
 * bearing wall has trusses along its whole length, while accidental
 * regularity (window jambs, header extents) clusters in one pocket.
 */
function familyOf(
  cross: number[],
  ptPerFt: number,
): { members: number; spread: number } {
  const none = { members: 0, spread: 0 };
  if (cross.length < MIN_MEMBERS) return none;
  const sorted = [...cross].sort((a, b) => a - b);
  const members: number[] = [sorted[0]];
  for (const c of sorted.slice(1)) {
    if (c - members[members.length - 1] > CLUSTER_FT * ptPerFt)
      members.push(c);
    else members[members.length - 1] = (members[members.length - 1] + c) / 2;
  }
  if (members.length < MIN_MEMBERS) return none;
  let regular = 0;
  for (let i = 1; i < members.length; i++) {
    const gapFt = (members[i] - members[i - 1]) / ptPerFt;
    if (gapFt >= SPACING_MIN_FT && gapFt <= SPACING_MAX_FT) regular++;
  }
  if (regular < MIN_REGULAR_GAPS) return none;
  return {
    members: members.length,
    spread: members[members.length - 1] - members[0],
  };
}

/**
 * Score the framing field just inside each axis-aligned perimeter edge.
 * `segments` should be the thin-inclusive field channel
 * (selectFieldSegments); a sparse bold-only set simply produces no verdicts —
 * the safe failure mode.
 */
export function deriveTrussField(opts: {
  outline: readonly OverlayPt[];
  edges: readonly OutlineEdge[];
  segments: readonly number[][] | null | undefined;
  ptPerFt?: number | null;
}): Map<string, TrussFieldVerdict> {
  const out = new Map<string, TrussFieldVerdict>();
  const { outline, edges, segments } = opts;
  if (!segments || segments.length < 8 || outline.length < 3) return out;

  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const span = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    1,
  );
  // Scale: prefer the solved pt/ft; fall back to span ≈ a 60 ft building.
  const ptPerFt =
    opts.ptPerFt && Number.isFinite(opts.ptPerFt) && opts.ptPerFt > 0
      ? opts.ptPerFt
      : span / 60;
  const near = NEAR_FT * ptPerFt;
  const depth = DEPTH_FT * ptPerFt;
  const minLen = MIN_MEMBER_FT * ptPerFt;
  const minCross = MIN_CROSS_FT * ptPerFt;

  // Long axis-aligned members only — pre-split once.
  const hSegs: number[][] = [];
  const vSegs: number[][] = [];
  for (const s of segments) {
    if (!Array.isArray(s) || s.length < 4) continue;
    const dx = Math.abs(s[2] - s[0]);
    const dy = Math.abs(s[3] - s[1]);
    if (dx >= 1.5 && dy >= 1.5) continue;
    if (Math.max(dx, dy) < minLen) continue;
    (dx >= dy ? hSegs : vSegs).push(s);
  }

  for (const e of edges) {
    if (e.axis !== "h" && e.axis !== "v") continue;
    if (e.lenPt < 3 * ptPerFt) continue; // sub-3ft jogs: strip too small

    // Inward normal: probe a point just off the midpoint.
    const nCands =
      e.axis === "h"
        ? [
            { x: 0, y: 1 },
            { x: 0, y: -1 },
          ]
        : [
            { x: 1, y: 0 },
            { x: -1, y: 0 },
          ];
    const eps = Math.max(2, span * 0.004);
    const inward = nCands.find((n) =>
      pointInPolygon(
        { x: e.mid.x + n.x * eps, y: e.mid.y + n.y * eps },
        outline,
      ),
    );
    if (!inward) continue;

    // Strip rectangle in plain x/y (edges and field are axis-aligned).
    const shrink = e.lenPt * END_SHRINK;
    let x0: number, x1: number, y0: number, y1: number;
    if (e.axis === "h") {
      x0 = Math.min(e.p1.x, e.p2.x) + shrink;
      x1 = Math.max(e.p1.x, e.p2.x) - shrink;
      y0 = e.mid.y + inward.y * near;
      y1 = e.mid.y + inward.y * depth;
    } else {
      y0 = Math.min(e.p1.y, e.p2.y) + shrink;
      y1 = Math.max(e.p1.y, e.p2.y) - shrink;
      x0 = e.mid.x + inward.x * near;
      x1 = e.mid.x + inward.x * depth;
    }
    const rx0 = Math.min(x0, x1);
    const rx1 = Math.max(x0, x1);
    const ry0 = Math.min(y0, y1);
    const ry1 = Math.max(y0, y1);

    // Collect qualifying members per orientation.
    //   PARALLEL member (same axis as the edge): must run along MOST of the
    //   wall inside the strip — a gable-end truss spans its wall; parallel
    //   wall/plate scraps and header stubs don't qualify.
    //   PERPENDICULAR member (into the wall): must genuinely enter the strip;
    //   the family additionally has to SPREAD along the wall (bearing walls
    //   carry trusses over their whole length).
    const alongSpan = e.axis === "h" ? rx1 - rx0 : ry1 - ry0;
    const parCross: number[] = [];
    const perpCross: number[] = []; // cross position ALONG the edge
    for (const s of hSegs) {
      const yMid = (s[1] + s[3]) / 2;
      if (yMid < ry0 || yMid > ry1) continue;
      const clip = overlap(s[0], s[2], rx0, rx1);
      if (e.axis === "h") {
        if (clip >= alongSpan * 0.5) parCross.push(yMid);
      } else if (clip >= minCross) {
        perpCross.push(yMid);
      }
    }
    for (const s of vSegs) {
      const xMid = (s[0] + s[2]) / 2;
      if (xMid < rx0 || xMid > rx1) continue;
      const clip = overlap(s[1], s[3], ry0, ry1);
      if (e.axis === "v") {
        if (clip >= alongSpan * 0.5) parCross.push(xMid);
      } else if (clip >= minCross) {
        perpCross.push(xMid);
      }
    }

    const parFam = familyOf(parCross, ptPerFt);
    const perpFam = familyOf(perpCross, ptPerFt);
    const par = parFam.members;
    const perp =
      perpFam.spread >= alongSpan * 0.4 ? perpFam.members : 0;

    if (process.env.TRUSS_FIELD_DEBUG) {
      const fmt = (a: number[]) =>
        [...a]
          .sort((m, n) => m - n)
          .map((c) => (c / ptPerFt).toFixed(1))
          .join(" ");
      console.log(
        `[field] ${e.id} strip x[${(rx0 / ptPerFt).toFixed(1)},${(rx1 / ptPerFt).toFixed(1)}] y[${(ry0 / ptPerFt).toFixed(1)},${(ry1 / ptPerFt).toFixed(1)}]ft  par=${par} perp=${perp} (perpSpread=${(perpFam.spread / ptPerFt).toFixed(1)}ft of ${(alongSpan / ptPerFt).toFixed(1)}ft)\n` +
          `        par cross(ft): ${fmt(parCross)}\n        perp cross(ft): ${fmt(perpCross)}`,
      );
    }

    if (par >= MIN_MEMBERS && par >= 2 * perp) {
      out.set(e.id, { verdict: "parallel", par, perp });
    } else if (perp >= MIN_MEMBERS && perp >= 2 * par) {
      out.set(e.id, { verdict: "perpendicular", par, perp });
    }
  }
  return out;
}

export type TrussFieldResult = {
  classes: EdgeClass[];
  notes: string[];
  demoted: number;
  /** edges whose field reads parallel — rake HINTS for the reconciler */
  parallelIds: Set<string>;
};

/**
 * Apply the STRONG half of the field evidence before elevation
 * reconciliation: a perpendicular periodic array means this wall bears the
 * trusses — a label-less rake call flips to eave; a printed gable label
 * conflicting with it goes UNPRICED with a verify note. Parallel verdicts
 * are returned as hints only (see reconcile-edge-classes.ts).
 */
export function applyTrussFieldDemotions(opts: {
  classes: readonly EdgeClass[];
  field: Map<string, TrussFieldVerdict>;
}): TrussFieldResult {
  const classes = opts.classes.map((c) => ({ ...c }));
  const notes: string[] = [];
  const parallelIds = new Set<string>();
  let demoted = 0;

  for (const cls of classes) {
    const v = opts.field.get(cls.id);
    if (!v) continue;
    if (v.verdict === "parallel") {
      parallelIds.add(cls.id);
      continue;
    }
    if (cls.edge_class === "eave") {
      cls.evidence = [...(cls.evidence ?? []), "truss_field_perpendicular"];
      continue;
    }
    if ((cls.evidence ?? []).some((t) => STRONG_RAKE_EVIDENCE.has(t))) {
      cls.edge_class = "unknown";
      notes.push(
        `📐 ${cls.id}: printed gable label vs a truss array drawn INTO this wall — conflicting sheet evidence, UNPRICED, verify.`,
      );
      continue;
    }
    const was = cls.edge_class;
    cls.edge_class = "eave";
    cls.evidence = [...(cls.evidence ?? []), "truss_field_perpendicular"];
    demoted++;
    notes.push(
      `📐 ${cls.id} ${was}→EAVE: the framing array runs INTO this wall (trusses bear on it) — it carries the gutter per the sheet.`,
    );
  }
  if (demoted > 0) {
    notes.push(
      `📐 Truss-field check: ${demoted} wall(s) returned to eave by the framing sheet's own linework.`,
    );
  }
  return { classes, notes, demoted, parallelIds };
}
