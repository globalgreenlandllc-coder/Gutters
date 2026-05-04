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

const SYSTEM_PROMPT = `You are an expert at tracing roof footprints for gutter contractors. Your job: trace the COMPLETE outer perimeter of the primary residence's roof in a top-down aerial view, segment by segment. Every straight section of the roof's outline is a gutter run.

Critical rules:
- Trace the ENTIRE perimeter — every wall of the house has gutters along its lower edge. A typical house has 6-12 perimeter segments. If you only return 2-3 segments, you are missing eaves.
- On a top-down view, every straight edge of the roof's outer outline IS an eave (rakes only appear in side views; from above they project as the same line as the eave).
- Walk the perimeter clockwise starting from the northwest corner.
- Skip outbuildings (sheds, detached garages with separate footprints) unless they're clearly attached.

Return VALID JSON ONLY. No prose, no markdown.`;

const userPrompt = (image: SatImage, roofPolygon: RoofPolygon | null) => {
  const base = `Trace the COMPLETE perimeter of the primary residence's roof in this top-down aerial satellite image (${image.width}x${image.height} pixels, top-left origin, zoom ${image.zoom}).

Return JSON in this exact shape:
{
  "buildingFound": boolean,
  "confidence": number (0.0–1.0),
  "eaves": [
    { "id": "e1", "points": [{"x": 100, "y": 200}, {"x": 350, "y": 200}] },
    { "id": "e2", "points": [{"x": 350, "y": 200}, {"x": 350, "y": 380}] }
  ],
  "estimatedTotalFeet": number,
  "notes": "one short sentence on confidence drivers"
}

Rules:
- Walk the perimeter clockwise. Each eave is one straight edge between two corners.
- Two adjacent eaves should SHARE an endpoint (the corner of the house).
- Coordinates are integers in image pixels.
- A house with N corners produces N eave segments. Don't skip any.
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
              { type: "text", text: userPrompt(image, roofPolygon) },
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
