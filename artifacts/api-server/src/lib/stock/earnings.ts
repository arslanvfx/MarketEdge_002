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

function withProximity(info: EarningsInfo, blackoutHours: number): EarningsInfo {
  const hoursUntil = (new Date(info.date + "T13:30:00Z").getTime() - Date.now()) / (60 * 60 * 1000);
  return {
    ...info,
    hoursUntil,
    soon: hoursUntil >= -6 && hoursUntil <= blackoutHours,
  };
}
