import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";
import type { SatImage } from "./static-map";
import type { RoofPolygon } from "./sam";

export type SegmentedEavePolyline = {
  id: string;
  points: { x: number; y: number }[];
};

export type VisionSegmentation = {
  buildingFound: boolean;
  confidence: number;
  eaves: SegmentedEavePolyline[];
  estimatedTotalFeet: number;
  notes: string;
};

/** Hint for where the building lives in the image. Either a single
 *  point (when only the parcel centroid is known) or a full bounding
 *  box (preferred — Solar API gives this when it locates a building). */
export type BuildingHint =
  | { x: number; y: number }
  | { x1: number; y1: number; x2: number; y2: number };

const SYSTEM_PROMPT = `You are an expert at identifying GUTTER LINES on a residential roof from a top-down aerial photo. Gutters only run along EAVES — the bottom horizontal edges where the roof slope meets the wall. Gutters DO NOT run along RAKES (the angled sides of a gable end where the roof slopes up toward a peak).

How to tell eaves from rakes from a top-down view:
- A GABLE end is a triangular wall under a roof peak. From above, the roof at a gable end shows two slope panels meeting at a RIDGE LINE that runs perpendicular to the gable wall. The TWO LONG EDGES of those panels (parallel to the ridge) are EAVES — gutters here. The TWO SHORT EDGES at the gable wall are RAKES — NO gutter.
- A HIP roof has all four perimeter edges sloping inward to a ridge. ALL FOUR perimeter edges are EAVES — gutters everywhere.
- Most houses are a mix. When in doubt: if the edge runs PERPENDICULAR to the ridge of its roof panel, it's a rake (skip). If PARALLEL to the ridge, it's an eave (gutter goes here).

Critical rules:
- Return ONLY eave segments. Do NOT return rake segments. A typical house has 6-12 eaves; gable houses typically have eaves on the two long sides only.
- Trace each eave as one straight line between two corners.
- Walk clockwise starting from the northwest corner.
- Skip outbuildings (sheds, detached garages with separate footprints) unless they're clearly attached to the main house.

Return VALID JSON ONLY. No prose, no markdown.`;

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

  const base = `Identify all EAVE segments (gutter-bearing edges) of the primary residence's roof in this top-down aerial satellite image (${image.width}x${image.height} pixels, top-left origin, zoom ${image.zoom}).${hint}

Return JSON in this exact shape:
{
  "buildingFound": boolean,
  "confidence": number (0.0–1.0),
  "eaves": [
    { "id": "e1", "points": [{"x": 100, "y": 200}, {"x": 350, "y": 200}] },
    { "id": "e2", "points": [{"x": 100, "y": 380}, {"x": 350, "y": 380}] }
  ],
  "estimatedTotalFeet": number,
  "notes": "one short sentence on which edges are gables/rakes you skipped, if any"
}

Rules:
- Return ONLY eaves (gutter lines). SKIP rakes/gables (the angled sides under a gable peak).
- Each eave is one straight line between two corners of the roof's footprint.
- Coordinates are integers in image pixels.
- For a hip roof, every perimeter edge is an eave (return all of them).
- For a gable roof, only the two long sides parallel to the ridge are eaves (return those, skip the gable ends).
- Most houses are mixed — apply the rule per roof section.
- If the primary residence is partially out of frame, mark buildingFound: false and return an empty eaves array.`;

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
      }))
      .filter((e) => e.points.length >= 2);

    return {
      buildingFound: parsed.buildingFound,
      confidence: clamp(parsed.confidence ?? 0, 0, 1),
      eaves,
      estimatedTotalFeet: Math.max(0, parsed.estimatedTotalFeet ?? 0),
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
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
