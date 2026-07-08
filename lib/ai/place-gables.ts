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

import type { Gable } from "../roof-engine";
import type { FaceReadingRaw, FaceGableRead, FaceProjection } from "./face-merge";
import type { RoofMassArea } from "./to-masses";
import type { Pt } from "../roof-skeleton";
import { DEFAULT_FACE_NORMALS, facingLetterOf, type FaceNormals } from "./plan-orientation";

export type PlaceResult = { gables: Gable[]; notes: string[] };

export type PlaceOptions = {
  /** Per-mass roof areas from the plan's roof schedule. When a projecting
   *  gable matches one by kind, its DEPTH = area ÷ span (LAW 2 — depth from the
   *  plan, not the face view). */
  roofMasses?: RoofMassArea[] | null;
  /** Compass→canvas outward normals derived from the plan's own elevation
   *  titles (plan-orientation.ts). Without it the legacy north-up assumption
   *  applies — wrong for sets drawn front-at-bottom with front≠south. */
  faceNormals?: FaceNormals | null;
};

/** entry porches roof-share the "porch" schedule label. */
function normalizeKind(kind: FaceGableRead["kind"]): string {
  return kind === "entry" ? "porch" : kind;
}

const plausibleDepth = (d: number): boolean => d >= 2 && d <= 40;

/**
 * Resolve a projecting gable's DEPTH in feet by the two-angle rule:
 *  1. PRIMARY — the PERPENDICULAR side elevation, which sees this pop-out in
 *     profile and can measure how far it projects (matched to it by kind).
 *  2. CROSS-CHECK / fallback — the plan's stated roof area ÷ span.
 *  3. Last resort — a schematic default.
 * When the two independent sources disagree materially, it returns a note.
 */
function resolveDepthFt(
  g: FaceGableRead,
  spanFt: number,
  roofMasses: RoofMassArea[] | null | undefined,
  perpProjections: FaceProjection[],
): { depthFt: number; source: string; note?: string } {
  const kind = normalizeKind(g.kind);

  // 1. Depth from the perpendicular elevation (panel 2), matched by kind.
  const perp = perpProjections.find(
    (p) => normalizeKind(p.kind) === kind && typeof p.depth_ft === "number" && plausibleDepth(p.depth_ft),
  );
  const perpDepth = perp ? (perp.depth_ft as number) : null;

  // 2. Depth from the stated roof area ÷ span.
  let areaDepth: number | null = null;
  let areaMass: RoofMassArea | undefined;
  if (roofMasses && roofMasses.length && spanFt > 0 && kind !== "main" && kind !== "other") {
    areaMass = roofMasses.find((m) => m.label === kind);
    if (areaMass) {
      const d = areaMass.areaFt2 / spanFt;
      if (plausibleDepth(d)) areaDepth = d;
    }
  }

  if (perpDepth != null) {
    const note =
      areaDepth != null && Math.abs(perpDepth - areaDepth) / perpDepth > 0.35
        ? `depth ${perpDepth.toFixed(0)} ft from the side elevation vs ${areaDepth.toFixed(0)} ft from roof-area÷span — verify`
        : undefined;
    return { depthFt: perpDepth, source: "side (perpendicular) elevation", note };
  }
  if (areaDepth != null && areaMass) {
    return { depthFt: areaDepth, source: `${kind} roof area ${areaMass.areaFt2} sf ÷ ${spanFt.toFixed(0)} ft span` };
  }
  return { depthFt: Math.max(3, Math.min(spanFt * 0.6, 8)), source: "schematic default" };
}

/** The two faces perpendicular to a given face (where its pop-outs' depth is
 *  visible in profile). */
const PERP: Record<string, string[]> = {
  north: ["east", "west"],
  south: ["east", "west"],
  east: ["north", "south"],
  west: ["north", "south"],
};

const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));

/** The viewer's LEFT→RIGHT direction for a face with outward normal `n`
 *  (y-down canvas): the viewer stands outside looking along −n, so their right
 *  hand points along n rotated a quarter turn — rightDir = (n.y, −n.x).
 *  Check (default north, n={0,−1}): the viewer stands north of the house
 *  facing south; their left hand points EAST (+x), so u must DECREASE with x —
 *  rightDir = {−1,0}. ✓  (The old per-face switch had all four faces mirrored:
 *  a north gable read at position_frac 0 — the drawing's far LEFT, the house's
 *  EAST end — landed on the WEST end.) */
const rightDirOf = (n: Pt): Pt => ({ x: n.y, y: -n.x });

/** Along-face scalar that increases to the viewer's RIGHT. Lets multiple
 *  sub-edges of one face be ordered and addressed on a common axis. */
function faceU(p: Pt, rightDir: Pt): number {
  return p.x * rightDir.x + p.y * rightDir.y;
}

type FaceEdge = { L: Pt; R: Pt; uL: number; uR: number; out: number };

/**
 * EVERY outline edge on a given side — not just the furthest-out one. An edge
 * qualifies when it runs roughly ALONG the face (perpendicular to the outward
 * normal `n`) AND sits in the outward half of the footprint — so a recessed /
 * projecting JOG sub-edge still counts, but the opposite back edge doesn't.
 * Returned oriented [L,R] in the viewer's left→right order, tagged with each
 * edge's along-face u-range and how far out it sits. This is what lets a gable
 * read at a `position_frac` land on the correct jog instead of being squeezed
 * onto one principal edge (the cause of missing gables on articulated fronts).
 * A face with a single straight edge yields one FaceEdge → identical to before.
 */
function faceEdges(poly: Pt[], n: Pt): FaceEdge[] {
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p.x;
    cy += p.y;
  }
  cx /= poly.length;
  cy /= poly.length;
  const centroidProj = cx * n.x + cy * n.y;
  const rd = rightDirOf(n);
  const edges: FaceEdge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= 0) continue;
    // Skip edges running ALONG the normal (they belong to the perpendicular sides).
    if (Math.abs((dx / len) * n.x + (dy / len) * n.y) > 0.5) continue;
    const out = ((a.x + b.x) / 2) * n.x + ((a.y + b.y) / 2) * n.y;
    if (out < centroidProj) continue; // an edge on the opposite (back) half
    const [L, R] = orientEdge(a, b, rd);
    edges.push({ L, R, uL: faceU(L, rd), uR: faceU(R, rd), out });
  }
  edges.sort((e1, e2) => e1.uL - e2.uL);
  return edges;
}

/** The outline point at along-face position `u`. Which DEPTH plane it lands on
 *  depends on what's being placed:
 *  - "outer": a PROJECTING gable (porch/patio on posts, a pop-out) rides the
 *    outermost sub-edge covering `u` — its own forward eave.
 *  - "inner": a FLUSH gable sits ON THE HOUSE WALL — the face's DOMINANT wall
 *    plane (the depth carrying the most sub-edge length), extrapolated across
 *    any pop-out that interrupts the wall in front of it. Picking outermost
 *    here parked flush wall gables (e.g. a great-room gable) on a porch's
 *    outer eave standing in front of them — wrong plane.
 *  Falls back to the nearest sub-edge when `u` lands in a gap. */
function pointAtU(edges: FaceEdge[], u: number, prefer: "outer" | "inner" = "outer", eps = 1e-6): Pt {
  if (prefer === "inner" && edges.length > 1) {
    // Dominant wall plane: group sub-edges by depth (out) and take the group
    // with the greatest total length — that's the house wall, not a pop-out.
    const outs = edges.map((e) => e.out);
    const tol = Math.max(2, (Math.max(...outs) - Math.min(...outs)) * 0.1);
    let wall: FaceEdge[] = [];
    let wallLen = -1;
    for (const e of edges) {
      const grp = edges.filter((o) => Math.abs(o.out - e.out) <= tol);
      const len = grp.reduce((s, o) => s + Math.abs(o.uR - o.uL), 0);
      if (len > wallLen) { wallLen = len; wall = grp; }
    }
    // Interpolate on the wall sub-edge covering u, else EXTRAPOLATE along the
    // wall plane (the wall line continues behind an interrupting pop-out).
    const cover = wall.find((e) => u >= Math.min(e.uL, e.uR) - eps && u <= Math.max(e.uL, e.uR) + eps);
    const ref = cover ?? wall.reduce((a, b) => (Math.abs(a.uR - a.uL) >= Math.abs(b.uR - b.uL) ? a : b));
    const denom = ref.uR - ref.uL;
    const s = denom !== 0 ? (u - ref.uL) / denom : 0; // unclamped ⇒ extrapolates
    return { x: ref.L.x + (ref.R.x - ref.L.x) * s, y: ref.L.y + (ref.R.y - ref.L.y) * s };
  }
  const covers = edges.filter(
    (e) => u >= Math.min(e.uL, e.uR) - eps && u <= Math.max(e.uL, e.uR) + eps,
  );
  const pool = covers.length ? covers : edges;
  let pick = pool[0];
  for (const e of pool) {
    if (covers.length) {
      if (e.out > pick.out) pick = e; // outermost among covering sub-edges
    } else {
      const d = Math.min(Math.abs(u - e.uL), Math.abs(u - e.uR));
      const dp = Math.min(Math.abs(u - pick.uL), Math.abs(u - pick.uR));
      if (d < dp) pick = e; // nearest sub-edge when u sits in a gap
    }
  }
  const denom = pick.uR - pick.uL;
  const s = denom !== 0 ? clamp01((u - pick.uL) / denom) : 0;
  return { x: pick.L.x + (pick.R.x - pick.L.x) * s, y: pick.L.y + (pick.R.y - pick.L.y) * s };
}

/** Order an edge's endpoints [left, right] as seen looking at that elevation
 *  (u increasing along the viewer's rightDir). */
function orientEdge(a: Pt, b: Pt, rightDir: Pt): [Pt, Pt] {
  return faceU(a, rightDir) <= faceU(b, rightDir) ? [a, b] : [b, a];
}

const FACE_NAMES = ["north", "south", "east", "west"] as const;

/**
 * Place the per-face gables on the outline. `pxPerFt` converts span/projection
 * from feet to the outline's pixel space (caller derives it from the runs).
 */
export function placeGablesFromFaces(
  perFace: Record<string, FaceReadingRaw> | null | undefined,
  outlinePx: Pt[],
  pxPerFt: number,
  options?: PlaceOptions,
): PlaceResult {
  const gables: Gable[] = [];
  const notes: string[] = [];
  if (!perFace || !(pxPerFt > 0) || !Array.isArray(outlinePx) || outlinePx.length < 4) {
    return { gables, notes };
  }

  for (const face of FACE_NAMES) {
    const n = options?.faceNormals?.[face] ?? DEFAULT_FACE_NORMALS[face];
    // The engine draws by CANVAS letter — under a derived orientation the
    // compass-north gable projects wherever north points on this sheet.
    const letter = facingLetterOf(n);
    const reading = perFace[face];
    if (!reading || reading.readable === false) continue;
    const read = (reading.gables ?? []).filter((g) => g && (g.span_ft ?? 0) >= 0);
    if (read.length === 0) continue;
    // ALL sub-edges on this side (incl. jogs), left→right — so each gable lands
    // on the sub-edge its position_frac maps to across the full face width.
    const edges = faceEdges(outlinePx, n);
    if (edges.length === 0) continue;
    const uMin = Math.min(...edges.map((e) => e.uL));
    const uMax = Math.max(...edges.map((e) => e.uR));
    const uSpan = uMax - uMin;

    // Depth of a pop-out on THIS face is measured on the PERPENDICULAR faces.
    const perpProjections: FaceProjection[] = (PERP[face] ?? []).flatMap((pf) =>
      perFace[pf]?.readable !== false ? perFace[pf]?.projections ?? [] : [],
    );

    read.forEach((g, i) => {
      const t = clamp01(g.position_frac ?? (read.length === 1 ? 0.5 : (i + 0.5) / read.length));
      const spanFt = g.span_ft && g.span_ft > 0 ? g.span_ft : 12;
      const projecting =
        g.supported_on === "posts" ||
        g.supported_on === "beam" ||
        g.eave_condition_guess === "projecting" ||
        g.shows_projection_cue === true;
      // Depth plane: a projecting gable rides the outermost sub-edge (its own
      // pop-out eave); a FLUSH gable sits on the house WALL (innermost) — never
      // on a porch pop-out that happens to stand in front of it.
      const base = pointAtU(edges, uMin + t * uSpan, projecting ? "outer" : "inner");
      // Depth by the two-angle rule: perpendicular elevation, then roof area ÷
      // span, then schematic.
      const { depthFt, source, note } = projecting
        ? resolveDepthFt(g, spanFt, options?.roofMasses, perpProjections)
        : { depthFt: 0, source: "", note: undefined };
      const name = g.id || `${face}_gable_${i + 1}`;
      // Set-back / dormer (Case 2): base reads above the eave line ⇒ it sits this
      // far behind the eave. The eave stays guttered in front; treat as a dormer.
      const setbackFt = g.set_back_ft && g.set_back_ft > 0 ? g.set_back_ft : 0;
      gables.push({
        baseCenter: base,
        span: spanFt * pxPerFt,
        pitch: g.pitch && g.pitch > 0 ? g.pitch : 6,
        projection: depthFt * pxPerFt,
        facing: letter,
        name,
        eaveCondition: projecting ? "projecting" : setbackFt > 0 ? "roof_mounted" : "flush",
        supportedOn: g.supported_on === "unknown" ? undefined : g.supported_on,
        ...(setbackFt > 0 ? { setbackFt: setbackFt * pxPerFt } : {}),
      });
      if (projecting) {
        const verify = source === "schematic default" ? " (schematic) — verify depth & position" : " — verify position";
        notes.push(
          `Placed a projecting ${face} gable '${name}'${
            g.supported_on === "posts" || g.supported_on === "beam" ? ` (on ${g.supported_on})` : ""
          } at ~${depthFt.toFixed(0)} ft depth from ${source}${verify}.`,
        );
        if (note) notes.push(`⚠ ${name}: ${note}`);
      }
    });
  }
  return { gables, notes };
}
