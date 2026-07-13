// Stock trading bot engine. Runs on a market-hours-gated cycle, independent of
// the crypto/Kalshi bot. Responsibilities:
//   - manage open positions with per-horizon exit rules (day EOD close, swing
//     target/stop, long-term research re-rating + trailing stop, ML outcome)
//   - respect risk limits (daily loss, per-mode & total position caps, PDT,
//     earnings blackout)
//   - open new positions autonomously from Claude research reports (multi-
//     horizon) combined with live technical signals, timed via Level 1 quotes
//   - keep a rolling decision log (last 50 ENTER/EXIT/SKIP decisions with
//     reasoning) surfaced on the bot status endpoint
//
// The DB (stock_bot_bets) is the source of truth for positions so the bot is
// fully restart-safe. Nothing here imports from crypto.ts / kalshi-bot.ts.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import {
  alpacaConfigured,
  getClock,
  getAccount,
  getLatestPrice,
  getLevel1Quote,
  getOrderBook,
  placeOrder,
  closePosition,
} from "./alpaca";
import { getConfig, saveConfig } from "./config";
import { selectEntryMode, heldKey } from "./bot-entry-core";
import { getCandles } from "./data";
import { buildSignals } from "./ai";
import { buildFeatures, recordOutcome } from "./ml";
import { getScoredNews } from "./news";
import { getEarnings } from "./earnings";
import { getScannerResults, getSectorMomentum } from "./scanner";
import { getCachedResearch, getTodayReports, researchPositionExit } from "./research";
import { lookupUniverse } from "./universe";
import { watchlistTickers } from "./watchlist";
import { getMacroTrend } from "./macro-filter";
import { consumeNewsAlert, registerPositionTicker, unregisterPositionTicker } from "./news-monitor";
import type { Candle, TradingMode, StockBotConfig, ResearchReport, ScannerRow } from "./types";
import { DAY_EOD_BUFFER_MS, evaluateExitReason } from "./bot-manage-core";

let running = false;
let lastCycleAt = 0;
let lastCycleSummary = "";

// ── Per-horizon exit rules (Task spec) ──────────────────────────────────────
const LONG_ENTRY_MIN_CONF = 75;           // research confidence gate for long entries

// ── Level 1 entry-timing gate ───────────────────────────────────────────────
const MAX_ENTRY_SPREAD_PCT = 0.3;
const MIN_ENTRY_IMBALANCE = 1.2;

// ── Rolling decision log (last 50 in-memory, persisted to stock_bot_decisions)
export interface BotDecision {
  ts: number;
  ticker: string;
  action: "ENTER" | "EXIT" | "SKIP";
  horizon: TradingMode | null;
  confidence: number | null;
  reason: string;
  /** Claude research summary — populated for ENTER decisions in current session. */
  claudeReasoning?: string | null;
}

const DECISION_LOG_MAX = 50;
const DECISION_RETENTION_DAYS = 7;
const DECISION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // prune at most every 6h

const decisionLog: BotDecision[] = [];
let lastDecisionCleanupAt = 0;

function recordDecision(d: Omit<BotDecision, "ts">): void {
  const decision: BotDecision = { ts: Date.now(), ...d };
  decisionLog.unshift(decision);
  if (decisionLog.length > DECISION_LOG_MAX) decisionLog.length = DECISION_LOG_MAX;

  // Persist asynchronously so a slow/unavailable DB never blocks the bot cycle.
  // For ENTER decisions, we embed claudeReasoning into the reason field using a
  // delimiter so it survives restarts without a schema change.
  const persistedReason = decision.claudeReasoning
    ? `${decision.reason}|||${decision.claudeReasoning}`
    : decision.reason;
  db.execute(sql`
    INSERT INTO stock_bot_decisions (ticker, action, horizon, confidence, reason, ts)
    VALUES (${decision.ticker}, ${decision.action}, ${decision.horizon},
            ${decision.confidence}, ${persistedReason}, to_timestamp(${decision.ts / 1000}))
  `).catch((err) => logger.warn({ err }, "[stock-bot] decision persist failed"));

  // Opportunistic retention cleanup, throttled so it doesn't run every insert.
  const now = Date.now();
  if (now - lastDecisionCleanupAt >= DECISION_CLEANUP_INTERVAL_MS) {
    lastDecisionCleanupAt = now;
    cleanupOldDecisions();
  }
}

function cleanupOldDecisions(): void {
  db.execute(sql`
    DELETE FROM stock_bot_decisions
    WHERE ts < NOW() - make_interval(days => ${DECISION_RETENTION_DAYS})
  `).catch((err) => logger.warn({ err }, "[stock-bot] decision cleanup failed"));
}

/** Hydrate the in-memory decision feed from the DB after a restart. */
export async function initDecisionLogFromDB(): Promise<void> {
  const res = (await db.execute(sql`
    SELECT ticker, action, horizon, confidence, reason, ts
    FROM stock_bot_decisions
    WHERE ts >= NOW() - make_interval(days => ${DECISION_RETENTION_DAYS})
    ORDER BY ts DESC
    LIMIT ${DECISION_LOG_MAX}
  `)) as unknown as { rows: any[] };
  const rows = res.rows ?? [];
  decisionLog.length = 0;
  for (const r of rows) {
    const rawReason = String(r.reason ?? "");
    const delimIdx = rawReason.indexOf("|||");
    const reason = delimIdx >= 0 ? rawReason.slice(0, delimIdx) : rawReason;
    const claudeReasoning = delimIdx >= 0 ? rawReason.slice(delimIdx + 3) : undefined;
    decisionLog.push({
      ts: new Date(r.ts).getTime(),
      ticker: String(r.ticker),
      action: r.action as BotDecision["action"],
      horizon: (r.horizon ?? null) as TradingMode | null,
      confidence: r.confidence != null ? Number(r.confidence) : null,
      reason,
      claudeReasoning,
    });
  }
  lastDecisionCleanupAt = Date.now();
  cleanupOldDecisions();
  logger.info({ count: decisionLog.length }, "[stock-bot] decision log hydrated from DB");
}

export function getDecisionLog(): BotDecision[] {
  return [...decisionLog];
}

interface OpenBetRow {
  id: string;
  ticker: string;
  sector: string | null;
  tradingMode: TradingMode;
  /** "long" = long position (buy to open); "short" = short position (sell to open). */
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  stopLoss: number | null;
  targetPrice: number | null;
  peakPrice: number | null;
  notional: number;
  confidence: number;
  signals: any;
  createdAt: Date;
}


async function openBets(mode: "paper" | "live"): Promise<OpenBetRow[]> {
  const res = (await db.execute(sql`
    SELECT id, ticker, sector, trading_mode, side, qty, entry_price, stop_loss, target_price,
           peak_price, notional, confidence, signals, created_at
    FROM stock_bot_bets
    WHERE action IN ('buy', 'short_sell') AND exited_at IS NULL AND mode = ${mode}
  `)) as unknown as { rows: any[] };
  return (res.rows ?? []).map((r) => ({
    id: r.id,
    ticker: r.ticker,
    sector: r.sector,
    tradingMode: r.trading_mode as TradingMode,
    side: (r.side === "short" ? "short" : "long") as "long" | "short",
    qty: Number(r.qty) || 0,
    entryPrice: Number(r.entry_price) || 0,
    stopLoss: r.stop_loss != null ? Number(r.stop_loss) : null,
    targetPrice: r.target_price != null ? Number(r.target_price) : null,
    peakPrice: r.peak_price != null ? Number(r.peak_price) : null,
    notional: Number(r.notional) || 0,
    confidence: Number(r.confidence) || 0,
    signals: r.signals ?? {},
    createdAt: new Date(r.created_at),
  }));
}

async function todayRealizedPnl(mode: "paper" | "live"): Promise<number> {
  const res = (await db.execute(sql`
    SELECT COALESCE(SUM(pnl), 0) AS pnl
    FROM stock_bot_bets
    WHERE mode = ${mode} AND exited_at IS NOT NULL
      AND exited_at >= date_trunc('day', NOW())
  `)) as unknown as { rows: any[] };
  return Number(res.rows?.[0]?.pnl) || 0;
}

async function exitPosition(
  bet: OpenBetRow,
  mode: "paper" | "live",
  exitPrice: number,
  reason: string,
): Promise<void> {
  // Broker close must succeed (or confirm already-flat via 404) before we mark
  // the DB row exited. If it fails we leave the row open so the next cycle
  // retries — the DB must never say flat while the broker still holds risk.
  try {
    await closePosition(mode, bet.ticker);
  } catch (err) {
    logger.warn(
      { err, ticker: bet.ticker },
      "[stock-bot] closePosition failed — keeping position open for retry",
    );
    throw err;
  }
  // Short P&L is inverted: profit when price drops below entry.
  const pnl = bet.side === "short"
    ? (bet.entryPrice - exitPrice) * bet.qty
    : (exitPrice - bet.entryPrice) * bet.qty;
  const outcome = pnl > 0 ? "win" : pnl < 0 ? "loss" : "push";
  unregisterPositionTicker(bet.ticker);
  await db.execute(sql`
    UPDATE stock_bot_bets SET
      exit_price = ${exitPrice},
      pnl = ${pnl},
      outcome = ${outcome},
      exit_reason = ${reason},
      exited_at = NOW(),
      evaluated_at = NOW()
    WHERE id = ${bet.id}
  `);
  // Feed the ML model: label = did price rise from entry?
  const features: number[] | undefined = bet.signals?.features;
  if (Array.isArray(features)) {
    const label = exitPrice >= bet.entryPrice ? 1 : 0;
    await recordOutcome(bet.ticker, bet.id, features, label);
  }
  recordDecision({
    ticker: bet.ticker,
    action: "EXIT",
    horizon: bet.tradingMode,
    confidence: bet.confidence,
    reason: `${reason} @ $${exitPrice.toFixed(2)} (P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})`,
  });
  logger.info({ ticker: bet.ticker, pnl: pnl.toFixed(2), reason }, "[stock-bot] exited position");
}

/**
 * Manually close a single open position on demand (from the dashboard).
 *
 * Uses the same broker-confirm-then-record flow as the automatic exit so the
 * DB is never marked flat while the broker still holds risk. Reason is recorded
 * as "manual" so it is distinguishable from bot-driven exits in the history.
 */
export async function manualClosePosition(
  ticker: string,
): Promise<{ closed: boolean; ticker: string; qty: number; exitPrice: number; pnl: number }> {
  if (!alpacaConfigured()) throw new Error("Alpaca is not configured");
  const cfg = getConfig();
  const sym = ticker.trim().toUpperCase();
  const open = await openBets(cfg.mode);
  const bet = open.find((b) => b.ticker.toUpperCase() === sym);
  if (!bet) throw new Error(`No open ${cfg.mode} position for ${sym}`);

  // Best-effort live price for P&L; fall back to entry if the quote is missing
  // so the close still proceeds (the broker sells at market regardless).
  let price = await getLatestPrice(bet.ticker);
  if (price == null || price <= 0) price = bet.entryPrice;

  await exitPosition(bet, cfg.mode, price, "manual");
  const pnl = bet.side === "short"
    ? (bet.entryPrice - price) * bet.qty
    : (price - bet.entryPrice) * bet.qty;
  return { closed: true, ticker: bet.ticker, qty: bet.qty, exitPrice: price, pnl };
}

/**
 * Poll Alpaca news for all currently-open positions.
 * Called on a 5-min interval by the stock vertical — the results are consumed
 * per-tick inside managePositions via consumeNewsAlert().
 */
export async function runStockNewsCheck(): Promise<void> {
  const cfg = getConfig();
  const open = await openBets(cfg.mode);
  if (open.length === 0) return;
  const { checkNewsForPositions } = await import("./news-monitor");
  await checkNewsForPositions(open.map((b) => b.ticker));
}

/** Persist the running peak price used by the long-horizon trailing stop. */
async function updatePeak(betId: string, peak: number): Promise<void> {
  await db.execute(sql`
    UPDATE stock_bot_bets SET peak_price = ${peak} WHERE id = ${betId}
  `).catch((err) => logger.warn({ err, betId }, "[stock-bot] peak update failed"));
}

async function managePositions(
  cfg: StockBotConfig,
  marketOpen: boolean,
  nextCloseMs: number | null,
): Promise<number> {
  let exits = 0;
  const open = await openBets(cfg.mode);
  const nearClose =
    marketOpen && nextCloseMs != null && nextCloseMs - Date.now() <= DAY_EOD_BUFFER_MS;

  for (const bet of open) {
    const price = await getLatestPrice(bet.ticker);
    if (price == null || price <= 0) continue;

    // Check for breaking news alert on this position
    const newsAlert = consumeNewsAlert(bet.ticker);

    // Research for exit gate: cached report OR a fresh Claude exit re-check
    // triggered by: (a) breaking news alert, or (b) swing/long held overnight
    let research = bet.tradingMode !== "day" ? getCachedResearch(bet.ticker) ?? null : null;

    if (marketOpen && bet.tradingMode !== "day" && (newsAlert || bet.tradingMode === "swing" || bet.tradingMode === "long")) {
      const daysHeld = Math.floor((Date.now() - bet.createdAt.getTime()) / 86_400_000);
      const gainPct = bet.entryPrice > 0
        ? (bet.side === "short"
            ? (bet.entryPrice - price) / bet.entryPrice
            : (price - bet.entryPrice) / bet.entryPrice) * 100
        : 0;
      const uni = lookupUniverse(bet.ticker);
      const exitCheck = await researchPositionExit(bet.ticker, {
        price,
        entryPrice: bet.entryPrice,
        gainPct,
        sector: bet.sector ?? uni?.sector ?? "Other",
        companyName: uni?.name ?? bet.ticker,
        tradingMode: bet.tradingMode,
        daysHeld,
        originalSummary: (bet.signals as any)?.research?.summary,
        newsAlert: newsAlert?.headline,
      }).catch(() => null);

      if (exitCheck?.shouldExit) {
        const exitReason = newsAlert
          ? `claude_exit_news (${newsAlert.headline.slice(0, 80)})`
          : `claude_exit_recheck (conf ${exitCheck.confidence})`;
        if (marketOpen) {
          try {
            await exitPosition(bet, cfg.mode, price, exitReason);
            exits++;
            continue;
          } catch (err) {
            logger.warn({ err, ticker: bet.ticker }, "[stock-bot] Claude-triggered exit failed; will retry");
          }
        }
        continue;
      }
      // Update the research confidence from Claude's re-check for the rule-based exit below
      if (exitCheck && research) {
        research = { ...research, confidence: exitCheck.confidence };
      }
    }

    const { reason, newPeak } = evaluateExitReason({
      bet,
      price,
      cfg,
      marketOpen,
      nearClose,
      nowMs: Date.now(),
      research,
    });

    if (newPeak != null) await updatePeak(bet.id, newPeak);

    if (reason) {
      // Exits require an open market (except forced EOD which we still attempt).
      if (!marketOpen && reason !== "eod_close") continue;
      try {
        await exitPosition(bet, cfg.mode, price, reason);
        exits++;
      } catch (err) {
        // Broker close failed — position stays open and is retried next cycle.
        logger.warn({ err, ticker: bet.ticker }, "[stock-bot] exit failed; will retry");
      }
    }
  }
  return exits;
}

// ── Entry candidates: research reports first, then scanner/watchlist ────────

interface EntryCandidate {
  ticker: string;
  /** Horizon dictated by research; null = flexible (watchlist/scanner). */
  horizon: TradingMode | null;
  report: ResearchReport | null;
  /** "long" (default) = buy to open; "short" = sell to open. */
  side?: "long" | "short";
}

async function entryCandidates(cfg: StockBotConfig): Promise<{
  candidates: EntryCandidate[];
  scannerByTicker: Map<string, ScannerRow>;
}> {
  const [scanner, watch] = await Promise.all([getScannerResults(), watchlistTickers()]);
  const scannerByTicker = new Map(scanner.map((r) => [r.ticker, r]));

  const seen = new Set<string>();
  const candidates: EntryCandidate[] = [];

  // 1. Today's research reports, highest confidence first.
  for (const rep of getTodayReports()) {
    if (seen.has(rep.ticker)) continue;
    seen.add(rep.ticker);
    candidates.push({ ticker: rep.ticker, horizon: rep.horizon, report: rep });
  }

  // 2. Watchlist tickers (flexible horizon), always eligible.
  for (const t of watch) {
    if (seen.has(t)) continue;
    seen.add(t);
    candidates.push({ ticker: t, horizon: null, report: getCachedResearch(t) ?? null });
  }

  // 3. Top scanner rows (upward direction) as a fallback long pool.
  const ranked = scanner
    .filter((r) => r.direction === "up")
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  for (const r of ranked) {
    if (seen.has(r.ticker)) continue;
    seen.add(r.ticker);
    candidates.push({ ticker: r.ticker, horizon: null, report: null, side: "long" });
  }

  // 4. Top downward-trending tickers as short candidates (research-avoid flagged).
  // Short candidates: scanner rows with direction="down" + research stance="avoid".
  const shortCandidates = scanner
    .filter((r) => r.direction === "down")
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  for (const r of shortCandidates) {
    const shortKey = `short:${r.ticker}`;
    if (seen.has(shortKey)) continue;
    const report = getCachedResearch(r.ticker) ?? null;
    // Only short when Claude explicitly says avoid (confirmed bearish thesis)
    if (!report || report.stance !== "avoid") continue;
    seen.add(shortKey);
    candidates.push({ ticker: r.ticker, horizon: r.direction === "down" ? "swing" : null, report, side: "short" });
  }

  return { candidates, scannerByTicker };
}

/** Is it currently within the first hour of the regular session (ET)? */
function inFirstHourET(now = new Date()): boolean {
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(et.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(et.find((p) => p.type === "minute")?.value ?? 0);
  const mins = hour * 60 + minute;
  return mins >= 9 * 60 + 30 && mins < 10 * 60 + 30;
}

/**
 * Horizon-specific entry criteria (task spec):
 *  - day:   first hour of the session, RSI momentum (55–75) + volume surge
 *  - swing: MA alignment + positive research (conf ≥ 60)
 *  - long:  research confidence ≥ 75 + RSI not overheated (< 60)
 * Returns null when eligible, else the skip reason.
 */
function horizonGate(
  horizon: TradingMode,
  report: ResearchReport | null,
  row: ScannerRow | undefined,
): string | null {
  const d = (row?.details ?? {}) as Record<string, any>;
  const rsi = typeof d.rsi === "number" ? d.rsi : null;
  const volumeSurge = typeof d.volumeSurge === "number" ? d.volumeSurge : null;
  const maAlignment = d.maAlignment === true;

  if (horizon === "day") {
    if (!inFirstHourET()) return "day entries only in first hour";
    if (rsi == null || rsi < 55 || rsi > 75) return `RSI ${rsi ?? "n/a"} outside 55-75 momentum band`;
    if (volumeSurge == null) return "volume surge unavailable";
    if (volumeSurge < 1.2) return `volume surge ${volumeSurge.toFixed(1)}× too weak`;
    return null;
  }
  if (horizon === "swing") {
    if (!maAlignment) return "MA alignment not bullish";
    if (!report) return "no research report";
    if (report.confidence < 60) return `research conf ${report.confidence} < 60`;
    return null;
  }
  // long
  if (!report || report.confidence < LONG_ENTRY_MIN_CONF) {
    return `research conf ${report?.confidence ?? "none"} < ${LONG_ENTRY_MIN_CONF}`;
  }
  if (rsi != null && rsi >= 60) return `RSI ${rsi} overheated for accumulation`;
  return null;
}

async function tryEntries(cfg: StockBotConfig): Promise<number> {
  let entries = 0;
  const account = await getAccount(cfg.mode);

  // PDT guard: if flagged and low equity, block new day trades.
  const pdtBlocked = account.patternDayTrader && account.equity < 25000;

  // ── Macro market filter ─────────────────────────────────────────────────
  // Block new LONG entries when SPY is in a confirmed intraday downtrend.
  // Short entries are unaffected (shorts profit in a down market).
  const macro = await getMacroTrend().catch(() => null);
  const macroBlocksLongs = macro?.trend === "bearish";
  if (macroBlocksLongs) {
    logger.info(
      { spy: macro?.spyPrice, changePct: macro?.spyChangePct, aboveVwap: macro?.aboveVwap },
      "[stock-bot] macro bearish — blocking new long entries this cycle",
    );
  }

  const open = await openBets(cfg.mode);
  // Held guard is per (ticker, horizon): the same ticker may hold concurrent
  // day/swing/long positions, but never two positions in the same horizon.
  const held = new Set(open.map((b) => heldKey(b.ticker, b.tradingMode)));
  const modeCounts: Record<TradingMode, number> = { day: 0, swing: 0, long: 0 };
  for (const b of open) modeCounts[b.tradingMode] = (modeCounts[b.tradingMode] ?? 0) + 1;
  const capFor = (m: TradingMode) =>
    m === "day" ? cfg.maxDayPositions : m === "swing" ? cfg.maxSwingPositions : cfg.maxLongPositions;

  if (open.length >= cfg.maxConcurrentPositions) return 0;

  // Track sector exposures added in this cycle so that intra-cycle multi-entry
  // concentration is accounted for (open was captured before the loop).
  const cycleSectorNotional = new Map<string, number>();
  let cycleTotalNotional = 0;

  const { candidates: allCandidates, scannerByTicker } = await entryCandidates(cfg);

  // Sector focus filter: if sectorFocus is non-empty, only consider tickers in
  // those sectors. Watchlist tickers are always eligible regardless of sector.
  const watchSet = new Set(await watchlistTickers());
  const activeSectors = cfg.sectorFocus ?? [];
  const candidates =
    activeSectors.length === 0
      ? allCandidates
      : allCandidates.filter((c) => {
          if (watchSet.has(c.ticker)) return true; // watchlist bypass
          const sector =
            c.report?.sector ?? scannerByTicker.get(c.ticker)?.sector ?? lookupUniverse(c.ticker)?.sector ?? "";
          return activeSectors.includes(sector);
        });

  for (const cand of candidates) {
    if (open.length + entries >= cfg.maxConcurrentPositions) break;
    const ticker = cand.ticker;

    const candidateSide: "long" | "short" = cand.side ?? "long";

    // Macro filter: block new long entries when SPY trend is bearish.
    // Short entries are allowed — shorts benefit from a down market.
    if (candidateSide === "long" && macroBlocksLongs) {
      recordDecision({
        ticker, action: "SKIP", horizon: cand.horizon,
        confidence: cand.report?.confidence ?? null,
        reason: `macro bearish (SPY ${macro?.spyChangePct?.toFixed(2)}%) — long entries blocked`,
      });
      continue;
    }

    // Claude stance gate:
    //   Long entries: never enter when Claude says "avoid".
    //   Short entries: only enter when Claude says "avoid" (confirmed bearish thesis).
    if (candidateSide === "long" && cand.report?.stance === "avoid") {
      recordDecision({
        ticker, action: "SKIP", horizon: cand.horizon,
        confidence: cand.report.confidence,
        reason: "Claude research stance: avoid (stay away/sell)",
      });
      continue;
    }
    if (candidateSide === "short") {
      if (!cand.report || cand.report.stance !== "avoid") {
        // Shorts require explicit Claude bearish confirmation
        recordDecision({
          ticker, action: "SKIP", horizon: cand.horizon,
          confidence: cand.report?.confidence ?? null,
          reason: "short candidate skipped — Claude stance not 'avoid'",
        });
        continue;
      }
    }

    // Resolve which horizon this entry would use. Research-driven candidates
    // use their recommended horizon; flexible candidates take the first active
    // mode with capacity (day → swing → long preference). A horizon already
    // held for this ticker is skipped, but other horizons remain eligible.
    const { mode, allHeld } = selectEntryMode({
      ticker,
      horizon: cand.horizon,
      held,
      modeCounts,
      caps: { day: cfg.maxDayPositions, swing: cfg.maxSwingPositions, long: cfg.maxLongPositions },
      activeModes: cfg.tradingModes,
      pdtBlocked,
    });
    if (!mode) {
      if (cand.report && !allHeld) {
        recordDecision({
          ticker, action: "SKIP", horizon: cand.horizon,
          confidence: cand.report.confidence,
          reason: cand.horizon ? `${cand.horizon} capacity full or mode inactive` : "no horizon capacity",
        });
      }
      continue;
    }

    const row = scannerByTicker.get(ticker);
    const gateFail = horizonGate(mode, cand.report, row);
    if (gateFail) {
      if (cand.report) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode,
          confidence: cand.report.confidence, reason: gateFail,
        });
      }
      continue;
    }

    try {
      const candles: Candle[] = await getCandles(ticker, mode);
      if (candles.length < 25) continue;

      const uni = lookupUniverse(ticker);
      const sector = cand.report?.sector ?? row?.sector ?? uni?.sector ?? "Other";
      const news = await getScoredNews(ticker);
      const earnings = await getEarnings(ticker, cfg.earningsBlackoutHours);

      if (cfg.earningsBlackout && earnings?.soon) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode,
          confidence: cand.report?.confidence ?? null, reason: "earnings blackout",
        });
        continue;
      }

      const signals = await buildSignals(
        ticker,
        candles,
        news,
        earnings,
        getSectorMomentum(sector),
        { useClaude: false },
      );

      // Direction gate: longs require bullish technicals; shorts require bearish.
      const requiredDir = candidateSide === "short" ? "down" : "up";
      if (signals.combinedDirection !== requiredDir) {
        if (cand.report) {
          recordDecision({
            ticker, action: "SKIP", horizon: mode,
            confidence: cand.report.confidence,
            reason: candidateSide === "short"
              ? "technical signals not bearish (short requires 'down')"
              : "technical signals not bullish",
          });
        }
        continue;
      }

      // Research signal: ±5pp confidence based on today's Claude research.
      let effectiveConfidence = signals.combinedConfidence;
      const research = cand.report ?? getCachedResearch(ticker);
      if (research) {
        if (research.confidence >= 70) {
          effectiveConfidence = Math.min(95, effectiveConfidence + 5);
        } else if (research.confidence <= 30) {
          effectiveConfidence = Math.max(50, effectiveConfidence - 5);
        }
      }

      if (effectiveConfidence < cfg.minConfidence) {
        if (cand.report) {
          recordDecision({
            ticker, action: "SKIP", horizon: mode,
            confidence: effectiveConfidence,
            reason: `confidence ${effectiveConfidence} < min ${cfg.minConfidence}`,
          });
        }
        continue;
      }

      const price = signals.price;
      if (price <= 0) continue;

      // Minimum market cap filter.
      // The S&P 500 stocks in STOCK_UNIVERSE are all large-caps (>$15B market cap)
      // and always pass this filter. For user-added watchlist tickers, market cap
      // data is unavailable from Alpaca's standard API, so when the filter is
      // enabled we fail-closed — blocking unknown-cap tickers rather than letting
      // potential micro-caps through.
      if (cfg.minMarketCapBillion > 0) {
        const inUniverse = lookupUniverse(ticker) !== null;
        if (!inUniverse) {
          recordDecision({
            ticker, action: "SKIP", horizon: mode, confidence: null,
            reason: `market cap unverifiable for non-universe ticker (filter: >$${cfg.minMarketCapBillion}B)`,
          });
          continue;
        }
        // Universe stocks are S&P 500 large-caps (>$15B) and always satisfy any
        // supported threshold (1B / 5B / 10B). No additional check needed.
      }

      // Level 1 entry timing gate (fail-closed): tight spread + buy-side
      // dominant book are both required — missing quote data blocks entry.
      const quote = await getLevel1Quote(ticker);
      if (!quote || quote.spreadPct == null || quote.imbalance == null) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
          reason: "Level 1 quote unavailable — entry timing cannot be verified",
        });
        continue;
      }
      if (quote.spreadPct > MAX_ENTRY_SPREAD_PCT) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
          reason: `spread ${quote.spreadPct.toFixed(2)}% > ${MAX_ENTRY_SPREAD_PCT}%`,
        });
        continue;
      }
      if (quote.imbalance < MIN_ENTRY_IMBALANCE) {
        recordDecision({
          ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
          reason: `book imbalance ${quote.imbalance.toFixed(2)} < ${MIN_ENTRY_IMBALANCE} (sell-side dominant)`,
        });
        continue;
      }

      // Level 2 orderbook gate (soft — skip on bad depth, don't fail-close on missing data).
      // Longs: skip when sell-side depth dominates (depthImbalance < 0.8 means big ask wall).
      // Shorts: skip when buy-side depth dominates (depthImbalance > 1.2 means strong buyer support).
      const MIN_DEPTH_IMBALANCE_LONG = 0.8;
      const MAX_DEPTH_IMBALANCE_SHORT = 1.2;
      try {
        const ob = await getOrderBook(ticker);
        if (ob) {
          if (ob.depthImbalance != null && candidateSide === "long" && ob.depthImbalance < MIN_DEPTH_IMBALANCE_LONG) {
            recordDecision({
              ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
              reason: `L2 depth imbalance ${ob.depthImbalance.toFixed(2)} < ${MIN_DEPTH_IMBALANCE_LONG} (ask wall — bad long)`,
            });
            continue;
          }
          if (ob.depthImbalance != null && candidateSide === "short" && ob.depthImbalance > MAX_DEPTH_IMBALANCE_SHORT) {
            recordDecision({
              ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
              reason: `L2 depth imbalance ${ob.depthImbalance.toFixed(2)} > ${MAX_DEPTH_IMBALANCE_SHORT} (buyer support — bad short)`,
            });
            continue;
          }
        }
      } catch {
        // Orderbook unavailable — proceed without L2 gate (soft fail-open)
      }

      // Dynamic sizing: linearly interpolate from base position size at minConfidence
      // to the max dollar cap at 80%+ confidence. This maps confidence directly to
      // min→max dollar sizing. When maxPositionDollars is unset, the ceiling is 1.5×
      // the base notional.
      const baseNotional = Math.max(1, (account.equity * cfg.positionSizePct) / 100);
      let notional: number;
      if (cfg.dynamicSizing) {
        const minConf = cfg.minConfidence;
        const maxConf = 80;
        const t = Math.min(1, Math.max(0, (effectiveConfidence - minConf) / Math.max(1, maxConf - minConf)));
        const maxNotional = cfg.maxPositionDollars ?? baseNotional * 1.5;
        notional = baseNotional + t * (Math.max(maxNotional, baseNotional) - baseNotional);
      } else {
        notional = cfg.maxPositionDollars != null ? Math.min(baseNotional, cfg.maxPositionDollars) : baseNotional;
      }
      const qty = Math.floor(notional / price);
      if (qty < 1) continue;

      // Sector concentration cap.
      // We use the combined deployed capital (pre-existing open bets + entries
      // already made this cycle) as the effective portfolio basis. When that basis
      // is zero (empty portfolio, first entry of the cycle), we skip the check —
      // a single first position cannot be "over-concentrated" relative to an empty
      // book, and the cap is only meaningful once there is a portfolio to diversify.
      if (cfg.maxSectorPct > 0 && sector) {
        const proposedNotional = qty * price;
        const existingTotal = open.reduce((s, b) => s + b.notional, 0);
        const effectiveTotal = existingTotal + cycleTotalNotional;
        if (effectiveTotal > 0) {
          const existingSector = open.filter(b => b.sector === sector).reduce((s, b) => s + b.notional, 0);
          const cycleSector = cycleSectorNotional.get(sector) ?? 0;
          const projectedTotal = effectiveTotal + proposedNotional;
          const projectedSectorPct = ((existingSector + cycleSector + proposedNotional) / projectedTotal) * 100;
          if (projectedSectorPct > cfg.maxSectorPct) {
            recordDecision({
              ticker, action: "SKIP", horizon: mode, confidence: effectiveConfidence,
              reason: `sector ${sector} would reach ${projectedSectorPct.toFixed(0)}% > cap ${cfg.maxSectorPct}%`,
            });
            continue;
          }
        }
      }

      // Per-mode stop/target (fall back to global if not set).
      // Shorts flip the direction: stop is ABOVE entry, target is BELOW entry.
      const stopPct = mode === "day" ? (cfg.dayStopLossPct ?? cfg.stopLossPct)
        : mode === "swing" ? (cfg.swingStopLossPct ?? cfg.stopLossPct)
        : (cfg.longStopLossPct ?? cfg.stopLossPct);
      const targetPct = mode === "day" ? (cfg.dayTargetGainPct ?? cfg.targetGainPct)
        : mode === "swing" ? (cfg.swingTargetGainPct ?? cfg.targetGainPct)
        : (cfg.longTargetGainPct ?? cfg.targetGainPct);
      const stopLoss = candidateSide === "short"
        ? price * (1 + stopPct / 100)   // short stop: above entry
        : price * (1 - stopPct / 100);  // long stop: below entry
      const targetPrice = candidateSide === "short"
        ? price * (1 - targetPct / 100) // short target: below entry
        : price * (1 + targetPct / 100); // long target: above entry
      const features = buildFeatures(candles, news, earnings, getSectorMomentum(sector));

      // Limit orders: for longs we bid 1 cent above ask (crosses the spread to fill
      // quickly while protecting against stale quotes); for shorts we offer 1 cent
      // below bid. Both use GTC for swing/long so they survive the session.
      const limitPrice = candidateSide === "short"
        ? parseFloat(((quote.bid ?? price) - 0.01).toFixed(2))
        : parseFloat(((quote.ask ?? price) + 0.01).toFixed(2));

      let orderId: string | null = null;
      let filledPrice = limitPrice;
      try {
        const order = await placeOrder(cfg.mode, {
          symbol: ticker,
          qty,
          side: candidateSide === "short" ? "sell" : "buy",
          type: "limit",
          limitPrice,
          timeInForce: mode === "day" ? "day" : "gtc",
        });
        orderId = order.id;
        if (order.filledAvgPrice) filledPrice = order.filledAvgPrice;
      } catch (err) {
        logger.warn({ err, ticker }, "[stock-bot] order placement failed");
        continue;
      }

      const id = randomUUID();
      const dbAction = candidateSide === "short" ? "short_sell" : "buy";
      await db.execute(sql`
        INSERT INTO stock_bot_bets
          (id, ticker, sector, action, trading_mode, mode, side, qty, signals, confidence,
           entry_price, stop_loss, target_price, peak_price, notional, alpaca_order_id, created_at)
        VALUES
          (${id}, ${ticker}, ${sector}, ${dbAction}, ${mode}, ${cfg.mode}, ${candidateSide}, ${qty},
           ${JSON.stringify({
             features,
             combinedDirection: signals.combinedDirection,
             combinedConfidence: signals.combinedConfidence,
             effectiveConfidence,
             research: research
               ? { confidence: research.confidence, horizon: research.horizon, summary: research.summary }
               : null,
             quote: quote
               ? { spreadPct: quote.spreadPct, imbalance: quote.imbalance }
               : null,
             stat: signals.stat,
             claude: signals.claude,
             ml: signals.ml,
           })}::jsonb,
           ${effectiveConfidence}, ${filledPrice}, ${stopLoss}, ${targetPrice}, ${filledPrice},
           ${qty * filledPrice}, ${orderId}, NOW())
      `);
      entries++;
      modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;
      held.add(heldKey(ticker, mode));
      // Register for intraday news monitoring (swing/long positions)
      if (mode !== "day") registerPositionTicker(ticker);
      // Update cycle-level sector tracking so subsequent candidates in this
      // same cycle see an accurate concentration picture.
      const filledNotional = qty * filledPrice;
      cycleTotalNotional += filledNotional;
      if (sector) cycleSectorNotional.set(sector, (cycleSectorNotional.get(sector) ?? 0) + filledNotional);
      recordDecision({
        ticker, action: "ENTER", horizon: mode, confidence: effectiveConfidence,
        reason: candidateSide === "short"
          ? `SHORT ${research?.horizon ?? mode} conf ${research?.confidence ?? effectiveConfidence} @ $${filledPrice.toFixed(2)}`
          : research
            ? `research ${research.horizon} conf ${research.confidence} + technicals @ $${filledPrice.toFixed(2)}`
            : `technical signal @ $${filledPrice.toFixed(2)}`,
        claudeReasoning: research?.summary ?? null,
      });
      logger.info(
        {
          ticker,
          side: candidateSide,
          mode,
          qty,
          price: filledPrice.toFixed(2),
          limitPrice,
          conf: effectiveConfidence,
          baseConf: signals.combinedConfidence,
          research: research ? { confidence: research.confidence, horizon: research.horizon } : null,
        },
        "[stock-bot] opened position",
      );
    } catch (err) {
      logger.warn({ err, ticker }, "[stock-bot] entry evaluation failed");
    }
  }
  return entries;
}

/** One full bot cycle. Safe to call on an interval; self-guards re-entry. */
export async function runBotCycle(): Promise<{ ran: boolean; summary: string }> {
  if (running) return { ran: false, summary: "cycle already running" };
  if (!alpacaConfigured()) return { ran: false, summary: "alpaca not configured" };

  let cfg = getConfig();

  // Auto-start/stop: enable the bot when the market opens, disable when it closes.
  // This runs even when the bot is disabled, so it can auto-enable at open.
  if (cfg.autoStartStop) {
    try {
      const clock = await getClock(cfg.mode);
      if (clock.isOpen && !cfg.enabled) {
        cfg = await saveConfig({ enabled: true });
        logger.info("[stock-bot] auto-start: market opened");
      } else if (!clock.isOpen && cfg.enabled) {
        // Only auto-stop if we are genuinely post-market (market already closed
        // for the day). Do NOT stop during pre-market: if nextOpen is within
        // 2 hours we are just waiting for the open, so let the bot sit enabled.
        const msUntilOpen = clock.nextOpen
          ? new Date(clock.nextOpen).getTime() - Date.now()
          : Infinity;
        const PRE_MARKET_WINDOW_MS = 2 * 60 * 60_000; // 2 hours
        if (msUntilOpen > PRE_MARKET_WINDOW_MS) {
          cfg = await saveConfig({ enabled: false });
          logger.info("[stock-bot] auto-stop: market closed (post-market)");
        } else {
          logger.info({ msUntilOpen: Math.round(msUntilOpen / 60_000) + "min" },
            "[stock-bot] pre-market hold — market opens soon, staying enabled");
        }
      }
    } catch (err) {
      logger.warn({ err }, "[stock-bot] auto-start/stop clock check failed");
    }
  }

  if (!cfg.enabled) return { ran: false, summary: "bot disabled" };

  running = true;
  try {
    const clock = await getClock(cfg.mode);
    const marketOpen = clock.isOpen;
    const nextCloseMs = clock.nextClose ? new Date(clock.nextClose).getTime() : null;

    const exits = await managePositions(cfg, marketOpen, nextCloseMs);

    let entries = 0;
    let note = "";
    if (marketOpen) {
      const realized = await todayRealizedPnl(cfg.mode);
      if (realized <= -Math.abs(cfg.dailyLossLimit)) {
        note = `daily loss limit hit (${realized.toFixed(2)})`;
      } else {
        entries = await tryEntries(cfg);
      }
    } else {
      note = "market closed — managing positions only";
    }

    lastCycleAt = Date.now();
    lastCycleSummary = `exits=${exits} entries=${entries}${note ? ` (${note})` : ""}`;
    return { ran: true, summary: lastCycleSummary };
  } catch (err) {
    logger.error({ err }, "[stock-bot] cycle failed");
    return { ran: false, summary: "cycle error" };
  } finally {
    running = false;
  }
}

export function botStatus(): {
  lastCycleAt: number;
  lastCycleSummary: string;
  running: boolean;
  decisions: BotDecision[];
} {
  return { lastCycleAt, lastCycleSummary, running, decisions: getDecisionLog() };
}
