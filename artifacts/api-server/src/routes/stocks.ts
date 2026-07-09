// REST routes for the stock trading vertical. All paths under /api/stocks/*.
// Fully isolated from the crypto/Kalshi routes. Mutating bot endpoints require
// an authenticated Clerk user (and optional BOT_ADMIN_CLERK_USER_ID lock,
// matching the Kalshi bot's guard).

import { Router } from "express";
import { getAuth } from "@clerk/express";
import { alpacaConfigured, getAccount, getPositions } from "../lib/stock/alpaca";
import { getConfig, saveConfig } from "../lib/stock/config";
import { getScannerResults, runScan, lastScanTime, getScanProgress } from "../lib/stock/scanner";
import { getLatestReports, getReportsForTicker, getResearchStatus, getResearchProgress, getResearchLists } from "../lib/stock/research";
import { getUniverseStatus } from "../lib/stock/market-universe";
import { getScoredNews } from "../lib/stock/news";
import { getEarnings } from "../lib/stock/earnings";
import { getCandles, getChartData, CHART_RANGES, type ChartRange } from "../lib/stock/data";
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
  const uni = getUniverseStatus();
  res.json({
    configured: alpacaConfigured(),
    sectors: SECTORS,
    universeSize: uni.candidateCount > 0 ? uni.candidateCount : STOCK_UNIVERSE.length,
    universe: uni,
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
    const result = await runScan({ force: true });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Scan failed" });
  }
});

router.get("/stocks/scanner/progress", (_req, res) => {
  res.json(getScanProgress());
});

router.get("/stocks/research", async (_req, res) => {
  try {
    const { running, ready } = getResearchStatus();
    const reports = await getLatestReports(200);
    res.json({ reports, running, ready, progress: getResearchProgress() });
  } catch {
    res.status(500).json({ error: "Failed to load research reports" });
  }
});

router.get("/stocks/research/lists", async (_req, res) => {
  try {
    const lists = await getResearchLists();
    res.json(lists);
  } catch {
    res.status(500).json({ error: "Failed to build research lists" });
  }
});

router.get("/stocks/research/:ticker", async (req, res) => {
  try {
    const reports = await getReportsForTicker(req.params.ticker, 10);
    if (reports.length === 0) {
      res.status(404).json({ error: "No research reports for this ticker" });
      return;
    }
    res.json({ ticker: req.params.ticker.toUpperCase(), reports });
  } catch {
    res.status(500).json({ error: "Failed to load research reports" });
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
  const rangeParam = String(req.query.range ?? "1D");
  const range: ChartRange = (CHART_RANGES as string[]).includes(rangeParam)
    ? (rangeParam as ChartRange)
    : "1D";
  try {
    if (!alpacaConfigured()) {
      res.status(503).json({ error: "Alpaca not configured" });
      return;
    }
    const [candles, chart] = await Promise.all([
      getCandles(ticker, ["day", "swing", "long"].includes(mode) ? mode : "day"),
      getChartData(ticker, range).catch(() => null),
    ]);
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
      useClaude: false,
    });
    res.json({
      ...signals,
      sector,
      companyName: uni?.name ?? ticker,
      ml: { ...signals.ml, ...mlStatus(ticker) },
      candles: candles.slice(-120),
      chart,
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
    "minConfidence", "stopLossPct", "targetGainPct",
    "dayStopLossPct", "dayTargetGainPct", "swingStopLossPct", "swingTargetGainPct", "longStopLossPct",
    "swingMaxHoldDays", "longMaxHoldDays", "earningsBlackout", "earningsBlackoutHours",
    "newsSensitivity", "sectorFocus", "maxPositionDollars",
    "dynamicSizing", "minMarketCapBillion", "maxSectorPct",
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

/** Open bets from the DB — includes confidence, stop, target, signals. */
router.get("/stocks/bot/bets/open", async (_req, res) => {
  try {
    const cfg = getConfig();
    const rows = (await db.execute(sql`
      SELECT id, ticker, trading_mode, confidence, signals, stop_loss, target_price,
             peak_price, entry_price, notional, sector, created_at
      FROM stock_bot_bets
      WHERE action = 'buy' AND exited_at IS NULL AND mode = ${cfg.mode}
      ORDER BY created_at DESC
    `)) as unknown as { rows: any[] };
    const bets = (rows.rows ?? []).map((r) => ({
      id: String(r.id),
      ticker: String(r.ticker),
      tradingMode: r.trading_mode as string,
      confidence: r.confidence != null ? Number(r.confidence) : null,
      stopLoss: r.stop_loss != null ? Number(r.stop_loss) : null,
      targetPrice: r.target_price != null ? Number(r.target_price) : null,
      peakPrice: r.peak_price != null ? Number(r.peak_price) : null,
      entryPrice: r.entry_price != null ? Number(r.entry_price) : null,
      signals: r.signals ?? null,
      sector: r.sector ?? null,
      createdAt: r.created_at,
    }));
    res.json({ bets });
  } catch {
    res.status(500).json({ error: "Failed to load open bets" });
  }
});

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

router.get("/stocks/bot/performance", async (_req, res) => {
  try {
    const cfg = getConfig();
    const [dailyRes, modeRes, summaryRes] = await Promise.all([
      db.execute(sql`
        SELECT
          DATE(exited_at AT TIME ZONE 'America/New_York') AS day,
          COALESCE(SUM(pnl), 0) AS daily_pnl
        FROM stock_bot_bets
        WHERE exited_at IS NOT NULL AND mode = ${cfg.mode} AND archived_at IS NULL
        GROUP BY 1
        ORDER BY 1 ASC
      `) as unknown as Promise<{ rows: any[] }>,
      db.execute(sql`
        SELECT
          trading_mode,
          COUNT(*) FILTER (WHERE outcome = 'win')  AS wins,
          COUNT(*) FILTER (WHERE outcome = 'loss') AS losses,
          COALESCE(SUM(pnl), 0)                    AS total_pnl
        FROM stock_bot_bets
        WHERE exited_at IS NOT NULL AND mode = ${cfg.mode} AND archived_at IS NULL
        GROUP BY 1
      `) as unknown as Promise<{ rows: any[] }>,
      db.execute(sql`
        SELECT
          COUNT(*)                                              AS total_trades,
          COUNT(*) FILTER (WHERE outcome = 'win')              AS total_wins,
          COUNT(*) FILTER (WHERE outcome = 'loss')             AS total_losses,
          COALESCE(AVG(pnl) FILTER (WHERE outcome = 'win'),  0) AS avg_win,
          COALESCE(AVG(pnl) FILTER (WHERE outcome = 'loss'), 0) AS avg_loss,
          COALESCE(MAX(pnl), 0)                               AS best_trade,
          COALESCE(MIN(pnl), 0)                               AS worst_trade,
          COALESCE(SUM(pnl), 0)                               AS total_pnl
        FROM stock_bot_bets
        WHERE exited_at IS NOT NULL AND mode = ${cfg.mode} AND archived_at IS NULL
      `) as unknown as Promise<{ rows: any[] }>,
    ]);

    // Build cumulative equity curve from daily P&L rows
    let cum = 0;
    const equityCurve = ((dailyRes as any).rows ?? []).map((r: any) => {
      cum += Number(r.daily_pnl) || 0;
      return { date: String(r.day), cumPnl: parseFloat(cum.toFixed(2)) };
    });

    const s = ((summaryRes as any).rows ?? [])[0] ?? {};
    const totalWins = Number(s.total_wins) || 0;
    const totalLosses = Number(s.total_losses) || 0;

    const byMode: Record<string, { wins: number; losses: number; totalPnl: number }> = {
      day: { wins: 0, losses: 0, totalPnl: 0 },
      swing: { wins: 0, losses: 0, totalPnl: 0 },
      long: { wins: 0, losses: 0, totalPnl: 0 },
    };
    for (const r of (modeRes as any).rows ?? []) {
      if (r.trading_mode && byMode[r.trading_mode]) {
        byMode[r.trading_mode] = {
          wins: Number(r.wins) || 0,
          losses: Number(r.losses) || 0,
          totalPnl: parseFloat((Number(r.total_pnl) || 0).toFixed(2)),
        };
      }
    }

    res.json({
      equityCurve,
      summary: {
        totalTrades: Number(s.total_trades) || 0,
        winRate: totalWins + totalLosses > 0 ? totalWins / (totalWins + totalLosses) : 0,
        avgWin: parseFloat((Number(s.avg_win) || 0).toFixed(2)),
        avgLoss: parseFloat((Number(s.avg_loss) || 0).toFixed(2)),
        bestTrade: parseFloat((Number(s.best_trade) || 0).toFixed(2)),
        worstTrade: parseFloat((Number(s.worst_trade) || 0).toFixed(2)),
        totalPnl: parseFloat((Number(s.total_pnl) || 0).toFixed(2)),
      },
      byMode,
    });
  } catch {
    res.status(500).json({ error: "Failed to load performance data" });
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
