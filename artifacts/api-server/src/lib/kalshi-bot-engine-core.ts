// Pure, zero-dependency decision core for the Kalshi bot.
//
// No imports from ./crypto or any DB/API module — this file is intentionally
// isolated so it can be unit-tested without any I/O setup.
//
// Entry paths:
//
//   PATH A — Core pair (Stat+Claude agree):
//     Both signals present and agree → BET.  Base 65%.
//     Single signal present → BET with half-pair base 60%.
//     ML and WM are boosters: each adds +8% when they agree.
//
//   PATH B — ML tiebreaker (Stat+Claude disagree):
//     ML model must be ready with mlConfidence ≥ ML_PRIMARY_MIN_CONFIDENCE.
//     ML decides the direction; each agreeing signal (stat/claude/WM) adds
//     ML_SIGNAL_BOOST (6%).
//
//   PATH C — ML primary (no core signals available):
//     ML model must be ready with mlConfidence ≥ ML_PRIMARY_MIN_CONFIDENCE.
//     ML decides direction; WM agreement adds ML_SIGNAL_BOOST.
//
// Final gates applied to all paths: EV gate, minConfidence gate.

export type BotDecisionAction = "BET_YES" | "BET_NO" | "SKIP";

// Base confidence when the core pair (Stat+Claude) both agree.
export const BASE_CONFIDENCE_FULL_PAIR = 65;
// Base confidence when only one core signal is available (other still null).
export const BASE_CONFIDENCE_HALF_PAIR = 60;
// Each supporting signal (ML, WM) adds this amount when it agrees — Path A only.
export const CONFIDENCE_BOOST_PER_SIGNAL = 8;
// Minimum ML confidence required for ML to lead (Path B or C).
export const ML_PRIMARY_MIN_CONFIDENCE = 58;
// Each agreeing signal (stat/claude/WM) adds this when ML leads (Paths B & C).
export const ML_SIGNAL_BOOST = 6;

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeEV(yesPrice: number | null, signalAccuracyPct: number | null): number | null {
  if (yesPrice == null || yesPrice <= 0 || signalAccuracyPct == null) return null;
  const accFrac = signalAccuracyPct / 100;
  const winPayoff = (1 - yesPrice) / yesPrice;
  return accFrac * winPayoff - (1 - accFrac);
}

function countSignals(
  direction: boolean,
  statAbove: boolean | null,
  claudeAbove: boolean | null,
  mlAbove: boolean | null,
  wmDriftAbove: boolean | null,
): { signalsTotal: number; signalsAgreeing: number } {
  const all = [statAbove, claudeAbove, mlAbove, wmDriftAbove];
  return {
    signalsTotal:    all.filter((x) => x !== null).length,
    signalsAgreeing: all.filter((x) => x === direction).length,
  };
}

/**
 * Pure decision function — all inputs are values, no I/O.
 *
 * See module header for the three entry paths (A / B / C).
 */
export function computeCorePairDecision(inp: CorePairInputs): CorePairResult {
  const skip = (reason: string, ev: number | null = null): CorePairResult => ({
    action: "SKIP", confidence: 0, reasoning: reason,
    signalsAgreeing: 0, signalsTotal: 0, ev,
  });

  if (!inp.kalshiTicker) {
    return skip("No active Kalshi market for this symbol");
  }

  const ev = computeEV(inp.yesPrice, inp.signalAccuracyPct);

  // EV gate — applied to all paths
  if (ev !== null && ev < -0.05) {
    return {
      action: "SKIP", confidence: 0,
      reasoning: `Negative EV (${ev.toFixed(3)}) at yes=${inp.yesPrice?.toFixed(2)} acc=${inp.signalAccuracyPct?.toFixed(0)}%`,
      signalsAgreeing: 0, signalsTotal: 0, ev,
    };
  }

  // Whether the ML model is ready to lead an entry
  const mlLeadReady =
    inp.mlAbove !== null &&
    inp.mlConfidence != null &&
    inp.mlConfidence >= ML_PRIMARY_MIN_CONFIDENCE;

  // ── CORE-PAIR GATE ────────────────────────────────────────────────────────
  const corePair = ([inp.statAbove, inp.claudeAbove] as (boolean | null)[]).filter(
    (x): x is boolean => x !== null,
  );

  if (corePair.length >= 1) {
    const coreDirection = corePair[0];
    const coreAgree = corePair.every((x) => x === coreDirection);

    if (coreAgree) {
      // ── PATH A: Stat+Claude agree ─────────────────────────────────────────
      const action: BotDecisionAction = coreDirection ? "BET_YES" : "BET_NO";
      const base = corePair.length >= 2 ? BASE_CONFIDENCE_FULL_PAIR : BASE_CONFIDENCE_HALF_PAIR;
      let confidence = base;

      if (inp.mlAbove !== null && inp.mlAbove === coreDirection) confidence += CONFIDENCE_BOOST_PER_SIGNAL;
      if (inp.wmDriftAbove !== null && inp.wmDriftAbove === coreDirection) confidence += CONFIDENCE_BOOST_PER_SIGNAL;

      if (confidence < inp.minConfidence) {
        const { signalsAgreeing, signalsTotal } = countSignals(coreDirection, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
        return {
          action: "SKIP", confidence,
          reasoning: `Confidence ${confidence}% below minimum ${inp.minConfidence}%`,
          signalsAgreeing, signalsTotal, ev,
        };
      }

      const { signalsAgreeing, signalsTotal } = countSignals(coreDirection, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);

      const corePairDesc = [
        inp.statAbove !== null ? `Stat:${inp.statAbove === coreDirection ? "✓" : "✗"}` : "Stat:—",
        inp.claudeAbove !== null ? `Claude:${inp.claudeAbove === coreDirection ? "✓" : "✗"}` : "Claude:—",
      ].join(" ");
      const boosterParts: string[] = [];
      if (inp.mlAbove !== null) boosterParts.push(`ML:${inp.mlAbove === coreDirection ? `+${CONFIDENCE_BOOST_PER_SIGNAL}` : "—"}`);
      if (inp.wmDriftAbove !== null) boosterParts.push(`WM:${inp.wmDriftAbove === coreDirection ? `+${CONFIDENCE_BOOST_PER_SIGNAL}` : "—"}`);
      const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";
      const boosterDesc = boosterParts.length ? ` | ${boosterParts.join(" ")}` : "";

      return {
        action, confidence, ev, signalsAgreeing, signalsTotal,
        reasoning: `core pair: ${corePairDesc}${boosterDesc} → ${action} (${confidence}%)${evDesc}`,
      };
    }

    // ── PATH B: Stat+Claude disagree — ML tiebreaker ──────────────────────
    if (!mlLeadReady) {
      return skip(
        `Core signals disagree: Stat=${inp.statAbove} vs Claude=${inp.claudeAbove}`,
        ev,
      );
    }

    const mlDir = inp.mlAbove as boolean;
    const action: BotDecisionAction = mlDir ? "BET_YES" : "BET_NO";
    let confidence = inp.mlConfidence as number;
    if (inp.statAbove === mlDir)    confidence += ML_SIGNAL_BOOST;
    if (inp.claudeAbove === mlDir)  confidence += ML_SIGNAL_BOOST;
    if (inp.wmDriftAbove === mlDir) confidence += ML_SIGNAL_BOOST;

    if (confidence < inp.minConfidence) {
      const { signalsAgreeing, signalsTotal } = countSignals(mlDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
      return {
        action: "SKIP", confidence,
        reasoning: `Confidence ${confidence}% below minimum ${inp.minConfidence}% (ML tiebreaker)`,
        signalsAgreeing, signalsTotal, ev,
      };
    }

    const { signalsAgreeing, signalsTotal } = countSignals(mlDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
    const agreeDesc = [
      `ML:✓(${Math.round(inp.mlConfidence as number)}%)`,
      inp.statAbove === mlDir ? "Stat:✓" : `Stat:✗(${inp.statAbove})`,
      inp.claudeAbove === mlDir ? "Claude:✓" : `Claude:✗(${inp.claudeAbove})`,
    ].join(" ");
    const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";

    return {
      action, confidence, ev, signalsAgreeing, signalsTotal,
      reasoning: `ML tiebreaker: ${agreeDesc} → ${action} (${confidence}%)${evDesc}`,
    };
  }

  // ── PATH C: No core signals — ML leads solo ───────────────────────────────
  if (!mlLeadReady) {
    return skip("No core signals (Stat/Claude) available", ev);
  }

  const mlDir = inp.mlAbove as boolean;
  const action: BotDecisionAction = mlDir ? "BET_YES" : "BET_NO";
  let confidence = inp.mlConfidence as number;
  if (inp.wmDriftAbove === mlDir) confidence += ML_SIGNAL_BOOST;

  if (confidence < inp.minConfidence) {
    const { signalsAgreeing, signalsTotal } = countSignals(mlDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
    return {
      action: "SKIP", confidence,
      reasoning: `Confidence ${confidence}% below minimum ${inp.minConfidence}% (ML primary)`,
      signalsAgreeing, signalsTotal, ev,
    };
  }

  const { signalsAgreeing, signalsTotal } = countSignals(mlDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
  const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";

  return {
    action, confidence, ev, signalsAgreeing, signalsTotal,
    reasoning: `ML primary: ML:✓(${Math.round(confidence)}%) Stat:— Claude:— → ${action}${evDesc}`,
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
 *
 * Disable modes:
 *   maxConsecutiveLosses <= 0  → breaker never triggers (streak still tracked)
 *   pauseWindows === 0         → breaker never triggers
 */
export function applyBetOutcome(
  state: CircuitBreakerState,
  won: boolean,
  maxConsecutiveLosses: number,
  pauseWindows: number,
): CircuitBreakerState {
  if (won) {
    return { consecutiveLosses: 0, circuitBreakerWindowsRemaining: 0 };
  }
  const newConsecutive = state.consecutiveLosses + 1;
  const canTrigger = maxConsecutiveLosses > 0 && pauseWindows > 0;
  const shouldTrigger = canTrigger && newConsecutive >= maxConsecutiveLosses;
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

// ---------------------------------------------------------------------------
// Regime detection — momentum / price-trend helpers
// ---------------------------------------------------------------------------

export type PriceRegime = "trending_up" | "trending_down" | "ranging";

/**
 * Derives a simple price regime from a chronological list of recent strike prices.
 * Requires at least 2 data points; returns "ranging" when insufficient data.
 */
export function deriveRegime(recentStrikes: number[], windowCount: number = 3): PriceRegime {
  if (recentStrikes.length < 2) return "ranging";
  const relevant = recentStrikes.slice(-Math.max(2, windowCount));
  let allUp = true;
  let allDown = true;
  for (let i = 1; i < relevant.length; i++) {
    if (relevant[i] <= relevant[i - 1]) allUp = false;
    if (relevant[i] >= relevant[i - 1]) allDown = false;
  }
  if (allUp) return "trending_up";
  if (allDown) return "trending_down";
  return "ranging";
}

/**
 * Returns true when the proposed bet direction is clearly opposed by multi-window
 * momentum — i.e., the price has moved consistently against the bet direction for
 * `windowCount` consecutive windows AND the cumulative move exceeds the threshold.
 */
export function checkMomentumOverride(
  proposedDirection: "yes" | "no",
  recentStrikes: number[],
  cumulativeThresholdPct: number = 0.5,
  windowCount: number = 3,
): boolean {
  if (recentStrikes.length < windowCount + 1) return false;
  const relevant = recentStrikes.slice(-(windowCount + 1));

  let allUp = true;
  let allDown = true;
  for (let i = 1; i < relevant.length; i++) {
    if (relevant[i] <= relevant[i - 1]) allUp = false;
    if (relevant[i] >= relevant[i - 1]) allDown = false;
  }
  if (!allUp && !allDown) return false;

  const oldest = relevant[0];
  const newest = relevant[relevant.length - 1];
  const pctMove = Math.abs((newest - oldest) / oldest * 100);
  if (pctMove < cumulativeThresholdPct) return false;

  if (allUp && proposedDirection === "no") return true;
  if (allDown && proposedDirection === "yes") return true;
  return false;
}
