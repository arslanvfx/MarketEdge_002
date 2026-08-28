import assert from "node:assert/strict";
import test from "node:test";
import { buildKalshi15mTicker } from "./kalshi-15m-ticker.ts";

test("Kalshi 15-minute ticker uses EDT during summer", () => {
  assert.equal(
    buildKalshi15mTicker("btc", "2026-08-28T17:45"),
    "KXBTC15M-26AUG281400-00",
  );
});

test("Kalshi 15-minute ticker uses EST during winter", () => {
  assert.equal(
    buildKalshi15mTicker("BTC", "2026-01-15T17:45"),
    "KXBTC15M-26JAN151300-00",
  );
});

test("Kalshi 15-minute ticker follows New York across the spring DST boundary", () => {
  assert.equal(
    buildKalshi15mTicker("ETH", "2026-03-08T06:45"),
    "KXETH15M-26MAR080300-00",
  );
});

test("Kalshi 15-minute ticker rejects invalid input", () => {
  assert.equal(buildKalshi15mTicker("", "2026-08-28T17:45"), null);
  assert.equal(buildKalshi15mTicker("BTC", "not-a-window"), null);
});