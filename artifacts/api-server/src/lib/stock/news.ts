// News pipeline: fetch per-ticker headlines from Alpaca, score sentiment with
// Claude, and cache the scored results in stock_news_cache. Fully isolated from
// the crypto AI path (its own cache table, its own Claude prompt).

import { sql } from "drizzle-orm";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { getNews as alpacaGetNews, alpacaConfigured } from "./alpaca";
import type { NewsItem, Sentiment } from "./types";

const MODEL = "claude-sonnet-4-6";
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 min

// In-memory freshness guard so we don't re-hit Alpaca + Claude per request.
const lastFetched = new Map<string, number>();

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : trimmed;
}

async function scoreSentiment(items: NewsItem[]): Promise<NewsItem[]> {
  if (items.length === 0) return items;
  const lines = items
    .map((n, i) => `${i}. [${n.ticker}] "${n.headline}"${n.summary ? ` — ${n.summary.slice(0, 200)}` : ""}`)
    .join("\n");
  const prompt = `You are a sharp equity news analyst. For each news item, judge its likely SHORT-TERM impact on the stock's price.

For each item return:
- "sentiment": "bullish" | "bearish" | "neutral"
- "magnitude": integer 1-5 (1 = trivial, 5 = major market-moving)
- "score": number -1.0 to 1.0 (negative = bearish, positive = bullish, scaled by conviction)

News items:
${lines}

Respond with ONLY a JSON array, one object per item:
[{"index":0,"sentiment":"bullish","magnitude":3,"score":0.5}]
No prose, no markdown fences.`;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });
    const block = message.content[0];
    const text = block && block.type === "text" ? block.text : "";
    const parsed = JSON.parse(stripJsonFences(text)) as {
      index: number;
      sentiment: Sentiment;
      magnitude: number;
      score: number;
    }[];
    const byIdx = new Map(parsed.map((p) => [p.index, p]));
    return items.map((n, i) => {
      const p = byIdx.get(i);
      if (!p) return { ...n, sentiment: "neutral", magnitude: 1, sentimentScore: 0 };
      return {
        ...n,
        sentiment: p.sentiment ?? "neutral",
        magnitude: Math.max(1, Math.min(5, Math.round(p.magnitude ?? 1))),
        sentimentScore: Math.max(-1, Math.min(1, p.score ?? 0)),
      };
    });
  } catch (err) {
    logger.warn({ err }, "[stock-news] sentiment scoring failed (non-fatal)");
    return items.map((n) => ({ ...n, sentiment: "neutral", magnitude: 1, sentimentScore: 0 }));
  }
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
    const scored = await scoreSentiment(raw);
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
