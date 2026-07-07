/**
 * Copy the building OUTLINE from the PDF's vector layer — instead of asking
 * the AI to re-draw it (which flattens every plan to a box). Given the real
 * drawn wall segments off the foundation/floor plan, recover the building's
 * outer perimeter as a clean rectilinear polygon that feeds the roof engine.
 *
 * Method (robust to the noise on a real plan — interior walls, dimension
 * lines, door gaps — and needs no OpenCV): rasterize the segments to a grid,
 * close small gaps (dilate), flood-fill the exterior, take the largest
 * enclosed region (the building), then walk its boundary cells into a
 * directed-edge loop and collapse collinear runs into corners. Returns the
 * polygon in the SAME coordinate space as the input segments, or null when
 * the segments don't enclose a believable building (caller falls back).
 *
 * Pure (no DOM / server-only / React) so it runs in the browser bundle AND
 * under `node` for tests.
 */

export type Pt = { x: number; y: number };

const GRID = 200; // cells on the long axis — fine enough for jogs, cheap.

type Grid = { w: number; h: number; cells: Uint8Array };
const at = (g: Grid, x: number, y: number) =>
  x < 0 || y < 0 || x >= g.w || y >= g.h ? 0 : g.cells[y * g.w + x];
const set = (g: Grid, x: number, y: number, v: number) => {
  if (x >= 0 && y >= 0 && x < g.w && y < g.h) g.cells[y * g.w + x] = v;
};

/** Rasterize one segment into the grid (Bresenham), thickened by `t` cells. */
function drawSeg(g: Grid, x0: number, y0: number, x1: number, y1: number, t: number) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < g.w * g.h * 4; guard++) {
    for (let oy = -t; oy <= t; oy++)
      for (let ox = -t; ox <= t; ox++) set(g, x + ox, y + oy, 1);
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Flood the exterior (border-connected empty cells) → mark value 2. */
function floodExterior(g: Grid) {
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < g.w && y < g.h && g.cells[y * g.w + x] === 0) {
      g.cells[y * g.w + x] = 2;
      stack.push(x, y);
    }
  };
  for (let x = 0; x < g.w; x++) {
    push(x, 0);
    push(x, g.h - 1);
  }
  for (let y = 0; y < g.h; y++) {
    push(0, y);
    push(g.w - 1, y);
  }
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
}

/** Largest 4-connected component of "inside" cells (not exterior, value≠2). */
function largestInside(g: Grid): Uint8Array {
  const comp = new Uint8Array(g.w * g.h);
  const seen = new Uint8Array(g.w * g.h);
  let best: number[] = [];
  for (let i = 0; i < g.cells.length; i++) {
    if (g.cells[i] === 2 || seen[i]) continue;
    const cur: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      cur.push(idx);
      const x = idx % g.w;
      const y = (idx / g.w) | 0;
      const nb = [
        x + 1 < g.w ? idx + 1 : -1,
        x - 1 >= 0 ? idx - 1 : -1,
        y + 1 < g.h ? idx + g.w : -1,
        y - 1 >= 0 ? idx - g.w : -1,
      ];
      for (const n of nb)
        if (n >= 0 && !seen[n] && g.cells[n] !== 2) {
          seen[n] = 1;
          stack.push(n);
        }
    }
    if (cur.length > best.length) best = cur;
  }
  for (const idx of best) comp[idx] = 1;
  return comp;
}

/** Erode the inside mask by `iters` cells — undoes the wall-thickening so the
 *  traced outline sits on the wall centerline instead of its outer edge. */
function erode(g: Grid, inside: Uint8Array, iters: number): Uint8Array {
  let cur = inside;
  for (let it = 0; it < iters; it++) {
    const nextMask = new Uint8Array(cur.length);
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        const i = y * g.w + x;
        if (!cur[i]) continue;
        const edge =
          (x + 1 < g.w ? !cur[i + 1] : true) ||
          (x - 1 >= 0 ? !cur[i - 1] : true) ||
          (y + 1 < g.h ? !cur[i + g.w] : true) ||
          (y - 1 >= 0 ? !cur[i - g.w] : true);
        if (!edge) nextMask[i] = 1;
      }
    }
    cur = nextMask;
  }
  return cur;
}

const key = (x: number, y: number) => `${x},${y}`;

/** Walk the boundary of the inside mask into a closed rectilinear loop of
 *  grid-corner points (the outer perimeter), collinear runs collapsed. */
function traceOutline(g: Grid, inside: Uint8Array): Pt[] | null {
  const isIn = (x: number, y: number) =>
    x < 0 || y < 0 || x >= g.w || y >= g.h ? 0 : inside[y * g.w + x];
  // Directed boundary edges, walking each inside cell clockwise (y-down) so
  // the OUTER boundary forms one CW loop; inside is on the right of each edge.
  const next = new Map<string, Pt>();
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (!isIn(x, y)) continue;
      if (!isIn(x, y - 1)) next.set(key(x, y), { x: x + 1, y }); // top  →
      if (!isIn(x + 1, y)) next.set(key(x + 1, y), { x: x + 1, y: y + 1 }); // right ↓
      if (!isIn(x, y + 1)) next.set(key(x + 1, y + 1), { x, y: y + 1 }); // bot  ←
      if (!isIn(x - 1, y)) next.set(key(x, y + 1), { x, y }); // left ↑
    }
  }
  if (next.size === 0) return null;
  // Pick a guaranteed-outer starting corner: topmost-leftmost edge start.
  let start: Pt | null = null;
  for (const k of next.keys()) {
    const [sx, sy] = k.split(",").map(Number);
    if (!start || sy < start.y || (sy === start.y && sx < start.x))
      start = { x: sx, y: sy };
  }
  if (!start) return null;
  const loop: Pt[] = [];
  let cur: Pt | undefined = start;
  for (let guard = 0; guard < next.size + 4; guard++) {
    if (!cur) break;
    loop.push(cur);
    const nx = next.get(key(cur.x, cur.y));
    if (!nx) break;
    if (nx.x === start.x && nx.y === start.y) break;
    cur = nx;
  }
  if (loop.length < 4) return null;
  // Collapse collinear runs → corners only.
  const corners: Pt[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i - 1 + loop.length) % loop.length];
    const b = loop[i];
    const c = loop[(i + 1) % loop.length];
    const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const straight =
      (b.x - a.x) * (c.y - b.y) === (b.y - a.y) * (c.x - b.x) &&
      turn === 0;
    if (!straight) corners.push(b);
  }
  return corners.length >= 4 ? corners : loop;
}

/** Cluster near-equal coordinates to a shared representative (their mean) so a
 *  grid-traced outline's single-cell stair-steps and door-gap dimples snap to
 *  clean axis lines. Sorted-sweep grouping within `tol`. */
function clusterReps(vals: number[], tol: number): number[] {
  const sorted = [...vals].sort((a, b) => a - b);
  const reps: number[] = [];
  let group: number[] = [];
  for (const v of sorted) {
    if (group.length === 0 || v - group[group.length - 1] <= tol) group.push(v);
    else {
      reps.push(group.reduce((s, x) => s + x, 0) / group.length);
      group = [v];
    }
  }
  if (group.length) reps.push(group.reduce((s, x) => s + x, 0) / group.length);
  return reps;
}
const nearestRep = (reps: number[], v: number): number =>
  reps.reduce((best, r) => (Math.abs(r - v) < Math.abs(best - v) ? r : best), reps[0]);

/**
 * Clean a grid-traced rectilinear outline: snap x/y to clustered axis lines
 * (kills sub-`tol` stair-steps and door-gap dimples that would otherwise inflate
 * a real ~6-corner footprint to 30-40 staircase corners), drop consecutive
 * duplicates, then collapse collinear runs. Real jogs (edges ≫ tol) survive
 * because their coordinates cluster far apart.
 */
function snapAndClean(poly: Pt[], tol: number): Pt[] {
  if (poly.length < 4) return poly;
  const xs = clusterReps(poly.map((p) => p.x), tol);
  const ys = clusterReps(poly.map((p) => p.y), tol);
  let pts = poly.map((p) => ({ x: nearestRep(xs, p.x), y: nearestRep(ys, p.y) }));
  // Drop consecutive duplicates (a snapped-away step collapses to a point).
  pts = pts.filter((p, i) => {
    const q = pts[(i - 1 + pts.length) % pts.length];
    return Math.abs(p.x - q.x) > 1e-6 || Math.abs(p.y - q.y) > 1e-6;
  });
  // Collapse collinear runs → corners only.
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const b = pts[i];
    const c = pts[(i + 1) % pts.length];
    const collinear = (b.x - a.x) * (c.y - b.y) === (b.y - a.y) * (c.x - b.x);
    if (!collinear) out.push(b);
  }
  return out.length >= 4 ? out : pts;
}

function bboxOf(segments: number[][]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of segments) {
    if (s.length < 4) continue;
    for (const [px, py] of [
      [s[0], s[1]],
      [s[2], s[3]],
    ]) {
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

type RunLike = {
  start: Pt;
  end: Pt;
  tier?: string;
  feature?: string;
  side?: string;
};

const bboxPts = (pts: Pt[]) => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
const normMid = (a: Pt, b: Pt, bb: { x0: number; y0: number; x1: number; y1: number }) => ({
  x: ((a.x + b.x) / 2 - bb.x0) / Math.max(1e-6, bb.x1 - bb.x0),
  y: ((a.y + b.y) / 2 - bb.y0) / Math.max(1e-6, bb.y1 - bb.y0),
});

/**
 * Turn the recovered outline's edges into eave runs, inheriting tier / feature
 * / side from the nearest AI gutter run (matched in normalized bbox space) so
 * the porch/patio/garage labels + tiers the AI read survive even though the
 * GEOMETRY now comes from the copied outline, not the AI. Each edge is an
 * eave by default; the contractor trims gable faces on the canvas.
 */
export function outlineEdgesToRuns(
  polygon: Pt[],
  aiRuns: RunLike[],
): RunLike[] {
  const n = polygon.length;
  if (n < 3) return [];
  const polyBB = bboxPts(polygon);
  const aiMids =
    aiRuns.length > 0
      ? (() => {
          const aiPts = aiRuns.flatMap((r) => [r.start, r.end]);
          const aiBB = bboxPts(aiPts);
          return aiRuns.map((r) => ({ run: r, m: normMid(r.start, r.end, aiBB) }));
        })()
      : [];
  const out: RunLike[] = [];
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    let tier: string | undefined;
    let feature: string | undefined;
    let side: string | undefined;
    if (aiMids.length) {
      const m = normMid(a, b, polyBB);
      let best = aiMids[0];
      let bestD = Infinity;
      for (const cand of aiMids) {
        const d = Math.hypot(cand.m.x - m.x, cand.m.y - m.y);
        if (d < bestD) {
          bestD = d;
          best = cand;
        }
      }
      tier = best.run.tier;
      feature = best.run.feature;
      side = best.run.side;
    }
    out.push({ start: a, end: b, tier, feature, side });
  }
  return out;
}

/**
 * Recover the building outline polygon from drawn wall segments. Returns the
 * polygon in the input's coordinate space + the bbox used, or null.
 */
export function extractBuildingOutline(
  segments: number[][],
  opts?: { grid?: number; gapCells?: number },
): { polygon: Pt[]; bbox: { x0: number; y0: number; x1: number; y1: number } } | null {
  try {
    if (!segments || segments.length < 4) return null;
    const bbox = bboxOf(segments);
    if (!bbox) return null;
    const wWorld = bbox.x1 - bbox.x0;
    const hWorld = bbox.y1 - bbox.y0;
    if (wWorld <= 0 || hWorld <= 0) return null;

    const G = opts?.grid ?? GRID;
    const cell = Math.max(wWorld, hWorld) / G;
    const gw = Math.max(4, Math.ceil(wWorld / cell) + 4);
    const gh = Math.max(4, Math.ceil(hWorld / cell) + 4);
    const grid: Grid = { w: gw, h: gh, cells: new Uint8Array(gw * gh) };
    const toGx = (x: number) => (x - bbox.x0) / cell + 2;
    const toGy = (y: number) => (y - bbox.y0) / cell + 2;

    // Thicken walls by a couple of cells to bridge door gaps / hairline breaks.
    const thick = Math.max(1, opts?.gapCells ?? Math.round(G / 90));
    for (const s of segments) {
      if (s.length < 4) continue;
      drawSeg(grid, toGx(s[0]), toGy(s[1]), toGx(s[2]), toGy(s[3]), thick);
    }

    floodExterior(grid);
    const insideRaw = largestInside(grid);
    const insideCount = insideRaw.reduce((a, b) => a + b, 0);
    // Reject if the "building" is a sliver (segments didn't enclose anything).
    if (insideCount < gw * gh * 0.05) return null;
    // Erode away the wall thickening so the outline tracks the real walls.
    const inside = erode(grid, insideRaw, thick);

    const gridPoly = traceOutline(grid, inside);
    if (!gridPoly || gridPoly.length < 4) return null;

    // Grid corners → world space (undo the +2 pad and cell scale).
    const raw = gridPoly.map((p) => ({
      x: bbox.x0 + (p.x - 2) * cell,
      y: bbox.y0 + (p.y - 2) * cell,
    }));
    // Snap out sub-cell stair-steps + door-gap dimples so a real footprint reads
    // as a clean ~6-corner polygon, not a 30-40 corner staircase (which feeds
    // noisy geometry and can false-trip the roof's ≤40-corner gate). Real jogs
    // survive — their coordinates cluster far apart. tol ≈ 2.5 cells.
    const polygon = snapAndClean(raw, cell * 2.5);
    return { polygon, bbox };
  } catch {
    return null;
  }
}
