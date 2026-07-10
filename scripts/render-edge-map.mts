/**
 * Render the v2 EDGE MAP overlay for the Woodinville PDF — exactly the image
 * classify-edges.ts sends to the model. Eyeball: every outline edge gets a
 * legible E-chip outside the ring, dimension candidates get D-chips, and the
 * sheet's own linework shows through for context.
 * Run:  npx tsx scripts/render-edge-map.mts
 * Writes scripts/edge-map.svg / .png (gitignored render outputs).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import sharp from "sharp";
import { segmentsFromOps, selectSegments } from "../lib/ai/pdf-segments.ts";
import { readRoofFromVectors } from "../lib/ai/roof-from-vectors.ts";
import { renderEdgeMapSvg, renderDimMapSvg } from "../lib/ai/plan-overlay.ts";
import { findDimSpanCandidates } from "../lib/ai/dim-scale.ts";
import { extractBuildingOutline } from "../lib/ai/outline-from-vectors.ts";

const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const ROOF_PAGE = 11;
const FOOTPRINT_PAGE = 6;

const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const { OPS } = await getResolvedPDFJS();

async function pageSegs(n: number, boldOnly: boolean) {
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const opList = await page.getOperatorList();
  return {
    segs: selectSegments(segmentsFromOps(opList, OPS), boldOnly),
    w: Math.round(vp.width),
    h: Math.round(vp.height),
  };
}

const roofPg = await pageSegs(ROOF_PAGE, true);
console.log(`A9 segments: ${roofPg.segs.length} (page ${roofPg.w}x${roofPg.h}pt)`);

const roof = readRoofFromVectors([], roofPg.segs);
if (!roof || roof.perimeter.length <= 4) {
  console.log("outline rejected");
  process.exit(1);
}
console.log(`outline: ${roof.perimeter.length} corners`);

const dims = findDimSpanCandidates(roofPg.segs, roof.perimeter, 4, {
  pageW: roofPg.w,
  pageH: roofPg.h,
});
console.log(
  `roof dim candidates: ${dims.map((d) => `${d.id}(${d.axis}, ${Math.round(d.spanPt)}pt)`).join(", ") || "none"}`,
);

// Footprint page (foundation plan) — where the printed overall dims live.
const fpPg = await pageSegs(FOOTPRINT_PAGE, false);
console.log(`A4 segments: ${fpPg.segs.length} (page ${fpPg.w}x${fpPg.h}pt)`);
const fpOutline = extractBuildingOutline(fpPg.segs)?.polygon ?? null;
let fpDims: ReturnType<typeof findDimSpanCandidates> = [];
if (fpOutline && fpOutline.length >= 3) {
  fpDims = findDimSpanCandidates(fpPg.segs, fpOutline, 4, {
    pageW: fpPg.w,
    pageH: fpPg.h,
    idOffset: dims.length,
  });
}
console.log(
  `footprint dim candidates: ${fpDims.map((d) => `${d.id}(${d.axis}, ${Math.round(d.spanPt)}pt)`).join(", ") || "none"}`,
);
if (fpDims.length > 0) {
  const dm = renderDimMapSvg({ segments: fpPg.segs, dims: fpDims });
  writeFileSync("scripts/dim-map.svg", dm.svg);
  writeFileSync("scripts/dim-map.png", await sharp(Buffer.from(dm.svg)).png().toBuffer());
  console.log(`wrote scripts/dim-map.png (${dm.widthPx}x${dm.heightPx})`);
  // Scale sanity: what would each candidate imply for the A9 outline width?
  const xs = roof.perimeter.map((p) => p.x);
  const outlineW = Math.max(...xs) - Math.min(...xs);
  for (const d of fpDims) {
    console.log(
      `  if ${d.id} = 64 ft → ${(d.spanPt / 64).toFixed(2)} pt/ft → outline width ${(outlineW / (d.spanPt / 64)).toFixed(1)} ft`,
    );
  }
}

const { svg, edges, widthPx, heightPx } = renderEdgeMapSvg({
  outline: roof.perimeter,
  segments: roofPg.segs,
  dims,
});
console.log(
  `edges: ${edges.filter((e) => e.lenPt >= 1e-6).length} — ${edges
    .slice(0, 6)
    .map((e) => `${e.id}:${Math.round(e.lenPt)}pt/${e.axis}`)
    .join(" ")}…`,
);
writeFileSync("scripts/edge-map.svg", svg);
const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync("scripts/edge-map.png", png);
console.log(`wrote scripts/edge-map.png (${widthPx}x${heightPx})`);
