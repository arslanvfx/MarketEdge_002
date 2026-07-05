// ---------------------------------------------------------------------------
// crypto-stat.ts — statistical prediction model + prompt helpers
// ---------------------------------------------------------------------------

import {
  type Candle, type OrderBook,
  mean, stddev, sma, ema, rsi, bollingerBands, atr,
  intraWindowMetrics, linReg, clamp, normCdf, vwap,
  priceDp, obBucket, formatOrderBook,
} from "./crypto-indicators";
import {
  type CoinDef, type CoinStats, type CoinPrediction, type Prediction,
} from "./crypto-data";

// ---------------------------------------------------------------------------
// Market regime derived from the intra-window efficiency ratio
// ---------------------------------------------------------------------------
export type PromptRegime = "trending" | "drifting" | "choppy";

export function regimeFromER(er: number): PromptRegime {
  if (er >= 0.55) return "trending";
  if (er >= 0.25) return "drifting";
  return "choppy";
}

// Format the intra-window momentum metrics as a prompt block for Claude.
export function intraWindowBlock(ind: CoinPrediction["indicators"]): string {
  const er = ind.efficiencyRatio;
  const regimeLabel: Record<PromptRegime, string> = {
    trending: "TRENDING (clean directional move — momentum is reliable)",
    drifting: "DRIFTING (mixed — momentum is weak, treat edge as modest)",
    choppy: "CHOPPY (price is sawing back and forth — momentum is unreliable)",
  };
  const regime = regimeLabel[regimeFromER(er)];
  const drift = ind.netDriftPct >= 0 ? "+" : "";
  const spikeLine = ind.spikeFlag
    ? `Spike: YES — a candle ranged ${ind.spikeMultiple.toFixed(2)}× the median; recent move may be a one-off blip, not sustained order flow.`
    : "Spike: none — candle ranges are orderly.";
  return `
INTRA-WINDOW MOMENTUM (last 15 × 1-min candles — what price is doing RIGHT NOW):
Regime: ${regime}
Efficiency ratio: ${er.toFixed(3)} (|net move| ÷ total path; 1=clean trend, 0=pure chop)
Oscillations: ${ind.oscillationCount} close-to-close direction reversals
Net drift: ${drift}${ind.netDriftPct.toFixed(3)}% | Total path travelled: ${ind.totalPathPct.toFixed(3)}%
${spikeLine}`;
}

// ---------------------------------------------------------------------------
// Quarter-hour target generation (next 4 boundaries from now)
// ---------------------------------------------------------------------------
export function nextQuarterTargets(now: Date, count = 4): Date[] {
  const targets: Date[] = [];
  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  const minutesToNext = 15 - (d.getMinutes() % 15);
  d.setMinutes(d.getMinutes() + (minutesToNext === 0 ? 15 : minutesToNext));
  for (let i = 0; i < count; i++) {
    targets.push(new Date(d.getTime() + i * 15 * 60_000));
  }
  return targets;
}

export function estLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

// ---------------------------------------------------------------------------
// Prediction model
// ---------------------------------------------------------------------------
export function analyzeCoin(
  coin: CoinDef,
  candles: Candle[],
  stats: CoinStats,
  now: Date,
  geckoPrice?: number,
  orderBook?: OrderBook,
): CoinPrediction {
  const rawLastClose = candles.length > 0 ? candles[candles.length - 1].c : 0;
  const price = geckoPrice ?? (stats.last > 0 ? stats.last : rawLastClose);

  let patchedCandles = candles;
  if (geckoPrice && geckoPrice > 0 && candles.length > 0) {
    const last = candles[candles.length - 1];
    if (Math.abs(geckoPrice - last.c) / (last.c || 1) > 0.0001) {
      patchedCandles = [
        ...candles.slice(0, -1),
        {
          ...last,
          c: geckoPrice,
          h: Math.max(last.h, geckoPrice),
          l: Math.min(last.l, geckoPrice),
        },
      ];
    }
  }

  const closes = patchedCandles.map((c) => c.c);

  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const recentRets = rets.slice(-60);
  const meanRet = mean(recentRets);
  const vol = stddev(recentRets);

  const recentCloses = closes.slice(-60);
  const { slope, r2 } = linReg(recentCloses);
  const slopeRet = price > 0 ? slope / price : 0;

  const rsiVal  = rsi(closes, 14);
  const sma20   = sma(closes, 20);
  const ema12   = ema(closes, 12);
  const ema26   = ema(closes, 26);
  const macd    = ema12 - ema26;
  const bb      = bollingerBands(closes, 20, 2);
  const atr14   = atr(candles, 14);
  const iwm     = intraWindowMetrics(patchedCandles, 15);

  const ER = iwm.efficiencyRatio;
  let trendFactor = clamp((ER - 0.25) / (0.55 - 0.25), 0, 0.5);
  if (iwm.spikeFlag) trendFactor = Math.max(trendFactor, 0.8);

  const vols = patchedCandles.map((c) => c.v);
  const recentVol = mean(vols.slice(-5));
  const baseVol   = mean(vols.slice(-30));
  const volRatio  = baseVol > 0 ? recentVol / baseVol : 1;
  const volTilt   = clamp((volRatio - 1) * 0.5, -0.3, 0.3);
  trendFactor = clamp(trendFactor + volTilt * (trendFactor - 0.5) * 2, 0, 1);

  const vwapVal  = vwap(patchedCandles.slice(-30));
  const revGapTotal = vwapVal > 0 && price > 0 ? (vwapVal - price) / price : 0;
  const revPerMin   = clamp(revGapTotal / 15, -0.001, 0.001);
  let rsiBias = 0;
  if (rsiVal > 70) rsiBias = -((rsiVal - 70) / 30) * 0.0004;
  else if (rsiVal < 30) rsiBias = ((30 - rsiVal) / 30) * 0.0004;
  const mrSignal = revPerMin + rsiBias;

  const wMom = 0.15 + 0.4 * trendFactor;
  const wReg = 0.15 + 0.3 * trendFactor;
  const wMR  = Math.max(0, 1 - wMom - wReg);
  let drift  = wMom * meanRet + wReg * slopeRet + wMR * mrSignal;

  if (orderBook && orderBook.bids.length > 0 && orderBook.asks.length > 0) {
    const topN   = 10;
    const bidVol = orderBook.bids.slice(0, topN).reduce((s, b) => s + b.size, 0);
    const askVol = orderBook.asks.slice(0, topN).reduce((s, a) => s + a.size, 0);
    const denom  = bidVol + askVol;
    const imbalance = denom > 0 ? (bidVol - askVol) / denom : 0;
    drift += imbalance * 0.00015;
  }

  const trendStrength = clamp(Math.abs(slopeRet) / (vol + 1e-9), 0, 1);
  let trend: "up" | "down" | "flat" = "flat";
  if (macd > 0 && slopeRet > 0) trend = "up";
  else if (macd < 0 && slopeRet < 0) trend = "down";
  else if (slopeRet > vol * 0.5) trend = "up";
  else if (slopeRet < -vol * 0.5) trend = "down";

  const change24hPct = stats.open > 0 ? ((price - stats.open) / stats.open) * 100 : 0;
  const price1hAgo   = closes.length >= 61 ? closes[closes.length - 61] : closes[0];
  const change1hPct  = price1hAgo > 0 ? ((price - price1hAgo) / price1hAgo) * 100 : 0;

  const targets = nextQuarterTargets(now, 4);
  const predictions: Prediction[] = targets.map((target) => {
    const minutesAhead  = Math.max(1, Math.round((target.getTime() - now.getTime()) / 60_000));
    const rawPredicted  = price * Math.exp(drift * minutesAhead);
    const secsRemaining = Math.max(0, target.getTime() - now.getTime()) / 1_000;
    const nearCloseFrac = Math.max(0, 1 - secsRemaining / 120);
    const predictedPrice = rawPredicted * (1 - nearCloseFrac) + price * nearCloseFrac;
    const band = price * vol * Math.sqrt(minutesAhead);
    const low  = predictedPrice - band;
    const high = predictedPrice + band;
    const changePct = price > 0 ? ((predictedPrice - price) / price) * 100 : 0;
    let direction: "up" | "down" | "flat" = "flat";
    if (changePct > 0.20) direction = "up";
    else if (changePct < -0.20) direction = "down";
    if (direction === "down" && !iwm.spikeFlag) direction = "flat";
    const z = vol > 1e-9 ? (drift * Math.sqrt(minutesAhead)) / vol : 0;
    const pUp   = normCdf(z);
    const pSide = Math.max(pUp, 1 - pUp);
    const fit   = clamp(r2, 0, 1);
    const quality =
      clamp(0.4 + 0.4 * trendFactor + 0.2 * fit, 0.4, 1) * (iwm.spikeFlag ? 0.85 : 1);
    const zPenalty = clamp(1 - Math.max(0, Math.abs(z) - 0.5) * 0.18, 0.70, 1.0);
    const conf = clamp(50 + (pSide * 100 - 50) * quality * 0.5 * zPenalty, 50, 65);
    return {
      target: target.toISOString(),
      label: estLabel(target),
      minutesAhead,
      predictedPrice,
      low,
      high,
      direction,
      confidence: Math.round(conf),
      changePct,
    };
  });

  return {
    symbol: coin.symbol,
    product: coin.product,
    name: coin.name,
    price,
    change24hPct,
    change1hPct,
    high24h: stats.high,
    low24h: stats.low,
    indicators: {
      rsi: Math.round(rsiVal * 10) / 10,
      sma20,
      ema12,
      ema26,
      macd,
      trend,
      trendStrength: Math.round(trendStrength * 100) / 100,
      volatilityPct: Math.round(vol * 10000) / 100,
      bbUpper: bb.upper,
      bbLower: bb.lower,
      bbWidth: Math.round(bb.width * 100) / 100,
      bbPctB: Math.round(bb.pctB * 10) / 10,
      atr14,
      efficiencyRatio: iwm.efficiencyRatio,
      oscillationCount: iwm.oscillationCount,
      netDriftPct: iwm.netDriftPct,
      totalPathPct: iwm.totalPathPct,
      spikeFlag: iwm.spikeFlag,
      spikeMultiple: iwm.spikeMultiple,
    },
    sparkline: closes.slice(-60),
    candles: patchedCandles.slice(-90),
    predictions,
  };
}

// ---------------------------------------------------------------------------
// Backtest entry point: run the stat model at a historical window open
// ---------------------------------------------------------------------------
export function analyzeCoinAt(
  coin: CoinDef,
  candlesUpToOpen: Candle[],
  openPrice: number,
  windowOpen: Date,
): CoinPrediction {
  const highs = candlesUpToOpen.map((c) => c.h);
  const lows  = candlesUpToOpen.map((c) => c.l);
  const stats: CoinStats = {
    open:   candlesUpToOpen.length > 0 ? candlesUpToOpen[0].c : openPrice,
    high:   highs.length > 0 ? Math.max(...highs) : openPrice,
    low:    lows.length  > 0 ? Math.min(...lows)  : openPrice,
    last:   openPrice,
    volume: 0,
  };
  return analyzeCoin(coin, candlesUpToOpen, stats, windowOpen, openPrice);
}
