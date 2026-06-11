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
  if (allPoints.length === 0) {
    return { project: (p) => ({ x: p.x, y: p.y }), ftScale: 1 };
  }

  // Derive PDF-pixels-per-foot from runs where we know both ends.
  // Median absorbs outliers (a single mis-measured run won't skew it).
  const samples: number[] = [];
  for (const r of runs) {
    if (r.length_ft == null || r.length_ft <= 0) continue;
    const dx = r.end.x - r.start.x;
    const dy = r.end.y - r.start.y;
    const pdfPxLen = Math.sqrt(dx * dx + dy * dy);
    if (pdfPxLen <= 0) continue;
    samples.push(pdfPxLen / r.length_ft);
  }
  samples.sort((a, b) => a - b);
  const pdfPxPerFt =
    samples.length > 0 ? samples[Math.floor(samples.length / 2)] : null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of allPoints) {
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
  if (pdfPxPerFt == null) {
    const fitScale = Math.min(targetW / w, targetH / h);
    const ox = (VIEWBOX_W - w * fitScale) / 2 - minX * fitScale;
    const oy = (VIEWBOX_H - h * fitScale) / 2 - minY * fitScale;
    return {
      project: (p) => ({ x: p.x * fitScale + ox, y: p.y * fitScale + oy }),
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
    project: (p) => ({ x: p.x * scale + ox, y: p.y * scale + oy }),
    ftScale: shrink,
  };
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
  // Union of every point we know about — this is what we fit to the canvas.
  const allPoints: BlueprintPoint[] = [
    ...analysis.building_footprint,
    ...analysis.gutter_runs.flatMap((r) => [r.start, r.end]),
    ...analysis.downspouts.map((d) => d.at),
    ...analysis.excluded_edges.flatMap((e) => [e.start, e.end]),
  ];
  const { project, ftScale } = buildFeetAwareProjection(
    allPoints,
    analysis.gutter_runs,
  );

  const eaves: EditableLine[] = analysis.gutter_runs.map((r, i) => ({
    id: `plan-eave-${i}`,
    kind: "eave",
    points: [project(r.start), project(r.end)],
  }));

  // Hips + rakes + dormer_rakes ARE perimeter edges the contractor needs
  // to see so they can verify what the AI excluded. Ridges and valleys are
  // interior to the roof plane — we drop them here, they're not "edges of
  // the building" and would just confuse the no-gutter dashed rendering.
  const rakes: EditableLine[] = analysis.excluded_edges
    .filter((e) => e.kind !== "ridge" && e.kind !== "valley")
    .map((e, i) => ({
      id: `plan-rake-${i}`,
      kind: "rake",
      points: [project(e.start), project(e.end)],
    }));

  // Downspouts. Each one carries its source-run tier height when the
  // AI was able to derive tiers from the elevations (e.g. porch
  // downspouts at 10 ft, 2-story body downspouts at 20-26 ft).
  // Fallback to 20 ft (2-story default) when tier info is missing —
  // pricing for the taller drop is the conservative call. Contractor
  // can still edit per-downspout via the popover in AerialCanvas.
  const downspouts: Downspout[] = analysis.downspouts.map((d, i) => {
    const p = project(d.at);
    const heightFt =
      d.drop_height_ft != null && d.drop_height_ft > 0
        ? Math.round(d.drop_height_ft)
        : 20;
    return { id: `plan-ds-${i}`, x: p.x, y: p.y, heightFt };
  });

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
