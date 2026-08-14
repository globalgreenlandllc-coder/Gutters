/**
 * debug-outline.mts — reproduce the "A4 outline 4 corners — a plain box" skip
 * on the REAL Woodinville plan set, through the REAL code path:
 *   unpdf page → segmentsFromOps → selectSegments (length filter, no bold)
 *   → extractBuildingOutline.
 * Then test the frame hypothesis: the traced "building" is actually the sheet
 * border / drawing-area rectangle, and peeling frame-hugging segments recovers
 * the articulated footprint.
 * Run: npx tsx scripts/debug-outline.mts [pageNum]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { segmentsFromOps, selectSegments } from "../lib/ai/pdf-segments.ts";
import { extractBuildingOutline, type Pt } from "../lib/ai/outline-from-vectors.ts";

const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const pageNum = Number(process.argv[2] ?? 6); // A4 foundation plan

const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const page = await pdf.getPage(pageNum);
const { OPS } = await getResolvedPDFJS();
const opList = await page.getOperatorList();
const raw = segmentsFromOps(opList, OPS);
const segs = selectSegments(raw, false);
console.log(`page ${pageNum}: raw segments ${raw.length}, selected ${segs.length}`);

const bb = (ss: number[][]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of ss) {
    x0 = Math.min(x0, s[0], s[2]); y0 = Math.min(y0, s[1], s[3]);
    x1 = Math.max(x1, s[0], s[2]); y1 = Math.max(y1, s[1], s[3]);
  }
  return { x0, y0, x1, y1 };
};
const bbox = bb(segs);
console.log(`segment bbox: ${JSON.stringify(bbox)} (${(bbox.x1 - bbox.x0).toFixed(0)}×${(bbox.y1 - bbox.y0).toFixed(0)} pt)`);

const out = extractBuildingOutline(segs);
if (!out) console.log("extractBuildingOutline → null");
else {
  console.log(`outline: ${out.polygon.length} corners`);
  const px = out.polygon.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" ");
  console.log(`  ${px}`);
  const pbb = bb(out.polygon.map((p) => [p.x, p.y, p.x, p.y]));
  const cover =
    ((pbb.x1 - pbb.x0) * (pbb.y1 - pbb.y0)) /
    Math.max(1e-6, (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0));
  console.log(`  outline-bbox / segment-bbox area: ${(cover * 100).toFixed(1)}% ← ~100% means we traced the sheet frame`);
}

// ── Frame-peel experiment: drop segments hugging the global bbox edges, retry.
const span = Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0);
const tol = span * 0.02;
const nearEdge = (v: number, lo: number, hi: number) => v - lo < tol || hi - v < tol;
const onFrame = (s: number[]) => {
  const horiz = Math.abs(s[1] - s[3]) < tol;
  const vert = Math.abs(s[0] - s[2]) < tol;
  if (horiz && nearEdge(s[1], bbox.y0, bbox.y1) && nearEdge(s[3], bbox.y0, bbox.y1)) return true;
  if (vert && nearEdge(s[0], bbox.x0, bbox.x1) && nearEdge(s[2], bbox.x0, bbox.x1)) return true;
  return false;
};
let peeled = segs.filter((s) => !onFrame(s));
console.log(`\npeel pass 1: dropped ${segs.length - peeled.length} frame-hugging segs → ${peeled.length} left`);
for (let pass = 2; pass <= 4; pass++) {
  const o = extractBuildingOutline(peeled);
  if (!o) { console.log(`peel pass ${pass - 1}: extract → null`); break; }
  const pbb = bb(o.polygon.map((p) => [p.x, p.y, p.x, p.y]));
  const sb = bb(peeled);
  const cover =
    ((pbb.x1 - pbb.x0) * (pbb.y1 - pbb.y0)) /
    Math.max(1e-6, (sb.x1 - sb.x0) * (sb.y1 - sb.y0));
  console.log(`peel pass ${pass - 1}: outline ${o.polygon.length} corners, covers ${(cover * 100).toFixed(1)}% of remaining bbox`);
  if (o.polygon.length > 4 && cover < 0.85) {
    console.log(`  corners: ${o.polygon.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" ")}`);
    // SVG eyeball: segments + outline
    const W = 1200;
    const S2 = W / (sb.x1 - sb.x0);
    const H = (sb.y1 - sb.y0) * S2;
    const X = (x: number) => (x - sb.x0) * S2;
    const Y = (y: number) => H - (y - sb.y0) * S2; // PDF y-up → SVG y-down
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H.toFixed(0)}" viewBox="0 0 ${W} ${H.toFixed(0)}">`,
      `<rect width="${W}" height="${H.toFixed(0)}" fill="white"/>`,
      ...peeled.map((s) => `<line x1="${X(s[0]).toFixed(1)}" y1="${Y(s[1]).toFixed(1)}" x2="${X(s[2]).toFixed(1)}" y2="${Y(s[3]).toFixed(1)}" stroke="#cbd5e1" stroke-width="1"/>`),
      `<path d="${o.polygon.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ")} Z" fill="rgba(59,130,246,0.15)" stroke="#dc2626" stroke-width="2.5"/>`,
      `</svg>`,
    ].join("");
    writeFileSync("scripts/debug-outline.svg", svg);
    console.log("  wrote scripts/debug-outline.svg");
    break;
  }
  // still frame-like → peel the next enclosing rectangle
  const sb2 = bb(peeled);
  const tol2 = Math.max(sb2.x1 - sb2.x0, sb2.y1 - sb2.y0) * 0.02;
  const near2 = (v: number, lo: number, hi: number) => v - lo < tol2 || hi - v < tol2;
  const onF2 = (s: number[]) => {
    const horiz = Math.abs(s[1] - s[3]) < tol2;
    const vert = Math.abs(s[0] - s[2]) < tol2;
    if (horiz && near2(s[1], sb2.y0, sb2.y1) && near2(s[3], sb2.y0, sb2.y1)) return true;
    if (vert && near2(s[0], sb2.x0, sb2.x1) && near2(s[2], sb2.x0, sb2.x1)) return true;
    return false;
  };
  const nextPeeled = peeled.filter((s) => !onF2(s));
  console.log(`  peel pass ${pass}: dropped ${peeled.length - nextPeeled.length} more`);
  if (nextPeeled.length === peeled.length) break;
  peeled = nextPeeled;
}
