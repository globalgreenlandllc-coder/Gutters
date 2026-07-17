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
  /** For porch/patio/entry covers: the cover's OWN roof form, read off the
   *  elevation — decides which of the cover's edges carry gutter
   *  (front_gabled = side returns; hipped = wraps 3 sides; shed = low edge
   *  only). Optional; absent on non-cover gables and older reads. */
  cover_form?: "front_gabled" | "hipped" | "shed" | "unknown" | null;
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

/** One BREAK in the eave/fascia line as read on an elevation, scanning the
 *  face viewer-LEFT→RIGHT (owner doctrine: gutters hang on the ROOF edge, and
 *  the eave-line profile is where every roof jog/tier step shows FIRST —
 *  before the roof plan, and always before a wall/footprint jog). */
export type FaceEaveStep = {
  /** Where along the face the eave line breaks: 0 = far left, 1 = far right,
   *  in the VIEWER's frame as you look at this elevation. Null when the model
   *  saw a break but couldn't localize it. */
  position_frac: number | null;
  /** Height change scanning left→right at the break: "down" = the eave drops
   *  to a lower plane, "up" = it rises. Null on a defensive parse of garbage. */
  direction: "up" | "down" | null;
  /** Vertical fascia offset in FEET, only when a printed dimension / plate
   *  line makes it readable. NEVER used to size plan geometry (it's vertical). */
  offset_ft: number | null;
  /** What the break is: a full tier change, a same-tier fascia jog, or unknown. */
  kind?: "tier_drop" | "fascia_jog" | "unknown";
  notes?: string;
};

/** A mass this elevation sees IN PROFILE (sticking out across the view) with its
 *  measurable DEPTH — the perpendicular view's job (LAW 2). A side elevation
 *  reports front/rear pop-outs here; a front/rear elevation reports side ones.
 *  Matched to a gable on the perpendicular face by `kind`. */
export type FaceProjection = {
  kind: FaceGableRead["kind"];
  depth_ft: number | null;
  /** Where along this face the profiled mass sits, in the VIEWER's frame as
   *  you look at the elevation (left_end / center / right_end). Two
   *  perpendicular faces agreeing pin the mass's plan corner — the
   *  tier-corner veto's input (lib/ai/tier-corner-veto.ts). Optional; absent
   *  on older reads. */
  position?: "left_end" | "center" | "right_end" | "unknown" | null;
  /** true when the mass's eave line reads clearly LOWER than the main eave
   *  (a dropped single-story cover — the strongest lower-tier signal).
   *  Optional; absent on older reads, null when unclear. */
  eave_below_main?: boolean | null;
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
  /** EVERY break in this face's eave/fascia line, viewer left→right (see
   *  FaceEaveStep). [] = one unbroken eave plane across the whole face — an
   *  explicit, load-bearing answer. ABSENT (older reads / stale prompt
   *  overrides) = "not read": every eave-step consumer must degrade to
   *  byte-identical legacy behavior when the key is missing. */
  eave_steps?: FaceEaveStep[] | null;
  /** Pop-outs seen IN PROFILE from this view, with depth (see FaceProjection). */
  projections: FaceProjection[];
  projection_cues: string[];
  /** Above-grade floor levels of WALL this elevation shows (1/2/3). Drives the
   *  downspout drop-height default (a 1-story plan must not price 2-story
   *  drops). Optional (older reads omit) — null when unclear. */
  stories_visible?: number | null;
  confidence: "high" | "medium" | "low";
};

/**
 * UNANIMOUS HIP: every readable face reads a continuous eave with ZERO gables
 * (≥3 readable faces so a partial read can't force it). Key-agnostic — works
 * for compass OR house-relative perFace keys. On a unanimously hipped home the
 * elevations are the gable budget: every exterior wall carries an eave, so a
 * "rake" mark on the plan-view trace is a mis-tagged hip/ridge stroke and an
 * unclassified wall is a missed eave, not a possible gable end. Shared by the
 * engine draw (suppresses phantom gable wings) and the perimeter closure
 * (prices unclassified walls on raster plans).
 */
export function isUnanimousHip(
  perFace:
    | Partial<Record<string, FaceReadingRaw | undefined>>
    | null
    | undefined,
): boolean {
  return explainUnanimousHip(perFace).unanimous;
}

/**
 * isUnanimousHip with the REASON it failed — so a skipped hip closure is a
 * diagnosis on the takeoff panel, not a silent no-op.
 *
 * What counts as gable evidence (and what deliberately does NOT):
 * - a `gables[]` entry with `is_hip_end:true` is NOT a gable — it's a hip the
 *   reader recorded through the gable channel on a second look;
 * - `gable_count` is discounted by the hip-end entries visible in the array
 *   (a truncated array can't hide a real gable behind the discount);
 * - `continuous_eave:false` does NOT veto: a stepped multi-tier hip
 *   (clerestory prairie roofs — the 1168G BIDSET) honestly reads a broken
 *   eave line while still having zero gables and an eave on every wall;
 * - `roof_form` "gabled"/"mixed" DOES veto even with an empty gables array —
 *   a contradictory read stays conservative.
 */
export function explainUnanimousHip(
  perFace:
    | Partial<Record<string, FaceReadingRaw | undefined>>
    | null
    | undefined,
): { unanimous: boolean; reason: string | null } {
  if (!perFace) {
    return { unanimous: false, reason: "no per-face elevation reads stored" };
  }
  const readable = Object.entries(perFace).filter(
    (e): e is [string, FaceReadingRaw] => !!e[1] && e[1].readable !== false,
  );
  if (readable.length < 3) {
    return {
      unanimous: false,
      reason: `only ${readable.length} readable elevation face(s) — need 3+ to rule out an unseen gable`,
    };
  }
  for (const [face, r] of readable) {
    if (r.roof_form === "gabled" || r.roof_form === "mixed") {
      return {
        unanimous: false,
        reason: `${face} face reads roof_form "${r.roof_form}"`,
      };
    }
    const entries = Array.isArray(r.gables) ? r.gables.filter(Boolean) : null;
    const hipEnds = entries ? entries.filter((g) => g.is_hip_end === true).length : 0;
    const listed = entries ? entries.length - hipEnds : 0;
    const counted =
      typeof r.gable_count === "number" ? Math.max(0, r.gable_count - hipEnds) : 0;
    const gableEvidence = Math.max(listed, entries ? counted : 0);
    if (gableEvidence > 0 || (!entries && typeof r.gable_count === "number" && r.gable_count > 0)) {
      return {
        unanimous: false,
        reason: `${face} face reads ${Math.max(gableEvidence, r.gable_count ?? 0)} gable(s)`,
      };
    }
  }
  return { unanimous: true, reason: null };
}

export type MergedFaces = {
  per_face: Record<string, FaceReadingRaw>;
  /** Always false — the whole point of reading faces independently. */
  symmetry_assumed: false;
  elevation_unreadable: string[];
  review_flags: string[];
};

/**
 * STORIES CONSENSUS across the four per-face reads. The old rule took the MAX
 * of stories_visible, so ONE clerestory misread ("that band is a 2nd floor")
 * outvoted three honest 1-story reads and priced 2-story drops on a rambler
 * (the 1168G STORIES=2 pill). Rule: with ≥3 non-null reads where all-but-one
 * agree, the majority value wins; otherwise fall back to the MAX of the
 * non-null reads (the conservative legacy rule); null when nothing was read.
 * Pure + deterministic.
 */
export function consensusStories(perFace: (number | null)[]): number | null {
  const vals = perFace.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 1,
  );
  if (vals.length === 0) return null;
  if (vals.length >= 3) {
    const counts = new Map<number, number>();
    for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const [v, c] of counts) {
      if (c >= vals.length - 1) return v; // all-but-one agree → majority value
    }
  }
  return Math.max(...vals);
}

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

export function mergeFaceReadings(
  reads: FaceReadingRaw[],
  expectedFaces: string[],
  /** Roof-area schedule masses when the sheet printed one — lets a
   *  projection-cue flag state the estimated side-eave LF (area ÷ span × 2)
   *  instead of a bare "no gutter added". Optional; flags stay note-only. */
  roofMasses?: readonly { label: string; areaFt2: number }[] | null,
): MergedFaces {
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

  // EAVE-STEP density flag: a face whose eave line breaks 2+ times is a
  // multi-tier boundary read — worth a human look before pricing (each break
  // is a place the gutter changes height/plane). Note-only; the deterministic
  // cross-check against the traced roof happens in eave-step-reconcile.ts.
  for (const r of reads) {
    if (!r.readable) continue;
    const steps = Array.isArray(r.eave_steps) ? r.eave_steps.filter(Boolean) : null;
    if (steps && steps.length >= 2) {
      flags.push(
        `${r.face} eave line steps ${steps.length}× — verify tier boundaries on the ${r.face} face (each break is a gutter height/plane change).`,
      );
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

  // Projection cues → confirm-before-guttering flag. Default is still flush
  // (no gutter added on a guess), but when the roof-area schedule NAMES the
  // cued porch/patio mass, the flag states the measurable side-eave LF
  // (depth = area ÷ span, two side returns) instead of a bare "no gutter" —
  // an estimate to verify, never a silent price change (the LF itself is
  // synthesized downstream from the same schedule, see projection-lf.ts).
  const massForCue = (kind: string): { label: string; areaFt2: number } | null => {
    const k = normKind(kind);
    if (!JOG_KINDS.has(kind) || k === "garage") return null; // porch/patio/entry cues only
    const wanted = kind === "entry" ? ["entry", "porch"] : [k];
    let best: { label: string; areaFt2: number } | null = null;
    for (const m of roofMasses ?? []) {
      const label = (m.label ?? "").toLowerCase();
      if (!label) continue;
      if (wanted.some((w) => label.includes(w) || w.includes(label))) {
        if (!best || m.areaFt2 > best.areaFt2) best = m;
      }
    }
    return best;
  };
  for (const r of reads) {
    if (!r.readable) continue;
    const cued = (r.gables ?? []).filter((g) => g.shows_projection_cue || g.eave_condition_guess === "projecting");
    for (const g of cued) {
      const perp = OPPOSITE[r.face] ? `${OPPOSITE[r.face]}/side` : "side";
      const carry = g.supported_on === "posts" || g.supported_on === "beam" ? ` (on ${g.supported_on} — likely a projecting porch)` : "";
      const mass = g.span_ft != null && g.span_ft >= 6 && g.span_ft <= 120 ? massForCue(g.kind) : null;
      const depthFt = mass ? mass.areaFt2 / g.span_ft! : null;
      if (mass && depthFt != null && depthFt >= 4 && depthFt <= 60) {
        flags.push(
          `Gable '${g.id}' on the ${r.face} elevation shows a projection cue${carry} — the roof schedule's ${Math.round(mass.areaFt2)} sf ÷ its ${Math.round(g.span_ft!)} ft span ≈ ${Math.round(depthFt)} ft deep, so its two side returns carry ≈${Math.round(2 * depthFt)} LF of gutter (estimated — verify). Confirm the depth from the ${perp} elevation or roof plan.`,
        );
        continue;
      }
      flags.push(`Gable '${g.id}' on the ${r.face} elevation shows a projection cue${carry} — confirm its depth from the ${perp} elevation or roof plan before adding side-eave gutter. Defaulted to FLUSH (no gutter added).`);
    }
  }

  return { per_face, symmetry_assumed: false, elevation_unreadable, review_flags: flags };
}
