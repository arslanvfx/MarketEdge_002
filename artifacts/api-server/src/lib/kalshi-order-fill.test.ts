import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeMarketableLimitPrice,
  placeOrderWithRetry,
  type PlaceOrderParams,
  type PlaceOrderResult,
} from "./kalshi-trader.ts";

const FILLED: PlaceOrderResult = { orderId: "o1", status: "filled", filledCount: 5, avgPrice: 0.6 };
const PARTIAL: PlaceOrderResult = { orderId: "o2", status: "filled", filledCount: 3, avgPrice: 0.6 };
const UNFILLED: PlaceOrderResult = { orderId: null, status: "unfilled", filledCount: 0, avgPrice: null };

const baseParams: PlaceOrderParams = {
  ticker: "T",
  side: "yes",
  action: "buy",
  count: 5,
  type: "market",
  yesPrice: 0.5,
};

// ---------------------------------------------------------------------------
// Option-2 price improvement (computeMarketableLimitPrice improvementCents)
//
// computeMarketableLimitPrice is still used for the limitPrice calculation;
// these tests pin the pure pricing behavior and remain unchanged.
// ---------------------------------------------------------------------------

test("no improvement → base marketable price (bid crosses up by 0.15 buffer)", () => {
  assert.equal(computeMarketableLimitPrice("bid", 0.5), 0.65);
  assert.equal(computeMarketableLimitPrice("bid", 0.5, undefined, 0), 0.65);
});

test("bid improvement pays MORE (price rises one cent per cent of improvement)", () => {
  assert.equal(computeMarketableLimitPrice("bid", 0.5, undefined, 1), 0.66);
  assert.equal(computeMarketableLimitPrice("bid", 0.5, undefined, 3), 0.68);
});

test("ask improvement pays MORE for NO (yes-price drops → cost 1-price rises)", () => {
  // base ask for yesPrice 0.5 crosses down by buffer → 0.35
  assert.equal(computeMarketableLimitPrice("ask", 0.5), 0.35);
  assert.equal(computeMarketableLimitPrice("ask", 0.5, undefined, 1), 0.34);
  assert.equal(computeMarketableLimitPrice("ask", 0.5, undefined, 3), 0.32);
});

test("bid price improvement is clamped at 0.99", () => {
  assert.equal(computeMarketableLimitPrice("bid", 0.9, undefined, 50), 0.99);
});

test("ask price improvement is clamped at 0.01", () => {
  assert.equal(computeMarketableLimitPrice("ask", 0.1, undefined, 50), 0.01);
});

test("negative / nullish improvement is treated as zero (no change)", () => {
  assert.equal(computeMarketableLimitPrice("bid", 0.5, undefined, -5), 0.65);
  assert.equal(computeMarketableLimitPrice("bid", 0.5, undefined, null), 0.65);
});

test("CRITICAL: return-floor cap always wins over price improvement", () => {
  // minReturnMultiple 1.7 → maxCost = 1/1.7 ≈ 0.588 → bid capped at 0.58.
  // Base bid for yesPrice 0.5 would be 0.65, already capped to 0.58.
  assert.equal(computeMarketableLimitPrice("bid", 0.5, 1.7), 0.58);
  // Even with aggressive improvement, we must NEVER pay past the floor cap.
  assert.equal(computeMarketableLimitPrice("bid", 0.5, 1.7, 10), 0.58);
  assert.equal(computeMarketableLimitPrice("bid", 0.5, 1.7, 1), 0.58);
});

test("improvement works up to the floor cap but not beyond", () => {
  // minReturnMultiple 2.0 → maxCost = 0.50 → bid capped at 0.50.
  // Base bid for yesPrice 0.30 ≈ 0.44 (0.30 + 0.15, floored to cents), below the
  // 0.50 cap, so improvement raises the price until the cap binds.
  const base = computeMarketableLimitPrice("bid", 0.3, 2.0);
  const improved = computeMarketableLimitPrice("bid", 0.3, 2.0, 3);
  assert.ok(improved > base, "improvement should raise the price toward the cap");
  assert.ok(base < 0.5 && improved <= 0.5, "both stay at/under the floor cap");
  // Large improvement lands exactly on the cap and never exceeds it.
  assert.equal(computeMarketableLimitPrice("bid", 0.3, 2.0, 20), 0.5);
});

// ---------------------------------------------------------------------------
// placeOrderWithRetry — IOC (immediate_or_cancel) behavior
//
// IOC fills whatever the book has at the limit price immediately, then
// cancels the rest. Partial fills are fully accepted — the bot tracks
// position by actual fill count, not requested count.
// ---------------------------------------------------------------------------

test("IOC: full fill → filledCount equals requested count", async () => {
  let calls = 0;
  let receivedTif: string | undefined;
  const res = await placeOrderWithRetry(
    baseParams,
    {},
    async (p) => {
      calls++;
      receivedTif = p.timeInForce;
      return FILLED;
    },
  );
  assert.equal(res.filledCount, 5);
  assert.equal(calls, 1, "IOC submits exactly one order — no retry loop");
  assert.equal(receivedTif, "immediate_or_cancel", "must use IOC, not FOK");
});

test("IOC: partial fill → filledCount < requested, still a success", async () => {
  const res = await placeOrderWithRetry(
    baseParams,
    {},
    async () => PARTIAL,
  );
  assert.equal(res.filledCount, 3, "partial fill is accepted, not retried");
  assert.equal(res.status, "filled");
});

test("IOC: zero fill (empty book) → filledCount 0, no retry attempted", async () => {
  let calls = 0;
  const res = await placeOrderWithRetry(
    baseParams,
    {},
    async () => { calls++; return UNFILLED; },
  );
  assert.equal(res.filledCount, 0);
  assert.equal(calls, 1, "no retry — caller handles 0-fill by skipping the window");
});

test("IOC: overrides any timeInForce already set on params", async () => {
  let received: string | undefined;
  await placeOrderWithRetry(
    { ...baseParams, timeInForce: "fill_or_kill" }, // caller tried to set FOK
    {},
    async (p) => { received = p.timeInForce; return FILLED; },
  );
  assert.equal(received, "immediate_or_cancel", "placeOrderWithRetry always uses IOC");
});

test("CRITICAL: any error from the exchange is re-thrown immediately", async () => {
  await assert.rejects(
    placeOrderWithRetry(
      baseParams,
      {},
      async () => { throw new Error("Kalshi POST → 401: unauthorized"); },
    ),
    /401: unauthorized/,
  );
});
