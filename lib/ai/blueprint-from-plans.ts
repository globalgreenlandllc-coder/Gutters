import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getActiveApiKey } from "@/lib/api-keys";

export type BlueprintPoint = { x: number; y: number };

export type BlueprintRun = {
  id: string;
  side: "front" | "back" | "left" | "right" | "interior";
  start: BlueprintPoint;
  end: BlueprintPoint;
  length_ft: number | null;
  length_px: number;
  drains_to: string[];
};

export type BlueprintDownspout = {
  id: string;
  at: BlueprintPoint;
  from_gutter: string;
  drop_direction: "front" | "back" | "left" | "right";
  reason: "outside_corner" | "long_run_relief" | "valley_terminus";
};

export type BlueprintExcludedEdge = {
  kind: "rake" | "ridge" | "hip" | "valley" | "dormer_rake";
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
Look at the supplied images (one or more pages from architectural plans). Find
the ROOF PLAN, identify every roof edge, classify each correctly, then produce
a precise specification of where to install 5" K-style aluminum gutters and
3"x4" rectangular downspouts. Output strict JSON, nothing else.
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

<method>
Follow these steps in order. Think carefully before producing JSON.

1. Locate the roof plan page in the supplied images. If none is visible,
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
      "drains_to": ["d1"]
    }
  ],
  "downspouts": [
    {
      "id": "d1",
      "at": { "x": number, "y": number },
      "from_gutter": "g1",
      "drop_direction": "front" | "back" | "left" | "right",
      "reason": "outside_corner" | "long_run_relief" | "valley_terminus"
    }
  ],
  "excluded_edges": [
    {
      "kind": "rake" | "ridge" | "hip" | "valley" | "dormer_rake",
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
  "notes": ["<short warning, e.g. 'scale unreadable — lengths in pixels'>"]
}
</output_schema>

<rules>
- Coordinate origin is TOP-LEFT of the source image, x→right, y→down. Use the
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

export type PlanImage = {
  /** base64 (no data: prefix) */
  base64: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
};

const MODEL = "claude-sonnet-4-6";

export async function blueprintFromPlanImages(
  images: PlanImage[],
): Promise<BlueprintResult> {
  if (images.length === 0) {
    return { ok: false, reason: "No images supplied" };
  }
  const apiKey =
    (await getActiveApiKey("ANTHROPIC")) ?? process.env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey) {
    return { ok: false, reason: "Anthropic API key not configured" };
  }

  const client = new Anthropic({ apiKey });
  const t0 = Date.now();

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
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
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Construction plans attached. Find the roof plan page(s) and return the gutter layout JSON per the schema.",
            },
            ...images.map((img) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: img.mediaType,
                data: img.base64,
              },
            })),
          ],
        },
        // Assistant prefill forces the model to start with `{` and produce
        // valid JSON without any "Here is the JSON:" preamble.
        { role: "assistant", content: [{ type: "text", text: "{" }] },
      ],
    });

    const body = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const raw = "{" + body;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        ok: false,
        reason: `Claude returned unparseable JSON: ${(e as Error).message}. First 200 chars: ${raw.slice(0, 200)}`,
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
