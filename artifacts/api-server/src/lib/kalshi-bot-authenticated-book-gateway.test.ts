import assert from "node:assert/strict";
import test from "node:test";
import { quoteAuthenticatedBookExecution } from "./kalshi-bot-authenticated-book-gateway.ts";

const executable = (side: "yes" | "no", version = "7:9", visibleContracts = 3, marginalLimitCost = .823) =>
  ({ ticker: "KXBTC", side, sideCost: .8, marginalLimitCost, visibleContracts, seq: 9, updatedAt: Date.now(), bookVersion: version });

test("authenticated Bot 1 gateway uses requested exact depth and conservative YES limit", () => {
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
  assert.equal(gateway.revalidate(), false, "a changed book version invalidates the immutable quote");
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

test("authenticated Bot 1 gateway fails closed without full requested depth", () => {
  const gateway = quoteAuthenticatedBookExecution(
    { ticker: "KXBTC", side: "yes", requestedCount: 3, sideCostFloor: .79, sideCostCeiling: .87 },
    { isFresh: () => true, getExecutable: () => executable("yes", "1:1", 2) },
  );
  assert.equal(gateway, null);
});

test("authenticated Bot 1 gateway passes the approved side-cost zone to every book read", () => {
  const calls: Array<[number, number]> = [];
  const gateway = quoteAuthenticatedBookExecution(
    { ticker: "KXBTC", side: "yes", requestedCount: 2, sideCostFloor: .81, sideCostCeiling: .86 },
    {
      isFresh: () => true,
      getExecutable: (_ticker, _side, _count, floor, ceiling) => {
        calls.push([floor, ceiling]);
        return executable("yes", "3:4", 2, .85);
      },
    },
  );
  assert.ok(gateway);
  assert.equal(gateway.revalidate(), true);
  assert.deepEqual(calls, [[.81, .86], [.81, .86]]);
});