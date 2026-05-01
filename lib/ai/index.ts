import "server-only";
import { geocodeAddress, type GeocodeResult } from "./geocode";
import { fetchSatelliteImage, type SatImage } from "./static-map";
import { estimateStoriesFromInsights, getBuildingInsights } from "./solar";
import { segmentRoofViaSam } from "./sam";
import { segmentEavesViaVision } from "./vision";
import {
  buildEditableLines,
  countCorners,
  measurementsFromVision,
  pixelLengthToFeet,
  placeDownspouts,
  polylineLengthPx,
} from "./geometry";
import {
  sampleEaves,
  sampleDownspouts,
  sampleMeasurements,
} from "@/lib/mock-estimate";
import type { EditableLine, Downspout, Measurements, Stories } from "@/lib/types";

export type EstimateResult = {
  geocoded: GeocodeResult;
  measurements: Measurements;
  eaves: EditableLine[];
  downspouts: Downspout[];
  source: "ai" | "mock" | "partial";
  durationMs: number;
  notes: string[];
  aerial?: {
    imageDataUrl: string;
    width: number;
    height: number;
    zoom: number;
  };
};

export async function runAIEstimatePipeline(
  address: string,
): Promise<EstimateResult> {
  const t0 = Date.now();
  const notes: string[] = [];

  // 1. Geocode
  const geocoded = await geocodeAddress(address);
  notes.push(
    geocoded.source === "google"
      ? "Geocoded via Google Maps"
      : "Geocoded via mock (no Google Maps key in vault)",
  );

  // 2. Aerial imagery (only if we have a real geocode)
  let image: SatImage | null = null;
  if (geocoded.source === "google") {
    image = await fetchSatelliteImage(geocoded.lat, geocoded.lng, {
      zoom: 20,
      size: 640,
    });
    notes.push(
      image
        ? `Fetched ${image.width}×${image.height} satellite tile @ z${image.zoom}`
        : "Static Maps fetch failed — using mock geometry",
    );
  } else {
    notes.push("Skipped aerial fetch (mock geocode)");
  }

  // 3. Building insights (Solar API has limited regional coverage)
  let estimatedStories: Stories = 2;
  if (image) {
    const insights = await getBuildingInsights(geocoded.lat, geocoded.lng);
    if (insights) {
      estimatedStories = estimateStoriesFromInsights(insights);
      notes.push(
        `Solar API: ${insights.roofSegments.length} roof segments, ${Math.round(
          insights.totalRoofAreaMeters2,
        )} m² total · est. ${estimatedStories}-story`,
      );
    } else {
      notes.push("Solar API: no coverage / unavailable for this location");
    }
  }

  // 4. SAM 2 roof polygon (optional — fal.ai key required). Gives GPT-4o
  // a verified building outline so it doesn't hallucinate eaves over
  // driveways, trees, or neighboring roofs.
  let roofPolygon = null;
  if (image) {
    roofPolygon = await segmentRoofViaSam(image);
    if (roofPolygon) {
      notes.push(
        `SAM 2: roof polygon ${roofPolygon.points.length} verts, covers ${(
          roofPolygon.areaFraction * 100
        ).toFixed(1)}% of tile`,
      );
    } else {
      notes.push("SAM 2: skipped (no FAL key) — vision will run unconstrained");
    }
  }

  // 5. Vision segmentation
  if (image) {
    const segmentation = await segmentEavesViaVision(image, roofPolygon);
    if (
      segmentation &&
      segmentation.buildingFound &&
      segmentation.eaves.length > 0
    ) {
      notes.push(
        `Vision: ${segmentation.eaves.length} eaves @ ${Math.round(
          segmentation.confidence * 100,
        )}% confidence`,
      );
      if (segmentation.notes) notes.push(`Vision note: ${segmentation.notes}`);

      const eaves = buildEditableLines(
        segmentation.eaves,
        image.width,
        image.height,
      );

      // Compute LF using ORIGINAL image-pixel coords + map scale, then
      // apply an 8% waste factor for material overlap and cuts.
      let totalEaveLF = 0;
      for (const seg of segmentation.eaves) {
        const px = polylineLengthPx(seg.points);
        totalEaveLF += pixelLengthToFeet(px, geocoded.lat, image.zoom);
      }
      totalEaveLF = totalEaveLF * 1.08;

      const cornerCount = countCorners(eaves);
      const downspouts = placeDownspouts(eaves, totalEaveLF, estimatedStories);
      const measurements = measurementsFromVision({
        eaveLF: totalEaveLF,
        downspoutCount: downspouts.length,
        cornerCount,
        stories: estimatedStories,
      });

      return {
        geocoded,
        measurements,
        eaves,
        downspouts,
        source: "ai",
        durationMs: Date.now() - t0,
        notes,
        aerial: {
          imageDataUrl: `data:${image.mimeType};base64,${image.base64}`,
          width: image.width,
          height: image.height,
          zoom: image.zoom,
        },
      };
    }
    notes.push(
      segmentation
        ? "Vision returned no eaves — falling back to mock geometry"
        : "Vision unavailable (no OpenAI key or call failed) — using mock geometry",
    );
  }

  // 6. Fallback — mock geometry (with the real aerial image as background
  // if we got that far).
  return {
    geocoded,
    measurements: sampleMeasurements,
    eaves: sampleEaves,
    downspouts: sampleDownspouts,
    source: image ? "partial" : "mock",
    durationMs: Date.now() - t0,
    notes,
    aerial: image
      ? {
          imageDataUrl: `data:${image.mimeType};base64,${image.base64}`,
          width: image.width,
          height: image.height,
          zoom: image.zoom,
        }
      : undefined,
  };
}
