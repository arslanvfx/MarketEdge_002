// Pure, zero-dependency decision core for the Kalshi bot.
//
// No imports from ./crypto or any DB/API module — this file is intentionally
// isolated so it can be unit-tested without any I/O setup.
//
// Signal priority (highest to lowest):
//
//   PATH A — ML primary:
//     ML model is ready (mlConfidence ≥ ML_PRIMARY_MIN_CONFIDENCE).
//     ML decides the direction; each agreeing validator (Claude, Stat, WM)
//     adds ML_SIGNAL_BOOST (6%) to the base ML confidence score.
//
//   PATH B — Claude primary (ML not ready):
//     Claude decides the direction.  Stat must agree or be absent; if Stat
//     disagrees there is no tiebreaker — the window is skipped.
//     WM agreement adds CONFIDENCE_BOOST_PER_SIGNAL (8%).
//
//   PATH C — Stat primary (no ML, no Claude):
//     Stat decides the direction.  Base = statConfidence or
//     BASE_CONFIDENCE_HALF_PAIR (60%).  WM adds CONFIDENCE_BOOST_PER_SIGNAL.
//
// Final gates applied to all paths: EV gate, minConfidence gate.

export type BotDecisionAction = "BET_YES" | "BET_NO" | "SKIP";

// Base confidence when Claude+Stat both agree (Path B full pair).
export const BASE_CONFIDENCE_FULL_PAIR = 65;
// Base confidence when only one of Claude/Stat is available (Path B/C half pair).
export const BASE_CONFIDENCE_HALF_PAIR = 60;
// Each validating signal adds this when it agrees in Path B/C (WM).
export const CONFIDENCE_BOOST_PER_SIGNAL = 8;
// Minimum ML confidence required for ML to lead (Path A).
export const ML_PRIMARY_MIN_CONFIDENCE = 62;
// Each agreeing validator (Claude, Stat, WM) adds this when ML leads (Path A).
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
 * See module header for the three priority paths (A / B / C).
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

  // Whether the ML model is ready to lead
  let mlLeadReady =
    inp.mlAbove !== null &&
    inp.mlConfidence != null &&
    inp.mlConfidence >= ML_PRIMARY_MIN_CONFIDENCE;

  // Veto PATH A when the core pair (Stat + Claude) are BOTH available and BOTH
  // oppose ML's direction.  When two independent signals unanimously disagree
  // with ML, the core pair is more reliable for direction — let PATH B/C decide.
  if (
    mlLeadReady &&
    inp.mlAbove !== null &&
    inp.statAbove !== null && inp.claudeAbove !== null &&
    inp.statAbove !== inp.mlAbove && inp.claudeAbove !== inp.mlAbove
  ) {
    mlLeadReady = false;
  }

  // ── PATH A: ML primary ────────────────────────────────────────────────────
  if (mlLeadReady) {
    const mlDir = inp.mlAbove as boolean;
    const action: BotDecisionAction = mlDir ? "BET_YES" : "BET_NO";

    // Guard: when ML is the ONLY available signal (no Stat, no Claude) and WM
    // signals caution, skip rather than betting on a single unvalidated signal.
    if (inp.statAbove === null && inp.claudeAbove === null && inp.wmRec === "caution") {
      return skip(
        `ML only + caution: no core signals to validate ML(${mlDir}) and WM signals caution — skipping`,
        ev,
      );
    }

    let confidence = inp.mlConfidence as number;

    if (inp.claudeAbove === mlDir) confidence += ML_SIGNAL_BOOST;
    if (inp.statAbove   === mlDir) confidence += ML_SIGNAL_BOOST;
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

    const claudeDesc = inp.claudeAbove !== null
      ? `Claude:${inp.claudeAbove === mlDir ? `+${ML_SIGNAL_BOOST}` : "—"}`
      : "Claude:—";
    const statDesc = inp.statAbove !== null
      ? `Stat:${inp.statAbove === mlDir ? `+${ML_SIGNAL_BOOST}` : "—"}`
      : "Stat:—";
    const wmDesc = inp.wmDriftAbove !== null
      ? `WM:${inp.wmDriftAbove === mlDir ? `+${ML_SIGNAL_BOOST}` : "—"}`
      : "";
    const validators = [claudeDesc, statDesc, wmDesc].filter(Boolean).join(" ");
    const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";

    return {
      action, confidence, ev, signalsAgreeing, signalsTotal,
      reasoning: `ML primary: ML:✓(${Math.round(inp.mlConfidence as number)}%) ${validators} → ${action} (${confidence}%)${evDesc}`,
    };
  }

  // ── PATH B: Claude primary (ML not ready) ─────────────────────────────────
  if (inp.claudeAbove !== null) {
    const claudeDir = inp.claudeAbove;
    const action: BotDecisionAction = claudeDir ? "BET_YES" : "BET_NO";

    // If Stat is available and disagrees with Claude → no tiebreaker, skip
    if (inp.statAbove !== null && inp.statAbove !== claudeDir) {
      return skip(
        `Claude and Stat disagree: Claude=${claudeDir} Stat=${inp.statAbove} — no ML to arbitrate`,
        ev,
      );
    }

    const base = inp.statAbove === claudeDir ? BASE_CONFIDENCE_FULL_PAIR : BASE_CONFIDENCE_HALF_PAIR;
    let confidence = base;
    if (inp.wmDriftAbove === claudeDir) confidence += CONFIDENCE_BOOST_PER_SIGNAL;

    if (confidence < inp.minConfidence) {
      const { signalsAgreeing, signalsTotal } = countSignals(claudeDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
      return {
        action: "SKIP", confidence,
        reasoning: `Confidence ${confidence}% below minimum ${inp.minConfidence}% (Claude primary)`,
        signalsAgreeing, signalsTotal, ev,
      };
    }

    const { signalsAgreeing, signalsTotal } = countSignals(claudeDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);

    const statDesc = inp.statAbove !== null ? `Stat:✓` : "Stat:—";
    const wmBoostDesc = inp.wmDriftAbove === claudeDir ? ` WM:+${CONFIDENCE_BOOST_PER_SIGNAL}` : "";
    const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";

    return {
      action, confidence, ev, signalsAgreeing, signalsTotal,
      reasoning: `Claude primary: Claude:✓ ${statDesc}${wmBoostDesc} → ${action} (${confidence}%)${evDesc}`,
    };
  }

  // ── PATH C: Stat primary (no ML, no Claude) ───────────────────────────────
  if (inp.statAbove !== null) {
    const statDir = inp.statAbove;
    const action: BotDecisionAction = statDir ? "BET_YES" : "BET_NO";
    const base = inp.statConfidence != null
      ? Math.max(inp.statConfidence, 50)
      : BASE_CONFIDENCE_HALF_PAIR;
    let confidence = base;
    if (inp.wmDriftAbove === statDir) confidence += CONFIDENCE_BOOST_PER_SIGNAL;

    if (confidence < inp.minConfidence) {
      const { signalsAgreeing, signalsTotal } = countSignals(statDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
      return {
        action: "SKIP", confidence,
        reasoning: `Confidence ${confidence}% below minimum ${inp.minConfidence}% (Stat primary)`,
        signalsAgreeing, signalsTotal, ev,
      };
    }

    const { signalsAgreeing, signalsTotal } = countSignals(statDir, inp.statAbove, inp.claudeAbove, inp.mlAbove, inp.wmDriftAbove);
    const wmBoostDesc = inp.wmDriftAbove === statDir ? ` WM:+${CONFIDENCE_BOOST_PER_SIGNAL}` : "";
    const evDesc = ev !== null ? ` EV=${ev.toFixed(3)}` : "";

    return {
      action, confidence, ev, signalsAgreeing, signalsTotal,
      reasoning: `Stat primary: Stat:✓(${Math.round(base)}%)${wmBoostDesc} → ${action} (${confidence}%)${evDesc}`,
    };
  }

  // ── No signals ────────────────────────────────────────────────────────────
  return skip("No signals available", ev);
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

// ---------------------------------------------------------------------------
// Bot configuration types and defaults
//
// Defined here (zero-dependency file) so they can be imported by unit tests
// without pulling in the ./crypto or DB modules.
// ---------------------------------------------------------------------------

export type DecisionMode = "classic" | "ml_gate" | "consensus" | "unanimous";

export interface BotConfig {
  betSize: number;           // $ per bet (default 0.50)
  dailyLossLimit: number;    // $ max daily loss (default 20)
  signalThreshold: number;   // kept for config compat — not used for entry gating (see core-pair gate)
  minConfidence: number;     // 0-100; skip bet when engine confidence is below this (default 60)
  decisionMode: DecisionMode; // which signal-combination logic to use (default "classic")
  midExitSensitivity: "conservative" | "balanced" | "aggressive";
  phase2ThresholdPp: number; // pp below entry to activate phase 2 (default 30)
  maxEntryMinutes: number;   // ceiling: don't enter after this many minutes into the window; 0 = disabled (no ceiling)
  minRemainingMinutes: number; // floor: don't enter when fewer than this many minutes remain; 0 = disabled (no floor)
  maxBetsPerWindow: number;  // how many separate bets the bot may place per 15-min window (default 3)
  enabled: boolean;          // master kill-switch
  quietHoursStart: number;   // UTC hour (0-23) when quiet period starts — no new entries (default 12)
  quietHoursEnd: number;     // UTC hour (0-23) when quiet period ends (default 18); set equal to start to disable
  maxConsecutiveLosses: number;     // trigger circuit breaker after this many consecutive losses (default 3)
  circuitBreakerPauseWindows: number; // windows to skip after circuit breaker triggers (default 2)
  // Directional balance filter: caps correlated exposure by limiting same-direction
  // bets in one window. Set enableDirectionCap=false or maxSameDirectionBets=0 to disable.
  enableDirectionCap: boolean;   // (default true)
  maxSameDirectionBets: number;  // max YES or NO bets per 15-min window (default 3)
  // Momentum filter: prevents betting against a clear multi-window price trend.
  // Set enableMomentumFilter=false to disable.
  enableMomentumFilter: boolean; // (default true)
  momentumWindowCount: number;   // consecutive windows required to trigger (default 3)
  // Self-learning auto-tune: when enabled the bot periodically analyses its own
  // recent performance and applies safe parameter adjustments automatically.
  enableAutoTuning: boolean;     // (default true)
  autoTuneWindowSize: number;    // number of most-recent settled bets to analyse (default 100)
  // Border-proximity guard: skip bets when price has been hovering too close to the
  // Kalshi strike in recent settled windows (high-noise, near-50/50 outcome territory).
  enableBorderGuard: boolean;    // (default true)
  borderProximityPct: number;    // skip if avg |closePrice−strike|/strike < this % (default 0.3)
  borderLookbackBets: number;    // how many most-recent settled bets to examine per coin (default 3)
  // Regime filter: how many confidence-points to deduct when the bot would bet
  // against the recent settlement direction. Set to 0 to disable the penalty entirely.
  regimePenalty: number;         // pp deducted for against-regime bets (default 8)
  // Paper trading simulation parameters (only used in paper mode).
  // paperStartingBalance: the wallet amount before any bets are counted.
  // paperWinReturnRate: profit as a fraction of betSize on a winning bet (0.5 = +50¢ per $1 bet).
  // paperBalanceResetAt: ISO timestamp of the last manual wallet reset; bets before this are ignored.
  paperStartingBalance: number;  // (default 100)
  paperWinReturnRate: number;    // (default 0.5)
  paperBalanceResetAt: string | null; // (default null = count all bets)
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  betSize: 1.00,
  dailyLossLimit: 20,
  signalThreshold: 2,    // legacy field — core-pair gate now governs entry
  minConfidence: 52,
  decisionMode: "classic",
  midExitSensitivity: "balanced",
  phase2ThresholdPp: 30,
  // Ceiling: 0 = disabled (no ceiling — enter at any point in the window).
  maxEntryMinutes: 0,
  // Floor: skip entry when fewer than 2 minutes remain in the 15-min window.
  // 0 = disabled.
  minRemainingMinutes: 2,
  // Allow up to 6 re-entries per coin per window.
  maxBetsPerWindow: 6,
  enabled: true,
  // start === end → disabled; 7 = 07:00 UTC stored value (set equal to disable)
  quietHoursStart: 7,
  quietHoursEnd: 7,
  // 0 = disabled (no circuit breaker on consecutive losses)
  maxConsecutiveLosses: 0,
  circuitBreakerPauseWindows: 2,
  enableDirectionCap: true,
  maxSameDirectionBets: 6,
  enableMomentumFilter: true,
  momentumWindowCount: 3,
  enableAutoTuning: true,
  autoTuneWindowSize: 100,
  // Border guard disabled by default — only enable if specific proximity issues seen
  enableBorderGuard: false,
  borderProximityPct: 0.1,
  borderLookbackBets: 3,
  // Regime penalty: 8pp deduction for against-regime bets (softer than the original 15pp)
  regimePenalty: 8,
  // Paper trading defaults
  paperStartingBalance: 100,
  paperWinReturnRate: 0.50,
  paperBalanceResetAt: null,
};
