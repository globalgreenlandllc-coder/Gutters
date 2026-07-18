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
  | "blueprint.roofplan.system"
  | "blueprint.takeoff.system"
  | "proposal.pricing.system";

export const PROMPT_KEYS: PromptKey[] = [
  "address.vision.system",
  "address.roof_structure.system",
  "blueprint.classify.system",
  "blueprint.elevation.system",
  "blueprint.roofplan.system",
  "blueprint.takeoff.system",
  "proposal.pricing.system",
];

export type PromptCategory = "address" | "blueprint" | "proposal";

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
  "blueprint.roofplan.system": {
    label: "Roof-plan layout reader",
    category: "blueprint",
    model: "Claude Sonnet 5",
    description:
      "Reads the roof framing / roof plan page as the LAYOUT TRUTH on scanned sets: walks all four sides for hip-eave vs gable end, counts printed downspout marks, notes fascia/tier steps. Its verdicts outrank the elevations (the fallback). ⚠ An override saved here SHADOWS the code default — reset after engine updates.",
  },
  "blueprint.takeoff.system": {
    label: "Gutter takeoff (Stage 2)",
    category: "blueprint",
    model: "Claude Sonnet 4.6",
    description:
      "The main blueprint-scan prompt: traces the roof plan and produces the gutter runs, downspouts, and linear footage. The big one — tune this to change how blueprints are measured.",
  },
  "proposal.pricing.system": {
    label: "AI market price (by location)",
    category: "proposal",
    model: "Claude Sonnet 5",
    description:
      "Drives the 'AI recommended price' switch in the proposal builder: given the job's address, gutter spec, and measurements it suggests a realistic local install price with a low–high range and short reasoning. Contractor-facing only — never shown to the client.",
  },
};

/**
 * Resolve a prompt: DB override → code default. Never throws — a DB error
 * falls back to the hardcoded default so an estimate can't fail just
 * because the prompt store is unreachable.
 *
 * `requiredMarkers`: substrings the engine DEPENDS on the prompt teaching
 * (field names like "eave_passes_in_front", block tags like "<stories>").
 * An override saved before those blocks existed silently degrades every
 * read it drives — the Woodinville run lost all eave-in-front + stories
 * data to a stale elevation override. When any marker is missing, the
 * override is treated as STALE: the code default is used and the caller
 * gets `stale: true` to surface it ("reset the override at /admin/prompts").
 */
export async function getPrompt(
  key: PromptKey,
  fallback: string,
  opts?: { requiredMarkers?: string[] },
): Promise<string> {
  return (await getPromptWithMeta(key, fallback, opts)).content;
}

export async function getPromptWithMeta(
  key: PromptKey,
  fallback: string,
  opts?: { requiredMarkers?: string[] },
): Promise<{ content: string; source: "override" | "default"; stale: boolean }> {
  try {
    const row = await db.promptTemplate.findUnique({ where: { key } });
    if (row && row.content.trim().length > 0) {
      const missing = (opts?.requiredMarkers ?? []).filter(
        (m) => !row.content.includes(m),
      );
      if (missing.length === 0) {
        return { content: row.content, source: "override", stale: false };
      }
      console.warn(
        `[prompts] ${key} override is STALE (missing: ${missing.join(", ")}) — using the code default. Re-save or reset it at /admin/prompts.`,
      );
      return { content: fallback, source: "default", stale: true };
    }
  } catch (e) {
    console.warn(`[prompts] getPrompt(${key}) — using code default:`, e);
  }
  return { content: fallback, source: "default", stale: false };
}
