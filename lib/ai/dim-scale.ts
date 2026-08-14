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
 * walls ≥ 0.8 pt on these sets).
 *
 * Rails AND tick-to-tick sub-spans: the segment extractor chain-merges a
 * dimension CHAIN into one long rail (the Woodinville bug — every candidate
 * was a ~1200-pt full-chain rail, so vision paired a 65.9-ft chain with the
 * printed "51'-0 OVERALL" → 23.27 pt/ft on an 18 pt/ft sheet). The chain's
 * TICKS are still on the sheet as strokes crossing the rail near-
 * perpendicular (witness/extension lines), so each rail is also SPLIT at its
 * tick crossings and the building-scale sub-spans become chips too. The full
 * rail stays — overall rows are legit full-extent dims. Returns up to
 * `max` rails + up to `max` sub-spans (longest first within each group),
 * labeled D1…Dn.
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
  const dup = (list: typeof out, c: (typeof out)[number]) =>
    list.some(
      (p) =>
        p.axis === c.axis &&
        Math.abs(p.spanPt - c.spanPt) < span * 0.02 &&
        Math.hypot(p.p1.x - c.p1.x, p.p1.y - c.p1.y) < span * 0.05,
    );
  const picked: typeof out = [];
  for (const c of out) {
    if (!dup(picked, c)) picked.push(c);
    if (picked.length >= max) break;
  }

  // Tick-to-tick sub-spans: split every rail (pre-dedupe — a stacked chain
  // row deduped away still contributes its ticks) at near-perpendicular
  // crossings. A crossing must actually REACH the rail line, so wall/hatch
  // strokes inside the building never register (rails sit outside the bbox).
  const TICK_TOUCH = 3; // pt — how close a crossing stroke must come to the rail
  const TICK_MERGE = 2; // pt — crossings closer than this are one tick
  const subMin = Math.max(40, span * 0.05); // building-scale dims only
  const subs: typeof out = [];
  for (const rail of out.slice(0, 12)) {
    const horiz = rail.axis === "h";
    const c = horiz ? rail.p1.y : rail.p1.x;
    const lo = horiz ? rail.p1.x : rail.p1.y;
    const hi = horiz ? rail.p2.x : rail.p2.y;
    const ticks: number[] = [lo, hi]; // a rail terminates at ticks
    for (const s of segments) {
      if (!Array.isArray(s) || s.length < 4) continue;
      const [x1, y1, x2, y2] = s;
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
      if (thinCap != null && s.length >= 5 && Number.isFinite(s[4]) && s[4] > thinCap * 1.5) {
        continue; // dim furniture is thin, like the rail itself
      }
      const dx = Math.abs(x2 - x1);
      const dy = Math.abs(y2 - y1);
      const perp = horiz ? dy >= 4 * Math.max(dx, 0.01) : dx >= 4 * Math.max(dy, 0.01);
      if (!perp) continue;
      const t = horiz ? (x1 + x2) / 2 : (y1 + y2) / 2;
      if (t < lo - TICK_TOUCH || t > hi + TICK_TOUCH) continue;
      const a = horiz ? Math.min(y1, y2) : Math.min(x1, x2);
      const b = horiz ? Math.max(y1, y2) : Math.max(x1, x2);
      if (a > c + TICK_TOUCH || b < c - TICK_TOUCH) continue; // never reaches the rail
      ticks.push(Math.min(Math.max(t, lo), hi));
    }
    ticks.sort((m, n) => m - n);
    const merged: number[] = [];
    for (const t of ticks) {
      if (merged.length === 0 || t - merged[merged.length - 1] > TICK_MERGE) merged.push(t);
    }
    if (merged.length > 40) continue; // hatch-dense rail — crossings unreliable
    for (let i = 1; i < merged.length; i++) {
      const d = merged[i] - merged[i - 1];
      if (d < subMin || d > rail.spanPt * 0.9) continue; // full rail is already a chip
      subs.push({
        p1: horiz ? { x: merged[i - 1], y: c } : { x: c, y: merged[i - 1] },
        p2: horiz ? { x: merged[i], y: c } : { x: c, y: merged[i] },
        spanPt: d,
        axis: rail.axis,
      });
    }
  }
  subs.sort((a, b) => b.spanPt - a.spanPt); // prefer building-scale sub-spans
  const all = [...picked];
  for (const c of subs) {
    if (all.length >= max * 2) break; // sensible total-chip cap
    if (!dup(all, c)) all.push(c);
  }
  const off = opts?.idOffset ?? 0;
  return all.map((c, i) => ({ id: `D${off + i + 1}`, ...c }));
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

/** Standard ARCH sheet scales in pt per foot, 1"=1' down to 1/12"=1'
 *  (72, 1/2"=36, 3/8"=27, 1/3"=24, 1/4"=18, 3/16"=13.5, 1/6"=12, 1/8"=9,
 *  3/32"=6.75, 1/12"=6). A real plan sheet prints at one of these. */
export const STANDARD_SHEET_SCALES_PT_PER_FT = [
  72, 36, 27, 24, 18, 13.5, 12, 9, 6.75, 6,
] as const;

// Anchor tolerances. Roof/eave outlines overhang the walls ~2 ft a side and
// foundation outlines add footing width, so the implied extent legitimately
// overshoots the printed overall by a few feet — 12% covers it while still
// rejecting a 1.3× scale alias (adjacent standard scales sit 12.5-33% apart).
const ANCHOR_TOL = 0.12;
// An anchor read must be a building OVERALL. Two eligibility gates:
//  • its D-chip must span (nearly) the full building extent along its axis —
//    tick-to-tick SUB-SPAN chips (garage doors, room dims) and misread
//    slivers can never anchor, so one misread chip the solve already
//    rejected can't overturn a correct solve;
//  • it must be at least a small building across — a 16-ft door dim read in
//    isolation is not an overall even when its chip span is unknown.
const ANCHOR_RAIL_MIN_FRAC = 0.6;
const ANCHOR_MIN_FT = 24;

/** One vision dim read for the anchor gate. Bare numbers stay accepted
 *  (legacy callers/tests); the classifier wiring passes the chip span+axis
 *  so sub-span chips are excluded from anchoring. */
export type ScaleAnchorRead =
  | number
  | null
  | {
      feet: number | null;
      /** pt length of the D-chip this value was read from (null = unknown). */
      spanPt?: number | null;
      /** Chip axis on the sheet — scopes the full-rail check per axis. */
      axis?: "h" | "v" | null;
    };

export type ScaleAnchorResult = {
  /** false = nothing to check (no building-sized overall reads / degenerate
   *  bbox) — the solve is untouched. */
  checked: boolean;
  verdict: "kept" | "corrected" | "unanchored" | "ambiguous";
  /** The scale to USE: the solve, or the one anchored standard scale. */
  ptPerFt: number;
  solvedPtPerFt: number;
  /** The largest ELIGIBLE read (a full-rail building overall), the anchor. */
  anchorFt: number | null;
  /** Long-axis extent in ft implied by the SOLVED scale. */
  solvedLongFt: number | null;
  /** Long-axis extent in ft implied by the corrected scale (when corrected). */
  correctedLongFt: number | null;
  /** Standard scales that landed on the anchor (either bbox axis). */
  anchoredStandards: number[];
};

/**
 * Post-solve sanity gate for the dimension-line scale. The solve is
 * spanPt ÷ vision-read value, so ONE mispaired chip rescales every priced
 * run — but the read VALUES themselves are printed truth, and the outline
 * bbox at the true scale must land near the largest full-rail read (the
 * building overall). Deterministic, no vision:
 *
 *   anchor = the largest ELIGIBLE read: building-sized (≥24 ft) AND read off
 *     a chip spanning ≥60% of the bbox extent along its axis (sub-span tick
 *     chips and misread slivers never anchor — solvePtPerFt's own outlier
 *     rejection must not be overturned by a chip it rejected);
 *   the anchor may land on EITHER bbox axis — projections (porches/patios)
 *     legitimately stretch one axis far past the printed overall, so the
 *     overall matches whichever axis the body defines;
 *   solved scale anchored → KEEP;
 *   not anchored + EXACTLY ONE standard sheet scale anchored → CORRECT to it;
 *   zero / multiple anchored → KEEP the solve, caller flags it (a former
 *     short-axis tie-break could convert this ambiguity into a false
 *     correction — removed; ambiguity always keeps the solve).
 *
 * NEVER corrects without an eligible overall read — `checked:false` and the
 * solve stands.
 */
export function anchorSolvedScale(
  solvedPtPerFt: number,
  outline: readonly OverlayPt[],
  dimReads: readonly ScaleAnchorRead[],
): ScaleAnchorResult {
  const untouched: ScaleAnchorResult = {
    checked: false,
    verdict: "kept",
    ptPerFt: solvedPtPerFt,
    solvedPtPerFt,
    anchorFt: null,
    solvedLongFt: null,
    correctedLongFt: null,
    anchoredStandards: [],
  };
  if (!Number.isFinite(solvedPtPerFt) || solvedPtPerFt <= 0) return untouched;
  if (!outline || outline.length < 3) return untouched;

  // Building-plausible reads only — same window as solvePtPerFt.
  const reads = dimReads
    .map((r) =>
      typeof r === "number" || r == null
        ? { feet: r, spanPt: null as number | null, axis: null as "h" | "v" | null }
        : { feet: r.feet ?? null, spanPt: r.spanPt ?? null, axis: r.axis ?? null },
    )
    .filter(
      (r): r is { feet: number; spanPt: number | null; axis: "h" | "v" | null } =>
        r.feet != null && Number.isFinite(r.feet) && r.feet >= 8 && r.feet <= 250,
    );
  if (reads.length === 0) return untouched;

  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const bboxLong = Math.max(spanX, spanY);
  const bboxShort = Math.min(spanX, spanY);
  if (!(bboxLong > 0)) return untouched;

  // Anchor eligibility: full-rail, building-sized reads only.
  const extentFor = (axis: "h" | "v" | null) =>
    axis === "h" ? spanX : axis === "v" ? spanY : bboxShort;
  const eligible = reads.filter(
    (r) =>
      r.feet >= ANCHOR_MIN_FT &&
      (r.spanPt == null || r.spanPt >= ANCHOR_RAIL_MIN_FRAC * extentFor(r.axis)),
  );
  if (eligible.length === 0) return untouched;

  const anchorFt = Math.max(...eligible.map((r) => r.feet));
  const impliedLong = (s: number) => bboxLong / s;
  // Either axis may carry the overall: projections stretch ONE axis far past
  // the printed overall (a rear patio adds ~20 ft of depth), so the printed
  // width then matches the bbox SHORT axis — long-axis-only anchoring both
  // missed true corrections and manufactured false ones.
  const anchored = (s: number) =>
    Math.abs(bboxLong / s - anchorFt) / anchorFt <= ANCHOR_TOL ||
    (bboxShort > 0 && Math.abs(bboxShort / s - anchorFt) / anchorFt <= ANCHOR_TOL);
  const round1 = (v: number) => Math.round(v * 10) / 10;

  const base: ScaleAnchorResult = {
    ...untouched,
    checked: true,
    anchorFt,
    solvedLongFt: round1(impliedLong(solvedPtPerFt)),
  };
  if (anchored(solvedPtPerFt)) return base; // verdict "kept"

  const hits = STANDARD_SHEET_SCALES_PT_PER_FT.filter(anchored);
  if (hits.length === 1) {
    return {
      ...base,
      verdict: "corrected",
      ptPerFt: hits[0],
      correctedLongFt: round1(impliedLong(hits[0])),
      anchoredStandards: [...hits],
    };
  }
  return {
    ...base,
    verdict: hits.length === 0 ? "unanchored" : "ambiguous",
    anchoredStandards: [...hits],
  };
}

/**
 * Cross-check a solved pt/ft against the sheet's PRINTED overall dimensions
 * (deterministically extracted text — no vision in the loop). The dimension-
 * line solve is span÷printed-value, so a vision misread of one D-chip value
 * scales EVERY priced run; but the text layer still carries the true
 * "64'-0" OVERALL" strings, and the outline's own bbox at the solved scale
 * must land near one of them. FLAG-ONLY: the caller notes a mismatch for
 * review, it never rescales pricing on its own.
 */
export function crossCheckScaleAgainstOveralls(
  ptPerFt: number,
  outline: readonly OverlayPt[],
  dimStrings: readonly string[] | null | undefined,
): {
  checked: boolean;
  consistent: boolean;
  impliedWFt: number;
  impliedHFt: number;
  bestOverallFt: number | null;
  mismatchPct: number | null;
} {
  const none = {
    checked: false,
    consistent: true,
    impliedWFt: 0,
    impliedHFt: 0,
    bestOverallFt: null,
    mismatchPct: null,
  };
  if (!Number.isFinite(ptPerFt) || ptPerFt <= 0) return none;
  if (!outline || outline.length < 3 || !dimStrings || dimStrings.length === 0) return none;

  const feet: number[] = [];
  for (const s of dimStrings) {
    for (const m of String(s).matchAll(/(\d{2,3})\s*['’](?:\s*-?\s*(\d{1,2}))?/g)) {
      const ft = Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0);
      if (ft >= 20 && ft <= 200) feet.push(ft);
    }
  }
  if (feet.length === 0) return none;

  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const impliedWFt = (Math.max(...xs) - Math.min(...xs)) / ptPerFt;
  const impliedHFt = (Math.max(...ys) - Math.min(...ys)) / ptPerFt;
  const long = Math.max(impliedWFt, impliedHFt);
  const short = Math.min(impliedWFt, impliedHFt);
  if (!(long > 0)) return none;

  // BOTH axes must land near SOME printed building-sized value. One axis
  // alone can alias: a 29%-inflated scale reads the 64-ft width as 49.5 ft,
  // which sits innocently next to the printed 51-ft DEPTH — but then the
  // implied depth (39.5) matches nothing. A small porch/bay overrun is
  // normal; a 15%+ residual on an axis means the solve read a wrong value.
  const bestFor = (extent: number): { ft: number; err: number } | null => {
    let best: { ft: number; err: number } | null = null;
    for (const ft of feet) {
      const err = Math.abs(extent - ft) / ft;
      if (!best || err < best.err) best = { ft, err };
    }
    return best;
  };
  const bLong = bestFor(long);
  if (!bLong) return none;
  const distinct = new Set(feet.map((f) => Math.round(f))).size;
  const bShort = distinct >= 2 && short > 0 ? bestFor(short) : null;
  const worstErr = Math.max(bLong.err, bShort?.err ?? 0);
  return {
    checked: true,
    consistent: worstErr <= 0.15,
    impliedWFt: Math.round(impliedWFt * 10) / 10,
    impliedHFt: Math.round(impliedHFt * 10) / 10,
    bestOverallFt: bLong.ft,
    mismatchPct: Math.round(worstErr * 100),
  };
}
