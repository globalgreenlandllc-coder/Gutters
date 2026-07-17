/**
 * feature-quadrant-sanity.ts — LABEL-ONLY cross-check of the takeoff's
 * feature labels against the roof-plan page's read feature locations.
 *
 * The 1168G live failure this fixes: the trace labels runs by feature
 * (garage/porch/patio) with no location evidence, so "GARAGE" bled along the
 * whole right side into den/outdoor-living territory — the garage is only
 * the front-right corner mass, and the roof page SAYS so (feature_quadrants,
 * read-roof-layout.ts). This pass drops the feature label from any run whose
 * midpoint's outline quadrant CONTRADICTS the page's read quadrant.
 *
 * Doctrine guarantees:
 *  - LF-NEUTRAL RELABEL ONLY: geometry, length_ft, tier and totals are
 *    byte-untouched; only the `feature` key is removed from offending runs.
 *  - Loud note: ONE aggregated note per feature names the count, the read
 *    quadrant and where the offending runs actually sit.
 *  - Degrade byte-identical: no feature_quadrants (old stashes, page labels
 *    nothing) / null-or-"center" quadrant / ambiguous midpoint (inside the
 *    dead band around the outline center) → nothing changes, and the
 *    returned analysis is the caller's OWN object.
 *  - PURE + never throws (mirrors tier-corner-veto.ts / eave-step-reconcile).
 *
 * Quadrant frame: the fixed drafting convention shared with
 * tier-corner-veto.ts HOUSE_NORMALS — y-down canvas, front at the bottom of
 * the sheet (front = +y), left/right as you face the front (right = +x).
 */

import type { BlueprintAnalysis, BlueprintRun } from "./blueprint-from-plans";
import type { RoofPlanFeatureQuadrants, RoofPlanQuadrant } from "./read-roof-layout";
import { isFinitePt } from "../roof-skeleton";

type Pt = { x: number; y: number };

export type FeatureQuadrantSanityResult = {
  /** The caller's analysis object when nothing changed; a shallow copy with
   *  a new gutter_runs array (untouched runs keep their identity) when at
   *  least one label was cleared. Geometry/LF/tier/totals byte-untouched. */
  analysis: BlueprintAnalysis;
  /** One aggregated "🏷 …" note per feature whose labels moved. */
  notes: string[];
  /** ids of the runs whose feature label was cleared. */
  clearedRunIds: string[];
};

/** The run features the roof page can pin by quadrant. `outdoor_living` is
 *  READ (and stored) but has no BlueprintRun.feature counterpart, so it
 *  takes no action here. */
const CHECKED_FEATURES = ["garage", "porch", "patio"] as const;
type CheckedFeature = (typeof CHECKED_FEATURES)[number];

/** Ambiguity dead band around the outline center, per axis, as a fraction of
 *  that axis's extent — a midpoint this close to a center line can't
 *  contradict anything. */
const CENTER_BAND_FRAC = 0.08;

const yWord = (dy: number): "front" | "rear" => (dy > 0 ? "front" : "rear");
const xWord = (dx: number): "left" | "right" => (dx > 0 ? "right" : "left");

/**
 * Clear the feature label from runs the roof page's feature_quadrants
 * contradict. LF-neutral, note-loud, byte-identical degrade — see the
 * module header for the full contract.
 */
export function featureQuadrantSanity(args: {
  analysis: BlueprintAnalysis;
  featureQuadrants: RoofPlanFeatureQuadrants | undefined;
}): FeatureQuadrantSanityResult {
  const unchanged: FeatureQuadrantSanityResult = {
    analysis: args.analysis,
    notes: [],
    clearedRunIds: [],
  };
  try {
    const fq = args.featureQuadrants;
    if (!fq) return unchanged;

    const runs = args.analysis?.gutter_runs;
    if (!Array.isArray(runs) || runs.length === 0) return unchanged;

    // Outline bbox (falling back to the runs' own endpoints when the
    // footprint is missing/degenerate — same space either way).
    const pts: Pt[] = (args.analysis.building_footprint ?? []).filter((p) =>
      isFinitePt(p as Pt),
    );
    if (pts.length < 3) {
      for (const r of runs) {
        if (isFinitePt(r.start as Pt)) pts.push(r.start);
        if (isFinitePt(r.end as Pt)) pts.push(r.end);
      }
    }
    if (pts.length < 3) return unchanged;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const w = maxX - minX;
    const h = maxY - minY;
    if (!(w > 0 && h > 0)) return unchanged;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const bandX = w * CENTER_BAND_FRAC;
    const bandY = h * CENTER_BAND_FRAC;

    /** Quadrant of a run midpoint — null when ambiguous (inside a band). */
    const quadrantOf = (r: BlueprintRun): RoofPlanQuadrant | null => {
      if (!isFinitePt(r.start as Pt) || !isFinitePt(r.end as Pt)) return null;
      const mx = (r.start.x + r.end.x) / 2;
      const my = (r.start.y + r.end.y) / 2;
      if (Math.abs(mx - cx) <= bandX || Math.abs(my - cy) <= bandY) return null;
      return `${yWord(my - cy)}-${xWord(mx - cx)}` as RoofPlanQuadrant;
    };

    // Per feature: the runs whose midpoint quadrant contradicts the read.
    // Cleared by INDEX (model-authored ids aren't guaranteed unique).
    const cleared = new Map<
      CheckedFeature,
      { read: RoofPlanQuadrant; ids: string[]; others: Set<string> }
    >();
    const clearedIdx = new Set<number>();

    runs.forEach((run, i) => {
      const feature = run.feature as CheckedFeature | undefined;
      if (!feature || !CHECKED_FEATURES.includes(feature)) return;
      const read = fq[feature];
      if (!read || read === "center") return; // no verdict for this feature
      const q = quadrantOf(run);
      if (!q || q === read) return; // ambiguous or agreeing → label kept
      clearedIdx.add(i);
      const bucket = cleared.get(feature) ?? { read, ids: [], others: new Set<string>() };
      bucket.ids.push(run.id);
      bucket.others.add(q);
      cleared.set(feature, bucket);
    });

    if (clearedIdx.size === 0) return unchanged;

    // LF-NEUTRAL RELABEL: drop ONLY the feature key; untouched runs keep
    // their object identity (byte-identical outside the cleared set).
    const newRuns = runs.map((r, i) => {
      if (!clearedIdx.has(i)) return r;
      const { feature: _cleared, ...rest } = r;
      return rest as BlueprintRun;
    });

    const notes: string[] = [];
    for (const [feature, b] of cleared) {
      notes.push(
        `🏷 ${b.ids.length} run label(s) moved off ${feature} — the roof plan puts the ${feature} at the ${b.read}, but those runs sit at ${[...b.others].join(" / ")}. Lengths and pricing unchanged; labels cleared to UPPER ROOF.`,
      );
    }

    return {
      analysis: { ...args.analysis, gutter_runs: newRuns },
      notes,
      clearedRunIds: [...cleared.values()].flatMap((b) => b.ids),
    };
  } catch {
    return unchanged;
  }
}
