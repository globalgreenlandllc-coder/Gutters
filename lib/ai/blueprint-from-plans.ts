import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getActiveApiKey } from "@/lib/api-keys";
import { getPrompt } from "./prompts";
import { buildVectorBlock, type PlanVectors } from "./pdf-vectors";
import type { GeometryConstraints, PlanClassification } from "./classify-plans";
import { geometryQualityPenalty } from "./blueprint-trace-quality";

export type BlueprintPoint = { x: number; y: number };

export type BlueprintRun = {
  id: string;
  side: "front" | "back" | "left" | "right" | "interior";
  start: BlueprintPoint;
  end: BlueprintPoint;
  length_ft: number | null;
  length_px: number;
  drains_to: string[];
  /** Which roof tier this run sits on. Single-story porch/garage
   *  sections are "lower" (~10 ft); 2-story main body is "upper"
   *  (~20 ft). Drives drop_height_ft on the downspouts that drain
   *  this run. */
  tier?: "lower" | "upper" | "unknown";
  /** What structure this run's eave belongs to, READ FROM THE PLANS
   *  (elevation/floor-plan callouts) — so the layout can name covered
   *  projections instead of showing an anonymous "lower" line. "main" =
   *  the main house body. Absent on older analyses. */
  feature?:
    | "porch"
    | "patio"
    | "deck"
    | "entry"
    | "garage"
    | "dormer"
    | "main"
    | "unknown";
};

export type BlueprintDownspout = {
  id: string;
  at: BlueprintPoint;
  from_gutter: string;
  drop_direction: "front" | "back" | "left" | "right";
  reason: "outside_corner" | "long_run_relief" | "valley_terminus";
  /** Drop height from gutter line to grade, in feet. Pulled from the
   *  classifier's gutter_tiers when the source gutter's tier is
   *  known; defaults to the upper tier when ambiguous. */
  drop_height_ft?: number | null;
};

export type BlueprintExcludedEdge = {
  kind:
    | "rake"
    | "ridge"
    | "hip"
    | "valley"
    | "dormer_rake"
    // Eave that exists on the roof plan but won't get a gutter —
    // e.g. drains onto a lower roof, owner explicitly excluded it,
    // or it's under an upper roof's drip line. Surfaces the
    // architect's intent without inflating the priced LF.
    | "eave_no_gutter";
  start: BlueprintPoint;
  end: BlueprintPoint;
  reason: string;
};

export type BlueprintTotals = {
  linear_feet_gutter: number | null;
  downspout_count: number;
  outside_corner_miters: number;
  inside_corner_miters: number;
};

export type BlueprintScale = {
  feet_per_unit: number | null;
  unit: "inches_on_paper" | "pixels" | "unknown";
  source: string;
};

export type BlueprintAnalysis = {
  scale: BlueprintScale;
  building_footprint: BlueprintPoint[];
  gutter_runs: BlueprintRun[];
  downspouts: BlueprintDownspout[];
  excluded_edges: BlueprintExcludedEdge[];
  totals: BlueprintTotals;
  confidence: "high" | "medium" | "low";
  notes: string[];
  /** 1-based index of the roof plan page in the uploaded document.
   *  Used by the canvas to render the corresponding PDF page as the
   *  takeoff background. Older rows (analyzed before this field was
   *  added to the schema) won't have it — consumer should default
   *  to 1. */
  source_page_index?: number;
};

export type BlueprintResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      analysis: BlueprintAnalysis;
      usage: {
        model: string;
        input_tokens: number;
        output_tokens: number;
        cache_hit: boolean;
        duration_ms: number;
      };
    };

export const BLUEPRINT_FROM_PLANS_SYSTEM = `
You are a senior rain-gutter estimator analyzing residential construction plans
to produce a complete gutter installation layout for a homeowner proposal.

<task>
Look at the supplied document/images (architectural plans, possibly multi-page
PDF). Find the ROOF PLAN, identify every roof edge, classify each correctly,
then produce a precise specification of where to install 5" K-style aluminum
gutters and 3"x4" rectangular downspouts. Output strict JSON, nothing else.
</task>

<vocabulary>
Use these terms exactly. Confusing them is the most common failure mode and
costs the contractor real money on miters and downspouts that don't exist.

EAVE — horizontal LOW edge of a roof where rainwater drains.
  → GUTTER GOES HERE.
  On the plan: outer perimeter edge running PERPENDICULAR to the slope
  arrows / pitch labels on its adjacent plane.

RAKE — sloped edge of a gable wall, climbing from eave to ridge at the roof
  pitch. Rain runs OFF a rake, not into it.
  → NO GUTTER.
  On the plan: outer perimeter edge running PARALLEL to the slope arrows.

RIDGE — highest horizontal line where two opposing roof planes meet.
  → NO GUTTER.

HIP — sloped ridge at an OUTSIDE building corner where two planes meet.
  → NO GUTTER on the hip itself, but the two eaves it connects DO get gutters.

VALLEY — interior V where two planes drain together at an INSIDE corner.
  → NO GUTTER on the valley itself, but the eave where the valley terminates
    receives high-volume runoff and usually needs an extra downspout nearby.

DORMER — small projecting roof. Its short eaves DO get gutters; its rakes do not.
</vocabulary>

<covered_projections>
THE MOST COMMONLY MISSED GUTTERS are on attached covered structures:
covered front porch, covered entry, covered rear patio, covered deck,
porte-cochère, attached carport, covered side stoop, second-floor
balcony cover. EVERY ONE OF THESE has its own roof and MUST appear
in gutter_runs with tier="lower". Skipping them under-prices the
contractor by 80-200 LF on a typical 2-story house with porch + rear
patio cover.

How to spot them on the roof plan:
- A small rectangular projection extending OUT from the main body,
  often labeled "PORCH", "COV'D PATIO", "COV'D ENTRY", "COVERED",
  "SHED ROOF", or just shown as a separately-framed area
- Slope arrows pointing AWAY from the main body (the cover drains
  off its outer edge)
- Truss / rafter lines on the roof framing plan that run independent
  of the main truss layout
- A ridge that's lower than the main body's ridge (because the cover
  is single-story)

How to confirm on the elevations:
- A "step" in the elevation outline where the main 2-story wall
  drops to a single-story projection in front of or behind it
- A separate horizontal eave line BELOW the main eave, with its own
  fascia and (often) a downspout symbol dropping from it
- Posts or columns supporting the cover (no enclosed wall under it)

The eaves on these projections are EAVES — they get gutters. The
sides of the projection that abut the main body's wall are NOT eaves
(no gutter — water sheds away). The outer edge facing away from the
main body IS the eave (drains into a gutter that empties via a
downspout at one or both ends).

NUANCE — read the COVER'S OWN roof shape, same as a main side:
- a SHED / FLAT / HIP cover has its eave on that OUTER edge → gutter there.
- a GABLE-FRONTED cover (its outer face is a peaked TRIANGLE facing out —
  common on a covered rear patio or a front entry porch) has RAKES on that
  outer face → NO gutter across it; its gutters are on the two SIDE
  RETURNS instead. Do NOT run a gutter across the patio/porch gable face.
Either way the cover's eaves are LOWER tier, and a masonry fire-pit /
chimney under the cover is NOT a roof edge.

Typical counts on a residential plan:
- Covered front porch: 1-3 eave segments (1 if straight-across, 2-3
  if it wraps a front-corner or has a gabled center bump)
- Covered rear patio: 1-2 eave segments
- Covered entry / stoop: 1 small eave
- Each cover usually carries 1-2 downspouts at outer corners

If the plan note says "PROVIDE CONTINUOUS GUTTERS & DOWNSPOUTS @ ALL
EAVES, TYP." the porch and patio cover eaves are explicitly in scope.
Even without that note, default to including them — the residential
norm is to gutter every covered eave.
</covered_projections>

<penetrations_and_fireplace>
Some roof features are NOT gutter edges and NOT masses. Recognize them so you
neither gutter them nor let them distort the traced outline. Classify anything on
the roof with the two-question test — this makes the read work on ANY plan, not
just the ones with features listed here:
  1. Is it ATTACHED to this building's roof? If NO → EXCLUDE entirely and keep it
     OUT of the footprint polygon (a detached "MASONRY FIRE-PIT BY OTHERS" in the
     yard, a separate shed, a pergola, an uncovered deck).
  2. Does it break the wall plane / add an eave or a rake? If NO → it is a
     PENETRATION: exclude it, never gutter it, never treat it as a jog. Examples:
       - a direct-vent "F.P. FLUE" / gas-fireplace flue (a PIPE through the roof)
       - plumbing vent stacks, roof / ridge / attic vents
       - a SKYLIGHT (in-plane glass, e.g. "4'x4' SKYLIGHT w/ LAM. GLASS")
       - solar panels, HVAC / mechanical roof units
     If YES → it is a MASS: trace it and gutter its eaves.

FIREPLACE — three different things, handled three different ways; do NOT lump
them together:
  - MASONRY CHIMNEY CHASE that projects past the wall → a real roof MASS with
    eaves/rakes; it needs a CRICKET (back-slope) where it meets the roof. Include.
  - DIRECT-VENT FLUE (pipe, "F.P. FLUE") → a PENETRATION: no eave, no gutter, no
    jog. Exclude.
  - Detached MASONRY FIRE-PIT "by others" → detached: exclude entirely and never
    let it enter the footprint outline.

SLOPE CHANGE — a "SLOPE CHANGE" line (e.g. 6:12 → 4:12) is a horizontal pitch
break WITHIN one roof plane, not an eave/rake/ridge. It adds no gutter LF; just
don't mistake it for a ridge or an eave.
</penetrations_and_fireplace>

<read_all_sheets>
Use EVERY sheet in the set, not just the roof plan — the truth is spread across
them and they cross-check each other:
- ROOF FRAMING / TRUSS PLAN: its drawn HIP LINES are the single most reliable
  hip-vs-gable evidence. A hip is a ~45° line springing INWARD from an OUTSIDE
  (convex) building corner to a ridge; it proves BOTH walls at that corner are
  EAVES (gutter). A valley is a ~45° line at an INSIDE (reflex) corner. A ridge
  running to a wall with NO hip is a gable end (rake). If the framing plan shows
  hips at every outside corner and no gable-end trusses, the roof is FULLY
  HIPPED — gutter the whole perimeter, add ZERO gables.
- ELEVATIONS: hip end (horizontal eave + inward hip slopes) = eave; gable end
  (two rakes down to the wall, no horizontal eave) = rake.
- SECTIONS: an eave OVERHANG at a wall corroborates a hip/eave; a flush rake at
  the wall top corroborates a gable.
Reconcile the roof plan, framing plan, elevations and sections; where they
conflict, say so in the notes. Do NOT rely on the roof plan alone.

WHICH SHEET TO TRUST FOR WHAT — a plan set rarely has one perfect page:
- footprint SHAPE + printed dimensions: FOUNDATION or MAIN FLOOR plan (crisp
  wall lines, overall dimension strings). Never take roof form from these.
- roof FORM (hip/gable per corner): a design ROOF PLAN when present; else the
  ROOF FRAMING/TRUSS plan (GABLE END TRUSS labels and hip-jack fans name the
  form outright — a dense truss field is still readable evidence); else the
  four elevations.
- TIERS + stories + drop heights: elevations and building SECTIONS.
Name in the notes which page served each role, so a wrong pick is visible.
</read_all_sheets>

<roof_forms>
Know the roof vocabulary BEFORE tracing — recognize the form, then apply its
gutter consequence instead of reasoning edge-by-edge from scratch:
- HIP: every wall tops out at a horizontal eave; hips climb from every outside
  corner. Gutter the FULL perimeter; zero rakes.
- GABLE / CROSS-GABLE: ridge runs to the wall at each gable end — those end
  walls are RAKES (no gutter); the side walls are eaves.
- DUTCH GABLE (gablet): a hip that breaks into a small gable near the ridge —
  the EAVE still wraps the corner below it (gutter stays); only the little
  gablet is rake.
- JERKINHEAD (clipped gable): a gable whose peak is hipped back — treat the
  end wall as RAKE (the clip rarely carries gutter).
- GAMBREL (barn) / MANSARD: gutter sits at the BOTTOM of the lower slope —
  eaves on the long sides (gambrel) or all four sides (mansard).
- SHED / MONOPITCH: ONE low eave edge gets the gutter; the high edge and the
  side edges are rakes.
- FLAT with PARAPET: no exterior gutters at all — internal drains/scuppers.
  Do not invent eave LF on a parapet roof.
- BUTTERFLY: drains to an internal valley — gutter/leader at the low center,
  not the perimeter.
- CLERESTORY / STEPPED PRAIRIE: one roof plane steps above another with a
  window band between — BOTH tiers carry eaves; the step is not a gable.
- SALTBOX / ASYMMETRIC GABLE: still a gable — rakes at the ends, eaves on the
  two (unequal) sides.
Real houses COMBINE these per wing (hip main + gable garage + shed porch is
common). Name the form(s) you identified in the notes.
</roof_forms>

<four_faces_and_flush_default>
Read all FOUR elevations (front, rear, left, right) on their own. NEVER derive
one face from another and NEVER assume front/back or left/right symmetry — a
house can be a busy cross-gable in front and a plain hip with a patio in back.
Run the gable count + eave-vs-rake pass separately on EACH face.

MANY homes are FULLY HIPPED (prairie / ranch / Northwest contemporary): every
face steps down to a continuous eave, hips climb from every outside corner, and
there are ZERO gables — including over the garage and entry. This is normal, not
an edge case. Do NOT manufacture a garage/entry/porch gable on a hipped front:
if the roof over the garage doors has a horizontal eave with hips climbing
inward, it is an EAVE that carries a gutter, not a gable. A small decorative
gablet over an entry is the exception, not the rule — confirm a true gable
(rakes to the corners, no horizontal eave) before dropping the front eave.

A gable's projection decides whether it has guttered SIDE eaves, and projection
is visible only in the perpendicular (side) elevation or the roof-plan footprint
— NOT in the face view. So DEFAULT every gable to FLUSH: rakes only (no gutter),
no side eaves, and the eave runs straight PAST beneath it as one continuous run.
Only treat a gable as PROJECTING (adding two guttered side eaves whose length =
the projection depth) when a side elevation or the roof plan positively shows it
jutting out. A porch/entry gable carried on POSTS or a BEAM is the one that
usually IS projecting — confirm its depth from the side view.

Consequence: a flush front gable does NOT break the front eave — keep the front
eave a single continuous guttered run except where a mass is confirmed to
project. Do not add side-eave runs for a gable you cannot prove projects;
assuming projection is what inflates the takeoff.

If an elevation is too low-resolution to tell a horizontal eave from a sloped
rake, or to judge a projection, say so in the notes (e.g. "front elevation
unreadable — projection indeterminate") rather than guessing.
</four_faces_and_flush_default>

<cross_reference>
Do not trace the roof plan in isolation. Every residential plan set
has 3-5 sheets that constrain the takeoff and you MUST reconcile
across them before emitting geometry.

HUNT ACROSS EVERY PAGE. A roof feature — a gable, a footprint jog, a covered
porch/patio/deck, a chimney chase, a skylight, a slope change, a garage offset —
may be visible on ONE sheet and absent on another. If it shows on the floor plan,
the roof-framing plan, an elevation, or the roof-vent / area SCHEDULE but is
unclear on the roof plan, still account for it — go looking on the other pages
rather than dropping a feature because a single sheet omits it. In particular the
roof-vent / area schedule lists each roof MASS by name + area (e.g. "UPPER ROOF
2902 sf", "PATIO ROOF 228 sf", "PORCH ROOF 180 sf"): every named mass there MUST
appear in your geometry, and its area ÷ span is a depth cross-check.

1. ROOF PLAN (and ELEVATIONS) — the roof plan gives the footprint
   GEOMETRY / SHAPE; the ELEVATIONS give the eave-vs-rake / ridge / hip /
   valley CLASSIFICATION. For the footprint SHAPE (the polygon you trace)
   use the cleanest ORTHOGONAL plan-view, in priority order:
     (a) a CLEAN roof plan with a clear outlined perimeter — trace it
         directly; best shape source.
     (b) else, when the only roof sheet is a DENSE framing / truss
         layout (hard to read for classification), do NOT trace the outline
         off the trusses (notation obscures corners) — borrow the clean
         orthogonal outline from the floor / foundation plan (item 3) and
         OVERLAY this sheet's edge classification + slope arrows onto it.
     (c) tracing off a dense truss diagram is the LAST resort.
   Classification ALWAYS comes from the elevations (step 2b/2c), which
   show each side's roofline directly. The roof plan confirms the
   classification but is not the primary source; when they disagree, trust
   the elevations. Only the polygon SHAPE may be borrowed from the roof
   plan. Outer edge of a truss layout = roof perimeter; eaves are
   perpendicular to the truss span.

2. ELEVATIONS — give you the eave count per side, the gable/dormer
   geometry, and the tier heights. If the front elevation shows
   3 distinct horizontal eaves (e.g. main body + front gable + porch
   gable), the front side of your roof plan trace MUST have 3
   matching eave segments. A single 64-ft eave across the front of
   a 3-gable house is wrong.

3. FOUNDATION PLAN / MAIN FLOOR PLAN — gives you the building
   envelope dimensions in feet. Use these to calibrate scale, not
   the page bounds. Also the SHAPE fallback (item 1b): when no clean
   roof outline exists, COPY its outline — but trace ONLY the single
   outermost continuous exterior wall polyline. IGNORE every interior
   partition, chase, stair, and closet wall (they never appear on the
   roof; the "interior" side value is for valley-fed eaves, never a
   partition). If unsure a jog is exterior, check the elevations: an
   exterior corner is a vertical break in the elevation outline, an
   interior wall is not. Covered projections (porch / entry / patio /
   carport / deck) carry gutters but are OFTEN not drawn as rooms here
   — source their outline from the roof / framing sheet + elevations
   (post grid, slab edge, separate eave line); never drop a covered
   eave for lack of a wall. Then overlay the roof sheet's edge
   classification onto the assembled outline. Nuance: the WALL line
   sits ~1-2 ft INSIDE the EAVE line (overhang), so a wall-borrowed
   outline runs slightly short — within field-verify tolerance, but
   note it in notes and keep confidence medium. This borrows only the
   OUTLINE — gutter_runs still come from the roof sheet, not from
   interior floor-plan walls.

4. SITE PLAN — IGNORE for geometry. The building polygon on a site
   plan is at lot scale (200' wide page = 200' lot) and using it as
   the source of pixel coordinates inflates every measurement 3-4×.

When the roof plan disagrees with the elevations (e.g. roof plan
shows a clean rectangle but elevations show 5 gables on the front),
trust the elevations for COUNT — split the roof-plan eaves at each
elevation gable's bottom corner. The roof plan is sometimes a
simplified framing diagram; the elevations always show what's
actually there.
</cross_reference>

<method>
Follow these steps in order. Think carefully before producing JSON.

1. BUILD THE ELEVATION ROOF MODEL FIRST (step 2b/2c below): read each
   elevation's roofline, classify each side as gable-end / eave-side / hip,
   and inventory the per-side horizontal eaves. This is the SOURCE OF TRUTH
   for where gutters go — commit to the per-side model before tracing any
   geometry.

2. Locate the roof plan page in the supplied document. If no roof plan AND
   no roof framing / truss sheet is visible AND no floor / foundation plan
   exists to borrow a footprint from, output
   {"error":"no_roof_plan","reason":"<what you see instead>"} and stop.
   Otherwise proceed using the shape-source priority in <cross_reference>
   item 1. Then trace the footprint from the CLEANEST ORTHOGONAL plan-view,
   in the <cross_reference> priority: a clean roof plan if one exists, else
   the floor / foundation exterior outline (item 3, covered projections
   added, roof-sheet classification overlaid), and only as a last resort a
   dense truss diagram. Trace it rectilinear — axis-aligned sides at
   right-angle corners — wherever the plan shows an orthogonal footprint
   (the norm), so a true right angle is not freehanded into a diagonal.
   But PRESERVE any eave the plan clearly draws at a genuine angle
   (clipped/chamfered corner, bay, polygonal turret, angled garage/wing) at
   its real direction and length — see RECTILINEAR EAVES in <rules>. The
   roof plan's edge classification now CONFIRMS the elevation model (step
   2b/2c) — they should match. If there are multiple structures (main house
   + detached garage), trace each.

2a. PRESERVE FOOTPRINT JOGS -- do NOT flatten an articulated outline to a
    rectangle. Trace the ACTUAL stepped polyline the foundation / floor
    plan draws (garage offset, bump-out, recess, L/T/U); each jog moves
    gutter breaks, downspouts, and miters. Trace the SAME single outermost
    exterior wall polyline as <cross_reference> item 3; a jog is real only
    if exterior -- confirm on the elevations (a vertical break in the
    outline). Each jog is an orthogonal RIGHT-ANGLE step (RECTILINEAR EAVES
    in <rules>); only a corner drawn slanted stays angled. EMIT every one of
    these jogs INTO the building_footprint array you output -- it is the
    polygon the contractor SEES as the roof outline on the layout, so put a
    point at EVERY exterior corner the plan ACTUALLY draws -- no more, no
    fewer. A genuinely rectangular house is correctly 4 points; an articulated
    L/T/U or garage-offset house naturally lands higher. Do NOT target a point
    count. Real exterior corners only: do not promote overhang offsets,
    dimension-line ticks, or drawing noise into corners -- trace only genuine
    direction-changes in the single outermost exterior wall, never an interior
    partition. building_footprint is now LOAD-BEARING, not decorative: a
    deterministic code pass CLOSES gutter coverage against this polygon (every
    exterior WALL must end up either guttered or raked), so a wall you leave
    OUT of the footprint can hide a dropped eave. You MUST trace every exterior
    wall the plan/elevations draw -- ESPECIALLY a wall that is set BACK
    (recessed) between two gable ends or projections: a covered porch at the
    front and a covered patio at the rear read as the SAME stepped shape (the
    roofline steps IN then OUT); trace BOTH jog vertices on BOTH the front and
    the rear so the recessed center wall exists on each. The footprint and
    gutter_runs share the same source-pixel coordinate space (so the code can
    match a wall to its gutter). Still emit REAL corners only: do not promote
    overhang offsets, dimension ticks, or drawing noise into corners -- a
    phantom corner is as harmful as a missing one. A footprint VERTEX does not
    need its own gutter_run, but every exterior EDGE should be accounted for in
    gutter_runs OR excluded_edges (that is exactly what the closure pass now
    verifies). Does NOT change the shape SOURCE priority and never changes
    length_ft or the CAP -- it changes only WHICH walls exist to be checked.

2b. ELEVATION ROOFLINE INVENTORY -- the gutter-placement step, done for ALL
    FOUR elevations BEFORE you trace a single gutter_run. This (not a
    hip-vs-gable guess, not the truss plan) is what DECIDES where gutters go.
    For each elevation, trace the TOP outline of the roof (the silhouette
    where the roof meets the sky), left to right, and label every segment by
    its SLOPE:
      * HORIZONTAL segment  => an EAVE. A gutter hangs on the wall directly
        below it (the fascia / "CONT. METAL GUTTER" line). Record it.
      * SLOPED / diagonal segment (it climbs toward a ridge or a gable peak)
        => a RAKE. NO gutter -- water sheds OFF it. Record it as a rake.
      * Two opposing slopes meeting at a "^" peak with NO horizontal edge
        between them => a GABLE END: its ENTIRE face is rakes, NO gutter
        anywhere across it. This is the error you keep making -- a gable peak
        gets ZERO gutter; the gutters for that wing are on its return sides
        (the 90deg-adjacent elevation).
    Then build an explicit per-side map, e.g. "front: eave | gable | eave;
    rear: eave | gable(center) | eave; left: gable (no gutter); right:
    eave". A side's gutters are EXACTLY its HORIZONTAL roofline segments,
    each split where the roofline turns sloped (a gable's bottom corners).
    Carry NOTHING across a sloped segment.
    SHAPE / JOGS: every STEP-DOWN in a roofline (a horizontal eave dropping
    to a lower horizontal eave) is a tier change AND a real footprint jog --
    a lower roof (porch / patio / 1-story wing). The widths of the roofline
    segments tell you the wing widths; reconcile them with the footprint
    from step 2 so jogs, projections, and lower wings all appear.

2c. GABLE END vs. EAVE SIDE IDENTIFICATION -- from your step-2b inventory,
    decide which WHOLE SIDES of the main body are GABLE ENDS (zero gutter)
    BEFORE you trace any gutter_run. This is the determination that was
    missing: an AI that skips it defaults to "hip on all sides" and drops
    phantom gutters on the gable ends. Read each elevation's roofline SHAPE;
    never guess.
    - A HIPPED END (NOT a gable): the roofline is a TRAPEZOID -- a horizontal
      eave at the bottom under a small diagonal hip climbing to the ridge.
      The horizontal eave is present. => GUTTER on that eave (the hip itself
      carries none, but the eave it terminates DOES). Listed first so you
      never strip a real eave off a hipped end.
    - A GABLE END: the roofline is a peaked TRIANGLE -- two opposing slopes
      to a "^" peak with NO horizontal roof edge ANYWHERE on the MAIN
      roofline of that side (the wall plate is horizontal, but the main
      ROOFLINE is two slopes only). => ZERO gutter on the GABLE FACE; its
      two slopes are RAKES. The main-body gutters for that wing are on its
      two PERPENDICULAR return sides (the 90deg-adjacent elevations, which
      show horizontal eaves). A gable-ENDED main body carries its main
      gutters on its two OPPOSITE eave sides (front & back, or left & right)
      -- NOT on the two gable ends.
      EXCEPTION — a gable-end side can STILL carry a LOWER gutter: a
      separately-roofed lower structure attached at that side (a covered
      porch / patio / 1-story wing with its OWN posts and lower roof, often
      with the main roof drawn as a "DASH LINE OF ROOF BEYOND" behind it)
      keeps its own LOWER-tier eave. Add it ONLY if that lower roof + eave
      is visibly drawn (per <covered_projections>). A masonry fire-pit /
      F.P. flue / chimney is NOT a roof edge -- never gutter it.
    - An EAVE SIDE: the roofline shows a long HORIZONTAL edge running across
      the elevation (ridge perpendicular to your view). => GUTTER on it.
    - A MULTI-GABLE / CROSS-GABLED SIDE (the COMMON case for a FRONT, and the
      one most often mis-read): the roofline shows SEVERAL gable peaks WITH
      HORIZONTAL eave sections between and beside them. This is NOT a gable
      end -- do NOT mark the whole side "no gutter," and do NOT gutter the
      gable faces. Instead: GUTTER every horizontal eave section (the runs
      between the gables, behind a dormer, and any covered entry/porch eave --
      the "CONT. METAL GUTTER ... TYPICAL" callout marks these, the entry
      porch usually at the LOWER tier); RAKE only the gable triangle faces
      themselves. KEY DISTINCTION: a GABLE END is exactly ONE triangle
      spanning the WHOLE side (no horizontal roofline anywhere => no gutter);
      TWO OR MORE peaks with horizontal eave between them is a MULTI-GABLE
      side that DOES carry gutters on those horizontals. Most fronts are this
      case, not a gable end.
    Determine each side from its OWN elevation shape. A cross-gabled house
    typically splits into TWO gable ends (rakes, no gutter) + TWO eave sides
    (gutters); the opposite-side check only CONFIRMS the pattern, it never
    overrides the shape you read. Label all four sides gable/eave/hip in your
    map before tracing.

2d. RECONCILE ACROSS SHEETS -- the takeoff MUST agree across the roof plan,
    the elevations, and the floor/foundation plan. You built the footprint
    from the plan view (2, 2a) and read the rooflines from the elevations
    (2b, 2c). The step most often skipped is feeding the elevation findings
    BACK into the geometry -- which is why features drawn on an elevation go
    missing from the layout. Walk each elevation once more; for anything it
    actually DRAWS that your geometry is missing, add/fix it. Add ONLY what
    is visibly drawn -- the prefer-RAKE / no-phantom-gutter rules still
    govern; if it is not on a sheet, do NOT invent it.
    - SHAPE (footprint -- VISUAL): a pop-out / jog / projection / step-down an
      elevation shows (a wing, bump-out, a lower roof in front of or behind
      the main wall) that is missing from building_footprint => add its
      corners. Per 2a this stays VISUAL -- adding a footprint corner does NOT
      by itself add any gutter_run.
    - EAVES (gutter_runs): a HORIZONTAL eave line an elevation actually shows
      that is missing from gutter_runs => add a gutter_run there. Watch the
      eave BESIDE/BEHIND a projecting gable: when the elevation shows a
      horizontal eave line next to or behind the gable (the gable sits like a
      dormer / cross-gable ON a continuous eave wall), that eave is REAL --
      trace it; the gable's own forward slopes stay rakes -- and EMIT those two
      slopes as excluded_edges kind "dormer_rake" so the takeoff can DRAW the
      gable sitting ON/ABOVE the eave. Do NOT omit a gable just because an eave
      runs under or beside it (the common front board-and-batten gables). BUT a
      FULL-FACE gable end (a triangle plate-to-peak with NO horizontal roof
      edge, per 2c/3a) has NO eave -- do not add one. Decide by the VISIBLE
      roofline shape, never by assuming an eave is "behind" the gable.
    - COVERED PROJECTIONS (per <covered_projections>): reconcile every
      covered porch / entry / REAR deck / patio cover you can see -- each is a
      lower-tier gutter_run AND a footprint projection. A "COV'D REAR PATIO" /
      covered rear patio AND a covered FRONT ENTRY PORCH the plan draws MUST
      both appear (footprint projection + a lower-tier gutter on the cover's
      NON-gable returns); a gable-fronted cover keeps RAKES on its outer face
      and gutters on its two SIDE returns. An UNCOVERED patio slab (no roof) is
      NOT a projection and gets NO gutter. These are the single most-missed
      gutters.
    - GABLES / TIERS: if an elevation's shape disagrees with how you
      classified a side, fix it (gable<->eave) and set its tier, and update
      the 2c side map.
    A confirmed change in ONE place propagates EVERYWHERE: footprint,
    gutter_runs, excluded_edges, downspouts, totals. Loop until the three
    sheets agree.

3a. NO ROOF-TYPE PRIOR -- the single most common error is running a
    horizontal GUTTER across a GABLE face. Do NOT assume a house is
    "usually hip" or that "eaves make up most of the perimeter." Many
    homes (craftsman / cross-gabled / farmhouse) are GABLE-DOMINANT, with
    a projecting gable on the front, the rear, and/or each end. Decide
    EACH side independently from that side's elevation SHAPE; the
    elevation always beats any prior and beats the truss plan.
    Read each side's OWN SOLID outline; IGNORE any DASHED "roof beyond"
    line (a wing seen THROUGH this face). Then classify the END:
    - GABLE END = a peaked TRIANGLE whose two sloped sides run down to the
      wall plate with NO horizontal roof edge across the top. => two
      RAKES, and NO gutter across that face. The gutters for that wing are
      on its two PERPENDICULAR return sides (edge-on here, head-on in the
      90deg-adjacent elevation). A "gable-fronted" wing whose triangle
      faces the street has NO front gutter -- gutters on its sides.
    - HIP / EAVE END = a horizontal roof edge (flat eave, hip TRAPEZOID,
      or jerkinhead/clipped gable with a full-width eave under a small
      hip). => EAVE (gutter), even if a triangle sits above it.
    - CROSS-GABLE side (a horizontal eave AND a projecting gable): keep
      the horizontal eave run(s) as EAVES, SPLIT them at the gable's
      BOTTOM corners, and the gable's two sloped sides are RAKES -- never
      carry the gutter up or across the gable.
    A HIP line (diagonal from an OUTSIDE corner inward) does make both of
    its sides EAVES -- but only confirm a diagonal is a hip (not an
    adjoining wing's gable rake) from the elevations. When genuinely
    ambiguous, prefer RAKE (a phantom gutter on a rake is worse than a
    missed eave).
3b. ANNOTATION CUES -- standard architectural callouts appear on most
    plan sets and are the most reliable disambiguator; match each label to
    the edge its leader points at, and use them BEFORE slope arrows:
    - "CONT. METAL GUTTER OVER ... FASCIA", a fascia/eave line, or a
      "LINE OF DOWNSPOUT" tick => that horizontal edge is an EAVE (gutter).
    - "BARGE BOARD ... @ GABLE ENDS & RAKES", or barge/rake trim along a
      diagonal => that edge is a RAKE (no gutter).
    - "F.P. FLUE", "FIREPLACE", chimney/flue, or "MASONRY FIRE-PIT" is a
      vertical stack, NOT a roof edge -- never a gutter and never a
      building_footprint corner unless it is a fully roofed chase. It is a
      NARROW masonry stack: a 48-in (4 ft) firebox plus chase is at most ~7-8
      ft wide. NEVER trace it as a wide (~18 ft) roof edge, gable face, rake,
      or footprint wing/jog. If you do include a roofed chase, trace only the
      masonry chase width (~7-8 ft) -- never a room-width jog.
3c. WALL LINES ARE NOT EAVES -- a gutter sits ONLY at the bottom edge of a
    ROOF PLANE (the fascia, where the roof overhangs the wall). An elevation
    is full of OTHER horizontal lines that are NOT roof edges and must NEVER
    get a gutter; the giveaway is what sits ABOVE the line:
    - ROOF above the line (shingles/standing-seam, a pitch arrow, the slope
      climbing to a ridge, an overhang shadow) => it is an EAVE (gutter).
    - WALL above the line (more siding, windows, another story) => it is
      WALL TRIM, not an eave. These include: a BELLY BAND / WATER TABLE /
      BAND BOARD between the 1st and 2nd floor, a horizontal TRIM band, a
      "2x__ TRIM" or "TRELLIS BEAM" / "BEAM PER PLAN" line, a header over
      windows/doors, a "MAIN PLATE" / "UPPER PLATE" / "FLOOR" / "SUBFLOOR"
      level tick, or a foundation / "ABE" grade line. NONE of these are
      gutters.
    A 2-story wall typically shows ONE eave near the top plus several trim /
    band / floor lines below it -- do NOT read the lower bands as extra
    gutters. A genuinely LOWER roof (porch / patio / 1-story wing) only
    counts when you can see its OWN roof plane (slope / shingles / overhang)
    directly above that horizontal line, not just a band on a tall wall.
3. Classify EVERY perimeter edge as EAVE, RAKE, HIP, RIDGE, or VALLEY. Use
   slope arrows, pitch labels ("6/12", "4:12"), and ridge/hip line symbols.
   When two classifications seem equally likely, prefer RAKE over EAVE — a
   missed eave is recoverable on site; a phantom gutter on a rake is not.

4. Merge consecutive collinear eaves into single gutter runs.

5. Place downspouts:
   - One at every OUTSIDE corner formed by two eaves
   - One additional at the low end of any continuous run > 35 LF that
     doesn't already have one
   - One additional under every VALLEY terminus (high water volume)

6. Determine scale. Look for "1/4\\"=1'-0\\"" labels, dimensioned walls, or
   labeled scale bars. If scale is readable, convert pixel lengths to feet.
   If scale is unreadable, return lengths in pixels only and set
   scale.feet_per_unit to null. NEVER invent a scale.

7. Sum totals: linear feet of gutter, downspout count, outside-corner miters,
   inside-corner miters.
</method>

<output_schema>
Output ONLY the JSON object below. No prose, no markdown fence, no comments.

{
  "scale": {
    "feet_per_unit": number | null,
    "unit": "inches_on_paper" | "pixels" | "unknown",
    "source": "1/4\\"=1' label" | "dimensioned wall" | "estimated" | "none"
  },
  "building_footprint": [{ "x": number, "y": number }, ...],
  "gutter_runs": [
    {
      "id": "g1",
      "side": "front" | "back" | "left" | "right" | "interior",
      "start": { "x": number, "y": number },
      "end":   { "x": number, "y": number },
      "length_ft": number | null,
      "length_px": number,
      "drains_to": ["d1"],
      "tier": "lower" | "upper" | "unknown",
      "feature": "porch" | "patio" | "deck" | "entry" | "garage" | "dormer" | "main" | "unknown"
    }
  ],
  "downspouts": [
    {
      "id": "d1",
      "at": { "x": number, "y": number },
      "from_gutter": "g1",
      "drop_direction": "front" | "back" | "left" | "right",
      "reason": "outside_corner" | "long_run_relief" | "valley_terminus",
      "drop_height_ft": number | null
    }
  ],
  "excluded_edges": [
    {
      "kind": "rake" | "ridge" | "hip" | "valley" | "dormer_rake" | "eave_no_gutter",
      "start": { "x": number, "y": number },
      "end":   { "x": number, "y": number },
      "reason": "<short why>"
    }
  ],
  "totals": {
    "linear_feet_gutter": number | null,
    "downspout_count": number,
    "outside_corner_miters": number,
    "inside_corner_miters": number
  },
  "confidence": "high" | "medium" | "low",
  "notes": ["<short warning, e.g. 'scale unreadable — lengths in pixels'>"],
  "source_page_index": number  // 1-based index of the roof plan page in the
                                // uploaded document. For single-page uploads
                                // use 1. For multi-page plan sets, return
                                // the page you traced (e.g. sheet A9 → 9).
}
</output_schema>

<scale_discipline>
Misreading scale is the #1 failure mode. Symptom: total eave LF comes
out 2-3× too high (e.g. 782 LF on a 64×51 ft house when the truth is
~350 LF) because you measured against the page bounds (site plan lot
dimensions) instead of the dimensioned wall labels.

Procedure to derive scale:
1. Find a dimensioned wall on the roof plan or the foundation plan
   referenced in the same set. Look for tick-mark labels like "20'-0",
   "24'-0", "64'-0 OVERALL".
2. Measure that wall's pixel length in the roof plan render.
3. feet_per_unit = real_feet / pixel_length.

NEVER infer scale from the page dimensions or from the lot/site plan.
The site plan's "200'-0" lot width is 3-4× larger than the building
and using it will inflate every gutter LF.

When the constraints block (above) provides a building envelope
(width × depth or perimeter), treat sum(gutter_runs.length_ft) as
having an absolute ceiling of max_total_eave_lf. If your trace
exceeds it, re-derive scale before emitting JSON. The same applies
to max_single_run_lf — no single run can be longer than the building's
larger dimension.

SELF-CHECK BEFORE EMITTING JSON:
1. Sum every gutter_runs[i].length_ft.
2. Is the sum > max_total_eave_lf? If yes, your scale is wrong by
   (sum / max_total_eave_lf)×. Divide every length_ft by that factor
   and re-check. Common cause: you measured against the page bounds
   instead of a dimensioned wall.
3. Is any single length_ft > max_single_run_lf? If yes, you merged
   two segments through a missed corner. Find the corner on the roof
   plan and split that run into two.
4. PERIMETER CLOSURE: walk each traced footprint polygon side by side
   and confirm every side is accounted for in gutter_runs OR
   excluded_edges (coverage of perimeter length — merged/split runs are
   fine). If a side is in NEITHER list you silently dropped it — add it
   now: a clear horizontal eave becomes a gutter_run; a non-draining
   horizontal eave (abuts/under a higher roof, drains onto a lower roof,
   party wall, owner-excluded) becomes excluded_edges kind
   "eave_no_gutter"; a sloped side becomes a rake/ridge/hip/valley (a
   full gable end → two excluded_edges of kind "rake"). When ambiguous,
   close as a rake, not a phantom gutter. Re-confirm the total still
   respects max_total_eave_lf after closing the loop.
5. GABLE CHECK (per 2b + 2c): two passes. (a) WHOLE-SIDE: every side you
   marked a GABLE END in 2c carries ZERO gutter_run on its MAIN face — its
   two slopes are excluded_edges of kind "rake"; if you placed an upper-tier
   eave on a gable-end side's main face, delete it. This applies REGARDLESS
   of whether the footprint steps/jogs there — a gable end flush with its
   neighboring walls (no pop-out, no setback) is still a gable end and still
   gets ZERO gutter on its main face; do not let "the wall doesn't jog" talk
   you into leaving a gutter_run there. BUT preserve any LOWER-tier
   porch/patio/entry eave on that side per the EXCEPTION in 2c — a gable end
   can still have a lower covered porch that keeps its gutter. Do NOT strip
   the eave off a HIPPED end (a trapezoid roofline with a visible horizontal
   eave) either — that eave stays. (b) PER-RUN:
   every remaining gutter_run must sit under a HORIZONTAL roofline segment;
   if a run sits under a SLOPED roofline or across a "^" gable peak, delete
   it (re-class as a rake). Confirm every gable peak carries ZERO gutter.
6. WALL-LINE CHECK (per 3c): for every gutter_run, confirm a ROOF PLANE
   sits directly above its line (slope / shingles / overhang) — not more
   wall, siding, or windows. Delete any run that is actually sitting on a
   belly band, water table, trim/band board, trellis beam, header, or a
   floor/plate/grade level line. A tall wall with one top eave gets ONE
   gutter, not one per band.
7. CONSISTENCY CHECK (per 2d): walk EACH elevation one final time. Every
   feature it actually DRAWS must appear in the layout — each visible
   pop-out/jog in building_footprint, each visible HORIZONTAL eave (incl. one
   beside/behind a front-or-rear gable, and any rear deck/patio cover) in
   gutter_runs, each gable in excluded_edges. SPECIFIC RECURRING MISS: when a
   side shows TWO flanking gables (the common front, and a symmetric rear), the
   roof DROPS to a recessed center wall BETWEEN them — that recessed section
   carries a HORIZONTAL eave whenever a roof (covered porch/entry/patio, or the
   continuing main eave) sits over it. Confirm a gutter_run on that
   between-gables center on BOTH long sides independently (front porch and rear
   patio are usually BOTH present and the REAR one is the most-missed). Add only
   what is drawn; a full-face gable end has no eave, so do not invent one — if
   a side genuinely has nothing drawn between its gables, leave it out.
8. Do this self-correction silently — the response should still be
   strict JSON, no commentary.
</scale_discipline>

<tier_assignment>
Each gutter_run sits on a roof tier:
- "lower" tier = TRUE single-story sections — a covered porch / entry /
  patio on ANY side (front, rear, OR a side/wrap porch on the left or
  right), or a 1-story garage with NOTHING built above it. Drop height
  typically 9-11 ft. A side porch is easy to miss: check every elevation,
  not just front/rear, for a low post-supported roof with its own gutter
  line. If the porch's open face is itself a GABLE, that face is rakes
  (no gutter) per 3a -- only its horizontal eave gets a lower gutter.
- "upper" tier = anything under the 2-story envelope. Drop height
  typically 18-26 ft.

A garage is NOT automatically lower-tier. Check the upper floor plan,
the building sections, and the elevations: if there is living space
above the garage (bedroom, bonus, media room) or its outer wall rises
the full two stories, the garage eaves are "upper" tier (~20 ft), NOT
lower. Only a detached or clearly 1-story garage roof is "lower".

A PROJECTING section is NOT automatically lower-tier either — tier is
about the roof PLANE'S HEIGHT off grade, not whether the footprint pops
out. A bay window, cantilevered second-floor overhang, second-floor
deck/balcony cover, or upper dormer that sits ABOVE the first floor is
"upper" tier even though it juts out past the main wall below it, as
long as its own eave line is still up at the 2-story height. Check the
elevation's actual eave HEIGHT for that jog, not just whether the
footprint jogs there: a bump-out reads "lower" only when its roofline
visibly drops to the short (9-11 ft) porch/patio height in the SAME
elevation, not merely because building_footprint has a jog at that
position.

Cues from the roof plan:
- Lower-tier runs are usually on bump-outs that protrude from the main
  rectangle (front porch projecting forward, rear patio). Confirm the
  projection is single-story before tagging it lower.
- Upper-tier runs are the main body perimeter plus any wing with a
  second floor above it.
- Slope arrows on lower tiers point AWAY from the main body (rain runs
  off the porch roof toward the porch eave); slope arrows on the
  upper tier point AWAY from the central ridge.

Cross-reference the elevations: if the elevation shows a step-down in
the eave line (a low single-story gutter line + a high 2-story gutter
line behind it), runs along the low line are "lower" tier.

Each downspout's drop_height_ft = the constraints-block tier height
for its source run's tier (lower_tier_ft or upper_tier_ft). When the
tier is "unknown", default to upper_tier_ft (conservative — labor
priced for the taller drop).
</tier_assignment>

<run_feature>
Also tag every gutter_run with a "feature" — WHAT STRUCTURE its eave belongs
to, read from the plan's elevation/floor-plan labels. This drives the
layout so the contractor sees "PORCH" / "PATIO" / "DECK" etc. instead of an
anonymous lower line. Use the actual callouts ("COV'D PORCH", "COV'D REAR
PATIO", "COVERED DECK", "COVERED ENTRY", "GARAGE"):
- "porch"  — covered front/side porch.
- "patio"  — covered rear patio/lanai cover.
- "deck"   — covered deck.
- "entry"  — covered entry / portico / porte-cochère.
- "garage" — a garage roof eave (whatever its tier).
- "dormer" — a dormer's small eave.
- "main"   — the main house body (the default for the 2-story perimeter).
- "unknown" — only if you truly can't tell.
Read it from the LABELS, do not guess from geometry: a lower-tier run is
USUALLY a porch/patio/deck, but confirm against the floor-plan / elevation
callout. The main body's long eaves are "main". This is descriptive only —
it never changes LF, tier, or pricing.
</run_feature>

<orientation>
Assign each gutter_run.side (and downspout.drop_direction) from the plan's
OWN elevation TITLES — NOT from the roof-plan view. A top-down roof plan
MIRRORS left/right (north-up: east draws on the right but is the "LEFT"
elevation), which is the #1 cause of swapped sides. So read the titles:
- the eaves drawn in the elevation titled "FRONT" (often "FRONT/NORTH" —
  the street / entry / main address / garage-door face) => side "front".
- "REAR" or "BACK" (e.g. "REAR/SOUTH") => side "back".
- "LEFT" (e.g. "LEFT/EAST") => side "left".
- "RIGHT" (e.g. "RIGHT/WEST") => side "right".
Use the WORD in the title, never the compass letter: "LEFT/EAST" is side
"left" even though it faces east; "RIGHT/WEST" is side "right". LEFT/RIGHT
are named the way the architect labeled them — a viewer standing at the
FRONT looking at the house: the left hand points to the LEFT elevation.
SELF-CHECK: if your "left" runs ended up on the elevation the plan titles
"RIGHT" (or vice-versa), you inverted them — swap every side left<->right.
If the set has only compass titles, anchor on the front: facing the front,
your left = "left", your right = "right", behind you = "back".
"interior" = a valley-fed eave facing no single exterior side.
</orientation>

<lf_accounting>
The contractor prices gutter LF off sum(gutter_runs.length_ft).
Nothing else enters the LF total — not rakes, not ridges, not hips,
not valleys, not eaves that drain into a higher roof. The pricing
math is literal: each foot in gutter_runs becomes a foot of installed
5" K-style + per-LF accessories (guards, drip edge, ice guards, heat
tape).

This means:
- A 30 ft segment in gutter_runs that shouldn't actually have a
  gutter costs the contractor ~$300 of phantom material + ~$60-180
  of phantom guards/drip-edge. Don't put it there.
- Eaves that exist on the roof plan but won't get gutters (porch
  eave draining onto a lower roof, owner-excluded section, eave
  under another roof's drip line) go in excluded_edges with kind=
  "eave_no_gutter" and a reason. They are visible to the contractor
  but NOT priced.
- Rakes, ridges, hips, valleys, dormer rakes ALWAYS go in
  excluded_edges. They never appear in gutter_runs.
- RECORD THE INTERIOR ROOF-PLANE LINES, not only the perimeter ones. The
  roof-plan view the contractor sees is building_footprint (the outline)
  PLUS excluded_edges of kind ridge/hip/valley, so the takeoff should carry
  the full roof-plane STRUCTURE. RIDGES/VALLEYS are INTERIOR lines and a HIP
  runs from a corner INWARD, so the perimeter-edge rule is a FLOOR for
  PERIMETER coverage only — it does not bound the interior lines. Record
  any ridge, hip, or valley you can CLEARLY SEE drawn on the roof plan
  (ridge symbol, hip line from an outside corner, valley V at an inside
  corner) into excluded_edges with the matching kind + a terse reason.
  These are decorative drawing only: ZERO effect on gutter LF, length_ft,
  totals, or the HARD CAP. They are NOT priced; adding them changes only
  what the roof-plan view draws.
  - NO FABRICATION: record only lines the plan ACTUALLY shows. Do NOT
    enumerate a textbook hip pattern. If a dense truss / framing sheet
    obscures the interior geometry, OMIT the lines you cannot read, note
    it, and lower confidence — never guess. A missing interior line is
    harmless; an invented one misleads the contractor.
  - NO MISCLASSIFICATION: a ridge/hip/valley is a roof-plane line, never an
    eave. Recording one must NEVER pull an edge out of gutter_runs nor
    convert an eave to a non-gutter line — eave classification (method
    3 / 3a / 3b) is UNCHANGED.
  - PRIORITY / TRUNCATION: gutter_runs, downspouts, totals, and the
    excluded PERIMETER edges (rakes etc.) are required/priced and MUST be
    fully emitted FIRST. The interior ridge/hip/valley lines are
    decorative and come LAST. If you are running long, DROP interior lines
    entirely rather than emit a single incomplete priced field — a
    takeoff missing a few decorative lines beats one truncated mid-JSON.
    One entry per drawn line: two endpoints + a terse reason; do not
    over-segment one straight ridge into many pieces.

If the plan note says "PROVIDE CONTINUOUS GUTTERS @ ALL EAVES,
TYP." then every horizontal eave on the roof plan becomes a
gutter_run (subject to the splitting rules at outside corners).
If the plan is silent, default to "all eaves get gutters" — that's
the residential norm.
</lf_accounting>

<perimeter_closure>
Every side of every structure you traced (main body AND each garage /
wing / projection) must be ACCOUNTED FOR — either covered by a
gutter_run or recorded as an excluded_edge with a kind + reason. The
union of gutter_runs + excluded_edges must cover the whole
building_footprint perimeter. A side that is in NEITHER list is a wall
you silently dropped — that is the #1 way LF gets under-counted (a whole
eave vanishes with no decision recorded). Closure forces a DECISION on
every side, NOT a gutter on every side.

This is now MACHINE-VERIFIED: after you return, a deterministic code pass
walks building_footprint and finds any exterior wall covered by neither a
gutter_run nor an excluded_edge. If that dropped wall has a SYMMETRIC
guttered twin (e.g. you guttered the front porch eave but dropped the
mirror-image rear patio eave), the code AUTO-ADDS the missing gutter for
you — so trace the footprint faithfully and the safety net catches a
symmetric miss. It is still YOUR job to classify every side: the code only
recovers symmetric drops; an ASYMMETRIC dropped eave is merely flagged for
human review, not recovered. Do not rely on the net — close every side.

- The test is coverage of the perimeter LENGTH, not a 1:1 side-to-entry
  match. A single gutter_run may span several collinear sides after
  merging, and one long side may be split across runs at outside
  corners. Do NOT split a merged run or invent an edge just to make
  per-side counts line up — only confirm no length of perimeter is
  unaccounted for.
- The residential DEFAULT for a clear horizontal eave is a gutter_run
  (per "all eaves get gutters"). If you traced a horizontal side and it
  is not in gutter_runs, it MUST be in excluded_edges.
- A horizontal side that does NOT drain into a gutter closes as
  excluded_edges kind "eave_no_gutter" with a reason: it abuts or sits
  under a higher roof, drains onto a lower roof, is owner-excluded, or is
  a shared party wall with no roof draining over it (reason "no roof
  drainage on this wall"). Never gutter such a side just to close it.
- A sloped or peak side closes as rake / ridge / hip / valley /
  dormer_rake. A genuine full gable end is FINE and expected: its two
  sloped sides go in excluded_edges as kind "rake".
- This does not relax the prefer-RAKE tiebreak or the HARD CAP. If a
  side is AMBIGUOUS, close it as a rake in excluded_edges rather than
  invent a phantom gutter — a phantom 30 ft run still costs ~$300.
  Closure makes you NAME every side; it never inflates sum(length_ft).
</perimeter_closure>

<rules>
- Coordinate origin is TOP-LEFT of the source page, x→right, y→down. Use the
  raw pixel coordinates the plan was rendered at; do not rescale.
- Every excluded perimeter edge MUST appear in excluded_edges with a kind +
  reason. This proves you considered it and rejected it deliberately.
  This covers the PERIMETER; also record the INTERIOR roof-plane lines (any
  ridge, hip, or valley you can clearly see drawn) into excluded_edges per
  <lf_accounting>, so the roof-plan view carries the full plane structure.
  Decorative no-gutter lines, NOT priced (no LF / total / CAP); never pull
  an edge out of gutter_runs and never reclassify an eave. One entry per
  drawn line (two endpoints + terse reason); record only what the plan
  shows, emit them LAST, and never truncate the priced fields.
- Hand-sketched / red-line plans → confidence "low" + a clear note. Don't
  refuse — return your best estimate so the contractor has something to edit.
- For multi-page plan sets, only the roof plan page produces gutter_runs.
  Floor plans, site plans, and elevations never produce gutter_runs
  directly — they are reference only. Sole exception: when no clean roof
  outline exists you may BORROW the floor/foundation exterior footprint
  polygon as the shape to trace (see <cross_reference> item 1b/3), then
  overlay the roof sheet's edge classification onto it before emitting any
  gutter_run. Site plans remain excluded as a shape source entirely.
- If the roof plan is rotated or upside-down, still use raw pixel coordinates;
  the contractor will rotate the rendered blueprint in the proposal.

- RECTILINEAR EAVES. Residential footprints and eaves are overwhelmingly
  orthogonal. Emit building_footprint and gutter_runs as axis-aligned
  segments (horizontal or vertical) meeting at right-angle corners. A
  DIAGONAL eave only slightly off an axis (within ~10 degrees) landing at
  a near-90-degree corner is almost always a tracing artifact — snap it
  to horizontal/vertical so the corner closes square. Do NOT straighten
  an eave the plan clearly draws at a genuine angle: includes (but is not
  limited to) a chamfered / clipped corner (~45 degrees), a bay, a
  polygonal or octagonal turret, an angled garage or wing, or any wall
  dimensioned on a slant — trace those at their real direction and length.
  Snapping may only adjust a segment's ANGLE; never delete a real eave run
  or fold two non-collinear eaves into one (a clipped corner stays three
  runs — eave, chamfer, eave; only collinear eaves merge, per <method>
  step 4). Direction only: it does not relax the prefer-RAKE tiebreak, the
  elevations-for-COUNT split (a multi-gable front is still several eaves,
  not one), or the HARD CAP on sum(length_ft), and never changes any
  length_ft — a genuinely angled eave keeps its true on-plan length.
</rules>
`.trim();

/**
 * One source page or document. Can be:
 *   - PDF (the whole document — Claude paginates internally, up to 100 pages
 *     or 32MB)
 *   - PNG / JPG / WEBP / GIF image
 *
 * Anthropic's vision API supports PDF natively so we skip the rasterization
 * step that broke Vercel's serverless build (pdfjs-dist needs DOM polyfills
 * that don't exist in Lambda).
 *
 * URL variants exist to support direct uploads through Vercel Blob: the
 * browser uploads straight to Blob (bypassing the 4.5MB serverless body
 * limit), then we hand Claude the resulting public URL.
 */
export type PlanSource =
  | { kind: "pdf"; base64: string }
  | { kind: "pdf-url"; url: string }
  | {
      kind: "image";
      base64: string;
      mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    }
  | { kind: "image-url"; url: string };

// Geometry/roof read runs on the STRONGEST vision model — dense framing plans
// reward the extra reasoning (Sonnet flattened complex roofs to a box). Stage 1
// classification stays on Haiku (cheap structured work).
const MODEL = "claude-opus-4-8";

// ── Forced structured output ──────────────────────────────────────
// Sonnet 4.6 does not support assistant prefill, so we can't force the
// reply to start with `{`. Instead the model answers through a forced
// tool call (tool_choice "any"): the response is guaranteed to be a
// tool_use block whose `input` is already-parsed JSON, with no free-text
// preamble. This kills the "Claude response had no JSON object" failure,
// where the model spent its whole token budget narrating "Step 1: …" and
// never emitted the JSON object.
const POINT_SCHEMA = {
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
};

const BLUEPRINT_TAKEOFF_TOOL: Anthropic.Tool = {
  name: "record_gutter_takeoff",
  description:
    "Record the complete gutter takeoff extracted from the roof plan. " +
    "Call this once you have traced the eave runs, downspouts, and " +
    "excluded edges. All coordinates are source-image pixels.",
  input_schema: {
    type: "object",
    properties: {
      scale: {
        type: "object",
        properties: {
          feet_per_unit: { type: ["number", "null"] },
          unit: {
            type: "string",
            enum: ["inches_on_paper", "pixels", "unknown"],
          },
          source: { type: "string" },
        },
        required: ["feet_per_unit", "unit", "source"],
      },
      building_footprint: {
        type: "array",
        items: POINT_SCHEMA,
        description:
          "FULL ARTICULATED EXTERIOR OUTLINE of the building, traced per " +
          "<method> step 2a / <cross_reference> item 3: a point at every " +
          "exterior corner the plan ACTUALLY draws (each garage-wing offset, " +
          "bump-out, recess, projection, L/T/U step) -- no more, no fewer. A " +
          "genuinely rectangular house is correctly 4 points; an articulated " +
          "house naturally lands higher. Do NOT target a point count or " +
          "promote overhang offsets / dimension ticks / interior partitions " +
          "into corners; when unsure a jog is exterior, OMIT it. " +
          "ROOFED PROJECTIONS BEYOND THE FOUNDATION: this is the ROOF/EAVE " +
          "outline, which can extend PAST the foundation slab. Include any " +
          "projection that carries roof over it -- covered porch / entry / " +
          "rear patio cover, a bay-window or fireplace-chase bump-out with a " +
          "roof (the masonry chase ONLY, ~7-8 ft wide -- NEVER a room-width " +
          "jog), a cantilevered upper floor -- because each has its own eave " +
          "the gutter sits on. EXCLUDE projections with NO roof: an open deck, " +
          "a bare chimney/fireplace stack, and an UNCOVERED patio slab " +
          "(concrete only, no roof drawn over it) -- no roof means no eave " +
          "means it is NOT part of this outline. Distinguish an UNCOVERED " +
          "patio (excluded, no gutter) from a COVERED patio cover (included, " +
          "lower-tier gutter on its returns). This is the " +
          "roof outline the contractor SEES under the gutter trace, so it " +
          "must match the real building shape. VISUAL ONLY -- a footprint " +
          "corner needs no matching gutter_run or excluded_edge and does NOT " +
          "change gutter_runs, any length_ft, the total, or the CAP.",
      },
      gutter_runs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            side: {
              type: "string",
              enum: ["front", "back", "left", "right", "interior"],
            },
            start: POINT_SCHEMA,
            end: POINT_SCHEMA,
            length_ft: { type: ["number", "null"] },
            length_px: { type: "number" },
            drains_to: { type: "array", items: { type: "string" } },
            tier: { type: "string", enum: ["lower", "upper", "unknown"] },
            feature: {
              type: "string",
              enum: [
                "porch",
                "patio",
                "deck",
                "entry",
                "garage",
                "dormer",
                "main",
                "unknown",
              ],
            },
          },
          required: [
            "id",
            "side",
            "start",
            "end",
            "length_ft",
            "length_px",
            "drains_to",
          ],
        },
      },
      downspouts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            at: POINT_SCHEMA,
            from_gutter: { type: "string" },
            drop_direction: {
              type: "string",
              enum: ["front", "back", "left", "right"],
            },
            reason: {
              type: "string",
              enum: ["outside_corner", "long_run_relief", "valley_terminus"],
            },
            drop_height_ft: { type: ["number", "null"] },
          },
          required: ["id", "at", "from_gutter", "drop_direction", "reason"],
        },
      },
      excluded_edges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: [
                "rake",
                "ridge",
                "hip",
                "valley",
                "dormer_rake",
                "eave_no_gutter",
              ],
            },
            start: POINT_SCHEMA,
            end: POINT_SCHEMA,
            reason: { type: "string" },
          },
          required: ["kind", "start", "end", "reason"],
        },
      },
      totals: {
        type: "object",
        properties: {
          linear_feet_gutter: { type: ["number", "null"] },
          downspout_count: { type: "number" },
          outside_corner_miters: { type: "number" },
          inside_corner_miters: { type: "number" },
        },
        required: [
          "linear_feet_gutter",
          "downspout_count",
          "outside_corner_miters",
          "inside_corner_miters",
        ],
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      notes: { type: "array", items: { type: "string" } },
      source_page_index: {
        type: "number",
        description: "1-based page index of the roof plan in the document.",
      },
    },
    required: [
      "scale",
      "building_footprint",
      "gutter_runs",
      "downspouts",
      "excluded_edges",
      "totals",
      "confidence",
      "notes",
    ],
  },
};

const BLUEPRINT_PROBLEM_TOOL: Anthropic.Tool = {
  name: "report_problem",
  description:
    "Call this INSTEAD of record_gutter_takeoff when you cannot produce a " +
    "takeoff — e.g. the document has no roof plan, the scale is unreadable, " +
    "or the relevant pages are illegible.",
  input_schema: {
    type: "object",
    properties: {
      error: {
        type: "string",
        description: "Short problem code, e.g. 'no_roof_plan'.",
      },
      reason: {
        type: "string",
        description: "Human-readable explanation for the contractor.",
      },
    },
    required: ["error", "reason"],
  },
};

/**
 * Render Stage-1 classifier output into a prose block that gets
 * prepended to the geometry call's user message. Empty string when no
 * constraints supplied (legacy single-call mode still works for direct
 * image uploads that skip the classifier).
 */
export function buildConstraintsBlock(c: GeometryConstraints | undefined): string {
  if (!c) return "";
  const lines: string[] = [
    "GROUND-TRUTH FROM SHEET-INVENTORY PASS (already run on this PDF):",
  ];
  if (c.roof_plan_page != null) {
    lines.push(
      `- The roof plan is on page ${c.roof_plan_page}. Trace ONLY that page. ` +
        "Set source_page_index to this value. Do not trace the site plan, " +
        "floor plans, or elevations — they are reference material only.",
    );
  } else {
    lines.push(
      "- No dedicated roof plan was identified. Borrow the building " +
        "outline from the floor / foundation plan (NEVER the site plan — " +
        "it is lot-scale and inflates every measurement 3-4×), then overlay " +
        "eave-vs-rake classification from the framing sheet + elevations. " +
        "Flag this in notes and lower confidence accordingly.",
    );
  }
  if (c.elevation_summary) {
    lines.push(`- Elevation coverage: ${c.elevation_summary}.`);
  }
  if (c.building_envelope_note) {
    lines.push(`- Building envelope: ${c.building_envelope_note}.`);
  }
  if (c.roof_scale) {
    lines.push(
      `- Roof-plan scale (verbatim from the title block): ${c.roof_scale}. ` +
        "Use this to convert pixels → feet. Do NOT derive scale from page bounds.",
    );
  }
  if (c.max_total_eave_lf != null) {
    lines.push(
      `- HARD CAP — sum(gutter_runs.length_ft) MUST be ≤ ${c.max_total_eave_lf} ft. ` +
        "If your trace exceeds this, you misread the scale (likely measured " +
        "against the lot dimensions on the site plan). Re-derive scale from " +
        "a dimensioned wall before emitting JSON.",
    );
  }
  if (c.max_single_run_lf != null) {
    lines.push(
      `- HARD CAP — no single gutter_run can be longer than ${Math.round(c.max_single_run_lf)} ft ` +
        "(the building's larger dimension). A run longer than that means you " +
        "merged two segments through what should be an outside corner.",
    );
  }
  if (c.lower_tier_ft != null || c.upper_tier_ft != null) {
    lines.push(
      `- Gutter tiers (from elevation plate heights): lower = ${c.lower_tier_ft ?? "?"} ft, ` +
        `upper = ${c.upper_tier_ft ?? "?"} ft. Assign every gutter_run a tier ` +
        "(lower for single-story porch/garage sections, upper for the 2-story " +
        "main body) and set each downspout's drop_height_ft to its source run's " +
        "tier height.",
    );
  }
  if (c.min_gutter_runs != null && c.min_gutter_runs > 0) {
    lines.push(
      `- Target gutter_runs count: ~${c.min_gutter_runs} (from elevation ` +
        "eave segments). If your trace lands materially below this number, " +
        "re-examine the roof plan — you've probably missed a gable, dormer, " +
        "or porch roof. BUT do NOT fabricate runs to hit the number. " +
        "Pricing is per-LF on the gutter_runs you emit, so a phantom 30 ft " +
        "segment turns into ~$300 of phantom gutter on the contractor's " +
        "quote. If the real count is genuinely lower, return fewer and " +
        "drop confidence to 'medium' with a note.",
    );
  }
  if (c.min_downspouts != null && c.min_downspouts > 0) {
    lines.push(
      `- Downspouts visible in the elevations total ${c.min_downspouts}. ` +
        "Use that as a lower bound when placing downspouts.",
    );
  }
  if (c.global_rules.length > 0) {
    lines.push("- Plan notes that constrain the takeoff:");
    for (const r of c.global_rules) lines.push(`    * "${r}"`);
  }
  lines.push(
    "- PERIMETER CLOSURE — every side of the traced building_footprint " +
      "must be accounted for: covered by a gutter_run OR recorded as an " +
      "excluded_edge with a kind + reason. EXACTLY ONE, never BOTH: a wall " +
      "segment must NOT appear in both gutter_runs and excluded_edges — a " +
      "gable face is a rake (no gutter), an eave is a gutter, never the same " +
      "edge as both (that double-classification breaks the roof solver). " +
      "A side in neither list means " +
      "you silently dropped a wall — a common under-count. Coverage " +
      "is of perimeter length, not a 1:1 side count (merged/split runs are " +
      "fine). Classify each side from its elevation SHAPE (no hip-vs-gable " +
      "prior): a clear horizontal eave is a gutter; a gable end is its two " +
      "rakes (NO gutter across the face); close a non-draining eave or " +
      "party wall as kind 'eave_no_gutter'. Decide every side, do NOT gutter every " +
      "side — keep sum(gutter_runs.length_ft) within the HARD CAP above " +
      "and never fabricate a run just to close a side.",
  );
  lines.push("");
  return lines.join("\n") + "\n";
}

export type BlueprintRunOptions = {
  /** Stage-1 classifier output. When provided, gets injected into the
   *  user message as ground-truth constraints — the geometry pass
   *  traces ONLY the identified roof_plan_page and must meet the
   *  min_gutter_runs floor derived from the elevations. Without this
   *  the model regularly traces the site plan and returns a
   *  rectangular ~8-run trace for houses with 12-18 distinct eaves. */
  constraints?: GeometryConstraints;
  /** Vector layer extracted from the PDF — the foundation/floor-plan
   *  building outline + dimensions (authoritative footprint) and the
   *  roof-plan lines (edge-classification cross-reference). Injected as
   *  ground truth so the model sizes/shapes from the architect's real
   *  geometry instead of eyeballing pixels. null/absent → unchanged
   *  vision-only behavior. */
  vectorGeometry?: PlanVectors | null;
  /** Stage-1 classification (schedule area, width×depth, roof shape). When
   *  present, the best-of scorer additionally rewards the trace whose footprint
   *  agrees with the stated roof area — so a candidate missing a wing/mass loses.
   *  Scale-free, so a mere px→ft scale mislabel (which leaves the measured LF
   *  intact) is NOT penalized. */
  classification?: PlanClassification | null;
  /** Learned-calibration prompt block (takeoff-calibration.ts) built from
   *  this contractor's past corrected takeoffs. Injected into the USER
   *  message (never the cached system prompt) as a soft prior — "your eave
   *  totals have run ~12% high" — with an explicit instruction that the
   *  current plan's printed dimensions always win. null/absent → no-op. */
  learnedCalibration?: string | null;
};

/**
 * Heuristic quality score for a blueprint trace (higher = better) — used to
 * pick the best of several independent Opus reads. Rewards valid, articulated,
 * in-envelope geometry; punishes degenerate coords, collapsed footprints, and
 * over-cap LF.
 */
export function scoreBlueprintAnalysis(
  a: BlueprintAnalysis,
  c?: GeometryConstraints,
  classification?: PlanClassification | null,
): number {
  const fin = (p?: { x: number; y: number } | null) =>
    !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const runs = a.gutter_runs ?? [];
  const valid = runs.filter((r) => fin(r.start) && fin(r.end));
  let s = 0;
  s += valid.length * 2;
  s -= (runs.length - valid.length) * 6; // bad coords are very bad
  const fp = (a.building_footprint ?? []).filter(fin);
  s += Math.min(fp.length, 16); // articulation, capped
  if (c?.min_gutter_runs && c.min_gutter_runs > 0)
    s -= Math.abs(valid.length - c.min_gutter_runs) * 1.5;
  const totalLF = valid.reduce((t, r) => t + (r.length_ft ?? 0), 0);
  if (totalLF <= 0) s -= 20; // no priced geometry at all
  if (c?.max_total_eave_lf && totalLF > c.max_total_eave_lf)
    s -= (totalLF - c.max_total_eave_lf) * 0.1 + 8;
  s += a.confidence === "high" ? 5 : a.confidence === "medium" ? 2 : 0;

  // Geometry-quality gate (pure, unit-tested in blueprint-trace-quality.ts):
  // demote a self-intersecting/collapsed footprint (the centroid-fan cause), a
  // trace whose scale-free area falls short of the stated schedule (missing
  // wing), and a trace whose eave LF is an implausibly small fraction of the
  // footprint perimeter (an under-trace, e.g. 120 LF on a 326 ft perimeter).
  // Reject-implausible only — never fabricates or prices geometry.
  s -= geometryQualityPenalty(a, classification);
  return s;
}

/**
 * Best-of-N ensemble: run the geometry read several times IN PARALLEL and keep
 * the highest-scoring trace. Opus has no temperature pin, so independent reads
 * vary — scoring + pick-best kills the occasional bad/collapsed trace and lands
 * the most complete, in-envelope one. samples=1 is the plain single call.
 */
export async function blueprintFromPlanSourcesBestOf(
  sources: PlanSource[],
  opts: BlueprintRunOptions = {},
  samples = 3,
  /** Extra readers (e.g. a different vision model like Gemini) whose results
   *  join the same scoring pool — the genuine cross-provider ensemble. Each
   *  is wrapped so a throw / missing key can't sink the whole run. */
  extraReaders: Array<() => Promise<BlueprintResult>> = [],
): Promise<BlueprintResult> {
  const n = Math.max(1, Math.min(5, samples));
  if (n === 1 && extraReaders.length === 0)
    return blueprintFromPlanSources(sources, opts);
  const safe = (p: Promise<BlueprintResult>) =>
    p.catch((e): BlueprintResult => ({
      ok: false,
      reason: e instanceof Error ? e.message : "reader threw",
    }));
  const isOk = (
    r: BlueprintResult,
  ): r is Extract<BlueprintResult, { ok: true }> => r.ok;
  const primary = () => safe(blueprintFromPlanSources(sources, opts));
  let results = await Promise.all([
    ...Array.from({ length: n }, primary),
    ...extraReaders.map((r) => safe(r())),
  ]);
  let ok = results.filter(isOk);
  // Don't let the ensemble silently collapse to a lone read: if a transient
  // Anthropic error (429 / 5xx / timeout) sank the primary samples and we have
  // fewer than 2 good traces, retry the primary model once so the scorer still
  // has a cross-check instead of shipping a single-model best-of-1.
  if (ok.length < 2) {
    const need = Math.max(1, 2 - ok.length);
    const retries = await Promise.all(Array.from({ length: need }, primary));
    results = [...results, ...retries];
    ok = results.filter(isOk);
  }
  if (ok.length === 0) return results[0]; // all failed — surface the reason
  ok.sort(
    (a, b) =>
      scoreBlueprintAnalysis(b.analysis, opts.constraints, opts.classification) -
      scoreBlueprintAnalysis(a.analysis, opts.constraints, opts.classification),
  );
  const best = ok[0];
  const models = ok.map((r) => r.usage.model);
  best.analysis.notes = [
    ...(best.analysis.notes ?? []),
    `Best of ${ok.length} reads (${[...new Set(models)].join(", ")}) — kept the highest-scoring valid trace (simple, in-envelope footprint) from ${best.usage.model}.`,
  ];
  return best;
}

export async function blueprintFromPlanSources(
  sources: PlanSource[],
  opts: BlueprintRunOptions = {},
): Promise<BlueprintResult> {
  if (sources.length === 0) {
    return { ok: false, reason: "No plan sources supplied" };
  }
  const apiKey =
    (await getActiveApiKey("ANTHROPIC")) ?? process.env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey) {
    return { ok: false, reason: "Anthropic API key not configured" };
  }

  const client = new Anthropic({ apiKey });
  const t0 = Date.now();

  const constraintsBlock = buildConstraintsBlock(opts.constraints);

  // Build the content blocks: each PDF as a document, each image as an image.
  const userContent: Anthropic.MessageParam["content"] = [
    {
      type: "text",
      text:
        "Construction plans attached. Find the roof plan page(s) and return " +
        "the gutter layout JSON per the schema.\n\n" +
        constraintsBlock +
        buildVectorBlock(opts.vectorGeometry) +
        (opts.learnedCalibration ?? "") +
        "OUTPUT FORMAT: respond with a single JSON object only. No preamble, " +
        "no commentary, no markdown code fences. The response must start " +
        "with `{` and end with `}`. The downstream parser extracts the " +
        "substring between the first `{` and the last `}` — anything " +
        "outside that range is discarded.",
    },
    ...sources.map((s) => {
      switch (s.kind) {
        case "pdf":
          return {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: s.base64,
            },
          } as const;
        case "pdf-url":
          return {
            type: "document",
            source: { type: "url", url: s.url },
          } as const;
        case "image":
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: s.mediaType,
              data: s.base64,
            },
          } as const;
        case "image-url":
          return {
            type: "image",
            source: { type: "url", url: s.url },
          } as const;
      }
    }),
  ];

  try {
    // Stale-override guard: an /admin/prompts override saved before the
    // hip-evidence + roof-form blocks existed would silently regress every
    // takeoff — bypass it for the code default (loud console warning).
    const blueprintSystem = await getPrompt(
      "blueprint.takeoff.system",
      BLUEPRINT_FROM_PLANS_SYSTEM,
      { requiredMarkers: ["read_all_sheets", "roof_forms"] },
    );
    const response = await client.messages.create({
      model: MODEL,
      // Sonnet's per-token generation rate is the main wall-clock cost
      // here. The typical takeoff (15-20 runs + 10 downspouts + 10
      // excluded edges) finishes in ~3000-4000 output tokens. 16000
      // was leaving 12k of headroom that generation latency had to
      // walk through every time. 6000 covers the long tail (complex
      // 30-segment trace with full excluded_edges) and trims ~15-25s
      // off wall-clock for typical jobs. Bumped 6000→8000 for headroom
      // now that the result comes back as a forced tool call (no prose
      // preamble eats the budget). Bumped 8000→12000 because the prompt
      // now also records the interior ridge/hip/valley roof-plane lines
      // into excluded_edges (decorative); a complex cross-gable/hip roof
      // can add 15-40 interior segments (~+800-2800 tokens) on exactly
      // the case the cap was tuned tight for. If output still truncates,
      // the stop_reason branch below salvages the priced fields.
      max_tokens: 12000,
      // NOTE: Opus 4.8 rejects `temperature` ("deprecated for this model"),
      // so it's omitted — the model is deterministic enough here without it.
      system: [
        {
          type: "text",
          text: blueprintSystem,
          // Cache the ~3k-token system prompt across blueprint runs.
          // Cuts input cost ~90% from the second blueprint onward.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        { role: "user", content: userContent },
        // No assistant prefill — Claude 4+ (incl. Sonnet 4.6) rejects it
        // ("This model does not support assistant message prefill"). We
        // force a tool call instead (tool_choice below), so the result is
        // structured JSON in a tool_use block rather than free text we'd
        // have to scrape a `{ … }` out of.
      ],
      // tool_choice "any" → the model MUST answer through one of these
      // tools, so it can never emit a prose-only response that has no
      // JSON object. disable_parallel_tool_use → exactly one call back.
      tools: [BLUEPRINT_TAKEOFF_TOOL, BLUEPRINT_PROBLEM_TOOL],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    });

    // The model answers through a forced tool call, so the result is a
    // tool_use block whose `input` is already-parsed JSON — no text
    // scraping, no "had no JSON object" failure mode.
    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (!toolUse) {
      // No tool call came back — the model was cut off before emitting
      // one (max_tokens) or it refused. Surface a clear, actionable
      // reason instead of a generic parse error.
      const truncated = response.stop_reason === "max_tokens";
      const textPreview = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .slice(0, 200);
      return {
        ok: false,
        reason: truncated
          ? "Claude analysis was truncated before it returned any tool call (hit max_tokens — bump max_tokens in blueprint-from-plans.ts)."
          : `Claude did not return a takeoff (stop_reason=${response.stop_reason}). First 200 chars: ${textPreview}`,
      };
    }

    // report_problem → the model couldn't produce a takeoff (no roof
    // plan, unreadable scale, etc.). Surface its reason to the contractor.
    if (toolUse.name === BLUEPRINT_PROBLEM_TOOL.name) {
      const obj = toolUse.input as { error?: string; reason?: string };
      return {
        ok: false,
        reason: `${obj.error ?? "Could not analyze plan"}: ${obj.reason ?? "(no reason)"}`,
      };
    }

    // record_gutter_takeoff truncated mid-input. The interior
    // ridge/hip/valley lines are emitted LAST and are decorative, so a
    // truncation usually lops off trailing excluded_edges, not the priced
    // data. If the priced fields (gutter_runs + totals) already came back
    // intact, salvage the takeoff: drop any partially-emitted trailing
    // excluded_edges and note it, rather than throwing away a fully-priced
    // result. Only hard-fail when the priced fields themselves are
    // incomplete.
    if (response.stop_reason === "max_tokens") {
      const partial = toolUse.input as Partial<BlueprintAnalysis>;
      const pricedOk =
        Array.isArray(partial.gutter_runs) &&
        partial.gutter_runs.length > 0 &&
        partial.totals != null;
      if (!pricedOk) {
        return {
          ok: false,
          reason:
            "Claude analysis was truncated at max_tokens before the priced gutter_runs/totals were complete. Bump max_tokens in blueprint-from-plans.ts and re-analyze.",
        };
      }
      const salvaged: BlueprintAnalysis = {
        ...(partial as BlueprintAnalysis),
        // Last-emitted excluded_edge may be cut off mid-object; drop it.
        excluded_edges: Array.isArray(partial.excluded_edges)
          ? partial.excluded_edges.filter(
              (e) => e && e.kind && e.start && e.end,
            )
          : [],
        notes: [
          ...(Array.isArray(partial.notes) ? partial.notes : []),
          "Output truncated at max_tokens; interior roof-plane lines may be incomplete (decorative only). Priced runs/totals are intact.",
        ],
      };
      return {
        ok: true,
        analysis: salvaged,
        usage: {
          model: MODEL,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_hit: (response.usage.cache_read_input_tokens ?? 0) > 0,
          duration_ms: Date.now() - t0,
        },
      };
    }

    const analysis = toolUse.input as BlueprintAnalysis;
    return {
      ok: true,
      analysis,
      usage: {
        model: MODEL,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_hit: (response.usage.cache_read_input_tokens ?? 0) > 0,
        duration_ms: Date.now() - t0,
      },
    };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Claude blueprint analysis failed",
    };
  }
}
