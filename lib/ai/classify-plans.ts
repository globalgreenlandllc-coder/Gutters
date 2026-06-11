import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getActiveApiKey } from "@/lib/api-keys";
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

const CLASSIFIER_SYSTEM = `
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
</elevation_side_detection>

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
          text: CLASSIFIER_SYSTEM,
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
                "the schema. Respond with a single JSON object only — no " +
                "preamble, no markdown fence. The response must start with " +
                "`{` and end with `}`.",
            },
            sourceBlock,
          ],
        },
      ],
    });

    const body = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const firstBrace = body.indexOf("{");
    const lastBrace = body.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return {
        ok: false,
        reason: `Classifier response had no JSON object. First 200 chars: ${body.slice(0, 200)}`,
      };
    }
    const raw = body.slice(firstBrace, lastBrace + 1);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const truncated = response.stop_reason === "max_tokens";
      const baseMsg = (e as Error).message;
      const hint = truncated
        ? " (output was truncated at max_tokens — bump max_tokens in classify-plans.ts)"
        : "";
      return {
        ok: false,
        reason: `Classifier returned unparseable JSON: ${baseMsg}${hint}. First 200 chars: ${raw.slice(0, 200)}`,
      };
    }

    const classification = parsed as PlanClassification;
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
export function classificationToConstraints(
  c: PlanClassification,
): GeometryConstraints {
  const elevations = c.sheets.filter((s) => s.sheet_type === "elevation");
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
      return `page ${s.page_index} (${side}): ${eaves}, ${ds}`;
    })
    .join("; ");

  return {
    roof_plan_page: c.roof_plan_page,
    min_gutter_runs: c.min_expected_gutter_runs,
    min_downspouts: c.min_expected_downspouts,
    elevation_summary: elevationSummary || null,
    global_rules: c.global_rules,
  };
}

export type GeometryConstraints = {
  roof_plan_page: number | null;
  min_gutter_runs: number | null;
  min_downspouts: number | null;
  elevation_summary: string | null;
  global_rules: string[];
};
