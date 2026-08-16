// Race tests for the cancel-before-sell reconcile of a pending entry order.
// These cover the cross-path scenarios flagged in review:
//   • partial below-floor fill + unconfirmed cancel → exit MUST abort (throw),
//     never sell into a live entry order
//   • expiry-close cancellation ambiguity → throw so the caller restores the
//     position (no sell, position stays tracked)
//   • fills that landed while resting are adopted before the sell
import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcilePendingEntryOrder,
  type PendingEntryReconcileDeps,
} from "./kalshi-pending-entry-reconcile.ts";

const log = { info: () => {}, warn: () => {}, error: () => {} };

function deps(over: Partial<PendingEntryReconcileDeps> = {}): PendingEntryReconcileDeps {
  return {
    cancelOrder: async () => true,
    getOrder: async () => ({ filledCount: 0, status: "cancelled", avgPrice: null }),
    log,
    ...over,
  };
}

// ── Unconfirmed cancel: MUST throw, never allow the sell ─────────────────────
test("partial fill + cancel throws + order still resting → reconcile throws (no sell)", async () => {
  const d = deps({
    cancelOrder: async () => { throw new Error("DELETE timeout"); },
    getOrder: async () => ({ filledCount: 3, status: "resting", avgPrice: 0.79 }), // below-floor partial
  });
  await assert.rejects(
    () => reconcilePendingEntryOrder({ sym: "BTC", pendingId: "ord-1", recordedCount: 3 }, d),
    /still resting/,
  );
});

test("cancel ok but getOrder throws → reconcile throws (state unconfirmed, no sell)", async () => {
  const d = deps({
    getOrder: async () => { throw new Error("api down"); },
  });
  await assert.rejects(
    () => reconcilePendingEntryOrder({ sym: "ETH", pendingId: "ord-2", recordedCount: 5 }, d),
    /api down/,
  );
});

test("order reports unknown status → reconcile throws (never trust ambiguity)", async () => {
  const d = deps({
    getOrder: async () => ({ filledCount: 2, status: "unknown", avgPrice: null }),
  });
  await assert.rejects(
    () => reconcilePendingEntryOrder({ sym: "SOL", pendingId: "ord-3", recordedCount: 2 }, d),
    /still unknown/,
  );
});

// ── Confirmed terminal: sell may proceed with reconciled counts ──────────────
test("order cancelled with MORE fills than recorded → actual count adopted before sell", async () => {
  const d = deps({
    getOrder: async () => ({ filledCount: 9, status: "cancelled", avgPrice: 0.9 }),
  });
  const r = await reconcilePendingEntryOrder({ sym: "BTC", pendingId: "ord-4", recordedCount: 4 }, d);
  assert.equal(r.actualCount, 9, "fills landed while resting must be sold too");
});

test("order fully filled → terminal, recorded count kept when >= exchange count", async () => {
  const d = deps({
    getOrder: async () => ({ filledCount: 4, status: "filled", avgPrice: 0.88 }),
  });
  const r = await reconcilePendingEntryOrder({ sym: "XRP", pendingId: "ord-5", recordedCount: 4 }, d);
  assert.equal(r.actualCount, 4);
});

test("order 404 (expired backstop) → terminal with recorded count", async () => {
  const d = deps({
    cancelOrder: async () => false, // 404 on cancel
    getOrder: async () => null,     // 404 on read
  });
  const r = await reconcilePendingEntryOrder({ sym: "DOGE", pendingId: "ord-6", recordedCount: 2 }, d);
  assert.equal(r.actualCount, 2);
});

test("cancel throws but post-read shows cancelled → terminal, sell proceeds", async () => {
  const d = deps({
    cancelOrder: async () => { throw new Error("timeout"); },
    getOrder: async () => ({ filledCount: 6, status: "cancelled", avgPrice: 0.85 }),
  });
  const r = await reconcilePendingEntryOrder({ sym: "BNB", pendingId: "ord-7", recordedCount: 6 }, d);
  assert.equal(r.actualCount, 6);
});
