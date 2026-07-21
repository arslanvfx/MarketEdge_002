// ---------------------------------------------------------------------------
// kalshi-bot-pipeline.ts — per-coin signal READER pipeline
// ---------------------------------------------------------------------------
// At window-open, this pipeline runs for each confirmed coin:
//   Wait for fresh Kalshi target → read stat/Claude/ML from the predictor
//   layer (getLatestCoinSignals — the same caches the Crypto Predictor page
//   displays).
//
// HARD RULE: the bot NEVER computes signals itself.  No analyzeCoin calls,
// no Claude calls, no independent ML feature extraction happen here — the
// Crypto Predictor tool is the single source of truth for all three models.
// If any signal is still null, the pipeline stores the partial result and
// the re-check loop polls again until the predictor has produced all three.
//
// Step 1 BLOCKS until Kalshi publishes the new window's market (10-30s).
// No signals are read against a stale/previous-window target.
//
// Results are tagged to the current windowKey (not a wall-clock TTL).
// The bot tick gate checks getPipelineResult(sym, windowKey):
//   null   → pipeline still running, defer this tick
//   result → signals stored; entry fires only when stat+Claude+ML all non-null

import { logger } from "./logger";
import {
  CRYPTO_COINS,
  getKalshiCachedData, fetchKalshiTarget,
  getLatestCoinSignals,
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
  /** stat_ml early-fire: true when the callback fired before Claude returned (claudeAbove was null). */
  statMLEarlyFire?: boolean;
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

// Invoked once when the initial pipeline completes for a coin (isRecheck=false).
// Registered by kalshi-bot-loop.ts to trigger an immediate entry evaluation.
// Fire-and-forget; errors inside the callback are the caller's responsibility.
let _pipelineCompleteCallback: ((sym: string, windowKey: string, result: PipelineResult) => void) | null = null;

// Returns the current decision mode — registered by kalshi-bot-loop.ts so the
// pipeline can check whether Claude is required without a circular import.
let _decisionModeGetter: (() => string) | null = null;

/**
 * Register a callback that fires once per coin per window when all three
 * models (Stat, Claude, ML) have returned directions.  Only one callback
 * is supported — calling this again replaces the previous registration.
 * Must be registered before the first window pipeline runs.
 */
export function registerPipelineCompleteCallback(
  fn: (sym: string, windowKey: string, result: PipelineResult) => void,
): void {
  _pipelineCompleteCallback = fn;
}

/**
 * Register a getter that returns the current bot decision mode.
 * Used by the pipeline to determine whether Claude is required (stat_ml
 * fires as soon as Stat+ML are ready; other modes wait for all three).
 * Must be registered by kalshi-bot-loop.ts before the first window.
 */
export function registerDecisionModeGetter(fn: () => string): void {
  _decisionModeGetter = fn;
}

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
 * Re-read the predictor's signals for a coin's window.  Used (a) every 2-3
 * min for open positions to detect consensus flips, and (b) by the bot tick
 * to keep polling until all three signals are non-null.  Returns the updated
 * result or null on failure.  Updates pipelineResults so subsequent ticks
 * see the fresh signals.
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
  //   stat   → getCachedPrediction (predCache) vs Kalshi strike
  //   claude → getTrackerWindowCall  (null when autopilot off OR tracker not done yet)
  //   ml     → fresh inference with tracker's latest pred snapshot (~30 s cadence)
  //   wm     → getWindowBetSignal
  //
  // The bot NEVER computes signals itself — it only reads what the predictor
  // tool already produced, so the pipeline can never show a different
  // direction than the predictor page for the same coin and window.
  if (!isRecheck) pipelinePhaseMap.set(`${sym}:${windowKey}`, "fetching-data");
  const signals = getLatestCoinSignals(sym);
  const statAbove: boolean | null = signals.statAbove;
  const statConfidence: number | null = signals.statConfidence;
  const claudeAbove: boolean | null = signals.claudeAbove;
  const claudeConfidence: number | null = signals.claudeConfidence;
  const mlAbove: boolean | null = signals.mlAbove;
  const mlConfidence: number | null = signals.mlConfidence;
  const claudeCallMs = 0;

  logger.debug(
    { sym, windowKey, statAbove, statConfidence, claudeAbove, mlAbove, wmRecommendation: signals.wmRecommendation, isRecheck },
    "[pipeline] unified signals read from predictor layer",
  );

  // ── Step 5: Store and return ─────────────────────────────────────────────
  // NO fallbacks: the bot never computes its own stat and never makes its own
  // Claude call.  The predictor tool is the ONLY place those are computed —
  // if a signal is still null the completion trigger below simply waits and
  // the re-check loop polls again until the predictor has produced it.
  const result: PipelineResult = {
    sym, windowKey, completedAt: Date.now(),
    kalshiTarget,
    statAbove, statConfidence,
    claudeAbove, claudeConfidence,
    mlAbove, mlConfidence,
    claudeCallMs, isRecheck,
  };

  // Determine mode BEFORE storing result so statMLEarlyFire can be embedded.
  const currentMode = _decisionModeGetter?.() ?? "classic";
  const isStatML = currentMode === "stat_ml";

  // statMLEarlyFire: set when stat_ml fires the callback while claudeAbove is
  // still null.  Stored in the result for downstream diagnostics and history.
  if (isStatML && claudeAbove === null) {
    (result as PipelineResult).statMLEarlyFire = true;
  }

  // Capture the previous result BEFORE overwriting — used below to detect the
  // null→non-null stat transition on re-checks.
  const prevResult = pipelineResults.get(`${sym}:${windowKey}`);
  pipelineResults.set(`${sym}:${windowKey}`, result);

  logger.info(
    { sym, windowKey, statAbove, claudeAbove, mlAbove, isRecheck, statMLEarlyFire: result.statMLEarlyFire },
    `[pipeline] ${isRecheck ? "re-check" : "initial"} complete`,
  );

  // Fire the completion callback exactly once per window, the first time the
  // required model signals are non-null.
  //
  // stat_ml mode: fires as soon as Stat+ML are both non-null (Claude not required).
  // All other modes: fires when all THREE (Stat, Claude, ML) are non-null.
  //
  // HARD RULE: the bot must never enter a bet with a missing REQUIRED signal.
  // For stat_ml, Claude being null is fine — it is never required.
  // For other modes, if any of statAbove/claudeAbove/mlAbove is still null
  // we log and wait — the re-check loop keeps polling.
  //
  // Guard: prevAnyWasNull ensures the callback fires AT MOST ONCE per window.
  // Note: currentMode and isStatML are computed above (before result is stored).

  // Determine "ready" based on which signals are required for the active mode.
  const allSignalsReady = isStatML
    ? (statAbove !== null && mlAbove !== null)
    : (statAbove !== null && claudeAbove !== null && mlAbove !== null);

  if (_pipelineCompleteCallback && allSignalsReady) {
    const prevAnyWasNull = isStatML
      ? (prevResult == null || prevResult.statAbove === null || prevResult.mlAbove === null)
      : (prevResult == null || prevResult.statAbove === null || prevResult.claudeAbove === null || prevResult.mlAbove === null);
    if (!isRecheck || prevAnyWasNull) {
      try {
        logger.info(
          { sym, windowKey, isRecheck, prevAnyWasNull, mode: currentMode },
          "[pipeline] completion trigger: required signals ready — firing entry callback",
        );
        _pipelineCompleteCallback(sym, windowKey, result);
      } catch {
        // non-fatal — the next scheduler tick will pick up the pipeline result
      }
    }
  } else if (_pipelineCompleteCallback && !allSignalsReady) {
    logger.info(
      { sym, windowKey, statAbove, claudeAbove, mlAbove, isRecheck, mode: currentMode },
      isStatML
        ? "[pipeline] stat_ml: waiting for Stat+ML signals — entry callback NOT fired (re-check loop will retry)"
        : "[pipeline] waiting for all signals (Stat+Claude+ML) — entry callback NOT fired (re-check loop will retry)",
    );
  }

  return result;
}

