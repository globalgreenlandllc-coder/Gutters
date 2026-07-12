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
import { footprintMaskFromSolarSegments } from "./solar-segment-footprint";

import { classifyEdgeWithAzimuth, ringCentroid } from "./edge-classifier";
import { cropSatImageToBox } from "./crop";
import { rectifyOutline } from "./rectify-outline";
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
  canvasPxPerFoot,
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
import { countOpenEaveEnds } from "./roof-geom";
import {
  assessSatelliteTrace,
  type FootprintBboxCanvas,
  type TraceQuality,
} from "./trace-quality";
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
  /** Canvas-pixels-per-foot for THIS estimate's trace. Set only for
   *  satellite estimates (where eaves are COVER-fit onto the viewBox and
   *  1 ft ≠ 2.4 px); absent for plan takeoffs, which are laid out at the
   *  fixed PX_PER_FT and so use that default. The client divides canvas
   *  px by this (not the hardcoded 2.4) so the legend + live re-priced LF
   *  match the server's measurements.eaveLF. */
  canvasPxPerFt?: number;
  /** Plan-based estimates: PDF page reference for the canvas to render
   *  as the takeoff background. The browser fetches `pdfUrl` (an
   *  authenticated proxy on /api/blueprints/[id]/pdf), rasterizes the
   *  requested page via pdfjs-dist, and uses that image as the
   *  background instead of the satellite cartoon. Page is 1-based. */
  planSource?: {
    pdfUrl: string;
    pageIndex: number;
    /** Total pages in the PDF — bounds the sheet selector. */
    pageCount?: number;
    /** Classifier sheet inventory so the contractor can flip the
     *  underlay to the right drawing (roof plan vs foundation/floor),
     *  labelled. 1-based pageIndex. `sheetType`/`elevationSide` carry the
     *  classifier's per-sheet type + (for elevations) which face it shows —
     *  used by the Elevations view to show the four real side drawings. */
    sheets?: {
      pageIndex: number;
      label: string;
      sheetType?: string;
      elevationSide?: string;
    }[];
  };
  /** Optional perimeter + ridge/valley overlay for the visual annotation
   *  layer. Detected via GPT-4o vision in parallel with the eaves
   *  pipeline; null when the vision call fails or no image is available. */
  roofStructure?: RoofStructure;
  /** Trust signal for the satellite auto-trace. Drives the "bad pic —
   *  draw it yourself" banner on the results screen. Absent for plan
   *  takeoffs (their geometry comes from the PDF, not image tracing). */
  traceQuality?: TraceQuality;
  /** Suggested INTERIOR gutter runs — the downhill edges of elevated
   *  Solar roof tiers ("upper roof drops onto lower roof"), which the
   *  outer-perimeter trace structurally can't see. These are UN-PRICED
   *  hints only: they are NEVER summed into measurements.eaveLF and never
   *  auto-merged into `eaves`. The canvas/diagram draws them dashed with a
   *  tap-to-add affordance; accepting one moves it into the priced eaves.
   *  Canvas (900×580) space, same as `eaves`. Empty when no tier-breaks
   *  were detected (or no Solar coverage). */
  suggestedEaves?: EditableLine[];
};

/**
 * Union of the Google Solar roof-segment bounding boxes, projected into
 * canvas (900×580) space and padded for overhang — a coarse "is the
 * trace even on the building?" gate for assessSatelliteTrace, plus the
 * footprint area in ft². null when there's no Solar coverage or no
 * satellite image to project against.
 */
function solarFootprintCanvas(
  segments: RoofSegment[],
  geocoded: { lat: number; lng: number },
  image: { width: number; height: number; zoom: number } | null,
): { areaFt2: number; bbox: FootprintBboxCanvas } | null {
  if (!image) return null;
  const M2_TO_FT2 = 10.7639;
  let areaFt2 = 0;
  const latLngs: { lat: number; lng: number }[] = [];
  for (const s of segments) {
    areaFt2 += (s.areaMeters2 ?? 0) * M2_TO_FT2;
    if (s.boundingBoxNE) latLngs.push(s.boundingBoxNE);
    if (s.boundingBoxSW) latLngs.push(s.boundingBoxSW);
    if (s.center) latLngs.push(s.center);
  }
  if (latLngs.length === 0) return null;
  const canvasPts = transformToCanvas(
    latLngs.map((p) =>
      latLngToImagePixel(
        p.lat,
        p.lng,
        geocoded.lat,
        geocoded.lng,
        image.zoom,
        image.width,
        image.height,
      ),
    ),
    image.width,
    image.height,
  );
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of canvasPts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return null;
  // Pad ~7% of the viewBox so eave overhang + the axis-aligned-bbox slack
  // don't read as "off the roof".
  const PAD_X = 64;
  const PAD_Y = 42;
  return {
    areaFt2,
    bbox: {
      minX: minX - PAD_X,
      minY: minY - PAD_Y,
      maxX: maxX + PAD_X,
      maxY: maxY + PAD_Y,
    },
  };
}

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
  // True when roofPolygon was synthesized from Solar segment bboxes (both
  // image tracers failed) — a coarse footprint that must be trace-quality
  // flagged so it never reads "ok".
  let usedCoarseFootprint = false;
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
    // Hand SAM a TIGHT box hugging the actual building (Google Solar bbox
    // translated into work-image space + ~10px overhang pad), instead of
    // letting sam.ts default to the whole-crop-minus-5% box. The crop
    // carries ~120px of yard on every side, so the default box invites SAM
    // to lock onto one bright plane (this house: 3.7% coverage → rejected).
    // Bounded: a mis-tightened box still faces the unchanged 15% area gate
    // and Solar-mask fallback, so worst case === today.
    let samBox:
      | { x_min: number; y_min: number; x_max: number; y_max: number }
      | undefined;
    if (buildingBoxPx) {
      const PAD = 10;
      const bx1 = buildingBoxPx.x1 - cropOffset.x - PAD;
      const by1 = buildingBoxPx.y1 - cropOffset.y - PAD;
      const bx2 = buildingBoxPx.x2 - cropOffset.x + PAD;
      const by2 = buildingBoxPx.y2 - cropOffset.y + PAD;
      if (bx2 - bx1 > 20 && by2 - by1 > 20) {
        samBox = { x_min: bx1, y_min: by1, x_max: bx2, y_max: by2 };
      }
    }
    // SAM runs at the crop's NATIVE resolution. A prior 2× upscale (for
    // sub-pixel corner accuracy) quadrupled the fal.ai payload and pushed
    // requests past fal's 35s server timeout — SAM would then hard-fail and
    // the trace fell all the way through to the crude vision rectangle. The
    // marginal corner gain isn't worth regressing the PRIMARY tracer into a
    // total miss; the rectify pass below recovers clean corners for free.
    // Gate SAM acceptance on areaFraction. A real residential roof, tightly
    // cropped, occupies 20–55% of the crop. Anything below ~15% means SAM
    // locked onto a sub-region (one gable, a high-contrast plane, a
    // chimney) rather than the whole footprint — we'd render a tiny eave
    // run that the contractor would have to redraw entirely. Fall through
    // to the Solar mask in that case; the Solar polygon traces wall
    // outlines and is robust against multi-gable hip roofs that confuse
    // SAM's box prompt.
    const SAM_MIN_AREA_FRACTION = 0.15;
    let samOutcome = await segmentRoofViaSam(workImage, samPoint, samBox);
    // MULTI-WING RETRY: on a big roof the box prompt locks onto one bright
    // plane (this house: 4.2%). Google Solar already handed us a center per
    // roof segment — seed a positive SAM point inside every wing so SAM 2
    // unions all the planes into the whole footprint. Fires ONCE, only when
    // the box result under-segmented AND the roof is genuinely multi-plane;
    // the seeded retry is kept only if it covers MORE than the box alone,
    // so the worst case is one extra fal call and === today's fallthrough.
    const boxCoverage = samOutcome.ok ? samOutcome.polygon.areaFraction : 0;
    if (boxCoverage < SAM_MIN_AREA_FRACTION && solarRoofSegments.length >= 4) {
      const seeds = solarRoofSegments
        .map((s) => s.center)
        .filter((c): c is { lat: number; lng: number } => !!c)
        .map((c) => {
          const px = latLngToImagePixel(
            c.lat,
            c.lng,
            geocoded.lat,
            geocoded.lng,
            image.zoom,
            image.width,
            image.height,
          );
          return { x: px.x - cropOffset.x, y: px.y - cropOffset.y };
        })
        .filter(
          (p) =>
            p.x >= 0 &&
            p.y >= 0 &&
            p.x <= workImage.width &&
            p.y <= workImage.height,
        );
      if (seeds.length >= 2) {
        const retry = await segmentRoofViaSam(workImage, samPoint, samBox, seeds);
        const retryCoverage = retry.ok ? retry.polygon.areaFraction : 0;
        notes.push(
          `SAM multi-wing retry (${seeds.length} Solar-segment seeds): ${(
            retryCoverage * 100
          ).toFixed(1)}% coverage vs ${(boxCoverage * 100).toFixed(1)}% box-only`,
        );
        if (retryCoverage > boxCoverage) samOutcome = retry;
      }
    }
    // OFF-BUILDING QUALITY GATE. Coverage ≠ correctness: the multi-wing
    // retry can hit 42% area by grabbing shadow/pavement/neighbor roof, so
    // its boundary wanders far off the actual building (a jagged mess of
    // eave stubs in the yard). Measure what fraction of the SAM outline
    // falls outside the Google Solar footprint bbox (projected to image
    // px); if most of it is off-building, REJECT the trace so we fall to
    // the deterministic Solar-segment outline instead of shipping garbage.
    // Only gates when Solar gave us a footprint to check against.
    const SAM_MAX_OFF_BUILDING = 0.35;
    let samOffBuildingFrac = 0;
    if (samOutcome.ok && samOutcome.polygon.points.length >= 8) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const s of solarRoofSegments) {
        for (const ll of [s.boundingBoxNE, s.boundingBoxSW, s.center]) {
          if (!ll) continue;
          const px = latLngToImagePixel(
            ll.lat,
            ll.lng,
            geocoded.lat,
            geocoded.lng,
            image.zoom,
            image.width,
            image.height,
          );
          minX = Math.min(minX, px.x);
          minY = Math.min(minY, px.y);
          maxX = Math.max(maxX, px.x);
          maxY = Math.max(maxY, px.y);
        }
      }
      if (Number.isFinite(minX) && maxX > minX && maxY > minY) {
        // ~15% overhang pad so real eaves just past the wall aren't counted off.
        const padX = (maxX - minX) * 0.15;
        const padY = (maxY - minY) * 0.15;
        const lo = { x: minX - padX, y: minY - padY };
        const hi = { x: maxX + padX, y: maxY + padY };
        const tp = samOutcome.polygon.points.map(translatePoint);
        const off = tp.filter(
          (p) => p.x < lo.x || p.x > hi.x || p.y < lo.y || p.y > hi.y,
        ).length;
        samOffBuildingFrac = tp.length > 0 ? off / tp.length : 0;
      }
    }
    if (
      samOutcome.ok &&
      samOffBuildingFrac > SAM_MAX_OFF_BUILDING &&
      solarRoofSegments.length >= 4
    ) {
      notes.push(
        `SAM trace rejected: ${(samOffBuildingFrac * 100).toFixed(0)}% of the outline fell outside the Google Solar footprint (the mask grabbed shadow/yard). Using the deterministic Solar-segment outline instead.`,
      );
    }
    if (
      samOutcome.ok &&
      samOutcome.polygon.points.length >= 8 &&
      samOutcome.polygon.areaFraction >= SAM_MIN_AREA_FRACTION &&
      !(samOffBuildingFrac > SAM_MAX_OFF_BUILDING && solarRoofSegments.length >= 4)
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
      let finalPoints =
        simplifiedPoints.length >= 4 ? simplifiedPoints : translatedPoints;
      // Manhattan-snap the simplified trace onto its guessed true wall
      // lines ("a little off? guess it"): forces clean 90° corners and
      // merges residual stair-steps. Tolerance ≈ 2.5 ft at this tile's
      // scale — derived through pixelLengthToFeet so it uses the exact
      // same Mercator convention as the LF math (no double-scale trap).
      // Non-rectilinear roofs and area-changing snaps bail internally.
      const ftPerPx = pixelLengthToFeet(1, geocoded.lat, image.zoom);
      if (ftPerPx > 0) {
        const rect = rectifyOutline(finalPoints, { snapTolPx: 2.5 / ftPerPx });
        if (rect.applied) {
          finalPoints = rect.points;
          notes.push(
            `Rectified outline: snapped to ${rect.points.length} right-angle corners (grid at ${rect.angleDeg.toFixed(1)}°)`,
          );
        } else {
          notes.push(`Rectify skipped: ${rect.reason}`);
        }
      }
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
  // When we reject the Solar mask polygon as too-small to use directly,
  // we still keep its bbox around as a *spatial hint* for the vision
  // call below — vision otherwise has no idea where in the crop the
  // building actually sits and traces whatever's biggest (often grass
  // + driveway). The bbox lives in the original-image coordinate
  // system; we translate it to crop space when handing it off.
  let rejectedSolarBboxOriginal: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;

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
        // Stash the bbox unconditionally — used as a focus hint for the
        // vision augmentation pass even when we accept the polygon.
        rejectedSolarBboxOriginal = {
          x: result.polygon.bbox.x,
          y: result.polygon.bbox.y,
          width: result.polygon.bbox.width,
          height: result.polygon.bbox.height,
        };
        // Lower threshold (was 0.55). A residential building with 120px
        // of crop padding around it commonly fills only 35–45% of the
        // work image. Even a "small" Solar mask gives us a real outer
        // outline we'd otherwise lose entirely. Vision still runs as
        // augmentation downstream when coverage is on the low end.
        const MASK_COVERAGE_FLOOR = 0.3;
        if (coverage >= MASK_COVERAGE_FLOOR) {
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
        } else {
          notes.push(
            `Solar mask covered only ${(coverage * 100).toFixed(0)}% — below ${(MASK_COVERAGE_FLOOR * 100).toFixed(0)}% floor. Falling through to vision with the bbox as a focus hint.`,
          );
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

  // 4b-ii. SOLAR-SEGMENT FOOTPRINT FALLBACK. Both image tracers failed
  //   (SAM couldn't lock on, the raster mask was too sparse), but Solar
  //   still handed us a bounding box PER roof plane. Those boxes come from
  //   a different Solar product than the sparse mask and collectively
  //   cover the whole roof — union them into a synthetic mask and trace it
  //   with the same machinery. Deterministic and image-independent, but a
  //   coarse over-approximation (axis-aligned plane bboxes), so it's
  //   trace-quality-flagged (usedCoarseFootprint) and never reads "ok".
  //   This is the deterministic floor under the weak GPT-4o vision path.
  if (image && !roofPolygon && solarRoofSegments.length >= 4) {
    const segMask = footprintMaskFromSolarSegments(solarRoofSegments);
    if (segMask) {
      const result = polygonFromSolarMask(
        segMask,
        { lat: geocoded.lat, lng: geocoded.lng },
        image.zoom,
        image.width,
        image.height,
      );
      if (result && result.polygon.points.length >= 8) {
        roofPolygon = result.polygon;
        usedCoarseFootprint = true;
        classifiedEaveLatLng = classifyRingViaAzimuth(result.ringLatLng);
        notes.push(
          `Solar-segment footprint fallback: unioned ${solarRoofSegments.length} roof planes → ${result.polygon.points.length}-vert outline (${(segMask.areaFraction * 100).toFixed(0)}% of the plane grid). Coarse (plane bounding boxes) — verify the outline against the image before pricing.`,
        );
      } else {
        notes.push(
          `Solar-segment footprint fallback produced too small a polygon (${result?.polygon.points.length ?? 0} verts) — falling through to vision.`,
        );
      }
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
  // Tier-break detector: still computed for diagnostics so we can see
  // when a multi-tier roof was detected, but no longer adds eaves to
  // the trace by default. The Solar segment bbox edges weren't real
  // roof edges — they were axis-aligned rectangles approximating
  // angular hip planes, so they drew as straight stubs through the
  // middle of the roof. Contractor adds these eaves manually with the
  // drawing tool when they exist.
  // Hoisted so BOTH return paths (polygon + vision) can feed the count
  // into trace-quality — a multi-tier roof whose interior gutters weren't
  // auto-drawn must never ship as "ok / no adjustment needed."
  let interiorTiersDetected = 0;
  // Un-priced "suggested interior gutter" hints, projected to canvas space.
  // Populated from the tier-break detector below; carried on EstimateResult
  // so the diagram/canvas can draw them dashed with a tap-to-add affordance.
  // NEVER summed into eaveLF (money-safe by construction).
  let suggestedEaves: EditableLine[] = [];
  if (solarRoofSegments.length > 0) {
    const perimeterEdges = (classifiedEaveLatLng ?? []).map((e) => ({
      a: e.a,
      b: e.b,
    }));
    const { candidates: tierBreaks, diag } = detectTierBreakEaves(
      solarRoofSegments,
      perimeterEdges,
    );
    interiorTiersDetected = tierBreaks.length;
    // Project each tier-break edge (lat/lng) into canvas space using the
    // SAME transform as the perimeter eaves/rakes (latLngToImagePixel →
    // transformToCanvas). Guarded on `image` (the projection needs the
    // tile dims); on the rare no-image path these stay empty.
    if (image && tierBreaks.length > 0) {
      suggestedEaves = tierBreaks.map((c, i) => {
        const a = latLngToImagePixel(
          c.edge.a.lat,
          c.edge.a.lng,
          geocoded.lat,
          geocoded.lng,
          image.zoom,
          image.width,
          image.height,
        );
        const b = latLngToImagePixel(
          c.edge.b.lat,
          c.edge.b.lng,
          geocoded.lat,
          geocoded.lng,
          image.zoom,
          image.width,
          image.height,
        );
        return {
          id: `suggested-tier-${i}`,
          kind: "eave" as const,
          points: transformToCanvas([a, b], image.width, image.height),
        };
      });
    }
    if (tierBreaks.length > 0) {
      const meanStepFt =
        (tierBreaks.reduce((s, t) => s + t.stepMeters, 0) /
          tierBreaks.length) *
        3.28084;
      notes.push(
        `Tier-break detected: ${tierBreaks.length} upper tier${
          tierBreaks.length === 1 ? "" : "s"
        } averaging ${meanStepFt.toFixed(1)} ft above baseline — add interior eaves manually with the drawing tool if needed`,
      );
    } else if (diag.segmentsWithHeight > 0) {
      const range =
        diag.heightMax !== null && diag.heightMin !== null
          ? ((diag.heightMax - diag.heightMin) * 3.28084).toFixed(1)
          : "?";
      notes.push(
        `Tier-break detector: single-tier roof (height range ${range} ft across ${diag.segmentsWithHeight} segments)`,
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
      // Coverage stats — purely informational now. The previous
      // upper-bound gate (>98% coverage → "filter likely broken" →
      // fall back to all polygon edges as eaves) was causing gables
      // and rakes to be billed as gutters whenever the tier-break
      // detector added interior eaves (since those increase the
      // numerator beyond the perimeter denominator). Trust the
      // classifier's per-edge rake/eave labels; surface coverage in
      // the notes only.
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
      const MIN_EDGES = 2;
      if (imageSpaceEdges.length >= MIN_EDGES) {
        if (coverage > 1.05) {
          notes.push(
            `DSM eave LF ${(coverage * 100).toFixed(0)}% of perimeter — extra is interior tier-break eaves, not a classifier bug. Keeping DSM classification.`,
          );
        }
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
        // Classification here runs through classifyEdgeWithAzimuth (Solar
        // plane azimuths), NOT the dead DSM classifier — label it honestly
        // so the run notes don't misdirect debugging.
        sourceLabel = "azimuth-classified";
      } else {
        notes.push(
          `DSM kept ${imageSpaceEdges.length} edge(s) — too few to trust, falling back to all ${roofPolygon.points.length} polygon edges`,
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

    // Over-trace signal (parity with the GPT-4o vision path's √area gate).
    // The primary SAM path is accepted purely on areaFraction ≥ 0.15,
    // which catches UNDER-trace (SAM locked onto one wing) but NOT
    // OVER-trace: SAM can grab roof + cast shadow, or roof + an adjacent
    // slab/driveway, swallowing the perimeter — that inflated LF would
    // otherwise ship as priced eaveLF marked "ok / no adjustment". Cross-
    // check the traced eave LF against Solar's reported roof area (a real
    // residential perimeter is ~5–8× √area). On an implausible ratio we
    // FLAG the trace UNUSABLE so the loud "bad pic — draw it yourself"
    // banner fires and the contractor redraws.
    //
    // We deliberately do NOT drop/zero the trace here. Solar area can be
    // PARTIAL (it reports a subset of planes), which understates the
    // denominator and inflates this ratio for a perfectly correct trace.
    // The vision fallback path divides by the SAME Solar area and THROWS
    // at >11, so zeroing-and-falling-through could compound the two
    // correlated gates into a hard address error on a good trace. Flagging
    // (not dropping) keeps the address available and is money-safe: an
    // over-trace ships loudly flagged for redraw, never silently as trusted.
    let polygonOvertrace = false;
    const overtraceSolarAreaM2 = solarRoofSegments.reduce(
      (s, seg) => s + (seg.areaMeters2 ?? 0),
      0,
    );
    if (eaves.length > 0 && overtraceSolarAreaM2 > 30) {
      const solarAreaSqft = overtraceSolarAreaM2 * 10.7639;
      const ratio = totalEaveLF / Math.sqrt(solarAreaSqft);
      if (ratio > 11) {
        polygonOvertrace = true;
        notes.push(
          `Polygon over-trace: ${totalEaveLF.toFixed(0)} LF / √(${solarAreaSqft.toFixed(
            0,
          )} sqft) = ${ratio.toFixed(
            1,
          )}× (max 11) — the traced outline may include shadow/pavement; flagged for redraw`,
        );
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
      // Eaves handed to placeDownspoutsOnPolygon are canvas-space (900×580
      // viewBox), so downspout spacing must divide by the SATELLITE
      // canvas-px-per-foot, NOT the plan-takeoff constant 2.4. Passing 2.4
      // inflates internal LF ~3× (this house's tile ≈7.2 px/ft), which
      // over-fires the per-30-LF target and the >35-ft mid-run rule and
      // over-places downspouts. Guard against a non-finite return (NaN ≤ 35
      // is false → a mid-run downspout on every eave), which the literal
      // 2.4 could never produce.
      const rawCpf = canvasPxPerFoot(
        geocoded.lat,
        image.zoom,
        image.width,
        image.height,
      );
      const cpf = Number.isFinite(rawCpf) && rawCpf > 0 ? rawCpf : 2.4;
      const downspouts = placeDownspoutsOnPolygon(
        roofPolygon,
        eaves,
        image.width,
        image.height,
        estimatedStories,
        cpf,
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
      // End caps belong at OPEN eave-run terminations (a run that stops in
      // mid-air, e.g. where an eave meets a rake), a topological quantity —
      // not the length-blind eaveLF/60 heuristic. Runs computed on the
      // post-merge eaves so continuous walls count as one run.
      const openEnds = countOpenEaveEnds(eaves);
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
        endCaps: Math.max(2, openEnds),
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
        canvasPxPerFt: canvasPxPerFoot(
          geocoded.lat,
          image.zoom,
          image.width,
          image.height,
        ),
        traceQuality: (() => {
          const fp = solarFootprintCanvas(solarRoofSegments, geocoded, image);
          const q = assessSatelliteTrace({
            source: "ai",
            eaves,
            totalEaveLF,
            footprintAreaFt2: fp?.areaFt2 ?? null,
            footprintBboxCanvas: fp?.bbox ?? null,
            interiorTiersDetected,
            segmentCount: solarRoofSegments.length,
            coarseFootprint: usedCoarseFootprint,
          });
          // An over-traced perimeter (swallowed shadow/pavement) must fire
          // the loud "draw it yourself" banner even if the other signals
          // read "ok" — the assessed ratio otherwise only reaches "low".
          if (polygonOvertrace) {
            return {
              status: "unusable" as const,
              confidence: Math.min(q.confidence, 0.3),
              reasons: [
                ...q.reasons,
                "Traced outline appears to include roof shadow or pavement (perimeter far exceeds roof area) — redraw the outline to price accurately.",
              ],
            };
          }
          return q;
        })(),
        roofStructure,
        suggestedEaves,
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
    // Build a building hint for vision in crop-space coords. Priority:
    //   1. Rejected Solar mask bbox (most precise — Solar found the
    //      building, we just didn't trust its polygon trace).
    //   2. Building bbox from Solar API insights (less precise).
    //   3. Building point from geocode (lowest precision).
    // Without a hint, vision sees a crop the same size as the building
    // PLUS its yard and traces whatever's biggest — usually the lawn,
    // driveway, and house all stitched into one giant polygon.
    let visionHint:
      | { x: number; y: number }
      | { x1: number; y1: number; x2: number; y2: number }
      | null = null;
    if (rejectedSolarBboxOriginal) {
      // Translate original-image bbox into crop-space.
      visionHint = {
        x1: rejectedSolarBboxOriginal.x - cropOffset.x,
        y1: rejectedSolarBboxOriginal.y - cropOffset.y,
        x2:
          rejectedSolarBboxOriginal.x +
          rejectedSolarBboxOriginal.width -
          cropOffset.x,
        y2:
          rejectedSolarBboxOriginal.y +
          rejectedSolarBboxOriginal.height -
          cropOffset.y,
      };
    } else if (!didCrop) {
      visionHint = buildingBoxPx ?? buildingPointPx ?? null;
    } else if (buildingBoxPx) {
      visionHint = {
        x1: buildingBoxPx.x1 - cropOffset.x,
        y1: buildingBoxPx.y1 - cropOffset.y,
        x2: buildingBoxPx.x2 - cropOffset.x,
        y2: buildingBoxPx.y2 - cropOffset.y,
      };
    } else if (buildingPointPx) {
      visionHint = {
        x: buildingPointPx.x - cropOffset.x,
        y: buildingPointPx.y - cropOffset.y,
      };
    }
    const segmentation = await segmentEavesViaVision(
      workImage,
      didCrop ? null : roofPolygon,
      visionHint,
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

      // Sanity check vision's trace against Solar API's reported roof
      // area. A real residential roof has perimeter ~5-8 × sqrt(area).
      // If vision returned >12× sqrt(area), it traced grass/driveway
      // along with the building. Bail out — better to show an error
      // than render a 400 LF trace for a 200 m² house.
      const solarAreaM2 = solarRoofSegments.reduce(
        (s, seg) => s + (seg.areaMeters2 ?? 0),
        0,
      );
      if (solarAreaM2 > 30) {
        const solarAreaSqft = solarAreaM2 * 10.7639;
        const sqrtArea = Math.sqrt(solarAreaSqft);
        const ratio = totalEaveLF / sqrtArea;
        notes.push(
          `Vision sanity: ${totalEaveLF.toFixed(0)} LF / √(${solarAreaSqft.toFixed(0)} sqft) = ${ratio.toFixed(1)} (expected 5–8, max 11)`,
        );
        if (ratio > 11) {
          notes.push(
            `Vision rejected: trace LF is ${ratio.toFixed(1)}× sqrt(roof area) — likely traced yard/driveway as part of building. Try moving downspouts manually after fixing the perimeter, or contact support.`,
          );
          // Bail out of vision path — caller falls through to no-result
          // / mock pipeline so the contractor doesn't see a wildly
          // wrong trace they have to delete and redraw entirely.
          // Returning empty would crash downstream; instead throw a
          // controlled error the caller can render.
          throw new Error(
            `Vision trace is ${ratio.toFixed(1)}× the expected perimeter for this roof area — refusing to ship a misleading takeoff. The AI couldn't lock onto the building outline at this address. Try the address with a small variant (e.g. add ', USA') to bypass the cache, or use the manual takeoff tools.`,
          );
        }
      }

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
        canvasPxPerFt: canvasPxPerFoot(
          geocoded.lat,
          image.zoom,
          image.width,
          image.height,
        ),
        traceQuality: (() => {
          const fp = solarFootprintCanvas(solarRoofSegments, geocoded, image);
          return assessSatelliteTrace({
            source: "ai",
            eaves,
            totalEaveLF,
            footprintAreaFt2: fp?.areaFt2 ?? null,
            footprintBboxCanvas: fp?.bbox ?? null,
            interiorTiersDetected,
            segmentCount: solarRoofSegments.length,
            // This is the weak vision fallback (SAM + Solar mask both
            // failed) — never let it read as a trustworthy "ok".
            fromVisionFallback: true,
            roofLevelsMulti: segmentation.roofLevels === "multi_level",
          });
        })(),
        roofStructure,
        suggestedEaves,
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
    // Mock/partial fallback ships SAMPLE cartoon geometry, never a real
    // trace — always steer the contractor to the drawing tool.
    traceQuality: {
      status: "unusable",
      confidence: 0,
      reasons: [
        image
          ? "We loaded the satellite image but couldn't trace the roof from it."
          : "Couldn't load a clear satellite image for this address.",
      ],
    },
    roofStructure,
  };
}
