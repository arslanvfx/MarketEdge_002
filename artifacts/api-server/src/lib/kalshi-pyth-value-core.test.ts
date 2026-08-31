import { test } from "node:test";
import assert from "node:assert/strict";

import { parseKalshiPythValueFrame } from "./kalshi-pyth-value-core.ts";

test("Kalshi pyth_value parser retains authoritative publication evidence", () => {
  const evidence = parseKalshiPythValueFrame({
    type: "pyth_value",
    sid: 1,
    seq: 42,
    msg: {
      underlying_ticker: "Metal.XAU/USD",
      value_usd: "4435.86000000",
      source_ts_ms: 1_800_000_100,
      received_at: 1_800_000_123,
    },
  }, 1_800_000_200);
  assert.deepEqual(evidence, {
    underlyingTicker: "Metal.XAU/USD",
    price: 4435.86,
    sourceTsMs: 1_800_000_100,
    receivedAtMs: 1_800_000_123,
    sourceSequence: "1800000100:4435.86000000",
  });
});

test("Kalshi pyth_value parser ignores unrelated frames", () => {
  assert.equal(parseKalshiPythValueFrame({
    type: "subscribed",
    msg: { channel: "pyth_value", sid: 1 },
  }, 1_800_000_200), null);
});

test("Kalshi pyth_value parser fails closed on malformed or future evidence", () => {
  assert.throws(() => parseKalshiPythValueFrame({
    type: "pyth_value",
    msg: {
      underlying_ticker: "Commodities.Index.PYTHOIL/USD",
      value_usd: "not-a-number",
      source_ts_ms: 1_800_000_100,
    },
  }, 1_800_000_200), /malformed/);
  assert.throws(() => parseKalshiPythValueFrame({
    type: "pyth_value",
    msg: {
      underlying_ticker: "Metal.XAG/USD",
      value_usd: "67.12",
      source_ts_ms: 1_800_010_000,
    },
  }, 1_800_000_200), /in the future/);
});