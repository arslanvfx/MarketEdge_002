import assert from "node:assert/strict";
import test from "node:test";
import { PerKeyInFlight } from "./per-key-in-flight.ts";

test("a slow symbol does not block a fresh cycle for another symbol", async () => {
  const coordinator = new PerKeyInFlight();
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let fastRuns = 0;

  const slowRun = coordinator.run("GOLD", () => slow);
  await coordinator.run("BNB", async () => { fastRuns += 1; });
  await coordinator.run("BNB", async () => { fastRuns += 1; });

  assert.equal(fastRuns, 2);
  releaseSlow();
  await slowRun;
});

test("the same symbol remains coalesced while its request is active", async () => {
  const coordinator = new PerKeyInFlight();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;

  const first = coordinator.run("BNB", async () => { runs += 1; await pending; });
  const second = coordinator.run("BNB", async () => { runs += 1; });
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(runs, 1);
  release();
  await Promise.all([first, second]);
});