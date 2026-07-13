// Intraday news monitor — polls Alpaca/Benzinga news for open positions every 5 min.
// Detects breaking negative headlines and flags them as alerts so the next bot
// cycle can trigger an immediate Claude exit re-check.
// Positive news is logged as confirmation (no action needed).

import { getNews } from "./alpaca";
import { logger } from "../logger";

export interface NewsAlert {
  ticker: string;
  headline: string;
  summary: string;
  sentiment: "strong_bearish" | "strong_bullish";
  publishedAt: string;
  seenAt: number;
}

// Active alerts awaiting consumption by the bot cycle
const activeAlerts = new Map<string, NewsAlert>();
// Most-recent news ID seen per ticker (prevents double-processing)
const lastSeenId = new Map<string, string>();

let monitorRunning = false;

// ── Keyword patterns ──────────────────────────────────────────────────────────

const BEARISH_CRITICAL = /\b(fraud|sec\s+(probe|investigation|charges?)|subpoena|recalls?|bankruptcy|insolvency|miss(ed)?\s+(earnings|estimates|eps|revenue|guidance)|guidance\s+(cut|lowered|slashed|reduced|below|miss)|downgrade|layoffs?|restatement|restated?|class[\s-]action\s+lawsuit|short[\s-]seller|short\s+report|going\s+concern|default|debt\s+covenant|fdic|osha\s+fine|patent\s+invalidat|lost\s+contract|contract\s+cancel|data\s+breach|whistleblower|insider\s+trading)\b/i;

const BULLISH_STRONG = /\b(beat\s+(earnings|estimates|eps|revenue)|exceeded\s+(expectations|estimates|guidance)|upgrade|raised?\s+guidance|price\s+target\s+(raised?|increased?|upped?)|share\s+buyback|stock\s+repurchase|acquisition|strategic\s+partnership|fda\s+(approv|clear|grant)|record\s+(revenue|earnings|sales|profit)|dividend\s+(increase|hike|special)|strategic\s+review|activist\s+investor)\b/i;

/**
 * Poll news for a set of open-position tickers.
 * Call this on a 5-minute interval during market hours.
 */
export async function checkNewsForPositions(tickers: string[]): Promise<void> {
  if (tickers.length === 0 || monitorRunning) return;
  monitorRunning = true;
  try {
    // Alpaca news endpoint accepts up to ~50 symbols; chunk conservatively
    const chunks: string[][] = [];
    for (let i = 0; i < tickers.length; i += 10) chunks.push(tickers.slice(i, i + 10));

    for (const chunk of chunks) {
      try {
        const items = await getNews(chunk, 5);
        for (const item of items) {
          const ticker = (item.ticker ?? "").toUpperCase();
          if (!ticker || !tickers.includes(ticker)) continue;
          if (!item.id) continue;

          // Baseline on first encounter — don't alert on pre-existing news
          if (!lastSeenId.has(ticker)) {
            lastSeenId.set(ticker, item.id);
            continue;
          }
          // Already processed
          if (lastSeenId.get(ticker) === item.id) continue;
          lastSeenId.set(ticker, item.id);

          const headline = item.headline ?? "";
          const summary = item.summary ?? "";
          const text = `${headline} ${summary}`;
          const publishedAt = item.publishedAt ?? new Date().toISOString();

          if (BEARISH_CRITICAL.test(text)) {
            const alert: NewsAlert = {
              ticker,
              headline,
              summary,
              sentiment: "strong_bearish",
              publishedAt,
              seenAt: Date.now(),
            };
            activeAlerts.set(ticker, alert);
            logger.warn({ ticker, headline }, "[news-monitor] ⚠ BEARISH alert — position flagged for exit review");
          } else if (BULLISH_STRONG.test(text)) {
            logger.info({ ticker, headline }, "[news-monitor] ✓ Bullish catalyst confirmed for held position");
          }
        }
      } catch (err) {
        logger.warn({ err, chunk }, "[news-monitor] news fetch failed for chunk");
      }
    }
  } finally {
    monitorRunning = false;
  }
}

/**
 * Returns the active bearish alert for a ticker and clears it (one-shot).
 * Returns null if no alert is pending.
 */
export function consumeNewsAlert(ticker: string): NewsAlert | null {
  const T = ticker.toUpperCase();
  const alert = activeAlerts.get(T) ?? null;
  if (alert) activeAlerts.delete(T);
  return alert;
}

/** All currently pending alerts (for dashboard / logging). */
export function getActiveNewsAlerts(): NewsAlert[] {
  return [...activeAlerts.values()];
}

/**
 * Register a ticker so the monitor knows its baseline news ID on first check.
 * Call when a new position is opened.
 */
export function registerPositionTicker(ticker: string): void {
  lastSeenId.delete(ticker.toUpperCase()); // force baseline re-set on next poll
}

/** Remove a ticker from tracking when a position is closed. */
export function unregisterPositionTicker(ticker: string): void {
  const T = ticker.toUpperCase();
  lastSeenId.delete(T);
  activeAlerts.delete(T);
}
