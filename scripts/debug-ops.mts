/**
 * debug-ops.mts — inventory a page's operator list: op counts, image XObjects
 * (size + placement), and how many path segments land in the central drawing
 * area vs the frame/title block. Answers: is the drawing raster or vector?
 * Run: npx tsx scripts/debug-ops.mts [pages...]
 */
import { readFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { segmentsFromOps } from "../lib/ai/pdf-segments.ts";

const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const pages = process.argv.slice(2).map(Number);
if (pages.length === 0) pages.push(6, 8, 11, 13);

const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const { OPS } = await getResolvedPDFJS();
const OPNAME: Record<number, string> = {};
for (const [k, v] of Object.entries(OPS)) if (typeof v === "number") OPNAME[v] = k;

for (const pageNum of pages) {
  const page = await pdf.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const counts = new Map<string, number>();
  for (const fn of ops.fnArray) {
    const n = OPNAME[fn] ?? `op${fn}`;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  console.log(`\n=== page ${pageNum} (${vp.width.toFixed(0)}×${vp.height.toFixed(0)} pt) ===`);
  console.log(
    "  ops:",
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v}`).join("  "),
  );
  // image placements: track CTM like segmentsFromOps does
  type Mat = [number, number, number, number, number, number];
  const mul = (a: Mat, b: Mat): Mat => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  const images: string[] = [];
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) {
      const a = ops.argsArray[k] as number[];
      if (a?.length >= 6) ctm = mul(ctm, [a[0], a[1], a[2], a[3], a[4], a[5]]);
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject) {
      // unit square maps through ctm: image spans (e, f) → (a+e, d+f)
      const w = Math.hypot(ctm[0], ctm[1]);
      const h = Math.hypot(ctm[2], ctm[3]);
      images.push(
        `${OPNAME[fn]} at (${ctm[4].toFixed(0)},${ctm[5].toFixed(0)}) size ${w.toFixed(0)}×${h.toFixed(0)} pt` +
          ` (${((w / vp.width) * 100).toFixed(0)}%×${((h / vp.height) * 100).toFixed(0)}% of page)`,
      );
    }
  }
  for (const im of images.slice(0, 8)) console.log(`  image: ${im}`);
  if (images.length > 8) console.log(`  … +${images.length - 8} more images`);
  // segment coverage of the central drawing area
  const raw = segmentsFromOps(ops, OPS);
  const inDrawing = raw.filter(({ seg }) => {
    const mx = (seg[0] + seg[2]) / 2;
    const my = (seg[1] + seg[3]) / 2;
    return mx > vp.width * 0.06 && mx < vp.width * 0.86 && my > vp.height * 0.04 && my < vp.height * 0.96;
  });
  const longInDrawing = inDrawing.filter(({ seg }) => Math.hypot(seg[2] - seg[0], seg[3] - seg[1]) >= 18);
  console.log(`  path segments: ${raw.length} total, ${inDrawing.length} in drawing area, ${longInDrawing.length} of those ≥18pt`);
}
