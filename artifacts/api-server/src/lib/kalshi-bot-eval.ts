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
  liveCoinStreakState, coinSlippageStrikes, recentWindowOutcomes, recentUnanimousOutcomes, recentDirectionalOutcomes, windowCBBuffer,
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
import { isPythProduct, COMMODITY_SYMBOLS } from "./market-defs";
import { tagBotEntryTimingOutcomes, recoverBotEntryTimingSnapshots } from "./kalshi-bot-entry-timing";
import { applyDirectionalOutcome } from "./kalshi-bot-directional-outcomes";
import { recomputeSymbolQuietHours } from "./kalshi-bot-db";

export { applyDirectionalOutcome } from "./kalshi-bot-directional-outcomes";

/**
 * Fetch a Kalshi market settlement result with automatic retries.
 * A transient network failure or a market that hasn't yet published its result
 * both return `result: "unknown"` on the first attempt — retrying a few times
 * gives the Kalshi API time to settle before we fall back to the Coinbase candle,
 * which can differ from the authoritative CF Benchmarks RTI price near the strike.
 */
async function fetchKalshiResultWithRetry(
  ticker: string,
  maxAttempts = 3,
): Promise<Awaited<ReturnType<typeof fetchKalshiMarketResult>>> {
  let last!: Awaited<ReturnType<typeof fetchKalshiMarketResult>>;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      last = await fetchKalshiMarketResult(ticker);
      if (last.result === "yes" || last.result === "no") return last;
    } catch (err) {
      logger.warn({ ticker, attempt, err }, "[kalshi-eval] fetchKalshiMarketResult attempt failed");
    }
    if (attempt < maxAttempts) await new Promise<void>(r => setTimeout(r, 1_500));
  }
  return last ?? { result: "unknown" as const, status: "unknown" };
}

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

      // Per-row try-catch: a DB write failure on one row must not abort
      // evaluation of the remaining rows in this batch. Each failure is
      // logged; the row stays with evaluatedAt=NULL and will be retried on
      // the next evalClosedBets call (runs every tick).
      try {

      if (row.action === "expired") {
        // ── Settlement evaluation ─────────────────────────────────────────────
        // Priority order:
        //   1. Kalshi's own settlement result (authoritative — Kalshi settles via
        //      CF Benchmarks RTI which differs from Coinbase candle close prices).
        //   2. Coinbase 1-min candle close at the window boundary (legacy fallback).
        //   3. cryptoPriceAtExit (live ticker captured at expiry — last resort).
        //   4. Full-loss fallback after 90-s deferral (ensures row never gets stuck).
        const coin = CRYPTO_COINS.find((c) => c.symbol === row.symbol);
        if (!coin || !row.windowKey || row.direction == null) {
          logger.warn(
            { id: row.id, sym: row.symbol, hasCoin: !!coin, hasWindowKey: !!row.windowKey, direction: row.direction },
            "[kalshi-bot] evalClosedBets: skipping row — missing coin definition, windowKey, or direction",
          );
          continue;
        }

        const strike = row.kalshiTarget != null ? parseFloat(String(row.kalshiTarget)) : null;
        const entryPrice = row.entryPrice != null ? parseFloat(String(row.entryPrice)) : null;
        const count = row.contractCount ?? 1;
        if (strike == null || entryPrice == null) {
          logger.warn(
            { id: row.id, sym: row.symbol, windowKey: row.windowKey, strike, entryPrice },
            "[kalshi-bot] evalClosedBets: skipping row — missing strike or entryPrice; row may need manual correction",
          );
          continue;
        }

        // ── Step 1: Kalshi settlement result (primary — no price comparison needed) ──
        let kalshiSettled = false;
        if (row.ticker) {
          const settled = await fetchKalshiResultWithRetry(row.ticker);
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

        // ── Step 1.5: Series-level settlement lookup ──────────────────────────
        // When GET /markets/{ticker} returns unknown (slow-settling commodity RTI,
        // ticker-format quirk) fetch the full settled-market list for this series
        // and match the exact ticker.  More reliable for WTI, GOLD, SILVER where
        // CF Benchmarks RTI can lag the window close by several minutes.
        if (!kalshiSettled && row.ticker) {
          const _seriesTk = row.ticker.split("-")[0]; // "KXWTI15M-26AUG261900-00" → "KXWTI15M"
          if (_seriesTk) {
            const _seriesMkts = await fetchKalshiSettledMarkets(_seriesTk, 200).catch(() => []);
            const _seriesMatch = _seriesMkts.find(m => m.ticker === row.ticker);
            if (_seriesMatch) {
              const _seriesWon = row.direction === "yes" ? _seriesMatch.result === "yes" : _seriesMatch.result === "no";
              outcome = _seriesWon ? "win" : "loss";
              const ep = entryPrice; const n = count;
              if (row.mode === "live") {
                correctedPnl = _seriesWon
                  ? (row.direction === "yes" ? (1 - ep) * n : ep * n)
                  : (row.direction === "yes" ? -ep * n       : -(1 - ep) * n);
              } else {
                const betAmt = row.betAmount != null ? parseFloat(String(row.betAmount)) : ep * n;
                correctedPnl = _seriesWon ? betAmt * 0.50 : -betAmt;
              }
              logger.info(
                { sym: row.symbol, windowKey: row.windowKey, ticker: row.ticker, kalshiResult: _seriesMatch.result, direction: row.direction, outcome, pnl: correctedPnl },
                "[kalshi-bot] evalClosedBets: settled via series-level Kalshi lookup (step 1.5)",
              );
              kalshiSettled = true;
            }
          }
        }

        // ── Commodity-specific defer ───────────────────────────────────────────
        // For commodity markets (WTI/GOLD/SILVER) the Pyth spot price differs from
        // CF Benchmarks RTI which Kalshi uses for settlement — comparing against a
        // Pyth candle near the strike gives the wrong outcome.
        // Defer within the 90-s window; commit conservative loss past it so the
        // row never gets permanently stuck.  reEvaluateSettledBets + fixCommodityOutcomes
        // auto-correct once Kalshi publishes the RTI result.
        if (!kalshiSettled && isPythProduct(coin.product)) {
          const _exitedAtRaw = row.exitedAt;
          const _exitedAtDate = _exitedAtRaw instanceof Date ? _exitedAtRaw : _exitedAtRaw != null ? new Date(_exitedAtRaw as string) : null;
          const _pastDefer = _exitedAtDate == null || _exitedAtDate <= deferCutoff;
          if (!_pastDefer) {
            logger.debug(
              { sym: row.symbol, id: row.id, ticker: row.ticker },
              "[kalshi-bot] evalClosedBets: commodity not yet settled by Kalshi — deferring (Pyth candle differs from RTI)",
            );
            continue;
          }
          // Past 90-s deferral window and Kalshi still hasn't published RTI.
          // Commit conservative loss; reEvaluateSettledBets / fixCommodityOutcomes
          // will flip it to the correct outcome once Kalshi settles.
          const ep = entryPrice; const n = count;
          const _cPnl = row.direction === "yes" ? -ep * n : -(1 - ep) * n;
          logger.warn(
            { sym: row.symbol, id: row.id, ticker: row.ticker ?? "(none)" },
            "[kalshi-bot] evalClosedBets: commodity not settled after 90-s defer — committing conservative loss; fixCommodityOutcomes will auto-correct once Kalshi RTI publishes",
          );
          await withRetry(() =>
            db.update(kalshiBotBetsTable)
              .set({ outcome: "loss", pnl: String(_cPnl), evaluatedAt: new Date() })
              .where(eq(kalshiBotBetsTable.id, row.id))
          );
          evaluated++;
          continue;
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
            if (fallbackPnl == null) {
              // No stored P&L and no price source past the 90-s deferral window.
              // Attempt one last Kalshi fetch before giving up.
              if (row.ticker) {
                const lastChance = await fetchKalshiResultWithRetry(row.ticker, 1).catch(() => null);
                if (lastChance && (lastChance.result === "yes" || lastChance.result === "no")) {
                  const won = row.direction === "yes" ? lastChance.result === "yes" : lastChance.result === "no";
                  const rescueOutcome = won ? ("win" as const) : ("loss" as const);
                  const ep = entryPrice;
                  const n  = count;
                  // Compute real P&L — same formula as the normal evaluation path below.
                  const rescuePnl = row.mode === "live"
                    ? (won
                        ? (row.direction === "yes" ? (1 - ep) * n : ep * n)
                        : (row.direction === "yes" ? -ep * n : -(1 - ep) * n))
                    : (won ? ep * n * 0.5 : -(ep * n));
                  logger.info(
                    { sym: row.symbol, id: row.id, ticker: row.ticker, kalshiResult: lastChance.result, outcome: rescueOutcome },
                    "[kalshi-bot] evalClosedBets: stuck row rescued by last-chance Kalshi retry",
                  );
                  await withRetry(() =>
                    db.update(kalshiBotBetsTable)
                      .set({ outcome: rescueOutcome, pnl: String(rescuePnl), evaluatedAt: new Date() })
                      .where(eq(kalshiBotBetsTable.id, row.id))
                  );
                  evaluated++;
                  continue;
                }
              }
              // Kalshi not yet settled and no price data — commit conservative 'loss' so
              // the row is NEVER permanently stuck.  reEvaluateSettledBets() auto-corrects
              // once Kalshi publishes its final settlement result.
              const ep = entryPrice;
              const n  = count;
              const conservativePnl = row.direction === "yes" ? -ep * n : -(1 - ep) * n;
              logger.warn(
                { sym: row.symbol, id: row.id, windowKey: row.windowKey, ticker: row.ticker ?? "(none)" },
                "[kalshi-bot] evalClosedBets: no price data, no stored pnl, past 90-s defer — committing conservative loss; reEvaluateSettledBets will auto-correct once Kalshi settles",
              );
              await withRetry(() =>
                db.update(kalshiBotBetsTable)
                  .set({ outcome: "loss", pnl: String(conservativePnl), evaluatedAt: new Date() })
                  .where(eq(kalshiBotBetsTable.id, row.id))
              );
              evaluated++;
              continue;
            }
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

          // Kalshi settles "above" as strictly > strike (not >=).
          // At exactly the strike, Kalshi settles NO (below).
          // Using >= here would misclassify exact-strike closes as YES wins.
          const priceAboveStrike = closePrice > strike;
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

        // Track directional outcomes for the directional regime dampener.
        if (row.direction) {
          applyDirectionalOutcome(recentDirectionalOutcomes, row.direction, correctedPnl, wk);
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
          S.config.coinStreakLossLimit ?? 2,
          S.config.coinStreakPauseWindows ?? 2,
          row.windowKey ?? "",
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
      // Trigger per-symbol quiet-hours schedule recompute when in per_market mode.
      // Fire-and-forget: auto-calibration failures are non-fatal.
      if (S.config.quietHoursMode === "per_market") {
        recomputeSymbolQuietHours(row.symbol).catch(() => {});
      }

      } catch (rowErr) {
        // DB write (or price fetch) failed for this row — log and continue so
        // other rows in the batch are still processed.  This row keeps
        // evaluatedAt=NULL and will be retried on the next evalClosedBets call.
        logger.warn(
          { err: rowErr, id: row.id, sym: row.symbol, windowKey: row.windowKey },
          "[kalshi-bot] evalClosedBets: row evaluation failed — will retry on next tick",
        );
      }
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
        let _reEvalResult = settled.result;

        // Fallback: series-level lookup when per-ticker result is unavailable.
        // This is the primary fix for commodity markets (WTI/GOLD/SILVER) where
        // GET /markets/{ticker} can return null while the series-level endpoint
        // correctly shows the CF Benchmarks RTI settlement.
        if (_reEvalResult !== "yes" && _reEvalResult !== "no") {
          const _reSeries = row.ticker.split("-")[0]; // "KXWTI15M-..." → "KXWTI15M"
          if (_reSeries) {
            const _reMkts = await fetchKalshiSettledMarkets(_reSeries, 200).catch(() => []);
            const _reMatch = _reMkts.find(m => m.ticker === row.ticker);
            if (_reMatch) _reEvalResult = _reMatch.result;
          }
        }

        if (_reEvalResult !== "yes" && _reEvalResult !== "no") continue; // not settled yet

        const won = row.direction === "yes"
          ? _reEvalResult === "yes"
          : _reEvalResult === "no";
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
          { id: row.id, sym: row.symbol, windowKey: row.windowKey, ticker: row.ticker, kalshiResult: _reEvalResult, direction: row.direction, oldOutcome: row.outcome, newOutcome: correctOutcome, oldPnl, newPnl },
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

/**
 * Re-evaluate ALL commodity (WTI/GOLD/SILVER) expired bets using the Kalshi
 * series-level settlement API.  Corrects outcomes committed as conservative losses
 * before the CF Benchmarks RTI result was published.  Idempotent — safe to call
 * multiple times.
 *
 * Batches series API calls: one fetchKalshiSettledMarkets call per series covers
 * all bets in that series, minimising API round-trips.
 */
export async function fixCommodityOutcomes(opts: { since?: string; limit?: number } = {}): Promise<{
  checked: number;
  corrected: number;
  errors: number;
  details: Array<{ id: string; symbol: string; windowKey: string; oldOutcome: string | null; newOutcome: string; oldPnl: string; newPnl: string }>;
}> {
  type FixDetail = { id: string; symbol: string; windowKey: string; oldOutcome: string | null; newOutcome: string; oldPnl: string; newPnl: string };
  const result = { checked: 0, corrected: 0, errors: 0, details: [] as FixDetail[] };

  if (COMMODITY_SYMBOLS.length === 0) return result;

  const limitVal = opts.limit ?? 500;
  try {
    const whereClause = opts.since
      ? and(
          inArray(kalshiBotBetsTable.symbol, COMMODITY_SYMBOLS),
          eq(kalshiBotBetsTable.action, "expired"),
          isNotNull(kalshiBotBetsTable.exitedAt),
          isNotNull(kalshiBotBetsTable.ticker),
          sql`${kalshiBotBetsTable.windowKey} >= ${opts.since}`,
        )
      : and(
          inArray(kalshiBotBetsTable.symbol, COMMODITY_SYMBOLS),
          eq(kalshiBotBetsTable.action, "expired"),
          isNotNull(kalshiBotBetsTable.exitedAt),
          isNotNull(kalshiBotBetsTable.ticker),
        );

    const rows = await db
      .select({
        id:            kalshiBotBetsTable.id,
        symbol:        kalshiBotBetsTable.symbol,
        windowKey:     kalshiBotBetsTable.windowKey,
        ticker:        kalshiBotBetsTable.ticker,
        direction:     kalshiBotBetsTable.direction,
        mode:          kalshiBotBetsTable.mode,
        outcome:       kalshiBotBetsTable.outcome,
        pnl:           kalshiBotBetsTable.pnl,
        entryPrice:    kalshiBotBetsTable.entryPrice,
        contractCount: kalshiBotBetsTable.contractCount,
        betAmount:     kalshiBotBetsTable.betAmount,
      })
      .from(kalshiBotBetsTable)
      .where(whereClause)
      .orderBy(desc(kalshiBotBetsTable.windowKey))
      .limit(limitVal);

    logger.info({ count: rows.length, symbols: COMMODITY_SYMBOLS }, "[kalshi-bot] fixCommodityOutcomes: starting");

    // One series fetch per unique series ticker covers all bets in that series.
    const seriesCache = new Map<string, Awaited<ReturnType<typeof fetchKalshiSettledMarkets>>>();

    for (const row of rows) {
      if (!row.ticker || !row.direction) continue;
      result.checked++;

      try {
        const seriesTk = row.ticker.split("-")[0]; // "KXWTI15M-26AUG..." → "KXWTI15M"
        if (!seriesCache.has(seriesTk)) {
          const mkts = await fetchKalshiSettledMarkets(seriesTk, 500).catch(() => []);
          seriesCache.set(seriesTk, mkts);
        }
        const mkts = seriesCache.get(seriesTk) ?? [];
        const match = mkts.find(m => m.ticker === row.ticker);
        if (!match) continue; // not yet settled by Kalshi — skip

        const won = row.direction === "yes" ? match.result === "yes" : match.result === "no";
        const correctOutcome: "win" | "loss" = won ? "win" : "loss";

        if (correctOutcome === row.outcome) continue; // already correct

        const entryPrice = row.entryPrice != null ? parseFloat(String(row.entryPrice)) : null;
        const count = row.contractCount ?? 1;
        let correctedPnl: number | null = null;
        if (entryPrice != null) {
          const ep = entryPrice; const n = count;
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
            evaluatedAt: new Date(),
            ...(correctedPnl != null ? { pnl: String(correctedPnl) } : {}),
          })
          .where(eq(kalshiBotBetsTable.id, row.id));

        result.corrected++;
        result.details.push({ id: row.id, symbol: row.symbol, windowKey: row.windowKey ?? "", oldOutcome: row.outcome, newOutcome: correctOutcome, oldPnl, newPnl });
        logger.warn(
          { id: row.id, sym: row.symbol, windowKey: row.windowKey, ticker: row.ticker, kalshiResult: match.result, direction: row.direction, oldOutcome: row.outcome, newOutcome: correctOutcome, oldPnl, newPnl },
          "[kalshi-bot] fixCommodityOutcomes: CORRECTED",
        );
      } catch (err) {
        result.errors++;
        logger.warn({ err, id: row.id, sym: row.symbol }, "[kalshi-bot] fixCommodityOutcomes: error on row");
      }
    }

    logger.info(
      { checked: result.checked, corrected: result.corrected, errors: result.errors },
      "[kalshi-bot] fixCommodityOutcomes: complete",
    );
  } catch (err) {
    logger.warn({ err }, "[kalshi-bot] fixCommodityOutcomes: query error");
  }

  return result;
}

