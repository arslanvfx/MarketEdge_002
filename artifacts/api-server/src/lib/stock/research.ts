// Claude research pass: evaluates the top-ranked stocks from each scan with a
// structured research brief. The brief is built from Alpaca news, categorized
// into earnings results, analyst moves, M&A/SEC activity, and general news,
// plus upcoming earnings timing and sector macro context.
//
// Results are cached per (ticker, trading-day) so Claude is not re-called on
// every scan cycle. Runs asynchronously after the scan — fire-and-forget safe.

import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../logger";
import { getScoredNews } from "./news";
import { getEarnings } from "./earnings";
import { getSectorMomentum } from "./scanner";
import type { NewsItem } from "./types";

const RESEARCH_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 600;
const MAX_TICKERS = 20;

export interface ResearchResult {
  ticker: string;
  score: number;        // 0–100
  verdict: "Buy" | "Hold" | "Avoid";
  reason: string;       // ≤2 sentences, concrete and specific
  researchedAt: string; // ISO timestamp
}

// In-memory cache keyed by `${TICKER}:${YYYY-MM-DD}`.
const cache = new Map<string, ResearchResult>();
let researchRunning = false;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Return the cached research result for a ticker (today's trading day). */
export function getCachedResearch(ticker: string): ResearchResult | undefined {
  return cache.get(`${ticker.toUpperCase()}:${todayKey()}`);
}

/** Return today's full research map (ticker → result) plus running flag. */
export function getAllResearch(): Record<string, ResearchResult> {
  const day = todayKey();
  const out: Record<string, ResearchResult> = {};
  for (const [key, value] of cache.entries()) {
    if (key.endsWith(`:${day}`)) {
      out[key.slice(0, -day.length - 1)] = value;
    }
  }
  return out;
}

export function getResearchStatus(): { running: boolean; ready: string[] } {
  const day = todayKey();
  const ready: string[] = [];
  for (const key of cache.keys()) {
    if (key.endsWith(`:${day}`)) ready.push(key.slice(0, -day.length - 1));
  }
  return { running: researchRunning, ready };
}

/** Categorize news items by domain for the structured research brief. */
interface CategorizedNews {
  earnings: NewsItem[];   // EPS results, revenue, guidance, beats/misses
  analyst: NewsItem[];    // Upgrades, downgrades, price target changes
  maSec: NewsItem[];      // M&A, acquisitions, SEC filings, regulatory
  general: NewsItem[];    // Other business news
}

function categorizeNews(news: NewsItem[]): CategorizedNews {
  const earnings: NewsItem[] = [];
  const analyst: NewsItem[] = [];
  const maSec: NewsItem[] = [];
  const general: NewsItem[] = [];
  const EARNINGS_RE =
    /\b(earnings|eps|beat|miss|revenue|quarter(ly)?|guidance|profit|loss|net\s+income|adjusted|fiscal|q[1-4]|results?)\b/i;
  const ANALYST_RE =
    /\b(upgrad|downgrad|buy|sell|neutral|overweight|underweight|price.?target|outperform|underperform|analyst|rating|initiat|reiterat|cover)\b/i;
  const MA_SEC_RE =
    /\b(acqui|merger|m&a|buyout|takeover|sec\b|8-k|10-k|10-q|proxy|filing|antitrust|regulatory|fcpa|settlement|lawsuit|litigation)\b/i;

  for (const n of news) {
    const text = `${n.headline} ${n.summary ?? ""}`;
    if (EARNINGS_RE.test(text)) {
      earnings.push(n);
    } else if (ANALYST_RE.test(text)) {
      analyst.push(n);
    } else if (MA_SEC_RE.test(text)) {
      maSec.push(n);
    } else {
      general.push(n);
    }
  }
  return { earnings, analyst, maSec, general };
}

function formatSection(label: string, items: NewsItem[], max = 3): string {
  const slice = items.slice(0, max);
  if (slice.length === 0) return `${label}: none identified in recent news`;
  const lines = slice.map(
    (n) =>
      `  - "${n.headline}"${n.sentiment ? ` [${n.sentiment}, impact ${n.magnitude ?? 1}/5]` : ""}`,
  );
  return `${label}:\n${lines.join("\n")}`;
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Evaluate up to MAX_TICKERS stocks with Claude research (low-token model).
 * Skips tickers already evaluated today. Safe to call concurrently —
 * re-entrant guard ensures only one pass runs at a time.
 */
export async function runResearchPass(tickers: string[]): Promise<void> {
  if (researchRunning) return;
  researchRunning = true;
  const day = todayKey();
  try {
    const batch = tickers.slice(0, MAX_TICKERS);
    for (const rawTicker of batch) {
      const ticker = rawTicker.toUpperCase();
      const cacheKey = `${ticker}:${day}`;
      if (cache.has(cacheKey)) continue; // already done today

      try {
        // Fetch 12 headlines so we have enough items to populate all categories.
        const [allNews, earnings] = await Promise.all([
          getScoredNews(ticker),
          getEarnings(ticker, 72),
        ]);

        const cat = categorizeNews(allNews);

        // Sector momentum as a macro proxy (positive = sector tailwind).
        const uni = (await import("./universe")).lookupUniverse(ticker);
        const sectorMom = uni ? getSectorMomentum(uni.sector) : 0;
        const macroLine =
          sectorMom > 0.5
            ? `Sector tailwind: ${uni?.sector ?? "sector"} up ${sectorMom.toFixed(1)}% on average today`
            : sectorMom < -0.5
              ? `Sector headwind: ${uni?.sector ?? "sector"} down ${Math.abs(sectorMom).toFixed(1)}% on average today`
              : `Sector: ${uni?.sector ?? "sector"} roughly flat today (${sectorMom.toFixed(1)}%)`;

        const earningsLine = earnings
          ? `Upcoming earnings: ${earnings.date} in ${earnings.hoursUntil.toFixed(0)}h${earnings.soon ? " — EARNINGS IMMINENT (within blackout)" : ""}`
          : "Upcoming earnings: no data available";

        const brief = [
          formatSection("EARNINGS RESULTS & GUIDANCE", cat.earnings, 3),
          formatSection("ANALYST MOVES (upgrades/downgrades/targets)", cat.analyst, 3),
          formatSection("M&A / SEC FILINGS / REGULATORY", cat.maSec, 2),
          formatSection("GENERAL BUSINESS NEWS", cat.general, 3),
          `MACRO: ${macroLine}`,
          `TIMING: ${earningsLine}`,
        ].join("\n\n");

        const prompt = `You are a senior equity research analyst. Evaluate ${ticker} as a short-term trading opportunity (1-5 day horizon) using this structured research brief.

${brief}

Score this stock 0-100:
- 70-100: Strong opportunity — clear positive catalysts, analyst support, favorable sector
- 40-69: Neutral — mixed or limited catalysts, wait-and-see
- 0-39: Avoid — negative catalysts, earnings risk, regulatory concerns, analyst downgrades

Reference specific details from the brief in your reason. If earnings are imminent, penalize score.

Respond with ONLY JSON:
{"score":0-100,"verdict":"Buy"|"Hold"|"Avoid","reason":"1-2 sentences, cite specific headline or catalyst"}
No prose, no markdown fences.`;

        const message = await anthropic.messages.create({
          model: RESEARCH_MODEL,
          max_tokens: MAX_TOKENS,
          messages: [{ role: "user", content: prompt }],
        });

        const block = message.content[0];
        const text = block && block.type === "text" ? block.text : "";
        const parsed = JSON.parse(stripJsonFences(text)) as {
          score: number;
          verdict: string;
          reason: string;
        };

        const verdict: ResearchResult["verdict"] =
          parsed.verdict === "Buy" ? "Buy" : parsed.verdict === "Avoid" ? "Avoid" : "Hold";

        const result: ResearchResult = {
          ticker,
          score: Math.max(0, Math.min(100, Math.round(parsed.score ?? 50))),
          verdict,
          reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 400) : "",
          researchedAt: new Date().toISOString(),
        };

        cache.set(cacheKey, result);
        logger.info(
          { ticker, score: result.score, verdict: result.verdict },
          "[stock-research] ticker researched",
        );
      } catch (err) {
        logger.warn({ err, ticker }, "[stock-research] ticker research failed (non-fatal)");
      }
    }
  } finally {
    researchRunning = false;
  }
}
