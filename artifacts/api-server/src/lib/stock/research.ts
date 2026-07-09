// Autonomous Claude research engine (Tier 3 of the scan pipeline).
//
// For each candidate ticker, Claude receives a structured technical snapshot
// (price, MAs, RSI, volume trend, recent news headlines) and — when the API
// supports it — a live web_search tool to pull recent news, analyst ratings,
// earnings surprises, and sector catalysts. Claude classifies the stock's best
// trading horizon (day / swing / long), assigns a 0–100 confidence, lists
// bullish/bearish factors, and writes a 2–3 sentence summary.
//
// Reports are persisted to stock_research_reports (survives restarts) and
// cached in memory per trading day. The bot reads reports for entry decisions;
// the Research UI reads them via /api/stocks/research.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { logger } from "../logger";
import { getScoredNews } from "./news";
import { getEarnings, getLatestEarningsSurprise } from "./earnings";
import type { NewsItem, ResearchHorizon, ResearchReport } from "./types";

const RESEARCH_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8192;
const CONCURRENCY = 2;

// Whether the AI proxy accepts the web_search server tool. Starts optimistic;
// flips to false permanently (per process) on the first 4xx tool rejection so
// we don't burn a failed call per ticker.
let webSearchSupported = true;

let researchRunning = false;
let researchTotal = 0;
let researchDone = 0;

// In-memory day cache keyed `${TICKER}:${YYYY-MM-DD}` for fast bot reads.
const cache = new Map<string, ResearchReport>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface ResearchProgress {
  running: boolean;
  total: number;
  done: number;
}

export function getResearchProgress(): ResearchProgress {
  return { running: researchRunning, total: researchTotal, done: researchDone };
}

/** Today's cached report for a ticker (memory first, no DB hit). */
export function getCachedResearch(ticker: string): ResearchReport | undefined {
  return cache.get(`${ticker.toUpperCase()}:${todayKey()}`);
}

/** All of today's reports currently in memory (bot entry candidates). */
export function getTodayReports(): ResearchReport[] {
  const day = todayKey();
  const out: ResearchReport[] = [];
  for (const [key, rep] of cache.entries()) {
    if (key.endsWith(`:${day}`)) out.push(rep);
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

export function getResearchStatus(): { running: boolean; ready: string[] } {
  const day = todayKey();
  const ready: string[] = [];
  for (const key of cache.keys()) {
    if (key.endsWith(`:${day}`)) ready.push(key.slice(0, -day.length - 1));
  }
  return { running: researchRunning, ready };
}

function rowToReport(r: any): ResearchReport {
  let factors: { bull: string[]; bear: string[] } = { bull: [], bear: [] };
  try {
    const f = typeof r.factors_json === "string" ? JSON.parse(r.factors_json) : r.factors_json;
    if (f && Array.isArray(f.bull) && Array.isArray(f.bear)) factors = f;
  } catch { /* keep empty */ }
  return {
    ticker: r.ticker,
    companyName: r.company_name ?? r.ticker,
    sector: r.sector ?? "Other",
    horizon: (["day", "swing", "long"].includes(r.horizon) ? r.horizon : "swing") as ResearchHorizon,
    confidence: Number(r.confidence) || 0,
    summary: r.summary ?? "",
    bullFactors: factors.bull,
    bearFactors: factors.bear,
    price: r.price != null ? Number(r.price) : null,
    webSearchUsed: !!r.web_search_used,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** Latest report per ticker (one row each), newest first. */
export async function getLatestReports(limit = 100): Promise<ResearchReport[]> {
  const res = (await db.execute(sql`
    SELECT DISTINCT ON (ticker)
      ticker, company_name, sector, horizon, confidence, summary, factors_json,
      price, web_search_used, created_at
    FROM stock_research_reports
    ORDER BY ticker, created_at DESC
  `)) as unknown as { rows: any[] };
  return (res.rows ?? [])
    .map(rowToReport)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/** Full report history for one ticker, newest first. */
export async function getReportsForTicker(ticker: string, limit = 10): Promise<ResearchReport[]> {
  const res = (await db.execute(sql`
    SELECT ticker, company_name, sector, horizon, confidence, summary, factors_json,
           price, web_search_used, created_at
    FROM stock_research_reports
    WHERE ticker = ${ticker.toUpperCase()}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)) as unknown as { rows: any[] };
  return (res.rows ?? []).map(rowToReport);
}

/** Hydrate today's in-memory cache from DB on startup (restart-safe bot reads). */
export async function initResearchFromDB(): Promise<void> {
  try {
    const res = (await db.execute(sql`
      SELECT DISTINCT ON (ticker)
        ticker, company_name, sector, horizon, confidence, summary, factors_json,
        price, web_search_used, created_at
      FROM stock_research_reports
      WHERE created_at >= date_trunc('day', NOW())
      ORDER BY ticker, created_at DESC
    `)) as unknown as { rows: any[] };
    const day = todayKey();
    for (const r of res.rows ?? []) {
      const rep = rowToReport(r);
      cache.set(`${rep.ticker}:${day}`, rep);
    }
    if ((res.rows ?? []).length > 0) {
      logger.info({ count: res.rows.length }, "[stock-research] today's reports restored from DB");
    }
  } catch (err) {
    logger.warn({ err }, "[stock-research] initResearchFromDB failed (non-fatal)");
  }
}

async function persistReport(rep: ResearchReport): Promise<void> {
  await db.execute(sql`
    INSERT INTO stock_research_reports
      (ticker, company_name, sector, horizon, confidence, summary, factors_json,
       price, web_search_used, created_at)
    VALUES
      (${rep.ticker}, ${rep.companyName}, ${rep.sector}, ${rep.horizon}, ${rep.confidence},
       ${rep.summary}, ${JSON.stringify({ bull: rep.bullFactors, bear: rep.bearFactors })}::jsonb,
       ${rep.price}, ${rep.webSearchUsed}, NOW())
  `);
}

function stripJsonFences(text: string): string {
  const fenced = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

/** Pull the last JSON object out of a possibly-prose response. */
function extractJson(text: string): string {
  const cleaned = stripJsonFences(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return cleaned.slice(start, end + 1);
  return cleaned;
}

export interface ResearchTechContext {
  price: number;
  changePct: number;
  rsi: number | null;
  sma21: number | null;
  sma50: number | null;
  sma180: number | null;
  volumeSurge: number | null; // today's volume / prev session volume
  sector: string;
  companyName: string;
}

function buildPrompt(ticker: string, ctx: ResearchTechContext, news: NewsItem[], extra: string[]): string {
  const monthYear = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const maLine = [
    ctx.sma21 != null ? `SMA21 $${ctx.sma21.toFixed(2)}` : null,
    ctx.sma50 != null ? `SMA50 $${ctx.sma50.toFixed(2)}` : null,
    ctx.sma180 != null ? `SMA180 $${ctx.sma180.toFixed(2)}` : null,
  ].filter(Boolean).join(", ") || "MA data unavailable";
  const newsLines = news.slice(0, 5)
    .map((n) => `- [${n.publishedAt?.slice(0, 10) ?? "?"}] "${n.headline}"${n.sentiment ? ` (${n.sentiment})` : ""}`)
    .join("\n") || "- (no recent news on file)";

  return `You are an elite equity research analyst deciding whether ${ticker} (${ctx.companyName}, ${ctx.sector}) is a high-potential LONG opportunity right now, and on what horizon.

TECHNICAL SNAPSHOT:
- Price: $${ctx.price.toFixed(2)} (${ctx.changePct >= 0 ? "+" : ""}${ctx.changePct.toFixed(2)}% today)
- RSI(14): ${ctx.rsi != null ? ctx.rsi.toFixed(0) : "n/a"}
- Moving averages: ${maLine}
- Volume vs prior session: ${ctx.volumeSurge != null ? `${ctx.volumeSurge.toFixed(1)}×` : "n/a"}
${extra.length ? extra.join("\n") + "\n" : ""}
RECENT NEWS ON FILE:
${newsLines}

${webSearchSupported ? `Use web search to check the latest on: "${ticker} stock news analyst rating ${monthYear}" — recent analyst upgrades/downgrades, earnings surprises, and sector catalysts. Limit yourself to at most 2 searches.` : "Base your judgment on the data above only."}

Classify the SINGLE best trading horizon for a long position:
- "day": strong intraday momentum setup (volume surge, catalyst today)
- "swing": 2–10 day setup (trend alignment, upcoming catalyst, analyst momentum)
- "long": multi-week/month accumulation (undervalued vs trend, durable catalysts)

Then respond with ONLY this JSON (no prose before or after):
{"horizon":"day"|"swing"|"long","confidence":0-100,"bullFactors":["3 specific bullish factors"],"bearFactors":["2 specific bearish risks"],"summary":"2-3 sentence thesis citing specifics"}

Confidence rubric: 80+ exceptional conviction, 60-79 solid setup, 40-59 mixed, <40 avoid. Be skeptical — most stocks deserve <60.`;
}

async function researchOne(
  ticker: string,
  ctx: ResearchTechContext,
): Promise<ResearchReport | null> {
  const T = ticker.toUpperCase();

  // Structured extras: EPS surprise + upcoming earnings (best-effort).
  const extra: string[] = [];
  try {
    const [surprise, upcoming] = await Promise.all([
      getLatestEarningsSurprise(T).catch(() => null),
      getEarnings(T, 72).catch(() => undefined),
    ]);
    if (surprise?.surprisePercent != null) {
      extra.push(
        `- Last EPS: ${surprise.surprisePercent > 0 ? "BEAT" : "MISSED"} estimates by ${Math.abs(surprise.surprisePercent).toFixed(1)}% (${surprise.period})`,
      );
    }
    if (upcoming) {
      extra.push(`- Next earnings: ${upcoming.date} (${upcoming.hoursUntil.toFixed(0)}h away)${upcoming.soon ? " — IMMINENT, high risk" : ""}`);
    }
  } catch { /* best-effort */ }

  const news = await getScoredNews(T).catch(() => [] as NewsItem[]);
  const prompt = buildPrompt(T, ctx, news, extra);

  const callClaude = async (useTools: boolean) =>
    anthropic.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
      ...(useTools
        ? { tools: [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 2 }] }
        : {}),
    });

  let message;
  let usedWebSearch = webSearchSupported;
  try {
    message = await callClaude(webSearchSupported);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (webSearchSupported && /tool|web_search|400|invalid/i.test(msg)) {
      logger.warn({ ticker: T }, "[stock-research] web_search tool rejected — disabling for this session");
      webSearchSupported = false;
      usedWebSearch = false;
      message = await callClaude(false);
    } else {
      throw err;
    }
  }

  // Concatenate all text blocks (web-search responses interleave tool blocks).
  const text = message.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
  const parsed = JSON.parse(extractJson(text)) as {
    horizon?: string;
    confidence?: number;
    bullFactors?: unknown;
    bearFactors?: unknown;
    summary?: string;
  };

  const horizon: ResearchHorizon =
    parsed.horizon === "day" ? "day" : parsed.horizon === "long" ? "long" : "swing";
  const toStrings = (v: unknown, max: number): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").map((s) => s.slice(0, 300)).slice(0, max) : [];

  const rep: ResearchReport = {
    ticker: T,
    companyName: ctx.companyName,
    sector: ctx.sector,
    horizon,
    confidence: Math.max(0, Math.min(100, Math.round(parsed.confidence ?? 0))),
    summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 800) : "",
    bullFactors: toStrings(parsed.bullFactors, 4),
    bearFactors: toStrings(parsed.bearFactors, 3),
    price: ctx.price > 0 ? ctx.price : null,
    webSearchUsed: usedWebSearch,
    createdAt: new Date().toISOString(),
  };
  return rep;
}

/**
 * Research a batch of tickers (Tier 3). Skips tickers already researched
 * today. Re-entrant guard prevents overlapping passes. Fire-and-forget safe.
 */
export async function runResearchPass(
  candidates: { ticker: string; ctx: ResearchTechContext }[],
): Promise<void> {
  if (researchRunning) return;
  researchRunning = true;
  const day = todayKey();
  const todo = candidates.filter((c) => !cache.has(`${c.ticker.toUpperCase()}:${day}`));
  researchTotal = todo.length;
  researchDone = 0;
  try {
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const batch = todo.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async ({ ticker, ctx }) => {
          const T = ticker.toUpperCase();
          try {
            const rep = await researchOne(T, ctx);
            if (rep) {
              cache.set(`${T}:${day}`, rep);
              await persistReport(rep).catch((err) =>
                logger.warn({ err, ticker: T }, "[stock-research] persist failed"),
              );
              logger.info(
                { ticker: T, horizon: rep.horizon, confidence: rep.confidence, web: rep.webSearchUsed },
                "[stock-research] report generated",
              );
            }
          } catch (err) {
            logger.warn({ err, ticker: T }, "[stock-research] ticker research failed (non-fatal)");
          } finally {
            researchDone++;
          }
        }),
      );
    }
  } finally {
    researchRunning = false;
  }
}
