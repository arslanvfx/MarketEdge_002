// Market-wide tiered scanner. Ranks the ENTIRE pre-filtered US equity market
// (see market-universe.ts) for the best opportunities, in three tiers:
//
//   Tier 1 — fast technical screen of ALL candidates using fresh bulk
//            snapshots only (momentum, volume surge, spread) — no per-ticker
//            API calls.
//   Tier 2 — full candle + news + stat deep scoring for the top-150 Tier 1
//            tickers (+ watchlist, always included). Rows persist to
//            stock_scanner_results immediately for live partial progress.
//   Tier 3 — Claude + web research for the top-30 Tier 2 tickers, stored as
//            research reports (research.ts).
//
// Progress across all tiers is tracked in-memory and exposed via
// getScanProgress() so the UI can show a live pipeline indicator.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { isAiFeatureEnabled } from "../ai-spend";
import { alpacaConfigured, getSnapshots, getBars, getClock, type StockSnapshot } from "./alpaca";
import { getMarketUniverse, getUniverseStatus, type UniverseCandidate } from "./market-universe";
import { lookupUniverse } from "./universe";
import { statSignal } from "./ai";
import { getScoredNews, aggregateSentiment } from "./news";
import { getEarnings } from "./earnings";
import { efficiencyRatio, sma } from "./indicators";
import { watchlistTickers } from "./watchlist";
import { getConfig } from "./config";
import { runResearchPass, getResearchProgress, type ResearchTechContext } from "./research";
import type { Candle, Direction, ScannerRow, Sentiment } from "./types";

const DEEP_SCORE_LIMIT = 150; // Tier 1 → Tier 2 cut
const RESEARCH_LIMIT = 10;    // Tier 2 → Tier 3 cut (top 10 only — AI cost control)
const SCORE_BATCH = 5;        // concurrent deep-score requests
const SNAPSHOT_CHUNK = 500;   // symbols per snapshots call

let lastScanAt = 0;
let scanning = false;

export interface ScanProgress {
  scanning: boolean;
  phase: "idle" | "snapshots" | "screening" | "scoring" | "research" | "done";
  /** Tier 2 deep-scoring totals (kept as total/done/pct for UI compat). */
  total: number;
  done: number;
  currentTicker: string;
  pct: number; // 0-100 across the deep-scoring tier
  /** Tier 1: how many tickers were screened market-wide. */
  screened: number;
  /** Universe size the screen ran against. */
  universeSize: number;
  /** Tier 3 research progress. */
  researchTotal: number;
  researchDone: number;
  researchRunning: boolean;
}

const IDLE: ScanProgress = {
  scanning: false, phase: "idle", total: 0, done: 0, currentTicker: "", pct: 0,
  screened: 0, universeSize: 0, researchTotal: 0, researchDone: 0, researchRunning: false,
};

let progress: ScanProgress = { ...IDLE };

export function getScanProgress(): ScanProgress {
  const r = getResearchProgress();
  // The research tier runs in the background after the scan returns, so the
  // phase is derived from live research state rather than the stored value.
  const phase = !scanning && r.running ? "research" : progress.phase;
  return {
    ...progress,
    phase,
    researchTotal: r.total,
    researchDone: r.done,
    researchRunning: r.running,
    universeSize: progress.universeSize || getUniverseStatus().candidateCount,
  };
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

/** Tier 1 fast score from snapshot data only — no per-ticker API calls. */
function fastScore(s: StockSnapshot): number {
  const volSurge = s.prevVolume > 0 ? s.volume / s.prevVolume : 0;
  let score = Math.abs(s.changePct) * 2;          // momentum magnitude
  if (volSurge >= 2) score += 6;                  // strong volume surge
  else if (volSurge >= 1.3) score += 3;
  if (s.spreadPct != null && s.spreadPct < 0.15) score += 1; // very liquid
  return score;
}

export async function runScan(opts: { force?: boolean } = {}): Promise<{ scanned: number; scored: number }> {
  if (scanning) return { scanned: 0, scored: 0 };
  if (!alpacaConfigured()) {
    logger.info("[stock-scanner] skipped — Alpaca not configured");
    return { scanned: 0, scored: 0 };
  }
  scanning = true;
  progress = { ...IDLE, scanning: true, phase: "snapshots" };
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
          progress = { ...IDLE };
          return { scanned: 0, scored: 0 };
        }
      } catch (err) {
        logger.warn({ err }, "[stock-scanner] clock check failed — scanning anyway");
      }
    }

    // ── Tier 0: market-wide pre-filtered universe (4h cached) ────────────────
    const universe = await getMarketUniverse();
    const uniByTicker = new Map<string, UniverseCandidate>(universe.map((c) => [c.ticker, c]));
    const watch = new Set(await watchlistTickers());
    const tickers = Array.from(new Set([...universe.map((c) => c.ticker), ...watch]));
    progress.universeSize = tickers.length;

    // ── Tier 1: fresh bulk snapshots + fast screen ───────────────────────────
    progress.phase = "screening";
    const snaps: Record<string, StockSnapshot> = {};
    for (let i = 0; i < tickers.length; i += SNAPSHOT_CHUNK) {
      const chunk = tickers.slice(i, i + SNAPSHOT_CHUNK);
      try {
        Object.assign(snaps, await getSnapshots(chunk));
      } catch (err) {
        logger.warn({ err, chunkStart: i }, "[stock-scanner] snapshot chunk failed");
      }
      progress.screened = Math.min(tickers.length, i + chunk.length);
    }
    progress.screened = tickers.length;

    // Sector momentum = mean daily change across each known sector.
    const bySector = new Map<string, number[]>();
    for (const t of tickers) {
      const s = snaps[t];
      if (!s) continue;
      const sector = uniByTicker.get(t)?.sector ?? lookupUniverse(t)?.sector;
      if (!sector || sector === "Other") continue;
      const arr = bySector.get(sector) ?? [];
      arr.push(s.changePct);
      bySector.set(sector, arr);
    }
    for (const [sector, arr] of bySector) {
      sectorMomentum.set(sector, arr.reduce((a, b) => a + b, 0) / (arr.length || 1));
    }

    // Rank all screened tickers by fast score; watchlist always advances.
    const ranked = tickers
      .filter((t) => snaps[t])
      .map((t) => ({ ticker: t, fs: fastScore(snaps[t]) }))
      .sort((a, b) => b.fs - a.fs);
    const shortlist = new Set<string>(Array.from(watch).filter((t) => snaps[t]));
    for (const { ticker } of ranked) {
      if (shortlist.size >= DEEP_SCORE_LIMIT) break;
      shortlist.add(ticker);
    }

    // ── Tier 2: deep-score shortlist in parallel batches ────────────────────
    const shortlistArr = Array.from(shortlist);
    progress.phase = "scoring";
    progress.total = shortlistArr.length;

    const scoredRows: ScannerRow[] = [];

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
          const cand = uniByTicker.get(ticker);
          const sector = cand?.sector ?? lookupUniverse(ticker)?.sector ?? "Other";
          const companyName = cand?.name ?? lookupUniverse(ticker)?.name ?? ticker;
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

          const snap = snaps[ticker];
          const volumeSurge =
            snap && snap.prevVolume > 0 ? snap.volume / snap.prevVolume : null;

          const score =
            (stat.confidence - 50) * (0.6 + 0.8 * er) +
            Math.abs(snap?.changePct ?? 0) * 2 +
            newsAlign * 8 -
            (earn?.soon ? 6 : 0);

          const row: ScannerRow = {
            ticker,
            companyName,
            sector,
            price: snap?.price ?? 0,
            changePct: snap?.changePct ?? 0,
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
              volumeSurge: volumeSurge != null ? Number(volumeSurge.toFixed(2)) : null,
              dailyBarsCount: dailyCandles.length,
            },
            updatedAt: new Date().toISOString(),
          };
          scoredRows.push(row);

          // Persist immediately so partial results are visible in the UI.
          await persistRow(row);
        } catch (err) {
          logger.warn({ err, ticker }, "[stock-scanner] deep scoring failed");
        } finally {
          progress.done++;
          progress.pct = Math.round((progress.done / Math.max(1, progress.total)) * 100);
        }
      }));
    }

    // Drop stale rows so the results table always reflects the current market
    // view (the market-wide universe rotates tickers in and out daily).
    await db.execute(sql`
      DELETE FROM stock_scanner_results WHERE updated_at < NOW() - INTERVAL '24 hours'
    `).catch((err) => logger.warn({ err }, "[stock-scanner] stale-row cleanup failed"));

    lastScanAt = Date.now();
    const scored = scoredRows.length;
    progress.phase = "research";
    logger.info(
      { universe: tickers.length, screened: ranked.length, scored },
      "[stock-scanner] tiers 1-2 complete",
    );

    // ── Tier 3: Claude + web research for the top scored tickers ────────────
    if (isAiFeatureEnabled("stock_research")) {
      const top = [...scoredRows].sort((a, b) => b.score - a.score).slice(0, RESEARCH_LIMIT);
      const candidates = top.map((r) => {
        const snap = snaps[r.ticker];
        const d = (r.details ?? {}) as Record<string, any>;
        const ctx: ResearchTechContext = {
          price: r.price,
          changePct: r.changePct,
          rsi: typeof d.rsi === "number" ? d.rsi : null,
          sma21: d.sma21 ?? null,
          sma50: d.sma50 ?? null,
          sma180: d.sma180 ?? null,
          volumeSurge: d.volumeSurge ?? (snap && snap.prevVolume > 0 ? snap.volume / snap.prevVolume : null),
          sector: r.sector,
          companyName: r.companyName,
        };
        return { ticker: r.ticker, ctx };
      });
      // Fire-and-forget: research runs in the background after the scan returns.
      runResearchPass(candidates)
        .catch((err) => logger.warn({ err }, "[stock-scanner] research pass error"))
        .finally(() => {
          if (!scanning) progress.phase = "done";
        });
    }

    progress = {
      ...progress,
      scanning: false,
      phase: "done",
      currentTicker: "",
      pct: 100,
    };
    logger.info({ scanned: tickers.length, scored }, "[stock-scanner] scan complete");

    return { scanned: tickers.length, scored };
  } finally {
    scanning = false;
    // Keep "done" phase visible for 30s after scan finishes.
    if (progress.phase !== "done" && progress.phase !== "research") {
      progress = { ...IDLE };
    }
    setTimeout(() => {
      if (!scanning && !getResearchProgress().running) {
        progress = { ...IDLE };
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
