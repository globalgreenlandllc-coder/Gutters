/**
 * ink-takeoff.ts — the OWNER-DOCTRINE blueprint takeoff rebuild:
 * "read the blueprint eaves for gutters."
 *
 * When the footprint IS the roof-plan page's own verified ink outline
 * (raster swap applied, scale solved from the printed overalls), the AI's
 * separately-measured gutter runs are the WEAKEST data on the canvas — their
 * per-run scales disagree with each other and with the drawing (the 1168G
 * runs drew as diagonals across the roof and priced 96% hot per pixel).
 * This module REPLACES them wholesale: every perimeter edge of the verified
 * outline becomes a gutter run whose LF is pure geometry × the plan's own
 * scale — deterministic, no AI measurement, no snapping, no reconcile
 * passes. Edges on a gable-end face dash as rakes instead. Downspouts are
 * placed by rule (outside corners + long-run relief, topped up to the
 * elevations' visible-count floor). Miters are counted from the ring's own
 * corner turns.
 *
 * PURE + never throws: any invalid input returns null and the caller keeps
 * the AI takeoff unchanged.
 */

import type {
  BlueprintDownspout,
  BlueprintExcludedEdge,
  BlueprintRun,
  BlueprintTotals,
} from "./blueprint-from-plans";

type Pt = { x: number; y: number };
type Side = "front" | "back" | "left" | "right";

const round1 = (x: number): number => Math.round(x * 10) / 10;
const isFinitePt = (p: unknown): p is Pt =>
  !!p &&
  typeof p === "object" &&
  Number.isFinite((p as Pt).x) &&
  Number.isFinite((p as Pt).y);

export type InkTakeoffResult = {
  runs: BlueprintRun[];
  downspouts: BlueprintDownspout[];
  excluded: BlueprintExcludedEdge[];
  totals: BlueprintTotals;
  /** One-line summary for the analysis notes. */
  summary: string;
  gutterLf: number;
  gableLf: number;
};

/**
 * Deterministic gutter takeoff from a verified perimeter ring.
 *
 * Conventions (the analysis canvas): y-down, front at MAX y — the same
 * frame every other blueprint pass uses.
 */
export function inkTakeoff(args: {
  /** Verified outline in ANALYSIS space (the post-swap building_footprint). */
  ring: readonly Pt[];
  /** Feet per analysis unit (RasterApplyOk.ftPerUnit — the plan's own scale). */
  ftPerUnit: number;
  /** Faces whose perimeter edges are GABLE ENDS (dash, no gutter). */
  gableSides?: readonly Side[] | null;
  /** Elevations' visible downspout count — a placement LOWER bound. */
  minDownspouts?: number | null;
  /** Max gutter run a single downspout serves before relief (default 40 ft). */
  dsSpacingFt?: number;
}): InkTakeoffResult | null {
  try {
    const { ftPerUnit } = args;
    if (!(typeof ftPerUnit === "number" && Number.isFinite(ftPerUnit) && ftPerUnit > 0)) {
      return null;
    }
    const ring = (args.ring ?? []).filter(isFinitePt);
    if (ring.length < 4) return null;
    const spacingFt = args.dsSpacingFt && args.dsSpacingFt > 8 ? args.dsSpacingFt : 40;
    const gableSides = new Set<Side>(args.gableSides ?? []);

    // Centroid + signed area (orientation) for outward normals and turns.
    let cx = 0;
    let cy = 0;
    let area2 = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      cx += a.x;
      cy += a.y;
      area2 += a.x * b.y - b.x * a.y;
    }
    cx /= ring.length;
    cy /= ring.length;
    if (!(Math.abs(area2) > 0)) return null;
    const cw = area2 > 0; // y-down "clockwise" (positive shoelace)

    const sideOf = (a: Pt, b: Pt): Side => {
      // Outward normal of edge a→b for this ring orientation.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let nx = cw ? -dy : dy;
      let ny = cw ? dx : -dx;
      // Guard: it must point AWAY from the centroid.
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if ((mx - cx) * nx + (my - cy) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      if (Math.abs(nx) >= Math.abs(ny)) return nx >= 0 ? "right" : "left";
      return ny >= 0 ? "front" : "back";
    };

    // ── Runs + rakes: one per perimeter edge ─────────────────────────────
    const runs: BlueprintRun[] = [];
    const excluded: BlueprintExcludedEdge[] = [];
    let gutterLf = 0;
    let gableLf = 0;
    type EdgeInfo = { run: BlueprintRun; side: Side; lenFt: number };
    const edgeInfos: EdgeInfo[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const lenPx = Math.hypot(b.x - a.x, b.y - a.y);
      const lenFt = lenPx * ftPerUnit;
      if (!(lenFt >= 1)) continue; // sub-foot slivers add noise, not gutter
      const side = sideOf(a, b);
      if (gableSides.has(side)) {
        gableLf += lenFt;
        excluded.push({
          kind: "rake",
          start: { ...a },
          end: { ...b },
          reason: `gable end on the ${side} face (roof-plan/elevation read) — no gutter across a rake`,
        });
        continue;
      }
      const run: BlueprintRun = {
        id: `ink-g${runs.length + 1}`,
        side,
        start: { ...a },
        end: { ...b },
        length_ft: round1(lenFt),
        length_px: lenPx,
        drains_to: [],
        tier: "upper",
      };
      gutterLf += lenFt;
      runs.push(run);
      edgeInfos.push({ run, side, lenFt });
    }
    if (runs.length === 0) return null;

    // ── Miters from the ring's own corner turns ──────────────────────────
    let outsideMiters = 0;
    let insideMiters = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[(i - 1 + ring.length) % ring.length];
      const q = ring[i];
      const r = ring[(i + 1) % ring.length];
      const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
      if (Math.abs(cross) < 1e-9) continue;
      const convex = cw ? cross > 0 : cross < 0;
      if (convex) outsideMiters++;
      else insideMiters++;
    }

    // ── Downspouts: outside corners first, relief on long runs, then top
    //    up to the elevations' floor on the longest runs ─────────────────
    const downspouts: BlueprintDownspout[] = [];
    const dsAt = (
      p: Pt,
      run: BlueprintRun,
      reason: BlueprintDownspout["reason"],
    ): void => {
      // Never stack two drops on (nearly) the same point.
      const tol = 2 / ftPerUnit > 0 ? 2 / ftPerUnit : 1; // ~2 ft
      if (downspouts.some((d) => Math.hypot(d.at.x - p.x, d.at.y - p.y) <= tol)) return;
      downspouts.push({
        id: `ink-d${downspouts.length + 1}`,
        at: { ...p },
        from_gutter: run.id,
        drop_direction: run.side === "front" || run.side === "back" || run.side === "left" || run.side === "right" ? run.side : "front",
        reason,
      });
    };

    // Walk the guttered edges in ring order, dropping at the END of a
    // stretch whenever the accumulated eave since the last drop reaches the
    // spacing (a drop serves ≤ spacing ft of gutter on each side of it).
    let sinceDrop = 0;
    for (const e of edgeInfos) {
      sinceDrop += e.lenFt;
      // Long single run: relief drop(s) mid-run.
      if (e.lenFt > spacingFt) {
        const drops = Math.floor(e.lenFt / spacingFt);
        for (let k = 1; k <= drops; k++) {
          const t = k / (drops + 1);
          dsAt(
            {
              x: e.run.start.x + (e.run.end.x - e.run.start.x) * t,
              y: e.run.start.y + (e.run.end.y - e.run.start.y) * t,
            },
            e.run,
            "long_run_relief",
          );
        }
        sinceDrop = e.lenFt / 2;
        continue;
      }
      if (sinceDrop >= spacingFt * 0.75) {
        dsAt(e.run.end, e.run, "outside_corner");
        sinceDrop = 0;
      }
    }
    if (downspouts.length === 0) {
      // Degenerate tiny building: one drop at the first run's end.
      dsAt(edgeInfos[0].run.end, edgeInfos[0].run, "outside_corner");
    }
    // Top up to the elevations' visible floor: extra relief on the longest
    // runs, spread evenly.
    const floor =
      typeof args.minDownspouts === "number" && Number.isFinite(args.minDownspouts)
        ? Math.max(0, Math.min(30, Math.floor(args.minDownspouts)))
        : 0;
    if (floor > downspouts.length) {
      const byLen = edgeInfos.slice().sort((a, b) => b.lenFt - a.lenFt);
      let li = 0;
      let guard = 0;
      while (downspouts.length < floor && guard++ < 90) {
        const e = byLen[li % byLen.length];
        li++;
        const t = 0.28 + 0.44 * ((li * 7919) % 13) / 13; // deterministic spread
        dsAt(
          {
            x: e.run.start.x + (e.run.end.x - e.run.start.x) * t,
            y: e.run.start.y + (e.run.end.y - e.run.start.y) * t,
          },
          e.run,
          "long_run_relief",
        );
      }
    }

    const totals: BlueprintTotals = {
      linear_feet_gutter: round1(gutterLf),
      downspout_count: downspouts.length,
      outside_corner_miters: outsideMiters,
      inside_corner_miters: insideMiters,
    };
    const summary =
      `📐 INK TAKEOFF — gutters generated directly from the verified sheet outline: ` +
      `${runs.length} eave run(s), ${round1(gutterLf)} LF at the plan's own scale` +
      (gableLf > 0 ? `; ${round1(gableLf)} LF of gable rake dashed (no gutter)` : "") +
      `; ${downspouts.length} downspout(s) by corner/spacing rule` +
      (floor > 0 ? ` (elevations show ≥${floor})` : "") +
      `; ${outsideMiters} outside + ${insideMiters} inside miters from the outline's own corners. ` +
      `The AI-measured runs were replaced — their lengths disagreed with the drawing.`;

    return {
      runs,
      downspouts,
      excluded,
      totals,
      summary,
      gutterLf: round1(gutterLf),
      gableLf: round1(gableLf),
    };
  } catch {
    return null;
  }
}
