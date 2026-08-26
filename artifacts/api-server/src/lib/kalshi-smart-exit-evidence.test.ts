import assert from "node:assert/strict";
import { test } from "node:test";
import { KalshiSmartExitEvidenceCollector, type SmartExitEvidenceFetch } from "./kalshi-smart-exit-evidence.ts";

const reply = (body: unknown) => ({ ok: true, json: async () => body });

test("collects independent Coinbase ticker, tape, and L2 evidence", async () => {
  let clock = 1_000_000;
  const fetch: SmartExitEvidenceFetch = async (url) => {
    if (url.includes("/ticker")) return reply({ price: "110", time: "1970-01-01T00:16:40.000Z" });
    if (url.includes("/trades")) return reply([
      { trade_id: 2, price: "110", size: "3", side: "sell", time: "1970-01-01T00:16:40.000Z" },
      { trade_id: 1, price: "109", size: "1", side: "buy", time: "1970-01-01T00:16:40.000Z" },
    ]);
    return reply({ bids: [["109", "4"]], asks: [["111", "1"]] });
  };
  const collector = new KalshiSmartExitEvidenceCollector({ fetch, now: () => clock, momentumWindowSeconds: 1 });
  await collector.collect("BTC", "BTC-USD", 0.6);
  clock += 1_000;
  const evidence = await collector.collect("BTC", "BTC-USD", 0.6);
  assert.equal(evidence.underlyingPrice, 110);
  assert.equal(evidence.spotReceivedAtSeconds, 1001);
  assert.equal(evidence.tapeReceivedAtSeconds, 1001);
  assert.equal(evidence.bookReceivedAtSeconds, 1001);
  assert.equal(evidence.tradeFlowImbalance, 0.5); // maker sell -> aggressive buy
  assert.equal(evidence.bookImbalance, 0.6);
  assert.equal(evidence.marketWinProbability, 0.6);
  assert.equal(collector.health().tradeSamples, 2); // repeated tape IDs dedupe
});

test("unsupported Pyth products never become tape or book evidence", async () => {
  const collector = new KalshiSmartExitEvidenceCollector({
    now: () => 1_000,
    fetch: async () => { throw new Error("must not fetch"); },
  });
  const evidence = await collector.collect("GOLD", "PYTH:Metal.XAU/USD", 0.5);
  assert.equal(evidence.source, "unsupported");
  assert.equal(evidence.underlyingPrice, null);
  assert.equal(evidence.tradeFlowImbalance, null);
  assert.equal(evidence.bookImbalance, null);
  collector.stop();
  assert.equal(collector.latest("GOLD"), null);
});

test("a failed subfeed is null rather than a cached or neutral substitute", async () => {
  const fetch: SmartExitEvidenceFetch = async (url) => {
    if (url.includes("/ticker")) return reply({ price: "100", time: "1970-01-01T00:00:01.000Z" });
    if (url.includes("/trades")) return { ok: false, json: async () => ({}) };
    return reply({ bids: [["99", "2"]], asks: [["101", "2"]] });
  };
  const collector = new KalshiSmartExitEvidenceCollector({ fetch, now: () => 1_000 });
  const evidence = await collector.collect("BTC", "BTC-USD", 0.5);
  assert.equal(evidence.underlyingPrice, 100);
  assert.equal(evidence.tapeObservedAtSeconds, null);
  assert.equal(evidence.tradeFlowImbalance, null);
  assert.equal(evidence.volatilityLogReturnPerSqrtSecond, null);
});

test("freshly received quiet tape keeps transport freshness separate from event age", async () => {
  const fetch: SmartExitEvidenceFetch = async (url) => {
    if (url.includes("/ticker")) return reply({ price: "100", time: "1970-01-01T00:01:40.000Z" });
    if (url.includes("/trades")) return reply([
      { trade_id: 1, price: "100", size: "1", side: "sell", time: "1970-01-01T00:01:30.000Z" },
    ]);
    return reply({ bids: [["99", "2"]], asks: [["101", "2"]] });
  };
  const collector = new KalshiSmartExitEvidenceCollector({ fetch, now: () => 100_000 });
  const evidence = await collector.collect("BTC", "BTC-USD", 0.5);
  assert.equal(evidence.tapeReceivedAtSeconds, 100);
  assert.equal(evidence.tapeObservedAtSeconds, 90);
});