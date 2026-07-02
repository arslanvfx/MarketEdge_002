import { Router } from "express";
import { getAuth } from "@clerk/express";
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
} from "../lib/kalshi-bot";
import type { BotMode } from "../lib/kalshi-bot";
import { getAllMLStatus } from "../lib/ml-store";

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
    aiPaused,
    paperStartingBalance,
    paperWinReturnRate,
    paperBalanceResetAt,
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
    aiPaused?: boolean;
    paperStartingBalance?: number;
    paperWinReturnRate?: number;
    paperBalanceResetAt?: string | null;
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
  if (decisionMode === "classic" || decisionMode === "ml_gate" || decisionMode === "consensus") {
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
  if (typeof aiPaused === "boolean") partial.aiPaused = aiPaused;
  if (typeof paperStartingBalance === "number" && paperStartingBalance >= 1 && paperStartingBalance <= 10000) {
    partial.paperStartingBalance = paperStartingBalance;
  }
  if (typeof paperWinReturnRate === "number" && paperWinReturnRate >= 0.1 && paperWinReturnRate <= 2.0) {
    partial.paperWinReturnRate = paperWinReturnRate;
  }
  if ("paperBalanceResetAt" in req.body) {
    partial.paperBalanceResetAt = typeof paperBalanceResetAt === "string" ? paperBalanceResetAt : null;
  }

  const { config: updated, persisted } = await updateBotConfig(partial);
  res.json({ ok: true, config: updated, persisted });
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

// GET /crypto/bot/all-history?limit=100&offset=0 (public — all records for dashboard)
router.get("/crypto/bot/all-history", async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10) || 100));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  try {
    const history = await getBotAllHistory(limit, offset);
    res.json({ history });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/stats?symbol=BTC (public — read only)
router.get("/crypto/bot/stats", async (req, res) => {
  const symbol = typeof req.query.symbol === "string" && req.query.symbol.trim()
    ? req.query.symbol.trim()
    : undefined;
  try {
    const stats = await getBotStats(symbol);
    res.json(stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// GET /crypto/bot/trend?limit=50 — chronological win/loss sequence with rolling win rate
router.get("/crypto/bot/trend", async (req, res) => {
  const limit = Math.min(100, Math.max(2, parseInt(String(req.query.limit ?? "50"), 10) || 50));
  try {
    const points = await getBotTrend(limit);
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
