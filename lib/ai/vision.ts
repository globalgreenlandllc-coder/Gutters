import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";
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
};

/** Hint for where the building lives in the image. Either a single
 *  point (when only the parcel centroid is known) or a full bounding
 *  box (preferred — Solar API gives this when it locates a building). */
export type BuildingHint =
  | { x: number; y: number }
  | { x1: number; y1: number; x2: number; y2: number };

const SYSTEM_PROMPT = `You are a senior gutter estimator producing a takeoff from a top-down aerial image. You think like a pro doing a real bid, not a generic image-tagging model.

Before you trace anything, mentally do this:

1. SCALE CALIBRATION. Look for a known-size reference: a 2-car garage door (~16 ft), single-car garage door (~9 ft), front door (~3 ft), driveway slab width (~10–12 ft), sidewalk slab (~4–5 ft), or a parked car (~6×15 ft). Use that to establish pixels-per-foot. If nothing is visible, say so in the notes.

2. EDGE CLASSIFICATION. For every segment of the roof outline you can see, decide which of four kinds it is. Only EAVES get gutters:
   - EAVE: the low horizontal edge of a roof plane. The plane SLOPES UP from this edge toward a ridge. Gutters install here.
   - RAKE: a sloped edge running from eave to ridge along a gable wall. No gutter.
   - RIDGE: the high peak where two planes meet at the top. No gutter.
   - HIP / VALLEY: diagonal seams where roof planes meet at corners. No gutter (valleys discharge ONTO eaves below — note which).
   Use shadows (eaves cast a clean shadow on the wall below; rakes don't), visible ridge lines from above, and the geometry of intersecting planes to make this call. If you're uncertain about an edge, mark it lower confidence — don't drop it.

3. INCLUSION BIAS. When in doubt, INCLUDE the edge as an eave. The contractor will delete a wrong rake with one click; a missing eave costs them the sale. A typical complex residential roof has 8–14 eave segments. If you return fewer than 6 on a multi-gable house, you missed real eaves.

4. SKIP RULES.
   - Skip detached outbuildings (separate sheds, freestanding garages with their own footprint).
   - Skip edges that are clearly inside the roof outline (ridges, hips, valleys).
   - Do NOT invent edges under tree cover, glare, or shadow occlusion. If a side is hidden, say so in the notes and lower confidence on adjacent edges.
   - Do NOT trace driveways, decks, walkways, or covered patios with no roof above them.

Return VALID JSON ONLY. No prose outside the JSON, no markdown code fences.`;

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

  const base = `Trace every EAVE of the primary residence's roof in this top-down aerial satellite image (${image.width}x${image.height} pixels, top-left origin, zoom ${image.zoom}).${hint}

Work through these steps before answering — the JSON must reflect a real takeoff, not a guess:
1. Pick a scale reference visible in this image (garage door, front door, driveway, parked car). Note it.
2. Trace the roof outline. Walk it clockwise and label each segment as eave / rake / ridge / hip / valley. Only eaves go in the output.
3. For each eave, rate your classification confidence 0.0–1.0. Use lower values for edges partly under tree cover, in deep shadow, or where the slope direction is ambiguous from above.

Return JSON in this exact shape:
{
  "buildingFound": boolean,
  "confidence": number (0.0–1.0),
  "scaleReference": "string — what you used to set scale, e.g. '16-ft 2-car garage door, lower-right'",
  "eaves": [
    { "id": "e1", "points": [{"x": 100, "y": 200}, {"x": 350, "y": 200}], "edgeConfidence": 0.95 },
    { "id": "e2", "points": [{"x": 350, "y": 200}, {"x": 350, "y": 380}], "edgeConfidence": 0.80 }
  ],
  "estimatedTotalFeet": number,
  "notes": "one short sentence on what's obscured, what's uncertain, what the overall takeoff hinges on"
}

Rules:
- Walk the perimeter clockwise. Adjacent eave edges share a corner endpoint.
- Each segment is one straight line between two corners (not a curve, not a polyline of 3+ points unless the wall genuinely jogs).
- Coordinates are integers in image pixels.
- A complex residential roof has 8–14 eaves. Returning fewer than 6 on a multi-gable house means you missed eaves — re-check before answering.
- Include short eaves (4–10 ft) — they're often connectors between roof sections.
- If a side of the house is fully obscured by trees, do not invent edges there. Mention it in notes and let the visible eaves stand.
- If the primary residence is partially out of frame, set buildingFound=false and return an empty eaves array.`;

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

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
          { role: "system", content: SYSTEM_PROMPT },
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
    });

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
