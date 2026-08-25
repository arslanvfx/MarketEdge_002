import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  const result = evaluate("yes", [101, 100.9, 100.8, 100.7, 100.6]);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_consecutive_falling");
});

test("NO rising for four consecutive seconds is blocked", () => {
  const result = evaluate("no", [99, 99.1, 99.2, 99.3, 99.4]);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "freefall_consecutive_rising");
});

test("rapid movement in either direction is blocked", () => {
  const result = evaluate("yes", [100, 100.2, 100.4, 100.6, 100.8]);
  assert.equal(result.allowed, false);
  assert.equal(result.guardResult?.rapidMoveBlocked, true);
  assert.equal(result.reason, "rapid_move_too_fast_rising");
});

test("favorable movement below the rapid threshold is allowed", () => {
  const result = evaluate("yes", [100, 100.05, 100.1, 100.15, 100.2]);
  assert.equal(result.allowed, true);
  assert.equal(result.guardResult?.favorableTrendConfirmed, true);
});

test("unavailable samples fail closed with 120 seconds remaining", () => {
  const result = evaluate("yes", [100], 120);
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /unavailable/);
  assert.equal(result.deferredUnavailable, false);
});

test("unavailable warming samples defer earlier than final two minutes", () => {
  const result = evaluate("yes", [100], 121);
  assert.equal(result.allowed, true);
  assert.match(result.reason ?? "", /unavailable/);
  assert.equal(result.deferredUnavailable, true);
});

test("final guard remains before regular durable intent claim", () => {
  const source = readFileSync(
    new URL("./kalshi-bot-tick.ts", import.meta.url),
    "utf8",
  );
  const guardAt = source.indexOf("evaluateRegularFreefallPreSubmitGuard({");
  const claimAt = source.indexOf("claimRegularOrderIntent({", guardAt);
  assert.ok(guardAt >= 0, "final regular freefall guard call must exist");
  assert.ok(claimAt > guardAt, "guard must execute before durable intent claim");
});