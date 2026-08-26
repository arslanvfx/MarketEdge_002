import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SMART_EXIT_CONFIG, INITIAL_SMART_EXIT_STATE, adverseContinuationScore,
  assessSmartExitDeepLossHold,
  evaluateSmartExit, modelWinProbability, probabilityDropThreshold,
  resolveSmartExitSensitivity,
} from "./kalshi-smart-exit-policy.ts";
import type { SmartExitEvidence, SmartExitPosition } from "./kalshi-smart-exit-types.ts";

test("Smart Exit sensitivity resolver is canonical, immutable, and legacy-safe", () => {
  assert.deepEqual(resolveSmartExitSensitivity("more_aggressive").parameters, {
    debounceCount: 2, confirmationLevel: 0.20,
    minMarketLossFraction: 0.15, crossingReserveFraction: 0.10,
  });
  assert.deepEqual(resolveSmartExitSensitivity("default").parameters, {
    debounceCount: 3, confirmationLevel: 0.35,
    minMarketLossFraction: 0.25, crossingReserveFraction: 0.20,
  });
  assert.deepEqual(resolveSmartExitSensitivity("less_aggressive").parameters, {
    debounceCount: 4, confirmationLevel: 0.50,
    minMarketLossFraction: 0.35, crossingReserveFraction: 0.30,
  });
  assert.equal(resolveSmartExitSensitivity(undefined).sensitivity, "default");
  assert.equal(Object.isFrozen(resolveSmartExitSensitivity("default")), true);
  assert.equal(Object.isFrozen(resolveSmartExitSensitivity("default").parameters), true);
});

const position: SmartExitPosition = {
  positionId: "p", owner: { kind: "regular", tradingMode: "paper" }, symbol: "BTC",
  windowKey: "1970-01-01T00:00", ticker: "KXBTC15M-TEST", remainingQuantity: 1,
  requestedQuantity: 1, entryStake: 0.72,
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
const config = { ...DEFAULT_SMART_EXIT_CONFIG, enabled: true, mode: "shadow" as const, sensitivity: "more_aggressive" as const, debounceCount: 2, confirmationLevel: 0.20, hysteresisSeconds: 0, probabilityShrinkage: 0, fatTailVolatilityMultiplier: 1 };

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
test("near-target adverse movement prepares, then signals only after sustained confirmation", () => {
  const initialState = {
    ...INITIAL_SMART_EXIT_STATE,
    previousUnderlyingPrice: 101,
    previousUnderlyingAtSeconds: 99,
  };
  const current = evidence({
    underlyingPrice: 100.6,
    marketWinProbability: 0.4,
    marketExecutablePrice: 0.9,
  });
  const first = evaluateSmartExit(position, current, initialState, config, 100);
  assert.equal(first.disposition, "PREPARE_EXIT");
  assert.equal(first.crossingRiskConfirmed, false);
  const second = evaluateSmartExit(
    position,
    {
      ...current,
      underlyingPrice: 100.2,
      observedAtSeconds: 101,
      spotReceivedAtSeconds: 101,
      tapeReceivedAtSeconds: 101,
      bookReceivedAtSeconds: 101,
      spotObservedAtSeconds: 101,
      marketQuoteObservedAtSeconds: 101,
      marketBookObservedAtSeconds: 101,
    },
    first.nextState,
    config,
    101,
  );
  assert.equal(second.disposition, "EXIT_SIGNAL");
  assert.equal(second.crossingRiskConfirmed, true);
  assert.equal(second.mayExecuteExit, false);
});
test("fast catastrophic probability drop cannot bypass crossing confirmation", () => {
  const state = {
    ...INITIAL_SMART_EXIT_STATE,
    previousModelProbability: 1,
    previousObservedAtSeconds: 99,
    previousUnderlyingPrice: 151,
    previousUnderlyingAtSeconds: 99,
  };
  const decision = evaluateSmartExit(
    position,
    evidence({
      underlyingPrice: 150,
      volatilityLogReturnPerSqrtSecond: 0.1,
      marketExecutablePrice: 0.9,
      marketWinProbability: 0.2,
    }),
    state,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.notEqual(decision.disposition, "EXIT_SIGNAL");
  assert.equal(decision.crossingRiskConfirmed, false);
  assert.equal(decision.mayExecuteExit, false);
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
  assert.equal(decision.targetAlreadyCrossed, true);
  assert.equal(decision.projectedCrossBeforeExpiry, true);
  assert.equal(decision.disposition, "EXIT_SIGNAL");
  assert.ok(decision.estimatedSaleValue! > decision.expectedHoldValue!);
});

test("80-to-30-cent market collapse only warns when the underlying cannot plausibly cross", () => {
  const decision = evaluateSmartExit(
    {
      ...position,
      marketAtEntry: { winProbability: 0.8, observedAtSeconds: 0 },
    },
    evidence({
      underlyingPrice: 150,
      volatilityLogReturnPerSqrtSecond: 0.00001,
      momentumLogReturn: -0.001,
      marketWinProbability: 0.3,
      marketExecutablePrice: 0.9,
    }),
    INITIAL_SMART_EXIT_STATE,
    config,
    100,
  );
  assert.equal(decision.highRisk, true);
  assert.equal(decision.crossingRiskConfirmed, false);
  assert.equal(decision.disposition, "WATCH");
  assert.match(decision.reason, /repricing.*crossing is not plausible/i);
});

test("a sharp adverse move remains non-executable when distance and volatility make crossing unrealistic", () => {
  const state = {
    ...INITIAL_SMART_EXIT_STATE,
    adverseSampleCount: config.debounceCount,
    previousUnderlyingPrice: 151,
    previousUnderlyingAtSeconds: 99,
    previousAdverseVelocity: 1,
  };
  const decision = evaluateSmartExit(
    position,
    evidence({
      underlyingPrice: 150,
      volatilityLogReturnPerSqrtSecond: 0.00001,
      marketWinProbability: 0.7,
      marketExecutablePrice: 0.9,
    }),
    state,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(decision.projectedCrossBeforeExpiry, true);
  assert.equal(decision.volatilityReachableBeforeExpiry, false);
  assert.equal(decision.crossingRiskConfirmed, false);
  assert.notEqual(decision.disposition, "EXIT_SIGNAL");
  assert.equal(decision.mayExecuteExit, false);
});

test("actual target crossing can escalate immediately but requires complete executable evidence", () => {
  const noDepth = evaluateSmartExit(
    position,
    evidence({ marketExecutableQuantity: null }),
    INITIAL_SMART_EXIT_STATE,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(noDepth.targetAlreadyCrossed, true);
  assert.equal(noDepth.disposition, "PREPARE_EXIT");
  assert.equal(noDepth.mayExecuteExit, false);

  const executable = evaluateSmartExit(
    position,
    evidence({ marketExecutablePrice: 0.9 }),
    INITIAL_SMART_EXIT_STATE,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(executable.disposition, "EXIT_SIGNAL");
  assert.equal(executable.crossingRiskConfirmed, true);
  assert.equal(executable.mayExecuteExit, true);
});

test("actual target crossing does not wait for a 25-percent Kalshi repricing", () => {
  const decision = evaluateSmartExit(
    position,
    evidence({
      marketWinProbability: 0.65,
      marketExecutablePrice: 0.9,
    }),
    INITIAL_SMART_EXIT_STATE,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.ok(decision.marketLossFraction! < 0.25);
  assert.equal(decision.targetAlreadyCrossed, true);
  assert.equal(decision.disposition, "EXIT_SIGNAL");
  assert.equal(decision.mayExecuteExit, true);
});

test("deep-loss recovery protection uses the exact 80/90 percent and 3:30 boundaries", () => {
  const base = {
    remainingSeconds: 210,
    recoveryReachable: true,
    deepLossHoldThreshold: 0.8,
    terminalLossHoldThreshold: 0.9,
    recoveryMinSeconds: 210,
  };
  assert.deepEqual(
    assessSmartExitDeepLossHold({ ...base, capitalLossFraction: 0.799 }),
    { hold: false, kind: "none" },
  );
  assert.deepEqual(
    assessSmartExitDeepLossHold({ ...base, capitalLossFraction: 0.8 }),
    { hold: true, kind: "recovery" },
  );
  assert.deepEqual(
    assessSmartExitDeepLossHold({ ...base, capitalLossFraction: 0.899, remainingSeconds: 209 }),
    { hold: false, kind: "none" },
  );
  assert.deepEqual(
    assessSmartExitDeepLossHold({ ...base, capitalLossFraction: 0.899, recoveryReachable: false }),
    { hold: false, kind: "none" },
  );
  assert.deepEqual(
    assessSmartExitDeepLossHold({
      ...base,
      capitalLossFraction: 0.9,
      remainingSeconds: 1,
      recoveryReachable: false,
    }),
    { hold: true, kind: "terminal" },
  );
});

test("90-percent executable capital loss always blocks a live exit signal", () => {
  const decision = evaluateSmartExit(
    { ...position, entryStake: 1 },
    evidence({ underlyingPrice: 1, marketExecutablePrice: 0.1, marketExecutableQuantity: 1 }),
    INITIAL_SMART_EXIT_STATE,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(decision.capitalLossFraction, 0.9);
  assert.equal(decision.deepLossHoldActive, true);
  assert.equal(decision.deepLossHoldKind, "terminal");
  assert.equal(decision.disposition, "HOLD");
  assert.equal(decision.mayExecuteExit, false);
});

test("deep-loss protection ignores partial and stale executable evidence", () => {
  const partial = evaluateSmartExit(
    { ...position, entryStake: 1 },
    evidence({ underlyingPrice: 1, marketExecutablePrice: 0.05, marketExecutableQuantity: 0.5 }),
    INITIAL_SMART_EXIT_STATE,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(partial.capitalLossFraction, null);
  assert.equal(partial.deepLossHoldActive, false);
  assert.equal(partial.disposition, "PREPARE_EXIT");

  const stale = evaluateSmartExit(
    { ...position, entryStake: 1 },
    evidence({
      underlyingPrice: 1,
      marketExecutablePrice: 0.05,
      marketExecutableQuantity: 1,
      marketQuoteObservedAtSeconds: 1,
      marketBookObservedAtSeconds: 1,
    }),
    INITIAL_SMART_EXIT_STATE,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(stale.capitalLossFraction, null);
  assert.equal(stale.deepLossHoldActive, false);
  assert.notEqual(stale.disposition, "HOLD");
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