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
  getTrackerWindowCall,
  getWindowBetSignal,
  isCoinClaudeEnabled,
} from "./crypto-tracker";
import { predCache } from "./crypto-data";
import { getKalshiCachedData, getKalshiWindowContext } from "./crypto-kalshi";
import { extractMLFeatures } from "./ml-features";
import { getMLPrediction } from "./ml-store";
import { liveDirectionCache } from "./crypto-claude";

// Pure helpers — re-exported so callers only need one import.
export {
  PRED_MAX_AGE_MS,
  resolvePredEntry,
  resolveStatSignal,
} from "./crypto-signals-pure";
import { resolvePredEntry, resolveStatSignal } from "./crypto-signals-pure";

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
 *   getCachedPrediction    — predCache: the predictor page's live stat snapshot
 *   getTrackerWindowCall   — same as predictor page's Claude opening call
 *   getWindowBetSignal     — same as predictor page's Window Monitor badge
 *   getMLPrediction        — run inference with predictor's latest pred snapshot
 *
 * This is the canonical unified accessor.  Use it everywhere you need
 * statAbove/claudeAbove/mlAbove instead of computing them independently.
 */
export function getLatestCoinSignals(symbol: string): CoinSignals {
  const sym = symbol.toUpperCase();

  // ── Predictor snapshot + Kalshi strike (shared by stat + ML below) ──────
  // predCache is the exact cache the Crypto Predictor page displays — it is
  // refreshed both by the tracker snap loop and by frontend polling, so it is
  // always at least as fresh as historyStore (which only updates every ~30 s
  // and lags at window open).
  //
  // Freshness guard: if the predCache entry is older than PRED_MAX_AGE_MS the
  // predictor's snap loop has stalled — treat the snapshot as missing so
  // stat and ML both go null and the bot's all-signals gate blocks entries
  // rather than betting on stale model output.  (Same 10-min ceiling the
  // engine's old applyStatPredCacheOverride enforced.)
  const pred = resolvePredEntry(predCache.get(sym), Date.now());
  const kalshiTarget = getKalshiCachedData(sym)?.value ?? null;
  const winCtx = getKalshiWindowContext(sym);

  // ── Stat — derived from predCache, same math as the predictor page ──────
  // statAbove = the model's forward prediction vs the current Kalshi strike.
  // The forward prediction whose horizon best matches the remaining window
  // time is used — the exact same selection logic as the engine's
  // applyStatPredCacheOverride.  This replaces the old getStatWindowCall
  // (historyStore) read, which could lag 30-90 s behind the predictor page
  // at window open.
  //
  // NOTE: resolveStatSignal always compares against the CURRENT kalshiTarget,
  // not whatever strike was in effect when the pred snapshot was computed.
  // A predCache entry that is fresh by timestamp but was computed during a
  // prior window will still be compared against the live strike.  The
  // PRED_MAX_AGE_MS guard (10 min) ensures that a prior-window snapshot can
  // only survive into the next window for at most 10 minutes — after that it
  // goes null and the bot cannot enter on it at all.
  const minutesRemaining = winCtx ? Math.max(0, 15 - winCtx.minutesElapsed) : null;
  const statResult =
    pred && kalshiTarget != null
      ? resolveStatSignal(pred.predictions, kalshiTarget, minutesRemaining)
      : null;
  const statAbove: boolean | null = statResult?.statAbove ?? null;
  const statConfidence: number | null = statResult?.statConfidence ?? null;

  // ── Claude — tracker opening call + live direction override ─────────────
  // The opening call (historyStore) is written once at window-open and stays
  // frozen.  If a mid-window live re-check (fetchLiveDirection) has run, its
  // result is stored in liveDirectionCache which is cleared at every window
  // transition — so any entry here is always from the current window and
  // reflects Claude's most up-to-date read.  Prefer it over the opening snap
  // to match exactly what the Crypto Predictor page shows.
  const trackerCall = getTrackerWindowCall(sym);
  let claudeAbove = trackerCall?.aboveKalshi ?? null;
  let claudeConfidence = trackerCall?.confidence ?? null;
  const liveEntry = liveDirectionCache.get(sym);
  if (liveEntry && liveEntry.result.aboveKalshi !== null) {
    claudeAbove = liveEntry.result.aboveKalshi;
    // liveDirectionCache entries may not carry a confidence value; keep the
    // opening-call confidence as the best available approximation.
  }
  const claudeEnabled = isCoinClaudeEnabled(sym);

  // ── Window Monitor ───────────────────────────────────────────────────────
  const wmSignal = getWindowBetSignal(sym);
  const wmRecommendation = wmSignal?.recommendation ?? null;
  const wmReady = wmSignal?.ready ?? false;

  // ── ML — run inference using the predictor's current pred snapshot ───────
  // Uses the same pred + kalshiTarget read above, so stat and ML always see
  // an identical snapshot — no divergence between the two is possible.
  let mlAbove: boolean | null = null;
  let mlConfidence: number | null = null;
  if (pred && kalshiTarget != null) {
    try {
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
