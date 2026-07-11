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

/**
 * Upscale a satellite crop with bilinear resampling before handing it to SAM.
 * SAM's mask is quantized to input pixels, so tracing at 2× halves the vertex
 * quantization error on eave corners — real accuracy from the same tile.
 * The long side is CAPPED (default 1024) because fal.ai chokes on ~2MB+
 * payloads (the all-black-mask failure); below a 1.25× gain it's not worth
 * re-encoding and returns the input unchanged (scale 1).
 */
export function upscaleSatImage(
  image: SatImage,
  maxLongSide = 1024,
): { image: SatImage; scale: number } {
  try {
    const long = Math.max(image.width, image.height);
    const scale = Math.min(2, maxLongSide / long);
    if (!(scale >= 1.25)) return { image, scale: 1 };

    const src = PNG.sync.read(Buffer.from(image.base64, "base64"));
    const w = Math.round(src.width * scale);
    const h = Math.round(src.height * scale);
    const dst = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      const sy = Math.min(src.height - 1, y / scale);
      const y0 = Math.floor(sy);
      const y1 = Math.min(src.height - 1, y0 + 1);
      const fy = sy - y0;
      for (let x = 0; x < w; x++) {
        const sx = Math.min(src.width - 1, x / scale);
        const x0 = Math.floor(sx);
        const x1 = Math.min(src.width - 1, x0 + 1);
        const fx = sx - x0;
        const di = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) {
          const p00 = src.data[(y0 * src.width + x0) * 4 + c];
          const p10 = src.data[(y0 * src.width + x1) * 4 + c];
          const p01 = src.data[(y1 * src.width + x0) * 4 + c];
          const p11 = src.data[(y1 * src.width + x1) * 4 + c];
          dst.data[di + c] = Math.round(
            p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy,
          );
        }
      }
    }
    const out = PNG.sync.write(dst);
    return {
      image: { ...image, base64: out.toString("base64"), mimeType: "image/png", width: w, height: h },
      scale,
    };
  } catch {
    return { image, scale: 1 };
  }
}

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
      source: image.source,
      primaryFailureReason: image.primaryFailureReason,
    },
    offset: { x: x1, y: y1 },
    size: { width: w, height: h },
  };
}
