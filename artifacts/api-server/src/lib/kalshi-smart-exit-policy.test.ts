import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SMART_EXIT_CONFIG, INITIAL_SMART_EXIT_STATE, adverseContinuationScore,
  evaluateSmartExit, modelWinProbability, probabilityDropThreshold,
} from "./kalshi-smart-exit-policy.ts";
import type { SmartExitEvidence, SmartExitPosition } from "./kalshi-smart-exit-types.ts";

const position: SmartExitPosition = {
  positionId: "p", owner: { kind: "regular", tradingMode: "paper" }, symbol: "BTC",
  windowKey: "1970-01-01T00:00", ticker: "KXBTC15M-TEST", remainingQuantity: 1,
  exchangeIndex: null, side: "yes", underlyingKind: "crypto",
  strikePrice: 100, expirySeconds: 900, openedAtSeconds: 0,
  modelAtEntry: { winProbability: 0.8, observedAtSeconds: 0 },
  marketAtEntry: { winProbability: 0.72, observedAtSeconds: 0 },
};
const evidence = (overrides: Partial<SmartExitEvidence> = {}): SmartExitEvidence => ({
  source: "coinbase-rest", spotObservedAtSeconds: 100, tapeObservedAtSeconds: 100, bookObservedAtSeconds: 100,
  observedAtSeconds: 100, underlyingPrice: 90, volatilityLogReturnPerSqrtSecond: 0.01,
  momentumLogReturn: -0.04, momentumWindowSeconds: 1, tradeFlowImbalance: -1, bookImbalance: -1,
  marketWinProbability: 0.2, ...overrides,
});
const config = { ...DEFAULT_SMART_EXIT_CONFIG, enabled: true, mode: "shadow" as const, debounceCount: 2, hysteresisSeconds: 0, probabilityShrinkage: 0, fatTailVolatilityMultiplier: 1 };

test("default is disabled and shadow safe", () => {
  assert.equal(DEFAULT_SMART_EXIT_CONFIG.enabled, false);
  assert.equal(DEFAULT_SMART_EXIT_CONFIG.mode, "shadow");
  assert.equal(evaluateSmartExit(position, evidence(), INITIAL_SMART_EXIT_STATE, DEFAULT_SMART_EXIT_CONFIG, 100).disposition, "OFF");
});
test("probability uses log moneyness, seconds, side, tails and shrinkage", () => {
  const yes = modelWinProbability(position, evidence({ underlyingPrice: 110 }), config, 100)!;
  const no = modelWinProbability({ ...position, side: "no" }, evidence({ underlyingPrice: 110 }), config, 100)!;
  assert.ok(yes > 0.5 && no < 0.5);
  assert.ok(modelWinProbability(position, evidence({ underlyingPrice: 110 }), { ...config, probabilityShrinkage: 1 }, 100)! === 0.5);
  assert.ok(modelWinProbability(position, evidence({ underlyingPrice: 110 }), { ...config, fatTailVolatilityMultiplier: 2 }, 100)! < yes);
});
test("threshold follows square root of exact remaining seconds", () => {
  assert.equal(probabilityDropThreshold(900, config), config.baseProbabilityDropThreshold);
  assert.ok(Math.abs(probabilityDropThreshold(225, config) - config.baseProbabilityDropThreshold / 2) < 1e-12);
});
test("continuation is adverse-side aligned", () => {
  assert.ok(adverseContinuationScore("yes", evidence(), config)! > 0);
  assert.ok(adverseContinuationScore("no", evidence(), config)! < 0);
});
test("missing, stale, and commodity evidence fail closed", () => {
  assert.equal(evaluateSmartExit(position, evidence({ tradeFlowImbalance: null }), INITIAL_SMART_EXIT_STATE, config, 100).disposition, "UNAVAILABLE");
  assert.equal(evaluateSmartExit(position, evidence({ observedAtSeconds: 1 }), INITIAL_SMART_EXIT_STATE, config, 100).disposition, "UNAVAILABLE");
  assert.equal(evaluateSmartExit({ ...position, underlyingKind: "commodity" }, evidence(), INITIAL_SMART_EXIT_STATE, config, 100).disposition, "UNAVAILABLE");
});
test("confirmation debounces then signals; shadow cannot execute", () => {
  const first = evaluateSmartExit(position, evidence(), INITIAL_SMART_EXIT_STATE, config, 100);
  assert.equal(first.disposition, "HOLD");
  const second = evaluateSmartExit(position, evidence({ observedAtSeconds: 101 }), first.nextState, config, 101);
  assert.equal(second.disposition, "EXIT_SIGNAL");
  assert.equal(second.mayExecuteExit, false);
});
test("fast catastrophic drop bypasses debounce and live flag is only advisory", () => {
  const state = { ...INITIAL_SMART_EXIT_STATE, previousModelProbability: 0.9, previousObservedAtSeconds: 99 };
  const decision = evaluateSmartExit(position, evidence(), state, { ...config, mode: "live-exit" }, 100);
  assert.equal(decision.disposition, "EXIT_SIGNAL");
  assert.equal(decision.mayExecuteExit, true);
});