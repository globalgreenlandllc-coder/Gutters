/**
 * Roof LAYOUT from the classified perimeter — the v2 interior geometry.
 *
 * The v2 principle applied to the roof diagram: the AI never draws a line.
 * The perimeter is the plan's own vector outline; the classifier says which
 * edges are eaves and which are gable (rake) walls; THIS module computes the
 * interior — ridges, hips, valleys — deterministically as the weighted
 * straight skeleton of that classified polygon (rake walls held stationary,
 * so ridges run flush to gable ends and no hip is drawn there). Same math a
 * framer's roof obeys: every eave plane rises at one pitch, planes meet on
 * the skeleton.
 *
 * Evidence beats derivation: the roof-framing sheet DRAWS its hips and
 * valleys, and on a truss plan every long diagonal stroke is one (trusses,
 * walls, and dims are axis-aligned). We extract those diagonals from the
 * sheet's vectors and (a) score the computed skeleton against them — the
 * match ratio drives the drawn diagram's confidence (the canvas shows
 * "Schematic — verify" below 0.7) — and (b) ADOPT long unmatched ones as
 * valleys, because a multi-pitch or multi-tier roof has creases a uniform
 * skeleton cannot synthesize but the sheet plots exactly.
 *
 * Robustness ladder (a wrong diagram is worse than a sparser one):
 *   full rake set → drop one degenerate gable wall → all-eave skeleton →
 *   sheet-diagonals only → nothing (ok:false, fail loud).
 *
 * Pure module — no AI, no server-only imports; runs under node --test.
 */

import {
  deriveRoofSkeletonStraight,
  validateSkeleton,
} from "../roof-skeleton-straight";
import type { Seg as SkelSeg, SkeletonLine, RoofSkeleton } from "../roof-skeleton";
import type { OutlineEdge, OverlayPt } from "./plan-overlay";
import type { EdgeClass } from "./edge-takeoff";
import { pointInPolygon } from "./plan-orientation";
import { facesFromRoofLines, type RoofFacePoly } from "./roof-faces-from-lines";

export type LayoutSeg = { p1: OverlayPt; p2: OverlayPt };

/** A gable-end triangle, anchored to the outline edge it rises from. The
 *  canvas draws it as a WING (base + the two base→apex slopes) so a gable
 *  reads as an actual gable form, not an anonymous ridge stub. Decorative —
 *  pricing never reads it. */
export type GableEnd = {
  /** outline edge id the gable end sits on ("" when unmatched) */
  edgeId: string;
  /** the rake wall the gable planes rise from */
  base: [OverlayPt, OverlayPt];
  /** plan-view peak — where the gable's ridge leaves the wall span */
  apex: OverlayPt;
  /** true = recorded from an elevation gable the reconcile REJECTED from
   *  pricing (frame-over / beam) — drawn the same, flagged verify */
  verify?: boolean;
};

export type RoofLayoutDiag = {
  /** distinct long diagonal strokes drawn on the roof sheet inside the outline */
  planDiagonals: number;
  /** of those, how many the computed skeleton reproduces */
  matchedPlan: number;
  /** hips + valleys the skeleton drew */
  skeletonDiagonals: number;
  /** of those, how many the sheet's own linework evidences */
  matchedSkel: number;
  /** sheet diagonals adopted into the drawn layout (creases the uniform
   *  skeleton can't synthesize — pitch breaks, tier intersections) */
  adopted: number;
};

export type RoofLayout = {
  ok: boolean;
  reason?: string;
  ridges: LayoutSeg[];
  hips: LayoutSeg[];
  valleys: LayoutSeg[];
  /** outline edge ids the classifier called rake — the gable end walls */
  rakeEdgeIds: string[];
  gableCount: number;
  /** Edge-anchored gable-end triangles — carried on BOTH paths (kept
   *  skeleton or rule-drawn ridge-backs) so the drawn gables never vanish
   *  when the skeleton degenerates. Decorative only. */
  gableEnds: GableEnd[];
  /** Roof PLANES tiling the outline: the skeleton's validated faces when it
   *  stood, else a planar polygonization of the kept lines
   *  (facesFromRoofLines). Undefined when neither validates — the estimate
   *  bridge falls back to a single flat face so shading always covers. */
  faces?: RoofFacePoly[];
  diag?: RoofLayoutDiag;
  /** 0..1 — drives the canvas "Schematic — verify" banner (shown < 0.7) */
  confidence: number;
  notes: string[];
};

const fail = (reason: string): RoofLayout => ({
  ok: false,
  reason,
  ridges: [],
  hips: [],
  valleys: [],
  rakeEdgeIds: [],
  gableCount: 0,
  gableEnds: [],
  confidence: 0,
  notes: [`📐 Roof layout not drawn: ${reason}`],
});

function toSeg(l: SkeletonLine): LayoutSeg {
  return {
    p1: { x: l.points[0].x, y: l.points[0].y },
    p2: { x: l.points[1].x, y: l.points[1].y },
  };
}

function outlineSpan(outline: readonly OverlayPt[]): number {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of outline) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

/** Distance from point p to segment [a, b]. */
function distToSeg(p: OverlayPt, a: OverlayPt, b: OverlayPt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export type PlanDiag = {
  p1: OverlayPt;
  p2: OverlayPt;
  slope: 1 | -1;
  mid: OverlayPt;
  len: number;
  /** absolute angle off horizontal, degrees (22..68 by construction) */
  angleDeg: number;
};

/**
 * Pull the roof sheet's own hip/valley candidates out of its vector linework:
 * long diagonal strokes (22°–68° off axis — a 45° hip on equal pitches, but a
 * 6:12-meets-4:12 valley plots steeper) whose midpoint lies inside the
 * outline. Trusses, walls, and dimension lines are axis-aligned on a framing
 * plan, so surviving diagonals are almost pure hip/valley signal.
 * Near-duplicate parallel strokes (double-drawn lines) are merged.
 */
export function extractPlanDiagonals(
  segments: readonly number[][],
  outline: readonly OverlayPt[],
): PlanDiag[] {
  const span = outlineSpan(outline);
  if (!Number.isFinite(span) || span <= 0) return [];
  const minLen = Math.max(30, span * 0.045);
  const raw: PlanDiag[] = [];
  for (const s of segments) {
    if (!s || s.length < 4) continue;
    const [x1, y1, x2, y2] = s;
    const adx = Math.abs(x2 - x1);
    const ady = Math.abs(y2 - y1);
    const len = Math.hypot(adx, ady);
    if (len < minLen) continue;
    if (adx < 1e-6 || ady < 1e-6) continue;
    // 22°–68°: |dy|/|dx| in [0.40, 2.50] — rejects axis linework + leaders
    // that run nearly flat/steep, keeps unequal-pitch valleys.
    const ratio = ady / adx;
    if (ratio < 0.4 || ratio > 2.5) continue;
    const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    if (!pointInPolygon(mid, outline)) continue;
    const slope: 1 | -1 = (x2 - x1) * (y2 - y1) > 0 ? 1 : -1;
    raw.push({
      p1: { x: x1, y: y1 },
      p2: { x: x2, y: y2 },
      slope,
      mid,
      len,
      angleDeg: (Math.atan2(ady, adx) * 180) / Math.PI,
    });
  }
  // Merge near-duplicates: same slope, similar angle, one lying on the other
  // (double-stroked plan lines). Keep the longest of each cluster.
  const tol = Math.max(6, span * 0.012);
  raw.sort((a, b) => b.len - a.len);
  const merged: PlanDiag[] = [];
  for (const d of raw) {
    const dup = merged.some(
      (m) =>
        m.slope === d.slope &&
        Math.abs(m.angleDeg - d.angleDeg) <= 8 &&
        distToSeg(d.mid, m.p1, m.p2) <= tol,
    );
    if (!dup) merged.push(d);
  }
  return merged;
}

/** Ray o + t·d against segment [a,b]; smallest positive t or null. */
function raySegT(
  o: OverlayPt,
  d: OverlayPt,
  a: OverlayPt,
  b: OverlayPt,
): number | null {
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denom = d.x * sy - d.y * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qx = a.x - o.x;
  const qy = a.y - o.y;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * d.y - qy * d.x) / denom;
  if (t <= 1e-6 || u < -0.02 || u > 1.02) return null;
  return t;
}

/** Inward unit normal of an outline edge, found by probing the polygon. */
function inwardNormalOf(
  e: OutlineEdge,
  outline: readonly OverlayPt[],
  span: number,
): OverlayPt | null {
  const dx = e.p2.x - e.p1.x;
  const dy = e.p2.y - e.p1.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  const probeAt = (sx: number, sy: number) => ({
    x: e.mid.x + sx * span * 0.005,
    y: e.mid.y + sy * span * 0.005,
  });
  if (!pointInPolygon(probeAt(nx, ny), outline)) {
    nx = -nx;
    ny = -ny;
    if (!pointInPolygon(probeAt(nx, ny), outline)) return null;
  }
  return { x: nx, y: ny };
}

/**
 * A gable wall's ridge, drawn by rule: from the wall midpoint straight
 * inward until it dies into the first sheet-drawn valley or main ridge (the
 * plan says where its planes meet the next mass), never past the footprint
 * boundary.
 */
function ridgeBack(
  e: OutlineEdge,
  outline: readonly OverlayPt[],
  stopAt: readonly LayoutSeg[],
  span: number,
): LayoutSeg | null {
  const n = inwardNormalOf(e, outline, span);
  if (!n) return null;
  const o = { x: e.mid.x + n.x * 0.5, y: e.mid.y + n.y * 0.5 };
  // The outline-exit crossing always bounds an interior ray — start the stop
  // distance beyond any real geometry so a long mass's ridge isn't truncated.
  let tStop = span * 2;
  for (const v of stopAt) {
    const t = raySegT(o, n, v.p1, v.p2);
    if (t !== null && t < tStop) tStop = t;
  }
  for (let i = 0; i < outline.length; i++) {
    const t = raySegT(o, n, outline[i], outline[(i + 1) % outline.length]);
    if (t !== null && t < tStop) tStop = t;
  }
  if (tStop < span * 0.03 || tStop > span * 1.5) return null;
  return {
    p1: { x: e.mid.x, y: e.mid.y },
    p2: { x: o.x + n.x * tStop, y: o.y + n.y * tStop },
  };
}

/**
 * Where several sheet valleys END on one axis line, the roof planes they
 * bound meet at a common ridge — connect the aligned endpoints. Conservative:
 * needs endpoints from ≥2 distinct valleys, a real span, and an interior
 * midpoint; at most the two longest.
 */
function mainRidgesFromValleys(
  valleys: readonly LayoutSeg[],
  outline: readonly OverlayPt[],
  span: number,
): LayoutSeg[] {
  const tol = Math.max(8, span * 0.02);
  const endpoints = valleys.flatMap((v, vi) => [
    { p: v.p1, vi },
    { p: v.p2, vi },
  ]);
  type Cand = LayoutSeg & { len: number; members: string; alongSpan: number };
  const out: Cand[] = [];
  for (const axis of ["y", "x"] as const) {
    const fixed = (p: OverlayPt) => (axis === "y" ? p.y : p.x);
    const along = (p: OverlayPt) => (axis === "y" ? p.x : p.y);
    const taken = new Set<number>();
    for (let i = 0; i < endpoints.length; i++) {
      if (taken.has(i)) continue;
      const cluster = [endpoints[i]];
      taken.add(i);
      for (let j = i + 1; j < endpoints.length; j++) {
        if (taken.has(j)) continue;
        if (Math.abs(fixed(endpoints[j].p) - fixed(endpoints[i].p)) <= tol) {
          cluster.push(endpoints[j]);
          taken.add(j);
        }
      }
      const memberSet = [...new Set(cluster.map((c) => c.vi))].sort((a, b) => a - b);
      if (cluster.length < 2 || memberSet.length < 2) continue;
      const alongs = cluster.map((c) => along(c.p));
      const lo = Math.min(...alongs);
      const hi = Math.max(...alongs);
      const alongSpan = hi - lo;
      if (alongSpan < span * 0.08) continue;
      const f =
        cluster.map((c) => fixed(c.p)).sort((a, b) => a - b)[
          Math.floor(cluster.length / 2)
        ];
      let p1 = axis === "y" ? { x: lo, y: f } : { x: f, y: lo };
      let p2 = axis === "y" ? { x: hi, y: f } : { x: f, y: hi };
      // A ridge DIES into a valley, never crosses it: clip at PROPER valley
      // crossings and keep the longest clean piece. A valley that merely ENDS
      // on this line (u near 0/1 — the endpoints that defined the cluster)
      // is a termination, not a crossing: never a cut.
      const cuts = [0, 1];
      const d = { x: p2.x - p1.x, y: p2.y - p1.y };
      for (const v of valleys) {
        const sx = v.p2.x - v.p1.x;
        const sy = v.p2.y - v.p1.y;
        const denom = d.x * sy - d.y * sx;
        if (Math.abs(denom) < 1e-9) continue;
        const qx = v.p1.x - p1.x;
        const qy = v.p1.y - p1.y;
        const t = (qx * sy - qy * sx) / denom;
        const u = (qx * d.y - qy * d.x) / denom;
        if (t > 0.02 && t < 0.98 && u > 0.05 && u < 0.95) cuts.push(t);
      }
      cuts.sort((a, b) => a - b);
      let bestLo = 0;
      let bestLen = -1;
      for (let c = 0; c + 1 < cuts.length; c++) {
        if (cuts[c + 1] - cuts[c] > bestLen) {
          bestLen = cuts[c + 1] - cuts[c];
          bestLo = cuts[c];
        }
      }
      p2 = { x: p1.x + d.x * (bestLo + bestLen), y: p1.y + d.y * (bestLo + bestLen) };
      p1 = { x: p1.x + d.x * bestLo, y: p1.y + d.y * bestLo };
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (len < span * 0.08) continue;
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      if (!pointInPolygon(mid, outline)) continue;
      out.push({ p1, p2, len, members: memberSet.join(","), alongSpan });
    }
  }
  // A valley bank can put BOTH its end lines through the gates (tops AND
  // feet aligned). Which end is the ridge is not decidable from plan
  // geometry alone — and a phantom ridge along the valley FEET (midway down
  // the roof planes) is far worse than no main ridge. Draw neither; the
  // gable ridge-backs still anchor the diagram. Only an UNAMBIGUOUS cluster
  // (its valleys' other ends don't form a second line) synthesizes a ridge.
  const byMembers = new Map<string, Cand[]>();
  for (const c of out) {
    const arr = byMembers.get(c.members) ?? [];
    arr.push(c);
    byMembers.set(c.members, arr);
  }
  const kept: Cand[] = [];
  for (const group of byMembers.values()) {
    if (group.length === 1) kept.push(group[0]);
  }
  const picked = kept
    .sort((a, b) => b.members.split(",").length - a.members.split(",").length || b.len - a.len)
    .slice(0, 2);
  // Two synthesized ridges (one per axis) may properly cross — keep the first.
  if (picked.length === 2) {
    const [a, b] = picked;
    const orient = (p: OverlayPt, q: OverlayPt, r: OverlayPt) =>
      Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    const properCross =
      orient(a.p1, a.p2, b.p1) * orient(a.p1, a.p2, b.p2) < 0 &&
      orient(b.p1, b.p2, a.p1) * orient(b.p1, b.p2, a.p2) < 0;
    if (properCross) picked.pop();
  }
  return picked.map(({ p1, p2 }) => ({ p1, p2 }));
}

/** Nearest point on segment ab to p, with its distance. */
function nearestOnSeg(
  p: OverlayPt,
  a: OverlayPt,
  b: OverlayPt,
): { q: OverlayPt; d: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t =
    len2 < 1e-12
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  const q = { x: a.x + abx * t, y: a.y + aby * t };
  return { q, d: Math.hypot(p.x - q.x, p.y - q.y) };
}

/** First intersection of ray p + t·d (t in (0, tMax]) with segment ab. */
function raySegHit(
  p: OverlayPt,
  d: { x: number; y: number },
  a: OverlayPt,
  b: OverlayPt,
  tMax: number,
): { q: OverlayPt; t: number } | null {
  const rx = d.x;
  const ry = d.y;
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((a.x - p.x) * sy - (a.y - p.y) * sx) / denom;
  const u = ((a.x - p.x) * ry - (a.y - p.y) * rx) / denom;
  if (t <= 1e-9 || t > tMax || u < -0.02 || u > 1.02) return null;
  return { q: { x: p.x + rx * t, y: p.y + ry * t }, t };
}

/**
 * Organize the sheet-adopted diagonals into the drawn frame. Adopted strokes
 * are the plan's own vectors, but the plan draws them only along part of a
 * valley's true run — so on the canvas they FLOAT: ends hanging mid-plane,
 * meeting nothing (the "random lines" review). Physically a valley runs from
 * a reflex eave corner up to a ridge/another valley, so each endpoint is
 * SNAPPED to the nearest frame geometry (ridge/hip/valley/outline) within a
 * small tolerance, else EXTENDED along its own direction until it hits the
 * frame. A stroke that still anchors nowhere is dropped — with a note, never
 * silently. Geometry-only: adopted strokes keep their direction; nothing is
 * invented off-axis.
 */
export function organizeInterior(opts: {
  adopted: readonly LayoutSeg[];
  frame: readonly LayoutSeg[]; // ridges + hips + non-adopted valleys
  outline: readonly OverlayPt[];
  span: number;
}): { kept: LayoutSeg[]; connected: number; dropped: number } {
  const { adopted, frame, outline, span } = opts;
  const snapTol = Math.max(8, span * 0.035);
  const extendTol = span * 0.22;
  const outlineSegs: LayoutSeg[] = outline.map((p, i) => ({
    p1: p,
    p2: outline[(i + 1) % outline.length],
  }));
  // FIXPOINT over the adoptee set: anchor geometry includes the other
  // adopted strokes (two dormer valleys meet each other at the apex), but a
  // stroke must never stay "connected" to a neighbor that itself gets
  // dropped as a stray — that anchor is phantom ink. Re-run with dropped
  // strokes removed until the surviving set stabilizes (hard-capped; each
  // round can only shrink the set).
  let activeIdx = adopted.map((_, i) => i);
  let kept: { seg: LayoutSeg; origMid: OverlayPt }[] = [];
  let connected = 0;
  for (let round = 0; round < 6; round++) {
    kept = [];
    connected = 0;
    const survivors: number[] = [];
    for (const i of activeIdx) {
      const s = adopted[i];
      const anchors: LayoutSeg[] = [
        ...frame,
        ...outlineSegs,
        ...activeIdx.filter((j) => j !== i).map((j) => adopted[j]),
      ];
      const pts = [
        { x: s.p1.x, y: s.p1.y },
        { x: s.p2.x, y: s.p2.y },
      ];
      const anchoredFlags = [false, false];
      let moved = false;
      for (const end of [0, 1] as const) {
        const p = pts[end];
        // 1) snap to the nearest anchor point within tolerance
        let best: { q: OverlayPt; d: number } | null = null;
        for (const a of anchors) {
          const hit = nearestOnSeg(p, a.p1, a.p2);
          if (hit.d <= snapTol && (!best || hit.d < best.d)) best = hit;
        }
        if (best) {
          if (best.d > 1e-6) moved = true;
          pts[end] = best.q;
          anchoredFlags[end] = true;
          continue;
        }
        // 2) extend outward along the stroke's ORIGINAL ink direction (the
        // other endpoint may already be snapped — a lateral snap must not
        // rotate the ray and shoot it at a far anchor off-axis)
        const origSelf = end === 0 ? s.p1 : s.p2;
        const origOther = end === 0 ? s.p2 : s.p1;
        const len =
          Math.hypot(origSelf.x - origOther.x, origSelf.y - origOther.y) || 1;
        const dir = {
          x: (origSelf.x - origOther.x) / len,
          y: (origSelf.y - origOther.y) / len,
        };
        let hitBest: { q: OverlayPt; t: number } | null = null;
        for (const a of anchors) {
          const hit = raySegHit(p, dir, a.p1, a.p2, extendTol);
          if (hit && (!hitBest || hit.t < hitBest.t)) hitBest = hit;
        }
        if (hitBest) {
          pts[end] = hitBest.q;
          anchoredFlags[end] = true;
          moved = true;
        }
      }
      const newLen = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (!anchoredFlags[0] && !anchoredFlags[1]) continue; // stray — dropped
      if (newLen < span * 0.03) continue; // collapsed to a dot
      if (moved) connected++;
      survivors.push(i);
      kept.push({
        seg: { p1: pts[0], p2: pts[1] },
        origMid: { x: (s.p1.x + s.p2.x) / 2, y: (s.p1.y + s.p2.y) / 2 },
      });
    }
    const stable = survivors.length === activeIdx.length;
    activeIdx = survivors;
    if (stable) break;
  }
  const dropped = adopted.length - activeIdx.length;

  // Two valleys cannot CROSS mid-plane — where two organized strokes now
  // properly intersect (an extension overshot), the crossing IS their real
  // junction: trim each back to it, keeping the side that holds the sheet's
  // original ink. The X becomes the V the plan means, and the estimate
  // path's crossing filter no longer has to kill either stroke.
  const paramOf = (s: LayoutSeg, p: OverlayPt): number => {
    const dx = s.p2.x - s.p1.x;
    const dy = s.p2.y - s.p1.y;
    const len2 = dx * dx + dy * dy;
    return len2 < 1e-12
      ? 0
      : ((p.x - s.p1.x) * dx + (p.y - s.p1.y) * dy) / len2;
  };
  const properCross = (a: LayoutSeg, b: LayoutSeg): OverlayPt | null => {
    const rx = a.p2.x - a.p1.x;
    const ry = a.p2.y - a.p1.y;
    const sx = b.p2.x - b.p1.x;
    const sy = b.p2.y - b.p1.y;
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-12) return null;
    const t = ((b.p1.x - a.p1.x) * sy - (b.p1.y - a.p1.y) * sx) / denom;
    const u = ((b.p1.x - a.p1.x) * ry - (b.p1.y - a.p1.y) * rx) / denom;
    if (t <= 0.02 || t >= 0.98 || u <= 0.02 || u >= 0.98) return null;
    return { x: a.p1.x + rx * t, y: a.p1.y + ry * t };
  };
  const trimTo = (k: (typeof kept)[number], x: OverlayPt) => {
    const tX = paramOf(k.seg, x);
    const tM = paramOf(k.seg, k.origMid);
    if (tM <= tX) k.seg = { p1: k.seg.p1, p2: x };
    else k.seg = { p1: x, p2: k.seg.p2 };
  };
  for (let a = 0; a < kept.length; a++) {
    for (let b = a + 1; b < kept.length; b++) {
      const x = properCross(kept[a].seg, kept[b].seg);
      if (!x) continue;
      trimTo(kept[a], x);
      trimTo(kept[b], x);
    }
  }
  return { kept: kept.map((k) => k.seg), connected, dropped };
}

function segAngle(s: LayoutSeg): { slope: 1 | -1 | 0; angleDeg: number } {
  const dx = s.p2.x - s.p1.x;
  const dy = s.p2.y - s.p1.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const angleDeg = (Math.atan2(ady, adx) * 180) / Math.PI;
  if (adx < 1e-6 || ady < 1e-6) return { slope: 0, angleDeg };
  const ratio = ady / adx;
  if (ratio < 0.3 || ratio > 3.4) return { slope: 0, angleDeg };
  return { slope: dx * dy > 0 ? 1 : -1, angleDeg };
}

/** Match plan diagonals against skeleton diagonals — ONE shared predicate so
 *  "matched" and "adopted" can never double-count the same stroke. */
function matchDiagonals(
  skeleton: { hips: readonly LayoutSeg[]; valleys: readonly LayoutSeg[] },
  planDiags: readonly PlanDiag[],
  outline: readonly OverlayPt[],
): { matchedPlanIdx: Set<number>; matchedSkel: number; skeletonDiagonals: number } {
  const span = outlineSpan(outline);
  const tol = Math.max(10, span * 0.02);
  const skelDiags = [...skeleton.hips, ...skeleton.valleys]
    .map((s) => ({ seg: s, ...segAngle(s) }))
    .filter((s) => s.slope !== 0);
  const near = (a: PlanDiag, b: (typeof skelDiags)[number]) =>
    a.slope === b.slope &&
    Math.abs(a.angleDeg - b.angleDeg) <= 12 &&
    (distToSeg(a.mid, b.seg.p1, b.seg.p2) <= tol ||
      distToSeg(
        { x: (b.seg.p1.x + b.seg.p2.x) / 2, y: (b.seg.p1.y + b.seg.p2.y) / 2 },
        a.p1,
        a.p2,
      ) <= tol);
  const matchedPlanIdx = new Set<number>();
  planDiags.forEach((d, i) => {
    if (skelDiags.some((s) => near(d, s))) matchedPlanIdx.add(i);
  });
  const matchedSkel = skelDiags.filter((s) => planDiags.some((d) => near(d, s))).length;
  return { matchedPlanIdx, matchedSkel, skeletonDiagonals: skelDiags.length };
}

/** Score the computed skeleton's diagonals against the sheet's own. */
export function crossCheckDiagonals(
  skeleton: { hips: LayoutSeg[]; valleys: LayoutSeg[] },
  planDiags: readonly PlanDiag[],
  outline: readonly OverlayPt[],
): Omit<RoofLayoutDiag, "adopted"> {
  const m = matchDiagonals(skeleton, planDiags, outline);
  return {
    planDiagonals: planDiags.length,
    matchedPlan: m.matchedPlanIdx.size,
    skeletonDiagonals: m.skeletonDiagonals,
    matchedSkel: m.matchedSkel,
  };
}

/**
 * Compute the roof layout for a classified perimeter.
 *
 * `classes` follow the classifier: eave edges shrink at slope speed, rake
 * edges are stationary gable walls. UNKNOWN edges are drawn as eaves (the
 * common case, and drawing is decorative — pricing keeps them UNPRICED
 * separately), noted so the reviewer knows what the diagram assumed.
 */
export function buildRoofLayout(opts: {
  outline: readonly OverlayPt[];
  edges: readonly OutlineEdge[];
  classes: readonly EdgeClass[];
  /** roof-sheet vector segments ([x1,y1,x2,y2][]) for the diagonal evidence */
  segments?: readonly number[][] | null;
  /** Elevation gables the reconcile REJECTED from pricing (frame-over /
   *  beam / forced-flush) — the wall keeps its class, but the roof form is
   *  real, so it still DRAWS as a gable end tagged verify. Spans are in
   *  feet; `ptPerFt` converts them to sheet units. */
  frameOverEnds?:
    | readonly { edgeId: string; spanFt?: number | null; u?: number | null }[]
    | null;
  ptPerFt?: number | null;
}): RoofLayout {
  try {
    const { outline, edges, classes } = opts;
    if (!Array.isArray(outline) || outline.length < 4) {
      return fail("outline too small");
    }
    const clsById = new Map(classes.map((c) => [c.id, c.edge_class]));
    const realEdges = edges.filter((e) => e.lenPt >= 1e-6);
    const rakeIdsWanted = realEdges
      .filter((e) => (clsById.get(e.id) ?? "unknown") === "rake")
      .map((e) => e.id);
    const unknowns = realEdges.filter(
      (e) => (clsById.get(e.id) ?? "unknown") === "unknown",
    ).length;
    if (rakeIdsWanted.length === realEdges.length) {
      return fail("every edge classified rake — no eave to slope from");
    }

    const planDiags = opts.segments?.length
      ? extractPlanDiagonals(opts.segments, outline)
      : [];

    const runSkel = (
      rakeIds: readonly string[],
    ): { skel: RoofSkeleton; valid: boolean } => {
      const eaveSegments: SkelSeg[] = [];
      const rakeSegments: SkelSeg[] = [];
      for (const e of realEdges) {
        const seg: SkelSeg = [
          { x: e.p1.x, y: e.p1.y },
          { x: e.p2.x, y: e.p2.y },
        ];
        if (rakeIds.includes(e.id)) rakeSegments.push(seg);
        else eaveSegments.push(seg);
      }
      const skel = deriveRoofSkeletonStraight(outline, {
        eaveSegments,
        rakeSegments,
      });
      return { skel, valid: skel.faces.length > 0 && validateSkeleton(skel, outline) };
    };

    // Robustness ladder: full rake set → drop ONE gable wall (the weighted
    // wavefront has degenerate configurations; a sparser-but-correct diagram
    // beats none) → all-eave. Candidates scored by plan-diagonal agreement.
    let used: { skel: RoofSkeleton; rakeIds: readonly string[] } | null = null;
    let droppedRake: string | null = null;
    const full = runSkel(rakeIdsWanted);
    if (full.valid) {
      used = { skel: full.skel, rakeIds: rakeIdsWanted };
    } else if (rakeIdsWanted.length > 0) {
      let best: { skel: RoofSkeleton; rakeIds: string[]; score: number } | null = null;
      for (const dropId of rakeIdsWanted) {
        const subset = rakeIdsWanted.filter((id) => id !== dropId);
        const t = runSkel(subset);
        if (!t.valid) continue;
        const stats = crossCheckDiagonals(
          { hips: t.skel.hips.map(toSeg), valleys: t.skel.valleys.map(toSeg) },
          planDiags,
          outline,
        );
        const score = stats.matchedPlan * 2 + stats.matchedSkel;
        if (!best || score > best.score) best = { skel: t.skel, rakeIds: subset, score };
      }
      if (best) {
        used = { skel: best.skel, rakeIds: best.rakeIds };
        droppedRake = rakeIdsWanted.find((id) => !best!.rakeIds.includes(id)) ?? null;
      } else {
        const allEave = runSkel([]);
        if (allEave.valid) {
          used = { skel: allEave.skel, rakeIds: [] };
          droppedRake = "all";
        }
      }
    }

    const notes: string[] = [];
    let ridges: LayoutSeg[] = [];
    let hips: LayoutSeg[] = [];
    let valleys: LayoutSeg[] = [];
    if (used) {
      ridges = used.skel.ridges.map(toSeg);
      hips = used.skel.hips.map(toSeg);
      valleys = used.skel.valleys.map(toSeg);
    } else if (planDiags.length === 0) {
      return fail("straight skeleton unavailable (non-rectilinear or degenerate outline)");
    }
    if (used && droppedRake === "all") {
      notes.push(
        "📐 Gable walls degenerated the skeleton — drawn all-hip; rake edges still marked on the perimeter.",
      );
    } else if (used && droppedRake) {
      notes.push(
        `📐 Gable wall ${droppedRake} drawn as eave in the diagram (skeleton degeneracy) — its rake classification is unchanged.`,
      );
    }

    // Evidence pass. Score the skeleton against the sheet's diagonals FIRST —
    // then let the sheet outrank the derivation:
    //   - A uniform single-pitch skeleton is only right for a uniform roof.
    //     When the sheet draws several diagonals and the skeleton reproduces
    //     NONE of them (multi-pitch / split-level roof — "SLOPE CHANGE" plans),
    //     the skeleton is wrong-in-kind: discard it wholesale.
    //   - ADOPT the sheet's own diagonals as valleys either way. Never
    //     invented: every adopted stroke is the sheet's own vector.
    const span = outlineSpan(outline);
    let diag: RoofLayoutDiag | undefined;
    let skeletonKept = !!used;
    if (opts.segments?.length) {
      const pre = matchDiagonals({ hips, valleys }, planDiags, outline);
      // Discard only when the skeleton DREW diagonals and the sheet confirms
      // none of them. A pure-gable skeleton (ridge only, zero diagonals) has
      // nothing to falsify — a few stray 45° strokes must not destroy it.
      if (
        used &&
        planDiags.length >= 3 &&
        pre.skeletonDiagonals > 0 &&
        pre.matchedSkel === 0
      ) {
        skeletonKept = false;
        ridges = [];
        hips = [];
        valleys = [];
        // The fallback-skeleton notes above ("drawn all-hip" / "drawn as
        // eave") describe lines just deleted — retract them so the notes
        // describe what IS drawn, not the discarded fallback.
        const staleIdx = notes.findIndex(
          (n) => n.includes("drawn all-hip") || n.includes("drawn as eave in the diagram"),
        );
        if (staleIdx >= 0) notes.splice(staleIdx, 1);
        notes.push(
          "📐 The sheet's drawn diagonals contradict the uniform skeleton (multi-pitch roof) — " +
            "interior drawn from the sheet's own linework + gable ridge rules instead" +
            (staleIdx >= 0
              ? " (the degenerate fallback skeleton was discarded; rake edges stay marked on the perimeter)."
              : "."),
        );
      }
      // Adopt with the SAME predicate that counted matches, against the lines
      // actually kept — a stroke is matched or adopted, never both.
      const post = skeletonKept
        ? pre
        : matchDiagonals({ hips, valleys }, planDiags, outline);
      // Generous ceiling — a 20-gable plan legitimately draws dozens of
      // valleys; the cap only guards against a degenerate diagonal storm,
      // and dropping anything is said out loud, never silent.
      const unmatched = planDiags.filter((_, i) => !post.matchedPlanIdx.has(i));
      const adoptees = unmatched.slice(0, 32);
      if (unmatched.length > adoptees.length) {
        notes.push(
          `📐 ${unmatched.length - adoptees.length} drawn diagonal(s) beyond the 32-line adoption ceiling were left off the diagram — review the sheet.`,
        );
      }
      for (const d of adoptees) {
        valleys.push({ p1: d.p1, p2: d.p2 });
      }
      diag = {
        planDiagonals: planDiags.length,
        matchedPlan: post.matchedPlanIdx.size,
        // Report the ORIGINAL skeleton's evidence score — it justifies the
        // discard decision in the note even after the lines are gone.
        skeletonDiagonals: pre.skeletonDiagonals,
        matchedSkel: pre.matchedSkel,
        adopted: adoptees.length,
      };
    } else if (!used) {
      return fail("straight skeleton unavailable (non-rectilinear or degenerate outline)");
    }

    // Gable ENDS — edge-anchored triangles the canvas draws as wings, carried
    // on BOTH paths so the drawn gables never vanish with the skeleton.
    // Decorative only; the rake classification (and pricing) is untouched.
    const gableEnds: GableEnd[] = [];
    const nearestRakeEdgeId = (mid: OverlayPt): string => {
      let bestId = "";
      let bestD = Infinity;
      for (const id of rakeIdsWanted) {
        const e = realEdges.find((r) => r.id === id);
        if (!e) continue;
        const d = Math.hypot(e.mid.x - mid.x, e.mid.y - mid.y);
        if (d < bestD) {
          bestD = d;
          bestId = id;
        }
      }
      return bestId;
    };

    // Sheet-anchored ridge synthesis — only when the skeleton was discarded
    // (or never stood) and the sheet gave us valleys to anchor against.
    if (!skeletonKept && valleys.length > 0) {
      // (a) Valley endpoints that align on an axis line across ≥2 different
      //     valleys mark the main ridge the planes meet at — connect them.
      //     Computed FIRST so gable ridges can terminate on them.
      const mains = mainRidgesFromValleys(valleys, outline, span);
      ridges.push(...mains);
      // (b) Each gable wall's ridge runs from the wall midpoint straight
      //     inward until it dies into the first sheet valley or main ridge
      //     (the plan says where its planes meet the next mass), else until
      //     it would leave the footprint. Stopping at (a)'s ridges keeps the
      //     drawn diagram crossing-free by construction.
      const stopAt = [...valleys, ...mains];
      for (const id of rakeIdsWanted) {
        const e = realEdges.find((r) => r.id === id);
        if (!e) continue;
        const rb = ridgeBack(e, outline, stopAt, span);
        if (!rb) continue;
        ridges.push(rb);
        // Gable-end triangle on the ridge-back: apex at half the rake span
        // along it (a ~45° gable in plan), never past the ridge-back's end.
        const rbLen = Math.hypot(rb.p2.x - rb.p1.x, rb.p2.y - rb.p1.y);
        const t = rbLen > 1e-9 ? Math.min(e.lenPt / 2, rbLen) / rbLen : 0;
        gableEnds.push({
          edgeId: id,
          base: [
            { x: e.p1.x, y: e.p1.y },
            { x: e.p2.x, y: e.p2.y },
          ],
          apex: {
            x: rb.p1.x + (rb.p2.x - rb.p1.x) * t,
            y: rb.p1.y + (rb.p2.y - rb.p1.y) * t,
          },
        });
      }
    }

    // Kept-skeleton path: the skeleton's own gable walls, apex = the ridge
    // endpoint that lands on the wall (the ridge runs flush to a gable end).
    if (skeletonKept && used) {
      for (const g of used.skel.gables) {
        const a = g.points[0];
        const b = g.points[1];
        if (!a || !b) continue;
        const base: [OverlayPt, OverlayPt] = [
          { x: a.x, y: a.y },
          { x: b.x, y: b.y },
        ];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        let apex: OverlayPt = mid;
        let bestD = Math.max(6, span * 0.015);
        for (const r of ridges) {
          for (const p of [r.p1, r.p2]) {
            const d = distToSeg(p, base[0], base[1]);
            if (d < bestD) {
              bestD = d;
              apex = { x: p.x, y: p.y };
            }
          }
        }
        gableEnds.push({ edgeId: nearestRakeEdgeId(mid), base, apex });
      }
      // A rake the robustness ladder DROPPED (skeleton degeneracy) has no
      // skeleton gable — synthesize its end on the ridge-back exactly like
      // the discarded-skeleton path, so the drawn gable never vanishes with
      // a wavefront hiccup. Decorative; classification/pricing untouched.
      for (const id of rakeIdsWanted) {
        if (gableEnds.some((g) => g.edgeId === id)) continue;
        const e = realEdges.find((r) => r.id === id);
        if (!e) continue;
        const rb = ridgeBack(e, outline, [...valleys, ...ridges, ...hips], span);
        if (!rb) continue;
        ridges.push(rb);
        const rbLen = Math.hypot(rb.p2.x - rb.p1.x, rb.p2.y - rb.p1.y);
        const t = rbLen > 1e-9 ? Math.min(e.lenPt / 2, rbLen) / rbLen : 0;
        gableEnds.push({
          edgeId: id,
          base: [
            { x: e.p1.x, y: e.p1.y },
            { x: e.p2.x, y: e.p2.y },
          ],
          apex: {
            x: rb.p1.x + (rb.p2.x - rb.p1.x) * t,
            y: rb.p1.y + (rb.p2.y - rb.p1.y) * t,
          },
        });
        // The "drawn as eave" note is now wrong for this wall — it gets a
        // drawn gable end after all. Say what actually happens.
        if (droppedRake === id) {
          const staleIdx = notes.findIndex((n) =>
            n.includes(`Gable wall ${id} drawn as eave`),
          );
          if (staleIdx >= 0) {
            notes.splice(
              staleIdx,
              1,
              `📐 Gable wall ${id} degenerated the skeleton wing — its gable end is drawn from the ridge line instead; its rake classification is unchanged.`,
            );
          }
        }
      }
    }

    // Organize the adopted sheet strokes into the frame — run AFTER ridge
    // synthesis so ridges exist to anchor against. Adoptees are always the
    // LAST diag.adopted entries of `valleys` (nothing appends between).
    if (diag && diag.adopted > 0 && valleys.length >= diag.adopted) {
      const keep = valleys.length - diag.adopted;
      const org = organizeInterior({
        adopted: valleys.slice(keep),
        frame: [...valleys.slice(0, keep), ...ridges, ...hips],
        outline,
        span,
      });
      valleys = [...valleys.slice(0, keep), ...org.kept];
      if (org.connected > 0 || org.dropped > 0) {
        notes.push(
          `📐 Interior tidy: ${org.connected} sheet diagonal(s) connected into the ridge/eave frame` +
            (org.dropped > 0
              ? `; ${org.dropped} floating stray stroke(s) dropped`
              : "") +
            `.`,
        );
      }
      diag = { ...diag, adopted: org.kept.length };
    }

    // Frame-over / beam gables the reconcile rejected from pricing — the
    // wall keeps its eave (and gutter), but the roof form above it is real:
    // draw it as a gable end tagged verify. Sub-span of the wall, centered
    // at the elevation's u, apex clipped inside the outline.
    for (const fo of opts.frameOverEnds ?? []) {
      if (!fo?.edgeId || gableEnds.some((g) => g.edgeId === fo.edgeId)) continue;
      const e = realEdges.find((r) => r.id === fo.edgeId);
      if (!e || e.lenPt < 1e-6) continue;
      const u = Math.min(1, Math.max(0, typeof fo.u === "number" ? fo.u : 0.5));
      const spanPt =
        typeof fo.spanFt === "number" && fo.spanFt > 0 && opts.ptPerFt && opts.ptPerFt > 0
          ? Math.min(fo.spanFt * opts.ptPerFt, e.lenPt)
          : e.lenPt;
      const half = spanPt / 2;
      const c = Math.min(e.lenPt - half, Math.max(half, u * e.lenPt));
      const dx = (e.p2.x - e.p1.x) / e.lenPt;
      const dy = (e.p2.y - e.p1.y) / e.lenPt;
      const base: [OverlayPt, OverlayPt] = [
        { x: e.p1.x + dx * (c - half), y: e.p1.y + dy * (c - half) },
        { x: e.p1.x + dx * (c + half), y: e.p1.y + dy * (c + half) },
      ];
      const n = inwardNormalOf(e, outline, span);
      if (!n) continue;
      const mid = { x: (base[0].x + base[1].x) / 2, y: (base[0].y + base[1].y) / 2 };
      const o = { x: mid.x + n.x * 0.5, y: mid.y + n.y * 0.5 };
      let depth = spanPt / 2;
      for (let i = 0; i < outline.length; i++) {
        const t = raySegT(o, n, outline[i], outline[(i + 1) % outline.length]);
        if (t !== null && t < depth) depth = t;
      }
      if (depth < span * 0.01) continue;
      gableEnds.push({
        edgeId: e.id,
        base,
        apex: { x: mid.x + n.x * depth, y: mid.y + n.y * depth },
        verify: true,
      });
    }

    // Roof PLANES: the skeleton's validated tiling when it stood, else a
    // planar polygonization of the final kept lines. Undefined when neither
    // validates — the estimate bridge shades a single flat face instead.
    let faces: RoofFacePoly[] | undefined;
    if (skeletonKept && used && used.skel.faces.length > 0) {
      faces = used.skel.faces.map((f) => ({
        polygon: f.polygon.map((p) => ({ x: p.x, y: p.y })),
        downhill: { x: f.downhill.x, y: f.downhill.y },
      }));
    } else {
      faces =
        facesFromRoofLines(outline, [...ridges, ...hips, ...valleys]) ?? undefined;
    }

    const rakeEdgeIds = [...rakeIdsWanted];
    const layout: RoofLayout = {
      ok: true,
      ridges,
      hips,
      valleys,
      rakeEdgeIds,
      gableCount: rakeEdgeIds.length,
      gableEnds,
      ...(faces ? { faces } : {}),
      diag,
      confidence: 0.75,
      notes,
    };

    if (diag) {
      if (!skeletonKept) {
        // Sheet-anchored but rule-ridged: honest and drawn from the plan's
        // own strokes, yet young — keep the "Schematic — verify" banner on.
        layout.confidence = 0.65;
      } else if (diag.planDiagonals === 0) {
        // The sheet draws no interior diagonals — nothing to falsify against
        // (an all-gable roof legitimately has none). Neutral confidence.
        layout.confidence = 0.7;
      } else {
        // Adoption is automatic, so it is NOT agreement — only genuinely
        // reproduced strokes raise confidence. Bounded at 0.95 by design.
        const r1 = diag.matchedPlan / diag.planDiagonals;
        const r2 =
          diag.skeletonDiagonals > 0 ? diag.matchedSkel / diag.skeletonDiagonals : 1;
        layout.confidence = Math.min(
          0.95,
          Math.round((0.5 + 0.45 * (0.75 * r1 + 0.25 * r2)) * 100) / 100,
        );
      }
    }

    layout.notes.push(
      `📐 Roof layout (computed, not traced): ${layout.ridges.length} ridge(s), ` +
        `${layout.hips.length} hip(s), ${layout.valleys.length} valley(s) from the ` +
        `${outline.length}-corner outline with ${rakeEdgeIds.length} gable end(s)` +
        (unknowns > 0 ? ` (${unknowns} unknown edge(s) drawn as eaves)` : "") +
        (diag
          ? `; sheet check: ${diag.matchedPlan}/${diag.planDiagonals} drawn diagonals ` +
            `reproduced, ${diag.adopted} adopted from the sheet, ` +
            `${diag.matchedSkel}/${diag.skeletonDiagonals} of ours evidenced.`
          : "."),
    );
    return layout;
  } catch (e) {
    return fail(e instanceof Error ? e.message : "layout error");
  }
}
