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
  liveCoinStreakState, coinSlippageStrikes, recentWindowOutcomes, recentUnanimousOutcomes, windowCBBuffer,
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

// Persist the current config + mode to the bot_config DB row.
export async function _persistModeToConfig(): Promise<void> {
  try {
    const snapshot = { ...S.config, mode: S.botMode } as Record<string, unknown>;
    await db.execute(sql`
      INSERT INTO bot_config (id, config, updated_at)
      VALUES ('default', ${JSON.stringify(snapshot)}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at
    `);
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to persist mode to DB (non-fatal)");
  }
}

export async function loadBotConfigFromDB(): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(botConfigTable)
      .where(eq(botConfigTable.id, "default"))
      .limit(1);
    if (rows.length > 0 && rows[0].config) {
      const saved = rows[0].config as Partial<BotConfig> & { mode?: BotMode };
      S.config = { ...DEFAULT_BOT_CONFIG, ...saved };
      if (saved.mode === "paper" || saved.mode === "live") {
        // applyStartupModeRestore: extracted to engine-core for unit-testability.
        const { effective, didDowngrade } = applyStartupModeRestore(saved.mode, process.env.NODE_ENV);
        // Set S.botMode BEFORE persisting so _persistModeToConfig writes the
        // correct (effective) value, not a stale previous S.botMode.
        S.botMode = effective;
        if (didDowngrade) {
          // Safety net: never allow a "live" mode to persist into a non-production
          // environment even if the DB was written in prod and the DB is shared.
          logger.warn("[kalshi-bot] DB had mode=live but this is a non-production environment — forcing paper mode");
          // Rewrite the DB value so the next restart is also clean.
          _persistModeToConfig().catch(() => {});
        }
        logger.info({ mode: S.botMode }, "[kalshi-bot] mode restored from DB");
      }
      logger.info({ config: S.config }, "[kalshi-bot] config loaded from DB");
    } else {
      logger.info("[kalshi-bot] no saved config in DB — seeding defaults");
      // Seed the table so production starts with an explicit S.config row rather than
      // relying on code defaults that differ from the values tuned in development.
      try {
        await db.execute(sql`
          INSERT INTO bot_config (id, config, updated_at)
          VALUES ('default', ${JSON.stringify({ ...DEFAULT_BOT_CONFIG, mode: S.botMode })}::jsonb, NOW())
          ON CONFLICT (id) DO NOTHING
        `);
        logger.info("[kalshi-bot] default config seeded to DB");
      } catch (seedErr) {
        logger.warn({ seedErr }, "[kalshi-bot] failed to seed default config (non-fatal)");
      }
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to load config from DB — using defaults (non-fatal)");
  }
}

/**
 * Reconstruct S.dailyPnl and S.dailyLossCount from today's evaluated bet rows.
 * Called once at startup after loadBotConfigFromDB() so the loss-limit guard
 * has correct state even after a crash or restart mid-day.
 */
export async function loadDailyPnlFromDB(): Promise<void> {
  try {
    const today = todayUTC();
    // Filter by exitedAt date to match runtime behaviour: S.dailyPnl is incremented
    // in closePosition() (i.e. at exit time), so reconstruction must use the same
    // day bucket — exitedAt UTC date — not createdAt. This keeps daily state correct
    // even when a position opened before midnight and was closed after.
    //
    // IMPORTANT: filter to the current S.botMode so paper and live have fully
    // independent daily loss limits. Paper losses must not eat into the live
    // daily budget and vice versa.
    const rows = await db
      .select({ pnl: kalshiBotBetsTable.pnl })
      .from(kalshiBotBetsTable)
      .where(
        and(
          isNotNull(kalshiBotBetsTable.exitedAt),
          isNull(kalshiBotBetsTable.archivedAt),
          eq(kalshiBotBetsTable.mode, S.botMode),
          sql`DATE(${kalshiBotBetsTable.exitedAt} AT TIME ZONE 'UTC') = ${today}`,
          sql`${kalshiBotBetsTable.action} IN ('exit', 'late_recovery_exit', 'expired')`,
        ),
      );

    let pnlSum = 0;
    let lossCount = 0;
    for (const r of rows) {
      const p = r.pnl != null ? parseFloat(String(r.pnl)) : 0;
      pnlSum += p;
      if (p < 0) lossCount++;
    }
    S.dailyPnl = pnlSum;
    S.dailyLossCount = lossCount;
    S.dailyDate = today;

    // Restore consecutive-loss streak and recent Kalshi strike prices from recent bets.
    // Both are needed on startup: streak → circuit-breaker restore; strikes → momentum filter.
    // Rows ordered newest-first so we can walk the streak forward from the most recent bet.
    // Filter to the current S.botMode so a paper loss streak cannot trip the live
    // circuit-breaker and vice versa.
    const recentRows = await db
      .select({
        pnl: kalshiBotBetsTable.pnl,
        symbol: kalshiBotBetsTable.symbol,
        kalshiTarget: kalshiBotBetsTable.kalshiTarget,
        windowKey: kalshiBotBetsTable.windowKey,
        exitedAt: kalshiBotBetsTable.exitedAt,
        source: kalshiBotBetsTable.source,
      })
      .from(kalshiBotBetsTable)
      .where(
        and(
          eq(kalshiBotBetsTable.mode, S.botMode),
          sql`${kalshiBotBetsTable.action} IN ('exit', 'late_recovery_exit', 'expired')
            AND ${kalshiBotBetsTable.exitedAt} IS NOT NULL`,
        ),
      )
      .orderBy(desc(kalshiBotBetsTable.exitedAt))
      .limit(REGIME_STRIKES_MAX * 8); // fetch enough to populate targets for all coins

    // Streak: count consecutive losses from most-recent row backwards.
    // Manual bets are excluded so user-placed trades don't skew the bot's
    // circuit-breaker state or auto-tune logic.
    let streak = 0;
    for (const r of recentRows) {
      if (r.source === "manual") continue;
      const p = r.pnl != null ? parseFloat(String(r.pnl)) : 0;
      if (p < 0) streak++;
      else break; // first non-loss resets the streak
    }

    // Targets: collect all records (newest-first) and reverse to chronological order.
    const targetsBySymbol: Map<string, number[]> = new Map();
    for (const r of recentRows) {
      const sym = (r.symbol ?? "").toUpperCase();
      if (sym && r.kalshiTarget != null) {
        if (!targetsBySymbol.has(sym)) targetsBySymbol.set(sym, []);
        const t = parseFloat(String(r.kalshiTarget));
        if (!isNaN(t)) targetsBySymbol.get(sym)!.push(t);
      }
    }
    for (const [sym, targets] of targetsBySymbol.entries()) {
      // DB returned newest-first; reverse for chronological order then cap size.
      recentKalshiTargets.set(sym, targets.reverse().slice(-REGIME_STRIKES_MAX));
    }

    // Per-coin consecutive loss recovery: if a coin has ≥5 consecutive losses in recent
    // bets AND the most recent bet for that coin was within the last 90 minutes (6 windows),
    // auto-pause it for 4 windows. The recency guard prevents perpetual re-pause on every
    // server restart when the coin has been idle (already served its pause time).
    const perCoinStreak: Map<string, number> = new Map();
    const perCoinLastBetAt: Map<string, Date> = new Map();
    const perCoinStreakDone: Set<string> = new Set();
    const STARTUP_PAUSE_RECENCY_MS = 90 * 60_000; // 90 minutes = 6 windows
    const nowForPause = Date.now();
    for (const r of recentRows) {
      if (r.source === "manual") continue; // manual bets must not trip per-coin auto-pause
      const sym = (r.symbol ?? "").toUpperCase();
      if (!sym || perCoinStreakDone.has(sym)) continue;
      // Track most-recent bet timestamp per coin (rows are newest-first).
      if (!perCoinLastBetAt.has(sym) && r.exitedAt) {
        perCoinLastBetAt.set(sym, new Date(r.exitedAt));
      }
      const p = r.pnl != null ? parseFloat(String(r.pnl)) : 0;
      if (p < 0) {
        perCoinStreak.set(sym, (perCoinStreak.get(sym) ?? 0) + 1);
      } else {
        perCoinStreakDone.add(sym); // first win resets streak for this coin
      }
    }
    for (const [sym, consecutive] of perCoinStreak.entries()) {
      const lastBet = perCoinLastBetAt.get(sym);
      const isRecent = lastBet && (nowForPause - lastBet.getTime()) < STARTUP_PAUSE_RECENCY_MS;
      if (consecutive >= 5 && !pausedCoins.has(sym) && isRecent) {
        pausedCoins.set(sym, 4);
        logger.warn(
          { sym, consecutive, lastBetAt: lastBet },
          "[kalshi-bot] startup: auto-pausing coin with ≥5 consecutive recent losses",
        );
      } else if (consecutive >= 5 && !isRecent) {
        logger.info(
          { sym, consecutive, lastBetAt: lastBet },
          "[kalshi-bot] startup: skipping auto-pause — last bet too old (coin already served pause time)",
        );
      }
    }

    // Populate per-window outcome tracking from recent settled rows.
    // recentRows is newest-first; we just iterate and bucket by windowKey.
    // Manual bets are excluded so they don't skew the window-doubt penalty.
    recentWindowOutcomes.clear();
    recentUnanimousOutcomes.clear();
    for (const r of recentRows) {
      if (r.source === "manual") continue;
      const wk = r.windowKey;
      if (!wk || r.pnl == null) continue;
      const p = parseFloat(String(r.pnl));
      const wo = recentWindowOutcomes.get(wk) ?? { wins: 0, losses: 0 };
      if (p > 0) wo.wins++;
      else if (p < 0) wo.losses++;
      recentWindowOutcomes.set(wk, wo);

      // Unanimous-model tracking: only bets where all non-null models agreed.
      const sigs = (r.signals ?? {}) as Record<string, unknown>;
      const sAgreeing = typeof sigs["signalsAgreeing"] === "number" ? sigs["signalsAgreeing"] : null;
      const sTotal    = typeof sigs["signalsTotal"]    === "number" ? sigs["signalsTotal"]    : null;
      if (sAgreeing !== null && sTotal !== null && sTotal >= 2 && sAgreeing === sTotal) {
        const uo = recentUnanimousOutcomes.get(wk) ?? { wins: 0, losses: 0 };
        if (p > 0) uo.wins++;
        else if (p < 0) uo.losses++;
        recentUnanimousOutcomes.set(wk, uo);
      }
    }

    // Restore consecutive-loss streak for in-session tracking only.
    // The circuit-breaker window countdown is NOT restored on restart because:
    //   1. S.cbState starts at 0 each process start — Math.max(0, N) would always reset
    //      CB to the full configured pause count whenever a streak exists, causing
    //      perpetual blocking across restarts (no new bets → streak never clears → repeat).
    //   2. The CB is a session-level safety feature; the per-coin auto-pause (above)
    //      already handles the "bad recent streak" case on restart with the recency guard.
    // CB re-activates naturally when new losses happen within the running session.
    S.cbState = { consecutiveLosses: streak, circuitBreakerWindowsRemaining: 0 };

    logger.info({ dailyPnl: S.dailyPnl, dailyLossCount: S.dailyLossCount, date: today, cbState: S.cbState }, "[kalshi-bot] daily P&L loaded from DB");
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to load daily P&L from DB (non-fatal)");
  }
}

/**
 * Reconstruct per-coin daily loss totals from today's settled bet rows.
 * Called at startup and after a mode change (same timing as loadDailyPnlFromDB).
 */
export async function loadCoinDailyLossFromDB(): Promise<void> {
  try {
    const today = todayUTC();
    const rows = await db
      .select({
        symbol: kalshiBotBetsTable.symbol,
        pnl: kalshiBotBetsTable.pnl,
      })
      .from(kalshiBotBetsTable)
      .where(
        and(
          isNotNull(kalshiBotBetsTable.exitedAt),
          isNull(kalshiBotBetsTable.archivedAt),
          eq(kalshiBotBetsTable.mode, S.botMode),
          sql`DATE(${kalshiBotBetsTable.exitedAt} AT TIME ZONE 'UTC') = ${today}`,
          sql`${kalshiBotBetsTable.action} IN ('exit', 'late_recovery_exit', 'expired')`,
        ),
      );

    const modeMap = coinDailyLossForMode(S.botMode);
    modeMap.clear();
    for (const r of rows) {
      const sym = (r.symbol ?? "").toUpperCase();
      const p = r.pnl != null ? parseFloat(String(r.pnl)) : 0;
      if (sym && p < 0) {
        modeMap.set(sym, (modeMap.get(sym) ?? 0) + Math.abs(p));
      }
    }
    logger.info(
      { coinDailyLoss: Object.fromEntries(modeMap) },
      "[kalshi-bot] per-coin daily loss loaded from DB",
    );
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to load per-coin daily loss from DB (non-fatal)");
  }
}

/**
 * Persist the current coinStreakState to bot_config (id="coin_streak_state").
 * Called fire-and-forget after every closePosition() that updates the Map so
 * the guard survives server restarts without touching the main S.config row.
 */
async function persistCoinStreakStateToDB(): Promise<void> {
  try {
    // Persist both mode-specific maps independently so each has its own row.
    await Promise.all([
      persistCoinStreakState(paperCoinStreakState, paperStreakStore),
      persistCoinStreakState(liveCoinStreakState, liveStreakStore),
    ]);
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to persist coinStreakState to DB (non-fatal)");
  }
}

/**
 * Restore both per-mode coinStreak maps from DB.
 * Auto-clears any pauseUntilWindowKey that has already expired by comparing it
 * to the current window key — so a pause set before a restart never blocks a
 * coin after the pause window has passed.
 */
export async function loadCoinStreakStateFromDB(): Promise<void> {
  try {
    const nowWindowKey = currentWindowKey();

    async function loadIntoMap(store: StreakDbStore, target: Map<string, CoinStreakEntry>, label: string) {
      const { state: restored, clearedSyms } = await loadCoinStreakState(store, nowWindowKey);
      if (restored.size === 0 && clearedSyms.length === 0) {
        logger.info(`[kalshi-bot] no persisted coinStreakState found for ${label} — starting fresh`);
        target.clear();
        return;
      }
      target.clear();
      for (const [sym, entry] of restored.entries()) {
        target.set(sym, entry);
        if (clearedSyms.includes(sym)) {
          logger.info({ sym, nowWindowKey }, `[kalshi-bot] startup: ${label} coinStreak pause expired — cleared`);
        } else if (entry.pauseUntilWindowKey) {
          logger.warn(
            { sym, pauseUntilWindowKey: entry.pauseUntilWindowKey, consecutiveLosses: entry.consecutiveLosses, nowWindowKey },
            `[kalshi-bot] startup: restoring active ${label} coinStreak pause`,
          );
        }
      }
      logger.info(
        { [label]: Object.fromEntries(target) },
        `[kalshi-bot] coinStreakState(${label}) loaded from DB`,
      );
    }

    await Promise.all([
      loadIntoMap(paperStreakStore, paperCoinStreakState, "paper"),
      loadIntoMap(liveStreakStore, liveCoinStreakState, "live"),
    ]);
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to load coinStreakState from DB (non-fatal)");
  }
}

/**
 * Compute and restore the paper-mode account balance from the DB.
 *
 * Balance = paperStartingBalance (from S.config) + sum of all paper-mode bet PnL
 * settled *after* S.config.paperBalanceResetAt (or all time when that is null).
 *
 * Called once on startup after loadBotConfigFromDB() so the balance reflects
 * the real state rather than resetting to the hardcoded default on every
 * server restart / republish.
 */
/**
 * One-time startup migration: correct historical live-mode expired bet P&L records
 * that were written with the old paper-simulation formula (betAmount × 0.50).
 *
 * Real Kalshi contract P&L:
 *   YES win:  (1 − entryPrice) × contractCount
 *   YES loss: −entryPrice × contractCount
 *   NO  win:   entryPrice × contractCount
 *   NO  loss: −(1 − entryPrice) × contractCount
 *
 * Safe to run on every startup: only updates rows where outcome AND entry_price
 * AND contract_count are all set (evaluated rows), and only for mode='live'.
 */
export async function fixLiveExpiredPnlHistorical(): Promise<void> {
  try {
    const updated = await db.execute(sql`
      UPDATE kalshi_bot_bets
      SET pnl = CASE
        WHEN direction = 'yes' AND outcome = 'win'  THEN (1 - entry_price::numeric) * contract_count
        WHEN direction = 'yes' AND outcome = 'loss' THEN (-entry_price::numeric) * contract_count
        WHEN direction = 'no'  AND outcome = 'win'  THEN entry_price::numeric * contract_count
        WHEN direction = 'no'  AND outcome = 'loss' THEN (-(1 - entry_price::numeric)) * contract_count
        ELSE pnl
      END
      WHERE mode = 'live'
        AND action = 'expired'
        AND outcome IN ('win', 'loss')
        AND entry_price IS NOT NULL
        AND contract_count IS NOT NULL
    `);
    logger.info({ rowCount: updated.rowCount }, "[kalshi-bot] fixLiveExpiredPnlHistorical: corrected live expired P&L to real contract math");
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] fixLiveExpiredPnlHistorical: failed (non-fatal)");
  }
}

export async function loadPaperBalanceFromDB(): Promise<void> {
  if (S.botMode === "live") {
    // Live mode: balance is fetched from Kalshi on demand; skip DB computation.
    return;
  }
  try {
    const startingBalance = S.config.paperStartingBalance ?? 100;
    const resetAt = S.config.paperBalanceResetAt ? new Date(S.config.paperBalanceResetAt) : null;

    const conditions = [
      isNotNull(kalshiBotBetsTable.exitedAt),
      eq(kalshiBotBetsTable.mode, "paper"),
      sql`${kalshiBotBetsTable.action} IN ('exit', 'late_recovery_exit', 'expired')`,
    ];
    if (resetAt) {
      conditions.push(sql`${kalshiBotBetsTable.exitedAt} >= ${resetAt.toISOString()}`);
    }

    const rows = await db
      .select({ pnl: kalshiBotBetsTable.pnl })
      .from(kalshiBotBetsTable)
      .where(and(...conditions));

    let pnlSum = 0;
    for (const r of rows) {
      pnlSum += r.pnl != null ? parseFloat(String(r.pnl)) : 0;
    }
    S.accountBalance = startingBalance + pnlSum;
    logger.info(
      { startingBalance, pnlSum, accountBalance: S.accountBalance, resetAt },
      "[kalshi-bot] paper balance loaded from DB",
    );
  } catch (err) {
    S.accountBalance = S.config.paperStartingBalance ?? 100;
    logger.warn({ err }, "[kalshi-bot] failed to load paper balance from DB — using starting balance");
  }
}

/**
 * Delete kalshi_bot_bets records older than `hours` hours and reload in-memory
 * daily P&L counters so the bot reflects the trimmed history immediately.
 * Prediction_records (learning data) are never touched.
 */
export async function clearBetHistoryOld(hours = 2): Promise<{ deleted: number }> {
  // Soft-archive: stamp archived_at instead of deleting so that operational queries
  // (recentKalshiTargets seeding, evalClosedBets, border guard, auto-tune) keep
  // working with full history.  Only DISPLAY queries filter archived_at IS NULL.
  const result = await db.execute(
    sql`UPDATE kalshi_bot_bets
        SET archived_at = NOW()
        WHERE created_at < NOW() - (${hours} || ' hours')::interval
          AND archived_at IS NULL`
  );
  const deleted = (result as unknown as { rowCount: number }).rowCount ?? 0;
  logger.info({ archived: deleted, hours }, "[kalshi-bot] clearBetHistoryOld — bet records soft-archived");
  // Reload in-memory daily counters so the running bot reflects the clean slate.
  await loadDailyPnlFromDB();
  return { deleted };
}

/**
 * Recover an open position from the DB after a server restart.
 * Looks for the most recent 'bet' row with no exitedAt within the last 24 hours
 * (24h covers midnight-UTC boundaries so a position opened late in one day is
 * still found on a post-midnight restart). If found:
 *   - Window still active → restores the position into openPositions so the
 *     exit guard resumes on the next tick. No double-entry can occur because
 *     _runBotTick returns early when a position slot is already occupied.
 *   - Window expired → skips restoration; evalClosedBets will settle the row
 *     once the bot-loop window-expiry check closes it.
 */
export async function loadOpenPositionFromDB(): Promise<void> {
  try {
    // Use a 24-hour rolling window instead of a DATE equality so a position
    // opened just before UTC midnight is still found after a post-midnight restart.
    const rows = await db
      .select()
      .from(kalshiBotBetsTable)
      .where(
        and(
          isNull(kalshiBotBetsTable.exitedAt),
          eq(kalshiBotBetsTable.action, "bet"),
          sql`${kalshiBotBetsTable.createdAt} >= NOW() - INTERVAL '24 hours'`,
        ),
      )
      .orderBy(desc(kalshiBotBetsTable.createdAt));

    if (rows.length === 0) {
      logger.info("[kalshi-bot] no open positions found in DB");
      return;
    }

    const currentKey = currentWindowKey();
    let restored = 0;

    for (const row of rows) {
      // Validate required fields before reconstructing in-memory position.
      if (
        !row.direction ||
        !row.ticker ||
        row.entryPrice == null ||
        row.contractCount == null ||
        row.betAmount == null ||
        row.kalshiTarget == null
      ) {
        logger.warn({ id: row.id }, "[kalshi-bot] open position row missing required fields — skipping restore");
        continue;
      }

      const windowKey = row.windowKey;

      if (windowKey !== currentKey) {
        // Window has already expired — skip; evalClosedBets will settle it.
        logger.info(
          { id: row.id, symbol: row.symbol, windowKey, currentKey },
          "[kalshi-bot] recovered position window has expired — leaving for normal evaluator flow",
        );
        continue;
      }

      const entryYesPrice = parseFloat(String(row.entryPrice));
      const direction = row.direction as "yes" | "no";

      openPositions.set(row.symbol, {
        id: row.id,
        symbol: row.symbol,
        windowKey,
        ticker: row.ticker,
        direction,
        entryYesPrice,
        contractCount: row.contractCount,
        betAmount: parseFloat(String(row.betAmount)),
        kalshiTarget: parseFloat(String(row.kalshiTarget)),
        openedAt: row.createdAt instanceof Date ? row.createdAt.getTime() : new Date(String(row.createdAt)).getTime(),
        cryptoPriceAtEntry: (row as Record<string, unknown>)["cryptoPriceAtEntry"] != null
          ? parseFloat(String((row as Record<string, unknown>)["cryptoPriceAtEntry"]))
          : null,
        exitState: makeInitialExitState(entryYesPrice),
        entryDecision: {
          action: direction === "yes" ? "BET_YES" : "BET_NO",
          confidence: 0, // not stored; the exit guard only needs direction + price
          signals: (row.signals ?? {}) as Record<string, unknown>,
        } as unknown as BotDecision,
        phase2Activated: row.phase2Activated ?? false,
        // Recover the mode the position was opened in so its exit uses a real
        // sell order when it was a live bet, regardless of the current mode.
        entryMode: row.mode === "live" ? "live" : "paper",
        // Infer source from ID prefix (manual:...) or persisted signals flag so
        // closeManualPosition still works correctly after a server restart.
        source: row.id.startsWith("manual:") || (row.signals as Record<string, unknown> | null)?.["manual"] === true
          ? "manual"
          : "bot",
      });

      logger.info(
        { id: row.id, symbol: row.symbol, windowKey, direction, entryYesPrice },
        "[kalshi-bot] open position restored from DB — exit guard will resume on next tick",
      );
      restored++;
    }

    if (restored > 0) {
      logger.info({ restored }, "[kalshi-bot] open positions restored from DB");
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to restore open positions from DB (non-fatal)");
  }
}

/**
 * Restore windowBetCounts, windowTotalBets, and windowBetDetails from DB on startup.
 * Without this, every server restart wipes the in-memory maps so bets placed earlier
 * in the current window won't have BET PLACED badges and the global cap resets to 0.
 * We only restore for the CURRENT window — previous windows don't matter.
 */
export async function loadWindowBetCountsFromDB(): Promise<void> {
  try {
    const wk = currentWindowKey();
    const rows = await db
      .select({
        symbol: kalshiBotBetsTable.symbol,
        direction: kalshiBotBetsTable.direction,
        signals: kalshiBotBetsTable.signals,
        mode: kalshiBotBetsTable.mode,
      })
      .from(kalshiBotBetsTable)
      .where(
        and(
          eq(kalshiBotBetsTable.action, "bet"),
          eq(kalshiBotBetsTable.windowKey, wk),
          isNull(kalshiBotBetsTable.archivedAt),
        ),
      );

    if (rows.length === 0) return;

    for (const row of rows) {
      const sym = row.symbol.toUpperCase();
      // Mode-aware keys: paper bets never pollute the live cap.
      const rowMode = row.mode === "live" ? "live" : "paper";
      const key = `${sym}:${wk}:${rowMode}`;
      const totalKey = `${wk}:${rowMode}`;
      windowBetCounts.set(key, (windowBetCounts.get(key) ?? 0) + 1);
      windowTotalBets.set(totalKey, (windowTotalBets.get(totalKey) ?? 0) + 1);

      const dir = row.direction as "yes" | "no" | null;
      if (dir === "yes" || dir === "no") {
        // Restore direction cap counters so maxSameDirectionBets also respects prior bets.
        // Direction counts are shared across modes (intentional — both modes see the same markets).
        windowDirectionCounts.set(dir, (windowDirectionCounts.get(dir) ?? 0) + 1);
        const sig = row.signals as Record<string, unknown> | null;
        const confidence = typeof sig?.effectiveConfidence === "number"
          ? sig.effectiveConfidence
          : 0;
        windowBetDetails.set(key, { direction: dir, confidence });
      }
    }

    logger.info(
      { windowKey: wk, restoredCount: rows.length },
      "[kalshi-bot] window bet counts restored from DB",
    );
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] failed to restore window bet counts from DB (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Border-proximity guard helper
// ---------------------------------------------------------------------------

/**
 * Queries the last `lookback` evaluated bets per symbol and returns a map of
 * sym → avg |closePrice−kalshiTarget| / kalshiTarget × 100 (as a percentage).
 * Only rows that have closePriceAtEval stored in their signals JSONB are counted.
 */
/**
 * Queries the last `lookback` settled bets per symbol and determines whether
 * the close price consistently settled above or below the Kalshi strike.
 * Returns "above" / "below" / "neutral" per symbol.
 * "above" means ALL recent closes were above the strike (lean YES regime).
 * "below" means ALL recent closes were below the strike (lean NO regime).
 */
export async function loadRegimeCache(symbols: string[], lookback: number): Promise<Map<string, "above" | "below" | "neutral">> {
  const result = new Map<string, "above" | "below" | "neutral">();
  if (symbols.length === 0 || lookback <= 0) return result;
  try {
    const rows = await db.execute(sql`
      WITH ranked AS (
        SELECT
          symbol,
          kalshi_target::numeric                          AS target,
          (signals->>'closePriceAtEval')::numeric         AS close_price,
          ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY evaluated_at DESC) AS rn
        FROM kalshi_bot_bets
        WHERE outcome IS NOT NULL
          AND evaluated_at IS NOT NULL
          AND signals->>'closePriceAtEval' IS NOT NULL
          AND kalshi_target IS NOT NULL
          AND symbol = ANY(${sql.raw(`ARRAY[${symbols.map(s => `'${s.replace(/'/g, "''")}'`).join(",")}]`)})
      )
      SELECT
        symbol,
        COUNT(*) FILTER (WHERE close_price > target)::int  AS above_count,
        COUNT(*) FILTER (WHERE close_price < target)::int  AS below_count,
        COUNT(*)::int                                       AS sample_count
      FROM ranked
      WHERE rn <= ${lookback}
      GROUP BY symbol
    `);
    for (const row of rows.rows as { symbol: string; above_count: number; below_count: number; sample_count: number }[]) {
      if (row.sample_count < lookback) {
        result.set(row.symbol, "neutral");
      } else if (row.above_count === row.sample_count) {
        result.set(row.symbol, "above");
      } else if (row.below_count === row.sample_count) {
        result.set(row.symbol, "below");
      } else {
        result.set(row.symbol, "neutral");
      }
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] loadRegimeCache: query failed — regime filter disabled this tick");
  }
  return result;
}

export async function loadBorderProximityCache(symbols: string[], lookback: number): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (symbols.length === 0 || lookback <= 0) return result;
  try {
    const rows = await db.execute(sql`
      WITH ranked AS (
        SELECT
          symbol,
          kalshi_target::numeric                          AS target,
          (signals->>'closePriceAtEval')::numeric         AS close_price,
          ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY evaluated_at DESC) AS rn
        FROM kalshi_bot_bets
        WHERE outcome IS NOT NULL
          AND evaluated_at IS NOT NULL
          AND signals->>'closePriceAtEval' IS NOT NULL
          AND kalshi_target IS NOT NULL
          AND symbol = ANY(${sql.raw(`ARRAY[${symbols.map(s => `'${s.replace(/'/g, "''")}'`).join(",")}]`)})
      )
      SELECT
        symbol,
        AVG(ABS(close_price - target) / target * 100)::numeric AS avg_proximity_pct,
        COUNT(*)::int                                           AS sample_count
      FROM ranked
      WHERE rn <= ${lookback}
      GROUP BY symbol
    `);
    for (const row of rows.rows as { symbol: string; avg_proximity_pct: string; sample_count: number }[]) {
      const pct = parseFloat(row.avg_proximity_pct);
      if (!isNaN(pct)) result.set(row.symbol, pct);
    }
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] loadBorderProximityCache: query failed — guard disabled this tick");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Timing accuracy helper
// ---------------------------------------------------------------------------

export async function getTimingAccuracy(symbol: string, minutesElapsed: number): Promise<number | null> {
  const nowMs = Date.now();
  if (nowMs - S.timingCacheAt > TIMING_CACHE_TTL) {
    try {
      const rows = await getTimingAnalysis(); // aggregate across all coins
      const fresh = new Map<string, number | null>();
      for (const r of rows) {
        const key = `${r.symbol ?? "ALL"}:${r.minuteMark}`;
        fresh.set(key, r.accuracy != null ? r.accuracy * 100 : null);
      }
      S.timingCache = fresh;
      S.timingCacheAt = nowMs;
    } catch {
      // keep stale cache
    }
  }

  // Look up the closest minute mark (1,3,6,9,12)
  const marks = [1, 3, 6, 9, 12];
  const elapsedMin = Math.floor(minutesElapsed);
  const closest = marks.reduce((prev, m) => Math.abs(m - elapsedMin) < Math.abs(prev - elapsedMin) ? m : prev, marks[0]);
  const markSeconds = closest * 60;

  const symKey = `${symbol}:${markSeconds}`;
  const allKey = `ALL:${markSeconds}`;
  return S.timingCache.get(symKey) ?? S.timingCache.get(allKey) ?? null;
}

// ---------------------------------------------------------------------------
// Core tick — called by the prediction tracker every 30 s per coin
// ---------------------------------------------------------------------------

// In-flight guard to prevent overlapping ticks per symbol
const tickInFlight = new Set<string>();

// Update bot config and persist to DB. Exported here to avoid circular deps.
export async function updateBotConfig(partial: Partial<BotConfig>): Promise<{ config: BotConfig; persisted: boolean }> {
  const modeSpecific: Partial<BotConfig> = {};
  if ("decisionMode" in partial && partial.decisionMode) {
    if (S.botMode === "paper") modeSpecific.paperDecisionMode = partial.decisionMode;
    else modeSpecific.liveDecisionMode = partial.decisionMode;
  }
  S.config = { ...S.config, ...partial, ...modeSpecific };
  const snapshot = { ...S.config };
  let persisted = false;
  try {
    const stored = { ...snapshot, mode: S.botMode } as Record<string, unknown>;
    await db.execute(sql`
      INSERT INTO bot_config (id, config, updated_at)
      VALUES ('default', ${JSON.stringify(stored)}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at
    `);
    persisted = true;
  } catch (err) {
    logger.error({ err }, "[kalshi-bot] failed to persist config to DB");
  }
  if ("paperStartingBalance" in partial || "paperBalanceResetAt" in partial) {
    await loadPaperBalanceFromDB().catch(() => {});
  }
  return { config: snapshot, persisted };
}
