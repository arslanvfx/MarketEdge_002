import { test } from "node:test";
import assert from "node:assert/strict";
import { stockAiPermitted } from "./ai-policy.ts";

// Regression: aiEnabled=false must block ALL stock AI (including the
// scheduled scanner's research tier) even when the spend guard allows it.
test("ai policy: aiEnabled=false blocks research even with spend guard enabled", () => {
  assert.equal(stockAiPermitted(false, true), false);
});

test("ai policy: spend guard disabled blocks research even when aiEnabled", () => {
  assert.equal(stockAiPermitted(true, false), false);
});

test("ai policy: both permits required", () => {
  assert.equal(stockAiPermitted(true, true), true);
  assert.equal(stockAiPermitted(false, false), false);
});

test("ai policy: missing aiEnabled (legacy config) defaults to enabled", () => {
  assert.equal(stockAiPermitted(undefined, true), true);
});
