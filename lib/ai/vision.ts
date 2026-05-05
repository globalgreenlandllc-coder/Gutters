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

const SYSTEM_PROMPT = `You are an expert at tracing residential roof footprints for gutter contractors from top-down aerial photos.

Your job: trace EVERY straight perimeter edge of the primary residence's roof. The contractor will manually remove any edge that's actually a rake (gable end) — your job is to find ALL the candidate edges, not to over-filter.

When in doubt, INCLUDE the edge. Missing an eave costs the contractor a sale; including a rake costs them one click to delete. Bias toward inclusion.

A typical complex residential roof has 8–14 perimeter edges. If you only return 2–4, you are missing eaves and the contractor will reject the estimate.

Skip only:
- Detached outbuildings (separate sheds, separate garages with their own footprint)
- Edges that are clearly INSIDE the roof outline (ridge lines, valleys)
- Edges where you're <50% confident a roof actually exists

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

  const base = `Trace EVERY perimeter edge of the primary residence's roof in this top-down aerial satellite image (${image.width}x${image.height} pixels, top-left origin, zoom ${image.zoom}).${hint}

Return JSON in this exact shape:
{
  "buildingFound": boolean,
  "confidence": number (0.0–1.0),
  "eaves": [
    { "id": "e1", "points": [{"x": 100, "y": 200}, {"x": 350, "y": 200}] },
    { "id": "e2", "points": [{"x": 350, "y": 200}, {"x": 350, "y": 380}] },
    { "id": "e3", "points": [{"x": 350, "y": 380}, {"x": 100, "y": 380}] },
    { "id": "e4", "points": [{"x": 100, "y": 380}, {"x": 100, "y": 200}] }
  ],
  "estimatedTotalFeet": number,
  "notes": "one short sentence on confidence drivers"
}

Rules:
- Walk the COMPLETE perimeter clockwise. Adjacent edges share a corner endpoint.
- Each segment is one straight line between two corners.
- Coordinates are integers in image pixels.
- A complex residential roof has 8–14 perimeter segments. Returning fewer means you missed eaves.
- Include short edges (under 10 ft) — they're often the connectors between roof sections.
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
