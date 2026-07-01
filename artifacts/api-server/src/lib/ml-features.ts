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

  // Features 14-16: other model signals (encoded via the shared helper below).
  const [statFeat, claudeFeat, wmFeat] = encodeSignalFeatures(statAbove, claudeAbove, wmRec);

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

/**
 * Derive binary above/below directions from model predicted prices vs. a reference.
 *
 * This is the pure sequencing step that MUST run after stat and claude have both
 * produced a predictedPrice, and BEFORE captureMLSnapshot is called.  If the
 * snapshot were captured before this step, statAbove and claudeAbove would both
 * be null and features 14-15 would encode 0.5 (neutral) — silently degrading
 * training data quality.
 *
 * A 0.05% dead-band is used to avoid encoding trivially small deviations as a
 * directional signal.  This matches the threshold used by the ensemble's
 * dirFromPrice helper so training and inference are consistent.
 *
 * @param statPredictedPrice   Price output by the stat model (analyzeCoin basePred).
 * @param claudePredictedPrice Price output by Claude, or null if Claude was not run.
 * @param reference            Kalshi strike when known; otherwise the live price.
 */
export function deriveMLSignalDirections(
  statPredictedPrice: number,
  claudePredictedPrice: number | null,
  reference: number,
): { mlStatAbove: boolean | null; mlClaudeAbove: boolean | null } {
  const pct = (p: number): number =>
    reference > 0 ? ((p - reference) / reference) * 100 : 0;

  const mlStatAbove: boolean | null =
    pct(statPredictedPrice) > 0.05
      ? true
      : pct(statPredictedPrice) < -0.05
      ? false
      : null;

  const mlClaudeAbove: boolean | null =
    claudePredictedPrice !== null
      ? pct(claudePredictedPrice) > 0.05
        ? true
        : pct(claudePredictedPrice) < -0.05
        ? false
        : null
      : null;

  return { mlStatAbove, mlClaudeAbove };
}

/**
 * Build the complete ML snapshot inputs in the correct order.
 *
 * This function is the single point of truth for the tracker's sequencing
 * invariant:
 *
 *   1. Stat model runs  →  statPredictedPrice is known
 *   2. Claude runs      →  claudePredictedPrice is known (or null if skipped)
 *   3. THIS FUNCTION derives directions from those prices (features 14-15)
 *   4. THIS FUNCTION feeds them into extractMLFeatures
 *   5. Caller passes the returned `features` to captureMLSnapshot
 *
 * The return value is only usable for snapshot capture AFTER this function
 * has run, which is only possible AFTER stat+claude have both completed.
 * If the snapshot were captured before calling this function the caller would
 * have no `features` to pass — the ordering bug becomes a type error.
 *
 * @param coin               Full CoinPrediction from the live snapshot
 * @param kalshiTarget       Kalshi strike for this window
 * @param elapsedFraction    Time into window / 900 s (clamped 0–1)
 * @param priceAtOpen        Price at window open (from getKalshiWindowContext)
 * @param statPredictedPrice predictedPrice from analyzeCoin basePred — stat MUST have run
 * @param claudePredictedPrice predictedPrice from Claude, or null if Claude was not run
 * @param wmRec              Window-monitor recommendation string (or null)
 */
export function buildMLSnapshotInputs(
  coin: Parameters<typeof extractMLFeatures>[0],
  kalshiTarget: number,
  elapsedFraction: number,
  priceAtOpen: number | null | undefined,
  statPredictedPrice: number,
  claudePredictedPrice: number | null,
  wmRec: string | null,
): {
  features: number[];
  mlStatAbove: boolean | null;
  mlClaudeAbove: boolean | null;
} {
  // Step 3 — derive directions from post-model prices:
  const { mlStatAbove, mlClaudeAbove } = deriveMLSignalDirections(
    statPredictedPrice,
    claudePredictedPrice,
    kalshiTarget,
  );
  // Step 4 — build the feature vector with real signal values in slots 14-15:
  const features = extractMLFeatures(
    coin,
    kalshiTarget,
    elapsedFraction,
    priceAtOpen,
    mlStatAbove,
    mlClaudeAbove,
    wmRec,
  );
  return { features, mlStatAbove, mlClaudeAbove };
}

/**
 * Pure encoding helper shared by extractMLFeatures and the backfill augmentor.
 * Returns [statFeat, claudeFeat, wmFeat] — each in {0, 0.5, 1}.
 *
 * Encoding rules:
 *   boolean true  → 1  (above / bet)
 *   boolean false → 0  (below / stay_away)
 *   null/undefined/unknown string → 0.5  (no opinion / abstain)
 *
 * wmRec string values: "bet"→1, "stay_away"→0, anything else (incl. "caution")→0.5.
 */
export function encodeSignalFeatures(
  statAbove?: boolean | null,
  claudeAbove?: boolean | null,
  wmRec?: string | null,
): [number, number, number] {
  const statFeat   = statAbove   === true ? 1 : statAbove   === false ? 0 : 0.5;
  const claudeFeat = claudeAbove === true ? 1 : claudeAbove === false ? 0 : 0.5;
  const wmFeat     = wmRec === "bet" ? 1 : wmRec === "stay_away" ? 0 : 0.5;
  return [statFeat, claudeFeat, wmFeat];
}

/**
 * In-place mutation: overwrite features[14-16] of a backfill example using
 * stat/claude directions looked up from the historical signal map.
 * wmRec is always 0.5 for backfill rows (not stored historically).
 *
 * Safe to call even when `sig` is undefined (all three features stay at 0.5).
 */
export function applySignalAugmentation(
  features: number[],
  statAbove: boolean | null | undefined,
  claudeAbove: boolean | null | undefined,
): void {
  const [statFeat, claudeFeat] = encodeSignalFeatures(statAbove, claudeAbove, null);
  features[14] = statFeat;
  features[15] = claudeFeat;
  features[16] = 0.5; // wmRec never stored historically
}
