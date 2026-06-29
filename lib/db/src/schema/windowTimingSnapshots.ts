import { boolean, integer, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const windowTimingSnapshotsTable = pgTable("window_timing_snapshots", {
  id: text("id").primaryKey(),            // {symbol}:{windowKey}:{minuteMark}
  symbol: text("symbol").notNull(),
  windowKey: text("window_key").notNull(),// ISO 15-min window start "2026-06-29T14:30"
  targetTime: timestamp("target_time", { withTimezone: true }).notNull(),
  minuteMark: integer("minute_mark").notNull(), // seconds into window: 60,180,360,540,720
  priceAbove: boolean("price_above"),     // currentPrice > kalshiTarget at snapshot
  kalshiTarget: numeric("kalshi_target", { precision: 16, scale: 6 }),
  currentPrice: numeric("current_price", { precision: 16, scale: 6 }),
  kalshiYesPrice: numeric("kalshi_yes_price", { precision: 8, scale: 4 }), // Kalshi Yes price at mark
  statAbove: boolean("stat_above"),       // open-snap stat model direction
  ensembleAbove: boolean("ensemble_above"), // open-snap ensemble direction
  actualAbove: boolean("actual_above"),   // filled at window close
  correct: boolean("correct"),            // priceAbove === actualAbove
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
});
