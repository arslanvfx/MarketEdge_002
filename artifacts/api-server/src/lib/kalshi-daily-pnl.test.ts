import assert from "node:assert/strict";
import test from "node:test";
import { DAILY_TRADING_PNL_SQL } from "./kalshi-daily-pnl-query.ts";
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