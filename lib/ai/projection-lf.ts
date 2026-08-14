/**
 * Estimated gutter LF for projecting masses (open porch / patio / garage on
 * posts or a beam) whose gable maps onto a house wall but whose OWN eaves sit
 * beyond the traced footprint — so they never enter the edge ring and price at
 * $0 (the Woodinville garage-jog hole). The elevation reconcile detects these
 * (reconcile-edge-classes.ts → droppedProjections); this turns them into an
 * ESTIMATED line instead of a dropped one.
 *
 * Pure module (no server-only, no React, no DB) so it runs under node --test.
 */
import type { DroppedProjection } from "./reconcile-edge-classes";
import type { RoofMassArea } from "./to-masses";

/** The reconcile can attach the cover's OWN roof form (from the elevation
 *  read's cover_form) and, on a SHORTFALL drop, how deep the traced wall
 *  bump's return edges already run. Local widening so older stashes (and a
 *  reconcile that hasn't recorded them yet) keep working unchanged. */
type ProjectionDrop = DroppedProjection & {
  form?: "gable" | "hip" | "shed" | null;
  stubReturnFt?: number | null;
};

/**
 * We do NOT invent geometry: a line is synthesized ONLY when the roof-area
 * schedule gives that mass a real area, so depth = area ÷ span is a measured
 * number, not a guess. The cover's own roof form decides which edges gutter:
 *  - GABLE (default) — the outer face is a rake; the two SIDES gutter → 2×depth
 *  - HIP — the eave wraps the cover: two sides + the outer face → 2×depth + span
 *  - SHED — one low monopitch edge only → span
 * A SHORTFALL drop (stubReturnFt set) means the traced outline already priced
 * a wall bump `stubReturnFt` deep under this cover — we synthesize ONLY the
 * depth the roof carries past it, 2×(depth − stubReturn) clamped ≥ 0, so the
 * stub's own edges are never double-counted. Everything is clamped to sane
 * bounds and each synthesized line is tagged "estimated — verify" so it reads
 * as a prompt to confirm, never a hard number.
 */
export function synthesizeProjectionGutterLF(
  dropped: readonly DroppedProjection[] | null | undefined,
  roofMasses: readonly RoofMassArea[] | null | undefined,
): { addedLF: number; notes: string[] } {
  if (!dropped?.length || !roofMasses?.length) return { addedLF: 0, notes: [] };

  // Match a dropped projection's kind to a roof-schedule mass by label. Real
  // schedules label these "GARAGE", "GARAGE ROOF", "COVERED PORCH", etc., so a
  // containment test in either direction is enough; "main"/"other" never match
  // (we only estimate a mass the schedule actually named). An ENTRY porch
  // roof-shares the "porch" schedule label (same normalization as
  // place-gables.ts) — try the raw kind first, then the synonym.
  const matchMass = (kind: string): RoofMassArea | null => {
    const k = kind.toLowerCase();
    if (k === "main" || k === "other" || k === "dormer") return null;
    const candidates = k === "entry" ? [k, "porch"] : [k];
    let best: RoofMassArea | null = null;
    for (const m of roofMasses) {
      const label = (m.label ?? "").toLowerCase();
      if (!label) continue;
      if (candidates.some((c) => label.includes(c) || c.includes(label))) {
        if (!best || m.areaFt2 > best.areaFt2) best = m;
      }
    }
    return best;
  };

  let addedLF = 0;
  const notes: string[] = [];
  const usedLabels = new Set<string>();
  for (const p of dropped as readonly ProjectionDrop[]) {
    if (!(p.spanFt && p.spanFt >= 6 && p.spanFt <= 120)) continue; // need a real span
    const mass = matchMass(p.kind);
    if (!mass || !(mass.areaFt2 >= 60 && mass.areaFt2 <= 4000)) continue;
    // One estimate per named mass — two elevations can each see the same
    // projecting gable (front + a side view) and we must not double-count it.
    if (usedLabels.has(mass.label)) continue;
    usedLabels.add(mass.label);

    const depthFt = mass.areaFt2 / p.spanFt;
    if (!(depthFt >= 4 && depthFt <= 60)) continue; // implausible → keep note-only
    const form = p.form === "hip" || p.form === "shed" ? p.form : "gable";
    const stubReturnFt =
      typeof p.stubReturnFt === "number" && Number.isFinite(p.stubReturnFt) && p.stubReturnFt >= 0
        ? p.stubReturnFt
        : null;

    let lf: number;
    let how: string;
    if (stubReturnFt != null) {
      // SHORTFALL: the traced bump already priced its return edges (and its
      // outer edge covers the span-length eave of a hip/shed cover, at the
      // same length wherever the roof edge actually sits) — add only the
      // depth the roof rides past the bump on posts/a beam.
      if (form === "shed") continue; // the low edge is span-length wherever it sits — already priced on the bump
      const shortFt = Math.max(0, depthFt - stubReturnFt);
      lf = Math.round(2 * shortFt);
      how = `roof ${Math.round(mass.areaFt2)} sf ÷ ${Math.round(p.spanFt)} ft span ≈ ${Math.round(depthFt)} ft deep, but the traced wall bump returns only ${Math.round(stubReturnFt)} ft — the extra ≈${Math.round(shortFt)} ft per side rides past it on posts/a beam`;
    } else if (form === "hip") {
      lf = Math.round(2 * depthFt + p.spanFt);
      how = `hipped cover — roof ${Math.round(mass.areaFt2)} sf ÷ ${Math.round(p.spanFt)} ft span ≈ ${Math.round(depthFt)} ft deep; the gutter wraps 2 sides + the ${Math.round(p.spanFt)} ft face`;
    } else if (form === "shed") {
      lf = Math.round(p.spanFt);
      how = `shed cover — the gutter hangs on the ${Math.round(p.spanFt)} ft low edge only`;
    } else {
      lf = Math.round(2 * depthFt); // two guttered side returns
      how = `roof ${Math.round(mass.areaFt2)} sf ÷ ${Math.round(p.spanFt)} ft span ≈ ${Math.round(depthFt)} ft deep × 2 side returns`;
    }
    if (lf < 6 || lf > 200) continue;
    addedLF += lf;
    notes.push(
      `➕ Estimated ${p.kind} gutter: ~${lf} LF (${how}). This mass projects beyond the traced outline and was NOT measured from the plan — VERIFY before quoting.`,
    );
  }
  return { addedLF, notes };
}
