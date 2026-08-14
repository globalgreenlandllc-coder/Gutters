import "server-only";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { getActiveApiKey } from "@/lib/api-keys";
import { getPrompt } from "./prompts";
import {
  BLUEPRINT_FROM_PLANS_SYSTEM,
  buildConstraintsBlock,
  type BlueprintAnalysis,
  type BlueprintResult,
  type BlueprintRunOptions,
  type PlanSource,
} from "./blueprint-from-plans";
import { buildVectorBlock } from "./pdf-vectors";

/**
 * Second, GENUINELY DIFFERENT vision model for the Stage-2 roof read — Google
 * Gemini. It reads the PDF natively (like Claude, no rasterizing) and is
 * strong on dense technical documents, so it catches what Opus misses; both
 * results feed the same best-of scorer (blueprintFromPlanSourcesBestOf). It
 * reuses the EXACT same system prompt, constraints, and extracted-vector
 * ground truth as the Claude path, so it's a true apples-to-apples second
 * opinion. Off unless a GEMINI key is configured (admin → API keys).
 */

// Strongest Gemini doc/vision model. Falls back gracefully (the read just
// fails and drops out of the ensemble) if the id ever changes.
const GEMINI_MODEL = "gemini-2.5-pro";

async function geminiKey(): Promise<string | null> {
  return (await getActiveApiKey("GEMINI")) ?? process.env.GEMINI_API_KEY ?? null;
}

/** True when a Gemini key is configured — gate the ensemble on this. */
export async function geminiAvailable(): Promise<boolean> {
  return !!(await geminiKey());
}

/** Pull the JSON object out of a model reply (strip any stray prose/fences). */
function extractJson(s: string): string | null {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : null;
}

export async function geminiBlueprintFromPlan(
  sources: PlanSource[],
  opts: BlueprintRunOptions = {},
): Promise<BlueprintResult> {
  try {
    const apiKey = await geminiKey();
    if (!apiKey) return { ok: false, reason: "Gemini API key not configured" };
    const pdf = sources.find((s) => s.kind === "pdf");
    if (!pdf || pdf.kind !== "pdf")
      return { ok: false, reason: "Gemini path needs a base64 PDF source" };

    const system = await getPrompt(
      "blueprint.takeoff.system",
      BLUEPRINT_FROM_PLANS_SYSTEM,
      { requiredMarkers: ["read_all_sheets", "roof_forms"] },
    );
    const userText =
      "Construction plans attached. Find the roof plan page(s) and return the " +
      "gutter layout JSON per the schema.\n\n" +
      buildConstraintsBlock(opts.constraints) +
      buildVectorBlock(opts.vectorGeometry) +
      "OUTPUT FORMAT: respond with a single JSON object only. No preamble, no " +
      "commentary, no markdown code fences. Start with `{` and end with `}`.";

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: system,
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 16000,
      },
    });

    const t0 = Date.now();
    const res = await model.generateContent([
      { text: userText },
      { inlineData: { mimeType: "application/pdf", data: pdf.base64 } },
    ]);
    const text = res.response.text();
    const json = extractJson(text);
    if (!json) return { ok: false, reason: "Gemini returned no JSON object" };

    const parsed = JSON.parse(json) as BlueprintAnalysis & {
      error?: string;
      reason?: string;
    };
    if (parsed.error)
      return { ok: false, reason: `Gemini: ${parsed.reason ?? parsed.error}` };
    if (!Array.isArray(parsed.gutter_runs))
      return { ok: false, reason: "Gemini JSON missing gutter_runs" };

    const um = res.response.usageMetadata;
    return {
      ok: true,
      analysis: parsed as BlueprintAnalysis,
      usage: {
        model: GEMINI_MODEL,
        input_tokens: um?.promptTokenCount ?? 0,
        output_tokens: um?.candidatesTokenCount ?? 0,
        cache_hit: false,
        duration_ms: Date.now() - t0,
      },
    };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Gemini blueprint analysis failed",
    };
  }
}
