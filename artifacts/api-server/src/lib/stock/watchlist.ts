// Watchlist CRUD. Watchlist tickers are always monitored by the scanner and bot
// regardless of scanner ranking.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { lookupUniverse } from "./universe";

export interface WatchlistEntry {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  addedAt: string;
}

export async function listWatchlist(): Promise<WatchlistEntry[]> {
  const res = (await db.execute(sql`
    SELECT ticker, company_name, sector, added_at
    FROM stock_watchlist
    ORDER BY added_at DESC
  `)) as unknown as { rows: any[] };
  return (res.rows ?? []).map((r) => ({
    ticker: r.ticker,
    companyName: r.company_name ?? null,
    sector: r.sector ?? null,
    addedAt: new Date(r.added_at).toISOString(),
  }));
}

export async function addWatchlist(ticker: string, name?: string, sector?: string): Promise<void> {
  const T = ticker.toUpperCase();
  const uni = lookupUniverse(T);
  await db.execute(sql`
    INSERT INTO stock_watchlist (ticker, company_name, sector)
    VALUES (${T}, ${name ?? uni?.name ?? null}, ${sector ?? uni?.sector ?? null})
    ON CONFLICT (ticker) DO NOTHING
  `);
}

export async function removeWatchlist(ticker: string): Promise<void> {
  await db.execute(sql`DELETE FROM stock_watchlist WHERE ticker = ${ticker.toUpperCase()}`);
}

export async function watchlistTickers(): Promise<string[]> {
  const rows = await listWatchlist();
  return rows.map((r) => r.ticker);
}
