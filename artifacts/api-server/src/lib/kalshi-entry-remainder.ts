// ---------------------------------------------------------------------------
// One-shot IOC remainder decision (pure, unit-testable)
// ---------------------------------------------------------------------------
// After a real-book IOC conviction entry partially fills, the bot may submit
// exactly ONE more IOC order for the unfilled remainder at the SAME limit
// price.  The hard invariant: at most TWO exchange orders per entry, total.
//
// The initial entry goes through placeEntryOrderWithSizeFallback, which may
// itself place a second (half-size) order after a 409 volume rejection.  When
// that fallback fired, the two-order budget is already spent — a remainder
// re-attempt here would be a THIRD exchange submission and is forbidden.
// The helper reports `attemptedCount` (the size of the order that actually
// produced the fill), so `attemptedCount < requestedCount` detects the
// fallback deterministically.
//
// All other guards:
//   • This optional follow-up is currently disabled at the call site. If it is
//     re-enabled, keep the two-order budget below intact for every IOC source.
//   • remainder counted against attemptedCount (the actual submitted size),
//     never the original requested count.
//   • ≥3 minutes must remain in the window (same hard floor as entry dispatch).

export interface RemainderDecisionArgs {
  usedPollerFallback: boolean;
  timeInForce: string;
  /** Contract count the bot originally asked the entry helper to place. */
  requestedCount: number;
  /** Contract count of the order that actually produced the fill (helper-reported). */
  attemptedCount: number;
  /** Contracts actually filled by that order. */
  filledCount: number;
  /** Minutes remaining in the window, computed fresh at decision time. */
  minutesRemaining: number;
}

export interface RemainderDecision {
  attempt: boolean;
  /** Contracts to submit if attempt=true (attemptedCount − filledCount). */
  remainder: number;
  /** Human-readable reason when attempt=false. */
  skipReason: string | null;
}

export function decideRemainderAttempt(a: RemainderDecisionArgs): RemainderDecision {
  const remainder = a.attemptedCount - a.filledCount;
  if (a.usedPollerFallback) {
    return { attempt: false, remainder, skipReason: "poller-fallback remainder is disabled at this decision boundary" };
  }
  if (a.timeInForce !== "immediate_or_cancel") {
    return { attempt: false, remainder, skipReason: `time-in-force ${a.timeInForce} — remainder applies to IOC only` };
  }
  if (a.attemptedCount < a.requestedCount) {
    // Half-size volume fallback already placed a second exchange order —
    // the two-order budget is spent.
    return { attempt: false, remainder, skipReason: "half-size volume fallback already used — two-order budget spent" };
  }
  if (remainder < 1) {
    return { attempt: false, remainder, skipReason: "no unfilled remainder" };
  }
  if (a.minutesRemaining < 3) {
    return { attempt: false, remainder, skipReason: `only ${a.minutesRemaining.toFixed(2)} min left — below 3-min hard floor` };
  }
  return { attempt: true, remainder, skipReason: null };
}
