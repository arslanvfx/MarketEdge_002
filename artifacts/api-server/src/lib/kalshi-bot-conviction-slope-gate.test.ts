// Unit tests for computeConvictionCandleSlopeGate.
//
// The slope gate is a medium-term directional confirmation gate that runs
// ALONGSIDE computeConvictionDirectionGate.  It looks at the last N
// minute-candles to catch sustained prior declines that a 7-second tick
// window can miss.
//
// Logic recap:
//   slopePct = (lastCandle.c − candles[−lookback].c) / candles[−lookback].c × 100
//   YES bet: blocked when slopePct < −effectiveThreshold  (sustained decline)
//   NO  bet: blocked when slopePct > +effectiveThreshold  (sustained rise)
//   Flat (|slopePct| ≤ threshold) is always neutral — never blocks.
//
//   ATR scaling: effectiveThreshold = thresholdPct × min(cap, max(1, atrPct / 0.20))
//   Fail-open: blocked=false when data is insufficient (< lookback+1 candles)
//              or when fromCandle.c === 0 (division guard).
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeConvictionCandleSlopeGate,
  type ConvictionCandleSlopeResult,
} from "./kalshi-bot-engine-core.ts";

// ---------------------------------------------------------------------------
// Helper — build a candle array from close prices
// ---------------------------------------------------------------------------
function candles(...closes: number[]): Array<{ c: number }> {
  return closes.map((c) => ({ c }));
}

// ---------------------------------------------------------------------------
// Build a candle array of `count` candles where the first has close `from`
// and the last has close `to`.  Intermediate candles are linearly spaced so
// the array always has exactly `count` entries.
//
// The slope gate uses candles[length-1-lookback] as fromCandle and
// candles[length-1] as toCandle, so: pass count >= lookback+1 and set the
// first close to `from` and the last close to `to`.
// ---------------------------------------------------------------------------
function slopeCandles(count: number, first: number, last: number): Array<{ c: number }> {
  const arr: Array<{ c: number }> = [];
  for (let i = 0; i < count; i++) {
    arr.push({ c: i === 0 ? first : i === count - 1 ? last : first });
  }
  return arr;
}

// ---------------------------------------------------------------------------
// YES direction — blocked when price has declined beyond threshold
// ---------------------------------------------------------------------------

test("slope gate YES block: decline beyond threshold → blocked=true", () => {
  // fromCandle.c=100, toCandle.c=99.9 → slopePct = -0.1%  (below −0.05% threshold)
  // Need clampedLookback+1 = 6 candles (default lookback=5)
  const arr = candles(100, 100, 100, 100, 100, 99.9);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, true, `Expected blocked=true, got ${r.blocked}`);
  assert.ok(r.slopePct !== null && r.slopePct < -0.05,
    `Expected slopePct < -0.05, got ${r.slopePct}`);
  assert.equal(r.effectiveThreshold, 0.05);
  assert.equal(r.atrMultiplier, 1);
});

test("slope gate YES pass: price rising → blocked=false", () => {
  // fromCandle.c=100, toCandle.c=100.2 → slopePct = +0.2% — rising, not adverse for YES
  const arr = candles(100, 100, 100, 100, 100, 100.2);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false);
  assert.ok(r.slopePct !== null && r.slopePct > 0,
    `Expected positive slopePct, got ${r.slopePct}`);
});

test("slope gate YES pass: decline exactly at threshold boundary → not blocked", () => {
  // slopePct = exactly −0.05%; gate fires on strict < so boundary itself passes
  // fromCandle=100, toCandle = 100 * (1 - 0.0005) = 99.95
  const arr = candles(100, 100, 100, 100, 100, 99.95);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  // slopePct ≈ −0.05 which equals −effectiveThreshold, not strictly less than
  assert.equal(r.blocked, false,
    `Boundary (slopePct === −threshold) must not block; got blocked=${r.blocked}`);
});

// ---------------------------------------------------------------------------
// NO direction — blocked when price has risen beyond threshold
// ---------------------------------------------------------------------------

test("slope gate NO block: rise beyond threshold → blocked=true", () => {
  // fromCandle.c=100, toCandle.c=100.2 → slopePct = +0.2% (above +0.05% threshold)
  const arr = candles(100, 100, 100, 100, 100, 100.2);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "no",
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, true, `Expected blocked=true, got ${r.blocked}`);
  assert.ok(r.slopePct !== null && r.slopePct > 0.05,
    `Expected slopePct > 0.05, got ${r.slopePct}`);
  assert.equal(r.effectiveThreshold, 0.05);
});

test("slope gate NO pass: price falling → blocked=false", () => {
  // fromCandle.c=100, toCandle.c=99.9 → slopePct = −0.1% — falling, not adverse for NO
  const arr = candles(100, 100, 100, 100, 100, 99.9);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "no",
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false);
  assert.ok(r.slopePct !== null && r.slopePct < 0,
    `Expected negative slopePct, got ${r.slopePct}`);
});

test("slope gate NO pass: rise exactly at threshold boundary → not blocked", () => {
  // slopePct = exactly +0.05%; gate fires on strict > so boundary itself passes
  const arr = candles(100, 100, 100, 100, 100, 100.05);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "no",
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false,
    `Boundary (slopePct === +threshold) must not block; got blocked=${r.blocked}`);
});

// ---------------------------------------------------------------------------
// Flat slope — never blocked regardless of direction
// ---------------------------------------------------------------------------

test("slope gate flat: slopePct=0 YES direction → blocked=false (neutral)", () => {
  // fromCandle.c=100, toCandle.c=100 → slopePct = 0
  const arr = candles(100, 100, 100, 100, 100, 100);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false);
  assert.equal(r.slopePct, 0);
});

test("slope gate flat: slopePct=0 NO direction → blocked=false (neutral)", () => {
  const arr = candles(100, 100, 100, 100, 100, 100);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "no",
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false);
  assert.equal(r.slopePct, 0);
});

test("slope gate small move within threshold YES → not blocked", () => {
  // decline of 0.03% is inside the 0.05% threshold → pass
  // fromCandle=100, toCandle=99.97 → slopePct ≈ −0.03
  const arr = candles(100, 100, 100, 100, 100, 99.97);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false,
    `Small move within threshold must not block; slopePct=${r.slopePct}`);
});

test("slope gate small move within threshold NO → not blocked", () => {
  // rise of 0.03% is inside the 0.05% threshold → pass
  const arr = candles(100, 100, 100, 100, 100, 100.03);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "no",
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false,
    `Small move within threshold must not block; slopePct=${r.slopePct}`);
});

// ---------------------------------------------------------------------------
// Fail-open — insufficient candles
// ---------------------------------------------------------------------------

test("slope gate fail-open: empty array → blocked=false, slopePct=null", () => {
  const r = computeConvictionCandleSlopeGate({ candles: [], direction: "yes" });
  assert.equal(r.blocked, false);
  assert.equal(r.slopePct, null);
});

test("slope gate fail-open: one candle → blocked=false (< lookback+1)", () => {
  const r = computeConvictionCandleSlopeGate({
    candles: candles(100),
    direction: "yes",
  });
  assert.equal(r.blocked, false);
  assert.equal(r.slopePct, null);
});

test("slope gate fail-open: exactly lookback candles (need lookback+1) → blocked=false", () => {
  // Default lookback=5 clamped=5; need >= 6 candles; 5 candles → fail-open
  const arr = candles(100, 99, 98, 97, 96);
  assert.equal(arr.length, 5);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    lookback: 5,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false, "5 candles with lookback=5 is insufficient (need 6) → fail-open");
  assert.equal(r.slopePct, null);
});

test("slope gate pass: exactly lookback+1 candles → gate fires (sufficient data)", () => {
  // 6 candles with lookback=5 → fromCandle=candles[0], toCandle=candles[5]
  // Prices clearly declining → should block a YES bet
  const arr = candles(100, 100, 100, 100, 100, 99.9);
  assert.equal(arr.length, 6);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    lookback: 5,
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, true, "6 candles with lookback=5 is sufficient → gate should fire");
  assert.ok(r.slopePct !== null);
});

test("slope gate fail-open: lookback clamped to 2 minimum — still respects clamp", () => {
  // lookback=0 is clamped to 2; need >= 3 candles
  const arr = candles(100, 100); // only 2 → still insufficient for clampedLookback=2
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    lookback: 0, // clamped to 2
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false);
  assert.equal(r.lookback, 2, "lookback below 2 must be clamped to 2");
});

// ---------------------------------------------------------------------------
// Fail-open — fromCandle.c === 0 (division guard)
// ---------------------------------------------------------------------------

test("slope gate fail-open: fromCandle.c === 0 → blocked=false, slopePct=null", () => {
  // If the reference candle has a zero close, division would produce ±Infinity.
  // The guard must catch this and return fail-open.
  // lookback=2 (clamp min); need >= 3 candles
  const arr = [{ c: 0 }, { c: 50 }, { c: 100 }]; // fromCandle.c = 0
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    lookback: 2,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false, "fromCandle.c=0 must trigger fail-open, not block");
  assert.equal(r.slopePct, null);
});

test("slope gate fail-open: fromCandle.c < 0 (negative price guard) → blocked=false", () => {
  // Negative close prices should also trigger the fail-open guard (c <= 0 check)
  const arr = [{ c: -1 }, { c: 100 }, { c: 100 }];
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    lookback: 2,
    atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false, "fromCandle.c<0 must trigger fail-open");
  assert.equal(r.slopePct, null);
});

// ---------------------------------------------------------------------------
// ATR scaling — widens effective threshold proportionally
// ---------------------------------------------------------------------------

test("slope gate ATR scaling: atrPct=0.30 widens threshold 1.5× → small decline passes", () => {
  // atrPct=0.30, baseline=0.20 → multiplier = 0.30/0.20 = 1.5
  // thresholdPct=0.05 → effectiveThreshold = 0.075
  // slopePct = -0.07 → within [−0.075, +∞) for YES → NOT blocked
  const arr = candles(100, 100, 100, 100, 100, 99.93); // slopePct ≈ -0.07
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrPct: 0.30,
    atrScaleEnabled: true,
  });
  assert.equal(r.blocked, false,
    `Decline of ~0.07% should pass with effectiveThreshold=0.075; got blocked=${r.blocked} slopePct=${r.slopePct}`);
  assert.ok(Math.abs(r.effectiveThreshold - 0.075) < 1e-9,
    `effectiveThreshold should be 0.075, got ${r.effectiveThreshold}`);
  assert.ok(Math.abs(r.atrMultiplier - 1.5) < 1e-9,
    `atrMultiplier should be 1.5, got ${r.atrMultiplier}`);
});

test("slope gate ATR scaling: atrPct=0.30 — decline beyond widened threshold still blocks", () => {
  // Same setup; slopePct = -0.08 → -0.08 < -0.075 → blocked
  const arr = candles(100, 100, 100, 100, 100, 99.92); // slopePct = -0.08
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrPct: 0.30,
    atrScaleEnabled: true,
  });
  assert.equal(r.blocked, true,
    `Decline of ~0.08% should block with effectiveThreshold=0.075; got blocked=${r.blocked} slopePct=${r.slopePct}`);
});

test("slope gate ATR scaling disabled: atrPct provided but atrScaleEnabled=false → multiplier=1", () => {
  // Even with atrPct=1.0, if atrScaleEnabled=false, no scaling applies
  const arr = candles(100, 100, 100, 100, 100, 99.9); // slopePct = -0.1
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrPct: 1.0,
    atrScaleEnabled: false,
  });
  assert.equal(r.atrMultiplier, 1, "ATR multiplier must be 1 when scaling disabled");
  assert.equal(r.effectiveThreshold, 0.05);
  assert.equal(r.blocked, true, "decline of 0.1% must still block when scaling disabled");
});

test("slope gate ATR scaling: null atrPct → multiplier=1, no scaling", () => {
  const arr = candles(100, 100, 100, 100, 100, 99.9);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrPct: null,
    atrScaleEnabled: true,
  });
  assert.equal(r.atrMultiplier, 1, "null atrPct must produce multiplier=1");
  assert.equal(r.effectiveThreshold, 0.05);
});

// ---------------------------------------------------------------------------
// ATR cap — scaling never exceeds cap (default 2×)
// ---------------------------------------------------------------------------

test("slope gate ATR cap: very high atrPct clamped to 2× default cap", () => {
  // atrPct=1.0, baseline=0.20 → raw multiplier=5 → clamped to cap=2
  // effectiveThreshold = 0.05 * 2 = 0.10
  // slopePct = -0.08 → within -0.10 → NOT blocked (cap widened enough)
  const arr = candles(100, 100, 100, 100, 100, 99.92); // slopePct ≈ -0.08
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrPct: 1.0,
    atrScaleEnabled: true,
    atrMultiplierCap: 2,
  });
  assert.equal(r.atrMultiplier, 2, `Cap must clamp multiplier to 2, got ${r.atrMultiplier}`);
  assert.ok(Math.abs(r.effectiveThreshold - 0.10) < 1e-9,
    `effectiveThreshold should be 0.10, got ${r.effectiveThreshold}`);
  assert.equal(r.blocked, false,
    `-0.08% decline should pass with cap-limited threshold of 0.10%; got blocked=${r.blocked}`);
});

test("slope gate ATR cap: custom cap=3 allows larger scaling than default 2×", () => {
  // atrPct=0.60, baseline=0.20 → raw multiplier=3 → within custom cap=3
  // effectiveThreshold = 0.05 * 3 = 0.15
  const arr = candles(100, 100, 100, 100, 100, 99.92); // slopePct = -0.08
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrPct: 0.60,
    atrScaleEnabled: true,
    atrMultiplierCap: 3,
  });
  assert.ok(Math.abs(r.atrMultiplier - 3) < 1e-9,
    `multiplier should be 3 (= atrPct/baseline), got ${r.atrMultiplier}`);
  assert.ok(Math.abs(r.effectiveThreshold - 0.15) < 1e-9,
    `effectiveThreshold should be 0.15, got ${r.effectiveThreshold}`);
  // -0.08% is within -0.15% threshold → not blocked
  assert.equal(r.blocked, false);
});

test("slope gate ATR cap: decline beyond cap-limited threshold still blocks", () => {
  // atrPct=1.0, cap=2 → effectiveThreshold=0.10
  // slopePct = -0.15 → beyond -0.10 → blocked
  const arr = candles(100, 100, 100, 100, 100, 99.85); // slopePct = -0.15
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrPct: 1.0,
    atrScaleEnabled: true,
    atrMultiplierCap: 2,
  });
  assert.equal(r.atrMultiplier, 2);
  assert.equal(r.blocked, true,
    `-0.15% decline must block even with 2× cap (threshold=0.10%); got blocked=${r.blocked}`);
});

// ---------------------------------------------------------------------------
// Result fields — verify all output fields are populated correctly
// ---------------------------------------------------------------------------

test("slope gate result fields: lookback returned in result", () => {
  const arr = candles(100, 100, 100, 100, 100, 100);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    lookback: 5,
    atrScaleEnabled: false,
  });
  assert.equal(r.lookback, 5, `lookback field should be 5 (the clamped value), got ${r.lookback}`);
});

test("slope gate result fields: lookback clamped to 10 maximum", () => {
  // Provide enough candles to avoid fail-open; lookback=20 clamped to 10
  const arr = slopeCandles(12, 100, 100); // 12 candles, all 100 → flat
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    lookback: 20, // above max
    atrScaleEnabled: false,
  });
  assert.equal(r.lookback, 10, `lookback above 10 must be clamped to 10, got ${r.lookback}`);
});

test("slope gate result fields: slopePct is correct percentage", () => {
  // from=100, to=101 → slopePct = (101-100)/100*100 = 1.0%
  const arr = candles(100, 100, 100, 100, 100, 101);
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    lookback: 5,
    thresholdPct: 0.05,
    atrScaleEnabled: false,
  });
  assert.ok(r.slopePct !== null);
  assert.ok(Math.abs(r.slopePct - 1.0) < 1e-9,
    `slopePct should be exactly 1.0, got ${r.slopePct}`);
});

// ---------------------------------------------------------------------------
// ATR floor — very low atrPct never scales below 1×
// ---------------------------------------------------------------------------

test("slope gate ATR floor: very low atrPct (< 0.20 baseline) → multiplier stays at 1", () => {
  // atrPct=0.10 → raw = 0.10/0.20 = 0.5; Math.max(1, 0.5) = 1 → no shrinkage
  // effectiveThreshold must equal thresholdPct unchanged
  const arr = candles(100, 100, 100, 100, 100, 99.9); // slopePct = -0.1% — beyond 0.05%
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrPct: 0.10, // below baseline — must not shrink the threshold
    atrScaleEnabled: true,
  });
  assert.equal(r.atrMultiplier, 1,
    `atrPct below baseline must keep multiplier at 1 (floor), got ${r.atrMultiplier}`);
  assert.equal(r.effectiveThreshold, 0.05,
    `effectiveThreshold must not shrink below thresholdPct, got ${r.effectiveThreshold}`);
  assert.equal(r.blocked, true, "decline of 0.1% must still block with unscaled threshold of 0.05%");
});

// ---------------------------------------------------------------------------
// Default ATR cap — cap applies without explicitly passing atrMultiplierCap
// ---------------------------------------------------------------------------

test("slope gate ATR cap default: omitting atrMultiplierCap applies the built-in 2× cap", () => {
  // atrPct=0.80 → raw multiplier = 0.80/0.20 = 4; built-in cap=2 → capped at 2
  // effectiveThreshold = 0.05 * 2 = 0.10
  // slopePct = -0.08% → within -0.10% → NOT blocked
  const arr = candles(100, 100, 100, 100, 100, 99.92); // slopePct ≈ -0.08
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "yes",
    thresholdPct: 0.05,
    atrPct: 0.80,
    atrScaleEnabled: true,
    // atrMultiplierCap intentionally omitted — should default to 2
  });
  assert.equal(r.atrMultiplier, 2,
    `Default cap must clamp multiplier to 2 even without explicit cap param; got ${r.atrMultiplier}`);
  assert.ok(Math.abs(r.effectiveThreshold - 0.10) < 1e-9,
    `effectiveThreshold should be 0.10 with default cap; got ${r.effectiveThreshold}`);
  assert.equal(r.blocked, false,
    `-0.08% must pass with default-capped threshold of 0.10%; got blocked=${r.blocked}`);
});

// ---------------------------------------------------------------------------
// NO direction — ATR-scaled threshold widens for volatile coin
// ---------------------------------------------------------------------------

test("slope gate ATR scaling NO: atrPct=0.30 widens threshold 1.5× → small rise passes", () => {
  // atrPct=0.30 → multiplier=1.5; thresholdPct=0.05 → effectiveThreshold=0.075
  // slopePct = +0.06% → within +0.075 → NOT blocked for NO bet
  const arr = candles(100, 100, 100, 100, 100, 100.06); // slopePct ≈ +0.06
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "no",
    thresholdPct: 0.05,
    atrPct: 0.30,
    atrScaleEnabled: true,
  });
  assert.equal(r.blocked, false,
    `+0.06% rise should pass with ATR-widened threshold of 0.075%; got blocked=${r.blocked} slopePct=${r.slopePct}`);
  assert.ok(Math.abs(r.atrMultiplier - 1.5) < 1e-9,
    `atrMultiplier should be 1.5, got ${r.atrMultiplier}`);
});

test("slope gate ATR scaling NO: rise beyond widened threshold still blocks", () => {
  // Same ATR setup; slopePct = +0.09% → beyond +0.075 → blocked
  const arr = candles(100, 100, 100, 100, 100, 100.09); // slopePct ≈ +0.09
  const r = computeConvictionCandleSlopeGate({
    candles: arr,
    direction: "no",
    thresholdPct: 0.05,
    atrPct: 0.30,
    atrScaleEnabled: true,
  });
  assert.equal(r.blocked, true,
    `+0.09% rise must block with ATR-widened threshold of 0.075%; got blocked=${r.blocked} slopePct=${r.slopePct}`);
});
