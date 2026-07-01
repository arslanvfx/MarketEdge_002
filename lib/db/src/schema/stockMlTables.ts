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

// One ML training snapshot per stock per entry decision, captured at signal
// time. Outcome filled when the trade settles. Separate tables from the crypto
// ML system (which uses ml_window_snapshots / ml_model_state) so the two models
// never contaminate each other — including different feature-vector lengths.
export const stockMlSnapshotsTable = pgTable("stock_ml_snapshots", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  refId: text("ref_id").notNull(),           // trade/decision id this snapshot maps to
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
  features: jsonb("features").notNull(),     // number[] normalized feature vector
  outcome: smallint("outcome"),              // NULL until resolved; 1=up, 0=down
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const stockMlModelStateTable = pgTable("stock_ml_model_state", {
  ticker: text("ticker").primaryKey(),
  weights: jsonb("weights").notNull(),       // number[] — [bias, w1..wN]
  trainingSamples: integer("training_samples").notNull().default(0),
  labeledSamples: integer("labeled_samples").notNull().default(0),
  lastTrainedAt: timestamp("last_trained_at", { withTimezone: true }).notNull(),
  valAccuracy: numeric("val_accuracy", { precision: 6, scale: 4 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
