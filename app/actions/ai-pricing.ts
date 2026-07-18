"use server";

import { getMe } from "./me";
import { suggestMarketPrice } from "@/lib/ai/price-suggestion";
import type { AiPriceQuote } from "@/lib/proposal-mock";
import type { EstimateConfig, Measurements } from "@/lib/types";

/**
 * ai-pricing.ts — the proposal builder's "AI recommended price" fetch.
 *
 * Thin authenticated wrapper around lib/ai/price-suggestion: the client
 * sends the job's address + spec + footage and its own `inputKey`
 * fingerprint; the action stamps the quote so the builder can cache it
 * on the package and detect staleness later. Signed-in users only —
 * the AI key never leaves the server.
 */

export type AiPriceQuoteResult =
  | { ok: true; quote: AiPriceQuote }
  | { ok: false; reason: string };

export async function getAiPriceQuote(input: {
  address: string;
  config: EstimateConfig;
  measurements: Measurements;
  /** Client-computed fingerprint of (address, spec, footage) — echoed
   *  back on the quote so the builder can tell when it goes stale. */
  inputKey: string;
}): Promise<AiPriceQuoteResult> {
  const me = await getMe();
  if (!me) return { ok: false, reason: "Not signed in" };
  const address = (input.address ?? "").trim();
  if (!address) {
    return { ok: false, reason: "Add a property address first" };
  }
  if (
    !input.measurements ||
    !Number.isFinite(input.measurements.eaveLF) ||
    input.measurements.eaveLF <= 0
  ) {
    return { ok: false, reason: "Measurements are missing — add footage first" };
  }

  const res = await suggestMarketPrice({
    address,
    config: input.config,
    measurements: input.measurements,
  });
  if (!res.ok) return res;

  return {
    ok: true,
    quote: {
      recommendedTotal: res.suggestion.recommendedTotal,
      lowTotal: res.suggestion.lowTotal,
      highTotal: res.suggestion.highTotal,
      perLfInstalled: res.suggestion.perLfInstalled,
      reasoning: res.suggestion.reasoning,
      location: res.suggestion.location,
      fetchedAt: new Date().toISOString(),
      inputKey: input.inputKey,
    },
  };
}
