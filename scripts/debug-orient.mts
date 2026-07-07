import { readFileSync } from "node:fs";
import { getDocumentProxy } from "unpdf";
import { deriveOrientation } from "../lib/ai/plan-orientation.ts";
const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const pdf = await getDocumentProxy(new Uint8Array(readFileSync(PDF)));
const texts: { page: number; text: string }[] = [];
for (let p = 1; p <= Math.min(pdf.numPages, 30); p++) {
  const page = await pdf.getPage(p);
  const content = await page.getTextContent();
  texts.push({ page: p, text: (content.items as Array<{ str?: string }>).map((i) => i.str ?? "").join(" ") });
}
const hits = texts.filter(t => /ELEV/i.test(t.text)).map(t => t.page);
console.log("pages mentioning ELEV:", hits.join(","));
const o = deriveOrientation(texts);
console.log(o ? JSON.stringify({ rot: o.rotationQuarterTurns, pairs: o.pairs, north: o.normals.north, west: o.normals.west }) : "null — no orientation derived");
if (o) console.log(o.note);
