// ---------------------------------------------------------------------------
// Resting full-size entry lifecycle (pure, unit-testable)
// ---------------------------------------------------------------------------
// Real-book conviction entries place ONE good-till-canceled (GTC) limit order
// for the FULL computed contract count at the zone-capped limit price and let
// it rest on the book, exactly like the Kalshi app.  Market makers fill it
// within seconds.  The order is cancelled when any of these fire first:
//   • price leaves the conviction zone (checked by the caller each poll),
//   • the 3-minute late-entry hard floor is reached,
//   • a bounded max rest time elapses (default 75 s).
// A server-side expiration_time backstop guarantees the order can never outlive
// the window even if the bot process restarts.
//
// Empty-book poller-fallback entries stay FOK all-or-nothing (no resting order).
//
// This module supersedes kalshi-entry-remainder.ts (the old one-shot IOC
// remainder logic), which relied on repeated same-price re-submissions.

export interface RestingEntryPlan {
  /** Whether to place a resting GTC order (false → caller uses FOK/IOC path). */
  useResting: boolean;
  /** Contract count for the resting order (the full requested size). */
  count: number;
  /** Unix seconds for the server-side expiration backstop. */
  expirationTimeSec: number;
  /** Milliseconds the bot will actively poll/cancel before giving up. */
  maxRestMs: number;
  /** Human-readable reason when useResting=false. */
  skipReason: string | null;
}

export interface RestingEntryPlanArgs {
  usedPollerFallback: boolean;
  /** Full contract count the operator's bet size resolved to. */
  requestedCount: number;
  /** Milliseconds remaining in the window, computed fresh at decision time. */
  msRemaining: number;
  /** Minimum window time (ms) required to place a resting entry. */
  minRemainingMs?: number;
  /** Bounded active rest time before the bot cancels an unfilled order. */
  maxRestMs?: number;
  /** Current wall-clock time (ms) — injected for deterministic tests. */
  nowMs: number;
}

const DEFAULT_MIN_REMAINING_MS = 3 * 60_000; // 3-min hard floor
const DEFAULT_MAX_REST_MS = 75_000;          // 75 s active poll-and-cancel budget

/**
 * Decide whether to place a resting full-size entry order and, if so, compute
 * its lifetime.  Pure: no I/O.
 */
export function planRestingEntry(a: RestingEntryPlanArgs): RestingEntryPlan {
  const minRemainingMs = a.minRemainingMs ?? DEFAULT_MIN_REMAINING_MS;
  const maxRestMs      = a.maxRestMs ?? DEFAULT_MAX_REST_MS;

  if (a.usedPollerFallback) {
    return {
      useResting: false, count: a.requestedCount, expirationTimeSec: 0, maxRestMs,
      skipReason: "poller-fallback path — empty book stays FOK all-or-nothing",
    };
  }
  if (a.requestedCount < 1) {
    return {
      useResting: false, count: a.requestedCount, expirationTimeSec: 0, maxRestMs,
      skipReason: "requested count < 1 — nothing to place",
    };
  }
  if (a.msRemaining < minRemainingMs) {
    return {
      useResting: false, count: a.requestedCount, expirationTimeSec: 0, maxRestMs,
      skipReason: `only ${(a.msRemaining / 60000).toFixed(2)} min left — below ${(minRemainingMs / 60000).toFixed(0)}-min hard floor`,
    };
  }

  // Expiration backstop: the sooner of (a) max rest budget, (b) the 3-min
  // hard floor before window close.  Never let the resting order live past the
  // point where a fill would be too late to be worth holding.
  const restDeadlineMs  = a.nowMs + maxRestMs;
  const floorDeadlineMs = a.nowMs + (a.msRemaining - minRemainingMs);
  const expirationMs    = Math.min(restDeadlineMs, floorDeadlineMs);
  const expirationTimeSec = Math.max(a.nowMs / 1000 + 1, Math.floor(expirationMs / 1000));

  return {
    useResting: true,
    count: a.requestedCount,
    expirationTimeSec,
    maxRestMs,
    skipReason: null,
  };
}

// ---------------------------------------------------------------------------
// Cancel-decision for an in-flight resting order (pure)
// ---------------------------------------------------------------------------
export interface RestingCancelArgs {
  /** Whether the live price is still inside the conviction entry zone. */
  inZone: boolean;
  /** Milliseconds the order has been resting so far. */
  elapsedMs: number;
  /** Bounded active rest budget. */
  maxRestMs: number;
  /** Milliseconds remaining in the window right now. */
  msRemaining: number;
  /** Minimum window time (ms) required to keep the order alive. */
  minRemainingMs?: number;
}

export interface RestingCancelDecision {
  cancel: boolean;
  reason: string | null;
}

export function decideRestingCancel(a: RestingCancelArgs): RestingCancelDecision {
  const minRemainingMs = a.minRemainingMs ?? DEFAULT_MIN_REMAINING_MS;
  if (!a.inZone)                       return { cancel: true, reason: "price left conviction zone" };
  if (a.msRemaining < minRemainingMs)  return { cancel: true, reason: "3-min hard floor reached" };
  if (a.elapsedMs >= a.maxRestMs)      return { cancel: true, reason: "max rest time elapsed" };
  return { cancel: false, reason: null };
}

// ---------------------------------------------------------------------------
// Partial-then-cancel fill accounting (pure)
// ---------------------------------------------------------------------------
// After the resting order is cancelled (or filled), record the position using
// the ACTUAL filled count and the actual weighted-average fill price — never
// the originally requested count.  A cancel with a partial fill produces a
// smaller-but-correct position; a cancel with zero fills produces no position.
export interface RestingFillResult {
  /** Contracts actually filled (0 = no position). */
  filledCount: number;
  /** Weighted-average YES-side fill price (null when nothing filled). */
  avgYesPrice: number | null;
}

export interface RestingFillArgs {
  requestedCount: number;
  filledCount: number;
  avgYesPrice: number | null;
}

export function accountRestingFill(a: RestingFillArgs): RestingFillResult {
  const filled = Math.max(0, Math.min(a.filledCount, a.requestedCount));
  return {
    filledCount: filled,
    avgYesPrice: filled > 0 ? a.avgYesPrice : null,
  };
}
