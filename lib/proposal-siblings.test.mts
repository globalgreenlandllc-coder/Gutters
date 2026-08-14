import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clientKeyOf,
  siteKeyOf,
  proposalPairKey,
  siblingProposals,
} from "./proposal-siblings.ts";

test("clientKeyOf: email wins, case-insensitive; name slug fallback; null when neither", () => {
  assert.equal(clientKeyOf("Sarah@Example.com", "Someone Else"), "sarah@example.com");
  assert.equal(clientKeyOf("", "  Sarah  Chen "), "name:sarah chen");
  assert.equal(clientKeyOf(null, null), null);
});

test("siteKeyOf: punctuation/case/whitespace-insensitive", () => {
  assert.equal(siteKeyOf("123 Main St., Lake Stevens, WA 98258"), "123 main st lake stevens wa 98258");
  assert.equal(
    siteKeyOf("123  MAIN st Lake Stevens WA 98258"),
    "123 main st lake stevens wa 98258",
  );
  assert.equal(siteKeyOf("   "), null);
});

test("siblingProposals: same client + same site pairs; different site or client never does", () => {
  const A = { id: "a", clientEmail: "s@x.com", clientName: "Sarah", address: "123 Main St, WA" };
  const B = { id: "b", clientEmail: "S@X.com", clientName: "", address: "123 Main St., WA" };
  const C = { id: "c", clientEmail: "s@x.com", clientName: "Sarah", address: "999 Other Rd" };
  const D = { id: "d", clientEmail: "other@y.com", clientName: "Bob", address: "123 Main St, WA" };
  const sibs = siblingProposals([A, B, C, D], A);
  assert.deepEqual(sibs.map((s) => s.id), ["b"]);
});

test("siblingProposals: unidentifiable target (no email/name or no address) chains nothing", () => {
  const A = { id: "a", clientEmail: "", clientName: "", address: "123 Main St" };
  const B = { id: "b", clientEmail: "", clientName: "", address: "123 Main St" };
  assert.deepEqual(siblingProposals([A, B], A), []);
  const E = { id: "e", clientEmail: "s@x.com", clientName: "S", address: "" };
  const F = { id: "f", clientEmail: "s@x.com", clientName: "S", address: "" };
  assert.deepEqual(siblingProposals([E, F], E), []);
});
