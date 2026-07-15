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
import {
  validateBlueprintGeometry,
  parseScheduleAreaFt2,
  parseRoofMasses,
  parseOverallDimsFt,
  type RoofMassArea,
} from "./to-masses";
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

/** The deterministic text/schedule evidence the gates run on. Extractable
 *  EARLY (before the edge takeoff needs `roofMasses`) and passed back into
 *  `runBlueprintGates` so the PDF text layer is scanned exactly once even
 *  though the gates themselves run AFTER the edge takeoff (whose D-chip
 *  printed reads anchor the stated-box cross-check). */
export type GateEvidence = {
  texts: { page: number; text: string }[];
  schedule: { areaFt2: number; label: string; page: number } | null;
  roofMasses: RoofMassArea[];
  roofMassSource: string;
};

export async function extractGateEvidence(args: {
  /** Raw PDF bytes (base64) when the source is a PDF, else null. */
  pdfBase64: string | null;
  classification: PlanClassification | null;
}): Promise<GateEvidence> {
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
  return { texts, schedule, roofMasses, roofMassSource };
}

export async function runBlueprintGates(args: {
  analysis: BlueprintAnalysis;
  classification: PlanClassification | null;
  /** Raw PDF bytes (base64) when the source is a PDF, else null. Unused when
   *  `evidence` is supplied. */
  pdfBase64: string | null;
  /** Deterministic printed-dimension reads in FEET (the edge classifier's
   *  D-chip values, when the caller has them). Combined with the text-layer
   *  OVERALL callouts parsed here to cross-check the classifier's vision-read
   *  width × depth before it becomes the area-gate baseline. Optional —
   *  without it, only text-layer overalls anchor the check. */
  printedDimsFt?: readonly number[] | null;
  /** Precomputed text/schedule evidence (extractGateEvidence) — pass it when
   *  the routes extracted it early for the edge takeoff's roofMasses, so the
   *  PDF text layer isn't scanned twice. */
  evidence?: GateEvidence | null;
}): Promise<BlueprintGateResult> {
  const { texts, schedule, roofMasses, roofMassSource } =
    args.evidence ??
    (await extractGateEvidence({
      pdfBase64: args.pdfBase64,
      classification: args.classification,
    }));

  // Printed OVERALL callouts (deterministic text) + any dimension reads the
  // caller passed down — the evidence the classifier's vision-read width×depth
  // box is cross-checked against before it becomes the area-gate baseline
  // (a misread 71.5' depth once became a 4576 sf phantom baseline on a good
  // 3264 sf trace). Sets that outline ALL their text yield no overalls here;
  // then only the caller's dim reads can anchor the check.
  const textOveralls = texts.flatMap(({ text }) => parseOverallDimsFt(text));
  const printedDimsFt = [...(args.printedDimsFt ?? []), ...textOveralls];
  console.log(
    `[blueprint-gates] schedule area: ${
      schedule ? `${schedule.areaFt2} sf (${schedule.label}, p${schedule.page})` : "NONE → area gate uses width×depth"
    }; roof masses: ${roofMasses.length ? `${roofMasses.map((m) => `${m.label}=${m.areaFt2}`).join(", ")} (${roofMassSource})` : "NONE → gable depth uses schematic"}; ` +
      `printed dims for the box check: ${printedDimsFt.length ? printedDimsFt.map((f) => `${f}'`).join(", ") : "NONE"}.`,
  );

  const v = validateBlueprintGeometry(args.analysis, args.classification, {
    statedScheduleAreaFt2: schedule?.areaFt2 ?? null,
    scheduleLabel: schedule ? `${schedule.label} (p${schedule.page})` : undefined,
    printedDimsFt: printedDimsFt.length > 0 ? printedDimsFt : null,
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
