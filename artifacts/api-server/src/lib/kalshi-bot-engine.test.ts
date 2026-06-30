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
  type CorePairInputs,
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
