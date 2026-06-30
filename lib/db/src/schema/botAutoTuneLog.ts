import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const botAutoTuneLogTable = pgTable("bot_auto_tune_log", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  ruleName: text("rule_name").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  triggerReason: text("trigger_reason").notNull(),
});
