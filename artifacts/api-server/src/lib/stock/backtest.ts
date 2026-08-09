// Offline replay harness — NARROW SCOPE: stat-signal simulation only.
//
// Replays historical bars through statSignal() long entries with ATR-adaptive
// (or fixed) stops/targets and a simple slippage model. It deliberately does
// NOT reproduce the full live AI-off pipeline: no scanner/watchlist gates, no
// ML/news/macro/L1-L2 requirements, no shorts, no horizon selection, and no
// live exit behavior (trailing, EOD flat, max-hold days). Claude is not
// backtestable at all (no historical responses).
//
// Use it to compare RELATIVE stop/target/confidence variants for the core
// stat signal — not as sole evidence for live defaults. Config changes should
// additionally be validated in paper mode against the real pipeline.

import { getBars } from "./alpaca";
import { statSignal } from "./ai";
import { getConfig } from "./config";
import type { Candle } from "./types";

export interface BacktestParams {
  tickers: string[];
  /** Bar timeframe (default "15Min"). */
  timeframe?: string;
  /** Bars fetched per ticker (default 1000 ≈ 6 weeks of 15-min bars). */
  bars?: number;
  minConfidence?: number;
  atrStops?: boolean;
  atrStopMult?: number;
  atrTargetMult?: number;
  /** Fixed stop/target % (used when atrStops=false). */
  stopPct?: number;
  targetPct?: number;
  /** Entry slippage as % of price (default 0.05). */
  slippagePct?: number;
  /** Max bars a simulated position may be held (default 26 ≈ 1 session). */
  maxHoldBars?: number;
}

export interface BacktestTrade {
  ticker: string;
  entryIdx: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: "stop" | "target" | "max_hold" | "end_of_data";
  holdBars: number;
  returnPct: number;
  confidence: number;
}

export interface BacktestResult {
  params: Required<Omit<BacktestParams, "tickers">> & { tickers: string[] };
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgReturnPct: number | null;
  totalReturnPct: number;
  expectancyPct: number | null;
  maxDrawdownPct: number;
  avgHoldBars: number | null;
  byTicker: Record<string, { trades: number; wins: number; totalReturnPct: number }>;
  sample: BacktestTrade[];
}

const WARMUP = 30; // bars needed before the first signal

export async function runBacktest(p: BacktestParams): Promise<BacktestResult> {
  const cfg = getConfig();
  const params = {
    tickers: p.tickers.slice(0, 15),
    timeframe: p.timeframe ?? "15Min",
    bars: Math.min(2000, Math.max(100, p.bars ?? 1000)),
    minConfidence: p.minConfidence ?? cfg.minConfidence,
    atrStops: p.atrStops ?? (cfg.atrStops !== false),
    atrStopMult: p.atrStopMult ?? cfg.atrStopMult ?? 1.5,
    atrTargetMult: p.atrTargetMult ?? cfg.atrTargetMult ?? 3,
    stopPct: p.stopPct ?? cfg.stopLossPct,
    targetPct: p.targetPct ?? cfg.targetGainPct,
    slippagePct: p.slippagePct ?? 0.05,
    maxHoldBars: p.maxHoldBars ?? 26,
  };

  const trades: BacktestTrade[] = [];
  const byTicker: BacktestResult["byTicker"] = {};

  for (const ticker of params.tickers) {
    let candles: Candle[];
    try {
      candles = await getBars(ticker, params.timeframe, params.bars);
    } catch {
      continue; // ticker fetch failed — skip, don't poison the run
    }
    if (candles.length < WARMUP + 5) continue;

    let i = WARMUP;
    while (i < candles.length - 1) {
      const window = candles.slice(0, i + 1);
      const sig = statSignal(window.slice(-120));
      if (sig.direction !== "up" || sig.confidence < params.minConfidence) {
        i++;
        continue;
      }
      // Enter at next bar open + slippage.
      const entryPrice = candles[i + 1].o * (1 + params.slippagePct / 100);
      const stopDist = params.atrStops && sig.atrPct > 0
        ? Math.min(12, Math.max(0.75, sig.atrPct * params.atrStopMult))
        : params.stopPct;
      const targetDist = params.atrStops && sig.atrPct > 0
        ? Math.min(25, Math.max(1.5, sig.atrPct * params.atrTargetMult))
        : params.targetPct;
      const stopPrice = entryPrice * (1 - stopDist / 100);
      const targetPrice = entryPrice * (1 + targetDist / 100);

      let exitPrice = candles[candles.length - 1].c;
      let exitReason: BacktestTrade["exitReason"] = "end_of_data";
      let holdBars = candles.length - 1 - (i + 1);
      for (let j = i + 1; j < Math.min(candles.length, i + 1 + params.maxHoldBars); j++) {
        const bar = candles[j];
        // Pessimistic: stop checked before target within the same bar.
        if (bar.l <= stopPrice) {
          exitPrice = stopPrice * (1 - params.slippagePct / 100);
          exitReason = "stop";
          holdBars = j - (i + 1);
          break;
        }
        if (bar.h >= targetPrice) {
          exitPrice = targetPrice * (1 - params.slippagePct / 100);
          exitReason = "target";
          holdBars = j - (i + 1);
          break;
        }
        if (j === i + params.maxHoldBars) {
          exitPrice = bar.c * (1 - params.slippagePct / 100);
          exitReason = "max_hold";
          holdBars = j - (i + 1);
        }
      }

      const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
      trades.push({
        ticker, entryIdx: i + 1, entryPrice, exitPrice, exitReason,
        holdBars, returnPct, confidence: sig.confidence,
      });
      const bt = byTicker[ticker] ?? { trades: 0, wins: 0, totalReturnPct: 0 };
      bt.trades++;
      if (returnPct > 0) bt.wins++;
      bt.totalReturnPct += returnPct;
      byTicker[ticker] = bt;

      // Resume scanning after the position closed (no overlapping positions per ticker).
      i = i + 1 + Math.max(1, holdBars) + 1;
    }
  }

  const wins = trades.filter((t) => t.returnPct > 0).length;
  const losses = trades.length - wins;
  const totalReturnPct = trades.reduce((s, t) => s + t.returnPct, 0);
  const avgReturnPct = trades.length ? totalReturnPct / trades.length : null;

  // Max drawdown on the cumulative return curve (in return-% terms).
  let cum = 0, peak = 0, maxDd = 0;
  for (const t of trades) {
    cum += t.returnPct;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }

  const round = (v: number | null, d = 3) => (v == null ? null : parseFloat(v.toFixed(d)));
  return {
    params,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length ? round(wins / trades.length) : null,
    avgReturnPct: round(avgReturnPct),
    totalReturnPct: round(totalReturnPct)!,
    expectancyPct: round(avgReturnPct),
    maxDrawdownPct: round(maxDd)!,
    avgHoldBars: trades.length ? round(trades.reduce((s, t) => s + t.holdBars, 0) / trades.length, 1) : null,
    byTicker: Object.fromEntries(
      Object.entries(byTicker).map(([k, v]) => [k, { ...v, totalReturnPct: round(v.totalReturnPct)! }]),
    ),
    sample: trades.slice(-25),
  };
}
