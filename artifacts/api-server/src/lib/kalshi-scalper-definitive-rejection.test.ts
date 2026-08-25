import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DefinitiveScalpOrderRejectionError,
  parseDefinitiveScalpOrderRejection,
} from "./kalshi-scalper-exchange.ts";

describe("definitive Scalper order rejections", () => {
  it("classifies market_not_found as authoritative no-order evidence", () => {
    const rejection = parseDefinitiveScalpOrderRejection(
      new Error(
        'Kalshi POST /portfolio/events/orders → 404: {"error":{"code":"market_not_found","message":"market not found"}}',
      ),
    );
    assert.deepEqual(rejection, {
      status: 404,
      code: "market_not_found",
      message:
        'Kalshi POST /portfolio/events/orders → 404: {"error":{"code":"market_not_found","message":"market not found"}}',
    });
  });

  it("keeps transport, proxy, throttling, and duplicate-id failures ambiguous", () => {
    assert.equal(parseDefinitiveScalpOrderRejection(new Error("fetch failed")), null);
    assert.equal(
      parseDefinitiveScalpOrderRejection(new Error("Kalshi POST /orders → 500: gateway")),
      null,
    );
    assert.equal(
      parseDefinitiveScalpOrderRejection(new Error("Kalshi POST /orders → 429: throttled")),
      null,
    );
    assert.equal(
      parseDefinitiveScalpOrderRejection(new Error("Kalshi POST /orders → 408: request timeout")),
      null,
    );
    assert.equal(
      parseDefinitiveScalpOrderRejection(new Error("Kalshi POST /orders → 425: too early")),
      null,
    );
    assert.equal(
      parseDefinitiveScalpOrderRejection(
        new Error('Kalshi POST /orders → 409: {"error":{"code":"duplicate_client_order_id"}}'),
      ),
      null,
    );
  });

  it("preserves typed definitive rejection details", () => {
    const error = new DefinitiveScalpOrderRejectionError({
      status: 400,
      code: "invalid_price",
      message: "Kalshi POST /orders → 400: invalid_price",
    });
    assert.deepEqual(parseDefinitiveScalpOrderRejection(error), {
      status: 400,
      code: "invalid_price",
      message: "Kalshi POST /orders → 400: invalid_price",
    });
  });

  it("keeps the persisted production market_not_found shape repairable", () => {
    const persisted =
      'scalp submit threw (fill state unknown): Error: Kalshi POST /portfolio/events/orders → 404: {"error":{"code":"market_not_found","message":"market not found"}}';
    assert.deepEqual(parseDefinitiveScalpOrderRejection(persisted), {
      status: 404,
      code: "market_not_found",
      message: persisted,
    });
  });
});