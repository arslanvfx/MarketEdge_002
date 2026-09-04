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
  options?: {
    consecutiveSeconds?: number;
    requireConsecutiveFavorableTrend?: boolean;
  },
) {
  return evaluateRegularFreefallPreSubmitGuard({
    samples: samples(prices),
    side,
    nowMs: NOW,
    windowStartMs: 0,
    closeTimeMs: NOW + secondsRemaining * 1_000,
    targetPrice: side === "yes" ? TARGET : 101,
    hasProduct: true,
    consecutiveSeconds: options?.consecutiveSeconds,
    requireConsecutiveFavorableTrend:
      options?.requireConsecutiveFavorableTrend,
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

test("FastLane requires the configured consecutive favorable seconds for YES", () => {
  const insufficient = evaluate(
    "yes",
    [100.02, 100, 99.99, 100, 100.01, 100.01],
    120,
    {
      consecutiveSeconds: 4,
      requireConsecutiveFavorableTrend: true,
    },
  );
  assert.equal(insufficient.allowed, false);
  assert.equal(
    insufficient.reason,
    "freefall_favorable_trend_not_confirmed_yes",
  );
  assert.equal(insufficient.guardResult?.consecutiveFavorableMoves, 0);
  assert.equal(insufficient.guardResult?.consecutiveFavorableSeconds, 0);
  assert.equal(insufficient.guardResult?.favorableTrendResetCount, 1);

  const confirmed = evaluate(
    "yes",
    [99.99, 100, 100.01, 100.02, 100.03, 100.04],
    120,
    {
      consecutiveSeconds: 4,
      requireConsecutiveFavorableTrend: true,
    },
  );
  assert.equal(confirmed.allowed, true);
  assert.equal(confirmed.guardResult?.consecutiveFavorableMoves, 4);
  assert.equal(confirmed.guardResult?.consecutiveFavorableSeconds, 4);
  assert.equal(confirmed.guardResult?.requiredConsecutiveMoves, 4);
});

test("FastLane applies the configured consecutive favorable seconds symmetrically to NO", () => {
  const insufficient = evaluate(
    "no",
    [100.2, 100.1, 100.05, 100, 99.95, 99.95],
    120,
    {
      consecutiveSeconds: 3,
      requireConsecutiveFavorableTrend: true,
    },
  );
  assert.equal(insufficient.allowed, false);
  assert.equal(
    insufficient.reason,
    "freefall_favorable_trend_not_confirmed_no",
  );

  const confirmed = evaluate(
    "no",
    [100.02, 100.01, 100, 99.99, 99.98, 99.97],
    120,
    {
      consecutiveSeconds: 3,
      requireConsecutiveFavorableTrend: true,
    },
  );
  assert.equal(confirmed.allowed, true);
  assert.equal(confirmed.guardResult?.consecutiveFavorableMoves, 3);
  assert.equal(confirmed.guardResult?.consecutiveFavorableSeconds, 3);
  assert.equal(confirmed.guardResult?.requiredConsecutiveMoves, 3);
});

test("FastLane resets favorable confirmation on an adverse sub-cadence source update", () => {
  const points = [
    { offset: -5_000, price: 99.99 },
    { offset: -4_000, price: 100 },
    { offset: -3_000, price: 100.01 },
    // The one-second cadence selector skips this 500ms update. Strict
    // favorable accounting must still see it and reset the sequence.
    { offset: -2_500, price: 100.005 },
    { offset: -2_000, price: 100.02 },
    { offset: -1_000, price: 100.03 },
    { offset: 0, price: 100.04 },
  ];
  const result = evaluateRegularFreefallPreSubmitGuard({
    samples: points.map(({ offset, price }) => ({
      price,
      ts: NOW + offset,
    })),
    side: "yes",
    nowMs: NOW,
    windowStartMs: 0,
    closeTimeMs: NOW + 120_000,
    targetPrice: TARGET,
    hasProduct: true,
    consecutiveSeconds: 4,
    requireConsecutiveFavorableTrend: true,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_favorable_trend_not_confirmed_yes");
  assert.equal(result.guardResult?.consecutiveFavorableMoves, 3);
  assert.equal(result.guardResult?.consecutiveFavorableSeconds, 2.5);
  assert.equal(result.guardResult?.favorableTrendResetCount, 1);
  assert.equal(result.guardResult?.lastFavorableTrendResetAt, NOW - 2_500);
});

test("FastLane fails closed when the persisted favorable duration is invalid", () => {
  const result = evaluateRegularFreefallPreSubmitGuard({
    samples: samples([100, 100.01, 100.02, 100.03, 100.04, 100.05]),
    side: "yes",
    nowMs: NOW,
    windowStartMs: 0,
    closeTimeMs: NOW + 120_000,
    targetPrice: TARGET,
    hasProduct: true,
    consecutiveSeconds: 11,
    requireConsecutiveFavorableTrend: true,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_unavailable_config");
  assert.equal(result.guardResult, null);
});

test("unavailable samples fail closed even before the final two minutes", () => {
  const result = evaluate("yes", [100], 121);
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /unavailable/);
  assert.equal(result.deferredUnavailable, false);
});

test("an empty production feed fails closed with the exact no-samples reason", () => {
  const result = evaluateRegularFreefallPreSubmitGuard({
    samples: [],
    side: "yes",
    nowMs: NOW,
    windowStartMs: 0,
    closeTimeMs: NOW + 120_000,
    targetPrice: TARGET,
    hasProduct: true,
    consecutiveSeconds: 3,
    authoritativePublicationCadence: true,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_unavailable_no_samples");
  assert.equal(result.guardResult?.evaluable, false);
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

test("authoritative publication gaps remain fail-closed after history continuity repair", () => {
  const gap = evaluatePyth([
    { offset: -12_000, price: 100 },
    { offset: -5_000, price: 100.1 },
    { offset: 0, price: 100.2 },
  ]);
  assert.equal(gap.allowed, false);
  assert.equal(gap.reason, "freefall_unavailable_oracle_gap");
  assert.equal(gap.guardResult?.evaluable, false);
});

test("out-of-order authoritative publications remain fail-closed", () => {
  const result = evaluateRegularFreefallPreSubmitGuard({
    samples: [
      {
        price: 100,
        ts: NOW - 4_000,
        oraclePublishedAtMs: NOW - 4_000,
        oracleAgeMs: 0,
      },
      {
        price: 100.1,
        ts: NOW - 2_000,
        oraclePublishedAtMs: NOW - 1_000,
        oracleAgeMs: 0,
      },
      {
        price: 100.2,
        ts: NOW,
        oraclePublishedAtMs: NOW - 2_000,
        oracleAgeMs: 2_000,
      },
    ],
    side: "yes",
    nowMs: NOW,
    windowStartMs: 0,
    closeTimeMs: NOW + 120_000,
    targetPrice: TARGET,
    hasProduct: true,
    consecutiveSeconds: 3,
    authoritativePublicationCadence: true,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_unavailable_oracle_out_of_order");
  assert.equal(result.guardResult?.evaluable, false);
});

test("distinct publications delivered between sampler ticks remain fully evaluable", () => {
  const result = evaluateRegularFreefallPreSubmitGuard({
    samples: [
      {
        price: 100,
        ts: NOW - 5_990,
        oraclePublishedAtMs: NOW - 6_000,
        oracleAgeMs: 10,
        sourceSequence: "BRTI:1",
      },
      {
        price: 100.1,
        ts: NOW - 2_990,
        oraclePublishedAtMs: NOW - 3_000,
        oracleAgeMs: 10,
        sourceSequence: "BRTI:2",
      },
      {
        price: 100.2,
        ts: NOW - 90,
        oraclePublishedAtMs: NOW - 100,
        oracleAgeMs: 10,
        sourceSequence: "BRTI:3",
      },
    ],
    side: "yes",
    nowMs: NOW,
    windowStartMs: 0,
    closeTimeMs: NOW + 120_000,
    targetPrice: TARGET,
    hasProduct: true,
    consecutiveSeconds: 3,
    authoritativePublicationCadence: true,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.guardResult?.evaluable, true);
  assert.equal(result.guardResult?.evaluatedSamples.length, 3);
  assert.equal(result.guardResult?.favorableTrendConfirmed, true);
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

test("September 1 XRP FastLane replay rejects a decline followed by one small bounce", () => {
  const submittedAt = Date.parse("2026-09-01T20:40:00.000Z");
  const prices = [
    1.35258,
    1.35241,
    1.35233,
    1.35240,
    1.35248,
    1.35248,
  ];
  const result = evaluateRegularFreefallPreSubmitGuard({
    samples: prices.map((price, index) => {
      const publishedAtMs =
        submittedAt - (prices.length - 1 - index) * 1_000;
      return {
        price,
        ts: publishedAtMs,
        oraclePublishedAtMs: publishedAtMs,
        oracleAgeMs: 0,
        source: "kalshi_cfbenchmarks",
        sourceIndex: "XRPUSD_RTI",
        sourceSequence: `XRPUSD_RTI:${publishedAtMs}:${price}`,
        websocketSequence: index + 1,
      };
    }),
    side: "yes",
    nowMs: submittedAt,
    windowStartMs: Date.parse("2026-09-01T20:30:00.000Z"),
    closeTimeMs: Date.parse("2026-09-01T20:45:00.000Z"),
    targetPrice: 1.351,
    hasProduct: true,
    consecutiveSeconds: 4,
    requireConsecutiveFavorableTrend: true,
    authoritativePublicationCadence: true,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_favorable_trend_not_confirmed_yes");
  assert.equal(result.guardResult?.requiredConsecutiveMoves, 4);
  assert.equal(result.guardResult?.consecutiveFavorableMoves, 0);
  assert.equal(result.guardResult?.consecutiveFavorableSeconds, 0);
  assert.equal(result.guardResult?.favorableTrendConfirmed, false);
  assert.ok((result.guardResult?.favorableTrendResetCount ?? 0) >= 1);
});