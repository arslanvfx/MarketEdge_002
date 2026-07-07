// ---------------------------------------------------------------------------
// kalshi-bot-pipeline.ts — per-coin sequential signal pipeline
// ---------------------------------------------------------------------------
// At window-open, this pipeline runs sequentially for each confirmed coin:
//   Kalshi target → stat analysis → Claude (rich prompt + explicit close time) → ML
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
  getKalshiCachedData, getKalshiWindowContext,
  getCachedPrediction,
  getStatWindowCall,
  liveDirectionCache,
  type CoinDef,
  type CoinPrediction,
  type LiveDirectionResult,
} from "./crypto";
import { extractMLFeatures } from "./ml-features";
import { getMLPrediction } from "./ml-store";

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

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// Keyed by `${sym}:${windowKey}` — one result per coin per window.
const pipelineResults = new Map<string, PipelineResult>();

// Prevents concurrent runs for the same (sym, windowKey) pair.
// Re-checks use a separate key (`${sym}:${windowKey}:recheck`) so they don't
// block the initial pipeline and vice versa.
const pipelineInFlight = new Set<string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getPipelineResult(sym: string, windowKey: string): PipelineResult | null {
  return pipelineResults.get(`${sym.toUpperCase()}:${windowKey}`) ?? null;
}

/**
 * Trigger the window pipeline for a coin.  Fire-and-forget, idempotent:
 * if a result already exists for (sym, windowKey) the call is a no-op.
 * Call this from runWindowOpenPrefetch (primary) and from the bot tick
 * (fallback for coins whose Kalshi market wasn't yet published at prefetch time).
 */
export function triggerWindowPipeline(sym: string, windowKey: string): void {
  const key = `${sym.toUpperCase()}:${windowKey}`;
  if (pipelineResults.has(key) || pipelineInFlight.has(key)) return;
  pipelineInFlight.add(key);
  _runPipeline(sym.toUpperCase(), windowKey, false)
    .finally(() => pipelineInFlight.delete(key));
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
// Internal pipeline runner
// ---------------------------------------------------------------------------

async function _runPipeline(
  sym: string,
  windowKey: string,
  isRecheck: boolean,
): Promise<PipelineResult | null> {
  const coin = CRYPTO_COINS.find(c => c.symbol === sym);
  if (!coin) return null;

  // ── Step 1: Kalshi target ────────────────────────────────────────────────
  const kd = getKalshiCachedData(sym);
  const kalshiTarget = kd?.value ?? null;
  if (kalshiTarget == null) {
    logger.debug({ sym, windowKey }, "[pipeline] no Kalshi target — aborting");
    return null;
  }

  // ── Step 2: Stat signal (from tracker's historyStore snap) ───────────────
  // getStatWindowCall reads the snap written by the tracker at ~T+30-60s.
  // May be null early in the window; that's OK — the engine handles null stat.
  const statCall = getStatWindowCall(sym);
  const statAbove = statCall?.aboveKalshi ?? null;
  const statConfidence = statCall?.confidence ?? null;

  // ── Step 3: Claude — rich prompt with explicit window close timestamp ─────
  let claudeAbove: boolean | null = null;
  let claudeConfidence: number | null = null;
  let claudeCallMs = 0;

  if (isAiFeatureEnabled("crypto_live_dir")) {
    try {
      const claudeResult = await _callPipelineClaude(
        sym, coin, kalshiTarget, windowKey,
        getCachedPrediction(sym),
        statAbove, statConfidence,
      );
      claudeAbove = claudeResult.aboveKalshi;
      claudeConfidence = claudeResult.confidence;
      claudeCallMs = claudeResult.callMs;

      // Write to liveDirectionCache so _makeBotDecisionInner sees the fresh
      // signal via applyClaudeLiveOverride with no engine changes.
      const liveResult: LiveDirectionResult = {
        aboveKalshi: claudeAbove,
        direction: claudeAbove === null ? "flat" : claudeAbove ? "up" : "down",
        confidence: claudeConfidence ?? 50,
        at: new Date().toISOString(),
        cached: false,
      };
      liveDirectionCache.set(sym, { result: liveResult, at: Date.now() });

      logger.info(
        { sym, windowKey, claudeAbove, claudeConfidence, callMs: claudeCallMs, isRecheck },
        "[pipeline] Claude verdict ready",
      );
    } catch (err) {
      logger.warn({ sym, windowKey, err }, "[pipeline] Claude call failed — proceeding without Claude signal");
    }
  }

  // ── Step 4: ML prediction ────────────────────────────────────────────────
  let mlAbove: boolean | null = null;
  let mlConfidence: number | null = null;
  const pred = getCachedPrediction(sym);
  if (pred && kalshiTarget != null) {
    try {
      const winCtx = getKalshiWindowContext(sym);
      // windowKey is "YYYY-MM-DDTHH:MM" — parse as UTC window start
      const windowStartMs = new Date(`${windowKey}:00.000Z`).getTime();
      const elapsedFraction = Math.min((Date.now() - windowStartMs) / (15 * 60_000), 1);
      const features = extractMLFeatures(
        pred, kalshiTarget, elapsedFraction, winCtx?.priceAtOpen,
        statAbove, claudeAbove, null,
      );
      const mlResult = getMLPrediction(sym, features);
      if (mlResult.ready && mlResult.prediction) {
        mlAbove = mlResult.prediction.above;
        mlConfidence = mlResult.prediction.confidence ?? null;
      }
    } catch (err) {
      logger.warn({ sym, windowKey, err }, "[pipeline] ML inference failed");
    }
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

  // Both initial and re-check overwrite the main key so subsequent ticks always
  // see the freshest signals for this window.
  pipelineResults.set(`${sym}:${windowKey}`, result);

  logger.info(
    { sym, windowKey, statAbove, claudeAbove, mlAbove, isRecheck },
    `[pipeline] ${isRecheck ? "re-check" : "initial"} complete`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Pipeline-specific Claude call
// ---------------------------------------------------------------------------

async function _callPipelineClaude(
  sym: string,
  coin: CoinDef,
  kalshiTarget: number,
  windowKey: string,
  pred: CoinPrediction | null,
  statAbove: boolean | null,
  statConfidence: number | null,
): Promise<{ aboveKalshi: boolean | null; confidence: number; callMs: number }> {
  // Exact window close time — windowKey is "YYYY-MM-DDTHH:MM" UTC
  const windowStartMs = new Date(`${windowKey}:00.000Z`).getTime();
  const windowCloseMs = windowStartMs + 15 * 60_000;
  const windowCloseDate = new Date(windowCloseMs);
  const windowCloseUTC = windowCloseDate.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const windowCloseET = windowCloseDate.toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }) + " ET";
  const minutesRemaining = Math.max(0, (windowCloseMs - Date.now()) / 60_000);

  // Fetch fresh market data in parallel
  const [candles, stats, tickerPrice] = await Promise.all([
    getCandles(coin.product).catch(() => [] as Array<{ c: number; h: number; l: number; t: number; v: number; o: number }>),
    getStats(coin.product).catch(() => null),
    getTicker(coin.product).catch(() => 0),
  ]);

  const livePrice = tickerPrice > 0 ? tickerPrice : (pred?.price ?? 0);
  if (livePrice === 0) throw new Error("no live price available");

  // Decimal places: 2 for BTC/ETH (≥100), 4 for mid-range, 6 for small coins
  const dp = livePrice >= 100 ? 2 : livePrice >= 1 ? 4 : 6;

  // Fresh indicators from latest candles
  const freshAnalysis = candles.length >= 10 && stats != null
    ? analyzeCoin(coin, candles, stats, new Date(), tickerPrice > 0 ? tickerPrice : undefined)
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
    : "Stat model: not yet snapped";

  const lines = [
    `${sym} — Kalshi 15-min window`,
    `Strike: $${kalshiTarget.toFixed(dp)} | Window closes: ${windowCloseUTC} (${windowCloseET}) | ${minutesRemaining.toFixed(1)} min remaining`,
    trajectoryNote,
    `Current price: $${livePrice.toFixed(dp)} — ${gapPct.toFixed(3)}% ${currentSide} strike`,
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
    statNote,
    ``,
    `Question: Will ${sym} close ABOVE or BELOW $${kalshiTarget.toFixed(dp)} at exactly ${windowCloseUTC}?`,
    `Respond with ONLY this JSON: {"above":true,"confidence":70}`,
  ].filter(Boolean).join("\n");

  const t0 = Date.now();

  // 60-second timeout so the pipeline never hangs indefinitely
  const response = await Promise.race([
    anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 60,
      system: "You are a short-term crypto price analyst. Analyze the data and return ONLY compact JSON: {\"above\":true,\"confidence\":70}. 'above' is true if price will be AT OR ABOVE the Kalshi strike at window close, false if below. No markdown, no prose, no explanation.",
      messages: [{ role: "user", content: lines }],
    } as Parameters<typeof anthropic.messages.create>[0]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Claude pipeline timeout (60s)")), 60_000),
    ),
  ]);

  const callMs = Date.now() - t0;
  const raw = (response as { content: Array<{ type: string; text?: string }> }).content
    .filter(b => b.type === "text")
    .map(b => b.text ?? "")
    .join("")
    .trim();

  let parsed: { above?: boolean; confidence?: number } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Attempt to extract JSON from prose if Claude added surrounding text
    const match = raw.match(/\{[^}]+\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error(`Claude returned non-JSON: ${raw.slice(0, 100)}`);
  }

  const confidence = Math.min(90, Math.max(20, parsed.confidence ?? 60));
  const aboveKalshi = typeof parsed.above === "boolean" ? parsed.above : null;
  return { aboveKalshi, confidence, callMs };
}
