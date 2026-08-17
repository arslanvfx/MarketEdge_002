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
  BTC:  "bitcoin",
  ETH:  "ethereum",
  SOL:  "solana",
  XRP:  "ripple",
  DOGE: "dogecoin",
  HYPE: "hyperliquid",
  BNB:  "binancecoin",
  NEAR: "near",
  ZEC:  "zcash",
};

// Market definitions live in market-defs.ts (pure module, unit-testable);
// re-exported here so all existing `from "./crypto-data"` imports keep working.
export {
  CRYPTO_COINS, COMMODITY_SYMBOLS, isPythProduct, type CoinDef,
} from "./market-defs";
import { CRYPTO_COINS, isPythProduct, type CoinDef } from "./market-defs";

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
  category?: "crypto" | "commodity";
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
// Pyth routing — commodities (gold / silver / WTI)
// ---------------------------------------------------------------------------
// Kalshi settles its 15-min commodity markets against Pyth price feeds
// (settlement_sources: "Pyth - Gold" → Metal.XAU/USD, etc.), so Pyth is both
// the most credible AND the settlement-consistent source for live spot prices.
//   • Spot:    Hermes v2 /updates/price/latest — sub-second publish cadence.
//   • Candles: Pyth Benchmarks TradingView shim — 1-min/5-min OHLC history.
// Commodity products carry no exchange volume (candle v = 0); all volume-based
// logic (vwap, volumeDirectionBias, volTilt) already degrades gracefully to
// neutral when total volume is 0.

export const PYTH_HERMES = "https://hermes.pyth.network";
export const PYTH_BENCHMARKS = "https://benchmarks.pyth.network";

/** "PYTH:Metal.XAU/USD" → "Metal.XAU/USD" */
function pythSymbol(product: string): string {
  return product.slice(5);
}

// Pyth Hermes needs the hex feed id for spot lookups. Resolved once per
// symbol via the search endpoint, then cached for the process lifetime.
const pythFeedIdCache = new Map<string, string>();

async function getPythFeedId(symbol: string): Promise<string> {
  const hit = pythFeedIdCache.get(symbol);
  if (hit) return hit;
  const results = await fetchJson<Array<{ id: string; attributes: { symbol?: string } }>>(
    `${PYTH_HERMES}/v2/price_feeds?query=${encodeURIComponent(symbol.split(".").pop() ?? symbol)}`,
  );
  const match = results.find((r) => r.attributes?.symbol === symbol);
  if (!match) throw new Error(`Pyth feed id not found for ${symbol}`);
  pythFeedIdCache.set(symbol, match.id);
  return match.id;
}

/** Max acceptable publish age for a Pyth spot price used as a live tick.
 *  Pyth publishes sub-second when markets are open; anything older than this
 *  means the market is closed or the feed is degraded — callers must treat
 *  the price as unavailable (fail closed), never as a live tick. */
const PYTH_SPOT_MAX_AGE_S = 60;

/**
 * Fresh Pyth spot price. Throws when the feed is stale (> PYTH_SPOT_MAX_AGE_S)
 * or unavailable so callers fail closed exactly like a Coinbase fetch error.
 */
async function fetchPythSpot(product: string): Promise<number> {
  const sym = pythSymbol(product);
  const id = await getPythFeedId(sym);
  const body = await fetchJson<{
    parsed?: Array<{ id: string; price: { price: string; expo: number; publish_time: number } }>;
  }>(`${PYTH_HERMES}/v2/updates/price/latest?ids[]=${id}`, 5000);
  const p = body.parsed?.[0]?.price;
  if (!p) throw new Error(`Pyth spot unavailable for ${sym}`);
  const ageS = Date.now() / 1000 - p.publish_time;
  if (ageS > PYTH_SPOT_MAX_AGE_S) {
    throw new Error(`Pyth spot stale for ${sym} (${Math.round(ageS)}s old — market closed?)`);
  }
  const price = Number(p.price) * Math.pow(10, p.expo);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Pyth spot invalid for ${sym}`);
  return price;
}

/** Pyth Benchmarks TradingView-shim OHLC history → Candle[] (v always 0). */
async function fetchPythCandles(
  product: string,
  resolutionMin: number,
  lookbackSec: number,
): Promise<Candle[]> {
  const sym = pythSymbol(product);
  const to = Math.floor(Date.now() / 1000);
  const from = to - lookbackSec;
  const body = await fetchJson<{
    s: string;
    t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; v?: number[];
  }>(
    `${PYTH_BENCHMARKS}/v1/shims/tradingview/history` +
      `?symbol=${encodeURIComponent(sym)}&resolution=${resolutionMin}&from=${from}&to=${to}`,
  );
  if (body.s !== "ok" || !body.t?.length) {
    throw new Error(`Pyth candles unavailable for ${sym} (status=${body.s})`);
  }
  const candles: Candle[] = body.t.map((t, i) => ({
    t,
    o: body.o![i],
    h: body.h![i],
    l: body.l![i],
    c: body.c![i],
    v: body.v?.[i] ?? 0,
  }));
  return candles.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------
// Per-product cached fetchers
// ---------------------------------------------------------------------------
export async function getTicker(product: string): Promise<number> {
  const hit = tickerCache.get(product);
  if (hit && Date.now() - hit.at < TICKER_TTL) return hit.value;
  const price = isPythProduct(product)
    ? await fetchPythSpot(product)
    : parseFloat(
        (await fetchJson<Record<string, string>>(`${COINBASE}/products/${product}/ticker`)).price ?? "0",
      );
  tickerCache.set(product, { at: Date.now(), value: price });
  return price;
}

/**
 * getTickerFresh — like getTicker but ALWAYS hits the live Coinbase ticker,
 * bypassing the 2 s TTL cache.  Used by the conviction 1 s spot-price poller
 * so the direction guard sees genuinely moving prices instead of a value that
 * only refreshes every 2 s (and, via predCache, effectively every 15 s).
 * The fresh value still populates the shared tickerCache so other callers
 * benefit from it within their TTL window.
 */
export async function getTickerFresh(product: string): Promise<number> {
  if (isPythProduct(product)) {
    // fetchPythSpot enforces the publish-age ceiling and throws when the feed
    // is stale/closed — the conviction tick feed treats a throw as a failed
    // tick (nothing pushed), so the direction guard fails closed rather than
    // operating on frozen prices.
    const price = await fetchPythSpot(product);
    tickerCache.set(product, { at: Date.now(), value: price });
    return price;
  }
  const raw = await fetchJson<Record<string, string>>(
    `${COINBASE}/products/${product}/ticker`,
  );
  const price = parseFloat(raw.price ?? "0");
  if (price > 0) tickerCache.set(product, { at: Date.now(), value: price });
  return price;
}

export async function getCandles(product: string): Promise<Candle[]> {
  const hit = candleCache.get(product);
  if (hit && Date.now() - hit.at < CANDLE_TTL) return hit.value;
  let candles: Candle[];
  if (isPythProduct(product)) {
    // Coinbase returns 300 × 1-min candles by default; mirror that lookback.
    candles = await fetchPythCandles(product, 1, 300 * 60);
  } else {
    const raw = await fetchJson<number[][]>(
      `${COINBASE}/products/${product}/candles?granularity=60`,
    );
    candles = raw
      .map((r) => ({ t: r[0], l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] }))
      .sort((a, b) => a.t - b.t);
  }
  candleCache.set(product, { at: Date.now(), value: candles });
  return candles;
}

export async function getStats(product: string): Promise<CoinStats> {
  const hit = statsCache.get(product);
  if (hit && Date.now() - hit.at < STATS_TTL) return hit.value;
  let stats: CoinStats;
  if (isPythProduct(product)) {
    // No 24h stats endpoint on Pyth — derive from 24h of 15-min candles.
    const dayCandles = await fetchPythCandles(product, 15, 24 * 3600);
    const last = dayCandles[dayCandles.length - 1];
    stats = {
      open:   dayCandles[0]?.o ?? 0,
      high:   Math.max(...dayCandles.map((c) => c.h)),
      low:    Math.min(...dayCandles.map((c) => c.l)),
      last:   last?.c ?? 0,
      volume: 0,
    };
  } else {
    const raw = await fetchJson<Record<string, string>>(
      `${COINBASE}/products/${product}/stats`,
    );
    stats = {
      open:   parseFloat(raw.open   ?? "0"),
      high:   parseFloat(raw.high   ?? "0"),
      low:    parseFloat(raw.low    ?? "0"),
      last:   parseFloat(raw.last   ?? "0"),
      volume: parseFloat(raw.volume ?? "0"),
    };
  }
  statsCache.set(product, { at: Date.now(), value: stats });
  return stats;
}

export async function get5mCandles(product: string): Promise<Candle[]> {
  const hit = candle5mCache.get(product);
  if (hit && Date.now() - hit.at < CANDLE_5M_TTL) return hit.value;
  let candles: Candle[];
  if (isPythProduct(product)) {
    candles = (await fetchPythCandles(product, 5, 48 * 300)).slice(-48);
  } else {
    const raw = await fetchJson<number[][]>(
      `${COINBASE}/products/${product}/candles?granularity=300`,
    );
    candles = raw
      .map((r) => ({ t: r[0], l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] }))
      .sort((a, b) => a.t - b.t)
      .slice(-48);
  }
  candle5mCache.set(product, { at: Date.now(), value: candles });
  return candles;
}

export async function getOrderBook(product: string): Promise<OrderBook> {
  // Pyth is an oracle, not an exchange — there is no order book for
  // commodities. Return an empty book; every consumer already handles
  // orderBook === undefined/empty (imbalance features degrade to neutral).
  if (isPythProduct(product)) return { bids: [], asks: [] };
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

/**
 * Window close price for settlement evaluation — routes to the right source.
 * For Pyth products, uses the Benchmarks 1-min candle whose slot is the last
 * minute of the window (same convention as the Coinbase path in
 * kalshi-bot-shadow.fetchWindowClosePrice).  Returns null on any error.
 */
export async function fetchPythWindowClosePrice(product: string, windowKey: string): Promise<number | null> {
  try {
    const windowStartMs = new Date(windowKey + ":00Z").getTime();
    if (isNaN(windowStartMs)) return null;
    const windowEndSec = Math.floor((windowStartMs + 15 * 60_000) / 1000);
    const sym = pythSymbol(product);
    const body = await fetchJson<{ s: string; t?: number[]; c?: number[] }>(
      `${PYTH_BENCHMARKS}/v1/shims/tradingview/history` +
        `?symbol=${encodeURIComponent(sym)}&resolution=1&from=${windowEndSec - 120}&to=${windowEndSec}`,
    );
    if (body.s !== "ok" || !body.t?.length) return null;
    const targetT = windowEndSec - 60; // last 1-min candle in the window
    const idx = body.t.lastIndexOf(targetT);
    const close = idx >= 0 ? body.c![idx] : body.c![body.c!.length - 1];
    return Number.isFinite(close) && close > 0 ? close : null;
  } catch {
    return null;
  }
}
