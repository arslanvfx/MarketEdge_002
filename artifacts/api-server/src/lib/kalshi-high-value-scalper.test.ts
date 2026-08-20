import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateHighValueScalpEligibility,
  highValueScalpMaxSecondsRemaining,
  isHighValueScalpWindowOpen,
} from "./kalshi-high-value-scalper-policy.ts";
import { isRecoverableOpenPositionAction, restoreHighValueScalpMetadata } from "./kalshi-high-value-scalper-recovery.ts";
import { buildHighValueScalpEntryUpdate } from "./kalshi-high-value-scalper-persistence.ts";


const config = {
  highValueScalpMinPrice: 0.90,
  highValueScalpMaxPrice: 0.95,
  highValueScalpMaxMinutesRemaining: 2,
};

test("high-value scalp selects YES only from a fresh in-band YES ask", () => {
  const result = evaluateHighValueScalpEligibility({
    yesAsk: 0.92, yesBid: 0.90, secondsRemaining: 119, config,
  });
  assert.deepEqual(result, { eligible: true, side: "yes", price: 0.92, reason: null });
});

test("high-value scalp derives NO from the YES bid complement", () => {
  const result = evaluateHighValueScalpEligibility({
    yesAsk: 0.09, yesBid: 0.07, secondsRemaining: 90, config,
  });
  assert.deepEqual(result, { eligible: true, side: "no", price: 0.93, reason: null });
});

test("high-value scalp rejects early, stale-shaped, and opposite-position quotes", () => {
  assert.equal(evaluateHighValueScalpEligibility({
    yesAsk: 0.92, yesBid: 0.90, secondsRemaining: 121, config,
  }).eligible, false);
  assert.equal(evaluateHighValueScalpEligibility({
    yesAsk: 0.92, yesBid: null, secondsRemaining: 60, config,
  }).eligible, false);
  assert.equal(evaluateHighValueScalpEligibility({
    yesAsk: 0.92, yesBid: 0.90, secondsRemaining: 60, config,
    activePosition: { direction: "no" },
  }).eligible, false);
});

test("high-value scalp supports a precise 1 minute 30 second final window", () => {
  const result = evaluateHighValueScalpEligibility({
    yesAsk: 0.92, yesBid: 0.90, secondsRemaining: 90,
    config: {
      highValueScalpMinPrice: 0.90,
      highValueScalpMaxPrice: 0.95,
      highValueScalpMaxSecondsRemaining: 90,
    },
  });
  assert.equal(result.eligible, true);
  assert.equal(evaluateHighValueScalpEligibility({
    yesAsk: 0.92, yesBid: 0.90, secondsRemaining: 91,
    config: {
      highValueScalpMinPrice: 0.90,
      highValueScalpMaxPrice: 0.95,
      highValueScalpMaxSecondsRemaining: 90,
    },
  }).eligible, false);
});

test("high-value scalp scanner gate honors a configured window above two minutes", () => {
  const config = { highValueScalpMaxSecondsRemaining: 150 };
  assert.equal(highValueScalpMaxSecondsRemaining(config), 150);
  assert.equal(isHighValueScalpWindowOpen(150, config), true);
  assert.equal(isHighValueScalpWindowOpen(151, config), false);
});

test("high-value scalp rows remain recoverable and retain their cap attribution after restart", () => {
  assert.equal(isRecoverableOpenPositionAction("high_value_scalp"), true);
  assert.equal(isRecoverableOpenPositionAction("high_value_scalp_add"), true);
  assert.equal(isRecoverableOpenPositionAction("exit"), false);
  assert.deepEqual(
    restoreHighValueScalpMetadata({
      action: "high_value_scalp_add",
      source: "high_value_scalp",
      signals: { highValueScalp: true, highValueScalpAmount: 25, highValueScalpAddCount: 1 },
    }),
    { source: "high_value_scalp", highValueScalpAmount: 25, highValueScalpAddCount: 1 },
  );
});

test("high-value scalp add-on persistence only changes entry accounting", () => {
  const update = buildHighValueScalpEntryUpdate({
    signals: { highValueScalp: true, highValueScalpAmount: 25 },
    entryPrice: 0.93, entryYesPrice: 0.93, contractCount: 40, betAmount: 37.2,
    source: "high_value_scalp",
  });
  assert.deepEqual(update, {
    signals: { highValueScalp: true, highValueScalpAmount: 25 },
    entryPrice: "0.93", entryYesPrice: "0.93", contractCount: 40,
    betAmount: "37.2", source: "high_value_scalp",
  });
  assert.equal("exitedAt" in update, false);
  assert.equal("pnl" in update, false);
  assert.equal("action" in update, false);
});

// Cap enforcement is now handled by direct numeric checks in scanSymbol rather
// than a separate reservation ledger.  The scan runs serially so each coin
// sees the correct accumulated exposure before deciding to bet.