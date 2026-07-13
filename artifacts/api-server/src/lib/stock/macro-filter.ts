// SPY macro trend filter — blocks new long entries when the broad market is in a
// confirmed intraday downtrend. Uses 5-min SPY bars: VWAP position, SMA5/20
// crossover, and daily change %. Two of three bearish signals required.
// Results are cached 5 minutes to avoid extra data-rate pressure.

import { getBars } from "./alpaca";
import { sma, vwap } from "./indicators";
import { logger } from "../logger";

export type MacroTrend = "bullish" | "bearish" | "neutral";

export interface MacroSnapshot {
  trend: MacroTrend;
  spyPrice: number;
  spyChangePct: number;
  aboveVwap: boolean;
  sma5: number;
  sma20: number;
  computedAt: number;
}

let cache: MacroSnapshot | null = null;
const CACHE_TTL_MS = 5 * 60_000;

function neutral(computedAt = Date.now()): MacroSnapshot {
  return { trend: "neutral", spyPrice: 0, spyChangePct: 0, aboveVwap: true, sma5: 0, sma20: 0, computedAt };
}

/**
 * Returns current SPY intraday trend.
 * Fails open (returns "neutral") so a data hiccup never blocks entries entirely.
 */
export async function getMacroTrend(): Promise<MacroSnapshot> {
  if (cache && Date.now() - cache.computedAt < CACHE_TTL_MS) return cache;

  try {
    const candles = await getBars("SPY", "5Min", 30);
    if (candles.length < 10) return neutral();

    const closes = candles.map((c) => c.c);
    const price = closes[closes.length - 1]!;
    const dayOpen = candles[0]!.o;
    const changePct = dayOpen > 0 ? ((price - dayOpen) / dayOpen) * 100 : 0;

    const vwapVal = vwap(candles);
    const aboveVwap = vwapVal > 0 ? price >= vwapVal : true;

    const sma5Val = sma(closes, Math.min(5, closes.length));
    const sma20Val = sma(closes, Math.min(20, closes.length));

    // 2-of-3 rule for trend classification
    const bearish = [
      !aboveVwap,
      changePct < -0.4,
      sma20Val > 0 && sma5Val < sma20Val * 0.9995,
    ].filter(Boolean).length;

    const bullish = [
      aboveVwap,
      changePct > 0.3,
      sma20Val > 0 && sma5Val > sma20Val * 1.0005,
    ].filter(Boolean).length;

    const trend: MacroTrend =
      bearish >= 2 ? "bearish" : bullish >= 2 ? "bullish" : "neutral";

    cache = { trend, spyPrice: price, spyChangePct: changePct, aboveVwap, sma5: sma5Val, sma20: sma20Val, computedAt: Date.now() };
    logger.info(
      { trend, spy: price.toFixed(2), changePct: changePct.toFixed(2) + "%", aboveVwap, bearishCount: bearish },
      "[macro-filter] SPY trend updated",
    );
    return cache;
  } catch (err) {
    logger.warn({ err }, "[macro-filter] SPY trend check failed — defaulting neutral (fail-open)");
    return neutral();
  }
}

/** Clear the cache (call on new trading session). */
export function clearMacroCache(): void {
  cache = null;
}
