import { readFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { segmentsFromOps, selectSegments } from "../lib/ai/pdf-segments.ts";
import { readRoofFromVectors } from "../lib/ai/roof-from-vectors.ts";
import { outlineEdges } from "../lib/ai/plan-overlay.ts";
import { sideOfPerimeterEdge } from "../lib/ai/plan-orientation.ts";

const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const { OPS } = await getResolvedPDFJS();
const page = await pdf.getPage(11);
const opList = await page.getOperatorList();
const vpT = page.getViewport({ scale: 1 }).transform as never;
const segs = selectSegments(segmentsFromOps(opList, OPS, vpT), true);
const outline = readRoofFromVectors([], segs)!.perimeter;
const edges = outlineEdges(outline);
// front side, viewer left→right: rd=(1,0) per Woodinville orientation (north normal +y)
const front = edges.filter((e) => e.lenPt > 1e-6 && sideOfPerimeterEdge(e.p1, e.p2, outline) === process.env.SIDE);
let lo = Infinity, hi = -Infinity;
for (const e of front) { lo = Math.min(lo, e.p1.y, e.p2.y); hi = Math.max(hi, e.p1.y, e.p2.y); }
for (const e of front) {
  const u0 = (Math.min(e.p1.y, e.p2.y) - lo) / (hi - lo);
  const u1 = (Math.max(e.p1.y, e.p2.y) - lo) / (hi - lo);
  console.log(`${e.id}: u ${u0.toFixed(3)}–${u1.toFixed(3)} (${(e.lenPt / 23.27).toFixed(1)} ft)`);
}
