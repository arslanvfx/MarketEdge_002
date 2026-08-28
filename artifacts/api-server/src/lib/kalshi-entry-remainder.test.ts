import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRemainderAttempt } from "./kalshi-entry-remainder.ts";

const base = {
  usedPollerFallback: false,
  timeInForce: "immediate_or_cancel",
  requestedCount: 12,
  attemptedCount: 12,
  filledCount: 7,
  minutesRemaining: 6,
};

test("remainder: plain partial IOC fill → attempt remainder of attempted−filled", () => {
  const d = decideRemainderAttempt(base);
  assert.equal(d.attempt, true);
  assert.equal(d.remainder, 5);
});

test("remainder CRITICAL: half-size fallback already fired → NO remainder (two-order budget spent)", () => {
  // 409 at 12 → helper retried at 6 → partial fill 4.  attemptedCount=6 < requested=12.
  // A remainder attempt here would be exchange order #3 — forbidden.
  const d = decideRemainderAttempt({ ...base, attemptedCount: 6, filledCount: 4 });
  assert.equal(d.attempt, false);
  assert.match(d.skipReason!, /two-order budget spent/);
});

test("remainder CRITICAL: fallback fired and even fully filled at half size → still no remainder", () => {
  const d = decideRemainderAttempt({ ...base, attemptedCount: 6, filledCount: 6 });
  assert.equal(d.attempt, false);
});

test("remainder: poller-fallback follow-up remains disabled", () => {
  const d = decideRemainderAttempt({ ...base, usedPollerFallback: true });
  assert.equal(d.attempt, false);
  assert.match(d.skipReason!, /disabled/);
});

test("remainder: non-IOC time-in-force → never attempts", () => {
  const d = decideRemainderAttempt({ ...base, timeInForce: "fill_or_kill" });
  assert.equal(d.attempt, false);
});

test("remainder: full fill → nothing to do", () => {
  const d = decideRemainderAttempt({ ...base, filledCount: 12 });
  assert.equal(d.attempt, false);
  assert.equal(d.remainder, 0);
});

test("remainder: under 3 minutes left → blocked by hard floor", () => {
  const d = decideRemainderAttempt({ ...base, minutesRemaining: 2.9 });
  assert.equal(d.attempt, false);
  assert.match(d.skipReason!, /3-min hard floor/);
});

test("remainder: exactly 3 minutes left → allowed", () => {
  const d = decideRemainderAttempt({ ...base, minutesRemaining: 3 });
  assert.equal(d.attempt, true);
});

test("remainder: remainder is measured against attemptedCount, not requestedCount", () => {
  // Sanity: attempted=12=requested, filled 11 → remainder 1 (allowed).
  const d = decideRemainderAttempt({ ...base, filledCount: 11 });
  assert.equal(d.attempt, true);
  assert.equal(d.remainder, 1);
});

test("integration: 409 → half-size partial fallback → remainder decision keeps total order count at 2", async () => {
  // Simulate the full entry flow order-count accounting:
  // order #1: 12 requested → 409 volume rejection (inside helper)
  // order #2: helper half-size retry at 6 → partial fill 4
  // decision: attemptedCount(6) < requestedCount(12) → NO remainder order.
  const { placeEntryOrderWithSizeFallback } = await import("./kalshi-trader.ts");
  const VOLUME_ERR = new Error(
    "Kalshi POST /portfolio/orders → 409: {\"error\":{\"code\":\"fill_or_kill_insufficient_resting_volume\"}}",
  );
  let exchangeOrders = 0;
  const res = await placeEntryOrderWithSizeFallback(
    { ticker: "T", side: "yes", action: "buy", count: 12, type: "market", timeInForce: "immediate_or_cancel", limitPrice: 0.85 },
    async (p) => {
      exchangeOrders++;
      if (p.count === 12) throw VOLUME_ERR;
      return { orderId: "o2", status: "filled", filledCount: 4, avgPrice: 0.85 };
    },
  );
  assert.equal(exchangeOrders, 2, "helper placed initial + half-size fallback");
  const d = decideRemainderAttempt({
    usedPollerFallback: false,
    timeInForce: "immediate_or_cancel",
    requestedCount: 12,
    attemptedCount: res.attemptedCount,
    filledCount: res.filledCount,
    minutesRemaining: 6,
  });
  assert.equal(d.attempt, false, "remainder must NOT fire after the fallback — would be order #3");
  // Total exchange submissions for this entry: exactly 2.
  assert.equal(exchangeOrders + (d.attempt ? 1 : 0), 2);
});
