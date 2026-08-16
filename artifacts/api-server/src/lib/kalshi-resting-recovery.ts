// ---------------------------------------------------------------------------
// Startup reconciliation of in-flight resting entry orders (DI, testable)
// ---------------------------------------------------------------------------
// A provisional "resting_pending" row is persisted BEFORE every resting entry
// order is placed (carrying the caller-owned client_order_id).  If the process
// crashes during the resting lifecycle, that row is the only durable link to
// the live order.  On startup this module resolves each pending row against
// the exchange:
//   • lookup by client id → confirmed absent = clean no-order
//   • order found → confirm terminal (cancel if still resting) and adopt any
//     fills that exceed what was recorded before the crash
//   • ANY unconfirmed state → row stays pending (fail closed, retried on the
//     next startup / reconcile pass) — never resolved on ambiguity.

export interface PendingRestingOrderRow {
  rowId: string;
  symbol: string;
  windowKey: string;
  ticker: string | null;
  direction: "yes" | "no";
  clientOrderId: string;
  /** Exchange order id if it was learned before the crash. */
  orderId: string | null;
  requestedCount: number;
  limitPrice: number | null;
}

export interface RecoveredOrderState {
  filledCount: number;
  status: "resting" | "filled" | "cancelled" | "unknown";
  avgPrice: number | null;
}

export interface RestingRecoveryDeps {
  findOrderIdByClientId: (clientOrderId: string) => Promise<string | null>;
  /** null = 404 — order no longer queryable. */
  getOrder: (orderId: string) => Promise<RecoveredOrderState | null>;
  cancelOrder: (orderId: string) => Promise<boolean>;
  /** Contracts already recorded in bet rows for this symbol/window (0 if none). */
  getRecordedCount: (row: PendingRestingOrderRow) => Promise<number>;
  /** Adopt fills that exceed the recorded count (upsert bet row / patch position). */
  adoptFills: (
    row: PendingRestingOrderRow,
    actual: { filledCount: number; avgPrice: number | null; recordedCount: number },
  ) => Promise<void>;
  markResolved: (row: PendingRestingOrderRow, note: string) => Promise<void>;
  log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
}

export type RecoveryOutcome = "resolved" | "left-pending";

/**
 * Pure merge of a recovered order's ACTUAL total fills into whatever partial
 * position was persisted before the crash.  The exchange's avgPrice covers the
 * ENTIRE order (all fills), so it is the correct entry price for the merged
 * position; the persisted partial price is superseded, not averaged again.
 * Returns the full replacement values for the open bet row — callers must
 * UPDATE the existing row (or insert one row with these values when none
 * exists), never append a delta row: position restore keys one row per
 * symbol and an appended delta would restore only part of the exposure.
 */
export function computeFillMerge(
  existing: { contractCount: number; entryYesPrice: number } | null,
  actual: { filledCount: number; avgPrice: number | null },
  direction: "yes" | "no",
  fallbackPrice: number | null,
): { contractCount: number; entryYesPrice: number; betAmount: number } {
  const entryYesPrice =
    actual.avgPrice ?? existing?.entryYesPrice ?? fallbackPrice ?? 0.5;
  const contractCount = Math.max(actual.filledCount, existing?.contractCount ?? 0);
  const betAmount = direction === "yes"
    ? contractCount * entryYesPrice
    : contractCount * (1 - entryYesPrice);
  return { contractCount, entryYesPrice, betAmount };
}

/**
 * Reconcile ONE pending resting-order row against the exchange.
 * "left-pending" means the exchange state could not be confirmed — the row
 * must stay pending so a later pass retries (fail closed).
 */
export async function reconcilePendingRestingOrder(
  row: PendingRestingOrderRow,
  d: RestingRecoveryDeps,
): Promise<RecoveryOutcome> {
  // 1) Resolve the exchange order id (persisted, or looked up by client id).
  let orderId = row.orderId;
  if (orderId == null) {
    try {
      orderId = await d.findOrderIdByClientId(row.clientOrderId);
    } catch (err) {
      d.log.warn({ err, sym: row.symbol, clientOrderId: row.clientOrderId },
        "[resting-recovery] client-id lookup failed — leaving row pending");
      return "left-pending";
    }
    if (orderId == null) {
      // CONFIRMED absent — the POST never landed.
      await d.markResolved(row, "order never landed (confirmed absent by client-id lookup)");
      return "resolved";
    }
  }

  // 2) Read the order; if still live, cancel and CONFIRM terminal.
  let st: RecoveredOrderState | null;
  try {
    st = await d.getOrder(orderId);
  } catch (err) {
    d.log.warn({ err, sym: row.symbol, orderId }, "[resting-recovery] order read failed — leaving row pending");
    return "left-pending";
  }

  if (st != null && st.status === "resting") {
    try {
      await d.cancelOrder(orderId);
    } catch (err) {
      d.log.warn({ err, sym: row.symbol, orderId }, "[resting-recovery] cancel failed — re-reading state");
    }
    try {
      st = await d.getOrder(orderId);
    } catch (err) {
      d.log.warn({ err, sym: row.symbol, orderId }, "[resting-recovery] post-cancel read failed — leaving row pending");
      return "left-pending";
    }
  }
  if (st != null && st.status !== "cancelled" && st.status !== "filled") {
    // Still live or unknown after a cancel attempt — never resolve on ambiguity.
    d.log.warn({ sym: row.symbol, orderId, status: st.status },
      "[resting-recovery] order not confirmed terminal — leaving row pending");
    return "left-pending";
  }

  if (st == null) {
    // 404 — order gone; final fills unknowable from the order API.  Recorded
    // state stands; the settlement evaluator corrects P&L from settled markets.
    await d.markResolved(row, "order gone (404) — recorded state stands, evaluator settles");
    return "resolved";
  }

  // 3) Terminal with a known final fill count — adopt anything unrecorded.
  const recordedCount = await d.getRecordedCount(row);
  if (st.filledCount > recordedCount) {
    d.log.info(
      { sym: row.symbol, orderId, filled: st.filledCount, recorded: recordedCount },
      "[resting-recovery] fills landed while server was down — adopting untracked contracts",
    );
    await d.adoptFills(row, { filledCount: st.filledCount, avgPrice: st.avgPrice, recordedCount });
  }
  await d.markResolved(row, `reconciled terminal: filled=${st.filledCount} recorded=${recordedCount}`);
  return "resolved";
}
