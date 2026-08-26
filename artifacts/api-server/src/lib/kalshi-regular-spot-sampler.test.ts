import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  collectRegularEntrySpotSamples,
  REGULAR_SPOT_SAMPLE_LIMIT,
  shouldRunRegularSpotSampler,
} from "./kalshi-regular-spot-sampler-core.ts";

test("non-conviction paper and live modes own the sampler lifecycle", () => {
  assert.equal(shouldRunRegularSpotSampler({
    enabled: true,
    paused: false,
    botMode: "live",
    decisionMode: "statistical",
  }), true);
  assert.equal(shouldRunRegularSpotSampler({
    enabled: true,
    paused: false,
    botMode: "live",
    decisionMode: "conviction",
  }), false);
  assert.equal(shouldRunRegularSpotSampler({
    enabled: true,
    paused: false,
    botMode: "paper",
    decisionMode: "statistical",
  }), true);
  assert.equal(shouldRunRegularSpotSampler({
    enabled: true,
    paused: true,
    botMode: "live",
    decisionMode: "statistical",
  }), false);
});

test("WTI is sampled through its exact Pyth product route", async () => {
  const requested: string[] = [];
  const samples = new Map<string, Array<{ price: number; ts: number }>>();
  await collectRegularEntrySpotSamples({
    products: [{
      symbol: "WTI",
      product: "PYTH:Commodities.USOILSPOT",
    }],
    fetchFresh: async (product) => {
      requested.push(product);
      return 72.5;
    },
    samples,
    nowMs: 900_000,
  });
  assert.deepEqual(requested, ["PYTH:Commodities.USOILSPOT"]);
  assert.deepEqual(samples.get("WTI"), [{ price: 72.5, ts: 900_000 }]);
});

test("Pyth publish evidence is retained while Coinbase keeps local cadence", async () => {
  const samples = new Map();
  await collectRegularEntrySpotSamples({
    products: [
      { symbol: "WTI", product: "PYTH:Commodities.USOILSPOT" },
      { symbol: "BTC", product: "BTC-USD" },
    ],
    fetchFresh: async (product) => product.startsWith("PYTH:")
      ? { price: 72.5, publishedAtMs: 899_500 }
      : { price: 100_000, publishedAtMs: null },
    samples,
    nowMs: 900_000,
  });
  assert.deepEqual(samples.get("WTI"), [{
    price: 72.5,
    ts: 900_000,
    oraclePublishedAtMs: 899_500,
    oracleAgeMs: 500,
  }]);
  assert.deepEqual(samples.get("BTC"), [{ price: 100_000, ts: 900_000 }]);
});

test("samples are current-window-only and bounded", async () => {
  const nowMs = 1_800_000;
  const samples = new Map<string, Array<{ price: number; ts: number }>>([
    ["BTC", [
      { price: 1, ts: 899_999 },
      ...Array.from({ length: REGULAR_SPOT_SAMPLE_LIMIT }, (_, index) => ({
        price: index + 2,
        ts: 900_000 + index,
      })),
    ]],
  ]);
  await collectRegularEntrySpotSamples({
    products: [{ symbol: "BTC", product: "BTC-USD" }],
    fetchFresh: async () => 999,
    samples,
    nowMs,
  });
  const kept = samples.get("BTC")!;
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0], { price: 999, ts: nowMs });
});

test("conviction spot sampling has an independent no-overlap lifecycle", () => {
  const source = readFileSync(
    new URL("./kalshi-conviction-poller.ts", import.meta.url),
    "utf8",
  );
  const pollBody = source.slice(
    source.indexOf("async function pollOnceImpl"),
    source.indexOf("function pollOnce()"),
  );
  assert.doesNotMatch(pollBody, /refreshSpotTick|spotWarmups/);
  assert.match(source, /if \(spotSampleInFlight\) return spotSampleInFlight/);
  assert.match(source, /spotSamplerHandle = setInterval/);
  assert.match(source, /clearInterval\(spotSamplerHandle\)/);
  assert.match(source, /getTickerFreshEvidence\(product\)/);
});