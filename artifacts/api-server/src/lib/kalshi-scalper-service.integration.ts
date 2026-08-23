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
        reason: "freefall_consecutive_falling",
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
        "freefall_consecutive_falling",
        "freefall_unavailable_fetch_failed",
        "freefall_unavailable_stale",
      ],
    );
    for (const attempt of result.skippedAttempts) {
      assert.ok(attempt.skippedAt, `${attempt.reason} must persist a dashboard timestamp`);
      assert.equal(attempt.evidence?.protectedSide, "yes");
      assert.equal(attempt.evidence?.freefallConsecutiveSeconds, 4);
    }
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