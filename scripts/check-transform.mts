/** Which transform maps extracted segment coords onto the rendered raster?
 *  Score ink coverage along segments under candidate transforms. */
import { readFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import sharp from "sharp";
import { segmentsFromOps, selectSegments } from "../lib/ai/pdf-segments.ts";

const SCRATCH =
  "/private/tmp/claude-501/-Users-dmitriyapetenok-Documents-gutters-project/5eca9025-5e4d-4ef2-ab4b-aa2b263cd373/scratchpad";
const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const { OPS } = await getResolvedPDFJS();
const page = await pdf.getPage(11);
const vp = page.getViewport({ scale: 1 });
console.log("page.view (cropbox):", (page as unknown as { view: number[] }).view);
console.log("viewport.transform:", vp.transform);
console.log(`viewport ${vp.width}x${vp.height}`);

const opList = await page.getOperatorList();
const segs = selectSegments(segmentsFromOps(opList, OPS), false).slice(0, 250);

const img = sharp(`${SCRATCH}/a9-11.png`).greyscale();
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;
const dark = (x: number, y: number): number => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return 0;
  return 255 - data[yi * W + xi];
};

type Xf = { name: string; fn: (x: number, y: number) => [number, number] };
const t = vp.transform as number[];
const candidates: Xf[] = [
  { name: "raw (x,y)", fn: (x, y) => [x, y] },
  { name: "flip-y (x, H-y)", fn: (x, y) => [x, H - y] },
  {
    name: "viewport.transform",
    fn: (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]],
  },
];
for (const c of candidates) {
  let sum = 0;
  let n = 0;
  for (const s of segs) {
    for (let k = 0; k <= 20; k++) {
      const x = s[0] + ((s[2] - s[0]) * k) / 20;
      const y = s[1] + ((s[3] - s[1]) * k) / 20;
      const [rx, ry] = c.fn(x, y);
      sum += dark(rx, ry);
      n++;
    }
  }
  console.log(`${c.name.padEnd(22)} ink=${(sum / n).toFixed(1)} /255`);
}
