/**
 * lab-calibration.ts — the accuracy lab's LENGTH-BIAS RADAR: a robust
 * signed estimate of how much the engine systematically over/under-draws
 * gutter LF, computed from the admin's corrections.
 *
 * SIGNAL-ONLY by doctrine. An auto-applied geometric lever (drip-edge
 * offset) was built and probed: the engine's downstream wall snapping /
 * edge classification makes LF respond to offsets as a CLIFF, not a dial
 * (+0.02 m: no change; +0.04 m: two rakes flipped to eaves, +13% LF on
 * the reference roof). So this number is displayed and trended to direct
 * deterministic engine fixes — it never silently reprices user scans.
 *
 * Robustness rules:
 *   · MEDIAN of per-run LF deltas, never mean
 *   · APPROVED (clean) runs count as delta 0 — approvals are evidence
 *     of no bias and keep one bad correction from dominating
 *   · implausible deltas (>35% of the run's LF) are excluded — that's
 *     a structural failure needing a code fix, not a bias
 *   · needs ≥ MIN_SAMPLES finalized runs and ≥ MIN_ACTIONABLE_FT of
 *     consistent bias before it's flagged actionable
 */

export const LAB_CAL_MIN_SAMPLES = 5;
export const LAB_CAL_MIN_ACTIONABLE_FT = 1.5;
/** A delta beyond this fraction of the run's LF is structural, not bias. */
const MAX_PLAUSIBLE_FRACTION = 0.35;

export type LabCalibrationInput = {
  status: "APPROVED" | "CORRECTED";
  /** From the stored LabDiff. */
  eaveLFBefore: number;
  eaveLFAfter: number;
};

export type LabCalibration = {
  sampleCount: number;
  excludedCount: number;
  /** Signed: positive = engine draws SHORT (truth is longer). */
  medianLfDeltaFt: number;
  /** Enough consistent samples that the bias deserves an engine fix. */
  actionable: boolean;
};

export function computeLabCalibration(
  rows: LabCalibrationInput[],
): LabCalibration {
  const deltas: number[] = [];
  let excluded = 0;
  for (const r of rows) {
    if (r.status === "APPROVED") {
      deltas.push(0);
      continue;
    }
    if (!(r.eaveLFBefore > 0)) {
      excluded++;
      continue;
    }
    const delta = r.eaveLFAfter - r.eaveLFBefore;
    if (Math.abs(delta) > r.eaveLFBefore * MAX_PLAUSIBLE_FRACTION) {
      excluded++;
      continue;
    }
    deltas.push(delta);
  }

  const sampleCount = deltas.length;
  let median = 0;
  if (sampleCount > 0) {
    const sorted = [...deltas].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    median =
      sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const actionable =
    sampleCount >= LAB_CAL_MIN_SAMPLES &&
    Math.abs(median) >= LAB_CAL_MIN_ACTIONABLE_FT;

  return {
    sampleCount,
    excludedCount: excluded,
    medianLfDeltaFt: Math.round(median * 10) / 10,
    actionable,
  };
}
