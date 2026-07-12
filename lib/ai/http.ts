import "server-only";

/**
 * fetch with a hard per-call timeout.
 *
 * The address pipeline chains several upstream calls (geocode → satellite
 * imagery → Google Solar → SAM-2 via fal.ai → GPT-4o vision). A bare
 * `fetch()` has NO timeout, so a single slow or hung dependency used to
 * consume the entire 90s Vercel function budget and surface to the user as
 * an opaque "we couldn't run that estimate — an upstream service may be
 * slow". Bounding each call turns a hang into an ordinary, catchable
 * failure that the pipeline's existing per-step fallbacks already handle
 * (skip Solar, fall back Mapbox→Google, degrade vision, etc.).
 *
 * On timeout it throws a plain `Error` with a readable message (not the raw
 * DOMException) so callers' existing `e.message` handling produces a clean
 * run-note / humanized error.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ms = Math.max(1, Math.round(timeoutMs));
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`request timed out after ${ms}ms`);
    }
    throw e;
  }
}

/**
 * Per-call ceilings for the address pipeline, in one place so they're easy
 * to tune. Each is generous (~2-3× the typical latency) so normal runs are
 * never cut short — they only trip on a genuinely stuck/extreme call. The
 * pathological "everything slow at once" case is caught separately by the
 * whole-pipeline deadline in runEstimate (app/actions/estimate.ts), which
 * returns a clean error before the 90s Vercel kill.
 */
export const AI_TIMEOUTS = {
  geocode: 10_000,
  imagery: 12_000,
  solar: 12_000,
  solarMask: 12_000,
  solarDsm: 12_000,
  sam: 35_000,
  vision: 45_000,
} as const;
