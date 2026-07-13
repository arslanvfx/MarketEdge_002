// Self-contained technical indicators for the stock module. Deliberately NOT
// imported from crypto.ts so the two systems stay fully decoupled — a change to
// crypto indicators can never affect stock signals and vice versa.

import type { Candle } from "./types";

export function sma(values: number[], period: number): number {
  if (values.length < period || period <= 0) return NaN;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

export function ema(values: number[], period: number): number {
  if (values.length === 0 || period <= 0) return NaN;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function stddev(values: number[], period: number): number {
  if (values.length < period || period <= 0) return NaN;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

/** Wilder's RSI. Returns 0-100 (50 = neutral). */
export function rsi(closes: number[], period = 14): number {
  if (closes.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Rolling SMA series: one value per input close, null during the warmup period. */
export function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Wilder's RSI series: one value per input close, null during the warmup period. */
export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = Math.max(0, diff);
    const loss = Math.max(0, -diff);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface Bollinger {
  upper: number;
  middle: number;
  lower: number;
  /** 0 = at/below lower band, 1 = at/above upper band. */
  position: number;
}

export function bollinger(closes: number[], period = 20, mult = 2): Bollinger {
  const middle = sma(closes, period);
  const sd = stddev(closes, period);
  const upper = middle + mult * sd;
  const lower = middle - mult * sd;
  const last = closes[closes.length - 1];
  let position = 0.5;
  if (upper > lower) position = (last - lower) / (upper - lower);
  return { upper, middle, lower, position: Math.max(0, Math.min(1, position)) };
}

/** Average True Range as a percentage of last price. */
export function atrPct(candles: Candle[], period = 14): number {
  if (candles.length <= period) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].c;
    const tr = Math.max(
      c.h - c.l,
      Math.abs(c.h - prevClose),
      Math.abs(c.l - prevClose),
    );
    trs.push(tr);
  }
  const atr = sma(trs, period);
  const last = candles[candles.length - 1].c;
  return last > 0 ? (atr / last) * 100 : 0;
}

/** Kaufman efficiency ratio over the window: 0 = pure chop, 1 = clean trend. */
export function efficiencyRatio(closes: number[], period = 14): number {
  if (closes.length <= period) return 0;
  const slice = closes.slice(-(period + 1));
  const net = Math.abs(slice[slice.length - 1] - slice[0]);
  let vol = 0;
  for (let i = 1; i < slice.length; i++) vol += Math.abs(slice[i] - slice[i - 1]);
  return vol === 0 ? 0 : net / vol;
}

/** Net directional drift over the window as a % of starting price. */
export function netDriftPct(closes: number[], period = 14): number {
  if (closes.length <= period) return 0;
  const start = closes[closes.length - 1 - period];
  const end = closes[closes.length - 1];
  return start > 0 ? ((end - start) / start) * 100 : 0;
}

/** Net buying vs selling pressure over recent candles: -1 (selling) .. 1 (buying). */
export function volumeDirectionBias(candles: Candle[], period = 8): number {
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  let buyVol = 0;
  let sellVol = 0;
  for (const c of slice) {
    if (c.c >= c.o) buyVol += c.v;
    else sellVol += c.v;
  }
  const total = buyVol + sellVol;
  return total === 0 ? 0 : (buyVol - sellVol) / total;
}

/** Ratio of latest volume vs the average of the prior `period` candles. */
export function volumeRatio(candles: Candle[], period = 20): number {
  if (candles.length <= period) return 1;
  const recent = candles[candles.length - 1].v;
  const prior = candles.slice(-(period + 1), -1);
  const avg = prior.reduce((a, c) => a + c.v, 0) / prior.length;
  return avg > 0 ? recent / avg : 1;
}

export type CandlePattern =
  | "shooting_star"
  | "hammer"
  | "bullish_engulfing"
  | "bearish_engulfing"
  | "none";

/** Detects a single reversal candle pattern on the most recent bar. */
export function candleReversal(candles: Candle[]): CandlePattern {
  if (candles.length < 2) return "none";
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const body = Math.abs(c.c - c.o);
  const range = c.h - c.l;
  if (range === 0) return "none";
  const upperWick = c.h - Math.max(c.c, c.o);
  const lowerWick = Math.min(c.c, c.o) - c.l;

  // Shooting star: small body, long upper wick, near lows.
  if (upperWick > body * 2 && lowerWick < body && body / range < 0.4) {
    return "shooting_star";
  }
  // Hammer: small body, long lower wick, near highs.
  if (lowerWick > body * 2 && upperWick < body && body / range < 0.4) {
    return "hammer";
  }
  // Engulfing patterns.
  const pBody = Math.abs(p.c - p.o);
  if (c.c > c.o && p.c < p.o && c.c >= p.o && c.o <= p.c && body > pBody) {
    return "bullish_engulfing";
  }
  if (c.c < c.o && p.c > p.o && c.o >= p.c && c.c <= p.o && body > pBody) {
    return "bearish_engulfing";
  }
  return "none";
}

/** Numeric encoding of a candle pattern for ML feature use: -1..1. */
export function candlePatternScore(pattern: CandlePattern): number {
  switch (pattern) {
    case "hammer":
    case "bullish_engulfing":
      return 1;
    case "shooting_star":
    case "bearish_engulfing":
      return -1;
    default:
      return 0;
  }
}

// ── EMA helper (internal) ─────────────────────────────────────────────────────
function emaSeries(data: number[], period: number): number[] {
  if (data.length === 0 || period <= 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let e = data[0];
  out.push(e);
  for (let i = 1; i < data.length; i++) {
    e = data[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export interface MACD {
  macd: number;
  signal: number;
  histogram: number;
  /** Crossover direction on the most recent bar. */
  crossover: "bullish" | "bearish" | "none";
}

/**
 * Standard MACD (12, 26, 9).
 * Returns zeros when there is not enough data for a valid reading.
 */
export function macd(closes: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): MACD {
  if (closes.length < slowPeriod + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0, crossover: "none" };
  }

  const fastEmas = emaSeries(closes, fastPeriod);
  const slowEmas = emaSeries(closes, slowPeriod);

  // MACD line: only valid once slowPeriod has warmed up.
  const macdLine: number[] = [];
  for (let i = slowPeriod - 1; i < closes.length; i++) {
    macdLine.push(fastEmas[i] - slowEmas[i]);
  }

  // Signal line: EMA(signalPeriod) of MACD line.
  const signalLine = emaSeries(macdLine, signalPeriod);

  const lastMACD = macdLine[macdLine.length - 1]!;
  const prevMACD = macdLine.length > 1 ? macdLine[macdLine.length - 2]! : lastMACD;
  const lastSignal = signalLine[signalLine.length - 1]!;
  const prevSignal = signalLine.length > 1 ? signalLine[signalLine.length - 2]! : lastSignal;

  const lastHist = lastMACD - lastSignal;
  const prevHist = prevMACD - prevSignal;

  let crossover: "bullish" | "bearish" | "none" = "none";
  if (prevHist <= 0 && lastHist > 0) crossover = "bullish";
  else if (prevHist >= 0 && lastHist < 0) crossover = "bearish";

  return { macd: lastMACD, signal: lastSignal, histogram: lastHist, crossover };
}

/**
 * VWAP (Volume-Weighted Average Price) from intraday candles.
 * Uses typical price (H+L+C)/3 weighted by volume.
 */
export function vwap(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  let cumTPV = 0;
  let cumVol = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    cumTPV += tp * c.v;
    cumVol += c.v;
  }
  return cumVol > 0 ? cumTPV / cumVol : 0;
}
