// Unit tests for the sequential pipeline decision core.
//
// Tests the pure `computeCorePairDecision` function, which is the extracted
// decision logic with no I/O dependencies. This avoids needing to mock the
// crypto module.
//
// Pipeline (sequential gates — all must pass before a bet fires):
//   GATE 1 — All three models required: Stat + Claude + ML must each have a direction.
//   GATE 2 — Per-signal minimums (non-unanimous only): Stat≥58%, Claude≥62%, ML≥60%.
//             Bypassed when all three models unanimously agree (Path A) — Gate 4 decides.
//   GATE 3 — Direction agreement:
//     (A) Unanimous → bet (ML+6, Stat+4); Gate 2 bypassed; Gate 4 composite decides
//     (B) ML+Claude agree, Stat dissents → bet (ML+6, Stat−4); ML must be ≥70% to lead
//     (C) Stat+Claude agree, ML opposes at ≥75% → ML override
//     (D) ML+Stat agree, Claude disagrees → SKIP
//   GATE 4 — Composite confidence ≥ minConfidence (default 70%).
//   Post-pipeline — EV gate, minReturnMultiple gate.
//
// NOTE: The pipeline Claude gate (claudeAbove=null → SKIP) lives both in the
// pure core and in `makeBotDecision` in kalshi-bot-engine.ts (which also
// builds the SignalSnapshot and logs the pending state).
//
// Run with:  pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeCorePairDecision,
  checkMinReturnGate,
  checkFastAgreementEntry,
  DEFAULT_BOT_CONFIG,
  BASE_CONFIDENCE_FULL_PAIR,
  BASE_CONFIDENCE_HALF_PAIR,
  CONFIDENCE_BOOST_PER_SIGNAL,
  ML_PRIMARY_MIN_CONFIDENCE,
  ML_SIGNAL_BOOST,
  STAT_AGREE_BOOST,
  ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY,
  ML_REQUIRED_MIN_CONF,
  ML_LEAD_MIN_CONF,
  ML_OVERRIDE_MIN_CONF,
  STAT_REQUIRED_MIN_CONF,
  CLAUDE_REQUIRED_MIN_CONF,
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
// PIPELINE: Gate 1 — all three models required
// ---------------------------------------------------------------------------

test("pipeline gate 1: stat=null → SKIP — waiting for Stat", () => {
  const r = computeCorePairDecision(inp({
    statAbove: null,
    claudeAbove: false, claudeConfidence: 55,
    mlAbove: false, mlConfidence: 65,
  }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /waiting for Stat/);
});

test("pipeline gate 1: claude=null → SKIP — waiting for Claude", () => {
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 55,
    claudeAbove: null,
    mlAbove: false, mlConfidence: 65,
  }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /waiting for Claude/);
});

test("pipeline gate 1: ml=null → SKIP — waiting for ML", () => {
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 55,
    claudeAbove: false, claudeConfidence: 55,
    mlAbove: null,
  }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /waiting for ML/);
});

test("pipeline gate 1: all three null → SKIP — first gate fires on Stat", () => {
  const r = computeCorePairDecision(inp());
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Pipeline/);
});

// ---------------------------------------------------------------------------
// PIPELINE: Gate 2 — per-signal confidence minimums (non-unanimous only)
// Gate 2 is bypassed when all three models unanimously agree (Path A).
// It only fires when models disagree (Paths B/C/D).
// ---------------------------------------------------------------------------

test("pipeline gate 2: stat confidence 57% → SKIP for non-unanimous decision (below 58% minimum)", () => {
  // ML+Claude agree YES, Stat dissents NO (Path B) — non-unanimous → Gate 2 applies
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 57, // below 58% floor; dissenting
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70,
    minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Stat confidence.*below minimum/);
});

test("pipeline gate 2: stat exactly 58% → passes minimum in non-unanimous decision", () => {
  // ML+Claude agree YES, Stat dissents NO (Path B) — non-unanimous → Gate 2 applies; stat passes floor
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 58, // exactly at floor; dissenting
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70,
    minConfidence: 50,
  }));
  // Passes Gate 2; Path B fires (ML leads against Stat dissent)
  assert.notEqual(r.action, "SKIP");
});

test("pipeline gate 2: claude confidence 61% → SKIP for non-unanimous decision (below 62% minimum)", () => {
  // ML+Claude agree YES, Stat dissents NO (Path B) — non-unanimous → Gate 2 applies
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 58, // dissenting but above floor
    claudeAbove: true, claudeConfidence: 61, // below 62% floor
    mlAbove: true, mlConfidence: 70,
    minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Claude confidence.*below minimum/);
});

test("pipeline gate 2: ML confidence 69% unanimous → BET_YES (60% floor; Path B handles dissent separately)", () => {
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 69,
    minConfidence: 50,
  }));
  assert.equal(r.action, "BET_YES"); // unanimous: ML needs only 60% not 70%
  assert.equal(r.confidence, 69 + ML_SIGNAL_BOOST + STAT_AGREE_BOOST); // 69+6+4=79
});

test("pipeline gate 3B: ML+Claude agree, ML 69% < ML_LEAD_MIN_CONF (70%) → SKIP when Stat dissents", () => {
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 58, // Stat disagrees
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 69,
    minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /ML.*needs.*70.*lead.*Stat.*dissent/);
});

test("pipeline gate 2: ML exactly 70% → passes minimum", () => {
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70,
    minConfidence: 50,
  }));
  assert.notEqual(r.action, "SKIP");
});

test("pipeline gate 2: null confidence unanimous → Gate 2 bypassed → composite 0+6+4=10% < minConfidence → SKIP at Gate 4", () => {
  // Unanimous (all true) bypasses Gate 2; null conf → 0 → composite=10% < default minConfidence → Gate 4 blocks
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: null,
    claudeAbove: true, claudeConfidence: null,
    mlAbove: true, mlConfidence: null,
  }));
  assert.equal(r.action, "SKIP");
});

test("pipeline gate 2: unanimous low-confidence (stat=55, claude=58, ml=56) → BET_YES (Gate 2 BYPASSED for unanimous)", () => {
  // All three agree YES. Gate 2 floors do NOT apply to the unanimous path — three-model
  // unanimous agreement is itself strong evidence. The stat model's calibrated output
  // (50–57%) is routinely below any floor even on reliable entries.
  // Composite confidence = mlConf(56) + ML_SIGNAL_BOOST(6) + STAT_AGREE_BOOST(4) = 66 ≥ minConfidence(60) → BET_YES.
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 55,
    claudeAbove: true, claudeConfidence: 58,
    mlAbove: true, mlConfidence: 56,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 56 + ML_SIGNAL_BOOST + STAT_AGREE_BOOST); // 56+6+4=66
});

test("pipeline gate 2: unanimous with sufficient ML + stat but low claude → BET_YES (claude floor waived unanimous)", () => {
  // All three agree YES. ML(61%) ≥ 60%, Stat(59%) ≥ 58%. Claude floor waived for unanimous.
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 59,
    claudeAbove: true, claudeConfidence: 58, // below 62% floor — waived for unanimous
    mlAbove: true, mlConfidence: 61,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 61 + ML_SIGNAL_BOOST + STAT_AGREE_BOOST); // 61+6+4=71
});

test("pipeline gate 2: constants reflect spec values (stat=58, claude=62, ml=60, lead=70, override=75, stat_boost=4, dissent_penalty=4)", () => {
  assert.equal(STAT_REQUIRED_MIN_CONF,                  58);
  assert.equal(CLAUDE_REQUIRED_MIN_CONF,                62);
  assert.equal(ML_REQUIRED_MIN_CONF,                    60); // Gate 2 floor — just enough to have a direction
  assert.equal(ML_LEAD_MIN_CONF,                        70); // Path B — ML leading against Stat dissent
  assert.equal(ML_OVERRIDE_MIN_CONF,                    75);
  assert.equal(STAT_AGREE_BOOST,                         4);
  assert.equal(ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY,     4);
});

// ---------------------------------------------------------------------------
// PIPELINE: Gate 3A — unanimous agreement
// ---------------------------------------------------------------------------

test("unanimous YES: all three agree above minimums → BET_YES", () => {
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_YES");
});

test("unanimous NO: all three agree above minimums → BET_NO", () => {
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 58,
    claudeAbove: false, claudeConfidence: 62,
    mlAbove: false, mlConfidence: 70,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_NO");
});

test("unanimous: confidence = mlConf + ML_SIGNAL_BOOST + STAT_AGREE_BOOST (Claude co-signs +6, Stat confirms +4)", () => {
  // Path A: 70 + 6 + 4 = 80
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70,
    minConfidence: 60,
  }));
  assert.equal(r.confidence, 70 + ML_SIGNAL_BOOST + STAT_AGREE_BOOST); // 70+6+4=80
});

test("unanimous: WM agreeing adds CONFIDENCE_BOOST_PER_SIGNAL on top", () => {
  // Path A + WM: 70+6+4+8=88
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70,
    wmDriftAbove: true, wmRec: "bet", wmReady: true,
    minConfidence: 60,
  }));
  assert.equal(r.confidence, 70 + ML_SIGNAL_BOOST + STAT_AGREE_BOOST + CONFIDENCE_BOOST_PER_SIGNAL); // 88
});

test("unanimous: WM opposing does NOT reduce confidence (WM never vetoes)", () => {
  const noWm = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70,
    minConfidence: 60,
  }));
  const wmOppose = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70,
    wmDriftAbove: false, wmRec: "skip", wmReady: true,
    minConfidence: 60,
  }));
  assert.equal(wmOppose.confidence, noWm.confidence); // no penalty from opposing WM
});

test("unanimous: composite below final minConfidence gate → SKIP with confidence value preserved", () => {
  // Path A: 70+6+4=80, minConfidence=85 → SKIP
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70,
    minConfidence: 85,
  }));
  assert.equal(r.action, "SKIP");
  assert.equal(r.confidence, 80);
});

test("unanimous: reasoning contains 'Unanimous'", () => {
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 58,
    claudeAbove: false, claudeConfidence: 62,
    mlAbove: false, mlConfidence: 70,
    minConfidence: 60,
  }));
  assert.match(r.reasoning, /Unanimous/);
});

test("unanimous YES clears production minConfidence=70 at minimum inputs (70+6+4=80 ≥ 70)", () => {
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70,
    minConfidence: 70,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 80);
});

test("unanimous NO clears production minConfidence=70 at minimum inputs", () => {
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 58,
    claudeAbove: false, claudeConfidence: 62,
    mlAbove: false, mlConfidence: 70,
    minConfidence: 70,
  }));
  assert.equal(r.action, "BET_NO");
  assert.equal(r.confidence, 80);
});

// ---------------------------------------------------------------------------
// PIPELINE: Gate 3C — ML override (stat+claude agree, ML opposes at ≥75%)
// ---------------------------------------------------------------------------

test("ML override: ML 70% opposing stat+claude → SKIP (below 75% override threshold)", () => {
  // stat+claude both say YES, ML says NO at 70% — below the 75% override bar
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 60,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: false, mlConfidence: 70,
    minConfidence: 60,
  }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /needs.*to override|below.*override/i);
});

test("ML override: ML 74% opposing stat+claude → SKIP (1% below 75% threshold)", () => {
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 58,
    claudeAbove: false, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 74,
    minConfidence: 60,
  }));
  assert.equal(r.action, "SKIP");
});

test("ML override: ML exactly 75% opposing stat+claude YES → follow ML → BET_NO at 75", () => {
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: false, mlConfidence: 75,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_NO"); // ML says NO (below strike), stat+claude said YES
  assert.equal(r.confidence, 75);   // ML confidence alone — no boosts from opposing validators
});

test("ML override: ML exactly 75% opposing stat+claude NO → follow ML → BET_YES at 75", () => {
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 58,
    claudeAbove: false, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 75,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 75);
});

test("ML override: confidence = ML confidence alone (opposing validators add no boost)", () => {
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: false, mlConfidence: 75,
    minConfidence: 60,
  }));
  assert.equal(r.confidence, 75);
  assert.notEqual(r.confidence, 75 + ML_SIGNAL_BOOST); // stat does NOT boost ML here
});

test("ML override: WM agreeing with ML adds CONFIDENCE_BOOST_PER_SIGNAL", () => {
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 58,
    claudeAbove: false, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 75,
    wmDriftAbove: true, wmRec: "bet", wmReady: true,
    minConfidence: 60,
  }));
  assert.equal(r.confidence, 75 + CONFIDENCE_BOOST_PER_SIGNAL); // 83
});

test("ML override: reasoning contains 'ML override'", () => {
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 58,
    claudeAbove: false, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 75,
    minConfidence: 60,
  }));
  assert.match(r.reasoning, /ML override/);
});

test("ML override: ML 80% opposing stat+claude → override fires", () => {
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 80,
    statAbove: false, statConfidence: 58,
    claudeAbove: false, claudeConfidence: 62,
    minConfidence: 62,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 80);
  assert.match(r.reasoning, /ML override/);
});

test("ML override: ML 75% opposing high-confidence stat+claude → override fires regardless of their level", () => {
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 75,
    statAbove: false, statConfidence: 70,
    claudeAbove: false, claudeConfidence: 70,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 75);
});

// ---------------------------------------------------------------------------
// PIPELINE: Gate 3B — ML+Claude agree, Stat dissents → BET with penalty
// ---------------------------------------------------------------------------

test("Path B: ML=YES + Claude=YES, Stat=NO → BET_YES with Stat-dissent penalty", () => {
  // ML+Claude agree on YES; Stat disagrees. Net confidence = mlConf + 6 − 4 = 70+6−4=72
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 70,
    claudeAbove: true, claudeConfidence: 62,
    statAbove: false, statConfidence: 58,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 70 + ML_SIGNAL_BOOST - ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY); // 72
});

test("Path B: ML=NO + Claude=NO, Stat=YES → BET_NO with Stat-dissent penalty", () => {
  const r = computeCorePairDecision(inp({
    mlAbove: false, mlConfidence: 70,
    claudeAbove: false, claudeConfidence: 62,
    statAbove: true, statConfidence: 58,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_NO");
  assert.equal(r.confidence, 70 + ML_SIGNAL_BOOST - ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY); // 72
});

test("Path B: confidence = mlConf + ML_SIGNAL_BOOST − ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY", () => {
  // 72 + 6 − 4 = 74
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 72,
    claudeAbove: true, claudeConfidence: 65,
    statAbove: false, statConfidence: 60,
    minConfidence: 60,
  }));
  assert.equal(r.confidence, 72 + ML_SIGNAL_BOOST - ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY); // 74
});

test("Path B: WM agreeing with direction adds CONFIDENCE_BOOST_PER_SIGNAL on top of penalty", () => {
  // 70+6−4+8=80
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 70,
    claudeAbove: true, claudeConfidence: 62,
    statAbove: false, statConfidence: 58,
    wmDriftAbove: true, wmRec: "bet", wmReady: true,
    minConfidence: 60,
  }));
  assert.equal(r.confidence, 70 + ML_SIGNAL_BOOST - ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY + CONFIDENCE_BOOST_PER_SIGNAL); // 80
});

test("Path B: reasoning mentions Stat dissent", () => {
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 70,
    claudeAbove: true, claudeConfidence: 62,
    statAbove: false, statConfidence: 58,
    minConfidence: 60,
  }));
  assert.match(r.reasoning, /Stat dissent|dissent/i);
});

test("Path B: penalized confidence below minConfidence → SKIP", () => {
  // 70+6−4=72, minConfidence=75 → SKIP
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 70,
    claudeAbove: true, claudeConfidence: 62,
    statAbove: false, statConfidence: 58,
    minConfidence: 75,
  }));
  assert.equal(r.action, "SKIP");
});

// ---------------------------------------------------------------------------
// PIPELINE: Gate 3D — ML+Stat agree, Claude disagrees → always SKIP
// ---------------------------------------------------------------------------

test("Path D: ML=YES + Stat=YES, Claude=NO → SKIP (Claude opposition overrides)", () => {
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 60,
    claudeAbove: false, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70,
    minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /disagree|Claude.*disagree|opposition/i);
});

test("Path D: ML=NO + Stat=NO, Claude=YES → SKIP", () => {
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 60,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: false, mlConfidence: 70,
    minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
});

test("Path D: ML=YES + Stat=YES, Claude=NO even with very high ML confidence → still SKIP", () => {
  // ML at 90% cannot override Claude's opposition in Path D — hard block.
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 60,
    claudeAbove: false, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 90,
    minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
});

// ---------------------------------------------------------------------------
// No signals / all null
// ---------------------------------------------------------------------------

test("No signals at all (all null) → SKIP — Pipeline gate fires on Stat first", () => {
  const r = computeCorePairDecision(inp());
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Pipeline/);
});

test("ML+WM agree but stat/claude null → SKIP — Pipeline gate fires", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 65, wmDriftAbove: true }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Pipeline/);
});

test("Only stat present (no claude, no ML) → SKIP — Gate 1 fires on Claude", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, statConfidence: 60 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Pipeline.*Claude/i);
});

test("Stat+ML agree but claude null → SKIP — Gate 1 fires on Claude (no bypass)", () => {
  // Previously this was the fast-agreement path. Now it always waits for Claude.
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 60,
    mlAbove: true, mlConfidence: 70,
    claudeAbove: null,
  }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Pipeline.*Claude/i);
});

test("ML+WM agree but mlConfidence null → SKIP (Gate 1 stat/claude check fires first)", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, wmDriftAbove: true }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Pipeline/);
});
test("No Kalshi ticker → SKIP", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, kalshiTicker: null }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /No active Kalshi market/);
});

// ---------------------------------------------------------------------------
// EV gate — direction-aware (YES and NO on equal footing)
// Gate runs AFTER direction is decided; each side uses its own payoff formula:
//   BET_YES: EV = acc*(1−p)/p − (1−acc)
//   BET_NO:  EV = acc*p/(1−p) − (1−acc)
// All EV tests provide all three signals so pipeline Gates 1-3 pass first.
// ---------------------------------------------------------------------------

const evYes = (extra: Partial<CorePairInputs> = {}) => inp({
  statAbove: true, statConfidence: 58,
  claudeAbove: true, claudeConfidence: 62,
  mlAbove: true, mlConfidence: 70,
  ...extra,
});
const evNo = (extra: Partial<CorePairInputs> = {}) => inp({
  statAbove: false, statConfidence: 58,
  claudeAbove: false, claudeConfidence: 62,
  mlAbove: false, mlConfidence: 70,
  ...extra,
});

test("Negative EV fires when signalAccuracyPct is low (40% at 50¢ YES)", () => {
  // BET_YES: EV = 0.40*(0.50/0.50) − 0.60 = −0.20 < −0.05
  const r = computeCorePairDecision(evYes({ yesPrice: 0.50, signalAccuracyPct: 40 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Negative EV/);
});

test("Negative EV fires at 45% accuracy at 50¢ YES (borderline)", () => {
  // BET_YES: EV = 0.45*1 − 0.55 = −0.10 < −0.05
  const r = computeCorePairDecision(evYes({ yesPrice: 0.50, signalAccuracyPct: 45 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Negative EV/);
});

test("EV gate passes when signalAccuracyPct is 60% at 50¢ YES", () => {
  // BET_YES: EV = 0.60*1 − 0.40 = +0.20 ≥ −0.05 → proceeds
  const r = computeCorePairDecision(evYes({ yesPrice: 0.50, signalAccuracyPct: 60 }));
  assert.equal(r.action, "BET_YES");
});

test("EV gate skipped when signalAccuracyPct is null (no history yet)", () => {
  // null acc → dirEV=null → gate doesn't fire
  const r = computeCorePairDecision(evYes({ signalAccuracyPct: null }));
  assert.equal(r.action, "BET_YES");
});

test("EV gate symmetry: expensive NO (low yes_price) blocked just like bad YES", () => {
  // BET_NO at yes=0.08 (NO costs 0.92): EV = 0.40*(0.08/0.92) − 0.60 = −0.565 < −0.05
  const r = computeCorePairDecision(evNo({ yesPrice: 0.08, signalAccuracyPct: 40 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Negative EV/);
});

test("EV gate symmetry: cheap NO (high yes_price) passes despite low acc", () => {
  // BET_NO at yes=0.92 (NO costs 0.08): EV = 0.40*(0.92/0.08) − 0.60 = +4.0 ≥ −0.05
  const r = computeCorePairDecision(evNo({ yesPrice: 0.92, signalAccuracyPct: 40 }));
  assert.equal(r.action, "BET_NO");
});

test("EV gate: 50¢ market is identical for YES and NO at same accuracy", () => {
  // Both directions at 50¢ with 40% acc: EV = 0.40*1 − 0.60 = −0.20 → both block
  const rYes = computeCorePairDecision(evYes({ yesPrice: 0.50, signalAccuracyPct: 40 }));
  const rNo  = computeCorePairDecision(evNo ({ yesPrice: 0.50, signalAccuracyPct: 40 }));
  assert.equal(rYes.action, "SKIP");
  assert.equal(rNo.action,  "SKIP");
  assert.ok(rYes.ev != null && rNo.ev != null && Math.abs(rYes.ev - rNo.ev) < 0.001, "EV symmetric at 50¢");
});

// ---------------------------------------------------------------------------
// Reversing-caution arithmetic (Phase 3 penalty applied externally)
// ---------------------------------------------------------------------------

test("Low-conviction: unanimous at ML=70 → 70+6+4=80, 80−21=59 < minConfidence(61) → Phase 3 skips", () => {
  // ML at ML_LEAD_MIN_CONF (70) — the practical minimum for non-trivial entries.
  // Unanimous → 70+6+4=80 (Path A). Phase 3 applies an external penalty; here we verify
  // the confidence value for the caller.  With a 21pp penalty: 80−21=59 < 61 → Phase 3 SKIP.
  const r = computeCorePairDecision(inp({
    statAbove: true, statConfidence: 58,
    claudeAbove: true, claudeConfidence: 62,
    mlAbove: true, mlConfidence: 70, // ML_LEAD_MIN_CONF
    minConfidence: 60, // normal gate — bet passes here; penalty applied outside
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 70 + ML_SIGNAL_BOOST + STAT_AGREE_BOOST); // 80
  assert.ok(r.confidence - 21 < 61, "penalized confidence (59) falls below a raised gate (61)");
});

test("High-conviction: ML+Claude+Stat+WM all agree → 70+6+4+8=88 → 88−20=68 ≥ 60 → Phase 3 allows", () => {
  // ML at 70 plus WM: 70+6+4+8=88 (Path A + WM). Phase 3 −20 → 68 ≥ 60 → passes.
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 70, // ML_LEAD_MIN_CONF
    claudeAbove: true, claudeConfidence: 62,
    statAbove: true, statConfidence: 58,
    wmDriftAbove: true, wmRec: "bet", wmReady: true,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 70 + ML_SIGNAL_BOOST + STAT_AGREE_BOOST + CONFIDENCE_BOOST_PER_SIGNAL); // 88
  assert.ok(r.confidence - 20 >= DEFAULT_MIN_CONFIDENCE, "penalized confidence (68) still clears gate (60)");
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

// Helpers for min-return-gate tests: provide all three signals so pipeline
// Gates 1-3 pass before the min-return gate is reached.
// Use minimum passing values: stat=58, claude=62, ml=70.
const mrNo  = (extra: Partial<CorePairInputs> = {}) => inp({
  statAbove: false, statConfidence: 58,
  claudeAbove: false, claudeConfidence: 62,
  mlAbove: false, mlConfidence: 70,
  ...extra,
});
const mrYes = (extra: Partial<CorePairInputs> = {}) => inp({
  statAbove: true, statConfidence: 58,
  claudeAbove: true, claudeConfidence: 62,
  mlAbove: true, mlConfidence: 70,
  ...extra,
});

test("min-return gate: off (undefined) allows deep-ITM BET_NO", () => {
  // yesPrice 0.08 → NO cost 0.92 → return ~1.09x. No gate → bet proceeds.
  const r = computeCorePairDecision(mrNo({ yesPrice: 0.08 }));
  assert.equal(r.action, "BET_NO");
});

test("min-return gate: 1.44x skips deep-ITM BET_NO (cost 92c, ret 1.09x)", () => {
  const r = computeCorePairDecision(mrNo({ yesPrice: 0.08, minReturnMultiple: 1.44 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Return 1\.09x below minimum 1\.44x/);
});

test("min-return gate: 1.44x skips deep-ITM BET_YES (cost 92c)", () => {
  const r = computeCorePairDecision(mrYes({ yesPrice: 0.92, minReturnMultiple: 1.44 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /below minimum 1\.44x/);
});

test("min-return gate: 1.44x allows a cheap bet (cost 50c, ret 2x)", () => {
  const r = computeCorePairDecision(mrNo({ yesPrice: 0.50, minReturnMultiple: 1.44 }));
  assert.equal(r.action, "BET_NO");
});

test("min-return gate: return exactly at threshold passes (2x floor, 2x bet)", () => {
  // yesPrice 0.50 → NO cost 0.50 → return exactly 2.0x → allowed.
  const r = computeCorePairDecision(mrNo({ yesPrice: 0.50, minReturnMultiple: 2.0 }));
  assert.equal(r.action, "BET_NO");
});

test("min-return gate: floor of 1 is treated as off", () => {
  const r = computeCorePairDecision(mrNo({ yesPrice: 0.08, minReturnMultiple: 1 }));
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
// checkFastAgreementEntry — early-entry predicate that bypasses the Claude-
// pending guard when Stat and ML agree with sufficient confidence. This is
// what allows the bot to enter during minutes 1-3 of a window (the only time
// trending-window prices are still bettable) without waiting for Claude's
// 30-120s extended-thinking call.
// ---------------------------------------------------------------------------

test("fastAgreement: stat+ML agree bearish, ML confident → true (NO bets can fire early)", () => {
  assert.equal(checkFastAgreementEntry(false, false, null, 65), true);
});

test("fastAgreement: stat+ML agree bullish, stat confident → true", () => {
  assert.equal(checkFastAgreementEntry(true, true, 62, 55), true);
});

test("fastAgreement: stat+ML agree but BOTH below confidence floor → false", () => {
  assert.equal(checkFastAgreementEntry(true, true, 55, 58), false);
});

test("fastAgreement: stat+ML disagree → false regardless of confidence", () => {
  assert.equal(checkFastAgreementEntry(true, false, 90, 90), false);
});

test("fastAgreement: stat null → false (needs BOTH signals present)", () => {
  assert.equal(checkFastAgreementEntry(null, true, null, 90), false);
});

test("fastAgreement: ML null → false (needs BOTH signals present)", () => {
  assert.equal(checkFastAgreementEntry(false, null, 90, null), false);
});

test("fastAgreement: null confidences are treated as 0, not confident", () => {
  assert.equal(checkFastAgreementEntry(true, true, null, null), false);
});

test("fastAgreement: exactly at the 60 threshold → true (inclusive)", () => {
  assert.equal(checkFastAgreementEntry(false, false, null, 60), true);
  assert.equal(checkFastAgreementEntry(false, false, 60, null), true);
});

test("fastAgreement: custom minConf is respected", () => {
  assert.equal(checkFastAgreementEntry(true, true, null, 62, 65), false);
  assert.equal(checkFastAgreementEntry(true, true, null, 66, 65), true);
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

// ---------------------------------------------------------------------------
// Stat flip downstream effect on computeCorePairDecision
//
// These tests verify that when the stat signal changes direction mid-window,
// computeCorePairDecision correctly handles the updated signals fed to it.
// ---------------------------------------------------------------------------

test("stat flip downstream: flip above→below + Claude=below + ML=below → BET_NO (all three agree on new direction)", () => {
  // Opening: stat=above.  Mid-snap flips stat to below.  Claude and ML also say below.
  // All three models agree on below after the flip → unanimous BET_NO (Path A).
  const r = computeCorePairDecision(inp({
    statAbove: false, statConfidence: 58,
    claudeAbove: false, claudeConfidence: 62,
    mlAbove: false, mlConfidence: 70,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_NO", "agreed-below after flip must bet NO, not SKIP");
});

test("stat flip downstream: flip + Claude=above, ML=null → SKIP (Gate 1: pipeline waits for ML)", () => {
  // Stat has flipped to below but Claude still says above.  ML not yet available.
  // Pipeline Gate 1 fires: ML direction missing → SKIP regardless of other signals.
  const r = computeCorePairDecision(inp({
    claudeAbove: true, claudeConfidence: 62,
    statAbove: false, statConfidence: 58,
    mlAbove: null,
  }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Pipeline.*ML/i);
});

test("stat flip downstream: flip + Claude=YES + ML=YES → BET_YES (Path B: ML+Claude agree, Stat dissents)", () => {
  // Stat has flipped to below (NO), but Claude and ML both say above (YES).
  // New pipeline Path B: ML+Claude agree → BET_YES with Stat-dissent penalty.
  // Confidence = mlConf + ML_SIGNAL_BOOST − ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY = 70+6−4=72
  const r = computeCorePairDecision(inp({
    claudeAbove: true, claudeConfidence: 62,
    statAbove: false, statConfidence: 58,
    mlAbove: true, mlConfidence: 70,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_YES", "ML+Claude agree YES; stat dissents → Path B bet, not SKIP");
  assert.equal(r.confidence, 70 + ML_SIGNAL_BOOST - ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY); // 72
});

test("stat flip downstream: no flip (stat stays above) + Claude=above + ML=above → BET_YES unchanged", () => {
  // Sanity check: when stat does NOT flip, all three agree above → unanimous BET_YES (Path A).
  const r = computeCorePairDecision(inp({
    claudeAbove: true, claudeConfidence: 62,
    statAbove: true, statConfidence: 58,
    mlAbove: true, mlConfidence: 70,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 70 + ML_SIGNAL_BOOST + STAT_AGREE_BOOST); // 80
});

test("stat flip downstream: flip above→below + ML=YES + Claude=YES → BET_YES (Path B with minimum inputs)", () => {
  // When stat flips to NO but ML+Claude agree YES — Path B fires (not a SKIP).
  // This is the central behavior change from the prior pipeline:
  // the old pipeline SKIPped here (stat≠claude); the new pipeline BETs with a penalty.
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 70,
    claudeAbove: true, claudeConfidence: 62,
    statAbove: false, statConfidence: 58,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_YES", "ML+Claude agree YES (Path B) — bets despite stat flip");
  assert.equal(r.confidence, 70 + ML_SIGNAL_BOOST - ML_CLAUDE_AGREE_STAT_DISSENT_PENALTY); // 72
});

// ---------------------------------------------------------------------------
// checkSignalDivergenceCutout — pure divergence cutout logic
// ---------------------------------------------------------------------------

import {
  checkSignalDivergenceCutout,
  DIVERGENCE_MAX_MINUTES,
  DIVERGENCE_MIN_SIGNALS_FLIPPED,
  DIVERGENCE_PRICE_FLOOR_MULT,
} from "./kalshi-bot-engine-core.ts";

const defaultEntry = { statAbove: true, claudeAbove: true, mlAbove: true };
const ENTRY_PRICE = 0.60;

test("divergence: all three signals flip for YES bet → triggered", () => {
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: true, claudeAbove: true, mlAbove: true },
    false, false, false,
  );
  assert.equal(r.triggered, true);
  assert.match(r.reason, /Signal divergence/);
  assert.match(r.reason, /stat/);
  assert.match(r.reason, /claude/);
  assert.match(r.reason, /ml/);
});

test("divergence: exactly 2 signals flip → triggered", () => {
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: true, claudeAbove: true, mlAbove: true },
    false, false, true,
  );
  assert.equal(r.triggered, true);
});

test("divergence: only 1 signal flips → not triggered", () => {
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: true, claudeAbove: true, mlAbove: true },
    false, true, true,
  );
  assert.equal(r.triggered, false);
  assert.match(r.reason, /1\/2 signals flipped/);
});

test("divergence: minutesElapsed >= DIVERGENCE_MAX_MINUTES → not triggered", () => {
  const r = checkSignalDivergenceCutout(
    "yes", DIVERGENCE_MAX_MINUTES, 0.40, ENTRY_PRICE,
    defaultEntry, false, false, false,
  );
  assert.equal(r.triggered, false);
  assert.match(r.reason, /beyond early window/);
});

test("divergence: price below floor → not triggered even if signals flipped", () => {
  const floorPrice = ENTRY_PRICE * DIVERGENCE_PRICE_FLOOR_MULT - 0.01; // just below floor
  const r = checkSignalDivergenceCutout(
    "yes", 3, floorPrice, ENTRY_PRICE,
    defaultEntry, false, false, false,
  );
  assert.equal(r.triggered, false);
  assert.match(r.reason, /not enough value to exit/);
});

test("divergence: price at exactly floor → triggered (≥ floor means allowed to exit)", () => {
  const floorPrice = ENTRY_PRICE * DIVERGENCE_PRICE_FLOOR_MULT;
  const r = checkSignalDivergenceCutout(
    "yes", 3, floorPrice, ENTRY_PRICE,
    defaultEntry, false, false, false,
  );
  assert.equal(r.triggered, true, "at exactly floor contract value (not strictly below), exit is allowed");
});

test("divergence: price just above floor → triggered when signals flipped", () => {
  const aboveFloor = ENTRY_PRICE * DIVERGENCE_PRICE_FLOOR_MULT + 0.01;
  const r = checkSignalDivergenceCutout(
    "yes", 3, aboveFloor, ENTRY_PRICE,
    defaultEntry, false, false, false,
  );
  assert.equal(r.triggered, true);
});

test("divergence: null entry signal is ignored (cannot flip)", () => {
  // statAbove=null at entry → stat cannot count as flipped
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: null, claudeAbove: true, mlAbove: true },
    false, false, false,
  );
  // Only claude + ml flip (2) → triggered
  assert.equal(r.triggered, true);
});

test("divergence: null current signal is ignored (unknown state)", () => {
  // claudeAbove currently null → cannot assess, ignore
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: true, claudeAbove: true, mlAbove: true },
    false, null, false,
  );
  // stat + ml flip (2) → triggered
  assert.equal(r.triggered, true);
});

test("divergence: all entry signals null → nothing can flip → not triggered", () => {
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: null, claudeAbove: null, mlAbove: null },
    false, false, false,
  );
  assert.equal(r.triggered, false);
});

test("divergence: NO bet — signals flip when entry was false and now true", () => {
  const r = checkSignalDivergenceCutout(
    "no", 3, 0.65, 0.35, // NO entry: yesPrice=0.35 → NO contract cost = 1-0.35 = 0.65
    { statAbove: false, claudeAbove: false, mlAbove: false },
    true, true, false,
  );
  // stat + claude flipped (were false, now true, against NO bet) → triggered
  assert.equal(r.triggered, true);
  assert.match(r.reason, /stat/);
  assert.match(r.reason, /claude/);
});

test("divergence: NO bet price floor uses NO contract value (1 - yesPrice)", () => {
  // NO entry: entryYesPrice = 0.30 → NO contract value = 0.70
  // floor = 0.70 * 0.50 = 0.35 (in NO terms)
  // If yesPrice is now 0.68 → NO value = 0.32 < 0.35 → below floor
  const r = checkSignalDivergenceCutout(
    "no", 3, 0.68, 0.30,
    { statAbove: false, claudeAbove: false, mlAbove: false },
    true, true, true,
  );
  assert.equal(r.triggered, false, "NO contract value below floor — should not trigger");
});

test("divergence: signal that was FOR bet and stays FOR bet → no flip counted", () => {
  // Stat stays supporting the YES bet (was true, still true)
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.50, ENTRY_PRICE,
    { statAbove: true, claudeAbove: true, mlAbove: true },
    true, false, false,
  );
  // Only claude + ml flipped → 2/2 → triggered
  assert.equal(r.triggered, true);
});

test("divergence: signal that was AGAINST bet at entry cannot flip (only supporting signals can flip)", () => {
  // Entry: statAbove=false for YES bet (was opposing already) — cannot flip against
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.50, ENTRY_PRICE,
    { statAbove: false, claudeAbove: true, mlAbove: true },
    false, false, false,
  );
  // stat was already against (entry false) → not counted; only claude+ml flipped → 2
  assert.equal(r.triggered, true);
  assert.match(r.reason, /claude/);
  assert.match(r.reason, /ml/);
});

test("divergence: currentYesPrice=null → not triggered (cannot verify price floor, must hold)", () => {
  const r = checkSignalDivergenceCutout(
    "yes", 3, null, ENTRY_PRICE,
    defaultEntry, false, false, false,
  );
  assert.equal(r.triggered, false, "null price → price floor unverifiable → hold, do not exit");
  assert.match(r.reason, /unavailable/);
});

