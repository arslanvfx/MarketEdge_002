import { db, kalshiBotBetsTable, botConfigTable, botAutoTuneLogTable } from "@workspace/db";
import { isAiFeatureEnabled } from "./ai-spend";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  checkMaxBetSizeGuard, checkDailyLossGuard, checkStreakPauseGuard,
  checkSlippageStrikeGuard, checkWindowMonitorReadyGuard, applyStayAwayGateDecision,
  checkBalanceGuard, checkExposureGuard, applyDailyLossUpdate, applyStreakUpdate,
  checkDuplicatePositionGuard, checkManualPositionExistsGuard, checkManualSourceGuard,
} from "./kalshi-bot-guards";
import {
  DEFAULT_BOT_CONFIG, BET_PROFILES, computeDynamicBetSize, makeBotDecision,
  isInQuietHours, applyBetOutcome, tickCircuitBreakerWindow,
  deriveRegime, isLiveModePermitted, assertSetBotModeAllowed, resolveStartupMode,
  applyStartupModeRestore, buildStreakSnapshot, restoreStreakState,
  computeStrikeProximityGate,
  getEffectiveProximityThreshold,
  type BotConfig, type BotDecision, type CircuitBreakerState, type PriceRegime,
  type DecisionMode, type CoinStreakEntry,
} from "./kalshi-bot-engine";
import {
  makeInitialExitState, runExitGuard, type ExitState, type GuardStates,
} from "./kalshi-bot-exit";
import {
  buyYes, buyNo, sellYes, sellNo, getBalance, isKalshiConfigured, placeOrderWithRetry,
  getCachedKalshiBalance, invalidateBalanceCache, computeMarketableLimitPrice,
  fetchKalshiMarketResult, fetchKalshiSettledMarkets, cancelOrder, getOrder,
} from "./kalshi-trader";
import {
  getKalshiWindowContext, getWindowBetSignal, getTimingAnalysis, intraWindowMetrics,
  getCachedPrediction, getKalshiCachedData, fetchKalshiTarget, fetchLiveDirection,
  fetchTrendStabilityForBot, getPredictionAnalytics, getConfirmedTargetMs,
  getLatestCoinSignals,
  CRYPTO_COINS, KALSHI_SERIES, currentWindowKey, liveDirectionCache, type TrendStability,
} from "./crypto";
import {
  computePerformanceReport, runAutoTuneRules, decrementPausedCoins,
  type PerformanceReport, type AutoTuneMutation, type SettledBetRecord,
} from "./kalshi-bot-performance";
import {
  persistCoinStreakState, loadCoinStreakState, type StreakDbStore,
} from "./kalshi-bot-streak-db";
import {
  S, openPositions, midExitedWindows, lastGuardStatesMap, lastGuardReasonMap,
  lastDecisionWindowKey, prefetchedTicker, windowBetCounts, windowTotalBets,
  windowBetDetails, windowDirectionCounts, windowFailedFills, windowZeroFillAttempts,
  convictionFiredThisWindow, convictionEmergencyCloses, convictionBoostWindowCoins, coinConvictionWinRates, getBotDecisionMode, maxBetWindowToken,
  convictionAbortCooldown, CONVICTION_ABORT_COOLDOWN_MS, windowRandomizerUsedValues,
  maxBetCandidateForWindow,
  pausedCoins, paperCoinDailyLoss, liveCoinDailyLoss, paperCoinStreakState,
  liveCoinStreakState, coinSlippageStrikes, recentWindowOutcomes, recentUnanimousOutcomes, recentDirectionalOutcomes, directionalDampenerCooldown, windowCBBuffer,
  cachedPerformanceReportByMode, recentKalshiTargets, windowStabilityCache,
  paperStreakStore, liveStreakStore, makeStreakStore, streakStoreForMode,
  activeCoinDailyLoss, coinDailyLossForMode, activeCoinStreakState,
  coinStreakStateForMode, todayUTC, probeDb, resetDailyIfNeeded,
  NOISE_CONFIDENCE_FLOOR, MIN_HARD_MODEL_SIGNALS, DB_DEGRADED_THRESHOLD,
  DB_DEGRADED_MIN_WINDOW_MS, REGIME_STRIKES_MAX,
  STABILITY_WAIT_MAX_S, COIN_YES_BLOCKED, COIN_FULLY_BLOCKED, TIMING_CACHE_TTL,
  WINDOW_ENTRY_BUFFER_S, coinStabilityCache, coinTrajectoryCache, extremeCautionAbortedThisWindow,
  type BotMode, type BotStatus, type OpenPosition, type OpenPositionDisplay,
  type BotStateSnapshot, type WindowCoinEvaluation, type ParoleState, type CoinStabilityResult,
} from "./kalshi-bot-state";
import { evalClosedBets, reEvaluateSettledBets } from "./kalshi-bot-eval";
import { evalShadowBets, checkAllParoles, recordShadowBet } from "./kalshi-bot-shadow";
import { closePosition, persistBetRecord } from "./kalshi-bot-close";
import { runBotTickForCoin, refreshTrajectoryForAllCoins } from "./kalshi-bot-tick";
import { getConvictionLivePrice } from "./kalshi-conviction-poller";
import {
  triggerWindowPipeline, runPipelineRecheck, registerPipelineCompleteCallback,
  type PipelineResult,
} from "./kalshi-bot-pipeline";
import {
  _persistModeToConfig, updateBotConfig, loadDailyPnlFromDB, loadCoinDailyLossFromDB,
  loadCoinStreakStateFromDB, loadWindowBetCountsFromDB, loadRegimeCache,
  loadBorderProximityCache, getTimingAccuracy,
} from "./kalshi-bot-db";

// ---------------------------------------------------------------------------
// Bot loop — called from index.ts every 30 s
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Window-open pre-fetch orchestrator
// ---------------------------------------------------------------------------
// Fires once per window the moment EITHER the bot loop OR the prediction
// tracker detects a new window key.  Runs all prerequisite data collection
// in a strict checks-and-balances chain:
//
//   Step 1 — Parallel Kalshi target fetch (all coins simultaneously).
//             Each coin is checked independently.  A coin is only considered
//             "confirmed" when its Kalshi cache has a non-null strike AND a
//             non-null yes-price.  Coins where Kalshi has not yet published
//             the new market are logged as deferred — they fall back to the
//             per-tick retry in runBotLoopTick.
//
//   Step 2 — Stability analysis dispatch (gated on Step 1 per coin).
//             Only fires for coins that PASSED Step 1.  Uses the shared
//             S.stabilityFiredForCoins guard so bot-loop retries cannot
//             double-dispatch.  On error/null result the coin is removed
//             from the guard so the bot loop can retry on the next tick.
//
// This ensures all signals are warm before the 120-second entry buffer
// clears, so the first eligible bet fires immediately rather than waiting
// an extra 30-60 seconds for lazy signal resolution.
export async function runWindowOpenPrefetch(windowKey: string): Promise<void> {
  const kalshiCoins = CRYPTO_COINS.filter(c => KALSHI_SERIES[c.symbol]);

  // ── Step 1: parallel Kalshi target fetches ──────────────────────────────
  // All coins fetched simultaneously.  Each result is checked for completeness
  // (non-null strike + yes-price) before Step 2 is allowed for that coin.
  const step1Results = await Promise.allSettled(
    kalshiCoins.map(async (c) => {
      const sym = c.symbol.toUpperCase();
      await fetchKalshiTarget(sym);
      const kd = getKalshiCachedData(sym);
      if (!kd?.value || kd.yesPrice == null) {
        throw new Error("Kalshi market not yet published");
      }
      return sym;
    }),
  );

  const confirmed: string[] = [];
  const deferred: string[] = [];
  step1Results.forEach((r, i) => {
    const sym = kalshiCoins[i].symbol.toUpperCase();
    if (r.status === "fulfilled") confirmed.push(sym);
    else deferred.push(sym);
  });

  if (confirmed.length > 0) {
    logger.info({ confirmed, windowKey }, "[prefetch] step 1 complete — Kalshi data confirmed");
    // Fire the window pipeline for every confirmed coin immediately after their
    // Kalshi target is available.  The pipeline runs sequentially per coin:
    //   Kalshi target → stat → Claude (rich prompt, explicit close time) → ML
    // Results are stored in pipelineResults; the bot tick gate will defer until
    // the pipeline completes rather than betting on stale cached signals.
    for (const sym of confirmed) {
      triggerWindowPipeline(sym, windowKey);
    }
  }
  if (deferred.length > 0) {
    logger.warn(
      { deferred, windowKey },
      "[prefetch] step 1 partial — Kalshi market not yet published for these coins; bot tick will retry",
    );
  }

  // ── Step 2: stability analysis, gated on Step 1 per coin ────────────────
  // Only coins that PASSED step 1 are dispatched here.  The shared
  // S.stabilityFiredForCoins guard prevents double-dispatch with the bot loop.
  if (getBotDecisionMode() === "conviction" || !isAiFeatureEnabled("crypto_stability") || confirmed.length === 0) return;

  const toDispatch = confirmed.filter(sym => !S.stabilityFiredForCoins.has(sym));
  if (toDispatch.length === 0) return;

  // Mark synchronously before any await — mirrors the bot-loop guard pattern.
  toDispatch.forEach(sym => S.stabilityFiredForCoins.add(sym));
  logger.info(
    { coins: toDispatch, windowKey },
    "[prefetch] step 2 — dispatching stability analysis (Kalshi confirmed for each)",
  );

  void Promise.all(
    toDispatch.map(sym =>
      fetchTrendStabilityForBot(sym, windowKey)
        .then(r => {
          if (r) {
            windowStabilityCache.set(sym, r.trendStability);
            logger.info(
              { sym, result: r.trendStability, windowKey },
              "[prefetch] step 2 complete — stability resolved",
            );
          } else {
            // Null result means no data came back — remove guard so bot loop retries.
            S.stabilityFiredForCoins.delete(sym);
            logger.warn({ sym, windowKey }, "[prefetch] step 2 null result — bot loop will retry");
          }
        })
        .catch(() => {
          // Error (Claude down, timeout, etc.) — remove guard so bot loop retries.
          S.stabilityFiredForCoins.delete(sym);
          logger.warn({ sym, windowKey }, "[prefetch] step 2 failed — bot loop will retry");
        }),
    ),
  );
}

// Prevents two runBotLoopTick invocations from running concurrently.
// The prefetch-triggered immediate tick and the scheduler tick can otherwise
// overlap if Claude stability analysis is still in-flight when the interval fires.
// The openPositions guard already prevents double-bets, but this lock avoids
// redundant Kalshi API calls and confusing interleaved log output.
// Tracks the last time a pipeline re-check was run for each open position.
// Keyed by sym — cleared on window change by the position-expiry logic.
const pipelineRecheckAt = new Map<string, number>();

// Conviction diagnostic throttle: logs Phase-3 price + decision once per
// 60s per coin so every window has at least one visible data point.
const convictionDiagLastLogAt = new Map<string, number>();

// ---------------------------------------------------------------------------
// Per-coin conviction win rates — refreshed at most once per hour
// ---------------------------------------------------------------------------
let _lastWinRateRefreshAt = 0;
async function refreshConvictionWinRates(): Promise<void> {
  const now = Date.now();
  if (now - _lastWinRateRefreshAt < 60 * 60 * 1000) return; // at most once per hour
  _lastWinRateRefreshAt = now;
  try {
    const result = await db.execute(sql`
      SELECT symbol,
        COUNT(*) FILTER (WHERE outcome = 'win')  AS wins,
        COUNT(*) FILTER (WHERE outcome = 'loss') AS losses
      FROM kalshi_bot_bets
      WHERE mode = 'live'
        AND decision_mode = 'conviction'
        AND action = 'expired'
        AND outcome IS NOT NULL
        AND created_at >= NOW() - INTERVAL '14 days'
      GROUP BY symbol
    `);
    const rows = result.rows ?? result;
    for (const row of (rows as unknown as { symbol: string; wins: string; losses: string }[])) {
      const wins   = parseInt(row.wins,   10) || 0;
      const losses = parseInt(row.losses, 10) || 0;
      const total  = wins + losses;
      if (total >= 3) {
        coinConvictionWinRates.set(row.symbol.toUpperCase(), wins / total);
      }
    }
    logger.debug(
      { rates: Object.fromEntries(coinConvictionWinRates) },
      "[kalshi-bot] conviction win rates refreshed",
    );
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] conviction win rate refresh failed — using cached values");
  }
}

// Tracks which `sym:windowKey` pairs have already had their pipeline-completion
// entry evaluation triggered.  The pipeline callback fires exactly once per coin
// per window when all three models (Stat, Claude, ML) have returned directions.
// The Phase-3 scheduler loop skips coins in this Set so the 15s polling tick
// cannot double-attempt an entry that was already evaluated by the trigger.
// Cleared on every window transition so each new window starts fresh.
const pipelineEntryFiredThisWindow = new Set<string>();

// ---------------------------------------------------------------------------
// Pipeline-completion entry trigger
// ---------------------------------------------------------------------------
// Registered once at module-load time.  When the initial pipeline finishes for
// a coin, the pipeline fires this callback synchronously; we add the coin to
// pipelineEntryFiredThisWindow (guards against double-fire) and schedule the
// entry evaluation asynchronously so we don't block the pipeline's finally{}.
registerPipelineCompleteCallback((_sym: string, _windowKey: string, _result: PipelineResult) => {
  const key = `${_sym}:${_windowKey}`;
  if (pipelineEntryFiredThisWindow.has(key)) return; // idempotent guard
  pipelineEntryFiredThisWindow.add(key);
  _firePipelineEntryForCoin(_sym, _windowKey).catch(err =>
    logger.warn({ err, sym: _sym, windowKey: _windowKey }, "[pipeline] completion-triggered entry failed (non-fatal)"),
  );
});

/**
 * Evaluate a single coin for entry immediately after its pipeline completes.
 * This replaces the time-based entry buffer as the "signals ready" gate:
 * instead of waiting a fixed number of seconds, we fire once the moment all
 * three models (Stat, Claude, ML) have directions for the current window.
 *
 * All existing quality gates (Gate 1, Gate 2, late-floor, EV, return gate) are
 * enforced inside runBotTickForCoin / _runBotTick — nothing is bypassed here.
 */
async function _firePipelineEntryForCoin(sym: string, windowKey: string): Promise<void> {
  if (!S.config.enabled || S.paused) {
    logger.debug({ sym, windowKey }, "[pipeline] completion trigger: bot disabled/paused — skipping entry");
    return;
  }
  if (S.dbDegradedSince !== null) {
    logger.debug({ sym, windowKey }, "[pipeline] completion trigger: DB degraded — skipping entry");
    return;
  }
  // Confirm the window is still current — late pipeline completions (>12min in) are
  // caught by the late-floor guard inside _runBotTick so this is just a fast-exit
  // for completions that arrive after the window has already rolled over.
  if (currentWindowKey() !== windowKey) {
    logger.debug({ sym, windowKey }, "[pipeline] completion trigger: window already expired — skipping entry");
    return;
  }
  // Skip if a position is already open for this coin — Phase 2 in the scheduler
  // tick will manage the exit; we do not open a second position.
  if (openPositions.has(sym)) {
    logger.debug({ sym, windowKey }, "[pipeline] completion trigger: position already open — skipping new entry");
    return;
  }

  // Conviction mode does NOT use pipeline-triggered entry.  The signal is the Kalshi
  // price crossing a threshold (≥90¢ YES or ≤10¢ NO) — model readiness is irrelevant
  // to that condition.  Release the lock so the per-tick loop (which checks the live
  // YES price every 5 s) handles entry whenever the threshold is actually crossed.
  // Without this guard the pipeline fires immediately on model completion while the
  // market is still pricing YES at 50¢, which bypasses the conviction price gate.
  if (S.config.decisionMode === "conviction") {
    pipelineEntryFiredThisWindow.delete(`${sym}:${windowKey}`);
    logger.debug({ sym, windowKey }, "[pipeline] conviction mode — pipeline-triggered entry skipped; per-tick loop handles price-cross entry");
    return;
  }

  const kalshiData = getKalshiCachedData(sym);
  const prediction  = getCachedPrediction(sym);

  // If the Kalshi market for this window hasn't published yet (ticker/strike/price can
  // all be null for 4-8 min after window-open), runBotTickForCoin would silently return
  // at the "no market data" guard — leaving the coin permanently locked in
  // pipelineEntryFiredThisWindow and blocking Phase-3 from ever retrying.
  // Release the lock so Phase-3's per-tick loop can place the bet once data arrives.
  if (!kalshiData?.ticker || kalshiData.value === null || kalshiData.yesPrice == null) {
    pipelineEntryFiredThisWindow.delete(`${sym}:${windowKey}`);
    logger.info(
      { sym, windowKey, hasTicker: !!kalshiData?.ticker, hasValue: kalshiData?.value != null, hasPrice: kalshiData?.yesPrice != null },
      "[pipeline] completion trigger: Kalshi market not ready — releasing lock for Phase-3 retry",
    );
    return;
  }

  // ── Bet delay with fresh re-analysis ────────────────────────────────────
  // When betDelayMinutes > 0, hold off from placing a bet until that many
  // minutes have elapsed since window-open.  If signals arrived before the
  // delay threshold, schedule a deferred entry: wait for the remaining time,
  // then run a fresh pipeline re-check (updated Claude + stat signals) and
  // fire the tick so the bot acts on current market direction — not the
  // opening snapshot.  Phase-3 sees the pipeline lock and leaves this coin
  // alone while the timer is pending.
  const betDelayMs = (S.config.betDelayMinutes ?? 0) * 60_000;
  if (betDelayMs > 0) {
    const windowKeyMs = new Date(windowKey).getTime();
    const clockElapsedMs = Date.now() - windowKeyMs;
    const remainingMs = betDelayMs - clockElapsedMs;

    if (remainingMs > 0) {
      logger.info(
        { sym, windowKey, betDelayMinutes: S.config.betDelayMinutes, clockElapsedMs: Math.round(clockElapsedMs), waitingMs: Math.round(remainingMs) },
        "[pipeline] bet delay active — holding entry, will re-analyze when delay elapses",
      );
      setTimeout(() => {
        _firePipelineEntryAfterDelay(sym, windowKey).catch(err =>
          logger.warn({ err, sym, windowKey }, "[pipeline] delayed entry error (non-fatal)"),
        );
      }, remainingMs);
      return; // hold here — the scheduled callback will do the actual entry
    }
    // Already past the delay (signals arrived late) — fall through to immediate entry
    // but still run a fresh re-check below before placing the bet.
    logger.info(
      { sym, windowKey, betDelayMinutes: S.config.betDelayMinutes, clockElapsedMs: Math.round(clockElapsedMs) },
      "[pipeline] bet delay already elapsed — running fresh re-check before entry",
    );
    await runPipelineRecheck(sym, windowKey);
  }

  logger.info({ sym, windowKey }, "[pipeline] completion trigger: all models ready — evaluating entry");

  try {
    const kd = getKalshiCachedData(sym);
    const pred = getCachedPrediction(sym);
    if (!kd?.ticker || kd.value === null || kd.yesPrice == null) {
      logger.warn({ sym, windowKey }, "[pipeline] Kalshi data vanished before entry — releasing lock");
      pipelineEntryFiredThisWindow.delete(`${sym}:${windowKey}`);
      return;
    }
    await runBotTickForCoin(sym, kd.ticker, kd.value, kd.yesPrice, pred?.candles ?? []);
  } catch (err) {
    logger.warn({ err, sym, windowKey }, "[pipeline] completion-triggered tick error (non-fatal)");
  }
}

/**
 * Called by the bet-delay timer.  Re-checks signals (fresh Claude + stat read)
 * then fires the entry tick.  Guards against window expiry and already-open positions.
 */
async function _firePipelineEntryAfterDelay(sym: string, windowKey: string): Promise<void> {
  if (!S.config.enabled || S.paused) return;
  if (S.dbDegradedSince !== null) return;
  if (currentWindowKey() !== windowKey) {
    logger.debug({ sym, windowKey }, "[pipeline] delayed entry: window expired — skipping");
    pipelineEntryFiredThisWindow.delete(`${sym}:${windowKey}`);
    return;
  }
  if (openPositions.has(sym)) {
    logger.debug({ sym, windowKey }, "[pipeline] delayed entry: position already open — skipping");
    return;
  }

  logger.info({ sym, windowKey, betDelayMinutes: S.config.betDelayMinutes }, "[pipeline] bet delay elapsed — running fresh re-analysis before entry");

  // Fresh re-check: updated Claude + stat signals so the entry decision
  // reflects current market direction, not the opening snapshot.
  try {
    await runPipelineRecheck(sym, windowKey);
  } catch (err) {
    logger.warn({ err, sym, windowKey }, "[pipeline] delayed re-check failed — proceeding with cached signals");
  }

  const kd = getKalshiCachedData(sym);
  const pred = getCachedPrediction(sym);
  if (!kd?.ticker || kd.value === null || kd.yesPrice == null) {
    logger.warn({ sym, windowKey }, "[pipeline] delayed entry: Kalshi data missing — releasing lock");
    pipelineEntryFiredThisWindow.delete(`${sym}:${windowKey}`);
    return;
  }

  logger.info({ sym, windowKey }, "[pipeline] delayed entry: firing entry tick with fresh signals");
  try {
    await runBotTickForCoin(sym, kd.ticker, kd.value, kd.yesPrice, pred?.candles ?? []);
  } catch (err) {
    logger.warn({ err, sym, windowKey }, "[pipeline] delayed entry tick error (non-fatal)");
  }
}

let tickInFlight = false;

// Tracks how many consecutive bot-evaluation windows had every coin skipped because
// yesPrice was null.  Three or more in a row almost certainly means the Kalshi API
// format changed and the parser needs updating — an ERROR is logged at that threshold.
let consecutiveAllNullPriceWindows = 0;
let lastAllNullPriceWindowKey = "";

// Iterates over all Kalshi-enabled coins, ensures fresh Kalshi market data is
// available (fetching from the public API if the cache is stale), then runs
// the bot tick for each coin.  The Kalshi market-data endpoint is public and
// requires no API key, so this works in both paper and live modes.
export async function runBotLoopTick(): Promise<void> {
  if (tickInFlight) {
    logger.debug("[kalshi-bot] tick already in flight — skipping concurrent call");
    return;
  }
  tickInFlight = true;
  try {
  // Evaluate any closed bets that haven't been stamped with outcome yet.
  // Fire-and-forget — outcome evaluation is non-blocking and non-fatal.
  evalClosedBets().catch(() => {});
  // Evaluate shadow (probe) bets from prior windows — also fire-and-forget.
  evalShadowBets().catch(() => {});

  // Always run window-expiry check, even when S.paused or disabled.
  // If the 15-minute window rolls over while a position is still open (e.g.
  // the bot was S.paused, or the tick was slow), we must mark it expired and
  // clear in-memory state so the next window starts fresh.
  if (openPositions.size > 0) {
    const currentKey = currentWindowKey();
    // Snapshot entries before iterating — deletes inside the loop are safe on a Map,
    // but a snapshot makes the control flow easier to reason about.
    for (const [posSymbol, stalePos] of Array.from(openPositions.entries())) {
      if (stalePos.windowKey !== currentKey) {
        logger.info(
          { sym: posSymbol, oldKey: stalePos.windowKey, newKey: currentKey },
          "[kalshi-bot] window expired — auto-closing open position",
        );
        // Clear immediately so a concurrent tick cannot double-close the same position.
        openPositions.delete(posSymbol);
        try {
          const kalshiData = getKalshiCachedData(posSymbol);
          await closePosition(
            stalePos,
            kalshiData?.yesPrice ?? null,
            kalshiData?.value ?? null,
            "window_expired",
          );
        } catch (err) {
          logger.warn({ err, sym: posSymbol }, "[kalshi-bot] window-expiry close error (non-fatal)");
        }
      }
    }
  }

  // Flush per-window circuit-breaker outcomes.
  // windowCBBuffer is populated by closePosition() for every window-expiry
  // closure.  Apply ONE S.cbState update per fully-closed window so that N
  // concurrent expiry closures don't each tick the consecutive-loss counter.
  // A window is considered "fully closed" as soon as its key is older than
  // the current 15-min window (the expiry loop above already processed it).
  if (windowCBBuffer.size > 0) {
    const flushKey = currentWindowKey();
    for (const [wk, wo] of Array.from(windowCBBuffer.entries())) {
      if (wk >= flushKey) continue; // window not yet closed — keep buffered
      const windowWon = wo.wins >= wo.losses; // majority-win decides the window outcome
      S.cbState = applyBetOutcome(S.cbState, windowWon, S.config.maxConsecutiveLosses, S.config.circuitBreakerPauseWindows);
      logger.info(
        { wk, wins: wo.wins, losses: wo.losses, windowWon, cbState: S.cbState },
        "[kalshi-bot] window CB flush — one outcome applied for closed window",
      );
      if (!windowWon && S.cbState.circuitBreakerWindowsRemaining > 0 && S.cbState.consecutiveLosses === S.config.maxConsecutiveLosses) {
        logger.warn({ cbState: S.cbState }, "[kalshi-bot] ⚡ circuit breaker TRIGGERED (window-level)");
      } else if (windowWon && S.cbState.consecutiveLosses === 0) {
        logger.info({ cbState: S.cbState }, "[kalshi-bot] window win — consecutive loss streak reset");
      }
      windowCBBuffer.delete(wk);
    }
  }

  // Circuit-breaker countdown: decrement once per 15-min window at the TOP of the loop
  // so the counter advances even when the bot is S.paused or in quiet hours.
  // The pre-decrement value is captured in `cbWindowsAtStart` so the gate below can
  // check it accurately — this ensures N configured pause windows = N windows actually
  // skipped (gate fires on the pre-decrement value, not the already-decremented one).
  const cbWindowNow = currentWindowKey();
  const isCBNewWindow = cbWindowNow !== S.lastCircuitBreakerWindowKey;
  const cbWindowsAtStart = S.cbState.circuitBreakerWindowsRemaining;
  if (isCBNewWindow) {
    S.lastCircuitBreakerWindowKey = cbWindowNow;
    // Reset per-window counters so all caps apply fresh each 15-min window.
    windowDirectionCounts.clear();
    windowFailedFills.clear();
    windowZeroFillAttempts.clear();
    windowRandomizerUsedValues.clear();
    convictionFiredThisWindow.clear();
    extremeCautionAbortedThisWindow.clear();
    convictionAbortCooldown.clear();
    convictionEmergencyCloses.clear();
    coinStabilityCache.clear();
    coinTrajectoryCache.clear();
    maxBetCandidateForWindow.clear(); // stale window keys no longer relevant
    // Global max-bet token: roll ONCE per window to decide whether any bet this
    // window is eligible for max-bet size.  The first qualifying coin claims it.
    // All other coins use regular size, regardless of their stability.
    {
      const prob = S.config.convictionStabilityMaxBetProbability ?? S.config.convictionBoostProbability ?? 0.25;
      const maxSlots = S.config.convictionStabilityMaxBetsPerWindow ?? 1;
      const tokenAvailable = Math.random() < prob;
      maxBetWindowToken.remaining = tokenAvailable ? maxSlots : 0;
      logger.info(
        { windowKey: cbWindowNow, prob, tokenAvailable, maxSlots },
        tokenAvailable
          ? `[kalshi-bot] max-bet token available this window (${maxSlots} slot${maxSlots !== 1 ? "s" : ""})`
          : "[kalshi-bot] no max-bet token this window — all bets regular size",
      );
    }
    convictionBoostWindowCoins.clear();
    refreshConvictionWinRates();   // async, fire-and-forget; used by win-rate gate in the tick
    windowTotalBets.delete(cbWindowNow);   // drop last window's total (keyed by new wk)
    // Clear bet details older than the current window to prevent map growth.
    for (const k of windowBetDetails.keys()) {
      if (!k.endsWith(`:${cbWindowNow}`)) windowBetDetails.delete(k);
    }
    if (S.cbState.circuitBreakerWindowsRemaining > 0) {
      S.cbState = tickCircuitBreakerWindow(S.cbState);
      logger.info(
        { circuitBreakerWindowsRemaining: S.cbState.circuitBreakerWindowsRemaining },
        "[kalshi-bot] circuit breaker countdown — windows remaining",
      );
    }
    // Decrement per-coin auto-tune pause counters; remove coins whose pause expires.
    const nextPausedCoins = decrementPausedCoins(pausedCoins);
    for (const [sym] of pausedCoins.entries()) {
      if (!nextPausedCoins.has(sym)) {
        logger.info({ sym }, "[kalshi-bot] auto-tune per-coin pause expired — resuming");
      } else {
        logger.info({ sym, remaining: nextPausedCoins.get(sym) }, "[kalshi-bot] auto-tune per-coin pause countdown");
      }
    }
    // Sync in-memory map with the decremented state
    for (const sym of Array.from(pausedCoins.keys())) {
      if (!nextPausedCoins.has(sym)) pausedCoins.delete(sym);
      else pausedCoins.set(sym, nextPausedCoins.get(sym)!);
    }

    // Temporary confidence raise revert: if auto-tune raised minConfidence for a
    // fixed number of windows, check whether the revert window has arrived and
    // restore the original value automatically.
    if (S.config.autoTuneConfidenceRevertAt && cbWindowNow >= S.config.autoTuneConfidenceRevertAt) {
      const revertTo = S.config.autoTuneConfidenceRevertTo ?? DEFAULT_BOT_CONFIG.minConfidence;
      logger.info(
        { from: S.config.minConfidence, to: revertTo, revertAt: S.config.autoTuneConfidenceRevertAt },
        "[auto-tune] temporary confidence raise expired — reverting to base",
      );
      await updateBotConfig({
        minConfidence: revertTo,
        autoTuneConfidenceRevertAt: null,
        autoTuneConfidenceRevertTo: null,
      }).catch(() => {});
    }
  }

  // Phase 1: refresh market data for all Kalshi-enabled coins — in parallel.
  // Runs unconditionally (before the enabled gate) so the UI always has fresh
  // Kalshi strike prices and trajectory data regardless of bot enabled state.
  await Promise.allSettled(
    CRYPTO_COINS
      .filter(c => KALSHI_SERIES[c.symbol])
      .map(c => fetchKalshiTarget(c.symbol).catch(() => null)),
  );

  // Refresh trajectory gate data for all coins — runs every tick from window open
  // so the UI and gate always have current velocity/projection data, even when
  // the bot is disabled or paused.
  refreshTrajectoryForAllCoins();

  if (!S.config.enabled || S.paused) return;

  // DB degraded mode: probe for recovery each tick; skip new bets until healthy.
  if (S.dbDegradedSince !== null) {
    const recovered = await probeDb();
    if (recovered) {
      const downMs = Date.now() - S.dbDegradedSince.getTime();
      logger.info(
        { downSeconds: Math.round(downMs / 1000) },
        "[kalshi-bot] DB probe succeeded — exiting degraded mode, resuming new bets",
      );
      S.dbDegradedSince = null;
      S.dbConsecutiveFailures = 0;
      S.dbFirstFailureAt = null;
    } else {
      logger.warn(
        { degradedSince: S.dbDegradedSince.toISOString() },
        "[kalshi-bot] DB still unreachable — skipping new bets this tick",
      );
      return;
    }
  }

  // Window-open prefetch + stability orchestration.
  // On a new window: clear per-window caches and immediately void-launch the
  // prefetch orchestrator (runWindowOpenPrefetch).  That function handles the
  // full Step-1 → Step-2 chain with proper checks-and-balances logging.
  //
  // Fallback per-tick retry (below): covers coins whose Kalshi market wasn't
  // published when the prefetch ran.  Uses the same S.stabilityFiredForCoins
  // guard so there is never a double-dispatch between the prefetch and here.
  const newWindowKey = currentWindowKey();
  if (newWindowKey !== S.lastStabilityWindowKey) {
    S.lastStabilityWindowKey = newWindowKey;
    S.stabilityFiredForCoins.clear();
    windowStabilityCache.clear();
    // Clear the live Claude direction cache so prior-window Claude responses cannot
    // satisfy the Claude-pending guard or act as a signal for the new window.  The
    // cache has a 2-min TTL but window boundaries are exactly 15 min — a prior-window
    // entry can survive into the new window and be treated as a current signal.
    liveDirectionCache.clear();
    logger.info({ windowKey: newWindowKey }, "[kalshi-bot] window transition: liveDirectionCache cleared");
    // Clear pipeline entry flags so the new window's completions each trigger
    // a fresh entry evaluation — prior-window keys are now stale.
    pipelineEntryFiredThisWindow.clear();
    // Fire the window-open pre-fetch burst immediately — runs in background.
    void runWindowOpenPrefetch(newWindowKey).catch(() => {});
  }
  // Per-tick fallback: pick up any coins the prefetch couldn't reach because
  // their Kalshi market wasn't published yet when the prefetch ran.
  const pendingCoins = CRYPTO_COINS.filter(c => {
    if (!KALSHI_SERIES[c.symbol]) return false;
    const sym = c.symbol.toUpperCase();
    if (S.stabilityFiredForCoins.has(sym)) return false;  // prefetch or earlier tick handled it
    const kd = getKalshiCachedData(sym);
    return kd?.value != null && kd.yesPrice != null;
  });
  if (pendingCoins.length > 0 && isAiFeatureEnabled("crypto_stability") && getBotDecisionMode() !== "conviction") {
    pendingCoins.forEach(c => S.stabilityFiredForCoins.add(c.symbol.toUpperCase()));
    void Promise.all(
      pendingCoins.map(c => {
        const sym = c.symbol.toUpperCase();
        return fetchTrendStabilityForBot(sym, newWindowKey)
          .then(r => {
            if (r) {
              windowStabilityCache.set(sym, r.trendStability);
              logger.info({ sym, result: r.trendStability, windowKey: newWindowKey }, "[kalshi-bot] fallback stability resolved");
            } else {
              S.stabilityFiredForCoins.delete(sym);
            }
          })
          .catch(() => { S.stabilityFiredForCoins.delete(sym); });
      }),
    );
    logger.info({ windowKey: newWindowKey, coins: pendingCoins.map(c => c.symbol) }, "[kalshi-bot] fallback stability dispatch — coins not yet handled by prefetch");
  }

  // Phase 2: manage exit for every open position (one tick per symbol).
  // _runBotTick returns early after managing an existing position so the
  // same coin does not immediately re-enter in Phase 4 of this tick.
  if (openPositions.size > 0) {
    // ── Conviction stop-loss ────────────────────────────────────────────────
    // Checked every tick before the normal exit path.
    // convictionStopLossFloor is an absolute contract-value floor in dollars
    // (e.g. 0.30 = exit when the contract we hold drops to 30¢ or below).
    //   YES position: contract value = yesPrice.  Exit when yesPrice ≤ floor.
    //   NO  position: contract value = 1 − yesPrice.  Exit when (1 − yesPrice) ≤ floor.
    // Near-zero guard: if the contract has already collapsed to ≤ 5¢ there
    // is no meaningful recovery value — skip the sell to avoid a pointless
    // transaction fee on a position that has already effectively expired worthless.
    const NEAR_ZERO_FLOOR = 0.05;
    const stopFloor = S.config.convictionStopLossFloor ?? 0;
    // Time-gate: only arm the stop-loss after convictionStopLossActivationMinute minutes
    // have elapsed in this window (default 12 = last 3 min).  Early-window dips can
    // recover — arming too early creates false stops on winning trades.
    const stopActivationMin = S.config.convictionStopLossActivationMinute ?? 0;
    const windowKeyMs = new Date(newWindowKey).getTime();
    const clockMinutesElapsed = (Date.now() - windowKeyMs) / 60000;
    const stopLossArmed = stopActivationMin === 0 || clockMinutesElapsed >= stopActivationMin;
    if (S.config.decisionMode === "conviction" && stopFloor > 0 && stopLossArmed) {
      for (const [sym, pos] of Array.from(openPositions.entries())) {
        const kd = getKalshiCachedData(sym);
        const yp = kd?.yesPrice ?? null;
        if (yp === null) continue;
        const contractValue = pos.direction === "yes" ? yp : (1 - yp);
        // Skip if already near-zero (no point selling worthless contracts).
        if (contractValue <= NEAR_ZERO_FLOOR) continue;
        if (contractValue > stopFloor) continue;

        logger.warn(
          { sym, direction: pos.direction,
            contractValue: +contractValue.toFixed(4),
            stopFloor,
            entryYesPrice: pos.entryYesPrice },
          "[kalshi-bot] conviction stop-loss triggered — selling position",
        );
        // Delete synchronously first — mirrors the window-expiry pattern so a
        // concurrent tick cannot double-close the same position.
        openPositions.delete(sym);
        try {
          await closePosition(pos, yp, kd?.value ?? null, "conviction_stop_loss", false, { gtcFallback: true });
        } catch (err) {
          logger.error({ err, sym }, "[kalshi-bot] conviction stop-loss exit failed — restoring position");
          openPositions.set(sym, pos);
        }
      }
    }

    for (const [sym] of Array.from(openPositions.entries())) {
      const kalshiData = getKalshiCachedData(sym);
      const prediction = getCachedPrediction(sym);
      try {
        await runBotTickForCoin(
          sym,
          kalshiData?.ticker ?? null,
          kalshiData?.value ?? null,
          kalshiData?.yesPrice ?? null,
          prediction?.candles ?? [],
        );
      } catch (err) {
        logger.warn({ err, sym }, "[kalshi-bot] exit tick error (non-fatal)");
      }
    }
  }

  // ── Pipeline re-check for open positions ──────────────────────────────────
  // Every PIPELINE_RECHECK_INTERVAL_MS (~2.5 min) re-run the signal pipeline
  // (Claude + stat + ML) for each open position.  If the resulting consensus
  // contradicts the direction we bet AND the current exit value is ≥ 50% of
  // the original entry cost, a SECOND independent pipeline run is immediately
  // triggered to confirm the flip is real before closing.  Both checks must
  // agree for the position to be closed — this prevents exiting on transient
  // noise (e.g. the stat mid-snap flip that often corrects within minutes).
  //
  // Gated by enableMidExit: when that flag is false the recheck still runs for
  // display-refresh purposes but will never trigger a close.
  const PIPELINE_RECHECK_INTERVAL_MS = 150_000; // 2.5 min
  if (openPositions.size > 0) {
    for (const [sym, pos] of Array.from(openPositions.entries())) {
      const lastRecheck = pipelineRecheckAt.get(sym) ?? 0;
      if (Date.now() - lastRecheck < PIPELINE_RECHECK_INTERVAL_MS) continue;
      pipelineRecheckAt.set(sym, Date.now());

      void runPipelineRecheck(sym, pos.windowKey).then(async (result) => {
        if (!result) return;
        const currentPos = openPositions.get(sym);
        if (!currentPos || currentPos.windowKey !== pos.windowKey) return;

        const betAbove = currentPos.direction === "yes";
        // Consensus check: stat + Claude majority must flip AND ML must also
        // confirm the new direction before we consider exiting.  All three
        // models agreeing is the required signal that direction has genuinely
        // shifted — not just short-term noise in one or two indicators.
        const mlAgainstBet = result.mlAbove !== null && result.mlAbove !== betAbove;
        const signals = [result.statAbove, result.claudeAbove];
        const signalsForBet = signals.filter(s => s === betAbove).length;
        const signalsAgainstBet = signals.filter(s => s !== null && s !== betAbove).length;

        logger.info(
          { sym, betAbove, signalsForBet, signalsAgainstBet, mlAgainstBet,
            statAbove: result.statAbove, claudeAbove: result.claudeAbove, mlAbove: result.mlAbove },
          "[pipeline-recheck] consensus check for open position",
        );

        if (signalsAgainstBet === 0 || signalsAgainstBet <= signalsForBet || !mlAgainstBet) return;

        // Respect the minimum hold period — even if signals have flipped, we
        // don't exit before the position has been held for minHoldMinutes.
        // The next recheck (2.5 min later) will re-evaluate if it's still flipped.
        const minHoldMs = (S.config.minHoldMinutes ?? 4) * 60_000;
        if (Date.now() - currentPos.openedAt < minHoldMs) {
          logger.info(
            { sym, heldSec: Math.round((Date.now() - currentPos.openedAt) / 1000), signalsAgainstBet },
            "[pipeline-recheck] consensus flipped but within minimum hold period — holding",
          );
          return;
        }

        const kd = getKalshiCachedData(sym);
        const currentYesPrice = kd?.yesPrice ?? null;
        if (currentYesPrice == null) return;

        const exitValue = betAbove ? currentYesPrice : (1 - currentYesPrice);
        const entryCost = betAbove ? currentPos.entryYesPrice : (1 - currentPos.entryYesPrice);
        const exitRatio = exitValue / Math.max(entryCost, 0.01);

        if (exitRatio < 0.50) {
          logger.info(
            { sym, exitRatio: exitRatio.toFixed(3), signalsAgainstBet },
            "[pipeline-recheck] all models flipped but exit value < 50% of entry cost — waiting for recovery uptick",
          );
          return;
        }

        // ── enableMidExit guard ───────────────────────────────────────────────
        // If mid-exit is disabled in config, the recheck still runs for
        // display-refresh purposes but must not close positions.
        // Use truthy check so null/undefined from older DB rows also disables.
        if (!S.config.enableMidExit) {
          logger.info(
            { sym, signalsAgainstBet, exitRatio: exitRatio.toFixed(3) },
            "[pipeline-recheck] all models flipped but enableMidExit=false — holding per config",
          );
          return;
        }

        // ── Double-check: run a second independent pipeline read before closing ─
        // A single flipped read can be a transient artifact (stat mid-snap noise,
        // a momentary Claude re-call, etc.).  Re-running all three models right
        // now gives us a second independent read; both must agree on the flip
        // before we execute the close order.
        logger.info(
          { sym, betAbove, exitRatio: exitRatio.toFixed(3) },
          "[pipeline-recheck] first check confirms flip — running double-check before close",
        );
        const confirmResult = await runPipelineRecheck(sym, pos.windowKey);
        if (!confirmResult) {
          logger.info({ sym }, "[pipeline-recheck] double-check returned no result — holding");
          return;
        }

        const confirmMlAgainst    = confirmResult.mlAbove !== null && confirmResult.mlAbove !== betAbove;
        const confirmSignals      = [confirmResult.statAbove, confirmResult.claudeAbove];
        const confirmForBet       = confirmSignals.filter(s => s === betAbove).length;
        const confirmAgainstBet   = confirmSignals.filter(s => s !== null && s !== betAbove).length;
        const doubleCheckFailed   = confirmAgainstBet === 0 || confirmAgainstBet <= confirmForBet || !confirmMlAgainst;

        logger.info(
          { sym, betAbove, confirmForBet, confirmAgainstBet, confirmMlAgainst,
            statAbove: confirmResult.statAbove, claudeAbove: confirmResult.claudeAbove, mlAbove: confirmResult.mlAbove },
          "[pipeline-recheck] double-check result",
        );

        if (doubleCheckFailed) {
          logger.info(
            { sym, confirmForBet, confirmAgainstBet, confirmMlAgainst },
            "[pipeline-recheck] double-check shows recovery or disagreement — holding position, not closing",
          );
          return;
        }

        logger.warn(
          { sym, betAbove, exitRatio: exitRatio.toFixed(3), signalsForBet, signalsAgainstBet, confirmAgainstBet },
          "[pipeline-recheck] both checks confirm flip — closing position",
        );

        // Synchronously delete before the async close to prevent double-close.
        openPositions.delete(sym);
        try {
          await closePosition(currentPos, currentYesPrice, kd?.value ?? null, "pipeline_recheck_flip");
        } catch (err) {
          // Close failed (e.g. Kalshi API error) — restore position so Phase 2 retries.
          openPositions.set(sym, currentPos);
          logger.error({ err, sym }, "[pipeline-recheck] close failed — position restored");
        }
      }).catch(() => {});
    }
  }

  // ── Periodic display-refresh pipeline re-check (all coins) ─────────────
  // Re-run stat + Claude every PIPELINE_RECHECK_INTERVAL_MS for every active
  // Kalshi coin — not just those with open positions — so the pipeline-status
  // UI always shows up-to-date signals throughout the 15-min window.
  // ML is not re-run (its feature vector is fixed at window open); Claude and
  // stat are re-checked and the updated result is stored so the window-eval
  // endpoint reflects the current model consensus.
  {
    const recheckWK = currentWindowKey();
    for (const coin of CRYPTO_COINS.filter(c => KALSHI_SERIES[c.symbol])) {
      const sym = coin.symbol;
      if (openPositions.has(sym)) continue; // already rechecked above
      const displayKey = `display:${sym}`;
      const lastDisplayRecheck = pipelineRecheckAt.get(displayKey) ?? 0;
      if (Date.now() - lastDisplayRecheck < PIPELINE_RECHECK_INTERVAL_MS) continue;
      pipelineRecheckAt.set(displayKey, Date.now());
      void runPipelineRecheck(sym, recheckWK).catch(() => {});
    }
  }

  // Quiet-hours gate: skip new entries during the configured UTC hour range.
  if (!S.config.freeRunMode && isInQuietHours(new Date().getUTCHours(), S.config.quietHoursStart, S.config.quietHoursEnd)) {
    logger.debug(
      { utcHour: new Date().getUTCHours(), quietHoursStart: S.config.quietHoursStart, quietHoursEnd: S.config.quietHoursEnd },
      "[kalshi-bot] quiet hours — skipping new entry",
    );
    if (isCBNewWindow) {
      const qhWindowKey = currentWindowKey();
      const qhNow = new Date().toISOString();
      S.lastWindowEvaluation = CRYPTO_COINS
        .filter(c => KALSHI_SERIES[c.symbol])
        .map(c => ({
          symbol: c.symbol.toUpperCase(),
          action: "SKIP" as const,
          confidence: 0,
          score: 0,
          reason: "quiet hours — no new entries",
          windowKey: qhWindowKey,
          selected: false,
          betPlacedThisWindow: false,
          evaluatedAt: qhNow,
          trendStability: null,
          regime: null,
        }));
    }
    return;
  }

  // Circuit breaker gate: gate on the PRE-decrement snapshot so that N pause windows
  // = N windows where new entries are blocked (countdown already advanced at top of loop).
  if (cbWindowsAtStart > 0) {
    logger.info(
      { circuitBreakerWindowsRemaining: S.cbState.circuitBreakerWindowsRemaining },
      "[kalshi-bot] circuit breaker active — skipping new entry",
    );
    // On a window transition, refresh S.lastWindowEvaluation with SKIP entries so the
    // dashboard panel clears stale BET PLACED badges from the previous window.
    // Without this, the panel stays frozen on old window data indefinitely while S.paused.
    if (isCBNewWindow) {
      const cbWindowKey = currentWindowKey();
      const cbNow = new Date().toISOString();
      S.lastWindowEvaluation = CRYPTO_COINS
        .filter(c => KALSHI_SERIES[c.symbol])
        .map(c => ({
          symbol: c.symbol.toUpperCase(),
          action: "SKIP" as const,
          confidence: 0,
          score: 0,
          reason: `circuit breaker S.paused (${S.cbState.circuitBreakerWindowsRemaining} window${S.cbState.circuitBreakerWindowsRemaining === 1 ? "" : "s"} remaining)`,
          windowKey: cbWindowKey,
          selected: false,
          betPlacedThisWindow: false,
          evaluatedAt: cbNow,
          trendStability: null,
          regime: null,
        }));
    }
    return;
  }

  // Phase 3: best-market selection.
  // Speculatively evaluate all eligible coins with makeBotDecision to rank
  // candidates. Coins that already have an open position (managed above in
  // Phase 2) will skip entry in _runBotTick so only genuinely idle symbols
  // compete for a new position. Other coins follow for SKIP record deduplication.
  const windowKey = currentWindowKey();
  const evalResults: WindowCoinEvaluation[] = [];

  // --- Window-doubt penalty ---
  // If the last 1-2 completed windows had a poor win rate (<40%) the market
  // is in an uncertain/choppy regime. Raise the effective confidence floor
  // by 4pp (one bad window) or 8pp (two consecutive bad windows) to avoid
  // over-betting into noise.
  //
  // IMPORTANT: the lookback is TIME-based, not data-based.  We generate the
  // last 2 completed window keys from Date.now() regardless of whether any
  // bets were placed in those windows.  Windows with no entries in
  // recentWindowOutcomes are treated as NEUTRAL (the total >= 1 guard skips
  // them).  This prevents a deadlock where the penalty is high enough to stop
  // all bets, but no bets means no new map entries, so the bad windows from
  // before the lockout are permanently "the last 2" and the penalty never clears.
  //
  // With time-based lookback: after one empty window passes, the penalty
  // drops from 8pp → 4pp (only 1 bad window in the last 2).  After two empty
  // windows it clears entirely.
  const DOUBT_WIN_RATE_THRESHOLD = 0.4;
  const nowMs = Date.now();
  // Generate the 2 most-recently-completed window keys from wall-clock time.
  const completedWindowKeys: string[] = [1, 2].map(i => {
    const ms = Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000) - i * 15 * 60_000;
    return new Date(ms).toISOString().slice(0, 16);
  });
  let windowDoubtPenalty = 0;
  let weakWindowCount = 0;
  const neutralWindows: string[] = [];
  for (const wk of completedWindowKeys) {
    const wo = recentWindowOutcomes.get(wk);
    if (!wo) {
      // No bet data for this window — treat as neutral, not weak.
      neutralWindows.push(wk);
      continue;
    }
    const total = wo.wins + wo.losses;
    if (total >= 1 && wo.wins / total < DOUBT_WIN_RATE_THRESHOLD) weakWindowCount++;
  }
  if (weakWindowCount >= 2) windowDoubtPenalty = 4;
  else if (weakWindowCount === 1) windowDoubtPenalty = 2;
  if (windowDoubtPenalty > 0) {
    logger.info(
      { windowDoubtPenalty, weakWindowCount, checkedWindows: completedWindowKeys, neutralWindows },
      `[kalshi-bot] doubt penalty: ${weakWindowCount} recent window(s) <${DOUBT_WIN_RATE_THRESHOLD * 100}% win rate — confidence floor +${windowDoubtPenalty}pp`,
    );
  } else if (neutralWindows.length > 0) {
    logger.info(
      { checkedWindows: completedWindowKeys, neutralWindows },
      "[kalshi-bot] doubt penalty cleared — recent windows have no bet data (treated as neutral)",
    );
  }
  // Store for Task-C signal enrichment: _runBotTick includes this in the signals JSON.
  if (S.config.freeRunMode) windowDoubtPenalty = 0;
  S.currentWindowDoubtPenalty = windowDoubtPenalty;

  // Unanimous-failure guard: secondary penalty that fires when ALL models have been
  // agreeing and still losing together.  Separate from the general doubt penalty
  // (which fires on any losing window) — this targets specifically the "correlated
  // model failure" pattern where stat+Claude+ML all call the same direction wrong.
  //
  // Same time-based lookback as doubt penalty so it self-clears after 1–2 empty
  // windows: after one empty window the weak-count drops 2→1 (3pp→0) and after
  // two it's fully gone.  Shadow parole can also reduce it early.
  const UNANIMOUS_FAILURE_THRESHOLD = 0.4;
  const UNANIMOUS_FAILURE_PENALTY_PP = 4;
  let unanimousFailurePenalty = 0;
  let unanimousWeakWindowCount = 0;
  for (const wk of completedWindowKeys) {
    const uo = recentUnanimousOutcomes.get(wk);
    if (!uo) continue; // no unanimous bets in that window → neutral
    const uTotal = uo.wins + uo.losses;
    if (uTotal >= 1 && uo.wins / uTotal < UNANIMOUS_FAILURE_THRESHOLD) unanimousWeakWindowCount++;
  }
  if (unanimousWeakWindowCount >= 2) unanimousFailurePenalty = UNANIMOUS_FAILURE_PENALTY_PP;
  else if (unanimousWeakWindowCount === 1) unanimousFailurePenalty = Math.floor(UNANIMOUS_FAILURE_PENALTY_PP / 2);
  if (unanimousFailurePenalty > 0) {
    logger.info(
      { unanimousFailurePenalty, unanimousWeakWindowCount, checkedWindows: completedWindowKeys },
      `[kalshi-bot] unanimous failure guard: ${unanimousWeakWindowCount} window(s) unanimous <${UNANIMOUS_FAILURE_THRESHOLD * 100}% WR — confidence floor +${unanimousFailurePenalty}pp`,
    );
  }
  if (S.config.freeRunMode) unanimousFailurePenalty = 0;
  S.currentUnanimousFailurePenalty = unanimousFailurePenalty;

  // ── Directional regime dampener ───────────────────────────────────────────
  // Tracks YES and NO win rates over recent completed windows. Once the penalty
  // fires it persists for directionalRegressionLookback windows via a cooldown
  // Map (directionalDampenerCooldown) — this prevents the penalty from clearing
  // early when sparse/empty windows temporarily drop the sample below minBets.
  const _dirLookback = S.config.directionalRegressionLookback ?? 3;
  const _dirThreshold = S.config.directionalRegressionThreshold ?? 0.35;
  const _dirPenaltyPp = S.config.directionalRegressionPenaltyPp ?? 10;
  const _currentWk = new Date(Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000)).toISOString().slice(0, 16);
  let _yesWinsTotal = 0, _yesLossesTotal = 0, _noWinsTotal = 0, _noLossesTotal = 0;
  for (let _di = 1; _di <= _dirLookback; _di++) {
    const _dms = Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000) - _di * 15 * 60_000;
    const _dwk = new Date(_dms).toISOString().slice(0, 16);
    const _dd = recentDirectionalOutcomes.get(_dwk);
    if (!_dd) continue;
    _yesWinsTotal += _dd.yesWins;
    _yesLossesTotal += _dd.yesLosses;
    _noWinsTotal += _dd.noWins;
    _noLossesTotal += _dd.noLosses;
  }
  const _yesTotal = _yesWinsTotal + _yesLossesTotal;
  const _noTotal = _noWinsTotal + _noLossesTotal;

  // Cooldown helper: returns true if the dampener fired within the last N windows.
  const _dirCooldownActive = (dir: string): boolean => {
    const _lastFired = directionalDampenerCooldown.get(dir);
    if (!_lastFired) return false;
    const _windowsAgo = (Date.parse(_currentWk) - Date.parse(_lastFired)) / (15 * 60_000);
    return _windowsAgo <= _dirLookback;
  };

  let directionalPenaltyYesPp = 0;
  let directionalPenaltyNoPp = 0;
  if (!S.config.freeRunMode) {
    // YES: fires on fresh data OR persists via cooldown.
    if (_yesTotal >= 2 && _yesWinsTotal / _yesTotal < _dirThreshold) {
      directionalPenaltyYesPp = _dirPenaltyPp;
      directionalDampenerCooldown.set("yes", _currentWk);
      logger.info(
        { yesWins: _yesWinsTotal, yesLosses: _yesLossesTotal, winRate: (_yesWinsTotal / _yesTotal).toFixed(2), threshold: _dirThreshold, penaltyPp: _dirPenaltyPp, lookback: _dirLookback, cooldownWindow: _currentWk },
        `[kalshi-bot] directional dampener: YES win rate ${(_yesWinsTotal / _yesTotal * 100).toFixed(0)}% < ${_dirThreshold * 100}% — +${_dirPenaltyPp}pp on YES bets (cooldown started)`,
      );
    } else if (_dirCooldownActive("yes")) {
      directionalPenaltyYesPp = _dirPenaltyPp;
      logger.info(
        { penaltyPp: _dirPenaltyPp, lastFired: directionalDampenerCooldown.get("yes"), currentWk: _currentWk },
        `[kalshi-bot] directional dampener: YES cooldown active — +${_dirPenaltyPp}pp persists through sparse window`,
      );
    }
    // NO: fires on fresh data OR persists via cooldown.
    if (_noTotal >= 2 && _noWinsTotal / _noTotal < _dirThreshold) {
      directionalPenaltyNoPp = _dirPenaltyPp;
      directionalDampenerCooldown.set("no", _currentWk);
      logger.info(
        { noWins: _noWinsTotal, noLosses: _noLossesTotal, winRate: (_noWinsTotal / _noTotal).toFixed(2), threshold: _dirThreshold, penaltyPp: _dirPenaltyPp, lookback: _dirLookback, cooldownWindow: _currentWk },
        `[kalshi-bot] directional dampener: NO win rate ${(_noWinsTotal / _noTotal * 100).toFixed(0)}% < ${_dirThreshold * 100}% — +${_dirPenaltyPp}pp on NO bets (cooldown started)`,
      );
    } else if (_dirCooldownActive("no")) {
      directionalPenaltyNoPp = _dirPenaltyPp;
      logger.info(
        { penaltyPp: _dirPenaltyPp, lastFired: directionalDampenerCooldown.get("no"), currentWk: _currentWk },
        `[kalshi-bot] directional dampener: NO cooldown active — +${_dirPenaltyPp}pp persists through sparse window`,
      );
    }
  }

  // Universal shadow parole — computed once per tick, covers ALL restriction types.
  // checkAllParoles queries shadow bet accuracy grouped by (symbol, blockedBy) and
  // returns bypass sets that each gate in the per-coin loop checks before blocking.
  // Side effects: auto-tune early revert + streak-pause clearance when thresholds met.
  const activeStreakMapForParole = activeCoinStreakState();
  const activeStreakStoreForParole = streakStoreForMode(S.botMode);
  const paroleState = await checkAllParoles(S.botMode, activeStreakMapForParole, activeStreakStoreForParole);

  // Apply doubt penalty reduction from shadow parole.
  let effectiveDoubtPenalty = windowDoubtPenalty;
  if (paroleState.doubtPenaltyReduction > 0 && windowDoubtPenalty > 0) {
    effectiveDoubtPenalty = Math.max(0, windowDoubtPenalty - paroleState.doubtPenaltyReduction);
    logger.info(
      { windowDoubtPenalty, reduction: paroleState.doubtPenaltyReduction, effectiveDoubtPenalty },
      `[kalshi-bot] [parole] doubt penalty reduced ${windowDoubtPenalty}pp → ${effectiveDoubtPenalty}pp for this tick`,
    );
  }

  // Apply unanimous failure penalty reduction from shadow parole.
  let effectiveUnanimousFailurePenalty = unanimousFailurePenalty;
  if (paroleState.unanimousFailurePenaltyReduction > 0 && unanimousFailurePenalty > 0) {
    effectiveUnanimousFailurePenalty = Math.max(0, unanimousFailurePenalty - paroleState.unanimousFailurePenaltyReduction);
    logger.info(
      { unanimousFailurePenalty, reduction: paroleState.unanimousFailurePenaltyReduction, effectiveUnanimousFailurePenalty },
      `[kalshi-bot] [parole] unanimous failure penalty reduced ${unanimousFailurePenalty}pp → ${effectiveUnanimousFailurePenalty}pp for this tick`,
    );
  }

  // Symbols blocked by directional-cap or border guard filters.
  // These must be excluded from Phase-4 orderedSymbols so runBotTickForCoin cannot
  // independently place a bet that the Phase-3 filter just blocked.
  const filteredByNewGuards = new Set<string>();

  // Global bet cap: total bets placed across ALL coins this window (mode-aware).
  // This is the correct interpretation of maxBetsPerWindow — not per-coin.
  // The per-coin windowBetCounts is still used to prevent a single coin from re-betting.
  const globalBetsThisWindow = windowTotalBets.get(`${windowKey}:${S.botMode}`) ?? 0;
  const globalCapReached = S.config.maxBetsPerWindow > 0 && globalBetsThisWindow >= S.config.maxBetsPerWindow;

  // Refresh border-proximity and regime caches once per window transition.
  if (windowKey !== S.borderProximityCacheWindow) {
    const syms = CRYPTO_COINS
      .filter(c => KALSHI_SERIES[c.symbol])
      .map(c => c.symbol.toUpperCase());
    if (S.config.enableBorderGuard) {
      S.borderProximityCache = await loadBorderProximityCache(syms, S.config.borderLookbackBets);
      logger.debug({ borderProximityCache: Object.fromEntries(S.borderProximityCache) },
        "[kalshi-bot] border-proximity cache refreshed");
    }
    S.regimeCache = await loadRegimeCache(syms, S.config.borderLookbackBets);
    S.regimeCacheWindow = windowKey;
    S.borderProximityCacheWindow = windowKey;
    logger.debug({ regimeCache: Object.fromEntries(S.regimeCache) },
      "[kalshi-bot] regime cache refreshed");
  }

  // Conviction mode: proactively refresh Kalshi bid/ask prices for every coin
  // before evaluating them. The tracker snapshot only runs every 30 s — far too
  // stale for the 88–92¢ window. Fetching in parallel here keeps prices ≤2 s
  // fresh so the engine never skips a coin based on stale pre-gate data.
  if (S.config.decisionMode === "conviction") {
    await Promise.all(
      CRYPTO_COINS
        .filter(c => KALSHI_SERIES[c.symbol])
        .map(c => fetchKalshiTarget(c.symbol.toUpperCase()).catch(() => null)),
    );
  }

  for (const coin of CRYPTO_COINS) {
    if (!KALSHI_SERIES[coin.symbol]) continue;
    const sym = coin.symbol.toUpperCase();

    // Refresh per-coin stability classification every tick in conviction mode,
    // regardless of whether this coin proceeds to entry logic.
    if (S.config.decisionMode === "conviction" && S.config.convictionStabilityEnabled !== false) {
      const _ind = getCachedPrediction(sym)?.indicators;
      if (_ind) {
        const _mlSig  = getLatestCoinSignals(sym);
        const _mlConf = _mlSig?.mlConfidence ?? null;
        const _minER     = S.config.convictionStabilityMinER     ?? 0.30;
        const _maxOsc    = S.config.convictionStabilityMaxOsc    ?? 8;
        const _maxVolPct = S.config.convictionStabilityMaxVolPct ?? 3.0;
        const _minMLConf = S.config.convictionStabilityMinMLConf ?? 52;
        const _spLivePrice  = getCachedPrediction(sym)?.price ?? null;
        const _spKalshiData = getKalshiCachedData(sym);
        const _spStrike     = _spKalshiData?.value ?? null;
        const _strikeGapPct = (_spLivePrice && _spStrike && _spStrike > 0)
          ? Math.abs(_spLivePrice - _spStrike) / _spStrike * 100
          : null;
        coinStabilityCache.set(sym, {
          // spikeFlag excluded: conviction fires because price hit 90¢ (often a spike);
          // blocking max bets on that spike is self-defeating.  See kalshi-bot-tick.ts.
          stable: _ind.efficiencyRatio  >= _minER &&
                  _ind.oscillationCount <= _maxOsc &&
                  _ind.volatilityPct    <= _maxVolPct &&
                  (_mlConf === null || _mlConf >= _minMLConf),
          er:     _ind.efficiencyRatio,
          osc:    _ind.oscillationCount,
          volPct: _ind.volatilityPct,
          mlConf: _mlConf,
          windowKey,
          computedAt: Date.now(),
          strikeGapPct: _strikeGapPct,
        } satisfies CoinStabilityResult);
      }
    }

    const kalshiData = getKalshiCachedData(sym);
    const winCtx = getKalshiWindowContext(sym);
    const secondsElapsed = winCtx?.secondsElapsed ?? 0;
    const minutesElapsed = winCtx?.minutesElapsed ?? 0;
    // Clock-derived elapsed time for timing guards.  winCtx.secondsElapsed is
    // measured from when the Kalshi prefetch completed — which can be 20-40 s
    // after the official window boundary — causing the entry buffer and the
    // late-floor check to undercount elapsed time and fire prematurely.
    // clockElapsedS anchors to the official window boundary (windowKey ISO string)
    // and is always used for the entry buffer and late-floor guards.
    const clockElapsedS = Math.max(0, (Date.now() - new Date(windowKey).getTime()) / 1000);
    const now = new Date().toISOString();

    // Derive regime from recent Kalshi strikes for this symbol (always computed).
    const recentStrikes = recentKalshiTargets.get(sym) ?? [];
    const regime: PriceRegime | null = recentStrikes.length >= 2
      ? deriveRegime(recentStrikes, S.config.momentumWindowCount)
      : null;

    if (!kalshiData?.ticker || kalshiData.value === null) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: "no market data", windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }
    // No order-book price: Kalshi returned a strike but no bid/ask/last_price —
    // the market is illiquid or market makers haven't posted quotes yet.  Surface
    // this clearly in the UI instead of computing a bet that the completeness gate
    // would silently abort downstream.
    if (kalshiData.yesPrice == null) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: "no order book price — market illiquid", windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }
    // Empty-book cooldown: if this coin's IOC order returned 0 fills on both attempts
    // this window, skip it — the book is genuinely empty. Cleared on window transition.
    // (First 0-fill does NOT block; bot retries once more ~30s later before giving up.)
    // Conviction mode is exempt: it retries every tick indefinitely. The book can
    // become liquid at any point in the window, and blocking kills valid entries.
    const isConvictionForCooldown = S.config.decisionMode === "conviction";
    if (!isConvictionForCooldown && windowFailedFills.has(`${sym}:${windowKey}:${S.botMode}`)) {
      filteredByNewGuards.add(sym);
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: "empty-book cooldown — IOC returned 0 fills earlier this window", windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }
    // Pipeline-completion gate: skip re-evaluation for coins where the
    // pipeline-triggered entry has already fired this window.
    // The completion callback (_firePipelineEntryForCoin) fires immediately when
    // all three models are ready and calls runBotTickForCoin directly.  This
    // prevents the 15s scheduler from double-attempting entry on the same window.
    // Coins with no pipeline result (deferred Kalshi market) remain eligible for
    // retry via the normal scheduler path so deferred coins are not permanently
    // excluded — they simply re-enter the Phase-3 loop until their market publishes.
    //
    // BYPASS for conviction mode: the bot monitors on every tick and fires the
    // moment the Kalshi YES price crosses kalshiLockPrice (default $0.90).
    // The pipeline sets the lock on first completion but we deliberately
    // re-evaluate each tick so a 90¢ cross at T+8 is caught within 5 seconds.
    const isConviction = S.config.decisionMode === "conviction";
    if (pipelineEntryFiredThisWindow.has(`${sym}:${windowKey}`) && !openPositions.has(sym)) {
      if (!isConviction) {
        filteredByNewGuards.add(sym); // exclude from Phase-4 to prevent a second runBotTickForCoin call
        evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: "pipeline-triggered entry already evaluated this window", windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
        continue;
      }
      // conviction mode: fall through — tick loop re-evaluates every 5s
    }
    // Conviction once-per-window guard: after a conviction entry has been attempted
    // (regardless of FOK fill outcome), block any further entry for this coin this
    // window.  This prevents repeated bets when the Kalshi YES price oscillates
    // across the lock threshold (e.g. 89¢ → 91¢ → 89¢ → 91¢ every tick).
    if (isConviction && convictionFiredThisWindow.has(`${sym}:${windowKey}`)) {
      filteredByNewGuards.add(sym);
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: "conviction: already entered this window", windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }
    // Abort cooldown: after a live-gate "price moved outside window" abort, skip
    // re-entry for CONVICTION_ABORT_COOLDOWN_MS (10 s) while the 1 s conviction
    // poller refreshes the cache.  Prevents a second abort loop if the bot-loop
    // tick fires before the poller has pushed a fresh price through.
    if (isConviction) {
      const abortedAt = convictionAbortCooldown.get(`${sym}:${windowKey}`);
      if (abortedAt != null && Date.now() - abortedAt < CONVICTION_ABORT_COOLDOWN_MS) {
        const remainingS = Math.ceil((CONVICTION_ABORT_COOLDOWN_MS - (Date.now() - abortedAt)) / 1_000);
        evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `conviction: abort cooldown (${remainingS}s remaining)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
        continue;
      }
    }

    // Conviction mode: minimal warmup (5s) — just enough for Kalshi to publish
    // the market after window open.  We intentionally ignore windowEntryBufferSeconds
    // here because that value was tuned for signal-based modes (momentum override
    // fires blind without a warm target cache).  Conviction is purely reactive to
    // yesPrice; the null-price guard below handles any not-yet-published market.
    // The minWindowEntryMinutes gate in tick.ts independently enforces any
    // user-configured timing restriction from bot config — that gate is not bypassed.
    if (isConviction) {
      const CONVICTION_WARMUP_S = 5;
      if (clockElapsedS < CONVICTION_WARMUP_S) {
        evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `conviction: warmup (${Math.ceil(CONVICTION_WARMUP_S - clockElapsedS)}s)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
        continue;
      }
      // Minimum entry wait: block dispatch until N minutes have elapsed.
      // Bypassed when extreme-price bypass is enabled and the live YES price
      // is at a configured extreme — mirrors the tick.ts gate exactly.
      const convMinEntryMin = S.config.convictionMinEntryMinutes ?? 0;
      if (convMinEntryMin > 0 && clockElapsedS < convMinEntryMin * 60) {
        const _bypassEnabled = S.config.convictionEarlyBypassEnabled !== false;
        const _bypassThreshold = S.config.convictionEarlyBypassThreshold ?? 0.92;
        const _pollerPrice = getConvictionLivePrice(sym);
        const _liveYes = _pollerPrice?.yesAsk ?? _pollerPrice?.yesBid ?? null;
        const _isExtreme = _bypassEnabled &&
          _liveYes !== null &&
          (_liveYes >= _bypassThreshold || _liveYes <= +(1 - _bypassThreshold).toFixed(4));
        if (!_isExtreme) {
          evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `conviction: min entry wait (${convMinEntryMin}min — ${(clockElapsedS / 60).toFixed(1)}min elapsed)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
          continue;
        }
      }
    }
    if (S.config.maxEntryMinutes > 0 && clockElapsedS > S.config.maxEntryMinutes * 60) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `past entry ceiling (>${S.config.maxEntryMinutes}min elapsed, clock=${Math.floor(clockElapsedS)}s)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }
    // Global total-bet cap: if maxBetsPerWindow total bets have already been placed
    // across ALL coins this window, skip any coin that has not yet placed a bet.
    // Coins that already placed a bet are allowed to continue (for display/exit purposes).
    //
    // CONVICTION MODE: this cap does NOT apply. Each coin bets independently based on
    // its own yesPrice crossing 90¢. Max-bet slots are governed separately by
    // convictionStabilityMaxBetsPerWindow via maxBetWindowToken.
    if (!isConviction && globalCapReached && !(windowBetCounts.get(`${sym}:${windowKey}:${S.botMode}`) ?? 0 > 0)) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `global bet cap reached (${globalBetsThisWindow}/${S.config.maxBetsPerWindow} bets this window)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }

    if (!S.config.allowLateEntries) {
      const minRem = S.config.minRemainingMinutes ?? 0;
      if (minRem > 0 && 15 * 60 - clockElapsedS < minRem * 60) {
        evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `min-remaining floor (<${minRem}min remaining, clock=${Math.floor(clockElapsedS)}s elapsed)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
        continue;
      }
    }

    // Signal accuracy — used in makeBotDecision for the EV gate and also in the
    // WM caution bypass peek below.  Moved above the WM readiness gate so the
    // peek call gets the real accuracy value (not null) for an accurate EV check.
    const signalAcc = getPredictionAnalytics(sym).bySource.ensemble.accuracyPct;

    // ── WM Caution Bypass — readiness wait override ───────────────────────────
    // When the window monitor hasn't yet accumulated enough intra-window candles
    // (wmReady=false) but the recommendation is "caution" rather than "stay_away",
    // peek at the model signals.  If all models agree unanimously at ≥
    // WM_CAUTION_BYPASS_MIN_CONF, the directional signal is clear enough to
    // proceed without waiting for the full 2-5 min readiness window.
    //
    // "stay_away" is NEVER bypassed — it reflects a genuine regime problem, not
    // just a data-accumulation delay.
    //
    // The bypass only fires when `requireMonitorReady=true` (the gate is active)
    // and the WM is not yet ready.  When WM is already ready, the normal path
    // below runs unchanged.
    const WM_CAUTION_BYPASS_MIN_CONF = 65;
    const _wmPreSig = getWindowBetSignal(sym);
    let _wmBypassActive = false;
    if (
      !(_wmPreSig?.ready ?? false) &&
      (_wmPreSig?.recommendation ?? null) !== "stay_away" &&
      (S.config.requireMonitorReady ?? true)
    ) {
      const _peekDec = makeBotDecision(
        sym, S.config, kalshiData.ticker, kalshiData.yesPrice ?? null,
        minutesElapsed, signalAcc, kalshiData.value,
      );
      if (
        _peekDec.action !== "SKIP" &&
        _peekDec.signals.signalsAgreeing >= 2 &&
        _peekDec.confidence >= WM_CAUTION_BYPASS_MIN_CONF
      ) {
        _wmBypassActive = true;
        logger.info(
          { sym, wmRec: _wmPreSig?.recommendation, conf: _peekDec.confidence,
            signalsAgreeing: _peekDec.signals.signalsAgreeing,
            minutesElapsed: minutesElapsed.toFixed(1), windowKey },
          "[kalshi-bot] WM caution bypass — unanimous signals override readiness wait",
        );
      }
    }

    // Window Monitor readiness gate: defer (not permanently block) until the monitor
    // has ≥2 min of intra-window candle data.  Unlike filteredByNewGuards entries,
    // this coin is NOT blocked from Phase-4 for the whole window — the next 60-second
    // tick will re-evaluate it and find the monitor ready.
    // Skipped when _wmBypassActive (unanimous high-confidence signals above).
    // Skipped in conviction mode: conviction is purely reactive to yesPrice; it uses
    // no WM signals, so waiting for candle accumulation only blocks early entries.
    if (!isConviction && !_wmBypassActive && checkWindowMonitorReadyGuard(_wmPreSig?.ready ?? false, S.config.requireMonitorReady ?? true)) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0,
        reason: `window monitor not ready (${minutesElapsed.toFixed(1)}m elapsed — needs ≥2m)`,
        windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }

    // Window Monitor STAY_AWAY gate: mirrors the predictor page's STAY AWAY badge.
    // applyStayAwayGateDecision handles both the verdict and the filteredByNewGuards
    // mutation atomically, so Phase 4 cannot independently bet this coin.
    // When requireMonitorReady=true: hard block (full-window, not per-tick defer).
    // When requireMonitorReady=false: advisory log only, entry proceeds.
    // Skipped in conviction mode: WM signals are irrelevant to price-reactive entry.
    if (!isConviction) {
      const _stayAway = applyStayAwayGateDecision(
        sym,
        getWindowBetSignal(sym),
        S.config.requireMonitorReady ?? true,
        filteredByNewGuards,
      );
      if (_stayAway.action === "block") {
        evalResults.push({
          symbol: sym, action: "SKIP", confidence: 0, score: 0,
          reason: _stayAway.reason,
          windowKey, selected: false, evaluatedAt: now, trendStability: null, regime,
        });
        continue;
      } else if (_stayAway.action === "advisory") {
        logger.debug({ sym, windowKey },
          "[kalshi-bot] window monitor STAY_AWAY advisory (requireMonitorReady=false) — proceeding");
      }
    }

    // Trend-stability readiness gate: defer new bets until the window-open Claude
    // trend-stability analysis has resolved for this coin.  Without this gate the
    // bot bets blind on the trend-quality dimension — e.g. a NO bet placed when
    // the analysis would have returned "reversing" (force-SKIP) or confirmed a
    // clear up-trend against the proposed direction.
    // Only enforced when the crypto_stability AI feature is enabled; if Claude is
    // off entirely we skip this gate so other signals can still operate.
    // After STABILITY_WAIT_MAX_S seconds we proceed anyway and log a warning —
    // this prevents the gate from blocking all entries if Claude is slow or down.
    // Skipped in conviction mode: conviction is purely reactive to yesPrice vs
    // lockPrice — it does not use trend-stability direction. Blocking conviction
    // entries while Claude resolves defeats the purpose of a price-reactive bot.
    if (!isConviction && isAiFeatureEnabled("crypto_stability") && !windowStabilityCache.has(sym)) {
      if (clockElapsedS < STABILITY_WAIT_MAX_S) {
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: 0,
          score: 0,
          reason: `pending trend analysis (${Math.round(clockElapsedS)}s elapsed — waiting up to ${STABILITY_WAIT_MAX_S}s)`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: null,
          regime,
        });
        continue;
      }
      // Past the wait ceiling — proceed without stability data but surface the miss.
      logger.warn(
        { sym, clockElapsedS: Math.round(clockElapsedS), windowKey },
        "[kalshi-bot] stability analysis timeout — proceeding without trend data",
      );
    }

    // Cached bot-timing accuracy is used for composite score ranking only.
    // Signal accuracy (signalAcc) was moved above the WM bypass block so the
    // bypass peek can use the real EV-gate accuracy value.
    const marks = [1, 3, 6, 9, 12];
    const elapsedMin = Math.floor(minutesElapsed);
    const closest = marks.reduce((p, m) => Math.abs(m - elapsedMin) < Math.abs(p - elapsedMin) ? m : p, marks[0]);
    const timingAcc = S.timingCache.get(`${sym}:${closest * 60}`) ?? S.timingCache.get(`ALL:${closest * 60}`) ?? null;

    // ── Per-coin streak confidence penalty (applied at decision-call time) ─────
    // Compute the raised minConfidence floor for this coin before calling
    // makeBotDecision, so the decision engine directly returns SKIP when the
    // signal confidence doesn't clear the streak-adjusted bar. This avoids a
    // post-decision threshold check and ensures the engine reasoning string
    // correctly reflects the raised floor. Exempt when freeRunMode.
    let _streakPenaltyPp = 0;
    if (!S.config.freeRunMode && !isConviction) {
      const _seEntry = activeCoinStreakState().get(sym);
      const _seConLosses = _seEntry?.consecutiveLosses ?? 0;
      const _sePen1 = S.config.coinStreakPenalty1LossPp ?? 6;
      const _sePen2 = S.config.coinStreakPenalty2PlusLossPp ?? 12;
      _streakPenaltyPp = _seConLosses >= 2 ? _sePen2 : _seConLosses === 1 ? _sePen1 : 0;
    }
    const _decisionConfig = _streakPenaltyPp > 0
      ? { ...S.config, minConfidence: S.config.minConfidence + _streakPenaltyPp }
      : S.config;
    if (_streakPenaltyPp > 0) {
      logger.info(
        { sym, penalty: _streakPenaltyPp, raisedFloor: _decisionConfig.minConfidence, windowKey },
        `[kalshi-bot] streak penalty: minConf raised +${_streakPenaltyPp}pp to ${_decisionConfig.minConfidence}% before decision call`,
      );
    }

    // `let` so the auto-tune shadow path and WM relief can temporarily substitute
    // an alt-floor decision for gate evaluation (see below).
    let decision = makeBotDecision(sym, _decisionConfig, kalshiData.ticker, kalshiData.yesPrice ?? null, minutesElapsed, signalAcc, kalshiData.value);

    // Conviction diagnostic: log once per 60 s per coin (or every BET action)
    // so we always have at least one visible INFO entry showing what Phase 3 sees.
    if (isConviction) {
      const cvCachedDiag = getKalshiCachedData(sym);
      const _diagKey = `${sym}:${windowKey}`;
      const _diagNow = Date.now();
      const _sinceLastLog = _diagNow - (convictionDiagLastLogAt.get(_diagKey) ?? 0);
      if (decision.action !== "SKIP" || _sinceLastLog >= 60_000) {
        convictionDiagLastLogAt.set(_diagKey, _diagNow);
        logger.info(
          {
            sym, windowKey,
            yesPrice: kalshiData.yesPrice != null ? +kalshiData.yesPrice.toFixed(4) : null,
            yesAsk:   cvCachedDiag?.yesAsk  != null ? +cvCachedDiag.yesAsk.toFixed(4)  : null,
            noAsk:    cvCachedDiag?.noAsk   != null ? +cvCachedDiag.noAsk.toFixed(4)   : null,
            action:   decision.action,
            reason:   decision.reasoning?.slice(0, 80),
            clockElapsedS: Math.round(clockElapsedS),
          },
          "[conviction-diag] Phase-3 price check",
        );
      }
    }

    // ── WM Caution Confidence Relief — threshold ease when WM is "caution" ───
    // When the window monitor is ready but says "caution" (choppy regime, not a
    // hard directional problem) and all models agree unanimously, relax the
    // confidence floor by WM_CAUTION_CONF_RELIEF pp.  This handles the edge case
    // where unanimous PATH-A confidence lands just below the global minConfidence.
    //
    // Conditions: SKIP due to confidence (confidence > 0), ≥3 signals agreeing,
    // WM recommendation is "caution", and confidence is within the relief band.
    // "stay_away" is never relieved (blocked above this point already).
    const WM_CAUTION_CONF_RELIEF = 4;
    if (
      decision.action === "SKIP" &&
      decision.confidence > 0 &&
      decision.confidence >= _decisionConfig.minConfidence - WM_CAUTION_CONF_RELIEF &&
      (getWindowBetSignal(sym)?.recommendation ?? null) === "caution" &&
      decision.signals.signalsAgreeing >= 3
    ) {
      // Use the streak-adjusted floor (_decisionConfig) so a streak-penalised coin
      // cannot be promoted back to BET by applying relief against the base floor.
      const _reliefConfig = { ..._decisionConfig, minConfidence: _decisionConfig.minConfidence - WM_CAUTION_CONF_RELIEF };
      const _reliefDec = makeBotDecision(
        sym, _reliefConfig, kalshiData.ticker, kalshiData.yesPrice ?? null,
        minutesElapsed, signalAcc, kalshiData.value,
      );
      if (_reliefDec.action !== "SKIP") {
        logger.info(
          { sym, wmRec: "caution", originalConf: decision.confidence,
            reliefFloor: _reliefConfig.minConfidence, action: _reliefDec.action,
            signalsAgreeing: decision.signals.signalsAgreeing, windowKey },
          "[kalshi-bot] WM caution confidence relief — unanimous signals cleared lower threshold",
        );
        decision = _reliefDec;
      }
    }

    // Save the original decision immediately — used at the final push to restore
    // the real action/confidence when `decision` is overridden for gate evaluation.
    const originalDecision = decision;
    const stability = windowStabilityCache.get(sym) ?? null;
    const reason = decision.reasoning;

    // Auto-tune shadow detection: if a temporary confidence-raise is active
    // (autoTuneConfidenceRevertTo != null) AND the primary decision is SKIP,
    // re-run makeBotDecision with the original (pre-raise) floor.
    //
    // If the alt-floor call returns a BET, override `decision` with `altDec`.
    // Because all downstream gates in this loop are guarded by
    // `decision.action !== "SKIP"`, overriding here causes every non-confidence
    // gate (reversing, momentum, price bands, regime, NO gate, border guard) to
    // evaluate the hypothetical BET direction correctly.  Any gate that fires
    // issues a `continue` — so `_autoTuneShadowDecision` is only consumed at the
    // FINAL evalResults.push when every non-confidence gate passed.
    //
    // Note: makeBotDecision returns the same `confidence` value regardless of
    // which floor is passed (confidence is signal-derived; the floor only changes
    // `action`).  So `effectiveConfidence` is identical for both calls, and
    // all gate thresholds evaluate consistently.
    let _autoTuneShadowDecision: { action: string; signals: unknown } | null = null;
    if (
      S.config.autoTuneConfidenceRevertTo != null &&
      _decisionConfig.minConfidence > S.config.autoTuneConfidenceRevertTo &&
      decision.action === "SKIP"
    ) {
      // Preserve the streak penalty in the shadow floor so that the auto-tune
      // shadow does not promote a streak-blocked coin to BET.
      const origFloorConfig = { ..._decisionConfig, minConfidence: S.config.autoTuneConfidenceRevertTo + _streakPenaltyPp };
      const altDec = makeBotDecision(
        sym,
        origFloorConfig,
        kalshiData.ticker,
        kalshiData.yesPrice ?? null,
        minutesElapsed,
        signalAcc,
        kalshiData.value,
      );
      if (altDec.action !== "SKIP") {
        _autoTuneShadowDecision = { action: altDec.action, signals: altDec.signals };
        // Override decision so downstream gates evaluate the hypothetical direction.
        decision = altDec;
      }
    }

    // Apply the bet profile's confidence cap before any further filters.
    // In aggressive mode this clamps at 80% — preventing the false-unanimity
    // problem where all signals agree in choppy markets and produce inflated 85-92%
    // confidence bets that win at only ~50%.
    const _betProfile = BET_PROFILES[S.config.betProfile ?? "normal"];
    let effectiveConfidence = Math.min(decision.confidence, _betProfile.effectiveConfidenceCap);

    // ── Per-coin streak pause (Phase-3 shadow probe) ──────────────────────────
    // checkAllParoles() already cleared in-memory pauses for paroled coins, so
    // any coin still showing a pause here has not yet met the accuracy threshold.
    // Record a shadow probe and skip the rest of Phase-3 evaluation.  The actual
    // placement block lives in Phase-4 (_runBotTick); this continue is safe because
    // filteredByNewGuards prevents Phase-4 from independently placing the order.
    {
      const _streakEntry = activeCoinStreakState().get(sym);
      const _isStreakPaused = _streakEntry?.pauseUntilWindowKey != null
        && windowKey <= _streakEntry.pauseUntilWindowKey;
      // freeRunMode bypasses streak pauses so "Reset all" + "Free Run" give
      // immediate unrestricted access to all coins.
      if (_isStreakPaused && !S.config.freeRunMode && !isConviction) {
        if (decision.action !== "SKIP") {
          const _shadowDir: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";
          void recordShadowBet(
            sym, _shadowDir, effectiveConfidence, decision.signals,
            kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
            "streak_pause",
          ).catch(err => logger.warn({ err, sym }, "[shadow-bet] streak-pause record failed (non-fatal)"));
        }
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym, action: "SKIP", confidence: effectiveConfidence, score: 0,
          reason: `streak pause — blocked until window ${_streakEntry!.pauseUntilWindowKey} (${_streakEntry!.consecutiveLosses} consecutive losses)`,
          windowKey, selected: false, evaluatedAt: now, trendStability: stability, regime,
        });
        continue;
      }
    }

    // (Streak penalty was applied at makeBotDecision call-time above — no
    // post-decision check needed here. If confidence was below the raised floor
    // the engine already returned SKIP, which is caught by Phase-4 guards.)

    // ── Per-coin manual pause ─────────────────────────────────────────────────
    // User-controlled: permanently skips this coin until the override is removed.
    // Unlike auto-tune pauses this is NOT bypassed by freeRunMode — the user
    // explicitly set it and must explicitly clear it.
    if (S.config.coinOverrides?.[sym]?.paused) {
      filteredByNewGuards.add(sym);
      evalResults.push({
        symbol: sym, action: "SKIP", confidence: effectiveConfidence, score: 0,
        reason: "manually paused",
        windowKey, selected: false, evaluatedAt: now, trendStability: stability, regime,
      });
      continue;
    }

    // ── Per-coin auto-tune pause (shadow probe) ───────────────────────────────
    // Fires after `decision` is computed so we can record a directional shadow
    // bet. checkAllParoles() clears pausedCoins early when shadow accuracy
    // reaches ≥60% over ≥3 evaluated bets (blockedBy="auto_tune_pause").
    // freeRunMode bypasses this gate so the user can un-pause all coins instantly.
    if (!S.config.freeRunMode && !isConviction && pausedCoins.has(sym)) {
      const remaining = pausedCoins.get(sym) ?? 0;
      if (decision.action !== "SKIP") {
        const _pauseDir: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";
        void recordShadowBet(
          sym, _pauseDir, effectiveConfidence, decision.signals,
          kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
          "auto_tune_pause",
        ).catch(err => logger.warn({ err, sym }, "[shadow-bet] auto-tune-pause record failed (non-fatal)"));
      }
      filteredByNewGuards.add(sym);
      evalResults.push({
        symbol: sym, action: "SKIP", confidence: effectiveConfidence, score: 0,
        reason: `auto-tune pause (${remaining} window${remaining === 1 ? "" : "s"} remaining)`,
        windowKey, selected: false, evaluatedAt: now, trendStability: stability, regime,
      });
      continue;
    }

    // Reversing: apply a -20pp penalty instead of a hard skip. Only very
    // high-conviction entries still clear minConfidence after the penalty.
    // Subtracts from the already-profile-capped value for consistency.
    // Bypassed when parole accuracy for this coin/restriction meets the threshold.
    // Conviction mode: trend stability is irrelevant — price position is the signal.
    let reversingCaution = false;
    if (S.config.decisionMode !== "conviction" && stability === "reversing" && decision.action !== "SKIP" && !paroleState.reversing.has(sym)) {
      effectiveConfidence = effectiveConfidence - 20;
      reversingCaution = true;
      if (effectiveConfidence < S.config.minConfidence) {
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `reversing-caution (${decision.confidence}%→${effectiveConfidence}%) — ${reason.slice(0, 40)}`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: "reversing",
          regime,
        });
        if ((decision.action as string) !== "SKIP") {
          const _sd: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";
          void recordShadowBet(
            sym, _sd, effectiveConfidence, decision.signals,
            kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
            "reversing_caution",
          ).catch(err => logger.warn({ err, sym }, "[shadow-bet] reversing_caution record failed"));
        }
        continue;
      }
    }

    // Momentum override removed: multi-window strike trend does NOT predict a single
    // 15-min window outcome. Each window is independent — YES/NO must be decided by
    // signal quality (Claude, ML, Stat), not by whether the market was going up or
    // down in previous windows.

    // --- Per-coin blocking filters BEFORE directional cap ---
    // These must run before phase3DirectionCounts is incremented so that coins which will
    // never actually bet cannot steal a directional cap slot and prevent a valid coin
    // from entering. Example: SOL is COIN_FULLY_BLOCKED; if it passed the dirCap check
    // first it would increment phase3DirectionCounts["no"] to 3, then get SKIP'd here,
    // leaving only 3 real NO slots (instead of 4) for the remaining coins.
    if (decision.action !== "SKIP") {
      if (!S.config.freeRunMode && COIN_FULLY_BLOCKED.has(sym) && !paroleState.fullyBlocked.has(sym)) {
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `coin filter — ${sym} soft-blocked (no edge either direction; shadow bets recorded — unblocks at ≥60% WR over ≥3 evaluated bets)`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: stability,
          regime,
        });
        const _cbDir: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";
        void recordShadowBet(
          sym, _cbDir, effectiveConfidence, decision.signals,
          kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
          "coin_fully_blocked",
        ).catch(err => logger.warn({ err, sym }, "[shadow-bet] coin_fully_blocked record failed"));
        continue;
      }

      // Hard-model-signal minimum: at least MIN_HARD_MODEL_SIGNALS of the three
      // core models (stat, claude, ML) must have produced a non-null directional
      // output. windowMonitor ("bet" / "caution" / "stay_away") does not count —
      // it is a meta-signal derived from the models, not an independent source.
      // This prevents single-model bets like XRP (stat=null, claude=null, ML only).
      // Skipped in conviction mode: direction is purely yesPrice vs lockPrice;
      // model signal availability is irrelevant to whether entry should fire.
      if (!isConviction) {
        const hardSigs = decision.signals as {
          statAbove?: boolean | null;
          claudeAbove?: boolean | null;
          mlAbove?: boolean | null;
        };
        const hardModelCount =
          (hardSigs.statAbove   != null ? 1 : 0) +
          (hardSigs.claudeAbove != null ? 1 : 0) +
          (hardSigs.mlAbove     != null ? 1 : 0);
        if (hardModelCount < MIN_HARD_MODEL_SIGNALS && !paroleState.hardModel.has(sym)) {
          filteredByNewGuards.add(sym);
          evalResults.push({
            symbol: sym,
            action: "SKIP",
            confidence: effectiveConfidence,
            score: 0,
            reason: `hard-model gate — only ${hardModelCount}/${MIN_HARD_MODEL_SIGNALS} core models produced a signal (stat=${hardSigs.statAbove ?? "null"} claude=${hardSigs.claudeAbove ?? "null"} ml=${hardSigs.mlAbove ?? "null"})`,
            windowKey,
            selected: false,
            evaluatedAt: now,
            trendStability: stability,
            regime,
          });
          const _hmDir: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";
          void recordShadowBet(
            sym, _hmDir, effectiveConfidence, decision.signals,
            kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
            "hard_model",
          ).catch(err => logger.warn({ err, sym }, "[shadow-bet] hard_model record failed"));
          continue;
        }
      }

      // ── ML Gate hard checkpoint ────────────────────────────────────────────
      // In ml_gate mode the ML model's vote is MANDATORY — it is a checkpoint,
      // not an optional signal.  If mlAbove === null (model failed to init,
      // still warming up, or backfill not yet complete) the bet is blocked
      // unconditionally.  We never silently skip a checkpoint: Step 1 must
      // unlock Step 2.  No parole override: a null ML vote is a missing
      // prerequisite, not a low-accuracy result.
      if (S.config.decisionMode === "ml_gate") {
        const _mlGateSigs = decision.signals as {
          mlAbove?: boolean | null;
          statAbove?: boolean | null;
          claudeAbove?: boolean | null;
        };
        if (_mlGateSigs.mlAbove == null) {
          logger.info(
            { sym, windowKey, statAbove: _mlGateSigs.statAbove, claudeAbove: _mlGateSigs.claudeAbove },
            `[kalshi-bot] ml_gate checkpoint BLOCKED — ML not ready for ${sym}`,
          );
          evalResults.push({
            symbol: sym,
            action: "SKIP",
            confidence: effectiveConfidence,
            score: 0,
            reason: `ml_gate checkpoint: ML not ready — model must vote before any bet fires (stat=${_mlGateSigs.statAbove ?? "null"} claude=${_mlGateSigs.claudeAbove ?? "null"})`,
            windowKey,
            selected: false,
            evaluatedAt: now,
            trendStability: stability,
            regime,
          });
          continue;
        }
      }

      if (decision.action === "BET_YES") {
        if (!S.config.freeRunMode && COIN_YES_BLOCKED.has(sym) && !paroleState.yesBlocked.has(sym)) {
          filteredByNewGuards.add(sym);
          evalResults.push({
            symbol: sym,
            action: "SKIP",
            confidence: effectiveConfidence,
            score: 0,
            reason: `coin filter — ${sym} YES blocked (historical WR ≤25%)`,
            windowKey,
            selected: false,
            evaluatedAt: now,
            trendStability: stability,
            regime,
          });
          void recordShadowBet(
            sym, "yes", effectiveConfidence, decision.signals,
            kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
            "coin_yes_blocked",
          ).catch(err => logger.warn({ err, sym }, "[shadow-bet] coin_yes_blocked record failed"));
          continue;
        }

        // Conviction mode: price position is the sole signal — quality gates
        // are meaningless because model directions are irrelevant.
        if (S.config.decisionMode !== "conviction") {
          // Signal quality gates for YES bets (direction-neutral logic applied
          // symmetrically to NO bets below):
          //
          // Claude and ML are the authoritative directional signals.  A YES bet
          // is only placed when neither Claude nor ML calls NO.  Stat is a
          // confidence modifier only (±pp via PATH A boost/penalty) and does NOT
          // block a bet on its own — the engine already penalises Stat dissent
          // in the confidence score.
          //
          // Note: Claude-ML misalignment is caught earlier (alignment gate in the
          //   core engine) so by the time we reach here both are guaranteed to
          //   agree with the bet direction if both are available.
          const yesSigs = decision.signals as {
            statAbove?: boolean | null; claudeAbove?: boolean | null; mlAbove?: boolean | null;
            statConfidence?: number | null; claudeConfidence?: number | null; mlConfidence?: number | null;
          };
          const yesViolation: string[] = [];
          for (const [name, above] of [
            ["Claude", yesSigs.claudeAbove] as const,
            ["ML",     yesSigs.mlAbove]     as const,
          ]) {
            if (above == null) continue;
            if (above === false) yesViolation.push(`${name} says NO`);
          }
          if (yesViolation.length > 0) {
            filteredByNewGuards.add(sym);
            evalResults.push({
              symbol: sym,
              action: "SKIP",
              confidence: effectiveConfidence,
              score: 0,
              reason: `YES quality gate — ${yesViolation.join("; ")}`,
              windowKey,
              selected: false,
              evaluatedAt: now,
              trendStability: stability,
              regime,
            });
            // Track accuracy only — signal contradiction is a data-quality issue,
            // not a structural market gate, so no bypass is issued.
            void recordShadowBet(
              sym, "yes", effectiveConfidence, decision.signals,
              kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
              "yes_quality_gate",
            ).catch(err => logger.warn({ err, sym }, "[shadow-bet] yes_quality_gate record failed"));
            continue;
          }
        }
      }

      if (decision.action === "BET_NO") {
        // Conviction mode: price position is the sole signal — quality gates bypass.
        if (S.config.decisionMode !== "conviction") {
          // Claude and ML are the authoritative directional signals.  A NO bet
          // is only placed when neither Claude nor ML calls YES.  Stat is a
          // confidence modifier only and does not block a NO bet on its own.
          const noSigs = decision.signals as {
            statAbove?: boolean | null; claudeAbove?: boolean | null; mlAbove?: boolean | null;
            statConfidence?: number | null; claudeConfidence?: number | null; mlConfidence?: number | null;
          };
          const noViolation: string[] = [];
          for (const [name, above] of [
            ["Claude", noSigs.claudeAbove] as const,
            ["ML",     noSigs.mlAbove]     as const,
          ]) {
            if (above == null) continue;
            if (above === true) noViolation.push(`${name} says YES`);
          }
          if (noViolation.length > 0) {
            filteredByNewGuards.add(sym);
            evalResults.push({
              symbol: sym,
              action: "SKIP",
              confidence: effectiveConfidence,
              score: 0,
              reason: `NO quality gate — ${noViolation.join("; ")}`,
              windowKey,
              selected: false,
              evaluatedAt: now,
              trendStability: stability,
              regime,
            });
            // Track accuracy only — no structural bypass for signal contradictions.
            void recordShadowBet(
              sym, "no", effectiveConfidence, decision.signals,
              kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
              "no_quality_gate",
            ).catch(err => logger.warn({ err, sym }, "[shadow-bet] no_quality_gate record failed"));
            continue;
          }
        }
      }
    }


    // Regime filter removed: historical "above/below strike" regime is a macro bias
    // that unfairly penalises YES bets when the market is currently trending up.
    // Each 15-min window is independent — direction is determined by current signals
    // (Claude, ML, Stat) evaluating the last few candles vs this specific strike.

    // Contrarian-momentum gate removed: same reason. Strike-price trend across
    // multiple windows does not predict where price will close in THIS window.
    // YES and NO are always equally valid entries — the signal agreement gates
    // below already ensure quality without adding directional prejudice.

    // Position-relative NO gate: when the live crypto price is already above the
    // Kalshi strike by > 0.1%, a NO bet is a mean-reversion call into a trending
    // market. Historical data shows 7/7 NO losses in exactly this configuration.
    // Require ML confirmation (mlAbove === false) OR broad 3-signal agreement to
    // allow entry — otherwise skip.  Bypassed by shadow parole when accuracy qualifies.
    if (S.config.decisionMode !== "conviction" && decision.action === "BET_NO" && kalshiData.value !== null && !paroleState.noGate.has(sym)) {
      const livePrice = getCachedPrediction(sym)?.price ?? null;
      const ABOVE_STRIKE_NO_GAP = 0.001; // 0.1% above strike
      if (livePrice !== null && livePrice > kalshiData.value * (1 + ABOVE_STRIKE_NO_GAP)) {
        const sigs = decision.signals as { signalsAgreeing?: number; mlAbove?: boolean | null };
        const mlConfirmsNo = sigs.mlAbove === false;
        const broadAgreement = (sigs.signalsAgreeing ?? 0) >= 3;
        if (!mlConfirmsNo && !broadAgreement) {
          const gapPct = ((livePrice - kalshiData.value) / kalshiData.value * 100).toFixed(3);
          logger.info(
            { sym, livePrice, kalshiTarget: kalshiData.value, gapPct, signalsAgreeing: sigs.signalsAgreeing, mlAbove: sigs.mlAbove },
            `[kalshi-bot] NO gate — ${sym} price +${gapPct}% above strike, no ML reversal confirmation`,
          );
          filteredByNewGuards.add(sym);
          evalResults.push({
            symbol: sym,
            action: "SKIP",
            confidence: effectiveConfidence,
            score: 0,
            reason: `NO gate — price +${gapPct}% above strike, requires ML or 3-signal agreement`,
            windowKey,
            selected: false,
            evaluatedAt: now,
            trendStability: stability,
            regime,
          });
          void recordShadowBet(
            sym, "no", effectiveConfidence, decision.signals,
            kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
            "no_gate",
          ).catch(err => logger.warn({ err, sym }, "[shadow-bet] no_gate record failed"));
          continue;
        }
      }
    }

    // Border-proximity guard: skip when the coin's close prices have been landing
    // within S.config.borderProximityPct % of the strike over the last N settled bets.
    // These windows are essentially noise — near-50/50 regardless of signal direction.
    // NOTE: this gate runs BEFORE the doubt filter so that any shadow bet recorded
    // inside the doubt filter is guaranteed to have already cleared this gate.
    // Bypassed by shadow parole when accuracy qualifies.
    if (decision.action !== "SKIP" && S.config.enableBorderGuard && !paroleState.border.has(sym)) {
      const proximity = S.borderProximityCache.get(sym);
      if (proximity !== undefined && proximity < S.config.borderProximityPct) {
        logger.info(
          { sym, avgProximityPct: proximity.toFixed(3), threshold: S.config.borderProximityPct },
          `[kalshi-bot] border guard — ${sym} price hovering near strike avg ${proximity.toFixed(2)}% gap`,
        );
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `border guard — avg ${proximity.toFixed(2)}% from strike (last ${S.config.borderLookbackBets} bets)`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: stability,
          regime,
        });
        const _bgDir: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";
        void recordShadowBet(
          sym, _bgDir, effectiveConfidence, decision.signals,
          kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
          "border_guard",
        ).catch(err => logger.warn({ err, sym }, "[shadow-bet] border_guard record failed"));
        continue;
      }
    }

    // Window-doubt filter: if recent windows had poor win rates, require higher conviction
    // for both YES and NO bets. This prevents the bot from over-betting during choppy
    // uncertain regimes when all signals are marginal.
    // effectiveDoubtPenalty is windowDoubtPenalty minus any parole reduction from
    // shadow-bet accuracy (see checkShadowParole above).
    // NOTE: this gate runs AFTER border guard — so any shadow probe recorded here has
    // already cleared every non-confidence gate in the loop (regime, contrarian, NO
    // gate, border guard).  Coins blocked by those earlier gates never reach this point.
    // Combined confidence floor = base minConfidence + doubt penalty + unanimous failure penalty
    // + directional regime dampener (direction-specific).
    // Each penalty eases independently: doubt via time (empty windows) + shadow parole,
    // unanimous failure via time (empty unanimous windows) + shadow parole,
    // directional via time (new window data) automatically.
    const _betDir = decision.action === "BET_YES" ? "yes" : decision.action === "BET_NO" ? "no" : null;
    const _dirPenalty = _betDir === "yes" ? directionalPenaltyYesPp : _betDir === "no" ? directionalPenaltyNoPp : 0;
    const totalPenalty = effectiveDoubtPenalty + effectiveUnanimousFailurePenalty + _dirPenalty;
    if (totalPenalty > 0 && effectiveConfidence < S.config.minConfidence + totalPenalty) {
      filteredByNewGuards.add(sym);

      // Build the reason string, showing which penalties are active.
      const penaltyParts: string[] = [];
      if (effectiveDoubtPenalty > 0)
        penaltyParts.push(`doubt+${effectiveDoubtPenalty}pp`);
      if (effectiveUnanimousFailurePenalty > 0)
        penaltyParts.push(`unanimous-fail+${effectiveUnanimousFailurePenalty}pp`);
      if (_dirPenalty > 0)
        penaltyParts.push(`dir-regime+${_dirPenalty}pp(${_betDir?.toUpperCase()})`);
      const penaltyStr = penaltyParts.join(" ");
      evalResults.push({
        symbol: sym,
        action: "SKIP",
        confidence: effectiveConfidence,
        score: 0,
        reason: `confidence floor — ${effectiveConfidence}% < ${S.config.minConfidence + totalPenalty}% (${penaltyStr})`,
        windowKey,
        selected: false,
        evaluatedAt: now,
        trendStability: stability,
        regime,
      });

      // Record shadow bets for each active penalty so they can be paroled
      // independently.  Only record when the coin's raw confidence already clears
      // the base minConfidence (it was the penalty that blocked it, not the signal).
      if (effectiveConfidence >= S.config.minConfidence && decision.action !== "SKIP") {
        const shadowDir: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";
        if (effectiveDoubtPenalty > 0) {
          void recordShadowBet(
            sym, shadowDir, effectiveConfidence, decision.signals,
            kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
            "doubt_penalty",
          ).catch(err => logger.warn({ err, sym }, "[shadow-bet] doubt_penalty record failed (non-fatal)"));
        }
        if (effectiveUnanimousFailurePenalty > 0) {
          void recordShadowBet(
            sym, shadowDir, effectiveConfidence, decision.signals,
            kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
            "unanimous_failure_guard",
          ).catch(err => logger.warn({ err, sym }, "[shadow-bet] unanimous_failure_guard record failed (non-fatal)"));
        }
        if (_dirPenalty > 0) {
          void recordShadowBet(
            sym, shadowDir, effectiveConfidence, decision.signals,
            kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
            "directional_regime_dampener",
          ).catch(err => logger.warn({ err, sym }, "[shadow-bet] directional_regime_dampener record failed (non-fatal)"));
        }
      }

      continue;
    }

    // clean → ×1.2 bonus for stable directional momentum; choppy/unknown → ×1.0
    const stabilityMultiplier = stability === "clean" ? 1.2 : 1.0;

    // Blend vote-agreement confidence with per-model certainty to differentiate coins
    // that share the same signal ratio.
    const sigs = decision.signals as {
      statConfidence?: number | null;
      claudeConfidence?: number | null;
      mlConfidence?: number | null;
    };
    const modelConfs = [sigs.statConfidence, sigs.claudeConfidence, sigs.mlConfidence]
      .filter((v): v is number => typeof v === "number");
    const avgModelConf = modelConfs.length > 0
      ? modelConfs.reduce((a, b) => a + b, 0) / modelConfs.length
      : effectiveConfidence;
    const blendedConf = effectiveConfidence * 0.6 + avgModelConf * 0.4;
    const score = blendedConf * ((timingAcc ?? 50) / 100) * stabilityMultiplier;

    const finalReason = reversingCaution
      ? `[reversing-caution] ${reason.slice(0, 60)}`
      : reason;

    // ── Strike proximity gate (conviction only) ──────────────────────────────
    // Before any FOK fires, verify the live crypto price is far enough from the
    // Kalshi strike. At 82¢ (entry floor) a coin can sit just fractions above
    // the strike — a single adverse candle can flip the outcome. Gate is
    // FAIL-OPEN: if livePrice or kalshiStrike unavailable, bet proceeds normally.
    if (isConviction && decision.action !== "SKIP" && originalDecision.action !== "SKIP") {
      const _proxLivePrice = getCachedPrediction(sym)?.price ?? null;
      const _proxStrike    = kalshiData?.value ?? null;
      const _proxAtrPct    = getCachedPrediction(sym)?.indicators?.volatilityPct ?? null;
      const _prox = computeStrikeProximityGate({
        livePrice:       _proxLivePrice,
        kalshiStrike:    _proxStrike,
        direction:       decision.action === "BET_YES" ? "yes" : "no",
        thresholdPct:    getEffectiveProximityThreshold(sym, S.config),
        atrPct:          _proxAtrPct,
        atrScaleEnabled: S.config.strikeProximityAtrScale ?? true,
      });
      if (_prox.blocked) {
        logger.info(
          { sym, gapPct: _prox.gapPct, effectiveThreshold: _prox.effectiveThreshold, action: decision.action },
          "[conviction-diag] strike-proximity gate blocked — price too close to strike",
        );
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym, action: "SKIP", confidence: effectiveConfidence, score: 0,
          reason: `strike-proximity blocked — gap ${_prox.gapPct?.toFixed(3)}% < threshold ${_prox.effectiveThreshold.toFixed(3)}%`,
          windowKey, selected: false, evaluatedAt: now, trendStability: stability, regime,
        });
        continue;
      }
    }

    // Auto-tune shadow bet: `_autoTuneShadowDecision` is set only when the
    // auto-tune temp raise is the reason for SKIP.  `decision` was overridden to
    // `altDec` so that all downstream gates evaluated the hypothetical BET direction.
    // Any gate that fired issued a `continue` — so if the coin reached here,
    // ALL non-confidence gates passed for the hypothetical direction.
    // We use `originalDecision.action === "SKIP"` (not `decision.action`) because
    // `decision` was overridden to the BET alt-decision for gate evaluation.
    if (_autoTuneShadowDecision !== null && originalDecision.action === "SKIP") {
      const shadowDir: "yes" | "no" =
        _autoTuneShadowDecision.action === "BET_YES" ? "yes" : "no";
      void recordShadowBet(
        sym,
        shadowDir,
        effectiveConfidence,
        _autoTuneShadowDecision.signals,
        kalshiData?.value ?? null,
        windowKey,
        S.botMode,
        kalshiData?.ticker ?? null,
        "auto_tune",
      ).catch(err => logger.warn({ err, sym }, "[shadow-bet] auto-tune record failed (non-fatal)"));
    }

    evalResults.push({
      symbol: sym,
      // Use originalDecision.action so auto-tune shadow coins push as SKIP
      // (not BET_YES/BET_NO from the overridden alt-floor `decision`).
      action: originalDecision.action as "BET_YES" | "BET_NO" | "SKIP",
      confidence: effectiveConfidence,
      score,
      reason: finalReason,
      windowKey,
      selected: false,
      evaluatedAt: now,
      trendStability: stability,
      regime,
    });
  }

  // Sort: BET candidates descending by composite score, then SKIP coins.
  const bets = evalResults.filter(e => e.action !== "SKIP").sort((a, b) => b.score - a.score);
  const skips = evalResults.filter(e => e.action === "SKIP");

  // Directional-cap filter (post-loop, confidence-aware):
  // Applied after all coins are scored and sorted so we keep the HIGHEST-confidence
  // bets per direction and drop the weakest — not whichever coin happened to be
  // last in CRYPTO_COINS iteration order.
  // windowDirectionCounts reflects bets placed in PREVIOUS ticks this window;
  // `remaining` is how many more same-direction bets are still allowed.
  // Conviction mode: no directional cap — each coin fires independently the moment
  // its yesPrice enters the lock zone.  Capping direction would prevent valid NO
  // and YES bets from firing simultaneously when multiple coins are in zone.
  if (!S.config.freeRunMode && S.config.decisionMode !== "conviction" && S.config.enableDirectionCap && S.config.maxSameDirectionBets > 0) {
    // Effective cap is raised by parole when direction_cap shadow accuracy qualifies.
    const effectiveDirCap = S.config.maxSameDirectionBets + paroleState.dirCapIncrease;
    for (const dir of ["yes", "no"] as const) {
      const action = dir === "yes" ? "BET_YES" : "BET_NO";
      const alreadyPlaced = windowDirectionCounts.get(dir) ?? 0;
      const remaining = Math.max(0, effectiveDirCap - alreadyPlaced);
      // bets[] is sorted score DESC — dirBets preserves that order.
      const dirBets = bets.filter(e => e.action === action);
      if (dirBets.length > remaining) {
        // Keep the top `remaining` (highest score); drop the rest.
        const toCap = dirBets.slice(remaining);
        const cappedSyms = toCap.map(e => e.symbol);
        logger.info(
          { dir, alreadyPlaced, remaining, cap: effectiveDirCap, paroleBoost: paroleState.dirCapIncrease, dropped: cappedSyms },
          `[kalshi-bot] directional cap — keeping top ${remaining} ${dir.toUpperCase()} bets, dropping ${toCap.length} weakest`,
        );
        for (const e of toCap) {
          e.action = "SKIP";
          e.reason = `directional cap — ${dir.toUpperCase()} slots filled (kept higher-confidence entries)`;
          filteredByNewGuards.add(e.symbol);
          const idx = bets.indexOf(e);
          if (idx !== -1) bets.splice(idx, 1);
          skips.push(e);
          // Record shadow probe: direction_cap accuracy feeds paroleState.dirCapIncrease.
          const _dcKalshi = getKalshiCachedData(e.symbol);
          void recordShadowBet(
            e.symbol, dir, e.confidence, {},
            _dcKalshi?.value ?? null, windowKey, S.botMode, _dcKalshi?.ticker ?? null,
            "direction_cap",
          ).catch(err => logger.warn({ err, sym: e.symbol }, "[shadow-bet] direction_cap record failed"));
        }
      }
    }
  }

  // Cross-coin chop detection: when 4 or more eligible coins are all in the
  // "low conviction" confidence band (≤58%), the market is indecisive across
  // the board. Cap the bet count to 2 — the top two ranked candidates — to
  // avoid scattering capital into marginal signals that all look like noise.
  // Excess bets are downgraded to SKIP so Phase 4 cannot place them.
  const LOW_CONVICTION_BAND = 58;
  const CHOP_MIN_COINS = 4;
  const lowConvCount = bets.filter(e => e.confidence <= LOW_CONVICTION_BAND).length;
  if (!S.config.freeRunMode && lowConvCount >= CHOP_MIN_COINS) {
    const capped = bets.splice(2); // keep top 2, remove the rest
    for (const e of capped) {
      e.action = "SKIP";
      e.reason = `chop filter — ${lowConvCount} coins ≤${LOW_CONVICTION_BAND}% confidence, capped at 2 bets`;
      filteredByNewGuards.add(e.symbol);
      skips.push(e);
    }
    logger.info(
      { lowConvCount, cappedSymbols: capped.map(e => e.symbol) },
      `[kalshi-bot] chop filter: ${lowConvCount} low-confidence coins — capping to 2 bets this window`,
    );
  }

  if (bets.length > 0) {
    if (S.config.decisionMode === "conviction") {
      // Conviction: all qualifying coins fire in parallel — no single winner.
      // Mark the max-bet candidate (pre-selected by stability score) as "selected"
      // purely for UI display.  If none qualifies, fall back to bets[0].
      const _maxSym   = maxBetCandidateForWindow.get(windowKey) ?? null;
      const _maxEntry = _maxSym ? bets.find(e => e.symbol === _maxSym) : null;
      (_maxEntry ?? bets[0]).selected = true;
      logger.info(
        { symbols: bets.map(e => `${e.symbol}(${e.action})`), maxBetCandidate: _maxSym ?? "none", windowKey },
        "[kalshi-bot] conviction: dispatching all in-zone coins",
      );
    } else {
      bets[0].selected = true;
      const winner = bets[0];
      const multiplierDesc =
        winner.trendStability === "clean" ? "×1.2 (clean)" :
        winner.trendStability === "choppy" ? "×1.0 (choppy)" :
        winner.trendStability === null ? "×1.0 (pending)" : "×1.0";
      logger.info({
        symbol: winner.symbol,
        action: winner.action,
        confidence: winner.confidence,
        score: winner.score.toFixed(2),
        trendStability: winner.trendStability ?? "pending",
        multiplier: multiplierDesc,
        windowKey,
      }, "[kalshi-bot] best-market selected");
    }
  }
  // Stamp betPlacedThisWindow + placed bet details on every eval entry so the dashboard
  // shows accurate direction/confidence even after the coin switches to SKIP.
  const allResults = [...bets, ...skips];
  for (const e of allResults) {
    const wbKey = `${e.symbol}:${e.windowKey}:${S.botMode}`;
    e.betPlacedThisWindow = (windowBetCounts.get(wbKey) ?? 0) > 0;
    if (e.betPlacedThisWindow) {
      const details = windowBetDetails.get(wbKey);
      if (details) {
        e.placedBetDirection = details.direction;
        e.placedBetConfidence = details.confidence;
      }
    }
  }
  S.lastWindowEvaluation = allResults;

  // ── Kalshi price-parser health check ────────────────────────────────────
  // If every coin in this window was skipped because yesPrice was null, count it.
  // Three consecutive windows like this means the Kalshi API format likely changed
  // and the parser in crypto-kalshi.ts needs updating — surface as a loud ERROR.
  const allNullPrice = allResults.length > 0 &&
    allResults.every(e => e.reason === "no order book price — market illiquid");
  if (allNullPrice && windowKey !== lastAllNullPriceWindowKey) {
    consecutiveAllNullPriceWindows++;
    lastAllNullPriceWindowKey = windowKey;
    if (consecutiveAllNullPriceWindows >= 3) {
      logger.error(
        { consecutiveWindows: consecutiveAllNullPriceWindows, windowKey },
        "[kalshi-bot] ERROR: Kalshi price parsing broken — yesPrice=null for ALL coins " +
        `across ${consecutiveAllNullPriceWindows} consecutive windows. ` +
        "The Kalshi API likely changed its response format. " +
        "Check the WARN log in crypto-kalshi.ts for the actual price field names " +
        "currently returned, then update the parser (parseDollar/toFrac priority chain).",
      );
    } else {
      logger.warn(
        { consecutiveWindows: consecutiveAllNullPriceWindows, windowKey },
        "[kalshi-bot] all coins null-price this window — monitoring for API format change",
      );
    }
  } else if (!allNullPrice) {
    consecutiveAllNullPriceWindows = 0;
  }

  // Phase 4: run all eligible coins in parallel.
  // Phase 3 is the authoritative filter — it has already enforced the global bet cap,
  // directional caps, chop filter, and all other guards on bets[].
  // Reversing coins that were soft-skipped (trendStability="reversing") and coins
  // blocked by momentum override / directional-cap are excluded from execution.
  const betSymbols  = bets.map(e => e.symbol);
  const _isConvictionMode = S.config.decisionMode === "conviction";
  const skipSymbols = skips
    .filter(e => (_isConvictionMode || e.trendStability !== "reversing") && !filteredByNewGuards.has(e.symbol))
    .map(e => e.symbol);

  // Snapshot pre-launch open-position state for all candidates.
  // Must happen before any await so direction-count updates after settling are correct.
  const hadPositionBefore = new Map<string, boolean>(
    [...betSymbols, ...skipSymbols].map(sym => [sym, openPositions.has(sym)]),
  );

  const runCoin = async (sym: string) => {
    const kalshiData = getKalshiCachedData(sym);
    const prediction  = getCachedPrediction(sym);
    // In conviction mode: use the dedicated 1 s poller price (≤ 1.5 s fresh)
    // for the zone-trigger check so stale-cache mismatches can't cause false
    // positive entries.  Falls back to kalshiData.yesPrice only when the
    // poller has no fresh data (e.g. first tick before poller has run once).
    let yesPrice: number | null = kalshiData?.yesPrice ?? null;
    if (S.config.decisionMode === "conviction") {
      const pollerPrice = getConvictionLivePrice(sym);
      if (pollerPrice != null) {
        yesPrice =
          pollerPrice.yesAsk != null && pollerPrice.yesBid != null
            ? (pollerPrice.yesAsk + pollerPrice.yesBid) / 2
            : pollerPrice.yesAsk ?? pollerPrice.yesBid ?? yesPrice;
      }
    }
    try {
      await runBotTickForCoin(
        sym,
        kalshiData?.ticker ?? null,
        kalshiData?.value  ?? null,
        yesPrice,
        prediction?.candles ?? [],
      );
    } catch (err) {
      logger.warn({ err, sym }, "[kalshi-bot] loop tick error (non-fatal)");
    }
  };

  // CONVICTION MODE: run all bet candidates in parallel. Each coin independently
  // fires a FOK on its own yesPrice crossing — there's no global cap to serialize
  // around (cap is bypassed for conviction), so sequential execution would only
  // delay coins behind slow FOK retries from earlier coins.
  //
  // NON-CONVICTION: fire sequentially so each coin's bet increments windowTotalBets
  // before the next coin re-checks it. Running in parallel caused multiple coins to
  // all see globalBetsThisWindow=0 (the Phase-3 snapshot) and all place bets in the
  // same tick, violating maxBetsPerWindow.
  // Max-bet pre-selection: before running coins in parallel, score all stable
  // candidates and record the single best one.  Only the winner can claim the
  // global token — this eliminates the race where whichever coin's async tick
  // fires first wins the slot regardless of quality (ER / osc / ML).
  if (_isConvictionMode && S.config.convictionStabilityEnabled !== false && maxBetWindowToken.remaining > 0) {
    const minER     = S.config.convictionStabilityMinER     ?? 0.30;
    const maxOsc    = S.config.convictionStabilityMaxOsc    ?? 8;
    const maxVolPct = S.config.convictionStabilityMaxVolPct ?? 3.0;
    const minMLConf = S.config.convictionStabilityMinMLConf ?? 52;
    let bestSym: string | null = null;
    let bestScore = -Infinity;
    for (const sym of betSymbols) {
      const ind    = getCachedPrediction(sym)?.indicators;
      const mlConf = getLatestCoinSignals(sym)?.mlConfidence ?? null;
      if (!ind) continue;
      if (ind.efficiencyRatio  < minER)     continue;
      if (ind.oscillationCount > maxOsc)    continue;
      if (ind.volatilityPct    > maxVolPct) continue;
      if (mlConf !== null && mlConf < minMLConf) continue;
      // Composite score: ER is primary (×100), osc penalised (×1.5),
      // ML confidence secondary (×0.3), volatility penalised (×10).
      const score = ind.efficiencyRatio * 100
                  - ind.oscillationCount * 1.5
                  + (mlConf ?? minMLConf) * 0.3
                  - ind.volatilityPct * 10;
      if (score > bestScore) { bestScore = score; bestSym = sym; }
    }
    const prev = maxBetCandidateForWindow.get(windowKey);
    if (prev !== bestSym) {
      maxBetCandidateForWindow.set(windowKey, bestSym);
      if (bestSym) {
        logger.info(
          { sym: bestSym, score: bestScore.toFixed(2), windowKey },
          "[kalshi-bot] max-bet candidate pre-selected (best stable coin by ER/osc/ML)",
        );
      }
    }
  }

  if (_isConvictionMode) {
    await Promise.allSettled(betSymbols.map(runCoin));
  } else {
    for (const sym of betSymbols) {
      await runCoin(sym);
    }
  }

  // Then manage existing positions (skips) in parallel.
  await Promise.allSettled(skipSymbols.map(runCoin));

  // Update direction counts for all positions newly opened this tick.
  for (const sym of [...betSymbols, ...skipSymbols]) {
    if (!hadPositionBefore.get(sym) && openPositions.has(sym)) {
      const dir = openPositions.get(sym)!.direction;
      windowDirectionCounts.set(dir, (windowDirectionCounts.get(dir) ?? 0) + 1);
    }
  }
  } finally {
    tickInFlight = false;
  }
}

