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

// Per-face reads are 4 vision calls per analysis. Haiku was the original
// default; on the Woodinville front it read 3 gables where the sheet shows 5
// (stacked porch/center gables merged) — recall misses are exactly the
// failure the owner pays to avoid, so the default is now Sonnet.
// Override with BLUEPRINT_ELEVATION_MODEL.
const MODEL = process.env.BLUEPRINT_ELEVATION_MODEL || "claude-sonnet-5";

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
for each gable: its span (width), pitch tag (e.g. 6:12) when legible, its
horizontal POSITION along the face (position_frac: 0 = far left edge of the
building, 0.5 = center, 1 = far right edge, as you look at this elevation), and
what it ROOFS (kind: porch / patio / entry / garage / dormer / main) from any
label near it — "other" if unlabelled. The two SLOPED edges of a gable are
RAKES → they carry NO gutter.

MULTIPLE GABLES PER FACE ARE THE NORM, not the exception: a craftsman FRONT
typically stacks TWO or THREE (main gable + entry-porch gable + GARAGE gable),
and a complex plan can show 10, 20 or more on one face — there is NO upper
limit; report EVERY one. Finding one or two does NOT mean you are done —
under-counting is the #1 read error, and every missed gable becomes gutter
billed across a rake.

STACKED / NESTED GABLES ARE SEPARATE GABLES. A porch or entry gable sitting
BELOW a taller wall gable, a small gable rising in front of or behind a bigger
one, and a dormer gable poking through a larger triangle are each their OWN
entry with their OWN span, position_frac, kind, and set_back_ft. NEVER merge
nested or overlapping triangles into one wide gable — a merged read reports a
phantom span that matches no wall and both real gables get lost.

Gable signatures to look for (any ONE of these marks a gable):
  - a triangular panel of vertical board-and-batten siding above the eave line
  - a barge-board / rake-trim callout pointing at the edge (e.g. "BARGE BOARD,
    TYPICAL @ GABLE ENDS & RAKES")
  - a louvered GABLE END VENT in the triangle
  - two sloped fascia lines rising to a peak

GARAGE CHECK: if this face shows garage doors, look directly ABOVE them — a
gable over the garage is one of the most common forms and the most commonly
missed. Report it with kind:"garage".

Before you report the count, SELF-CHECK: split the face into left / center /
right thirds and confirm you scanned each third — misses cluster at the far
left and far right of the sheet.
</gable_enumeration>

<not_a_gable>
Do NOT count these as gables — mistaking one for a roof face miscounts the gables
and misplaces a mass:
  - a direct-vent "F.P. FLUE", plumbing vent, or roof/ridge vent (a PIPE — a
    penetration, not a roof face)
  - a SKYLIGHT (e.g. "4'x4' SKYLIGHT w/ LAM. GLASS" — in-plane glass, not a
    triangle)
  - a "SLOPE CHANGE" line (a pitch break within one plane, not a gable)
  - a detached "MASONRY FIRE-PIT BY OTHERS" (a ground feature, not on the roof)
Only a triangular roof FACE pointing at the viewer is a gable. A masonry CHIMNEY
CHASE that projects past the wall IS a real mass — report it (kind:"other" with
its width) — but a flue PIPE is not.
</not_a_gable>

<gable_end_span>
When the gable IS the entire END of the house — the whole face you are reading is
one triangle over the full wall width (a GABLE END, common on side elevations) —
report span_ft as the FULL width of that face, read from the overall dimension
string when present. NEVER leave span_ft null for a gable end: a null span gets a
small default downstream and draws the whole roof end as a tiny mid-wall gable.
</gable_end_span>

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

<set_back_gable>
A gable normally starts AT the eave — its base sits on the eave/fascia line. But
a gable can be SET BACK: its base reads a few feet ABOVE the eave line, with a
strip of eave-and-gutter running IN FRONT of it (a dormer, or a gable recessed up
the roof slope). When a gable base is clearly above the eave line rather than on
it, set set_back_ft to how far back it reads (feet) — the eave in front keeps its
gutter and the gable rises behind it. A base sitting ON the eave ⇒ set_back_ft 0
— ALWAYS report set_back_ft explicitly (0 for a flush gable): a missing value on
a continuous-eave face is treated as "above the eave" downstream and the gable
will NOT consume a wall.

SEPARATELY from set_back_ft, report eave_passes_in_front for EVERY gable:
true when a horizontal eave/gutter line — at ANY height, even a lower tier's —
runs across IN FRONT of / below this gable's base at its position (the gable
rises BEHIND a guttered roof edge). This is the decisive gutter signal on
STEPPED side elevations where the eave line changes height and continuous_eave
is honestly false: the wall below such a gable still carries its gutter.
false when the gable's base meets open wall all the way down (a true
wall-plane gable end).
</set_back_gable>

<profile_depth>
This elevation CAN measure the DEPTH of pop-outs on the PERPENDICULAR faces —
masses that stick out sideways ACROSS your view (a front porch or rear patio
seen from a side elevation; a garage wing or bay seen from the front/rear). Seen
in profile, how far they project is measurable. For each such mass, add a
projections entry with its kind (porch/patio/bay/wing…) and depth_ft in feet. You
CANNOT measure the depth of a pop-out you're looking at head-on — that's the
perpendicular view's job, i.e. some OTHER elevation reports this one's gables.
</profile_depth>

<edges>
Classify each roof-bottom edge: a HORIZONTAL bottom edge is an EAVE (gutter); a
SLOPED bottom edge rising to a peak is a RAKE (no gutter). Report continuous_eave
= true ONLY when one uninterrupted fascia/gutter line runs the FULL width of this
face (broken only where a mass steps or projects, never by a gable). A wall-plane
gable that interrupts the eave line ⇒ continuous_eave = false. Frame-over/dormer
gables ABOVE the line don't break it — those faces stay true.
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
      sheet_title: {
        type: ["string", "null"],
        description:
          'The elevation\'s printed title EXACTLY as it appears on the sheet, e.g. "FRONT/NORTH ELEVATION" or "REAR ELEVATION". This anchors the plan\'s compass orientation. Null if untitled.',
      },
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
            kind: {
              type: "string",
              enum: ["porch", "patio", "entry", "garage", "dormer", "main", "other"],
              description: "What this gable roofs, from any label near it (COV'D PORCH, PATIO, entry). 'other' if unlabelled.",
            },
            span_ft: { type: ["number", "null"] },
            pitch: { type: ["number", "null"], description: "rise per 12 (e.g. 6 for 6:12)." },
            position_frac: {
              type: ["number", "null"],
              description:
                "Horizontal center of this gable along the face: 0 = far left, 0.5 = center, 1 = far right, as you look at the elevation.",
            },
            eave_condition_guess: { type: "string", enum: ["projecting", "roof_mounted", "flush", "unknown"] },
            supported_on: { type: "string", enum: ["wall", "posts", "beam", "unknown"] },
            shows_projection_cue: { type: "boolean" },
            set_back_ft: {
              type: ["number", "null"],
              description:
                "SET-BACK / dormer gable: feet the base sits BEHIND the eave (its base reads ABOVE the eave line). 0 or omit for a normal at-the-eave gable.",
            },
            eave_passes_in_front: {
              type: "boolean",
              description:
                "true when a horizontal eave/gutter line (any height, even a lower tier's) runs across IN FRONT of / below this gable's base — the gable rises BEHIND a guttered roof edge. false for a true wall-plane gable end (open wall all the way down).",
            },
            notes: { type: "string" },
          },
          required: ["id", "kind", "position_frac", "eave_condition_guess", "supported_on", "shows_projection_cue"],
        },
      },
      projections: {
        type: "array",
        description:
          "Masses this elevation shows IN PROFILE (sticking out across your view — a porch/patio/bay/wing on a PERPENDICULAR face). Here you CAN measure how far it projects: its depth in feet.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["porch", "patio", "entry", "garage", "dormer", "main", "other"] },
            depth_ft: { type: ["number", "null"], description: "how far it projects (measured in profile)." },
            notes: { type: "string" },
          },
          required: ["kind", "depth_ft"],
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
    sheet_title: null,
    readable: false,
    unreadable_reason: reason,
    gable_count: null,
    continuous_eave: false,
    gables: [],
    projections: [],
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
      // Sized for the WORST face, not the typical one: a 20-gable elevation
      // is ~2k tokens of tool JSON, and a truncated tool call loses the whole
      // face (the old 1500 cap silently limited gable counts). Non-haiku
      // models spend adaptive-thinking tokens from this same budget; haiku's
      // hard output ceiling is 8192.
      max_tokens: /haiku/.test(MODEL) ? 8000 : 16000,
      // Opus 4.7+/Sonnet 5 reject `temperature`. Positive allowlist: pin 0
      // only on models KNOWN to accept it; unknown models get no sampling params.
      ...(/haiku|sonnet-4-/.test(MODEL) ? { temperature: 0 } : {}),
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
                `Report sheet_title with the elevation's printed title EXACTLY as it appears (e.g. "FRONT/${spec.face.toUpperCase()} ELEVATION") — it anchors the plan's compass orientation. ` +
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
    // A truncated tool call parses as a PLAUSIBLE face (defaults fill the
    // lost tail: readable:true, continuous_eave:true, gables cut short) —
    // poison for the reconciler. An honest "unreadable" degrades safely.
    if (response.stop_reason === "max_tokens") {
      return { reading: emptyFace(spec.face, "tool output truncated at max_tokens — face discarded"), usage };
    }
    if (!toolUse) return { reading: emptyFace(spec.face, "model returned no structured reading"), usage };

    const raw = toolUse.input as Partial<FaceReadingRaw>;
    const reading: FaceReadingRaw = {
      face: spec.face, // trust our spec over the model's echo
      sheet_title: typeof raw.sheet_title === "string" && raw.sheet_title.trim() ? raw.sheet_title.trim() : null,
      readable: raw.readable !== false,
      unreadable_reason: raw.unreadable_reason ?? null,
      gable_count: typeof raw.gable_count === "number" ? raw.gable_count : null,
      continuous_eave: raw.continuous_eave !== false,
      gables: Array.isArray(raw.gables) ? raw.gables : [],
      projections: Array.isArray(raw.projections) ? raw.projections : [],
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
