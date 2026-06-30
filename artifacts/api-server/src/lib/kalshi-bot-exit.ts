// Kalshi bot exit guard — two-phase exit policy.
//
// Phase 1 (minutes 1–11): Hold through noise. Multiple guards must ALL clear
// before recommending exit. Biased toward holding to avoid panic-selling winners.
//
// Phase 2 (minutes 11–14): Damage control. When clearly losing with no realistic
// path back, actively hunt for the best available exit price rather than riding
// to near-zero at expiry.

import { getStatWindowCall, getTrackerWindowCall, getWindowBetSignal } from "./crypto";

export type ExitRecommendation = "HOLD" | "EXIT";

export interface Phase1State {
  adverseTickCount: number;    // consecutive ticks where price moved against position
  entryPrice: number;          // Yes price at entry (0-1 fraction)
  entryTime: number;           // ms timestamp of bet entry
  lastYesPrice: number | null; // most recent yes price seen
}

export interface Phase2State {
  activatedAt: number | null;   // ms timestamp when Phase 2 first activated
  recentLow: number | null;     // lowest yes price since activation (used for YES positions)
  recentHigh: number | null;    // highest yes price since activation (used for NO positions)
  lastYesPrice: number | null;
}

export interface ExitState {
  phase1: Phase1State;
  phase2: Phase2State;
}

export interface ExitGuardResult {
  recommendation: ExitRecommendation;
  reason: string;
  phase: 1 | 2;
  guardStates: GuardStates;
}

export interface GuardStates {
  // Phase 1 guards
  holdDurationOk: boolean;     // min 4 min hold satisfied (want: false to allow exit)
  flipConfirmed: boolean;      // 3+ consecutive adverse ticks
  magnitudeOk: boolean;        // yes price moved >20pp against entry
  consensusOk: boolean;        // stat + Claude both agree reversal
  timingOverride: boolean;     // current minute has ≥70% accuracy → force hold
  erOk: boolean;               // ER ≥ 0.3 (not pure chop)
  // Phase 2
  phase2Active: boolean;
  phase2UptickDetected: boolean;
  phase2Timeout: boolean;      // 2 min elapsed with no uptick
  phase2YesPrice: number | null;
  phase2RecentLow: number | null;
}

// mid-exit sensitivity thresholds
const SENSITIVITY: Record<string, { adverseTicks: number; magnitudePp: number }> = {
  conservative: { adverseTicks: 4, magnitudePp: 25 },
  balanced:     { adverseTicks: 3, magnitudePp: 20 },
  aggressive:   { adverseTicks: 2, magnitudePp: 15 },
};

export function runExitGuard(
  symbol: string,
  direction: "yes" | "no",
  minutesElapsed: number,
  currentYesPrice: number | null,
  state: ExitState,
  timingAccuracyPct: number | null,
  erValue: number | null,
  sensitivity: "conservative" | "balanced" | "aggressive",
  phase2ThresholdPp: number,
): ExitGuardResult {
  const { adverseTicks, magnitudePp } = SENSITIVITY[sensitivity];

  // Update tick tracking
  const entryPrice = state.phase1.entryPrice;
  const yp = currentYesPrice;

  // Compute yes-price deviation from entry (pp = percentage points 0-100)
  // For YES bets: losing if yes price falls below entry
  // For NO bets: losing if yes price rises above entry
  let priceMovePp = 0;
  let isAdverseTick = false;
  if (yp !== null && entryPrice > 0) {
    if (direction === "yes") {
      priceMovePp = (entryPrice - yp) * 100;
      isAdverseTick = yp < entryPrice;
    } else {
      priceMovePp = (yp - entryPrice) * 100;
      isAdverseTick = yp > entryPrice;
    }
  }

  // Update adverse tick count
  if (isAdverseTick) {
    state.phase1.adverseTickCount++;
  } else {
    state.phase1.adverseTickCount = 0;
  }
  state.phase1.lastYesPrice = yp;

  // ── PHASE 2 CHECK ─────────────────────────────────────────────────────────
  // Activate when: yes price far below entry, all models agree wrong direction,
  // ER momentum confirms, and fewer than 4 minutes remain

  // "fewer than 4 minutes remain" in a 15-min window: 15 - minutesElapsed < 4 → minutesElapsed > 11
  const isPhase2Time = minutesElapsed > 11;
  const isLossBeyondThreshold = priceMovePp >= phase2ThresholdPp;
  const isLowYesPrice = direction === "yes"
    ? (yp !== null && yp < 0.35)
    : (yp !== null && yp > 0.65);

  // Reversal signal: at least one of stat or Claude must agree reversal is underway.
  // Previously required both — but when Claude lags (stays bullish while market crashes),
  // the exit guard never clears. "Either" is more responsive while still filtering noise.
  const statCall = getStatWindowCall(symbol.toUpperCase());
  const claudeCall = getTrackerWindowCall(symbol.toUpperCase());
  const wmSignal = getWindowBetSignal(symbol.toUpperCase());
  const wmDriftAbove = wmSignal?.factors != null ? wmSignal.factors.netDriftPct > 0 : null;

  let modelsAgreeWrong = false;
  const hasAnyStat = statCall != null && statCall.aboveKalshi !== null;
  const hasAnyClaude = claudeCall != null && claudeCall.aboveKalshi !== null;
  if (hasAnyStat || hasAnyClaude) {
    if (direction === "yes") {
      // Either stat OR Claude sees BELOW → reversal confirmed
      const statSaysBelow   = hasAnyStat   && statCall!.aboveKalshi === false;
      const claudeSaysBelow = hasAnyClaude && claudeCall!.aboveKalshi === false;
      const coreAgree = statSaysBelow || claudeSaysBelow;
      const wmAgree   = wmDriftAbove === null || wmDriftAbove === false;
      modelsAgreeWrong = coreAgree && wmAgree;
    } else {
      const statSaysAbove   = hasAnyStat   && statCall!.aboveKalshi === true;
      const claudeSaysAbove = hasAnyClaude && claudeCall!.aboveKalshi === true;
      const coreAgree = statSaysAbove || claudeSaysAbove;
      const wmAgree   = wmDriftAbove === null || wmDriftAbove === true;
      modelsAgreeWrong = coreAgree && wmAgree;
    }
  }

  // Emergency magnitude exit: if loss is extreme (≥40pp) regardless of model consensus,
  // activate Phase 2 damage control. Prevents catastrophic losses when models lag.
  const isEmergencyLoss = priceMovePp >= 40;

  // ER momentum confirms (>0.3 means directional, not random chop)
  const erConfirms = erValue !== null && erValue >= 0.3;

  // Phase 2 activates on normal conditions OR emergency loss (≥40pp), even mid-window,
  // so the bot doesn't ride a clear bleed-out to zero.
  const shouldActivatePhase2 =
    (isPhase2Time && isLossBeyondThreshold && isLowYesPrice && modelsAgreeWrong && erConfirms)
    || (isEmergencyLoss && isLowYesPrice);

  if (shouldActivatePhase2 && state.phase2.activatedAt === null) {
    state.phase2.activatedAt = Date.now();
    // Seed the tracking extreme for this direction
    if (direction === "yes") {
      state.phase2.recentLow = yp;
    } else {
      state.phase2.recentHigh = yp;
    }
  }

  const phase2Active = state.phase2.activatedAt !== null;

  if (phase2Active) {
    // YES positions track the lowest yes price seen (recovery = price rises back)
    // NO  positions track the highest yes price seen (recovery = price falls back)
    if (direction === "yes") {
      if (yp !== null && (state.phase2.recentLow === null || yp < state.phase2.recentLow)) {
        state.phase2.recentLow = yp;
      }
    } else {
      if (yp !== null && (state.phase2.recentHigh === null || yp > state.phase2.recentHigh)) {
        state.phase2.recentHigh = yp;
      }
    }
    state.phase2.lastYesPrice = yp;

    const phase2ElapsedMs = Date.now() - (state.phase2.activatedAt ?? Date.now());
    const phase2Timeout = phase2ElapsedMs >= 2 * 60_000;

    // Recovery signal: position is no longer bleeding as badly
    // YES: yes price rose ≥5pp from its recent low      → EXIT (salvage what's left)
    // NO:  yes price fell ≥5pp from its recent high     → EXIT
    let recoveryDetected = false;
    let recoveryMagnitudePp = 0;
    if (direction === "yes") {
      const recentLow = state.phase2.recentLow ?? yp ?? entryPrice;
      recoveryMagnitudePp = yp !== null ? (yp - recentLow) * 100 : 0;
      recoveryDetected = yp !== null && recoveryMagnitudePp >= 5;
    } else {
      const recentHigh = state.phase2.recentHigh ?? yp ?? entryPrice;
      recoveryMagnitudePp = yp !== null ? (recentHigh - yp) * 100 : 0;
      recoveryDetected = yp !== null && recoveryMagnitudePp >= 5;
    }

    const recentExtreme = direction === "yes"
      ? (state.phase2.recentLow ?? yp)
      : (state.phase2.recentHigh ?? yp);

    const guardStates: GuardStates = {
      holdDurationOk: false, flipConfirmed: false, magnitudeOk: false,
      consensusOk: false, timingOverride: false, erOk: false,
      phase2Active: true,
      phase2UptickDetected: recoveryDetected,
      phase2Timeout,
      phase2YesPrice: yp,
      phase2RecentLow: recentExtreme,
    };

    if (recoveryDetected) {
      const dir = direction === "yes" ? "rose" : "fell";
      return {
        recommendation: "EXIT",
        reason: `Phase 2: Yes price ${dir} ${recoveryMagnitudePp.toFixed(1)}pp from extreme — best available exit`,
        phase: 2,
        guardStates,
      };
    }
    if (phase2Timeout) {
      return {
        recommendation: "EXIT",
        reason: "Phase 2: 2-min timeout — exiting at market to avoid expiry-at-zero",
        phase: 2,
        guardStates,
      };
    }
    return {
      recommendation: "HOLD",
      reason: "Phase 2 active — watching for recovery before exiting",
      phase: 2,
      guardStates,
    };
  }

  // ── PHASE 1 GUARDS ────────────────────────────────────────────────────────

  const holdDurationMs = Date.now() - state.phase1.entryTime;
  const holdDurationOk = holdDurationMs >= 4 * 60_000;
  const flipConfirmed = state.phase1.adverseTickCount >= adverseTicks;
  const magnitudeOk = priceMovePp >= magnitudePp;

  // Model consensus: either stat OR Claude must agree on adverse direction.
  // Previously required both — which prevented exit when Claude lagged a price crash.
  let consensusOk = false;
  if (hasAnyStat || hasAnyClaude) {
    if (direction === "yes") {
      const statSaysBelow   = hasAnyStat   && statCall!.aboveKalshi === false;
      const claudeSaysBelow = hasAnyClaude && claudeCall!.aboveKalshi === false;
      const coreAgree = statSaysBelow || claudeSaysBelow;
      const wmAgree   = wmDriftAbove === null || wmDriftAbove === false;
      consensusOk = coreAgree && wmAgree;
    } else {
      const statSaysAbove   = hasAnyStat   && statCall!.aboveKalshi === true;
      const claudeSaysAbove = hasAnyClaude && claudeCall!.aboveKalshi === true;
      const coreAgree = statSaysAbove || claudeSaysAbove;
      const wmAgree   = wmDriftAbove === null || wmDriftAbove === true;
      consensusOk = coreAgree && wmAgree;
    }
  }

  // Timing accuracy override: if ≥70% accuracy at this minute, hold
  const timingOverride = timingAccuracyPct !== null && timingAccuracyPct >= 70;

  // ER regime: choppy (< 0.3) = suppress exit
  const erOk = erValue === null || erValue >= 0.3;

  const guardStates: GuardStates = {
    holdDurationOk, flipConfirmed, magnitudeOk, consensusOk, timingOverride, erOk,
    phase2Active: false, phase2UptickDetected: false, phase2Timeout: false,
    phase2YesPrice: yp, phase2RecentLow: null,
  };

  // Timing override: always hold if high accuracy at this minute
  if (timingOverride) {
    return {
      recommendation: "HOLD",
      reason: `Timing accuracy ${timingAccuracyPct?.toFixed(0)}% at min ${minutesElapsed} — holding`,
      phase: 1,
      guardStates,
    };
  }

  // All phase-1 guards must clear simultaneously
  const allGuardsClear = holdDurationOk && flipConfirmed && magnitudeOk && consensusOk && erOk;
  if (allGuardsClear) {
    return {
      recommendation: "EXIT",
      reason: `Phase 1: all guards cleared — ${adverseTicks} adverse ticks, ${priceMovePp.toFixed(1)}pp vs entry, model consensus`,
      phase: 1,
      guardStates,
    };
  }

  const blockers: string[] = [];
  if (!holdDurationOk) blockers.push("hold<4min");
  if (!flipConfirmed) blockers.push(`${state.phase1.adverseTickCount}/${adverseTicks} ticks`);
  if (!magnitudeOk) blockers.push(`${priceMovePp.toFixed(1)}pp<${magnitudePp}pp`);
  if (!consensusOk) blockers.push("no consensus");
  if (!erOk) blockers.push("choppy");

  return {
    recommendation: "HOLD",
    reason: `Phase 1: holding — ${blockers.join(", ")}`,
    phase: 1,
    guardStates,
  };
}

export function makeInitialExitState(entryPrice: number): ExitState {
  return {
    phase1: {
      adverseTickCount: 0,
      entryPrice,
      entryTime: Date.now(),
      lastYesPrice: entryPrice,
    },
    phase2: {
      activatedAt: null,
      recentLow: null,
      recentHigh: null,
      lastYesPrice: null,
    },
  };
}
