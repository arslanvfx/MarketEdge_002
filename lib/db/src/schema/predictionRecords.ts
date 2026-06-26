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
  // Which model produced this prediction: "stat" (statistical model),
  // "claude" (Claude refinement), or "ensemble" (regime-weighted blend of the
  // two). Lets accuracy and bias be computed per source so Claude only ever
  // calibrates against its own track record.
  source: text("source").notNull().default("stat"),
  // Ensemble-only: true when the blended call abstained (no bet) because the
  // models disagreed on direction or combined confidence was below threshold.
  // null for stat/claude records (abstention is an ensemble concept only).
  abstained: boolean("abstained"),
  // Intra-window efficiency ratio at snapshot time — lets accuracy and bias be
  // bucketed by market regime (trending / drifting / choppy) after the fact.
  efficiencyRatio: numeric("efficiency_ratio", { precision: 6, scale: 4 }),
  // Claude's pre-calibration ("reported") confidence. `confidence` stores the
  // calibrated value that is shown/scored; rawConfidence is what we learn the
  // reliability curve from, so calibration never feeds on its own output.
  rawConfidence: integer("raw_confidence"),
});
