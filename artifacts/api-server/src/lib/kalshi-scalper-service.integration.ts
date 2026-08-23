import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCALP_GUARD_RETRY_COOLDOWN_MS } from "./kalshi-scalper-policy.ts";
import {
  runControlledFreefallServiceExercise,
  runControlledSampleSchedulerExercise,
  runControlledScalperLayeringExercise,
} from "./kalshi-scalper-service.ts";

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