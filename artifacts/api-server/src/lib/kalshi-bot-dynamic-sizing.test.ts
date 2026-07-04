// Unit tests for computeDynamicBetSize — confidence-based bet sizing.
//
// The helper linearly scales the target dollar bet between betSize (min, at
// minConfidence) and maxBetSize (max, at dynamicSizingMaxConfidence). It must:
//   1. Return betSize unchanged when disabled (legacy behavior).
//   2. Return betSize at/below the confidence floor.
//   3. Return maxBetSize at/above the confidence ceiling.
//   4. Interpolate linearly in between.
//   5. Never exceed maxBetSize nor drop below betSize, even for bad configs.
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDynamicBetSize } from "./kalshi-bot-engine-core.ts";

const base = {
  enableDynamicSizing: true,
  betSize: 1,
  maxBetSize: 2,
  minConfidence: 65,
  dynamicSizingMaxConfidence: 85,
};

test("disabled → always returns betSize", () => {
  assert.equal(computeDynamicBetSize(99, { ...base, enableDynamicSizing: false }), 1);
  assert.equal(computeDynamicBetSize(50, { ...base, enableDynamicSizing: false }), 1);
});

test("at or below the floor → minimum bet", () => {
  assert.equal(computeDynamicBetSize(65, base), 1);
  assert.equal(computeDynamicBetSize(40, base), 1);
});

test("at or above the ceiling → maximum bet", () => {
  assert.equal(computeDynamicBetSize(85, base), 2);
  assert.equal(computeDynamicBetSize(100, base), 2);
});

test("interpolates linearly at the midpoint", () => {
  // Midpoint of [65,85] is 75 → halfway between $1 and $2 = $1.50
  assert.equal(computeDynamicBetSize(75, base), 1.5);
});

test("interpolates linearly at an arbitrary point", () => {
  // 70 is 25% of the way from 65→85 → $1 + 0.25*($1) = $1.25
  assert.equal(computeDynamicBetSize(70, base), 1.25);
});

test("never exceeds maxBetSize nor drops below betSize", () => {
  for (let c = 0; c <= 100; c++) {
    const size = computeDynamicBetSize(c, base);
    assert.ok(size >= base.betSize, `size ${size} below min at conf ${c}`);
    assert.ok(size <= base.maxBetSize, `size ${size} above max at conf ${c}`);
  }
});

test("inverted range (betSize >= maxBetSize) → returns betSize", () => {
  assert.equal(computeDynamicBetSize(90, { ...base, betSize: 2, maxBetSize: 2 }), 2);
  assert.equal(computeDynamicBetSize(90, { ...base, betSize: 3, maxBetSize: 2 }), 3);
});

test("non-finite confidence (NaN/Infinity) → minimum bet", () => {
  assert.equal(computeDynamicBetSize(NaN, base), 1);
  assert.equal(computeDynamicBetSize(Infinity, base), 1);
  assert.equal(computeDynamicBetSize(-Infinity, base), 1);
});

test("degenerate confidence range (ceiling <= floor) → step at floor", () => {
  const cfg = { ...base, minConfidence: 80, dynamicSizingMaxConfidence: 80 };
  assert.equal(computeDynamicBetSize(79, cfg), 1);
  assert.equal(computeDynamicBetSize(80, cfg), 2);
  assert.equal(computeDynamicBetSize(95, cfg), 2);
});
