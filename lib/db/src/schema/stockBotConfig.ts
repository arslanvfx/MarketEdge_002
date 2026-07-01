import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Single-row config store for the stock trading bot. Separate table from the
// crypto bot's bot_config so the two systems never share state.
export const stockBotConfigTable = pgTable("stock_bot_config", {
  id: text("id").primaryKey(),
  config: jsonb("config").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
