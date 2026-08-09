// Durable order-fill confirmation state machine (pure — broker calls injected).
//
// Invariant: the caller must NEVER abandon an order without either
//   (a) a confirmed terminal broker state, or
//   (b) an "unknown" outcome, which the caller MUST treat as possibly-filled
//       and persist a tracked (provisional) position for reconciliation.
// A cancel request can race a partial/full fill, and any status/cancel call
// can fail transiently — so every broker interaction here is retried, and
// uncertainty is surfaced explicitly instead of being swallowed.

export interface OrderStatusLike {
  status: string; // new | partially_filled | filled | canceled | expired | rejected | done_for_day ...
  filledQty: number;
  filledAvgPrice: number | null;
}

export interface ConfirmOrderDeps {
  getStatus: () => Promise<OrderStatusLike>;
  cancel: () => Promise<void>;
  /** Injected sleep for testability. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll attempts while waiting for a fill (default 5). */
  pollAttempts?: number;
  pollDelayMs?: number;
  /** Retries per individual broker call (default 3). */
  callRetries?: number;
}

export type ConfirmOutcome =
  | { outcome: "filled"; filledQty: number; filledAvgPrice: number }
  | { outcome: "partial"; filledQty: number; filledAvgPrice: number }
  | { outcome: "unfilled" }
  /** Terminal state could not be confirmed — caller must track the order as possibly filled. */
  | { outcome: "unknown" };

const TERMINAL_DEAD = ["canceled", "expired", "rejected", "done_for_day"];

async function withRetries<T>(fn: () => Promise<T>, retries: number, sleep: (ms: number) => Promise<void>): Promise<T | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch {
      if (i < retries) await sleep(300 * (i + 1));
    }
  }
  return null;
}

function fromStatus(st: OrderStatusLike): ConfirmOutcome | null {
  if (st.status === "filled" && st.filledAvgPrice != null && st.filledQty > 0) {
    return { outcome: "filled", filledQty: st.filledQty, filledAvgPrice: st.filledAvgPrice };
  }
  if (TERMINAL_DEAD.includes(st.status)) {
    // Partial fill before death still opened real exposure.
    if (st.filledQty > 0 && st.filledAvgPrice != null) {
      return { outcome: "partial", filledQty: st.filledQty, filledAvgPrice: st.filledAvgPrice };
    }
    return { outcome: "unfilled" };
  }
  return null; // still working
}

/**
 * Wait for a fill; if none arrives, cancel and confirm the terminal state.
 * Returns "unknown" ONLY when the broker's terminal state could not be
 * established despite retries.
 */
export async function confirmOrderFill(deps: ConfirmOrderDeps): Promise<ConfirmOutcome> {
  const sleep = deps.sleep ?? ((ms) => new Promise<void>(r => setTimeout(r, ms)));
  const pollAttempts = deps.pollAttempts ?? 5;
  const pollDelayMs = deps.pollDelayMs ?? 700;
  const callRetries = deps.callRetries ?? 3;

  // Phase 1: poll for a fill.
  for (let i = 0; i < pollAttempts; i++) {
    const st = await withRetries(deps.getStatus, callRetries, sleep);
    if (st != null) {
      const terminal = fromStatus(st);
      if (terminal) return terminal;
    }
    await sleep(pollDelayMs);
  }

  // Phase 2: not filled in time — cancel, then CONFIRM the terminal state
  // (cancel may race a fill; a failed cancel call proves nothing).
  await withRetries(deps.cancel, callRetries, sleep);
  for (let i = 0; i < callRetries + 2; i++) {
    const st = await withRetries(deps.getStatus, callRetries, sleep);
    if (st != null) {
      const terminal = fromStatus(st);
      if (terminal) return terminal;
      // Still shows as working post-cancel — cancel may not have landed; retry it.
      await withRetries(deps.cancel, callRetries, sleep);
    }
    await sleep(pollDelayMs);
  }

  // Terminal state unconfirmed — caller must persist a provisional position.
  return { outcome: "unknown" };
}

// ── Provisional-position reconciliation planner (pure) ─────────────────────
// A provisional row was persisted assuming a worst-case full fill at the
// limit price because the broker's terminal state was unknown. On each
// management cycle the caller re-confirms the entry order and applies:
//   - close_never_filled: order died with zero fill → the position never
//     existed; close the DB row without touching broker positions.
//   - adopt_fill: real fill confirmed (possibly partial, possibly a LATE fill
//     after the outage) → rewrite qty/entry price from broker truth and clear
//     the provisional flag; normal management resumes from real numbers.
//   - keep_provisional: still unknown → the row must stay open and MUST NOT
//     be exited or marked flat this cycle (a broker 404 proves nothing while
//     the entry order may still be working).
export type ProvisionalPlan =
  | { action: "close_never_filled" }
  | { action: "adopt_fill"; filledQty: number; filledAvgPrice: number }
  | { action: "keep_provisional" };

export function planProvisionalReconciliation(outcome: ConfirmOutcome): ProvisionalPlan {
  switch (outcome.outcome) {
    case "unfilled":
      return { action: "close_never_filled" };
    case "filled":
    case "partial":
      return { action: "adopt_fill", filledQty: outcome.filledQty, filledAvgPrice: outcome.filledAvgPrice };
    default:
      return { action: "keep_provisional" };
  }
}
