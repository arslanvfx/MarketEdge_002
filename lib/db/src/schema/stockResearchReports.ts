import { boolean, integer, jsonb, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const stockResearchReportsTable = pgTable("stock_research_reports", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  companyName: text("company_name"),
  sector: text("sector"),
  horizon: text("horizon").notNull(),
  stance: text("stance"),
  confidence: numeric("confidence", { precision: 6, scale: 2 }).notNull(),
  summary: text("summary"),
  factorsJson: jsonb("factors_json"),
  valuation: text("valuation"),
  price: numeric("price", { precision: 14, scale: 4 }),
  webSearchUsed: boolean("web_search_used").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
