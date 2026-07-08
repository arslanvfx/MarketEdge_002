// ---------------------------------------------------------------------------
// crypto-data.ts — raw data-fetch helpers, in-memory caches, shared types
// ---------------------------------------------------------------------------

import { logger } from "./logger";
import {
  type Candle,
  type OrderBook,
} from "./crypto-indicators";

export type { Candle } from "./crypto-indicators";
export { intraWindowMetrics } from "./crypto-indicators";

export const COINBASE = "https://api.exchange.coinbase.com";
export const COINGECKO = "https://api.coingecko.com/api/v3";
export const UA = "MarketEdge/1.0 (crypto-predictor)";

export const GECKO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
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
  { symbol: "DOGE", product: "DOGE-USD", name: "Dogecoin" },
];

export interface Prediction {
  target: string;
  label: string;
  minutesAhead: number;
  predictedPrice: number;
  low: number;
  high: number;
  direction: "up" | "down" | "flat";
  confidence: number;
  changePct: number;
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
    trendStrength: number;
    volatilityPct: number;
    bbUpper: number;
    bbLower: number;
    bbWidth: number;
    bbPctB: number;
    atr14: number;
    efficiencyRatio: number;
    oscillationCount: number;
    netDriftPct: number;
    totalPathPct: number;
    spikeFlag: boolean;
    spikeMultiple: number;
  };
  sparkline: number[];
  candles: Candle[];
  predictions: Prediction[];
  kalshiTarget?: number | null;
}

export interface CoinPrice {
  symbol: string;
  product: string;
  name: string;
  price: number;
  change24hPct: number;
}

export interface CoinStats {
  open: number;
  high: number;
  low: number;
  last: number;
  volume: number;
}

// ---------------------------------------------------------------------------
// Fetch helpers with short in-memory caches
// ---------------------------------------------------------------------------

export async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T> {
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

const candleCache    = new Map<string, CacheEntry<Candle[]>>();
const candle5mCache  = new Map<string, CacheEntry<Candle[]>>();
const orderBookCache = new Map<string, CacheEntry<OrderBook>>();
const statsCache     = new Map<string, CacheEntry<CoinStats>>();
const tickerCache    = new Map<string, CacheEntry<number>>();
const CANDLE_TTL      = 8_000;
const CANDLE_5M_TTL   = 20_000;
const ORDER_BOOK_TTL  = 4_000;
const STATS_TTL       = 4_000;
const TICKER_TTL      = 2_000;

// Full coin analysis cache (tracker keeps this warm; frontend uses it as fallback).
export const PRED_TTL = 15_000;
export const predCache = new Map<string, CacheEntry<CoinPrediction>>();

// Window-level prediction lock — committed once per 15-min window.
export const windowPredCache = new Map<string, { windowKey: string; predictions: Prediction[] }>();

// ---------------------------------------------------------------------------
// Returns the ISO-minute string for the START of the current 15-min window.
// ---------------------------------------------------------------------------
export function currentWindowKey(now: Date = new Date()): string {
  const ms = now.getTime();
  const windowMs = Math.floor(ms / (15 * 60_000)) * (15 * 60_000);
  return new Date(windowMs).toISOString().slice(0, 16);
}

// ---------------------------------------------------------------------------
// CoinGecko — single batched request for all coins (24h change reference)
// ---------------------------------------------------------------------------
interface GeckoEntry { usd: number; usd_24h_change: number; }
type GeckoPrices = Record<string, GeckoEntry>;
let geckoCache: CacheEntry<GeckoPrices> | null = null;
const GECKO_TTL = 15_000;

export async function getGeckoPrices(): Promise<GeckoPrices> {
  if (geckoCache && Date.now() - geckoCache.at < GECKO_TTL) return geckoCache.value;
  const ids = Object.values(GECKO_ID).join(",");
  const data = await fetchJson<GeckoPrices>(
    `${COINGECKO}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
  );
  geckoCache = { at: Date.now(), value: data };
  return data;
}

// ---------------------------------------------------------------------------
// Per-product cached fetchers
// ---------------------------------------------------------------------------
export async function getTicker(product: string): Promise<number> {
  const hit = tickerCache.get(product);
  if (hit && Date.now() - hit.at < TICKER_TTL) return hit.value;
  const raw = await fetchJson<Record<string, string>>(
    `${COINBASE}/products/${product}/ticker`,
  );
  const price = parseFloat(raw.price ?? "0");
  tickerCache.set(product, { at: Date.now(), value: price });
  return price;
}

export async function getCandles(product: string): Promise<Candle[]> {
  const hit = candleCache.get(product);
  if (hit && Date.now() - hit.at < CANDLE_TTL) return hit.value;
  const raw = await fetchJson<number[][]>(
    `${COINBASE}/products/${product}/candles?granularity=60`,
  );
  const candles: Candle[] = raw
    .map((r) => ({ t: r[0], l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] }))
    .sort((a, b) => a.t - b.t);
  candleCache.set(product, { at: Date.now(), value: candles });
  return candles;
}

export async function getStats(product: string): Promise<CoinStats> {
  const hit = statsCache.get(product);
  if (hit && Date.now() - hit.at < STATS_TTL) return hit.value;
  const raw = await fetchJson<Record<string, string>>(
    `${COINBASE}/products/${product}/stats`,
  );
  const stats: CoinStats = {
    open:   parseFloat(raw.open   ?? "0"),
    high:   parseFloat(raw.high   ?? "0"),
    low:    parseFloat(raw.low    ?? "0"),
    last:   parseFloat(raw.last   ?? "0"),
    volume: parseFloat(raw.volume ?? "0"),
  };
  statsCache.set(product, { at: Date.now(), value: stats });
  return stats;
}

export async function get5mCandles(product: string): Promise<Candle[]> {
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

export async function getOrderBook(product: string): Promise<OrderBook> {
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
