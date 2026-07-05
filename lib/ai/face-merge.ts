/**
 * face-merge.ts — the PURE, deterministic merge of independent per-face
 * elevation reads (Correction 1). Split out of read-elevations.ts (which is
 * `server-only` because it makes model calls) so this logic runs under
 * `node --test` with no server/DB/AI dependency — mirrors reconcile-eaves.ts.
 *
 * It enforces `symmetry_assumed:false`, lists unreadable / missing faces,
 * contrasts opposite faces WITHOUT mirroring them, and turns every projection
 * cue into a confirm-before-guttering flag (defaulting to flush — no gutter
 * added on a guess).
 */

export type ElevationFaceName =
  | "north"
  | "south"
  | "east"
  | "west"
  | "front"
  | "rear"
  | "left"
  | "right";

export type FaceGableRead = {
  id: string;
  /** What this gable roofs, from any label on the elevation ("COV'D PORCH",
   *  "PATIO", entry). Used to match the gable to its stated roof-area (so its
   *  projection DEPTH = roof area ÷ span). "other" when unlabelled. */
  kind: "porch" | "patio" | "entry" | "garage" | "dormer" | "main" | "other";
  span_ft: number | null;
  pitch: number | null;
  /** Horizontal position of the gable's CENTER along this face as you look at
   *  the elevation: 0 = far left, 0.5 = center, 1 = far right. Lets the engine
   *  place the gable on the roof-plan outline. Null when not localized. */
  position_frac: number | null;
  /** The model's best guess; DEFAULTS to flush — a single elevation can't prove
   *  a projection (Correction 2). */
  eave_condition_guess: "projecting" | "roof_mounted" | "flush" | "unknown";
  supported_on: "wall" | "posts" | "beam" | "unknown";
  /** A positive depth cue visible ON THIS face (a "roof beyond" line, a porch at
   *  a different plane, posts/beam under an entry gable). Not a confirmation. */
  shows_projection_cue: boolean;
  notes: string;
};

export type FaceReadingRaw = {
  face: ElevationFaceName;
  readable: boolean;
  unreadable_reason: string | null;
  gable_count: number | null;
  continuous_eave: boolean;
  gables: FaceGableRead[];
  projection_cues: string[];
  confidence: "high" | "medium" | "low";
};

export type MergedFaces = {
  per_face: Record<string, FaceReadingRaw>;
  /** Always false — the whole point of reading faces independently. */
  symmetry_assumed: false;
  elevation_unreadable: string[];
  review_flags: string[];
};

/** Opposite faces — used to phrase the "read independently, not mirrored" note. */
const OPPOSITE: Record<string, string> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  front: "rear",
  rear: "front",
  left: "right",
  right: "left",
};

export function mergeFaceReadings(reads: FaceReadingRaw[], expectedFaces: string[]): MergedFaces {
  const per_face: Record<string, FaceReadingRaw> = {};
  for (const r of reads) per_face[r.face] = r;

  const elevation_unreadable: string[] = [];
  const flags: string[] = [];

  // Coverage summary FIRST so the takeoff shows which of the four faces were
  // actually read on their own (a page often holds two elevations, so a naive
  // one-side-per-page read silently skips two faces).
  const readList = reads.filter((r) => r.readable);
  flags.push(
    `4-face check — read independently (no mirroring): ${
      readList.length
        ? readList.map((r) => `${r.face} ${r.gable_count ?? "?"} gable(s)`).join(", ")
        : "none"
    }.`,
  );

  // Expected-but-missing faces + faces read as unreadable.
  for (const f of expectedFaces) {
    const r = per_face[f];
    if (!r) {
      elevation_unreadable.push(f);
      flags.push(`${f} elevation not read on its own — a sheet may hold two elevations and only one side was picked; that face's eaves/projections were NOT independently verified. Check the ${f} face.`);
    } else if (!r.readable) {
      elevation_unreadable.push(f);
      flags.push(`elevation_unreadable: ${f} — ${r.unreadable_reason ?? "too low-res"}; projections needing this view are unconfirmed (not added).`);
    }
  }

  // Opposite-face contrast (Corrections 1 & 3): report both counts, never mirror.
  const done = new Set<string>();
  for (const f of Object.keys(per_face)) {
    const opp = OPPOSITE[f];
    if (!opp || done.has(f) || done.has(opp)) continue;
    const a = per_face[f];
    const b = per_face[opp];
    if (a?.readable && b?.readable && a.gable_count != null && b.gable_count != null) {
      done.add(f);
      done.add(opp);
      if (a.gable_count !== b.gable_count) {
        flags.push(`Independent read: ${f} shows ${a.gable_count} gable(s), ${opp} shows ${b.gable_count} — read separately, NOT mirrored. Verify each face.`);
      }
    }
  }

  // Projection cues → confirm-before-guttering flag (default flush).
  for (const r of reads) {
    if (!r.readable) continue;
    const cued = (r.gables ?? []).filter((g) => g.shows_projection_cue || g.eave_condition_guess === "projecting");
    for (const g of cued) {
      const perp = OPPOSITE[r.face] ? `${OPPOSITE[r.face]}/side` : "side";
      const carry = g.supported_on === "posts" || g.supported_on === "beam" ? ` (on ${g.supported_on} — likely a projecting porch)` : "";
      flags.push(`Gable '${g.id}' on the ${r.face} elevation shows a projection cue${carry} — confirm its depth from the ${perp} elevation or roof plan before adding side-eave gutter. Defaulted to FLUSH (no gutter added).`);
    }
  }

  return { per_face, symmetry_assumed: false, elevation_unreadable, review_flags: flags };
}
