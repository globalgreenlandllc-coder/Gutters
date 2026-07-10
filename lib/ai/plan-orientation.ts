/**
 * plan-orientation.ts — derive the COMPASS→CANVAS mapping for a plan set from
 * its own elevation sheet titles, instead of assuming plan-north = top of the
 * sheet (which flipped every gable placement on sets drawn front-at-bottom).
 *
 * The signal: American residential sets title each elevation with BOTH the
 * house-relative word and the compass face — "FRONT/NORTH ELEVATION",
 * "RIGHT/WEST ELEVATION" — and those titles live in the PDF text layer. The
 * drafting convention (front of the house at the BOTTOM of the plan sheet,
 * right side of the house at the sheet's right) then fixes where each compass
 * direction points on the canvas:
 *   front = bottom {0,+1}   rear = top {0,-1}
 *   right = right {+1,0}    left = left {-1,0}      (PDF-pixel space, y down)
 * Every (word, compass) pair implies one rigid rotation of the compass; pairs
 * must agree (plans are top-down views — never mirrored) or we return null and
 * the caller falls back to the north-up default.
 *
 * PURE (no server-only / DOM) — node-testable.
 */

export type Pt = { x: number; y: number };
export type FaceName = "north" | "south" | "east" | "west";
export type FaceNormals = Record<FaceName, Pt>;

/** The legacy assumption: plan-north = top of the canvas. */
export const DEFAULT_FACE_NORMALS: FaceNormals = {
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
  east: { x: 1, y: 0 },
  west: { x: -1, y: 0 },
};

/** Canvas letter for a face normal (what the roof engine draws by). */
export function facingLetterOf(n: Pt): "N" | "S" | "E" | "W" {
  if (Math.abs(n.x) >= Math.abs(n.y)) return n.x >= 0 ? "E" : "W";
  return n.y >= 0 ? "S" : "N";
}

/** Quarter-turn index of a unit axis direction: up 0, right 1, down 2, left 3. */
const idxOf = (v: Pt): number => {
  if (Math.abs(v.x) >= Math.abs(v.y)) return v.x >= 0 ? 1 : 3;
  return v.y >= 0 ? 2 : 0;
};
const VEC: Pt[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/** Where each house-relative word points on the canvas (front-at-bottom). */
const WORD_NORMALS: Record<string, Pt> = {
  front: { x: 0, y: 1 },
  rear: { x: 0, y: -1 },
  back: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
};

export type PlanOrientation = {
  normals: FaceNormals;
  /** Quarter turns the compass is rotated from north-up (canvas CW). */
  rotationQuarterTurns: number;
  /** The word↔compass pairs the titles yielded, e.g. { front: "north" }. */
  pairs: Record<string, FaceName>;
  note: string;
};

const PAIR_RE =
  /\b(FRONT|REAR|BACK|LEFT|RIGHT)\s*[\/\-]\s*(NORTH|SOUTH|EAST|WEST)\s+ELEV/gi;
const PAIR_RE_REV =
  /\b(NORTH|SOUTH|EAST|WEST)\s*[\/\-]\s*(FRONT|REAR|BACK|LEFT|RIGHT)\s+ELEV/gi;
// A bare title without the ELEVATION word — the per-face reads echo titles
// verbatim, so require only the word/compass pair itself.
const TITLE_RE = /\b(FRONT|REAR|BACK|LEFT|RIGHT)\s*[\/\-]\s*(NORTH|SOUTH|EAST|WEST)\b/i;
const TITLE_RE_REV = /\b(NORTH|SOUTH|EAST|WEST)\s*[\/\-]\s*(FRONT|REAR|BACK|LEFT|RIGHT)\b/i;

/** Resolve collected word↔compass pairs into normals — every pair implies one
 *  rigid compass rotation; all must agree (a top-down plan is never mirrored). */
function resolveFromPairs(pairs: Record<string, FaceName>): PlanOrientation | null {
  const entries = Object.entries(pairs);
  if (entries.length === 0) return null;
  let rot: number | null = null;
  for (const [word, compass] of entries) {
    const r = (idxOf(WORD_NORMALS[word]) - idxOf(DEFAULT_FACE_NORMALS[compass]) + 4) % 4;
    if (rot === null) rot = r;
    else if (rot !== r) return null; // inconsistent titles — don't guess
  }
  if (rot === null) return null;

  const normals = Object.fromEntries(
    (Object.keys(DEFAULT_FACE_NORMALS) as FaceName[]).map((face) => [
      face,
      VEC[(idxOf(DEFAULT_FACE_NORMALS[face]) + rot) % 4],
    ]),
  ) as FaceNormals;

  const pairStr = entries.map(([w, c]) => `${w}=${c}`).join(", ");
  return {
    normals,
    rotationQuarterTurns: rot,
    pairs,
    note:
      rot === 0
        ? `Plan orientation confirmed from elevation titles (${pairStr}): plan-north is up.`
        : `Plan orientation from elevation titles (${pairStr}): plan-north points ${
            ["up", "right", "down", "left"][idxOf(normals.north)]
          } on the sheet (front-at-bottom convention) — gables placed accordingly.`,
  };
}

/**
 * Derive the compass→canvas normals from the plan set's page text. Returns
 * null when no titled pairs exist or the pairs disagree (caller keeps the
 * north-up default). NB many sets draw titles as glyph OUTLINES (no text
 * layer) — the per-face `sheet_title` echo below is the robust source.
 */
export function deriveOrientation(
  pageTexts: { page: number; text: string }[],
): PlanOrientation | null {
  const pairs: Record<string, FaceName> = {};
  const add = (wordRaw: string, compassRaw: string): boolean => {
    const word = wordRaw.toLowerCase() === "back" ? "rear" : wordRaw.toLowerCase();
    const compass = compassRaw.toLowerCase() as FaceName;
    if (pairs[word] && pairs[word] !== compass) return false; // conflicting titles
    pairs[word] = compass;
    return true;
  };
  for (const { text } of pageTexts ?? []) {
    if (!text) continue;
    for (const m of text.matchAll(PAIR_RE)) if (!add(m[1], m[2])) return null;
    for (const m of text.matchAll(PAIR_RE_REV)) if (!add(m[2], m[1])) return null;
  }
  return resolveFromPairs(pairs);
}

/**
 * Derive orientation from the per-face elevation reads' `sheet_title` echoes
 * (analysisJson._perFace.per_face) — the model reads the printed title even
 * when it's drawn as glyph outlines with no text layer. A title whose compass
 * doesn't match the face it was recorded under is skipped (the model may have
 * echoed the neighbouring elevation on a two-per-sheet page).
 */
export function deriveOrientationFromFaceTitles(
  perFace: Record<string, { sheet_title?: string | null } | undefined> | null | undefined,
): PlanOrientation | null {
  if (!perFace) return null;
  const pairs: Record<string, FaceName> = {};
  for (const face of Object.keys(DEFAULT_FACE_NORMALS) as FaceName[]) {
    const title = perFace[face]?.sheet_title;
    if (!title) continue;
    const m = TITLE_RE.exec(title);
    const mr = m ? null : TITLE_RE_REV.exec(title);
    const wordRaw = m ? m[1] : mr ? mr[2] : null;
    const compassRaw = m ? m[2] : mr ? mr[1] : null;
    if (!wordRaw || !compassRaw) continue;
    const compass = compassRaw.toLowerCase() as FaceName;
    if (compass !== face) continue; // echoed a different elevation — distrust
    const word = wordRaw.toLowerCase() === "back" ? "rear" : wordRaw.toLowerCase();
    if (pairs[word] && pairs[word] !== compass) return null; // conflicting titles
    pairs[word] = compass;
  }
  return resolveFromPairs(pairs);
}

/**
 * House-relative side (front/back/left/right) of a perimeter EDGE, from pure
 * geometry: the edge's outward normal (away from the footprint interior),
 * snapped to its dominant axis under the same front-at-bottom drafting
 * convention the rest of this module encodes (front = bottom of the sheet,
 * canvas y down). This is how the orientation chips get their sides in engine
 * mode — the AI's per-run `side` tags proved swappable (front↔back), while the
 * footprint polygon itself cannot lie about which way an edge faces.
 *
 * Returns null for degenerate edges or footprints (< 3 points).
 */
export function sideOfPerimeterEdge(
  p1: Pt,
  p2: Pt,
  footprint: readonly Pt[],
): "front" | "back" | "left" | "right" | null {
  if (!footprint || footprint.length < 3) return null;
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (!Number.isFinite(len) || len < 1e-6) return null;
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  let nx = -(p2.y - p1.y) / len;
  let ny = (p2.x - p1.x) / len;
  // Orient the normal OUTWARD: probe a point a small step along the normal;
  // if it lands inside the polygon, flip. Probe distance scales with the
  // footprint so tiny jog edges on large plans still probe past the wall line.
  const xs = footprint.map((p) => p.x);
  const ys = footprint.map((p) => p.y);
  const span = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  );
  const probe = Math.max(span * 0.005, 1e-3);
  if (pointInPolygon({ x: mx + nx * probe, y: my + ny * probe }, footprint)) {
    nx = -nx;
    ny = -ny;
  }
  // Dominant axis → house word. Canvas y grows DOWN, so +y = sheet bottom =
  // FRONT under the drafting convention (see WORD_NORMALS above).
  if (Math.abs(ny) >= Math.abs(nx)) return ny >= 0 ? "front" : "back";
  return nx >= 0 ? "right" : "left";
}

/** Standard ray-cast point-in-polygon (exported for tests). */
export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
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
