import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";
import type { SatImage } from "./static-map";
import type { BuildingHint } from "./vision";

export type DetectedRoofLine = {
  id: string;
  /** Two endpoints in the SOURCE image's pixel space. */
  points: { x: number; y: number }[];
  label?: string;
};

export type DetectedRoofStructure = {
  /** Closed perimeter polygon vertices in source image pixel space. */
  perimeter: { x: number; y: number }[];
  ridges: DetectedRoofLine[];
  valleys: DetectedRoofLine[];
  /** 0–1, model's self-rated confidence. */
  confidence: number;
  notes: string;
};

const SYSTEM_PROMPT = `You are an expert at reading residential roofs from top-down aerial photos. You identify the OUTER ROOF PERIMETER, the RIDGE LINES (peaks where two slopes meet at the top), and the VALLEY LINES (inside seams where two slopes drain toward each other).

This is for a *recreational visual annotation* — not certified measurements. Bias toward correctness over completeness. Skip features you're <70% sure about.

Return VALID JSON ONLY. No prose, no markdown.`;

const userPrompt = (image: SatImage, hint: BuildingHint | null) => {
  let hintText = "";
  if (hint) {
    if ("x1" in hint) {
      hintText = `\n\nThe primary residence's roof occupies the image region from pixel (${hint.x1}, ${hint.y1}) to (${hint.x2}, ${hint.y2}). Annotate ONLY this roof. Ignore neighbors, sheds, detached garages with separate footprints.\n`;
    } else {
      hintText = `\n\nThe primary residence's roof is centered around image pixel (${hint.x}, ${hint.y}). Ignore other buildings.\n`;
    }
  }

  return `Annotate the primary residence's roof in this top-down aerial satellite image (${image.width}×${image.height} pixels, top-left origin, zoom ${image.zoom}).${hintText}

Identify three layers:

1. PERIMETER — the outer boundary of the roof, walked clockwise. A closed polygon with 4–14 corners. Includes garage steps, bays, and dormers visible from above. Excludes the driveway, lawn, and adjacent buildings.

2. RIDGES — the highest seams where two roof planes meet at a peak. On a hip roof these run along the longest axis at the center. On a complex roof there can be 2–4 ridges, including short ridges over bays/dormers. Each ridge is a single straight line between two endpoints.

3. VALLEYS — the low diagonal seams where two roof planes drain TOWARD each other (always at INSIDE corners of the perimeter). On an L-shaped or T-shaped roof there's typically one valley per inside corner. Each valley is a single straight line between two endpoints.

Return JSON in this exact shape:
{
  "perimeter": [{"x": 100, "y": 200}, {"x": 350, "y": 200}, {"x": 350, "y": 380}, {"x": 100, "y": 380}],
  "ridges": [
    { "id": "r1", "points": [{"x": 150, "y": 290}, {"x": 320, "y": 290}], "label": "RIDGE" }
  ],
  "valleys": [
    { "id": "v1", "points": [{"x": 220, "y": 250}, {"x": 280, "y": 320}], "label": "VALLEY" }
  ],
  "confidence": 0.0–1.0,
  "notes": "one short sentence"
}

Rules:
- All coordinates are integers in source image pixels.
- Perimeter: closed polygon (do NOT repeat the first point at the end), at least 4 vertices.
- Each ridge/valley: exactly 2 endpoints (a single straight line).
- Skip uncertain features rather than guessing.
- If the building isn't fully visible, still return what you see, but lower the confidence.`;
};

export async function detectRoofStructureViaVision(
  image: SatImage,
  hint: BuildingHint | null = null,
): Promise<DetectedRoofStructure | null> {
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
        max_tokens: 2000,
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
              { type: "text", text: userPrompt(image, hint) },
            ],
          },
        ],
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      console.warn(`[roof-structure] HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as Partial<DetectedRoofStructure>;
    const cleanPoint = (p: { x: number; y: number } | undefined) =>
      p && Number.isFinite(p.x) && Number.isFinite(p.y)
        ? { x: Math.round(p.x), y: Math.round(p.y) }
        : null;
    const cleanLine = (
      l: Partial<DetectedRoofLine> | undefined,
      idPrefix: string,
      i: number,
    ): DetectedRoofLine | null => {
      if (!l || !Array.isArray(l.points)) return null;
      const pts = l.points.map(cleanPoint).filter((p): p is { x: number; y: number } => p !== null);
      if (pts.length < 2) return null;
      return {
        id: l.id ?? `${idPrefix}-${i}`,
        points: pts,
        label: l.label,
      };
    };

    const perimeter = (parsed.perimeter ?? [])
      .map(cleanPoint)
      .filter((p): p is { x: number; y: number } => p !== null);
    if (perimeter.length < 4) return null;

    const ridges = (parsed.ridges ?? [])
      .map((r, i) => cleanLine(r, "ridge", i))
      .filter((r): r is DetectedRoofLine => r !== null);
    const valleys = (parsed.valleys ?? [])
      .map((v, i) => cleanLine(v, "valley", i))
      .filter((v): v is DetectedRoofLine => v !== null);

    return {
      perimeter,
      ridges,
      valleys,
      confidence: clamp(parsed.confidence ?? 0, 0, 1),
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
    };
  } catch (e) {
    console.warn(
      "[roof-structure] Failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
