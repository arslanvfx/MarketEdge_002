// Stock bot config store. Uses a raw parameterized upsert (NOT Drizzle's
// onConflictDoUpdate) because that helper has been observed to silently fail for
// single-row jsonb config tables in this codebase. Separate row/table from the
// crypto bot config.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import type { StockBotConfig } from "./types";

const CONFIG_ID = "stock-bot";

export const DEFAULT_CONFIG: StockBotConfig = {
  enabled: false,
  mode: "paper",
  tradingModes: ["day", "swing"],
  positionSizePct: 5,
  maxConcurrentPositions: 5,
  maxDayPositions: 3,
  maxSwingPositions: 3,
  maxLongPositions: 3,
  dailyLossLimit: 500,
  minConfidence: 60,
  stopLossPct: 3,
  targetGainPct: 6,
  swingMaxHoldDays: 5,
  longMaxHoldDays: 30,
  earningsBlackout: true,
  earningsBlackoutHours: 24,
  newsSensitivity: 3,
};

let current: StockBotConfig = { ...DEFAULT_CONFIG };

export function getConfig(): StockBotConfig {
  return current;
}

export function setConfigInMemory(cfg: StockBotConfig): void {
  current = cfg;
}

export async function loadConfigFromDB(): Promise<StockBotConfig> {
  try {
    const res = (await db.execute(sql`
      SELECT config FROM stock_bot_config WHERE id = ${CONFIG_ID}
    `)) as unknown as { rows: any[] };
    const row = res.rows?.[0];
    if (row?.config) {
      const parsed = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
      current = { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch (err) {
    logger.warn({ err }, "[stock-bot] config load failed (non-fatal)");
  }
  return current;
}

export async function saveConfig(partial: Partial<StockBotConfig>): Promise<StockBotConfig> {
  current = { ...current, ...partial };
  try {
    await db.execute(sql`
      INSERT INTO stock_bot_config (id, config, updated_at)
      VALUES (${CONFIG_ID}, ${JSON.stringify(current)}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET
        config = ${JSON.stringify(current)}::jsonb,
        updated_at = NOW()
    `);
  } catch (err) {
    logger.warn({ err }, "[stock-bot] config save failed (non-fatal)");
  }
  return current;
}
