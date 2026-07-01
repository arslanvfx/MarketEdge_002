import { integer, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Stock trading bot trade log. Mirrors kalshi_bot_bets in spirit but models
// real equity positions (shares, entry/exit price, stop-loss, target). Fully
// independent of the crypto/Kalshi bot tables.
export const stockBotBetsTable = pgTable("stock_bot_bets", {
  id: text("id").primaryKey(),
  ticker: text("ticker").notNull(),
  sector: text("sector"),
  action: text("action").notNull(),          // "buy" | "skip" | "exit"
  tradingMode: text("trading_mode").notNull(),// "day" | "swing" | "long"
  mode: text("mode").notNull(),              // "paper" | "live"
  side: text("side").notNull().default("long"), // "long" (long-only for now)
  qty: numeric("qty", { precision: 14, scale: 4 }),
  signals: jsonb("signals"),                 // full reasoning snapshot at entry
  confidence: numeric("confidence", { precision: 6, scale: 2 }),
  entryPrice: numeric("entry_price", { precision: 14, scale: 4 }),
  exitPrice: numeric("exit_price", { precision: 14, scale: 4 }),
  stopLoss: numeric("stop_loss", { precision: 14, scale: 4 }),
  targetPrice: numeric("target_price", { precision: 14, scale: 4 }),
  notional: numeric("notional", { precision: 16, scale: 4 }),
  pnl: numeric("pnl", { precision: 16, scale: 4 }),
  exitReason: text("exit_reason"),
  outcome: text("outcome"),                  // "win" | "loss" | "push" | null
  alpacaOrderId: text("alpaca_order_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  exitedAt: timestamp("exited_at", { withTimezone: true }),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});
