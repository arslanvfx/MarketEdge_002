import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrateSmartExit, replaySmartExit, type SmartExitReplayLifecycle } from "./kalshi-smart-exit-replay.ts";

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