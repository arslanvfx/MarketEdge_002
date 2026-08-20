import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHighValueScalpEligibility } from "./kalshi-high-value-scalper-policy.ts";
import { isRecoverableOpenPositionAction, restoreHighValueScalpMetadata } from "./kalshi-high-value-scalper-recovery.ts";
import { buildHighValueScalpEntryUpdate } from "./kalshi-high-value-scalper-persistence.ts";
import { HighValueScalpReservationLedger } from "./kalshi-high-value-scalper-ledger.ts";

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

test("high-value scalp reservations prevent concurrent markets from oversubscribing either cap", () => {
  const ledger = new HighValueScalpReservationLedger();
  const base = {
    mode: "paper" as const, amount: 25, currentExposure: 0, maxExposure: 40,
    currentDailySpend: 0, maxDailySpend: 40,
  };
  assert.equal(ledger.tryReserve({ ...base, key: "BTC" }), true);
  assert.equal(ledger.tryReserve({ ...base, key: "ETH" }), false);
  assert.equal(ledger.reservedAmount("paper"), 25);
  ledger.release("BTC");
  assert.equal(ledger.tryReserve({ ...base, key: "ETH" }), true);

  const dailyLedger = new HighValueScalpReservationLedger();
  assert.equal(dailyLedger.tryReserve({ ...base, key: "BTC", maxExposure: 100, maxDailySpend: 30 }), true);
  assert.equal(dailyLedger.tryReserve({ ...base, key: "ETH", maxExposure: 100, maxDailySpend: 30 }), false);
});