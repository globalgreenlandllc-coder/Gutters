import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getActiveApiKey } from "@/lib/api-keys";
import type { GeometryConstraints } from "./classify-plans";

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

const BLUEPRINT_FROM_PLANS_SYSTEM = `
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

<cross_reference>
Do not trace the roof plan in isolation. Every residential plan set
has 3-5 sheets that constrain the takeoff and you MUST reconcile
across them before emitting geometry:

1. ROOF PLAN — gives you the geometry (perimeter shape, slope
   arrows, ridge/hip/valley lines). This is where coordinates come
   from. The roof framing plan with truss layout works too: the
   outer edge of the truss layout = roof perimeter; eaves are the
   edges perpendicular to the truss span direction.

2. ELEVATIONS — give you the eave count per side, the gable/dormer
   geometry, and the tier heights. If the front elevation shows
   3 distinct horizontal eaves (e.g. main body + front gable + porch
   gable), the front side of your roof plan trace MUST have 3
   matching eave segments. A single 64-ft eave across the front of
   a 3-gable house is wrong.

3. FOUNDATION PLAN / MAIN FLOOR PLAN — gives you the building
   envelope dimensions in feet. Use these to calibrate scale, not
   the page bounds.

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

1. Locate the roof plan page in the supplied document. If none is visible,
   output {"error":"no_roof_plan","reason":"<what you see instead>"} and stop.

2. Trace the building footprint as drawn on the roof plan. If there are
   multiple structures (main house + detached garage), trace each.

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
      "tier": "lower" | "upper" | "unknown"
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
4. Do this self-correction silently — the response should still be
   strict JSON, no commentary.
</scale_discipline>

<tier_assignment>
Each gutter_run sits on a roof tier. On a 2-story house with attached
single-story garage / front porch / rear covered patio:
- "lower" tier = single-story sections (garage, porch, patio cover).
  Drop height typically 9-11 ft.
- "upper" tier = 2-story main body. Drop height typically 18-26 ft.

Cues from the roof plan:
- Lower-tier runs are usually on bump-outs that protrude from the main
  rectangle (front porch projecting forward, garage wing, rear patio).
- Upper-tier runs are the main body perimeter.
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

If the plan note says "PROVIDE CONTINUOUS GUTTERS @ ALL EAVES,
TYP." then every horizontal eave on the roof plan becomes a
gutter_run (subject to the splitting rules at outside corners).
If the plan is silent, default to "all eaves get gutters" — that's
the residential norm.
</lf_accounting>

<rules>
- Coordinate origin is TOP-LEFT of the source page, x→right, y→down. Use the
  raw pixel coordinates the plan was rendered at; do not rescale.
- Every excluded perimeter edge MUST appear in excluded_edges with a kind +
  reason. This proves you considered it and rejected it deliberately.
- Hand-sketched / red-line plans → confidence "low" + a clear note. Don't
  refuse — return your best estimate so the contractor has something to edit.
- For multi-page plan sets, only the roof plan page produces gutter_runs.
  Floor plans, site plans, and elevations are ignored.
- If the roof plan is rotated or upside-down, still use raw pixel coordinates;
  the contractor will rotate the rendered blueprint in the proposal.
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

const MODEL = "claude-sonnet-4-6";

/**
 * Render Stage-1 classifier output into a prose block that gets
 * prepended to the geometry call's user message. Empty string when no
 * constraints supplied (legacy single-call mode still works for direct
 * image uploads that skip the classifier).
 */
function buildConstraintsBlock(c: GeometryConstraints | undefined): string {
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
      "- No dedicated roof plan was identified. Use the elevations and any " +
        "footprint-bearing sheet (site plan or floor plan) to infer the " +
        "roof outline. Flag this in notes and lower confidence accordingly.",
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
};

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
    const response = await client.messages.create({
      model: MODEL,
      // Sonnet's per-token generation rate is the main wall-clock cost
      // here. The typical takeoff (15-20 runs + 10 downspouts + 10
      // excluded edges) finishes in ~3000-4000 output tokens. 16000
      // was leaving 12k of headroom that generation latency had to
      // walk through every time. 6000 covers the long tail (complex
      // 30-segment trace with full excluded_edges) and trims ~15-25s
      // off wall-clock for typical jobs. If output gets truncated the
      // stop_reason check below catches it and surfaces a clear error.
      max_tokens: 6000,
      temperature: 0,
      system: [
        {
          type: "text",
          text: BLUEPRINT_FROM_PLANS_SYSTEM,
          // Cache the ~3k-token system prompt across blueprint runs.
          // Cuts input cost ~90% from the second blueprint onward.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        { role: "user", content: userContent },
        // Was: assistant prefill forcing the response to start with `{`.
        // Removed because Anthropic's API now rejects prefill on the
        // current Claude 4 models ("This model does not support
        // assistant message prefill. The conversation must end with a
        // user message"). We instead extract the JSON object from the
        // response body — the system prompt already demands JSON-only
        // output and the user message reinforces it.
      ],
    });

    const body = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Robust JSON extraction: the model is instructed to return JSON
    // only, but if it slips in a preamble ("Here is the JSON…") or
    // wraps in ```json fences we still recover. Take the substring
    // between the first '{' and the matching last '}'.
    const firstBrace = body.indexOf("{");
    const lastBrace = body.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return {
        ok: false,
        reason: `Claude response had no JSON object. First 200 chars: ${body.slice(0, 200)}`,
      };
    }
    const raw = body.slice(firstBrace, lastBrace + 1);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // stop_reason "max_tokens" → Claude was cut off mid-output.
      // Surface that explicitly so the operator can bump max_tokens
      // instead of staring at a generic JSON parse error.
      const truncated = response.stop_reason === "max_tokens";
      const baseMsg = (e as Error).message;
      const hint = truncated
        ? " (output was truncated at max_tokens — bump max_tokens in blueprint-from-plans.ts)"
        : "";
      return {
        ok: false,
        reason: `Claude returned unparseable JSON: ${baseMsg}${hint}. First 200 chars: ${raw.slice(0, 200)}`,
      };
    }

    // Graceful error from the model — e.g. "no roof plan found".
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as Record<string, unknown>).error === "string"
    ) {
      const obj = parsed as Record<string, unknown>;
      return {
        ok: false,
        reason: `${obj.error}: ${typeof obj.reason === "string" ? obj.reason : "(no reason)"}`,
      };
    }

    const analysis = parsed as BlueprintAnalysis;
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
