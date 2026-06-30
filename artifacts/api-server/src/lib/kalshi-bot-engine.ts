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
//     3. ML model    (getCachedPrediction)   — online logistic regression
//     4. Window BetSignal (getWindowBetSignal) — intra-window momentum regime
//
// Core-pair gate: at least one of Stat/Claude must be non-null, and all
// non-null core signals must agree. ML and WM can never block an entry —
// they only raise or leave unchanged the base confidence of 65%.

import {
  getTrackerWindowCall,
  getStatWindowCall,
  getWindowBetSignal,
  getCachedPrediction,
  TRAINING_COINS,
  type TrackerWindowCall,
  type WindowBetSignal,
} from "./crypto";

import {
  computeCorePairDecision,
  BASE_CONFIDENCE_FULL_PAIR,
  BASE_CONFIDENCE_HALF_PAIR,
  CONFIDENCE_BOOST_PER_SIGNAL,
  type BotDecisionAction,
  type CorePairInputs,
  type CorePairResult,
} from "./kalshi-bot-engine-core";

// Re-export constants and types so callers only import from this file.
export {
  computeCorePairDecision,
  BASE_CONFIDENCE_FULL_PAIR,
  BASE_CONFIDENCE_HALF_PAIR,
  CONFIDENCE_BOOST_PER_SIGNAL,
  type BotDecisionAction,
  type CorePairInputs,
  type CorePairResult,
};

export interface BotConfig {
  betSize: number;           // $ per bet (default 0.50)
  dailyLossLimit: number;    // $ max daily loss (default 20)
  signalThreshold: number;   // kept for config compat — not used for entry gating (see core-pair gate)
  minConfidence: number;     // 0-100; skip bet when engine confidence is below this (default 60)
  midExitSensitivity: "conservative" | "balanced" | "aggressive";
  phase2ThresholdPp: number; // pp below entry to activate phase 2 (default 30)
  maxEntryMinutes: number;   // don't enter after this many minutes into the window (default 5)
  enabled: boolean;          // master kill-switch
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  betSize: 0.50,
  dailyLossLimit: 20,
  signalThreshold: 2,    // legacy field — core-pair gate now governs entry
  minConfidence: 60,
  midExitSensitivity: "balanced",
  phase2ThresholdPp: 30,
  // Entry is only allowed between t+45s and t+5:00 of each 15-min window.
  // 45s warmup = Kalshi market stabilises + Claude opening call completes.
  // 5-min ceiling = signals get noisier as the window ages.
  // Hard floor: entry is never allowed if fewer than 4 minutes remain (see kalshi-bot.ts).
  maxEntryMinutes: 5,
  enabled: true,
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
}

export interface BotDecision {
  action: BotDecisionAction;
  confidence: number;
  reasoning: string;
  signals: SignalSnapshot;
}

// ---------------------------------------------------------------------------
// Public decision engine — gathers live signals then calls the pure core
// ---------------------------------------------------------------------------

export function makeBotDecision(
  symbol: string,
  config: BotConfig,
  kalshiTicker: string | null,
  yesPrice: number | null,
  minutesElapsed: number,
  signalAccuracyPct: number | null,
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
    };
    return {
      action: "SKIP",
      confidence: 0,
      reasoning: "Claude opening call pending — waiting up to 90 s before evaluating entry",
      signals: pendingSnapshot,
    };
  }

  let mlAbove: boolean | null = null;
  let mlConfidence: number | null = null;
  const cached = getCachedPrediction(sym);
  if (cached?.predictions) {
    const nearestPred = cached.predictions[0];
    if (nearestPred && nearestPred.direction !== "flat") {
      mlAbove = nearestPred.direction === "up";
      mlConfidence = nearestPred.confidence ?? null;
    }
  }

  const wmFactors = wmSignal?.factors;
  const wmDriftAbove: boolean | null =
    wmReady && wmRec === "bet" && wmFactors != null ? wmFactors.netDriftPct > 0 : null;

  const result = computeCorePairDecision({
    statAbove, claudeAbove, mlAbove, wmDriftAbove,
    wmRec, wmReady, yesPrice, signalAccuracyPct, minutesElapsed,
    statConfidence: statCall?.confidence ?? null,
    claudeConfidence: claudeCall?.confidence ?? null,
    mlConfidence,
    kalshiTicker,
    minConfidence: config.minConfidence,
  });

  const snapshot: SignalSnapshot = {
    statAbove, claudeAbove, mlAbove,
    windowMonitor: wmRec, windowMonitorReady: wmReady,
    yesPrice, ev: result.ev, signalAccuracyPct, minutesElapsed,
    signalsAgreeing: result.signalsAgreeing,
    signalsTotal: result.signalsTotal,
    agreementTarget: result.action !== "SKIP" ? result.action : null,
    statConfidence: statCall?.confidence ?? null,
    claudeConfidence: claudeCall?.confidence ?? null,
    mlConfidence,
    warmupActive: false,
  };

  return {
    action: result.action,
    confidence: result.confidence,
    reasoning: result.reasoning,
    signals: snapshot,
  };
}
