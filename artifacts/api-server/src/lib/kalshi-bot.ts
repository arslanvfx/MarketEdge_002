// ---------------------------------------------------------------------------
// kalshi-bot.ts — public API barrel
// Core public state getters/setters live here; all heavy logic is in sub-modules.
// ---------------------------------------------------------------------------

import { logger } from "./logger";
import { isKalshiConfigured, getCachedKalshiBalance } from "./kalshi-trader";
import { syncConvictionPoller, getPollerStats } from "./kalshi-conviction-poller";
import {
  DEFAULT_BOT_CONFIG, isInQuietHours, assertSetBotModeAllowed,
  resolveQuietHoursV2State, resolveEntryQuietHoursDecisionForSymbol,
  type BotConfig,
} from "./kalshi-bot-engine";
import {
  getKalshiCachedData, getKalshiWindowContext,
  CRYPTO_COINS, KALSHI_SERIES,
} from "./crypto";
import {
  S, openPositions, lastGuardStatesMap, lastGuardReasonMap,
  activeCoinStreakState, WINDOW_ENTRY_BUFFER_S, getEffectiveDailyLossLimit,
  type BotMode, type BotStatus, type OpenPositionDisplay, type BotStateSnapshot,
  type SymbolSmartHoursMode,
} from "./kalshi-bot-state";
import {
  _persistModeToConfig, loadDailyPnlFromDB, loadCoinDailyLossFromDB,
  loadCoinStreakStateFromDB, loadPaperBalanceFromDB, runQuietHoursAutoTune, recomputeAllSymbolQuietHours,
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
  getConvictionThresholdAnalysis,
  getConvictionStabilityAnalysis,
  getBotGapAnalytics,
} from "./kalshi-bot-analytics";
export type { GapBandRow, GapAnalyticsResult } from "./kalshi-bot-analytics";
export type {
  TrendPoint,
  CoinBotStats,
  LogicModeStats,
  BacktestModeStats,
  ConvictionPriceBand,
  StabilityThresholdRow,
  StabilityDimensionAnalysis,
  ConvictionStabilityAnalysis,
} from "./kalshi-bot-analytics";

// ---------------------------------------------------------------------------
// Re-exports from sub-modules (preserves existing import paths for callers)
// ---------------------------------------------------------------------------
export type { BotMode, BotStatus, OpenPosition, OpenPositionDisplay, BotStateSnapshot, WindowCoinEvaluation, ParoleState } from "./kalshi-bot-state";
export {
  loadBotConfigFromDB, loadDailyPnlFromDB, loadCoinDailyLossFromDB,
  loadCoinStreakStateFromDB, loadOpenPositionFromDB, loadPaperBalanceFromDB,
  loadWindowBetCountsFromDB, fixLiveExpiredPnlHistorical, clearBetHistoryOld,
  updateBotConfig, runQuietHoursAutoTune, recomputeAllSymbolQuietHours,
} from "./kalshi-bot-db";
export {
  runSmartHoursCalibration,
  ensureSmartHoursCalibrationCurrent,
  runSmartHoursCalibrationCatchUpIfNeeded,
} from "./kalshi-smart-hours-calibration";
export { runBotLoopTick, runWindowOpenPrefetch } from "./kalshi-bot-loop";
export {
  runBotTickForCoin,
  finalizeReconciledFastLaneExit,
} from "./kalshi-bot-tick";
export { placeManualOrder, closeManualPosition, type ManualOrderResult } from "./kalshi-bot-manual";
export { evalShadowBets } from "./kalshi-bot-shadow";
export { evalClosedBets, reEvaluateSettledBets, fixCommodityOutcomes } from "./kalshi-bot-eval";
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
    : S.dailyPnl <= -getEffectiveDailyLossLimit()
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

  const now = new Date();
  const smartHoursScope: "global" | "per_market" = S.config.quietHoursMode === "per_market" ? "per_market" : "global";

  // Resolve per-symbol Smart Hours modes using the canonical server resolver.
  // This ensures the header/status UI can never disagree with the enforcement logic.
  const symbolSmartHoursModes: Record<string, SymbolSmartHoursMode> = {};
  const masterEnabled = S.config.quietHoursV2?.enabled === true;
  for (const coin of CRYPTO_COINS.filter((c) => KALSHI_SERIES[c.symbol])) {
    const sym = coin.symbol;
    if (!masterEnabled) {
      // Master switch is OFF (or absent): all symbols proceed active.
      symbolSmartHoursModes[sym] = "active";
      continue;
    }
    if (smartHoursScope === "per_market") {
      const symSchedule = S.config.perSymbolQuietHours?.[sym];
      if (!symSchedule?.enabled) {
        symbolSmartHoursModes[sym] = "no-schedule";
        continue;
      }
      const decision = resolveEntryQuietHoursDecisionForSymbol(S.config, S.botMode, sym, now);
      if (decision.action === "block" || decision.qhMode === "silenced") {
        symbolSmartHoursModes[sym] = "silenced";
      } else if (decision.qhMode === "reduced") {
        symbolSmartHoursModes[sym] = "reduced";
      } else {
        symbolSmartHoursModes[sym] = "active";
      }
    } else {
      // Global mode: all symbols share the same state.
      const st = resolveQuietHoursV2State(S.config.quietHoursV2, now);
      if (st.mode === "silenced") {
        symbolSmartHoursModes[sym] = "silenced";
      } else if (st.mode === "reduced") {
        symbolSmartHoursModes[sym] = "reduced";
      } else {
        symbolSmartHoursModes[sym] = "active";
      }
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
    dailySpendAmount: S.dailySpendAmount,
    dailyDate: S.dailyDate,
    accountBalance: S.accountBalance,
    lastUpdatedAt: now.toISOString(),
    configured: isKalshiConfigured(),
    warmupSecondsRemaining,
    circuitBreakerWindowsRemaining: S.cbState.circuitBreakerWindowsRemaining,
    consecutiveLosses: S.cbState.consecutiveLosses,
    isInQuietHours: isInQuietHours(now.getUTCHours(), S.config.quietHoursStart, S.config.quietHoursEnd),
    quietHoursV2State: resolveQuietHoursV2State(S.config.quietHoursV2, now),
    autoTuneQHLastRunAt: S.autoTuneQHLastRunAt,
    autoTuneQHLastChanges: S.autoTuneQHLastChanges,
    dbDegraded: S.dbDegradedSince !== null,
    dbDegradedSince: S.dbDegradedSince?.toISOString() ?? null,
    isProductionEnv: process.env.NODE_ENV === "production",
    coinStreakState: Object.fromEntries(activeCoinStreakState()),
    convictionPollerRunning: getPollerStats().running,
    convictionPriceAgeMs: getPollerStats().priceAgeMs,
    smartHoursScope,
    symbolSmartHoursModes,
    symbolSmartHoursResolvedAt: now.toISOString(),
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
  // Sync conviction poller after decisionMode is restored.  Without this, a
  // mode switch from live→paper (or vice-versa) where the target mode has
  // decisionMode="conviction" would run conviction zone-trigger checks against
  // the 2 s shared cache instead of the 1 s poller price.
  syncConvictionPoller();

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
  syncConvictionPoller();
}

