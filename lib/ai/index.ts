import "server-only";
import { geocodeAddress, type GeocodeResult } from "./geocode";
import { fetchSatelliteImage, type SatImage } from "./static-map";
import {
  estimateStoriesFromInsights,
  getBuildingInsights,
  type RoofSegment,
} from "./solar";
import { segmentRoofViaSam, type RoofPolygon } from "./sam";
import { getRoofMaskFromSolar } from "./solar-mask";
import { polygonFromSolarMask } from "./solar-polygon";

import { classifyEdgeWithAzimuth, ringCentroid } from "./edge-classifier";
import { cropSatImageToBox } from "./crop";
import { segmentEavesViaVision } from "./vision";
import {
  detectRoofStructureViaVision,
  type DetectedRoofStructure,
} from "./roof-structure";
import { buildSegmentRidges } from "./segment-ridges";
import {
  buildEditableLines,
  countCorners,
  eavesFromRoofPolygon,
  imagePixelToLatLng,
  latLngToImagePixel,
  measurementsFromVision,
  pixelLengthToFeet,
  placeDownspouts,
  placeDownspoutsOnPolygon,
  pointInPolygon,
  polylineLengthPx,
  simplify,
  transformToCanvas,
} from "./geometry";
import {
  sampleEaves,
  sampleDownspouts,
  sampleMeasurements,
} from "@/lib/mock-estimate";
import type {
  EditableLine,
  Downspout,
  Measurements,
  RoofStructure,
  Stories,
} from "@/lib/types";

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
  /** Optional perimeter + ridge/valley overlay for the visual annotation
   *  layer. Detected via GPT-4o vision in parallel with the eaves
   *  pipeline; null when the vision call fails or no image is available. */
  roofStructure?: RoofStructure;
};

/**
 * Project a vision-detected roof structure (cropped-image-pixel coords)
 * into the SVG canvas's 900×580 viewBox so the overlay component can
 * render lines straight onto the displayed satellite tile. Ridges and
 * valleys whose MIDPOINT falls outside the building footprint are
 * dropped — those are vision-call hallucinations placed in the yard.
 *
 * When `solarRidgesImagePx` is supplied (Solar API roof segments are
 * available), the ridges from that deterministic source REPLACE any
 * vision-detected ridges. The vision call still contributes valleys —
 * Solar's per-segment data doesn't tell us where two adjacent
 * segments meet at an inside corner.
 */
function detectedToCanvasRoofStructure(
  detected: DetectedRoofStructure | null,
  cropOffset: { x: number; y: number },
  imageWidth: number,
  imageHeight: number,
  /** Footprint polygon in ORIGINAL image-pixel space, used as the
   *  inside-test for filtering out off-roof labels. */
  footprintImagePx: { x: number; y: number }[] | null,
  /** Deterministic ridges in ORIGINAL image-pixel space, derived from
   *  Solar API roof segments. When non-empty, replaces vision ridges. */
  solarRidgesImagePx: { id: string; a: { x: number; y: number }; b: { x: number; y: number } }[],
): RoofStructure {
  const toOriginal = (pts: { x: number; y: number }[]) =>
    pts.map((p) => ({ x: p.x + cropOffset.x, y: p.y + cropOffset.y }));
  const toCanvas = (pts: { x: number; y: number }[]) =>
    transformToCanvas(toOriginal(pts), imageWidth, imageHeight);

  const insideFootprintCropped = (line: { points: { x: number; y: number }[] }) => {
    if (!footprintImagePx || footprintImagePx.length < 3) return true;
    const original = toOriginal(line.points);
    if (original.length < 2) return false;
    const a = original[0];
    const b = original[original.length - 1];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return pointInPolygon(mid, footprintImagePx);
  };

  const insideFootprintOriginal = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    if (!footprintImagePx || footprintImagePx.length < 3) return true;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return pointInPolygon(mid, footprintImagePx);
  };

  // Solar ridges are already in ORIGINAL image-pixel space (from
  // latLngToImagePixel) — skip the cropOffset translation and go
  // straight to canvas coords via transformToCanvas.
  const ridges =
    solarRidgesImagePx.length > 0
      ? solarRidgesImagePx
          .filter((r) => insideFootprintOriginal(r.a, r.b))
          .map((r) => ({
            id: r.id,
            kind: "ridge" as const,
            points: transformToCanvas([r.a, r.b], imageWidth, imageHeight),
            label: "RIDGE",
          }))
      : (detected?.ridges ?? [])
          .filter(insideFootprintCropped)
          .map((r) => ({
            id: r.id,
            kind: "ridge" as const,
            points: toCanvas(r.points),
            label: r.label ?? "RIDGE",
          }));

  const valleys = (detected?.valleys ?? [])
    .filter(insideFootprintCropped)
    .map((v) => ({
      id: v.id,
      kind: "valley" as const,
      points: toCanvas(v.points),
      label: v.label ?? "VALLEY",
    }));

  return {
    perimeter: footprintImagePx 
      ? transformToCanvas(footprintImagePx, imageWidth, imageHeight)
      : detected ? toCanvas(detected.perimeter) : [],
    ridges,
    valleys,
    confidence: detected?.confidence ?? 0.85,
  };
}

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
      const providerLabel =
        image.source === "mapbox" ? "Mapbox (Maxar Vivid)" : "Google Static Maps";
      notes.push(
        `Fetched ${image.width}×${image.height} satellite tile via ${providerLabel} @ z${image.zoom}`,
      );
    } else {
      notes.push(`Satellite tile fetch failed — ${imgOutcome.reason}`);
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
  let solarRoofSegments: RoofSegment[] = [];
  if (image) {
    const insights = await getBuildingInsights(geocoded.lat, geocoded.lng);
    if (insights) {
      solarRoofSegments = insights.roofSegments;
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

  // Fire the recreational roof-structure annotation in parallel with the
  // Solar mask / DSM / SAM work below. It's a separate GPT-4o call so we
  // don't want it serialized after the eaves pipeline. Awaited via
  // `resolveRoofStructure()` at each return path; if the call fails the
  // result is undefined and we just skip the overlay.
  const roofStructurePromise: Promise<DetectedRoofStructure | null> = image
    ? detectRoofStructureViaVision(
        workImage,
        didCrop
          ? null
          : (buildingBoxPx ?? buildingPointPx ?? null),
      )
    : Promise.resolve(null);
  const resolveRoofStructure = async (): Promise<RoofStructure | undefined> => {
    if (!image) return undefined;
    const detected = await roofStructurePromise;

    // Build deterministic ridges from the Solar roof-segment data we
    // already fetched. Each segment's center + azimuth + bbox gives a
    // ridge line anchored on the actual roof plane — no vision
    // hallucination, no off-roof labels.
    const solarRidges =
      solarRoofSegments.length > 0
        ? buildSegmentRidges(
            solarRoofSegments,
            { lat: geocoded.lat, lng: geocoded.lng },
            image.zoom,
            image.width,
            image.height,
          )
        : [];

    if (!detected && solarRidges.length === 0) {
      notes.push("Roof structure overlay unavailable (no Solar segments, vision call failed)");
      return undefined;
    }

    const projected = detectedToCanvasRoofStructure(
      detected,
      cropOffset,
      image.width,
      image.height,
      roofPolygon ? roofPolygon.points : null,
      solarRidges,
    );
    const ridgeSource =
      solarRidges.length > 0 ? "Solar segments" : "vision";
    notes.push(
      `Roof structure: ${projected.ridges.length} ridge(s) (${ridgeSource}), ${projected.valleys.length} valley(s)`,
    );
    return projected;
  };

  // 4. Build the roof footprint polygon + classify edges as eaves vs rakes.
  //
  // PRIMARY: SAM 2 via fal.ai. It traces the high-resolution satellite
  // image directly, producing crisp 90° architectural corners. Sharp
  // corners are critical for the azimuth-based eave/rake classifier — a
  // wall traced at the actual slab angle gives an outward-normal that
  // aligns with the Solar segment's down-slope azimuth within a few
  // degrees on eaves and is way off on rakes.
  //
  // FALLBACK: Google Solar API building mask (GeoTIFF). Cheap and works
  // when the address has Solar coverage, but the mask is a low-res
  // pixelated blob — tracing it tends to round corners and warp wall
  // angles, which causes the azimuth math to flag rakes as eaves.
  let roofPolygon: RoofPolygon | null = null;
  type ClassifiedEdge = {
    a: { lat: number; lng: number };
    b: { lat: number; lng: number };
  };
  let classifiedEaveLatLng: ClassifiedEdge[] | null = null;

  // Helper used by both source paths. Returns null when no Solar segments
  // are available (caller falls through with all polygon edges as eaves).
  const classifyRingViaAzimuth = (
    ring: { lat: number; lng: number }[],
  ): ClassifiedEdge[] | null => {
    if (solarRoofSegments.length === 0) {
      notes.push(`No Solar roof segments available — using all polygon edges as eaves`);
      return null;
    }
    const centroid = ringCentroid(ring);
    const eaves: ClassifiedEdge[] = [];
    let rakeCount = 0;
    let unknownCount = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      const cls = classifyEdgeWithAzimuth({ a, b }, solarRoofSegments, centroid);
      if (cls.kind === "eave") eaves.push({ a, b });
      else if (cls.kind === "rake") rakeCount++;
      else unknownCount++;
    }
    notes.push(
      `Azimuth filter (±35°): ${eaves.length} eaves, ${rakeCount} rakes dropped, ${unknownCount} unknown`,
    );
    return eaves;
  };

  // 4a. PRIMARY: SAM 2 high-res segmentation.
  if (image) {
    const samPoint = didCrop
      ? { x: Math.round(workImage.width / 2), y: Math.round(workImage.height / 2) }
      : (buildingPointPx ?? undefined);
    const samOutcome = await segmentRoofViaSam(workImage, samPoint);
    if (samOutcome.ok && samOutcome.polygon.points.length >= 8) {
      const translatedPoints = samOutcome.polygon.points.map(translatePoint);
      // Collapse the SAM mask's pixel-stair jaggies into architectural
      // corners BEFORE classification. The raw boundary trace has ~400
      // points per roof; without this the azimuth filter runs over
      // dozens of 6–12 LF stub edges that aren't real walls (each one
      // ends up rendered as a separate cyan LF label in the canvas).
      // epsilon ≈ 8 px @ zoom-20 ≈ 4 ft — anything tighter is mask noise.
      const rawCount = translatedPoints.length;
      const simplifiedPoints = simplify(translatedPoints, 8);
      const finalPoints =
        simplifiedPoints.length >= 4 ? simplifiedPoints : translatedPoints;
      roofPolygon = {
        points: finalPoints,
        bbox: {
          x: samOutcome.polygon.bbox.x + cropOffset.x,
          y: samOutcome.polygon.bbox.y + cropOffset.y,
          width: samOutcome.polygon.bbox.width,
          height: samOutcome.polygon.bbox.height,
        },
        areaFraction: samOutcome.polygon.areaFraction,
      };
      notes.push(
        `SAM 2 (primary): ${rawCount} raw → ${finalPoints.length} simplified verts, covers ${(
          roofPolygon.areaFraction * 100
        ).toFixed(1)}% of crop`,
      );

      // Project the SIMPLIFIED pixel-space polygon back into lat/lng so
      // the azimuth classifier sees architectural corners instead of mask
      // stair-steps. Same input shape the Solar path uses.
      const ring: { lat: number; lng: number }[] = finalPoints.map((p) =>
        imagePixelToLatLng(
          p.x,
          p.y,
          geocoded.lat,
          geocoded.lng,
          image.zoom,
          image.width,
          image.height,
        ),
      );
      // Ensure the ring is closed (first == last) for the classifier.
      if (
        ring.length > 0 &&
        (ring[0].lat !== ring[ring.length - 1].lat ||
          ring[0].lng !== ring[ring.length - 1].lng)
      ) {
        ring.push(ring[0]);
      }
      classifiedEaveLatLng = classifyRingViaAzimuth(ring);
    } else if (samOutcome.ok) {
      notes.push(
        `SAM 2 polygon too small (${samOutcome.polygon.points.length} verts) — trying Solar fallback`,
      );
    } else {
      notes.push(`SAM 2 failed — ${samOutcome.reason}; trying Solar fallback`);
    }
  }

  // 4b. FALLBACK: Google Solar building mask. Only fetched when SAM 2
  // didn't produce a usable polygon.
  if (image && !roofPolygon) {
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
        const cleanupLabel =
          result.cleanup.kind === "ortho"
            ? `ortho ✓ (${result.cleanup.vertCount} verts)`
            : result.cleanup.kind === "simplified"
              ? `ortho ✗ (${result.cleanup.reason}) — using DP-simplified ${result.cleanup.vertCount} verts`
              : `ortho ✗ + DP ✗ (${result.cleanup.reason}) — raw ${result.cleanup.vertCount} verts`;
        notes.push(
          `Solar mask fallback (${solarMask.crsLabel}): ${solarMask.width}×${solarMask.height} GeoTIFF → ${cleanupLabel}, bbox ${result.polygon.bbox.width}×${result.polygon.bbox.height} px @ (${result.polygon.bbox.x},${result.polygon.bbox.y})`,
        );
        classifiedEaveLatLng = classifyRingViaAzimuth(result.ringLatLng);
      } else {
        notes.push(
          `Solar mask polygon too small (${result?.polygon.points.length ?? 0} verts)`,
        );
      }
    } else {
      notes.push(`Solar mask unavailable — ${solarMask.reason}`);
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

      const roofStructure = await resolveRoofStructure();
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
        roofStructure,
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

      const roofStructure = await resolveRoofStructure();
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
        roofStructure,
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
  const roofStructure = await resolveRoofStructure();
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
    roofStructure,
  };
}
