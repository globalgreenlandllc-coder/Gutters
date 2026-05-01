import "server-only";
import { getActiveApiKey } from "@/lib/api-keys";
import type { SatImage } from "./static-map";

export type RoofPolygon = {
  /** Pixel-space points (image coordinates, top-left origin) tracing the roof outline. */
  points: { x: number; y: number }[];
  /** Axis-aligned bbox of the polygon, also in image pixels. */
  bbox: { x: number; y: number; width: number; height: number };
  /** Mask area as a fraction of the full image. Useful as a sanity check. */
  areaFraction: number;
};

/**
 * Calls fal.ai's SAM 2 endpoint with the satellite tile and a center-point
 * prompt to segment the primary building's roof footprint.
 *
 * Why SAM 2 here: GPT-4o is great at classification ("which edges are eaves?")
 * but mediocre at producing pixel-accurate polygons of arbitrary objects.
 * SAM 2 is purpose-built for that. Running it first gives the GPT-4o pass a
 * verified building outline so it doesn't hallucinate eaves over driveways
 * or trees.
 *
 * Returns null when the FAL key is missing or the call fails — caller should
 * proceed with GPT-4o alone.
 */
export async function segmentRoofViaSam(
  image: SatImage,
): Promise<RoofPolygon | null> {
  const key = await getActiveApiKey("FAL");
  if (!key) return null;

  // Center-point prompt: the satellite tile is geocoded to the property,
  // so the building is centered. SAM 2 will grow the mask outward from there.
  const cx = Math.round(image.width / 2);
  const cy = Math.round(image.height / 2);

  try {
    // Synchronous /run endpoint — returns the result inline up to ~30s, which
    // is plenty for SAM 2 on a 640×640 tile (~1–2s typical).
    const res = await fetch("https://fal.run/fal-ai/sam2/image", {
      method: "POST",
      headers: {
        Authorization: `Key ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_url: `data:${image.mimeType};base64,${image.base64}`,
        prompts: [
          { type: "point", x: cx, y: cy, label: 1 },
        ],
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      console.warn(`[sam2] HTTP ${res.status}`);
      return null;
    }

    type SamMask = {
      polygon?: { points?: Array<[number, number] | { x: number; y: number }> };
      bbox?: { x: number; y: number; width: number; height: number };
      area?: number;
    };
    type SamResponse = {
      masks?: SamMask[];
      polygons?: SamMask["polygon"][];
    };

    const data = (await res.json()) as SamResponse;

    // fal.ai's SAM 2 response schema has shifted across versions. Be lenient.
    const firstMask = data.masks?.[0];
    const rawPoints =
      firstMask?.polygon?.points ?? data.polygons?.[0]?.points ?? [];

    const points = rawPoints
      .map((p) =>
        Array.isArray(p)
          ? { x: Math.round(p[0]), y: Math.round(p[1]) }
          : { x: Math.round(p.x), y: Math.round(p.y) },
      )
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

    if (points.length < 4) return null;

    const bbox =
      firstMask?.bbox ??
      computeBbox(points);

    const areaFraction =
      typeof firstMask?.area === "number"
        ? firstMask.area / (image.width * image.height)
        : (bbox.width * bbox.height) / (image.width * image.height);

    return { points, bbox, areaFraction };
  } catch (e) {
    console.warn("[sam2] Failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

function computeBbox(points: { x: number; y: number }[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };
}
