// ---------------------------------------------------------------------------
// kalshi-bot-pipeline.ts — per-coin sequential signal pipeline
// ---------------------------------------------------------------------------
// At window-open, this pipeline runs sequentially for each confirmed coin:
//   Wait for fresh Kalshi target → stat analysis → Claude (extended thinking)
//   → ML (using Claude's verdict as a feature)
//
// Step 1 BLOCKS until Kalshi publishes the new window's market (10-30s).
// No analysis runs against a stale/previous-window target.
//
// Results are tagged to the current windowKey (not a wall-clock TTL).
// The bot tick gate checks getPipelineResult(sym, windowKey):
//   null   → pipeline still running, defer this tick
//   result → all signals ready, proceed to makeBotDecision
//
// The pipeline writes Claude's verdict to liveDirectionCache so
// _makeBotDecisionInner picks it up via applyClaudeLiveOverride with no
// engine changes needed.

import { logger } from "./logger";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { isAiFeatureEnabled } from "./ai-spend";
import {
  CRYPTO_COINS,
  getCandles, getStats, getTicker,
  analyzeCoin,
  getKalshiCachedData, fetchKalshiTarget, getKalshiWindowContext,
  getCachedPrediction,
  liveDirectionCache,
  getLatestCoinSignals,
  type CoinDef,
  type CoinPrediction,
  type LiveDirectionResult,
} from "./crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineResult {
  sym: string;
  windowKey: string;
  completedAt: number;
  kalshiTarget: number;
  statAbove: boolean | null;
  statConfidence: number | null;
  claudeAbove: boolean | null;
  claudeConfidence: number | null;
  mlAbove: boolean | null;
  mlConfidence: number | null;
  claudeCallMs: number;
  isRecheck: boolean;
}

export type PipelinePhase =
  | "waiting-target"
  | "fetching-data"
  | "claude-analyzing"
  | "ml-analyzing"
  | "ready";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// Keyed by `${sym}:${windowKey}` — one result per coin per window.
const pipelineResults = new Map<string, PipelineResult>();

// Prevents concurrent runs for the same (sym, windowKey) pair.
// Re-checks use a separate key (`${sym}:${windowKey}:recheck`) so they don't
// block the initial pipeline and vice versa.
const pipelineInFlight = new Set<string>();

// Tracks the current execution phase for each in-flight coin (for status display).
const pipelinePhaseMap = new Map<string, PipelinePhase>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getPipelineResult(sym: string, windowKey: string): PipelineResult | null {
  return pipelineResults.get(`${sym.toUpperCase()}:${windowKey}`) ?? null;
}

/** Return all current pipeline results as an array (one per coin, current window only). */
export function getAllPipelineResults(): PipelineResult[] {
  return Array.from(pipelineResults.values());
}

/** Return whether the pipeline is in-flight for a given (sym, windowKey) pair. */
export function isPipelineInFlight(sym: string, windowKey: string): boolean {
  const key = `${sym.toUpperCase()}:${windowKey}`;
  return pipelineInFlight.has(key) || pipelineInFlight.has(`${key}:recheck`);
}

/**
 * Return all currently in-flight entries with their current phase.
 * Keys are `SYM:YYYY-MM-DDTHH:MM` (initial) or `SYM:YYYY-MM-DDTHH:MM:recheck`.
 */
export function getInFlightDetails(): Array<{
  sym: string;
  windowKey: string;
  isRecheck: boolean;
  phase: PipelinePhase;
}> {
  const entries: Array<{ sym: string; windowKey: string; isRecheck: boolean; phase: PipelinePhase }> = [];
  for (const key of pipelineInFlight) {
    const parts = key.split(":");
    if (parts.length < 3) continue;
    const sym = parts[0];
    const isRecheck = parts[parts.length - 1] === "recheck";
    const wkParts = isRecheck ? parts.slice(1, -1) : parts.slice(1);
    const windowKey = wkParts.join(":");
    if (sym && windowKey) {
      const phase = pipelinePhaseMap.get(`${sym}:${windowKey}`) ?? "waiting-target";
      entries.push({ sym, windowKey, isRecheck, phase });
    }
  }
  return entries;
}

/**
 * Legacy accessor — returns just the sym list for the current window.
 * Kept for backward compat; prefer getInFlightDetails() for phase info.
 */
export function getInFlightEntries(): Array<{ sym: string; windowKey: string; isRecheck: boolean }> {
  return getInFlightDetails();
}

/**
 * Trigger the window pipeline for a coin.  Fire-and-forget, idempotent:
 * if a result already exists for (sym, windowKey) the call is a no-op.
 * Call this from runWindowOpenPrefetch (primary) and from the bot tick
 * (fallback for coins whose Kalshi market wasn't yet published at prefetch time).
 */
export function triggerWindowPipeline(sym: string, windowKey: string): void {
  const symUp = sym.toUpperCase();
  const key = `${symUp}:${windowKey}`;
  if (pipelineResults.has(key) || pipelineInFlight.has(key)) return;

  // Prune results from previous windows for this coin so the map doesn't grow
  // unboundedly over long uptime.  Keep only the entry for the current windowKey.
  for (const existingKey of pipelineResults.keys()) {
    if (existingKey.startsWith(`${symUp}:`) && existingKey !== key) {
      pipelineResults.delete(existingKey);
    }
  }
  // Prune stale phase entries for this coin
  for (const phaseKey of pipelinePhaseMap.keys()) {
    if (phaseKey.startsWith(`${symUp}:`) && phaseKey !== key) {
      pipelinePhaseMap.delete(phaseKey);
    }
  }

  pipelineInFlight.add(key);
  _runPipeline(symUp, windowKey, false)
    .finally(() => {
      pipelineInFlight.delete(key);
      pipelinePhaseMap.delete(`${symUp}:${windowKey}`);
    });
}

/**
 * Re-run stat + Claude for an open position's window.  Used every 2-3 min
 * to detect consensus flips.  Returns the updated result or null on failure.
 * Updates liveDirectionCache and pipelineResults so subsequent ticks see the
 * fresh signal even if no explicit re-check fires.
 */
export async function runPipelineRecheck(
  sym: string,
  windowKey: string,
): Promise<PipelineResult | null> {
  const key = `${sym.toUpperCase()}:${windowKey}:recheck`;
  if (pipelineInFlight.has(key)) return null;
  pipelineInFlight.add(key);
  try {
    return await _runPipeline(sym.toUpperCase(), windowKey, true);
  } finally {
    pipelineInFlight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Fresh-target polling
// ---------------------------------------------------------------------------

/**
 * Poll fetchKalshiTarget(sym, windowCloseDate) until Kalshi publishes the new
 * window's market — one whose close_time is within 8 min of windowCloseMs.
 *
 * fetchKalshiTarget with a targetTime skips the in-memory cache and always
 * makes a live API call, then validates close_time proximity. Returns null
 * only if the window's market has not been published within maxWaitMs.
 *
 * On success the kalshiTargetCache is updated by fetchKalshiTarget internally,
 * so getKalshiCachedData(sym) immediately reflects the fresh target.
 */
async function waitForFreshKalshiTarget(
  sym: string,
  windowKey: string,
  windowCloseMs: number,
  maxWaitMs: number,
): Promise<number | null> {
  const windowCloseDate = new Date(windowCloseMs);
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const target = await fetchKalshiTarget(sym, windowCloseDate);
      if (target != null) {
        const kd = getKalshiCachedData(sym);
        logger.info(
          { sym, windowKey, target, ticker: kd?.ticker, attempt },
          "[pipeline] fresh Kalshi target confirmed",
        );
        return target;
      }
    } catch {
      // non-fatal, will retry
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    logger.debug(
      { sym, windowKey, attempt, remainingMs: Math.round(remaining) },
      "[pipeline] Kalshi target not yet published — retrying in 5s",
    );
    await new Promise<void>(r => setTimeout(r, 5_000));
  }

  logger.warn({ sym, windowKey, attempts: attempt }, "[pipeline] timed out waiting for fresh Kalshi target");
  return null;
}

// ---------------------------------------------------------------------------
// Internal pipeline runner
// ---------------------------------------------------------------------------

async function _runPipeline(
  sym: string,
  windowKey: string,
  isRecheck: boolean,
): Promise<PipelineResult | null> {
  const coin = CRYPTO_COINS.find(c => c.symbol === sym);
  if (!coin) return null;

  // ── Step 1: Ensure fresh Kalshi target for THIS window ───────────────────
  // Re-checks are mid-window — the market is already confirmed and the target
  // is stable. Only the initial run needs to wait for the new window's market.
  // fetchKalshiTarget(sym, windowCloseDate) validates close_time proximity,
  // bypasses the cache, and always makes a live API call.
  const windowCloseMs = new Date(`${windowKey}:00.000Z`).getTime() + 15 * 60_000;

  let kalshiTarget: number | null;
  if (isRecheck) {
    kalshiTarget = getKalshiCachedData(sym)?.value ?? null;
  } else {
    pipelinePhaseMap.set(`${sym}:${windowKey}`, "waiting-target");
    kalshiTarget = await waitForFreshKalshiTarget(sym, windowKey, windowCloseMs, 90_000);
  }

  if (kalshiTarget == null) {
    logger.warn({ sym, windowKey, isRecheck }, "[pipeline] no Kalshi target — aborting");
    return null;
  }

  // ── Steps 2–4: Read all signals from the unified predictor layer ─────────
  // getLatestCoinSignals reads from the SAME sources as the Crypto Predictor page:
  //   stat   → getStatWindowCall     (null when historyStore snap not ready yet)
  //   claude → getTrackerWindowCall  (null when autopilot off OR tracker not done yet)
  //   ml     → fresh inference with tracker's latest pred snapshot (~30 s cadence)
  //   wm     → getWindowBetSignal
  //
  // Replacing independent stat/claude/ML computation with a single unified read
  // eliminates every signal divergence: the pipeline can never show a different
  // direction than the predictor page for the same coin and window.
  if (!isRecheck) pipelinePhaseMap.set(`${sym}:${windowKey}`, "fetching-data");
  const signals = getLatestCoinSignals(sym);
  const statAbove: boolean | null = signals.statAbove;
  const statConfidence: number | null = signals.statConfidence;
  let claudeAbove: boolean | null = signals.claudeAbove;
  let claudeConfidence: number | null = signals.claudeConfidence;
  const mlAbove: boolean | null = signals.mlAbove;
  const mlConfidence: number | null = signals.mlConfidence;
  let claudeCallMs = 0;

  logger.debug(
    { sym, windowKey, statAbove, statConfidence, claudeAbove, mlAbove, wmRecommendation: signals.wmRecommendation, isRecheck },
    "[pipeline] unified signals read from predictor layer",
  );

  // ── Claude race-fallback ──────────────────────────────────────────────────
  // claudeAbove is null in two cases:
  //   (a) Auto-pilot OFF  — predictor not running Claude → leave null (matches page).
  //   (b) Race at T+0     — auto-pilot on but tracker's opening call hasn't resolved
  //                         yet (takes 15–60 s); fall back to a fresh pipeline call
  //                         so we don't miss the opening window bet entirely.
  //
  // signals.claudeEnabled distinguishes them: true = auto-pilot on (case b); false = off (case a).
  if (isAiFeatureEnabled("crypto_live_dir") && claudeAbove === null && signals.claudeEnabled) {
    if (!isRecheck) pipelinePhaseMap.set(`${sym}:${windowKey}`, "claude-analyzing");
    try {
      // Lazy-fetch market data — only needed for the Claude prompt context.
      const pred = getCachedPrediction(sym);
      const [candles, stats, tickerPrice] = await Promise.all([
        getCandles(coin.product).catch(() => [] as Array<{ c: number; h: number; l: number; t: number; v: number; o: number }>),
        getStats(coin.product).catch(() => null),
        getTicker(coin.product).catch(() => 0),
      ]);
      const livePrice = tickerPrice > 0 ? tickerPrice : (pred?.price ?? 0);
      if (livePrice === 0) throw new Error("no live price available for Claude fallback");

      logger.info({ sym, windowKey, isRecheck },
        "[pipeline] tracker Claude not ready — running fresh pipeline call (auto-pilot on, race at window open)");
      const claudeResult = await _callPipelineClaude(
        sym, coin, kalshiTarget, windowKey,
        pred, candles, stats, livePrice,
        statAbove, statConfidence,
      );
      claudeAbove = claudeResult.aboveKalshi;
      claudeConfidence = claudeResult.confidence;
      claudeCallMs = claudeResult.callMs;
      logger.info(
        { sym, windowKey, claudeAbove, claudeConfidence, callMs: claudeCallMs, isRecheck },
        "[pipeline] Claude verdict from fresh pipeline call (fallback)",
      );
    } catch (err) {
      logger.warn({ sym, windowKey, err }, "[pipeline] Claude fallback failed — proceeding without Claude signal");
    }
  }

  // Write to liveDirectionCache so _makeBotDecisionInner picks up the Claude
  // verdict via applyClaudeLiveOverride without any engine changes.
  if (isAiFeatureEnabled("crypto_live_dir") && claudeAbove !== null) {
    const liveResult: LiveDirectionResult = {
      aboveKalshi: claudeAbove,
      direction: claudeAbove ? "up" : "down",
      confidence: claudeConfidence ?? 50,
      at: new Date().toISOString(),
      cached: false,
    };
    liveDirectionCache.set(sym, { result: liveResult, at: Date.now() });
  }

  // ── Step 5: Store and return ─────────────────────────────────────────────
  const result: PipelineResult = {
    sym, windowKey, completedAt: Date.now(),
    kalshiTarget,
    statAbove, statConfidence,
    claudeAbove, claudeConfidence,
    mlAbove, mlConfidence,
    claudeCallMs, isRecheck,
  };

  pipelineResults.set(`${sym}:${windowKey}`, result);

  logger.info(
    { sym, windowKey, statAbove, claudeAbove, mlAbove, isRecheck },
    `[pipeline] ${isRecheck ? "re-check" : "initial"} complete`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Pipeline-specific Claude call — extended thinking
// ---------------------------------------------------------------------------

async function _callPipelineClaude(
  sym: string,
  coin: CoinDef,
  kalshiTarget: number,
  windowKey: string,
  pred: CoinPrediction | null,
  candles: Array<{ c: number; h: number; l: number; t: number; v: number; o: number }>,
  stats: Awaited<ReturnType<typeof getStats>> | null,
  livePrice: number,
  statAbove: boolean | null,
  statConfidence: number | null,
): Promise<{ aboveKalshi: boolean | null; confidence: number; callMs: number }> {
  if (livePrice === 0) throw new Error("no live price available");

  const windowStartMs = new Date(`${windowKey}:00.000Z`).getTime();
  const windowCloseMs = windowStartMs + 15 * 60_000;
  const windowCloseDate = new Date(windowCloseMs);
  const windowCloseUTC = windowCloseDate.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const windowCloseET = windowCloseDate.toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }) + " ET";
  const minutesRemaining = Math.max(0, (windowCloseMs - Date.now()) / 60_000);

  const dp = livePrice >= 100 ? 2 : livePrice >= 1 ? 4 : 6;

  const freshAnalysis = candles.length >= 10 && stats != null
    ? analyzeCoin(coin, candles, stats, new Date(), livePrice)
    : null;
  const ind = freshAnalysis?.indicators ?? pred?.indicators ?? null;

  const regime = ind
    ? ind.efficiencyRatio >= 0.4 ? "trending"
    : ind.efficiencyRatio >= 0.15 ? "drifting" : "choppy"
    : "unknown";

  const currentSide = livePrice >= kalshiTarget ? "ABOVE" : "BELOW";
  const gapPct = Math.abs(livePrice - kalshiTarget) / kalshiTarget * 100;
  const recent20 = candles.slice(-20);
  const closesStr = recent20.length > 0
    ? recent20.map(c => `$${c.c.toFixed(dp)}`).join(" → ")
    : "(no candle data)";
  const volStr = recent20.length > 0
    ? `Vol range: ${Math.min(...recent20.map(c => c.v)).toFixed(0)}–${Math.max(...recent20.map(c => c.v)).toFixed(0)}`
    : "";
  const topVol = recent20.length > 0
    ? [...recent20].sort((a, b) => b.v - a.v)[0]
    : null;

  const winCtx = getKalshiWindowContext(sym);
  let trajectoryNote = "";
  if (winCtx?.priceAtOpen != null) {
    const openGapPct = Math.abs(winCtx.priceAtOpen - kalshiTarget) / kalshiTarget * 100;
    const openSide = winCtx.priceAtOpen >= kalshiTarget ? "ABOVE" : "BELOW";
    const elapsed = (winCtx.minutesElapsed ?? 0).toFixed(1);
    trajectoryNote = `Window opened ${elapsed}min ago at $${winCtx.priceAtOpen.toFixed(dp)} (${openGapPct.toFixed(3)}% ${openSide} strike).`;
  }

  const statNote = statAbove !== null
    ? `Stat model: ${statAbove ? "ABOVE" : "BELOW"} strike${statConfidence != null ? ` (${statConfidence.toFixed(0)}% conf)` : ""}`
    : "Stat model: not yet available";

  const lines = [
    `${sym} — Kalshi 15-min binary market`,
    `CONFIRMED strike (new window): $${kalshiTarget.toFixed(dp)}`,
    `Window closes: ${windowCloseUTC} (${windowCloseET}) | ${minutesRemaining.toFixed(1)} min remaining`,
    trajectoryNote,
    `Current live price: $${livePrice.toFixed(dp)} — ${gapPct.toFixed(3)}% ${currentSide} strike`,
    ind
      ? `RSI ${ind.rsi.toFixed(0)} | MACD ${ind.macd >= 0 ? "bullish" : "bearish"} | BB%B ${ind.bbPctB.toFixed(0)}%` +
        ` | Trend: ${ind.trend} (strength ${Math.round(ind.trendStrength * 100)}%) | ER ${ind.efficiencyRatio.toFixed(2)} (${regime})`
      : "",
    ind
      ? `Net drift last 15 candles: ${ind.netDriftPct >= 0 ? "+" : ""}${ind.netDriftPct.toFixed(3)}%` +
        ` | Oscillations: ${ind.oscillationCount}` +
        ` | Volatility: ${ind.volatilityPct.toFixed(3)}%`
      : "",
    `Last 20 1-min closes: ${closesStr}`,
    volStr,
    topVol ? `Highest-volume candle close: $${topVol.c.toFixed(dp)} (${topVol.v.toFixed(0)} units)` : "",
    statNote,
    ``,
    `Question: Will ${sym} close ABOVE or BELOW $${kalshiTarget.toFixed(dp)} at exactly ${windowCloseUTC}?`,
    `Respond with ONLY this JSON: {"above":true,"confidence":70}`,
  ].filter(Boolean).join("\n");

  const t0 = Date.now();

  // Extended thinking gives Claude full reasoning depth before committing to
  // a direction. Budget 8000 tokens lets Claude properly weigh momentum,
  // proximity, regime, and indicator context before outputting the JSON.
  const response = await Promise.race([
    anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 12000,
      thinking: { type: "enabled", budget_tokens: 8000 },
      system: "You are a short-term crypto price analyst making a binary ABOVE/BELOW prediction for a Kalshi 15-min market. Use your thinking to thoroughly analyze price momentum, technical indicators, distance from the strike, regime, and time remaining. After your analysis, output ONLY this JSON in your response: {\"above\":true,\"confidence\":70}. The 'above' field is true if the price will be AT OR ABOVE the strike at window close, false if below. Confidence must be 50-90. No markdown, no prose, no explanation outside the JSON.",
      messages: [{ role: "user", content: lines }],
    } as Parameters<typeof anthropic.messages.create>[0]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Claude pipeline timeout (120s)")), 120_000),
    ),
  ]);

  const callMs = Date.now() - t0;
  // Extended thinking responses include both "thinking" and "text" content blocks.
  // Parse only the text block for the JSON verdict.
  const raw = (response as { content: Array<{ type: string; text?: string }> }).content
    .filter(b => b.type === "text")
    .map(b => b.text ?? "")
    .join("")
    .trim();

  let parsed: { above?: boolean; confidence?: number } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[^}]+\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error(`Claude returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const confidence = Math.min(90, Math.max(50, parsed.confidence ?? 60));
  const aboveKalshi = typeof parsed.above === "boolean" ? parsed.above : null;
  return { aboveKalshi, confidence, callMs };
}
