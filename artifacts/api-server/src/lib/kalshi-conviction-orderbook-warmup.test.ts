import assert from "node:assert/strict";
import test from "node:test";
import { ConvictionOrderbookWarmupCoordinator } from "./kalshi-conviction-orderbook-warmup.ts";

test("failed exact-ticker warmup remains joinable and is not started twice", async () => {
  const coordinator = new ConvictionOrderbookWarmupCoordinator(100);
  let requests = 0;
  const fail = async () => {
    requests += 1;
    throw new Error("authenticated orderbook unavailable");
  };

  coordinator.start("BTC", "CURRENT", fail);
  assert.equal(await coordinator.wait("BTC", "CURRENT", 20), true);
  coordinator.start("BTC", "CURRENT", fail);

  assert.equal(requests, 1);
  assert.equal(await coordinator.wait("BTC", "CURRENT", 0), true);
});

test("timed-out exact-ticker warmup remains the sole authenticated request", async () => {
  const coordinator = new ConvictionOrderbookWarmupCoordinator(100);
  let requests = 0;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });

  coordinator.start("ETH", "CURRENT", async () => {
    requests += 1;
    await pending;
  });

  assert.equal(await coordinator.wait("ETH", "CURRENT", 5), true);
  coordinator.start("ETH", "CURRENT", async () => {
    requests += 1;
  });
  assert.equal(requests, 1);

  finish();
  assert.equal(await coordinator.wait("ETH", "CURRENT", 20), true);
  assert.equal(requests, 1);
});