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
import { extractScheduleText } from "./pdf-vectors";
import { validateBlueprintGeometry, parseScheduleAreaFt2, parseRoofMasses, type RoofMassArea } from "./to-masses";
import { deriveOrientation, type PlanOrientation } from "./plan-orientation";
import type { ReviewFlag } from "../roof-engine";

export type BlueprintGateResult = {
  reviewFlags: ReviewFlag[];
  scaleFtPerPx: number | null;
  scheduleArea: { areaFt2: number; label: string; page: number } | null;
  /** Per-mass roof areas from the roof schedule (for projecting-gable depth). */
  roofMasses: RoofMassArea[];
  /** Compass→canvas orientation from elevation titles in the TEXT layer, when
   *  present (many sets outline their titles — the per-face `sheet_title` echo
   *  is the fallback the estimate path also consults). */
  orientation: PlanOrientation | null;
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
  // One page-text scan (logged), then run both parsers over it.
  const texts = args.pdfBase64 ? await extractScheduleText(args.pdfBase64) : [];
  let schedule: { areaFt2: number; label: string; page: number } | null = null;
  for (const { page, text } of texts) {
    const hit = parseScheduleAreaFt2(text);
    if (hit) {
      schedule = { ...hit, page };
      break;
    }
  }
  const byLabel = new Map<string, number>();
  for (const { text } of texts) {
    for (const m of parseRoofMasses(text)) {
      if (m.areaFt2 > (byLabel.get(m.label) ?? 0)) byLabel.set(m.label, m.areaFt2);
    }
  }
  // Text-layer parse first; when it finds nothing (many sets OUTLINE their
  // schedule text — the Woodinville PDF's whole text layer is 137 chars of
  // title-block boilerplate), fall back to the classifier's VISUAL read of the
  // roof-area tables (sheets[].roof_areas).
  let roofMassSource = "text layer";
  if (byLabel.size === 0 && args.classification?.sheets) {
    roofMassSource = "classifier (visual read)";
    for (const sheet of args.classification.sheets) {
      for (const ra of sheet.roof_areas ?? []) {
        if (!ra || typeof ra.area_ft2 !== "number") continue;
        if (!(ra.area_ft2 >= 50 && ra.area_ft2 <= 50000)) continue;
        const label = String(ra.label ?? "").trim().toLowerCase();
        if (!label) continue;
        if (ra.area_ft2 > (byLabel.get(label) ?? 0)) byLabel.set(label, ra.area_ft2);
      }
    }
  }
  const roofMasses: RoofMassArea[] = [...byLabel.entries()].map(([label, areaFt2]) => ({ label, areaFt2 }));
  console.log(
    `[blueprint-gates] schedule area: ${
      schedule ? `${schedule.areaFt2} sf (${schedule.label}, p${schedule.page})` : "NONE → area gate uses width×depth"
    }; roof masses: ${roofMasses.length ? `${roofMasses.map((m) => `${m.label}=${m.areaFt2}`).join(", ")} (${roofMassSource})` : "NONE → gable depth uses schematic"}.`,
  );

  const v = validateBlueprintGeometry(args.analysis, args.classification, {
    statedScheduleAreaFt2: schedule?.areaFt2 ?? null,
    scheduleLabel: schedule ? `${schedule.label} (p${schedule.page})` : undefined,
  });

  const notes = v.reviewFlags.map((f) => `${MARK[f.severity]} ${f.message}`);
  if (roofMasses.length) {
    notes.push(
      `🏠 Roof-area schedule: ${roofMasses.map((m) => `${m.label} ${m.areaFt2} sf`).join(", ")} — used for projecting-gable depth (area ÷ span).`,
    );
  }

  // Compass orientation from elevation titles in the text layer ("FRONT/NORTH
  // ELEVATION" ⇒ front-at-bottom fixes where north points on the canvas). Many
  // sets outline their titles (no text) — then this is null and the per-face
  // reads' sheet_title echo takes over at estimate time.
  const orientation = deriveOrientation(texts);
  if (orientation) notes.push(`🧭 ${orientation.note}`);

  return {
    reviewFlags: v.reviewFlags,
    scaleFtPerPx: v.scaleFtPerPx,
    scheduleArea: schedule,
    roofMasses,
    orientation,
    notes,
  };
}
