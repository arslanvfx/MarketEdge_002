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
