import { pgTable, text, timestamp, numeric, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const savedCombosTable = pgTable("saved_combos", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  note: text("note"),
  jointProbabilityAtSave: numeric("joint_probability_at_save", { precision: 10, scale: 8 }).notNull(),
  payoutMultiplierAtSave: numeric("payout_multiplier_at_save", { precision: 10, scale: 4 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const comboLegsTable = pgTable("combo_legs", {
  id: text("id").primaryKey(),
  comboId: text("combo_id").notNull().references(() => savedCombosTable.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  marketId: text("market_id").notNull(),
  marketTitle: text("market_title").notNull(),
  position: text("position").notNull(),
  oddsAtSave: numeric("odds_at_save", { precision: 10, scale: 8 }).notNull(),
  impliedProbAtSave: numeric("implied_prob_at_save", { precision: 10, scale: 8 }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const insertSavedComboSchema = createInsertSchema(savedCombosTable).omit({ createdAt: true });
export const insertComboLegSchema = createInsertSchema(comboLegsTable);

export type InsertSavedCombo = z.infer<typeof insertSavedComboSchema>;
export type SavedCombo = typeof savedCombosTable.$inferSelect;
export type InsertComboLeg = z.infer<typeof insertComboLegSchema>;
export type ComboLeg = typeof comboLegsTable.$inferSelect;
