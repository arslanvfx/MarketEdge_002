// Pure mathematical indicators and formatting helpers for crypto analysis.
// No external imports or shared state — every function here is a pure transform
// on its inputs, making it safe to import from both main code and tests.

export interface Candle {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface OrderBook {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}

// ---------------------------------------------------------------------------
// Indicator math
// ---------------------------------------------------------------------------

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function sma(xs: number[], period: number): number {
  if (xs.length === 0) return 0;
  const slice = xs.slice(-period);
  return mean(slice);
}

export function ema(xs: number[], period: number): number {
  if (xs.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = xs[0];
  for (let i = 1; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}

export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  // seed with the first `period` deltas
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

export function bollingerBands(
  closes: number[],
  period = 20,
  mult = 2,
): { upper: number; lower: number; width: number; pctB: number } {
  const s = sma(closes, period);
  const slice = closes.slice(-period);
  const sd = stddev(slice);
  const upper = s + mult * sd;
  const lower = s - mult * sd;
  const width = s > 0 ? ((upper - lower) / s) * 100 : 0;
  const lastClose = closes[closes.length - 1] ?? s;
  const pctB = upper !== lower ? ((lastClose - lower) / (upper - lower)) * 100 : 50;
  return { upper, lower, width, pctB };
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].c;
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - prev),
      Math.abs(candles[i].l - prev),
    );
    trs.push(tr);
  }
  return sma(trs, period);
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// Intra-window momentum analysis over the last `window` 1-min candles.
// Answers: is price moving cleanly in one direction, or just oscillating?
// And: were there abnormal spike candles in the window?
export function intraWindowMetrics(
  candles: Candle[],
  window = 15,
): {
  efficiencyRatio: number; // |net move| ÷ total path; 1=clean trend, 0=pure chop
  oscillationCount: number; // close-to-close direction reversals
  netDriftPct: number; // net signed move as % of window-open price
  totalPathPct: number; // sum of abs candle moves as % of window-open price
  spikeFlag: boolean; // any candle range > 3× the median range
  spikeMultiple: number; // largest candle range ÷ median range
} {
  const slice = candles.slice(-window);
  if (slice.length < 3) {
    return {
      efficiencyRatio: 0,
      oscillationCount: 0,
      netDriftPct: 0,
      totalPathPct: 0,
      spikeFlag: false,
      spikeMultiple: 0,
    };
  }

  const closes = slice.map((c) => c.c);
  const first = closes[0];
  const last = closes[closes.length - 1];
  const net = last - first;

  // Sum of absolute close-to-close moves = total path traveled.
  let totalPath = 0;
  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    deltas.push(d);
    totalPath += Math.abs(d);
  }

  const efficiencyRatio = totalPath > 0 ? Math.abs(net) / totalPath : 0;

  // Direction reversals: count sign flips across consecutive non-zero deltas.
  let oscillationCount = 0;
  let prevSign = 0;
  for (const d of deltas) {
    const sign = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (sign !== 0) {
      if (prevSign !== 0 && sign !== prevSign) oscillationCount++;
      prevSign = sign;
    }
  }

  // Spike detection: largest candle high-low range vs median range.
  // When the median range is zero (mostly flat candles) but one candle still
  // moved, treat that lone move as a spike with a capped multiple sentinel.
  const ranges = slice.map((c) => c.h - c.l);
  const medRange = median(ranges);
  const maxRange = Math.max(...ranges);
  const spikeMultiple = medRange > 0 ? maxRange / medRange : maxRange > 0 ? 99 : 0;
  const spikeFlag = spikeMultiple > 3;

  const netDriftPct = first > 0 ? (net / first) * 100 : 0;
  const totalPathPct = first > 0 ? (totalPath / first) * 100 : 0;

  return {
    efficiencyRatio: Math.round(efficiencyRatio * 1000) / 1000,
    oscillationCount,
    netDriftPct: Math.round(netDriftPct * 1000) / 1000,
    totalPathPct: Math.round(totalPathPct * 1000) / 1000,
    spikeFlag,
    spikeMultiple: Math.round(spikeMultiple * 100) / 100,
  };
}

// Ordinary least-squares slope (per index step) and R² over the series.
export function linReg(ys: number[]): { slope: number; r2: number } {
  const n = ys.length;
  if (n < 2) return { slope: 0, r2: 0 };
  const xs = ys.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * xs[i] + intercept;
    ssRes += (ys[i] - pred) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { slope, r2 };
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// Error function (Abramowitz & Stegun 7.1.26) → normal CDF, used to turn the
// predicted drift-vs-noise ratio into a calibrated probability of the call.
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Volume-Weighted Average Price over a candle series.
export function vwap(candles: Candle[]): number {
  let cumTPV = 0;
  let cumVol = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    cumTPV += tp * c.v;
    cumVol += c.v;
  }
  return cumVol > 0 ? cumTPV / cumVol : 0;
}

// Returns the number of decimal places appropriate for displaying a price.
// Ensures candle rows and prompt prices carry enough sub-cent granularity.
export function priceDp(price: number): number {
  if (price >= 100) return 2;
  if (price >= 10)  return 3;
  if (price >= 1)   return 4;
  if (price >= 0.1) return 5;
  return 6;
}

// Returns the order-book bucket width that makes sense for a coin's price.
// BTC uses $50 buckets; slower/cheaper coins get proportionally tighter ones.
export function obBucket(price: number): number {
  if (price >= 10000) return 50;
  if (price >= 1000)  return 5;
  if (price >= 100)   return 1;
  if (price >= 10)    return 0.5;
  if (price >= 1)     return 0.01;
  return 0.001;
}

// Bucket the Level-2 order book into price slots scaled to the coin's price.
// Returns a multi-line string ready to paste into a prompt.
export function formatOrderBook(book: OrderBook, currentPrice: number, symbol = "units"): string {
  const BUCKET = obBucket(currentPrice);
  const dp     = priceDp(currentPrice);
  const bucketAsk = new Map<number, number>();
  const bucketBid = new Map<number, number>();

  for (const { price, size } of book.asks) {
    const b = Math.ceil(price / BUCKET) * BUCKET;
    bucketAsk.set(b, (bucketAsk.get(b) ?? 0) + size);
  }
  for (const { price, size } of book.bids) {
    const b = Math.floor(price / BUCKET) * BUCKET;
    bucketBid.set(b, (bucketBid.get(b) ?? 0) + size);
  }

  const topAsks = [...bucketAsk.entries()]
    .sort(([a], [b]) => a - b)
    .slice(0, 6)
    .reverse();

  const topBids = [...bucketBid.entries()]
    .sort(([a], [b]) => b - a)
    .slice(0, 6);

  const fmt = (p: number, s: number) =>
    `  $${p.toFixed(dp)}: ${s.toFixed(4)} ${symbol}`;

  return [
    "  ASKS (potential resistance):",
    ...topAsks.map(([p, s]) => fmt(p, s)),
    `  ── spot $${currentPrice.toFixed(dp)} ──`,
    ...topBids.map(([p, s]) => fmt(p, s)),
    "  BIDS (potential support):",
  ].join("\n");
}
