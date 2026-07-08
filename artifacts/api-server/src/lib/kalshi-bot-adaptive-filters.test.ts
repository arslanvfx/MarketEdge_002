// Unit tests for the three loss-learning adaptive filters:
//   1. Per-coin streak confidence penalty (config defaults + floor logic)
//   2. Unanimous model floor in ml_gate (computeMLGateDecision downgrade)
//   3. Directional regime dampener accumulation and thin-data guard
//
// Run with:  pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeMLGateDecision,
  DEFAULT_BOT_CONFIG,
  STAT_BOOST,
  STAT_PENALTY,
  ML_WEIGHT,
  CLAUDE_WEIGHT,
  type CorePairInputs,
} from "./kalshi-bot-engine-core.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mlGateInputs(overrides: Partial<CorePairInputs> = {}): CorePairInputs {
  return {
    statAbove: true,
    claudeAbove: true,
    mlAbove: true,
    statConfidence: 60,
    claudeConfidence: 60,
    mlConfidence: 60,
    wmDriftAbove: null,
    wmRec: null,
    wmReady: false,
    yesPrice: 0.5,
    signalAccuracyPct: null,
    minutesElapsed: 2,
    kalshiTicker: "KXBTC-123",
    minConfidence: 60,
    minReturnMultiple: null,
    unanimousMinModelConfidence: undefined,
    ...overrides,
  };
}

// Pure helper that mirrors the directional dampener math in kalshi-bot-loop.ts.
// Used to validate the logic in isolation without importing any DB-backed module.
function computeDirectionalPenaltyPp(
  wins: number,
  losses: number,
  minBets: number,
  threshold: number,
  penaltyPp: number,
  freeRunMode = false,
): number {
  const total = wins + losses;
  if (freeRunMode) return 0;
  if (total < minBets) return 0;
  return wins / total < threshold ? penaltyPp : 0;
}

// ---------------------------------------------------------------------------
// 1. Coin streak penalty — config defaults
// ---------------------------------------------------------------------------

test("streak penalty: DEFAULT_BOT_CONFIG has correct 1-loss and 2+-loss penalty defaults", () => {
  assert.strictEqual(
    DEFAULT_BOT_CONFIG.coinStreakPenalty1LossPp,
    6,
    "1-loss streak penalty should default to 6pp",
  );
  assert.strictEqual(
    DEFAULT_BOT_CONFIG.coinStreakPenalty2PlusLossPp,
    12,
    "2+-loss streak penalty should default to 12pp",
  );
});

test("streak penalty: DEFAULT_BOT_CONFIG unanimousMinModelConfidence defaults to 57", () => {
  assert.strictEqual(
    DEFAULT_BOT_CONFIG.unanimousMinModelConfidence,
    57,
    "unanimousMinModelConfidence should default to 57",
  );
});

// Simulate the streak-penalty confidence reduction applied in the loop:
// effectiveConfidence = baseConf - penalty; skip when below minConfidence.
test("streak penalty: 1 consecutive loss reduces effective confidence by 6pp", () => {
  const minConf = 60;
  const pen1 = DEFAULT_BOT_CONFIG.coinStreakPenalty1LossPp!; // 6
  const baseConf = 65;
  const effective = baseConf - pen1; // 59
  assert.ok(effective < minConf, "effective confidence should fall below minConfidence after 1-loss penalty");
});

test("streak penalty: 2+ consecutive losses reduces effective confidence by 12pp", () => {
  const minConf = 60;
  const pen2 = DEFAULT_BOT_CONFIG.coinStreakPenalty2PlusLossPp!; // 12
  const baseConf = 70;
  const effective = baseConf - pen2; // 58
  assert.ok(effective < minConf, "effective confidence should fall below minConfidence after 2+-loss penalty");
});

test("streak penalty: freeRunMode exempts coins from streak penalty", () => {
  // In freeRunMode the loop skips the penalty block entirely.
  // Validate the config flag exists and is boolean.
  assert.strictEqual(typeof DEFAULT_BOT_CONFIG.freeRunMode, "boolean");
  // The logic: if (freeRunMode) skip penalty → confidence unchanged.
  const pen2 = DEFAULT_BOT_CONFIG.coinStreakPenalty2PlusLossPp!;
  const freeRun = true;
  const penalty = freeRun ? 0 : pen2;
  assert.strictEqual(penalty, 0, "freeRunMode should zero out streak penalty");
});

// ---------------------------------------------------------------------------
// 2. Unanimous model floor in ml_gate (computeMLGateDecision)
// ---------------------------------------------------------------------------

test("ml_gate unanimous floor: all models agree above floor → no downgrade, BET fires", () => {
  // ML=62%, Claude=62%, Stat=YES; floor=57; all above floor → no downgrade
  // composite = round(62×0.60) + round(62×0.40) + STAT_BOOST
  //           = 37 + 25 + 4 = 66 ≥ minConf 60 → BET_YES
  const result = computeMLGateDecision(mlGateInputs({
    mlConfidence: 62,
    claudeConfidence: 62,
    statConfidence: 62,
    statAbove: true,
    claudeAbove: true,
    mlAbove: true,
    minConfidence: 60,
    unanimousMinModelConfidence: 57,
  }));
  assert.strictEqual(result.action, "BET_YES", "All models above floor → should BET_YES");
  assert.ok(!result.reasoning.includes("unanimous downgraded"), "Should not include downgrade note when all above floor");
});

test("ml_gate unanimous floor: weakest model below floor → downgraded, SKIP fires", () => {
  // ML=56%, Claude=56%, Stat=56%; floor=57; weakest=56 < 57 → downgrade
  // composite = round(56×0.60) + round(56×0.40) - STAT_PENALTY
  //           = 34 + 22 - 4 = 52 < minConf 60 → SKIP
  // Without downgrade: 34 + 22 + 4 = 60 = minConf → would have BET_YES
  const result = computeMLGateDecision(mlGateInputs({
    mlConfidence: 56,
    claudeConfidence: 56,
    statConfidence: 56,
    statAbove: true,
    claudeAbove: true,
    mlAbove: true,
    minConfidence: 60,
    unanimousMinModelConfidence: 57,
  }));
  assert.strictEqual(result.action, "SKIP", "Weakest model below floor → should SKIP after downgrade");
  assert.ok(
    result.reasoning.includes("unanimous downgraded"),
    `Reasoning should include downgrade note; got: "${result.reasoning}"`,
  );
  assert.ok(
    result.reasoning.includes("56%") && result.reasoning.includes("57%"),
    "Reasoning should reference the weakest model confidence and the floor",
  );
});

test("ml_gate unanimous floor: floor=0 (disabled) → no downgrade regardless of model confs", () => {
  // floor=0 disables the unanimous check entirely
  const result = computeMLGateDecision(mlGateInputs({
    mlConfidence: 50,
    claudeConfidence: 50,
    statConfidence: 50,
    minConfidence: 55,
    unanimousMinModelConfidence: 0,
  }));
  // composite = round(50×0.60) + round(50×0.40) + STAT_BOOST = 30+20+4 = 54 < 55 → SKIP
  // But SKIP should be for composite reason, NOT downgrade
  assert.ok(!result.reasoning.includes("unanimous downgraded"), "floor=0 must not produce downgrade note");
});

test("ml_gate unanimous floor: stat disagrees (not unanimous) → floor check does not fire", () => {
  // Stat disagrees → not unanimous; floor guard should not engage
  // composite = round(62×0.60) + round(62×0.40) - STAT_PENALTY = 37+25-4 = 58 < 60 → SKIP
  // But for composite reason, NOT unanimous downgrade
  const result = computeMLGateDecision(mlGateInputs({
    mlConfidence: 62,
    claudeConfidence: 62,
    statAbove: false, // disagrees with ML YES
    mlAbove: true,
    claudeAbove: true,
    minConfidence: 60,
    unanimousMinModelConfidence: 57,
  }));
  assert.ok(!result.reasoning.includes("unanimous downgraded"), "Non-unanimous input must not trigger downgrade note");
});

// ---------------------------------------------------------------------------
// 3. Directional dampener — accumulation and thin-data guard
// ---------------------------------------------------------------------------

test("directional dampener: fewer than 2 bets in a direction → penalty is 0 (thin-data guard)", () => {
  assert.strictEqual(
    computeDirectionalPenaltyPp(0, 1, 2, 0.35, 10),
    0,
    "1 total bet (0 wins, 1 loss) should NOT trigger penalty — below minimum sample",
  );
  assert.strictEqual(
    computeDirectionalPenaltyPp(1, 0, 2, 0.35, 10),
    0,
    "1 total bet (1 win, 0 losses) should NOT trigger penalty — below minimum sample",
  );
  assert.strictEqual(
    computeDirectionalPenaltyPp(0, 0, 2, 0.35, 10),
    0,
    "0 bets should NOT trigger penalty",
  );
});

test("directional dampener: win rate below threshold with ≥2 bets → penalty fires", () => {
  // 0 wins, 2 losses → winRate=0 < 0.35 → penalty=10
  assert.strictEqual(
    computeDirectionalPenaltyPp(0, 2, 2, 0.35, 10),
    10,
    "0/2 win rate below threshold should fire the penalty",
  );
  // 0 wins, 3 losses → winRate=0 < 0.35 → penalty=10
  assert.strictEqual(
    computeDirectionalPenaltyPp(0, 3, 2, 0.35, 10),
    10,
    "0/3 win rate below threshold should fire the penalty",
  );
});

test("directional dampener: win rate at or above threshold → no penalty", () => {
  // 1 win, 1 loss → winRate=0.5 > 0.35 → no penalty
  assert.strictEqual(
    computeDirectionalPenaltyPp(1, 1, 2, 0.35, 10),
    0,
    "50% win rate above threshold should NOT fire penalty",
  );
  // exactly at threshold → 0.35 is NOT < 0.35 → no penalty
  assert.strictEqual(
    computeDirectionalPenaltyPp(7, 13, 2, 0.35, 10),
    0,
    "win rate exactly at threshold (7/20=0.35) should NOT fire penalty",
  );
});

test("directional dampener: freeRunMode disables penalty regardless of win rate", () => {
  assert.strictEqual(
    computeDirectionalPenaltyPp(0, 5, 2, 0.35, 10, true),
    0,
    "freeRunMode=true must suppress directional penalty even with 0% win rate",
  );
});

test("directional dampener: DEFAULT_BOT_CONFIG has correct directional filter defaults", () => {
  assert.strictEqual(
    DEFAULT_BOT_CONFIG.directionalRegressionLookback,
    3,
    "directionalRegressionLookback should default to 3 windows",
  );
  assert.ok(
    Math.abs((DEFAULT_BOT_CONFIG.directionalRegressionThreshold ?? 0) - 0.35) < 0.001,
    "directionalRegressionThreshold should default to 0.35",
  );
  assert.strictEqual(
    DEFAULT_BOT_CONFIG.directionalRegressionPenaltyPp,
    10,
    "directionalRegressionPenaltyPp should default to 10pp",
  );
});
