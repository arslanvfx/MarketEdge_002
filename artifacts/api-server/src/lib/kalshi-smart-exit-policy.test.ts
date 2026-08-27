import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SMART_EXIT_CONFIG, INITIAL_SMART_EXIT_STATE, adverseContinuationScore,
  assessSmartExitMarketDirection,
  assessSmartExitMarketPressure,
  assessSmartExitTrajectory,
  assessSmartExitTimeScaledRisk,
  assessSmartExitDeepLossHold,
  evaluateSmartExit, modelWinProbability, probabilityDropThreshold,
  resolveSmartExitSensitivity,
  resolveSmartExitTimeBand,
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

const evidenceAt = (
  at: number,
  overrides: Partial<SmartExitEvidence> = {},
): SmartExitEvidence => evidence({
  observedAtSeconds: at,
  spotReceivedAtSeconds: at,
  tapeReceivedAtSeconds: at,
  bookReceivedAtSeconds: at,
  spotObservedAtSeconds: at,
  tapeObservedAtSeconds: at,
  bookObservedAtSeconds: at,
  marketQuoteObservedAtSeconds: at,
  marketBookObservedAtSeconds: at,
  ...overrides,
});

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
  assert.notEqual(evaluateSmartExit(position, evidence({
    underlyingPrice: 110,
    tradeFlowImbalance: null,
  }), INITIAL_SMART_EXIT_STATE, config, 100).disposition, "UNAVAILABLE");
  assert.equal(evaluateSmartExit(position, evidence({ observedAtSeconds: 1 }), INITIAL_SMART_EXIT_STATE, config, 100).disposition, "UNAVAILABLE");
  assert.equal(evaluateSmartExit(position, evidence({ spotReceivedAtSeconds: 1 }), INITIAL_SMART_EXIT_STATE, config, 100).disposition, "UNAVAILABLE");
  assert.equal(evaluateSmartExit({ ...position, underlyingKind: "commodity" }, evidence(), INITIAL_SMART_EXIT_STATE, config, 100).disposition, "UNAVAILABLE");
});

test("missing trade flow blocks execution without erasing fresh spot trajectory", () => {
  const first = evaluateSmartExit(
    { ...position, expirySeconds: 900 },
    evidenceAt(745, {
      underlyingPrice: 99.99,
      volatilityLogReturnPerSqrtSecond: 0.0001,
      momentumLogReturn: -0.0002,
      tradeFlowImbalance: null,
      marketWinProbability: 0.52,
      marketBestBid: 0.51,
      marketBestAsk: 0.53,
      marketExecutablePrice: 0.51,
    }),
    {
      ...INITIAL_SMART_EXIT_STATE,
      previousUnderlyingPrice: 100.02,
      previousUnderlyingAtSeconds: 744,
    },
    config,
    745,
  );
  assert.equal(first.disposition, "UNAVAILABLE");
  assert.equal(first.targetAlreadyCrossed, true);
  assert.ok(first.nextState.trajectorySamples.length >= 2);
  assert.equal(first.nextState.targetCrossedSinceSeconds, 745);

  const second = evaluateSmartExit(
    { ...position, expirySeconds: 900 },
    evidenceAt(747, {
      underlyingPrice: 99.97,
      volatilityLogReturnPerSqrtSecond: 0.0001,
      momentumLogReturn: -0.0003,
      tradeFlowImbalance: null,
      marketWinProbability: 0.51,
      marketBestBid: 0.50,
      marketBestAsk: 0.52,
      marketExecutablePrice: 0.50,
    }),
    first.nextState,
    config,
    747,
  );
  assert.equal(second.disposition, "UNAVAILABLE");
  assert.ok(second.nextState.trajectorySamples.length >= 3);
  assert.equal(second.adverseLatchActive, true);
  assert.equal(second.targetCrossedDurationSeconds, 2);
});

test("one low Kalshi print or an unhealthy book cannot create value-preservation pressure", () => {
  const single = assessSmartExitMarketPressure({
    nowSeconds: 745,
    remainingSeconds: 155,
    observedAtSeconds: 745,
    bestBid: 0.49,
    bestAsk: 0.51,
    executablePrice: 0.49,
    liquidityCoverage: 1,
    marketLossFraction: 0.42,
    previousState: INITIAL_SMART_EXIT_STATE,
    maximumEventAgeSeconds: 3,
  });
  assert.equal(single.pressureConfirmed, false);
  assert.equal(single.lowDurationSeconds, 0);

  const wide = assessSmartExitMarketPressure({
    nowSeconds: 749,
    remainingSeconds: 151,
    observedAtSeconds: 749,
    bestBid: 0.45,
    bestAsk: 0.64,
    executablePrice: 0.45,
    liquidityCoverage: 1,
    marketLossFraction: 0.47,
    previousState: {
      ...INITIAL_SMART_EXIT_STATE,
      marketPressureSamples: single.samples,
      marketLowSinceSeconds: 745,
      marketCollapseLatchUntilSeconds: 753,
    },
    maximumEventAgeSeconds: 3,
  });
  assert.equal(wide.bookHealthy, false);
  assert.equal(wide.pressureConfirmed, false);
  assert.equal(wide.collapseLatchActive, false);
});

test("flat low books cannot re-arm an expired collapse latch", () => {
  const first = assessSmartExitMarketPressure({
    nowSeconds: 100,
    remainingSeconds: 150,
    observedAtSeconds: 100,
    bestBid: 0.50,
    bestAsk: 0.52,
    executablePrice: 0.50,
    liquidityCoverage: 1,
    marketLossFraction: 0.4,
    previousState: INITIAL_SMART_EXIT_STATE,
    maximumEventAgeSeconds: 3,
  });
  assert.equal(first.collapseLatchActive, true);

  const flatAfterExpiry = assessSmartExitMarketPressure({
    nowSeconds: 109,
    remainingSeconds: 141,
    observedAtSeconds: 109,
    bestBid: 0.50,
    bestAsk: 0.52,
    executablePrice: 0.50,
    liquidityCoverage: 1,
    marketLossFraction: 0.4,
    previousState: {
      ...INITIAL_SMART_EXIT_STATE,
      marketPressureSamples: first.samples,
      marketCollapseLatchUntilSeconds: first.collapseLatchUntilSeconds,
      marketLowSinceSeconds: first.lowSinceSeconds,
    },
    maximumEventAgeSeconds: 3,
  });
  assert.equal(flatAfterExpiry.collapseLatchActive, false);
  assert.equal(flatAfterExpiry.pressureConfirmed, false);
  assert.equal(flatAfterExpiry.lowDurationSeconds, 0);
});

test("spot and Kalshi feed gaps reset value-preservation persistence", () => {
  const decision = evaluateSmartExit(
    {
      ...position,
      expirySeconds: 300,
      entryStake: 0.85,
      marketAtEntry: { winProbability: 0.85, observedAtSeconds: 0 },
    },
    evidenceAt(120, {
      underlyingPrice: 99.98,
      volatilityLogReturnPerSqrtSecond: 0.0001,
      momentumLogReturn: -0.0003,
      tradeFlowImbalance: null,
      marketWinProbability: 0.49,
      marketBestBid: 0.48,
      marketBestAsk: 0.50,
      marketExecutablePrice: 0.48,
      marketExecutableQuantity: 10,
    }),
    {
      ...INITIAL_SMART_EXIT_STATE,
      previousUnderlyingPrice: 99.99,
      previousUnderlyingAtSeconds: 110,
      targetCrossedSinceSeconds: 105,
      marketPressureSamples: [{
        observedAtSeconds: 110,
        bestBid: 0.48,
        bestAsk: 0.50,
        executablePrice: 0.48,
        liquidityCoverage: 1,
      }],
      marketCollapseLatchUntilSeconds: 130,
      marketLowSinceSeconds: 105,
    },
    { ...config, mode: "live-exit" },
    120,
  );
  assert.equal(decision.targetCrossedDurationSeconds, 0);
  assert.equal(decision.marketLowDurationSeconds, 0);
  assert.equal(decision.marketPressureConfirmed, false);
  assert.notEqual(decision.disposition, "EXIT_SIGNAL");
});

test("persistent losing-side spot plus healthy low Kalshi depth preserves value inside three minutes", () => {
  const liveConfig = { ...config, mode: "live-exit" as const };
  const livePosition = {
    ...position,
    expirySeconds: 900,
    entryStake: 0.85,
    marketAtEntry: { winProbability: 0.85, observedAtSeconds: 700 },
  };
  const first = evaluateSmartExit(
    livePosition,
    evidenceAt(745, {
      underlyingPrice: 99.99,
      volatilityLogReturnPerSqrtSecond: 0.0001,
      momentumLogReturn: -0.0002,
      tradeFlowImbalance: null,
      marketWinProbability: 0.52,
      marketBestBid: 0.51,
      marketBestAsk: 0.53,
      marketExecutablePrice: 0.51,
      marketExecutableQuantity: 10,
    }),
    {
      ...INITIAL_SMART_EXIT_STATE,
      previousUnderlyingPrice: 100.02,
      previousUnderlyingAtSeconds: 744,
    },
    liveConfig,
    745,
  );
  assert.equal(first.disposition, "UNAVAILABLE");

  const second = evaluateSmartExit(
    livePosition,
    evidenceAt(747, {
      underlyingPrice: 99.98,
      volatilityLogReturnPerSqrtSecond: 0.0001,
      momentumLogReturn: -0.0003,
      tradeFlowImbalance: null,
      marketWinProbability: 0.50,
      marketBestBid: 0.49,
      marketBestAsk: 0.51,
      marketExecutablePrice: 0.49,
      marketExecutableQuantity: 10,
    }),
    first.nextState,
    liveConfig,
    747,
  );
  assert.equal(second.disposition, "UNAVAILABLE");

  const third = evaluateSmartExit(
    livePosition,
    evidenceAt(749, {
      underlyingPrice: 99.975,
      volatilityLogReturnPerSqrtSecond: 0.0001,
      momentumLogReturn: -0.00035,
      tradeFlowImbalance: null,
      marketWinProbability: 0.495,
      marketBestBid: 0.485,
      marketBestAsk: 0.505,
      marketExecutablePrice: 0.485,
      marketExecutableQuantity: 10,
    }),
    second.nextState,
    liveConfig,
    749,
  );
  assert.equal(third.disposition, "UNAVAILABLE");

  const fourth = evaluateSmartExit(
    livePosition,
    evidenceAt(751, {
      underlyingPrice: 99.97,
      volatilityLogReturnPerSqrtSecond: 0.0001,
      momentumLogReturn: -0.0004,
      tradeFlowImbalance: null,
      marketWinProbability: 0.49,
      marketBestBid: 0.48,
      marketBestAsk: 0.50,
      marketExecutablePrice: 0.48,
      marketExecutableQuantity: 10,
    }),
    third.nextState,
    liveConfig,
    751,
  );
  assert.equal(fourth.disposition, "EXIT_SIGNAL");
  assert.equal(fourth.mayExecuteExit, true);
  assert.equal(fourth.valuePreservationTriggered, true);
  assert.equal(fourth.marketPressureConfirmed, true);
  assert.ok(fourth.targetCrossedDurationSeconds >= 5);
  assert.match(fourth.reason, /full-depth Kalshi value/i);
});

test("final-three-minute value preservation is symmetric for a held NO position", () => {
  const liveConfig = { ...config, mode: "live-exit" as const };
  const livePosition = {
    ...position,
    side: "no" as const,
    expirySeconds: 900,
    entryStake: 0.85,
    marketAtEntry: { winProbability: 0.85, observedAtSeconds: 700 },
  };
  const samples = [
    { at: 745, spot: 100.01, probability: 0.52, bid: 0.51, ask: 0.53 },
    { at: 747, spot: 100.015, probability: 0.51, bid: 0.50, ask: 0.52 },
    { at: 749, spot: 100.02, probability: 0.50, bid: 0.49, ask: 0.51 },
    { at: 751, spot: 100.03, probability: 0.49, bid: 0.48, ask: 0.50 },
  ];
  let state = {
    ...INITIAL_SMART_EXIT_STATE,
    previousUnderlyingPrice: 99.98,
    previousUnderlyingAtSeconds: 744,
  };
  let decision = evaluateSmartExit(
    livePosition,
    evidenceAt(samples[0].at, {
      underlyingPrice: samples[0].spot,
      volatilityLogReturnPerSqrtSecond: 0.0001,
      momentumLogReturn: 0.0002,
      tradeFlowImbalance: null,
      bookImbalance: 1,
      marketWinProbability: samples[0].probability,
      marketBestBid: samples[0].bid,
      marketBestAsk: samples[0].ask,
      marketExecutablePrice: samples[0].bid,
      marketExecutableQuantity: 10,
    }),
    state,
    liveConfig,
    samples[0].at,
  );
  state = decision.nextState;
  for (const sample of samples.slice(1)) {
    decision = evaluateSmartExit(
      livePosition,
      evidenceAt(sample.at, {
        underlyingPrice: sample.spot,
        volatilityLogReturnPerSqrtSecond: 0.0001,
        momentumLogReturn: 0.0003,
        tradeFlowImbalance: null,
        bookImbalance: 1,
        marketWinProbability: sample.probability,
        marketBestBid: sample.bid,
        marketBestAsk: sample.ask,
        marketExecutablePrice: sample.bid,
        marketExecutableQuantity: 10,
      }),
      state,
      liveConfig,
      sample.at,
    );
    state = decision.nextState;
  }
  assert.equal(decision.disposition, "EXIT_SIGNAL");
  assert.equal(decision.valuePreservationTriggered, true);
  assert.equal(decision.mayExecuteExit, true);
});

test("value-preservation pressure clears immediately when the held-side book recovers", () => {
  const pressure = assessSmartExitMarketPressure({
    nowSeconds: 750,
    remainingSeconds: 150,
    observedAtSeconds: 750,
    bestBid: 0.63,
    bestAsk: 0.65,
    executablePrice: 0.63,
    liquidityCoverage: 1,
    marketLossFraction: 0.25,
    previousState: {
      ...INITIAL_SMART_EXIT_STATE,
      marketLowSinceSeconds: 744,
      marketCollapseLatchUntilSeconds: 755,
      marketPressureSamples: [{
        observedAtSeconds: 748,
        bestBid: 0.49,
        bestAsk: 0.51,
        executablePrice: 0.49,
        liquidityCoverage: 1,
      }],
    },
    maximumEventAgeSeconds: 3,
  });
  assert.equal(pressure.pressureConfirmed, false);
  assert.equal(pressure.collapseLatchActive, false);
  assert.equal(pressure.lowSinceSeconds, null);
});
test("near-target adverse movement remains watch-only in the monitor band", () => {
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
  assert.equal(first.disposition, "WATCH");
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
  assert.equal(second.disposition, "WATCH");
  assert.equal(second.crossingRiskConfirmed, false);
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

test("an early market collapse cannot exit without fresh Kalshi direction confirmation", () => {
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
  assert.equal(decision.disposition, "WATCH");
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

test("actual target crossing remains watch-only early even with complete executable evidence", () => {
  const noDepth = evaluateSmartExit(
    position,
    evidence({ marketExecutableQuantity: null }),
    INITIAL_SMART_EXIT_STATE,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(noDepth.targetAlreadyCrossed, true);
  assert.equal(noDepth.disposition, "WATCH");
  assert.equal(noDepth.mayExecuteExit, false);

  const executable = evaluateSmartExit(
    position,
    evidence({ marketExecutablePrice: 0.9 }),
    INITIAL_SMART_EXIT_STATE,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(executable.disposition, "WATCH");
  assert.equal(executable.crossingRiskConfirmed, false);
  assert.equal(executable.mayExecuteExit, false);
});

test("target crossing during collector warm-up is unavailable then returns to early monitoring", () => {
  const warming = evaluateSmartExit(
    position,
    evidence({
      momentumLogReturn: null,
      momentumWindowSeconds: null,
      tradeFlowImbalance: null,
    }),
    INITIAL_SMART_EXIT_STATE,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(warming.disposition, "UNAVAILABLE");
  assert.equal(warming.mayExecuteExit, false);
  assert.deepEqual(warming.degradedComponents, ["momentum", "trade_flow"]);
  assert.match(warming.reason, /target crossed.*unavailable/i);

  const recovered = evaluateSmartExit(
    position,
    evidence({
      observedAtSeconds: 101,
      spotReceivedAtSeconds: 101,
      tapeReceivedAtSeconds: 101,
      bookReceivedAtSeconds: 101,
      spotObservedAtSeconds: 101,
      tapeObservedAtSeconds: 101,
      bookObservedAtSeconds: 101,
      marketQuoteObservedAtSeconds: 101,
      marketBookObservedAtSeconds: 101,
      marketExecutablePrice: 0.9,
    }),
    warming.nextState,
    { ...config, mode: "live-exit" },
    101,
  );
  assert.equal(recovered.disposition, "WATCH");
  assert.equal(recovered.mayExecuteExit, false);
});

test("crossed target missing volatility keeps the crossing-specific unavailable reason", () => {
  const decision = evaluateSmartExit(
    position,
    evidence({ volatilityLogReturnPerSqrtSecond: null }),
    INITIAL_SMART_EXIT_STATE,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(decision.disposition, "UNAVAILABLE");
  assert.deepEqual(decision.degradedComponents, ["volatility"]);
  assert.match(decision.reason, /target crossed.*volatility/i);
});

test("actual target crossing alone cannot bypass the time-scaled policy", () => {
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
  assert.equal(decision.disposition, "WATCH");
  assert.equal(decision.mayExecuteExit, false);
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

test("90-percent capital loss assessment remains a terminal hold", () => {
  const decision = evaluateSmartExit(
    { ...position, entryStake: 1 },
    evidence({ underlyingPrice: 1, marketExecutablePrice: 0.1, marketExecutableQuantity: 1 }),
    INITIAL_SMART_EXIT_STATE,
    { ...config, mode: "live-exit" },
    100,
  );
  assert.equal(decision.capitalLossFraction, 0.9);
  assert.deepEqual(assessSmartExitDeepLossHold({
    capitalLossFraction: decision.capitalLossFraction,
    remainingSeconds: 800,
    recoveryReachable: false,
    deepLossHoldThreshold: 0.8,
    terminalLossHoldThreshold: 0.9,
    recoveryMinSeconds: 210,
  }), { hold: true, kind: "terminal" });
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
  assert.equal(partial.disposition, "WATCH");

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
      underlyingPrice: 110,
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

test("time bands use exact remaining-second boundaries", () => {
  assert.equal(resolveSmartExitTimeBand(421).band, "monitor");
  assert.equal(resolveSmartExitTimeBand(420).band, "monitor");
  assert.equal(resolveSmartExitTimeBand(241).band, "monitor");
  assert.equal(resolveSmartExitTimeBand(240).band, "escalation");
  assert.equal(resolveSmartExitTimeBand(181).band, "escalation");
  assert.equal(resolveSmartExitTimeBand(180).band, "urgent");
  assert.equal(resolveSmartExitTimeBand(61).band, "urgent");
  assert.equal(resolveSmartExitTimeBand(60).band, "critical");
  assert.equal(resolveSmartExitTimeBand(0).band, "critical");
});

test("the same shallow crossing becomes actionable only as time runs out", () => {
  const assess = (remainingSeconds: number) => assessSmartExitTimeScaledRisk({
    side: "no",
    underlyingPrice: 100.10,
    strikePrice: 100,
    remainingSeconds,
    volatilityLogReturnPerSqrtSecond: 0.00001,
    fatTailVolatilityMultiplier: 1,
    directionalCount: 4,
    continuationAdverse: true,
    targetAlreadyCrossed: true,
    projectedCrossingConfirmed: true,
    marketDirectionConfirmed: true,
  });
  assert.equal(assess(241).timeBand, "monitor");
  assert.equal(assess(241).actionable, false);
  assert.equal(assess(240).timeBand, "escalation");
  assert.equal(assess(240).actionable, false);
  assert.equal(assess(180).timeBand, "urgent");
  assert.equal(assess(180).actionable, true);
  assert.equal(assess(60).timeBand, "critical");
  assert.equal(assess(60).actionable, true);
});

test("a roughly 0.25-percent BTC displacement is the early extreme floor, not a dollar constant", () => {
  const below = assessSmartExitTimeScaledRisk({
    side: "no",
    underlyingPrice: 100_249,
    strikePrice: 100_000,
    remainingSeconds: 300,
    volatilityLogReturnPerSqrtSecond: 0.00001,
    fatTailVolatilityMultiplier: 1,
    directionalCount: 4,
    continuationAdverse: true,
    targetAlreadyCrossed: true,
    projectedCrossingConfirmed: true,
    marketDirectionConfirmed: true,
  });
  const beyond = assessSmartExitTimeScaledRisk({
    ...{
      side: "no" as const,
      strikePrice: 100_000,
      remainingSeconds: 300,
      volatilityLogReturnPerSqrtSecond: 0.00001,
      fatTailVolatilityMultiplier: 1,
      directionalCount: 4,
      continuationAdverse: true,
      targetAlreadyCrossed: true,
      projectedCrossingConfirmed: true,
      marketDirectionConfirmed: true,
    },
    underlyingPrice: 100_301,
  });
  assert.equal(below.timeBand, "monitor");
  assert.equal(below.actionable, false);
  assert.equal(beyond.actionable, true);
  assert.ok(below.requiredAdverseTargetDistanceFraction >= 0.0025);
  assert.ok(beyond.adverseTargetDistanceFraction > below.adverseTargetDistanceFraction);
});

test("fresh held-side Kalshi direction requires consecutive adverse samples and resets on recovery", () => {
  const first = assessSmartExitMarketDirection({
    currentProbability: 0.62,
    currentObservedAtSeconds: 101,
    previousProbability: 0.70,
    previousObservedAtSeconds: 100,
    previousSampleCount: 0,
    maximumGapSeconds: 3,
    requiredSampleCount: 2,
    marketLossFraction: 0.25,
    minimumMarketLossFraction: 0.20,
  });
  assert.equal(first.direction, "adverse");
  assert.equal(first.sampleCount, 1);
  assert.equal(first.confirmed, false);
  const second = assessSmartExitMarketDirection({
    currentProbability: 0.55,
    currentObservedAtSeconds: 102,
    previousProbability: 0.62,
    previousObservedAtSeconds: 101,
    previousSampleCount: first.sampleCount,
    maximumGapSeconds: 3,
    requiredSampleCount: 2,
    marketLossFraction: 0.30,
    minimumMarketLossFraction: 0.20,
  });
  assert.equal(second.confirmed, true);
  assert.ok(second.adverseSlopePerSecond! > 0);
  const recovery = assessSmartExitMarketDirection({
    currentProbability: 0.60,
    currentObservedAtSeconds: 103,
    previousProbability: 0.55,
    previousObservedAtSeconds: 102,
    previousSampleCount: second.sampleCount,
    maximumGapSeconds: 3,
    requiredSampleCount: 2,
    marketLossFraction: 0.25,
    minimumMarketLossFraction: 0.20,
  });
  assert.equal(recovery.direction, "recovering");
  assert.equal(recovery.sampleCount, 0);
  assert.equal(recovery.confirmed, false);
});

test("duplicate event-time samples preserve a bounded adverse latch without inventing direction", () => {
  const first = assessSmartExitTrajectory({
    side: "yes",
    strikePrice: 100,
    price: 99.92,
    observedAtSeconds: 100,
    nowSeconds: 100,
    remainingSeconds: 50,
    maximumEventAgeSeconds: 3,
    previousState: {
      ...INITIAL_SMART_EXIT_STATE,
      previousUnderlyingPrice: 100.02,
      previousUnderlyingAtSeconds: 99.5,
    },
  });
  assert.equal(first.distinctSampleAdded, true);
  assert.equal(first.adverseLatchActive, true);
  assert.ok(first.adverseVelocityPerSecond! > 0);
  const duplicate = assessSmartExitTrajectory({
    side: "yes",
    strikePrice: 100,
    price: 99.92,
    observedAtSeconds: 100,
    nowSeconds: 100.5,
    remainingSeconds: 49.5,
    maximumEventAgeSeconds: 3,
    previousState: {
      ...INITIAL_SMART_EXIT_STATE,
      trajectorySamples: first.samples,
      adverseLatchUntilSeconds: first.adverseLatchUntilSeconds,
      adverseExcursionFraction: first.adverseExcursionFraction,
      latchedAdverseVelocityPerSecond: first.adverseVelocityPerSecond,
      latchedAdverseAccelerationPerSecond2: first.adverseAccelerationPerSecond2,
    },
  });
  assert.equal(duplicate.distinctSampleAdded, false);
  assert.equal(duplicate.adverseLatchActive, true);
  assert.equal(duplicate.samples.length, first.samples.length);
  assert.equal(duplicate.adverseVelocityPerSecond, first.adverseVelocityPerSecond);
});

test("two genuine recovery events clear the latch and stale evidence clears immediately", () => {
  const baseState = {
    ...INITIAL_SMART_EXIT_STATE,
    trajectorySamples: [
      { observedAtSeconds: 100, price: 100.1 },
      { observedAtSeconds: 101, price: 99.9 },
    ],
    adverseLatchUntilSeconds: 110,
    adverseExcursionFraction: 0.002,
    latchedAdverseVelocityPerSecond: 0.2,
  };
  const recoveryOne = assessSmartExitTrajectory({
    side: "yes", strikePrice: 100, price: 99.95,
    observedAtSeconds: 102, nowSeconds: 102, remainingSeconds: 50,
    maximumEventAgeSeconds: 3, previousState: baseState,
  });
  assert.equal(recoveryOne.recoveryProgress, 1);
  const recoveryTwo = assessSmartExitTrajectory({
    side: "yes", strikePrice: 100, price: 100.0,
    observedAtSeconds: 103, nowSeconds: 103, remainingSeconds: 49,
    maximumEventAgeSeconds: 3,
    previousState: {
      ...baseState,
      trajectorySamples: recoveryOne.samples,
      adverseRecoverySampleCount: recoveryOne.recoveryProgress,
      adverseLatchUntilSeconds: recoveryOne.adverseLatchUntilSeconds,
      adverseExcursionFraction: recoveryOne.adverseExcursionFraction,
    },
  });
  assert.equal(recoveryTwo.adverseLatchActive, false);
  const stale = assessSmartExitTrajectory({
    side: "yes", strikePrice: 100, price: 99.9,
    observedAtSeconds: 100, nowSeconds: 104, remainingSeconds: 48,
    maximumEventAgeSeconds: 3, previousState: baseState,
  });
  assert.equal(stale.adverseLatchActive, false);
  assert.deepEqual(stale.samples, []);
});

test("abrupt final-minute adverse excursions are symmetric for held YES and NO", () => {
  const assess = (side: "yes" | "no", previousPrice: number, price: number) =>
    assessSmartExitTrajectory({
      side, strikePrice: 100, price,
      observedAtSeconds: 100, nowSeconds: 100, remainingSeconds: 60,
      maximumEventAgeSeconds: 3,
      previousState: {
        ...INITIAL_SMART_EXIT_STATE,
        previousUnderlyingPrice: previousPrice,
        previousUnderlyingAtSeconds: 99.5,
      },
    });
  const yes = assess("yes", 100.05, 99.95);
  const no = assess("no", 99.95, 100.05);
  assert.equal(yes.adverseLatchActive, true);
  assert.equal(no.adverseLatchActive, true);
  assert.ok(Math.abs(yes.adverseExcursionFraction - no.adverseExcursionFraction) < 1e-12);
});

test("critical crossing can proceed without tape flow but still requires liquidity and economics", () => {
  const state = {
    ...INITIAL_SMART_EXIT_STATE,
    previousUnderlyingPrice: 100.05,
    previousUnderlyingAtSeconds: 869,
    previousMarketWinProbability: 0.7,
    previousMarketObservedAtSeconds: 869,
  };
  const decision = evaluateSmartExit(
    { ...position, expirySeconds: 900 },
    evidence({
      observedAtSeconds: 870,
      spotReceivedAtSeconds: 870,
      tapeReceivedAtSeconds: null,
      bookReceivedAtSeconds: 870,
      spotObservedAtSeconds: 870,
      tapeObservedAtSeconds: null,
      bookObservedAtSeconds: 870,
      underlyingPrice: 99.9,
      tradeFlowImbalance: null,
      marketWinProbability: 0.1,
      marketQuoteObservedAtSeconds: 870,
      marketBookObservedAtSeconds: 870,
      marketExecutablePrice: 0.2,
      marketExecutableQuantity: null,
    }),
    state,
    { ...config, mode: "live-exit" },
    870,
  );
  assert.equal(decision.timeBand, "critical");
  assert.notEqual(decision.disposition, "UNAVAILABLE");
  assert.equal(decision.executionEvidenceReady, false);
  assert.notEqual(decision.disposition, "EXIT_SIGNAL");
});

test("fresh tape transport with stale trade events cannot authorize a non-critical exit", () => {
  const decision = evaluateSmartExit(
    { ...position, expirySeconds: 900 },
    evidence({
      observedAtSeconds: 700,
      spotReceivedAtSeconds: 700,
      tapeReceivedAtSeconds: 700,
      bookReceivedAtSeconds: 700,
      spotObservedAtSeconds: 700,
      tapeObservedAtSeconds: 690,
      bookObservedAtSeconds: 700,
      underlyingPrice: 99.8,
      tradeFlowImbalance: -0.9,
      bookImbalance: -0.8,
      marketWinProbability: 0.1,
      marketQuoteObservedAtSeconds: 700,
      marketBookObservedAtSeconds: 700,
      marketExecutablePrice: 0.2,
      marketExecutableQuantity: 10,
    }),
    {
      ...INITIAL_SMART_EXIT_STATE,
      previousUnderlyingPrice: 100.05,
      previousUnderlyingAtSeconds: 699,
      previousMarketWinProbability: 0.7,
      previousMarketObservedAtSeconds: 699,
    },
    { ...config, mode: "live-exit" },
    700,
  );
  assert.equal(decision.timeBand, "escalation");
  assert.equal(decision.disposition, "UNAVAILABLE");
  assert.match(decision.reason, /trade_flow/);
  assert.equal(decision.mayExecuteExit, false);
});

test("stale, flat, and disagreeing Kalshi evidence cannot authorize an exit", () => {
  const stale = assessSmartExitMarketDirection({
    currentProbability: 0.40,
    currentObservedAtSeconds: 110,
    previousProbability: 0.70,
    previousObservedAtSeconds: 100,
    previousSampleCount: 10,
    maximumGapSeconds: 3,
    requiredSampleCount: 1,
    marketLossFraction: 0.5,
    minimumMarketLossFraction: 0.05,
  });
  assert.equal(stale.direction, "unknown");
  assert.equal(stale.confirmed, false);
  const flat = assessSmartExitMarketDirection({
    currentProbability: 0.7005,
    currentObservedAtSeconds: 101,
    previousProbability: 0.70,
    previousObservedAtSeconds: 100,
    previousSampleCount: 10,
    maximumGapSeconds: 3,
    requiredSampleCount: 1,
    marketLossFraction: 0.5,
    minimumMarketLossFraction: 0.05,
  });
  assert.equal(flat.direction, "flat");
  assert.equal(flat.confirmed, false);
  const duplicate = assessSmartExitMarketDirection({
    currentProbability: 0.20,
    currentObservedAtSeconds: 101,
    previousProbability: 0.20,
    previousObservedAtSeconds: 101,
    previousSampleCount: 10,
    maximumGapSeconds: 3,
    requiredSampleCount: 1,
    marketLossFraction: 0.75,
    minimumMarketLossFraction: 0.05,
  });
  assert.equal(duplicate.direction, "flat");
  assert.equal(duplicate.sampleCount, 10);
  assert.equal(duplicate.confirmed, false);
  const risk = assessSmartExitTimeScaledRisk({
    side: "yes",
    underlyingPrice: 99,
    strikePrice: 100,
    remainingSeconds: 30,
    volatilityLogReturnPerSqrtSecond: 0.001,
    fatTailVolatilityMultiplier: 1,
    directionalCount: 4,
    continuationAdverse: true,
    targetAlreadyCrossed: true,
    projectedCrossingConfirmed: true,
    marketDirectionConfirmed: false,
  });
  assert.equal(risk.actionable, false);
});

test("an unchanged Kalshi event cannot reauthorize a critical live exit", () => {
  const decision = evaluateSmartExit(
    { ...position, expirySeconds: 900 },
    evidence({
      observedAtSeconds: 870,
      spotReceivedAtSeconds: 870,
      tapeReceivedAtSeconds: null,
      bookReceivedAtSeconds: 870,
      spotObservedAtSeconds: 870,
      tapeObservedAtSeconds: null,
      bookObservedAtSeconds: 870,
      underlyingPrice: 99.9,
      tradeFlowImbalance: null,
      marketWinProbability: 0.1,
      marketQuoteObservedAtSeconds: 870,
      marketBookObservedAtSeconds: 870,
      marketExecutablePrice: 0.2,
      marketExecutableQuantity: 10,
    }),
    {
      ...INITIAL_SMART_EXIT_STATE,
      adverseSampleCount: 3,
      marketAdverseSampleCount: 3,
      previousUnderlyingPrice: 100.05,
      previousUnderlyingAtSeconds: 869,
      previousMarketWinProbability: 0.1,
      previousMarketObservedAtSeconds: 870,
    },
    { ...config, mode: "live-exit" },
    870,
  );
  assert.equal(decision.timeBand, "critical");
  assert.equal(decision.marketDirection, "flat");
  assert.equal(decision.marketDirectionSampleCount, 3);
  assert.equal(decision.marketDirectionConfirmed, false);
  assert.notEqual(decision.disposition, "EXIT_SIGNAL");
  assert.equal(decision.mayExecuteExit, false);
});

test("final-minute projected crossing is actionable before the target only with both confirmations", () => {
  const base = {
    side: "yes" as const,
    underlyingPrice: 100.05,
    strikePrice: 100,
    remainingSeconds: 59,
    volatilityLogReturnPerSqrtSecond: 0.001,
    fatTailVolatilityMultiplier: 1,
    directionalCount: 2,
    continuationAdverse: true,
    targetAlreadyCrossed: false,
    projectedCrossingConfirmed: true,
    marketDirectionConfirmed: true,
  };
  assert.equal(assessSmartExitTimeScaledRisk(base).actionable, true);
  assert.equal(assessSmartExitTimeScaledRisk({
    ...base,
    marketDirectionConfirmed: false,
  }).actionable, false);
  assert.equal(assessSmartExitTimeScaledRisk({
    ...base,
    continuationAdverse: false,
  }).actionable, false);
});

test("ZEC-style shallow crossing with 131 seconds left cannot jump directly to exit", () => {
  const zecPosition: SmartExitPosition = {
    ...position,
    positionId: "zec-regression",
    symbol: "ZEC",
    side: "no",
    strikePrice: 817.7313,
    expirySeconds: 900,
    entryStake: 1.74,
    marketAtEntry: { winProbability: 0.87, observedAtSeconds: 0 },
  };
  const state = {
    ...INITIAL_SMART_EXIT_STATE,
    adverseSampleCount: 3,
    marketAdverseSampleCount: 1,
    previousUnderlyingPrice: 817.80,
    previousUnderlyingAtSeconds: 768,
    previousAdverseVelocity: 0.05,
    previousMarketWinProbability: 0.58,
    previousMarketObservedAtSeconds: 768,
  };
  const decision = evaluateSmartExit(
    zecPosition,
    evidence({
      observedAtSeconds: 769,
      spotReceivedAtSeconds: 769,
      tapeReceivedAtSeconds: 769,
      bookReceivedAtSeconds: 769,
      spotObservedAtSeconds: 769,
      tapeObservedAtSeconds: 769,
      bookObservedAtSeconds: 769,
      underlyingPrice: 817.88,
      volatilityLogReturnPerSqrtSecond: 0.0001,
      momentumLogReturn: 0.001,
      momentumWindowSeconds: 15,
      tradeFlowImbalance: 0.8,
      bookImbalance: 0.8,
      marketWinProbability: 0.52,
      marketQuoteObservedAtSeconds: 769,
      marketBookObservedAtSeconds: 769,
      marketExecutablePrice: 0.52,
      marketExecutableQuantity: 2,
    }),
    state,
    { ...config, mode: "live-exit", sensitivity: "less_aggressive" },
    769,
  );
  assert.equal(decision.timeBand, "urgent");
  assert.equal(decision.targetAlreadyCrossed, true);
  assert.equal(decision.marketDirectionConfirmed, true);
  assert.equal(decision.disposition, "PREPARE_EXIT");
  assert.equal(decision.mayExecuteExit, false);
  assert.ok(decision.adverseTargetDistanceFraction < decision.requiredAdverseTargetDistanceFraction);
});