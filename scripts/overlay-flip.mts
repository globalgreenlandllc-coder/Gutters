/** Overlay the vector outline on the rasterized A9 — raw y vs flipped y. */
import { readFileSync, writeFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import sharp from "sharp";
import {
  segmentsFromOps,
  selectSegments,
} from "../lib/ai/pdf-segments.ts";
import { readRoofFromVectors } from "../lib/ai/roof-from-vectors.ts";
import { outlineEdges } from "../lib/ai/plan-overlay.ts";

const SCRATCH =
  "/private/tmp/claude-501/-Users-dmitriyapetenok-Documents-gutters-project/5eca9025-5e4d-4ef2-ab4b-aa2b263cd373/scratchpad";
const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const { OPS } = await getResolvedPDFJS();
const page = await pdf.getPage(11);
const vp = page.getViewport({ scale: 1 });
console.log(`page ${vp.width}x${vp.height}pt`);
const opList = await page.getOperatorList();
const segs = selectSegments(segmentsFromOps(opList, OPS), true);
const roof = readRoofFromVectors([], segs);
if (!roof) throw new Error("no outline");
const outline = roof.perimeter;
const edges = outlineEdges(outline);

const raster = sharp(`${SCRATCH}/a9-11.png`);
const meta = await raster.metadata();
console.log(`raster ${meta.width}x${meta.height}px`);
const sx = (meta.width ?? vp.width) / vp.width;
const sy = (meta.height ?? vp.height) / vp.height;

for (const flip of [false, true]) {
  const Y = (y: number) => (flip ? (vp.height - y) * sy : y * sy).toFixed(1);
  const X = (x: number) => (x * sx).toFixed(1);
  const ring = outline
    .map((p, i) => `${i ? "L" : "M"}${X(p.x)},${Y(p.y)}`)
    .join(" ");
  const chips = edges
    .map(
      (e) =>
        `<text x="${X(e.mid.x)}" y="${Y(e.mid.y)}" font-family="Helvetica" font-size="26" font-weight="bold" fill="#dc2626">${e.id}</text>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}"><path d="${ring} Z" fill="none" stroke="#2563eb" stroke-width="5"/>${chips}</svg>`;
  const out = await sharp(`${SCRATCH}/a9-11.png`)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
  writeFileSync(`${SCRATCH}/overlay-${flip ? "flipped" : "raw"}.png`, out);
  console.log(`wrote overlay-${flip ? "flipped" : "raw"}.png`);
}
