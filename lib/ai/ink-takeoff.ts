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
type Quadrant = "front-left" | "front-right" | "rear-left" | "rear-right" | "center";

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
  /** Roof-plan feature labels by outline quadrant (garage / covered porch /
   *  covered patio / outdoor living). Drives tier COLOR + the porch/patio
   *  label on the runs that sit in each feature's quadrant: a covered
   *  section reads LOWER tier (amber) and is named by POSITION per the owner
   *  rule — front = "porch", rear = "patio". The garage stays main tier.
   *  Absent → every run stays main/upper (byte-identical to before). */
  featureQuadrants?: {
    garage?: Quadrant | null;
    porch?: Quadrant | null;
    outdoor_living?: Quadrant | null;
    patio?: Quadrant | null;
  } | null;
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

    // ── Tier + feature by roof-plan quadrant (owner rule: covered section →
    //    lower tier, named porch (front) / patio (rear); garage → main) ────
    let lowerLf = 0;
    let taggedPorch = false;
    let taggedPatio = false;
    const fq = args.featureQuadrants ?? null;
    if (fq) {
      // bbox for the quadrant test (front = MAX y in analysis space).
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of ring) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;
      // Dead-zone so a left/right feature never grabs a central main-roof eave.
      const xPad = (maxX - minX) * 0.12;
      const yPad = (maxY - minY) * 0.12;
      const runInQuadrant = (run: BlueprintRun, q: Quadrant): boolean => {
        if (q === "center") return false; // too ambiguous to tag safely
        const mx = (run.start.x + run.end.x) / 2;
        const my = (run.start.y + run.end.y) / 2;
        const isFront = my > midY + yPad; // front = max-y half
        const isRear = my < midY - yPad;
        const isRight = mx > midX + xPad;
        const isLeft = mx < midX - xPad;
        const wantFront = q.startsWith("front");
        const wantRight = q.endsWith("right");
        return (wantFront ? isFront : isRear) && (wantRight ? isRight : isLeft);
      };
      // Covered features → lower tier, named by front/rear position. Garage
      // is claimed FIRST (main tier) so a covered feature can't over-tag it.
      const garageQ = fq.garage ?? null;
      const coveredQs: Quadrant[] = [fq.porch, fq.outdoor_living, fq.patio].filter(
        (q): q is Quadrant => !!q && q !== "center",
      );
      for (const e of edgeInfos) {
        if (garageQ && garageQ !== "center" && runInQuadrant(e.run, garageQ)) {
          e.run.feature = "garage"; // main tier — garage roof ≈ main height
          continue;
        }
        for (const q of coveredQs) {
          if (!runInQuadrant(e.run, q)) continue;
          const front = q.startsWith("front");
          e.run.tier = "lower";
          e.run.feature = front ? "porch" : "patio";
          lowerLf += e.lenFt;
          if (front) taggedPorch = true;
          else taggedPatio = true;
          break;
        }
      }
    }

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

    // ── Downspouts: at OUTSIDE (convex) CORNERS — where gutters actually
    //    drop — distributed to the spacing, topped to the printed count ───
    // Real gutter layouts put downspouts at outside corners (the low points
    // of the run), not mid-wall. Walk the guttered runs in ring order; each
    // run's END that is a convex corner is a candidate. Greedily accept a
    // corner once the eave accumulated since the last accepted drop reaches
    // ~0.6× spacing, so drops land at corners spread ≈ one spacing apart.
    const downspouts: BlueprintDownspout[] = [];
    const dropTol = Math.max(1, 2 / ftPerUnit); // ~2 ft de-dupe
    const dsAt = (
      p: Pt,
      run: BlueprintRun,
      reason: BlueprintDownspout["reason"],
    ): boolean => {
      if (downspouts.some((d) => Math.hypot(d.at.x - p.x, d.at.y - p.y) <= dropTol)) return false;
      downspouts.push({
        id: `ink-d${downspouts.length + 1}`,
        at: { ...p },
        from_gutter: run.id,
        drop_direction: run.side === "interior" ? "front" : run.side,
        reason,
        drop_height_ft: run.tier === "lower" ? 10 : null,
      });
      return true;
    };
    // Is a ring vertex (a run's END point) a convex/outside corner?
    const isConvexAt = (pt: Pt): boolean => {
      const i = ring.findIndex((p) => Math.hypot(p.x - pt.x, p.y - pt.y) <= 1e-6);
      if (i < 0) return true; // not a ring vertex (shouldn't happen) — allow
      const p = ring[(i - 1 + ring.length) % ring.length];
      const q = ring[i];
      const r = ring[(i + 1) % ring.length];
      const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
      if (Math.abs(cross) < 1e-9) return false;
      return cw ? cross > 0 : cross < 0;
    };

    const floor =
      typeof args.minDownspouts === "number" && Number.isFinite(args.minDownspouts)
        ? Math.max(0, Math.min(30, Math.floor(args.minDownspouts)))
        : 0;
    const gutterFt = edgeInfos.reduce((s, e) => s + e.lenFt, 0);
    const target = Math.max(floor, Math.ceil(gutterFt / spacingFt), 2);

    // Pass 1 — accept convex corners ≈ one spacing apart.
    let sinceDrop = 0;
    for (const e of edgeInfos) {
      sinceDrop += e.lenFt;
      if (e.lenFt > spacingFt) {
        // A long run also needs a mid-run relief drop.
        const drops = Math.floor(e.lenFt / spacingFt);
        for (let k = 1; k <= drops; k++) {
          const t = k / (drops + 1);
          dsAt(
            { x: e.run.start.x + (e.run.end.x - e.run.start.x) * t, y: e.run.start.y + (e.run.end.y - e.run.start.y) * t },
            e.run,
            "long_run_relief",
          );
        }
      }
      if (sinceDrop >= spacingFt * 0.6 && isConvexAt(e.run.end)) {
        if (dsAt(e.run.end, e.run, "outside_corner")) sinceDrop = 0;
      }
    }
    // Pass 2 — still under target: accept remaining convex corners (closest
    // to evenly spaced first), then any corner, then mid-longest-run relief.
    if (downspouts.length < target) {
      const convexEnds = edgeInfos
        .filter((e) => isConvexAt(e.run.end))
        .sort((a, b) => b.lenFt - a.lenFt);
      for (const e of convexEnds) {
        if (downspouts.length >= target) break;
        dsAt(e.run.end, e.run, "outside_corner");
      }
    }
    if (downspouts.length < target) {
      const byLen = edgeInfos.slice().sort((a, b) => b.lenFt - a.lenFt);
      let li = 0, guard = 0;
      while (downspouts.length < target && guard++ < 90) {
        const e = byLen[li % byLen.length];
        li++;
        const t = 0.3 + 0.4 * ((li * 7919) % 11) / 11;
        dsAt(
          { x: e.run.start.x + (e.run.end.x - e.run.start.x) * t, y: e.run.start.y + (e.run.end.y - e.run.start.y) * t },
          e.run,
          "long_run_relief",
        );
      }
    }
    if (downspouts.length === 0) dsAt(edgeInfos[0].run.end, edgeInfos[0].run, "outside_corner");

    const totals: BlueprintTotals = {
      linear_feet_gutter: round1(gutterLf),
      downspout_count: downspouts.length,
      outside_corner_miters: outsideMiters,
      inside_corner_miters: insideMiters,
    };
    const tierClause =
      taggedPorch || taggedPatio
        ? `; ${round1(lowerLf)} LF on a LOWER covered roof (amber — ${[
            taggedPorch ? "front porch" : null,
            taggedPatio ? "rear patio" : null,
          ]
            .filter(Boolean)
            .join(" + ")}, per the roof-plan labels — verify the tier)`
        : "";
    const summary =
      `📐 INK TAKEOFF — gutters generated directly from the verified sheet outline: ` +
      `${runs.length} eave run(s), ${round1(gutterLf)} LF at the plan's own scale` +
      tierClause +
      (gableLf > 0 ? `; ${round1(gableLf)} LF of gable rake dashed (no gutter)` : "") +
      `; ${downspouts.length} downspout(s) at the outside corners` +
      (floor > 0 ? ` (roof plan shows ≥${floor})` : "") +
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
