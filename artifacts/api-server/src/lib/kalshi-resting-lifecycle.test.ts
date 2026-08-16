// Race-case tests for the resting entry lifecycle orchestration.
// Covers the failure modes that can create untracked live exposure:
//   1. placement POST timeout AFTER Kalshi accepted the order (reconcile by client id)
//   2. reconcile lookup failure → unknown state (never reported as clean 0-fill)
//   3. cancel failure with zero known fills → stillResting (fail closed)
//   4. adverse move through the zone floor → actual below-floor fill price is
//      reported verbatim so the caller's Layer-3 check can fire
import test from "node:test";
import assert from "node:assert/strict";
import {
  runRestingEntryLifecycle,
  type RestingLifecycleDeps,
  type RestingLifecycleArgs,
} from "./kalshi-resting-lifecycle.ts";

const NOW0 = 1_755_200_000_000;

function makeArgs(over: Partial<RestingLifecycleArgs> = {}): RestingLifecycleArgs {
  return {
    sym: "BTC",
    direction: "yes",
    count: 9,
    clientOrderId: "cid-1",
    expirationTimeSec: Math.floor(NOW0 / 1000) + 75,
    maxRestMs: 75_000,
    lockPrice: 0.82,
    lockPriceCap: 0.91,
    windowCloseMs: NOW0 + 10 * 60_000,
    pollMs: 1,
    ...over,
  };
}

function makeDeps(over: Partial<RestingLifecycleDeps> = {}): RestingLifecycleDeps & { clock: { t: number } } {
  const clock = { t: NOW0 };
  return {
    clock,
    placeOrder: async () => ({ orderId: "ord-1", filledCount: 0, avgPrice: null }),
    getOrder: async () => ({ filledCount: 0, status: "resting", avgPrice: null }),
    cancelOrder: async () => true,
    findOrderIdByClientId: async () => null,
    getRefYesPrice: () => 0.88,
    now: () => clock.t,
    sleep: async (ms: number) => { clock.t += Math.max(ms, 1000); },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...over,
  };
}

// ── 1. POST timeout after Kalshi accepted the order ──────────────────────────
test("placement throw + order found by client id → order is managed, fills claimed", async () => {
  let polls = 0;
  const d = makeDeps({
    placeOrder: async () => { throw new Error("fetch timeout"); },
    findOrderIdByClientId: async () => "ord-recovered",
    getOrder: async () => {
      polls++;
      return polls >= 2
        ? { filledCount: 9, status: "filled", avgPrice: 0.9 }
        : { filledCount: 3, status: "resting", avgPrice: 0.9 };
    },
  });
  const r = await runRestingEntryLifecycle(makeArgs(), d);
  assert.equal(r.orderId, "ord-recovered");
  assert.equal(r.filledCount, 9);
  assert.equal(r.stillResting, false);
  assert.equal(r.unknown, false);
});

test("placement throw + confirmed-absent lookup → clean 0-fill, no phantom order", async () => {
  const d = makeDeps({
    placeOrder: async () => { throw new Error("500"); },
    findOrderIdByClientId: async () => null,
  });
  const r = await runRestingEntryLifecycle(makeArgs(), d);
  assert.equal(r.filledCount, 0);
  assert.equal(r.orderId, null);
  assert.equal(r.stillResting, false);
  assert.equal(r.unknown, false);
});

// ── 2. Reconcile lookup keeps failing → UNKNOWN, never a clean 0-fill ────────
test("placement throw + reconcile failing past backstop → unknown+stillResting", async () => {
  const d = makeDeps({
    placeOrder: async () => { throw new Error("timeout"); },
    findOrderIdByClientId: async () => { throw new Error("api down"); },
  });
  const r = await runRestingEntryLifecycle(makeArgs(), d);
  assert.equal(r.unknown, true);
  assert.equal(r.stillResting, true);
  assert.equal(r.filledCount, 0);
});

test("placement throw + reconcile succeeds on retry → order recovered", async () => {
  let attempts = 0;
  const d = makeDeps({
    placeOrder: async () => { throw new Error("timeout"); },
    findOrderIdByClientId: async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "ord-late";
    },
    getOrder: async () => ({ filledCount: 9, status: "filled", avgPrice: 0.89 }),
  });
  const r = await runRestingEntryLifecycle(makeArgs(), d);
  assert.equal(r.orderId, "ord-late");
  assert.equal(r.filledCount, 9);
  assert.equal(r.unknown, false);
});

// ── 3. Cancel failure with zero known fills → fail closed ────────────────────
test("cancel throws + post-cancel read still resting → stillResting=true (never clean 0-fill)", async () => {
  const d = makeDeps({
    getRefYesPrice: () => 0.5, // out of zone → cancel immediately
    cancelOrder: async () => { throw new Error("DELETE timeout"); },
    getOrder: async () => ({ filledCount: 0, status: "resting", avgPrice: null }),
  });
  const r = await runRestingEntryLifecycle(makeArgs(), d);
  assert.equal(r.cancelled, true);
  assert.equal(r.stillResting, true, "unconfirmed cancel must surface stillResting");
  assert.equal(r.filledCount, 0);
});

test("cancel throws but post-cancel read shows cancelled → terminal, fills adopted", async () => {
  let reads = 0;
  const d = makeDeps({
    getRefYesPrice: () => 0.5, // out of zone → cancel immediately
    cancelOrder: async () => { throw new Error("DELETE timeout"); },
    getOrder: async () => {
      reads++;
      // first read (pre-cancel poll): resting with partial fill;
      // second read (post-cancel): cancelled with the same fills
      return reads >= 2
        ? { filledCount: 4, status: "cancelled", avgPrice: 0.9 }
        : { filledCount: 4, status: "resting", avgPrice: 0.9 };
    },
  });
  const r = await runRestingEntryLifecycle(makeArgs(), d);
  assert.equal(r.cancelled, true);
  assert.equal(r.stillResting, false);
  assert.equal(r.filledCount, 4);
  assert.equal(r.avgPrice, 0.9);
});

test("cancel SUCCEEDS but post-cancel read fails → stillResting=true (DELETE alone is not terminal proof)", async () => {
  // A successful DELETE does not reveal the final fill count — fills may have
  // landed between the last poll and the cancel.  Without a confirming read,
  // the lifecycle must NOT report a safely-terminal order.
  let reads = 0;
  const d = makeDeps({
    getRefYesPrice: () => 0.5, // out of zone → cancel immediately
    cancelOrder: async () => true, // DELETE succeeds
    getOrder: async () => {
      reads++;
      if (reads >= 2) throw new Error("read timeout"); // post-cancel read fails
      return { filledCount: 2, status: "resting", avgPrice: 0.9 };
    },
  });
  const r = await runRestingEntryLifecycle(makeArgs(), d);
  assert.equal(r.cancelled, true);
  assert.equal(r.stillResting, true, "unconfirmed final state must surface stillResting even after successful DELETE");
  assert.equal(r.filledCount, 2, "last-known fills retained");
});

test("cancel 404 (already gone) is terminal", async () => {
  const d = makeDeps({
    getRefYesPrice: () => 0.5,
    cancelOrder: async () => false, // 404 already gone
    getOrder: async () => ({ filledCount: 0, status: "cancelled", avgPrice: null }),
  });
  const r = await runRestingEntryLifecycle(makeArgs(), d);
  assert.equal(r.stillResting, false);
});

// ── 4. Adverse move through the floor → below-floor fill reported verbatim ───
test("adverse fill below the zone floor is reported at actual price (Layer-3 input)", async () => {
  const d = makeDeps({
    getOrder: async () => ({ filledCount: 9, status: "filled", avgPrice: 0.78 }), // below floor 0.82
  });
  const r = await runRestingEntryLifecycle(makeArgs(), d);
  assert.equal(r.filledCount, 9);
  assert.equal(r.avgPrice, 0.78, "actual below-floor price must be surfaced, not clamped");
  // Caller's Layer-3 deviation check fires on lockPrice - fill > 0:
  assert.ok(0.82 - r.avgPrice! > 0);
});

// ── Standard paths ────────────────────────────────────────────────────────────
test("instant full fill at placement → done, no polling", async () => {
  const d = makeDeps({
    placeOrder: async () => ({ orderId: "ord-1", filledCount: 9, avgPrice: 0.9 }),
    getOrder: async () => { throw new Error("should not poll"); },
  });
  const r = await runRestingEntryLifecycle(makeArgs(), d);
  assert.equal(r.filledCount, 9);
  assert.equal(r.stillResting, false);
});

test("server-side expiration (getOrder 404) resolves terminal with last-known fills", async () => {
  const d = makeDeps({
    getOrder: async () => null, // 404 — order gone
  });
  const r = await runRestingEntryLifecycle(makeArgs(), d);
  assert.equal(r.cancelled, true);
  assert.equal(r.stillResting, false);
});

test("max rest elapsed → cancel with partial fill recorded", async () => {
  const d = makeDeps({
    getOrder: async () => ({ filledCount: 2, status: "resting", avgPrice: 0.91 }),
    cancelOrder: async () => true,
    // sleep advances clock 1s per poll; maxRestMs small so it trips fast
  });
  const r = await runRestingEntryLifecycle(makeArgs({ maxRestMs: 2_000 }), d);
  assert.equal(r.cancelled, true);
  assert.equal(r.filledCount, 2);
});

test("no fresh price (refYes null) does NOT cancel on zone — waits for other triggers", async () => {
  let cancelledFor: string | null = null;
  const d = makeDeps({
    getRefYesPrice: () => null,
    getOrder: async () => ({ filledCount: 0, status: "resting", avgPrice: null }),
    cancelOrder: async () => { cancelledFor = "cancel-called"; return true; },
  });
  const r = await runRestingEntryLifecycle(makeArgs({ maxRestMs: 3_000 }), d);
  // It cancels eventually (max rest), NOT because of missing price data.
  assert.equal(r.cancelled, true);
  assert.equal(cancelledFor, "cancel-called");
});
