import { db, kalshiBotBetsTable, botConfigTable, botAutoTuneLogTable, withRetry } from "@workspace/db";
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
  applyStartupModeRestore, applyLockPrice090Migration, applyLockPrice093Bootstrap, applyLockPrice092Bootstrap, applyLockPrice082Migration, applyProximityCalibrationMigration, buildStreakSnapshot, restoreStreakState,
  applyQuietHoursAutoTuneDeltas, resolveEntryQuietHoursDecisionForSymbol,
  type BotConfig, type BotDecision, type CircuitBreakerState, type PriceRegime,
  type DecisionMode, type CoinStreakEntry, type QuietHoursAutoTuneDelta, type QuietHoursV2,
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
  computePerformanceReport, runAutoTuneRules, decrementPausedCoins, computeSymbolQuietHoursV2,
  mergeCalibratedSymbolQuietHours, PER_MARKET_QUIET_HOURS_MIN_BETS,
  type PerformanceReport, type AutoTuneMutation, type SettledBetRecord,
} from "./kalshi-bot-performance";
import {
  persistCoinStreakState, loadCoinStreakState, type StreakDbStore,
} from "./kalshi-bot-streak-db";
import {
  ensureRegularOrderIntentMigrations,
  hasActiveRegularExitIntent,
} from "./kalshi-regular-order-intent";
import { getPaperTradingBalance } from "./kalshi-daily-pnl";
import { AsyncSerialQueue } from "./async-serial-queue";
import {
  createSerializedAsyncOperation,
  smartHoursCalibrationMarker,
  shouldRunSmartHoursCatchUp,
} from "./kalshi-quiet-hours-scheduler";
import {
  S, openPositions, historicalExitRecoveryPositions, midExitedWindows, lastGuardStatesMap, lastGuardReasonMap,
  lastDecisionWindowKey, prefetchedTicker, windowBetCounts, windowTotalBets,
  windowBetDetails, windowDirectionCounts, windowFailedFills, windowZeroFillAttempts,
  pausedCoins, paperCoinDailyLoss, liveCoinDailyLoss, paperCoinStreakState,
  liveCoinStreakState, coinSlippageStrikes, recentWindowOutcomes, recentUnanimousOutcomes, windowCBBuffer,
  cachedPerformanceReportByMode, recentKalshiTargets, windowStabilityCache,
  paperStreakStore, liveStreakStore, makeStreakStore, streakStoreForMode,
  activeCoinDailyLoss, coinDailyLossForMode, activeCoinStreakState,
  coinStreakStateForMode, todayEastern, probeDb, resetDailyIfNeeded,
  REGIME_AGAINST_PENALTY_FALLBACK, CONTRARIAN_LIVE_REGIME_PENALTY,
  NOISE_CONFIDENCE_FLOOR, MIN_HARD_MODEL_SIGNALS, DB_DEGRADED_THRESHOLD,
  DB_DEGRADED_MIN_WINDOW_MS, REGIME_STRIKES_MAX, WINDOW_ENTRY_BUFFER_S,
  STABILITY_WAIT_MAX_S, COIN_YES_BLOCKED, COIN_FULLY_BLOCKED, TIMING_CACHE_TTL,
  type BotMode, type BotStatus, type OpenPosition, type OpenPositionDisplay,
  type BotStateSnapshot, type WindowCoinEvaluation, type ParoleState,
} from "./kalshi-bot-state";

const _botConfigPersistenceQueue = new AsyncSerialQueue();

async function _persistCurrentBotConfig(): Promise<Record<string, unknown>> {
  const snapshot = { ...S.config, mode: S.botMode } as Record<string, unknown>;
  await withRetry(() => db.execute(sql`
    INSERT INTO bot_config (id, config, updated_at)
    VALUES ('default', ${JSON.stringify(snapshot)}::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at
  `));
  return snapshot;
}

// Persist the current config + mode to the bot_config DB row. All config
// writers share one queue so an older slow write can never finish last and
// erase a newer operator change.
export async function _persistModeToConfig(): Promise<void> {
  try {
    await _botConfigPersistenceQueue.run(_persistCurrentBotConfig);
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
      const savedRecord = { ...(rows[0].config as Record<string, unknown>) };
      let removedLegacyStopLossConfig = false;
      for (const key of [
        "convictionStopLossFloor",
        "convictionStopLossActivationMinute",
        "convictionStopLossSuppressionMarginPct",
      ]) {
        if (!(key in savedRecord)) continue;
        delete savedRecord[key];
        removedLegacyStopLossConfig = true;
      }
      const saved = savedRecord as Partial<BotConfig> & { mode?: BotMode };
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
      if (removedLegacyStopLossConfig) {
        logger.warn("[kalshi-bot] removed retired legacy stop-loss settings from persisted config");
        _persistModeToConfig().catch(() => {});
      }

      // Backfill any mode-specific fields that are null in the stored config.
      // This prevents in-memory defaults from diverging from the DB value after
      // a mode switch (e.g. conviction sets kalshiLockPrice=0.90 in-memory via
      // BUILT_IN_MODE_DEFAULTS but the DB row may still have null if the row
      // predates the default or was written by an older build).
      // Write back to DB so future restarts and log queries always see the
      // effective value — eliminating "kalshiLockPrice: null" confusion.
      const mode = S.config.decisionMode;
      // One-time migration: conviction target moved back 0.91 → 0.90 so the
      // ±2¢ zone is [88¢, 92¢] (user requirement 2026-07-13: "88-92").
      // Pure helper (see kalshi-bot-engine-core.ts) — sets the flag on every
      // evaluated config so a later deliberate user value is never reverted.
      const migration = applyLockPrice090Migration(S.config);
      if (migration.migrated) {
        logger.info("[kalshi-bot] one-time migration: kalshiLockPrice 0.91 → 0.90 (zone [88¢, 92¢])");
      }
      if (migration.changed) {
        logger.info({ mode, kalshiLockPrice: S.config.kalshiLockPrice }, "[kalshi-bot] backfilled null mode defaults — persisting to DB");
        _persistModeToConfig().catch(() => {});
      }

      // One-time bootstrap: move 0.90 default → 0.93 user preference (zone [91¢, 95¢]).
      // Safe: only fires once (flag-guarded) and only if value is exactly at old default.
      const bootstrap = applyLockPrice093Bootstrap(S.config);
      if (bootstrap.bumped) {
        logger.info({ kalshiLockPrice: S.config.kalshiLockPrice }, "[kalshi-bot] bootstrap: kalshiLockPrice 0.90 → 0.93 (zone [91¢, 95¢]) — persisting");
        _persistModeToConfig().catch(() => {});
      } else if (bootstrap.changed) {
        // Flag was set for the first time but value was already custom — still persist the flag.
        _persistModeToConfig().catch(() => {});
      }

      // One-time bootstrap: 0.93 → 0.92 target (asymmetric zone [90¢, 95¢]).
      // Runs after the 093 bootstrap so a fresh install chains 0.90 → 0.93 → 0.92.
      const bootstrap092 = applyLockPrice092Bootstrap(S.config);
      if (bootstrap092.bumped) {
        logger.info({ kalshiLockPrice: S.config.kalshiLockPrice }, "[kalshi-bot] bootstrap: kalshiLockPrice 0.93 → 0.92 (zone [90¢, 95¢]) — persisting");
        _persistModeToConfig().catch(() => {});
      } else if (bootstrap092.changed) {
        _persistModeToConfig().catch(() => {});
      }

      // One-time migration: widen entry zone to 82¢–91¢.
      // If kalshiLockPrice ≥ 0.88 (old high-target semantics), resets to 0.82 (new floor).
      // Always bootstraps kalshiLockPriceCap to 0.91 if not set yet.
      const migration082 = applyLockPrice082Migration(S.config);
      if (migration082.changed) {
        logger.info(
          { kalshiLockPrice: S.config.kalshiLockPrice, kalshiLockPriceCap: S.config.kalshiLockPriceCap, migrated: migration082.migrated },
          "[kalshi-bot] migration: zone widened to 82¢–91¢ (independent floor + cap) — persisting",
        );
        _persistModeToConfig().catch(() => {});
      }

      // One-time migration: clamp drifted strike-proximity thresholds back to
      // the calibrated band (global ≤0.05%, per-coin ≤ calibrated suggestion).
      // The Aug-15 config update pushed thresholds to 0.05–0.06% while real
      // conviction-zone gaps are 0.01–0.06% — the gate blocked nearly every entry.
      const proximityMigration = applyProximityCalibrationMigration(S.config);
      if (proximityMigration.changed) {
        if (proximityMigration.clampedGlobal) {
          logger.info(
            {
              strikeProximityMinPct: S.config.strikeProximityMinPct,
              clampedGlobal: true,
            },
            "[kalshi-bot] migration: global strike-proximity threshold clamped back to calibrated band (per-coin overrides preserved) — persisting",
          );
        }
        _persistModeToConfig().catch(() => {});
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
    const today = todayEastern();
    // Filter by exitedAt date to match runtime behaviour: S.dailyPnl is incremented
    // in closePosition() (i.e. at exit time), so reconstruction must use the same
    // day bucket — exitedAt UTC date — not createdAt. This keeps daily state correct
    // even when a position opened before midnight and was closed after.
    //
    // IMPORTANT: filter to the current S.botMode so paper and live have fully
    // independent daily loss limits. Paper losses must not eat into the live
    // daily budget and vice versa.
    //
    const rows = await db
      .select({ pnl: kalshiBotBetsTable.pnl })
      .from(kalshiBotBetsTable)
      .where(
        and(
          isNotNull(kalshiBotBetsTable.exitedAt),
          isNull(kalshiBotBetsTable.archivedAt),
          eq(kalshiBotBetsTable.mode, S.botMode),
          sql`DATE(${kalshiBotBetsTable.exitedAt} AT TIME ZONE 'America/New_York') = ${today}`,
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
    const today = todayEastern();
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
          sql`DATE(${kalshiBotBetsTable.exitedAt} AT TIME ZONE 'America/New_York') = ${today}`,
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
    const resetAt = S.config.paperBalanceResetAt ?? null;
    const balance = await getPaperTradingBalance(startingBalance, resetAt);
    S.accountBalance = balance.accountBalance;
    logger.info(
      {
        startingBalance,
        regularPnl: balance.regularPnl,
        scalperPnl: balance.scalperPnl,
        accountBalance: S.accountBalance,
        resetAt,
      },
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
    await ensureRegularOrderIntentMigrations();
    // Use a 24-hour rolling window instead of a DATE equality so a position
    // opened just before UTC midnight is still found after a post-midnight restart.
    // Positions with unresolved live exits are never age-limited: they must be
    // hydrated so the loop can reconcile the durable broker lifecycle.
    const rows = await db
      .select()
      .from(kalshiBotBetsTable)
      .where(
        and(
          isNull(kalshiBotBetsTable.exitedAt),
          eq(kalshiBotBetsTable.action, "bet"),
          sql`(
            ${kalshiBotBetsTable.createdAt} >= NOW() - INTERVAL '24 hours'
            OR EXISTS (
              SELECT 1
                FROM kalshi_regular_exit_intents exit_intent
               WHERE exit_intent.mode = 'live'
                 AND exit_intent.position_id = ${kalshiBotBetsTable.id}
                 AND exit_intent.status IN ('reserved','unknown','filled')
            )
          )`,
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
        const hasActiveLiveExit = row.mode === "live"
          && await hasActiveRegularExitIntent("live", row.id);
        if (!hasActiveLiveExit) {
          // Ordinary expired rows remain evaluator-owned. Only a durable live
          // exit lifecycle justifies restoring an older-window position.
          logger.info(
            { id: row.id, symbol: row.symbol, windowKey, currentKey },
            "[kalshi-bot] recovered position window has expired — leaving for normal evaluator flow",
          );
          continue;
        }
        logger.warn(
          { id: row.id, symbol: row.symbol, windowKey, currentKey },
          "[kalshi-bot] restoring expired-window position with active live exit for reconciliation",
        );
      }

      const entryYesPrice = parseFloat(String(row.entryPrice));
      const direction = row.direction as "yes" | "no";

      const recoveredPosition: OpenPosition = {
        id: row.id,
        symbol: row.symbol,
        windowKey,
        ticker: row.ticker,
        direction,
        entryYesPrice,
        contractCount: Number(row.contractCount),
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
        entrySignals: (() => {
          const s = row.signals as Record<string, unknown> | null;
          if (!s) return undefined;
          const sa = s["statAbove"]; const ca = s["claudeAbove"]; const ma = s["mlAbove"];
          return {
            statAbove:   typeof sa === "boolean" ? sa : null,
            claudeAbove: typeof ca === "boolean" ? ca : null,
            mlAbove:     typeof ma === "boolean" ? ma : null,
          };
        })(),
      };

      if (windowKey === currentKey) {
        openPositions.set(row.symbol, recoveredPosition);
      } else {
        historicalExitRecoveryPositions.set(row.id, recoveredPosition);
      }

      logger.info(
        { id: row.id, symbol: row.symbol, windowKey, direction, entryYesPrice },
        windowKey === currentKey
          ? "[kalshi-bot] open position restored from DB — exit guard will resume on next tick"
          : "[kalshi-bot] historical live-exit position restored into reconciliation queue",
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
// ---------------------------------------------------------------------------
// Quiet-hours auto-tune
// ---------------------------------------------------------------------------

/**
 * Analyses live-bet win rates by UTC hour for the last N days, then
 * automatically silences hours below the threshold and unsilences hours that
 * have recovered above it.
 *
 * Rules:
 *  - Silence  : win rate < threshold AND ≥ MIN_BETS data points
 *  - Unsilence : win rate ≥ threshold AND ≥ MIN_BETS data points (and currently silenced)
 *  - Skip      : fewer than MIN_BETS bets — not enough data to act either way
 *
 * Threshold default 84.5 % (user rule: "84.5 is okay, 84 is not").
 */
const QH_MIN_BETS = 5;

// ---------------------------------------------------------------------------
// Per-symbol smart-hours auto-calibration
// ---------------------------------------------------------------------------

/** Rate-limit: skip per-symbol recompute when the same symbol ran within 5 min. */
const _symQHLastRecomputedAt = new Map<string, number>();
const _SYM_QH_RECOMPUTE_MIN_MS = 5 * 60_000;

/**
 * Recompute the per-symbol QuietHoursV2 schedule for one symbol from its
 * settled bet history, then update S.config.perSymbolQuietHours and persist.
 *
 * Triggered automatically after each bet is evaluated when
 * quietHoursMode === 'per_market'.  Rate-limited to once per 5 minutes per
 * symbol so a single busy eval cycle never causes a DB storm.
 */
export async function recomputeSymbolQuietHours(symbol: string): Promise<void> {
  const sym = symbol.toUpperCase();
  const now = Date.now();
  if (now - (_symQHLastRecomputedAt.get(sym) ?? 0) < _SYM_QH_RECOMPUTE_MIN_MS) return;
  _symQHLastRecomputedAt.set(sym, now);

  const qhv2 = S.config.quietHoursV2;
  const threshold = qhv2?.autoTuneThreshold ?? 40; // 40% win-rate floor (vs 84.5% for global auto-tune)
  const days = Math.min(90, Math.max(7, qhv2?.autoTuneDays ?? 30));

  try {
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
        and(
          eq(kalshiBotBetsTable.symbol, sym),
          sql`${kalshiBotBetsTable.outcome} IN ('win', 'loss')`,
          sql`${kalshiBotBetsTable.createdAt} >= NOW() - (${days} || ' days')::INTERVAL`,
          sql`archived_at IS NULL`,
        ),
      )
      .orderBy(asc(kalshiBotBetsTable.createdAt))
      .limit(500);

    const bets: SettledBetRecord[] = rows.map(r => ({
      symbol: r.symbol,
      direction: r.direction,
      pnl: r.pnl,
      exitReason: r.exitReason,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      exitedAt: r.exitedAt instanceof Date ? r.exitedAt.toISOString() : r.exitedAt != null ? String(r.exitedAt) : null,
      signals: (r.signals as Record<string, unknown>) ?? null,
      outcome: r.outcome,
      isMaxBet: r.isMaxBet ?? false,
    }));

    const newQhv2 = computeSymbolQuietHoursV2(
      bets,
      threshold,
      PER_MARKET_QUIET_HOURS_MIN_BETS,
    );
    newQhv2.calibratedAt = new Date().toISOString();
    const current = S.config.perSymbolQuietHours ?? {};
    // Apply ONLY calibration-owned schedule fields so user-set fields (autoTuneEnabled,
    // autoTuneIntervalHours, autoTuneDays, autoTuneThreshold, reducedByDow, DG overrides)
    // are preserved.  computeSymbolQuietHoursV2 hard-codes autoTuneEnabled:true, so
    // spreading the full result last would flip a user-disabled auto-tune back on.
    await updateBotConfig({
      perSymbolQuietHours: {
        ...current,
        [sym]: mergeCalibratedSymbolQuietHours(current[sym], newQhv2),
      },
    });
    logger.debug(
      { sym, betCount: bets.length, threshold, days },
      "[qh-per-symbol] per-symbol schedule recomputed",
    );
  } catch (err) {
    logger.warn({ err, sym }, "[qh-per-symbol] recomputeSymbolQuietHours failed (non-fatal)");
  }
}

const _ALL_PER_MARKET_SYMBOLS = ["BTC", "ETH", "XRP", "HYPE", "BNB", "SOL", "DOGE", "NEAR", "ZEC", "GOLD", "SILVER", "WTI", "COPPER", "NATGAS"];

/**
 * Force-recomputes quiet-hours schedules for ALL per-market symbols at once.
 * Uses up to 90 days of history (paper + live + dev — no mode filter) and a lower
 * three-bet calibration threshold so zero-to-two-bet cells stay data-gathering.
 * Bypasses the per-symbol rate-limit used by the incremental auto-trigger.
 */
export async function recomputeAllSymbolQuietHours(
  thresholdOverride?: number,
): Promise<{
  perSymbolQuietHours: Record<string, QuietHoursV2>;
  calibratedSymbols: string[];
  skippedSymbols: string[];
}> {
  // Calibration preserves an operator's per-symbol enable/disable selections.
  // It never activates enforcement; the global Smart Hours master is the sole
  // enforcement switch.
  const qhv2 = S.config.quietHoursV2;
  // Default to 84.5 (matches global auto-tune default and the grid's Silence threshold UI).
  // Callers may pass an explicit threshold — the API route forwards the client's chosen value.
  const threshold = thresholdOverride ?? qhv2?.autoTuneThreshold ?? 84.5;
  // Zero through two bets remain active under the data-collection cap.
  // The third settled bet is the first sample size eligible for calibration.
  const minBets = PER_MARKET_QUIET_HOURS_MIN_BETS;
  const days = 90;
  const calibratedAt = new Date().toISOString();

  const result: Record<string, QuietHoursV2> = {};
  const calibrated: string[] = [];
  const skipped: string[] = [];

  for (const sym of _ALL_PER_MARKET_SYMBOLS) {
    try {
      const rows = await db
        .select({
          symbol:    kalshiBotBetsTable.symbol,
          direction: kalshiBotBetsTable.direction,
          pnl:       kalshiBotBetsTable.pnl,
          exitReason:kalshiBotBetsTable.exitReason,
          createdAt: kalshiBotBetsTable.createdAt,
          exitedAt:  kalshiBotBetsTable.exitedAt,
          signals:   kalshiBotBetsTable.signals,
          outcome:   kalshiBotBetsTable.outcome,
          isMaxBet:  kalshiBotBetsTable.isMaxBet,
        })
        .from(kalshiBotBetsTable)
        .where(
          and(
            eq(kalshiBotBetsTable.symbol, sym),
            sql`${kalshiBotBetsTable.outcome} IN ('win', 'loss')`,
            sql`${kalshiBotBetsTable.createdAt} >= NOW() - (${days} || ' days')::INTERVAL`,
            sql`archived_at IS NULL`,
          ),
        )
        .orderBy(asc(kalshiBotBetsTable.createdAt))
        .limit(1000);

      const bets: SettledBetRecord[] = rows.map(r => ({
        symbol:    r.symbol,
        direction: r.direction,
        pnl:       r.pnl,
        exitReason:r.exitReason,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
        exitedAt:  r.exitedAt instanceof Date ? r.exitedAt.toISOString() : r.exitedAt != null ? String(r.exitedAt) : null,
        signals:   (r.signals as Record<string, unknown>) ?? null,
        outcome:   r.outcome,
        isMaxBet:  r.isMaxBet ?? false,
      }));

      const schedule = computeSymbolQuietHoursV2(bets, threshold, minBets);
      schedule.calibratedAt = calibratedAt;
      result[sym] = schedule;
      calibrated.push(sym);
      // Bump rate-limit cache so per-symbol auto-trigger won't re-run immediately
      _symQHLastRecomputedAt.set(sym, Date.now());
    } catch (err) {
      logger.warn({ err, sym }, "[qh-calibrate-all] failed for symbol (non-fatal)");
      skipped.push(sym);
    }
  }

  // mergedResult holds the persisted (user-merged) schedules for each calibrated symbol.
  // Declared in outer scope so it can be returned after the if-block.
  const mergedResult: Record<string, QuietHoursV2> = {};

  if (Object.keys(result).length > 0) {
    const current = S.config.perSymbolQuietHours ?? {};
    // Merge ONLY calibration-owned schedule fields so user-set fields (autoTuneEnabled,
    // autoTuneIntervalHours, autoTuneDays, autoTuneThreshold, reducedByDow, DG overrides)
    // are never overwritten.  computeSymbolQuietHoursV2 hard-codes autoTuneEnabled:true,
    // so spreading the full result last would silently flip a user-disabled auto-tune back on.
    const fullMerged: typeof current = { ...current };
    for (const [sym, cal] of Object.entries(result)) {
      const mergedEntry = mergeCalibratedSymbolQuietHours(current[sym], cal);
      fullMerged[sym] = mergedEntry;
      // Track only the calibrated entries (not the full psqh map) for the API response.
      mergedResult[sym] = mergedEntry;
    }
    await updateBotConfig({ perSymbolQuietHours: fullMerged });
  }

  logger.info({ calibrated, skipped }, "[qh-calibrate-all] bulk calibration complete");
  // Return the persisted merged schedules — not the raw calibration output — so the
  // client draft stays in sync with what was actually saved to DB (user-owned fields intact).
  return { perSymbolQuietHours: mergedResult, calibratedSymbols: calibrated, skippedSymbols: skipped };
}

// ---------------------------------------------------------------------------
// Shared Smart Hours calibration operation (manual button + hourly auto run)
// ---------------------------------------------------------------------------

/**
 * The single, canonical Smart Hours calibration used by BOTH the manual
 * "Refresh All Market Schedules" button and the automatic hourly UTC run.
 *
 * It preserves operator-owned fields and per-symbol enablement via
 * mergeCalibratedSymbolQuietHours over the freshest serialized config, then
 * stamps a durable per-UTC-hour marker on success so a duplicate run in the same
 * hour is skipped and a restart can catch up exactly once.
 *
 * All invocations funnel through one non-overlapping guard so a manual click and
 * the hourly boundary can never run concurrently.
 */
async function _runSmartHoursCalibrationInner(opts?: {
  thresholdOverride?: number;
  nowMs?: number;
}): Promise<{
  perSymbolQuietHours: Record<string, QuietHoursV2>;
  calibratedSymbols: string[];
  skippedSymbols: string[];
}> {
  const nowMs = opts?.nowMs ?? Date.now();
  // The threshold selected for a manual calibration is also the durable
  // threshold for every subsequent hourly/catch-up calibration. Persist it
  // before computing schedules so the operation and saved configuration can
  // never disagree, including after a restart.
  if (
    opts?.thresholdOverride !== undefined
    && S.config.quietHoursV2?.autoTuneThreshold !== opts.thresholdOverride
  ) {
    await updateBotConfig({
      quietHoursV2: {
        ...(S.config.quietHoursV2 ?? {
          enabled: false,
          silencedUtcHours: [],
          reducedBetUtcHours: {},
        }),
        autoTuneThreshold: opts.thresholdOverride,
      },
    });
  }
  const result = await recomputeAllSymbolQuietHours(opts?.thresholdOverride);
  const isCompleteRun = result.calibratedSymbols.length > 0 && result.skippedSymbols.length === 0;
  const configPatch = {
    ...(isCompleteRun && S.config.smartHoursCalibratedUtcHour !== smartHoursCalibrationMarker(nowMs)
      ? { smartHoursCalibratedUtcHour: smartHoursCalibrationMarker(nowMs) }
      : {}),
  };

  if (Object.keys(configPatch).length > 0) {
    await updateBotConfig(configPatch);
  }

  if (isCompleteRun) {
    const activeSymbols: string[] = [];
    const silencedSymbols: string[] = [];
    const reducedSymbols: string[] = [];
    const atCalibrationTime = new Date(nowMs);
    for (const sym of result.calibratedSymbols) {
      const decision = resolveEntryQuietHoursDecisionForSymbol(
        S.config,
        S.botMode,
        sym,
        atCalibrationTime,
      );
      if (decision.action === "block" || decision.qhMode === "silenced") {
        silencedSymbols.push(sym);
      } else if (decision.qhMode === "reduced") {
        reducedSymbols.push(sym);
      } else {
        activeSymbols.push(sym);
      }
    }
    logger.info(
      {
        marker: smartHoursCalibrationMarker(nowMs),
        threshold: S.config.quietHoursV2?.autoTuneThreshold ?? 84.5,
        activeSymbols,
        silencedSymbols,
        reducedSymbols,
      },
      "[qh-per-symbol] calibration committed for current UTC hour",
    );
  }

  // Stamp only a complete run. The manual endpoint may still return partial
  // results, but a restart in the same hour should retry any skipped market
  // rather than treating an incomplete automatic pass as fully calibrated.
  return result;
}

type SmartHoursCalibrationResult = {
  skipped: false;
  perSymbolQuietHours: Record<string, QuietHoursV2>;
  calibratedSymbols: string[];
  skippedSymbols: string[];
};

type SmartHoursCalibrationOptions = {
  thresholdOverride?: number;
  nowMs?: number;
  /** Retained for API compatibility. All callers are now durably serialized. */
  queueIfBusy?: boolean;
};

/**
 * Manual/auto execution queue. Every caller receives its own completion
 * promise and retains its requested threshold option. Redundant
 * automatic requests collapse at execution time once the current-hour marker
 * is already committed.
 */
const _enqueueSmartHoursCalibration = createSerializedAsyncOperation(
  async (opts: SmartHoursCalibrationOptions): Promise<SmartHoursCalibrationResult> => {
    const targetNowMs = opts.nowMs ?? Date.now();
    const isAutomaticRequest = opts.thresholdOverride === undefined;
    if (
      isAutomaticRequest
      && S.config.smartHoursCalibratedUtcHour === smartHoursCalibrationMarker(targetNowMs)
    ) {
      return {
        skipped: false,
        perSymbolQuietHours: S.config.perSymbolQuietHours ?? {},
        calibratedSymbols: Object.keys(S.config.perSymbolQuietHours ?? {}),
        skippedSymbols: [],
      };
    }
    const result = await _runSmartHoursCalibrationInner({
      thresholdOverride: opts.thresholdOverride,
      nowMs: targetNowMs,
    });
    return { skipped: false, ...result };
  }
);

export function runSmartHoursCalibrationCore(
  opts: SmartHoursCalibrationOptions = {},
): Promise<SmartHoursCalibrationResult> {
  return _enqueueSmartHoursCalibration(opts);
}

export async function runQuietHoursAutoTune(opts?: { force?: boolean }): Promise<void> {
  const qhv2 = S.config.quietHoursV2;
  // autoTuneEnabled defaults to true (undefined → on); set explicitly to false to disable.
  if (!qhv2?.enabled || qhv2.autoTuneEnabled === false) return;

  // Respect the configured interval (default 2h).  The scheduler polls every
  // 30 min so this guard prevents over-running during short-interval schedules.
  // Pass force:true to bypass this guard (e.g. manual "Run now" from the UI).
  if (!opts?.force) {
    const intervalHours = Math.max(1, Math.min(12, qhv2.autoTuneIntervalHours ?? 2));
    const intervalMs    = intervalHours * 60 * 60_000;
    if (S.autoTuneQHLastRunAt) {
      const elapsed = Date.now() - new Date(S.autoTuneQHLastRunAt).getTime();
      if (elapsed < intervalMs) return;
    }
  }

  const days      = Math.min(90, Math.max(1, qhv2.autoTuneDays      ?? 14));
  const threshold =                            qhv2.autoTuneThreshold ?? 84.5;

  // ── single query: DOW × hour, paper + live + shadow bets all included ───
  // DOW uses America/New_York so evening bets placed between 8 PM and
  // midnight ET are attributed to the correct calendar day rather than
  // rolling over to the next UTC day (which would silently misclassify them
  // under the wrong day of week for auto-tune decisions).
  // Hour stays as UTC — silencedByDow stores UTC hours and the frontend
  // converts them to ET for display via utcToEst().
  const result = await db.execute(sql`
    SELECT
      EXTRACT(DOW  FROM created_at AT TIME ZONE 'America/New_York')::int AS et_dow,
      EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int              AS utc_hour,
      COUNT(*)                                                            AS total_bets,
      COUNT(CASE WHEN outcome = 'win' THEN 1 END)                        AS wins
    FROM kalshi_bot_bets
    WHERE created_at >= NOW() - (${days} || ' days')::INTERVAL
      AND outcome IN ('win', 'loss')
      AND archived_at IS NULL
    GROUP BY et_dow, utc_hour
  `);

  interface HourStat { dow: number; hour: number; winRate: number | null; bets: number }
  const stats: HourStat[] = result.rows.map((r: Record<string, unknown>) => {
    const bets = Number(r.total_bets);
    const wins = Number(r.wins);
    return { dow: Number(r.et_dow), hour: Number(r.utc_hour), bets, winRate: bets > 0 ? (wins / bets) * 100 : null };
  });

  // ── compute per-day DELTAS (not a whole-map rewrite) ────────────────────
  // The DB aggregation above is async: the operator may toggle a slot in the
  // UI while it runs.  Computing deltas against the pre-query snapshot and
  // then MERGING them per-cell onto the freshest config (below) means a
  // concurrent manual toggle to any other cell can never be clobbered by
  // this write.  Overlapping cells: auto-tune's silence/unsilence for cells
  // it has ≥MIN_BETS data on still wins for those specific cells only.
  const snapshotByDow = qhv2.silencedByDow ?? {};
  const deltas: Record<string, QuietHoursAutoTuneDelta> = {};
  let totalSilenced   = 0;
  let totalUnsilenced = 0;

  for (let dow = 0; dow <= 6; dow++) {
    const dowStats = stats.filter(s => s.dow === dow);
    // Only configure a day when it has ≥1 hour with enough data
    if (!dowStats.some(s => s.bets >= QH_MIN_BETS)) continue;

    const currentSilenced = new Set<number>(snapshotByDow[String(dow)] ?? []);
    const toSilence   = dowStats.filter(s => s.bets >= QH_MIN_BETS && s.winRate !== null && s.winRate  < threshold && !currentSilenced.has(s.hour)).map(s => s.hour);
    const toUnsilence = dowStats.filter(s => s.bets >= QH_MIN_BETS && s.winRate !== null && s.winRate >= threshold &&  currentSilenced.has(s.hour)).map(s => s.hour);

    // Always record the day as configured (even with empty deltas) so the
    // flat-fallback intersection includes every day auto-tune has data for.
    deltas[String(dow)] = { silence: toSilence, unsilence: toUnsilence };
    totalSilenced   += toSilence.length;
    totalUnsilenced += toUnsilence.length;
  }

  S.autoTuneQHLastRunAt = new Date().toISOString();
  // arrays hold dummy values — UI only inspects .length for display counts
  S.autoTuneQHLastChanges = {
    silenced:   new Array(totalSilenced).fill(0),
    unsilenced: new Array(totalUnsilenced).fill(0),
  };

  if (totalSilenced === 0 && totalUnsilenced === 0) {
    logger.info({ threshold, days }, "[qh-autotune] no per-day changes needed");
    return;
  }

  // Re-read the FRESHEST config at write time (S.config may have changed while
  // the aggregation query ran) and apply only the per-cell deltas onto it.
  const freshQhv2 = S.config.quietHoursV2 ?? qhv2;
  const merged = applyQuietHoursAutoTuneDeltas(
    freshQhv2.silencedByDow ?? {},
    deltas,
    freshQhv2.silencedUtcHours,
  );

  await updateBotConfig({
    quietHoursV2: { ...freshQhv2, silencedByDow: merged.silencedByDow, silencedUtcHours: merged.silencedUtcHours },
  });
  logger.info(
    { totalSilenced, totalUnsilenced, configuredDays: Object.keys(merged.silencedByDow).length, threshold, days },
    "[qh-autotune] per-day applied",
  );
}

export async function updateBotConfig(partial: Partial<BotConfig>): Promise<{ config: BotConfig; persisted: boolean }> {
  const modeSpecific: Partial<BotConfig> = {};
  if ("decisionMode" in partial && partial.decisionMode) {
    if (S.botMode === "paper") modeSpecific.paperDecisionMode = partial.decisionMode;
    else modeSpecific.liveDecisionMode = partial.decisionMode;
  }
  S.config = { ...S.config, ...partial, ...modeSpecific };
  let snapshot = { ...S.config };
  let persisted = false;
  try {
    const stored = await _botConfigPersistenceQueue.run(_persistCurrentBotConfig);
    const { mode: _persistedMode, ...persistedConfig } = stored;
    snapshot = persistedConfig as unknown as BotConfig;
    persisted = true;
  } catch (err) {
    logger.error({ err }, "[kalshi-bot] failed to persist config to DB");
  }
  if ("paperStartingBalance" in partial || "paperBalanceResetAt" in partial) {
    await loadPaperBalanceFromDB().catch(() => {});
  }
  // Sync the conviction price poller whenever decisionMode may have changed.
  // Lazy import avoids a circular dependency chain (poller → state → db → poller).
  if ("decisionMode" in partial || "enabled" in partial) {
    const { syncConvictionPoller } = await import("./kalshi-conviction-poller");
    syncConvictionPoller();
  }
  return { config: snapshot, persisted };
}
