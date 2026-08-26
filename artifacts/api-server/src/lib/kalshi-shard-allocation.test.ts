import assert from "node:assert/strict";
import test from "node:test";
import {
  applyVerifiedFundingSnapshot,
  hasCompleteKalshiRouteBalances,
  planKalshiRouteTransfers,
  planScalperRouteFunding,
} from "./kalshi-shard-allocation.ts";

test("production balance snapshot reserves three commodity attempts before more crypto", () => {
  const candidates = [
    ...["GOLD", "SILVER", "WTI"].map((symbol) => ({
      symbol,
      exchangeIndex: 0,
      requiredBalance: 30,
    })),
    ...["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE", "NEAR", "ZEC"].map(
      (symbol) => ({ symbol, exchangeIndex: 2, requiredBalance: 30 }),
    ),
  ];
  const funding = planScalperRouteFunding(269.62, candidates);

  assert.deepEqual(
    funding.targets,
    [
      { exchangeIndex: 0, targetAvailableBalance: 90 },
      { exchangeIndex: 2, targetAvailableBalance: 150 },
    ],
  );
  assert.equal(funding.fundedSymbols.has("GOLD"), true);
  assert.equal(funding.fundedSymbols.has("SILVER"), true);
  assert.equal(funding.fundedSymbols.has("WTI"), true);
  assert.equal(funding.fundedSymbols.size, 8);
  assert.equal(funding.blockedSymbols.size, 4);
});

test("overfunded crypto route returns enough cash to the commodity route", () => {
  const transfers = planKalshiRouteTransfers(
    269.62,
    [
      { exchangeIndex: 0, availableBalance: 20.8506 },
      { exchangeIndex: 2, availableBalance: 248.7694 },
    ],
    [
      { exchangeIndex: 0, targetAvailableBalance: 90 },
      { exchangeIndex: 2, targetAvailableBalance: 150 },
    ],
  );

  assert.deepEqual(transfers, [{
    sourceExchangeIndex: 2,
    destinationExchangeIndex: 0,
    amountCenticents: 691_494,
  }]);
});

test("second production snapshot cannot mark an unfunded commodity route ready", () => {
  const transfers = planKalshiRouteTransfers(
    254.76,
    [
      { exchangeIndex: 0, availableBalance: 22.7043 },
      { exchangeIndex: 2, availableBalance: 232.0557 },
    ],
    [
      { exchangeIndex: 0, targetAvailableBalance: 90 },
      { exchangeIndex: 2, targetAvailableBalance: 150 },
    ],
  );

  assert.equal(transfers[0]?.destinationExchangeIndex, 0);
  assert.equal(transfers[0]?.amountCenticents, 672_957);
});

test("a late or failed refresh preserves the last verified current-window permits", () => {
  const permits = new Map([["live:window:GOLD", { exchangeIndex: 0 }]]);
  applyVerifiedFundingSnapshot(
    permits,
    ["live:window:GOLD"],
    null,
  );
  assert.deepEqual(
    permits.get("live:window:GOLD"),
    { exchangeIndex: 0 },
  );
});

test("a completed verification atomically revokes permits absent from its snapshot", () => {
  const permits = new Map([
    ["live:window:GOLD", { exchangeIndex: 0 }],
    ["live:window:BTC", { exchangeIndex: 2 }],
  ]);
  applyVerifiedFundingSnapshot(
    permits,
    ["live:window:GOLD", "live:window:BTC"],
    new Map([["live:window:BTC", { exchangeIndex: 2 }]]),
  );
  assert.equal(permits.has("live:window:GOLD"), false);
  assert.equal(permits.has("live:window:BTC"), true);
});

test("incomplete balance breakdowns are not accepted as verified snapshots", () => {
  const targets = [
    { exchangeIndex: 0, targetAvailableBalance: 90 },
    { exchangeIndex: 2, targetAvailableBalance: 150 },
  ];
  assert.equal(hasCompleteKalshiRouteBalances(undefined, targets), false);
  assert.equal(hasCompleteKalshiRouteBalances([], targets), false);
  assert.equal(
    hasCompleteKalshiRouteBalances(
      [{ exchangeIndex: 2, availableBalance: 200 }],
      targets,
    ),
    false,
  );
  assert.equal(
    hasCompleteKalshiRouteBalances(
      [
        { exchangeIndex: 0, availableBalance: 50 },
        { exchangeIndex: 2, availableBalance: 200 },
      ],
      targets,
    ),
    true,
  );
});