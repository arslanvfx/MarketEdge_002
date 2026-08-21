import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { describeScalperAttempt, normalizeScalpOrders } from "./scalper-ledger.ts";
import type { ScalpOrder, ScalperAttempt } from "./types.ts";

function order(overrides: Partial<ScalpOrder> = {}): ScalpOrder {
  return {
    id: "order-1",
    mode: "live",
    symbol: "XRP",
    windowKey: "2026-08-21T19:00:00.000Z",
    ticker: "KXXRP15M-26AUG211500-15",
    side: "no",
    entryYesPrice: 0.08,
    contractCount: 3,
    budgetSpent: 2.76,
    orderId: "exchange-1",
    filledCount: 3,
    avgFillPrice: 0.08,
    limitPrice: 0.08,
    status: "filled",
    error: null,
    settlementResult: null,
    outcome: "open",
    pnl: null,
    incidentId: null,
    createdAt: "2026-08-21T19:12:00.000Z",
    settledAt: null,
    ...overrides,
  };
}

describe("normalizeScalpOrders", () => {
  it("maps confirmed fills into shared positions and history", () => {
    const result = normalizeScalpOrders([order()]);
    assert.equal(result.positions.length, 1);
    assert.equal(result.history.length, 1);
    assert.equal(result.positions[0]?.source, "scalper");
    assert.equal(result.positions[0]?.contractCount, 3);
    assert.equal(result.history[0]?.source, "scalper");
    assert.equal(result.history[0]?.action, "bet");
  });

  it("excludes zero-fill, skipped, error, and unknown attempts", () => {
    const rejected = [
      order({ id: "zero", status: "zero_fill", filledCount: 0, avgFillPrice: null }),
      order({ id: "skip", status: "skipped" }),
      order({ id: "error", status: "error" }),
      order({ id: "unknown", status: "unknown" }),
    ];
    assert.deepEqual(normalizeScalpOrders(rejected), { positions: [], history: [] });
  });

  it("filters by mode without leaking Paper orders into Live history", () => {
    const result = normalizeScalpOrders([
      order({ id: "live", mode: "live" }),
      order({ id: "paper", mode: "paper", status: "paper" }),
    ], "live");
    assert.deepEqual(result.history.map((record) => record.id), ["scalper:live"]);
  });

  it("replaces an open duplicate with its settled row", () => {
    const settled = order({
      outcome: "win",
      settlementResult: "no",
      pnl: 0.24,
      settledAt: "2026-08-21T19:15:30.000Z",
    });
    const result = normalizeScalpOrders([order(), settled]);
    assert.equal(result.positions.length, 0);
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0]?.outcome, "win");
    assert.equal(result.history[0]?.pnl, "0.24");
  });
});

describe("describeScalperAttempt", () => {
  function attempt(overrides: Partial<ScalperAttempt>): ScalperAttempt {
    return {
      id: "attempt-1",
      mode: "live",
      symbol: "BTC",
      windowKey: "2026-08-21T19:00:00.000Z",
      ticker: "KXBTC15M-26AUG211500-15",
      status: "skipped",
      reason: null,
      reservedBudget: 0,
      createdAt: "2026-08-21T19:11:00.000Z",
      attemptedAt: "2026-08-21T19:12:00.000Z",
      ...overrides,
    };
  }

  it("distinguishes final quote movement from zero fills", () => {
    assert.equal(
      describeScalperAttempt(attempt({ reason: "second_quote_outside_band" })),
      "Final authenticated quote moved outside the band",
    );
    assert.equal(
      describeScalperAttempt(attempt({ status: "zero_fill", reason: "zero_fill" })),
      "IOC returned zero fills",
    );
  });
});