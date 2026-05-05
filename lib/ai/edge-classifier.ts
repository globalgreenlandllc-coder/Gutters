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
 * here — flat at the bottom of a roof slope) or a RAKE (no gutter — the
 * angled side of a gable end where the roof slopes up toward a peak).
 *
 * The math (from the prompt's "secret sauce 3D filter"):
 *
 *   1. Sample the DSM elevation at both endpoints.
 *      - If they differ by more than `slopeThresholdM` → the edge is
 *        sloped → it's a RAKE. Skip it.
 *
 *   2. For flat edges (endpoints at the same elevation), sample 1ft
 *      INSIDE the polygon (perpendicular to the edge, toward the
 *      polygon's centroid).
 *      - If the inside is HIGHER than the edge → water flows DOWN to
 *        the edge → it's an EAVE.
 *      - If the inside is at the same height (or lower) → it's not a
 *        slope's bottom → not an eave.
 */
export function classifyEdgeWithDsm(
  edge: { a: { lat: number; lng: number }; b: { lat: number; lng: number } },
  dsm: Extract<DsmOutcome, { ok: true }>,
  centroid: { lat: number; lng: number },
  slopeThresholdM = 0.5,
  insideHeightDiffM = 0.5,
): ClassifiedEdge {
  const heightA = sampleDsmAtLatLng(dsm, edge.a.lat, edge.a.lng);
  const heightB = sampleDsmAtLatLng(dsm, edge.b.lat, edge.b.lng);

  if (heightA == null || heightB == null) {
    return {
      a: edge.a,
      b: edge.b,
      kind: "unknown",
      reason: "DSM no-data at endpoint",
    };
  }

  // Test 1: sloped edge → rake
  const slope = Math.abs(heightA - heightB);
  if (slope > slopeThresholdM) {
    return {
      a: edge.a,
      b: edge.b,
      kind: "rake",
      reason: `endpoint Δh = ${slope.toFixed(2)}m > ${slopeThresholdM}m`,
    };
  }

  // Test 2: sample 1ft INSIDE the polygon, perpendicular from the edge
  // midpoint toward the centroid. If interior is higher than the edge,
  // water flows toward this edge → eave.
  const midLat = (edge.a.lat + edge.b.lat) / 2;
  const midLng = (edge.a.lng + edge.b.lng) / 2;

  // Direction from midpoint toward centroid
  const dxLng = centroid.lng - midLng;
  const dyLat = centroid.lat - midLat;
  const norm = Math.hypot(dxLng, dyLat);
  if (norm < 1e-12) {
    return {
      a: edge.a,
      b: edge.b,
      kind: "unknown",
      reason: "edge midpoint == centroid",
    };
  }
  // 1 ft ≈ 0.3 m. At lat ~48°N, 0.3m corresponds to ≈2.7e-6° lat and
  // ≈4e-6° lng (longitude shrinks by cos(lat)). Approximate using a
  // simple meters-per-degree at this latitude.
  const M_PER_DEG_LAT = 110_540;
  const M_PER_DEG_LNG = 111_320 * Math.cos((midLat * Math.PI) / 180);
  const offsetMeters = 1.0; // 1m inside (slightly more than 1ft for DSM
  // sampling robustness — the 0.5m DSM pixel size means anything <0.5m
  // could land in the same pixel as the edge)
  const insideLat = midLat + (dyLat / norm) * (offsetMeters / M_PER_DEG_LAT);
  const insideLng = midLng + (dxLng / norm) * (offsetMeters / M_PER_DEG_LNG);

  const insideHeight = sampleDsmAtLatLng(dsm, insideLat, insideLng);
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
    reason: `flat (Δh=${slope.toFixed(2)}m), interior diff +${insideRise.toFixed(2)}m (no rise toward roof)`,
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
