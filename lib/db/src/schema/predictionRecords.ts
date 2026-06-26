import { pgTable, text, timestamp, numeric, integer, boolean } from "drizzle-orm/pg-core";

export const predictionRecordsTable = pgTable("prediction_records", {
  id: text("id").primaryKey(), // `${symbol}-${targetTime ISO}`
  symbol: text("symbol").notNull(),
  snappedAt: timestamp("snapped_at", { withTimezone: true }).notNull(),
  targetTime: timestamp("target_time", { withTimezone: true }).notNull(),
  targetLabel: text("target_label").notNull(),
  priceAtSnapshot: numeric("price_at_snapshot", { precision: 16, scale: 6 }).notNull(),
  predictedPrice: numeric("predicted_price", { precision: 16, scale: 6 }).notNull(),
  predictedDirection: text("predicted_direction").notNull(),
  confidence: integer("confidence").notNull(),
  kalshiTarget: numeric("kalshi_target", { precision: 16, scale: 6 }),
  actualPrice: numeric("actual_price", { precision: 16, scale: 6 }),
  errorPct: numeric("error_pct", { precision: 10, scale: 6 }),
  correct: boolean("correct"),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
  status: text("status").notNull().default("pending"),
  // Which model produced this prediction: "stat" (statistical model) or
  // "claude" (Claude refinement). Lets accuracy and bias be computed per
  // source so Claude only ever calibrates against its own track record.
  source: text("source").notNull().default("stat"),
});
