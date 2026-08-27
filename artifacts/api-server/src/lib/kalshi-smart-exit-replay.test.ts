import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildCrossingRiskReplayLifecycles,
  calibrateSmartExit,
  replaySmartExit,
  summarizeSmartExitComparison,
  type SmartExitReplayLifecycle,
} from "./kalshi-smart-exit-replay.ts";
import {
  getSmartExitShadowProceeds,
  type SmartExitEvaluationRecord,
} from "./kalshi-smart-exit-types.ts";

const lifecycle = (overrides: Partial<SmartExitReplayLifecycle> = {}): SmartExitReplayLifecycle => ({
  owner: "regular", symbol: "BTC", regime: "trend", entryTimestampSeconds: 10, expiryTimestampSeconds: 100,
  entryContractCost: 0.6, quantity: 1, holdToExpiryPnl: -0.6,
  candidateExit: { timestampSeconds: 40, contractPrice: 0.45, reason: "adverse" }, ...overrides,
});

test("replay sorts chronologically and scores candidate exits", () => {
  const report = replaySmartExit([lifecycle({ entryTimestampSeconds: 20 }), lifecycle({ entryTimestampSeconds: 10 })]);
  assert.deepEqual(report.chronologicalLifecycles.map((item) => item.entryTimestampSeconds), [10, 20]);
  assert.equal(report.overall.hold.totalPnl, -1.2);
  assert.ok(Math.abs(report.overall.candidate.totalPnl - (-0.3)) < 1e-12);
  assert.equal(report.overall.avoidedLosses, 2);
  assert.equal(report.byOwner.regular.hold.samples, 2);
});

test("false exits count an exited position that would have won", () => {
  const report = replaySmartExit([lifecycle({ holdToExpiryPnl: 0.4, candidateExit: { timestampSeconds: 20, contractPrice: 0.3, reason: "bad" } })]);
  assert.equal(report.overall.falseExits, 1);
  assert.equal(report.overall.missedWins, 1);
  assert.ok(report.overall.missedWinDollars > 0);
  assert.equal(report.overall.avoidedLosses, 0);
});

test("slippage reduces exit P&L and no exit remains a hold", () => {
  const report = replaySmartExit([
    lifecycle(),
    lifecycle({ candidateExit: null, holdToExpiryPnl: 0.2 }),
  ], [{ bps: 100, cents: 1 }]);
  assert.equal(report.slippage[0]!.comparison.candidate.totalPnl < report.overall.candidate.totalPnl, true);
  assert.equal(report.slippage[0]!.comparison.candidate.totalPnl > -0.6, true);
});

test("calibration uses oldest training and newest holdout, and never applies", () => {
  const data = Array.from({ length: 8 }, (_, index) => lifecycle({
    entryTimestampSeconds: index, expiryTimestampSeconds: index + 10,
    holdToExpiryPnl: -0.5, candidateExit: { timestampSeconds: index + 1, contractPrice: 0.4, reason: "x" },
  }));
  const result = calibrateSmartExit([...data].reverse(), {
    minSamples: 8, minTrainingSamples: 6, minHoldoutSamples: 2, holdoutFraction: .25, minSegmentSamples: 20,
  });
  assert.equal(result.status, "validated");
  assert.equal(result.applied, false);
  assert.equal(result.training!.hold.samples, 6);
  assert.equal(result.holdout!.hold.samples, 2);
});

test("rejects a candidate that reduces losses by sacrificing total P&L", () => {
  const data = Array.from({ length: 8 }, (_, index) => lifecycle({
    entryTimestampSeconds: index, expiryTimestampSeconds: index + 10,
    holdToExpiryPnl: index < 4 ? -1 : 2,
    candidateExit: { timestampSeconds: index + 1, contractPrice: index < 4 ? 0.1 : 0.7, reason: "x" },
  }));
  const result = calibrateSmartExit(data, { minSamples: 8, minTrainingSamples: 6, minHoldoutSamples: 2, holdoutFraction: .25, minSegmentSamples: 20 });
  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.some((reason) => reason.includes("total P&L")));
});

test("requires minimum chronological samples before validation", () => {
  const result = calibrateSmartExit([lifecycle()], { minSamples: 2, minTrainingSamples: 1, minHoldoutSamples: 1 });
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.applied, false);
});

test("rejects a segment or slippage scenario that is not stable", () => {
  const data = Array.from({ length: 8 }, (_, index) => lifecycle({
    entryTimestampSeconds: index, expiryTimestampSeconds: index + 10, holdToExpiryPnl: -0.6,
    candidateExit: { timestampSeconds: index + 1, contractPrice: 0.01, reason: "x" },
  }));
  const result = calibrateSmartExit(data, {
    minSamples: 8, minTrainingSamples: 6, minHoldoutSamples: 2, holdoutFraction: .25,
    minSegmentSamples: 1, slippageAssumptions: [{ cents: 10 }],
  });
  assert.equal(result.status, "rejected");
  assert.ok(result.reasons.some((reason) => reason.includes("slippage")));
});

const durableEvaluation = (
  timestampSeconds: number,
  overrides: Partial<SmartExitEvaluationRecord> = {},
): SmartExitEvaluationRecord => ({
  owner: "regular",
  positionId: "p",
  symbol: "BTC",
  side: "yes",
  timestamp: new Date(timestampSeconds * 1_000).toISOString(),
  secondsRemaining: 100 - timestampSeconds,
  underlyingPrice: 100.5,
  strikePrice: 100,
  volatilityLogReturnPerSqrtSecond: 0.01,
  momentumLogReturn: -0.01,
  momentumWindowSeconds: 15,
  tradeFlowImbalance: -1,
  bookImbalance: -1,
  continuationScore: 1,
  adverseVelocityPerSecond: 0.2,
  adverseAccelerationPerSecond2: 0,
  projectedCrossingSeconds: 2.5,
  marketLossFraction: 0.5,
  exitEdgePerContract: 0.1,
  executionEvidenceReady: true,
  liquidityCoverage: 1,
  estimatedSaleValue: 0.4,
  entryStake: 0.8,
  remainingQuantity: 1,
  ...overrides,
} as SmartExitEvaluationRecord);

test("durable one-second replay requires sustained realistic crossing before selecting an exit", () => {
  const settlements = [{
    owner: "regular" as const,
    positionId: "p",
    symbol: "BTC",
    regime: "trend",
    entryTimestampSeconds: 10,
    expiryTimestampSeconds: 100,
    entryContractCost: 0.8,
    quantity: 1,
    holdToExpiryPnl: -0.8,
  }];
  const replay = buildCrossingRiskReplayLifecycles(settlements, [
    durableEvaluation(20, {
      underlyingPrice: 150,
      volatilityLogReturnPerSqrtSecond: 0.00001,
      projectedCrossingSeconds: 10,
    }),
    durableEvaluation(30),
    durableEvaluation(31),
    durableEvaluation(32),
    durableEvaluation(33),
  ]);
  assert.equal(replay[0]!.candidateExit?.timestampSeconds, 33);
  assert.match(replay[0]!.candidateExit?.reason ?? "", /sustained projected target crossing/);
});

test("durable replay uses the same sensitivity debounce boundaries as live policy", () => {
  const settlement = {
    owner: "regular" as const, positionId: "p", symbol: "BTC", regime: "trend",
    entryTimestampSeconds: 10, expiryTimestampSeconds: 100,
    entryContractCost: 0.8, quantity: 1, holdToExpiryPnl: -0.8,
  };
  const samples = [30, 31, 32, 33, 34].map((at) => durableEvaluation(at));
  assert.equal(buildCrossingRiskReplayLifecycles(
    [settlement], samples, { sensitivity: "more_aggressive" },
  )[0]!.candidateExit?.timestampSeconds, 32);
  assert.equal(buildCrossingRiskReplayLifecycles(
    [settlement], samples, { sensitivity: "default" },
  )[0]!.candidateExit?.timestampSeconds, 33);
  assert.equal(buildCrossingRiskReplayLifecycles(
    [settlement], samples, { sensitivity: "less_aggressive" },
  )[0]!.candidateExit?.timestampSeconds, 34);
});

test("durable replay treats a fully executable actual crossing as immediate", () => {
  const replay = buildCrossingRiskReplayLifecycles([{
    owner: "regular",
    positionId: "p",
    symbol: "BTC",
    regime: "trend",
    entryTimestampSeconds: 10,
    expiryTimestampSeconds: 100,
    entryContractCost: 0.8,
    quantity: 1,
    holdToExpiryPnl: -0.8,
  }], [
    durableEvaluation(20, {
      underlyingPrice: 99.9,
      projectedCrossingSeconds: 0,
      adverseVelocityPerSecond: null,
      continuationScore: null,
    }),
  ]);
  assert.equal(replay[0]!.candidateExit?.timestampSeconds, 20);
  assert.match(replay[0]!.candidateExit?.reason ?? "", /actual target crossing/);
});

test("ZEC cold-cross replay waits for complete evidence and compares all sensitivity timings deterministically", () => {
  const settlement = {
    owner: "regular" as const,
    positionId: "zec-2026-08-26",
    symbol: "ZEC",
    regime: "reversal",
    entryTimestampSeconds: Date.parse("2026-08-26T23:42:08Z") / 1_000,
    expiryTimestampSeconds: Date.parse("2026-08-26T23:45:00Z") / 1_000,
    entryContractCost: 0.48,
    quantity: 1,
    holdToExpiryPnl: 0.52,
  };
  const coldCross = durableEvaluation(settlement.entryTimestampSeconds + 10, {
    positionId: settlement.positionId,
    symbol: "ZEC",
    side: "no",
    strikePrice: 817.7313,
    underlyingPrice: 818,
    volatilityLogReturnPerSqrtSecond: null,
    momentumLogReturn: null,
    tradeFlowImbalance: null,
    bookImbalance: null,
    secondsRemaining: settlement.expiryTimestampSeconds - (settlement.entryTimestampSeconds + 10),
  });
  const warmed = [46, 47, 48, 49].map((offset) => durableEvaluation(
    settlement.entryTimestampSeconds + offset,
    {
      positionId: settlement.positionId,
      symbol: "ZEC",
      side: "no",
      strikePrice: 817.7313,
      underlyingPrice: 817.5 - (offset - 46) * 0.1,
      secondsRemaining: settlement.expiryTimestampSeconds - (settlement.entryTimestampSeconds + offset),
    },
  ));
  const samples = [coldCross, ...warmed];
  const timing = (sensitivity: "more_aggressive" | "default" | "less_aggressive") =>
    buildCrossingRiskReplayLifecycles([settlement], samples, { sensitivity })[0]!.candidateExit?.timestampSeconds;
  assert.equal(timing("more_aggressive"), settlement.entryTimestampSeconds + 48);
  assert.equal(timing("default"), settlement.entryTimestampSeconds + 49);
  assert.equal(timing("less_aggressive"), undefined);
});

test("replay cannot execute a crossed sample whose momentum window is missing", () => {
  const settlement = {
    owner: "regular" as const,
    positionId: "missing-window",
    symbol: "ZEC",
    regime: "cold",
    entryTimestampSeconds: 10,
    expiryTimestampSeconds: 100,
    entryContractCost: 0.48,
    quantity: 1,
    holdToExpiryPnl: 0.52,
  };
  const replay = buildCrossingRiskReplayLifecycles([settlement], [
    durableEvaluation(20, {
      positionId: settlement.positionId,
      symbol: settlement.symbol,
      underlyingPrice: 99,
      momentumWindowSeconds: null,
    }),
  ]);
  assert.equal(replay[0]!.candidateExit, null);
});

test("durable replay applies the same terminal and recoverable deep-loss holds as live policy", () => {
  const settlement = {
    owner: "regular" as const,
    positionId: "p",
    symbol: "BTC",
    regime: "trend",
    entryTimestampSeconds: 10,
    expiryTimestampSeconds: 500,
    entryContractCost: 0.8,
    quantity: 1,
    holdToExpiryPnl: 0.2,
  };
  const terminal = buildCrossingRiskReplayLifecycles([settlement], [
    durableEvaluation(100, {
      secondsRemaining: 400,
      underlyingPrice: 99,
      estimatedSaleValue: 0.08,
    }),
  ]);
  assert.equal(terminal[0]!.candidateExit, null);

  const recoverable = buildCrossingRiskReplayLifecycles([settlement], [
    durableEvaluation(100, {
      secondsRemaining: 400,
      underlyingPrice: 99,
      estimatedSaleValue: 0.12,
    }),
  ]);
  assert.equal(recoverable[0]!.candidateExit, null);

  const tooLate = buildCrossingRiskReplayLifecycles([settlement], [
    durableEvaluation(291, {
      secondsRemaining: 209,
      underlyingPrice: 99,
      estimatedSaleValue: 0.12,
    }),
  ]);
  assert.equal(tooLate[0]!.candidateExit?.timestampSeconds, 291);
});

test("durable replay uses the recorded remaining stake after a partial position reduction", () => {
  const replay = buildCrossingRiskReplayLifecycles([{
    owner: "regular",
    positionId: "p",
    symbol: "BTC",
    regime: "trend",
    entryTimestampSeconds: 10,
    expiryTimestampSeconds: 500,
    entryContractCost: 0.8,
    quantity: 10,
    holdToExpiryPnl: -8,
  }], [
    durableEvaluation(291, {
      secondsRemaining: 209,
      underlyingPrice: 99,
      remainingQuantity: 2,
      entryStake: 1.6,
      estimatedSaleValue: 0.16,
      capitalLossFraction: 0.9,
    }),
  ]);
  assert.equal(replay[0]!.candidateExit, null);
});

test("durable replay refuses partial liquidity and reports dollars saved versus forfeited", () => {
  const noExit = buildCrossingRiskReplayLifecycles([{
    owner: "regular",
    positionId: "p",
    symbol: "BTC",
    regime: "trend",
    entryTimestampSeconds: 10,
    expiryTimestampSeconds: 100,
    entryContractCost: 0.8,
    quantity: 1,
    holdToExpiryPnl: -0.8,
  }], [
    durableEvaluation(20, {
      underlyingPrice: 99.9,
      projectedCrossingSeconds: 0,
      executionEvidenceReady: false,
      liquidityCoverage: 0.5,
    }),
  ]);
  assert.equal(noExit[0]!.candidateExit, null);
  assert.equal(getSmartExitShadowProceeds({
    executionEvidenceReady: true,
    estimatedSaleValue: 0.4,
    liquidityCoverage: 0.5,
    remainingQuantity: 1,
  }, 1), null);
  assert.equal(getSmartExitShadowProceeds({
    executionEvidenceReady: true,
    estimatedSaleValue: 0.4,
    liquidityCoverage: null,
    remainingQuantity: 1,
  }, 1), null);
  assert.equal(getSmartExitShadowProceeds({
    executionEvidenceReady: true,
    estimatedSaleValue: 0.4,
    liquidityCoverage: 1,
    remainingQuantity: 2,
  }, 1), null);

  const report = replaySmartExit([
    lifecycle({ holdToExpiryPnl: -0.6, candidateExit: { timestampSeconds: 20, contractPrice: 0.3, reason: "saved" } }),
    lifecycle({ holdToExpiryPnl: 0.4, candidateExit: { timestampSeconds: 20, contractPrice: 0.3, reason: "forfeited" } }),
  ]);
  assert.ok(report.overall.avoidedLossDollars > 0);
  assert.ok(report.overall.missedWinDollars > 0);
  assert.ok(Math.abs(report.overall.totalPnlDelta
    - (report.overall.avoidedLossDollars - report.overall.missedWinDollars)) < 1e-12);

  const summary = summarizeSmartExitComparison(report.chronologicalLifecycles);
  assert.ok(summary.grossMoneySaved > 0);
  assert.ok(summary.grossMoneyForfeited > 0);
  assert.ok(Math.abs(summary.netValue
    - (summary.grossMoneySaved - summary.grossMoneyForfeited)) < 1e-12);
  assert.equal(summary.triggered, 2);
  assert.equal(summary.helped, 1);
  assert.equal(summary.harmed, 1);
});

test("durable replay cannot scale partial-position evidence into a hypothetical full exit", () => {
  const replay = buildCrossingRiskReplayLifecycles([{
    owner: "regular",
    positionId: "p",
    symbol: "BTC",
    regime: "trend",
    entryTimestampSeconds: 10,
    expiryTimestampSeconds: 100,
    entryContractCost: 0.8,
    quantity: 10,
    holdToExpiryPnl: -8,
  }], [
    durableEvaluation(20, {
      underlyingPrice: 99.9,
      projectedCrossingSeconds: 0,
      remainingQuantity: 5,
      estimatedSaleValue: 2,
      entryStake: 4,
      executionEvidenceReady: true,
      liquidityCoverage: 1,
    }),
  ]);
  assert.equal(replay[0]!.candidateExit, null);
});

test("legacy replay report fields remain available alongside explicit effectiveness accounting", () => {
  const report = replaySmartExit([lifecycle()]);
  assert.equal(report.overall.totalPnlDelta, report.overall.candidate.totalPnl - report.overall.hold.totalPnl);
  assert.equal(typeof report.overall.avoidedLossDollars, "number");
  assert.equal(typeof report.overall.missedWinDollars, "number");
  assert.equal(report.chronologicalLifecycles.length, 1);
});

test("durable replay DB loading is capped per position and in total", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "kalshi-smart-exit-db.ts"), "utf8");
  assert.match(source, /SMART_EXIT_REPLAY_MAX_POSITIONS = 50/);
  assert.match(source, /SMART_EXIT_REPLAY_MAX_EVALUATIONS_PER_POSITION = 1_000/);
  assert.match(source, /ROW_NUMBER\(\) OVER \(\s*PARTITION BY e\.owner, e\.position_id/s);
  assert.match(source, /WHERE sample_rank <= \$4/);
  assert.match(source, /LIMIT \$5/);
});

test("global counterfactual persistence is canonical-only and never embedded in scoped reports", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "kalshi-smart-exit-service.ts"), "utf8");
  const routeSource = readFileSync(join(here, "../routes/kalshi-smart-exit.ts"), "utf8");
  assert.match(source, /isSmartExitGlobalCalibration\(params\)/);
  assert.match(source, /id: "smart-exit:global-counterfactual-v1"/);
  assert.match(source, /symbol: "GLOBAL"/);
  assert.match(source, /version: "global-counterfactual-v1"/);
  assert.match(source, /params\.owner === undefined/);
  assert.match(source, /params\.symbol === undefined/);
  assert.match(source, /params\.limitPositions === undefined/);
  assert.match(source, /getSmartExitReplayReportByIdentity/);
  assert.doesNotMatch(source, /sharedCoverage,\s*\n\s*globalComparison,/);
  assert.match(routeSource, /rawLimit === undefined \? undefined : Number\(rawLimit\)/);
  assert.match(routeSource, /requestedLimit === undefined\s*\? undefined/);
});