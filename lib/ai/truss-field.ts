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
// NB a "jack-fill" test for the short END-JACK strokes at side eaves was
// tried and removed: on the real Woodinville A9 those jacks are only
// LABELED, not drawn — the jack-length strokes inside the strip are text
// glyphs and hardware symbols, i.e. pure false-positive fuel.

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

/**
 * HIP-CORNER EAVE HINTS — read the roof-framing sheet's drawn HIP LINES.
 *
 * A hip springs as a ~45° diagonal from an OUTSIDE (convex) building corner and
 * runs inward to a ridge; a valley springs from an INSIDE (reflex) corner. A
 * hip proves that BOTH walls meeting at that corner are EAVES — the roof sheds
 * to a gutter on each. This is the deterministic counter-evidence a
 * hip-dominant roof was missing: the framing plan literally draws it, but no
 * engine read it (truss-field only looked at axis-aligned members).
 *
 * Returns the ids of perimeter edges flanked by a hip. PROTECTIVE (eave-only):
 * it never produces a rake, so it can restore/keep a gutter but never strip one.
 * A valley off a reflex corner is deliberately ignored.
 */
export function deriveHipCorners(opts: {
  outline: readonly OverlayPt[];
  edges: readonly OutlineEdge[];
  segments: readonly number[][] | null | undefined;
  ptPerFt?: number | null;
}): Set<string> {
  const hint = new Set<string>();
  const { outline, edges, segments } = opts;
  if (!segments || segments.length < 4 || outline.length < 4) return hint;

  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const span = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    1,
  );
  const ptPerFt =
    opts.ptPerFt && Number.isFinite(opts.ptPerFt) && opts.ptPerFt > 0
      ? opts.ptPerFt
      : span / 60;
  const minLen = 3 * ptPerFt; // a real hip run, not a hardware glyph
  const cornerTol = Math.max(1.5 * ptPerFt, span * 0.02);

  // Diagonal strokes at ~45° (22°–68°): both deltas meaningful, ratio near 1.
  const diagonals: Array<{ a: OverlayPt; b: OverlayPt }> = [];
  for (const s of segments) {
    if (!Array.isArray(s) || s.length < 4) continue;
    const dx = Math.abs(s[2] - s[0]);
    const dy = Math.abs(s[3] - s[1]);
    if (Math.hypot(dx, dy) < minLen) continue;
    const lo = Math.min(dx, dy);
    const hi = Math.max(dx, dy);
    if (lo < hi * 0.4) continue; // too axis-aligned to be a hip
    diagonals.push({ a: { x: s[0], y: s[1] }, b: { x: s[2], y: s[3] } });
  }
  if (diagonals.length === 0) return hint;

  // Polygon orientation (shoelace) so we can tell convex (outside) corners from
  // reflex (inside) ones — a hip only springs from a convex corner.
  let area2 = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    area2 += a.x * b.y - b.x * a.y;
  }
  const ccw = area2 > 0;

  for (let i = 0; i < outline.length; i++) {
    const prev = outline[(i - 1 + outline.length) % outline.length];
    const v = outline[i];
    const next = outline[(i + 1) % outline.length];
    // Cross product of incoming→outgoing edge; sign vs orientation = convexity.
    const cross =
      (v.x - prev.x) * (next.y - v.y) - (v.y - prev.y) * (next.x - v.x);
    const convex = ccw ? cross > 0 : cross < 0;
    if (!convex) continue; // valley corner — not a hip

    // A hip diagonal has an endpoint AT this corner and runs INWARD (its far
    // end sits inside the footprint, away from the corner).
    const hasHip = diagonals.some((d) => {
      const atA = Math.hypot(d.a.x - v.x, d.a.y - v.y) <= cornerTol;
      const atB = Math.hypot(d.b.x - v.x, d.b.y - v.y) <= cornerTol;
      if (!atA && !atB) return false;
      const far = atA ? d.b : d.a;
      return pointInPolygon({ x: far.x, y: far.y }, outline);
    });
    if (!hasHip) continue;

    // Mark the two perimeter edges meeting at this corner.
    for (const e of edges) {
      const touches =
        (Math.hypot(e.p1.x - v.x, e.p1.y - v.y) <= cornerTol ||
          Math.hypot(e.p2.x - v.x, e.p2.y - v.y) <= cornerTol) &&
        (e.axis === "h" || e.axis === "v");
      if (touches) hint.add(e.id);
    }
  }
  return hint;
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
 * conflicting with it goes UNPRICED with a verify note — UNLESS a ring
 * neighbor is the gable the label belongs to (labels print at stub corners
 * and the vision read attaches them to the nearest edge: the Woodinville
 * patio's GABLE END TRUSS label landed on both patio SIDES). Parallel
 * verdicts are returned as hints only (see reconcile-edge-classes.ts).
 */
export function applyTrussFieldDemotions(opts: {
  classes: readonly EdgeClass[];
  field: Map<string, TrussFieldVerdict>;
  /** Full perimeter ring, for label re-attribution to a neighboring gable. */
  edges?: readonly OutlineEdge[];
}): TrussFieldResult {
  const classes = opts.classes.map((c) => ({ ...c }));
  const notes: string[] = [];
  const parallelIds = new Set<string>();
  let demoted = 0;

  const ring = opts.edges ?? [];
  const idx = new Map(ring.map((e, i) => [e.id, i]));
  // Re-attribution is for STUB SIDES: a short return whose ∥ neighbor is the
  // clearly longer gable end the label really belongs to. A long wall keeps
  // its label-vs-field conflict as UNPRICED — on an L-plan a merged edge can
  // read perpendicular from the wing's trusses while its printed label is
  // genuine, and flipping it would silently price a real rake.
  const neighborIsParallelGable = (id: string): string | null => {
    const i = idx.get(id);
    if (i == null || ring.length < 3) return null;
    const self = ring[i];
    for (const j of [(i - 1 + ring.length) % ring.length, (i + 1) % ring.length]) {
      const nb = ring[j];
      if (
        opts.field.get(nb.id)?.verdict === "parallel" &&
        self.lenPt <= nb.lenPt * 0.75
      )
        return nb.id;
    }
    return null;
  };

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
      const gableNeighbor = neighborIsParallelGable(cls.id);
      if (gableNeighbor) {
        const was = cls.edge_class;
        cls.edge_class = "eave";
        cls.evidence = [
          ...(cls.evidence ?? []),
          "truss_field_perpendicular",
          "label_reattributed_to_neighbor",
        ];
        demoted++;
        notes.push(
          `📐 ${cls.id} ${was}→EAVE: the framing bears on this wall — the printed gable label belongs to the adjacent gable end ${gableNeighbor}; this side carries the gutter.`,
        );
        continue;
      }
      // Tagged so the elevation reconciler can settle the tie: when the
      // face ALSO reads one continuous gutter line across this wall, two
      // independent sheet reads outvote the stray label (see
      // reconcile-edge-classes.ts). Until then: UNPRICED, visible.
      cls.edge_class = "unknown";
      cls.evidence = [...(cls.evidence ?? []), "truss_field_conflict"];
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
