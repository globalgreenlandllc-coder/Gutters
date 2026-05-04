import "server-only";
import { PNG } from "pngjs";
import { getActiveApiKey } from "@/lib/api-keys";
import type { SatImage } from "./static-map";

export type RoofPolygon = {
  /** Pixel-space points (image coordinates, top-left origin) tracing the roof outline. */
  points: { x: number; y: number }[];
  /** Axis-aligned bbox of the polygon, also in image pixels. */
  bbox: { x: number; y: number; width: number; height: number };
  /** Mask area as a fraction of the full image. */
  areaFraction: number;
};

export type SamOutcome =
  | { ok: true; polygon: RoofPolygon }
  | { ok: false; reason: string };

type Pt = { x: number; y: number };

/**
 * Calls fal.ai's SAM 2 endpoint with a center-point prompt to segment the
 * primary building's roof footprint, then traces the returned mask PNG
 * into a polygon outline.
 *
 * fal.ai's SAM 2 returns the segmentation as a PNG mask (not polygon
 * coords). We fetch that mask, decode it with pngjs, then walk the
 * boundary with Moore-Neighbor tracing. Downstream Douglas-Peucker
 * simplification (in geometry.ts) collapses the raw boundary to clean
 * architectural corners.
 */
export async function segmentRoofViaSam(
  image: SatImage,
  /**
   * Optional point in image-pixel space to use as the SAM prompt. When the
   * Solar API has located the actual building, we pass that center here so
   * SAM segments the right house (not whatever happens to be at the
   * geocoded parcel centroid).
   */
  pointPrompt?: { x: number; y: number },
): Promise<SamOutcome> {
  const key = await getActiveApiKey("FAL");
  if (!key) return { ok: false, reason: "no FAL key in vault" };

  const cx = Math.round(pointPrompt?.x ?? image.width / 2);
  const cy = Math.round(pointPrompt?.y ?? image.height / 2);

  let res: Response;
  try {
    res = await fetch("https://fal.run/fal-ai/sam2/image", {
      method: "POST",
      headers: {
        Authorization: `Key ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_url: `data:${image.mimeType};base64,${image.base64}`,
        prompts: [{ type: "point", x: cx, y: cy, label: 1 }],
      }),
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      reason: `fal.ai network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string; message?: string };
      detail = body.detail || body.message || "";
    } catch {
      // body wasn't JSON
    }
    return {
      ok: false,
      reason: `fal.ai HTTP ${res.status}${detail ? ` — ${detail}` : ""}`,
    };
  }

  // fal.ai SAM 2 response shape (current as of 2026):
  //   { image: { url: "https://fal.media/..png", content_type, width, height } }
  // Older variants may also return `image: "data:image/png;base64,..."` or
  // top-level `mask_url` / nested `masks: [...]`. Be lenient.
  type FalImage =
    | string
    | { url?: string; content_type?: string; width?: number; height?: number };
  type FalResponse = {
    image?: FalImage;
    mask_url?: string;
    masks?: Array<{ image?: FalImage; url?: string }>;
  };

  let data: FalResponse;
  try {
    data = (await res.json()) as FalResponse;
  } catch (e) {
    return {
      ok: false,
      reason: `fal.ai returned non-JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const maskRef =
    (typeof data.image === "object" ? data.image?.url : undefined) ||
    (typeof data.image === "string" ? data.image : undefined) ||
    data.mask_url ||
    (typeof data.masks?.[0]?.image === "object"
      ? data.masks?.[0]?.image?.url
      : undefined) ||
    data.masks?.[0]?.url ||
    null;

  if (!maskRef) {
    return {
      ok: false,
      reason: `SAM 2 response had no mask URL (raw response keys: ${Object.keys(
        data,
      ).join(", ")})`,
    };
  }

  // Fetch the mask PNG (URL or data URI).
  let maskBytes: Buffer;
  try {
    if (maskRef.startsWith("data:")) {
      const b64 = maskRef.split(",", 2)[1] ?? "";
      maskBytes = Buffer.from(b64, "base64");
    } else {
      const maskRes = await fetch(maskRef, { cache: "no-store" });
      if (!maskRes.ok) {
        return { ok: false, reason: `mask download HTTP ${maskRes.status}` };
      }
      maskBytes = Buffer.from(await maskRes.arrayBuffer());
    }
  } catch (e) {
    return {
      ok: false,
      reason: `mask fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let png: PNG;
  try {
    png = PNG.sync.read(maskBytes);
  } catch (e) {
    return {
      ok: false,
      reason: `PNG decode failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // SAM masks come in different flavors and we don't know in advance
  // which one fal.ai is sending today. Try several foreground predicates,
  // count how many pixels each marks as foreground, then pick whichever
  // gives a sensible building-sized region (5–60% of the image).
  const totalPx = png.width * png.height;
  const candidates: Array<{ name: string; isFg: (x: number, y: number) => boolean }> = [
    {
      name: "alpha+red",
      isFg: (x, y) => {
        const i = (y * png.width + x) * 4;
        return png.data[i + 3] > 128 && png.data[i] > 64;
      },
    },
    {
      name: "alpha-only",
      isFg: (x, y) => png.data[(y * png.width + x) * 4 + 3] > 128,
    },
    {
      name: "white-on-black",
      isFg: (x, y) => png.data[(y * png.width + x) * 4] > 128,
    },
    {
      name: "black-on-white",
      isFg: (x, y) => png.data[(y * png.width + x) * 4] < 128,
    },
  ];

  let chosen: typeof candidates[number] | null = null;
  let chosenCount = 0;
  for (const c of candidates) {
    let count = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        if (c.isFg(x, y)) count++;
      }
    }
    const frac = count / totalPx;
    // Reasonable building footprint: 2–60% of the tile at zoom 20.
    if (frac >= 0.02 && frac <= 0.6) {
      chosen = c;
      chosenCount = count;
      break;
    }
  }

  if (!chosen) {
    return {
      ok: false,
      reason: `no usable mask found (tried ${candidates.length} foreground rules; all matched <2% or >60% of pixels)`,
    };
  }

  // Trace the boundary
  const boundary = traceMooreNeighbor(png.width, png.height, chosen.isFg);
  if (boundary.length < 8) {
    return {
      ok: false,
      reason: `mask "${chosen.name}" had ${chosenCount} fg pixels but traced to only ${boundary.length} boundary points`,
    };
  }

  // Downsample boundary to make Douglas-Peucker manageable. Raw boundary
  // can be 2000+ points on a complex roof; we don't need them all.
  const downsampled =
    boundary.length > 400
      ? boundary.filter((_, i) => i % Math.ceil(boundary.length / 400) === 0)
      : boundary;

  const bbox = computeBbox(downsampled);
  const areaFraction = chosenCount / totalPx;

  return {
    ok: true,
    polygon: { points: downsampled, bbox, areaFraction },
  };
}

/* ------------------------------------------------------------------ */
/*   Moore-Neighbor boundary tracing                                  */
/*                                                                    */
/*   Walks the perimeter of the foreground region in clockwise order  */
/*   starting from the top-leftmost foreground pixel. Returns the     */
/*   ordered boundary pixels — typically a few hundred points which   */
/*   simplify(eps=6) downstream collapses to ~10 architectural        */
/*   corners.                                                         */
/* ------------------------------------------------------------------ */
function traceMooreNeighbor(
  width: number,
  height: number,
  isFg: (x: number, y: number) => boolean,
): Pt[] {
  // Find starting pixel — first foreground pixel scanning row by row.
  let startX = -1;
  let startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (isFg(x, y)) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  if (startX === -1) return [];

  // 8-connected neighbors clockwise from north
  const dirs: ReadonlyArray<readonly [number, number]> = [
    [0, -1],   // 0 N
    [1, -1],   // 1 NE
    [1, 0],    // 2 E
    [1, 1],    // 3 SE
    [0, 1],    // 4 S
    [-1, 1],   // 5 SW
    [-1, 0],   // 6 W
    [-1, -1],  // 7 NW
  ];

  const boundary: Pt[] = [{ x: startX, y: startY }];
  let cx = startX;
  let cy = startY;
  // We arrived at the start pixel from the west (the cell to its left
  // was background — guaranteed since startX is in the leftmost column
  // with foreground at startY).
  let backtrackDir = 6; // W

  const maxIters = width * height * 2;
  for (let iter = 0; iter < maxIters; iter++) {
    let found = false;
    // Start scanning one position counter-clockwise of where we came
    // from so we hug the boundary on the right-hand side.
    for (let i = 0; i < 8; i++) {
      const dirIdx = (backtrackDir + 1 + i) % 8;
      const nx = cx + dirs[dirIdx][0];
      const ny = cy + dirs[dirIdx][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (isFg(nx, ny)) {
        backtrackDir = (dirIdx + 4) % 8;
        cx = nx;
        cy = ny;
        boundary.push({ x: cx, y: cy });
        found = true;
        break;
      }
    }
    if (!found) break;
    // Stop when we close the loop back to start.
    if (boundary.length > 8 && cx === startX && cy === startY) break;
  }

  // Drop the closing duplicate
  if (
    boundary.length > 1 &&
    boundary[boundary.length - 1].x === boundary[0].x &&
    boundary[boundary.length - 1].y === boundary[0].y
  ) {
    boundary.pop();
  }

  return boundary;
}

function computeBbox(points: Pt[]) {
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

