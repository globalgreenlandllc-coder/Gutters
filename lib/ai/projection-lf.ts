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

/**
 * We do NOT invent geometry: a line is synthesized ONLY when the roof-area
 * schedule gives that mass a real area, so depth = area ÷ span is a measured
 * number, not a guess. A projecting GABLE mass sheds off its two SIDES (the
 * gable end faces out as a rake; the back abuts the house), so the guttered
 * run ≈ 2 × depth. Everything is clamped to sane bounds and each synthesized
 * line is tagged "estimated — verify" so it reads as a prompt to confirm,
 * never a hard number.
 */
export function synthesizeProjectionGutterLF(
  dropped: readonly DroppedProjection[] | null | undefined,
  roofMasses: readonly RoofMassArea[] | null | undefined,
): { addedLF: number; notes: string[] } {
  if (!dropped?.length || !roofMasses?.length) return { addedLF: 0, notes: [] };

  // Match a dropped projection's kind to a roof-schedule mass by label. Real
  // schedules label these "GARAGE", "GARAGE ROOF", "COVERED PORCH", etc., so a
  // containment test in either direction is enough; "main"/"other" never match
  // (we only estimate a mass the schedule actually named).
  const matchMass = (kind: string): RoofMassArea | null => {
    const k = kind.toLowerCase();
    if (k === "main" || k === "other" || k === "dormer") return null;
    let best: RoofMassArea | null = null;
    for (const m of roofMasses) {
      const label = (m.label ?? "").toLowerCase();
      if (!label) continue;
      if (label.includes(k) || k.includes(label)) {
        if (!best || m.areaFt2 > best.areaFt2) best = m;
      }
    }
    return best;
  };

  let addedLF = 0;
  const notes: string[] = [];
  const usedLabels = new Set<string>();
  for (const p of dropped) {
    if (!(p.spanFt && p.spanFt >= 6 && p.spanFt <= 120)) continue; // need a real span
    const mass = matchMass(p.kind);
    if (!mass || !(mass.areaFt2 >= 60 && mass.areaFt2 <= 4000)) continue;
    // One estimate per named mass — two elevations can each see the same
    // projecting gable (front + a side view) and we must not double-count it.
    if (usedLabels.has(mass.label)) continue;
    usedLabels.add(mass.label);

    const depthFt = mass.areaFt2 / p.spanFt;
    if (!(depthFt >= 4 && depthFt <= 60)) continue; // implausible → keep note-only
    const lf = Math.round(2 * depthFt); // two guttered side returns
    if (lf < 6 || lf > 200) continue;
    addedLF += lf;
    notes.push(
      `➕ Estimated ${p.kind} gutter: ~${lf} LF (roof ${Math.round(mass.areaFt2)} sf ÷ ${Math.round(p.spanFt)} ft span ≈ ${Math.round(depthFt)} ft deep × 2 side returns). This mass projects beyond the traced outline and was NOT measured from the plan — VERIFY before quoting.`,
    );
  }
  return { addedLF, notes };
}
