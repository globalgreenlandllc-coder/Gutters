/**
 * dim-scale.ts — solve the sheet's TRUE pt-per-foot from its own dimension
 * lines instead of trusting a title-block scale note or snapping a bbox to a
 * "standard" scale (the v1 bug: the outline bbox over-reaches through leader
 * lines, so the snap picked 24 pt/ft on an 18 pt/ft sheet — and exported PDFs
 * aren't even guaranteed to be at a nominal print size).
 *
 * A dimension LINE cannot lie: its tick-to-tick span in pt, divided by its
 * printed value in feet, IS the scale. The span comes from vector geometry
 * (this module, deterministic); the printed value is outlined glyphs on these
 * sheets, so the edge classifier reads it with vision (each candidate gets a
 * D-chip on the overlay). PURE — node-testable.
 */

import type { DimSpanCandidate, OverlayPt } from "./plan-overlay";

/**
 * Find axis-aligned spans that look like DIMENSION LINES for the building:
 * they run just OUTSIDE the outline's bbox (dimension strings sit off the
 * building), are long (a meaningful fraction of the building), and are the
 * THINNEST stroke tier on the sheet when widths are known (dims ≈ 0.3 pt vs
 * walls ≥ 0.8 pt on these sets). Returns up to `max` candidates, longest
 * first, labeled D1…Dn.
 */
export function findDimSpanCandidates(
  segments: readonly number[][],
  outline: readonly OverlayPt[],
  max = 4,
  opts?: {
    /** Page size in pt — spans hugging the page border (the sheet FRAME)
     *  are rejected; a frame is exactly the long thin outside-the-building
     *  line this search would otherwise love. */
    pageW?: number;
    pageH?: number;
    /** Offset for candidate ids (D3… when a prior page already used D1-D2). */
    idOffset?: number;
  },
): DimSpanCandidate[] {
  if (!outline || outline.length < 3) return [];
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const span = Math.max(spanX, spanY);
  if (span <= 0) return [];

  // Thin-stroke gate when widths are present (5th tuple element). Dimension
  // linework is the thinnest tier on a CAD sheet.
  const widths = segments
    .filter((s) => s.length >= 5 && Number.isFinite(s[4]))
    .map((s) => s[4]);
  widths.sort((a, b) => a - b);
  const thinCap = widths.length > 0 ? widths[Math.floor(widths.length * 0.25)] : null;

  const band = span * 0.3; // how far outside the bbox a dim line may sit
  const out: { p1: OverlayPt; p2: OverlayPt; spanPt: number; axis: "h" | "v" }[] = [];

  for (const s of segments) {
    if (!Array.isArray(s) || s.length < 4) continue;
    const [x1, y1, x2, y2] = s;
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    if (thinCap != null && s.length >= 5 && Number.isFinite(s[4]) && s[4] > thinCap * 1.5) {
      continue; // heavier than the thin tier — wall/roof linework, not a dim
    }
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const horizontal = dx >= 20 * Math.max(dy, 0.01);
    const vertical = dy >= 20 * Math.max(dx, 0.01);
    if (!horizontal && !vertical) continue;
    const len = Math.hypot(dx, dy);

    // Sheet-frame rejection: a span whose fixed coordinate sits within 6% of
    // the page border is the drawing frame / title-block rule, not a dim.
    if (opts?.pageW && opts?.pageH) {
      const fx = (x1 + x2) / 2;
      const fy = (y1 + y2) / 2;
      const mx = opts.pageW * 0.06;
      const my = opts.pageH * 0.06;
      if (
        (vertical && (fx < mx || fx > opts.pageW - mx)) ||
        (horizontal && (fy < my || fy > opts.pageH - my))
      ) {
        continue;
      }
    }

    if (horizontal) {
      // Long enough to be an overall/major dim, and OUTSIDE the bbox rows.
      if (len < spanX * 0.45 || len > spanX * 1.15) continue;
      const y = (y1 + y2) / 2;
      const outside = y < minY - span * 0.01 || y > maxY + span * 0.01;
      if (!outside || y < minY - band || y > maxY + band) continue;
      out.push({
        p1: { x: Math.min(x1, x2), y },
        p2: { x: Math.max(x1, x2), y },
        spanPt: len,
        axis: "h",
      });
    } else if (vertical) {
      if (len < spanY * 0.45 || len > spanY * 1.15) continue;
      const x = (x1 + x2) / 2;
      const outside = x < minX - span * 0.01 || x > maxX + span * 0.01;
      if (!outside || x < minX - band || x > maxX + band) continue;
      out.push({
        p1: { x, y: Math.min(y1, y2) },
        p2: { x, y: Math.max(y1, y2) },
        spanPt: len,
        axis: "v",
      });
    }
  }

  // Dedupe near-identical spans (dimension chains re-draw the same line).
  out.sort((a, b) => b.spanPt - a.spanPt);
  const picked: typeof out = [];
  for (const c of out) {
    const dup = picked.some(
      (p) =>
        p.axis === c.axis &&
        Math.abs(p.spanPt - c.spanPt) < span * 0.02 &&
        Math.hypot(p.p1.x - c.p1.x, p.p1.y - c.p1.y) < span * 0.05,
    );
    if (!dup) picked.push(c);
    if (picked.length >= max) break;
  }
  const off = opts?.idOffset ?? 0;
  return picked.map((c, i) => ({ id: `D${off + i + 1}`, ...c }));
}

/**
 * Solve pt/ft from the classifier's read dimension values. Each (candidate,
 * feet) pair yields spanPt/feet; consistent pairs (within 7% of the median)
 * vote, and the median of the survivors wins. Returns null when nothing
 * consistent was read — the caller falls back rather than guessing.
 */
export function solvePtPerFt(
  candidates: readonly DimSpanCandidate[],
  readValues: readonly { id: string; feet: number | null }[],
): { ptPerFt: number; used: string[] } | null {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const pairs: { id: string; ptPerFt: number }[] = [];
  for (const r of readValues) {
    if (r.feet == null || !Number.isFinite(r.feet) || r.feet < 8 || r.feet > 250) continue;
    const c = byId.get(r.id);
    if (!c) continue;
    pairs.push({ id: r.id, ptPerFt: c.spanPt / r.feet });
  }
  if (pairs.length === 0) return null;
  const sorted = [...pairs].sort((a, b) => a.ptPerFt - b.ptPerFt);
  const median = sorted[Math.floor(sorted.length / 2)].ptPerFt;
  const consistent = pairs.filter(
    (p) => Math.abs(p.ptPerFt - median) / median <= 0.07,
  );
  if (consistent.length === 0) return null;
  const cs = consistent.map((p) => p.ptPerFt).sort((a, b) => a - b);
  return {
    ptPerFt: cs[Math.floor(cs.length / 2)],
    used: consistent.map((p) => p.id),
  };
}
