import assert from "node:assert/strict";
import test from "node:test";
import { calculateKalshiSettlementPnl } from "./kalshi-contract-pnl.ts";

test("$50 risked at 84 cents earns the contract payout, not a fixed 50 percent", () => {
  const entryCost = 0.84;
  const contractCount = 50 / entryCost;
  const pnl = calculateKalshiSettlementPnl({
    direction: "yes",
    entryYesPrice: entryCost,
    contractCount,
    won: true,
  });
  assert.ok(Math.abs(pnl - 9.5238095238) < 1e-9);
});

test("NO settlement is symmetric and losses equal the amount risked", () => {
  const noEntryCost = 0.84;
  const contractCount = 50 / noEntryCost;
  assert.ok(Math.abs(calculateKalshiSettlementPnl({
    direction: "no",
    entryYesPrice: 1 - noEntryCost,
    contractCount,
    won: true,
  }) - 9.5238095238) < 1e-9);
  assert.ok(Math.abs(calculateKalshiSettlementPnl({
    direction: "no",
    entryYesPrice: 1 - noEntryCost,
    contractCount,
    won: false,
  }) + 50) < 1e-9);
});