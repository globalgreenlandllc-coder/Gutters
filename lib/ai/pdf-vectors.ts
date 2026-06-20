import "server-only";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";

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
const MAX_SEGMENTS = 140;
const MIN_SEG_LEN = 18; // points — drops dimension ticks / hatching
const DIM_RE = /\d/;
const SIZE_MARK_RE = /['"′″]|\bft\b|\bLF\b|\d\s*[-:]\s*\d|\d\/\d/i;

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m: Mat, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/**
 * Walk a pdfjs operator list and recover stroked/filled straight LINE
 * segments in page user space. constructPath args are
 * `[paintOp, subPaths, bbox]`; each subPath is a flat array of
 * `[op, x, y, …]` where (validated empirically for the pinned pdfjs)
 * op 0 = moveTo, 1 = lineTo, 4 = closePath. Unknown ops (curves) end the
 * subpath safely rather than mis-aligning the coordinate stream.
 */
function segmentsFromOps(
  ops: { fnArray: number[]; argsArray: unknown[] },
  OPS: Record<string, number>,
): number[][] {
  const out: number[][] = [];
  const stack: Mat[] = [];
  let ctm: Mat = IDENTITY;
  for (let k = 0; k < ops.fnArray.length && out.length < 8000; k++) {
    const fn = ops.fnArray[k];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (fn === OPS.transform) {
      const a = ops.argsArray[k] as number[] | undefined;
      if (a && a.length >= 6) {
        ctm = mul(ctm, [a[0], a[1], a[2], a[3], a[4], a[5]]);
      }
    } else if (fn === OPS.constructPath) {
      const subPaths = (ops.argsArray[k] as unknown[])?.[1];
      if (!Array.isArray(subPaths)) continue;
      for (const raw of subPaths as ArrayLike<number>[]) {
        const p = Array.from(raw);
        let i = 0;
        let cx = 0;
        let cy = 0;
        let sx = 0;
        let sy = 0;
        let have = false;
        while (i < p.length) {
          const op = p[i];
          if (op === 0) {
            if (i + 2 >= p.length) break;
            [cx, cy] = apply(ctm, p[i + 1], p[i + 2]);
            sx = cx;
            sy = cy;
            have = true;
            i += 3;
          } else if (op === 1) {
            if (i + 2 >= p.length) break;
            const [nx, ny] = apply(ctm, p[i + 1], p[i + 2]);
            if (have) out.push([cx, cy, nx, ny]);
            cx = nx;
            cy = ny;
            i += 3;
          } else if (op === 4) {
            if (have) out.push([cx, cy, sx, sy]);
            cx = sx;
            cy = sy;
            i += 1;
          } else {
            break;
          }
        }
      }
    }
  }
  return out;
}

/** Keep the meaningful lines (drop ticks/hatching), dedupe undirected
 *  duplicates, prefer the longest, cap for prompt size. */
function filterSegments(raw: number[][]): number[][] {
  const seen = new Set<string>();
  const kept: { seg: number[]; len: number }[] = [];
  for (const [x1, y1, x2, y2] of raw) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < MIN_SEG_LEN) continue;
    const axisAligned = Math.abs(dx) < 1.5 || Math.abs(dy) < 1.5;
    if (!axisAligned && len < 60) continue; // short diagonals are noise
    const a = [Math.round(x1), Math.round(y1)];
    const b = [Math.round(x2), Math.round(y2)];
    const [p, q] =
      a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
    const key = `${p[0]},${p[1]},${q[0]},${q[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ seg: [p[0], p[1], q[0], q[1]], len });
  }
  kept.sort((m, n) => n.len - m.len);
  return kept.slice(0, MAX_SEGMENTS).map((k) => k.seg);
}

/**
 * Extract the vector layer of one PDF page. `page1Based` should be the
 * roof plan page the Stage-1 classifier identified (falls back to page 1).
 */
export async function extractPdfPageText(
  base64: string,
  page1Based: number | null | undefined,
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
      segments = filterSegments(segmentsFromOps(opList, OPS));
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
    const footprint = await extractPdfPageText(base64, fpPage);
    if (footprint) footprint.sheet = "foundation/floor plan";
    const roof =
      rfPage && rfPage !== fpPage ? await extractPdfPageText(base64, rfPage) : null;
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
const fmtSegs = (segs: number[][]) =>
  segs.map((s) => `[${s.join(",")}]`).join(" ");

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
