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
import type { FaceReadingRaw } from "./face-merge";
import {
  DEFAULT_FACE_NORMALS,
  deriveOrientationFromFaceTitles,
  sideOfPerimeterEdge,
  type FaceName,
  type FaceNormals,
} from "./plan-orientation";

export type ReconcileResult = {
  classes: EdgeClass[];
  notes: string[];
  promoted: number;
  demoted: number;
  unknowns: number;
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
  });
  try {
    const { outline, edges, perFace } = opts;
    if (!perFace || outline.length < 3) return noop();
    const faces = ["north", "south", "east", "west"] as const;
    if (!faces.some((f) => perFace[f]?.readable)) return noop();

    const normals: FaceNormals =
      deriveOrientationFromFaceTitles(perFace)?.normals ?? DEFAULT_FACE_NORMALS;
    // compass face → canvas side its outward normal points to
    const faceForSide = new Map<Side, FaceName>();
    for (const f of faces) faceForSide.set(sideOfNormal(normals[f]), f);

    const classes = opts.classes.map((c) => ({ ...c }));
    const byId = new Map(classes.map((c) => [c.id, c]));
    const fieldParallel = opts.fieldParallel ?? new Set<string>();
    const fieldEave = opts.fieldEave ?? new Set<string>();
    const notes: string[] = [];
    let promoted = 0;
    let demoted = 0;
    let unknowns = 0;

    for (const side of ["front", "back", "left", "right"] as Side[]) {
      const face = faceForSide.get(side);
      const reading = face ? perFace[face] : undefined;
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
      const n = normals[face!];
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

      // Flush/at-the-eave gables only — a set-back gable rises BEHIND a
      // guttered eave and must not consume a perimeter edge. When the face
      // reads a CONTINUOUS eave line, a flush wall-plane gable is physically
      // impossible unless the read explicitly places it at the eave — treat
      // set-back-unknown gables on such faces as frame-overs/dormers.
      const gablesAll = reading.gables ?? [];
      const flushGables = gablesAll.filter((g) => {
        const sb = typeof g.set_back_ft === "number" ? g.set_back_ft : null;
        if (sb != null) return sb <= 2;
        return reading.continuous_eave !== true;
      });
      if (gablesAll.length > flushGables.length) {
        const skipped = gablesAll.length - flushGables.length;
        notes.push(
          `🧭 ${face} elevation: ${skipped} gable(s) sit above the continuous eave line (frame-over/dormer) — the gutter below them stays.`,
        );
      }

      // 1) PROMOTE: map each elevation gable onto its wall segment.
      const confirmed = new Set<string>();
      for (const g of flushGables) {
        if (g.position_frac == null) continue;
        const u = Math.max(0, Math.min(1, g.position_frac));
        const hit =
          spans.find((s) => u >= s.u0 - 0.05 && u <= s.u1 + 0.05) ??
          spans.reduce(
            (best, s) => {
              const c = (s.u0 + s.u1) / 2;
              const d = Math.abs(c - u);
              return d < best.d ? { d, s } : best;
            },
            { d: Infinity, s: null as (typeof spans)[number] | null },
          ).s;
        if (!hit || Math.abs((hit.u0 + hit.u1) / 2 - u) > 0.25) continue;
        const cls = byId.get(hit.e.id)!;
        // The framing field says this wall BEARS trusses — the gable the
        // elevation sees here is a frame-over above the eave, not the wall.
        if (fieldEave.has(cls.id)) {
          notes.push(
            `🧭 ${cls.id}: the ${face} elevation shows a gable here, but the framing bears on this wall — frame-over above the eave; the gutter stays.`,
          );
          continue;
        }
        // HARD GATE: the face reads ONE uninterrupted gutter line across its
        // full width — then no wall-plane gable exists on it, whatever the
        // gable's set-back number says (the eave line is the thing we price;
        // trust it over a depth guess). A gable may still consume a wall here
        // with SHEET-side corroboration: a protruding porch/patio stub,
        // gable-end framing, or a printed label.
        const spanPtGate =
          g.span_ft != null && opts.ptPerFt ? g.span_ft * opts.ptPerFt : null;
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
          notes.push(
            `🧭 ${face} elevation: the ${g.kind ?? "gable"} roof sits on ${g.supported_on} and projects beyond this wall — its own eaves/gutters are NOT in the wall outline. Review that structure separately.`,
          );
          continue;
        }
        const spanPt =
          g.span_ft != null && opts.ptPerFt ? g.span_ft * opts.ptPerFt : null;
        if (cls.edge_class === "rake") {
          confirmed.add(cls.id);
          continue;
        }
        if (spanPt != null && hit.e.lenPt > spanPt * 1.6) {
          // The gable covers only part of a longer wall — converting the whole
          // edge would drop real gutter. Surface it instead of guessing.
          if (cls.edge_class === "eave") {
            cls.edge_class = "unknown";
            unknowns++;
            notes.push(
              `🧭 ${cls.id} eave→unknown: the ${face} elevation shows a ` +
                `${Math.round(g.span_ft!)}ft gable on this ${Math.round(hit.e.lenPt / (opts.ptPerFt || 1))}ft wall — partial gable, review.`,
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
        } else {
          cls.edge_class = "unknown";
          unknowns++;
          notes.push(
            `🧭 ${cls.id} rake→unknown: no printed gable label and the ${face} elevation shows no gable here — UNPRICED, review.`,
          );
        }
      }

      // 3) BUDGET CHECK: every flush gable the elevation shows should own a
      // gable wall on this side — a deficit means a gable the mapping missed.
      const rakeWalls = spans.filter(
        (s) => byId.get(s.e.id)!.edge_class === "rake",
      ).length;
      if (flushGables.length > rakeWalls) {
        notes.push(
          `⚠ ${face} elevation shows ${flushGables.length} gable(s) at the eave line but only ${rakeWalls} gable wall(s) placed on this side — review gable placement.`,
        );
      }
    }

    if (promoted + demoted + unknowns > 0) {
      notes.push(
        `🧭 Edge↔elevation reconcile: ${promoted} promoted to rake, ${demoted} demoted to eave, ${unknowns} set unknown (elevations are the gable budget).`,
      );
    }
    return { classes, notes, promoted, demoted, unknowns };
  } catch (e) {
    return noop(
      `🧭 Edge↔elevation reconcile skipped (${e instanceof Error ? e.message : "error"}).`,
    );
  }
}
