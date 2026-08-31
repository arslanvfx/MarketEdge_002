import { test } from "node:test";
import assert from "node:assert/strict";

import { parseKalshiCfBenchmarksValueFrame } from "./kalshi-cfbenchmarks-value-core.ts";
import { CF_BENCHMARKS_CRYPTO_FEEDS } from "./market-defs.ts";

test("parses settlement-aligned CF Benchmarks frames with source identity", () => {
  const nowMs = 1_788_184_469_100;
  const result = parseKalshiCfBenchmarksValueFrame({
    type: "cfbenchmarks_value",
    sid: 1,
    seq: 29,
    msg: {
      index_id: "ZECUSD_RTI",
      received_at: nowMs,
      data: JSON.stringify({
        type: "value",
        time: nowMs - 100,
        id: "ZECUSD_RTI",
        value: "824.60",
      }),
      avg_60s_data: { value: "825.10350000" },
    },
  }, nowMs);

  assert.equal(result?.indexId, "ZECUSD_RTI");
  assert.equal(result?.price, 824.6);
  assert.equal(result?.sourceTsMs, nowMs - 100);
  assert.equal(result?.websocketSequence, 29);
  assert.equal(result?.sourceSequence, `ZECUSD_RTI:${nowMs - 100}:824.60`);
  assert.equal(result?.average60s, 825.1035);
});

test("rejects a frame whose outer and embedded index identities differ", () => {
  assert.throws(() => parseKalshiCfBenchmarksValueFrame({
    type: "cfbenchmarks_value",
    seq: 1,
    msg: {
      index_id: "ZECUSD_RTI",
      received_at: 100_000,
      data: JSON.stringify({
        type: "value",
        time: 99_900,
        id: "ETHUSDRTI",
        value: "824.60",
      }),
    },
  }, 100_000), /mismatched/);
});

test("all tracked crypto products map to the exact Kalshi settlement RTI", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(CF_BENCHMARKS_CRYPTO_FEEDS).map(
      ([symbol, feed]) => [symbol, feed.indexId],
    )),
    {
      BTC: "BRTI",
      ETH: "ETHUSDRTI",
      SOL: "SOLUSDRTI",
      XRP: "XRPUSDRTI",
      HYPE: "HYPEUSDRTI",
      BNB: "BNBUSDRTI",
      DOGE: "DOGEUSDRTI",
      NEAR: "NEARUSDRTI",
      ZEC: "ZECUSDRTI",
    },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(CF_BENCHMARKS_CRYPTO_FEEDS).map(
      ([symbol, feed]) => [symbol, feed.streamIndexId],
    )),
    {
      BTC: "BRTI",
      ETH: "ETHUSD_RTI",
      SOL: "SOLUSD_RTI",
      XRP: "XRPUSD_RTI",
      HYPE: "HYPEUSD_RTI",
      BNB: "BNBUSD_RTI",
      DOGE: "DOGEUSD_RTI",
      NEAR: "NEARUSD_RTI",
      ZEC: "ZECUSD_RTI",
    },
  );
});