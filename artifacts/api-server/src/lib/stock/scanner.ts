// Market scanner: ranks the universe (+ watchlist) for the best short-term
// opportunities across sectors. Runs on a schedule during market hours and
// persists results to stock_scanner_results for instant UI reads.
//
// To stay within data-rate limits it works in two passes:
//   1. one batched snapshot call prices the whole universe and picks movers
//   2. the top movers per sector get full candle + news + stat scoring
// Everything degrades gracefully when Alpaca keys are absent.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { alpacaConfigured, getSnapshots, getBars, getClock } from "./alpaca";
import { STOCK_UNIVERSE, SECTORS, lookupUniverse } from "./universe";
import { statSignal } from "./ai";
import { getScoredNews, aggregateSentiment } from "./news";
import { getEarnings } from "./earnings";
import { efficiencyRatio } from "./indicators";
import { watchlistTickers } from "./watchlist";
import { getConfig } from "./config";
import type { Candle, Direction, ScannerRow, Sentiment } from "./types";

const TOP_PER_SECTOR = 6;      // how many movers per sector get full scoring
let lastScanAt = 0;
let scanning = false;

/** Sector-average recent momentum, used as an ML/context feature. */
const sectorMomentum = new Map<string, number>();

export function getSectorMomentum(sector: string): number {
  return sectorMomentum.get(sector) ?? 0;
}

export async function runScan(opts: { force?: boolean } = {}): Promise<{ scanned: number; scored: number }> {
  if (scanning) return { scanned: 0, scored: 0 };
  if (!alpacaConfigured()) {
    logger.info("[stock-scanner] skipped — Alpaca not configured");
    return { scanned: 0, scored: 0 };
  }
  scanning = true;
  try {
    const cfg = getConfig();

    // Market-hours gate: skip *automatic* scans when the market is closed so we
    // don't burn data-rate limits overnight. Manual scans (force=true) bypass this
    // so users can browse stocks with last-session prices any time.
    if (!opts.force) {
      try {
        const clock = await getClock(cfg.mode);
        if (!clock.isOpen) {
          logger.info("[stock-scanner] skipped — market closed (auto-scan)");
          return { scanned: 0, scored: 0 };
        }
      } catch (err) {
        logger.warn({ err }, "[stock-scanner] clock check failed — scanning anyway");
      }
    }

    const watch = new Set(await watchlistTickers());
    const tickers = Array.from(new Set([...STOCK_UNIVERSE.map((e) => e.ticker), ...watch]));

    const snaps = await getSnapshots(tickers);

    // Sector momentum = mean daily change across the sector.
    const bySector = new Map<string, number[]>();
    for (const e of STOCK_UNIVERSE) {
      const s = snaps[e.ticker];
      if (!s) continue;
      const arr = bySector.get(e.sector) ?? [];
      arr.push(s.changePct);
      bySector.set(e.sector, arr);
    }
    for (const [sector, arr] of bySector) {
      sectorMomentum.set(sector, arr.reduce((a, b) => a + b, 0) / (arr.length || 1));
    }

    // Pick movers per sector (largest absolute daily move), always include watchlist.
    const shortlist = new Set<string>(watch);
    for (const sector of SECTORS) {
      const inSector = STOCK_UNIVERSE.filter((e) => e.sector === sector)
        .map((e) => ({ ticker: e.ticker, chg: Math.abs(snaps[e.ticker]?.changePct ?? 0) }))
        .sort((a, b) => b.chg - a.chg)
        .slice(0, TOP_PER_SECTOR);
      for (const m of inSector) shortlist.add(m.ticker);
    }

    const rows: ScannerRow[] = [];
    let scored = 0;

    for (const ticker of tickers) {
      const snap = snaps[ticker];
      const uni = lookupUniverse(ticker);
      const sector = uni?.sector ?? "Other";
      const price = snap?.price ?? 0;
      const changePct = snap?.changePct ?? 0;

      let direction: Direction | null = changePct >= 0 ? "up" : "down";
      let confidence = 50;
      let newsSentiment: Sentiment = "neutral";
      let earningsSoon = false;
      let details: Record<string, unknown> = { basic: true };
      let score = Math.abs(changePct); // baseline: magnitude of the move

      if (shortlist.has(ticker)) {
        try {
          const candles: Candle[] = await getBars(ticker, "5Min", 78);
          if (candles.length > 20) {
            const stat = statSignal(candles);
            const news = await getScoredNews(ticker);
            const agg = aggregateSentiment(news);
            const earn = await getEarnings(ticker, cfg.earningsBlackoutHours);
            newsSentiment = agg.sentiment;
            earningsSoon = !!earn?.soon;
            direction = stat.direction;
            confidence = stat.confidence;
            const er = efficiencyRatio(candles.map((c) => c.c), 14);
            // Composite: conviction × trend cleanliness + news alignment − earnings risk.
            const newsAlign =
              (agg.sentiment === "bullish" && stat.direction === "up") ||
              (agg.sentiment === "bearish" && stat.direction === "down")
                ? 1
                : agg.sentiment === "neutral"
                  ? 0
                  : -1;
            score =
              (confidence - 50) * (0.6 + 0.8 * er) +
              Math.abs(changePct) * 2 +
              newsAlign * 8 -
              (earningsSoon ? 6 : 0);
            details = {
              rsi: Math.round(stat.rsi),
              efficiencyRatio: Number(er.toFixed(2)),
              netDriftPct: Number(stat.netDriftPct.toFixed(2)),
              volumeBias: Number(stat.volumeBias.toFixed(2)),
              newsCount: news.length,
              reasoning: stat.reasoning,
            };
            scored++;
          }
        } catch (err) {
          logger.warn({ err, ticker }, "[stock-scanner] deep scoring failed");
        }
      }

      rows.push({
        ticker,
        companyName: uni?.name ?? ticker,
        sector,
        price,
        changePct,
        score,
        direction,
        confidence,
        newsSentiment,
        earningsSoon,
        details,
        updatedAt: new Date().toISOString(),
      });
    }

    await persistRows(rows);
    lastScanAt = Date.now();
    logger.info({ scanned: rows.length, scored }, "[stock-scanner] scan complete");
    return { scanned: rows.length, scored };
  } finally {
    scanning = false;
  }
}

async function persistRows(rows: ScannerRow[]): Promise<void> {
  for (const r of rows) {
    await db.execute(sql`
      INSERT INTO stock_scanner_results
        (ticker, company_name, sector, price, change_pct, score, direction, confidence,
         news_sentiment, earnings_soon, details, updated_at)
      VALUES
        (${r.ticker}, ${r.companyName}, ${r.sector}, ${r.price}, ${r.changePct}, ${r.score},
         ${r.direction}, ${r.confidence}, ${r.newsSentiment}, ${r.earningsSoon},
         ${JSON.stringify(r.details ?? {})}::jsonb, NOW())
      ON CONFLICT (ticker) DO UPDATE SET
        company_name = EXCLUDED.company_name,
        sector = EXCLUDED.sector,
        price = EXCLUDED.price,
        change_pct = EXCLUDED.change_pct,
        score = EXCLUDED.score,
        direction = EXCLUDED.direction,
        confidence = EXCLUDED.confidence,
        news_sentiment = EXCLUDED.news_sentiment,
        earnings_soon = EXCLUDED.earnings_soon,
        details = EXCLUDED.details,
        updated_at = NOW()
    `);
  }
}

export async function getScannerResults(): Promise<ScannerRow[]> {
  const res = (await db.execute(sql`
    SELECT ticker, company_name, sector, price, change_pct, score, direction, confidence,
           news_sentiment, earnings_soon, details, updated_at
    FROM stock_scanner_results
    ORDER BY score DESC
  `)) as unknown as { rows: any[] };
  return (res.rows ?? []).map((r) => ({
    ticker: r.ticker,
    companyName: r.company_name ?? r.ticker,
    sector: r.sector,
    price: Number(r.price) || 0,
    changePct: Number(r.change_pct) || 0,
    score: Number(r.score) || 0,
    direction: (r.direction ?? null) as Direction | null,
    confidence: Number(r.confidence) || 50,
    newsSentiment: (r.news_sentiment ?? "neutral") as Sentiment,
    earningsSoon: !!r.earnings_soon,
    details: r.details ?? {},
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export function lastScanTime(): number {
  return lastScanAt;
}
