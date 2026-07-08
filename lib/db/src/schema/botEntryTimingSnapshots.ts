import { boolean, real, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const botEntryTimingSnapshotsTable = pgTable("bot_entry_timing_snapshots", {
  id: text("id").primaryKey(),                // {coin}:{window_key}:{minute_mark}:{mode}
  coin: text("coin").notNull(),
  windowKey: text("window_key").notNull(),    // ISO "2026-07-08T14:30"
  minuteMark: integer("minute_mark").notNull(), // 0–14
  mode: text("mode").notNull(),               // "paper" | "live"
  statAbove: boolean("stat_above"),
  claudeAbove: boolean("claude_above"),
  mlAbove: boolean("ml_above"),
  compositeDirection: boolean("composite_direction"), // mlAbove direction (null if signals not ready)
  compositeConfidence: real("composite_confidence"),  // composite confidence 0–100
  yesPrice: real("yes_price"),               // Kalshi yes price at this minute (0–1)
  finalResult: boolean("final_result"),       // null until window resolves; true=YES won
  compositeCorrect: boolean("composite_correct"), // compositeDirection === finalResult
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
