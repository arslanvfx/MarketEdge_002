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
  source: "coinbase-rest",
  spotReceivedAtSeconds: 100, tapeReceivedAtSeconds: 100, bookReceivedAtSeconds: 100,
  spotObservedAtSeconds: 100, tapeObservedAtSeconds: 100, bookObservedAtSeconds: 100,
  observedAtSeconds: 100, underlyingPrice: 90, volatilityLogReturnPerSqrtSecond: 0.01,
  momentumLogReturn: -0.04, momentumWindowSeconds: 1, tradeFlowImbalance: -1, bookImbalance: -1,
  marketWinProbability: 0.2, marketQuoteObservedAtSeconds: 100, marketBookObservedAtSeconds: 100,
  marketBestBid: 0.3, marketBestAsk: 0.32, marketExecutablePrice: 0.3,
  marketExecutableQuantity: 10, ...overrides,
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
  assert.notEqual(evaluateSmartExit(position, evidence({ tradeFlowImbalance: null }), INITIAL_SMART_EXIT_STATE, config, 100).disposition, "UNAVAILABLE");
  assert.equal(evaluateSmartExit(position, evidence({ observedAtSeconds: 1 }), INITIAL_SMART_EXIT_STATE, config, 100).disposition, "UNAVAILABLE");
  assert.equal(evaluateSmartExit(position, evidence({ spotReceivedAtSeconds: 1 }), INITIAL_SMART_EXIT_STATE, config, 100).disposition, "UNAVAILABLE");
  assert.equal(evaluateSmartExit({ ...position, underlyingKind: "commodity" }, evidence(), INITIAL_SMART_EXIT_STATE, config, 100).disposition, "UNAVAILABLE");
});
test("confirmation debounces then signals; shadow cannot execute", () => {
  const current = evidence({ marketWinProbability: 0.7, marketExecutablePrice: 0.9 });
  const first = evaluateSmartExit(position, current, INITIAL_SMART_EXIT_STATE, config, 100);
  assert.equal(first.disposition, "WATCH");
  const second = evaluateSmartExit(
    position,
    { ...current, observedAtSeconds: 101, spotReceivedAtSeconds: 101, spotObservedAtSeconds: 101 },
    first.nextState,
    config,
    101,
  );
  assert.equal(second.disposition, "EXIT_SIGNAL");
  assert.equal(second.mayExecuteExit, false);
});
test("fast catastrophic drop bypasses debounce and live flag is only advisory", () => {
  const state = {
    ...INITIAL_SMART_EXIT_STATE,
    previousModelProbability: 0.9,
    previousObservedAtSeconds: 99,
    previousUnderlyingPrice: 101,
    previousUnderlyingAtSeconds: 99,
  };
  const decision = evaluateSmartExit(
    position,
    evidence({ marketExecutablePrice: 0.9 }),
    state,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(decision.disposition, "EXIT_SIGNAL");
  assert.equal(decision.mayExecuteExit, true);
});

test("80-cent entry collapsing below 40 cents escalates immediately with crossing projection and economics", () => {
  const state = {
    ...INITIAL_SMART_EXIT_STATE,
    previousUnderlyingPrice: 101,
    previousUnderlyingAtSeconds: 99,
    previousAdverseVelocity: 0.5,
  };
  const decision = evaluateSmartExit(
    { ...position, marketAtEntry: { winProbability: 0.8, observedAtSeconds: 0 } },
    evidence({
      marketWinProbability: 0.35,
      marketExecutablePrice: 0.34,
      underlyingPrice: 70,
      spotObservedAtSeconds: 100,
    }),
    state,
    config,
    100,
  );
  assert.equal(decision.highRisk, true);
  assert.equal(decision.projectedCrossBeforeExpiry, true);
  assert.equal(decision.disposition, "EXIT_SIGNAL");
  assert.ok(decision.estimatedSaleValue! > decision.expectedHoldValue!);
});

test("quiet tape degrades confidence without erasing the shadow decision", () => {
  const decision = evaluateSmartExit(
    position,
    evidence({
      tapeObservedAtSeconds: 70,
      tradeFlowImbalance: null,
      bookImbalance: -1,
    }),
    INITIAL_SMART_EXIT_STATE,
    config,
    100,
  );
  assert.notEqual(decision.disposition, "UNAVAILABLE");
  assert.ok(decision.degradedComponents.includes("trade_flow"));
});

test("rapid-loss monitoring still works for positions opened before a model baseline was captured", () => {
  const decision = evaluateSmartExit(
    {
      ...position,
      modelAtEntry: { winProbability: null, observedAtSeconds: 0 },
      marketAtEntry: { winProbability: 0.8, observedAtSeconds: 0 },
    },
    evidence({ marketWinProbability: 0.3, marketExecutablePrice: 0.9 }),
    INITIAL_SMART_EXIT_STATE,
    config,
    100,
  );
  assert.notEqual(decision.disposition, "UNAVAILABLE");
  assert.equal(decision.highRisk, true);
  assert.ok(decision.degradedComponents.includes("model_entry_baseline"));
});

test("live execution keeps the decision-time edge and freshness limits immutable", () => {
  const decisionConfig = {
    ...config,
    mode: "live-exit" as const,
    minExitEdge: 0.08,
    maxEvidenceAgeSeconds: 2,
  };
  const decision = evaluateSmartExit(
    position,
    evidence({ marketExecutablePrice: 0.9 }),
    INITIAL_SMART_EXIT_STATE,
    decisionConfig,
    100,
  );
  decisionConfig.minExitEdge = 0;
  decisionConfig.maxEvidenceAgeSeconds = 15;
  assert.equal(
    decision.minimumWinningPrice,
    Math.ceil((decision.modelWinProbability! + 0.08) * 100) / 100,
  );
  assert.equal(decision.maximumExecutionEvidenceAgeSeconds, 2);
  assert.equal(decision.executionEvidenceExpiresAtSeconds, 102);
});