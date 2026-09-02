import { pool } from "@workspace/db";
import type { BotMode } from "./kalshi-bot-state.ts";
import {
  DAILY_HOURLY_PNL_SQL,
  DAILY_PNL_SIMULATION_ROWS_SQL,
  DAILY_TRADING_PNL_SQL,
  PAPER_TRADING_BALANCE_SQL,
} from "./kalshi-daily-pnl-query.ts";
import {
  calculatePnlSimulation,
  finitePnlNumber,
  type PnlSimulationBreakdown,
  type PnlSimulationInputRow,
} from "./kalshi-daily-pnl-calculator.ts";

export interface DailyTradingPnl {
  mode: BotMode;
  timeZone: "America/New_York";
  asOf: string;
  dayStartAt: string;
  nextResetAt: string;
  regularPnl: number;
  scalperPnl: number;
  totalPnl: number;
  paperBalance: number | null;
}

export interface PaperTradingBalance {
  startingBalance: number;
  regularPnl: number;
  scalperPnl: number;
  accountBalance: number;
}

export async function getPaperTradingBalance(
  startingBalance: number,
  balanceResetAt?: string | null,
): Promise<PaperTradingBalance> {
  const result = await pool.query(PAPER_TRADING_BALANCE_SQL, [
    startingBalance,
    balanceResetAt ?? null,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error("Paper trading balance query returned no row");

  const values = {
    startingBalance: Number(row["starting_balance"]),
    regularPnl: Number(row["regular_pnl"]),
    scalperPnl: Number(row["scalper_pnl"]),
    accountBalance: Number(row["account_balance"]),
  };
  if (Object.values(values).some((value) => !Number.isFinite(value))) {
    throw new Error("Paper trading balance query returned invalid totals");
  }
  return values;
}

export async function getDailyTradingPnl(
  mode: BotMode,
  pnlResetAt?: string | null,
  paperStartingBalance = 100,
  paperBalanceResetAt?: string | null,
): Promise<DailyTradingPnl> {
  const [result, paperWallet] = await Promise.all([
    pool.query(DAILY_TRADING_PNL_SQL, [mode, pnlResetAt ?? null]),
    mode === "paper"
      ? getPaperTradingBalance(paperStartingBalance, paperBalanceResetAt)
      : Promise.resolve(null),
  ]);
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
    asOf: new Date().toISOString(),
    dayStartAt,
    nextResetAt,
    regularPnl,
    scalperPnl,
    totalPnl: regularPnl + scalperPnl,
    paperBalance: paperWallet?.accountBalance ?? null,
  };
}

export interface DailyHourlyPnlBar {
  /** ET hour 0–23 */
  etHour: number;
  regularPnl: number;
  scalperPnl: number;
  totalPnl: number;
}

export interface DailyHourlyPnl {
  mode: BotMode;
  timeZone: "America/New_York";
  dayStartAt: string;
  nextResetAt: string;
  hours: DailyHourlyPnlBar[];
}

export async function getDailyHourlyPnl(mode: BotMode): Promise<DailyHourlyPnl> {
  const result = await pool.query(DAILY_HOURLY_PNL_SQL, [mode]);

  // Extract bounds from any row (all rows share the same computed bounds)
  // We need to run a bounds-only query if no rows returned.
  const boundsResult = await pool.query<{ day_start_at: Date; next_reset_at: Date }>(
    `SELECT
       date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' AS day_start_at,
       (date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York') + INTERVAL '1 day') AT TIME ZONE 'America/New_York' AS next_reset_at`,
  );
  const bounds = boundsResult.rows[0];
  if (!bounds) throw new Error("Unable to compute daily P&L bounds");

  const hours: DailyHourlyPnlBar[] = result.rows.map((row) => ({
    etHour: Number(row["et_hour"]),
    regularPnl: Number(row["regular_pnl"]),
    scalperPnl: Number(row["scalper_pnl"]),
    totalPnl: Number(row["total_pnl"]),
  }));

  return {
    mode,
    timeZone: "America/New_York",
    dayStartAt: new Date(bounds.day_start_at).toISOString(),
    nextResetAt: new Date(bounds.next_reset_at).toISOString(),
    hours,
  };
}

export interface DailyPnlSimulation {
  mode: BotMode;
  timeZone: "America/New_York";
  dayStartAt: string;
  nextResetAt: string;
  regular: PnlSimulationBreakdown;
  scalper: PnlSimulationBreakdown;
  totals: Omit<PnlSimulationBreakdown, "hypotheticalStakePerBet">;
  assumptions: string[];
}

export async function getDailyPnlSimulation(
  mode: BotMode,
  regularStake: number,
  scalperStake: number,
): Promise<DailyPnlSimulation> {
  const result = await pool.query(DAILY_PNL_SIMULATION_ROWS_SQL, [mode]);
  const first = result.rows[0];
  if (!first) throw new Error("Daily P&L simulation query returned no rows");

  const rows: PnlSimulationInputRow[] = result.rows
    .filter((row) => row["strategy"] === "regular" || row["strategy"] === "scalper")
    .map((row) => ({
      strategy: row["strategy"] as PnlSimulationInputRow["strategy"],
      actualCost: finitePnlNumber(row["actual_cost"]),
      contractCount: finitePnlNumber(row["contract_count"]),
      pnl: finitePnlNumber(row["pnl"]),
      resolved: row["resolved"] === true,
    }));
  const simulation = calculatePnlSimulation(rows, regularStake, scalperStake);

  return {
    mode,
    timeZone: "America/New_York",
    dayStartAt: new Date(first["day_start_at"]).toISOString(),
    nextResetAt: new Date(first["next_reset_at"]).toISOString(),
    ...simulation,
    assumptions: [
      "Each settled bet keeps its actual realized return rate and is rescaled to the selected fixed stake.",
      "The estimate does not model different fills, liquidity, slippage, fees, or market impact.",
      "Only regular automated bot settlements and canonical High-Value Scalper settlements are included.",
    ],
  };
}