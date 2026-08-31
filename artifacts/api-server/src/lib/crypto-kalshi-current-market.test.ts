import assert from "node:assert/strict";
import test from "node:test";

import {
  parseKalshiFloorStrike,
  selectKalshiMarket,
} from "./crypto-kalshi-market-selection.ts";

test("selects the current close-time market even when its target is TBD", () => {
  const currentClose = new Date("2026-08-31T18:30:00.000Z");
  const markets = [
    {
      ticker: "KXBTC15M-CURRENT",
      close_time: currentClose.toISOString(),
      yes_ask_dollars: "0.8500",
    },
    {
      ticker: "KXBTC15M-EXPIRED",
      close_time: "2026-08-31T18:15:00.000Z",
      floor_strike: "78900.92",
    },
  ];

  const selected = selectKalshiMarket(markets, currentClose);

  assert.equal(selected?.ticker, "KXBTC15M-CURRENT");
  assert.equal(parseKalshiFloorStrike(selected?.floor_strike), null);
  assert.equal(parseKalshiFloorStrike(markets[1].floor_strike), 78900.92);
});

test("returns no market when every close time is outside the current window", () => {
  const selected = selectKalshiMarket(
    [
      {
        ticker: "KXBTC15M-EXPIRED",
        close_time: "2026-08-31T18:15:00.000Z",
        floor_strike: "78900.92",
      },
    ],
    new Date("2026-08-31T18:45:00.000Z"),
  );

  assert.equal(selected, undefined);
});