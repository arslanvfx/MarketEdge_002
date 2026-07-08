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
import { EVAL_DEFER_MS, fetchWindowClosePrice } from "./kalshi-bot-shadow";
import { tagBotEntryTimingOutcomes, recoverBotEntryTimingSnapshots } from "./kalshi-bot-entry-timing";

export async function evalClosedBets(): Promise<void> {
  const deferCutoff = new Date(Date.now() - EVAL_DEFER_MS);

  try {
    // ── Step 0: transition orphaned open-bet rows from expired windows ────────
    // A row with action='bet' and exitedAt IS NULL whose windowKey is older than
    // the current window is an orphaned position — it was open when the server
    // restarted during an active window but the window has since expired.
    // These rows are invisible to the main evaluation query (which requires
    // exitedAt IS NOT NULL), so we must first mark them as 'expired' to make
    // them eligible for outcome evaluation on the next cycle.
    // windowKey strings are ISO-formatted ("YYYY-MM-DDTHH:mm") so lexicographic
    // ordering gives correct chronological ordering.
    const currentKey = currentWindowKey();
    const orphanedBets = await db
      .select({
        id: kalshiBotBetsTable.id,
        symbol: kalshiBotBetsTable.symbol,
        windowKey: kalshiBotBetsTable.windowKey,
      })
      .from(kalshiBotBetsTable)
      .where(
        and(
          isNull(kalshiBotBetsTable.exitedAt),
          eq(kalshiBotBetsTable.action, "bet"),
          sql`${kalshiBotBetsTable.windowKey} < ${currentKey}`,
        ),
      );

    for (const orphan of orphanedBets) {
      logger.info(
        { id: orphan.id, symbol: orphan.symbol, windowKey: orphan.windowKey, currentKey },
        "[kalshi-bot] evalClosedBets: transitioning orphaned expired bet row",
      );
      await withRetry(() =>
        db
          .update(kalshiBotBetsTable)
          .set({ action: "expired", exitedAt: new Date() })
          .where(eq(kalshiBotBetsTable.id, orphan.id))
      );
    }

    const rows = await db
      .select({
        id: kalshiBotBetsTable.id,
        symbol: kalshiBotBetsTable.symbol,
        windowKey: kalshiBotBetsTable.windowKey,
        ticker: kalshiBotBetsTable.ticker,
        direction: kalshiBotBetsTable.direction,
        action: kalshiBotBetsTable.action,
        mode: kalshiBotBetsTable.mode,
        pnl: kalshiBotBetsTable.pnl,
        kalshiTarget: kalshiBotBetsTable.kalshiTarget,
        contractCount: kalshiBotBetsTable.contractCount,
        entryPrice: kalshiBotBetsTable.entryPrice,
        betAmount: kalshiBotBetsTable.betAmount,
        exitedAt: kalshiBotBetsTable.exitedAt,
        cryptoPriceAtExit: kalshiBotBetsTable.cryptoPriceAtExit,
        signals: kalshiBotBetsTable.signals,
        source: kalshiBotBetsTable.source,
      })
      .from(kalshiBotBetsTable)
      .where(
        and(
          isNotNull(kalshiBotBetsTable.exitedAt),
          isNull(kalshiBotBetsTable.evaluatedAt),
          sql`${kalshiBotBetsTable.action} IN ('exit','late_recovery_exit','expired')`,
        ),
      )
      .orderBy(asc(kalshiBotBetsTable.windowKey)) // chronological order for correct streak sequencing
      .limit(20); // process in small batches — each expired row makes a network call

    if (rows.length === 0) return;

    let evaluated = 0;
    for (const row of rows) {
      let outcome: "win" | "loss" | "push" = "loss"; // always overwritten before use; TS needs initialization
      let correctedPnl: number | null = null;
      let closePrice: number | null = null;

      if (row.action === "expired") {
        // ── Settlement evaluation ─────────────────────────────────────────────
        // Priority order:
        //   1. Kalshi's own settlement result (authoritative — Kalshi settles via
        //      CF Benchmarks RTI which differs from Coinbase candle close prices).
        //   2. Coinbase 1-min candle close at the window boundary (legacy fallback).
        //   3. cryptoPriceAtExit (live ticker captured at expiry — last resort).
        //   4. Full-loss fallback after 90-s deferral (ensures row never gets stuck).
        const coin = CRYPTO_COINS.find((c) => c.symbol === row.symbol);
        if (!coin || !row.windowKey || row.direction == null) continue;

        const strike = row.kalshiTarget != null ? parseFloat(String(row.kalshiTarget)) : null;
        const entryPrice = row.entryPrice != null ? parseFloat(String(row.entryPrice)) : null;
        const count = row.contractCount ?? 1;
        if (strike == null || entryPrice == null) continue;

        // ── Step 1: Kalshi settlement result (primary — no price comparison needed) ──
        let kalshiSettled = false;
        if (row.ticker) {
          const settled = await fetchKalshiMarketResult(row.ticker);
          if (settled.result === "yes" || settled.result === "no") {
            const won = row.direction === "yes"
              ? settled.result === "yes"
              : settled.result === "no";
            outcome = won ? "win" : "loss";
            const ep = entryPrice;
            const n  = count;
            if (row.mode === "live") {
              correctedPnl = won
                ? (row.direction === "yes" ? (1 - ep) * n : ep * n)
                : (row.direction === "yes" ? -ep * n       : -(1 - ep) * n);
            } else {
              const betAmt = row.betAmount != null ? parseFloat(String(row.betAmount)) : ep * n;
              correctedPnl = won ? betAmt * 0.50 : -betAmt;
            }
            logger.info(
              { sym: row.symbol, windowKey: row.windowKey, ticker: row.ticker, kalshiResult: settled.result, direction: row.direction, outcome, pnl: correctedPnl },
              "[kalshi-bot] evalClosedBets: expired bet settled via Kalshi result (authoritative)",
            );
            kalshiSettled = true;
          } else {
            logger.debug(
              { sym: row.symbol, id: row.id, ticker: row.ticker, status: settled.status },
              "[kalshi-bot] evalClosedBets: Kalshi market not yet settled — falling back to Coinbase candle",
            );
          }
        }

        if (!kalshiSettled) {
          // ── Step 2: Coinbase 1-min candle close (legacy fallback) ─────────────
          // Coinbase publishes 1-min candles within seconds of close, so this
          // succeeds on the first or second 30-s tick after the window ends.
          closePrice = await fetchWindowClosePrice(coin.product, row.windowKey);

          // ── Step 3: cryptoPriceAtExit (live ticker captured at expiry) ────────
          if (closePrice === null && row.cryptoPriceAtExit != null) {
            closePrice = parseFloat(String(row.cryptoPriceAtExit));
            logger.info(
              { sym: row.symbol, id: row.id, windowKey: row.windowKey, closePrice },
              "[kalshi-bot] evalClosedBets: Coinbase candle unavailable — using cryptoPriceAtExit as close price",
            );
          }

          if (closePrice === null) {
            // ── Step 4: defer / full-loss fallback ──────────────────────────────
            const noCoinPriceAtExit = row.cryptoPriceAtExit == null;
            const exitedAt = row.exitedAt instanceof Date
              ? row.exitedAt
              : row.exitedAt != null ? new Date(row.exitedAt as string) : null;
            const pastDeferWindow = exitedAt == null || exitedAt <= deferCutoff;

            if (!pastDeferWindow) {
              logger.debug(
                { sym: row.symbol, id: row.id, exitedAt, noCoinPriceAtExit },
                "[kalshi-bot] evalClosedBets: candle not yet available — deferring (within 90-s window)",
              );
              continue;
            }

            const fallbackPnl = row.pnl != null ? parseFloat(String(row.pnl)) : null;
            if (fallbackPnl == null) continue;
            const fallbackOutcome: "win" | "loss" | "push" =
              fallbackPnl > 0 ? "win" : fallbackPnl < 0 ? "loss" : "push";
            logger.warn(
              { sym: row.symbol, id: row.id, windowKey: row.windowKey, pnl: fallbackPnl },
              "[kalshi-bot] evalClosedBets: committing full-loss fallback — no price source after 90-s deferral; outcome may be inaccurate",
            );
            await withRetry(() =>
              db
                .update(kalshiBotBetsTable)
                .set({ outcome: fallbackOutcome, evaluatedAt: new Date() })
                .where(eq(kalshiBotBetsTable.id, row.id))
            );
            evaluated++;
            continue;
          }

          const priceAboveStrike = closePrice >= strike;
          const won = row.direction === "yes" ? priceAboveStrike : !priceAboveStrike;
          outcome = won ? "win" : "loss";

          // Tag all bot entry timing snapshots for this window with the final outcome.
          tagBotEntryTimingOutcomes(row.symbol, row.windowKey!, priceAboveStrike).catch(() => {});

          // Real contract P&L for live bets; paper simulation for paper bets.
          const ep = entryPrice;
          const n  = count;
          if (row.mode === "live") {
            correctedPnl = won
              ? (row.direction === "yes" ? (1 - ep) * n : ep * n)
              : (row.direction === "yes" ? -ep * n       : -(1 - ep) * n);
          } else {
            const betAmt = row.betAmount != null ? parseFloat(String(row.betAmount)) : ep * n;
            correctedPnl = won ? betAmt * 0.50 : -betAmt;
          }

          logger.info(
            { sym: row.symbol, windowKey: row.windowKey, closePrice, strike, direction: row.direction, outcome, pnl: correctedPnl },
            "[kalshi-bot] evalClosedBets: expired bet settled via Coinbase candle (fallback)",
          );
        }
      } else {
        // ── Mid-window exit: pnl already computed from real exit price ────────
        const pnl = row.pnl != null ? parseFloat(String(row.pnl)) : null;
        if (pnl == null) continue; // pnl not yet written; skip
        outcome = pnl > 0 ? "win" : pnl < 0 ? "loss" : "push";
        // Tag timing snapshots for mid-exits: direction + outcome → finalAbove
        if (outcome !== "push" && row.direction != null && row.windowKey) {
          const finalAbove = row.direction === "yes" ? outcome === "win" : outcome === "loss";
          tagBotEntryTimingOutcomes(row.symbol, row.windowKey, finalAbove).catch(() => {});
        }
      }

      // Merge closePrice into the signals JSONB so the dashboard can display it
      // without needing a separate column or an extra API call.
      const updatedSignals = {
        ...(row.signals as Record<string, unknown> ?? {}),
        ...(closePrice != null ? { closePriceAtEval: closePrice } : {}),
      };

      if (correctedPnl !== null) {
        await withRetry(() =>
          db
            .update(kalshiBotBetsTable)
            .set({ outcome, pnl: String(correctedPnl), evaluatedAt: new Date(), signals: updatedSignals })
            .where(eq(kalshiBotBetsTable.id, row.id))
        );
      } else {
        await withRetry(() =>
          db
            .update(kalshiBotBetsTable)
            .set({ outcome, evaluatedAt: new Date(), signals: updatedSignals })
            .where(eq(kalshiBotBetsTable.id, row.id))
        );
      }

      // Update in-memory window outcome map for the doubt-penalty signal.
      // Manual bets are excluded so user-placed trades don't skew the chop filter.
      const wk = row.windowKey;
      if (wk && correctedPnl !== null && row.source !== "manual") {
        const wo = recentWindowOutcomes.get(wk) ?? { wins: 0, losses: 0 };
        if (correctedPnl > 0) wo.wins++;
        else if (correctedPnl < 0) wo.losses++;
        recentWindowOutcomes.set(wk, wo);

        // Track unanimous-model outcomes separately: only bets where ALL 3
        // non-null models agreed with the bet direction (signalsAgreeing === signalsTotal
        // and signalsTotal >= 2). This feeds the unanimous_failure_guard penalty
        // which is a secondary layer on top of the general doubt penalty.
        const sigs = (row.signals ?? {}) as Record<string, unknown>;
        const sAgreeing = typeof sigs["signalsAgreeing"] === "number" ? sigs["signalsAgreeing"] : null;
        const sTotal    = typeof sigs["signalsTotal"]    === "number" ? sigs["signalsTotal"]    : null;
        if (sAgreeing !== null && sTotal !== null && sTotal >= 2 && sAgreeing === sTotal) {
          const uo = recentUnanimousOutcomes.get(wk) ?? { wins: 0, losses: 0 };
          if (correctedPnl > 0) uo.wins++;
          else if (correctedPnl < 0) uo.losses++;
          recentUnanimousOutcomes.set(wk, uo);
        }
      }

      // Apply real outcome to per-coin streak for expired rows.
      // closePosition() deferred this so that the confirmed candle close —
      // not the provisional estimate — drives coinStreakState.
      // Use the bet's mode so each mode's streak is updated independently.
      // Manual bets are excluded so they don't trigger or reset per-coin pauses.
      if (row.action === "expired" && row.source !== "manual") {
        const finalPnl = correctedPnl ?? (row.pnl != null ? parseFloat(String(row.pnl)) : 0);
        const rowMode: BotMode = row.mode === "live" ? "live" : "paper";
        const evalStreakMap = coinStreakStateForMode(rowMode);
        const evalStreakStore = streakStoreForMode(rowMode);
        const existingStreak = evalStreakMap.get(row.symbol) ?? { consecutiveLosses: 0, pauseUntilWindowKey: null };
        const updatedStreak = applyStreakUpdate(
          existingStreak,
          finalPnl,
          S.config.coinStreakLossLimit ?? 3,
          S.config.coinStreakPauseWindows ?? 4,
          Date.now(),
        );
        if (updatedStreak.pauseUntilWindowKey && !existingStreak.pauseUntilWindowKey) {
          logger.warn(
            { sym: row.symbol, windowKey: row.windowKey, pauseUntilWindowKey: updatedStreak.pauseUntilWindowKey, outcome },
            "[kalshi-bot] evalClosedBets: per-coin streak pause triggered (confirmed outcome)",
          );
        } else if (finalPnl >= 0 && updatedStreak.consecutiveLosses === 0 && existingStreak.consecutiveLosses > 0) {
          logger.info(
            { sym: row.symbol, windowKey: row.windowKey },
            "[kalshi-bot] evalClosedBets: per-coin streak reset on win",
          );
        }
        evalStreakMap.set(row.symbol, updatedStreak);
        persistCoinStreakState(evalStreakMap, evalStreakStore).catch(() => {});
      }

      evaluated++;
    }

    if (evaluated > 0) {
      logger.info({ evaluated }, "[kalshi-bot] evalClosedBets — outcomes stamped");
    }

    // Back-fill any snapshots whose window closed without a bet row (coins we
    // tracked but didn't bet on) using prediction_records as the source of truth.
    recoverBotEntryTimingSnapshots().catch(() => {});
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] evalClosedBets error (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Retroactive outcome re-evaluation (fix bets stored with wrong outcome)
// ---------------------------------------------------------------------------

/**
 * Re-evaluate all previously-evaluated expired bets that have a Kalshi ticker
 * by fetching the authoritative settlement result from Kalshi's API.
 *
 * This corrects bets that were evaluated using Coinbase candle close prices
 * (or live-ticker fallbacks) which can differ from Kalshi's CF Benchmarks RTI
 * settlement price — particularly near the strike boundary.
 *
 * Returns a summary of how many bets were corrected.
 */
export async function reEvaluateSettledBets(opts: { since?: string; limit?: number } = {}): Promise<{
  checked: number;
  corrected: number;
  errors: number;
  details: Array<{ id: string; symbol: string; windowKey: string; oldOutcome: string; newOutcome: string; oldPnl: string; newPnl: string }>;
}> {
  type ReEvalDetail = { id: string; symbol: string; windowKey: string; oldOutcome: string; newOutcome: string; oldPnl: string; newPnl: string };
  const result = { checked: 0, corrected: 0, errors: 0, details: [] as ReEvalDetail[] };

  const limitVal = opts.limit ?? 500;

  try {
    // Fetch evaluated expired bets that have a ticker stored.
    // Orders DESC so the most recent bets are checked first (most likely to
    // have been evaluated against Coinbase rather than Kalshi RTI).
    const whereClause = opts.since
      ? and(
          isNotNull(kalshiBotBetsTable.evaluatedAt),
          isNotNull(kalshiBotBetsTable.ticker),
          eq(kalshiBotBetsTable.action, "expired"),
          isNotNull(kalshiBotBetsTable.outcome),
          sql`${kalshiBotBetsTable.windowKey} >= ${opts.since}`,
        )
      : and(
          isNotNull(kalshiBotBetsTable.evaluatedAt),
          isNotNull(kalshiBotBetsTable.ticker),
          eq(kalshiBotBetsTable.action, "expired"),
          isNotNull(kalshiBotBetsTable.outcome),
        );

    const rows = await db
      .select({
        id: kalshiBotBetsTable.id,
        symbol: kalshiBotBetsTable.symbol,
        windowKey: kalshiBotBetsTable.windowKey,
        ticker: kalshiBotBetsTable.ticker,
        direction: kalshiBotBetsTable.direction,
        mode: kalshiBotBetsTable.mode,
        outcome: kalshiBotBetsTable.outcome,
        pnl: kalshiBotBetsTable.pnl,
        kalshiTarget: kalshiBotBetsTable.kalshiTarget,
        entryPrice: kalshiBotBetsTable.entryPrice,
        contractCount: kalshiBotBetsTable.contractCount,
        betAmount: kalshiBotBetsTable.betAmount,
        source: kalshiBotBetsTable.source,
      })
      .from(kalshiBotBetsTable)
      .where(whereClause)
      .orderBy(desc(kalshiBotBetsTable.windowKey))
      .limit(limitVal);

    logger.info({ count: rows.length }, "[kalshi-bot] reEvaluateSettledBets: starting re-evaluation");

    for (const row of rows) {
      if (!row.ticker || !row.direction || !row.outcome) continue;
      result.checked++;

      try {
        const settled = await fetchKalshiMarketResult(row.ticker);
        if (settled.result !== "yes" && settled.result !== "no") continue; // not settled yet or API error

        const won = row.direction === "yes"
          ? settled.result === "yes"
          : settled.result === "no";
        const correctOutcome: "win" | "loss" = won ? "win" : "loss";

        if (correctOutcome === row.outcome) continue; // already correct — no change needed

        // Outcome is wrong — recompute P&L and correct the record
        const entryPrice = row.entryPrice != null ? parseFloat(String(row.entryPrice)) : null;
        const count = row.contractCount ?? 1;
        let correctedPnl: number | null = null;

        if (entryPrice != null) {
          const ep = entryPrice;
          const n  = count;
          if (row.mode === "live") {
            correctedPnl = won
              ? (row.direction === "yes" ? (1 - ep) * n : ep * n)
              : (row.direction === "yes" ? -ep * n       : -(1 - ep) * n);
          } else {
            const betAmt = row.betAmount != null ? parseFloat(String(row.betAmount)) : ep * n;
            correctedPnl = won ? betAmt * 0.50 : -betAmt;
          }
        }

        const oldPnl = row.pnl != null ? String(row.pnl) : "null";
        const newPnl = correctedPnl != null ? String(correctedPnl) : oldPnl;

        await db
          .update(kalshiBotBetsTable)
          .set({
            outcome: correctOutcome,
            ...(correctedPnl != null ? { pnl: String(correctedPnl) } : {}),
          })
          .where(eq(kalshiBotBetsTable.id, row.id));

        result.corrected++;
        result.details.push({
          id: row.id,
          symbol: row.symbol,
          windowKey: row.windowKey ?? "",
          oldOutcome: row.outcome,
          newOutcome: correctOutcome,
          oldPnl,
          newPnl,
        });

        logger.warn(
          { id: row.id, sym: row.symbol, windowKey: row.windowKey, ticker: row.ticker, kalshiResult: settled.result, direction: row.direction, oldOutcome: row.outcome, newOutcome: correctOutcome, oldPnl, newPnl },
          "[kalshi-bot] reEvaluateSettledBets: CORRECTED — outcome was wrong",
        );
      } catch (err) {
        result.errors++;
        logger.warn({ err, id: row.id, sym: row.symbol }, "[kalshi-bot] reEvaluateSettledBets: error evaluating bet");
      }
    }

    logger.info(
      { checked: result.checked, corrected: result.corrected, errors: result.errors },
      "[kalshi-bot] reEvaluateSettledBets: complete",
    );
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] reEvaluateSettledBets: query error");
  }

  return result;
}

