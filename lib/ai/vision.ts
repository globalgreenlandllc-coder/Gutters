import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";
import { AI_TIMEOUTS, fetchWithTimeout } from "./http";
import { getPrompt } from "./prompts";
import type { SatImage } from "./static-map";
import type { RoofPolygon } from "./sam";

export type SegmentedEavePolyline = {
  id: string;
  points: { x: number; y: number }[];
  /** Per-edge classification confidence 0..1. Used for downstream
   *  filtering — a low-confidence edge can be styled differently in the
   *  canvas so the contractor can review-then-confirm. Optional because
   *  older model responses may not include it. */
  edgeConfidence?: number;
};

export type AttachedStructure = {
  kind:
    | "attached_garage"
    | "porch"
    | "deck"
    | "dormer"
    | "bay_window"
    | string;
  bbox?: { x: number; y: number; w: number; h: number };
  hasOwnRoof?: boolean;
  needsGutter?: boolean;
};

export type RoofObstruction = {
  kind: "chimney" | "skylight" | "vent" | "hvac" | "solar_array" | string;
  x: number;
  y: number;
};

export type VisionSegmentation = {
  buildingFound: boolean;
  confidence: number;
  eaves: SegmentedEavePolyline[];
  estimatedTotalFeet: number;
  notes: string;
  /** The model's stated scale reference (e.g. "16-ft 2-car garage door
   *  at center-right"). Surfaced in the run-notes strip so the
   *  contractor can sanity-check the model's measurement basis. */
  scaleReference?: string;
  /** Vision's level call as a cross-check against the DSM tier-break
   *  detector. "multi_level" means the model saw self-shadowing on the
   *  roof surface itself. */
  roofLevels?: "single_level" | "multi_level";
  /** One short sentence on what cued the level call. */
  levelCues?: string;
  /** Attached structures (garage / porch / deck / dormer / bay window).
   *  Decks get flagged with hasOwnRoof=false, needsGutter=false so the
   *  downstream eave consumer can skip any edges that fall inside them. */
  attachedStructures?: AttachedStructure[];
  /** Chimneys / skylights / vents / HVAC that may break a gutter run. */
  obstructions?: RoofObstruction[];
};

/** Hint for where the building lives in the image. Either a single
 *  point (when only the parcel centroid is known) or a full bounding
 *  box (preferred — Solar API gives this when it locates a building). */
export type BuildingHint =
  | { x: number; y: number }
  | { x1: number; y1: number; x2: number; y2: number };

export const SYSTEM_PROMPT = `You are a senior gutter estimator producing a takeoff from a NADIR (top-down, directly-overhead) aerial satellite image. You think like a pro doing a real bid, not a generic image-tagging model.

This is a true overhead view — NOT an oblique / Bird's-Eye. Roofs project as their footprint. Slopes are inferred from texture, shadow, and intersection geometry, never from "facing" the camera.

Before you trace anything, mentally do this:

1. SCALE CALIBRATION. Look for a known-size reference: a 2-car garage door (~16 ft), single-car garage door (~9 ft), front door (~3 ft), driveway slab width (~10–12 ft), sidewalk slab (~4–5 ft), or a parked car (~6×15 ft). Use that to establish pixels-per-foot. If nothing is visible, say so in the notes.

2. ROOF LEVELS — single vs multi-level. The strongest 2D cue is SELF-SHADOWING. An upper roof tier casts a hard shadow ONTO the lower roof's surface (not on the ground). Look for sharp dark bands on the roof itself with a sun-angle direction consistent across the whole image. If you see them, it's multi-level. Estimate which lower section each upper section sits over. (A separate DSM-based detector also runs in parallel; the vision call is a cross-check.)

3. EDGE CLASSIFICATION. For every distinct segment of the roof outline you can see, classify it. Only EAVES get gutters:
   - EAVE: the low horizontal edge of a roof plane. The plane slopes UP from this edge to a ridge. Strong visible cue: an EAVE casts a clean shadow line on the wall directly below, AND often shows a slight overhang shadow on the ground/wall.
   - RAKE: a sloped edge running from eave to ridge along a gable wall. Visible cue: the edge ALIGNS with the slope direction toward a ridge — no shadow below it because the wall is flush with the roof plane.
   - RIDGE: the high peak where two slopes meet. Inside the outline, not on the perimeter.
   - HIP: diagonal seam where two roof planes meet at an outside corner. Inside the outline.
   - VALLEY: diagonal seam where two planes meet at an inside corner. Inside the outline. Valleys DISCHARGE onto an eave below — note which.
   The eave-vs-rake call is genuinely hard from a 2D nadir view; mark uncertain edges with lower confidence (0.5-0.7) rather than dropping them. The DSM classifier downstream will override on the ones it can resolve from height data.

4. ATTACHED STRUCTURES — identify and bound:
   - attached_garage: continuation of the same roofing material, often lower tier
   - porch (roofed): continuation of roofing material at a lower tier with a clear roof texture
   - deck (UNROOFED): wood-plank texture, parallel slat shadows, sits in the yard footprint with NO roof material above it — DO NOT trace these as eaves; they get no gutter
   - dormer: small upper-tier projection sticking out of a main slope, with its own ridge
   - bay_window: small projection on the perimeter, may or may not have its own roof
   For each, flag whether it has its own roof + needs its own gutter.

5. OBSTRUCTIONS that could break a single gutter run into two: chimneys, skylights, vents, hvac units on the roof, solar arrays.

6. INCLUSION BIAS. When in doubt, INCLUDE the edge as an eave. The contractor will delete a wrong rake with one click; a missing eave costs them the sale. A typical complex residential roof has 8–14 eave segments — returning fewer than 6 on a multi-gable house means you missed real eaves. Re-check before answering.

7. SKIP RULES.
   - Skip detached outbuildings (separate sheds, freestanding garages with their own footprint not connected to the primary residence).
   - Skip edges that are clearly inside the roof outline (ridges, hips, valleys).
   - Do NOT invent edges under tree cover, glare, or shadow occlusion. If a side is hidden, say so in the notes and lower confidence on adjacent edges.
   - Do NOT trace driveways, decks (unroofed wood plank surfaces), walkways, or pool decks.

Return VALID JSON ONLY. No prose outside the JSON, no markdown code fences. Use null (not the string "null") for any field you cannot determine.`;

const userPrompt = (
  image: SatImage,
  roofPolygon: RoofPolygon | null,
  buildingHint: BuildingHint | null,
) => {
  let hint = "";
  if (buildingHint) {
    if ("x1" in buildingHint) {
      hint = `\n\nThe primary residence's roof footprint occupies the image region from pixel (${buildingHint.x1}, ${buildingHint.y1}) to (${buildingHint.x2}, ${buildingHint.y2}). Trace the COMPLETE outline of THIS region's roof — every wall on every side. Ignore any other buildings in the tile (sheds, neighbors, garages with separate footprints).\n`;
    } else {
      hint = `\n\nThe primary residence's roof is centered around image pixel (${buildingHint.x}, ${buildingHint.y}). Ignore any other buildings in the tile (sheds, neighbors, garages with separate footprints).\n`;
    }
  }

  const base = `Trace every EAVE of the primary residence's roof in this NADIR (true top-down) aerial satellite image (${image.width}x${image.height} pixels, top-left origin, zoom ${image.zoom}).${hint}

Work through these steps before answering — the JSON must reflect a real takeoff, not a guess:
1. SCALE: pick a known-size reference visible in this image (garage door, front door, driveway, parked car).
2. LEVELS: scan for self-shadowing on the roof surface itself. Hard dark bands on the roof = upper tier above lower tier. Estimate which tier sits over which.
3. OUTLINE: trace the roof outline of the primary residence. Walk it clockwise. For multi-tier roofs trace BOTH the outer perimeter AND every interior tier-break edge (where an upper section ends over a lower section's surface — gutter needs to go there too).
4. CLASSIFY each segment as eave / rake / ridge / hip / valley. Only eaves go in the output.
5. ATTACHED STRUCTURES: spot any attached_garage, porch (roofed), deck (unroofed wood), dormer, or bay_window. Decks get NO eaves — wood-plank slat shadow texture is the giveaway.
6. OBSTRUCTIONS: chimneys, skylights, vents, hvac units, solar arrays that interrupt a gutter run.

Return JSON in this exact shape:
{
  "buildingFound": boolean,
  "confidence": number (0.0–1.0),
  "scaleReference": "string — what you used to set scale, e.g. '16-ft 2-car garage door, lower-right'",
  "roofLevels": "single_level" | "multi_level",
  "levelCues": "string — one short sentence on the self-shadowing / texture cues that drove the level call",
  "eaves": [
    { "id": "e1", "points": [{"x": 100, "y": 200}, {"x": 350, "y": 200}], "edgeConfidence": 0.95, "tier": "lower" | "upper" | null }
  ],
  "attachedStructures": [
    { "kind": "attached_garage" | "porch" | "deck" | "dormer" | "bay_window", "bbox": {"x":0,"y":0,"w":0,"h":0}, "hasOwnRoof": boolean, "needsGutter": boolean }
  ],
  "obstructions": [
    { "kind": "chimney" | "skylight" | "vent" | "hvac" | "solar_array", "x": 0, "y": 0 }
  ],
  "estimatedTotalFeet": number,
  "notes": "one short sentence on what's obscured, what's uncertain, what the takeoff hinges on"
}

Rules:
- Walk the perimeter clockwise. Adjacent eave edges share a corner endpoint.
- Each eave is ONE straight line between TWO corners.
- Coordinates are integers in image pixels.
- A complex residential roof has 8–14 eaves. Returning fewer than 6 on a multi-gable house means you missed eaves — re-check.
- Include short eaves (4–10 ft) — they're often connectors between roof sections.
- If a side is fully obscured by trees, do NOT invent edges there. Mention in notes and let visible eaves stand.
- If the primary residence is partially out of frame, set buildingFound=false and return an empty eaves array.
- DECKS (unroofed wood-plank surfaces) — never as eaves. Include them in attachedStructures with hasOwnRoof=false, needsGutter=false.`;

  if (!roofPolygon) return base;

  // Pre-segmented polygon from SAM 2 — tell GPT-4o exactly where the
  // building is so it only classifies edges instead of also locating it.
  const polyPoints = roofPolygon.points
    .slice(0, 32) // cap to keep prompt small; 32 vertices is more than enough
    .map((p) => `(${p.x},${p.y})`)
    .join(" ");
  const { x, y, width, height } = roofPolygon.bbox;

  return `${base}

A vision segmentation model has already located the primary roof footprint.
- Bounding box: x=${x}, y=${y}, width=${width}, height=${height}
- Polygon vertices (clockwise, image pixels): ${polyPoints}

Constrain every eave you return to lie ON this polygon's perimeter (within ~10px). Do not draw eaves outside the bounding box. Return only the polygon edges that are eaves (lower horizontal); skip rakes (sloped) and ridges (top).`;
};

export async function segmentEavesViaVision(
  image: SatImage,
  roofPolygon: RoofPolygon | null = null,
  buildingHint: BuildingHint | null = null,
): Promise<VisionSegmentation | null> {
  const key = await getActiveApiKey("OPENAI");
  if (!key) return null;

  const systemPrompt = await getPrompt("address.vision.system", SYSTEM_PROMPT);

  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        max_tokens: 1500,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${image.mimeType};base64,${image.base64}`,
                  detail: "high",
                },
              },
              {
                type: "text",
                text: userPrompt(image, roofPolygon, buildingHint),
              },
            ],
          },
        ],
      }),
      cache: "no-store",
    }, AI_TIMEOUTS.vision);

    if (!res.ok) {
      console.warn(`[vision] HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as Partial<VisionSegmentation>;
    if (!parsed || typeof parsed.buildingFound !== "boolean") return null;

    const eaves = (parsed.eaves ?? [])
      .filter(
        (e): e is SegmentedEavePolyline =>
          Array.isArray(e?.points) && e.points.length >= 2,
      )
      .map((e, i) => ({
        id: e.id ?? `vision-${i}`,
        points: e.points
          .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
          .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        edgeConfidence:
          typeof e.edgeConfidence === "number"
            ? clamp(e.edgeConfidence, 0, 1)
            : undefined,
      }))
      .filter((e) => e.points.length >= 2);

    const attachedStructures = Array.isArray(parsed.attachedStructures)
      ? (parsed.attachedStructures as AttachedStructure[])
          .filter((s) => s && typeof s.kind === "string")
          .map((s) => ({
            kind: s.kind,
            bbox:
              s.bbox &&
              [s.bbox.x, s.bbox.y, s.bbox.w, s.bbox.h].every((n) =>
                Number.isFinite(n),
              )
                ? {
                    x: Math.round(s.bbox.x),
                    y: Math.round(s.bbox.y),
                    w: Math.round(s.bbox.w),
                    h: Math.round(s.bbox.h),
                  }
                : undefined,
            hasOwnRoof:
              typeof s.hasOwnRoof === "boolean" ? s.hasOwnRoof : undefined,
            needsGutter:
              typeof s.needsGutter === "boolean" ? s.needsGutter : undefined,
          }))
      : undefined;

    const obstructions = Array.isArray(parsed.obstructions)
      ? (parsed.obstructions as RoofObstruction[])
          .filter(
            (o) =>
              o &&
              typeof o.kind === "string" &&
              Number.isFinite(o.x) &&
              Number.isFinite(o.y),
          )
          .map((o) => ({
            kind: o.kind,
            x: Math.round(o.x),
            y: Math.round(o.y),
          }))
      : undefined;

    return {
      buildingFound: parsed.buildingFound,
      confidence: clamp(parsed.confidence ?? 0, 0, 1),
      eaves,
      estimatedTotalFeet: Math.max(0, parsed.estimatedTotalFeet ?? 0),
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
      scaleReference:
        typeof parsed.scaleReference === "string"
          ? parsed.scaleReference
          : undefined,
      roofLevels:
        parsed.roofLevels === "single_level" ||
        parsed.roofLevels === "multi_level"
          ? parsed.roofLevels
          : undefined,
      levelCues:
        typeof parsed.levelCues === "string" ? parsed.levelCues : undefined,
      attachedStructures,
      obstructions,
    };
  } catch (e) {
    console.warn(
      "[vision] Failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
