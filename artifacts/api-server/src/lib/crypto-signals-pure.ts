// ---------------------------------------------------------------------------
// crypto-signals-pure.ts — zero-dependency pure helpers for crypto-signals
// ---------------------------------------------------------------------------
// Extracted so tests can import them without pulling in crypto-tracker,
// crypto-kalshi, ml-store, or any other I/O module.

// Minimal structural types — only the fields the pure helpers read.
// Keep in sync with Prediction / CoinPrediction in crypto-data.ts.
export interface PredictionSlice {
  minutesAhead: number;
  predictedPrice: number;
  confidence: number;
}

export interface CoinPredictionSlice {
  predictions: PredictionSlice[];
}

// ---------------------------------------------------------------------------

/**
 * Maximum age (ms) for a predCache entry to be considered fresh.
 * If the entry is older than this the predictor's snap loop has stalled;
 * treat it as missing so stat and ML both return null and the bot's
 * all-signals gate blocks entries rather than betting on stale output.
 */
export const PRED_MAX_AGE_MS = 10 * 60_000;

/**
 * Resolve a predCache entry to its value, or null if the entry is absent or
 * older than PRED_MAX_AGE_MS relative to `nowMs`.
 *
 * Pure — no side effects, no I/O.
 */
export function resolvePredEntry<T extends CoinPredictionSlice>(
  entry: { at: number; value: T } | undefined,
  nowMs: number,
): T | null {
  return entry != null && nowMs - entry.at < PRED_MAX_AGE_MS
    ? entry.value
    : null;
}

/**
 * Given a fresh pred snapshot, pick the forward prediction whose horizon
 * best matches `minutesRemaining` in the current window, then compare its
 * predictedPrice against the CURRENT `kalshiTarget` (not the target that
 * was in effect when the pred was computed — the bot always uses the live
 * Kalshi strike).
 *
 * Returns null when there are no predictions or when predictedPrice <= 0.
 * Pure — no side effects, no I/O.
 */
export function resolveStatSignal(
  predictions: PredictionSlice[],
  kalshiTarget: number,
  minutesRemaining: number | null,
): { statAbove: boolean; statConfidence: number | null } | null {
  if (predictions.length === 0) return null;
  let best = predictions[predictions.length - 1];
  if (minutesRemaining != null && minutesRemaining > 0) {
    best = predictions.reduce((b, p) => {
      const d = Math.abs((p.minutesAhead ?? 0) - minutesRemaining);
      const dBest = Math.abs((b.minutesAhead ?? 0) - minutesRemaining);
      return d < dBest ? p : b;
    }, predictions[0]);
  }
  if (best.predictedPrice <= 0) return null;
  return {
    statAbove: best.predictedPrice >= kalshiTarget,
    statConfidence: best.confidence ?? null,
  };
}
