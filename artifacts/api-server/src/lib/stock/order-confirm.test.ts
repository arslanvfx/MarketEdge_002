import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmOrderFill } from "./order-confirm.ts";
import type { OrderStatusLike } from "./order-confirm.ts";

// All tests inject a no-op sleep so they run instantly.
const noSleep = async () => {};

function seq(statuses: (OrderStatusLike | Error)[]): () => Promise<OrderStatusLike> {
  let i = 0;
  return async () => {
    const s = statuses[Math.min(i++, statuses.length - 1)];
    if (s instanceof Error) throw s;
    return s;
  };
}

const working: OrderStatusLike = { status: "new", filledQty: 0, filledAvgPrice: null };
const filled: OrderStatusLike = { status: "filled", filledQty: 10, filledAvgPrice: 100.5 };
const canceledEmpty: OrderStatusLike = { status: "canceled", filledQty: 0, filledAvgPrice: null };
const canceledPartial: OrderStatusLike = { status: "canceled", filledQty: 4, filledAvgPrice: 100.2 };

test("confirm: immediate fill", async () => {
  const r = await confirmOrderFill({ getStatus: seq([filled]), cancel: async () => {}, sleep: noSleep });
  assert.deepEqual(r, { outcome: "filled", filledQty: 10, filledAvgPrice: 100.5 });
});

test("confirm: unfilled order is cancelled and confirmed dead", async () => {
  let cancelled = false;
  const r = await confirmOrderFill({
    getStatus: seq([working, working, working, working, working, canceledEmpty]),
    cancel: async () => { cancelled = true; },
    sleep: noSleep,
    pollAttempts: 5,
  });
  assert.equal(cancelled, true);
  assert.deepEqual(r, { outcome: "unfilled" });
});

test("confirm: cancel races a full fill — fill wins", async () => {
  // Order shows working during polls; after cancel, broker reports filled.
  const r = await confirmOrderFill({
    getStatus: seq([working, working, working, working, working, filled]),
    cancel: async () => {},
    sleep: noSleep,
    pollAttempts: 5,
  });
  assert.deepEqual(r, { outcome: "filled", filledQty: 10, filledAvgPrice: 100.5 });
});

test("confirm: cancel races a partial fill — partial exposure is reported", async () => {
  const r = await confirmOrderFill({
    getStatus: seq([working, working, working, working, working, canceledPartial]),
    cancel: async () => {},
    sleep: noSleep,
    pollAttempts: 5,
  });
  assert.deepEqual(r, { outcome: "partial", filledQty: 4, filledAvgPrice: 100.2 });
});

test("confirm: transient status failures are retried through to the fill", async () => {
  const r = await confirmOrderFill({
    getStatus: seq([new Error("timeout"), new Error("timeout"), filled]),
    cancel: async () => {},
    sleep: noSleep,
  });
  assert.deepEqual(r, { outcome: "filled", filledQty: 10, filledAvgPrice: 100.5 });
});

test("confirm: persistent status+cancel failure returns unknown (caller must track)", async () => {
  const r = await confirmOrderFill({
    getStatus: async () => { throw new Error("broker down"); },
    cancel: async () => { throw new Error("broker down"); },
    sleep: noSleep,
    pollAttempts: 2,
    callRetries: 1,
  });
  assert.deepEqual(r, { outcome: "unknown" });
});

test("confirm: cancel call fails but a later status fetch confirms the fill", async () => {
  const r = await confirmOrderFill({
    getStatus: seq([working, working, filled]),
    cancel: async () => { throw new Error("cancel 500"); },
    sleep: noSleep,
    pollAttempts: 2,
    callRetries: 1,
  });
  assert.deepEqual(r, { outcome: "filled", filledQty: 10, filledAvgPrice: 100.5 });
});

test("confirm: order stuck working forever post-cancel eventually returns unknown", async () => {
  const r = await confirmOrderFill({
    getStatus: async () => working,
    cancel: async () => {},
    sleep: noSleep,
    pollAttempts: 2,
    callRetries: 1,
  });
  assert.deepEqual(r, { outcome: "unknown" });
});

// ── Provisional reconciliation lifecycle ─────────────────────────────────────
import { planProvisionalReconciliation, confirmOrderFill as confirm2 } from "./order-confirm.ts";

test("provisional lifecycle: outage keeps row provisional, late fill converges to broker truth", async () => {
  // Cycle 0 (entry): total broker outage → unknown → provisional row persisted.
  const entry = await confirmOrderFill({
    getStatus: async () => { throw new Error("outage"); },
    cancel: async () => { throw new Error("outage"); },
    sleep: noSleep, pollAttempts: 2, callRetries: 1,
  });
  assert.equal(entry.outcome, "unknown");
  assert.deepEqual(planProvisionalReconciliation(entry), { action: "keep_provisional" });

  // Cycle 1 (manage): broker still down → row must stay open, no exit allowed.
  const cycle1 = await confirmOrderFill({
    getStatus: async () => { throw new Error("still down"); },
    cancel: async () => { throw new Error("still down"); },
    sleep: noSleep, pollAttempts: 1, callRetries: 1,
  });
  assert.deepEqual(planProvisionalReconciliation(cycle1), { action: "keep_provisional" });

  // Cycle 2: broker recovers and reports the order FILLED LATE (partial 7/10)
  // — the exact untracked-exposure scenario; the row adopts broker truth.
  const lateFill: OrderStatusLike = { status: "filled", filledQty: 7, filledAvgPrice: 101.1 };
  const cycle2 = await confirmOrderFill({
    getStatus: async () => lateFill,
    cancel: async () => {},
    sleep: noSleep, pollAttempts: 1, callRetries: 1,
  });
  assert.deepEqual(planProvisionalReconciliation(cycle2), {
    action: "adopt_fill", filledQty: 7, filledAvgPrice: 101.1,
  });
});

test("provisional lifecycle: order died unfilled → row closed as never-filled, broker untouched", async () => {
  const dead = await confirmOrderFill({
    getStatus: async () => canceledEmpty,
    cancel: async () => {},
    sleep: noSleep, pollAttempts: 1, callRetries: 1,
  });
  assert.deepEqual(planProvisionalReconciliation(dead), { action: "close_never_filled" });
});

test("provisional lifecycle: cancel raced a partial fill → real exposure adopted", async () => {
  const partial = await confirmOrderFill({
    getStatus: async () => canceledPartial,
    cancel: async () => {},
    sleep: noSleep, pollAttempts: 1, callRetries: 1,
  });
  assert.deepEqual(planProvisionalReconciliation(partial), {
    action: "adopt_fill", filledQty: 4, filledAvgPrice: 100.2,
  });
});

test("confirm: totally-throwing deps (sync throw included) never propagate — returns unknown", async () => {
  const r = await confirmOrderFill({
    getStatus: () => { throw new Error("sync boom"); },
    cancel: () => { throw new Error("sync boom"); },
    sleep: noSleep,
    pollAttempts: 1,
    callRetries: 0,
  });
  assert.deepEqual(r, { outcome: "unknown" });
});
