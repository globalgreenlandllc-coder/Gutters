"use client";

import type { Measurements } from "./types";

/**
 * Estimate → Proposal handoff via localStorage.
 *
 * The proposal flow lives at /proposal and was originally always seeded
 * with sampleMeasurements regardless of what the contractor actually
 * estimated. This module gives the estimate flow a way to hand its live
 * takeoff data to the proposal flow without threading a server-side
 * draft-proposal record through the router (which is the right long-term
 * answer but a bigger change). The localStorage payload is consumed
 * once on /proposal mount and cleared immediately so a manual refresh
 * doesn't re-apply stale data.
 */

const STORAGE_KEY = "gutters:estimate-handoff";

export interface EstimateHandoff {
  address: string;
  measurements: Measurements;
  /** ms epoch — used to ignore handoffs older than a few minutes so a
   *  stale tab doesn't hijack a fresh proposal session. */
  capturedAt: number;
}

const MAX_AGE_MS = 10 * 60 * 1000; // 10 min

export function writeEstimateHandoff(
  payload: Omit<EstimateHandoff, "capturedAt">,
): void {
  if (typeof window === "undefined") return;
  try {
    const stored: EstimateHandoff = { ...payload, capturedAt: Date.now() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // localStorage can throw in private-browsing / quota-exceeded
    // scenarios. Silently no-op — the proposal page will just fall back
    // to its blank template, which is the same behavior we had before
    // the handoff existed.
  }
}

export function readEstimateHandoff(): EstimateHandoff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EstimateHandoff;
    if (
      !parsed ||
      typeof parsed.address !== "string" ||
      !parsed.measurements ||
      typeof parsed.capturedAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.capturedAt > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearEstimateHandoff(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // see writeEstimateHandoff comment
  }
}
