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
} from "../lib/kalshi-bot";
import type { BotMode } from "../lib/kalshi-bot";

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
    res.json(getBotState());
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
    midExitSensitivity,
    phase2ThresholdPp,
    maxEntryMinutes,
    maxBetsPerWindow,
    enabled,
    quietHoursStart,
    quietHoursEnd,
    maxConsecutiveLosses,
    circuitBreakerPauseWindows,
  } = req.body as {
    betSize?: number;
    dailyLossLimit?: number;
    signalThreshold?: number;
    minConfidence?: number;
    midExitSensitivity?: "conservative" | "balanced" | "aggressive";
    phase2ThresholdPp?: number;
    maxEntryMinutes?: number;
    maxBetsPerWindow?: number;
    enabled?: boolean;
    quietHoursStart?: number;
    quietHoursEnd?: number;
    maxConsecutiveLosses?: number;
    circuitBreakerPauseWindows?: number;
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
  if (typeof maxEntryMinutes === "number" && maxEntryMinutes >= 1 && maxEntryMinutes <= 7) {
    partial.maxEntryMinutes = maxEntryMinutes;
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

export default router;
