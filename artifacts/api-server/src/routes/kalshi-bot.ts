import { Router } from "express";
import {
  getBotState,
  setBotMode,
  setBotPaused,
  updateBotConfig,
  getBotHistory,
  getBotStats,
} from "../lib/kalshi-bot";
import type { BotMode } from "../lib/kalshi-bot";

const router = Router();

// GET /crypto/bot/status — full bot state
router.get("/crypto/bot/status", (_req, res) => {
  try {
    res.json(getBotState());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

// POST /crypto/bot/mode  { mode: "paper" | "live" }
router.post("/crypto/bot/mode", (req, res) => {
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
router.post("/crypto/bot/pause", (req, res) => {
  const { paused } = req.body as { paused?: boolean };
  if (typeof paused !== "boolean") {
    res.status(400).json({ error: "paused must be a boolean" });
    return;
  }
  setBotPaused(paused);
  res.json({ ok: true, ...getBotState() });
});

// POST /crypto/bot/config  — update one or more config fields
router.post("/crypto/bot/config", (req, res) => {
  const {
    betSize,
    dailyLossLimit,
    signalThreshold,
    midExitSensitivity,
    phase2ThresholdPp,
    enabled,
  } = req.body as {
    betSize?: number;
    dailyLossLimit?: number;
    signalThreshold?: number;
    midExitSensitivity?: "conservative" | "balanced" | "aggressive";
    phase2ThresholdPp?: number;
    enabled?: boolean;
  };

  const partial: Parameters<typeof updateBotConfig>[0] = {};
  if (typeof betSize === "number" && betSize >= 0.5 && betSize <= 25) partial.betSize = betSize;
  if (typeof dailyLossLimit === "number" && dailyLossLimit > 0) partial.dailyLossLimit = dailyLossLimit;
  if (typeof signalThreshold === "number" && [2, 3, 4].includes(signalThreshold)) {
    partial.signalThreshold = signalThreshold;
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
  if (typeof enabled === "boolean") partial.enabled = enabled;

  const updated = updateBotConfig(partial);
  res.json({ ok: true, config: updated });
});

// GET /crypto/bot/history?limit=20
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

// GET /crypto/bot/stats
router.get("/crypto/bot/stats", async (_req, res) => {
  try {
    const stats = await getBotStats();
    res.json(stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
