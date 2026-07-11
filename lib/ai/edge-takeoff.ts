/**
 * edge-takeoff.ts — turn CLASSIFIED outline edges into the takeoff,
 * deterministically. v2 "classify, don't trace": geometry comes from the
 * plan's own vector outline (exact), classification comes from the edge
 * classifier (per-edge eave/rake/unknown + tier/feature + downspouts + dims).
 * This module does the arithmetic — lengths, corners, downspout placement —
 * and NEVER guesses: an unknown edge is surfaced UNPRICED instead of being
 * defaulted to gutter (the v1 closure default is what kept inventing LF).
 * PURE — node-testable.
 */

import type { OutlineEdge, OverlayPt } from "./plan-overlay";
import { sideOfPerimeterEdge } from "./plan-orientation";

export type EdgeClass = {
  id: string;
  edge_class: "eave" | "rake" | "unknown";
  tier?: "upper" | "lower" | null;
  feature?: string | null;
  evidence?: string[];
  /** Flush gable span(s) occupying only PART of this eave wall, as
   *  [u0,u1] intervals along the edge (0 = p1, 1 = p2). The gutter is
   *  priced on the complement; each gable interval is excluded as rake.
   *  Set by the elevation reconcile when a read gable is clearly
   *  narrower than the wall it pins to (partial-gable walls used to
   *  ship entirely UNPRICED). */
  partial_gables?: { u0: number; u1: number }[];
};

export type EdgeDownspout = { edge_id: string; frac: number };

export type EdgeTakeoffResult = {
  gutter_runs: {
    id: string;
    side: "front" | "back" | "left" | "right" | "interior";
    start: OverlayPt;
    end: OverlayPt;
    length_px: number;
    length_ft: number;
    drains_to: string[];
    tier: "upper" | "lower" | "unknown";
    feature?: "porch" | "patio" | "garage";
  }[];
  excluded_edges: {
    kind: "rake" | "unclassified";
    start: OverlayPt;
    end: OverlayPt;
    reason: string;
  }[];
  downspouts: {
    at: OverlayPt;
    drop_height_ft: number;
    edge_id: string;
    side: "front" | "back" | "left" | "right" | "interior";
  }[];
  totals: {
    eave_lf: number;
    outside_corner_miters: number;
    inside_corner_miters: number;
    downspouts: number;
  };
  unpricedIds: string[];
  notes: string[];
};

const cross = (o: OverlayPt, a: OverlayPt, b: OverlayPt) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function polygonArea(pts: readonly OverlayPt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/**
 * Build the takeoff from classified edges.
 *
 * Corner counting: a corner is a MITER only where two consecutive EAVE edges
 * meet (gutter turns the corner). Outside vs inside from the polygon turn
 * direction, orientation-normalized so winding order doesn't matter.
 */
export function buildEdgeTakeoff(opts: {
  outline: readonly OverlayPt[];
  edges: readonly OutlineEdge[];
  classes: readonly EdgeClass[];
  ptPerFt: number;
  downspouts?: readonly EdgeDownspout[];
  /** drop height per tier, ft (2-story body vs porch/patio). */
  tierHeights?: { upper: number; lower: number };
}): EdgeTakeoffResult {
  const { outline, edges, classes, ptPerFt } = opts;
  const tierHeights = opts.tierHeights ?? { upper: 20, lower: 10 };
  const byId = new Map(classes.map((c) => [c.id, c]));
  const notes: string[] = [];
  const unpricedIds: string[] = [];

  const runs: EdgeTakeoffResult["gutter_runs"] = [];
  const excluded: EdgeTakeoffResult["excluded_edges"] = [];
  // Which ends of each eave edge the gutter actually REACHES — a partial
  // edge whose gable sits at one end must not miter that corner.
  const gutteredEnds = new Map<string, { start: boolean; end: boolean }>();
  // The guttered sub-intervals [u0,u1] of each eave edge (gable spans
  // removed) — the downspout synthesizer measures and places drops on
  // these, never on the gable/rake portion.
  const gutteredIntervals = new Map<string, { u0: number; u1: number }[]>();

  const lerp = (e: OutlineEdge, t: number): OverlayPt => ({
    x: e.p1.x + (e.p2.x - e.p1.x) * t,
    y: e.p1.y + (e.p2.y - e.p1.y) * t,
  });
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  for (const e of edges) {
    if (e.lenPt < 1e-6) continue;
    const c = byId.get(e.id);
    const cls = c?.edge_class ?? "unknown";
    const feature =
      c?.feature === "porch" || c?.feature === "patio" || c?.feature === "garage"
        ? c.feature
        : undefined;
    if (cls === "eave") {
      const tier =
        c?.tier === "lower" ? ("lower" as const) : c?.tier === "upper" ? ("upper" as const) : ("unknown" as const);
      const side = sideOfPerimeterEdge(e.p1, e.p2, outline) ?? "interior";
      // Gable intervals along the edge — merge overlaps, then price the
      // complement. An empty/degenerate list is the plain full-edge case.
      const gables = (c?.partial_gables ?? [])
        .map((g) => ({ u0: clamp01(Math.min(g.u0, g.u1)), u1: clamp01(Math.max(g.u0, g.u1)) }))
        .filter((g) => g.u1 - g.u0 > 1e-6)
        .sort((a, b) => a.u0 - b.u0);
      const merged: { u0: number; u1: number }[] = [];
      for (const g of gables) {
        const last = merged[merged.length - 1];
        if (last && g.u0 <= last.u1) last.u1 = Math.max(last.u1, g.u1);
        else merged.push({ ...g });
      }
      if (merged.length === 0) {
        gutteredEnds.set(e.id, { start: true, end: true });
        gutteredIntervals.set(e.id, [{ u0: 0, u1: 1 }]);
        runs.push({
          id: `edge-${e.id}`,
          side,
          start: e.p1,
          end: e.p2,
          length_px: e.lenPt,
          length_ft: Math.round((e.lenPt / ptPerFt) * 10) / 10,
          drains_to: [],
          tier,
          ...(feature ? { feature } : {}),
        });
      } else {
        // Complement of the gable intervals over [0,1].
        const segs: { u0: number; u1: number }[] = [];
        let cursor = 0;
        for (const g of merged) {
          if (g.u0 > cursor) segs.push({ u0: cursor, u1: g.u0 });
          cursor = Math.max(cursor, g.u1);
        }
        if (cursor < 1) segs.push({ u0: cursor, u1: 1 });
        // Drop slivers the trade wouldn't hang gutter on (< 2 ft).
        const minPt = ptPerFt > 0 ? 2 * ptPerFt : 0;
        const kept = segs.filter((s) => e.lenPt * (s.u1 - s.u0) >= minPt);
        const eps = 0.02;
        gutteredEnds.set(e.id, {
          start: kept.some((s) => s.u0 <= eps),
          end: kept.some((s) => s.u1 >= 1 - eps),
        });
        gutteredIntervals.set(e.id, kept);
        kept.forEach((s, k) => {
          const lenPt = e.lenPt * (s.u1 - s.u0);
          runs.push({
            id: `edge-${e.id}-g${k}`,
            side,
            start: lerp(e, s.u0),
            end: lerp(e, s.u1),
            length_px: lenPt,
            length_ft: Math.round((lenPt / ptPerFt) * 10) / 10,
            drains_to: [],
            tier,
            ...(feature ? { feature } : {}),
          });
        });
        for (const g of merged) {
          excluded.push({
            kind: "rake",
            start: lerp(e, g.u0),
            end: lerp(e, g.u1),
            reason: `Flush gable spans ${Math.round((e.lenPt * (g.u1 - g.u0)) / ptPerFt)}ft of ${e.id} — rake over the gable only; gutter kept on the rest of the wall`,
          });
        }
      }
    } else if (cls === "rake") {
      excluded.push({
        kind: "rake",
        start: e.p1,
        end: e.p2,
        reason:
          c?.evidence && c.evidence.length > 0
            ? `Gable/rake per ${c.evidence.join(", ")}`
            : "Gable/rake per edge classifier",
      });
    } else {
      unpricedIds.push(e.id);
      excluded.push({
        kind: "unclassified",
        start: e.p1,
        end: e.p2,
        reason: "No evidence read for this edge — UNPRICED, review",
      });
    }
  }

  // Corners: consecutive eave-eave pairs only — and on partial edges the
  // gutter must actually REACH the shared corner to miter it.
  const orient = polygonArea(outline) >= 0 ? 1 : -1;
  let outside = 0;
  let inside = 0;
  const n = edges.length;
  for (let i = 0; i < n; i++) {
    const a = edges[i];
    const b = edges[(i + 1) % n];
    if (a.lenPt < 1e-6 || b.lenPt < 1e-6) continue;
    const ca = byId.get(a.id)?.edge_class;
    const cb = byId.get(b.id)?.edge_class;
    if (ca !== "eave" || cb !== "eave") continue;
    if (gutteredEnds.get(a.id)?.end === false) continue;
    if (gutteredEnds.get(b.id)?.start === false) continue;
    const turn = cross(a.p1, a.p2, b.p2) * orient;
    if (turn > 1e-9) outside++;
    else if (turn < -1e-9) inside++;
  }

  // Downspouts at classifier-marked positions (the sheet's own D.S. marks).
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const downspouts: EdgeTakeoffResult["downspouts"] = [];
  for (const d of opts.downspouts ?? []) {
    const e = edgeById.get(d.edge_id);
    if (!e || e.lenPt < 1e-6) continue;
    const f = Math.max(0.05, Math.min(0.95, Number(d.frac) || 0.5));
    const at = {
      x: e.p1.x + (e.p2.x - e.p1.x) * f,
      y: e.p1.y + (e.p2.y - e.p1.y) * f,
    };
    const tier = byId.get(d.edge_id)?.tier;
    downspouts.push({
      at,
      drop_height_ft: tier === "lower" ? tierHeights.lower : tierHeights.upper,
      edge_id: d.edge_id,
      side: sideOfPerimeterEdge(e.p1, e.p2, outline) ?? "interior",
    });
  }

  // No D.S. marks read → synthesize by the 1-per-40 ft trade rule so the
  // takeoff never ships zero downspouts on a guttered roof. One chain =
  // consecutive eave edges around the ring; each chain gets
  // ceil(LF/40) drops spaced evenly along it. Loudly noted — mark-read
  // downspouts are always preferred.
  if (downspouts.length === 0 && runs.length > 0 && ptPerFt > 0) {
    const n = edges.length;
    const isEave = (i: number) => byId.get(edges[i].id)?.edge_class === "eave";
    // Degenerate (zero-length) edges are TRANSPARENT: they must neither
    // count as eave nor break a physically-continuous run in two (a
    // duplicated outline vertex would otherwise mint an extra min-1 drop).
    const isBreaker = (i: number) => !isEave(i) && edges[i].lenPt > 1e-6;
    // Start at a breaker so chains never wrap-split.
    let start = 0;
    while (start < n && !isBreaker(start)) start++;
    const chains: number[][] = [];
    if (start === n) {
      chains.push(edges.map((_, i) => i).filter((i) => isEave(i) && edges[i].lenPt > 1e-6)); // fully guttered ring
    } else {
      let cur: number[] = [];
      for (let k = 1; k <= n; k++) {
        const i = (start + k) % n;
        if (isEave(i) && edges[i].lenPt > 1e-6) cur.push(i);
        else if (isBreaker(i) && cur.length > 0) {
          chains.push(cur);
          cur = [];
        }
      }
      if (cur.length > 0) chains.push(cur);
    }
    // Guttered pt-length of an edge (full, minus any gable spans) and a
    // mapper from a guttered offset → the actual point on the gutter, so a
    // partial-gable edge is never measured or dropped-on over its gable.
    const intervalsOf = (id: string) =>
      gutteredIntervals.get(id) ?? [{ u0: 0, u1: 1 }];
    const gutteredPt = (i: number) => {
      const e = edges[i];
      return intervalsOf(e.id).reduce((s, iv) => s + (iv.u1 - iv.u0) * e.lenPt, 0);
    };
    // offsetPt measured along the edge's GUTTERED length → fraction u.
    const uAtGutteredOffset = (i: number, offsetPt: number): number => {
      const e = edges[i];
      let rem = offsetPt;
      const ivs = intervalsOf(e.id);
      for (const iv of ivs) {
        const segPt = (iv.u1 - iv.u0) * e.lenPt;
        if (rem <= segPt || iv === ivs[ivs.length - 1]) {
          return iv.u0 + Math.max(0, Math.min(segPt, rem)) / e.lenPt;
        }
        rem -= segPt;
      }
      return 0.5;
    };
    for (const chain of chains) {
      if (chain.length === 0) continue;
      const lenPts = chain.map((i) => gutteredPt(i));
      const totalPt = lenPts.reduce((s, l) => s + l, 0);
      const lf = totalPt / ptPerFt;
      if (!Number.isFinite(lf) || lf <= 0) continue;
      // Tiny isolated stubs (short bay jogs between rakes) don't warrant
      // their own drop unless they're all the roof has.
      if (lf < 6 && chains.length > 1) continue;
      const count = Math.min(20, Math.max(1, Math.ceil(lf / 40)));
      for (let d = 0; d < count; d++) {
        let target = ((d + 0.5) / count) * totalPt;
        let ci = 0;
        while (ci < chain.length - 1 && target > lenPts[ci]) {
          target -= lenPts[ci];
          ci++;
        }
        const e = edges[chain[ci]];
        const u = uAtGutteredOffset(chain[ci], target);
        const f = Math.max(0.05, Math.min(0.95, u));
        const tier = byId.get(e.id)?.tier;
        downspouts.push({
          at: {
            x: e.p1.x + (e.p2.x - e.p1.x) * f,
            y: e.p1.y + (e.p2.y - e.p1.y) * f,
          },
          drop_height_ft:
            tier === "lower" ? tierHeights.lower : tierHeights.upper,
          edge_id: e.id,
          side: sideOfPerimeterEdge(e.p1, e.p2, outline) ?? "interior",
        });
      }
    }
    if (downspouts.length > 0) {
      notes.push(
        `⚠ No usable D.S. marks read from the plan — ${downspouts.length} downspout(s) placed by the 1-per-40 ft spacing rule. Verify locations against the plan.`,
      );
    }
  } else if (downspouts.length > 0 && ptPerFt > 0) {
    // Marks are authoritative, but a partial read is the COMMON vision
    // failure — warn when the marks fall far short of trade spacing.
    const totalLf = runs.reduce((s, r) => s + r.length_ft, 0);
    const expected = Math.ceil(totalLf / 40);
    if (Number.isFinite(totalLf) && downspouts.length < expected) {
      notes.push(
        `⚠ Only ${downspouts.length} D.S. mark(s) read for ${Math.round(totalLf)} LF of gutter — 1-per-40 ft spacing suggests ~${expected}. Review for missed marks.`,
      );
    }
  }

  const eaveLf = Math.round(runs.reduce((s, r) => s + r.length_ft, 0) * 10) / 10;
  if (unpricedIds.length > 0) {
    notes.push(
      `⚠ ${unpricedIds.length} edge(s) had no readable evidence (${unpricedIds.join(", ")}) — UNPRICED, review against the elevations.`,
    );
  }
  notes.push(
    `Edge takeoff: ${runs.length} eave edge(s) priced from the plan's own outline at ${Math.round(ptPerFt * 100) / 100} pt/ft; ${excluded.filter((e) => e.kind === "rake").length} gable/rake edge(s) carry no gutter.`,
  );

  return {
    gutter_runs: runs,
    excluded_edges: excluded,
    downspouts,
    totals: {
      eave_lf: eaveLf,
      outside_corner_miters: outside,
      inside_corner_miters: inside,
      downspouts: downspouts.length,
    },
    unpricedIds,
    notes,
  };
}
