import "server-only";

/**
 * Run the deterministic roof-engine gates over a finished BlueprintAnalysis and
 * return both the structured flags (stashed on `analysisJson._engine` for a
 * future dedicated UI) and human-readable note lines (folded into the analysis
 * notes so they surface in today's results panel).
 *
 * This is the single wire-in point shared by the upload route and the reanalyze
 * route so the two stay in lockstep. It is pure VALIDATION — it never mutates
 * geometry or pricing; worst case it adds a review note.
 *
 * Schedule-area priority for the area gate: title-block/schedule area
 * (authoritative, extracted from the PDF text) → classifier width × depth
 * (backstop) → scale-free aspect ratio (last resort, inside the validator).
 */

import type { BlueprintAnalysis } from "./blueprint-from-plans";
import type { PlanClassification } from "./classify-plans";
import { extractScheduleArea } from "./pdf-vectors";
import { validateBlueprintGeometry } from "./to-masses";
import type { ReviewFlag } from "../roof-engine";

export type BlueprintGateResult = {
  reviewFlags: ReviewFlag[];
  scaleFtPerPx: number | null;
  scheduleArea: { areaFt2: number; label: string; page: number } | null;
  /** Human-readable lines to fold into `analysis.notes`. */
  notes: string[];
};

const MARK: Record<ReviewFlag["severity"], string> = {
  error: "⛔",
  warn: "⚠",
  info: "🔎",
};

export async function runBlueprintGates(args: {
  analysis: BlueprintAnalysis;
  classification: PlanClassification | null;
  /** Raw PDF bytes (base64) when the source is a PDF, else null. */
  pdfBase64: string | null;
}): Promise<BlueprintGateResult> {
  const schedule = args.pdfBase64 ? await extractScheduleArea(args.pdfBase64) : null;

  const v = validateBlueprintGeometry(args.analysis, args.classification, {
    statedScheduleAreaFt2: schedule?.areaFt2 ?? null,
    scheduleLabel: schedule ? `${schedule.label} (p${schedule.page})` : undefined,
  });

  const notes = v.reviewFlags.map((f) => `${MARK[f.severity]} ${f.message}`);

  return {
    reviewFlags: v.reviewFlags,
    scaleFtPerPx: v.scaleFtPerPx,
    scheduleArea: schedule,
    notes,
  };
}
