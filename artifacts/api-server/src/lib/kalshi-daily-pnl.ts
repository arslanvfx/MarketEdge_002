import { pool } from "@workspace/db";
import type { BotMode } from "./kalshi-bot-state.ts";
import { DAILY_TRADING_PNL_SQL } from "./kalshi-daily-pnl-query.ts";

export interface DailyTradingPnl {
  mode: BotMode;
  timeZone: "America/New_York";
  dayStartAt: string;
  nextResetAt: string;
  regularPnl: number;
  scalperPnl: number;
  totalPnl: number;
}

export async function getDailyTradingPnl(mode: BotMode): Promise<DailyTradingPnl> {
  const result = await pool.query(DAILY_TRADING_PNL_SQL, [mode]);
  const row = result.rows[0];
  if (!row) {
    throw new Error("Daily trading P&L query returned no row");
  }

  const regularPnl = Number(row["regular_pnl"]);
  const scalperPnl = Number(row["scalper_pnl"]);
  const dayStartAt = new Date(row["day_start_at"]).toISOString();
  const nextResetAt = new Date(row["next_reset_at"]).toISOString();

  if (!Number.isFinite(regularPnl) || !Number.isFinite(scalperPnl)) {
    throw new Error("Daily trading P&L query returned invalid totals");
  }

  return {
    mode,
    timeZone: "America/New_York",
    dayStartAt,
    nextResetAt,
    regularPnl,
    scalperPnl,
    totalPnl: regularPnl + scalperPnl,
  };
}