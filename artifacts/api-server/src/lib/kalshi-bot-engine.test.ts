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
  computeMLGateDecision,
  computeConvictionDecision,
  CLAUDE_BOOST,
  CLAUDE_PENALTY,
  STAT_BOOST,
  STAT_PENALTY,
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
  applyLockPrice090Migration,
  applyLockPrice093Bootstrap,
  applyLockPrice092Bootstrap,
  applyLockPrice082Migration,
  deriveConvictionZone,
  computeStrikeProximityGate,
  checkConvictionOneSidedBook,
  shouldSuppressConvictionStopLoss,
  type BotConfig,
  type CorePairInputs,
  type CircuitBreakerState,
  type ConvictionInputs,
  computeAdverseMomentumGate,
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

test("EV gate: 50¢ YES passes when composite is high (signalAccuracyPct no longer drives EV)", () => {
  // EV now uses composite confidence (80%) not signalAccuracyPct (40%).
  // At 50¢ with composite=80%: EV = 0.80*1 − 0.20 = +0.60 → passes gate.
  const r = computeCorePairDecision(evYes({ yesPrice: 0.50, signalAccuracyPct: 40 }));
  assert.equal(r.action, "BET_YES");
});

test("EV gate: 50¢ YES passes even at borderline composite (stale acc no longer used)", () => {
  // Composite (80%) is the accuracy estimate; 50¢ YES has positive EV at any composite ≥ 50%.
  const r = computeCorePairDecision(evYes({ yesPrice: 0.50, signalAccuracyPct: 45 }));
  assert.equal(r.action, "BET_YES");
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

test("Min-return gate blocks expensive NO (low yes_price) before EV even runs", () => {
  // BET_NO at yes=0.08 → NO cost = 0.92 → return = 1.09× < 1.45 floor → min-return blocks first.
  const r = computeCorePairDecision(evNo({ yesPrice: 0.08, signalAccuracyPct: 40, minReturnMultiple: 1.45 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /below minimum/);
});

test("EV gate symmetry: cheap NO (high yes_price) passes despite low acc", () => {
  // BET_NO at yes=0.92 (NO costs 0.08): EV = 0.40*(0.92/0.08) − 0.60 = +4.0 ≥ −0.05
  const r = computeCorePairDecision(evNo({ yesPrice: 0.92, signalAccuracyPct: 40 }));
  assert.equal(r.action, "BET_NO");
});

test("EV gate: 50¢ market — both YES and NO pass when composite is high", () => {
  // EV now uses composite (80%), not signalAccuracyPct (40%).
  // At 50¢ with composite=80%: EV = 0.80*1 − 0.20 = +0.60 → both sides pass.
  const rYes = computeCorePairDecision(evYes({ yesPrice: 0.50, signalAccuracyPct: 40 }));
  const rNo  = computeCorePairDecision(evNo ({ yesPrice: 0.50, signalAccuracyPct: 40 }));
  assert.equal(rYes.action, "BET_YES");
  assert.equal(rNo.action,  "BET_NO");
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


// ---------------------------------------------------------------------------
// ML GATE: simplified three-tier formula (computeMLGateDecision)
//   ML = primary direction setter, Claude = confidence modifier (±CLAUDE_BOOST/PENALTY)
//   Stat = confidence modifier (±STAT_BOOST/STAT_PENALTY).  No hard veto.
//   confidence = mlConf + (Claude agrees ? +CLAUDE_BOOST : −CLAUDE_PENALTY)
//                       + (Stat agrees   ? +STAT_BOOST   : −STAT_PENALTY)
// ---------------------------------------------------------------------------

function mlGateInp(overrides: Partial<CorePairInputs> = {}): CorePairInputs {
  // Default: all YES; mlConf=70 so partial agreements still clear the 65 floor.
  return inp({
    statAbove: true, claudeAbove: true, mlAbove: true,
    statConfidence: 55, claudeConfidence: 60, mlConfidence: 70,
    minConfidence: 65,
    ...overrides,
  });
}

// Gate 1 — all three required
test("mlGate: missing Stat → SKIP waiting", () => {
  const r = computeMLGateDecision(mlGateInp({ statAbove: null }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /waiting for Stat/);
});

test("mlGate: missing Claude → SKIP waiting", () => {
  const r = computeMLGateDecision(mlGateInp({ claudeAbove: null }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /waiting for Claude/);
});

test("mlGate: missing ML → SKIP waiting", () => {
  const r = computeMLGateDecision(mlGateInp({ mlAbove: null }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /waiting for ML/);
});

test("mlGate: no kalshiTicker → SKIP", () => {
  const r = computeMLGateDecision(mlGateInp({ kalshiTicker: null }));
  assert.equal(r.action, "SKIP");
});

// ── New weighted-blend formula ────────────────────────────────────────────────
// Default: mlConf=70, claudeConf=60, statConf=55, all YES agree, minConf=65
//   mlContrib  = round(70 × 0.60) = 42
//   clContrib  = round(60 × 0.40) = 24
//   composite  = 42 + 24 + 4 = 70

// Direction: ML leads — all YES agree
test("mlGate row1: all YES → BET_YES; composite = round(70×0.6)+round(60×0.4)+4 = 70", () => {
  const r = computeMLGateDecision(mlGateInp());
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 42 + 24 + 4); // 70
});

// Claude disagrees with ML direction → immediate direction veto (no bet, no penalty math)
test("mlGate row2: ML YES, Claude disagrees → SKIP direction veto", () => {
  const r = computeMLGateDecision(mlGateInp({ claudeAbove: false }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /direction veto/);
});

// Claude agrees, Stat dissents → statMod = -4; composite = 42+24-4 = 62 < 65
test("mlGate row3: ML YES, Claude YES, Stat dissents → SKIP below minimum (62 < 65)", () => {
  const r = computeMLGateDecision(mlGateInp({ statAbove: false }));
  assert.equal(r.action, "SKIP");
  assert.equal(r.confidence, 42 + 24 - 4); // 62
  assert.match(r.reasoning, /below minimum/);
});

// Claude disagrees takes priority over Stat — direction veto fires first
test("mlGate row4: ML YES, Claude dissents, Stat dissents → SKIP direction veto", () => {
  const r = computeMLGateDecision(mlGateInp({ claudeAbove: false, statAbove: false }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /direction veto/);
});

// ML NO; all NO agree — same weighted math, direction NO
test("mlGate row5: all NO → BET_NO; composite = round(70×0.6)+round(60×0.4)+4 = 70", () => {
  const r = computeMLGateDecision(mlGateInp({ statAbove: false, claudeAbove: false, mlAbove: false }));
  assert.equal(r.action, "BET_NO");
  assert.equal(r.confidence, 42 + 24 + 4); // 70
});

// ML NO; Claude says YES (disagrees with NO direction) → direction veto
test("mlGate row6: ML NO, Claude disagrees (YES) → SKIP direction veto", () => {
  const r = computeMLGateDecision(mlGateInp({ claudeAbove: true, statAbove: false, mlAbove: false }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /direction veto/);
});

// ML NO; Claude agrees (NO), Stat says YES (dissents) → statMod=-4; 42+24-4=62 < 65
test("mlGate row7: ML NO, Claude NO, Stat dissents (YES) → SKIP below minimum (62 < 65)", () => {
  const r = computeMLGateDecision(mlGateInp({ claudeAbove: false, statAbove: true, mlAbove: false }));
  assert.equal(r.action, "SKIP");
  assert.equal(r.confidence, 42 + 24 - 4); // 62
  assert.match(r.reasoning, /below minimum/);
});

// ML NO but default claudeAbove=true → Claude disagrees → direction veto
test("mlGate row8: ML NO, Claude+Stat both YES → SKIP direction veto", () => {
  const r = computeMLGateDecision(mlGateInp({ mlAbove: false }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /direction veto/);
});

// Composite gate — must clear minConfidence
test("mlGate: composite below minConfidence → SKIP; mlConf=60,clConf=60 → 36+24+4=64 < 75", () => {
  // round(60×0.6)=36; round(60×0.4)=24; +4 stat = 64 < 75
  const r = computeMLGateDecision(mlGateInp({ mlConfidence: 60, minConfidence: 75 }));
  assert.equal(r.action, "SKIP");
  assert.equal(r.confidence, 36 + 24 + 4); // 64
  assert.match(r.reasoning, /below minimum/);
});

test("mlGate: composite exactly at minConfidence → BET (>= inclusive)", () => {
  // round(75×0.6)=45; round(40×0.4)=16; +4 stat = 65 = minConfidence
  const r = computeMLGateDecision(mlGateInp({ mlConfidence: 75, claudeConfidence: 40, minConfidence: 65 }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 65);
});

// statConfidence magnitude does not affect composite — only statAbove direction matters
test("mlGate: statConfidence magnitude irrelevant — only direction matters for stat modifier", () => {
  // statConf=10 but statAbove=true (agrees); same composite as default statConf=55
  const r = computeMLGateDecision(mlGateInp({ statConfidence: 10 }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 42 + 24 + 4); // 70 — identical to row1
});

// Post-decision gates still apply
test("mlGate: EV gate blocks negative-EV YES bet", () => {
  // yesPrice 0.90, acc 50% → EV = 0.5*(0.1/0.9) - 0.5 ≈ -0.444 < -0.05 floor
  const r = computeMLGateDecision(mlGateInp({ yesPrice: 0.90, signalAccuracyPct: 50 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Negative EV/);
});

test("mlGate: min-return gate blocks deep ITM YES bet", () => {
  const r = computeMLGateDecision(mlGateInp({ yesPrice: 0.92, minReturnMultiple: 1.45 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /below minimum/);
});

// ---------------------------------------------------------------------------
// CONVICTION MODE: computeConvictionDecision — pure reactive FOK decision core
//
// Invariants verified here:
//   1. BET_YES fires when yesPrice ≥ lockPrice
//   2. BET_NO fires when yesPrice ≤ (1 − lockPrice)
//   3. SKIP fires otherwise (price not yet at threshold)
//   4. No model veto — price alone determines direction
// ---------------------------------------------------------------------------

// cvInp defaults match production conviction config: trigger=88%, cap=92%
// yesBid defaults to yesPrice to model a tight spread (realistic mid ≈ bid).
// Tests that need yesBid=null (one-sided book) must pass it explicitly.
function cvInp(overrides: Partial<ConvictionInputs> = {}): ConvictionInputs {
  const yesPrice = overrides.yesPrice ?? 0.85;
  return {
    yesPrice,
    yesBid:        yesPrice,  // tight-spread default: bid mirrors mid
    lockPrice:     0.88,
    lockPriceCap:  0.92,
    minConfidence: 70,
    ...overrides,
  };
}

// ── YES direction — within the 88–92% entry window ───────────────────────────

test("conviction: yesPrice exactly at lockPrice (0.88) → BET_YES", () => {
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.88, minConfidence: 0 }));
  assert.equal(r.action, "BET_YES");
});

test("conviction: yesPrice inside window (0.90) → BET_YES", () => {
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.90, minConfidence: 0 }));
  assert.equal(r.action, "BET_YES");
});

test("conviction: yesPrice exactly at cap (0.92) → BET_YES (inclusive)", () => {
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.92, minConfidence: 0 }));
  assert.equal(r.action, "BET_YES");
});

// ── YES direction — past the cap → SKIP (cap strictly enforced, no extreme bypass) ──

test("conviction: yesPrice above cap (0.95) → SKIP (past the 91% cap)", () => {
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.95, minConfidence: 0 }));
  assert.equal(r.action, "SKIP");
});

test("conviction: yesPrice at 0.99 → SKIP (past the 91% cap)", () => {
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.99, minConfidence: 0 }));
  assert.equal(r.action, "SKIP");
});

// ── NO direction — within the 88–92% entry window ────────────────────────────

test("conviction: yesPrice exactly at NO trigger (0.12) → BET_NO", () => {
  // NO price = 1 - 0.12 = 88% — exactly at the trigger
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.12, minConfidence: 0 }));
  assert.equal(r.action, "BET_NO");
});

test("conviction: yesPrice inside NO window (0.09) → BET_NO", () => {
  // NO price = 91%
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.09, minConfidence: 0 }));
  assert.equal(r.action, "BET_NO");
});

test("conviction: yesPrice at NO cap boundary (0.08) → BET_NO (inclusive)", () => {
  // NO price = 92% — exactly at the cap
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.08, minConfidence: 0 }));
  assert.equal(r.action, "BET_NO");
});

// ── NO direction — past the cap → SKIP (cap strictly enforced, no extreme bypass) ──

test("conviction: yesPrice below NO cap (0.05) → SKIP (past the 91% NO cap)", () => {
  // yesPrice=0.05 → NO price=95% — above the 91% cap, entry window missed
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.05, minConfidence: 0 }));
  assert.equal(r.action, "SKIP");
});

test("conviction: yesPrice at 0.01 → SKIP (past the 91% NO cap)", () => {
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.01, minConfidence: 0 }));
  assert.equal(r.action, "SKIP");
});

// ── NO direction — yesBid=null (one-sided book) ───────────────────────────────

test("conviction: yesPrice in NO zone but yesBid=null → SKIP (no counterparty)", () => {
  // When yesBid is null there is no YES buyer → no NO counterparty → noTrigger=null
  // The engine must SKIP, not dispatch BET_NO using the mid-price fallback.
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.09, yesBid: null, minConfidence: 0 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /no-bid|null/);
});

test("conviction: yesPrice at extreme (0.01) but yesBid=null → SKIP", () => {
  // Extreme-price bypass does not override the yesBid=null guard
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.01, yesBid: null, minConfidence: 0 }));
  assert.equal(r.action, "SKIP");
});

// ── SKIP (not yet at threshold) ───────────────────────────────────────────────

test("conviction: yesPrice below lockPrice → SKIP", () => {
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.85 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /lock threshold/);
});

test("conviction: yesPrice in mid-zone (0.50) → SKIP", () => {
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.50 }));
  assert.equal(r.action, "SKIP");
});

test("conviction: yesPrice null → SKIP", () => {
  const r = computeConvictionDecision(cvInp({ yesPrice: null }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /unavailable/);
});

// ── Confidence formula ────────────────────────────────────────────────────────

test("conviction: BET_YES confidence = min(round(50 + lockedPrice*50), 95)", () => {
  // yesPrice=0.90 → lockedPrice=0.90 → round(50+45)=95 → capped 95
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.90, minConfidence: 0 }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 95);
});

test("conviction: confidence below minConfidence → SKIP with confidence preserved", () => {
  // yesPrice=0.90 → confidence=95; set minConfidence=100 → SKIP
  const r = computeConvictionDecision(cvInp({ yesPrice: 0.90, minConfidence: 100 }));
  assert.equal(r.action, "SKIP");
  assert.equal(r.confidence, 95);
  assert.match(r.reasoning, /below minimum/);
});

// ── Proximity guard bypass (pure condition) ───────────────────────────────────
// The proximity guard in kalshi-bot-tick.ts is bypassed when
// decisionMode === "conviction" AND yesPrice is at the extreme threshold
// (≥ 0.92 or ≤ 0.08).  This mirrors the minWindowEntryMinutes bypass.
// We test the bypass condition as a pure expression to keep the test free of
// I/O dependencies while still locking in the exact semantics.

function proximityBypass(decisionMode: string, yesPrice: number | null): boolean {
  return (
    decisionMode === "conviction" &&
    yesPrice !== null &&
    (yesPrice >= 0.92 || yesPrice <= 0.08)
  );
}

test("proximity guard bypass: conviction + extreme YES price (≥ 0.92) → bypass", () => {
  assert.equal(proximityBypass("conviction", 0.92), true);
  assert.equal(proximityBypass("conviction", 0.95), true);
  assert.equal(proximityBypass("conviction", 1.00), true);
});

test("proximity guard bypass: conviction + extreme NO price (≤ 0.08) → bypass", () => {
  assert.equal(proximityBypass("conviction", 0.08), true);
  assert.equal(proximityBypass("conviction", 0.05), true);
  assert.equal(proximityBypass("conviction", 0.00), true);
});

test("proximity guard bypass: conviction + non-extreme price → no bypass", () => {
  assert.equal(proximityBypass("conviction", 0.50), false);
  assert.equal(proximityBypass("conviction", 0.91), false); // just below YES threshold
  assert.equal(proximityBypass("conviction", 0.09), false); // just above NO threshold
});

test("proximity guard bypass: non-conviction modes → no bypass even at extreme prices", () => {
  assert.equal(proximityBypass("classic",          0.92), false);
  assert.equal(proximityBypass("ml_gate",          0.08), false);
  assert.equal(proximityBypass("consensus",        0.95), false);
  assert.equal(proximityBypass("unanimous",        0.05), false);

});

test("proximity guard bypass: conviction + null yesPrice → no bypass", () => {
  assert.equal(proximityBypass("conviction", null), false);
});

// ---------------------------------------------------------------------------
// applyLockPrice090Migration — one-time conviction lock-price migration
// ---------------------------------------------------------------------------

function migCfg(overrides: Partial<BotConfig> = {}): BotConfig {
  return { ...DEFAULT_BOT_CONFIG, ...overrides };
}

test("lockPrice migration: conviction + null lockPrice → backfilled to 0.90 with flag", () => {
  const cfg = migCfg({ decisionMode: "conviction", kalshiLockPrice: undefined, lockPrice090Migrated: undefined });
  const res = applyLockPrice090Migration(cfg);
  assert.equal(res.changed, true);
  assert.equal(res.migrated, false);
  assert.equal(cfg.kalshiLockPrice, 0.90);
  assert.equal(cfg.lockPrice090Migrated, true);
});

test("lockPrice migration: legacy 0.91 without flag → migrated to 0.90 once", () => {
  const cfg = migCfg({ decisionMode: "conviction", kalshiLockPrice: 0.91, lockPrice090Migrated: undefined });
  const res = applyLockPrice090Migration(cfg);
  assert.equal(res.changed, true);
  assert.equal(res.migrated, true);
  assert.equal(cfg.kalshiLockPrice, 0.90);
  assert.equal(cfg.lockPrice090Migrated, true);
});

test("lockPrice migration: config already at 0.90 without flag → flag set, value untouched", () => {
  const cfg = migCfg({ decisionMode: "conviction", kalshiLockPrice: 0.90, lockPrice090Migrated: undefined });
  const res = applyLockPrice090Migration(cfg);
  assert.equal(res.changed, true);
  assert.equal(res.migrated, false);
  assert.equal(cfg.kalshiLockPrice, 0.90);
  assert.equal(cfg.lockPrice090Migrated, true);
});

test("lockPrice migration: user-set 0.91 AFTER flag → preserved on restart (idempotency)", () => {
  // Simulates: config evaluated once (flag set), user deliberately sets 0.91
  // via the UI, server restarts. The migration must NOT revert it.
  const cfg = migCfg({ decisionMode: "conviction", kalshiLockPrice: 0.91, lockPrice090Migrated: true });
  const res = applyLockPrice090Migration(cfg);
  assert.equal(res.changed, false);
  assert.equal(res.migrated, false);
  assert.equal(cfg.kalshiLockPrice, 0.91);
});

test("lockPrice migration: non-conviction mode without flag → flag set, no value backfill", () => {
  const cfg = migCfg({ decisionMode: "classic", kalshiLockPrice: undefined, lockPrice090Migrated: undefined });
  const res = applyLockPrice090Migration(cfg);
  assert.equal(res.changed, true);
  assert.equal(res.migrated, false);
  assert.equal(cfg.kalshiLockPrice, undefined);
  assert.equal(cfg.lockPrice090Migrated, true);
});

test("lockPrice migration: fully migrated config → no-op", () => {
  const cfg = migCfg({ decisionMode: "conviction", kalshiLockPrice: 0.90, lockPrice090Migrated: true });
  const res = applyLockPrice090Migration(cfg);
  assert.equal(res.changed, false);
  assert.equal(res.migrated, false);
  assert.equal(cfg.kalshiLockPrice, 0.90);
});

// ---------------------------------------------------------------------------
// deriveConvictionZone — single source of truth for the asymmetric −2¢/+3¢
// conviction entry zone (user spec 2026-07-17: sweet spot 92¢ → [90¢, 95¢])
// ---------------------------------------------------------------------------

test("deriveConvictionZone: target 0.92 → asymmetric zone [0.90, 0.95]", () => {
  const z = deriveConvictionZone(0.92);
  assert.equal(z.lockPrice, 0.90);
  assert.equal(z.lockPriceCap, 0.95);
});

test("deriveConvictionZone: 89¢ is BELOW the floor (never fill at 89 or less)", () => {
  const z = deriveConvictionZone(0.92);
  assert.ok(0.89 < z.lockPrice);
  assert.ok(0.90 >= z.lockPrice); // 90¢ is the first fillable cent
});

test("deriveConvictionZone: 95¢ fillable, anything above is not", () => {
  const z = deriveConvictionZone(0.92);
  assert.ok(0.95 <= z.lockPriceCap);
  assert.ok(0.955 > z.lockPriceCap);
  assert.ok(0.96 > z.lockPriceCap);
});

test("deriveConvictionZone: no floating-point drift on cent boundaries", () => {
  // 0.92 - 0.02 = 0.9000000000000001 in raw IEEE754 — the helper must round.
  const z = deriveConvictionZone(0.92);
  assert.equal(z.lockPrice, 0.9);
  assert.equal(z.lockPriceCap, 0.95);
});

// ---------------------------------------------------------------------------
// applyLockPrice092Bootstrap — one-time 0.93 → 0.92 target bootstrap
// ---------------------------------------------------------------------------

test("092 bootstrap: value at 0.93 → bumped to 0.92 with flag", () => {
  const cfg = migCfg({ kalshiLockPrice: 0.93, lockPrice092Bootstrap: undefined });
  const res = applyLockPrice092Bootstrap(cfg);
  assert.equal(res.changed, true);
  assert.equal(res.bumped, true);
  assert.equal(cfg.kalshiLockPrice, 0.92);
  assert.equal(cfg.lockPrice092Bootstrap, true);
});

test("092 bootstrap: custom value (0.94) → flag set, value untouched", () => {
  const cfg = migCfg({ kalshiLockPrice: 0.94, lockPrice092Bootstrap: undefined });
  const res = applyLockPrice092Bootstrap(cfg);
  assert.equal(res.changed, true);
  assert.equal(res.bumped, false);
  assert.equal(cfg.kalshiLockPrice, 0.94);
  assert.equal(cfg.lockPrice092Bootstrap, true);
});

test("092 bootstrap: flag already set → no-op even at 0.93", () => {
  const cfg = migCfg({ kalshiLockPrice: 0.93, lockPrice092Bootstrap: true });
  const res = applyLockPrice092Bootstrap(cfg);
  assert.equal(res.changed, false);
  assert.equal(res.bumped, false);
  assert.equal(cfg.kalshiLockPrice, 0.93);
});

test("092 bootstrap: user later sets 0.93 after flag → preserved on restart", () => {
  const cfg = migCfg({ kalshiLockPrice: 0.93, lockPrice092Bootstrap: true });
  applyLockPrice092Bootstrap(cfg);
  assert.equal(cfg.kalshiLockPrice, 0.93);
});

test("092 bootstrap: fresh-install chain 0.90 → 0.93 → 0.92", () => {
  const cfg = migCfg({ kalshiLockPrice: 0.90, lockPrice093Bootstrap: undefined, lockPrice092Bootstrap: undefined });
  applyLockPrice093Bootstrap(cfg);
  assert.equal(cfg.kalshiLockPrice, 0.93);
  const res = applyLockPrice092Bootstrap(cfg);
  assert.equal(res.bumped, true);
  assert.equal(cfg.kalshiLockPrice, 0.92);
});

// ---------------------------------------------------------------------------
// CONVICTION CATASTROPHIC FILL THRESHOLD
// Validates the pure threshold math used in the post-fill zone check
// (kalshi-bot-tick.ts). The check computes fillDeviation and compares it to
// convictionCatastrophicFillThresholdCents / 100.
// ---------------------------------------------------------------------------

/** Replicates the post-fill zone deviation check from kalshi-bot-tick.ts. */
function catastrophicFillCheck(
  fillAvgPrice: number,
  direction: "yes" | "no",
  target: number,
  thresholdCents = 15,
): { catastrophic: boolean; deviationCents: number } {
  const { lockPrice, lockPriceCap } = deriveConvictionZone(target);
  const convFillPrice = direction === "yes" ? fillAvgPrice : 1 - fillAvgPrice;
  const fillDeviation = direction === "yes"
    ? lockPrice - convFillPrice
    : convFillPrice - lockPriceCap;
  const threshold = thresholdCents / 100;
  return {
    catastrophic: fillDeviation > threshold,
    deviationCents: +(fillDeviation * 100).toFixed(2),
  };
}

test("catastrophic fill: YES at 11¢ with lockPrice=0.88 → 77¢ deviation → catastrophic", () => {
  // target=0.90 → lockPrice=0.88, lockPriceCap=0.93
  // avgPrice returned by Kalshi = 0.11 (YES fill)
  // deviation = 0.88 - 0.11 = 0.77 → 77¢ >> 15¢ threshold
  const r = catastrophicFillCheck(0.11, "yes", 0.90);
  assert.equal(r.catastrophic, true);
  assert.ok(r.deviationCents > 15, `Expected deviation > 15¢, got ${r.deviationCents}¢`);
});

test("catastrophic fill: YES at 85¢ with lockPrice=0.88 → 3¢ deviation → minor (hold)", () => {
  // deviation = 0.88 - 0.85 = 0.03 → 3¢ < 15¢ threshold
  const r = catastrophicFillCheck(0.85, "yes", 0.90);
  assert.equal(r.catastrophic, false);
  assert.ok(r.deviationCents <= 15, `Expected deviation ≤ 15¢, got ${r.deviationCents}¢`);
});

test("catastrophic fill: YES at 90¢ (in zone) → 0 deviation → not catastrophic", () => {
  // fill is inside zone, deviation is negative → 0 deviation scenario
  const r = catastrophicFillCheck(0.90, "yes", 0.90);
  assert.equal(r.catastrophic, false);
  assert.ok(r.deviationCents <= 0);
});

test("catastrophic fill: YES at exactly lockPrice (0.88) → 0¢ deviation → not catastrophic", () => {
  const r = catastrophicFillCheck(0.88, "yes", 0.90);
  assert.equal(r.catastrophic, false);
});

test("catastrophic fill: threshold=0 means any below-floor fill is catastrophic", () => {
  // Even 1¢ below floor triggers catastrophic when threshold=0
  const r = catastrophicFillCheck(0.87, "yes", 0.90, 0);
  assert.equal(r.catastrophic, true);
});

test("catastrophic fill: threshold=100 means nothing is catastrophic (always hold)", () => {
  // 77¢ deviation is still < 100¢ threshold
  const r = catastrophicFillCheck(0.11, "yes", 0.90, 100);
  assert.equal(r.catastrophic, false);
});

test("catastrophic fill: NO direction — avgPrice 0.06 (fill 94¢ NO cost) above cap=0.93 by 1¢ → minor", () => {
  // NO direction: convFillPrice = 1 - avgPrice = 1 - 0.06 = 0.94
  // fillDeviation = convFillPrice - lockPriceCap = 0.94 - 0.93 = 0.01 → 1¢ < 15¢ → minor
  const r = catastrophicFillCheck(0.06, "no", 0.90);
  assert.equal(r.catastrophic, false);
  assert.ok(Math.abs(r.deviationCents - 1) < 0.1, `Expected ~1¢, got ${r.deviationCents}¢`);
});

// ---------------------------------------------------------------------------
// CONVICTION ADVERSE MOMENTUM GATE
// Validates the time-to-cross math used in computeTrajectoryGate when
// convictionMomentumGateEnabled = true.
// Math: time-to-cross = currentMarginDollars / |velocity|
//       block if time-to-cross < minutesRemaining * safetyFactor
// ---------------------------------------------------------------------------

// Tests call computeAdverseMomentumGate directly — the same pure function used
// by computeTrajectoryGate in kalshi-bot-tick.ts.  This means any logic change
// in the gate is reflected immediately in both production and tests.

test("adverse momentum: YES freefall — $1000 margin, −300$/min, 8 min → BLOCKED (projectedGap=−1400 < threshold=600)", () => {
  // projectedGap = 1000 − 300×8 = −1400; threshold = 0.6×1000 = 600; −1400 < 600 → BLOCKED
  const r = computeAdverseMomentumGate({ livePrice: 101000, kalshiTarget: 100000, direction: "yes", velocityPerMin: -300, minutesRemaining: 8 });
  assert.equal(r.blocked, true);
  assert.ok(Math.abs(r.timeToCrossMin - 3.33) < 0.1, `Expected timeToCross ~3.33, got ${r.timeToCrossMin.toFixed(2)}`);
});

test("adverse momentum: YES gentle drift — $1000 margin, −50$/min, 8 min → SAFE (projectedGap=600 = threshold=600)", () => {
  // projectedGap = 1000 − 50×8 = 600; threshold = 0.6×1000 = 600; 600 < 600 is false → SAFE
  const r = computeAdverseMomentumGate({ livePrice: 101000, kalshiTarget: 100000, direction: "yes", velocityPerMin: -50, minutesRemaining: 8 });
  assert.equal(r.blocked, false);
  assert.ok(r.timeToCrossMin > 15, `Expected timeToCross > 15, got ${r.timeToCrossMin.toFixed(2)}`);
});

test("adverse momentum: YES crosses strike — $480 margin, −100$/min, 8 min → BLOCKED (projectedGap=−320 < threshold=288)", () => {
  // projectedGap = 480 − 100×8 = −320; threshold = 0.6×480 = 288; −320 < 288 → BLOCKED
  // (price fully crosses the strike before close — timeToCross = 4.8 min < 8 min remaining)
  const r = computeAdverseMomentumGate({ livePrice: 100480, kalshiTarget: 100000, direction: "yes", velocityPerMin: -100, minutesRemaining: 8 });
  assert.equal(r.blocked, true);
  assert.ok(Math.abs(r.timeToCrossMin - 4.8) < 0.01, `Expected timeToCross ~4.8, got ${r.timeToCrossMin.toFixed(3)}`);
});

test("adverse momentum: YES favorable velocity → SAFE (not adverse)", () => {
  // price rising → adverseVelocity = false → gate silent
  const r = computeAdverseMomentumGate({ livePrice: 101000, kalshiTarget: 100000, direction: "yes", velocityPerMin: 300, minutesRemaining: 8 });
  assert.equal(r.blocked, false);
});

test("adverse momentum: gate disabled → SAFE even on fast freefall", () => {
  const r = computeAdverseMomentumGate({ livePrice: 101000, kalshiTarget: 100000, direction: "yes", velocityPerMin: -300, minutesRemaining: 8, enabled: false });
  assert.equal(r.blocked, false);
});

test("adverse momentum: NO direction freefall — target $100k, live $99k, rising +300$/min, 8 min → BLOCKED", () => {
  // NO wins below target. margin = target - live = 100000 - 99000 = 1000.
  // projectedGap = 1000 − 300×8 = −1400; threshold = 0.6×1000 = 600; −1400 < 600 → BLOCKED
  const r = computeAdverseMomentumGate({ livePrice: 99000, kalshiTarget: 100000, direction: "no", velocityPerMin: 300, minutesRemaining: 8 });
  assert.equal(r.blocked, true);
  assert.ok(Math.abs(r.timeToCrossMin - 3.33) < 0.1, `Expected timeToCross ~3.33, got ${r.timeToCrossMin.toFixed(2)}`);
});

test("adverse momentum: zero velocity → SAFE (timeToCross = Infinity)", () => {
  const r = computeAdverseMomentumGate({ livePrice: 101000, kalshiTarget: 100000, direction: "yes", velocityPerMin: 0, minutesRemaining: 8 });
  assert.equal(r.blocked, false);
  assert.equal(r.timeToCrossMin, Infinity);
});

test("adverse momentum: HYPE 3:11 PM — $59.6751 live, $59.5480 strike, −0.04$/min, 4 min remaining → BLOCKED", () => {
  // Replicates the real HYPE bet that lost. The price was falling toward the strike.
  // gap = 59.6751 − 59.5480 = 0.1271
  // projectedGap = 0.1271 − 0.04×4 = 0.1271 − 0.16 = −0.0329  (projected to CROSS)
  // threshold   = 0.6 × 0.1271 = 0.07626
  // −0.0329 < 0.07626 → BLOCKED ✓
  const r = computeAdverseMomentumGate({
    livePrice: 59.6751,
    kalshiTarget: 59.5480,
    direction: "yes",
    velocityPerMin: -0.04,
    minutesRemaining: 4,
    safetyFactor: 0.6,
    enabled: true,
  });
  assert.equal(r.blocked, true, `Expected BLOCKED — projectedGap should be negative; timeToCross=${r.timeToCrossMin.toFixed(2)}`);
  // timeToCross is diagnostic; 0.1271/0.04 = 3.18 min (< 4 min remaining — confirms it crosses)
  assert.ok(Math.abs(r.timeToCrossMin - 3.18) < 0.05, `Expected timeToCross ~3.18, got ${r.timeToCrossMin.toFixed(3)}`);
});

test("adverse momentum: HYPE 3:11 PM gentle drift — same prices, −0.01$/min → SAFE", () => {
  // Same prices but only −0.01$/min — price stays above strike.
  // projectedGap = 0.1271 − 0.01×4 = 0.1271 − 0.04 = 0.0871
  // threshold   = 0.6 × 0.1271 = 0.07626
  // 0.0871 > 0.07626 → SAFE ✓
  const r = computeAdverseMomentumGate({
    livePrice: 59.6751,
    kalshiTarget: 59.5480,
    direction: "yes",
    velocityPerMin: -0.01,
    minutesRemaining: 4,
    safetyFactor: 0.6,
    enabled: true,
  });
  assert.equal(r.blocked, false, `Expected SAFE — gentle drift keeps 87% of gap; timeToCross=${r.timeToCrossMin.toFixed(2)}`);
  assert.ok(r.timeToCrossMin > 10, `Expected timeToCross > 10, got ${r.timeToCrossMin.toFixed(2)}`);
});

// ── computeStrikeProximityGate tests ────────────────────────────────────────

test("strike proximity: YES gap above threshold → PASS", () => {
  // livePrice $101k, strike $100k → gap = 1000/100000*100 = 1.00%; threshold 0.30%
  const r = computeStrikeProximityGate({ livePrice: 101000, kalshiStrike: 100000, direction: "yes", thresholdPct: 0.30, atrScaleEnabled: false });
  assert.equal(r.blocked, false);
  assert.ok(r.gapPct != null && Math.abs(r.gapPct - 1.00) < 0.001, `Expected gap ~1.00, got ${r.gapPct}`);
  assert.equal(r.effectiveThreshold, 0.30);
});

test("strike proximity: YES gap below threshold → BLOCKED", () => {
  // livePrice $100100, strike $100000 → gap = 100/100000*100 = 0.10%; threshold 0.30%
  const r = computeStrikeProximityGate({ livePrice: 100100, kalshiStrike: 100000, direction: "yes", thresholdPct: 0.30, atrScaleEnabled: false });
  assert.equal(r.blocked, true);
  assert.ok(r.gapPct != null && Math.abs(r.gapPct - 0.10) < 0.001, `Expected gap ~0.10, got ${r.gapPct}`);
});

test("strike proximity: NO direction — gap computed correctly (absolute)", () => {
  // NO: livePrice $99500, strike $100000 → gap = 500/100000*100 = 0.50% → passes 0.30%
  const r = computeStrikeProximityGate({ livePrice: 99500, kalshiStrike: 100000, direction: "no", thresholdPct: 0.30, atrScaleEnabled: false });
  assert.equal(r.blocked, false);
  assert.ok(r.gapPct != null && Math.abs(r.gapPct - 0.50) < 0.001, `Expected gap ~0.50, got ${r.gapPct}`);
});

test("strike proximity: ATR scaling widens threshold — marginal gap blocked by scaled threshold", () => {
  // gap = 0.40%, base threshold 0.30%, atrPct = 0.40% → multiplier = max(1, 0.40/0.20) = 2 → effective = 0.60% → BLOCKED
  const r = computeStrikeProximityGate({ livePrice: 100400, kalshiStrike: 100000, direction: "yes", thresholdPct: 0.30, atrPct: 0.40, atrScaleEnabled: true });
  assert.equal(r.blocked, true);
  assert.ok(Math.abs(r.effectiveThreshold - 0.60) < 0.001, `Expected effectiveThreshold ~0.60, got ${r.effectiveThreshold}`);
});

test("strike proximity: ATR scaling disabled — base threshold used even with high ATR", () => {
  // gap = 0.40%, base threshold 0.30% — PASS because atrScaleEnabled=false ignores atrPct
  const r = computeStrikeProximityGate({ livePrice: 100400, kalshiStrike: 100000, direction: "yes", thresholdPct: 0.30, atrPct: 0.40, atrScaleEnabled: false });
  assert.equal(r.blocked, false);
  assert.equal(r.effectiveThreshold, 0.30);
});

test("strike proximity: null livePrice → fail-open (gate passes)", () => {
  const r = computeStrikeProximityGate({ livePrice: null, kalshiStrike: 100000, direction: "yes", thresholdPct: 0.30 });
  assert.equal(r.blocked, false);
  assert.equal(r.gapPct, null);
});

test("strike proximity: null kalshiStrike → fail-open (gate passes)", () => {
  const r = computeStrikeProximityGate({ livePrice: 101000, kalshiStrike: null, direction: "yes", thresholdPct: 0.30 });
  assert.equal(r.blocked, false);
  assert.equal(r.gapPct, null);
});

// Tick-time proximity re-check scenarios (mirrors the conviction tick gate added
// to kalshi-bot-tick.ts to catch stale-cache drift between loop evaluation and FOK).

test("strike proximity (tick re-check): NEAR scenario — 0.0269% gap blocked by 0.15% threshold", () => {
  // Reproduces the Jul-22 NEAR NO bet: livePrice $1.8690, strike $1.8685,
  // gap = 0.0268% which is well below the 0.15% configured threshold.
  const strike = 1.8685;
  const livePrice = strike * (1 + 0.000269); // ~$1.86900
  const r = computeStrikeProximityGate({
    livePrice, kalshiStrike: strike, direction: "no", thresholdPct: 0.15, atrScaleEnabled: false,
  });
  assert.equal(r.blocked, true, `Expected blocked=true, gap=${r.gapPct?.toFixed(4)}%, threshold=0.15%`);
  assert.ok(r.gapPct != null && r.gapPct < 0.15, `Gap ${r.gapPct} should be < 0.15`);
});

test("strike proximity (tick re-check): gap exactly at threshold → NOT blocked (boundary)", () => {
  // Threshold = 0.15%; gap = 0.15% exactly → gate should PASS (not strictly less than)
  const strike = 1.8685;
  const livePrice = strike * (1 + 0.0015); // gap = 0.15% exactly
  const r = computeStrikeProximityGate({
    livePrice, kalshiStrike: strike, direction: "no", thresholdPct: 0.15, atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false, `Expected blocked=false at exactly threshold`);
});

test("strike proximity (tick re-check): gap well above threshold → NOT blocked", () => {
  // Gap = 0.50%, threshold = 0.15% → safe to bet
  const strike = 1.8685;
  const livePrice = strike * (1 + 0.005); // gap = 0.50%
  const r = computeStrikeProximityGate({
    livePrice, kalshiStrike: strike, direction: "no", thresholdPct: 0.15, atrScaleEnabled: false,
  });
  assert.equal(r.blocked, false);
  assert.ok(r.gapPct != null && r.gapPct > 0.15, `Gap ${r.gapPct} should exceed threshold`);
});

test("strike proximity (tick re-check): YES direction tiny gap also blocked", () => {
  // YES conviction at 90¢, BTC strike $65000, livePrice $65010 → 0.015% gap, threshold 0.15%
  const r = computeStrikeProximityGate({
    livePrice: 65010, kalshiStrike: 65000, direction: "yes", thresholdPct: 0.15, atrScaleEnabled: false,
  });
  assert.equal(r.blocked, true);
  assert.ok(r.gapPct != null && r.gapPct < 0.15);
});

// ── shouldSuppressConvictionStopLoss tests ────────────────────────────────────
// Reproduces the Jul-22 DOGE and BTC cases where the stop-loss exited winning
// positions because Kalshi temporarily mispriced the market.

test("stop-loss suppression: NO bet — livePrice below strike → suppress (DOGE Jul-22)", () => {
  // DOGE at $0.0700, strike $0.072927 → crypto says NO wins → suppress
  const result = shouldSuppressConvictionStopLoss({
    direction: "no", livePrice: 0.0700, kalshiStrike: 0.072927,
  });
  assert.equal(result, true, "Stop-loss should be suppressed when NO bet crypto is below strike");
});

test("stop-loss suppression: NO bet — livePrice above strike → allow stop-loss (genuine loss)", () => {
  // DOGE at $0.080, strike $0.072927 → crypto above strike → NO genuinely losing
  const result = shouldSuppressConvictionStopLoss({
    direction: "no", livePrice: 0.080, kalshiStrike: 0.072927,
  });
  assert.equal(result, false, "Stop-loss should fire when crypto is above strike for a NO bet");
});

test("stop-loss suppression: YES bet — livePrice above strike → suppress", () => {
  // BTC at $66100, strike $65983 → crypto above strike → YES winning → suppress
  const result = shouldSuppressConvictionStopLoss({
    direction: "yes", livePrice: 66100, kalshiStrike: 65983,
  });
  assert.equal(result, true, "Stop-loss should be suppressed when YES bet crypto is above strike");
});

test("stop-loss suppression: YES bet — livePrice below strike → allow stop-loss (genuine loss)", () => {
  // BTC at $65800, strike $65983 → crypto below strike → YES genuinely losing
  const result = shouldSuppressConvictionStopLoss({
    direction: "yes", livePrice: 65800, kalshiStrike: 65983,
  });
  assert.equal(result, false, "Stop-loss should fire when crypto is below strike for a YES bet");
});

test("stop-loss suppression: null livePrice → fail-closed (allow stop-loss)", () => {
  const result = shouldSuppressConvictionStopLoss({
    direction: "no", livePrice: null, kalshiStrike: 0.072927,
  });
  assert.equal(result, false, "Should not suppress when livePrice is unavailable");
});

test("stop-loss suppression: null kalshiStrike → fail-closed (allow stop-loss)", () => {
  const result = shouldSuppressConvictionStopLoss({
    direction: "no", livePrice: 0.0700, kalshiStrike: null,
  });
  assert.equal(result, false, "Should not suppress when kalshiStrike is unavailable");
});

test("stop-loss suppression: livePrice exactly at strike → allow stop-loss (at boundary, not winning)", () => {
  // Price exactly at strike = outcome is 50/50, not a confirmed win — fire stop-loss
  const result = shouldSuppressConvictionStopLoss({
    direction: "no", livePrice: 0.072927, kalshiStrike: 0.072927,
  });
  assert.equal(result, false, "Should not suppress when livePrice equals strike (not strictly below)");
});

// ── applyLockPrice082Migration tests ─────────────────────────────────────────

test("lockPrice082Migration: config with kalshiLockPrice=0.90 → migrated to 0.82, cap set to 0.91", () => {
  const config: Partial<BotConfig> = { kalshiLockPrice: 0.90 };
  const result = applyLockPrice082Migration(config as BotConfig);
  assert.equal(result.changed, true);
  assert.equal(result.migrated, true);
  assert.equal(config.kalshiLockPrice, 0.82);
  assert.equal(config.kalshiLockPriceCap, 0.91);
  assert.equal(config.lockPrice082Migrated, true);
});

test("lockPrice082Migration: already migrated → no-op", () => {
  const config: Partial<BotConfig> = { kalshiLockPrice: 0.82, kalshiLockPriceCap: 0.91, lockPrice082Migrated: true };
  const result = applyLockPrice082Migration(config as BotConfig);
  assert.equal(result.changed, false);
  assert.equal(result.migrated, false);
  assert.equal(config.kalshiLockPrice, 0.82); // unchanged
});

test("lockPrice082Migration: config with kalshiLockPrice=0.82 (already low) → not migrated, but cap+flag set", () => {
  const config: Partial<BotConfig> = { kalshiLockPrice: 0.82 };
  const result = applyLockPrice082Migration(config as BotConfig);
  assert.equal(result.changed, true);
  assert.equal(result.migrated, false); // was already below 0.88
  assert.equal(config.kalshiLockPrice, 0.82); // unchanged
  assert.equal(config.kalshiLockPriceCap, 0.91);
});

// ---------------------------------------------------------------------------
// checkConvictionOneSidedBook
// Covers the Kalshi one-sided orderbook fix: market makers often rest bids
// but not asks (or vice-versa) for strongly in-the-money directions.
// A YES bid of 0.999 or a YES ask of 0.001 should NOT trigger a "price
// reversed" abort — the available side confirms the direction is in zone.
// ---------------------------------------------------------------------------

test("one-sided book YES: ask=null, bid ≥ lockPrice → oneSidedConfirmed=true, side=bid", () => {
  // Production case: BTC/BNB YES — freshYesAsk=null, freshYesBid=0.999
  const r = checkConvictionOneSidedBook("yes", null, 0.999, 0.82);
  assert.equal(r.oneSidedConfirmed, true);
  assert.equal(r.side, "bid");
});

test("one-sided book YES: ask=null, bid exactly at lockPrice → oneSidedConfirmed=true", () => {
  const r = checkConvictionOneSidedBook("yes", null, 0.82, 0.82);
  assert.equal(r.oneSidedConfirmed, true);
  assert.equal(r.side, "bid");
});

test("one-sided book YES: ask=null, bid below lockPrice → oneSidedConfirmed=false (price may have reversed)", () => {
  // bid=0.81 < lockPrice=0.82 → cannot confirm direction is safe
  const r = checkConvictionOneSidedBook("yes", null, 0.81, 0.82);
  assert.equal(r.oneSidedConfirmed, false);
  assert.equal(r.side, null);
});

test("one-sided book YES: both null → oneSidedConfirmed=false (no side to confirm)", () => {
  const r = checkConvictionOneSidedBook("yes", null, null, 0.82);
  assert.equal(r.oneSidedConfirmed, false);
  assert.equal(r.side, null);
});

test("one-sided book YES: ask present → normal two-sided book, oneSidedConfirmed=false", () => {
  // When ask is present the primary ref price path applies — no bypass needed
  const r = checkConvictionOneSidedBook("yes", 0.85, 0.84, 0.82);
  assert.equal(r.oneSidedConfirmed, false);
  assert.equal(r.side, null);
});

test("one-sided book NO: bid=null, ask ≤ (1−lockPrice) → oneSidedConfirmed=true, side=ask", () => {
  // Production case: NEAR NO — freshYesAsk=0.001, freshYesBid=null
  // (1−lockPrice) = 1−0.82 = 0.18; ask=0.001 ≤ 0.18 → NO price ≈ 0.999
  const r = checkConvictionOneSidedBook("no", 0.001, null, 0.82);
  assert.equal(r.oneSidedConfirmed, true);
  assert.equal(r.side, "ask");
});

test("one-sided book NO: bid=null, ask exactly at (1−lockPrice) → oneSidedConfirmed=true", () => {
  // ask=0.18, lockPrice=0.82 → 1−lockPrice=0.18, ask≤0.18 → confirmed
  const r = checkConvictionOneSidedBook("no", 0.18, null, 0.82);
  assert.equal(r.oneSidedConfirmed, true);
  assert.equal(r.side, "ask");
});

test("one-sided book NO: bid=null, ask above (1−lockPrice) → oneSidedConfirmed=false (price may have reversed)", () => {
  // ask=0.25, lockPrice=0.82 → 1−lockPrice=0.18; 0.25 > 0.18 → price reversed
  const r = checkConvictionOneSidedBook("no", 0.25, null, 0.82);
  assert.equal(r.oneSidedConfirmed, false);
  assert.equal(r.side, null);
});

test("one-sided book NO: both null → oneSidedConfirmed=false (no side to confirm)", () => {
  const r = checkConvictionOneSidedBook("no", null, null, 0.82);
  assert.equal(r.oneSidedConfirmed, false);
  assert.equal(r.side, null);
});

test("one-sided book NO: bid present → normal two-sided book, oneSidedConfirmed=false", () => {
  // When bid is present the primary ref price (1−bid) applies — no bypass needed
  const r = checkConvictionOneSidedBook("no", 0.07, 0.06, 0.82);
  assert.equal(r.oneSidedConfirmed, false);
  assert.equal(r.side, null);
});

test("one-sided book YES: ask=null, bid=0.999, higher lockPrice=0.92 → still confirmed (bid ≥ lockPrice)", () => {
  const r = checkConvictionOneSidedBook("yes", null, 0.999, 0.92);
  assert.equal(r.oneSidedConfirmed, true);
  assert.equal(r.side, "bid");
});

test("one-sided book NO: bid=null, ask=0.05, lockPrice=0.88 → oneSidedConfirmed=true (1−0.88=0.12, 0.05≤0.12)", () => {
  const r = checkConvictionOneSidedBook("no", 0.05, null, 0.88);
  assert.equal(r.oneSidedConfirmed, true);
  assert.equal(r.side, "ask");
});

// ── getEffectiveProximityThreshold priority (Task: conviction override fix) ──
// Conviction mode: convictionStrikeProximityMinPct must BEAT per-coin
// overrides — otherwise the operator's conviction calibration knob silently
// no-ops for every coin with an override (SOL NO at 83¢ in-zone was blocked
// by its 0.19% override while the conviction value was ignored).
import { getEffectiveProximityThreshold, isConvictionFokFillable } from "./kalshi-bot-engine-core.ts";

const proxCfg = (over: Partial<typeof DEFAULT_BOT_CONFIG>) => ({ ...DEFAULT_BOT_CONFIG, ...over });

test("proximity threshold: conviction value beats per-coin override in conviction mode", () => {
  const cfg = proxCfg({
    strikeProximityMinPct: 0.30,
    strikeProximityMinPctOverrides: { SOL: 0.19 },
    convictionStrikeProximityMinPct: 0.10,
  });
  assert.equal(getEffectiveProximityThreshold("SOL", cfg, true), 0.10);
});

test("proximity threshold: per-coin override still applies in NON-conviction mode", () => {
  const cfg = proxCfg({
    strikeProximityMinPct: 0.30,
    strikeProximityMinPctOverrides: { SOL: 0.19 },
    convictionStrikeProximityMinPct: 0.10,
  });
  assert.equal(getEffectiveProximityThreshold("SOL", cfg, false), 0.19);
});

test("proximity threshold: conviction unset → per-coin override applies in conviction mode", () => {
  const cfg = proxCfg({
    strikeProximityMinPct: 0.30,
    strikeProximityMinPctOverrides: { SOL: 0.19 },
    convictionStrikeProximityMinPct: undefined,
  });
  assert.equal(getEffectiveProximityThreshold("SOL", cfg, true), 0.19);
});

test("proximity threshold: no override, no conviction value → global", () => {
  const cfg = proxCfg({
    strikeProximityMinPct: 0.25,
    strikeProximityMinPctOverrides: {},
    convictionStrikeProximityMinPct: undefined,
  });
  assert.equal(getEffectiveProximityThreshold("BTC", cfg, true), 0.25);
  assert.equal(getEffectiveProximityThreshold("BTC", cfg, false), 0.25);
});

test("proximity threshold: zero/invalid per-coin override ignored", () => {
  const cfg = proxCfg({
    strikeProximityMinPct: 0.30,
    strikeProximityMinPctOverrides: { BTC: 0 },
    convictionStrikeProximityMinPct: undefined,
  });
  assert.equal(getEffectiveProximityThreshold("BTC", cfg, false), 0.30);
});

// ── isConvictionFokFillable (Task: no wasted FOK attempts) ──────────────────
// The capBuffer widens the pre-order trigger past lockPriceCap, but the FOK
// limit is pinned to the strict cap.  Attempts where the capped limit cannot
// execute against the live book are guaranteed kills that would burn
// windowFailedFills — they must be detected and skipped without penalty.

test("FOK fillable YES: ask past strict cap → unfillable (capBuffer trigger, limit pinned at cap)", () => {
  // cap 0.85, ask 0.89 → limit = min(0.89, 0.85) = 0.85 < ask → cannot fill
  assert.equal(isConvictionFokFillable("yes", 0.85, 0.89, null), false);
});

test("FOK fillable YES: ask at/below cap → fillable", () => {
  assert.equal(isConvictionFokFillable("yes", 0.84, 0.84, null), true);
  assert.equal(isConvictionFokFillable("yes", 0.85, 0.83, null), true);
});

test("FOK fillable YES: sub-cent ask floored below → unfillable", () => {
  // ask 0.845 → limit floor(min(0.845,0.85)*100)/100 = 0.84 < 0.845 → kill
  assert.equal(isConvictionFokFillable("yes", 0.84, 0.845, null), false);
});

test("FOK fillable NO: yes-bid below strict floor → unfillable (YES-sell limit above bid)", () => {
  // cap 0.85 → NO limit = max(bid, 1−0.85)=0.15 ceil → 0.15 > bid 0.11 → kill
  assert.equal(isConvictionFokFillable("no", 0.15, null, 0.11), false);
});

test("FOK fillable NO: yes-bid at/above limit → fillable", () => {
  assert.equal(isConvictionFokFillable("no", 0.15, null, 0.15), true);
  assert.equal(isConvictionFokFillable("no", 0.15, null, 0.18), true);
});

test("FOK fillable: missing side price → fillable (nothing to check, downstream gates own it)", () => {
  assert.equal(isConvictionFokFillable("yes", 0.85, null, 0.99), true);
  assert.equal(isConvictionFokFillable("no", 0.15, 0.01, null), true);
});
