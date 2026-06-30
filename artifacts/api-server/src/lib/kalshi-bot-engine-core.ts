// Pure, zero-dependency decision core for the Kalshi bot.
//
// No imports from ./crypto or any DB/API module — this file is intentionally
// isolated so it can be unit-tested without any I/O setup.

export type BotDecisionAction = "BET_YES" | "BET_NO" | "SKIP";

// Base confidence when the core pair (Stat+Claude) both agree.
export const BASE_CONFIDENCE_FULL_PAIR = 65;
// Base confidence when only one core signal is available (other still null).
export const BASE_CONFIDENCE_HALF_PAIR = 60;
// Each supporting signal (ML, WM) adds this amount when it agrees.
export const CONFIDENCE_BOOST_PER_SIGNAL = 8;

export interface CorePairInputs {
  statAbove: boolean | null;
  claudeAbove: boolean | null;
  mlAbove: boolean | null;
  wmDriftAbove: boolean | null;   // null when WM is not ready or not recommending "bet"
  wmRec: "bet" | "stay_away" | "caution" | null;
  wmReady: boolean;
  yesPrice: number | null;
  signalAccuracyPct: number | null;
  minutesElapsed: number;
  statConfidence: number | null;
  claudeConfidence: number | null;
  mlConfidence: number | null;
  kalshiTicker: string | null;
  minConfidence: number;
}

export interface CorePairResult {
  action: BotDecisionAction;
  confidence: number;
  reasoning: string;
  signalsAgreeing: number;
  signalsTotal: number;
  ev: number | null;
}

/**
 * Pure decision function — all inputs are values, no I/O.
 *
 * Entry gate:
 *   - At least one of Stat/Claude must be non-null.
 *   - All non-null core signals must agree (Stat vs Claude disagree → SKIP).
 *   - ML and WM are confidence boosters only; they cannot block entry.
 *
 * Confidence:
 *   - Base: 65% (both Stat+Claude present) or 60% (only one present).
 *   - Each booster that agrees adds +8%.
 *
 * EV gate:
 *   - Uses signalAccuracyPct (from prediction_records) — not bot win rate.
 *   - ev = accFrac × winPayoff − (1 − accFrac). Skips if ev < −0.05.
 */
export function computeCorePairDecision(inp: CorePairInputs): CorePairResult {
  const skip = (reason: string): CorePairResult => ({
    action: "SKIP", confidence: 0, reasoning: reason,
    signalsAgreeing: 0, signalsTotal: 0, ev: null,
  });

  if (!inp.kalshiTicker) {
    return skip("No active Kalshi market for this symbol");
  }

  // ── CORE-PAIR GATE ────────────────────────────────────────────────────────
  const corePair = ([inp.statAbove, inp.claudeAbove] as (boolean | null)[]).filter(
    (x): x is boolean => x !== null,
  );

  if (corePair.length === 0) {
    return skip("No core signals (Stat/Claude) available");
  }

  const coreDirection = corePair[0];
  if (!corePair.every((x) => x === coreDirection)) {
    return skip(
      `Core signals disagree: Stat=${inp.statAbove} vs Claude=${inp.claudeAbove}`,
    );
  }

  const action: BotDecisionAction = coreDirection ? "BET_YES" : "BET_NO";

  // ── CONFIDENCE BOOSTERS ───────────────────────────────────────────────────
  const base = corePair.length >= 2 ? BASE_CONFIDENCE_FULL_PAIR : BASE_CONFIDENCE_HALF_PAIR;
  let confidence = base;

  if (inp.mlAbove !== null && inp.mlAbove === coreDirection) confidence += CONFIDENCE_BOOST_PER_SIGNAL;
  if (inp.wmDriftAbove !== null && inp.wmDriftAbove === coreDirection) confidence += CONFIDENCE_BOOST_PER_SIGNAL;

  // Agree/total counts (for dashboard display)
  const allDirectional: (boolean | null)[] = [
    inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove,
  ];
  const signalsTotal    = allDirectional.filter((x) => x !== null).length;
  const signalsAgreeing = allDirectional.filter((x) => x === coreDirection).length;

  // ── EV CALCULATION ────────────────────────────────────────────────────────
  let ev: number | null = null;
  if (inp.yesPrice !== null && inp.yesPrice > 0 && inp.signalAccuracyPct !== null) {
    const accFrac = inp.signalAccuracyPct / 100;
    const winPayoff = (1 - inp.yesPrice) / inp.yesPrice;
    ev = accFrac * winPayoff - (1 - accFrac);
  }

  if (ev !== null && ev < -0.05) {
    return {
      action: "SKIP", confidence: 0,
      reasoning: `Negative EV (${ev.toFixed(3)}) at yes=${inp.yesPrice?.toFixed(2)} acc=${inp.signalAccuracyPct?.toFixed(0)}%`,
      signalsAgreeing, signalsTotal, ev,
    };
  }

  // Minimum confidence gate
  if (confidence < inp.minConfidence) {
    return {
      action: "SKIP", confidence,
      reasoning: `Confidence ${confidence}% below minimum ${inp.minConfidence}%`,
      signalsAgreeing, signalsTotal, ev,
    };
  }

  // ── REASONING STRING ──────────────────────────────────────────────────────
  const corePairDesc = [
    inp.statAbove !== null ? `Stat:${inp.statAbove === coreDirection ? "✓" : "✗"}` : "Stat:—",
    inp.claudeAbove !== null ? `Claude:${inp.claudeAbove === coreDirection ? "✓" : "✗"}` : "Claude:—",
  ].join(" ");

  const boosterParts: string[] = [];
  if (inp.mlAbove !== null) {
    boosterParts.push(`ML:${inp.mlAbove === coreDirection ? `+${CONFIDENCE_BOOST_PER_SIGNAL}` : "—"}`);
  }
  if (inp.wmDriftAbove !== null) {
    boosterParts.push(`WM:${inp.wmDriftAbove === coreDirection ? `+${CONFIDENCE_BOOST_PER_SIGNAL}` : "—"}`);
  }

  const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";
  const boosterDesc = boosterParts.length ? ` | ${boosterParts.join(" ")}` : "";
  return {
    action, confidence, ev, signalsAgreeing, signalsTotal,
    reasoning: `core pair: ${corePairDesc}${boosterDesc} → ${action} (${confidence}%)${evDesc}`,
  };
}

// ---------------------------------------------------------------------------
// Quiet-hours gate (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Returns true if the given UTC hour falls within the quiet-hours window.
 * When start === end, quiet hours are disabled (always returns false).
 * Handles midnight wrap (e.g. start=22, end=6 blocks 22:00–05:59).
 */
export function isInQuietHours(utcHour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return utcHour >= start && utcHour < end;
  return utcHour >= start || utcHour < end;
}

// ---------------------------------------------------------------------------
// Circuit-breaker state helpers (pure, testable)
// ---------------------------------------------------------------------------

export interface CircuitBreakerState {
  consecutiveLosses: number;
  circuitBreakerWindowsRemaining: number;
}

/**
 * Returns updated circuit-breaker state after a single bet outcome.
 * A win resets the consecutive-loss streak; a loss increments it and triggers
 * the breaker when maxConsecutiveLosses is first reached.
 */
export function applyBetOutcome(
  state: CircuitBreakerState,
  won: boolean,
  maxConsecutiveLosses: number,
  pauseWindows: number,
): CircuitBreakerState {
  if (won) {
    return { consecutiveLosses: 0, circuitBreakerWindowsRemaining: state.circuitBreakerWindowsRemaining };
  }
  const newConsecutive = state.consecutiveLosses + 1;
  const shouldTrigger = newConsecutive >= maxConsecutiveLosses && pauseWindows > 0;
  return {
    consecutiveLosses: newConsecutive,
    circuitBreakerWindowsRemaining: shouldTrigger
      ? pauseWindows
      : state.circuitBreakerWindowsRemaining,
  };
}

/**
 * Decrements the circuit-breaker window countdown by 1 (clamped at 0).
 * Called once per new 15-minute window when the breaker is active.
 */
export function tickCircuitBreakerWindow(state: CircuitBreakerState): CircuitBreakerState {
  return {
    ...state,
    circuitBreakerWindowsRemaining: Math.max(0, state.circuitBreakerWindowsRemaining - 1),
  };
}
