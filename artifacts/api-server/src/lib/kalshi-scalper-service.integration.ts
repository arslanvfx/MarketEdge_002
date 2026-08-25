import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SCALP_GUARD_RETRY_COOLDOWN_MS,
  shouldRetryConfirmedZeroFillSameLifecycle,
} from "./kalshi-scalper-policy.ts";
import {
  runControlledFreefallServiceExercise,
  runControlledSampleSchedulerExercise,
  runControlledScalperLayeringExercise,
} from "./kalshi-scalper-service.ts";

describe("authenticated final quote retry boundary", () => {
  const valid = { yesAsk: 0.97, yesBid: 0.02 };
  const oneSided = { yesAsk: 0.97, yesBid: null };

  it("recovers a transient one-sided quote without changing the pinned band, budget, or exposure", async () => {
    const result = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      authenticatedQuoteSequence: [valid, oneSided, { yesAsk: 0.98, yesBid: 0.02 }],
    });

    assert.equal(result.quoteFetches, 3);
    assert.equal(result.intentWrites, 1);
    assert.equal(result.brokerSubmissions, 1);
    assert.deepEqual(result.submittedLimitPrices, [0.99]);
    assert.deepEqual(result.submittedCounts, [2]);
    assert.deepEqual(result.submittedExchangeIndexes, [0]);
  });

  it("pins authoritative shard 2 and shard 0 in CreateOrder submissions", async () => {
    const shardTwo = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      exchangeIndex: 2,
    });
    const shardZero = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      exchangeIndex: 0,
    });
    assert.deepEqual(shardTwo.submittedExchangeIndexes, [2]);
    assert.deepEqual(shardZero.submittedExchangeIndexes, [0]);
  });

  it("blocks missing or invalid routing identity before intent and broker POST", async () => {
    for (const exchangeIndex of [null, -1, 1.5, "bad"]) {
      const result = await runControlledFreefallServiceExercise({
        onlyRecoveredStep: true,
        exchangeIndex,
      });
      assert.equal(result.intentWrites, 0);
      assert.equal(result.brokerSubmissions, 0);
      assert.equal(
        result.skippedAttempts.at(-1)?.reason,
        "identity_exchange_index_invalid_after_refresh",
      );
    }
  });

  it("does not authorize a stale valid cache when force refresh resolves null", async () => {
    const result = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      identityTarget: null,
      exchangeIndex: 2,
    });
    assert.equal(result.intentWrites, 0);
    assert.equal(result.brokerSubmissions, 0);
    assert.equal(result.skippedAttempts.at(-1)?.reason, "identity_refresh_failed");
  });

  it("does not retry a valid above-cap or below-floor quote and records the exact terminal value", async () => {
    const above = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      authenticatedQuoteSequence: [valid, { yesAsk: 0.995, yesBid: 0.001 }],
    });
    assert.equal(above.quoteFetches, 2);
    assert.equal(above.brokerSubmissions, 0);
    assert.equal(above.skippedAttempts.at(-1)?.reason, "final_quote_above_cap");
    assert.equal(above.skippedAttempts.at(-1)?.evidence?.quoteYesAsk, 0.995);
    assert.equal(above.skippedAttempts.at(-1)?.evidence?.quoteRetryCount, 0);

    const below = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      authenticatedQuoteSequence: [valid, { yesAsk: 0.95, yesBid: 0.10 }],
    });
    assert.equal(below.quoteFetches, 2);
    assert.equal(below.brokerSubmissions, 0);
    assert.equal(below.skippedAttempts.at(-1)?.reason, "final_quote_below_floor");
    assert.equal(below.skippedAttempts.at(-1)?.evidence?.quoteYesAsk, 0.95);

    const sideFlip = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      authenticatedQuoteSequence: [valid, { yesAsk: 0.995, yesBid: 0.02 }],
    });
    assert.equal(sideFlip.skippedAttempts.at(-1)?.reason, "side_flipped_final_requote");
    assert.equal(
      sideFlip.skippedAttempts.at(-1)?.evidence?.quoteAttempts?.at(-1)?.reason,
      "side_flipped_final_requote",
    );
  });

  it("stops before retry when the remaining deadline budget is too small", async () => {
    const result = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      startSecondsRemaining: 3,
      quoteFetchAdvanceMs: 600,
      authenticatedQuoteSequence: [valid, oneSided, valid],
    });

    assert.equal(result.quoteFetches, 2);
    assert.equal(result.intentWrites, 0);
    assert.equal(result.brokerSubmissions, 0);
    assert.equal(result.skippedAttempts.at(-1)?.reason, "deadline_before_quote_retry");
    assert.equal(result.skippedAttempts.at(-1)?.evidence?.quoteRetryCount, 0);
    assert.equal(result.skippedAttempts.at(-1)?.evidence?.quoteAttempts?.length, 1);
  });

  it("re-runs the final window boundary after a successful retry and cannot submit late", async () => {
    const result = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      authenticatedQuoteSequence: [valid, oneSided, valid],
      windowChangesAfterQuoteFetchCount: 3,
    });

    assert.equal(result.quoteFetches, 3);
    assert.equal(result.intentWrites, 0);
    assert.equal(result.brokerSubmissions, 0);
    assert.equal(result.skippedAttempts.at(-1)?.reason, "window_expired_before_submit");
  });

  it("refreshes the underlying alongside a retry and re-runs target proximity before intent", async () => {
    const result = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      targetProximityGuardEnabled: true,
      authenticatedQuoteSequence: [valid, oneSided, { yesAsk: 0.98, yesBid: 0.02 }],
      underlyingPriceSequence: [105, 100.01],
    });

    assert.equal(result.quoteFetches, 3);
    assert.equal(result.intentWrites, 0);
    assert.equal(result.brokerSubmissions, 0);
    assert.equal(result.skippedAttempts.at(-1)?.reason, "target_proximity_too_close");
    assert.equal(result.skippedAttempts.at(-1)?.evidence?.underlyingPrice, 100.01);
  });

  it("records stale underlying data when the retry's authoritative refresh fails", async () => {
    const result = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      targetProximityGuardEnabled: true,
      authenticatedQuoteSequence: [valid, oneSided, valid],
      underlyingSampleSuccessSequence: [true, false],
    });

    assert.equal(result.intentWrites, 0);
    assert.equal(result.brokerSubmissions, 0);
    assert.equal(result.skippedAttempts.at(-1)?.reason, "stale_underlying_after_quote_retry");
  });

  it("re-runs target proximity after intent and aborts before the broker on a late move", async () => {
    const result = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      targetProximityGuardEnabled: true,
      authenticatedQuoteSequence: [valid, oneSided, { yesAsk: 0.98, yesBid: 0.02 }],
      underlyingPriceSequence: [105, 105],
      intentWriteUnderlyingPrice: 100.01,
    });

    assert.equal(result.intentWrites, 1);
    assert.equal(result.brokerSubmissions, 0);
    assert.deepEqual(
      result.abortedBeforeSubmitReasons,
      ["aborted_before_submit:target_proximity_too_close"],
    );
    assert.equal(result.abortedBeforeSubmitEvidences[0]?.quoteYesAsk, 0.98);
    assert.equal(result.abortedBeforeSubmitEvidences[0]?.quoteRetryCount, 1);
    assert.equal(result.abortedBeforeSubmitEvidences[0]?.quoteAttempts?.length, 2);
  });
});

describe("confirmed IOC zero-fill same-lifecycle retry", () => {
  it("finalizes zero, freshly requotes, writes a new intent/id, then can fill", async () => {
    const result = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      immediateZeroFillRetry: true,
      brokerOutcomeSequence: ["zero_fill", "confirmed_fill"],
    });

    assert.equal(result.brokerSubmissions, 2);
    assert.equal(result.intentWrites, 2);
    assert.equal(result.quoteFetches, 4);
    assert.deepEqual(result.finalizedZeroFillsBeforeSubmission, [0, 1]);
    assert.equal(new Set(result.intentIds).size, 2);
    assert.equal(new Set(result.clientOrderIds).size, 2);
    assert.deepEqual(result.submittedLimitPrices, [0.99, 0.99]);
    assert.deepEqual(result.submittedCounts, [2, 2]);
    assert.deepEqual(result.submittedExchangeIndexes, [0, 0]);
  });

  it("reruns identity and uses a fresh shard for a same-lifecycle zero-fill retry", async () => {
    const result = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      immediateZeroFillRetry: true,
      brokerOutcomeSequence: ["zero_fill", "confirmed_fill"],
      exchangeIndexSequence: [2, 0],
    });
    assert.deepEqual(result.submittedExchangeIndexes, [2, 0]);
  });

  it("never retries an unknown/ambiguous classification", () => {
    assert.equal(shouldRetryConfirmedZeroFillSameLifecycle("unknown", 1), false);
    assert.equal(shouldRetryConfirmedZeroFillSameLifecycle("confirmed_fill", 1), false);
  });

  it("honors the hard three-submission cap", async () => {
    const result = await runControlledFreefallServiceExercise({
      onlyRecoveredStep: true,
      immediateZeroFillRetry: true,
      brokerOutcomeSequence: ["zero_fill", "zero_fill", "zero_fill", "confirmed_fill"],
    });

    assert.equal(result.brokerSubmissions, 3);
    assert.equal(result.intentWrites, 3);
    assert.equal(result.quoteFetches, 6);
    assert.deepEqual(result.finalizedZeroFillsBeforeSubmission, [0, 1, 2]);
    assert.equal(new Set(result.intentIds).size, 3);
    assert.equal(new Set(result.clientOrderIds).size, 3);
    assert.ok(result.submittedLimitPrices.every((price) => price === 0.99));
  });
});

describe("real Scalper service Freefall boundary", () => {
  it("blocks actual intent/submit sinks, enforces cooldown, and recovers on fresh clear data", async () => {
    const result = await runControlledFreefallServiceExercise();
    const byLabel = new Map(result.steps.map((step) => [step.label, step]));

    assert.deepEqual(
      {
        state: byLabel.get("adverse")?.state,
        reason: byLabel.get("adverse")?.reason,
        intentWrites: byLabel.get("adverse")?.intentWrites,
        brokerSubmissions: byLabel.get("adverse")?.brokerSubmissions,
        retryAfterMs: byLabel.get("adverse")?.retryAfterMs,
      },
      {
        state: "skipped",
        reason: "freefall_favorable_trend_not_confirmed_yes",
        intentWrites: 0,
        brokerSubmissions: 0,
        retryAfterMs: SCALP_GUARD_RETRY_COOLDOWN_MS,
      },
    );
    assert.deepEqual(
      {
        state: byLabel.get("adverse_cooldown")?.state,
        intentWrites: byLabel.get("adverse_cooldown")?.intentWrites,
        brokerSubmissions: byLabel.get("adverse_cooldown")?.brokerSubmissions,
        retryAfterMs: byLabel.get("adverse_cooldown")?.retryAfterMs,
      },
      {
        state: "cooldown",
        intentWrites: 0,
        brokerSubmissions: 0,
        retryAfterMs: 1,
      },
    );

    assert.deepEqual(
      {
        state: byLabel.get("fetch_failed")?.state,
        reason: byLabel.get("fetch_failed")?.reason,
        intentWrites: byLabel.get("fetch_failed")?.intentWrites,
        brokerSubmissions: byLabel.get("fetch_failed")?.brokerSubmissions,
      },
      {
        state: "skipped",
        reason: "freefall_unavailable_fetch_failed",
        intentWrites: 0,
        brokerSubmissions: 0,
      },
    );
    assert.equal(byLabel.get("fetch_cooldown")?.state, "cooldown");
    assert.equal(byLabel.get("fetch_cooldown")?.intentWrites, 0);
    assert.equal(byLabel.get("fetch_cooldown")?.brokerSubmissions, 0);

    assert.deepEqual(
      {
        state: byLabel.get("stale")?.state,
        reason: byLabel.get("stale")?.reason,
        intentWrites: byLabel.get("stale")?.intentWrites,
        brokerSubmissions: byLabel.get("stale")?.brokerSubmissions,
      },
      {
        state: "skipped",
        reason: "freefall_unavailable_stale",
        intentWrites: 0,
        brokerSubmissions: 0,
      },
    );
    assert.equal(byLabel.get("stale_cooldown")?.state, "cooldown");
    assert.equal(byLabel.get("stale_cooldown")?.intentWrites, 0);
    assert.equal(byLabel.get("stale_cooldown")?.brokerSubmissions, 0);

    assert.deepEqual(
      {
        state: byLabel.get("target_crossing")?.state,
        reason: byLabel.get("target_crossing")?.reason,
        intentWrites: byLabel.get("target_crossing")?.intentWrites,
        brokerSubmissions: byLabel.get("target_crossing")?.brokerSubmissions,
      },
      {
        state: "skipped",
        reason: "freefall_wrong_target_side_yes",
        intentWrites: 0,
        brokerSubmissions: 0,
      },
    );

    assert.deepEqual(
      {
        state: byLabel.get("recovered")?.state,
        reason: byLabel.get("recovered")?.reason,
        intentWrites: byLabel.get("recovered")?.intentWrites,
        brokerSubmissions: byLabel.get("recovered")?.brokerSubmissions,
      },
      {
        state: "submitted",
        reason: null,
        intentWrites: 1,
        brokerSubmissions: 1,
      },
    );

    assert.deepEqual(
      result.skippedAttempts.map((attempt) => attempt.reason),
      [
        "freefall_favorable_trend_not_confirmed_yes",
        "freefall_unavailable_fetch_failed",
        "freefall_unavailable_stale",
        "freefall_wrong_target_side_yes",
      ],
    );
    for (const attempt of result.skippedAttempts) {
      assert.ok(attempt.skippedAt, `${attempt.reason} must persist a dashboard timestamp`);
      assert.equal(attempt.evidence?.protectedSide, "yes");
      assert.equal(attempt.evidence?.freefallConsecutiveSeconds, 4);
      if (attempt.reason === "freefall_favorable_trend_not_confirmed_yes") {
        assert.equal(attempt.evidence?.favorableTrendConfirmationEnabled, true);
        assert.equal(attempt.evidence?.favorableTrendConfirmed, false);
        assert.equal(attempt.evidence?.wrongWayResetCount, 1);
        assert.ok(attempt.evidence?.lastWrongWayResetAt);
        assert.equal(
          attempt.evidence?.favorableTrendReason,
          "freefall_favorable_trend_not_confirmed_yes",
        );
      }
      if (attempt.reason === "freefall_wrong_target_side_yes") {
        assert.equal(attempt.evidence?.targetSideWindowConfirmed, false);
        assert.equal(attempt.evidence?.targetSideViolationPrice, 99);
        assert.ok(attempt.evidence?.targetSideViolationAt);
      }
    }

    const evidence = result.submittedEntryEvidence;
    assert.ok(evidence, "submitted order intent must retain final guard-pass evidence");
    assert.equal(evidence.phase, "final_pre_submit");
    assert.equal(evidence.side, "yes");
    assert.equal(evidence.directionGuardEnabled, true);
    assert.equal(evidence.consecutiveWrongWayMoves, 0);
    assert.equal(evidence.consecutiveWrongWaySeconds, 0);
    assert.equal(evidence.freefallConsecutiveSeconds, 4);
    assert.equal(evidence.favorableTrendConfirmationEnabled, true);
    assert.equal(evidence.favorableTrendConfirmed, true);
    assert.equal(evidence.favorableTrendReason, null);
    assert.equal(evidence.targetSideWindowConfirmed, true);
    assert.equal(evidence.targetSideViolationPrice, null);
    assert.equal(evidence.targetSideViolationAt, null);
    assert.equal(evidence.samples.length, 5);
    assert.deepEqual(
      evidence.samples.map((sample) => sample.price),
      [101, 102, 103, 104, 105],
    );
    assert.ok(
      evidence.samples.every((sample) => Date.parse(sample.at) <= Date.parse(evidence.evaluatedAt)),
      "all persisted prices must come from the final pre-submit evaluation",
    );
  });

  it("blocks a net-falling NO window that crossed the target before any intent or broker call", async () => {
    const result = await runControlledFreefallServiceExercise({ side: "no" });
    const crossing = result.steps.find((step) => step.label === "target_crossing");

    assert.deepEqual(
      {
        state: crossing?.state,
        reason: crossing?.reason,
        intentWrites: crossing?.intentWrites,
        brokerSubmissions: crossing?.brokerSubmissions,
      },
      {
        state: "skipped",
        reason: "freefall_wrong_target_side_no",
        intentWrites: 0,
        brokerSubmissions: 0,
      },
    );
    const evidence = result.skippedAttempts.find(
      (attempt) => attempt.reason === "freefall_wrong_target_side_no",
    )?.evidence;
    assert.equal(evidence?.targetSideWindowConfirmed, false);
    assert.equal(evidence?.targetSideViolationPrice, 101);
    assert.ok(evidence?.targetSideViolationAt);
  });

  for (const scenario of [
    {
      side: "no" as const,
      adversePrices: [99, 99.01, 99.02, 99.01, 99.03],
      reason: "coordinated_direction_clearance_requires_favorable_minimum_no",
    },
    {
      side: "yes" as const,
      adversePrices: [101, 100.99, 100.98, 100.99, 100.97],
      reason: "coordinated_direction_clearance_requires_favorable_minimum_yes",
    },
  ]) {
    it(`blocks a projected-safe weak ${scenario.side.toUpperCase()} adverse trend at the final live boundary`, async () => {
      const result = await runControlledFreefallServiceExercise({
        side: scenario.side,
        targetProximityGuardEnabled: true,
        coordinatedDirectionClearanceEnabled: true,
        adversePrices: scenario.adversePrices,
      });
      const adverse = result.steps.find((step) => step.label === "adverse");
      assert.deepEqual(
        {
          state: adverse?.state,
          reason: adverse?.reason,
          intentWrites: adverse?.intentWrites,
          brokerSubmissions: adverse?.brokerSubmissions,
        },
        {
          state: "skipped",
          reason: `freefall_favorable_trend_not_confirmed_${scenario.side}`,
          intentWrites: 0,
          brokerSubmissions: 0,
        },
      );
      const evidence = result.skippedAttempts.find(
        (attempt) =>
          attempt.reason
          === `freefall_favorable_trend_not_confirmed_${scenario.side}`,
      )?.evidence;
      assert.ok(evidence, "blocked attempt must retain coordinated evidence");
      assert.equal(evidence.coordinatedDirectionClearanceEnabled, true);
      assert.equal(evidence.coordinatedDirectionClearanceApplied, false);
      assert.equal(evidence.coordinatedDirectionClearanceSafe, true);
      assert.equal(
        evidence.coordinatedDirectionClearanceReason,
        scenario.reason,
      );
      assert.ok((evidence.projectedDistancePct ?? 0) > 0.05);
      assert.ok((evidence.secondsRemaining ?? 0) > 0);
    });
  }

  it("persists projected-too-close evidence when coordination rejects before intent creation", async () => {
    const result = await runControlledFreefallServiceExercise({
      side: "no",
      targetProximityGuardEnabled: true,
      coordinatedDirectionClearanceEnabled: true,
      adversePrices: [99.85, 99.9, 99.95, 99.9, 99.94],
    });
    const blocked = result.skippedAttempts.find(
      (attempt) =>
        attempt.reason
        === "coordinated_direction_clearance_projected_too_close_no",
    );
    assert.ok(blocked, "projected-too-close attempt must be persisted");
    assert.equal(result.steps[0]?.state, "skipped");
    assert.equal(result.steps[0]?.intentWrites, 0);
    assert.equal(result.steps[0]?.brokerSubmissions, 0);
    assert.equal(
      blocked.evidence?.coordinatedDirectionClearanceEnabled,
      true,
    );
    assert.equal(
      blocked.evidence?.coordinatedDirectionClearanceApplied,
      false,
    );
    assert.equal(
      blocked.evidence?.coordinatedDirectionClearanceSafe,
      false,
    );
    assert.equal(
      blocked.evidence?.coordinatedDirectionClearanceReason,
      "coordinated_direction_clearance_projected_too_close_no",
    );
    assert.ok((blocked.evidence?.projectedDistancePct ?? Infinity) <= 0.05);
    assert.equal(blocked.evidence?.minimumPct, 0.05);
    assert.ok((blocked.evidence?.secondsRemaining ?? 0) > 0);
  });

  it("stores the decisive post-intent favorable evidence used by a live submission", async () => {
    const result = await runControlledFreefallServiceExercise({
      side: "no",
      targetProximityGuardEnabled: true,
      coordinatedDirectionClearanceEnabled: true,
      adversePrices: [99, 98.99, 98.98, 98.99, 98.97],
      intentWriteAdvanceMs: 1_000,
    });
    const adverse = result.steps.find((step) => step.label === "adverse");
    assert.equal(adverse?.state, "submitted");
    const evidence = result.submittedEntryEvidences[0];
    assert.ok(evidence);
    assert.equal(evidence.coordinatedDirectionClearanceApplied, false);
    assert.equal(evidence.favorableTrendConfirmed, true);
    assert.equal(evidence.secondsRemaining, 39);
    assert.equal(
      evidence.evaluatedAt,
      "2026-08-22T07:14:21.000Z",
      "durable evidence must come from the decisive post-intent recheck",
    );
  });

  it("applies the same meaningful favorable minimum at the final paper boundary", async () => {
    const result = await runControlledFreefallServiceExercise({
      mode: "paper",
      side: "yes",
      targetProximityGuardEnabled: true,
      coordinatedDirectionClearanceEnabled: true,
      adversePrices: [101, 101.01, 101.02, 101.01, 101.03],
    });
    const adverse = result.steps.find((step) => step.label === "adverse");
    assert.equal(adverse?.state, "submitted");
    assert.equal(adverse?.paperSubmissions, 1);
    assert.equal(adverse?.brokerSubmissions, 0);
    assert.equal(adverse?.intentWrites, 0);
    const evidence = result.submittedEntryEvidences[0];
    assert.ok(evidence);
    assert.equal(evidence.side, "yes");
    assert.equal(evidence.coordinatedDirectionClearanceApplied, false);
    assert.equal(evidence.favorableTrendConfirmed, true);
  });

  it("copies final target distance into every retry intent and retains the newest snapshot", async () => {
    const result = await runControlledFreefallServiceExercise({
      targetProximityGuardEnabled: true,
      runSecondSubmission: true,
    });

    assert.equal(result.intentWrites, 2);
    assert.equal(result.brokerSubmissions, 2);
    assert.equal(result.submittedEntryEvidences.length, 2);
    assert.ok(
      result.submittedEntryEvidences.every(
        (evidence) =>
          evidence.phase === "final_pre_submit"
          && evidence.targetProximityGuardEnabled
          && evidence.minimumPct === 0.05
          && evidence.targetPrice === 100,
      ),
    );
    assert.equal(result.submittedEntryEvidences[0]?.underlyingPrice, 105);
    assert.equal(result.submittedEntryEvidences[0]?.distancePct, 5);
    assert.equal(result.submittedEntryEvidences[1]?.underlyingPrice, 110);
    assert.equal(result.submittedEntryEvidences[1]?.distancePct, 10);
    assert.deepEqual(
      result.submittedEntryEvidence,
      result.submittedEntryEvidences[1],
      "the final retry must be the snapshot surfaced as the latest submission",
    );
  });

  it("rechecks sample freshness after a slow intent write and never reaches the broker", async () => {
    const result = await runControlledFreefallServiceExercise({
      intentWriteAdvanceMs: 2_500,
    });
    const recovered = result.steps.find((step) => step.label === "recovered");

    assert.equal(result.intentWrites, 1);
    assert.equal(result.brokerSubmissions, 0);
    assert.equal(recovered?.state, "skipped");
    assert.deepEqual(
      result.abortedBeforeSubmitReasons,
      ["aborted_before_submit:freefall_unavailable_stale"],
    );
  });
});

describe("real Scalper authoritative sample lane", () => {
  it("starts final guard work while two background fetches are still occupied", async () => {
    const result = await runControlledSampleSchedulerExercise();
    assert.deepEqual(
      result.backgroundStartedBeforeAuthoritative,
      ["CTRL-BG-1", "CTRL-BG-2"],
    );
    assert.equal(result.authoritativeStartedBeforeBackgroundRelease, true);
    assert.deepEqual(
      result.startOrder,
      ["CTRL-BG-1", "CTRL-BG-2", "CTRL-AUTH", "CTRL-BG-3"],
    );
    assert.equal(result.maxActiveObserved, 3);
  });
});

describe("real Scalper regular-position layering boundary", () => {
  it("aborts before broker submit when the regular side flips during intent persistence", async () => {
    const result = await runControlledScalperLayeringExercise();
    assert.deepEqual(
      {
        compatibilityChecks: result.liveBoundaryConflict.compatibilityChecks,
        intentWrites: result.liveBoundaryConflict.intentWrites,
        brokerSubmissions: result.liveBoundaryConflict.brokerSubmissions,
        aborts: result.liveBoundaryConflict.aborts,
        abortReason: result.liveBoundaryConflict.abortReason,
      },
      {
        compatibilityChecks: 3,
        intentWrites: 1,
        brokerSubmissions: 0,
        aborts: 1,
        abortReason: "aborted_before_submit:opposite_regular_position",
      },
    );
    assert.equal(result.liveBoundaryConflict.conflictEvidence?.layerDecision, "opposite_side_block");
    assert.equal(result.liveBoundaryConflict.conflictEvidence?.regularPositionSide, "no");
    assert.equal(result.liveBoundaryConflict.conflictEvidence?.selectedSide, "yes");
  });

  it("surfaces atomic paper persistence failure without separate best-effort writes", async () => {
    const result = await runControlledScalperLayeringExercise();
    assert.equal(result.paperPersistenceFailure.persistenceCalls, 1);
    assert.equal(result.paperPersistenceFailure.standaloneIntentWrites, 0);
    assert.equal(result.paperPersistenceFailure.standaloneReservationUpdates, 0);
    assert.match(result.paperPersistenceFailure.surfacedError ?? "", /controlled_paper_persistence_failure/);
    assert.equal(result.paperPersistenceFailure.layeredRegularPositionId, "regular-position-same");
    assert.equal(result.paperPersistenceFailure.layeredRegularSide, "yes");
  });
});