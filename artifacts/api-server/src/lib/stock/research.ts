// Claude research pass: evaluates the top-ranked stocks from each scan with a
// structured research brief. The brief is built from:
//   1. Latest reported EPS vs consensus estimate (Finnhub /stock/earnings)
//   2. Analyst rating changes in the past 30 days (Alpaca news, date-filtered)
//   3. M&A / SEC filings (Alpaca news, category-filtered)
//   4. General business news (Alpaca news)
//   5. Sector macro context (live scanner data)
//   6. Upcoming earnings timing (Finnhub calendar, blackout flag)
//
// Results are cached per (ticker, trading-day). Runs asynchronously after each
// scan — fire-and-forget safe.

import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../logger";
import { isGlobalAIKill } from "../global-ai";
import { getScoredNews } from "./news";
import { getEarnings, getLatestEarningsSurprise } from "./earnings";
import { getSectorMomentum } from "./scanner";
import { getNewsInRange, alpacaConfigured } from "./alpaca";
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

// ---------- News categorization ----------

const ANALYST_RE =
  /\b(upgrad|downgrad|buy|sell|neutral|overweight|underweight|price.?target|outperform|underperform|analyst|rating|initiat|reiterat|cover)\b/i;
const MA_SEC_RE =
  /\b(acqui|merger|m&a|buyout|takeover|sec\b|8-k|10-k|10-q|proxy|filing|antitrust|regulatory|fcpa|settlement|lawsuit|litigation)\b/i;
const EARNINGS_RE =
  /\b(earnings|eps|beat|miss|revenue|quarter(ly)?|guidance|profit|loss|net\s+income|adjusted|fiscal|q[1-4]|results?)\b/i;

function filterNews(items: NewsItem[], re: RegExp, max: number): NewsItem[] {
  return items.filter((n) => re.test(`${n.headline} ${n.summary ?? ""}`)).slice(0, max);
}

function formatSection(label: string, items: NewsItem[], max = 3): string {
  const slice = items.slice(0, max);
  if (slice.length === 0) return `${label}: none`;
  const lines = slice.map(
    (n) =>
      `  - [${n.publishedAt ? n.publishedAt.slice(0, 10) : "date unknown"}] "${n.headline}"` +
      (n.sentiment ? ` [${n.sentiment}, impact ${n.magnitude ?? 1}/5]` : ""),
  );
  return `${label}:\n${lines.join("\n")}`;
}

function stripJsonFences(text: string): string {
  const fenced = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

/** ISO date string N days ago: used as Alpaca `start` param. */
function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

// ---------- Main research pass ----------

/**
 * Evaluate up to MAX_TICKERS stocks with Claude research.
 * Skips tickers already evaluated today. Re-entrant guard prevents double runs.
 */
export async function runResearchPass(tickers: string[], opts: { aiPaused?: boolean } = {}): Promise<void> {
  if (opts.aiPaused || isGlobalAIKill()) return;
  if (researchRunning) return;
  researchRunning = true;
  const day = todayKey();
  try {
    const batch = tickers.slice(0, MAX_TICKERS);
    for (const rawTicker of batch) {
      const ticker = rawTicker.toUpperCase();
      const cacheKey = `${ticker}:${day}`;
      if (cache.has(cacheKey)) continue;

      try {
        // ── 1. Parallel data fetch ──────────────────────────────────────────
        const start30 = isoDateDaysAgo(30);
        const [recentNews, analystNews30d, surprise, upcomingEarnings] = await Promise.all([
          getScoredNews(ticker),                                          // scored, cached
          alpacaConfigured()
            ? getNewsInRange([ticker], start30, 20)                      // 30-day window for analyst changes
            : Promise.resolve([] as NewsItem[]),
          getLatestEarningsSurprise(ticker),                             // EPS actual vs estimate
          getEarnings(ticker, 72),                                        // upcoming calendar + blackout
        ]);

        // ── 2. Categorize news ──────────────────────────────────────────────

        // Analyst changes: explicitly date-filtered to 30 days, then regex-matched
        const analystItems = filterNews(analystNews30d, ANALYST_RE, 4);

        // M&A / SEC from scored news (recent, de-duped via cache)
        const maSec = filterNews(recentNews, MA_SEC_RE, 2);

        // Earnings results mentioned in recent news (general headlines)
        const earningsNews = filterNews(recentNews, EARNINGS_RE, 2);

        // General: anything in recentNews not already captured above
        const usedHeadlines = new Set([
          ...analystItems.map((n) => n.headline),
          ...maSec.map((n) => n.headline),
          ...earningsNews.map((n) => n.headline),
        ]);
        const general = recentNews
          .filter((n) => !usedHeadlines.has(n.headline))
          .slice(0, 3);

        // ── 3. Build structured brief ───────────────────────────────────────

        // Section 1: EPS surprise (structured, from Finnhub /stock/earnings)
        let epsSurpriseLine: string;
        if (surprise) {
          const pct = surprise.surprisePercent;
          const direction =
            pct == null
              ? "no surprise data"
              : pct > 0
                ? `BEAT by ${pct.toFixed(1)}%`
                : `MISSED by ${Math.abs(pct).toFixed(1)}%`;
          const actualStr = surprise.actual != null ? `$${surprise.actual.toFixed(2)}` : "N/A";
          const estStr = surprise.estimate != null ? `$${surprise.estimate.toFixed(2)}` : "N/A";
          epsSurpriseLine = `Last reported (${surprise.period}): EPS actual=${actualStr} vs estimate=${estStr} → ${direction}`;
        } else {
          epsSurpriseLine = "Last reported EPS vs estimate: data unavailable (FINNHUB_API_KEY not set or no recent data)";
        }

        // Combine earnings news headlines under the same section
        const earningsSection =
          `EARNINGS RESULTS & EPS SURPRISE:\n  ${epsSurpriseLine}` +
          (earningsNews.length > 0
            ? "\n  Related headlines:\n" +
              earningsNews
                .map((n) => `    - [${n.publishedAt?.slice(0, 10) ?? "?"}] "${n.headline}"`)
                .join("\n")
            : "");

        // Upcoming earnings timing
        const earningsLine = upcomingEarnings
          ? `${upcomingEarnings.date} in ${upcomingEarnings.hoursUntil.toFixed(0)}h${
              upcomingEarnings.soon
                ? " — ⚠️  EARNINGS IMMINENT: high uncertainty, penalize score"
                : ""
            }`
          : "no calendar data";

        // Sector context
        const uni = (await import("./universe")).lookupUniverse(ticker);
        const sectorMom = uni ? getSectorMomentum(uni.sector) : 0;
        const macroLine =
          sectorMom > 0.5
            ? `${uni?.sector ?? "sector"} up +${sectorMom.toFixed(1)}% average today (tailwind)`
            : sectorMom < -0.5
              ? `${uni?.sector ?? "sector"} down ${sectorMom.toFixed(1)}% average today (headwind)`
              : `${uni?.sector ?? "sector"} roughly flat (${sectorMom.toFixed(1)}%)`;

        const brief = [
          earningsSection,
          formatSection(
            "ANALYST RATING CHANGES (past 30 days — upgrades/downgrades/price targets)",
            analystItems,
            4,
          ),
          formatSection("M&A / SEC FILINGS / REGULATORY", maSec, 2),
          formatSection("GENERAL BUSINESS NEWS", general, 3),
          `SECTOR MACRO: ${macroLine}`,
          `UPCOMING EARNINGS: ${earningsLine}`,
        ].join("\n\n");

        // ── 4. Claude evaluation ────────────────────────────────────────────
        const prompt = `You are a senior equity research analyst. Evaluate ${ticker} as a short-term trading opportunity (1-5 day horizon) using this structured research brief.

${brief}

Score this stock 0-100 based on the evidence above:
- 70-100: Strong opportunity — clear positive catalysts, analyst support, favorable sector
- 40-69: Neutral — mixed or limited catalysts, wait-and-see
- 0-39: Avoid — negative catalysts, earnings risk, regulatory concerns, analyst downgrades

Rules:
- If earnings are IMMINENT (⚠️), cap score at 45 regardless of other signals.
- Reference specific details (EPS beat/miss, analyst firm name, M&A target) in your reason.
- Do not generalize — cite what you see in the brief.

Respond with ONLY JSON (no prose, no markdown):
{"score":0-100,"verdict":"Buy"|"Hold"|"Avoid","reason":"1-2 sentences citing specific data points"}`;

        const message = await anthropic.messages.create({
          model: RESEARCH_MODEL,
          max_tokens: MAX_TOKENS,
          messages: [{ role: "user", content: prompt }],
        });

        const block = message.content[0];
        const rawText = block && block.type === "text" ? block.text : "";
        const parsed = JSON.parse(stripJsonFences(rawText)) as {
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
          {
            ticker,
            score: result.score,
            verdict: result.verdict,
            hasSurprise: !!surprise,
            analystCount: analystItems.length,
          },
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
