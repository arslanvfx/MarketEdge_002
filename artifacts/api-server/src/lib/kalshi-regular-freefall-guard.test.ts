import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRegularFreefallPreSubmitGuard,
} from "./kalshi-regular-freefall-guard.ts";
test("disabled regular freefall guard allows entry without evaluating evidence", () => {
  const result = evaluateRegularFreefallPreSubmitGuard({
    enabled: false,
    samples: [],
    side: "yes",
    nowMs: 10_000,
    windowStartMs: 0,
    closeTimeMs: 20_000,
    targetPrice: 100,
    hasProduct: false,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, null);
  assert.equal(result.guardResult, null);
});


const NOW = 100_000;
const TARGET = 99;

function samples(prices: number[]) {
  return prices.map((price, index) => ({
    price,
    ts: NOW - (prices.length - 1 - index) * 1_000,
  }));
}

function evaluate(
  side: "yes" | "no",
  prices: number[],
  secondsRemaining = 120,
) {
  return evaluateRegularFreefallPreSubmitGuard({
    samples: samples(prices),
    side,
    nowMs: NOW,
    windowStartMs: 0,
    closeTimeMs: NOW + secondsRemaining * 1_000,
    targetPrice: side === "yes" ? TARGET : 101,
    hasProduct: true,
  });
}

test("YES falling for four consecutive seconds is blocked", () => {
  const result = evaluate("yes", [101, 100.9, 100.8, 100.7, 100.6, 100.5]);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_consecutive_falling");
  assert.equal(result.guardResult?.consecutiveWrongWayMoves, 4);
});

test("NO rising for four consecutive seconds is blocked", () => {
  const result = evaluate("no", [99, 99.1, 99.2, 99.3, 99.4, 99.5]);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_consecutive_rising");
});

test("rapid movement in either direction is blocked", () => {
  const result = evaluate("yes", [100, 100.1, 100.2, 100.4, 100.6, 100.8]);
  assert.equal(result.allowed, false);
  assert.equal(result.guardResult?.rapidMoveBlocked, true);
  assert.equal(result.reason, "rapid_move_too_fast_rising");
});

test("favorable movement below the rapid threshold is allowed", () => {
  const result = evaluate("yes", [100, 100.05, 100.1, 100.15, 100.2, 100.25]);
  assert.equal(result.allowed, true);
  assert.equal(result.guardResult?.favorableTrendConfirmed, true);
  assert.equal(result.guardResult?.targetSideWindowConfirmed, true);
});

test("unavailable samples fail closed even before the final two minutes", () => {
  const result = evaluate("yes", [100], 121);
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /unavailable/);
  assert.equal(result.deferredUnavailable, false);
});

test("stale spot evidence fails closed with structured evidence", () => {
  const result = evaluateRegularFreefallPreSubmitGuard({
    samples: [100, 100.1, 100.2, 100.3, 100.4, 100.5].map((price, index) => ({
      price,
      ts: NOW - 10_000 + index * 1_000,
    })),
    side: "yes",
    nowMs: NOW,
    windowStartMs: 0,
    closeTimeMs: NOW + 300_000,
    targetPrice: TARGET,
    hasProduct: true,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_unavailable_stale");
  assert.equal(result.guardResult?.evaluable, false);
  assert.equal(result.deferredUnavailable, false);
});

test("missing product or strike fails closed", () => {
  const noProduct = evaluateRegularFreefallPreSubmitGuard({
    samples: samples([100, 100.1, 100.2, 100.3, 100.4, 100.5]),
    side: "yes",
    nowMs: NOW,
    windowStartMs: 0,
    closeTimeMs: NOW + 300_000,
    targetPrice: TARGET,
    hasProduct: false,
  });
  assert.equal(noProduct.allowed, false);
  assert.equal(noProduct.reason, "freefall_unavailable_no_product");

  const noStrike = evaluateRegularFreefallPreSubmitGuard({
    samples: samples([100, 100.1, 100.2, 100.3, 100.4, 100.5]),
    side: "yes",
    nowMs: NOW,
    windowStartMs: 0,
    closeTimeMs: NOW + 300_000,
    targetPrice: Number.NaN,
    hasProduct: true,
  });
  assert.equal(noStrike.allowed, false);
  assert.equal(noStrike.reason, "freefall_unavailable_target");
});

test("wrong target-side evidence anywhere in the active lifecycle blocks", () => {
  const result = evaluate("yes", [99.2, 98.9, 99, 99.1, 99.2, 99.3]);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_wrong_target_side_yes");
  assert.equal(result.guardResult?.targetSideViolationPrice, 98.9);
});

test("endpoint reversal and recent adverse excursion both veto conviction", () => {
  const reversal = evaluate("yes", [100, 100.2, 100.4, 100.2, 100.3, 100.3]);
  assert.equal(reversal.allowed, false);
  assert.equal(reversal.reason, "adverse_excursion_peak_fall_yes");
  assert.equal(reversal.guardResult?.adverseExcursionBlocked, true);
  assert.ok((reversal.guardResult?.reversalAdverseMovePct ?? 0) >= 0.1);

  const endpoint = evaluate("yes", [100, 100.05, 100, 100.1, 100.05, 100.04]);
  assert.equal(endpoint.allowed, false);
  assert.equal(endpoint.reason, "freefall_favorable_trend_not_confirmed_yes");
  assert.ok((endpoint.guardResult?.endpointAdverseMovePct ?? 0) > 0);
});

test("samples before the lifecycle boundary cannot establish conviction", () => {
  const result = evaluateRegularFreefallPreSubmitGuard({
    samples: samples([100, 100.1, 100.2, 100.3, 100.4, 100.5]),
    side: "yes",
    nowMs: NOW,
    windowStartMs: NOW - 2_000,
    closeTimeMs: NOW + 300_000,
    targetPrice: TARGET,
    hasProduct: true,
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /unavailable/);
});

function pythSamples(
  publications: Array<{ offset: number; price: number; polls?: number }>,
  newestReceiptOffset = 0,
) {
  const result: Array<{
    price: number;
    ts: number;
    oraclePublishedAtMs: number;
    oracleAgeMs: number;
  }> = [];
  let receipt = NOW - 12_000;
  for (const publication of publications) {
    for (let poll = 0; poll < (publication.polls ?? 1); poll += 1) {
      result.push({
        price: publication.price,
        ts: receipt,
        oraclePublishedAtMs: NOW + publication.offset,
        oracleAgeMs: 500,
      });
      receipt += 1_000;
    }
  }
  result[result.length - 1].ts = NOW + newestReceiptOffset;
  return result;
}

function evaluatePyth(
  publications: Array<{ offset: number; price: number; polls?: number }>,
  newestReceiptOffset = 0,
) {
  return evaluateRegularFreefallPreSubmitGuard({
    samples: pythSamples(publications, newestReceiptOffset),
    side: "yes",
    nowMs: NOW,
    windowStartMs: 0,
    closeTimeMs: NOW + 120_000,
    targetPrice: TARGET,
    hasProduct: true,
    authoritativeCommodityCadence: true,
  });
}

test("Pyth uses distinct publication cadence and ignores repeated local polls", () => {
  const clear = evaluatePyth([
    { offset: -10_000, price: 100, polls: 3 },
    { offset: -5_000, price: 100.1, polls: 3 },
    { offset: 0, price: 100.2, polls: 3 },
  ]);
  assert.equal(clear.allowed, true);
  assert.equal(clear.guardResult?.evaluatedSamples.length, 3);
  assert.deepEqual(
    clear.guardResult?.evaluatedSamples.map((sample) => sample.at),
    [NOW - 10_000, NOW - 5_000, NOW],
  );

  const repeated = evaluatePyth([
    { offset: -5_000, price: 100, polls: 4 },
    { offset: 0, price: 100.1, polls: 4 },
  ]);
  assert.equal(repeated.allowed, false);
  assert.equal(repeated.reason, "freefall_unavailable_distinct_publishes");
});

test("Pyth cadence fails closed while warming or stale", () => {
  const warming = evaluatePyth([
    { offset: -2_000, price: 100 },
    { offset: -1_000, price: 100.1 },
    { offset: 0, price: 100.2 },
  ]);
  assert.equal(warming.reason, "freefall_unavailable_warming");

  const staleReceipt = evaluatePyth([
    { offset: -10_000, price: 100 },
    { offset: -5_000, price: 100.1 },
    { offset: 0, price: 100.2 },
  ], -3_000);
  assert.equal(staleReceipt.reason, "freefall_unavailable_stale");

  const staleOracle = evaluatePyth([
    { offset: -16_000, price: 100 },
    { offset: -11_000, price: 100.1 },
    { offset: -6_000, price: 100.2 },
  ]);
  assert.equal(staleOracle.reason, "freefall_unavailable_oracle_stale");
});

test("Pyth adverse reversal blocks on distinct publications", () => {
  const reversal = evaluatePyth([
    { offset: -6_000, price: 100 },
    { offset: -2_000, price: 100.4 },
    { offset: 0, price: 100.2 },
  ]);
  assert.equal(reversal.allowed, false);
  assert.equal(reversal.reason, "adverse_excursion_peak_fall_yes");
  assert.equal(reversal.guardResult?.adverseExcursionBlocked, true);
});

test("August 31 ZEC Kalshi RTI replay blocks the 9:44 YES submission", () => {
  const submittedAt = Date.parse("2026-08-31T13:44:07.000Z");
  const prices = [825.66, 825.42, 825.18, 824.97, 824.79, 824.60];
  const result = evaluateRegularFreefallPreSubmitGuard({
    samples: prices.map((price, index) => {
      const publishedAtMs = submittedAt - (prices.length - 1 - index) * 1_000;
      return {
        price,
        ts: publishedAtMs + 40,
        oraclePublishedAtMs: publishedAtMs,
        oracleAgeMs: 40,
        source: "kalshi_cfbenchmarks",
        sourceIndex: "ZECUSD_RTI",
        sourceSequence: `ZECUSD_RTI:${publishedAtMs}:${price}`,
        websocketSequence: index + 1,
      };
    }),
    side: "yes",
    nowMs: submittedAt + 100,
    windowStartMs: Date.parse("2026-08-31T13:30:00.000Z"),
    closeTimeMs: Date.parse("2026-08-31T13:45:00.000Z"),
    targetPrice: 823.151,
    hasProduct: true,
    authoritativePublicationCadence: true,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_consecutive_falling");
  assert.equal(result.guardResult?.consecutiveWrongWayMoves, 4);
  assert.equal(result.guardResult?.latestPrice, 824.6);
});