// REST routes for the stock trading vertical. All paths under /api/stocks/*.
// Fully isolated from the crypto/Kalshi routes. Mutating bot endpoints require
// an authenticated Clerk user (and optional BOT_ADMIN_CLERK_USER_ID lock,
// matching the Kalshi bot's guard).

import { Router } from "express";
import { getAuth } from "@clerk/express";
import { alpacaConfigured, getAccount, getPositions } from "../lib/stock/alpaca";
import { getConfig, saveConfig } from "../lib/stock/config";
import { getScannerResults, runScan, lastScanTime } from "../lib/stock/scanner";
import { getScoredNews } from "../lib/stock/news";
import { getEarnings } from "../lib/stock/earnings";
import { getCandles } from "../lib/stock/data";
import { buildSignals } from "../lib/stock/ai";
import { getSectorMomentum } from "../lib/stock/scanner";
import { lookupUniverse, STOCK_UNIVERSE, SECTORS } from "../lib/stock/universe";
import { mlStatus } from "../lib/stock/ml";
import { runBotCycle, botStatus, manualClosePosition } from "../lib/stock/bot";
import {
  listWatchlist,
  addWatchlist,
  removeWatchlist,
} from "../lib/stock/watchlist";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { StockBotConfig, TradingMode } from "../lib/stock/types";

const router = Router();

function requireAuth(req: any, res: any, next: any): void {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized — sign in to control the stock bot" });
    return;
  }
  const adminId = process.env["BOT_ADMIN_CLERK_USER_ID"];
  if (adminId && auth.userId !== adminId) {
    res.status(403).json({ error: "Forbidden — not authorized to control the stock bot" });
    return;
  }
  next();
}

// ---------- Meta ----------

router.get("/stocks/meta", (_req, res) => {
  res.json({
    configured: alpacaConfigured(),
    sectors: SECTORS,
    universeSize: STOCK_UNIVERSE.length,
    lastScanAt: lastScanTime(),
  });
});

// ---------- Scanner ----------

router.get("/stocks/scanner", async (_req, res) => {
  try {
    const rows = await getScannerResults();
    res.json({ results: rows, lastScanAt: lastScanTime() });
  } catch (err) {
    res.status(500).json({ error: "Failed to load scanner results" });
  }
});

router.post("/stocks/scanner/run", requireAuth, async (_req, res) => {
  try {
    const result = await runScan();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Scan failed" });
  }
});

// ---------- Watchlist ----------

router.get("/stocks/watchlist", async (_req, res) => {
  try {
    res.json({ watchlist: await listWatchlist() });
  } catch {
    res.status(500).json({ error: "Failed to load watchlist" });
  }
});

router.post("/stocks/watchlist", requireAuth, async (req, res) => {
  const ticker = String(req.body?.ticker ?? "").trim().toUpperCase();
  if (!ticker || !/^[A-Z.]{1,6}$/.test(ticker)) {
    res.status(400).json({ error: "Invalid ticker" });
    return;
  }
  try {
    await addWatchlist(ticker, req.body?.companyName, req.body?.sector);
    res.json({ watchlist: await listWatchlist() });
  } catch {
    res.status(500).json({ error: "Failed to add ticker" });
  }
});

router.delete("/stocks/watchlist/:ticker", requireAuth, async (req, res) => {
  try {
    await removeWatchlist(req.params.ticker);
    res.json({ watchlist: await listWatchlist() });
  } catch {
    res.status(500).json({ error: "Failed to remove ticker" });
  }
});

// ---------- Ticker detail: news, earnings, full signals ----------

router.get("/stocks/news/:ticker", async (req, res) => {
  try {
    res.json({ news: await getScoredNews(req.params.ticker) });
  } catch {
    res.status(500).json({ error: "Failed to load news" });
  }
});

router.get("/stocks/analysis/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const mode = (String(req.query.mode ?? "day") as TradingMode);
  try {
    if (!alpacaConfigured()) {
      res.status(503).json({ error: "Alpaca not configured" });
      return;
    }
    const candles = await getCandles(ticker, ["day", "swing", "long"].includes(mode) ? mode : "day");
    if (candles.length < 20) {
      res.status(422).json({ error: "Insufficient market data for analysis" });
      return;
    }
    const uni = lookupUniverse(ticker);
    const sector = uni?.sector ?? "Other";
    const news = await getScoredNews(ticker);
    const cfg = getConfig();
    const earnings = await getEarnings(ticker, cfg.earningsBlackoutHours);
    const signals = await buildSignals(ticker, candles, news, earnings, getSectorMomentum(sector), {
      useClaude: true,
    });
    res.json({
      ...signals,
      sector,
      companyName: uni?.name ?? ticker,
      ml: { ...signals.ml, ...mlStatus(ticker) },
      candles: candles.slice(-120),
    });
  } catch (err) {
    res.status(500).json({ error: "Analysis failed" });
  }
});

// ---------- Bot control ----------

router.get("/stocks/bot/status", async (_req, res) => {
  const cfg = getConfig();
  let account = null;
  let positions: unknown[] = [];
  try {
    if (alpacaConfigured()) {
      account = await getAccount(cfg.mode);
      positions = await getPositions(cfg.mode);
    }
  } catch {
    // best-effort — surface config/status even if the broker call fails
  }
  res.json({ config: cfg, account, positions, cycle: botStatus(), configured: alpacaConfigured() });
});

router.get("/stocks/bot/config", (_req, res) => {
  res.json({ config: getConfig() });
});

router.put("/stocks/bot/config", requireAuth, async (req, res) => {
  const body = req.body ?? {};
  const allowed: (keyof StockBotConfig)[] = [
    "enabled", "mode", "tradingModes", "positionSizePct", "maxConcurrentPositions",
    "maxDayPositions", "maxSwingPositions", "maxLongPositions", "dailyLossLimit",
    "minConfidence", "stopLossPct", "targetGainPct", "swingMaxHoldDays",
    "longMaxHoldDays", "earningsBlackout", "earningsBlackoutHours", "newsSensitivity",
  ];
  const partial: Partial<StockBotConfig> = {};
  for (const k of allowed) {
    if (k in body) (partial as any)[k] = body[k];
  }
  try {
    const cfg = await saveConfig(partial);
    res.json({ config: cfg });
  } catch {
    res.status(500).json({ error: "Failed to save config" });
  }
});

router.post("/stocks/bot/cycle", requireAuth, async (_req, res) => {
  try {
    res.json(await runBotCycle());
  } catch {
    res.status(500).json({ error: "Cycle failed" });
  }
});

router.post("/stocks/bot/positions/:ticker/close", requireAuth, async (req, res) => {
  const ticker = String(req.params.ticker ?? "").trim();
  if (!ticker) {
    res.status(400).json({ error: "Ticker is required" });
    return;
  }
  try {
    const result = await manualClosePosition(ticker);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to close position";
    // No open position / bad ticker is a client error; broker failures are 500.
    const status = /No open|required/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
});

// ---------- History / positions / P&L ----------

router.get("/stocks/bot/positions", async (_req, res) => {
  try {
    const cfg = getConfig();
    if (!alpacaConfigured()) {
      res.json({ positions: [] });
      return;
    }
    res.json({ positions: await getPositions(cfg.mode) });
  } catch {
    res.status(500).json({ error: "Failed to load positions" });
  }
});

// Derive which signal drove a trade from the stored signals snapshot. The bot
// blends stat / Claude / ML votes weighted by confidence (Claude ×1.1); the
// "primary driver" is the highest-weighted signal that agreed with the
// combined direction actually taken. News only tilts confidence and is not
// stored per-trade, so it is not surfaced as a discrete driver here.
function deriveSignalType(signals: any): string {
  if (!signals || typeof signals !== "object") return "unknown";
  const dir = signals.combinedDirection;
  if (!dir) return "unknown";
  const candidates: { type: string; weight: number }[] = [];
  const { stat, claude, ml } = signals;
  if (stat && stat.direction === dir) {
    candidates.push({ type: "technical", weight: (Number(stat.confidence) || 0) / 100 });
  }
  if (claude && claude.direction === dir) {
    candidates.push({ type: "ai", weight: ((Number(claude.confidence) || 0) / 100) * 1.1 });
  }
  if (ml && ml.ready && ml.direction === dir) {
    candidates.push({ type: "ml", weight: (Number(ml.confidence) || 0) / 100 });
  }
  if (candidates.length === 0) return "unknown";
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0].type;
}

router.get("/stocks/bot/history", async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  try {
    const rows = (await db.execute(sql`
      SELECT id, ticker, sector, action, trading_mode, mode, side, qty, confidence,
             entry_price, exit_price, stop_loss, target_price, notional, pnl,
             exit_reason, outcome, signals, created_at, exited_at
      FROM stock_bot_bets
      WHERE archived_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as { rows: any[] };
    const history = (rows.rows ?? []).map((r) => {
      const { signals, ...rest } = r;
      return { ...rest, signal_type: deriveSignalType(signals) };
    });
    res.json({ history });
  } catch {
    res.status(500).json({ error: "Failed to load history" });
  }
});

router.get("/stocks/bot/pnl", async (_req, res) => {
  try {
    const cfg = getConfig();
    const summary = (await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE exited_at IS NOT NULL) AS closed,
        COUNT(*) FILTER (WHERE exited_at IS NULL AND action = 'buy') AS open,
        COALESCE(SUM(pnl), 0) AS total_pnl,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
        COUNT(*) FILTER (WHERE outcome = 'loss') AS losses,
        COALESCE(SUM(pnl) FILTER (WHERE exited_at >= date_trunc('day', NOW())), 0) AS today_pnl
      FROM stock_bot_bets
      WHERE mode = ${cfg.mode} AND archived_at IS NULL
    `)) as unknown as { rows: any[] };
    const s = summary.rows?.[0] ?? {};
    const wins = Number(s.wins) || 0;
    const losses = Number(s.losses) || 0;
    res.json({
      closed: Number(s.closed) || 0,
      open: Number(s.open) || 0,
      totalPnl: Number(s.total_pnl) || 0,
      todayPnl: Number(s.today_pnl) || 0,
      wins,
      losses,
      winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
    });
  } catch {
    res.status(500).json({ error: "Failed to load P&L" });
  }
});

export default router;
