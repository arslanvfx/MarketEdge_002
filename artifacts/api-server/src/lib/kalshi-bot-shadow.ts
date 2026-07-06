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
import { updateBotConfig } from "./kalshi-bot-db";

// ---------------------------------------------------------------------------
// Closed-bet evaluator — wires outcome + evaluatedAt for settled positions
// ---------------------------------------------------------------------------

/**
 * Fetch the 1-minute close price at the END of a 15-minute window from
 * Coinbase historical candles.  The window key is "YYYY-MM-DDTHH:mm" (UTC).
 * The window ends at windowStart + 15 min; the last 1-min candle in that window
 * starts at windowEnd - 60 s (Coinbase reports `t` = candle start time).
 * Returns null on any error so the caller can retry next cycle.
 */
export async function fetchWindowClosePrice(product: string, windowKey: string): Promise<number | null> {
  try {
    const COINBASE = "https://api.exchange.coinbase.com";
    const UA = "MarketEdge/1.0 (crypto-predictor)";

    const windowStartMs = new Date(windowKey + ":00Z").getTime();
    if (isNaN(windowStartMs)) return null;

    const windowEndMs   = windowStartMs + 15 * 60_000;
    const candleStartMs = windowEndMs - 60_000; // last 1-min candle in the window

    const url =
      `${COINBASE}/products/${encodeURIComponent(product)}/candles?granularity=60` +
      `&start=${new Date(candleStartMs).toISOString()}` +
      `&end=${new Date(windowEndMs).toISOString()}`;

    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;

    // Coinbase format (newest-first): [time, low, high, open, close, volume]
    const raw = (await res.json()) as number[][];
    if (!Array.isArray(raw) || raw.length === 0) return null;

    // Prefer the candle whose start time matches the expected slot; fall back
    // to the first returned candle (Coinbase may return a candle slightly off).
    const targetT = Math.floor(candleStartMs / 1000);
    const candle = raw.find((c) => c[0] === targetT) ?? raw[0];
    return candle[4]; // close price
  } catch {
    return null;
  }
}

/**
 * For every closed bet row that has not yet been evaluated (evaluatedAt IS NULL
 * and exitedAt IS NOT NULL), determine the true outcome and write outcome +
 * corrected pnl + evaluatedAt to the DB.
 *
 * - "expired" bets: fetch the actual candle close price from Coinbase at the
 *   window settlement boundary, compare against the Kalshi strike, and compute
 *   the correct pnl based on contract settlement ($1 per contract if won, $0 if lost).
 * - "exit" / "late_recovery_exit" bets: pnl was already derived from the real
 *   Kalshi exit price at trade time, so it is authoritative.  We only need to
 *   stamp outcome and evaluatedAt.
 *
 * Rows that cannot be resolved this cycle (missing price data, Coinbase error,
 * etc.) are skipped and retried on the next 30-second tick.
 */
// How long to wait before committing the full-loss fallback for expired rows
// where BOTH the Coinbase candle AND the cached coin price are unavailable.
// Coinbase publishes 1-min candles within seconds of the candle close, so
// 90 s is already conservative.  We only hit this path when Coinbase itself
// is slow or the coin is not listed there (e.g. BNB).
export const EVAL_DEFER_MS = 90_000; // 90 seconds

// ---------------------------------------------------------------------------
// Shadow bet helpers
// ---------------------------------------------------------------------------

/**
 * Record a shadow (probe) bet: a virtual bet that fires when a coin would have
 * been traded normally but was blocked by a restriction gate.  No Kalshi order
 * is placed.  The outcome is evaluated at window close against the real price
 * and feeds checkAllParoles() which can lift the corresponding restriction.
 *
 * Shadow bets are completely isolated from all real-bet state — they never
 * touch openPositions, recentWindowOutcomes, P&L, balance guards, or streak
 * counters.  The deterministic ID (includes blockedBy) allows one shadow per
 * coin × window × mode × restriction — silently ignores re-recording.
 *
 * @param blockedBy  The restriction gate that blocked this bet.  Stored in
 *   signals.blockedBy so checkAllParoles can aggregate accuracy per restriction.
 */
export async function recordShadowBet(
  sym: string,
  direction: "yes" | "no",
  confidence: number,
  signals: unknown,
  kalshiTarget: number | null,
  windowKey: string,
  mode: BotMode,
  ticker: string | null,
  blockedBy: string,
): Promise<void> {
  // Deterministic ID: one shadow bet per (coin, window, mode, restriction).
  const id = `shadow:${sym}:${windowKey}:${mode}:${blockedBy}`;
  const enrichedSignals = {
    ...(signals as Record<string, unknown> ?? {}),
    blockedBy,
  };
  try {
    await db
      .insert(kalshiBotBetsTable)
      .values({
        id,
        symbol: sym,
        windowKey,
        ticker: ticker ?? null,
        direction,
        action: "shadow",
        mode,
        signals: enrichedSignals,
        kalshiTarget: kalshiTarget != null ? String(kalshiTarget) : null,
        source: "bot",
      })
      .onConflictDoNothing(); // idempotent — silently skip re-recording
    logger.info(
      { sym, direction, confidence, windowKey, mode, blockedBy },
      `[shadow-bet] probe recorded — ${blockedBy}`,
    );
  } catch (err) {
    logger.warn({ err, sym, windowKey, blockedBy }, "[shadow-bet] failed to record (non-fatal)");
  }
}

/**
 * Evaluate shadow bets from prior windows that have not yet been assessed.
 * For each, fetch the window close price, determine if the direction was
 * correct, and stamp outcome + evaluatedAt.
 *
 * Shadow outcomes MUST NOT update recentWindowOutcomes — that map is real-bets-only.
 * They also must not touch P&L, balance, or streak state.
 *
 * After evaluating new rows, the shadow parole cache is invalidated so the
 * next parole check reflects fresh accuracy data.
 */
export async function evalShadowBets(): Promise<void> {
  try {
    const currentKey = currentWindowKey();
    const rows = await db
      .select({
        id: kalshiBotBetsTable.id,
        symbol: kalshiBotBetsTable.symbol,
        windowKey: kalshiBotBetsTable.windowKey,
        ticker: kalshiBotBetsTable.ticker,
        direction: kalshiBotBetsTable.direction,
        kalshiTarget: kalshiBotBetsTable.kalshiTarget,
        signals: kalshiBotBetsTable.signals,
      })
      .from(kalshiBotBetsTable)
      .where(
        and(
          eq(kalshiBotBetsTable.action, "shadow"),
          isNull(kalshiBotBetsTable.evaluatedAt),
          sql`${kalshiBotBetsTable.windowKey} < ${currentKey}`,
        ),
      )
      .limit(20);

    if (rows.length === 0) return;

    let evaluated = 0;
    for (const row of rows) {
      const coin = CRYPTO_COINS.find((c) => c.symbol === row.symbol);
      if (!coin || !row.windowKey || !row.direction) continue;
      const strike = row.kalshiTarget != null ? parseFloat(String(row.kalshiTarget)) : null;
      if (strike == null) continue;

      let outcome: "win" | "loss";
      let evalSource: "kalshi" | "coinbase";
      const updatedSignals: Record<string, unknown> = {
        ...(row.signals as Record<string, unknown> ?? {}),
      };

      // ── 1. Try Kalshi settlement (authoritative — CF Benchmarks RTI) ────────
      // Same source as real bets: avoids Coinbase-vs-RTI discrepancies near strike.
      if (row.ticker) {
        const settled = await fetchKalshiMarketResult(row.ticker);
        if (settled.result === "yes" || settled.result === "no") {
          const won = row.direction === "yes"
            ? settled.result === "yes"
            : settled.result === "no";
          outcome = won ? "win" : "loss";
          evalSource = "kalshi";
          updatedSignals.kalshiResult = settled.result;
          updatedSignals.evalSource = "kalshi";
          logger.info(
            { sym: row.symbol, windowKey: row.windowKey, ticker: row.ticker, direction: row.direction, kalshiResult: settled.result, outcome },
            "[shadow-bet] evaluated via Kalshi RTI (authoritative)",
          );
        } else {
          // Kalshi hasn't settled yet — defer until next tick.
          logger.debug({ sym: row.symbol, windowKey: row.windowKey, ticker: row.ticker },
            "[shadow-bet] Kalshi not yet settled — deferring evaluation");
          continue;
        }
      } else {
        // ── 2. No ticker stored — fall back to Coinbase candle close ──────────
        // If the candle isn't available yet, defer rather than risk a wrong label.
        const closePrice = await fetchWindowClosePrice(coin.product, row.windowKey);
        if (closePrice === null) {
          logger.debug({ sym: row.symbol, windowKey: row.windowKey },
            "[shadow-bet] close price unavailable — deferring evaluation");
          continue;
        }
        const priceAboveStrike = closePrice >= strike;
        const won = row.direction === "yes" ? priceAboveStrike : !priceAboveStrike;
        outcome = won ? "win" : "loss";
        evalSource = "coinbase";
        updatedSignals.closePriceAtEval = closePrice;
        updatedSignals.evalSource = "coinbase";
        logger.info(
          { sym: row.symbol, windowKey: row.windowKey, direction: row.direction, closePrice, strike, outcome },
          "[shadow-bet] evaluated via Coinbase candle (no ticker — fallback)",
        );
      }

      const now = new Date();
      await withRetry(() =>
        db
          .update(kalshiBotBetsTable)
          .set({ outcome, exitedAt: now, evaluatedAt: now, signals: updatedSignals })
          .where(eq(kalshiBotBetsTable.id, row.id))
      );

      logger.info(
        { sym: row.symbol, windowKey: row.windowKey, direction: row.direction, outcome, evalSource },
        `[shadow-bet] evaluated — ${outcome}`,
      );
      evaluated++;
    }

    if (evaluated > 0) {
      // Invalidate parole cache so next parole check picks up fresh accuracy.
      S._shadowParoleCache = null;
      logger.info({ evaluated }, "[shadow-bet] evaluation batch complete");
    }
  } catch (err) {
    logger.warn({ err }, "[shadow-bet] evalShadowBets error (non-fatal)");
  }
}

/**
 * Compute per-restriction parole bypasses for the current tick.
 *
 * Queries all evaluated shadow bets from the last 3 windows, groups them by
 * (symbol, blockedBy), and applies the parole threshold (≥60% WR / ≥3 bets)
 * independently for each restriction type.  Returns a ParoleState whose fields
 * are used throughout the per-coin Phase-3 loop to bypass the corresponding
 * gates.
 *
 * Side effects (when parole threshold is met):
 *   - "auto_tune"    → reverts the temporary confidence raise in S.config + DB
 *   - "streak_pause" → clears pauseUntilWindowKey in-memory + DB for paroled coins
 *
 * Result is cached by (totalEvaluated, windowCutoff, mode) and invalidated by
 * evalShadowBets() whenever new shadow outcomes are stamped.
 */
export async function checkAllParoles(
  mode: BotMode,
  streakMap: Map<string, { consecutiveLosses: number; pauseUntilWindowKey: string | null }>,
  streakStore: StreakDbStore,
): Promise<ParoleState> {
  const empty: ParoleState = {
    doubtPenaltyReduction: 0,
    unanimousFailurePenaltyReduction: 0,
    reversing: new Set(),
    momentum: new Set(),
    priceBandYes: new Set(),
    priceBandNo: new Set(),
    yesBelowStrike: new Set(),
    hardModel: new Set(),
    noGate: new Set(),
    regime: new Set(),
    contrarian: new Set(),
    border: new Set(),
    yesBlocked: new Set(),
    fullyBlocked: new Set(),
    nearStrike: new Set(),
    dirCapIncrease: 0,
  };

  try {
    // Rolling window: last 3 × 15-min windows (~45 min).
    // Prevents stale historical probes from influencing current-lockout decisions.
    const nowMs = Date.now();
    const windowCutoff = new Date(
      Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000) - 3 * 15 * 60_000
    ).toISOString().slice(0, 16);

    // Query per (symbol, blockedBy) — one row per restriction type per coin.
    const rows = await db
      .select({
        symbol: kalshiBotBetsTable.symbol,
        blockedBy: sql<string>`${kalshiBotBetsTable.signals}->>'blockedBy'`,
        evaluated: sql<number>`(COUNT(*) FILTER (WHERE ${kalshiBotBetsTable.outcome} IN ('win','loss')))::int`,
        wins: sql<number>`(COUNT(*) FILTER (WHERE ${kalshiBotBetsTable.outcome} = 'win'))::int`,
      })
      .from(kalshiBotBetsTable)
      .where(
        and(
          eq(kalshiBotBetsTable.action, "shadow"),
          isNotNull(kalshiBotBetsTable.evaluatedAt),
          sql`${kalshiBotBetsTable.windowKey} >= ${windowCutoff}`,
          eq(kalshiBotBetsTable.mode, mode),
        ),
      )
      .groupBy(
        kalshiBotBetsTable.symbol,
        sql`${kalshiBotBetsTable.signals}->>'blockedBy'`,
      );

    const totalEvaluated = rows.reduce((s, r) => s + (r.evaluated ?? 0), 0);

    // Cache hit: same data, same window, same mode — skip recompute.
    if (
      S._shadowParoleCache &&
      S._shadowParoleCache.evaluatedCount === totalEvaluated &&
      S._shadowParoleCache.windowCutoff === windowCutoff &&
      S._shadowParoleCache.mode === mode
    ) {
      return S._shadowParoleCache.state;
    }

    const result: ParoleState = { ...empty };

    const streakToResume: string[] = [];
    const autoTunePauseToResume: string[] = [];

    for (const row of rows) {
      const { symbol: sym, blockedBy, evaluated, wins } = row;
      if (!blockedBy || !sym || !evaluated || evaluated < 3) continue;
      const winRate = (wins ?? 0) / evaluated;

      if (winRate < 0.6) {
        if (winRate < 0.4 && evaluated >= 5) {
          logger.warn(
            { sym, blockedBy, winRate: `${(winRate * 100).toFixed(0)}%`, evaluated },
            `[parole] ${blockedBy}/${sym} shadow accuracy ${(winRate * 100).toFixed(0)}% < 40% — restriction maintained`,
          );
        }
        continue;
      }

      // ≥60% WR with ≥3 bets — parole granted for this (sym, restriction) pair.
      logger.info(
        { sym, blockedBy, winRate: `${(winRate * 100).toFixed(0)}%`, evaluated },
        `[parole] ${blockedBy}/${sym} ≥60% accuracy — bypass granted`,
      );

      switch (blockedBy) {
        case "doubt_penalty":
          result.doubtPenaltyReduction = Math.max(result.doubtPenaltyReduction, 4);
          break;
        case "unanimous_failure_guard":
          result.unanimousFailurePenaltyReduction = Math.max(result.unanimousFailurePenaltyReduction, 3);
          break;
        case "near_strike_ev_filter":
          result.nearStrike.add(sym);
          break;
        case "auto_tune":
          // Side effect handled below after the loop.
          break;
        case "auto_tune_pause":      autoTunePauseToResume.push(sym); break;
        case "reversing_caution":    result.reversing.add(sym);    break;
        case "momentum_override":    result.momentum.add(sym);     break;
        case "price_band_yes":       result.priceBandYes.add(sym); break;
        case "price_band_no":        result.priceBandNo.add(sym);  break;
        case "yes_below_strike":     result.yesBelowStrike.add(sym); break;
        case "hard_model":           result.hardModel.add(sym);    break;
        case "no_gate":              result.noGate.add(sym);       break;
        case "regime_penalty":       result.regime.add(sym);       break;
        case "contrarian_penalty":   result.contrarian.add(sym);   break;
        case "border_guard":         result.border.add(sym);       break;
        case "coin_yes_blocked":
          // Same pattern as coin_fully_blocked — remove from the mutable set so
          // both the Phase-3 loop guard and the _runBotTick defence-in-depth
          // guard are cleared at once.  Re-added on next server restart.
          result.yesBlocked.add(sym);
          COIN_YES_BLOCKED.delete(sym);
          logger.info(
            { sym, winRate: `${(winRate * 100).toFixed(0)}%`, evaluated },
            "[parole] coin_yes_blocked cleared — YES bets re-enabled by shadow accuracy",
          );
          break;
        case "coin_fully_blocked":
          // Parole removes the coin from the mutable COIN_FULLY_BLOCKED set so
          // both the Phase-3 loop guard and the _runBotTick defence-in-depth
          // guard are cleared at once — mirrors the pausedCoins pattern used
          // for auto_tune_pause.  Re-added on next server restart so shadow
          // data re-accumulates before the coin can re-parole.
          result.fullyBlocked.add(sym);
          COIN_FULLY_BLOCKED.delete(sym);
          logger.info(
            { sym, winRate: `${(winRate * 100).toFixed(0)}%`, evaluated },
            "[parole] coin_fully_blocked cleared — coin re-enabled by shadow accuracy",
          );
          break;
        case "streak_pause":         streakToResume.push(sym);     break;
        case "direction_cap":
          result.dirCapIncrease = Math.min(result.dirCapIncrease + 1, 2);
          break;
        default:
          // yes_quality_gate, no_quality_gate, chop_filter — track accuracy only,
          // no structural bypass (signal contradictions indicate data quality issues).
          break;
      }
    }

    // ── Auto-tune early revert ────────────────────────────────────────────────
    const autoTuneParoled = rows.some(
      r => r.blockedBy === "auto_tune" && (r.evaluated ?? 0) >= 3 && ((r.wins ?? 0) / (r.evaluated ?? 1)) >= 0.6,
    );
    if (autoTuneParoled && S.config.autoTuneConfidenceRevertTo != null) {
      const revertTo = S.config.autoTuneConfidenceRevertTo;
      logger.info(
        { from: S.config.minConfidence, to: revertTo },
        "[parole] auto_tune shadow ≥60% — reverting confidence raise early",
      );
      await updateBotConfig({
        minConfidence: revertTo,
        autoTuneConfidenceRevertAt: null,
        autoTuneConfidenceRevertTo: null,
      }).catch(err => logger.warn({ err }, "[parole] auto-tune early revert failed (non-fatal)"));
    }

    // ── Streak-pause clearance ────────────────────────────────────────────────
    // Clear in-memory pause + persist to DB for any coin paroled from streak_pause.
    for (const sym of streakToResume) {
      const entry = streakMap.get(sym);
      if (entry?.pauseUntilWindowKey) {
        logger.info(
          { sym, pauseUntilWindowKey: entry.pauseUntilWindowKey },
          "[parole] streak_pause cleared by shadow accuracy — coin re-enabled",
        );
        entry.pauseUntilWindowKey = null;
        streakMap.set(sym, entry);
      }
    }
    if (streakToResume.length > 0) {
      persistCoinStreakState(streakMap, streakStore).catch(err =>
        logger.warn({ err }, "[parole] streak-pause DB persist failed (non-fatal)"),
      );
    }

    // ── Auto-tune pause clearance ─────────────────────────────────────────────
    // Clear pausedCoins in-memory for any coin whose shadow accuracy (while paused)
    // reached ≥60% over ≥3 evaluated bets. No DB persist needed — pausedCoins is
    // rebuilt from scratch on restart, and the window-by-window countdown handles
    // the normal expiry path.
    for (const sym of autoTunePauseToResume) {
      if (pausedCoins.has(sym)) {
        logger.info(
          { sym, remaining: pausedCoins.get(sym) },
          "[parole] auto_tune_pause cleared by shadow accuracy — coin re-enabled early",
        );
        pausedCoins.delete(sym);
      }
    }

    // ── Doubt penalty reduction log ───────────────────────────────────────────
    if (result.doubtPenaltyReduction > 0) {
      logger.info(
        { reduction: result.doubtPenaltyReduction, windowCutoff },
        `[parole] doubt_penalty shadow accuracy sufficient — penalty -${result.doubtPenaltyReduction}pp`,
      );
    }

    S._shadowParoleCache = { state: result, evaluatedCount: totalEvaluated, windowCutoff, mode };
    return result;
  } catch (err) {
    logger.warn({ err }, "[parole] checkAllParoles error (non-fatal)");
    return empty;
  }
}

