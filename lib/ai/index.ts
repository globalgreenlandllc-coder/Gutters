import "server-only";
import { geocodeAddress, type GeocodeResult } from "./geocode";
import { fetchSatelliteImage, type SatImage } from "./static-map";
import { estimateStoriesFromInsights, getBuildingInsights } from "./solar";
import { segmentRoofViaSam, type RoofPolygon } from "./sam";
import { getRoofMaskFromSolar } from "./solar-mask";
import { polygonFromSolarMask } from "./solar-polygon";
import { getDsmFromSolar } from "./solar-dsm";
import { classifyEdgeWithDsm, ringCentroid } from "./edge-classifier";
import { cropSatImageToBox } from "./crop";
import { segmentEavesViaVision } from "./vision";
import {
  buildEditableLines,
  countCorners,
  eavesFromRoofPolygon,
  latLngToImagePixel,
  measurementsFromVision,
  pixelLengthToFeet,
  placeDownspouts,
  placeDownspoutsOnPolygon,
  polylineLengthPx,
  transformToCanvas,
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
      : `Geocoded via mock — ${geocoded.fallbackReason ?? "Google Maps unavailable"}`,
  );

  // 2. Aerial imagery (only if we have a real geocode)
  let image: SatImage | null = null;
  if (geocoded.source === "google") {
    const imgOutcome = await fetchSatelliteImage(geocoded.lat, geocoded.lng, {
      zoom: 20,
      size: 640,
    });
    if (imgOutcome.ok) {
      image = imgOutcome.image;
      notes.push(
        `Fetched ${image.width}×${image.height} satellite tile @ z${image.zoom}`,
      );
    } else {
      notes.push(`Static Maps fetch failed — ${imgOutcome.reason}`);
    }
  } else {
    notes.push("Skipped aerial fetch (mock geocode)");
  }

  // 3. Building insights (Solar API has limited regional coverage). When
  // available, the bounding box also tells us where the actual house sits
  // in the tile — Google geocoding often returns the parcel centroid which
  // can be 50-100 ft offset from the building.
  let estimatedStories: Stories = 2;
  let buildingPointPx: { x: number; y: number } | null = null;
  let buildingBoxPx:
    | { x1: number; y1: number; x2: number; y2: number }
    | null = null;
  if (image) {
    const insights = await getBuildingInsights(geocoded.lat, geocoded.lng);
    if (insights) {
      estimatedStories = estimateStoriesFromInsights(insights);
      notes.push(
        `Solar API: ${insights.roofSegments.length} roof segments, ${Math.round(
          insights.totalRoofAreaMeters2,
        )} m² total · est. ${estimatedStories}-story`,
      );

      // Project the building's lat/lng bbox onto image pixel space.
      const ne = latLngToImagePixel(
        insights.boundingBoxNE.lat,
        insights.boundingBoxNE.lng,
        geocoded.lat,
        geocoded.lng,
        image.zoom,
        image.width,
        image.height,
      );
      const sw = latLngToImagePixel(
        insights.boundingBoxSW.lat,
        insights.boundingBoxSW.lng,
        geocoded.lat,
        geocoded.lng,
        image.zoom,
        image.width,
        image.height,
      );
      const x1 = Math.min(ne.x, sw.x);
      const y1 = Math.min(ne.y, sw.y);
      const x2 = Math.max(ne.x, sw.x);
      const y2 = Math.max(ne.y, sw.y);
      buildingBoxPx = { x1, y1, x2, y2 };
      buildingPointPx = {
        x: Math.round((x1 + x2) / 2),
        y: Math.round((y1 + y2) / 2),
      };
      const dx = buildingPointPx.x - image.width / 2;
      const dy = buildingPointPx.y - image.height / 2;
      const offsetPx = Math.round(Math.hypot(dx, dy));
      if (offsetPx > 30) {
        notes.push(
          `Building offset from geocode by ${offsetPx}px — pointing AI at actual house`,
        );
      }
    } else {
      notes.push("Solar API: no coverage / unavailable for this location");
    }
  }

  // 3.5. Crop the satellite tile around the Solar bounding box (with
  // padding) so the AI sees only the actual house. Two big wins:
  //   - SAM 2 via fal.ai was returning all-black masks on full 1280×1280
  //     payloads (~2MB base64); a 600×600 crop is ~250KB and processes
  //     successfully.
  //   - GPT-4o gets more pixel detail per inch of roof and can't pick the
  //     wrong building.
  // All AI-returned coordinates are in cropped pixel space — we translate
  // them back into original image space using `cropOffset`.
  let workImage: SatImage = image!;
  let cropOffset = { x: 0, y: 0 };
  let didCrop = false;
  if (image && buildingBoxPx) {
    const cropResult = cropSatImageToBox(image, buildingBoxPx, 120);
    if (cropResult) {
      workImage = cropResult.image;
      cropOffset = cropResult.offset;
      didCrop = true;
      notes.push(
        `Cropped to ${workImage.width}×${workImage.height} around building (offset ${cropOffset.x},${cropOffset.y})`,
      );
    }
  }

  const translatePoint = (p: { x: number; y: number }) => ({
    x: p.x + cropOffset.x,
    y: p.y + cropOffset.y,
  });

  // 4a. PRIMARY: Google Solar API building mask (GeoTIFF) + DSM-based
  // edge classifier. Pre-segmented server-side by Google. The mask gives
  // us the building footprint; the DSM lets us tell eaves from rakes by
  // elevation analysis at each polygon edge.
  let roofPolygon: RoofPolygon | null = null;
  type ClassifiedEdge = {
    a: { lat: number; lng: number };
    b: { lat: number; lng: number };
  };
  let classifiedEaveLatLng: ClassifiedEdge[] | null = null;
  if (image) {
    const solarMask = await getRoofMaskFromSolar(geocoded.lat, geocoded.lng);
    if (solarMask.ok) {
      const result = polygonFromSolarMask(
        solarMask,
        { lat: geocoded.lat, lng: geocoded.lng },
        image.zoom,
        image.width,
        image.height,
      );
      if (result && result.polygon.points.length >= 8) {
        roofPolygon = result.polygon;
        notes.push(
          `Solar mask (${solarMask.crsLabel}): ${solarMask.width}×${solarMask.height} GeoTIFF, ${result.polygon.points.length} polygon verts → bbox ${result.polygon.bbox.width}×${result.polygon.bbox.height} px @ (${result.polygon.bbox.x},${result.polygon.bbox.y})`,
        );

        // Try to classify edges using the DSM. If DSM is unavailable
        // we fall through with all polygon edges as candidate eaves.
        const dsm = await getDsmFromSolar(geocoded.lat, geocoded.lng);
        if (dsm.ok) {
          const ring = result.ringLatLng;
          const centroid = ringCentroid(ring);
          const eaves: ClassifiedEdge[] = [];
          let rakeCount = 0;
          let unknownCount = 0;
          for (let i = 0; i < ring.length - 1; i++) {
            const a = ring[i];
            const b = ring[i + 1];
            const cls = classifyEdgeWithDsm({ a, b }, dsm, centroid);
            if (cls.kind === "eave") eaves.push({ a, b });
            else if (cls.kind === "rake") rakeCount++;
            else unknownCount++;
          }
          classifiedEaveLatLng = eaves;
          notes.push(
            `DSM filter: ${eaves.length} eaves, ${rakeCount} rakes dropped, ${unknownCount} unknown`,
          );
        } else {
          notes.push(`DSM unavailable — using all polygon edges as eaves: ${dsm.reason}`);
        }
      } else {
        notes.push(
          `Solar mask polygon too small (${result?.polygon.points.length ?? 0} verts) — trying SAM`,
        );
      }
    } else {
      notes.push(`Solar mask unavailable — ${solarMask.reason}`);
    }
  }

  // 4b. FALLBACK: SAM 2 via fal.ai. Only runs when Solar mask wasn't
  // available (no Solar coverage for the address, or GeoTIFF decode
  // failed).
  if (image && !roofPolygon) {
    const samPoint = didCrop
      ? { x: Math.round(workImage.width / 2), y: Math.round(workImage.height / 2) }
      : (buildingPointPx ?? undefined);
    const samOutcome = await segmentRoofViaSam(workImage, samPoint);
    if (samOutcome.ok) {
      roofPolygon = {
        points: samOutcome.polygon.points.map(translatePoint),
        bbox: {
          x: samOutcome.polygon.bbox.x + cropOffset.x,
          y: samOutcome.polygon.bbox.y + cropOffset.y,
          width: samOutcome.polygon.bbox.width,
          height: samOutcome.polygon.bbox.height,
        },
        areaFraction: samOutcome.polygon.areaFraction,
      };
      notes.push(
        `SAM 2: roof polygon ${roofPolygon.points.length} verts, covers ${(
          roofPolygon.areaFraction * 100
        ).toFixed(1)}% of crop`,
      );
    } else {
      notes.push(`SAM 2 failed — ${samOutcome.reason}`);
    }
  }

  // 5a. Primary path: cleaned Solar polygon → eaves.
  //
  // We try DSM classification first (drops rake/gable edges using elevation
  // data) but if it's too aggressive — e.g. an ortho-regularized polygon
  // whose corners shifted off real building corners can confuse the
  // perpendicular-interior sampler — we fall back to drawing EVERY polygon
  // edge as a candidate eave. The contractor edits/deletes rakes manually
  // in the canvas. Falling back to GPT-4o vision is a last resort because
  // it loses the clean rectilinear shape the polygon already has.
  if (image && roofPolygon) {
    const MIN_EAVE_FT = 2;
    const buildPolygonEdgeEaves = (): {
      eaves: EditableLine[];
      lf: number;
    } => {
      const lines = eavesFromRoofPolygon(
        roofPolygon!,
        image.width,
        image.height,
      );
      let lf = 0;
      for (let i = 0; i < roofPolygon!.points.length; i++) {
        const a = roofPolygon!.points[i];
        const b = roofPolygon!.points[(i + 1) % roofPolygon!.points.length];
        lf += pixelLengthToFeet(
          Math.hypot(b.x - a.x, b.y - a.y),
          geocoded.lat,
          image.zoom,
        );
      }
      return { eaves: lines, lf: lf * 1.08 };
    };

    let eaves: EditableLine[] = [];
    let totalEaveLF = 0;
    let sourceLabel = "polygon-edges";

    if (classifiedEaveLatLng && classifiedEaveLatLng.length > 0) {
      const imageSpaceEdges: Array<
        readonly [{ x: number; y: number }, { x: number; y: number }]
      > = [];
      let dsmLF = 0;
      for (const edge of classifiedEaveLatLng) {
        const a = latLngToImagePixel(
          edge.a.lat,
          edge.a.lng,
          geocoded.lat,
          geocoded.lng,
          image.zoom,
          image.width,
          image.height,
        );
        const b = latLngToImagePixel(
          edge.b.lat,
          edge.b.lng,
          geocoded.lat,
          geocoded.lng,
          image.zoom,
          image.width,
          image.height,
        );
        const ft = pixelLengthToFeet(
          Math.hypot(b.x - a.x, b.y - a.y),
          geocoded.lat,
          image.zoom,
        );
        if (ft < MIN_EAVE_FT) continue;
        imageSpaceEdges.push([a, b]);
        dsmLF += ft;
      }
      if (imageSpaceEdges.length >= 3) {
        eaves = imageSpaceEdges.map(([a, b], i) => ({
          id: `dsm-eave-${i}`,
          kind: "eave" as const,
          points: transformToCanvas([a, b], image.width, image.height),
        }));
        totalEaveLF = dsmLF * 1.08;
        sourceLabel = "DSM-classified";
      } else {
        notes.push(
          `DSM kept only ${imageSpaceEdges.length} edge(s) — using all ${roofPolygon.points.length} polygon edges instead`,
        );
      }
    }

    if (eaves.length === 0) {
      const fallback = buildPolygonEdgeEaves();
      eaves = fallback.eaves;
      totalEaveLF = fallback.lf;
    }

    if (eaves.length >= 3) {
      const downspouts = placeDownspoutsOnPolygon(
        roofPolygon,
        eaves,
        image.width,
        image.height,
        estimatedStories,
      );
      const cornerCount = countCorners(eaves);
      const measurements = measurementsFromVision({
        eaveLF: totalEaveLF,
        downspoutCount: downspouts.length,
        cornerCount,
        stories: estimatedStories,
      });

      notes.push(
        `Eaves (${sourceLabel}): ${eaves.length} segments, ${downspouts.length} downspouts`,
      );

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
      `Solar polygon had too few edges (${eaves.length}) — falling back to GPT-4o vision`,
    );
  }

  // 5b. Fallback path: GPT-4o vision, used when SAM 2 is unavailable or
  // returned a polygon too noisy/small to trace. Less reliable but still
  // produces eaves on most homes.
  if (image) {
    // When cropped, the building IS the image so no hint needed; GPT-4o
    // gets a focused crop and traces the only roof in frame. roofPolygon
    // is in original image space so we can't pass it as crop-space context.
    const segmentation = await segmentEavesViaVision(
      workImage,
      didCrop ? null : roofPolygon,
      didCrop ? null : (buildingBoxPx ?? buildingPointPx),
    );
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

      // Translate eaves from cropped → original image space
      const eavesOriginalSpace = segmentation.eaves.map((e) => ({
        ...e,
        points: e.points.map(translatePoint),
      }));

      const eaves = buildEditableLines(
        eavesOriginalSpace,
        image.width,
        image.height,
      );

      let totalEaveLF = 0;
      for (const seg of eavesOriginalSpace) {
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
