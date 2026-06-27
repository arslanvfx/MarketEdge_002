import {
  pgTable,
  text,
  timestamp,
  numeric,
  integer,
  jsonb,
  serial,
  smallint,
} from "drizzle-orm/pg-core";

// One snapshot per 15-min window per coin, captured at prediction-snap time.
// Features are the normalized input vector; outcome is filled when the window closes.
export const mlWindowSnapshotsTable = pgTable("ml_window_snapshots", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  windowId: text("window_id").notNull(),     // targetTime ISO — the 15-min boundary
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
  elapsedFraction: numeric("elapsed_fraction", { precision: 6, scale: 4 }).notNull(),
  features: jsonb("features").notNull(),     // number[] — normalized feature vector
  outcome: smallint("outcome"),              // NULL until resolved; 1=above, 0=below
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Trained logistic-regression model state per coin.
// Weights survive server restarts so the model never forgets what it learned.
export const mlModelStateTable = pgTable("ml_model_state", {
  symbol: text("symbol").primaryKey(),
  weights: jsonb("weights").notNull(),             // number[] — [bias, w1..w12]
  trainingSamples: integer("training_samples").notNull().default(0),
  labeledWindows: integer("labeled_windows").notNull().default(0),
  lastTrainedAt: timestamp("last_trained_at", { withTimezone: true }).notNull(),
  valAccuracy: numeric("val_accuracy", { precision: 6, scale: 4 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
