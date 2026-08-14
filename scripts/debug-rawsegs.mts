/**
 * debug-rawsegs.mts — dump the RAW segmentsFromOps output for a page (before
 * selectSegments filtering) + a length histogram, to see where the building
 * walls go missing. Run: npx tsx scripts/debug-rawsegs.mts [pageNum]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { segmentsFromOps } from "../lib/ai/pdf-segments.ts";

const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const pageNum = Number(process.argv[2] ?? 6);

const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const page = await pdf.getPage(pageNum);
const { OPS } = await getResolvedPDFJS();
const opList = await page.getOperatorList();
const raw = segmentsFromOps(opList, OPS);
console.log(`page ${pageNum}: raw segments ${raw.length}`);

// Length histogram
const buckets = [0, 2, 5, 10, 18, 30, 60, 120, 300, 1000, 1e9];
const counts = new Array(buckets.length - 1).fill(0);
let axisAligned = 0;
for (const { seg } of raw) {
  const len = Math.hypot(seg[2] - seg[0], seg[3] - seg[1]);
  if (Math.abs(seg[2] - seg[0]) < 1.5 || Math.abs(seg[3] - seg[1]) < 1.5) axisAligned++;
  for (let i = 0; i < buckets.length - 1; i++)
    if (len >= buckets[i] && len < buckets[i + 1]) { counts[i]++; break; }
}
for (let i = 0; i < counts.length - 1; i++)
  console.log(`  len ${String(buckets[i]).padStart(5)}–${String(buckets[i + 1]).padEnd(5)}: ${counts[i]}`);
console.log(`  axis-aligned: ${axisAligned}/${raw.length}`);

// widths
const widths = new Map<string, number>();
for (const { w } of raw) {
  const k = w == null ? "null(fill)" : (Math.round(w * 100) / 100).toString();
  widths.set(k, (widths.get(k) ?? 0) + 1);
}
console.log("  stroke widths:", [...widths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}×${v}`).join("  "));

// SVG of ALL raw segments
let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
for (const { seg } of raw) {
  x0 = Math.min(x0, seg[0], seg[2]); y0 = Math.min(y0, seg[1], seg[3]);
  x1 = Math.max(x1, seg[0], seg[2]); y1 = Math.max(y1, seg[1], seg[3]);
}
const W = 1400;
const S = W / (x1 - x0);
const H = (y1 - y0) * S;
const X = (x: number) => (x - x0) * S;
const Y = (y: number) => H - (y - y0) * S;
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H.toFixed(0)}" viewBox="0 0 ${W} ${H.toFixed(0)}">`,
  `<rect width="${W}" height="${H.toFixed(0)}" fill="white"/>`,
  ...raw.map(({ seg, w }) => {
    const len = Math.hypot(seg[2] - seg[0], seg[3] - seg[1]);
    const color = len >= 18 ? "#0f172a" : "#f97316"; // orange = killed by MIN_SEG_LEN
    return `<line x1="${X(seg[0]).toFixed(1)}" y1="${Y(seg[1]).toFixed(1)}" x2="${X(seg[2]).toFixed(1)}" y2="${Y(seg[3]).toFixed(1)}" stroke="${color}" stroke-width="${w == null ? 0.5 : 0.8}"/>`;
  }),
  `</svg>`,
].join("");
writeFileSync(`scripts/debug-rawsegs-p${pageNum}.svg`, svg);
writeFileSync(
  `scripts/debug-rawsegs-p${pageNum}.html`,
  `<!doctype html><meta charset="utf-8"><body style="margin:0">${svg}</body>`,
);
console.log(`wrote scripts/debug-rawsegs-p${pageNum}.svg (black = survives 18pt filter, orange = dropped-short)`);
