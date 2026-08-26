import { pool } from "@workspace/db";
import type { BotMode } from "./kalshi-bot-state.ts";
import {
  DAILY_PNL_SIMULATION_ROWS_SQL,
  DAILY_TRADING_PNL_SQL,
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