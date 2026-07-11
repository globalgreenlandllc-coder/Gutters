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

/** Evidence tags that outrank an elevation summary — the sheet's own words. */
const STRONG_RAKE_EVIDENCE = new Set([
  "gable_end_truss_label",
  "barge_or_rake_callout",
]);

const sideOfNormal = (n: { x: number; y: number }): Side =>
  Math.abs(n.y) >= Math.abs(n.x)
    ? n.y >= 0
      ? "front"
      : "back"
    : n.x >= 0
      ? "right"
      : "left";

export function reconcileEdgeClasses(opts: {
  outline: readonly OverlayPt[];
  edges: readonly OutlineEdge[];
  classes: readonly EdgeClass[];
  perFace: Partial<Record<string, FaceReadingRaw>> | null | undefined;
  ptPerFt?: number | null;
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
      // guttered eave and must not consume a perimeter edge.
      const flushGables = (reading.gables ?? []).filter(
        (g) => !(typeof g.set_back_ft === "number" && g.set_back_ft > 2),
      );

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
