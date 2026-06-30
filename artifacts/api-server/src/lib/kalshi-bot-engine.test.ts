// Unit tests for the core-pair entry gate.
//
// Tests the pure `computeCorePairDecision` function, which is the extracted
// decision logic with no I/O dependencies. This avoids needing to mock the
// crypto module.
//
// Verifies:
//   1. Stat+Claude agree  → entry even when ML/WM disagree
//   2. ML+WM agree but Stat+Claude both null → SKIP (no core signal)
//   3. Stat and Claude disagree → SKIP (core pair conflict)
//   4. Only one core signal (other null) → entry with half-pair base confidence
//   5. Confidence boosters: ML+8, WM+8 when they agree
//   6. Negative EV gate still fires when signalAccuracyPct is low
//   7. High-conviction reversing window: confidence 81−20=61 ≥ 60 clears penalty
//   8. Reasoning string correctness
//
// NOTE: The "Claude-pending" guard (training coin + claudeAbove=null + <90 s elapsed →
// SKIP "Claude opening call pending") lives in `makeBotDecision` in
// kalshi-bot-engine.ts — the I/O wrapper layer — rather than in this pure
// function.  It is not tested here because testing it requires mocking the
// in-memory stores from crypto.ts.  The guard condition itself is a simple
// three-way boolean that doesn't warrant a mock-heavy integration test.
//
// Run with:  pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeCorePairDecision,
  BASE_CONFIDENCE_FULL_PAIR,
  BASE_CONFIDENCE_HALF_PAIR,
  CONFIDENCE_BOOST_PER_SIGNAL,
  isInQuietHours,
  applyBetOutcome,
  tickCircuitBreakerWindow,
  type CorePairInputs,
  type CircuitBreakerState,
} from "./kalshi-bot-engine-core.ts";

const DEFAULT_MIN_CONFIDENCE = 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inp(overrides: Partial<CorePairInputs> = {}): CorePairInputs {
  return {
    statAbove:         null,
    claudeAbove:       null,
    mlAbove:           null,
    wmDriftAbove:      null,
    wmRec:             null,
    wmReady:           false,
    yesPrice:          0.50,
    signalAccuracyPct: null,
    minutesElapsed:    2,
    statConfidence:    null,
    claudeConfidence:  null,
    mlConfidence:      null,
    kalshiTicker:      "KXBTC-123",
    minConfidence:     DEFAULT_MIN_CONFIDENCE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Core-pair gate
// ---------------------------------------------------------------------------

test("Stat+Claude both agree YES → BET_YES even when ML and WM disagree", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, mlAbove: false, wmDriftAbove: false, wmRec: "bet", wmReady: true }));
  assert.equal(r.action, "BET_YES");
});

test("Stat+Claude both agree NO → BET_NO even when ML and WM disagree", () => {
  const r = computeCorePairDecision(inp({ statAbove: false, claudeAbove: false, mlAbove: true, wmDriftAbove: true, wmRec: "bet", wmReady: true }));
  assert.equal(r.action, "BET_NO");
});

test("ML+WM agree but Stat and Claude both null → SKIP (no core signal)", () => {
  const r = computeCorePairDecision(inp({ statAbove: null, claudeAbove: null, mlAbove: true, wmDriftAbove: true }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /No core signals/);
});

test("Stat and Claude disagree → SKIP (core pair conflict)", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: false }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /disagree/);
});

test("No Kalshi ticker → SKIP", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, kalshiTicker: null }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /No active Kalshi market/);
});

// ---------------------------------------------------------------------------
// Single core signal (half pair)
// ---------------------------------------------------------------------------

test("Only Stat available (Claude null), Stat=true → BET_YES", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: null }));
  assert.equal(r.action, "BET_YES");
});

test("Only Claude available (Stat null), Claude=false → BET_NO", () => {
  const r = computeCorePairDecision(inp({ statAbove: null, claudeAbove: false }));
  assert.equal(r.action, "BET_NO");
});

test("Half-pair base confidence = BASE_CONFIDENCE_HALF_PAIR", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: null }));
  assert.equal(r.confidence, BASE_CONFIDENCE_HALF_PAIR);
});

// ---------------------------------------------------------------------------
// Confidence boosters
// ---------------------------------------------------------------------------

test("Full core pair baseline = BASE_CONFIDENCE_FULL_PAIR", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true }));
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

test("Agreeing ML adds CONFIDENCE_BOOST_PER_SIGNAL to full pair", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, mlAbove: true }));
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR + CONFIDENCE_BOOST_PER_SIGNAL);
});

test("Disagreeing ML adds no boost", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, mlAbove: false }));
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

test("Agreeing WM drift adds CONFIDENCE_BOOST_PER_SIGNAL", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, wmDriftAbove: true, wmRec: "bet", wmReady: true }));
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR + CONFIDENCE_BOOST_PER_SIGNAL);
});

test("Agreeing ML + agreeing WM = full 81%", () => {
  const r = computeCorePairDecision(inp({
    statAbove: true, claudeAbove: true, mlAbove: true,
    wmDriftAbove: true, wmRec: "bet", wmReady: true,
  }));
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR + 2 * CONFIDENCE_BOOST_PER_SIGNAL);
});

test("Disagreeing ML + disagreeing WM = no boost, stays at base", () => {
  const r = computeCorePairDecision(inp({
    statAbove: true, claudeAbove: true, mlAbove: false,
    wmDriftAbove: false, wmRec: "bet", wmReady: true,
  }));
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

// ---------------------------------------------------------------------------
// EV gate
// ---------------------------------------------------------------------------

test("Negative EV fires when signalAccuracyPct is low (40% at 50¢ yes)", () => {
  // accFrac=0.40, winPayoff=1.0 → EV = 0.40*1 - 0.60 = -0.20 < -0.05
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, yesPrice: 0.50, signalAccuracyPct: 40 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Negative EV/);
});

test("Negative EV fires at 45% accuracy at 50¢ yes (borderline negative EV)", () => {
  // accFrac=0.45, winPayoff=(1-0.50)/0.50=1.0 → EV = 0.45*1 - 0.55 = -0.10 < -0.05
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, yesPrice: 0.50, signalAccuracyPct: 45 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Negative EV/);
});

test("EV gate passes when signalAccuracyPct is 60% at 50¢ yes", () => {
  // accFrac=0.60, winPayoff=1.0 → EV = 0.60*1 - 0.40 = +0.20 ≥ -0.05
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, yesPrice: 0.50, signalAccuracyPct: 60 }));
  assert.equal(r.action, "BET_YES");
});

test("EV gate skipped when signalAccuracyPct is null (no history yet)", () => {
  // No accuracy data → ev=null → gate doesn't fire → entry proceeds
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, signalAccuracyPct: null }));
  assert.equal(r.action, "BET_YES");
});

// ---------------------------------------------------------------------------
// Reversing-caution arithmetic (the Phase 3 penalty is applied externally;
// these tests verify the confidence values that Phase 3 operates on)
// ---------------------------------------------------------------------------

test("Low-conviction reversing: base 65 - 20 = 45 < minConfidence(60) → Phase 3 skips", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
  // Phase 3 applies -20 penalty: 65-20=45 < 60 → Phase 3 produces SKIP
  assert.ok(r.confidence - 20 < DEFAULT_MIN_CONFIDENCE, "penalized confidence falls below gate");
});

test("High-conviction reversing: all 4 agree = 81 - 20 = 61 ≥ 60 → Phase 3 allows entry", () => {
  const r = computeCorePairDecision(inp({
    statAbove: true, claudeAbove: true, mlAbove: true,
    wmDriftAbove: true, wmRec: "bet", wmReady: true,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR + 2 * CONFIDENCE_BOOST_PER_SIGNAL);
  // Phase 3 applies -20 penalty: 81-20=61 ≥ 60 → entry proceeds
  assert.ok(r.confidence - 20 >= DEFAULT_MIN_CONFIDENCE, "penalized confidence still clears gate");
});

// ---------------------------------------------------------------------------
// Reasoning string format
// ---------------------------------------------------------------------------

test("Reasoning string reports core pair label on BET", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true }));
  assert.match(r.reasoning, /core pair:/);
  assert.match(r.reasoning, /Stat:✓/);
  assert.match(r.reasoning, /Claude:✓/);
  assert.match(r.reasoning, /BET_YES/);
});

test("Reasoning string shows dash when one core signal is null", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: null }));
  assert.match(r.reasoning, /Claude:—/);
});

test("Reasoning string shows booster contributions", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, mlAbove: true, wmDriftAbove: false, wmRec: "bet", wmReady: true }));
  assert.match(r.reasoning, /ML:\+8/);
  assert.match(r.reasoning, /WM:—/);
});

// ---------------------------------------------------------------------------
// isInQuietHours — pure UTC gate
// ---------------------------------------------------------------------------

test("isInQuietHours: disabled when start === end", () => {
  // Any hour is allowed when start equals end
  for (const h of [0, 8, 12, 18, 23]) {
    assert.equal(isInQuietHours(h, 12, 12), false, `hour ${h} should not be blocked`);
  }
});

test("isInQuietHours: normal range (start < end) blocks hours in range", () => {
  // Range 12–18: blocks 12, 13, 14, 15, 16, 17; allows 0–11 and 18–23
  assert.equal(isInQuietHours(12, 12, 18), true);
  assert.equal(isInQuietHours(17, 12, 18), true);
  assert.equal(isInQuietHours(11, 12, 18), false);
  assert.equal(isInQuietHours(18, 12, 18), false);
  assert.equal(isInQuietHours(0,  12, 18), false);
  assert.equal(isInQuietHours(23, 12, 18), false);
});

test("isInQuietHours: midnight-wrap range (start > end) blocks hours in range", () => {
  // Range 22–6: blocks 22,23,0,1,2,3,4,5; allows 6–21
  assert.equal(isInQuietHours(22, 22, 6), true);
  assert.equal(isInQuietHours(23, 22, 6), true);
  assert.equal(isInQuietHours(0,  22, 6), true);
  assert.equal(isInQuietHours(5,  22, 6), true);
  assert.equal(isInQuietHours(6,  22, 6), false);
  assert.equal(isInQuietHours(21, 22, 6), false);
});

// ---------------------------------------------------------------------------
// applyBetOutcome — circuit breaker trigger logic
// ---------------------------------------------------------------------------

const zeroCB: CircuitBreakerState = { consecutiveLosses: 0, circuitBreakerWindowsRemaining: 0 };

test("applyBetOutcome: win resets consecutive losses to 0", () => {
  const s: CircuitBreakerState = { consecutiveLosses: 2, circuitBreakerWindowsRemaining: 0 };
  const next = applyBetOutcome(s, true, 3, 2);
  assert.equal(next.consecutiveLosses, 0);
});

test("applyBetOutcome: win resets circuit-breaker windows remaining to 0", () => {
  const s: CircuitBreakerState = { consecutiveLosses: 2, circuitBreakerWindowsRemaining: 2 };
  const next = applyBetOutcome(s, true, 3, 2);
  assert.equal(next.circuitBreakerWindowsRemaining, 0, "win must cancel active cooldown");
});

test("applyBetOutcome: loss increments consecutive count", () => {
  const next = applyBetOutcome(zeroCB, false, 3, 2);
  assert.equal(next.consecutiveLosses, 1);
  assert.equal(next.circuitBreakerWindowsRemaining, 0);
});

test("applyBetOutcome: triggers circuit breaker at maxConsecutiveLosses", () => {
  let s = zeroCB;
  s = applyBetOutcome(s, false, 3, 2); // 1 loss
  s = applyBetOutcome(s, false, 3, 2); // 2 losses
  assert.equal(s.circuitBreakerWindowsRemaining, 0, "not triggered yet");
  s = applyBetOutcome(s, false, 3, 2); // 3rd loss → trigger
  assert.equal(s.consecutiveLosses, 3);
  assert.equal(s.circuitBreakerWindowsRemaining, 2, "circuit breaker should fire");
});

test("applyBetOutcome: circuit breaker does not re-trigger past max (stays at pauseWindows)", () => {
  // Already triggered (windows=2), another loss: does NOT reset to pauseWindows again
  const s: CircuitBreakerState = { consecutiveLosses: 3, circuitBreakerWindowsRemaining: 2 };
  const next = applyBetOutcome(s, false, 3, 2);
  // consecutive goes to 4; 4 >= max(3) but circuitBreaker should not change (already active)
  assert.equal(next.consecutiveLosses, 4);
  assert.equal(next.circuitBreakerWindowsRemaining, 2);
});

test("applyBetOutcome: pauseWindows=0 means breaker never triggers", () => {
  let s = zeroCB;
  for (let i = 0; i < 10; i++) s = applyBetOutcome(s, false, 3, 0);
  assert.equal(s.circuitBreakerWindowsRemaining, 0);
});

test("applyBetOutcome: maxConsecutiveLosses=0 disables the circuit breaker entirely", () => {
  let s = zeroCB;
  for (let i = 0; i < 10; i++) s = applyBetOutcome(s, false, 0, 2);
  assert.equal(s.circuitBreakerWindowsRemaining, 0, "breaker must not trigger when maxConsecutiveLosses=0");
});

// ---------------------------------------------------------------------------
// tickCircuitBreakerWindow — countdown decrement
// ---------------------------------------------------------------------------

test("tickCircuitBreakerWindow: decrements remaining by 1", () => {
  const s: CircuitBreakerState = { consecutiveLosses: 3, circuitBreakerWindowsRemaining: 2 };
  const next = tickCircuitBreakerWindow(s);
  assert.equal(next.circuitBreakerWindowsRemaining, 1);
});

test("tickCircuitBreakerWindow: clamps at 0 — does not go negative", () => {
  const s: CircuitBreakerState = { consecutiveLosses: 0, circuitBreakerWindowsRemaining: 0 };
  const next = tickCircuitBreakerWindow(s);
  assert.equal(next.circuitBreakerWindowsRemaining, 0);
});

test("tickCircuitBreakerWindow: two ticks from 2 → 0", () => {
  let s: CircuitBreakerState = { consecutiveLosses: 3, circuitBreakerWindowsRemaining: 2 };
  s = tickCircuitBreakerWindow(s);
  s = tickCircuitBreakerWindow(s);
  assert.equal(s.circuitBreakerWindowsRemaining, 0);
});

test("Full circuit-breaker lifecycle: 3 losses → trigger → 2 ticks → re-enable", () => {
  let s = zeroCB;
  s = applyBetOutcome(s, false, 3, 2);
  s = applyBetOutcome(s, false, 3, 2);
  s = applyBetOutcome(s, false, 3, 2); // trigger
  assert.equal(s.circuitBreakerWindowsRemaining, 2, "breaker active");
  s = tickCircuitBreakerWindow(s); // window passes
  assert.equal(s.circuitBreakerWindowsRemaining, 1);
  s = tickCircuitBreakerWindow(s); // second window passes
  assert.equal(s.circuitBreakerWindowsRemaining, 0, "breaker cleared");
});

// ---------------------------------------------------------------------------
// checkMomentumOverride tests
// ---------------------------------------------------------------------------

import { checkMomentumOverride, deriveRegime } from "./kalshi-bot-engine-core.ts";

test("checkMomentumOverride: returns false when insufficient data (fewer than windowCount+1 points)", () => {
  // Only 3 points, windowCount=3 requires 4
  const strikes = [100, 101, 102];
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), false);
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: returns false when no clear trend (mixed moves)", () => {
  // Up, down, up — no consistent direction
  const strikes = [100, 102, 101, 103];
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), false);
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: returns false when move is below threshold", () => {
  // All rising but only 0.1% total move — below 0.5% threshold
  const strikes = [100.00, 100.03, 100.07, 100.10];
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: triggers for NO bet when price is trending UP", () => {
  // Consistently rising over 3 windows, >0.5% move
  const strikes = [100, 101, 102, 103];
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), true,
    "NO bet should be overridden when price is trending up");
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false,
    "YES bet should NOT be overridden when price is trending up");
});

test("checkMomentumOverride: triggers for YES bet when price is trending DOWN", () => {
  // Consistently falling over 3 windows, >0.5% move
  const strikes = [103, 102, 101, 100];
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), true,
    "YES bet should be overridden when price is trending down");
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), false,
    "NO bet should NOT be overridden when price is trending down");
});

test("checkMomentumOverride: uses only last windowCount+1 elements (ignores older data)", () => {
  // First 2 values are a downtrend, but last 4 are a clear uptrend
  // With windowCount=3, only last 4 points matter → uptrend → override NO
  const strikes = [200, 190, 100, 101, 102, 103];
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), true,
    "should look only at last windowCount+1 points");
});

test("checkMomentumOverride: exactly windowCount+1 points passes the length check", () => {
  // 4 points = exactly windowCount+1 for windowCount=3
  const strikes = [100, 100.6, 101.2, 101.8];
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), true);
});

// ---------------------------------------------------------------------------
// deriveRegime tests
// ---------------------------------------------------------------------------

test("deriveRegime: returns ranging when fewer than 2 data points", () => {
  assert.equal(deriveRegime([]), "ranging");
  assert.equal(deriveRegime([100]), "ranging");
});

test("deriveRegime: returns trending_up when all moves are upward", () => {
  assert.equal(deriveRegime([100, 101, 102], 3), "trending_up");
  assert.equal(deriveRegime([50, 51, 52, 53, 54], 3), "trending_up");
});

test("deriveRegime: returns trending_down when all moves are downward", () => {
  assert.equal(deriveRegime([103, 102, 101], 3), "trending_down");
  assert.equal(deriveRegime([200, 195, 190, 185], 3), "trending_down");
});

test("deriveRegime: returns ranging when moves are mixed", () => {
  assert.equal(deriveRegime([100, 102, 101, 103], 3), "ranging");
  assert.equal(deriveRegime([100, 99, 101, 100], 3), "ranging");
});

test("deriveRegime: uses last max(2, windowCount) elements", () => {
  // First 2 values going down, last 3 going up → with windowCount=3, uses last 3 → trending_up
  const strikes = [200, 190, 100, 101, 102];
  assert.equal(deriveRegime(strikes, 3), "trending_up");
});
