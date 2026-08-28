import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeDashboard2Capital, evaluateDashboard2SafetyGate, type Dashboard2SafetyEvidence } from "./dashboard2-safety-gate.ts";
import { DEFAULT_DASHBOARD2_POLICY } from "./dashboard2-policy.ts";

const evidence = (): Dashboard2SafetyEvidence => ({
  identity: { symbol: "BTC", ticker: "KXBTC", windowKey: "2026-01-01T00:00", side: "yes", bookVersion: "1:2" },
  elapsedMinutes: 8, sideCost: 0.82, sequenceValid: true, bookFresh: true,
  signalPreparationComplete: true, hasDuplicateOrOpenPosition: false, quietHoursAllows: true,
  directionEvidencePositive: true, targetProximityPositive: true, availableFunding: 10, exposureAllowance: 2,
});
const decide = (patch: Partial<Dashboard2SafetyEvidence> = {}) => evaluateDashboard2SafetyGate({
  expectedIdentity: evidence().identity, evidence: { ...evidence(), ...patch },
  policy: DEFAULT_DASHBOARD2_POLICY, visibleExecutableDepth: 2, observationOnly: true, owner: "dashboard2_bot",
});

test("Safety Gate fail-closes every mandatory unknown", () => {
  const cases: Array<[keyof Dashboard2SafetyEvidence, string]> = [
    ["elapsedMinutes", "elapsed_minute_unknown"], ["sideCost", "side_cost_unknown"],
    ["sequenceValid", "book_sequence_unknown"], ["bookFresh", "book_freshness_unknown"],
    ["signalPreparationComplete", "signal_preparation_unknown"], ["hasDuplicateOrOpenPosition", "open_position_conflict_unknown"],
    ["quietHoursAllows", "quiet_hours_unknown"], ["directionEvidencePositive", "direction_evidence_unknown"],
    ["targetProximityPositive", "target_proximity_unknown"], ["availableFunding", "funding_unknown"],
    ["exposureAllowance", "exposure_unknown"],
  ];
  for (const [field, reason] of cases) {
    assert.equal(decide({ [field]: null } as Partial<Dashboard2SafetyEvidence>).blockingReason, reason);
  }
});

test("Safety Gate honors minute and inclusive cost boundaries", () => {
  assert.equal(decide({ elapsedMinutes: 7.999 }).blockingReason, "entry_window_not_open");
  assert.equal(decide({ sideCost: 0.79 }).blockingReason, "execution_observation_only");
  assert.equal(decide({ sideCost: 0.85 }).blockingReason, "execution_observation_only");
});

test("Safety Gate rejects missing or mismatched bound identity", () => {
  assert.equal(decide({
    identity: { ...evidence().identity, bookVersion: null },
  }).blockingReason, "book_version_unknown");
  assert.equal(decide({
    identity: { ...evidence().identity, ticker: "OTHER" },
  }).blockingReason, "identity_mismatch");
});

test("capital authorization caps depth, funding, and exposure at policy ceiling", () => {
  assert.deepEqual(authorizeDashboard2Capital({
    maxContracts: 9, visibleExecutableDepth: 7, availableFunding: 2.7, sideCostCeiling: 0.85, exposureAllowance: 2,
  }), { authorized: true, quantity: 2, worstCaseCost: 1.7, blockingReason: null });
  assert.equal(authorizeDashboard2Capital({
    maxContracts: 2, visibleExecutableDepth: 2, availableFunding: 10, sideCostCeiling: 0.85, exposureAllowance: 0,
  }).authorized, false);
});

test("observation-only is shadow-qualified but never execution-authorized", () => {
  const result = decide();
  assert.equal(result.shadowQualified, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.blockingReason, "execution_observation_only");
  const ownerBlocked = evaluateDashboard2SafetyGate({
    expectedIdentity: evidence().identity, evidence: evidence(), policy: DEFAULT_DASHBOARD2_POLICY,
    visibleExecutableDepth: 2, observationOnly: false, owner: "current_bot",
  });
  assert.equal(ownerBlocked.shadowQualified, true);
  assert.equal(ownerBlocked.executionAuthorized, false);
});