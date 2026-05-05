import "server-only";
import { PNG } from "pngjs";
import type { SatImage } from "./static-map";

export type CropResult = {
  /** Cropped satellite image with the same `SatImage` shape (re-base64'd PNG). */
  image: SatImage;
  /** Where the cropped region sits in the *original* image's pixel space. */
  offset: { x: number; y: number };
  /** Cropped dimensions (also reflected in image.width/height). */
  size: { width: number; height: number };
};

/**
 * Crops a satellite tile around a bounding box (typically the Solar API's
 * building footprint) with `paddingPx` of context on each side. The result
 * is a fresh `SatImage` with the cropped PNG re-base64'd. Caller must use
 * the returned `offset` to translate any AI-returned coordinates back into
 * the original image's pixel space:
 *
 *   originalCoord = croppedCoord + offset
 *
 * Why crop:
 *   - SAM 2 via fal.ai gets a much smaller payload (1280×1280 base64 ≈ 2MB
 *     was returning all-black masks; a 512×512 crop is ~250KB and works)
 *   - GPT-4o sees more pixel detail per inch of roof
 *   - The building fills the frame, eliminating "wrong building" picks
 */
export function cropSatImageToBox(
  image: SatImage,
  box: { x1: number; y1: number; x2: number; y2: number },
  paddingPx = 100,
): CropResult | null {
  // Decode the source PNG
  const sourceBytes = Buffer.from(image.base64, "base64");
  let src: PNG;
  try {
    src = PNG.sync.read(sourceBytes);
  } catch {
    return null;
  }

  // Clamp the crop region to the source image bounds
  const x1 = Math.max(0, Math.floor(box.x1 - paddingPx));
  const y1 = Math.max(0, Math.floor(box.y1 - paddingPx));
  const x2 = Math.min(src.width, Math.ceil(box.x2 + paddingPx));
  const y2 = Math.min(src.height, Math.ceil(box.y2 + paddingPx));

  const w = x2 - x1;
  const h = y2 - y1;
  if (w < 64 || h < 64) return null; // crop too tiny to be useful

  // Build the cropped pixel buffer
  const dst = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const srcRowStart = ((y1 + row) * src.width + x1) * 4;
    const dstRowStart = row * w * 4;
    src.data.copy(dst.data, dstRowStart, srcRowStart, srcRowStart + w * 4);
  }

  // Re-encode as PNG and re-base64
  const out = PNG.sync.write(dst);
  return {
    image: {
      base64: out.toString("base64"),
      mimeType: "image/png",
      width: w,
      height: h,
      zoom: image.zoom,
      centerLat: image.centerLat,
      centerLng: image.centerLng,
    },
    offset: { x: x1, y: y1 },
    size: { width: w, height: h },
  };
}
