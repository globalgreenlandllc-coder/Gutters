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
  distToPolyline,
  distToRing,
  eaveHeightAboveGroundM,
  estimateGroundHeightM,
  estimateRenderShift,
  expandWindowToAspect,
  findTierEdges,
  growRoofMask,
  interiorNormal,
  inwardNormalForRing,
  median,
  offsetPolygonOutward,
  outwardNormalAzimuthDeg,
  padToAspect,
  polygonArea,
  polygonCentroid,
  recoverAttachedRoofs,
  refineEdgesToPhoto,
  tierRegionRings,
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
  /** The DETAILED drip-edge polyline (canvas coords, ~2 px spacing) —
   *  the client's drawing tool snaps to it and can trace along it, so
   *  manual fixes follow every real jog without vertex-by-vertex work. */
  magnetPath: { x: number; y: number }[];
  /** Prefix of magnetPath forming the closed OUTER ring — two-click
   *  arc-following is only valid within it. */
  magnetRingCount: number;
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
  let dripEdgeGrown = false;
  let groundM: number | null = null;
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
      groundM = ground;
      // Grow the footprint along the DSM to the TRUE drip edge. The
      // mask's ML boundary smooths stepped corners into diagonals and
      // hugs the walls; the height data carries the real jogs and 90°
      // corners, and its boundary IS the gutter line (so the blanket
      // overhang offset shrinks to a safety margin below).
      const grown = growRoofMask({
        mask: layers.mask,
        dsm: layers.dsm,
        dsmNoData: layers.dsmNoData,
        rgb: layers.rgb,
        width: layers.grid.width,
        height: layers.grid.height,
        metersPerPixel: mpp,
        groundHeightM: ground,
      });
      let growMask = layers.mask;
      if (grown.grownPx > 0) {
        const regrow = traceMaskFootprint(
          grown.mask,
          layers.grid.width,
          layers.grid.height,
        );
        if (regrow && regrow.areaPx <= traced.areaPx * 1.45) {
          growMask = grown.mask;
          workMask = grown.mask;
          traced = regrow;
          expectedAreaPx = regrow.areaPx;
          dripEdgeGrown = true;
          notes.push(
            `Drip-edge trace: footprint grown +${Math.round(grown.grownPx * mpp * mpp)} m² along the height data to the real roof edge (recovers jogs and square corners the building mask smoothed away)`,
          );
        }
      }
      const rec = recoverAttachedRoofs({
        mask: growMask,
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
        expectedAreaPx = expectedAreaPx + rec.addedPx;
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

  // Overhang: the raw mask traces the WALL line, so gutters hang past
  // it; after drip-edge growth the boundary already IS the gutter line
  // and only a small safety margin remains.
  const overhangM = dripEdgeGrown ? 0.15 : OVERHANG_M;
  const ringFull = offsetPolygonOutward(cleaned.points, overhangM / mpp);

  notes.push(
    `Footprint from Google's building mask: ${traced.boundary.length} boundary px → ${cleaned.points.length} corners` +
      (cleaned.cleanup.kind === "ortho"
        ? " (right-angle snap ✓)"
        : ` (${cleaned.cleanup.reason})`) +
      (cleaned.squaredCorners > 0
        ? `, squared ${cleaned.squaredCorners} chamfered corner${cleaned.squaredCorners === 1 ? "" : "s"} to 90°`
        : "") +
      `, gutter line offset +${overhangM} m` +
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

  // PHOTO-LEAN REGISTRATION. The mask/DSM are true-position; the RGB
  // orthophoto renders roofs displaced by height × off-nadir (~1 m).
  // Estimate that shift from the photo's edges and apply it to every
  // DRAWN point — the contractor sees the outline ON the roof — while
  // all measurement math stays at true position (lengths are shift-
  // invariant anyway).
  const renderShift = estimateRenderShift({
    rgb,
    width: W,
    height: H,
    ring,
    metersPerPixel: mpp,
    // Anchors the search to THIS roof's appearance — without it a bright
    // sidewalk/driveway border out-gradients the real roofline and drags
    // the outline onto pavement.
    mask: maskCrop,
  });
  const S = (p: Pt): Pt => ({
    x: Math.max(0, Math.min(W, p.x + renderShift.dx)),
    y: Math.max(0, Math.min(H, p.y + renderShift.dy)),
  });
  if (renderShift.dx !== 0 || renderShift.dy !== 0) {
    const shiftM = Math.hypot(renderShift.dx, renderShift.dy) * mpp;
    notes.push(
      `Aligned the outline to the photo: roofs lean ~${shiftM.toFixed(1)} m in this orthophoto (true-position data vs ground-rectified image) — drawn geometry shifted to match, measurements unchanged`,
    );
  }

  // PER-EDGE SNAP: after the global shift, each wall slides individually
  // onto the photo's roof edge and every corner is rebuilt as the
  // intersection of its two refined walls — squares corners and removes
  // the per-edge residual a single global shift can't fix.
  const refineOut = refineEdgesToPhoto({
    ring: ring.map(S),
    rgb,
    mask: maskCrop,
    width: W,
    height: H,
    metersPerPixel: mpp,
  });
  const renderRing: Pt[] = refineOut.ring.map((p) => ({
    x: Math.max(0, Math.min(W, p.x)),
    y: Math.max(0, Math.min(H, p.y)),
  }));
  if (refineOut.refined > 0) {
    notes.push(
      `Snapped ${refineOut.refined} wall${refineOut.refined === 1 ? "" : "s"} onto the photo's roof edges and re-squared their corners`,
    );
  }

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
    /** Index into `ring` (and renderRing) of this edge's first vertex. */
    idx: number;
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
    // Probe-based inward normal — the centroid heuristic points the wrong
    // way along the courtyard edges of concave (U/L) footprints.
    const nrm = inwardNormalForRing(a, b, ring, 0.4 / mpp);
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
    classified.push({ a, b, idx: i, kind, lengthFt, via });
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
  const renderEdge = (e: { idx: number; a: Pt; b: Pt }): [Pt, Pt] => [
    renderRing[e.idx] ?? S(e.a),
    renderRing[(e.idx + 1) % ring.length] ?? S(e.b),
  ];
  let eaves: EditableLine[] = eaveEdges.map((e, i) => ({
    id: `solar-eave-${i}`,
    kind: "eave" as const,
    points: transformToCanvas(renderEdge(e), W, H),
  }));
  let rakes: EditableLine[] = rakeEdges.map((e, i) => ({
    id: `solar-rake-${i}`,
    kind: "rake" as const,
    points: transformToCanvas(renderEdge(e), W, H),
  }));

  // ---- INTERIOR TIER EAVES, auto-drawn as PRICED runs ----------------
  // Decompose the roof into height tiers and trace each upper mass's own
  // drip line — the loops a contractor draws around every roof-above-a-
  // roof section. Edges that duplicate the outer perimeter are skipped;
  // the rest are kept only when their inside sits ≥0.8 m above their
  // outside (the upper roof's edge, not the lower roof's wall line), and
  // each is eave/rake-classified with the same DSM drainage voting as
  // the perimeter.
  let tierEaveFt = 0;
  let tierEaveCount = 0;
  const tierRingsForMagnet: Pt[][] = [];
  const rejectedTierSuggestions: { a: Pt; b: Pt }[] = [];
  {
    const regions = tierRegionRings({
      mask: maskCrop,
      dsm,
      dsmNoData: noData,
      width: W,
      height: H,
      metersPerPixel: mpp,
    });
    const nearOuterPx = 0.9 / mpp;
    const insetPx = 0.7 / mpp;
    const insideMask = (x: number, y: number) => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      return xi >= 0 && yi >= 0 && xi < W && yi < H && maskCrop[yi * W + xi] > 0;
    };
    type TierChain = { points: Pt[]; ft: number };
    const tierChains: TierChain[] = [];
    const tierRakes: { a: Pt; b: Pt }[] = [];
    // Geometry the quality gates REJECT still surfaces as unpriced amber
    // suggestions — the adversarial review proved findTierEdges can't be
    // the safety net (its PCA line fit rejects corner-wrapping cliffs),
    // so every rejection path records its own segments here.
    const rejectedTierSegs = rejectedTierSuggestions;
    for (let r = 0; r < regions.length; r++) {
      const reg = regions[r].ring;
      // A NEIGHBOR's building sliver inside the crop window forms its own
      // region — only tiers whose center lies inside OUR footprint count.
      if (!pointInPolygon(polygonCentroid(reg), ring)) continue;
      // Degenerate-region gate: a needle-thin sliver (barrier artifacts
      // between roof planes) produces spike rings that draw as random
      // lines. Compactness 4πA/P² of a square ≈ 0.79; a 10:1 sliver
      // ≈ 0.13; the phantom needles score < 0.05.
      {
        let per = 0;
        for (let i = 0; i < reg.length; i++) {
          const a = reg[i];
          const b = reg[(i + 1) % reg.length];
          per += Math.hypot(b.x - a.x, b.y - a.y);
        }
        const compactness = (4 * Math.PI * polygonArea(reg)) / Math.max(1, per * per);
        if (compactness < 0.07 || regions[r].areaM2 < 12) continue;
      }
      tierRingsForMagnet.push(reg);
      // Judge every ring edge, then emit CONTIGUOUS CHAINS of kept edges
      // as single polyline runs — the loops a contractor draws — instead
      // of scattered per-edge stubs. A single skipped mini-edge (<4 ft,
      // e.g. a corner nub or unknown-verdict sliver) is bridged so it
      // can't break the chain.
      type EdgeJudged = { a: Pt; b: Pt; lengthFt: number; keep: "eave" | "rake" | "skip"; bridgeable: boolean };
      const judged: EdgeJudged[] = [];
      for (let i = 0; i < reg.length; i++) {
        const a = reg[i];
        const b = reg[(i + 1) % reg.length];
        const lengthFt = (Math.hypot(b.x - a.x, b.y - a.y) * mpp) / METERS_PER_FOOT;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const nearOuter = distToRing(mid, ring) < nearOuterPx;
        // pointInPolygon-probed normal: the centroid heuristic points the
        // WRONG WAY on concave (U/L) upper masses and inverted this test.
        const nrm = inwardNormalForRing(a, b, reg, 0.4 / mpp);
        const hIn = sample(mid.x + nrm.nx * insetPx, mid.y + nrm.ny * insetPx);
        const hOut = sample(mid.x - nrm.nx * insetPx, mid.y - nrm.ny * insetPx);
        const upper = hIn != null && hOut != null && hIn - hOut >= 0.8;
        if (nearOuter || !upper) {
          judged.push({ a, b, lengthFt, keep: "skip", bridgeable: false });
          continue;
        }
        // LEVELNESS: a real gutter line is horizontal. A tier-ring edge
        // that runs along a hip/valley or up a slope changes height along
        // its run — those drew as the "random diagonal lines".
        {
          const hsAlong: number[] = [];
          for (const t of [0.2, 0.4, 0.6, 0.8]) {
            const v = sample(
              a.x + (b.x - a.x) * t + nrm.nx * insetPx,
              a.y + (b.y - a.y) * t + nrm.ny * insetPx,
            );
            if (v != null) hsAlong.push(v);
          }
          if (hsAlong.length < 3) {
            judged.push({ a, b, lengthFt, keep: "skip", bridgeable: true });
            continue;
          }
          const range = Math.max(...hsAlong) - Math.min(...hsAlong);
          if (range > 0.9) {
            if (lengthFt >= 4) rejectedTierSegs.push({ a, b });
            judged.push({ a, b, lengthFt, keep: "skip", bridgeable: false });
            continue;
          }
        }
        if (lengthFt < 1.5) {
          judged.push({ a, b, lengthFt, keep: "skip", bridgeable: true });
          continue;
        }
        const verdict = classifyEdgeByDsm(a, b, nrm, sample, mpp, { insideMask });
        if (verdict.kind === "rake" && lengthFt >= 6) {
          judged.push({ a, b, lengthFt, keep: "rake", bridgeable: false });
        } else if (verdict.kind === "unknown" && lengthFt < 4) {
          judged.push({ a, b, lengthFt, keep: "skip", bridgeable: true });
        } else {
          judged.push({ a, b, lengthFt, keep: "eave", bridgeable: false });
        }
      }
      // Bridge single skipped-but-bridgeable edges BETWEEN two eave edges.
      const n = judged.length;
      for (let i = 0; i < n; i++) {
        if (judged[i].keep === "skip" && judged[i].bridgeable) {
          const prev = judged[(i - 1 + n) % n];
          const next = judged[(i + 1) % n];
          if (prev.keep === "eave" && next.keep === "eave") judged[i].keep = "eave";
        }
      }
      // Emit chains (ring-aware: rotate so index 0 isn't mid-chain).
      let startAt = 0;
      while (startAt < n && judged[startAt].keep === "eave") startAt++;
      if (startAt === n) startAt = 0; // whole ring is one loop
      let chain: Pt[] = [];
      let chainFt = 0;
      const flush = () => {
        // HAIRPIN: a vertex where the chain doubles back (turn > 150°) is
        // a ring-needle artifact — SPLIT the chain there and keep both
        // trustworthy flanks (dropping the whole run silently deleted a
        // real 40 ft drip line minus a 1 m spike). MIN LENGTH per piece:
        // a 2–5 ft orphan reads as a random tick, not a gutter run.
        if (chain.length >= 2) {
          const pieces: Pt[][] = [];
          let cur: Pt[] = [chain[0]];
          for (let i = 1; i < chain.length; i++) {
            if (i + 1 < chain.length) {
              const v1x = chain[i].x - chain[i - 1].x;
              const v1y = chain[i].y - chain[i - 1].y;
              const v2x = chain[i + 1].x - chain[i].x;
              const v2y = chain[i + 1].y - chain[i].y;
              const l1 = Math.hypot(v1x, v1y);
              const l2 = Math.hypot(v2x, v2y);
              const cos =
                l1 > 1e-6 && l2 > 1e-6
                  ? (v1x * v2x + v1y * v2y) / (l1 * l2)
                  : 1;
              if (cos < -0.87) {
                cur.push(chain[i]);
                pieces.push(cur);
                cur = [chain[i + 1]]; // skip PAST the spike vertex
                i++;
                continue;
              }
            }
            cur.push(chain[i]);
          }
          pieces.push(cur);
          for (const piece of pieces) {
            if (piece.length < 2) continue;
            let ft = 0;
            for (let i = 1; i < piece.length; i++) {
              ft +=
                (Math.hypot(
                  piece[i].x - piece[i - 1].x,
                  piece[i].y - piece[i - 1].y,
                ) *
                  mpp) /
                METERS_PER_FOOT;
            }
            if (ft >= 6) {
              tierChains.push({ points: piece, ft });
            } else if (ft >= 4) {
              for (let i = 1; i < piece.length; i++) {
                rejectedTierSegs.push({ a: piece[i - 1], b: piece[i] });
              }
            }
          }
        }
        chain = [];
        chainFt = 0;
      };
      for (let k = 0; k < n; k++) {
        const e = judged[(startAt + k) % n];
        if (e.keep === "eave") {
          if (chain.length === 0) chain.push(e.a);
          chain.push(e.b);
          chainFt += e.lengthFt;
        } else {
          if (e.keep === "rake") {
            tierRakes.push({ a: e.a, b: e.b });
          }
          flush();
        }
      }
      flush();
    }
    // DEDUP: the same physical step line can yield near-coincident runs
    // from two adjacent regions — keep the longest, drop a chain whose
    // points mostly sit within ~0.8 m of an already-kept one.
    tierChains.sort((x, y) => y.ft - x.ft);
    const dupTolPx = 0.8 / mpp;
    // Open-polyline distance — distToRing would add a phantom closing
    // edge across the chain and over-trigger the dedup.
    const distToChain = (p: Pt, pts: Pt[]): number => {
      let best = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t =
          len2 > 0
            ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
            : 0;
        const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
        if (d < best) best = d;
      }
      return best;
    };
    // Densify to ~1 m stations so the 70% overlap test measures FOOTAGE,
    // not vertex counts (a straight chain has only 2 vertices).
    const densify = (pts: Pt[]): Pt[] => {
      const out: Pt[] = [];
      const stepPx = 1 / mpp;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const n = Math.max(1, Math.round(len / stepPx));
        for (let k = 0; k < n; k++) {
          out.push({
            x: a.x + ((b.x - a.x) * k) / n,
            y: a.y + ((b.y - a.y) * k) / n,
          });
        }
      }
      out.push(pts[pts.length - 1]);
      return out;
    };
    const kept: TierChain[] = [];
    for (const c of tierChains) {
      let dup = false;
      const stations = densify(c.points);
      for (const k of kept) {
        let near = 0;
        for (const p of stations) {
          if (distToChain(p, k.points) < dupTolPx) near++;
        }
        if (near / stations.length >= 0.7) {
          dup = true;
          break;
        }
      }
      if (!dup) kept.push(c);
    }
    for (const c of kept) {
      eaves = [
        ...eaves,
        {
          id: `tier-eave-${tierEaveCount}`,
          kind: "eave" as const,
          points: transformToCanvas(c.points.map(S), W, H),
        },
      ];
      tierEaveFt += c.ft;
      tierEaveCount++;
    }
    for (let k = 0; k < tierRakes.length; k++) {
      rakes = [
        ...rakes,
        {
          id: `tier-rake-${k}`,
          kind: "rake" as const,
          points: transformToCanvas([S(tierRakes[k].a), S(tierRakes[k].b)], W, H),
        },
      ];
    }
    if (tierEaveCount > 0) {
      notes.push(
        `Interior upper-roof gutters auto-drawn: ${tierEaveCount} run${tierEaveCount === 1 ? "" : "s"} = ${Math.round(
          tierEaveFt * WASTE_FACTOR,
        )} LF traced around the height tiers (roof above a roof) — delete any run the customer doesn't want guttered`,
      );
    }
  }

  const totalEaveLF =
    (eaveEdges.reduce((s, e) => s + e.lengthFt, 0) + tierEaveFt) * WASTE_FACTOR;

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
    .map((r) => clipSegmentToRect(S(r.a), S(r.b), W, H))
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r, i) => ({
      id: `solar-ridge-${i}`,
      kind: "ridge" as const,
      points: transformToCanvas([r.a, r.b], W, H),
      label: "RIDGE",
    }));
  const canvasRing = transformToCanvas(renderRing, W, H);
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
  const ringRender = renderRing;
  const roofPolygon = {
    points: ringRender,
    bbox: (() => {
      const bxs = ringRender.map((p) => p.x);
      const bys = ringRender.map((p) => p.y);
      const minX = Math.min(...bxs);
      const minY = Math.min(...bys);
      return {
        x: Math.round(minX),
        y: Math.round(minY),
        width: Math.round(Math.max(...bxs) - minX),
        height: Math.round(Math.max(...bys) - minY),
      };
    })(),
    areaFraction: polygonArea(ringRender) / (W * H),
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
  // TRUE interior tier edges from the DSM: where an upper roof drops ≥1 m
  // onto a lower roof, the height cliff lands exactly on the upper eave
  // line — far more accurate than the Solar-segment bbox chords below.
  // Tier edges the quality gates DIDN'T auto-draw still surface as
  // amber tap-to-add suggestions (precision governs pricing; recall
  // survives as hints). Ones already covered by a drawn chain are
  // filtered below.
  const dsmTiers = findTierEdges({
    mask: maskCrop,
    dsm,
    dsmNoData: noData,
    width: W,
    height: H,
    metersPerPixel: mpp,
  });
  const drawnTierLines = eaves.filter((e) => e.id.startsWith("tier-eave-"));
  // Coverage = point-to-SEGMENT distance against drawn runs (vertex-only
  // testing let a suggestion sit ON TOP of a priced straight run — one
  // tap double-billed the same footage) — checked at the midpoint AND
  // both endpoints so a partially-covered edge still surfaces.
  const coveredByDrawn = (aPx: Pt, bPx: Pt): boolean => {
    if (drawnTierLines.length === 0) return false;
    const [ca, cb, cm] = transformToCanvas(
      [S(aPx), S(bPx), S({ x: (aPx.x + bPx.x) / 2, y: (aPx.y + bPx.y) / 2 })],
      W,
      H,
    );
    const near = (p: Pt) =>
      drawnTierLines.some((l) => distToPolyline(p, l.points) < 15);
    return near(cm) && near(ca) && near(cb);
  };
  // Pool: undiscovered height cliffs (findTierEdges) + the tier block's
  // OWN gate-rejected segments (findTierEdges structurally misses
  // corner-wrapping cliffs, so it can't be the only safety net).
  const suggestionPool: { a: Pt; b: Pt }[] = [
    ...dsmTiers,
    ...rejectedTierSuggestions,
  ].filter((t) => !coveredByDrawn(t.a, t.b));
  // De-dup the pool against itself (rejected segments often coincide
  // with a findTierEdges chord over the same cliff).
  const poolKept: { a: Pt; b: Pt; canvas: Pt[] }[] = [];
  for (const t of suggestionPool) {
    const clipped = clipSegmentToRect(S(t.a), S(t.b), W, H);
    if (!clipped) continue;
    const canvasPts = transformToCanvas([clipped.a, clipped.b], W, H);
    const mid = {
      x: (canvasPts[0].x + canvasPts[1].x) / 2,
      y: (canvasPts[0].y + canvasPts[1].y) / 2,
    };
    if (poolKept.some((k) => distToPolyline(mid, k.canvas) < 15)) continue;
    poolKept.push({ a: t.a, b: t.b, canvas: canvasPts });
  }
  if (poolKept.length > 0) {
    interiorTiersDetected = poolKept.length;
    suggestedEaves = poolKept.map((t, i) => ({
      id: `suggested-tier-${i}`,
      kind: "eave" as const,
      points: t.canvas,
    }));
    notes.push(
      `Upper-roof eaves: ${poolKept.length} more interior drop edge${poolKept.length === 1 ? "" : "s"} found in the height data — shown as tap-to-add interior gutters`,
    );
  } else if (tierEaveCount === 0 && segments.length > 0) {
    const perimeterEavesLatLng = eaveEdges.map((e) => ({
      a: toLatLng(e.a),
      b: toLatLng(e.b),
    }));
    const { candidates } = detectTierBreakEaves(segments, perimeterEavesLatLng);
    interiorTiersDetected = candidates.length;
    suggestedEaves = candidates
      .map((c) =>
        clipSegmentToRect(
          S(fromLatLng(c.edge.a.lat, c.edge.a.lng)),
          S(fromLatLng(c.edge.b.lat, c.edge.b.lng)),
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
  if (tierEaveCount > 0 && traceQuality.status === "ok") {
    traceQuality = {
      status: "low",
      confidence: Math.min(traceQuality.confidence, 0.75),
      reasons: [
        "Interior upper-roof gutters were auto-drawn from the height tiers — verify them before pricing.",
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

  // ---- Magnet path (detailed drip edge for the drawing tool) ------------
  const magnetStepPx = Math.max(1, Math.round(0.25 / mpp));
  const magnetPath: Pt[] = [];
  for (let i = 0; i < traced.boundary.length; i += magnetStepPx) {
    const p = traced.boundary[i];
    const local = S({
      x: p.x - win.x + padded.offX,
      y: p.y - win.y + padded.offY,
    });
    magnetPath.push(local);
  }
  // Two-click arc-following is only valid on the closed OUTER ring.
  const magnetRingCount = magnetPath.length;
  // Interior tier rings: snap targets for adjusting the auto-drawn
  // upper-roof gutters (already in cropped px space; densify each edge).
  for (const reg of tierRingsForMagnet) {
    for (let i = 0; i < reg.length; i++) {
      const a = reg[i];
      const b = reg[(i + 1) % reg.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.floor(len / magnetStepPx));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        magnetPath.push(
          S({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
        );
      }
    }
  }
  const magnetCanvas = transformToCanvas(magnetPath, W, H);

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
    magnetPath: magnetCanvas,
    magnetRingCount,
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
