import "server-only";
import { db } from "@/lib/db";

/**
 * Admin-editable AI prompts.
 *
 * Each estimation pipeline is driven by a large system prompt that lives
 * as a hardcoded constant in code (the canonical DEFAULT). An admin can
 * override any of these from /admin/prompts; the override is stored in
 * the `prompt_templates` table keyed by `PromptKey`. `getPrompt(key,
 * fallback)` returns the DB override when present, else the code default
 * — so the pipeline always works, even with an empty table or a DB
 * hiccup, and edits take effect live without a redeploy.
 *
 * Only the STATIC system prompts are exposed (no runtime `{placeholder}`
 * interpolation lives in them), so an edit can't break the per-run data
 * the pipelines still inject as separate user/constraint messages.
 */
export type PromptKey =
  | "address.vision.system"
  | "address.roof_structure.system"
  | "blueprint.classify.system"
  | "blueprint.elevation.system"
  | "blueprint.takeoff.system";

export const PROMPT_KEYS: PromptKey[] = [
  "address.vision.system",
  "address.roof_structure.system",
  "blueprint.classify.system",
  "blueprint.elevation.system",
  "blueprint.takeoff.system",
];

export type PromptCategory = "address" | "blueprint";

export const PROMPT_META: Record<
  PromptKey,
  { label: string; category: PromptCategory; model: string; description: string }
> = {
  "address.vision.system": {
    label: "Eave trace (vision)",
    category: "address",
    model: "OpenAI GPT-4o",
    description:
      "The main address-scan prompt: instructs the AI how to read the satellite image and decide which roof edges are gutter eaves. Tune this to change how the address scan traces gutters.",
  },
  "address.roof_structure.system": {
    label: "Roof structure overlay",
    category: "address",
    model: "OpenAI GPT-4o",
    description:
      "Finds ridge / valley lines for the decorative roof overlay drawn under the trace. Not priced — purely visual.",
  },
  "blueprint.classify.system": {
    label: "Plan classifier (Stage 1)",
    category: "blueprint",
    model: "Claude Haiku 4.5",
    description:
      "Reads the whole PDF and inventories every page (which is the roof plan, elevation sides, tier heights, 'all eaves get gutters'-type rules) that constrains the takeoff pass.",
  },
  "blueprint.elevation.system": {
    label: "Elevation face reader (per-face)",
    category: "blueprint",
    model: "Claude Sonnet 5",
    description:
      "Reads ONE exterior elevation in isolation — enumerates ALL its gables (stacked/nested count separately, no upper limit), classifies eave vs rake, reports set-back and eave-in-front per gable, and defaults gables to flush. One independent call per face so the front is never mirrored onto the back. ⚠ An override saved here SHADOWS the code default — reset after engine updates.",
  },
  "blueprint.takeoff.system": {
    label: "Gutter takeoff (Stage 2)",
    category: "blueprint",
    model: "Claude Sonnet 4.6",
    description:
      "The main blueprint-scan prompt: traces the roof plan and produces the gutter runs, downspouts, and linear footage. The big one — tune this to change how blueprints are measured.",
  },
};

/**
 * Resolve a prompt: DB override → code default. Never throws — a DB error
 * falls back to the hardcoded default so an estimate can't fail just
 * because the prompt store is unreachable.
 */
export async function getPrompt(
  key: PromptKey,
  fallback: string,
): Promise<string> {
  try {
    const row = await db.promptTemplate.findUnique({ where: { key } });
    if (row && row.content.trim().length > 0) return row.content;
  } catch (e) {
    console.warn(`[prompts] getPrompt(${key}) — using code default:`, e);
  }
  return fallback;
}
