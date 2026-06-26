// ── Auto-pilot decision logic (pure, dependency-free) ────────────────────────
// The subtle per-coin rules that decide whether Claude is "earning its keep"
// live here, isolated from the data layer so they can be unit-tested without a
// database or the analytics pipeline. crypto.ts gathers the live accuracy stats
// and feeds them in; this module is a pure function of its inputs.
//
// Guardrails encoded here:
//  • min-sample gating — never act on a thin sample (need a stat baseline)
//  • exploration — when a coin lacks enough Claude history to judge, briefly run
//    Claude (within the cap, lower priority than proven winners) to gather data
//  • hysteresis — turn ON only with a clear edge, stay ON until the edge clearly
//    erodes, so a coin doesn't flip on/off every tick around the break-even line
//  • global cap — at most N coins run Claude at once, for cost control

// Each model needs this many evaluated bets before a performance-based decision.
export const AUTOPILOT_MIN_SAMPLES = 8;
// Claude is turned ON when it beats stat by at least this many points…
export const AUTOPILOT_ON_MARGIN = 5;
// …and stays ON until its edge falls to this margin or below (hysteresis band).
export const AUTOPILOT_OFF_MARGIN = -2;
// Hard cap on coins auto-running Claude at once (cost control).
export const AUTOPILOT_MAX_ACTIVE = 3;
// Below this many evaluated Claude bets, a coin is "unproven" → explore to gather
// data rather than judging it on noise.
export const AUTOPILOT_EXPLORE_SAMPLES = 8;

export interface AutoPilotDecision {
  symbol: string;
  active: boolean; // is Claude auto-enabled for this coin right now?
  reason: string; // human-readable explanation surfaced in the UI
  exploring: boolean; // active only to gather Claude data (not yet proven)
  claudeAccuracyPct: number | null;
  statAccuracyPct: number | null;
  claudeN: number; // evaluated Claude bets backing the decision
  statN: number; // evaluated stat bets backing the decision
  marginPct: number | null; // claudeAccuracy − statAccuracy
}

// Live accuracy stats for one coin, plus whether auto-pilot had it on last tick
// (needed for hysteresis).
export interface AutoPilotInput {
  symbol: string;
  claudeAcc: number | null;
  statAcc: number | null;
  claudeN: number;
  statN: number;
  wasActive: boolean; // was Claude auto-active for this coin on the previous tick?
}

interface Candidate {
  symbol: string;
  claudeAcc: number | null;
  statAcc: number | null;
  claudeN: number;
  statN: number;
  margin: number | null;
  want: boolean; // wants to run Claude (before the global cap is applied)
  exploring: boolean;
  reason: string;
  priority: number; // cap ranking: higher kept first (winners > explorers)
}

// Per-coin auto-pilot decisions. Compares Claude vs the statistical model and
// decides whether Claude should run, honoring all guardrails. Returns one
// decision per input, in input order.
export function computeAutoPilotDecisions(inputs: AutoPilotInput[]): AutoPilotDecision[] {
  const candidates: Candidate[] = inputs.map(
    ({ symbol, claudeAcc, statAcc, claudeN, statN, wasActive }) => {
      const margin = claudeAcc != null && statAcc != null ? claudeAcc - statAcc : null;
      const base = { symbol, claudeAcc, statAcc, claudeN, statN, margin };

      // Need a trustworthy stat baseline to compare Claude against.
      if (statN < AUTOPILOT_MIN_SAMPLES || statAcc == null) {
        return {
          ...base,
          want: false,
          exploring: false,
          reason: `Building stat baseline (${statN}/${AUTOPILOT_MIN_SAMPLES} bets)`,
          priority: -1,
        };
      }
      // Not enough Claude history to judge → explore (run it to gather data).
      if (claudeN < AUTOPILOT_EXPLORE_SAMPLES || claudeAcc == null) {
        return {
          ...base,
          want: true,
          exploring: true,
          reason: `Gathering Claude data (${claudeN}/${AUTOPILOT_EXPLORE_SAMPLES} bets)`,
          priority: 0,
        };
      }
      // Both proven → performance decision with hysteresis.
      const want = wasActive ? margin! > AUTOPILOT_OFF_MARGIN : margin! >= AUTOPILOT_ON_MARGIN;
      const sign = margin! >= 0 ? "+" : "";
      const reason = want
        ? `Claude ${claudeAcc}% vs stat ${statAcc}% (${sign}${margin}%)`
        : `Claude ${claudeAcc}% vs stat ${statAcc}% (${sign}${margin}%) — paused`;
      return {
        ...base,
        want,
        exploring: false,
        reason,
        priority: 1 + Math.max(0, margin!), // proven winners outrank explorers
      };
    },
  );

  // Apply the global cap: proven winners (by edge) fill slots first, then explorers.
  const wanted = candidates.filter((c) => c.want).sort((a, b) => b.priority - a.priority);
  const activeSet = new Set(wanted.slice(0, AUTOPILOT_MAX_ACTIVE).map((c) => c.symbol));

  return candidates.map((c) => {
    const active = activeSet.has(c.symbol);
    const reason =
      c.want && !active
        ? `Capped — only ${AUTOPILOT_MAX_ACTIVE} coins run Claude at once`
        : c.reason;
    return {
      symbol: c.symbol,
      active,
      reason,
      exploring: active && c.exploring,
      claudeAccuracyPct: c.claudeAcc,
      statAccuracyPct: c.statAcc,
      claudeN: c.claudeN,
      statN: c.statN,
      marginPct: c.margin,
    };
  });
}

// Claude runs for a coin if the user manually enabled it OR auto-pilot chose it.
// Manual enablement is additive: it always wins regardless of auto-pilot state.
export function claudeEnabledFor(opts: {
  manualEnabled: boolean;
  autoPilotEnabled: boolean;
  autoActive: boolean;
}): boolean {
  if (opts.manualEnabled) return true;
  if (opts.autoPilotEnabled && opts.autoActive) return true;
  return false;
}
