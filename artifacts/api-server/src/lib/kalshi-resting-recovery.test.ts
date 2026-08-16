// Restart/crash tests for startup reconciliation of in-flight resting orders.
// Covers the reviewer-flagged scenario: a process crash during the 75-second
// resting lifecycle must NOT lose the order — the persisted client_order_id
// row is reconciled on startup, still-live orders are cancelled + confirmed,
// and fills that landed while the server was down are adopted.
import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcilePendingRestingOrder,
  computeFillMerge,
  createBlockTracker,
  isEntryBlockedByRecovery,
  type PendingRestingOrderRow,
  type RestingRecoveryDeps,
} from "./kalshi-resting-recovery.ts";

const log = { info: () => {}, warn: () => {}, error: () => {} };

function row(over: Partial<PendingRestingOrderRow> = {}): PendingRestingOrderRow {
  return {
    rowId: "resting-pending:cid-1",
    symbol: "BTC",
    windowKey: "2026-08-15T14:30",
    ticker: "KXBTC15M-26AUG15-1030-30",
    direction: "yes",
    clientOrderId: "cid-1",
    orderId: null,
    requestedCount: 9,
    limitPrice: 0.9,
    ...over,
  };
}

function deps(over: Partial<RestingRecoveryDeps> = {}): RestingRecoveryDeps & {
  adopted: Array<{ filledCount: number; recordedCount: number }>;
  resolved: string[];
} {
  const adopted: Array<{ filledCount: number; recordedCount: number }> = [];
  const resolved: string[] = [];
  return {
    adopted,
    resolved,
    findOrderIdByClientId: async () => null,
    getOrder: async () => null,
    cancelOrder: async () => true,
    getRecordedCount: async () => 0,
    adoptFills: async (_r, a) => { adopted.push({ filledCount: a.filledCount, recordedCount: a.recordedCount }); },
    markResolved: async (_r, note) => { resolved.push(note); },
    log,
    ...over,
  };
}

// ── Confirmed absent → clean resolution, nothing adopted ────────────────────
test("client-id lookup confirms absent → resolved with no adoption", async () => {
  const d = deps({ findOrderIdByClientId: async () => null });
  const out = await reconcilePendingRestingOrder(row(), d);
  assert.equal(out, "resolved");
  assert.equal(d.adopted.length, 0);
  assert.equal(d.resolved.length, 1);
});

// ── Crash mid-rest, order filled while down → fills adopted ────────────────
test("order found terminal-filled with fills beyond recorded → adoptFills called", async () => {
  const d = deps({
    findOrderIdByClientId: async () => "ord-9",
    getOrder: async () => ({ filledCount: 9, status: "filled", avgPrice: 0.89 }),
    getRecordedCount: async () => 3, // only 3 were recorded before the crash
  });
  const out = await reconcilePendingRestingOrder(row(), d);
  assert.equal(out, "resolved");
  assert.deepEqual(d.adopted, [{ filledCount: 9, recordedCount: 3 }]);
});

// ── Crash mid-rest, order STILL RESTING → cancel, confirm, adopt ────────────
test("order still resting → cancelled, post-cancel read adopted", async () => {
  let cancelled = false;
  let reads = 0;
  const d = deps({
    findOrderIdByClientId: async () => "ord-10",
    getOrder: async () => {
      reads++;
      return reads === 1
        ? { filledCount: 4, status: "resting" as const, avgPrice: 0.9 }
        : { filledCount: 6, status: "cancelled" as const, avgPrice: 0.9 }; // 2 more filled in the race
    },
    cancelOrder: async () => { cancelled = true; return true; },
    getRecordedCount: async () => 0,
  });
  const out = await reconcilePendingRestingOrder(row(), d);
  assert.equal(out, "resolved");
  assert.equal(cancelled, true);
  assert.deepEqual(d.adopted, [{ filledCount: 6, recordedCount: 0 }]);
});

// ── Ambiguity must keep the row pending (fail closed) ────────────────────────
test("client-id lookup throws → left-pending (retried next pass)", async () => {
  const d = deps({ findOrderIdByClientId: async () => { throw new Error("api down"); } });
  assert.equal(await reconcilePendingRestingOrder(row(), d), "left-pending");
  assert.equal(d.resolved.length, 0);
});

test("order read throws → left-pending", async () => {
  const d = deps({
    findOrderIdByClientId: async () => "ord-11",
    getOrder: async () => { throw new Error("read timeout"); },
  });
  assert.equal(await reconcilePendingRestingOrder(row(), d), "left-pending");
});

test("still resting + cancel fails + post-cancel read fails → left-pending", async () => {
  let reads = 0;
  const d = deps({
    findOrderIdByClientId: async () => "ord-12",
    getOrder: async () => {
      reads++;
      if (reads === 1) return { filledCount: 2, status: "resting" as const, avgPrice: 0.9 };
      throw new Error("read timeout");
    },
    cancelOrder: async () => { throw new Error("cancel timeout"); },
  });
  assert.equal(await reconcilePendingRestingOrder(row(), d), "left-pending");
  assert.equal(d.adopted.length, 0, "no adoption on unconfirmed state");
});

test("post-cancel read still shows resting → left-pending (never resolve on ambiguity)", async () => {
  const d = deps({
    findOrderIdByClientId: async () => "ord-13",
    getOrder: async () => ({ filledCount: 1, status: "resting", avgPrice: 0.9 }),
    cancelOrder: async () => true, // DELETE 'succeeded' but exchange still shows resting
  });
  assert.equal(await reconcilePendingRestingOrder(row(), d), "left-pending");
});

// ── computeFillMerge: partial persisted fill + later recovered fill ─────────
test("computeFillMerge: partial position + more fills → total count at order-wide avg", () => {
  // 3 contracts persisted at 0.90 before crash; order ended with 9 filled at avg 0.89.
  const m = computeFillMerge(
    { contractCount: 3, entryYesPrice: 0.9 },
    { filledCount: 9, avgPrice: 0.89 },
    "yes",
    0.9,
  );
  assert.equal(m.contractCount, 9, "merged row must carry TOTAL exchange exposure, not the delta");
  assert.equal(m.entryYesPrice, 0.89, "order-wide avgPrice supersedes the partial price");
  assert.ok(Math.abs(m.betAmount - 9 * 0.89) < 1e-9);
});

test("computeFillMerge: NO direction costs (1-avg)×count", () => {
  const m = computeFillMerge(null, { filledCount: 5, avgPrice: 0.12 }, "no", null);
  assert.equal(m.contractCount, 5);
  assert.ok(Math.abs(m.betAmount - 5 * 0.88) < 1e-9);
});

test("computeFillMerge: null avgPrice falls back to existing price, never shrinks count", () => {
  const m = computeFillMerge(
    { contractCount: 4, entryYesPrice: 0.91 },
    { filledCount: 2, avgPrice: null }, // exchange reports fewer than recorded (shouldn't shrink)
    "yes",
    0.9,
  );
  assert.equal(m.contractCount, 4);
  assert.equal(m.entryYesPrice, 0.91);
});

// ── Global scan gate: DB scan failure must block ALL live entries ────────────
test("isEntryBlockedByRecovery: scan not complete → every symbol blocked globally", () => {
  assert.ok(isEntryBlockedByRecovery("BTC", false, new Set()));
  assert.ok(isEntryBlockedByRecovery("ETH", false, new Set(["BTC"])));
});

test("isEntryBlockedByRecovery: scan complete → only blocked symbols denied", () => {
  const blocked = new Set(["BTC"]);
  assert.ok(isEntryBlockedByRecovery("BTC", true, blocked));
  assert.equal(isEntryBlockedByRecovery("ETH", true, blocked), null);
  assert.equal(isEntryBlockedByRecovery("BTC", true, new Set()), null);
});

// ── Multi-row per-symbol blocks: released only when ALL rows resolve ─────────
test("createBlockTracker: symbol with two pending rows stays blocked until both resolve", () => {
  const t = createBlockTracker(["BTC", "BTC", "ETH"]);
  assert.deepEqual(t.blockedSymbols().sort(), ["BTC", "ETH"]);
  assert.equal(t.resolve("BTC"), false, "first BTC row resolved — must NOT release the block");
  assert.deepEqual(t.blockedSymbols().sort(), ["BTC", "ETH"]);
  assert.equal(t.resolve("BTC"), true, "second BTC row resolved — block released");
  assert.equal(t.resolve("ETH"), true);
  assert.deepEqual(t.blockedSymbols(), []);
});

test("createBlockTracker: resolving an untracked symbol is a safe release", () => {
  const t = createBlockTracker(["BTC"]);
  assert.equal(t.resolve("DOGE"), true); // no rows → nothing to hold
  assert.deepEqual(t.blockedSymbols(), ["BTC"]);
});

// ── 404 after crash (expiration backstop fired) → recorded state stands ─────
test("persisted orderId, order 404 → resolved without adoption", async () => {
  const d = deps({
    getOrder: async () => null, // 404
  });
  const out = await reconcilePendingRestingOrder(row({ orderId: "ord-14" }), d);
  assert.equal(out, "resolved");
  assert.equal(d.adopted.length, 0);
});
