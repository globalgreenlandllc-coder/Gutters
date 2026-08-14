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
  /** PARTIAL gables read off the elevations: a gable at `centerFrac` (VIEWER
   *  frame, 0 = viewer's far left of that face) spanning `widthFt`. The
   *  overlapped stretch of that face's eave is dashed as a rake — the rest
   *  of the face keeps its gutter (a garage gable must not un-gutter the
   *  whole front). A gable ≥70% of its face's width promotes to a full
   *  gable end (whole side dashes, same as gableSides). Dormers/set-back/
   *  frame-over gables must be filtered by the CALLER (their eave keeps
   *  the gutter). */
  gableReads?: readonly {
    side: Side;
    centerFrac: number;
    widthFt: number;
  }[] | null;
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

    // ── Partial gable spans, per side, on each face's own PLAN axis ──────
    // Viewer-frame fractions (0 = viewer's far left looking AT the face)
    // convert per the fixed front-at-bottom drafting convention:
    //   front: identity      back: 1 − f
    //   left:  identity (viewer L→R = rear→front = minY→maxY, y-down)
    //   right: 1 − f    (viewer L→R = front→rear)
    // Plan-axis frac = (x − minX)/w on front/back, (y − minY)/d on left/right.
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    for (const p of ring) {
      if (p.x < bMinX) bMinX = p.x;
      if (p.x > bMaxX) bMaxX = p.x;
      if (p.y < bMinY) bMinY = p.y;
      if (p.y > bMaxY) bMaxY = p.y;
    }
    const bW = Math.max(bMaxX - bMinX, 1e-9);
    const bD = Math.max(bMaxY - bMinY, 1e-9);
    const faceWidthFt = (side: Side): number =>
      (side === "front" || side === "back" ? bW : bD) * ftPerUnit;
    const planFracOf = (p: Pt, side: Side): number =>
      side === "front" || side === "back"
        ? (p.x - bMinX) / bW
        : (p.y - bMinY) / bD;
    const viewerToPlanFrac = (side: Side, f: number): number =>
      side === "front" || side === "left" ? f : 1 - f;

    const gableSpans = new Map<Side, { lo: number; hi: number }[]>();
    for (const g of args.gableReads ?? []) {
      if (!g || !Number.isFinite(g.centerFrac) || !(g.widthFt > 0)) continue;
      if (g.centerFrac < 0 || g.centerFrac > 1) continue;
      const faceFt = faceWidthFt(g.side);
      if (!(faceFt > 0)) continue;
      // A gable spanning ~the whole face IS the gable end — whole side dashes.
      if (g.widthFt >= faceFt * 0.7) {
        gableSides.add(g.side);
        continue;
      }
      const cPlan = viewerToPlanFrac(g.side, g.centerFrac);
      const half = g.widthFt / faceFt / 2;
      const lo = Math.max(0, cPlan - half);
      const hi = Math.min(1, cPlan + half);
      if (hi - lo < 1e-6) continue;
      const list = gableSpans.get(g.side) ?? [];
      list.push({ lo, hi });
      gableSpans.set(g.side, list);
    }
    // Merge overlapping spans per side so the edge partition is clean.
    for (const [side, list] of gableSpans) {
      list.sort((a, b) => a.lo - b.lo);
      const merged: { lo: number; hi: number }[] = [];
      for (const s of list) {
        const prev = merged[merged.length - 1];
        if (prev && s.lo <= prev.hi) prev.hi = Math.max(prev.hi, s.hi);
        else merged.push({ ...s });
      }
      gableSpans.set(side, merged);
    }

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
    const emitRun = (side: Side, a: Pt, b: Pt): void => {
      const lenPx = Math.hypot(b.x - a.x, b.y - a.y);
      const lenFt = lenPx * ftPerUnit;
      if (!(lenFt >= 1)) return; // sub-foot slivers add noise, not gutter
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
    };
    const emitRake = (side: Side, a: Pt, b: Pt, partial: boolean): void => {
      const lenFt = Math.hypot(b.x - a.x, b.y - a.y) * ftPerUnit;
      if (!(lenFt >= 1)) return;
      gableLf += lenFt;
      excluded.push({
        kind: "rake",
        start: { ...a },
        end: { ...b },
        reason: partial
          ? `gable on the ${side} face (elevation read: ~${round1(lenFt)} ft wide) — no gutter across its end`
          : `gable end on the ${side} face (roof-plan/elevation read) — no gutter across a rake`,
      });
    };

    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const lenPx = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(lenPx * ftPerUnit >= 1)) continue;
      const side = sideOf(a, b);
      if (gableSides.has(side)) {
        emitRake(side, a, b, false);
        continue;
      }
      const spans = gableSpans.get(side);
      if (!spans || spans.length === 0) {
        emitRun(side, a, b);
        continue;
      }
      // Partition this edge at the gable-span boundaries: pieces inside a
      // span dash as rakes, the rest keep their gutter. Work in the edge's
      // own param t, mapping span fracs (plan axis) onto it.
      const fA = planFracOf(a, side);
      const fB = planFracOf(b, side);
      const span01 = (f: number): number =>
        fB !== fA ? (f - fA) / (fB - fA) : -1; // t along the edge for frac f
      const cuts = new Set<number>([0, 1]);
      for (const s of spans) {
        for (const f of [s.lo, s.hi]) {
          const t = span01(f);
          if (t > 1e-6 && t < 1 - 1e-6) cuts.add(t);
        }
      }
      const ts = [...cuts].sort((x, y) => x - y);
      const inSpan = (f: number): boolean =>
        spans.some((s) => f >= s.lo - 1e-9 && f <= s.hi + 1e-9);
      for (let k = 0; k + 1 < ts.length; k++) {
        const t0 = ts[k];
        const t1 = ts[k + 1];
        const p0: Pt = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
        const p1: Pt = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
        const midF = fA + (fB - fA) * ((t0 + t1) / 2);
        if (inSpan(midF)) emitRake(side, p0, p1, true);
        else emitRun(side, p0, p1);
      }
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
