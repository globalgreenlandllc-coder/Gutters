/**
 * roof-structure-view — pure selection of the roof geometry a canvas overlay
 * should draw for a stored takeoff.
 *
 * The proposal preview historically re-derived a grid skeleton client-side
 * and mixed it with the engine's stored lines: two skeletons on one canvas,
 * and the GABLE labels (stored gable ends) could sit on wedges drawn by the
 * OTHER skeleton — a hip-shaped face labeled "GABLE". When the stored
 * structure carries engine-drawn geometry (v2 blueprint rows), the overlay
 * must render THAT geometry verbatim — one source of truth, nothing
 * re-invented — so clients only ever see evidenced lines.
 *
 * Pure and framework-free so node tests can pin the selection rules.
 */

export type ViewPt = { x: number; y: number };
export type ViewLine = { id?: string; points: ViewPt[] };
export type ViewFace = { polygon: ViewPt[]; downhill: ViewPt };

export type EngineViewGeometry = {
  ridges: { points: ViewPt[] }[];
  hips: { points: ViewPt[] }[];
  valleys: { points: ViewPt[] }[];
  /** gable-end BASES (two points) — the same channel the GABLE labels use */
  gables: { points: ViewPt[] }[];
  faces: ViewFace[];
};

const hasEngineId = (lines: readonly ViewLine[] | undefined): boolean =>
  (lines ?? []).some(
    (l) => typeof l.id === "string" && l.id.startsWith("engine-"),
  );

/**
 * When the stored structure was drawn by the takeoff engine (any interior
 * line carries an `engine-*` id, or validated faces travel with it), return
 * it verbatim for the overlay. Returns null for legacy/satellite structures —
 * the caller keeps its existing client-side derivation for those.
 */
export function engineDrawnGeometry(structure: {
  ridges: ViewLine[];
  hips?: ViewLine[];
  valleys: ViewLine[];
  gables?: ViewLine[];
  faces?: ViewFace[];
}): EngineViewGeometry | null {
  const engineDrawn =
    hasEngineId(structure.ridges) ||
    hasEngineId(structure.hips) ||
    hasEngineId(structure.valleys) ||
    hasEngineId(structure.gables) ||
    (structure.faces?.length ?? 0) > 0;
  if (!engineDrawn) return null;
  const strip = (ls: readonly ViewLine[] | undefined) =>
    (ls ?? [])
      .filter((l) => l.points.length >= 2)
      .map((l) => ({ points: l.points }));
  return {
    ridges: strip(structure.ridges),
    hips: strip(structure.hips),
    valleys: strip(structure.valleys),
    // Gable label + drawn base come from the SAME entries — the label can
    // never sit on geometry another derivation invented.
    gables: (structure.gables ?? [])
      .filter((l) => l.points.length >= 2)
      .map((l) => ({ points: [l.points[0], l.points[l.points.length - 1]] })),
    faces: structure.faces ?? [],
  };
}
