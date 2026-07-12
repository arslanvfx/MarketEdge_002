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
  cryptoPriceAtEntry: numeric("crypto_price_at_entry", { precision: 16, scale: 2 }),
  cryptoPriceAtExit: numeric("crypto_price_at_exit", { precision: 16, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  exitedAt: timestamp("exited_at", { withTimezone: true }),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  // Soft-archive: set when the user clears history via the UI or API.
  // Archived rows are hidden from the display (history list, win-rate stats, P&L)
  // but are KEPT in the DB so operational queries (momentum filter seeding,
  // border proximity guard, evalClosedBets, auto-tune) continue to work correctly.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  // Decision mode active when the bet was placed: "classic" | "ml_gate" | "consensus" | "ml_primary".
  // Null for bets placed before this field was added (treated as "classic").
  decisionMode: text("decision_mode"),
  // Originating source of the bet: "bot" (automated) | "manual" (placed via dashboard button).
  // Null for rows written before this field was added (treated as "bot").
  source: text("source"),
  // Kalshi YES contract price (0–1) at the moment the bet decision was made.
  // Populated for all bets; especially useful for conviction mode threshold analysis.
  entryYesPrice: numeric("entry_yes_price", { precision: 8, scale: 4 }),
  // True when the stability gate + probability roll upgraded this bet to max size.
  // Null / false for regular-sized bets and all non-bet rows.
  isMaxBet: boolean("is_max_bet").default(false),
});
