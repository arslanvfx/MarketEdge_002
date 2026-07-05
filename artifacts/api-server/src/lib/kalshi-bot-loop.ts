import { db, kalshiBotBetsTable, botConfigTable, botAutoTuneLogTable } from "@workspace/db";
import { isAiFeatureEnabled } from "./ai-spend";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  checkMaxBetSizeGuard, checkDailyLossGuard, checkStreakPauseGuard,
  checkSlippageStrikeGuard, checkWindowMonitorReadyGuard, checkBalanceGuard,
  checkExposureGuard, applyDailyLossUpdate, applyStreakUpdate,
  checkDuplicatePositionGuard, checkManualPositionExistsGuard, checkManualSourceGuard,
} from "./kalshi-bot-guards";
import {
  DEFAULT_BOT_CONFIG, BET_PROFILES, computeDynamicBetSize, makeBotDecision,
  isInQuietHours, applyBetOutcome, tickCircuitBreakerWindow, checkMomentumOverride,
  deriveRegime, isLiveModePermitted, assertSetBotModeAllowed, resolveStartupMode,
  applyStartupModeRestore, buildStreakSnapshot, restoreStreakState,
  type BotConfig, type BotDecision, type CircuitBreakerState, type PriceRegime,
  type DecisionMode, type CoinStreakEntry,
} from "./kalshi-bot-engine";
import {
  makeInitialExitState, runExitGuard, type ExitState, type GuardStates,
} from "./kalshi-bot-exit";
import {
  buyYes, buyNo, sellYes, sellNo, getBalance, isKalshiConfigured, placeOrderWithRetry,
  getCachedKalshiBalance, invalidateBalanceCache, computeMarketableLimitPrice,
  fetchKalshiMarketResult, fetchKalshiSettledMarkets,
} from "./kalshi-trader";
import {
  getKalshiWindowContext, getWindowBetSignal, getTimingAnalysis, intraWindowMetrics,
  getCachedPrediction, getKalshiCachedData, fetchKalshiTarget, fetchLiveDirection,
  fetchTrendStabilityForBot, getPredictionAnalytics, getConfirmedTargetMs,
  CRYPTO_COINS, KALSHI_SERIES, currentWindowKey, type TrendStability,
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
  pausedCoins, paperCoinDailyLoss, liveCoinDailyLoss, paperCoinStreakState,
  liveCoinStreakState, coinSlippageStrikes, recentWindowOutcomes, windowCBBuffer,
  cachedPerformanceReportByMode, recentKalshiTargets, windowStabilityCache,
  paperStreakStore, liveStreakStore, makeStreakStore, streakStoreForMode,
  activeCoinDailyLoss, coinDailyLossForMode, activeCoinStreakState,
  coinStreakStateForMode, todayUTC, probeDb, resetDailyIfNeeded,
  REGIME_AGAINST_PENALTY_FALLBACK, CONTRARIAN_LIVE_REGIME_PENALTY,
  NOISE_CONFIDENCE_FLOOR, MIN_HARD_MODEL_SIGNALS, DB_DEGRADED_THRESHOLD,
  DB_DEGRADED_MIN_WINDOW_MS, REGIME_STRIKES_MAX, WINDOW_ENTRY_BUFFER_S,
  STABILITY_WAIT_MAX_S, COIN_YES_BLOCKED, COIN_FULLY_BLOCKED, TIMING_CACHE_TTL,
  type BotMode, type BotStatus, type OpenPosition, type OpenPositionDisplay,
  type BotStateSnapshot, type WindowCoinEvaluation, type ParoleState,
} from "./kalshi-bot-state";
import { evalClosedBets, reEvaluateSettledBets } from "./kalshi-bot-eval";
import { evalShadowBets, checkAllParoles, recordShadowBet } from "./kalshi-bot-shadow";
import { closePosition } from "./kalshi-bot-close";
import { runBotTickForCoin } from "./kalshi-bot-tick";
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
  if (!isAiFeatureEnabled("crypto_stability") || confirmed.length === 0) return;

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

// Iterates over all Kalshi-enabled coins, ensures fresh Kalshi market data is
// available (fetching from the public API if the cache is stale), then runs
// the bot tick for each coin.  The Kalshi market-data endpoint is public and
// requires no API key, so this works in both paper and live modes.
export async function runBotLoopTick(): Promise<void> {
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

  // Phase 1: refresh market data for all Kalshi-enabled coins — in parallel.
  // All Kalshi API calls fire simultaneously so the slowest coin sets the wait
  // time, not the sum of all coins.  Failures per-coin are swallowed here;
  // the prefetch orchestrator (runWindowOpenPrefetch) handles retry logging.
  await Promise.allSettled(
    CRYPTO_COINS
      .filter(c => KALSHI_SERIES[c.symbol])
      .map(c => fetchKalshiTarget(c.symbol).catch(() => null)),
  );

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
  if (pendingCoins.length > 0 && isAiFeatureEnabled("crypto_stability")) {
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

  // Quiet-hours gate: skip new entries during the configured UTC hour range.
  if (isInQuietHours(new Date().getUTCHours(), S.config.quietHoursStart, S.config.quietHoursEnd)) {
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
  if (weakWindowCount >= 2) windowDoubtPenalty = 8;
  else if (weakWindowCount === 1) windowDoubtPenalty = 4;
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
  S.currentWindowDoubtPenalty = windowDoubtPenalty;

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

  // Symbols blocked by the new regime-aware guards (momentum override, directional cap, border guard).
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

  for (const coin of CRYPTO_COINS) {
    if (!KALSHI_SERIES[coin.symbol]) continue;
    const sym = coin.symbol.toUpperCase();
    const kalshiData = getKalshiCachedData(sym);
    const winCtx = getKalshiWindowContext(sym);
    const secondsElapsed = winCtx?.secondsElapsed ?? 0;
    const minutesElapsed = winCtx?.minutesElapsed ?? 0;
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
    // Empty-book cooldown: if this coin's IOC order returned 0 fills on both attempts
    // this window, skip it — the book is genuinely empty. Cleared on window transition.
    // (First 0-fill does NOT block; bot retries once more ~30s later before giving up.)
    if (windowFailedFills.has(`${sym}:${windowKey}:${S.botMode}`)) {
      filteredByNewGuards.add(sym);
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: "empty-book cooldown — IOC returned 0 fills earlier this window", windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }
    if (secondsElapsed < WINDOW_ENTRY_BUFFER_S) {
      const remaining = Math.ceil(WINDOW_ENTRY_BUFFER_S - secondsElapsed);
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `window buffer (${remaining}s remaining)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }
    if (S.config.maxEntryMinutes > 0 && secondsElapsed > S.config.maxEntryMinutes * 60) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `past entry ceiling (>${S.config.maxEntryMinutes}min elapsed)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }
    // Global total-bet cap: if maxBetsPerWindow total bets have already been placed
    // across ALL coins this window, skip any coin that has not yet placed a bet.
    // Coins that already placed a bet are allowed to continue (for display/exit purposes).
    if (globalCapReached && !(windowBetCounts.get(`${sym}:${windowKey}:${S.botMode}`) ?? 0 > 0)) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `global bet cap reached (${globalBetsThisWindow}/${S.config.maxBetsPerWindow} bets this window)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }

    const minRem = S.config.minRemainingMinutes ?? 0;
    if (minRem > 0 && 15 * 60 - secondsElapsed < minRem * 60) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0, reason: `min-remaining floor (<${minRem}min remaining)`, windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
    }

    // Window Monitor readiness gate: defer (not permanently block) until the monitor
    // has ≥2 min of intra-window candle data.  Unlike filteredByNewGuards entries,
    // this coin is NOT blocked from Phase-4 for the whole window — the next 60-second
    // tick will re-evaluate it and find the monitor ready.
    if (checkWindowMonitorReadyGuard(getWindowBetSignal(sym)?.ready ?? false, S.config.requireMonitorReady ?? true)) {
      evalResults.push({ symbol: sym, action: "SKIP", confidence: 0, score: 0,
        reason: `window monitor not ready (${minutesElapsed.toFixed(1)}m elapsed — needs ≥2m)`,
        windowKey, selected: false, evaluatedAt: now, trendStability: null, regime });
      continue;
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
    if (isAiFeatureEnabled("crypto_stability") && !windowStabilityCache.has(sym)) {
      if (secondsElapsed < STABILITY_WAIT_MAX_S) {
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: 0,
          score: 0,
          reason: `pending trend analysis (${Math.round(secondsElapsed)}s elapsed — waiting up to ${STABILITY_WAIT_MAX_S}s)`,
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
        { sym, secondsElapsed: Math.round(secondsElapsed), windowKey },
        "[kalshi-bot] stability analysis timeout — proceeding without trend data",
      );
    }

    // Cached bot-timing accuracy is used for composite score ranking only.
    // Signal accuracy (from prediction_records) is passed separately to makeBotDecision
    // for the EV gate so it reflects signal quality rather than bot win rate.
    const marks = [1, 3, 6, 9, 12];
    const elapsedMin = Math.floor(minutesElapsed);
    const closest = marks.reduce((p, m) => Math.abs(m - elapsedMin) < Math.abs(p - elapsedMin) ? m : p, marks[0]);
    const timingAcc = S.timingCache.get(`${sym}:${closest * 60}`) ?? S.timingCache.get(`ALL:${closest * 60}`) ?? null;

    const signalAcc = getPredictionAnalytics(sym).bySource.ensemble.accuracyPct;
    // `let` so the auto-tune shadow path can temporarily substitute the alt-floor
    // decision for gate evaluation (see below).
    let decision = makeBotDecision(sym, S.config, kalshiData.ticker, kalshiData.yesPrice ?? null, minutesElapsed, signalAcc, kalshiData.value);
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
      S.config.minConfidence > S.config.autoTuneConfidenceRevertTo &&
      decision.action === "SKIP"
    ) {
      const origFloorConfig = { ...S.config, minConfidence: S.config.autoTuneConfidenceRevertTo };
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
      if (_isStreakPaused) {
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

    // ── Per-coin auto-tune pause (shadow probe) ───────────────────────────────
    // Fires after `decision` is computed so we can record a directional shadow
    // bet. checkAllParoles() clears pausedCoins early when shadow accuracy
    // reaches ≥60% over ≥3 evaluated bets (blockedBy="auto_tune_pause").
    if (pausedCoins.has(sym)) {
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
    let reversingCaution = false;
    if (stability === "reversing" && decision.action !== "SKIP" && !paroleState.reversing.has(sym)) {
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

    // Momentum override filter: skip when price trend opposes the proposed direction.
    // Bypassed when shadow accuracy for this coin/restriction meets the parole threshold.
    // filteredByNewGuards ensures Phase-4 cannot bypass this by calling runBotTickForCoin.
    if (decision.action !== "SKIP" && S.config.enableMomentumFilter && !paroleState.momentum.has(sym)) {
      const proposedDir = decision.action === "BET_YES" ? "yes" : "no";
      if (checkMomentumOverride(proposedDir, recentStrikes, 0.5, S.config.momentumWindowCount)) {
        logger.info({ sym, proposedDir, recentStrikes, windowCount: S.config.momentumWindowCount },
          `[kalshi-bot] momentum override — ${sym} trending against ${proposedDir.toUpperCase()} entry`);
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `momentum override — trending against ${proposedDir.toUpperCase()} entry`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: stability,
          regime,
        });
        void recordShadowBet(
          sym, proposedDir, effectiveConfidence, decision.signals,
          kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
          "momentum_override",
        ).catch(err => logger.warn({ err, sym }, "[shadow-bet] momentum_override record failed"));
        continue;
      }
    }

    // --- Per-coin blocking filters BEFORE directional cap ---
    // These must run before phase3DirectionCounts is incremented so that coins which will
    // never actually bet cannot steal a directional cap slot and prevent a valid coin
    // from entering. Example: SOL is COIN_FULLY_BLOCKED; if it passed the dirCap check
    // first it would increment phase3DirectionCounts["no"] to 3, then get SKIP'd here,
    // leaving only 3 real NO slots (instead of 4) for the remaining coins.
    if (decision.action !== "SKIP") {
      if (COIN_FULLY_BLOCKED.has(sym) && !paroleState.fullyBlocked.has(sym)) {
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `coin filter — ${sym} blocked (no edge in either direction: NO ${sym==="SOL"?"22":"?"}% WR, YES ${sym==="SOL"?"40":"?"}% WR)`,
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
      {
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

      // ── Price-band gates (market consensus) ─────────────────────────────────
      // These run before coin-specific quality gates because they are the
      // single strongest predictor of loss in the historical data:
      //
      //   YES lean (<50¢):    0% WR on 3 bets, −$5.94 total.  Market is saying
      //                       <50% chance of finishing above strike; betting YES
      //                       into that has no edge.
      //
      //   NO favorite (≥65¢): 0–25% WR on 6 bets, −$3.75 total.  When YES is
      //                       priced at 65¢+, market conviction is too strong
      //                       to bet NO profitably.
      //
      // yesPrice is in 0-1 scale (e.g. 0.43 = 43¢).
      if (decision.action === "BET_YES" && kalshiData.yesPrice != null && kalshiData.yesPrice < 0.50 && !paroleState.priceBandYes.has(sym)) {
        const priceCents = Math.round(kalshiData.yesPrice * 100);
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `YES price gate — market prices YES at ${priceCents}¢ (<50¢); 0% historical WR on lean YES bets`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: stability,
          regime,
        });
        void recordShadowBet(
          sym, "yes", effectiveConfidence, decision.signals,
          kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
          "price_band_yes",
        ).catch(err => logger.warn({ err, sym }, "[shadow-bet] price_band_yes record failed"));
        continue;
      }

      if (decision.action === "BET_NO" && kalshiData.yesPrice != null && kalshiData.yesPrice >= 0.65 && !paroleState.priceBandNo.has(sym)) {
        const priceCents = Math.round(kalshiData.yesPrice * 100);
        filteredByNewGuards.add(sym);
        evalResults.push({
          symbol: sym,
          action: "SKIP",
          confidence: effectiveConfidence,
          score: 0,
          reason: `NO price gate — market prices YES at ${priceCents}¢ (≥65¢); 0–25% historical WR betting NO against strong market consensus`,
          windowKey,
          selected: false,
          evaluatedAt: now,
          trendStability: stability,
          regime,
        });
        void recordShadowBet(
          sym, "no", effectiveConfidence, decision.signals,
          kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
          "price_band_no",
        ).catch(err => logger.warn({ err, sym }, "[shadow-bet] price_band_no record failed"));
        continue;
      }

      // YES below-strike gate: when the live crypto price is already below the
      // Kalshi strike by more than 0.3%, a YES bet needs a price recovery to win.
      // Historical data: ETH YES −0.042% and HYPE YES −0.123% below strike both
      // lost; adding a 0.3% buffer avoids false-positive SKIPs on near-flat markets.
      if (decision.action === "BET_YES" && kalshiData.value != null && !paroleState.yesBelowStrike.has(sym)) {
        const livePrice = getCachedPrediction(sym)?.price ?? null;
        const BELOW_STRIKE_YES_GAP = 0.003; // 0.3% below strike
        if (livePrice !== null && livePrice < kalshiData.value * (1 - BELOW_STRIKE_YES_GAP)) {
          const gapPct = ((kalshiData.value - livePrice) / kalshiData.value * 100).toFixed(3);
          logger.info(
            { sym, livePrice, kalshiTarget: kalshiData.value, gapPct },
            `[kalshi-bot] YES below-strike gate — ${sym} price −${gapPct}% below strike`,
          );
          filteredByNewGuards.add(sym);
          evalResults.push({
            symbol: sym,
            action: "SKIP",
            confidence: effectiveConfidence,
            score: 0,
            reason: `YES below-strike gate — price −${gapPct}% below strike; YES needs price to recover`,
            windowKey,
            selected: false,
            evaluatedAt: now,
            trendStability: stability,
            regime,
          });
          void recordShadowBet(
            sym, "yes", effectiveConfidence, decision.signals,
            kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
            "yes_below_strike",
          ).catch(err => logger.warn({ err, sym }, "[shadow-bet] yes_below_strike record failed"));
          continue;
        }
      }

      if (decision.action === "BET_YES") {
        if (COIN_YES_BLOCKED.has(sym) && !paroleState.yesBlocked.has(sym)) {
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

        // Signal quality gates for YES bets (direction-neutral logic applied
        // symmetrically to NO bets below):
        //
        // Rule A — No opposite signal: if any model that fired points NO while
        //   we want to bet YES, the signals are contradicted.  A contradicted
        //   bet (BTC stat=YES but ML=NO) is worse than no signal at all.
        //
        // Note: we intentionally do NOT block on low-confidence agreeing signals.
        //   When all models agree on direction, a weakly-confident model (e.g.
        //   Claude at 35%) still votes the right way — the EV gate handles the
        //   math.  Only direction contradictions (above === false) are hard stops.
        const yesSigs = decision.signals as {
          statAbove?: boolean | null; claudeAbove?: boolean | null; mlAbove?: boolean | null;
          statConfidence?: number | null; claudeConfidence?: number | null; mlConfidence?: number | null;
        };
        const yesViolation: string[] = [];
        for (const [name, above, conf] of [
          ["Stat",   yesSigs.statAbove,   yesSigs.statConfidence]   as const,
          ["Claude", yesSigs.claudeAbove, yesSigs.claudeConfidence] as const,
          ["ML",     yesSigs.mlAbove,     yesSigs.mlConfidence]     as const,
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

      if (decision.action === "BET_NO") {
        // Rule A — No opposite signal: any model pointing YES contradicts a NO bet.
        // Only direction contradictions block — same logic as YES gate above.
        // Low-confidence agreeing signals are accepted; the EV gate handles math.
        const noSigs = decision.signals as {
          statAbove?: boolean | null; claudeAbove?: boolean | null; mlAbove?: boolean | null;
          statConfidence?: number | null; claudeConfidence?: number | null; mlConfidence?: number | null;
        };
        const noViolation: string[] = [];
        for (const [name, above, conf] of [
          ["Stat",   noSigs.statAbove,   noSigs.statConfidence]   as const,
          ["Claude", noSigs.claudeAbove, noSigs.claudeConfidence] as const,
          ["ML",     noSigs.mlAbove,     noSigs.mlConfidence]     as const,
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


    // Regime filter: if recent settlements consistently closed on one side of the strike,
    // penalise bets going against that regime by raising the minimum confidence bar.
    // Bypassed when shadow accuracy for this coin/restriction meets the parole threshold.
    if (decision.action !== "SKIP") {
      const kalshiRegime = S.regimeCache.get(sym);
      const isAgainstRegime =
        (kalshiRegime === "above" && decision.action === "BET_NO") ||
        (kalshiRegime === "below" && decision.action === "BET_YES");
      if (isAgainstRegime && !paroleState.regime.has(sym)) {
        const penalised = effectiveConfidence - (S.config.regimePenalty ?? REGIME_AGAINST_PENALTY_FALLBACK);
        logger.info(
          { sym, kalshiRegime, action: decision.action, confidence: effectiveConfidence, penalised },
          `[kalshi-bot] regime filter — ${sym} regime=${kalshiRegime} vs ${decision.action}: confidence ${effectiveConfidence}→${penalised}`,
        );
        if (penalised < S.config.minConfidence) {
          filteredByNewGuards.add(sym);
          evalResults.push({
            symbol: sym,
            action: "SKIP",
            confidence: effectiveConfidence,
            score: 0,
            reason: `regime filter — ${kalshiRegime} regime, against-direction penalty → ${penalised}% < ${S.config.minConfidence}%`,
            windowKey,
            selected: false,
            evaluatedAt: now,
            trendStability: stability,
            regime,
          });
          const _rgDir: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";
          void recordShadowBet(
            sym, _rgDir, effectiveConfidence, decision.signals,
            kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
            "regime_penalty",
          ).catch(err => logger.warn({ err, sym }, "[shadow-bet] regime_penalty record failed"));
          continue;
        }
        effectiveConfidence = penalised;
      }
    }

    // Contrarian momentum gate: when the Kalshi strike-price trend (from recent
    // windows) is moving strongly against the proposed bet direction, the bot is
    // making a mean-reversion call that needs extra conviction.
    // Bypassed when shadow accuracy for this coin/restriction meets the parole threshold.
    if (decision.action !== "SKIP" && regime !== null && !paroleState.contrarian.has(sym)) {
      const isContrarian =
        (regime === "trending_down" && decision.action === "BET_YES") ||
        (regime === "trending_up"   && decision.action === "BET_NO");
      if (isContrarian) {
        const penalised = effectiveConfidence - CONTRARIAN_LIVE_REGIME_PENALTY;
        logger.info(
          { sym, regime, action: decision.action, confidence: effectiveConfidence, penalised },
          `[kalshi-bot] contrarian-momentum gate — ${sym} strike trend=${regime} vs ${decision.action}: ${effectiveConfidence}→${penalised}`,
        );
        if (penalised < S.config.minConfidence) {
          filteredByNewGuards.add(sym);
          evalResults.push({
            symbol: sym,
            action: "SKIP",
            confidence: effectiveConfidence,
            score: 0,
            reason: `contrarian-momentum gate — strikes ${regime === "trending_down" ? "falling" : "rising"}, betting ${decision.action === "BET_YES" ? "YES" : "NO"} needs +${CONTRARIAN_LIVE_REGIME_PENALTY}pp → ${penalised}% < ${S.config.minConfidence}%`,
            windowKey,
            selected: false,
            evaluatedAt: now,
            trendStability: stability,
            regime,
          });
          const _ctDir: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";
          void recordShadowBet(
            sym, _ctDir, effectiveConfidence, decision.signals,
            kalshiData?.value ?? null, windowKey, S.botMode, kalshiData?.ticker ?? null,
            "contrarian_penalty",
          ).catch(err => logger.warn({ err, sym }, "[shadow-bet] contrarian_penalty record failed"));
          continue;
        }
        effectiveConfidence = penalised;
      }
    }

    // Position-relative NO gate: when the live crypto price is already above the
    // Kalshi strike by > 0.1%, a NO bet is a mean-reversion call into a trending
    // market. Historical data shows 7/7 NO losses in exactly this configuration.
    // Require ML confirmation (mlAbove === false) OR broad 3-signal agreement to
    // allow entry — otherwise skip.  Bypassed by shadow parole when accuracy qualifies.
    if (decision.action === "BET_NO" && kalshiData.value !== null && !paroleState.noGate.has(sym)) {
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
    if (effectiveDoubtPenalty > 0 && effectiveConfidence < S.config.minConfidence + effectiveDoubtPenalty) {
      filteredByNewGuards.add(sym);
      evalResults.push({
        symbol: sym,
        action: "SKIP",
        confidence: effectiveConfidence,
        score: 0,
        reason: `doubt filter — ${weakWindowCount} weak recent window(s), ${effectiveConfidence}% < ${S.config.minConfidence + effectiveDoubtPenalty}% floor (+${effectiveDoubtPenalty}pp)`,
        windowKey,
        selected: false,
        evaluatedAt: now,
        trendStability: stability,
        regime,
      });

      // Record a shadow (probe) bet: the coin passed every non-confidence gate
      // but is blocked solely by the doubt-penalty confidence floor.  Shadow
      // accuracy feeds checkAllParoles() which can reduce the penalty early.
      if (
        effectiveDoubtPenalty > 0 &&
        effectiveConfidence >= S.config.minConfidence &&
        decision.action !== "SKIP"
      ) {
        const shadowDir: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";
        void recordShadowBet(
          sym,
          shadowDir,
          effectiveConfidence,
          decision.signals,
          kalshiData?.value ?? null,
          windowKey,
          S.botMode,
          kalshiData?.ticker ?? null,
          "doubt_penalty",
        ).catch(err => logger.warn({ err, sym }, "[shadow-bet] record failed (non-fatal)"));
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
  if (S.config.enableDirectionCap && S.config.maxSameDirectionBets > 0) {
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
  if (lowConvCount >= CHOP_MIN_COINS) {
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

  // Phase 4: run all eligible coins in parallel.
  // Phase 3 is the authoritative filter — it has already enforced the global bet cap,
  // directional caps, chop filter, and all other guards on bets[].
  // Reversing coins that were soft-skipped (trendStability="reversing") and coins
  // blocked by momentum override / directional-cap are excluded from execution.
  const betSymbols  = bets.map(e => e.symbol);
  const skipSymbols = skips
    .filter(e => e.trendStability !== "reversing" && !filteredByNewGuards.has(e.symbol))
    .map(e => e.symbol);

  // Snapshot pre-launch open-position state for all candidates.
  // Must happen before any await so direction-count updates after settling are correct.
  const hadPositionBefore = new Map<string, boolean>(
    [...betSymbols, ...skipSymbols].map(sym => [sym, openPositions.has(sym)]),
  );

  const runCoin = async (sym: string) => {
    const kalshiData = getKalshiCachedData(sym);
    const prediction  = getCachedPrediction(sym);
    try {
      await runBotTickForCoin(
        sym,
        kalshiData?.ticker   ?? null,
        kalshiData?.value    ?? null,
        kalshiData?.yesPrice ?? null,
        prediction?.candles  ?? [],
      );
    } catch (err) {
      logger.warn({ err, sym }, "[kalshi-bot] loop tick error (non-fatal)");
    }
  };

  // Fire all bet candidates in parallel so FOK retries and DB writes don't
  // serialize — all three (or however many Phase 3 approved) attempt concurrently.
  await Promise.allSettled(betSymbols.map(runCoin));

  // Then manage existing positions (skips) in parallel.
  await Promise.allSettled(skipSymbols.map(runCoin));

  // Update direction counts for all positions newly opened this tick.
  for (const sym of [...betSymbols, ...skipSymbols]) {
    if (!hadPositionBefore.get(sym) && openPositions.has(sym)) {
      const dir = openPositions.get(sym)!.direction;
      windowDirectionCounts.set(dir, (windowDirectionCounts.get(dir) ?? 0) + 1);
    }
  }
}

