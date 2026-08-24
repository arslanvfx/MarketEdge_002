import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ContrarianExposureRegistry,
  DEFAULT_CONTRARIAN_CONFIG,
  buildContrarianGuardOutcomeHypothesis,
  buildContrarianGuardOutcomeStudyPayload,
  computeContrarianFillSpend,
  computeContrarianPnl,
  evaluateContrarianGuardEligibility,
  parseContrarianConfigPatch,
  planContrarianOrder,
  replayContrarianGuardOutcomeRows,
  validateContrarianConfig,
} from "./kalshi-scalper-contrarian.ts";
import type { FreefallPreSubmitDecision } from "./kalshi-scalper-policy.ts";

function decision(overrides: Record<string, unknown> = {}): FreefallPreSubmitDecision {
  return {
    allowed: false,
    reason: "freefall_consecutive_falling",
    sampleCoverageMs: 4_000,
    guardResult: {
      evaluable: true, blocked: true, reason: "freefall_consecutive_falling",
      directionalBlocked: true, wrongTargetSide: false, rapidMoveBlocked: false,
      targetPrice: 100, latestPrice: 101, projectedPrice: 99,
      adverseMovePct: 1, endpointAdverseMovePct: 1, reversalAdverseMovePct: 0,
      samplesUsed: 5, requiredSamples: 5, consecutiveWrongWayMoves: 4,
      consecutiveWrongWaySeconds: 4, requiredConsecutiveMoves: 4,
      observedSpanMs: 4_000, directionalMovePct: -1,
      favorableTrendConfirmed: false, favorableTrendBlocked: true,
      favorableTrendReason: "adverse", coordinatedDirectionClearanceApplied: false,
      coordinatedDirectionClearanceSafe: null, coordinatedDirectionClearanceReason: null,
      adversePacePctPerSecond: 0.25, projectedAdverseMovePct: 0.5,
      projectedDistancePct: -1, secondsRemaining: 2,
      targetSideWindowConfirmed: true, targetSideViolationPrice: null,
      targetSideViolationAt: null, rapidMovePct: 0, evaluatedSamples: [],
      wrongWayResetCount: 0, lastWrongWayResetAt: null,
      ...overrides,
    },
  };
}

describe("contrarian spike experiment pure boundary", () => {
  it("defaults off, paper, and tiny independent limits", () => {
    assert.deepEqual(DEFAULT_CONTRARIAN_CONFIG, {
      enabled: false, mode: "paper", budgetDollars: 0.25, dailyCapDollars: 1,
      openCapDollars: 0.5, perWindowCapDollars: 0.25,
      maxDirectContractCost: 0.05, circuitBreakerEnabled: true,
      circuitBreaker: false, circuitBreakerReason: null,
    });
  });

  it("allows only a directional final block with a projected/current crossing", () => {
    const result = evaluateContrarianGuardEligibility(decision(), "yes");
    assert.equal(result.eligible, true);
    if (result.eligible) assert.equal(result.oppositeSide, "no");
    assert.equal(evaluateContrarianGuardEligibility(decision({ projectedPrice: 100.01 }), "yes").eligible, false);
    assert.equal(evaluateContrarianGuardEligibility(decision({ directionalBlocked: false, rapidMoveBlocked: true }), "yes").eligible, false);
    assert.equal(evaluateContrarianGuardEligibility({ ...decision(), allowed: true }, "yes").eligible, false);
  });

  it("permits only the exact existing coordinated projected-crossing reason", () => {
    const coordinated = decision({
      directionalBlocked: false,
      favorableTrendBlocked: true,
      reason: "coordinated_direction_clearance_projected_too_close_yes",
      coordinatedDirectionClearanceReason: "coordinated_direction_clearance_projected_too_close_yes",
      projectedPrice: 99,
    });
    assert.equal(evaluateContrarianGuardEligibility(coordinated, "yes").eligible, true);
    assert.equal(evaluateContrarianGuardEligibility(decision({
      directionalBlocked: false, favorableTrendBlocked: true,
      favorableTrendReason: "favorable_trend_not_confirmed",
      projectedPrice: 99,
    }), "yes").eligible, false);
  });

  it("strictly parses config and never permits breaker latch patching", () => {
    assert.equal(parseContrarianConfigPatch({ enabled: true, mode: "live" }).ok, true);
    assert.equal(parseContrarianConfigPatch({ budgetDollars: "0.25" }).ok, false);
    assert.equal(parseContrarianConfigPatch({ circuitBreaker: false }).ok, false);
    assert.equal(parseContrarianConfigPatch({ circuitBreakerEnabled: false }).ok, false);
    assert.equal(parseContrarianConfigPatch({ maxDirectContractCost: 1 }).ok, false);
  });

  it("keeps the experiment breaker mandatory and enforces related cap ordering", () => {
    assert.ok(validateContrarianConfig({
      ...DEFAULT_CONTRARIAN_CONFIG,
      circuitBreakerEnabled: false,
    }).includes("the experiment circuit breaker must remain enabled"));
    assert.ok(validateContrarianConfig({
      ...DEFAULT_CONTRARIAN_CONFIG,
      budgetDollars: 0.5,
      perWindowCapDollars: 0.25,
    }).includes("budgetDollars cannot exceed perWindowCapDollars"));
  });

  it("sizes from the worst-case IOC limit instead of the cheaper observed ask", () => {
    const plan = planContrarianOrder({
      budgetDollars: 0.25,
      maxDirectContractCost: 0.05,
      directAsk: 0.02,
      oppositeSide: "no",
    });
    assert.deepEqual(plan, {
      ok: true,
      contractCount: 5,
      yesLimitPrice: 0.95,
      maxExposure: 0.25,
      hypotheticalAvgYesPrice: 0.98,
    });
    assert.equal(planContrarianOrder({
      budgetDollars: 0.04,
      maxDirectContractCost: 0.05,
      directAsk: 0.02,
      oppositeSide: "yes",
    }).ok, false);
  });

  it("derives confirmed fill spend from side-aware YES-price economics", () => {
    assert.equal(computeContrarianFillSpend("yes", 10, 0.04), 0.4);
    assert.ok(Math.abs((computeContrarianFillSpend("no", 10, 0.96) ?? 0) - 0.4) < 1e-9);
    assert.equal(computeContrarianFillSpend("no", 0, 0.96), null);
    assert.equal(computeContrarianFillSpend("yes", 1, 1), null);
  });

  it("settles YES and NO fills with direct contract economics", () => {
    assert.equal(computeContrarianPnl({
      side: "yes", count: 5, avgYesPrice: 0.04, result: "yes",
    }), 4.8);
    assert.ok(Math.abs(computeContrarianPnl({
      side: "no", count: 5, avgYesPrice: 0.96, result: "no",
    }) - 4.8) < 1e-9);
    assert.ok(Math.abs(computeContrarianPnl({
      side: "no", count: 5, avgYesPrice: 0.96, result: "yes",
    }) + 0.2) < 1e-9);
  });

  it("prices guard outcome hypotheses only from a valid recorded opposite ask", () => {
    assert.deepEqual(buildContrarianGuardOutcomeHypothesis({
      oppositeSide: "no",
      yesAsk: 0.97,
      noAsk: 0.04,
      budgetDollars: 2,
    }), {
      yesAsk: 0.97,
      noAsk: 0.04,
      oppositeAsk: 0.04,
      quoteSupported: true,
      hypotheticalContracts: 50,
      hypotheticalBudget: 2,
      hypotheticalAvgYesPrice: 0.96,
    });
    assert.deepEqual(buildContrarianGuardOutcomeHypothesis({
      oppositeSide: "no",
      yesAsk: 0.97,
      noAsk: null,
      budgetDollars: 2,
    }), {
      yesAsk: 0.97,
      noAsk: null,
      oppositeAsk: null,
      quoteSupported: false,
      hypotheticalContracts: 0,
      hypotheticalBudget: 0,
      hypotheticalAvgYesPrice: null,
    });
  });

  it("builds a JSON-safe prospective outbox payload from the strict guard allowlist", () => {
    const payload = buildContrarianGuardOutcomeStudyPayload({
      sourceMode: "live",
      symbol: "btc",
      windowKey: "2026-08-24T08:00",
      ticker: "KXBTC15M-26AUG240415-15",
      closeTime: "2026-08-24T08:15:00.000Z",
      protectedSide: "yes",
      decision: decision(),
      yesAsk: 0.97,
      noAsk: 0.04,
      budgetDollars: 2,
      observedAtMs: Date.parse("2026-08-24T08:14:58.000Z"),
      evidence: { phase: "initial_final_guard" },
    });
    assert.ok(payload);
    assert.deepEqual({
      version: payload.version,
      mode: payload.mode,
      symbol: payload.symbol,
      oppositeSide: payload.oppositeSide,
      quoteSupported: payload.quoteSupported,
      hypotheticalContracts: payload.hypotheticalContracts,
      observedAt: payload.observedAt,
      phase: payload.evidence.phase,
    }, {
      version: 1,
      mode: "live",
      symbol: "BTC",
      oppositeSide: "no",
      quoteSupported: true,
      hypotheticalContracts: 50,
      observedAt: "2026-08-24T08:14:58.000Z",
      phase: "initial_final_guard",
    });
    assert.equal(
      buildContrarianGuardOutcomeStudyPayload({
        sourceMode: "live",
        symbol: "BTC",
        windowKey: "w",
        ticker: "t",
        closeTime: "2026-08-24T08:15:00.000Z",
        protectedSide: "yes",
        decision: decision({ projectedPrice: 100.01 }),
        yesAsk: 0.97,
        noAsk: 0.04,
        budgetDollars: 2,
      }),
      null,
    );
  });

  it("replays a durable outbox row after transient failure and treats a race as deduplicated", async () => {
    const payload = buildContrarianGuardOutcomeStudyPayload({
      sourceMode: "paper",
      symbol: "ETH",
      windowKey: "2026-08-24T08:00",
      ticker: "KXETH15M-26AUG240415-15",
      closeTime: "2026-08-24T08:15:00.000Z",
      protectedSide: "yes",
      decision: decision(),
      yesAsk: 0.97,
      noAsk: 0.04,
      budgetDollars: 2,
      observedAtMs: Date.parse("2026-08-24T08:14:58.000Z"),
    });
    assert.ok(payload);
    const getPending = async () => [{
      mode: payload.mode,
      symbol: payload.symbol,
      windowKey: payload.windowKey,
      payload,
    }];
    const rows = await getPending();
    const failed = await replayContrarianGuardOutcomeRows(
      rows,
      async () => {
        throw new Error("temporary database outage");
      },
    );
    assert.deepEqual(failed, {
      attempted: 1,
      inserted: 0,
      deduplicated: 0,
      failed: 1,
    });
    const recovered = await replayContrarianGuardOutcomeRows(
      rows,
      async () => true,
    );
    assert.deepEqual(recovered, {
      attempted: 1,
      inserted: 1,
      deduplicated: 0,
      failed: 0,
    });
    const raced = await replayContrarianGuardOutcomeRows(
      rows,
      async () => false,
    );
    assert.deepEqual(raced, {
      attempted: 1,
      inserted: 0,
      deduplicated: 1,
      failed: 0,
    });
  });

  it("keeps paper and live exposure blocking isolated", () => {
    const registry = new ContrarianExposureRegistry();
    registry.replace([{ mode: "live", symbol: "btc", windowKey: "w", status: "unknown" }]);
    assert.equal(registry.has("live", "BTC", "w"), true);
    assert.equal(registry.has("paper", "BTC", "w"), false);
    registry.remove("live", "BTC", "w");
    assert.equal(registry.has("live", "BTC", "w"), false);
  });
});

describe("contrarian spike durable ownership boundaries", () => {
  const normalDbSource = readFileSync(
    new URL("./kalshi-scalper-db.ts", import.meta.url),
    "utf8",
  );
  const contrarianDbSource = readFileSync(
    new URL("./kalshi-scalper-contrarian-db.ts", import.meta.url),
    "utf8",
  );
  const scalperServiceSource = readFileSync(
    new URL("./kalshi-scalper-service.ts", import.meta.url),
    "utf8",
  );

  it("serializes normal and experiment reservation ownership on the same advisory lock", () => {
    assert.match(
      normalDbSource,
      /kalshi-scalper-contrarian-cap:\$\{mode\}/,
    );
    assert.match(
      contrarianDbSource,
      /kalshi-scalper-contrarian-cap:\$\{input\.executionMode\}/,
    );
    assert.match(
      contrarianDbSource,
      /FROM kalshi_scalp_reservations r[\s\S]*r\.status = 'claimed'[\s\S]*r\.reserved_budget > 0/,
    );
    const normalConflictBlock = normalDbSource.slice(
      normalDbSource.indexOf("const contrarianConflict"),
      normalDbSource.indexOf("// Attempt to insert this reservation"),
    );
    const contrarianConflictBlock = contrarianDbSource.slice(
      contrarianDbSource.indexOf("const normalConflict"),
      contrarianDbSource.indexOf("if (normalConflict.rows[0])"),
    );
    assert.doesNotMatch(normalConflictBlock, /r\.ticker\s*=/);
    assert.doesNotMatch(contrarianConflictBlock, /r\.ticker\s*=/);
  });

  it("permits reconciliation to transition only unresolved order states", () => {
    assert.match(
      contrarianDbSource,
      /WHERE id=\$1\s+AND status IN \('submitting','unknown'\)\s+RETURNING \*/,
    );
  });

  it("keeps the prospective guard study isolated and deduplicated", () => {
    assert.match(
      contrarianDbSource,
      /CREATE TABLE IF NOT EXISTS kalshi_scalp_guard_outcome_studies/,
    );
    assert.match(
      contrarianDbSource,
      /PRIMARY KEY\(mode,symbol,window_key\)/,
    );
    assert.match(
      contrarianDbSource,
      /ON CONFLICT\(mode,symbol,window_key\) DO NOTHING/,
    );
    assert.match(
      contrarianDbSource,
      /r\.attempted_at >= m\.tracking_started_at/,
    );
    assert.match(
      contrarianDbSource,
      /r\.skip_evidence->'guardOutcomeStudy'/,
    );
    assert.match(
      scalperServiceSource,
      /"initial_final_guard"/,
    );
    assert.match(
      scalperServiceSource,
      /"paper_final_guard"/,
    );
    assert.match(
      scalperServiceSource,
      /"live_final_guard"/,
    );
    assert.match(
      scalperServiceSource,
      /guardOutcomeStudy,/,
    );
    assert.doesNotMatch(
      scalperServiceSource,
      /scheduleGuardOutcomeStudy|recordContrarianGuardOutcomeStudy/,
    );
  });
});