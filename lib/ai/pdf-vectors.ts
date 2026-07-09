import "server-only";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { segmentsFromOps, selectSegments } from "./pdf-segments";

/**
 * "Read the blueprint better": pull the PDF's REAL vector layer — printed
 * dimensions/labels (text) AND the actual drawn line segments — and hand
 * them to the Stage-2 geometry model as ground truth, instead of making it
 * eyeball the rendered page. The pipeline was 100% vision: Claude read the
 * raster and guessed pixel coordinates + scale, which is why dense plans
 * came back the wrong size/shape.
 *
 * Runs server-side via `unpdf` (a serverless-safe pdfjs build). This is
 * TEXT + path-OPERATOR extraction, NOT rasterization, so it avoids the
 * DOM-polyfill problem that pulled pdfjs-dist off the server before.
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

export type PdfPageVectors = {
  /** 1-based page the data was read from. */
  page: number;
  /** Which sheet this page is, for prompt wording — e.g.
   *  "foundation/floor plan" (authoritative footprint) vs "roof plan". */
  sheet?: string;
  widthPt: number;
  heightPt: number;
  /** Dimension-like strings (digit + a feet/inch/scale mark) — the
   *  load-bearing ground truth for scale + per-wall length. */
  dimensions: PdfTextItem[];
  /** Other short labels useful for classification: sheet titles,
   *  GABLE/RIDGE/EAVE tags, slope ratios, elevation side names, etc. */
  labels: PdfTextItem[];
  /** Candidate drawn line segments `[x1,y1,x2,y2]` in the SAME PDF user
   *  space as the text — the long orthogonal ones include the building
   *  footprint perimeter; longer diagonals are hips/ridges. */
  segments: number[][];
};

/**
 * Vectors pulled from the TWO pages that matter for a takeoff:
 * - `footprint` — the foundation / floor plan, which carries the CLEAN
 *   building outline + the overall ("64'-0 OVERALL") dimensions. This is
 *   the authoritative footprint shape. (Falls back to the roof plan when
 *   the classifier didn't identify a separate floor/foundation sheet.)
 * - `roof` — the roof plan, used only to CROSS-REFERENCE edge
 *   classification (ridges/hips/valleys, GABLE/EAVE tags). On some sets
 *   this is a dense framing/truss sheet whose lines are NOT the footprint,
 *   so the prompt is careful never to snap the footprint to them.
 */
export type PlanVectors = {
  footprint: PdfPageVectors | null;
  roof: PdfPageVectors | null;
};

const MAX_TEXT = 90;
const DIM_RE = /\d/;
const SIZE_MARK_RE = /['"′″]|\bft\b|\bLF\b|\d\s*[-:]\s*\d|\d\/\d/i;

// The operator-list → segment logic (incl. stroke-weight tracking + the
// bold-line filter) lives in the pure, node-tested ./pdf-segments module.

/**
 * Extract the vector layer of one PDF page. `page1Based` should be the
 * roof plan page the Stage-1 classifier identified (falls back to page 1).
 * `boldOnly` keeps just the heavy structural strokes (roof outline +
 * ridge/hip/valley) and drops thin truss/dimension/hatching noise — use it
 * for the dense roof-framing sheet, NOT the footprint authority page.
 */
export async function extractPdfPageText(
  base64: string,
  page1Based: number | null | undefined,
  opts?: { boldOnly?: boolean },
): Promise<PdfPageVectors | null> {
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
      const x = Math.round(Number(tx[4]) || 0);
      const y = Math.round(Number(tx[5]) || 0);
      if (DIM_RE.test(s) && SIZE_MARK_RE.test(s)) {
        if (dimensions.length < MAX_TEXT) dimensions.push({ s, x, y });
      } else if (s.length <= 24 && /[A-Za-z0-9]/.test(s)) {
        if (labels.length < MAX_TEXT) labels.push({ s, x, y });
      }
    }

    let segments: number[][] = [];
    try {
      const { OPS } = await getResolvedPDFJS();
      const opList = await page.getOperatorList();
      segments = selectSegments(
        segmentsFromOps(opList, OPS),
        opts?.boldOnly ?? false,
      );
    } catch (e) {
      console.warn(
        "[pdf-vectors] segment extraction failed (text still used):",
        e instanceof Error ? e.message : e,
      );
    }

    if (dimensions.length === 0 && labels.length === 0 && segments.length === 0)
      return null;

    return {
      page: pageNum,
      widthPt: Math.round(viewport.width),
      heightPt: Math.round(viewport.height),
      dimensions,
      labels,
      segments,
    };
  } catch (e) {
    console.warn(
      "[pdf-vectors] extraction failed (continuing vision-only):",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/**
 * Extract the vector layer of BOTH the footprint source (foundation /
 * floor plan) and the roof plan. The footprint sheet is the authoritative
 * outline; the roof sheet is cross-reference only (and may be a dense
 * framing/truss page). When the classifier didn't identify a separate
 * floor/foundation sheet, the roof plan stands in as the footprint source
 * (a clean roof plan's perimeter IS the outline) and `roof` is left null
 * so we don't double-extract the same page.
 *
 * Fully fail-safe: each page is read independently and any failure yields
 * null for that page; the whole call returns null only if BOTH are empty.
 */
export async function extractPlanVectors(
  base64: string,
  opts: { footprintPage?: number | null; roofPage?: number | null },
): Promise<PlanVectors | null> {
  const fpPage = opts.footprintPage ?? null;
  const rfPage = opts.roofPage ?? null;

  if (fpPage) {
    // Footprint sheet stays geometry-driven (the outline + interior partitions
    // often share a weight, so bold-filtering could drop the perimeter).
    const footprint = await extractPdfPageText(base64, fpPage);
    if (footprint) footprint.sheet = "foundation/floor plan";
    // Roof sheet is the dense truss page this feature targets → keep only the
    // BOLD roof lines (outline + ridge/hip/valley), drop the truss noise.
    const roof =
      rfPage && rfPage !== fpPage
        ? await extractPdfPageText(base64, rfPage, { boldOnly: true })
        : null;
    if (roof) roof.sheet = "roof plan";
    if (!footprint && !roof) return null;
    return { footprint, roof };
  }

  // No dedicated floor/foundation sheet — the roof plan is the best
  // available footprint source.
  const footprint = rfPage ? await extractPdfPageText(base64, rfPage) : null;
  if (footprint) footprint.sheet = "roof plan";
  if (!footprint) return null;
  return { footprint, roof: null };
}

const fmtText = (items: PdfTextItem[]) =>
  items.map((i) => `${i.s}@(${i.x},${i.y})`).join("  ");
// Only the 4 coords go to the model — a 5th stroke-weight element (used
// downstream for wall/dimension tiering) is not geometry the AI should see.
const fmtSegs = (segs: number[][]) =>
  segs.map((s) => `[${s.slice(0, 4).join(",")}]`).join(" ");

/**
 * Render the extracted vectors into a compact ground-truth block for the
 * Stage-2 user message. Empty string when there's nothing to add. The
 * guidance lives HERE (user message) rather than the system prompt, so it
 * applies even when the system prompt is overridden via /admin/prompts.
 *
 * Two clearly-separated sections: the footprint sheet is the AUTHORITY for
 * the building outline + scale; the roof sheet is cross-reference for edge
 * classification only — the model is explicitly told NOT to snap the
 * footprint to roof-plan/truss lines.
 */
export function buildVectorBlock(plan: PlanVectors | null | undefined): string {
  if (!plan || (!plan.footprint && !plan.roof)) return "";
  const lines: string[] = [];

  const fp = plan.footprint;
  if (fp) {
    const where = fp.sheet ?? "foundation/floor plan";
    lines.push(
      `EXTRACTED VECTOR DATA — BUILDING OUTLINE (page ${fp.page}, ${fp.widthPt}×${fp.heightPt} pt, origin bottom-left, read from the ${where}'s real vector layer). This is the AUTHORITATIVE footprint shape + scale — trust it over pixel-eyeballing:`,
    );
    if (fp.dimensions.length) {
      lines.push(
        "- DIMENSIONS: the architect's real overall + per-wall lengths. Set " +
          "scale from these and make every building_footprint wall match a " +
          "printed dimension; if your trace disagrees, the dimension wins.",
      );
      lines.push(`DIMENSIONS: ${fmtText(fp.dimensions)}`);
    }
    if (fp.segments.length) {
      lines.push(
        "- OUTLINE SEGMENTS [x1,y1,x2,y2]: real strokes from the " +
          `${where}. The building_footprint perimeter is the OUTERMOST closed ` +
          "loop of these — snap your footprint corners to these endpoints and " +
          "capture every jog/bump-out (porch, patio, garage, fireplace). IGNORE " +
          "interior partition walls (segments that sit inside the outer loop).",
      );
      lines.push(`OUTLINE: ${fmtSegs(fp.segments)}`);
    }
    if (fp.labels.length) {
      lines.push(`OUTLINE LABELS: ${fmtText(fp.labels)}`);
    }
    lines.push("");
  }

  const rf = plan.roof;
  if (rf) {
    lines.push(
      `EXTRACTED VECTOR DATA — ROOF PLAN (page ${rf.page}, ${rf.widthPt}×${rf.heightPt} pt, origin bottom-left). Cross-reference for edge classification ONLY — NOT the footprint authority (this sheet may be a dense framing/truss plan):`,
    );
    if (rf.labels.length) {
      lines.push(
        "- ROOF LABELS: use to classify edges (GABLE/RIDGE/HIP/EAVE tags, " +
          "slope ratios, side names).",
      );
      lines.push(`ROOF LABELS: ${fmtText(rf.labels)}`);
    }
    if (rf.segments.length) {
      lines.push(
        "- ROOF LINES [x1,y1,x2,y2]: candidate ridges/hips/valleys + roof-plane " +
          "edges. Use ONLY to classify eave-vs-rake; do NOT snap the footprint " +
          "to these (they include interior framing/truss members).",
      );
      lines.push(`ROOF LINES: ${fmtSegs(rf.segments)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Extract each page's raw text (concatenated items) ONCE — the source the
 * schedule-area + roof-mass parsers run on. Logs a per-page diagnostic (text
 * length, whether "ROOF AREA" appears, a snippet around it) plus a summary, so a
 * re-analyze reveals WHY the roof schedule isn't being read: a genuinely empty
 * text layer (scanned/image PDF — unpdf can't read it) vs. a format the parser
 * misses. Fully fail-safe → [] on any error.
 */
export async function extractScheduleText(base64: string): Promise<{ page: number; text: string }[]> {
  try {
    if (!base64) return [];
    const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    const pdf = await getDocumentProxy(bytes);
    const total = pdf.numPages;
    if (!total) return [];
    const maxPages = Math.min(total, 30);
    const out: { page: number; text: string }[] = [];
    let withText = 0;
    let withRoofArea = 0;
    for (let p = 1; p <= maxPages; p++) {
      try {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const text = (content.items as Array<{ str?: string }>).map((i) => i.str ?? "").join(" ");
        out.push({ page: p, text });
        if (text.trim().length > 0) withText++;
        const ra = text.search(/roof\s*area/i);
        const hasRoofArea = ra >= 0;
        if (hasRoofArea) withRoofArea++;
        const hasSF = /\bs\.?\s?f\.?\b|sq\.?\s?ft|square\s+feet/i.test(text);
        const snippet = hasRoofArea
          ? ` snippet="${text.slice(Math.max(0, ra - 20), ra + 70).replace(/\s+/g, " ")}"`
          : "";
        console.log(
          `[pdf-vectors] page ${p}: textLen=${text.length} hasRoofArea=${hasRoofArea} hasSF=${hasSF}${snippet}`,
        );
      } catch (e) {
        console.warn(`[pdf-vectors] page ${p} text extraction failed:`, e instanceof Error ? e.message : e);
      }
    }
    console.log(
      `[pdf-vectors] schedule scan: ${maxPages} page(s), ${withText} with text, ${withRoofArea} with "ROOF AREA".` +
        (withText === 0 ? " NO TEXT LAYER — likely a scanned/image PDF; unpdf can't read it (that's why the roof schedule is missing)." : ""),
    );
    return out;
  } catch (e) {
    console.warn("[pdf-vectors] schedule text extraction failed:", e instanceof Error ? e.message : e);
    return [];
  }
}
