import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_PNL_SIMULATION_ROWS_SQL,
  DAILY_TRADING_PNL_SQL,
  PAPER_TRADING_BALANCE_SQL,
} from "./kalshi-daily-pnl-query.ts";
import {
  calculatePnlSimulation,
  wholeContractsForStake,
} from "./kalshi-daily-pnl-calculator.ts";
import { todayEastern } from "./eastern-time.ts";

test("todayEastern rolls over at New York midnight, not UTC midnight", () => {
  assert.equal(todayEastern(new Date("2026-08-26T03:59:59.999Z")), "2026-08-25");
  assert.equal(todayEastern(new Date("2026-08-26T04:00:00.000Z")), "2026-08-26");
});

test("todayEastern remains DST-aware in standard time", () => {
  assert.equal(todayEastern(new Date("2026-01-15T04:59:59.999Z")), "2026-01-14");
  assert.equal(todayEastern(new Date("2026-01-15T05:00:00.000Z")), "2026-01-15");
});

test("daily P&L query includes only regular bot and canonical Scalper settlements", () => {
  assert.match(DAILY_TRADING_PNL_SQL, /AT TIME ZONE 'America\/New_York'/);
  assert.match(DAILY_TRADING_PNL_SQL, /FROM kalshi_bot_bets/);
  assert.match(DAILY_TRADING_PNL_SQL, /source = 'bot'/);
  assert.match(DAILY_TRADING_PNL_SQL, /FROM kalshi_scalp_orders/);
  assert.match(DAILY_TRADING_PNL_SQL, /outcome IN \('win', 'loss'\)/);
  assert.doesNotMatch(DAILY_TRADING_PNL_SQL, /kalshi_scalp_contrarian_orders/);
  assert.doesNotMatch(DAILY_TRADING_PNL_SQL, /liveStatsResetAt|paperStatsResetAt/);
});

test("paper balance uses the same regular and canonical Scalper ownership", () => {
  assert.match(PAPER_TRADING_BALANCE_SQL, /FROM kalshi_bot_bets/);
  assert.match(PAPER_TRADING_BALANCE_SQL, /b\.source = 'bot'/);
  assert.match(PAPER_TRADING_BALANCE_SQL, /FROM kalshi_scalp_orders/);
  assert.match(PAPER_TRADING_BALANCE_SQL, /o\.mode = 'paper'/);
  assert.match(PAPER_TRADING_BALANCE_SQL, /account_balance/);
  assert.doesNotMatch(PAPER_TRADING_BALANCE_SQL, /contrarian|shadow/i);
});

test("simulation query preserves Eastern boundaries and source isolation", () => {
  assert.match(DAILY_PNL_SIMULATION_ROWS_SQL, /AT TIME ZONE 'America\/New_York'/);
  assert.match(DAILY_PNL_SIMULATION_ROWS_SQL, /b\.source = 'bot'/);
  assert.match(DAILY_PNL_SIMULATION_ROWS_SQL, /b\.archived_at IS NULL/);
  assert.match(DAILY_PNL_SIMULATION_ROWS_SQL, /FROM kalshi_scalp_orders/);
  assert.doesNotMatch(DAILY_PNL_SIMULATION_ROWS_SQL, /contrarian|shadow/i);
});

test("simulation rescales each mixed-size win and loss independently", () => {
  const result = calculatePnlSimulation([
    { strategy: "regular", actualCost: 2, contractCount: 2, pnl: 1, resolved: true },
    { strategy: "regular", actualCost: 4, contractCount: 4, pnl: -4, resolved: true },
    { strategy: "scalper", actualCost: 10, contractCount: 10, pnl: 5, resolved: true },
    { strategy: "scalper", actualCost: 20, contractCount: 20, pnl: -10, resolved: true },
  ], 8, 40);

  assert.equal(result.regular.actualPnl, -3);
  assert.equal(result.regular.hypotheticalPnl, -4);
  assert.equal(result.regular.hypotheticalStake, 16);
  assert.equal(result.scalper.actualPnl, -5);
  assert.equal(result.scalper.hypotheticalPnl, 0);
  assert.equal(result.scalper.hypotheticalStake, 80);
  assert.equal(result.totals.actualPnl, -8);
  assert.equal(result.totals.hypotheticalPnl, -4);
  assert.equal(result.totals.deltaPnl, 4);
  assert.equal(result.totals.deltaPct, 50);
});

test("simulation excludes missing costs, zero costs, missing P&L, and unresolved rows", () => {
  const result = calculatePnlSimulation([
    { strategy: "regular", actualCost: null, contractCount: 2, pnl: 1, resolved: true },
    { strategy: "regular", actualCost: 0, contractCount: 2, pnl: -1, resolved: true },
    { strategy: "regular", actualCost: 2, contractCount: 2, pnl: null, resolved: true },
    { strategy: "scalper", actualCost: 10, contractCount: 10, pnl: 3, resolved: false },
    { strategy: "scalper", actualCost: 10, contractCount: 10, pnl: 3, resolved: true },
  ], 2, 20);

  assert.equal(result.regular.includedCount, 0);
  assert.equal(result.regular.excludedCount, 3);
  assert.equal(result.scalper.includedCount, 1);
  assert.equal(result.scalper.excludedCount, 1);
  assert.equal(result.scalper.unresolvedCount, 1);
  assert.equal(result.scalper.hypotheticalPnl, 6);
  assert.equal(result.totals.includedCount, 1);
  assert.equal(result.totals.excludedCount, 4);
});

test("simulation floors hypothetical sizing to whole contracts", () => {
  const result = calculatePnlSimulation([
    { strategy: "regular", actualCost: 3, contractCount: 2, pnl: 1, resolved: true },
  ], 5, 10);

  assert.equal(result.regular.hypotheticalStake, 4.5);
  assert.equal(result.regular.hypotheticalPnl, 1.5);
});

test("whole-contract sizing is exact at decimal price boundaries", () => {
  assert.equal(wholeContractsForStake(0.3, 0.1), 3);
  assert.equal(wholeContractsForStake(1, 0.2), 5);
  assert.equal(wholeContractsForStake(0.29, 0.1), 2);
});