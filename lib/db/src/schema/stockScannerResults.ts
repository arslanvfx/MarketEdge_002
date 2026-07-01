import { boolean, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Latest market-scanner ranking, one row per scanned ticker. Overwritten each
// scan cycle. Feeds the scanner UI without re-scanning on every request.
export const stockScannerResultsTable = pgTable("stock_scanner_results", {
  ticker: text("ticker").primaryKey(),
  companyName: text("company_name"),
  sector: text("sector").notNull(),
  price: numeric("price", { precision: 14, scale: 4 }),
  changePct: numeric("change_pct", { precision: 8, scale: 4 }),
  score: numeric("score", { precision: 8, scale: 4 }).notNull(),
  direction: text("direction"),              // "up" | "down" | null
  confidence: numeric("confidence", { precision: 6, scale: 2 }),
  newsSentiment: text("news_sentiment"),     // "bullish" | "bearish" | "neutral"
  earningsSoon: boolean("earnings_soon").default(false),
  details: jsonb("details"),                 // indicator + signal breakdown
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
