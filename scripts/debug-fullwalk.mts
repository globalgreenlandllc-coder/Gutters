/**
 * debug-fullwalk.mts — EXPERIMENT: fix the three suspected extraction bugs in
 * a scratch copy and see if the real Woodinville footprint emerges:
 *   1. walk the WHOLE operator list (no 8000-segment early stop; inline
 *      min-length filter so glyph strokes don't blow memory)
 *   2. chain-merge collinear strokes (CAD pattern/dash chopping)
 *   3. strip frame-hugging segments, then extractBuildingOutline
 * Run: npx tsx scripts/debug-fullwalk.mts [pageNum]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { extractBuildingOutline } from "../lib/ai/outline-from-vectors.ts";

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m: Mat, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/** segmentsFromOps clone: full walk, inline minLen, big cap. */
function fullWalk(
  ops: { fnArray: number[]; argsArray: unknown[] },
  OPS: Record<string, number>,
  minLen: number,
  cap: number,
): { seg: [number, number, number, number]; w: number | null }[] {
  const num = (x: unknown): x is number => typeof x === "number";
  const STROKE_PAINTS = new Set(
    [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].filter(num),
  );
  const out: { seg: [number, number, number, number]; w: number | null }[] = [];
  const stack: { ctm: Mat; w: number }[] = [];
  let ctm: Mat = IDENTITY;
  let widthUser = 1;
  const push = (x1: number, y1: number, x2: number, y2: number, w: number | null) => {
    if (out.length >= cap) return;
    if (Math.hypot(x2 - x1, y2 - y1) < minLen) return;
    out.push({ seg: [x1, y1, x2, y2], w });
  };
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k];
    if (fn === OPS.save) stack.push({ ctm, w: widthUser });
    else if (fn === OPS.restore) {
      const p = stack.pop();
      if (p) { ctm = p.ctm; widthUser = p.w; } else ctm = IDENTITY;
    } else if (fn === OPS.transform) {
      const a = ops.argsArray[k] as number[] | undefined;
      if (a && a.length >= 6) ctm = mul(ctm, [a[0], a[1], a[2], a[3], a[4], a[5]]);
    } else if (fn === OPS.setLineWidth) {
      const v = (ops.argsArray[k] as number[] | undefined)?.[0];
      if (num(v) && Number.isFinite(v)) widthUser = v;
    } else if (fn === OPS.constructPath) {
      const args = ops.argsArray[k] as unknown[] | undefined;
      const paintOp = args?.[0];
      const subPaths = args?.[1];
      if (!Array.isArray(subPaths)) continue;
      const stroked = num(paintOp) && STROKE_PAINTS.has(paintOp);
      const det = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
      const w = stroked ? (widthUser > 0 ? widthUser : 0.01) * (Math.sqrt(det) || 1) : null;
      for (const raw of subPaths as (ArrayLike<number> | null)[]) {
        if (raw == null) continue;
        const p = Array.from(raw);
        let i = 0; let cx = 0; let cy = 0; let sx = 0; let sy = 0; let have = false;
        while (i < p.length) {
          const op = p[i];
          if (op === 0) { if (i + 2 >= p.length) break; [cx, cy] = apply(ctm, p[i + 1], p[i + 2]); sx = cx; sy = cy; have = true; i += 3; }
          else if (op === 1) { if (i + 2 >= p.length) break; const [nx, ny] = apply(ctm, p[i + 1], p[i + 2]); if (have) push(cx, cy, nx, ny, w); cx = nx; cy = ny; i += 3; }
          else if (op === 2) { if (i + 6 >= p.length) break; [cx, cy] = apply(ctm, p[i + 5], p[i + 6]); i += 7; }
          else if (op === 3) { if (i + 4 >= p.length) break; [cx, cy] = apply(ctm, p[i + 3], p[i + 4]); i += 5; }
          else if (op === 4) { if (have) push(cx, cy, sx, sy, w); cx = sx; cy = sy; i += 1; }
          else break;
        }
      }
    }
  }
  return out;
}

/** Merge collinear axis-aligned segments chained with small gaps. */
function chainMerge(segs: number[][], gapTol: number, offTol: number): number[][] {
  type Run = { lo: number; hi: number };
  const out: number[][] = [];
  const groups = new Map<string, { c: number; runs: Run[] }>(); // key: axis+rounded coord
  const diag: number[][] = [];
  for (const s of segs) {
    const horiz = Math.abs(s[1] - s[3]) <= offTol;
    const vert = Math.abs(s[0] - s[2]) <= offTol;
    if (horiz === vert) { diag.push(s); continue; } // diagonal or degenerate
    const c = horiz ? (s[1] + s[3]) / 2 : (s[0] + s[2]) / 2;
    const key = `${horiz ? "h" : "v"}:${Math.round(c / offTol)}`;
    const lo = horiz ? Math.min(s[0], s[2]) : Math.min(s[1], s[3]);
    const hi = horiz ? Math.max(s[0], s[2]) : Math.max(s[1], s[3]);
    const g = groups.get(key) ?? { c, runs: [] };
    g.runs.push({ lo, hi });
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    const horiz = key.startsWith("h");
    g.runs.sort((a, b) => a.lo - b.lo);
    let cur: Run | null = null;
    const flush = () => {
      if (!cur) return;
      out.push(horiz ? [cur.lo, g.c, cur.hi, g.c] : [g.c, cur.lo, g.c, cur.hi]);
      cur = null;
    };
    for (const r of g.runs) {
      if (cur && r.lo - cur.hi <= gapTol) cur.hi = Math.max(cur.hi, r.hi);
      else { flush(); cur = { ...r }; }
    }
    flush();
  }
  return [...out, ...diag];
}

const PDF = `${process.env.HOME}/Downloads/05.13.26 DA HOMES - WOODINVILLE PLAN SET.pdf`;
const pageNum = Number(process.argv[2] ?? 6);
const bytes = new Uint8Array(readFileSync(PDF));
const pdf = await getDocumentProxy(bytes);
const page = await pdf.getPage(pageNum);
const vp = page.getViewport({ scale: 1 });
const { OPS } = await getResolvedPDFJS();
const opList = await page.getOperatorList();

const raw = fullWalk(opList, OPS, 4, 60000);
console.log(`page ${pageNum}: full-walk segments (≥4pt): ${raw.length}`);
const inDrawing = raw.filter(({ seg }) => {
  const mx = (seg[0] + seg[2]) / 2, my = (seg[1] + seg[3]) / 2;
  return mx > vp.width * 0.05 && mx < vp.width * 0.85 && my > vp.height * 0.03 && my < vp.height * 0.97;
});
console.log(`  in drawing area: ${inDrawing.length}`);
const hist = (ss: { seg: [number, number, number, number] }[] | number[][]) => {
  const buckets = [4, 10, 18, 30, 60, 120, 300, 3000];
  const counts = new Array(buckets.length - 1).fill(0);
  for (const item of ss) {
    const s = Array.isArray(item) ? item : item.seg;
    const len = Math.hypot(s[2] - s[0], s[3] - s[1]);
    for (let i = 0; i < buckets.length - 1; i++)
      if (len >= buckets[i] && len < buckets[i + 1]) { counts[i]++; break; }
  }
  return counts.map((c, i) => `${buckets[i]}–${buckets[i + 1]}:${c}`).join("  ");
};
console.log(`  len hist (drawing): ${hist(inDrawing)}`);

// dedupe then chain-merge
const seen = new Set<string>();
const dd: number[][] = [];
for (const { seg } of raw) {
  const a = [Math.round(seg[0]), Math.round(seg[1])];
  const b = [Math.round(seg[2]), Math.round(seg[3])];
  const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
  const k = `${p[0]},${p[1]},${q[0]},${q[1]}`;
  if (seen.has(k)) continue;
  seen.add(k);
  dd.push([p[0], p[1], q[0], q[1]]);
}
const merged = chainMerge(dd, 6, 1.2);
const mergedLong = merged.filter((s) => Math.hypot(s[2] - s[0], s[3] - s[1]) >= 18);
console.log(`  dedup ${dd.length} → chain-merged ${merged.length} → ≥18pt ${mergedLong.length}`);
console.log(`  len hist (merged ≥18): ${hist(mergedLong)}`);

// frame strip: drop long axis-aligned segs hugging the global bbox
let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
for (const s of mergedLong) {
  x0 = Math.min(x0, s[0], s[2]); y0 = Math.min(y0, s[1], s[3]);
  x1 = Math.max(x1, s[0], s[2]); y1 = Math.max(y1, s[1], s[3]);
}
const tol = Math.max(x1 - x0, y1 - y0) * 0.02;
const nearEdge = (v: number, lo: number, hi: number) => v - lo < tol || hi - v < tol;
const noFrame = mergedLong.filter((s) => {
  const horiz = Math.abs(s[1] - s[3]) < tol;
  const vert = Math.abs(s[0] - s[2]) < tol;
  if (horiz && nearEdge(s[1], y0, y1) && nearEdge(s[3], y0, y1)) return false;
  if (vert && nearEdge(s[0], x0, x1) && nearEdge(s[2], x0, x1)) return false;
  return true;
});
console.log(`  frame strip: ${mergedLong.length} → ${noFrame.length}`);

for (const [label, segs] of [["merged≥18 raw", mergedLong], ["frame-stripped", noFrame]] as const) {
  const o = extractBuildingOutline(segs);
  if (!o) { console.log(`  extract(${label}) → null`); continue; }
  const pxs = o.polygon.map((p) => p.x), pys = o.polygon.map((p) => p.y);
  const cover =
    ((Math.max(...pxs) - Math.min(...pxs)) * (Math.max(...pys) - Math.min(...pys))) /
    Math.max(1, (x1 - x0) * (y1 - y0));
  console.log(`  extract(${label}) → ${o.polygon.length} corners, bbox-cover ${(cover * 100).toFixed(1)}%`);
  if (o.polygon.length > 4 && cover < 0.8) {
    console.log(`    corners: ${o.polygon.map((p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(" ")}`);
  }
}

// SVG eyeball of the frame-stripped set + outline
const o = extractBuildingOutline(noFrame);
const W = 1400, S = W / (x1 - x0), H = (y1 - y0) * S;
const X = (x: number) => (x - x0) * S;
const Y = (y: number) => H - (y - y0) * S;
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H.toFixed(0)}" viewBox="0 0 ${W} ${H.toFixed(0)}">`,
  `<rect width="${W}" height="${H.toFixed(0)}" fill="white"/>`,
  ...noFrame.map((s) => `<line x1="${X(s[0]).toFixed(1)}" y1="${Y(s[1]).toFixed(1)}" x2="${X(s[2]).toFixed(1)}" y2="${Y(s[3]).toFixed(1)}" stroke="#94a3b8" stroke-width="0.7"/>`),
  o ? `<path d="${o.polygon.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ")} Z" fill="rgba(59,130,246,0.12)" stroke="#dc2626" stroke-width="3"/>` : "",
  `</svg>`,
].join("");
writeFileSync(`scripts/debug-fullwalk-p${pageNum}.html`, `<!doctype html><meta charset="utf-8"><body style="margin:0">${svg}</body>`);
console.log(`wrote scripts/debug-fullwalk-p${pageNum}.html`);
