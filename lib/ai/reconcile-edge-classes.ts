/**
 * Elevation ↔ edge-class reconciliation — the code-enforced cross-check the
 * v2 classifier answers to.
 *
 * The Woodinville production run exposed the failure mode: the classifier
 * applied ONE global truss direction to the whole building and called every
 * side wall a gable and every front/back wall an eave — exactly inverted on
 * half the perimeter. The independent per-face elevation reads already know
 * the truth (north 3 gables, south 1, east 1, west 1 — with positions and
 * spans), so this module makes them binding:
 *
 *   PROMOTE  an eave/unknown edge to rake when a flush elevation gable maps
 *            onto exactly that wall segment (position + span agree). This is
 *            what puts the entry/garage/great-room gables back on the front.
 *   DEMOTE   a rake call with no strong sheet evidence (no GABLE END TRUSS /
 *            barge label) and no elevation gable mapping to it — to eave when
 *            that face reads a continuous eave line, else to unknown
 *            (UNPRICED, visible). This is what recovers the guttered sides.
 *   NEVER    touch an edge whose rake call carries a printed label
 *            (gable_end_truss_label / barge_or_rake_callout) — the sheet's
 *            own words outrank a summary elevation read; conflicts get noted.
 *
 * Set-back gables (dormers / frame-overs above a lower roof) never map to a
 * perimeter edge — the eave below them keeps its gutter.
 *
 * Pure module — no AI, no server-only imports; runs under node --test.
 */

import type { OutlineEdge, OverlayPt } from "./plan-overlay";
import type { EdgeClass } from "./edge-takeoff";
import { detectAsymmetricJogs, type FaceReadingRaw } from "./face-merge";
import {
  DEFAULT_FACE_NORMALS,
  deriveOrientationFromFaceTitles,
  sideOfPerimeterEdge,
  type FaceName,
  type FaceNormals,
} from "./plan-orientation";

/** A projecting roof mass (open porch/patio/garage on posts or a beam) whose
 *  gable maps onto a base-line house wall but whose OWN eaves/gutters sit
 *  beyond the traced wall outline — so they are never in the edge ring and
 *  price at $0. Emitted so the estimate assembler can synthesize an
 *  ESTIMATED gutter line from the roof-area schedule (area ÷ span) instead of
 *  dropping the LF on the floor. See the posts/beam gate below. */
export type DroppedProjection = {
  face: Side;
  /** porch | patio | entry | garage | dormer | main | other (from the read). */
  kind: string;
  supportedOn: "wall" | "posts" | "beam" | "unknown";
  /** Gable span (the projecting mass's WIDTH along the wall), if the
   *  elevation read it — the divisor in depth = area ÷ span. */
  spanFt: number | null;
  /** Cover roof form from the elevation read (cover_form) — lets the LF
   *  synthesis price the right sides (gable = 2 side returns, hip = the
   *  gutter wraps 3 sides, shed = the low edge only). Absent on older reads. */
  form?: "gable" | "hip" | "shed";
  /** SHORTFALL signal: the gable DID land on a traced bump-out, but the
   *  roof-area schedule says the roof runs deeper than the bump-out's traced
   *  returns (this many ft). The synthesis must add 2 × (depth − stubReturnFt)
   *  ONLY — the traced stub sides are already priced and must never be
   *  double-counted. */
  stubReturnFt?: number;
};

/** A REAL elevation gable one of the money gates rejected from the perimeter
 *  (overframe / eave-runs-in-front / decorative-beam routing). The wall keeps
 *  its class and its gutter — this is a DRAWING channel only, so the roof
 *  layout can still show the gable end above the priced eave instead of
 *  degenerating to an all-hip skeleton (the Woodinville hip-rendered wings). */
export type FrameOverEnd = {
  edgeId: string;
  spanFt: number | null;
  /** Gable center along its face, 0..1 viewer-left→right (pinning's u). */
  u: number;
  /** "truss-conflict": the label-vs-field resolution ladder priced the wall
   *  as an eave and parked the elevation gable ABOVE it for drawing. */
  source: "overframe" | "forced-flush" | "beam" | "truss-conflict";
};

export type ReconcileResult = {
  classes: EdgeClass[];
  notes: string[];
  promoted: number;
  demoted: number;
  unknowns: number;
  /** Projecting masses whose own gutters are outside the traced outline —
   *  candidates for an estimated-LF synthesis downstream (never priced here). */
  droppedProjections: DroppedProjection[];
  /** Gables rejected from the perimeter but real on the elevations — drawn
   *  above the eave by the roof layout, tagged verify. Never changes pricing. */
  frameOverEnds: FrameOverEnd[];
};

type Side = "front" | "back" | "left" | "right";

/** Evidence tags that outrank an elevation summary — the sheet's own words
 *  (printed labels, and the framing field read directly off the linework). */
const STRONG_RAKE_EVIDENCE = new Set([
  "gable_end_truss_label",
  "barge_or_rake_callout",
  "truss_field_parallel",
]);

const sideOfNormal = (n: { x: number; y: number }): Side =>
  Math.abs(n.y) >= Math.abs(n.x)
    ? n.y >= 0
      ? "front"
      : "back"
    : n.x >= 0
      ? "right"
      : "left";

/** Does this edge protrude from its side — i.e. do BOTH ring neighbors step
 *  back inward from its line? Open porch/patio roofs sit on protruding
 *  stubs; their elevation gables must never consume a base-line house wall. */
function isProtrusion(
  e: OutlineEdge,
  edges: readonly OutlineEdge[],
  outline: readonly OverlayPt[],
  ptPerFt?: number | null,
): boolean {
  const n = edges.length;
  if (n < 4) return false;
  const idx = edges.findIndex((x) => x.id === e.id);
  if (idx < 0) return false;
  const prev = edges[(idx - 1 + n) % n];
  const next = edges[(idx + 1) % n];
  // A stub is a LOCAL feature: two CLEARLY shorter perpendicular returns,
  // and the outer edge itself well under the building's span (a full-width
  // wall of a simple rectangle is not a stub even though all of its geometry
  // is "inward"; a side wall whose neighbor is a near-equal back wall isn't
  // one either — the Woodinville E13/E3 leak).
  // Returns must be clearly shorter than the stub — but a deep square porch
  // (8x7 ft) is still a stub, so allow returns up to ~8 ft absolute when the
  // scale is known.
  const maxReturn = Math.max(
    e.lenPt * 0.8,
    ptPerFt && ptPerFt > 0 ? 8 * ptPerFt : 0,
  );
  if (prev.lenPt > maxReturn || next.lenPt > maxReturn) return false;
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const axisSpan =
    e.axis === "h"
      ? Math.max(...xs) - Math.min(...xs)
      : e.axis === "v"
        ? Math.max(...ys) - Math.min(...ys)
        : Math.max(
            Math.max(...xs) - Math.min(...xs),
            Math.max(...ys) - Math.min(...ys),
          );
  if (e.lenPt > axisSpan * 0.5) return false;
  // Inward = from the edge line toward the polygon centroid's side of it.
  const cx = outline.reduce((s, p) => s + p.x, 0) / outline.length;
  const cy = outline.reduce((s, p) => s + p.y, 0) / outline.length;
  const dx = e.p2.x - e.p1.x;
  const dy = e.p2.y - e.p1.y;
  const len = Math.hypot(dx, dy) || 1;
  // Normal pointing toward the centroid.
  let nx = -dy / len;
  let ny = dx / len;
  if ((cx - e.mid.x) * nx + (cy - e.mid.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const depthOf = (p: OverlayPt) =>
    (p.x - e.mid.x) * nx + (p.y - e.mid.y) * ny;
  const minStep = Math.max(8, len * 0.15);
  // The far endpoint of each neighbor must sit clearly inward of the edge line.
  const prevFar = prev.p1;
  const nextFar = next.p2;
  return depthOf(prevFar) > minStep && depthOf(nextFar) > minStep;
}

export function reconcileEdgeClasses(opts: {
  outline: readonly OverlayPt[];
  edges: readonly OutlineEdge[];
  classes: readonly EdgeClass[];
  perFace: Partial<Record<string, FaceReadingRaw>> | null | undefined;
  ptPerFt?: number | null;
  /** Edge ids whose framing field reads PARALLEL (gable-end arrays) — the
   *  sheet's own gable hints, promoted when the face corroborates. */
  fieldParallel?: ReadonlySet<string> | null;
  /** Edge ids whose framing field reads PERPENDICULAR (trusses bear on the
   *  wall) — never promotable to rake; a gable mapping here is a frame-over
   *  above the eave. */
  fieldEave?: ReadonlySet<string> | null;
  /** Roof-area schedule masses (label + sf) when the sheet printed one — the
   *  beam/posts gate's off-outline plausibility evidence and the shortfall
   *  math's depth source. Optional; absent ⇒ those checks stay conservative. */
  roofMasses?: readonly { label: string; areaFt2: number }[] | null;
}): ReconcileResult {
  const noop = (why?: string): ReconcileResult => ({
    classes: opts.classes.map((c) => ({ ...c })),
    notes: why ? [why] : [],
    promoted: 0,
    demoted: 0,
    unknowns: 0,
    droppedProjections: [],
    frameOverEnds: [],
  });
  try {
    const { outline, edges, perFace } = opts;
    if (!perFace || outline.length < 3) return noop();
    const faces = ["north", "south", "east", "west"] as const;
    // House-relative face names map 1:1 onto the footprint sides with NO
    // compass — front=bottom edge, rear=top, left, right (the front-at-bottom
    // drafting convention). A set titled FRONT/RIGHT SIDE/REAR/LEFT SIDE (no
    // compass) is read house-relative upstream; without this branch its
    // fully-legible hip elevations were discarded and a gable-biased guess won.
    const HR_FOR_SIDE: Record<Side, string> = {
      front: "front",
      back: "rear",
      left: "left",
      right: "right",
    };
    // Each side's outward canvas normal (front-at-bottom, y down). Equivalent to
    // normals[compassFace] for compass plans (faceForSide placed that face here
    // precisely because its normal points this way), and the ONLY normal we have
    // for a house-relative read — so use it uniformly.
    const SIDE_NORMAL: Record<Side, { x: number; y: number }> = {
      front: { x: 0, y: 1 },
      back: { x: 0, y: -1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 },
    };
    const anyCompass = faces.some((f) => perFace[f]?.readable);
    const anyHouseRel = (["front", "back", "left", "right"] as Side[]).some(
      (s) => perFace[HR_FOR_SIDE[s]]?.readable,
    );
    if (!anyCompass && !anyHouseRel) return noop();

    const normals: FaceNormals =
      deriveOrientationFromFaceTitles(perFace)?.normals ?? DEFAULT_FACE_NORMALS;
    // compass face → canvas side its outward normal points to
    const faceForSide = new Map<Side, FaceName>();
    for (const f of faces) faceForSide.set(sideOfNormal(normals[f]), f);
    // Per side, prefer a readable HOUSE-RELATIVE read (which already names the
    // side directly) over the compass-mapped face.
    const readingForSide = (
      side: Side,
    ): { faceLabel: string | undefined; reading: FaceReadingRaw | undefined } => {
      const hr = HR_FOR_SIDE[side];
      if (perFace[hr]?.readable) return { faceLabel: hr, reading: perFace[hr] };
      const cf = faceForSide.get(side);
      return { faceLabel: cf, reading: cf ? perFace[cf] : undefined };
    };

    const classes = opts.classes.map((c) => ({ ...c }));
    const droppedProjections: DroppedProjection[] = [];
    const frameOverEnds: FrameOverEnd[] = [];
    // Roof-area schedule lookup, same label-containment match the downstream
    // synthesis uses (projection-lf.ts) — "COVERED PORCH" matches kind porch.
    // main/other/dormer never match: only a mass the schedule NAMED counts.
    const roofMasses = opts.roofMasses ?? [];
    const massFor = (kind: string | null | undefined) => {
      const k = (kind ?? "").toLowerCase();
      if (!k || k === "main" || k === "other" || k === "dormer") return null;
      const wanted = k === "entry" ? ["entry", "porch"] : [k];
      let best: { label: string; areaFt2: number } | null = null;
      for (const m of roofMasses) {
        const label = (m.label ?? "").toLowerCase();
        if (!label) continue;
        if (wanted.some((w) => label.includes(w) || w.includes(label))) {
          if (!best || m.areaFt2 > best.areaFt2) best = m;
        }
      }
      return best;
    };
    // The elevation read's porch/patio cover form (cover_form is a newer read
    // field — access defensively so older stored reads stay valid).
    const formOfCover = (g: unknown): "gable" | "hip" | "shed" | undefined => {
      const cf = (g as { cover_form?: unknown }).cover_form;
      return cf === "front_gabled"
        ? "gable"
        : cf === "hipped"
          ? "hip"
          : cf === "shed"
            ? "shed"
            : undefined;
    };
    const byId = new Map(classes.map((c) => [c.id, c]));
    const fieldParallel = opts.fieldParallel ?? new Set<string>();
    const fieldEave = opts.fieldEave ?? new Set<string>();
    const notes: string[] = [];
    let promoted = 0;
    let demoted = 0;
    let unknowns = 0;
    let hipVetoed = 0;
    // Edges an elevation gable claimed on ANY side — pass 4 must not touch a
    // wall that is itself disputed as a gable candidate.
    const claimedByGable = new Set<string>();

    for (const side of ["front", "back", "left", "right"] as Side[]) {
      const { faceLabel: face, reading } = readingForSide(side);
      if (!reading || reading.readable === false) continue;

      const sideEdges = edges.filter(
        (e) =>
          e.lenPt > 1e-6 &&
          sideOfPerimeterEdge(e.p1, e.p2, outline) === side &&
          byId.has(e.id),
      );
      if (sideEdges.length === 0) continue;

      // Order the side's edges the way the elevation VIEWER sees them
      // (left→right), same convention place-gables pins with tests:
      // rightDir = (n.y, -n.x) for outward normal n.
      const n = SIDE_NORMAL[side];
      const rd = { x: n.y, y: -n.x };
      const proj = (p: OverlayPt) => p.x * rd.x + p.y * rd.y;
      let lo = Infinity;
      let hi = -Infinity;
      for (const e of sideEdges) {
        lo = Math.min(lo, proj(e.p1), proj(e.p2));
        hi = Math.max(hi, proj(e.p1), proj(e.p2));
      }
      const extent = hi - lo;
      if (!Number.isFinite(extent) || extent <= 0) continue;
      const uOf = (p: OverlayPt) => (proj(p) - lo) / extent;
      const spans = sideEdges.map((e) => {
        const a = uOf(e.p1);
        const b = uOf(e.p2);
        return { e, u0: Math.min(a, b), u1: Math.max(a, b) };
      });
      // Pin a gable position to ONE edge — the containing span, else the
      // nearest center within a quarter of the face. SHARED by the mapping,
      // the frame-over demote, and the 2b recovery so one gable can never
      // act on two different walls (a frame-over pinned to the house wall
      // must not also demote the neighboring garage's true gable end).
      const pinEdge = (posFrac: number | null | undefined) => {
        if (posFrac == null) return null;
        const u = Math.max(0, Math.min(1, posFrac));
        // Among candidates, the NEAREST CENTER wins — the ±0.05 boundary
        // slack makes adjacent spans overlap, and first-found would pin by
        // ring order instead of by geometry.
        const nearest = (cands: typeof spans) =>
          cands.reduce(
            (best, sp) => {
              const c = (sp.u0 + sp.u1) / 2;
              const d = Math.abs(c - u);
              return d < best.d ? { d, s: sp } : best;
            },
            { d: Infinity, s: null as (typeof spans)[number] | null },
          ).s;
        // Strict containment first — the spans partition the face, so at
        // most one wall strictly contains u and it IS the gable's wall (a
        // narrow entry stub must not lose its gable to a wide neighbor
        // whose center happens to sit closer).
        const strict = spans.filter((sp) => u >= sp.u0 && u <= sp.u1);
        if (strict.length > 0) return nearest(strict);
        const containing = spans.filter(
          (sp) => u >= sp.u0 - 0.05 && u <= sp.u1 + 0.05,
        );
        const hit = containing.length > 0 ? nearest(containing) : nearest(spans);
        if (!hit || Math.abs((hit.u0 + hit.u1) / 2 - u) > 0.25) return null;
        return hit;
      };

      // Shared partial-gable carve: the face-window [g0,g1] the gable's
      // position + span cover on its wall, clamped to the wall, expressed as
      // a [u0,u1] interval along the EDGE (0=p1, 1=p2). ONE implementation
      // for both callers — the eave-base carve and the field-conflict
      // resolution ladder — so the two money paths can never drift apart.
      const carveGable = (
        hit: { e: OutlineEdge; u0: number; u1: number },
        u: number,
        spanPt: number,
      ): {
        clampedCleanly: boolean;
        remainderFt: number;
        interval: { u0: number; u1: number } | null;
      } => {
        const a1 = uOf(hit.e.p1);
        const a2 = uOf(hit.e.p2);
        const spanU = spanPt / extent;
        const g0 = Math.max(hit.u0, u - spanU / 2);
        const g1 = Math.min(hit.u1, u + spanU / 2);
        // If clamping to the wall ate a real slice of the read span, the
        // gable straddles the corner — position/span is suspect and the
        // clamped-off part would price as gutter.
        const clampedCleanly = g1 - g0 >= spanU * 0.75;
        const remainderFt =
          (hit.e.lenPt - Math.max(0, g1 - g0) * extent) / (opts.ptPerFt || 1);
        if (!(Math.abs(a2 - a1) > 1e-9 && g1 > g0)) {
          return { clampedCleanly, remainderFt, interval: null };
        }
        const t0 = (g0 - a1) / (a2 - a1);
        const t1 = (g1 - a1) / (a2 - a1);
        return {
          clampedCleanly,
          remainderFt,
          interval: { u0: Math.min(t0, t1), u1: Math.max(t0, t1) },
        };
      };

      // Flush/at-the-eave gables only — a set-back gable rises BEHIND a
      // guttered eave and must not consume a perimeter edge. When the face
      // reads a CONTINUOUS eave line, a flush wall-plane gable is physically
      // impossible unless the read explicitly places it at the eave — treat
      // set-back-unknown gables on such faces as frame-overs/dormers.
      const gablesAll = reading.gables ?? [];
      // FLOATING gables — reported on this side but never pinned to a wall.
      // Two very different kinds:
      //   UNPINNED (null/bad position, failed re-pin): the gable could sit
      //   ANYWHERE — including on a conflicted label's wall — so its presence
      //   still vetoes the pass-2b recovery (the tie stands).
      //   ABOVE-EAVE (null set-back dropped by the continuous-eave filter):
      //   the face reads ONE gutter line across its full width, so this gable
      //   is above that line by definition — it can't be the conflicted
      //   label's wall plane and does NOT veto 2b; on a 2b recovery it is
      //   recorded to frameOverEnds so the drawing still gains the gable.
      let floatingUnpinned = 0;
      const floatingAboveEave: (typeof gablesAll)[number][] = [];
      // Gables the elevation itself saw a gutter line running IN FRONT of —
      // frame-overs on stepped faces (no single continuous line to gate on).
      // They never consume a wall, and the wall at their position KEEPS its
      // gutter (see the demote pass below).
      const frameOverGables: {
        g: (typeof gablesAll)[number];
        pin: ReturnType<typeof pinEdge>;
      }[] = [];
      const flushGables = gablesAll.filter((g) => {
        if (g.eave_passes_in_front === true) {
          const pin = pinEdge(g.position_frac);
          const spanPt =
            g.span_ft != null && opts.ptPerFt ? g.span_ft * opts.ptPerFt : null;
          // A gable as wide as (almost) its whole wall IS the wall plane —
          // frame-overs read narrower (same exemption the continuous gate
          // carries). A misread boolean must not price away a full-width
          // gable end: treat it as flush and let the mapping decide. But a
          // span CLEARLY WIDER than the wall is the opposite proof: the eave
          // runs in front AND the roof spans past the wall — definitionally
          // a frame-over, so it stays in the frame-over channel. (The old
          // >=0.8× check alone rerouted exactly the over-wide side gables it
          // should protect into the flush path, where the overframe gate
          // then discarded them — no gable end drawn, wings rendered as
          // hips: the Woodinville E13/E3 failure.)
          if (
            pin &&
            spanPt != null &&
            spanPt >= pin.e.lenPt * 0.8 &&
            spanPt <= pin.e.lenPt * 1.08
          )
            return true;
          if (pin) {
            frameOverGables.push({ g, pin });
            // Real gable, rejected from the perimeter — record it so the
            // layout still DRAWS the gable end above the priced eave.
            frameOverEnds.push({
              edgeId: pin.e.id,
              spanFt: typeof g.span_ft === "number" ? g.span_ft : null,
              u: Math.max(0, Math.min(1, g.position_frac ?? 0.5)),
              source: "forced-flush",
            });
          } else floatingUnpinned++; // unpinnable frame-over — ambiguous, vetoes 2b
          return false;
        }
        const sb = typeof g.set_back_ft === "number" ? g.set_back_ft : null;
        if (sb != null) return sb <= 2;
        if (reading.continuous_eave === true) floatingAboveEave.push(g);
        return reading.continuous_eave !== true;
      });
      if (gablesAll.length > flushGables.length) {
        const skipped = gablesAll.length - flushGables.length;
        notes.push(
          `🧭 ${face} elevation: ${skipped} gable(s) sit above the continuous eave line (frame-over/dormer) — the gutter below them stays.`,
        );
      }
      // Diagnostic: the frame-over defense needs the eave_passes_in_front
      // read. When EVERY gable on the face lacks it, the reads ran on an
      // old prompt — most likely a stale /admin/prompts override.
      if (
        gablesAll.length > 0 &&
        gablesAll.every((g) => g.eave_passes_in_front == null)
      ) {
        notes.push(
          `⚠ ${face} face read carries no eave-in-front data — the elevation prompt may be outdated or overridden at /admin/prompts; frame-over gables can tent guttered walls without it.`,
        );
      }

      // 1) PROMOTE: map each elevation gable onto its wall segment.
      const confirmed = new Set<string>();
      // Gables pinned per rake edge — TWO gables on one wall is the
      // signature of a missing footprint jog (each should own its own
      // wall segment); the un-gabled remainder ships unpriced, so say so.
      const rakePins = new Map<string, { count: number; spanPt: number }>();
      // Walls the field-conflict RESOLUTION LADDER resolved (frame-over eave
      // or rake-over-span split) — their gable IS placed even though the
      // class isn't rake, so the budget check must count them.
      const ladderPlaced = new Set<string>();
      // Edges a flush gable tried to claim but the framing field blocked —
      // a label-conflict on such an edge stays a genuine tie (see 2b).
      const gableBlockedByField = new Set<string>();
      // SHORTFALL: a porch/patio gable landed on a traced bump-out, but the
      // roof-area schedule says its roof runs DEEPER than the bump-out's
      // traced returns — the extra depth's side gutter sits outside the
      // outline and would price at $0. Emit the signal (with the traced
      // return length) so the downstream synthesis adds ONLY the flagged
      // difference, 2 × (depth − stubReturnFt) — never the stub sides again.
      const emitStubShortfall = (
        g: (typeof gablesAll)[number],
        stubEdge: OutlineEdge,
      ) => {
        if (!opts.ptPerFt || typeof g.span_ft !== "number" || g.span_ft < 6)
          return;
        const kindRaw = (g.kind ?? "").toLowerCase();
        const kindN = kindRaw === "entry" ? "porch" : kindRaw;
        if (kindN !== "porch" && kindN !== "patio") return;
        if (!isProtrusion(stubEdge, edges, outline, opts.ptPerFt)) return;
        const mass = massFor(kindRaw);
        if (!mass || !(mass.areaFt2 >= 60 && mass.areaFt2 <= 4000)) return;
        const depthFt = mass.areaFt2 / g.span_ft;
        if (!(depthFt >= 4 && depthFt <= 60)) return;
        const ringN = edges.length;
        const idx = edges.findIndex((x) => x.id === stubEdge.id);
        if (idx < 0) return;
        const stubReturnFt =
          Math.max(
            edges[(idx - 1 + ringN) % ringN].lenPt,
            edges[(idx + 1) % ringN].lenPt,
          ) / opts.ptPerFt;
        if (depthFt - stubReturnFt < 3) return; // not materially deeper
        droppedProjections.push({
          face: side,
          kind: g.kind ?? "porch",
          supportedOn:
            g.supported_on === "posts" ||
            g.supported_on === "beam" ||
            g.supported_on === "wall"
              ? g.supported_on
              : "unknown",
          spanFt: g.span_ft,
          form: formOfCover(g) ?? "gable",
          stubReturnFt: Math.round(stubReturnFt * 10) / 10,
        });
      };
      for (const g of flushGables) {
        if (g.position_frac == null) {
          floatingUnpinned++;
          continue;
        }
        const u = Math.max(0, Math.min(1, g.position_frac));
        let hit = pinEdge(g.position_frac);
        if (!hit) {
          floatingUnpinned++;
          continue;
        }
        const spanPt =
          g.span_ft != null && opts.ptPerFt ? g.span_ft * opts.ptPerFt : null;
        // SPAN-AWARE PIN: position alone picked a protruding stub FAR
        // narrower than the gable (the Woodinville E8: a 20-ft garage gable
        // consumed an 8-ft entry stub). Position is the weakest read, so
        // prefer a same-side wall whose LENGTH matches the span near the
        // same spot; with no such wall the gable stays UNPLACED (floating)
        // — it must never delete the stub's gutter on a position guess.
        // Either way the STUB keeps its own base reading: it is CONFIRMED so
        // the step-2 demote can't re-class it (a rake stub flipped to eave
        // would bill gutter across the bump-out's own gable end — the note
        // promises "the bump-out keeps its own reading", so enforce it).
        let spanRepinned = false;
        if (
          spanPt != null &&
          spanPt > hit.e.lenPt * 1.5 &&
          isProtrusion(hit.e, edges, outline, opts.ptPerFt)
        ) {
          const stubFt = Math.round(hit.e.lenPt / (opts.ptPerFt || 1));
          const pinnedId = hit.e.id;
          const better = spans
            .filter(
              (sp) =>
                sp.e.id !== pinnedId &&
                Math.abs(sp.e.lenPt - spanPt) <= spanPt * 0.25 &&
                Math.abs((sp.u0 + sp.u1) / 2 - u) <= 0.25,
            )
            .reduce(
              (best, sp) => {
                const d = Math.abs((sp.u0 + sp.u1) / 2 - u);
                return d < best.d ? { d, s: sp } : best;
              },
              { d: Infinity, s: null as (typeof spans)[number] | null },
            ).s;
          confirmed.add(pinnedId); // the stub keeps its own reading
          if (better) {
            notes.push(
              `🧭 ${face} elevation: its ${g.kind ?? "gable"} gable reads ${Math.round(g.span_ft!)}ft — far wider than the ${stubFt}ft bump-out at its position — but the ${Math.round(better.e.lenPt / (opts.ptPerFt || 1))}ft wall beside it matches the span, so the gable was placed there instead. Verify.`,
            );
            hit = better;
            spanRepinned = true;
          } else {
            floatingUnpinned++;
            notes.push(
              `🧭 ${face} elevation: its ${g.kind ?? "gable"} gable reads ${Math.round(g.span_ft!)}ft but sits over the ${stubFt}ft bump-out and no same-side wall matches the span — the gable was left unplaced (nothing tented; the bump-out keeps its own reading). Review gable placement.`,
            );
            continue;
          }
        }
        const cls = byId.get(hit.e.id)!;
        // The framing field says this wall BEARS trusses — the gable the
        // elevation sees here needs resolving against the wall, not blind
        // parking (the Woodinville E3/E9 ~106 LF shipped UNPRICED because
        // this check used to act on nothing). RESOLUTION LADDER — every rung
        // a deterministic gate, and only (d) still parks the wall:
        //   (hip)  hip read → the "gable" is a hip end; eave per framing.
        //   (a)    the gable sits ABOVE a running eave/gutter line
        //          (eave-in-front read / continuous face / span wider than
        //          the wall) → frame-over: gutter priced full, gable drawn
        //          above the eave.
        //   (b)    label-vs-field conflict + gable clearly narrower than the
        //          wall → the E4 mechanism: rake over the span, gutter kept
        //          on the remainder (the framing bears there).
        //   (c)    label-vs-field conflict + full-wall gable at the eave
        //          line → rake (label + elevation outvote the truss read);
        //          an off-center fit that leaves a real run still splits.
        //   (d)    nothing mappable → today's park: UNPRICED, review.
        // Rungs (b)/(c) REMOVE gutter, so they additionally require the
        // edge's own label conflict (printed gable label / parked
        // truss_field_conflict) — a bare elevation gable on a truss-bearing
        // wall stays a frame-over question (fieldEave's contract: never
        // promotable to rake on an elevation read alone).
        if (fieldEave.has(cls.id)) {
          // (hip-first) A hip end carries a gutter — eave per framing, and
          // nothing is drawn above it (NO frameOverEnds entry).
          if (reading.roof_form === "hipped" || g.is_hip_end === true) {
            notes.push(
              `🛖 ${cls.id}: the ${face} elevation reads a hip end here and the framing bears on this wall — eave per framing, not tented` +
                (cls.edge_class === "eave"
                  ? "."
                  : "; the wall stays under review (UNPRICED)."),
            );
            continue;
          }
          // (a) The gable rises ABOVE a running eave/gutter line — the wall
          // under it is a guttered eave (frame-over); the gable is real and
          // is drawn above it.
          if (
            g.eave_passes_in_front === true ||
            reading.continuous_eave === true ||
            (spanPt != null && spanPt > hit.e.lenPt * 1.08)
          ) {
            const was = cls.edge_class;
            if (was !== "eave") {
              cls.edge_class = "eave";
              demoted++;
            }
            cls.evidence = [
              ...(cls.evidence ?? []),
              "field_conflict_frame_over",
            ];
            frameOverEnds.push({
              edgeId: cls.id,
              spanFt: typeof g.span_ft === "number" ? g.span_ft : null,
              u,
              source: "truss-conflict",
            });
            confirmed.add(cls.id);
            ladderPlaced.add(cls.id);
            notes.push(
              `🧭 ${cls.id} ${was === "eave" ? "EAVE kept" : `${was}→EAVE`}: the framing bears on this wall AND the ${face} elevation shows its gable ABOVE a running eave/gutter line (frame-over) — gutter priced full; the gable is drawn above the eave. VERIFY against the building sections before quoting.`,
            );
            continue;
          }
          const labelConflict = (cls.evidence ?? []).some(
            (t) => t === "truss_field_conflict" || STRONG_RAKE_EVIDENCE.has(t),
          );
          if (spanPt != null && labelConflict) {
            const applyFieldSplit = (
              remainderFt: number,
              interval: { u0: number; u1: number },
            ) => {
              if (cls.edge_class !== "eave") {
                cls.edge_class = "eave";
                demoted++;
              }
              cls.partial_gables = [...(cls.partial_gables ?? []), interval];
              cls.evidence = [...(cls.evidence ?? []), "field_conflict_split"];
              confirmed.add(cls.id);
              ladderPlaced.add(cls.id);
              notes.push(
                `🧭 ${cls.id}: printed gable label vs framing INTO this wall — resolved by the ${face} elevation: rake over its ~${Math.round(g.span_ft!)}ft gable span, gutter kept on the remaining ~${Math.round(remainderFt)}ft (the framing bears there). VERIFY both ends against the roof plan.`,
              );
            };
            // (b) clearly narrower than the wall → rake-over-span split.
            if (spanPt <= hit.e.lenPt * 0.8 && !fieldParallel.has(cls.id)) {
              const carve = carveGable(hit, u, spanPt);
              if (
                carve.clampedCleanly &&
                carve.remainderFt >= 6 &&
                carve.interval
              ) {
                applyFieldSplit(carve.remainderFt, carve.interval);
                continue;
              }
              // straddling/sliver — fall through to the park (d).
            } else if (
              spanPt > hit.e.lenPt * 0.8 &&
              spanPt <= hit.e.lenPt * 1.08
            ) {
              // (c) full-wall gable AT the eave line — eave_passes===true
              // can't reach here (rung (a) consumed it and continued). An
              // off-center fit that still leaves a real gutter run splits
              // like (b); else rake.
              const carve = fieldParallel.has(cls.id)
                ? null
                : carveGable(hit, u, spanPt);
              if (
                carve &&
                carve.clampedCleanly &&
                carve.remainderFt >= 6 &&
                carve.interval
              ) {
                applyFieldSplit(carve.remainderFt, carve.interval);
                continue;
              }
              cls.edge_class = "rake";
              cls.evidence = [
                ...(cls.evidence ?? []),
                "elevation_gable_mapped",
              ];
              promoted++;
              confirmed.add(cls.id);
              const acc = rakePins.get(cls.id) ?? { count: 0, spanPt: 0 };
              acc.count++;
              acc.spanPt += spanPt;
              rakePins.set(cls.id, acc);
              notes.push(
                `🧭 ${cls.id} → RAKE: the printed gable label AND a full-wall elevation gable outvote the truss read — gable end, no gutter. Verify.`,
              );
              continue;
            }
          }
          // (d) nothing resolvable — today's park, exactly.
          gableBlockedByField.add(cls.id);
          notes.push(
            `🧭 ${cls.id}: the ${face} elevation shows a gable here, but the framing bears on this wall — frame-over above the eave; ` +
              (cls.edge_class === "eave"
                ? "the gutter stays."
                : "the wall stays under review (UNPRICED)."),
          );
          continue;
        }
        // HIP VETO: when the face reads HIPPED (every edge a horizontal eave) or
        // the reader marked THIS shape a hip end (is_hip_end), the "gable" is a
        // hip — it carries a gutter. Never promote its wall to a rake. This is
        // the deterministic counter-evidence a hip-dominant roof was missing;
        // it is gutter-PROTECTIVE (keeps the base eave/unknown, invents nothing)
        // and yields to a printed rake label (the sheet's own words win).
        const faceHipped = reading?.roof_form === "hipped";
        if (
          (faceHipped || g.is_hip_end === true) &&
          !(cls.evidence ?? []).some((t) => STRONG_RAKE_EVIDENCE.has(t))
        ) {
          hipVetoed++;
          notes.push(
            `🛖 ${cls.id}: the ${face} elevation reads a HIP end here (${faceHipped ? "hipped face" : "hip-end shape"}), not a gable — the roof sheds to a gutter across this wall. Kept the eave; not tented. Verify.`,
          );
          continue;
        }
        // BUDGET DEDUPE: the face reads ONE gable, its position pinned to a
        // BASE-LINE wall, but a protruding bump-out on this side already
        // carries a rake inside the gable's span window — the elevation's
        // gable IS that bump-out's gable end (a rear patio/porch roof seen
        // straight-on). One gable must not tent two walls: it is placed on
        // the bump-out and the wall behind keeps its gutter (the Woodinville
        // E16 phantom rear rake).
        //
        // Guards (each one is a demonstrated over-fire): never after the
        // span-aware re-pin already moved this gable (the re-pin would be
        // undone in the same breath); never when the span ≈ the parent wall
        // (0.8×+ — a perfect-fit parent IS the gable end and must win over
        // any stray bump; wider still belongs to the overframe gate below);
        // and the bump-out must be a plausible END for this gable — its
        // length near the span and its CENTER inside the span window (the
        // window grows with span, so overlap alone let any rake bump capture
        // a wide gable).
        if (
          flushGables.length === 1 &&
          !spanRepinned &&
          spanPt != null &&
          spanPt < hit.e.lenPt * 0.8 &&
          !isProtrusion(hit.e, edges, outline, opts.ptPerFt) &&
          !(cls.evidence ?? []).some((t) => STRONG_RAKE_EVIDENCE.has(t)) &&
          !fieldParallel.has(cls.id)
        ) {
          const halfSpanU = spanPt / extent / 2;
          const stub = spans.find(
            (sp) =>
              sp.e.id !== hit!.e.id &&
              byId.get(sp.e.id)!.edge_class === "rake" &&
              sp.e.lenPt >= spanPt * 0.35 &&
              sp.e.lenPt <= spanPt * 1.6 &&
              (sp.u0 + sp.u1) / 2 >= u - halfSpanU &&
              (sp.u0 + sp.u1) / 2 <= u + halfSpanU &&
              isProtrusion(sp.e, edges, outline, opts.ptPerFt),
          );
          if (stub) {
            confirmed.add(stub.e.id);
            const acc = rakePins.get(stub.e.id) ?? { count: 0, spanPt: 0 };
            acc.count++;
            if (spanPt != null) acc.spanPt += spanPt;
            rakePins.set(stub.e.id, acc);
            if (cls.edge_class === "rake") {
              cls.edge_class = "eave";
              cls.evidence = [...(cls.evidence ?? []), "gable_budget_dedupe"];
              demoted++;
            }
            notes.push(
              `🧭 ${cls.id}: the ${face} elevation's only gable is the protruding bump-out's gable end (${stub.e.id}) — one gable can't tent two walls, so ${cls.edge_class === "eave" ? "this wall keeps its gutter" : "this wall stays under review (UNPRICED)"}. Verify.`,
            );
            emitStubShortfall(g, stub.e);
            continue;
          }
        }
        // OVERFRAME GATE: a gable that reads clearly WIDER than the wall it
        // pins to cannot be that wall's plane — its roof spans PAST the wall
        // (an overframe; the section sheets print these as "FRAME-OVER PER
        // PLAN"). Protruding stubs are exempt: their inset walls read
        // narrower than the roof they carry. Sheet evidence (printed label /
        // gable-end framing) overrides. A rake call here ships UNPRICED for
        // review; an EAVE call stays priced — the wall keeps its gutter and
        // the note says so (the old note claimed "UNPRICED" on walls that
        // were never unpriced). Either way the gable is real: record it so
        // the layout draws the gable end above the eave.
        if (
          spanPt != null &&
          spanPt > hit.e.lenPt * 1.08 &&
          !(cls.evidence ?? []).some((t) => STRONG_RAKE_EVIDENCE.has(t)) &&
          !fieldParallel.has(cls.id) &&
          !isProtrusion(hit.e, edges, outline, opts.ptPerFt)
        ) {
          frameOverEnds.push({
            edgeId: cls.id,
            spanFt: typeof g.span_ft === "number" ? g.span_ft : null,
            u,
            source: "overframe",
          });
          const wallFt = Math.round(hit.e.lenPt / (opts.ptPerFt || 1));
          if (cls.edge_class === "rake") {
            cls.edge_class = "unknown";
            unknowns++;
            notes.push(
              `🧭 ${cls.id}: the ${face} elevation's ${g.kind ?? "gable"} gable reads ${Math.round(g.span_ft!)}ft — WIDER than this ${wallFt}ft wall, so its roof spans past the wall (overframe/frame-over). Not tented — UNPRICED, review the building sections.`,
            );
          } else {
            notes.push(
              `🧭 ${cls.id}: the ${face} elevation's ${g.kind ?? "gable"} gable reads ${Math.round(g.span_ft!)}ft — WIDER than this ${wallFt}ft wall, so the roof spans past it (frame-over). The wall keeps its gutter; the gable is drawn above the eave — verify.`,
            );
          }
          continue;
        }
        // HARD GATE: the face reads ONE uninterrupted gutter line across its
        // full width — then no wall-plane gable exists on it, whatever the
        // gable's set-back number says (the eave line is the thing we price;
        // trust it over a depth guess). A gable may still consume a wall here
        // with SHEET-side corroboration: a protruding porch/patio stub,
        // gable-end framing, or a printed label.
        if (
          reading.continuous_eave === true &&
          !fieldParallel.has(cls.id) &&
          !(cls.evidence ?? []).some((t) => STRONG_RAKE_EVIDENCE.has(t)) &&
          !isProtrusion(hit.e, edges, outline, opts.ptPerFt) &&
          // A gable as wide as (almost) the whole wall IS the wall plane —
          // frame-overs read narrower. This keeps a true rectangle gable end
          // alive even when the face sloppily reads continuous.
          !(spanPt != null && spanPt >= hit.e.lenPt * 0.8)
        ) {
          notes.push(
            `🧭 ${cls.id}: the ${face} elevation reads one continuous eave/gutter line across this side — its gable sits above the gutter (frame-over); the wall keeps its gutter.`,
          );
          continue;
        }
        // Open porch/patio roofs (on posts/beams) live on protruding stubs.
        // Mapped onto a base-line house wall, the gable belongs to a
        // projecting roof our wall outline cannot see — never unprice the
        // wall for it. PLAUSIBILITY: only porch/patio/entry kinds (or a mass
        // the roof-area schedule NAMED) plausibly project beyond the
        // outline. A MAIN/GARAGE gable "on beams" whose wall matches its
        // span is the opposite read — decorative trellis/beams drawn UNDER a
        // real gable end (the Woodinville garage front) — so the wall IS the
        // gable: the rake lands here and the gutter comes off, loudly.
        if (
          (g.supported_on === "posts" || g.supported_on === "beam") &&
          !isProtrusion(hit.e, edges, outline, opts.ptPerFt)
        ) {
          const kindRaw = (g.kind ?? "other").toLowerCase();
          // Direct projection evidence from the read itself: the elevation
          // SAW the roof project past the wall (cue), guessed its eave
          // projecting, or watched a gutter line run in front of the gable.
          // Any of these means the wall keeps its gutter — the trellis
          // promotion below must never fire over them.
          const projectionCue =
            (g as { shows_projection_cue?: unknown }).shows_projection_cue ===
              true ||
            (g as { eave_condition_guess?: unknown }).eave_condition_guess ===
              "projecting" ||
            g.eave_passes_in_front === true;
          // Only a MAIN/GARAGE gable can be the "decorative trellis drawn
          // under a real gable end" read. The elevation prompt mandates kind
          // "other" for every unlabelled projecting mass (porch covers,
          // carports…), so anything else — other/porch/patio/entry/dormer or
          // a schedule-named mass — plausibly lies beyond the outline.
          const plausiblyBeyond =
            (kindRaw !== "main" && kindRaw !== "garage") ||
            projectionCue ||
            massFor(kindRaw) != null;
          if (
            !plausiblyBeyond &&
            spanPt != null &&
            hit.e.lenPt >= spanPt * 0.7 &&
            hit.e.lenPt <= spanPt * 1.6
          ) {
            // ⚠ REMOVES LF where the plan shows a gable end — deterministic
            // gate (beam/posts read + main/garage kind + wall ≈ span + base
            // line) and a loud verify note. A wrong eave here would bill
            // gutter across a rake.
            if (cls.edge_class !== "rake") {
              cls.edge_class = "rake";
              promoted++;
            }
            cls.evidence = [...(cls.evidence ?? []), "elevation_gable_mapped"];
            confirmed.add(cls.id);
            const acc = rakePins.get(cls.id) ?? { count: 0, spanPt: 0 };
            acc.count++;
            acc.spanPt += spanPt;
            rakePins.set(cls.id, acc);
            notes.push(
              `🧭 ${cls.id}: the ${face} elevation's ${g.kind ?? "main"} gable sits over decorative beams/trellis — this wall is a gable end, gutter removed here; verify against the roof plan before quoting.`,
            );
            continue;
          }
          droppedProjections.push({
            face: side,
            kind: g.kind ?? "other",
            supportedOn: g.supported_on,
            spanFt: typeof g.span_ft === "number" ? g.span_ft : null,
            form: formOfCover(g),
          });
          // Real gable beyond the wall — record it so the layout draws it.
          frameOverEnds.push({
            edgeId: hit.e.id,
            spanFt: typeof g.span_ft === "number" ? g.span_ft : null,
            u,
            source: "beam",
          });
          notes.push(
            `🧭 ${face} elevation: the ${g.kind ?? "gable"} roof sits on ${g.supported_on} and projects beyond this wall — its own eaves/gutters are NOT in the wall outline. Estimated separately from the roof-area schedule where available (verify).`,
          );
          continue;
        }
        if (cls.edge_class === "rake") {
          confirmed.add(cls.id);
          const acc = rakePins.get(cls.id) ?? { count: 0, spanPt: 0 };
          acc.count++;
          if (spanPt != null) acc.spanPt += spanPt;
          rakePins.set(cls.id, acc);
          // Say WHY the tent stands — the depth fields are the reviewable
          // part (a frame-over misread as flush lands exactly here).
          notes.push(
            `🧭 ${cls.id} stays RAKE: the ${face} elevation's ${g.kind ?? "gable"} gable maps onto this wall ` +
              `(u≈${u.toFixed(2)}${g.span_ft != null ? `, span ${Math.round(g.span_ft)}ft` : ""}, ` +
              `set-back ${g.set_back_ft ?? "unread"}, eave-in-front ${g.eave_passes_in_front ?? "unread"}) — verify against the section sheets (a FRAME-OVER keeps its gutter).`,
          );
          emitStubShortfall(g, hit.e);
          continue;
        }
        if (spanPt != null && hit.e.lenPt > spanPt * 1.6) {
          // The gable covers only part of a longer wall. Whole-edge unknown
          // SHIPPED the gutter at $0 (the Woodinville front). The elevation
          // read the gable's position AND span, so carve that interval out
          // and keep the gutter on the remainder — the eave line by
          // definition runs up to the gable on a mixed wall.
          //
          // ONLY when the base classifier already believes this wall is an
          // EAVE. An `unknown` base means the geometry couldn't decide
          // eave-vs-rake; a single partial gable proves only that PART is a
          // rake, never that the rest is gutter — "unknown beats a guess",
          // so an unknown wall stays unknown (UNPRICED), not priced-eave.
          const wallFt = Math.round(hit.e.lenPt / (opts.ptPerFt || 1));
          // Same carve math as the field-conflict ladder (shared helper) —
          // a straddling clamp bails to review instead of pricing the
          // clamped-off part as gutter.
          const carve = carveGable(hit, u, spanPt);
          if (
            cls.edge_class === "eave" &&
            carve.clampedCleanly &&
            carve.interval &&
            carve.remainderFt >= 6 &&
            !fieldParallel.has(cls.id)
          ) {
            cls.partial_gables = [
              ...(cls.partial_gables ?? []),
              carve.interval,
            ];
            cls.evidence = [...(cls.evidence ?? []), "partial_gable_remainder"];
            notes.push(
              `🧭 ${cls.id}: the ${face} elevation shows a ${Math.round(g.span_ft!)}ft gable on this ${wallFt}ft wall — rake over the gable span only; gutter kept on the remaining ~${Math.round(carve.remainderFt)}ft. Verify.`,
            );
            confirmed.add(cls.id);
            continue;
          }
          // No clean carve (unknown base, straddling gable, perpendicular
          // return, sliver remainder, sheet gable-end framing) — surface it
          // instead of guessing. An eave base is knocked to unknown so a
          // partial gable never leaves the whole wall priced.
          if (cls.edge_class === "eave") {
            cls.edge_class = "unknown";
            unknowns++;
            notes.push(
              `🧭 ${cls.id} eave→unknown: the ${face} elevation shows a ` +
                `${Math.round(g.span_ft!)}ft gable on this ${wallFt}ft wall — partial gable, review.`,
            );
          }
          confirmed.add(cls.id);
          continue;
        }
        if (spanPt == null && cls.edge_class === "eave") {
          // No span to corroborate — don't silently delete a gutter.
          cls.edge_class = "unknown";
          unknowns++;
          confirmed.add(cls.id);
          notes.push(
            `🧭 ${cls.id} eave→unknown: the ${face} elevation shows a gable here but its span didn't read — review.`,
          );
          continue;
        }
        cls.edge_class = "rake";
        cls.evidence = [...(cls.evidence ?? []), "elevation_gable_mapped"];
        confirmed.add(cls.id);
        {
          const acc = rakePins.get(cls.id) ?? { count: 0, spanPt: 0 };
          acc.count++;
          if (spanPt != null) acc.spanPt += spanPt;
          rakePins.set(cls.id, acc);
        }
        promoted++;
        notes.push(
          `🧭 ${cls.id} ${side === "front" || side === "back" ? side : side + " side"} → RAKE: the ${face} elevation's ` +
            `${g.kind ?? "gable"} gable maps onto this wall (u≈${u.toFixed(2)}` +
            (g.span_ft != null ? `, span ${Math.round(g.span_ft)}ft` : "") +
            `).`,
        );
        if (spanPt != null && spanPt > hit.e.lenPt * 1.5) {
          notes.push(
            `🧭 ${cls.id}: the read gable span (${Math.round(g.span_ft!)}ft) is wider than this ${Math.round(hit.e.lenPt / (opts.ptPerFt || 1))}ft wall — span read suspect, verify.`,
          );
        }
        emitStubShortfall(g, hit.e);
      }

      // 1b) SHEET GABLES: the framing field found a gable-end array along
      // these walls — the sheet's own evidence. Promote when the face
      // corroborates (shows any flush gable) or can't be read; a face that
      // reads as continuous-eave-only vetoes (two-tier side walls draw the
      // upper roof's trusses while the gutter rides a lower fascia).
      for (const s of spans) {
        const cls = byId.get(s.e.id)!;
        if (!fieldParallel.has(cls.id)) continue;
        if (cls.edge_class === "rake") {
          confirmed.add(cls.id);
          continue;
        }
        if (flushGables.length === 0) {
          notes.push(
            `🧭 ${cls.id}: gable-end framing on the sheet, but the ${face} elevation shows no flush gable on this side — left as-is, verify.`,
          );
          continue;
        }
        cls.edge_class = "rake";
        cls.evidence = [...(cls.evidence ?? []), "truss_field_parallel"];
        confirmed.add(cls.id);
        promoted++;
        notes.push(
          `📐 ${cls.id} → RAKE: gable-end framing runs along this wall on the sheet and the ${face} elevation shows a gable on this side.`,
        );
      }

      // 2) DEMOTE: rake calls with neither a printed label nor a mapped gable.
      // Rakes kept ONLY on their printed label, with no elevation gable
      // mapped to them — they stay rake (the sheet's own words win) but must
      // not count as "placed" in the budget check below: a silent label keep
      // masked per-face placement deficits (the Woodinville front reported
      // 3 gables read / 3 placed when only 2 had actually mapped).
      const labelKeptUnmapped = new Set<string>();
      for (const s of spans) {
        const cls = byId.get(s.e.id)!;
        if (cls.edge_class !== "rake" || confirmed.has(cls.id)) continue;
        const evidence = cls.evidence ?? [];
        if (evidence.some((t) => STRONG_RAKE_EVIDENCE.has(t))) {
          labelKeptUnmapped.add(cls.id);
          notes.push(
            flushGables.length === 0
              ? `🧭 ${cls.id} kept RAKE on its printed label, but the ${face} elevation shows no gable on this side — verify.`
              : `🧭 ${cls.id} kept RAKE on its printed label — no elevation gable maps to this wall — verify.`,
          );
          continue;
        }
        if (reading.continuous_eave === true) {
          cls.edge_class = "eave";
          cls.evidence = [...evidence, "elevation_continuous_eave"];
          demoted++;
          notes.push(
            `🧭 ${cls.id} rake→EAVE: the ${face} elevation shows a continuous eave/gutter line and no gable maps to this wall.`,
          );
          continue;
        }
        // Stepped face (continuous read is honestly false): when the face's
        // gable pinned to EXACTLY this wall rises BEHIND a running eave line
        // (eave_passes_in_front), the wall under it still carries that
        // gutter — the gable is a frame-over, not a wall plane.
        const fo = frameOverGables.find((f) => f.pin?.e.id === s.e.id);
        if (fo) {
          cls.edge_class = "eave";
          cls.evidence = [...evidence, "eave_passes_in_front_of_gable"];
          demoted++;
          notes.push(
            `🧭 ${cls.id} rake→EAVE: the ${face} elevation shows its gable rising BEHIND a running eave/gutter line at this position (frame-over) — the wall keeps its gutter.`,
          );
        } else {
          cls.edge_class = "unknown";
          unknowns++;
          notes.push(
            `🧭 ${cls.id} rake→unknown: no printed gable label and the ${face} elevation shows no gable here — UNPRICED, review.`,
          );
        }
      }

      // 2b) SETTLE LABEL-vs-FIELD CONFLICTS: the truss-field pass parks a
      // printed-label edge whose framing reads PERPENDICULAR as unknown
      // (truss_field_conflict). When THIS face independently reads one
      // continuous eave/gutter line across the side and no elevation gable
      // claimed the edge, that's TWO sheet reads (framing bears + unbroken
      // fascia) against ONE stray label — the wall gets its gutter back.
      // An edge a gable tried to claim (gableBlockedByField) stays a tie:
      // UNPRICED, human review. So does the whole side while a reported
      // gable floats UNPINNED (null position / bad map) — that floater could
      // be the label's gable, and a wrong eave BILLS gutter across a rake.
      // An ABOVE-EAVE floater (dropped by the continuous-eave filter) does
      // NOT veto: the face's one gutter line runs under it by definition —
      // it is recorded to frameOverEnds instead so the drawing gains the
      // side gable above the recovered eave.
      for (const s of spans) {
        const cls = byId.get(s.e.id)!;
        if (cls.edge_class !== "unknown") continue;
        if (!(cls.evidence ?? []).includes("truss_field_conflict")) continue;
        // Eave evidence from the face: one continuous line across the side,
        // OR (stepped faces) a frame-over gable pinned to EXACTLY this wall —
        // the elevation saw the eave running in front of it.
        const foHere = frameOverGables.some((f) => f.pin?.e.id === s.e.id);
        if (reading.continuous_eave !== true && !foHere) continue;
        if (confirmed.has(cls.id) || gableBlockedByField.has(cls.id)) continue;
        if (floatingUnpinned > 0) {
          notes.push(
            `🧭 ${cls.id} stays UNPRICED: the framing and the ${face} elevation's continuous eave line both dispute its printed gable label, but ${floatingUnpinned} reported gable(s) on this side couldn't be pinned to a wall — one of them may be this label's gable. Review.`,
          );
          continue;
        }
        cls.edge_class = "eave";
        cls.evidence = [...(cls.evidence ?? []), "elevation_continuous_eave"];
        demoted++;
        // The side's above-the-eave gable(s) belong over this recovered
        // wall — record them so the layout draws the side gable (the old
        // veto shipped the wall unpriced AND drew nothing).
        for (const fg of floatingAboveEave.splice(0, floatingAboveEave.length)) {
          frameOverEnds.push({
            edgeId: cls.id,
            spanFt: typeof fg.span_ft === "number" ? fg.span_ft : null,
            u: Math.max(0, Math.min(1, fg.position_frac ?? 0.5)),
            source: "truss-conflict",
          });
        }
        notes.push(
          `🧭 ${cls.id} unknown→EAVE: the framing bears on this wall AND the ${face} elevation ` +
            (reading.continuous_eave === true
              ? "reads one continuous eave/gutter line across this side"
              : "shows the eave running in front of this wall's frame-over gable") +
            ` — two sheet reads outvote the stray gable label; gutter restored, verify.`,
        );
      }

      // 2c) MULTI-GABLE WALL: two flush gables pinned onto ONE rake wall
      // means each lacks its own wall segment (usually a jog the footprint
      // dropped). The stretch between/beside them may carry gutter but the
      // whole edge is rake — say what's unpriced instead of staying silent.
      for (const [id, acc] of rakePins) {
        if (acc.count < 2 || acc.spanPt <= 0) continue;
        const cls = byId.get(id)!;
        if (cls.edge_class !== "rake") continue;
        if ((cls.evidence ?? []).some((t) => STRONG_RAKE_EVIDENCE.has(t))) continue;
        if (fieldParallel.has(id)) continue;
        const e = spans.find((s) => s.e.id === id)?.e;
        if (!e) continue;
        const remFt = (e.lenPt - acc.spanPt) / (opts.ptPerFt || 1);
        if (remFt >= 8) {
          notes.push(
            `⚠ ${id}: ${acc.count} gables from the ${face} elevation share this ${Math.round(e.lenPt / (opts.ptPerFt || 1))}ft wall — each should own its own wall segment (likely a footprint jog this outline is missing). The ~${Math.round(remFt)}ft between/beside them may carry gutter but ships UNPRICED — review.`,
          );
        }
      }

      // 3) BUDGET CHECK: every flush gable the elevation shows should own a
      // gable wall on this side — a deficit means a gable the mapping missed.
      // A partial-gable wall (rake over the span, gutter on the rest) counts
      // as placed; a rake kept only on its printed label does NOT (no
      // elevation gable mapped to it — honest accounting).
      // A ladder-resolved wall (frame-over eave / rake-over-span split) DID
      // place its gable — counting it avoids the false "0 gable walls
      // placed" alarm the old conflict park raised on every resolved side.
      const rakeWalls = spans.filter((s) => {
        const c = byId.get(s.e.id)!;
        return (
          (c.edge_class === "rake" && !labelKeptUnmapped.has(s.e.id)) ||
          (c.partial_gables?.length ?? 0) > 0 ||
          ladderPlaced.has(s.e.id)
        );
      }).length;
      if (flushGables.length > rakeWalls) {
        notes.push(
          `⚠ ${face} elevation shows ${flushGables.length} gable(s) at the eave line but only ${rakeWalls} gable wall(s)/frame-over(s) placed on this side — review gable placement.`,
        );
      }
      for (const id of confirmed) claimedByGable.add(id);
    }

    // 4) GABLE-SIDE EAVES: a gable-end roof sheds onto the walls flanking
    // it — its side eaves. An UNKNOWN edge with no rake evidence of its own,
    // sitting ring-adjacent and PERPENDICULAR to a final rake wall, is that
    // gable roof's side eave and carries the gutter (the short jog returns
    // beside the Woodinville garage/entry gables shipped UNPRICED without
    // this). Deliberately-parked conflicts and gable-claimed edges stay put.
    const isPerp = (a?: string | null, b?: string | null) =>
      (a === "h" && b === "v") || (a === "v" && b === "h");
    const ringE = edges.filter((e) => e.lenPt > 1e-6);
    for (let i = 0; i < ringE.length; i++) {
      const e = ringE[i];
      const cls = byId.get(e.id);
      if (!cls || cls.edge_class !== "unknown") continue;
      const evidence = cls.evidence ?? [];
      if (evidence.some((t) => STRONG_RAKE_EVIDENCE.has(t))) continue;
      if (evidence.includes("truss_field_conflict")) continue;
      if (claimedByGable.has(cls.id)) continue;
      // The framing field drew a gable-end array ALONG this wall — the tag
      // only lands in evidence when a readable face corroborated (1b), so
      // check the raw verdict set too: sheet-marked gable ends must never
      // be priced by adjacency.
      if (fieldParallel.has(cls.id)) continue;
      const prev = ringE[(i - 1 + ringE.length) % ringE.length];
      const next = ringE[(i + 1) % ringE.length];
      const rakeNb = [prev, next].find(
        (nb) =>
          isPerp(nb.axis, e.axis) && byId.get(nb.id)?.edge_class === "rake",
      );
      if (!rakeNb) continue;
      cls.edge_class = "eave";
      cls.evidence = [...evidence, "gable_side_eave"];
      demoted++;
      notes.push(
        `🧭 ${cls.id} unknown→EAVE: it flanks the gable end ${rakeNb.id} — the gable roof sheds onto this wall, so it carries the gutter (its side eave). Verify.`,
      );
    }

    // 4b) FRONT-GABLED ENTRY/PORCH STUB: a small protruding entry cover
    // whose peak faces FRONT hangs its gutters on its two SIDE returns —
    // the outer (front) edge is a rake with no gutter and no D.S. The
    // Woodinville entry stub shipped exactly inverted (front priced eave
    // with a D.S. on it, sides raked). Deterministic gates: the stub trio
    // geometry (unifyStubTiers-style DEPTH test — isProtrusion fails on
    // 9.1-ft returns), entry/porch evidence (a trio feature tag or the
    // facing elevation's front_gabled entry/porch gable pinned inside the
    // stub), and hard vetoes on any contradicting sheet evidence.
    if (opts.ptPerFt && opts.ptPerFt > 0 && outline.length >= 3) {
      const ppf = opts.ptPerFt;
      const cxAll = outline.reduce((s, p) => s + p.x, 0) / outline.length;
      const cyAll = outline.reduce((s, p) => s + p.y, 0) / outline.length;
      const xsAll = outline.map((p) => p.x);
      const ysAll = outline.map((p) => p.y);
      const spanX = Math.max(...xsAll) - Math.min(...xsAll);
      const spanY = Math.max(...ysAll) - Math.min(...ysAll);
      for (let i = 0; i < ringE.length; i++) {
        const outer = ringE[i];
        const oCls = byId.get(outer.id);
        if (!oCls || ringE.length < 4) continue;
        // Trade-plausible entry-cover size only.
        if (outer.lenPt > 16 * ppf) continue;
        const prev = ringE[(i - 1 + ringE.length) % ringE.length];
        const next = ringE[(i + 1) % ringE.length];
        if (prev.lenPt > 12 * ppf || next.lenPt > 12 * ppf) continue;
        const axisSpan =
          outer.axis === "h"
            ? spanX
            : outer.axis === "v"
              ? spanY
              : Math.max(spanX, spanY);
        if (outer.lenPt > axisSpan * 0.5) continue;
        // DEPTH test (unifyStubTiers): both ring neighbors' far endpoints
        // step clearly inward of the outer edge's line.
        const dx = outer.p2.x - outer.p1.x;
        const dy = outer.p2.y - outer.p1.y;
        const len = Math.hypot(dx, dy) || 1;
        let nx = -dy / len;
        let ny = dx / len;
        if ((cxAll - outer.mid.x) * nx + (cyAll - outer.mid.y) * ny < 0) {
          nx = -nx;
          ny = -ny;
        }
        const depthOf = (p: OverlayPt) =>
          (p.x - outer.mid.x) * nx + (p.y - outer.mid.y) * ny;
        const minStep = Math.max(8, len * 0.15);
        if (depthOf(prev.p1) <= minStep || depthOf(next.p2) <= minStep)
          continue;
        // VETO: the framing bears INTO the outer edge — sheet evidence wins.
        if (fieldEave.has(outer.id)) continue;
        const trio = [byId.get(prev.id), oCls, byId.get(next.id)].filter(
          (c): c is EdgeClass => !!c,
        );
        // VETO: a garage stub is not an entry cover (its front is a door
        // wall under a gable OR a guttered eave — never this rule's call).
        if (
          trio.some((c) => (c.feature ?? "").toLowerCase() === "garage")
        )
          continue;
        const side = sideOfPerimeterEdge(outer.p1, outer.p2, outline);
        if (!side) continue;
        const { faceLabel: faceOf, reading: facing } = readingForSide(side);
        // VETO: a hipped face has no front-gabled covers.
        if (facing?.roof_form === "hipped") continue;
        // Evidence 1: the classifier tagged the stub porch/entry.
        const featEvidence = trio.some((c) => {
          const f = (c.feature ?? "").toLowerCase();
          return f === "porch" || f === "entry";
        });
        // Evidence 2: the facing elevation's entry/porch gable pins inside
        // the stub's window on that side (any supported_on).
        let pinnedCover: FaceReadingRaw["gables"][number] | null = null;
        if (facing && facing.readable !== false) {
          const sideEdges4b = edges.filter(
            (e) =>
              e.lenPt > 1e-6 &&
              sideOfPerimeterEdge(e.p1, e.p2, outline) === side,
          );
          const n4 = SIDE_NORMAL[side];
          const rd4 = { x: n4.y, y: -n4.x };
          const proj4 = (p: OverlayPt) => p.x * rd4.x + p.y * rd4.y;
          let lo4 = Infinity;
          let hi4 = -Infinity;
          for (const e of sideEdges4b) {
            lo4 = Math.min(lo4, proj4(e.p1), proj4(e.p2));
            hi4 = Math.max(hi4, proj4(e.p1), proj4(e.p2));
          }
          const ext4 = hi4 - lo4;
          if (Number.isFinite(ext4) && ext4 > 0) {
            const su0 =
              (Math.min(proj4(outer.p1), proj4(outer.p2)) - lo4) / ext4;
            const su1 =
              (Math.max(proj4(outer.p1), proj4(outer.p2)) - lo4) / ext4;
            for (const g of facing.gables ?? []) {
              const k = (g.kind ?? "").toLowerCase();
              if (k !== "entry" && k !== "porch") continue;
              if (g.position_frac == null) continue;
              const gu = Math.max(0, Math.min(1, g.position_frac));
              if (gu < su0 - 0.05 || gu > su1 + 0.05) continue;
              pinnedCover = g;
              break;
            }
          }
        }
        // VETO: the pinned shape is a hip end — not a gabled cover.
        if (pinnedCover?.is_hip_end === true) continue;
        const coverForm = (pinnedCover as { cover_form?: unknown } | null)
          ?.cover_form;
        // VETO (note-only): the cover reads hipped/shed — its front edge
        // carries its own gutter pattern, never this rule's rake.
        if (coverForm === "hipped" || coverForm === "shed") {
          notes.push(
            `🧭 ${outer.id}: the ${faceOf ?? side} elevation reads the ${pinnedCover?.kind ?? "porch"} cover as ${coverForm} — its edges keep their readings (a ${coverForm} cover is not the front-gable pattern). Verify.`,
          );
          continue;
        }
        const gableEvidence =
          pinnedCover != null && coverForm === "front_gabled";
        if (!featEvidence && !gableEvidence) continue;
        // ACTION — flip the stub to the front-gabled pattern.
        let removedLf = 0;
        let addedLf = 0;
        let changedAny = false;
        const sideIds: string[] = [];
        if (oCls.edge_class === "eave" || oCls.edge_class === "unknown") {
          if (oCls.edge_class === "eave") removedLf += outer.lenPt / ppf;
          oCls.edge_class = "rake";
          oCls.evidence = [...(oCls.evidence ?? []), "front_gabled_cover"];
          promoted++;
          changedAny = true;
        }
        for (const [nb, c] of [
          [prev, byId.get(prev.id)],
          [next, byId.get(next.id)],
        ] as const) {
          if (!c) continue;
          if (c.edge_class === "rake" || c.edge_class === "unknown") {
            // VETO (per edge): the sheet's own gable-end evidence on a side
            // return outranks the cover pattern — it keeps its rake.
            if (
              (c.evidence ?? []).some((t) => STRONG_RAKE_EVIDENCE.has(t)) ||
              fieldParallel.has(c.id)
            ) {
              notes.push(
                `🧭 ${c.id}: the ${outer.id} entry/porch cover's side return keeps its RAKE — the sheet's own gable-end evidence outranks the cover pattern. Verify.`,
              );
              continue;
            }
            if (c.edge_class === "rake") demoted++;
            c.edge_class = "eave";
            c.evidence = [...(c.evidence ?? []), "cover_side_eave"];
            addedLf += nb.lenPt / ppf;
            sideIds.push(c.id);
            changedAny = true;
          } else if (c.edge_class === "eave") {
            sideIds.push(c.id);
          }
        }
        if (!changedAny) continue;
        // The stub's own returns now price the cover's gutters — a
        // same-face porch/entry droppedProjection would double-count them
        // through the projection-LF synthesis. This rule supersedes it.
        for (let k = droppedProjections.length - 1; k >= 0; k--) {
          const dp = droppedProjections[k];
          const dk = (dp.kind ?? "").toLowerCase();
          if (dp.face === side && (dk === "porch" || dk === "entry")) {
            droppedProjections.splice(k, 1);
          }
        }
        const net = Math.round((addedLf - removedLf) * 10) / 10;
        notes.push(
          `🧭 ${outer.id}: front-gabled entry cover — the peak faces front, so its front edge is a RAKE (gutter and D.S. removed there); the cover's gutters hang on its side returns ${sideIds.join("+") || "(none priced)"}. Net ${net >= 0 ? "+" : ""}${net} LF. Verify against the roof plan.`,
        );
      }
    }

    // 5) JOG ↔ FOOTPRINT CROSS-CHECK: the elevations prove an offset
    // garage/porch jog on a side, but the footprint's wall line there
    // shows fewer steps than jogs — the outline (often borrowed from a
    // foundation/wall loop) flattened a projection. Every length on that
    // side is then suspect; a straight-through wall can also make two
    // gables share one edge. Note-only — geometry is never invented.
    if (opts.ptPerFt && opts.ptPerFt > 0) {
      const stepTol = 1.5 * opts.ptPerFt;
      const minWall = 4 * opts.ptPerFt;
      const jogsByFace = new Map<string, string[]>();
      for (const j of detectAsymmetricJogs(perFace)) {
        const arr = jogsByFace.get(j.face) ?? [];
        if (!arr.includes(j.kind)) arr.push(j.kind);
        jogsByFace.set(j.face, arr);
      }
      for (const [faceName, kinds] of jogsByFace) {
        const nrm = normals[faceName as FaceName];
        if (!nrm) continue;
        const side = sideOfNormal(nrm);
        const wantAxis: "h" | "v" =
          side === "front" || side === "back" ? "h" : "v";
        const offsets = edges
          .filter(
            (e) =>
              e.axis === wantAxis &&
              e.lenPt >= minWall &&
              sideOfPerimeterEdge(e.p1, e.p2, outline) === side,
          )
          .map((e) => (wantAxis === "h" ? e.mid.y : e.mid.x))
          .sort((a, b) => a - b);
        if (offsets.length === 0) continue;
        let clusters = 1;
        for (let i = 1; i < offsets.length; i++) {
          if (offsets[i] - offsets[i - 1] > stepTol) clusters++;
        }
        const steps = clusters - 1;
        if (steps < kinds.length) {
          notes.push(
            `⚠ footprint↔elevation: the elevations prove ${kinds.length} offset jog(s) on the ${faceName} side (${kinds.join(" + ")}), but its wall line shows ${steps === 0 ? "no step" : `only ${steps} step(s)`} — the outline may be missing a projection (wall/foundation loop vs the roof). Lengths and gutter on this side need review.`,
          );
        }
      }
    }

    if (promoted + demoted + unknowns + hipVetoed > 0) {
      notes.push(
        `🧭 Edge↔elevation reconcile: ${promoted} promoted to rake, ${demoted} demoted to eave, ${unknowns} set unknown` +
          (hipVetoed > 0
            ? `, ${hipVetoed} kept as eave (read as hip ends, not gables)`
            : "") +
          " (elevations are the gable budget).",
      );
    }
    if (hipVetoed > 0) {
      notes.push(
        `⚠ ${hipVetoed} wall(s) the elevations read as HIP ends kept their gutter over a gable read — a hip-driven change to the priced eaves. Eyeball the front/garage/entry against the roof before quoting.`,
      );
    }
    return {
      classes,
      notes,
      promoted,
      demoted,
      unknowns,
      droppedProjections,
      frameOverEnds,
    };
  } catch (e) {
    return noop(
      `🧭 Edge↔elevation reconcile skipped (${e instanceof Error ? e.message : "error"}).`,
    );
  }
}
