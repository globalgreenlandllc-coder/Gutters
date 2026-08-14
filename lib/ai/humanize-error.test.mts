import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeAiError } from "./humanize-error.ts";

test("humanizeAiError: the Anthropic credit-balance 400 blob → generic user apology (no billing internals)", () => {
  const raw =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011"}';
  const out = humanizeAiError(raw);
  // Users must never learn the PLATFORM's provider account is out of
  // credits — they get a plain "temporarily unavailable" apology; the
  // raw cause is server-log-only at the call sites.
  assert.match(out, /temporarily unavailable/i);
  assert.doesNotMatch(out, /credit balance|out of credits|anthropic|billing/i, "no billing internals leak");
  assert.doesNotMatch(out, /\{|invalid_request_error|request_id/, "no raw JSON leaks through");
});

test("humanizeAiError: auth/key failures are also masked as temporarily unavailable", () => {
  const out = humanizeAiError("401 authentication_error: invalid x-api-key");
  assert.match(out, /temporarily unavailable/i);
  assert.doesNotMatch(out, /api.?key|auth/i, "no key/config internals leak");
});

test("humanizeAiError: rate-limit / timeout get their own clear messages", () => {
  assert.match(humanizeAiError("429 rate limit exceeded"), /busy/i);
  assert.match(humanizeAiError("Request timed out after 90s"), /timed out/i);
});

test("humanizeAiError: unrecognized errors pass through unchanged; empty → generic", () => {
  assert.equal(humanizeAiError("footprint trace produced 0 corners"), "footprint trace produced 0 corners");
  assert.match(humanizeAiError(""), /retry/i);
  assert.match(humanizeAiError(null), /retry/i);
});
