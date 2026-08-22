import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { describeScalperAttempt, describeScalperEvidence, normalizeScalpOrders } from "./scalper-ledger.ts";
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
      "Final authenticated quote moved outside the permitted band",
    );
    assert.equal(
      describeScalperAttempt(attempt({ status: "zero_fill", reason: "zero_fill" })),
      "IOC returned zero fills",
    );
  });

  it("uses readable explanations for authenticated quote and identity skips", () => {
    assert.equal(
      describeScalperAttempt(attempt({ reason: "final_quote_invalid" })),
      "Authenticated final quote was unavailable or invalid",
    );
    assert.equal(
      describeScalperAttempt(attempt({ reason: "identity_outside_window" })),
      "Refreshed market identity was outside the entry window",
    );
  });

  it("clearly names fail-closed Freefall feed outcomes", () => {
    assert.equal(
      describeScalperAttempt(attempt({ reason: "freefall_unavailable_fetch_failed" })),
      "Fresh underlying price fetch failed — Freefall blocked submission",
    );
    assert.equal(
      describeScalperAttempt(attempt({ reason: "freefall_unavailable_stale" })),
      "Freefall samples were stale",
    );
  });

  it("renders measured target-distance and Freefall evidence", () => {
    const lines = describeScalperEvidence(attempt({
      reason: "target_proximity_too_close",
      skipEvidence: {
        distancePct: 0.012,
        minimumPct: 0.02,
        targetPrice: 117_500,
        underlyingPrice: 117_486,
        adverseMovePct: 0.54,
        freefallThresholdPct: 0.5,
        samplesUsed: 24,
        sampleCoverageMs: 28_100,
        protectedSide: "yes",
        secondsRemaining: 21.4,
        effectiveWindowSeconds: 45,
      },
    }));
    assert.match(lines.join("\n"), /Target distance 0\.012% \(0\.020% minimum\)/);
    assert.match(lines.join("\n"), /Adverse move 0\.540% \(0\.500% threshold\)/);
    assert.match(lines.join("\n"), /24 samples over 28\.1s · protected YES/);
    assert.match(lines.join("\n"), /21\.4s remained · 45s effective entry window/);
  });

  it("renders authenticated quote and refresh-latency evidence", () => {
    const lines = describeScalperEvidence(attempt({
      reason: "final_quote_outside_band",
      skipEvidence: {
        quoteYesAsk: 0.947,
        quoteNoAsk: 0.061,
        bandMin: 0.96,
        bandMax: 0.99,
        identityRefreshMs: 84,
        quoteRefreshMs: 132,
        parallelRefreshMs: 140,
      },
    }));
    assert.match(lines.join("\n"), /Authenticated final quote YES 94\.7¢ \/ NO 6\.1¢/);
    assert.match(lines.join("\n"), /identity 84ms · quote 132ms · parallel total 140ms/);
  });
});