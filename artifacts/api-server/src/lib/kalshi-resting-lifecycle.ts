// ---------------------------------------------------------------------------
// Resting entry order lifecycle orchestration (dependency-injected, testable)
// ---------------------------------------------------------------------------
// Drives a real-book conviction entry: place ONE full-size good-till-canceled
// limit order, poll it, and cancel on zone-exit / 3-min floor / max-rest.
//
// Safety invariants this module enforces:
//   • AMBIGUOUS PLACEMENT is never treated as "no order".  If the POST throws
//     (timeout/abort may occur AFTER Kalshi accepted the order), the order id
//     is reconciled via the caller-owned client_order_id.  Reconciliation
//     retries until the server-side expiration backstop has passed; only a
//     CONFIRMED-absent lookup may report a clean 0-fill.  Anything else
//     surfaces `unknown: true` / `stillResting: true` so the caller fails
//     closed (blocks the coin, never releases the entry as "didn't happen").
//   • CANCELLATION is only trusted when confirmed terminal: a cancel HTTP
//     error does not mean the order is dead, so the order is re-read and
//     treated as safely closed only when the exchange reports
//     cancelled/filled/404.  Otherwise `stillResting: true` is returned and
//     the caller must carry the order id so exits cancel it before selling.
//   • PRICE: the GTC limit is only an UPPER bound.  A resting YES bid at the
//     zone cap can be filled BELOW the zone floor if the market moves through
//     it between polls.  This module reports the actual average fill price
//     verbatim; the caller's post-fill zone check (Layer 3) is the safety net
//     for below-floor fills and MUST remain active for resting entries.

import { decideRestingCancel } from "./kalshi-resting-entry.ts";

export interface RestingOrderPlacement {
  orderId: string | null;
  filledCount: number;
  avgPrice: number | null; // YES-side fraction
}

export interface RestingOrderStatusRead {
  filledCount: number;
  status: "resting" | "filled" | "cancelled" | "unknown";
  avgPrice: number | null;
}

export interface RestingLifecycleDeps {
  placeOrder: (clientOrderId: string) => Promise<RestingOrderPlacement>;
  getOrder: (orderId: string) => Promise<RestingOrderStatusRead | null>; // null = 404 (gone)
  cancelOrder: (orderId: string) => Promise<boolean>; // true=cancelled, false=404 already gone
  findOrderIdByClientId: (clientOrderId: string) => Promise<string | null>;
  /** Fresh reference YES price for the zone check; null = no fresh data. */
  getRefYesPrice: () => number | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Optional live status callback for dashboard state. */
  onStatus?: (s: { filledSoFar: number; orderId: string | null }) => void;
  log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
}

export interface RestingLifecycleArgs {
  sym: string;
  direction: "yes" | "no";
  count: number;
  clientOrderId: string;
  /** Unix seconds of the server-side expiration backstop (from planRestingEntry). */
  expirationTimeSec: number;
  maxRestMs: number;
  lockPrice: number;
  lockPriceCap: number;
  /** Epoch ms when the 15-min window closes. */
  windowCloseMs: number;
  pollMs?: number;
  /** Zone tolerance in YES-side dollars applied to both bounds. */
  zoneToleranceFrac?: number;
}

export interface RestingLifecycleResult {
  requested: number;
  filledCount: number;
  avgPrice: number | null; // YES-side
  orderId: string | null;
  clientOrderId: string;
  cancelled: boolean;
  /** True when the order may still be live on the exchange (UNCONFIRMED terminal state). */
  stillResting: boolean;
  /** True when the placement outcome could not be determined at all. */
  unknown: boolean;
}

const DEFAULT_POLL_MS = 1500;
const DEFAULT_ZONE_TOLERANCE = 0.02;
const RECONCILE_RETRY_MS = 2000;
const RECONCILE_GRACE_MS = 5000; // keep trying this long past the expiration backstop

export async function runRestingEntryLifecycle(
  a: RestingLifecycleArgs,
  d: RestingLifecycleDeps,
): Promise<RestingLifecycleResult> {
  const pollMs = a.pollMs ?? DEFAULT_POLL_MS;
  const tol = a.zoneToleranceFrac ?? DEFAULT_ZONE_TOLERANCE;
  const base = {
    requested: a.count,
    clientOrderId: a.clientOrderId,
  };

  // ── PLACE ────────────────────────────────────────────────────────────────
  let orderId: string | null = null;
  let filled = 0;
  let avg: number | null = null;
  try {
    const placement = await d.placeOrder(a.clientOrderId);
    orderId = placement.orderId;
    filled = placement.filledCount;
    avg = placement.avgPrice;
  } catch (err) {
    // AMBIGUOUS: the POST may have failed after Kalshi accepted the order.
    // Reconcile by client id, retrying until the expiration backstop (plus a
    // grace period) has passed.  Only a confirmed-absent lookup may report a
    // clean 0-fill; unresolved lookups surface unknown/stillResting so the
    // caller fails closed.
    d.log.warn({ err, sym: a.sym }, "[resting-entry] placement POST failed — reconciling by client id");
    const deadline = a.expirationTimeSec * 1000 + RECONCILE_GRACE_MS;
    let resolved = false;
    while (!resolved) {
      try {
        orderId = await d.findOrderIdByClientId(a.clientOrderId);
        resolved = true;
      } catch (recErr) {
        if (d.now() >= deadline) {
          d.log.error(
            { err: recErr, sym: a.sym, clientOrderId: a.clientOrderId },
            "[resting-entry] reconcile lookup failed past expiration backstop — order state UNKNOWN",
          );
          return { ...base, filledCount: 0, avgPrice: null, orderId: null, cancelled: false, stillResting: true, unknown: true };
        }
        await d.sleep(RECONCILE_RETRY_MS);
      }
    }
    if (orderId == null) {
      // CONFIRMED absent — the order never landed.  Safe to report 0-fill.
      return { ...base, filledCount: 0, avgPrice: null, orderId: null, cancelled: false, stillResting: false, unknown: false };
    }
    d.log.info({ sym: a.sym, orderId }, "[resting-entry] recovered live order after failed POST");
  }

  // Fully filled at placement — done.
  if (orderId != null && filled >= a.count) {
    return { ...base, filledCount: filled, avgPrice: avg, orderId, cancelled: false, stillResting: false, unknown: false };
  }
  // No order id, no exception — the exchange reported nothing placed.
  if (orderId == null) {
    return { ...base, filledCount: filled, avgPrice: avg, orderId: null, cancelled: false, stillResting: false, unknown: false };
  }

  // ── POLL / CANCEL ────────────────────────────────────────────────────────
  const startMs = d.now();
  while (true) {
    await d.sleep(pollMs);

    const refYes = d.getRefYesPrice();
    // In-zone test in YES-side terms for both directions.  Missing fresh data
    // does NOT cancel — the server-side expiration backstop still bounds risk.
    const inZone = refYes == null
      ? true
      : a.direction === "yes"
        ? refYes >= a.lockPrice - tol && refYes <= a.lockPriceCap + tol
        : (1 - refYes) >= a.lockPrice - tol && (1 - refYes) <= a.lockPriceCap + tol;

    const cancelDecision = decideRestingCancel({
      inZone,
      elapsedMs: d.now() - startMs,
      maxRestMs: a.maxRestMs,
      msRemaining: a.windowCloseMs - d.now(),
    });

    // Refresh fill status.
    let status: RestingOrderStatusRead | null = null;
    let statusReadOk = false;
    try {
      status = await d.getOrder(orderId);
      statusReadOk = true;
    } catch (err) {
      d.log.warn({ err, sym: a.sym, orderId }, "[resting-entry] getOrder failed — will retry poll");
    }
    if (statusReadOk) {
      if (status == null) {
        // 404 — the order no longer exists (expired backstop or external cancel).
        // Terminal with last-known fills.
        return { ...base, filledCount: filled, avgPrice: avg, orderId, cancelled: true, stillResting: false, unknown: false };
      }
      filled = status.filledCount;
      if (status.avgPrice != null) avg = status.avgPrice;
      if (status.status === "filled" || filled >= a.count) {
        return { ...base, filledCount: filled, avgPrice: avg, orderId, cancelled: false, stillResting: false, unknown: false };
      }
      if (status.status === "cancelled") {
        return { ...base, filledCount: filled, avgPrice: avg, orderId, cancelled: true, stillResting: false, unknown: false };
      }
    }

    d.onStatus?.({ filledSoFar: filled, orderId });

    if (cancelDecision.cancel) {
      d.log.info(
        { sym: a.sym, orderId, reason: cancelDecision.reason, filledSoFar: filled, requested: a.count },
        "[resting-entry] cancelling order",
      );
      // Attempt the cancel (best-effort).  The DELETE result is NOT sufficient
      // to confirm terminal state: even a successful DELETE leaves the final
      // fill count unknown — fills may have landed between the last poll and
      // the cancel, and selling only the last-known count would strand the
      // extra contracts untracked.
      try {
        await d.cancelOrder(orderId);
      } catch (err) {
        d.log.warn({ err, sym: a.sym, orderId }, "[resting-entry] cancel failed — re-checking order state");
      }
      // Terminal confirmation comes ONLY from the post-cancel read: the order
      // must report cancelled/filled (or 404-gone) AND we must have its final
      // fill count.  If the read fails or shows the order still live, return
      // stillResting=true so the caller carries pendingEntryOrderId and
      // closePosition re-reconciles (cancel + confirm + adopt actual fills)
      // before any sell.
      let cancelConfirmed = false;
      try {
        const post = await d.getOrder(orderId);
        if (post == null) {
          cancelConfirmed = true; // 404 → order gone; last-known fills stand
        } else {
          filled = post.filledCount;
          if (post.avgPrice != null) avg = post.avgPrice;
          cancelConfirmed = post.status === "cancelled" || post.status === "filled";
        }
      } catch (err) {
        d.log.warn({ err, sym: a.sym, orderId }, "[resting-entry] post-cancel read failed — terminal state UNCONFIRMED");
      }
      return { ...base, filledCount: filled, avgPrice: avg, orderId, cancelled: true, stillResting: !cancelConfirmed, unknown: false };
    }
  }
}
