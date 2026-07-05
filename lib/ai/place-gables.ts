/**
 * place-gables.ts — turn the independent per-face elevation reads into POSITIONED
 * engine gables on the roof-plan outline, so the engine can DRAW every gable and
 * pop-out (porch, patio, dormers) instead of relying on the freehand trace.
 *
 * For each cardinal face that was read, we find the outline edge on that side and
 * place each gable at its `position_frac` along that edge, facing outward. A
 * gable carried on POSTS / a BEAM (or read as projecting) is promoted to a
 * PROJECTING gable — that's what renders as a real pop-out with guttered side
 * eaves + a ridge-back + valleys. Everything else stays FLUSH (Correction 2).
 *
 * Positions come from the outline geometry (reliable). Sizes (span, projection)
 * are converted to pixels with a px-per-ft the CALLER derives from the runs'
 * own `length_px / length_ft` — not the unreliable declared scale. The exact
 * projection depth isn't knowable from a face view, so a schematic default is
 * used and flagged for the contractor to adjust.
 *
 * PURE (no server-only / DOM) — node-testable.
 */

import type { Facing, Gable } from "../roof-engine";
import type { FaceReadingRaw } from "./face-merge";
import type { Pt } from "../roof-skeleton";

export type PlaceResult = { gables: Gable[]; notes: string[] };

const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));

/** The outline edge on a given side: roughly perpendicular to the outward
 *  normal `n` and furthest out in that direction. (PDF-pixel space, y down;
 *  north = min y, south = max y, east = max x, west = min x.) */
function principalEdge(poly: Pt[], n: Pt): { a: Pt; b: Pt } | null {
  let best: { a: Pt; b: Pt } | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= 0) continue;
    // Skip edges parallel to the normal (they belong to the perpendicular sides).
    if (Math.abs((dx / len) * n.x + (dy / len) * n.y) > 0.5) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const score = mid.x * n.x + mid.y * n.y; // how far out in the normal dir
    if (score > bestScore) {
      bestScore = score;
      best = { a, b };
    }
  }
  return best;
}

/** Order an edge's endpoints [left, right] as seen looking at that elevation. */
function orientEdge(a: Pt, b: Pt, face: string): [Pt, Pt] {
  const swap = (): [Pt, Pt] => [b, a];
  switch (face) {
    case "north": // viewer's right = +x  → left = min x
      return a.x <= b.x ? [a, b] : swap();
    case "south": // viewer's right = −x  → left = max x
      return a.x >= b.x ? [a, b] : swap();
    case "east": // left = min y
      return a.y <= b.y ? [a, b] : swap();
    default: // west: left = max y
      return a.y >= b.y ? [a, b] : swap();
  }
}

const FACES: { face: string; n: Pt; letter: Facing }[] = [
  { face: "north", n: { x: 0, y: -1 }, letter: "N" },
  { face: "south", n: { x: 0, y: 1 }, letter: "S" },
  { face: "east", n: { x: 1, y: 0 }, letter: "E" },
  { face: "west", n: { x: -1, y: 0 }, letter: "W" },
];

/**
 * Place the per-face gables on the outline. `pxPerFt` converts span/projection
 * from feet to the outline's pixel space (caller derives it from the runs).
 */
export function placeGablesFromFaces(
  perFace: Record<string, FaceReadingRaw> | null | undefined,
  outlinePx: Pt[],
  pxPerFt: number,
): PlaceResult {
  const gables: Gable[] = [];
  const notes: string[] = [];
  if (!perFace || !(pxPerFt > 0) || !Array.isArray(outlinePx) || outlinePx.length < 4) {
    return { gables, notes };
  }

  for (const { face, n, letter } of FACES) {
    const reading = perFace[face];
    if (!reading || reading.readable === false) continue;
    const read = (reading.gables ?? []).filter((g) => g && (g.span_ft ?? 0) >= 0);
    if (read.length === 0) continue;
    const edge = principalEdge(outlinePx, n);
    if (!edge) continue;
    const [L, R] = orientEdge(edge.a, edge.b, face);

    read.forEach((g, i) => {
      const t = clamp01(g.position_frac ?? (read.length === 1 ? 0.5 : (i + 0.5) / read.length));
      const base = { x: L.x + (R.x - L.x) * t, y: L.y + (R.y - L.y) * t };
      const spanFt = g.span_ft && g.span_ft > 0 ? g.span_ft : 12;
      const projecting =
        g.supported_on === "posts" ||
        g.supported_on === "beam" ||
        g.eave_condition_guess === "projecting" ||
        g.shows_projection_cue === true;
      // Face views can't give depth; use a schematic default (flagged).
      const projFt = projecting ? Math.max(3, Math.min(spanFt * 0.6, 8)) : 0;
      const name = g.id || `${face}_gable_${i + 1}`;
      gables.push({
        baseCenter: base,
        span: spanFt * pxPerFt,
        pitch: g.pitch && g.pitch > 0 ? g.pitch : 6,
        projection: projFt * pxPerFt,
        facing: letter,
        name,
        eaveCondition: projecting ? "projecting" : "flush",
        supportedOn: g.supported_on === "unknown" ? undefined : g.supported_on,
      });
      if (projecting) {
        notes.push(
          `Placed a projecting ${face} gable '${name}'${
            g.supported_on === "posts" || g.supported_on === "beam" ? ` (on ${g.supported_on})` : ""
          } at ~${(projFt).toFixed(0)} ft depth (schematic) — verify depth & position on the canvas.`,
        );
      }
    });
  }
  return { gables, notes };
}
