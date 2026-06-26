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

import { extractBuildingOutline, type Pt } from "./outline-from-vectors";

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
