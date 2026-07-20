import { rectifyPlanFootprint, type RPt } from "./rectify-plan-takeoff";
import { polygonCloses } from "../roof-engine";

/**
 * raster-outline.ts — RASTER roof-outline extraction for SCANNED plan sets.
 *
 * On a scanned / flattened PDF ("FOR PRICING PURPOSES ONLY" exports) every
 * page is one embedded image and the vector engine can't run, so the
 * footprint is a best-of VISION trace — which rolls different shape defects
 * every analysis (undersized/too-square outlines, double-wide patio bands,
 * flattened garage jogs). But the roof-plan page's PRINTED INK **is** the
 * true outline. This module pulls the page's embedded scan (unpdf
 * `extractImages`), thresholds it to binary ink, drops the sheet
 * frame/titleblock, traces the outer contour of the largest remaining ink
 * component (the roof outline), squares it, and gates the result hard.
 * Deterministic — NO new vision calls.
 *
 * MODULE SHAPE (mirrors read-roof-layout.ts): everything except the PDF
 * access is PURE and lives at module top level with no server-only imports,
 * so the tracer / gates / consume-step run under `node --test` on synthetic
 * bitmaps. The unpdf access is a small dynamic-import wrapper
 * (`extractRoofPlanBitmap`) that only executes in a server context.
 *
 * DOCTRINE: strong quality gates; when they fail, behavior is byte-identical
 * (the vision trace stands untouched) with a loud reason trail. When they
 * pass, ONLY the geometry/shape changes — every run keeps its AI-read
 * `length_ft`, so the priced LF is unchanged by construction.
 */

// ─── types ───────────────────────────────────────────────────────────────────

export type RasterBitmap = {
  /** Raw pixel bytes, row-major, `channels` bytes per pixel. */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
};

export type RasterOutlineQuality = {
  corners: number;
  /** Axis-aligned perimeter fraction of the FINAL ring (1 = rectilinear). */
  axisFrac: number;
  /** Non-self-intersecting. */
  closes: boolean;
  /** Ink cells in the winning component (downsampled grid cells). */
  componentCells: number;
  downsampleStride: number;
  /** Whether rectifyPlanFootprint's squaring applied (vs its gates bailing). */
  squared: boolean;
  bitmapW: number;
  bitmapH: number;
};

export type RasterOutlineTrace = {
  /** The traced outer contour, simplified + squared, in ORIGINAL bitmap px. */
  ring: RPt[];
  axisFrac: number;
  closes: boolean;
  /** Ring area in original-bitmap px². */
  areaPx: number;
  bboxPx: { x0: number; y0: number; x1: number; y1: number };
  downsampleStride: number;
  quality: RasterOutlineQuality;
};

export type RasterGate = {
  ok: boolean;
  /** Solved scale (feet per original-bitmap pixel); null when ungateable. */
  ftPerPx: number | null;
  /** Every gate that ruled, in plain words. Empty when ok. */
  reasons: string[];
};

/** What the analysis routes stash verbatim under `analysisJson._rasterOutline`.
 *  JSON-small by contract: the ring only (never the bitmap), and the ring only
 *  when the gates passed. */
export type RasterOutlineStash = {
  ok: boolean;
  /** 1-based roof-plan page the bitmap came from. */
  page: number | null;
  /** Ring in ORIGINAL bitmap px — present only when ok. */
  ring?: RPt[];
  /** Feet per original-bitmap pixel — present only when ok. */
  ftPerPx?: number | null;
  quality?: RasterOutlineQuality | null;
  reasons: string[];
};

export type TraceRasterOpts = {
  /** Grayscale ink threshold — block averages BELOW this are ink. The
   *  Mascord-style light-gray watermark (~200) must threshold away, so keep
   *  this comfortably under it. Default 128. */
  threshold?: number;
  /** Target max grid width after integer-stride downsampling. Default 1400. */
  maxWidth?: number;
  /** Outer band (fraction of each grid dimension) — any ink component with a
   *  cell in the band is sheet frame / titleblock and is ignored. Default 0.025. */
  borderBandFrac?: number;
  /** Douglas-Peucker tolerance as a fraction of the contour span. Default 0.006. */
  simplifyTolFrac?: number;
};

// ─── small pure geometry helpers ─────────────────────────────────────────────

const isFinitePt = (p: RPt | null | undefined): p is RPt =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

function ringArea(pts: readonly RPt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function ringBBox(pts: readonly RPt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

function nearestOnSeg(p: RPt, a: RPt, b: RPt): { pt: RPt; d2: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const pt = { x: a.x + t * dx, y: a.y + t * dy };
  const ex = p.x - pt.x;
  const ey = p.y - pt.y;
  return { pt, d2: ex * ex + ey * ey };
}

/** Nearest point ON the closed ring to p — the follower snap primitive. */
export function nearestOnRing(ring: readonly RPt[], p: RPt): RPt {
  let best: RPt = { x: p.x, y: p.y };
  let bestD2 = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const { pt, d2 } = nearestOnSeg(p, a, b);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = pt;
    }
  }
  return best;
}

/** Fraction of the perimeter running within `tolDeg` of the PAGE axes (raw
 *  frame, no dominant-angle rotation). A plan sheet is drawn square to the
 *  page, so this — not the ring's own dominant frame — is the meaningful
 *  rectilinearity test: a 45°-rotated diamond must fail it even though it is
 *  rectilinear in its own frame. */
export function pageAxisAlignedFraction(pts: readonly RPt[], tolDeg = 12): number {
  const AX = Math.tan((tolDeg * Math.PI) / 180);
  let axisLen = 0;
  let totalLen = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const len = Math.hypot(dx, dy);
    totalLen += len;
    if (dy <= dx * AX || dx <= dy * AX) axisLen += len;
  }
  return totalLen > 0 ? axisLen / totalLen : 0;
}

/** Perpendicular distance from p to the infinite line a→b (0 if degenerate). */
function perpDist(p: RPt, a: RPt, b: RPt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Iterative Douglas-Peucker on an OPEN chain (endpoints kept). */
function dpChain(chain: RPt[], tol: number): RPt[] {
  if (chain.length <= 2) return chain.slice();
  const keep = new Uint8Array(chain.length);
  keep[0] = 1;
  keep[chain.length - 1] = 1;
  const stack: [number, number][] = [[0, chain.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    let worst = -1;
    let worstD = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(chain[i], chain[lo], chain[hi]);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worstD > tol && worst > 0) {
      keep[worst] = 1;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  const out: RPt[] = [];
  for (let i = 0; i < chain.length; i++) if (keep[i]) out.push(chain[i]);
  return out;
}

/** `ring` with the `len` vertices starting at circular index `start` removed
 *  (order-preserving; handles wraparound past the end of the array). */
function removeCircularWindow(ring: RPt[], start: number, len: number): RPt[] {
  const n = ring.length;
  const drop = new Set<number>();
  for (let k = 0; k < len; k++) drop.add((start + k) % n);
  const out: RPt[] = [];
  for (let i = 0; i < n; i++) if (!drop.has(i)) out.push(ring[i]);
  return out;
}

/**
 * Remove hairpin "there-and-back" excursions from a simplified closed ring.
 *
 * The Moore-neighbor tracer follows the OUTER boundary of the whole ink
 * component the roof outline belongs to — including anything connected to
 * it that isn't the outline: a downspout leader arrow, a callout line, a
 * dimension extension with one end free in open space. A true bridge (both
 * ends already on the loop, e.g. a ridge line spanning two walls) never
 * shows up in the outer trace at all, but a DANGLING appendage with one free
 * end makes the tracer walk out along it and back almost the same way. A
 * stroke has width, so the tip usually surfaces as TWO close vertices (one
 * per side of the line) rather than one exact reversal point — checked here
 * as a sliding window of 1-3 vertices whose entry/exit edges reverse past
 * `cosThresh`.
 *
 * A real narrow roof return (a hip tier's inner leg, a shallow notch) ALSO
 * turns back on itself this sharply, so angle alone can't tell them apart —
 * the discriminator is WIDTH: an ink artifact's "across" span (the distance
 * actually spanned inside the window) is stroke-thin, while a real return's
 * width is architectural (feet, not sub-pixel). Gated on
 * `internal length <= widthFrac × min(depth in, depth out)`: only a window
 * that's thin relative to how far it reaches is treated as noise. Iterated
 * to convergence: a multi-segment dangle collapses one window per pass.
 */
function removeHairpinSpikes(pts: RPt[], cosThresh = -0.9, widthFrac = 0.2): RPt[] {
  let ring = pts.slice();
  for (let guard = 0; guard < pts.length * 4 + 8; guard++) {
    const n = ring.length;
    if (n <= 4) break;
    let removed = false;
    for (let L = 1; L <= Math.min(3, n - 4) && !removed; L++) {
      for (let i = 0; i < n; i++) {
        const prev = ring[(i - 1 + n) % n];
        const windowStart = ring[i];
        const windowEnd = ring[(i + L - 1) % n];
        const next = ring[(i + L) % n];
        const inX = windowStart.x - prev.x;
        const inY = windowStart.y - prev.y;
        const outX = next.x - windowEnd.x;
        const outY = next.y - windowEnd.y;
        const inLen = Math.hypot(inX, inY);
        const outLen = Math.hypot(outX, outY);
        if (inLen < 1e-9 || outLen < 1e-9) continue;
        const cos = (inX * outX + inY * outY) / (inLen * outLen);
        if (cos >= cosThresh) continue;
        if (L > 1) {
          let internalLen = 0;
          for (let k = 0; k < L - 1; k++) {
            const a = ring[(i + k) % n];
            const b = ring[(i + k + 1) % n];
            internalLen += Math.hypot(b.x - a.x, b.y - a.y);
          }
          if (internalLen > widthFrac * Math.min(inLen, outLen)) continue; // too wide — a real narrow return
        }
        ring = removeCircularWindow(ring, i, L);
        removed = true;
        break;
      }
    }
    if (!removed) break;
  }
  return ring;
}

/** Douglas-Peucker on a CLOSED ring: anchor at vertex 0 and the vertex
 *  farthest from it, simplify the two chains, rejoin. */
/**
 * HIP-INK REPAIR — roof framing plans print a 45° hip diagonal springing
 * from EVERY outline corner and re-entrant corner. When the perimeter line
 * is broken (trusses, dimension ticks crossing it), the ink tracer follows
 * the bold hip diagonal instead of turning the corner, shipping an outline
 * with diagonal edges on a roof whose fascia is 100% horizontal/vertical
 * (the 1168G right side and front-left drew as long 45° cuts). Fascia
 * perimeters on these plans are rectilinear, so a near-45° segment IS hip
 * ink, never fascia: drop every non-axis edge and recover the true corner
 * by intersecting the neighboring H/V edge lines. Two parallel neighbors
 * (a diagonal spanning a whole side) get a synthesized perpendicular
 * connector at the midpoint of the removed span.
 *
 * Reject-implausible gates — any bail returns the input ring unchanged:
 *  - diagonals must be a MINORITY (≤45% of perimeter length) — a genuinely
 *    diagonal roof is left for the existing axis/scale gates to refuse;
 *  - the repaired ring must keep ≥4 corners and stay within 15% of the
 *    original area (a repair that reshapes the roof is no repair).
 */
/** BLIND-SPUR cleanup (in place): an out-and-back NEEDLE — A → B → C where C
 *  returns to within `spurTol` of A — is a stray tick/leader the tracer
 *  followed out and straight back, never fascia (it drew as a stub poking out
 *  of the 1168G right edge). Collapses the needle's tip + returned base and
 *  rescans until stable. DELIBERATELY needle-only (no wider "tab" collapse):
 *  a genuine small jog has two DISTINCT base corners and must survive — an
 *  earlier tab variant ate a real ~2.3 ft entry notch. `spurTol` is kept
 *  sub-foot so nothing real qualifies. */
function collapseBlindSpurs(out: RPt[], spurTol: number): void {
  for (let pass = 0; pass < 6; pass++) {
    let collapsed = false;
    for (let i = 0; i < out.length; i++) {
      if (out.length < 5) break;
      const a = out[i];
      const c = out[(i + 2) % out.length];
      if (Math.hypot(a.x - c.x, a.y - c.y) <= spurTol) {
        const bi = (i + 1) % out.length;
        const ci = (i + 2) % out.length;
        for (const idx of [Math.max(bi, ci), Math.min(bi, ci)]) out.splice(idx, 1);
        collapsed = true;
        i = -1; // restart scan — indices shifted
      }
    }
    if (!collapsed) break;
  }
}

export function orthogonalizeRing(ring: readonly RPt[]): {
  ring: RPt[];
  removedDiagonals: number;
} {
  const unchanged = { ring: ring.slice() as RPt[], removedDiagonals: 0 };
  const n = ring.length;
  if (n < 4) return unchanged;
  // Spur cleanup applies to EVERY ring, diagonals or not — compute the span
  // up front so a clean-but-spurred ring still gets scrubbed before the
  // early diagonal-free return below.
  const bb0 = ringBBox(ring as RPt[]);
  const span0 = Math.max(bb0.x1 - bb0.x0, bb0.y1 - bb0.y0);
  const preCleaned = ring.slice() as RPt[];
  if (span0 > 0) {
    collapseBlindSpurs(preCleaned, Math.max(1e-9, span0 * 0.006));
    if (preCleaned.length < 4) return unchanged;
  }
  const AXIS_COS = 0.94; // within ~20° of an axis = fascia ink
  type Kept = { orient: "h" | "v"; coord: number; len: number; a: RPt; b: RPt };
  const kept: Kept[] = [];
  let diagLen = 0;
  let totalLen = 0;
  let diagCount = 0;
  const m = preCleaned.length;
  for (let i = 0; i < m; i++) {
    const a = preCleaned[i];
    const b = preCleaned[(i + 1) % m];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    totalLen += len;
    if (Math.abs(dx) / len >= AXIS_COS) {
      kept.push({ orient: "h", coord: (a.y + b.y) / 2, len, a, b });
    } else if (Math.abs(dy) / len >= AXIS_COS) {
      kept.push({ orient: "v", coord: (a.x + b.x) / 2, len, a, b });
    } else {
      diagLen += len;
      diagCount++;
    }
  }
  // Diagonal-free ring: the spur scrub is the only change worth making.
  if (diagCount === 0) return { ring: preCleaned, removedDiagonals: 0 };
  if (kept.length < 3 || !(totalLen > 0) || diagLen / totalLen > 0.45) return unchanged;

  // Merge consecutive kept edges that are really one fascia line split by a
  // removed diagonal nick (same orientation, nearly the same coordinate).
  const bb = ringBBox(ring as RPt[]);
  const span = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
  const mergeTol = Math.max(1e-9, span * 0.015);
  const merged: Kept[] = [];
  for (const k of kept) {
    const prev = merged[merged.length - 1];
    if (prev && prev.orient === k.orient && Math.abs(prev.coord - k.coord) <= mergeTol) {
      prev.coord = (prev.coord * prev.len + k.coord * k.len) / (prev.len + k.len);
      prev.len += k.len;
      prev.b = k.b;
    } else {
      merged.push({ ...k });
    }
  }
  // The ring is cyclic — the first and last kept edges may be the same line.
  if (
    merged.length >= 2 &&
    merged[0].orient === merged[merged.length - 1].orient &&
    Math.abs(merged[0].coord - merged[merged.length - 1].coord) <= mergeTol
  ) {
    const last = merged.pop()!;
    merged[0].coord =
      (merged[0].coord * merged[0].len + last.coord * last.len) /
      (merged[0].len + last.len);
    merged[0].len += last.len;
    merged[0].a = last.a;
  }
  // 3 fascia lines is legal — a parallel pair gets its synthesized
  // connector below, so the OUTPUT corner count (gated after build) is
  // what matters, not the line count.
  if (merged.length < 3) return unchanged;

  // Corners: consecutive perpendicular lines intersect; consecutive parallel
  // lines (a removed whole-side diagonal) get a mid-span connector.
  const pts: RPt[] = [];
  for (let i = 0; i < merged.length; i++) {
    const A = merged[i];
    const B = merged[(i + 1) % merged.length];
    if (A.orient !== B.orient) {
      pts.push(A.orient === "h" ? { x: B.coord, y: A.coord } : { x: A.coord, y: B.coord });
    } else if (A.orient === "h") {
      const xc = (A.b.x + B.a.x) / 2;
      pts.push({ x: xc, y: A.coord }, { x: xc, y: B.coord });
    } else {
      const yc = (A.b.y + B.a.y) / 2;
      pts.push({ x: A.coord, y: yc }, { x: B.coord, y: yc });
    }
  }
  const dedupTol = Math.max(1e-9, span * 0.004);
  const out: RPt[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(prev.x - p.x, prev.y - p.y) <= dedupTol) continue;
    out.push(p);
  }
  while (
    out.length > 1 &&
    Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= dedupTol
  ) {
    out.pop();
  }
  collapseBlindSpurs(out, Math.max(dedupTol, span * 0.006));
  if (out.length < 4) return unchanged;
  const a0 = Math.abs(ringArea(ring as RPt[]));
  const a1 = Math.abs(ringArea(out));
  if (!(a0 > 0) || !(a1 > 0) || Math.abs(a1 - a0) / a0 > 0.15) return unchanged;
  return { ring: out, removedDiagonals: diagCount };
}

function simplifyRing(pts: RPt[], tol: number): RPt[] {
  if (pts.length <= 4) return pts.slice();
  let far = 1;
  let best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = dpChain(pts.slice(0, far + 1), tol);
  const b = dpChain([...pts.slice(far), pts[0]], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  // Drop exact duplicates that can survive the rejoin.
  const dedup: RPt[] = [];
  for (const p of out) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) dedup.push(p);
  }
  if (
    dedup.length >= 2 &&
    Math.abs(dedup[0].x - dedup[dedup.length - 1].x) < 1e-9 &&
    Math.abs(dedup[0].y - dedup[dedup.length - 1].y) < 1e-9
  ) {
    dedup.pop();
  }
  return dedup;
}

// ─── 1. bitmap extraction (the only non-pure piece — dynamic unpdf import) ───

/**
 * Pull the roof-plan page's embedded scan out of the PDF: unpdf
 * `extractImages(pdf, page)`, keep the LARGEST image (the full-sheet scan —
 * logos/stamps are far smaller). `page` is 1-based (the classifier's
 * roof_plan_page convention). Never throws — null on any failure, including
 * pages with no embedded raster (a vector page has none).
 */
export async function extractRoofPlanBitmap(
  pdfBase64: string | null | undefined,
  page: number | null | undefined,
): Promise<RasterBitmap | null> {
  try {
    if (!pdfBase64 || typeof pdfBase64 !== "string") return null;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return null;
    const bytes = Uint8Array.from(Buffer.from(pdfBase64, "base64"));
    const { extractImages } = await import("unpdf");
    const images = await extractImages(bytes, page);
    if (!Array.isArray(images) || images.length === 0) return null;
    let bestIdx = -1;
    let bestArea = 0;
    for (let i = 0; i < images.length; i++) {
      const im = images[i];
      const area = (im?.width ?? 0) * (im?.height ?? 0);
      if (area > bestArea) {
        bestArea = area;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return null;
    const im = images[bestIdx];
    // A full-sheet scan is thousands of px wide; anything tiny is a stamp.
    if (!im || im.width < 300 || im.height < 300) return null;
    if (im.channels !== 1 && im.channels !== 3 && im.channels !== 4) return null;
    if (!im.data || im.data.length < im.width * im.height * im.channels) return null;
    return { data: im.data, width: im.width, height: im.height, channels: im.channels };
  } catch {
    return null;
  }
}

// ─── 2. the pure tracer ──────────────────────────────────────────────────────

// Moore neighborhood, clockwise in y-down screen coords: E SE S SW W NW N NE.
const DX8 = [1, 1, 0, -1, -1, -1, 0, 1];
const DY8 = [0, 1, 1, 1, 0, -1, -1, -1];
const dirIndex = (dx: number, dy: number): number => {
  for (let i = 0; i < 8; i++) if (DX8[i] === dx && DY8[i] === dy) return i;
  return 0; // unreachable for Moore-adjacent deltas
};

/**
 * Trace the roof outline out of a scanned sheet bitmap. Fully pure — unit-
 * testable on synthetic Uint8Array grids. Returns null when there is nothing
 * plausible to trace (no ink, only frame ink, degenerate contour); gates on
 * the RESULT belong to `scaleAndGate`.
 *
 * Pipeline: integer-stride downsample (block-average grayscale) → binary
 * threshold (light-gray watermarks fall out here) → 8-connected component
 * labeling, ignoring anything touching the outer border band (sheet frame /
 * titleblock) or spanning ~the whole sheet → LARGEST remaining component →
 * Moore-neighbor outer-contour trace → Douglas-Peucker simplify →
 * rectifyPlanFootprint squaring (its own hard gates; a bail keeps the
 * simplified ring, which the axis gate downstream will then judge).
 */
export function traceRasterOutline(
  bitmap: RasterBitmap | null | undefined,
  opts?: TraceRasterOpts,
): RasterOutlineTrace | null {
  try {
    if (!bitmap || !bitmap.data || bitmap.width < 8 || bitmap.height < 8) return null;
    const { data, width, height, channels } = bitmap;
    if (channels !== 1 && channels !== 3 && channels !== 4) return null;
    if (data.length < width * height * channels) return null;

    const threshold = opts?.threshold ?? 128;
    const maxWidth = Math.max(64, opts?.maxWidth ?? 1400);
    const borderBandFrac = opts?.borderBandFrac ?? 0.025;
    const simplifyTolFrac = opts?.simplifyTolFrac ?? 0.006;

    // 2a. Downsample by integer stride to ≤ maxWidth: block-AVERAGE grayscale.
    // Averaging is a deliberate stroke-weight filter — the heavy printed roof
    // outline survives the threshold, hairline dimension lattice mostly
    // dissolves into its white surroundings.
    const stride = Math.max(1, Math.ceil(width / maxWidth));
    const gw = Math.max(1, Math.floor(width / stride));
    const gh = Math.max(1, Math.floor(height / stride));
    const sums = new Float64Array(gw * gh);
    const counts = new Uint32Array(gw * gh);
    for (let y = 0; y < gh * stride; y++) {
      const by = Math.floor(y / stride);
      const rowOff = y * width;
      for (let x = 0; x < gw * stride; x++) {
        const i = (rowOff + x) * channels;
        let lum: number;
        if (channels === 1) {
          lum = data[i];
        } else {
          lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          // Transparent px on an RGBA scan read as page white.
          if (channels === 4 && data[i + 3] < 64) lum = 255;
        }
        const gi = by * gw + Math.floor(x / stride);
        sums[gi] += lum;
        counts[gi]++;
      }
    }
    const ink = new Uint8Array(gw * gh);
    let inkCells = 0;
    for (let i = 0; i < gw * gh; i++) {
      if (counts[i] > 0 && sums[i] / counts[i] < threshold) {
        ink[i] = 1;
        inkCells++;
      }
    }
    if (inkCells < 32) return null;

    // 2b + 2c. 8-connected components; drop anything touching the border band
    // (sheet frame / titleblock ink) or spanning ~the whole grid; keep the
    // LARGEST survivor — the roof outline plus its connected interior linework.
    const bandX = Math.max(1, Math.round(gw * borderBandFrac));
    const bandY = Math.max(1, Math.round(gh * borderBandFrac));
    const labels = new Int32Array(gw * gh); // 0 = unlabeled
    const queue = new Int32Array(gw * gh);
    let bestLabel = 0;
    let bestSize = 0;
    let nextLabel = 0;
    for (let seed = 0; seed < gw * gh; seed++) {
      if (!ink[seed] || labels[seed] !== 0) continue;
      nextLabel++;
      let head = 0;
      let tail = 0;
      queue[tail++] = seed;
      labels[seed] = nextLabel;
      let size = 0;
      let touchesBorder = false;
      let bx0 = gw, by0 = gh, bx1 = -1, by1 = -1;
      while (head < tail) {
        const c = queue[head++];
        size++;
        const cx = c % gw;
        const cy = (c - cx) / gw;
        if (cx < bandX || cx >= gw - bandX || cy < bandY || cy >= gh - bandY) touchesBorder = true;
        if (cx < bx0) bx0 = cx;
        if (cx > bx1) bx1 = cx;
        if (cy < by0) by0 = cy;
        if (cy > by1) by1 = cy;
        for (let d = 0; d < 8; d++) {
          const nx = cx + DX8[d];
          const ny = cy + DY8[d];
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const ni = ny * gw + nx;
          if (!ink[ni] || labels[ni] !== 0) continue;
          labels[ni] = nextLabel;
          queue[tail++] = ni;
        }
      }
      // A component spanning ≥92% of BOTH grid dimensions is the sheet frame
      // even if a rough scan kept it out of the border band.
      const spansSheet = bx1 - bx0 >= 0.92 * gw && by1 - by0 >= 0.92 * gh;
      if (!touchesBorder && !spansSheet && size > bestSize) {
        bestSize = size;
        bestLabel = nextLabel;
      }
    }
    if (bestLabel === 0 || bestSize < 32) return null;

    // 2d-i. Moore-neighbor outer-contour trace of the winning component.
    const mask = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < gw && y < gh && labels[y * gw + x] === bestLabel;
    let sx = -1;
    let sy = -1;
    outer: for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        if (labels[y * gw + x] === bestLabel) {
          sx = x;
          sy = y;
          break outer;
        }
      }
    }
    if (sx < 0) return null;
    const contour: RPt[] = [{ x: sx, y: sy }];
    // Backtrack starts WEST of the row-major start (guaranteed empty).
    let bxp = sx;
    let byp = sy;
    let rx = sx - 1;
    let ry = sy;
    const firstB = { x: sx, y: sy };
    const firstR = { x: rx, y: ry };
    const cap = gw * gh * 4 + 16;
    for (let step = 0; step < cap; step++) {
      const d0 = dirIndex(rx - bxp, ry - byp);
      let moved = false;
      for (let k = 1; k <= 8; k++) {
        const j = (d0 + k) % 8;
        const nx = bxp + DX8[j];
        const ny = byp + DY8[j];
        if (mask(nx, ny)) {
          const pj = (d0 + k - 1) % 8;
          rx = bxp + DX8[pj];
          ry = byp + DY8[pj];
          bxp = nx;
          byp = ny;
          moved = true;
          break;
        }
      }
      if (!moved) break; // isolated cell
      // Jacob's stopping criterion: back at the start, entered the same way.
      if (bxp === firstB.x && byp === firstB.y && rx === firstR.x && ry === firstR.y) break;
      contour.push({ x: bxp, y: byp });
    }
    if (contour.length < 8) return null;

    // 2d-ii. Simplify, then square. Tolerance is a fraction of the span.
    const cb = ringBBox(contour);
    const span = Math.max(cb.x1 - cb.x0, cb.y1 - cb.y0);
    if (!(span > 4)) return null;
    let ring = simplifyRing(
      contour.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 })),
      Math.max(1, span * simplifyTolFrac),
    );
    if (ring.length < 4) return null;
    // Strip dangling appendages (leader lines, callout arrows, dimension
    // extensions) the outer trace picked up as hairpin reversals, THEN
    // re-simplify — collapsing a dangle can leave near-collinear neighbors.
    ring = removeHairpinSpikes(ring);
    if (ring.length < 4) return null;
    ring = simplifyRing(ring, Math.max(1, span * simplifyTolFrac));
    if (ring.length < 4) return null;
    // Hip-ink repair BEFORE squaring: 45° hip diagonals the tracer followed
    // at broken corners are dropped and the true H/V corners recovered
    // (orthogonalizeRing's own gates bail on genuinely diagonal shapes).
    ring = orthogonalizeRing(ring).ring;
    if (ring.length < 4) return null;
    // Final squaring: reuse rectifyPlanFootprint verbatim — its own hard gates
    // (axis fraction, area drift, corner shove) decide; a bail keeps the raw
    // simplified ring, whose low axisFrac the scale gate will then reject.
    const sq = rectifyPlanFootprint(ring, []);
    const squared = sq.applied;
    if (squared) ring = sq.footprint;

    // 2e. Back to ORIGINAL bitmap px + quality summary.
    const ringPx = ring.map((p) => ({ x: p.x * stride, y: p.y * stride }));
    const bboxPx = ringBBox(ringPx);
    const closes = polygonCloses(ringPx);
    const axisFrac = pageAxisAlignedFraction(ringPx);
    const areaPx = ringArea(ringPx);
    if (!(areaPx > 0)) return null;
    return {
      ring: ringPx,
      axisFrac,
      closes,
      areaPx,
      bboxPx,
      downsampleStride: stride,
      quality: {
        corners: ringPx.length,
        axisFrac,
        closes,
        componentCells: bestSize,
        downsampleStride: stride,
        squared,
        bitmapW: width,
        bitmapH: height,
      },
    };
  } catch {
    return null;
  }
}

// ─── 3. scale solve + hard gates ─────────────────────────────────────────────

/**
 * Solve feet-per-bitmap-px from the classifier's PRINTED overall dimensions
 * and gate the ring hard. `printedDimsFt` are the printed overalls (e.g.
 * [66.5, 48] — width/depth); the LARGEST anchors the ring's larger bbox span.
 * Gates (every failure is a plain-words reason):
 *  - the ring closes (no self-intersection) and has 6–80 corners (a plain box
 *    adds nothing over the trace; a noise blob is not an outline);
 *  - ≥90% of the perimeter is axis-aligned after squaring;
 *  - with a second printed dim, the scaled MINOR bbox span must land within
 *    ±10% of it (the cross-axis check — anchoring the major span makes its
 *    own ±10% vacuous);
 *  - with a stated width×depth box (ft²), the scaled polygon area must land
 *    within ±22% of it.
 */
export function scaleAndGate(
  ring: readonly RPt[] | null | undefined,
  printedDimsFt: readonly (number | null | undefined)[] | number | null | undefined,
  statedBoxFt2?: number | null,
): RasterGate {
  const reasons: string[] = [];
  try {
    const pts = (ring ?? []).filter(isFinitePt);
    if (pts.length !== (ring ?? []).length || pts.length < 3) {
      return { ok: false, ftPerPx: null, reasons: ["ring is missing or has non-finite points"] };
    }
    if (pts.length < 6) reasons.push(`only ${pts.length} corners — too simple to be the roof outline`);
    if (pts.length > 80) reasons.push(`${pts.length} corners — too noisy to be the roof outline`);
    if (!polygonCloses(pts as RPt[])) reasons.push("ring self-intersects");
    const axisFrac = pageAxisAlignedFraction(pts as RPt[]);
    if (axisFrac < 0.9)
      reasons.push(`only ${Math.round(axisFrac * 100)}% axis-aligned after squaring (need 90%)`);

    const dims = (Array.isArray(printedDimsFt) ? printedDimsFt : [printedDimsFt])
      .filter((d): d is number => typeof d === "number" && Number.isFinite(d) && d > 4)
      .sort((a, b) => b - a);
    if (dims.length === 0) {
      reasons.push("no printed overall dimension to anchor the scale");
      return { ok: false, ftPerPx: null, reasons };
    }

    const bb = ringBBox(pts);
    const major = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
    const minor = Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0);
    if (!(major > 0) || !(minor > 0)) {
      reasons.push("degenerate ring bbox");
      return { ok: false, ftPerPx: null, reasons };
    }
    const ftPerPx = dims[0] / major;
    if (!Number.isFinite(ftPerPx) || ftPerPx <= 0) {
      reasons.push("scale solve produced a non-finite ft/px");
      return { ok: false, ftPerPx: null, reasons };
    }
    if (dims.length >= 2) {
      const minorFt = minor * ftPerPx;
      // ASYMMETRIC band: the printed dims are WALL overalls, but the roof
      // ink includes the eave OVERHANGS — the ring legitimately runs LARGER
      // than the wall dim (2 × 2-2.5 ft typical overhang, PLUS covered
      // porch / outdoor-living roof sections that extend well past the wall
      // line: the real 1168G sheet runs 60.6 ft of roof over a 51 ft wall
      // depth = +19%, and the old +18% ceiling threw the exact ink away by
      // ONE percent, shipping a worse vision trace instead). Undersize is
      // still trace-error territory and stays tight.
      let bestRatio = Infinity;
      let bestDim = dims[1];
      for (const d of dims.slice(1)) {
        const ratio = minorFt / d;
        if (Math.abs(ratio - 1) < Math.abs(bestRatio - 1)) {
          bestRatio = ratio;
          bestDim = d;
        }
      }
      if (bestRatio < 0.94 || bestRatio > 1.28) {
        reasons.push(
          `scaled depth ${Math.round(minorFt * 10) / 10} ft is ${Math.round(Math.abs(bestRatio - 1) * 100)}% ${bestRatio > 1 ? "over" : "under"} the printed ${bestDim}' (roof overhang + covered-patio extension allows -6%…+28%)`,
        );
      }
    }
    if (typeof statedBoxFt2 === "number" && Number.isFinite(statedBoxFt2) && statedBoxFt2 > 0) {
      const areaFt2 = ringArea(pts) * ftPerPx * ftPerPx;
      const off = Math.abs(areaFt2 - statedBoxFt2) / statedBoxFt2;
      if (off > 0.22) {
        reasons.push(
          `scaled outline area ${Math.round(areaFt2)} sf is ${Math.round(off * 100)}% off the stated ${Math.round(statedBoxFt2)} sf box (need ±22%)`,
        );
      }
    }
    // ftPerPx is reported even on failure — the reasons quote it implicitly
    // and the stash stores it only when ok.
    return { ok: reasons.length === 0, ftPerPx, reasons };
  } catch (e) {
    return {
      ok: false,
      ftPerPx: null,
      reasons: [...reasons, `scale gate threw: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

// ─── 4. consume step (estimate path) — pure, byte-identical on any bail ─────

export type RasterApplyOk<
  R extends { start: RPt; end: RPt },
  E extends { start: RPt; end: RPt },
  D extends { at: RPt },
> = {
  applied: true;
  /** The raster ring, placed in the ANALYSIS coordinate space. */
  footprint: RPt[];
  runs: R[];
  excludedEdges: E[];
  downspouts: D[];
  /** Which axis flip aligned the bitmap frame onto the analysis frame. */
  flip: "none" | "x" | "y" | "xy";
  /** Mean ring-to-ring distance of the winning flip, as a fraction of the
   *  traced footprint's bbox diagonal (smaller = closer agreement). */
  disagreementFrac: number;
  /** Analysis-space scale used for placement (feet per analysis unit). */
  ftPerUnit: number;
  /** How far the trace's area sat from the sheet's ink, signed:
   *  negative = the trace was undersized. */
  traceAreaDeltaPct: number;
};

export type RasterApplyResult<
  R extends { start: RPt; end: RPt },
  E extends { start: RPt; end: RPt },
  D extends { at: RPt },
> = RasterApplyOk<R, E, D> | { applied: false; reasons: string[] };

/** Uniform-by-arclength boundary samples of a closed ring. */
function sampleRing(ring: readonly RPt[], n: number): RPt[] {
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    lens.push(l);
    total += l;
  }
  if (!(total > 0)) return ring.slice(0, n);
  const out: RPt[] = [];
  const step = total / n;
  let edge = 0;
  let along = 0;
  for (let k = 0; k < n; k++) {
    let target = k * step;
    while (edge < ring.length - 1 && along + lens[edge] < target) {
      along += lens[edge];
      edge++;
    }
    const a = ring[edge];
    const b = ring[(edge + 1) % ring.length];
    const t = lens[edge] > 0 ? (target - along) / lens[edge] : 0;
    out.push({ x: a.x + (b.x - a.x) * Math.min(1, t), y: a.y + (b.y - a.y) * Math.min(1, t) });
  }
  return out;
}

/** Symmetric mean boundary distance between two rings (Chamfer-style). */
function ringDisagreement(a: readonly RPt[], b: readonly RPt[]): number {
  const sa = sampleRing(a, 72);
  const sb = sampleRing(b, 72);
  let da = 0;
  for (const p of sa) {
    const q = nearestOnRing(b, p);
    da += Math.hypot(p.x - q.x, p.y - q.y);
  }
  let dbb = 0;
  for (const p of sb) {
    const q = nearestOnRing(a, p);
    dbb += Math.hypot(p.x - q.x, p.y - q.y);
  }
  return (da / sa.length + dbb / sb.length) / 2;
}

/**
 * Place the gated raster ring into the analysis coordinate space and carry
 * the gutter runs / excluded edges / downspouts onto it as followers.
 *
 * Placement doctrine (why NOT a bbox-onto-bbox affine): matching the raster
 * ring's bbox onto the traced footprint's bbox would inherit the trace's
 * wrong SIZE — the exact defect this module exists to remove. Instead the
 * ring is scaled bitmap-px → analysis-units through TRUE FEET (raster ftPerPx
 * ÷ the runs' own median ft-per-unit) and anchored at the traced footprint's
 * bbox CENTER, so the runs stay nearby without adopting the trace's size.
 * ORIENTATION: flip NONE, always — the ring and the trace come from the same
 * page image, so the sheet's own front-at-bottom convention IS the truth. A
 * misoriented TRACE must never flip the correct outline (the 1168G
 * upside-down canvas), so there is no flip search; if the no-flip placement
 * doesn't resemble the trace, the swap is refused and the vision trace kept.
 *
 * PURE + non-mutating: on ANY bail the caller's analysis stays byte-identical.
 * Runs keep their `length_ft` verbatim (priced LF unchanged); only start/end
 * (+ recomputed length_px) move onto the new perimeter.
 */
export function applyRasterOutline<
  R extends { start: RPt; end: RPt; length_px?: number | null; length_ft?: number | null },
  E extends { start: RPt; end: RPt },
  D extends { at: RPt },
>(input: {
  footprint: readonly RPt[] | null | undefined;
  runs: readonly R[] | null | undefined;
  excludedEdges?: readonly E[] | null;
  downspouts?: readonly D[] | null;
  raster: RasterOutlineStash | null | undefined;
  /** Fallback ft-per-analysis-unit (analysis.scale.feet_per_unit) when the
   *  runs carry no usable length_ft/length_px pairs. */
  scaleFeetPerUnit?: number | null;
  /** Max tolerated disagreement (fraction of the trace bbox diagonal) for the
   *  best flip. Default 0.30. */
  maxDisagreementFrac?: number;
}): RasterApplyResult<R, E, D> {
  const fail = (...reasons: string[]): { applied: false; reasons: string[] } => ({
    applied: false,
    reasons,
  });
  try {
    const raster = input.raster;
    if (!raster) return fail("no raster outline stored for this analysis");
    if (!raster.ok) {
      return fail(...(raster.reasons?.length ? raster.reasons : ["raster gates failed at analysis time"]));
    }
    let ringPx = (raster.ring ?? []).filter(isFinitePt);
    if (ringPx.length < 6 || ringPx.length !== (raster.ring ?? []).length) {
      return fail("stored raster ring is missing or malformed");
    }
    // Hip-ink repair at CONSUME time too — rings stashed before the repair
    // existed (or whose squaring bailed) may still carry 45° hip-diagonal
    // edges; the fascia perimeter is rectilinear, so recover the true
    // corners here. A bail leaves the stashed ring untouched.
    ringPx = orthogonalizeRing(ringPx).ring;
    const ftPerPx = raster.ftPerPx;
    if (typeof ftPerPx !== "number" || !Number.isFinite(ftPerPx) || ftPerPx <= 0) {
      return fail("stored raster ring has no usable ft/px scale");
    }
    const fp = (input.footprint ?? []).filter(isFinitePt);
    if (fp.length < 4) return fail("traced footprint has fewer than 4 corners to anchor on");
    const runs = input.runs ?? [];
    if (runs.length === 0) return fail("no gutter runs to carry onto the sheet outline");

    // Analysis-space feet-per-unit: the runs' own median (the same derivation
    // the perimeter closure and notch audit use), scale.feet_per_unit fallback.
    const ratios: number[] = [];
    for (const r of runs) {
      const lf = r.length_ft;
      const lp = r.length_px;
      if (
        typeof lf === "number" && Number.isFinite(lf) && lf > 0 &&
        typeof lp === "number" && Number.isFinite(lp) && lp > 0
      ) {
        ratios.push(lf / lp);
      }
    }
    ratios.sort((a, b) => a - b);
    let ftPerUnit = ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)] : null;
    if (ftPerUnit == null) {
      const s = input.scaleFeetPerUnit;
      if (typeof s === "number" && Number.isFinite(s) && s > 0) ftPerUnit = s;
    }
    if (ftPerUnit == null || !(ftPerUnit > 0)) {
      return fail("no run-derived scale to place the sheet outline in the trace's space");
    }

    // Place: bitmap px → analysis units through true feet, anchored at the
    // traced footprint's bbox CENTER; score all four axis flips.
    const s = ftPerPx / ftPerUnit;
    const fb = ringBBox(fp);
    const cx = (fb.x0 + fb.x1) / 2;
    const cy = (fb.y0 + fb.y1) / 2;
    const rb = ringBBox(ringPx);
    const rcx = (rb.x0 + rb.x1) / 2;
    const rcy = (rb.y0 + rb.y1) / 2;
    const diag = Math.hypot(fb.x1 - fb.x0, fb.y1 - fb.y0);
    if (!(diag > 0)) return fail("degenerate traced footprint bbox");

    // SHEET ORIENTATION IS THE TRUTH — flip NONE, always. The raster ring and
    // the vision trace come from the SAME page image, so the sheet's own
    // front-at-bottom drafting convention carries straight into the analysis
    // frame with no flip. The previous code scored all four axis flips and
    // kept whichever best matched the TRACE — which let a misoriented trace
    // (the 1168G gemini roll read the page upside-down) flip the CORRECT
    // outline to agree with the wrong trace: every jog landed on the opposite
    // side and FRONT/BACK swapped. There is no flip search anymore; if the
    // no-flip placement doesn't resemble the trace, we REFUSE and keep the
    // vision trace rather than risk a misorientation.
    const placedNone = ringPx.map((p) => ({
      x: cx + (p.x - rcx) * s,
      y: cy + (p.y - rcy) * s,
    }));
    const best = { name: "none" as const, ring: placedNone, score: ringDisagreement(placedNone, fp) / diag };
    const maxDisagree = input.maxDisagreementFrac ?? 0.3;
    if (best.score > maxDisagree) {
      return fail(
        `sheet outline doesn't resemble the traced footprint at the sheet's own orientation (${Math.round(
          best.score * 100,
        )}% of the bbox diagonal apart — likely a rotated/mirrored sheet or the wrong ink component; kept the vision trace)`,
      );
    }

    // Follower snap: every endpoint / downspout projects onto the new
    // perimeter. length_ft is deliberately untouched — priced LF unchanged.
    const newRing = best.ring;
    const outRuns = runs.map((r) => {
      if (!isFinitePt(r.start) || !isFinitePt(r.end)) return { ...r };
      const start = nearestOnRing(newRing, r.start);
      const end = nearestOnRing(newRing, r.end);
      const moved: R = { ...r, start, end };
      if (r.length_px != null) {
        (moved as { length_px?: number | null }).length_px = Math.hypot(
          end.x - start.x,
          end.y - start.y,
        );
      }
      return moved;
    });
    const outEdges = (input.excludedEdges ?? []).map((e) =>
      isFinitePt(e.start) && isFinitePt(e.end)
        ? { ...e, start: nearestOnRing(newRing, e.start), end: nearestOnRing(newRing, e.end) }
        : { ...e },
    );
    const outDs = (input.downspouts ?? []).map((d) =>
      isFinitePt(d.at) ? { ...d, at: nearestOnRing(newRing, d.at) } : { ...d },
    );

    // Signed size verdict for the loud note: trace area vs sheet-ink area, in ft².
    const traceAreaFt2 = ringArea(fp) * ftPerUnit * ftPerUnit;
    const rasterAreaFt2 = ringArea(ringPx) * ftPerPx * ftPerPx;
    const traceAreaDeltaPct =
      rasterAreaFt2 > 0 ? ((traceAreaFt2 - rasterAreaFt2) / rasterAreaFt2) * 100 : 0;

    return {
      applied: true,
      footprint: newRing,
      runs: outRuns,
      excludedEdges: outEdges,
      downspouts: outDs,
      flip: best.name,
      disagreementFrac: best.score,
      ftPerUnit,
      traceAreaDeltaPct,
    };
  } catch (e) {
    return fail(`raster apply threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── 5. route orchestrator (extract → trace → gate → stash) ─────────────────

/**
 * The one call the analysis routes make on the scanned path: pull the
 * roof-plan page's embedded scan, trace + gate it, and return the stash to
 * store verbatim under `analysisJson._rasterOutline`. Deterministic (no AI
 * spend). Never throws; never sinks a run — a failure returns { ok:false,
 * reasons } (stored so the estimate path can say what ruled), and a page that
 * can't even yield a bitmap still returns that, not an exception. Returns
 * null only when not attempted (kill switch / no page / no bytes), so old
 * behavior is byte-identical with no stash field at all.
 * Kill switch: BLUEPRINT_RASTER_OUTLINE=0.
 */
export async function computeRasterOutlineStash(input: {
  pdfBase64: string | null | undefined;
  /** 1-based classified roof-plan page. */
  page: number | null | undefined;
  /** Classifier printed overalls (width_ft/depth_ft), for the scale solve. */
  printedDimsFt?: readonly (number | null | undefined)[] | null;
  /** Stated width×depth box (ft²) for the area gate, when both dims exist. */
  statedBoxFt2?: number | null;
}): Promise<RasterOutlineStash | null> {
  const page = typeof input.page === "number" && Number.isInteger(input.page) ? input.page : null;
  try {
    if (process.env.BLUEPRINT_RASTER_OUTLINE === "0") return null;
    if (!input.pdfBase64 || page == null || page < 1) return null;
    const bitmap = await extractRoofPlanBitmap(input.pdfBase64, page);
    if (!bitmap) {
      return {
        ok: false,
        page,
        reasons: ["no embedded raster image on the roof-plan page (or it was too small to be the sheet scan)"],
      };
    }
    const trace = traceRasterOutline(bitmap);
    if (!trace) {
      return {
        ok: false,
        page,
        reasons: ["no traceable ink component after removing the sheet frame (broken outline, blank page, or all-hairline linework)"],
      };
    }
    const gate = scaleAndGate(trace.ring, input.printedDimsFt ?? null, input.statedBoxFt2 ?? null);
    if (!gate.ok || gate.ftPerPx == null) {
      return { ok: false, page, quality: trace.quality, reasons: gate.reasons };
    }
    return {
      ok: true,
      page,
      ring: trace.ring,
      ftPerPx: gate.ftPerPx,
      quality: trace.quality,
      reasons: [],
    };
  } catch (e) {
    return {
      ok: false,
      page,
      reasons: [`raster outline extraction threw: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}
