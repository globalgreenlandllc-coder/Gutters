/**
 * Read the ROOF from the SINGLE A9 roof-framing sheet — one coordinate space —
 * instead of stitching the A4 foundation footprint to the A9 classification
 * (two pages, two coord systems, gables never align). The A9 page's bold
 * structural strokes + clean text labels are already extracted and stored in
 * analysisJson._vectorGeometry.roof {segments, labels} at analysis time.
 *
 * THE BET: run the proven extractBuildingOutline on A9's bold segments to get
 * the roof PERIMETER (already in A9 space, so it aligns with the GABLE text
 * labels for free), then classify each perimeter edge as a GABLE (rake, no
 * gutter) vs an EAVE using the GABLE-family text labels — the clean, reliable
 * signal. Interior ridge/hip/valley classification is intentionally NOT done
 * here: the client re-derives them from perimeter+eaves+rakes via
 * deriveRoofSkeleton, so building them here would be pure risk with no payoff.
 *
 * Load-bearing outputs only: { perimeter, gableFlags }. Returns null on ANY
 * failure (no/short segments, no enclosed region, hip-dominant near-rectangle
 * <=4 corners, a truss-contaminated spiky/ribbon blob, or any thrown error) so
 * the caller degrades gracefully to the A4 footprint-copy block (and then to AI
 * geometry) — never blank, never worse, never throws.
 *
 * PURE: no DOM / server-only / React / unpdf. Runs in the browser bundle AND
 * under `node --test` on synthetic fixtures.
 */

import { extractBuildingOutline, snapAndClean, type Pt } from "./outline-from-vectors";

export type RoofLabel = { s: string; x: number; y: number };

export type RoofRead = {
  perimeter: Pt[];
  gableFlags: boolean[];
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence: number;
};

/**
 * True iff the label text names a GABLE end (the marker for where a gable wall
 * is). Covers "GABLE END", "GABLE END TRUSS", "STRUCT. GABLE END TRUSS",
 * "GABLE". Rejects RIDGE / HIP / VALLEY / MAIN VALLEY and the truss-type labels
 * COMMON / SCISSOR / STUB / SPECIAL / GIRDER TRUSS. Exported so the test pins
 * the keyword set and the wire-in stays dumb.
 */
export function classifyGableLabel(s: string): boolean {
  if (typeof s !== "string") return false;
  return /\bGABLE\b/.test(s.toUpperCase().trim());
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Absolute polygon area (shoelace). */
function polyArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Ray-cast point-in-polygon. Used to require a GABLE marker sit INSIDE the
 *  building (a gable-end-truss label prints a truss-depth in from its wall), so
 *  a stray "GABLE" note OUTSIDE the outline can't flag an edge. */
function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Read the roof perimeter + per-edge gable flags from A9's bold segments and
 * text labels (one coord space, PDF user space, bottom-left origin). Returns
 * null on any failure so the caller falls back to the existing pipeline.
 *
 * `opts.expectedAspect` (e.g. the A4 footprint's longer/shorter bbox ratio) lets
 * the caller reject an A9 read whose shape is wildly different from the known
 * footprint — catching a truss-contaminated "plausible blob" that floodfill
 * happened to enclose.
 */
export function readRoofFromVectors(
  labels: RoofLabel[],
  segments: number[][],
  opts?: { expectedAspect?: number },
): RoofRead | null {
  try {
    if (!Array.isArray(segments) || segments.length < 4) return null;

    // 1) PERIMETER — reuse the proven outline recovery. Its polygon comes back
    //    in the INPUT segments' coord space (= A9 space), so it already aligns
    //    with the gable labels. A plain box (<=4 corners) is no better than
    //    today; >40 corners is a truss-contaminated blob, not a building.
    const out = extractBuildingOutline(segments);
    if (!out) return null;
    const perimeter = out.polygon;
    if (perimeter.length <= 4 || perimeter.length > 40) return null;

    const bbox = out.bbox;
    const bboxW = bbox.x1 - bbox.x0;
    const bboxH = bbox.y1 - bbox.y0;
    if (!(bboxW > 0) || !(bboxH > 0)) return null;
    const span = Math.max(bboxW, bboxH);

    // ANTI-JUNK #1 — fill fraction. A real building outline (even an articulated
    // L/T/U) fills a healthy share of its bounding box; a deformed/spiky trace
    // from surviving truss noise fills only a sliver. Fall back if too sparse.
    const fill = polyArea(perimeter) / (bboxW * bboxH);
    if (!(fill >= 0.45)) return null;

    // ANTI-JUNK #2 — aspect. A house footprint is roughly squarish-to-2.5:1; a
    // truss blob is often a wild ribbon. Reject against the known footprint
    // aspect when supplied, else reject only the absurd.
    const aspect = Math.max(bboxW, bboxH) / Math.min(bboxW, bboxH);
    const exp =
      opts?.expectedAspect && opts.expectedAspect > 0
        ? opts.expectedAspect < 1
          ? 1 / opts.expectedAspect
          : opts.expectedAspect
        : null;
    if (exp != null) {
      if (aspect > exp * 1.8 + 0.3) return null;
    } else if (aspect > 4) {
      return null;
    }

    // 2) GABLE MARKERS — clean text signal. Keep only valid-coord GABLE labels
    //    that sit INSIDE the recovered outline (a gable-end-truss label prints a
    //    truss-depth in from its wall; a stray note outside can't flag an edge).
    const markers = (Array.isArray(labels) ? labels : []).filter(
      (l) =>
        l &&
        classifyGableLabel(l.s) &&
        Number.isFinite(l.x) &&
        Number.isFinite(l.y) &&
        pointInPolygon({ x: l.x, y: l.y }, perimeter),
    );

    const n = perimeter.length;
    const gableFlags = new Array<boolean>(n).fill(false);

    // 3) Assign EACH marker to its single best edge — a marker can never flag
    //    two parallel walls. "Best" = aligned to the edge (projection within the
    //    edge span ±tol) AND within an inward band (perp distance <= maxInward,
    //    a truss depth), then nearest by perpendicular distance among qualifiers.
    const tol = 0.06 * span;
    const maxInward = 0.18 * span;

    for (const m of markers) {
      let bestEdge = -1;
      let bestPerp = Infinity;
      for (let i = 0; i < n; i++) {
        const a = perimeter[i];
        const b = perimeter[(i + 1) % n];
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const len2 = ex * ex + ey * ey;
        if (len2 <= 1e-9) continue;
        const t = ((m.x - a.x) * ex + (m.y - a.y) * ey) / len2;
        const len = Math.sqrt(len2);
        const tolN = tol / len;
        if (t < -tolN || t > 1 + tolN) continue;
        const perp = Math.abs(((m.x - a.x) * ey - (m.y - a.y) * ex) / len);
        if (perp > maxInward) continue;
        if (perp < bestPerp) {
          bestPerp = perp;
          bestEdge = i;
        }
      }
      if (bestEdge >= 0) gableFlags[bestEdge] = true;
    }

    const confidence =
      markers.length > 0 ? clamp(0.5 + 0.1 * Math.min(n - 4, 5), 0, 1) : 0.3;

    return { perimeter, gableFlags, bbox, confidence };
  } catch {
    return null;
  }
}

// ————————————————————————————————————————————————————————————————————————
// PERIMETER REPAIR — cross-validate the traced roof perimeter BEFORE the
// edge takeoff prices it.
//
// Two deterministic failure modes of the flood-fill trace, both seen on a
// real dimensioned roof-framing sheet:
//  (a) PHANTOM POCKETS — the outermost closed contour is partly formed by
//      thin dimension-rail / leader linework (or a decorative trellis), so
//      the trace carries edges that sit on NO drawn roof line: fake side
//      "wings" ~8 ft outside the walls, a front edge riding a trellis line.
//  (b) MISSING JOGS — the trace rides one straight junk line across a real
//      wall step (e.g. the garage single-bay offset), flattening a jog that
//      the foundation plan draws plainly.
//
// Repair (a) from the sheet's OWN stroke weights: an edge unsupported by any
// wall-tier line snaps to the nearest heavy parallel line. Repair (b) from
// the already-extracted foundation-plan outline: a jog drawn there that maps
// into the middle of one flat roof edge is adopted (scaled).
//
// PRICING DOCTRINE: this CAN change LF, so every move is hard-gated (width
// data must tier, the pen weight is taken from the perimeter's own supported
// edges, snap distance capped, jog correspondence must be unambiguous, the
// result must stay a simple 4-40-corner polygon inside an area band) and the
// caller notes it loudly on-panel. Any doubt → null, the trace stands.
// ————————————————————————————————————————————————————————————————————————

/** An axis-aligned stroke/edge collapsed to its line: constant coord `c`,
 *  span [lo,hi] along the other axis. */
type AxisItem = { c: number; lo: number; hi: number; w: number };

/** Union length of intervals, clipped to [lo,hi]. */
function unionCoverage(items: { lo: number; hi: number }[], lo: number, hi: number): number {
  const iv = items
    .map((s) => [Math.max(lo, s.lo), Math.min(hi, s.hi)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of iv) {
    if (a > end) {
      total += b - a;
      end = b;
    } else if (b > end) {
      total += b - end;
      end = b;
    }
  }
  return total;
}

/** Split segments into horizontal / vertical axis items (others dropped). */
function axisPools(segments: number[][], axisTol: number): { hs: AxisItem[]; vs: AxisItem[] } {
  const hs: AxisItem[] = [];
  const vs: AxisItem[] = [];
  for (const s of segments) {
    if (!Array.isArray(s) || s.length < 4) continue;
    if (![s[0], s[1], s[2], s[3]].every(Number.isFinite)) continue;
    const w = s.length >= 5 && Number.isFinite(s[4]) ? s[4] : 0;
    if (Math.abs(s[1] - s[3]) <= axisTol) {
      hs.push({ c: (s[1] + s[3]) / 2, lo: Math.min(s[0], s[2]), hi: Math.max(s[0], s[2]), w });
    } else if (Math.abs(s[0] - s[2]) <= axisTol) {
      vs.push({ c: (s[0] + s[2]) / 2, lo: Math.min(s[1], s[3]), hi: Math.max(s[1], s[3]), w });
    }
  }
  return { hs, vs };
}

/** The polygon's edges as axis items (+ direction), or null when any edge is
 *  not axis-aligned — the repair only understands rectilinear outlines. */
function axisEdges(
  poly: Pt[],
  axisTol: number,
): { horiz: boolean; c: number; lo: number; hi: number; len: number }[] | null {
  const out: { horiz: boolean; c: number; lo: number; hi: number; len: number }[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (Math.abs(a.y - b.y) <= axisTol) {
      out.push({ horiz: true, c: (a.y + b.y) / 2, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), len: Math.abs(b.x - a.x) });
    } else if (Math.abs(a.x - b.x) <= axisTol) {
      out.push({ horiz: false, c: (a.x + b.x) / 2, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y), len: Math.abs(b.y - a.y) });
    } else {
      return null;
    }
  }
  return out;
}

/** Proper self-intersection check between non-adjacent edges (sanity gate —
 *  a repair must never emit a bow-tie). */
function isSimplePolygon(poly: Pt[]): boolean {
  const n = poly.length;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const properIntersect = (a: Pt, b: Pt, c: Pt, d: Pt) => {
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent around the wrap
      if (properIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

const spanOf = (poly: Pt[]) => {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

/**
 * (a) PHANTOM-POCKET REJECTION. A traced perimeter edge whose only nearby
 * parallel linework is the sheet's THINNEST stroke tier (dimension rails /
 * leaders) — or nothing at all — is not a drawn roof edge. Snap it to the
 * nearest parallel line drawn at the OUTLINE PEN weight (the dominant stroke
 * weight under the perimeter's well-supported edges), then merge the sliver
 * jogs that snapping leaves behind.
 *
 * Deliberately protective: an edge supported by ANY mid-weight line (a porch
 * roof drawn lighter than the main outline) is never touched; an unsupported
 * edge with no heavy line to snap to is kept as-is. Null = nothing to fix or
 * the width data can't be trusted — caller keeps the trace unchanged.
 */
export function snapPhantomEdges(
  perimeter: Pt[],
  segments: number[][],
): { perimeter: Pt[]; snapped: number } | null {
  const n = perimeter.length;
  if (n < 4 || n > 40 || !Array.isArray(segments) || segments.length < 4) return null;
  const span = spanOf(perimeter);
  if (!(span > 0)) return null;

  // Width gates: most segments must carry a stroke weight and the weights
  // must tier (thin dims / structure / heavy outline) — mirrors tierByWidth.
  const measured = segments.filter((s) => s.length >= 5 && Number.isFinite(s[4]) && s[4] > 0);
  if (measured.length < 0.5 * segments.length) return null;
  const distinct = [...new Set(measured.map((s) => Math.round(s[4] * 100) / 100))].sort((a, b) => a - b);
  if (distinct.length < 3) return null;
  const thin = distinct[0];

  const AXIS_TOL = Math.max(0.75, span * 0.001);
  const SUPPORT_TOL = span * 0.015; // trace-grid noise (~2.5 cells of a 200-cell grid)
  const SNAP_CAP = span * 0.12; // a dimension-rail pocket sits ~5-10% outside the walls

  const edges = axisEdges(perimeter, AXIS_TOL);
  if (!edges) return null;
  const { hs, vs } = axisPools(segments, AXIS_TOL);

  // Pass 1 — support census: which edges lie on wall-tier linework?
  const supported: boolean[] = new Array(edges.length).fill(false);
  const strongest: number[] = new Array(edges.length).fill(0);
  let supportedLen = 0;
  let totalLen = 0;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    totalLen += e.len;
    if (e.len <= AXIS_TOL) continue;
    const pool = e.horiz ? hs : vs;
    const near = pool.filter(
      (s) => s.w > thin + 1e-9 && Math.abs(s.c - e.c) <= SUPPORT_TOL && Math.min(e.hi, s.hi) - Math.max(e.lo, s.lo) > 0,
    );
    if (unionCoverage(near, e.lo, e.hi) >= 0.5 * e.len) {
      supported[i] = true;
      supportedLen += e.len;
      strongest[i] = Math.max(...near.map((s) => s.w));
    }
  }
  // Trust gate: at least half the perimeter must sit on real drawn linework,
  // otherwise the stroke weights don't describe this sheet's outline at all.
  if (!(totalLen > 0) || supportedLen < 0.5 * totalLen) return null;

  // The OUTLINE PEN: dominant (length-weighted) strongest support weight.
  const lenByPen = new Map<number, number>();
  for (let i = 0; i < edges.length; i++) {
    if (!supported[i]) continue;
    const w = Math.round(strongest[i] * 100) / 100;
    lenByPen.set(w, (lenByPen.get(w) ?? 0) + edges[i].len);
  }
  let pen = 0;
  let penLen = -Infinity;
  for (const [w, l] of lenByPen) {
    if (l > penLen || (l === penLen && w > pen)) {
      pen = w;
      penLen = l;
    }
  }
  if (!(pen > 0)) return null;

  // Pass 2 — snap each unsupported edge to the nearest outline-pen line that
  // covers ≥50% of its span (clustered so a dashed heavy line still counts).
  const newC = edges.map((e) => e.c);
  let snapped = 0;
  for (let i = 0; i < edges.length; i++) {
    if (supported[i]) continue;
    const e = edges[i];
    if (e.len <= AXIS_TOL) continue;
    const pool = (e.horiz ? hs : vs).filter(
      (s) =>
        s.w >= pen - 0.01 &&
        Math.abs(s.c - e.c) <= SNAP_CAP &&
        Math.min(e.hi, s.hi) - Math.max(e.lo, s.lo) > 0,
    );
    if (pool.length === 0) continue; // nothing to snap to — keep the edge
    // Cluster by line coordinate; a cluster is one drawn (possibly dashed) line.
    pool.sort((a, b) => a.c - b.c);
    const clusters: AxisItem[][] = [];
    for (const s of pool) {
      const last = clusters[clusters.length - 1];
      if (last && s.c - last[last.length - 1].c <= SUPPORT_TOL / 2) last.push(s);
      else clusters.push([s]);
    }
    let bestC: number | null = null;
    for (const cl of clusters) {
      if (unionCoverage(cl, e.lo, e.hi) < 0.5 * e.len) continue;
      const c = cl.reduce((s, x) => s + x.c, 0) / cl.length;
      if (bestC == null || Math.abs(c - e.c) < Math.abs(bestC - e.c)) bestC = c;
    }
    if (bestC == null) continue;
    newC[i] = bestC;
    snapped++;
  }
  if (snapped === 0) return null;
  // Too many phantom edges = the weight story is wrong for this sheet.
  if (snapped > Math.max(4, Math.ceil(n / 4))) return null;

  // Rebuild each vertex from its two edges' (possibly moved) lines, then merge
  // the sliver jogs snapping leaves (a snapped rail landing ~1 ft from its
  // neighbor wall collapses into one straight wall).
  const rebuilt: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = edges[(i - 1 + n) % n];
    const cur = edges[i];
    const cPrev = newC[(i - 1 + n) % n];
    const cCur = newC[i];
    if (prev.horiz === cur.horiz) return null; // degenerate corner — bail
    rebuilt.push(cur.horiz ? { x: cPrev, y: cCur } : { x: cCur, y: cPrev });
  }
  const cleaned = snapAndClean(rebuilt, SUPPORT_TOL);

  // Validity gates — a repair must stay a believable building.
  if (cleaned.length < 4 || cleaned.length > 40) return null;
  if (!isSimplePolygon(cleaned)) return null;
  const ratio = polyArea(cleaned) / Math.max(1e-9, polyArea(perimeter));
  if (ratio < 0.55 || ratio > 1.08) return null;
  return { perimeter: cleaned, snapped };
}

// ————————————————————————————————————————————————————————————————————————
// ELEVATIONS-FIRST JOG GATE (owner doctrine: gutters hang on the ROOF edge;
// jogs must come from the roof shape, elevations first — a wall/footprint jog
// alone proves nothing, the roof often bridges it). When the caller supplies
// per-face eave-line reads, a footprint jog is adopted into the priced
// outline ONLY when the same face's elevation shows an eave-line break near
// that position. A face that read a clean straight eave (eave_steps [] AND
// continuous_eave) VETOES the splice — the jog is surfaced as a note + an
// unpriced suggestedReturns entry instead. Faces without the field (old
// stored reads) keep legacy behavior byte-identical.
// ————————————————————————————————————————————————————————————————————————

/** Per-face eave-line breaks read off the elevations (viewer frame,
 *  0 = far left → 1 = far right as you look at that elevation). Only faces
 *  that actually REPORTED the field belong in this list. */
export type ElevationFaceSteps = {
  /** House-relative face word: front / rear / back / left / right. */
  face: string;
  steps: { position_frac: number | null; direction?: "up" | "down" | null }[];
  continuous_eave: boolean;
};

/** A footprint jog the elevation gate REFUSED to splice — surfaced for the
 *  caller's notes / suggestion channel instead of being carved into pricing. */
export type BlockedJog = {
  face: string;
  /** Viewer-frame 0..1 position of the jog along that face. */
  position_frac: number;
  /** The face read a clean straight eave ([] + continuous_eave) — the
   *  strongest "roof bridges the wall jog" evidence. */
  straightEave: boolean;
  note: string;
};

/** House-relative face of an axis-aligned edge, in the segments' RASTER
 *  convention (origin top-left, y-down — see pdf-vectors.ts) under the
 *  front-at-bottom drafting convention: front = max-y side, rear = min-y,
 *  right = max-x, left = min-x. Same physical convention as
 *  tier-corner-veto.ts HOUSE_NORMALS. */
function faceOfAxisEdge(
  bbox: { minX: number; maxX: number; minY: number; maxY: number },
  horiz: boolean,
  c: number,
): "front" | "rear" | "left" | "right" {
  if (horiz) return c >= (bbox.minY + bbox.maxY) / 2 ? "front" : "rear";
  return c >= (bbox.minX + bbox.maxX) / 2 ? "right" : "left";
}

/**
 * (b) FOOTPRINT JOG ADOPTION. The foundation/floor plan draws the wall line
 * the gutter follows; when its outline shows a step or notch (≥ ~2 ft) whose
 * shoulders BOTH map into the middle of ONE flat roof-perimeter edge, the
 * roof trace flattened a real jog — adopt it (scaled into roof-sheet space).
 *
 * Correspondence is required to be unambiguous: the two outlines register by
 * bbox (per-axis, ≤20% skew), the flanking footprint walls must lie within
 * 4% of the roof edge's line, and at most 3 jogs are adopted. Anything less
 * clean → null, the trace stands.
 *
 * The roof sheet's OWN linework has the final word: when `segments` are
 * given (the wired path always gives them), a jog is adopted ONLY where the
 * target sub-span of the flat roof edge is UNSUPPORTED by wall-tier strokes
 * — a heavy straight line drawn across the span means the roof genuinely
 * carries flat there (recessed entry alcove, inset corner porch under a
 * continuous roofline) and the trace is RIGHT; foundation articulation must
 * never be carved into it. If the widths can't tier, support can't be
 * assessed → null, the trace stands.
 *
 * `elevationSteps` adds the ELEVATIONS-FIRST gate (see the block comment
 * above): on a face whose elevation reported its eave-line breaks, a jog is
 * spliced only when a break sits within tolerance of it; a refused jog comes
 * back in `blocked` (note + unpriced suggestion — never carved). Faces
 * without elevation data behave exactly as before; the sheet's own linework
 * (`drawnAt`) still has the FIRST word — a drawn-straight span never reaches
 * the elevation gate.
 */
export function adoptFootprintJogs(
  perimeter: Pt[],
  footprintOutline: Pt[],
  segments?: number[][] | null,
  elevationSteps?: ElevationFaceSteps[] | null,
): { perimeter: Pt[]; adopted: number; blocked: BlockedJog[] } | null {
  const n = perimeter.length;
  if (n < 4 || n > 40) return null;
  if (!Array.isArray(footprintOutline) || footprintOutline.length < 5 || footprintOutline.length > 40)
    return null;

  const span = spanOf(perimeter);
  if (!(span > 0)) return null;
  const AXIS_TOL = Math.max(0.75, span * 0.001);

  // Support census pools from the roof sheet (see doc above). `drawnAt`
  // answers: is this sub-span of a roof edge sitting ON drawn wall-tier
  // linework? Then the trace is right there and the jog must not be adopted.
  let drawnAt: (horiz: boolean, c: number, lo: number, hi: number) => boolean;
  if (segments != null) {
    if (!Array.isArray(segments) || segments.length < 4) return null;
    const measured = segments.filter(
      (s) => Array.isArray(s) && s.length >= 5 && Number.isFinite(s[4]) && s[4] > 0,
    );
    if (measured.length < 0.5 * segments.length) return null;
    const distinct = [...new Set(measured.map((s) => Math.round(s[4] * 100) / 100))].sort(
      (a, b) => a - b,
    );
    if (distinct.length < 3) return null;
    const thin = distinct[0];
    const SUPPORT_TOL = span * 0.015;
    const { hs, vs } = axisPools(segments, AXIS_TOL);
    drawnAt = (horiz, c, lo, hi) => {
      if (!(hi - lo > 0)) return true; // degenerate span — treat as drawn (never adopt)
      const near = (horiz ? hs : vs).filter(
        (s) =>
          s.w > thin + 1e-9 &&
          Math.abs(s.c - c) <= SUPPORT_TOL &&
          Math.min(hi, s.hi) - Math.max(lo, s.lo) > 0,
      );
      return unionCoverage(near, lo, hi) >= 0.5 * (hi - lo);
    };
  } else {
    drawnAt = () => false; // no sheet linework supplied — legacy behavior
  }

  const rXs = perimeter.map((p) => p.x);
  const rYs = perimeter.map((p) => p.y);
  const fXs = footprintOutline.map((p) => p.x);
  const fYs = footprintOutline.map((p) => p.y);
  const rw = Math.max(...rXs) - Math.min(...rXs);
  const rh = Math.max(...rYs) - Math.min(...rYs);
  const fw = Math.max(...fXs) - Math.min(...fXs);
  const fh = Math.max(...fYs) - Math.min(...fYs);
  if (!(rw > 0) || !(rh > 0) || !(fw > 0) || !(fh > 0)) return null;
  const sx = rw / fw;
  const sy = rh / fh;
  // Register the footprint onto the roof sheet (align bboxes). The roof
  // outline is walls + overhang, so the per-axis scales should nearly agree;
  // a big skew means these are not the same building massing.
  if (Math.max(sx, sy) / Math.min(sx, sy) > 1.2) return null;
  const mapped: Pt[] = footprintOutline.map((p) => ({
    x: Math.min(...rXs) + (p.x - Math.min(...fXs)) * sx,
    y: Math.min(...rYs) + (p.y - Math.min(...fYs)) * sy,
  }));
  const fpEdges = axisEdges(mapped, Math.max(0.75, span * 0.002));
  if (!fpEdges) return null;

  // ELEVATIONS-FIRST gate (see block comment above adoptFootprintJogs).
  const stepsByFace = new Map<string, ElevationFaceSteps>();
  for (const e of elevationSteps ?? []) {
    if (e && typeof e.face === "string" && Array.isArray(e.steps)) {
      const key = e.face === "back" ? "rear" : e.face;
      stepsByFace.set(key, e);
    }
  }
  const blocked: BlockedJog[] = [];
  /** One face's verdict on a jog: "confirm" = an eave-line break sits within
   *  tolerance (splice allowed), "block" = the face reported the field but
   *  shows NO break there (with the strongest form being a clean straight
   *  eave), "nodata" = that face never reported the field → legacy. */
  type Verdict =
    | { kind: "confirm" | "nodata" }
    | { kind: "block"; blocked: BlockedJog };
  const elevationVerdict = (
    poly: Pt[],
    horiz: boolean,
    c: number,
    lo: number,
    hi: number,
  ): Verdict => {
    if (stepsByFace.size === 0) return { kind: "nodata" }; // legacy
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const bb = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
    const face = faceOfAxisEdge(bb, horiz, c);
    const info = stepsByFace.get(face);
    if (!info) return { kind: "nodata" }; // face never reported the field
    const [axMin, axMax] = horiz ? [bb.minX, bb.maxX] : [bb.minY, bb.maxY];
    const width = axMax - axMin;
    if (!(width > 0)) return { kind: "nodata" };
    // Viewer left→right along the face (y-down raster, front-at-bottom):
    // front reads +x, rear −x, right −y, left +y.
    const flip = face === "rear" || face === "right";
    const fracOf = (v: number) => (flip ? (axMax - v) / width : (v - axMin) / width);
    const vOf = (f: number) => (flip ? axMax - f * width : axMin + f * width);
    const tol = Math.max(span * 0.06, width * 0.06); // ≈4 ft / 6% of the face
    const jLo = Math.min(lo, hi);
    const jHi = Math.max(lo, hi);
    const matched = info.steps.some((s) => {
      const f = s?.position_frac;
      if (typeof f !== "number" || !Number.isFinite(f) || f < 0 || f > 1) return false;
      const v = vOf(f);
      return v >= jLo - tol && v <= jHi + tol;
    });
    if (matched) return { kind: "confirm" };
    const straightEave = info.steps.length === 0 && info.continuous_eave !== false;
    const frac = Math.max(0, Math.min(1, fracOf((jLo + jHi) / 2)));
    const pct = Math.round(frac * 100);
    const note = straightEave
      ? `📐 ELEVATIONS-FIRST: the foundation plan steps on the ${face} side (~${pct}% across), but the ${face} elevation reads one straight, unbroken eave line — the roof may bridge the wall jog, so it was NOT carved into the priced outline. Verify the ${face} roofline; add the return on the canvas if the roof really steps.`
      : `📐 ELEVATIONS-FIRST: the foundation plan steps on the ${face} side (~${pct}% across), but the ${face} elevation's eave-line breaks show no step there — the jog was NOT carved into the priced outline. Verify the ${face} roofline against the elevation.`;
    return { kind: "block", blocked: { face, position_frac: frac, straightEave, note } };
  };
  /** Combine the verdicts of the (up to two) faces a jog's eave-line break is
   *  visible on: ANY confirmation adopts; otherwise any block blocks (roof
   *  wins — the elevations read a straight eave where the wall steps); no
   *  data anywhere → legacy adopt. */
  const combineVerdicts = (verdicts: Verdict[]): BlockedJog | null => {
    if (verdicts.some((v) => v.kind === "confirm")) return null;
    const blocks = verdicts.filter(
      (v): v is Extract<Verdict, { kind: "block" }> => v.kind === "block",
    );
    if (blocks.length === 0) return null; // no data → legacy
    // Prefer the straight-eave reading — it's the decisive contradiction.
    return (blocks.find((b) => b.blocked.straightEave) ?? blocks[0]).blocked;
  };

  const JOG_MIN = span * 0.03; // ≈2 ft on a 64-ft building
  const OFFSET_TOL = span * 0.04; // wall→eave overhang plus registration noise
  const MARGIN = JOG_MIN * 0.5;
  const MAX_ADOPT = 3;

  let cur = perimeter.map((p) => ({ ...p }));
  let adopted = 0;
  // A footprint edge spends itself on ONE adoption — without this, the same
  // articulation (e.g. a masonry fireplace bump) re-fired on the geometry
  // its own splice created (the double-adopt failure).
  const usedFp = new Set<number>();

  for (let round = 0; round < MAX_ADOPT; round++) {
    const redges = axisEdges(cur, AXIS_TOL);
    if (!redges) break;
    const m = fpEdges.length;
    let applied = false;

    // NOTCH pass runs to completion BEFORE any END-STEP is considered: an
    // end-step hypothesis at one corner of a projection can qualify while
    // the correct notch reading sits one index later (the corner-carve
    // failure — a real wall carved inward off both corners).
    for (const pattern of ["notch", "step"] as const) {
      for (let i = 0; i < m && !applied; i++) {
        // Footprint pattern around edge i: run A (i), step S1 (i+1), run B (i+2)…
        if ([i, (i + 1) % m, (i + 2) % m].some((ix) => usedFp.has(ix))) continue;
        const A = fpEdges[i];
        const S1 = fpEdges[(i + 1) % m];
        const B = fpEdges[(i + 2) % m];
        if (A.horiz === S1.horiz || A.horiz !== B.horiz) continue;
        if (A.len < JOG_MIN || B.len < JOG_MIN) continue;
        const d1 = B.c - A.c; // signed step depth in registered space
        if (Math.abs(d1) < JOG_MIN) continue;
        // A genuine step/notch WALL between two runs is as long as the
        // offset it spans — a "step" edge running far past that is itself a
        // run (an entire wall misread as the step: the corner-carve bug).
        if (S1.len > Math.abs(d1) + Math.max(JOG_MIN, Math.abs(d1) * 0.5)) continue;

        if (pattern === "notch") {
          // NOTCH: …step S2 (i+3), run C (i+4) back on A's line. Adopt B's span
          // as an inset/outset strip in the middle of one flat roof edge.
          const S2 = fpEdges[(i + 3) % m];
          const C = fpEdges[(i + 4) % m];
          const isNotch =
            S2.horiz === S1.horiz &&
            C.horiz === A.horiz &&
            C.len >= JOG_MIN &&
            Math.abs(C.c - A.c) <= Math.min(OFFSET_TOL, Math.abs(d1) * 0.5);
          if (!isNotch) continue;
          const u1 = B.lo;
          const u2 = B.hi;
          for (let k = 0; k < redges.length; k++) {
            const E = redges[k];
            if (E.horiz !== A.horiz) continue;
            if (!(u1 > E.lo + MARGIN && u2 < E.hi - MARGIN)) continue;
            if (Math.abs(E.c - A.c) > OFFSET_TOL) continue;
            // The roof sheet drew this sub-span as-is → the trace is right.
            if (drawnAt(E.horiz, E.c, u1, u2)) continue;
            // ELEVATIONS-FIRST: a mid-wall notch's eave-line breaks (at u1
            // and u2) show on the face of E — that face's elevation must not
            // contradict the splice.
            const veto = combineVerdicts([
              elevationVerdict(cur, E.horiz, E.c, u1, u1),
              elevationVerdict(cur, E.horiz, E.c, u2, u2),
            ]);
            if (veto) {
              blocked.push(veto);
              for (let s = 0; s < 5; s++) usedFp.add((i + s) % m);
              break; // this footprint jog is decided — never spliced
            }
            // Insert the notch: sub-span [u1,u2] moves to E.c + d1.
            const a = cur[k];
            const b = cur[(k + 1) % cur.length];
            const forward = E.horiz ? b.x > a.x : b.y > a.y;
            const mk = (u: number, c: number): Pt => (E.horiz ? { x: u, y: c } : { x: c, y: u });
            const ins = forward
              ? [mk(u1, E.c), mk(u1, E.c + d1), mk(u2, E.c + d1), mk(u2, E.c)]
              : [mk(u2, E.c), mk(u2, E.c + d1), mk(u1, E.c + d1), mk(u1, E.c)];
            cur = [...cur.slice(0, k + 1), ...ins, ...cur.slice(k + 1)];
            adopted++;
            applied = true;
            for (let s = 0; s < 5; s++) usedFp.add((i + s) % m);
            break;
          }
          if (applied) break;
          continue;
        }

        // END-STEP: one of the two runs carries through to the roof edge's far
        // end — the whole far side of the flat edge sits on the wrong line.
        // A genuine step has A and B extending in OPPOSITE directions from it
        // (two sides of a U-shaped recess both extend the SAME way — that is a
        // notch wall pair, never a step in one wall line). Try both hypotheses
        // (roof edge on A's line with B offset, and the mirror); require
        // EXACTLY ONE to qualify (ambiguity → keep the trace). Splitting at
        // the step and moving the far sub-span also relocates a mis-placed
        // step: the old corner collapses in the cleanup pass.
        const uPos = S1.c; // the perpendicular step's position along the runs
        const sideOf = (run: { lo: number; hi: number }): "lo" | "hi" | null =>
          run.lo >= uPos - AXIS_TOL * 2 ? "hi" : run.hi <= uPos + AXIS_TOL * 2 ? "lo" : null;
        const aSide = sideOf(A);
        const bSide = sideOf(B);
        if (!aSide || !bSide || aSide === bSide) continue;
        for (let k = 0; k < redges.length && !applied; k++) {
          const E = redges[k];
          if (E.horiz !== A.horiz) continue;
          if (!(uPos > E.lo + MARGIN && uPos < E.hi - MARGIN)) continue;
          type Hyp = { d: number; farSide: "lo" | "hi" };
          const hyps: Hyp[] = [];
          for (const [near, far] of [
            [A, B],
            [B, A],
          ] as const) {
            if (Math.abs(E.c - near.c) > OFFSET_TOL) continue;
            // The far run must extend from the step through E's far end.
            const farSide = far === B ? bSide : aSide;
            const farEnd = farSide === "hi" ? E.hi : E.lo;
            const farReach = farSide === "hi" ? far.hi : far.lo;
            if (Math.abs(farReach - farEnd) > OFFSET_TOL) continue;
            hyps.push({ d: far.c - near.c, farSide });
          }
          if (hyps.length !== 1) continue;
          const { d, farSide } = hyps[0];
          // The roof sheet drew the far sub-span where the trace put it →
          // the roof genuinely runs flat through; never carve it.
          if (
            drawnAt(
              E.horiz,
              E.c,
              farSide === "hi" ? uPos : E.lo,
              farSide === "hi" ? E.hi : uPos,
            )
          )
            continue;
          // ELEVATIONS-FIRST: an end-step jog's eave-line break is visible on
          // TWO elevations — the face of E (break at uPos along E's axis) and
          // the perpendicular face on the moved sub-span's side (a depth break
          // at the NEW plane coordinate E.c + d). E.g. a front-eave step reads
          // both on the front elevation (fascia depth break at uPos) and on
          // the side elevation the moved span faces. Either confirming
          // adopts; a contradiction with no confirmation blocks.
          {
            const movedMid = farSide === "hi" ? (uPos + E.hi) / 2 : (E.lo + uPos) / 2;
            const veto = combineVerdicts([
              elevationVerdict(cur, E.horiz, E.c, uPos, uPos),
              elevationVerdict(cur, !E.horiz, movedMid, E.c + d, E.c + d),
            ]);
            if (veto) {
              blocked.push(veto);
              for (let s = 0; s < 3; s++) usedFp.add((i + s) % m);
              break; // decided — never spliced
            }
          }
          const a = cur[k];
          const b = cur[(k + 1) % cur.length];
          const forward = E.horiz ? b.x > a.x : b.y > a.y; // a at lo when forward
          const mk = (uu: number, c: number): Pt => (E.horiz ? { x: uu, y: c } : { x: c, y: uu });
          // Move the far sub-span to E.c + d: insert the step corners and move
          // the far endpoint of E onto the new line (its neighbor edge is
          // perpendicular, so it stays axis-aligned).
          const farIsEnd = (forward && farSide === "hi") || (!forward && farSide === "lo");
          const next = [...cur];
          if (farIsEnd) {
            const endIdx = (k + 1) % cur.length;
            const moved = { ...cur[endIdx] };
            if (E.horiz) moved.y = E.c + d;
            else moved.x = E.c + d;
            next[endIdx] = moved;
            cur = [...next.slice(0, k + 1), mk(uPos, E.c), mk(uPos, E.c + d), ...next.slice(k + 1)];
          } else {
            const moved = { ...cur[k] };
            if (E.horiz) moved.y = E.c + d;
            else moved.x = E.c + d;
            next[k] = moved;
            cur = [...next.slice(0, k + 1), mk(uPos, E.c + d), mk(uPos, E.c), ...next.slice(k + 1)];
          }
          adopted++;
          applied = true;
          for (let s = 0; s < 3; s++) usedFp.add((i + s) % m);
        }
        if (applied) break;
      }
      if (applied) break;
    }
    if (!applied) break;
  }

  if (adopted === 0) {
    // Nothing spliced. A jog the elevations REFUSED still surfaces (note +
    // unpriced suggestion channel); with none of those either, legacy null.
    return blocked.length > 0 ? { perimeter, adopted: 0, blocked } : null;
  }
  // Collapse duplicate/collinear corners the splices left behind; validate.
  const cleaned = snapAndClean(cur, Math.max(0.75, span * 0.004));
  if (cleaned.length < 4 || cleaned.length > 40) return null;
  if (!isSimplePolygon(cleaned)) return null;
  const ratio = polyArea(cleaned) / Math.max(1e-9, polyArea(perimeter));
  if (ratio < 0.75 || ratio > 1.25) return null;
  return { perimeter: cleaned, adopted, blocked };
}

export type PerimeterRepair = {
  perimeter: Pt[];
  snappedEdges: number;
  jogsAdopted: number;
  /** On-panel notes explaining exactly what moved — the caller appends them. */
  notes: string[];
  /** Footprint jogs the ELEVATIONS-FIRST gate refused to splice (straight
   *  eave read where the foundation steps): suggest-don't-carve. Their notes
   *  are already merged into `notes`; the structured entries ride here for a
   *  future tap-to-add channel. Absent when the gate never fired. */
  suggestedReturns?: BlockedJog[];
};

/**
 * Cross-validate the traced roof perimeter against the sheet's own heavy
 * linework (phantom-pocket rejection) and the foundation-plan outline (jog
 * adoption). Null = nothing fired / not trustworthy — the caller keeps the
 * traced perimeter EXACTLY as-is (today's behavior). Never throws.
 */
export function reconcileRoofPerimeter(opts: {
  perimeter: Pt[];
  /** Roof-sheet selected segments (5-tuples with stroke width when known). */
  segments: number[][];
  /** The foundation/floor-plan outline in ITS OWN page space (optional). */
  footprintOutline?: Pt[] | null;
  /** Per-face eave-line breaks from the elevation reads (elevations-first jog
   *  gate — see adoptFootprintJogs). Null/absent = legacy behavior. */
  elevationSteps?: ElevationFaceSteps[] | null;
}): PerimeterRepair | null {
  try {
    let perimeter = opts.perimeter;
    let snappedEdges = 0;
    let jogsAdopted = 0;
    let blocked: BlockedJog[] = [];

    const snap = snapPhantomEdges(perimeter, opts.segments);
    if (snap) {
      perimeter = snap.perimeter;
      snappedEdges = snap.snapped;
    }
    if (opts.footprintOutline && opts.footprintOutline.length >= 5) {
      // The roof sheet's own linework gates every adoption: a sub-span the
      // sheet DREW straight (heavy) stays — only unsupported flat spans may
      // take a foundation jog. The elevations' eave-line reads gate what's
      // left (elevations-first): a refused jog surfaces in `blocked`.
      const jogs = adoptFootprintJogs(
        perimeter,
        opts.footprintOutline,
        opts.segments,
        opts.elevationSteps ?? null,
      );
      if (jogs) {
        perimeter = jogs.perimeter;
        jogsAdopted = jogs.adopted;
        blocked = jogs.blocked ?? [];
      }
    }
    const changed = snappedEdges > 0 || jogsAdopted > 0;
    if (!changed && blocked.length === 0) return null;
    if (changed) {
      // A clean rectangle IS a valid repair (the articulation was all
      // phantom); anything under 4 corners or over 40 is not a building.
      if (perimeter.length < 4 || perimeter.length > 40) return null;
      if (perimeter === opts.perimeter) return null;
    }

    const notes: string[] = [];
    for (const b of blocked) notes.push(b.note);
    if (!changed) {
      // Elevation-vetoed jog(s) only — the traced perimeter stands verbatim,
      // the refusals ride the notes + suggestedReturns channels.
      return {
        perimeter: opts.perimeter,
        snappedEdges: 0,
        jogsAdopted: 0,
        notes,
        suggestedReturns: blocked,
      };
    }
    if (jogsAdopted > 0 && snappedEdges > 0) {
      notes.push(
        `📐 Outline check: the roof-sheet trace missed ${jogsAdopted} jog(s) drawn on the foundation plan — adopted them, and ${snappedEdges} traced edge(s) that sat on dimension/leader lines (not drawn roof edges) were snapped back onto the sheet's heavy roof linework. Verify the outline against the foundation page.`,
      );
    } else if (jogsAdopted > 0) {
      notes.push(
        `📐 Outline check: the roof-sheet trace missed ${jogsAdopted} jog(s) drawn on the foundation plan — adopted them. Verify the outline against the foundation page.`,
      );
    } else {
      notes.push(
        `📐 Outline check: ${snappedEdges} traced edge(s) sat on dimension/leader lines, not drawn roof edges — snapped back onto the sheet's heavy roof linework (phantom strips removed). Verify the outline against the roof sheet.`,
      );
    }
    return {
      perimeter,
      snappedEdges,
      jogsAdopted,
      notes,
      ...(blocked.length > 0 ? { suggestedReturns: blocked } : {}),
    };
  } catch {
    return null;
  }
}
