/**
 * Dump the real A9 vector-outline edges with feet + canvas side, so run-3
 * results can be checked edge-by-edge against the sheet.
 * Run: npx tsx scripts/dump-edges.mts
 */
import { readFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import {
  segmentsFromOps,
  selectSegments,
  selectFieldSegments,
} from "../lib/ai/pdf-segments.ts";
import { readRoofFromVectors } from "../lib/ai/roof-from-vectors.ts";
import { outlineEdges } from "../lib/ai/plan-overlay.ts";
import { sideOfPerimeterEdge } from "../lib/ai/plan-orientation.ts";
import { deriveTrussField } from "../lib/ai/truss-field.ts";

const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const PT_PER_FT = 23.27;

const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const { OPS } = await getResolvedPDFJS();
const page = await pdf.getPage(11);
const opList = await page.getOperatorList();
// Raster-convention space (y-down, like the printed sheet) — same as production.
const vpT = page.getViewport({ scale: 1 }).transform as [number, number, number, number, number, number];
const rawSegs = segmentsFromOps(opList, OPS, vpT);
const segs = selectSegments(rawSegs, true);
const roof = readRoofFromVectors([], segs);
if (!roof) throw new Error("no outline");
const outline = roof.perimeter;
const edges = outlineEdges(outline);

const xs = outline.map((p) => p.x);
const ys = outline.map((p) => p.y);
console.log(
  `outline: ${outline.length} corners, span ${((Math.max(...xs) - Math.min(...xs)) / PT_PER_FT).toFixed(1)}ft x ${((Math.max(...ys) - Math.min(...ys)) / PT_PER_FT).toFixed(1)}ft`,
);
const fieldSegs = selectFieldSegments(rawSegs);
console.log(`field segments: ${fieldSegs.length}`);
const field = deriveTrussField({
  outline,
  edges,
  segments: fieldSegs,
  ptPerFt: PT_PER_FT,
});
for (const e of edges) {
  const side = sideOfPerimeterEdge(e.p1, e.p2, outline);
  const v = field.get(e.id);
  console.log(
    `${e.id.padEnd(4)} ${e.axis} ${side?.padEnd(5) ?? "?    "} ` +
      `(${e.p1.x.toFixed(0)},${e.p1.y.toFixed(0)})→(${e.p2.x.toFixed(0)},${e.p2.y.toFixed(0)})  ` +
      `${(e.lenPt / PT_PER_FT).toFixed(1).padStart(5)} ft  ` +
      (v ? `${v.verdict.padEnd(13)} par=${v.par} perp=${v.perp} members` : "—"),
  );
}
