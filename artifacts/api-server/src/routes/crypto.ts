import { Router } from "express";
import { getAuth } from "@clerk/express";
import { getAiSpendLevel, setAiSpendLevel, getStockAiEnabled, setStockAiEnabled, AI_SPEND_LABELS, isAiFeatureEnabled, type AiSpendLevel } from "../lib/ai-spend";
import { kalshiTargetCache } from "../lib/crypto-kalshi";
import {
  fetchCryptoPredictions,
  fetchCryptoPrices,
  fetchAIPredictions,
  getPredictionHistory,
  getPredictionHeadlines,
  getPredictionAnalytics,
  getAllPredictionAnalytics,
  clearPredictionHistory,
  clearPredictionHistoryOld,
  clearAccuracyLogsOnly,
  ACCURACY_THRESHOLD_PCT,
  fetchKalshiBtcCall,
  fetchKalshiTarget,
  KALSHI_SERIES,
  getKalshiWindowContext,
  CRYPTO_COINS,
  getAiSettings,
  setGlobalAiMode,
  setCoinClaudeEnabled,
  setSelfConsistencySamples,
  setAutoPilot,
  isAiGloballyEnabled,
  getTrackerWindowCall,
  getStatWindowCall,
  getWindowBetSignal,
  fetchLiveDirection,
  getLiveDirectionHistory,
  getTradingWindows,
  getCachedPrediction,
  getWindowMonitorAccuracy,
  getTimingAnalysis,
} from "../lib/crypto";
import { getMLPrediction, getMLStatus } from "../lib/ml-store";
import { extractMLFeatures } from "../lib/ml-features";
import {
  runBacktest,
  compareReports,
  runThresholdAnalysis,
  type BacktestReport,
} from "../lib/backtest";
import { tally } from "../lib/history-tally";
import { getBotEntryTimingAnalysis } from "../lib/kalshi-bot-entry-timing";

const router = Router();

router.get("/crypto/predictions", async (_req, res) => {
  try {
    const result = await fetchCryptoPredictions();
    if (result.coins.length === 0) {
      res.status(502).json({ error: "Upstream price data unavailable" });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: "Failed to fetch crypto predictions" });
  }
});

router.get("/crypto/prices", async (_req, res) => {
  try {
    const result = await fetchCryptoPrices();
    if (result.prices.length === 0) {
      res.status(502).json({ error: "Upstream price data unavailable" });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: "Failed to fetch crypto prices" });
  }
});

router.get("/crypto/ai-predict", async (req, res) => {
  const symbol =
    typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "";
  if (!symbol) {
    res.status(400).json({ error: "symbol query param required" });
    return;
  }
  // Serve the tracker's opening snap for free when available.
  // Pass ?force=1 to bypass and always call Claude fresh (e.g. manual Enhance).
  // Pass ?snaponly=1 to return 204 (not ready) instead of falling through to a
  // fresh Claude call — used by the predictor page's silent polling query so it
  // never triggers a second Claude call while waiting for the tracker snap.
  const force = req.query.force === "1";
  const snaponly = req.query.snaponly === "1";
  if (!force) {
    const snap = getTrackerWindowCall(symbol);
    if (snap) {
      const QUARTER_MS = 15 * 60_000;
      const nowMs = Date.now();
      const nextBoundaryMs = Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS;
      const minutesAhead = Math.max(1, Math.round((nextBoundaryMs - nowMs) / 60_000));
      res.json({
        coin: symbol,
        predictions: [{
          minutesAhead,
          predictedPrice: snap.predictedPrice,
          low: snap.predictedPrice,
          high: snap.predictedPrice,
          direction: snap.direction,
          confidence: snap.confidence,
        }],
        generatedAt: snap.snappedAt,
        source: "snap",
      });
      return;
    }
    if (snaponly) {
      res.status(204).end();
      return;
    }
  }
  try {
    const result = await fetchAIPredictions(symbol);
    res.json({ ...result, source: "live" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `AI prediction failed: ${msg}` });
  }
});

// ── AI mode settings ─────────────────────────────────────────────────────────

router.get("/crypto/ai-settings", (_req, res) => {
  res.json(getAiSettings());
});

router.post("/crypto/ai-settings/mode", (req, res) => {
  const { mode } = req.body as { mode?: string };
  if (mode !== "stat" && mode !== "claude") {
    res.status(400).json({ error: "mode must be 'stat' or 'claude'" });
    return;
  }
  setGlobalAiMode(mode);
  res.json({ ok: true, ...getAiSettings() });
});

router.post("/crypto/ai-settings/coin/:symbol", (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const { enabled } = req.body as { enabled?: boolean };
  setCoinClaudeEnabled(symbol, !!enabled);
  res.json({ ok: true, ...getAiSettings() });
});

// Self-consistency: number of independent Claude samples to aggregate per
// snapshot (1 = off). Clamped server-side to a safe range.
router.post("/crypto/ai-settings/self-consistency", (req, res) => {
  const { samples } = req.body as { samples?: number };
  if (typeof samples !== "number" || !Number.isFinite(samples)) {
    res.status(400).json({ error: "samples must be a number" });
    return;
  }
  const applied = setSelfConsistencySamples(samples);
  res.json({ ok: true, ...getAiSettings(), selfConsistencySamples: applied });
});

// Auto-pilot: when on, the system auto-enables Claude per coin where it beats the
// statistical model (with min-sample, hysteresis, and a global cap). Manual
// per-coin enable/disable keeps working alongside it.
router.post("/crypto/ai-settings/auto-pilot", (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  setAutoPilot(enabled);
  res.json({ ok: true, ...getAiSettings() });
});

// ── Prediction history ────────────────────────────────────────────────────────

router.get("/crypto/prediction-history/summary", (_req, res) => {
  const summary = CRYPTO_COINS.map(({ symbol }) => {
    const evaluated = getPredictionHistory(symbol).filter((r) => r.status === "evaluated");
    return {
      symbol,
      ...tally(evaluated),
      // Broken out by model so Claude's hit rate is visible separately from
      // the statistical model's.
      bySource: {
        stat: tally(evaluated.filter((r) => r.source === "stat")),
        claude: tally(evaluated.filter((r) => r.source === "claude")),
        // Ensemble hit-rate covers BET windows only; abstentions are excluded so
        // it's comparable to a model that always takes a position.
        ensemble: tally(
          evaluated.filter((r) => r.source === "ensemble" && r.abstained !== true),
        ),
        ml: tally(evaluated.filter((r) => r.source === "ml")),
      },
    };
  });
  res.json({ summary });
});

// Read-only self-learning analytics: per-coin accuracy / Brier / signed bias
// broken out by source and regime, plus the Claude confidence-reliability curve
// that drives calibration. Inspectable for tuning; powers the dashboard later.
router.get("/crypto/prediction-analytics", (_req, res) => {
  res.json({ analytics: getAllPredictionAnalytics() });
});

router.get("/crypto/prediction-history", (req, res) => {
  const symbol =
    typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "";
  if (!symbol) {
    res.status(400).json({ error: "symbol query param required" });
    return;
  }
  // One headline row per window (ensemble › Claude › stat › ml). Per-source hit
  // rates come from analytics; windowGroups gives all model records per window so
  // the frontend can show a per-model verdict strip on each history card.
  const analytics = getPredictionAnalytics(symbol);
  const allRecords = getPredictionHistory(symbol);
  const toSummary = (m: { n: number; hits: number; accuracyPct: number | null }) => ({
    hits: m.hits,
    total: m.n,
    pct: m.accuracyPct,
  });

  // ML accuracy computed directly from raw history (not in analytics rollup yet)
  const mlEvaluated = allRecords.filter((r) => r.source === "ml" && r.status === "evaluated");
  const mlHits = mlEvaluated.filter((r) => r.correct === true).length;

  // Group all records by window target time for history card per-model strip
  const windowMap = new Map<string, typeof allRecords>();
  for (const r of allRecords) {
    const arr = windowMap.get(r.targetTime) ?? [];
    arr.push(r);
    windowMap.set(r.targetTime, arr);
  }
  const sourceOrder: Record<string, number> = { ensemble: 3, claude: 2, stat: 1, ml: 0 };
  const windowGroups = [...windowMap.entries()]
    .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime())
    .slice(0, 30)
    .map(([targetTime, recs]) => ({
      targetTime,
      records: recs
        .slice()
        .sort((a, b) => (sourceOrder[b.source] ?? -1) - (sourceOrder[a.source] ?? -1)),
    }));

  res.json({
    symbol,
    history: getPredictionHeadlines(symbol),
    windowGroups,
    sourceSummary: {
      stat: toSummary(analytics.bySource.stat),
      claude: toSummary(analytics.bySource.claude),
      ensemble: toSummary(analytics.bySource.ensemble),
      ml: {
        hits: mlHits,
        total: mlEvaluated.length,
        pct: mlEvaluated.length > 0 ? Math.round((mlHits / mlEvaluated.length) * 100) : null,
      },
    },
    abstention: analytics.abstention,
    accuracyThresholdPct: ACCURACY_THRESHOLD_PCT,
  });
});

// ── Password guard for destructive log-clear operations ──────────────────────
function checkClearPassword(req: import("express").Request, res: import("express").Response): boolean {
  const expected = process.env.CLEAR_LOGS_PASSWORD;
  if (!expected) {
    res.status(503).json({ error: "Clear password not configured on server" });
    return false;
  }
  const provided = req.headers["x-clear-password"];
  if (provided !== expected) {
    res.status(401).json({ error: "Invalid password" });
    return false;
  }
  return true;
}

// Soft clear — removes only records older than 48 h. Recent training data,
// Best Windows, and auto-pilot accuracy stats remain untouched.
router.delete("/crypto/prediction-history/old", async (req, res) => {
  if (!checkClearPassword(req, res)) return;
  await clearPredictionHistoryOld();
  res.json({ ok: true });
});

// Accuracy-only clear — wipes ALL prediction records so accuracy stats restart
// from zero, but leaves ML snapshots and model weights completely untouched.
router.delete("/crypto/prediction-history/accuracy-only", async (req, res) => {
  if (!checkClearPassword(req, res)) return;
  await clearAccuracyLogsOnly();
  res.json({ ok: true });
});

// Full reset — wipes all prediction records, ML snapshots, and ML model weights.
router.delete("/crypto/prediction-history", async (req, res) => {
  if (!checkClearPassword(req, res)) return;
  await clearPredictionHistory();
  res.json({ ok: true });
});

// ── Statistical-model accuracy backtest ───────────────────────────────────────
// Replays historical candles and scores the live statistical model over many
// past 15-min windows. See lib/backtest.ts for the run/compare workflow.
//   GET /crypto/backtest?coins=BTC,ETH&windows=96&endTime=2026-06-26T12:00:00Z
router.get("/crypto/backtest", async (req, res) => {
  try {
    const coins =
      typeof req.query.coins === "string" && req.query.coins.length > 0
        ? req.query.coins.toUpperCase().split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
    const windows =
      req.query.windows != null ? parseInt(String(req.query.windows), 10) : undefined;
    let endTime: number | undefined;
    if (typeof req.query.endTime === "string" && req.query.endTime.length > 0) {
      const ms = new Date(req.query.endTime).getTime();
      if (!Number.isNaN(ms)) endTime = Math.floor(ms / 1000);
    }
    const report = await runBacktest({
      coins,
      windows: windows != null && !Number.isNaN(windows) ? windows : undefined,
      endTime,
    });
    res.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "backtest failed";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/backtest/threshold-analysis — run a backtest and show hit rates
// bucketed by pre-window efficiency ratio (0.05 steps). Use to check whether
// the hardcoded BET/STAY-AWAY ER thresholds still have real edge and to get
// data-derived threshold suggestions.
//   ?coins=BTC,ETH  ?windows=96  ?endTime=2026-06-26T12:00:00Z
router.get("/crypto/backtest/threshold-analysis", async (req, res) => {
  try {
    const coins =
      typeof req.query.coins === "string" && req.query.coins.length > 0
        ? req.query.coins.toUpperCase().split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
    const windows =
      req.query.windows != null ? parseInt(String(req.query.windows), 10) : undefined;
    let endTime: number | undefined;
    if (typeof req.query.endTime === "string" && req.query.endTime.length > 0) {
      const ms = new Date(req.query.endTime).getTime();
      if (!Number.isNaN(ms)) endTime = Math.floor(ms / 1000);
    }
    const report = await runThresholdAnalysis({
      coins,
      windows: windows != null && !Number.isNaN(windows) ? windows : undefined,
      endTime,
    });
    res.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "threshold analysis failed";
    res.status(500).json({ error: msg });
  }
});

// POST two backtest reports to get before/after deltas: { a: report, b: report }
router.post("/crypto/backtest/compare", (req, res) => {
  const { a, b } = (req.body ?? {}) as { a?: BacktestReport; b?: BacktestReport };
  const isReport = (r: unknown): r is BacktestReport =>
    !!r &&
    typeof r === "object" &&
    "overall" in r &&
    "byRegime" in r &&
    "byCoin" in r;
  if (!isReport(a) || !isReport(b)) {
    res.status(400).json({
      error: "body must include two full backtest reports: { a, b }",
    });
    return;
  }
  res.json(compareReports(a, b));
});

// ── Kalshi 15-min target (generic: BTC, ETH, XRP) ───────────────────────────
// Fetches the currently-active KX{SYMBOL}15M market and extracts the strike
// price set at window open. Per-symbol cache (15s TTL).

interface KalshiTargetPayload {
  available: boolean;
  targetPrice: number | null;
  ticker?: string;
  eventTicker?: string;
  closeTime?: string;
  openTime?: string;
  isLive?: boolean;
  yesBid?: number;
  yesAsk?: number;
  url?: string;
  minutesElapsed?: number;
  windowOpenPrice?: number | null;
}

// Kalshi market URL slugs for each supported symbol.
const KALSHI_URL_SLUGS: Record<string, { path: string; label: string }> = {
  BTC: { path: "kxbtc15m", label: "bitcoin-price-up-down" },
  ETH: { path: "kxeth15m", label: "ethereum-price-up-down" },
  XRP: { path: "kxxrp15m", label: "xrp-price-up-down" },
};

const kalshiRouteCache = new Map<string, { data: KalshiTargetPayload; fetchedAt: number }>();
// Normal TTL 15s; reduced to 5s near window boundaries (first/last 90s of each
// 15-min window) so new Kalshi markets are picked up within one poll cycle.
const KALSHI_TARGET_TTL_NORMAL = 15_000;
const KALSHI_TARGET_TTL_BOUNDARY = 5_000;

// Per-window Kalshi target cache for the ML prediction endpoint.
// Key: `${symbol}:${windowMs}` — automatically expires each 15-min boundary.
// Prevents "Awaiting window…" flicker when the Kalshi API returns a transient
// null (e.g. the new window's contract hasn't published yet for a few seconds).
const mlKalshiCache = new Map<string, { target: number; windowMs: number }>();

async function fetchKalshiTargetRoute(symbol: string): Promise<KalshiTargetPayload> {
  const series = KALSHI_SERIES[symbol];
  if (!series) return { available: false, targetPrice: null };

  const cached = kalshiRouteCache.get(symbol);
  const secIntoWin = Math.floor(Date.now() / 1_000) % (15 * 60);
  const nearBoundary = secIntoWin < 90 || secIntoWin > (15 * 60 - 90);
  const routeTTL = nearBoundary ? KALSHI_TARGET_TTL_BOUNDARY : KALSHI_TARGET_TTL_NORMAL;
  if (cached && Date.now() - cached.fetchedAt < routeTTL) {
    // If the cached market's close_time has already passed, the previous window
    // has expired — bypass the cache immediately so the new window's strike is
    // fetched instead of serving a stale target that would produce the wrong
    // ABOVE/BELOW direction for up to routeTTL seconds.
    const ct = cached.data.closeTime;
    if (!ct || new Date(ct).getTime() > Date.now()) return cached.data;
    // closeTime is in the past — fall through to re-fetch the current window.
  }

  const resp = await fetch(
    `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=open&limit=5`,
    { headers: { accept: "application/json" } },
  );
  if (!resp.ok) return { available: false, targetPrice: null };

  const body = (await resp.json()) as { markets?: Record<string, unknown>[] };
  let found: Record<string, unknown> | null = null;
  let targetPrice: number | null = null;
  for (const m of body.markets ?? []) {
    const strike = m.floor_strike as number | undefined;
    if (typeof strike === "number" && strike > 0) { found = m; targetPrice = strike; break; }
  }
  if (!found) {
    // Do NOT cache this result. The new window's market often takes 10-30 s
    // to be published after the boundary fires. Caching available:false for
    // KALSHI_TARGET_TTL would hide the Kalshi hub for the full TTL on every
    // window transition. Instead, let each frontend poll retry Kalshi directly
    // so the section reappears as soon as the market publishes.
    return { available: false, targetPrice: null };
  }

  const slugs = KALSHI_URL_SLUGS[symbol] ?? { path: series.toLowerCase(), label: "price-up-down" };
  const openTimeStr = found.open_time as string | undefined;
  let minutesElapsed: number | undefined;
  if (openTimeStr) {
    const openMs = new Date(openTimeStr).getTime();
    if (!isNaN(openMs)) {
      minutesElapsed = Math.max(0, Math.round((Date.now() - openMs) / 60_000));
    }
  }
  const winCtx = getKalshiWindowContext(symbol);
  const data: KalshiTargetPayload = {
    available: true,
    targetPrice,
    ticker: found.ticker as string,
    eventTicker: found.event_ticker as string,
    closeTime: found.close_time as string,
    openTime: openTimeStr,
    isLive: true,
    yesBid: parseFloat(found.yes_bid_dollars as string) || 0,
    yesAsk: parseFloat(found.yes_ask_dollars as string) || 0,
    url: `https://kalshi.com/markets/${slugs.path}/${slugs.label}/${found.event_ticker as string}`,
    minutesElapsed,
    windowOpenPrice: winCtx?.priceAtOpen,
  };
  kalshiRouteCache.set(symbol, { data, fetchedAt: Date.now() });
  return data;
}

// Live Kalshi ticker — all tracked coins in one call, read from in-memory cache.
// No Kalshi API calls are made here; data is as fresh as the conviction poller
// (≤1 s in conviction mode) or the 2 s pipeline cache in all other modes.
router.get("/crypto/kalshi-live", (_req, res) => {
  const coins = Object.keys(KALSHI_SERIES).map((sym) => {
    const entry = kalshiTargetCache.get(sym);
    const yesAsk = entry?.yesAsk ?? null;
    const yesBid = entry?.yesBid ?? null;
    const noAsk  = yesBid != null ? +(1 - yesBid).toFixed(4) : null;
    const returnIfYesPct =
      yesAsk != null && yesAsk > 0 && yesAsk < 1
        ? +((1 - yesAsk) / yesAsk * 100).toFixed(1)
        : null;
    const returnIfNoPct =
      noAsk != null && noAsk > 0 && noAsk < 1
        ? +((1 - noAsk) / noAsk * 100).toFixed(1)
        : null;
    return {
      sym,
      target:        entry?.value    ?? null,
      ticker:        entry?.ticker   ?? null,
      yesAsk,
      yesBid,
      yesPrice:      entry?.yesPrice ?? null,
      noAsk,
      noBid:         yesAsk != null ? +(1 - yesAsk).toFixed(4) : null,
      returnIfYesPct,
      returnIfNoPct,
      dataAgeMs:     entry ? Date.now() - entry.at : null,
      closeTime:     entry?.closeTime ?? null,
    };
  });
  res.json({ coins, serverTime: Date.now() });
});

// Generic endpoint: /crypto/kalshi-target?symbol=BTC|ETH|XRP
router.get("/crypto/kalshi-target", async (req, res) => {
  const symbol = typeof req.query.symbol === "string" ? req.query.symbol.toUpperCase() : "";
  if (!symbol || !KALSHI_SERIES[symbol]) {
    res.status(400).json({ available: false, error: "symbol must be BTC, ETH, or XRP" });
    return;
  }
  try {
    res.json(await fetchKalshiTargetRoute(symbol));
  } catch {
    res.status(500).json({ available: false, targetPrice: null });
  }
});

// Legacy BTC-only endpoint kept for backward compatibility.
router.get("/crypto/kalshi-btc-target", async (_req, res) => {
  try {
    res.json(await fetchKalshiTargetRoute("BTC"));
  } catch {
    res.status(500).json({ available: false });
  }
});

// ── Global AI spend level ─────────────────────────────────────────────────────

router.get("/crypto/ai-spend", (_req, res) => {
  const level = getAiSpendLevel();
  res.json({ level, stockAiEnabled: getStockAiEnabled(), labels: AI_SPEND_LABELS });
});

// Admin guard (same pattern as bot control routes): requires a signed-in
// Clerk user; if BOT_ADMIN_CLERK_USER_ID is set, only that user may mutate.
function requireAdmin(req: any, res: any, next: any) {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized — must be signed in to change AI spend" });
    return;
  }
  const adminId = process.env["BOT_ADMIN_CLERK_USER_ID"];
  if (adminId && auth.userId !== adminId) {
    res.status(403).json({ error: "Forbidden — not authorized to change AI spend" });
    return;
  }
  next();
}

router.post("/crypto/ai-spend", requireAdmin, (req, res) => {
  const { level, stockAiEnabled } = req.body as { level?: string; stockAiEnabled?: boolean };

  if (level !== undefined) {
    if (level !== "off" && level !== "eco" && level !== "balanced" && level !== "max") {
      res.status(400).json({ error: "level must be off | eco | balanced | max" });
      return;
    }
    setAiSpendLevel(level as AiSpendLevel);
  }

  if (stockAiEnabled !== undefined) {
    setStockAiEnabled(!!stockAiEnabled);
  }

  res.json({ ok: true, level: getAiSpendLevel(), stockAiEnabled: getStockAiEnabled(), labels: AI_SPEND_LABELS });
});

// Dedicated Claude call for the current Kalshi BTC window.
// Serves from the tracker's opening snap (free) when available;
// only falls back to a fresh Claude call if the snap hasn't fired yet.
router.get("/crypto/kalshi-btc-call", async (req, res) => {
  if (!isAiGloballyEnabled() || !isAiFeatureEnabled("crypto_btc_call")) {
    res.status(503).json({ error: "AI disabled at current spend level" });
    return;
  }

  const eventTicker = String(req.query.eventTicker ?? "");
  const rawTarget = parseFloat(String(req.query.target ?? ""));

  if (!eventTicker || isNaN(rawTarget)) {
    res.status(400).json({ error: "eventTicker and target query params required" });
    return;
  }

  // Prefer the tracker's already-computed opening snap — no new Claude call needed.
  const snap = getTrackerWindowCall("BTC");
  if (snap && snap.aboveKalshi !== null) {
    res.json({ above: snap.aboveKalshi, predictedPrice: snap.predictedPrice, confidence: snap.confidence });
    return;
  }

  try {
    const result = await fetchKalshiBtcCall(rawTarget, eventTicker);
    if (!result) {
      res.status(503).json({ error: "Claude call failed" });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: "Internal error" });
  }
});

// Claude's and stat model's opening calls for the current window, plus the
// Window Monitor bet/stay-away signal derived from the first 5 minutes.
// Free — reads from in-memory caches only, no new API call.
router.get("/crypto/tracker-snapshot/:symbol", (req, res) => {
  const symbol = (req.params.symbol ?? "").toUpperCase();
  const snap = getTrackerWindowCall(symbol);
  const statSnap = getStatWindowCall(symbol);
  const windowBetSignal = getWindowBetSignal(symbol);
  res.json({ snapshot: snap ?? null, statSnapshot: statSnap ?? null, windowBetSignal: windowBetSignal ?? null });
});

// Lightweight mid-window Claude re-check — fast binary ABOVE/BELOW call.
// Cached 5 min per coin. Pass ?force=1 to bypass the cache.
router.get("/crypto/live-direction/:symbol", async (req, res) => {
  const symbol = (req.params.symbol ?? "").toUpperCase();
  const force = req.query.force === "1";
  if (!CRYPTO_COINS.find((c) => c.symbol === symbol)) {
    res.status(404).json({ error: "Unknown symbol" });
    return;
  }
  try {
    const result = await fetchLiveDirection(symbol, force);
    if (!result) {
      res.status(503).json({ error: "Direction check unavailable" });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: "Internal error" });
  }
});

// Per-window ring buffer of Claude live-direction checks (max 5 per coin).
// Cleared automatically when the 15-min window rolls over.
// Returns an empty array if no calls have been recorded yet this window.
router.get("/crypto/live-direction-history/:symbol", (req, res) => {
  const symbol = (req.params.symbol ?? "").toUpperCase();
  if (!CRYPTO_COINS.find((c) => c.symbol === symbol)) {
    res.status(404).json({ error: "Unknown symbol" });
    return;
  }
  res.json({ symbol, history: getLiveDirectionHistory(symbol) });
});

// ── ML Model prediction ───────────────────────────────────────────────────────
// Returns the self-trained logistic-regression prediction for the current
// 15-min window.  When the model hasn't seen enough data (< 30 labeled windows)
// the response carries ready:false and no directional prediction.
router.get("/crypto/ml-prediction/:symbol", async (req, res) => {
  const symbol = (req.params.symbol ?? "").toUpperCase();
  const status  = getMLStatus(symbol);

  // Base response — always returned even when model isn't ready.
  const base = {
    symbol,
    above:       null as boolean | null,
    confidence:  null as number | null,
    prob:        null as number | null,
    ready:       status.ready,
    windows:     status.windows,
    samples:     status.samples,
    minWindows:  status.minWindows,
    valAccuracy: status.valAccuracy,
  };

  if (!status.ready) return res.json(base);
  if (!KALSHI_SERIES[symbol]) return res.json(base);

  // Need a cached coin snapshot for live features + a Kalshi target.
  const cached = getCachedPrediction(symbol);
  if (!cached) return res.json(base);

  // Compute the current window boundary and fetch with it so we bypass the
  // shared display cache — that cache can still hold the PREVIOUS window's
  // strike for up to ~15 s after the boundary fires, which would give the ML
  // model wrong features right when the new window opens.
  const now        = Date.now();
  const QUARTER_MS = 15 * 60_000;
  const windowMs   = Math.floor(now / QUARTER_MS) * QUARTER_MS;
  const nextBoundary = new Date(windowMs + QUARTER_MS);
  let kalshiTarget = await fetchKalshiTarget(symbol, nextBoundary).catch(() => null);
  if (kalshiTarget != null) {
    // Cache the successful fetch for this window boundary.
    mlKalshiCache.set(symbol, { target: kalshiTarget, windowMs });
  } else {
    // Fall back to the cached target if it belongs to the same window.
    // This suppresses "Awaiting window…" flicker from transient API failures
    // or the ~30s gap before a new Kalshi contract is published.
    const cached = mlKalshiCache.get(symbol);
    if (cached?.windowMs === windowMs) kalshiTarget = cached.target;
  }
  if (kalshiTarget == null) return res.json(base);

  // Elapsed fraction in the current 15-min window.
  const elapsed      = Math.min((now - windowMs) / QUARTER_MS, 1);
  const priceAtOpen  = getKalshiWindowContext(symbol)?.priceAtOpen ?? null;
  const features     = extractMLFeatures(cached, kalshiTarget, elapsed, priceAtOpen);
  const { prediction } = getMLPrediction(symbol, features);

  return res.json({
    ...base,
    above:      prediction?.above ?? null,
    confidence: prediction?.confidence ?? null,
    prob:       prediction?.prob ?? null,
  });
});

// ── Best-time-to-trade analytics ─────────────────────────────────────────────
// Aggregates training-coin history by ET hour-of-day and day-of-week so the
// user can see when the market is most predictable.
// Optional ?symbol=BTC to filter to a single training coin.
router.get("/crypto/trading-windows", async (req, res) => {
  const symbol =
    typeof req.query.symbol === "string" && req.query.symbol.length > 0
      ? req.query.symbol.toUpperCase()
      : undefined;
  try {
    res.json(await getTradingWindows(symbol));
  } catch (err) {
    res.status(500).json({ error: "Failed to compute trading windows" });
  }
});

// Intra-window timing analysis — per-symbol accuracy at 1,3,6,9,12-min marks.
// ?symbol=BTC restricts to one coin; omit for all coins.
// ?days=7 limits to last N calendar days (by evaluated_at); omit for all-time.
router.get("/crypto/timing-analysis", async (req, res) => {
  const symbol =
    typeof req.query.symbol === "string" && req.query.symbol.length > 0
      ? req.query.symbol.toUpperCase()
      : undefined;
  const daysRaw = typeof req.query.days === "string" ? Number(req.query.days) : NaN;
  const days = isNaN(daysRaw) || daysRaw <= 0 ? undefined : daysRaw;
  try {
    const rows = await getTimingAnalysis(symbol, days);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch timing analysis" });
  }
});

// Window Monitor accuracy stats for a single coin over the last N days.
// Returns per-recommendation counts and accuracy ratios.
router.get("/crypto/window-monitor-accuracy/:symbol", async (req, res) => {
  const symbol = (req.params.symbol ?? "").toUpperCase();
  if (!CRYPTO_COINS.find((c) => c.symbol === symbol)) {
    res.status(404).json({ error: "Unknown symbol" });
    return;
  }
  try {
    const days = Number(req.query.days ?? 7);
    const stats = await getWindowMonitorAccuracy(symbol, isNaN(days) ? 7 : days);
    res.json(stats);
  } catch {
    res.status(500).json({ error: "Failed to fetch window monitor accuracy" });
  }
});

// ── Entry proximity calibration ───────────────────────────────────────────────
// Derives per-coin, per-phase proximity thresholds from window_timing_snapshots.
// That table records currentPrice + kalshiTarget at minuteMark seconds into
// each 15-min window (marks: 60, 180, 360, 540, 720 = T+1, T+3, T+6, T+9, T+12),
// giving 5 unbiased intra-window price-vs-strike samples per coin per window —
// not selection-biased by which windows the bot entered.
//
// Phase split: marks where (15min − minuteMark/60) ≤ lateWindowMinutes are "late".
// Threshold = multiplier × stdDev of distancePct per phase.
// A bet is skipped when its distancePct < threshold (price is in the near-strike tail).
// POST body: { lateWindowMinutes?: number (default 7), days?: number (default 60), multiplier?: number (default 1.5) }
router.post("/crypto/bot/calibrate-proximity", async (req, res) => {
  const { lateWindowMinutes = 7, days = 60, multiplier = 1.5 } = (req.body ?? {}) as {
    lateWindowMinutes?: number;
    days?: number;
    multiplier?: number;
  };
  const lateWinMins  = Math.max(1, Math.min(14, Number(lateWindowMinutes) || 7));
  const lookbackDays = Math.max(1, Math.min(365, Number(days) || 60));
  const sdMultiplier = Math.max(0.5, Math.min(4, Number(multiplier) || 1.5));
  // A phase bucket with fewer than this many samples gets suggested=null (too little data).
  const MIN_SAMPLES  = 10;
  // lateWindowMins maps to minuteMark threshold in seconds: marks >= this are "late".
  const lateMarkS = (15 - lateWinMins) * 60; // e.g. lateWinMins=7 → 8min*60=480s

  try {
    const { db, windowTimingSnapshotsTable } = await import("@workspace/db");
    const { and, isNotNull, sql: drizzleSql } = await import("drizzle-orm");

    // window_timing_snapshots has multiple rows per coin per window (one per
    // minuteMark), recorded at regular 15-min snap intervals.  This is the
    // correct unbiased source for calibrating how far the price sits from the
    // strike at early vs late points within a window.
    const rows = await db
      .select({
        symbol:       windowTimingSnapshotsTable.symbol,
        minuteMark:   windowTimingSnapshotsTable.minuteMark,
        kalshiTarget: windowTimingSnapshotsTable.kalshiTarget,
        currentPrice: windowTimingSnapshotsTable.currentPrice,
      })
      .from(windowTimingSnapshotsTable)
      .where(
        and(
          isNotNull(windowTimingSnapshotsTable.kalshiTarget),
          isNotNull(windowTimingSnapshotsTable.currentPrice),
          drizzleSql`${windowTimingSnapshotsTable.windowKey} >= to_char(NOW() - (${lookbackDays} || ' days')::interval, 'YYYY-MM-DD"T"HH24:MI')`,
        ),
      )
      .limit(50000);

    type PhaseData = { distances: number[] };
    const bySymbol = new Map<string, { early: PhaseData; late: PhaseData }>();

    for (const row of rows) {
      const sym = row.symbol ?? "";
      if (!sym) continue;
      const target = parseFloat(String(row.kalshiTarget));
      const price  = parseFloat(String(row.currentPrice));
      if (!isFinite(target) || target <= 0 || !isFinite(price) || price <= 0) continue;

      const distancePct = Math.abs(price - target) / target * 100;
      const mark = row.minuteMark ?? 0; // seconds into window
      const isLate = mark >= lateMarkS;

      if (!bySymbol.has(sym)) {
        bySymbol.set(sym, { early: { distances: [] }, late: { distances: [] } });
      }
      const bucket = bySymbol.get(sym)!;
      if (isLate) {
        bucket.late.distances.push(distancePct);
      } else {
        bucket.early.distances.push(distancePct);
      }
    }

    function stdDev(values: number[]): number {
      if (values.length < 2) return 0;
      const mean     = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
      return Math.sqrt(variance);
    }

    function summarize(d: PhaseData) {
      const n = d.distances.length;
      if (n === 0) return { n: 0, mean: null, stdDev: null, suggested: null };
      const mean = d.distances.reduce((a, b) => a + b, 0) / n;
      const sd   = stdDev(d.distances);
      // threshold = multiplier × stdDev.  A bet is blocked when distancePct < threshold,
      // i.e. the lower sdMultiplier std devs of the distribution.  If sample count is
      // too low to be reliable, return null so the UI shows "—" instead of guessing.
      const suggested = n >= MIN_SAMPLES
        ? parseFloat((sdMultiplier * sd).toFixed(3))
        : null;
      return { n, mean: parseFloat(mean.toFixed(4)), stdDev: parseFloat(sd.toFixed(4)), suggested };
    }

    const result: Record<string, { early: ReturnType<typeof summarize>; late: ReturnType<typeof summarize> }> = {};
    for (const [sym, data] of bySymbol) {
      result[sym] = { early: summarize(data.early), late: summarize(data.late) };
    }

    res.json({ ok: true, lateWindowMinutes: lateWinMins, lookbackDays, multiplier: sdMultiplier, minSamples: MIN_SAMPLES, bySym: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "calibration failed";
    res.status(500).json({ error: msg });
  }
});

// Bot entry timing analytics — composite ML Gate direction accuracy per minute (0–14).
// ?coin=BTC restricts to one coin; ?days=30 limits to last N days; ?mode=paper|live.
router.get("/crypto/bot/entry-timing", async (req, res) => {
  const coin = typeof req.query.coin === "string" && req.query.coin.length > 0
    ? req.query.coin.toUpperCase() : null;
  const daysRaw = typeof req.query.days === "string" ? Number(req.query.days) : NaN;
  const days = isNaN(daysRaw) || daysRaw <= 0 ? null : daysRaw;
  const mode = typeof req.query.mode === "string" && req.query.mode.length > 0
    ? req.query.mode : null;
  try {
    const rows = await getBotEntryTimingAnalysis(coin, days, mode);
    res.json(rows);
  } catch {
    res.status(500).json({ error: "Failed to fetch bot entry timing analysis" });
  }
});

export default router;
