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
} from "../lib/kalshi-bot";
import type { BotMode } from "../lib/kalshi-bot";
import type { BotConfig, DecisionMode } from "../lib/kalshi-bot-engine-core";
import { getAllMLStatus } from "../lib/ml-store";
import { db, botConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

// GET /crypto/bot/coin-guard-state — per-coin streak / daily-loss / slippage state (public — read only)
router.get("/crypto/bot/coin-guard-state", (_req, res) => {
  try {
    res.json(getCoinGuardState());
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

// GET /crypto/bot/history?limit=20 (public — read only, terminal outcomes only)
router.get("/crypto/bot/history", async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
  try {
    const history = await getBotHistory(limit);
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
  try {
    const history = await getBotAllHistory(limit, offset, mode);
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
  try {
    const stats = await getBotStats(symbol, mode);
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
  try {
    const points = await getBotTrend(limit, mode);
    res.json(points);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/window-eval (public — last market evaluation results)
router.get("/crypto/bot/window-eval", (_req, res) => {
  try {
    res.json({ evaluation: getWindowEvaluation() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/performance-report — latest cached analytics report (public)
router.get("/crypto/bot/performance-report", (_req, res) => {
  try {
    const report = getPerformanceReport();
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
router.get("/crypto/bot/logic-performance", async (_req, res) => {
  try {
    const modes = await getBotLogicPerformance();
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

// POST /crypto/bot/clear-pauses — immediately clear all per-coin auto-tune pauses
// and reset the circuit-breaker countdown. Safe to call at any time; does not
// affect mode, positions, or config.
router.post("/crypto/bot/clear-pauses", requireAuth, (_req, res) => {
  try {
    const result = clearAllPauses();
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

export default router;
