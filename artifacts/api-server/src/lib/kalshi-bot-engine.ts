// Kalshi bot decision engine.
//
// Reads all available prediction signals for the current window and returns a
// BET_YES / BET_NO / SKIP decision with full reasoning logged.

import {
  getTrackerWindowCall,
  getStatWindowCall,
  getWindowBetSignal,
  type TrackerWindowCall,
  type WindowBetSignal,
} from "./crypto";

export interface BotConfig {
  betSize: number;           // $ per bet (default 0.50)
  dailyLossLimit: number;    // $ max daily loss (default 20)
  signalThreshold: number;   // min signals agreeing: 2 | 3 | 4 (default 3)
  midExitSensitivity: "conservative" | "balanced" | "aggressive";
  phase2ThresholdPp: number; // pp below entry to activate phase 2 (default 30)
  enabled: boolean;          // master kill-switch
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  betSize: 0.50,
  dailyLossLimit: 20,
  signalThreshold: 3,
  midExitSensitivity: "balanced",
  phase2ThresholdPp: 30,
  enabled: true,
};

export type BotDecisionAction = "BET_YES" | "BET_NO" | "SKIP";

export interface SignalSnapshot {
  statAbove: boolean | null;
  claudeAbove: boolean | null;
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

  // If no Kalshi ticker/market, we can't bet
  if (!kalshiTicker) {
    return skip("No active Kalshi market for this symbol", {
      statAbove, claudeAbove, windowMonitor: wmRec, windowMonitorReady: wmReady,
      yesPrice, ev: null, timingAccuracyPct, minutesElapsed,
      signalsAgreeing: 0, signalsTotal: 0, agreementTarget: null,
      statConfidence: statCall?.confidence ?? null,
      claudeConfidence: claudeCall?.confidence ?? null,
    });
  }

  // Window monitor override: stay_away = hard skip
  if (wmReady && wmRec === "stay_away") {
    return skip("Window Monitor says STAY AWAY — choppy/spike conditions", {
      statAbove, claudeAbove, windowMonitor: wmRec, windowMonitorReady: wmReady,
      yesPrice, ev: null, timingAccuracyPct, minutesElapsed,
      signalsAgreeing: 0, signalsTotal: 0, agreementTarget: null,
      statConfidence: statCall?.confidence ?? null,
      claudeConfidence: claudeCall?.confidence ?? null,
    });
  }

  // Count signal agreements
  const candidates: Array<{ above: boolean | null; weight: number }> = [
    { above: statAbove, weight: 1 },
    { above: claudeAbove, weight: 1 },
  ];

  // Window monitor as a directional signal only if it says "bet" and there's a drift direction
  const wmFactors = wmSignal?.factors;
  const wmDriftAbove = wmFactors
    ? wmFactors.netDriftPct > 0   // net drift direction as a proxy signal
    : null;
  if (wmReady && wmRec === "bet" && wmDriftAbove !== null) {
    candidates.push({ above: wmDriftAbove, weight: 1 });
  }

  // Timing accuracy as a meta-signal: if accuracy <45%, slight disagreement signal
  if (timingAccuracyPct !== null) {
    if (timingAccuracyPct < 45) {
      // Low accuracy minute mark — add a null vote (uncertainty)
      candidates.push({ above: null, weight: 1 });
    }
  }

  const yesAboveCount = candidates.filter((c) => c.above === true).length;
  const noAboveCount = candidates.filter((c) => c.above === false).length;
  const total = candidates.filter((c) => c.above !== null).length;

  let agreementTarget: BotDecisionAction | null = null;
  let signalsAgreeing = 0;
  if (yesAboveCount >= noAboveCount) {
    agreementTarget = "BET_YES";
    signalsAgreeing = yesAboveCount;
  } else {
    agreementTarget = "BET_NO";
    signalsAgreeing = noAboveCount;
  }

  // EV calculation
  let ev: number | null = null;
  if (yesPrice !== null && yesPrice > 0 && timingAccuracyPct !== null) {
    const accFrac = timingAccuracyPct / 100;
    // EV per $1 bet on YES: win (1-p)/p or lose 1
    // p = yes price fraction (0-1)
    const winPayoff = (1 - yesPrice) / yesPrice;
    ev = accFrac * winPayoff - (1 - accFrac);
  }

  // Negative EV skip
  if (ev !== null && ev < -0.05) {
    return skip(`Negative EV (${ev.toFixed(3)}) at current yes price ${yesPrice?.toFixed(2)}`, {
      statAbove, claudeAbove, windowMonitor: wmRec, windowMonitorReady: wmReady,
      yesPrice, ev, timingAccuracyPct, minutesElapsed,
      signalsAgreeing, signalsTotal: total, agreementTarget,
      statConfidence: statCall?.confidence ?? null,
      claudeConfidence: claudeCall?.confidence ?? null,
    });
  }

  const threshold = config.signalThreshold;
  const signals: SignalSnapshot = {
    statAbove, claudeAbove, windowMonitor: wmRec, windowMonitorReady: wmReady,
    yesPrice, ev, timingAccuracyPct, minutesElapsed,
    signalsAgreeing, signalsTotal: total, agreementTarget,
    statConfidence: statCall?.confidence ?? null,
    claudeConfidence: claudeCall?.confidence ?? null,
  };

  if (signalsAgreeing < threshold) {
    return skip(
      `Only ${signalsAgreeing}/${total} signals agree (need ${threshold})`,
      signals,
    );
  }

  // caution from Window Monitor is a confidence reducer but not a hard block
  const cautionPenalty = wmReady && wmRec === "caution" ? 10 : 0;
  const baseConfidence =
    total > 0 ? Math.round((signalsAgreeing / total) * 100) : 50;
  const confidence = Math.max(40, baseConfidence - cautionPenalty);

  if (agreementTarget === null) return skip("Could not determine direction", signals);
  const action = agreementTarget;

  const parts: string[] = [];
  if (statAbove !== null) parts.push(`Stat: ${statAbove ? "ABOVE" : "BELOW"}`);
  if (claudeAbove !== null) parts.push(`Claude: ${claudeAbove ? "ABOVE" : "BELOW"}`);
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
