/**
 * roof-faces-from-lines.ts — polygonize a roof-line drawing into roof PLANES.
 *
 * The v2 layout can end up as pure line work (sheet-adopted valleys + rule
 * ridges) when the straight skeleton degenerates or the sheet's own diagonals
 * contradict it. Lines draw fine, but the canvas shades roof PLANES — and
 * without a face set the middle of the footprint renders empty (the
 * Woodinville "top band + bottom band, nothing in between" look). This module
 * rebuilds the planes from the lines themselves:
 *
 *   1. planar arrangement — outline edges + interior segments, split at every
 *      pairwise crossing / T-junction;
 *   2. half-edge graph over the split pieces (dangling stubs pruned);
 *   3. leftmost-turn face walk enumerates the minimal faces;
 *   4. keep faces whose centroid lies inside the outline; downhill = toward
 *      the nearest perimeter edge (that edge is the face's eave).
 *
 * The kept faces must TILE the outline (Σ areas within 5%) or the whole
 * result is rejected (null) — partial shading is worse than the flat
 * fallback the callers draw instead.
 *
 * Decorative only: pricing never reads faces. Pure module — node --test.
 */

import type { OverlayPt } from "./plan-overlay";
import { pointInPolygon } from "./plan-orientation";

/** A roof plane: its polygon + the unit direction it slopes DOWN toward. */
export type RoofFacePoly = { polygon: OverlayPt[]; downhill: OverlayPt };

type Seg = { p1: OverlayPt; p2: OverlayPt };

function polySignedArea(poly: readonly OverlayPt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Area-weighted centroid; falls back to the vertex mean when degenerate. */
function polyCentroid(poly: readonly OverlayPt[]): OverlayPt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) > 1e-9) return { x: cx / (3 * a), y: cy / (3 * a) };
  let sx = 0;
  let sy = 0;
  for (const p of poly) {
    sx += p.x;
    sy += p.y;
  }
  const n = poly.length || 1;
  return { x: sx / n, y: sy / n };
}

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

const finitePt = (p: OverlayPt | undefined | null): p is OverlayPt =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * Polygonize `outline` + `interior` line segments into roof planes.
 * Returns null when the arrangement cannot be validated (degenerate outline,
 * broken graph, or the kept faces don't tile the footprint) — callers fall
 * back to a single flat face so shading always covers the footprint.
 */
export function facesFromRoofLines(
  outline: readonly OverlayPt[],
  interior: readonly Seg[],
): RoofFacePoly[] | null {
  try {
    const ring = (outline ?? []).filter(finitePt);
    if (ring.length < 3) return null;
    const footArea = Math.abs(polySignedArea(ring));
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const span = Math.max(maxX - minX, maxY - minY);
    if (!(footArea > 1e-9) || !(span > 0)) return null;
    // A near-zero-area ring (all points almost collinear) is a degenerate
    // input, not a roof — reject before the arrangement wastes time on it.
    if (footArea < span * span * 0.01) return null;
    const tol = Math.max(span * 5e-4, 1e-9);

    // ── 1. collect segments (perimeter first, then interior) ──────────
    const segs: (Seg & { len: number })[] = [];
    for (let i = 0; i < ring.length; i++) {
      const p1 = ring[i];
      const p2 = ring[(i + 1) % ring.length];
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (len > tol * 2) segs.push({ p1, p2, len });
    }
    for (const s of interior ?? []) {
      if (!s || !finitePt(s.p1) || !finitePt(s.p2)) continue;
      const len = Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y);
      if (len > tol * 2) segs.push({ p1: s.p1, p2: s.p2, len });
    }
    if (segs.length < 3) return null;

    // ── 2. split every segment at crossings + T-junctions ─────────────
    const cuts: number[][] = segs.map(() => [0, 1]);
    const paramOf = (s: (typeof segs)[number], p: OverlayPt): number => {
      const dx = s.p2.x - s.p1.x;
      const dy = s.p2.y - s.p1.y;
      return ((p.x - s.p1.x) * dx + (p.y - s.p1.y) * dy) / (s.len * s.len);
    };
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const A = segs[i];
        const B = segs[j];
        const rx = A.p2.x - A.p1.x;
        const ry = A.p2.y - A.p1.y;
        const sx = B.p2.x - B.p1.x;
        const sy = B.p2.y - B.p1.y;
        const denom = rx * sy - ry * sx;
        if (Math.abs(denom) > 1e-12) {
          const qx = B.p1.x - A.p1.x;
          const qy = B.p1.y - A.p1.y;
          const t = (qx * sy - qy * sx) / denom;
          const u = (qx * ry - qy * rx) / denom;
          const eT = tol / A.len;
          const eU = tol / B.len;
          if (t > -eT && t < 1 + eT && u > -eU && u < 1 + eU) {
            cuts[i].push(Math.max(0, Math.min(1, t)));
            cuts[j].push(Math.max(0, Math.min(1, u)));
          }
        }
        // T-junctions / near-collinear touches the crossing test misses:
        // an endpoint of one segment resting ON the other.
        for (const p of [B.p1, B.p2]) {
          const hit = nearestOnSeg(p, A.p1, A.p2);
          if (hit.d <= tol) cuts[i].push(Math.max(0, Math.min(1, paramOf(A, p))));
        }
        for (const p of [A.p1, A.p2]) {
          const hit = nearestOnSeg(p, B.p1, B.p2);
          if (hit.d <= tol) cuts[j].push(Math.max(0, Math.min(1, paramOf(B, p))));
        }
      }
    }

    // ── 3. nodes (snapped within tol) + undirected edges ───────────────
    const nodes: OverlayPt[] = [];
    const cells = new Map<string, number[]>();
    const cellKey = (cx: number, cy: number) => `${cx}:${cy}`;
    const nodeAt = (p: OverlayPt): number => {
      const cx = Math.round(p.x / tol);
      const cy = Math.round(p.y / tol);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const id of cells.get(cellKey(cx + dx, cy + dy)) ?? []) {
            const n = nodes[id];
            if (Math.hypot(n.x - p.x, n.y - p.y) <= tol) return id;
          }
        }
      }
      const id = nodes.length;
      nodes.push({ x: p.x, y: p.y });
      const key = cellKey(cx, cy);
      const arr = cells.get(key) ?? [];
      arr.push(id);
      cells.set(key, arr);
      return id;
    };
    const edgeSet = new Set<string>();
    const edges: { a: number; b: number }[] = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const ts = [...new Set(cuts[i])].sort((a, b) => a - b);
      let prev: number | null = null;
      let prevT = -Infinity;
      for (const t of ts) {
        if ((t - prevT) * s.len <= tol) continue;
        const id = nodeAt({
          x: s.p1.x + (s.p2.x - s.p1.x) * t,
          y: s.p1.y + (s.p2.y - s.p1.y) * t,
        });
        if (prev !== null && id !== prev) {
          const key = prev < id ? `${prev}:${id}` : `${id}:${prev}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ a: prev, b: id });
          }
        }
        prev = id;
        prevT = t;
      }
    }

    // ── 4. prune dangling stubs (degree-1 chains can't bound a face) ───
    const adj = new Map<number, Set<number>>();
    const link = (a: number, b: number) => {
      const s = adj.get(a) ?? new Set<number>();
      s.add(b);
      adj.set(a, s);
    };
    for (const e of edges) {
      link(e.a, e.b);
      link(e.b, e.a);
    }
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (const [id, nb] of adj) {
        if (nb.size === 1) {
          const [other] = nb;
          adj.get(other)?.delete(id);
          adj.delete(id);
          pruned = true;
        } else if (nb.size === 0) {
          adj.delete(id);
          pruned = true;
        }
      }
    }
    let dirCount = 0;
    for (const nb of adj.values()) dirCount += nb.size;
    if (dirCount < 6) return null; // fewer than 3 surviving edges

    // ── 5. leftmost-turn face walk over the half-edge graph ───────────
    const sorted = new Map<number, number[]>();
    for (const [id, nb] of adj) {
      sorted.set(
        id,
        [...nb].sort(
          (a, b) =>
            Math.atan2(nodes[a].y - nodes[id].y, nodes[a].x - nodes[id].x) -
            Math.atan2(nodes[b].y - nodes[id].y, nodes[b].x - nodes[id].x),
        ),
      );
    }
    const visited = new Set<string>();
    const rawFaces: { ids: number[]; area: number }[] = [];
    let steps = 0;
    const stepCap = dirCount * 4 + 64;
    for (const [start, nb] of adj) {
      for (const first of nb) {
        if (visited.has(`${start}>${first}`)) continue;
        const ids: number[] = [start];
        let u = start;
        let v = first;
        let closed = false;
        while (steps++ < stepCap) {
          visited.add(`${u}>${v}`);
          ids.push(v);
          const ring2 = sorted.get(v);
          if (!ring2 || ring2.length === 0) break;
          const idx = ring2.indexOf(u);
          if (idx < 0) break;
          const next = ring2[(idx - 1 + ring2.length) % ring2.length];
          u = v;
          v = next;
          if (u === start && v === first) {
            closed = true;
            break;
          }
        }
        if (!closed) return null; // broken arrangement — reject wholesale
        ids.pop(); // last id repeats the start
        if (ids.length < 3) continue;
        const poly = ids.map((id) => nodes[id]);
        const area = polySignedArea(poly);
        if (Math.abs(area) > footArea * 1e-6) rawFaces.push({ ids, area });
      }
    }
    if (rawFaces.length === 0) return null;

    // ── 6. drop the outer face, keep the bounded interior ─────────────
    // Sum of signed areas over ALL faces of a planar subdivision is 0: the
    // bounded faces share one sign, the single unbounded face carries the
    // other. Whichever sign group has exactly one member is the outer face.
    const pos = rawFaces.filter((f) => f.area > 0);
    const neg = rawFaces.filter((f) => f.area < 0);
    let bounded: typeof rawFaces;
    if (neg.length === 1 && pos.length >= 1) bounded = pos;
    else if (pos.length === 1 && neg.length >= 1) bounded = neg;
    else bounded = pos.length >= neg.length ? pos : neg;

    const kept: { polygon: OverlayPt[]; centroid: OverlayPt; area: number }[] = [];
    for (const f of bounded) {
      const polygon = f.ids.map((id) => ({ x: nodes[id].x, y: nodes[id].y }));
      const centroid = polyCentroid(polygon);
      if (!pointInPolygon(centroid, ring)) continue; // sliver outside the outline
      kept.push({ polygon, centroid, area: Math.abs(f.area) });
    }
    if (kept.length === 0) return null;

    // ── 7. validate the tiling — same 5% gate validateSkeleton uses ────
    const keptArea = kept.reduce((s, f) => s + f.area, 0);
    if (Math.abs(keptArea - footArea) / footArea > 0.05) return null;

    // ── 8. downhill: each plane drains toward its nearest perimeter edge
    return kept.map((f) => {
      let best: { q: OverlayPt; d: number } | null = null;
      for (let i = 0; i < ring.length; i++) {
        const hit = nearestOnSeg(f.centroid, ring[i], ring[(i + 1) % ring.length]);
        if (!best || hit.d < best.d) best = hit;
      }
      const dx = best ? best.q.x - f.centroid.x : 0;
      const dy = best ? best.q.y - f.centroid.y : 1;
      const m = Math.hypot(dx, dy);
      return {
        polygon: f.polygon,
        downhill: m > 1e-9 ? { x: dx / m, y: dy / m } : { x: 0, y: 1 },
      };
    });
  } catch {
    return null;
  }
}
