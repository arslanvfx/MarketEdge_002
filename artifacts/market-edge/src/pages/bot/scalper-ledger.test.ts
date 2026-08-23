import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  describeEntryGuardEvidence,
  describeScalperAttempt,
  describeScalperEvidence,
  getScalperGuardBlock,
  normalizeScalpOrders,
} from "./scalper-ledger.ts";
import type { EntryGuardEvidence, ScalpOrder, ScalperAttempt } from "./types.ts";

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
    layeredRegularPositionId: null,
    layeredRegularSide: null,
    entryGuardEvidence: null,
    createdAt: "2026-08-21T19:12:00.000Z",
    settledAt: null,
    ...overrides,
  };
}

function makeEntryGuardEvidence(overrides: Partial<EntryGuardEvidence> = {}): EntryGuardEvidence {
  return {
    schemaVersion: 1,
    phase: "final_pre_submit",
    evaluatedAt: "2026-08-21T19:12:00.500Z",
    side: "no",
    directionGuardEnabled: true,
    rapidMoveGuardEnabled: true,
    targetProximityGuardEnabled: true,
    samples: [
      { at: "2026-08-21T19:11:56.123Z", price: 117_490 },
      { at: "2026-08-21T19:11:57.123Z", price: 117_495 },
      { at: "2026-08-21T19:11:58.123Z", price: 117_498 },
      { at: "2026-08-21T19:11:59.123Z", price: 117_502 },
      { at: "2026-08-21T19:12:00.123Z", price: 117_505 },
    ],
    sampleCoverageMs: 4_000,
    samplesUsed: 5,
    wrongWayResetCount: 0,
    lastWrongWayResetAt: null,
    consecutiveWrongWayMoves: 0,
    consecutiveWrongWaySeconds: 0,
    directionalMovePct: 0.013,
    freefallConsecutiveSeconds: 4,
    rapidMovePct: 0.012,
    rapidMoveThresholdPct: 0.5,
    rapidMoveLookbackSeconds: 4,
    distancePct: 0.043,
    minimumPct: 0.02,
    targetPrice: 117_500,
    underlyingPrice: 117_505,
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

  it("keeps same-side layer metadata in unified history", () => {
    const result = normalizeScalpOrders([
      order({
        layeredRegularPositionId: "regular-1",
        layeredRegularSide: "no",
      }),
    ]);
    assert.equal(result.history[0]?.signals?.layeredRegularPositionId, "regular-1");
    assert.equal(result.history[0]?.signals?.layeredRegularSide, "no");
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

  it("labels successful layers and opposite-side conflicts plainly", () => {
    assert.equal(
      describeScalperAttempt(attempt({
        status: "filled",
        layeredRegularPositionId: "regular-yes",
        layeredRegularSide: "yes",
      })),
      "Confirmed fill — layered on regular YES",
    );
    const conflict = attempt({
      reason: "opposite_regular_position",
      skipEvidence: {
        selectedSide: "no",
        regularPositionId: "regular-yes",
        regularPositionSide: "yes",
        layerDecision: "opposite_side_block",
      },
    });
    assert.equal(
      describeScalperAttempt(conflict),
      "Position-Side Guard blocked submission",
    );
    assert.match(
      describeScalperEvidence(conflict).join("\n"),
      /Scalper NO would oppose open regular YES/,
    );
  });

  it("clearly names fail-closed Freefall feed outcomes", () => {
    assert.equal(
      describeScalperAttempt(attempt({ reason: "freefall_unavailable_fetch_failed" })),
      "Real-Time Direction Guard blocked submission",
    );
    assert.equal(
      describeScalperAttempt(attempt({ reason: "freefall_unavailable_stale" })),
      "Real-Time Direction Guard blocked submission",
    );
  });

  it("classifies durable skip reasons by the exact guard that triggered", () => {
    assert.equal(
      getScalperGuardBlock(attempt({ reason: "freefall_consecutive_falling" }))?.badge,
      "DIRECTION GUARD",
    );
    assert.equal(
      getScalperGuardBlock(attempt({ reason: "freefall_adverse_falling" }))?.badge,
      "FREEFALL GUARD",
    );
    assert.equal(
      getScalperGuardBlock(attempt({ reason: "rapid_move_too_fast_rising" }))?.badge,
      "FAST-MOVE GUARD",
    );
    assert.equal(
      getScalperGuardBlock(attempt({ reason: "target_proximity_too_close" }))?.badge,
      "TARGET GUARD",
    );
    assert.equal(
      getScalperGuardBlock(attempt({ status: "filled", reason: "freefall_consecutive_falling" })),
      null,
    );
  });

  it("shows a prominent guard trigger even when detailed evidence is absent", () => {
    const lines = describeScalperEvidence(attempt({
      reason: "freefall_consecutive_rising",
      skipEvidence: null,
    }));
    assert.equal(
      lines[0],
      "GUARD TRIGGERED: Real-Time Direction Guard — Underlying rose toward the target for the configured consecutive seconds",
    );
  });

  it("renders measured target-distance and real-time direction evidence", () => {
    const lines = describeScalperEvidence(attempt({
      reason: "target_proximity_too_close",
      skipEvidence: {
        distancePct: 0.012,
        minimumPct: 0.02,
        targetPrice: 117_500,
        underlyingPrice: 117_486,
        directionalMovePct: -0.54,
        freefallConsecutiveSeconds: 4,
        consecutiveWrongWayMoves: 4,
        consecutiveWrongWaySeconds: 4,
        samplesUsed: 5,
        sampleCoverageMs: 4_000,
        protectedSide: "yes",
        secondsRemaining: 21.4,
        effectiveWindowSeconds: 45,
      },
    }));
    assert.match(lines[0] ?? "", /GUARD TRIGGERED: Target-Proximity Guard/);
    assert.match(lines.join("\n"), /Target distance 0\.012% \(0\.020% minimum\)/);
    assert.match(lines.join("\n"), /Real-time direction -0\.540% · 4\/4 wrong-way seconds/);
    assert.match(lines.join("\n"), /5 samples over 4\.0s · protected YES/);
    assert.match(lines.join("\n"), /21\.4s remained · 45s effective entry window/);
  });

  it("shows fast-move guard block measurements and threshold", () => {
    const lines = describeScalperEvidence(attempt({
      reason: "rapid_move_too_fast_falling",
      skipEvidence: {
        rapidMoveBlocked: true,
        rapidMovePct: -0.72,
        rapidMoveThresholdPct: 0.5,
        rapidMoveLookbackSeconds: 4,
      },
    }));
    assert.match(lines[0] ?? "", /GUARD TRIGGERED: Fast-Move Guard/);
    assert.match(lines.join("\n"), /Fast-move guard BLOCKED: -0\.720% over 4s \(0\.500% threshold\)/);
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

  it("renders full fast-path latency and its slowest phase", () => {
    const lines = describeScalperEvidence(attempt({
      skipEvidence: null,
      latency: {
        mode: "live",
        symbol: "BTC",
        windowKey: "2026-08-21T19:00:00.000Z",
        detectedAt: "2026-08-21T19:14:00.000Z",
        completedAt: "2026-08-21T19:14:01.284Z",
        totalMs: 1_284,
        queueWaitMs: 4,
        capClaimMs: 82,
        identityRefreshMs: 130,
        quoteRefreshMs: 410,
        parallelRefreshMs: 415,
        intentWriteMs: 24,
        brokerSubmitMs: 731,
        decisionFinalizeMs: 32,
        slowestStage: "broker_submit",
        slowestStageMs: 731,
      },
    }));
    assert.match(lines.join("\n"), /Fast path 1\.28s total · slowest broker submit 731ms/);
  });
});

describe("describeEntryGuardEvidence", () => {
  it("opens with SAFETY CHECKS PASSED mentioning final pre-submit and sample exclusion", () => {
    const lines = describeEntryGuardEvidence(makeEntryGuardEvidence());
    assert.match(
      lines[0] ?? "",
      /SAFETY CHECKS PASSED.*final pre-submit.*exclude post-fill/i,
    );
    assert.match(lines[0] ?? "", /2026-08-21T19:12:00\.500Z/);
  });

  it("renders sample prices with full dates and millisecond timestamps", () => {
    const lines = describeEntryGuardEvidence(makeEntryGuardEvidence());
    const joined = lines.join("\n");
    assert.match(joined, /\$117,490/);
    assert.match(joined, /Samples \(5\)/);
    assert.match(joined, /2026-08-21T19:11:56\.123Z/);
    assert.match(joined, /2026-08-21T19:12:00\.123Z/);
    assert.match(joined, /4\.0s coverage/);
  });

  it("renders wrong-way resets and streak duration", () => {
    const lines = describeEntryGuardEvidence(makeEntryGuardEvidence({
      wrongWayResetCount: 2,
      lastWrongWayResetAt: "2026-08-21T19:11:55.321Z",
      consecutiveWrongWaySeconds: 1.5,
      freefallConsecutiveSeconds: 4,
    }));
    const joined = lines.join("\n");
    assert.match(joined, /2 wrong-way reset/);
    assert.match(joined, /2026-08-21T19:11:55\.321Z/);
    assert.match(joined, /1\.5s consecutive wrong-way/);
    assert.match(joined, /4s threshold/);
  });

  it("labels a NO-side rise as wrong-way toward the target without calling it a block", () => {
    const lines = describeEntryGuardEvidence(makeEntryGuardEvidence({
      directionalMovePct: 0.013,
      side: "no",
    }));
    assert.match(
      lines.join("\n"),
      /Directional movement \+0\.013% — wrong-way toward target for NO entry; duration stayed below the blocking threshold — CLEAR/,
    );
  });

  it("labels a YES-side fall as wrong-way toward the target without calling it a block", () => {
    const lines = describeEntryGuardEvidence(makeEntryGuardEvidence({
      directionalMovePct: -0.021,
      side: "yes",
    }));
    assert.match(
      lines.join("\n"),
      /Directional movement -0\.021% — wrong-way toward target for YES entry; duration stayed below the blocking threshold — CLEAR/,
    );
  });

  it("labels movement away from the target as favorable for the selected side", () => {
    const lines = describeEntryGuardEvidence(makeEntryGuardEvidence({
      directionalMovePct: 0.021,
      side: "yes",
    }));
    assert.match(lines.join("\n"), /\+0\.021% — favorable away from target for YES entry/);
  });

  it("renders rapid movement and threshold", () => {
    const lines = describeEntryGuardEvidence(makeEntryGuardEvidence({
      rapidMovePct: 0.012,
      rapidMoveThresholdPct: 0.5,
      rapidMoveLookbackSeconds: 4,
    }));
    assert.match(lines.join("\n"), /Fast-move: 0\.012% over 4s \(0\.500% threshold\) — CLEAR/);
  });

  it("renders target distance, minimum, and prices", () => {
    const lines = describeEntryGuardEvidence(makeEntryGuardEvidence({
      distancePct: 0.043,
      minimumPct: 0.02,
      targetPrice: 117_500,
      underlyingPrice: 117_505,
    }));
    assert.match(lines.join("\n"), /Target distance 0\.043% \(0\.020% minimum\)/);
    assert.match(lines.join("\n"), /\$117,500/);
    assert.match(lines.join("\n"), /CLEAR/);
  });

  it("handles null values gracefully without throwing", () => {
    const ege = makeEntryGuardEvidence({
      directionalMovePct: null,
      rapidMovePct: null,
      distancePct: null,
      wrongWayResetCount: null,
      consecutiveWrongWaySeconds: null,
      consecutiveWrongWayMoves: null,
    });
    assert.doesNotThrow(() => describeEntryGuardEvidence(ege));
    const lines = describeEntryGuardEvidence(ege);
    assert.match(lines[0] ?? "", /SAFETY CHECKS PASSED/);
  });

  it("states explicitly when guards were disabled for the entry", () => {
    const lines = describeEntryGuardEvidence(makeEntryGuardEvidence({
      directionGuardEnabled: false,
      rapidMoveGuardEnabled: false,
      targetProximityGuardEnabled: false,
    }));
    assert.ok(lines.includes("Direction guard: disabled for this entry"));
    assert.ok(lines.includes("Fast-move guard: disabled for this entry"));
    assert.ok(lines.includes("Target-distance guard: disabled for this entry"));
  });
});

describe("describeScalperEvidence — entry guard evidence for filled attempts", () => {
  function attempt(overrides: Partial<ScalperAttempt>): ScalperAttempt {
    return {
      id: "attempt-filled",
      mode: "live",
      symbol: "BTC",
      windowKey: "2026-08-21T19:00:00.000Z",
      ticker: "KXBTC15M-26AUG211500-15",
      status: "filled",
      reason: null,
      reservedBudget: 5,
      createdAt: "2026-08-21T19:12:00.000Z",
      attemptedAt: "2026-08-21T19:12:00.100Z",
      ...overrides,
    };
  }

  it("shows SAFETY CHECKS PASSED block for filled attempts with evidence", () => {
    const lines = describeScalperEvidence(attempt({
      entryGuardEvidence: makeEntryGuardEvidence(),
    }));
    assert.match(lines[0] ?? "", /SAFETY CHECKS PASSED/);
  });

  it("returns empty for filled attempts with null evidence (old orders stay safe)", () => {
    const lines = describeScalperEvidence(attempt({
      entryGuardEvidence: null,
    }));
    assert.equal(lines.length, 0);
  });

  it("still appends fast-path latency after safety checks passed block", () => {
    const lines = describeScalperEvidence(attempt({
      entryGuardEvidence: makeEntryGuardEvidence(),
      latency: {
        mode: "live",
        symbol: "BTC",
        windowKey: "2026-08-21T19:00:00.000Z",
        detectedAt: "2026-08-21T19:12:00.000Z",
        completedAt: "2026-08-21T19:12:00.842Z",
        totalMs: 842,
        queueWaitMs: 3,
        capClaimMs: 60,
        identityRefreshMs: 100,
        quoteRefreshMs: 350,
        parallelRefreshMs: 355,
        intentWriteMs: 20,
        brokerSubmitMs: 404,
        decisionFinalizeMs: 28,
        slowestStage: "broker_submit",
        slowestStageMs: 404,
      },
    }));
    assert.match(lines.join("\n"), /SAFETY CHECKS PASSED/);
    assert.match(lines.join("\n"), /Fast path 842ms total · slowest broker submit 404ms/);
  });
});

describe("normalizeScalpOrders — entryGuardEvidence preserved in signals", () => {
  it("copies entryGuardEvidence into history signals", () => {
    const ege = makeEntryGuardEvidence();
    const result = normalizeScalpOrders([order({ entryGuardEvidence: ege })]);
    const sigs = result.history[0]?.signals as Record<string, unknown> | null;
    assert.deepEqual(sigs?.entryGuardEvidence, ege);
  });

  it("stores null when entryGuardEvidence is absent on older orders", () => {
    const result = normalizeScalpOrders([order({ entryGuardEvidence: null })]);
    const sigs = result.history[0]?.signals as Record<string, unknown> | null;
    assert.equal(sigs?.entryGuardEvidence, null);
  });
});