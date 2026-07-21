import "server-only";
import type {
  BlueprintAnalysis,
  BlueprintPoint,
} from "./blueprint-from-plans";
import type { EstimateResult } from "./index";
import type {
  Downspout,
  EaveFeature,
  EaveSide,
  EaveTier,
  EditableLine,
  RoofStructure,
  RoofStructureLine,
  Stories,
} from "@/lib/types";
// Import from the directive-free constants module, NOT from aerial-shared
// ("use client"). A server module that pulls a value export through a
// "use client" boundary receives an RSC client reference instead of the
// number — PX_PER_FT would read as an object and every `× PX_PER_FT` /
// `PX_PER_FT ÷ …` would silently become NaN, collapsing the projection
// and the synthesized layout (blank canvas, "Eaves NaN LF").
import { PX_PER_FT } from "@/components/estimate/aerial-constants";
import { buildEngineTakeoff } from "./engine-takeoff";
import { consensusStories, isUnanimousHip, type FaceReadingRaw } from "./face-merge";
import { sideOfPerimeterEdge, type FaceNormals } from "./plan-orientation";
import {
  classifyRunPlacement,
  collectStepEdges,
  filterRoofDiagramLines,
  shouldDrawTierSteps,
} from "./roof-diagram-filter";
import { facesFromRoofLines } from "./roof-faces-from-lines";
import type { RoofMassArea } from "./to-masses";
import type { DroppedProjection } from "./reconcile-edge-classes";
import { synthesizeProjectionGutterLF } from "./projection-lf";

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

// Defensive fallback. PX_PER_FT now comes from a directive-free module so
// it resolves to a real number on the server — but if the client/server
// boundary bug ever returns (PX_PER_FT → NaN), clamp to the known canvas
// scale rather than poisoning every projection and synthesized layout.
const SAFE_PX_PER_FT =
  Number.isFinite(PX_PER_FT) && PX_PER_FT > 0 ? PX_PER_FT : 2.4;

/** Canvas-pixel length of a polyline (mirrors lineLengthFt's px sum on
 *  the client). NaN-safe so one bad point can't poison the total. */
function lineLenPx(line: { points: BlueprintPoint[] }): number {
  let total = 0;
  for (let i = 1; i < line.points.length; i++) {
    const a = line.points[i - 1];
    const b = line.points[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (Number.isFinite(d)) total += d;
  }
  return total;
}

/** Same polyline length expressed in feet (the unit the canvas legend
 *  and the pricing panel show). */
function lineLenFt(line: { points: BlueprintPoint[] }): number {
  return lineLenPx(line) / SAFE_PX_PER_FT;
}

/** Minimum distance from a point to a polygon's boundary (nearest edge). Used
 *  to keep only the engine edges that lie on the OUTER footprint perimeter,
 *  dropping the internal tier-decomposition boundaries in perimeter-only mode. */
function distToPolygonBoundary(p: BlueprintPoint, poly: BlueprintPoint[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

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
  const idealScale = SAFE_PX_PER_FT / pdfPxPerFt;

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
  runs: readonly {
    length_ft: number | null;
    side?: EaveSide;
    tier?: EaveTier;
  }[],
  downspoutCount: number,
): { eaves: EditableLine[]; downspouts: Downspout[] } {
  const validRuns = runs
    // Number() coercion so a stray string length_ft can't turn the
    // `sum + len` reduce below into string concatenation.
    .map((r, i) => ({ i, len: Number(r.length_ft) || 0, side: r.side, tier: r.tier }))
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
  const widthPx = widthFt * SAFE_PX_PER_FT;
  const depthPx = depthFt * SAFE_PX_PER_FT;
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
  const perimPx = 2 * (wPx + dPx); // already reflects `shrink` via wPx/dPx
  const eaves: EditableLine[] = [];
  let cursorPx = 0; // 0..perimPx
  for (const { i, len, side, tier } of validRuns) {
    // perimPx already includes the shrink factor — don't apply it again
    // or the runs under-fill the rectangle (and pile up at one corner).
    const spanPx = (len / totalLF) * perimPx;
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
      tier: (tier ?? "unknown") as EaveTier,
      side,
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
  /** Total PDF pages — bounds the canvas sheet selector. */
  pageCount?: number;
  /** Classifier sheet inventory ({pageIndex, label, ...}) so the contractor
   *  can flip the underlay to the right drawing; sheetType/elevationSide
   *  drive the Elevations view. */
  sheets?: {
    pageIndex: number;
    label: string;
    sheetType?: string;
    elevationSide?: string;
  }[];
}

/** True when two segments are collinear (within tol) AND overlap along their
 *  shared direction — i.e. the SAME wall. Used to catch a wall the AI marked
 *  as BOTH a gutter and a gable rake. */
function segmentsCollinearOverlap(
  a0: BlueprintPoint,
  a1: BlueprintPoint,
  b0: BlueprintPoint,
  b1: BlueprintPoint,
  tol: number,
): boolean {
  const adx = a1.x - a0.x;
  const ady = a1.y - a0.y;
  const alen = Math.hypot(adx, ady);
  if (alen < 1e-6) return false;
  const ux = adx / alen;
  const uy = ady / alen;
  const perp = (p: BlueprintPoint) =>
    Math.abs((p.x - a0.x) * -uy + (p.y - a0.y) * ux);
  if (perp(b0) > tol || perp(b1) > tol) return false; // not the same line
  const proj = (p: BlueprintPoint) => (p.x - a0.x) * ux + (p.y - a0.y) * uy;
  const bLo = Math.min(proj(b0), proj(b1));
  const bHi = Math.max(proj(b0), proj(b1));
  return Math.min(alen, bHi) - Math.max(0, bLo) > tol; // real overlap
}

export function blueprintToEstimateResult(
  analysis: BlueprintAnalysis,
  meta: BlueprintToEstimateMeta,
  opts?: {
    /** When true, the deterministic roof engine drives the priced eave LF,
     *  downspouts, eave/rake lines, and ridge/valley overlay instead of the raw
     *  gutter_runs sum. Gated by the BLUEPRINT_ENGINE_TAKEOFF flag; default off. */
    useEngineTakeoff?: boolean;
    /** DISPLAY-ONLY engine geometry: draw the engine's gables/pop-outs + clean
     *  skeleton on the canvas, but keep pricing (eave LF, downspouts) on the
     *  measured-run path. Gated by BLUEPRINT_ENGINE_DRAW; implied by
     *  useEngineTakeoff. Pricing is byte-identical to the flag-off path. */
    useEngineDraw?: boolean;
    /** Per-face elevation reads (analysisJson._perFace.per_face) so the engine
     *  can draw each face's gables + pop-outs (porch/patio) by rule. */
    perFace?: Record<string, FaceReadingRaw> | null;
    /** The caller's MERGED all-hip verdict (roof-plan page ∪ elevations —
     *  broader than isUnanimousHip(perFace), which can't see the roof page).
     *  On a confirmed fully-hipped roof every trace rake mark is a phantom,
     *  so the run-vs-rake dedupe stands down instead of deleting restored
     *  gutter runs to "keep" a hallucinated gable. */
    allHipConfirmed?: boolean;
    /** Per-mass roof areas (analysisJson._engine.roofMasses) so a projecting
     *  gable's depth = roof area ÷ span (LAW 2), not a schematic guess. */
    roofMasses?: RoofMassArea[] | null;
    /** Projecting masses (porch/patio/garage on posts/beam) the elevation
     *  reconcile found whose OWN gutters sit beyond the traced outline. When a
     *  matching roof-area mass exists, an ESTIMATED gutter line is synthesized
     *  (2 side returns × area÷span) and added to eaveLF instead of the LF being
     *  silently dropped. Tagged "estimated — verify"; no-op when empty. */
    droppedProjections?: DroppedProjection[] | null;
    /** Compass→canvas normals derived from the plan's own elevation titles
     *  (plan-orientation.ts) so per-face gables land on the right canvas side
     *  when the sheet isn't drawn north-up. Null → legacy north-up default. */
    faceNormals?: FaceNormals | null;
    /** PERIMETER-ONLY render (perimeterOnlyEnabled(), default ON): keep the
     *  engine's per-edge eave/rake classification but DROP the interior roof
     *  skeleton (ridges/hips/valleys) from the drawn structure. The interior is
     *  decorative + unpriced and the sole source of the fanned garbage renders. */
    perimeterOnly?: boolean;
    /** v2 EDGE-TAKEOFF layout: the deterministic ridge/hip/valley skeleton
     *  computed from the classified perimeter (lib/ai/roof-layout.ts), in the
     *  SAME analysis coordinate space as building_footprint/gutter_runs. When
     *  present it is the drawn interior — projected through the same
     *  transforms as the eaves so everything stays registered. Decorative,
     *  never priced. `confidence` is evidence-based (plan-diagonal match). */
    edgeLayout?: {
      ridges: Array<{ p1: BlueprintPoint; p2: BlueprintPoint }>;
      valleys: Array<{ p1: BlueprintPoint; p2: BlueprintPoint }>;
      hips: Array<{ p1: BlueprintPoint; p2: BlueprintPoint }>;
      gableCount: number;
      /** Edge-anchored gable-end triangles (roof-layout.ts GableEnd) —
       *  projected into the "engine-gable-…" line channel + the overlay's
       *  gable list so gables draw even when the skeleton degenerated. */
      gableEnds?: Array<{
        edgeId?: string;
        base: [BlueprintPoint, BlueprintPoint];
        apex: BlueprintPoint;
        verify?: boolean;
      }> | null;
      /** Roof PLANES tiling the outline (analysis space) — projected into
       *  RoofStructure.faces so shading covers the whole footprint. */
      faces?: Array<{
        polygon: BlueprintPoint[];
        downhill: BlueprintPoint;
      }> | null;
      confidence: number;
    } | null;
    /** UN-PRICED suggested gutter segments in ANALYSIS space (e.g. the rear
     *  tier-step return from the corner veto, tier-corner-veto.ts). Projected
     *  through the SAME transform as the eaves and returned on
     *  EstimateResult.suggestedEaves — the canvas draws them dashed with a
     *  tap-to-add affordance; NEVER summed into eaveLF (money-safe). */
    suggestedEaves?: { points: BlueprintPoint[]; tier?: EaveTier }[] | null;
  },
): EstimateResult {
  // CONFLICT DEDUP (Gemini code-review): a wall can't be BOTH a gutter and a
  // gable rake. When the AI double-classifies an edge — a gutter_run that
  // overlaps an excluded_edge rake — it renders a gutter AND a GABLE label on
  // the same wall and hands the roof-skeleton solver contradictory input
  // (wrong ridge direction). Drop the duplicate gutter and keep the explicit
  // rake: that clears the visual conflict, fixes the skeleton, AND removes a
  // phantom gutter pricing a gable face. Runs at load → no re-analyze needed.
  // On a confirmed all-hip roof (roof page + elevations agree: zero gables)
  // this dedupe is exactly backwards — every rake mark is a trace phantom,
  // and "keeping the gable" deletes real (often just-restored) gutter runs.
  // The rake marks still render as dashes for review; they just can't eat
  // priced runs.
  if (opts?.allHipConfirmed !== true) {
    const finite = (p?: BlueprintPoint | null) =>
      !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
    const rakes = (analysis.excluded_edges ?? []).filter(
      (e) =>
        (e.kind === "rake" || e.kind === "dormer_rake") &&
        finite(e.start) &&
        finite(e.end),
    );
    if (rakes.length > 0 && analysis.gutter_runs.length > 0) {
      const pts = [
        ...analysis.gutter_runs.flatMap((r) => [r.start, r.end]),
        ...rakes.flatMap((e) => [e.start, e.end]),
      ].filter(finite);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const span = Math.max(
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
        1,
      );
      const tol = Math.max(span * 0.025, 2);
      const deduped = analysis.gutter_runs.filter((r) => {
        if (!finite(r.start) || !finite(r.end)) return true;
        return !rakes.some((e) =>
          segmentsCollinearOverlap(r.start, r.end, e.start, e.end, tol),
        );
      });
      if (deduped.length !== analysis.gutter_runs.length) {
        analysis = {
          ...analysis,
          gutter_runs: deduped,
          notes: [
            ...(analysis.notes ?? []),
            `Cleaned ${analysis.gutter_runs.length - deduped.length} gutter run(s) that overlapped a gable rake (a wall can't be both) — kept the gable.`,
          ],
        };
      }
    }
  }
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

  // Engine geometry. Built whenever EITHER the full takeoff (pricing) OR the
  // display-only draw mode is on, so the engine's gables/pop-outs + clean
  // skeleton can render. `enginePrices` gates the PRICING coupling (eave LF,
  // rule-placed downspouts) to the full-takeoff flag ONLY — in display-only
  // mode the engine draws but pricing stays on the measured-run path. Null when
  // there's no footprint / no scale, in which case both modes no-op.
  const engineBundle =
    opts?.useEngineTakeoff || opts?.useEngineDraw
      ? buildEngineTakeoff(analysis, opts?.perFace, opts?.roofMasses, opts?.faceNormals)
      : null;
  const enginePrices = !!opts?.useEngineTakeoff && !!engineBundle;

  // PERIMETER-ONLY (default): draw only the OUTER footprint edges, color-coded
  // eave vs rake. The engine decomposes the footprint into tier masses whose
  // SHARED internal boundaries also appear as mass edges — drawing those puts
  // dashed "rake" lines INSIDE the building. Keep only edges that lie on the
  // outer footprint boundary; internal tier splits are dropped.
  const perimeterOnly = opts?.perimeterOnly !== false;
  const outerFp = (analysis.building_footprint ?? []).filter(
    (p): p is BlueprintPoint => !!p && Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  const outerBoundaryTol = (() => {
    if (outerFp.length < 3) return Infinity;
    const xs = outerFp.map((p) => p.x);
    const ys = outerFp.map((p) => p.y);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return Math.max(span * 0.02, 2);
  })();
  const onOuterBoundary = (e: { p1: BlueprintPoint; p2: BlueprintPoint }): boolean => {
    if (!perimeterOnly || outerFp.length < 3) return true;
    const mid = { x: (e.p1.x + e.p2.x) / 2, y: (e.p1.y + e.p2.y) / 2 };
    return distToPolygonBoundary(mid, outerFp) <= outerBoundaryTol;
  };

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
        // Carry the plan's roof tier + side so the canvas can color the
        // run and show whether it's an upper (2-story) or lower
        // (porch/patio/1-story) eave. `feature` names the covered
        // projection (porch/patio/deck/…) so the layout can label it.
        tier: (r.tier ?? "unknown") as EaveTier,
        side: r.side as EaveSide,
        feature: r.feature as EaveFeature | undefined,
      };
    })
    .filter((l): l is EditableLine => l !== null);

  // Priced-run count for the count-derived quantities (end caps, rakeLF
  // average). Frozen by the engine block below to the PRE-steps drawn set so
  // the display-only interior-run append can't move a priced number; null =
  // non-engine path (use eaves.length, as always).
  let pricedRunCount: number | null = null;

  // Engine mode: replace the gutter_runs eaves with the engine's guttered edges
  // (footprint perimeter + confirmed projecting-gable side eaves), projected
  // with the SAME transform so the canvas registers and re-prices consistently.
  if (engineBundle) {
    // Inherit each engine edge's tier / feature from the NEAREST AI gutter
    // run (same analysis coordinate space) — without `tier` the upper/lower
    // eave coloring is lost, and `feature` names the porch/patio. Match by
    // midpoint distance, capped at 20% of the footprint span so a far-away
    // run can't mislabel an unrelated wall. `side` is NOT inherited: the AI's
    // per-run side tags proved swappable (front↔back), so the orientation
    // chips' side comes from pure geometry instead (sideOfPerimeterEdge —
    // the edge's outward normal under the front-at-bottom convention).
    const labelDonors = analysis.gutter_runs
      .filter(
        (r) =>
          r.start && r.end &&
          Number.isFinite(r.start.x) && Number.isFinite(r.start.y) &&
          Number.isFinite(r.end.x) && Number.isFinite(r.end.y),
      )
      .map((r) => ({
        x: (r.start.x + r.end.x) / 2,
        y: (r.start.y + r.end.y) / 2,
        side: r.side as EaveSide | undefined,
        tier: (r.tier ?? "unknown") as EaveTier,
        feature: r.feature as EaveFeature | undefined,
      }));
    const donorCap = Number.isFinite(outerBoundaryTol) ? outerBoundaryTol * 10 : Infinity;
    const nearestDonor = (e: { p1: BlueprintPoint; p2: BlueprintPoint }) => {
      const mx = (e.p1.x + e.p2.x) / 2;
      const my = (e.p1.y + e.p2.y) / 2;
      let best: (typeof labelDonors)[number] | null = null;
      let bestD = Infinity;
      for (const d of labelDonors) {
        const dist = Math.hypot(d.x - mx, d.y - my);
        if (dist < bestD) {
          bestD = dist;
          best = d;
        }
      }
      return best && bestD <= donorCap ? best : null;
    };
    // Partition the engine's guttered edges by placement. PRICING mode bills
    // EVERY guttered engine edge, so every one draws (drawn set = priced set
    // and the LF correction below lands ≈1). DISPLAY mode prices the AI's
    // measured runs — the perimeter engine edges draw the outline, and the
    // AI's own INTERIOR runs (clerestory / upper-tier gutters mid-roof) are
    // appended right after so every priced foot is VISIBLE. Before this,
    // interior runs vanished from the drawing while their length_ft still
    // counted into targetEaveLF, and the uniform correction smeared that
    // invisible LF onto the perimeter pill labels.
    const engineGutterEdges = engineBundle.takeoff.masses
      .flatMap((m) => m.edges)
      .filter((e) => e.gutter);
    eaves = (enginePrices
      ? engineGutterEdges
      : engineGutterEdges.filter(onOuterBoundary)
    ).map((e, i): EditableLine => {
      const donor = nearestDonor(e);
      const geomSide =
        outerFp.length >= 3 ? sideOfPerimeterEdge(e.p1, e.p2, outerFp) : null;
      const side = geomSide ?? donor?.side;
      return {
        id: `engine-eave-${i}`,
        kind: "eave",
        points: [project(e.p1), project(e.p2)],
        ...(side ? { side } : {}),
        ...(donor ? { tier: donor.tier } : {}),
        ...(donor?.feature ? { feature: donor.feature } : {}),
      };
    });
    // PRICED-COUNT FREEZE: end caps (× runs) and the rakeLF average divide by
    // the run COUNT. Appending interior runs / unfiltering engine edges is a
    // DISPLAY fix and must never move a priced quantity — derive those counts
    // from the same set the pre-steps code drew (perimeter engine edges).
    pricedRunCount = engineGutterEdges.filter(onOuterBoundary).length;
    if (!enginePrices) {
      // PRICED INTERIOR RUNS MUST DRAW (display mode): append the AI-traced
      // gutter runs whose midpoint sits INTERIOR to the footprint. Finite
      // coords only — classifyRunPlacement returns "invalid" for garbage
      // points, and those never draw. NEVER touches targetEaveLF: these runs
      // were ALWAYS priced; they just weren't drawn.
      const interiorTol = perimeterOnly ? outerBoundaryTol : Infinity;
      analysis.gutter_runs.forEach((r, i) => {
        if (classifyRunPlacement(r, outerFp, interiorTol) !== "interior")
          return;
        eaves.push({
          id: `plan-eave-${i}`,
          kind: "eave",
          points: [project(r.start), project(r.end)],
          tier: (r.tier ?? "unknown") as EaveTier,
          ...(r.side ? { side: r.side as EaveSide } : {}),
          ...(r.feature ? { feature: r.feature as EaveFeature } : {}),
        });
      });
    }
  }

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

  // Gable rakes (rake + dormer_rake) are the dashed "GABLE — no gutter"
  // edges. Hips, ridges, and valleys are NOT gables — they go into the
  // roof-structure overlay below (perimeter outline + interior roof
  // lines) so the contractor sees the whole roof shape, not a hip
  // mislabeled as a gable.
  // A gable rake on a rectilinear plan takeoff is always an axis-aligned wall
  // edge. A DIAGONAL excluded edge (both dx and dy significant) is an artifact
  // — a stale suggestion/tier-drop or a bad reconcile output — and it draws as
  // the stray dashed line cutting diagonally across a step that the owner
  // flagged ("I don't need to see that"). Drop it on the perimeter-only plan
  // path; satellite (angled walls, no perimeterOnly) is untouched.
  const isDiagonalRake = (a: BlueprintPoint, b: BlueprintPoint): boolean => {
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return false;
    return dx / len > 0.26 && dy / len > 0.26; // >~15° off both axes
  };
  let rakes: EditableLine[] = analysis.excluded_edges
    .filter((e) => e.kind === "rake" || e.kind === "dormer_rake")
    .map((e, i): EditableLine | null => {
      if (!isGoodPoint(e.start) || !isGoodPoint(e.end)) {
        droppedRakes.push(i);
        return null;
      }
      if (perimeterOnly && isDiagonalRake(e.start, e.end)) {
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

  // Engine mode: rakes are the gable faces the engine drew by rule (projecting
  // and flush gables both), so they render as clean "no gutter" edges.
  if (engineBundle) {
    rakes = engineBundle.takeoff.masses
      .flatMap((m) => m.edges)
      .filter((e) => e.type === "rake" && onOuterBoundary(e))
      .map((e, i): EditableLine => ({ id: `engine-rake-${i}`, kind: "rake", points: [project(e.p1), project(e.p2)] }));
  }

  // Downspouts. Each one carries its source-run tier height when the
  // AI was able to derive tiers from the elevations (e.g. porch
  // downspouts at 10 ft, 2-story body downspouts at 20-26 ft).
  // Height fallback when tier info is missing: what the ELEVATIONS show.
  // The blind 20 ft (2-story) default priced every single-story plan as
  // 2 stories (measurements.stories derives from the max drop — the
  // 1168G single-story hip showed "stories 2"). The per-face reads carry
  // stories_visible — but the MAX across faces let ONE clerestory misread
  // outvote three honest 1-story reads, so the CONSENSUS decides (≥3 reads
  // with all-but-one agreeing → the majority; else the legacy max).
  const faceStoriesReads = Object.values(opts?.perFace ?? {}).map((r) =>
    r && r.readable !== false && typeof r.stories_visible === "number" && r.stories_visible >= 1
      ? Math.min(3, Math.round(r.stories_visible))
      : null,
  );
  const storiesConsensus = consensusStories(faceStoriesReads);
  const maxFaceStories = faceStoriesReads.reduce<number>((m, v) => (v != null && v > m ? v : m), 0);
  const faceStories = storiesConsensus ?? 0;
  const defaultDropFt = faceStories === 1 ? 10 : faceStories >= 3 ? 26 : 20;
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
          : defaultDropFt;
      return { id: `plan-ds-${i}`, x: p.x, y: p.y, heightFt };
    })
    .filter((d): d is Downspout => d !== null);

  // Engine PRICING mode only: rule-based downspouts (1 per continuous run + 1
  // per 40 ft). Display-only mode keeps the AI downspouts (they're what the
  // priced downspout count reflects), so pricing stays untouched.
  if (engineBundle && enginePrices) {
    downspouts = engineBundle.takeoff.downspouts.map((d, i): Downspout => {
      const p = project(d.at);
      return { id: `engine-ds-${i}`, x: p.x, y: p.y, heightFt: 20 };
    });
  }

  // ── Roof-structure overlay ─────────────────────────────────────────
  // The AI's full building outline + interior ridge / hip / valley lines.
  // Drawn UNDER the trace so the contractor sees the whole roof shape and
  // can read where the gutters sit on it — and where a run is MISSING (a
  // stretch of outline with no eave on it). Projected with the SAME
  // transform as the eaves so it registers with the trace; the LF
  // correction below scales it in lockstep when it runs.
  const projPts = (pts: readonly BlueprintPoint[]): BlueprintPoint[] =>
    pts.filter((p) => isGoodPoint(p)).map((p) => project(p));
  const structLines = (
    kind: "ridge" | "valley" | "hip",
  ): RoofStructureLine[] =>
    analysis.excluded_edges
      .filter(
        (e) => e.kind === kind && isGoodPoint(e.start) && isGoodPoint(e.end),
      )
      .map((e, i) => ({
        id: `plan-${kind}-${i}`,
        kind,
        points: [project(e.start), project(e.end)],
      }));
  let roofPerimeter = projPts(analysis.building_footprint ?? []);
  let roofRidges = structLines("ridge");
  let roofValleys = structLines("valley");

  let roofHips = structLines("hip");
  // v2-layout extras: gable-end BASE segments (the overlay's GABLE labels +
  // skeleton input) and the roof PLANES that shade the whole footprint.
  // Both stay empty off the edgeLayout path — decorative, never priced.
  let roofGables: RoofStructureLine[] = [];
  let roofFaces: NonNullable<RoofStructure["faces"]> = [];
  // Tier STEP edges — the interior mass boundaries the perimeter-only filter
  // drops from the drawn eaves/rakes. On a multi-tier roof these ARE the
  // picture (where one roof level drops to the next), so they get their own
  // drawn channel (thin solid, never dashed). Display-only, LF-neutral.
  let roofSteps: RoofStructureLine[] = [];

  // Engine mode: the engine owns the interior skeleton — the clean straight-
  // skeleton (main hips/ridges/valleys) + each gable's ridge-back — so the roof
  // draws connected. Projected with the same transform; decorative (never
  // priced). BUT only override when the engine actually drew a REAL main skeleton
  // (a source==="skeleton" line survived the fan/reentrant reject in
  // assembleMass). When the engine rejected its own fan, leave the roof lines to
  // the client's grid derivation (a clean hip) rather than forcing just the
  // gable ridge-stubs — the engine's GABLE RAKES still draw separately.
  if (engineBundle) {
    const interior = engineBundle.takeoff.masses.flatMap((m) => m.interior);
    const engineDrewSkeleton = interior.some((e) => e.source === "skeleton");
    // Two channels of engine interior lines, drawn differently:
    //  - SKELETON lines (source "skeleton") are the clean straight-skeleton of
    //    the whole footprint. They only exist when the skeleton passed its
    //    fan/reentrant gate (a rejected fan pushes NONE), and when present they
    //    REPLACE the client's grid derivation (ids "engine-…").
    //  - GABLE lines (source "gable:…") are each gable's ridge-back + two
    //    valleys. These are valid geometry regardless of the main skeleton, so
    //    they ALWAYS draw (ids "engine-gable-…"); the overlay AUGMENTS them onto
    //    whatever main skeleton it uses. This is what makes a FLUSH cross-gable
    //    actually show even when the main skeleton was rejected (Woodinville).
    const skelLines = (kind: "ridge" | "valley" | "hip") =>
      interior
        .filter((e) => e.type === kind && e.source === "skeleton")
        .map((e, i) => ({ id: `engine-${kind}-${i}`, kind, points: [project(e.p1), project(e.p2)] }));
    // GABLE-LINE GATE: on a unanimous all-hip read (all 4 elevations agree,
    // zero gables) there is NO cross-gable to draw — any "gable:…" interior
    // line is a placement artifact, and its ridge-back + valleys were the
    // floating zigzag mid-roof on the 1168G scanned row. Belt-and-braces
    // with the upstream placement fix: the gate holds even on rows whose
    // stored geometry predates it.
    const gableLines = (kind: "ridge" | "valley") =>
      isUnanimousHip(opts?.perFace)
        ? []
        : interior
            .filter((e) => e.type === kind && e.source?.startsWith("gable:"))
            .map((e, i) => ({ id: `engine-gable-${kind}-${i}`, kind, points: [project(e.p1), project(e.p2)] }));
    if (engineDrewSkeleton) {
      roofRidges = [...skelLines("ridge"), ...gableLines("ridge")];
      roofValleys = [...skelLines("valley"), ...gableLines("valley")];
      roofHips = skelLines("hip");
    } else {
      // Skeleton rejected — leave the main hip to the client's grid derivation,
      // but add the gable ridge-backs + valleys so flush cross-gables draw over it.
      roofRidges = [...roofRidges, ...gableLines("ridge")];
      roofValleys = [...roofValleys, ...gableLines("valley")];
    }
    // TIER STEPS ARE THE PICTURE: the interior mass-boundary edges the
    // perimeter-only filter drops from the drawn eaves/rakes (a clerestory
    // box, an upper tier stepping down to a garage roof). Emit them on their
    // own drawn channel — deduped across the two masses that share each
    // boundary, labeled with the mass/tier name — so a multi-tier plan reads
    // as tiers instead of a bare outline. Infinity tol off the perimeter-only
    // path = no steps (those edges already draw as eaves/rakes there).
    // ONLY on a real multi-level roof: with every run on one tier the
    // decomposition seams are bookkeeping, not steps — drawing them painted
    // full-height lines across an all-upper hip roof.
    roofSteps = !shouldDrawTierSteps(analysis.gutter_runs)
      ? []
      : collectStepEdges(
      engineBundle.takeoff.masses.flatMap((m) =>
        m.edges.map((e) => ({ edge: e, massName: m.name })),
      ),
      outerFp,
      perimeterOnly ? outerBoundaryTol : Infinity,
    ).map(({ edge, massName }, i) => ({
      id: `engine-step-${i}`,
      kind: "step" as const,
      points: [project(edge.p1), project(edge.p2)],
      ...(massName ? { label: massName } : {}),
    }));
  }

  // v2 edge-takeoff layout: the whole-perimeter skeleton computed from the
  // classified outline OWNS the interior. It wins over both the AI-traced
  // lines and the per-mass engine skeleton (the caller disables engine draw on
  // the v2 path anyway). Ids carry the "engine-" prefix so the perimeter-only
  // filter below keeps them — they ARE rule-drawn engine output.
  if (opts?.edgeLayout) {
    const el = opts.edgeLayout;
    const goodSeg = (s: { p1: BlueprintPoint; p2: BlueprintPoint }) =>
      !!s && isGoodPoint(s.p1) && isGoodPoint(s.p2);
    const layoutLines = (
      kind: "ridge" | "valley" | "hip",
      arr: Array<{ p1: BlueprintPoint; p2: BlueprintPoint }>,
    ): RoofStructureLine[] =>
      // The layout is free-form JSON off the DB by the time it gets here —
      // tolerate a malformed array rather than crash the whole estimate.
      (Array.isArray(arr) ? arr : [])
        .filter(goodSeg)
        .map((s, i) => ({
          id: `engine-${kind}-${i}`,
          kind,
          points: [project(s.p1), project(s.p2)],
        }));
    roofRidges = layoutLines("ridge", el.ridges);
    roofValleys = layoutLines("valley", el.valleys);
    roofHips = layoutLines("hip", el.hips);

    // Gable ENDS → the "engine-gable-…" line channel the overlay already
    // renders as gable wings: a ridge stub (base midpoint → apex) plus the
    // two base→apex slopes. A rake that spans its WHOLE footprint side is a
    // flush gable end — the plan draws no diagonals there, so only the base
    // segment (roofGables, for the GABLE label + skeleton input) is kept.
    const gEnds = (Array.isArray(el.gableEnds) ? el.gableEnds : []).filter(
      (g) =>
        !!g &&
        Array.isArray(g.base) &&
        isGoodPoint(g.base[0]) &&
        isGoodPoint(g.base[1]) &&
        isGoodPoint(g.apex),
    );
    if (gEnds.length > 0) {
      const vertexTol = 4; // canvas px — "base corner sits ON an outline corner"
      const onPerimVertex = (p: BlueprintPoint) =>
        roofPerimeter.some((v) => Math.hypot(v.x - p.x, v.y - p.y) <= vertexTol);
      roofGables = [];
      gEnds.forEach((g, i) => {
        const b0 = project(g.base[0]);
        const b1 = project(g.base[1]);
        const ap = project(g.apex);
        const mid = { x: (b0.x + b1.x) / 2, y: (b0.y + b1.y) / 2 };
        roofGables.push({
          id: `engine-gable-end-${i}`,
          kind: "gable",
          points: [b0, b1],
          ...(g.verify ? { label: "verify" } : {}),
        });
        if (Math.hypot(ap.x - mid.x, ap.y - mid.y) > 1.5) {
          roofRidges.push({
            id: `engine-gable-ridge-${i}`,
            kind: "ridge",
            points: [mid, ap],
          });
          const wholeSide = onPerimVertex(b0) && onPerimVertex(b1);
          if (!wholeSide) {
            roofValleys.push(
              { id: `engine-gable-valley-${i}a`, kind: "valley", points: [b0, ap] },
              { id: `engine-gable-valley-${i}b`, kind: "valley", points: [b1, ap] },
            );
          }
        }
      });
    }

    // Roof PLANES (analysis space → canvas). project() is a uniform positive
    // scale + translation, so the downhill DIRECTION passes through as-is.
    roofFaces = (Array.isArray(el.faces) ? el.faces : [])
      .filter(
        (f) =>
          !!f &&
          Array.isArray(f.polygon) &&
          f.polygon.length >= 3 &&
          f.polygon.every(isGoodPoint) &&
          isGoodPoint(f.downhill),
      )
      .map((f) => ({
        polygon: f.polygon.map((p) => project(p)),
        downhill: { x: f.downhill.x, y: f.downhill.y },
      }));
  }

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
      // The frozen engine count no longer describes what's drawn/priced —
      // the synthesized layout owns the run count now.
      pricedRunCount = null;
      // Replace downspouts only when we also had none rendered — if
      // the AI gave good downspout coordinates, keep them.
      if (downspouts.length === 0) {
        downspouts = syn.downspouts;
      }
      synthesized = true;
    }
  }

  // ── Length-accurate geometry correction ───────────────────────────
  // The canvas measures LF from the drawn pixel geometry (lineLengthFt),
  // but the AI's per-run pixel coordinates are noisy and diverge from its
  // own length_ft values — so the canvas can read 30%+ over the clamped,
  // envelope-capped LF the AI actually reported (the "513 vs 390" gap,
  // plus impossible 103 ft runs on a 64 ft house). Two corrections make
  // the drawing trustworthy and keep header = canvas = price:
  //   1. Uniformly scale the whole trace about its centroid so the total
  //      canvas LF equals the clamped length_ft total. Uniform scale =
  //      zero shape distortion.
  //   2. Cap any single run longer than the building's bounding-box
  //      diagonal — no straight eave can physically exceed it.
  // Then we price from the corrected geometry, not the raw length_ft.
  // Engine mode prices from the engine's real-feet LF; otherwise the clamped,
  // envelope-capped length_ft sum (scaled to the viewBox). Either way the
  // length-correction below scales the drawn eaves so header = canvas = price.
  const targetEaveLF =
    enginePrices && engineBundle
      ? engineBundle.eaveLfFt * ftScale
      : analysis.gutter_runs.reduce((sum, r) => sum + (r.length_ft ?? 0) * ftScale, 0);

  let eaveLF: number;
  if (eaves.length > 0 && targetEaveLF > 0) {
    // Centroid of every eave point — the fixed point of the scale.
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const l of eaves) {
      for (const p of l.points) {
        sx += p.x;
        sy += p.y;
        n++;
      }
    }
    const cx = n > 0 ? sx / n : VIEWBOX_W / 2;
    const cy = n > 0 ? sy / n : VIEWBOX_H / 2;

    const currentFt = eaves.reduce((s, l) => s + lineLenFt(l), 0);
    const scale = currentFt > 0 ? targetEaveLF / currentFt : 1;
    const sp = (p: BlueprintPoint): BlueprintPoint => ({
      x: cx + (p.x - cx) * scale,
      y: cy + (p.y - cy) * scale,
    });

    // (1) Uniform scale eaves + rakes + downspouts about the same point
    // so the whole layout stays registered while the total LF lands on
    // the clamped target.
    eaves = eaves.map((l) => ({ ...l, points: l.points.map(sp) }));
    rakes = rakes.map((l) => ({ ...l, points: l.points.map(sp) }));
    downspouts = downspouts.map((d) => {
      const q = sp({ x: d.x, y: d.y });
      return { ...d, x: q.x, y: q.y };
    });
    // Scale the roof-structure overlay in lockstep so the outline stays
    // registered with the corrected eaves.
    roofPerimeter = roofPerimeter.map(sp);
    const scaleLines = (ls: RoofStructureLine[]) =>
      ls.map((l) => ({ ...l, points: l.points.map(sp) }));
    roofRidges = scaleLines(roofRidges);
    roofValleys = scaleLines(roofValleys);
    roofHips = scaleLines(roofHips);
    roofGables = scaleLines(roofGables);
    roofSteps = scaleLines(roofSteps);
    // Uniform scale about a point — downhill directions are unchanged.
    roofFaces = roofFaces.map((f) => ({ ...f, polygon: f.polygon.map(sp) }));

    // (2) Cap physically-impossible runs. The longest legitimate run is
    // the longest (clamped) length_ft the AI reported — already capped to
    // the building's longest wall by clampBlueprintToEnvelope. Any drawn
    // run longer than that is a projection artifact (the 103 ft run on a
    // 64 ft house); pull it back to that limit. Falls back to the eave
    // bbox diagonal when no length_ft is available.
    //
    // SKIP this in engine-draw mode: there the eaves are the engine's
    // footprint-perimeter edges (chained real walls), not noisy freehand AI
    // runs. A real long wall (e.g. a 64 ft side) legitimately exceeds the
    // longest measured AI run, and shrinking it about its midpoint detaches it
    // from both corners — that is exactly what left the teal perimeter "open"
    // with ~8 ft gaps. The engine's own long_run review flag already guards
    // genuinely-impossible walls, so no clip is needed here.
    const maxRunFt = engineBundle ? Infinity : analysis.gutter_runs.reduce((m, r) => {
      const f = (r.length_ft ?? 0) * ftScale;
      return Number.isFinite(f) && f > m ? f : m;
    }, 0);
    let maxRunPx: number;
    if (maxRunFt > 0) {
      maxRunPx = maxRunFt * 1.02 * SAFE_PX_PER_FT;
    } else {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const l of eaves) {
        for (const p of l.points) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
      }
      maxRunPx = Math.hypot(maxX - minX, maxY - minY) * 1.02;
    }
    if (Number.isFinite(maxRunPx) && maxRunPx > 0) {
      eaves = eaves.map((l) => {
        if (l.points.length !== 2) return l;
        const a = l.points[0];
        const b = l.points[1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len <= maxRunPx || len === 0) return l;
        // Shrink about the midpoint, preserving direction.
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const k = maxRunPx / len / 2;
        return {
          ...l,
          points: [
            { x: mx - (b.x - a.x) * k, y: my - (b.y - a.y) * k },
            { x: mx + (b.x - a.x) * k, y: my + (b.y - a.y) * k },
          ],
        };
      });
    }

    // Price from the corrected geometry so the legend, the property
    // header, and the pricing panel all agree with what's drawn.
    eaveLF = Math.round(eaves.reduce((s, l) => s + lineLenFt(l), 0));
  } else {
    eaveLF = Math.round(targetEaveLF);
  }

  // Recover the gutters on projecting masses (porch/patio/garage on posts or a
  // beam) whose own eaves sit beyond the traced outline — the elevation
  // reconcile flagged them but their LF was previously dropped. Synthesized
  // ONLY when the roof-area schedule gives the mass a real area, and always
  // tagged "estimated — verify" (see notes below). No-op otherwise.
  const projectionSynth = synthesizeProjectionGutterLF(
    opts?.droppedProjections,
    opts?.roofMasses,
  );
  eaveLF += projectionSynth.addedLF;

  // We don't get rake length from Claude — excluded_edges only has
  // endpoints, no source-feet conversion. Estimate rakeLF as the
  // average eave-run length times the rake count so the measurement
  // sheet isn't blank. Contractor can override in the pricing panel.
  // Divide by the FROZEN priced-run count in engine mode (see pricedRunCount)
  // — the display-only interior-run append grows `eaves` but must not shrink
  // the average and move rakeLF (a priced quantity) on existing rows.
  const runCountForPricing = pricedRunCount ?? eaves.length;
  const avgRunLf = runCountForPricing > 0 ? eaveLF / runCountForPricing : 0;
  const rakeLF = Math.round(rakes.length * avgRunLf);

  // Stories: the elevation CONSENSUS when the faces were read (a wall count is
  // direct evidence — the drop-height heuristic below inferred "2 stories"
  // from a defaulted 20 ft drop on the 1168G single-story rambler). Fallback
  // when no face read stories: the max downspout drop, as before.
  const maxDropFt = downspouts.reduce((m, d) => Math.max(m, d.heightFt), 0);
  const heuristicStories: Stories = maxDropFt > 24 ? 3 : maxDropFt > 14 ? 2 : 1;
  const stories: Stories =
    storiesConsensus != null
      ? ((Math.min(3, Math.max(1, storiesConsensus)) as Stories))
      : heuristicStories;
  // A consensus that OVERRODE a taller reading (one face read more floors, or
  // the drop heights implied more) must say so — never silently flip a pill.
  let storiesNote: string | null = null;
  if (storiesConsensus != null && (storiesConsensus < maxFaceStories || storiesConsensus < heuristicStories)) {
    const m = faceStoriesReads.filter((v) => v != null).length;
    const nAgree = faceStoriesReads.filter((v) => v === storiesConsensus).length;
    storiesNote =
      storiesConsensus === 1
        ? `STORIES: ${nAgree} of ${m} elevations read a single story (a clerestory band is not a floor) — priced as 1-story drops. Some downspout drops were read taller; verify heights on the canvas.`
        : `STORIES: ${nAgree} of ${m} elevations read ${storiesConsensus} stories — priced as ${storiesConsensus}-story drops. A taller reading was outvoted; verify heights on the canvas.`;
  }

  const measurements = {
    eaveLF,
    rakeLF,
    outsideCorners: analysis.totals.outside_corner_miters,
    insideCorners: analysis.totals.inside_corner_miters,
    // Each detached run gets two end caps. Approximation but close
    // enough for a starting bid. Count-frozen in engine mode so the
    // display-only interior-run append can't add priced caps.
    endCaps: Math.max(2, runCountForPricing * 2),
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
  for (const n of projectionSynth.notes) notes.push(n);
  if (storiesNote) notes.push(`⚠ ${storiesNote}`);

  if (engineBundle) {
    const eaveCount = engineBundle.takeoff.masses.flatMap((m) => m.edges).filter((e) => e.gutter).length;
    if (enginePrices) {
      notes.push(
        `⚙ Engine takeoff (flag ON): ${engineBundle.eaveLfFt} LF across ${eaveCount} guttered edge(s), ${engineBundle.takeoff.downspouts.length} rule-placed downspout(s).`,
      );
    } else {
      // A mass edge defaults to type "rake" whenever it simply has no gutter
      // coverage (to-masses.ts) — that's "unguttered", not a confirmed gable.
      // On a unanimous-hip read, calling those "gable rakes" contradicts the
      // 4-face check ("15 gable rake(s)" on a zero-gable 1168G) — say what the
      // elevations actually established. Count only the PERIMETER rakes (the
      // ones actually drawn); interior mass boundaries draw as tier-step
      // lines and are reported as such — the note must describe what is on
      // the canvas, not what the decomposition emitted.
      const rakeCount = engineBundle.takeoff.masses
        .flatMap((m) => m.edges)
        .filter((e) => e.type === "rake" && onOuterBoundary(e)).length;
      const stepNote =
        roofSteps.length > 0
          ? `; ${roofSteps.length} tier-step edge(s) drawn as thin solid lines where one roof level drops to another`
          : "";
      notes.push(
        isUnanimousHip(opts?.perFace)
          ? `⚙ Engine-drawn roof geometry (DISPLAY ONLY — not priced): all-hip per the 4-face reads (0 gables)${rakeCount > 0 ? `; ${rakeCount} unguttered edge(s) drawn as plain roof edges` : ""}${stepNote} + a clean straight-skeleton. Pricing stays on the measured-run LF.`
          : `⚙ Engine-drawn roof geometry (DISPLAY ONLY — not priced): ${rakeCount} gable rake(s)${stepNote} + a clean straight-skeleton drawn by rule from the 4-face reads. Pricing stays on the measured-run LF.`,
      );
    }
    // Surface the engine (footprint-perimeter) LF next to what we actually
    // PRICE so a big gap is visible, not silent. The compare is against the
    // final priced eaveLF (incl. any estimated projection LF), so this doesn't
    // re-warn about gutters already recovered above. Direction matters: when
    // the engine DREW more guttered eave than we bill — the classic
    // projecting-side-eave draw/price mismatch the contractor can see on the
    // canvas but that adds $0 — say "drawn but not priced". When it drew less,
    // it may be under-counting a hip-dominant perimeter.
    if (eaveLF > 0 && engineBundle.eaveLfFt > 0) {
      const diff = engineBundle.eaveLfFt - eaveLF;
      const gapPct = Math.abs(diff) / eaveLF;
      if (gapPct <= 0.15) {
        notes.push(
          `⚖ Engine LF ${engineBundle.eaveLfFt} vs priced LF ${eaveLF} — within 15%, consistent.`,
        );
      } else if (diff > 0 && !enginePrices) {
        notes.push(
          `⚖ Engine drew ~${diff} LF MORE guttered eave than is priced (${engineBundle.eaveLfFt} drawn vs ${eaveLF} billed, a ${(gapPct * 100).toFixed(0)}% gap). Likely projecting side-eaves (porch/garage/entry gable returns) the measured runs missed — they show on the canvas but add $0. VERIFY and add them if real.`,
        );
      } else {
        // Priced > drawn: the engine may be under-counting — OR the run
        // lengths are hot against their own drawn geometry (an inflated
        // dimensioned-wall scale read). Check the runs' internal consistency:
        // every run carries length_ft AND pixel geometry, so their ft-per-px
        // ratios should agree; name the worst deviator so the owner knows
        // where to start. Flag-only — priced LF is never touched here.
        const ratios = (analysis.gutter_runs ?? [])
          .map((r) => {
            const px =
              typeof r.length_px === "number" && r.length_px > 0
                ? r.length_px
                : isGoodPoint(r.start) && isGoodPoint(r.end)
                  ? Math.hypot(r.end.x - r.start.x, r.end.y - r.start.y)
                  : 0;
            return px > 0 && typeof r.length_ft === "number" && r.length_ft > 0
              ? { id: r.id, feature: r.feature, ratio: r.length_ft / px, ft: r.length_ft }
              : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        let inflated = "";
        if (ratios.length >= 3) {
          const sorted = [...ratios].sort((a, b) => a.ratio - b.ratio);
          const median = sorted[Math.floor(sorted.length / 2)].ratio;
          const worst = ratios.reduce((w, r) =>
            Math.abs(r.ratio / median - 1) > Math.abs(w.ratio / median - 1) ? r : w,
          );
          const dev = worst.ratio / median - 1;
          if (Math.abs(dev) > 0.2) {
            inflated = ` The runs also disagree with EACH OTHER on scale: "${worst.id}"${worst.feature ? ` (${worst.feature})` : ""} prices its ${worst.ft} LF ${Math.round(Math.abs(dev) * 100)}% ${dev > 0 ? "hotter" : "colder"} per pixel than the median run — the lengths look inflated vs their own drawn geometry; verify the scale before quoting.`;
          }
        }
        notes.push(
          `⚖ Engine LF ${engineBundle.eaveLfFt} vs priced LF ${eaveLF} — a ${(gapPct * 100).toFixed(0)}% gap. VERIFY against the real roof: the engine may be under-counting eaves (edges classed as gable rakes, or runs not on the perimeter) on a hip-dominant roof.` +
            inflated,
        );
      }
    }
    notes.push(
      "⚠ Engine-drawn geometry is for VERIFICATION — eyeball it against the real roof before quoting. It won't over-bill (flush ≤ projecting by construction) but pop-out depths/positions are schematic until confirmed.",
    );
    const mark = { error: "⛔", warn: "⚠", info: "🔎" } as const;
    for (const f of engineBundle.takeoff.reviewFlags) notes.push(`${mark[f.severity]} ${f.message}`);
    for (const n of engineBundle.placementNotes) notes.push(`🏠 ${n}`);
  }

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

  // Only surface the roof outline when we have a real traced footprint
  // that registers with the eaves. When the trace was synthesized (the
  // AI's coords were unusable and we laid out a rectangle from the run
  // lengths), the building_footprint coords are unusable too, so an
  // outline would float misaligned — drop it.
  // v2 layout carries its own evidence-based confidence (how many of the
  // sheet's drawn 45° lines the computed skeleton reproduced) — it outranks
  // the coarse analysis-level confidence.
  const roofConfidence =
    opts?.edgeLayout?.confidence ??
    (analysis.confidence === "high"
      ? 0.9
      : analysis.confidence === "low"
        ? 0.35
        : 0.6);
  // PERIMETER-ONLY: drop the AI-TRACED interior roof geometry from the DRAWN
  // structure (ids "plan-…"). A gutter takeoff is the perimeter + which edges
  // are eaves vs rakes; AI-freehand hips/ridges/valleys off a dense truss
  // sheet are the sparse floating dashes that made the roof unreadable. The
  // ENGINE's interior lines (ids "engine-…") are different: a rule-drawn
  // straight skeleton + gable ridge-backs — those STAY so the diagram reads
  // as a roof plan, not a bare outline. But tier masses overlap in plan, so
  // the flat-mapped skeletons can stack into crossing whole-body fans and
  // floating stubs — filterRoofDiagramLines enforces the roof-plan
  // invariants (no crossings, no over-long hips/valleys, every line anchored
  // to the perimeter or a junction) and keeps only what draws clean.
  // Decorative either way: pricing (eaveLF) is untouched.
  // v2 edgeLayout lines are exempt: they satisfy the invariants by
  // construction (ridges are clipped to die into valleys, T-junction
  // anchored, sheet-adopted valleys are the plan's own strokes — the 40%
  // hip/valley length cap would silently drop a legitimate long valley the
  // confidence score already credited).
  if (perimeterOnly && !opts?.edgeLayout) {
    const engineDrawn = (l: { id: string }) => l.id.startsWith("engine-");
    // strictAnchor = the raster-path rules: RIDGES must anchor at BOTH
    // endpoints (a stub dying into a hidden interior cut wall floats and
    // must drop), and a tiny surviving set (<2 lines, or fragments only)
    // is emitted EMPTY — nothing over fabricated fragments.
    const filtered = filterRoofDiagramLines(
      {
        ridges: roofRidges.filter(engineDrawn),
        valleys: roofValleys.filter(engineDrawn),
        hips: roofHips.filter(engineDrawn),
      },
      roofPerimeter,
      { strictAnchor: true },
    );
    roofRidges = filtered.ridges;
    roofValleys = filtered.valleys;
    roofHips = filtered.hips;
    if (filtered.interiorOmitted) {
      notes.push(
        "Interior roof lines omitted — not enough evidenced structure to draw them; the perimeter and tier steps are exact.",
      );
    }
  }
  // v2 shading back-compat + total-coverage guarantee: layouts stored before
  // faces existed carry none — polygonize the PROJECTED lines instead (the
  // arrangement helper is scale-free), and when even that fails shade the
  // footprint as ONE flat plane rather than leaving the middle empty.
  if (opts?.edgeLayout && !synthesized && roofPerimeter.length >= 3) {
    if (roofFaces.length === 0) {
      const segs = [...roofRidges, ...roofValleys, ...roofHips]
        .filter((l) => l.points.length >= 2)
        .map((l) => ({ p1: l.points[0], p2: l.points[l.points.length - 1] }));
      roofFaces = facesFromRoofLines(roofPerimeter, segs) ?? [];
    }
    if (roofFaces.length === 0) {
      roofFaces = [{ polygon: [...roofPerimeter], downhill: { x: 0.3, y: 1 } }];
    }
  }
  const roofStructure: RoofStructure | undefined =
    !synthesized && roofPerimeter.length >= 3
      ? {
          perimeter: roofPerimeter,
          ridges: roofRidges,
          valleys: roofValleys,
          hips: roofHips,
          ...(roofGables.length > 0 ? { gables: roofGables } : {}),
          ...(roofFaces.length > 0 ? { faces: roofFaces } : {}),
          ...(roofSteps.length > 0 ? { steps: roofSteps } : {}),
          // True gable-structure count: v2 layout counts classified gable-end
          // walls; otherwise the engine's per-face placement. Absent when
          // neither is drawing (AI-only path).
          gableCount:
            opts?.edgeLayout?.gableCount ??
            (engineBundle
              ? engineBundle.massInputs.reduce(
                  (s, m) => s + (m.gables?.length ?? 0),
                  0,
                )
              : undefined),
          confidence: roofConfidence,
        }
      : undefined;

  // UN-PRICED suggestion lines (tap-to-add) — same projection as the eaves so
  // they register with the trace; never summed into eaveLF. Skipped when the
  // layout was synthesized (the projection space is fabricated there).
  const suggestedLines: EditableLine[] = synthesized
    ? []
    : (opts?.suggestedEaves ?? [])
        .filter(
          (s) =>
            Array.isArray(s?.points) &&
            s.points.length >= 2 &&
            s.points.every((p) => isGoodPoint(p)),
        )
        .map((s, i) => ({
          id: `suggested-step-${i}`,
          kind: "eave" as const,
          points: s.points.map(project),
          ...(s.tier ? { tier: s.tier } : {}),
        }));

  // ── Run-label sanity (owner rules from the first gabled plan) ─────────
  // 1. FEATURE names: only the roof-plan-label-derived trio (porch / patio /
  //    garage) may print on a pill. The AI read's other guesses ("ENTRY" on
  //    a 47 LF side run) were wrong more often than right — strip them; the
  //    FRONT/BACK/LEFT/RIGHT chips already say where a run is.
  // 2. TIER majority: a LOWER roof is by definition the minority (a porch or
  //    garage wing under the main roof). When most of the priced LF reads
  //    "lower", the read is inverted or the house is single-story — either
  //    way the split is unreliable, so every run shows as the main tier
  //    (uniform color) instead of painting the whole house amber.
  {
    const TRUSTED_FEATURES = new Set(["porch", "patio", "garage"]);
    let lowerFt = 0;
    let totalFt = 0;
    for (const l of eaves) {
      const ft = lineLenFt(l);
      totalFt += ft;
      if (l.tier === "lower") lowerFt += ft;
    }
    const lowerMajority = totalFt > 0 && lowerFt / totalFt > 0.6;
    eaves = eaves.map((l) => ({
      ...l,
      ...(l.feature && !TRUSTED_FEATURES.has(l.feature)
        ? { feature: undefined }
        : {}),
      ...(lowerMajority && l.tier === "lower" ? { tier: "upper" as const } : {}),
    }));
  }

  // A downspout ALWAYS hangs on the gutter, so it must sit ON an eave line —
  // never floating off the perimeter (the owner's "don't ever leave a
  // downspout outside" note). Regardless of source (AI read, ink takeoff,
  // stale stash), snap each drop onto the nearest point of the nearest eave
  // polyline as the final step, after every projection/scale. A drop with no
  // eave to snap to (degenerate) is dropped rather than left adrift.
  if (eaves.length > 0 && downspouts.length > 0) {
    const nearestOnPolys = (x: number, y: number): { x: number; y: number } | null => {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (const l of eaves) {
        for (let i = 0; i + 1 < l.points.length; i++) {
          const a = l.points[i];
          const b = l.points[i + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const l2 = dx * dx + dy * dy;
          const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
          const qx = a.x + dx * t;
          const qy = a.y + dy * t;
          const d = Math.hypot(x - qx, y - qy);
          if (d < bestD) {
            bestD = d;
            best = { x: qx, y: qy };
          }
        }
      }
      return best;
    };
    downspouts = downspouts
      .map((d) => {
        const q = nearestOnPolys(d.x, d.y);
        return q ? { ...d, x: q.x, y: q.y } : null;
      })
      .filter((d): d is Downspout => d !== null);
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
    roofStructure,
    ...(suggestedLines.length > 0 ? { suggestedEaves: suggestedLines } : {}),
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
          pageCount: meta.pageCount,
          sheets: meta.sheets,
        }
      : undefined,
  };
}
