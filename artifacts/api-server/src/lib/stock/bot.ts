// Stock trading bot engine. Runs on a market-hours-gated cycle, independent of
// the crypto/Kalshi bot. Responsibilities:
//   - manage open positions (stop-loss, target, max-hold, exit → ML outcome)
//   - respect risk limits (daily loss, per-mode & total position caps, PDT,
//     earnings blackout)
//   - open new positions from the highest-scoring scanner candidates that clear
//     the combined-signal confidence gate
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
  placeOrder,
  closePosition,
} from "./alpaca";
import { getConfig, saveConfig } from "./config";
import { getCandles } from "./data";
import { buildSignals, setStockAIPaused } from "./ai";
import { buildFeatures, recordOutcome } from "./ml";
import { getScoredNews } from "./news";
import { getEarnings } from "./earnings";
import { getScannerResults, getSectorMomentum } from "./scanner";
import { getCachedResearch } from "./research";
import { lookupUniverse } from "./universe";
import { watchlistTickers } from "./watchlist";
import type { Candle, TradingMode, StockBotConfig } from "./types";

let running = false;
let lastCycleAt = 0;
let lastCycleSummary = "";

interface OpenBetRow {
  id: string;
  ticker: string;
  sector: string | null;
  tradingMode: TradingMode;
  qty: number;
  entryPrice: number;
  stopLoss: number | null;
  targetPrice: number | null;
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
           notional, confidence, signals, created_at
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

async function managePositions(cfg: StockBotConfig, marketOpen: boolean): Promise<number> {
  let exits = 0;
  const open = await openBets(cfg.mode);
  for (const bet of open) {
    const price = await getLatestPrice(bet.ticker);
    if (price == null || price <= 0) continue;
    const heldMs = Date.now() - bet.createdAt.getTime();
    let reason: string | null = null;

    if (bet.stopLoss != null && price <= bet.stopLoss) reason = "stop_loss";
    else if (bet.targetPrice != null && price >= bet.targetPrice) reason = "target";
    else if (heldMs >= maxHoldMs(bet.tradingMode, cfg)) reason = "max_hold";
    else if (bet.tradingMode === "day" && !marketOpen) reason = "eod_close";

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

async function candidateTickers(cfg: StockBotConfig): Promise<string[]> {
  const scanner = await getScannerResults();
  const watch = await watchlistTickers();
  // Highest scanner score first; watchlist always eligible.
  const ranked = scanner
    .filter((r) => r.direction === "up") // long-only for now
    .sort((a, b) => b.score - a.score)
    .map((r) => r.ticker);
  return Array.from(new Set([...watch, ...ranked]));
}

async function tryEntries(cfg: StockBotConfig): Promise<number> {
  let entries = 0;
  const account = await getAccount(cfg.mode);

  // PDT guard: if flagged and low equity, block new day trades.
  const pdtBlocked = account.patternDayTrader && account.equity < 25000;

  const open = await openBets(cfg.mode);
  const held = new Set(open.map((b) => b.ticker));
  const countByMode = (m: TradingMode) => open.filter((b) => b.tradingMode === m).length;

  if (open.length >= cfg.maxConcurrentPositions) return 0;

  const allCandidates = await candidateTickers(cfg);

  // Sector focus filter: if sectorFocus is non-empty, only consider tickers in
  // those sectors. Watchlist tickers are always eligible regardless of sector.
  const watchSet = new Set(await watchlistTickers());
  const activeSectors = (cfg.sectorFocus ?? []);
  const candidates =
    activeSectors.length === 0
      ? allCandidates
      : allCandidates.filter((t) => {
          if (watchSet.has(t)) return true; // watchlist bypass
          const uni = lookupUniverse(t);
          return activeSectors.includes(uni?.sector ?? "");
        });

  if (activeSectors.length > 0) {
    logger.info(
      { sectorFocus: activeSectors, candidatesBefore: allCandidates.length, candidatesAfter: candidates.length },
      "[stock-bot] sector filter applied",
    );
  }

  // Choose the primary trading mode for a new entry: prefer day, then swing, then long.
  const activeModes = cfg.tradingModes.filter((m) =>
    countByMode(m) < (m === "day" ? cfg.maxDayPositions : m === "swing" ? cfg.maxSwingPositions : cfg.maxLongPositions),
  );
  if (activeModes.length === 0) return 0;

  for (const ticker of candidates) {
    if (open.length + entries >= cfg.maxConcurrentPositions) break;
    if (held.has(ticker)) continue;

    // Pick a mode with remaining capacity (day requires PDT clearance).
    const mode = activeModes.find((m) => {
      if (m === "day" && pdtBlocked) return false;
      const cap = m === "day" ? cfg.maxDayPositions : m === "swing" ? cfg.maxSwingPositions : cfg.maxLongPositions;
      return countByMode(m) + entries < cap;
    });
    if (!mode) continue;

    try {
      const candles: Candle[] = await getCandles(ticker, mode);
      if (candles.length < 25) continue;

      const uni = lookupUniverse(ticker);
      const sector = uni?.sector ?? "Other";
      const news = await getScoredNews(ticker);
      const earnings = await getEarnings(ticker, cfg.earningsBlackoutHours);

      if (cfg.earningsBlackout && earnings?.soon) {
        continue; // avoid entering into an earnings event
      }

      const signals = await buildSignals(
        ticker,
        candles,
        news,
        earnings,
        getSectorMomentum(sector),
        { useClaude: !cfg.aiPaused },
      );

      if (signals.combinedDirection !== "up") continue;

      // Research signal: ±5pp confidence based on today's cached Claude research.
      let effectiveConfidence = signals.combinedConfidence;
      const research = getCachedResearch(ticker);
      if (research) {
        if (research.score >= 70) {
          effectiveConfidence = Math.min(95, effectiveConfidence + 5);
          logger.info(
            { ticker, researchScore: research.score, verdict: research.verdict },
            "[stock-bot] research boost +5pp",
          );
        } else if (research.score <= 30) {
          effectiveConfidence = Math.max(50, effectiveConfidence - 5);
          logger.info(
            { ticker, researchScore: research.score, verdict: research.verdict },
            "[stock-bot] research penalty -5pp",
          );
        }
      }

      if (effectiveConfidence < cfg.minConfidence) continue;

      const price = signals.price;
      if (price <= 0) continue;

      const pctNotional = Math.max(1, (account.equity * cfg.positionSizePct) / 100);
      const dollarCap = cfg.maxPositionDollars ?? null;
      const notional = dollarCap != null ? Math.min(pctNotional, dollarCap) : pctNotional;
      const cappedByDollar = dollarCap != null && notional < pctNotional;
      const qty = Math.floor(notional / price);
      if (qty < 1) continue;

      if (cappedByDollar) {
        logger.info(
          { ticker, pctNotional: pctNotional.toFixed(2), cap: dollarCap, notional: notional.toFixed(2) },
          "[stock-bot] dollar cap applied to position size",
        );
      }

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
           entry_price, stop_loss, target_price, notional, alpaca_order_id, created_at)
        VALUES
          (${id}, ${ticker}, ${sector}, 'buy', ${mode}, ${cfg.mode}, 'long', ${qty},
           ${JSON.stringify({
             features,
             combinedDirection: signals.combinedDirection,
             combinedConfidence: signals.combinedConfidence,
             effectiveConfidence,
             research: research
               ? { score: research.score, verdict: research.verdict }
               : null,
             stat: signals.stat,
             claude: signals.claude,
             ml: signals.ml,
           })}::jsonb,
           ${effectiveConfidence}, ${filledPrice}, ${stopLoss}, ${targetPrice},
           ${qty * filledPrice}, ${orderId}, NOW())
      `);
      entries++;
      logger.info(
        {
          ticker,
          mode,
          qty,
          price: filledPrice.toFixed(2),
          conf: effectiveConfidence,
          baseConf: signals.combinedConfidence,
          research: research ? { score: research.score, verdict: research.verdict } : null,
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
  // Sync AI pause flag at the top of every cycle so claudeSignal() sees it immediately.
  setStockAIPaused(cfg.aiPaused ?? false);

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

    const exits = await managePositions(cfg, marketOpen);

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

export function botStatus(): { lastCycleAt: number; lastCycleSummary: string; running: boolean } {
  return { lastCycleAt, lastCycleSummary, running };
}
