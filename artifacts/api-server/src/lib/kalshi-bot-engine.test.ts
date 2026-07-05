// Unit tests for the ML-primary decision core.
//
// Tests the pure `computeCorePairDecision` function, which is the extracted
// decision logic with no I/O dependencies. This avoids needing to mock the
// crypto module.
//
// Signal priority order (highest → lowest):
//   PATH A — ML primary (mlConfidence ≥ ML_PRIMARY_MIN_CONFIDENCE)
//   PATH B — Claude primary (ML not ready, Claude available)
//   PATH C — Stat primary  (no ML, no Claude)
//
// Final gates: EV gate, minConfidence gate.
//
// NOTE: The "Claude-pending" guard (training coin + claudeAbove=null + <90 s elapsed →
// SKIP "Claude opening call pending") lives in `makeBotDecision` in
// kalshi-bot-engine.ts — the I/O wrapper layer — rather than in this pure
// function.  It is not tested here because testing it requires mocking the
// in-memory stores from crypto.ts.
//
// Run with:  pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeCorePairDecision,
  checkMinReturnGate,
  DEFAULT_BOT_CONFIG,
  BASE_CONFIDENCE_FULL_PAIR,
  BASE_CONFIDENCE_HALF_PAIR,
  CONFIDENCE_BOOST_PER_SIGNAL,
  ML_PRIMARY_MIN_CONFIDENCE,
  ML_SIGNAL_BOOST,
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
// PATH A — ML primary
// ---------------------------------------------------------------------------

test("PATH A: ML ready, all null validators → BET on ML direction (YES)", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 68 }));
  assert.equal(r.action, "BET_YES");
});

test("PATH A: ML ready, all null validators → BET on ML direction (NO)", () => {
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 65 }));
  assert.equal(r.action, "BET_NO");
});

test("PATH A: ML base confidence = mlConfidence when no validators agree", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 67 }));
  assert.equal(r.confidence, 67);
});

test("PATH A: Claude agrees with ML → +ML_SIGNAL_BOOST", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 62, claudeAbove: true }));
  assert.equal(r.confidence, 62 + ML_SIGNAL_BOOST);
});

test("PATH A: Claude disagrees with ML → no boost", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 62, claudeAbove: false }));
  assert.equal(r.confidence, 62);
});

test("PATH A: Stat agrees with ML → +ML_SIGNAL_BOOST", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 62, statAbove: true }));
  assert.equal(r.confidence, 62 + ML_SIGNAL_BOOST);
});

test("PATH A: Stat disagrees with ML → no boost", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 62, statAbove: false }));
  assert.equal(r.confidence, 62);
});

test("PATH A: WM agrees with ML → +ML_SIGNAL_BOOST", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 62, wmDriftAbove: true, wmRec: "bet", wmReady: true }));
  assert.equal(r.confidence, 62 + ML_SIGNAL_BOOST);
});

test("PATH A: all three validators agree with ML → +3×ML_SIGNAL_BOOST", () => {
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 62,
    claudeAbove: true, statAbove: true,
    wmDriftAbove: true, wmRec: "bet", wmReady: true,
  }));
  assert.equal(r.confidence, 62 + 3 * ML_SIGNAL_BOOST);
});

test("PATH A veto: Stat+Claude both oppose ML → core pair wins (falls to PATH B)", () => {
  // ML=YES(65%); Stat=NO, Claude=NO both oppose → veto fires; PATH B picks up
  // Claude=NO + Stat=NO agree → BET_NO at BASE_CONFIDENCE_FULL_PAIR
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 65, claudeAbove: false, statAbove: false }));
  assert.equal(r.action, "BET_NO");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

test("PATH A: ML confidence below threshold → SKIP", () => {
  const belowThreshold = ML_PRIMARY_MIN_CONFIDENCE - 1;
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: belowThreshold }));
  assert.equal(r.action, "SKIP");
});

test("PATH A: reasoning string contains 'ML primary'", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70 }));
  assert.match(r.reasoning, /ML primary/);
});

test("PATH A veto: Stat+Claude both YES, ML=NO → core pair wins (BET_YES via PATH B)", () => {
  // ML=NO(65%); Stat=YES, Claude=YES both oppose → veto fires; PATH B picks up
  // Claude=YES + Stat=YES agree → BET_YES at BASE_CONFIDENCE_FULL_PAIR
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 65, claudeAbove: true, statAbove: true }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

// ---------------------------------------------------------------------------
// PATH B — Claude primary (ML not ready)
// ---------------------------------------------------------------------------

test("PATH B: Claude=YES, Stat agrees → BET_YES", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: true }));
  assert.equal(r.action, "BET_YES");
});

test("PATH B: Claude=NO, Stat agrees → BET_NO", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: false, statAbove: false }));
  assert.equal(r.action, "BET_NO");
});

test("PATH B: Claude+Stat agree → BASE_CONFIDENCE_FULL_PAIR", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: true }));
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

test("PATH B: Claude alone (Stat null) → BASE_CONFIDENCE_HALF_PAIR", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: false, statAbove: null }));
  assert.equal(r.confidence, BASE_CONFIDENCE_HALF_PAIR);
});

test("PATH B: Claude and Stat disagree → SKIP (no ML to arbitrate)", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: false }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /disagree/);
});

test("PATH B: WM agrees with Claude → +CONFIDENCE_BOOST_PER_SIGNAL", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: true, wmDriftAbove: true, wmRec: "bet", wmReady: true }));
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR + CONFIDENCE_BOOST_PER_SIGNAL);
});

test("PATH B: reasoning string contains 'Claude primary'", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: true }));
  assert.match(r.reasoning, /Claude primary/);
});

// ML present but below confidence threshold → falls through to Claude path
test("PATH B: ML below threshold + Claude available → Claude leads", () => {
  const belowThreshold = ML_PRIMARY_MIN_CONFIDENCE - 1;
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: belowThreshold, claudeAbove: true, statAbove: true }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

// mlConfidence null → ML not ready → Claude leads
test("PATH B: ML confidence null → Claude leads", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: null, claudeAbove: false, statAbove: false }));
  assert.equal(r.action, "BET_NO");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

// ---------------------------------------------------------------------------
// PATH C — Stat primary (no ML, no Claude)
// ---------------------------------------------------------------------------

test("PATH C: Stat=YES, no ML, no Claude → BET_YES", () => {
  const r = computeCorePairDecision(inp({ statAbove: true }));
  assert.equal(r.action, "BET_YES");
});

test("PATH C: Stat=NO, no ML, no Claude → BET_NO", () => {
  const r = computeCorePairDecision(inp({ statAbove: false }));
  assert.equal(r.action, "BET_NO");
});

test("PATH C: Stat primary base = BASE_CONFIDENCE_HALF_PAIR when statConfidence null", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, statConfidence: null }));
  assert.equal(r.confidence, BASE_CONFIDENCE_HALF_PAIR);
});

test("PATH C: Stat primary uses statConfidence when available", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, statConfidence: 63 }));
  assert.equal(r.confidence, 63);
});

test("PATH C: WM agrees with Stat → +CONFIDENCE_BOOST_PER_SIGNAL", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, wmDriftAbove: true, wmRec: "bet", wmReady: true }));
  assert.equal(r.confidence, BASE_CONFIDENCE_HALF_PAIR + CONFIDENCE_BOOST_PER_SIGNAL);
});

test("PATH C: reasoning string contains 'Stat primary'", () => {
  const r = computeCorePairDecision(inp({ statAbove: true }));
  assert.match(r.reasoning, /Stat primary/);
});

// ---------------------------------------------------------------------------
// No signals
// ---------------------------------------------------------------------------

test("No signals at all (ML null, Claude null, Stat null) → SKIP", () => {
  const r = computeCorePairDecision(inp());
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /No signals/);
});

test("ML+WM agree but mlConfidence null → SKIP (ML not ready, no Claude/Stat)", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, wmDriftAbove: true }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /No signals/);
});

// ---------------------------------------------------------------------------
// No Kalshi ticker
// ---------------------------------------------------------------------------

test("No Kalshi ticker → SKIP", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, kalshiTicker: null }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /No active Kalshi market/);
});

// ---------------------------------------------------------------------------
// EV gate
// ---------------------------------------------------------------------------

test("Negative EV fires when signalAccuracyPct is low (40% at 50¢ yes)", () => {
  // accFrac=0.40, winPayoff=1.0 → EV = 0.40*1 - 0.60 = -0.20 < -0.05
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70, yesPrice: 0.50, signalAccuracyPct: 40 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Negative EV/);
});

test("Negative EV fires at 45% accuracy at 50¢ yes (borderline negative EV)", () => {
  // accFrac=0.45, winPayoff=1.0 → EV = 0.45*1 - 0.55 = -0.10 < -0.05
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70, yesPrice: 0.50, signalAccuracyPct: 45 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Negative EV/);
});

test("EV gate passes when signalAccuracyPct is 60% at 50¢ yes", () => {
  // accFrac=0.60, winPayoff=1.0 → EV = 0.60*1 - 0.40 = +0.20 ≥ -0.05
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70, yesPrice: 0.50, signalAccuracyPct: 60 }));
  assert.equal(r.action, "BET_YES");
});

test("EV gate skipped when signalAccuracyPct is null (no history yet)", () => {
  // No accuracy data → ev=null → gate doesn't fire → entry proceeds
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70, signalAccuracyPct: null }));
  assert.equal(r.action, "BET_YES");
});

// ---------------------------------------------------------------------------
// Reversing-caution arithmetic (Phase 3 penalty applied externally)
// ---------------------------------------------------------------------------

test("Low-conviction: base 65 - 20 = 45 < minConfidence(60) → Phase 3 skips", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: true }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
  assert.ok(r.confidence - 20 < DEFAULT_MIN_CONFIDENCE, "penalized confidence falls below gate");
});

test("High-conviction: ML+Claude+Stat+WM all agree → 62+18=80 → 80-20=60 ≥ 60 → Phase 3 allows", () => {
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 62,
    claudeAbove: true, statAbove: true,
    wmDriftAbove: true, wmRec: "bet", wmReady: true,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 62 + 3 * ML_SIGNAL_BOOST);
  assert.ok(r.confidence - 20 >= DEFAULT_MIN_CONFIDENCE, "penalized confidence still clears gate");
});

// ---------------------------------------------------------------------------
// isInQuietHours — pure UTC gate
// ---------------------------------------------------------------------------

test("isInQuietHours: disabled when start === end", () => {
  for (const h of [0, 8, 12, 18, 23]) {
    assert.equal(isInQuietHours(h, 12, 12), false, `hour ${h} should not be blocked`);
  }
});

test("isInQuietHours: normal range (start < end) blocks hours in range", () => {
  assert.equal(isInQuietHours(12, 12, 18), true);
  assert.equal(isInQuietHours(17, 12, 18), true);
  assert.equal(isInQuietHours(11, 12, 18), false);
  assert.equal(isInQuietHours(18, 12, 18), false);
  assert.equal(isInQuietHours(0,  12, 18), false);
  assert.equal(isInQuietHours(23, 12, 18), false);
});

test("isInQuietHours: midnight-wrap range (start > end) blocks hours in range", () => {
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
  const s: CircuitBreakerState = { consecutiveLosses: 3, circuitBreakerWindowsRemaining: 2 };
  const next = applyBetOutcome(s, false, 3, 2);
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
  s = tickCircuitBreakerWindow(s);
  assert.equal(s.circuitBreakerWindowsRemaining, 1);
  s = tickCircuitBreakerWindow(s);
  assert.equal(s.circuitBreakerWindowsRemaining, 0, "breaker cleared");
});

// ---------------------------------------------------------------------------
// checkMomentumOverride tests
// ---------------------------------------------------------------------------

import { checkMomentumOverride, deriveRegime, buildStreakSnapshot, restoreStreakState, type CoinStreakEntry } from "./kalshi-bot-engine-core.ts";

test("checkMomentumOverride: returns false when insufficient data (fewer than windowCount+1 points)", () => {
  const strikes = [100, 101, 102];
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), false);
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: returns false when no clear trend (mixed moves)", () => {
  const strikes = [100, 102, 101, 103];
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), false);
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: returns false when move is below threshold", () => {
  // All rising but only 0.1% total move — below 0.5% threshold
  const strikes = [100.00, 100.03, 100.07, 100.10]; // ~0.1% total
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: blocks YES bet when price trending down with sufficient move", () => {
  const strikes = [100, 99.8, 99.5, 99.2]; // trending down ~0.8%
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), true);
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: blocks NO bet when price trending up with sufficient move", () => {
  const strikes = [100, 100.2, 100.5, 100.8]; // trending up ~0.8%
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), true);
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: uses only the last windowCount+1 points", () => {
  // Older data is down, but recent 4 points are flat → no override
  const strikes = [95, 90, 85, 100, 100.1, 100.2, 100.3];
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

// ---------------------------------------------------------------------------
// deriveRegime tests
// ---------------------------------------------------------------------------

test("deriveRegime: returns 'ranging' with fewer than 2 data points", () => {
  assert.equal(deriveRegime([]), "ranging");
  assert.equal(deriveRegime([100]), "ranging");
});

test("deriveRegime: returns 'trending_up' when all strikes increase", () => {
  assert.equal(deriveRegime([100, 101, 102, 103], 3), "trending_up");
});

test("deriveRegime: returns 'trending_down' when all strikes decrease", () => {
  assert.equal(deriveRegime([103, 102, 101, 100], 3), "trending_down");
});

test("deriveRegime: returns 'ranging' on mixed moves", () => {
  assert.equal(deriveRegime([100, 102, 101, 103], 3), "ranging");
});

test("deriveRegime: uses only last windowCount points", () => {
  // First half goes down, but last 3 go up → trending_up
  const strikes = [200, 150, 100, 101, 102, 103];
  assert.equal(deriveRegime(strikes, 3), "trending_up");
});

// ---------------------------------------------------------------------------
// buildStreakSnapshot — snapshot filter for persistence
// ---------------------------------------------------------------------------

test("buildStreakSnapshot: excludes entry with consecutiveLosses=0 and no pause (win-cleared)", () => {
  const state = new Map<string, CoinStreakEntry>([
    ["BTC", { consecutiveLosses: 0, pauseUntilWindowKey: null }],
  ]);
  const snap = buildStreakSnapshot(state);
  assert.deepEqual(snap, {}, "win-cleared entry must NOT appear in snapshot");
});

test("buildStreakSnapshot: includes entry with consecutiveLosses > 0", () => {
  const state = new Map<string, CoinStreakEntry>([
    ["ETH", { consecutiveLosses: 2, pauseUntilWindowKey: null }],
  ]);
  const snap = buildStreakSnapshot(state);
  assert.ok("ETH" in snap);
  assert.equal(snap["ETH"].consecutiveLosses, 2);
  assert.equal(snap["ETH"].pauseUntilWindowKey, null);
});

test("buildStreakSnapshot: includes entry with active pause even when consecutiveLosses=0", () => {
  const state = new Map<string, CoinStreakEntry>([
    ["DOGE", { consecutiveLosses: 0, pauseUntilWindowKey: "2099-01-01T00:00" }],
  ]);
  const snap = buildStreakSnapshot(state);
  assert.ok("DOGE" in snap);
  assert.equal(snap["DOGE"].pauseUntilWindowKey, "2099-01-01T00:00");
});

test("buildStreakSnapshot: mixed map — only non-trivial entries appear", () => {
  const state = new Map<string, CoinStreakEntry>([
    ["BTC",  { consecutiveLosses: 0, pauseUntilWindowKey: null }],
    ["ETH",  { consecutiveLosses: 1, pauseUntilWindowKey: null }],
    ["DOGE", { consecutiveLosses: 0, pauseUntilWindowKey: "2099-01-01T00:00" }],
  ]);
  const snap = buildStreakSnapshot(state);
  assert.ok(!("BTC" in snap),  "BTC (trivial) must be excluded");
  assert.ok("ETH" in snap,     "ETH (loss streak) must be included");
  assert.ok("DOGE" in snap,    "DOGE (paused) must be included");
});

// ---------------------------------------------------------------------------
// restoreStreakState — expiry logic on startup load
// ---------------------------------------------------------------------------

test("restoreStreakState: active pause (nowWindowKey <= pauseUntilWindowKey) is preserved", () => {
  const saved: Record<string, CoinStreakEntry> = {
    BTC: { consecutiveLosses: 3, pauseUntilWindowKey: "2026-07-03T10:15" },
  };
  const now = "2026-07-03T10:00"; // earlier than pause key
  const { state, clearedSyms } = restoreStreakState(saved, now);
  const entry = state.get("BTC");
  assert.ok(entry, "BTC must be present after restore");
  assert.equal(entry!.pauseUntilWindowKey, "2026-07-03T10:15", "active pause must be kept");
  assert.equal(entry!.consecutiveLosses, 3);
  assert.deepEqual(clearedSyms, [], "no syms should have been cleared");
});

test("restoreStreakState: pause at exact same window key as now is expired (boundary — nowKey === pauseKey)", () => {
  // Spec: expired = pauseUntilWindowKey <= currentWindowKey.
  // At equality the coin resumes betting this window → pause must be cleared.
  const saved: Record<string, CoinStreakEntry> = {
    ETH: { consecutiveLosses: 3, pauseUntilWindowKey: "2026-07-03T10:00" },
  };
  const now = "2026-07-03T10:00"; // equal → pause has expired
  const { state, clearedSyms } = restoreStreakState(saved, now);
  assert.equal(state.get("ETH")!.pauseUntilWindowKey, null, "pause at exact current window must be cleared");
  assert.ok(clearedSyms.includes("ETH"), "ETH must appear in clearedSyms");
});

test("restoreStreakState: expired pause (nowWindowKey > pauseUntilWindowKey) is auto-cleared", () => {
  const saved: Record<string, CoinStreakEntry> = {
    BTC: { consecutiveLosses: 3, pauseUntilWindowKey: "2026-07-03T09:45" },
  };
  const now = "2026-07-03T10:00"; // later than pause key → expired
  const { state, clearedSyms } = restoreStreakState(saved, now);
  const entry = state.get("BTC");
  assert.ok(entry, "BTC must still be present");
  assert.equal(entry!.pauseUntilWindowKey, null, "expired pause must be cleared");
  assert.ok(clearedSyms.includes("BTC"), "BTC must appear in clearedSyms");
});

test("restoreStreakState: multiple coins — active pauses kept, expired pauses cleared", () => {
  const saved: Record<string, CoinStreakEntry> = {
    BTC:  { consecutiveLosses: 3, pauseUntilWindowKey: "2026-07-03T10:15" }, // future → keep
    ETH:  { consecutiveLosses: 2, pauseUntilWindowKey: "2026-07-03T09:45" }, // past   → clear
    DOGE: { consecutiveLosses: 1, pauseUntilWindowKey: null },                // no pause
  };
  const now = "2026-07-03T10:00";
  const { state, clearedSyms } = restoreStreakState(saved, now);
  assert.equal(state.get("BTC")!.pauseUntilWindowKey,  "2026-07-03T10:15", "BTC pause must be kept");
  assert.equal(state.get("ETH")!.pauseUntilWindowKey,  null,               "ETH pause must be cleared");
  assert.equal(state.get("DOGE")!.pauseUntilWindowKey, null,               "DOGE has no pause");
  assert.ok(clearedSyms.includes("ETH"),  "ETH in clearedSyms");
  assert.ok(!clearedSyms.includes("BTC"), "BTC not in clearedSyms");
  assert.ok(!clearedSyms.includes("DOGE"), "DOGE not in clearedSyms");
});

test("restoreStreakState: symbol keys are uppercased on restore", () => {
  const saved: Record<string, CoinStreakEntry> = {
    btc: { consecutiveLosses: 2, pauseUntilWindowKey: null },
  };
  const { state } = restoreStreakState(saved, "2026-07-03T10:00");
  assert.ok(state.has("BTC"), "lowercase key must be uppercased");
  assert.ok(!state.has("btc"), "original case key must not be present");
});

test("restoreStreakState: entry with no pause and no losses is restored (not filtered)", () => {
  // restoreStreakState faithfully restores whatever was saved; filtering at persist time
  // is buildStreakSnapshot's job — it would never save this entry in the first place.
  const saved: Record<string, CoinStreakEntry> = {
    SOL: { consecutiveLosses: 0, pauseUntilWindowKey: null },
  };
  const { state } = restoreStreakState(saved, "2026-07-03T10:00");
  assert.ok(state.has("SOL"), "trivial entry in saved snapshot is still restored");
});


// ---------------------------------------------------------------------------
// Minimum-return (payout multiple) gate
// ---------------------------------------------------------------------------

test("min-return gate: off (undefined) allows deep-ITM BET_NO", () => {
  // yesPrice 0.08 → NO cost 0.92 → return ~1.09x. No gate → bet proceeds.
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, yesPrice: 0.08 }));
  assert.equal(r.action, "BET_NO");
});

test("min-return gate: 1.44x skips deep-ITM BET_NO (cost 92c, ret 1.09x)", () => {
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, yesPrice: 0.08, minReturnMultiple: 1.44 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Return 1\.09x below minimum 1\.44x/);
});

test("min-return gate: 1.44x skips deep-ITM BET_YES (cost 92c)", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70, yesPrice: 0.92, minReturnMultiple: 1.44 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /below minimum 1\.44x/);
});

test("min-return gate: 1.44x allows a cheap bet (cost 50c, ret 2x)", () => {
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, yesPrice: 0.50, minReturnMultiple: 1.44 }));
  assert.equal(r.action, "BET_NO");
});

test("min-return gate: return exactly at threshold passes (2x floor, 2x bet)", () => {
  // yesPrice 0.50 → NO cost 0.50 → return exactly 2.0x, not below 2.0 → allowed.
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, yesPrice: 0.50, minReturnMultiple: 2.0 }));
  assert.equal(r.action, "BET_NO");
});

test("min-return gate: floor of 1 is treated as off", () => {
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, yesPrice: 0.08, minReturnMultiple: 1 }));
  assert.equal(r.action, "BET_NO");
});

// checkMinReturnGate — the shared pure helper used by every decision mode
// (classic, ml_gate, consensus, unanimous). Testing it directly proves the
// mode-level guards behave correctly without mocking the I/O wrapper.

test("checkMinReturnGate: floor ≤ 1 disables the gate", () => {
  assert.equal(checkMinReturnGate("BET_NO", 0.08, 1).blocked, false);
  assert.equal(checkMinReturnGate("BET_YES", 0.92, undefined).blocked, false);
});

test("checkMinReturnGate: SKIP action is never blocked", () => {
  assert.equal(checkMinReturnGate("SKIP", 0.92, 1.44).blocked, false);
});

test("checkMinReturnGate: blocks deep-ITM BET_NO below floor", () => {
  const g = checkMinReturnGate("BET_NO", 0.08, 1.44); // NO cost 0.92 → 1.09x
  assert.equal(g.blocked, true);
  assert.match(g.reason, /Return 1\.09x below minimum 1\.44x/);
});

test("checkMinReturnGate: allows a bet at/above the floor", () => {
  assert.equal(checkMinReturnGate("BET_NO", 0.50, 1.44).blocked, false); // 2x
  assert.equal(checkMinReturnGate("BET_NO", 0.50, 2.0).blocked, false);  // exactly 2x
});

test("checkMinReturnGate: null yes-price is NOT blocked even when gate is active", () => {
  // The decision-time cache price is frequently null; the market order fills at
  // the real price at placement time, so the gate must not skip on null.
  const g = checkMinReturnGate("BET_YES", null, 1.44);
  assert.equal(g.blocked, false);
});

test("checkMinReturnGate: null yes-price is allowed when gate is off", () => {
  assert.equal(checkMinReturnGate("BET_YES", null, 1).blocked, false);
});

// ---------------------------------------------------------------------------
// DEFAULT_BOT_CONFIG defaults
// ---------------------------------------------------------------------------

test("DEFAULT_BOT_CONFIG: minReturnMultiple default is 1.45", () => {
  assert.equal(DEFAULT_BOT_CONFIG.minReturnMultiple, 1.45);
});

test("DEFAULT_BOT_CONFIG: minNoEntryMinutes default is 1", () => {
  assert.equal(DEFAULT_BOT_CONFIG.minNoEntryMinutes, 1);
});
