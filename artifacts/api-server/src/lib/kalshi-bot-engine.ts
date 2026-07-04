// Kalshi bot decision engine.
//
// Reads all available prediction signals for the current window and returns a
// BET_YES / BET_NO / SKIP decision with full reasoning logged.
//
// Signal sources:
//   Core pair (both must agree for entry):
//     1. Stat model  (getStatWindowCall)     — short-term statistical regression
//     2. Claude AI   (getTrackerWindowCall)  — LLM directional read
//   Confidence boosters (+8% each when they agree with core direction):
//     3. ML model    (getMLPrediction)       — online logistic regression (14-feature vector)
//     4. Window BetSignal (getWindowBetSignal) — pre-window regime + intra-window momentum
//
// Core-pair gate: at least one of Stat/Claude must be non-null, and all
// non-null core signals must agree. ML and WM can never block an entry —
// they only raise or leave unchanged the base confidence of 65%.

import {
  getTrackerWindowCall,
  getStatWindowCall,
  getWindowBetSignal,
  getCachedPrediction,
  getKalshiCachedData,
  getKalshiWindowContext,
  TRAINING_COINS,
  type TrackerWindowCall,
  type WindowBetSignal,
} from "./crypto";

import { extractMLFeatures } from "./ml-features";
import { getMLPrediction } from "./ml-store";

import {
  computeCorePairDecision,
  checkMinReturnGate,
  BASE_CONFIDENCE_FULL_PAIR,
  BASE_CONFIDENCE_HALF_PAIR,
  CONFIDENCE_BOOST_PER_SIGNAL,
  ML_PRIMARY_MIN_CONFIDENCE,
  ML_SIGNAL_BOOST,
  BET_PROFILES,
  isInQuietHours,
  applyBetOutcome,
  tickCircuitBreakerWindow,
  checkMomentumOverride,
  deriveRegime,
  isLiveModePermitted,
  assertSetBotModeAllowed,
  resolveStartupMode,
  applyStartupModeRestore,
  DEFAULT_BOT_CONFIG,
  buildStreakSnapshot,
  restoreStreakState,
  type BetProfile,
  type BetProfileConfig,
  type DecisionMode,
  type BotConfig,
  type BotDecisionAction,
  type CorePairInputs,
  type CorePairResult,
  type CircuitBreakerState,
  type PriceRegime,
  type CoinStreakEntry,
} from "./kalshi-bot-engine-core";

// Re-export constants and types so callers only import from this file.
export {
  computeCorePairDecision,
  checkMinReturnGate,
  BASE_CONFIDENCE_FULL_PAIR,
  BASE_CONFIDENCE_HALF_PAIR,
  CONFIDENCE_BOOST_PER_SIGNAL,
  ML_PRIMARY_MIN_CONFIDENCE,
  ML_SIGNAL_BOOST,
  BET_PROFILES,
  isInQuietHours,
  applyBetOutcome,
  tickCircuitBreakerWindow,
  checkMomentumOverride,
  deriveRegime,
  // Live-mode env guards — pure functions, also exported here so callers
  // (e.g. routes/kalshi-bot.ts) only import from this file.
  isLiveModePermitted,
  assertSetBotModeAllowed,
  resolveStartupMode,
  applyStartupModeRestore,
  // BotConfig types and defaults live in the zero-dependency core module so
  // they can be imported by unit tests without pulling in ./crypto.
  DEFAULT_BOT_CONFIG,
  // Streak-state pure helpers — extracted so kalshi-bot.ts can delegate and
  // unit tests can verify expiry logic without touching the DB.
  buildStreakSnapshot,
  restoreStreakState,
  type BetProfile,
  type BetProfileConfig,
  type DecisionMode,
  type BotConfig,
  type BotDecisionAction,
  type CorePairInputs,
  type CorePairResult,
  type CircuitBreakerState,
  type PriceRegime,
  type CoinStreakEntry,
};

export interface SignalSnapshot {
  statAbove: boolean | null;
  claudeAbove: boolean | null;
  mlAbove: boolean | null;
  windowMonitor: "bet" | "stay_away" | "caution" | null;
  windowMonitorReady: boolean;
  yesPrice: number | null;
  ev: number | null;
  signalAccuracyPct: number | null;
  minutesElapsed: number;
  signalsAgreeing: number;
  signalsTotal: number;
  agreementTarget: BotDecisionAction | null;
  statConfidence: number | null;
  claudeConfidence: number | null;
  mlConfidence: number | null;
  warmupActive: boolean;
  roiPct: number | null;       // net return % on the chosen side; null when yesPrice unknown
}

export interface BotDecision {
  action: BotDecisionAction;
  confidence: number;
  reasoning: string;
  signals: SignalSnapshot;
}

// ---------------------------------------------------------------------------
// ROI gate — skip when the payout on our chosen side is below the minimum
// ---------------------------------------------------------------------------

// Minimum net return required to place a bet.  Set to 1.4 % as a loose ~1.5 %
// floor — values like 1.45 % and 1.48 % are acceptable; hard-losing plays
// (< 1.4 %) are skipped.  A YES bet needs yesPrice ≤ 98.62 ¢; a NO bet needs
// yesPrice ≥ 1.38 ¢.  Gate is bypassed when yesPrice is unknown.
const MIN_ROI_PCT = 1.4;

function calcROI(action: BotDecisionAction, yesPrice: number): number {
  return action === "BET_YES"
    ? (100 - yesPrice) / yesPrice * 100
    : yesPrice / (100 - yesPrice) * 100;
}

// ---------------------------------------------------------------------------
// Public decision engine — gathers live signals then calls the pure core
// ---------------------------------------------------------------------------

function _makeBotDecisionInner(
  symbol: string,
  config: BotConfig,
  kalshiTicker: string | null,
  yesPrice: number | null,
  minutesElapsed: number,
  signalAccuracyPct: number | null,
  kalshiTarget?: number | null,
): BotDecision {
  const sym = symbol.toUpperCase();

  const statCall: TrackerWindowCall | null = getStatWindowCall(sym);
  const claudeCall: TrackerWindowCall | null = getTrackerWindowCall(sym);
  const wmSignal: WindowBetSignal | null = getWindowBetSignal(sym);

  const statAbove: boolean | null = statCall?.aboveKalshi ?? null;
  const claudeAbove: boolean | null = claudeCall?.aboveKalshi ?? null;
  const wmRec = wmSignal?.recommendation ?? null;
  const wmReady = wmSignal?.ready ?? false;

  // Guard: training coins always run Claude. If Claude hasn't responded yet and
  // we're within the first 90 s of the window, hold off rather than entering on
  // stat alone — Claude's opening call takes 15–60 s after the snapshot fires at
  // t+45 s, so the first bot tick (t+60 s) can race ahead of Claude's response.
  const CLAUDE_PENDING_THRESHOLD_MIN = 1.5; // 90 s expressed in minutes
  if (
    TRAINING_COINS.has(sym) &&
    claudeAbove === null &&
    minutesElapsed < CLAUDE_PENDING_THRESHOLD_MIN
  ) {
    const pendingSnapshot: SignalSnapshot = {
      statAbove, claudeAbove: null, mlAbove: null,
      windowMonitor: wmRec, windowMonitorReady: wmReady,
      yesPrice, ev: null, signalAccuracyPct, minutesElapsed,
      signalsAgreeing: 0, signalsTotal: 0, agreementTarget: null,
      statConfidence: statCall?.confidence ?? null,
      claudeConfidence: null, mlConfidence: null,
      warmupActive: true,
      roiPct: null,
    };
    return {
      action: "SKIP",
      confidence: 0,
      reasoning: "Claude opening call pending — waiting up to 90 s before evaluating entry",
      signals: pendingSnapshot,
    };
  }

  // ML logistic-regression prediction.
  // getCachedPrediction gives the live CoinPrediction (price + indicators + candles).
  // extractMLFeatures converts it into the 14-element feature vector; getMLPrediction
  // runs inference on the in-memory trained weights.  Returns null when the model
  // hasn't accumulated ≥30 labeled windows yet (minWindows gate).
  //
  // ML fix: the CoinPrediction.kalshiTarget field may be null even when the Kalshi
  // route cache has the strike; fall back to getKalshiCachedData so ML always gets
  // the current window's numeric strike when available.
  let mlAbove: boolean | null = null;
  let mlConfidence: number | null = null;
  const pred = getCachedPrediction(sym);
  // Use the caller-supplied kalshiTarget first (already confirmed non-null by
  // the bot loop's Phase-3 gate). Falling back to getKalshiCachedData handles
  // calls from tests or callers that don't pass the value explicitly, but
  // avoids a stale-cache race where the prediction tracker overwrites the
  // kalshiTargetCache with value:null between the Phase-3 check and this call.
  const mlKalshiTarget = kalshiTarget ?? pred?.kalshiTarget ?? getKalshiCachedData(sym)?.value ?? null;
  if (pred && mlKalshiTarget != null) {
    const winCtx = getKalshiWindowContext(sym);
    const elapsedFraction = Math.min(minutesElapsed / 15, 1);
    // Pass live stat/claude/wm signals so ML sees all three model directions
    // at inference time — matching the training distribution where these are
    // also captured at snapshot time after stat+claude have been computed.
    const features = extractMLFeatures(pred, mlKalshiTarget, elapsedFraction, winCtx?.priceAtOpen, statAbove, claudeAbove, wmRec);
    const mlResult = getMLPrediction(sym, features);
    if (mlResult.ready && mlResult.prediction) {
      mlAbove = mlResult.prediction.above;
      mlConfidence = mlResult.prediction.confidence ?? null;
    }
  }

  const wmFactors = wmSignal?.factors;
  const wmDriftAbove: boolean | null =
    wmReady && wmRec === "bet" && wmFactors != null ? wmFactors.netDriftPct > 0 : null;

  // Helper to build a signal snapshot (roiPct filled in by the outer wrapper)
  const buildSnapshot = (ev: number | null, signalsAgreeing = 0, signalsTotal = 0, agreementTarget: BotDecisionAction | null = null): SignalSnapshot => ({
    statAbove, claudeAbove, mlAbove,
    windowMonitor: wmRec, windowMonitorReady: wmReady,
    yesPrice, ev, signalAccuracyPct, minutesElapsed,
    signalsAgreeing, signalsTotal, agreementTarget,
    statConfidence: statCall?.confidence ?? null,
    claudeConfidence: claudeCall?.confidence ?? null,
    mlConfidence,
    warmupActive: false,
    roiPct: null,
  });

  const decisionMode: DecisionMode = config.decisionMode ?? "classic";
  const profile = BET_PROFILES[config.betProfile ?? "normal"];

  // ── Decision Mode: consensus ──────────────────────────────────────────────
  // Require at least 2 out of [Stat, Claude, ML] to agree on the same direction.
  // Fall back to classic when fewer than 2 signals are available (ML not yet
  // trained) so the mode is never strictly worse than classic during warm-up.
  if (decisionMode === "consensus") {
    const votes: Array<{ above: boolean; conf: number }> = [];
    if (statAbove !== null)  votes.push({ above: statAbove,  conf: statCall?.confidence ?? 55 });
    if (claudeAbove !== null) votes.push({ above: claudeAbove, conf: claudeCall?.confidence ?? 55 });
    if (mlAbove !== null && mlConfidence != null) votes.push({ above: mlAbove, conf: mlConfidence });

    if (votes.length < 2) {
      // Not enough signals to form a meaningful consensus — fall through to classic
      // so the bot can still operate while ML is warming up.
    } else {
      const yesVotes = votes.filter(v => v.above);
      const noVotes  = votes.filter(v => !v.above);
      const majorityDir: boolean | null =
        yesVotes.length > noVotes.length ? true :
        noVotes.length  > yesVotes.length ? false : null;
      const majorityCount = majorityDir === null ? 0 : Math.max(yesVotes.length, noVotes.length);

      if (majorityDir === null || majorityCount < 2) {
        return {
          action: "SKIP",
          confidence: 0,
          reasoning: `consensus: no 2/${votes.length} majority (yes=${yesVotes.length} no=${noVotes.length} total=${votes.length}) — skipping`,
          signals: buildSnapshot(null),
        };
      }

      const agreeingVotes = majorityDir ? yesVotes : noVotes;
      const avgConf = agreeingVotes.reduce((s, v) => s + v.conf, 0) / agreeingVotes.length;
      const confidence = Math.round(Math.max(avgConf, BASE_CONFIDENCE_HALF_PAIR));
      const action: BotDecisionAction = majorityDir ? "BET_YES" : "BET_NO";

      if (confidence < config.minConfidence) {
        return {
          action: "SKIP",
          confidence,
          reasoning: `consensus: confidence ${confidence}% below minimum ${config.minConfidence}%`,
          signals: buildSnapshot(null, agreeingVotes.length, votes.length),
        };
      }

      const consensusReturnGate = checkMinReturnGate(action, yesPrice, config.minReturnMultiple);
      if (consensusReturnGate.blocked) {
        return {
          action: "SKIP",
          confidence,
          reasoning: `consensus: ${consensusReturnGate.reason}`,
          signals: buildSnapshot(null, agreeingVotes.length, votes.length),
        };
      }

      return {
        action,
        confidence,
        reasoning: `consensus: ${agreeingVotes.length}/${votes.length} agree ${majorityDir ? "YES" : "NO"} (avg conf ${confidence}%)`,
        signals: buildSnapshot(null, agreeingVotes.length, votes.length, action),
      };
    }
  }

  // ── Decision Mode: unanimous ──────────────────────────────────────────────
  // Require all three signals (Stat, Claude, ML) to be available and agree
  // unanimously on the same direction. Any missing signal or any disagreement
  // → SKIP. No warm-up fallback — this is intentionally the strictest mode.
  if (decisionMode === "unanimous") {
    if (statAbove === null || claudeAbove === null || mlAbove === null) {
      const missing = (
        [statAbove === null && "Stat", claudeAbove === null && "Claude", mlAbove === null && "ML"] as Array<string | false>
      ).filter(Boolean).join("+");
      return {
        action: "SKIP",
        confidence: 0,
        reasoning: `unanimous: ${missing} not available — all 3 signals required`,
        signals: buildSnapshot(null),
      };
    }

    if (statAbove !== claudeAbove || claudeAbove !== mlAbove) {
      return {
        action: "SKIP",
        confidence: 0,
        reasoning: `unanimous: signals disagree (Stat=${statAbove ? "YES" : "NO"} Claude=${claudeAbove ? "YES" : "NO"} ML=${mlAbove ? "YES" : "NO"}) — skipping`,
        signals: buildSnapshot(null),
      };
    }

    const agreeDir = statAbove; // all three are identical
    const action: BotDecisionAction = agreeDir ? "BET_YES" : "BET_NO";
    const statConf   = statCall?.confidence   ?? BASE_CONFIDENCE_HALF_PAIR;
    const claudeConf = claudeCall?.confidence ?? BASE_CONFIDENCE_HALF_PAIR;
    const mlConf     = mlConfidence           ?? BASE_CONFIDENCE_HALF_PAIR;
    const confidence = Math.round((statConf + claudeConf + mlConf) / 3);

    if (confidence < config.minConfidence) {
      return {
        action: "SKIP",
        confidence,
        reasoning: `unanimous: confidence ${confidence}% below minimum ${config.minConfidence}%`,
        signals: buildSnapshot(null, 3, 3),
      };
    }

    const unanimousReturnGate = checkMinReturnGate(action, yesPrice, config.minReturnMultiple);
    if (unanimousReturnGate.blocked) {
      return {
        action: "SKIP",
        confidence,
        reasoning: `unanimous: ${unanimousReturnGate.reason}`,
        signals: buildSnapshot(null, 3, 3),
      };
    }

    return {
      action,
      confidence,
      reasoning: `unanimous: all 3 agree ${agreeDir ? "YES" : "NO"} (Stat=${Math.round(statConf)}% Claude=${Math.round(claudeConf)}% ML=${Math.round(mlConf)}% → avg ${confidence}%)`,
      signals: buildSnapshot(null, 3, 3, action),
    };
  }

  // ── Decision Mode: ml_gate ────────────────────────────────────────────────
  // Rule: compute the Stat+Claude core-pair decision WITHOUT ML (so ML is not
  // promoted to PATH A), then veto the resulting bet if ML is available and
  // disagrees with the direction. If ML is unavailable, fall through to normal
  // classic behavior (ML will still boost confidence if it agrees at the end).
  if (decisionMode === "ml_gate") {
    const coreResult = computeCorePairDecision({
      statAbove, claudeAbove,
      mlAbove: null, mlConfidence: null, // exclude ML from the core direction decision
      wmDriftAbove, wmRec, wmReady,
      yesPrice, signalAccuracyPct, minutesElapsed,
      statConfidence: statCall?.confidence ?? null,
      claudeConfidence: claudeCall?.confidence ?? null,
      mlMinConfidence: profile.mlMinConfidence,
      kalshiTicker,
      minConfidence: config.minConfidence,
      minReturnMultiple: config.minReturnMultiple,
    });

    if (coreResult.action !== "SKIP" && mlAbove !== null) {
      const proposedDir = coreResult.action === "BET_YES";
      if (mlAbove !== proposedDir) {
        // Soft veto: only block when ML is confident enough in the opposition.
        // When mlConfidence < mlVetoMinConfidence the ML signal is too uncertain
        // to override a Stat+Claude agreement — let the bet through.
        const vetoThreshold = config.mlVetoMinConfidence ?? 57;
        const mlConf = mlConfidence ?? 0;
        if (mlConf >= vetoThreshold) {
          return {
            action: "SKIP",
            confidence: 0,
            reasoning: `ml_gate: ML veto (ML=${mlAbove ? "above" : "below"} at ${mlConf}% ≥ ${vetoThreshold}% threshold opposes ${coreResult.action} from Stat+Claude) — skipping`,
            signals: buildSnapshot(coreResult.ev, coreResult.signalsAgreeing, coreResult.signalsTotal),
          };
        }
        // ML disagrees but below confidence threshold — proceed, note it in reasoning
        // (overriding will be logged via the return below)
      }
    }

    // ML agrees or is unavailable (or disagrees but below veto threshold) — return the core result directly
    const coreSnap = buildSnapshot(
      coreResult.ev,
      coreResult.signalsAgreeing,
      coreResult.signalsTotal,
      coreResult.action !== "SKIP" ? coreResult.action : null,
    );
    // Only annotate with ML context when the core produced an actionable direction.
    // A SKIP result (e.g. "No signals available") has no direction for ML to confirm.
    let mlReasonSuffix = "";
    if (coreResult.action !== "SKIP") {
      const proposedDir = coreResult.action === "BET_YES";
      const mlDisagreesButBelowThreshold =
        mlAbove !== null && mlAbove !== proposedDir;
      mlReasonSuffix =
        mlAbove === null
          ? " (ML not ready — no veto applied)"
          : mlDisagreesButBelowThreshold
            ? ` (ML disagrees at ${mlConfidence ?? 0}% < ${config.mlVetoMinConfidence ?? 57}% threshold — veto skipped)`
            : ` (ML confirms: ${mlAbove ? "above" : "below"})`;
    }
    return {
      action: coreResult.action,
      confidence: coreResult.confidence,
      reasoning: coreResult.reasoning + mlReasonSuffix,
      signals: coreSnap,
    };
  }

  // ── Classic path (also used by ml_primary) ────────────────────────────────
  const result = computeCorePairDecision({
    statAbove, claudeAbove, mlAbove, wmDriftAbove,
    wmRec, wmReady, yesPrice, signalAccuracyPct, minutesElapsed,
    statConfidence: statCall?.confidence ?? null,
    claudeConfidence: claudeCall?.confidence ?? null,
    mlConfidence,
    mlMinConfidence: profile.mlMinConfidence,
    kalshiTicker,
    minConfidence: config.minConfidence,
    minReturnMultiple: config.minReturnMultiple,
  });

  const snapshot = buildSnapshot(
    result.ev,
    result.signalsAgreeing,
    result.signalsTotal,
    result.action !== "SKIP" ? result.action : null,
  );

  return {
    action: result.action,
    confidence: result.confidence,
    reasoning: result.reasoning,
    signals: snapshot,
  };
}

// ---------------------------------------------------------------------------
// Exported wrapper — applies the ROI gate after all signal logic has run
// ---------------------------------------------------------------------------

export function makeBotDecision(
  symbol: string,
  config: BotConfig,
  kalshiTicker: string | null,
  yesPrice: number | null,
  minutesElapsed: number,
  signalAccuracyPct: number | null,
  kalshiTarget?: number | null,
): BotDecision {
  const inner = _makeBotDecisionInner(symbol, config, kalshiTicker, yesPrice, minutesElapsed, signalAccuracyPct, kalshiTarget);

  // Compute ROI for the chosen side when yesPrice is available.
  // yesPrice is in cents (0–100); net return = payout / stake.
  if (inner.action !== "SKIP" && yesPrice !== null && yesPrice > 0 && yesPrice < 100) {
    const roi = calcROI(inner.action, yesPrice);
    // Always record roiPct so it shows in bet signals even on SKIPs below.
    inner.signals = { ...inner.signals, roiPct: parseFloat(roi.toFixed(2)) };

    if (roi < MIN_ROI_PCT) {
      return {
        action: "SKIP",
        confidence: inner.confidence,
        reasoning: `roi-too-low: ${roi.toFixed(2)}% net return on ${inner.action === "BET_YES" ? "YES" : "NO"} side is below the ${MIN_ROI_PCT}% minimum — market has priced in the direction`,
        signals: inner.signals,
      };
    }
  }

  return inner;
}
