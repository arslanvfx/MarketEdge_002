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
import { getConfig } from "./config";
import { getCandles } from "./data";
import { buildSignals } from "./ai";
import { buildFeatures, recordOutcome } from "./ml";
import { getScoredNews } from "./news";
import { getEarnings } from "./earnings";
import { getScannerResults, getSectorMomentum } from "./scanner";
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
  try {
    await closePosition(mode, bet.ticker);
  } catch (err) {
    logger.warn({ err, ticker: bet.ticker }, "[stock-bot] closePosition failed (may already be flat)");
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
      await exitPosition(bet, cfg.mode, price, reason);
      exits++;
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

  const candidates = await candidateTickers(cfg);
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
        { useClaude: true },
      );

      if (signals.combinedDirection !== "up") continue;
      if (signals.combinedConfidence < cfg.minConfidence) continue;

      const price = signals.price;
      if (price <= 0) continue;

      const notional = Math.max(1, (account.equity * cfg.positionSizePct) / 100);
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
           entry_price, stop_loss, target_price, notional, alpaca_order_id, created_at)
        VALUES
          (${id}, ${ticker}, ${sector}, 'buy', ${mode}, ${cfg.mode}, 'long', ${qty},
           ${JSON.stringify({
             features,
             combinedDirection: signals.combinedDirection,
             combinedConfidence: signals.combinedConfidence,
             stat: signals.stat,
             claude: signals.claude,
             ml: signals.ml,
           })}::jsonb,
           ${signals.combinedConfidence}, ${filledPrice}, ${stopLoss}, ${targetPrice},
           ${qty * filledPrice}, ${orderId}, NOW())
      `);
      entries++;
      logger.info(
        { ticker, mode, qty, price: filledPrice.toFixed(2), conf: signals.combinedConfidence },
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
  const cfg = getConfig();
  if (!cfg.enabled) return { ran: false, summary: "bot disabled" };
  if (!alpacaConfigured()) return { ran: false, summary: "alpaca not configured" };

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
