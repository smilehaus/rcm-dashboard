import test from "node:test";
import assert from "node:assert/strict";
import { sensitiveHits } from "./lib/sensitive-json.mjs";

test("filled pin field is rejected", () => {
  assert.ok(sensitiveHits({ staff: [{ id: "a", pin: "0000" }] }).some(h => h.startsWith("secret-key:")));
});

test("empty pin field is allowed", () => {
  assert.deepEqual(sensitiveHits({ staff: [{ id: "a", pin: "" }] }), []);
});

test("email-shaped text is rejected", () => {
  assert.deepEqual(sensitiveHits({ note: "write user@example.com later" }), ["email"]);
});

test("ordinary board fields are allowed", () => {
  assert.deepEqual(sensitiveHits({
    staff: [{ id: "a", name: "A", dept: "RCM" }],
    offices: [{ code: "SQ" }],
    ivDates: { SQ: "2026-10-22" }
  }), []);
});
