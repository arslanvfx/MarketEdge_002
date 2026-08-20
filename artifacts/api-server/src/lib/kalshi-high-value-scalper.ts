// ---------------------------------------------------------------------------
// High-value scalping
//
// Same workflow as regular conviction bets — same conviction-poller price
// cache, same order placement (placeEntryOrderWithSizeFallback), same bet
// persistence (persistBetRecord).  The only difference: this fires in the
// configured final window (default 6 min) when the winning-side contract
// ask is inside the configured price band (default 90–95¢), bypassing the
// normal model-signal gates.
//
// The scan runs serially across all coins every tick (no parallel Promise.all)
// so each coin sees the updated spend/exposure totals from coins checked
// before it — no reservation ledger needed.
// ---------------------------------------------------------------------------

import { logger } from "./logger";
import { kalshiTargetCache } from "./crypto-kalshi";
import { KALSHI_SERIES } from "./crypto";
import { getConvictionLivePrice } from "./kalshi-conviction-poller";
import { getCachedKalshiBalance, invalidateBalanceCache, placeEntryOrderWithSizeFallback } from "./kalshi-trader";
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

async function scanSymbol(sym: string, now: number): Promise<void> {
  const config = S.config;
  const timing = currentWindowTiming(now);
  const mode = S.botMode;
  const firedKey = `${sym}:${timing.windowKey}:${mode}`;

  // One scalp per coin per window per mode — checked before any awaits.
  if (highValueScalpFiredThisWindow.has(firedKey)) return;

  // Per-coin override: paused coin is skipped entirely.
  const coinOverride = config.highValueScalpCoinOverrides?.[sym];
  if (coinOverride?.paused) return;

  // Per-coin timing gate: if a tighter entry window is configured for this coin,
  // apply it before the eligibility check (global window already passed above).
  if (coinOverride?.maxSecondsRemaining != null && timing.secondsRemaining > coinOverride.maxSecondsRemaining) return;

  // Read from the shared kalshiTargetCache that the conviction poller and
  // normal bot loop keep fresh.  Never call fetchKalshiTarget with a
  // targetTime here — that bypasses the cache and causes 429s that poison
  // the cache to null for all callers.
  const market = kalshiTargetCache.get(sym);
  if (!market?.ticker || market.value == null) return;

  // Guard: ensure cached market belongs to the current 15-min window.
  if (market.closeTime) {
    const marketCloseMs = new Date(market.closeTime).getTime();
    if (Math.abs(marketCloseMs - timing.closeAt) > 8 * 60_000) return;
  }

  // Price from the conviction poller cache — the same source the MarketEdge
  // UI shows and the regular conviction tick uses.  No separate API call.
  const pollerPrice = getConvictionLivePrice(sym);
  const scanYesAsk = pollerPrice?.yesAsk ?? null;
  const rawYesBid  = pollerPrice?.yesBid ?? null;
  const scanYesBid = rawYesBid ?? (pollerPrice?.noAsk != null ? +(1 - pollerPrice.noAsk).toFixed(2) : null);

  const eligibility = evaluateHighValueScalpEligibility({
    yesAsk: scanYesAsk,
    yesBid: scanYesBid,
    secondsRemaining: currentWindowTiming().secondsRemaining,
    config,
    activePosition: openPositions.get(sym) ?? null,
  });
  if (!eligibility.eligible || !eligibility.side || eligibility.price == null) {
    // Only log when a position exists and is being blocked — otherwise this
    // fires for every coin on every tick and floods the log.
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
  // NO ask = 1-yesBid for NO).  Do not invert it — that would compute the
  // complementary side's price and cause 9× over-sizing on NO bets.
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
  // Same poller source — no separate orderbook call needed.
  const finalPollerPrice = getConvictionLivePrice(sym);
  const finalYesAsk = finalPollerPrice?.yesAsk ?? null;
  const finalRawYesBid = finalPollerPrice?.yesBid ?? null;
  const finalYesBid = finalRawYesBid ?? (finalPollerPrice?.noAsk != null ? +(1 - finalPollerPrice.noAsk).toFixed(2) : null);
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

  // Same reasoning as costPerContractScan: eligibility.price IS the ask cost
  // for the selected side — do not invert it for NO bets.
  const costPerContract = finalEligibility.price;
  const contracts = Math.floor(budget / costPerContract);
  if (contracts < 1) return;

  // Mark fired before the await so concurrent ticks (if any) see it immediately.
  highValueScalpFiredThisWindow.add(firedKey);

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
        logger.info({ sym, windowKey: timing.windowKey, contracts }, "[high-value-scalp] order returned zero fills");
        highValueScalpFiredThisWindow.delete(firedKey); // allow retry next tick
        return;
      }
      filledCount = result.filledCount;
      fillYesPrice = result.avgPrice;
    }
  } catch (err) {
    logger.warn({ err, sym, windowKey: timing.windowKey }, "[high-value-scalp] order error; will retry next tick");
    highValueScalpFiredThisWindow.delete(firedKey);
    return;
  }

  const actualSpend = filledCount * (finalEligibility.side === "yes" ? fillYesPrice : 1 - fillYesPrice);
  const actualSidePrice = finalEligibility.side === "yes" ? fillYesPrice : 1 - fillYesPrice;
  if (actualSidePrice < (config.highValueScalpMinPrice ?? 0.90) || actualSidePrice > (config.highValueScalpMaxPrice ?? 0.95)) {
    logger.error({ sym, side: finalEligibility.side, actualSidePrice }, "[high-value-scalp] out-of-band fill; holding for normal management");
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
        price: actualSidePrice, maxSecondsRemaining: config.highValueScalpMaxSecondsRemaining ?? 360,
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

/** Scan all Kalshi-backed markets. Safe to call on every ordinary bot-loop tick. */
export async function runHighValueScalpScan(): Promise<void> {
  if (!S.config.highValueScalpEnabled || S.dbDegradedSince !== null) return;
  const now = Date.now();
  const timing = currentWindowTiming(now);
  if (!isHighValueScalpWindowOpen(timing.secondsRemaining, S.config)) return;
  // Serial scan: each coin sees updated caps from coins checked before it.
  for (const sym of Object.keys(KALSHI_SERIES)) {
    await scanSymbol(sym, now);
  }
}
