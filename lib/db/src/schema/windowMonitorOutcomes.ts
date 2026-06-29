import { pgTable, text, timestamp, numeric, boolean, jsonb } from "drizzle-orm/pg-core";

export const windowMonitorOutcomesTable = pgTable("window_monitor_outcomes", {
  id: text("id").primaryKey(),
  symbol: text("symbol").notNull(),
  windowKey: text("window_key").notNull(),
  targetTime: text("target_time").notNull(),
  recommendation: text("recommendation").notNull(),
  factors: jsonb("factors").notNull(),
  kalshiTarget: numeric("kalshi_target", { precision: 16, scale: 6 }),
  statPredictedAbove: boolean("stat_predicted_above"),
  actualAbove: boolean("actual_above"),
  outcome: text("outcome"),
  lockedAt: timestamp("locked_at", { withTimezone: true }).notNull(),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
});
