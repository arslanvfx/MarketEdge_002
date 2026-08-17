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
  resolveQuietHoursV2State,
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
  liveCoinStreakState, coinSlippageStrikes, recentWindowOutcomes, recentUnanimousOutcomes, windowCBBuffer,
  cachedPerformanceReportByMode, recentKalshiTargets, windowStabilityCache,
  paperStreakStore, liveStreakStore, makeStreakStore, streakStoreForMode,
  activeCoinDailyLoss, coinDailyLossForMode, activeCoinStreakState,
  coinStreakStateForMode, todayUTC, probeDb, resetDailyIfNeeded,
  REGIME_AGAINST_PENALTY_FALLBACK, CONTRARIAN_LIVE_REGIME_PENALTY,
  NOISE_CONFIDENCE_FLOOR, MIN_HARD_MODEL_SIGNALS, DB_DEGRADED_THRESHOLD,
  DB_DEGRADED_MIN_WINDOW_MS, REGIME_STRIKES_MAX, WINDOW_ENTRY_BUFFER_S,
  STABILITY_WAIT_MAX_S, COIN_YES_BLOCKED, COIN_FULLY_BLOCKED, TIMING_CACHE_TTL,
  getEffectiveDailyLossLimit, tickAbortReasons,
  type BotMode, type BotStatus, type OpenPosition, type OpenPositionDisplay,
  type BotStateSnapshot, type WindowCoinEvaluation, type ParoleState,
} from "./kalshi-bot-state";
import { updateBotConfig } from "./kalshi-bot-db";
import { overlayTickAbortReasons } from "./kalshi-bot-eval-overlay";

// ---------------------------------------------------------------------------
// Window evaluation accessor (for the bot dashboard)
// ---------------------------------------------------------------------------

export function getWindowEvaluation(): WindowCoinEvaluation[] {
  // Overlay tick-time abort reasons (set by _runBotTick when a conviction gate
  // fires AFTER the Phase-3 loop dispatched the coin).  The loop-level reason
  // (e.g. "price in zone — monitoring") is stale the moment a tick-time gate
  // aborts the order — the abort reason is both newer and more specific, so it
  // wins whenever the map has an entry for this coin+window.
  return overlayTickAbortReasons(S.lastWindowEvaluation, tickAbortReasons) as WindowCoinEvaluation[];
}

// ---------------------------------------------------------------------------
// Performance report & auto-tune job
// ---------------------------------------------------------------------------

export function getPerformanceReport(mode?: BotMode): PerformanceReport | null {
  const key = mode ?? S.botMode;
  return cachedPerformanceReportByMode.get(key) ?? null;
}

export function getPausedCoinState(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [sym, rem] of pausedCoins.entries()) out[sym] = rem;
  return out;
}

export interface CoinGuardEntry {
  symbol: string;
  dailyLoss: number;
  consecutiveLosses: number;
  pauseUntilWindowKey: string | null;
  slippageStrikes: number;
}

/** Returns per-coin guard state for display in the bot dashboard. */
export function getCoinGuardState(mode?: BotMode): {
  coins: CoinGuardEntry[];
  maxDailyLossPerCoin: number;
} {
  const nowMs = Date.now();
  const currentWK = new Date(Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000)).toISOString().slice(0, 16);
  const resolvedMode = mode ?? S.botMode;
  const activeStreak = coinStreakStateForMode(resolvedMode);
  const activeLoss = coinDailyLossForMode(resolvedMode);
  const coins: CoinGuardEntry[] = CRYPTO_COINS.map((c) => {
    const sym = c.symbol;
    const dailyLoss = activeLoss.get(sym) ?? 0;
    const streak = activeStreak.get(sym) ?? { consecutiveLosses: 0, pauseUntilWindowKey: null };
    const slip = coinSlippageStrikes.get(sym);
    const slippageStrikes = slip && slip.windowKey === currentWK ? slip.strikes : 0;
    return {
      symbol: sym,
      dailyLoss,
      consecutiveLosses: streak.consecutiveLosses,
      pauseUntilWindowKey: streak.pauseUntilWindowKey,
      slippageStrikes,
    };
  });

  return { coins, maxDailyLossPerCoin: S.config.maxDailyLossPerCoin };
}

/** Clear all per-coin auto-tune pauses and reset the circuit-breaker countdown.
 *  Also clears all coinStreak pauseUntilWindowKey entries (the streak-based
 *  per-coin blocks shown in the "Blocked coins" banner).
 *  Does NOT change bot mode, S.config, or position state. */
export function clearAllPauses(): { clearedCoins: string[]; cbWasActive: boolean } {
  const clearedCoins = [...pausedCoins.keys()];
  pausedCoins.clear();
  const cbWasActive = S.cbState.circuitBreakerWindowsRemaining > 0;
  S.cbState = { ...S.cbState, circuitBreakerWindowsRemaining: 0 };

  // Clear streak-based pauses (pauseUntilWindowKey) from BOTH mode streak maps
  // so that a reset is total — paper and live are independent stores and the
  // bot may have been running in a different mode when pauses were recorded.
  const streakCleared: string[] = [];
  for (const [streakMap, store] of [
    [paperCoinStreakState, paperStreakStore],
    [liveCoinStreakState,  liveStreakStore],
  ] as const) {
    for (const [sym, entry] of streakMap.entries()) {
      if (entry.pauseUntilWindowKey !== null) {
        streakMap.set(sym, { ...entry, pauseUntilWindowKey: null, consecutiveLosses: 0 });
        streakCleared.push(sym);
      }
    }
    // Persist each map so the cleared state survives a republish / restart.
    persistCoinStreakState(streakMap, store).catch(() => {});
  }

  logger.info(
    { clearedCoins, streakCleared, cbWasActive },
    "[kalshi-bot] all pauses cleared manually (both paper + live modes)",
  );
  return { clearedCoins: [...clearedCoins, ...streakCleared], cbWasActive };
}

export interface BotConditionsSnapshot {
  windowKey: string;
  mode: BotMode;
  freeRunMode: boolean;
  // Global gates
  botEnabled: boolean;
  botPaused: boolean;
  isInQuietHours: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  quietHoursV2State: { mode: "active" | "silenced" | "reduced"; reducedBetAmount?: number; utcHour: number };
  circuitBreakerActive: boolean;
  circuitBreakerWindowsRemaining: number;
  dailyLimitHit: boolean;
  dailyPnl: number;
  dailyLossLimit: number;
  dbDegraded: boolean;
  doubtPenaltyPp: number;
  unanimousFailurePenaltyPp: number;
  warmupSecondsRemaining: number;
  // Betting caps
  directionCapEnabled: boolean;
  maxSameDirectionBets: number;
  directionCountYes: number;
  directionCountNo: number;
  maxBetsPerWindow: number;
  totalBetsThisWindow: number;
  // Per-coin window-level restrictions
  emptyBookBlockedCoins: string[];       // blocked after 2 consecutive 0-fill IOC attempts
  emptyBookAttempts: Record<string, number>; // first 0-fill only — will retry next tick
  nearStrikeFilteredCoins: string[];     // coins filtered by the near-strike EV gate this window
  // Static coin filters (permanent until code changes)
  yesBlockedCoins: string[];
  fullyBlockedCoins: string[];
  // Auto-tune + streak pauses
  autoTunePausedCoins: Record<string, number>; // sym -> windows remaining
}

/** Returns a snapshot of every active restriction and condition in the bot. */
export function getWindowConditions(): BotConditionsSnapshot {
  const wk = currentWindowKey();

  const firstKalshiCoin = CRYPTO_COINS.find((c) => KALSHI_SERIES[c.symbol]);
  const winCtx = firstKalshiCoin ? getKalshiWindowContext(firstKalshiCoin.symbol) : null;
  const secondsIntoWindow = winCtx?.secondsElapsed ?? 0;
  const warmupSecondsRemaining = Math.max(0, WINDOW_ENTRY_BUFFER_S - secondsIntoWindow);

  const dirYes = windowDirectionCounts.get("yes") ?? 0;
  const dirNo = windowDirectionCounts.get("no") ?? 0;

  // Parse "sym:windowKey:mode" keys from the window-level sets
  const emptyBookBlockedCoins: string[] = [];
  for (const key of windowFailedFills) {
    const sym = key.split(":")[0];
    if (sym) emptyBookBlockedCoins.push(sym);
  }

  const emptyBookAttempts: Record<string, number> = {};
  for (const [key, count] of windowZeroFillAttempts) {
    if (windowFailedFills.has(key)) continue; // already in blocked list
    const sym = key.split(":")[0];
    if (sym) emptyBookAttempts[sym] = count;
  }

  return {
    windowKey: wk,
    mode: S.botMode,
    freeRunMode: S.config.freeRunMode ?? false,
    botEnabled: S.config.enabled ?? true,  // undefined in DB = enabled by default
    botPaused: S.paused,
    isInQuietHours: isInQuietHours(new Date().getUTCHours(), S.config.quietHoursStart, S.config.quietHoursEnd),
    quietHoursStart: S.config.quietHoursStart,
    quietHoursEnd: S.config.quietHoursEnd,
    quietHoursV2State: resolveQuietHoursV2State(S.config.quietHoursV2),
    circuitBreakerActive: S.cbState.circuitBreakerWindowsRemaining > 0,
    circuitBreakerWindowsRemaining: S.cbState.circuitBreakerWindowsRemaining,
    dailyLimitHit: S.dailyPnl <= -getEffectiveDailyLossLimit(),
    dailyPnl: S.dailyPnl,
    dailyLossLimit: getEffectiveDailyLossLimit(),
    dbDegraded: S.dbDegradedSince !== null,
    doubtPenaltyPp: S.currentWindowDoubtPenalty,
    unanimousFailurePenaltyPp: S.currentUnanimousFailurePenalty,
    warmupSecondsRemaining,
    directionCapEnabled: S.config.enableDirectionCap,
    maxSameDirectionBets: S.config.maxSameDirectionBets,
    directionCountYes: dirYes,
    directionCountNo: dirNo,
    maxBetsPerWindow: S.config.maxBetsPerWindow,
    totalBetsThisWindow: dirYes + dirNo,
    emptyBookBlockedCoins,
    emptyBookAttempts,
    nearStrikeFilteredCoins: S.lastWindowEvaluation
      .filter(ev => ev.action === "SKIP" && ev.reason.includes("near-strike EV filter"))
      .map(ev => ev.symbol),
    yesBlockedCoins: [...COIN_YES_BLOCKED],
    fullyBlockedCoins: [...COIN_FULLY_BLOCKED],
    autoTunePausedCoins: Object.fromEntries(pausedCoins),
  };
}

/** Nuclear reset — clears every per-window and per-coin restriction so all
 *  coins can bet freely on the next tick.  Does NOT touch mode, daily P&L,
 *  open positions, or trade history.
 *
 *  Also resets in-memory direction-block sets (COIN_YES_BLOCKED /
 *  COIN_FULLY_BLOCKED) so no coin is silently suppressed after the reset.
 *  The caller (route handler) is responsible for persisting any config field
 *  resets (e.g. regimePenalty → 0) to the DB. */
export function resetWindowConditions(): { cleared: string[]; cbWasActive: boolean; coinBlocksCleared: string[] } {
  // ── Window-level blocks ───────────────────────────────────────────────────
  windowFailedFills.clear();
  windowZeroFillAttempts.clear();
  windowDirectionCounts.clear();

  // ── Doubt & unanimous-failure confidence penalties ────────────────────────
  // Clear the per-window outcome maps that drive penalty computation AND zero
  // the cached penalty values so the next tick doesn't carry over stale state.
  recentWindowOutcomes.clear();
  recentUnanimousOutcomes.clear();
  S.currentWindowDoubtPenalty = 0;
  S.currentUnanimousFailurePenalty = 0;

  // ── Per-coin slippage strikes ─────────────────────────────────────────────
  coinSlippageStrikes.clear();

  // ── Shadow parole cache ───────────────────────────────────────────────────
  // Invalidate so the next checkAllParoles() re-reads fresh shadow data
  // rather than serving a cached state that may now be stale.
  S._shadowParoleCache = null;

  // ── Directional coin blocks (YES-blocked and fully-blocked sets) ──────────
  // These in-memory Sets are populated by the auto-tune system and the shadow
  // parole evaluator. On a full reset the user explicitly wants all coins
  // unblocked so every coin can bet freely in the next window.
  const yesBlockedCleared = [...COIN_YES_BLOCKED];
  const fullyBlockedCleared = [...COIN_FULLY_BLOCKED];
  COIN_YES_BLOCKED.clear();
  COIN_FULLY_BLOCKED.clear();
  const coinBlocksCleared = [...new Set([...yesBlockedCleared, ...fullyBlockedCleared])];

  // ── Auto-tune pauses, circuit-breaker, streak pauses ─────────────────────
  const pauseResult = clearAllPauses();

  // ── Consecutive loss counters for all coins (not just paused ones) ────────
  // clearAllPauses() only zeros losses for coins that have an active pause.
  // A coin sitting at 2 consecutive losses (below the pause threshold) still
  // carries that state — reset it here so no coin enters the next window
  // with a strike count.  Clear BOTH mode maps so paper+live are both clean.
  const streakReset: string[] = [];
  for (const [streakMap, store] of [
    [paperCoinStreakState, paperStreakStore],
    [liveCoinStreakState,  liveStreakStore],
  ] as const) {
    let dirty = false;
    for (const [sym, entry] of streakMap.entries()) {
      if (entry.consecutiveLosses > 0) {
        streakMap.set(sym, { ...entry, consecutiveLosses: 0, pauseUntilWindowKey: null });
        streakReset.push(sym);
        dirty = true;
      }
    }
    if (dirty) {
      persistCoinStreakState(streakMap, store).catch(() => {});
    }
  }

  const allCleared = [...new Set([...pauseResult.clearedCoins, ...streakReset])];
  logger.info(
    {
      cleared: allCleared,
      cbWasActive: pauseResult.cbWasActive,
      doubtPenaltyCleared: true,
      unanimousPenaltyCleared: true,
      slippageStrikesCleared: true,
      streakCountersReset: streakReset,
      coinBlocksCleared,
    },
    "[kalshi-bot] full reset — all restrictions, penalties, coin blocks, and streak counters cleared",
  );
  return { cleared: allCleared, cbWasActive: pauseResult.cbWasActive, coinBlocksCleared };
}

/**
 * Fetch the last 200 settled bets from the DB, compute a PerformanceReport,
 * run auto-tune rules, apply safe S.config mutations, and log every mutation.
 * Should be called once every 15 min (e.g. from index.ts setInterval).
 */
export async function runAutoTuneJob(): Promise<void> {
  try {
    // Fetch settled bets (oldest first so last-30 slice is correct).
    // Manual bets are excluded so user-placed trades don't skew the auto-tune
    // Rules 1–4 (confidence threshold adjustment, coin pausing, etc.).
    const liveResetAt = S.botMode === "live" ? (S.config.liveStatsResetAt ?? null) : null;
    const resetClause = liveResetAt
      ? sql` AND ${kalshiBotBetsTable.createdAt} >= ${liveResetAt}`
      : sql``;
    const rows = await db
      .select({
        symbol: kalshiBotBetsTable.symbol,
        direction: kalshiBotBetsTable.direction,
        pnl: kalshiBotBetsTable.pnl,
        exitReason: kalshiBotBetsTable.exitReason,
        createdAt: kalshiBotBetsTable.createdAt,
        exitedAt: kalshiBotBetsTable.exitedAt,
        signals: kalshiBotBetsTable.signals,
        outcome: kalshiBotBetsTable.outcome,
        isMaxBet: kalshiBotBetsTable.isMaxBet,
      })
      .from(kalshiBotBetsTable)
      .where(
        sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')
          AND ${kalshiBotBetsTable.outcome} IS NOT NULL
          AND ${kalshiBotBetsTable.mode} = ${S.botMode}
          AND (${kalshiBotBetsTable.source} IS NULL OR ${kalshiBotBetsTable.source} != 'manual')${resetClause}`,
      )
      .orderBy(desc(kalshiBotBetsTable.createdAt)) // most-recent first → reverse below
      .limit(S.config.autoTuneWindowSize ?? 100);

    rows.reverse(); // convert to oldest-first so slice(-30) gives the most recent 30

    const bets: SettledBetRecord[] = rows.map(r => ({
      symbol: r.symbol,
      direction: r.direction,
      pnl: r.pnl,
      exitReason: r.exitReason,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      exitedAt: r.exitedAt instanceof Date ? r.exitedAt.toISOString()
              : r.exitedAt != null ? String(r.exitedAt) : null,
      signals: (r.signals as Record<string, unknown>) ?? null,
      outcome: r.outcome,
      isMaxBet: r.isMaxBet ?? false,
    }));

    // Separate all-time max-bet query (no limit) so the max-bet stats panel is
    // never truncated by autoTuneWindowSize.
    const maxBetRows = await db
      .select({
        symbol: kalshiBotBetsTable.symbol,
        direction: kalshiBotBetsTable.direction,
        pnl: kalshiBotBetsTable.pnl,
        exitReason: kalshiBotBetsTable.exitReason,
        createdAt: kalshiBotBetsTable.createdAt,
        exitedAt: kalshiBotBetsTable.exitedAt,
        signals: kalshiBotBetsTable.signals,
        outcome: kalshiBotBetsTable.outcome,
        isMaxBet: kalshiBotBetsTable.isMaxBet,
      })
      .from(kalshiBotBetsTable)
      .where(
        sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')
          AND ${kalshiBotBetsTable.outcome} IS NOT NULL
          AND ${kalshiBotBetsTable.mode} = ${S.botMode}
          AND ${kalshiBotBetsTable.isMaxBet} = true
          AND (${kalshiBotBetsTable.source} IS NULL OR ${kalshiBotBetsTable.source} != 'manual')${resetClause}`,
      )
      .orderBy(asc(kalshiBotBetsTable.createdAt));

    const allMaxBets: SettledBetRecord[] = maxBetRows.map(r => ({
      symbol: r.symbol,
      direction: r.direction,
      pnl: r.pnl,
      exitReason: r.exitReason,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      exitedAt: r.exitedAt instanceof Date ? r.exitedAt.toISOString()
              : r.exitedAt != null ? String(r.exitedAt) : null,
      signals: (r.signals as Record<string, unknown>) ?? null,
      outcome: r.outcome,
      isMaxBet: true,
    }));

    const report = computePerformanceReport(bets, undefined, allMaxBets);
    cachedPerformanceReportByMode.set(S.botMode, report);

    const tuneConfig = {
      minConfidence: S.config.minConfidence,
      quietHoursStart: S.config.quietHoursStart,
      quietHoursEnd: S.config.quietHoursEnd,
      enableAutoTuning: S.config.enableAutoTuning ?? true,
      defaultMinConfidence: DEFAULT_BOT_CONFIG.minConfidence,
      autoTuneConfidenceRevertAt: S.config.autoTuneConfidenceRevertAt ?? null,
      autoTuneConfidenceRevertTo: S.config.autoTuneConfidenceRevertTo ?? null,
    };

    // Build a per-rule "last fired at" map from the log table so the cooldown
    // check in runAutoTuneRules survives server restarts.
    const lastFiredAt = new Map<string, Date>();
    try {
      const logRows = await db
        .select({ ruleName: botAutoTuneLogTable.ruleName, createdAt: botAutoTuneLogTable.createdAt })
        .from(botAutoTuneLogTable)
        .orderBy(desc(botAutoTuneLogTable.createdAt))
        .limit(50); // enough to find the most-recent entry for each distinct rule

      for (const row of logRows) {
        if (row.ruleName && row.createdAt && !lastFiredAt.has(row.ruleName)) {
          lastFiredAt.set(row.ruleName, row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt)));
        }
      }
    } catch (err) {
      logger.warn({ err }, "[auto-tune] failed to load last-fired timestamps (non-fatal — cooldown skipped)");
    }

    const mutations: AutoTuneMutation[] = runAutoTuneRules(report, tuneConfig, pausedCoins, lastFiredAt);

    if (mutations.length === 0) {
      logger.info({ totalBets: report.totalBets, overallWinRate: report.overallWinRate },
        "[auto-tune] report computed — no parameter changes warranted");
      return;
    }

    for (const mutation of mutations) {
      logger.info({ ruleName: mutation.ruleName, oldValue: mutation.oldValue, newValue: mutation.newValue, reason: mutation.triggerReason },
        "[auto-tune] applying mutation");

      // Persist the log entry to DB
      try {
        await db.insert(botAutoTuneLogTable).values({
          ruleName: mutation.ruleName,
          oldValue: mutation.oldValue,
          newValue: mutation.newValue,
          triggerReason: mutation.triggerReason,
          createdAt: new Date(),
        });
      } catch (err) {
        logger.warn({ err }, "[auto-tune] failed to write log entry (non-fatal)");
      }

      // Apply S.config mutations
      if (mutation.configMutation) {
        S.config = { ...S.config, ...mutation.configMutation };
        // Persist new S.config to DB (fire-and-forget)
        updateBotConfig(mutation.configMutation).catch(() => {});
      }

      // Apply per-coin pause
      if (mutation.pauseCoin) {
        const { symbol: pauseSym, windows } = mutation.pauseCoin;
        pausedCoins.set(pauseSym.toUpperCase(), windows);
        logger.info({ sym: pauseSym, windows }, "[auto-tune] per-coin pause applied");
      }
    }
  } catch (err) {
    logger.warn({ err }, "[auto-tune] job failed (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
