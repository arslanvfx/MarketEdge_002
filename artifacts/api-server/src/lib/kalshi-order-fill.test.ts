import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeMarketableLimitPrice,
  placeOrderWithRetry,
  type PlaceOrderParams,
  type PlaceOrderResult,
} from "./kalshi-trader.ts";

const FILLED: PlaceOrderResult = { orderId: "o1", status: "filled", filledCount: 5, avgPrice: 0.6 };
const UNFILLED: PlaceOrderResult = { orderId: null, status: "unfilled", filledCount: 0, avgPrice: null };
const FOK_ERR = new Error(
  'Kalshi POST /portfolio/events/orders → 409: {"error":{"code":"fill_or_kill_insufficient_resting_volume"}}',
);
// Fast opts so tests don't sleep for real.
const FAST = { immediateDelayMs: 0, priceImprovementDelayMs: 0 } as const;

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
// When a fill_or_kill order is repeatedly killed for insufficient resting
// volume, the bot crosses further into the book by an extra cent per attempt.
// These tests pin the pure pricing behavior of that escalation.
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
// placeOrderWithRetry orchestration (via injected placer — no network I/O)
// ---------------------------------------------------------------------------

test("fills on the first attempt → no retries, no price improvement", async () => {
  let calls = 0;
  const res = await placeOrderWithRetry(
    baseParams,
    { immediateAttempts: 4, priceImprovementMaxCents: 5, ...FAST },
    async () => {
      calls++;
      return FILLED;
    },
  );
  assert.equal(res.filledCount, 5);
  assert.equal(calls, 1);
});

test("Phase 1: retries immediately at the SAME price until it fills", async () => {
  const seen: (number | undefined)[] = [];
  let calls = 0;
  const res = await placeOrderWithRetry(
    baseParams,
    { immediateAttempts: 4, priceImprovementMaxCents: 5, ...FAST },
    async (p) => {
      seen.push(p.priceImprovementCents);
      calls++;
      return calls < 3 ? UNFILLED : FILLED; // fill on the 3rd immediate attempt
    },
  );
  assert.equal(res.filledCount, 5);
  assert.equal(calls, 3);
  // All Phase-1 attempts used the base price (no improvement).
  assert.deepEqual(seen, [undefined, undefined, undefined]);
});

test("Phase 2: escalates +1 cent per attempt after immediate retries fail", async () => {
  const improvements: (number | undefined)[] = [];
  const res = await placeOrderWithRetry(
    baseParams,
    { immediateAttempts: 2, priceImprovementMaxCents: 5, ...FAST },
    async (p) => {
      improvements.push(p.priceImprovementCents);
      return p.priceImprovementCents === 3 ? FILLED : UNFILLED; // fills at +3c
    },
  );
  assert.equal(res.filledCount, 5);
  // 2 immediate (base) attempts, then +1c, +2c, +3c (fills).
  assert.deepEqual(improvements, [undefined, undefined, 1, 2, 3]);
});

test("FOK 409 is treated as unfilled and retried (not thrown)", async () => {
  let calls = 0;
  const res = await placeOrderWithRetry(
    baseParams,
    { immediateAttempts: 3, priceImprovementMaxCents: 0, ...FAST },
    async () => {
      calls++;
      if (calls < 3) throw FOK_ERR; // killed twice, then fills
      return FILLED;
    },
  );
  assert.equal(res.filledCount, 5);
  assert.equal(calls, 3);
});

test("all attempts exhausted → returns unfilled result", async () => {
  let calls = 0;
  const res = await placeOrderWithRetry(
    baseParams,
    { immediateAttempts: 2, priceImprovementMaxCents: 2, ...FAST },
    async () => {
      calls++;
      throw FOK_ERR; // never fills
    },
  );
  assert.equal(res.filledCount, 0);
  assert.equal(calls, 4); // 2 immediate + 2 escalation
});

test("CRITICAL: a non-FOK error is re-thrown, never swallowed", async () => {
  await assert.rejects(
    placeOrderWithRetry(
      baseParams,
      { immediateAttempts: 3, priceImprovementMaxCents: 3, ...FAST },
      async () => {
        throw new Error("Kalshi POST → 401: unauthorized");
      },
    ),
    /401: unauthorized/,
  );
});
