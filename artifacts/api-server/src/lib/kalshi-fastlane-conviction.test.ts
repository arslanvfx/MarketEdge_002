import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  computeFastLaneLimitPrice,
  computeFastLaneContractCount,
  computeConvictionDecision,
  computeKalshi15mTicker,
  isPriceTriggeredDecisionMode,
} from "./kalshi-bot-engine-core.ts";
import {
  CONVICTION_MAX_ZERO_FILL_ATTEMPTS,
  CONVICTION_ZERO_FILL_RETRY_COOLDOWN_MS,
  regularZeroFillMaxAttempts,
  regularZeroFillRetryCooldownMs,
} from "./kalshi-regular-zero-fill-policy.ts";

test("FastLane is a price-triggered mode without changing existing modes", () => {
  assert.equal(isPriceTriggeredDecisionMode("fastlane"), true);
  assert.equal(isPriceTriggeredDecisionMode("conviction"), true);
  assert.equal(isPriceTriggeredDecisionMode("ml_gate"), false);
});

test("FastLane caps YES and NO orders at the far edge of the side-cost band", () => {
  assert.equal(computeFastLaneLimitPrice("yes", 0.91), 0.91);
  assert.equal(computeFastLaneLimitPrice("no", 0.91), 0.09);
  assert.equal(computeFastLaneLimitPrice("yes", 0.955), 0.95);
  assert.equal(computeFastLaneLimitPrice("no", 0.955), 0.05);
});

test("FastLane band detection includes both boundaries for YES and NO", () => {
  const base = {
    yesPrice: 0.5,
    lockPrice: 0.82,
    lockPriceCap: 0.91,
    minConfidence: 0,
  };
  assert.equal(
    computeConvictionDecision({ ...base, yesAsk: 0.82, yesBid: 0.1, noAsk: 0.9 }).action,
    "BET_YES",
  );
  assert.equal(
    computeConvictionDecision({ ...base, yesAsk: 0.91, yesBid: 0.1, noAsk: 0.9 }).action,
    "BET_YES",
  );
  assert.equal(
    computeConvictionDecision({ ...base, yesAsk: 0.1, yesBid: 0.18, noAsk: 0.82 }).action,
    "BET_NO",
  );
  assert.equal(
    computeConvictionDecision({ ...base, yesAsk: 0.1, yesBid: 0.09, noAsk: 0.91 }).action,
    "BET_NO",
  );
});

test("FastLane contract sizing cannot spend above the target at the band edge", () => {
  const yesLimit = computeFastLaneLimitPrice("yes", 0.91);
  const noLimit = computeFastLaneLimitPrice("no", 0.91);
  assert.equal(computeFastLaneContractCount(10, "yes", yesLimit), 10);
  assert.equal(computeFastLaneContractCount(10, "no", noLimit), 10);
  assert.ok(computeFastLaneContractCount(10, "yes", yesLimit) * 0.91 <= 10);
  assert.ok(computeFastLaneContractCount(10, "no", noLimit) * 0.91 <= 10);
});

test("exact Kalshi ticker conversion honors both EST and EDT", () => {
  assert.equal(
    computeKalshi15mTicker("btc", "2026-01-15T00:15"),
    "KXBTC15M-26JAN141930-30",
  );
  assert.equal(
    computeKalshi15mTicker("btc", "2026-07-18T00:15"),
    "KXBTC15M-26JUL172030-30",
  );
});

test("FastLane confirmed zero fills use the controlled five-second, ten-attempt policy", () => {
  assert.equal(
    regularZeroFillRetryCooldownMs("fastlane"),
    CONVICTION_ZERO_FILL_RETRY_COOLDOWN_MS,
  );
  assert.equal(
    regularZeroFillMaxAttempts("fastlane"),
    CONVICTION_MAX_ZERO_FILL_ATTEMPTS,
  );
});

test("FastLane bypasses authenticated-book quote and revalidation while retaining IOC intent flow", () => {
  const source = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  assert.match(source, /const useAuthenticatedBook =\s*!isFastLane/);
  assert.match(source, /\[kalshi-bot\] FastLane range hit — submitting edge-capped IOC/);
  assert.match(source, /timeInForce: entryTimeInForce/);
  assert.match(source, /claimRegularOrderIntent\(/);
  assert.match(source, /markRegularOrderIntentUnknown\(/);
  assert.match(source, /authenticatedBookQuote\?\.revalidate\(\) \?\? true/);
});

test("one slow market poll cannot serialize every FastLane symbol", () => {
  const source = readFileSync(new URL("./kalshi-conviction-poller.ts", import.meta.url), "utf8");
  assert.match(source, /const marketPollsInFlight = new PerKeyInFlight\(\)/);
  assert.match(source, /marketPollsInFlight\.run\(sym,/);
  assert.match(source, /stopConvictionPoller[\s\S]*marketPollsInFlight\.clear\(\)/);
  assert.doesNotMatch(source, /pollOnceInFlight/);
});