/**
 * debug-roofread.mts — run the A9 roof-framing sheet (page 11) through the
 * PRODUCTION path: extractPdfPageText-equivalent (boldOnly) → readRoofFromVectors,
 * exactly like estimate.ts does. Shows whether the single-sheet roof read now
 * activates with the fixed segment walk.
 * Run: npx tsx scripts/debug-roofread.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { segmentsFromOps, selectSegments } from "../lib/ai/pdf-segments.ts";
import { readRoofFromVectors } from "../lib/ai/roof-from-vectors.ts";

const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const pageNum = Number(process.argv[2] ?? 11);
const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const page = await pdf.getPage(pageNum);
const { OPS } = await getResolvedPDFJS();
const opList = await page.getOperatorList();
const segs = selectSegments(segmentsFromOps(opList, OPS), true); // boldOnly like the roof sheet
console.log(`page ${pageNum}: bold segments ${segs.length}`);

const content = await page.getTextContent();
const labels: { s: string; x: number; y: number }[] = [];
for (const raw of content.items as Array<{ str?: string; transform?: number[] }>) {
  const s = (raw.str ?? "").trim();
  if (!s || s.length > 24 || !/[A-Za-z0-9]/.test(s)) continue;
  const tx = raw.transform ?? [];
  labels.push({ s, x: Math.round(Number(tx[4]) || 0), y: Math.round(Number(tx[5]) || 0) });
}
console.log(`labels: ${labels.length} (${labels.filter((l) => /gable/i.test(l.s)).length} GABLE)`);

// expectedAspect from the A4 footprint we now recover (~1439/1441 ≈ 1.0)
const roof = readRoofFromVectors(labels, segs, { expectedAspect: 1.0 });
if (!roof) {
  console.log("readRoofFromVectors → REJECTED (gates)");
} else {
  console.log(`perimeter: ${roof.perimeter.length} corners; gableFlags: ${roof.gableFlags.filter(Boolean).length} gable edge(s)`);
  console.log(`  corners: ${roof.perimeter.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" ")}`);
  // eyeball SVG
  const xs = segs.flatMap((s) => [s[0], s[2]]);
  const ys = segs.flatMap((s) => [s[1], s[3]]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const W = 1300, S = W / (x1 - x0), H = (y1 - y0) * S;
  const X = (x: number) => (x - x0) * S;
  const Y = (y: number) => H - (y - y0) * S;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H.toFixed(0)}" viewBox="0 0 ${W} ${H.toFixed(0)}">`,
    `<rect width="${W}" height="${H.toFixed(0)}" fill="white"/>`,
    ...segs.map((s) => `<line x1="${X(s[0]).toFixed(1)}" y1="${Y(s[1]).toFixed(1)}" x2="${X(s[2]).toFixed(1)}" y2="${Y(s[3]).toFixed(1)}" stroke="#94a3b8" stroke-width="0.8"/>`),
    `<path d="${roof.perimeter.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ")} Z" fill="rgba(59,130,246,0.12)" stroke="#dc2626" stroke-width="3"/>`,
    `</svg>`,
  ].join("");
  writeFileSync(`scripts/debug-roofread-p${pageNum}.html`, `<!doctype html><meta charset="utf-8"><body style="margin:0">${svg}</body>`);
  console.log(`wrote scripts/debug-roofread-p${pageNum}.html`);
}
