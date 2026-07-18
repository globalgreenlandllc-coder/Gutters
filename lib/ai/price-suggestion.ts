import Anthropic from "@anthropic-ai/sdk";
import { getActiveApiKey } from "@/lib/api-keys";
import { getPrompt } from "@/lib/ai/prompts";
import type { EstimateConfig, Measurements } from "@/lib/types";

/**
 * price-suggestion.ts — the "AI recommended price" behind the proposal
 * builder's pricing switch.
 *
 * Given the job's location, the proposal's tiered packages (good /
 * better / best — every package the client will see), and the measured
 * footage, asks Claude what each tier typically SELLS for in that
 * market (tax-in sticker price a homeowner would be quoted), plus a
 * realistic low–high range per tier and short shared reasoning. All
 * tiers are priced in ONE call so the ladder stays coherent — a richer
 * spec can never come back cheaper than a leaner one. Deliberately NOT
 * told the contractor's own prices so the suggestion is an independent
 * second opinion, not an anchored echo.
 *
 * Server-only (pulls the API key from the vault). Forced tool call →
 * structured JSON, never prose.
 */

const MODEL = "claude-sonnet-5";

export type PricePackageInput = {
  /** Package id ("good" | "better" | "best") — echoed back per tier. */
  id: string;
  /** Display name shown to the client (e.g. "Pro Shield"). */
  name: string;
  config: EstimateConfig;
};

export type PriceSuggestionInput = {
  /** Property address — the location the market rate is read from. */
  address: string;
  packages: PricePackageInput[];
  measurements: Measurements;
};

export type PackagePriceSuggestion = {
  packageId: string;
  recommendedTotal: number;
  lowTotal: number;
  highTotal: number;
  perLfInstalled: number | null;
};

export type PriceSuggestion = {
  packages: PackagePriceSuggestion[];
  reasoning: string[];
  location: string;
};

export type PriceSuggestionResult =
  | { ok: true; suggestion: PriceSuggestion }
  | { ok: false; reason: string };

const PRICING_TOOL: Anthropic.Tool = {
  name: "record_price_suggestion",
  description:
    "Record the market price suggestion for every package of this gutter job. Always call this tool exactly once, with one entry per package.",
  input_schema: {
    type: "object",
    properties: {
      location_used: {
        type: "string",
        description:
          'The market you priced against, as "City, ST" (or the closest region you could resolve from the address).',
      },
      packages: {
        type: "array",
        description:
          "One pricing entry for EVERY package you were given, in the same order.",
        items: {
          type: "object",
          properties: {
            package_id: {
              type: "string",
              description: "The package id exactly as given (e.g. 'better').",
            },
            recommended_total_usd: {
              type: "number",
              description:
                "The single price you would recommend quoting for this package in this market — the full tax-in sticker price a reputable local company would charge.",
            },
            low_total_usd: {
              type: "number",
              description:
                "Bottom of the realistic local range for this package (a lean but professional quote). Must be <= recommended_total_usd.",
            },
            high_total_usd: {
              type: "number",
              description:
                "Top of the realistic local range for this package (premium local companies). Must be >= recommended_total_usd.",
            },
            per_lf_installed_usd: {
              type: ["number", "null"],
              description:
                "The installed $/LF market rate for this package's gutter spec that the totals lean on, or null if the job is dominated by minimums/extras.",
            },
          },
          required: [
            "package_id",
            "recommended_total_usd",
            "low_total_usd",
            "high_total_usd",
            "per_lf_installed_usd",
          ],
        },
      },
      reasoning: {
        type: "array",
        items: { type: "string" },
        description:
          "2–4 short bullets (max ~12 words each) on how you priced the job overall: regional labor, material tiers, height/difficulty, removal, minimums.",
      },
    },
    required: ["location_used", "packages", "reasoning"],
  },
};

export const PRICING_SYSTEM = `
You are a veteran gutter-installation estimator who prices residential
gutter jobs across the United States for a living. You know how installed
gutter pricing really moves market to market: coastal metros and
high-cost-of-living areas run well above national averages, rural markets
run below; copper and steel command multiples over aluminum; second- and
third-story work, steep access, and tear-off add real labor cost; and
every reputable company has a job minimum that dominates small footage.

You will receive ONE job — the property address and the measured footage
(eave LF, downspout count, stories, corners) — offered to the homeowner
as tiered packages (typically good / better / best), each with its own
gutter system spec (size, style, material, downspout size, accessories,
old-gutter removal). Price each package for what it typically SELLS for
in that local market — the full tax-in sticker price a homeowner would
be quoted by a reputable licensed company. This is the price of the
whole job at that spec (materials, labor, accessories, removal if
specified), not a cost breakdown.

Rules:
- Price the LOCAL market implied by the address. If you cannot resolve
  the exact town, use the nearest metro/region you can and say so in
  location_used.
- Price each package on its own spec, and keep the ladder coherent: a
  richer spec must never price below a leaner one for the same footage.
- Be realistic, not promotional: low = a lean but professional quote,
  high = premium local companies. recommended sits where most good
  companies actually land. Never invert a range.
- Respect job minimums: tiny footage still prices like a real truck roll
  (rarely under $600–$900 anywhere).
- Copper is a specialty trade — price it like one (typically 3–6× the
  aluminum $/LF installed).
- Stories/height and accessories (guards, heat tape) move price; say so
  in the reasoning bullets when they do.
- Keep reasoning bullets short, concrete, and contractor-facing.
- Always answer by calling record_price_suggestion exactly once, with an
  entry for each package.
`.trim();

function packageBrief(p: PricePackageInput): string {
  const acc = p.config.accessories;
  const accessoryLines = acc
    ? [
        acc.guard !== "none" ? `leaf guards: ${acc.guard}` : null,
        acc.dripEdge ? "drip edge" : null,
        acc.rainChain ? "rain chain" : null,
        acc.iceGuard ? "ice guards" : null,
        acc.heatTape ? "heat tape" : null,
      ].filter(Boolean)
    : [];
  return [
    `Package "${p.id}" (${p.name}):`,
    `- ${p.config.size}" ${p.config.style} ${p.config.material}, color ${p.config.color}`,
    `- Downspouts: ${p.config.downspoutSize}`,
    `- Old gutter removal: ${p.config.oldGutterRemoval ?? "none"}`,
    accessoryLines.length > 0
      ? `- Accessories: ${accessoryLines.join(", ")}`
      : `- Accessories: none`,
  ].join("\n");
}

export async function suggestMarketPrices(
  input: PriceSuggestionInput,
): Promise<PriceSuggestionResult> {
  const apiKey =
    (await getActiveApiKey("ANTHROPIC")) ?? process.env.ANTHROPIC_API_KEY ?? null;
  if (!apiKey) {
    return { ok: false, reason: "Anthropic API key not configured" };
  }

  const { address, packages, measurements } = input;
  if (packages.length === 0) {
    return { ok: false, reason: "No packages to price" };
  }

  const jobBrief = [
    `Property address: ${address}`,
    ``,
    `Measurements (same house for every package):`,
    `- Gutter (eave) length: ${Math.round(measurements.eaveLF)} LF`,
    `- Downspouts: ${measurements.downspoutCount} (${measurements.stories}-story home)`,
    `- Corners: ${measurements.insideCorners + measurements.outsideCorners}, end caps: ${measurements.endCaps}`,
    ``,
    ...packages.map((p) => packageBrief(p) + "\n"),
    `Price every package for its local market by calling record_price_suggestion once.`,
  ].join("\n");

  try {
    const client = new Anthropic({ apiKey });
    // requiredMarkers: an /admin/prompts override saved back when this
    // prompt priced a single package would silently mis-drive the
    // per-package tool call — treat it as stale and use the code default.
    const system = await getPrompt("proposal.pricing.system", PRICING_SYSTEM, {
      requiredMarkers: ["each package"],
    });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1600,
      // No temperature override — matches the repo's other sonnet-5
      // callers (only haiku/sonnet-4 models pin temperature: 0).
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: jobBrief }] }],
      tools: [PRICING_TOOL],
      tool_choice: { type: "tool", name: PRICING_TOOL.name },
    });

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolUse || response.stop_reason === "max_tokens") {
      return {
        ok: false,
        reason: "The AI did not return a price — try again in a moment.",
      };
    }

    const raw = toolUse.input as {
      location_used?: unknown;
      packages?: unknown;
      reasoning?: unknown;
    };
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

    const rows = Array.isArray(raw.packages) ? raw.packages : [];
    const knownIds = new Set(packages.map((p) => p.id));
    const seen = new Set<string>();
    const suggestions: PackagePriceSuggestion[] = [];
    for (const row of rows) {
      const r = row as {
        package_id?: unknown;
        recommended_total_usd?: unknown;
        low_total_usd?: unknown;
        high_total_usd?: unknown;
        per_lf_installed_usd?: unknown;
      };
      const id = typeof r.package_id === "string" ? r.package_id.trim() : "";
      if (!knownIds.has(id) || seen.has(id)) continue;
      const recommended = num(r.recommended_total_usd);
      if (recommended === null) continue;
      seen.add(id);
      // Range sanity: clamp low/high around the recommendation so a
      // confused reply can never show an inverted range in the UI.
      const low = Math.min(num(r.low_total_usd) ?? recommended, recommended);
      const high = Math.max(num(r.high_total_usd) ?? recommended, recommended);
      suggestions.push({
        packageId: id,
        recommendedTotal: Math.round(recommended),
        lowTotal: Math.round(low),
        highTotal: Math.round(high),
        perLfInstalled: num(r.per_lf_installed_usd),
      });
    }
    if (suggestions.length === 0) {
      return { ok: false, reason: "The AI returned no usable prices" };
    }

    const reasoning = Array.isArray(raw.reasoning)
      ? raw.reasoning
          .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
          .slice(0, 4)
      : [];

    return {
      ok: true,
      suggestion: {
        packages: suggestions,
        reasoning,
        location:
          typeof raw.location_used === "string" && raw.location_used.trim()
            ? raw.location_used.trim()
            : address,
      },
    };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "AI price suggestion failed",
    };
  }
}
