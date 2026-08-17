import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeMarketableLimitPrice,
  placeOrderWithRetry,
  placeEntryOrderWithSizeFallback,
  isInsufficientVolumeError,
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

test("IOC: defaults to immediate_or_cancel when caller does not specify timeInForce", async () => {
  let received: string | undefined;
  await placeOrderWithRetry(
    { ...baseParams }, // no timeInForce specified
    {},
    async (p) => { received = p.timeInForce; return FILLED; },
  );
  assert.equal(received, "immediate_or_cancel", "placeOrderWithRetry defaults to IOC");
});

test("FOK: respects caller-provided timeInForce: fill_or_kill (used by conviction path)", async () => {
  let received: string | undefined;
  await placeOrderWithRetry(
    { ...baseParams, timeInForce: "fill_or_kill" },
    {},
    async (p) => { received = p.timeInForce; return FILLED; },
  );
  assert.equal(received, "fill_or_kill", "conviction path must send FOK on-wire");
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

// ---------------------------------------------------------------------------
// placeEntryOrderWithSizeFallback — half-size retry on insufficient volume
//
// The $10-bet-size regression: 12-18 contract FOK orders were rejected with
// 409 fill_or_kill_insufficient_resting_volume even when most contracts were
// available. This helper retries ONCE at half size, and converts a second
// volume rejection into a synthetic 0-fill so the caller's zero-fill attempt
// counter (not the generic error path) handles it.
// ---------------------------------------------------------------------------

const VOLUME_ERR = new Error(
  "Kalshi POST /portfolio/orders → 409: {\"error\":{\"code\":\"fill_or_kill_insufficient_resting_volume\"}}",
);

test("isInsufficientVolumeError: matches Kalshi 409 volume rejection, not other errors", () => {
  assert.equal(isInsufficientVolumeError(VOLUME_ERR), true);
  assert.equal(isInsufficientVolumeError(new Error("Kalshi POST → 401: unauthorized")), false);
  assert.equal(isInsufficientVolumeError(new Error("insufficient_resting_volume")), true);
});

test("size fallback: clean fill on first attempt → no retry, attemptedCount = requested", async () => {
  let calls = 0;
  const res = await placeEntryOrderWithSizeFallback(
    { ...baseParams, count: 12 },
    async (p) => { calls++; return { ...FILLED, filledCount: p.count }; },
  );
  assert.equal(calls, 1);
  assert.equal(res.filledCount, 12);
  assert.equal(res.attemptedCount, 12);
});

test("size fallback: volume rejection at 12 → retries once at 6 (floor of half)", async () => {
  const counts: number[] = [];
  const res = await placeEntryOrderWithSizeFallback(
    { ...baseParams, count: 12 },
    async (p) => {
      counts.push(p.count);
      if (p.count === 12) throw VOLUME_ERR;
      return { orderId: "o3", status: "filled", filledCount: p.count, avgPrice: 0.82 };
    },
  );
  assert.deepEqual(counts, [12, 6]);
  assert.equal(res.filledCount, 6);
  assert.equal(res.attemptedCount, 6);
});

test("size fallback: odd count 13 → half is floor(13/2)=6, min 1", async () => {
  const counts: number[] = [];
  await placeEntryOrderWithSizeFallback(
    { ...baseParams, count: 13 },
    async (p) => {
      counts.push(p.count);
      if (p.count === 13) throw VOLUME_ERR;
      return { ...FILLED, filledCount: p.count };
    },
  );
  assert.deepEqual(counts, [13, 6]);
});

test("size fallback: BOTH attempts volume-rejected → synthetic 0-fill, no throw", async () => {
  let calls = 0;
  const res = await placeEntryOrderWithSizeFallback(
    { ...baseParams, count: 12 },
    async () => { calls++; throw VOLUME_ERR; },
  );
  assert.equal(calls, 2, "exactly one retry — never a third attempt");
  assert.equal(res.filledCount, 0);
  assert.equal(res.status, "unfilled");
  assert.equal(res.orderId, null);
});

test("size fallback: count=1 volume-rejected → no smaller retry possible, synthetic 0-fill", async () => {
  let calls = 0;
  const res = await placeEntryOrderWithSizeFallback(
    { ...baseParams, count: 1 },
    async () => { calls++; throw VOLUME_ERR; },
  );
  assert.equal(calls, 1, "no retry at the same size");
  assert.equal(res.filledCount, 0);
});

test("size fallback CRITICAL: non-volume error on first attempt is re-thrown (no retry)", async () => {
  let calls = 0;
  await assert.rejects(
    placeEntryOrderWithSizeFallback(
      { ...baseParams, count: 12 },
      async () => { calls++; throw new Error("Kalshi POST → 401: unauthorized"); },
    ),
    /401: unauthorized/,
  );
  assert.equal(calls, 1);
});

test("size fallback CRITICAL: non-volume error on the HALVED retry is re-thrown", async () => {
  await assert.rejects(
    placeEntryOrderWithSizeFallback(
      { ...baseParams, count: 12 },
      async (p) => {
        if (p.count === 12) throw VOLUME_ERR;
        throw new Error("Kalshi POST → 500: internal");
      },
    ),
    /500: internal/,
  );
});

// ---------------------------------------------------------------------------
// Single-attempt mode (disableHalfSizeRetry) — used by the one-shot IOC
// remainder re-attempt after a partial conviction fill.  The remainder must
// place EXACTLY ONE exchange order: a volume rejection is final (synthetic
// 0-fill), never a second half-size submission.
// ---------------------------------------------------------------------------

test("single-attempt mode: clean fill → one order, result passed through", async () => {
  let calls = 0;
  const res = await placeEntryOrderWithSizeFallback(
    { ...baseParams, count: 5 },
    async (p) => { calls++; return { ...FILLED, filledCount: p.count }; },
    { disableHalfSizeRetry: true },
  );
  assert.equal(calls, 1);
  assert.equal(res.filledCount, 5);
  assert.equal(res.attemptedCount, 5);
});

test("single-attempt mode: partial fill accepted as-is — no follow-up order", async () => {
  let calls = 0;
  const res = await placeEntryOrderWithSizeFallback(
    { ...baseParams, count: 5 },
    async () => { calls++; return { orderId: "o9", status: "filled", filledCount: 2, avgPrice: 0.82 }; },
    { disableHalfSizeRetry: true },
  );
  assert.equal(calls, 1, "partial remainder fill is final — no additional orders");
  assert.equal(res.filledCount, 2);
});

test("single-attempt mode CRITICAL: volume rejection → synthetic 0-fill, NO half-size retry", async () => {
  let calls = 0;
  const res = await placeEntryOrderWithSizeFallback(
    { ...baseParams, count: 5 },
    async () => { calls++; throw VOLUME_ERR; },
    { disableHalfSizeRetry: true },
  );
  assert.equal(calls, 1, "single-attempt mode must place exactly one order");
  assert.equal(res.filledCount, 0);
  assert.equal(res.status, "unfilled");
  assert.equal(res.orderId, null);
});

test("single-attempt mode CRITICAL: non-volume error is still re-thrown", async () => {
  let calls = 0;
  await assert.rejects(
    placeEntryOrderWithSizeFallback(
      { ...baseParams, count: 5 },
      async () => { calls++; throw new Error("Kalshi POST → 401: unauthorized"); },
      { disableHalfSizeRetry: true },
    ),
    /401: unauthorized/,
  );
  assert.equal(calls, 1);
});

test("size fallback: partial fill on the halved retry is accepted as-is", async () => {
  const res = await placeEntryOrderWithSizeFallback(
    { ...baseParams, count: 12 },
    async (p) => {
      if (p.count === 12) throw VOLUME_ERR;
      return { orderId: "o4", status: "filled", filledCount: 4, avgPrice: 0.82 }; // 4 of 6
    },
  );
  assert.equal(res.filledCount, 4, "IOC partial fill on retry tracked by actual count");
  assert.equal(res.attemptedCount, 6);
});

test("size fallback: preserves caller timeInForce on both attempts (FOK poller-fallback path)", async () => {
  const tifs: (string | undefined)[] = [];
  await placeEntryOrderWithSizeFallback(
    { ...baseParams, count: 12, timeInForce: "fill_or_kill" },
    async (p) => {
      tifs.push(p.timeInForce);
      if (p.count === 12) throw VOLUME_ERR;
      return { ...FILLED, filledCount: p.count };
    },
  );
  assert.deepEqual(tifs, ["fill_or_kill", "fill_or_kill"]);
});

test("size fallback: defaults to IOC when caller does not specify timeInForce", async () => {
  let received: string | undefined;
  await placeEntryOrderWithSizeFallback(
    { ...baseParams, count: 12 },
    async (p) => { received = p.timeInForce; return { ...FILLED, filledCount: p.count }; },
  );
  assert.equal(received, "immediate_or_cancel");
});
