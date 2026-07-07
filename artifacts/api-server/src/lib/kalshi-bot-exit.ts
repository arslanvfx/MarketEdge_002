// Kalshi bot exit guard — two-phase exit policy.
//
// Phase 1 (minutes 1–11): Hold through noise. Multiple guards must ALL clear
// before recommending exit. Biased toward holding to avoid panic-selling winners.
//
// Phase 2 (minutes 11–14): Damage control. When clearly losing with no realistic
// path back, actively hunt for the best available exit price rather than riding
// to near-zero at expiry.

import { getStatWindowCall, getTrackerWindowCall, getWindowBetSignal, getLastMLAbove } from "./crypto";
import { checkSignalDivergenceCutout, DIVERGENCE_MAX_MINUTES, DIVERGENCE_PRICE_FLOOR_MULT } from "./kalshi-bot-engine-core";

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
  mlFlipped: boolean;          // ML direction opposes open position (supports exit)
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
  entrySignals?: { statAbove: boolean | null; claudeAbove: boolean | null; mlAbove: boolean | null },
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

  // ML direction signal — true when the ML model predicts the position is going wrong.
  const mlAbove = getLastMLAbove(symbol);
  const mlFlipped = mlAbove !== null && (
    (direction === "yes" && mlAbove === false) ||
    (direction === "no"  && mlAbove === true)
  );

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

    // Recovery signal: price has bounced from its extreme AND sell value has recovered
    // to ≥ 50% of the original entry cost.  This prevents exiting on the first tick
    // of any minor uptick — we wait through the downturn for a genuine recovery that
    // restores at least half the investment before cashing out.
    // YES: yes price rose ≥5pp from recent low AND sell value ≥ 50% of entry cost
    // NO:  yes price fell ≥5pp from recent high AND sell value ≥ 50% of entry cost
    let recoveryDetected = false;
    let recoveryMagnitudePp = 0;
    const entryCost = direction === "yes" ? entryPrice : (1 - entryPrice);
    const sellValue = yp !== null ? (direction === "yes" ? yp : (1 - yp)) : null;
    const recoveryRatio = sellValue !== null ? sellValue / Math.max(entryCost, 0.01) : 0;
    if (direction === "yes") {
      const recentLow = state.phase2.recentLow ?? yp ?? entryPrice;
      recoveryMagnitudePp = yp !== null ? (yp - recentLow) * 100 : 0;
      recoveryDetected = yp !== null && recoveryMagnitudePp >= 5 && recoveryRatio >= 0.50;
    } else {
      const recentHigh = state.phase2.recentHigh ?? yp ?? entryPrice;
      recoveryMagnitudePp = yp !== null ? (recentHigh - yp) * 100 : 0;
      recoveryDetected = yp !== null && recoveryMagnitudePp >= 5 && recoveryRatio >= 0.50;
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
      mlFlipped,
    };

    if (recoveryDetected) {
      const dir = direction === "yes" ? "rose" : "fell";
      return {
        recommendation: "EXIT",
        reason: `Phase 2: Yes price ${dir} ${recoveryMagnitudePp.toFixed(1)}pp from extreme, recovered ${(recoveryRatio * 100).toFixed(0)}% of entry cost — best exit`,
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

  // ── SIGNAL DIVERGENCE EARLY-EXIT CUTOUT ─────────────────────────────────
  // Fires before Phase 1 guards when ≥2 of 3 signals that were FOR the bet
  // at entry have since flipped AGAINST it, while still early (<8 min) and
  // while the contract still retains ≥50% of entry value.
  if (entrySignals != null) {
    const currentStatAbove   = statCall?.aboveKalshi ?? null;
    const currentClaudeAbove = claudeCall?.aboveKalshi ?? null;
    const divergence = checkSignalDivergenceCutout(
      direction,
      minutesElapsed,
      yp,
      entryPrice,
      entrySignals,
      currentStatAbove,
      currentClaudeAbove,
      mlAbove,
    );
    if (divergence.triggered) {
      const divGuardStates: GuardStates = {
        holdDurationOk: false, flipConfirmed: false, magnitudeOk: false,
        consensusOk: false, timingOverride: false, erOk: false,
        mlFlipped,
        phase2Active: false, phase2UptickDetected: false, phase2Timeout: false,
        phase2YesPrice: yp, phase2RecentLow: null,
      };
      return {
        recommendation: "EXIT",
        reason: divergence.reason,
        phase: 1,
        guardStates: divGuardStates,
      };
    }
  }

  // ── PHASE 1 GUARDS ────────────────────────────────────────────────────────

  const holdDurationMs = Date.now() - state.phase1.entryTime;
  const holdDurationOk = holdDurationMs >= 2 * 60_000;
  const flipConfirmed = state.phase1.adverseTickCount >= adverseTicks;
  const magnitudeOk = priceMovePp >= magnitudePp;

  // Model consensus: vote-based across stat, Claude, WM, and ML (one vote each).
  // Requires ≥2 adverse votes AND at least one core model (stat or Claude) voting
  // adverse. ML can count as a second vote (strengthens consensus) but cannot
  // trigger exit alone. ML disagreeing does not block exit if ≥2 others agree.
  let statSaysAdverse = false;
  let claudeSaysAdverse = false;
  let adverseVotes = 0;
  if (hasAnyStat) {
    statSaysAdverse = direction === "yes"
      ? statCall!.aboveKalshi === false
      : statCall!.aboveKalshi === true;
    if (statSaysAdverse) adverseVotes++;
  }
  if (hasAnyClaude) {
    claudeSaysAdverse = direction === "yes"
      ? claudeCall!.aboveKalshi === false
      : claudeCall!.aboveKalshi === true;
    if (claudeSaysAdverse) adverseVotes++;
  }
  if (mlAbove !== null && mlFlipped) adverseVotes++;
  if (wmDriftAbove !== null) {
    const wmSaysAdverse = direction === "yes" ? !wmDriftAbove : wmDriftAbove;
    if (wmSaysAdverse) adverseVotes++;
  }
  const consensusOk = adverseVotes >= 2 && (statSaysAdverse || claudeSaysAdverse);

  // Timing accuracy override: if ≥70% accuracy at this minute, hold
  const timingOverride = timingAccuracyPct !== null && timingAccuracyPct >= 70;

  // ER regime: choppy (< 0.3) = suppress exit
  const erOk = erValue === null || erValue >= 0.3;

  const guardStates: GuardStates = {
    holdDurationOk, flipConfirmed, magnitudeOk, consensusOk, timingOverride, erOk,
    mlFlipped,
    phase2Active: false, phase2UptickDetected: false, phase2Timeout: false,
    phase2YesPrice: yp, phase2RecentLow: null,
  };

  // Fast-flip path: stat AND Claude unanimously signal reversal AND ML agrees.
  // All three models must confirm the direction has shifted before cutting the
  // loss early — this prevents premature exits caused by short-term noise in
  // stat or Claude when the ML model still supports the original position.
  const bothCoreFlipped = statSaysAdverse && claudeSaysAdverse;
  const holdMinimumForFlip = holdDurationMs >= 90_000;
  if (bothCoreFlipped && mlFlipped && holdMinimumForFlip && !timingOverride) {
    return {
      recommendation: "EXIT",
      reason: `Fast flip: stat + Claude + ML all signal reversal after ${Math.round(holdDurationMs / 1000)}s — cutting to allow re-entry`,
      phase: 1,
      guardStates,
    };
  }

  // Strike-cross urgency exit for NO bets.
  // When a NO position has been open for 3+ minutes and the yes price has
  // clearly moved above 0.60 (market pricing >60% chance the price is ABOVE
  // the strike) with at least one model confirming, exit rather than ride to
  // near-certain full loss at expiry.  This is more sensitive than full
  // Phase 1 because NO reversals (price bouncing back above strike after we
  // bet it would stay below) are the dominant loss pattern.
  if (
    direction === "no" &&
    holdDurationMs >= 3 * 60_000 &&
    yp !== null && yp > 0.60 &&
    !timingOverride &&
    (statSaysAdverse || claudeSaysAdverse || mlFlipped)
  ) {
    return {
      recommendation: "EXIT",
      reason: `Strike-cross urgency: NO bet, yes price ${(yp * 100).toFixed(0)}¢ (market says ABOVE strike) with model confirmation after ${Math.round(holdDurationMs / 60_000)}min`,
      phase: 1,
      guardStates,
    };
  }

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
