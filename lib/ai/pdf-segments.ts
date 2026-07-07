/**
 * Pure operator-list → line-segment logic for the PDF vector extractor, split
 * out of pdf-vectors.ts (which is `server-only` + pulls `unpdf`) so it can be
 * node-tested directly — same pattern as roof-skeleton.ts / outline-from-vectors.ts.
 *
 * The win this adds over a plain segment dump: STROKE WEIGHT. On a dense roof
 * FRAMING sheet the roof we want (outline + ridge/hip/valley) is drawn HEAVY,
 * while the noise (truss members, dimension lines, hatching) is drawn THIN.
 * We track each segment's device-space line width and can keep only the bold
 * structural lines — "read the roof that's already drawn" instead of eyeballing
 * it. Every width gate falls back to the length-only result, so width can only
 * SUBTRACT noise, never make the output worse.
 */

export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
export const apply = (m: Mat, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/** One straight segment in page user space plus its device-space stroke
 *  weight. `w` is null for fill-only paths (no meaningful stroke weight) and
 *  for any path whose paint op we couldn't resolve. */
export type WSeg = { seg: [number, number, number, number]; w: number | null };

const MIN_SEG_LEN = 18; // points — drops dimension ticks / hatching
const MAX_SEGMENTS = 300;

// Walk-time guards. CAD exports draw text as thousands of tiny glyph strokes
// (and the frame/title block FIRST in stream order) — a small emit cap starves
// the walk before it ever reaches the drawing (the Woodinville A4 bug: exactly
// ~8300 segments on every sheet = the old cap's fingerprint, drawing area
// empty). Skip sub-glyph strokes inline instead, and keep a high cap purely as
// a memory backstop.
const WALK_MIN_LEN = 4; // points — glyph strokes / dots, never wall pieces
const WALK_CAP = 60000;

const HAIRLINE_USER = 0.01; // pt — below any real drawn weight (pdfjs width 0)
/** Device-space stroke weight = user lineWidth × the CTM's isotropic 2D scale
 *  (geometric mean of its singular values = sqrt|det|): one scalar, robust to
 *  shear/anisotropy (won't collapse to zero like an axis-only scale), which is
 *  fine for the near-uniform CTMs in architectural plans. */
const deviceWidth = (userWidth: number, ctm: Mat): number => {
  const w = userWidth > 0 ? userWidth : HAIRLINE_USER;
  const det = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
  const scale = Math.sqrt(det) || 1; // degenerate CTM → no scaling
  return w * scale;
};

/**
 * Walk a pdfjs operator list and recover straight LINE segments in page user
 * space, each tagged with its device-space stroke width (null when the path is
 * filled, not stroked — width is meaningless there).
 *
 * Verified against the RUNNING engine (unpdf's bundled pdfjs v5): `constructPath`
 * args are `[paintOp, subPaths, minMax]` — the PAINT op is FUSED at `[0]` (v5
 * no longer emits a separate following stroke/fill op), and `subPaths` at `[1]`
 * is an array of flat `[op, x, y, …]` coord streams with sub-ops
 * 0=moveTo, 1=lineTo, 2=cubic-curve, 3=quad-curve, 4=closePath. Curves are
 * skipped to their endpoint (kept connected, not emitted as a chord — they're
 * never roof structure). lineWidth is graphics-state: tracked via setLineWidth
 * / ExtGState `LW`, saved/restored with the CTM.
 */
export function segmentsFromOps(
  ops: { fnArray: number[]; argsArray: unknown[] },
  OPS: Record<string, number>,
): WSeg[] {
  const num = (x: unknown): x is number => typeof x === "number";
  // Paint ops that draw a stroked edge → width meaningful. Built from the live
  // OPS object (robust to a future pdfjs renumber — no hard-coded codes).
  const STROKE_PAINTS = new Set(
    [
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke,
    ].filter(num),
  );

  const out: WSeg[] = [];
  const stack: { ctm: Mat; w: number }[] = [];
  let ctm: Mat = IDENTITY;
  let widthUser = 1; // pdfjs initial graphics-state lineWidth
  const emit = (x1: number, y1: number, x2: number, y2: number, w: number | null) => {
    if (Math.hypot(x2 - x1, y2 - y1) < WALK_MIN_LEN) return; // glyph stroke
    out.push({ seg: [x1, y1, x2, y2], w });
  };

  for (let k = 0; k < ops.fnArray.length && out.length < WALK_CAP; k++) {
    const fn = ops.fnArray[k];
    if (fn === OPS.save) {
      stack.push({ ctm, w: widthUser });
    } else if (fn === OPS.restore) {
      const popped = stack.pop();
      if (popped) {
        ctm = popped.ctm;
        widthUser = popped.w;
      } else {
        ctm = IDENTITY;
      }
    } else if (fn === OPS.transform) {
      const a = ops.argsArray[k] as number[] | undefined;
      if (a && a.length >= 6) {
        ctm = mul(ctm, [a[0], a[1], a[2], a[3], a[4], a[5]]);
      }
    } else if (fn === OPS.setLineWidth) {
      const v = (ops.argsArray[k] as number[] | undefined)?.[0];
      if (num(v) && Number.isFinite(v)) widthUser = v;
    } else if (fn === OPS.setGState) {
      // Width can also arrive via an ExtGState: argsArray[k] = [ [[key,val],…] ]
      const entries = (ops.argsArray[k] as unknown[] | undefined)?.[0];
      if (Array.isArray(entries)) {
        for (const pair of entries as unknown[]) {
          if (Array.isArray(pair) && pair[0] === "LW" && num(pair[1]))
            widthUser = pair[1];
        }
      }
    } else if (fn === OPS.constructPath) {
      const args = ops.argsArray[k] as unknown[] | undefined;
      const paintOp = args?.[0];
      const subPaths = args?.[1];
      if (!Array.isArray(subPaths)) continue;
      // Width is meaningful only for stroked paths; filled paths → null (the
      // segment is still emitted so the footprint outline survives even when
      // a plan draws it as a fill).
      const stroked = num(paintOp) && STROKE_PAINTS.has(paintOp);
      const w = stroked ? deviceWidth(widthUser, ctm) : null;
      for (const raw of subPaths as (ArrayLike<number> | null)[]) {
        if (raw == null) continue; // v5 emits [null] for an empty path
        const p = Array.from(raw);
        let i = 0;
        let cx = 0;
        let cy = 0;
        let sx = 0;
        let sy = 0;
        let have = false;
        while (i < p.length) {
          const op = p[i];
          if (op === 0) {
            // moveTo
            if (i + 2 >= p.length) break;
            [cx, cy] = apply(ctm, p[i + 1], p[i + 2]);
            sx = cx;
            sy = cy;
            have = true;
            i += 3;
          } else if (op === 1) {
            // lineTo
            if (i + 2 >= p.length) break;
            const [nx, ny] = apply(ctm, p[i + 1], p[i + 2]);
            if (have) emit(cx, cy, nx, ny, w);
            cx = nx;
            cy = ny;
            i += 3;
          } else if (op === 2) {
            // cubic curveTo (6 coords) — skip to endpoint, don't emit a chord
            if (i + 6 >= p.length) break;
            [cx, cy] = apply(ctm, p[i + 5], p[i + 6]);
            i += 7;
          } else if (op === 3) {
            // quadratic curveTo (4 coords) — skip to endpoint
            if (i + 4 >= p.length) break;
            [cx, cy] = apply(ctm, p[i + 3], p[i + 4]);
            i += 5;
          } else if (op === 4) {
            // closePath
            if (have) emit(cx, cy, sx, sy, w);
            cx = sx;
            cy = sy;
            i += 1;
          } else {
            break;
          }
        }
      }
    }
  }
  return out;
}

type KeptSeg = { seg: number[]; len: number; w: number | null };

// Chain-merge tuning. CAD exports draw one wall as a CHAIN of short collinear
// strokes (line patterns / plotter dashes) — on the Woodinville A4 the walls
// are 10–18pt pieces, ALL below MIN_SEG_LEN, so without merging the "footprint
// segments" are just the sheet frame + dimension lines. Merging runs first so
// a chained wall reads as one long segment.
const CHAIN_GAP = 6; // points — max gap between chained strokes (door gaps stay open)
const CHAIN_OFF = 1.2; // points — max off-axis wobble to treat strokes as collinear

/**
 * Stage 0: merge collinear AXIS-ALIGNED strokes chained with ≤CHAIN_GAP gaps
 * into single long segments (interval union per shared axis line, so exact
 * duplicates coalesce too). Diagonals pass through untouched — hips/ridges on
 * roof sheets are drawn solid, and diagonal hatching must not merge into fake
 * long lines. Width of a merged run = max of its pieces (a wall's pattern
 * pieces share a weight; max keeps it eligible for the bold stage).
 */
export function mergeCollinearStrokes(raw: WSeg[]): WSeg[] {
  type Run = { lo: number; hi: number; w: number | null };
  const groups = new Map<string, { c: number; runs: Run[] }>();
  const out: WSeg[] = [];
  for (const { seg, w } of raw) {
    const horiz = Math.abs(seg[1] - seg[3]) <= CHAIN_OFF;
    const vert = Math.abs(seg[0] - seg[2]) <= CHAIN_OFF;
    if (horiz === vert) {
      out.push({ seg, w }); // diagonal (or degenerate) — pass through
      continue;
    }
    const c = horiz ? (seg[1] + seg[3]) / 2 : (seg[0] + seg[2]) / 2;
    const key = `${horiz ? "h" : "v"}:${Math.round(c / CHAIN_OFF)}`;
    const lo = horiz ? Math.min(seg[0], seg[2]) : Math.min(seg[1], seg[3]);
    const hi = horiz ? Math.max(seg[0], seg[2]) : Math.max(seg[1], seg[3]);
    const g = groups.get(key) ?? { c, runs: [] };
    g.runs.push({ lo, hi, w });
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    const horiz = key.startsWith("h");
    g.runs.sort((a, b) => a.lo - b.lo);
    let cur: Run | null = null;
    const flush = () => {
      if (!cur) return;
      out.push({
        seg: horiz ? [cur.lo, g.c, cur.hi, g.c] : [g.c, cur.lo, g.c, cur.hi],
        w: cur.w,
      });
      cur = null;
    };
    for (const r of g.runs) {
      if (cur && r.lo - cur.hi <= CHAIN_GAP) {
        cur.hi = Math.max(cur.hi, r.hi);
        if (r.w != null && (cur.w == null || r.w > cur.w)) cur.w = r.w;
      } else {
        flush();
        cur = { lo: r.lo, hi: r.hi, w: r.w };
      }
    }
    flush();
  }
  return out;
}

/** Stage 1: length / orientation filter + undirected dedupe, preserving each
 *  segment's device width for the optional bold stage. */
function lengthFilter(raw: WSeg[]): KeptSeg[] {
  const seen = new Set<string>();
  const kept: KeptSeg[] = [];
  for (const { seg, w } of raw) {
    const [x1, y1, x2, y2] = seg;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < MIN_SEG_LEN) continue;
    const axisAligned = Math.abs(dx) < 1.5 || Math.abs(dy) < 1.5;
    if (!axisAligned && len < 60) continue; // short diagonals are noise
    const a = [Math.round(x1), Math.round(y1)];
    const b = [Math.round(x2), Math.round(y2)];
    const [p, q] =
      a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
    const key = `${p[0]},${p[1]},${q[0]},${q[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ seg: [p[0], p[1], q[0], q[1]], len, w });
  }
  return kept;
}

// Bold-filter tuning. Every gate falls back to the length-only set, so the
// width signal can only subtract truss/dim noise — never make output worse.
const MIN_BIMODAL = 1.6; // min bold/thin width ratio to call a plan bimodal
const MIN_BOLD_COUNT = 4; // reject a split that keeps almost nothing
const BOLD_LEN_FLOOR = 0.08; // bold tier must be ≥8% of kept length
const BOLD_LEN_CEIL = 0.92; // …and ≤92% (else it kept "everything")
const WIDTH_COVERAGE = 0.5; // ≥50% of kept segs must have a measured width
const BOLD_MED_FLOOR_PT = 0.3; // distrust a "bold" tier thinner than this

/** Stage 2 (roof/framing sheet only): keep only the BOLD strokes — the roof
 *  outline + ridge/hip/valley — and drop thin truss/dimension/hatch lines.
 *  Returns the input UNCHANGED on any gate that can't trust the width signal,
 *  so it is strictly a noise-subtractor over the length filter. */
export function boldFilter(kept: KeptSeg[]): KeptSeg[] {
  // GATE A — is width a usable signal at all?
  const measured = kept.filter(
    (s): s is { seg: number[]; len: number; w: number } =>
      s.w != null && s.w > 0,
  );
  if (measured.length < WIDTH_COVERAGE * kept.length) return kept;

  // Length-weighted distinct widths (round so quantized weights merge).
  const lenByWidth = new Map<number, number>();
  for (const s of measured) {
    const wq = Math.round(s.w * 100) / 100;
    lenByWidth.set(wq, (lenByWidth.get(wq) ?? 0) + s.len);
  }
  const distinct = [...lenByWidth.keys()].sort((m, n) => m - n);
  if (distinct.length < 2) return kept;
  const totalLen = kept.reduce((a, s) => a + s.len, 0);
  if (totalLen <= 0) return kept;

  // Among adjacent-width gaps with ratio ≥ MIN_BIMODAL, pick the cut that
  // yields the LONGEST passing bold tier. Roof structure (outline + ridge /
  // hip / valley) is LONG and may span more than one weight; truss /
  // dimension noise is short. Maximizing bold LENGTH separates noise from ALL
  // structure and never splits the outline off the ridges — the failure mode
  // of a plain "largest relative gap" cut (which, with truss 0.25 / outline
  // 0.5 / ridge 1.5, cuts 0.5↔1.5 and drops the whole outline). Conservative
  // by design: when no clean split exists it returns the length-only set, so
  // it can only subtract noise, never drop the footprint-bearing outline.
  let best: { bold: typeof measured; boldLen: number } | null = null;
  for (let i = 1; i < distinct.length; i++) {
    if (distinct[i] / distinct[i - 1] < MIN_BIMODAL) continue;
    const cut = Math.sqrt(distinct[i] * distinct[i - 1]); // geometric midpoint
    const bold = measured.filter((s) => s.w >= cut);
    if (bold.length < MIN_BOLD_COUNT) continue;
    const boldLen = bold.reduce((a, s) => a + s.len, 0);
    // GATE C — never keep almost nothing, never keep ~everything.
    if (boldLen < BOLD_LEN_FLOOR * totalLen) continue;
    if (boldLen > BOLD_LEN_CEIL * totalLen) continue;
    if (best === null || boldLen > best.boldLen) best = { bold, boldLen };
  }
  if (best === null) return kept; // no clean split → length-only

  // Loose absolute sanity floor: reject an implausibly-hairline "bold" tier.
  const sorted = best.bold.map((s) => s.w).sort((m, n) => m - n);
  if (sorted[Math.floor(sorted.length / 2)] < BOLD_MED_FLOOR_PT) return kept;

  return best.bold;
}

/** Public driver: chain-merge → length filter → (optional) bold filter →
 *  longest-first → cap → bare `number[]` coords. Always returns number[][]
 *  like before. */
export function selectSegments(raw: WSeg[], boldOnly: boolean): number[][] {
  const s0 = mergeCollinearStrokes(raw);
  const s1 = lengthFilter(s0);
  const s2 = boldOnly ? boldFilter(s1) : s1;
  s2.sort((m, n) => n.len - m.len);
  return s2.slice(0, MAX_SEGMENTS).map((k) => k.seg);
}
