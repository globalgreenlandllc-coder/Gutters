import "server-only";
import { geocodeAddress, type GeocodeResult } from "./geocode";
import {
  sampleEaves,
  sampleDownspouts,
  sampleMeasurements,
} from "@/lib/mock-estimate";
import type { EditableLine, Downspout, Measurements } from "@/lib/types";

export type EstimateResult = {
  geocoded: GeocodeResult;
  measurements: Measurements;
  eaves: EditableLine[];
  downspouts: Downspout[];
  source: "ai" | "mock" | "partial";
  durationMs: number;
  notes: string[];
};

/**
 * End-to-end pipeline. Currently:
 *  1. Geocode the address (Google Maps if key present, else mock)
 *  2. [TODO] Fetch aerial imagery via Google Solar API
 *  3. [TODO] Vision-segment eaves via GPT-4o
 *  4. [TODO] Convert pixel polylines to LF via Turf.js
 *
 * For now, steps 2-4 produce the existing canonical sample data so the
 * /estimate UI works end-to-end. The geometry hook is in place; swap
 * mock measurements with the real pipeline once Google Solar + OpenAI
 * keys are in the vault.
 */
export async function runAIEstimatePipeline(
  address: string,
): Promise<EstimateResult> {
  const t0 = Date.now();
  const notes: string[] = [];

  const geocoded = await geocodeAddress(address);
  if (geocoded.source === "google") {
    notes.push("Geocoded via Google Maps");
  } else {
    notes.push("Geocoded via mock (no Google Maps key in vault)");
  }

  const aiCallable = false; // becomes true when Solar + Vision are wired

  if (!aiCallable) {
    notes.push("Roof segmentation pending — using canonical sample geometry");
    return {
      geocoded,
      measurements: sampleMeasurements,
      eaves: sampleEaves,
      downspouts: sampleDownspouts,
      source: geocoded.source === "google" ? "partial" : "mock",
      durationMs: Date.now() - t0,
      notes,
    };
  }

  return {
    geocoded,
    measurements: sampleMeasurements,
    eaves: sampleEaves,
    downspouts: sampleDownspouts,
    source: "ai",
    durationMs: Date.now() - t0,
    notes,
  };
}
