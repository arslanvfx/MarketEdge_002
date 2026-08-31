import { test } from "node:test";
import assert from "node:assert/strict";

import { KalshiPythValueService } from "./kalshi-pyth-value-service.ts";

test("malformed publication invalidates previously fresh commodity evidence", () => {
  const service = new KalshiPythValueService();
  const nowMs = Date.now();
  const receive = (payload: unknown) => {
    (service as unknown as { onMessage(data: Buffer): void })
      .onMessage(Buffer.from(JSON.stringify(payload)));
  };

  receive({
    type: "pyth_value",
    seq: 1,
    msg: {
      underlying_ticker: "Metal.XAU/USD",
      value_usd: "4400.25",
      source_ts_ms: nowMs - 100,
      received_at: nowMs,
    },
  });
  assert.notEqual(service.getStatus(nowMs).underlyings["Metal.XAU/USD"], null);

  receive({
    type: "pyth_value",
    seq: 2,
    msg: {
      underlying_ticker: "Metal.XAU/USD",
      value_usd: "malformed",
      source_ts_ms: nowMs,
      received_at: nowMs,
    },
  });

  const status = service.getStatus(nowMs);
  assert.equal(status.underlyings["Metal.XAU/USD"], null);
  assert.match(status.lastFailureReason ?? "", /malformed pyth_value frame/);
});