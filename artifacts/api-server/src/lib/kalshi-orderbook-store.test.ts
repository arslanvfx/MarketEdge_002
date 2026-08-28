import assert from "node:assert/strict";
import { test } from "node:test";
import { KalshiOrderbookStore } from "./kalshi-orderbook-store.ts";

const snapshot = (seq = 10, ticker = "KXTEST") => ({
  type: "orderbook_snapshot", sid: 7, seq,
  msg: {
    market_ticker: ticker,
    // Deliberately ascending, as supplied by Kalshi.
    yes_dollars_fp: [["0.10", "2"], ["0.20", "3"]],
    no_dollars_fp: [["0.15", "1"], ["0.18", "3"]],
  },
});
const delta = (seq: number, side: "yes" | "no", price: string, change: string, ticker = "KXTEST") => ({
  type: "orderbook_delta", sid: 7, seq,
  msg: { market_ticker: ticker, side, price_dollars: price, delta_fp: change },
});

test("Kalshi book applies snapshots and complementary executable depth", () => {
  const store = new KalshiOrderbookStore();
  assert.equal(store.apply(snapshot(), 1_000), true);
  // YES consumes NO bids: 1-.18=.82 before 1-.15=.85.
  assert.deepEqual(store.getExecutable("KXTEST", "yes", 2, .79, .85, 1_001), {
    ticker: "KXTEST", side: "yes", sideCost: .82, marginalLimitCost: .82, visibleContracts: 2,
    seq: 10, updatedAt: 1_000, bookVersion: "7:10",
  });
  // NO consumes YES bids: 1-.20=.80.
  assert.deepEqual(store.getExecutable("KXTEST", "no", 2, .79, .85, 1_001), {
    ticker: "KXTEST", side: "no", sideCost: .8, marginalLimitCost: .8, visibleContracts: 2,
    seq: 10, updatedAt: 1_000, bookVersion: "7:10",
  });
});

test("Kalshi book handles positive/negative deltas and zero deletion", () => {
  const store = new KalshiOrderbookStore();
  store.apply(snapshot(), 1_000);
  assert.equal(store.apply(delta(11, "no", ".18", "-3"), 1_001), true);
  assert.equal(store.getExecutable("KXTEST", "yes", 2, .79, .85, 1_002)?.visibleContracts, 1);
  assert.equal(store.apply(delta(12, "no", ".18", "2"), 1_002), true);
  assert.equal(store.getExecutable("KXTEST", "yes", 2, .79, .85, 1_003)?.visibleContracts, 2);
});

test("Kalshi book fails closed on sequence gaps, malformed events, and staleness", () => {
  const store = new KalshiOrderbookStore(100);
  store.apply(snapshot(), 1_000);
  assert.equal(store.apply(delta(12, "no", ".18", "1"), 1_001), false);
  assert.equal(store.getExecutable("KXTEST", "yes", 1, .79, .85, 1_002), null);
  assert.equal(store.apply(snapshot(20), 1_003), true);
  assert.equal(store.apply({ type: "orderbook_delta", sid: 7, seq: 21, msg: { market_ticker: "KXTEST" } }, 1_004), false);
  assert.equal(store.getExecutable("KXTEST", "yes", 1, .79, .85, 1_005), null);
  assert.equal(store.apply(snapshot(30), 1_010), true);
  assert.equal(store.isFresh("KXTEST", 1_111), false);
});

test("Kalshi sid sequence permits interleaved tickers and gaps poison the whole sid", () => {
  const store = new KalshiOrderbookStore();
  assert.equal(store.apply(snapshot(10, "KXBTC"), 1_000), true);
  assert.equal(store.apply(snapshot(11, "KXSOL"), 1_001), true);
  assert.equal(store.apply(delta(12, "no", ".18", "1", "KXBTC"), 1_002), true);
  assert.equal(store.apply(delta(13, "yes", ".20", "1", "KXSOL"), 1_003), true);
  assert.notEqual(store.getExecutable("KXBTC", "yes", 1, .79, .85, 1_004), null);
  assert.notEqual(store.getExecutable("KXSOL", "no", 1, .79, .85, 1_004), null);

  // seq=15 skips the global sid seq=14; both BTC and SOL must fail closed.
  assert.equal(store.apply(delta(15, "no", ".18", "1", "KXBTC"), 1_005), false);
  assert.equal(store.getExecutable("KXBTC", "yes", 1, .79, .85, 1_006), null);
  assert.equal(store.getExecutable("KXSOL", "no", 1, .79, .85, 1_006), null);
});

test("Kalshi snapshots accept omitted empty sides", () => {
  const store = new KalshiOrderbookStore();
  const emptySide = snapshot(10);
  delete (emptySide.msg as { yes_dollars_fp?: unknown }).yes_dollars_fp;
  assert.equal(store.apply(emptySide, 1_000), true);
});

test("Kalshi count_fp arithmetic is exact at hundredth-contract precision", () => {
  const store = new KalshiOrderbookStore();
  assert.equal(store.apply({
    type: "orderbook_snapshot", sid: 9, seq: 1,
    msg: { market_ticker: "KXCOUNT", yes_dollars_fp: [], no_dollars_fp: [["0.18", "0.10"]] },
  }, 1_000), true);
  assert.equal(store.apply({
    type: "orderbook_delta", sid: 9, seq: 2,
    msg: { market_ticker: "KXCOUNT", side: "no", price_dollars: "0.18", delta_fp: "0.20" },
  }, 1_001), true);
  assert.equal(store.apply({
    type: "orderbook_delta", sid: 9, seq: 3,
    msg: { market_ticker: "KXCOUNT", side: "no", price_dollars: "0.18", delta_fp: "-0.30" },
  }, 1_002), true);
  assert.equal(store.getExecutable("KXCOUNT", "yes", 1, .79, .85, 1_003), null);
  assert.equal(store.isFresh("KXCOUNT", 1_003), true);
});

test("Kalshi executable depth floors fractional contracts and rejects malformed precision", () => {
  const store = new KalshiOrderbookStore();
  assert.equal(store.apply({
    type: "orderbook_snapshot", sid: 10, seq: 1,
    msg: {
      market_ticker: "KXFRACTION",
      yes_dollars_fp: [],
      no_dollars_fp: [["0.18", "0.99"], ["0.16", "1.00"]],
    },
  }, 1_000), true);
  const executable = store.getExecutable("KXFRACTION", "yes", 2, .79, .85, 1_001);
  assert.equal(executable?.visibleContracts, 1);
  // The exactly one executable contract consumes .99 at .82 then .01 at .84.
  assert.equal(executable?.sideCost, .8202);
  assert.equal(store.apply({
    type: "orderbook_delta", sid: 10, seq: 2,
    msg: { market_ticker: "KXFRACTION", side: "no", price_dollars: "0.18", delta_fp: "0.001" },
  }, 1_002), false);
  assert.equal(store.getExecutable("KXFRACTION", "yes", 1, .79, .85, 1_003), null);
});

test("Kalshi book accepts omitted empty sides without inventing executable depth", () => {
  const store = new KalshiOrderbookStore();
  assert.equal(store.apply({
    type: "orderbook_snapshot",
    sid: 8,
    seq: 1,
    msg: {
      market_ticker: "KXEMPTY",
      yes_dollars_fp: [["0.20", "3"]],
    },
  }, 2_000), true);
  assert.equal(store.isFresh("KXEMPTY", 2_001), true);
  assert.equal(store.getExecutable("KXEMPTY", "yes", 2, .79, .85, 2_001), null);
  assert.equal(store.getExecutable("KXEMPTY", "no", 2, .79, .85, 2_001)?.visibleContracts, 2);
});

test("Kalshi executable sell reads direct bids highest first at exact depth", () => {
  const store = new KalshiOrderbookStore();
  assert.equal(store.apply({
    type: "orderbook_snapshot", sid: 11, seq: 1,
    msg: {
      market_ticker: "KXSELL",
      yes_dollars_fp: [["0.31", "0.99"], ["0.30", "1.01"]],
      no_dollars_fp: [["0.49", "0.75"], ["0.41", "1.25"]],
    },
  }, 1_000), true);
  assert.deepEqual(store.getExecutableSell("KXSELL", "yes", 2, 1_001), {
    ticker: "KXSELL", side: "yes", sideProceeds: 0.30495, marginalLimitProceeds: 0.30,
    visibleContracts: 2, seq: 1, updatedAt: 1_000, bookVersion: "11:1",
  });
  assert.deepEqual(store.getExecutableSell("KXSELL", "no", 2, 1_001), {
    ticker: "KXSELL", side: "no", sideProceeds: 0.44, marginalLimitProceeds: 0.41,
    visibleContracts: 2, seq: 1, updatedAt: 1_000, bookVersion: "11:1",
  });
  assert.equal(store.getExecutableSell("KXSELL", "yes", 2, 7_000), null);
  store.invalidate("KXSELL");
  assert.equal(store.getExecutableSell("KXSELL", "no", 1, 1_002), null);
});

test("Kalshi entry quote retains weighted cost and marginal depth cost for both sides", () => {
  const store = new KalshiOrderbookStore();
  assert.equal(store.apply({
    type: "orderbook_snapshot", sid: 12, seq: 1,
    msg: {
      market_ticker: "KXENTRY",
      // YES consumes NO: costs .80 for .75 then .84 for 1.25.
      no_dollars_fp: [["0.20", "0.75"], ["0.16", "1.25"]],
      // NO consumes YES: costs .79 for .50 then .83 for 1.50.
      yes_dollars_fp: [["0.17", "1.50"], ["0.21", "0.50"]],
    },
  }, 1_000), true);
  const yes = store.getExecutable("KXENTRY", "yes", 2, .79, .85, 1_001);
  assert.equal(yes?.visibleContracts, 2);
  assert.equal(yes?.sideCost, .825);
  assert.equal(yes?.marginalLimitCost, .84);
  const no = store.getExecutable("KXENTRY", "no", 2, .79, .85, 1_001);
  assert.equal(no?.visibleContracts, 2);
  assert.equal(no?.sideCost, .82);
  assert.equal(no?.marginalLimitCost, .83);
});