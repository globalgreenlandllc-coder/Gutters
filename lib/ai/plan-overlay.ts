/**
 * plan-overlay.ts — build the ANNOTATED EDGE MAP the edge classifier reads.
 *
 * v2 "classify, don't trace": the model never emits coordinates — it answers
 * questions about edges WE define. This module defines them: number the
 * outline's edges E1…En, tag candidate dimension spans D1…Dk, and render
 * everything over the sheet's own extracted linework so the model can match
 * chips to the drawing's callouts (GABLE END TRUSS, CONT. METAL GUTTER, D.S.,
 * printed dims). PURE — SVG string out; rasterization happens in the caller
 * (sharp lives server-side).
 */

export type OverlayPt = { x: number; y: number };

export type OutlineEdge = {
  id: string; // "E1"…
  p1: OverlayPt;
  p2: OverlayPt;
  lenPt: number;
  mid: OverlayPt;
  /** "h" horizontal / "v" vertical / "d" diagonal (canvas axes). */
  axis: "h" | "v" | "d";
};

export type DimSpanCandidate = {
  id: string; // "D1"…
  p1: OverlayPt;
  p2: OverlayPt;
  spanPt: number;
  axis: "h" | "v";
};

/** Number the polygon's edges in ring order. Degenerate edges (< 1pt) are
 *  kept (ids must stay aligned with the polygon) but flagged by length. */
export function outlineEdges(outline: readonly OverlayPt[]): OutlineEdge[] {
  const n = outline.length;
  const edges: OutlineEdge[] = [];
  for (let i = 0; i < n; i++) {
    const p1 = outline[i];
    const p2 = outline[(i + 1) % n];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const lenPt = Math.hypot(dx, dy);
    const axis =
      lenPt < 1e-6
        ? "d"
        : Math.abs(dx) >= 3 * Math.abs(dy)
          ? "h"
          : Math.abs(dy) >= 3 * Math.abs(dx)
            ? "v"
            : "d";
    edges.push({
      id: `E${i + 1}`,
      p1: { x: p1.x, y: p1.y },
      p2: { x: p2.x, y: p2.y },
      lenPt,
      mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      axis,
    });
  }
  return edges;
}

function pointInPoly(p: OverlayPt, poly: readonly OverlayPt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Render the edge map. `segments` is the page's extracted linework
 * ([x1,y1,x2,y2] or 5-tuples with width) drawn faint for context; `outline`
 * is drawn bold with an E-chip per edge (offset OUTWARD so chips never cover
 * the roof interior); `dims` draw dashed magenta with D-chips.
 */
export function renderEdgeMapSvg(opts: {
  outline: readonly OverlayPt[];
  segments?: readonly number[][];
  dims?: readonly DimSpanCandidate[];
}): { svg: string; edges: OutlineEdge[]; widthPx: number; heightPx: number } {
  const { outline } = opts;
  const segments = opts.segments ?? [];
  const dims = opts.dims ?? [];
  const edges = outlineEdges(outline);

  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  // Include dim spans in the frame — they sit outside the outline by design.
  for (const d of dims) {
    minX = Math.min(minX, d.p1.x, d.p2.x);
    maxX = Math.max(maxX, d.p1.x, d.p2.x);
    minY = Math.min(minY, d.p1.y, d.p2.y);
    maxY = Math.max(maxY, d.p1.y, d.p2.y);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const pad = span * 0.14;

  // Target ~1600px on the long side — crisp enough for chip text at the
  // model's vision resolution without exploding the payload.
  const S = 1600 / (span + 2 * pad);
  const W = Math.round((maxX - minX + 2 * pad) * S);
  const H = Math.round((maxY - minY + 2 * pad) * S);
  const X = (x: number) => ((x - minX + pad) * S).toFixed(1);
  const Y = (y: number) => ((y - minY + pad) * S).toFixed(1);

  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

  // Context linework — the sheet's own strokes, faint gray.
  for (const s of segments) {
    if (!Array.isArray(s) || s.length < 4) continue;
    parts.push(
      `<line x1="${X(s[0])}" y1="${Y(s[1])}" x2="${X(s[2])}" y2="${Y(s[3])}" stroke="#9ca3af" stroke-width="1" opacity="0.55"/>`,
    );
  }

  // Outline — bold navy ring.
  const ring = outline
    .map((p, i) => `${i ? "L" : "M"}${X(p.x)},${Y(p.y)}`)
    .join(" ");
  parts.push(
    `<path d="${ring} Z" fill="none" stroke="#1e3a8a" stroke-width="5" stroke-linejoin="round"/>`,
  );
  for (const p of outline) {
    parts.push(`<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="6" fill="#dc2626"/>`);
  }

  // Dim spans — dashed magenta with end ticks + D-chips.
  for (const d of dims) {
    parts.push(
      `<line x1="${X(d.p1.x)}" y1="${Y(d.p1.y)}" x2="${X(d.p2.x)}" y2="${Y(d.p2.y)}" stroke="#c026d3" stroke-width="3" stroke-dasharray="10 6"/>`,
    );
    for (const e of [d.p1, d.p2]) {
      const tick = 12;
      if (d.axis === "h") {
        parts.push(
          `<line x1="${X(e.x)}" y1="${(parseFloat(Y(e.y)) - tick).toFixed(1)}" x2="${X(e.x)}" y2="${(parseFloat(Y(e.y)) + tick).toFixed(1)}" stroke="#c026d3" stroke-width="3"/>`,
        );
      } else {
        parts.push(
          `<line x1="${(parseFloat(X(e.x)) - tick).toFixed(1)}" y1="${Y(e.y)}" x2="${(parseFloat(X(e.x)) + tick).toFixed(1)}" y2="${Y(e.y)}" stroke="#c026d3" stroke-width="3"/>`,
        );
      }
    }
    const mx = (d.p1.x + d.p2.x) / 2;
    const my = (d.p1.y + d.p2.y) / 2;
    chip(parts, parseFloat(X(mx)), parseFloat(Y(my)), d.id, "#c026d3", "#fdf4ff");
  }

  // Edge chips — offset OUTWARD along the edge normal so they never cover
  // the interior (the classifier must see ridge/valley/truss context).
  let cx = 0;
  let cy = 0;
  for (const p of outline) {
    cx += p.x;
    cy += p.y;
  }
  cx /= outline.length;
  cy /= outline.length;
  for (const e of edges) {
    if (e.lenPt < 1e-6) continue;
    let nx = -(e.p2.y - e.p1.y) / e.lenPt;
    let ny = (e.p2.x - e.p1.x) / e.lenPt;
    const probe = Math.max(span * 0.005, 0.5);
    if (
      pointInPoly(
        { x: e.mid.x + nx * probe, y: e.mid.y + ny * probe },
        outline,
      )
    ) {
      nx = -nx;
      ny = -ny;
    }
    const off = span * 0.045;
    const chipX = parseFloat(X(e.mid.x + nx * off));
    const chipY = parseFloat(Y(e.mid.y + ny * off));
    // Leader from chip to its edge so adjacent chips can't be misread.
    parts.push(
      `<line x1="${chipX}" y1="${chipY}" x2="${X(e.mid.x)}" y2="${Y(e.mid.y)}" stroke="#1e3a8a" stroke-width="1.5" opacity="0.6"/>`,
    );
    chip(parts, chipX, chipY, e.id, "#1e3a8a", "#eff6ff");
  }

  parts.push(
    `<text x="18" y="34" font-family="Arial, sans-serif" font-size="26" font-weight="bold" fill="#111827">EDGE MAP — the bold ring is the roof outline; classify each E-chip edge; read the printed value for each D-chip dimension</text>`,
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
  return { svg, edges, widthPx: W, heightPx: H };
}

/**
 * Dims-only map for a SECOND page (the foundation/floor plan): its linework
 * plus D-chips on the dimension-span candidates, no edge ring. The printed
 * overall dimensions live on this page even when the roof sheet has none —
 * and both pages print at the same scale, so a value read here solves pt/ft
 * for the roof outline too.
 */
export function renderDimMapSvg(opts: {
  segments: readonly number[][];
  dims: readonly DimSpanCandidate[];
  title?: string;
}): { svg: string; widthPx: number; heightPx: number } {
  const { segments, dims } = opts;
  const pts: number[] = [];
  for (const s of segments) {
    if (Array.isArray(s) && s.length >= 4) pts.push(s[0], s[1], s[2], s[3]);
  }
  for (const d of dims) pts.push(d.p1.x, d.p1.y, d.p2.x, d.p2.y);
  if (pts.length < 4) return { svg: "<svg xmlns='http://www.w3.org/2000/svg'/>", widthPx: 0, heightPx: 0 };
  const xsAll = pts.filter((_, i) => i % 2 === 0);
  const ysAll = pts.filter((_, i) => i % 2 === 1);
  const minX = Math.min(...xsAll);
  const maxX = Math.max(...xsAll);
  const minY = Math.min(...ysAll);
  const maxY = Math.max(...ysAll);
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const pad = span * 0.06;
  const S = 1600 / (span + 2 * pad);
  const W = Math.round((maxX - minX + 2 * pad) * S);
  const H = Math.round((maxY - minY + 2 * pad) * S);
  const X = (x: number) => ((x - minX + pad) * S).toFixed(1);
  const Y = (y: number) => ((y - minY + pad) * S).toFixed(1);
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="#ffffff"/>`];
  for (const s of segments) {
    if (!Array.isArray(s) || s.length < 4) continue;
    parts.push(
      `<line x1="${X(s[0])}" y1="${Y(s[1])}" x2="${X(s[2])}" y2="${Y(s[3])}" stroke="#9ca3af" stroke-width="1" opacity="0.6"/>`,
    );
  }
  for (const d of dims) {
    parts.push(
      `<line x1="${X(d.p1.x)}" y1="${Y(d.p1.y)}" x2="${X(d.p2.x)}" y2="${Y(d.p2.y)}" stroke="#c026d3" stroke-width="3" stroke-dasharray="10 6"/>`,
    );
    const mx = (d.p1.x + d.p2.x) / 2;
    const my = (d.p1.y + d.p2.y) / 2;
    chip(parts, parseFloat(X(mx)), parseFloat(Y(my)), d.id, "#c026d3", "#fdf4ff");
  }
  parts.push(
    `<text x="16" y="30" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="#111827">${opts.title ?? "DIMENSION MAP — read the printed value for each D-chip span"}</text>`,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
  return { svg, widthPx: W, heightPx: H };
}

function chip(
  parts: string[],
  x: number,
  y: number,
  label: string,
  color: string,
  fill: string,
) {
  const w = label.length * 15 + 16;
  const h = 30;
  parts.push(
    `<rect x="${(x - w / 2).toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${color}" stroke-width="2.5"/>`,
  );
  parts.push(
    `<text x="${x.toFixed(1)}" y="${(y + 8).toFixed(1)}" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="${color}" text-anchor="middle">${label}</text>`,
  );
}

/**
 * Deterministic downspout marks from the sheet's own TEXT layer.
 *
 * Plans print "D.S." at the roof edge wherever a downspout drops. The edge
 * classifier reads them with vision, but a dense sheet can defeat that read
 * (Woodinville: zero marks seen, downspouts fell back to the 1-per-40 ft
 * rule while the foundation plan printed them plainly). The extracted text
 * items carry exact coordinates in the SAME pt space as the outline — so
 * when the vision channel comes back empty, snap each "D.S." string to the
 * nearest outline edge instead of guessing.
 *
 * Only labels within `maxFt` (default 10 ft) of an edge count — a schedule
 * or legend entry ("D.S." in a key box) is far from the perimeter and is
 * ignored. Pure — node-testable.
 */
export function downspoutMarksFromLabels(
  labels: readonly { s: string; x: number; y: number }[] | null | undefined,
  edges: readonly OutlineEdge[],
  ptPerFt: number | null | undefined,
  maxFt = 10,
): { edge_id: string; frac: number }[] {
  if (!labels || labels.length === 0 || edges.length === 0) return [];
  const tolPt = ptPerFt && ptPerFt > 0 ? maxFt * ptPerFt : 40;
  const minGapPt = ptPerFt && ptPerFt > 0 ? 4 * ptPerFt : 16;
  const out: { edge_id: string; frac: number; x: number; y: number }[] = [];
  for (const l of labels) {
    if (!/^D\.?S\.?$/i.test((l.s ?? "").trim())) continue;
    let best: { edge_id: string; frac: number; dist: number } | null = null;
    for (const e of edges) {
      if (e.lenPt < 1e-6) continue;
      const dx = e.p2.x - e.p1.x;
      const dy = e.p2.y - e.p1.y;
      const t = Math.max(
        0,
        Math.min(1, ((l.x - e.p1.x) * dx + (l.y - e.p1.y) * dy) / (e.lenPt * e.lenPt)),
      );
      const px = e.p1.x + dx * t;
      const py = e.p1.y + dy * t;
      const dist = Math.hypot(l.x - px, l.y - py);
      if (dist <= tolPt && (!best || dist < best.dist)) {
        best = { edge_id: e.id, frac: t, dist };
      }
    }
    if (!best) continue;
    // Dedupe: the same printed mark often extracts as two nearby items.
    const dup = out.some(
      (o) => Math.hypot(o.x - l.x, o.y - l.y) < minGapPt,
    );
    if (!dup) out.push({ edge_id: best.edge_id, frac: best.frac, x: l.x, y: l.y });
    if (out.length >= 40) break;
  }
  return out.map(({ edge_id, frac }) => ({
    edge_id,
    frac: Math.max(0.05, Math.min(0.95, frac)),
  }));
}
