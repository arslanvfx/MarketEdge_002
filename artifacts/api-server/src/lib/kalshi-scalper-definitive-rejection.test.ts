import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DefinitiveScalpOrderRejectionError,
  parseDefinitiveScalpOrderRejection,
  placeScalpOrderStrict,
} from "./kalshi-scalper-exchange.ts";
import fs from "node:fs";
import { generateKeyPairSync } from "node:crypto";

describe("definitive Scalper order rejections", () => {
  it("matches the regular path by sending the final observed shard", async () => {
    const previousKeyId = process.env["KALSHI_API_KEY_ID"];
    const previousPrivateKey = process.env["KALSHI_PRIVATE_KEY"];
    const previousFetch = globalThis.fetch;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env["KALSHI_API_KEY_ID"] = "controlled-key";
    process.env["KALSHI_PRIVATE_KEY"] = privateKey.export({
      type: "pkcs1",
      format: "pem",
    }).toString();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('{"error":{"code":"market_not_found"}}', { status: 404 });
    };
    try {
      for (const exchangeIndex of [2, 0]) {
        await assert.rejects(
          placeScalpOrderStrict({
            ticker: `CONTROLLED-SHARD-${exchangeIndex}`,
            exchangeIndex,
            side: "yes",
            limitPrice: 0.97,
            count: 2,
            clientOrderId: `controlled-client-${exchangeIndex}`,
          }),
          DefinitiveScalpOrderRejectionError,
        );
      }
      assert.deepEqual(
        bodies.map((body) => body["exchange_index"]),
        [2, 0],
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKeyId === undefined) delete process.env["KALSHI_API_KEY_ID"];
      else process.env["KALSHI_API_KEY_ID"] = previousKeyId;
      if (previousPrivateKey === undefined) delete process.env["KALSHI_PRIVATE_KEY"];
      else process.env["KALSHI_PRIVATE_KEY"] = previousPrivateKey;
    }
  });

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

describe("stale pre-submit reservation reset recovery", () => {
  it("repairs only aged claimed reservations with no order intent", () => {
    const dbSource = fs.readFileSync(
      new URL("./kalshi-scalper-db.ts", import.meta.url),
      "utf8",
    );
    const start = dbSource.indexOf(
      "export async function releaseStalePreSubmitLiveReservations",
    );
    const end = dbSource.indexOf(
      "export async function getUnresolvedLiveAttempts",
      start,
    );
    const recovery = dbSource.slice(start, end);
    assert.match(recovery, /r\.status = 'claimed'/);
    assert.match(recovery, /r\.reserved_budget > 0/);
    assert.match(recovery, /COALESCE\(r\.attempted_at, r\.created_at\)/);
    assert.match(recovery, /NOT EXISTS[\s\S]*kalshi_scalp_orders/);
    assert.match(recovery, /status = 'skipped'/);
    assert.match(recovery, /reserved_budget = 0/);
  });

  it("serializes intent creation with recovery and rejects a released claim", () => {
    const dbSource = fs.readFileSync(
      new URL("./kalshi-scalper-db.ts", import.meta.url),
      "utf8",
    );
    const insertStart = dbSource.indexOf(
      "export async function insertScalpOrderIntent",
    );
    const insertEnd = dbSource.indexOf(
      "export async function finalizePaperOrderAndReleaseReservation",
      insertStart,
    );
    const insert = dbSource.slice(insertStart, insertEnd);
    assert.match(insert, /kalshi-scalper-cap:\$\{order\.mode\}/);
    assert.match(insert, /FROM kalshi_scalp_reservations/);
    assert.match(insert, /FOR UPDATE/);
    assert.match(insert, /row\["status"\] !== "claimed"/);
    assert.match(insert, /Number\(row\["reserved_budget"\][\s\S]*\) <= 0/);
    assert.ok(
      insert.indexOf("await _insertScalpOrder") >
        insert.indexOf('row["status"] !== "claimed"'),
    );
  });

  it("runs orphan recovery before the unresolved reset check", () => {
    const serviceSource = fs.readFileSync(
      new URL("./kalshi-scalper-service.ts", import.meta.url),
      "utf8",
    );
    const resetStart = serviceSource.indexOf(
      "export async function resetCircuitBreaker",
    );
    const resetEnd = serviceSource.indexOf(
      "export class ScalpReconciliationError",
      resetStart,
    );
    const reset = serviceSource.slice(resetStart, resetEnd);
    const recovery = reset.indexOf(
      "await releaseStalePreSubmitLiveReservations()",
    );
    const unresolvedCheck = reset.indexOf(
      "await countUnresolvedLiveAttempts()",
    );
    assert.ok(recovery >= 0);
    assert.ok(unresolvedCheck > recovery);
  });
});