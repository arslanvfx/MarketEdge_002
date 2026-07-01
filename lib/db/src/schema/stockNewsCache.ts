import { integer, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Per-ticker news items with Claude sentiment scoring. Cached so repeated
// scanner/detail requests don't re-hit the news API or re-run Claude.
export const stockNewsCacheTable = pgTable("stock_news_cache", {
  id: text("id").primaryKey(),               // stable id from news source
  ticker: text("ticker").notNull(),
  headline: text("headline").notNull(),
  summary: text("summary"),
  url: text("url"),
  source: text("source"),
  sentiment: text("sentiment"),              // "bullish" | "bearish" | "neutral"
  magnitude: integer("magnitude"),           // 1-5 strength
  sentimentScore: numeric("sentiment_score", { precision: 6, scale: 3 }), // -1..1
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
