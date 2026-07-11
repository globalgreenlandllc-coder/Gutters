/**
 * Render the thin FIELD segments (truss/jack linework) over the A9 outline,
 * colored by orientation, with edge ids — to eyeball what the truss-field
 * arbiter is actually reading. Run: npx tsx scripts/render-field.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import sharp from "sharp";
import {
  segmentsFromOps,
  selectFieldSegments,
} from "../lib/ai/pdf-segments.ts";
import { readRoofFromVectors } from "../lib/ai/roof-from-vectors.ts";
import { outlineEdges } from "../lib/ai/plan-overlay.ts";

const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const { OPS } = await getResolvedPDFJS();
const page = await pdf.getPage(11);
const opList = await page.getOperatorList();
const raw = segmentsFromOps(opList, OPS);
const field = selectFieldSegments(raw);
const { selectSegments } = await import("../lib/ai/pdf-segments.ts");
const roof = readRoofFromVectors([], selectSegments(raw, true));
if (!roof) throw new Error("no outline");
const outline = roof.perimeter;
const edges = outlineEdges(outline);

const xs = outline.map((p) => p.x);
const ys = outline.map((p) => p.y);
const minX = Math.min(...xs) - 80;
const maxX = Math.max(...xs) + 80;
const minY = Math.min(...ys) - 80;
const maxY = Math.max(...ys) + 80;
const S = 1800 / (maxX - minX);
const W = Math.round((maxX - minX) * S);
const H = Math.round((maxY - minY) * S);
const X = (x: number) => ((x - minX) * S).toFixed(1);
const Y = (y: number) => ((y - minY) * S).toFixed(1);

const PT_PER_FT = 23.27;
const parts: string[] = [`<rect width="${W}" height="${H}" fill="#fff"/>`];
for (const s of field) {
  const dx = Math.abs(s[2] - s[0]);
  const dy = Math.abs(s[3] - s[1]);
  const long = Math.max(dx, dy) >= 8 * PT_PER_FT;
  const color = dx >= dy ? (long ? "#dc2626" : "#fca5a5") : long ? "#2563eb" : "#93c5fd";
  parts.push(
    `<line x1="${X(s[0])}" y1="${Y(s[1])}" x2="${X(s[2])}" y2="${Y(s[3])}" stroke="${color}" stroke-width="${long ? 2 : 1}"/>`,
  );
}
const ring = outline.map((p, i) => `${i ? "L" : "M"}${X(p.x)},${Y(p.y)}`).join(" ");
parts.push(`<path d="${ring} Z" fill="none" stroke="#111827" stroke-width="4"/>`);
for (const e of edges) {
  parts.push(
    `<text x="${X(e.mid.x)}" y="${Y(e.mid.y)}" font-family="Helvetica" font-size="30" font-weight="bold" fill="#059669">${e.id}</text>`,
  );
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
writeFileSync("scripts/field.svg", svg);
writeFileSync("scripts/field.png", await sharp(Buffer.from(svg)).png().toBuffer());
console.log(`wrote scripts/field.png (${W}x${H}), ${field.length} field segs`);
