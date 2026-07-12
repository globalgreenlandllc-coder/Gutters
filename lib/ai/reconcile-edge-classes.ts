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
  supportedOn: "posts" | "beam";
  /** Gable span (the projecting mass's WIDTH along the wall), if the
   *  elevation read it — the divisor in depth = area ÷ span. */
  spanFt: number | null;
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
}): ReconcileResult {
  const noop = (why?: string): ReconcileResult => ({
    classes: opts.classes.map((c) => ({ ...c })),
    notes: why ? [why] : [],
    promoted: 0,
    demoted: 0,
    unknowns: 0,
    droppedProjections: [],
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

      // Flush/at-the-eave gables only — a set-back gable rises BEHIND a
      // guttered eave and must not consume a perimeter edge. When the face
      // reads a CONTINUOUS eave line, a flush wall-plane gable is physically
      // impossible unless the read explicitly places it at the eave — treat
      // set-back-unknown gables on such faces as frame-overs/dormers.
      const gablesAll = reading.gables ?? [];
      // FLOATING gables — reported on this side but never pinned to a wall:
      // a null set-back dropped by the continuous-eave filter (a guess, not a
      // read), a null position, or a position that maps to no edge. Any one
      // of them could be the gable a conflicted label really belongs to, so
      // their presence vetoes the pass-2b recovery (the tie stands).
      let floatingGables = 0;
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
          // gable end: treat it as flush and let the mapping decide.
          if (pin && spanPt != null && spanPt >= pin.e.lenPt * 0.8) return true;
          if (pin) frameOverGables.push({ g, pin });
          else floatingGables++; // unpinnable frame-over — ambiguous, vetoes 2b
          return false;
        }
        const sb = typeof g.set_back_ft === "number" ? g.set_back_ft : null;
        if (sb != null) return sb <= 2;
        if (reading.continuous_eave === true) floatingGables++;
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
      // Edges a flush gable tried to claim but the framing field blocked —
      // a label-conflict on such an edge stays a genuine tie (see 2b).
      const gableBlockedByField = new Set<string>();
      for (const g of flushGables) {
        if (g.position_frac == null) {
          floatingGables++;
          continue;
        }
        const u = Math.max(0, Math.min(1, g.position_frac));
        const hit = pinEdge(g.position_frac);
        if (!hit) {
          floatingGables++;
          continue;
        }
        const cls = byId.get(hit.e.id)!;
        // The framing field says this wall BEARS trusses — the gable the
        // elevation sees here is a frame-over above the eave, not the wall.
        if (fieldEave.has(cls.id)) {
          gableBlockedByField.add(cls.id);
          notes.push(
            `🧭 ${cls.id}: the ${face} elevation shows a gable here, but the framing bears on this wall — frame-over above the eave; ` +
              (byId.get(cls.id)!.edge_class === "eave"
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
        const spanPtGate =
          g.span_ft != null && opts.ptPerFt ? g.span_ft * opts.ptPerFt : null;
        // OVERFRAME GATE: a gable that reads clearly WIDER than the wall it
        // pins to cannot be that wall's plane — its roof spans PAST the wall
        // (an overframe; the section sheets print these as "FRAME-OVER PER
        // PLAN"). Protruding stubs are exempt: their inset walls read
        // narrower than the roof they carry. Sheet evidence (printed label /
        // gable-end framing) overrides. The wall ships UNPRICED for review —
        // never silently tented.
        if (
          spanPtGate != null &&
          spanPtGate > hit.e.lenPt * 1.08 &&
          !(cls.evidence ?? []).some((t) => STRONG_RAKE_EVIDENCE.has(t)) &&
          !fieldParallel.has(cls.id) &&
          !isProtrusion(hit.e, edges, outline, opts.ptPerFt)
        ) {
          if (cls.edge_class === "rake") {
            cls.edge_class = "unknown";
            unknowns++;
          }
          notes.push(
            `🧭 ${cls.id}: the ${face} elevation's ${g.kind ?? "gable"} gable reads ${Math.round(g.span_ft!)}ft — WIDER than this ${Math.round(hit.e.lenPt / (opts.ptPerFt || 1))}ft wall, so its roof spans past the wall (overframe/frame-over). Not tented — UNPRICED, review the building sections.`,
          );
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
          !(spanPtGate != null && spanPtGate >= hit.e.lenPt * 0.8)
        ) {
          notes.push(
            `🧭 ${cls.id}: the ${face} elevation reads one continuous eave/gutter line across this side — its gable sits above the gutter (frame-over); the wall keeps its gutter.`,
          );
          continue;
        }
        // Open porch/patio roofs (on posts/beams) live on protruding stubs.
        // Mapped onto a base-line house wall, the gable belongs to a
        // projecting roof our wall outline cannot see — never unprice the
        // wall for it.
        if (
          (g.supported_on === "posts" || g.supported_on === "beam") &&
          !isProtrusion(hit.e, edges, outline, opts.ptPerFt)
        ) {
          droppedProjections.push({
            face: side,
            kind: g.kind ?? "other",
            supportedOn: g.supported_on,
            spanFt: typeof g.span_ft === "number" ? g.span_ft : null,
          });
          notes.push(
            `🧭 ${face} elevation: the ${g.kind ?? "gable"} roof sits on ${g.supported_on} and projects beyond this wall — its own eaves/gutters are NOT in the wall outline. Estimated separately from the roof-area schedule where available (verify).`,
          );
          continue;
        }
        const spanPt =
          g.span_ft != null && opts.ptPerFt ? g.span_ft * opts.ptPerFt : null;
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
          const a1 = uOf(hit.e.p1);
          const a2 = uOf(hit.e.p2);
          const spanU = spanPt / extent;
          const g0 = Math.max(hit.u0, u - spanU / 2);
          const g1 = Math.min(hit.u1, u + spanU / 2);
          // If clamping to the wall ate a real slice of the read span, the
          // gable straddles the corner — position/span is suspect and the
          // clamped-off part would price as gutter. Bail to review instead.
          const clampedCleanly = g1 - g0 >= spanU * 0.75;
          const remainderFt =
            (hit.e.lenPt - Math.max(0, g1 - g0) * extent) / (opts.ptPerFt || 1);
          if (
            cls.edge_class === "eave" &&
            clampedCleanly &&
            Math.abs(a2 - a1) > 1e-9 &&
            g1 > g0 &&
            remainderFt >= 6 &&
            !fieldParallel.has(cls.id)
          ) {
            const t0 = (g0 - a1) / (a2 - a1);
            const t1 = (g1 - a1) / (a2 - a1);
            cls.partial_gables = [
              ...(cls.partial_gables ?? []),
              { u0: Math.min(t0, t1), u1: Math.max(t0, t1) },
            ];
            cls.evidence = [...(cls.evidence ?? []), "partial_gable_remainder"];
            notes.push(
              `🧭 ${cls.id}: the ${face} elevation shows a ${Math.round(g.span_ft!)}ft gable on this ${wallFt}ft wall — rake over the gable span only; gutter kept on the remaining ~${Math.round(remainderFt)}ft. Verify.`,
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
      for (const s of spans) {
        const cls = byId.get(s.e.id)!;
        if (cls.edge_class !== "rake" || confirmed.has(cls.id)) continue;
        const evidence = cls.evidence ?? [];
        if (evidence.some((t) => STRONG_RAKE_EVIDENCE.has(t))) {
          if (flushGables.length === 0) {
            notes.push(
              `🧭 ${cls.id} kept RAKE on its printed label, but the ${face} elevation shows no gable on this side — verify.`,
            );
          }
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
      // UNPRICED, human review. So does the whole side while ANY reported
      // gable floats unpinned (null position / null set-back / bad map) —
      // the floater could be the label's gable, and a wrong eave BILLS
      // gutter across a rake.
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
        if (floatingGables > 0) {
          notes.push(
            `🧭 ${cls.id} stays UNPRICED: the framing and the ${face} elevation's continuous eave line both dispute its printed gable label, but ${floatingGables} reported gable(s) on this side couldn't be pinned to a wall — one of them may be this label's gable. Review.`,
          );
          continue;
        }
        cls.edge_class = "eave";
        cls.evidence = [...(cls.evidence ?? []), "elevation_continuous_eave"];
        demoted++;
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
      // as placed.
      const rakeWalls = spans.filter((s) => {
        const c = byId.get(s.e.id)!;
        return c.edge_class === "rake" || (c.partial_gables?.length ?? 0) > 0;
      }).length;
      if (flushGables.length > rakeWalls) {
        notes.push(
          `⚠ ${face} elevation shows ${flushGables.length} gable(s) at the eave line but only ${rakeWalls} gable wall(s) placed on this side — review gable placement.`,
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
    return { classes, notes, promoted, demoted, unknowns, droppedProjections };
  } catch (e) {
    return noop(
      `🧭 Edge↔elevation reconcile skipped (${e instanceof Error ? e.message : "error"}).`,
    );
  }
}
