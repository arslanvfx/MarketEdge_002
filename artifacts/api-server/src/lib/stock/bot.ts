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
import { getCachedResearch, getTodayReports } from "./research";
import { lookupUniverse } from "./universe";
import { watchlistTickers } from "./watchlist";
import type { Candle, TradingMode, StockBotConfig, ResearchReport, ScannerRow } from "./types";

let running = false;
let lastCycleAt = 0;
let lastCycleSummary = "";

// ── Per-horizon exit rules (Task spec) ──────────────────────────────────────
const DAY_EOD_BUFFER_MS = 15 * 60 * 1000; // close day trades 15 min before close
const SWING_TARGET_PCT = 8;
const SWING_STOP_PCT = 4;
const LONG_MIN_RESEARCH_CONF = 60;        // exit long if re-rated below this
const LONG_TRAIL_STOP_PCT = 6;            // −6% trailing stop from peak
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
  db.execute(sql`
    INSERT INTO stock_bot_decisions (ticker, action, horizon, confidence, reason, ts)
    VALUES (${decision.ticker}, ${decision.action}, ${decision.horizon},
            ${decision.confidence}, ${decision.reason}, to_timestamp(${decision.ts / 1000}))
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
    decisionLog.push({
      ts: new Date(r.ts).getTime(),
      ticker: String(r.ticker),
      action: r.action as BotDecision["action"],
      horizon: (r.horizon ?? null) as TradingMode | null,
      confidence: r.confidence != null ? Number(r.confidence) : null,
      reason: String(r.reason ?? ""),
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

function maxHoldMs(mode: TradingMode, cfg: StockBotConfig): number {
  if (mode === "day") return 6.5 * 60 * 60 * 1000; // close intraday
  if (mode === "swing") return cfg.swingMaxHoldDays * 24 * 60 * 60 * 1000;
  return cfg.longMaxHoldDays * 24 * 60 * 60 * 1000;
}

async function openBets(mode: "paper" | "live"): Promise<OpenBetRow[]> {
  const res = (await db.execute(sql`
    SELECT id, ticker, sector, trading_mode, qty, entry_price, stop_loss, target_price,
           peak_price, notional, confidence, signals, created_at
    FROM stock_bot_bets
    WHERE action = 'buy' AND exited_at IS NULL AND mode = ${mode}
  `)) as unknown as { rows: any[] };
  return (res.rows ?? []).map((r) => ({
    id: r.id,
    ticker: r.ticker,
    sector: r.sector,
    tradingMode: r.trading_mode as TradingMode,
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
  const pnl = (exitPrice - bet.entryPrice) * bet.qty;
  const outcome = pnl > 0 ? "win" : pnl < 0 ? "loss" : "push";
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
  const pnl = (price - bet.entryPrice) * bet.qty;
  return { closed: true, ticker: bet.ticker, qty: bet.qty, exitPrice: price, pnl };
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
    const heldMs = Date.now() - bet.createdAt.getTime();
    const gainPct = bet.entryPrice > 0 ? ((price - bet.entryPrice) / bet.entryPrice) * 100 : 0;
    let reason: string | null = null;

    // Claude stance override: today's research says stay away / sell → exit
    // swing & long positions (day trades are already flattened intraday).
    const stanceRep = bet.tradingMode !== "day" ? getCachedResearch(bet.ticker) : undefined;
    if (stanceRep?.stance === "avoid") {
      reason = "research_avoid (Claude: stay away/sell)";
    } else if (bet.tradingMode === "day") {
      // Day trades: hard stop/target if set, forced flat 15 min before close.
      if (bet.stopLoss != null && price <= bet.stopLoss) reason = "stop_loss";
      else if (bet.targetPrice != null && price >= bet.targetPrice) reason = "target";
      else if (nearClose || !marketOpen) reason = "eod_close";
      else if (heldMs >= maxHoldMs("day", cfg)) reason = "max_hold";
    } else if (bet.tradingMode === "swing") {
      // Swing: +8% target / −4% stop (task-spec rules), plus max-hold days.
      if (gainPct <= -SWING_STOP_PCT) reason = "swing_stop";
      else if (gainPct >= SWING_TARGET_PCT) reason = "swing_target";
      else if (bet.stopLoss != null && price <= bet.stopLoss) reason = "stop_loss";
      else if (heldMs >= maxHoldMs("swing", cfg)) reason = "max_hold";
    } else {
      // Long: trailing −6% stop from peak + research re-rating each cycle.
      const peak = Math.max(bet.peakPrice ?? bet.entryPrice, price);
      if (peak > (bet.peakPrice ?? 0)) await updatePeak(bet.id, peak);
      const drawdownPct = peak > 0 ? ((peak - price) / peak) * 100 : 0;
      const research = getCachedResearch(bet.ticker);
      if (research && research.confidence < LONG_MIN_RESEARCH_CONF) {
        reason = `research_downgrade (conf ${research.confidence})`;
      } else if (drawdownPct >= LONG_TRAIL_STOP_PCT) {
        reason = "trailing_stop";
      } else if (bet.stopLoss != null && price <= bet.stopLoss) {
        reason = "stop_loss";
      } else if (heldMs >= maxHoldMs("long", cfg)) {
        reason = "max_hold";
      }
    }

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

  // 3. Top scanner rows (upward direction) as a fallback pool.
  const ranked = scanner
    .filter((r) => r.direction === "up")
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  for (const r of ranked) {
    if (seen.has(r.ticker)) continue;
    seen.add(r.ticker);
    candidates.push({ ticker: r.ticker, horizon: null, report: null });
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

  const open = await openBets(cfg.mode);
  // Held guard is per (ticker, horizon): the same ticker may hold concurrent
  // day/swing/long positions, but never two positions in the same horizon.
  const held = new Set(open.map((b) => heldKey(b.ticker, b.tradingMode)));
  const modeCounts: Record<TradingMode, number> = { day: 0, swing: 0, long: 0 };
  for (const b of open) modeCounts[b.tradingMode] = (modeCounts[b.tradingMode] ?? 0) + 1;
  const capFor = (m: TradingMode) =>
    m === "day" ? cfg.maxDayPositions : m === "swing" ? cfg.maxSwingPositions : cfg.maxLongPositions;

  if (open.length >= cfg.maxConcurrentPositions) return 0;

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

    // Claude stance gate: never enter a stock on today's stay-away/sell list.
    if (cand.report?.stance === "avoid") {
      recordDecision({
        ticker, action: "SKIP", horizon: cand.horizon,
        confidence: cand.report.confidence,
        reason: "Claude research stance: avoid (stay away/sell)",
      });
      continue;
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

      if (signals.combinedDirection !== "up") {
        if (cand.report) {
          recordDecision({
            ticker, action: "SKIP", horizon: mode,
            confidence: cand.report.confidence, reason: "technical signals not bullish",
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

      const pctNotional = Math.max(1, (account.equity * cfg.positionSizePct) / 100);
      const dollarCap = cfg.maxPositionDollars ?? null;
      const notional = dollarCap != null ? Math.min(pctNotional, dollarCap) : pctNotional;
      const qty = Math.floor(notional / price);
      if (qty < 1) continue;

      const stopLoss = price * (1 - cfg.stopLossPct / 100);
      const targetPrice = price * (1 + cfg.targetGainPct / 100);
      const features = buildFeatures(candles, news, earnings, getSectorMomentum(sector));

      let orderId: string | null = null;
      let filledPrice = price;
      try {
        const order = await placeOrder(cfg.mode, {
          symbol: ticker,
          qty,
          side: "buy",
          type: "market",
          timeInForce: mode === "day" ? "day" : "gtc",
        });
        orderId = order.id;
        if (order.filledAvgPrice) filledPrice = order.filledAvgPrice;
      } catch (err) {
        logger.warn({ err, ticker }, "[stock-bot] order placement failed");
        continue;
      }

      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO stock_bot_bets
          (id, ticker, sector, action, trading_mode, mode, side, qty, signals, confidence,
           entry_price, stop_loss, target_price, peak_price, notional, alpaca_order_id, created_at)
        VALUES
          (${id}, ${ticker}, ${sector}, 'buy', ${mode}, ${cfg.mode}, 'long', ${qty},
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
      recordDecision({
        ticker, action: "ENTER", horizon: mode, confidence: effectiveConfidence,
        reason: research
          ? `research ${research.horizon} conf ${research.confidence} + technicals @ $${filledPrice.toFixed(2)}`
          : `technical signal @ $${filledPrice.toFixed(2)}`,
      });
      logger.info(
        {
          ticker,
          mode,
          qty,
          price: filledPrice.toFixed(2),
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
        cfg = await saveConfig({ enabled: false });
        logger.info("[stock-bot] auto-stop: market closed");
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
