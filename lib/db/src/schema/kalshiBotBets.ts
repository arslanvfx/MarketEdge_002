import { boolean, integer, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const kalshiBotBetsTable = pgTable("kalshi_bot_bets", {
  id: text("id").primaryKey(),
  symbol: text("symbol").notNull(),
  windowKey: text("window_key").notNull(),
  ticker: text("ticker"),
  direction: text("direction"),             // "yes" | "no" | null (skip)
  action: text("action").notNull(),         // "bet" | "skip" | "exit" | "late_recovery_exit" | "expired"
  mode: text("mode").notNull(),             // "paper" | "live"
  signals: jsonb("signals"),                // full reasoning snapshot at decision time
  entryPrice: numeric("entry_price", { precision: 8, scale: 4 }),
  exitPrice: numeric("exit_price", { precision: 8, scale: 4 }),
  contractCount: integer("contract_count"),
  betAmount: numeric("bet_amount", { precision: 10, scale: 4 }),
  pnl: numeric("pnl", { precision: 10, scale: 4 }),
  exitReason: text("exit_reason"),
  phase2Activated: boolean("phase2_activated").default(false),
  phase2RecoveredAmount: numeric("phase2_recovered_amount", { precision: 10, scale: 4 }),
  outcome: text("outcome"),                 // "win" | "loss" | "push" | null
  kalshiTarget: numeric("kalshi_target", { precision: 16, scale: 6 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  exitedAt: timestamp("exited_at", { withTimezone: true }),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
});
