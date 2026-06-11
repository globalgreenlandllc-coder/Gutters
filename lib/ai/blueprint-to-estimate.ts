import "server-only";
import type {
  BlueprintAnalysis,
  BlueprintPoint,
} from "./blueprint-from-plans";
import type { EstimateResult } from "./index";
import type { Downspout, EditableLine, Stories } from "@/lib/types";
import { PX_PER_FT } from "@/components/estimate/aerial-shared";

/**
 * Bridge between the plan-vision pipeline (Claude) and the address-vision
 * pipeline (SAM-2 + Solar). Both pipelines need to feed the same
 * `<ResultsView>` so the contractor's "Save proposal" / "Send proposal"
 * flow doesn't fork.
 *
 * Plan coordinates come in as raw source-image pixels (the page Claude
 * read). The estimate canvas is a 900×580 viewBox. We fit-to-viewBox the
 * union of every point we know about (footprint + gutter runs + downspouts
 * + excluded edges) so the proposal canvas shows the layout exactly the
 * way the contractor saw it in the blueprint preview.
 */

const VIEWBOX_W = 900;
const VIEWBOX_H = 580;
const MARGIN_PCT = 0.08;

/**
 * IQR-based outlier filter on a 2D point set. Drops points whose x or
 * y lies more than 3×IQR outside the [Q1, Q3] range — generous enough
 * to keep all legitimate building coordinates, strict enough to reject
 * sentinel/page-bounds artifacts that the AI sometimes mixes into
 * building_footprint or excluded_edges.
 */
function filterOutliers(points: readonly BlueprintPoint[]): BlueprintPoint[] {
  if (points.length < 4) return [...points];
  const xs = points.map((p) => p.x).sort((a, b) => a - b);
  const ys = points.map((p) => p.y).sort((a, b) => a - b);
  const q = (arr: number[], pct: number) =>
    arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * pct)))];
  const xQ1 = q(xs, 0.25);
  const xQ3 = q(xs, 0.75);
  const yQ1 = q(ys, 0.25);
  const yQ3 = q(ys, 0.75);
  const xIQR = Math.max(1, xQ3 - xQ1);
  const yIQR = Math.max(1, yQ3 - yQ1);
  const xMin = xQ1 - 3 * xIQR;
  const xMax = xQ3 + 3 * xIQR;
  const yMin = yQ1 - 3 * yIQR;
  const yMax = yQ3 + 3 * yIQR;
  const kept = points.filter(
    (p) => p.x >= xMin && p.x <= xMax && p.y >= yMin && p.y <= yMax,
  );
  // If we'd reject everything, give up and return original — fail
  // safe rather than producing an empty bbox.
  return kept.length >= Math.max(2, points.length * 0.5) ? kept : [...points];
}

/**
 * Feet-aware projection from raw PDF-pixel coordinates onto the
 * 900×580 canvas viewBox.
 *
 * Why this needs to be feet-aware: the canvas's live-pricing
 * recompute (`lineLengthFt` in aerial-shared.tsx) divides
 * canvas-pixel distance by the global PX_PER_FT constant. For the
 * satellite (aerial) flow that constant is calibrated to the
 * fixed-zoom imagery. For plan takeoffs the raw input pixels come
 * from whatever DPI the PDF was rendered at — totally arbitrary.
 *
 * If we naively fit-to-viewBox (old behavior), the contractor sees a
 * pretty trace but the displayed feet are nonsense: a building the
 * AI sized at 210 LF gutter ends up reading 805 LF on the canvas
 * because viewBox-pixels ÷ 2.4 has no relationship to plan scale.
 *
 * The fix: derive a single feet-per-PDF-pixel ratio from the AI's
 * own length_ft values (median across runs to absorb noise), then
 * project so canvas-pixels = real-feet × PX_PER_FT. Now
 * lineLengthFt round-trips and the live recompute matches the
 * stored length_ft.
 *
 * If the resulting bbox doesn't fit the viewBox (huge house), we
 * uniformly downscale BOTH positions AND length_ft on each run so
 * the canvas stays self-consistent. The trade is accuracy → fit,
 * but that's still better than the original "feet are random"
 * behavior.
 */
function buildFeetAwareProjection(
  allPoints: readonly BlueprintPoint[],
  runs: readonly { start: BlueprintPoint; end: BlueprintPoint; length_ft: number | null }[],
): {
  project: (p: BlueprintPoint) => BlueprintPoint;
  /** Multiplier applied to AI length_ft values so they stay consistent
   *  with what lineLengthFt(line) computes from canvas distance. < 1
   *  when the plan didn't fit and we had to shrink everything. */
  ftScale: number;
} {
  // Drop anything non-finite before doing arithmetic — stored
  // analyses from earlier prompt versions sometimes have null x/y
  // or NaN values, and one bad sample poisons the median and zeros
  // out every projected coordinate (entire canvas goes blank, LF
  // reads "NaN LF").
  const finitePoints = allPoints.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (finitePoints.length === 0) {
    return { project: (p) => ({ x: p.x, y: p.y }), ftScale: 1 };
  }

  // Reject outliers before bbox math. The AI sometimes emits a stray
  // sentinel coordinate (page-bounds reference, off-page label) in
  // building_footprint or excluded_edges — a single (99999, y) point
  // blows the bbox up so much that every real gutter coordinate
  // shrinks to sub-pixel scale, and the canvas renders as one dot.
  // IQR-based filter: keep points within Q1-3×IQR to Q3+3×IQR on
  // both axes. Generous bounds because real plans can have legitimate
  // long-axis dimensions, but extreme enough to catch sentinels.
  const safePoints = filterOutliers(finitePoints);

  // Derive PDF-pixels-per-foot from runs where we know both ends.
  // Median absorbs outliers (a single mis-measured run won't skew it).
  const samples: number[] = [];
  for (const r of runs) {
    if (r.length_ft == null || !Number.isFinite(r.length_ft) || r.length_ft <= 0)
      continue;
    if (
      !Number.isFinite(r.start.x) ||
      !Number.isFinite(r.start.y) ||
      !Number.isFinite(r.end.x) ||
      !Number.isFinite(r.end.y)
    )
      continue;
    const dx = r.end.x - r.start.x;
    const dy = r.end.y - r.start.y;
    const pdfPxLen = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(pdfPxLen) || pdfPxLen <= 0) continue;
    const ratio = pdfPxLen / r.length_ft;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    samples.push(ratio);
  }
  samples.sort((a, b) => a - b);
  const pdfPxPerFt =
    samples.length > 0 ? samples[Math.floor(samples.length / 2)] : null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of safePoints) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const targetW = VIEWBOX_W * (1 - 2 * MARGIN_PCT);
  const targetH = VIEWBOX_H * (1 - 2 * MARGIN_PCT);

  // Without a feet-per-pixel anchor we can't be feet-aware — fall
  // back to fit-to-viewBox. AI didn't return any length_ft (no
  // readable scale on the plan); the contractor will see correct
  // shape but the displayed LF is meaningless until they edit it.
  if (pdfPxPerFt == null || !Number.isFinite(pdfPxPerFt)) {
    const fitScale = Math.min(targetW / w, targetH / h);
    const ox = (VIEWBOX_W - w * fitScale) / 2 - minX * fitScale;
    const oy = (VIEWBOX_H - h * fitScale) / 2 - minY * fitScale;
    return {
      project: (p) => {
        const x = p.x * fitScale + ox;
        const y = p.y * fitScale + oy;
        return {
          x: Number.isFinite(x) ? x : VIEWBOX_W / 2,
          y: Number.isFinite(y) ? y : VIEWBOX_H / 2,
        };
      },
      ftScale: 1,
    };
  }

  // Ideal scale: canvas-pixels = feet × PX_PER_FT
  //   feet = pdf-pixels / pdfPxPerFt
  //   canvas-pixels = (pdf-pixels / pdfPxPerFt) × PX_PER_FT
  // So scale = PX_PER_FT / pdfPxPerFt
  const idealScale = PX_PER_FT / pdfPxPerFt;

  // If the projected bbox exceeds the viewBox, shrink uniformly so
  // it fits. We then apply the same shrink to all length_ft values
  // so the canvas stays internally consistent.
  const projW = w * idealScale;
  const projH = h * idealScale;
  const shrink =
    projW > targetW || projH > targetH
      ? Math.min(targetW / projW, targetH / projH)
      : 1;
  const scale = idealScale * shrink;
  const ox = (VIEWBOX_W - w * scale) / 2 - minX * scale;
  const oy = (VIEWBOX_H - h * scale) / 2 - minY * scale;
  return {
    project: (p) => {
      const x = p.x * scale + ox;
      const y = p.y * scale + oy;
      return {
        x: Number.isFinite(x) ? x : VIEWBOX_W / 2,
        y: Number.isFinite(y) ? y : VIEWBOX_H / 2,
      };
    },
    ftScale: Number.isFinite(shrink) && shrink > 0 ? shrink : 1,
  };
}

/**
 * Last-resort synthesis. When the AI's stored gutter_runs all have
 * unusable coordinates (null/NaN/undefined points, or every run
 * collapsed to the same single coordinate) — the resulting eaves
 * array is empty and the canvas shows nothing.
 *
 * The data is still valuable: the AI knows the gutter LENGTHS and
 * COUNTS even when it can't pin them to good pixel coordinates.
 * Synthesize a plausible rectangular footprint and distribute the
 * runs around its perimeter, sized proportionally to their
 * length_ft. The contractor sees the layout they expected and can
 * drag corners to match the real plan. Worst case: they redraw
 * from scratch with the drawing tools — still better than a blank
 * canvas.
 *
 * Returns synthesized EditableLines in canvas coordinates (already
 * inside the viewBox with margin). Each line's points are scaled so
 * lineLengthFt(line) gives back the AI's length_ft cleanly.
 */
function synthesizeRectangularLayout(
  runs: readonly { length_ft: number | null }[],
  downspoutCount: number,
): { eaves: EditableLine[]; downspouts: Downspout[] } {
  const validRuns = runs
    .map((r, i) => ({ i, len: r.length_ft ?? 0 }))
    .filter((r) => r.len > 0);
  if (validRuns.length === 0) {
    return { eaves: [], downspouts: [] };
  }

  const totalLF = validRuns.reduce((sum, r) => sum + r.len, 0);
  // Aim for a 4:3 rectangle whose perimeter equals the total LF.
  // perimeter = 2(W + D), W = 4k, D = 3k → 14k = totalLF → k = totalLF/14
  const k = totalLF / 14;
  const widthFt = 4 * k;
  const depthFt = 3 * k;

  // Fit the rectangle into the viewBox at canvas-PX_PER_FT scale so
  // lineLengthFt round-trips correctly. If the rectangle doesn't fit,
  // shrink uniformly — same trick as buildFeetAwareProjection's
  // ftScale path.
  const targetW = VIEWBOX_W * (1 - 2 * MARGIN_PCT);
  const targetH = VIEWBOX_H * (1 - 2 * MARGIN_PCT);
  const widthPx = widthFt * PX_PER_FT;
  const depthPx = depthFt * PX_PER_FT;
  const shrink =
    widthPx > targetW || depthPx > targetH
      ? Math.min(targetW / widthPx, targetH / depthPx)
      : 1;
  const wPx = widthPx * shrink;
  const dPx = depthPx * shrink;
  const left = (VIEWBOX_W - wPx) / 2;
  const top = (VIEWBOX_H - dPx) / 2;

  // Walk runs around the perimeter clockwise from top-left, allocating
  // each run a span proportional to its length_ft. Sides break at
  // corners.
  const perimPx = 2 * (wPx + dPx);
  const eaves: EditableLine[] = [];
  let cursorPx = 0; // 0..perimPx
  for (const { i, len } of validRuns) {
    const spanPx = (len / totalLF) * perimPx * shrink;
    const startCanvas = pointOnRect(cursorPx, left, top, wPx, dPx, perimPx);
    const endCanvas = pointOnRect(
      cursorPx + spanPx,
      left,
      top,
      wPx,
      dPx,
      perimPx,
    );
    eaves.push({
      id: `plan-eave-${i}-syn`,
      kind: "eave",
      points: [startCanvas, endCanvas],
    });
    cursorPx += spanPx;
  }

  // Drop downspouts at the start of each run, capped at the requested
  // count. Real contractors will reposition; the goal is "they appear
  // SOMEWHERE on the canvas," not pixel-perfect.
  const downspouts: Downspout[] = [];
  const dsCount = Math.min(downspoutCount, validRuns.length);
  for (let n = 0; n < dsCount; n++) {
    const at = pointOnRect(
      (n / dsCount) * perimPx,
      left,
      top,
      wPx,
      dPx,
      perimPx,
    );
    downspouts.push({
      id: `plan-ds-${n}-syn`,
      x: at.x,
      y: at.y,
      heightFt: 20,
    });
  }
  return { eaves, downspouts };
}

function pointOnRect(
  t: number,
  left: number,
  top: number,
  w: number,
  h: number,
  perim: number,
): BlueprintPoint {
  // Walk a closed rectangular perimeter clockwise from top-left:
  // 0..w → top edge, w..(w+h) → right edge, (w+h)..(2w+h) → bottom,
  // (2w+h)..perim → left edge.
  let s = t % perim;
  if (s < 0) s += perim;
  if (s <= w) return { x: left + s, y: top };
  s -= w;
  if (s <= h) return { x: left + w, y: top + s };
  s -= h;
  if (s <= w) return { x: left + w - s, y: top + h };
  s -= w;
  return { x: left, y: top + h - s };
}

export interface BlueprintToEstimateMeta {
  /** Original uploaded filename — used as the "address" label in the
   *  results view header since there's no real geocoded address. */
  filename: string;
  /** Total time Claude spent analyzing the plan; surfaced in the notes
   *  panel alongside the AI confidence score. */
  durationMs?: number;
  /** PlanAnalysis row id. Used to build the authenticated PDF proxy
   *  URL (/api/blueprints/<id>/pdf) so the canvas can rasterize the
   *  source page as its background. */
  planId?: string;
}

export function blueprintToEstimateResult(
  analysis: BlueprintAnalysis,
  meta: BlueprintToEstimateMeta,
): EstimateResult {
  // ONLY load-bearing geometry feeds the bbox: gutter_runs (what we
  // price + render solid) + downspouts (drainage points). The
  // building_footprint and excluded_edges fields are decorative — and
  // when the AI puts a stray sentinel coordinate in either of them
  // (a page-bounds reference at 99999, an off-page label), the
  // outlier blows up the bbox and crushes every gutter coordinate
  // to sub-pixel scale. Limiting the bbox source isolates the
  // projection from those artifacts.
  const loadBearingPoints: BlueprintPoint[] = [
    ...analysis.gutter_runs.flatMap((r) => [r.start, r.end]),
    ...analysis.downspouts.map((d) => d.at),
  ];
  const { project, ftScale } = buildFeetAwareProjection(
    loadBearingPoints,
    analysis.gutter_runs,
  );

  // A point is "bad" when the stored analysis has null/undefined/NaN
  // coords — projection would collapse it to viewBox center and the
  // canvas would render every degenerate eave on top of one another
  // (the "single pink dot, no eaves" failure mode). Drop bad lines
  // entirely so the canvas shows the trace that's actually usable.
  const isGoodPoint = (p: BlueprintPoint | undefined | null): p is BlueprintPoint =>
    !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const droppedEaves: number[] = [];
  const droppedRakes: number[] = [];
  const droppedDownspouts: number[] = [];

  let eaves: EditableLine[] = analysis.gutter_runs
    .map((r, i): EditableLine | null => {
      if (!isGoodPoint(r.start) || !isGoodPoint(r.end)) {
        droppedEaves.push(i);
        return null;
      }
      return {
        id: `plan-eave-${i}`,
        kind: "eave",
        points: [project(r.start), project(r.end)],
      };
    })
    .filter((l): l is EditableLine => l !== null);

  // Also detect "all eaves got projected to the same point" — the
  // bbox was so small the load-bearing geometry collapsed. In that
  // case the eaves array is non-empty but every line has zero canvas
  // length. Treat as a project-failure and synthesize the same way.
  const allDegenerate =
    eaves.length > 0 &&
    eaves.every((l) => {
      const a = l.points[0];
      const b = l.points[1];
      if (!a || !b) return true;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      return dx * dx + dy * dy < 1; // < 1 canvas px²
    });

  // Hips + rakes + dormer_rakes ARE perimeter edges the contractor needs
  // to see so they can verify what the AI excluded. Ridges and valleys are
  // interior to the roof plane — we drop them here, they're not "edges of
  // the building" and would just confuse the no-gutter dashed rendering.
  const rakes: EditableLine[] = analysis.excluded_edges
    .filter((e) => e.kind !== "ridge" && e.kind !== "valley")
    .map((e, i): EditableLine | null => {
      if (!isGoodPoint(e.start) || !isGoodPoint(e.end)) {
        droppedRakes.push(i);
        return null;
      }
      return {
        id: `plan-rake-${i}`,
        kind: "rake",
        points: [project(e.start), project(e.end)],
      };
    })
    .filter((l): l is EditableLine => l !== null);

  // Downspouts. Each one carries its source-run tier height when the
  // AI was able to derive tiers from the elevations (e.g. porch
  // downspouts at 10 ft, 2-story body downspouts at 20-26 ft).
  // Fallback to 20 ft (2-story default) when tier info is missing.
  let downspouts: Downspout[] = analysis.downspouts
    .map((d, i): Downspout | null => {
      if (!isGoodPoint(d.at)) {
        droppedDownspouts.push(i);
        return null;
      }
      const p = project(d.at);
      const heightFt =
        d.drop_height_ft != null && d.drop_height_ft > 0
          ? Math.round(d.drop_height_ft)
          : 20;
      return { id: `plan-ds-${i}`, x: p.x, y: p.y, heightFt };
    })
    .filter((d): d is Downspout => d !== null);

  // Synthesis fallback. Triggers in two cases:
  //   1. ALL eaves were dropped because every gutter_run had bad
  //      coords (eaves array empty but analysis.gutter_runs has data).
  //   2. The projection collapsed everything to ~0 canvas length
  //      (allDegenerate) — happens when the AI emitted the same
  //      coordinate for every run, or coordinates with no useful
  //      bbox.
  // In either case the run COUNTS and LENGTHS the AI gave us are
  // still valid — just the (x, y) pixels aren't. Lay them out around
  // a rectangle whose perimeter equals the total LF so the contractor
  // sees a meaningful starting trace instead of nothing.
  let synthesized = false;
  if (
    (eaves.length === 0 && analysis.gutter_runs.length > 0) ||
    allDegenerate
  ) {
    const syn = synthesizeRectangularLayout(
      analysis.gutter_runs,
      downspouts.length > 0
        ? downspouts.length
        : analysis.downspouts.length,
    );
    if (syn.eaves.length > 0) {
      eaves = syn.eaves;
      // Replace downspouts only when we also had none rendered — if
      // the AI gave good downspout coordinates, keep them.
      if (downspouts.length === 0) {
        downspouts = syn.downspouts;
      }
      synthesized = true;
    }
  }

  // LF totals come from Claude's length_ft values, scaled by ftScale
  // when the polygon had to be shrunk to fit the viewBox (rare —
  // only triggers on enormous floor plates). Without this scale,
  // canvas-pixel re-computes via lineLengthFt would diverge from the
  // stored total.
  const eaveLF = Math.round(
    analysis.gutter_runs.reduce(
      (sum, r) => sum + (r.length_ft ?? 0) * ftScale,
      0,
    ),
  );

  // We don't get rake length from Claude — excluded_edges only has
  // endpoints, no source-feet conversion. Estimate rakeLF as the
  // average eave-run length times the rake count so the measurement
  // sheet isn't blank. Contractor can override in the pricing panel.
  const avgRunLf = eaves.length > 0 ? eaveLF / eaves.length : 0;
  const rakeLF = Math.round(rakes.length * avgRunLf);

  // Stories = the max tier we found on any downspout. A 2-story house
  // with a porch will have downspouts at both 10 ft (porch) and 20+
  // (main body); priced as 2-story.
  const maxDropFt = downspouts.reduce((m, d) => Math.max(m, d.heightFt), 0);
  const stories: Stories =
    maxDropFt > 24 ? 3 : maxDropFt > 14 ? 2 : 1;

  const measurements = {
    eaveLF,
    rakeLF,
    outsideCorners: analysis.totals.outside_corner_miters,
    insideCorners: analysis.totals.inside_corner_miters,
    // Each detached run gets two end caps. Approximation but close
    // enough for a starting bid.
    endCaps: Math.max(2, eaves.length * 2),
    downspoutCount: analysis.totals.downspout_count,
    stories,
    wasteFactorPct: 8,
  };

  const notes: string[] = [
    `Plan-based estimate from ${meta.filename}`,
    `AI confidence: ${analysis.confidence}`,
  ];
  if (analysis.scale.feet_per_unit == null) {
    notes.push(
      "⚠ Plan scale unreadable — LF values are best-effort. Review the pricing panel before sending.",
    );
  } else {
    notes.push(
      `Scale: 1 unit = ${analysis.scale.feet_per_unit.toFixed(3)} ft (${analysis.scale.source})`,
    );
  }
  for (const n of analysis.notes) notes.push(n);

  // Tell the contractor when the stored analysis had malformed
  // geometry we had to drop. A non-zero count means the takeoff is
  // partial — they should re-run rather than send.
  if (droppedEaves.length + droppedRakes.length + droppedDownspouts.length > 0) {
    notes.push(
      `⚠ Stored analysis had ${droppedEaves.length} eave(s), ` +
        `${droppedRakes.length} rake(s), ${droppedDownspouts.length} downspout(s) ` +
        "with missing/invalid coordinates — dropped to keep canvas usable. " +
        "Re-analyze for a complete trace.",
    );
  }
  if (synthesized) {
    notes.push(
      "⚠ AI returned valid run counts and lengths but unusable pixel " +
        "coordinates — canvas shows a synthesized rectangular layout " +
        "with each run sized to its real LF. Drag corners to match the " +
        "actual house shape, or redraw from the plan.",
    );
  }

  return {
    geocoded: {
      formatted: meta.filename,
      lat: 0,
      lng: 0,
      source: "mock",
      fallbackReason:
        "Plan-based estimate — no geocoded address. Edit the address on the proposal.",
    },
    measurements,
    eaves,
    rakes,
    downspouts,
    source: "ai",
    durationMs: meta.durationMs ?? 0,
    notes,
    aerial: undefined,
    // Plan-based estimates pass the source-PDF reference so the canvas
    // can render the actual roof plan page underneath the trace
    // instead of falling back to the cartoon yard scene.
    planSource: meta.planId
      ? {
          pdfUrl: `/api/blueprints/${meta.planId}/pdf`,
          pageIndex: analysis.source_page_index ?? 1,
        }
      : undefined,
  };
}
