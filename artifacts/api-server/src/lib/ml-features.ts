// Pure feature extraction — no DB, no side effects.
// Converts the live CoinPrediction snapshot into a normalized 17-element vector
// suitable for logistic regression. Every feature is in the range [-1, 1] or [0, 1].
//
// v2 (14 features): added windowPriceDriftNorm + recentMom2 so the model can
// see intra-window momentum — the most important signal for "is this trend real?"
//
// v3 (17 features): added statAbove, claudeAbove, wmRec so ML can synthesise all
// three signal streams. Features 14-16 encode the other models' directions and the
// window-monitor recommendation; null/unknown → 0.5 (neutral/abstain).
// Training distribution now matches inference: stat/claude are passed at both
// snapshot capture time (in the prediction tracker) and at inference time (bot engine).

import type { CoinPrediction } from "./crypto";

export const N_FEATURES = 17;

export const FEATURE_NAMES = [
  "elapsedFraction",      //  0: how far into the 15-min window (0→1)
  "priceVsStrikeNorm",    //  1: (price-strike)/strike*100/5, clipped ±1
  "aboveStrike",          //  2: 1 if price >= strike, else 0
  "efficiencyRatio",      //  3: 0=pure chop, 1=clean trend
  "bbPctBNorm",           //  4: Bollinger %B normalized 0→1
  "rsiNorm",              //  5: RSI / 100
  "netDriftNorm",         //  6: net intra-window drift / 3%, clipped ±1
  "oscillationNorm",      //  7: direction-reversal count / 15, clipped 0→1
  "spikeFlag",            //  8: 1 if any candle > 3× median range
  "strikeProximityNorm",  //  9: |price-strike| / ATR14 / 3, clipped 0→1
  "atrNorm",              // 10: ATR14 as % of price / 2%, clipped 0→1
  "momentumDir",          // 11: 1=up drift, 0=flat, encoded 0/0.5/1
  "windowPriceDriftNorm", // 12: (price-priceAtWindowOpen)/priceAtOpen*100/2%, clipped ±1
  "recentMom2",           // 13: (lastCandle.close - prevCandle.close)/ATR14, clipped ±1
  "statAbove",            // 14: stat model direction — 1=above, 0=below, 0.5=unknown/null
  "claudeAbove",          // 15: claude model direction — 1=above, 0=below, 0.5=unknown/null
  "wmRec",                // 16: window monitor — 1=bet, 0=stay_away, 0.5=caution/unknown
] as const;

function clip(v: number, lo: number, hi: number): number {
  const n = isFinite(v) ? v : 0;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Extract the normalized 17-element feature vector from a live coin snapshot.
 * @param coin            Full CoinPrediction (price + indicators + candles)
 * @param kalshiTarget    The Kalshi strike for the current 15-min window
 * @param elapsedFraction Time elapsed in window / 900s (0 at open, 1 at close)
 * @param priceAtOpen     Coin price recorded when this window opened (from getKalshiWindowContext).
 *                        Pass null/undefined if not yet available — feature 12 will be 0.
 * @param statAbove       Stat model direction: true=above, false=below, null=not yet computed.
 *                        Encoded as 1/0/0.5 in feature 14.
 * @param claudeAbove     Claude model direction: true=above, false=below, null=not yet computed.
 *                        Encoded as 1/0/0.5 in feature 15.
 * @param wmRec           Window-monitor recommendation: "bet"→1, "stay_away"→0, anything else→0.5.
 *                        Feature 16. Pass null when not yet available (encoded 0.5).
 */
export function extractMLFeatures(
  coin: CoinPrediction,
  kalshiTarget: number,
  elapsedFraction: number,
  priceAtOpen?: number | null,
  statAbove?: boolean | null,
  claudeAbove?: boolean | null,
  wmRec?: string | null,
): number[] {
  const { price, indicators, candles } = coin;
  const {
    efficiencyRatio,
    bbPctB,
    rsi,
    netDriftPct,
    oscillationCount,
    spikeFlag,
    atr14,
  } = indicators;

  const pctVsStrike  = ((price - kalshiTarget) / kalshiTarget) * 100;
  const aboveStrike  = price >= kalshiTarget ? 1 : 0;
  const atrProximity = atr14 > 0 ? Math.abs(price - kalshiTarget) / atr14 : 0;
  const atrPct       = price > 0 ? (atr14 / price) * 100 : 0;
  const drift        = netDriftPct ?? 0;

  // Feature 12: live drift from window-open price.
  // A $300 BTC drop on a $60k open is -0.5% → normalized to -0.25.
  // At ±2% normalization, a strong directional move fills the whole range.
  const windowDrift =
    priceAtOpen && priceAtOpen > 0
      ? ((price - priceAtOpen) / priceAtOpen) * 100
      : 0;

  // Feature 13: 2-candle recent momentum relative to ATR.
  // Positive = most recent 1-min candle moved up; negative = moved down.
  // Captures instantaneous price velocity, not averaged over the whole window.
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const recentMom2 =
    lastCandle && prevCandle && atr14 > 0
      ? (lastCandle.c - prevCandle.c) / atr14
      : 0;

  // Features 14-16: other model signals.
  // Null/unknown → 0.5 so the model sees a neutral "no opinion" value during
  // training windows where a signal hasn't arrived yet, and correctly ignores
  // the feature rather than learning a spurious correlation.
  const statFeat   = statAbove   === true ? 1 : statAbove   === false ? 0 : 0.5;
  const claudeFeat = claudeAbove === true ? 1 : claudeAbove === false ? 0 : 0.5;
  const wmFeat     = wmRec === "bet" ? 1 : wmRec === "stay_away" ? 0 : 0.5;

  return [
    clip(elapsedFraction, 0, 1),               //  0
    clip(pctVsStrike / 5, -1, 1),              //  1: ±5% → ±1
    aboveStrike,                               //  2
    clip(efficiencyRatio ?? 0, 0, 1),          //  3
    clip((bbPctB ?? 50) / 100, 0, 1),          //  4
    clip((rsi ?? 50) / 100, 0, 1),             //  5
    clip(drift / 3, -1, 1),                    //  6: ±3% → ±1
    clip((oscillationCount ?? 0) / 15, 0, 1),  //  7
    spikeFlag ? 1 : 0,                         //  8
    clip(atrProximity / 3, 0, 1),              //  9
    clip(atrPct / 2, 0, 1),                    // 10
    drift > 0.1 ? 1 : drift < -0.1 ? 0 : 0.5, // 11
    clip(windowDrift / 2, -1, 1),              // 12: ±2% → ±1
    clip(recentMom2, -1, 1),                   // 13
    statFeat,                                  // 14: stat direction
    claudeFeat,                                // 15: claude direction
    wmFeat,                                    // 16: window-monitor rec
  ];
}
