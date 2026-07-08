import { Router } from "express";
import { getAuth } from "@clerk/express";
import { BET_PROFILES, isLiveModePermitted, type BetProfile } from "../lib/kalshi-bot-engine";
import { isKalshiConfigured, getCachedKalshiBalance } from "../lib/kalshi-trader";
import {
  getBotState,
  setBotMode,
  setBotPaused,
  updateBotConfig,
  getBotHistory,
  getBotAllHistory,
  getBotStats,
  getBotTrend,
  getWindowEvaluation,
  getPerformanceReport,
  getBotAutoTuneLog,
  getPausedCoinState,
  clearBetHistoryOld,
  getBotLogicPerformance,
  getBacktestModes,
  clearAllPauses,
  getCoinGuardState,
  placeManualOrder,
  closeManualPosition,
  getWindowConditions,
  resetWindowConditions,
  reEvaluateSettledBets,
} from "../lib/kalshi-bot";
import type { BotMode } from "../lib/kalshi-bot";
import type { BotConfig, DecisionMode } from "../lib/kalshi-bot-engine-core";
import { getAllMLStatus } from "../lib/ml-store";
import { getAllPipelineResults, getInFlightDetails } from "../lib/kalshi-bot-pipeline";
import { getLatestCoinSignals } from "../lib/crypto-signals";
import { db, botConfigTable, kalshiBotBetsTable, botAutoTuneLogTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

// ── Decision-mode preset helpers ──────────────────────────────────────────────

const PRESET_ROW_ID = "mode_presets";

async function readModePresets(): Promise<Partial<Record<DecisionMode, Partial<BotConfig>>>> {
  try {
    const rows = await db.select().from(botConfigTable).where(eq(botConfigTable.id, PRESET_ROW_ID)).limit(1);
    if (rows.length > 0) {
      const cfg = rows[0].config as { presets?: Partial<Record<DecisionMode, Partial<BotConfig>>> } | null;
      return cfg?.presets ?? {};
    }
  } catch { /* non-fatal */ }
  return {};
}

async function writeModePreset(mode: DecisionMode, config: Partial<BotConfig>): Promise<void> {
  const existing = await readModePresets();
  const updated = { ...existing, [mode]: config };
  await db
    .insert(botConfigTable)
    .values({ id: PRESET_ROW_ID, config: { presets: updated } as Record<string, unknown>, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: botConfigTable.id,
      set: { config: { presets: updated } as Record<string, unknown>, updatedAt: new Date() },
    });
}

const router = Router();

// Bot admin guard.
// Requires an authenticated Clerk user. If the BOT_ADMIN_CLERK_USER_ID
// environment variable is set (a Clerk user_XXXX ID), only that specific user
// may mutate bot state — preventing any other signed-in user from toggling
// live mode or changing config in a multi-tenant deployment.
// When unset, any authenticated user is allowed (single-user / dev mode).
function requireAuth(req: any, res: any, next: any) {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized — must be signed in to control the bot" });
    return;
  }
  const adminId = process.env["BOT_ADMIN_CLERK_USER_ID"];
  if (adminId && auth.userId !== adminId) {
    res.status(403).json({ error: "Forbidden — not authorized to control the bot" });
    return;
  }
  next();
}

// GET /crypto/bot/pipeline-status (and alias /bot/pipeline-status) —
// Current per-coin pipeline results for the current window (public — read only)
function pipelineStatusHandler(_req: any, res: any) {
  try {
    const allResults = getAllPipelineResults();
    const inFlightDetails = getInFlightDetails();

    // Determine current window from BOTH completed results and in-flight entries
    // so we correctly identify the window even when all results were pruned and
    // only in-flight entries remain (transition edge case).
    const allWindowKeys = [
      ...allResults.map(r => r.windowKey),
      ...inFlightDetails.map(e => e.windowKey),
    ];
    const currentWindowKey = allWindowKeys.length > 0
      ? allWindowKeys.reduce((best, wk) => (wk > best ? wk : best), allWindowKeys[0])
      : null;

    // Scope both results and in-flight to the current window only
    const results = currentWindowKey
      ? allResults.filter(r => r.windowKey === currentWindowKey)
      : allResults;
    const inFlight = currentWindowKey
      ? inFlightDetails.filter(e => e.windowKey === currentWindowKey)
      : inFlightDetails;

    // Legacy field for any consumers that haven't updated yet
    const inFlightSyms = inFlight.map(e => e.sym);

    // Live unified signals — sourced from the same predictor-layer functions as
    // the Crypto Predictor page so stat/claude/ml always match what the page shows.
    // Keyed by symbol for all coins in the current window (completed + in-flight).
    const allSyms = Array.from(new Set([
      ...results.map(r => r.sym),
      ...inFlight.map(e => e.sym),
    ]));
    const liveSignals = Object.fromEntries(allSyms.map(sym => [sym, getLatestCoinSignals(sym)]));

    res.json({ results, inFlight, inFlightSyms, windowKey: currentWindowKey, liveSignals });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
}

router.get("/crypto/bot/pipeline-status", pipelineStatusHandler);
// Alias matching the task spec path
router.get("/bot/pipeline-status", pipelineStatusHandler);

// GET /crypto/bot/coin-guard-state?mode=paper|live — per-coin streak / daily-loss / slippage state (public — read only)
router.get("/crypto/bot/coin-guard-state", (req, res) => {
  try {
    const rawMode = req.query.mode;
    const filterMode: BotMode =
      rawMode === "paper" || rawMode === "live" ? rawMode : getBotState().mode;
    res.json(getCoinGuardState(filterMode));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/status — full bot state (public — read only)
router.get("/crypto/bot/status", (_req, res) => {
  try {
    const allML = getAllMLStatus();
    const readyCount = allML.filter(s => s.ready).length;
    const mlStatus = {
      ready: allML.length > 0 && allML.every(s => s.ready),
      readyCount,
      totalCount: allML.length,
      minWindows: allML.length > 0 ? Math.min(...allML.map(s => s.windows)) : 0,
      minRequired: 30,
    };
    res.json({ ...getBotState(), mlStatus });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/mode  { mode: "paper" | "live" }
router.post("/crypto/bot/mode", requireAuth, (req, res) => {
  const { mode } = req.body as { mode?: string };
  if (mode !== "paper" && mode !== "live") {
    res.status(400).json({ error: "mode must be 'paper' or 'live'" });
    return;
  }
  // Guard live-mode requests in non-production before calling setBotMode so the
  // caller gets a 403 (forbidden here) rather than a generic 400 (bad input).
  if (mode === "live" && !isLiveModePermitted(process.env.NODE_ENV)) {
    res.status(403).json({ error: "Live betting is only available in the production deployment." });
    return;
  }
  try {
    setBotMode(mode as BotMode);
    res.json({ ok: true, ...getBotState() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(400).json({ error: msg });
  }
});

// POST /crypto/bot/pause  { paused: boolean }
router.post("/crypto/bot/pause", requireAuth, (req, res) => {
  const { paused } = req.body as { paused?: boolean };
  if (typeof paused !== "boolean") {
    res.status(400).json({ error: "paused must be a boolean" });
    return;
  }
  setBotPaused(paused);
  res.json({ ok: true, ...getBotState() });
});

// POST /crypto/bot/config  — update one or more config fields
router.post("/crypto/bot/config", requireAuth, async (req, res) => {
  const {
    betSize,
    dailyLossLimit,
    signalThreshold,
    minConfidence,
    decisionMode,
    midExitSensitivity,
    phase2ThresholdPp,
    maxEntryMinutes,
    minRemainingMinutes,
    windowEntryBufferSeconds,
    maxBetsPerWindow,
    enabled,
    quietHoursStart,
    quietHoursEnd,
    maxConsecutiveLosses,
    circuitBreakerPauseWindows,
    enableDirectionCap,
    maxSameDirectionBets,
    enableMomentumFilter,
    momentumWindowCount,
    enableAutoTuning,
    autoTuneWindowSize,
    enableBorderGuard,
    borderProximityPct,
    borderLookbackBets,
    regimePenalty,
    mlVetoMinConfidence,
    betProfile,
    paperStartingBalance,
    paperWinReturnRate,
    paperBalanceResetAt,
    maxBetSize,
    minAccountBalance,
    maxTotalExposure,
    maxDailyLossPerCoin,
    coinStreakLossLimit,
    coinStreakPauseWindows,
    maxSlippageCents,
    minReturnMultiple,
    requireMonitorReady,
    enableDynamicSizing,
    dynamicSizingMaxConfidence,
    profitLockPct,
    consensusMinCents,
    momentumLookbackCandles,
  } = req.body as {
    betSize?: number;
    dailyLossLimit?: number;
    signalThreshold?: number;
    minConfidence?: number;
    decisionMode?: string;
    midExitSensitivity?: "conservative" | "balanced" | "aggressive";
    phase2ThresholdPp?: number;
    maxEntryMinutes?: number;
    minRemainingMinutes?: number;
    windowEntryBufferSeconds?: number;
    maxBetsPerWindow?: number;
    enabled?: boolean;
    quietHoursStart?: number;
    quietHoursEnd?: number;
    maxConsecutiveLosses?: number;
    circuitBreakerPauseWindows?: number;
    enableDirectionCap?: boolean;
    maxSameDirectionBets?: number;
    enableMomentumFilter?: boolean;
    momentumWindowCount?: number;
    enableAutoTuning?: boolean;
    autoTuneWindowSize?: number;
    enableBorderGuard?: boolean;
    borderProximityPct?: number;
    borderLookbackBets?: number;
    regimePenalty?: number;
    mlVetoMinConfidence?: number;
    betProfile?: "normal" | "aggressive";
    paperStartingBalance?: number;
    paperWinReturnRate?: number;
    paperBalanceResetAt?: string | null;
    maxBetSize?: number;
    minAccountBalance?: number;
    maxTotalExposure?: number;
    maxDailyLossPerCoin?: number;
    coinStreakLossLimit?: number;
    coinStreakPauseWindows?: number;
    maxSlippageCents?: number;
    minReturnMultiple?: number;
    requireMonitorReady?: boolean;
    enableDynamicSizing?: boolean;
    dynamicSizingMaxConfidence?: number;
    profitLockPct?: number;
    consensusMinCents?: number;
    momentumLookbackCandles?: number;
  };

  const partial: Parameters<typeof updateBotConfig>[0] = {};
  if (typeof betSize === "number" && betSize >= 0.5 && betSize <= 25) partial.betSize = betSize;
  if (typeof dailyLossLimit === "number" && dailyLossLimit > 0) partial.dailyLossLimit = dailyLossLimit;
  if (typeof signalThreshold === "number" && [2, 3, 4].includes(signalThreshold)) {
    partial.signalThreshold = signalThreshold;
  }
  if (typeof minConfidence === "number" && minConfidence >= 40 && minConfidence <= 100) {
    partial.minConfidence = minConfidence;
  }
  if (decisionMode === "classic" || decisionMode === "ml_gate" || decisionMode === "consensus" || decisionMode === "unanimous") {
    // When switching modes: auto-load the saved preset for the new mode (if any),
    // then apply any explicit overrides from this request on top.
    const presets = await readModePresets();
    const modePreset = presets[decisionMode as DecisionMode];
    if (modePreset) {
      Object.assign(partial, modePreset);
    } else if (decisionMode === "ml_gate" && typeof minConfidence !== "number") {
      // No saved ml_gate preset and no explicit minConfidence: apply a sensible
      // default of 62% — lower than the classic 65% since ML validates each bet.
      partial.minConfidence = 62;
    }
    partial.decisionMode = decisionMode;
  }
  if (
    midExitSensitivity === "conservative" ||
    midExitSensitivity === "balanced" ||
    midExitSensitivity === "aggressive"
  ) {
    partial.midExitSensitivity = midExitSensitivity;
  }
  if (typeof phase2ThresholdPp === "number" && phase2ThresholdPp >= 10 && phase2ThresholdPp <= 50) {
    partial.phase2ThresholdPp = phase2ThresholdPp;
  }
  if (typeof maxEntryMinutes === "number" && maxEntryMinutes >= 0 && maxEntryMinutes <= 13) {
    partial.maxEntryMinutes = maxEntryMinutes;
  }
  if (typeof minRemainingMinutes === "number" && minRemainingMinutes >= 0 && minRemainingMinutes <= 7) {
    partial.minRemainingMinutes = minRemainingMinutes;
  }
  if (typeof windowEntryBufferSeconds === "number" && windowEntryBufferSeconds >= 0 && windowEntryBufferSeconds <= 300) {
    partial.windowEntryBufferSeconds = windowEntryBufferSeconds;
  }
  if (typeof maxBetsPerWindow === "number" && maxBetsPerWindow >= 1 && maxBetsPerWindow <= 10) {
    partial.maxBetsPerWindow = maxBetsPerWindow;
  }
  if (typeof enabled === "boolean") partial.enabled = enabled;
  if (typeof quietHoursStart === "number" && quietHoursStart >= 0 && quietHoursStart <= 23) {
    partial.quietHoursStart = quietHoursStart;
  }
  if (typeof quietHoursEnd === "number" && quietHoursEnd >= 0 && quietHoursEnd <= 23) {
    partial.quietHoursEnd = quietHoursEnd;
  }
  if (typeof maxConsecutiveLosses === "number" && maxConsecutiveLosses >= 0 && maxConsecutiveLosses <= 10) {
    partial.maxConsecutiveLosses = maxConsecutiveLosses;
  }
  if (typeof circuitBreakerPauseWindows === "number" && circuitBreakerPauseWindows >= 0 && circuitBreakerPauseWindows <= 20) {
    partial.circuitBreakerPauseWindows = circuitBreakerPauseWindows;
  }
  if (typeof enableDirectionCap === "boolean") partial.enableDirectionCap = enableDirectionCap;
  if (typeof maxSameDirectionBets === "number" && maxSameDirectionBets >= 1 && maxSameDirectionBets <= 10) {
    partial.maxSameDirectionBets = maxSameDirectionBets;
  }
  if (typeof enableMomentumFilter === "boolean") partial.enableMomentumFilter = enableMomentumFilter;
  if (typeof momentumWindowCount === "number" && momentumWindowCount >= 2 && momentumWindowCount <= 8) {
    partial.momentumWindowCount = momentumWindowCount;
  }
  if (typeof enableAutoTuning === "boolean") partial.enableAutoTuning = enableAutoTuning;
  if (typeof autoTuneWindowSize === "number" && autoTuneWindowSize >= 20 && autoTuneWindowSize <= 500) {
    partial.autoTuneWindowSize = autoTuneWindowSize;
  }
  if (typeof enableBorderGuard === "boolean") partial.enableBorderGuard = enableBorderGuard;
  if (typeof borderProximityPct === "number" && borderProximityPct >= 0.05 && borderProximityPct <= 2.0) {
    partial.borderProximityPct = borderProximityPct;
  }
  if (typeof borderLookbackBets === "number" && borderLookbackBets >= 1 && borderLookbackBets <= 10) {
    partial.borderLookbackBets = borderLookbackBets;
  }
  if (typeof regimePenalty === "number" && regimePenalty >= 0 && regimePenalty <= 20) {
    partial.regimePenalty = regimePenalty;
  }
  if (typeof mlVetoMinConfidence === "number" && mlVetoMinConfidence >= 50 && mlVetoMinConfidence <= 70) {
    partial.mlVetoMinConfidence = mlVetoMinConfidence;
  }
  if (betProfile === "normal" || betProfile === "aggressive") {
    partial.betProfile = betProfile;
    // Auto-sync regimePenalty to the profile's preset unless the caller also
    // explicitly provided a regimePenalty override in the same request.
    if (typeof regimePenalty !== "number") {
      partial.regimePenalty = BET_PROFILES[betProfile].regimePenalty;
    }
  }
  if (typeof paperStartingBalance === "number" && paperStartingBalance >= 1 && paperStartingBalance <= 10000) {
    partial.paperStartingBalance = paperStartingBalance;
  }
  if (typeof paperWinReturnRate === "number" && paperWinReturnRate >= 0.1 && paperWinReturnRate <= 2.0) {
    partial.paperWinReturnRate = paperWinReturnRate;
  }
  if ("paperBalanceResetAt" in req.body) {
    partial.paperBalanceResetAt = typeof paperBalanceResetAt === "string" ? paperBalanceResetAt : null;
  }
  // Live-mode safety guards
  if (typeof maxBetSize === "number" && maxBetSize >= 0.5 && maxBetSize <= 100) partial.maxBetSize = maxBetSize;
  if (typeof minAccountBalance === "number" && minAccountBalance >= 0 && minAccountBalance <= 1000) partial.minAccountBalance = minAccountBalance;
  if (typeof maxTotalExposure === "number" && maxTotalExposure >= 0 && maxTotalExposure <= 500) partial.maxTotalExposure = maxTotalExposure;
  if (typeof maxDailyLossPerCoin === "number" && maxDailyLossPerCoin >= 0 && maxDailyLossPerCoin <= 100) partial.maxDailyLossPerCoin = maxDailyLossPerCoin;
  if (typeof coinStreakLossLimit === "number" && coinStreakLossLimit >= 0 && coinStreakLossLimit <= 10) partial.coinStreakLossLimit = coinStreakLossLimit;
  if (typeof coinStreakPauseWindows === "number" && coinStreakPauseWindows >= 1 && coinStreakPauseWindows <= 10) partial.coinStreakPauseWindows = coinStreakPauseWindows;
  if (typeof maxSlippageCents === "number" && maxSlippageCents >= 0 && maxSlippageCents <= 50) partial.maxSlippageCents = maxSlippageCents;
  if (typeof minReturnMultiple === "number" && minReturnMultiple >= 1 && minReturnMultiple <= 10) partial.minReturnMultiple = minReturnMultiple;
  if (typeof requireMonitorReady === "boolean") partial.requireMonitorReady = requireMonitorReady;
  // Confidence-based dynamic bet sizing
  if (typeof enableDynamicSizing === "boolean") partial.enableDynamicSizing = enableDynamicSizing;
  if (typeof dynamicSizingMaxConfidence === "number" && dynamicSizingMaxConfidence >= 50 && dynamicSizingMaxConfidence <= 100) {
    partial.dynamicSizingMaxConfidence = dynamicSizingMaxConfidence;
  }
  if (typeof profitLockPct === "number" && profitLockPct >= 0 && profitLockPct <= 99) {
    partial.profitLockPct = profitLockPct;
  }
  // Entry safety gate thresholds
  if (typeof consensusMinCents === "number" && consensusMinCents >= 0 && consensusMinCents <= 50) {
    partial.consensusMinCents = consensusMinCents;
  }
  if (typeof momentumLookbackCandles === "number" && momentumLookbackCandles >= 4 && momentumLookbackCandles <= 12) {
    partial.momentumLookbackCandles = momentumLookbackCandles;
  }

  const { config: updated, persisted } = await updateBotConfig(partial);
  res.json({ ok: true, config: updated, persisted });
});

// GET /crypto/bot/kalshi-preflight — pre-switch balance verification (auth required)
// Called by the pre-live checklist BEFORE the user switches to live mode.
// No mode guard — checks Kalshi API reachability and account balance regardless
// of current bot mode so the checklist can show a real green/red state.
router.get("/crypto/bot/kalshi-preflight", requireAuth, async (_req, res) => {
  try {
    const configured = isKalshiConfigured();
    if (!configured) {
      res.json({ configured: false, balance: null, ok: false });
      return;
    }
    const balance = await getCachedKalshiBalance();
    res.json({ configured: true, balance, ok: true });
  } catch {
    res.json({ configured: true, balance: null, ok: false });
  }
});

// GET /crypto/bot/kalshi-balance — live Kalshi account balance
// Returns ok:false unless the bot is in live mode and Kalshi is configured.
// Used by the live balance header badge (mode-guarded per spec).
router.get("/crypto/bot/kalshi-balance", async (_req, res) => {
  try {
    const { mode } = getBotState();
    if (mode !== "live") {
      res.json({ balance: null, ok: false, reason: "not_live" });
      return;
    }
    if (!isKalshiConfigured()) {
      res.json({ balance: null, ok: false, reason: "not_configured" });
      return;
    }
    const balance = await getCachedKalshiBalance();
    res.json({ balance, ok: true });
  } catch {
    res.json({ balance: null, ok: false, reason: "api_error" });
  }
});

// GET /crypto/bot/history?limit=20&mode=paper|live (public — read only, terminal outcomes only)
router.get("/crypto/bot/history", async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
  const rawMode = req.query.mode;
  const filterMode: BotMode =
    rawMode === "paper" || rawMode === "live" ? rawMode : getBotState().mode;
  const resetAt = filterMode === "live" ? (getBotState().config.liveStatsResetAt ?? null) : null;
  try {
    const history = await getBotHistory(limit, filterMode, resetAt);
    res.json({ history });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/all-history?limit=100&offset=0&mode=paper|live (public — all records for dashboard)
router.get("/crypto/bot/all-history", async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10) || 100));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  const mode = req.query.mode === "paper" || req.query.mode === "live" ? req.query.mode as BotMode : undefined;
  const resetAt = mode === "live" ? (getBotState().config.liveStatsResetAt ?? null) : null;
  try {
    const history = await getBotAllHistory(limit, offset, mode, resetAt);
    res.json({ history });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/stats?symbol=BTC&mode=paper|live (public — read only)
router.get("/crypto/bot/stats", async (req, res) => {
  const symbol = typeof req.query.symbol === "string" && req.query.symbol.trim()
    ? req.query.symbol.trim()
    : undefined;
  const mode = req.query.mode === "paper" || req.query.mode === "live" ? req.query.mode as BotMode : undefined;
  const resetAt = mode === "live" ? (getBotState().config.liveStatsResetAt ?? null) : null;
  try {
    const stats = await getBotStats(symbol, mode, resetAt);
    res.json(stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/trend?limit=50&mode=paper|live — chronological win/loss sequence with rolling win rate
router.get("/crypto/bot/trend", async (req, res) => {
  const limit = Math.min(100, Math.max(2, parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const mode = req.query.mode === "paper" || req.query.mode === "live" ? req.query.mode as BotMode : undefined;
  const resetAt = mode === "live" ? (getBotState().config.liveStatsResetAt ?? null) : null;
  try {
    const points = await getBotTrend(limit, mode, resetAt);
    res.json(points);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/window-eval (public — last market evaluation results)
// Response: { evaluation, signals }
//   evaluation — bot decision per coin (action/confidence/reason) from last Phase-3 run
//   signals    — current unified predictor signals per coin (stat/claude/ml/wm),
//                derived from getLatestCoinSignals so they always match the Crypto
//                Predictor page — no pipelineResults divergence.
router.get("/crypto/bot/window-eval", (_req, res) => {
  try {
    const evaluation = getWindowEvaluation();
    // Build unified signal map for each coin that appeared in the last evaluation.
    // getLatestCoinSignals reads from the same sources as the predictor page, so
    // the bot dashboard and predictor page always display identical values.
    const signals: Record<string, ReturnType<typeof getLatestCoinSignals>> = {};
    for (const row of evaluation) {
      try {
        signals[row.symbol] = getLatestCoinSignals(row.symbol);
      } catch {
        // non-fatal — skip signal enrichment for this coin
      }
    }
    res.json({ evaluation, signals });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/performance-report?mode=paper|live — latest cached analytics report (public)
router.get("/crypto/bot/performance-report", (req, res) => {
  try {
    const rawMode = req.query.mode;
    const filterMode: BotMode =
      rawMode === "paper" || rawMode === "live" ? rawMode : getBotState().mode;
    const report = getPerformanceReport(filterMode);
    res.json({ report, pausedCoins: getPausedCoinState() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/auto-tune-log?limit=20 — recent auto-tune mutations (public)
router.get("/crypto/bot/auto-tune-log", async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
  try {
    const entries = await getBotAutoTuneLog(limit);
    res.json({ entries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/logic-performance — per-decision-mode win/loss/accuracy stats (public)
router.get("/crypto/bot/logic-performance", async (req, res) => {
  try {
    const rawMode = req.query.mode;
    const filterMode: "paper" | "live" | undefined =
      rawMode === "paper" || rawMode === "live" ? rawMode : undefined;
    const modes = await getBotLogicPerformance(filterMode);
    res.json({ modes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/backtest-modes — replay settled bets through each mode's logic (public)
router.get("/crypto/bot/backtest-modes", async (_req, res) => {
  try {
    const modes = await getBacktestModes();
    res.json({ modes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/manual-order — place a single order immediately from the dashboard
// Accepts { symbol, direction: "yes"|"no", betSize?, mode? }
// Uses the same live-ask fill logic as the automated bot (Task #242).
router.post("/crypto/bot/manual-order", requireAuth, async (req, res) => {
  const { symbol, direction, betSize, mode } = req.body as {
    symbol?: string;
    direction?: string;
    betSize?: number;
    mode?: string;
  };

  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  if (direction !== "yes" && direction !== "no") {
    res.status(400).json({ error: "direction must be 'yes' or 'no'" });
    return;
  }
  if (betSize !== undefined && (typeof betSize !== "number" || betSize <= 0)) {
    res.status(400).json({ error: "betSize must be a positive number" });
    return;
  }
  const resolvedMode = mode === "paper" || mode === "live" ? mode : undefined;
  // Live manual orders are only permitted in production
  if (resolvedMode === "live" && !isLiveModePermitted(process.env.NODE_ENV)) {
    res.status(403).json({ error: "Live orders are only available in the production deployment." });
    return;
  }

  try {
    const result = await placeManualOrder({
      symbol,
      direction,
      betSize,
      mode: resolvedMode,
    });
    // Invalidate any internal caches that the next status poll depends on
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    // 400 for business-rule rejections (open position, insufficient funds, etc.)
    res.status(400).json({ error: msg });
  }
});

// POST /crypto/bot/close-manual-position — close a manually-placed position early.
// Only works on positions with source="manual"; bot-opened positions must be
// managed by the automated engine.
router.post("/crypto/bot/close-manual-position", requireAuth, async (req, res) => {
  const { symbol } = req.body as { symbol?: string };
  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  try {
    const result = await closeManualPosition(symbol);
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(400).json({ error: msg });
  }
});

// POST /crypto/bot/clear-pauses — immediately clear all per-coin auto-tune pauses
// and reset the circuit-breaker countdown. Safe to call at any time; does not
// affect mode, positions, or config.
router.post("/crypto/bot/clear-pauses", requireAuth, async (_req, res) => {
  try {
    const result = clearAllPauses();
    // Write a synthetic per_coin_pause log entry so the cooldown guard in
    // runAutoTuneRules prevents the auto-tune job from immediately re-pausing
    // the same coin on the next window tick (consecutive losses are still in DB).
    // Without this, clearing the in-memory pausedCoins map has no lasting effect.
    await db.insert(botAutoTuneLogTable).values({
      ruleName: "per_coin_pause",
      oldValue: result.clearedCoins.join(",") || "none",
      newValue: "user_cleared",
      triggerReason: "Manual clear-pauses action — cooldown guard applied for 1 hour",
      createdAt: new Date(),
    }).catch(() => {}); // non-fatal: cooldown skipped if write fails
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/conditions — current snapshot of every active restriction and
// condition in the bot: global gates, direction caps, per-coin window blocks,
// and static coin filters. Refreshed on every request (no caching).
router.get("/crypto/bot/conditions", (_req, res) => {
  try {
    res.json(getWindowConditions());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/free-run  { enabled: boolean }
// Toggle free-run mode: when true, all restriction/penalty layers are bypassed
// (proximity gate, oscillation filter, quiet hours, doubt penalties, direction
// cap, chop filter, per-coin pauses, price-band gates, near-strike filter).
// Safety rails that are NEVER bypassed: circuit breaker, daily loss limit,
// max bets per window, and the ML-Claude alignment gate.
router.post("/crypto/bot/free-run", requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    const { S } = await import("../lib/kalshi-bot-state");
    const { updateBotConfig } = await import("../lib/kalshi-bot-db");
    S.config = { ...S.config, freeRunMode: enabled };
    await updateBotConfig({ freeRunMode: enabled });
    return res.json({ ok: true, freeRunMode: enabled });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/reset-conditions — nuclear reset: clears all window-level
// restrictions (empty-book cooldowns, direction counts), auto-tune pauses,
// coin streak pauses, the circuit-breaker countdown, directional coin blocks
// (COIN_YES_BLOCKED / COIN_FULLY_BLOCKED), and resets restriction-related
// config fields (regimePenalty → 0) so the bot runs with clean settings
// exactly matching the current defaults. Safe to call at any time; does not
// affect mode, daily P&L, open positions, or trade history.
router.post("/crypto/bot/reset-conditions", requireAuth, async (_req, res) => {
  try {
    const result = resetWindowConditions();

    // Reset restriction-related config fields to their clean defaults and
    // persist to DB so the settings survive a restart. Only touches fields
    // that represent active restrictions — leaves betSize, dailyLossLimit,
    // and all other user-configured values untouched.
    await updateBotConfig({
      regimePenalty: 0,
    });

    // Same cooldown guard as clear-pauses: write a synthetic per_coin_pause
    // log entry so the auto-tune job cannot immediately re-pause any coin
    // that was just unblocked by this full reset.
    await db.insert(botAutoTuneLogTable).values({
      ruleName: "per_coin_pause",
      oldValue: result.cleared.join(",") || "none",
      newValue: "user_reset",
      triggerReason: "Manual reset-conditions action — cooldown guard applied for 1 hour",
      createdAt: new Date(),
    }).catch(() => {}); // non-fatal

    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/config/presets — return all saved per-mode presets (public)
router.get("/crypto/bot/config/presets", async (_req, res) => {
  try {
    const presets = await readModePresets();
    res.json({ presets });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/config/save-preset — save current bot config as preset for
// the current decision mode. Call this after dialling in optimal settings for
// a mode so they auto-apply next time the mode is selected.
router.post("/crypto/bot/config/save-preset", requireAuth, async (_req, res) => {
  try {
    const state = getBotState();
    const mode = state.config.decisionMode;
    await writeModePreset(mode, state.config as unknown as Partial<BotConfig>);
    res.json({ ok: true, saved: mode, preset: state.config });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// DELETE /crypto/bot/bets/old — admin maintenance endpoint.
// Deletes kalshi_bot_bets records older than `hours` hours (1–24, default 2)
// and reloads in-memory daily P&L so the running bot reflects the clean slate.
// prediction_records (learning data) are NEVER touched.
// Accepts either Clerk admin auth OR X-Clear-Password header so it can be
// invoked from the frontend (Clerk session) or via curl (password).
router.delete("/crypto/bot/bets/old", async (req, res) => {
  const clerkAuth = getAuth(req);
  const adminId = process.env["BOT_ADMIN_CLERK_USER_ID"];
  const hasClerkAuth = clerkAuth?.userId && (!adminId || clerkAuth.userId === adminId);

  const clearPassword = process.env["CLEAR_LOGS_PASSWORD"];
  const hasClearPassword = clearPassword && req.headers["x-clear-password"] === clearPassword;

  if (!hasClerkAuth && !hasClearPassword) {
    res.status(401).json({ error: "Unauthorized — sign in as admin or supply X-Clear-Password" });
    return;
  }
  const hoursRaw = req.query.hours;
  const hours = Math.min(24, Math.max(1, parseInt(String(hoursRaw ?? "2"), 10) || 2));
  try {
    const result = await clearBetHistoryOld(hours);
    res.json({ ok: true, deleted: result.deleted, hours });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/re-evaluate-bets — re-check all historical expired bets
// against Kalshi's authoritative settlement result (RTI) and correct any that
// were mis-evaluated using Coinbase candle prices.
// Accepts Clerk admin auth OR X-Clear-Password header.
router.post("/crypto/bot/re-evaluate-bets", async (req, res) => {
  const clerkAuth = getAuth(req);
  const adminId = process.env["BOT_ADMIN_CLERK_USER_ID"];
  const hasClerkAuth = clerkAuth?.userId && (!adminId || clerkAuth.userId === adminId);
  const clearPassword = process.env["CLEAR_LOGS_PASSWORD"];
  const hasClearPassword = clearPassword && req.headers["x-clear-password"] === clearPassword;
  if (!hasClerkAuth && !hasClearPassword) {
    res.status(401).json({ error: "Unauthorized — sign in as admin or supply X-Clear-Password" });
    return;
  }
  try {
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const limitRaw = parseInt(String(req.query.limit ?? ""), 10);
    const limit = !isNaN(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : undefined;
    const result = await reEvaluateSettledBets({ since, limit });
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/time-analytics — permanent per-coin win/loss by day + hour
// Queries ALL historical bets with no rolling window, paper+live combined.
// This data never gets erased (bets table is the permanent store) and survives
// any server restart or republish.
router.get("/crypto/bot/time-analytics", async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        symbol,
        EXTRACT(DOW  FROM created_at AT TIME ZONE 'UTC')::int  AS dow,
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int  AS hour,
        COUNT(*) FILTER (WHERE outcome = 'win')::int  AS wins,
        COUNT(*) FILTER (WHERE outcome = 'loss')::int AS losses,
        COUNT(*)::int                                          AS total
      FROM ${kalshiBotBetsTable}
      WHERE
        action    IN ('exit', 'late_recovery_exit', 'expired')
        AND outcome IN ('win', 'loss')
        AND (source IS NULL OR source != 'manual')
      GROUP BY symbol, dow, hour
      ORDER BY symbol, dow, hour
    `);

    const data = (rows.rows ?? rows).map((r: Record<string, unknown>) => ({
      symbol:  String(r.symbol  ?? ""),
      dow:     Number(r.dow     ?? 0),
      hour:    Number(r.hour    ?? 0),
      wins:    Number(r.wins    ?? 0),
      losses:  Number(r.losses  ?? 0),
      total:   Number(r.total   ?? 0),
    }));

    const totalBets = data.reduce((s: number, r: { total: number }) => s + r.total, 0);
    res.json({ rows: data, totalBets, lastUpdated: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/reset-live-stats — set liveStatsResetAt to NOW() so all
// visual stats (win/loss %, profit, history, performance report) start fresh
// from this moment.  Zero rows are deleted; the underlying data is fully
// preserved for ML training and auto-tune learning.
router.post("/crypto/bot/reset-live-stats", requireAuth, async (_req, res) => {
  try {
    const { config } = await updateBotConfig({ liveStatsResetAt: new Date().toISOString() });
    res.json({ ok: true, liveStatsResetAt: config.liveStatsResetAt });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
