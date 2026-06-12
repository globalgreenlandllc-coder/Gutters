import "server-only";
import type {
  BlueprintAnalysis,
  BlueprintRun,
} from "./blueprint-from-plans";
import type { GeometryConstraints } from "./classify-plans";

/**
 * Post-processing pass on the Stage-2 geometry output. The Stage-1
 * classifier extracts the real building dimensions off the foundation
 * plan ("64'-0 OVERALL"); those become the source of truth for what
 * the priced LF *should* be. If Stage-2's per-run length_ft values
 * sum to more than the cap (typical failure mode: Sonnet reads the
 * site-plan lot dimensions instead of the dimensioned wall labels
 * and inflates every run 2-3×), we proportionally scale the run
 * lengths down so the total fits the envelope.
 *
 * Why we don't re-prompt: another Claude call costs another 20-40s
 * and the same prompt has already failed once. The classifier's
 * dimensional read is reliable (Haiku is good at structured number
 * extraction); the geometry trace's *shape* is also usable. Scaling
 * the lengths in code keeps the shape, fixes the price, and gets the
 * contractor a usable takeoff in zero extra latency.
 *
 * Caveats:
 * - We scale length_ft only, not length_px. The canvas fit-to-viewBox
 *   uses pixel coordinates and doesn't care about the absolute pixel
 *   magnitude — only the relative shape, which is preserved.
 * - Single-run cap (no run > building's larger dimension) is treated
 *   as a flag, not a fix, because exceeding it means Sonnet merged
 *   what should have been two runs through a missed corner — we
 *   can't recover the corner without re-tracing.
 */
export function clampBlueprintToEnvelope(
  analysis: BlueprintAnalysis,
  constraints: GeometryConstraints | undefined,
): { analysis: BlueprintAnalysis; clampNotes: string[] } {
  const notes: string[] = [];
  if (!constraints) return { analysis, clampNotes: notes };

  const cap = constraints.max_total_eave_lf;
  const singleCap = constraints.max_single_run_lf;

  const runs = analysis.gutter_runs;
  const totalLF = runs.reduce((sum, r) => sum + (r.length_ft ?? 0), 0);

  let scaledRuns: BlueprintRun[] = runs;
  let scaledTotals = analysis.totals;

  if (cap != null && cap > 0 && totalLF > cap) {
    // Target slightly under the cap so the priced LF lands at a
    // believable number rather than exactly at the ceiling.
    const target = Math.round(cap * 0.85);
    const ratio = target / totalLF;
    scaledRuns = runs.map((r) => ({
      ...r,
      length_ft:
        r.length_ft != null ? Math.round(r.length_ft * ratio * 10) / 10 : null,
    }));
    const newTotal = Math.round(totalLF * ratio);
    scaledTotals = {
      ...analysis.totals,
      linear_feet_gutter: newTotal,
    };
    notes.push(
      `⚠ Scale auto-corrected: AI emitted ${Math.round(totalLF)} LF gutter, ` +
        `which exceeded the ${cap} LF envelope cap derived from the ` +
        `${constraints.building_envelope_note ?? "foundation plan"}. ` +
        `All run lengths scaled by ${ratio.toFixed(2)}× so the total ` +
        `lands at ~${newTotal} LF. Review the canvas — shape is correct, ` +
        `but verify individual run lengths before sending.`,
    );
  }

  if (singleCap != null && singleCap > 0) {
    const oversized = scaledRuns.filter(
      (r) => r.length_ft != null && r.length_ft > singleCap * 1.05,
    );
    if (oversized.length > 0) {
      const longest = Math.max(...oversized.map((r) => r.length_ft ?? 0));
      // A single straight eave can't be longer than the building's
      // longest wall — a run over the cap means the AI merged two eaves
      // through a missed corner (or misread the scale). Cap it to the
      // limit rather than just flagging, so the priced LF and the canvas
      // geometry don't carry an impossible 103 ft run on a 64 ft house.
      scaledRuns = scaledRuns.map((r) =>
        r.length_ft != null && r.length_ft > singleCap * 1.05
          ? { ...r, length_ft: Math.round(singleCap * 10) / 10 }
          : r,
      );
      const cappedTotal = Math.round(
        scaledRuns.reduce((s, r) => s + (r.length_ft ?? 0), 0),
      );
      scaledTotals = { ...scaledTotals, linear_feet_gutter: cappedTotal };
      notes.push(
        `⚠ ${oversized.length} run(s) exceeded the per-run cap of ${Math.round(singleCap)} ft ` +
          `(longest was ${Math.round(longest)} ft) — capped to ${Math.round(singleCap)} ft each. ` +
          `This usually means the AI merged two eaves through a missed outside ` +
          `corner; split them on the canvas where the roof changes direction.`,
      );
    }
  }

  if (notes.length === 0) return { analysis, clampNotes: notes };

  return {
    analysis: {
      ...analysis,
      gutter_runs: scaledRuns,
      totals: scaledTotals,
      confidence:
        analysis.confidence === "high" ? "medium" : analysis.confidence,
    },
    clampNotes: notes,
  };
}
