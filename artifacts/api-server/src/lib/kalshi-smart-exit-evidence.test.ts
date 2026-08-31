import assert from "node:assert/strict";
import { test } from "node:test";
import { KalshiSmartExitEvidenceCollector, type SmartExitEvidenceFetch } from "./kalshi-smart-exit-evidence.ts";

const reply = (body: unknown) => ({ ok: true, json: async () => body });

test("collects Kalshi CF spot with independent Coinbase tape and L2 evidence", async () => {
  let clock = 1_000_000;
  const fetch: SmartExitEvidenceFetch = async (url) => {
    if (url.includes("/trades")) return reply([
      { trade_id: 2, price: "110", size: "3", side: "sell", time: "1970-01-01T00:16:40.000Z" },
      { trade_id: 1, price: "109", size: "1", side: "buy", time: "1970-01-01T00:16:40.000Z" },
    ]);
    return reply({ bids: [["109", "4"]], asks: [["111", "1"]] });
  };
  const collector = new KalshiSmartExitEvidenceCollector({
    fetch,
    now: () => clock,
    momentumWindowSeconds: 1,
    readCfBenchmarks: async () => ({
      price: 110,
      publishedAtMs: clock,
      receivedAtMs: clock,
      sourceSequence: `BRTI:${clock}:110`,
    }),
  });
  await collector.collect("BTC", "BTC-USD", 0.6);
  clock += 1_000;
  const evidence = await collector.collect("BTC", "BTC-USD", 0.6);
  assert.equal(evidence.underlyingPrice, 110);
  assert.equal(evidence.source, "kalshi-cfbenchmarks");
  assert.equal(evidence.spotReceivedAtSeconds, 1001);
  assert.equal(evidence.tapeReceivedAtSeconds, 1001);
  assert.equal(evidence.bookReceivedAtSeconds, 1001);
  assert.equal(evidence.tradeFlowImbalance, 0.5); // maker sell -> aggressive buy
  assert.equal(evidence.bookImbalance, 0.6);
  assert.equal(evidence.marketWinProbability, 0.6);
  assert.equal(collector.health().tradeSamples, 2); // repeated tape IDs dedupe
});

test("Pyth products require an authoritative reader and never synthesize tape or book evidence", async () => {
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

test("Kalshi Pyth evidence uses distinct upstream publications and fails closed on stale transport", async () => {
  let clock = 20_000;
  let publication = {
    price: 100,
    publishedAtMs: 20_000,
    receivedAtMs: 20_000,
    sourceSequence: "20000:100",
  };
  const collector = new KalshiSmartExitEvidenceCollector({
    now: () => clock,
    momentumWindowSeconds: 2,
    readPyth: async () => publication,
  });
  await collector.collectSpot("GOLD", "PYTH:Metal.XAU/USD", null);
  clock += 1_000;
  const duplicate = await collector.collectSpot("GOLD", "PYTH:Metal.XAU/USD", null);
  assert.equal(duplicate.source, "kalshi-pyth");
  assert.equal(duplicate.spotTrajectoryAtSeconds, 20);
  assert.equal(collector.health().priceSamples, 1);

  publication = {
    price: 99.8,
    publishedAtMs: 21_000,
    receivedAtMs: 21_000,
    sourceSequence: "21000:99.8",
  };
  await collector.collectSpot("GOLD", "PYTH:Metal.XAU/USD", null);
  clock += 1_000;
  publication = {
    price: 99.6,
    publishedAtMs: 22_000,
    receivedAtMs: 22_000,
    sourceSequence: "22000:99.6",
  };
  const ready = await collector.collectSpot("GOLD", "PYTH:Metal.XAU/USD", null);
  assert.equal(ready.momentumLogReturn !== null, true);
  assert.equal(ready.tradeFlowImbalance, null);
  assert.equal(ready.bookImbalance, null);
  assert.equal(collector.health().priceSamples, 3);
  assert.equal(
    collector.health().latestBySymbol.GOLD?.spotObservedAtSeconds,
    ready.spotObservedAtSeconds,
  );

  clock += 1_000;
  publication = {
    price: 99.5,
    publishedAtMs: 21_000,
    receivedAtMs: 21_000,
    sourceSequence: "regressed",
  };
  const regressed = await collector.collectSpot("GOLD", "PYTH:Metal.XAU/USD", null);
  assert.equal(regressed.underlyingPrice, null);
  assert.match(regressed.failureReason ?? "", /regressed/);

  publication = {
    price: 99.4,
    publishedAtMs: 21_500,
    receivedAtMs: 23_000,
    sourceSequence: "still-old-after-failure",
  };
  const stillRegressed = await collector.collectSpot("GOLD", "PYTH:Metal.XAU/USD", null);
  assert.equal(stillRegressed.underlyingPrice, null);
  assert.match(stillRegressed.failureReason ?? "", /regressed/);
});

test("GOLD, SILVER, and WTI all route through Kalshi Pyth publication identity", async () => {
  const products = [
    "PYTH:Metal.XAU/USD",
    "PYTH:Metal.XAG/USD",
    "PYTH:Commodities.Index.PYTHOIL/USD",
  ];
  for (const [index, product] of products.entries()) {
    const nowMs = 50_000 + index;
    const collector = new KalshiSmartExitEvidenceCollector({
      now: () => nowMs,
      readPyth: async (requestedProduct) => {
        assert.equal(requestedProduct, product);
        return {
          price: 70 + index,
          publishedAtMs: nowMs - 50,
          receivedAtMs: nowMs - 25,
          sourceSequence: `${product}:${index}`,
        };
      },
    });
    const result = await collector.collectSpot(`commodity-${index}`, product, null);
    assert.equal(result.source, "kalshi-pyth");
    assert.equal(result.spotSourceSequence, `${product}:${index}`);
    assert.equal(result.spotTrajectoryAtSeconds, (nowMs - 25) / 1_000);
  }
});

test("a failed subfeed is null rather than a cached or neutral substitute", async () => {
  const fetch: SmartExitEvidenceFetch = async (url) => {
    if (url.includes("/trades")) return { ok: false, json: async () => ({}) };
    return reply({ bids: [["99", "2"]], asks: [["101", "2"]] });
  };
  const collector = new KalshiSmartExitEvidenceCollector({
    fetch,
    now: () => 1_000,
    readCfBenchmarks: async () => ({
      price: 100,
      publishedAtMs: 1_000,
      receivedAtMs: 1_000,
      sourceSequence: "BRTI:1000:100",
    }),
  });
  const evidence = await collector.collect("BTC", "BTC-USD", 0.5);
  assert.equal(evidence.underlyingPrice, 100);
  assert.equal(evidence.tapeObservedAtSeconds, null);
  assert.equal(evidence.tradeFlowImbalance, null);
  assert.equal(evidence.volatilityLogReturnPerSqrtSecond, null);
});

test("freshly received quiet tape keeps transport freshness separate from event age", async () => {
  const fetch: SmartExitEvidenceFetch = async (url) => {
    if (url.includes("/trades")) return reply([
      { trade_id: 1, price: "100", size: "1", side: "sell", time: "1970-01-01T00:01:30.000Z" },
    ]);
    return reply({ bids: [["99", "2"]], asks: [["101", "2"]] });
  };
  const collector = new KalshiSmartExitEvidenceCollector({
    fetch,
    now: () => 100_000,
    readCfBenchmarks: async () => ({
      price: 100,
      publishedAtMs: 100_000,
      receivedAtMs: 100_000,
      sourceSequence: "BRTI:100000:100",
    }),
  });
  const evidence = await collector.collect("BTC", "BTC-USD", 0.5);
  assert.equal(evidence.tapeReceivedAtSeconds, 100);
  assert.equal(evidence.tapeObservedAtSeconds, 90);
});

test("bounded pre-position collection is ready for a newly opened position and survives repeated warm samples", async () => {
  let clock = 20_000;
  let tick = 0;
  const fetch: SmartExitEvidenceFetch = async (url) => {
    if (url.includes("/trades")) return reply([
      { trade_id: `old-${tick}`, price: "99", size: "1", side: "buy", time: new Date(clock - 16_000).toISOString() },
      { trade_id: `new-${tick}`, price: "101", size: "2", side: "sell", time: new Date(clock).toISOString() },
    ]);
    return reply({ bids: [["100", "2"]], asks: [["102", "1"]] });
  };
  const collector = new KalshiSmartExitEvidenceCollector({
    fetch, now: () => clock, momentumWindowSeconds: 3, maxPriceSamples: 4, maxTradeSamples: 4,
    readCfBenchmarks: async () => {
      tick += 1;
      return {
        price: 100 + tick,
        publishedAtMs: clock,
        receivedAtMs: clock,
        sourceSequence: `ZECUSD_RTI:${clock}:${100 + tick}`,
      };
    },
  });
  for (let index = 0; index < 5; index += 1) {
    await collector.collect("ZEC", "ZEC-USD", null);
    clock += 1_000;
  }
  const atOpen = collector.latest("ZEC")!;
  assert.notEqual(atOpen.volatilityLogReturnPerSqrtSecond, null);
  assert.notEqual(atOpen.momentumLogReturn, null);
  assert.notEqual(atOpen.tradeFlowImbalance, null);
  assert.equal(collector.health().priceSamples <= 4, true);
  assert.equal(collector.health().tradeSamples <= 4, true);
});

test("hot Kalshi CF observations preserve publication identity and do not manufacture movement", async () => {
  let clock = 100_000;
  let publication = {
    price: 100,
    publishedAtMs: 100_000,
    receivedAtMs: 100_000,
    sourceSequence: "BNBUSD_RTI:100000:100",
  };
  const collector = new KalshiSmartExitEvidenceCollector({
    now: () => clock,
    momentumWindowSeconds: 1,
    readCfBenchmarks: async () => publication,
  });

  const first = await collector.collectSpot("BNB", "BNB-USD", null);
  clock += 500;
  const duplicate = await collector.collectSpot("BNB", "BNB-USD", null);

  assert.equal(first.spotObservedAtSeconds, 100);
  assert.equal(duplicate.spotObservedAtSeconds, 100);
  assert.equal(duplicate.spotTrajectoryAtSeconds, 100);
  assert.equal(collector.health().priceSamples, 1);

  clock += 500;
  publication = {
    price: 99,
    publishedAtMs: 101_000,
    receivedAtMs: 101_000,
    sourceSequence: "BNBUSD_RTI:101000:99",
  };
  clock = 101_000;
  const changed = await collector.collectSpot("BNB", "BNB-USD", null);
  assert.equal(changed.spotObservedAtSeconds, 101);
  assert.equal(collector.health().priceSamples, 2);
});

test("all nine crypto products route through Kalshi CF Benchmarks identities", async () => {
  const products = [
    "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "HYPE-USD",
    "BNB-USD", "DOGE-USD", "NEAR-USD", "ZEC-USD",
  ];
  for (const [index, product] of products.entries()) {
    const nowMs = 200_000 + index;
    const collector = new KalshiSmartExitEvidenceCollector({
      now: () => nowMs,
      readCfBenchmarks: async (requestedProduct) => {
        assert.equal(requestedProduct, product);
        return {
          price: 1_000 + index,
          publishedAtMs: nowMs - 20,
          receivedAtMs: nowMs - 10,
          sourceSequence: `${product}:${nowMs}`,
        };
      },
    });
    const result = await collector.collectSpot(`crypto-${index}`, product, null);
    assert.equal(result.source, "kalshi-cfbenchmarks");
    assert.equal(result.underlyingPrice, 1_000 + index);
    assert.equal(result.spotSourceSequence, `${product}:${nowMs}`);
  }
});