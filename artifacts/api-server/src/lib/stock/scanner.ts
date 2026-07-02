// Market scanner: ranks the universe (+ watchlist) for the best short-term
// opportunities across sectors. Runs on a schedule and persists results to
// stock_scanner_results for instant UI reads. Results survive server restarts.
//
// Scan strategy:
//   1. One batched snapshot call prices the whole universe (fast).
//   2. Top movers per sector get full candle + news + stat scoring (parallel).
//   3. Results are upserted to DB immediately after each ticker so partial
//      progress is visible if the scan is interrupted.
// Scan progress is tracked in-memory and exposed via getScanProgress() so the
// UI can show a live progress bar.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { isAiFeatureEnabled } from "../ai-spend";
import { alpacaConfigured, getSnapshots, getBars, getClock } from "./alpaca";
import { STOCK_UNIVERSE, SECTORS, lookupUniverse } from "./universe";
import { statSignal } from "./ai";
import { getScoredNews, aggregateSentiment } from "./news";
import { getEarnings } from "./earnings";
import { efficiencyRatio, sma } from "./indicators";
import { watchlistTickers } from "./watchlist";
import { getConfig } from "./config";
import { runResearchPass } from "./research";
import type { Candle, Direction, ScannerRow, Sentiment } from "./types";

const TOP_PER_SECTOR = 6;   // movers per sector that get deep scoring
const SCORE_BATCH = 5;       // concurrent deep-score requests

let lastScanAt = 0;
let scanning = false;

export interface ScanProgress {
  scanning: boolean;
  phase: "idle" | "snapshots" | "scoring" | "done";
  total: number;    // tickers that will be deep-scored
  done: number;     // tickers deep-scored so far
  currentTicker: string;
  pct: number;      // 0-100
}

let progress: ScanProgress = {
  scanning: false,
  phase: "idle",
  total: 0,
  done: 0,
  currentTicker: "",
  pct: 0,
};

export function getScanProgress(): ScanProgress {
  return { ...progress };
}

/** Sector-average recent momentum, used as an ML/context feature. */
const sectorMomentum = new Map<string, number>();

export function getSectorMomentum(sector: string): number {
  return sectorMomentum.get(sector) ?? 0;
}

/** Initialize lastScanAt from DB on server startup so the UI shows the age of
 *  existing results rather than treating them as absent. */
export async function initLastScanAt(): Promise<void> {
  try {
    const res = (await db.execute(sql`
      SELECT MAX(updated_at) AS last_at FROM stock_scanner_results
    `)) as unknown as { rows: any[] };
    const ts = res.rows?.[0]?.last_at;
    if (ts) {
      lastScanAt = new Date(ts).getTime();
      logger.info({ lastScanAt: new Date(lastScanAt).toISOString() }, "[stock-scanner] lastScanAt restored from DB");
    }
  } catch (err) {
    logger.warn({ err }, "[stock-scanner] initLastScanAt failed (non-fatal)");
  }
}

export async function runScan(opts: { force?: boolean } = {}): Promise<{ scanned: number; scored: number }> {
  if (scanning) return { scanned: 0, scored: 0 };
  if (!alpacaConfigured()) {
    logger.info("[stock-scanner] skipped — Alpaca not configured");
    return { scanned: 0, scored: 0 };
  }
  scanning = true;
  progress = { scanning: true, phase: "snapshots", total: 0, done: 0, currentTicker: "", pct: 0 };
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
          scanning = false;
          progress = { scanning: false, phase: "idle", total: 0, done: 0, currentTicker: "", pct: 0 };
          return { scanned: 0, scored: 0 };
        }
      } catch (err) {
        logger.warn({ err }, "[stock-scanner] clock check failed — scanning anyway");
      }
    }

    const watch = new Set(await watchlistTickers());
    const tickers = Array.from(new Set([...STOCK_UNIVERSE.map((e) => e.ticker), ...watch]));

    // ── Phase 1: batch snapshot (one call, very fast) ─────────────────────────
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

    // ── Phase 2: deep-score shortlist in parallel batches ────────────────────
    const shortlistArr = Array.from(shortlist);
    progress = { scanning: true, phase: "scoring", total: shortlistArr.length, done: 0, currentTicker: "", pct: 0 };

    const rowMap = new Map<string, ScannerRow>();

    // First pass: basic rows for all tickers (no deep scoring)
    for (const ticker of tickers) {
      const snap = snaps[ticker];
      const uni = lookupUniverse(ticker);
      const sector = uni?.sector ?? "Other";
      const price = snap?.price ?? 0;
      const changePct = snap?.changePct ?? 0;
      rowMap.set(ticker, {
        ticker,
        companyName: uni?.name ?? ticker,
        sector,
        price,
        changePct,
        score: Math.abs(changePct),
        direction: (changePct >= 0 ? "up" : "down") as Direction,
        confidence: 50,
        newsSentiment: "neutral" as Sentiment,
        earningsSoon: false,
        details: { basic: true },
        updatedAt: new Date().toISOString(),
      });
    }

    // Parallel batch deep-scoring for the shortlist.
    for (let i = 0; i < shortlistArr.length; i += SCORE_BATCH) {
      const batch = shortlistArr.slice(i, i + SCORE_BATCH);
      await Promise.all(batch.map(async (ticker) => {
        progress.currentTicker = ticker;
        try {
          // Fetch 5-min bars (for intraday stat signal) and daily bars (for MA).
          // Use limit=250 so we have enough history for sma180 where available.
          const [candles, dailyCandles] = await Promise.all([
            getBars(ticker, "5Min", 78),
            getBars(ticker, "1Day", 250),
          ]);
          if (candles.length < 20) return;

          const stat = statSignal(candles);
          const news = await getScoredNews(ticker);
          const agg = aggregateSentiment(news);
          const uni = lookupUniverse(ticker);
          const sector = uni?.sector ?? "Other";
          const earn = await getEarnings(ticker, getConfig().earningsBlackoutHours);
          const er = efficiencyRatio(candles.map((c) => c.c), 14);

          // MA alignment: 21-day SMA above 50-day SMA (bullish trend structure).
          // Also check vs 180-day SMA if we have enough history (the IEX feed
          // often returns 100–200 bars, so sma180 may be NaN — skip that check
          // gracefully rather than forcing maAlignment=false for all stocks).
          const dailyCloses = dailyCandles.map((c) => c.c);
          const sma21 = sma(dailyCloses, 21);
          const sma50 = sma(dailyCloses, 50);
          const sma180 = sma(dailyCloses, 180);
          const maAlignment =
            dailyCandles.length >= 50 &&
            !isNaN(sma21) &&
            !isNaN(sma50) &&
            sma21 > sma50 &&
            (isNaN(sma180) || sma21 > sma180); // skip 180-check if not enough history

          const newsAlign =
            (agg.sentiment === "bullish" && stat.direction === "up") ||
            (agg.sentiment === "bearish" && stat.direction === "down")
              ? 1
              : agg.sentiment === "neutral"
                ? 0
                : -1;

          const score =
            (stat.confidence - 50) * (0.6 + 0.8 * er) +
            Math.abs(snaps[ticker]?.changePct ?? 0) * 2 +
            newsAlign * 8 -
            (earn?.soon ? 6 : 0);

          const row: ScannerRow = {
            ticker,
            companyName: uni?.name ?? ticker,
            sector,
            price: snaps[ticker]?.price ?? 0,
            changePct: snaps[ticker]?.changePct ?? 0,
            score,
            direction: stat.direction,
            confidence: stat.confidence,
            newsSentiment: agg.sentiment,
            earningsSoon: !!earn?.soon,
            details: {
              rsi: Math.round(stat.rsi),
              efficiencyRatio: Number(er.toFixed(2)),
              netDriftPct: Number(stat.netDriftPct.toFixed(2)),
              volumeBias: Number(stat.volumeBias.toFixed(2)),
              newsCount: news.length,
              reasoning: stat.reasoning,
              maAlignment,
              sma21: isNaN(sma21) ? null : Number(sma21.toFixed(2)),
              sma50: isNaN(sma50) ? null : Number(sma50.toFixed(2)),
              sma180: isNaN(sma180) ? null : Number(sma180.toFixed(2)),
              dailyBarsCount: dailyCandles.length,
            },
            updatedAt: new Date().toISOString(),
          };
          rowMap.set(ticker, row);

          // Persist immediately so partial results are visible in the UI.
          await persistRow(row);
        } catch (err) {
          logger.warn({ err, ticker }, "[stock-scanner] deep scoring failed");
        } finally {
          progress.done++;
          progress.pct = Math.round((progress.done / progress.total) * 100);
        }
      }));
    }

    // Persist basic rows for non-shortlisted tickers (fast batch).
    const basicTickers = tickers.filter((t) => !shortlist.has(t));
    for (const ticker of basicTickers) {
      const row = rowMap.get(ticker);
      if (row) await persistRow(row).catch(() => {});
    }

    const rows = Array.from(rowMap.values());
    lastScanAt = Date.now();
    const scored = shortlistArr.length;
    progress = { scanning: false, phase: "done", total: shortlistArr.length, done: scored, currentTicker: "", pct: 100 };
    logger.info({ scanned: rows.length, scored }, "[stock-scanner] scan complete");

    // Fire-and-forget Claude research pass for the top-20 scored tickers.
    if (isAiFeatureEnabled("stock_research")) {
      const top20 = [...rows]
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map((r) => r.ticker);
      runResearchPass(top20).catch((err) =>
        logger.warn({ err }, "[stock-scanner] research pass error"),
      );
    }

    return { scanned: rows.length, scored };
  } finally {
    scanning = false;
    // Keep "done" phase visible for 30s after scan finishes.
    if (progress.phase !== "done") {
      progress = { scanning: false, phase: "idle", total: 0, done: 0, currentTicker: "", pct: 0 };
    }
    setTimeout(() => {
      if (!scanning) {
        progress = { scanning: false, phase: "idle", total: 0, done: 0, currentTicker: "", pct: 0 };
      }
    }, 30_000);
  }
}

async function persistRow(r: ScannerRow): Promise<void> {
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
