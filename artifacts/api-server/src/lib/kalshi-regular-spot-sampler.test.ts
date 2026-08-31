import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  collectRegularEntrySpotSample,
  collectRegularEntrySpotSamples,
  isRegularSpotSampleOwnerActive,
  REGULAR_SPOT_SAMPLE_LIMIT,
  shouldRunRegularSpotSampler,
} from "./kalshi-regular-spot-sampler-core.ts";
import { PerKeyInFlight } from "./per-key-in-flight.ts";

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
      product: "PYTH:Commodities.Index.PYTHOIL/USD",
    }],
    fetchFresh: async (product) => {
      requested.push(product);
      return 72.5;
    },
    samples,
    nowMs: 900_000,
  });
  assert.deepEqual(requested, ["PYTH:Commodities.Index.PYTHOIL/USD"]);
  assert.deepEqual(samples.get("WTI"), [{ price: 72.5, ts: 900_000 }]);
});

test("Pyth publish evidence is retained while Coinbase keeps local cadence", async () => {
  const samples = new Map();
  await collectRegularEntrySpotSamples({
    products: [
      { symbol: "WTI", product: "PYTH:Commodities.Index.PYTHOIL/USD" },
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

test("repeated Kalshi CF publication identity is not counted as a fresh sample", async () => {
  const samples = new Map();
  const evidence = {
    price: 824.6,
    publishedAtMs: 899_900,
    sourceSequence: "ZECUSD_RTI:899900:824.60",
    source: "kalshi_cfbenchmarks",
    sourceIndex: "ZECUSD_RTI",
    websocketSequence: 17,
  };
  await collectRegularEntrySpotSample({
    product: { symbol: "ZEC", product: "ZEC-USD" },
    fetchFresh: async () => evidence,
    samples,
    nowMs: 900_000,
  });
  await collectRegularEntrySpotSample({
    product: { symbol: "ZEC", product: "ZEC-USD" },
    fetchFresh: async () => evidence,
    samples,
    nowMs: 901_000,
  });

  assert.equal(samples.get("ZEC").length, 1);
  assert.equal(samples.get("ZEC")[0].sourceIndex, "ZECUSD_RTI");
  assert.equal(samples.get("ZEC")[0].websocketSequence, 17);
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

test("regular sampling publishes BNB while an unrelated product remains hung", async () => {
  const coordinator = new PerKeyInFlight();
  const samples = new Map<string, Array<{ price: number; ts: number }>>();
  let releaseGold!: () => void;
  const goldFetch = new Promise<number>((resolve) => { releaseGold = () => resolve(2_500); });

  const gold = coordinator.run("GOLD", () => collectRegularEntrySpotSample({
    product: { symbol: "GOLD", product: "PYTH:Metal.XAU/USD" },
    fetchFresh: () => goldFetch,
    samples,
    nowMs: 900_000,
  }));
  await coordinator.run("BNB", () => collectRegularEntrySpotSample({
    product: { symbol: "BNB", product: "BNB-USD" },
    fetchFresh: async () => 850,
    samples,
    nowMs: 900_000,
  }));

  assert.deepEqual(samples.get("BNB"), [{ price: 850, ts: 900_000 }]);
  assert.equal(samples.has("GOLD"), false);
  releaseGold();
  await gold;
});

test("retired generation, stopped sampler, and rolled window all reject publication", () => {
  const base = {
    capturedGeneration: 4,
    currentGeneration: 4,
    samplerRunning: true,
    capturedWindowStartMs: 900_000,
    currentWindowStartMs: 900_000,
    clockWindowStartMs: 900_000,
  };
  assert.equal(isRegularSpotSampleOwnerActive(base), true);
  assert.equal(isRegularSpotSampleOwnerActive({ ...base, currentGeneration: 5 }), false);
  assert.equal(isRegularSpotSampleOwnerActive({ ...base, samplerRunning: false }), false);
  assert.equal(isRegularSpotSampleOwnerActive({ ...base, currentWindowStartMs: 1_800_000 }), false);
  assert.equal(isRegularSpotSampleOwnerActive({ ...base, clockWindowStartMs: 1_800_000 }), false);
});

test("conviction spot sampling coalesces per symbol without global head-of-line blocking", () => {
  const source = readFileSync(
    new URL("./kalshi-conviction-poller.ts", import.meta.url),
    "utf8",
  );
  const pollBody = source.slice(
    source.indexOf("async function pollOnceImpl"),
    source.indexOf("function pollOnce()"),
  );
  assert.doesNotMatch(pollBody, /refreshSpotTick|spotWarmups/);
  assert.match(source, /spotSamplesInFlight\.run\(sym/);
  assert.doesNotMatch(source, /if \(spotSampleInFlight\) return spotSampleInFlight/);
  assert.match(source, /spotSamplerHandle = setInterval/);
  assert.match(source, /clearInterval\(spotSamplerHandle\)/);
  assert.match(source, /spotSamplesInFlight\.clear\(\)/);
  assert.match(source, /getTickerFreshEvidence\(product\)/);
});