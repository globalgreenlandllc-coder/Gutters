import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";
import type { SatImage } from "./static-map";

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

const SYSTEM_PROMPT = `You are an expert at analyzing aerial roofing imagery for gutter contractors. Your job: identify the EAVES of a single primary residence — the lower horizontal edges of each roof segment where rainwater would flow off into a gutter. RAKES (sloped sides of a gable roof) are NOT eaves. Hip roof valleys are NOT eaves. Skip outbuildings unless the customer is clearly there.

Return VALID JSON ONLY. No prose, no markdown.`;

const userPrompt = (image: SatImage) =>
  `Identify the eaves (gutter-bearing horizontal edges) of the primary residence in this aerial satellite image (${image.width}x${image.height} pixels, top-left origin, zoom ${image.zoom}).

Return JSON in this exact shape:
{
  "buildingFound": boolean,
  "confidence": number (0.0–1.0),
  "eaves": [
    { "id": "e1", "points": [{"x": 100, "y": 200}, {"x": 350, "y": 200}] },
    { "id": "e2", "points": [{"x": 100, "y": 380}, {"x": 350, "y": 380}] }
  ],
  "estimatedTotalFeet": number,
  "notes": "one short sentence on confidence drivers"
}

Rules:
- Each eave is a single straight or near-straight polyline (most are 2 points).
- Coordinates are integers in image pixels.
- If the primary residence is partially out of frame, mark buildingFound: false and return an empty eaves array.`;

export async function segmentEavesViaVision(
  image: SatImage,
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
              { type: "text", text: userPrompt(image) },
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
