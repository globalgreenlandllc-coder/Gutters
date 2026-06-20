import "server-only";
import { getDocumentProxy } from "unpdf";

/**
 * Phase 1 of "read the blueprint better": pull the PDF's REAL text layer
 * (printed dimensions + labels, each with its coordinate) and hand it to
 * the Stage-2 geometry model as ground truth, instead of making it eyeball
 * the rendered page. Today the pipeline is 100% vision — Claude reads the
 * raster and guesses pixel coordinates + scale, which is exactly why dense
 * plans come back the wrong size / shape.
 *
 * Vector PDFs carry the dimensions as selectable text; extracting them is
 * cheap and reliable (`getTextContent`), so the model can calibrate scale
 * and verify each wall length against the architect's printed numbers.
 *
 * Runs server-side via `unpdf` (a serverless-safe pdfjs build) — note this
 * is TEXT extraction only, NOT rasterization, so it avoids the DOM-polyfill
 * problem that pulled pdfjs-dist off the server before. Raw line-segment /
 * outline extraction (parsing path operators) is Phase 2 — it needs
 * real-plan iteration to be trustworthy, so it's deliberately not here.
 *
 * Fully fail-safe: ANY error returns null and the caller falls back to the
 * existing vision-only path. It can never break an analysis.
 */

export type PdfTextItem = {
  /** The printed string, e.g. `24'-6"`, `4:12`, `GABLE`, `ROOF PLAN`. */
  s: string;
  /** Position in PDF user space (origin bottom-left), rounded to points. */
  x: number;
  y: number;
};

export type PdfPageText = {
  /** 1-based page the text was read from. */
  page: number;
  widthPt: number;
  heightPt: number;
  /** Dimension-like strings (contain a digit + a feet/inch/scale mark) —
   *  the load-bearing ground truth for scale + per-wall length. */
  dimensions: PdfTextItem[];
  /** Other short labels useful for classification: sheet titles,
   *  GABLE/RIDGE/EAVE tags, slope ratios, elevation side names, etc. */
  labels: PdfTextItem[];
};

const MAX_ITEMS = 90; // keep each list tight so the prompt block stays small
// A digit plus an architectural size mark: ' " ′ ″ , ft, LF, or a dash-run
// like 24-6. Catches 24'-6", 32', 1/4" = 1'-0", 4:12, etc.
const DIM_RE = /\d/;
const SIZE_MARK_RE = /['"′″]|\bft\b|\bLF\b|\d\s*[-:]\s*\d|\d\/\d/i;

/**
 * Extract the text layer of one PDF page. `page1Based` should be the roof
 * plan page the Stage-1 classifier identified (falls back to page 1).
 */
export async function extractPdfPageText(
  base64: string,
  page1Based: number | null | undefined,
): Promise<PdfPageText | null> {
  try {
    if (!base64) return null;
    const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    const pdf = await getDocumentProxy(bytes);
    const total = pdf.numPages;
    if (!total) return null;
    const pageNum = Math.min(Math.max(1, Math.round(page1Based || 1)), total);
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const dimensions: PdfTextItem[] = [];
    const labels: PdfTextItem[] = [];

    for (const raw of content.items as Array<{
      str?: string;
      transform?: number[];
    }>) {
      const s = (raw.str ?? "").trim();
      if (!s || s.length > 40) continue;
      const tx = raw.transform ?? [];
      // transform = [a,b,c,d,e,f]; (e,f) is the text origin in user space.
      const x = Math.round(Number(tx[4]) || 0);
      const y = Math.round(Number(tx[5]) || 0);
      if (DIM_RE.test(s) && SIZE_MARK_RE.test(s)) {
        if (dimensions.length < MAX_ITEMS) dimensions.push({ s, x, y });
      } else if (s.length <= 24 && /[A-Za-z0-9]/.test(s)) {
        if (labels.length < MAX_ITEMS) labels.push({ s, x, y });
      }
    }

    // Nothing useful → behave as if there were no vector text at all.
    if (dimensions.length === 0 && labels.length === 0) return null;

    return {
      page: pageNum,
      widthPt: Math.round(viewport.width),
      heightPt: Math.round(viewport.height),
      dimensions,
      labels,
    };
  } catch (e) {
    console.warn(
      "[pdf-vectors] text extraction failed (continuing vision-only):",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/**
 * Render the extracted text into a compact ground-truth block for the
 * Stage-2 user message. Empty string when there's nothing to add (so the
 * prompt is unchanged on raster/scanned plans or extraction failure).
 * The guidance lives HERE (in the user message) rather than the system
 * prompt, so it applies even when the system prompt is overridden via
 * /admin/prompts.
 */
export function buildVectorBlock(v: PdfPageText | null | undefined): string {
  if (!v) return "";
  const fmt = (items: PdfTextItem[]) =>
    items.map((i) => `${i.s}@(${i.x},${i.y})`).join("  ");
  const lines: string[] = [
    `EXTRACTED VECTOR-PDF TEXT (page ${v.page}, ${v.widthPt}×${v.heightPt} pt, origin bottom-left) — GROUND TRUTH:`,
    "These strings + coordinates were read from the PDF's real text layer, not",
    "your visual estimate. Trust them over pixel-eyeballing:",
    "- Use the DIMENSIONS to set scale and to check each wall length you trace;",
    "  if your traced footprint disagrees with the printed dimensions, the",
    "  dimensions win — re-read the outline.",
    "- Use the labels (sheet titles, GABLE/RIDGE/EAVE tags, slope ratios, side",
    "  names) to confirm which sheet is the roof plan and to classify edges.",
  ];
  if (v.dimensions.length) lines.push(`DIMENSIONS: ${fmt(v.dimensions)}`);
  if (v.labels.length) lines.push(`LABELS: ${fmt(v.labels)}`);
  lines.push("");
  return lines.join("\n");
}
