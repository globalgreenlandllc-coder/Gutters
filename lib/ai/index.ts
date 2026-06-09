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
import { detectTierBreakEaves } from "./tier-breaks";
import {
  buildEditableLines,
  classifyPolygonCorners,
  countCorners,
  eavesFromRoofPolygon,
  imagePixelToLatLng,
  latLngToImagePixel,
  measurementsFromVision,
  mergeCollinearEaves,
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
  /** Edges the classifier identified as rakes (sloped gable edges that
   *  do NOT get gutters). Rendered on the canvas as gray-dashed
   *  "no-gutter" lines so the contractor can verify what was excluded
   *  rather than wondering whether the AI quietly dropped real eaves. */
  rakes: EditableLine[];
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
      if (image.primaryFailureReason) {
        notes.push(
          `Mapbox primary failed (${image.primaryFailureReason}) — fell back to Google`,
        );
      }
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
  // Rakes are retained (not just counted) so the canvas can render them
  // as gray-dashed "no-gutter" edges. Surfaces what the AI excluded so
  // the contractor can verify the classification — a missing eave is
  // expensive, but a rake the contractor can't see being excluded is a
  // trust problem.
  let classifiedRakeLatLng: ClassifiedEdge[] = [];

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
    const rakes: ClassifiedEdge[] = [];
    let unknownCount = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      const cls = classifyEdgeWithAzimuth({ a, b }, solarRoofSegments, centroid);
      if (cls.kind === "eave") eaves.push({ a, b });
      else if (cls.kind === "rake") rakes.push({ a, b });
      else unknownCount++;
    }
    classifiedRakeLatLng = rakes;
    notes.push(
      `Azimuth filter (±50°): ${eaves.length} eaves, ${rakes.length} rakes, ${unknownCount} unknown`,
    );
    return eaves;
  };

  // 4a. PRIMARY: SAM 2 high-res segmentation.
  if (image) {
    const samPoint = didCrop
      ? { x: Math.round(workImage.width / 2), y: Math.round(workImage.height / 2) }
      : (buildingPointPx ?? undefined);
    const samOutcome = await segmentRoofViaSam(workImage, samPoint);
    // Gate SAM acceptance on areaFraction. A real residential roof, tightly
    // cropped, occupies 20–55% of the crop. Anything below ~15% means SAM
    // locked onto a sub-region (one gable, a high-contrast plane, a
    // chimney) rather than the whole footprint — we'd render a tiny eave
    // run that the contractor would have to redraw entirely. Fall through
    // to the Solar mask in that case; the Solar polygon traces wall
    // outlines and is robust against multi-gable hip roofs that confuse
    // SAM's box prompt.
    const SAM_MIN_AREA_FRACTION = 0.15;
    if (
      samOutcome.ok &&
      samOutcome.polygon.points.length >= 8 &&
      samOutcome.polygon.areaFraction >= SAM_MIN_AREA_FRACTION
    ) {
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
      const reason =
        samOutcome.polygon.points.length < 8
          ? `${samOutcome.polygon.points.length} verts`
          : `${(samOutcome.polygon.areaFraction * 100).toFixed(1)}% coverage (need ≥${(SAM_MIN_AREA_FRACTION * 100).toFixed(0)}% — likely segmented one wing not whole roof)`;
      notes.push(`SAM 2 rejected: ${reason} — trying Solar fallback`);
    } else {
      notes.push(`SAM 2 failed — ${samOutcome.reason}; trying Solar fallback`);
    }
  }

  // 4b. FALLBACK: Google Solar building mask. Only fetched when SAM 2
  // didn't produce a usable polygon.
  //
  // Sanity check: the Solar mask sometimes returns ONLY one wing of a
  // multi-tier roof (the highest tier, since lower planes can be
  // partially obscured in the DSM). On a 2-story main + 1-story
  // wraparound this gives a polygon that traces just the main mass and
  // misses every lower eave. We catch this by comparing the polygon's
  // bbox area against the image area — if it's <55% of the work image,
  // we treat the Solar mask as unreliable and fall through to GPT-4o
  // vision which sees the whole frame.
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
        const polygonBboxArea =
          result.polygon.bbox.width * result.polygon.bbox.height;
        const workArea = workImage.width * workImage.height;
        const coverage = polygonBboxArea / workArea;
        // Threshold: below 55% suggests the mask captured one wing of
        // a multi-tier roof. Above that, it's probably the whole house.
        const MASK_COVERAGE_FLOOR = 0.55;
        if (coverage < MASK_COVERAGE_FLOOR) {
          notes.push(
            `Solar mask covered only ${(coverage * 100).toFixed(0)}% of work image (bbox ${result.polygon.bbox.width}×${result.polygon.bbox.height} px) — likely one wing of a multi-tier roof. Falling through to vision.`,
          );
        } else {
          roofPolygon = result.polygon;
          const cleanupLabel =
            result.cleanup.kind === "ortho"
              ? `ortho ✓ (${result.cleanup.vertCount} verts)`
              : result.cleanup.kind === "simplified"
                ? `ortho ✗ (${result.cleanup.reason}) — using DP-simplified ${result.cleanup.vertCount} verts`
                : `ortho ✗ + DP ✗ (${result.cleanup.reason}) — raw ${result.cleanup.vertCount} verts`;
          notes.push(
            `Solar mask fallback (${solarMask.crsLabel}): ${solarMask.width}×${solarMask.height} GeoTIFF → ${cleanupLabel}, bbox ${result.polygon.bbox.width}×${result.polygon.bbox.height} px @ (${result.polygon.bbox.x},${result.polygon.bbox.y}), ${(coverage * 100).toFixed(0)}% coverage`,
          );
          classifiedEaveLatLng = classifyRingViaAzimuth(result.ringLatLng);
        }
      } else {
        notes.push(
          `Solar mask polygon too small (${result?.polygon.points.length ?? 0} verts)`,
        );
      }
    } else {
      notes.push(`Solar mask unavailable — ${solarMask.reason}`);
    }
  }

  // 4c. Tier-break detection: a real roof often has stacked tiers
  //     (1-story garage wing attached to a 2-story main, dormers, etc.).
  //     The outer perimeter trace only finds eaves along the building
  //     footprint — it misses every "upper roof drops onto lower roof"
  //     situation. We pick those up here using Solar's per-segment
  //     planeHeightMeters: any segment whose plane sits >18" above the
  //     median roof height has a downhill bbox edge that probably needs
  //     its own gutter. Duplicates (an existing perimeter eave already
  //     within 1.5m) are filtered.
  if (solarRoofSegments.length > 0) {
    const perimeterEdges = (classifiedEaveLatLng ?? []).map((e) => ({
      a: e.a,
      b: e.b,
    }));
    const { candidates: tierBreaks, diag } = detectTierBreakEaves(
      solarRoofSegments,
      perimeterEdges,
    );
    if (tierBreaks.length > 0) {
      const added = tierBreaks.map((t) => ({ a: t.edge.a, b: t.edge.b }));
      classifiedEaveLatLng = [...(classifiedEaveLatLng ?? []), ...added];
      const meanStepFt =
        (tierBreaks.reduce((s, t) => s + t.stepMeters, 0) /
          tierBreaks.length) *
        3.28084;
      notes.push(
        `Tier-break detector: +${tierBreaks.length} interior eave${
          tierBreaks.length === 1 ? "" : "s"
        } (upper tier averages ${meanStepFt.toFixed(1)} ft above baseline)`,
      );
    } else if (diag.segmentsWithHeight === 0) {
      notes.push(
        `Tier-break detector: Solar API didn't return plane heights for any of ${diag.segmentsTotal} segments — interior tiers can't be auto-detected on this property`,
      );
    } else {
      const range =
        diag.heightMax !== null && diag.heightMin !== null
          ? ((diag.heightMax - diag.heightMin) * 3.28084).toFixed(1)
          : "?";
      notes.push(
        `Tier-break detector: no elevated tiers (${diag.segmentsWithHeight}/${diag.segmentsTotal} segments have height; range ${range} ft, baseline @ ${diag.baselineUsed?.toFixed(2)}m, threshold ${diag.stepThresholdM}m)`,
      );
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
    let rakes: EditableLine[] = [];
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
      // Coverage gate: when the azimuth filter strips more than half the
      // perimeter, the result reads as a handful of disconnected eave
      // stubs floating around an otherwise unmarked roof — useless to
      // the contractor and embarrassing in the UI. In that case we
      // discard the classification and treat EVERY polygon edge as a
      // candidate eave; the contractor deletes the rakes manually with
      // 1-click each. Better to show too much than to hide real eaves.
      let totalPolygonLF = 0;
      for (let i = 0; i < roofPolygon.points.length; i++) {
        const a = roofPolygon.points[i];
        const b = roofPolygon.points[(i + 1) % roofPolygon.points.length];
        totalPolygonLF += pixelLengthToFeet(
          Math.hypot(b.x - a.x, b.y - a.y),
          geocoded.lat,
          image.zoom,
        );
      }
      const coverage = totalPolygonLF > 0 ? dsmLF / totalPolygonLF : 0;
      // Coverage gate is now ONLY an upper-bound sanity check (≈100% of
      // perimeter classified as eave usually means the azimuth filter
      // broke — no rakes at all is impossible on a real hip/gable roof).
      //
      // Lower-bound gate removed deliberately: when the classifier kept
      // only 2-3 edges, falling back to "treat every polygon edge as a
      // gutter" was billing the homeowner for rakes/ridges they don't
      // get. Better to trust the classifier and surface the rakes the
      // AI flagged as gray-dashed "no-gutter" lines — the contractor
      // edits/adds manually from there.
      const MIN_EDGES = 2;
      const MAX_COVERAGE = 0.98;
      if (
        imageSpaceEdges.length >= MIN_EDGES &&
        coverage <= MAX_COVERAGE
      ) {
        eaves = imageSpaceEdges.map(([a, b], i) => ({
          id: `dsm-eave-${i}`,
          kind: "eave" as const,
          points: transformToCanvas([a, b], image.width, image.height),
        }));
        // Project the rakes the classifier flagged so the canvas can
        // render them as gray-dashed "no-gutter" edges. Same pixel
        // transform as eaves; we don't enforce MIN_EAVE_FT here since
        // showing a 1-ft rake stub still helps the contractor verify
        // the AI didn't quietly drop a real eave.
        rakes = classifiedRakeLatLng
          .map((edge, i) => {
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
            return {
              id: `dsm-rake-${i}`,
              kind: "rake" as const,
              points: transformToCanvas([a, b], image.width, image.height),
            };
          });
        totalEaveLF = dsmLF * 1.08;
        sourceLabel = "DSM-classified";
      } else {
        const why =
          imageSpaceEdges.length < MIN_EDGES
            ? `kept ${imageSpaceEdges.length} edge(s) — too few to trust`
            : `classified ${(coverage * 100).toFixed(0)}% as eave (filter likely broken)`;
        notes.push(
          `DSM ${why} — falling back to all ${roofPolygon.points.length} polygon edges`,
        );
      }
    }

    if (eaves.length === 0) {
      const fallback = buildPolygonEdgeEaves();
      eaves = fallback.eaves;
      totalEaveLF = fallback.lf;
      // Even in fallback, retain the AI's rake classification so the
      // contractor can SEE which edges the AI thought weren't gutters.
      // The cyan all-edges layer shows "treat as candidate"; the
      // gray-dashed overlay shows "AI's gut: probably not a gutter".
      // Two visuals competing on the same edge is intentional — the
      // dashed line draws on top and reads as "review this one".
      if (classifiedRakeLatLng.length > 0) {
        rakes = classifiedRakeLatLng.map((edge, i) => {
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
          return {
            id: `fallback-rake-${i}`,
            kind: "rake" as const,
            points: transformToCanvas([a, b], image.width, image.height),
          };
        });
      }
    }

    // Bumped from ≥3 to ≥5. Three eaves on a residential roof almost
    // never represents a real takeoff — it's an L-shape stub at best.
    // Below this floor we'd rather fall through to GPT-4o vision than
    // ship a sparse answer the contractor can't trust.
    if (eaves.length >= 5) {
      // Collapse runs that read as multiple segments on the canvas
      // (3 near-collinear vertices on one wall = one continuous eave)
      // before downspout placement and corner counting. Spacing math
      // wants long-run lengths, not stair-step splits.
      const beforeMerge = eaves.length;
      eaves = mergeCollinearEaves(eaves);
      if (eaves.length < beforeMerge) {
        notes.push(
          `Merged collinear eaves: ${beforeMerge} → ${eaves.length} continuous runs`,
        );
      }

      // Get the roof structure overlay early — we need its valley list
      // to weight downspout placement (valleys discharge water onto an
      // eave below; that's a natural drop point).
      const roofStructure = await resolveRoofStructure();
      const downspouts = placeDownspoutsOnPolygon(
        roofPolygon,
        eaves,
        image.width,
        image.height,
        estimatedStories,
        2.4,
        roofStructure?.valleys ?? [],
      );

      // Replace the 70/30 corner-count heuristic with the actual
      // outside/inside split from polygon convexity. Falls back to the
      // heuristic when the polygon is degenerate.
      const cornerCount = countCorners(eaves);
      const cornerSplit = classifyPolygonCorners(
        roofPolygon,
        image.width,
        image.height,
      );
      const measurements = measurementsFromVision({
        eaveLF: totalEaveLF,
        downspoutCount: downspouts.length,
        cornerCount,
        stories: estimatedStories,
        outsideCorners:
          cornerSplit.outside + cornerSplit.inside > 0
            ? cornerSplit.outside
            : undefined,
        insideCorners:
          cornerSplit.outside + cornerSplit.inside > 0
            ? cornerSplit.inside
            : undefined,
      });

      notes.push(
        `Eaves (${sourceLabel}): ${eaves.length} segments, ${downspouts.length} downspouts${rakes.length > 0 ? `, ${rakes.length} rakes (no gutter)` : ""}`,
      );
      if (cornerSplit.outside + cornerSplit.inside > 0) {
        notes.push(
          `Corners (polygon geometry): ${cornerSplit.outside} outside, ${cornerSplit.inside} inside`,
        );
      }
      return {
        geocoded,
        measurements,
        eaves,
        rakes,
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
      if (segmentation.roofLevels) {
        const levelLabel =
          segmentation.roofLevels === "multi_level"
            ? "multi-level (vision)"
            : "single-level (vision)";
        notes.push(
          `Roof levels: ${levelLabel}${
            segmentation.levelCues ? ` — ${segmentation.levelCues}` : ""
          }`,
        );
      }
      if (segmentation.attachedStructures && segmentation.attachedStructures.length > 0) {
        const summary = segmentation.attachedStructures
          .map((s) => {
            const flag = s.needsGutter === false ? " (no gutter)" : "";
            return `${s.kind}${flag}`;
          })
          .join(", ");
        notes.push(`Attached: ${summary}`);
      }
      if (segmentation.obstructions && segmentation.obstructions.length > 0) {
        const counts = new Map<string, number>();
        for (const o of segmentation.obstructions) {
          counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
        }
        const summary = [...counts.entries()]
          .map(([k, n]) => `${n}× ${k}`)
          .join(", ");
        notes.push(`Obstructions: ${summary}`);
      }
      if (segmentation.scaleReference) {
        notes.push(`Vision scale ref: ${segmentation.scaleReference}`);
      }
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
        // Vision path doesn't classify rakes — it only traces gutter
        // candidates. Contractor sees all candidates as cyan eaves; no
        // dashed-rake overlay because we don't know which were excluded.
        rakes: [],
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
    rakes: [],
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
