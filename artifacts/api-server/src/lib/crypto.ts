import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, predictionRecordsTable } from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";

// Real-time crypto price predictor.
//
// Price sources:
//   CoinGecko (primary) — free, no key, aggregates across all major exchanges.
//     /simple/price?ids=...&vs_currencies=usd&include_24hr_change=true
//   Coinbase Exchange (candles + 24h stats fallback) — no key, US-friendly.
//     candles: /products/{id}/candles?granularity=60  → [time,low,high,open,close,vol] newest-first
//     stats:   /products/{id}/stats  → { open(24h), high, low, last, volume }
//
// We pull recent 1-minute candles, compute a set of technical indicators, then
// project the price forward to the next quarter-hour boundaries (:00/:15/:30/:45).
// All predictions are model-based estimates derived from recent chart behaviour.

const COINBASE = "https://api.exchange.coinbase.com";
const COINGECKO = "https://api.coingecko.com/api/v3";
// Coinbase is the dominant constituent of CF Benchmarks RTI (the index
// Kalshi uses for all crypto 15-min markets). Using Coinbase for every
// coin keeps our displayed prices within cents of what Kalshi shows.
const UA = "MarketEdge/1.0 (crypto-predictor)";

// CoinGecko IDs for each symbol.
const GECKO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  LINK: "chainlink",
  DOGE: "dogecoin",
  HYPE: "hyperliquid",
  BNB:  "binancecoin",
};

export interface CoinDef {
  symbol: string;
  product: string;
  name: string;
}

export const CRYPTO_COINS: CoinDef[] = [
  { symbol: "BTC",  product: "BTC-USD",  name: "Bitcoin" },
  { symbol: "ETH",  product: "ETH-USD",  name: "Ethereum" },
  { symbol: "SOL",  product: "SOL-USD",  name: "Solana" },
  { symbol: "XRP",  product: "XRP-USD",  name: "XRP" },
  { symbol: "HYPE", product: "HYPE-USD", name: "Hyperliquid" },
  { symbol: "BNB",  product: "BNB-USD",  name: "BNB" },
  { symbol: "LINK", product: "LINK-USD", name: "Chainlink" },
  { symbol: "DOGE", product: "DOGE-USD", name: "Dogecoin" },
];

export interface Candle {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Prediction {
  target: string; // ISO timestamp of the quarter-hour boundary
  label: string; // EST formatted clock label, e.g. "10:15 AM"
  minutesAhead: number;
  predictedPrice: number;
  low: number;
  high: number;
  direction: "up" | "down" | "flat";
  confidence: number; // 0-100
  changePct: number; // vs current price
}

export interface CoinPrediction {
  symbol: string;
  product: string;
  name: string;
  price: number;
  change24hPct: number;
  change1hPct: number;
  high24h: number;
  low24h: number;
  indicators: {
    rsi: number;
    sma20: number;
    ema12: number;
    ema26: number;
    macd: number;
    trend: "up" | "down" | "flat";
    trendStrength: number; // 0-1 signal-to-noise
    volatilityPct: number; // per-minute vol as pct
    bbUpper: number;
    bbLower: number;
    bbWidth: number; // band width as % of SMA20
    bbPctB: number; // %B: 0=at lower band, 100=at upper band
    atr14: number; // Average True Range over 14 periods
    // Intra-window momentum (last 15 1-min candles)
    efficiencyRatio: number; // |net move| ÷ total path; 1=clean trend, 0=pure chop
    oscillationCount: number; // close-to-close direction reversals
    netDriftPct: number; // net signed move as % of window-open price
    totalPathPct: number; // sum of abs candle moves as % of window-open price
    spikeFlag: boolean; // any candle range > 3× the median range
    spikeMultiple: number; // largest candle range ÷ median range
  };
  sparkline: number[]; // recent closes (last ~60)
  candles: Candle[]; // recent candles for charting (last ~90)
  predictions: Prediction[];
  kalshiTarget?: number | null; // Kalshi RTI strike for the current 15-min window
}

export interface CoinPrice {
  symbol: string;
  product: string;
  name: string;
  price: number;
  change24hPct: number;
}

// ---------------------------------------------------------------------------
// Fetch helpers with a short in-memory cache to dedupe concurrent polling.
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

type CacheEntry<T> = { at: number; value: T };
const candleCache = new Map<string, CacheEntry<Candle[]>>();
const candle5mCache = new Map<string, CacheEntry<Candle[]>>();
const orderBookCache = new Map<string, CacheEntry<OrderBook>>();
const statsCache = new Map<string, CacheEntry<CoinStats>>();
const tickerCache = new Map<string, CacheEntry<number>>();
const CANDLE_TTL = 8_000;
const CANDLE_5M_TTL = 20_000; // 5-min candles update slowly
const ORDER_BOOK_TTL = 4_000; // order book changes fast — keep fresh
const STATS_TTL = 4_000;
const TICKER_TTL = 2_000; // very short — this is the per-tick live price
// Full coin analysis cache: live price/indicators refresh here (fallback only).
const PRED_TTL = 15_000;
const predCache = new Map<string, CacheEntry<CoinPrediction>>();

// Window-level prediction lock — the ABOVE/BELOW call and predicted price are
// committed once per 15-min window and never change until the next window opens.
// This eliminates flip-flopping: the stat model won't reverse its call mid-window
// just because one new candle shifted the regression by a hair.
const windowPredCache = new Map<string, { windowKey: string; predictions: Prediction[] }>();

// Returns the ISO-minute string for the START of the current 15-min window,
// e.g. "2026-06-25T15:30". Used as the window lock key.
function currentWindowKey(now: Date): string {
  const ms = now.getTime();
  const windowMs = Math.floor(ms / (15 * 60_000)) * (15 * 60_000);
  return new Date(windowMs).toISOString().slice(0, 16);
}

// Level-2 order book shape from Coinbase.
interface OrderBook {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}

// CoinGecko — single batched request for all coins (24h change reference).
interface GeckoEntry {
  usd: number;
  usd_24h_change: number;
}
type GeckoPrices = Record<string, GeckoEntry>;
let geckoCache: CacheEntry<GeckoPrices> | null = null;
const GECKO_TTL = 15_000; // CoinGecko free tier; only used for 24h change %

async function getGeckoPrices(): Promise<GeckoPrices> {
  if (geckoCache && Date.now() - geckoCache.at < GECKO_TTL) return geckoCache.value;
  const ids = Object.values(GECKO_ID).join(",");
  const data = await fetchJson<GeckoPrices>(
    `${COINGECKO}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
  );
  geckoCache = { at: Date.now(), value: data };
  return data;
}

// Live ticker price — Coinbase last-trade for all coins.
// Coinbase is the primary CF Benchmarks RTI constituent so this keeps us
// within cents of what Kalshi displays as the current reference price.
async function getTicker(product: string): Promise<number> {
  const hit = tickerCache.get(product);
  if (hit && Date.now() - hit.at < TICKER_TTL) return hit.value;
  const raw = await fetchJson<Record<string, string>>(
    `${COINBASE}/products/${product}/ticker`,
  );
  const price = parseFloat(raw.price ?? "0");
  tickerCache.set(product, { at: Date.now(), value: price });
  return price;
}

interface CoinStats {
  open: number;
  high: number;
  low: number;
  last: number;
  volume: number;
}

async function getCandles(product: string): Promise<Candle[]> {
  const hit = candleCache.get(product);
  if (hit && Date.now() - hit.at < CANDLE_TTL) return hit.value;
  const raw = await fetchJson<number[][]>(
    `${COINBASE}/products/${product}/candles?granularity=60`,
  );
  // Coinbase returns newest-first; reverse to oldest-first for indicator math.
  const candles: Candle[] = raw
    .map((r) => ({ t: r[0], l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] }))
    .sort((a, b) => a.t - b.t);
  candleCache.set(product, { at: Date.now(), value: candles });
  return candles;
}

async function getStats(product: string): Promise<CoinStats> {
  const hit = statsCache.get(product);
  if (hit && Date.now() - hit.at < STATS_TTL) return hit.value;
  const raw = await fetchJson<Record<string, string>>(
    `${COINBASE}/products/${product}/stats`,
  );
  const stats: CoinStats = {
    open: parseFloat(raw.open ?? "0"),
    high: parseFloat(raw.high ?? "0"),
    low: parseFloat(raw.low ?? "0"),
    last: parseFloat(raw.last ?? "0"),
    volume: parseFloat(raw.volume ?? "0"),
  };
  statsCache.set(product, { at: Date.now(), value: stats });
  return stats;
}

// 5-minute candles — last 48 bars = 4 hours of higher-timeframe context.
async function get5mCandles(product: string): Promise<Candle[]> {
  const hit = candle5mCache.get(product);
  if (hit && Date.now() - hit.at < CANDLE_5M_TTL) return hit.value;
  const raw = await fetchJson<number[][]>(
    `${COINBASE}/products/${product}/candles?granularity=300`,
  );
  const candles: Candle[] = raw
    .map((r) => ({ t: r[0], l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] }))
    .sort((a, b) => a.t - b.t)
    .slice(-48);
  candle5mCache.set(product, { at: Date.now(), value: candles });
  return candles;
}

// Coinbase Level-2 order book — top 20 levels each side.
async function getOrderBook(product: string): Promise<OrderBook> {
  const hit = orderBookCache.get(product);
  if (hit && Date.now() - hit.at < ORDER_BOOK_TTL) return hit.value;
  const raw = await fetchJson<{ bids: [string, string][]; asks: [string, string][] }>(
    `${COINBASE}/products/${product}/book?level=2`,
  );
  const parse = (rows: [string, string][]): Array<{ price: number; size: number }> =>
    (rows ?? []).slice(0, 20).map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }));
  const book: OrderBook = { bids: parse(raw.bids), asks: parse(raw.asks) };
  orderBookCache.set(product, { at: Date.now(), value: book });
  return book;
}

// ---------------------------------------------------------------------------
// Indicator math
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function sma(xs: number[], period: number): number {
  if (xs.length === 0) return 0;
  const slice = xs.slice(-period);
  return mean(slice);
}

function ema(xs: number[], period: number): number {
  if (xs.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = xs[0];
  for (let i = 1; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}

function rsi(closes: number[], period = 14): number {
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

function bollingerBands(
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

function atr(candles: Candle[], period = 14): number {
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

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// Intra-window momentum analysis over the last `window` 1-min candles.
// Answers: is price moving cleanly in one direction, or just oscillating?
// And: were there abnormal spike candles in the window?
function intraWindowMetrics(
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
function linReg(ys: number[]): { slope: number; r2: number } {
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

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// Error function (Abramowitz & Stegun 7.1.26) → normal CDF, used to turn the
// predicted drift-vs-noise ratio into a calibrated probability of the call.
function erf(x: number): number {
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

function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Volume-Weighted Average Price over a candle series.
function vwap(candles: Candle[]): number {
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
function priceDp(price: number): number {
  if (price >= 100) return 2;
  if (price >= 10)  return 3;
  if (price >= 1)   return 4;
  if (price >= 0.1) return 5;
  return 6;
}

// Returns the order-book bucket width that makes sense for a coin's price.
// BTC uses $50 buckets; slower/cheaper coins get proportionally tighter ones.
function obBucket(price: number): number {
  if (price >= 10000) return 50;
  if (price >= 1000)  return 5;
  if (price >= 100)   return 1;
  if (price >= 10)    return 0.5;
  if (price >= 1)     return 0.01;
  return 0.001;
}

// Bucket the Level-2 order book into price slots scaled to the coin's price.
// Returns a multi-line string ready to paste into a prompt.
function formatOrderBook(book: OrderBook, currentPrice: number, symbol = "units"): string {
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

// Market regime derived purely from the intra-window efficiency ratio, using
// the SAME thresholds the prompt shows Claude (see intraWindowBlock). Keeping
// one classifier means stored records bucket into exactly the regimes Claude
// reasoned about. "spike" is tracked separately as a flag, not a regime here.
type PromptRegime = "trending" | "drifting" | "choppy";
function regimeFromER(er: number): PromptRegime {
  if (er >= 0.55) return "trending";
  if (er >= 0.25) return "drifting";
  return "choppy";
}

// Format the intra-window momentum metrics (last 15 1-min candles) as a prompt
// block so Claude can temper confidence in choppy windows and treat spikes with
// caution. Mirrors the Price Action panel shown to the user on /predictor.
function intraWindowBlock(ind: CoinPrediction["indicators"]): string {
  const er = ind.efficiencyRatio;
  const regimeLabel: Record<PromptRegime, string> = {
    trending: "TRENDING (clean directional move — momentum is reliable)",
    drifting: "DRIFTING (mixed — momentum is weak, treat edge as modest)",
    choppy: "CHOPPY (price is sawing back and forth — momentum is unreliable)",
  };
  const regime = regimeLabel[regimeFromER(er)];
  const drift = ind.netDriftPct >= 0 ? "+" : "";
  const spikeLine = ind.spikeFlag
    ? `Spike: YES — a candle ranged ${ind.spikeMultiple.toFixed(2)}× the median; recent move may be a one-off blip, not sustained order flow.`
    : "Spike: none — candle ranges are orderly.";
  return `
INTRA-WINDOW MOMENTUM (last 15 × 1-min candles — what price is doing RIGHT NOW):
Regime: ${regime}
Efficiency ratio: ${er.toFixed(3)} (|net move| ÷ total path; 1=clean trend, 0=pure chop)
Oscillations: ${ind.oscillationCount} close-to-close direction reversals
Net drift: ${drift}${ind.netDriftPct.toFixed(3)}% | Total path travelled: ${ind.totalPathPct.toFixed(3)}%
${spikeLine}`;
}

// Minimum evaluated records a regime bucket needs before we trust its bias on
// its own. Below this we fall back to the coin's all-regime history so a thin
// bucket can't whipsaw the calibration note.
const BIAS_MIN_BUCKET = 3;

// Compute the average signed prediction error from the last N evaluated records
// for a coin. Positive = Claude has been predicting too high; negative = too low.
// When a regime is supplied, bias is computed from that regime's bucket (falling
// back coarser → all-regime when the bucket is too thin), because directional
// drift in a choppy market is a different beast than in a trending one. Always
// Claude-only (stat records would poison Claude's self-assessment).
// Returns a human-readable calibration instruction string.
function computeSignedBias(
  symbol: string,
  opts?: { regime?: PromptRegime; lastN?: number },
): string {
  const lastN = opts?.lastN ?? 10;
  const all = (historyStore.get(symbol) ?? []).filter(
    (r) =>
      r.source === "claude" &&
      r.status === "evaluated" &&
      r.actualPrice !== null &&
      (r.actualPrice ?? 0) > 0,
  );

  // Bucket by regime when asked and the bucket is deep enough; otherwise fall
  // back to all-regime history.
  let records = all;
  let scope = "all regimes";
  if (opts?.regime) {
    const bucket = all.filter(
      (r) => r.efficiencyRatio != null && regimeFromER(r.efficiencyRatio) === opts.regime,
    );
    if (bucket.length >= BIAS_MIN_BUCKET) {
      records = bucket;
      scope = `${opts.regime} regime`;
    }
  }
  records = records.slice(-lastN);

  if (records.length < 3) {
    return `Insufficient history for bias calibration (n=${records.length}, ${scope}).`;
  }

  // Percentage-based signed error: positive = predicted too high, negative = too low.
  const signedPctErrors = records.map(
    (r) => (((r.predictedPrice ?? 0) - (r.actualPrice ?? 0)) / (r.actualPrice ?? 1)) * 100,
  );
  const avg = signedPctErrors.reduce((a, b) => a + b, 0) / signedPctErrors.length;
  const absAvg = Math.abs(avg);

  if (absAvg < 0.5) {
    return `Well-calibrated: avg signed error ${avg >= 0 ? "+" : ""}${avg.toFixed(3)}% (n=${records.length}, ${scope}). No adjustment needed.`;
  }
  const dir = avg > 0 ? "HIGH" : "LOW";
  const adj = avg > 0 ? "DOWN" : "UP";
  return `CALIBRATION REQUIRED: recent predictions averaged ${absAvg.toFixed(2)}% too ${dir} (signed avg = ${avg >= 0 ? "+" : ""}${avg.toFixed(3)}%, n=${records.length}, ${scope}). Shift your price target ${adj} by ~${absAvg.toFixed(2)}% to correct this systematic bias.`;
}

// ---------------------------------------------------------------------------
// Self-learning performance analytics + confidence calibration
//
// Everything below reads from the in-memory history (kept in sync with the DB)
// and is pure/read-only except calibrateConfidence, which is still pure — it
// only consumes history to map a raw confidence onto an empirically-grounded one.
// ---------------------------------------------------------------------------

// Confidence bands aligned to the model's clamp range (20–92), matching the
// backtest module so the two analytics surfaces stay comparable.
const CONF_BANDS: Array<{ band: string; lo: number; hi: number }> = [
  { band: "20-39%", lo: 0, hi: 40 },
  { band: "40-54%", lo: 40, hi: 55 },
  { band: "55-69%", lo: 55, hi: 70 },
  { band: "70-92%", lo: 70, hi: 101 },
];
function confBand(c: number): { band: string; lo: number; hi: number } {
  return CONF_BANDS.find((b) => c >= b.lo && c < b.hi) ?? CONF_BANDS[CONF_BANDS.length - 1];
}

const REGIMES: PromptRegime[] = ["trending", "drifting", "choppy"];

export interface SourceMetrics {
  n: number;                       // evaluated records in this slice
  hits: number;
  accuracyPct: number | null;
  brier: number | null;            // mean (conf - outcome)^2 — confidence calibration quality
  signedBiasPct: number | null;    // +ve = predicted too high
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// Roll up accuracy / Brier / signed bias over a set of records. Brier is taken
// over the binary correct/incorrect outcome vs the stored (calibrated) confidence
// so the reported score reflects what the user actually sees.
function metricsFor(records: PredictionRecord[]): SourceMetrics {
  const ev = records.filter((r) => r.status === "evaluated" && r.correct !== null);
  const n = ev.length;
  if (n === 0) return { n: 0, hits: 0, accuracyPct: null, brier: null, signedBiasPct: null };
  const hits = ev.filter((r) => r.correct === true).length;
  const brier = mean(ev.map((r) => (r.confidence / 100 - (r.correct ? 1 : 0)) ** 2));
  const biasRecs = ev.filter((r) => r.actualPrice != null && (r.actualPrice ?? 0) > 0);
  const signedBiasPct =
    biasRecs.length > 0
      ? mean(biasRecs.map((r) => ((r.predictedPrice - (r.actualPrice ?? 1)) / (r.actualPrice ?? 1)) * 100))
      : null;
  return {
    n,
    hits,
    accuracyPct: Math.round((hits / n) * 100),
    brier: round3(brier),
    signedBiasPct: signedBiasPct != null ? round3(signedBiasPct) : null,
  };
}

export interface CoinAnalytics {
  symbol: string;
  bySource: { stat: SourceMetrics; claude: SourceMetrics };
  byRegime: { stat: Record<PromptRegime, SourceMetrics>; claude: Record<PromptRegime, SourceMetrics> };
  // Claude-only reliability curve: for each raw-confidence band, the rate at
  // which those calls actually came true. This is what calibration learns from.
  calibration: Array<{ band: string; n: number; avgConfidencePct: number | null; hitRatePct: number | null }>;
}

function regimeBreakdown(records: PredictionRecord[]): Record<PromptRegime, SourceMetrics> {
  const out = {} as Record<PromptRegime, SourceMetrics>;
  for (const reg of REGIMES) {
    out[reg] = metricsFor(
      records.filter((r) => r.efficiencyRatio != null && regimeFromER(r.efficiencyRatio) === reg),
    );
  }
  return out;
}

// The band value used for the reliability curve is Claude's RAW confidence so
// calibration never feeds on its own (already-calibrated) output. Pre-Task-50
// records have no rawConfidence, so we fall back to the stored confidence.
function bandValue(r: PredictionRecord): number {
  return r.rawConfidence ?? r.confidence;
}

export function getPredictionAnalytics(symbol: string): CoinAnalytics {
  const recs = historyStore.get(symbol.toUpperCase()) ?? [];
  const stat = recs.filter((r) => r.source === "stat");
  const claude = recs.filter((r) => r.source === "claude");
  const calClaude = claude.filter((r) => r.status === "evaluated" && r.correct !== null);
  const calibration = CONF_BANDS.map((b) => {
    const inBand = calClaude.filter((r) => bandValue(r) >= b.lo && bandValue(r) < b.hi);
    const n = inBand.length;
    const hits = inBand.filter((r) => r.correct === true).length;
    return {
      band: b.band,
      n,
      avgConfidencePct: n > 0 ? Math.round(mean(inBand.map(bandValue))) : null,
      hitRatePct: n > 0 ? Math.round((hits / n) * 100) : null,
    };
  });
  return {
    symbol: symbol.toUpperCase(),
    bySource: { stat: metricsFor(stat), claude: metricsFor(claude) },
    byRegime: { stat: regimeBreakdown(stat), claude: regimeBreakdown(claude) },
    calibration,
  };
}

export function getAllPredictionAnalytics(): CoinAnalytics[] {
  return CRYPTO_COINS.map((c) => getPredictionAnalytics(c.symbol));
}

// Min evaluated records in a confidence band before its observed hit rate is
// trusted; below this we pass the raw confidence through unchanged.
const CALIB_MIN_SAMPLES = 5;
// Shrinkage strength: calibrated conf is a sample-weighted blend of the raw
// confidence and the band's observed hit rate (weight = n/(n+K)). Larger K =
// more conservative (leans on the raw value until evidence accumulates).
const CALIB_SHRINK_K = 8;

// Map Claude's raw confidence onto its empirically-observed reliability. With
// few samples it passes through; as evidence accumulates it shrinks toward the
// band's real hit rate. Always clamped to the model's display range (20–92).
export function calibrateConfidence(symbol: string, rawConf: number): number {
  const claude = (historyStore.get(symbol.toUpperCase()) ?? []).filter(
    (r) => r.source === "claude" && r.status === "evaluated" && r.correct !== null,
  );
  const b = confBand(rawConf);
  const inBand = claude.filter((r) => bandValue(r) >= b.lo && bandValue(r) < b.hi);
  const n = inBand.length;
  if (n < CALIB_MIN_SAMPLES) return clamp(Math.round(rawConf), 20, 92);
  const hitRate = (inBand.filter((r) => r.correct === true).length / n) * 100;
  const w = n / (n + CALIB_SHRINK_K);
  const calibrated = rawConf * (1 - w) + hitRate * w;
  return clamp(Math.round(calibrated), 20, 92);
}

// ---------------------------------------------------------------------------
// Quarter-hour target generation (next 4 boundaries from now)
// ---------------------------------------------------------------------------

function nextQuarterTargets(now: Date, count = 4): Date[] {
  const targets: Date[] = [];
  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  // advance to the next quarter-hour strictly after `now`
  const minutesToNext = 15 - (d.getMinutes() % 15);
  d.setMinutes(d.getMinutes() + (minutesToNext === 0 ? 15 : minutesToNext));
  for (let i = 0; i < count; i++) {
    targets.push(new Date(d.getTime() + i * 15 * 60_000));
  }
  return targets;
}

function estLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

// ---------------------------------------------------------------------------
// Prediction model
// ---------------------------------------------------------------------------

function analyzeCoin(
  coin: CoinDef,
  candles: Candle[],
  stats: CoinStats,
  now: Date,
  geckoPrice?: number,
  orderBook?: OrderBook,
): CoinPrediction {
  // Prefer live ticker (CoinGecko/Kraken) → Coinbase last → latest candle close.
  const rawLastClose = candles.length > 0 ? candles[candles.length - 1].c : 0;
  const price = geckoPrice ?? (stats.last > 0 ? stats.last : rawLastClose);

  // Patch the live price into the last candle so that ALL indicator calculations
  // (RSI, MACD, Bollinger, trend regression) reflect the current real-time price
  // rather than the last completed 1-min candle close (which can be up to 60s stale).
  // Without this, Claude sees a contradictory prompt: "Current price: $X" but
  // every indicator computed from candles that closed at $Y — causing it to trust
  // the stale indicators and ignore the live price.
  let patchedCandles = candles;
  if (geckoPrice && geckoPrice > 0 && candles.length > 0) {
    const last = candles[candles.length - 1];
    if (Math.abs(geckoPrice - last.c) / (last.c || 1) > 0.0001) {
      patchedCandles = [
        ...candles.slice(0, -1),
        {
          ...last,
          c: geckoPrice,
          h: Math.max(last.h, geckoPrice),
          l: Math.min(last.l, geckoPrice),
        },
      ];
    }
  }

  const closes = patchedCandles.map((c) => c.c);

  // Per-minute log returns over the recent window.
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const recentRets = rets.slice(-60);
  const meanRet = mean(recentRets); // per-minute drift (log) — 60-min window for stability
  const vol = stddev(recentRets); // per-minute volatility (log)

  // Trend via linear regression over the last 60 minutes of price.
  const recentCloses = closes.slice(-60);
  const { slope, r2 } = linReg(recentCloses);
  const slopeRet = price > 0 ? slope / price : 0; // convert price slope to per-min return

  // Indicators.
  const rsiVal = rsi(closes, 14);
  const sma20 = sma(closes, 20);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = ema12 - ema26;
  const bb = bollingerBands(closes, 20, 2);
  const atr14 = atr(candles, 14);
  const iwm = intraWindowMetrics(patchedCandles, 15);

  // --- Regime-aware drift -------------------------------------------------
  // The blend of momentum / regression / mean-reversion adapts to how clean
  // the recent price action is (efficiency ratio). In clean trends we lean on
  // momentum + regression; in chop we fade extension back toward VWAP. This is
  // the main lever for raising hit rate in the choppy windows where a fixed
  // momentum blend performs worst.
  const ER = iwm.efficiencyRatio; // 0 = pure chop, 1 = clean one-way move
  let trendFactor = clamp((ER - 0.25) / (0.55 - 0.25), 0, 1);
  // A volatility spike marks a breakout/impulse that tends to continue over the
  // next 15 min, so lean momentum rather than fading it.
  if (iwm.spikeFlag) trendFactor = Math.max(trendFactor, 0.8);

  // Short-term volume: recent (5m) vs baseline (30m). Elevated volume confirms
  // a real trend; a volume burst inside chop tends to be climactic → reverts.
  const vols = patchedCandles.map((c) => c.v);
  const recentVol = mean(vols.slice(-5));
  const baseVol = mean(vols.slice(-30));
  const volRatio = baseVol > 0 ? recentVol / baseVol : 1;
  const volTilt = clamp((volRatio - 1) * 0.5, -0.3, 0.3);
  // Push trendFactor toward its current extreme: in a trend high volume → more
  // trend; in chop high volume → more chop (stronger reversion).
  trendFactor = clamp(trendFactor + volTilt * (trendFactor - 0.5) * 2, 0, 1);

  // Mean-reversion signal: pull back toward the recent VWAP, plus an RSI-extreme
  // nudge. Spread the total gap over the ~15-min window and cap it.
  const vwapVal = vwap(patchedCandles.slice(-30));
  const revGapTotal = vwapVal > 0 && price > 0 ? (vwapVal - price) / price : 0;
  const revPerMin = clamp(revGapTotal / 15, -0.001, 0.001);
  let rsiBias = 0;
  if (rsiVal > 70) rsiBias = -((rsiVal - 70) / 30) * 0.0004;
  else if (rsiVal < 30) rsiBias = ((30 - rsiVal) / 30) * 0.0004;
  const mrSignal = revPerMin + rsiBias;

  // Regime-weighted blend (weights sum to 1): momentum + regression dominate in
  // trends, mean-reversion dominates in chop.
  const wMom = 0.15 + 0.4 * trendFactor; // 0.15 → 0.55
  const wReg = 0.15 + 0.3 * trendFactor; // 0.15 → 0.45
  const wMR = Math.max(0, 1 - wMom - wReg); // 0.70 → 0.00
  let drift = wMom * meanRet + wReg * slopeRet + wMR * mrSignal;

  // Order-book imbalance (live only — never available in backtest, so it stays
  // neutral there). Top-of-book pressure nudges near-term drift/direction.
  if (orderBook && orderBook.bids.length > 0 && orderBook.asks.length > 0) {
    const topN = 10;
    const bidVol = orderBook.bids.slice(0, topN).reduce((s, b) => s + b.size, 0);
    const askVol = orderBook.asks.slice(0, topN).reduce((s, a) => s + a.size, 0);
    const denom = bidVol + askVol;
    const imbalance = denom > 0 ? (bidVol - askVol) / denom : 0; // -1..1
    drift += imbalance * 0.00015; // small per-minute nudge
  }

  // Trend classification (signal-to-noise of the slope vs volatility).
  const trendStrength = clamp(Math.abs(slopeRet) / (vol + 1e-9), 0, 1);
  let trend: "up" | "down" | "flat" = "flat";
  if (macd > 0 && slopeRet > 0) trend = "up";
  else if (macd < 0 && slopeRet < 0) trend = "down";
  else if (slopeRet > vol * 0.5) trend = "up";
  else if (slopeRet < -vol * 0.5) trend = "down";

  const change24hPct = stats.open > 0 ? ((price - stats.open) / stats.open) * 100 : 0;
  const price1hAgo = closes.length >= 61 ? closes[closes.length - 61] : closes[0];
  const change1hPct = price1hAgo > 0 ? ((price - price1hAgo) / price1hAgo) * 100 : 0;

  const targets = nextQuarterTargets(now, 4);
  const predictions: Prediction[] = targets.map((target) => {
    const minutesAhead = Math.max(1, Math.round((target.getTime() - now.getTime()) / 60_000));
    const predictedPrice = price * Math.exp(drift * minutesAhead);
    // ~1 sigma random-walk band scaling with sqrt(time).
    const band = price * vol * Math.sqrt(minutesAhead);
    const low = predictedPrice - band;
    const high = predictedPrice + band;
    const changePct = price > 0 ? ((predictedPrice - price) / price) * 100 : 0;
    let direction: "up" | "down" | "flat" = "flat";
    // 0.20% threshold (~$210 on BTC) requires a meaningful signal before
    // committing to a direction — eliminates noise-driven flips.
    if (changePct > 0.20) direction = "up";
    else if (changePct < -0.20) direction = "down";
    // Confidence = probability the ABOVE/BELOW call is correct under a
    // random-walk-with-drift model: predicted log-move vs the noise band
    // (vol·√t). Haircut in choppy/spike/low-fit regimes where the model is
    // less sure, then shrunk/capped (below) to match the achievable hit rate.
    const z = vol > 1e-9 ? (drift * Math.sqrt(minutesAhead)) / vol : 0;
    const pUp = normCdf(z);
    const pSide = Math.max(pUp, 1 - pUp); // prob of the side we actually call
    const fit = clamp(r2, 0, 1);
    const quality =
      clamp(0.4 + 0.4 * trendFactor + 0.2 * fit, 0.4, 1) * (iwm.spikeFlag ? 0.85 : 1);
    // Backtesting shows the raw drift/vol z-score has only a few points of real
    // directional skill at this horizon, so the probability edge is shrunk and
    // capped — keeping stated confidence close to the achievable hit rate.
    const conf = clamp(50 + (pSide * 100 - 50) * quality * 0.5, 50, 65);
    return {
      target: target.toISOString(),
      label: estLabel(target),
      minutesAhead,
      predictedPrice,
      low,
      high,
      direction,
      confidence: Math.round(conf),
      changePct,
    };
  });

  return {
    symbol: coin.symbol,
    product: coin.product,
    name: coin.name,
    price,
    change24hPct,
    change1hPct,
    high24h: stats.high,
    low24h: stats.low,
    indicators: {
      rsi: Math.round(rsiVal * 10) / 10,
      sma20,
      ema12,
      ema26,
      macd,
      trend,
      trendStrength: Math.round(trendStrength * 100) / 100,
      volatilityPct: Math.round(vol * 10000) / 100,
      bbUpper: bb.upper,
      bbLower: bb.lower,
      bbWidth: Math.round(bb.width * 100) / 100,
      bbPctB: Math.round(bb.pctB * 10) / 10,
      atr14,
      efficiencyRatio: iwm.efficiencyRatio,
      oscillationCount: iwm.oscillationCount,
      netDriftPct: iwm.netDriftPct,
      totalPathPct: iwm.totalPathPct,
      spikeFlag: iwm.spikeFlag,
      spikeMultiple: iwm.spikeMultiple,
    },
    sparkline: closes.slice(-60),
    candles: patchedCandles.slice(-90),
    predictions,
  };
}

// ---------------------------------------------------------------------------
// Backtest entry point: run the EXACT statistical model at a historical
// 15-min window open, given only the 1-min candles that had completed up to
// that moment plus the price at window open. Used by the accuracy backtest
// harness (lib/backtest.ts) so the harness always scores the real model
// (analyzeCoin), never a divergent copy. The returned predictions[0] targets
// the next quarter-hour boundary (+15 min) — exactly the live Kalshi window.
// ---------------------------------------------------------------------------
export function analyzeCoinAt(
  coin: CoinDef,
  candlesUpToOpen: Candle[],
  openPrice: number,
  windowOpen: Date,
): CoinPrediction {
  const highs = candlesUpToOpen.map((c) => c.h);
  const lows = candlesUpToOpen.map((c) => c.l);
  const stats: CoinStats = {
    open: candlesUpToOpen.length > 0 ? candlesUpToOpen[0].c : openPrice,
    high: highs.length > 0 ? Math.max(...highs) : openPrice,
    low: lows.length > 0 ? Math.min(...lows) : openPrice,
    last: openPrice,
    volume: 0,
  };
  // Pass openPrice as the "live" price so the last candle is patched to the
  // true window-open price — mirroring how the live tracker snaps at open.
  return analyzeCoin(coin, candlesUpToOpen, stats, windowOpen, openPrice);
}

// ---------------------------------------------------------------------------
// Claude AI prediction refinement — shared core used by both the automatic
// cache-refresh path and the on-demand /ai-predict endpoint.
// ---------------------------------------------------------------------------

export interface AIPrediction {
  minutesAhead: number;
  predictedPrice: number;
  low: number;
  high: number;
  direction: "up" | "down" | "flat";
  confidence: number;
}

// Calls Claude with the full chart context for a CoinPrediction.
// Returns refined predictions in the same order as coin.predictions, or null
// if Claude is unavailable (caller falls back to the statistical model).
async function callClaudeForPredictions(
  coin: CoinPrediction,
  extra?: { candles5m?: Candle[]; orderBook?: OrderBook; kalshiTarget?: number | null; windowOpenPrice?: number | null; minutesElapsed?: number },
): Promise<AIPrediction[] | null> {
  try {
    const dp = priceDp(coin.price);
    const recent = coin.candles.slice(-60);
    const candleRows = recent
      .map(
        (c) =>
          `${c.t},${c.o.toFixed(dp)},${c.h.toFixed(dp)},${c.l.toFixed(dp)},${c.c.toFixed(dp)},${c.v.toFixed(2)}`,
      )
      .join("\n");

    const rsiHint =
      coin.indicators.rsi >= 70 ? "overbought" : coin.indicators.rsi <= 30 ? "oversold" : "neutral";

    const bbPos =
      coin.indicators.bbPctB > 80
        ? "near upper band (overbought zone)"
        : coin.indicators.bbPctB < 20
          ? "near lower band (oversold zone)"
          : `mid-band (${coin.indicators.bbPctB.toFixed(1)}%B)`;

    // Highlight top-3 volume candles for Claude to flag unusual activity.
    const sorted = [...recent].sort((a, b) => b.v - a.v).slice(0, 3);
    const volSpikes = sorted
      .map((c) => `  t=${c.t} vol=${c.v.toFixed(2)} close=$${c.c.toFixed(dp)}`)
      .join("\n");

    // Claude only analyses the next 15-min boundary — stat model covers 30/45/60.
    const next15 = coin.predictions[0];
    const baselineRows = next15
      ? `+${next15.minutesAhead}min: $${next15.predictedPrice.toFixed(dp)}, range $${next15.low.toFixed(dp)}–$${next15.high.toFixed(dp)}, ${next15.direction}, conf ${next15.confidence}%`
      : "";

    // Expected 15-min price move range based on ATR (1–3× ATR per 15 min).
    const atr15Low  = (coin.indicators.atr14 * 1).toFixed(dp);
    const atr15High = (coin.indicators.atr14 * 3).toFixed(dp);
    const expectedMoveBlock = `Expected 15-min move range: $${atr15Low}–$${atr15High} (1–3× ATR). Your predictedPrice MUST be within this band of the current price and expressed to ${dp} decimal places — do NOT round to the nearest whole dollar or half-dollar.`;

    // ── B: 5-min candle block + VWAP ─────────────────────────────────────────
    let multiTfBlock = "";
    if (extra?.candles5m && extra.candles5m.length > 0) {
      const c5m = extra.candles5m.slice(-24); // last 2 hours at 5-min
      const vwapVal = vwap(c5m);
      const rows5m = c5m
        .map((c) => `${c.t},${c.o.toFixed(dp)},${c.h.toFixed(dp)},${c.l.toFixed(dp)},${c.c.toFixed(dp)},${c.v.toFixed(2)}`)
        .join("\n");
      const vwapRel = coin.price > vwapVal ? "above VWAP (bullish bias)" : "below VWAP (bearish bias)";
      multiTfBlock = `
VWAP (4-hour, 5-min candles): $${vwapVal.toFixed(dp)} — price is ${vwapRel}

LAST 24 × 5-MIN CANDLES — 2-hour structure (oldest first, unix/open/high/low/close/volume):
${rows5m}`;
    }

    // ── A: order book block ───────────────────────────────────────────────────
    let orderBookBlock = "";
    if (extra?.orderBook) {
      orderBookBlock = `
LIVE ORDER BOOK — $${obBucket(coin.price)} price buckets (use these as real support/resistance levels):
${formatOrderBook(extra.orderBook, coin.price, coin.symbol)}`;
    }

    // ── C: Kalshi target block (the primary decision anchor) ──────────────────
    let kalshiBlock = "";
    const kt = extra?.kalshiTarget ?? null;
    if (kt !== null && kt > 0) {
      const gap = ((coin.price - kt) / kt) * 100;
      const side = gap >= 0 ? "ABOVE" : "BELOW";
      let trajectoryLine = "";
      const wop = extra?.windowOpenPrice;
      const wme = extra?.minutesElapsed;
      if (wop && wop > 0 && wme != null) {
        const openGap = ((wop - kt) / kt) * 100;
        const openSide = openGap >= 0 ? "ABOVE" : "BELOW";
        const trend = Math.abs(gap) > Math.abs(openGap) ? "moving away from" : "moving toward";
        trajectoryLine = `\nWindow opened ${wme}min ago at $${wop.toFixed(dp)} (${Math.abs(openGap).toFixed(3)}% ${openSide}) — price is ${trend} the strike.`;
      }
      kalshiBlock = `
══ KALSHI 15-MIN BINARY TARGET ══════════════════════════════════════
Kalshi strike: $${kt.toFixed(dp)}
Current price: $${coin.price.toFixed(dp)} — ${Math.abs(gap).toFixed(3)}% ${side} the strike${trajectoryLine}
PRIMARY QUESTION: Will ${coin.symbol} close ABOVE or BELOW $${kt.toFixed(dp)}?
This is the binary you must answer. All indicators below are evidence for or against.
═════════════════════════════════════════════════════════════════════
`;
    }

    const userPrompt = `${kalshiBlock}Refine price predictions for ${coin.symbol} (${coin.name}).
Current price: $${coin.price.toFixed(dp)}

INDICATORS:
RSI(14): ${coin.indicators.rsi} (${rsiHint})
MACD: ${coin.indicators.macd >= 0 ? "Bullish" : "Bearish"} (signal: ${coin.indicators.macd.toFixed(4)})
Trend: ${coin.indicators.trend.toUpperCase()} | Strength: ${Math.round(coin.indicators.trendStrength * 100)}%
Volatility: ${coin.indicators.volatilityPct.toFixed(3)}%/min
SMA(20): $${coin.indicators.sma20.toFixed(dp)}
Bollinger Bands(20,2): upper=$${coin.indicators.bbUpper.toFixed(dp)} / lower=$${coin.indicators.bbLower.toFixed(dp)} | width=${coin.indicators.bbWidth.toFixed(2)}% | price ${bbPos}
ATR(14): $${coin.indicators.atr14.toFixed(dp)} (expected move per bar)
24h change: ${coin.change24hPct >= 0 ? "+" : ""}${coin.change24hPct.toFixed(2)}%
1h change: ${coin.change1hPct >= 0 ? "+" : ""}${coin.change1hPct.toFixed(2)}%
24h range: $${coin.low24h.toFixed(dp)}–$${coin.high24h.toFixed(dp)}
${intraWindowBlock(coin.indicators)}
${multiTfBlock}
TOP-3 VOLUME SPIKES (possible order-flow events):
${volSpikes}
${orderBookBlock}
RECENT 60 1-MIN CANDLES (oldest first, unix/open/high/low/close/volume):
${candleRows}

STATISTICAL MODEL BASELINE:
${baselineRows}

PRECISION REQUIREMENT:
${expectedMoveBlock}

Instructions:
1. Use the LIVE ORDER BOOK as your primary support/resistance map — walls are real levels, not inferred ones
2. Use the 5-min candles for 2-hour structure (trend, channels, key swing highs/lows) before zooming into the 1-min detail
3. Identify VWAP position: price above VWAP favors continuation up; below favors continuation down
4. Identify chart patterns and volume-price relationship on both timeframes
5. Use Bollinger Band position to judge momentum compression/expansion
6. Use ATR to calibrate realistic move size over each 15-minute window (see PRECISION REQUIREMENT above)
7. Weigh the INTRA-WINDOW MOMENTUM regime heavily: in a CHOPPY / low efficiency-ratio window price is sawing back and forth, so directional edge is weak — lower your confidence accordingly. Only a TRENDING (high ER) window justifies high confidence
8. If a spike is flagged, treat the recent move with caution — it may be a one-off blip rather than sustained order flow; do not over-extrapolate it
9. Produce your best price estimate for the NEXT 15-MIN TARGET ONLY, plus a pessimistic low and optimistic high
10. Set direction (up/down/flat) and confidence (0-100) based on signal confluence; penalise confidence when signals conflict or when the window is choppy

Return ONLY valid JSON with exactly 1 item:
{
  "analysis": [
    {"predictedPrice": 0.0, "low": 0.0, "high": 0.0, "direction": "up", "confidence": 70}
  ]
}`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 10000 },
      system:
        "You are an expert crypto technical analyst and quantitative trader. When a Kalshi binary target is shown, your primary job is to determine whether price will be above or below that strike — not just to predict general direction. Analyze chart patterns, indicators, and the live order book to produce refined short-term price predictions. Respond with ONLY valid JSON after your thinking — no markdown, no extra text.",
      messages: [{ role: "user", content: userPrompt }],
    } as Parameters<typeof anthropic.messages.create>[0]);

    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("") || "";
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned) as {
      analysis: Array<{
        predictedPrice: number;
        low: number;
        high: number;
        direction: string;
        confidence: number;
      }>;
    };

    if (!Array.isArray(parsed.analysis) || parsed.analysis.length === 0) {
      return null;
    }

    const VALID_DIRS = new Set<string>(["up", "down", "flat"]);
    return coin.predictions.map((pred, i) => {
      const ai = parsed.analysis[i];
      if (!ai) {
        return {
          minutesAhead: pred.minutesAhead,
          predictedPrice: pred.predictedPrice,
          low: pred.low,
          high: pred.high,
          direction: pred.direction,
          confidence: pred.confidence,
        };
      }
      return {
        minutesAhead: pred.minutesAhead,
        predictedPrice: Number(ai.predictedPrice) || pred.predictedPrice,
        low: Number(ai.low) || pred.low,
        high: Number(ai.high) || pred.high,
        direction: (VALID_DIRS.has(ai.direction) ? ai.direction : pred.direction) as
          | "up"
          | "down"
          | "flat",
        // Calibrate the confidence shown to the user the same way the stored
        // tracker calls are, so display and scored confidence stay consistent.
        confidence: calibrateConfidence(coin.symbol, Number(ai.confidence) || pred.confidence),
      };
    });
  } catch {
    return null; // caller uses statistical baseline
  }
}

// Merges AIPrediction results back into a CoinPrediction, updating price
// targets, ranges, directions, confidence, and changePct.
function applyAIPredictions(coin: CoinPrediction, aiPreds: AIPrediction[]): CoinPrediction {
  return {
    ...coin,
    predictions: coin.predictions.map((p, i) => {
      const ai = aiPreds[i];
      if (!ai) return p;
      const predictedPrice = ai.predictedPrice;
      return {
        ...p,
        predictedPrice,
        low: ai.low,
        high: ai.high,
        direction: ai.direction,
        confidence: ai.confidence,
        changePct: coin.price > 0 ? ((predictedPrice - coin.price) / coin.price) * 100 : p.changePct,
      };
    }),
  };
}

// On-demand endpoint — forces a fresh Claude analysis for the selected coin
// (bypasses the predCache so the user always gets a new read on demand).
export async function fetchAIPredictions(symbol: string): Promise<{
  coin: string;
  predictions: AIPrediction[];
  generatedAt: string;
}> {
  const coinDef = CRYPTO_COINS.find((c) => c.symbol === symbol.toUpperCase());
  if (!coinDef) throw new Error(`Unknown symbol: ${symbol}`);

  const now = new Date();
  const [candles, stats, tickerPrice, candles5m, orderBook, kalshiTargetPrice] = await Promise.all([
    getCandles(coinDef.product),
    getStats(coinDef.product),
    getTicker(coinDef.product).catch(() => 0),
    get5mCandles(coinDef.product).catch(() => [] as Candle[]),
    getOrderBook(coinDef.product).catch(() => undefined),
    fetchKalshiTarget(symbol.toUpperCase()).catch(() => null),
  ]);
  const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
  const coin = analyzeCoin(coinDef, candles, stats, now, livePrice);

  updateKalshiWindowPrice(getLastKalshiTicker(symbol.toUpperCase()), coin.price);
  const winCtx = getKalshiWindowContext(symbol.toUpperCase());
  const aiPreds = await callClaudeForPredictions(coin, {
    candles5m,
    orderBook,
    kalshiTarget: kalshiTargetPrice,
    windowOpenPrice: winCtx?.priceAtOpen,
    minutesElapsed: winCtx?.minutesElapsed,
  });
  if (!aiPreds) throw new Error("Claude analysis unavailable");

  return { coin: symbol, predictions: aiPreds, generatedAt: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Prediction History Tracker
// Snaps predictions at each 15-min boundary, evaluates accuracy once the
// window closes. Keeps up to 8 entries per coin (= 2 hours of history).
// ---------------------------------------------------------------------------

export interface PredictionRecord {
  symbol: string;
  snappedAt: string;              // ISO — when snapshot was taken
  targetTime: string;             // ISO — the 15-min boundary being predicted
  targetLabel: string;            // "10:15 AM" in ET
  priceAtSnapshot: number;        // live price when snapshot was captured
  predictedPrice: number;         // model's price target for targetTime
  predictedDirection: "up" | "down" | "flat";
  confidence: number;
  kalshiTarget: number | null;    // Kalshi KXBTC15M strike at snap time (BTC only)
  actualPrice: number | null;     // filled in after targetTime passes
  errorPct: number | null;        // abs % difference from predicted
  correct: boolean | null;        // was the Kalshi YES/NO call right?
  evaluatedAt: string | null;
  status: "pending" | "evaluated";
  source: "stat" | "claude";      // which model produced this prediction
  efficiencyRatio: number | null; // ER at snapshot — used to bucket by regime
  rawConfidence: number | null;   // Claude's pre-calibration confidence (claude only)
}

const QUARTER_MS = 15 * 60 * 1000;
const MAX_HISTORY = 30; // last 30 quarter-hour predictions per coin
// Fallback accuracy threshold used when no Kalshi target is available.
// For coins other than BTC (no KXBTC15M market), a prediction is a "hit"
// only if direction is correct AND price is within this % of actual.
export const ACCURACY_THRESHOLD_PCT = 1.0;

// ---------------------------------------------------------------------------
// Kalshi 15-min target price — fetched at snap time for BTC, ETH, XRP
// ---------------------------------------------------------------------------

// Map of symbol → Kalshi series ticker for coins that have 15-min markets.
export const KALSHI_SERIES: Record<string, string> = {
  BTC:  "KXBTC15M",
  ETH:  "KXETH15M",
  SOL:  "KXSOL15M",
  XRP:  "KXXRP15M",
  HYPE: "KXHYPE15M",
  BNB:  "KXBNB15M",
};

// Per-symbol cache so each coin's Kalshi target is fetched independently.
// Stores the event ticker so window transitions can be detected by callers.
const kalshiTargetCache = new Map<string, { value: number | null; ticker?: string; at: number }>();
const KALSHI_TARGET_LIB_TTL = 12_000;

// Returns the most-recently-seen event ticker for a symbol (e.g. "KXBTC15M-25JUN2026-B68000").
// Used by callers (which have the coin price) to detect new windows.
export function getLastKalshiTicker(symbol: string): string | undefined {
  return kalshiTargetCache.get(symbol.toUpperCase())?.ticker;
}

// Tracks the coin price when each Kalshi window opened, keyed by event ticker.
// Ticker is registered immediately when first seen in fetchKalshiTarget (time is exact).
// Coin price is filled in lazily on the first AI/snapshot call (where price is available).
const kalshiWindowStore = new Map<string, { priceAtOpen: number | null; openedAt: number }>();

function updateKalshiWindowPrice(ticker: string | undefined, coinPrice: number): void {
  if (!ticker || coinPrice <= 0) return;
  const existing = kalshiWindowStore.get(ticker);
  if (!existing) {
    // Shouldn't normally happen — fetchKalshiTarget registers tickers first.
    kalshiWindowStore.set(ticker, { priceAtOpen: coinPrice, openedAt: Date.now() });
  } else if (existing.priceAtOpen === null) {
    // First coin price we've seen for this ticker window — fill it in.
    existing.priceAtOpen = coinPrice;
  }
}

export function getKalshiWindowContext(symbol: string): { priceAtOpen: number | null; minutesElapsed: number } | null {
  const ticker = getLastKalshiTicker(symbol);
  if (!ticker) return null;
  const entry = kalshiWindowStore.get(ticker);
  if (!entry) return null;
  return {
    priceAtOpen: entry.priceAtOpen,
    minutesElapsed: Math.max(0, Math.round((Date.now() - entry.openedAt) / 60_000)),
  };
}

export async function fetchKalshiTarget(symbol: string): Promise<number | null> {
  const series = KALSHI_SERIES[symbol.toUpperCase()];
  if (!series) return null;
  const hit = kalshiTargetCache.get(symbol);
  if (hit && Date.now() - hit.at < KALSHI_TARGET_LIB_TTL) return hit.value;
  try {
    const resp = await fetch(
      `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=open&limit=5`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) {
      kalshiTargetCache.set(symbol, { value: null, at: Date.now() });
      return null;
    }
    const body = (await resp.json()) as { markets?: { floor_strike?: number; ticker?: string }[] };
    for (const m of body.markets ?? []) {
      if (typeof m.floor_strike === "number" && m.floor_strike > 0) {
        kalshiTargetCache.set(symbol, { value: m.floor_strike, ticker: m.ticker, at: Date.now() });
        // Register the window ticker immediately so minutesElapsed is accurate from first sight.
        // priceAtOpen is filled in lazily by updateKalshiWindowPrice (first caller with coin price).
        if (m.ticker && !kalshiWindowStore.has(m.ticker)) {
          kalshiWindowStore.set(m.ticker, { priceAtOpen: null, openedAt: Date.now() });
        }
        return m.floor_strike;
      }
    }
    kalshiTargetCache.set(symbol, { value: null, at: Date.now() });
    return null;
  } catch {
    return null;
  }
}
const historyStore = new Map<string, PredictionRecord[]>(); // symbol → records

export function getPredictionHistory(symbol: string): PredictionRecord[] {
  return (historyStore.get(symbol.toUpperCase()) ?? []).slice().reverse(); // newest first
}

export async function clearPredictionHistory(): Promise<void> {
  historyStore.clear();
  await db.delete(predictionRecordsTable);
}

// ---------------------------------------------------------------------------
// DB persistence helpers — fire-and-forget, never block the tracker
// ---------------------------------------------------------------------------

function rowToRecord(row: typeof predictionRecordsTable.$inferSelect): PredictionRecord {
  return {
    symbol: row.symbol,
    snappedAt: row.snappedAt.toISOString(),
    targetTime: row.targetTime.toISOString(),
    targetLabel: row.targetLabel,
    priceAtSnapshot: parseFloat(row.priceAtSnapshot),
    predictedPrice: parseFloat(row.predictedPrice),
    predictedDirection: row.predictedDirection as "up" | "down" | "flat",
    confidence: row.confidence,
    kalshiTarget: row.kalshiTarget != null ? parseFloat(row.kalshiTarget) : null,
    actualPrice: row.actualPrice != null ? parseFloat(row.actualPrice) : null,
    errorPct: row.errorPct != null ? parseFloat(row.errorPct) : null,
    correct: row.correct,
    evaluatedAt: row.evaluatedAt ? row.evaluatedAt.toISOString() : null,
    status: row.status as "pending" | "evaluated",
    source: (row.source as "stat" | "claude") ?? "stat",
    efficiencyRatio: row.efficiencyRatio != null ? parseFloat(row.efficiencyRatio) : null,
    rawConfidence: row.rawConfidence ?? null,
  };
}

async function initHistoryFromDB(): Promise<void> {
  try {
    const symbols = CRYPTO_COINS.map((c) => c.symbol);
    // Load the last MAX_HISTORY records per coin, newest first, then reverse per coin.
    const rows = await db
      .select()
      .from(predictionRecordsTable)
      .where(inArray(predictionRecordsTable.symbol, symbols))
      .orderBy(desc(predictionRecordsTable.targetTime))
      .limit(symbols.length * MAX_HISTORY);

    for (const sym of symbols) {
      const coinRows = rows.filter((r) => r.symbol === sym).reverse(); // oldest first
      historyStore.set(sym, coinRows.map(rowToRecord));
    }
  } catch (err) {
    console.error("[initHistoryFromDB] failed (non-fatal):", err);
  }
}

function dbInsertRecord(rec: PredictionRecord): void {
  const id = `${rec.symbol}-${rec.targetTime}`;
  db.insert(predictionRecordsTable)
    .values({
      id,
      symbol: rec.symbol,
      snappedAt: new Date(rec.snappedAt),
      targetTime: new Date(rec.targetTime),
      targetLabel: rec.targetLabel,
      priceAtSnapshot: String(rec.priceAtSnapshot),
      predictedPrice: String(rec.predictedPrice),
      predictedDirection: rec.predictedDirection,
      confidence: rec.confidence,
      kalshiTarget: rec.kalshiTarget != null ? String(rec.kalshiTarget) : null,
      actualPrice: null,
      errorPct: null,
      correct: null,
      evaluatedAt: null,
      status: "pending",
      source: rec.source,
      efficiencyRatio: rec.efficiencyRatio != null ? String(rec.efficiencyRatio) : null,
      rawConfidence: rec.rawConfidence,
    })
    .onConflictDoNothing()
    .catch((err) => console.error("[dbInsertRecord] failed:", err));
}

function dbUpdateRecord(rec: PredictionRecord): void {
  const id = `${rec.symbol}-${rec.targetTime}`;
  db.update(predictionRecordsTable)
    .set({
      actualPrice: rec.actualPrice != null ? String(rec.actualPrice) : null,
      errorPct: rec.errorPct != null ? String(rec.errorPct) : null,
      correct: rec.correct,
      evaluatedAt: rec.evaluatedAt ? new Date(rec.evaluatedAt) : null,
      status: rec.status,
    })
    .where(eq(predictionRecordsTable.id, id))
    .catch((err) => console.error("[dbUpdateRecord] failed:", err));
}

// ---------------------------------------------------------------------------
// Claude-powered refinement for the tracker snapshot.
// Called once per 15-min boundary per coin; falls back to statistical model.
// ---------------------------------------------------------------------------

async function refineSnappedPrediction(
  coin: CoinPrediction,
  basePred: Prediction,
  extra?: { candles5m?: Candle[]; orderBook?: OrderBook; kalshiTarget?: number | null; windowOpenPrice?: number | null; minutesElapsed?: number },
): Promise<{ predictedPrice: number; direction: "up" | "down" | "flat"; confidence: number } | null> {
  try {
    const dp = priceDp(coin.price);
    const recent = coin.candles.slice(-60);
    const candleRows = recent
      .map(
        (c) =>
          `${c.t},${c.o.toFixed(dp)},${c.h.toFixed(dp)},${c.l.toFixed(dp)},${c.c.toFixed(dp)},${c.v.toFixed(2)}`,
      )
      .join("\n");

    const rsiHint =
      coin.indicators.rsi >= 70
        ? "overbought"
        : coin.indicators.rsi <= 30
          ? "oversold"
          : "neutral";

    const bbPos =
      coin.indicators.bbPctB > 80
        ? "near upper band (overbought zone)"
        : coin.indicators.bbPctB < 20
          ? "near lower band (oversold zone)"
          : `mid-band (${coin.indicators.bbPctB.toFixed(1)}%B)`;

    // Top-3 volume candles to surface order-flow events.
    const sorted = [...recent].sort((a, b) => b.v - a.v).slice(0, 3);
    const volSpikes = sorted
      .map((c) => `  t=${c.t} vol=${c.v.toFixed(2)} close=$${c.c.toFixed(dp)}`)
      .join("\n");

    // Accuracy feedback: Claude's OWN last 5 evaluated predictions (raw
    // hit/miss). Filtering to source="claude" keeps the feedback loop honest —
    // statistical-model records would otherwise poison Claude's self-assessment.
    const recentEvals = (historyStore.get(coin.symbol) ?? [])
      .filter((r) => r.source === "claude" && r.status === "evaluated" && r.errorPct != null)
      .slice(-5);
    const feedbackStr =
      recentEvals.length > 0
        ? recentEvals
            .map(
              (r) =>
                `  ${r.targetLabel}: predicted $${r.predictedPrice?.toFixed(dp)} → actual $${r.actualPrice?.toFixed(dp)} | error ${r.errorPct?.toFixed(2)}% | ${r.correct ? "HIT ✓" : "MISS ✗"}`,
            )
            .join("\n")
        : "  No evaluated predictions yet.";

    // Learn-from-misses: Claude's 3 biggest recent MISSES (worst absolute
    // error), so the prompt confronts the model with its actual failure modes
    // rather than only the chronological tail. Claude-only by construction.
    const worstCalls = (historyStore.get(coin.symbol) ?? [])
      .filter((r) => r.source === "claude" && r.status === "evaluated" && r.correct === false && r.errorPct != null)
      .slice(-15)
      .sort((a, b) => (b.errorPct ?? 0) - (a.errorPct ?? 0))
      .slice(0, 3);
    const worstStr =
      worstCalls.length > 0
        ? worstCalls
            .map(
              (r) =>
                `  ${r.targetLabel}: called ${r.predictedDirection} → $${r.predictedPrice?.toFixed(dp)} (conf ${r.confidence}%) but actual $${r.actualPrice?.toFixed(dp)} | off by ${r.errorPct?.toFixed(2)}% ✗`,
            )
            .join("\n")
        : "  No notable recent misses.";

    // Per-source, regime-bucketed signed-bias calibration — computed from
    // Claude's own records only (see computeSignedBias), bucketed by the CURRENT
    // market regime so the correction reflects how Claude drifts in this kind of
    // window, not a global average that blends trending and choppy behaviour.
    const currentRegime = regimeFromER(coin.indicators.efficiencyRatio);
    const calibrationStr = computeSignedBias(coin.symbol, { regime: currentRegime });

    // Expected 15-min price move range based on ATR (1–3× ATR per 15 min).
    const atr15Low  = (coin.indicators.atr14 * 1).toFixed(dp);
    const atr15High = (coin.indicators.atr14 * 3).toFixed(dp);
    const expectedMoveBlock = `Expected 15-min move range: $${atr15Low}–$${atr15High} (1–3× ATR). Your predictedPrice MUST be within this band of the current price and expressed to ${dp} decimal places — do NOT round to the nearest whole dollar or half-dollar.`;

    // ── B: 5-min candles + VWAP ───────────────────────────────────────────────
    let multiTfBlock = "";
    if (extra?.candles5m && extra.candles5m.length > 0) {
      const c5m = extra.candles5m.slice(-24);
      const vwapVal = vwap(c5m);
      const rows5m = c5m
        .map((c) => `${c.t},${c.o.toFixed(dp)},${c.h.toFixed(dp)},${c.l.toFixed(dp)},${c.c.toFixed(dp)},${c.v.toFixed(2)}`)
        .join("\n");
      const vwapRel = coin.price > vwapVal ? "above VWAP (bullish bias)" : "below VWAP (bearish bias)";
      multiTfBlock = `
VWAP (4-hour, 5-min candles): $${vwapVal.toFixed(dp)} — price is ${vwapRel}

LAST 24 × 5-MIN CANDLES — 2-hour structure (oldest first, unix/open/high/low/close/volume):
${rows5m}`;
    }

    // ── A: order book block ───────────────────────────────────────────────────
    let orderBookBlock = "";
    if (extra?.orderBook) {
      orderBookBlock = `
LIVE ORDER BOOK — $${obBucket(coin.price)} price buckets (use as real support/resistance levels):
${formatOrderBook(extra.orderBook, coin.price, coin.symbol)}`;
    }

    // ── C: Kalshi target block (the primary decision anchor) ──────────────────
    let kalshiBlock = "";
    const kt = extra?.kalshiTarget ?? null;
    if (kt !== null && kt > 0) {
      const gap = ((coin.price - kt) / kt) * 100;
      const side = gap >= 0 ? "ABOVE" : "BELOW";
      let trajectoryLine = "";
      const wop = extra?.windowOpenPrice;
      const wme = extra?.minutesElapsed;
      if (wop && wop > 0 && wme != null) {
        const openGap = ((wop - kt) / kt) * 100;
        const openSide = openGap >= 0 ? "ABOVE" : "BELOW";
        const trend = Math.abs(gap) > Math.abs(openGap) ? "moving away from" : "moving toward";
        trajectoryLine = `\nWindow opened ${wme}min ago at $${wop.toFixed(dp)} (${Math.abs(openGap).toFixed(3)}% ${openSide}) — price is ${trend} the strike.`;
      }
      kalshiBlock = `
══ KALSHI 15-MIN BINARY TARGET ══════════════════════════════════════
Kalshi strike: $${kt.toFixed(dp)}
Current price: $${coin.price.toFixed(dp)} — ${Math.abs(gap).toFixed(3)}% ${side} the strike${trajectoryLine}
PRIMARY QUESTION: Will ${coin.symbol} close ABOVE or BELOW $${kt.toFixed(dp)} at ${basePred.label} ET?
This is the binary you must answer. All indicators below are evidence for or against.
═════════════════════════════════════════════════════════════════════
`;
    }

    const prompt = `${kalshiBlock}Predict the price of ${coin.symbol} (${coin.name}) at ${basePred.label} ET (+${basePred.minutesAhead} minutes from now).

Current price: $${coin.price.toFixed(dp)}

INDICATORS:
RSI(14): ${coin.indicators.rsi} (${rsiHint})
MACD: ${coin.indicators.macd >= 0 ? "Bullish" : "Bearish"} (signal: ${coin.indicators.macd.toFixed(4)})
Trend: ${coin.indicators.trend.toUpperCase()} | Strength: ${Math.round(coin.indicators.trendStrength * 100)}%
Volatility: ${coin.indicators.volatilityPct.toFixed(3)}%/min
SMA(20): $${coin.indicators.sma20.toFixed(dp)}
Bollinger Bands(20,2): upper=$${coin.indicators.bbUpper.toFixed(dp)} / lower=$${coin.indicators.bbLower.toFixed(dp)} | width=${coin.indicators.bbWidth.toFixed(2)}% | price ${bbPos}
ATR(14): $${coin.indicators.atr14.toFixed(dp)} (1-bar expected range)
24h change: ${coin.change24hPct >= 0 ? "+" : ""}${coin.change24hPct.toFixed(2)}%
1h change: ${coin.change1hPct >= 0 ? "+" : ""}${coin.change1hPct.toFixed(2)}%
24h range: $${coin.low24h.toFixed(dp)}–$${coin.high24h.toFixed(dp)}
${intraWindowBlock(coin.indicators)}
${multiTfBlock}
TOP-3 VOLUME SPIKES (potential order-flow events):
${volSpikes}
${orderBookBlock}
RECENT 60 1-MIN CANDLES (oldest first, unix/open/high/low/close/volume):
${candleRows}

STATISTICAL MODEL BASELINE: $${basePred.predictedPrice.toFixed(dp)}, ${basePred.direction}, conf ${basePred.confidence}%

YOUR RECENT ACCURACY FOR ${coin.symbol} (your own calls only):
${feedbackStr}

YOUR WORST RECENT CALLS FOR ${coin.symbol} (biggest misses — diagnose and avoid repeating these mistakes):
${worstStr}
CALIBRATION: ${calibrationStr}

PRECISION REQUIREMENT:
${expectedMoveBlock}

Analysis steps:
1. Use the LIVE ORDER BOOK as your primary support/resistance map — walls are real levels, not inferred ones
2. Use the 5-min candles for 2-hour structure before zooming into 1-min detail
3. Use VWAP position: above = bullish continuation bias; below = bearish continuation bias
4. Check volume spikes for order-flow confirmation of directional moves
5. Use Bollinger Band position to assess compression or expansion
6. Use ATR to ground your target — a 15-min move should be within 1–3× ATR (see PRECISION REQUIREMENT)
7. Weigh the INTRA-WINDOW MOMENTUM regime: a CHOPPY / low efficiency-ratio window means price is sawing back and forth with little directional edge — lower confidence. A spike flag means the latest move may be a one-off blip — do not over-extrapolate it
8. Set confidence 0-100; reduce when signals conflict or when the window is choppy

Return ONLY valid JSON (no markdown):
{"predictedPrice": 0.0, "direction": "up", "confidence": 70}`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 10000 },
      system:
        "You are an expert crypto technical analyst and quantitative trader. When a Kalshi binary target is shown, your primary job is to determine whether price will be above or below that strike at window close. Use multi-timeframe candle data, the live order book, technical indicators, VWAP, and your accuracy record as supporting evidence. Respond with ONLY valid JSON after your thinking — no markdown, no extra text.",
      messages: [{ role: "user", content: prompt }],
    } as Parameters<typeof anthropic.messages.create>[0]);

    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("") || "";
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned) as {
      predictedPrice: number;
      direction: string;
      confidence: number;
    };

    const VALID_DIRS = new Set<string>(["up", "down", "flat"]);
    return {
      predictedPrice: Number(parsed.predictedPrice) || basePred.predictedPrice,
      direction: (VALID_DIRS.has(parsed.direction)
        ? parsed.direction
        : basePred.direction) as "up" | "down" | "flat",
      confidence: Math.min(92, Math.max(20, Number(parsed.confidence) || basePred.confidence)),
    };
  } catch {
    return null; // fall back to statistical model
  }
}

// Self-consistency wrapper: when selfConsistencySamples > 1, independently
// samples Claude that many times and aggregates the calls — majority vote on
// direction, median predicted price among the agreeing samples, and a
// confidence that scales with the level of agreement. Sampling several times
// and aggregating dampens one-off outliers on the calls that matter most.
async function refineWithSelfConsistency(
  coin: CoinPrediction,
  basePred: Prediction,
  extra?: { candles5m?: Candle[]; orderBook?: OrderBook; kalshiTarget?: number | null; windowOpenPrice?: number | null; minutesElapsed?: number },
): Promise<{ predictedPrice: number; direction: "up" | "down" | "flat"; confidence: number } | null> {
  const samples = clamp(selfConsistencySamples, 1, MAX_SELF_CONSISTENCY);
  if (samples <= 1) return refineSnappedPrediction(coin, basePred, extra);

  const results = (
    await Promise.all(
      Array.from({ length: samples }, () => refineSnappedPrediction(coin, basePred, extra)),
    )
  ).filter((r): r is NonNullable<typeof r> => r !== null);

  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  // Majority vote on direction. Requires a STRICT plurality — if the top two
  // directions are tied (e.g. 1/1 on 2 samples, or 2/2 on 4), there is no
  // consensus, so we fall back to the statistical base direction rather than
  // letting object key order silently bias the call (toward "up").
  const counts: Record<"up" | "down" | "flat", number> = { up: 0, down: 0, flat: 0 };
  for (const r of results) counts[r.direction]++;
  const ranked = (Object.keys(counts) as Array<"up" | "down" | "flat">).sort(
    (a, b) => counts[b] - counts[a],
  );
  const direction: "up" | "down" | "flat" =
    counts[ranked[0]] > counts[ranked[1]] ? ranked[0] : basePred.direction;
  const agreeing = results.filter((r) => r.direction === direction);
  // If the consensus direction matched none of the samples (tie → base
  // direction with zero votes), aggregate across all samples instead so we
  // still return a sensible price/confidence.
  if (agreeing.length === 0) {
    return {
      predictedPrice: median(results.map((r) => r.predictedPrice)),
      direction,
      confidence: clamp(Math.round(mean(results.map((r) => r.confidence)) * 0.5), 20, 92),
    };
  }
  const agreement = agreeing.length / results.length;

  // Median predicted price among the agreeing samples (robust to outliers).
  const predictedPrice = median(agreeing.map((r) => r.predictedPrice));

  // Confidence = mean confidence of the agreeing samples, scaled by agreement
  // so a split vote (low consensus) is reported with proportionally less
  // certainty. Full agreement → mean confidence; 50/50 → roughly halved.
  const meanConf = mean(agreeing.map((r) => r.confidence));
  const confidence = clamp(Math.round(meanConf * (0.5 + 0.5 * agreement)), 20, 92);

  return { predictedPrice, direction, confidence };
}

// ── AI Mode Settings ─────────────────────────────────────────────────────────
// Controls whether Claude is used in the background tracker (costs money).
// Default: "stat" — statistical model only; Claude only runs when the user
// explicitly presses "Enhance" for a coin (which also sets claudeEnabledCoins).

let globalAiMode: "stat" | "claude" = "stat";
const claudeEnabledCoins = new Set<string>();

// Self-consistency: how many times to independently sample Claude per snapshot.
// 1 = off (single call). When >1, the calls are aggregated by majority vote on
// direction with a confidence that scales with agreement (see refineWithSelfConsistency).
let selfConsistencySamples = 1;
const MAX_SELF_CONSISTENCY = 5;

export function getAiSettings(): {
  mode: "stat" | "claude";
  claudeCoins: string[];
  selfConsistencySamples: number;
} {
  return {
    mode: globalAiMode,
    claudeCoins: [...claudeEnabledCoins],
    selfConsistencySamples,
  };
}

export function setSelfConsistencySamples(n: number): number {
  selfConsistencySamples = clamp(Math.round(n) || 1, 1, MAX_SELF_CONSISTENCY);
  return selfConsistencySamples;
}

export function isAiGloballyEnabled(): boolean {
  return globalAiMode === "claude";
}

export function setGlobalAiMode(mode: "stat" | "claude"): void {
  globalAiMode = mode;
  if (mode === "stat") claudeEnabledCoins.clear();
}

export function setCoinClaudeEnabled(symbol: string, enabled: boolean): void {
  if (enabled) {
    claudeEnabledCoins.add(symbol);
    globalAiMode = "claude";
  } else {
    claudeEnabledCoins.delete(symbol);
    if (claudeEnabledCoins.size === 0) globalAiMode = "stat";
  }
}

function isCoinClaudeEnabled(symbol: string): boolean {
  return globalAiMode === "claude" && claudeEnabledCoins.has(symbol);
}

export function startPredictionTracker(): void {
  const tick = async () => {
    const nowMs = Date.now();
    const nextBoundary = new Date(Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS);

    await Promise.all(
      CRYPTO_COINS.map(async (coin) => {
        const sym = coin.symbol;
        if (!historyStore.has(sym)) historyStore.set(sym, []);
        const records = historyStore.get(sym)!;

        // 1. Evaluate pending records whose target time has passed.
        for (const rec of records) {
          if (rec.status === "pending" && new Date(rec.targetTime).getTime() <= nowMs) {
            try {
              const actual = await getTicker(coin.product);
              const snapshotPrice = rec.priceAtSnapshot;
              const actualDir: "up" | "down" | "flat" =
                actual > snapshotPrice * 1.0002 ? "up"
                : actual < snapshotPrice * 0.9998 ? "down"
                : "flat";
              const errorPct =
                Math.abs((actual - rec.predictedPrice) / rec.predictedPrice) * 100;
              let correct: boolean;
              if (rec.kalshiTarget !== null && rec.kalshiTarget !== undefined) {
                // Kalshi target known: a "hit" = Claude predicted the same side of
                // the target as where BTC actually landed (mirrors Kalshi YES/NO).
                const predictedAbove = rec.predictedPrice >= rec.kalshiTarget;
                const actualAbove    = actual >= rec.kalshiTarget;
                correct = predictedAbove === actualAbove;
              } else {
                // No Kalshi target (non-BTC, or Kalshi market wasn't active at snap).
                // Fall back: direction correct AND price within threshold.
                const directionCorrect =
                  rec.predictedDirection === "flat"
                    ? actualDir === "flat"
                    : rec.predictedDirection === actualDir;
                correct = directionCorrect && errorPct <= ACCURACY_THRESHOLD_PCT;
              }
              rec.actualPrice = actual;
              rec.errorPct = errorPct;
              rec.correct = correct;
              rec.evaluatedAt = new Date().toISOString();
              rec.status = "evaluated";
              dbUpdateRecord(rec);
            } catch {
              // retry on next tick
            }
          }
        }

        // 2. Snapshot a new prediction for the next boundary if not already done.
        const targetISO = nextBoundary.toISOString();
        const timeToNext = nextBoundary.getTime() - nowMs;
        const alreadySnapped = records.some((r) => r.targetTime === targetISO);

        // Snapshot within the FIRST 4 minutes of a window opening, and only
        // if at least 60s remain (avoids right-at-boundary noise).
        // This ensures accuracy is measured against the call made at window OPEN,
        // not some random mid-window recompute.
        const windowStartMs = nextBoundary.getTime() - 15 * 60_000;
        const timeIntoWindow = nowMs - windowStartMs;
        if (!alreadySnapped && timeToNext > 60_000 && timeIntoWindow < 4 * 60_000) {
          try {
            const [candles, stats, tickerPrice, candles5m, orderBook, kalshiTargetSnap] = await Promise.all([
              getCandles(coin.product),
              getStats(coin.product),
              getTicker(coin.product).catch(() => 0),
              get5mCandles(coin.product).catch(() => [] as Candle[]),
              getOrderBook(coin.product).catch(() => undefined),
              fetchKalshiTarget(sym).catch(() => null),
            ]);
            const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
            const analysis = analyzeCoin(coin, candles, stats, new Date(nowMs), livePrice, orderBook);
            const basePred =
              analysis.predictions.find((p) => p.target === targetISO) ??
              analysis.predictions[0];
            if (basePred) {
              // Only call Claude if the user has enabled it for this coin.
              // Default: statistical model only (no cost).
              updateKalshiWindowPrice(getLastKalshiTicker(sym), analysis.price);
              const winCtxSnap = getKalshiWindowContext(sym);
              const useAI = isCoinClaudeEnabled(sym);
              const [ai, kalshiTarget] = await Promise.all([
                useAI
                  ? refineWithSelfConsistency(analysis, basePred, {
                      candles5m,
                      orderBook,
                      kalshiTarget: kalshiTargetSnap,
                      windowOpenPrice: winCtxSnap?.priceAtOpen,
                      minutesElapsed: winCtxSnap?.minutesElapsed,
                    })
                  : Promise.resolve(null),
                Promise.resolve(kalshiTargetSnap),
              ]);
              // Map Claude's reported confidence onto its empirically-observed
              // reliability before storing. rawConfidence keeps the pre-calibration
              // value so the reliability curve never learns from its own output.
              const rawConfidence = ai ? ai.confidence : null;
              const storedConfidence = ai
                ? calibrateConfidence(sym, ai.confidence)
                : basePred.confidence;
              const newRec: PredictionRecord = {
                symbol: sym,
                snappedAt: new Date(nowMs).toISOString(),
                targetTime: targetISO,
                targetLabel: basePred.label,
                priceAtSnapshot: analysis.price,
                predictedPrice: ai?.predictedPrice ?? basePred.predictedPrice,
                predictedDirection: ai?.direction ?? basePred.direction,
                confidence: storedConfidence,
                kalshiTarget,
                actualPrice: null,
                errorPct: null,
                correct: null,
                evaluatedAt: null,
                status: "pending",
                // Tag by the model that actually produced the stored call: when
                // Claude refinement succeeded it's "claude", otherwise the stat
                // baseline was used (Claude disabled or its call failed).
                source: ai ? "claude" : "stat",
                // Snapshot the regime input so accuracy/bias can be bucketed
                // later, and keep Claude's raw confidence for calibration.
                efficiencyRatio: analysis.indicators.efficiencyRatio,
                rawConfidence,
              };
              records.push(newRec);
              dbInsertRecord(newRec);
              if (records.length > MAX_HISTORY)
                records.splice(0, records.length - MAX_HISTORY);
            }
          } catch {
            // non-fatal — will retry next tick
          }
        }
      }),
    );
  };

  // Load DB history first, then tick immediately. Using .finally so a DB
  // failure doesn't block the tracker from starting.
  initHistoryFromDB()
    .catch(() => {})
    .finally(() => {
      tick().catch(() => {});
      setInterval(() => tick().catch(() => {}), 30_000);
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchCryptoPredictions(): Promise<{
  generatedAt: string;
  coins: CoinPrediction[];
}> {
  const now = new Date();
  const wk = currentWindowKey(now);

  const coins = await Promise.all(
    CRYPTO_COINS.map(async (coin) => {
      try {
        // Fetch Kalshi target in parallel (12s cache — no extra network hits per call).
        const kalshiTargetP = KALSHI_SERIES[coin.symbol]
          ? fetchKalshiTarget(coin.symbol).catch(() => null)
          : Promise.resolve(null);

        // Use predCache for live price/indicators (15s TTL keeps display responsive).
        const hit = predCache.get(coin.symbol);
        if (hit && Date.now() - hit.at < PRED_TTL) {
          // Indicators are fresh — still apply the window-locked predictions.
          const wHit = windowPredCache.get(coin.symbol);
          const kalshiTarget = await kalshiTargetP;
          if (wHit?.windowKey === wk) {
            return { ...hit.value, predictions: wHit.predictions, kalshiTarget };
          }
          return { ...hit.value, kalshiTarget };
        }

        const [candles, stats, tickerPrice, orderBook] = await Promise.all([
          getCandles(coin.product),
          getStats(coin.product),
          getTicker(coin.product).catch(() => 0),
          getOrderBook(coin.product).catch(() => undefined),
        ]);
        const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
        const result = analyzeCoin(coin, candles, stats, now, livePrice, orderBook);
        predCache.set(coin.symbol, { at: Date.now(), value: result });

        // Lock predictions for this 15-min window on first compute.
        // Subsequent calls within the same window return these exact predictions
        // — no flip-flopping even if new candles shift the regression.
        const wHit = windowPredCache.get(coin.symbol);
        if (!wHit || wHit.windowKey !== wk) {
          windowPredCache.set(coin.symbol, { windowKey: wk, predictions: result.predictions });
        }

        const lockedPreds = windowPredCache.get(coin.symbol)!.predictions;
        const kalshiTarget = await kalshiTargetP;
        return { ...result, predictions: lockedPreds, kalshiTarget };
      } catch {
        return null;
      }
    }),
  );
  return {
    generatedAt: now.toISOString(),
    coins: coins.filter((c): c is CoinPrediction => c !== null),
  };
}

// ---------------------------------------------------------------------------
// Dedicated Kalshi BTC call — one focused Claude question per market window
// ---------------------------------------------------------------------------

interface KalshiBtcCallResult {
  above: boolean;
  confidence: number;
  predictedPrice: number;
}

// Cache keyed by Kalshi eventTicker so the same answer is reused within a window.
const kalshiBtcCallCache = new Map<string, KalshiBtcCallResult>();

export async function fetchKalshiBtcCall(
  kalshiTarget: number,
  eventTicker: string,
): Promise<KalshiBtcCallResult | null> {
  // Return cached result for the same Kalshi window.
  const cached = kalshiBtcCallCache.get(eventTicker);
  if (cached) return cached;

  try {
    const btc = CRYPTO_COINS.find((c) => c.symbol === "BTC")!;
    const [candles, stats, tickerPrice] = await Promise.all([
      getCandles(btc.product),
      getStats(btc.product),
      getTicker(btc.product).catch(() => 0),
    ]);
    const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
    const analysis = analyzeCoin(btc, candles, stats, new Date(), livePrice);
    const price = livePrice ?? analysis.price;

    const recent = candles.slice(-20);
    const candleRows = recent
      .map((c) => `${c.t},${c.o.toFixed(2)},${c.h.toFixed(2)},${c.l.toFixed(2)},${c.c.toFixed(2)}`)
      .join("\n");

    const ind = analysis.indicators;
    const rsiHint = ind.rsi >= 70 ? "overbought" : ind.rsi <= 30 ? "oversold" : "neutral";

    const prompt = `BTC/USD Kalshi market question.

Current price: $${price.toFixed(2)}
Kalshi target (floor strike): $${kalshiTarget.toFixed(2)}
Gap to target: ${(price - kalshiTarget).toFixed(2)} (${((price - kalshiTarget) / kalshiTarget * 100).toFixed(3)}%)

INDICATORS:
RSI(14): ${ind.rsi.toFixed(1)} (${rsiHint})
MACD: ${ind.macd >= 0 ? "Bullish" : "Bearish"} (${ind.macd.toFixed(2)})
Trend: ${ind.trend.toUpperCase()} | Strength: ${Math.round(ind.trendStrength * 100)}%
Volatility: ${ind.volatilityPct.toFixed(3)}%/min
1h change: ${analysis.change1hPct.toFixed(3)}%

RECENT 20 1-MIN CANDLES (unix,open,high,low,close):
${candleRows}

Question: Will BTC close ABOVE or BELOW the Kalshi target of $${kalshiTarget.toFixed(2)} in the next 15 minutes?

Return ONLY valid JSON:
{"side":"above","predictedPrice":0.00,"confidence":70}`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      system:
        "You are an expert crypto short-term trader. You MUST respond with ONLY a raw JSON object — no markdown, no explanation, no analysis text. Your entire response is the JSON object and nothing else.",
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text : "";

    // Try to extract a JSON object anywhere in the response.
    let parsed: { side: string; predictedPrice: number; confidence: number } | null = null;
    const jsonMatch = raw.match(/\{[^{}]*"side"[^{}]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
    }

    // Fallback: parse the prose for ABOVE / BELOW keywords.
    if (!parsed) {
      const lower = raw.toLowerCase();
      const sideInferred = lower.includes("above") ? "above" : "below";
      const confMatch = lower.match(/(\d{2,3})%\s*confidence|\bconfidence[:\s]+(\d{2,3})/);
      const confidence = confMatch ? parseInt(confMatch[1] ?? confMatch[2]) : 65;
      const priceMatch = raw.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
      const inferredPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : price;
      parsed = { side: sideInferred, confidence, predictedPrice: inferredPrice || price };
    }

    const result: KalshiBtcCallResult = {
      above: parsed.side === "above",
      confidence: Math.min(95, Math.max(20, Number(parsed.confidence) || 60)),
      predictedPrice: Number(parsed.predictedPrice) || price,
    };

    kalshiBtcCallCache.set(eventTicker, result);
    // Evict old window answers (keep at most 5 entries)
    if (kalshiBtcCallCache.size > 5) {
      kalshiBtcCallCache.delete(kalshiBtcCallCache.keys().next().value!);
    }
    return result;
  } catch (err) {
    console.error("[fetchKalshiBtcCall] error:", err);
    return null;
  }
}

export async function fetchCryptoPrices(): Promise<{
  generatedAt: string;
  prices: CoinPrice[];
}> {
  const now = new Date();
  // Use CoinGecko for 24h change % (aggregated reference) and Coinbase ticker for
  // the live price (per-tick precision, full decimal, no rounding).
  const gecko = await getGeckoPrices().catch(() => ({} as GeckoPrices));

  const prices = await Promise.all(
    CRYPTO_COINS.map(async (coin) => {
      try {
        const geckoEntry = gecko[GECKO_ID[coin.symbol] ?? ""];
        // Always fetch ticker (precise live price) and stats (24h open for fallback change %).
        const [tickerPrice, stats] = await Promise.all([
          getTicker(coin.product),
          geckoEntry?.usd_24h_change == null ? getStats(coin.product) : Promise.resolve(null),
        ]);
        const change24hPct =
          geckoEntry?.usd_24h_change != null
            ? geckoEntry.usd_24h_change
            : stats
              ? stats.open > 0 ? ((tickerPrice - stats.open) / stats.open) * 100 : 0
              : 0;
        return {
          symbol: coin.symbol,
          product: coin.product,
          name: coin.name,
          price: tickerPrice,
          change24hPct,
        };
      } catch {
        // Full fallback: Coinbase stats
        try {
          const stats = await getStats(coin.product);
          const change24hPct =
            stats.open > 0 ? ((stats.last - stats.open) / stats.open) * 100 : 0;
          return {
            symbol: coin.symbol,
            product: coin.product,
            name: coin.name,
            price: stats.last,
            change24hPct,
          };
        } catch {
          return null;
        }
      }
    }),
  );
  return {
    generatedAt: now.toISOString(),
    prices: prices.filter((p): p is CoinPrice => p !== null),
  };
}
