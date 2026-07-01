// Earnings calendar. Uses Finnhub's free earnings-calendar endpoint when a
// FINNHUB_API_KEY is present; otherwise degrades gracefully to "no earnings
// info" so the bot simply loses the earnings blackout signal rather than
// crashing. Results are cached in-memory per ticker for the trading day.

import { logger } from "../logger";
import type { EarningsInfo } from "./types";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const cache = new Map<string, { info: EarningsInfo | null; at: number }>();

export function earningsConfigured(): boolean {
  return !!process.env.FINNHUB_API_KEY;
}

export async function getEarnings(
  ticker: string,
  blackoutHours: number,
): Promise<EarningsInfo | undefined> {
  const T = ticker.toUpperCase();
  const cached = cache.get(T);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.info ? withProximity(cached.info, blackoutHours) : undefined;
  }
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return undefined;
  try {
    const from = new Date().toISOString().slice(0, 10);
    const toDate = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(T)}&from=${from}&to=${toDate}&token=${key}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Finnhub ${res.status}`);
    const data = (await res.json()) as { earningsCalendar?: { date: string }[] };
    const next = (data.earningsCalendar ?? [])
      .map((e) => e.date)
      .filter(Boolean)
      .sort()[0];
    if (!next) {
      cache.set(T, { info: null, at: Date.now() });
      return undefined;
    }
    const info: EarningsInfo = { ticker: T, date: next, hoursUntil: 0, soon: false };
    cache.set(T, { info, at: Date.now() });
    return withProximity(info, blackoutHours);
  } catch (err) {
    logger.warn({ err, ticker: T }, "[stock-earnings] fetch failed (non-fatal)");
    cache.set(T, { info: null, at: Date.now() });
    return undefined;
  }
}

// ---------- Latest earnings surprise (actual vs estimate) ----------

export interface EarningsSurprise {
  period: string;            // e.g. "2024-06-30"
  actual: number | null;     // reported EPS
  estimate: number | null;   // consensus estimate EPS
  surprisePercent: number | null; // (actual - estimate) / |estimate| × 100
}

const surpriseCache = new Map<string, { data: EarningsSurprise | null; at: number }>();
const SURPRISE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — result doesn't change intraday

/**
 * Fetch the most recently reported EPS vs consensus estimate from Finnhub.
 * Returns undefined when FINNHUB_API_KEY is absent or no data is available.
 */
export async function getLatestEarningsSurprise(
  ticker: string,
): Promise<EarningsSurprise | undefined> {
  const T = ticker.toUpperCase();
  const cached = surpriseCache.get(T);
  if (cached && Date.now() - cached.at < SURPRISE_TTL_MS) {
    return cached.data ?? undefined;
  }
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return undefined;
  try {
    const url = `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(T)}&limit=1&token=${key}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Finnhub ${res.status}`);
    const data = (await res.json()) as Array<{
      period?: string;
      actual?: number | null;
      estimate?: number | null;
      surprisePercent?: number | null;
    }>;
    const latest = Array.isArray(data) ? data[0] : undefined;
    if (!latest?.period) {
      surpriseCache.set(T, { data: null, at: Date.now() });
      return undefined;
    }
    const result: EarningsSurprise = {
      period: latest.period,
      actual: latest.actual ?? null,
      estimate: latest.estimate ?? null,
      surprisePercent: latest.surprisePercent ?? null,
    };
    surpriseCache.set(T, { data: result, at: Date.now() });
    return result;
  } catch (err) {
    logger.warn({ err, ticker: T }, "[stock-earnings] surprise fetch failed (non-fatal)");
    surpriseCache.set(T, { data: null, at: Date.now() });
    return undefined;
  }
}

function withProximity(info: EarningsInfo, blackoutHours: number): EarningsInfo {
  const hoursUntil = (new Date(info.date + "T13:30:00Z").getTime() - Date.now()) / (60 * 60 * 1000);
  return {
    ...info,
    hoursUntil,
    soon: hoursUntil >= -6 && hoursUntil <= blackoutHours,
  };
}
