// ---------------------------------------------------------------------------
// crypto-signals.ts — unified predictor signal accessor
// ---------------------------------------------------------------------------
// Single source of truth for all model signals for a given coin.
// Reads from the same functions the Crypto Predictor page uses so the bot
// engine and dashboard always reflect identical values with no divergence.
//
// Import path: this file imports directly from sub-modules (NOT from the
// crypto.ts barrel) to avoid a circular dependency — the barrel re-exports
// from this file, so importing from it here would be circular.

import {
  getStatWindowCall,
  getTrackerWindowCall,
  getWindowBetSignal,
  getCachedPrediction,
  isCoinClaudeEnabled,
} from "./crypto-tracker";
import { getKalshiCachedData, getKalshiWindowContext } from "./crypto-kalshi";
import { extractMLFeatures } from "./ml-features";
import { getMLPrediction } from "./ml-store";

export interface CoinSignals {
  statAbove: boolean | null;
  statConfidence: number | null;
  claudeAbove: boolean | null;
  claudeConfidence: number | null;
  mlAbove: boolean | null;
  mlConfidence: number | null;
  wmRecommendation: "bet" | "stay_away" | "caution" | null;
  wmReady: boolean;
  claudeEnabled: boolean;
}

/**
 * Return the predictor page's current signals for a coin in one call.
 *
 * Reads from:
 *   getStatWindowCall      — same as predictor page's stat model signal
 *   getTrackerWindowCall   — same as predictor page's Claude opening call
 *   getWindowBetSignal     — same as predictor page's Window Monitor badge
 *   getMLPrediction        — run inference with predictor's latest pred snapshot
 *
 * This is the canonical unified accessor.  Use it everywhere you need
 * statAbove/claudeAbove/mlAbove instead of computing them independently.
 */
export function getLatestCoinSignals(symbol: string): CoinSignals {
  const sym = symbol.toUpperCase();

  // ── Stat — same source as predictor page ────────────────────────────────
  const statCall = getStatWindowCall(sym);
  const statAbove = statCall?.aboveKalshi ?? null;
  const statConfidence = statCall?.confidence ?? null;

  // ── Claude — tracker window call (predictor page's source) ──────────────
  // Only present when auto-pilot fired the opening Claude call for this coin.
  const trackerCall = getTrackerWindowCall(sym);
  const claudeAbove = trackerCall?.aboveKalshi ?? null;
  const claudeConfidence = trackerCall?.confidence ?? null;
  const claudeEnabled = isCoinClaudeEnabled(sym);

  // ── Window Monitor ───────────────────────────────────────────────────────
  const wmSignal = getWindowBetSignal(sym);
  const wmRecommendation = wmSignal?.recommendation ?? null;
  const wmReady = wmSignal?.ready ?? false;

  // ── ML — run inference using the predictor's current pred snapshot ───────
  // getCachedPrediction reads from predCache which the tracker updates every
  // ~30 s — so ML inference here uses exactly the same live features that the
  // predictor page would use if asked right now.
  let mlAbove: boolean | null = null;
  let mlConfidence: number | null = null;
  const pred = getCachedPrediction(sym);
  const kalshiTarget = getKalshiCachedData(sym)?.value ?? null;
  if (pred && kalshiTarget != null) {
    try {
      const winCtx = getKalshiWindowContext(sym);
      const elapsedFraction = winCtx
        ? Math.min(winCtx.minutesElapsed / 15, 1)
        : 0;
      const features = extractMLFeatures(
        pred, kalshiTarget, elapsedFraction,
        winCtx?.priceAtOpen, statAbove, claudeAbove, wmRecommendation,
      );
      const mlResult = getMLPrediction(sym, features);
      if (mlResult.ready && mlResult.prediction) {
        mlAbove = mlResult.prediction.above;
        mlConfidence = mlResult.prediction.confidence ?? null;
      }
    } catch {
      // non-fatal — ML not ready or feature extraction failed
    }
  }

  return {
    statAbove, statConfidence,
    claudeAbove, claudeConfidence,
    mlAbove, mlConfidence,
    wmRecommendation, wmReady,
    claudeEnabled,
  };
}
