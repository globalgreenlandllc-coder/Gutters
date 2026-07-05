import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getActiveApiKey } from "@/lib/api-keys";
import { getPrompt } from "./prompts";
import type { PlanSource } from "./blueprint-from-plans";
import type { PlanClassification } from "./classify-plans";
import {
  mergeFaceReadings,
  type ElevationFaceName,
  type FaceReadingRaw,
} from "./face-merge";

export type { ElevationFaceName, FaceGableRead, FaceReadingRaw, MergedFaces } from "./face-merge";
export { mergeFaceReadings } from "./face-merge";

/**
 * read-elevations.ts — INDEPENDENT per-face elevation reading (Correction 1).
 *
 * Instead of one call that reads the whole set and can silently mirror the front
 * onto the back, each elevation is read in its OWN model call, so no single
 * context ever reconciles two faces into a symmetric guess. The reads run in
 * parallel; a pure `mergeFaceReadings` then assembles the per-face record and
 * the review flags.
 *
 * IMPORTANT — the nature of the independence here: this repo intentionally does
 * NOT rasterize PDF pages server-side (see pdf-vectors.ts), so each call still
 * receives the whole document and is *instructed* to read only its page. The
 * guarantee is therefore CALL-LEVEL independence (no cross-face reconciliation
 * in one reasoning context), not pixel isolation. True per-page isolation would
 * need a PDF-splitting dependency; this is a deliberate, documented trade-off.
 *
 * Correction 2 (default flush) is enforced downstream in code
 * (`resolveProjectionFt`); a blind face read cannot confirm its own projection,
 * so it only reports depth CUES, never a confirmed projection — the merge flags
 * those for human confirmation rather than adding side-eave gutter.
 *
 * Fully fail-safe: any read error degrades that face to `readable:false`; the
 * stage never throws and never blocks the takeoff.
 */

const MODEL = "claude-haiku-4-5-20251001";

export type ElevationReadResult = {
  per_face: Record<string, FaceReadingRaw>;
  /** Always false — the whole point of reading faces independently. */
  symmetry_assumed: false;
  elevation_unreadable: string[];
  review_flags: string[];
  usage: { input_tokens: number; output_tokens: number; calls: number };
};

export const ELEVATION_FACE_SYSTEM = `
You are a senior rain-gutter estimator reading ONE exterior elevation of a house
to support a gutter takeoff. You are reading this face IN ISOLATION.

<isolation>
Read ONLY the page/face named in the user message. Do NOT look at, infer, or
borrow from any other elevation. NEVER assume the opposite face is the same —
a house can be a busy cross-gable in front and a plain hip in back. If a fact
requires seeing another (perpendicular) view, DO NOT guess it here — report it
as a cue or leave it unknown.
</isolation>

<gable_enumeration>
Scan the FULL width of this elevation and count EVERY triangular roof face that
points at the viewer — including small, high dormer gables. Report the count and,
for each gable, its span (width) and pitch tag (e.g. 6:12) when legible.
The two SLOPED edges of a gable are RAKES → they carry NO gutter.
</gable_enumeration>

<projection_default>
A gable's FACE view shows that it EXISTS and how wide it is. It does NOT show
whether the gable projects forward — that is only visible in the perpendicular
(side) elevation or the roof-plan footprint. Therefore DEFAULT every gable to
FLUSH (eave_condition_guess:"flush"): rakes only, no side eaves, the eave runs
straight past beneath it.
Set shows_projection_cue:true ONLY when THIS elevation shows a positive depth
cue: a lower "roof beyond" dashed line, a porch/entry roof clearly on a nearer
plane, or a gable carried on POSTS or a BEAM (supported_on:"posts"|"beam") rather
than the house wall. A porch/entry gable on posts or a beam is very likely
projecting — flag the cue, but still leave the confirmation to the side view.
Never invent a projection to add gutter.
</projection_default>

<edges>
Classify each roof-bottom edge: a HORIZONTAL bottom edge is an EAVE (gutter); a
SLOPED bottom edge rising to a peak is a RAKE (no gutter). Report continuous_eave
= true when the main fascia/gutter line runs continuously across this face
(broken only where a mass steps or projects).
</edges>

<resolution_gate>
If the image is too low-resolution to distinguish a horizontal eave from a
sloped rake, or to judge a gable, DO NOT guess. Set readable:false and give
unreadable_reason. An honest "unreadable" is a correct answer; a guessed edge is
not.
</resolution_gate>

Call record_face_reading with your result. Do not output prose.
`.trim();

const RECORD_FACE_TOOL: Anthropic.Tool = {
  name: "record_face_reading",
  description:
    "Record the independent reading of a single exterior elevation face for a gutter takeoff.",
  input_schema: {
    type: "object",
    properties: {
      face: { type: "string", enum: ["north", "south", "east", "west", "front", "rear", "left", "right"] },
      readable: { type: "boolean", description: "false when the image is too low-res to classify edges/gables." },
      unreadable_reason: { type: ["string", "null"] },
      gable_count: { type: ["integer", "null"] },
      continuous_eave: { type: "boolean" },
      gables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            span_ft: { type: ["number", "null"] },
            pitch: { type: ["number", "null"], description: "rise per 12 (e.g. 6 for 6:12)." },
            eave_condition_guess: { type: "string", enum: ["projecting", "roof_mounted", "flush", "unknown"] },
            supported_on: { type: "string", enum: ["wall", "posts", "beam", "unknown"] },
            shows_projection_cue: { type: "boolean" },
            notes: { type: "string" },
          },
          required: ["id", "eave_condition_guess", "supported_on", "shows_projection_cue"],
        },
      },
      projection_cues: { type: "array", items: { type: "string" } },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["face", "readable", "gable_count", "continuous_eave", "gables", "confidence"],
  },
};

function sourceBlock(source: PlanSource): Anthropic.ContentBlockParam {
  switch (source.kind) {
    case "pdf":
      return { type: "document", source: { type: "base64", media_type: "application/pdf", data: source.base64 } };
    case "pdf-url":
      return { type: "document", source: { type: "url", url: source.url } };
    case "image":
      return { type: "image", source: { type: "base64", media_type: source.mediaType, data: source.base64 } };
    case "image-url":
      return { type: "image", source: { type: "url", url: source.url } };
  }
}

function emptyFace(face: ElevationFaceName, reason: string): FaceReadingRaw {
  return {
    face,
    readable: false,
    unreadable_reason: reason,
    gable_count: null,
    continuous_eave: false,
    gables: [],
    projection_cues: [],
    confidence: "low",
  };
}

/** Read ONE elevation face in its own model call. Never throws — a failure
 *  returns an unreadable face. */
export async function readElevationFace(
  source: PlanSource,
  spec: { face: ElevationFaceName; pages: number[] },
): Promise<{ reading: FaceReadingRaw; usage: { input_tokens: number; output_tokens: number } }> {
  const zero = { input_tokens: 0, output_tokens: 0 };
  try {
    const apiKey = (await getActiveApiKey("ANTHROPIC")) ?? process.env.ANTHROPIC_API_KEY ?? null;
    if (!apiKey) return { reading: emptyFace(spec.face, "no Anthropic API key"), usage: zero };

    const client = new Anthropic({ apiKey });
    const system = await getPrompt("blueprint.elevation.system", ELEVATION_FACE_SYSTEM);
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      temperature: 0,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Find and read the ${spec.face.toUpperCase()} exterior elevation — in isolation. ` +
                (spec.pages.length
                  ? `The elevation sheets in this set are page(s) ${spec.pages.join(", ")}, and a single sheet often holds TWO elevations side by side, so look at ALL of them and pick the ${spec.face.toUpperCase()} one (it may be titled "${spec.face.toUpperCase()}" or e.g. "FRONT/${spec.face.toUpperCase()}", "LEFT/${spec.face.toUpperCase()}"). `
                  : `Locate the ${spec.face.toUpperCase()} elevation anywhere in the set. `) +
                `Read ONLY the ${spec.face.toUpperCase()} elevation; ignore every other elevation and face, and do NOT assume any other face looks like this one. ` +
                `If there is no ${spec.face.toUpperCase()} elevation in the set, set readable:false. ` +
                `Enumerate its gables, classify its eave/rake edges, note any projection cues, and call record_face_reading with face:"${spec.face}".`,
            },
            sourceBlock(source),
          ],
        },
      ],
      tools: [RECORD_FACE_TOOL],
      tool_choice: { type: "tool", name: RECORD_FACE_TOOL.name },
    });

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
    if (!toolUse) return { reading: emptyFace(spec.face, "model returned no structured reading"), usage };

    const raw = toolUse.input as Partial<FaceReadingRaw>;
    const reading: FaceReadingRaw = {
      face: spec.face, // trust our spec over the model's echo
      readable: raw.readable !== false,
      unreadable_reason: raw.unreadable_reason ?? null,
      gable_count: typeof raw.gable_count === "number" ? raw.gable_count : null,
      continuous_eave: raw.continuous_eave !== false,
      gables: Array.isArray(raw.gables) ? raw.gables : [],
      projection_cues: Array.isArray(raw.projection_cues) ? raw.projection_cues : [],
      confidence: raw.confidence ?? "low",
    };
    return { reading, usage };
  } catch (e) {
    return {
      reading: emptyFace(spec.face, `read failed: ${e instanceof Error ? e.message : "unknown"}`),
      usage: zero,
    };
  }
}

/**
 * Read every identified elevation independently (in parallel) and merge. Returns
 * an empty result (with a note) when the classifier found no elevations. Never
 * throws.
 */
export async function readAllElevations(
  source: PlanSource,
  classification: PlanClassification | null,
): Promise<ElevationReadResult> {
  const empty = (flags: string[]): ElevationReadResult => ({
    per_face: {},
    symmetry_assumed: false,
    elevation_unreadable: [],
    review_flags: flags,
    usage: { input_tokens: 0, output_tokens: 0, calls: 0 },
  });

  try {
    const sheets = classification?.sheets ?? [];
    // Collect the elevation SHEETS (a sheet often holds two elevations side by
    // side, so we don't map one face per sheet — we read each face directly).
    const elevationPages = Array.from(
      new Set(
        sheets
          .filter((s) => s.sheet_type === "elevation" && typeof s.page_index === "number")
          .map((s) => s.page_index),
      ),
    );

    // Always read ALL FOUR cardinal faces, each locating its own elevation among
    // the elevation pages — so two-elevations-per-sheet no longer skips a side.
    const CARDINAL_FACES: ElevationFaceName[] = ["north", "south", "east", "west"];
    const specs = CARDINAL_FACES.map((face) => ({ face, pages: elevationPages }));

    const results = await Promise.all(specs.map((spec) => readElevationFace(source, spec)));
    const reads = results.map((r) => r.reading);
    const merged = mergeFaceReadings(reads, CARDINAL_FACES);
    const usage = results.reduce(
      (acc, r) => ({
        input_tokens: acc.input_tokens + r.usage.input_tokens,
        output_tokens: acc.output_tokens + r.usage.output_tokens,
        calls: acc.calls + 1,
      }),
      { input_tokens: 0, output_tokens: 0, calls: 0 },
    );
    return { ...merged, usage };
  } catch (e) {
    return empty([`Face-by-face read failed: ${e instanceof Error ? e.message : "unknown"}`]);
  }
}
