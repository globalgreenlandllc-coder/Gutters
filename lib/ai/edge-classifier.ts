import "server-only";
import { sampleDsmAtLatLng, type DsmOutcome } from "./solar-dsm";

export type EdgeKind = "eave" | "rake" | "unknown";

export type ClassifiedEdge = {
  /** Lat/lng endpoints of this perimeter edge. */
  a: { lat: number; lng: number };
  b: { lat: number; lng: number };
  kind: EdgeKind;
  /** Reasoning for diagnostic display: which heights were sampled. */
  reason: string;
};

/**
 * Classify a single roof-perimeter edge as either an EAVE (gutters go
 * here — flat at the bottom of a roof slope) or a RAKE/RIDGE (no gutter
 * — angled gable side or a peak between two slopes).
 *
 * Sampling notes (this took two iterations to get right):
 *
 *   The polygon vertices sit ON the wall line. Sampling the DSM
 *   *exactly* at a vertex hits the boundary between roof shingles and
 *   the ground around the house — DSM pixels are 0.5m wide so the
 *   sample often lands on grass/driveway 5–15m below the roof. That
 *   10m+ delta makes every edge look "sloped" and the classifier drops
 *   100% of edges as rakes.
 *
 *   Fix: INSET every sample point 0.5m perpendicular-inward toward the
 *   polygon centroid before sampling. This guarantees we read actual
 *   roof shingle elevation, not the ground beside it.
 *
 * Algorithm:
 *
 *   1. Inset both endpoints 0.5m perpendicular-inward; sample heights
 *      Δh between them. > 0.5m → RAKE (sloped edge).
 *
 *   2. For flat edges, sample 1.5m perpendicular-inward from midpoint.
 *      Interior > edge by 0.5m → water drains TO this edge → EAVE.
 *      Otherwise → not an eave (ridge or flat seam).
 */
export function classifyEdgeWithDsm(
  edge: { a: { lat: number; lng: number }; b: { lat: number; lng: number } },
  dsm: Extract<DsmOutcome, { ok: true }>,
  centroid: { lat: number; lng: number },
  // 1.2 m, not 0.5 m, because complex hip/gable roofs (20+ Solar
  // segments) have natural endpoint variance: an "eave" edge can span
  // a small dormer or transition, putting endpoints on neighbouring
  // roof planes that differ by ~0.7-1 m even though the contractor
  // would still run a single gutter along it. 0.5 m was throwing out
  // 24 of 26 edges on real residential roofs.
  slopeThresholdM = 1.2,
  insideHeightDiffM = 0.5,
): ClassifiedEdge {
  const midLat = (edge.a.lat + edge.b.lat) / 2;
  const midLng = (edge.a.lng + edge.b.lng) / 2;

  // Local meters-per-degree at the edge's latitude — works for any
  // latitude, including the high-latitude case where lng degrees shrink.
  const M_PER_DEG_LAT = 110_540;
  const M_PER_DEG_LNG = 111_320 * Math.cos((midLat * Math.PI) / 180);

  // Edge direction in METERS (so perpendicular is geometrically correct
  // even when M_PER_DEG_LNG ≪ M_PER_DEG_LAT).
  const edgeDxM = (edge.b.lng - edge.a.lng) * M_PER_DEG_LNG;
  const edgeDyM = (edge.b.lat - edge.a.lat) * M_PER_DEG_LAT;
  const edgeLenM = Math.hypot(edgeDxM, edgeDyM);
  if (edgeLenM < 1e-6) {
    return { a: edge.a, b: edge.b, kind: "unknown", reason: "zero-length edge" };
  }

  // Unit perpendicular (rotate 90°), then orient toward centroid so a
  // positive scalar moves us INWARD. Two rotations possible — pick the
  // one whose dot-product with (centroid - midpoint) is positive.
  let perpDxM = -edgeDyM / edgeLenM;
  let perpDyM = edgeDxM / edgeLenM;
  const toCentDxM = (centroid.lng - midLng) * M_PER_DEG_LNG;
  const toCentDyM = (centroid.lat - midLat) * M_PER_DEG_LAT;
  if (perpDxM * toCentDxM + perpDyM * toCentDyM < 0) {
    perpDxM = -perpDxM;
    perpDyM = -perpDyM;
  }

  // Convert a (lat,lng,inset_meters) into the inset lat/lng.
  const insetLatLng = (
    lat: number,
    lng: number,
    insetM: number,
  ): { lat: number; lng: number } => ({
    lat: lat + (perpDyM * insetM) / M_PER_DEG_LAT,
    lng: lng + (perpDxM * insetM) / M_PER_DEG_LNG,
  });

  // Endpoints — inset 0.5m so we land on roof shingles, not the ground.
  const ENDPOINT_INSET_M = 0.5;
  const insetA = insetLatLng(edge.a.lat, edge.a.lng, ENDPOINT_INSET_M);
  const insetB = insetLatLng(edge.b.lat, edge.b.lng, ENDPOINT_INSET_M);
  const heightA = sampleDsmAtLatLng(dsm, insetA.lat, insetA.lng);
  const heightB = sampleDsmAtLatLng(dsm, insetB.lat, insetB.lng);

  if (heightA == null || heightB == null) {
    return {
      a: edge.a,
      b: edge.b,
      kind: "unknown",
      reason: "DSM no-data at inset endpoint",
    };
  }

  // Test 1: sloped edge → rake
  const slope = Math.abs(heightA - heightB);
  if (slope > slopeThresholdM) {
    return {
      a: edge.a,
      b: edge.b,
      kind: "rake",
      reason: `inset endpoint Δh = ${slope.toFixed(2)}m > ${slopeThresholdM}m`,
    };
  }

  // Test 2: 1.5m perpendicular-inward from midpoint. If the interior is
  // higher → water flows TO the edge → eave. If lower or equal →
  // ridge/flat seam, skip.
  const INTERIOR_INSET_M = 1.5;
  const interior = insetLatLng(midLat, midLng, INTERIOR_INSET_M);
  const insideHeight = sampleDsmAtLatLng(dsm, interior.lat, interior.lng);
  if (insideHeight == null) {
    return {
      a: edge.a,
      b: edge.b,
      kind: "unknown",
      reason: "DSM no-data at interior sample",
    };
  }

  const edgeHeight = (heightA + heightB) / 2;
  const insideRise = insideHeight - edgeHeight;
  if (insideRise > insideHeightDiffM) {
    return {
      a: edge.a,
      b: edge.b,
      kind: "eave",
      reason: `flat (Δh=${slope.toFixed(2)}m), interior +${insideRise.toFixed(2)}m`,
    };
  }
  return {
    a: edge.a,
    b: edge.b,
    kind: "rake",
    reason: `flat (Δh=${slope.toFixed(2)}m), interior diff +${insideRise.toFixed(2)}m (no rise toward roof — ridge or flat seam)`,
  };
}

/** Compute centroid (lat/lng) of a closed lat/lng polygon ring. */
export function ringCentroid(
  ring: Array<{ lat: number; lng: number }>,
): { lat: number; lng: number } {
  let sumLat = 0;
  let sumLng = 0;
  for (const p of ring) {
    sumLat += p.lat;
    sumLng += p.lng;
  }
  return { lat: sumLat / ring.length, lng: sumLng / ring.length };
}
