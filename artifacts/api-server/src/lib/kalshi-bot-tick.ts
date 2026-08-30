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
  evaluateConvictionFillZone,
  CONVICTION_EMERGENCY_EXIT_FLOOR,
  shouldEmergencyExitConvictionFill,
  FASTLANE_EMERGENCY_EXIT_THRESHOLD_CENTS,
  resolveFastLaneEmergencyExitThresholdCents,
  shouldEmergencyExitFastLaneFill,
  getEffectiveConvictionZone,
  computeAdverseMomentumGate,
  computeConvictionDirectionGate,
  computeConvictionCandleSlopeGate,
  computeNoAskBounceThreshold,
  selectTimeBetBracket,
  evaluateYesBidFloorAbort,
  checkConvictionOneSidedBook,
  computeStrikeProximityGate,
  getEffectiveProximityThreshold,
  getConvictionMinEntryMinute,
  isPriceTriggeredDecisionMode,
  computeFastLaneLimitPrice,
  computeFastLaneContractCount,
  computeKalshi15mTicker,
  tryClaimEntryReservation,
  releaseEntryReservationOwnership,
  type EntryReservationOwnership,
  resolveEntryQuietHoursDecision, resolveEntryQuietHoursDecisionForSymbol,
  applyPlacementTimeReducedPct,
  type BotConfig, type BotDecision, type CircuitBreakerState, type PriceRegime,
  type DecisionMode, type CoinStreakEntry, type SignalSnapshot,
} from "./kalshi-bot-engine";
import { isSmartHoursCalibrationCurrent } from "./kalshi-quiet-hours-scheduler";
import {
  makeInitialExitState, runExitGuard, type ExitState, type GuardStates,
} from "./kalshi-bot-exit";
import {
  buyYes, buyNo, sellYes, sellNo, getBalance, isKalshiConfigured, placeOrderWithRetry,
  placeEntryOrderWithSizeFallback,
  getCachedKalshiBalance, getFreshRegularAccountSnapshot, getFreshRegularAccountSnapshotForRoute, getPreparedRegularOrderExchangeIndex,
  claimRegularRouteFundingHold, hasAuthorizedRegularRouteFundingHold, releaseRegularRouteFundingHold,
  commitRegularRouteFundingHold, getRegularAccountSnapshotDiagnostics,
  computeRegularWorstCaseRouteCost, invalidateBalanceCache, computeMarketableLimitPrice,
  fetchKalshiMarketResult, fetchKalshiSettledMarkets, placeOrder,
  isUncertainOrderError,
} from "./kalshi-trader";
import {
  claimRegularOrderIntent, resolveRegularOrderIntent, markRegularOrderIntentUnknown,
  hasUnresolvedRegularIntent,
} from "./kalshi-regular-order-intent";
import { reconcileActiveRegularExitIntent } from "./kalshi-regular-order-reconcile";
import { quoteAuthenticatedBookExecution } from "./kalshi-bot-authenticated-book-gateway";
import { dashboard2KalshiOrderbookService } from "./kalshi-orderbook-service";
import {
  describeRegularFreefallDecision,
  evaluateRegularFreefallPreSubmitGuard,
} from "./kalshi-regular-freefall-guard";
import { shouldPersistRegularFreefallSkip } from "./kalshi-freefall-telemetry";
import { regularPlacementFunnel, type RegularPlacementTerminalOutcome } from "./kalshi-regular-placement-funnel";
import crypto from "crypto";
import { decideRemainderAttempt } from "./kalshi-entry-remainder";
import { recordTickAbort, clearTickAbort } from "./kalshi-bot-eval-overlay";
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
  windowZeroFillRetryAfter, windowZeroFillBookVersions,
  windowRandomizerUsedValues,
  convictionFiredThisWindow, coinConvictionWinRates, coinStabilityCache, coinTrajectoryCache,
  convictionAbortCooldown, CONVICTION_ABORT_COOLDOWN_MS, convictionDirectionGuardBlockedMap,
  convictionAbortCooldownMs, CONVICTION_BOUNDARY_MISS_COOLDOWN_MS, convictionObCache, CONVICTION_OB_CACHE_TTL_MS,
  tickAbortReasons,
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
  convictionPriceTicks, shadowQhBypassActive,
  type BotMode, type BotStatus, type OpenPosition, type OpenPositionDisplay,
  type BotStateSnapshot, type WindowCoinEvaluation, type ParoleState,
} from "./kalshi-bot-state";
import {
  regularZeroFillRetryCooldownMs,
  regularZeroFillMaxAttempts,
  regularZeroFillRetryKey,
  regularZeroFillRetryRemainingMs,
  hasNewAuthenticatedBookVersion,
} from "./kalshi-regular-zero-fill-policy";
import { closePosition, persistBetRecord, BetRecordArgs } from "./kalshi-bot-close";
import { captureSmartExitRegularEntry } from "./kalshi-smart-exit-service";
import { getTimingAccuracy } from "./kalshi-bot-db";
import { writeBotEntryTimingSnapshot } from "./kalshi-bot-entry-timing";

// Deduplication Set for bot entry timing snapshots (cleared implicitly as
// window keys rotate — each key encodes coin+windowKey+minuteMark+mode).
const entryTimingWritten = new Set<string>();

// ---------------------------------------------------------------------------
// Tick-time abort reason helper
// ---------------------------------------------------------------------------
// Called at every conviction gate abort inside _runBotTick.  Stores the most
// recent human-readable skip reason so the window-eval dashboard can display
// it instead of the stale Phase-3 loop reason (e.g. "monitoring").
// The map is keyed by `sym:windowKey` and cleared on window transition.
function setTickAbortReason(sym: string, windowKey: string, reason: string): void {
  recordTickAbort(tickAbortReasons, sym, windowKey, reason);
}

// ---------------------------------------------------------------------------
// Trajectory Gate
// Computes price velocity from recent 1-min candles and projects where the
// underlying price will be at window close.  If the projection is too close
// to — or crosses — the Kalshi target, the max bet is blocked.
// Pure function: no I/O, no side-effects.
// ---------------------------------------------------------------------------
export function computeTrajectoryGate(
  sym: string,
  candles: Array<{ c: number; h: number; l: number; t: number }>,
  livePrice: number,
  kalshiTarget: number,
  direction: "yes" | "no",
  clockElapsedS: number,
  config: import("./kalshi-bot-engine").BotConfig,
  _betType: "max" | "regular" = "max",
  isConvictionMode: boolean = false,
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

  if (candles.length < 2) return inactive("insufficient_data");

  // ── ATR: coin-relative volatility unit ────────────────────────────────────
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

  // ── Adverse momentum gate (conviction mode only, active throughout window) ─
  // Delegates to computeAdverseMomentumGate (pure, exported, unit-tested).
  // Uses a conviction-specific lookback so it can be tuned independently of
  // the freefall gate's lookback.  Unlike the freefall gate this runs at any
  // point in the window, not just the final N minutes.
  // Guard: only activates when called from a conviction-mode tick (isConvictionMode=true).
  // Regular-trajectory calls always skip this block — config flag alone is not sufficient.
  const amEnabled = isConvictionMode && (config.convictionMomentumGateEnabled ?? false);
  if (amEnabled && minutesRemaining > 0) {
    const amLookbackMin = Math.max(1, config.convictionMomentumLookbackMinutes ?? lookbackMin);
    const amActual = Math.min(amLookbackMin, candles.length - 1);
    const amVelocity = amActual === actualLookback
      ? velocity
      : (livePrice - candles[candles.length - 1 - amActual].c) / amActual;

    const amResult = computeAdverseMomentumGate({
      livePrice,
      kalshiTarget,
      direction,
      velocityPerMin: amVelocity,
      minutesRemaining,
      safetyFactor: config.convictionMomentumSafetyFactor ?? 0.6,
      enabled: true,
    });

    if (amResult.blocked) {
      const amProjPrice = livePrice + amVelocity * minutesRemaining;
      const amProjMarginPct = ((amProjPrice - kalshiTarget) / kalshiTarget) * 100;
      return {
        symbol: sym, blocked: true, reason: "adverse_momentum_to_cross",
        velocity: amVelocity, projectedPrice: amProjPrice,
        currentMarginPct, projectedMarginPct: amProjMarginPct,
        minutesRemaining, direction, computedAt: Date.now(),
        atrPct, effectiveCurrentMarginMinPct: 0, effectiveDangerBandPct: 0,
        timeWeight: 1, adverseVelocity: true,
      };
    }
  }

  // ── Freefall gate: only meaningful in the final N minutes ─────────────────
  // Early in the window a linear velocity projection over the full horizon is
  // too noisy to act on. The gate stands silent until nearly window-close, then
  // checks whether freefall momentum will carry the price through the strike.
  const finalMinutes = config.maxBetTrajectoryFinalMinutes ?? 5;
  if (minutesRemaining > finalMinutes) return inactive("gate_inactive");

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

export async function finalizeReconciledFastLaneExit(params: {
  clientOrderId: string;
  positionId: string;
  filledCount: number;
  avgYesPrice: number;
}): Promise<boolean> {
  const entry = [...openPositions.entries()].find(([, position]) => position.id === params.positionId);
  let sym: string;
  let pos: OpenPosition;
  let reconstructedFromDb = false;
  if (entry) {
    [sym, pos] = entry;
  } else {
    const rows = await db
      .select()
      .from(kalshiBotBetsTable)
      .where(eq(kalshiBotBetsTable.id, params.positionId))
      .limit(1);
    const row = rows[0];
    if (
      !row
      || !row.direction
      || !row.ticker
      || row.entryPrice == null
      || row.contractCount == null
      || row.betAmount == null
      || row.kalshiTarget == null
    ) {
      return false;
    }
    sym = row.symbol;
    const entryYesPrice = Number(row.entryPrice);
    pos = {
      id: row.id,
      symbol: row.symbol,
      windowKey: row.windowKey,
      ticker: row.ticker,
      direction: row.direction as "yes" | "no",
      entryYesPrice,
      contractCount: Number(row.contractCount),
      betAmount: Number(row.betAmount),
      kalshiTarget: Number(row.kalshiTarget),
      openedAt: row.createdAt instanceof Date
        ? row.createdAt.getTime()
        : new Date(String(row.createdAt)).getTime(),
      cryptoPriceAtEntry: row.cryptoPriceAtEntry == null
        ? null
        : Number(row.cryptoPriceAtEntry),
      exitState: makeInitialExitState(entryYesPrice),
      entryDecision: {
        action: row.direction === "yes" ? "BET_YES" : "BET_NO",
        confidence: 0,
        signals: (row.signals ?? {}) as unknown as SignalSnapshot,
      } as BotDecision,
      phase2Activated: row.phase2Activated ?? false,
      entryMode: "live",
      source: "bot",
    };
    reconstructedFromDb = true;
  }
  await closePosition(
    pos,
    params.avgYesPrice,
    pos.kalshiTarget,
    "fastlane_fill_below_configured_floor_threshold",
    false,
    {
      reconciledLiveFill: {
        clientOrderId: params.clientOrderId,
        filledCount: params.filledCount,
        avgYesPrice: params.avgYesPrice,
        reconstructedFromDb,
      },
    },
  );
  if (!reconstructedFromDb && openPositions.get(sym)?.id === pos.id) {
    openPositions.delete(sym);
  }
  return true;
}

async function _runBotTick(
  sym: string,
  kalshiTicker: string | null,
  kalshiTarget: number | null,
  yesPrice: number | null,
  candles: Array<{ c: number; h: number; l: number; t: number; v: number; o: number }>,
): Promise<void> {
  resetDailyIfNeeded();
  const isFastLane = S.config.decisionMode === "fastlane";
  const isPriceTriggeredMode = isPriceTriggeredDecisionMode(S.config.decisionMode);

  // Recovery must run before pause and daily-loss gates. A confirmed broker
  // sell is accounting work, not a new trading decision, and must finalize even
  // while entries are disabled.
  const recoveryPos = openPositions.get(sym);
  if (recoveryPos?.entryMode === "live") {
    const recoverySignals =
      recoveryPos.entryDecision.signals as unknown as Record<string, unknown> | null;
    if (recoverySignals?.["fastLaneEmergencyExit"] === true) {
      const recovery = await reconcileActiveRegularExitIntent(recoveryPos.id);
      if (recovery.outcome === "confirmed_fill") {
        await finalizeReconciledFastLaneExit({
          clientOrderId: recovery.clientOrderId,
          positionId: recoveryPos.id,
          filledCount: recovery.filledCount,
          avgYesPrice: recovery.avgYesPrice,
        });
        return;
      }
      if (recovery.outcome === "ambiguous") return;
    }
  }

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
    const positionSignals =
      pos.entryDecision.signals as unknown as Record<string, unknown> | null;
    const fastLaneEmergencyDetails =
      positionSignals?.["fastLaneEmergencyExitDetails"] as Record<string, unknown> | null | undefined;
    const fastLaneSideCost = Number(fastLaneEmergencyDetails?.["sideCost"]);
    const fastLaneFloor = Number(fastLaneEmergencyDetails?.["lockPrice"]);
    const fastLaneThresholdCents = Number(fastLaneEmergencyDetails?.["thresholdCents"]);
    const requiresFastLaneEmergencyExit =
      pos.entryMode === "live"
      && positionSignals?.["fastLaneEmergencyExit"] === true
      && shouldEmergencyExitFastLaneFill(
        fastLaneSideCost,
        fastLaneFloor,
        fastLaneThresholdCents,
      );
    if (requiresFastLaneEmergencyExit) {
      try {
        const reconciliation = await reconcileActiveRegularExitIntent(pos.id);
        if (reconciliation.outcome === "confirmed_fill") {
          await finalizeReconciledFastLaneExit({
            clientOrderId: reconciliation.clientOrderId,
            positionId: pos.id,
            filledCount: reconciliation.filledCount,
            avgYesPrice: reconciliation.avgYesPrice,
          });
          logger.error(
            {
              sym,
              positionId: pos.id,
              clientOrderId: reconciliation.clientOrderId,
              filledCount: reconciliation.filledCount,
              avgYesPrice: reconciliation.avgYesPrice,
            },
            "[kalshi-bot] reconciled FastLane emergency exit fill — local position finalized",
          );
          return;
        }
        if (reconciliation.outcome === "ambiguous") {
          setTickAbortReason(
            sym,
            windowKey,
            "FastLane emergency exit remains unresolved; position retained pending reconciliation",
          );
          return;
        }
      } catch (reconciliationError) {
        setTickAbortReason(
          sym,
          windowKey,
          "FastLane emergency exit reconciliation unavailable; position retained fail-closed",
        );
        logger.error(
          { err: reconciliationError, sym, positionId: pos.id },
          "[kalshi-bot] FastLane emergency-exit reconciliation failed",
        );
        return;
      }
    }
    if (pos.windowKey === windowKey && requiresFastLaneEmergencyExit) {
      try {
        await closePosition(
          pos,
          yesPrice,
          kalshiTarget,
          "fastlane_fill_below_configured_floor_threshold",
        );
        openPositions.delete(sym);
        logger.error(
          {
            sym,
            windowKey,
            sideCost: fastLaneSideCost,
            configuredFloor: fastLaneFloor,
            thresholdCents: fastLaneThresholdCents,
          },
          "[kalshi-bot] recovered FastLane adverse fill — emergency exit confirmed",
        );
      } catch (closeError) {
        logger.error(
          {
            err: closeError,
            sym,
            windowKey,
            sideCost: fastLaneSideCost,
            configuredFloor: fastLaneFloor,
            thresholdCents: fastLaneThresholdCents,
          },
          "[kalshi-bot] recovered FastLane adverse fill exit failed — position remains tracked",
        );
      }
      return;
    }
    const outOfBandDetails =
      positionSignals?.["convictionOutOfBandFillDetails"] as Record<string, unknown> | null | undefined;
    const recoveredSideCost = Number(outOfBandDetails?.["sideCost"]);
    const requiresEmergencyUnwind =
      pos.entryMode === "live"
      && positionSignals?.["convictionOutOfBandFill"] === true
      && shouldEmergencyExitConvictionFill(recoveredSideCost);
    if (pos.windowKey === windowKey && requiresEmergencyUnwind) {
      try {
        await closePosition(pos, yesPrice, kalshiTarget, "conviction_fill_below_emergency_floor");
        openPositions.delete(sym);
        logger.error(
          {
            sym,
            windowKey,
            sideCost: recoveredSideCost,
            emergencyFloor: CONVICTION_EMERGENCY_EXIT_FLOOR,
          },
          "[kalshi-bot] recovered conviction fill below emergency floor — unwound",
        );
      } catch (closeError) {
        logger.error(
          {
            err: closeError,
            sym,
            windowKey,
            sideCost: recoveredSideCost,
            emergencyFloor: CONVICTION_EMERGENCY_EXIT_FLOOR,
          },
          "[kalshi-bot] recovered sub-floor conviction fill unwind failed — position remains tracked",
        );
      }
      return;
    }
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

      // ── Conviction-mode exit suppression ──────────────────────────────────
      // Conviction entries are pure price-cross bets (≥88¢ YES / ≤12¢ YES).
      // The Phase 1/2 exit guard is calibrated for signal-driven pipeline bets
      // and misfires badly in conviction mode (17% win rate on exits).
      // When disableMidExitForConviction is true (the default), all mid-exit
      // evaluation is suppressed for conviction positions so they always hold
      // to window expiry.  The conviction stop-loss in kalshi-bot-loop.ts is
      // unaffected — it runs before this path and handles catastrophic losses.
      if (S.config.decisionMode === "conviction" && S.config.disableMidExitForConviction !== false) {
        logger.debug({ sym }, "[kalshi-bot] conviction mode — mid-exit suppressed, holding to expiry");
        return;
      }

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

  // ── Tick-level Smart Hours gate (path-independent) ────────────────────────
  // The loop-level quiet-hours gates are a fast path only: the pipeline-
  // completion trigger, bet-delay timers, and conviction dispatch/retry call
  // this tick directly and never pass through them.  Resolving here guarantees
  // EVERY entry path honors Smart Hours regardless of which code dispatched it.
  // Fail-closed: a silenced hour blocks all new entries (paper included)
  // unless the shadowPaperIgnoreQuietHours bypass applies — which only ever
  // DEMOTES a live entry to paper, never permits a live order.
  // ── Tick abort reason refresh ─────────────────────────────────────────────
  // Every dispatch into the entry path clears the previous tick-time abort
  // reason for this coin+window.  Each abort path below re-records its own
  // current reason before returning, so the dashboard always shows THIS tick's
  // exact block — never a reason left over from an earlier tick that would
  // otherwise mask the current state.
  clearTickAbort(tickAbortReasons, sym, windowKey);

  if (
    S.config.quietHoursMode === "per_market"
    && S.config.quietHoursV2?.enabled === true
    && !isSmartHoursCalibrationCurrent(S.config.smartHoursCalibratedUtcHour)
  ) {
    logger.info(
      {
        sym,
        windowKey,
        storedMarker: S.config.smartHoursCalibratedUtcHour ?? null,
        source: "tick-entry-readiness",
      },
      "[kalshi-bot] smart-hours calibration pending for current hour — deferring entry without applying stale schedule",
    );
    setTickAbortReason(sym, windowKey, "smart hours: current-hour calibration pending — entry will retry");
    return;
  }

  const qhEntry = resolveEntryQuietHoursDecisionForSymbol(S.config, S.botMode, sym);
  if (qhEntry.action === "block") {
    logger.info(
      { sym, windowKey, qhMode: qhEntry.qhMode, utcHour: qhEntry.utcHour, botMode: S.botMode, source: "tick-entry-gate" },
      "[kalshi-bot] smart-hours entry gate: hour is silenced — blocking new entry",
    );
    setTickAbortReason(sym, windowKey, "smart hours: current hour is silenced — new entries blocked");
    return;
  }

  // Effective mode for ALL entry accounting in this tick.
  // shadowQhBypassActive: loop-set bypass flag (scheduler path).
  // qhEntry.forcedPaper: tick-level resolution of the same rule — covers
  // direct-dispatch paths that skip the loop.  Either one demotes the entry to
  // paper so it doesn't consume live spend budgets, window caps, or failed-fill
  // locks.  S.botMode is never mutated — position close accounting
  // (closePosition uses pos.entryMode directly) is unaffected.
  const effectiveMode: BotMode = (shadowQhBypassActive || qhEntry.forcedPaper) ? "paper" : S.botMode;
  const zeroFillRetryKey = regularZeroFillRetryKey(effectiveMode, sym, windowKey);
  const zeroFillRetryRemaining = regularZeroFillRetryRemainingMs(
    windowZeroFillRetryAfter.get(zeroFillRetryKey),
  );
  if (effectiveMode === "live" && zeroFillRetryRemaining > 0) {
    setTickAbortReason(
      sym,
      windowKey,
      `confirmed zero-fill cooldown: retry available in ${(zeroFillRetryRemaining / 1_000).toFixed(1)}s`,
    );
    return;
  }

  // Multi-bet guard: purge stale window entries then check the per-window cap.
  // Purge any entry for this symbol that belongs to an older window key (any mode).
  for (const [k] of windowBetCounts) {
    if (k.startsWith(`${sym}:`) && !k.startsWith(`${sym}:${windowKey}:`)) {
      windowBetCounts.delete(k);
    }
  }
  // Mode-aware key so paper bets don't count against the live cap and vice-versa.
  const windowBetKey = `${sym}:${windowKey}:${effectiveMode}`;
  const betsThisWindow = windowBetCounts.get(windowBetKey) ?? 0;
  if (!isPriceTriggeredMode && betsThisWindow >= S.config.maxBetsPerWindow) {
    logger.debug({ sym, betsThisWindow, max: S.config.maxBetsPerWindow }, "[kalshi-bot] maxBetsPerWindow reached — skipping entry");
    setTickAbortReason(sym, windowKey, `per-coin bet cap reached (${betsThisWindow}/${S.config.maxBetsPerWindow} this window)`);
    return;
  }
  // Live global cap re-check: Phase 3 snapshots globalBetsThisWindow once before
  // iterating coins, so when bet candidates run sequentially the first coin's bet
  // must be visible to the next. Reading windowTotalBets here (before any await)
  // gives the authoritative live count.
  // CONVICTION MODE: global cap bypassed — each coin bets independently on price cross;
  // max-bet slots are governed by convictionStabilityMaxBetsPerWindow.
  const globalTotalNow = windowTotalBets.get(`${windowKey}:${effectiveMode}`) ?? 0;
  if (!isPriceTriggeredMode && S.config.maxBetsPerWindow > 0 && globalTotalNow >= S.config.maxBetsPerWindow) {
    logger.debug({ sym, globalTotalNow, max: S.config.maxBetsPerWindow }, "[kalshi-bot] global cap reached at entry — skipping");
    setTickAbortReason(sym, windowKey, `global bet cap reached (${globalTotalNow}/${S.config.maxBetsPerWindow} this window)`);
    return;
  }

  // Ceiling: skip if bot has been in the window longer than maxEntryMinutes.
  // 0 = disabled (no ceiling — enter at any point).
  if (!isFastLane && S.config.maxEntryMinutes > 0 && secondsElapsed > S.config.maxEntryMinutes * 60) {
    setTickAbortReason(sym, windowKey, `past entry ceiling (>${S.config.maxEntryMinutes}min elapsed)`);
    return;
  }
  // Early-window lockout: hard block on new bets for the first N minutes of the window.
  // Only bypassed at true market extremes (≥92¢ or ≤8¢) regardless of mode.
  // Conviction mode respects minWindowEntryMinutes just like any other mode —
  // the separate maxBetMinWindowEntryMinutes gate controls when max bets are eligible.
  {
    const minWindowEntryMinutes = S.config.minWindowEntryMinutes ?? 0;
    if (!isFastLane && minWindowEntryMinutes > 0 && secondsElapsed < minWindowEntryMinutes * 60) {
      // Bypass: configurable — disabled means the timer is ALWAYS respected.
      // When enabled, the threshold is user-adjustable (default 0.92).
      const bypassEnabled = S.config.convictionEarlyBypassEnabled !== false;
      const bypassFloor = S.config.convictionEarlyBypassThreshold ?? 0.81;
      const bypassCap   = S.config.convictionEarlyBypassCap ?? 0.95;
      // For NO bets the actual fill cost is 1 − yesBid (the NO ask), NOT yesAsk.
      // At a 2¢ spread: YES ask=6¢, YES bid=4¢ → yesPrice=6¢, but NO ask=96¢.
      // Checking only yesPrice ≤ (1−threshold) uses the wrong side of the spread
      // and silently fails even when NO is clearly past the bypass threshold.
      // Read yesBid from the in-memory cache (no I/O) and check the actual NO ask.
      const _bypassKd    = getKalshiCachedData(sym);
      const _noActualAsk = _bypassKd?.yesBid != null ? 1 - _bypassKd.yesBid : null;
      // Bypass fires when yesPrice is in the YES zone [floor, cap] or the mirrored
      // NO zone [(1-cap), (1-floor)], or when the actual NO ask is in [floor, cap].
      const noFloor = +(1 - bypassCap).toFixed(4);
      const noCap   = +(1 - bypassFloor).toFixed(4);
      const isExtreme = bypassEnabled && (
        (yesPrice !== null && (
          (yesPrice >= bypassFloor && yesPrice <= bypassCap) ||   // YES zone
          (yesPrice >= noFloor && yesPrice <= noCap)              // NO zone
        )) ||
        (_noActualAsk !== null && _noActualAsk >= bypassFloor && _noActualAsk <= bypassCap)
      );
      if (!isExtreme) {
        logger.debug(
          { sym, windowKey, secondsElapsed, minWindowEntryMinutes, yesPrice, noActualAsk: _noActualAsk, bypassEnabled, bypassFloor, bypassCap },
          "[kalshi-bot] early-window lockout — timer active",
        );
        setTickAbortReason(sym, windowKey, `early-window lockout (first ${minWindowEntryMinutes}min — price not in extreme bypass range)`);
        return;
      }
      logger.debug(
        { sym, windowKey, secondsElapsed, minWindowEntryMinutes, yesPrice, noActualAsk: _noActualAsk, bypassFloor, bypassCap },
        "[kalshi-bot] early-window lockout bypassed — price in extreme range",
      );
    }
  }
  // Floor: early-exit the tick if fewer than minRemainingMinutes remain.
  // Bypassed entirely when allowLateEntries=true (conviction mode design: the
  // price crossing happens near settlement; blocking it defeats the purpose).
  // The hard pre-order floor below is also bypassed when allowLateEntries=true.
  if (!S.config.allowLateEntries && !isPriceTriggeredMode) {
    const minRemaining = S.config.minRemainingMinutes ?? 0;
    if (minRemaining > 0 && 15 * 60 - secondsElapsed < minRemaining * 60) {
      logger.debug({ sym, secondsElapsed, minRemaining }, "[kalshi-bot] min-remaining floor — skipping tick early");
      setTickAbortReason(sym, windowKey, `min-remaining floor: <${minRemaining}min left in window`);
      return;
    }
  }
  if (!kalshiTicker || kalshiTarget === null) {
    logger.info(
      { sym, windowKey, hasKalshiTicker: !!kalshiTicker, kalshiTarget },
      "[kalshi-bot] tick: no ticker/target — skipping (market unpublished or cache race)",
    );
    setTickAbortReason(sym, windowKey, "no Kalshi ticker/strike yet — market unpublished or cache race");
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
  if (!isFastLane && S.config.proximityGuardEnabled) {
    // Derive the same zone floor used by the engine so the bypass is in sync.
    const _proximityZone = getEffectiveConvictionZone(sym, S.config);
    const convZoneFloor = deriveConvictionZone(
      _proximityZone.lockPrice,
      _proximityZone.lockPriceCap,
    ).lockPrice;
    const proximityIsConvictionExtreme =
      isPriceTriggeredMode &&
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
          setTickAbortReason(sym, windowKey, `proximity guard: ${distancePct.toFixed(2)}% from strike — need ${threshold.toFixed(2)}% (${phase})`);
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
  if (!isPriceTriggeredMode) {
    const live = getLatestCoinSignals(sym);
    if (live.statAbove === null || live.claudeAbove === null || live.mlAbove === null) {
      logger.info(
        {
          sym, windowKey, secondsElapsed,
          statAbove: live.statAbove, claudeAbove: live.claudeAbove, mlAbove: live.mlAbove,
        },
        "[kalshi-bot] waiting for all signals (stat+Claude+ML) — no bet until all three are ready",
      );
      setTickAbortReason(sym, windowKey,
        `waiting for all signals (stat=${live.statAbove === null ? "pending" : "ready"}, Claude=${live.claudeAbove === null ? "pending" : "ready"}, ML=${live.mlAbove === null ? "pending" : "ready"})`);
      return;
    }
  }

  // Use ensemble signal accuracy (from prediction_records historyStore) for the
  // EV gate — not the bot's own win rate, which is contaminated by exit decisions.
  const signalAcc = getPredictionAnalytics(sym).bySource.ensemble.accuracyPct;
  const livePrice = getCachedPrediction(sym)?.price ?? null;
  const decision = makeBotDecision(
    sym,
    isFastLane ? { ...S.config, minConfidence: 0 } : S.config,
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
    const timingKey    = `${sym}:${windowKey}:${minuteMark}:${effectiveMode}`;
    if (!entryTimingWritten.has(timingKey)) {
      entryTimingWritten.add(timingKey);
      writeBotEntryTimingSnapshot({
        id:                   timingKey,
        coin:                 sym,
        windowKey,
        minuteMark,
        mode:                 effectiveMode,
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
  if (!isFastLane && !S.config.freeRunMode && decision.action === "BET_YES" && COIN_YES_BLOCKED.has(sym)) {
    logger.debug({ sym }, "[kalshi-bot] _runBotTick: BET_YES blocked by COIN_YES_BLOCKED (defense-in-depth)");
    setTickAbortReason(sym, windowKey, "coin filter: YES bets blocked for this coin");
    return;
  }
  if (!isFastLane && !S.config.freeRunMode && decision.action !== "SKIP" && COIN_FULLY_BLOCKED.has(sym)) {
    logger.debug({ sym }, "[kalshi-bot] _runBotTick: entry blocked by COIN_FULLY_BLOCKED (defense-in-depth)");
    setTickAbortReason(sym, windowKey, "coin filter: all bets blocked for this coin");
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
  if (!isPriceTriggeredMode) {
    const dirSigs = decision.signals as { claudeAbove?: boolean | null };
    if (decision.action === "BET_YES" && dirSigs.claudeAbove === false) {
      logger.info(
        { sym, windowKey, claudeAbove: dirSigs.claudeAbove, confidence: decision.confidence },
        "[kalshi-bot] _runBotTick: BET_YES blocked — Claude says NO (direction quality gate)",
      );
      setTickAbortReason(sym, windowKey, "direction quality gate: YES bet blocked — Claude calls BELOW");
      return;
    }
    if (decision.action === "BET_NO" && dirSigs.claudeAbove === true) {
      logger.info(
        { sym, windowKey, claudeAbove: dirSigs.claudeAbove, confidence: decision.confidence },
        "[kalshi-bot] _runBotTick: BET_NO blocked — Claude says YES (direction quality gate)",
      );
      setTickAbortReason(sym, windowKey, "direction quality gate: NO bet blocked — Claude calls ABOVE");
      return;
    }
  }

  // ── RE-ENTRY GUARD ───────────────────────────────────────────────────────
  // If we exited a position mid-window (fast-flip or phase-2), we may re-enter
  // — but only in the OPPOSITE direction, and only with a higher confidence bar
  // (+5pp) to avoid immediately flipping back on noise.
  const recentFlip = midExitedWindows.get(sym);
  if (!isFastLane && recentFlip && recentFlip.windowKey === windowKey && decision.action !== "SKIP") {
    const exitedDir = recentFlip.direction; // "yes" or "no"
    const newDir = decision.action === "BET_YES" ? "yes" : "no";
    if (newDir === exitedDir) {
      // Same direction as what we just exited — skip to avoid whipsawing.
      logger.debug({ sym, exitedDir, newDir }, "[kalshi-bot] re-entry blocked — same direction as mid-exit");
      setTickAbortReason(sym, windowKey, `re-entry guard: already exited a ${exitedDir.toUpperCase()} position this window — same-direction re-entry blocked`);
      return;
    }
    // Opposite direction is allowed but requires higher confidence.
    const flipConfidenceBar = (S.config.minConfidence ?? 65) + 5;
    if (decision.confidence < flipConfidenceBar) {
      logger.debug({ sym, confidence: decision.confidence, flipConfidenceBar }, "[kalshi-bot] re-entry blocked — confidence below flip bar");
      setTickAbortReason(sym, windowKey, `re-entry guard: flip needs confidence ≥${flipConfidenceBar} (have ${decision.confidence})`);
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
    setTickAbortReason(sym, windowKey, decision.reasoning || "engine returned SKIP");
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
  if (!isFastLane && !S.config.freeRunMode && streakPause.blocked) {
    logger.info(
      { sym, pauseUntilWindowKey: streakInfo!.pauseUntilWindowKey, windowKey, consecutiveLosses: streakInfo!.consecutiveLosses },
      "[kalshi-bot] SKIP — coin paused after consecutive window losing streak",
    );
    setTickAbortReason(sym, windowKey, `streak pause: ${streakInfo!.consecutiveLosses} consecutive losses — paused until window ${streakInfo!.pauseUntilWindowKey}`);
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
  if (!isFastLane && !S.config.freeRunMode) {
    const streakLimit = S.config.coinStreakLossLimit ?? 3;
    const currentLosses = streakInfo?.consecutiveLosses ?? 0;
    if (streakLimit > 0 && currentLosses >= streakLimit) {
      logger.info(
        { sym, currentLosses, streakLimit },
        "[kalshi-bot] SKIP — pre-entry streak block: already at streak limit",
      );
      setTickAbortReason(sym, windowKey, `streak block: ${currentLosses} consecutive losses ≥ limit ${streakLimit}`);
      return;
    }
  }

  // ── Per-coin daily loss cap ───────────────────────────────────────────────
  // Skip for the rest of the UTC day when this coin's losses reach the cap.
  const coinLossToday = activeCoinDailyLoss().get(sym) ?? 0;
  const maxCoinLoss = S.config.maxDailyLossPerCoin ?? 3;
  if (!isFastLane && checkDailyLossGuard(coinLossToday, maxCoinLoss)) {
    logger.info(
      { sym, coinLossToday: coinLossToday.toFixed(4), maxDailyLossPerCoin: maxCoinLoss },
      "[kalshi-bot] SKIP — coin has reached its daily loss cap",
    );
    setTickAbortReason(sym, windowKey, `daily loss cap: $${coinLossToday.toFixed(2)} lost today ≥ $${maxCoinLoss} cap`);
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
  if (!isPriceTriggeredMode) {
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
      setTickAbortReason(sym, windowKey, `momentum check: candle cache not warm (${candles.length}/${lookbackCandles} candles)`);
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
        setTickAbortReason(sym, windowKey, `reversal guard: candle momentum ${netChangePct >= 0 ? "+" : ""}${netChangePct.toFixed(2)}% opposes ${direction.toUpperCase()} bet`);
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
    if (!S.config.freeRunMode && !isPriceTriggeredMode && livePrice != null && livePrice > 0 && kalshiTarget > 0) {
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
        setTickAbortReason(sym, windowKey, `strike proximity: price ${distancePct.toFixed(3)}% from strike on at-risk side (< ${STRIKE_PROXIMITY_PCT}%)`);
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
    if (!S.config.freeRunMode && !isPriceTriggeredMode && kalshiTarget > 0 && pred != null && pred.candles.length >= 6) {
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
        setTickAbortReason(sym, windowKey, `strike oscillation: ${crossings} strike crossings in last 6 candles — market chopping around target`);
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
  const isConviction = isPriceTriggeredMode;
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
  if (!isPriceTriggeredMode) {
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
      setTickAbortReason(sym, windowKey, `return floor: fill cost ${(expectedFillCost * 100).toFixed(0)}¢ → return ${(1 / expectedFillCost).toFixed(2)}× < ${minReturnFloor}× minimum`);
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
  if (!isFastLane && !S.config.freeRunMode && (S.config.consensusMinCents ?? 25) > 0) {
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
      setTickAbortReason(sym, windowKey, msg);
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

  // Historical production evidence did not support max-size promotion from the
  // old stability/trajectory stack. Keep its UI telemetry passive, but conviction
  // entries always use normal configured sizing until a validated replacement
  // policy is intentionally introduced.
  const boostBetSize: number | null = null;
  // A max-bet token is reserved before the late conviction/order gates run.
  // Every no-fill retry or pre-fill abort must release it exactly once so one
  // rejected coin cannot strand the window's max-bet opportunity.
  let entryReservationOwnership: EntryReservationOwnership = {
    maxBetTokenReserved: boostBetSize != null,
    convictionLockClaimed: false,
  };
  const releaseConvictionEntryReservation = (reason: string): void => {
    const release = releaseEntryReservationOwnership(entryReservationOwnership);
    entryReservationOwnership = release.nextOwnership;
    if (release.releaseConvictionLock) {
      convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
    }
    // restoreMaxBetToken is always false while conviction max-size promotion is disabled.
  };
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
  let targetBetSize = boostBetSize != null
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

  // ── TIME-BASED BET SCHEDULE + EXTREME CAUTION BET OVERRIDE ───────────────
  // Priority: timeBetSchedule wins when a bracket matches; only when no
  // bracket matches (or schedule is disabled) does extremeCautionBetOverride
  // apply (conviction mode only).  Normal sizing is the final fallback.
  // Both features are no-ops when disabled (enabled flag false / empty
  // schedule / override 0).
  //
  // IMPORTANT: use nowMs/windowStartMs (anchored to the official window
  // boundary) rather than winCtx.secondsElapsed (prefetch-relative, 20-40 s
  // behind) so bracket thresholds are evaluated against true elapsed time.
  const nowMs = Date.now();
  const windowStartMs = new Date(windowKey + ":00Z").getTime();
  const secondsElapsedNow = isNaN(windowStartMs) ? 0 : (nowMs - windowStartMs) / 1000;
  const secondsRemainingNow = 15 * 60 - secondsElapsedNow;
  let betScheduleApplied = false;
  if ((S.config.timeBetScheduleEnabled ?? false) && (S.config.timeBetSchedule?.length ?? 0) > 0) {
    const elapsedMin = secondsElapsedNow / 60;
    const match = selectTimeBetBracket(S.config.timeBetSchedule ?? [], elapsedMin);
    if (match != null) {
      const scheduled = match.betAmount;
      logger.info(
        { sym, elapsedMin: +elapsedMin.toFixed(1), bracketMin: match.minutesElapsed, scheduled: +scheduled.toFixed(2), prev: +targetBetSize.toFixed(2) },
        "[kalshi-bot] time-bet schedule: overriding bet size",
      );
      targetBetSize = scheduled;
      betScheduleApplied = true;
    }
  }

  // ── BET AMOUNT RANDOMIZER ─────────────────────────────────────────────────
  // When enabled and ≥ 2 values are configured, override targetBetSize with a
  // randomly-chosen value from the list.  This runs AFTER all other sizing
  // paths (conviction boost, regime, dynamic, time-schedule, extreme caution)
  // so it overrides all of them.  The per-coin maxBetSize (from coinOverrides)
  // is the only hard cap that still applies after randomization.
  // NOTE: Smart Quiet Hours is applied AFTER this block so the percentage
  // reduction is always honoured regardless of which sizing path set the value.
  // betRandomizerApplied is tracked so the downstream maxBetCap guard widens
  // to honour the randomized amount (same pattern as betScheduleApplied).
  //
  // Per-window deduplication: each distinct dollar value can only be picked
  // once per coin per window.  Available pool = full list minus already-confirmed
  // values this window.  If every value has been used, falls back to normal
  // sizing rather than repeating a high amount.
  //
  // IMPORTANT: the picked value is NOT recorded as used here.  In conviction
  // mode _runBotTick fires every second per coin; the conviction gate (live
  // price, bid-floor, zone check) blocks the order on most ticks.  Recording
  // at the sizing step would exhaust all slots on failed-gate ticks before the
  // real FOK ever lands.  The value is recorded only after the bet is confirmed
  // placed (see windowRandomizerUsedValues.set call after windowBetCounts.set).
  let betRandomizerApplied = false;
  // Carries the tentative pick down to the post-fill confirmation block.
  let randomizerPickedForWindow: number | null = null;
  if (
    (S.config.betRandomizerEnabled ?? false) &&
    Array.isArray(S.config.betRandomizerValues) &&
    S.config.betRandomizerValues.length >= 2
  ) {
    const vals = S.config.betRandomizerValues;
    // Ensure the coin's Set is in the Map (even when empty) so the filter is
    // consistent across ticks within the same window before any fill lands.
    if (!windowRandomizerUsedValues.has(sym)) windowRandomizerUsedValues.set(sym, new Set());
    const usedSet = windowRandomizerUsedValues.get(sym)!;
    const available = vals.filter(v => !usedSet.has(v));
    if (available.length > 0) {
      const picked = available[Math.floor(Math.random() * available.length)]!;
      const clamped = perCoinMaxBet != null && picked > perCoinMaxBet ? perCoinMaxBet : picked;
      // Stash for post-fill recording — do NOT add to usedSet yet.
      randomizerPickedForWindow = picked;
      logger.info(
        {
          sym, picked: +picked.toFixed(2), clamped: +clamped.toFixed(2),
          available: available.map(v => +v.toFixed(2)),
          alreadyUsedThisWindow: [...usedSet].map(v => +v.toFixed(2)),
          prev: +targetBetSize.toFixed(2),
        },
        `[kalshi-bot] bet randomizer: tentatively selected $${picked.toFixed(2)} from [${available.join(", ")}] (will record on confirmed fill)`,
      );
      targetBetSize = clamped;
      betRandomizerApplied = true;
    } else {
      logger.info(
        { sym, values: vals, usedThisWindow: [...usedSet].map(v => +v.toFixed(2)) },
        "[kalshi-bot] bet randomizer: all values used this window — falling back to normal sizing",
      );
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── QUIET HOURS V2 REDUCED BET CAP ───────────────────────────────────────
  // Applied LAST — after every other sizing path including the randomizer —
  // so the operator-configured percentage is always honoured regardless of
  // whether overall sizing, conviction boost, or bet randomization set the
  // pre-reduction value.  Intentionally does not check betScheduleApplied or
  // betRandomizerApplied so neither can bypass this reduction.
  //
  // The percentage is RE-RESOLVED here at sizing time (qhSizing) rather than
  // read from the loop's tick-start snapshot (S.quietHoursV2ReducedBet): a
  // tick that crosses an hour boundary — or a direct-dispatch entry that never
  // went through the loop — must use the rule for the hour the bet is actually
  // placed in.  The loop snapshot is kept as a fallback for safety (larger
  // reduction wins).
  const qhSizing = resolveEntryQuietHoursDecisionForSymbol(S.config, S.botMode, sym);
  const effectiveReducedPct = (() => {
    const fresh = qhSizing.reducedPct;
    const snap  = S.quietHoursV2ReducedBet;
    if (fresh != null && snap != null) return Math.min(fresh, snap); // most conservative
    return fresh ?? snap;
  })();
  // Remembered for the FINAL pre-order gate: if the clock crosses into a
  // stricter reduced hour between here and order submission, the contract
  // count is rescaled there using this as the already-applied baseline.
  let sizingReducedPctApplied: number | null = null;
  if (effectiveReducedPct != null && effectiveReducedPct >= 1) {
    const reducedPct = effectiveReducedPct; // 10–99 — percentage OF regular bet to use (50 = bet at 50% of normal)
    const reducedSize = +(targetBetSize * (reducedPct / 100)).toFixed(2);
    if (reducedSize < targetBetSize) {
      logger.info(
        { sym, reducedPct, prev: +targetBetSize.toFixed(2), next: reducedSize, randomizerApplied: betRandomizerApplied },
        "[kalshi-bot] quiet-hours-v2 reduced bet % applied",
      );
      targetBetSize = reducedSize;
    }
    sizingReducedPctApplied = reducedPct;
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── DATA-GATHERING DOLLAR CAP ───────────────────────────────────────────────
  // Hours in dataGatheringByDow have 0 or sparse bets. When collection is on,
  // the bot is capped at a small dollar amount so it collects data without
  // exposing normal risk. When collection is off, the authoritative entry gate
  // blocks these cells before sizing. Applied after all other sizing so the cap is
  // always honoured regardless of dynamic sizing, conviction boost, or randomizer.
  // This cap path only runs when dataGatheringEnabled is on.
  // Per-cell dollar overrides take precedence over the global dataGatheringBetCap.
  if (qhSizing.isDataGathering && S.config.dataGatheringEnabled !== false) {
    const dgCap = qhSizing.dgOverrideAmount ?? (S.config.dataGatheringBetCap ?? 1);
    if (targetBetSize > dgCap) {
      logger.info(
        { sym, prev: +targetBetSize.toFixed(2), cap: dgCap, perCell: qhSizing.dgOverrideAmount != null },
        `[kalshi-bot] data-gathering cap — sparse hour capped at $${dgCap}${qhSizing.dgOverrideAmount != null ? " (per-cell override)" : ""}`,
      );
      targetBetSize = dgCap;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

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
        mode: effectiveMode,
      },
      "[kalshi-bot] SKIP — budget cannot buy 1 contract at current ask; engaging fill cooldown",
    );
    windowFailedFills.add(`${sym}:${windowKey}:${effectiveMode}`);
    setTickAbortReason(sym, windowKey, `sizing: $${targetBetSize.toFixed(2)} budget cannot buy 1 contract at ${(expectedFillCost * 100).toFixed(0)}¢ ask`);
    releaseConvictionEntryReservation("initial sizing produced zero contracts");
    return;
  }
  const betAmount = contractCount * expectedFillCost; // expected dollars risked
  // Legacy Conviction-only gross-spend throttle. FastLane intentionally does
  // not inherit this mode-specific cap; it retains the canonical daily-loss,
  // balance, reservation, ownership, and reconciliation safety boundaries.
  if (
    S.config.decisionMode === "conviction"
    && effectiveMode === "live"
    && (S.config.convictionMaxDailySpend ?? 0) > 0
  ) {
    const spendCap = S.config.convictionMaxDailySpend!;
    if (S.dailySpendAmount + betAmount > spendCap) {
      logger.info(
        { sym, dailySpendAmount: S.dailySpendAmount.toFixed(2), betAmount: betAmount.toFixed(2), spendCap },
        "[kalshi-bot] SKIP — daily spend cap reached",
      );
      setTickAbortReason(sym, windowKey, `daily spend cap: $${S.dailySpendAmount.toFixed(2)} spent + $${betAmount.toFixed(2)} bet > $${spendCap} cap`);
      releaseConvictionEntryReservation("daily spend cap");
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
  // When the time-bet schedule or bet randomizer applied a larger amount,
  // honour that amount as the cap so the safety check doesn't false-positive
  // on intentional overrides.
  const maxBetCap = (betScheduleApplied || betRandomizerApplied)
    ? Math.max(effectiveMaxBet, targetBetSize)
    : effectiveMaxBet;
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
        mode: effectiveMode,
      },
      "[kalshi-bot] SAFETY ABORT — computed betAmount exceeds maxBetSize cap; trade cancelled",
    );
    setTickAbortReason(sym, windowKey, `safety abort: computed bet $${betAmount.toFixed(2)} exceeds $${maxBetCap} max-bet cap`);
    releaseConvictionEntryReservation("initial max-size safety abort");
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ── LIVE-ONLY GUARDS: slippage strikes, account balance, total exposure ───
  if (effectiveMode === "live") {
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
      setTickAbortReason(sym, windowKey, "slippage penalty: ≥3 unfair fills last window — sitting this window out");
      releaseConvictionEntryReservation("slippage strike guard");
      return;
    }

    // Account balance guard: conviction dispatch consumes only the snapshot
    // prewarmed by the poller. Never put an authenticated balance GET between an
    // eligible conviction quote and its atomic durable claim.
    const minBal = S.config.minAccountBalance ?? 5;
    try {
      const liveBal = S.config.decisionMode === "conviction"
        ? getFreshRegularAccountSnapshot()
        : await getCachedKalshiBalance();
      if (liveBal == null) {
        throw new Error("fresh regular account snapshot unavailable");
      }
      S.accountBalance = liveBal; // keep bot state fresh for the dashboard badge
      if (checkBalanceGuard(liveBal, minBal)) {
        logger.error(
          { sym, liveBal: liveBal.toFixed(2), minAccountBalance: minBal },
          "[kalshi-bot] SAFETY ABORT — Kalshi account balance below minimum; trade cancelled",
        );
        setTickAbortReason(sym, windowKey, `safety abort: account balance $${liveBal.toFixed(2)} below $${minBal} minimum`);
        releaseConvictionEntryReservation("account balance below minimum");
        return;
      }
    } catch (err) {
      logger.error(
        { err, sym, accountSnapshot: getRegularAccountSnapshotDiagnostics() },
        "[kalshi-bot] SAFETY ABORT — could not fetch Kalshi balance before trade; trade cancelled",
      );
      setTickAbortReason(sym, windowKey, "safety abort: could not fetch account balance before trade");
      releaseConvictionEntryReservation("account balance fetch failed");
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
      setTickAbortReason(sym, windowKey, `safety abort: open exposure $${openExposure.toFixed(2)} + $${betAmount.toFixed(2)} bet exceeds $${maxExposure} cap`);
      releaseConvictionEntryReservation("open exposure cap");
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
  // secondsElapsedNow / secondsRemainingNow / nowMs / windowStartMs are declared
  // earlier (before the time-bet schedule block) so they are also available here.
  if (!S.config.allowLateEntries && !isPriceTriggeredMode) {
    const hardFloorS = (S.config.minRemainingMinutes ?? 0) * 60;
    if (hardFloorS > 0 && secondsRemainingNow < hardFloorS) {
      logger.warn(
        { sym, secondsRemainingNow: Math.round(secondsRemainingNow), windowKey, hardFloorS },
        "[kalshi-bot] HARD FLOOR — aborting bet, insufficient time remaining in window",
      );
      setTickAbortReason(sym, windowKey, `hard late-entry floor: only ${Math.round(secondsRemainingNow)}s left in window (< ${hardFloorS}s floor) at order time`);
      releaseConvictionEntryReservation("hard late-entry floor");
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
    const noSignals = !isPriceTriggeredMode && (decision.signals?.signalsTotal ?? 0) < 1;
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
      setTickAbortReason(sym, windowKey,
        `completeness gate: missing ${[noPrice && "price reference", noSignals && "model signals", noTarget && "Kalshi strike"].filter(Boolean).join(", ")} — trade cancelled`);
      releaseConvictionEntryReservation("pre-bet completeness gate");
      return;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── CONVICTION MIN ENTRY WAIT ──────────────────────────────────────────────
  // Hard floor: block entry until N minutes have elapsed in this window.
  // The bot polls continuously — the instant the floor clears and price is in
  // zone ([lockPrice-2¢, lockPrice+2¢]), the next tick fires the bet.
  //
  // Conviction-only exception: if convictionEarlyBypassEnabled=true and the live price
  // crosses the extreme bypass threshold (default 0.92, currently set to 0.95
  // in config), entry is allowed immediately — that's an outsized move that
  // justifies jumping the queue.  Any price within the normal zone waits.
  // FastLane never receives the early-price bypass: its configured wait is a
  // hard placement-time floor even when the contract is already in range.
  if (isPriceTriggeredMode) {
    // Use per-market override when set; falls through to global convictionMinEntryMinutes.
    const _convMinEntry = getConvictionMinEntryMinute(sym, S.config);
    if (_convMinEntry > 0 && secondsElapsedNow < _convMinEntry * 60) {
      const _bypassEnabled =
        S.config.decisionMode === "conviction" &&
        S.config.convictionEarlyBypassEnabled !== false;
      const _bypassFloor = S.config.convictionEarlyBypassThreshold ?? 0.81;
      const _bypassCap   = S.config.convictionEarlyBypassCap ?? 0.95;
      // Same spread-side fix as the minWindowEntryMinutes bypass above:
      // use the actual NO ask (1 − yesBid) not yesAsk for the NO direction check.
      const _bypassKd2    = getKalshiCachedData(sym);
      const _noActualAsk2 = _bypassKd2?.yesBid != null ? 1 - _bypassKd2.yesBid : null;
      const _noFloor2 = +(1 - _bypassCap).toFixed(4);
      const _noCap2   = +(1 - _bypassFloor).toFixed(4);
      const _isExtreme = _bypassEnabled && (
        (yesPrice !== null && (
          (yesPrice >= _bypassFloor && yesPrice <= _bypassCap) ||
          (yesPrice >= _noFloor2 && yesPrice <= _noCap2)
        )) ||
        (_noActualAsk2 !== null && _noActualAsk2 >= _bypassFloor && _noActualAsk2 <= _bypassCap)
      );
      if (_isExtreme) {
        logger.debug(
          { sym, windowKey, elapsedMin: +(secondsElapsedNow / 60).toFixed(1), yesPrice, noActualAsk: _noActualAsk2, _bypassFloor, _bypassCap },
          "[kalshi-bot] conviction: min entry wait bypassed — price in extreme range",
        );
      } else {
        const modeLabel = isFastLane ? "fastlane" : "conviction";
        logger.info(
          { sym, windowKey, elapsedMin: +(secondsElapsedNow / 60).toFixed(1), convictionMinEntryMinutes: _convMinEntry },
          `[kalshi-bot] ${modeLabel}: min entry time not yet reached — skipping`,
        );
        setTickAbortReason(sym, windowKey,
          `${modeLabel}: min entry wait (${_convMinEntry}min — ${(secondsElapsedNow / 60).toFixed(1)}min elapsed${isFastLane ? "" : ", price not in extreme bypass range"})`);
        releaseConvictionEntryReservation(`${modeLabel} minimum entry wait`);
        return;
      }
    }
  }

  // Conviction once-per-window lock: mark synchronously before any await so that
  // a concurrent tick (e.g. the 5s scheduler vs the pipeline-completion trigger)
  // cannot also read the guard as "not fired" and place a duplicate bet.
  // The Phase-3 scheduler in kalshi-bot-loop.ts checks this same Set and skips
  // conviction coins that are already marked.  Cleared on window transition.
  if (S.config.decisionMode === "conviction" || isFastLane) {
    const convictionReservationKey = `${sym}:${windowKey}`;
    if (!tryClaimEntryReservation(convictionFiredThisWindow, convictionReservationKey)) {
      setTickAbortReason(sym, windowKey, "conviction entry already reserved by another dispatch");
      return;
    }
    entryReservationOwnership = {
      ...entryReservationOwnership,
      convictionLockClaimed: true,
    };
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
  const convictionHotPathStartedAt = Date.now();
  let finalQuoteReadyAt = convictionHotPathStartedAt;
  // Deterministic exact-window ticker. Kalshi names 15-minute contracts by
  // their New York local close time, so the conversion must honor EST/EDT.
  const expectedTicker = computeKalshi15mTicker(sym, windowKey);

  if (S.config.decisionMode === "conviction") {
    if (
      kalshiTicker !== expectedTicker
      || kalshiTarget == null
      || !Number.isFinite(kalshiTarget)
      || kalshiTarget <= 0
    ) {
      releaseConvictionEntryReservation("poller ticker/strike identity mismatch");
      setTickAbortReason(sym, windowKey, "conviction market identity unavailable or mismatched");
      logger.warn(
        { sym, windowKey, expectedTicker, suppliedTicker: kalshiTicker, kalshiTarget },
        "[kalshi-bot] conviction entry blocked: exact ticker/strike snapshot mismatch",
      );
      return;
    }
    // Derive the asymmetric −2¢/+3¢ zone from the single slider value
    // (kalshiLockPrice) via deriveConvictionZone — single source of truth,
    // shared with the engine, the conviction poller, and the post-fill check.
    // Target 92¢ → zone [90¢, 95¢]. Below the floor: price can flip, too
    // risky. Above the cap: margin too small, not worth the entry.
    const _effectiveZone = getEffectiveConvictionZone(sym, S.config);
    const { lockPrice, lockPriceCap } = deriveConvictionZone(
      _effectiveZone.lockPrice,
      _effectiveZone.lockPriceCap,
    );
    // expectedTicker already computed above (hoisted). Re-used here for OB fetch.

    const freshData = getKalshiCachedData(sym);
    // Authenticated orderbook prices are the only trusted source — they show
    // the real best-bid/ask while the public market list can lag by minutes.
    // Always use the deterministically-computed ticker for the current window,
    // NOT freshData.ticker which may point to the already-published next window.
    // Use pre-warmed orderbook cache when available (populated by the conviction
    // poller in the same poll cycle that triggered this dispatch — saves 0.5–2 s
    // of Kalshi API latency on the critical entry path).  Falls back to a fresh
    // authenticated API call when the cache is absent, stale (>1.5 s), or for a
    // mismatched ticker.  Caching null (timeout) is intentionally excluded: the
    // tick treats null as "retry later" and must not serve a stale error.
    const _cachedOb = convictionObCache.get(sym);
    const _obCacheFresh = _cachedOb != null
      && Date.now() - _cachedOb.fetchedAt <= CONVICTION_OB_CACHE_TTL_MS
      && _cachedOb.ticker === expectedTicker;
    const obPrices: { yesAsk: number | null; yesBid: number | null } | null =
      _obCacheFresh && _cachedOb
        ? { yesAsk: _cachedOb.yesAsk, yesBid: _cachedOb.yesBid }
        : null;
    logger.debug(
      { sym, windowKey, expectedTicker, cacheTickerWasDifferent: freshData?.ticker !== expectedTicker, obCacheHit: _obCacheFresh },
      "[kalshi-bot] conviction live-price gate: prepared orderbook consumed",
    );

    // No public/poller fallback is allowed for conviction. If this authenticated
    // prepared book is absent, empty, or one-sided, fail closed and wait for a
    // later tick. The final execution gateway below separately requires fresh
    // authenticated full requested depth and revalidates it immediately before
    // the broker POST.
    if (
      obPrices == null
      || obPrices.yesAsk == null
      || obPrices.yesBid == null
    ) {
      const reason = obPrices == null
        ? "authenticated orderbook unavailable"
        : "authenticated orderbook incomplete";
      releaseConvictionEntryReservation(reason);
      logger.warn(
        { sym, direction, windowKey, expectedTicker, reason },
        "[kalshi-bot] conviction live-price gate: authenticated book required — retrying next tick",
      );
      setTickAbortReason(sym, windowKey, `${reason} — retrying next tick`);
      return;
    }
    freshYesAsk = obPrices.yesAsk;
    freshYesBid = obPrices.yesBid;

    // NO orders require freshYesAsk for the cross-check.  If it is null (one-sided
    // book — bids present but no YES asks), we cannot confirm the spread is tight
    // and cannot detect a YES-ask bounce.  Fail closed: the 1 s poller will retry.
    // This is what prevented the 79–82¢ NO fills from the missing freshYesAsk bypass.
    if (direction === "no" && freshYesAsk == null) {
      releaseConvictionEntryReservation("NO order freshYesAsk missing");
      logger.warn(
        { sym, direction, windowKey, expectedTicker, freshYesBid },
        "[kalshi-bot] conviction live-price gate: NO order aborted — freshYesAsk null (one-sided book), cannot confirm zone",
      );
      setTickAbortReason(sym, windowKey, "NO order: one-sided book (no YES ask) — cannot confirm zone");
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

    // One-sided orderbook bypass:
    // Kalshi market makers frequently rest bids but not asks (or vice-versa)
    // when one direction is strongly in-the-money.  For example:
    //   YES bet: freshYesAsk=null, freshYesBid=0.999 — no one selling YES,
    //     but bid of 99.9¢ proves the price has NOT reversed below the floor.
    //   NO bet:  freshYesBid=null, freshYesAsk=0.001 — NO price (1−ask) ≈ 1.
    // When the primary ref price is null the belowFloor condition always fires
    // (null < floor is treated as true), aborting every order even though the
    // available side confirms the direction.  checkConvictionOneSidedBook
    // detects this pattern; when confirmed we skip both the belowFloor and
    // aboveCap aborts (we cannot determine above-cap from one side alone).
    // The subsequent cross-checks (evaluateYesBidFloorAbort, NO-ask bounce)
    // remain active for further validation.
    const { oneSidedConfirmed, side: oneSidedSide } = checkConvictionOneSidedBook(
      direction, freshYesAsk, freshYesBid, lockPrice,
    );
    if (oneSidedConfirmed) {
      logger.info(
        {
          sym, direction, windowKey, oneSidedSide,
          freshYesAsk, freshYesBid, lockPrice, lockPriceCap,
        },
        "[kalshi-bot] conviction live-price gate: one-sided book — direction confirmed by available side, proceeding",
      );
    }

    // Split zone check into two independent conditions:
    //   belowFloor — price reversed back through the entry floor (dangerous: abort)
    //   aboveCap   — price moved further PAST the cap in our direction (good: continue)
    // Previously both were treated as "!inWindow → abort", which meant every
    // NO bet at 97–99¢ was killed even though the market had moved MORE in our
    // favor and the FOK at the capped limit was still achievable.
    // When oneSidedConfirmed=true both conditions are bypassed — the available
    // side already confirms the direction is safe.
    const belowFloor = !oneSidedConfirmed && (freshRefPrice == null || freshRefPrice < lockPrice - GATE_BUFFER);
    const aboveCap   = !oneSidedConfirmed && freshRefPrice != null && freshRefPrice > lockPriceCap + GATE_BUFFER;

    if (belowFloor) {
      // Price reversed back through the entry floor — abort and clear lock so
      // a future tick can re-evaluate if price recovers into the zone.
      // Set abort cooldown so the loop does not immediately re-dispatch while
      // the conviction poller has not yet pushed a fresh in-zone reading through.
      releaseConvictionEntryReservation("price reversed below floor");
      convictionAbortCooldown.set(`${sym}:${windowKey}`, Date.now());
      logger.info(
        {
          sym, direction, windowKey,
          freshRefPrice: freshRefPrice != null ? +freshRefPrice.toFixed(4) : null,
          lockPrice, lockPriceCap, gateBuffer: GATE_BUFFER,
          freshYesAsk, freshYesBid,
          cooldownMs: CONVICTION_ABORT_COOLDOWN_MS,
        },
        "[conviction-diag] tick-time price miss: reversed below floor — abort cooldown set",
      );
      setTickAbortReason(sym, windowKey,
        `price ${freshRefPrice != null ? (freshRefPrice * 100).toFixed(1) + '¢' : '?'} reversed below ${direction} entry floor ${(lockPrice * 100).toFixed(0)}¢`);
      return;
    }

    if (aboveCap) {
      // Price has moved PAST the cap — entry window missed, strict enforcement.
      // Abort and release the once-per-window lock so a future tick can
      // re-evaluate if price pulls back into [lockPrice, lockPriceCap].
      // Set abort cooldown to prevent immediate re-dispatch.
      releaseConvictionEntryReservation("price moved past cap");
      convictionAbortCooldown.set(`${sym}:${windowKey}`, Date.now());
      // Boundary miss — use shorter 2 s cooldown so the bot can re-enter quickly
      // if the price pulls back into the zone from the far side of the cap.
      convictionAbortCooldownMs.set(`${sym}:${windowKey}`, CONVICTION_BOUNDARY_MISS_COOLDOWN_MS);
      logger.info(
        {
          sym, direction, windowKey,
          freshRefPrice: +freshRefPrice.toFixed(4),
          lockPrice, lockPriceCap,
          cooldownMs: CONVICTION_BOUNDARY_MISS_COOLDOWN_MS,
        },
        "[conviction-diag] tick-time price miss: price past cap — abort cooldown set",
      );
      setTickAbortReason(sym, windowKey,
        `${direction.toUpperCase()} ${(freshRefPrice * 100).toFixed(1)}¢ past entry cap ${(lockPriceCap * 100).toFixed(0)}¢ — entry window missed`);
      return;
    }

    // ── NO cross-check (stale-bid guard) ─────────────────────────────────────
    // The main gate above uses `1 − freshYesBid` as the NO-ask proxy.  If the
    // bid data is stale (e.g., the orderbook refresh failed and the cached value
    // still shows the trigger-time bid of 7¢), the gate can pass while the real
    // market has bounced significantly.
    //
    // Problem: an immediate ask-side order with limitPrice = 0.06 (sell YES ≥ 6¢) fills at
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
    // NO cross-check: an immediate buy-NO can fill against an eligible YES bid, so
    // a high YES ask IS a fill-price risk.  The threshold gives 1¢ of spread
    // tolerance above the conviction zone floor.  Applies to all entry paths
    // (both poller-fallback and real-book) since both now use IOC.
    if (direction === "no" && freshYesAsk != null) {
      // Strict zone: only allow 1¢ spread above the YES-side floor.
      // Zone [91¢,96¢] NO = [4¢,9¢] YES → floor = 1−lockPrice = 9¢ → threshold = 10¢.
      // Any YES ask above 10¢ means the NO fill could land below 91¢ — outside zone.
      // Round to 2 decimal places to avoid IEEE 754 drift: (1 − 0.91) evaluates to
      // 0.08999... in double precision, making the raw threshold 0.09999... instead of
      // 0.10, causing a false abort when freshYesAsk is exactly 0.10.
      const yesAskBounceThreshold = computeNoAskBounceThreshold(lockPrice, false);
      if (freshYesAsk > yesAskBounceThreshold) {
        releaseConvictionEntryReservation("NO cross-check abort");
        convictionAbortCooldown.set(`${sym}:${windowKey}`, Date.now());
        logger.info(
          {
            sym, direction, windowKey,
            freshYesAsk: +freshYesAsk.toFixed(4),
            freshYesBid: freshYesBid != null ? +freshYesBid.toFixed(4) : null,
            yesAskBounceThreshold: +yesAskBounceThreshold.toFixed(4),
            lockPrice, lockPriceCap,
            cooldownMs: CONVICTION_ABORT_COOLDOWN_MS,
          },
          "[conviction-diag] tick-time price miss: NO cross-check YES ask bounced above target — abort cooldown set",
        );
        setTickAbortReason(sym, windowKey,
          `NO cross-check: YES ask ${(freshYesAsk * 100).toFixed(1)}¢ > bounce threshold ${(yesAskBounceThreshold * 100).toFixed(1)}¢ — price reversed`);
        return;
      }
    }

    // ── YES cross-check (hard bid floor) ────────────────────────────────────
    // A marketable limit-BUY fills at the best available ask ≤ the limit price —
    // there is no minimum fill price.  If a resting sell order sits at 86¢
    // and we set limit=88¢, the exchange fills at 86¢.
    //
    // Hard guarantee when resting orders are present: require freshYesBid ≥ lockPrice.
    // If the bid is already ≥ 88¢, buyers are paying ≥ 88¢ — that means
    // there can be no resting sell orders below 88¢ (a crossed market is
    // impossible on Kalshi).  So a fill below the zone floor becomes
    // physically impossible, regardless of any race between gate and fill.
    //
    // Example (target 0.90 → lockPrice 0.88, book has resting orders):
    //   freshYesBid = 0.87 → 0.87 < 0.88 → abort ✓  (book has depth below zone)
    //   freshYesBid = 0.88 → 0.88 ≥ 0.88 → proceed ✓ (entire book in zone)
    if (direction === "yes" && freshYesBid != null) {
      const bidAbort = evaluateYesBidFloorAbort(
        freshYesBid,
        lockPrice,
        false,
        false,
      );
      if (bidAbort.abort) {
        releaseConvictionEntryReservation("YES bid-floor cross-check abort");
        convictionAbortCooldown.set(`${sym}:${windowKey}`, Date.now());
        logger.info(
          {
            sym, direction, windowKey,
            freshYesBid: +freshYesBid.toFixed(4),
            freshYesAsk: freshYesAsk != null ? +freshYesAsk.toFixed(4) : null,
            yesBidDropThreshold: +lockPrice.toFixed(4),
            lockPrice, lockPriceCap,
            cooldownMs: CONVICTION_ABORT_COOLDOWN_MS,
          },
          "[conviction-diag] tick-time price miss: YES cross-check bid below zone floor — abort cooldown set",
        );
        setTickAbortReason(sym, windowKey,
          `YES cross-check: bid ${(freshYesBid * 100).toFixed(1)}¢ below zone floor ${(lockPrice * 100).toFixed(0)}¢ — price reversed`);
        return;
      }
    }

    // Gate passed — re-derive sizing from the fresh orderbook prices so that a
    // stale pre-gate cache (e.g. liveYesBid=0.93 left over from the prior window)
    // cannot inflate contractCount to 57 on a 4 $ bet and produce a $38 fill.
    //
    // Limit at the exact verified executable quote. IOC accepts whatever volume
    // is immediately available there and cancels the rest; it does not chase a
    // moved quote or authorize a higher price.
    if (direction === "yes" && freshYesAsk != null) {
      expectedFillCost = freshYesAsk;
      orderLimitPrice = Math.floor(Math.min(freshYesAsk, lockPriceCap) * 100) / 100;
    } else if (direction === "no" && freshYesBid != null) {
      expectedFillCost = 1 - freshYesBid;
      // For NO orders the limit is expressed as a YES-side ask. Floor it at
      // (1 - lockPriceCap) so the acquired NO price cannot exceed the cap.
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
      releaseConvictionEntryReservation("fresh sizing produced zero contracts");
      windowFailedFills.add(`${sym}:${windowKey}:${effectiveMode}`);
      setTickAbortReason(sym, windowKey,
        `bet size $${targetBetSize} too small for contract cost ${(expectedFillCost * 100).toFixed(0)}¢ — 0 contracts`);
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
      releaseConvictionEntryReservation("post-gate max-size safety abort");
      windowFailedFills.add(`${sym}:${windowKey}:${effectiveMode}`);
      setTickAbortReason(sym, windowKey,
        `safety abort: sizing $${postGateCost.toFixed(2)} exceeds max bet cap $${maxBetCap}`);
      return;
    }
    finalQuoteReadyAt = Date.now();
  } else if (isFastLane) {
    if (
      kalshiTicker !== expectedTicker
      || kalshiTarget == null
      || !Number.isFinite(kalshiTarget)
      || kalshiTarget <= 0
    ) {
      releaseConvictionEntryReservation("FastLane ticker/strike identity mismatch");
      setTickAbortReason(sym, windowKey, "FastLane market identity unavailable or mismatched");
      return;
    }

    const fastLaneZoneRaw = getEffectiveConvictionZone(sym, S.config);
    const fastLaneZone = deriveConvictionZone(
      fastLaneZoneRaw.lockPrice,
      fastLaneZoneRaw.lockPriceCap,
    );
    const fastLaneNoAsk = _cachedKalshi?.noAsk
      ?? (liveYesBid != null ? 1 - liveYesBid : null);
    const observedSideCost = direction === "yes" ? liveYesAsk : fastLaneNoAsk;
    if (
      observedSideCost == null
      || observedSideCost < fastLaneZone.lockPrice
      || observedSideCost > fastLaneZone.lockPriceCap
    ) {
      releaseConvictionEntryReservation("FastLane price outside configured range");
      setTickAbortReason(
        sym,
        windowKey,
        `FastLane: ${direction.toUpperCase()} price ${
          observedSideCost == null ? "unavailable" : `${(observedSideCost * 100).toFixed(1)}¢`
        } outside ${(fastLaneZone.lockPrice * 100).toFixed(0)}¢–${(fastLaneZone.lockPriceCap * 100).toFixed(0)}¢ range`,
      );
      return;
    }

    orderLimitPrice = computeFastLaneLimitPrice(direction, fastLaneZone.lockPriceCap);
    const worstCaseSideCost = direction === "yes"
      ? orderLimitPrice
      : 1 - orderLimitPrice;
    expectedFillCost = worstCaseSideCost;
    const fastLaneContractCount = computeFastLaneContractCount(
      targetBetSize,
      direction,
      orderLimitPrice,
    );
    if (fastLaneContractCount < 1) {
      releaseConvictionEntryReservation("FastLane sizing produced zero contracts");
      setTickAbortReason(
        sym,
        windowKey,
        `FastLane: $${targetBetSize.toFixed(2)} cannot buy one contract at ${(expectedFillCost * 100).toFixed(1)}¢`,
      );
      return;
    }
    contractCount = fastLaneContractCount;
    finalQuoteReadyAt = Date.now();
    logger.info(
      {
        sym,
        direction,
        windowKey,
        observedSideCost,
        worstCaseSideCost,
        rangeFloor: fastLaneZone.lockPrice,
        rangeCap: fastLaneZone.lockPriceCap,
        orderLimitPrice,
        contractCount,
      },
      "[kalshi-bot] FastLane range hit — submitting edge-capped IOC",
    );
  }

  let placementCandidateId: string | null = null;
  const ensurePlacementCandidate = (mode: BotMode = effectiveMode): string => {
    if (placementCandidateId == null) {
      placementCandidateId = regularPlacementFunnel.identify({
        mode,
        symbol: sym,
        windowKey,
        side: direction,
      }, convictionHotPathStartedAt).id;
    }
    return placementCandidateId;
  };
  let paperLiveEligibilityReason: string | null = null;
  const markPlacementTerminal = (
    outcome: RegularPlacementTerminalOutcome,
    reason: string,
  ): void => {
    regularPlacementFunnel.terminal(ensurePlacementCandidate(), outcome, Date.now(), reason);
  };
  const markPaperLiveIneligible = (reason: string): void => {
    paperLiveEligibilityReason ??= reason;
  };

  // Trajectory gate — regular bets: block if price is trending dangerously into target.
  // Use live-patched last candle close — always fresher than predCache.price.
  if (
    !isPriceTriggeredMode
    && S.config.regularBetTrajectoryEnabled
    && kalshiTarget != null
    && candles.length >= 2
  ) {
    const trajLiveP = candles[candles.length - 1].c;
    const _trajWkMs = new Date(windowKey).getTime();
    const _trajClockS = isNaN(_trajWkMs) ? 0 : (Date.now() - _trajWkMs) / 1000;
    const traj = computeTrajectoryGate(sym, candles, trajLiveP, kalshiTarget, direction, _trajClockS, S.config, "regular");
    coinTrajectoryCache.set(sym, traj);
    if (traj.blocked) {
      releaseConvictionEntryReservation("regular trajectory gate");
      logger.info(
        { sym, reason: traj.reason, velocity: traj.velocity.toFixed(2), currentMarginPct: traj.currentMarginPct.toFixed(3), projectedMarginPct: traj.projectedMarginPct.toFixed(3), minutesRemaining: traj.minutesRemaining.toFixed(1), direction },
        "[kalshi-bot] trajectory gate (regular) — BLOCKED: bet skipped (price momentum too close to target)",
      );
      setTickAbortReason(sym, windowKey,
        `trajectory gate: price momentum too close to target (projected margin ${traj.projectedMarginPct.toFixed(3)}%)`);
      const trajectoryReason = traj.reason ?? "regular trajectory guard";
      regularPlacementFunnel.finalEligibility(ensurePlacementCandidate(), false, Date.now(), trajectoryReason);
      markPlacementTerminal("proximity", trajectoryReason);
      return;
    }
    logger.info(
      { sym, velocity: traj.velocity.toFixed(2), projectedMarginPct: traj.projectedMarginPct.toFixed(3), minutesRemaining: traj.minutesRemaining.toFixed(1) },
      "[kalshi-bot] trajectory gate (regular) — SAFE",
    );
  }

  // ── Conviction strike-proximity re-check (tick-time) ──────────────────────
  // The main-loop evaluation runs computeStrikeProximityGate once per loop
  // tick using a potentially-stale cached crypto price.  Between that check
  // and the IOC order below, the live price can drift much closer to the
  // Kalshi strike than the configured threshold allows (e.g. NEAR at 0.03%
  // when the threshold is 0.15%).  Re-check here with the freshest available
  // price — the latest fresh one-second spot sample — immediately before the
  // order fires. Missing price or strike evidence blocks.
  if (
    S.config.decisionMode === "conviction"
    && (S.config.convictionProximityGuardEnabled ?? true)
  ) {
    const _proxNow = Date.now();
    const _proxLatestTick = [...(convictionPriceTicks.get(sym) ?? [])]
      .reverse()
      .find((sample) =>
        Number.isFinite(sample.price)
        && sample.price > 0
        && sample.ts <= _proxNow
        && _proxNow - sample.ts <= 2_000
      );
    const _proxLivePrice = _proxLatestTick?.price ?? null;
    const _proxAtrPct = getCachedPrediction(sym)?.indicators?.volatilityPct ?? null;
    const _proxBaseThreshold = getEffectiveProximityThreshold(sym, S.config);
    const _prox = computeStrikeProximityGate({
      livePrice:        _proxLivePrice,
      kalshiStrike:     kalshiTarget,
      direction,
      thresholdPct:     _proxBaseThreshold,
      atrPct:           _proxAtrPct,
      atrScaleEnabled:  S.config.strikeProximityAtrScale ?? true,
      // Conviction entries are naturally near-strike; cap ATR amplification at
      // 1.2× so a high-vol coin doesn't double the threshold and re-block entries
      // that are in the Kalshi conviction zone by design.
      atrMultiplierCap: 1.2,
    });
    if (_prox.blocked) {
      releaseConvictionEntryReservation("conviction proximity re-check");
      logger.warn(
        {
          sym, direction, windowKey,
          gapPct:             _prox.gapPct?.toFixed(4),
          baseThreshold:      _proxBaseThreshold.toFixed(4),
          atrMultiplier:      _prox.atrMultiplier.toFixed(2),
          effectiveThreshold: _prox.effectiveThreshold.toFixed(4),
          livePrice:          _proxLivePrice,
          kalshiStrike:       kalshiTarget,
        },
        "[kalshi-bot] conviction proximity re-check: price too close to strike — order aborted",
      );
      setTickAbortReason(sym, windowKey,
        `strike-proximity re-check: gap ${_prox.gapPct?.toFixed(3) ?? '?'}% < threshold ${_prox.effectiveThreshold.toFixed(3)}%`);
      regularPlacementFunnel.finalEligibility(ensurePlacementCandidate(), false, Date.now(), "strike proximity guard");
      markPlacementTerminal("proximity", "strike proximity guard");
      void persistBetRecord({
        symbol: sym,
        windowKey,
        ticker: expectedTicker,
        direction,
        action: "skip",
        signals: {
          reason: "conviction_proximity_guard",
          guard: {
            blocked: true,
            gapPct: _prox.gapPct,
            effectiveThreshold: _prox.effectiveThreshold,
            atrMultiplier: _prox.atrMultiplier,
            livePrice: _proxLivePrice,
            kalshiStrike: kalshiTarget,
            spotSampleAt: _proxLatestTick?.ts ?? null,
          },
        },
        entryPrice: yesPrice,
        kalshiTarget,
      }).catch((err) => logger.warn(
        { err, sym, windowKey },
        "[kalshi-bot] proximity guard evidence persist failed",
      ));
      return;
    }
    logger.info(
      {
        sym, direction, windowKey,
        gapPct:             _prox.gapPct?.toFixed(4) ?? "n/a",
        effectiveThreshold: _prox.effectiveThreshold.toFixed(4),
      },
      "[kalshi-bot] conviction proximity re-check: gap OK — proceeding",
    );
  }

  // ── Pipeline direction guard (all non-conviction modes) ──────────────────
  // Conviction mode already has its own guard above (with second-level ticks).
  // For pipeline/ml_gate/classic entries the signals tell you *where price
  // closes*, but say nothing about intra-window entry momentum.  If spot is
  // trending toward the strike right now, that is a bad-timing entry regardless
  // of the longer-horizon prediction.  Reuse computeConvictionDirectionGate
  // with only candle slope (no priceTicks — those are conviction-poller-sourced).
  // Fail-open: guard is skipped when < 2 candles are available.
  if (!isPriceTriggeredMode &&
      (S.config.convictionDirectionGuardEnabled ?? true) &&
      candles.length >= 2) {
    const _pLookback = Math.max(1, Math.min(S.config.convictionDirectionLookbackCandles ?? 3, 10));
    const _pDir = computeConvictionDirectionGate({ candles, direction, lookback: _pLookback });
    if (_pDir.blocked) {
      releaseConvictionEntryReservation("pipeline direction guard");
      logger.warn(
        {
          sym, direction, windowKey,
          decisionMode: S.config.decisionMode,
          fromPrice:    _pDir.fromPrice,
          toPrice:      _pDir.toPrice,
          slopePrice:   _pDir.slopePrice?.toFixed(2),
          lookback:     _pLookback,
        },
        "[kalshi-bot] pipeline direction guard: price moving toward strike — order aborted",
      );
      setTickAbortReason(sym, windowKey,
        `direction guard: price moving toward strike (slope ${_pDir.slopePrice?.toFixed(2) ?? "?"}/candle) — order aborted`);
      regularPlacementFunnel.finalEligibility(ensurePlacementCandidate(), false, Date.now(), "pipeline direction guard");
      markPlacementTerminal("direction", "pipeline direction guard");
      return;
    }
    logger.info(
      {
        sym, direction, windowKey,
        decisionMode: S.config.decisionMode,
        slopePrice: _pDir.slopePrice?.toFixed(2),
        lookback:   _pLookback,
      },
      "[kalshi-bot] pipeline direction guard: price moving away from strike — OK",
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
  const authorizationDecisionMode = S.config.decisionMode;
  const authorizationConvictionZone = (() => {
    if (authorizationDecisionMode !== "conviction") return null;
    const effective = getEffectiveConvictionZone(sym, S.config);
    return deriveConvictionZone(effective.lockPrice, effective.lockPriceCap);
  })();
  const authorizationFastLaneZone = (() => {
    if (authorizationDecisionMode !== "fastlane") return null;
    const effective = getEffectiveConvictionZone(sym, S.config);
    return deriveConvictionZone(effective.lockPrice, effective.lockPriceCap);
  })();
  const authorizationFastLaneEmergencyThresholdCents =
    authorizationDecisionMode === "fastlane"
      ? resolveFastLaneEmergencyExitThresholdCents(
        S.config.fastLaneEmergencyExitThresholdCents,
      )
      : null;
  let convictionOutOfBandFill: {
    sideCost: number;
    reason: "below_floor" | "above_cap";
    lockPrice: number;
    lockPriceCap: number;
  } | null = null;
  let fastLaneEmergencyExit: {
    sideCost: number;
    lockPrice: number;
    lockPriceCap: number;
    thresholdCents: number;
    shortfallCents: number;
  } | null = null;

  // ── DURABLE INTENT LIFECYCLE (live mode only) ────────────────────────────
  // These MUST live at function scope, not inside the `if (entryMode === "live")`
  // block, because the confirmed-fill resolve below runs AFTER persistBetRecord
  // (outside that block). Leaving them block-scoped left every confirmed live
  // fill stuck at status='reserved'. Paper mode never sets _intentClaimed, so it
  // stays fully isolated from this durable table.
  const _intentReservationId = crypto.randomUUID();
  let _intentClaimed = false;
  let _routeFundingHoldClaimed = false;

  // ── FINAL SMART HOURS CHECK — immediately before order placement ─────────
  // Authoritative, fail-closed re-resolution at the moment the order would be
  // submitted.  Catches (a) entry paths that bypassed the loop gates entirely,
  // and (b) ticks that started in an allowed hour but crossed into a silenced
  // hour before reaching this point.  A live order must NEVER be placed during
  // a silenced hour — with the shadow bypass the entry is demoted to paper;
  // without it the entry is rejected outright.
  if (
    S.config.quietHoursMode === "per_market"
    && S.config.quietHoursV2?.enabled === true
    && !isSmartHoursCalibrationCurrent(S.config.smartHoursCalibratedUtcHour)
  ) {
    logger.warn(
      {
        sym,
        windowKey,
        direction,
        storedMarker: S.config.smartHoursCalibratedUtcHour ?? null,
        source: "pre-order-readiness",
      },
      "[kalshi-bot] smart-hours calibration became stale before placement — deferring order without applying stale schedule",
    );
    releaseConvictionEntryReservation("current-hour smart-hours calibration pending");
    setTickAbortReason(sym, windowKey, "smart hours: current-hour calibration pending — order deferred");
    regularPlacementFunnel.finalEligibility(
      ensurePlacementCandidate(),
      false,
      Date.now(),
      "current-hour smart-hours calibration pending",
    );
    markPlacementTerminal("smart_hours", "current-hour smart-hours calibration pending");
    return;
  }

  const qhFinal = resolveEntryQuietHoursDecisionForSymbol(S.config, S.botMode, sym);
  if (qhFinal.action === "block") {
    logger.warn(
      { sym, windowKey, direction, qhMode: qhFinal.qhMode, utcHour: qhFinal.utcHour, botMode: S.botMode, source: "pre-order-final-gate" },
      "[kalshi-bot] smart-hours FINAL gate: hour is silenced — order rejected at placement time",
    );
    releaseConvictionEntryReservation("final smart-hours block");
    setTickAbortReason(sym, windowKey, "smart hours: current hour is silenced — order rejected at placement time");
    regularPlacementFunnel.finalEligibility(ensurePlacementCandidate(), false, Date.now(), "final smart-hours block");
    markPlacementTerminal("smart_hours", "final smart-hours block");
    return;
  }

  // ── FINAL REDUCED-% ENFORCEMENT — same placement-time authority as above ──
  // Sizing ran earlier in the tick; if the clock crossed from an active hour
  // (or a milder reduction) into a STRICTER reduced hour before reaching this
  // point, the already-computed contract count is too large for the hour the
  // bet is actually placed in.  Rescale it here (most-conservative-wins: a
  // reduced→active crossing never inflates the bet back up).  If the stricter
  // budget can no longer buy one contract, reject the order outright and
  // release conviction state exactly like the silenced-hour block above.
  {
    const rescaled = applyPlacementTimeReducedPct(contractCount, sizingReducedPctApplied, qhFinal.reducedPct);
    if (rescaled !== contractCount) {
      if (rescaled < 1) {
        logger.warn(
          { sym, windowKey, direction, sizedCount: contractCount, sizingReducedPctApplied, finalReducedPct: qhFinal.reducedPct, utcHour: qhFinal.utcHour, source: "pre-order-final-gate" },
          "[kalshi-bot] smart-hours FINAL gate: hour turned reduced — budget no longer buys 1 contract; order rejected at placement time",
        );
        releaseConvictionEntryReservation("final smart-hours reduced sizing below one contract");
        setTickAbortReason(sym, windowKey,
          `smart hours: hour turned reduced (${qhFinal.reducedPct}%) — budget no longer buys 1 contract; order rejected at placement time`);
        regularPlacementFunnel.finalEligibility(ensurePlacementCandidate(), false, Date.now(), "smart-hours reduced sizing below one contract");
        markPlacementTerminal("smart_hours", "smart-hours reduced sizing below one contract");
        return;
      }
      logger.warn(
        { sym, windowKey, direction, prevCount: contractCount, newCount: rescaled, sizingReducedPctApplied, finalReducedPct: qhFinal.reducedPct, utcHour: qhFinal.utcHour, source: "pre-order-final-gate" },
        "[kalshi-bot] smart-hours FINAL gate: hour turned reduced after sizing — contract count rescaled at placement time",
      );
      contractCount = rescaled;
    }
  }

  // Snapshot the mode ONCE before any await. If the user flips the mode while
  // the live order is filling, this entry must still be recorded and exited as
  // the mode it was actually placed in — otherwise a real live buy could be
  // recorded as paper and never sold, stranding funds on the exchange.
  //
  // shadowQhBypassActive: set by the loop when shadowPaperIgnoreQuietHours fires
  // during a silenced hour.  qhFinal.forcedPaper is the tick-level resolution of
  // the same rule (covers direct-dispatch paths).  Either demotes the entry to
  // paper-only so auto-tune data accumulates without placing any live order.
  // S.botMode is NOT changed by the bypass — position closes and risk counters
  // stay live-correct because closePosition uses pos.entryMode (not S.botMode
  // or these flags).
  const entryMode: BotMode = (shadowQhBypassActive || qhFinal.forcedPaper) ? "paper" : S.botMode;
  ensurePlacementCandidate(entryMode);
  if (qhFinal.forcedPaper && !shadowQhBypassActive) {
    logger.info(
      { sym, windowKey, direction, utcHour: qhFinal.utcHour, source: "pre-order-final-gate" },
      "[kalshi-bot] smart-hours FINAL gate: silenced hour + shadow bypass — live entry demoted to paper",
    );
  }

  // Evaluate one canonical final decision for both modes at the exact same
  // pre-submit boundary. Live fails closed; paper records the decision but
  // remains advisory so it can measure the guard without changing exposure.
  const freefallProduct = CRYPTO_COINS.find(
    (product) => product.symbol.toUpperCase() === sym.toUpperCase(),
  );
  const freefallStartedAt = Date.now();
  const regularFreefall = evaluateRegularFreefallPreSubmitGuard({
    enabled: !isFastLane && (S.config.convictionDirectionGuardEnabled ?? true),
    samples: convictionPriceTicks.get(sym) ?? [],
    side: direction,
    nowMs: freefallStartedAt,
    windowStartMs,
    closeTimeMs: windowStartMs + 15 * 60_000,
    targetPrice: kalshiTarget,
    hasProduct: freefallProduct != null,
    authoritativeCommodityCadence: freefallProduct?.product.startsWith("PYTH:") ?? false,
  });
  const regularFreefallSignals = {
    allowed: regularFreefall.allowed,
    evidenceClass: regularFreefall.allowed
      ? "clear"
      : regularFreefall.guardResult?.evaluable === true ? "adverse" : "unavailable",
    advisory: entryMode === "paper",
    cadence: freefallProduct?.product.startsWith("PYTH:") ? "pyth" : "coinbase",
    reason: regularFreefall.reason,
    guardResult: regularFreefall.guardResult,
    sampleCoverageMs: regularFreefall.sampleCoverageMs,
    secondsRemaining: regularFreefall.secondsRemaining,
  } as const;
  if (!regularFreefall.allowed) {
    const evidence = describeRegularFreefallDecision(regularFreefall);
    convictionDirectionGuardBlockedMap.set(sym, {
      direction,
      advisory: entryMode === "paper",
      gate: regularFreefall.guardResult?.evaluable === false ? "no-data" : "tick",
      evidenceClass: regularFreefallSignals.evidenceClass,
      reason: regularFreefall.reason,
      lookback: regularFreefall.guardResult?.samplesUsed ?? 0,
      fromPrice: regularFreefall.guardResult?.evaluatedSamples[0]?.price,
      toPrice: regularFreefall.guardResult?.latestPrice ?? undefined,
    });
    if (entryMode === "live") {
      regularPlacementFunnel.finalEligibility(ensurePlacementCandidate(), false, Date.now(), evidence);
      markPlacementTerminal("freefall", evidence);
      setTickAbortReason(sym, windowKey, evidence);
      releaseConvictionEntryReservation(evidence);
      logger.warn(
        {
          sym,
          windowKey,
          direction,
          product: freefallProduct?.product ?? null,
          reason: regularFreefall.reason,
          secondsRemaining: regularFreefall.secondsRemaining,
          guardResult: regularFreefall.guardResult,
        },
        "[kalshi-bot] final regular freefall guard blocked order before durable intent",
      );
      const persistSkip = (mode: BotMode) => {
        const persistAt = Date.now();
        const reason = regularFreefall.reason ?? "freefall_blocked_final";
        if (!shouldPersistRegularFreefallSkip({
          symbol: sym, windowKey, mode, reason, nowMs: persistAt,
        })) return;
        void persistBetRecord({
          symbol: sym,
          windowKey,
          ticker: expectedTicker,
          direction,
          action: "skip",
          signals: {
            reason: "conviction_freefall_guard",
            // Keep the established top-level fields for production analytics
            // while the structured object carries paper/live parity metadata.
            guardReason: regularFreefall.reason,
            guardResult: regularFreefall.guardResult,
            sampleCoverageMs: regularFreefall.sampleCoverageMs,
            secondsRemaining: regularFreefall.secondsRemaining,
            regularFreefall: regularFreefallSignals,
          },
          entryPrice: yesPrice,
          kalshiTarget,
          mode,
          insertId: `${sym}:${windowKey}:freefall:${mode}:${persistAt}`,
        }).catch((err) => logger.warn(
          { err, sym, windowKey, mode },
          "[kalshi-bot] freefall guard evidence persist failed",
        ));
      };
      persistSkip("live");
      if (S.config.shadowPaperBets) persistSkip("paper");
      return;
    }
    markPaperLiveIneligible(evidence);
  } else {
    convictionDirectionGuardBlockedMap.delete(sym);
  }

  if (entryMode === "live") {
    // Conviction IOC orders MUST use the authenticated execution book even
    // when the operator's general gateway setting is legacy. A buy limit only
    // caps the worst price; Kalshi may legally improve into cheaper offers.
    // The authenticated quote proves every currently executable contract is
    // inside the conviction band and revalidates that exact book version at
    // the final pre-POST boundary. Without that proof, do not submit.
    const convictionRequiresAuthenticatedBook =
      authorizationDecisionMode === "conviction";
    const useAuthenticatedBook =
      !isFastLane
      && (
        convictionRequiresAuthenticatedBook
        || S.config.liveExecutionGateway === "authenticated_book"
      );
    const authenticatedGatewayZone = S.config.decisionMode === "conviction"
      ? getEffectiveConvictionZone(sym, S.config)
      : { lockPrice: 0, lockPriceCap: 1 };
    const authenticatedBookQuote = useAuthenticatedBook
      ? quoteAuthenticatedBookExecution({
          ticker: expectedTicker,
          side: direction,
          requestedCount: contractCount,
          sideCostFloor: authenticatedGatewayZone.lockPrice,
          sideCostCeiling: authenticatedGatewayZone.lockPriceCap,
        }, dashboard2KalshiOrderbookService)
      : null;
    if (useAuthenticatedBook && !authenticatedBookQuote) {
      const reason = convictionRequiresAuthenticatedBook
        ? "conviction IOC requires a fresh exact authenticated book with every executable level inside the entry band"
        : "authenticated book gateway requires a fresh exact book with full requested depth";
      releaseConvictionEntryReservation(reason);
      setTickAbortReason(sym, windowKey, `gateway abort: ${reason}`);
      regularPlacementFunnel.finalEligibility(ensurePlacementCandidate(), false, Date.now(), reason);
      markPlacementTerminal("definite_error", reason);
      return;
    }
    if (authenticatedBookQuote) {
      const priorZeroFillBookVersion = windowZeroFillBookVersions.get(
        regularZeroFillRetryKey(entryMode, sym, windowKey),
      );
      if (
        authorizationDecisionMode === "conviction"
        && !hasNewAuthenticatedBookVersion(
          priorZeroFillBookVersion,
          authenticatedBookQuote.bookVersion,
        )
      ) {
        const reason = "conviction retry requires a newer authenticated book update after the zero fill";
        releaseConvictionEntryReservation(reason);
        setTickAbortReason(sym, windowKey, `gateway abort: ${reason}`);
        regularPlacementFunnel.finalEligibility(ensurePlacementCandidate(), false, Date.now(), reason);
        markPlacementTerminal("definite_error", reason);
        return;
      }
      logger.info(
        {
          sym,
          windowKey,
          ticker: authenticatedBookQuote.ticker,
          side: authenticatedBookQuote.side,
          requestedCount: authenticatedBookQuote.requestedCount,
          limitPrice: authenticatedBookQuote.limitPrice,
          worstCaseCost: authenticatedBookQuote.worstCaseCost,
          bookVersion: authenticatedBookQuote.bookVersion,
        },
        "[kalshi-bot] authenticated book gateway quoted exact IOC",
      );
    }
    // Persist and submit precisely this cent-grid YES-side limit. Route cash is
    // reserved against the true worst case, not the earlier quote estimate.
    const durableEntryLimitRaw = authenticatedBookQuote?.limitPrice ?? orderLimitPrice ?? computeMarketableLimitPrice(
      direction === "yes" ? "bid" : "ask",
      yesPrice,
      S.config.minReturnMultiple,
    );
    const durableEntryLimitPrice = authenticatedBookQuote
      ? authenticatedBookQuote.limitPrice
      : direction === "yes"
        ? Math.floor(durableEntryLimitRaw * 100) / 100
        : Math.ceil(durableEntryLimitRaw * 100) / 100;
    const worstCaseRouteCost = authenticatedBookQuote?.worstCaseCost ?? computeRegularWorstCaseRouteCost(
      direction,
      durableEntryLimitPrice,
      contractCount,
    );
    // Both route and its funding evidence were prepared by the poller before
    // zone eligibility. Do not issue a balance or market read here: absent
    // exact-shard funding is unsafe and fails closed before the durable claim.
    const preparedExchangeIndex = getPreparedRegularOrderExchangeIndex(expectedTicker);
    const preparedAccount = preparedExchangeIndex == null
      ? null
      : getFreshRegularAccountSnapshotForRoute(preparedExchangeIndex);
    const routeAvailableBalance = preparedExchangeIndex == null || !preparedAccount
      ? null
      : preparedAccount.availableBalanceByExchange.get(preparedExchangeIndex) ?? null;
    if (
      preparedExchangeIndex == null
      || preparedAccount == null
      || routeAvailableBalance == null
      || worstCaseRouteCost == null
      || routeAvailableBalance + 1e-9 < worstCaseRouteCost
    ) {
      const reason = preparedExchangeIndex == null
        ? "prepared exact route unavailable"
        : preparedAccount == null
          ? "fresh aggregate/route account snapshot unavailable"
          : "prepared route shard has insufficient available cash";
      releaseConvictionEntryReservation(reason);
      setTickAbortReason(sym, windowKey, `safety abort: ${reason}`);
      regularPlacementFunnel.finalEligibility(ensurePlacementCandidate(), false, Date.now(), reason);
      markPlacementTerminal("definite_error", reason);
      return;
    }
    regularPlacementFunnel.finalEligibility(ensurePlacementCandidate(), true, Date.now());
    // Persist and submit the exact same YES-side limit. Older fallback paths
    // stored NULL and let placeOrder derive the price internally, which made an
    // uncertain order impossible to match strictly during reconciliation.
    // ── DURABLE INTENT + ATOMIC RESERVATION (Task #667 req #3/#4) ────────────
    // Persist a durable order intent AND atomically claim a per-(mode,symbol,
    // window) reservation BEFORE the live POST so parallel symbol ticks cannot
    // double-enter, and so an indeterminate POST outcome leaves a durable
    // record that blocks re-entry until reconciliation. Live mode ONLY —
    // paper never touches this table (paper behavior stays isolated).
    // (_intentReservationId / _intentClaimed are declared at function scope so
    //  the confirmed-fill resolve after persistBetRecord can reference them.)
    const intentStartedAt = Date.now();
    const zeroFillRetryCooldownMs = regularZeroFillRetryCooldownMs(S.config.decisionMode);
    try {
      const claim = await claimRegularOrderIntent({
        clientOrderId: _intentReservationId,
        mode: "live",
        symbol: sym,
        windowKey,
        ticker: expectedTicker,
        side: direction,
        requestedCount: contractCount,
        limitPrice: durableEntryLimitPrice,
        requestedCost: worstCaseRouteCost,
        // Price-triggered modes intentionally take every eligible market.
        // Durable symbol/window ownership still prevents duplicate exposure,
        // but there is no cross-symbol order-count ceiling.
        maxOrdersPerWindow: isPriceTriggeredMode ? undefined : S.config.maxBetsPerWindow,
        maxTotalExposure: S.config.maxTotalExposure,
        zeroFillRetryCooldownMs,
        maxZeroFillAttempts: regularZeroFillMaxAttempts(authorizationDecisionMode),
        authorizationDecisionMode,
        authorizationConvictionFloor: authorizationConvictionZone?.lockPrice ?? null,
        authorizationConvictionCap: authorizationConvictionZone?.lockPriceCap ?? null,
      });
      if (!claim.claimed) {
        if (claim.reason === "authoritative_zero_fill_cooldown") {
          windowZeroFillRetryAfter.set(
            regularZeroFillRetryKey("live", sym, windowKey),
            Date.now() + zeroFillRetryCooldownMs,
          );
        }
        if (claim.reason === "authoritative_zero_fill_attempt_cap") {
          windowFailedFills.add(`${sym}:${windowKey}:${entryMode}`);
          setTickAbortReason(sym, windowKey, "confirmed zero-fill attempt cap reached — blocked for rest of window");
          regularPlacementFunnel.reservation(ensurePlacementCandidate(), false, Date.now(), claim.reason);
          markPlacementTerminal("intent_denied", claim.reason);
          return;
        }
        regularPlacementFunnel.reservation(ensurePlacementCandidate(), false, Date.now(), claim.reason);
        markPlacementTerminal("intent_denied", claim.reason ?? "durable reservation denied");
        // An unresolved intent already exists for this symbol/window — a prior
        // attempt is in flight or was left UNKNOWN. Never place a second live
        // order; block and retain that reservation until reconciliation.
        releaseConvictionEntryReservation("durable intent claim denied — unresolved prior attempt");
        logger.warn(
          { sym, windowKey, direction, reason: claim.reason },
          "[kalshi-bot] live entry blocked — unresolved durable order intent exists for this symbol/window",
        );
        setTickAbortReason(sym, windowKey,
          "live entry blocked: an unresolved order intent already exists for this symbol/window (awaiting reconciliation)");
        return;
      }
      _intentClaimed = true;
      if (!claimRegularRouteFundingHold(expectedTicker, _intentReservationId, worstCaseRouteCost)) {
        const reason = "prepared route cash already reserved or account snapshot unavailable";
        regularPlacementFunnel.reservation(ensurePlacementCandidate(), false, Date.now(), reason);
        markPlacementTerminal("intent_denied", reason);
        void resolveRegularOrderIntent({
          clientOrderId: _intentReservationId,
          status: "skipped",
          reason,
        }).catch(() => {});
        releaseConvictionEntryReservation(reason);
        logger.warn(
          {
            sym,
            windowKey,
            ticker: expectedTicker,
            worstCaseRouteCost,
            accountSnapshot: getRegularAccountSnapshotDiagnostics(),
          },
          "[kalshi-bot] live entry blocked — exact-route funding hold unavailable",
        );
        setTickAbortReason(sym, windowKey, `safety abort: ${reason}`);
        return;
      }
      _routeFundingHoldClaimed = true;
      regularPlacementFunnel.reservation(ensurePlacementCandidate(), true, Date.now());
      logger.info(
        {
          sym,
          windowKey,
          quoteValidationMs: finalQuoteReadyAt - convictionHotPathStartedAt,
          finalFreefallMs: intentStartedAt - freefallStartedAt,
          intentClaimMs: Date.now() - intentStartedAt,
          hotPathToReservationMs: Date.now() - convictionHotPathStartedAt,
        },
        "[kalshi-bot] conviction entry latency: final checks and atomic reservation complete",
      );
    } catch (claimErr) {
      const claimReason = claimErr instanceof Error ? claimErr.message : "durable intent persist failed";
      regularPlacementFunnel.reservation(ensurePlacementCandidate(), false, Date.now(), claimReason);
      markPlacementTerminal("intent_error", claimReason);
      // Could not persist the durable intent — fail CLOSED. Placing a live order
      // without a durable record would risk an unrecoverable rogue order.
      releaseConvictionEntryReservation("durable intent persist failed");
      logger.error(
        { err: claimErr, sym, windowKey, direction },
        "[kalshi-bot] live entry aborted — durable order intent could not be persisted (fail-closed)",
      );
      setTickAbortReason(sym, windowKey, "live entry aborted: durable order intent could not be persisted");
      return;
    }
    try {
      // ── ENTRY ORDER (IOC for every regular conviction source) ───────────────
      // Kalshi does not support any GTC/resting time-in-force value — both
      // "gtc" and "good_till_cancelled" are rejected with a 400 oneof error.
      //
      // Time-in-force selection (changed 2026-08-15 — the $10 sizing regression):
      //   • Authenticated real-book only: IOC. At 12–18 contracts an
      //     all-or-nothing FOK was rejected with 409 insufficient_resting_volume
      //     even when MOST contracts are available (e.g. 11 of 12).  IOC fills
      //     whatever the book has at our limit and cancels the rest — the
      //     partial-fill correction below tracks the position by ACTUAL fill
      //     count.  The limit price still hard-caps the fill price, so zone
      //     enforcement is unchanged.
      // Regular conviction uses single-attempt mode. A definitive immediate
      // volume rejection becomes a 0-fill and returns to the guarded next-tick
      // lifecycle; this call never emits a second broker request.
      let result: { filledCount: number; avgPrice: number | null; orderId: string | null };

      const entryTimeInForce: "immediate_or_cancel" = "immediate_or_cancel";

      logger.info(
        { sym, direction, windowKey, ticker: expectedTicker, limitPrice: orderLimitPrice, contractCount, timeInForce: entryTimeInForce },
        "[kalshi-bot] conviction entry: placing authenticated-book IOC order",
      );

      const exchangeSubmitStartedAt = Date.now();
      regularPlacementFunnel.submit(ensurePlacementCandidate(), exchangeSubmitStartedAt);
      const fokResult = await placeEntryOrderWithSizeFallback(
        {
          clientOrderId: _intentReservationId,
          ticker: expectedTicker,
          side: direction,
          action: "buy",
          count: contractCount,
          type: "market",
          timeInForce: entryTimeInForce,
          // Use the zone-capped/crossing-buffered limit price when available.
          // Falls back to midpoint mode (yesPrice + minReturnMultiple) only when
          // neither the poller nor the authenticated book supplied a price.
          limitPrice: durableEntryLimitPrice,
          requirePreparedRoute: true,
          // This executes immediately before fetch in the trader. A revoked
          // authorization is a known no-submit outcome, so the existing
          // definite-error catch resolves this durable intent as skipped.
          preSubmitGuard: () => {
            if (!S.config.enabled || S.paused || S.botMode !== "live" || entryMode !== "live") return false;
            const currentQh = resolveEntryQuietHoursDecisionForSymbol(S.config, S.botMode, sym);
            return currentQh.action !== "block"
              && !currentQh.forcedPaper
              && hasAuthorizedRegularRouteFundingHold(expectedTicker, _intentReservationId)
              && (authenticatedBookQuote?.revalidate() ?? true);
          },
        },
        undefined,
        { disableHalfSizeRetry: true },
      );
      const exchangeResponseAt = Date.now();
      regularPlacementFunnel.response(ensurePlacementCandidate(), exchangeResponseAt);
      logger.info(
        {
          sym,
          windowKey,
          exchangePostMs: Date.now() - exchangeSubmitStartedAt,
          hotPathTotalMs: Date.now() - convictionHotPathStartedAt,
          filledCount: fokResult.filledCount,
          timeInForce: entryTimeInForce,
        },
        "[kalshi-bot] conviction entry latency: exchange submission resolved",
      );

      if (fokResult.filledCount === 0) {
        releaseRegularRouteFundingHold(_intentReservationId);
        _routeFundingHoldClaimed = false;
        regularPlacementFunnel.fill(ensurePlacementCandidate(), 0, exchangeResponseAt);
        markPlacementTerminal("zero_fill", "entry order returned zero fills");
        // IOC returned 0 fills — no resting contracts at our exact price.
        // Conviction retries use the proven five-second cadence and must observe
        // a newer authenticated book version before another submission.
        // Capture the original order ownership before releasing anything. This
        // synchronous timestamp closes the gap where another poller dispatch
        // could re-enter before the durable zero-fill update completes.
        const retryKey = regularZeroFillRetryKey(entryMode, sym, windowKey);
        windowZeroFillRetryAfter.set(
          retryKey,
          Date.now() + zeroFillRetryCooldownMs,
        );
        if (authorizationDecisionMode === "conviction" && authenticatedBookQuote) {
          windowZeroFillBookVersions.set(retryKey, authenticatedBookQuote.bookVersion);
        }
        // Preserve the established key format consumed by the window-level
        // failed-fill guards and attempt counter.
        const attemptKey = `${sym}:${windowKey}:${entryMode}`;
        const prev = windowZeroFillAttempts.get(attemptKey) ?? 0;
        const attempts = prev + 1;
        windowZeroFillAttempts.set(attemptKey, attempts);
        // Unknown outcomes remain durably locked. Confirmed zero fills may
        // retry only within this bounded policy.
        const MAX_ZERO_FILL_ATTEMPTS = regularZeroFillMaxAttempts(S.config.decisionMode);
        if (attempts >= MAX_ZERO_FILL_ATTEMPTS) {
          logger.warn(
            { sym, ticker: kalshiTicker, direction, attempts },
            "[kalshi-bot] IOC returned 0 fills after max attempts — blocking for rest of window",
          );
          windowFailedFills.add(attemptKey);
          // Conviction lock intentionally left set — coin is blocked for rest of window.
          setTickAbortReason(sym, windowKey,
            `order returned 0 fills after ${attempts} attempts — book empty at our price; blocked for rest of window`);
        } else {
          logger.warn(
            { sym, ticker: kalshiTicker, direction, attempts, maxAttempts: MAX_ZERO_FILL_ATTEMPTS },
            "[kalshi-bot] IOC returned 0 fills — book empty, will retry next tick",
          );
          // Release conviction lock so the next tick can retry this coin.
          // Without this, the coin stays locked for the whole window after one 0-fill.
          releaseConvictionEntryReservation("entry order returned zero fills; retry allowed");
          setTickAbortReason(sym, windowKey,
            `order returned 0 fills (attempt ${attempts}/${MAX_ZERO_FILL_ATTEMPTS}) — book empty at our price, retrying after ${zeroFillRetryCooldownMs / 1_000}s cooldown`);
        }
        // Confirmed zero fill (dead) — release the durable reservation so the
        // next tick may re-claim. This is a DEFINITE outcome, safe to release.
        void resolveRegularOrderIntent({
          clientOrderId: _intentReservationId,
          status: "zero_fill",
          reason: "entry order returned zero fills",
          filledCount: 0,
        }).catch((e) => logger.warn({ err: e, sym }, "[kalshi-bot] intent zero-fill resolve failed (non-fatal)"));
        return;
      }
      result = fokResult;

      // ── PARTIAL FILL CORRECTION + IOC REMAINDER RE-ATTEMPT ────────────────
      // The IOC entry fills what the book has at our price
      // and cancels the rest.  result.filledCount is the ACTUAL number of
      // contracts filled — can be less than contractCount.
      //
      // Consistency fix (2026-08-15): a partial IOC fill used to be recorded
      // as-is, so an operator-configured $10 bet could land as $4–7 depending
      // on book depth at that instant.  Now, when the real-book IOC path fills
      // only part of the requested size, we immediately re-submit the REMAINDER
      // as ONE more IOC order at the SAME limit price (no price escalation).
      // Books refresh within ~1s as market makers replenish, so a single
      // same-price second shot usually completes the configured amount without
      // hammering the book.  Whatever the second shot fills (including 0) is
      // final — total actual fill is recorded, never retried further.
      //
      // HARD INVARIANT — at most TWO exchange orders per entry:
      //   order #1 = the initial entry submission (or, if it was 409
      //   volume-rejected, the helper's half-size fallback becomes order #2 and
      //   the budget is spent).  decideRemainderAttempt (pure, unit-tested)
      //   detects the fallback via attemptedCount < requestedCount and refuses
      //   the remainder in that case, so a third submission is impossible.
      // Other guards (all inside decideRemainderAttempt):
      //   • poller-fallback remainder remains disabled even though its initial
      //     entry is now IOC; the initial partial fill is recorded immediately.
      //   • remainder measured against attemptedCount (actual submitted size).
      //   • fresh ≥3-min hard floor re-check (same rule as entry dispatch) so
      //     the remainder cannot land dangerously late in the window.
      const allowAdditionalLiveEntrySubmission = false;
      if (allowAdditionalLiveEntrySubmission && fokResult.filledCount > 0 && fokResult.filledCount < contractCount) {
        const requestedCount = contractCount;
        const firstFill      = fokResult.filledCount;
        let totalFilled      = firstFill;

        const _remWkMs    = new Date(windowKey + (windowKey.endsWith("Z") ? "" : ":00Z")).getTime();
        const _remMinLeft = isNaN(_remWkMs) ? 0 : (15 - (Date.now() - _remWkMs) / 60000);

        const remDecision = decideRemainderAttempt({
          usedPollerFallback: false,
          timeInForce: entryTimeInForce,
          requestedCount,
          attemptedCount: fokResult.attemptedCount,
          filledCount: firstFill,
          minutesRemaining: _remMinLeft,
        });
        const remainder = remDecision.remainder;

        if (remDecision.attempt) {
          logger.warn(
            { sym, direction, requested: requestedCount, attempted: fokResult.attemptedCount, filled: firstFill, remainder, limitPrice: orderLimitPrice, minLeft: +_remMinLeft.toFixed(2) },
            "[kalshi-bot] IOC partial fill — re-submitting remainder once at same limit price",
          );
          try {
            // Single-attempt mode: disableHalfSizeRetry guarantees this places
            // exactly ONE exchange order — a volume rejection is final (0 fills),
            // never a second half-size submission.  Total order count per entry
            // is therefore capped at 2 (initial + this remainder).
            const remResult = await placeEntryOrderWithSizeFallback(
              {
                ticker: expectedTicker,
                side: direction,
                action: "buy",
                count: remainder,
                type: "market",
                timeInForce: "immediate_or_cancel",
                ...(orderLimitPrice != null
                  ? { limitPrice: orderLimitPrice }
                  : {
                      yesPrice: yesPrice ?? undefined,
                      minReturnMultiple: S.config.minReturnMultiple,
                    }),
              },
              undefined,
              { disableHalfSizeRetry: true },
            );
            if (remResult.filledCount > 0) {
              totalFilled += remResult.filledCount;
              // Weighted-average the fill price across both shots so P&L math
              // reflects the true blended cost.
              if (result.avgPrice != null && remResult.avgPrice != null) {
                result = {
                  ...result,
                  avgPrice: (result.avgPrice * firstFill + remResult.avgPrice * remResult.filledCount) / totalFilled,
                };
              }
              logger.info(
                { sym, direction, firstFill, remainderFilled: remResult.filledCount, totalFilled, requested: requestedCount },
                "[kalshi-bot] IOC remainder re-attempt filled — recording combined position",
              );
            } else {
              logger.warn(
                { sym, direction, firstFill, remainder, totalFilled },
                "[kalshi-bot] IOC remainder re-attempt returned 0 fills — recording first fill only",
              );
            }
          } catch (remErr) {
            logger.warn(
              { err: remErr, sym, direction, firstFill, remainder },
              "[kalshi-bot] IOC remainder re-attempt failed (non-fatal) — recording first fill only",
            );
          }
        } else {
          logger.warn(
            { sym, direction, requested: requestedCount, attempted: fokResult.attemptedCount, filled: firstFill, skipReason: remDecision.skipReason, minLeft: +_remMinLeft.toFixed(2) },
            "[kalshi-bot] partial fill — no remainder re-attempt; updating contractCount to actual fill",
          );
        }
        contractCount = totalFilled;
      }
      // IOC can fill a fixed-point fraction of the submitted whole-contract
      // request. Every downstream position, exit, and P&L calculation must use
      // the authoritative fill count rather than the requested count.
      contractCount = result.filledCount;

      // ── FILL ACCOUNTING (both GTC and IOC paths) ───────────────────────────
      // Must happen AFTER the branch so both paths feed the same downstream
      // accounting (post-fill zone check, emergency close, position recording).
      //
      // A CONFIRMED fill (filledCount > 0) always carries a validated (0,1)
      // avgPrice from the strict parser — it must NEVER fall back to the cached
      // decision yesPrice (Task #667 req #1). If it is somehow null here the
      // result is indeterminate: treat as UNKNOWN LIVE EXPOSURE, retain the
      // reservation, and halt (do NOT auto-close, do NOT place an opposite order).
      if (result.avgPrice == null) {
        regularPlacementFunnel.fill(ensurePlacementCandidate(), result.filledCount, Date.now());
        markPlacementTerminal("unknown", "confirmed fill returned no average price");
        void markRegularOrderIntentUnknown({
          clientOrderId: _intentReservationId,
          reason: "confirmed fill with missing avg price",
        }).catch(() => {});
        logger.error(
          { sym, direction, windowKey, filled: result.filledCount, orderId: result.orderId },
          "[kalshi-bot] confirmed fill missing avg price — UNKNOWN exposure, retaining reservation and halting (no auto-close)",
        );
        // Retain the conviction reservation (block re-entry). Track the position
        // as open at a NULL-safe price only via reconciliation; here we simply
        // stop to avoid recording a fabricated price.
        setTickAbortReason(sym, windowKey,
          "confirmed fill returned no price — treated as unknown exposure; awaiting reconciliation");
        return;
      }
      fillPrice = result.avgPrice;
      orderId   = result.orderId;

      // Order filled — clear any stale tick-time abort reason from earlier ticks
      // so the dashboard shows the placed bet, not a superseded abort.
      clearTickAbort(tickAbortReasons, sym, windowKey);

      // Audit the authoritative fill, not only the quote that authorized the
      // submission. A BUY limit caps the worst price but Kalshi can legally fill
      // against a cheaper resting offer that appeared after final revalidation.
      // Record that exchange price improvement. The normal flexibility buffer
      // holds every winning-side cost >=70¢ (including above the configured
      // entry cap). Only the rare disaster case below 70¢ is unwound after the
      // fill and its ownership have been durably recorded.
      if (authorizationDecisionMode === "conviction" && result.avgPrice != null && authorizationConvictionZone) {
        const { lockPrice: _lp, lockPriceCap: _lpCap } = authorizationConvictionZone;
        const fillZone = evaluateConvictionFillZone(direction, result.avgPrice, _lp, _lpCap);
        if (
          !fillZone.allowed
          && fillZone.sideCost != null
          && (fillZone.reason === "below_floor" || fillZone.reason === "above_cap")
        ) {
          convictionOutOfBandFill = {
            sideCost: fillZone.sideCost,
            reason: fillZone.reason,
            lockPrice: _lp,
            lockPriceCap: _lpCap,
          };
          logger.error(
            {
              sym, direction, windowKey,
              convFillPrice: +fillZone.sideCost.toFixed(4),
              avgPrice: +result.avgPrice.toFixed(4),
              lockPrice: _lp, lockPriceCap: _lpCap,
              contractCount, ticker: expectedTicker,
            },
            shouldEmergencyExitConvictionFill(fillZone.sideCost)
              ? "[kalshi-bot] conviction fill below 70¢ emergency floor — audit recorded; unwind required"
              : "[kalshi-bot] conviction fill outside entry band but inside hold buffer — audit recorded; position will be held",
          );
        }
      }
      if (
        authorizationDecisionMode === "fastlane"
        && result.avgPrice != null
        && authorizationFastLaneZone
        && authorizationFastLaneEmergencyThresholdCents != null
      ) {
        const { lockPrice: _lp, lockPriceCap: _lpCap } = authorizationFastLaneZone;
        const fillZone = evaluateConvictionFillZone(direction, result.avgPrice, _lp, _lpCap);
        if (
          fillZone.sideCost != null
          && shouldEmergencyExitFastLaneFill(
            fillZone.sideCost,
            _lp,
            authorizationFastLaneEmergencyThresholdCents,
          )
        ) {
          fastLaneEmergencyExit = {
            sideCost: fillZone.sideCost,
            lockPrice: _lp,
            lockPriceCap: _lpCap,
            thresholdCents: authorizationFastLaneEmergencyThresholdCents,
            shortfallCents: +((_lp - fillZone.sideCost) * 100).toFixed(4),
          };
          logger.error(
            {
              sym,
              direction,
              windowKey,
              avgPrice: +result.avgPrice.toFixed(4),
              ...fastLaneEmergencyExit,
              contractCount,
              ticker: expectedTicker,
            },
            "[kalshi-bot] FastLane fill exceeded configured adverse-fill gap — immediate exit required",
          );
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
      const confirmedRouteCost = computeRegularWorstCaseRouteCost(
        direction,
        result.avgPrice,
        result.filledCount,
      ) ?? worstCaseRouteCost;
      const debitCommitted = commitRegularRouteFundingHold(_intentReservationId, confirmedRouteCost);
      if (debitCommitted) {
        _routeFundingHoldClaimed = false;
      } else {
        logger.error(
          { sym, windowKey, confirmedRouteCost, accountSnapshot: getRegularAccountSnapshotDiagnostics() },
          "[kalshi-bot] confirmed fill could not debit prepared account snapshot — retaining route funding hold",
        );
      }
      regularPlacementFunnel.fill(ensurePlacementCandidate(), result.filledCount, Date.now());
      markPlacementTerminal("filled", `confirmed ${result.filledCount} contract fill`);
    } catch (err) {
      regularPlacementFunnel.response(ensurePlacementCandidate(), Date.now());
      // ── UNKNOWN LIVE EXPOSURE (Task #667 req #2/#3/#7) ────────────────────
      // An UncertainOrderError means the broker returned an HTTP-2xx body we
      // could not trust (malformed fill_count/order_id/price, overfill, etc.), OR
      // the response contradicted the submitted order. A transport timeout AFTER
      // the request was sent is equally indeterminate. In BOTH cases contracts
      // may be live. We MUST NOT: treat it as a zero fill, retry it, release the
      // reservation, auto-close, or place an opposite order. Mark the intent
      // UNKNOWN (retain the reservation → blocks re-entry) and halt.
      const uncertain = isUncertainOrderError(err);
      if (uncertain) {
        markPlacementTerminal(
          "unknown",
          `uncertain order outcome: ${(err as { reason?: string }).reason ?? "unknown"}`,
        );
        const coid = (err as { clientOrderId?: string }).clientOrderId ?? null;
        void markRegularOrderIntentUnknown({
          clientOrderId: _intentReservationId,
          reason: `uncertain order outcome: ${(err as { reason?: string }).reason ?? "unknown"}${coid ? ` (client_order_id=${coid})` : ""}`,
        }).catch((e) => logger.warn({ err: e, sym }, "[kalshi-bot] intent unknown-mark failed (non-fatal)"));
        // Retain the conviction reservation & max-bet token — DO NOT release, DO
        // NOT retry. Block the coin for the rest of the window.
        windowFailedFills.add(`${sym}:${windowKey}:${S.botMode}`);
        logger.error(
          { err, sym, windowKey, direction, clientOrderId: coid },
          "[kalshi-bot] order outcome UNKNOWN — possible live exposure; retaining reservation, blocking window, awaiting reconciliation (no retry, no auto-close)",
        );
        setTickAbortReason(sym, windowKey,
          "order outcome uncertain — possible live exposure; blocked pending reconciliation (no retry)");
        return;
      }

      // DEFINITE pre-exposure failure (e.g. transport error establishing the
      // request, auth failure, invalid ticker): no order was accepted, so it is
      // safe to release the durable reservation and allow a retry next tick.
      logger.error({ err, sym }, "[kalshi-bot] order placement failed");
      if (_routeFundingHoldClaimed) {
        releaseRegularRouteFundingHold(_intentReservationId);
        _routeFundingHoldClaimed = false;
      }
      markPlacementTerminal(
        "definite_error",
        err instanceof Error ? err.message : "definite order placement error",
      );
      void resolveRegularOrderIntent({
        clientOrderId: _intentReservationId,
        status: "skipped",
        reason: `order placement failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown error"}`,
      }).catch(() => {});
      // Release conviction lock so the next tick can retry if the error is transient
      // (e.g. network timeout, 429 rate-limit).  Permanent failures (e.g. invalid
      // ticker, account suspended) will keep throwing and the window will expire.
      releaseConvictionEntryReservation("order placement failed");
      setTickAbortReason(sym, windowKey,
        `order placement failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown error"}`);
      return;
    }
  } else {
    // Paper never claims a durable intent or submits an order. It does perform
    // a read-only preview of the remaining live-only predicates so funnel
    // comparisons use executable opportunities rather than all synthetic fills.
    if (paperLiveEligibilityReason == null) {
      const slipInfo = coinSlippageStrikes.get(sym);
      if (checkSlippageStrikeGuard(slipInfo, windowKey)) {
        markPaperLiveIneligible("slippage strike guard would block live entry");
      }
    }
    if (
      paperLiveEligibilityReason == null
      && S.config.decisionMode === "conviction"
      && (S.config.convictionMaxDailySpend ?? 0) > 0
      && S.dailySpendAmount + contractCount * expectedFillCost > S.config.convictionMaxDailySpend!
    ) {
      markPaperLiveIneligible("live daily spend cap would be exceeded");
    }
    if (paperLiveEligibilityReason == null) {
      try {
        const previewBalance = await getCachedKalshiBalance();
        const minBalance = S.config.minAccountBalance ?? 5;
        if (checkBalanceGuard(previewBalance, minBalance)) {
          markPaperLiveIneligible(
            `balance $${previewBalance.toFixed(2)} below $${minBalance.toFixed(2)} minimum`,
          );
        }
      } catch {
        markPaperLiveIneligible("live balance unavailable");
      }
    }
    if (paperLiveEligibilityReason == null) {
      const openExposure = Array.from(openPositions.values())
        .reduce((sum, position) => sum + position.betAmount, 0);
      if (checkExposureGuard(
        openExposure,
        contractCount * expectedFillCost,
        S.config.maxTotalExposure ?? 5,
      )) {
        markPaperLiveIneligible("live exposure cap would be exceeded");
      }
    }
    if (paperLiveEligibilityReason == null) {
      try {
        if (await hasUnresolvedRegularIntent("live", sym, windowKey)) {
          markPaperLiveIneligible("unresolved live intent exists");
        }
      } catch {
        markPaperLiveIneligible("live intent preview unavailable");
      }
    }
    const paperEligible = paperLiveEligibilityReason == null;
    regularPlacementFunnel.finalEligibility(
      ensurePlacementCandidate(),
      paperEligible,
      Date.now(),
      paperLiveEligibilityReason,
    );
    regularPlacementFunnel.paperLiveEligibility(
      ensurePlacementCandidate(),
      paperEligible,
      paperLiveEligibilityReason,
    );
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
    ticker: expectedTicker,
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
  captureSmartExitRegularEntry(newPosition);

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
    regularFreefall: regularFreefallSignals,
    effectiveConfidence: decision.confidence,
    regime: S.regimeCache.get(sym) ?? null,
    trendStability: windowStabilityCache.get(sym) ?? null,
    windowDoubtPenalty: S.currentWindowDoubtPenalty,
    reasoning: decision.reasoning ?? null,
    convictionOutOfBandFill: convictionOutOfBandFill != null,
    convictionOutOfBandFillDetails: convictionOutOfBandFill,
    fastLaneEmergencyExit: fastLaneEmergencyExit != null,
    fastLaneEmergencyExitDetails: fastLaneEmergencyExit,
    // Conviction-stability metrics at entry — null for non-conviction modes.
    stabilityEr:     _stabilitySnap?.er     ?? null,
    stabilityOsc:    _stabilitySnap?.osc    ?? null,
    stabilityVolPct: _stabilitySnap?.volPct ?? null,
    stabilityMlConf: _stabilitySnap?.mlConf ?? null,
    stabilityStable: _stabilitySnap?.stable ?? null,
  };
  // Keep the in-memory position's signals identical to the durable bet row.
  // This lets a failed FastLane emergency exit retry on the very next tick
  // without requiring a process restart and DB rehydration.
  newPosition.entryDecision = {
    ...newPosition.entryDecision,
    signals: enrichedSignals as unknown as SignalSnapshot,
  };

  await persistBetRecord({
    symbol: sym,
    windowKey,
    ticker: expectedTicker,
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
    // Persist the authoritative exchange fill. The decision-time quote remains
    // available in signals.yesPrice for analytics.
    entryYesPrice: actualFillYesPrice,
    // Max-bet flag: true when the stability gate + probability roll upgraded this bet.
    isMaxBet: boostBetSize != null,
  });

  if (entryMode === "paper") {
    regularPlacementFunnel.paperSynthetic(
      ensurePlacementCandidate(),
      Date.now(),
      paperLiveEligibilityReason ?? "paper synthetic fill",
    );
  }

  // Resolve the live intent only AFTER the open position and bet row exist.
  // A crash before this point leaves the intent reserved, which blocks the
  // symbol across later windows rather than risking an untracked duplicate.
  if (entryMode === "live" && _intentClaimed) {
    try {
      await resolveRegularOrderIntent({
        clientOrderId: _intentReservationId,
        status: "filled",
        reason: "confirmed fill persisted locally",
        filledCount: contractCount,
        avgFillPrice: actualFillYesPrice,
        orderId,
      });
    } catch (err) {
      logger.error(
        { err, sym, clientOrderId: _intentReservationId },
        "[kalshi-bot] confirmed fill persisted but intent resolve failed — reservation remains fail-closed",
      );
    }
  }

  if (entryMode === "live" && fastLaneEmergencyExit != null) {
    try {
      await closePosition(
        newPosition,
        actualFillYesPrice,
        kalshiTarget,
        "fastlane_fill_below_configured_floor_threshold",
      );
      openPositions.delete(sym);
      setTickAbortReason(
        sym,
        windowKey,
        `FastLane fill ${(fastLaneEmergencyExit.sideCost * 100).toFixed(0)}¢ was ${fastLaneEmergencyExit.shortfallCents.toFixed(0)}¢ below the configured ${Math.round(fastLaneEmergencyExit.lockPrice * 100)}¢ floor and was sold immediately`,
      );
      logger.error(
        {
          sym,
          direction,
          windowKey,
          ...fastLaneEmergencyExit,
        },
        "[kalshi-bot] FastLane adverse fill sold immediately",
      );
    } catch (closeError) {
      setTickAbortReason(
        sym,
        windowKey,
        "FastLane adverse-fill emergency sell failed; position retained and re-entry blocked",
      );
      logger.error(
        {
          err: closeError,
          sym,
          direction,
          windowKey,
          ...fastLaneEmergencyExit,
        },
        "[kalshi-bot] FastLane emergency sell failed — position remains tracked",
      );
    }
    return;
  }

  if (entryMode === "live" && convictionOutOfBandFill != null) {
    if (shouldEmergencyExitConvictionFill(convictionOutOfBandFill.sideCost)) {
      try {
        await closePosition(
          newPosition,
          actualFillYesPrice,
          kalshiTarget,
          "conviction_fill_below_emergency_floor",
        );
        openPositions.delete(sym);
        setTickAbortReason(
          sym,
          windowKey,
          `actual conviction fill ${(convictionOutOfBandFill.sideCost * 100).toFixed(0)}¢ was below the ${CONVICTION_EMERGENCY_EXIT_FLOOR * 100}¢ emergency floor and was unwound`,
        );
        logger.error(
          {
            sym,
            direction,
            windowKey,
            emergencyFloor: CONVICTION_EMERGENCY_EXIT_FLOOR,
            ...convictionOutOfBandFill,
          },
          "[kalshi-bot] sub-70¢ conviction fill unwound immediately",
        );
      } catch (closeError) {
        setTickAbortReason(
          sym,
          windowKey,
          "sub-70¢ conviction fill could not be unwound; position retained and re-entry blocked",
        );
        logger.error(
          {
            err: closeError,
            sym,
            direction,
            windowKey,
            emergencyFloor: CONVICTION_EMERGENCY_EXIT_FLOOR,
            ...convictionOutOfBandFill,
          },
          "[kalshi-bot] sub-70¢ emergency unwind failed — position remains tracked",
        );
      }
      return;
    }
    logger.warn(
      {
        sym,
        direction,
        windowKey,
        emergencyFloor: CONVICTION_EMERGENCY_EXIT_FLOOR,
        ...convictionOutOfBandFill,
      },
      "[kalshi-bot] out-of-band conviction fill is within the 70¢+ hold buffer — holding position",
    );
  }

  // Shadow paper bet: when live mode is active and shadowPaperBets is enabled,
  // write an identical mode='paper' row so quiet-hours analysis accumulates data
  // from both streams without any additional Kalshi API calls.
  if (S.config.shadowPaperBets && entryMode === "live") {
    const shadowId = `${id}:shadow`;
    // Tag the open position so closePosition can close the mirrored row too.
    const livePos = openPositions.get(sym);
    if (livePos) livePos.shadowPaperId = shadowId;
    // Fire-and-forget — a failure here must never block the live bet's success path.
    persistBetRecord({
      symbol: sym,
      windowKey,
      ticker: expectedTicker,
      direction,
      action: "bet",
      signals: enrichedSignals,
      entryPrice: newPosition.entryYesPrice,
      kalshiTarget,
      contractCount,
      betAmount: actualBetAmount,
      insertId: shadowId,
      cryptoPriceAtEntry,
      decisionMode: S.config.decisionMode ?? "classic",
      mode: "paper",
      entryYesPrice: yesPrice,
      isMaxBet: boostBetSize != null,
    }).catch(err => logger.warn({ err, sym }, "[kalshi-bot] shadow paper bet persist failed (non-fatal)"));
  }

  // Mark this window as having a recorded decision so SKIP dedup works correctly
  lastDecisionWindowKey.set(sym, windowKey);
  // Increment the per-window bet counter so subsequent ticks respect maxBetsPerWindow.
  windowBetCounts.set(windowBetKey, betsThisWindow + 1);
  // Record the randomizer pick as used NOW that the bet is confirmed placed.
  // Must happen here (not at sizing time) so that conviction-mode ticks that are
  // blocked by the live-price / bid-floor gate don't consume slots prematurely.
  if (randomizerPickedForWindow != null) {
    const _rUsed = windowRandomizerUsedValues.get(sym) ?? new Set<number>();
    _rUsed.add(randomizerPickedForWindow);
    windowRandomizerUsedValues.set(sym, _rUsed);
    logger.info(
      { sym, recorded: +randomizerPickedForWindow.toFixed(2), usedThisWindow: [..._rUsed].map(v => +v.toFixed(2)) },
      "[kalshi-bot] bet randomizer: value recorded as used after confirmed fill",
    );
  }
  // Track gross daily spend so convictionMaxDailySpend gate can block future entries.
  // Only live entries consume real capital — paper bypass entries must not affect this counter.
  if (entryMode === "live") {
    S.dailySpendAmount += actualBetAmount;
  }
  // Increment the GLOBAL window total (all symbols combined) for the maxBetsPerWindow cap.
  // Mode-aware: paper and live each have their own counter (effectiveMode matches entryMode here).
  const totalKey = `${windowKey}:${effectiveMode}`;
  windowTotalBets.set(totalKey, (windowTotalBets.get(totalKey) ?? 0) + 1);
  // Store bet details so the eval panel can display actual direction + confidence
  // even after the coin switches to "directional cap reached" on later ticks.
  windowBetDetails.set(windowBetKey, { direction, confidence: decision.confidence });

  logger.info({ sym, direction, fillPrice, contractCount, betsThisWindow: betsThisWindow + 1 }, "[kalshi-bot] bet placed");
}

