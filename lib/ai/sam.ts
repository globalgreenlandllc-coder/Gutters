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

export type SamOutcome =
  | { ok: true; polygon: RoofPolygon }
  | { ok: false; reason: string };

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
 * Returns a discriminated union so callers can surface the actual reason
 * for failure (no key, auth error, schema mismatch, empty mask) — instead
 * of the misleading "skipped (no key)" we used to print for every outcome.
 */
export async function segmentRoofViaSam(
  image: SatImage,
): Promise<SamOutcome> {
  const key = await getActiveApiKey("FAL");
  if (!key) return { ok: false, reason: "no FAL key in vault" };

  // Center-point prompt: the satellite tile is geocoded to the property,
  // so the building is centered. SAM 2 will grow the mask outward from there.
  const cx = Math.round(image.width / 2);
  const cy = Math.round(image.height / 2);

  try {
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
      // Try to surface fal's error body — they return JSON with a
      // human-readable message for auth / quota / model errors.
      let detail = "";
      try {
        const body = (await res.json()) as { detail?: string; message?: string };
        detail = body.detail || body.message || "";
      } catch {
        // body wasn't json
      }
      const reason = `fal.ai HTTP ${res.status}${detail ? ` — ${detail}` : ""}`;
      console.warn(`[sam2] ${reason}`);
      return { ok: false, reason };
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

    if (points.length < 4) {
      return {
        ok: false,
        reason: `SAM 2 response had no usable polygon (got ${points.length} points; raw response keys: ${Object.keys(data).join(", ")})`,
      };
    }

    const bbox = firstMask?.bbox ?? computeBbox(points);
    const areaFraction =
      typeof firstMask?.area === "number"
        ? firstMask.area / (image.width * image.height)
        : (bbox.width * bbox.height) / (image.width * image.height);

    return { ok: true, polygon: { points, bbox, areaFraction } };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn("[sam2] Failed:", reason);
    return { ok: false, reason };
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
