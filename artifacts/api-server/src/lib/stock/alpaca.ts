// Alpaca REST client for trading + market data + news.
//
// Auth is via API key/secret headers (no OAuth). Paper vs live is chosen by the
// trading base URL. Credentials are read from env at call time (never cached) so
// rotating a secret takes effect without a restart.
//
// This is the ONLY module that talks to Alpaca. Everything is best-effort: if
// keys are missing every call throws a clear AlpacaConfigError so callers can
// degrade gracefully rather than crash the server.

import { logger } from "../logger";
import type { Candle, NewsItem } from "./types";

const TRADING_PAPER = "https://paper-api.alpaca.markets";
const TRADING_LIVE = "https://api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";

export class AlpacaConfigError extends Error {
  constructor() {
    super("Alpaca API keys are not configured (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY).");
    this.name = "AlpacaConfigError";
  }
}

export function alpacaConfigured(): boolean {
  return !!(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);
}

function headers(): Record<string, string> {
  const id = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!id || !secret) throw new AlpacaConfigError();
  return {
    "APCA-API-KEY-ID": id,
    "APCA-API-SECRET-KEY": secret,
    "Content-Type": "application/json",
  };
}

function tradingBase(mode: "paper" | "live"): string {
  return mode === "live" ? TRADING_LIVE : TRADING_PAPER;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alpaca ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// ---------- Market data ----------

/** Approx. bars per trading day for a given Alpaca timeframe string. */
function barsPerDay(timeframe: string): number {
  if (timeframe === "1Day") return 1;
  if (timeframe === "1Hour") return 7;
  const m = /^(\d+)Min$/.exec(timeframe);
  if (m) return Math.max(1, Math.floor(390 / Number(m[1])));
  return 1;
}

/**
 * Fetch historical bars (candles) for a symbol. timeframe e.g. "5Min", "1Day".
 *
 * Alpaca defaults `start` to the beginning of the current trading day, so
 * without an explicit start a multi-day request (e.g. 250 daily bars) returns
 * only today's bar. We compute a start far enough back (trading days →
 * calendar days with weekend/holiday slack) that `limit` bars are available.
 */
export async function getBars(
  symbol: string,
  timeframe: string,
  limit = 100,
): Promise<Candle[]> {
  const tradingDays = Math.ceil(limit / barsPerDay(timeframe));
  const calendarDays = Math.ceil(tradingDays * 1.6) + 5;
  const start = new Date(Date.now() - calendarDays * 86_400_000).toISOString();
  const params = new URLSearchParams({
    timeframe,
    limit: String(limit),
    start,
    adjustment: "raw",
    feed: "iex", // IEX feed is available on the free data plan
    sort: "desc", // newest first so `limit` always keeps the most recent bars
  });
  const url = `${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars?${params}`;
  const data = await req<{ bars?: any[] }>(url);
  return (data.bars ?? []).reverse().map((b) => ({
    t: new Date(b.t).getTime(),
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  }));
}

/** Latest trade price for a symbol. */
export async function getLatestPrice(symbol: string): Promise<number | null> {
  try {
    const url = `${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`;
    const data = await req<{ trade?: { p: number } }>(url);
    return data.trade?.p ?? null;
  } catch (err) {
    logger.warn({ err, symbol }, "[alpaca] latest price failed");
    return null;
  }
}

/** Batched snapshots for many symbols: latest price + daily bar. */
export async function getSnapshots(
  symbols: string[],
): Promise<Record<string, { price: number; prevClose: number; changePct: number }>> {
  if (symbols.length === 0) return {};
  const params = new URLSearchParams({ symbols: symbols.join(","), feed: "iex" });
  const url = `${DATA_BASE}/v2/stocks/snapshots?${params}`;
  const data = await req<Record<string, any>>(url);
  const out: Record<string, { price: number; prevClose: number; changePct: number }> = {};
  for (const [sym, snap] of Object.entries(data)) {
    const price = snap?.latestTrade?.p ?? snap?.dailyBar?.c ?? 0;
    const prevClose = snap?.prevDailyBar?.c ?? snap?.dailyBar?.o ?? price;
    const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    out[sym] = { price, prevClose, changePct };
  }
  return out;
}

/** Raw news items for one or more tickers (Benzinga feed via Alpaca). */
export async function getNews(symbols: string[], limit = 10): Promise<NewsItem[]> {
  if (symbols.length === 0) return [];
  const params = new URLSearchParams({
    symbols: symbols.join(","),
    limit: String(limit),
    sort: "desc",
  });
  const url = `${DATA_BASE}/v1beta1/news?${params}`;
  const data = await req<{ news?: any[] }>(url);
  return (data.news ?? []).map((n) => ({
    id: String(n.id),
    ticker: (n.symbols?.[0] ?? symbols[0]) as string,
    headline: n.headline ?? "",
    summary: n.summary ?? "",
    url: n.url ?? undefined,
    source: n.source ?? "Alpaca",
    publishedAt: n.created_at ?? n.updated_at ?? undefined,
  }));
}

/**
 * Fetch news for symbols filtered by a start date (ISO date string, e.g. "2025-06-01").
 * Useful for pulling a strict 30-day window for analyst-change detection.
 */
export async function getNewsInRange(
  symbols: string[],
  startDate: string,
  limit = 20,
): Promise<NewsItem[]> {
  if (symbols.length === 0) return [];
  const params = new URLSearchParams({
    symbols: symbols.join(","),
    limit: String(limit),
    sort: "desc",
    start: startDate,
  });
  const url = `${DATA_BASE}/v1beta1/news?${params}`;
  const data = await req<{ news?: any[] }>(url);
  return (data.news ?? []).map((n) => ({
    id: String(n.id),
    ticker: (n.symbols?.[0] ?? symbols[0]) as string,
    headline: n.headline ?? "",
    summary: n.summary ?? "",
    url: n.url ?? undefined,
    source: n.source ?? "Alpaca",
    publishedAt: n.created_at ?? n.updated_at ?? undefined,
  }));
}

// ---------- Trading ----------

export interface AlpacaAccount {
  equity: number;
  cash: number;
  buyingPower: number;
  daytradeCount: number;
  patternDayTrader: boolean;
}

export async function getAccount(mode: "paper" | "live"): Promise<AlpacaAccount> {
  const data = await req<any>(`${tradingBase(mode)}/v2/account`);
  return {
    equity: Number(data.equity) || 0,
    cash: Number(data.cash) || 0,
    buyingPower: Number(data.buying_power) || 0,
    daytradeCount: Number(data.daytrade_count) || 0,
    patternDayTrader: !!data.pattern_day_trader,
  };
}

export interface AlpacaPosition {
  ticker: string;
  qty: number;
  avgEntry: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlpc: number;
}

export async function getPositions(mode: "paper" | "live"): Promise<AlpacaPosition[]> {
  const data = await req<any[]>(`${tradingBase(mode)}/v2/positions`);
  return (data ?? []).map((p) => ({
    ticker: p.symbol,
    qty: Number(p.qty),
    avgEntry: Number(p.avg_entry_price),
    currentPrice: Number(p.current_price),
    marketValue: Number(p.market_value),
    unrealizedPl: Number(p.unrealized_pl),
    unrealizedPlpc: Number(p.unrealized_plpc) * 100,
  }));
}

export interface PlacedOrder {
  id: string;
  symbol: string;
  qty: number;
  side: string;
  status: string;
  filledAvgPrice: number | null;
}

export async function placeOrder(
  mode: "paper" | "live",
  params: {
    symbol: string;
    qty?: number;
    notional?: number;
    side: "buy" | "sell";
    type?: "market" | "limit";
    limitPrice?: number;
    timeInForce?: "day" | "gtc";
  },
): Promise<PlacedOrder> {
  const body: Record<string, unknown> = {
    symbol: params.symbol,
    side: params.side,
    type: params.type ?? "market",
    time_in_force: params.timeInForce ?? "day",
  };
  if (params.qty != null) body.qty = String(params.qty);
  if (params.notional != null) body.notional = String(params.notional);
  if (params.limitPrice != null) body.limit_price = String(params.limitPrice);
  const data = await req<any>(`${tradingBase(mode)}/v2/orders`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    id: data.id,
    symbol: data.symbol,
    qty: Number(data.qty) || 0,
    side: data.side,
    status: data.status,
    filledAvgPrice: data.filled_avg_price ? Number(data.filled_avg_price) : null,
  };
}

/**
 * Liquidate an entire position at market.
 *
 * A 404 means the broker is already flat for this symbol — treated as success
 * so the caller can safely reconcile its DB row. Any other error is re-thrown
 * so the caller can keep the position open and retry, rather than marking the
 * DB flat while the broker may still hold live exposure.
 */
export async function closePosition(mode: "paper" | "live", symbol: string): Promise<void> {
  try {
    await req(`${tradingBase(mode)}/v2/positions/${encodeURIComponent(symbol)}`, {
      method: "DELETE",
    });
  } catch (err) {
    // Alpaca returns 404 when there is no open position for the symbol.
    if (err instanceof Error && /Alpaca 404\b/.test(err.message)) return;
    throw err;
  }
}

export interface MarketClock {
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
  timestamp: string;
}

export async function getClock(mode: "paper" | "live"): Promise<MarketClock> {
  const data = await req<any>(`${tradingBase(mode)}/v2/clock`);
  return {
    isOpen: !!data.is_open,
    nextOpen: data.next_open,
    nextClose: data.next_close,
    timestamp: data.timestamp,
  };
}
