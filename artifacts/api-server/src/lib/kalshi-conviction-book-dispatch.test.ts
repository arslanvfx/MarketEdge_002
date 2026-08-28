import assert from "node:assert/strict";
import test from "node:test";
import {
  ConvictionBookDispatchCoordinator,
  ConvictionDispatchInFlightGate,
} from "./kalshi-conviction-book-dispatch.ts";

const candidate = {
  sym: "BTC", windowKey: "2026-07-18T00:15", ticker: "KXBTC",
  target: 100, lockPrice: .9, lockPriceCap: .95,
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("authenticated book dispatcher sends YES and NO in-zone updates", async () => {
  const dispatched: Array<[number | null, number | null]> = [];
  let top = { yesAsk: .92, noAsk: .2, bookVersion: "1:1" };
  const coordinator = new ConvictionBookDispatchCoordinator({
    isActive: () => true, isFresh: () => true, getTopOfBook: () => ({ ticker: "KXBTC", yesBid: null, noBid: null, seq: 1, updatedAt: 1, ...top }),
    candidatesForTicker: () => [candidate],
    dispatch: (_candidate, yesAsk, noAsk) => { dispatched.push([yesAsk, noAsk]); },
  });
  coordinator.onAcceptedBookUpdate("KXBTC");
  await settle();
  top = { yesAsk: .2, noAsk: .93, bookVersion: "1:2" };
  coordinator.onAcceptedBookUpdate("KXBTC");
  await settle();
  assert.deepEqual(dispatched, [[.92, .2], [.2, .93]]);
});

test("dispatcher rejects wrong ticker and fail-closed stale/gapped lifecycle", async () => {
  let fresh = true;
  let top = true;
  let candidateTicker = "OTHER";
  let count = 0;
  const coordinator = new ConvictionBookDispatchCoordinator({
    isActive: () => true, isFresh: () => fresh,
    getTopOfBook: () => top ? { ticker: "KXBTC", yesAsk: .92, yesBid: .9, noAsk: .1, noBid: .08, seq: 1, updatedAt: 1, bookVersion: "1:1" } : null,
    candidatesForTicker: () => [{ ...candidate, ticker: candidateTicker }],
    dispatch: () => { count += 1; },
  });
  coordinator.onAcceptedBookUpdate("KXBTC"); await settle();
  candidateTicker = "KXBTC"; fresh = false;
  coordinator.onAcceptedBookUpdate("KXBTC"); await settle();
  fresh = true; top = false; // reconnect/gap cleared the book
  coordinator.onAcceptedBookUpdate("KXBTC"); await settle();
  assert.equal(count, 0);
});

test("dispatcher coalesces burst updates and races while a guarded tick is active", async () => {
  let resolveTick!: () => void;
  const tick = new Promise<void>((resolve) => { resolveTick = resolve; });
  let count = 0;
  const coordinator = new ConvictionBookDispatchCoordinator({
    isActive: () => true, isFresh: () => true,
    getTopOfBook: () => ({ ticker: "KXBTC", yesAsk: .92, yesBid: .9, noAsk: .1, noBid: .08, seq: 1, updatedAt: 1, bookVersion: "1:1" }),
    candidatesForTicker: () => [candidate],
    dispatch: () => { count += 1; return tick; },
  });
  coordinator.onAcceptedBookUpdate("KXBTC");
  coordinator.onAcceptedBookUpdate("KXBTC");
  coordinator.onAcceptedBookUpdate("KXBTC");
  await settle();
  coordinator.onAcceptedBookUpdate("KXBTC"); // poller/WS race during tick
  await settle();
  assert.equal(count, 1);
  resolveTick();
  await settle();
});

test("dispatcher sends unchanged top immediately once, then retries after zero-fill cooldown", async () => {
  let now = 100;
  let count = 0;
  const coordinator = new ConvictionBookDispatchCoordinator({
    isActive: () => true, isFresh: () => true, now: () => now,
    getTopOfBook: () => ({
      ticker: "KXBTC", yesAsk: .92, yesBid: .9, noAsk: .1, noBid: .08,
      seq: now, updatedAt: now, bookVersion: `1:${now}`,
    }),
    candidatesForTicker: () => [candidate],
    dispatch: () => { count += 1; },
  });
  coordinator.onAcceptedBookUpdate("KXBTC");
  await settle();
  assert.equal(count, 1, "first actionable top must dispatch immediately");

  now = 999;
  coordinator.onAcceptedBookUpdate("KXBTC");
  await settle();
  assert.equal(count, 1, "unchanged top must not churn the guarded tick");

  now = 1_100;
  coordinator.onAcceptedBookUpdate("KXBTC");
  await settle();
  assert.equal(count, 2, "unchanged top remains eligible after the one-second retry floor");
});

test("dispatcher sends a top-price change immediately during the retry interval", async () => {
  let now = 100;
  let yesAsk = .92;
  let count = 0;
  const coordinator = new ConvictionBookDispatchCoordinator({
    isActive: () => true, isFresh: () => true, now: () => now,
    getTopOfBook: () => ({
      ticker: "KXBTC", yesAsk, yesBid: .9, noAsk: .1, noBid: .08,
      seq: now, updatedAt: now, bookVersion: `1:${now}`,
    }),
    candidatesForTicker: () => [candidate],
    dispatch: () => { count += 1; },
  });
  coordinator.onAcceptedBookUpdate("KXBTC");
  await settle();
  yesAsk = .93;
  now = 101;
  coordinator.onAcceptedBookUpdate("KXBTC");
  await settle();
  assert.equal(count, 2);
});

test("shared in-flight gate coalesces a public-poller and websocket race", async () => {
  const gate = new ConvictionDispatchInFlightGate();
  let resolvePoller!: () => void;
  const pollerTick = new Promise<void>((resolve) => { resolvePoller = resolve; });
  let dispatches = 0;
  const first = gate.run("BTC:window:ticker", () => {
    dispatches += 1;
    return pollerTick;
  });
  const raced = gate.run("BTC:window:ticker", () => {
    dispatches += 1;
  });
  assert.ok(first);
  assert.equal(raced, null);
  assert.equal(dispatches, 0, "the guarded operation begins on the next microtask");
  await settle();
  assert.equal(dispatches, 1);
  resolvePoller();
  await first;
  const afterCompletion = gate.run("BTC:window:ticker", () => {
    dispatches += 1;
  });
  assert.ok(afterCompletion);
  await afterCompletion;
  assert.equal(dispatches, 2);
});

test("dispatcher re-checks active state after a queued websocket burst", async () => {
  let active = true;
  let count = 0;
  const coordinator = new ConvictionBookDispatchCoordinator({
    isActive: () => active,
    isFresh: () => true,
    getTopOfBook: () => ({
      ticker: "KXBTC", yesAsk: .92, yesBid: .9, noAsk: .1, noBid: .08,
      seq: 1, updatedAt: Date.now(), bookVersion: "1:1",
    }),
    candidatesForTicker: () => [candidate],
    dispatch: () => { count += 1; },
  });
  coordinator.onAcceptedBookUpdate("KXBTC");
  active = false;
  await settle();
  assert.equal(count, 0);
});

test("dispatcher fails closed and reports synchronous candidate errors", async () => {
  const events: string[] = [];
  const coordinator = new ConvictionBookDispatchCoordinator({
    isActive: () => true,
    isFresh: () => true,
    getTopOfBook: () => ({
      ticker: "KXBTC", yesAsk: .92, yesBid: .9, noAsk: .1, noBid: .08,
      seq: 1, updatedAt: Date.now(), bookVersion: "1:1",
    }),
    candidatesForTicker: () => { throw new Error("candidate failure"); },
    dispatch: () => { throw new Error("must not dispatch"); },
    telemetry: (event) => { events.push(event); },
  });
  coordinator.onAcceptedBookUpdate("KXBTC");
  await settle();
  assert.deepEqual(events, ["error"]);
});

test("dispatcher contains telemetry failures and remains usable", async () => {
  let dispatches = 0;
  const coordinator = new ConvictionBookDispatchCoordinator({
    isActive: () => true,
    isFresh: () => true,
    getTopOfBook: () => ({
      ticker: "KXBTC", yesAsk: .92, yesBid: .9, noAsk: .1, noBid: .08,
      seq: 1, updatedAt: Date.now(), bookVersion: "1:1",
    }),
    candidatesForTicker: () => [candidate],
    dispatch: () => { dispatches += 1; },
    telemetry: () => { throw new Error("telemetry failure"); },
  });
  coordinator.onAcceptedBookUpdate("KXBTC");
  await settle();
  assert.equal(dispatches, 1);
});