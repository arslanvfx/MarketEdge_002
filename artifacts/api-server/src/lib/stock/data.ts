// Candle-fetching helper. Chooses a timeframe/lookback appropriate to the
// trading mode and patches the final candle with the live trade price so
// indicators reflect the current tick rather than a stale bar close.

import { getBars, getLatestPrice } from "./alpaca";
import { smaSeries, rsiSeries, sma } from "./indicators";
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

// ---------- Chart data (detail-page charting with MA + RSI series) ----------

export type ChartRange = "1D" | "5D" | "1M" | "3M" | "6M" | "1Y";

export const CHART_RANGES: ChartRange[] = ["1D", "5D", "1M", "3M", "6M", "1Y"];

interface RangeSpec {
  timeframe: string;
  /** Number of bars shown on the chart. */
  display: number;
  daily: boolean;
}

function rangeSpec(range: ChartRange): RangeSpec {
  switch (range) {
    case "1D":  return { timeframe: "5Min",  display: 78,  daily: false }; // 1 session
    case "5D":  return { timeframe: "15Min", display: 130, daily: false }; // 5 sessions
    case "1M":  return { timeframe: "1Day",  display: 22,  daily: true };
    case "3M":  return { timeframe: "1Day",  display: 66,  daily: true };
    case "6M":  return { timeframe: "1Day",  display: 126, daily: true };
    case "1Y":  return { timeframe: "1Day",  display: 250, daily: true };
  }
}

export interface ChartData {
  range: ChartRange;
  resolution: string;
  candles: Candle[];
  /** Per-candle 21-day SMA. Flat (current daily value) on intraday ranges. */
  sma21: (number | null)[];
  sma50: (number | null)[];
  sma180: (number | null)[];
  /** Per-candle RSI(14) at the chart's own resolution. */
  rsi14: (number | null)[];
}

function livePatch(candles: Candle[], live: number | null): Candle[] {
  if (candles.length === 0 || live == null || live <= 0) return candles;
  const lastIdx = candles.length - 1;
  const last = { ...candles[lastIdx] };
  last.c = live;
  if (live > last.h) last.h = live;
  if (live < last.l) last.l = live;
  const out = candles.slice();
  out[lastIdx] = last;
  return out;
}

/**
 * Fetch chart candles for a range plus pre-computed 21D/50D/180D SMA and
 * RSI(14) series, all index-aligned with `candles`.
 *
 * Daily ranges compute rolling daily SMAs (fetching extra warmup history so
 * the lines start at the left edge of the chart when the feed has enough
 * bars). Intraday ranges (1D/5D) show the *current* daily MA levels as flat
 * reference lines, since a 21-day average barely moves within a session.
 */
export async function getChartData(ticker: string, range: ChartRange): Promise<ChartData> {
  const spec = rangeSpec(range);

  if (spec.daily) {
    const [bars, live] = await Promise.all([
      getBars(ticker, "1Day", spec.display + 180),
      getLatestPrice(ticker),
    ]);
    const candles = livePatch(bars, live);
    const closes = candles.map((c) => c.c);
    const s21 = smaSeries(closes, 21);
    const s50 = smaSeries(closes, 50);
    const s180 = smaSeries(closes, 180);
    const r14 = rsiSeries(closes, 14);
    const from = Math.max(0, candles.length - spec.display);
    return {
      range,
      resolution: spec.timeframe,
      candles: candles.slice(from),
      sma21: s21.slice(from),
      sma50: s50.slice(from),
      sma180: s180.slice(from),
      rsi14: r14.slice(from),
    };
  }

  const [bars, dailyBars, live] = await Promise.all([
    getBars(ticker, spec.timeframe, spec.display),
    getBars(ticker, "1Day", 250),
    getLatestPrice(ticker),
  ]);
  const candles = livePatch(bars, live);
  const dailyCloses = livePatch(dailyBars, live).map((c) => c.c);
  const flat = (period: number): number | null => {
    const v = sma(dailyCloses, period);
    return isNaN(v) ? null : v;
  };
  const ma21 = flat(21);
  const ma50 = flat(50);
  const ma180 = flat(180);
  const closes = candles.map((c) => c.c);
  return {
    range,
    resolution: spec.timeframe,
    candles,
    sma21: candles.map(() => ma21),
    sma50: candles.map(() => ma50),
    sma180: candles.map(() => ma180),
    rsi14: rsiSeries(closes, 14),
  };
}
