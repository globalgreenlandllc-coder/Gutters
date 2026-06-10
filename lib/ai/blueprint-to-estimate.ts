import "server-only";
import type {
  BlueprintAnalysis,
  BlueprintPoint,
} from "./blueprint-from-plans";
import type { EstimateResult } from "./index";
import type { Downspout, EditableLine, Stories } from "@/lib/types";

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

function fitTransform(
  points: readonly BlueprintPoint[],
): (p: BlueprintPoint) => BlueprintPoint {
  if (points.length === 0) return (p) => ({ x: p.x, y: p.y });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const targetW = VIEWBOX_W * (1 - 2 * MARGIN_PCT);
  const targetH = VIEWBOX_H * (1 - 2 * MARGIN_PCT);
  const scale = Math.min(targetW / w, targetH / h);
  const offsetX = (VIEWBOX_W - w * scale) / 2 - minX * scale;
  const offsetY = (VIEWBOX_H - h * scale) / 2 - minY * scale;
  return (p) => ({ x: p.x * scale + offsetX, y: p.y * scale + offsetY });
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
  const project = fitTransform(allPoints);

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

  // Downspouts. Plan-based estimates default to 1-story (10 ft drop).
  // The contractor edits each downspout's heightFt manually via the
  // popover in <AerialCanvas> just like the satellite-based flow.
  const downspouts: Downspout[] = analysis.downspouts.map((d, i) => {
    const p = project(d.at);
    return { id: `plan-ds-${i}`, x: p.x, y: p.y, heightFt: 10 };
  });

  // LF totals come from Claude's pixel-or-feet output. When the plan
  // had a readable scale, length_ft is populated; otherwise length_px
  // is all we have and the LF will read 0 + a strong note will warn.
  const eaveLF = Math.round(
    analysis.gutter_runs.reduce((sum, r) => sum + (r.length_ft ?? 0), 0),
  );

  // We don't get rake length from Claude — excluded_edges only has
  // endpoints, no source-feet conversion. Estimate rakeLF as the
  // average eave-run length times the rake count so the measurement
  // sheet isn't blank. Contractor can override in the pricing panel.
  const avgRunLf = eaves.length > 0 ? eaveLF / eaves.length : 0;
  const rakeLF = Math.round(rakes.length * avgRunLf);

  const stories: Stories = 1;

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
