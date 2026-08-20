// ---------------------------------------------------------------------------
// High-value scalping
//
// This is intentionally a standalone price-only execution path. It does not
// call makeBotDecision or the ordinary tick entry path, so its thresholds and
// market eligibility cannot alter normal bot behavior.
// ---------------------------------------------------------------------------

import { logger } from "./logger";
import { fetchKalshiTarget, fetchOrderbookPrices, kalshiTargetCache } from "./crypto-kalshi";
import { KALSHI_SERIES } from "./crypto";
import { getCachedKalshiBalance, invalidateBalanceCache, placeEntryOrderWithSizeFallback } from "./kalshi-trader";
import { makeInitialExitState } from "./kalshi-bot-exit";
import { persistBetRecord } from "./kalshi-bot-close";
import {
  S,
  openPositions,
  highValueScalpReservations,
  highValueScalpFiredThisWindow,
  paperHighValueScalpDailySpend,
  liveHighValueScalpDailySpend,
  type BotMode,
  type OpenPosition,
} from "./kalshi-bot-state";
import type { BotDecision } from "./kalshi-bot-engine";
import {
  evaluateHighValueScalpEligibility,
  type HighValueScalpSide,
} from "./kalshi-high-value-scalper-policy";
import { highValueScalpReservationLedger } from "./kalshi-high-value-scalper-ledger";
export { evaluateHighValueScalpEligibility } from "./kalshi-high-value-scalper-policy";

// Bounded per-market cadence. The final execution quote remains freshly fetched
// immediately before order submission; this only prevents repeated scans from
// amplifying ordinary loop traffic into a Kalshi API burst.
const lastScalpQuoteScanAt = new Map<string, number>();
const SCALP_MARKET_SCAN_INTERVAL_MS = 10_000;

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
    reasoning: "High-value scalp: fresh winning-side contract quote inside configured late-window price band.",
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
  const reservationKey = `${sym}:${timing.windowKey}:${mode}`;
  if (highValueScalpReservations.has(reservationKey) || highValueScalpFiredThisWindow.has(reservationKey)) return;
  const quoteScanKey = `${sym}:${timing.windowKey}`;
  if (now - (lastScalpQuoteScanAt.get(quoteScanKey) ?? 0) < SCALP_MARKET_SCAN_INTERVAL_MS) return;
  lastScalpQuoteScanAt.set(quoteScanKey, now);

  // Claim before the first await. Any abort releases this exact key.
  highValueScalpReservations.add(reservationKey);
  let budgetReserved = false;
  const release = () => {
    highValueScalpReservations.delete(reservationKey);
    if (budgetReserved) highValueScalpReservationLedger.release(reservationKey);
  };
  try {
    // Reuse the normal target cache; force-refreshing every market per bot tick
    // during the final window would throttle the shared Kalshi endpoint.
    await fetchKalshiTarget(sym, new Date(timing.closeAt));
    const market = kalshiTargetCache.get(sym);
    if (!market?.ticker || market.value == null) return;

    // Orderbook validation is deliberately required here; a cache/poller quote
    // is never sufficient for this strict late-window path.
    const orderbook = await fetchOrderbookPrices(market.ticker);
    const eligibility = evaluateHighValueScalpEligibility({
      yesAsk: orderbook?.yesAsk ?? null,
      yesBid: orderbook?.yesBid ?? null,
      secondsRemaining: currentWindowTiming().secondsRemaining,
      config,
      activePosition: openPositions.get(sym) ?? null,
    });
    if (!eligibility.eligible || !eligibility.side || eligibility.price == null) {
      logger.debug({ sym, windowKey: timing.windowKey, reason: eligibility.reason }, "[high-value-scalp] skipped");
      return;
    }

    const active = openPositions.get(sym);
    const budget = config.highValueScalpBetAmount ?? 25;
    if (Math.floor(budget / eligibility.price) < 1) {
      logger.warn({ sym, budget, price: eligibility.price }, "[high-value-scalp] skipped — configured budget cannot buy one contract");
      return;
    }
    const openCap = config.highValueScalpMaxOpenExposure ?? 100;
    const dailyCap = config.highValueScalpMaxDailySpend ?? 100;
    const spendMap = modeSpend(mode);
    const dailySpend = spendMap.get(S.dailyDate) ?? 0;
    // Reserve the full configured budget (rather than a stale quote estimate)
    // before the next await. Every concurrent symbol now sees this pending
    // amount in both independent caps.
    if (!highValueScalpReservationLedger.tryReserve({
      key: reservationKey, mode, amount: budget,
      currentExposure: currentScalpExposure(mode), maxExposure: openCap,
      currentDailySpend: dailySpend, maxDailySpend: dailyCap,
    })) {
      logger.warn({ sym, budget, openCap, dailySpend, dailyCap }, "[high-value-scalp] blocked — scalp cap reservation unavailable");
      return;
    }
    budgetReserved = true;
    if (mode === "live") {
      const balance = await getCachedKalshiBalance();
      S.accountBalance = balance;
      const minimum = config.minAccountBalance ?? 5;
      if (balance < minimum || balance < budget) {
        logger.warn({ sym, balance, minimum, budget }, "[high-value-scalp] blocked — insufficient available balance");
        return;
      }
    }

    // The price can move while balance checks run; require a second fresh,
    // two-sided quote and evaluate again immediately before order submission.
    const finalBook = await fetchOrderbookPrices(market.ticker);
    const finalEligibility = evaluateHighValueScalpEligibility({
      yesAsk: finalBook?.yesAsk ?? null,
      yesBid: finalBook?.yesBid ?? null,
      secondsRemaining: currentWindowTiming().secondsRemaining,
      config,
      activePosition: openPositions.get(sym) ?? null,
    });
    if (!finalEligibility.eligible || finalEligibility.side !== eligibility.side || finalEligibility.price == null) {
      logger.info({ sym, windowKey: timing.windowKey, reason: finalEligibility.reason }, "[high-value-scalp] final quote rejected");
      return;
    }
    // Recompute contract count from the final fresh price so an adverse quote
    // move cannot spend beyond the amount atomically reserved above.
    const contracts = Math.floor(budget / finalEligibility.price);
    if (contracts < 1) return;

    let filledCount = contracts;
    let fillYesPrice = finalEligibility.side === "yes"
      ? finalEligibility.price
      : 1 - finalEligibility.price;
    if (mode === "live") {
      const limitPrice = finalEligibility.side === "yes"
        ? finalEligibility.price
        : 1 - finalEligibility.price;
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
        logger.info({ sym, windowKey: timing.windowKey, contracts }, "[high-value-scalp] order returned zero fills; reservation released");
        return;
      }
      filledCount = result.filledCount;
      fillYesPrice = result.avgPrice;
    }

    const actualSpend = filledCount * (finalEligibility.side === "yes" ? fillYesPrice : 1 - fillYesPrice);
    // A price-improved fill must still be in the configured winning-side band.
    const actualSidePrice = finalEligibility.side === "yes" ? fillYesPrice : 1 - fillYesPrice;
    if (actualSidePrice < (config.highValueScalpMinPrice ?? 0.90) || actualSidePrice > (config.highValueScalpMaxPrice ?? 0.95)) {
      logger.error({ sym, side: finalEligibility.side, actualSidePrice }, "[high-value-scalp] unexpected out-of-band fill; holding position for normal management");
    }

    const decision = scalpDecision(finalEligibility.side);
    const id = active?.id ?? `scalp:${sym}:${timing.windowKey}:${Date.now()}`;
    if (active) {
      const oldCount = active.contractCount;
      const totalCount = oldCount + filledCount;
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
          price: actualSidePrice, maxMinutesRemaining: config.highValueScalpMaxMinutesRemaining ?? 2,
        },
        entryPrice: fillYesPrice, entryYesPrice: fillYesPrice, kalshiTarget: market.value,
        contractCount: filledCount, betAmount: actualSpend, mode,
        decisionMode: config.decisionMode, source: "high_value_scalp",
      });
    }
    // No await between release and commit: all other scans see the committed
    // spend or the provisional reservation, never a stale lower total.
    highValueScalpReservationLedger.release(reservationKey);
    budgetReserved = false;
    spendMap.set(S.dailyDate, (spendMap.get(S.dailyDate) ?? 0) + actualSpend);
    highValueScalpFiredThisWindow.add(reservationKey);
    invalidateBalanceCache();
    logger.info({ sym, windowKey: timing.windowKey, side: finalEligibility.side, filledCount, actualSpend, stacked: Boolean(active) }, "[high-value-scalp] confirmed fill");
  } catch (err) {
    logger.warn({ err, sym, windowKey: timing.windowKey }, "[high-value-scalp] execution error; reservation released");
  } finally {
    release();
  }
}

/** Scan all Kalshi-backed markets. Safe to call on every ordinary bot-loop tick. */
export async function runHighValueScalpScan(): Promise<void> {
  if (!S.config.highValueScalpEnabled || S.dbDegradedSince !== null) return;
  const now = Date.now();
  const timing = currentWindowTiming(now);
  if (timing.secondsRemaining > (S.config.highValueScalpMaxMinutesRemaining ?? 2) * 60) return;
  await Promise.allSettled(Object.keys(KALSHI_SERIES).map((sym) => scanSymbol(sym, now)));
}