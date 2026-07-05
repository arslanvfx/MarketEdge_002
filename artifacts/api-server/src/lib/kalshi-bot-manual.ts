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
import { closePosition, persistBetRecord, BetRecordArgs } from "./kalshi-bot-close";

// ---------------------------------------------------------------------------
// Manual order — triggered by the dashboard "Place Order" button
// ---------------------------------------------------------------------------

export interface ManualOrderResult {
  filled: boolean;
  fillPrice: number;
  contractCount: number;
  betAmount: number;
  pnlProjected: number;
  ticker: string;
}

export async function placeManualOrder(opts: {
  symbol: string;
  direction: "yes" | "no";
  betSize?: number;
  mode?: BotMode;
}): Promise<ManualOrderResult> {
  const sym = opts.symbol.toUpperCase();
  const direction = opts.direction;
  const targetMode: BotMode = opts.mode ?? S.botMode;
  const targetBetSize = opts.betSize ?? S.config.betSize;

  // Guard: bet size cap
  const maxBetCap = S.config.maxBetSize ?? 2;
  if (targetBetSize > maxBetCap + 0.01) {
    throw new Error(`betSize $${targetBetSize.toFixed(2)} exceeds maxBetSize $${maxBetCap.toFixed(2)}`);
  }

  // Guard: position already open for this coin
  if (checkDuplicatePositionGuard(openPositions.has(sym))) {
    throw new Error(`Position already open for ${sym} — close it before placing a new order`);
  }

  // Get live Kalshi bid/ask from the shared 5s cache (same data source as bot)
  const cachedKalshi = getKalshiCachedData(sym);
  const kalshiTicker = cachedKalshi?.ticker ?? null;
  const kalshiTarget = cachedKalshi?.value ?? null;
  const yesAsk = cachedKalshi?.yesAsk ?? null;
  const yesBid = cachedKalshi?.yesBid ?? null;
  const yesPrice = cachedKalshi?.yesPrice ?? null;

  if (!kalshiTicker) {
    throw new Error(`No active Kalshi market found for ${sym} — try again in a few seconds`);
  }
  if (kalshiTarget == null) {
    throw new Error(`Kalshi strike price not available for ${sym}`);
  }

  // Compute fill price and cost per contract (mirrors bot Phase-3 logic)
  const liveLimitPrice: number | null =
    direction === "yes"
      ? (yesAsk != null && yesAsk > 0 ? yesAsk : null)
      : (yesBid != null && yesBid > 0 ? yesBid : null);

  const expectedFillCost: number =
    direction === "yes"
      ? (liveLimitPrice ?? computeMarketableLimitPrice("bid", yesPrice, S.config.minReturnMultiple))
      : (yesBid != null && yesBid > 0
          ? (1 - yesBid)
          : (1 - (yesPrice ?? 0.5)));

  // Crossing buffer — same 3-cent spread-crossing buffer as the bot path.
  const _manualReturnFloor = S.config.minReturnMultiple ?? 1.45;
  const _manualMaxCost = 1 / _manualReturnFloor;
  const orderLimitPrice: number | null = (() => {
    const CROSSING_BUFFER = 0.03;
    if (direction === "yes") {
      if (yesAsk == null || yesAsk <= 0) return null;
      return Math.floor(Math.min(yesAsk + CROSSING_BUFFER, _manualMaxCost) * 100) / 100;
    } else {
      if (yesBid == null || yesBid <= 0) return null;
      return Math.ceil(Math.max(yesBid - CROSSING_BUFFER, 1 - _manualMaxCost) * 100) / 100;
    }
  })();

  // Return floor guard — mirrors the bot entry path gate. Manual orders must
  // also respect the 1.45x floor so the user can't accidentally buy a contract
  // that would need to win to barely break even.
  {
    const minReturnFloor = S.config.minReturnMultiple ?? 1.45;
    const maxAllowedCost = 1 / minReturnFloor;
    if (expectedFillCost > maxAllowedCost) {
      throw new Error(
        `Fill cost ${(expectedFillCost * 100).toFixed(0)}¢ implies a ${(1 / expectedFillCost).toFixed(3)}× return — below the ${minReturnFloor}× floor. ` +
        `For YES bets, price must be ≤${Math.floor(maxAllowedCost * 100)}¢; for NO bets, YES price must be ≥${Math.ceil((1 - maxAllowedCost) * 100)}¢.`,
      );
    }
  }

  const contractCount = Math.floor(targetBetSize / expectedFillCost);
  if (contractCount < 1) {
    throw new Error(
      `Budget $${targetBetSize.toFixed(2)} cannot buy 1 contract — current cost is $${expectedFillCost.toFixed(2)}/contract`,
    );
  }

  // Guard: live mode prerequisites
  if (targetMode === "live") {
    if (!S.config.enabled) {
      throw new Error("Bot is currently disabled — enable it before placing live orders");
    }
    if (!isKalshiConfigured()) {
      throw new Error("Kalshi is not configured — add API credentials before placing live orders");
    }
    // Always fetch a fresh balance rather than relying on the nullable in-memory value
    const bal = await getCachedKalshiBalance();
    const minBal = S.config.minAccountBalance ?? 5;
    if (bal == null) {
      throw new Error("Unable to verify account balance — please try again in a few seconds");
    }
    if (bal < minBal) {
      throw new Error(`Account balance $${bal.toFixed(2)} is below the minimum $${minBal.toFixed(2)} — top up before betting`);
    }
  }

  const windowKey = currentWindowKey();
  let fillPrice: number;
  let orderId: string | null = null;

  if (targetMode === "live") {
    const result = await placeOrderWithRetry(
      {
        ticker: kalshiTicker,
        side: direction,
        action: "buy",
        count: contractCount,
        type: "market",
        ...(orderLimitPrice != null
          ? { limitPrice: orderLimitPrice }
          : {
              yesPrice: yesPrice ?? undefined,
              minReturnMultiple: S.config.minReturnMultiple,
            }),
      },
    );
    if (result.filledCount === 0) {
      throw new Error("IOC order returned 0 fills — the book may be empty right now");
    }
    fillPrice = result.avgPrice ?? yesAsk ?? yesPrice ?? 0.5;
    orderId = result.orderId;
    invalidateBalanceCache();
  } else {
    // Paper: simulate fill at live ask/bid (or midpoint as fallback)
    fillPrice = direction === "yes"
      ? (yesAsk ?? yesPrice ?? 0.5)
      : (yesBid ?? yesPrice ?? 0.5);
  }

  const actualFillYesPrice = fillPrice;
  const actualBetAmount = direction === "yes"
    ? contractCount * actualFillYesPrice
    : contractCount * (1 - actualFillYesPrice);

  const id = `manual:${sym}:${windowKey}:${Date.now()}`;
  const cryptoPriceAtEntry = getCachedPrediction(sym)?.price ?? null;

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
    exitState: makeInitialExitState(actualFillYesPrice),
    entryDecision: {
      action: direction === "yes" ? "BET_YES" : "BET_NO",
      confidence: 0,
      reasoning: "manual order placed via dashboard",
      signals: {} as unknown as import("./kalshi-bot-engine").SignalSnapshot,
    },
    phase2Activated: false,
    entryMode: targetMode,
    source: "manual",
  };
  openPositions.set(sym, newPosition);

  await persistBetRecord({
    symbol: sym,
    windowKey,
    ticker: kalshiTicker,
    direction,
    action: "bet",
    signals: { manual: true, orderId: orderId ?? undefined },
    entryPrice: actualFillYesPrice,
    kalshiTarget,
    contractCount,
    betAmount: actualBetAmount,
    insertId: id,
    cryptoPriceAtEntry,
    decisionMode: S.config.decisionMode ?? "classic",
    mode: targetMode,
    source: "manual",
  });

  logger.info({ sym, direction, fillPrice, contractCount, targetMode, manual: true }, "[kalshi-bot] manual order placed");

  // Projected payout on win: YES win = (1 − entryPrice) × n; NO win = entryPrice × n
  const pnlProjected = direction === "yes"
    ? contractCount * (1 - actualFillYesPrice)
    : contractCount * actualFillYesPrice;

  return {
    filled: true,
    fillPrice: actualFillYesPrice,
    contractCount,
    betAmount: actualBetAmount,
    pnlProjected,
    ticker: kalshiTicker,
  };
}

// ---------------------------------------------------------------------------
// Close manual position (public API)
// ---------------------------------------------------------------------------

export async function closeManualPosition(symbol: string): Promise<{ pnl: number | null }> {
  const sym = symbol.toUpperCase();
  const pos = openPositions.get(sym);
  checkManualPositionExistsGuard(pos, sym);
  checkManualSourceGuard(pos!.source ?? "", sym);

  const cachedKalshi = getKalshiCachedData(sym);
  const currentYesPrice = cachedKalshi?.yesPrice ?? null;
  const currentKalshiTarget = cachedKalshi?.value ?? null;

  await closePosition(pos!, currentYesPrice, currentKalshiTarget, "manual_close");
  openPositions.delete(sym);

  // Compute final P&L to return to caller. Mirrors mid-window exit formula.
  let pnl: number | null = null;
  if (currentYesPrice != null) {
    const priceDelta = pos!.direction === "yes"
      ? currentYesPrice - pos!.entryYesPrice
      : pos!.entryYesPrice - currentYesPrice;
    pnl = priceDelta * pos!.contractCount;
  }

  logger.info({ sym, pnl }, "[kalshi-bot] manual position closed via dashboard");
  return { pnl };
}

// ---------------------------------------------------------------------------
// Close position helper
// ---------------------------------------------------------------------------

