// ---------------------------------------------------------------------------
// High-value scalping
//
// Driven by the conviction poller's 1-second fresh-price cycle, not the bot
// loop tick.  When the poller detects a coin's YES ask (or NO ask complement)
// inside the configured price band (default 90–95¢) during the configured
// final window (default last 120 s), it calls runHighValueScalpForCoin()
// directly with the just-fetched prices — no cache staleness possible.
//
// Order placement follows the same IOC path as regular conviction bets.
// Out-of-band fills (exchange race between final-check and fill) are closed
// immediately rather than held for "normal management".
// ---------------------------------------------------------------------------

import { logger } from "./logger";
import { kalshiTargetCache } from "./crypto-kalshi";
import { getCachedKalshiBalance, invalidateBalanceCache, placeEntryOrderWithSizeFallback, placeOrder } from "./kalshi-trader";
import { makeInitialExitState } from "./kalshi-bot-exit";
import { persistBetRecord } from "./kalshi-bot-close";
import {
  S,
  openPositions,
  highValueScalpFiredThisWindow,
  paperHighValueScalpDailySpend,
  liveHighValueScalpDailySpend,
  type BotMode,
  type OpenPosition,
} from "./kalshi-bot-state";
import type { BotDecision } from "./kalshi-bot-engine";
import {
  evaluateHighValueScalpEligibility,
  isHighValueScalpWindowOpen,
  type HighValueScalpSide,
} from "./kalshi-high-value-scalper-policy";
export { evaluateHighValueScalpEligibility } from "./kalshi-high-value-scalper-policy";

function modeSpend(mode: BotMode): Map<string, number> {
  return mode === "live" ? liveHighValueScalpDailySpend : paperHighValueScalpDailySpend;
}

function currentScalpExposure(mode: BotMode): number {
  return Array.from(openPositions.values())
    .filter((pos) => pos.entryMode === mode)
    .reduce((sum, pos) => sum + (pos.highValueScalpAmount ?? 0), 0);
}

function currentWindowTiming(now = Date.now()): { windowKey: string; closeAt: number; secondsRemaining: number } {
  const openAt = Math.floor(now / (15 * 60_000)) * 15 * 60_000;
  return {
    windowKey: new Date(openAt).toISOString().slice(0, 16),
    closeAt: openAt + 15 * 60_000,
    secondsRemaining: Math.max(0, Math.floor((openAt + 15 * 60_000 - now) / 1000)),
  };
}

function scalpDecision(side: HighValueScalpSide): BotDecision {
  return {
    action: side === "yes" ? "BET_YES" : "BET_NO",
    confidence: 95,
    reasoning: "High-value scalp: winning-side contract ask inside configured late-window price band.",
    signals: {
      statAbove: null, claudeAbove: null, mlAbove: null,
      statConfidence: null, claudeConfidence: null, mlConfidence: null,
      signalsAgreeing: 0, signalsTotal: 0, agreementTarget: null,
      windowMonitor: null, windowMonitorReady: false, yesPrice: null,
      ev: null, signalAccuracyPct: null, minutesElapsed: 0, warmupActive: false, roiPct: null,
    },
  };
}

/**
 * Execute a high-value scalp for one symbol using freshly-fetched prices.
 *
 * Called directly from the conviction poller the moment a scalp-band price
 * is detected (same pattern as conviction zone dispatch).  The `prices`
 * argument is the just-fetched Kalshi quote — guaranteed ≤ 1 s old — so
 * there is no stale-cache risk on the initial eligibility check.
 *
 * Fire-and-forget safe: `highValueScalpFiredThisWindow.add(firedKey)` is
 * called synchronously before the first await, so concurrent poller ticks
 * cannot race into a double-fill.
 */
export async function runHighValueScalpForCoin(
  sym: string,
  prices: { yesAsk: number | null; yesBid: number | null; noAsk?: number | null },
  now: number = Date.now(),
): Promise<void> {
  const config = S.config;
  const timing = currentWindowTiming(now);
  const mode = S.botMode;
  const firedKey = `${sym}:${timing.windowKey}:${mode}`;

  // One scalp per coin per window per mode.
  // MUST be checked AND set synchronously here — before ANY await — so that
  // concurrent poller ticks racing in before the first await all see it set.
  // Do NOT delete this key on failure; clearing it to allow "retry next tick"
  // was the direct cause of 20+ duplicate SILVER orders ($80 loss): every
  // failed IOC cleared the guard, so each subsequent 1-second poll re-dispatched
  // a real order for as long as the price stayed in band.
  // If an order attempt fails (0 fills or error), the coin is blocked for the
  // rest of the window — same semantics as the conviction bot's FOK cooldown.
  if (highValueScalpFiredThisWindow.has(firedKey)) return;
  highValueScalpFiredThisWindow.add(firedKey); // synchronous — before any await

  // Per-coin override: paused coin is skipped entirely.
  const coinOverride = config.highValueScalpCoinOverrides?.[sym];
  if (coinOverride?.paused) return;

  // Per-coin timing gate: if a tighter entry window is configured for this
  // coin, apply it before the eligibility check.
  if (coinOverride?.maxSecondsRemaining != null && timing.secondsRemaining > coinOverride.maxSecondsRemaining) return;

  // Read from the shared kalshiTargetCache for market ticker and strike value.
  // Never call fetchKalshiTarget with a targetTime here — that bypasses the
  // cache and causes 429s that poison the cache to null for all callers.
  const market = kalshiTargetCache.get(sym);
  if (!market?.ticker || market.value == null) return;

  // Guard: ensure cached market belongs to the current 15-min window.
  if (market.closeTime) {
    const marketCloseMs = new Date(market.closeTime).getTime();
    if (Math.abs(marketCloseMs - timing.closeAt) > 8 * 60_000) return;
  }

  // Use the fresh prices passed in by the poller — no cache reads here.
  const scanYesAsk = prices.yesAsk;
  const rawYesBid  = prices.yesBid ?? null;
  const scanYesBid = rawYesBid ?? (prices.noAsk != null ? +(1 - prices.noAsk).toFixed(2) : null);

  const eligibility = evaluateHighValueScalpEligibility({
    yesAsk: scanYesAsk,
    yesBid: scanYesBid,
    secondsRemaining: timing.secondsRemaining,
    config,
    activePosition: openPositions.get(sym) ?? null,
  });
  if (!eligibility.eligible || !eligibility.side || eligibility.price == null) {
    if (eligibility.reason && eligibility.reason !== "winning side outside scalp band"
        && eligibility.reason !== "outside final scalp window"
        && eligibility.reason !== "missing or crossed two-sided quote") {
      logger.info({ sym, windowKey: timing.windowKey, reason: eligibility.reason }, "[high-value-scalp] skipped");
    }
    return;
  }

  logger.info({ sym, windowKey: timing.windowKey, side: eligibility.side, price: eligibility.price }, "[high-value-scalp] eligible — checking caps");

  // Per-coin budget overrides the global bet amount when set.
  const budget = (coinOverride?.maxBetSize ?? config.highValueScalpBetAmount) ?? 25;
  // eligibility.price IS the ask price for the selected side (YES ask for YES,
  // NO ask = 1-yesBid for NO).  Do not invert it.
  const costPerContractScan = eligibility.price;
  if (Math.floor(budget / costPerContractScan) < 1) {
    logger.warn({ sym, budget, price: eligibility.price }, "[high-value-scalp] skipped — budget cannot buy one contract");
    return;
  }

  // Open exposure cap — null means no cap.
  const openCap = config.highValueScalpMaxOpenExposure ?? null;
  if (openCap !== null && currentScalpExposure(mode) + budget > openCap) {
    logger.warn({ sym, openCap, currentExposure: currentScalpExposure(mode), budget }, "[high-value-scalp] blocked — open exposure cap reached");
    return;
  }

  // Daily spend cap — null means no cap.
  const dailyCap = config.highValueScalpMaxDailySpend ?? null;
  const spendMap = modeSpend(mode);
  const dailySpend = spendMap.get(S.dailyDate) ?? 0;
  if (dailyCap !== null && dailySpend + budget > dailyCap) {
    logger.warn({ sym, dailyCap, dailySpend, budget }, "[high-value-scalp] blocked — daily spend cap reached");
    return;
  }

  if (mode === "live") {
    const balance = await getCachedKalshiBalance();
    S.accountBalance = balance;
    const minimum = config.minAccountBalance ?? 5;
    if (balance < minimum || balance < budget) {
      logger.warn({ sym, balance, minimum, budget }, "[high-value-scalp] blocked — insufficient balance");
      return;
    }
  }

  // Final price re-check immediately before order submission.
  // Read from the shared kalshiTargetCache — the conviction poller just
  // force-refreshed it in the same 1 s poll cycle, so this is the freshest
  // available Kalshi quote without making an extra API call.
  const finalEntry = kalshiTargetCache.get(sym);
  const finalYesAsk = finalEntry?.yesAsk ?? null;
  const finalRawYesBid = finalEntry?.yesBid ?? null;
  const finalYesBid = finalRawYesBid ?? (finalEntry?.noAsk != null ? +(1 - finalEntry.noAsk).toFixed(2) : null);
  const finalEligibility = evaluateHighValueScalpEligibility({
    yesAsk: finalYesAsk,
    yesBid: finalYesBid,
    secondsRemaining: currentWindowTiming().secondsRemaining,
    config,
    activePosition: openPositions.get(sym) ?? null,
  });
  if (!finalEligibility.eligible || finalEligibility.side !== eligibility.side || finalEligibility.price == null) {
    logger.info({ sym, windowKey: timing.windowKey, reason: finalEligibility.reason }, "[high-value-scalp] final check: price moved out of band");
    return;
  }
  logger.info({ sym, windowKey: timing.windowKey, side: finalEligibility.side, price: finalEligibility.price }, "[high-value-scalp] confirmed — placing order");

  // Same reasoning as costPerContractScan: eligibility.price IS the ask cost.
  const costPerContract = finalEligibility.price;
  let contracts = Math.floor(budget / costPerContract);
  if (contracts < 1) return;

  // ── TEST HARD-CAP MODE ────────────────────────────────────────────────────
  if (config.testHardCapEnabled && mode === "live") {
    const perBetCap = config.testHardCapPerBet ?? 1.00;
    const totalCap  = config.testHardCapTotal  ?? 4.00;
    if (S.testModeSpentAmount >= totalCap) {
      logger.warn({ sym, spent: +S.testModeSpentAmount.toFixed(2), cap: totalCap }, "[high-value-scalp] TEST HARD-CAP: session ceiling reached — blocked");
      return;
    }
    const cappedContracts = Math.max(1, Math.floor(perBetCap / costPerContract));
    if (cappedContracts < contracts) {
      logger.info({ sym, original: contracts, capped: cappedContracts, perBetCap }, "[high-value-scalp] TEST HARD-CAP: capping contracts to per-bet $ limit");
      contracts = cappedContracts;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  let filledCount = contracts;
  let fillYesPrice = finalEligibility.side === "yes" ? finalEligibility.price : 1 - finalEligibility.price;

  try {
    if (mode === "live") {
      const limitPrice = finalEligibility.side === "yes" ? finalEligibility.price : 1 - finalEligibility.price;
      const result = await placeEntryOrderWithSizeFallback({
        ticker: market.ticker,
        side: finalEligibility.side,
        action: "buy",
        count: contracts,
        type: "market",
        timeInForce: "immediate_or_cancel",
        limitPrice,
      });
      if (result.filledCount <= 0 || result.avgPrice == null) {
        logger.info({ sym, windowKey: timing.windowKey, contracts }, "[high-value-scalp] order returned zero fills — coin blocked for rest of window");
        return;
      }
      filledCount = result.filledCount;
      fillYesPrice = result.avgPrice;
    }
  } catch (err) {
    logger.warn({ err, sym, windowKey: timing.windowKey }, "[high-value-scalp] order error — coin blocked for rest of window");
    return;
  }

  const min = config.highValueScalpMinPrice ?? 0.90;
  const max = config.highValueScalpMaxPrice ?? 0.95;
  const actualSpend = filledCount * (finalEligibility.side === "yes" ? fillYesPrice : 1 - fillYesPrice);
  const actualSidePrice = finalEligibility.side === "yes" ? fillYesPrice : 1 - fillYesPrice;
  if (config.testHardCapEnabled && mode === "live") {
    S.testModeSpentAmount += actualSpend;
    logger.info({ sym, spend: +actualSpend.toFixed(2), sessionTotal: +S.testModeSpentAmount.toFixed(2), cap: config.testHardCapTotal ?? 4.00 }, "[high-value-scalp] TEST HARD-CAP: session spend updated");
  }

  // Out-of-band fill guard: if the exchange filled at a price outside the
  // configured band (race between final-check and fill), close immediately.
  // The fresh-price dispatch makes this very unlikely, but we handle it
  // defensively rather than holding an unintended position.
  if (mode === "live" && (actualSidePrice < min || actualSidePrice > max)) {
    logger.warn(
      { sym, side: finalEligibility.side, actualSidePrice, min, max, filledCount },
      "[high-value-scalp] out-of-band fill — attempting immediate close",
    );
    try {
      await placeOrder({
        ticker: market.ticker,
        side: finalEligibility.side,
        action: "sell",
        count: filledCount,
        type: "market",
        timeInForce: "immediate_or_cancel",
        limitPrice: actualSidePrice,
      });
      logger.warn({ sym, actualSidePrice }, "[high-value-scalp] out-of-band position closed — coin blocked for rest of window");
      return;
    } catch (closeErr) {
      logger.error(
        { closeErr, sym, actualSidePrice },
        "[high-value-scalp] out-of-band close failed — persisting for manual management",
      );
      // Fall through to persist so the operator can see and manage the position.
    }
  }

  const decision = scalpDecision(finalEligibility.side);
  const active = openPositions.get(sym);
  const id = active?.id ?? `scalp:${sym}:${timing.windowKey}:${Date.now()}`;

  if (active) {
    const oldCount = active.contractCount;
    const totalCount = oldCount + filledCount;
    const originalEntry = {
      contractCount: active.contractCount,
      entryYesPrice: active.entryYesPrice,
      betAmount: active.betAmount,
      openedAt: active.openedAt,
      direction: active.direction,
      decisionMode: (active.entryDecision?.signals as unknown as Record<string, unknown> | undefined)?.decisionMode ?? null,
    };
    active.entryYesPrice = ((active.entryYesPrice * oldCount) + (fillYesPrice * filledCount)) / totalCount;
    active.contractCount = totalCount;
    active.betAmount += actualSpend;
    active.highValueScalpAmount = (active.highValueScalpAmount ?? 0) + actualSpend;
    active.highValueScalpAddCount = (active.highValueScalpAddCount ?? 0) + 1;
    active.source = "high_value_scalp";
    await persistBetRecord({
      symbol: active.symbol, windowKey: active.windowKey, ticker: active.ticker,
      direction: active.direction, action: "high_value_scalp_add",
      signals: {
        ...(active.entryDecision.signals as unknown as Record<string, unknown>),
        highValueScalp: true, highValueScalpAddCount: active.highValueScalpAddCount,
        highValueScalpAmount: active.highValueScalpAmount,
        originalEntry,
        scalpLayer: { contractCount: filledCount, entryYesPrice: fillYesPrice, betAmount: actualSpend, addedAt: Date.now(), side: finalEligibility.side },
      },
      entryPrice: active.entryYesPrice, kalshiTarget: active.kalshiTarget,
      contractCount: active.contractCount, betAmount: active.betAmount,
      existingId: active.id, entryUpdate: true, source: "high_value_scalp",
      entryYesPrice: active.entryYesPrice, mode,
    });
  } else {
    const position: OpenPosition = {
      id, symbol: sym, windowKey: timing.windowKey, ticker: market.ticker,
      direction: finalEligibility.side, entryYesPrice: fillYesPrice,
      contractCount: filledCount, betAmount: actualSpend, kalshiTarget: market.value,
      openedAt: Date.now(), cryptoPriceAtEntry: null,
      exitState: makeInitialExitState(fillYesPrice), entryDecision: decision,
      phase2Activated: false, entryMode: mode, source: "high_value_scalp",
      highValueScalpAmount: actualSpend, highValueScalpAddCount: 1,
      entrySignals: { statAbove: null, claudeAbove: null, mlAbove: null },
    };
    openPositions.set(sym, position);
    await persistBetRecord({
      insertId: id, symbol: sym, windowKey: timing.windowKey, ticker: market.ticker,
      direction: finalEligibility.side, action: "high_value_scalp",
      signals: {
        highValueScalp: true, highValueScalpAmount: actualSpend,
        price: actualSidePrice, maxSecondsRemaining: config.highValueScalpMaxSecondsRemaining ?? 120,
      },
      entryPrice: fillYesPrice, entryYesPrice: fillYesPrice, kalshiTarget: market.value,
      contractCount: filledCount, betAmount: actualSpend, mode,
      decisionMode: config.decisionMode, source: "high_value_scalp",
    });
  }

  spendMap.set(S.dailyDate, dailySpend + actualSpend);
  invalidateBalanceCache();
  logger.info({ sym, windowKey: timing.windowKey, side: finalEligibility.side, filledCount, actualSpend, stacked: Boolean(active) }, "[high-value-scalp] confirmed fill");
}

/** Scan all Kalshi-backed markets using the current conviction price cache.
 * @deprecated Scalp detection is now driven by the conviction poller's
 * 1-second fresh-price cycle via runHighValueScalpForCoin().  This wrapper
 * is kept for callers that may reference it but is a no-op when the poller
 * is running. */
export async function runHighValueScalpScan(): Promise<void> {
  // No-op: the conviction poller calls runHighValueScalpForCoin() directly
  // on every fresh price update, so bot-loop-tick-based scanning is redundant
  // and would only introduce a second stale-cache read path.
}
