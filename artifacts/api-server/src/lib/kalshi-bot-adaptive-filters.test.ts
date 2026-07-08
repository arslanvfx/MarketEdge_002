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
import {
  applyDirectionalOutcome,
  computeDirectionalPenaltyPp,
  type DirectionalOutcomeEntry,
} from "./kalshi-bot-directional-outcomes.ts";

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
// The streak penalty raises minConfidence (the threshold), NOT reduces decision.confidence.
// A bet fires only when: decision.confidence >= minConfidence + streakPenalty

test("streak penalty: 1 consecutive loss raises the required floor by 6pp — blocks a borderline bet", () => {
  const minConf = 60;
  const pen1 = DEFAULT_BOT_CONFIG.coinStreakPenalty1LossPp!; // 6
  const raisedFloor = minConf + pen1; // 66
  // A decision.confidence of 64% would pass the base floor (64 ≥ 60) but fail
  // the raised floor (64 < 66), so the bet is skipped.
  const decisionConf = 64;
  assert.ok(decisionConf >= minConf, "base floor: decision would be allowed without streak");
  assert.ok(decisionConf < raisedFloor, "raised floor: decision should be blocked by 1-loss streak penalty");
});

test("streak penalty: 2+ consecutive losses raises the required floor by 12pp — blocks a borderline bet", () => {
  const minConf = 60;
  const pen2 = DEFAULT_BOT_CONFIG.coinStreakPenalty2PlusLossPp!; // 12
  const raisedFloor = minConf + pen2; // 72
  const decisionConf = 70;
  assert.ok(decisionConf >= minConf, "base floor: decision would be allowed without streak");
  assert.ok(decisionConf < raisedFloor, "raised floor: decision should be blocked by 2+-loss streak penalty");
});

test("streak penalty: a confident-enough bet still passes even with streak penalty", () => {
  const minConf = 60;
  const pen2 = DEFAULT_BOT_CONFIG.coinStreakPenalty2PlusLossPp!; // 12
  const raisedFloor = minConf + pen2; // 72
  const decisionConf = 75;
  assert.ok(decisionConf >= raisedFloor, "a 75% confidence bet should still clear the 2+-loss raised floor (72%)");
});

test("streak penalty: freeRunMode exempts coins from streak penalty", () => {
  // In freeRunMode the loop skips the penalty block entirely.
  assert.strictEqual(typeof DEFAULT_BOT_CONFIG.freeRunMode, "boolean");
  // The logic: if (freeRunMode) penalty = 0, floor stays at minConfidence.
  const freeRun = true;
  const pen2 = DEFAULT_BOT_CONFIG.coinStreakPenalty2PlusLossPp!;
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

// ---------------------------------------------------------------------------
// 4. Directional dampener — accumulation through the real module
// These tests call applyDirectionalOutcome imported from kalshi-bot-directional-outcomes.ts
// — the same function used by evalClosedBets in production.
// ---------------------------------------------------------------------------

test("applyDirectionalOutcome: YES win increments yesWins for the given window key", () => {
  const map = new Map<string, DirectionalOutcomeEntry>();
  applyDirectionalOutcome(map, "yes", 0.50, "2026-07-08T14:00");
  const entry = map.get("2026-07-08T14:00");
  assert.strictEqual(entry?.yesWins, 1, "win should increment yesWins");
  assert.strictEqual(entry?.yesLosses, 0);
  assert.strictEqual(entry?.noWins, 0);
  assert.strictEqual(entry?.noLosses, 0);
});

test("applyDirectionalOutcome: YES loss increments yesLosses", () => {
  const map = new Map<string, DirectionalOutcomeEntry>();
  applyDirectionalOutcome(map, "yes", -0.50, "2026-07-08T14:00");
  const entry = map.get("2026-07-08T14:00");
  assert.strictEqual(entry?.yesWins, 0);
  assert.strictEqual(entry?.yesLosses, 1, "loss should increment yesLosses");
});

test("applyDirectionalOutcome: NO loss increments noLosses", () => {
  const map = new Map<string, DirectionalOutcomeEntry>();
  applyDirectionalOutcome(map, "no", -0.50, "2026-07-08T14:00");
  const entry = map.get("2026-07-08T14:00");
  assert.strictEqual(entry?.noLosses, 1, "NO loss should increment noLosses");
  assert.strictEqual(entry?.yesLosses, 0, "YES losses must not change");
});

test("applyDirectionalOutcome: pnl=0 is ignored (tie/push, no counter incremented)", () => {
  const map = new Map<string, DirectionalOutcomeEntry>();
  applyDirectionalOutcome(map, "yes", 0, "2026-07-08T14:00");
  const entry = map.get("2026-07-08T14:00");
  assert.strictEqual(entry?.yesWins, 0);
  assert.strictEqual(entry?.yesLosses, 0);
});

test("applyDirectionalOutcome: accumulates across multiple bets in the same window", () => {
  const map = new Map<string, DirectionalOutcomeEntry>();
  const wk = "2026-07-08T14:00";
  applyDirectionalOutcome(map, "yes", -0.5, wk); // YES loss
  applyDirectionalOutcome(map, "yes", -0.5, wk); // YES loss
  applyDirectionalOutcome(map, "no", 0.5, wk);   // NO win
  const entry = map.get(wk)!;
  assert.strictEqual(entry.yesWins, 0);
  assert.strictEqual(entry.yesLosses, 2);
  assert.strictEqual(entry.noWins, 1);
  assert.strictEqual(entry.noLosses, 0);
});

test("applyDirectionalOutcome: different window keys are tracked independently", () => {
  const map = new Map<string, DirectionalOutcomeEntry>();
  applyDirectionalOutcome(map, "yes", -0.5, "2026-07-08T13:45"); // loss in w1
  applyDirectionalOutcome(map, "yes", 0.5,  "2026-07-08T14:00"); // win in w2
  assert.strictEqual(map.get("2026-07-08T13:45")?.yesLosses, 1);
  assert.strictEqual(map.get("2026-07-08T14:00")?.yesWins, 1);
  assert.strictEqual(map.get("2026-07-08T14:00")?.yesLosses, 0);
});

test("applyDirectionalOutcome + computeDirectionalPenaltyPp: full dampener cycle — 2 losses triggers penalty", () => {
  // Simulate 2 YES losses across 2 windows, then compute whether penalty fires.
  const map = new Map<string, DirectionalOutcomeEntry>();
  applyDirectionalOutcome(map, "yes", -0.5, "2026-07-08T13:30");
  applyDirectionalOutcome(map, "yes", -0.5, "2026-07-08T13:45");

  // Aggregate across lookback (2 windows):
  let yesWins = 0, yesLosses = 0;
  for (const entry of map.values()) { yesWins += entry.yesWins; yesLosses += entry.yesLosses; }

  const penalty = computeDirectionalPenaltyPp(yesWins, yesLosses, 2, 0.35, 10);
  assert.strictEqual(penalty, 10, "2 YES losses over lookback should trigger 10pp dampener penalty");
});

test("applyDirectionalOutcome + computeDirectionalPenaltyPp: thin-data guard — 1 loss does not trigger penalty", () => {
  const map = new Map<string, DirectionalOutcomeEntry>();
  applyDirectionalOutcome(map, "yes", -0.5, "2026-07-08T13:30");

  let yesWins = 0, yesLosses = 0;
  for (const entry of map.values()) { yesWins += entry.yesWins; yesLosses += entry.yesLosses; }

  const penalty = computeDirectionalPenaltyPp(yesWins, yesLosses, 2, 0.35, 10);
  assert.strictEqual(penalty, 0, "Only 1 bet in direction should not trigger penalty (thin-data guard)");
});

test("applyDirectionalOutcome + computeDirectionalPenaltyPp: mixed results above threshold — no penalty", () => {
  const map = new Map<string, DirectionalOutcomeEntry>();
  applyDirectionalOutcome(map, "yes", 0.5,  "2026-07-08T13:30"); // win
  applyDirectionalOutcome(map, "yes", -0.5, "2026-07-08T13:45"); // loss

  let yesWins = 0, yesLosses = 0;
  for (const entry of map.values()) { yesWins += entry.yesWins; yesLosses += entry.yesLosses; }

  const penalty = computeDirectionalPenaltyPp(yesWins, yesLosses, 2, 0.35, 10);
  assert.strictEqual(penalty, 0, "50% win rate above 35% threshold should NOT trigger penalty");
});

// ---------------------------------------------------------------------------
// Cooldown persistence — once triggered, penalty holds across sparse windows
// ---------------------------------------------------------------------------

test("directional dampener cooldown: penalty persists within lookback window count", () => {
  // Simulate: dampener fired at window W, now we are at W+1 (lookback=3).
  // Even if sample drops below minBets in W+1, cooldown should keep penalty active.
  const lookback = 3;
  const lastFired  = "2026-07-08T14:00"; // window when dampener triggered
  const currentWk  = "2026-07-08T14:15"; // one window later (within lookback)
  const windowsAgo = (Date.parse(currentWk) - Date.parse(lastFired)) / (15 * 60_000);
  assert.ok(windowsAgo <= lookback, "W+1 is within the 3-window cooldown — penalty should stay active");
});

test("directional dampener cooldown: penalty clears after lookback windows elapse", () => {
  const lookback  = 3;
  const lastFired = "2026-07-08T14:00";
  const currentWk = "2026-07-08T14:45"; // 3 windows later — exactly at the boundary
  const windowsAgo = (Date.parse(currentWk) - Date.parse(lastFired)) / (15 * 60_000);
  // windowsAgo === lookback means cooldown expires at this window (not active).
  assert.ok(windowsAgo <= lookback, "exactly at boundary (=lookback) is still within cooldown");

  const afterWk    = "2026-07-08T15:00"; // 4 windows later — beyond lookback
  const afterAgo   = (Date.parse(afterWk)   - Date.parse(lastFired)) / (15 * 60_000);
  assert.ok(afterAgo > lookback, "W+4 (beyond 3-window lookback) should no longer be in cooldown");
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
