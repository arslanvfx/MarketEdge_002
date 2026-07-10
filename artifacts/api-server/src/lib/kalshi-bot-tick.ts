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
  getCachedPrediction, getKalshiCachedData, fetchKalshiTarget,
  fetchTrendStabilityForBot, getPredictionAnalytics, getConfirmedTargetMs,
  getLatestCoinSignals,
  CRYPTO_COINS, KALSHI_SERIES, currentWindowKey, type TrendStability,
} from "./crypto";
import { triggerWindowPipeline } from "./kalshi-bot-pipeline";
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
  DB_DEGRADED_MIN_WINDOW_MS, REGIME_STRIKES_MAX,
  STABILITY_WAIT_MAX_S, COIN_YES_BLOCKED, COIN_FULLY_BLOCKED, TIMING_CACHE_TTL,
  tickInFlight,
  type BotMode, type BotStatus, type OpenPosition, type OpenPositionDisplay,
  type BotStateSnapshot, type WindowCoinEvaluation, type ParoleState,
} from "./kalshi-bot-state";
import { closePosition, persistBetRecord, BetRecordArgs } from "./kalshi-bot-close";
import { getTimingAccuracy } from "./kalshi-bot-db";
import { writeBotEntryTimingSnapshot } from "./kalshi-bot-entry-timing";

// Deduplication Set for bot entry timing snapshots (cleared implicitly as
// window keys rotate — each key encodes coin+windowKey+minuteMark+mode).
const entryTimingWritten = new Set<string>();

// Minimum cashout value (per contract) required to allow any mid-window exit.
// At $0 sell value there is no benefit over holding to expiry — the position
// might still recover. Only exit when there is meaningful value to capture.
const MIN_EXIT_CASHOUT_PER_CONTRACT = 0.15;


export async function runBotTickForCoin(
  symbol: string,
  kalshiTicker: string | null,
  kalshiTarget: number | null,
  yesPrice: number | null,
  candles: Array<{ c: number; h: number; l: number; t: number; v: number; o: number }>,
): Promise<void> {
  if (!S.config.enabled) return;

  const sym = symbol.toUpperCase();
  if (tickInFlight.has(sym)) return;
  tickInFlight.add(sym);

  try {
    await _runBotTick(sym, kalshiTicker, kalshiTarget, yesPrice, candles);
  } catch (err) {
    logger.warn({ err, sym }, "[kalshi-bot] tick error (non-fatal)");
  } finally {
    tickInFlight.delete(sym);
  }
}

async function _runBotTick(
  sym: string,
  kalshiTicker: string | null,
  kalshiTarget: number | null,
  yesPrice: number | null,
  candles: Array<{ c: number; h: number; l: number; t: number; v: number; o: number }>,
): Promise<void> {
  resetDailyIfNeeded();

  // Daily loss limit check
  if (S.dailyPnl <= -S.config.dailyLossLimit) {
    const limitPos = openPositions.get(sym);
    if (limitPos) {
      logger.warn({ sym }, "[kalshi-bot] daily limit hit — closing position");
      await closePosition(limitPos, yesPrice, kalshiTarget, "daily_loss_limit_hit");
      openPositions.delete(sym);
    }
    return;
  }

  if (S.paused) return;

  // Get ER from recent candles
  const metrics = candles.length >= 3 ? intraWindowMetrics(candles, 15) : null;
  const erValue = metrics?.efficiencyRatio ?? null;

  const winCtx = getKalshiWindowContext(sym);
  const minutesElapsed = winCtx?.minutesElapsed ?? 0;
  const secondsElapsed = winCtx?.secondsElapsed ?? 0;
  const windowKey = currentWindowKey();

  // ── POSITION MANAGEMENT ──────────────────────────────────────────────────
  // Each coin's tick independently manages its own position slot.  There is no
  // cross-symbol guard — coins are fully independent of one another.

  const pos = openPositions.get(sym);
  if (pos) {
    // Check if the window has changed (expired)
    if (pos.windowKey !== windowKey) {
      midExitedWindows.delete(sym); // clear flip state — new window starts fresh
      await closePosition(pos, yesPrice, kalshiTarget, "window_expired");
      openPositions.delete(sym);
    } else {
      // Use last known yes-price as fallback when the live cache returns null.
      // lastYesPrice is seeded from entryPrice and updated each tick where yesPrice
      // is non-null, so this prevents the exit guard from running blind on a stale cache miss.
      const effectiveYesPrice = yesPrice ?? pos.exitState.phase1.lastYesPrice;

      // Verbose per-tick diagnostics so Phase-2 / exit-guard decisions are observable in logs.
      const rawMovePp = effectiveYesPrice !== null
        ? (pos.direction === "yes"
            ? (pos.entryYesPrice - effectiveYesPrice) * 100
            : (effectiveYesPrice - pos.entryYesPrice) * 100)
        : null;
      logger.debug({
        sym,
        currentYesPrice: effectiveYesPrice,
        entryYesPrice: pos.entryYesPrice,
        movePp: rawMovePp?.toFixed(2),
        phase2ThresholdPp: S.config.phase2ThresholdPp,
        minutesElapsed,
        direction: pos.direction,
      }, "[kalshi-bot] exit-tick price check");

      // ── Minimum hold guard ────────────────────────────────────────────────
      // Block ALL exits (profit-lock, exit-guard, time-stop) for the first
      // minHoldMinutes after entry.  The market needs time to establish a
      // direction; reacting to the opening noise spike almost always means
      // exiting a winner too early.  After the hold period expires the normal
      // exit logic resumes, including model-signal re-checks.
      const minHoldMs = (S.config.minHoldMinutes ?? 4) * 60_000;
      const heldMs = Date.now() - pos.openedAt;
      if (minHoldMs > 0 && heldMs < minHoldMs) {
        const remainingSec = Math.ceil((minHoldMs - heldMs) / 1000);
        logger.debug(
          { sym, heldSec: Math.round(heldMs / 1000), remainingSec },
          "[kalshi-bot] minimum hold period active — skipping exit evaluation",
        );
        return;
      }

      // ── Mid-exit master switch ────────────────────────────────────────────
      // When enableMidExit is falsy, skip all cashout/exit evaluation.
      // The position will be closed normally when the window expires.
      // Use truthy check (not === false) so null/undefined from older DB rows also disables.
      if (!S.config.enableMidExit) return;

      // ── Profit-lock early cash-out ────────────────────────────────────────
      // When the position has captured ≥ profitLockPct% of its maximum possible
      // payout, cash out immediately rather than risk a late reversal.
      // Two guards prevent redundant triggers:
      //   • held ≥ 2 min (no opening-spike false trigger)
      //   • ≥ 2 min remaining (window resolves on its own if almost over)
      const profitLockThreshold = (S.config.profitLockPct ?? 0) / 100;
      if (
        profitLockThreshold > 0 &&
        effectiveYesPrice !== null &&
        Date.now() - pos.openedAt >= 2 * 60_000 &&
        secondsElapsed <= 13 * 60
      ) {
        const ep = pos.entryYesPrice;
        const lockRatio =
          pos.direction === "yes"
            ? (effectiveYesPrice - ep) / (1 - ep)
            : (ep - effectiveYesPrice) / ep;
        if (lockRatio >= profitLockThreshold) {
          logger.info(
            {
              sym,
              direction: pos.direction,
              lockRatioPct: `${(lockRatio * 100).toFixed(1)}%`,
              thresholdPct: `${(profitLockThreshold * 100).toFixed(0)}%`,
              minutesRemaining: (15 - minutesElapsed).toFixed(1),
              yesPrice: effectiveYesPrice,
              entryYesPrice: ep,
            },
            "[kalshi-bot] profit-lock triggered — cashing out early",
          );
          await closePosition(pos, effectiveYesPrice, kalshiTarget, "profit_lock");
          openPositions.delete(sym);
          return;
        }
      }

      // Run exit guard for the current position
      const timingAcc = await getTimingAccuracy(sym, minutesElapsed);
      const guard = runExitGuard(
        sym,
        pos.direction,
        minutesElapsed,
        effectiveYesPrice,
        pos.exitState,
        timingAcc,
        erValue,
        S.config.midExitSensitivity,
        S.config.phase2ThresholdPp,
        pos.entrySignals,
        S.config.minHoldMinutes ?? 4,
      );

      lastGuardStatesMap.set(sym, guard.guardStates);
      lastGuardReasonMap.set(sym, guard.reason);

      if (guard.guardStates.phase2Active && !pos.phase2Activated) {
        pos.phase2Activated = true;
        logger.info(
          {
            sym,
            yesPrice: effectiveYesPrice,
            entryYesPrice: pos.entryYesPrice,
            movePp: rawMovePp?.toFixed(2),
          },
          "[kalshi-bot] phase2 activated for position",
        );
      }

      logger.debug({
        sym,
        recommendation: guard.recommendation,
        guardReason: guard.reason,
        phase2Active: guard.guardStates.phase2Active,
        flipConfirmed: guard.guardStates.flipConfirmed,
        magnitudeOk: guard.guardStates.magnitudeOk,
        consensusOk: guard.guardStates.consensusOk,
        erOk: guard.guardStates.erOk,
        holdDurationOk: guard.guardStates.holdDurationOk,
      }, "[kalshi-bot] exit-guard result");

      if (guard.recommendation === "EXIT") {
        // Cashout floor: never exit mid-window if the sell value is below 40% of
        // the original entry cost.  Below this threshold the position is so far
        // underwater that cashing out locks in a large loss with little benefit —
        // it's better to let the market play out (hold to expiry or wait for a
        // real recovery that clears the 40% bar).
        const entryContractCost = pos.direction === "yes" ? pos.entryYesPrice : (1 - pos.entryYesPrice);
        const currentSellValue = effectiveYesPrice !== null
          ? (pos.direction === "yes" ? effectiveYesPrice : 1 - effectiveYesPrice) * pos.contractCount
          : null;
        const currentSellPerContract = effectiveYesPrice !== null
          ? (pos.direction === "yes" ? effectiveYesPrice : 1 - effectiveYesPrice)
          : null;
        const recoveryRatio = currentSellPerContract !== null
          ? currentSellPerContract / Math.max(entryContractCost, 0.01)
          : null;
        const belowRecoveryFloor = recoveryRatio !== null && recoveryRatio < 0.50;
        if (belowRecoveryFloor) {
          logger.info(
            { sym, direction: pos.direction,
              sellPct: recoveryRatio != null ? `${(recoveryRatio * 100).toFixed(0)}%` : "?",
              entryCost: entryContractCost.toFixed(2), guardReason: guard.reason },
            "[kalshi-bot] HOLD — cashout < 50% of entry cost; letting position play out",
          );
        } else {
          const isLateRecovery = guard.phase === 2;
          const exitReason = guard.phase === 2 ? "mid_exit_phase2" : "mid_exit_phase1";
          logger.info({ sym, exitReason, guardReason: guard.reason }, "[kalshi-bot] mid-exit triggered");
          await closePosition(pos, effectiveYesPrice, kalshiTarget, exitReason, isLateRecovery);
          openPositions.delete(sym);
          // Record that we exited mid-window so the entry loop can re-enter in
          // the opposite direction ("sell and rebuy") with a higher confidence bar.
          midExitedWindows.set(sym, { windowKey, direction: pos.direction });
        }
      }

      // Guaranteed time-stop: if < 2 minutes remain in the 15-min window AND the
      // position is losing (crypto price on the wrong side of the Kalshi strike),
      // exit immediately rather than riding to expiry at maximum loss.
      // Gated by enableTimeStop — when false (default), this block is fully skipped.
      if (S.config.enableTimeStop && openPositions.has(sym)) {
        const minutesRemaining = 15 - minutesElapsed;
        if (minutesRemaining < 2) {
          const cryptoPrice = getCachedPrediction(sym)?.price ?? null;
          const isPositionLosing = cryptoPrice !== null && (
            (pos.direction === "yes" && cryptoPrice < pos.kalshiTarget) ||
            (pos.direction === "no"  && cryptoPrice >= pos.kalshiTarget)
          );
          if (isPositionLosing) {
            // 40% recovery floor: if cashing out now would return less than 40% of
            // what was paid, it's not worth executing the sell.  Let the position
            // expire naturally — the market may still move in our favour in the
            // last 2 minutes, and the cost of closing a deeply-underwater position
            // exceeds the benefit versus simply riding to expiry.
            const tseEntryCost = pos.direction === "yes" ? pos.entryYesPrice : (1 - pos.entryYesPrice);
            const tseSellPerContract = effectiveYesPrice !== null
              ? (pos.direction === "yes" ? effectiveYesPrice : 1 - effectiveYesPrice)
              : null;
            const tseRecoveryRatio = tseSellPerContract !== null
              ? tseSellPerContract / Math.max(tseEntryCost, 0.01)
              : null;
            if (tseRecoveryRatio !== null && tseRecoveryRatio < 0.50) {
              logger.info(
                { sym, minutesRemaining,
                  sellPct: `${(tseRecoveryRatio * 100).toFixed(0)}%`, entryCost: tseEntryCost.toFixed(2) },
                "[kalshi-bot] time-stop HOLD — cashout < 50% of entry cost; letting position expire",
              );
            } else {
              logger.info(
                {
                  sym,
                  minutesRemaining,
                  cryptoPrice,
                  strike: pos.kalshiTarget,
                  direction: pos.direction,
                  yesPrice: effectiveYesPrice,
                },
                "[kalshi-bot] time-stop triggered — exiting losing position before expiry",
              );
              await closePosition(pos, effectiveYesPrice, kalshiTarget, "mid_exit_time");
              openPositions.delete(sym);
            }
          }
        }
      }
    }
    return; // managed position this tick — check re-entry on next tick
  }

  // ── ENTRY DECISION ────────────────────────────────────────────────────────

  // Multi-bet guard: purge stale window entries then check the per-window cap.
  // Purge any entry for this symbol that belongs to an older window key (any mode).
  for (const [k] of windowBetCounts) {
    if (k.startsWith(`${sym}:`) && !k.startsWith(`${sym}:${windowKey}:`)) {
      windowBetCounts.delete(k);
    }
  }
  // Mode-aware key so paper bets don't count against the live cap and vice-versa.
  const windowBetKey = `${sym}:${windowKey}:${S.botMode}`;
  const betsThisWindow = windowBetCounts.get(windowBetKey) ?? 0;
  if (betsThisWindow >= S.config.maxBetsPerWindow) {
    logger.debug({ sym, betsThisWindow, max: S.config.maxBetsPerWindow }, "[kalshi-bot] maxBetsPerWindow reached — skipping entry");
    return;
  }

  // Ceiling: skip if bot has been in the window longer than maxEntryMinutes.
  // 0 = disabled (no ceiling — enter at any point).
  if (S.config.maxEntryMinutes > 0 && secondsElapsed > S.config.maxEntryMinutes * 60) return;
  // Floor: early-exit the tick if fewer than minRemainingMinutes remain.
  // This is a soft/configurable guard checked at tick start.  The hard
  // non-configurable 3-minute floor is re-checked with fresh Date.now()
  // immediately before the order is placed — see HARD LATE-ENTRY FLOOR below.
  // Default 3 to match the hard floor; setting it higher gives extra headroom.
  const minRemaining = S.config.minRemainingMinutes ?? 3;
  if (15 * 60 - secondsElapsed < minRemaining * 60) {
    logger.debug({ sym, secondsElapsed, minRemaining }, "[kalshi-bot] min-remaining floor — skipping tick early");
    return;
  }
  if (!kalshiTicker || kalshiTarget === null) return;

  // New-ticker detection: when a new Kalshi ticker is first seen for a symbol,
  // trigger the window pipeline (fire-and-forget, idempotent).  The pipeline
  // runs Claude with a rich prompt that includes the explicit window-close time,
  // stat direction, and fresh indicators — replacing the old eager fetchLiveDirection.
  // If runWindowOpenPrefetch already fired the pipeline, triggerWindowPipeline is a
  // no-op.  This block acts as a fallback for coins whose Kalshi market wasn't yet
  // published at prefetch time.
  if (prefetchedTicker.get(sym) !== kalshiTicker) {
    prefetchedTicker.set(sym, kalshiTicker);
    triggerWindowPipeline(sym, windowKey); // fire-and-forget, idempotent
  }

  // ── All-signals gate (HARD RULE) ───────────────────────────────────────────
  // The bot must NEVER enter a bet unless ALL THREE model signals — stat,
  // Claude, and ML — are non-null.  Signals are read LIVE from the predictor
  // layer (the same caches the Crypto Predictor page displays), not from the
  // stored pipeline snapshot, so the very next tick after the predictor
  // produces the missing signal can proceed without waiting for a re-check.
  //
  // There is no time-based fallback — we would rather miss the window entry
  // than bet with incomplete signal data.  (Open-position management is
  // unaffected: this gate only blocks NEW entries, and _runBotTick for open
  // positions is handled in Phase 2 before this point.)
  {
    const live = getLatestCoinSignals(sym);
    if (live.statAbove === null || live.claudeAbove === null || live.mlAbove === null) {
      logger.info(
        {
          sym, windowKey, secondsElapsed,
          statAbove: live.statAbove, claudeAbove: live.claudeAbove, mlAbove: live.mlAbove,
        },
        "[kalshi-bot] waiting for all signals (stat+Claude+ML) — no bet until all three are ready",
      );
      return;
    }
  }

  // Use ensemble signal accuracy (from prediction_records historyStore) for the
  // EV gate — not the bot's own win rate, which is contaminated by exit decisions.
  const signalAcc = getPredictionAnalytics(sym).bySource.ensemble.accuracyPct;
  // livePrice: used by position_confirm mode to gate on current price vs strike.
  // Read from the predictor cache — same source as the strike-proximity guard below.
  const livePrice = getCachedPrediction(sym)?.price ?? null;
  const decision = makeBotDecision(
    sym,
    S.config,
    kalshiTicker,
    yesPrice,
    minutesElapsed,
    signalAcc,
    kalshiTarget,  // pass through so ML doesn't re-fetch a potentially stale cache
    livePrice,
  );

  // ── Bot entry timing snapshot (fire-and-forget, once per minute per coin) ──
  // Captures the composite model direction + confidence at this minute mark so
  // we can later compute per-minute accuracy vs. return-ratio curves.
  {
    const windowKeyMs  = new Date(windowKey).getTime();
    const clockElapsedS = (Date.now() - windowKeyMs) / 1000;
    const minuteMark   = Math.min(14, Math.max(0, Math.floor(clockElapsedS / 60)));
    const timingKey    = `${sym}:${windowKey}:${minuteMark}:${S.botMode}`;
    if (!entryTimingWritten.has(timingKey)) {
      entryTimingWritten.add(timingKey);
      writeBotEntryTimingSnapshot({
        id:                   timingKey,
        coin:                 sym,
        windowKey,
        minuteMark,
        mode:                 S.botMode,
        statAbove:            decision.signals.statAbove,
        claudeAbove:          decision.signals.claudeAbove,
        mlAbove:              decision.signals.mlAbove,
        compositeDirection:   decision.signals.mlAbove,
        compositeConfidence:  decision.confidence,
        yesPrice,
      }).catch(() => { entryTimingWritten.delete(timingKey); });
    }
  }

  // ── Defense-in-depth coin direction filters ───────────────────────────────
  // These mirror the Phase-3 selection guards.  Phase-3 only adds a coin to
  // filteredByNewGuards when its makeBotDecision result is BET_YES at Phase-3
  // evaluation time.  If signals shift between Phase-3 and this tick, the Phase-3
  // result may have been SKIP (so the coin was never flagged), yet here
  // makeBotDecision now returns BET_YES — slipping past the per-coin block.
  // Re-checking here closes that race window unconditionally.
  if (!S.config.freeRunMode && decision.action === "BET_YES" && COIN_YES_BLOCKED.has(sym)) {
    logger.debug({ sym }, "[kalshi-bot] _runBotTick: BET_YES blocked by COIN_YES_BLOCKED (defense-in-depth)");
    return;
  }
  if (!S.config.freeRunMode && decision.action !== "SKIP" && COIN_FULLY_BLOCKED.has(sym)) {
    logger.debug({ sym }, "[kalshi-bot] _runBotTick: entry blocked by COIN_FULLY_BLOCKED (defense-in-depth)");
    return;
  }

  // ── Claude direction quality gate (defense-in-depth) ─────────────────────
  // Phase-3 enforces: for a YES bet Claude must not call NO, for a NO bet
  // Claude must not call YES.  Phase-3 is bypassed when the pipeline-completion
  // trigger (_firePipelineEntryForCoin) calls _runBotTick directly, so this
  // guard must also live here.  Without it, a YES bet can fire even when Claude
  // is calling BELOW — exactly the bug observed when ML briefly outputted YES
  // at window-open before settling to NO, while Claude's opening call was BELOW.
  //
  // BYPASS for position_confirm: in that mode direction is determined by where
  // the live price IS relative to the Kalshi strike — Claude is a soft veto
  // (handled inside makeBotDecision: ≥2 model vetoes → SKIP).  Applying a
  // hard Claude veto here would silently kill all bets where Claude's directional
  // prediction happens to disagree with the current price position.
  if (S.config.decisionMode !== "position_confirm" && S.config.decisionMode !== "market_lock") {
    const dirSigs = decision.signals as { claudeAbove?: boolean | null };
    if (decision.action === "BET_YES" && dirSigs.claudeAbove === false) {
      logger.info(
        { sym, windowKey, claudeAbove: dirSigs.claudeAbove, confidence: decision.confidence },
        "[kalshi-bot] _runBotTick: BET_YES blocked — Claude says NO (direction quality gate)",
      );
      return;
    }
    if (decision.action === "BET_NO" && dirSigs.claudeAbove === true) {
      logger.info(
        { sym, windowKey, claudeAbove: dirSigs.claudeAbove, confidence: decision.confidence },
        "[kalshi-bot] _runBotTick: BET_NO blocked — Claude says YES (direction quality gate)",
      );
      return;
    }
  }

  // ── RE-ENTRY GUARD ───────────────────────────────────────────────────────
  // If we exited a position mid-window (fast-flip or phase-2), we may re-enter
  // — but only in the OPPOSITE direction, and only with a higher confidence bar
  // (+5pp) to avoid immediately flipping back on noise.
  const recentFlip = midExitedWindows.get(sym);
  if (recentFlip && recentFlip.windowKey === windowKey && decision.action !== "SKIP") {
    const exitedDir = recentFlip.direction; // "yes" or "no"
    const newDir = decision.action === "BET_YES" ? "yes" : "no";
    if (newDir === exitedDir) {
      // Same direction as what we just exited — skip to avoid whipsawing.
      logger.debug({ sym, exitedDir, newDir }, "[kalshi-bot] re-entry blocked — same direction as mid-exit");
      return;
    }
    // Opposite direction is allowed but requires higher confidence.
    const flipConfidenceBar = (S.config.minConfidence ?? 65) + 5;
    if (decision.confidence < flipConfidenceBar) {
      logger.debug({ sym, confidence: decision.confidence, flipConfidenceBar }, "[kalshi-bot] re-entry blocked — confidence below flip bar");
      return;
    }
    logger.info({ sym, exitedDir, newDir, confidence: decision.confidence }, "[kalshi-bot] flip re-entry — entering opposite direction after mid-exit");
    // Clear the flip record so we don't double-guard
    midExitedWindows.delete(sym);
  }

  if (decision.action === "SKIP") {
    // Always log the skip reason at info level so production logs show exactly
    // why each bet was not placed.  DB persistence is deduplicated (once per
    // window) but the log fires on every tick so the most recent reasoning is
    // always visible even when the DB write fails due to connection issues.
    logger.info(
      {
        sym, windowKey, secondsElapsed,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        statAbove: decision.signals.statAbove,
        claudeAbove: decision.signals.claudeAbove,
        mlAbove: decision.signals.mlAbove,
        statConf: decision.signals.statConfidence,
        claudeConf: decision.signals.claudeConfidence,
        mlConf: decision.signals.mlConfidence,
      },
      "[kalshi-bot] SKIP decision",
    );
    // Persist at most once per (symbol, window) to avoid flooding the DB
    if (lastDecisionWindowKey.get(sym) !== windowKey) {
      lastDecisionWindowKey.set(sym, windowKey);
      await persistBetRecord({
        symbol: sym,
        windowKey,
        ticker: kalshiTicker,
        direction: null,
        action: "skip",
        signals: decision.signals,
        entryPrice: null,
        kalshiTarget,
      });
    }
    return;
  }

  // ── Per-coin streak pause ─────────────────────────────────────────────────
  // If a coin lost N consecutive windows it is S.paused for M windows.  The pause
  // key is an ISO windowKey string — skip while the current window ≤ pause key.
  // When the pause expires, clear pauseUntilWindowKey so a future losing streak
  // can re-arm a new pause without requiring a win to reset the field first.
  const streakMap = activeCoinStreakState();
  const streakInfo = streakMap.get(sym);
  const streakPause = checkStreakPauseGuard(streakInfo?.pauseUntilWindowKey ?? null, windowKey);
  if (!S.config.freeRunMode && streakPause.blocked) {
    logger.info(
      { sym, pauseUntilWindowKey: streakInfo!.pauseUntilWindowKey, windowKey, consecutiveLosses: streakInfo!.consecutiveLosses },
      "[kalshi-bot] SKIP — coin paused after consecutive window losing streak",
    );
    return;
  } else if (streakPause.expired && streakInfo) {
    // Pause has expired — clear it so subsequent streaks can trigger new pauses.
    streakInfo.pauseUntilWindowKey = null;
    streakMap.set(sym, streakInfo);
  }

  // ── Pre-entry streak block ────────────────────────────────────────────────
  // Block entry only after the Nth loss has already been recorded — the coin
  // gets to attempt the recovery bet and the pause only kicks in if it loses
  // again.  The post-loss pause (coinStreakPauseWindows) handles the cooldown
  // after the limit is reached and that pause is set by the eval/close path.
  if (!S.config.freeRunMode) {
    const streakLimit = S.config.coinStreakLossLimit ?? 3;
    const currentLosses = streakInfo?.consecutiveLosses ?? 0;
    if (streakLimit > 0 && currentLosses >= streakLimit) {
      logger.info(
        { sym, currentLosses, streakLimit },
        "[kalshi-bot] SKIP — pre-entry streak block: already at streak limit",
      );
      return;
    }
  }

  // ── Per-coin daily loss cap ───────────────────────────────────────────────
  // Skip for the rest of the UTC day when this coin's losses reach the cap.
  const coinLossToday = activeCoinDailyLoss().get(sym) ?? 0;
  const maxCoinLoss = S.config.maxDailyLossPerCoin ?? 3;
  if (checkDailyLossGuard(coinLossToday, maxCoinLoss)) {
    logger.info(
      { sym, coinLossToday: coinLossToday.toFixed(4), maxDailyLossPerCoin: maxCoinLoss },
      "[kalshi-bot] SKIP — coin has reached its daily loss cap",
    );
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Place the bet
  const direction: "yes" | "no" = decision.action === "BET_YES" ? "yes" : "no";

  // ── Candle momentum guard ─────────────────────────────────────────────────
  // Skip entry when the last N one-minute candles are clearly running against
  // the bet direction. Catches intra-window reversals the snap-time model missed.
  // Threshold: 0.15% net move over the last N closes. Calibrated so normal
  // noise (~0.05%) doesn't trigger, but a steady push does.
  // N = config.momentumLookbackCandles (default 8 — extended from legacy 4 to
  // catch medium-duration drops that leave recent candles oscillating at the low).
  {
    const lookbackCandles = S.config.momentumLookbackCandles ?? 8;
    const pred = getCachedPrediction(sym);
    const candles = pred?.candles ?? [];

    // ── Missing-data block ────────────────────────────────────────────────
    // If the prediction cache isn't warm enough for the full lookback, block
    // rather than silently pass. At T+2 with a healthy tracker this cache is
    // always populated; fewer candles than the lookback means a fresh restart.
    if (pred == null || candles.length < lookbackCandles) {
      logger.info(
        { sym, direction, candleCount: candles.length, lookbackCandles, predCached: pred != null },
        "[kalshi-bot] SKIP — prediction cache not warm enough for momentum check",
      );
      if (lastDecisionWindowKey.get(sym) !== windowKey) {
        lastDecisionWindowKey.set(sym, windowKey);
        await persistBetRecord({
          symbol: sym, windowKey, ticker: kalshiTicker, direction,
          action: "skip",
          signals: { ...decision.signals, reason: "candle-cache-not-warm", candleCount: candles.length },
          entryPrice: yesPrice, kalshiTarget,
        });
      }
      return;
    }

    const recent = candles.slice(-lookbackCandles);
    const firstClose = recent[0].c;
    const lastClose  = recent[recent.length - 1].c;
    if (firstClose > 0) {
      const netChangePct = ((lastClose - firstClose) / firstClose) * 100;
      const MOMENTUM_REVERSAL_PCT = 0.15;
      const opposing =
        (direction === "yes" && netChangePct < -MOMENTUM_REVERSAL_PCT) ||
        (direction === "no"  && netChangePct >  MOMENTUM_REVERSAL_PCT);
      if (opposing) {
        logger.info(
          { sym, direction, netChangePct: +netChangePct.toFixed(3) },
          "[kalshi-bot] SKIP — candle momentum opposes bet direction (reversal guard)",
        );
        if (lastDecisionWindowKey.get(sym) !== windowKey) {
          lastDecisionWindowKey.set(sym, windowKey);
          await persistBetRecord({
            symbol: sym, windowKey, ticker: kalshiTicker, direction,
            action: "skip",
            signals: { ...decision.signals, reason: "candle-momentum-reversal", netChangePct: +netChangePct.toFixed(3) },
            entryPrice: yesPrice, kalshiTarget,
          });
        }
        return;
      }
    }

    // ── Strike proximity guard ─────────────────────────────────────────────
    // Skip when the live price is within 0.05% of the Kalshi target.
    // At that proximity a single tick crosses the strike and flips the
    // outcome — the bet is effectively a coin flip regardless of signals.
    // Only applied on the "at risk" side for each direction:
    //   NO  bet + price barely below target → one tick up = loss
    //   YES bet + price barely above target → one tick down = loss
    const livePrice = pred?.price;
    if (!S.config.freeRunMode && livePrice != null && livePrice > 0 && kalshiTarget > 0) {
      const STRIKE_PROXIMITY_PCT = 0.03;
      const distancePct = Math.abs((livePrice - kalshiTarget) / kalshiTarget) * 100;
      const tooClose =
        (direction === "no"  && livePrice <  kalshiTarget && distancePct < STRIKE_PROXIMITY_PCT) ||
        (direction === "yes" && livePrice >= kalshiTarget && distancePct < STRIKE_PROXIMITY_PCT);
      if (tooClose) {
        logger.info(
          { sym, direction, livePrice, kalshiTarget, distancePct: +distancePct.toFixed(4) },
          "[kalshi-bot] SKIP — price within strike proximity threshold (proximity guard)",
        );
        if (lastDecisionWindowKey.get(sym) !== windowKey) {
          lastDecisionWindowKey.set(sym, windowKey);
          await persistBetRecord({
            symbol: sym, windowKey, ticker: kalshiTicker, direction,
            action: "skip",
            signals: { ...decision.signals, reason: "strike-proximity", livePrice, kalshiTarget, distancePct: +distancePct.toFixed(4) },
            entryPrice: yesPrice, kalshiTarget,
          });
        }
        return;
      }
    }

    // ── Strike-oscillation filter ─────────────────────────────────────────
    // Skip when price has been bouncing repeatedly across the strike in
    // the last 6 one-minute candles.  Two or more crossings mean the market
    // is chopping around the target — no directional edge regardless of what
    // the models say.  One crossing is fine (directional momentum shift);
    // zero crossings means price is cleanly on one side (ideal entry).
    if (!S.config.freeRunMode && kalshiTarget > 0 && pred != null && pred.candles.length >= 6) {
      const recent6 = pred.candles.slice(-6);
      let crossings = 0;
      let prevSide: boolean | null = null;
      for (const candle of recent6) {
        const side = candle.c >= kalshiTarget;
        if (prevSide !== null && side !== prevSide) crossings++;
        prevSide = side;
      }
      if (crossings >= 3) {
        logger.info(
          { sym, direction, crossings, kalshiTarget },
          "[kalshi-bot] SKIP — strike-oscillation: price crossing strike repeatedly",
        );
        if (lastDecisionWindowKey.get(sym) !== windowKey) {
          lastDecisionWindowKey.set(sym, windowKey);
          await persistBetRecord({
            symbol: sym, windowKey, ticker: kalshiTicker, direction,
            action: "skip",
            signals: { ...decision.signals, reason: "strike-oscillation", crossings, kalshiTarget },
            entryPrice: yesPrice, kalshiTarget,
          });
        }
        return;
      }
    }
  }

  // ── LIVE-ASK FILL PRICE ──────────────────────────────────────────────────
  // Use the live Kalshi bid/ask (cached from the most recent fetchKalshiTarget
  // call, typically ≤12s old) to compute the order price and contract count.
  //
  // This eliminates the midpoint-anchor + return-multiple-cap interaction that
  // blocked fills: the old logic added +0.15 to the midpoint but then capped
  // the result at 1/minReturnMultiple (≈0.714 for 1.4×), so a YES ask at 72c
  // would never fill even with Phase 2 escalation.
  //
  //   YES: submit a BID at yes_ask  → cost per contract = yes_ask
  //   NO:  submit an ASK at yes_bid → cost per contract = 1 − yes_bid
  //        (placing our ask at the bid price crosses the spread for NO fills)
  //
  // Falls back to the midpoint-buffer calculation when live prices are absent.
  const _cachedKalshi = getKalshiCachedData(sym);
  const liveYesAsk = _cachedKalshi?.yesAsk != null && _cachedKalshi.yesAsk > 0
    ? _cachedKalshi.yesAsk
    : null;
  const liveYesBid = _cachedKalshi?.yesBid != null && _cachedKalshi.yesBid > 0
    ? _cachedKalshi.yesBid
    : null;

  // The YES-side reference price (raw cached ask/bid).
  // Used for expectedFillCost sizing and the return-floor gate — NOT for the
  // actual order price (see orderLimitPrice below).
  const liveLimitPrice: number | null =
    direction === "yes" ? liveYesAsk : liveYesBid;

  // Cost per contract (dollars actually at risk per contract):
  //   YES: = yes_ask (the price we pay)
  //   NO:  = 1 − yes_bid (complement of the YES bid credit we receive on fill)
  // Legacy fallback uses the midpoint-based buffer + return-floor cap.
  const legacySideCost = direction === "yes" ? (yesPrice ?? 0.5) : (1 - (yesPrice ?? 0.5));
  const expectedFillCost: number =
    direction === "yes"
      ? (liveLimitPrice ?? computeMarketableLimitPrice("bid", yesPrice, S.config.minReturnMultiple))
      : (liveYesBid != null && liveYesBid > 0
          ? (1 - liveYesBid)
          : legacySideCost);

  // Crossing buffer: bid 3 cents above the cached ask (or 3 cents below the cached
  // bid for NO) so that minor ask drift between prefetch and order arrival still fills.
  // Without this, even a 1-cent move in the ask causes our IOC to return 0 fills.
  // The buffer is capped at the return floor — we never bid above what minReturnMultiple
  // allows. The exchange always price-improves us to the actual resting ask, so paying
  // the buffer price is the ceiling, not the typical outcome.
  //   YES: bid at min(yesAsk + 0.03, maxCost),  cent-floored
  //   NO:  ask at max(yesBid − 0.03, 1−maxCost), cent-ceiled
  const _entryReturnFloor = S.config.minReturnMultiple ?? 1.45;
  const _entryMaxCost = 1 / _entryReturnFloor;
  const orderLimitPrice: number | null = (() => {
    const CROSSING_BUFFER = 0.03;
    if (direction === "yes") {
      if (liveYesAsk == null) return null;
      const raw = liveYesAsk + CROSSING_BUFFER;
      return Math.floor(Math.min(raw, _entryMaxCost) * 100) / 100;
    } else {
      if (liveYesBid == null) return null;
      const raw = liveYesBid - CROSSING_BUFFER;
      return Math.ceil(Math.max(raw, 1 - _entryMaxCost) * 100) / 100;
    }
  })();

  // ── RETURN FLOOR GATE (actual fill cost) ────────────────────────────────
  // The decision engine already gates on minReturnMultiple using the midpoint
  // yesPrice. This second check uses the ACTUAL cost we will pay (live ask or
  // legacy midpoint+buffer) so a live ask that drifted above the midpoint can
  // never produce a sub-1.45x fill.
  //   YES: cost = yes_ask;  return = 1/cost. Need cost ≤ 1/1.45 ≈ 0.6897.
  //   NO:  cost = 1−yes_bid; return = 1/cost. Same threshold.
  // 1/1.45 ≈ 0.6897 → nearest cent-aligned ceiling is 0.68 (return 1.471x).
  // We compare against the raw 1/1.45 float so a 0.69 cost (1.449x) is blocked.
  {
    const minReturnFloor = S.config.minReturnMultiple ?? 1.45;
    const maxAllowedCost = 1 / minReturnFloor;
    if (expectedFillCost > maxAllowedCost) {
      logger.warn(
        {
          sym,
          direction,
          expectedFillCost: expectedFillCost.toFixed(4),
          maxAllowedCost: maxAllowedCost.toFixed(4),
          impliedReturn: (1 / expectedFillCost).toFixed(3),
          minReturnFloor,
        },
        "[kalshi-bot] SKIP — live fill cost exceeds return floor; actual return < minReturnMultiple",
      );
      return;
    }
  }

  // ── Market consensus gate ─────────────────────────────────────────────────
  // Skip when the Kalshi market itself prices the outcome strongly against the
  // bet direction — the market embeds real-time crowd wisdom we should respect.
  //
  //   YES bet blocked when YES ask < consensusMinCents¢
  //     (market implies <X% probability of YES — overwhelming consensus for NO)
  //   NO  bet blocked when YES ask > (100 − consensusMinCents)¢
  //     (market implies >X% probability of YES — overwhelming consensus against NO)
  //
  // Uses the live ask/bid; falls back to decision yesPrice when cache is absent.
  // consensusMinCents=25 (default) → don't bet against 3:1 market odds.
  // Set to 0 to disable.
  if (!S.config.freeRunMode && (S.config.consensusMinCents ?? 25) > 0) {
    const consensusFloor = (S.config.consensusMinCents ?? 25) / 100;
    const refYesAsk = liveYesAsk ?? yesPrice ?? null;
    const consensusBlocked = refYesAsk != null && (
      (direction === "yes" && refYesAsk < consensusFloor) ||
      (direction === "no"  && refYesAsk > (1 - consensusFloor))
    );
    if (consensusBlocked) {
      const pricePct  = Math.round((refYesAsk!) * 100);
      const floorPct  = Math.round(consensusFloor * 100);
      const ceilPct   = 100 - floorPct;
      const msg = direction === "yes"
        ? `Market consensus gate: YES=${pricePct}¢ < floor ${floorPct}¢ — market says NO`
        : `Market consensus gate: YES=${pricePct}¢ > ceiling ${ceilPct}¢ — market says YES`;
      logger.info(
        { sym, direction, pricePct, floorPct, ceilPct },
        `[kalshi-bot] SKIP — ${msg}`,
      );
      if (lastDecisionWindowKey.get(sym) !== windowKey) {
        lastDecisionWindowKey.set(sym, windowKey);
        await persistBetRecord({
          symbol: sym, windowKey, ticker: kalshiTicker, direction,
          action: "skip",
          signals: { ...decision.signals, reason: "market-consensus-gate", pricePct, floorPct },
          entryPrice: yesPrice, kalshiTarget,
        });
      }
      return;
    }
  }

  // Confidence-based dynamic sizing: scale the target dollar bet between betSize
  // (min) and maxBetSize (max) according to the engine's confidence, further
  // shrunk by the per-position Kelly fraction (p−q)/odds so thin-edge prices
  // (e.g. YES at 0.52) receive smaller bets than high-value prices (YES at
  // 0.70) even at the same confidence score.  When enableDynamicSizing is
  // false this returns S.config.betSize unchanged (legacy).
  const targetBetSize = computeDynamicBetSize(decision.confidence, S.config, yesPrice, direction);
  const contractCount = Math.floor(targetBetSize / expectedFillCost);
  // If budget can't buy even one contract at the live ask, skip this entry and
  // engage the FOK-cooldown so this coin doesn't retry the same window.
  if (contractCount < 1) {
    logger.warn(
      {
        sym,
        targetBetSize: targetBetSize.toFixed(4),
        expectedFillCost: expectedFillCost.toFixed(4),
        direction,
        mode: S.botMode,
      },
      "[kalshi-bot] SKIP — budget cannot buy 1 contract at current ask; engaging fill cooldown",
    );
    windowFailedFills.add(`${sym}:${windowKey}:${S.botMode}`);
    return;
  }
  const betAmount = contractCount * expectedFillCost; // expected dollars risked
  if (S.config.enableDynamicSizing && targetBetSize !== S.config.betSize) {
    logger.info(
      {
        sym,
        confidence: decision.confidence,
        minBet: S.config.betSize,
        maxBet: S.config.maxBetSize,
        targetBetSize: targetBetSize.toFixed(4),
        contractCount,
      },
      "[kalshi-bot] dynamic sizing — bet scaled by confidence",
    );
  }

  // ── SAFETY GUARD: hard bet-size cap ─────────────────────────────────────────
  // If the computed betAmount would exceed the configured maxBetSize, abort the
  // trade entirely before touching Kalshi.  This protects against misconfigured
  // betSize values, unexpected rounding, or any future code change that could
  // inflate contractCount.  A tolerance of $0.01 covers floating-point dust.
  const maxBetCap = S.config.maxBetSize ?? 2;
  if (checkMaxBetSizeGuard(betAmount, maxBetCap)) {
    logger.error(
      {
        sym,
        betAmount: betAmount.toFixed(4),
        maxBetSize: maxBetCap,
        configuredBetSize: S.config.betSize,
        contractCount,
        costPerContract: expectedFillCost.toFixed(4),
        direction,
        mode: S.botMode,
      },
      "[kalshi-bot] SAFETY ABORT — computed betAmount exceeds maxBetSize cap; trade cancelled",
    );
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── LIVE-ONLY GUARDS: slippage strikes, account balance, total exposure ───
  if (S.botMode === "live") {
    // Slippage: skip entry on the window immediately following ≥3 unfair fills.
    // Strikes accumulated in window W → entry skipped in window W+1, then cleared.
    // (Strikes in the same window don't block entry — the bet already went through.)
    const slipInfo = coinSlippageStrikes.get(sym);
    if (checkSlippageStrikeGuard(slipInfo, windowKey)) {
      logger.warn(
        { sym, strikes: slipInfo!.strikes, strikeWindowKey: slipInfo!.windowKey, windowKey },
        "[kalshi-bot] SKIP — coin had ≥3 slippage strikes in the previous window; clearing counter",
      );
      coinSlippageStrikes.delete(sym); // one-window penalty only — clear so W+2 is unaffected
      return;
    }

    // Account balance guard: abort if Kalshi available balance is below the floor.
    const minBal = S.config.minAccountBalance ?? 5;
    try {
      const liveBal = await getCachedKalshiBalance();
      S.accountBalance = liveBal; // keep bot state fresh for the dashboard badge
      if (checkBalanceGuard(liveBal, minBal)) {
        logger.error(
          { sym, liveBal: liveBal.toFixed(2), minAccountBalance: minBal },
          "[kalshi-bot] SAFETY ABORT — Kalshi account balance below minimum; trade cancelled",
        );
        return;
      }
    } catch (err) {
      logger.error({ err, sym }, "[kalshi-bot] SAFETY ABORT — could not fetch Kalshi balance before trade; trade cancelled");
      return;
    }

    // Total open exposure cap: sum of all open positions + this bet must not exceed the cap.
    const maxExposure = S.config.maxTotalExposure ?? 5;
    const openExposure = Array.from(openPositions.values()).reduce((s, p) => s + p.betAmount, 0);
    if (checkExposureGuard(openExposure, betAmount, maxExposure)) {
      logger.error(
        { sym, openExposure: openExposure.toFixed(4), betAmount: betAmount.toFixed(4), maxTotalExposure: maxExposure },
        "[kalshi-bot] SAFETY ABORT — total open exposure would exceed cap; trade cancelled",
      );
      return;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── HARD LATE-ENTRY FLOOR (re-checked at order time) ─────────────────────
  // The minRemainingMinutes guard at the top of this tick uses a `secondsElapsed`
  // snapshot that was taken when the tick started.  Between that check and now,
  // tens of seconds of async work may have elapsed (signal reads, decision
  // engine, balance API, FOK retry latency).  A tick that starts with "3 min
  // remaining" can easily try to place an order with <1 min remaining.
  //
  // This re-check uses fresh Date.now() so it is ALWAYS accurate regardless of
  // tick latency.  3 minutes is the absolute minimum and cannot be configured
  // away — the configurable minRemainingMinutes guard above provides additional
  // tuning on top of this hard floor.
  const HARD_LATE_ENTRY_FLOOR_S = 3 * 60; // 3 minutes — non-negotiable
  const nowMs = Date.now();
  const windowStartMs = new Date(windowKey + ":00Z").getTime();
  const secondsElapsedNow = isNaN(windowStartMs) ? 0 : (nowMs - windowStartMs) / 1000;
  const secondsRemainingNow = 15 * 60 - secondsElapsedNow;
  if (secondsRemainingNow < HARD_LATE_ENTRY_FLOOR_S) {
    logger.warn(
      { sym, secondsRemainingNow: Math.round(secondsRemainingNow), windowKey, hardFloorS: HARD_LATE_ENTRY_FLOOR_S },
      "[kalshi-bot] HARD FLOOR — aborting bet, fewer than 3 minutes remain in window",
    );
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── PRE-BET DATA COMPLETENESS GATE ──────────────────────────────────────
  // Final hard check: ALL data required to place a bet must be confirmed
  // non-null before we ever touch the Kalshi API.  This is the last line of
  // defense — individual guards above catch most cases, but this unified
  // gate ensures nothing slips through via a missing null-check upstream.
  //
  // Required before any bet:
  //   1. A known price reference: yesPrice OR orderLimitPrice must be non-null.
  //      Without a price we cannot verify cost, sizing, or expected return.
  //   2. At least one model signal in the decision: signalsTotal ≥ 1.
  //      A signalsTotal of 0 means the engine fired on zero data — impossible
  //      to reach in normal operation but caught here as an ultimate guard.
  //   3. kalshiTarget must be non-null (should always be true at this point).
  {
    const noPrice = yesPrice == null && orderLimitPrice == null;
    const noSignals = (decision.signals?.signalsTotal ?? 0) < 1;
    const noTarget = kalshiTarget == null;

    if (noPrice || noSignals || noTarget) {
      logger.error(
        {
          sym, direction, windowKey,
          noPrice, noSignals, noTarget,
          yesPrice, orderLimitPrice, kalshiTarget,
          signalsTotal: decision.signals?.signalsTotal ?? 0,
        },
        "[kalshi-bot] SAFETY ABORT — pre-bet completeness gate failed; trade cancelled",
      );
      return;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  logger.info(
    {
      sym, direction, decision: decision.action, confidence: decision.confidence,
      secondsRemainingNow: Math.round(secondsRemainingNow),
      cachedAsk: direction === "yes" ? liveYesAsk : liveYesBid,
      orderPrice: orderLimitPrice,
    },
    "[kalshi-bot] placing bet",
  );

  let fillPrice = yesPrice; // paper fill
  let orderId: string | null = null;

  // Snapshot the mode ONCE before any await. If the user flips the mode while
  // the live order is filling, this entry must still be recorded and exited as
  // the mode it was actually placed in — otherwise a real live buy could be
  // recorded as paper and never sold, stranding funds on the exchange.
  const entryMode: BotMode = S.botMode;

  if (entryMode === "live") {
    try {
      const result = await placeOrderWithRetry(
        {
          ticker: kalshiTicker,
          side: direction,
          action: "buy",
          count: contractCount,
          type: "market",
          // Use the crossing-buffered price (ask + 3c, capped at return floor)
          // so minor ask drift between prefetch and order arrival still fills.
          // Falls back to midpoint mode when no live price is cached.
          ...(orderLimitPrice != null
            ? { limitPrice: orderLimitPrice }
            : {
                yesPrice: yesPrice ?? undefined,
                minReturnMultiple: S.config.minReturnMultiple,
              }),
        },
      );
      if (result.filledCount === 0) {
        // IOC returned 0 fills — the Kalshi book had no resting contracts at our
        // limit price right now. Allow up to 2 attempts (spaced by ~30s bot ticks)
        // before blocking the coin for the rest of the window. This gives the book
        // time to build liquidity (especially early in a window) without hammering
        // an empty book every tick.
        const failWk = currentWindowKey();
        const attemptKey = `${sym}:${failWk}:${S.botMode}`;
        const prev = windowZeroFillAttempts.get(attemptKey) ?? 0;
        const attempts = prev + 1;
        windowZeroFillAttempts.set(attemptKey, attempts);
        const MAX_ZERO_FILL_ATTEMPTS = 2;
        if (attempts >= MAX_ZERO_FILL_ATTEMPTS) {
          logger.warn(
            { sym, ticker: kalshiTicker, direction, attempts },
            "[kalshi-bot] IOC returned 0 fills after max attempts — blocking for rest of window",
          );
          windowFailedFills.add(attemptKey);
        } else {
          logger.warn(
            { sym, ticker: kalshiTicker, direction, attempts, maxAttempts: MAX_ZERO_FILL_ATTEMPTS },
            "[kalshi-bot] IOC returned 0 fills — book empty, will retry next tick",
          );
        }
        return;
      }
      fillPrice = result.avgPrice ?? yesPrice;
      orderId = result.orderId;

      // Slippage guard: compare actual fill price to the expected yes-price.
      // Tracks CONSECUTIVE bad fills — a clean fill resets the counter.
      // 3 consecutive bad fills → coin skips next window's entry, then counter clears.
      const maxSlipCents = S.config.maxSlippageCents ?? 10;
      // Slippage is measured in YES-side terms: result.avgPrice is always the
      // YES-side fill price returned by Kalshi (for both YES and NO orders).
      // Use liveLimitPrice (YES-side ask/bid) when available, else fall back to
      // yesPrice (midpoint) — never expectedFillCost which is in NO-cost basis
      // and would produce a unit mismatch (~20c false spike on NO fallback).
      const executionBaseline = liveLimitPrice ?? yesPrice;
      if (maxSlipCents > 0 && result.avgPrice != null && executionBaseline != null) {
        const slippageCents = Math.abs(result.avgPrice - executionBaseline) * 100;
        if (slippageCents > maxSlipCents) {
          logger.warn(
            {
              sym,
              executionBaseline: executionBaseline.toFixed(4),
              usedLivePrice: liveLimitPrice != null,
              fillPrice: result.avgPrice.toFixed(4),
              slippageCents: slippageCents.toFixed(1),
              maxSlippageCents: maxSlipCents,
            },
            "[kalshi-bot] SLIPPAGE WARNING — fill price deviated from expected price",
          );
          const existing = coinSlippageStrikes.get(sym);
          if (existing?.windowKey === windowKey) {
            coinSlippageStrikes.set(sym, { strikes: existing.strikes + 1, windowKey });
          } else {
            coinSlippageStrikes.set(sym, { strikes: 1, windowKey });
          }
          const strikes = coinSlippageStrikes.get(sym)!.strikes;
          if (strikes >= 3) {
            logger.warn({ sym, strikes }, "[kalshi-bot] slippage strikes reached 3 — coin will skip next window's first entry");
          }
        } else {
          // Clean fill — reset consecutive slippage strikes so the counter tracks
          // only runs of consecutive bad fills, not total bad fills in the window.
          const existing = coinSlippageStrikes.get(sym);
          if (existing?.windowKey === windowKey && existing.strikes > 0) {
            logger.info({ sym, prevStrikes: existing.strikes }, "[kalshi-bot] slippage strikes reset — clean fill received");
            coinSlippageStrikes.delete(sym);
          }
        }
      }
      // Invalidate the cached balance so the next entry guard fetches a fresh value.
      invalidateBalanceCache();
    } catch (err) {
      logger.error({ err, sym }, "[kalshi-bot] order placement failed");
      return;
    }
  }

  const id = `${sym}:${windowKey}:${Date.now()}`;
  // Capture the live coin price at the moment the bet is placed.
  const cryptoPriceAtEntry = getCachedPrediction(sym)?.price ?? null;

  // Compute actual cost using the real fill price (not the estimated fill used for sizing).
  // YES cost = fillPrice per contract; NO cost = (1 − fillPrice) per contract.
  const actualFillYesPrice = fillPrice ?? yesPrice ?? 0.5;
  const actualBetAmount = direction === "yes"
    ? contractCount * actualFillYesPrice
    : contractCount * (1 - actualFillYesPrice);

  const _entrySigs = decision.signals as {
    statAbove?: boolean | null;
    claudeAbove?: boolean | null;
    mlAbove?: boolean | null;
  };
  const newPosition: OpenPosition = {
    id,
    symbol: sym,
    windowKey,
    ticker: kalshiTicker,
    direction,
    entryYesPrice: actualFillYesPrice,
    contractCount,
    betAmount: actualBetAmount,
    kalshiTarget,
    openedAt: Date.now(),
    cryptoPriceAtEntry,
    exitState: makeInitialExitState(fillPrice ?? yesPrice ?? 0.5),
    entryDecision: decision,
    phase2Activated: false,
    entryMode,
    entrySignals: {
      statAbove: _entrySigs.statAbove ?? null,
      claudeAbove: _entrySigs.claudeAbove ?? null,
      mlAbove: _entrySigs.mlAbove ?? null,
    },
  };
  openPositions.set(sym, newPosition);

  // Enrich signals with effectiveConfidence (the composite score that gated this bet)
  // so analytics can build accurate confidence-band win-rate breakdowns without relying
  // on statConfidence/claudeConfidence alone, which are per-model not per-decision.
  // Task C (2026-07-03): also persist regime, trendStability, and windowDoubtPenalty
  // so post-analysis can evaluate the impact of each Phase-3 filter on outcomes.
  const enrichedSignals = {
    ...(decision.signals as unknown as Record<string, unknown>),
    effectiveConfidence: decision.confidence,
    regime: S.regimeCache.get(sym) ?? null,
    trendStability: windowStabilityCache.get(sym) ?? null,
    windowDoubtPenalty: S.currentWindowDoubtPenalty,
  };

  await persistBetRecord({
    symbol: sym,
    windowKey,
    ticker: kalshiTicker,
    direction,
    action: "bet",
    signals: enrichedSignals,
    entryPrice: newPosition.entryYesPrice,
    kalshiTarget,
    contractCount,
    betAmount: actualBetAmount,
    // Use insertId (not existingId) so persistBetRecord INSERTs this row.
    // The exit UPDATE will find it later via existingId: pos.id.
    insertId: id,
    cryptoPriceAtEntry,
    decisionMode: S.config.decisionMode ?? "classic",
    // Persist the snapshotted entry mode (not the live global) so a mid-fill
    // mode flip cannot mislabel this row on restart.
    mode: entryMode,
  });
  // Mark this window as having a recorded decision so SKIP dedup works correctly
  lastDecisionWindowKey.set(sym, windowKey);
  // Increment the per-window bet counter so subsequent ticks respect maxBetsPerWindow.
  windowBetCounts.set(windowBetKey, betsThisWindow + 1);
  // Increment the GLOBAL window total (all symbols combined) for the maxBetsPerWindow cap.
  // Mode-aware: paper and live each have their own counter.
  const totalKey = `${windowKey}:${S.botMode}`;
  windowTotalBets.set(totalKey, (windowTotalBets.get(totalKey) ?? 0) + 1);
  // Store bet details so the eval panel can display actual direction + confidence
  // even after the coin switches to "directional cap reached" on later ticks.
  windowBetDetails.set(windowBetKey, { direction, confidence: decision.confidence });

  logger.info({ sym, direction, fillPrice, contractCount, betsThisWindow: betsThisWindow + 1 }, "[kalshi-bot] bet placed");
}

