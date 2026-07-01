import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, predictionRecordsTable, mlWindowSnapshotsTable, mlModelStateTable, windowMonitorOutcomesTable, windowTimingSnapshotsTable } from "@workspace/db";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { extractMLFeatures } from "./ml-features";
import {
  captureMLSnapshot,
  labelWindowAndRetrain,
  initMLFromDB,
  getMLPrediction,
  getMLStatus,
} from "./ml-store";
import {
  AUTOPILOT_MAX_ACTIVE,
  type AutoPilotDecision,
  claudeEnabledFor,
  computeAutoPilotDecisions,
} from "./autopilot";
import { mlSnapPrice, computeStatWindowCall, SNAP_QUARTER_MS } from "./prediction-utils";
import { logger } from "./logger";

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

// Lock cache for the Window Monitor "BET / STAY AWAY" signal: once the first
// 5 minutes of a window have been observed, the recommendation is locked for
// the rest of that window so it never flip-flops mid-window.
const windowBetSignalLockCache = new Map<string, { windowKey: string; signal: WindowBetSignal }>();

// Tracks which window monitor signals have already been persisted to DB so the
// tick loop doesn't insert duplicates.  Lost on restart — the DB insert uses
// onConflictDoNothing, so a restart simply re-attempts the insert harmlessly.
const wmRecordedKeys = new Set<string>();

// Tracks which intra-window timing snapshots have been written this session.
// Lost on restart — onConflictDoNothing makes repeated inserts harmless.
const timingSnapshotWritten = new Set<string>();

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

// Abstention quality for the ensemble: of the windows where it chose NOT to
// bet, how often was that the right call (the would-be bet would have lost)?
export interface AbstentionMetrics {
  evaluated: number;       // abstained ensemble records that have been evaluated
  avoidedLoss: number;     // abstained AND the would-be call was wrong (good skip)
  missedWin: number;       // abstained BUT the would-be call was right (bad skip)
  avoidedLossPct: number | null; // avoidedLoss / evaluated
}

export interface CoinAnalytics {
  symbol: string;
  // Ensemble metrics cover BET windows only (abstentions excluded), so its
  // accuracy is comparable to a model that always takes a position.
  bySource: { stat: SourceMetrics; claude: SourceMetrics; ensemble: SourceMetrics };
  byRegime: {
    stat: Record<PromptRegime, SourceMetrics>;
    claude: Record<PromptRegime, SourceMetrics>;
    ensemble: Record<PromptRegime, SourceMetrics>;
  };
  abstention: AbstentionMetrics;
  // Claude-only reliability curve: for each raw-confidence band, the rate at
  // which those calls actually came true. This is what calibration learns from.
  calibration: Array<{ band: string; n: number; avgConfidencePct: number | null; hitRatePct: number | null }>;
  // Server-computed blend weights the ensemble ACTUALLY uses. `overall` is the
  // all-regime baseline; `byRegime` is the regime-aware weight applied when the
  // live market is in that regime (what computeEnsemble picks per window).
  ensembleWeights: {
    overall: EnsembleWeights;
    byRegime: Record<PromptRegime, EnsembleWeights>;
  };
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
  const ensembleAll = recs.filter((r) => r.source === "ensemble");
  // Ensemble accuracy reflects only the windows where it actually BET — skipping
  // abstentions, which are scored separately as abstention quality below.
  const ensembleBets = ensembleAll.filter((r) => r.abstained !== true);
  const ensembleAbstainedEval = ensembleAll.filter(
    (r) => r.abstained === true && r.status === "evaluated" && r.correct !== null,
  );
  const avoidedLoss = ensembleAbstainedEval.filter((r) => r.correct === false).length;
  const missedWin = ensembleAbstainedEval.filter((r) => r.correct === true).length;
  const abstention: AbstentionMetrics = {
    evaluated: ensembleAbstainedEval.length,
    avoidedLoss,
    missedWin,
    avoidedLossPct:
      ensembleAbstainedEval.length > 0
        ? Math.round((avoidedLoss / ensembleAbstainedEval.length) * 100)
        : null,
  };
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
  // Build the metrics first, then derive the blend weights FROM that object —
  // ensembleWeights(symbol) would re-enter getPredictionAnalytics and recurse,
  // so the weight helpers below take the already-computed analytics instead.
  const base: Omit<CoinAnalytics, "ensembleWeights"> = {
    symbol: symbol.toUpperCase(),
    bySource: {
      stat: metricsFor(stat),
      claude: metricsFor(claude),
      ensemble: metricsFor(ensembleBets),
    },
    byRegime: {
      stat: regimeBreakdown(stat),
      claude: regimeBreakdown(claude),
      ensemble: regimeBreakdown(ensembleBets),
    },
    abstention,
    calibration,
  };
  const byRegimeWeights = {} as Record<PromptRegime, EnsembleWeights>;
  for (const reg of REGIMES) byRegimeWeights[reg] = ensembleWeightsFor(base, reg);
  return {
    ...base,
    ensembleWeights: {
      overall: overallWeightsFor(base),
      byRegime: byRegimeWeights,
    },
  };
}

export function getAllPredictionAnalytics(): CoinAnalytics[] {
  return CRYPTO_COINS.map((c) => getPredictionAnalytics(c.symbol));
}

// ---------------------------------------------------------------------------
// Best-trading-windows analytics
// Groups training-coin history by ET hour-of-day and day-of-week to surface
// when the market is most predictable.  Reads directly from the DB (no row
// limit) so the panel survives server restarts with a full history, while
// falling back to the in-memory historyStore on DB error.
// ---------------------------------------------------------------------------

const TW_MIN_BUCKET        = 10;  // samples per hour/day bucket — all-coin mode
const TW_MIN_BUCKET_SINGLE =  3;  // single-coin: spread thinner, still meaningful
const TW_MIN_TOTAL         = 50;  // total windows before recommendations — all-coin
const TW_MIN_TOTAL_SINGLE  = 10;  // single-coin total threshold

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtHourLabel(h: number): string {
  if (h === 0)  return "12 AM";
  if (h < 12)   return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

export interface TradingWindowBucket {
  count: number;
  evaluatedCount: number;
  accuracyPct: number | null;
  avgEfficiencyRatio: number | null;
  trendingPct: number | null;
  sparse: boolean;
}

export interface RecommendedWindow {
  hour: number;
  label: string;
  score: number;
  avgEfficiencyRatio: number;
  accuracyPct: number | null;
  rank: "best" | "worst";
}

export interface TradingWindowsData {
  hourly: Array<TradingWindowBucket & { hour: number; label: string }>;
  daily: Array<TradingWindowBucket & { dayIndex: number; label: string }>;
  /** 7-element array (Sun=0…Sat=6), each containing 24 hourly buckets.
   *  Lets the UI show "best hours on Mondays" etc. */
  byDayHour: Array<Array<TradingWindowBucket & { hour: number; label: string }>>;
  recommendedWindows: RecommendedWindow[];
  totalSamples: number;
  lastUpdatedAt: string;
  recommendation: string;
  hasEnoughData: boolean;
}

export async function getTradingWindows(filterSymbol?: string): Promise<TradingWindowsData> {
  const symbols = filterSymbol
    ? TRAINING_COINS.has(filterSymbol) ? [filterSymbol] : []
    : [...TRAINING_COINS];

  // Scale thresholds down for single-coin mode: 48 windows spread across
  // ~20 active hours yields only 2-4 per bucket — far below the all-coin
  // TW_MIN_BUCKET of 10. Single-coin analysis is still meaningful at 3+.
  const minBucket = symbols.length === 1 ? TW_MIN_BUCKET_SINGLE : TW_MIN_BUCKET;
  const minTotal  = symbols.length === 1 ? TW_MIN_TOTAL_SINGLE  : TW_MIN_TOTAL;

  // Fetch all DB records for the requested training coins (no row limit so the
  // panel keeps growing across server restarts).  Fall back to in-memory store
  // if the DB query fails — this keeps the endpoint functional even if Postgres
  // is temporarily unavailable.
  let sourceRecords: PredictionRecord[];
  try {
    if (symbols.length === 0) {
      sourceRecords = [];
    } else {
      const rows = await db
        .select()
        .from(predictionRecordsTable)
        .where(inArray(predictionRecordsTable.symbol, symbols))
        .orderBy(desc(predictionRecordsTable.targetTime));
      sourceRecords = rows.map(rowToRecord);
    }
  } catch {
    // Fallback: read from capped in-memory store so the endpoint still responds.
    sourceRecords = symbols.flatMap((sym) => historyStore.get(sym) ?? []);
  }

  // One representative record per (symbol, window) — stat preferred (always has ER).
  const windowMap = new Map<string, PredictionRecord>();
  for (const r of sourceRecords) {
    const key = `${r.symbol}|${r.targetTime}`;
    const ex  = windowMap.get(key);
    if (!ex || r.source === "stat") windowMap.set(key, r);
  }

  type Acc = {
    erSum: number; erCount: number; trendingCount: number;
    hits: number; evaluated: number; total: number;
  };
  const mkAcc = (): Acc => ({
    erSum: 0, erCount: 0, trendingCount: 0, hits: 0, evaluated: 0, total: 0,
  });
  const hourAcc:    Acc[]   = Array.from({ length: 24 }, mkAcc);
  const dayAcc:     Acc[]   = Array.from({ length: 7  }, mkAcc);
  const dayHourAcc: Acc[][] = Array.from({ length: 7  }, () =>
    Array.from({ length: 24 }, mkAcc),
  );

  const ET_FMT = new Intl.DateTimeFormat("en-US", {
    timeZone:  "America/New_York",
    hour:      "numeric",
    hour12:    false,
    weekday:   "short",
  });

  for (const rec of windowMap.values()) {
    const date  = new Date(rec.snappedAt);
    const parts = ET_FMT.formatToParts(date);
    const rawH  = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0");
    const hour  = rawH === 24 ? 0 : rawH; // some Intl engines emit 24 for midnight
    const dow   = parts.find((p) => p.type === "weekday")?.value ?? "";
    const dayIdx = DOW_LABELS.indexOf(dow);
    if (hour < 0 || hour > 23 || dayIdx === -1) continue;

    const hA  = hourAcc[hour];
    const dA  = dayAcc[dayIdx];
    const dhA = dayHourAcc[dayIdx][hour];

    hA.total++; dA.total++; dhA.total++;

    if (rec.efficiencyRatio !== null) {
      hA.erSum  += rec.efficiencyRatio; hA.erCount++;
      dA.erSum  += rec.efficiencyRatio; dA.erCount++;
      dhA.erSum += rec.efficiencyRatio; dhA.erCount++;
      if (rec.efficiencyRatio >= 0.55) {
        hA.trendingCount++; dA.trendingCount++; dhA.trendingCount++;
      }
    }

    if (rec.status === "evaluated" && rec.correct !== null && rec.abstained !== true) {
      hA.evaluated++; dA.evaluated++; dhA.evaluated++;
      if (rec.correct) { hA.hits++; dA.hits++; dhA.hits++; }
    }
  }

  const toBucket = (acc: Acc): TradingWindowBucket => {
    const avgER = acc.erCount > 0
      ? Math.round((acc.erSum / acc.erCount) * 1000) / 1000
      : null;
    return {
      count:              acc.total,
      evaluatedCount:     acc.evaluated,
      // Use minBucket as the evaluated floor too — consistency between modes.
      accuracyPct:        acc.evaluated >= minBucket
        ? Math.round((acc.hits / acc.evaluated) * 100) : null,
      avgEfficiencyRatio: avgER,
      trendingPct:        acc.erCount > 0
        ? Math.round((acc.trendingCount / acc.erCount) * 100) : null,
      sparse: acc.total < minBucket,
    };
  };

  const hourly     = hourAcc.map((acc, h) => ({ ...toBucket(acc), hour: h, label: fmtHourLabel(h) }));
  const daily      = dayAcc.map((acc, i)  => ({ ...toBucket(acc), dayIndex: i, label: DOW_LABELS[i] }));
  const byDayHour  = dayHourAcc.map((dayHours) =>
    dayHours.map((acc, h) => ({ ...toBucket(acc), hour: h, label: fmtHourLabel(h) })),
  );

  const totalSamples = windowMap.size;

  // Score each non-sparse hour: blend of ER (predictability) and accuracy.
  const scored = hourly
    .filter((h) => !h.sparse && h.avgEfficiencyRatio !== null)
    .map((h) => ({
      hour:  h.hour,
      label: h.label,
      er:    h.avgEfficiencyRatio ?? 0,
      score: ((h.accuracyPct ?? 50) / 100) * 0.4 + (h.avgEfficiencyRatio ?? 0) * 0.6,
    }))
    .sort((a, b) => b.score - a.score);

  let recommendation: string;
  let recommendedWindows: RecommendedWindow[] = [];
  if (totalSamples < minTotal) {
    recommendation =
      `Collecting data — needs at least ${minTotal} windows to identify patterns. ` +
      `${totalSamples} recorded so far.`;
  } else if (scored.length === 0) {
    recommendation = "No hour bucket has enough samples yet.";
  } else {
    const top   = scored.slice(0, Math.min(3, scored.length));
    const worst = scored.slice(-Math.min(3, scored.length)).reverse();
    const avgTopER = Math.round((top.reduce((s, h) => s + h.er, 0) / top.length) * 100) / 100;
    const topStr   = top.map((h) => h.label).join(", ");
    const worstStr = worst.map((h) => h.label).join(", ");
    recommendation =
      `Best windows: ${topStr} ET (avg efficiency ${avgTopER.toFixed(2)}). ` +
      `Tend to avoid: ${worstStr} ET — markets are choppier during those hours.`;
    recommendedWindows = [
      ...top.map((h) => ({
        hour: h.hour,
        label: h.label,
        score: Math.round(h.score * 1000) / 1000,
        avgEfficiencyRatio: Math.round(h.er * 1000) / 1000,
        accuracyPct: hourly[h.hour].accuracyPct,
        rank: "best" as const,
      })),
      ...worst.map((h) => ({
        hour: h.hour,
        label: h.label,
        score: Math.round(h.score * 1000) / 1000,
        avgEfficiencyRatio: Math.round(h.er * 1000) / 1000,
        accuracyPct: hourly[h.hour].accuracyPct,
        rank: "worst" as const,
      })),
    ];
  }

  return {
    hourly,
    daily,
    byDayHour,
    recommendedWindows,
    totalSamples,
    lastUpdatedAt: new Date().toISOString(),
    recommendation,
    hasEnoughData: totalSamples >= (symbols.length === 1 ? 10 : TW_MIN_TOTAL),
  };
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
// Adaptive stat + Claude ensemble
//
// Fuses the statistical model and Claude into a single call whose blend weights
// adapt to each model's RECENT, REGIME-AWARE accuracy (from the analytics layer
// above). When the two models disagree on direction, or the blended confidence
// is too low to be worth a bet, the ensemble abstains ("no bet") rather than
// forcing a coin-flip call.
// ---------------------------------------------------------------------------

// Min evaluated records a (source, regime) bucket needs before its accuracy is
// trusted for weighting. Below this we fall back to the source's all-regime
// accuracy, then to equal weights.
const ENSEMBLE_MIN_SAMPLES = 8;
// Each model's weight is clamped to [floor, 1-floor] so a hot streak never lets
// one model fully silence the other — both always retain a voice.
const ENSEMBLE_WEIGHT_FLOOR = 0.2;
// Blended confidence below this → abstain (combined edge too thin to bet).
export const ENSEMBLE_ABSTAIN_MIN_CONF = 55;

export interface EnsembleWeights {
  stat: number;
  claude: number;
}

// One model's call as seen by the ensemble (direction is the DISPLAYED call —
// derived from predicted price vs the reference price by the caller).
interface ModelCall {
  predictedPrice: number;
  direction: "up" | "down" | "flat";
  confidence: number;
}

export interface EnsembleCall {
  predictedPrice: number;
  direction: "up" | "down" | "flat";
  confidence: number;
  abstained: boolean;
  reason: string;
  weights: EnsembleWeights;
}

// Analytics without the derived blend weights — the shape available WHILE the
// weights are still being computed (lets the weight helpers run on the partial
// object built inside getPredictionAnalytics without a chicken-and-egg cycle).
type CoinAnalyticsBase = Omit<CoinAnalytics, "ensembleWeights">;

// Pull a source's trusted accuracy for a regime: prefer the regime bucket once
// it has enough samples, else the source's all-regime accuracy, else null.
function trustedAccuracy(
  a: CoinAnalyticsBase,
  src: "stat" | "claude",
  regime: PromptRegime,
): number | null {
  const reg = a.byRegime[src][regime];
  if (reg.n >= ENSEMBLE_MIN_SAMPLES && reg.accuracyPct != null) return reg.accuracyPct;
  const all = a.bySource[src];
  if (all.n >= ENSEMBLE_MIN_SAMPLES && all.accuracyPct != null) return all.accuracyPct;
  return null;
}

// Turn a pair of trusted accuracies into blend weights. Weight is proportional
// to each model's edge over a coin-flip (accuracy − 50), clamped to the floor.
// When either accuracy is unknown, fall back to equal weighting so the ensemble
// degrades to a simple average rather than over-trusting a thin sample.
function weightsFromAccuracy(
  statAcc: number | null,
  claudeAcc: number | null,
): EnsembleWeights {
  if (statAcc == null || claudeAcc == null) return { stat: 0.5, claude: 0.5 };
  const edgeStat = Math.max(0, statAcc - 50);
  const edgeClaude = Math.max(0, claudeAcc - 50);
  if (edgeStat + edgeClaude === 0) return { stat: 0.5, claude: 0.5 };
  const wStat = clamp(
    edgeStat / (edgeStat + edgeClaude),
    ENSEMBLE_WEIGHT_FLOOR,
    1 - ENSEMBLE_WEIGHT_FLOOR,
  );
  return { stat: round3(wStat), claude: round3(1 - wStat) };
}

// Regime-aware weights from a PRECOMPUTED analytics object (no recursion). Uses
// trustedAccuracy, which prefers the regime bucket and falls back to all-regime.
function ensembleWeightsFor(a: CoinAnalyticsBase, regime: PromptRegime): EnsembleWeights {
  return weightsFromAccuracy(
    trustedAccuracy(a, "stat", regime),
    trustedAccuracy(a, "claude", regime),
  );
}

// All-regime baseline weights from a precomputed analytics object: uses each
// source's overall accuracy once it clears the min-sample gate, else equal.
function overallWeightsFor(a: CoinAnalyticsBase): EnsembleWeights {
  const statAcc =
    a.bySource.stat.n >= ENSEMBLE_MIN_SAMPLES ? a.bySource.stat.accuracyPct : null;
  const claudeAcc =
    a.bySource.claude.n >= ENSEMBLE_MIN_SAMPLES ? a.bySource.claude.accuracyPct : null;
  return weightsFromAccuracy(statAcc, claudeAcc);
}

// Regime-aware blend weights for a symbol — the weights computeEnsemble applies.
export function ensembleWeights(symbol: string, regime: PromptRegime): EnsembleWeights {
  return ensembleWeightsFor(getPredictionAnalytics(symbol), regime);
}

// Per-coin data-driven Claude down-call weight scale.
// Claude "down" accuracy varies enormously by coin — BNB (70.3% down, 42.9% up)
// is the OPPOSITE of BTC/ETH/HYPE (36-50% down, 61-80% up). Applying a fixed
// 30% penalty globally actively hurts BNB. This function computes the scale from
// the coin's own evaluated history: ratio of down accuracy to up accuracy,
// clamped to [0.5, 1.0]. BNB → 1.0 (no penalty); ETH → ~0.58; BTC → ~0.72.
// Falls back to 0.85 (mild universal default) when direction samples are thin.
const CLAUDE_DOWN_SCALE_MIN_DIR_SAMPLES = 5;
function computeClaudeDownScale(symbol: string): number {
  // historyStore is module-level — defined below snap logic but callable here
  // since this function is only invoked at runtime (never at parse time).
  const records = (historyStore as Map<string, PredictionRecord[]>).get(symbol.toUpperCase()) ?? [];
  const claudeEval = records.filter(
    (r) => r.source === "claude" && r.status === "evaluated"
      && r.correct !== null && r.kalshiTarget != null,
  );
  const downRecs = claudeEval.filter((r) => r.predictedDirection === "down");
  const upRecs   = claudeEval.filter((r) => r.predictedDirection === "up");
  if (
    downRecs.length < CLAUDE_DOWN_SCALE_MIN_DIR_SAMPLES ||
    upRecs.length   < CLAUDE_DOWN_SCALE_MIN_DIR_SAMPLES
  ) {
    return 0.85; // insufficient direction samples → mild universal default
  }
  const downAcc = downRecs.filter((r) => r.correct === true).length / downRecs.length;
  const upAcc   = upRecs.filter((r) => r.correct === true).length / upRecs.length;
  if (upAcc <= 0) return 1.0; // edge: no up hits → don't penalise down
  return clamp(downAcc / upAcc, 0.5, 1.0);
}

// Blend a stat call and a Claude call into one ensemble call, deciding whether
// to bet or abstain. `referencePrice` is the live price the displayed directions
// were derived from, so the blended direction stays consistent with the columns.
export function computeEnsemble(
  symbol: string,
  regime: PromptRegime,
  stat: ModelCall,
  claude: ModelCall,
  referencePrice: number,
): EnsembleCall {
  const weights = ensembleWeights(symbol, regime);
  // Per-coin asymmetric down-weighting, derived from each coin's own evaluated
  // history. BNB claude-down (70%) > claude-up (43%) → scale=1.0 (no penalty).
  // ETH claude-down (39%) << claude-up (67%) → scale≈0.58 (stronger penalty).
  // XRP (57% vs 60%) → scale≈0.94 (near-equal, almost no penalty).
  // Falls back to 0.85 when direction samples are insufficient.
  const claudeDownScale = claude.direction === "down" ? computeClaudeDownScale(symbol) : 1.0;
  const effectiveClaudeW = weights.claude * claudeDownScale;
  const effectiveStatW = weights.stat + (weights.claude - effectiveClaudeW);
  const predictedPrice = effectiveStatW * stat.predictedPrice + effectiveClaudeW * claude.predictedPrice;
  const confidence = Math.round(effectiveStatW * stat.confidence + effectiveClaudeW * claude.confidence);
  const changePct = referencePrice > 0 ? ((predictedPrice - referencePrice) / referencePrice) * 100 : 0;
  const direction: "up" | "down" | "flat" =
    changePct > 0.05 ? "up" : changePct < -0.05 ? "down" : "flat";

  // Abstain when the models point opposite ways (one up, one down) or when the
  // blended confidence is too low to justify a bet.
  const conflict =
    (stat.direction === "up" && claude.direction === "down") ||
    (stat.direction === "down" && claude.direction === "up");
  const lowConf = confidence < ENSEMBLE_ABSTAIN_MIN_CONF;
  const abstained = conflict || lowConf;
  const reason = conflict
    ? "Models disagree on direction"
    : lowConf
      ? `Combined confidence ${confidence}% below ${ENSEMBLE_ABSTAIN_MIN_CONF}% threshold`
      : "Models agree — regime-weighted blend";

  return { predictedPrice, direction, confidence, abstained, reason, weights };
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
  // Cap trendFactor at 0.5 (middle-regime level). Empirically, 15-min windows
  // with ER > 0.55 (clean trend) almost always REVERT in the following window —
  // the trend is already exhausted by the time ER reads high. Letting trendFactor
  // reach 1.0 sets wMom=0.55, wMR=0: pure momentum continuation with zero
  // mean-reversion — and that exact combination produced 14–25 % accuracy in
  // trending windows (worse than random). Capping at 0.5 keeps the blend similar
  // to the middle regime (wMom≈0.35, wMR≈0.35) which scores 52–73 % accuracy.
  let trendFactor = clamp((ER - 0.25) / (0.55 - 0.25), 0, 0.5);
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
    const rawPredicted  = price * Math.exp(drift * minutesAhead);
    // Near-close live-price blend: when < 2 minutes remain in the current window,
    // the live price is by far the best predictor of the closing price — drift-based
    // extrapolation can't realistically reverse a meaningful gap in 60–90 seconds.
    // We linearly blend the model's prediction toward the live price:
    //   2 min remaining → 0 % blend (pure model)
    //   0 min remaining → 100 % blend (pure live price)
    const secsRemaining = Math.max(0, target.getTime() - now.getTime()) / 1_000;
    const nearCloseFrac  = Math.max(0, 1 - secsRemaining / 120); // 0 at ≥2 min, 1 at close
    const predictedPrice = rawPredicted * (1 - nearCloseFrac) + price * nearCloseFrac;
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
    // Stat "down" calls are empirically 9.1% accurate (n=11 resolved) —
    // reliably wrong, not just noisy. Unless a spike is driving the downside
    // call (spikes tend to continue their impulse), suppress explicit "down"
    // to "flat" so it stops poisoning the accuracy log.
    if (direction === "down" && !iwm.spikeFlag) direction = "flat";
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
    // Large |z| occurs in trending regimes (large drift/vol ratio) where
    // empirical accuracy DROPS rather than rises — confidence is inverted.
    // Penalise high-z predictions so the stated confidence stays close to
    // the achievable hit rate. Penalty kicks in above |z|=0.5, caps at 30 %.
    const zPenalty = clamp(1 - Math.max(0, Math.abs(z) - 0.5) * 0.18, 0.70, 1.0);
    // Backtesting shows the raw drift/vol z-score has only a few points of real
    // directional skill at this horizon, so the probability edge is shrunk and
    // capped — keeping stated confidence close to the achievable hit rate.
    const conf = clamp(50 + (pSide * 100 - 50) * quality * 0.5 * zPenalty, 50, 65);
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
Kalshi strike: $${kt.toFixed(dp)}  ← this is ${coin.symbol}'s closing price at the START of this window (previous window's close). The question is whether price ends the window ABOVE or BELOW where it opened.
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

    const raw = (response as { content: Array<{ type: string; text?: string }> }).content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
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
  // Regime-aware blend weights + abstention threshold so the client can compute
  // the combined call from the exact stat/Claude values it displays (keeping the
  // headline consistent with the two model columns).
  ensembleWeights: EnsembleWeights;
  ensembleRegime: PromptRegime;
  abstainMinConf: number;
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

  const ensembleRegime = regimeFromER(coin.indicators.efficiencyRatio);
  return {
    coin: symbol,
    predictions: aiPreds,
    ensembleWeights: ensembleWeights(symbol.toUpperCase(), ensembleRegime),
    ensembleRegime,
    abstainMinConf: ENSEMBLE_ABSTAIN_MIN_CONF,
    generatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Prediction History Tracker
// Snaps predictions at each 15-min boundary, evaluates accuracy once the
// window closes. Keeps up to 8 entries per coin (= 2 hours of history).
// ---------------------------------------------------------------------------

export interface PredictionRecord {
  id: string;                     // `${symbol}-${targetTime}-${source}` (unique per window per source)
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
  source: "stat" | "claude" | "ensemble" | "ml"; // which model produced this prediction
  // Ensemble-only: true when the blended call abstained (no bet). null for
  // stat/claude. Even when abstained the record is still evaluated, so we can
  // measure abstention quality (a "good" abstention = would-be call was wrong).
  abstained: boolean | null;
  efficiencyRatio: number | null; // ER at snapshot — used to bucket by regime
  rawConfidence: number | null;   // Claude's pre-calibration confidence (claude only)
  archivedAt: string | null;      // set by soft-clear; hidden from display but counted in analytics
  // Claude/ensemble only. Direct binary ABOVE/BELOW from fetchLiveDirection
  // recorded at the "initial (stat snap ready)" trigger (~45-75s into window).
  // Authoritative AT OPEN call for accuracy — avoids the price-to-binary
  // rounding error near the boundary. null until liveDirection resolves.
  liveDirectionAbove: boolean | null;
}

// Stable per-source record id. Legacy records (pre-multi-source) used a 2-part
// `${symbol}-${targetTime}` id; new records append the source so stat/claude/
// ensemble calls for the same window each persist independently.
function recordId(symbol: string, targetTime: string, source: PredictionRecord["source"]): string {
  return `${symbol}-${targetTime}-${source}`;
}

const QUARTER_MS = 15 * 60 * 1000;
// Up to 3 records per window (stat + claude + ensemble) when Claude is enabled,
// so keep ~30 windows × 3 = 90 records per coin.
const MAX_HISTORY = 90;

// How many days of prediction records to retain in the DB.  Records with
// snapped_at older than this are deleted once per day — non-fatal if it fails.
const RETENTION_DAYS = 60;

// These coins ALWAYS run Claude in the background tracker regardless of UI mode
// or auto-pilot state.  The data collected here is what trains the self-learning
// loop — without it the auto-pilot and ensemble have nothing to learn from.
// Kept to 5 to bound API cost while building a meaningful dataset quickly.
export const TRAINING_COINS = new Set(["BTC", "ETH", "XRP", "HYPE", "BNB"]);
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
const kalshiTargetCache = new Map<string, { value: number | null; ticker?: string; at: number; closeTime?: string; yesPrice?: number | null }>();
const KALSHI_TARGET_LIB_TTL = 12_000;

// Tracks when each symbol's new-window Kalshi target was first confirmed.
// Set the moment a NEW ticker is seen in fetchKalshiTarget (i.e. Kalshi published).
// Consumed by:
//   • snap gate  — fires opening Claude+ML immediately instead of after fixed 45s delay
//   • kalshi-bot — replaces time-based warmup with target-detection gate
const confirmedTargetStore = new Map<string, { ticker: string; confirmedAt: number; target: number }>();

export function getConfirmedTargetMs(symbol: string): number | null {
  return confirmedTargetStore.get(symbol.toUpperCase())?.confirmedAt ?? null;
}

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

// Cache of the most recently computed ML above/below prediction per symbol.
// Updated whenever the per-coin processing loop computes an ML prediction.
// Consumed by the exit guard to incorporate ML direction as an exit signal.
const lastMLAboveCache = new Map<string, boolean | null>();

export function getLastMLAbove(symbol: string): boolean | null {
  return lastMLAboveCache.get(symbol.toUpperCase()) ?? null;
}

export function getKalshiWindowContext(symbol: string): {
  priceAtOpen: number | null;
  minutesElapsed: number;
  secondsElapsed: number;
} | null {
  const ticker = getLastKalshiTicker(symbol);
  if (!ticker) return null;
  const entry = kalshiWindowStore.get(ticker);
  if (!entry) return null;
  const msElapsed = Math.max(0, Date.now() - entry.openedAt);
  return {
    priceAtOpen: entry.priceAtOpen,
    minutesElapsed: Math.floor(msElapsed / 60_000),
    secondsElapsed: Math.floor(msElapsed / 1_000),
  };
}

// Returns the current in-memory Kalshi target cache entry for a symbol.
// Used by the bot loop to read ticker, yes price, and target without re-fetching.
export function getKalshiCachedData(symbol: string): {
  value: number | null;
  ticker?: string;
  yesPrice?: number | null;
  closeTime?: string;
} | null {
  return kalshiTargetCache.get(symbol.toUpperCase()) ?? null;
}

export async function fetchKalshiTarget(symbol: string, targetTime?: Date): Promise<number | null> {
  const sym = symbol.toUpperCase();
  const series = KALSHI_SERIES[sym];
  if (!series) return null;

  // Display calls (no targetTime) use the short-lived shared cache so every
  // render doesn't hammer the Kalshi API.
  //
  // Snapshot calls (targetTime provided) MUST bypass the shared cache because
  // it may still hold the PREVIOUS window's strike for up to 12 s after the
  // boundary — silently recording the wrong target in a new prediction record.
  if (!targetTime) {
    const hit = kalshiTargetCache.get(sym);
    // Near a window boundary (first 90s or last 90s of a 15-min window) reduce
    // the TTL to 5s so new Kalshi markets are detected within one poll cycle
    // rather than waiting the full 12s. This is the primary lever for reducing
    // entry latency — the new ticker usually appears 10-30s after boundary.
    const secIntoWindow = Math.floor(Date.now() / 1_000) % (15 * 60);
    const isNearBoundary = secIntoWindow < 90 || secIntoWindow > (15 * 60 - 90);
    const effectiveTTL = isNearBoundary ? 5_000 : KALSHI_TARGET_LIB_TTL;
    if (hit && Date.now() - hit.at < effectiveTTL) {
      // Guard: if the cached market's close_time has already passed, the entry
      // holds the previous window's target — even if it was written just now
      // (Kalshi's API can take 20-30s to transition the market to "closed").
      // This mirrors the route-level cache fix and prevents all model calls from
      // comparing against the expired window's strike price.
      const ct = hit.closeTime;
      if (!ct || new Date(ct).getTime() > Date.now()) return hit.value;
      // closeTime passed — fall through to re-fetch the new window's target.
    }
  }

  try {
    const resp = await fetch(
      `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=open&limit=10`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) {
      if (!targetTime) kalshiTargetCache.set(sym, { value: null, at: Date.now() });
      return null;
    }
    const body = (await resp.json()) as {
      markets?: { floor_strike?: number; ticker?: string; close_time?: string; yes_ask?: number; yes_bid?: number; last_price?: number }[];
    };

    const markets = (body.markets ?? []).filter(
      (m) => typeof m.floor_strike === "number" && (m.floor_strike as number) > 0,
    );

    let selected: (typeof markets)[0] | undefined;

    if (targetTime) {
      // Prefer strict close_time matching: only accept a market expiring
      // within 8 min of the requested window boundary.  This prevents picking
      // the next window's market when Kalshi opens it before the current one
      // closes (which would store the wrong strike in the prediction record).
      const targetMs = targetTime.getTime();
      const marketsWithCloseTime = markets.filter((m) => m.close_time);
      if (marketsWithCloseTime.length > 0) {
        let bestDiff = Infinity;
        for (const m of marketsWithCloseTime) {
          const diff = Math.abs(new Date(m.close_time!).getTime() - targetMs);
          if (diff < 8 * 60_000 && diff < bestDiff) { bestDiff = diff; selected = m; }
        }
        if (!selected) {
          // Close_time data is available but no market fits this window yet.
          // Return null so the tracker retries on the next 30-second tick.
          console.info(`[kalshi] ${sym}: no market within 8 min of ${targetTime.toISOString()} — will retry`);
          return null;
        }
      } else {
        // API doesn't include close_time — fall back to first market and log
        // a warning so we know the strict guard couldn't run.
        selected = markets[0];
        if (selected) {
          console.warn(`[kalshi] ${sym}: close_time absent from API response — using first market (strike ${selected.floor_strike}). Consider checking the API format.`);
        }
      }
    } else {
      selected = markets[0];
    }

    if (selected) {
      // yes_ask / yes_bid / last_price are integers in cents (1–99); 0 means no quote.
      // Prefer the bid/ask midpoint for the most accurate yes probability estimate.
      // Fall back: ask only → bid only → last traded price → null (no price available).
      const toFrac = (v: number | undefined | null) =>
        typeof v === "number" && v > 0 ? v / 100 : null;
      const yesAsk   = toFrac(selected.yes_ask);
      const yesBid   = toFrac(selected.yes_bid);
      const lastP    = toFrac(selected.last_price);
      const yesPrice =
        yesAsk !== null && yesBid !== null ? (yesAsk + yesBid) / 2
        : yesAsk ?? yesBid ?? lastP ?? null;
      kalshiTargetCache.set(sym, {
        value: selected.floor_strike!,
        ticker: selected.ticker,
        at: Date.now(),
        closeTime: (selected as Record<string, unknown>).close_time as string | undefined,
        yesPrice,
      });
      // Register the window ticker immediately so minutesElapsed is accurate from first sight.
      // priceAtOpen is filled in lazily by updateKalshiWindowPrice (first caller with coin price).
      if (selected.ticker && !kalshiWindowStore.has(selected.ticker)) {
        kalshiWindowStore.set(selected.ticker, { priceAtOpen: null, openedAt: Date.now() });
      }
      // Target-detection gate: record the first moment we see this window's ticker.
      // This timestamp drives the snap gate and bot warmup — replacing the old fixed
      // 45s delay with "fire as soon as target is confirmed + a small stability buffer."
      if (selected.ticker) {
        const prevConf = confirmedTargetStore.get(sym);
        if (!prevConf || prevConf.ticker !== selected.ticker) {
          confirmedTargetStore.set(sym, {
            ticker: selected.ticker,
            confirmedAt: Date.now(),
            target: selected.floor_strike!,
          });
        }
      }
      return selected.floor_strike!;
    }

    if (!targetTime) kalshiTargetCache.set(sym, { value: null, at: Date.now() });
    return null;
  } catch {
    return null;
  }
}
const historyStore = new Map<string, PredictionRecord[]>(); // symbol → records
// Prevents concurrent ticks from double-snapping the same window. setInterval
// fires every 30s without awaiting the previous tick, so if a Claude call takes
// >30s two ticks overlap and both see alreadySnapped=false before either pushes
// records. The DB deduplicates via onConflictDoNothing but the in-memory array
// gets both copies. This Set is the synchronous guard that closes the gap.
const snapInFlight = new Set<string>(); // `${sym}:${targetISO}`

export function getPredictionHistory(symbol: string): PredictionRecord[] {
  return (historyStore.get(symbol.toUpperCase()) ?? []).slice().reverse(); // newest first
}

// One headline record per window for the accuracy log: prefer the ensemble call,
// else Claude, else the stat baseline. Keeps the log to one row per window even
// though up to three source records are stored per window.
const HEADLINE_RANK: Record<PredictionRecord["source"], number> = {
  ensemble: 3,
  claude: 2,
  stat: 1,
  ml: 0,
};
export function getPredictionHeadlines(symbol: string): PredictionRecord[] {
  const all = historyStore.get(symbol.toUpperCase()) ?? [];
  const byWindow = new Map<string, PredictionRecord>();
  for (const r of all) {
    // Archived records (soft-cleared) are hidden from the display log.
    // They remain in the in-memory store and DB so analytics are unaffected.
    if (r.archivedAt) continue;
    const cur = byWindow.get(r.targetTime);
    if (!cur || HEADLINE_RANK[r.source] > HEADLINE_RANK[cur.source]) byWindow.set(r.targetTime, r);
  }
  return [...byWindow.values()].sort(
    (a, b) => new Date(b.targetTime).getTime() - new Date(a.targetTime).getTime(),
  );
}

// Soft clear — archives records older than 48 hours by setting archivedAt.
// No rows are deleted: archived records still power Best Windows, auto-pilot
// accuracy, and the self-learning dashboard (analytics are unaffected).
// Only the display log filters them out (getPredictionHeadlines skips archived).
export async function clearPredictionHistoryOld(): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await db
    .update(predictionRecordsTable)
    .set({ archivedAt: new Date() })
    .where(lt(predictionRecordsTable.snappedAt, cutoff));
  // Reload the in-memory store so the display reflects the change immediately.
  historyStore.clear();
  await initHistoryFromDB();
}

// Accuracy-only clear — wipes all prediction records from the display log and
// DB so accuracy stats restart from zero, but leaves ML snapshots and model
// weights completely untouched.  Use this to reset accuracy after tweaks
// without throwing away hard-won training data.
export async function clearAccuracyLogsOnly(): Promise<void> {
  historyStore.clear();
  await db.delete(predictionRecordsTable);
  // Re-init so in-memory state is consistent with the (now empty) DB.
  await initHistoryFromDB();
}

// Full reset — wipes ALL prediction records, ML snapshots, and ML model
// weights, then re-initialises the ML engine from the now-empty DB so the
// in-memory state matches (training restarts from zero).
export async function clearPredictionHistory(): Promise<void> {
  historyStore.clear();
  await db.delete(predictionRecordsTable);
  await db.delete(mlWindowSnapshotsTable);
  await db.delete(mlModelStateTable);
  await initMLFromDB();
}

// ---------------------------------------------------------------------------
// DB persistence helpers — fire-and-forget, never block the tracker
// ---------------------------------------------------------------------------

function rowToRecord(row: typeof predictionRecordsTable.$inferSelect): PredictionRecord {
  const source = (row.source as PredictionRecord["source"]) ?? "stat";
  return {
    id: row.id,
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
    source,
    abstained: row.abstained ?? null,
    efficiencyRatio: row.efficiencyRatio != null ? parseFloat(row.efficiencyRatio) : null,
    rawConfidence: row.rawConfidence ?? null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    liveDirectionAbove: row.liveDirectionAbove ?? null,
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

async function pruneOldPredictionRecords(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await db
      .delete(predictionRecordsTable)
      .where(lt(predictionRecordsTable.snappedAt, cutoff));
    const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (count > 0) {
      console.info(
        `[pruneOldRecords] deleted ${count} records older than ${RETENTION_DAYS} days (before ${cutoff.toISOString()})`,
      );
    }
  } catch (err) {
    console.error("[pruneOldRecords] failed (non-fatal):", err);
  }
}

function dbInsertRecord(rec: PredictionRecord): void {
  db.insert(predictionRecordsTable)
    .values({
      id: rec.id,
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
      abstained: rec.abstained,
      efficiencyRatio: rec.efficiencyRatio != null ? String(rec.efficiencyRatio) : null,
      rawConfidence: rec.rawConfidence,
      liveDirectionAbove: null,
    })
    .onConflictDoNothing()
    .catch((err) => console.error("[dbInsertRecord] failed:", err));
}

function dbUpdateRecord(rec: PredictionRecord): void {
  db.update(predictionRecordsTable)
    .set({
      actualPrice: rec.actualPrice != null ? String(rec.actualPrice) : null,
      errorPct: rec.errorPct != null ? String(rec.errorPct) : null,
      correct: rec.correct,
      evaluatedAt: rec.evaluatedAt ? new Date(rec.evaluatedAt) : null,
      status: rec.status,
    })
    .where(eq(predictionRecordsTable.id, rec.id))
    .catch((err) => console.error("[dbUpdateRecord] failed:", err));
}

// Write the liveDirection binary call back to the claude/ensemble DB records
// for this window so accuracy evaluation uses the direct ABOVE/BELOW answer
// rather than the price-prediction-to-binary mapping near the boundary.
function dbUpdateLiveDirection(symbol: string, targetTime: string, aboveKalshi: boolean): void {
  const sources: PredictionRecord["source"][] = ["claude", "ensemble"];
  for (const source of sources) {
    const id = recordId(symbol, targetTime, source);
    db.update(predictionRecordsTable)
      .set({ liveDirectionAbove: aboveKalshi })
      .where(eq(predictionRecordsTable.id, id))
      .catch((err) => console.error(`[dbUpdateLiveDirection] ${symbol} ${source} failed:`, err));
    // Also update the in-memory record so the accuracy eval path uses the new
    // value immediately without waiting for a DB round-trip.
    const recs = historyStore.get(symbol.toUpperCase()) ?? [];
    const rec = recs.find((r) => r.id === id);
    if (rec) rec.liveDirectionAbove = aboveKalshi;
  }
  console.info(`[live-dir] ${symbol}: liveDirectionAbove=${aboveKalshi} written to DB (claude + ensemble)`);
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
    // Format a single evaluated record for the feedback prompt.
    // When a kalshiTarget is present the binary ABOVE/BELOW call is the
    // primary accuracy signal — show it explicitly so Claude's self-correction
    // is grounded in the same metric used to score it, not a raw price error.
    const formatEval = (r: PredictionRecord): string => {
      const rdp = priceDp(r.priceAtSnapshot ?? r.predictedPrice);
      const kt = r.kalshiTarget;
      if (kt != null) {
        const predSide = r.predictedPrice >= kt ? "ABOVE" : "BELOW";
        const actSide =
          r.actualPrice != null
            ? r.actualPrice >= kt
              ? "ABOVE"
              : "BELOW"
            : "?";
        return (
          `  ${r.targetLabel}: predicted ${predSide} $${kt.toFixed(rdp)} strike` +
          ` → $${r.predictedPrice?.toFixed(rdp)} | actual ${actSide} at $${r.actualPrice?.toFixed(rdp)}` +
          ` | ${r.correct ? "HIT ✓" : "MISS ✗"}`
        );
      }
      return (
        `  ${r.targetLabel}: predicted $${r.predictedPrice?.toFixed(rdp)}` +
        ` → actual $${r.actualPrice?.toFixed(rdp)}` +
        ` | error ${r.errorPct?.toFixed(2)}%` +
        ` | ${r.correct ? "HIT ✓" : "MISS ✗"}`
      );
    };

    const feedbackStr =
      recentEvals.length > 0
        ? recentEvals.map(formatEval).join("\n")
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
            .map((r) => {
              const rdp = priceDp(r.priceAtSnapshot ?? r.predictedPrice);
              const kt = r.kalshiTarget;
              if (kt != null) {
                const predSide = r.predictedPrice >= kt ? "ABOVE" : "BELOW";
                const actSide =
                  r.actualPrice != null
                    ? r.actualPrice >= kt
                      ? "ABOVE"
                      : "BELOW"
                    : "?";
                return (
                  `  ${r.targetLabel}: predicted ${predSide} $${kt.toFixed(rdp)} (conf ${r.confidence}%)` +
                  ` but actual ${actSide} | error ${r.errorPct?.toFixed(2)}% ✗`
                );
              }
              return (
                `  ${r.targetLabel}: called ${r.predictedDirection} → $${r.predictedPrice?.toFixed(rdp)}` +
                ` (conf ${r.confidence}%) but actual $${r.actualPrice?.toFixed(rdp)}` +
                ` | off by ${r.errorPct?.toFixed(2)}% ✗`
              );
            })
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
Kalshi strike: $${kt.toFixed(dp)}  ← this is ${coin.symbol}'s closing price at the START of this window (previous window's close). The question is whether price ends the window ABOVE or BELOW where it opened.
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

    const raw = (response as { content: Array<{ type: string; text?: string }> }).content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
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

// ── Auto-pilot ───────────────────────────────────────────────────────────────
// When enabled, the system decides per-coin whether Claude is earning its keep —
// turning it on where Claude beats the statistical model and off where it stops —
// so AI budget is spent only where it pays off. Runs once per tracker tick.
//
// The subtle decision rules (min-sample gating, exploration, hysteresis, global
// cap) live in the pure, unit-tested ./autopilot module. This wrapper only feeds
// it the latest live accuracy stats and stores the resulting decisions.

let autoPilotEnabled = true; // ON by default — self-learning runs from first tick
const autoPilotDecisions = new Map<string, AutoPilotDecision>();

// Per-coin auto-pilot decision. Gathers Claude vs statistical-model accuracy from
// the analytics layer and delegates the guardrailed decision to computeAutoPilotDecisions.
export function runAutoPilot(): void {
  if (!autoPilotEnabled) {
    autoPilotDecisions.clear();
    return;
  }

  // Auto-pilot only manages training coins — non-training coins are stat-only by
  // policy (isCoinClaudeEnabled always returns false for them). Including them in
  // computeAutoPilotDecisions would produce active=true decisions that the UI shows
  // as "Claude on" even though Claude never runs, which is confusing and wrong.
  const inputs = CRYPTO_COINS
    .filter(({ symbol }) => TRAINING_COINS.has(symbol))
    .map(({ symbol }) => {
      const a = getPredictionAnalytics(symbol);
      return {
        symbol,
        claudeAcc: a.bySource.claude.accuracyPct,
        statAcc: a.bySource.stat.accuracyPct,
        claudeN: a.bySource.claude.n,
        statN: a.bySource.stat.n,
        // wasActive drives hysteresis — read before we overwrite the decisions map.
        wasActive: autoPilotDecisions.get(symbol)?.active ?? false,
      };
    });

  const decisions = computeAutoPilotDecisions(inputs);
  autoPilotDecisions.clear();
  for (const d of decisions) autoPilotDecisions.set(d.symbol, d);
}

export function getAiSettings(): {
  mode: "stat" | "claude";
  claudeCoins: string[];
  trainingCoins: string[];
  selfConsistencySamples: number;
  autoPilot: {
    enabled: boolean;
    maxActive: number;
    decisions: AutoPilotDecision[];
  };
} {
  return {
    mode: globalAiMode,
    claudeCoins: [...claudeEnabledCoins],
    trainingCoins: [...TRAINING_COINS],
    selfConsistencySamples,
    autoPilot: {
      enabled: autoPilotEnabled,
      maxActive: AUTOPILOT_MAX_ACTIVE,
      decisions: CRYPTO_COINS.map(({ symbol }) => {
        const stored = autoPilotDecisions.get(symbol);
        if (stored) return stored;
        // Non-training coins are stat-only by policy; training coins may still
        // be evaluating on first tick before computeAutoPilotDecisions runs.
        const isTraining = TRAINING_COINS.has(symbol);
        return {
          symbol,
          active: false,
          reason: isTraining
            ? autoPilotEnabled ? "Evaluating…" : "Auto-pilot off"
            : "Stat only",
          exploring: false,
          claudeAccuracyPct: null,
          statAccuracyPct: null,
          claudeN: 0,
          statN: 0,
          marginPct: null,
        };
      }),
    },
  };
}

export function setAutoPilot(enabled: boolean): boolean {
  autoPilotEnabled = enabled;
  // Recompute immediately so the UI reflects the new state without waiting a tick.
  if (enabled) runAutoPilot();
  else autoPilotDecisions.clear();
  return autoPilotEnabled;
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
  // Only training coins may have Claude toggled on — non-training coins are
  // stat-only so we never spend Claude API budget outside the self-learning loop.
  if (!TRAINING_COINS.has(symbol)) {
    claudeEnabledCoins.delete(symbol); // purge if somehow present
    return;
  }
  if (enabled) {
    claudeEnabledCoins.add(symbol);
    globalAiMode = "claude";
  } else {
    claudeEnabledCoins.delete(symbol);
    if (claudeEnabledCoins.size === 0) globalAiMode = "stat";
  }
}

// Claude runs for a training coin only when the user has manually enabled it
// OR when auto-pilot has decided it's earning its keep (or is in the exploration
// phase gathering data). Non-training coins are always stat-only.
// claudeEnabledFor() from autopilot.ts is the single source of truth so the
// tracker tick, live-direction watcher, and UI dashboard all stay consistent.
function isCoinClaudeEnabled(symbol: string): boolean {
  if (!TRAINING_COINS.has(symbol)) return false;
  return claudeEnabledFor({
    manualEnabled: claudeEnabledCoins.has(symbol),
    autoPilotEnabled,
    autoActive: autoPilotDecisions.get(symbol)?.active ?? false,
  });
}

export function startPredictionTracker(onInitComplete?: () => void): void {
  const tick = async () => {
    const nowMs = Date.now();
    const nextBoundary = new Date(Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS);

    // Refresh auto-pilot decisions from the latest accuracy before snapping, so
    // this tick's Claude on/off choices reflect the most recent performance.
    runAutoPilot();

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
                // Kalshi target known: a "hit" = model predicted the same side of
                // the target as where price actually landed (mirrors Kalshi YES/NO).
                // For Claude/ensemble: prefer liveDirectionAbove (direct binary call
                // from fetchLiveDirection, written after the stat snap) over the
                // price-prediction-to-binary mapping — avoids boundary rounding error.
                const predictedAbove =
                  (rec.source === "claude" || rec.source === "ensemble") &&
                  rec.liveDirectionAbove !== null && rec.liveDirectionAbove !== undefined
                    ? rec.liveDirectionAbove
                    : rec.predictedPrice >= rec.kalshiTarget;
                const actualAbove    = actual >= rec.kalshiTarget;
                correct = predictedAbove === actualAbove;
                // ML: label this window's snapshot with the actual ABOVE/BELOW
                // outcome and trigger an incremental retrain.  Only the stat
                // record drives labeling (one label per window, not 3×).
                if (rec.source === "stat") {
                  labelWindowAndRetrain(sym, rec.targetTime, actualAbove ? 1 : 0);
                }
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

              // Fill in the window monitor outcome for this window using the
              // stat record's ABOVE/BELOW result (since BET/STAY AWAY is a
              // signal about betting quality — its accuracy is measured by
              // whether the stat model's directional call turned out correct).
              if (rec.source === "stat" && rec.kalshiTarget != null) {
                const wStartMs = new Date(rec.targetTime).getTime() - 15 * 60_000;
                const wmKey = new Date(wStartMs).toISOString().slice(0, 16);
                const wmId = `${sym}:${wmKey}`;
                const wActualAbove = actual > rec.kalshiTarget;
                const wActualBelow = actual < rec.kalshiTarget;
                const wStatAbove = rec.predictedPrice >= rec.kalshiTarget;
                // push: actual landed exactly on the strike (within float precision)
                const wOutcome =
                  !wActualAbove && !wActualBelow
                    ? "push"
                    : wStatAbove === wActualAbove
                    ? "correct"
                    : "wrong";
                db.update(windowMonitorOutcomesTable)
                  .set({ actualAbove: wActualAbove, outcome: wOutcome, evaluatedAt: new Date() })
                  .where(eq(windowMonitorOutcomesTable.id, wmId))
                  .execute()
                  .catch(() => {});

                // Score intra-window timing snapshots for this window.
                // correct = was price_above at that minute mark the same as the
                // actual final outcome?  Uses >= (inclusive) consistent with the
                // main prediction evaluation rule.
                // direction: strict `>` per spec (exact-strike = BELOW / push)
                const timingActualAbove = actual > rec.kalshiTarget;
                db.update(windowTimingSnapshotsTable)
                  .set({
                    actualAbove: timingActualAbove,
                    correct: sql`price_above = ${timingActualAbove}`,
                    evaluatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(windowTimingSnapshotsTable.symbol, sym),
                      eq(windowTimingSnapshotsTable.windowKey, wmKey),
                      isNull(windowTimingSnapshotsTable.actualAbove),
                    ),
                  )
                  .execute()
                  .catch(() => {});
              }
            } catch {
              // retry on next tick
            }
          }
        }

        // 2. Snapshot a new prediction for the next boundary if not already done.
        const targetISO = nextBoundary.toISOString();
        const timeToNext = nextBoundary.getTime() - nowMs;
        const alreadySnapped = records.some((r) => r.targetTime === targetISO);
        const snapKey = `${sym}:${targetISO}`;

        // Timing strategy:
        //   • Wait at least 30 s into the window before the first snap attempt.
        //     Kalshi sometimes doesn't publish the new market's strike until
        //     a few seconds (or up to ~1 min) after the boundary fires.
        //   • Fetch the Kalshi target FIRST, separately from the other data.
        //     If no matching market is available yet AND we're still within the
        //     60-second grace window, skip this tick and retry on the next one.
        //   • After 60 s with no target, snap anyway (null target) so the
        //     window always has a prediction for model-accuracy tracking.
        //   • Never snap after 12 min (too far from window open).
        // SNAP_DELAY_MS removed — snap gate is now target-detection-based (see below).
        // The snap fires as soon as the new window's Kalshi target has been confirmed
        // for at least TARGET_CONFIRM_BUFFER_MS, replacing the old fixed 45s timer.
        const TARGET_CONFIRM_BUFFER_MS = 5_000;  // 5s stability buffer after target confirmed
        const SNAP_GIVE_UP_MS = 90_000;          // give up waiting for Kalshi target after 90s
        const SNAP_MAX_MS     = 12 * 60_000;     // never snap after 12 min into the window
        const windowStartMs = nextBoundary.getTime() - 15 * 60_000;
        const timeIntoWindow = nowMs - windowStartMs;

        // 2b. Intra-window timing snapshots — record price-vs-strike direction
        //     at 1, 3, 6, 9, 12-minute marks.  Only written when a confirmed
        //     Kalshi target exists (stat record already snapped for this window).
        //     Keyed per-symbol so accuracy curves reflect each coin's volatility.
        //     TOLERANCE: only write if we're within 90 s of the mark boundary
        //     (2 tick periods).  This prevents a post-restart tick from writing
        //     all elapsed marks with stale current prices.
        {
          const TIMING_MARKS_S    = [60, 180, 360, 540, 720];
          const MARK_TOLERANCE_MS = 90_000; // max ms past the mark boundary to still record
          const timingWKey = new Date(windowStartMs).toISOString().slice(0, 16);
          const statRecTiming = records.find(
            (r) => r.source === "stat" && r.targetTime === targetISO && r.kalshiTarget != null,
          );
          if (statRecTiming?.kalshiTarget != null) {
            const kt = statRecTiming.kalshiTarget;
            const ensRecTiming = records.find(
              (r) => r.source === "ensemble" && r.targetTime === targetISO,
            );
            // direction: strict `>` per spec
            const statAboveTiming = statRecTiming.predictedPrice > kt;
            const ensAboveTiming  = ensRecTiming != null ? ensRecTiming.predictedPrice > kt : null;
            for (const markS of TIMING_MARKS_S) {
              const markMs   = markS * 1000;
              const lateness = timeIntoWindow - markMs;
              if (lateness >= 0 && lateness <= MARK_TOLERANCE_MS) {
                const timingKey = `${sym}:${timingWKey}:${markS}`;
                if (!timingSnapshotWritten.has(timingKey)) {
                  timingSnapshotWritten.add(timingKey);
                  getTicker(coin.product)
                    .then(async (livePrice) => {
                      // direction: strict `>` per spec (exact-strike = BELOW)
                      const priceAbove = livePrice > kt;
                      // Refresh the Kalshi yes price. fetchKalshiTarget (no targetTime)
                      // uses the 12-second shared cache so it only hits the API when
                      // the cached entry is stale — which is the common case here
                      // because timing marks fire independently of the snap flow that
                      // normally populates the cache.
                      if (KALSHI_SERIES[sym]) {
                        await fetchKalshiTarget(sym).catch(() => null);
                      }
                      const cachedKalshi = kalshiTargetCache.get(sym);
                      const yesPrice = cachedKalshi?.yesPrice != null
                        ? String(cachedKalshi.yesPrice)
                        : null;
                      db.insert(windowTimingSnapshotsTable)
                        .values({
                          id: timingKey,
                          symbol: sym,
                          windowKey: timingWKey,
                          targetTime: nextBoundary,
                          minuteMark: markS,
                          priceAbove,
                          kalshiTarget: String(kt),
                          currentPrice: String(livePrice),
                          kalshiYesPrice: yesPrice,
                          statAbove: statAboveTiming,
                          ensembleAbove: ensAboveTiming,
                          actualAbove: null,
                          correct: null,
                          evaluatedAt: null,
                        })
                        .onConflictDoNothing()
                        .execute()
                        .catch(() => { timingSnapshotWritten.delete(timingKey); });
                    })
                    .catch(() => { timingSnapshotWritten.delete(timingKey); });
                }
              }
            }
          }
        }

        // Target-detection snap gate: fire as soon as the new Kalshi target has
        // been confirmed for TARGET_CONFIRM_BUFFER_MS — no fixed timer needed.
        // For non-Kalshi coins (KALSHI_SERIES[sym] falsy), confirmed is never set
        // so we fall back to a lightweight 15s delay from window start.
        // Fallback path: if 90s have elapsed and still no target (SNAP_GIVE_UP_MS),
        // snap without a target so the window always has an accuracy record.
        const confirmedSnap = confirmedTargetStore.get(sym);
        const msSinceConfirmed = confirmedSnap ? nowMs - confirmedSnap.confirmedAt : null;
        const kalshiSnapReady = KALSHI_SERIES[sym]
          ? msSinceConfirmed !== null && msSinceConfirmed >= TARGET_CONFIRM_BUFFER_MS
          : timeIntoWindow >= 15_000; // non-Kalshi: small fixed buffer only
        const snapFallback = KALSHI_SERIES[sym] && timeIntoWindow >= SNAP_GIVE_UP_MS;

        if (
          !alreadySnapped &&
          !snapInFlight.has(snapKey) &&
          timeToNext > 60_000 &&
          (kalshiSnapReady || snapFallback) &&
          timeIntoWindow < SNAP_MAX_MS
        ) {
          snapInFlight.add(snapKey);
          try {
            // Fetch Kalshi target before the expensive data calls so we can
            // bail early if the market isn't ready yet.
            let kalshiTargetSnap = KALSHI_SERIES[sym]
              ? await fetchKalshiTarget(sym, nextBoundary).catch(() => null)
              : null;

            // If the target is missing AND Kalshi has a series for this coin
            // AND we're still inside the grace window, skip and retry next tick.
            if (
              kalshiTargetSnap === null &&
              KALSHI_SERIES[sym] &&
              timeIntoWindow < SNAP_GIVE_UP_MS
            ) {
              // Kalshi market not published yet — will retry on the next tick.
            } else {
            const [candles, stats, tickerPrice, candles5m, orderBook] = await Promise.all([
              getCandles(coin.product),
              getStats(coin.product),
              getTicker(coin.product).catch(() => 0),
              get5mCandles(coin.product).catch(() => [] as Candle[]),
              getOrderBook(coin.product).catch(() => undefined),
            ]);
            const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
            const analysis = analyzeCoin(coin, candles, stats, new Date(nowMs), livePrice, orderBook);

            // ── ML snapshot is now captured AFTER stat+claude are computed ──────
            // (see below, just after the if(ai) block) so features 14-16
            // carry real stat/claude directions instead of the 0.5 placeholder.

            const basePred =
              analysis.predictions.find((p) => p.target === targetISO) ??
              analysis.predictions[0];
            if (basePred) {
              // For accuracy tracking, always run Claude + ensemble for training
              // coins so every window has all 4 model records to compare.
              // Auto-pilot only controls which model drives the live bet
              // recommendation (autoPilotAbove in the frontend) — it should NOT
              // stop Claude from recording, otherwise we can't measure whether
              // Claude improves while paused and accuracy tracking breaks.
              updateKalshiWindowPrice(getLastKalshiTicker(sym), analysis.price);
              const winCtxSnap = getKalshiWindowContext(sym);
              const useAI = TRAINING_COINS.has(sym);
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
              const er = analysis.indicators.efficiencyRatio;
              const regime = regimeFromER(er);
              const snappedAt = new Date(nowMs).toISOString();
              // Shared fields for every record snapped this window.
              const common = {
                symbol: sym,
                snappedAt,
                targetTime: targetISO,
                targetLabel: basePred.label,
                priceAtSnapshot: analysis.price,
                kalshiTarget,
                actualPrice: null,
                errorPct: null,
                correct: null,
                evaluatedAt: null,
                status: "pending" as const,
                efficiencyRatio: er,
              };
              const newRecs: PredictionRecord[] = [];

              // ── Proximity + time-of-day confidence adjustment (stat only) ──
              // Calibrated from per-coin DB analysis across 61+ evaluated records
              // per coin. Applied to the stat record before storage.
              //
              // Strike proximity: Kalshi sets the strike at the current market
              // price when the window opens, so snap happens 30-90s later with
              // average proximity of only 0.04-0.09% — NOT 0.2%+ as originally
              // coded. Re-calibrated thresholds from actual data:
              //   >0.1%  → 64-83% accuracy (clear edge)     → +boost
              //   0.03-0.1% → 33-73% (mixed / baseline)     → no change
              //   <0.03% → 47-57% accuracy (coin-flip zone)  → -penalty
              //
              // Time-of-day (UTC): UTC 19 (3 PM ET) is the only clean cross-coin
              // signal (75-100% across all 6 coins, n=4 each). UTC 17 is
              // unconfirmed; UTC 20-22 reduce was removed because BNB/SOL show
              // 75% accuracy there — it was helping BTC/ETH but hurting others.
              let adjustedStatConf = basePred.confidence;
              if (kalshiTarget != null) {
                const proximityPct =
                  Math.abs(analysis.price - kalshiTarget) / analysis.price * 100;
                if (proximityPct > 0.1) {
                  // Clear edge: proportional boost from 0.1%, capped at +6 pts.
                  const boost = Math.round(Math.min((proximityPct - 0.1) * 20, 6));
                  adjustedStatConf = Math.min(68, adjustedStatConf + boost);
                } else if (proximityPct < 0.03) {
                  // Coin-flip zone: reduce confidence toward fair-bet level.
                  adjustedStatConf = Math.max(50, adjustedStatConf - 4);
                }
                // 0.03-0.1% (modal range): no adjustment — mixed evidence.
              }
              const snapHourUTC = new Date(nowMs).getUTCHours();
              if (snapHourUTC === 19) {
                // UTC 19 (3 PM ET): 75-100% accuracy across all 6 coins — boost.
                adjustedStatConf = Math.min(68, adjustedStatConf + 4);
              }
              // UTC 20-22 reduce removed: too coin-specific (BNB/SOL 75% there).

              // Statistical baseline — always stored (free, no Claude needed).
              newRecs.push({
                ...common,
                id: recordId(sym, targetISO, "stat"),
                predictedPrice: basePred.predictedPrice,
                predictedDirection: basePred.direction,
                confidence: adjustedStatConf,
                source: "stat",
                abstained: null,
                rawConfidence: null,
                archivedAt: null,
                liveDirectionAbove: null,
              });

              if (ai) {
                // Map Claude's reported confidence onto its empirically-observed
                // reliability before storing. rawConfidence keeps the pre-
                // calibration value so the reliability curve never learns from
                // its own output.
                const claudeConfidence = calibrateConfidence(sym, ai.confidence);
                newRecs.push({
                  ...common,
                  id: recordId(sym, targetISO, "claude"),
                  predictedPrice: ai.predictedPrice,
                  predictedDirection: ai.direction,
                  confidence: claudeConfidence,
                  source: "claude",
                  abstained: null,
                  rawConfidence: ai.confidence,
                  archivedAt: null,
                  liveDirectionAbove: null,   // filled in by fetchLiveDirection initial trigger
                });

                // Regime-weighted ensemble of the two calls above. Even when it
                // abstains we store + evaluate it, so abstention quality (good
                // skip vs missed win) is measurable later. Directions are derived
                // from predicted-vs-reference price (NOT the raw Claude direction
                // string) so the disagreement check matches the DISPLAYED calls.
                //
                // Reference = Kalshi target (the window-open price) when known,
                // else current price. This keeps "up" = ABOVE target and "down" =
                // BELOW target — exactly matching the ABOVE/BELOW evaluation rule.
                const dirRef = kalshiTargetSnap ?? analysis.price;
                const dirFromPrice = (p: number): "up" | "down" | "flat" => {
                  const ch = dirRef > 0 ? ((p - dirRef) / dirRef) * 100 : 0;
                  return ch > 0.05 ? "up" : ch < -0.05 ? "down" : "flat";
                };
                const ens = computeEnsemble(
                  sym,
                  regime,
                  {
                    predictedPrice: basePred.predictedPrice,
                    direction: dirFromPrice(basePred.predictedPrice),
                    confidence: basePred.confidence,
                  },
                  {
                    predictedPrice: ai.predictedPrice,
                    direction: dirFromPrice(ai.predictedPrice),
                    confidence: claudeConfidence,
                  },
                  analysis.price,
                );
                newRecs.push({
                  ...common,
                  id: recordId(sym, targetISO, "ensemble"),
                  predictedPrice: ens.predictedPrice,
                  predictedDirection: ens.direction,
                  confidence: ens.confidence,
                  source: "ensemble",
                  abstained: ens.abstained,
                  rawConfidence: null,
                  archivedAt: null,
                  liveDirectionAbove: null,   // filled in by fetchLiveDirection initial trigger
                });
              }

              // ── Derive stat/claude directions for ML features 14-16 ─────────────
              // Use the same 0.05% threshold as the ensemble dirFromPrice helper.
              // These are used in both the ML training snapshot and the ML accuracy
              // record below so the training distribution matches inference exactly.
              {
                const _ref = kalshiTargetSnap ?? analysis.price;
                const _pct = (p: number) => _ref > 0 ? ((p - _ref) / _ref) * 100 : 0;
                const mlStatAbove: boolean | null =
                  _pct(basePred.predictedPrice) > 0.05 ? true :
                  _pct(basePred.predictedPrice) < -0.05 ? false : null;
                const mlClaudeAbove: boolean | null = ai
                  ? (_pct(ai.predictedPrice) > 0.05 ? true :
                     _pct(ai.predictedPrice) < -0.05 ? false : null)
                  : null;

                // ── ML: capture training snapshot after stat+claude are computed ──
                // Features 14-16 now carry real model directions (not the 0.5
                // placeholder that would have been used if captured before this point).
                if (kalshiTargetSnap != null) {
                  const elapsed = Math.min(timeIntoWindow / (15 * 60_000), 1);
                  const priceAtOpen = getKalshiWindowContext(sym)?.priceAtOpen ?? null;
                  const snapFeatures = extractMLFeatures(analysis, kalshiTargetSnap, elapsed, priceAtOpen, mlStatAbove, mlClaudeAbove, null);
                  captureMLSnapshot(sym, targetISO, snapFeatures, elapsed);
                }

              // ML model record — written alongside stat/claude/ensemble so its
              // accuracy is tracked in the same evaluation pipeline. Only added
              // when the model is ready and a Kalshi target is available (ML
              // requires the target as a feature). Stored as a synthetic price
              // just above/below the strike to encode the binary ABOVE/BELOW call
              // in the same predictedPrice→kalshiTarget comparison used for eval.
              if (kalshiTarget != null) {
                const mlStatus = getMLStatus(sym);
                if (mlStatus.ready) {
                  const elapsed = Math.min(timeIntoWindow / (15 * 60_000), 1);
                  const priceAtOpen = getKalshiWindowContext(sym)?.priceAtOpen ?? null;
                  const mlFeatures = extractMLFeatures(analysis, kalshiTarget, elapsed, priceAtOpen, mlStatAbove, mlClaudeAbove, null);
                  const mlResult = getMLPrediction(sym, mlFeatures);
                  if (mlResult.prediction?.above !== null && mlResult.prediction?.above !== undefined) {
                    const mlAbove = mlResult.prediction.above;
                    lastMLAboveCache.set(sym, mlAbove);
                    // Synthetic price: 0.1% above/below strike encodes direction
                    // and evaluates correctly against the actual close price.
                    const mlPredPrice = mlSnapPrice(mlAbove, kalshiTarget);
                    newRecs.push({
                      ...common,
                      id: recordId(sym, targetISO, "ml"),
                      predictedPrice: mlPredPrice,
                      predictedDirection: mlAbove ? "up" : "down",
                      confidence: mlResult.prediction.confidence ?? 50,
                      source: "ml",
                      abstained: null,
                      rawConfidence: mlResult.prediction.prob ?? null,
                      archivedAt: null,
                      liveDirectionAbove: null,
                    });
                  }
                }
              }
              } // end stat/claude directions block

              for (const rec of newRecs) {
                records.push(rec);
                dbInsertRecord(rec);
              }
              if (records.length > MAX_HISTORY)
                records.splice(0, records.length - MAX_HISTORY);
            }
            } // end else (kalshiTarget available or gave up waiting)
          } catch {
            // non-fatal — will retry next tick
          } finally {
            snapInFlight.delete(snapKey);
          }
        }

        // ── Auto-trigger live-direction re-check ────────────────────────────
        // Keeps Claude's Call current throughout the window for every coin
        // with Claude enabled. Two independent triggers — both respect the
        // LIVE_DIR_AUTO_COOLDOWN throttle so we never spam Claude:
        //   (a) Strike-crossing: live price moved to the opposite side from
        //       Claude's last cached ABOVE/BELOW call.
        //   (b) Periodic: cache is stale (> LIVE_DIR_PERIODIC_MS elapsed since
        //       the last fetch), so Claude re-analyses current market conditions.
        const LIVE_DIR_PERIODIC_MS = 5 * 60_000; // refresh at least every 5 min
        if (isCoinClaudeEnabled(sym) && !liveDirectionInFlight.has(sym)) {
          const cached = liveDirectionCache.get(sym);
          const lastTrigger = liveDirectionLastAutoTrigger.get(sym) ?? 0;
          if (nowMs - lastTrigger > LIVE_DIR_AUTO_COOLDOWN) {
            let triggerReason: string | null = null;

            // (a) Strike-crossing trigger.
            if (cached && cached.result.aboveKalshi !== null) {
              const statRec = records.slice().reverse().find(
                (r) => r.source === "stat" && r.kalshiTarget != null,
              );
              if (statRec?.kalshiTarget != null) {
                try {
                  const currentPrice = await getTicker(coin.product);
                  const priceAbove = currentPrice >= statRec.kalshiTarget;
                  if (priceAbove !== cached.result.aboveKalshi) {
                    triggerReason = `price ${currentPrice.toFixed(4)} crossed strike ${statRec.kalshiTarget}`;
                  }
                } catch {
                  // non-fatal
                }
              }
            }

            // (b) Periodic trigger — no cache yet, or cache is stale.
            if (!triggerReason) {
              if (!cached) {
                // Only fire the initial Claude call once the stat snap for THIS
                // window is done — that guarantees the Kalshi target has been
                // fetched, so Claude's prompt will have the correct strike price.
                const statSnappedThisWindow = records.find(
                  (r) => r.source === "stat" && r.targetTime === targetISO,
                );
                if (statSnappedThisWindow) {
                  triggerReason = "initial (stat snap ready)";
                }
              } else if (nowMs - cached.at > LIVE_DIR_PERIODIC_MS) {
                triggerReason = `periodic (${Math.round((nowMs - cached.at) / 60_000)}m since last)`;
              }
            }

            if (triggerReason) {
              const isInitialTrigger = triggerReason === "initial (stat snap ready)";
              liveDirectionInFlight.add(sym);
              liveDirectionLastAutoTrigger.set(sym, nowMs);
              console.info(`[live-dir] ${sym}: ${triggerReason} — re-checking Claude`);
              fetchLiveDirection(sym, true)
                .then((result) => {
                  // On the initial trigger only: write the direct binary ABOVE/BELOW
                  // verdict back to the claude/ensemble DB records as liveDirectionAbove.
                  // This becomes the authoritative AT OPEN call for accuracy evaluation,
                  // avoiding the price-prediction-to-binary rounding error near the strike.
                  if (isInitialTrigger && result && result.aboveKalshi !== null) {
                    dbUpdateLiveDirection(sym, targetISO, result.aboveKalshi);
                  }
                })
                .catch(() => {})
                .finally(() => liveDirectionInFlight.delete(sym));
            }
          }
        }

        // 3. Record the Window Monitor signal once it locks (≥5 min elapsed).
        //    We key by `${sym}:${windowKey}` so each window is written exactly
        //    once.  The DB insert uses onConflictDoNothing for idempotency.
        //    Only persisted when a Kalshi target is available (non-Kalshi
        //    windows carry no meaningful ABOVE/BELOW result to evaluate against).
        const wKeyMs = Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000);
        const currentWKey = new Date(wKeyMs).toISOString().slice(0, 16);
        const wmId = `${sym}:${currentWKey}`;
        if (!wmRecordedKeys.has(wmId)) {
          const wbs = getWindowBetSignal(sym);
          if (wbs?.ready) {
            const wTargetISO = nextBoundary.toISOString();
            const statRec = records.find(
              (r) => r.source === "stat" && r.targetTime === wTargetISO && r.kalshiTarget != null,
            );
            const wKalshiTarget = statRec?.kalshiTarget ?? null;
            // Only persist when a Kalshi target is available — without one the
            // outcome can never be evaluated (no strike to compare actual price
            // against), so the row would sit unevaluated forever.
            if (wKalshiTarget != null) {
              wmRecordedKeys.add(wmId);
              const wStatPredAbove = statRec!.predictedPrice >= wKalshiTarget;
              db.insert(windowMonitorOutcomesTable)
                .values({
                  id: wmId,
                  symbol: sym,
                  windowKey: currentWKey,
                  targetTime: wTargetISO,
                  recommendation: wbs.recommendation,
                  factors: wbs.factors,
                  kalshiTarget: String(wKalshiTarget),
                  statPredictedAbove: wStatPredAbove,
                  actualAbove: null,
                  outcome: null,
                  lockedAt: new Date(nowMs),
                  evaluatedAt: null,
                })
                .onConflictDoNothing()
                .execute()
                .catch(() => { wmRecordedKeys.delete(wmId); });
            }
          }
        }
      }),
    );
  };

  // Load DB history and ML state in parallel, then start the tick loop.
  // Both are non-fatal — failures are logged but don't block the tracker.
  Promise.all([
    initHistoryFromDB().catch(() => {}),
    initMLFromDB().catch(() => {}),
  ]).finally(() => {
    // Recover any timing snapshots from closed windows that were never evaluated
    // (e.g. written before a server restart — the normal evaluation block only
    // fires for windows that close *while the server is running*).
    recoverUnevaluatedTimingSnapshots().catch(() => {});
    tick().catch(() => {});
    setInterval(() => tick().catch(() => {}), 30_000);
    onInitComplete?.();
  });

  // Prune records older than RETENTION_DAYS once at startup and then every 24 h.
  // Non-fatal — a failure is logged but does not affect the tracker.
  pruneOldPredictionRecords().catch(() => {});
  setInterval(() => pruneOldPredictionRecords().catch(() => {}), 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return the most-recently-cached analysis for a coin, or null if cold. */
export function getCachedPrediction(symbol: string): CoinPrediction | null {
  return predCache.get(symbol)?.value ?? null;
}

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
    coins: coins.filter((c) => c !== null) as CoinPrediction[],
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

// ---------------------------------------------------------------------------
// Tracker window snapshot — Claude's opening call for the current 15-min window
// ---------------------------------------------------------------------------

export interface TrackerWindowCall {
  direction: "up" | "down" | "flat";
  aboveKalshi: boolean | null;
  predictedPrice: number;
  confidence: number;
  snappedAt: string;
  strikeProximityPct: number | null;
}

// Returns the tracker's Claude record for the CURRENT window, if one has been
// snapped already (i.e., within the first 4 minutes of the window).  Callers
// use this to display the "what did Claude say at window-open?" signal without
// triggering a new API call.
export function getTrackerWindowCall(symbol: string): TrackerWindowCall | null {
  const nowMs = Date.now();
  const nextBoundary = new Date(Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS);
  const targetISO = nextBoundary.toISOString();
  const records = historyStore.get(symbol.toUpperCase()) ?? [];
  const rec = records.find((r) => r.targetTime === targetISO && r.source === "claude");
  if (!rec) return null;
  const predPrice = Number(rec.predictedPrice);
  const aboveKalshi =
    rec.kalshiTarget != null ? predPrice >= Number(rec.kalshiTarget) : null;
  const strikeProximityPct =
    rec.kalshiTarget != null && rec.priceAtSnapshot != null && rec.priceAtSnapshot > 0
      ? Math.abs(rec.priceAtSnapshot - rec.kalshiTarget) / rec.priceAtSnapshot * 100
      : null;
  return {
    direction: rec.predictedDirection as "up" | "down" | "flat",
    aboveKalshi,
    predictedPrice: predPrice,
    confidence: rec.confidence,
    snappedAt: rec.snappedAt,
    strikeProximityPct,
  };
}

// Returns the tracker's stat record for the CURRENT window — the stat model's
// opening call, locked at first snap (30–90 s after window open). Used to show
// a committed ABOVE/BELOW that doesn't flip with live candle jitter.
export function getStatWindowCall(symbol: string): TrackerWindowCall | null {
  const nowMs = Date.now();
  const records = historyStore.get(symbol.toUpperCase()) ?? [];
  const result = computeStatWindowCall(records, nowMs);
  if (!result) return null;
  // computeStatWindowCall operates on the minimal SnapRecord shape, so
  // priceAtSnapshot (needed for proximity) is not in its result. Look up
  // the raw record directly to compute it.
  const targetISO = new Date(Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS).toISOString();
  const rec = records.find((r) => r.targetTime === targetISO && r.source === "stat");
  const strikeProximityPct =
    rec != null && rec.kalshiTarget != null && rec.priceAtSnapshot != null && rec.priceAtSnapshot > 0
      ? Math.abs(rec.priceAtSnapshot - rec.kalshiTarget) / rec.priceAtSnapshot * 100
      : null;
  return { ...result, strikeProximityPct };
}

// ---------------------------------------------------------------------------
// Window Monitor — BET / STAY AWAY / CAUTION signal at 5-min into window
// ---------------------------------------------------------------------------

export interface WindowBetSignal {
  ready: boolean;              // true once ≥5 min have elapsed in the window
  minutesElapsed: number;
  recommendation: "bet" | "stay_away" | "caution";
  reason: string;              // one short sentence for the user
  preWindowER: number | null;  // 90-min pre-window efficiency ratio (primary signal)
  factors: {
    efficiencyRatio: number;
    oscillationCount: number;
    spikeFlag: boolean;
    netDriftPct: number;
  };
}

// Pure decision function: classifies the first-N-minutes behaviour of a window.
//
// Threshold rationale (derived from 1 400+ backtested windows across all coins):
//   Pre-window ER ≥ 0.25 (trending/drifting regime) → 55–57% hit rate.
//   Pre-window ER < 0.25 or spike regime            → 46–47% hit rate.
//   The 5-min intra-window IWM alone has no predictive edge (bet ≈ caution ≈ 50%).
//   Therefore preWindowER is the primary signal; intra-window acts as a tie-breaker.
export function computeWindowBetSignal(
  metrics: {
    efficiencyRatio: number;       // intra-window ER (first 5 min of the window)
    oscillationCount: number;
    spikeFlag: boolean;
    netDriftPct: number;
    preWindowER?: number;          // 90-min pre-window ER — strongest predictor
    preWindowSpikeFlag?: boolean;  // spike flag from the pre-window lookback
  },
  minutesElapsed: number,
): WindowBetSignal {
  const { efficiencyRatio: er, oscillationCount: osc, spikeFlag, netDriftPct,
          preWindowER, preWindowSpikeFlag } = metrics;
  const factors = { efficiencyRatio: er, oscillationCount: osc, spikeFlag, netDriftPct };
  const pER = preWindowER ?? null;

  // When preWindowER is available it is the PRIMARY signal (55-57% hit rate vs 46-47%).
  // It is computed from the 90-min pre-window lookback and is usable from minute 1.
  // We only need 2 minutes of intra-window candles for the IWM secondary check.
  // Without preWindowER the intra-window fallback path needs 5 min of data.
  const readyThreshold = pER !== null ? 2 : 5;
  if (minutesElapsed < readyThreshold) {
    return { ready: false, minutesElapsed, recommendation: "caution", reason: "Monitoring…", preWindowER: pER, factors };
  }

  let recommendation: WindowBetSignal["recommendation"];
  let reason: string;

  const pSpike = preWindowSpikeFlag ?? false;

  if (pER !== null) {
    // ── Primary path: use the stronger 90-min pre-window regime signal ──────
    const regimeBad = pER < 0.25 || pSpike;
    const regimeGood = pER >= 0.30 && !pSpike;

    if (regimeBad) {
      // Choppy or spike pre-window regime → low edge territory.
      if (osc >= 3) {
        recommendation = "stay_away";
        reason = "Choppy/spike pre-window regime confirmed by choppy first 5 min";
      } else {
        recommendation = "caution";
        reason = "Choppy or spike regime before window — proceed carefully";
      }
    } else if (regimeGood) {
      // Trending or drifting pre-window → favorable.
      if (osc <= 3 && !spikeFlag) {
        recommendation = "bet";
        reason = "Trending pre-window regime with orderly opening — solid edge";
      } else {
        recommendation = "caution";
        reason = "Favorable pre-window regime but choppy opening — reduced confidence";
      }
    } else {
      // Borderline (0.25 ≤ pER < 0.30).
      recommendation = "caution";
      reason = "Borderline pre-window regime — insufficient directional clarity";
    }
  } else {
    // ── Fallback: no pre-window ER — use intra-window metrics only ──────────
    if ((er < 0.25 && osc >= 4) || (er < 0.30 && osc >= 5)) {
      recommendation = "stay_away";
      reason = "Price flip-flopping — no clear direction in first 5 min";
    } else if (spikeFlag && osc >= 3) {
      recommendation = "stay_away";
      reason = "Erratic spike + reversals — unpredictable window";
    } else if (er >= 0.45 && osc <= 2) {
      recommendation = "bet";
      reason = "Clean intra-window trend — price moving consistently";
    } else {
      recommendation = "caution";
      reason = "Mixed signals — proceed with reduced confidence";
    }
  }

  return { ready: true, minutesElapsed, recommendation, reason, preWindowER: pER, factors };
}

// Returns the Window Monitor signal for a coin.  If ≥5 min have elapsed the
// result is locked for the remainder of the window — it won't flip later even
// if the market suddenly goes choppy.  Returns null when no Kalshi window is
// active or candle data isn't cached yet (UI should suppress the card).
export function getWindowBetSignal(symbol: string): WindowBetSignal | null {
  const sym = symbol.toUpperCase();
  const winCtx = getKalshiWindowContext(sym);
  if (!winCtx) return null;

  const { minutesElapsed } = winCtx;
  // Use the Kalshi event ticker as the window key, not the UTC clock boundary.
  // currentWindowKey() snaps to :00/:15/:30/:45 which may not align with
  // Kalshi's actual window start times — a new Kalshi window that opens at
  // (say) 07:32 still falls inside the "07:30" UTC block, so the lock cache
  // would incorrectly return the previous window's locked verdict as current.
  // The eventTicker changes on every new Kalshi window regardless of when
  // within the UTC block that transition happens.
  const wKey = getLastKalshiTicker(sym) ?? currentWindowKey(new Date());

  // Return the locked signal if it was already committed for this window.
  const locked = windowBetSignalLockCache.get(sym);
  if (locked?.windowKey === wKey && locked.signal.ready) {
    // Carry forward the current minutesElapsed so the UI countdown stays live.
    return { ...locked.signal, minutesElapsed };
  }

  // Need candles from the prediction cache to compute the 5-min IWM.
  const pred = getCachedPrediction(sym);
  if (!pred) return null;

  // Use only as many candles as the window has been open (max 5).
  const nCandles = Math.min(Math.max(minutesElapsed, 1), 5);
  const iwm = intraWindowMetrics(pred.candles, nCandles);

  const signal = computeWindowBetSignal(
    {
      efficiencyRatio: iwm.efficiencyRatio,
      oscillationCount: iwm.oscillationCount,
      spikeFlag: iwm.spikeFlag,
      netDriftPct: iwm.netDriftPct,
      // Pass the 90-min pre-window regime indicators from the prediction cache.
      // These are the primary predictor of window edge (55-57% vs 46-47% hit rate).
      preWindowER: pred.indicators.efficiencyRatio,
      preWindowSpikeFlag: pred.indicators.spikeFlag,
    },
    minutesElapsed,
  );

  // Lock once the observation window closes.
  if (signal.ready) {
    windowBetSignalLockCache.set(sym, { windowKey: wKey, signal });
  }

  return signal;
}

// ---------------------------------------------------------------------------
// Live direction — lightweight mid-window Claude re-check (cached 5 min)
// ---------------------------------------------------------------------------

export interface LiveDirectionResult {
  aboveKalshi: boolean | null;
  direction: "up" | "down" | "flat";
  confidence: number;
  at: string;
  cached: boolean;
}

const liveDirectionCache = new Map<string, { result: LiveDirectionResult; at: number }>();
const LIVE_DIR_TTL = 2 * 60_000; // 2 minutes — "live" means live
// Tracks in-flight live-direction re-checks (prevents concurrent calls per coin).
const liveDirectionInFlight = new Set<string>();
// Tracks when the last auto-trigger fired per coin (cooldown guard).
const liveDirectionLastAutoTrigger = new Map<string, number>();
const LIVE_DIR_AUTO_COOLDOWN = 2 * 60_000; // min gap between auto-triggers per coin

// Cheap, fast Claude call — no extended thinking, minimal context.  Just enough
// to answer the binary "ABOVE or BELOW the Kalshi strike at window close?" so
// the user can see if Claude's opinion has shifted during the window.
export async function fetchLiveDirection(symbol: string, force = false): Promise<LiveDirectionResult | null> {
  const nowMs = Date.now();
  const entry = liveDirectionCache.get(symbol.toUpperCase());
  if (!force && entry && nowMs - entry.at < LIVE_DIR_TTL) {
    return { ...entry.result, cached: true };
  }

  const coin = CRYPTO_COINS.find((c) => c.symbol === symbol.toUpperCase());
  if (!coin) return null;

  try {
    const [candles, stats, tickerPrice, kalshiTargetFresh] = await Promise.all([
      getCandles(coin.product),
      getStats(coin.product),
      getTicker(coin.product).catch(() => 0),
      KALSHI_SERIES[coin.symbol] ? fetchKalshiTarget(coin.symbol).catch(() => null) : Promise.resolve(null),
    ]);
    // The Kalshi strike doesn't change mid-window, so a slightly stale cached
    // value is just as accurate as a fresh one. If the 12-s TTL expired between
    // polls, fall back to the raw cache entry — as long as the window's
    // closeTime hasn't passed — so Claude always gets the strike in its prompt.
    let kalshiTargetVal = kalshiTargetFresh;
    if (kalshiTargetVal == null && KALSHI_SERIES[coin.symbol]) {
      const stale = kalshiTargetCache.get(coin.symbol.toUpperCase());
      if (stale?.value != null) {
        const ct = stale.closeTime;
        if (!ct || new Date(ct).getTime() > Date.now()) kalshiTargetVal = stale.value;
      }
    }

    const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
    const analysis = analyzeCoin(coin, candles, stats, new Date(), livePrice);
    const price = livePrice ?? analysis.price;
    const dp = price >= 100 ? 2 : price >= 1 ? 4 : 6;
    const ind = analysis.indicators;

    // Last 10 closes for momentum context, plus top volume candle
    const recent10 = candles.slice(-10);
    const closesStr = recent10.map((c) => `$${c.c.toFixed(dp)}`).join(" → ");
    const topVol = [...recent10].sort((a, b) => b.v - a.v)[0];
    const regime =
      ind.efficiencyRatio >= 0.4 ? "trending" : ind.efficiencyRatio >= 0.15 ? "drifting" : "choppy";

    // Window trajectory: how far price has moved from the strike since open
    const winCtx = getKalshiWindowContext(coin.symbol);
    let trajectoryNote = "";
    if (kalshiTargetVal && winCtx?.priceAtOpen && winCtx.minutesElapsed != null) {
      const openGapPct = ((winCtx.priceAtOpen - kalshiTargetVal) / kalshiTargetVal * 100).toFixed(3);
      const openSide = winCtx.priceAtOpen >= kalshiTargetVal ? "ABOVE" : "BELOW";
      trajectoryNote = `Window opened ${winCtx.minutesElapsed}min ago at $${winCtx.priceAtOpen.toFixed(dp)} (${Math.abs(Number(openGapPct))}% ${openSide} strike).`;
    }

    let prompt: string;
    if (kalshiTargetVal) {
      const side = price >= kalshiTargetVal ? "ABOVE" : "BELOW";
      const gapPct = (Math.abs(price - kalshiTargetVal) / kalshiTargetVal * 100).toFixed(3);
      prompt = `${coin.symbol} live check — Kalshi strike $${kalshiTargetVal.toFixed(dp)} (this window's opening price).
${trajectoryNote}
Now: $${price.toFixed(dp)} — ${gapPct}% ${side} strike.
RSI ${ind.rsi.toFixed(0)} | MACD ${ind.macd >= 0 ? "bull" : "bear"} | BB%B ${ind.bbPctB.toFixed(0)} | trend ${ind.trend} (strength ${Math.round(ind.trendStrength * 100)}%) | ER ${ind.efficiencyRatio.toFixed(2)} (${regime})
Recent 10 closes: ${closesStr}
Largest candle vol: $${topVol?.c.toFixed(dp)} (${topVol?.v.toFixed(0)} volume)
Oscillations last 15 candles: ${ind.oscillationCount} | Net drift: ${ind.netDriftPct >= 0 ? "+" : ""}${ind.netDriftPct.toFixed(3)}%

Will ${coin.symbol} close ABOVE or BELOW $${kalshiTargetVal.toFixed(dp)} at window close?
JSON only: {"above":true,"confidence":70}`;
    } else {
      prompt = `${coin.symbol} at $${price.toFixed(dp)}.
RSI ${ind.rsi.toFixed(0)} | MACD ${ind.macd >= 0 ? "bull" : "bear"} | trend ${ind.trend} | ER ${ind.efficiencyRatio.toFixed(2)} (${regime})
Recent 10 closes: ${closesStr}
Net drift: ${ind.netDriftPct >= 0 ? "+" : ""}${ind.netDriftPct.toFixed(3)}%

Will price be higher (up) or lower (down) in the next 15 min?
JSON only: {"direction":"up","confidence":65}`;
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 40,
      system:
        "Return ONLY valid compact JSON. For Kalshi questions: {\"above\":true,\"confidence\":70}. For direction questions: {\"direction\":\"up\",\"confidence\":65}. No markdown, no prose.",
      messages: [{ role: "user", content: prompt }],
    } as Parameters<typeof anthropic.messages.create>[0]);

    const raw = (response as { content: Array<{ type: string; text?: string }> }).content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    const parsed = JSON.parse(raw) as { above?: boolean; direction?: string; confidence?: number };

    const confidence = Math.min(90, Math.max(20, parsed.confidence ?? 60));
    let aboveKalshi: boolean | null = null;
    let direction: "up" | "down" | "flat" = "flat";

    if (kalshiTargetVal) {
      aboveKalshi = parsed.above ?? null;
      direction = aboveKalshi === null ? "flat" : aboveKalshi ? "up" : "down";
    } else {
      direction = (["up", "down", "flat"].includes(parsed.direction ?? "") ? parsed.direction : "flat") as "up" | "down" | "flat";
    }

    const result: LiveDirectionResult = { aboveKalshi, direction, confidence, at: new Date().toISOString(), cached: false };
    liveDirectionCache.set(symbol.toUpperCase(), { result, at: nowMs });
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Trend Stability — bot window-open cross-coin analysis
// ---------------------------------------------------------------------------

export type TrendStability = "clean" | "choppy" | "reversing";

export interface TrendStabilityResult {
  aboveKalshi: boolean | null;
  direction: "up" | "down" | "flat";
  confidence: number;
  trendStability: TrendStability;
  reasoning: string;   // 2-4 word rationale from Claude
  at: string;
  windowKey: string;
}

// Cache keyed by "${symbol}:${windowKey}" — auto-expires each window.
const trendStabilityCache = new Map<string, TrendStabilityResult>();

/**
 * Enhanced Claude call fired at window-open for the bot's cross-coin ranking pass.
 * Includes last-15 candle closes and asks Claude to classify trend stability
 * ("clean"/"choppy"/"reversing") alongside the normal ABOVE/BELOW call.
 * Results are cached per (symbol, windowKey) — safe to call from multiple ticks.
 */
export async function fetchTrendStabilityForBot(
  symbol: string,
  windowKey: string,
): Promise<TrendStabilityResult | null> {
  const sym = symbol.toUpperCase();
  const cacheKey = `${sym}:${windowKey}`;
  const cached = trendStabilityCache.get(cacheKey);
  if (cached) return cached;

  const coin = CRYPTO_COINS.find((c) => c.symbol === sym);
  if (!coin) return null;

  try {
    const [candles, stats, tickerPrice, kalshiTargetFresh] = await Promise.all([
      getCandles(coin.product),
      getStats(coin.product),
      getTicker(coin.product).catch(() => 0),
      KALSHI_SERIES[coin.symbol]
        ? fetchKalshiTarget(coin.symbol).catch(() => null)
        : Promise.resolve(null),
    ]);

    let kalshiTargetVal = kalshiTargetFresh;
    if (kalshiTargetVal == null && KALSHI_SERIES[coin.symbol]) {
      const stale = kalshiTargetCache.get(sym);
      if (stale?.value != null) {
        const ct = stale.closeTime;
        if (!ct || new Date(ct).getTime() > Date.now()) kalshiTargetVal = stale.value;
      }
    }

    const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
    const analysis = analyzeCoin(coin, candles, stats, new Date(), livePrice);
    const price = livePrice ?? analysis.price;
    const dp = price >= 100 ? 2 : price >= 1 ? 4 : 6;
    const ind = analysis.indicators;

    // ── Kalshi yes price (updated by fetchKalshiTarget above) ──────────────
    const yesPrice = kalshiTargetCache.get(sym)?.yesPrice ?? null;

    // ── Stat-model direction from in-memory history store ──────────────────
    const statRecords = historyStore.get(sym) ?? [];
    const statCall = computeStatWindowCall(statRecords, Date.now());
    const statDir = statCall?.aboveKalshi != null
      ? (statCall.aboveKalshi ? "above" : "below")
      : "unknown";

    // ── ML direction + confidence ──────────────────────────────────────────
    let mlDir = "unknown";
    let mlConf: number | null = null;
    const mlStatus = getMLStatus(sym);
    if (mlStatus.ready && kalshiTargetVal) {
      try {
        const winCtx = getKalshiWindowContext(sym);
        const priceAtOpen = winCtx?.priceAtOpen ?? null;
        const windowStartMs = new Date(windowKey + ":00Z").getTime();
        const elapsed = Math.min(
          !isNaN(windowStartMs) ? (Date.now() - windowStartMs) / (15 * 60_000) : 0,
          1,
        );
        const mlFeatures = extractMLFeatures(analysis, kalshiTargetVal, elapsed, priceAtOpen);
        const mlResult = getMLPrediction(sym, mlFeatures);
        if (mlResult.prediction?.above != null) {
          mlDir = mlResult.prediction.above ? "above" : "below";
          mlConf = mlResult.prediction.confidence ?? 50;
          lastMLAboveCache.set(sym, mlResult.prediction.above);
        }
      } catch {
        // ML unavailable — proceed without it
      }
    }

    const last15 = candles.slice(-15);
    const closesStr = last15.map((c) => `$${c.c.toFixed(dp)}`).join(" → ");
    const regime =
      ind.efficiencyRatio >= 0.4 ? "trending" : ind.efficiencyRatio >= 0.15 ? "drifting" : "choppy";

    let prompt: string;
    if (kalshiTargetVal) {
      const side = price >= kalshiTargetVal ? "ABOVE" : "BELOW";
      const gapPct = (Math.abs(price - kalshiTargetVal) / kalshiTargetVal * 100).toFixed(3);
      const yesPriceStr = yesPrice != null ? `${Math.round(yesPrice * 100)}¢` : "n/a";
      const mlStr = mlConf != null
        ? `ML: ${mlDir} (${mlConf.toFixed(0)}% conf)`
        : `ML: ${mlDir}`;
      prompt = `${sym} window-open trend analysis — Kalshi strike $${kalshiTargetVal.toFixed(dp)}.
Now: $${price.toFixed(dp)} — ${gapPct}% ${side} strike. Yes price: ${yesPriceStr}.
Stat model: ${statDir} | ${mlStr}
ER ${ind.efficiencyRatio.toFixed(2)} (${regime}) | RSI ${ind.rsi.toFixed(0)} | oscillations ${ind.oscillationCount} | net drift ${ind.netDriftPct >= 0 ? "+" : ""}${ind.netDriftPct.toFixed(3)}%
Last 15 one-minute closes (oldest→newest): ${closesStr}

Classify trend stability from the 15 closes:
  "clean"     = steady directional momentum, low noise
  "choppy"    = oscillating without clear direction
  "reversing" = clear reversal of prior trend in the most recent candles

Will ${sym} close ABOVE or BELOW $${kalshiTargetVal.toFixed(dp)} at window close?
JSON only: {"above":true,"confidence":70,"stability":"clean","reasoning":"momentum up"}`;
    } else {
      const mlStr = mlConf != null
        ? `ML: ${mlDir} (${mlConf.toFixed(0)}% conf)`
        : `ML: ${mlDir}`;
      prompt = `${sym} window-open trend analysis.
Now: $${price.toFixed(dp)}
Stat model: ${statDir} | ${mlStr}
ER ${ind.efficiencyRatio.toFixed(2)} (${regime}) | RSI ${ind.rsi.toFixed(0)} | oscillations ${ind.oscillationCount} | net drift ${ind.netDriftPct >= 0 ? "+" : ""}${ind.netDriftPct.toFixed(3)}%
Last 15 one-minute closes (oldest→newest): ${closesStr}

Classify trend stability from the 15 closes:
  "clean"     = steady directional momentum, low noise
  "choppy"    = oscillating without clear direction
  "reversing" = clear reversal of prior trend in the most recent candles

Will price be higher (up) or lower (down) in 15 min?
JSON only: {"direction":"up","confidence":65,"stability":"choppy","reasoning":"noisy oscillation"}`;
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 80,
      system:
        "Return ONLY valid compact JSON. Kalshi format: {\"above\":true,\"confidence\":70,\"stability\":\"clean\",\"reasoning\":\"momentum up\"}. Direction format: {\"direction\":\"up\",\"confidence\":65,\"stability\":\"choppy\",\"reasoning\":\"noisy\"}. stability: clean|choppy|reversing. reasoning: 2-4 words. No markdown, no prose.",
      messages: [{ role: "user", content: prompt }],
    } as Parameters<typeof anthropic.messages.create>[0]);

    const raw = (response as { content: Array<{ type: string; text?: string }> }).content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    const parsed = JSON.parse(raw) as {
      above?: boolean;
      direction?: string;
      confidence?: number;
      stability?: string;
      reasoning?: string;
    };

    const confidence = Math.min(90, Math.max(20, parsed.confidence ?? 60));
    const validStabilities: TrendStability[] = ["clean", "choppy", "reversing"];
    const trendStability: TrendStability = validStabilities.includes(parsed.stability as TrendStability)
      ? (parsed.stability as TrendStability)
      : "choppy";
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";

    let aboveKalshi: boolean | null = null;
    let direction: "up" | "down" | "flat" = "flat";
    if (kalshiTargetVal) {
      aboveKalshi = parsed.above ?? null;
      direction = aboveKalshi === null ? "flat" : aboveKalshi ? "up" : "down";
    } else {
      direction = (["up", "down", "flat"].includes(parsed.direction ?? "")
        ? parsed.direction
        : "flat") as "up" | "down" | "flat";
    }

    const result: TrendStabilityResult = {
      aboveKalshi,
      direction,
      confidence,
      trendStability,
      reasoning,
      at: new Date().toISOString(),
      windowKey,
    };
    trendStabilityCache.set(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Window Monitor outcome accuracy
// ---------------------------------------------------------------------------

export interface WMAccuracyStats {
  bet: { total: number; correct: number; accuracy: number | null };
  stay_away: { total: number; correct: number; accuracy: number | null };
  caution: { total: number; correct: number; accuracy: number | null };
  totalSamples: number;
  days: number;
}

export async function getWindowMonitorAccuracy(symbol: string, days = 7): Promise<WMAccuracyStats> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(windowMonitorOutcomesTable)
    .where(
      and(
        eq(windowMonitorOutcomesTable.symbol, symbol.toUpperCase()),
        gt(windowMonitorOutcomesTable.lockedAt, since),
        isNotNull(windowMonitorOutcomesTable.outcome),
      ),
    );

  const tally: Record<string, { total: number; correct: number }> = {
    bet: { total: 0, correct: 0 },
    stay_away: { total: 0, correct: 0 },
    caution: { total: 0, correct: 0 },
  };

  for (const row of rows) {
    const bucket = tally[row.recommendation];
    if (!bucket || !row.outcome) continue;
    bucket.total++;
    if (row.outcome === "correct") bucket.correct++;
  }

  const betBucket = tally.bet;
  if (betBucket.total >= 20) {
    const betAcc = betBucket.correct / betBucket.total;
    if (betAcc < 0.55) {
      logger.warn(
        { symbol, betAccuracy: betAcc.toFixed(3), samples: betBucket.total },
        "Window Monitor BET threshold may need re-tuning: accuracy below 55%",
      );
    }
  }

  const acc = (b: { total: number; correct: number }) =>
    b.total > 0 ? b.correct / b.total : null;

  return {
    bet:       { ...betBucket,       accuracy: acc(betBucket) },
    stay_away: { ...tally.stay_away, accuracy: acc(tally.stay_away) },
    caution:   { ...tally.caution,   accuracy: acc(tally.caution) },
    totalSamples: rows.length,
    days,
  };
}

// ---------------------------------------------------------------------------
// Timing analysis — per-symbol accuracy at each intra-window minute mark
// ---------------------------------------------------------------------------

const TIMING_MARK_LABELS: Record<number, string> = {
  60:  "1 min",
  180: "3 min",
  360: "6 min",
  540: "9 min",
  720: "12 min",
};

export interface TimingAnalysisRow {
  symbol: string | null;     // null when aggregated across all symbols
  minuteMark: number;        // seconds into window
  label: string;
  sampleCount: number;
  accuracy: number | null;   // 0-1 fraction correct
  avgYesPrice: number | null;// Kalshi Yes price (0-1 fraction), null until collected
  avgReturn: number | null;  // potential upside per $1 bet if correct: (1-p)/p
  ev: number | null;         // EV per $1 bet = accuracy*(1/yesPrice) - (1-accuracy)
}

/**
 * Startup recovery: evaluates any timing snapshots from already-closed windows
 * that were never scored (e.g. written before a server restart).
 *
 * The normal evaluation block only fires when a window closes *while the server
 * is running*. Any snapshot written before a restart stays unevaluated forever
 * unless we back-fill it here using the actual closing price already stored in
 * prediction_records.
 */
async function recoverUnevaluatedTimingSnapshots(): Promise<void> {
  try {
    // Find distinct closed windows with at least one unevaluated snapshot.
    const pendingRows = await db.execute(sql`
      SELECT DISTINCT symbol, window_key, target_time, kalshi_target
      FROM   window_timing_snapshots
      WHERE  actual_above IS NULL
        AND  target_time < NOW()
    `);

    if (pendingRows.rows.length === 0) return;

    let recovered = 0;

    for (const row of pendingRows.rows as Array<Record<string, unknown>>) {
      const sym         = String(row.symbol);
      const windowKey   = String(row.window_key);
      const targetISO   = new Date(row.target_time as string).toISOString();
      const kalshiTarget = Number(row.kalshi_target);

      // Look up the actual closing price stored in prediction_records for this
      // symbol + window boundary — any evaluated record with actual_price works.
      const priceRes = await db.execute(sql`
        SELECT actual_price
        FROM   prediction_records
        WHERE  symbol      = ${sym}
          AND  target_time = ${targetISO}::timestamptz
          AND  actual_price IS NOT NULL
        LIMIT 1
      `);

      if (priceRes.rows.length === 0) continue; // no closing price yet — skip

      const actualPrice = Number((priceRes.rows[0] as Record<string, unknown>).actual_price);
      if (!actualPrice || actualPrice <= 0) continue;

      // Strict `>` consistent with the live evaluation rule.
      const actualAbove = actualPrice > kalshiTarget;

      await db.execute(sql`
        UPDATE window_timing_snapshots
        SET  actual_above  = ${actualAbove},
             correct       = (price_above = ${actualAbove}),
             evaluated_at  = NOW()
        WHERE symbol      = ${sym}
          AND window_key  = ${windowKey}
          AND actual_above IS NULL
      `);

      recovered++;
    }

    if (recovered > 0) {
      console.info(
        `[timing-recovery] back-filled ${recovered} unevaluated timing window(s) from closed prediction records`,
      );
    }
  } catch (err) {
    console.warn("[timing-recovery] failed (non-fatal):", err);
  }
}

/**
 * Returns direction accuracy per minute mark for intra-window entry timing.
 *
 * When `symbol` is omitted: aggregates across ALL symbols, grouped by
 * minute_mark only — the global recommendation curve.
 * When `symbol` is provided: groups by symbol+minute_mark — per-coin curve.
 * When `days` is provided: limits rows to the last N calendar days (by evaluated_at).
 */
export async function getTimingAnalysis(symbol?: string, days?: number): Promise<TimingAnalysisRow[]> {
  const rawRows = await db.execute(
    symbol
      ? days != null
        ? sql`
            SELECT symbol, minute_mark,
              COUNT(*)::int                                            AS sample_count,
              COUNT(*) FILTER (WHERE correct = true)::int             AS correct_count,
              AVG(kalshi_yes_price::float)                            AS avg_yes_price
            FROM window_timing_snapshots
            WHERE actual_above IS NOT NULL
              AND symbol = ${symbol}
              AND evaluated_at >= NOW() - (${days} || ' days')::interval
            GROUP BY symbol, minute_mark
            ORDER BY minute_mark
          `
        : sql`
            SELECT symbol, minute_mark,
              COUNT(*)::int                                            AS sample_count,
              COUNT(*) FILTER (WHERE correct = true)::int             AS correct_count,
              AVG(kalshi_yes_price::float)                            AS avg_yes_price
            FROM window_timing_snapshots
            WHERE actual_above IS NOT NULL
              AND symbol = ${symbol}
            GROUP BY symbol, minute_mark
            ORDER BY minute_mark
          `
      : days != null
        ? sql`
            SELECT NULL AS symbol, minute_mark,
              COUNT(*)::int                                            AS sample_count,
              COUNT(*) FILTER (WHERE correct = true)::int             AS correct_count,
              AVG(kalshi_yes_price::float)                            AS avg_yes_price
            FROM window_timing_snapshots
            WHERE actual_above IS NOT NULL
              AND evaluated_at >= NOW() - (${days} || ' days')::interval
            GROUP BY minute_mark
            ORDER BY minute_mark
          `
        : sql`
            SELECT NULL AS symbol, minute_mark,
              COUNT(*)::int                                            AS sample_count,
              COUNT(*) FILTER (WHERE correct = true)::int             AS correct_count,
              AVG(kalshi_yes_price::float)                            AS avg_yes_price
            FROM window_timing_snapshots
            WHERE actual_above IS NOT NULL
            GROUP BY minute_mark
            ORDER BY minute_mark
          `,
  );

  return (rawRows.rows as Array<Record<string, unknown>>).map((row) => {
    const sampleCount  = Number(row.sample_count);
    const correctCount = Number(row.correct_count);
    const accuracy     = sampleCount > 0 ? correctCount / sampleCount : null;
    const avgYesPrice  = row.avg_yes_price != null ? Number(row.avg_yes_price) : null;
    // avgReturn: expected payout per $1 if the bet wins = (1 - yesPrice) / yesPrice
    const avgReturn    =
      avgYesPrice !== null && avgYesPrice > 0 ? (1 - avgYesPrice) / avgYesPrice : null;
    // EV per $1 bet = accuracy × (1/yesPrice) - (1-accuracy)
    // Positive means the bet has positive expected value at this entry minute.
    const ev =
      accuracy !== null && avgYesPrice !== null && avgYesPrice > 0
        ? accuracy * (1 / avgYesPrice) - (1 - accuracy)
        : null;
    const markNum = Number(row.minute_mark);
    return {
      symbol:     row.symbol != null ? String(row.symbol) : null,
      minuteMark: markNum,
      label:      TIMING_MARK_LABELS[markNum] ?? `${markNum / 60} min`,
      sampleCount,
      accuracy,
      avgYesPrice,
      avgReturn,
      ev,
    };
  });
}
