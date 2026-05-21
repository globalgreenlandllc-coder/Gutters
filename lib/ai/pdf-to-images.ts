import "server-only";
import { pdf } from "pdf-to-img";

export interface RasterizedPage {
  /** 1-based page index */
  pageIndex: number;
  /** PNG image as base64 (no data: prefix) */
  base64: string;
  /** "image/png" — for the Anthropic vision content block */
  mediaType: "image/png";
  /** Rendered pixel size (informational; Claude is downscaled regardless). */
  width: number;
  height: number;
}

/**
 * Rasterize each page of a PDF to a PNG image suitable for Claude vision.
 *
 * Construction plans are usually 24×36" ARCH-D sheets. We render at 150 DPI
 * because Claude downsamples large images server-side anyway — going higher
 * just inflates upload size without improving readability. 150 DPI on ARCH-D
 * ≈ 3600×5400 px which Claude will re-bucket to ~1568px max edge.
 *
 * Cap at MAX_PAGES so a 50-page plan set doesn't blow up the API call. The
 * model is asked to find the roof plan among the supplied pages, so a
 * couple extra pages are fine — but at 50+ pages we hit Anthropic's
 * 20-images-per-request limit anyway.
 */
const MAX_PAGES = 10;

export async function rasterizePdf(
  pdfBuffer: Buffer,
): Promise<{ ok: true; pages: RasterizedPage[] } | { ok: false; reason: string }> {
  try {
    const doc = await pdf(pdfBuffer, { scale: 2 });
    const pages: RasterizedPage[] = [];
    let i = 0;
    for await (const pageBuffer of doc) {
      i += 1;
      if (i > MAX_PAGES) break;
      pages.push({
        pageIndex: i,
        base64: pageBuffer.toString("base64"),
        mediaType: "image/png",
        width: 0, // pdf-to-img doesn't expose dimensions; not critical for our use
        height: 0,
      });
    }
    if (pages.length === 0) {
      return { ok: false, reason: "PDF contained zero pages" };
    }
    return { ok: true, pages };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "PDF rasterization failed",
    };
  }
}
