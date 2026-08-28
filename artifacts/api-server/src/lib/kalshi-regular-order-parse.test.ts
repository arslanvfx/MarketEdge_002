import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseRegularOrderResponse,
  parseRegularFixedPointInteger,
  parseRegularFixedPointNumber,
  UncertainOrderError,
  isUncertainOrderError,
  placeOrder,
  placeEntryOrderWithSizeFallback,
  prewarmRegularOrderExchangeIndex,
  prewarmRegularAccountSnapshot,
  getFreshRegularAccountSnapshot,
  getFreshRegularAccountSnapshotForRoute,
  claimRegularRouteFundingHold,
  hasAuthorizedRegularRouteFundingHold,
  releaseRegularRouteFundingHold,
  commitRegularRouteFundingHold,
  REGULAR_ACCOUNT_REFRESH_INTERVAL_MS,
  hasFreshRegularPreparedRouteFunding,
  computeRegularWorstCaseRouteCost,
  invalidateBalanceCache,
  REGULAR_ACCOUNT_SNAPSHOT_TTL_MS,
  type PlaceOrderParams,
} from "./kalshi-trader.ts";

// ---------------------------------------------------------------------------
// FixedPointCount — count field
// ---------------------------------------------------------------------------

test("count: finite nonnegative integer number accepted", () => {
  assert.equal(parseRegularFixedPointInteger(0), 0);
  assert.equal(parseRegularFixedPointInteger(5), 5);
});

test("count: canonical values through centi-contract precision are accepted", () => {
  assert.equal(parseRegularFixedPointInteger("5"), 5);
  assert.equal(parseRegularFixedPointInteger("5.0"), 5);
  assert.equal(parseRegularFixedPointInteger("12.00"), 12);
  assert.equal(parseRegularFixedPointInteger("3.60"), 3.6);
  assert.equal(parseRegularFixedPointInteger("0.01"), 0.01);
  assert.equal(parseRegularFixedPointInteger(1.5), 1.5);
});

test("count CRITICAL: over-precision / negative / NaN / Infinity / malformed → null (never coerced to 0)", () => {
  assert.equal(parseRegularFixedPointInteger(-1), null);
  assert.equal(parseRegularFixedPointInteger("-1"), null);
  assert.equal(parseRegularFixedPointInteger(NaN), null);
  assert.equal(parseRegularFixedPointInteger(Infinity), null);
  assert.equal(parseRegularFixedPointInteger(" 5 "), null); // whitespace padded
  assert.equal(parseRegularFixedPointInteger("5abc"), null);
  assert.equal(parseRegularFixedPointInteger(""), null);
  assert.equal(parseRegularFixedPointInteger(null), null);
  assert.equal(parseRegularFixedPointInteger(undefined), null);
  assert.equal(parseRegularFixedPointInteger("5.123"), null);
  assert.equal(parseRegularFixedPointInteger(1.005), null);
  assert.equal(parseRegularFixedPointInteger("1e3"), null); // no exponents
  assert.equal(parseRegularFixedPointInteger("0x5"), null);
});

test("price: finite number and canonical numeric string accepted; malformed → null", () => {
  assert.equal(parseRegularFixedPointNumber(0.5), 0.5);
  assert.equal(parseRegularFixedPointNumber("0.88"), 0.88);
  assert.equal(parseRegularFixedPointNumber("88"), 88);
  assert.equal(parseRegularFixedPointNumber(NaN), null);
  assert.equal(parseRegularFixedPointNumber("abc"), null);
  assert.equal(parseRegularFixedPointNumber(""), null);
  assert.equal(parseRegularFixedPointNumber(" 0.5"), null);
  assert.equal(parseRegularFixedPointNumber("1e-2"), null);
});

// ---------------------------------------------------------------------------
// parseRegularOrderResponse — strict, fail-closed discriminated outcome
// ---------------------------------------------------------------------------

test("confirmed_fill: positive fixed-point fill with finite (0,1) price", () => {
  const r = parseRegularOrderResponse(
    { order_id: "o1", fill_count_fp: "3.60", average_fill_price_dollars: "0.88" },
    5,
  );
  assert.equal(r.outcome, "confirmed_fill");
  assert.equal(r.filledCount, 3.6);
  assert.equal(r.avgPrice, 0.88);
  assert.equal(r.orderId, "o1");
});

test("zero_fill: validated integer fill_count === 0 (avg may be absent)", () => {
  const r = parseRegularOrderResponse({ order_id: "o1", fill_count: "0" }, 5);
  assert.equal(r.outcome, "zero_fill");
  assert.equal(r.filledCount, 0);
  assert.equal(r.avgPrice, null);
});

test("CRITICAL: malformed fill_count → unknown, NOT zero", () => {
  const r = parseRegularOrderResponse(
    { order_id: "o1", fill_count: "1.555", average_fill_price: "0.88" },
    5,
  );
  assert.equal(r.outcome, "unknown");
  assert.equal(r.reason, "unparseable_fill_count");
  assert.equal(r.filledCount, null);
});

test("CRITICAL: conflicting modern and legacy fill counts stay unknown", () => {
  const result = parseRegularOrderResponse({
    order_id: "o1",
    fill_count_fp: "3.60",
    fill_count: "4",
    average_fill_price_dollars: "0.15",
  }, 4);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.reason, "conflicting_fill_count");
});

test("CRITICAL: missing fill_count → unknown (never coerced to zero)", () => {
  const r = parseRegularOrderResponse({ order_id: "o1", average_fill_price: "0.88" }, 5);
  assert.equal(r.outcome, "unknown");
  assert.equal(r.reason, "missing_fill_count");
});

test("CRITICAL: confirmed fill with missing/invalid price → unknown (no cached fallback)", () => {
  const missing = parseRegularOrderResponse({ order_id: "o1", fill_count: "5" }, 5);
  assert.equal(missing.outcome, "unknown");
  assert.equal(missing.reason, "missing_avg_price");

  const zeroPrice = parseRegularOrderResponse(
    { order_id: "o1", fill_count: "5", average_fill_price: "0" }, 5);
  assert.equal(zeroPrice.outcome, "unknown");
  assert.equal(zeroPrice.reason, "invalid_avg_price");

  const onePrice = parseRegularOrderResponse(
    { order_id: "o1", fill_count: "5", average_fill_price: "1" }, 5);
  assert.equal(onePrice.outcome, "unknown");

  const negPrice = parseRegularOrderResponse(
    { order_id: "o1", fill_count: "5", average_fill_price: "-0.1" }, 5);
  assert.equal(negPrice.outcome, "unknown");
});

test("CRITICAL: overfill (filled > requested) → unknown", () => {
  const r = parseRegularOrderResponse(
    { order_id: "o1", fill_count: "6", average_fill_price: "0.5" }, 5);
  assert.equal(r.outcome, "unknown");
  assert.equal(r.reason, "overfill_count");
});

test("missing/empty order_id → unknown", () => {
  assert.equal(parseRegularOrderResponse({ fill_count: "5", average_fill_price: "0.5" }, 5).outcome, "unknown");
  assert.equal(parseRegularOrderResponse({ order_id: "", fill_count: "0" }, 5).outcome, "unknown");
});

test("non-object / null / array response → unknown", () => {
  assert.equal(parseRegularOrderResponse(null, 5).outcome, "unknown");
  assert.equal(parseRegularOrderResponse("x", 5).outcome, "unknown");
  assert.equal(parseRegularOrderResponse([], 5).outcome, "unknown");
});

test("bad requestedCount → unknown (fail closed)", () => {
  assert.equal(parseRegularOrderResponse({ order_id: "o1", fill_count: "0" }, 0).reason, "bad_requested_count");
  assert.equal(parseRegularOrderResponse({ order_id: "o1", fill_count: "0" }, 1.555).reason, "bad_requested_count");
});

// ---------------------------------------------------------------------------
// placeOrder integration — strict parse wired into the order boundary
// (injectable fetch via monkeypatch of globalThis.fetch)
// ---------------------------------------------------------------------------

const BASE: PlaceOrderParams = {
  ticker: "T", side: "yes", action: "buy", count: 3, type: "market", limitPrice: 0.5,
};

function withEnvAndFetch(
  fetchImpl: typeof fetch,
  run: () => Promise<void>,
  marketResponse: Response | (() => Response | Promise<Response>) = () =>
    jsonResponse({ market: { ticker: BASE.ticker, exchange_index: 0 } }),
): () => Promise<void> {
  return async () => {
    const prevKey = process.env["KALSHI_API_KEY_ID"];
    const prevPem = process.env["KALSHI_PRIVATE_KEY"];
    const prevFetch = globalThis.fetch;
    process.env["KALSHI_API_KEY_ID"] = "test-key";
    // A minimal valid RSA private key is required for signing. Generate one.
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env["KALSHI_PRIVATE_KEY"] = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    globalThis.fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return typeof marketResponse === "function" ? marketResponse() : marketResponse;
      }
      return fetchImpl(input, init);
    };
    try {
      await run();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env["KALSHI_API_KEY_ID"]; else process.env["KALSHI_API_KEY_ID"] = prevKey;
      if (prevPem === undefined) delete process.env["KALSHI_PRIVATE_KEY"]; else process.env["KALSHI_PRIVATE_KEY"] = prevPem;
    }
  };
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

test("placeOrder: confirmed fill returns real avgPrice (no cached fallback)", withEnvAndFetch(
  async () => jsonResponse({ order_id: "ok1", fill_count: "3", average_fill_price: "0.42" }),
  async () => {
    const r = await placeOrder(BASE);
    assert.equal(r.filledCount, 3);
    assert.equal(r.avgPrice, 0.42);
    assert.equal(r.status, "filled");
  },
));

test("placeOrder routing: shard 0 and shard 2 are included in CreateOrderV2 bodies", async () => {
  for (const exchangeIndex of [0, 2]) {
    let postCount = 0;
    await withEnvAndFetch(
      async (_input, init) => {
        postCount++;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        assert.equal(body["exchange_index"], exchangeIndex);
        return jsonResponse({ order_id: `order-${exchangeIndex}`, fill_count: "0" });
      },
      async () => {
        await placeOrder(BASE);
      },
      () => jsonResponse({
        market: {
          ticker: BASE.ticker,
          exchange_index: exchangeIndex === 2 ? "2" : exchangeIndex,
        },
      }),
    )();
    assert.equal(postCount, 1);
  }
});

test("regular prepared route: exact fresh route posts directly with its shard and no market GET", async () => {
  const ticker = "PREPARED-ROUTE-DIRECT";
  prewarmRegularOrderExchangeIndex(ticker, 7);
  let marketGets = 0;
  let posts = 0;
  await withEnvAndFetch(
    async (_input, init) => {
      posts++;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.equal(body["exchange_index"], 7);
      assert.equal(body["ticker"], ticker);
      return jsonResponse({ order_id: "prepared-route-ok", fill_count: "0" });
    },
    async () => {
      await placeOrder({ ...BASE, ticker, requirePreparedRoute: true });
    },
    () => {
      marketGets++;
      return jsonResponse({ market: { ticker, exchange_index: 99 } });
    },
  )();
  assert.equal(marketGets, 0);
  assert.equal(posts, 1);
});

test("regular prepared route: absent or stale evidence fails closed without GET or POST", async () => {
  const staleTicker = "PREPARED-ROUTE-STALE";
  prewarmRegularOrderExchangeIndex(staleTicker, 3, Date.now() - 3 * 60_000);
  for (const ticker of ["PREPARED-ROUTE-ABSENT", staleTicker]) {
    let gets = 0;
    let posts = 0;
    await withEnvAndFetch(
      async () => {
        posts++;
        return jsonResponse({ order_id: "must-not-submit", fill_count: "0" });
      },
      async () => {
        await assert.rejects(
          placeOrder({ ...BASE, ticker, requirePreparedRoute: true }),
          /route is absent or stale/,
        );
      },
      () => {
        gets++;
        return jsonResponse({ market: { ticker, exchange_index: 0 } });
      },
    )();
    assert.equal(gets, 0);
    assert.equal(posts, 0);
  }
});

test("regular account snapshot: fresh read is synchronous and expires fail-closed", async () => {
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  const startedAt = previousNow();
  try {
    globalThis.fetch = async () => jsonResponse({ balance: 1234, portfolio_value: 0 });
    await prewarmRegularAccountSnapshot();
    // No Promise/await boundary: the hot path consumes a prepared value directly.
    assert.equal(getFreshRegularAccountSnapshot(), 12.34);
    Date.now = () => startedAt + REGULAR_ACCOUNT_SNAPSHOT_TTL_MS + 60_000;
    assert.equal(getFreshRegularAccountSnapshot(), null);
  } finally {
    Date.now = previousNow;
    globalThis.fetch = previousFetch;
  }
});

test("regular account snapshot: aggregate prewarm retains exact-route shard cash", async () => {
  const previousFetch = globalThis.fetch;
  try {
    invalidateBalanceCache();
    globalThis.fetch = async () => jsonResponse({
      balance: 3000,
      portfolio_value: 0,
      // Aggregate balance is cents; Kalshi's breakdown fields are fixed-point
      // dollar values (the production parser intentionally preserves that).
      balance_breakdown: [{ exchange_index: 4, balance: "12.5000" }, { exchange_index: 7, balance: "17.5000" }],
    });
    await prewarmRegularAccountSnapshot();
    const snapshot = getFreshRegularAccountSnapshotForRoute(7);
    assert.equal(snapshot?.availableBalance, 30);
    assert.equal(snapshot?.availableBalanceByExchange.get(7), 17.5);
    assert.equal(getFreshRegularAccountSnapshotForRoute(99), null);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("regular route cost: uses submitted YES-side limit for both YES and NO", () => {
  assert.equal(computeRegularWorstCaseRouteCost("yes", 0.91, 3), 2.73);
  assert.equal(computeRegularWorstCaseRouteCost("no", 0.09, 3), 2.73);
  assert.equal(computeRegularWorstCaseRouteCost("no", 0.12, 2.5), 2.2);
  assert.equal(computeRegularWorstCaseRouteCost("yes", 1, 1), null);
  assert.equal(computeRegularWorstCaseRouteCost("yes", 0.5, 1.001), null);
});

test("regular pre-submit funding predicate revokes after account invalidation", async () => {
  const ticker = "PREPARED-ROUTE-FUNDING";
  const previousFetch = globalThis.fetch;
  try {
    invalidateBalanceCache();
    globalThis.fetch = async () => jsonResponse({
      balance: 500,
      portfolio_value: 0,
      balance_breakdown: [{ exchange_index: 5, balance: "5.0000" }],
    });
    prewarmRegularOrderExchangeIndex(ticker, 5);
    await prewarmRegularAccountSnapshot();
    assert.equal(hasFreshRegularPreparedRouteFunding(ticker, 4.5), true);
    invalidateBalanceCache();
    assert.equal(hasFreshRegularPreparedRouteFunding(ticker, 4.5), false);
  } finally {
    globalThis.fetch = previousFetch;
  }

  let posts = 0;
  await withEnvAndFetch(
    async () => {
      posts++;
      return jsonResponse({ order_id: "must-not-submit", fill_count: "0" });
    },
    async () => {
      await assert.rejects(
        placeOrder({
          ...BASE,
          ticker,
          requirePreparedRoute: true,
          preSubmitGuard: () => hasFreshRegularPreparedRouteFunding(ticker, 4.5),
        }),
        /revoked before broker POST/,
      );
    },
  )();
  assert.equal(posts, 0);
});

test("regular account prewarm: concurrent callers coalesce, refresh-ahead reuses fresh snapshot, invalidation fails closed", async () => {
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  let gets = 0;
  try {
    invalidateBalanceCache();
    let now = previousNow();
    Date.now = () => now;
    globalThis.fetch = async () => {
      gets++;
      return jsonResponse({
        balance: 2000,
        portfolio_value: 0,
        balance_breakdown: [{ exchange_index: 2, balance: "20.0000" }],
      });
    };
    await Promise.all([
      prewarmRegularAccountSnapshot(),
      prewarmRegularAccountSnapshot(),
      prewarmRegularAccountSnapshot(),
    ]);
    assert.equal(gets, 1, "all same-cycle symbol prewarms share one authenticated GET");
    await prewarmRegularAccountSnapshot();
    assert.equal(gets, 1, "refresh-ahead retains a usable snapshot without repeated GETs");
    // Enter the refresh-ahead window, then emulate several symbols in the same
    // poll cycle. They must share one replacement GET, before snapshot expiry.
    now += REGULAR_ACCOUNT_REFRESH_INTERVAL_MS + 1;
    await Promise.all([
      prewarmRegularAccountSnapshot(),
      prewarmRegularAccountSnapshot(),
      prewarmRegularAccountSnapshot(),
    ]);
    assert.equal(gets, 2, "refresh-ahead starts exactly one shared replacement GET");
    assert.equal(getFreshRegularAccountSnapshotForRoute(2)?.availableBalance, 20);
    invalidateBalanceCache();
    assert.equal(getFreshRegularAccountSnapshot(), null);
    assert.equal(getFreshRegularAccountSnapshotForRoute(2), null);
  } finally {
    Date.now = previousNow;
    globalThis.fetch = previousFetch;
  }
});

test("regular account snapshot remains usable while a slow replacement is in flight", async () => {
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  let resolveRefresh!: (response: Response) => void;
  try {
    invalidateBalanceCache();
    let now = previousNow();
    Date.now = () => now;
    globalThis.fetch = async () => jsonResponse({
      balance: 2000,
      portfolio_value: 0,
      balance_breakdown: [{ exchange_index: 2, balance: "20.0000" }],
    });
    prewarmRegularOrderExchangeIndex("SLOW-REFRESH", 2, now);
    await prewarmRegularAccountSnapshot();

    now += REGULAR_ACCOUNT_REFRESH_INTERVAL_MS + 1;
    globalThis.fetch = () => new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const refresh = prewarmRegularAccountSnapshot();
    now += 10_000;
    assert.equal(getFreshRegularAccountSnapshotForRoute(2)?.availableBalance, 20);

    resolveRefresh(jsonResponse({
      balance: 1900,
      portfolio_value: 0,
      balance_breakdown: [{ exchange_index: 2, balance: "19.0000" }],
    }));
    await refresh;
    assert.equal(getFreshRegularAccountSnapshotForRoute(2)?.availableBalance, 19);
  } finally {
    Date.now = previousNow;
    globalThis.fetch = previousFetch;
  }
});

test("regular route funding holds serialize parallel cash and confirmed fills debit locally", async () => {
  const previousFetch = globalThis.fetch;
  try {
    invalidateBalanceCache();
    globalThis.fetch = async () => jsonResponse({
      balance: 1000,
      portfolio_value: 0,
      balance_breakdown: [{ exchange_index: 3, balance: "5.0000" }],
    });
    prewarmRegularOrderExchangeIndex("HELD-ROUTE", 3);
    await prewarmRegularAccountSnapshot();

    assert.equal(claimRegularRouteFundingHold("HELD-ROUTE", "hold-a", 3), true);
    assert.equal(claimRegularRouteFundingHold("HELD-ROUTE", "hold-b", 3), false);
    assert.equal(hasAuthorizedRegularRouteFundingHold("HELD-ROUTE", "hold-a"), true);
    assert.equal(commitRegularRouteFundingHold("hold-a", 2.5), true);
    assert.equal(getFreshRegularAccountSnapshotForRoute(3)?.availableBalanceByExchange.get(3), 2.5);

    assert.equal(claimRegularRouteFundingHold("HELD-ROUTE", "hold-c", 2), true);
    releaseRegularRouteFundingHold("hold-c");
    assert.equal(hasAuthorizedRegularRouteFundingHold("HELD-ROUTE", "hold-c"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("regular prepared route: revoked pre-submit guard makes zero broker POSTs", async () => {
  const ticker = "PREPARED-ROUTE-REVOKED";
  prewarmRegularOrderExchangeIndex(ticker, 1);
  let posts = 0;
  await withEnvAndFetch(
    async () => {
      posts++;
      return jsonResponse({ order_id: "must-not-submit", fill_count: "0" });
    },
    async () => {
      await assert.rejects(
        placeOrder({ ...BASE, ticker, requirePreparedRoute: true, preSubmitGuard: () => false }),
        /revoked before broker POST/,
      );
    },
  )();
  assert.equal(posts, 0);
});

test("regular intent migrations declare claim-predicate indexes", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./kalshi-regular-order-intent.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /regular_intent_mode_symbol_status_window/);
  assert.match(source, /ON kalshi_regular_order_intents \(mode, symbol, status, window_key\)/);
  assert.match(source, /regular_intent_active_cost/);
  assert.match(source, /WHERE status IN \('reserved', 'unknown', 'filled'\)/);
  const claim = source.slice(
    source.indexOf("async function claimRegularOrderIntentBatch"),
    source.indexOf("async function flushPendingIntentCohort"),
  );
  assert.match(claim, /migration is not ready; refusing live claim/);
  assert.doesNotMatch(claim, /await ensureMigrated\(\)/);
});

test("conviction hot path consumes only prepared orderbook and reaches durable claim without candidate I/O", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8"),
  );
  const gateStart = source.indexOf("// ─── CONVICTION LIVE-PRICE GATE");
  const gateEnd = source.indexOf("// Orderbook fetch result handling:", gateStart);
  const preparedGate = source.slice(gateStart, gateEnd);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  assert.doesNotMatch(preparedGate, /await waitForConvictionOrderbookWarmup/);
  assert.doesNotMatch(preparedGate, /await fetchOrderbookPrices/);
  assert.match(preparedGate, /_obCacheFresh/);

  const hotPathEnd = source.indexOf("const claim = await claimRegularOrderIntent", gateStart);
  const hotPath = source.slice(gateStart, hotPathEnd);
  assert.match(hotPath, /getPreparedRegularOrderExchangeIndex\(expectedTicker\)/);
  assert.match(hotPath, /getFreshRegularAccountSnapshotForRoute/);
  assert.doesNotMatch(hotPath, /await getCachedKalshiBalance/);
  assert.doesNotMatch(hotPath, /await fetchOrderbookPrices/);
});

test("conviction cannot silently fall back to the legacy execution gateway", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8"),
  );
  const gatewayStart = source.indexOf("const useAuthenticatedBookGateway");
  const gatewayEnd = source.indexOf("const durableEntryLimitRaw", gatewayStart);
  const gatewayPath = source.slice(gatewayStart, gatewayEnd);
  assert.ok(gatewayStart >= 0 && gatewayEnd > gatewayStart);
  assert.match(gatewayPath, /S\.config\.decisionMode === "conviction"/);
  assert.match(gatewayPath, /quoteAuthenticatedBookExecution/);
  assert.match(gatewayPath, /if \(useAuthenticatedBookGateway && !authenticatedBookQuote\)/);
});

test("authenticated conviction dispatch uses shared current-window identity without REST-poller dependency", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./kalshi-bot-loop.ts", import.meta.url), "utf8"),
  );
  const dispatcherStart = source.indexOf("const convictionBookDispatch");
  const dispatcherEnd = source.indexOf("dashboard2KalshiOrderbookService.onBookUpdate", dispatcherStart);
  const dispatcher = source.slice(dispatcherStart, dispatcherEnd);
  assert.ok(dispatcherStart >= 0 && dispatcherEnd > dispatcherStart);
  assert.match(dispatcher, /S\.config\.decisionMode === "conviction"/);
  assert.doesNotMatch(dispatcher, /liveExecutionGateway === "authenticated_book"/);
  assert.match(dispatcher, /getKalshiCachedData\(sym\)/);
  assert.doesNotMatch(dispatcher, /getConvictionLivePriceSnapshot\(sym\)/);
});

test("durable intent batching adds no fixed timer delay before broker submission", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./kalshi-regular-order-intent.ts", import.meta.url), "utf8"),
  );
  const claimStart = source.indexOf("export function claimRegularOrderIntent(");
  const claimEnd = source.indexOf("/**", claimStart + 10);
  const claim = source.slice(claimStart, claimEnd);
  assert.match(claim, /queueMicrotask/);
  assert.doesNotMatch(claim, /setTimeout/);
});

test("SKIP telemetry cannot hold the per-symbol lock ahead of a fresh book update", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8"),
  );
  const skipStart = source.indexOf('if (decision.action === "SKIP")');
  const skipEnd = source.indexOf("// ── Per-coin streak pause", skipStart);
  const skipPath = source.slice(skipStart, skipEnd);
  assert.ok(skipStart >= 0 && skipEnd > skipStart);
  assert.match(skipPath, /void persistBetRecord/);
  assert.doesNotMatch(skipPath, /await persistBetRecord/);
});

test("authenticated book ticks are queued behind an active scheduler tick instead of dropped", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8"),
  );
  const start = source.indexOf("export async function runBotTickForCoin");
  const end = source.indexOf("async function _runBotTick", start);
  const wrapper = source.slice(start, end);
  assert.match(wrapper, /pendingBotTicks\.set\(sym, requestedTick\)/);
  assert.match(wrapper, /queued\?\.source !== "authenticated_book"/);
  assert.match(wrapper, /next = pendingBotTicks\.get\(sym\)/);
  assert.doesNotMatch(wrapper, /if \(tickInFlight\.has\(sym\)\) return/);
});

test("regular conviction submits one IOC at the exact verified quote", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /Math\.floor\(Math\.min\(freshYesAsk, lockPriceCap\) \* 100\) \/ 100/);
  assert.match(source, /Math\.ceil\(Math\.max\(freshYesBid, 1 - lockPriceCap\) \* 100\) \/ 100/);
  assert.match(source, /const entryTimeInForce: "immediate_or_cancel" = "immediate_or_cancel"/);
  const initialEntry = source.slice(
    source.indexOf("const fokResult = await placeEntryOrderWithSizeFallback"),
    source.indexOf("const exchangeResponseAt", source.indexOf("const fokResult = await placeEntryOrderWithSizeFallback")),
  );
  assert.match(initialEntry, /disableHalfSizeRetry: true/);
});

test("placeOrder routing: invalid market identity fails closed with zero POSTs", async () => {
  const invalidPayloads: unknown[] = [
    null,
    {},
    { market: null },
    { market: { ticker: "OTHER", exchange_index: 2 } },
    { market: { ticker: BASE.ticker } },
    { market: { ticker: BASE.ticker, exchange_index: -1 } },
    { market: { ticker: BASE.ticker, exchange_index: 1.5 } },
    { market: { ticker: BASE.ticker, exchange_index: "invalid" } },
    { market: { ticker: BASE.ticker, exchange_index: "1.5" } },
  ];
  for (const payload of invalidPayloads) {
    let postCount = 0;
    await withEnvAndFetch(
      async () => {
        postCount++;
        return jsonResponse({ order_id: "must-not-submit", fill_count: "0" });
      },
      async () => {
        await assert.rejects(placeOrder(BASE), /routing/);
      },
      () => jsonResponse(payload),
    )();
    assert.equal(postCount, 0, `must not POST for ${JSON.stringify(payload)}`);
  }
});

test("placeOrder routing: malformed JSON and non-OK lookup fail closed with zero POSTs", async () => {
  const responses = [
    () => new Response("{bad json", { status: 200, headers: { "Content-Type": "application/json" } }),
    () => new Response("not found", { status: 404 }),
  ];
  for (const marketResponse of responses) {
    let postCount = 0;
    await withEnvAndFetch(
      async () => {
        postCount++;
        return jsonResponse({ order_id: "must-not-submit", fill_count: "0" });
      },
      async () => {
        await assert.rejects(placeOrder(BASE), /routing lookup failed before POST/);
      },
      marketResponse,
    )();
    assert.equal(postCount, 0);
  }
});

test("placeOrder routing: entry and sell exit both cross the fresh routing boundary", withEnvAndFetch(
  async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    assert.equal(body["exchange_index"], 2);
    return jsonResponse({ order_id: "entry-or-exit", fill_count: "0" });
  },
  async () => {
    await placeOrder(BASE);
    await placeOrder({ ...BASE, action: "sell" });
  },
  () => jsonResponse({ market: { ticker: BASE.ticker, exchange_index: 2 } }),
));

test("placeOrder routing: half-size retry resolves routing afresh before its POST", withEnvAndFetch(
  (() => {
    let posts = 0;
    return async (_input, init) => {
      posts++;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      assert.equal(body["exchange_index"], posts === 1 ? 2 : 0);
      if (posts === 1) {
        return new Response(
          JSON.stringify({ error: { code: "fill_or_kill_insufficient_resting_volume" } }),
          { status: 409 },
        );
      }
      return jsonResponse({ order_id: "retry-ok", fill_count: "0" });
    };
  })(),
  async () => {
    const result = await placeEntryOrderWithSizeFallback({ ...BASE, count: 4 });
    assert.equal(result.attemptedCount, 2);
  },
  (() => {
    let gets = 0;
    return () => {
      gets++;
      assert.ok(gets <= 2, "exactly one fresh lookup per actual POST");
      return jsonResponse({ market: { ticker: BASE.ticker, exchange_index: gets === 1 ? 2 : 0 } });
    };
  })(),
));

test("placeOrder: POST 404 remains a definitive rejection, not uncertain exposure", withEnvAndFetch(
  async () => new Response(
    JSON.stringify({ error: { code: "market_not_found" } }),
    { status: 404 },
  ),
  async () => {
    await assert.rejects(placeOrder(BASE), (err: unknown) => {
      assert.equal(isUncertainOrderError(err), false);
      assert.match(String((err as Error).message), /404/);
      return true;
    });
  },
));

test("placeOrder: zero fill returns filledCount 0, avgPrice null", withEnvAndFetch(
  async () => jsonResponse({ order_id: "ok2", fill_count: "0" }),
  async () => {
    const r = await placeOrder(BASE);
    assert.equal(r.filledCount, 0);
    assert.equal(r.avgPrice, null);
    assert.equal(r.status, "unfilled");
  },
));

test("placeOrder CRITICAL: malformed fill_count throws UncertainOrderError (not zero fill)", withEnvAndFetch(
  async () => jsonResponse({ order_id: "ok3", fill_count: "1.555", average_fill_price: "0.5" }),
  async () => {
    await assert.rejects(placeOrder(BASE), (err: unknown) => {
      assert.ok(isUncertainOrderError(err), "must be UncertainOrderError");
      assert.equal((err as UncertainOrderError).reason, "unparseable_fill_count");
      assert.ok((err as UncertainOrderError).clientOrderId.length > 0, "carries client_order_id");
      return true;
    });
  },
));

test("placeOrder CRITICAL: confirmed fill with no price throws Uncertain (never falls back)", withEnvAndFetch(
  async () => jsonResponse({ order_id: "ok4", fill_count: "3" }),
  async () => {
    await assert.rejects(placeOrder(BASE), (err: unknown) => isUncertainOrderError(err));
  },
));

test("placeOrder: transport timeout/abort surfaces as UncertainOrderError (ambiguous exposure)", withEnvAndFetch(
  async () => { throw new DOMException("The operation was aborted", "AbortError"); },
  async () => {
    await assert.rejects(placeOrder(BASE), (err: unknown) => {
      assert.ok(isUncertainOrderError(err), "abort must be uncertain");
      assert.equal((err as UncertainOrderError).reason, "transport_or_timeout");
      return true;
    });
  },
));

test("placeOrder: definite HTTP rejection (409 volume) is re-thrown verbatim, NOT uncertain", withEnvAndFetch(
  async () => new Response(
    JSON.stringify({ error: { code: "fill_or_kill_insufficient_resting_volume" } }),
    { status: 409 },
  ),
  async () => {
    await assert.rejects(placeOrder(BASE), (err: unknown) => {
      assert.ok(!isUncertainOrderError(err), "409 volume kill is definite, not uncertain");
      assert.match(String((err as Error).message), /insufficient_resting_volume|409/);
      return true;
    });
  },
));

test("placeOrder CRITICAL: 500 after POST is uncertain, never safe-to-retry", withEnvAndFetch(
  async () => new Response("gateway failure", { status: 500 }),
  async () => {
    await assert.rejects(placeOrder(BASE), (err: unknown) => {
      assert.ok(isUncertainOrderError(err));
      assert.equal((err as UncertainOrderError).reason, "ambiguous_http_500");
      return true;
    });
  },
));

test("placeOrder CRITICAL: 429 after POST is uncertain, never safe-to-retry", withEnvAndFetch(
  async () => new Response("rate limited", { status: 429 }),
  async () => {
    await assert.rejects(placeOrder(BASE), (err: unknown) => {
      assert.ok(isUncertainOrderError(err));
      assert.equal((err as UncertainOrderError).reason, "ambiguous_http_429");
      return true;
    });
  },
));

test("placeOrder submits the caller-persisted client_order_id exactly", withEnvAndFetch(
  async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { client_order_id?: string };
    assert.equal(body.client_order_id, "persisted-client-id");
    return jsonResponse({ order_id: "ok-client", fill_count: "3", average_fill_price: "0.42" });
  },
  async () => {
    const r = await placeOrder({ ...BASE, clientOrderId: "persisted-client-id" });
    assert.equal(r.filledCount, 3);
  },
));

test("placeOrder CRITICAL: fill worse than submitted limit becomes unknown", withEnvAndFetch(
  async () => jsonResponse({ order_id: "bad-limit", fill_count: "3", average_fill_price: "0.51" }),
  async () => {
    await assert.rejects(placeOrder(BASE), (err: unknown) => {
      assert.ok(isUncertainOrderError(err));
      assert.equal((err as UncertainOrderError).reason, "fill_breached_submitted_limit");
      return true;
    });
  },
));

test("UncertainOrderError: narrowing helper matches instances and shaped objects", () => {
  const e = new UncertainOrderError("cid-1", "reason-x");
  assert.equal(isUncertainOrderError(e), true);
  assert.equal(isUncertainOrderError({ kind: "uncertain_order" }), true);
  assert.equal(isUncertainOrderError(new Error("plain")), false);
});
