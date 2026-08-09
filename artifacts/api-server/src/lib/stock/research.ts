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
import { stockAiPermitted } from "./ai-policy";
import { getConfig } from "./config";
import { isAiFeatureEnabled } from "../ai-spend";
import { logger } from "../logger";
import { getScoredNews } from "./news";
import { getEarnings, getLatestEarningsSurprise } from "./earnings";
import type { NewsItem, ResearchHorizon, ResearchReport, ResearchStance } from "./types";

const RESEARCH_MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048; // JSON response is <500 tokens; web search results are on the input side
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
  let factors: { bull: string[]; bear: string[]; entryPrice?: number | null; targetPrice?: number | null; stopLoss?: number | null } = { bull: [], bear: [] };
  try {
    const f = typeof r.factors_json === "string" ? JSON.parse(r.factors_json) : r.factors_json;
    if (f && Array.isArray(f.bull) && Array.isArray(f.bear)) factors = f;
  } catch { /* keep empty */ }
  const confidence = Number(r.confidence) || 0;
  const toPrice = (v: unknown): number | null => {
    const n = Number(v);
    return v != null && !isNaN(n) && n > 0 ? n : null;
  };
  return {
    ticker: r.ticker,
    companyName: r.company_name ?? r.ticker,
    sector: r.sector ?? "Other",
    horizon: (["day", "swing", "long"].includes(r.horizon) ? r.horizon : "swing") as ResearchHorizon,
    stance: normalizeStance(r.stance, confidence),
    confidence,
    summary: r.summary ?? "",
    bullFactors: factors.bull,
    bearFactors: factors.bear,
    valuation: r.valuation ?? "",
    entryPrice: toPrice(factors.entryPrice),
    targetPrice: toPrice(factors.targetPrice),
    stopLoss: toPrice(factors.stopLoss),
    price: r.price != null ? Number(r.price) : null,
    webSearchUsed: !!r.web_search_used,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/**
 * Normalize a stored/parsed stance. Legacy rows (pre-stance) fall back to a
 * confidence-derived stance so old reports still sort into the right list.
 */
export function normalizeStance(raw: unknown, confidence: number): ResearchStance {
  if (raw === "buy_now" || raw === "buy" || raw === "watch" || raw === "avoid") return raw;
  if (confidence >= 80) return "buy_now";
  if (confidence >= 60) return "buy";
  if (confidence >= 40) return "watch";
  return "avoid";
}

export interface ResearchLists {
  /** Top 20 highest-conviction immediate buys (stance buy_now/buy, confidence-sorted). */
  topBuys: ResearchReport[];
  /** Stocks Claude says to stay away from or sell. */
  avoid: ResearchReport[];
  /** Everything researched, confidence-sorted (the full "best in market" list). */
  all: ResearchReport[];
}

/** Build the actionable lists from the latest report per ticker. */
export async function getResearchLists(): Promise<ResearchLists> {
  const all = await getLatestReports(500);
  const topBuys = all
    .filter((r) => r.stance === "buy_now" || r.stance === "buy")
    .slice(0, 20);
  const avoid = all
    .filter((r) => r.stance === "avoid")
    .sort((a, b) => a.confidence - b.confidence);
  return { topBuys, avoid, all };
}

/** Latest report per ticker (one row each), newest first. */
export async function getLatestReports(limit = 100): Promise<ResearchReport[]> {
  const res = (await db.execute(sql`
    SELECT DISTINCT ON (ticker)
      ticker, company_name, sector, horizon, stance, confidence, summary, factors_json,
      valuation, price, web_search_used, created_at
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
    SELECT ticker, company_name, sector, horizon, stance, confidence, summary, factors_json,
           valuation, price, web_search_used, created_at
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
        ticker, company_name, sector, horizon, stance, confidence, summary, factors_json,
        valuation, price, web_search_used, created_at
      FROM stock_research_reports
      WHERE created_at >= NOW() - INTERVAL '36 hours'
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
      (ticker, company_name, sector, horizon, stance, confidence, summary, factors_json,
       valuation, price, web_search_used, created_at)
    VALUES
      (${rep.ticker}, ${rep.companyName}, ${rep.sector}, ${rep.horizon}, ${rep.stance}, ${rep.confidence},
       ${rep.summary}, ${JSON.stringify({ bull: rep.bullFactors, bear: rep.bearFactors, entryPrice: rep.entryPrice, targetPrice: rep.targetPrice, stopLoss: rep.stopLoss })}::jsonb,
       ${rep.valuation}, ${rep.price}, ${rep.webSearchUsed}, NOW())
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
  // Moving averages
  sma21: number | null;
  sma50: number | null;
  sma180: number | null;
  maAlignment: boolean; // SMA21 > SMA50 (> SMA180 if available)
  // Momentum & oscillators
  rsi: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  macdCrossover: "bullish" | "bearish" | "none";
  // Price structure
  bbPosition: number | null; // 0=at lower band, 1=at upper band
  bbUpper: number | null;
  bbLower: number | null;
  vwap: number | null;
  // Volatility & trend quality
  atrPct: number | null;
  efficiencyRatio: number | null; // 0=chop, 1=clean trend
  netDriftPct: number | null;
  // Volume
  volumeSurge: number | null; // today's vol / prev session
  volumeBias: number | null;  // -1=selling, +1=buying
  // Pattern
  candlePattern: string;
  // Meta
  sector: string;
  companyName: string;
}

function buildPrompt(ticker: string, ctx: ResearchTechContext, news: NewsItem[], extra: string[]): string {
  const monthYear = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // ── Moving averages ───────────────────────────────────────────────────────
  const maLines = [
    ctx.sma21  != null ? `SMA(21)=$${ctx.sma21.toFixed(2)}`  : null,
    ctx.sma50  != null ? `SMA(50)=$${ctx.sma50.toFixed(2)}`  : null,
    ctx.sma180 != null ? `SMA(180)=$${ctx.sma180.toFixed(2)}` : null,
  ].filter(Boolean).join(" | ") || "n/a";
  const maStatus = ctx.maAlignment
    ? "✅ BULLISH — price above all key MAs (21>50>180)"
    : ctx.sma21 != null && ctx.sma50 != null && ctx.sma21 > ctx.sma50
      ? "⚠ MIXED — SMA21>SMA50 but not above SMA180"
      : "❌ BEARISH — MAs not aligned";

  // ── MACD ─────────────────────────────────────────────────────────────────
  const macdStr = ctx.macdLine != null
    ? `MACD=${ctx.macdLine.toFixed(3)} | Signal=${ctx.macdSignal?.toFixed(3) ?? "n/a"} | Hist=${ctx.macdHistogram != null ? (ctx.macdHistogram >= 0 ? "+" : "") + ctx.macdHistogram.toFixed(3) : "n/a"}${ctx.macdCrossover !== "none" ? ` 🔔 ${ctx.macdCrossover.toUpperCase()} CROSSOVER` : ""}`
    : "n/a";

  // ── Bollinger bands ───────────────────────────────────────────────────────
  const bbStr = ctx.bbPosition != null
    ? `Position=${(ctx.bbPosition * 100).toFixed(0)}% within bands${ctx.bbUpper != null ? ` | Upper=$${ctx.bbUpper.toFixed(2)} | Lower=$${ctx.bbLower?.toFixed(2) ?? "n/a"}` : ""} (0%=oversold at lower, 100%=overbought at upper)`
    : "n/a";

  // ── VWAP ─────────────────────────────────────────────────────────────────
  const vwapStr = ctx.vwap != null
    ? `$${ctx.vwap.toFixed(2)} — price is ${ctx.price > ctx.vwap ? `$${(ctx.price - ctx.vwap).toFixed(2)} ABOVE (bullish intraday)` : `$${(ctx.vwap - ctx.price).toFixed(2)} BELOW (bearish intraday)`}`
    : "n/a";

  // ── Volume ────────────────────────────────────────────────────────────────
  const volStr = [
    ctx.volumeSurge != null ? `Day surge: ${ctx.volumeSurge.toFixed(1)}× prior session` : null,
    ctx.volumeBias != null ? `Bias: ${ctx.volumeBias > 0.2 ? "📈 buying pressure" : ctx.volumeBias < -0.2 ? "📉 selling pressure" : "neutral"} (${ctx.volumeBias > 0 ? "+" : ""}${(ctx.volumeBias * 100).toFixed(0)}%)` : null,
  ].filter(Boolean).join(" | ") || "n/a";

  // ── Trend quality ─────────────────────────────────────────────────────────
  const erStr = ctx.efficiencyRatio != null
    ? `${ctx.efficiencyRatio.toFixed(2)} (${ctx.efficiencyRatio >= 0.6 ? "strong trend" : ctx.efficiencyRatio >= 0.3 ? "moderate trend" : "choppy/sideways"})`
    : "n/a";
  const driftStr = ctx.netDriftPct != null
    ? `${ctx.netDriftPct >= 0 ? "+" : ""}${ctx.netDriftPct.toFixed(2)}% over 14 periods`
    : "n/a";
  const atrStr = ctx.atrPct != null
    ? `${ctx.atrPct.toFixed(2)}% daily range (${ctx.atrPct > 3 ? "high vol" : ctx.atrPct > 1.5 ? "moderate vol" : "low vol"})`
    : "n/a";

  // ── Candle pattern ────────────────────────────────────────────────────────
  const patternStr = ctx.candlePattern !== "none" && ctx.candlePattern
    ? `⚡ ${ctx.candlePattern.replace(/_/g, " ").toUpperCase()} detected on latest bar`
    : "No reversal pattern";

  // ── News ──────────────────────────────────────────────────────────────────
  const newsLines = news.slice(0, 7)
    .map((n) => `  • [${n.publishedAt?.slice(0, 10) ?? "?"}] "${n.headline}"${n.sentiment ? ` (${n.sentiment})` : ""}`)
    .join("\n") || "  • (no recent news on file)";

  return `You are an elite equity research analyst and technical trader. Your job: determine whether ${ticker} (${ctx.companyName}, ${ctx.sector}) is worth buying RIGHT NOW for maximum profit, and on what horizon. Real capital follows your call. Be brutally honest — a decisive AVOID is as valuable as a strong buy.

════════════════════════════════════════
FULL TECHNICAL BRIEF — ${ticker}
════════════════════════════════════════

PRICE ACTION
  Current:     $${ctx.price.toFixed(2)}  (${ctx.changePct >= 0 ? "+" : ""}${ctx.changePct.toFixed(2)}% today)

MOVING AVERAGES
  Values:  ${maLines}
  Status:  ${maStatus}

MOMENTUM — RSI & MACD
  RSI(14): ${ctx.rsi != null ? `${ctx.rsi.toFixed(0)} ${ctx.rsi > 70 ? "⚠ OVERBOUGHT" : ctx.rsi < 30 ? "⚠ OVERSOLD" : ctx.rsi > 55 ? "(bullish momentum)" : ctx.rsi < 45 ? "(bearish pressure)" : "(neutral)"}` : "n/a"}
  MACD:    ${macdStr}

PRICE STRUCTURE
  Bollinger: ${bbStr}
  VWAP:      ${vwapStr}

VOLATILITY & TREND QUALITY
  ATR:               ${atrStr}
  Efficiency Ratio:  ${erStr}
  Net Drift:         ${driftStr}

VOLUME
  ${volStr}

CANDLE PATTERN
  ${patternStr}

${extra.length ? "EARNINGS / FUNDAMENTAL CONTEXT\n" + extra.map((e) => "  " + e).join("\n") + "\n" : ""}
RECENT NEWS (${news.length} items on file)
${newsLines}

════════════════════════════════════════
ANALYSIS INSTRUCTIONS
════════════════════════════════════════
${webSearchSupported
  ? `Run exactly 3 targeted web searches:
  1. "${ticker} stock news catalyst analyst ${monthYear}" — any recent upgrade/downgrade, earnings beat, sector tailwind, or breaking catalyst
  2. "${ticker} P/E revenue growth margins valuation ${monthYear}" — fundamentals: is it cheap or expensive vs peers? revenue/EPS trajectory
  3. "${ticker} institutional buying options flow ${monthYear}" — smart money activity, unusual options, insider buys

  Synthesize ALL of the technical data above WITH the live fundamental/catalyst picture.`
  : "Base your judgment only on the technical data above — no live web data available."}

Walk through each indicator systematically:
1. Trend: are MAs aligned? Is price above VWAP?
2. Momentum: RSI zone + MACD crossover direction
3. Structure: Bollinger position — expansion or squeeze?
4. Volume: confirmation (surge + buying bias) or distribution?
5. Quality: Efficiency Ratio — trending or choppy?
6. Catalyst: is there a real fundamental reason driving this, or is it noise?

════════════════════════════════════════
CLASSIFICATION
════════════════════════════════════════
Best trading horizon for a LONG entry:
  "day"   — strong intraday setup: volume catalyst + VWAP reclaim + momentum today
  "swing" — 2-10 day hold: MA alignment + trend quality + near-term catalyst
  "long"  — multi-week accumulation: undervalued, durable catalyst, strong trend

Actionable stance:
  "buy_now" — all signals aligned, exceptional conviction, enter immediately
  "buy"     — solid setup, enter on this horizon
  "watch"   — interesting but needs confirmation or better entry
  "avoid"   — deteriorating technicals, negative catalyst, or overextended

Respond with ONLY this JSON (no prose):
{"horizon":"day"|"swing"|"long","stance":"buy_now"|"buy"|"watch"|"avoid","confidence":0-100,"entryPrice":number|null,"targetPrice":number|null,"stopLoss":number|null,"bullFactors":["3 specific bullish factors citing actual indicator values"],"bearFactors":["2 specific risks"],"valuation":"1-2 sentences: P/E vs peers, revenue growth, balance sheet strength","summary":"3-4 sentence conviction thesis — cite specific indicator readings and the key catalyst"}

Confidence rubric: 85+ = exceptional, all signals aligned; 70-84 = strong, most signals green; 55-69 = solid but mixed; 40-54 = wait for confirmation; <40 = avoid. Be skeptical by default — most stocks are noise. Only "buy_now" when technicals + fundamentals + volume ALL agree.`;
}

/**
 * Unified stock-AI policy check at the API-call boundary. Re-evaluated
 * immediately before EVERY Anthropic invocation so a config/spend change
 * mid-batch stops further calls; returns false (no-call outcome) instead of
 * throwing.
 */
function researchAiPermitted(): boolean {
  return stockAiPermitted(getConfig().aiEnabled, isAiFeatureEnabled("stock_research"));
}

async function researchOne(
  ticker: string,
  ctx: ResearchTechContext,
): Promise<ResearchReport | null> {
  if (!researchAiPermitted()) return null;
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
  if (!researchAiPermitted()) return null; // re-check at the call boundary
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
    stance?: string;
    confidence?: number;
    entryPrice?: number | null;
    targetPrice?: number | null;
    stopLoss?: number | null;
    bullFactors?: unknown;
    bearFactors?: unknown;
    valuation?: string;
    summary?: string;
  };

  const horizon: ResearchHorizon =
    parsed.horizon === "day" ? "day" : parsed.horizon === "long" ? "long" : "swing";
  const toStrings = (v: unknown, max: number): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").map((s) => s.slice(0, 300)).slice(0, max) : [];

  const confidence = Math.max(0, Math.min(100, Math.round(parsed.confidence ?? 0)));
  const toPrice = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : null;
    return n != null && n > 0 ? Math.round(n * 100) / 100 : null;
  };
  const rep: ResearchReport = {
    ticker: T,
    companyName: ctx.companyName,
    sector: ctx.sector,
    horizon,
    stance: normalizeStance(parsed.stance, confidence),
    confidence,
    summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 800) : "",
    bullFactors: toStrings(parsed.bullFactors, 4),
    bearFactors: toStrings(parsed.bearFactors, 3),
    valuation: typeof parsed.valuation === "string" ? parsed.valuation.slice(0, 600) : "",
    entryPrice: toPrice(parsed.entryPrice),
    targetPrice: toPrice(parsed.targetPrice),
    stopLoss: toPrice(parsed.stopLoss),
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

// ── Exit re-check ─────────────────────────────────────────────────────────────

export interface ExitResearchResult {
  shouldExit: boolean;
  /** Updated confidence in the underlying thesis (not in the exit decision). */
  confidence: number;
  reason: string;
  webSearchUsed: boolean;
}

const exitCache = new Map<string, { result: ExitResearchResult; computedAt: number }>();
const EXIT_CACHE_TTL_MS = 4 * 60 * 60_000; // re-check at most every 4 hours

/**
 * Quick targeted Claude call for an open position: "should I exit now?"
 *
 * Designed to be cheap: max_tokens=600, 1 web search max.
 * Cache TTL is 4h unless a news alert forces an immediate re-check.
 */
export async function researchPositionExit(
  ticker: string,
  ctx: {
    price: number;
    entryPrice: number;
    gainPct: number;
    sector: string;
    companyName: string;
    tradingMode: string;
    daysHeld: number;
    originalSummary?: string;
    /** Breaking headline that triggered this re-check, if any. */
    newsAlert?: string;
  },
): Promise<ExitResearchResult | null> {
  const T = ticker.toUpperCase();
  const cacheKey = `exit:${T}:${todayKey()}`;
  const cached = exitCache.get(cacheKey);
  // Skip cache if triggered by a news alert so we always re-check on new info
  if (cached && Date.now() - cached.computedAt < EXIT_CACHE_TTL_MS && !ctx.newsAlert) {
    return cached.result;
  }

  const monthYear = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const gainStr = ctx.gainPct >= 0 ? `+${ctx.gainPct.toFixed(1)}%` : `${ctx.gainPct.toFixed(1)}%`;
  const alertBlock = ctx.newsAlert ? `\n⚠ BREAKING NEWS: "${ctx.newsAlert}"\n` : "";
  const thesisBlock = ctx.originalSummary ? `\nOriginal entry thesis: "${ctx.originalSummary}"\n` : "";

  const prompt = `You are managing an open stock position and must decide whether to EXIT or HOLD RIGHT NOW.

POSITION: ${T} (${ctx.companyName}, ${ctx.sector})
  Entry: $${ctx.entryPrice.toFixed(2)} | Current: $${ctx.price.toFixed(2)} | P&L: ${gainStr}
  Horizon: ${ctx.tradingMode} | Days held: ${ctx.daysHeld}${thesisBlock}${alertBlock}
${webSearchSupported
  ? `Search "${T} stock news ${monthYear}" for any new risks, downgrades, or catalysts that could affect the position.`
  : ""}

Return ONLY this JSON (no prose):
{"shouldExit":true|false,"confidence":0-100,"reason":"1-2 sentences"}

Rules:
- shouldExit=true: thesis broken, major negative catalyst, better capital allocation, news is materially negative
- shouldExit=false: thesis intact, normal volatility, position behaving as expected
- confidence: your current conviction in the STOCK (0=lost all faith, 100=extremely confident)
- Be decisive. Do not say "hold" just because the loss is small — if thesis broke, exit.`;

  const runCall = async (useTools: boolean) =>
    anthropic.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
      ...(useTools
        ? { tools: [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 1 }] }
        : {}),
    });

  if (!researchAiPermitted()) return null; // policy check at the call boundary
  try {
    let message: Awaited<ReturnType<typeof runCall>>;
    let usedWebSearch = webSearchSupported;
    try {
      message = await runCall(webSearchSupported);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (webSearchSupported && /tool|web_search|400|invalid/i.test(msg)) {
        webSearchSupported = false;
        usedWebSearch = false;
        message = await runCall(false);
      } else {
        throw err;
      }
    }

    const text = message.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    const parsed = JSON.parse(extractJson(text)) as {
      shouldExit?: boolean;
      confidence?: number;
      reason?: string;
    };
    const result: ExitResearchResult = {
      shouldExit: !!parsed.shouldExit,
      confidence: Math.max(0, Math.min(100, Math.round(parsed.confidence ?? 50))),
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 400) : "",
      webSearchUsed: usedWebSearch,
    };
    exitCache.set(cacheKey, { result, computedAt: Date.now() });
    logger.info(
      { ticker: T, shouldExit: result.shouldExit, confidence: result.confidence, newsTriggered: !!ctx.newsAlert },
      "[stock-research] exit re-check complete",
    );
    return result;
  } catch (err) {
    logger.warn({ err, ticker: T }, "[stock-research] exit re-check failed — keeping position");
    return null;
  }
}
