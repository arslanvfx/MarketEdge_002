import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearRegularSpotTelemetry,
  getRegularSpotTelemetrySnapshot,
  recordRegularSpotCandidateDecision,
  recordRegularSpotFetchAttempt,
  recordRegularSpotFetchFailure,
  recordRegularSpotFetchSuccess,
} from "./kalshi-regular-spot-telemetry.ts";

test("regular spot telemetry distinguishes unavailable evidence from adverse movement", () => {
  clearRegularSpotTelemetry();
  recordRegularSpotFetchAttempt("GOLD", "PYTH:Metal.XAU/USD", 10_000);
  recordRegularSpotFetchFailure({
    symbol: "GOLD",
    product: "PYTH:Metal.XAU/USD",
    atMs: 10_100,
    reason: "401 Hermes",
  });
  recordRegularSpotFetchSuccess({
    symbol: "GOLD",
    product: "PYTH:Metal.XAU/USD",
    atMs: 11_000,
    publishedAtMs: 10_500,
  });
  recordRegularSpotCandidateDecision({
    symbol: "GOLD",
    product: "PYTH:Metal.XAU/USD",
    evidenceClass: "unavailable",
    reason: "freefall_unavailable_no_samples",
    atMs: 12_000,
    windowKey: "2026-08-31T12:00",
    mode: "live",
  });
  recordRegularSpotCandidateDecision({
    symbol: "GOLD",
    product: "PYTH:Metal.XAU/USD",
    evidenceClass: "adverse",
    reason: "freefall_direction_blocked",
    atMs: 13_000,
    windowKey: "2026-08-31T12:00",
    mode: "live",
  });

  const snapshot = getRegularSpotTelemetrySnapshot(new Map([
    ["GOLD", [
      {
        ts: 10_600,
        oraclePublishedAtMs: 10_500,
        sourceSequence: "gold:10500",
      },
      {
        ts: 12_600,
        oraclePublishedAtMs: 12_500,
        sourceSequence: "gold:12500",
      },
    ]],
  ]), 13_000).GOLD;
  assert.equal(snapshot.sampleCount, 2);
  assert.equal(snapshot.distinctPublicationCount, 2);
  assert.equal(snapshot.latestReceiptAtMs, 12_600);
  assert.equal(snapshot.latestReceiptAgeMs, 400);
  assert.equal(snapshot.retainedCoverageMs, 2_000);
  assert.equal(snapshot.latestPublicationAgeMs, 500);
  assert.equal(snapshot.fetchFailureReason, null);
  assert.equal(snapshot.consecutiveFailures, 0);
  assert.equal(snapshot.unavailableCandidateBlocks, 1);
  assert.equal(snapshot.adverseCandidateBlocks, 1);
  assert.equal(snapshot.latestCandidateEvidenceClass, "adverse");
});