// ---------------------------------------------------------------------------
// kalshi-bot.ts — public API barrel
// Core public state getters/setters live here; all heavy logic is in sub-modules.
// ---------------------------------------------------------------------------

import { logger } from "./logger";
import { isKalshiConfigured, getCachedKalshiBalance } from "./kalshi-trader";
import {
  DEFAULT_BOT_CONFIG, isInQuietHours, assertSetBotModeAllowed,
  type BotConfig,
} from "./kalshi-bot-engine";
import {
  getKalshiCachedData, getKalshiWindowContext,
  CRYPTO_COINS, KALSHI_SERIES,
} from "./crypto";
import {
  S, openPositions, lastGuardStatesMap, lastGuardReasonMap,
  activeCoinStreakState, WINDOW_ENTRY_BUFFER_S,
  type BotMode, type BotStatus, type OpenPositionDisplay, type BotStateSnapshot,
} from "./kalshi-bot-state";
import {
  _persistModeToConfig, loadDailyPnlFromDB, loadCoinDailyLossFromDB,
  loadCoinStreakStateFromDB, loadPaperBalanceFromDB,
} from "./kalshi-bot-db";

// ---------------------------------------------------------------------------
// Re-exports from kalshi-bot-analytics (unchanged)
// ---------------------------------------------------------------------------
export {
  getBotHistory,
  getBotTrend,
  getBotAllHistory,
  getBotStats,
  getBotAutoTuneLog,
  getBotLogicPerformance,
  getBacktestModes,
  backtestModeApproval,
} from "./kalshi-bot-analytics";
export type {
  TrendPoint,
  CoinBotStats,
  LogicModeStats,
  BacktestModeStats,
} from "./kalshi-bot-analytics";

// ---------------------------------------------------------------------------
// Re-exports from sub-modules (preserves existing import paths for callers)
// ---------------------------------------------------------------------------
export type { BotMode, BotStatus, OpenPosition, OpenPositionDisplay, BotStateSnapshot, WindowCoinEvaluation, ParoleState } from "./kalshi-bot-state";
export {
  loadBotConfigFromDB, loadDailyPnlFromDB, loadCoinDailyLossFromDB,
  loadCoinStreakStateFromDB, loadOpenPositionFromDB, loadPaperBalanceFromDB,
  loadWindowBetCountsFromDB, fixLiveExpiredPnlHistorical, clearBetHistoryOld,
  updateBotConfig,
} from "./kalshi-bot-db";
export { runBotLoopTick, runWindowOpenPrefetch } from "./kalshi-bot-loop";
export { runBotTickForCoin } from "./kalshi-bot-tick";
export { placeManualOrder, closeManualPosition, type ManualOrderResult } from "./kalshi-bot-manual";
export { evalShadowBets } from "./kalshi-bot-shadow";
export { evalClosedBets, reEvaluateSettledBets } from "./kalshi-bot-eval";
export {
  getWindowEvaluation, getPerformanceReport, getPausedCoinState,
  getCoinGuardState, clearAllPauses, getWindowConditions, resetWindowConditions,
  runAutoTuneJob, type CoinGuardEntry, type BotConditionsSnapshot,
} from "./kalshi-bot-conditions";

// ---------------------------------------------------------------------------
// Public state getters / setters
// ---------------------------------------------------------------------------

export function isDbDegraded(): boolean {
  return S.dbDegradedSince !== null;
}

export function getBotState(): BotStateSnapshot {
  const modePositionCount = Array.from(openPositions.values()).filter(
    (pos) => pos.entryMode === S.botMode,
  ).length;
  const status: BotStatus = S.paused
    ? "paused"
    : S.dailyPnl <= -S.config.dailyLossLimit
    ? "daily_limit_hit"
    : modePositionCount > 0
    ? "position_open"
    : "idle";

  const openPositionsList: OpenPositionDisplay[] = Array.from(openPositions.values())
    .filter((pos) => pos.entryMode === S.botMode)
    .map((pos) => {
      const liveKalshi = getKalshiCachedData(pos.symbol);
      let currentYesPrice: number | null = null;
      let unrealizedPnl: number | null = null;
      if (liveKalshi?.yesPrice != null) {
        currentYesPrice = liveKalshi.yesPrice;
        const priceDelta = pos.direction === "yes"
          ? liveKalshi.yesPrice - pos.entryYesPrice
          : pos.entryYesPrice - liveKalshi.yesPrice;
        unrealizedPnl = priceDelta * pos.contractCount;
      }
      return {
        ...pos,
        exitState: pos.exitState,
        currentYesPrice,
        unrealizedPnl,
        guardStates: lastGuardStatesMap.get(pos.symbol) ?? null,
        guardReason: lastGuardReasonMap.get(pos.symbol) ?? null,
      };
    });

  let warmupSecondsRemaining: number | null = null;
  if (!S.paused) {
    const firstKalshiCoin = CRYPTO_COINS.find((c) => KALSHI_SERIES[c.symbol]);
    if (firstKalshiCoin) {
      const winCtx = getKalshiWindowContext(firstKalshiCoin.symbol);
      const secondsIntoWindow = winCtx?.secondsElapsed ?? 0;
      const remaining = Math.max(0, WINDOW_ENTRY_BUFFER_S - secondsIntoWindow);
      if (remaining > 0) warmupSecondsRemaining = remaining;
    }
  }

  return {
    mode: S.botMode,
    status,
    paused: S.paused,
    config: { ...S.config },
    openPositions: openPositionsList,
    dailyPnl: S.dailyPnl,
    dailyLossCount: S.dailyLossCount,
    dailyDate: S.dailyDate,
    accountBalance: S.accountBalance,
    lastUpdatedAt: new Date().toISOString(),
    configured: isKalshiConfigured(),
    warmupSecondsRemaining,
    circuitBreakerWindowsRemaining: S.cbState.circuitBreakerWindowsRemaining,
    consecutiveLosses: S.cbState.consecutiveLosses,
    isInQuietHours: isInQuietHours(new Date().getUTCHours(), S.config.quietHoursStart, S.config.quietHoursEnd),
    dbDegraded: S.dbDegradedSince !== null,
    dbDegradedSince: S.dbDegradedSince?.toISOString() ?? null,
    isProductionEnv: process.env.NODE_ENV === "production",
    coinStreakState: Object.fromEntries(activeCoinStreakState()),
  };
}

export function setBotMode(mode: BotMode): void {
  assertSetBotModeAllowed(mode, process.env.NODE_ENV, isKalshiConfigured());
  S.botMode = mode;
  logger.info({ mode }, "[kalshi-bot] mode changed");

  const savedDecisionMode = mode === "paper" ? S.config.paperDecisionMode : S.config.liveDecisionMode;
  if (savedDecisionMode) {
    S.config = { ...S.config, decisionMode: savedDecisionMode };
    logger.info({ mode, decisionMode: savedDecisionMode }, "[kalshi-bot] restored per-mode decisionMode");
  }

  _persistModeToConfig().catch(() => {});
  loadDailyPnlFromDB().catch(() => {});
  loadCoinDailyLossFromDB().catch(() => {});
  loadCoinStreakStateFromDB().catch(() => {});
  if (mode === "live" && isKalshiConfigured()) {
    getCachedKalshiBalance()
      .then(bal => { S.accountBalance = bal; })
      .catch(() => {});
  }
}

export function setBotPaused(p: boolean): void {
  S.paused = p;
  logger.info({ paused: S.paused }, "[kalshi-bot] paused changed");
}

