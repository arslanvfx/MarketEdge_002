import { numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const stockBotDecisionsTable = pgTable("stock_bot_decisions", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  action: text("action").notNull(),
  horizon: text("horizon"),
  confidence: numeric("confidence", { precision: 6, scale: 2 }),
  reason: text("reason").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
});
