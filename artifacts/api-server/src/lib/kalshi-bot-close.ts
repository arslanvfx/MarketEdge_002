import { db, kalshiBotBetsTable, botConfigTable, botAutoTuneLogTable } from "@workspace/db";
import { randomUUID } from "node:crypto";
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
  UncertainOrderError, isUncertainOrderError,
} from "./kalshi-trader";
import {
  claimRegularExitIntent,
  markRegularExitIntentUnknown,
  resolveRegularExitIntent,
} from "./kalshi-regular-order-intent";
import { regularCountsEqual } from "./kalshi-regular-fixed-point";
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

export async function closePosition(
  pos: OpenPosition,
  currentYesPrice: number | null,
  currentKalshiTarget: number | null,
  reason: string,
  isLateRecovery = false,
  _options?: {
    // Retained for call-site compatibility. Additional fallback submissions are
    // intentionally disabled: every live close is exactly one durable FOK POST.
    gtcFallback?: boolean;
    /**
     * Optional owner-controlled final authorization, evaluated after the
     * durable claim and immediately before the one broker submission.
     */
    preSubmitGuard?: () => boolean;
  },
): Promise<void> {
  const isExpiry = reason === "window_expired";

  // When the window expires, currentYesPrice belongs to the NEW window — never
  // use it for P&L. Instead, estimate settlement using the last known price of
  // the COIN vs the Kalshi target to determine win/loss.
  // Convention: YES contract pays $1 if price ends ≥ target, $0 otherwise.
  //             NO  contract pays $1 if price ends <  target, $0 otherwise.
  // We use the position's kalshiTarget (recorded at entry) and the last coin
  // price before window change to compute estimated settlement.
  // This will be corrected by the evaluator job (task #112) once Kalshi settles.
  let fillPrice: number | null = isExpiry ? null : currentYesPrice;

  if (pos.entryMode === "live" && !isExpiry) {
    const exitClientOrderId = randomUUID();
    const claim = await claimRegularExitIntent({
      clientOrderId: exitClientOrderId,
      mode: "live",
      positionId: pos.id,
      symbol: pos.symbol,
      windowKey: pos.windowKey,
      ticker: pos.ticker,
      side: pos.direction,
      requestedCount: pos.contractCount,
    });
    if (!claim.claimed) {
      throw new Error(
        `live exit blocked: ${claim.reason ?? "active exit intent exists"}; no additional order submitted`,
      );
    }

    try {
      if (_options?.preSubmitGuard && !_options.preSubmitGuard()) {
        await resolveRegularExitIntent({
          clientOrderId: exitClientOrderId,
          status: "zero_fill",
          reason: "owner pre-submit authorization revoked",
          filledCount: 0,
        });
        throw new Error("live exit blocked: owner pre-submit authorization revoked");
      }
      const result = pos.direction === "yes"
        ? await sellYes(pos.ticker, pos.contractCount, exitClientOrderId)
        : await sellNo(pos.ticker, pos.contractCount, exitClientOrderId);
      if (result.filledCount === 0) {
        await resolveRegularExitIntent({
          clientOrderId: exitClientOrderId,
          status: "zero_fill",
          reason: "confirmed FOK zero fill",
          filledCount: 0,
          orderId: result.orderId,
        });
        throw new Error("live exit confirmed zero fill");
      }
      if (!regularCountsEqual(result.filledCount, pos.contractCount) || result.avgPrice == null) {
        throw new UncertainOrderError(exitClientOrderId, "exit_fill_not_complete");
      }
      fillPrice = result.avgPrice;
      await resolveRegularExitIntent({
        clientOrderId: exitClientOrderId,
        status: "filled",
        reason,
        filledCount: result.filledCount,
        avgFillPrice: result.avgPrice,
        orderId: result.orderId,
      });
    } catch (err) {
      if (isUncertainOrderError(err)) {
        await markRegularExitIntentUnknown({
          clientOrderId: exitClientOrderId,
          reason: `uncertain exit outcome: ${(err as UncertainOrderError).reason}`,
        });
        logger.error(
          { err, sym: pos.symbol, clientOrderId: exitClientOrderId },
          "[kalshi-bot] exit outcome UNKNOWN — position remains open locally and additional exit orders are blocked",
        );
      } else {
        await resolveRegularExitIntent({
          clientOrderId: exitClientOrderId,
          status: "zero_fill",
          reason: `definite exit rejection: ${String((err as Error)?.message ?? err).slice(0, 160)}`,
          filledCount: 0,
        });
        logger.error(
          { err, sym: pos.symbol, clientOrderId: exitClientOrderId },
          "[kalshi-bot] exit definitely rejected — position remains open; a later tick may claim a new exit intent",
        );
      }
      throw err;
    }
  }

  // P&L calculation (paper or real)
  // For mid-window exits: pnl = (exitYesPrice - entryYesPrice) × contractCount
  //   YES bet profits when exitYesPrice > entryYesPrice
  //   NO  bet profits when exitYesPrice < entryYesPrice (they go inverse)
  // For expiry: TEMP paper simulation uses fixed return rate (see PAPER_WIN_RETURN_RATE).
  //   In live mode this path is replaced by evalClosedBets using real candle data.

  // Paper win return rate: configurable via S.config.paperWinReturnRate.
  // Default 0.50 = 50¢ profit per $1 bet. Change in Bot Configuration panel.
  const PAPER_WIN_RETURN_RATE = S.config.paperWinReturnRate ?? 0.50;

  let pnl = 0;
  if (fillPrice !== null) {
    // Mid-window exit: price-based PnL (kept as-is for live accuracy)
    const priceDelta = pos.direction === "yes"
      ? fillPrice - pos.entryYesPrice
      : pos.entryYesPrice - fillPrice;
    pnl = priceDelta * pos.contractCount;
  } else if (isExpiry) {
    // Estimate settlement from last known coin price vs strike
    const cachedCoin = getCachedPrediction(pos.symbol);
    const lastCoinPrice = cachedCoin?.price ?? null;
    const strike = currentKalshiTarget ?? pos.kalshiTarget;
    if (lastCoinPrice !== null) {
      const priceAboveStrike = lastCoinPrice >= strike;
      const won = pos.direction === "yes" ? priceAboveStrike : !priceAboveStrike;
      if (pos.entryMode === "live") {
        // Real contract P&L: each contract pays $1.00 (win) or $0.00 (loss)
        // YES cost = entryYesPrice/contract → profit = (1 − entry) × n   or loss = −entry × n
        // NO  cost = (1 − entry)/contract  → profit = entry × n           or loss = −(1 − entry) × n
        const ep = pos.entryYesPrice;
        const n  = pos.contractCount;
        pnl = won
          ? (pos.direction === "yes" ? (1 - ep) * n : ep * n)
          : (pos.direction === "yes" ? -ep * n       : -(1 - ep) * n);
      } else {
        // Paper simulation: fixed win rate
        pnl = won ? pos.betAmount * PAPER_WIN_RETURN_RATE : -pos.betAmount;
      }
    } else {
      // No price data — book conservatively as full loss
      if (pos.entryMode === "live") {
        const ep = pos.entryYesPrice;
        const n  = pos.contractCount;
        pnl = pos.direction === "yes" ? -ep * n : -(1 - ep) * n;
      } else {
        pnl = -pos.betAmount;
      }
    }
  }

  // Only apply risk counters if the position was opened in the current mode.
  // If the user switched modes mid-trade the result still gets persisted to DB
  // (correct) but must not corrupt the new mode's daily budget or circuit-breaker.
  if (pos.entryMode === S.botMode) {
    S.dailyPnl += pnl;
    if (pnl < 0) S.dailyLossCount++;

    if (isExpiry) {
      // Buffer this outcome — the window-level CB flush in runBotLoopTick
      // applies ONE S.cbState update for the entire window so that N concurrent
      // expiry closures in the same 15-min window don't count as N consecutive
      // losses.  A single bad window should be one data point, not N.
      const wo = windowCBBuffer.get(pos.windowKey) ?? { wins: 0, losses: 0 };
      if (pnl >= 0) wo.wins++; else wo.losses++;
      windowCBBuffer.set(pos.windowKey, wo);
    } else {
      // Mid-window exit: apply circuit breaker immediately (independent events).
      S.cbState = applyBetOutcome(
        S.cbState,
        pnl >= 0,
        S.config.maxConsecutiveLosses,
        S.config.circuitBreakerPauseWindows,
      );
      if (pnl >= 0 && S.cbState.consecutiveLosses === 0) {
        logger.info({ cbState: S.cbState }, "[kalshi-bot] win — consecutive loss streak reset");
      } else if (pnl < 0) {
        logger.info(
          { cbState: S.cbState, maxConsecutiveLosses: S.config.maxConsecutiveLosses },
          "[kalshi-bot] loss — consecutive loss count updated",
        );
        if (S.cbState.circuitBreakerWindowsRemaining > 0 && S.cbState.consecutiveLosses === S.config.maxConsecutiveLosses) {
          logger.warn(
            { cbState: S.cbState },
            "[kalshi-bot] ⚡ circuit breaker TRIGGERED — new entries paused for this many windows",
          );
        }
      }
    }
  } else {
    logger.info(
      { sym: pos.symbol, entryMode: pos.entryMode, currentMode: S.botMode },
      "[kalshi-bot] closePosition: skipping risk-counter update — position entry mode differs from current bot mode",
    );
  }

  // ── Per-coin daily loss accumulator ────────────────────────────────────────
  // Use the mode-specific map so paper losses never pollute live caps and
  // vice versa; the entryMode determines which map is updated.
  const modeMap = coinDailyLossForMode(pos.entryMode);
  modeMap.set(
    pos.symbol,
    applyDailyLossUpdate(modeMap, pos.symbol, pnl, pos.entryMode, pos.entryMode).get(pos.symbol) ??
      (modeMap.get(pos.symbol) ?? 0),
  );

  // ── Per-coin consecutive window streak tracking ────────────────────────────
  // For mid-window exits: apply immediately (pnl is based on real Kalshi price).
  // For window expiry: defer to evalClosedBets so the confirmed candle close
  // drives the streak — not the provisional estimate that closePosition uses
  // (which can be a conservative full-loss fallback when the price cache is cold).
  // Use the position's entryMode to update the right mode's streak map.
  if (!isExpiry) {
    const posStreakMap = coinStreakStateForMode(pos.entryMode);
    const posStreakStore = streakStoreForMode(pos.entryMode);
    const existing = posStreakMap.get(pos.symbol) ?? { consecutiveLosses: 0, pauseUntilWindowKey: null };
    const updated = applyStreakUpdate(
      existing,
      pnl,
      S.config.coinStreakLossLimit ?? 2,
      S.config.coinStreakPauseWindows ?? 2,
      pos.windowKey ?? "",   // windowKey of the closed bet — drives adjacency check
      Date.now(),
    );
    if (updated.pauseUntilWindowKey && !existing.pauseUntilWindowKey) {
      logger.warn(
        { sym: pos.symbol, pauseUntilWindowKey: updated.pauseUntilWindowKey, pauseWindows: S.config.coinStreakPauseWindows ?? 2 },
        "[kalshi-bot] per-coin streak pause triggered — coin skipped for N windows",
      );
    }
    posStreakMap.set(pos.symbol, updated);
    // Fire-and-forget — persist so the streak guard survives a server restart.
    persistCoinStreakState(posStreakMap, posStreakStore).catch(() => {});
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Recover account balance. Use the position's entry mode so a live position
  // closed after the user switched to paper still refreshes the real balance.
  if (pos.entryMode === "live") {
    getBalance()
      .then((b) => { S.accountBalance = b.availableBalance; })
      .catch(() => {});
  } else {
    S.accountBalance = (S.accountBalance ?? S.config.paperStartingBalance ?? 100) + pnl; // simulated paper balance
  }

  const phase2RecoveredAmount = isLateRecovery && pnl > -pos.betAmount
    ? pnl - (-pos.betAmount)  // how much we recovered vs riding to zero
    : null;

  // Capture the live coin price at the moment the position is closed.
  const cryptoPriceAtExit = getCachedPrediction(pos.symbol)?.price ?? null;

  // Non-throwing: all in-memory state (P&L, balance, circuit-breaker,
  // recentKalshiTargets) is already updated above. A DB failure here must
  // NOT prevent openPositions.delete() from running — otherwise the position
  // stays stuck in memory across windows and no further bets can be placed.
  try {
    await persistBetRecord({
      symbol: pos.symbol,
      windowKey: pos.windowKey,
      ticker: pos.ticker,
      direction: pos.direction,
      action: isLateRecovery ? "late_recovery_exit" : isExpiry ? "expired" : "exit",
      signals: pos.entryDecision.signals,
      entryPrice: pos.entryYesPrice,
      exitPrice: fillPrice ?? undefined,
      kalshiTarget: pos.kalshiTarget,
      contractCount: pos.contractCount,
      betAmount: pos.betAmount,
      pnl,
      exitReason: reason,
      phase2Activated: pos.phase2Activated,
      phase2RecoveredAmount: phase2RecoveredAmount ?? undefined,
      existingId: pos.id,
      cryptoPriceAtExit,
    });

    // Shadow paper bet: close the mirrored paper record with the same outcome.
    // pnl for paper uses the fixed simulation rate (not real contract math).
    if (pos.shadowPaperId) {
      const PAPER_WIN_RATE = S.config.paperWinReturnRate ?? 0.50;
      const paperPnl = isExpiry
        ? (pnl >= 0 ? pos.betAmount * PAPER_WIN_RATE : -pos.betAmount)
        : pnl; // mid-window price-delta PnL is equivalent for paper
      persistBetRecord({
        symbol: pos.symbol,
        windowKey: pos.windowKey,
        ticker: pos.ticker,
        direction: pos.direction,
        action: isLateRecovery ? "late_recovery_exit" : isExpiry ? "expired" : "exit",
        signals: pos.entryDecision.signals,
        entryPrice: pos.entryYesPrice,
        exitPrice: fillPrice ?? undefined,
        kalshiTarget: pos.kalshiTarget,
        contractCount: pos.contractCount,
        betAmount: pos.betAmount,
        pnl: paperPnl,
        exitReason: reason,
        phase2Activated: pos.phase2Activated,
        phase2RecoveredAmount: phase2RecoveredAmount ?? undefined,
        existingId: pos.shadowPaperId,
        cryptoPriceAtExit,
        mode: "paper",
      }).catch(() => {}); // fire-and-forget, non-fatal
    }

    if (isExpiry) {
      logger.info(
        { sym: pos.symbol, windowKey: pos.windowKey, direction: pos.direction, pnl: pnl.toFixed(4) },
        "[kalshi-bot] closePosition: window_expired — bet persisted to DB",
      );
    }
  } catch (err) {
    logger.warn({ err, sym: pos.symbol }, "[kalshi-bot] closePosition: DB persist error (non-fatal) — position cleared from memory regardless");
  }

  // Update recent Kalshi strike history for momentum/regime tracking.
  // We record the target price from the closed position (oldest-first order).
  const closedSym = pos.symbol.toUpperCase();
  if (pos.kalshiTarget != null) {
    const existing = recentKalshiTargets.get(closedSym) ?? [];
    existing.push(pos.kalshiTarget);
    if (existing.length > REGIME_STRIKES_MAX) existing.splice(0, existing.length - REGIME_STRIKES_MAX);
    recentKalshiTargets.set(closedSym, existing);
  }

  logger.info(
    { sym: pos.symbol, pnl, reason, isLateRecovery, dailyPnl: S.dailyPnl },
    "[kalshi-bot] position closed",
  );
}

// ---------------------------------------------------------------------------
// DB persistence
// ---------------------------------------------------------------------------

export interface BetRecordArgs {
  symbol: string;
  windowKey: string;
  ticker: string | null;
  direction: "yes" | "no" | null;
  action: string;
  signals: unknown;
  entryPrice: number | null | undefined;
  exitPrice?: number | null;
  kalshiTarget: number;
  contractCount?: number;
  betAmount?: number;
  pnl?: number;
  exitReason?: string;
  phase2Activated?: boolean;
  phase2RecoveredAmount?: number;
  // insertId: use this specific ID when inserting a new record (e.g. bets, where
  //   the id must match openPosition.id so the exit UPDATE can find the row).
  insertId?: string;
  // existingId: UPDATE the row with this id instead of inserting.
  existingId?: string;
  cryptoPriceAtEntry?: number | null;
  cryptoPriceAtExit?: number | null;
  // Active decision mode at the time of bet placement. Null on exit/expiry updates.
  decisionMode?: DecisionMode | null;
  // Bot mode (paper/live) captured at entry. Falls back to the global S.botMode
  // when omitted (e.g. skip/warmup rows). Prevents mid-fill flips mislabeling rows.
  mode?: BotMode;
  // Originating source: "bot" (automated loop) | "manual" (dashboard button).
  // Omitting defaults to "bot" in the DB insert.
  source?: "bot" | "manual";
  // Kalshi YES contract price (0–1) at decision time — used for conviction threshold analysis.
  entryYesPrice?: number | null;
  // True when the stability gate + probability roll upgraded this bet to max size.
  isMaxBet?: boolean;
}

export async function persistBetRecord(args: BetRecordArgs): Promise<void> {
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await _persistBetRecordOnce(args);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        // Give the pool time to drain — window-expiry fires 6-7 simultaneous
        // writes that can exhaust all slots. Use longer backoff than the old
        // 600 ms so a 8 s connection timeout on the previous attempt has
        // actually resolved before we hammer again.
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
  }
  throw lastErr;
}

export async function _persistBetRecordOnce(args: BetRecordArgs): Promise<void> {
  try {
    const id = args.existingId ?? args.insertId ?? `${args.symbol}:${args.windowKey}:${Date.now()}`;
    if (args.existingId) {
      // Exit / expiry update. Use a race-safe upsert (INSERT … ON CONFLICT DO UPDATE)
      // instead of a plain UPDATE so the bet is never silently lost when the window
      // expires before the entry INSERT has committed to the DB.
      //
      // Normal path (row already exists): updates only the exit-side fields,
      // leaving the original entry data (signals, entryPrice, decisionMode, etc.)
      // intact.
      //
      // Race path (row doesn't exist yet because the entry INSERT is still in-flight
      // or failed entirely): inserts a complete entry+exit record so the bet still
      // appears in history and is counted in stats.
      const exitedAt = new Date();
      await db
        .insert(kalshiBotBetsTable)
        .values({
          id,
          symbol: args.symbol,
          windowKey: args.windowKey,
          ticker: args.ticker ?? undefined,
          direction: args.direction ?? undefined,
          action: args.action,
          mode: args.mode ?? S.botMode,
          signals: args.signals as Record<string, unknown>,
          entryPrice: args.entryPrice != null ? String(args.entryPrice) : undefined,
          kalshiTarget: String(args.kalshiTarget),
          contractCount: args.contractCount,
          betAmount: args.betAmount != null ? String(args.betAmount) : undefined,
          exitPrice: args.exitPrice != null ? String(args.exitPrice) : undefined,
          pnl: args.pnl != null ? String(args.pnl) : undefined,
          exitReason: args.exitReason,
          phase2Activated: args.phase2Activated,
          phase2RecoveredAmount:
            args.phase2RecoveredAmount != null ? String(args.phase2RecoveredAmount) : undefined,
          cryptoPriceAtExit: args.cryptoPriceAtExit != null ? String(args.cryptoPriceAtExit) : undefined,
          source: args.source ?? "bot",
          decisionMode: args.decisionMode ?? null,
          exitedAt,
          createdAt: exitedAt,
        })
        .onConflictDoUpdate({
          target: kalshiBotBetsTable.id,
          set: {
            exitPrice: args.exitPrice != null ? String(args.exitPrice) : undefined,
            pnl: args.pnl != null ? String(args.pnl) : undefined,
            exitReason: args.exitReason,
            action: args.action,
            phase2Activated: args.phase2Activated,
            phase2RecoveredAmount:
              args.phase2RecoveredAmount != null ? String(args.phase2RecoveredAmount) : undefined,
            cryptoPriceAtExit:
              args.cryptoPriceAtExit != null ? String(args.cryptoPriceAtExit) : undefined,
            exitedAt,
          },
        });
    } else {
      // Insert new record (bet entry, skip, warmup)
      await db.insert(kalshiBotBetsTable).values({
        id,
        symbol: args.symbol,
        windowKey: args.windowKey,
        ticker: args.ticker ?? undefined,
        direction: args.direction ?? undefined,
        action: args.action,
        mode: args.mode ?? S.botMode,
        signals: args.signals as Record<string, unknown>,
        entryPrice: args.entryPrice != null ? String(args.entryPrice) : undefined,
        kalshiTarget: String(args.kalshiTarget),
        contractCount: args.contractCount,
        betAmount: args.betAmount != null ? String(args.betAmount) : undefined,
        cryptoPriceAtEntry: args.cryptoPriceAtEntry != null ? String(args.cryptoPriceAtEntry) : undefined,
        decisionMode: args.decisionMode ?? null,
        source: args.source ?? "bot",
        entryYesPrice: args.entryYesPrice != null ? String(args.entryYesPrice) : undefined,
        isMaxBet: args.isMaxBet ?? false,
        createdAt: new Date(),
      }).onConflictDoNothing();
    }
    // Successful write — reset the failure counter and clear degraded mode if set.
    if (S.dbDegradedSince !== null) {
      const downMs = Date.now() - S.dbDegradedSince.getTime();
      logger.info(
        { downSeconds: Math.round(downMs / 1000) },
        "[kalshi-bot] DB connection restored — exiting degraded mode, resuming new bets",
      );
      S.dbDegradedSince = null;
    }
    S.dbConsecutiveFailures = 0;
    S.dbFirstFailureAt = null;
  } catch (err) {
    const now = new Date();
    S.dbConsecutiveFailures++;
    if (S.dbFirstFailureAt === null) S.dbFirstFailureAt = now;
    const streakMs = now.getTime() - S.dbFirstFailureAt.getTime();
    if (
      S.dbConsecutiveFailures >= DB_DEGRADED_THRESHOLD &&
      streakMs >= DB_DEGRADED_MIN_WINDOW_MS &&
      S.dbDegradedSince === null
    ) {
      S.dbDegradedSince = now;
      logger.warn(
        { failures: S.dbConsecutiveFailures, streakSeconds: Math.round(streakMs / 1000) },
        "[kalshi-bot] DB degraded — pausing new bets until connection restores (open positions still managed)",
      );
    }
    logger.warn({ err }, "[kalshi-bot] DB persist error (non-fatal)");
    // Re-throw so the caller's retry loop (persistBetRecord) can retry.
    // Without this the outer loop never sees the failure and silently gives up
    // after a single attempt.
    throw err;
  }
}

