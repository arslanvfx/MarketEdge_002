export const DASHBOARD2_POLICY_VERSION = "dashboard2-entry-v1";
export const DASHBOARD2_CONSERVATIVE_MAX_CONTRACTS = 2;

export interface Dashboard2Policy {
  readonly version: string;
  readonly minEntryMinute: number;
  readonly sideCostFloor: number;
  readonly sideCostCeiling: number;
  readonly maxContracts: number;
}

export type Dashboard2QuoteDecision =
  | { authorized: true; action: "authorize-entry"; reason: null }
  | { authorized: false; action: "reject" | "hold-not-sell"; reason: string };

/**
 * Returns a frozen policy snapshot. The legacy dollar cap is used only to make
 * the contract-count limit more conservative; malformed or absent config never
 * increases the explicit fallback.
 */
export function createDashboard2Policy(existingMaxBetSize?: number | null): Dashboard2Policy {
  const configDerivedCap =
    Number.isFinite(existingMaxBetSize) && existingMaxBetSize! > 0
      ? Math.floor(existingMaxBetSize! / 0.87)
      : DASHBOARD2_CONSERVATIVE_MAX_CONTRACTS;
  const maxContracts = Math.max(
    0,
    Math.min(DASHBOARD2_CONSERVATIVE_MAX_CONTRACTS, configDerivedCap),
  );
  return Object.freeze({
    version: DASHBOARD2_POLICY_VERSION,
    minEntryMinute: 8,
    sideCostFloor: 0.79,
    sideCostCeiling: 0.87,
    maxContracts,
  });
}

export const DEFAULT_DASHBOARD2_POLICY = createDashboard2Policy();

export function authorizeDashboard2Quote(input: {
  elapsedMinutes: number;
  sideCost: number;
  contractCount: number;
  phase?: "entry" | "exchange-price-improvement";
  policy?: Dashboard2Policy;
}): Dashboard2QuoteDecision {
  const policy = input.policy ?? DEFAULT_DASHBOARD2_POLICY;
  if (!Number.isFinite(input.elapsedMinutes) || input.elapsedMinutes < policy.minEntryMinute) {
    return { authorized: false, action: "reject", reason: "entry_window_not_open" };
  }
  if (!Number.isInteger(input.contractCount) || input.contractCount < 1) {
    return { authorized: false, action: "reject", reason: "invalid_contract_count" };
  }
  if (input.contractCount > policy.maxContracts) {
    return { authorized: false, action: "reject", reason: "contract_cap_exceeded" };
  }
  if (!Number.isFinite(input.sideCost)) {
    return { authorized: false, action: "reject", reason: "invalid_side_cost" };
  }
  if (input.sideCost > policy.sideCostCeiling) {
    return { authorized: false, action: "reject", reason: "side_cost_above_ceiling" };
  }
  if (input.sideCost < policy.sideCostFloor) {
    return input.phase === "exchange-price-improvement"
      ? { authorized: false, action: "hold-not-sell", reason: "exchange_price_improved_below_floor" }
      : { authorized: false, action: "reject", reason: "side_cost_below_floor" };
  }
  return { authorized: true, action: "authorize-entry", reason: null };
}