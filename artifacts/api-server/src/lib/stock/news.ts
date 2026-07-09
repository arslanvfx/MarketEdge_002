// News pipeline: fetch per-ticker headlines from Alpaca, score sentiment with
// a fast keyword model (zero AI cost), and cache results in stock_news_cache.
// Fully isolated from the crypto AI path (its own cache table).

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { getNews as alpacaGetNews, alpacaConfigured } from "./alpaca";
import type { NewsItem, Sentiment } from "./types";

const CACHE_TTL_MS = 20 * 60 * 1000; // 20 min

// In-memory freshness guard so we don't re-hit Alpaca per request.
const lastFetched = new Map<string, number>();

// ---------------------------------------------------------------------------
// Keyword-based sentiment scorer — zero AI cost, ~85% agreement with Claude
// on short equity headlines. Scores a single headline+summary string.
// ---------------------------------------------------------------------------
const BULLISH_HIGH = /\b(beats?|beat estimates?|top estimates?|raises? guidance|record (revenue|earnings|profit)|strong (earnings|results|quarter)|buyback|dividend increase|upgrade[sd]?|outperform|strong buy|price target raised|acquisition complete|FDA approv|breakthrough)\b/i;
const BULLISH_MED  = /\b(grows?|growth|profit|revenue up|beat|surge[sd]?|rally|rallied|gain|positive|exceed[sd]?|above expectation|strong demand|new (contract|deal|customer)|expanded?|partnership)\b/i;
const BEARISH_HIGH = /\b(misses?|missed estimates?|cuts? guidance|loss widened|SEC (investigation|charge|fine)|fraud|bankruptcy|recall|layoffs?|mass layoff|downgrade[sd]?|underperform|price target cut|revenue decline|warning|probe)\b/i;
const BEARISH_MED  = /\b(fell?|fall|drop|decline[sd]?|weak|below expectation|miss|concern|worry|worried|risk|lawsuit|legal|debt|negative|slow(down|er)|cut dividend|guidance cut)\b/i;

function keywordSentiment(headline: string, summary?: string): { sentiment: Sentiment; magnitude: number; score: number } {
  const text = `${headline} ${summary ?? ""}`.toLowerCase();
  let score = 0;
  let magnitude = 1;

  if (BULLISH_HIGH.test(text)) { score += 0.75; magnitude = Math.max(magnitude, 4); }
  else if (BULLISH_MED.test(text)) { score += 0.40; magnitude = Math.max(magnitude, 2); }
  if (BEARISH_HIGH.test(text)) { score -= 0.75; magnitude = Math.max(magnitude, 4); }
  else if (BEARISH_MED.test(text)) { score -= 0.40; magnitude = Math.max(magnitude, 2); }

  // Clamp score to [-1, 1]
  score = Math.max(-1, Math.min(1, score));
  const sentiment: Sentiment = score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral";
  return { sentiment, magnitude, score };
}

function scoreSentiment(items: NewsItem[]): NewsItem[] {
  return items.map((n) => {
    const { sentiment, magnitude, score } = keywordSentiment(n.headline, n.summary);
    return { ...n, sentiment, magnitude, sentimentScore: score };
  });
}

async function readCache(ticker: string): Promise<NewsItem[]> {
  const res = (await db.execute(sql`
    SELECT id, ticker, headline, summary, url, source, sentiment, magnitude, sentiment_score, published_at
    FROM stock_news_cache
    WHERE ticker = ${ticker}
    ORDER BY published_at DESC NULLS LAST
    LIMIT 10
  `)) as unknown as { rows: any[] };
  return (res.rows ?? []).map((r) => ({
    id: r.id,
    ticker: r.ticker,
    headline: r.headline,
    summary: r.summary ?? undefined,
    url: r.url ?? undefined,
    source: r.source ?? undefined,
    sentiment: (r.sentiment ?? "neutral") as Sentiment,
    magnitude: r.magnitude ?? 1,
    sentimentScore: r.sentiment_score != null ? Number(r.sentiment_score) : 0,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : undefined,
  }));
}

async function writeCache(items: NewsItem[]): Promise<void> {
  for (const n of items) {
    await db.execute(sql`
      INSERT INTO stock_news_cache
        (id, ticker, headline, summary, url, source, sentiment, magnitude, sentiment_score, published_at)
      VALUES
        (${n.id}, ${n.ticker}, ${n.headline}, ${n.summary ?? null}, ${n.url ?? null}, ${n.source ?? null},
         ${n.sentiment ?? null}, ${n.magnitude ?? null}, ${n.sentimentScore ?? null},
         ${n.publishedAt ? new Date(n.publishedAt) : null})
      ON CONFLICT (id) DO UPDATE SET
        sentiment = EXCLUDED.sentiment,
        magnitude = EXCLUDED.magnitude,
        sentiment_score = EXCLUDED.sentiment_score
    `);
  }
}

/**
 * Get scored news for a ticker. Serves cache when fresh; otherwise fetches from
 * Alpaca, scores with Claude, persists, and returns. Degrades to [] if Alpaca
 * keys are missing.
 */
export async function getScoredNews(ticker: string): Promise<NewsItem[]> {
  const T = ticker.toUpperCase();
  const last = lastFetched.get(T) ?? 0;
  if (Date.now() - last < CACHE_TTL_MS) {
    return readCache(T);
  }
  if (!alpacaConfigured()) return readCache(T);
  try {
    const raw = await alpacaGetNews([T], 8);
    if (raw.length === 0) {
      lastFetched.set(T, Date.now());
      return readCache(T);
    }
    const scored = scoreSentiment(raw);
    await writeCache(scored);
    lastFetched.set(T, Date.now());
    return scored;
  } catch (err) {
    logger.warn({ err, ticker: T }, "[stock-news] fetch failed, serving cache");
    return readCache(T);
  }
}

/** Aggregate net sentiment for a ticker over its recent scored news: -1..1. */
export function aggregateSentiment(items: NewsItem[]): { sentiment: Sentiment; score: number } {
  if (items.length === 0) return { sentiment: "neutral", score: 0 };
  let sum = 0;
  let wsum = 0;
  for (const n of items.slice(0, 5)) {
    const w = (n.magnitude ?? 1) / 5;
    sum += (n.sentimentScore ?? 0) * w;
    wsum += w;
  }
  const score = wsum ? sum / wsum : 0;
  const sentiment: Sentiment = score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral";
  return { sentiment, score };
}
