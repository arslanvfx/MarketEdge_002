import assert from "node:assert/strict";
import test from "node:test";
import { quoteAuthenticatedBookExecution } from "./kalshi-bot-authenticated-book-gateway.ts";

const executable = (
  side: "yes" | "no",
  version = "7:9",
  visibleContracts = 3,
  marginalLimitCost = .823,
  bestExecutableCost = .8,
) => ({
  ticker: "KXBTC",
  side,
  sideCost: .8,
  marginalLimitCost,
  bestExecutableCost,
  visibleContracts,
  seq: 9,
  updatedAt: Date.now(),
  bookVersion: version,
});

test("authenticated Bot 1 gateway uses a conservative YES limit and revalidates current safety", () => {
  let current = executable("yes");
  const gateway = quoteAuthenticatedBookExecution(
    { ticker: "KXBTC", side: "yes", requestedCount: 3, sideCostFloor: .79, sideCostCeiling: .87 },
    { isFresh: () => true, getExecutable: () => current },
  );
  assert.ok(gateway);
  assert.equal(gateway.limitPrice, .83);
  assert.equal(gateway.worstCaseCost, 2.49);
  assert.equal(gateway.revalidate(), true);
  current = executable("yes", "7:10");
  assert.equal(gateway.revalidate(), true, "a safe book update must not cancel an urgent IOC");
});

test("authenticated Bot 1 gateway converts a NO side ceiling to Kalshi YES price", () => {
  const gateway = quoteAuthenticatedBookExecution(
    { ticker: "KXBTC", side: "no", requestedCount: 2, sideCostFloor: .79, sideCostCeiling: .87 },
    { isFresh: () => true, getExecutable: () => executable("no", "1:1", 2, .823) },
  );
  assert.ok(gateway);
  assert.equal(gateway.limitPrice, .17);
  assert.equal(gateway.worstCaseCost, 1.66);
});

test("authenticated Bot 1 gateway permits IOC partial fills when at least one contract is visible", () => {
  const gateway = quoteAuthenticatedBookExecution(
    { ticker: "KXBTC", side: "yes", requestedCount: 3, sideCostFloor: .79, sideCostCeiling: .87 },
    { isFresh: () => true, getExecutable: () => executable("yes", "1:1", 2) },
  );
  assert.ok(gateway);
  assert.equal(gateway.requestedCount, 2);
  assert.equal(gateway.worstCaseCost, 1.66);
});

test("authenticated Bot 1 gateway passes the approved side-cost zone to every book read", () => {
  const calls: Array<[number, number]> = [];
  const gateway = quoteAuthenticatedBookExecution(
    { ticker: "KXBTC", side: "yes", requestedCount: 2, sideCostFloor: .81, sideCostCeiling: .86 },
    {
      isFresh: () => true,
      getExecutable: (_ticker, _side, _count, floor, ceiling) => {
        calls.push([floor, ceiling]);
        return executable("yes", "3:4", 2, .85, .82);
      },
    },
  );
  assert.ok(gateway);
  assert.equal(gateway.revalidate(), true);
  assert.deepEqual(calls, [[0, .86], [0, .85]]);
});

test("authenticated Bot 1 gateway rejects favorable levels below the strict entry floor", () => {
  const gateway = quoteAuthenticatedBookExecution(
    { ticker: "KXBTC", side: "no", requestedCount: 2, sideCostFloor: .79, sideCostCeiling: .85 },
    {
      isFresh: () => true,
      getExecutable: () => executable("no", "5:6", 2, .84, .71),
    },
  );
  assert.equal(gateway, null);
});

test("authenticated Bot 1 gateway revalidation rejects a new below-floor level", () => {
  let current = executable("yes", "8:9", 2, .84, .80);
  const gateway = quoteAuthenticatedBookExecution(
    { ticker: "KXBTC", side: "yes", requestedCount: 2, sideCostFloor: .79, sideCostCeiling: .85 },
    { isFresh: () => true, getExecutable: () => current },
  );
  assert.ok(gateway);
  current = executable("yes", "8:9", 2, .84, .70);
  assert.equal(gateway.revalidate(), false);
});

test("authenticated Bot 1 gateway revalidation rejects a move above the fixed IOC limit", () => {
  let current = executable("yes", "9:10", 2, .82, .80);
  const gateway = quoteAuthenticatedBookExecution(
    { ticker: "KXBTC", side: "yes", requestedCount: 2, sideCostFloor: .79, sideCostCeiling: .87 },
    {
      isFresh: () => true,
      getExecutable: (_ticker, _side, _count, _floor, ceiling) =>
        current.marginalLimitCost <= ceiling ? current : null,
    },
  );
  assert.ok(gateway);
  current = executable("yes", "9:11", 2, .83, .80);
  assert.equal(gateway.revalidate(), false);
});