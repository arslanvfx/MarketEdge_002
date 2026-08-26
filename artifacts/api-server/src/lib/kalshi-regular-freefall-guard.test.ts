import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRegularFreefallPreSubmitGuard,
} from "./kalshi-regular-freefall-guard.ts";

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