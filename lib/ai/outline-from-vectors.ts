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

/** Largest 4-connected component of an arbitrary mask. */
function largestMaskComponent(g: Grid, mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  const seen = new Uint8Array(mask.length);
  let best: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
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
        if (n >= 0 && mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
    }
    if (cur.length > best.length) best = cur;
  }
  for (const idx of best) out[idx] = 1;
  return out;
}

/** Dilate a mask by `iters` cells, constrained to cells set in `within`. */
function dilate(g: Grid, mask: Uint8Array, iters: number, within: Uint8Array): Uint8Array {
  let cur = mask;
  for (let it = 0; it < iters; it++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        const i = y * g.w + x;
        if (!within[i]) continue;
        if (
          cur[i] ||
          (x + 1 < g.w && cur[i + 1]) ||
          (x - 1 >= 0 && cur[i - 1]) ||
          (y + 1 < g.h && cur[i + g.w]) ||
          (y - 1 >= 0 && cur[i - g.w])
        )
          next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
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
 * because their coordinates cluster far apart. Exported for the perimeter
 * repair in roof-from-vectors.ts, which needs the same sliver cleanup after
 * snapping phantom edges onto the sheet's drawn linework.
 */
export function snapAndClean(poly: Pt[], tol: number): Pt[] {
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

/** Perimeter of a closed polygon. */
function polyPerimeter(poly: Pt[]): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

// Standard architectural drawing scales, in PDF points per foot (72 pt/inch):
// 1/8"=1' → 9, 3/16" → 13.5, 1/4" → 18, 3/8" → 27, 1/2" → 36, plus a couple of
// less-common residential scales. A derived pt/ft that lands within 12% of one
// of these is snapped to it, so small trace / dimension-read noise self-corrects
// to the real sheet scale.
const STD_PT_PER_FT = [4.5, 6.75, 9, 12, 13.5, 18, 24, 27, 36, 48];

/**
 * Recover the TRUE feet-per-point of a vector footprint outline by anchoring it
 * to the building's real overall dimension.
 *
 * Why this is needed: after the footprint is swapped to the plan's own vector
 * outline (PDF-point coordinates), the AI's stored `scale.feet_per_unit` — and
 * the AI gutter runs' own length_ft/length_px ratio — are calibrated on the
 * model's RASTER-pixel trace, a different (and, on a mis-traced plan, wildly
 * inconsistent) coordinate space. Pricing the point-space outline at that scale
 * inflates every LF. The one number the model reads reliably is the PRINTED
 * overall dimension (e.g. "64'-0 OVERALL"), which it echoes into scale.source;
 * dividing the outline's matching extent by it gives the real point scale.
 *
 * Fail-safe: returns null when no plausible overall dimension can be parsed or
 * the derived scale is physically implausible, so the caller keeps the existing
 * run-derived scale (today's behavior).
 */
export function deriveVectorScale(
  outline: Pt[],
  textOrSource: string | null | undefined,
): { ftPerPt: number; ptPerFt: number; source: string } | null {
  if (!outline || outline.length < 4) return null;
  const bb = bboxPts(outline);
  const w = bb.x1 - bb.x0;
  const h = bb.y1 - bb.y0;
  if (!(w > 0) || !(h > 0)) return null;
  const src = String(textOrSource ?? "");
  if (!src) return null;

  // Parse feet values from ANY of the AI's text (scale.source, notes, stated
  // dimensions) — model wording varies (Opus echoes "64'-0 OVERALL" in
  // scale.source; Gemini buries it elsewhere), so the caller passes a joined
  // blob. Accept `64'-0"`, `64'`, `64 ft`, `64-0`. Keep building-sized overalls
  // (15–200 ft); a perimeter figure (>200) is ignored — it's usually derived
  // from a mis-traced width and can't be axis-matched.
  const feet: number[] = [];
  for (const m of src.matchAll(/(\d{2,3})\s*['’](?:\s*-?\s*(\d{1,2}))?/g)) {
    const ft = Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0);
    if (ft >= 15 && ft <= 200) feet.push(ft);
  }
  for (const m of src.matchAll(/(\d{2,3})\s*(?:ft|feet)\b/gi)) {
    const ft = Number(m[1]);
    if (ft >= 15 && ft <= 200) feet.push(ft);
  }
  if (feet.length === 0) return null;

  // Snap a raw pt/ft to the nearest standard architectural sheet scale.
  const snap = (ptPerFt: number): { std: number; err: number } | null => {
    let best: { std: number; err: number } | null = null;
    for (const std of STD_PT_PER_FT) {
      const err = Math.abs(ptPerFt - std) / std;
      if (!best || err < best.err) best = { std, err };
    }
    return best && best.err <= 0.1 ? best : null;
  };
  // A printed dimension is the building's overall side; try each candidate foot
  // value against BOTH bbox axes and keep whichever lands CLEANEST on a standard
  // scale. The real overall (64→18, 4% off) beats a spurious room dim or a
  // mis-traced width (82→13.5, 8% off), so the cleanest snap self-selects the
  // right anchor even when several numbers are present.
  let pick: { std: number; err: number; overallFt: number } | null = null;
  for (const ft of feet) {
    for (const dim of [Math.max(w, h), Math.min(w, h)]) {
      const s = snap(dim / ft);
      if (s && (!pick || s.err < pick.err)) pick = { ...s, overallFt: ft };
    }
  }
  if (!pick) return null;

  const ptPerFt = pick.std;
  const inchesPerFt = ptPerFt / 72; // e.g. 18 pt/ft → 0.25" = 1/4"=1'-0"
  return {
    ftPerPt: 1 / ptPerFt,
    ptPerFt,
    source: `vector outline anchored to ${pick.overallFt.toFixed(0)}ft overall dimension (${ptPerFt} pt/ft ≈ ${inchesPerFt.toFixed(3).replace(/0+$/, "")}"=1'-0" sheet scale)`,
  };
}

/** Shoelace area of a polygon (absolute). */
function polyAreaAbs(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Ray-cast point-in-polygon. */
function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

/** Min distance from a point to a polygon's boundary. */
function distToPoly(p: Pt, poly: Pt[]): number {
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
 * Does this traced polygon look like the SHEET FRAME rather than the building?
 * A frame (a) fills ~the entire segment bbox, and (b) has most of the drawn
 * segment length strictly INSIDE it (the whole drawing sits inside the border).
 * A building trace fails (a) on any sheet with dimension lines outside the
 * walls, and fails (b) because only its interior partitions sit inside.
 */
function looksLikeFrame(
  polygon: Pt[],
  bbox: { x0: number; y0: number; x1: number; y1: number },
  segments: number[][],
): boolean {
  const bboxArea = (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0);
  if (bboxArea <= 0) return false;
  if (polyAreaAbs(polygon) < 0.95 * bboxArea) return false;
  const tol = Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0) * 0.02;
  let inLen = 0;
  let totLen = 0;
  for (const s of segments) {
    if (s.length < 4) continue;
    const len = Math.hypot(s[2] - s[0], s[3] - s[1]);
    const mid = { x: (s[0] + s[2]) / 2, y: (s[1] + s[3]) / 2 };
    totLen += len;
    if (pointInPoly(mid, polygon) && distToPoly(mid, polygon) > tol) inLen += len;
  }
  return totLen > 0 && inLen / totLen >= 0.5;
}

/** Drop long axis-aligned segments hugging the bbox edges — the sheet border /
 *  drawing-area frame. A closed frame at the extremes seals the exterior
 *  flood-fill out, so the "largest enclosed region" becomes the whole sheet and
 *  the trace returns a perfect 4-corner box instead of the building. */
function stripFrameSegments(
  segments: number[][],
  bbox: { x0: number; y0: number; x1: number; y1: number },
): number[][] {
  const tol = Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0) * 0.02;
  const nearEdge = (v: number, lo: number, hi: number) => v - lo < tol || hi - v < tol;
  return segments.filter((s) => {
    if (s.length < 4) return false;
    const horiz = Math.abs(s[1] - s[3]) < tol;
    const vert = Math.abs(s[0] - s[2]) < tol;
    if (horiz && nearEdge(s[1], bbox.y0, bbox.y1) && nearEdge(s[3], bbox.y0, bbox.y1)) return false;
    if (vert && nearEdge(s[0], bbox.x0, bbox.x1) && nearEdge(s[2], bbox.x0, bbox.x1)) return false;
    return true;
  });
}

/** One rasterize→flood→trace pass over a segment set. */
function tracePass(
  segments: number[][],
  opts?: { grid?: number; gapCells?: number },
): { polygon: Pt[]; bbox: { x0: number; y0: number; x1: number; y1: number } } | null {
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

  // Morphological OPENING (erode k → largest component → dilate k back within
  // the original region): cuts the thin necks that attach non-building junk —
  // a footing-schedule table connected through a leader line — while the
  // building's real masses (≳8 ft wide) survive. Accepted only when it keeps
  // the BULK of the region: a genuine neck-cut sheds a small appendage (~10%),
  // while erosion dissolving the interior walls of a partitioned plan
  // fragments the region (largest piece = one room) — fall back un-opened.
  const k = Math.max(2, Math.round(G / 50));
  let region = insideRaw;
  const eroded = erode(grid, insideRaw, k);
  if (eroded.some((v) => v)) {
    const core = largestMaskComponent(grid, eroded);
    const opened = dilate(grid, core, k, insideRaw);
    const openedCount = opened.reduce((a, b) => a + b, 0);
    if (openedCount >= Math.max(gw * gh * 0.05, insideCount * 0.8)) region = opened;
  }

  // Erode away the wall thickening so the outline tracks the real walls.
  const inside = erode(grid, region, thick);

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
}

type Outline = { polygon: Pt[]; bbox: { x0: number; y0: number; x1: number; y1: number } };

/**
 * One flood-fill trace over a fixed segment set, with iterative sheet-frame
 * peeling: when a pass traces a polygon that fills ~the whole segment bbox,
 * that polygon IS the border/drawing frame — strip the frame-hugging segments
 * and re-trace what's inside. Without this, any sheet with a closed border
 * (i.e. every real plan set) traces as a perfect 4-corner box and the
 * articulated footprint inside is never seen.
 */
function traceWithFramePeel(
  segments: number[][],
  opts?: { grid?: number; gapCells?: number },
): Outline | null {
  let segs = segments;
  let fallback: Pt[] | null = null; // the outermost frame-like trace
  for (let pass = 0; pass < 3; pass++) {
    const res = tracePass(segs, opts);
    if (!res) break;
    if (!looksLikeFrame(res.polygon, res.bbox, segs)) {
      // A real building, not the frame — done.
      return { polygon: res.polygon, bbox: bboxPts(res.polygon) };
    }
    fallback ??= res.polygon;
    const peeled = stripFrameSegments(segs, res.bbox);
    if (peeled.length === segs.length || peeled.length < 4) break; // nothing to peel
    segs = peeled;
  }
  // Never found a building inside the frame(s). A plain 4-corner frame may
  // pass through (the caller's ≤4-corner gate skips it anyway); an
  // "articulated" frame (border + title-block notch) must not masquerade as
  // a footprint.
  if (fallback && fallback.length <= 4) {
    return { polygon: fallback, bbox: bboxPts(fallback) };
  }
  return null;
}

const WIDTH_COVERAGE = 0.5; // ≥50% of segs must carry a stroke weight to tier

/**
 * Peel the DIMENSION-LINE LATTICE off a dimensioned plan using stroke weight.
 *
 * The flood-fill in traceWithFramePeel stops at the OUTERMOST closed contour.
 * On a foundation / floor plan that contour is the ring of stacked dimension
 * strings + extension lines that surrounds the walls — NOT the building. The
 * true stem walls sit strictly inside it and are never traced (Woodinville:
 * an 80×80 ft dimension ring hiding the real 64×63 ft house). But the walls
 * are drawn HEAVIER than the dimension/grid lines and LIGHTER than the sheet
 * frame, so re-tracing on just the structural-weight band recovers the real
 * footprint.
 *
 * Strictly additive: returns a tiered outline only when it is a clean,
 * meaningfully-SMALLER improvement over `base` (the all-segments trace) —
 * i.e. it actually peeled the lattice. Any ambiguity → null and `base` stands,
 * so a plan with uniform stroke weights, or no widths at all (legacy rows),
 * degrades to exactly today's behavior.
 */
function tierByWidth(
  segments: number[][],
  base: Outline | null,
  opts?: { grid?: number; gapCells?: number },
): Outline | null {
  const measured = segments.filter((s) => s.length >= 5 && Number.isFinite(s[4]) && s[4] > 0);
  if (measured.length < WIDTH_COVERAGE * segments.length) return null;

  // Length-weighted distinct (quantized) widths, thinnest → thickest.
  const lenByW = new Map<number, number>();
  for (const s of measured) {
    const w = Math.round(s[4] * 100) / 100;
    lenByW.set(w, (lenByW.get(w) ?? 0) + Math.hypot(s[2] - s[0], s[3] - s[1]));
  }
  const distinct = [...lenByW.keys()].sort((a, b) => a - b);
  if (distinct.length < 3) return null; // need thin dims / walls / frame to separate

  // Exclude the sheet frame: the thickest tier when it stands clearly above the
  // rest (heavy border stroke). Structural walls are everything below it.
  const top = distinct[distinct.length - 1];
  const prev = distinct[distinct.length - 2];
  const frameCeil = top / prev >= 1.5 ? top : Infinity; // strict `< frameCeil`

  const baseArea = base ? polyAreaAbs(base.polygon) : Infinity;
  const grossArea = (() => {
    const bb = bboxOf(segments);
    return bb ? (bb.x1 - bb.x0) * (bb.y1 - bb.y0) : Infinity;
  })();

  // Candidate weight floors: each distinct wall-tier width, skipping the single
  // thinnest tier (dimension lines) and anything at/above the frame. For each,
  // trace {s : floor ≤ w < frameCeil}. As the floor drops the trace stays on
  // the inner building until it reaches the grid/dimension weight, at which
  // point its AREA JUMPS to the lattice — the area-ratio band rejects that jump.
  let bestPick: Outline | null = null;
  let bestCorners = -Infinity;
  let bestArea = -Infinity;
  for (let fi = 1; fi < distinct.length; fi++) {
    const floor = distinct[fi];
    if (floor >= frameCeil) break;
    const subset = segments.filter(
      (s) => s.length >= 5 && Number.isFinite(s[4]) && s[4] >= floor && s[4] < frameCeil,
    );
    if (subset.length < 4) continue; // need at least a closed ring's worth
    const res = traceWithFramePeel(subset, opts);
    if (!res || res.polygon.length < 5 || res.polygon.length > 40) continue;
    const area = polyAreaAbs(res.polygon);
    if (area <= 0) continue;
    // Must be strictly smaller than the all-segments trace (it peeled the
    // lattice) but not a tiny fragment of the sheet; reference against whichever
    // of base / gross area is finite.
    const ref = Number.isFinite(baseArea) ? baseArea : grossArea;
    if (!Number.isFinite(ref) || ref <= 0) continue;
    const ratio = area / ref;
    if (ratio < 0.15 || ratio > 0.8) continue;
    // Prefer the MOST ARTICULATED qualifying tier — the one that captures the
    // most real jogs (rear patio, entry, garage step). snapAndClean already
    // removed sub-cell staircase noise, so within the clean 5–40 corner band a
    // higher corner count means more genuine wall jogs, not more noise. Tie-break
    // on the larger area (the more inclusive tier of two equally-articulated).
    const corners = res.polygon.length;
    if (corners > bestCorners || (corners === bestCorners && area > bestArea)) {
      bestCorners = corners;
      bestArea = area;
      bestPick = { polygon: res.polygon, bbox: bboxPts(res.polygon) };
    }
  }
  return bestPick;
}

/**
 * Recover the building outline polygon from drawn wall segments. Returns the
 * polygon in the input's coordinate space + the POLYGON's bbox (the building's
 * extent — callers co-register the AI trace onto it, so it must bound the
 * building, not the whole sheet), or null.
 *
 * Two stages: (1) the all-segments flood-fill trace with sheet-frame peeling;
 * (2) when the segments carry stroke weights (5-tuples from selectSegments),
 * a width-tiered refinement that peels the surrounding dimension-line lattice
 * off a dimensioned plan and recovers the true wall polygon inside it. The
 * refinement only replaces stage 1 when it is a clean, strictly-smaller
 * improvement, so weightless input (legacy rows) is unchanged.
 */
export function extractBuildingOutline(
  segments: number[][],
  opts?: { grid?: number; gapCells?: number },
): Outline | null {
  try {
    if (!segments || segments.length < 4) return null;
    const base = traceWithFramePeel(segments, opts);
    const tiered = tierByWidth(segments, base, opts);
    return tiered ?? base;
  } catch {
    return null;
  }
}
