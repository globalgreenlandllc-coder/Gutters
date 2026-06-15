/**
 * Roof-skeleton derivation — turn a building FOOTPRINT polygon into a
 * plausible, fully-connected set of roof-plane lines (ridges, hips,
 * valleys) so the takeoff overlay reads like an actual architect's roof
 * plan instead of a bare outline with a couple of floating dashes.
 *
 * Why derive instead of trace? The AI can read the footprint SHAPE and
 * the eave/gable classification reliably off the floor/foundation plans,
 * but it cannot reliably trace interior ridge/hip/valley lines off a
 * dense truss-framing sheet — they come back sparse, floating, and
 * disconnected. The roof's interior geometry, however, is almost fully
 * DETERMINED by the footprint: a hip roof slopes up at ~45° from every
 * eave, ridges form where opposing slopes meet, hips run up from outside
 * corners, valleys drop in at inside (reflex) corners. So we compute it.
 *
 * This output is DECORATIVE ONLY — it never feeds LF, totals, or pricing
 * (those come from the eaves / gutter_runs). It exists purely so the
 * contractor can recognize the house, see its shape and orientation, and
 * judge whether the gutters are on the right edges. It is intentionally
 * schematic: clean straight planes, not a structural truss layout.
 *
 * Approach (robust + node-testable, no special-case event math):
 *   1. Clean + close the polygon.
 *   2. Build a coarse grid from the polygon's own vertex coordinates, so
 *      grid lines fall exactly on the building's wings/jogs.
 *   3. Classify each grid cell inside/outside (point-in-polygon).
 *   4. Greedily merge inside cells into maximal rectangles (the wings).
 *   5. Per rectangle, emit a hip/gable ridge + hips, suppressing roof
 *      lines on edges SHARED with a neighbour rectangle (interior walls
 *      aren't eaves), so the wings' roofs connect instead of double up.
 *   6. Add valley lines at the polygon's reflex (inside) corners.
 *
 * Everything is pure (no DOM, no server-only, no React) so it runs in the
 * browser bundle AND under `node` for tests.
 */

export type Pt = { x: number; y: number };
export type Seg = [Pt, Pt];
export type SkeletonLine = { points: [Pt, Pt] };
export type RoofSkeleton = {
  ridges: SkeletonLine[];
  hips: SkeletonLine[];
  valleys: SkeletonLine[];
  /** Perimeter segments that are GABLE ends (rake-only, no gutter). The
   *  ridge runs flush to these so the gable reads as part of the connected
   *  roof; callers can label them. */
  gables: SkeletonLine[];
};

const EMPTY: RoofSkeleton = { ridges: [], hips: [], valleys: [], gables: [] };

function isFinitePt(p: Pt | undefined | null): p is Pt {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** Drop consecutive duplicates and a trailing point equal to the first. */
function cleanRing(poly: readonly Pt[], tol: number): Pt[] {
  const pts = poly.filter(isFinitePt);
  const out: Pt[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > tol) out.push({ x: p.x, y: p.y });
  }
  // Remove closing duplicate (last ≈ first).
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= tol) out.pop();
  }
  return out;
}

/** Collapse near-equal coordinates onto shared grid lines so a wing edge
 *  that the AI drew 2px off still lands on one line. */
function uniqAxis(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > tol) out.push(v);
    else out[out.length - 1] = (out[out.length - 1] + v) / 2; // average the cluster
  }
  return out;
}

function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

type Rect = { x0: number; x1: number; y0: number; y1: number };

/**
 * Greedy maximal-rectangle cover of the inside-cells grid. `inside[i][j]`
 * is the cell spanning xs[i]..xs[i+1] × ys[j]..ys[j+1]. We repeatedly take
 * the largest-area rectangle of still-uncovered inside cells. Producing a
 * few big rectangles (the main mass + wings) rather than many slivers is
 * what keeps the derived roof clean.
 */
function coverRectangles(
  inside: boolean[][],
  nx: number,
  ny: number,
): { i0: number; i1: number; j0: number; j1: number }[] {
  const covered: boolean[][] = Array.from({ length: nx }, () =>
    new Array(ny).fill(false),
  );
  const rects: { i0: number; i1: number; j0: number; j1: number }[] = [];
  const free = (i: number, j: number) => inside[i][j] && !covered[i][j];

  for (;;) {
    let best: { i0: number; i1: number; j0: number; j1: number; area: number } | null =
      null;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        if (!free(i, j)) continue;
        // Grow width as far right as the whole column-range stays free.
        let maxI = i;
        while (maxI + 1 < nx && free(maxI + 1, j)) maxI++;
        // For each candidate right edge, grow height while the full row
        // band stays free, and track the largest cell-area rectangle.
        for (let ri = i; ri <= maxI; ri++) {
          let maxJ = j;
          outer: while (maxJ + 1 < ny) {
            for (let c = i; c <= ri; c++) if (!free(c, maxJ + 1)) break outer;
            maxJ++;
          }
          const area = (ri - i + 1) * (maxJ - j + 1);
          if (!best || area > best.area)
            best = { i0: i, i1: ri, j0: j, j1: maxJ, area };
        }
      }
    }
    if (!best) break;
    for (let i = best.i0; i <= best.i1; i++)
      for (let j = best.j0; j <= best.j1; j++) covered[i][j] = true;
    rects.push({ i0: best.i0, i1: best.i1, j0: best.j0, j1: best.j1 });
    if (rects.length > 24) break; // safety valve against pathological input
  }
  return rects;
}

/** Is the whole grid edge between cell (i,j) on the given side adjacent to
 *  another INSIDE cell? Then it's an interior wall, not an eave. */
function sideIsInterior(
  inside: boolean[][],
  nx: number,
  ny: number,
  rect: { i0: number; i1: number; j0: number; j1: number },
  side: "top" | "bottom" | "left" | "right",
): boolean {
  // A rectangle side is "interior" (shared) when EVERY cell just outside
  // that side is also inside the footprint.
  if (side === "left") {
    if (rect.i0 === 0) return false;
    for (let j = rect.j0; j <= rect.j1; j++) if (!inside[rect.i0 - 1][j]) return false;
    return true;
  }
  if (side === "right") {
    if (rect.i1 === nx - 1) return false;
    for (let j = rect.j0; j <= rect.j1; j++) if (!inside[rect.i1 + 1][j]) return false;
    return true;
  }
  if (side === "top") {
    if (rect.j0 === 0) return false;
    for (let i = rect.i0; i <= rect.i1; i++) if (!inside[i][rect.j0 - 1]) return false;
    return true;
  }
  // bottom
  if (rect.j1 === ny - 1) return false;
  for (let i = rect.i0; i <= rect.i1; i++) if (!inside[i][rect.j1 + 1]) return false;
  return true;
}

/**
 * Hip/gable ridge for one rectangle. Sides flagged `interior` get no hip
 * and the ridge runs out to that wall (a gable that abuts the neighbour),
 * so adjacent wings' ridges meet instead of each growing its own hip into
 * a shared wall.
 */
function rectRoof(
  r: Rect,
  flush: { top: boolean; bottom: boolean; left: boolean; right: boolean },
): { ridges: SkeletonLine[]; hips: SkeletonLine[] } {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w <= 0 || h <= 0) return { ridges: [], hips: [] };
  const ridges: SkeletonLine[] = [];
  const hips: SkeletonLine[] = [];

  // Ridge runs along the LONGER dimension. inset = half the SHORTER
  // dimension gives 45° hips. A HIP end is inset (with two hip diagonals);
  // a FLUSH end — a gable end, or a wall shared with a neighbour wing —
  // runs the ridge out to the wall with NO hip there.
  if (w >= h) {
    const yc = (r.y0 + r.y1) / 2;
    const inset = h / 2;
    const leftEnd = flush.left ? r.x0 : r.x0 + inset;
    const rightEnd = flush.right ? r.x1 : r.x1 - inset;
    const lo = Math.min(leftEnd, rightEnd);
    const hi = Math.max(leftEnd, rightEnd);
    // Skip a zero-length ridge: a square footprint is a pyramid whose four
    // hips already meet at the apex — there is no ridge line to draw.
    if (hi - lo > 1e-6)
      ridges.push({ points: [{ x: lo, y: yc }, { x: hi, y: yc }] });
    if (!flush.left) {
      hips.push({ points: [{ x: leftEnd, y: yc }, { x: r.x0, y: r.y0 }] });
      hips.push({ points: [{ x: leftEnd, y: yc }, { x: r.x0, y: r.y1 }] });
    }
    if (!flush.right) {
      hips.push({ points: [{ x: rightEnd, y: yc }, { x: r.x1, y: r.y0 }] });
      hips.push({ points: [{ x: rightEnd, y: yc }, { x: r.x1, y: r.y1 }] });
    }
  } else {
    const xc = (r.x0 + r.x1) / 2;
    const inset = w / 2;
    const topEnd = flush.top ? r.y0 : r.y0 + inset;
    const botEnd = flush.bottom ? r.y1 : r.y1 - inset;
    const lo = Math.min(topEnd, botEnd);
    const hi = Math.max(topEnd, botEnd);
    if (hi - lo > 1e-6)
      ridges.push({ points: [{ x: xc, y: lo }, { x: xc, y: hi }] });
    if (!flush.top) {
      hips.push({ points: [{ x: xc, y: topEnd }, { x: r.x0, y: r.y0 }] });
      hips.push({ points: [{ x: xc, y: topEnd }, { x: r.x1, y: r.y0 }] });
    }
    if (!flush.bottom) {
      hips.push({ points: [{ x: xc, y: botEnd }, { x: r.x0, y: r.y1 }] });
      hips.push({ points: [{ x: xc, y: botEnd }, { x: r.x1, y: r.y1 }] });
    }
  }
  return { ridges, hips };
}

/** Does an eave segment run ALONG this axis-aligned rectangle side? Used to
 *  decide hip vs gable: a side with a gutter on it is an eave side (hip
 *  allowed); a side with no gutter is a gable/return end (flush, no hip). */
function sideHasEave(
  axis: "h" | "v",
  fixed: number,
  lo: number,
  hi: number,
  eaves: readonly Seg[],
  tol: number,
): boolean {
  for (const [a, b] of eaves) {
    if (axis === "v") {
      // vertical side at x=fixed, y in [lo,hi]; eave must be ~vertical there
      if (Math.abs(a.x - fixed) > tol || Math.abs(b.x - fixed) > tol) continue;
      const elo = Math.min(a.y, b.y);
      const ehi = Math.max(a.y, b.y);
      if (Math.min(hi, ehi) - Math.max(lo, elo) > tol) return true;
    } else {
      if (Math.abs(a.y - fixed) > tol || Math.abs(b.y - fixed) > tol) continue;
      const elo = Math.min(a.x, b.x);
      const ehi = Math.max(a.x, b.x);
      if (Math.min(hi, ehi) - Math.max(lo, elo) > tol) return true;
    }
  }
  return false;
}

/** Cross-product sign at vertex b for the ring a→b→c. Sign tells convex
 *  vs reflex once we know the ring's winding. */
function cross(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

function signedArea(poly: readonly Pt[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += (poly[j].x * poly[i].y) - (poly[i].x * poly[j].y);
  }
  return s / 2;
}

/**
 * Valley lines at reflex (inside) corners. A reflex corner is where the
 * footprint cuts inward; two roof planes meet there and water runs down a
 * valley along the corner's inward 45° bisector. We draw a short valley
 * stub inward — enough to read, not so long it crosses the whole roof.
 *
 * ASSUMES a (near-)rectilinear footprint, which residential roof outlines
 * overwhelmingly are. The bisector below is the exact inward 45° line for a
 * 90° corner; for a non-orthogonal corner it still points generally inward
 * (a reasonable schematic) but is no longer a true angle bisector. This is
 * decorative-only, so an approximate direction on a rare angled corner is
 * acceptable — it never affects measurements.
 */
function valleyLines(poly: readonly Pt[], reach: number): SkeletonLine[] {
  const n = poly.length;
  if (n < 4) return [];
  const area = signedArea(poly);
  const ccw = area > 0;
  const out: SkeletonLine[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const cur = poly[i];
    const next = poly[(i + 1) % n];
    const cr = cross(prev, cur, next);
    // Reflex when the turn is opposite to the polygon's winding.
    const reflex = ccw ? cr < 0 : cr > 0;
    if (!reflex) continue;
    // Inward bisector = normalized(prev-dir + next-dir reversed)…
    // Simpler & robust for rectilinear corners: average the two edge
    // directions pointing AWAY from the corner, negate to point inward.
    const d1 = norm({ x: prev.x - cur.x, y: prev.y - cur.y });
    const d2 = norm({ x: next.x - cur.x, y: next.y - cur.y });
    let bx = d1.x + d2.x;
    let by = d1.y + d2.y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) continue; // straight-ish, skip
    bx /= bl;
    by /= bl;
    // For a reflex corner the inward direction is the bisector NEGATED
    // (the d1+d2 bisector points back out of the notch).
    out.push({
      points: [
        { x: cur.x, y: cur.y },
        { x: cur.x - bx * reach, y: cur.y - by * reach },
      ],
    });
  }
  return out;
}

function norm(v: Pt): Pt {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

/**
 * Derive the roof skeleton from a footprint polygon (canvas coordinates).
 * Returns clean ridge/hip/valley line segments. Never throws — returns
 * empty on degenerate input so the caller can fall back to a bare outline.
 */
export function deriveRoofSkeleton(
  perimeter: readonly Pt[],
  opts?: { eaveSegments?: readonly Seg[]; rakeSegments?: readonly Seg[] },
): RoofSkeleton {
  try {
    const finite = (perimeter ?? []).filter(isFinitePt);
    if (finite.length < 4) return EMPTY;
    // Tolerance scales with building size so snapping is resolution-aware.
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of finite) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const span = Math.max(maxX - minX, maxY - minY);
    if (!Number.isFinite(span) || span <= 0) return EMPTY;
    const tol = Math.max(2, span * 0.03);

    const ring = cleanRing(finite, tol);
    if (ring.length < 4) return EMPTY;

    const xs = uniqAxis(
      ring.map((p) => p.x).concat([minX, maxX]),
      tol,
    );
    const ys = uniqAxis(
      ring.map((p) => p.y).concat([minY, maxY]),
      tol,
    );
    const nx = xs.length - 1;
    const ny = ys.length - 1;
    if (nx < 1 || ny < 1) return EMPTY;

    // Classify cells.
    const inside: boolean[][] = Array.from({ length: nx }, () =>
      new Array(ny).fill(false),
    );
    let insideCount = 0;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const cx = (xs[i] + xs[i + 1]) / 2;
        const cy = (ys[j] + ys[j + 1]) / 2;
        if (pointInPolygon({ x: cx, y: cy }, ring)) {
          inside[i][j] = true;
          insideCount++;
        }
      }
    }
    if (insideCount === 0) return EMPTY;

    const rectCells = coverRectangles(inside, nx, ny);
    // If decomposition fragmented badly, fall back to a single bounding
    // hip roof — still clean, still reads as a roof. Threshold kept high
    // (was 8 — too eager: an articulated house with a garage + porch +
    // patio + a few jogs legitimately exceeds 8 wings, and collapsing it to
    // a bounding box was a real cause of "just a box" renders). Only a truly
    // over-fragmented (noisy) footprint should fall back.
    const rects: Rect[] =
      rectCells.length === 0 || rectCells.length > 18
        ? [{ x0: minX, x1: maxX, y0: minY, y1: maxY }]
        : rectCells.map((rc) => ({
            x0: xs[rc.i0],
            x1: xs[rc.i1 + 1],
            y0: ys[rc.j0],
            y1: ys[rc.j1 + 1],
          }));

    // Eave segments (gutter runs) let us tell a HIP side (gutter present)
    // from a GABLE side (no gutter). Without them we fall back to all-hip.
    const eaveSegs = (opts?.eaveSegments ?? []).filter(
      (s) => s && isFinitePt(s[0]) && isFinitePt(s[1]),
    );
    // Rake (gable) segments: the AI's explicit gable classification. A side
    // a rake runs along is a GABLE end — render it flush (ridge to wall) so
    // the gable connects to the roof, instead of as a floating stub.
    const rakeSegs = (opts?.rakeSegments ?? []).filter(
      (s) => s && isFinitePt(s[0]) && isFinitePt(s[1]),
    );
    const haveEaves = eaveSegs.length > 0;
    const eaveTol = tol * 2; // eaves sit ~1-2 ft inside the eave line (overhang)

    // Guard: if eaves were passed but NONE align with any rectangle side
    // (coordinate-space mismatch / bad data), don't turn every side into a
    // gable — fall back to all-hip so we still draw a recognizable roof.
    let anyEaveMatch = false;
    if (haveEaves) {
      for (const rc of rectCells.length
        ? rectCells.map((c) => ({
            x0: xs[c.i0],
            x1: xs[c.i1 + 1],
            y0: ys[c.j0],
            y1: ys[c.j1 + 1],
          }))
        : [{ x0: minX, x1: maxX, y0: minY, y1: maxY }]) {
        if (
          sideHasEave("h", rc.y0, rc.x0, rc.x1, eaveSegs, eaveTol) ||
          sideHasEave("h", rc.y1, rc.x0, rc.x1, eaveSegs, eaveTol) ||
          sideHasEave("v", rc.x0, rc.y0, rc.y1, eaveSegs, eaveTol) ||
          sideHasEave("v", rc.x1, rc.y0, rc.y1, eaveSegs, eaveTol)
        ) {
          anyEaveMatch = true;
          break;
        }
      }
    }
    const useEaves = haveEaves && anyEaveMatch;

    const ridges: SkeletonLine[] = [];
    const hips: SkeletonLine[] = [];
    const gables: SkeletonLine[] = [];
    const single = rects.length === 1 && rectCells.length <= 1;
    for (let k = 0; k < rects.length; k++) {
      const r = rects[k];
      const interior =
        single || rectCells.length === 0
          ? { top: false, bottom: false, left: false, right: false }
          : {
              top: sideIsInterior(inside, nx, ny, rectCells[k], "top"),
              bottom: sideIsInterior(inside, nx, ny, rectCells[k], "bottom"),
              left: sideIsInterior(inside, nx, ny, rectCells[k], "left"),
              right: sideIsInterior(inside, nx, ny, rectCells[k], "right"),
            };
      // A side is a GABLE end when a RAKE runs along it (the AI's explicit
      // classification — wins), OR — knowing the eaves — when it carries no
      // gutter. A gable side renders FLUSH (ridge to wall, no hip) so it
      // connects to the roof, and is recorded so the caller can label it.
      const isGable = (axis: "h" | "v", fixed: number, lo: number, hi: number) =>
        sideHasEave(axis, fixed, lo, hi, rakeSegs, eaveTol) ||
        (useEaves && !sideHasEave(axis, fixed, lo, hi, eaveSegs, eaveTol));
      const SIDES = [
        { k: "top" as const, axis: "h" as const, fixed: r.y0, lo: r.x0, hi: r.x1, a: { x: r.x0, y: r.y0 }, b: { x: r.x1, y: r.y0 } },
        { k: "bottom" as const, axis: "h" as const, fixed: r.y1, lo: r.x0, hi: r.x1, a: { x: r.x0, y: r.y1 }, b: { x: r.x1, y: r.y1 } },
        { k: "left" as const, axis: "v" as const, fixed: r.x0, lo: r.y0, hi: r.y1, a: { x: r.x0, y: r.y0 }, b: { x: r.x0, y: r.y1 } },
        { k: "right" as const, axis: "v" as const, fixed: r.x1, lo: r.y0, hi: r.y1, a: { x: r.x1, y: r.y0 }, b: { x: r.x1, y: r.y1 } },
      ];
      const flush = { top: false, bottom: false, left: false, right: false };
      for (const s of SIDES) {
        if (interior[s.k]) {
          flush[s.k] = true;
          continue;
        }
        if (isGable(s.axis, s.fixed, s.lo, s.hi)) {
          flush[s.k] = true;
          gables.push({ points: [s.a, s.b] });
        }
      }
      const rr = rectRoof(r, flush);
      ridges.push(...rr.ridges);
      hips.push(...rr.hips);
    }

    const valleys = valleyLines(ring, Math.max(tol * 2, span * 0.12));

    return { ridges, hips, valleys, gables };
  } catch {
    return EMPTY;
  }
}
