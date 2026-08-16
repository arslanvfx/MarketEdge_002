// ---------------------------------------------------------------------------
// Pending entry-order reconcile before any sell (dependency-injected, testable)
// ---------------------------------------------------------------------------
// If a resting entry order is (or may still be) live on the exchange, it must
// be cancelled and CONFIRMED terminal before the position can be sold.
// Selling while an entry order can still fill creates a race: the entry fills
// after the sell and the bot ends up with an untracked live position (or an
// oversell rejection).
//
// Invariant enforced here: THROW unless the pending order is confirmed
// terminal (cancelled / filled / 404-gone).  Callers must treat the throw as
// "abort the exit, keep the position tracked, retry next tick" — never as a
// reason to drop the position.

export interface PendingEntryOrderState {
  filledCount: number;
  status: "resting" | "filled" | "cancelled" | "unknown";
  avgPrice: number | null;
}

export interface PendingEntryReconcileDeps {
  cancelOrder: (orderId: string) => Promise<boolean>;
  /** null = 404 — order no longer exists (terminal). */
  getOrder: (orderId: string) => Promise<PendingEntryOrderState | null>;
  log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
}

export interface PendingEntryReconcileResult {
  /** Contracts confirmed filled by the entry order (>= recordedCount when it kept filling). */
  actualCount: number;
  /** Weighted-average fill price when the exchange reported one. */
  avgPrice: number | null;
}

/**
 * Cancel a pending entry order and confirm it is terminal.
 * Returns the reconciled fill count (which may exceed the recorded count when
 * fills landed while the order was resting).
 * THROWS when terminal state cannot be confirmed — the caller MUST abort the
 * sell and keep the position tracked for retry.
 */
export async function reconcilePendingEntryOrder(
  a: { sym: string; pendingId: string; recordedCount: number },
  d: PendingEntryReconcileDeps,
): Promise<PendingEntryReconcileResult> {
  try {
    await d.cancelOrder(a.pendingId);
  } catch (err) {
    // Cancel may fail because the order already filled or expired — that is
    // fine as long as the terminal state can be read below.
    d.log.warn({ err, sym: a.sym, pendingId: a.pendingId }, "[kalshi-bot] pending entry cancel failed — checking order state");
  }

  let st: PendingEntryOrderState | null;
  try {
    st = await d.getOrder(a.pendingId);
  } catch (err) {
    d.log.error({ err, sym: a.sym, pendingId: a.pendingId }, "[kalshi-bot] cannot confirm pending entry order state — exit aborted, will retry");
    throw err;
  }

  if (st == null) {
    // 404 — order no longer exists on the exchange → terminal; keep recorded count.
    return { actualCount: a.recordedCount, avgPrice: null };
  }
  if (st.status !== "cancelled" && st.status !== "filled") {
    // Still live (or state unknown) and cancel unconfirmed — do NOT sell into
    // a live entry order.
    throw new Error(`pending entry order ${a.pendingId} still ${st.status} — aborting exit to avoid race`);
  }

  // Reconcile: the order may have filled more contracts than the position
  // recorded at entry time.  Sell the ACTUAL total.
  if (st.filledCount > a.recordedCount) {
    d.log.info(
      { sym: a.sym, recorded: a.recordedCount, actual: st.filledCount },
      "[kalshi-bot] pending entry filled more while resting — updating position count before exit",
    );
    return { actualCount: st.filledCount, avgPrice: st.avgPrice };
  }
  return { actualCount: a.recordedCount, avgPrice: st.avgPrice };
}
