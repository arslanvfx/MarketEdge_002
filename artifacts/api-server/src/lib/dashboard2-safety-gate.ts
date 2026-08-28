import type { Dashboard2Policy } from "./dashboard2-policy.ts";
import { checkDuplicatePositionGuard } from "./kalshi-bot-guards.ts";

export type Dashboard2Side = "yes" | "no";

/**
 * A candidate and its evidence are deliberately separate.  This prevents a
 * quote, book, or signal collected for one contract/window from being reused
 * for another one by accident.
 */
export interface Dashboard2SafetyIdentity {
  readonly symbol: string | null;
  readonly ticker: string | null;
  readonly windowKey: string | null;
  readonly side: Dashboard2Side | null;
  readonly bookVersion: string | null;
}

export interface Dashboard2SafetyEvidence {
  readonly identity: Dashboard2SafetyIdentity;
  readonly elapsedMinutes: number | null;
  readonly sideCost: number | null;
  readonly sequenceValid: boolean | null;
  readonly bookFresh: boolean | null;
  readonly signalPreparationComplete: boolean | null;
  readonly hasDuplicateOrOpenPosition: boolean | null;
  readonly quietHoursAllows: boolean | null;
  readonly directionEvidencePositive: boolean | null;
  readonly targetProximityPositive: boolean | null;
  /** Account funding available for this entry. null means it was not observed. */
  readonly availableFunding: number | null;
  /** Remaining exposure expressed in contracts at the policy ceiling. */
  readonly exposureAllowance: number | null;
}

export type Dashboard2SafetyBlockReason =
  | "elapsed_minute_unknown"
  | "entry_window_not_open"
  | "side_cost_unknown"
  | "side_cost_below_floor"
  | "side_cost_above_ceiling"
  | "symbol_unknown"
  | "ticker_unknown"
  | "window_key_unknown"
  | "side_unknown"
  | "book_version_unknown"
  | "identity_mismatch"
  | "book_sequence_unknown"
  | "book_sequence_invalid"
  | "book_freshness_unknown"
  | "book_stale"
  | "signal_preparation_unknown"
  | "signal_preparation_incomplete"
  | "open_position_conflict_unknown"
  | "duplicate_or_open_position_conflict"
  | "quiet_hours_unknown"
  | "quiet_hours_blocked"
  | "direction_evidence_unknown"
  | "direction_evidence_not_positive"
  | "target_proximity_unknown"
  | "target_proximity_not_positive"
  | "funding_unknown"
  | "exposure_unknown"
  | "max_contracts_invalid"
  | "max_contracts_zero"
  | "visible_depth_unknown"
  | "visible_depth_invalid"
  | "funding_invalid"
  | "funding_insufficient"
  | "exposure_invalid"
  | "exposure_insufficient"
  | "policy_ceiling_invalid"
  | "execution_observation_only"
  | "execution_owner_not_dashboard2_bot";

export interface Dashboard2CapitalAuthorization {
  readonly authorized: boolean;
  readonly quantity: number;
  /** Always quantity × policy ceiling; never a sampled/observed ask. */
  readonly worstCaseCost: number;
  readonly blockingReason: Dashboard2SafetyBlockReason | null;
}

export interface Dashboard2SafetyDecision {
  readonly shadowQualified: boolean;
  readonly executionAuthorized: boolean;
  readonly blockingReason: Dashboard2SafetyBlockReason | null;
  readonly capital: Dashboard2CapitalAuthorization;
}

export interface Dashboard2SafetyGateInput {
  readonly expectedIdentity: Dashboard2SafetyIdentity;
  readonly evidence: Dashboard2SafetyEvidence;
  readonly policy: Dashboard2Policy;
  readonly visibleExecutableDepth: number | null;
  readonly observationOnly: boolean;
  /**
   * Paper simulations must clear every non-broker gate, but never require or
   * acquire the real execution owner.
   */
  readonly paperSimulation?: boolean;
  readonly owner: string | null;
}

const frozenCapital = (
  authorized: boolean,
  quantity: number,
  ceiling: number,
  blockingReason: Dashboard2SafetyBlockReason | null,
): Dashboard2CapitalAuthorization => Object.freeze({
  authorized,
  quantity,
  worstCaseCost: quantity * ceiling,
  blockingReason,
});

/**
 * Pure contract sizing.  The ceiling, rather than a currently attractive ask,
 * is the cost basis, so authorization cannot rely on a price that disappears.
 */
export function authorizeDashboard2Capital(input: {
  readonly maxContracts: number | null;
  readonly visibleExecutableDepth: number | null;
  readonly availableFunding: number | null;
  readonly sideCostCeiling: number | null;
  readonly exposureAllowance: number | null;
}): Dashboard2CapitalAuthorization {
  const ceiling = input.sideCostCeiling;
  if (!Number.isFinite(ceiling) || ceiling! <= 0) {
    return frozenCapital(false, 0, 0, "policy_ceiling_invalid");
  }
  if (!Number.isSafeInteger(input.maxContracts) || input.maxContracts! < 0) {
    return frozenCapital(false, 0, ceiling!, "max_contracts_invalid");
  }
  if (input.maxContracts === 0) return frozenCapital(false, 0, ceiling!, "max_contracts_zero");
  if (input.visibleExecutableDepth === null) return frozenCapital(false, 0, ceiling!, "visible_depth_unknown");
  if (!Number.isSafeInteger(input.visibleExecutableDepth) || input.visibleExecutableDepth < 1) {
    return frozenCapital(false, 0, ceiling!, "visible_depth_invalid");
  }
  if (input.availableFunding === null) return frozenCapital(false, 0, ceiling!, "funding_unknown");
  if (!Number.isFinite(input.availableFunding) || input.availableFunding < 0) {
    return frozenCapital(false, 0, ceiling!, "funding_invalid");
  }
  if (input.availableFunding < ceiling!) return frozenCapital(false, 0, ceiling!, "funding_insufficient");
  if (input.exposureAllowance === null) return frozenCapital(false, 0, ceiling!, "exposure_unknown");
  if (!Number.isSafeInteger(input.exposureAllowance) || input.exposureAllowance < 0) {
    return frozenCapital(false, 0, ceiling!, "exposure_invalid");
  }
  if (input.exposureAllowance === 0) return frozenCapital(false, 0, ceiling!, "exposure_insufficient");

  const quantity = Math.min(
    input.maxContracts!,
    input.visibleExecutableDepth,
    Math.floor(input.availableFunding / ceiling!),
    input.exposureAllowance,
  );
  return quantity > 0
    ? frozenCapital(true, quantity, ceiling!, null)
    : frozenCapital(false, 0, ceiling!, "funding_insufficient");
}

const missingIdentityReason = (identity: Dashboard2SafetyIdentity): Dashboard2SafetyBlockReason | null => {
  if (!identity.symbol) return "symbol_unknown";
  if (!identity.ticker) return "ticker_unknown";
  if (!identity.windowKey) return "window_key_unknown";
  if (!identity.side) return "side_unknown";
  if (!identity.bookVersion) return "book_version_unknown";
  return null;
};

/** Pure fail-closed Safety Gate. It observes evidence only and issues no token. */
export function evaluateDashboard2SafetyGate(input: Dashboard2SafetyGateInput): Dashboard2SafetyDecision {
  const { evidence, expectedIdentity, policy } = input;
  const block = (reason: Dashboard2SafetyBlockReason, capital?: Dashboard2CapitalAuthorization) =>
    Object.freeze({
      shadowQualified: false,
      executionAuthorized: false,
      blockingReason: reason,
      capital: capital ?? frozenCapital(false, 0, policy.sideCostCeiling, reason),
    });

  if (!Number.isFinite(evidence.elapsedMinutes)) return block("elapsed_minute_unknown");
  if (evidence.elapsedMinutes! < policy.minEntryMinute) return block("entry_window_not_open");
  if (!Number.isFinite(evidence.sideCost)) return block("side_cost_unknown");
  if (evidence.sideCost! < policy.sideCostFloor) return block("side_cost_below_floor");
  if (evidence.sideCost! > policy.sideCostCeiling) return block("side_cost_above_ceiling");

  const expectedMissing = missingIdentityReason(expectedIdentity);
  if (expectedMissing) return block(expectedMissing);
  const evidenceMissing = missingIdentityReason(evidence.identity);
  if (evidenceMissing) return block(evidenceMissing);
  if (
    evidence.identity.symbol !== expectedIdentity.symbol ||
    evidence.identity.ticker !== expectedIdentity.ticker ||
    evidence.identity.windowKey !== expectedIdentity.windowKey ||
    evidence.identity.side !== expectedIdentity.side ||
    evidence.identity.bookVersion !== expectedIdentity.bookVersion
  ) return block("identity_mismatch");

  if (evidence.sequenceValid === null) return block("book_sequence_unknown");
  if (!evidence.sequenceValid) return block("book_sequence_invalid");
  if (evidence.bookFresh === null) return block("book_freshness_unknown");
  if (!evidence.bookFresh) return block("book_stale");
  if (evidence.signalPreparationComplete === null) return block("signal_preparation_unknown");
  if (!evidence.signalPreparationComplete) return block("signal_preparation_incomplete");
  if (evidence.hasDuplicateOrOpenPosition === null) return block("open_position_conflict_unknown");
  if (checkDuplicatePositionGuard(evidence.hasDuplicateOrOpenPosition)) return block("duplicate_or_open_position_conflict");
  if (evidence.quietHoursAllows === null) return block("quiet_hours_unknown");
  if (!evidence.quietHoursAllows) return block("quiet_hours_blocked");
  if (evidence.directionEvidencePositive === null) return block("direction_evidence_unknown");
  if (!evidence.directionEvidencePositive) return block("direction_evidence_not_positive");
  if (evidence.targetProximityPositive === null) return block("target_proximity_unknown");
  if (!evidence.targetProximityPositive) return block("target_proximity_not_positive");
  if (evidence.availableFunding === null) return block("funding_unknown");
  if (evidence.exposureAllowance === null) return block("exposure_unknown");

  const capital = authorizeDashboard2Capital({
    maxContracts: policy.maxContracts,
    visibleExecutableDepth: input.visibleExecutableDepth,
    availableFunding: evidence.availableFunding,
    sideCostCeiling: policy.sideCostCeiling,
    exposureAllowance: evidence.exposureAllowance,
  });
  if (!capital.authorized) return block(capital.blockingReason!, capital);
  // Qualification is intentionally separate from permission to execute.  A
  // shadow-qualified observation is useful dashboard evidence, but never a
  // capability or an authorization-store token.
  if (input.observationOnly) {
    return Object.freeze({
      shadowQualified: true,
      executionAuthorized: false,
      blockingReason: "execution_observation_only" as const,
      capital,
    });
  }
  if (input.paperSimulation) {
    return Object.freeze({ shadowQualified: true, executionAuthorized: true, blockingReason: null, capital });
  }
  if (input.owner !== "dashboard2_bot") {
    return Object.freeze({
      shadowQualified: true,
      executionAuthorized: false,
      blockingReason: "execution_owner_not_dashboard2_bot" as const,
      capital,
    });
  }
  return Object.freeze({ shadowQualified: true, executionAuthorized: true, blockingReason: null, capital });
}