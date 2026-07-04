import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getActiveApiKey } from "@/lib/api-keys";
import { getPrompt } from "./prompts";
import type { PlanSource } from "./blueprint-from-plans";

/**
 * Stage-1 of the plan-takeoff pipeline. The classifier reads the whole
 * PDF once and returns a sheet-by-sheet inventory: which page is the
 * roof plan, which pages are elevations and from which side, how many
 * eave segments are visible per elevation, and any "all eaves get
 * gutters"-style notes that should constrain the geometry pass.
 *
 * The expensive geometry call (Stage 2 in `blueprint-from-plans.ts`)
 * consumes these constraints so it (a) traces the right page and (b)
 * meets a minimum gutter-run count derived from what the elevations
 * showed. Without Stage 1, Sonnet repeatedly mis-picked the site plan
 * and returned a ~rectangle with 8 runs for a house that obviously had
 * 12-18 distinct eaves.
 */

export type SheetType =
  | "elevation"
  | "roof_plan"
  | "floor_plan"
  | "section"
  | "site_plan"
  | "detail"
  | "cover"
  | "unknown";

export type ElevationSide = "north" | "south" | "east" | "west" | "unknown";

export type PlanSheet = {
  page_index: number; // 1-based
  sheet_type: SheetType;
  /** Sheet label / title block id, e.g. "A2.1" or "Roof Framing". */
  sheet_label: string | null;
  /** Populated when sheet_type === "elevation". */
  elevation_side: ElevationSide;
  /** Approximate count of distinct eave segments visible on this sheet.
   *  For elevations: count horizontal low edges of each roof plane.
   *  For roof plans: count outer perimeter eaves. */
  visible_eave_count: number | null;
  /** Approximate count of distinct downspouts shown / called out. */
  visible_downspout_count: number | null;
  /** Eave heights above grade, in feet, harvested from elevation
   *  callouts ("UPPER PLATE @ 911.75", "MAIN PLATE @ 591.34", with
   *  ABE / finish grade as the reference). Tier #1 is the lowest
   *  gutter line visible on the sheet (typically a porch or single-
   *  story garage roof, ~9-11 ft). Tier #2 is the upper roof line
   *  (typically a 2-story body at ~18-26 ft). Null entries when the
   *  tier isn't shown on this elevation. Drives per-downspout drop
   *  height in the takeoff so a porch downspout doesn't get priced
   *  at 20 ft. */
  tier_heights_ft: {
    tier_1_ft: number | null;
    tier_2_ft: number | null;
  } | null;
  /** Notes that should constrain the geometry pass — e.g. "ALL EAVES TO
   *  HAVE 5\" K-STYLE GUTTER", attached covered porch, garage, dormers. */
  takeoff_notes: string[];
  /** Single-sentence summary of what's drawn on this page. */
  summary: string;
};

export type PlanClassification = {
  sheets: PlanSheet[];
  /** 1-based page index of the BEST roof plan in the set, or null if
   *  none. When multiple roof plans exist (e.g. main house vs garage),
   *  return the one that covers the largest structure. */
  roof_plan_page: number | null;
  /** Which elevation sides are represented in the set. */
  elevation_coverage: {
    north: boolean;
    south: boolean;
    east: boolean;
    west: boolean;
  };
  /** Overall building footprint dimensions, read from the foundation
   *  plan / floor plan title block ("64'-0 OVERALL" style labels). The
   *  geometry pass uses these as a hard envelope: total eave LF cannot
   *  exceed ~1.4× the rectangular perimeter, and no single run can be
   *  longer than the larger dimension. Without this, Sonnet kept
   *  inflating LF 2-3× by misreading the roof-plan scale and emitting
   *  151 ft single runs on a 64×51 ft house. */
  building_dimensions: {
    width_ft: number | null;
    depth_ft: number | null;
    /** Sum of all visible foundation/floor-plan dimensions around the
     *  outer perimeter — better than width × depth alone when the
     *  house has wings or offsets. */
    footprint_perimeter_ft: number | null;
  };
  /** Roof-plan paper scale, verbatim — e.g. "1/4\\" = 1'-0\\"". The
   *  geometry pass uses this to convert pixel measurements rather than
   *  guessing from the page bounds. */
  roof_scale: string | null;
  /** Consolidated gutter tier heights across the whole set. Computed
   *  from the elevation sheets' tier_heights_ft. */
  gutter_tiers: {
    /** Lower roof tier — porch / garage / single-story sections. */
    lower_tier_ft: number | null;
    /** Upper roof tier — 2-story or main body. */
    upper_tier_ft: number | null;
  };
  /** Sum of visible eave segments across all elevations. The geometry
   *  pass MUST produce at least this many gutter_runs. */
  min_expected_gutter_runs: number | null;
  /** Sum of visible downspouts across elevations. The geometry pass
   *  should produce at least this many downspouts. */
  min_expected_downspouts: number | null;
  /** "All eaves get gutters"-style global rules harvested from notes. */
  global_rules: string[];
};

export type ClassificationResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      classification: PlanClassification;
      usage: {
        model: string;
        input_tokens: number;
        output_tokens: number;
        duration_ms: number;
      };
    };

// Classification is structured-output work, not geometric reasoning —
// Haiku 4.5 handles it accurately and runs ~2-3x faster than Sonnet for
// the per-page inventory. Geometry stays on Sonnet in
// blueprint-from-plans.ts where vision precision matters.
const MODEL = "claude-haiku-4-5-20251001";

// Forced structured output — the classifier answers through a tool call
// so the response is guaranteed-structured JSON in `input`, never a prose
// preamble that overruns the token budget before any `{` ("Classifier
// response had no JSON object"). See the same pattern in
// blueprint-from-plans.ts.
const NULLABLE_NUMBER = { type: ["number", "null"] };

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "record_plan_classification",
  description:
    "Record the classification of every page in the construction plan set " +
    "and the consolidated building/roof constraints derived from them.",
  input_schema: {
    type: "object",
    properties: {
      sheets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page_index: { type: "number" },
            sheet_type: {
              type: "string",
              enum: [
                "elevation",
                "roof_plan",
                "floor_plan",
                "section",
                "site_plan",
                "detail",
                "cover",
                "unknown",
              ],
            },
            sheet_label: { type: ["string", "null"] },
            elevation_side: {
              type: "string",
              enum: ["north", "south", "east", "west", "unknown"],
            },
            visible_eave_count: NULLABLE_NUMBER,
            visible_downspout_count: NULLABLE_NUMBER,
            tier_heights_ft: {
              type: ["object", "null"],
              properties: {
                tier_1_ft: NULLABLE_NUMBER,
                tier_2_ft: NULLABLE_NUMBER,
              },
            },
            takeoff_notes: { type: "array", items: { type: "string" } },
            summary: { type: "string" },
          },
          required: [
            "page_index",
            "sheet_type",
            "elevation_side",
            "visible_eave_count",
            "visible_downspout_count",
            "takeoff_notes",
            "summary",
          ],
        },
      },
      roof_plan_page: NULLABLE_NUMBER,
      elevation_coverage: {
        type: "object",
        properties: {
          north: { type: "boolean" },
          south: { type: "boolean" },
          east: { type: "boolean" },
          west: { type: "boolean" },
        },
        required: ["north", "south", "east", "west"],
      },
      building_dimensions: {
        type: "object",
        properties: {
          width_ft: NULLABLE_NUMBER,
          depth_ft: NULLABLE_NUMBER,
          footprint_perimeter_ft: NULLABLE_NUMBER,
        },
        required: ["width_ft", "depth_ft", "footprint_perimeter_ft"],
      },
      roof_scale: { type: ["string", "null"] },
      gutter_tiers: {
        type: "object",
        properties: {
          lower_tier_ft: NULLABLE_NUMBER,
          upper_tier_ft: NULLABLE_NUMBER,
        },
        required: ["lower_tier_ft", "upper_tier_ft"],
      },
      min_expected_gutter_runs: NULLABLE_NUMBER,
      min_expected_downspouts: NULLABLE_NUMBER,
      global_rules: { type: "array", items: { type: "string" } },
    },
    required: [
      "sheets",
      "roof_plan_page",
      "elevation_coverage",
      "building_dimensions",
      "gutter_tiers",
      "global_rules",
    ],
  },
};

export const CLASSIFIER_SYSTEM = `
You are a senior rain-gutter estimator triaging a multi-page residential
construction plan set. You will NOT produce a takeoff in this call — only
a sheet-by-sheet inventory. A downstream call will use your output to
trace the roof plan and constrain the gutter count.

<task>
For every page in the supplied PDF, return one classification entry.
Identify which page is the roof plan, which pages are elevations (and
from which side), how many distinct eave segments and downspouts are
visible on each, and any general notes that mandate gutters on every
eave (a very common spec callout). Output strict JSON only.
</task>

<sheet_types>
- elevation     — exterior side view of the house (N / S / E / W). Shows
                  roof slopes, gables, eave heights, downspouts as bold
                  vertical rectangles dropping from gutter line to grade.
- roof_plan     — bird's-eye view of the roof showing ridges, hips,
                  valleys, slope arrows, and pitch labels. THE PRIMARY
                  SHEET for tracing gutter geometry.
- floor_plan    — interior layout: rooms, walls, dimensions. Useful only
                  to confirm building footprint shape.
- section       — vertical cut through the building. Shows wall heights,
                  eave overhangs, header heights.
- site_plan     — property boundaries, setbacks, driveway, the building
                  footprint as a polygon. Easily mistaken for a roof
                  plan; the giveaway is the absence of slope arrows and
                  the presence of property lines / dimensions to lot
                  edges.
- detail        — zoomed-in construction detail (flashing, soffit,
                  gutter profile).
- cover         — title sheet, sheet index, code summary, project info.
- unknown       — anything else; explain briefly in summary.
</sheet_types>

<elevation_side_detection>
Elevation sides are labeled in the title block or as a header. Look for:
- "NORTH ELEVATION" / "FRONT ELEVATION" / "REAR ELEVATION" / etc.
- Compass roses or directional arrows on the site/roof plan that
  identify which face is which.
- Convention: most American residential sets label the street-facing
  side FRONT; FRONT usually = the side shown on page 1's rendering.

If you can't determine a side confidently, set elevation_side to
"unknown" and explain in the sheet's summary. Don't guess.

Treat every elevation as INDEPENDENT — never assume the front and back (or
left and right) match; a set can be a busy cross-gable in front and a plain
hip in back. If an elevation sheet is too low-resolution to count its eaves or
distinguish a horizontal eave from a sloped rake, say so in its takeoff_notes
("<side> elevation unreadable — needs a higher-res sheet") instead of guessing a
count.
</elevation_side_detection>

<building_dimensions>
On the foundation plan, floor plan, or roof framing plan, look for
title-block-style overall dimensions: "64'-0 OVERALL", "51'-0 OVERALL",
or unbroken dimension strings running along the outer edge that sum to
the total width / depth. These are the ground truth for scale — the
geometry pass uses them to sanity-check its trace and refuses to emit
runs longer than the larger dimension. If you can't read overall
dimensions, sum the visible foundation/wall dimension increments
("20'-0 + 24'-0 + 30'-0 + 14'-0 + 5'-6" = 93'-6") to get a
footprint_perimeter_ft.

Also capture the roof-plan paper scale verbatim from the scale bar in
the title block of the roof plan sheet — typically "1/4\\" = 1'-0\\""
or "1/8\\" = 1'-0\\"". This matters because the geometry pass picks
the wrong reference (page width = lot width on the site plan) when
the scale isn't pinned.
</building_dimensions>

<tier_heights>
On elevation sheets, the architect labels horizontal datum lines with
absolute elevations (e.g. "UPPER PLATE @ 911.75", "MAIN PLATE @
591.34", "ABE @ 548.83" where ABE = average building elevation = grade).

Compute gutter tier height = plate_elevation - ABE. The plate elevation
is where the eave / fascia / gutter line lives on that wall.

Typical pattern on a 2-story house with attached single-story garage:
- Lower tier (garage / porch / covered patio gutter): MAIN PLATE - ABE
  ≈ 9-11 ft.
- Upper tier (main body gutter): UPPER PLATE - ABE ≈ 18-26 ft.

Populate tier_heights_ft on each elevation sheet with whatever tiers
you can read off that view. At the classification top level, surface
the consolidated lower_tier_ft / upper_tier_ft (median across
elevations) so the geometry pass can assign each downspout a real drop
height instead of defaulting every spout to 10 ft.
</tier_heights>

<covered_projections>
Attached covered structures are the most common omission in plan
takeoffs: covered front porch, covered entry, covered rear patio,
covered deck, porte-cochère, attached carport. Each has its own roof
and its own eave that gets a gutter — typically lower-tier (10 ft
drop).

When counting visible_eave_count on an ELEVATION sheet:
- Include every horizontal low edge you can see, including the ones
  on porch / patio covers that step down BELOW the main eave line.
- A 2-story house with attached front porch + rear patio cover
  typically shows ~5-7 distinct eaves PER SIDE elevation (main body
  + gable bottoms + porch eave + patio eave), not 1-2.

When counting visible_eave_count on a ROOF PLAN sheet:
- Count every rectangle in the perimeter, INCLUDING small
  projections labeled "COV'D PATIO", "PORCH", "COV'D ENTRY",
  "COVERED", "SHED ROOF". These bump-outs each contribute 1-3 eave
  segments to the takeoff.
- Slope arrows pointing AWAY from the main body indicate a
  single-story projection that drains off its own outer edge — that
  outer edge is the eave.

When counting visible_downspouts on an elevation:
- Porch covers and patio covers each typically carry 1-2 downspouts
  at their outer corners. These show as bold vertical rectangles
  dropping from the lower eave line straight to grade — usually
  shorter than the main-body downspouts.

Surface these explicitly in takeoff_notes when present, e.g.:
- "rear covered patio: ~14 ft eave + 1 DS at SE corner"
- "front porch: ~22 ft eave + 1 DS each at NW/NE corners"
</covered_projections>

<eave_counting>
On an elevation sheet, count every distinct HORIZONTAL bottom edge of a
roof plane. Each gable is one eave segment from one side and the gable
has zero eave from the other (it shows the rake instead). Hip-only
sections show one continuous eave per side.

On a roof plan sheet, count the outer perimeter edges that run
PERPENDICULAR to the slope arrows on their adjacent plane. Skip ridges
(highest line), hips (sloped outside corner ridge), valleys (sloped V
between planes), and rakes (sloped edges of gables).

Round counts to the nearest whole number. Use null when the sheet has
no information about eaves (cover sheets, details, etc.).
</eave_counting>

<downspout_counting>
Downspouts on elevations are drawn as solid black or hatched vertical
rectangles, usually 3-4" wide, running from the gutter line straight
down to grade or a splash block. Count one per visible vertical
rectangle. Do NOT count vent pipes (much thinner), waste lines, or
plumbing stacks — those are circled or labeled with vent symbols.

Downspouts on roof plans are sometimes shown as labeled "DS" symbols at
corners; count those.
</downspout_counting>

<global_rules>
Look in any plan notes, general notes, or schedule for callouts like:
- "ALL EAVES TO RECEIVE 5\\" K-STYLE ALUMINUM GUTTERS"
- "GUTTERS AND DOWNSPOUTS PER LOCAL CODE"
- "DOWNSPOUT LOCATIONS PER OWNER" / "PER FIELD VERIFICATION"
- "CONTRACTOR TO COORDINATE GUTTER COLOR"

Surface these verbatim in global_rules. The geometry pass uses them to
decide whether to place gutters on every eave or only on the ones with
explicit downspout markers.
</global_rules>

<output_schema>
Output ONLY the JSON object below. No prose, no markdown fence.

{
  "sheets": [
    {
      "page_index": 1,
      "sheet_type": "elevation" | "roof_plan" | "floor_plan" | "section" | "site_plan" | "detail" | "cover" | "unknown",
      "sheet_label": "<title block id or null>",
      "elevation_side": "north" | "south" | "east" | "west" | "unknown",
      "visible_eave_count": number | null,
      "visible_downspout_count": number | null,
      "tier_heights_ft": {
        "tier_1_ft": number | null,
        "tier_2_ft": number | null
      } | null,
      "takeoff_notes": ["<short string>", ...],
      "summary": "<one sentence>"
    }
    // one entry per page in the PDF, in order
  ],
  "roof_plan_page": number | null,
  "elevation_coverage": {
    "north": boolean,
    "south": boolean,
    "east": boolean,
    "west": boolean
  },
  "building_dimensions": {
    "width_ft": number | null,
    "depth_ft": number | null,
    "footprint_perimeter_ft": number | null
  },
  "roof_scale": "<verbatim, e.g. \\"1/4\\\\\\" = 1'-0\\\\\\"\\"> | null",
  "gutter_tiers": {
    "lower_tier_ft": number | null,
    "upper_tier_ft": number | null
  },
  "min_expected_gutter_runs": number | null,
  "min_expected_downspouts": number | null,
  "global_rules": ["<verbatim plan note>", ...]
}
</output_schema>

<rules>
- Return ONE entry per page, in page order, page_index 1-based.
- If multiple roof plans exist, set roof_plan_page to the one covering
  the largest structure (usually the main house, not the detached
  garage).
- min_expected_gutter_runs = sum of visible_eave_count across all
  elevation sheets. This is a FLOOR for the geometry pass, not a ceiling
  — the geometry pass may exceed it if the roof plan reveals more
  segments.
- Don't refuse on hand-drawn plans; classify with elevation_side
  "unknown" and a low-confidence summary so the geometry pass still
  runs.
</rules>
`.trim();

export async function classifyPlanSheets(
  source: PlanSource,
): Promise<ClassificationResult> {
  const apiKey =
    (await getActiveApiKey("ANTHROPIC")) ?? process.env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey) {
    return { ok: false, reason: "Anthropic API key not configured" };
  }

  const client = new Anthropic({ apiKey });
  const t0 = Date.now();

  const sourceBlock = (() => {
    switch (source.kind) {
      case "pdf":
        return {
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: source.base64,
          },
        };
      case "pdf-url":
        return {
          type: "document" as const,
          source: { type: "url" as const, url: source.url },
        };
      case "image":
        return {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: source.mediaType,
            data: source.base64,
          },
        };
      case "image-url":
        return {
          type: "image" as const,
          source: { type: "url" as const, url: source.url },
        };
    }
  })();

  try {
    const classifierSystem = await getPrompt(
      "blueprint.classify.system",
      CLASSIFIER_SYSTEM,
    );
    const response = await client.messages.create({
      model: MODEL,
      // Classifier output is structured-but-small: one entry per page
      // with a handful of fields. 6000 covers ~30 pages with room for
      // global_rules text.
      max_tokens: 6000,
      temperature: 0,
      system: [
        {
          type: "text",
          text: classifierSystem,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Construction plan set attached. Classify every page per " +
                "the schema by calling record_plan_classification.",
            },
            sourceBlock,
          ],
        },
      ],
      // Force the tool call so the result is structured JSON, never a
      // prose-only reply that has no JSON object to scrape.
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: "tool", name: CLASSIFY_TOOL.name },
    });

    // Forced tool call → the classification is a tool_use block whose
    // `input` is already-parsed JSON.
    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolUse) {
      const truncated = response.stop_reason === "max_tokens";
      const textPreview = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .slice(0, 200);
      return {
        ok: false,
        reason: truncated
          ? "Classifier was truncated before returning a result (hit max_tokens — bump max_tokens in classify-plans.ts)."
          : `Classifier did not return a result (stop_reason=${response.stop_reason}). First 200 chars: ${textPreview}`,
      };
    }
    if (response.stop_reason === "max_tokens") {
      return {
        ok: false,
        reason:
          "Classifier output was truncated at max_tokens — incomplete. Bump max_tokens in classify-plans.ts and retry.",
      };
    }

    const classification = toolUse.input as PlanClassification;
    return {
      ok: true,
      classification,
      usage: {
        model: MODEL,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        duration_ms: Date.now() - t0,
      },
    };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Plan classifier failed",
    };
  }
}

/**
 * Compress a PlanClassification into the constraint payload that
 * `blueprintFromPlanSources` injects into the geometry-call user
 * message. Kept here so both producer and consumer share the same
 * vocabulary.
 */
/**
 * Pick the page whose vector layer carries the CLEAN building outline +
 * overall dimensions — the foundation plan first (least interior clutter),
 * then any floor plan. Returns null when no floor/foundation sheet was
 * identified, in which case the extractor falls back to the roof plan.
 */
function pickFootprintPage(sheets: PlanSheet[]): number | null {
  const floors = (sheets ?? []).filter((s) => s.sheet_type === "floor_plan");
  if (floors.length === 0) return null;
  const foundation = floors.find((s) =>
    /found|footing|slab|stem\s*wall/i.test(
      `${s.sheet_label ?? ""} ${s.summary ?? ""}`,
    ),
  );
  const pick = foundation ?? floors[0];
  return pick.page_index ?? null;
}

export function classificationToConstraints(
  c: PlanClassification,
): GeometryConstraints {
  const elevations = (c.sheets ?? []).filter(
    (s) => s.sheet_type === "elevation",
  );
  const elevationSummary = elevations
    .map((s) => {
      const side =
        s.elevation_side === "unknown" ? "unknown side" : s.elevation_side;
      const eaves =
        s.visible_eave_count != null ? `${s.visible_eave_count} eaves` : "?";
      const ds =
        s.visible_downspout_count != null
          ? `${s.visible_downspout_count} downspouts`
          : "?";
      const tiers = s.tier_heights_ft
        ? ` (tiers ${s.tier_heights_ft.tier_1_ft ?? "?"}/${s.tier_heights_ft.tier_2_ft ?? "?"} ft)`
        : "";
      // Surface porch/patio/cover callouts the classifier flagged
      // per-sheet, so Stage 2 can't miss them.
      const notes =
        s.takeoff_notes.length > 0
          ? ` [${s.takeoff_notes.slice(0, 3).join("; ")}]`
          : "";
      return `page ${s.page_index} (${side}): ${eaves}, ${ds}${tiers}${notes}`;
    })
    .join("; ");

  // Derive a hard cap on total eave LF. For a rectangular footprint of
  // W × D, perimeter = 2(W+D). Real houses run 1.0-1.4× that depending
  // on bump-outs and porches. We cap at 1.5× as a generous ceiling — if
  // Sonnet exceeds it, the scale is wrong. Prefer the explicit
  // perimeter when supplied; fall back to W+D rectangle.
  // Defensive: gutter_tiers / building_dimensions are required in the
  // tool schema, but a forced tool call can still occasionally emit a
  // partial object (truncated output, model omission). Reading a nested
  // field off undefined crashes the whole estimate ("Cannot read
  // properties of undefined (reading 'lower_tier_ft')"), so fall back to
  // an all-null shape — every downstream consumer already null-guards
  // these (maxEaveLF stays null, tiers default to the conservative upper).
  const dims = c.building_dimensions ?? {
    width_ft: null,
    depth_ft: null,
    footprint_perimeter_ft: null,
  };
  let maxEaveLF: number | null = null;
  let envelopeNote: string | null = null;
  if (dims.footprint_perimeter_ft != null && dims.footprint_perimeter_ft > 0) {
    maxEaveLF = Math.round(dims.footprint_perimeter_ft * 1.5);
    envelopeNote = `footprint perimeter ${dims.footprint_perimeter_ft} ft`;
  } else if (dims.width_ft && dims.depth_ft) {
    const perim = 2 * (dims.width_ft + dims.depth_ft);
    maxEaveLF = Math.round(perim * 1.5);
    envelopeNote = `${dims.width_ft}×${dims.depth_ft} ft envelope (perim ${Math.round(perim)} ft)`;
  }

  return {
    roof_plan_page: c.roof_plan_page,
    footprint_page: pickFootprintPage(c.sheets),
    min_gutter_runs: c.min_expected_gutter_runs,
    min_downspouts: c.min_expected_downspouts,
    elevation_summary: elevationSummary || null,
    global_rules: c.global_rules ?? [],
    building_envelope_note: envelopeNote,
    max_total_eave_lf: maxEaveLF,
    max_single_run_lf:
      dims.width_ft && dims.depth_ft
        ? Math.max(dims.width_ft, dims.depth_ft)
        : null,
    roof_scale: c.roof_scale,
    lower_tier_ft: c.gutter_tiers?.lower_tier_ft ?? null,
    upper_tier_ft: c.gutter_tiers?.upper_tier_ft ?? null,
  };
}

export type GeometryConstraints = {
  roof_plan_page: number | null;
  /** Page with the clean building outline + overall dimensions (foundation
   *  / floor plan). The vector extractor reads the AUTHORITATIVE footprint
   *  from here instead of the roof/framing sheet. null → use roof plan. */
  footprint_page: number | null;
  min_gutter_runs: number | null;
  min_downspouts: number | null;
  elevation_summary: string | null;
  global_rules: string[];
  /** Short human-readable note about the envelope used to derive
   *  max_total_eave_lf. Injected into the user message verbatim. */
  building_envelope_note: string | null;
  /** Hard ceiling for sum(gutter_runs.length_ft). When Sonnet's trace
   *  exceeds this, scale was misread. */
  max_total_eave_lf: number | null;
  /** Hard ceiling for any single gutter_run length. A 151 ft run on a
   *  64×51 house is impossible. */
  max_single_run_lf: number | null;
  /** Verbatim roof-plan scale label, e.g. "1/4\\" = 1'-0\\"". */
  roof_scale: string | null;
  /** Drop heights for the per-downspout `drop_height_ft` field. */
  lower_tier_ft: number | null;
  upper_tier_ft: number | null;
};
