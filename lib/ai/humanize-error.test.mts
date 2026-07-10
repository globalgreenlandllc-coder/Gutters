import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeAiError } from "./humanize-error.ts";

test("humanizeAiError: the Anthropic credit-balance 400 blob → plain billing guidance", () => {
  const raw =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011"}';
  const out = humanizeAiError(raw);
  assert.match(out, /out of credits/i);
  assert.match(out, /billing/i);
  assert.doesNotMatch(out, /\{|invalid_request_error|request_id/, "no raw JSON leaks through");
});

test("humanizeAiError: rate-limit / timeout / auth get their own clear messages", () => {
  assert.match(humanizeAiError("429 rate limit exceeded"), /rate-limited|overloaded/i);
  assert.match(humanizeAiError("Request timed out after 90s"), /timed out/i);
  assert.match(humanizeAiError("401 authentication_error: invalid x-api-key"), /key/i);
});

test("humanizeAiError: unrecognized errors pass through unchanged; empty → generic", () => {
  assert.equal(humanizeAiError("footprint trace produced 0 corners"), "footprint trace produced 0 corners");
  assert.match(humanizeAiError(""), /retry/i);
  assert.match(humanizeAiError(null), /retry/i);
});
