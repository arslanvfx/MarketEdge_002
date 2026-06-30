// Kalshi bot decision engine.
//
// Reads all available prediction signals for the current window and returns a
// BET_YES / BET_NO / SKIP decision with full reasoning logged.
//
// Signal sources (in priority order):
//   1. Stat model  (getStatWindowCall)     — short-term statistical regression
//   2. Claude AI   (getTrackerWindowCall)  — LLM directional read
//   3. ML model    (getCachedPrediction)   — online logistic regression
//   4. Window BetSignal (getWindowBetSignal) — intra-window momentum regime
//
// CAUTION from Window Monitor = hard SKIP (same as STAY_AWAY for the bot).
// The bot needs a clean, directional regime to operate — "caution" conditions
// (choppy/drifting) are statistically unfavourable enough to block entry.

import {
  getTrackerWindowCall,
  getStatWindowCall,
  getWindowBetSignal,
  getCachedPrediction,
  type TrackerWindowCall,
  type WindowBetSignal,
} from "./crypto";

export interface BotConfig {
  betSize: number;           // $ per bet (default 0.50)
  dailyLossLimit: number;    // $ max daily loss (default 20)
  signalThreshold: number;   // min signals agreeing: 2 | 3 | 4 (default 3)
  minConfidence: number;     // 0-100; skip bet when engine confidence is below this (default 60)
  midExitSensitivity: "conservative" | "balanced" | "aggressive";
  phase2ThresholdPp: number; // pp below entry to activate phase 2 (default 30)
  enabled: boolean;          // master kill-switch
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  betSize: 0.50,
  dailyLossLimit: 20,
  // Default 2 so the bot can act on stat + Claude agreement alone.
  // Raise to 3-4 once the ML model and Window Monitor are warm (20+ windows).
  signalThreshold: 2,
  minConfidence: 60,
  midExitSensitivity: "balanced",
  phase2ThresholdPp: 30,
  enabled: true,
};

export type BotDecisionAction = "BET_YES" | "BET_NO" | "SKIP";

export interface SignalSnapshot {
  statAbove: boolean | null;
  claudeAbove: boolean | null;
  mlAbove: boolean | null;
  windowMonitor: "bet" | "stay_away" | "caution" | null;
  windowMonitorReady: boolean;
  yesPrice: number | null;       // Kalshi Yes price fraction 0-1
  ev: number | null;             // EV per $1 at current yes price and timing accuracy
  timingAccuracyPct: number | null;
  minutesElapsed: number;
  signalsAgreeing: number;
  signalsTotal: number;
  agreementTarget: BotDecisionAction | null;
  statConfidence: number | null;
  claudeConfidence: number | null;
  mlConfidence: number | null;
}

export interface BotDecision {
  action: BotDecisionAction;
  confidence: number;  // 0-100
  reasoning: string;
  signals: SignalSnapshot;
}

// ---------------------------------------------------------------------------
// Decision engine
// ---------------------------------------------------------------------------

export function makeBotDecision(
  symbol: string,
  config: BotConfig,
  kalshiTicker: string | null,
  yesPrice: number | null,
  minutesElapsed: number,
  timingAccuracyPct: number | null,
): BotDecision {
  const sym = symbol.toUpperCase();

  // Gather signals
  const statCall: TrackerWindowCall | null = getStatWindowCall(sym);
  const claudeCall: TrackerWindowCall | null = getTrackerWindowCall(sym);
  const wmSignal: WindowBetSignal | null = getWindowBetSignal(sym);

  const statAbove: boolean | null = statCall?.aboveKalshi ?? null;
  const claudeAbove: boolean | null = claudeCall?.aboveKalshi ?? null;
  const wmRec = wmSignal?.recommendation ?? null;
  const wmReady = wmSignal?.ready ?? false;

  // Ensemble direction: the cached coin prediction's nearest forecast aggregates
  // the stat + Claude + ML models into a single directional signal. "up" = price
  // expected above the Kalshi strike → aboveKalshi=true.
  let mlAbove: boolean | null = null;
  let mlConfidence: number | null = null;
  const cached = getCachedPrediction(sym);
  if (cached?.predictions) {
    // predictions[0] is the nearest time bucket — the one that covers the current window
    const nearestPred = cached.predictions[0];
    if (nearestPred && nearestPred.direction !== "flat") {
      mlAbove = nearestPred.direction === "up";
      mlConfidence = nearestPred.confidence ?? null;
    }
  }

  const baseSignals = { statAbove, claudeAbove, mlAbove };

  function makeEmptySnapshot(): SignalSnapshot {
    return {
      statAbove, claudeAbove, mlAbove,
      windowMonitor: wmRec, windowMonitorReady: wmReady,
      yesPrice, ev: null, timingAccuracyPct, minutesElapsed,
      signalsAgreeing: 0, signalsTotal: 0, agreementTarget: null,
      statConfidence: statCall?.confidence ?? null,
      claudeConfidence: claudeCall?.confidence ?? null,
      mlConfidence,
    };
  }

  // If no Kalshi ticker/market, we can't bet
  if (!kalshiTicker) {
    return skip("No active Kalshi market for this symbol", makeEmptySnapshot());
  }

  // Window monitor override — both STAY_AWAY and CAUTION are hard skips.
  // CAUTION signals choppy/drifting conditions that statistically erode edge;
  // the bot only enters on clean "bet" regime from the window monitor.
  if (wmReady && (wmRec === "stay_away" || wmRec === "caution")) {
    return skip(
      `Window Monitor says ${wmRec?.toUpperCase()} — skipping (noisy/choppy regime)`,
      makeEmptySnapshot(),
    );
  }

  // Count signal agreements across all four directional sources
  const candidates: Array<{ above: boolean | null; weight: number; label: string }> = [
    { above: statAbove,   weight: 1, label: "stat" },
    { above: claudeAbove, weight: 1, label: "claude" },
    { above: mlAbove,     weight: 1, label: "ml" },
  ];

  // Window monitor directional vote (only when recommending "bet")
  const wmFactors = wmSignal?.factors;
  const wmDriftAbove = wmFactors
    ? wmFactors.netDriftPct > 0   // net drift direction as a proxy signal
    : null;
  if (wmReady && wmRec === "bet" && wmDriftAbove !== null) {
    candidates.push({ above: wmDriftAbove, weight: 1, label: "wm_drift" });
  }

  const yesAboveCount = candidates.filter((c) => c.above === true).length;
  const noAboveCount  = candidates.filter((c) => c.above === false).length;
  const total         = candidates.filter((c) => c.above !== null).length;

  let agreementTarget: "BET_YES" | "BET_NO" | null = null;
  let signalsAgreeing = 0;
  if (total > 0) {
    if (yesAboveCount >= noAboveCount) {
      agreementTarget = "BET_YES";
      signalsAgreeing = yesAboveCount;
    } else {
      agreementTarget = "BET_NO";
      signalsAgreeing = noAboveCount;
    }
  }

  // EV calculation
  let ev: number | null = null;
  if (yesPrice !== null && yesPrice > 0 && timingAccuracyPct !== null) {
    const accFrac = timingAccuracyPct / 100;
    const winPayoff = (1 - yesPrice) / yesPrice;
    ev = accFrac * winPayoff - (1 - accFrac);
  }

  const signals: SignalSnapshot = {
    ...baseSignals,
    windowMonitor: wmRec, windowMonitorReady: wmReady,
    yesPrice, ev, timingAccuracyPct, minutesElapsed,
    signalsAgreeing, signalsTotal: total, agreementTarget,
    statConfidence: statCall?.confidence ?? null,
    claudeConfidence: claudeCall?.confidence ?? null,
    mlConfidence,
  };

  // Negative EV skip
  if (ev !== null && ev < -0.05) {
    return skip(`Negative EV (${ev.toFixed(3)}) at current yes price ${yesPrice?.toFixed(2)}`, signals);
  }

  const threshold = config.signalThreshold;

  if (signalsAgreeing < threshold) {
    return skip(
      `Only ${signalsAgreeing}/${total} signals agree (need ${threshold})`,
      signals,
    );
  }

  if (agreementTarget === null) return skip("Could not determine direction", signals);
  const action = agreementTarget;

  const confidence = total > 0 ? Math.max(40, Math.round((signalsAgreeing / total) * 100)) : 50;

  // Confidence threshold gate: skip if the signal agreement isn't strong enough
  if (confidence < config.minConfidence) {
    return skip(
      `Confidence ${confidence}% below threshold ${config.minConfidence}% — skipping`,
      { ...signals, signalsAgreeing, signalsTotal: total, agreementTarget },
    );
  }

  const parts: string[] = [];
  if (statAbove !== null) parts.push(`Stat: ${statAbove ? "ABOVE" : "BELOW"}`);
  if (claudeAbove !== null) parts.push(`Claude: ${claudeAbove ? "ABOVE" : "BELOW"}`);
  if (mlAbove !== null) parts.push(`ML: ${mlAbove ? "ABOVE" : "BELOW"}`);
  if (wmRec) parts.push(`WM: ${wmRec.toUpperCase()}`);
  if (yesPrice !== null) parts.push(`Yes@${(yesPrice * 100).toFixed(0)}¢`);
  if (ev !== null) parts.push(`EV=${ev.toFixed(3)}`);

  return {
    action,
    confidence,
    reasoning: `${signalsAgreeing}/${total} signals → ${action}. ${parts.join(", ")}`,
    signals,
  };
}

function skip(reasoning: string, signals: SignalSnapshot): BotDecision {
  return { action: "SKIP", confidence: 0, reasoning, signals };
}
