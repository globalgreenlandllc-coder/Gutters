import "server-only";
import { PNG } from "pngjs";
import type { BuildingInsights, RoofSegment } from "./solar";
import { estimateStoriesFromInsights } from "./solar";
import {
  fetchSolarLayers,
  type SolarLayers,
} from "./solar-layers";
import {
  classifyEdgeByDsm,
  cleanFootprint,
  clipSegmentToRect,
  closeMask,
  cropFloat32,
  cropUint8,
  cropWindowAround,
  eaveHeightAboveGroundM,
  estimateGroundHeightM,
  expandWindowToAspect,
  interiorNormal,
  median,
  offsetPolygonOutward,
  outwardNormalAzimuthDeg,
  padToAspect,
  polygonArea,
  polygonCentroid,
  recoverAttachedRoofs,
  traceMaskFootprint,
  type DsmSampler,
  type Pt,
} from "./solar-geometry";
import {
  classifyPolygonCorners,
  countCorners,
  measurementsFromVision,
  mergeCollinearEaves,
  placeDownspoutsOnPolygon,
  pointInPolygon,
  transformToCanvas,
} from "./geometry";
import { countOpenEaveEnds } from "./roof-geom";
import { buildSegmentRidgesProjected } from "./segment-ridges";
import { detectTierBreakEaves } from "./tier-breaks";
import { assessSatelliteTrace, type TraceQuality } from "./trace-quality";
import { storiesFromHeightFt } from "@/lib/types";
import type {
  Downspout,
  EditableLine,
  Measurements,
  RoofStructure,
  Stories,
} from "@/lib/types";

/**
 * solar-engine.ts — the SOLAR-FIRST estimate path.
 *
 * Everything the old pipeline stitched together probabilistically (SAM-2
 * segmentation of a blurry Mapbox tile, GPT-4o vision, azimuth-only edge
 * guessing, bbox-union fallbacks) is replaced by one deterministic chain
 * on Google's own co-registered data:
 *
 *   building mask (0.1 m/px)  → footprint polygon (trace → DP → ortho)
 *   DSM (0.1 m/px)            → eave-vs-rake per edge, stories, (later) tiers
 *   RGB orthophoto            → the canvas background, SAME grid & capture
 *   buildingInsights segments → ridges, tier-break suggestions, azimuth
 *                               tie-breaks
 *
 * One coordinate system (local UTM, uniform meters/px), one imagery date,
 * no cross-provider reconciliation. When this path can't run (no Solar
 * coverage, LOW-quality satellite-only imagery, decode trouble) the
 * caller falls back to the legacy tile pipeline.
 */

export type SolarFirstResult = {
  measurements: Measurements;
  eaves: EditableLine[];
  rakes: EditableLine[];
  downspouts: Downspout[];
  aerial: {
    imageDataUrl: string;
    width: number;
    height: number;
    zoom: number;
  };
  canvasPxPerFt: number;
  traceQuality: TraceQuality;
  roofStructure: RoofStructure;
  suggestedEaves: EditableLine[];
};

const METERS_PER_FOOT = 0.3048;
const CANVAS_W = 900;
const CANVAS_H = 580;
/** Gutter line sits past the wall the mask traces (typical overhang). */
const OVERHANG_M = 0.55;
const WASTE_FACTOR = 1.08;
const MIN_EAVE_FT = 2;

export async function runSolarFirstEstimate(args: {
  lat: number;
  lng: number;
  insights: BuildingInsights | null;
  notes: string[];
  /** Injected layers for verification scripts / tests. */
  layersOverride?: SolarLayers;
}): Promise<SolarFirstResult | null> {
  const { insights, notes } = args;

  // Center the layer window on the building (insights bbox center), not
  // the geocode pin — Google geocoding often returns a parcel centroid
  // 50–100 ft off the structure. Radius from the bbox half-diagonal.
  let centerLat = args.lat;
  let centerLng = args.lng;
  let radius = 45;
  if (insights) {
    centerLat = (insights.boundingBoxNE.lat + insights.boundingBoxSW.lat) / 2;
    centerLng = (insights.boundingBoxNE.lng + insights.boundingBoxSW.lng) / 2;
    const mLat = 110_540;
    const mLng = 111_320 * Math.cos((centerLat * Math.PI) / 180);
    const spanY =
      Math.abs(insights.boundingBoxNE.lat - insights.boundingBoxSW.lat) * mLat;
    const spanX =
      Math.abs(insights.boundingBoxNE.lng - insights.boundingBoxSW.lng) * mLng;
    radius = Math.round(
      Math.min(90, Math.max(32, Math.hypot(spanX, spanY) / 2 + 12)),
    );
  }

  let layers: SolarLayers;
  if (args.layersOverride) {
    layers = args.layersOverride;
  } else {
    const outcome = await fetchSolarLayers(centerLat, centerLng, radius);
    if (!outcome.ok) {
      notes.push(`Solar HD layers unavailable — ${outcome.reason}`);
      return null;
    }
    layers = outcome.layers;
  }

  const mpp = layers.grid.metersPerPixel;
  notes.push(
    `Solar HD engine: ${layers.imageryQuality} quality aerial @ ${mpp.toFixed(2)} m/px` +
      (layers.imageryDate ? `, captured ${layers.imageryDate}` : "") +
      ` (${layers.grid.width}×${layers.grid.height} ${layers.grid.crsLabel})`,
  );

  if (layers.imageryQuality === "LOW") {
    // LOW = satellite-derived 0.5 m data; the legacy SAM path on a street
    // tile usually beats a blobby half-meter mask. Let it try.
    notes.push(
      "Solar imagery is LOW quality (0.5 m satellite) here — using the legacy tracer instead",
    );
    return null;
  }

  // ---- Footprint ---------------------------------------------------
  let traced = traceMaskFootprint(
    layers.mask,
    layers.grid.width,
    layers.grid.height,
  );
  if (!traced) {
    notes.push("Building mask had no traceable footprint — legacy tracer");
    return null;
  }

  // Recover attached roofs the mask missed. Google's mask maps the
  // HEATED footprint — porches, covered entries and carports routinely
  // sit outside it even though their roofs need gutters. The DSM knows
  // they're there (smooth elevated surfaces hugging the house) and the
  // orthophoto rules out tree canopy.
  let workMask = layers.mask;
  let expectedAreaPx = traced.areaPx;
  // Pushed only after the close step actually welds the porch onto the
  // footprint — a note about recovered roof that never landed would lie.
  let porchNote: string | null = null;
  let porchApplied = false;
  {
    const bxs = traced.boundary.map((p) => p.x);
    const bys = traced.boundary.map((p) => p.y);
    const ground = estimateGroundHeightM({
      mask: layers.mask,
      dsm: layers.dsm,
      dsmNoData: layers.dsmNoData,
      width: layers.grid.width,
      height: layers.grid.height,
      bbox: {
        minX: Math.min(...bxs),
        minY: Math.min(...bys),
        maxX: Math.max(...bxs),
        maxY: Math.max(...bys),
      },
      metersPerPixel: mpp,
    });
    if (ground != null) {
      const rec = recoverAttachedRoofs({
        mask: layers.mask,
        componentMask: traced.componentMask,
        dsm: layers.dsm,
        dsmNoData: layers.dsmNoData,
        rgb: layers.rgb,
        width: layers.grid.width,
        height: layers.grid.height,
        metersPerPixel: mpp,
        groundHeightM: ground,
      });
      if (rec.addedAreasM2.length > 0) {
        workMask = rec.mask;
        expectedAreaPx = traced.areaPx + rec.addedPx;
        porchNote = `Recovered ${rec.addedAreasM2.length} attached roof${
          rec.addedAreasM2.length === 1 ? "" : "s"
        } the building mask missed (porch/carport/covered entry): ${rec.addedAreasM2.join(" + ")} m² — verify the new outline covers real roof`;
      }
    }
  }

  // Close sub-meter wall notches AND weld recovered porch roofs onto the
  // main mass (they sit within ~0.7 m of it). Guard: if the closed
  // component's area jumps past the expected main+porch total, the close
  // bridged a NEIGHBOR (shed, fence-line garage) — fall back.
  {
    const CLOSE_RADIUS_M = 0.9;
    const closed = closeMask(
      workMask,
      layers.grid.width,
      layers.grid.height,
      CLOSE_RADIUS_M / mpp,
    );
    const closedTrace = traceMaskFootprint(
      closed,
      layers.grid.width,
      layers.grid.height,
    );
    if (closedTrace && closedTrace.areaPx <= expectedAreaPx * 1.12) {
      if (porchNote && closedTrace.areaPx > traced.areaPx * 1.02) {
        notes.push(porchNote);
        porchApplied = true;
      } else if (closedTrace.areaPx > traced.areaPx * 1.005) {
        notes.push(
          `Bridged sub-meter wall notches (roofs merge above them): footprint ${traced.areaPx} → ${closedTrace.areaPx} px²`,
        );
      }
      traced = closedTrace;
      workMask = closed;
    } else if (closedTrace) {
      notes.push(
        porchNote
          ? "Attached-roof recovery skipped — welding it in would have merged a neighboring structure"
          : "Notch-bridging skipped — it would have merged a neighboring structure",
      );
    }
  }

  const cleaned = cleanFootprint(traced.boundary, mpp);
  if (!cleaned || cleaned.points.length < 4) {
    notes.push("Footprint cleanup degenerated — legacy tracer");
    return null;
  }

  // Overhang: mask traces the WALL line; gutters hang past it.
  const ringFull = offsetPolygonOutward(cleaned.points, OVERHANG_M / mpp);

  notes.push(
    `Footprint from Google's building mask: ${traced.boundary.length} boundary px → ${cleaned.points.length} corners` +
      (cleaned.cleanup.kind === "ortho"
        ? " (right-angle snap ✓)"
        : ` (${cleaned.cleanup.reason})`) +
      `, gutter line offset +${OVERHANG_M} m` +
      (traced.touchesEdge
        ? " ⚠ building touches the imagery window edge"
        : ""),
  );

  // ---- Crop all layers around the footprint ------------------------
  const xs = ringFull.map((p) => p.x);
  const ys = ringFull.map((p) => p.y);
  const marginPx = Math.round(6 / mpp);
  // Expand the crop to the canvas aspect (900:580): the client COVER-fits
  // this image into its viewBox, so a matching aspect means contain ≡
  // cover — no traced geometry can land outside the canvas (which
  // clipped the proposal diagram) and the photo fills the frame edge to
  // edge instead of floating between letterbox bands.
  const win = expandWindowToAspect(
    cropWindowAround(
      {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      },
      marginPx,
      layers.grid.width,
      layers.grid.height,
    ),
    CANVAS_W / CANVAS_H,
    layers.grid.width,
    layers.grid.height,
  );
  // The WORKING mask (porches recovered + notches welded) — interior
  // DSM samples and ground sampling must see the same footprint the
  // trace came from. If the raster couldn't cover the full canvas
  // aspect (building near the window edge), pad with inert data so the
  // cover-fit invariant still holds.
  const padded = padToAspect({
    rgb: cropUint8(layers.rgb, layers.grid.width, win, 3),
    dsm: cropFloat32(layers.dsm, layers.grid.width, win),
    mask: cropUint8(workMask, layers.grid.width, win, 1),
    width: win.width,
    height: win.height,
    aspect: CANVAS_W / CANVAS_H,
    dsmNoData: layers.dsmNoData,
  });
  // Clamp to the padded raster: when the building touches the data-window
  // edge, the overhang offset can push the ring past where imagery exists
  // (negative coords → clipped in every client view). The trace there is
  // approximate anyway and the edge-touch flag already demotes trust.
  const ring: Pt[] = ringFull.map((p) => ({
    x: Math.max(0, Math.min(padded.width, p.x - win.x + padded.offX)),
    y: Math.max(0, Math.min(padded.height, p.y - win.y + padded.offY)),
  }));
  const rgb = padded.rgb;
  const dsm = padded.dsm;
  const maskCrop = padded.mask;
  const W = padded.width;
  const H = padded.height;

  const noData = layers.dsmNoData;
  const sample: DsmSampler = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return null;
    const v = dsm[yi * W + xi];
    if (!Number.isFinite(v)) return null;
    if (Math.abs(v - noData) < 0.001) return null;
    if (v < -450 || v > 9000) return null;
    return v;
  };

  // Full-grid px → lat/lng and back, adjusted for the crop + pad.
  const toLatLng = (p: Pt) =>
    layers.grid.toLatLng(
      p.x - padded.offX + win.x,
      p.y - padded.offY + win.y,
    );
  const fromLatLng = (lat: number, lng: number): Pt => {
    const g = layers.grid.fromLatLng(lat, lng);
    return { x: g.x - win.x + padded.offX, y: g.y - win.y + padded.offY };
  };

  // ---- Edge classification (DSM primary, azimuth tie-break) --------
  const centroid = polygonCentroid(ring);
  const segments = insights?.roofSegments ?? [];
  const segCentersPx = segments
    .map((s, i) => ({
      i,
      px: s.center ? fromLatLng(s.center.lat, s.center.lng) : null,
      azimuth: s.azimuthDegrees,
      pitch: s.pitchDegrees,
    }))
    .filter((s): s is typeof s & { px: Pt } => s.px !== null);

  const azimuthVerdict = (
    a: Pt,
    b: Pt,
    nrm: { nx: number; ny: number },
  ): { kind: "eave" | "rake" | "unknown"; reason: string } => {
    if (segCentersPx.length === 0) {
      return { kind: "unknown", reason: "no Solar segments" };
    }
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    let best: (typeof segCentersPx)[number] | null = null;
    let bestD = Infinity;
    for (const s of segCentersPx) {
      const d = Math.hypot(s.px.x - mx, s.px.y - my);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) return { kind: "unknown", reason: "no nearest segment" };
    if (best.pitch < 5) {
      return { kind: "eave", reason: "flat roof segment — gutters all around" };
    }
    const normalAz = outwardNormalAzimuthDeg(nrm);
    let diff = Math.abs(best.azimuth - normalAz);
    diff = Math.min(diff, 360 - diff);
    if (diff <= 50) {
      return {
        kind: "eave",
        reason: `normal ${Math.round(normalAz)}° ≈ segment azimuth ${Math.round(best.azimuth)}°`,
      };
    }
    return {
      kind: "rake",
      reason: `normal ${Math.round(normalAz)}° vs segment azimuth ${Math.round(best.azimuth)}° (Δ${Math.round(diff)}°)`,
    };
  };

  type ClassifiedEdge = {
    a: Pt;
    b: Pt;
    kind: "eave" | "rake";
    lengthFt: number;
    via: string;
  };
  const classified: ClassifiedEdge[] = [];
  let dsmDecided = 0;
  let azimuthDecided = 0;
  let defaultedToEave = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const lengthFt = (Math.hypot(b.x - a.x, b.y - a.y) * mpp) / METERS_PER_FOOT;
    if (lengthFt < MIN_EAVE_FT) continue;
    const nrm = interiorNormal(a, b, centroid);
    const dsmV = classifyEdgeByDsm(a, b, nrm, sample, mpp, {
      insideMask: (x, y) => {
        const xi = Math.round(x);
        const yi = Math.round(y);
        return (
          xi >= 0 && yi >= 0 && xi < W && yi < H && maskCrop[yi * W + xi] > 0
        );
      },
    });
    let kind: "eave" | "rake";
    let via: string;
    if (dsmV.kind !== "unknown") {
      kind = dsmV.kind;
      via = `DSM: ${dsmV.reason}`;
      dsmDecided++;
    } else {
      const azV = azimuthVerdict(a, b, nrm);
      if (azV.kind !== "unknown") {
        kind = azV.kind;
        via = `azimuth: ${azV.reason}`;
        azimuthDecided++;
      } else {
        // Inclusion bias: a wrongly-included rake is one click to delete;
        // a silently-dropped eave costs the contractor the sale.
        kind = "eave";
        via = `defaulted to eave (${dsmV.reason})`;
        defaultedToEave++;
      }
    }
    classified.push({ a, b, kind, lengthFt, via });
  }

  const eaveEdges = classified.filter((e) => e.kind === "eave");
  const rakeEdges = classified.filter((e) => e.kind === "rake");
  if (eaveEdges.length < 3) {
    notes.push(
      `Solar HD classification kept only ${eaveEdges.length} eave edge(s) — legacy tracer`,
    );
    return null;
  }
  notes.push(
    `Edge classification (DSM heights): ${eaveEdges.length} eaves, ${rakeEdges.length} rakes` +
      ` — ${dsmDecided} by height profile, ${azimuthDecided} by plane azimuth` +
      (defaultedToEave > 0 ? `, ${defaultedToEave} defaulted to eave` : ""),
  );

  // ---- Canvas-space geometry ---------------------------------------
  let eaves: EditableLine[] = eaveEdges.map((e, i) => ({
    id: `solar-eave-${i}`,
    kind: "eave" as const,
    points: transformToCanvas([e.a, e.b], W, H),
  }));
  const rakes: EditableLine[] = rakeEdges.map((e, i) => ({
    id: `solar-rake-${i}`,
    kind: "rake" as const,
    points: transformToCanvas([e.a, e.b], W, H),
  }));

  const beforeMerge = eaves.length;
  eaves = mergeCollinearEaves(eaves);
  if (eaves.length < beforeMerge) {
    notes.push(
      `Merged collinear eaves: ${beforeMerge} → ${eaves.length} continuous runs`,
    );
  }

  const totalEaveLF =
    eaveEdges.reduce((s, e) => s + e.lengthFt, 0) * WASTE_FACTOR;

  const coverScale = Math.max(CANVAS_W / W, CANVAS_H / H);
  const canvasPxPerFt = (coverScale * METERS_PER_FOOT) / mpp;

  // ---- Stories from the DSM ----------------------------------------
  let stories: Stories;
  const eaveAboveGroundM = eaveHeightAboveGroundM({
    ring,
    mask: maskCrop,
    width: W,
    height: H,
    sample,
    metersPerPixel: mpp,
  });
  if (eaveAboveGroundM != null) {
    const ft = eaveAboveGroundM / METERS_PER_FOOT;
    stories = storiesFromHeightFt(ft);
    notes.push(
      `Stories from DSM: gutter line ≈ ${ft.toFixed(1)} ft above grade → ${stories}-story`,
    );
  } else {
    stories = estimateStoriesFromInsights(insights);
    notes.push(
      `Stories: DSM ground sample too thin — falling back to footprint heuristic (${stories}-story)`,
    );
  }

  // ---- Roof structure overlay (deterministic ridges) ----------------
  const ridgeLines = buildSegmentRidgesProjected(
    segments,
    (lat, lng) => fromLatLng(lat, lng),
    {
      // Meter-based merge tolerances on THIS grid — the px defaults were
      // tuned for the legacy Mercator tile and would weld separate roof
      // masses into one long ridge at 0.1 m/px.
      mergePerpPx: 0.8 / mpp,
      mergeGapPx: 1.2 / mpp,
      minLenPx: 1.0 / mpp,
      pairMaxDistPx: 8 / mpp,
    },
  )
    .filter((r) => {
      const mid = { x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2 };
      return pointInPolygon(mid, ring);
    })
    .map((r) => clipSegmentToRect(r.a, r.b, W, H))
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r, i) => ({
      id: `solar-ridge-${i}`,
      kind: "ridge" as const,
      points: transformToCanvas([r.a, r.b], W, H),
      label: "RIDGE",
    }));
  const canvasRing = transformToCanvas(ring, W, H);
  const roofStructure: RoofStructure = {
    perimeter: canvasRing,
    ridges: ridgeLines,
    valleys: [],
    confidence: 0.92,
  };
  if (ridgeLines.length > 0) {
    notes.push(
      `Roof structure: ${ridgeLines.length} ridge(s) from Solar plane geometry`,
    );
  }

  // ---- Downspouts ----------------------------------------------------
  const roofPolygon = {
    points: ring,
    bbox: (() => {
      const bxs = ring.map((p) => p.x);
      const bys = ring.map((p) => p.y);
      const minX = Math.min(...bxs);
      const minY = Math.min(...bys);
      return {
        x: Math.round(minX),
        y: Math.round(minY),
        width: Math.round(Math.max(...bxs) - minX),
        height: Math.round(Math.max(...bys) - minY),
      };
    })(),
    areaFraction: polygonArea(ring) / (W * H),
  };
  const downspouts = placeDownspoutsOnPolygon(
    roofPolygon,
    eaves,
    W,
    H,
    stories,
    canvasPxPerFt,
    [],
  );

  // ---- Interior-tier suggestions (unpriced) --------------------------
  let suggestedEaves: EditableLine[] = [];
  let interiorTiersDetected = 0;
  if (segments.length > 0) {
    const perimeterEavesLatLng = eaveEdges.map((e) => ({
      a: toLatLng(e.a),
      b: toLatLng(e.b),
    }));
    const { candidates } = detectTierBreakEaves(segments, perimeterEavesLatLng);
    interiorTiersDetected = candidates.length;
    suggestedEaves = candidates
      .map((c) =>
        clipSegmentToRect(
          fromLatLng(c.edge.a.lat, c.edge.a.lng),
          fromLatLng(c.edge.b.lat, c.edge.b.lng),
          W,
          H,
        ),
      )
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .map((s, i) => ({
        id: `suggested-tier-${i}`,
        kind: "eave" as const,
        points: transformToCanvas([s.a, s.b], W, H),
      }));
    if (candidates.length > 0) {
      const meanStepFt =
        (candidates.reduce((s, c) => s + c.stepMeters, 0) / candidates.length) /
        METERS_PER_FOOT;
      notes.push(
        `Tier-break: ${candidates.length} upper tier(s) ≈ ${meanStepFt.toFixed(1)} ft above baseline — shown as tap-to-add interior gutters`,
      );
    }
  }

  // ---- Measurements ---------------------------------------------------
  const cornerSplit = classifyPolygonCorners(roofPolygon, W, H);
  const openEnds = countOpenEaveEnds(eaves);
  const measurements = measurementsFromVision({
    eaveLF: totalEaveLF,
    downspoutCount: downspouts.length,
    cornerCount: countCorners(eaves),
    stories,
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
    `Eaves (solar-HD): ${eaves.length} runs = ${Math.round(totalEaveLF)} LF (incl. ${Math.round(
      (WASTE_FACTOR - 1) * 100,
    )}% waste), ${downspouts.length} downspouts, ${rakeEdges.length} rakes (no gutter)`,
  );

  // ---- Trace quality ---------------------------------------------------
  const footprintAreaFt2 =
    polygonArea(ring) * Math.pow(mpp / METERS_PER_FOOT, 2);
  const cxs = canvasRing.map((p) => p.x);
  const cys = canvasRing.map((p) => p.y);
  let traceQuality = assessSatelliteTrace({
    source: "ai",
    eaves,
    totalEaveLF,
    footprintAreaFt2,
    footprintBboxCanvas: {
      minX: Math.min(...cxs) - 40,
      minY: Math.min(...cys) - 30,
      maxX: Math.max(...cxs) + 40,
      maxY: Math.max(...cys) + 30,
    },
    interiorTiersDetected,
    segmentCount: segments.length,
  });
  if (traced.touchesEdge && traceQuality.status === "ok") {
    traceQuality = {
      status: "low",
      confidence: Math.min(traceQuality.confidence, 0.7),
      reasons: [
        "The building reaches the edge of the imagery window — verify no wing was cut off.",
      ],
    };
  }
  // Recovered porch/carport roof is the least-certain part of the trace
  // (inferred from heights + photo, not Google's mask) — never let a run
  // that used it read as fully trusted.
  if (porchApplied && traceQuality.status === "ok") {
    traceQuality = {
      status: "low",
      confidence: Math.min(traceQuality.confidence, 0.75),
      reasons: [
        "A porch/carport roof missing from the building data was added from height analysis — verify that part of the outline before pricing.",
      ],
    };
  }

  // ---- RGB → PNG data URL ----------------------------------------------
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) {
    png.data[i * 4] = rgb[i * 3];
    png.data[i * 4 + 1] = rgb[i * 3 + 1];
    png.data[i * 4 + 2] = rgb[i * 3 + 2];
    png.data[i * 4 + 3] = 255;
  }
  const pngBuf = PNG.sync.write(png);

  return {
    measurements,
    eaves,
    rakes,
    downspouts,
    aerial: {
      imageDataUrl: `data:image/png;base64,${pngBuf.toString("base64")}`,
      width: W,
      height: H,
      // Dead-weight passthrough for the client type; the canvas never
      // reads it (all scale flows through canvasPxPerFt).
      zoom: 20,
    },
    canvasPxPerFt,
    traceQuality,
    roofStructure,
    suggestedEaves,
  };
}

/** Exported for the verification script: median of DSM heights inside
 *  the mask (rough roof-height sanity readout). */
export function roofHeightStats(layers: SolarLayers): {
  medianM: number | null;
} {
  const vals: number[] = [];
  const step = Math.max(1, Math.floor(layers.grid.width / 200));
  for (let y = 0; y < layers.grid.height; y += step) {
    for (let x = 0; x < layers.grid.width; x += step) {
      const i = y * layers.grid.width + x;
      if (layers.mask[i] > 0) {
        const v = layers.dsm[i];
        if (Number.isFinite(v) && Math.abs(v - layers.dsmNoData) > 0.001) {
          vals.push(v);
        }
      }
    }
  }
  return { medianM: vals.length > 0 ? median(vals) : null };
}
