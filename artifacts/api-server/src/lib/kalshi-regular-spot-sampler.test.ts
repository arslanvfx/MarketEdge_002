import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectRegularEntrySpotSamples,
  REGULAR_SPOT_SAMPLE_LIMIT,
  shouldRunRegularSpotSampler,
} from "./kalshi-regular-spot-sampler-core.ts";

test("non-conviction live regular mode owns the sampler lifecycle", () => {
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
  }), false);
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