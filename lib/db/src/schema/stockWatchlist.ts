import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// User-defined watchlist. Stocks here are ALWAYS monitored by the scanner and
// bot regardless of scanner ranking. Fully independent of the crypto system.
export const stockWatchlistTable = pgTable("stock_watchlist", {
  ticker: text("ticker").primaryKey(),
  companyName: text("company_name"),
  sector: text("sector"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});
