/**
 * Map a raw provider/SDK error string to a clear, user-facing sentence.
 *
 * The recurring one on this product is the Anthropic 400 "credit balance is too
 * low" JSON blob — it reaches the UI verbatim ("400 {"type":"error",…}"), which
 * reads like a crash when it's really just billing. Detect the common,
 * actionable failures and return plain guidance; fall through to the original
 * text for anything unrecognized (never hide a real error). Pure + directive-free
 * so it runs on the server AND in the browser bundle.
 */
export function humanizeAiError(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "Analysis failed — please retry.";
  if (/credit balance is too low|insufficient\s+cred|\bbilling\b/i.test(s))
    return "The AI service is out of credits, so the plan couldn't be analyzed. Add credits to the Anthropic account (Plans & Billing), then retry — this is a billing limit, not a problem with the plan.";
  if (/rate.?limit|\b429\b|overloaded|too many requests/i.test(s))
    return "The AI service is temporarily rate-limited or overloaded. Wait a moment and retry.";
  if (/\btimed?\s?out\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(s))
    return "The analysis timed out before it finished. Retry; if it keeps happening the plan set may be unusually large.";
  if (/authentication|invalid.*api.?key|unauthorized|\b401\b/i.test(s))
    return "The AI service rejected the API key (invalid or unauthorized). Check the API key configuration.";
  return s;
}
