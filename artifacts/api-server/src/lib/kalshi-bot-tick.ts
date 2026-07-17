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
  deriveConvictionZone,
  type BotConfig, type BotDecision, type CircuitBreakerState, type PriceRegime,
  type DecisionMode, type CoinStreakEntry,
} from "./kalshi-bot-engine";
import {
  makeInitialExitState, runExitGuard, type ExitState, type GuardStates,
} from "./kalshi-bot-exit";
import {
  buyYes, buyNo, sellYes, sellNo, getBalance, isKalshiConfigured, placeOrderWithRetry,
  getCachedKalshiBalance, invalidateBalanceCache, computeMarketableLimitPrice,
  fetchKalshiMarketResult, fetchKalshiSettledMarkets, placeOrder,
} from "./kalshi-trader";
import {
  getKalshiWindowContext, getWindowBetSignal, getTimingAnalysis, intraWindowMetrics,
  getCachedPrediction, getKalshiCachedData, fetchKalshiTarget, fetchOrderbookPrices,
  fetchTrendStabilityForBot, getPredictionAnalytics, getConfirmedTargetMs,
  getLatestCoinSignals,
  CRYPTO_COINS, KALSHI_SERIES, currentWindowKey, type TrendStability,
} from "./crypto";
import { triggerWindowPipeline } from "./kalshi-bot-pipeline";
import { getConvictionLivePrice } from "./kalshi-conviction-poller";
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
  convictionFiredThisWindow, convictionEmergencyCloses, coinConvictionWinRates, coinStabilityCache, coinTrajectoryCache, maxBetWindowToken, maxBetCandidateForWindow,
  convictionAbortCooldown,
  type CoinStabilityResult, type TrajectoryGateResult,
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
  tickInFlight, getEffectiveDailyLossLimit,
  type BotMode, type BotStatus, type OpenPosition, type OpenPositionDisplay,
  type BotStateSnapshot, type WindowCoinEvaluation, type ParoleState,
} from "./kalshi-bot-state";
import { closePosition, persistBetRecord, BetRecordArgs } from "./kalshi-bot-close";
import { getTimingAccuracy } from "./kalshi-bot-db";
import { writeBotEntryTimingSnapshot } from "./kalshi-bot-entry-timing";

// Deduplication Set for bot entry timing snapshots (cleared implicitly as
// window keys rotate — each key encodes coin+windowKey+minuteMark+mode).
const entryTimingWritten = new Set<string>();

// ---------------------------------------------------------------------------
// Trajectory Gate
// Computes price velocity from recent 1-min candles and projects where the
// underlying price will be at window close.  If the projection is too close
// to — or crosses — the Kalshi target, the max bet is blocked.
// Pure function: no I/O, no side-effects.
// ---------------------------------------------------------------------------
function computeTrajectoryGate(
  sym: string,
  candles: Array<{ c: number; h: number; l: number; t: number }>,
  livePrice: number,
  kalshiTarget: number,
  direction: "yes" | "no",
  clockElapsedS: number,
  config: import("./kalshi-bot-engine").BotConfig,
  _betType: "max" | "regular" = "max",
): TrajectoryGateResult {
  const minutesRemaining = Math.max(0, (15 * 60 - clockElapsedS) / 60);
  const currentMarginPct = ((livePrice - kalshiTarget) / kalshiTarget) * 100;

  // Shared inactive/early return shape
  const inactive = (reason: TrajectoryGateResult["reason"]): TrajectoryGateResult => ({
    symbol: sym, blocked: false, reason,
    velocity: 0, projectedPrice: livePrice,
    currentMarginPct, projectedMarginPct: currentMarginPct,
    minutesRemaining, direction, computedAt: Date.now(),
    atrPct: 0, effectiveCurrentMarginMinPct: 0, effectiveDangerBandPct: 0,
    timeWeight: 1, adverseVelocity: false,
  });

  // ── Gate is only meaningful in the final N minutes ────────────────────────
  // Early in the window a linear velocity projection is too noisy to act on.
  // The gate stands silent until the window is nearly over, then checks whether
  // the current freefall momentum is carrying the price through the strike.
  const finalMinutes = config.maxBetTrajectoryFinalMinutes ?? 5;
  if (minutesRemaining > finalMinutes) return inactive("gate_inactive");
  if (candles.length < 2)             return inactive("insufficient_data");

  // ── ATR: coin-relative volatility unit for the velocity significance check ─
  const atrLookback = Math.min(5, candles.length - 1);
  let trSum = 0;
  for (let i = candles.length - atrLookback; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, prevC = candles[i - 1].c;
    trSum += Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
  }
  const atr    = trSum / atrLookback;
  const atrPct = (atr / kalshiTarget) * 100;

  // ── Velocity: slope over the last N 1-min candles ────────────────────────
  const lookbackMin    = Math.max(1, config.maxBetTrajectoryLookbackMinutes ?? 3);
  const actualLookback = Math.min(lookbackMin, candles.length - 1);
  const priceNAgo      = candles[candles.length - 1 - actualLookback].c;
  const velocity       = (livePrice - priceNAgo) / actualLookback; // $/min

  const projectedPrice     = livePrice + velocity * minutesRemaining;
  const projectedMarginPct = ((projectedPrice - kalshiTarget) / kalshiTarget) * 100;

  // Signed so that positive = good direction for this bet:
  //   YES wins above target → rising is good; NO wins below → falling is good
  const signedVelocity        = direction === "yes" ? velocity            : -velocity;
  const signedProjectedMargin = direction === "yes" ? projectedMarginPct : -projectedMarginPct;

  // adverseVelocity: price is moving TOWARD (or through) the strike
  const adverseVelocity = signedVelocity <= 0;

  // ── Single gate: freefall projected to cross the target ───────────────────
  // Block only when:
  //   1. velocity is adverse (heading toward the strike), AND
  //   2. at the current rate, price is projected to close on the WRONG side.
  // Optionally: velocity must be significant (≥ minVelocityATR × ATR/min) to
  // avoid triggering on negligible drift rather than a real freefall.
  const blockOnCross  = config.maxBetTrajectoryBlockOnCross !== false;
  const minVelATR     = config.maxBetTrajectoryMinVelocityATR ?? 0;
  const velInATR      = atr > 0 ? Math.abs(velocity) / atr : 0;
  const velSignificant = minVelATR === 0 || velInATR >= minVelATR;

  const willCross = blockOnCross && adverseVelocity && velSignificant && signedProjectedMargin < 0;

  return {
    symbol: sym, blocked: willCross, reason: willCross ? "projected_cross" : null,
    velocity, projectedPrice,
    currentMarginPct, projectedMarginPct,
    minutesRemaining, direction, computedAt: Date.now(),
    atrPct, effectiveCurrentMarginMinPct: 0, effectiveDangerBandPct: 0,
    timeWeight: 1, adverseVelocity,
  };
}

// ---------------------------------------------------------------------------
// refreshTrajectoryForAllCoins
// Runs every main-loop tick (before per-coin bot logic) so the UI and gate
// always have fresh trajectory data from the very first tick of the window.
// No I/O — reads only in-memory caches.
// ---------------------------------------------------------------------------
export function refreshTrajectoryForAllCoins(): void {
  const wk = currentWindowKey();
  const wkMs = wk ? new Date(wk + ":00Z").getTime() : NaN;
  const clockS = isNaN(wkMs) ? 0 : (Date.now() - wkMs) / 1000;
  const lockP = S.config.kalshiLockPrice ?? 0.88;

  for (const coin of CRYPTO_COINS) {
    const sym = coin.symbol;
    if (!KALSHI_SERIES[sym]) continue;

    const pred    = getCachedPrediction(sym);
    const candles = pred?.candles ?? [];
    if (candles.length < 2) continue;

    const livePrice = candles[candles.length - 1].c; // live-patched last candle close

    const kd       = getKalshiCachedData(sym);
    const target   = kd?.value ?? null;
    if (target == null) continue;

    const yesAsk   = kd?.yesAsk ?? null;
    const yesBid   = kd?.yesBid ?? null;
    const yesPrice = yesAsk != null ? yesAsk : yesBid != null ? 1 - yesBid : null;
    const direction: "yes" | "no" = yesPrice != null && yesPrice >= lockP ? "yes"
                                  : yesPrice != null && yesPrice <= (1 - lockP) ? "no"
                                  : yesPrice != null && yesPrice > 0.5 ? "yes" : "no";

    coinTrajectoryCache.set(sym, computeTrajectoryGate(sym, candles, livePrice, target, direction, clockS, S.config));
  }
}

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

  // Daily loss limit check (uses conviction-specific limit when in conviction mode)
  if (S.dailyPnl <= -getEffectiveDailyLossLimit()) {
    const limitPos = openPositions.get(sym);
    if (limitPos) {
      logger.warn({ sym, dailyPnl: S.dailyPnl, limit: getEffectiveDailyLossLimit() }, "[kalshi-bot] daily limit hit — closing position");
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
  // Live global cap re-check: Phase 3 snapshots globalBetsThisWindow once before
  // iterating coins, so when bet candidates run sequentially the first coin's bet
  // must be visible to the next. Reading windowTotalBets here (before any await)
  // gives the authoritative live count.
  // CONVICTION MODE: global cap bypassed — each coin bets independently on price cross;
  // max-bet slots are governed by convictionStabilityMaxBetsPerWindow.
  const globalTotalNow = windowTotalBets.get(`${windowKey}:${S.botMode}`) ?? 0;
  if (S.config.decisionMode !== "conviction" && S.config.maxBetsPerWindow > 0 && globalTotalNow >= S.config.maxBetsPerWindow) {
    logger.debug({ sym, globalTotalNow, max: S.config.maxBetsPerWindow }, "[kalshi-bot] global cap reached at entry — skipping");
    return;
  }

  // Ceiling: skip if bot has been in the window longer than maxEntryMinutes.
  // 0 = disabled (no ceiling — enter at any point).
  if (S.config.maxEntryMinutes > 0 && secondsElapsed > S.config.maxEntryMinutes * 60) return;
  // Early-window lockout: hard block on new bets for the first N minutes of the window.
  // Only bypassed at true market extremes (≥92¢ or ≤8¢) regardless of mode.
  // Conviction mode respects minWindowEntryMinutes just like any other mode —
  // the separate maxBetMinWindowEntryMinutes gate controls when max bets are eligible.
  {
    const minWindowEntryMinutes = S.config.minWindowEntryMinutes ?? 0;
    if (minWindowEntryMinutes > 0 && secondsElapsed < minWindowEntryMinutes * 60) {
      // Bypass: configurable — disabled means the timer is ALWAYS respected.
      // When enabled, the threshold is user-adjustable (default 0.92).
      const bypassEnabled = S.config.convictionEarlyBypassEnabled !== false;
      const bypassThreshold = S.config.convictionEarlyBypassThreshold ?? 0.92;
      // For NO bets the actual fill cost is 1 − yesBid (the NO ask), NOT yesAsk.
      // At a 2¢ spread: YES ask=6¢, YES bid=4¢ → yesPrice=6¢, but NO ask=96¢.
      // Checking only yesPrice ≤ (1−threshold) uses the wrong side of the spread
      // and silently fails even when NO is clearly past the bypass threshold.
      // Read yesBid from the in-memory cache (no I/O) and check the actual NO ask.
      const _bypassKd    = getKalshiCachedData(sym);
      const _noActualAsk = _bypassKd?.yesBid != null ? 1 - _bypassKd.yesBid : null;
      const isExtreme = bypassEnabled && (
        (yesPrice !== null && (yesPrice >= bypassThreshold || yesPrice <= +(1 - bypassThreshold).toFixed(4))) ||
        (_noActualAsk !== null && _noActualAsk >= bypassThreshold)
      );
      if (!isExtreme) {
        logger.debug(
          { sym, windowKey, secondsElapsed, minWindowEntryMinutes, yesPrice, noActualAsk: _noActualAsk, bypassEnabled, bypassThreshold },
          "[kalshi-bot] early-window lockout — timer active",
        );
        return;
      }
      logger.debug(
        { sym, windowKey, secondsElapsed, minWindowEntryMinutes, yesPrice, noActualAsk: _noActualAsk, bypassThreshold },
        "[kalshi-bot] early-window lockout bypassed — extreme price crossed threshold",
      );
    }
  }
  // Floor: early-exit the tick if fewer than minRemainingMinutes remain.
  // Bypassed entirely when allowLateEntries=true (conviction mode design: the
  // price crossing happens near settlement; blocking it defeats the purpose).
  // The hard pre-order floor below is also bypassed when allowLateEntries=true.
  if (!S.config.allowLateEntries) {
    const minRemaining = S.config.minRemainingMinutes ?? 0;
    if (minRemaining > 0 && 15 * 60 - secondsElapsed < minRemaining * 60) {
      logger.debug({ sym, secondsElapsed, minRemaining }, "[kalshi-bot] min-remaining floor — skipping tick early");
      return;
    }
  }
  if (!kalshiTicker || kalshiTarget === null) {
    logger.info(
      { sym, windowKey, hasKalshiTicker: !!kalshiTicker, kalshiTarget },
      "[kalshi-bot] tick: no ticker/target — skipping (market unpublished or cache race)",
    );
    return;
  }

  // ── Entry proximity guard ──────────────────────────────────────────────────
  // Skip new entries when the live price is too close to the Kalshi strike.
  // Coin-flip territory → the bot has no real edge regardless of model signals.
  // Gated by S.config.proximityGuardEnabled so it is inert unless turned on.
  //
  // CONVICTION MODE + EXTREME PRICE bypass: when the Kalshi YES price is already
  // at or beyond the extreme threshold (≥ 0.92 or ≤ 0.08) in conviction mode,
  // the market itself is the signal — the spot price being close to the strike
  // is exactly *why* the market is pricing at 92 ¢ or 8 ¢.  Blocking these bets
  // defeats the purpose of conviction mode.  This mirrors the same bypass used
  // for the minWindowEntryMinutes guard above.
  if (S.config.proximityGuardEnabled) {
    // Derive the same zone floor used by the engine so the bypass is in sync.
    const convTarget = S.config.kalshiLockPrice ?? 0.90;
    const convZoneFloor = deriveConvictionZone(convTarget).lockPrice;
    const proximityIsConvictionExtreme =
      S.config.decisionMode === "conviction" &&
      yesPrice !== null &&
      (yesPrice >= convZoneFloor || yesPrice <= 1 - convZoneFloor);

    if (proximityIsConvictionExtreme) {
      logger.debug(
        { sym, yesPrice },
        "[kalshi-bot] proximity guard bypassed — conviction mode at extreme price",
      );
    } else {
      const proximityLivePrice = getCachedPrediction(sym)?.price ?? null;
      if (proximityLivePrice != null && kalshiTarget > 0) {
        const distancePct = Math.abs(proximityLivePrice - kalshiTarget) / kalshiTarget * 100;
        const minutesRemaining = (15 * 60 - secondsElapsed) / 60;
        const lateWindowMins = S.config.proximityLateWindowMinutes ?? 7;
        const isLate = minutesRemaining <= lateWindowMins;
        const globalThreshold = isLate
          ? (S.config.proximityLatePct ?? 0)
          : (S.config.proximityEarlyPct ?? 0);
        const overrideMap = isLate
          ? (S.config.proximityLatePctOverrides ?? {})
          : (S.config.proximityEarlyPctOverrides ?? {});
        const threshold = overrideMap[sym] ?? globalThreshold;
        if (threshold > 0 && distancePct < threshold) {
          const phase = isLate ? "late" : "early";
          logger.info(
            { sym, distancePct: +distancePct.toFixed(3), threshold, phase, minutesRemaining: +minutesRemaining.toFixed(1) },
            `[kalshi-bot] proximity guard [${sym}]: ${distancePct.toFixed(2)}% from strike — need ${threshold.toFixed(2)}% (${phase}, ${minutesRemaining.toFixed(1)} min remaining)`,
          );
          return;
        }
      }
    }
  }

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

  // ── All-signals gate (HARD RULE — non-conviction modes only) ─────────────
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
  //
  // CONVICTION MODE — price alone is the signal.  All model gates are bypassed
  // entirely.  The engine fires purely on yesPrice vs lockPrice.
  if (S.config.decisionMode !== "conviction") {
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
  if (S.config.decisionMode !== "conviction") {
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
  // Bypassed in conviction mode — price alone is the signal; candle direction
  // is already encoded in the Kalshi market price crossing the lock threshold.
  if (S.config.decisionMode !== "conviction") {
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
  }

  {
    const pred = getCachedPrediction(sym);
    // ── Strike proximity guard ─────────────────────────────────────────────
    // Skip when the live price is within 0.03% of the Kalshi target.
    // At that proximity a single tick crosses the strike and flips the
    // outcome — the bet is effectively a coin flip regardless of signals.
    // Only applied on the "at risk" side for each direction:
    //   NO  bet + price barely below target → one tick up = loss
    //   YES bet + price barely above target → one tick down = loss
    // Bypassed in conviction mode — at 88-92¢/8-12¢, being close to strike
    // is the whole point; blocking these bets defeats the mode entirely.
    const livePrice = pred?.price;
    if (!S.config.freeRunMode && S.config.decisionMode !== "conviction" && livePrice != null && livePrice > 0 && kalshiTarget > 0) {
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
    // Bypassed in conviction mode — oscillation near the strike is normal
    // when the market is pricing at extreme probabilities.
    if (!S.config.freeRunMode && S.config.decisionMode !== "conviction" && kalshiTarget > 0 && pred != null && pred.candles.length >= 6) {
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
  // Declared `let` so the conviction live-price gate (below) can re-derive these
  // values from fresh orderbook prices if the pre-gate cache is stale.
  let expectedFillCost: number =
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
  //
  // CONVICTION MODE: the return floor cap is removed entirely. At 88-92¢ YES /
  // 8-12¢ NO the cap (≈0.689) would force the order far from the market and
  // guarantee zero fills. We still apply a hard 0.01/0.99 sanity bound.
  const _entryReturnFloor = S.config.minReturnMultiple ?? 1.45;
  const _entryMaxCost = 1 / _entryReturnFloor;
  const isConviction = S.config.decisionMode === "conviction";
  // Declared `let` — the conviction live-price gate (below) refreshes the
  // underlying ask/bid and may recompute this value with fresh prices.
  let orderLimitPrice: number | null = (() => {
    const CROSSING_BUFFER = 0.03;
    if (direction === "yes") {
      if (liveYesAsk == null) return null;
      const raw = liveYesAsk + CROSSING_BUFFER;
      const cap = isConviction ? 0.99 : _entryMaxCost;
      return Math.floor(Math.min(raw, cap) * 100) / 100;
    } else {
      if (liveYesBid == null) return null;
      const raw = liveYesBid - CROSSING_BUFFER;
      const floor = isConviction ? 0.01 : (1 - _entryMaxCost);
      return Math.ceil(Math.max(raw, floor) * 100) / 100;
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
  // Bypassed in conviction mode — by design the return at 88-92¢ is ~1.09-1.14×;
  // the high probability is the edge, not the payout multiple.
  if (S.config.decisionMode !== "conviction") {
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
  // Per-coin maxBetSize override: further caps the bet for this specific coin.
  const perCoinMaxBet = S.config.coinOverrides?.[sym]?.maxBetSize;

  // Trajectory gate: update cache every tick so the UI always shows fresh data,
  // even when no bet is being placed.  Direction is estimated from yesPrice vs
  // lockPrice; the IIFE below re-runs with the precise direction before blocking.
  if (kalshiTarget != null && candles.length >= 2) {
    const trajLivePrice = candles[candles.length - 1].c; // live-patched last candle close
    const _wkMsTraj = new Date(windowKey).getTime();
    const _clockSTraj = isNaN(_wkMsTraj) ? 0 : (Date.now() - _wkMsTraj) / 1000;
    const lockP = S.config.kalshiLockPrice ?? 0.88;
    const guessDir: "yes" | "no" = yesPrice != null && yesPrice >= lockP ? "yes"
                                 : yesPrice != null && yesPrice <= (1 - lockP) ? "no"
                                 : yesPrice != null && yesPrice > 0.5 ? "yes" : "no";
    coinTrajectoryCache.set(sym, computeTrajectoryGate(sym, candles, trajLivePrice, kalshiTarget, guessDir, _clockSTraj, S.config));
  }

  // Conviction stability gate: classify the coin as stable or volatile using the
  // stat model indicators + ML confidence.  Stable → max bet size; volatile → normal size.
  // When convictionStabilityEnabled is false, falls back to the legacy random roll.
  const boostBetSize = (() => {
    if (S.config.decisionMode !== "conviction") return null;
    const targetBoost = (S.config.convictionBoostBetSize ?? 0) > 0
      ? S.config.convictionBoostBetSize!
      : (S.config.maxBetSize ?? 0);
    if (targetBoost <= 0) return null;
    // clockElapsedS: defined here at IIFE top so both stable and legacy paths
    // can use it.  The outer-scope definition lives inside a block `{ }` and
    // is not accessible in this IIFE.
    const _wkMs = new Date(windowKey).getTime();
    const clockElapsedS = isNaN(_wkMs) ? 0 : (Date.now() - _wkMs) / 1000;

    if (S.config.convictionStabilityEnabled !== false) {
      // ── Deterministic stability gate ──────────────────────────────────────
      const ind = getCachedPrediction(sym)?.indicators;
      if (!ind) {
        logger.info({ sym }, "[kalshi-bot] conviction stability — no indicators, treating as volatile");
        coinStabilityCache.set(sym, { stable: false, er: 0, osc: 0, volPct: 0, mlConf: null, windowKey, computedAt: Date.now() } satisfies CoinStabilityResult);
        return null;
      }
      const mlSig  = getLatestCoinSignals(sym);
      const mlConf = mlSig?.mlConfidence ?? null;
      const minER     = S.config.convictionStabilityMinER     ?? 0.30;
      const maxOsc    = S.config.convictionStabilityMaxOsc    ?? 8;
      const maxVolPct = S.config.convictionStabilityMaxVolPct ?? 3.0;
      const minMLConf = S.config.convictionStabilityMinMLConf ?? 52;
      const erOk  = ind.efficiencyRatio  >= minER;
      const oscOk = ind.oscillationCount <= maxOsc;
      const volOk = ind.volatilityPct    <= maxVolPct;
      const mlOk  = mlConf === null || mlConf >= minMLConf;
      // spikeFlag intentionally excluded here: conviction mode fires BECAUSE
      // price just hit 90¢ — that sharp move often sets spikeFlag, but the
      // 90¢ lock threshold is already the certainty filter.  Blocking max bets
      // on spikes in conviction mode is self-defeating.
      const stable = erOk && oscOk && volOk && mlOk;
      coinStabilityCache.set(sym, {
        stable,
        er: ind.efficiencyRatio,
        osc: ind.oscillationCount,
        volPct: ind.volatilityPct,
        mlConf,
        windowKey,
        computedAt: Date.now(),
      } satisfies CoinStabilityResult);
      if (!stable) {
        logger.info(
          { sym, er: ind.efficiencyRatio.toFixed(3), osc: ind.oscillationCount, volPct: ind.volatilityPct.toFixed(2), mlConf, spike: ind.spikeFlag, erOk, oscOk, volOk, mlOk },
          "[kalshi-bot] conviction stability — VOLATILE: regular bet size",
        );
        return null;
      }
      // Win-rate secondary gate: even stable coins need minimum historical win rate
      const minWr2 = S.config.convictionBoostMinWinRate ?? 0.70;
      const wr2    = coinConvictionWinRates.get(sym) ?? null;
      if (wr2 !== null && wr2 < minWr2) {
        logger.info(
          { sym, wr: wr2.toFixed(2), minWr: minWr2, er: ind.efficiencyRatio.toFixed(3), osc: ind.oscillationCount },
          "[kalshi-bot] conviction stability — STABLE but win-rate below threshold, regular bet size",
        );
        return null;
      }
      // Max-bet timing gate: independent of minWindowEntryMinutes; blocks max-size
      // bets until the configured number of minutes has elapsed.  Falling back to
      // regular size does NOT consume the token — it stays available for later.
      // (clockElapsedS is defined at the top of this IIFE, shared by all paths.)
      const maxBetEntryGateS = (S.config.maxBetMinWindowEntryMinutes ?? 0) * 60;
      if (maxBetEntryGateS > 0 && clockElapsedS < maxBetEntryGateS) {
        logger.info(
          { sym, elapsed: Math.round(clockElapsedS), gateS: maxBetEntryGateS },
          "[kalshi-bot] conviction stability — STABLE but max-bet timing gate not elapsed, regular bet size",
        );
        return null;
      }
      // Trajectory gate: block max bets when the underlying price is trending
      // dangerously close to (or crossing) the Kalshi target.
      // Use candles[last].c as the live price — it is patched with the live ticker
      // by the tracker snap loop and is always fresher than predCache.price.
      if (S.config.maxBetTrajectoryEnabled !== false && kalshiTarget != null && candles.length >= 2) {
        const trajLiveP = candles[candles.length - 1].c;
        const traj = computeTrajectoryGate(sym, candles, trajLiveP, kalshiTarget, direction, clockElapsedS, S.config);
        coinTrajectoryCache.set(sym, traj); // overwrite with precise direction
        if (traj.blocked) {
          logger.info(
            { sym, reason: traj.reason, velocity: traj.velocity.toFixed(2), currentMarginPct: traj.currentMarginPct.toFixed(3), projectedMarginPct: traj.projectedMarginPct.toFixed(3), minutesRemaining: traj.minutesRemaining.toFixed(1), direction },
            "[kalshi-bot] trajectory gate — BLOCKED: max bet skipped (price momentum too close to target)",
          );
          return null;
        }
        logger.info(
          { sym, velocity: traj.velocity.toFixed(2), currentMarginPct: traj.currentMarginPct.toFixed(3), projectedMarginPct: traj.projectedMarginPct.toFixed(3), minutesRemaining: traj.minutesRemaining.toFixed(1) },
          "[kalshi-bot] trajectory gate — SAFE: projected margin ok",
        );
      }

      // Pre-selection guard: only the best-scoring stable coin (ranked by ER,
      // osc, ML) can claim the max-bet token.  The loop pre-computes the winner
      // before dispatching parallel ticks so the result is deterministic.
      const preSelected = maxBetCandidateForWindow.get(windowKey);
      if (preSelected !== undefined && preSelected !== sym) {
        logger.info(
          { sym, preSelected, er: ind.efficiencyRatio.toFixed(3) },
          "[kalshi-bot] conviction stability — STABLE but not pre-selected for max bet, regular bet size",
        );
        return null;
      }
      // Global per-window token check: the probability was already rolled ONCE at
      // window transition.  If no token is available, all remaining coins use regular
      // size regardless of how stable they are.
      if (maxBetWindowToken.remaining <= 0) {
        logger.info(
          { sym, er: ind.efficiencyRatio.toFixed(3), osc: ind.oscillationCount },
          "[kalshi-bot] conviction stability — STABLE but no max-bet token this window, regular bet",
        );
        return null;
      }
      maxBetWindowToken.remaining--;
      logger.info(
        { sym, er: ind.efficiencyRatio.toFixed(3), osc: ind.oscillationCount, volPct: ind.volatilityPct.toFixed(2), mlConf, targetBoost },
        "[kalshi-bot] conviction stability — STABLE + max-bet token claimed: max bet size",
      );
      return targetBoost;
    }

    // ── Legacy path (convictionStabilityEnabled=false): same global token logic ──
    const minWr = S.config.convictionBoostMinWinRate ?? 0.70;
    const wr    = coinConvictionWinRates.get(sym) ?? null;
    if (wr !== null && wr < minWr) {
      logger.info({ sym, wr, minWr }, "[kalshi-bot] conviction boost — win-rate gate failed");
      return null;
    }
    const legacyMaxBetEntryGateS = (S.config.maxBetMinWindowEntryMinutes ?? 0) * 60;
    if (legacyMaxBetEntryGateS > 0 && clockElapsedS < legacyMaxBetEntryGateS) {
      logger.info(
        { sym, elapsed: Math.round(clockElapsedS), gateS: legacyMaxBetEntryGateS },
        "[kalshi-bot] conviction stability — STABLE but max-bet timing gate not elapsed, regular bet size",
      );
      return null;
    }
    if (maxBetWindowToken.remaining <= 0) {
      logger.info({ sym }, "[kalshi-bot] conviction boost — no max-bet token this window, regular bet");
      return null;
    }
    maxBetWindowToken.remaining--;
    logger.info({ sym, targetBoost, wr }, "[kalshi-bot] conviction boost — max-bet token claimed: max bet size");
    return targetBoost;
  })();
  // Stat regime boost: use maxBetSize when the coin's current price action is
  // stable (high efficiency ratio, low oscillations, no spike candle).
  // Works in any mode. Does not stack with conviction random boost.
  const regimeQualified = (() => {
    if (!(S.config.statRegimeBoostEnabled ?? false)) return false;
    if (boostBetSize != null) return false; // conviction boost already elevated, no need to stack
    const ind = getCachedPrediction(sym)?.indicators;
    if (!ind) return false;
    const minER  = S.config.statRegimeBoostMinER ?? 0.40;
    const maxOsc = S.config.statRegimeBoostMaxOscillations ?? 6;
    return ind.efficiencyRatio >= minER && ind.oscillationCount <= maxOsc && !ind.spikeFlag;
  })();
  const effectiveMaxBet = (() => {
    const baseMax = boostBetSize ?? (S.config.maxBetSize ?? 2);
    return perCoinMaxBet != null && perCoinMaxBet < baseMax ? perCoinMaxBet : baseMax;
  })();
  // Priority: conviction boost → regime boost → confidence-scaled dynamic sizing.
  const targetBetSize = boostBetSize != null
    ? Math.min(boostBetSize, effectiveMaxBet)
    : regimeQualified
      ? Math.min(S.config.maxBetSize ?? 2, effectiveMaxBet)
      : Math.min(
          computeDynamicBetSize(decision.confidence, S.config, yesPrice, direction),
          effectiveMaxBet,
        );
  if (boostBetSize != null) {
    logger.info(
      { sym, boostBetSize, baseBetSize: S.config.betSize, targetBetSize: targetBetSize.toFixed(4) },
      "[kalshi-bot] conviction stability gate — STABLE: using max bet size",
    );
  } else if (regimeQualified) {
    const ind = getCachedPrediction(sym)?.indicators;
    logger.info(
      {
        sym,
        er: ind?.efficiencyRatio, oscillations: ind?.oscillationCount, spike: ind?.spikeFlag,
        maxBetSize: S.config.maxBetSize, targetBetSize: targetBetSize.toFixed(4),
      },
      "[kalshi-bot] stat regime boost — stable price action → max bet size this entry",
    );
  } else if (perCoinMaxBet != null && perCoinMaxBet < (S.config.maxBetSize ?? 2)) {
    logger.info(
      { sym, perCoinMaxBet, globalMaxBetSize: S.config.maxBetSize, targetBetSize: targetBetSize.toFixed(4) },
      "[kalshi-bot] per-coin maxBetSize override applied",
    );
  }
  let contractCount = Math.floor(targetBetSize / expectedFillCost);
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
  // Conviction daily spend gate: block entry if today's total spend would exceed the configured cap.
  if ((S.config.convictionMaxDailySpend ?? 0) > 0) {
    const spendCap = S.config.convictionMaxDailySpend!;
    if (S.dailySpendAmount + betAmount > spendCap) {
      logger.info(
        { sym, dailySpendAmount: S.dailySpendAmount.toFixed(2), betAmount: betAmount.toFixed(2), spendCap },
        "[kalshi-bot] SKIP — daily spend cap reached",
      );
      return;
    }
  }
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
  const maxBetCap = effectiveMaxBet;
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
  // tick latency.  When allowLateEntries=true the floor is fully removed —
  // the bot is designed to catch the price crossing near settlement and any
  // time floor defeats that purpose.  For all other modes the floor stays at
  // 3 minutes (non-negotiable safety margin against fill latency eating into
  // settlement time).
  const nowMs = Date.now();
  const windowStartMs = new Date(windowKey + ":00Z").getTime();
  const secondsElapsedNow = isNaN(windowStartMs) ? 0 : (nowMs - windowStartMs) / 1000;
  const secondsRemainingNow = 15 * 60 - secondsElapsedNow;
  if (!S.config.allowLateEntries) {
    const hardFloorS = (S.config.minRemainingMinutes ?? 0) * 60;
    if (hardFloorS > 0 && secondsRemainingNow < hardFloorS) {
      logger.warn(
        { sym, secondsRemainingNow: Math.round(secondsRemainingNow), windowKey, hardFloorS },
        "[kalshi-bot] HARD FLOOR — aborting bet, insufficient time remaining in window",
      );
      return;
    }
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
  //      Exception: conviction mode uses price position only — signalsTotal is
  //      intentionally 0 and the price check (noPrice) is the sole guard.
  //   3. kalshiTarget must be non-null (should always be true at this point).
  {
    const noPrice = yesPrice == null && orderLimitPrice == null;
    const noSignals = S.config.decisionMode !== "conviction" && (decision.signals?.signalsTotal ?? 0) < 1;
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

  // ── CONVICTION MIN ENTRY WAIT ──────────────────────────────────────────────
  // Hard floor: block entry until N minutes have elapsed in this window.
  // The bot polls continuously — the instant the floor clears and price is in
  // zone ([lockPrice-2¢, lockPrice+2¢]), the next tick fires the bet.
  //
  // ONE exception: if convictionEarlyBypassEnabled=true and the live price
  // crosses the extreme bypass threshold (default 0.92, currently set to 0.95
  // in config), entry is allowed immediately — that's an outsized move that
  // justifies jumping the queue.  Any price within the normal zone waits.
  if (S.config.decisionMode === "conviction") {
    const _convMinEntry = S.config.convictionMinEntryMinutes ?? 0;
    if (_convMinEntry > 0 && secondsElapsedNow < _convMinEntry * 60) {
      const _bypassEnabled = S.config.convictionEarlyBypassEnabled !== false;
      const _bypassThreshold = S.config.convictionEarlyBypassThreshold ?? 0.92;
      // Same spread-side fix as the minWindowEntryMinutes bypass above:
      // use the actual NO ask (1 − yesBid) not yesAsk for the NO direction check.
      const _bypassKd2    = getKalshiCachedData(sym);
      const _noActualAsk2 = _bypassKd2?.yesBid != null ? 1 - _bypassKd2.yesBid : null;
      const _isExtreme = _bypassEnabled && (
        (yesPrice !== null && (yesPrice >= _bypassThreshold || yesPrice <= +(1 - _bypassThreshold).toFixed(4))) ||
        (_noActualAsk2 !== null && _noActualAsk2 >= _bypassThreshold)
      );
      if (_isExtreme) {
        logger.debug(
          { sym, windowKey, elapsedMin: +(secondsElapsedNow / 60).toFixed(1), yesPrice, noActualAsk: _noActualAsk2, _bypassThreshold },
          "[kalshi-bot] conviction: min entry wait bypassed — extreme price crossed threshold",
        );
      } else {
        logger.info(
          { sym, windowKey, elapsedMin: +(secondsElapsedNow / 60).toFixed(1), convictionMinEntryMinutes: _convMinEntry },
          "[kalshi-bot] conviction: min entry time not yet reached — skipping",
        );
        return;
      }
    }
  }

  // Conviction once-per-window lock: mark synchronously before any await so that
  // a concurrent tick (e.g. the 5s scheduler vs the pipeline-completion trigger)
  // cannot also read the guard as "not fired" and place a duplicate bet.
  // The Phase-3 scheduler in kalshi-bot-loop.ts checks this same Set and skips
  // conviction coins that are already marked.  Cleared on window transition.
  if (S.config.decisionMode === "conviction") {
    convictionFiredThisWindow.add(`${sym}:${windowKey}`);
  }

  // ─── CONVICTION LIVE-PRICE GATE ──────────────────────────────────────────
  // Force a fresh Kalshi API call (bypassing the 5 s cache) immediately before
  // placing the order.  If the real orderbook has moved outside the
  // [lockPrice, lockPriceCap] window since the signal fired, abort the order
  // and release the once-per-window lock so the next tick can retry if the
  // price re-enters.
  //
  // This prevents the "stale cache" fill: cached 92 ¢ → limit 95 ¢ →
  // real book at 74 ¢ → filled at 74 ¢ (outside the entry window).
  //
  // Hoisted outside the gate block so the recompute step below can use them
  // to update expectedFillCost / contractCount / orderLimitPrice with
  // fresh values (avoids stale-cache sizing blowup: yesBid 0.93 → 57 contracts).
  let freshYesAsk: number | null = null;
  let freshYesBid: number | null = null;
  if (S.config.decisionMode === "conviction") {
    // Derive the asymmetric −2¢/+3¢ zone from the single slider value
    // (kalshiLockPrice) via deriveConvictionZone — single source of truth,
    // shared with the engine, the conviction poller, and the post-fill check.
    // Target 92¢ → zone [90¢, 95¢]. Below the floor: price can flip, too
    // risky. Above the cap: margin too small, not worth the entry.
    const gateTarget   = S.config.kalshiLockPrice ?? 0.90;
    const { lockPrice, lockPriceCap } = deriveConvictionZone(gateTarget);
    // Compute the current window's ticker deterministically from windowKey rather
    // than reading it from kalshiTargetCache.  The cache can switch to the NEXT
    // window's market ~10 min into the current window once Kalshi pre-publishes
    // upcoming markets, causing the orderbook fetch to target the wrong ticker.
    //
    // Kalshi 15-min ticker format (observed): KX${SYM}15M-${YY}${MON}${DD}${HHMM}-${MM}
    //   • YY MON DD — date in EDT (UTC-4)
    //   • HHMM      — window start time in EDT
    //   • MM         — start-minute of the window (0, 15, 30, or 45)
    // Example: windowKey "2026-07-17T00:15" → EDT 20:15 July 16 → "KXBTC15M-26JUL162015-15"
    const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const windowOpenUtc  = new Date(windowKey + ":00Z");
    const windowOpenEdt  = new Date(windowOpenUtc.getTime() - 4 * 60 * 60 * 1000); // EDT = UTC-4
    const tyy  = String(windowOpenEdt.getUTCFullYear()).slice(-2);
    const tmon = MONTHS[windowOpenEdt.getUTCMonth()];
    const tdd  = String(windowOpenEdt.getUTCDate()).padStart(2, '0');
    const thh  = String(windowOpenEdt.getUTCHours()).padStart(2, '0');
    const tmm  = String(windowOpenEdt.getUTCMinutes()).padStart(2, '0');
    const expectedTicker = `KX${sym}15M-${tyy}${tmon}${tdd}${thh}${tmm}-${tmm}`;

    const freshData = getKalshiCachedData(sym);
    // Authenticated orderbook prices are the only trusted source — they show
    // the real best-bid/ask while the public market list can lag by minutes.
    // Always use the deterministically-computed ticker for the current window,
    // NOT freshData.ticker which may point to the already-published next window.
    const obPrices = await fetchOrderbookPrices(expectedTicker).catch(() => null);
    logger.debug(
      { sym, windowKey, expectedTicker, cacheTickerWasDifferent: freshData?.ticker !== expectedTicker },
      "[kalshi-bot] conviction live-price gate: orderbook fetch for expected window ticker",
    );

    // Orderbook fetch result handling:
    //
    // obPrices != null with prices → real book → use directly (most trusted).
    //
    // obPrices == { yesBid: null, yesAsk: null } → authenticated successfully
    // but no resting limit orders (illiquid). This is the NORMAL state for
    // Kalshi crypto markets — market makers quote via the public REST endpoint,
    // not as resting orders. Fall back to conviction poller price.
    //
    // obPrices == null → request timed out or threw (9 coins dispatching
    // simultaneously causes concurrent API calls → Kalshi rate-limits → timeout).
    // This is a network/rate-limit condition, NOT a data quality signal. The
    // conviction poller runs every 1 s with its own fresh fetch for the same
    // ticker, so its price is ≤1 s old and completely independent. Fall through
    // to the same poller-fallback path used for empty books. The spread + both-
    // sides + zone guards below still apply, and the FOK limit order still caps
    // the fill price at lockPrice, so no below-zone fill is possible.
    //
    // Historical context (2026-07-13 "0.908 vs 0.79" fill incident):
    //   That fill used freshData.ticker (pre-switched to next window ~10 min
    //   early). Both the poller and this gate now use the deterministic
    //   expectedTicker (derived from windowKey → EDT), so the price sources are
    //   always aligned on the same market. Ticker drift is no longer a risk.
    if (obPrices == null) {
      logger.warn(
        { sym, direction, windowKey, expectedTicker },
        "[kalshi-bot] conviction live-price gate: orderbook timeout/error — falling back to poller price",
      );
    }
    if (obPrices == null || (obPrices.yesBid == null && obPrices.yesAsk == null)) {
      // Empty book — authenticated successfully but no resting orders visible.
      //
      // Kalshi market makers quote via the public REST market-list endpoint, not
      // as resting limit orders in the authenticated orderbook.  The empty book
      // is therefore the NORMAL state for these thin markets throughout the window.
      //
      // Fall back to the conviction poller's fresh price, but only if it passes a
      // strict three-layer guard:
      //
      //   1. BOTH bid AND ask must be present — a one-sided quote is incomplete
      //      and suggests a stale or partially-updated market-list response.
      //
      //   2. TIGHT SPREAD: YES direction max 4 ¢, NO direction max 6 ¢ (YES price
      //      is only 5–9 ¢ so the absolute spread is naturally wider in cent terms).
      //      A wide spread is the clearest sign of a stale or stuck market-maker quote.
      //
      //   3. ZONE CHECK: the relevant ref price must lie within [lockPrice,
      //      lockPriceCap].  Belt-and-suspenders before the cross-checks below.
      //
      // Historical context on the "0.908 vs 0.79" fill incident:
      //   That fill happened because fetchOrderbookPrices was using freshData.ticker
      //   (which had already pre-switched to the NEXT window's market ~10 min early)
      //   while the conviction poller was still priced on the current window.  The
      //   deterministic expectedTicker derivation (windowKey → EDT) now completely
      //   prevents that ticker drift.  Both the poller fetch and the orderbook fetch
      //   target the same current-window ticker, so a large divergence would require
      //   the public market-list API itself to be severely stale — detectable by the
      //   spread gate.
      const pollerSnap   = getConvictionLivePrice(sym);
      const pYesAsk      = pollerSnap?.yesAsk ?? null;
      const pYesBid      = pollerSnap?.yesBid ?? null;

      // Guard 1: both sides present
      if (pYesAsk == null || pYesBid == null) {
        convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
        if (boostBetSize != null) {
          maxBetWindowToken.remaining++;
          logger.info({ sym }, "[kalshi-bot] conviction live-price gate: max-bet token restored (empty book + one-sided poller)");
        }
        logger.warn(
          { sym, direction, windowKey, expectedTicker, pYesAsk, pYesBid },
          "[kalshi-bot] conviction live-price gate: empty book — one-sided poller quote, fail closed",
        );
        return;
      }

      // Guard 2: tight spread (stale quotes have wide spreads)
      const spread = pYesAsk - pYesBid;
      // YES conviction: price ~91–95 ¢ → 4 ¢ max spread
      // NO  conviction: YES price ~5–9 ¢ → 6 ¢ max spread (YES price is tiny)
      const maxSpread = direction === "yes" ? 0.04 : 0.06;
      if (spread > maxSpread || spread < 0) {
        convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
        if (boostBetSize != null) {
          maxBetWindowToken.remaining++;
          logger.info({ sym }, "[kalshi-bot] conviction live-price gate: max-bet token restored (empty book + wide spread)");
        }
        logger.warn(
          { sym, direction, windowKey, expectedTicker, pYesAsk, pYesBid, spread: spread.toFixed(3), maxSpread },
          "[kalshi-bot] conviction live-price gate: empty book — spread too wide (stale quote?), fail closed",
        );
        return;
      }

      // Guard 3: zone check on the relevant ref price
      const pollerRefPrice =
        direction === "yes"
          ? pYesAsk
          : 1 - pYesBid;
      if (pollerRefPrice < lockPrice - 0.005 || pollerRefPrice > lockPriceCap + 0.005) {
        convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
        if (boostBetSize != null) {
          maxBetWindowToken.remaining++;
          logger.info({ sym }, "[kalshi-bot] conviction live-price gate: max-bet token restored (empty book, poller out of zone)");
        }
        logger.info(
          { sym, direction, windowKey, pollerRefPrice, lockPrice, lockPriceCap },
          "[kalshi-bot] conviction live-price gate: empty book — poller price out of zone, releasing lock for retry",
        );
        return;
      }

      // All three guards passed — proceed with the poller prices.
      // The cross-checks below (freshYesBid ≥ lockPrice for YES,
      // freshYesAsk ≤ threshold for NO) provide a fourth layer of verification
      // before the order is submitted.
      freshYesAsk = pYesAsk;
      freshYesBid = pYesBid;
      logger.info(
        { sym, direction, windowKey, expectedTicker, pYesAsk, pYesBid, spread: spread.toFixed(3), pollerRefPrice, lockPrice, lockPriceCap },
        "[kalshi-bot] conviction live-price gate: empty book — tight spread + in-zone poller, proceeding to cross-checks",
      );
    } else {
      freshYesAsk = obPrices.yesAsk;
      freshYesBid = obPrices.yesBid;

      // ── Pre-order depth check ─────────────────────────────────────────────
      // A FOK BUY fills at the cheapest available ask ≤ the limit, regardless
      // of zone.  If the book has only 1-2 contracts at in-zone prices and 20
      // at 70¢, all 15 contracts fill at a blended ~71¢ — far below zone.
      //
      // Fix: count contracts available in [lockPrice, lockPriceCap] BEFORE
      // placing.  If the book cannot fill our whole order within zone, abort.
      // The 1-second poller retries automatically on the next tick.
      //
      // Mapping:
      //   YES BUY  → needs YES asks in [lockPrice, lockPriceCap]
      //              YES ask at price P = NO bid at (1-P)
      //              → scan noDepth for prices in [1-lockPriceCap, 1-lockPrice]
      //   NO  BUY  → needs NO asks in [lockPrice, lockPriceCap]
      //              NO ask at price P = YES bid at (1-P)
      //              → scan yesDepth for prices in [1-lockPriceCap, 1-lockPrice]
      //
      // Only applies when depth arrays are available (orderbook_fp format).
      const hasDepthData = obPrices.yesDepth.length > 0 || obPrices.noDepth.length > 0;
      if (hasDepthData) {
        const depthFloor = 1 - lockPriceCap;   // e.g. 0.04 for zone [0.91, 0.96]
        const depthCap   = 1 - lockPrice;      // e.g. 0.09 for zone [0.91, 0.96]
        const depthArr   = direction === "yes" ? obPrices.noDepth : obPrices.yesDepth;

        const inZoneContracts = depthArr
          .filter(([price]) => price >= depthFloor && price <= depthCap)
          .reduce((sum, [, qty]) => sum + qty, 0);

        // Estimate needed contracts using the current ask price.
        // This mirrors the actual sizing formula (betSize / expectedFillCost).
        const betSizeEst = boostBetSize ?? S.config.maxBetSize ?? S.config.betSize ?? 20;
        const fillCostEst =
          direction === "yes"
            ? (freshYesAsk ?? lockPrice)
            : (freshYesBid != null ? 1 - freshYesBid : lockPrice);
        const neededContracts = Math.ceil(betSizeEst / Math.max(fillCostEst, lockPrice));

        if (inZoneContracts < neededContracts) {
          convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
          if (boostBetSize != null) {
            maxBetWindowToken.remaining++;
            logger.info({ sym }, "[kalshi-bot] conviction depth gate: max-bet token restored (thin in-zone book)");
          }
          logger.warn(
            {
              sym, direction, windowKey,
              inZoneContracts, neededContracts,
              depthFloor: depthFloor.toFixed(3), depthCap: depthCap.toFixed(3),
              lockPrice, lockPriceCap,
            },
            "[kalshi-bot] conviction depth gate: insufficient in-zone liquidity — aborting to prevent out-of-zone fill; retrying next tick",
          );
          return;
        }
        logger.debug(
          { sym, direction, windowKey, inZoneContracts, neededContracts },
          "[kalshi-bot] conviction depth gate: sufficient in-zone liquidity",
        );
      }
    }

    // NO orders require freshYesAsk for the cross-check.  If it is null (one-sided
    // book — bids present but no YES asks), we cannot confirm the spread is tight
    // and cannot detect a YES-ask bounce.  Fail closed: the 1 s poller will retry.
    // This is what prevented the 79–82¢ NO fills from the missing freshYesAsk bypass.
    if (direction === "no" && freshYesAsk == null) {
      convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
      if (boostBetSize != null) {
        maxBetWindowToken.remaining++;
        logger.info({ sym }, "[kalshi-bot] conviction live-price gate: max-bet token restored (NO order, freshYesAsk null)");
      }
      logger.warn(
        { sym, direction, windowKey, expectedTicker, freshYesBid },
        "[kalshi-bot] conviction live-price gate: NO order aborted — freshYesAsk null (one-sided book), cannot confirm zone",
      );
      return;
    }

    // YES direction: use the fresh YES ask.
    // NO  direction: NO ask = 1 − YES bid (the price paid per NO contract).
    const freshRefPrice =
      direction === "yes"
        ? freshYesAsk
        : freshYesBid != null ? 1 - freshYesBid : null;
    // Strict zone enforcement: gate passes ONLY when price is within
    // [lockPrice, lockPriceCap] with no tolerance.
    //
    // NOTE (2026-07-17): Kalshi now quotes SUB-CENT prices (observed
    // yesBid=0.045 → NO ask 0.955) but ORDER prices are still integer-cent.
    // A NO fill ≤ cap requires a YES-sell limit of ceil((1−cap)·100)/100
    // (e.g. 0.05 for cap 0.95), which cannot fill against a sub-cent bid like
    // 0.045.  So any tolerance here (e.g. passing 0.955) would let the gate
    // approve orders that are physically unfillable on the cent grid → FOK
    // kill → retry exhaustion → windowFailedFills lockout for the rest of the
    // window.  Strict 0 keeps this gate coherent with the order-limit clamp
    // below: gate passes ⟺ a fill inside the zone is actually achievable.
    // (Guard 3 above uses ±0.005 only as a pre-filter on the poller price;
    // this gate is the authoritative check.)
    const GATE_BUFFER = 0;
    const inWindow =
      freshRefPrice != null &&
      freshRefPrice >= lockPrice - GATE_BUFFER &&
      freshRefPrice <= lockPriceCap + GATE_BUFFER;
    if (!inWindow) {
      // Release the lock so a future tick can re-evaluate if price recovers.
      convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
      // Restore the max-bet token if this coin had already claimed it — the
      // order never executed, so the slot must be returned for the next
      // qualifying coin this window.
      if (boostBetSize != null) {
        maxBetWindowToken.remaining++;
        logger.info({ sym }, "[kalshi-bot] conviction live-price gate: max-bet token restored (order aborted before fill)");
      }
      // Record abort time ONLY for settled-upward exits (price above cap).
      // These indicate the market has moved decisively past the zone and the
      // poller needs time to propagate the new price.  Below-floor dips may
      // recover into zone — setting the cooldown there would block valid
      // re-entries after a transient dip back through 88¢.
      if (freshRefPrice != null && freshRefPrice > lockPriceCap) {
        convictionAbortCooldown.set(`${sym}:${windowKey}`, Date.now());
      }
      logger.warn(
        {
          sym, direction, windowKey,
          freshRefPrice: freshRefPrice != null ? +freshRefPrice.toFixed(4) : null,
          lockPrice, lockPriceCap, gateBuffer: GATE_BUFFER,
          freshYesAsk, freshYesBid,
        },
        "[kalshi-bot] conviction live-price gate: price moved outside window — order aborted",
      );
      return;
    }

    // ── NO cross-check (stale-bid guard) ─────────────────────────────────────
    // The main gate above uses `1 − freshYesBid` as the NO-ask proxy.  If the
    // bid data is stale (e.g., the orderbook refresh failed and the cached value
    // still shows the trigger-time bid of 7¢), the gate can pass while the real
    // market has bounced significantly.
    //
    // Problem: an ask-side FOK with limitPrice = 0.06 (sell YES ≥ 6¢) fills at
    // ANY available YES bid — including a bounced 24¢ bid → NO fill at 76¢,
    // far outside the conviction zone.
    //
    // Cross-check: freshYesAsk is fetched from the authenticated orderbook (a
    // different data path than yesBid).  If the YES ask has risen more than
    // 10¢ above the conviction target (1 − lockPrice), the market has moved and
    // the gate must abort, regardless of what freshYesBid reports.
    //
    // Example (NEAR, lockPrice=0.89):
    //   target YES = 1 − 0.89 = 0.11 (11¢)
    //   allow up to 0.11 + 0.10 = 0.21 (21¢) for normal bid-ask spread
    //   freshYesAsk = 0.24 → 0.24 > 0.21 → abort ✓
    //   freshYesAsk = 0.14 → 0.14 ≤ 0.21 → proceed ✓
    if (direction === "no" && freshYesAsk != null) {
      // Strict zone: only allow 1¢ spread above the YES-side floor.
      // Zone [90¢,95¢] NO = [5¢,10¢] YES → floor = 1−lockPrice = 10¢ → threshold = 11¢.
      // Any YES ask above 11¢ means the NO fill will land below 89¢ — outside zone.
      // Was +0.03 (→ 13¢): allowed ETH/XRP/BTC NO fills at 87–89¢ (1-2¢ below floor).
      const yesAskBounceThreshold = (1 - lockPrice) + 0.01; // 1¢ spread allowance only
      if (freshYesAsk > yesAskBounceThreshold) {
        convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
        if (boostBetSize != null) {
          maxBetWindowToken.remaining++;
          logger.info({ sym }, "[kalshi-bot] conviction live-price gate: max-bet token restored (NO cross-check abort)");
        }
        logger.warn(
          {
            sym, direction, windowKey,
            freshYesAsk: +freshYesAsk.toFixed(4),
            freshYesBid: freshYesBid != null ? +freshYesBid.toFixed(4) : null,
            yesAskBounceThreshold: +yesAskBounceThreshold.toFixed(4),
            lockPrice, lockPriceCap,
          },
          "[kalshi-bot] conviction live-price gate: NO cross-check — YES ask bounced above target; order aborted",
        );
        return;
      }
    }

    // ── YES cross-check (hard bid floor) ────────────────────────────────────
    // A FOK limit-BUY fills at the best available ask ≤ the limit price —
    // there is no minimum fill price.  If a resting sell order sits at 86¢
    // and we set limit=88¢, the exchange fills at 86¢.
    //
    // Hard guarantee: require freshYesBid ≥ lockPrice (≥ 88¢).
    // If the bid is already ≥ 88¢, buyers are paying ≥ 88¢ — that means
    // there can be no resting sell orders below 88¢ (a crossed market is
    // impossible on Kalshi).  So a fill below the zone floor becomes
    // physically impossible, regardless of any race between gate and fill.
    //
    // Example (target 0.90 → lockPrice 0.88):
    //   freshYesBid = 0.87 → 0.87 < 0.88 → abort ✓  (book has depth below zone)
    //   freshYesBid = 0.88 → 0.88 ≥ 0.88 → proceed ✓ (entire book in zone)
    if (direction === "yes" && freshYesBid != null) {
      const yesBidDropThreshold = lockPrice; // hard floor: bid must be in zone
      if (freshYesBid < yesBidDropThreshold) {
        convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
        if (boostBetSize != null) {
          maxBetWindowToken.remaining++;
          logger.info({ sym }, "[kalshi-bot] conviction live-price gate: max-bet token restored (YES cross-check abort)");
        }
        logger.warn(
          {
            sym, direction, windowKey,
            freshYesBid: +freshYesBid.toFixed(4),
            freshYesAsk: freshYesAsk != null ? +freshYesAsk.toFixed(4) : null,
            yesBidDropThreshold: +yesBidDropThreshold.toFixed(4),
            lockPrice, lockPriceCap,
          },
          "[kalshi-bot] conviction live-price gate: YES cross-check — bid below zone floor; order aborted (no sub-zone fills possible when bid >= lockPrice)",
        );
        return;
      }
    }

    // Gate passed — re-derive sizing from the fresh orderbook prices so that a
    // stale pre-gate cache (e.g. liveYesBid=0.93 left over from the prior window)
    // cannot inflate contractCount to 57 on a 4 $ bet and produce a $38 fill.
    //
    // Limit price = the EXACT verified ask (no crossing buffer).  A FOK order
    // at limit=ask fills at that ask or kills instantly if the book moved —
    // and the 1 s loop retries on the next tick.  The old ask+3¢ buffer only
    // widened the range of prices the exchange was allowed to fill at, which
    // is exactly what the user does not want ("fill in the zone or not at all").
    if (direction === "yes" && freshYesAsk != null) {
      expectedFillCost = freshYesAsk;
      orderLimitPrice = Math.floor(Math.min(freshYesAsk, lockPriceCap) * 100) / 100;
    } else if (direction === "no" && freshYesBid != null) {
      expectedFillCost = 1 - freshYesBid;
      // For NO orders the limit is expressed as a YES price.  Floor at
      // (1 - lockPriceCap) so the NO fill price can never exceed lockPriceCap.
      orderLimitPrice = Math.ceil(Math.max(freshYesBid, 1 - lockPriceCap) * 100) / 100;
    }
    const freshContractCount = Math.floor(targetBetSize / expectedFillCost);
    if (freshContractCount >= 1 && freshContractCount !== contractCount) {
      logger.info(
        {
          sym, direction,
          staleCost: contractCount > 0 ? (targetBetSize / contractCount).toFixed(4) : "n/a",
          freshCost: expectedFillCost.toFixed(4),
          staleCount: contractCount,
          freshCount: freshContractCount,
          freshOrderLimitPrice: orderLimitPrice,
        },
        "[kalshi-bot] conviction gate: re-derived sizing from fresh prices",
      );
      contractCount = freshContractCount;
    } else if (freshContractCount < 1) {
      logger.warn({ sym, direction, expectedFillCost, targetBetSize }, "[kalshi-bot] conviction gate: fresh prices give contractCount<1 — skipping");
      convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
      windowFailedFills.add(`${sym}:${windowKey}:${S.botMode}`);
      return;
    }
    // Post-gate safety re-check: the pre-gate maxBetSizeGuard used stale expectedFillCost
    // (e.g. 7¢ from a prior window → 57 contracts → $38 fill after exchange prices it
    // correctly).  Now that we have fresh prices, re-verify the actual expected cost.
    // In conviction mode this should always be ≤ maxBetCap (the gate constrains
    // expectedFillCost to 0.875–0.925 → max 11 contracts at $10 cap), but this guard
    // catches any future code path that could break that invariant.
    const postGateCost = contractCount * expectedFillCost;
    if (checkMaxBetSizeGuard(postGateCost, maxBetCap)) {
      logger.error(
        {
          sym, direction, contractCount,
          expectedFillCost: expectedFillCost.toFixed(4),
          postGateCost: postGateCost.toFixed(4),
          maxBetSize: maxBetCap,
        },
        "[kalshi-bot] SAFETY ABORT — post-conviction-gate sizing exceeds maxBetSize cap; trade cancelled",
      );
      convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
      windowFailedFills.add(`${sym}:${windowKey}:${S.botMode}`);
      return;
    }
  }

  // Trajectory gate — regular bets: block if price is trending dangerously into target.
  // Use live-patched last candle close — always fresher than predCache.price.
  if (S.config.regularBetTrajectoryEnabled && kalshiTarget != null && candles.length >= 2) {
    const trajLiveP = candles[candles.length - 1].c;
    const _trajWkMs = new Date(windowKey).getTime();
    const _trajClockS = isNaN(_trajWkMs) ? 0 : (Date.now() - _trajWkMs) / 1000;
    const traj = computeTrajectoryGate(sym, candles, trajLiveP, kalshiTarget, direction, _trajClockS, S.config, "regular");
    coinTrajectoryCache.set(sym, traj);
    if (traj.blocked) {
      logger.info(
        { sym, reason: traj.reason, velocity: traj.velocity.toFixed(2), currentMarginPct: traj.currentMarginPct.toFixed(3), projectedMarginPct: traj.projectedMarginPct.toFixed(3), minutesRemaining: traj.minutesRemaining.toFixed(1), direction },
        "[kalshi-bot] trajectory gate (regular) — BLOCKED: bet skipped (price momentum too close to target)",
      );
      return;
    }
    logger.info(
      { sym, velocity: traj.velocity.toFixed(2), projectedMarginPct: traj.projectedMarginPct.toFixed(3), minutesRemaining: traj.minutesRemaining.toFixed(1) },
      "[kalshi-bot] trajectory gate (regular) — SAFE",
    );
  }

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

      // ── IOC PARTIAL FILL CORRECTION ─────────────────────────────────────────
      // placeOrderWithRetry uses IOC: fills what the book has right now and
      // cancels the rest.  result.filledCount is the ACTUAL number of contracts
      // that went through — it can be less than the requested contractCount.
      // If we don't update contractCount here, we record the wrong position size
      // (e.g. sent 21, got 2, but store 21 / $19.95 instead of 2 / $1.91).
      if (result.filledCount > 0 && result.filledCount < contractCount) {
        logger.warn(
          { sym, direction, requested: contractCount, filled: result.filledCount, fillPrice },
          "[kalshi-bot] IOC partial fill — updating contractCount to actual fill",
        );
        contractCount = result.filledCount;
      }

      // Post-fill zone check (Layer 3 — hard guarantee).
      // Kalshi FOK BUY fills at any ask ≤ limit (no floor), so price "improvement"
      // can land the fill far below the conviction zone even when the pre-order gate
      // confirmed an in-zone price.  This check catches that race window: if the
      // actual fill price is outside [lockPrice, lockPriceCap], immediately sell to
      // eliminate the exposure and never record the position as open.
      // Loop guard: convictionEmergencyCloses caps closes at 2 per coin/window;
      // after 2 the once-per-window lock stays set so re-entry cannot happen.
      if (S.config.decisionMode === "conviction" && result.avgPrice != null) {
        const _gt   = S.config.kalshiLockPrice ?? 0.90;
        const { lockPrice: _lp, lockPriceCap: _lpCap } = deriveConvictionZone(_gt); // e.g. [0.90, 0.95] for target 0.92
        // Kalshi always returns avgPrice in YES-side terms.
        // For YES bets: fill price IS avgPrice.
        // For NO  bets: fill price = 1 − avgPrice (what we paid per NO contract).
        const convFillPrice = direction === "yes"
          ? result.avgPrice
          : 1 - result.avgPrice;
        if (convFillPrice < _lp || convFillPrice > _lpCap) {
          logger.error(
            {
              sym, direction, windowKey,
              convFillPrice: +convFillPrice.toFixed(4),
              avgPrice: +result.avgPrice.toFixed(4),
              lockPrice: _lp, lockPriceCap: _lpCap,
              contractCount, ticker: kalshiTicker,
            },
            "[kalshi-bot] CONVICTION FILL OUTSIDE ZONE — emergency close",
          );
          let emergencyExitAvgPrice: number | null = null;
          try {
            // Immediately sell what we just bought to eliminate the exposure.
            const exitResult = direction === "yes"
              ? await sellYes(kalshiTicker, contractCount)
              : await sellNo(kalshiTicker, contractCount);
            emergencyExitAvgPrice = exitResult.avgPrice ?? null;
            logger.warn(
              { sym, direction, convFillPrice: +convFillPrice.toFixed(4), contractCount, exitAvgPrice: emergencyExitAvgPrice },
              "[kalshi-bot] conviction emergency close: position closed",
            );
          } catch (closeErr) {
            logger.error(
              { sym, err: String(closeErr) },
              "[kalshi-bot] conviction emergency close FAILED — position may be stranded",
            );
          }
          // Strike counter: each out-of-zone fill costs real money (spread paid
          // on the round trip).  Allow up to 2 emergency closes per coin per
          // window; after that keep the once-per-window lock in place so the
          // coin cannot re-enter until the next window.  Prevents the
          // buy → close → re-buy bleed loop (XRP 4× in one window, 2026-07-13).
          const ecKey = `${sym}:${windowKey}`;
          const ecCount = (convictionEmergencyCloses.get(ecKey) ?? 0) + 1;
          convictionEmergencyCloses.set(ecKey, ecCount);
          const MAX_EMERGENCY_CLOSES_PER_WINDOW = 2;
          if (ecCount < MAX_EMERGENCY_CLOSES_PER_WINDOW) {
            // Release the lock so the next tick can retry if price re-enters zone.
            convictionFiredThisWindow.delete(ecKey);
          } else {
            logger.warn(
              { sym, windowKey, emergencyCloses: ecCount },
              "[kalshi-bot] conviction emergency-close limit reached — coin locked out for rest of window",
            );
          }
          // Persist the emergency close as a closed trade so it appears in
          // transaction history and P&L analytics.
          //
          // persistBetRecord with `existingId` is the only path that writes
          // exitedAt / exitPrice / pnl (the UPDATE branch). Without a prior
          // entry row there is nothing to UPDATE, so we do two sequential
          // calls: (1) INSERT the entry row, then (2) UPDATE it with exit
          // fields. This mirrors the normal bet → closePosition pattern.
          //
          // Both prices are YES-side (Kalshi returns avgPrice in YES terms for
          // both buy and sell orders). pnl formula matches closePosition().
          const _ecId       = `${sym}:${windowKey}:ec:${Date.now()}`;
          const _ecEntryYes = fillPrice;   // result.avgPrice ?? yesPrice (set at fill block above)
          const _ecExitYes  = emergencyExitAvgPrice;
          let _ecPnl = 0;
          if (_ecEntryYes != null && _ecExitYes != null) {
            const _ecDelta = direction === "yes"
              ? _ecExitYes - _ecEntryYes
              : _ecEntryYes - _ecExitYes;
            _ecPnl = _ecDelta * contractCount;
          }
          const _ecBetAmount = expectedFillCost * contractCount;

          // ── Mirror closePosition() in-memory state updates ───────────────────
          // closePosition() is not called directly here because it would place
          // a second sell order.  Instead we replicate its state mutations so
          // that the dashboard's "Today's P&L", circuit breaker, per-coin loss
          // caps, and streak counters are all updated immediately.
          if (entryMode === S.botMode) {
            S.dailyPnl += _ecPnl;
            if (_ecPnl < 0) S.dailyLossCount++;
            // Mid-window exit: apply circuit breaker as an independent event.
            S.cbState = applyBetOutcome(
              S.cbState,
              _ecPnl >= 0,
              S.config.maxConsecutiveLosses,
              S.config.circuitBreakerPauseWindows,
            );
            if (_ecPnl < 0) {
              logger.info(
                { sym, cbState: S.cbState, pnl: +_ecPnl.toFixed(4) },
                "[kalshi-bot] conviction emergency-close loss — dailyPnl and circuit breaker updated",
              );
            }
          }
          // Per-coin daily loss (mode-specific map, same as closePosition).
          {
            const _ecModeMap = coinDailyLossForMode(entryMode);
            _ecModeMap.set(
              sym,
              applyDailyLossUpdate(_ecModeMap, sym, _ecPnl, entryMode, entryMode).get(sym) ??
                (_ecModeMap.get(sym) ?? 0),
            );
          }
          // Per-coin streak (mid-window exit: apply immediately, same as closePosition).
          {
            const _ecStreakMap  = coinStreakStateForMode(entryMode);
            const _ecStreakStore = streakStoreForMode(entryMode);
            const _ecPrev = _ecStreakMap.get(sym) ?? { consecutiveLosses: 0, pauseUntilWindowKey: null };
            const _ecNext = applyStreakUpdate(
              _ecPrev, _ecPnl,
              S.config.coinStreakLossLimit ?? 3,
              S.config.coinStreakPauseWindows ?? 2,
              Date.now(),
            );
            _ecStreakMap.set(sym, _ecNext);
            persistCoinStreakState(_ecStreakMap, _ecStreakStore).catch(() => {});
          }
          // Account balance.
          if (entryMode === "live") {
            getBalance().then(b => { S.accountBalance = b.availableBalance; }).catch(() => {});
          } else {
            S.accountBalance = (S.accountBalance ?? S.config.paperStartingBalance ?? 100) + _ecPnl;
          }
          // ─────────────────────────────────────────────────────────────────────

          // Step 1: insert entry record (same shape as a normal bet open).
          persistBetRecord({
            insertId: _ecId,
            symbol: sym,
            windowKey,
            ticker: kalshiTicker,
            direction,
            action: "bet",
            signals: decision.signals,
            entryPrice: _ecEntryYes ?? undefined,
            kalshiTarget: kalshiTarget ?? 0,
            contractCount,
            betAmount: _ecBetAmount,
            decisionMode: "conviction",
            mode: entryMode,
          }).then(() =>
            // Step 2: update same row with exit fields (sets exitedAt, pnl, etc.).
            persistBetRecord({
              existingId: _ecId,
              symbol: sym,
              windowKey,
              ticker: kalshiTicker,
              direction,
              action: "exit",
              exitPrice: _ecExitYes ?? undefined,
              pnl: _ecPnl,
              exitReason: "conviction_emergency_close",
              kalshiTarget: kalshiTarget ?? 0,
              contractCount,
              betAmount: _ecBetAmount,
              decisionMode: null,
              mode: entryMode,
            })
          ).catch(err => logger.warn({ err, sym }, "[kalshi-bot] conviction emergency-close: DB persist failed (non-fatal)"));
          return; // do NOT record as open position
        }
      }

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
  // Conviction stability: persist the per-coin stability classification (er, osc, volPct,
  // mlConf, stable) so the /conviction-stability-analysis endpoint can correlate each
  // bet's market-regime conditions against its win/loss outcome and tune thresholds.
  const _stabilitySnap = S.config.decisionMode === "conviction"
    ? coinStabilityCache.get(sym) ?? null
    : null;
  const enrichedSignals = {
    ...(decision.signals as unknown as Record<string, unknown>),
    effectiveConfidence: decision.confidence,
    regime: S.regimeCache.get(sym) ?? null,
    trendStability: windowStabilityCache.get(sym) ?? null,
    windowDoubtPenalty: S.currentWindowDoubtPenalty,
    reasoning: decision.reasoning ?? null,
    // Conviction-stability metrics at entry — null for non-conviction modes.
    stabilityEr:     _stabilitySnap?.er     ?? null,
    stabilityOsc:    _stabilitySnap?.osc    ?? null,
    stabilityVolPct: _stabilitySnap?.volPct ?? null,
    stabilityMlConf: _stabilitySnap?.mlConf ?? null,
    stabilityStable: _stabilitySnap?.stable ?? null,
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
    // Kalshi YES contract price at decision time (used for conviction threshold analysis).
    entryYesPrice: yesPrice,
    // Max-bet flag: true when the stability gate + probability roll upgraded this bet.
    isMaxBet: boostBetSize != null,
  });
  // Mark this window as having a recorded decision so SKIP dedup works correctly
  lastDecisionWindowKey.set(sym, windowKey);
  // Increment the per-window bet counter so subsequent ticks respect maxBetsPerWindow.
  windowBetCounts.set(windowBetKey, betsThisWindow + 1);
  // Track gross daily spend so convictionMaxDailySpend gate can block future entries.
  S.dailySpendAmount += actualBetAmount;
  // Increment the GLOBAL window total (all symbols combined) for the maxBetsPerWindow cap.
  // Mode-aware: paper and live each have their own counter.
  const totalKey = `${windowKey}:${S.botMode}`;
  windowTotalBets.set(totalKey, (windowTotalBets.get(totalKey) ?? 0) + 1);
  // Store bet details so the eval panel can display actual direction + confidence
  // even after the coin switches to "directional cap reached" on later ticks.
  windowBetDetails.set(windowBetKey, { direction, confidence: decision.confidence });

  logger.info({ sym, direction, fillPrice, contractCount, betsThisWindow: betsThisWindow + 1 }, "[kalshi-bot] bet placed");
}

