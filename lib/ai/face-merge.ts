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
  /** SET-BACK / dormer signal (Case 2): how far the gable base sits BEHIND the
   *  eave, read from how far its base rises ABOVE the eave line in this elevation
   *  (at eave level ⇒ 0). Drives Gable.setbackFt so the engine draws it as a
   *  dormer — the eave keeps its gutter in front, the gable rises behind it.
   *  Optional; absent/0 ⇒ a normal at-the-eave gable. */
  set_back_ft?: number | null;
  /** Decisive gutter signal on STEPPED faces where no single continuous eave
   *  line exists: true when a horizontal eave/gutter line — at ANY height,
   *  even a lower tier — runs across IN FRONT of / below this gable's base.
   *  The gable then rises BEHIND a guttered roof edge (frame-over): it must
   *  not consume a wall, and the wall under it keeps its gutter. */
  eave_passes_in_front?: boolean | null;
  /** Hip DISCRIMINATOR: true when this shape's bottom is actually a horizontal
   *  eave (a hip end), i.e. the reader concluded on a second look it's a hip,
   *  not a gable. A hip end carries a gutter — the reconcile must NOT promote
   *  its wall to a rake. Optional; absent/false ⇒ treated as a real gable. */
  is_hip_end?: boolean | null;
  notes: string;
};

/** A mass this elevation sees IN PROFILE (sticking out across the view) with its
 *  measurable DEPTH — the perpendicular view's job (LAW 2). A side elevation
 *  reports front/rear pop-outs here; a front/rear elevation reports side ones.
 *  Matched to a gable on the perpendicular face by `kind`. */
export type FaceProjection = {
  kind: FaceGableRead["kind"];
  depth_ft: number | null;
  notes: string;
};

export type FaceReadingRaw = {
  face: ElevationFaceName;
  /** The elevation's printed title exactly as it appears ("FRONT/NORTH
   *  ELEVATION") — pairs the compass face with the house-relative word, which
   *  anchors the plan's compass orientation (see plan-orientation.ts). */
  sheet_title?: string | null;
  readable: boolean;
  unreadable_reason: string | null;
  /** Roof form on this face: 'hipped' = every edge is a horizontal eave (zero
   *  gables), 'gabled' = has true gable ends, 'mixed', 'unknown'. A 'hipped'
   *  face is gutter-PROTECTIVE — the reconcile keeps its perimeter eaves and
   *  vetoes a phantom gable→rake promotion on it. Optional (older reads omit). */
  roof_form?: "hipped" | "gabled" | "mixed" | "unknown" | null;
  gable_count: number | null;
  continuous_eave: boolean;
  gables: FaceGableRead[];
  /** Pop-outs seen IN PROFILE from this view, with depth (see FaceProjection). */
  projections: FaceProjection[];
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

/** Pop-out kinds that represent a footprint JOG — an offset mass with its own
 *  walls (garage wing, porch, patio, entry), as opposed to a roof-mounted dormer
 *  or the main body. When one of these appears on ONE elevation but not its
 *  opposite, the house is articulated on that side only. */
const JOG_KINDS = new Set(["garage", "porch", "patio", "entry"]);
const normKind = (k: string): string => (k === "entry" ? "porch" : k);

/** The jog-mass kinds this face attributes to an offset mass, from BOTH its own
 *  gable reads and the masses it sees in profile (`projections`). A side
 *  elevation reports front/rear jogs it sees end-on; a front/rear elevation
 *  reports the side jogs. */
function jogKindsOf(r: FaceReadingRaw | undefined): Set<string> {
  const out = new Set<string>();
  if (!r || !r.readable) return out;
  for (const g of r.gables ?? []) if (JOG_KINDS.has(g.kind)) out.add(normKind(g.kind));
  for (const p of r.projections ?? []) if (JOG_KINDS.has(p.kind)) out.add(normKind(p.kind));
  return out;
}

/** Offset jogs the elevations prove: a garage/porch/patio one face shows
 *  that its OPPOSITE face lacks. Shared by mergeFaceReadings (flags) and
 *  the edge reconcile (footprint step cross-check). */
export function detectAsymmetricJogs(
  perFace: Partial<Record<string, FaceReadingRaw | undefined>>,
): { face: string; opp: string; axis: string; kind: string }[] {
  const out: { face: string; opp: string; axis: string; kind: string }[] = [];
  const asymPairs: [string, string, string][] = [
    ["east", "west", "left↔right"],
    ["west", "east", "left↔right"],
    ["north", "south", "front↔rear"],
    ["south", "north", "front↔rear"],
  ];
  for (const [f, opp, axis] of asymPairs) {
    const a = perFace[f];
    const b = perFace[opp];
    if (!a?.readable || !b?.readable) continue; // need BOTH sides to call it asymmetric
    const has = jogKindsOf(a);
    const oppHas = jogKindsOf(b);
    for (const kind of has) {
      if (!oppHas.has(kind)) out.push({ face: f, opp, axis, kind });
    }
  }
  return out;
}

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

  // ASYMMETRIC-JOG detection (Stage 3). A garage/porch/patio that a face sees
  // (as a gable-end or a profile projection) but its OPPOSITE face does NOT is
  // an OFFSET jog — the left↔right (or front↔rear) articulation the freehand
  // trace flattens and a single face view can't catch. The classic case is an
  // asymmetric garage wing: the east side sees it end-on, the west side is a
  // plain wall. Flag it so the footprint carries the jog on the correct side
  // only, instead of a mirrored (or dropped) mass. Ordered pairs, so a jog
  // unique to each side is reported once from the side that has it.
  for (const j of detectAsymmetricJogs(per_face)) {
    flags.push(
      `ASYMMETRIC (${j.axis}): the ${j.face} elevation shows a ${j.kind} but the ${j.opp} does not — an OFFSET ${j.kind} jog, not a symmetric/mirrored mass. Carry the jog on the ${j.face} side of the footprint only.`,
    );
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
