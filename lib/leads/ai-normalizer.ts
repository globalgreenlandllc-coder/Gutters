import OpenAI from "openai";

import { getActiveApiKey } from "@/lib/api-keys";

export type CategorizedTrade =
  | "Roofing"
  | "Gutters"
  | "Framing"
  | "Siding"
  | "Windows"
  | "General"
  | "Other";

export type AiRelevance = "high" | "medium" | "low";

export interface PermitInsight {
  trade: CategorizedTrade;
  summary: string;
  relevance: AiRelevance;
}

const VALID_TRADES: CategorizedTrade[] = [
  "Roofing",
  "Gutters",
  "Framing",
  "Siding",
  "Windows",
  "General",
  "Other",
];

function fallbackInsight(description: string): PermitInsight {
  const lower = description.toLowerCase();
  let trade: CategorizedTrade = "Other";
  if (lower.includes("roof") || (lower.includes("r&r") && lower.includes("shingle"))) trade = "Roofing";
  else if (lower.includes("gutter") || lower.includes("downspout")) trade = "Gutters";
  else if (lower.includes("framing") || lower.includes("addition") || lower.includes("new sfr")) trade = "Framing";
  else if (lower.includes("siding")) trade = "Siding";
  else if (lower.includes("window")) trade = "Windows";

  // Naive relevance: new-construction & re-roofs are highest value for gutters.
  let relevance: AiRelevance = "low";
  if (trade === "Roofing" || trade === "Framing" || trade === "Siding") relevance = "high";
  else if (trade === "Windows" || trade === "Gutters") relevance = "medium";

  // First sentence-ish summary.
  const summary = description.split(/[.\n]/)[0].slice(0, 140);

  return { trade, summary, relevance };
}

export async function analyzePermit(
  description: string,
  buildingType?: string,
): Promise<PermitInsight> {
  const apiKey = await getActiveApiKey("OPENAI");

  if (!apiKey) return fallbackInsight(description);

  try {
    const openai = new OpenAI({ apiKey });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You analyze construction permits for a gutter installation business that also tracks adjacent trades (roofing, framing, siding, windows).

Given a municipal permit description (and optional building type), return JSON with:
- "trade": ONE of "Roofing" | "Gutters" | "Framing" | "Siding" | "Windows" | "General" | "Other". Pick the PRIMARY trade involved.
- "summary": 8-15 word plain-English summary a salesperson can scan. No marketing fluff, no caps lock.
- "relevance": "high" | "medium" | "low". HIGH = new home construction, full reroof, large addition, or anything where gutters will almost certainly be installed/replaced. MEDIUM = remodel, siding, window replacement, partial reroof. LOW = mechanical/electrical/plumbing only, signage, demolition without rebuild, minor interior work.

Return ONLY valid JSON.`,
        },
        {
          role: "user",
          content: buildingType
            ? `Building type: ${buildingType}\n\nPermit description:\n${description}`
            : description,
        },
      ],
    });

    const raw = response.choices[0].message.content?.trim() ?? "{}";
    const parsed = JSON.parse(raw) as Partial<PermitInsight>;

    const trade: CategorizedTrade = VALID_TRADES.includes(parsed.trade as CategorizedTrade)
      ? (parsed.trade as CategorizedTrade)
      : "Other";

    const relevance: AiRelevance =
      parsed.relevance === "high" || parsed.relevance === "medium" || parsed.relevance === "low"
        ? parsed.relevance
        : "low";

    const summary =
      typeof parsed.summary === "string" && parsed.summary.length > 0
        ? parsed.summary.slice(0, 200)
        : description.slice(0, 140);

    return { trade, summary, relevance };
  } catch (error) {
    console.error("AI analyzePermit error:", error);
    return fallbackInsight(description);
  }
}

// Back-compat: older callers may still expect a single trade word.
export async function normalizePermitDescription(description: string): Promise<CategorizedTrade> {
  return (await analyzePermit(description)).trade;
}
