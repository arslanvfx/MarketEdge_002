// ---------------------------------------------------------------------------
// Accuracy backtest harness for the STATISTICAL prediction model.
//
// Replays historical 1-min candles over many past 15-min windows, runs the
// exact live model (analyzeCoinAt) at each window open, and scores the
// prediction against the actual settlement price 15 minutes later. Results are
// bucketed by market regime (trending / drifting / choppy / spike, via the
// efficiency ratio) and by stated confidence band, and reported with hit rate,
// directional accuracy, error, and a Brier score.
//
// "Hit" mirrors the live Kalshi rule: a 15-min binary settles ABOVE or BELOW
// the window-open price. We use the window-open price as the synthetic strike
// (Kalshi sets its strike to the RTI at window open), so a hit = the model
// predicted the correct side of where price opened.
//
// Claude is NOT backtested: its prompt needs the live order book and ticker,
// which cannot be reconstructed historically. Claude is evaluated via the live
// accuracy log instead.
//
// ── How to run ──────────────────────────────────────────────────────────────
//   curl "$REPLIT_DEV_DOMAIN/api/crypto/backtest?windows=48"            # all coins
//   curl "$REPLIT_DEV_DOMAIN/api/crypto/backtest?coins=BTC,ETH&windows=96"
//   (locally on the API server: curl "http://localhost:8080/crypto/backtest?...")
// Each run also logs a formatted console summary to the server logs.
//
// ── How to compare two runs (before vs after a model change) ─────────────────
//   1. Pin the SAME window set on both runs by passing endTime (ISO):
//        curl ".../crypto/backtest?windows=96&endTime=2026-06-26T12:00:00Z" -o before.json
//      ...change the model, restart, then:
//        curl ".../crypto/backtest?windows=96&endTime=2026-06-26T12:00:00Z" -o after.json
//   2. POST both reports to get the deltas:
//        curl -X POST ".../crypto/backtest/compare" -H 'content-type: application/json' \
//             -d "{\"a\": $(cat before.json), \"b\": $(cat after.json)}"
//
// ── Threshold analysis ────────────────────────────────────────────────────────
//   curl "$REPLIT_DEV_DOMAIN/api/crypto/backtest/threshold-analysis?windows=96"
//   Returns hit rates bucketed by pre-window efficiency ratio (0.05 steps) so
//   you can see whether the hardcoded BET/STAY-AWAY ER thresholds in
//   computeWindowBetSignal still have real edge. Also suggests data-derived
//   thresholds. Run automatically once daily and logged to server output.
// ---------------------------------------------------------------------------

import {
  CRYPTO_COINS,
  isPythProduct,
  analyzeCoinAt,
  intraWindowMetrics,
  computeWindowBetSignal,
  type Candle,
  type CoinDef,
} from "./crypto";
import { extractMLFeatures } from "./ml-features.ts";
import { type MLTrainingExample } from "./ml-store.ts";
import { logger } from "./logger";

const COINBASE = "https://api.exchange.coinbase.com";
const UA = "MarketEdge/1.0 (crypto-backtest)";

const WINDOW_SEC = 15 * 60;
const LOOKBACK_SEC = 90 * 60; // candles fed to the model before each window open
const MAX_CANDLES_PER_REQ = 300; // Coinbase hard limit
const MIN_INPUT_CANDLES = 30; // need enough history for the indicators

// These mirror the live thresholds in computeWindowBetSignal. Keep in sync
// when updating crypto.ts — the analysis uses them to label each bucket.
const BET_ER_THRESHOLD        = 0.30; // preWindowER >= this → "bet zone"
const STAY_AWAY_ER_THRESHOLD  = 0.25; // preWindowER <  this → "stay_away zone"

export type Regime = "trending" | "drifting" | "choppy" | "spike";

export interface MetricSummary {
  windows: number;
  hits: number;
  hitRatePct: number | null;
  dirHits: number;
  dirAccPct: number | null;
  avgAbsErrPct: number | null;
  avgSignedErrPct: number | null;
  brier: number | null;
}

export interface CalibrationBin {
  band: string;
  windows: number;
  avgConfidencePct: number | null;
  hitRatePct: number | null;
}

export type BetSignalRec = "bet" | "caution" | "stay_away";

export interface BetSignalSummary extends MetricSummary {
  recommendation: BetSignalRec;
  pct: number | null; // fraction of all windows that fell in this bucket
}

export interface BacktestReport {
  generatedAt: string;
  note: string;
  params: {
    coins: string[];
    windows: number;
    firstWindowOpen: string | null;
    lastWindowOpen: string | null;
  };
  overall: MetricSummary;
  byCoin: Record<string, MetricSummary>;
  byRegime: Record<Regime, MetricSummary>;
  calibration: CalibrationBin[];
  byBetSignal: Record<BetSignalRec, BetSignalSummary>;
  errors?: Record<string, string>;
}

/** One 0.05-wide pre-window efficiency-ratio bucket. */
export interface ThresholdBucket {
  erLo: number;   // inclusive lower bound  (e.g. 0.25)
  erHi: number;   // exclusive upper bound  (e.g. 0.30)
  label: string;  // human label "0.25–0.30"
  windows: number;
  hitRatePct: number | null;
  /** What the current hardcoded thresholds assign to this ER band. */
  currentSignal: BetSignalRec;
}

/**
 * Returned by runThresholdAnalysis.
 * Shows hit rates per 0.05-wide ER band so the operator can see whether the
 * hardcoded BET/STAY-AWAY ER thresholds still reflect reality, and what
 * data-derived thresholds would look like.
 */
export interface ThresholdAnalysisReport {
  generatedAt: string;
  params: BacktestReport["params"];
  /** The ER thresholds currently hardcoded in computeWindowBetSignal. */
  currentThresholds: {
    betER: number;
    stayAwayER: number;
  };
  /**
   * Data-derived suggestion: the lowest ER threshold where windows with
   * preWindowER >= threshold hit >= 55% (minimum 20 samples).
   * null = not enough data or no qualifying threshold found.
   */
  suggestedBetER: number | null;
  /**
   * Data-derived suggestion: the highest ER threshold where windows with
   * preWindowER < threshold hit <= 45% (minimum 20 samples).
   * null = not enough data or no qualifying threshold found.
   */
  suggestedStayAwayER: number | null;
  /** Hit rates for windows in the current bet zone (preWindowER >= betER). */
  currentBetZoneHitRatePct: number | null;
  /** Hit rates for windows in the current stay_away zone (preWindowER < stayAwayER). */
  currentStayAwayZoneHitRatePct: number | null;
  buckets: ThresholdBucket[];
  overallHitRatePct: number | null;
  note: string;
  errors?: Record<string, string>;
}

export interface BacktestOpts {
  coins?: string[];
  windows?: number;
  endTime?: number; // unix seconds; pin the window set for reproducible compares
}

interface WindowResult {
  symbol: string;
  regime: Regime;
  confidence: number;
  hit: boolean;
  dirHit: boolean;
  absErrPct: number;
  signedErrPct: number;
  pAbove: number; // probability mass the model put on "above" (for Brier)
  actualAbove: boolean;
  betSignal: BetSignalRec;
  preWindowER: number; // 90-min pre-window efficiency ratio (from analyzeCoinAt)
  mlFeatures: number[];  // 14-dim feature vector at simulated snap time (elapsed=0.05, priceAtOpen=openPrice)
  windowIso: string;     // ISO timestamp of window open — used as backfill windowId
}

// Confidence bands aligned to the model's clamp range (20–92).
const CONF_BANDS: Array<{ band: string; lo: number; hi: number }> = [
  { band: "20-39%", lo: 0, hi: 40 },
  { band: "40-54%", lo: 40, hi: 55 },
  { band: "55-69%", lo: 55, hi: 70 },
  { band: "70-92%", lo: 70, hi: 101 },
];

// Pre-window ER bucket boundaries (0.00, 0.05, 0.10, … 0.95, 1.00).
const ER_STEP = 0.05;
const ER_N_BUCKETS = 20;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
function clampInt(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(x)));
}

function classifyRegime(ind: { efficiencyRatio: number; spikeFlag: boolean }): Regime {
  if (ind.spikeFlag) return "spike";
  if (ind.efficiencyRatio >= 0.55) return "trending";
  if (ind.efficiencyRatio >= 0.25) return "drifting";
  return "choppy";
}

// Paginated 1-min candle fetch over [startSec, endSec]. Coinbase returns at
// most 300 candles per request, newest-first; we walk backwards in chunks.
async function fetchCandlesRange(
  product: string,
  startSec: number,
  endSec: number,
): Promise<Candle[]> {
  // Commodity products: Pyth Benchmarks serves arbitrary ranges in one call
  // (no 300-candle pagination limit like Coinbase).
  if (isPythProduct(product)) {
    const sym = product.slice(5);
    const res = await fetch(
      `https://benchmarks.pyth.network/v1/shims/tradingview/history` +
        `?symbol=${encodeURIComponent(sym)}&resolution=1&from=${startSec}&to=${endSec}`,
      { headers: { "User-Agent": UA, Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`Pyth Benchmarks ${res.status} for ${product}`);
    const body = (await res.json()) as {
      s: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; v?: number[];
    };
    if (body.s !== "ok" || !body.t?.length) return [];
    return body.t
      .map((t, i) => ({ t, o: body.o![i], h: body.h![i], l: body.l![i], c: body.c![i], v: body.v?.[i] ?? 0 }))
      .sort((a, b) => a.t - b.t);
  }
  const out: Candle[] = [];
  let cursorEnd = endSec;
  let guard = 0;
  while (cursorEnd > startSec && guard < 60) {
    guard++;
    const cursorStart = Math.max(startSec, cursorEnd - MAX_CANDLES_PER_REQ * 60);
    const url =
      `${COINBASE}/products/${product}/candles?granularity=60` +
      `&start=${new Date(cursorStart * 1000).toISOString()}` +
      `&end=${new Date(cursorEnd * 1000).toISOString()}`;
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Coinbase ${res.status} for ${product}`);
    const raw = (await res.json()) as number[][];
    for (const r of raw) out.push({ t: r[0], l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] });
    cursorEnd = cursorStart;
    await new Promise((r) => setTimeout(r, 150)); // be gentle on the public API
  }
  // Dedupe by start time, sort oldest-first.
  const byT = new Map<number, Candle>();
  for (const c of out) byT.set(c.t, c);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

function aggregate(results: WindowResult[]): MetricSummary {
  const n = results.length;
  if (n === 0) {
    return {
      windows: 0,
      hits: 0,
      hitRatePct: null,
      dirHits: 0,
      dirAccPct: null,
      avgAbsErrPct: null,
      avgSignedErrPct: null,
      brier: null,
    };
  }
  const hits = results.filter((r) => r.hit).length;
  const dirHits = results.filter((r) => r.dirHit).length;
  return {
    windows: n,
    hits,
    hitRatePct: round1((hits / n) * 100),
    dirHits,
    dirAccPct: round1((dirHits / n) * 100),
    avgAbsErrPct: round3(mean(results.map((r) => r.absErrPct))),
    avgSignedErrPct: round3(mean(results.map((r) => r.signedErrPct))),
    brier: round3(mean(results.map((r) => (r.pAbove - (r.actualAbove ? 1 : 0)) ** 2))),
  };
}

async function backtestCoin(
  coin: CoinDef,
  firstOpen: number,
  lastSettleableOpen: number,
): Promise<WindowResult[]> {
  const fetchStart = firstOpen - LOOKBACK_SEC;
  const fetchEnd = lastSettleableOpen + WINDOW_SEC + 60;
  const candles = await fetchCandlesRange(coin.product, fetchStart, fetchEnd);
  const byT = new Map(candles.map((c) => [c.t, c]));
  const results: WindowResult[] = [];

  for (let open = firstOpen; open <= lastSettleableOpen; open += WINDOW_SEC) {
    const openCandle = byT.get(open);
    const settleCandle = byT.get(open + WINDOW_SEC);
    if (!openCandle || !settleCandle) continue; // gap in data — skip window

    const input = candles.filter((c) => c.t < open && c.t >= open - LOOKBACK_SEC);
    if (input.length < MIN_INPUT_CANDLES) continue;

    const openPrice = openCandle.o; // price at window open = synthetic strike
    const settlePrice = settleCandle.o; // price at window close (+15 min)

    const cp = analyzeCoinAt(coin, input, openPrice, new Date(open * 1000));
    const pred = cp.predictions[0];
    if (!pred) continue;

    const predictedAbove = pred.predictedPrice >= openPrice;
    const actualAbove = settlePrice >= openPrice;
    const dirActual: "up" | "down" | "flat" =
      settlePrice > openPrice * 1.0002 ? "up"
      : settlePrice < openPrice * 0.9998 ? "down"
      : "flat";

    // Bet signal: simulate what computeWindowBetSignal would have returned at t=5.
    // Grab the first 5 candles inside the window (open ≤ t < open+5min).
    const firstFive = candles
      .filter((c) => c.t >= open && c.t < open + 5 * 60)
      .sort((a, b) => a.t - b.t)
      .slice(0, 5);
    let betSignal: BetSignalRec = "caution";
    if (firstFive.length >= 3) {
      const iwm = intraWindowMetrics(firstFive, 5);
      const sig = computeWindowBetSignal(
        {
          efficiencyRatio: iwm.efficiencyRatio,
          oscillationCount: iwm.oscillationCount,
          spikeFlag: iwm.spikeFlag,
          netDriftPct: iwm.netDriftPct,
          // Pre-window regime from analyzeCoinAt (90-min lookback) — primary signal.
          preWindowER: cp.indicators.efficiencyRatio,
          preWindowSpikeFlag: cp.indicators.spikeFlag,
        },
        5, // minutesElapsed = 5 so the function treats this as a settled signal
      );
      if (sig.ready) betSignal = sig.recommendation;
    }

    // Use a mid-window candle (~T+7min, elapsed≈0.47) so training features have
    // real variance in priceVsStrike, aboveStrike and windowPriceDrift.
    // Without this, all 96 backfill examples have those features ≈ 0 (degenerate)
    // and the model can't react to intra-window price moves in live inference.
    const SNAP_OFFSET_SEC = 7 * 60; // T+7min
    const midT = open + SNAP_OFFSET_SEC;
    // Tolerant lookup: try exact tick, then ±1 minute.
    const midCandle = byT.get(midT) ?? byT.get(midT + 60) ?? byT.get(midT - 60);
    const snapPrice   = midCandle ? midCandle.c : openPrice;
    const snapElapsed = midCandle ? SNAP_OFFSET_SEC / WINDOW_SEC : 0.05;
    // Synthetic snapshot: pre-window regime indicators + actual mid-window price.
    // Mirrors live inference where indicators roll over the 90-min history but
    // price is the live feed.
    const cpSnap = { ...cp, price: snapPrice };
    const mlFeatures = extractMLFeatures(cpSnap, openPrice, snapElapsed, openPrice);

    results.push({
      symbol: coin.symbol,
      regime: classifyRegime(cp.indicators),
      confidence: pred.confidence,
      hit: predictedAbove === actualAbove,
      dirHit: pred.direction === dirActual,
      absErrPct: Math.abs((settlePrice - pred.predictedPrice) / pred.predictedPrice) * 100,
      signedErrPct: ((pred.predictedPrice - settlePrice) / settlePrice) * 100,
      pAbove: predictedAbove ? pred.confidence / 100 : 1 - pred.confidence / 100,
      actualAbove,
      betSignal,
      preWindowER: cp.indicators.efficiencyRatio,
      mlFeatures,
      windowIso: new Date(open * 1000).toISOString(),
    });
  }
  return results;
}

// ── Shared internal runner ────────────────────────────────────────────────────

interface RawBacktestData {
  results: WindowResult[];
  errors: Record<string, string>;
  coinDefs: CoinDef[];
  firstOpen: number;
  lastSettleableOpen: number;
}

async function runRawBacktest(opts: BacktestOpts): Promise<RawBacktestData> {
  const windows = clampInt(opts.windows ?? 48, 1, 480);
  const coinDefs =
    opts.coins && opts.coins.length > 0
      ? CRYPTO_COINS.filter((c) => opts.coins!.includes(c.symbol))
      : CRYPTO_COINS;

  const nowSec = Math.floor(opts.endTime ?? Date.now() / 1000);
  const lastBoundary = Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
  const lastSettleableOpen = lastBoundary - WINDOW_SEC;
  const firstOpen = lastSettleableOpen - (windows - 1) * WINDOW_SEC;

  const results: WindowResult[] = [];
  const errors: Record<string, string> = {};

  for (const coin of coinDefs) {
    try {
      const res = await backtestCoin(coin, firstOpen, lastSettleableOpen);
      results.push(...res);
    } catch (err) {
      errors[coin.symbol] = err instanceof Error ? err.message : String(err);
      logger.warn({ err, symbol: coin.symbol }, "[backtest] coin failed");
    }
  }

  return { results, errors, coinDefs, firstOpen, lastSettleableOpen };
}

// ── Public: standard backtest report ─────────────────────────────────────────

export async function runBacktest(opts: BacktestOpts = {}): Promise<BacktestReport> {
  const { results, errors, coinDefs, firstOpen, lastSettleableOpen } =
    await runRawBacktest(opts);

  const byCoin: Record<string, MetricSummary> = {};
  for (const coin of coinDefs) {
    byCoin[coin.symbol] = aggregate(results.filter((r) => r.symbol === coin.symbol));
  }

  const byRegime = {
    trending: aggregate(results.filter((r) => r.regime === "trending")),
    drifting: aggregate(results.filter((r) => r.regime === "drifting")),
    choppy: aggregate(results.filter((r) => r.regime === "choppy")),
    spike: aggregate(results.filter((r) => r.regime === "spike")),
  } satisfies Record<Regime, MetricSummary>;

  const calibration: CalibrationBin[] = CONF_BANDS.map(({ band, lo, hi }) => {
    const bin = results.filter((r) => r.confidence >= lo && r.confidence < hi);
    return {
      band,
      windows: bin.length,
      avgConfidencePct: bin.length > 0 ? round1(mean(bin.map((r) => r.confidence))) : null,
      hitRatePct: bin.length > 0 ? round1((bin.filter((r) => r.hit).length / bin.length) * 100) : null,
    };
  });

  const totalWindows = results.length;
  const makeBetSummary = (rec: BetSignalRec): BetSignalSummary => {
    const bin = results.filter((r) => r.betSignal === rec);
    const base = aggregate(bin);
    return {
      ...base,
      recommendation: rec,
      pct: totalWindows > 0 ? round1((bin.length / totalWindows) * 100) : null,
    };
  };
  const byBetSignal: Record<BetSignalRec, BetSignalSummary> = {
    bet: makeBetSummary("bet"),
    caution: makeBetSummary("caution"),
    stay_away: makeBetSummary("stay_away"),
  };

  const report: BacktestReport = {
    generatedAt: new Date().toISOString(),
    note:
      "Statistical model only. 'Hit' = predicted the correct side of the window-open price " +
      "(synthetic Kalshi strike). Settlement = price 15 min after each window open.",
    params: {
      coins: coinDefs.map((c) => c.symbol),
      windows: clampInt(opts.windows ?? 48, 1, 480),
      firstWindowOpen: results.length > 0 ? new Date(firstOpen * 1000).toISOString() : null,
      lastWindowOpen: results.length > 0 ? new Date(lastSettleableOpen * 1000).toISOString() : null,
    },
    overall: aggregate(results),
    byCoin,
    byRegime,
    calibration,
    byBetSignal,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };

  logger.info({ summary: formatReport(report) }, "[backtest] complete");
  return report;
}

// ── Public: ML training example generation ───────────────────────────────────

/**
 * Run a backtest and return labeled training examples suitable for backfilling
 * the ML model.  Each example has the 14-feature vector computed at simulated
 * snap time (elapsed=0.05, priceAtOpen=openPrice) and the actual outcome.
 *
 * Use this when the model resets (e.g. after a feature version bump) to avoid
 * waiting 30+ live windows before predictions resume.
 */
export async function generateMLTrainingExamples(
  opts: BacktestOpts = {},
): Promise<MLTrainingExample[]> {
  const { results } = await runRawBacktest(opts);
  return results.map((r) => ({
    symbol: r.symbol,
    // v3 prefix: distinguishes 17-feature (stat+claude aware) from the old v2
    // 14-feature backfill that had no knowledge of other model signals.
    windowId: `backfill_v3:${r.symbol}:${r.windowIso}`,
    features: r.mlFeatures,
    outcome: r.actualAbove ? 1 : 0,
    elapsedFraction: 7 / 15, // ~0.47 — matches SNAP_OFFSET_SEC / WINDOW_SEC
  }));
}

// ── Public: threshold analysis ────────────────────────────────────────────────

function buildThresholdBuckets(results: WindowResult[]): ThresholdBucket[] {
  const buckets: ThresholdBucket[] = [];
  for (let i = 0; i < ER_N_BUCKETS; i++) {
    const erLo = round2(i * ER_STEP);
    const erHi = round2((i + 1) * ER_STEP);
    const bin = results.filter((r) => r.preWindowER >= erLo && r.preWindowER < erHi);
    const hits = bin.filter((r) => r.hit).length;
    const currentSignal: BetSignalRec =
      erLo >= BET_ER_THRESHOLD ? "bet"
      : erHi <= STAY_AWAY_ER_THRESHOLD ? "stay_away"
      : "caution";
    buckets.push({
      erLo,
      erHi,
      label: `${erLo.toFixed(2)}–${erHi.toFixed(2)}`,
      windows: bin.length,
      hitRatePct: bin.length > 0 ? round1((hits / bin.length) * 100) : null,
      currentSignal,
    });
  }
  return buckets;
}

function deriveThresholds(results: WindowResult[]): {
  suggestedBetER: number | null;
  suggestedStayAwayER: number | null;
} {
  const MIN_SAMPLES = 20;
  const BET_TARGET = 55.0;
  const STAY_TARGET = 45.0;

  // suggestedBetER: lowest ER cutoff where windows with preWindowER >= cutoff
  // have hit rate >= BET_TARGET and at least MIN_SAMPLES windows.
  let suggestedBetER: number | null = null;
  for (let i = 0; i < ER_N_BUCKETS; i++) {
    const er = round2(i * ER_STEP);
    const above = results.filter((r) => r.preWindowER >= er);
    if (above.length < MIN_SAMPLES) continue;
    const hr = (above.filter((r) => r.hit).length / above.length) * 100;
    if (hr >= BET_TARGET) {
      suggestedBetER = er;
      break; // take the most inclusive (lowest) qualifying threshold
    }
  }

  // suggestedStayAwayER: highest ER cutoff where windows with preWindowER < cutoff
  // have hit rate <= STAY_TARGET and at least MIN_SAMPLES windows.
  let suggestedStayAwayER: number | null = null;
  for (let i = Math.floor(ER_N_BUCKETS / 2); i > 0; i--) {
    const er = round2(i * ER_STEP);
    const below = results.filter((r) => r.preWindowER < er);
    if (below.length < MIN_SAMPLES) continue;
    const hr = (below.filter((r) => r.hit).length / below.length) * 100;
    if (hr <= STAY_TARGET) {
      suggestedStayAwayER = er;
      break; // take the most inclusive (highest) qualifying threshold
    }
  }

  return { suggestedBetER, suggestedStayAwayER };
}

/**
 * Run a full backtest and produce a threshold analysis report that shows
 * hit rates per 0.05-wide ER band. Use this to check whether the hardcoded
 * BET/STAY-AWAY thresholds in computeWindowBetSignal still have real edge,
 * and to derive data-driven threshold suggestions.
 */
export async function runThresholdAnalysis(
  opts: BacktestOpts = {},
): Promise<ThresholdAnalysisReport> {
  const { results, errors, coinDefs, firstOpen, lastSettleableOpen } =
    await runRawBacktest(opts);

  const buckets = buildThresholdBuckets(results);
  const { suggestedBetER, suggestedStayAwayER } = deriveThresholds(results);

  const overall = aggregate(results);

  // Current zone hit rates (for quick comparison with suggestions).
  const betZone = results.filter((r) => r.preWindowER >= BET_ER_THRESHOLD);
  const stayZone = results.filter((r) => r.preWindowER < STAY_AWAY_ER_THRESHOLD);
  const hrBet  = betZone.length  > 0 ? round1((betZone.filter((r)  => r.hit).length  / betZone.length)  * 100) : null;
  const hrStay = stayZone.length > 0 ? round1((stayZone.filter((r) => r.hit).length / stayZone.length) * 100) : null;

  const report: ThresholdAnalysisReport = {
    generatedAt: new Date().toISOString(),
    params: {
      coins: coinDefs.map((c) => c.symbol),
      windows: clampInt(opts.windows ?? 48, 1, 480),
      firstWindowOpen: results.length > 0 ? new Date(firstOpen * 1000).toISOString() : null,
      lastWindowOpen:  results.length > 0 ? new Date(lastSettleableOpen * 1000).toISOString() : null,
    },
    currentThresholds: {
      betER: BET_ER_THRESHOLD,
      stayAwayER: STAY_AWAY_ER_THRESHOLD,
    },
    suggestedBetER,
    suggestedStayAwayER,
    currentBetZoneHitRatePct: hrBet,
    currentStayAwayZoneHitRatePct: hrStay,
    buckets,
    overallHitRatePct: overall.hitRatePct,
    note:
      "suggestedBetER = lowest ER threshold where preWindowER>=er gives ≥55% hit rate (≥20 samples). " +
      "suggestedStayAwayER = highest ER threshold where preWindowER<er gives ≤45% hit rate (≥20 samples). " +
      "Update BET_ER_THRESHOLD / STAY_AWAY_ER_THRESHOLD in backtest.ts and crypto.ts when suggestions diverge meaningfully.",
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };

  logger.info({ summary: formatThresholdReport(report) }, "[threshold-analysis] complete");
  return report;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function pct(x: number | null): string {
  return x === null ? "  n/a" : `${x.toFixed(1)}%`.padStart(6);
}

// Compact, log-friendly multi-line summary.
export function formatReport(r: BacktestReport): string {
  const o = r.overall;
  const lines: string[] = [];
  lines.push(
    `BACKTEST ${r.params.coins.join(",")} | ${o.windows} windows | hit ${pct(o.hitRatePct)} | dir ${pct(o.dirAccPct)} | absErr ${o.avgAbsErrPct ?? "n/a"}% | brier ${o.brier ?? "n/a"}`,
  );
  lines.push("  by regime:");
  for (const reg of ["trending", "drifting", "choppy", "spike"] as Regime[]) {
    const m = r.byRegime[reg];
    lines.push(`    ${reg.padEnd(9)} n=${String(m.windows).padStart(4)}  hit ${pct(m.hitRatePct)}  dir ${pct(m.dirAccPct)}`);
  }
  lines.push("  calibration (stated conf → actual hit rate):");
  for (const c of r.calibration) {
    lines.push(`    ${c.band.padEnd(8)} n=${String(c.windows).padStart(4)}  actual ${pct(c.hitRatePct)}`);
  }
  lines.push("  bet signal (t=5 recommendation → actual hit rate):");
  for (const rec of ["bet", "caution", "stay_away"] as BetSignalRec[]) {
    const s = r.byBetSignal[rec];
    lines.push(
      `    ${rec.padEnd(10)} n=${String(s.windows).padStart(4)} (${String(s.pct ?? "n/a").padStart(4)}% of windows)  hit ${pct(s.hitRatePct)}  dir ${pct(s.dirAccPct)}`,
    );
  }
  return lines.join("\n");
}

/** Compact log-friendly summary of a threshold analysis run. */
export function formatThresholdReport(r: ThresholdAnalysisReport): string {
  const lines: string[] = [];
  lines.push(
    `THRESHOLD-ANALYSIS ${r.params.coins.join(",")} | ${r.params.windows} windows | overall hit ${pct(r.overallHitRatePct)}`,
  );
  lines.push(
    `  current thresholds: betER≥${r.currentThresholds.betER} → hit ${pct(r.currentBetZoneHitRatePct)} | ` +
    `stayAwayER<${r.currentThresholds.stayAwayER} → hit ${pct(r.currentStayAwayZoneHitRatePct)}`,
  );
  lines.push(
    `  suggested thresholds: betER=${r.suggestedBetER ?? "n/a"} stayAwayER=${r.suggestedStayAwayER ?? "n/a"}`,
  );
  lines.push("  ER buckets (preWindowER → hit rate):");
  for (const b of r.buckets) {
    if (b.windows === 0) continue; // skip empty buckets
    const marker =
      b.currentSignal === "bet" ? " [BET]"
      : b.currentSignal === "stay_away" ? " [STAY]"
      : "";
    lines.push(
      `    ${b.label.padEnd(10)} n=${String(b.windows).padStart(4)}  hit ${pct(b.hitRatePct)}${marker}`,
    );
  }
  return lines.join("\n");
}

// Diff two reports (before vs after a model change). Positive deltas on hit
// rate / directional accuracy are improvements; negative deltas on absErr and
// Brier are improvements.
export function compareReports(a: BacktestReport, b: BacktestReport) {
  const delta = (x?: number | null, y?: number | null) =>
    x == null || y == null ? null : round3(y - x);

  const cmp = (m1: MetricSummary, m2: MetricSummary) => ({
    windows: { before: m1.windows, after: m2.windows },
    hitRatePct: { before: m1.hitRatePct, after: m2.hitRatePct, delta: delta(m1.hitRatePct, m2.hitRatePct) },
    dirAccPct: { before: m1.dirAccPct, after: m2.dirAccPct, delta: delta(m1.dirAccPct, m2.dirAccPct) },
    avgAbsErrPct: { before: m1.avgAbsErrPct, after: m2.avgAbsErrPct, delta: delta(m1.avgAbsErrPct, m2.avgAbsErrPct) },
    brier: { before: m1.brier, after: m2.brier, delta: delta(m1.brier, m2.brier) },
  });

  const regimes: Regime[] = ["trending", "drifting", "choppy", "spike"];
  const byRegime: Record<string, ReturnType<typeof cmp>> = {};
  for (const reg of regimes) byRegime[reg] = cmp(a.byRegime[reg], b.byRegime[reg]);

  const coins = [...new Set([...Object.keys(a.byCoin), ...Object.keys(b.byCoin)])];
  const byCoin: Record<string, ReturnType<typeof cmp>> = {};
  for (const sym of coins) {
    if (a.byCoin[sym] && b.byCoin[sym]) byCoin[sym] = cmp(a.byCoin[sym], b.byCoin[sym]);
  }

  const betRecs: BetSignalRec[] = ["bet", "caution", "stay_away"];
  const byBetSignal: Record<string, ReturnType<typeof cmp>> = {};
  for (const rec of betRecs) {
    if (a.byBetSignal?.[rec] && b.byBetSignal?.[rec]) {
      byBetSignal[rec] = cmp(a.byBetSignal[rec], b.byBetSignal[rec]);
    }
  }

  return {
    note: "delta = after - before. Higher hit/dir = better; lower absErr/brier = better.",
    before: { generatedAt: a.generatedAt, params: a.params },
    after: { generatedAt: b.generatedAt, params: b.params },
    overall: cmp(a.overall, b.overall),
    byRegime,
    byCoin,
    byBetSignal,
  };
}
