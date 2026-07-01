// Candle-fetching helper. Chooses a timeframe/lookback appropriate to the
// trading mode and patches the final candle with the live trade price so
// indicators reflect the current tick rather than a stale bar close.

import { getBars, getLatestPrice } from "./alpaca";
import type { Candle, TradingMode } from "./types";

interface TfSpec {
  timeframe: string;
  limit: number;
}

export function timeframeFor(mode: TradingMode): TfSpec {
  switch (mode) {
    case "day":
      return { timeframe: "5Min", limit: 78 }; // ~1 session of 5-min bars
    case "swing":
      return { timeframe: "1Hour", limit: 120 };
    case "long":
      return { timeframe: "1Day", limit: 120 };
  }
}

/** Fetch candles for a ticker at the resolution for `mode`, live-patched. */
export async function getCandles(ticker: string, mode: TradingMode): Promise<Candle[]> {
  const { timeframe, limit } = timeframeFor(mode);
  const candles = await getBars(ticker, timeframe, limit);
  if (candles.length === 0) return candles;
  const live = await getLatestPrice(ticker);
  if (live != null && live > 0) {
    const lastIdx = candles.length - 1;
    const last = { ...candles[lastIdx] };
    last.c = live;
    if (live > last.h) last.h = live;
    if (live < last.l) last.l = live;
    candles[lastIdx] = last;
  }
  return candles;
}
