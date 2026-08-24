// Isolated pure policy for the optional contrarian spike experiment.  It has no
// dependency on normal reservations, orders, caps, or trader state.
import type {
  FreefallPreSubmitDecision,
  FreefallGuardResult,
} from "./kalshi-scalper-policy.ts";
import type { ScalpMode } from "./kalshi-scalper-types.ts";

export type ContrarianSide = "yes" | "no";
export type ContrarianMode = ScalpMode;

export interface ContrarianConfig {
  enabled: boolean;
  mode: ContrarianMode;
  budgetDollars: number;
  dailyCapDollars: number;
  openCapDollars: number;
  perWindowCapDollars: number;
  maxDirectContractCost: number;
  circuitBreakerEnabled: boolean;
  circuitBreaker: boolean;
  circuitBreakerReason: string | null;
}

export const CONTRARIAN_HARD_LIMITS = {
  budgetDollars: 1,
  dailyCapDollars: 10,
  openCapDollars: 2,
  perWindowCapDollars: 1,
  minDirectContractCost: 0.01,
  maxDirectContractCost: 0.1,
} as const;

export const DEFAULT_CONTRARIAN_CONFIG: ContrarianConfig = {
  enabled: false,
  mode: "paper",
  budgetDollars: 0.25,
  dailyCapDollars: 1,
  openCapDollars: 0.5,
  perWindowCapDollars: 0.25,
  maxDirectContractCost: 0.05,
  circuitBreakerEnabled: true,
  circuitBreaker: false,
  circuitBreakerReason: null,
};

export type ContrarianConfigPatch = Partial<Pick<
  ContrarianConfig,
  | "enabled"
  | "mode"
  | "budgetDollars"
  | "dailyCapDollars"
  | "openCapDollars"
  | "perWindowCapDollars"
  | "maxDirectContractCost"
  | "circuitBreakerEnabled"
>>;

export type ContrarianEligibility =
  | { eligible: true; protectedSide: ContrarianSide; oppositeSide: ContrarianSide; reason: "target_crossed" | "projected_target_crossing"; guard: FreefallGuardResult }
  | { eligible: false; reason: string };

/** Only directional adverse final-guard outcomes are eligible. */
export function evaluateContrarianGuardEligibility(
  decision: FreefallPreSubmitDecision,
  protectedSide: ContrarianSide,
): ContrarianEligibility {
  const guard = decision.guardResult;
  if (!decision.allowed && guard == null) return { eligible: false, reason: "guard_evidence_missing" };
  if (!guard || decision.allowed || !guard.evaluable || !guard.blocked) {
    return { eligible: false, reason: "not_a_final_adverse_guard_block" };
  }
  const projectedTooCloseReason = protectedSide === "yes"
    ? "coordinated_direction_clearance_projected_too_close_yes"
    : "coordinated_direction_clearance_projected_too_close_no";
  const wrongTargetReason = protectedSide === "yes"
    ? "freefall_wrong_target_side_yes"
    : "freefall_wrong_target_side_no";
  const consecutiveReason = protectedSide === "yes"
    ? "freefall_consecutive_falling"
    : "freefall_consecutive_rising";
  // Never admit rapid-move-only or generic favorable-trend failure. The one
  // exception is the exact existing coordinated projection rejection.
  const exactWrongTargetBlock =
    guard.wrongTargetSide && guard.reason === wrongTargetReason;
  const exactConsecutiveBlock =
    guard.directionalBlocked && guard.reason === consecutiveReason;
  const exactCoordinatedProjectionBlock =
    guard.coordinatedDirectionClearanceReason === projectedTooCloseReason
    && guard.reason === projectedTooCloseReason;
  if (!exactWrongTargetBlock && !exactConsecutiveBlock && !exactCoordinatedProjectionBlock) {
    return { eligible: false, reason: "not_directional_adverse_block" };
  }
  if (guard.targetPrice == null || guard.latestPrice == null) {
    return { eligible: false, reason: "target_evidence_missing" };
  }
  const crossed = protectedSide === "yes"
    ? guard.latestPrice <= guard.targetPrice
    : guard.latestPrice >= guard.targetPrice;
  const projectedCrossed = guard.projectedPrice != null && (protectedSide === "yes"
    ? guard.projectedPrice <= guard.targetPrice
    : guard.projectedPrice >= guard.targetPrice);
  if (!crossed && !projectedCrossed) {
    return { eligible: false, reason: "target_not_crossed_or_projected" };
  }
  return {
    eligible: true,
    protectedSide,
    oppositeSide: protectedSide === "yes" ? "no" : "yes",
    reason: crossed ? "target_crossed" : "projected_target_crossing",
    guard,
  };
}

function isCentIncrement(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

export function validateContrarianConfig(config: ContrarianConfig): string[] {
  const errors: string[] = [];
  const finitePositive = (
    key: "budgetDollars" | "dailyCapDollars" | "openCapDollars" | "perWindowCapDollars",
    hardMax: number,
  ) => {
    const value = config[key];
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`${key} must be a finite positive number`);
    } else if (value > hardMax) {
      errors.push(`${key} cannot exceed the experiment hard limit of ${hardMax}`);
    }
  };
  finitePositive("budgetDollars", CONTRARIAN_HARD_LIMITS.budgetDollars);
  finitePositive("dailyCapDollars", CONTRARIAN_HARD_LIMITS.dailyCapDollars);
  finitePositive("openCapDollars", CONTRARIAN_HARD_LIMITS.openCapDollars);
  finitePositive("perWindowCapDollars", CONTRARIAN_HARD_LIMITS.perWindowCapDollars);
  if (
    !Number.isFinite(config.maxDirectContractCost)
    || config.maxDirectContractCost < CONTRARIAN_HARD_LIMITS.minDirectContractCost
    || config.maxDirectContractCost > CONTRARIAN_HARD_LIMITS.maxDirectContractCost
  ) {
    errors.push(
      `maxDirectContractCost must be between ${CONTRARIAN_HARD_LIMITS.minDirectContractCost} and ${CONTRARIAN_HARD_LIMITS.maxDirectContractCost}`,
    );
  } else if (!isCentIncrement(config.maxDirectContractCost)) {
    errors.push("maxDirectContractCost must use whole-cent increments");
  }
  if (config.budgetDollars > config.perWindowCapDollars) {
    errors.push("budgetDollars cannot exceed perWindowCapDollars");
  }
  if (config.perWindowCapDollars > config.openCapDollars) {
    errors.push("perWindowCapDollars cannot exceed openCapDollars");
  }
  if (config.openCapDollars > config.dailyCapDollars) {
    errors.push("openCapDollars cannot exceed dailyCapDollars");
  }
  if (!config.circuitBreakerEnabled) {
    errors.push("the experiment circuit breaker must remain enabled");
  }
  return errors;
}

export type ContrarianOrderPlan =
  | {
    ok: true;
    contractCount: number;
    yesLimitPrice: number;
    maxExposure: number;
    hypotheticalAvgYesPrice: number;
  }
  | { ok: false; reason: string };

export function planContrarianOrder(input: {
  budgetDollars: number;
  maxDirectContractCost: number;
  directAsk: number;
  oppositeSide: ContrarianSide;
}): ContrarianOrderPlan {
  const { budgetDollars, maxDirectContractCost, directAsk, oppositeSide } = input;
  if (
    !Number.isFinite(budgetDollars)
    || budgetDollars <= 0
    || !Number.isFinite(maxDirectContractCost)
    || maxDirectContractCost <= 0
    || !Number.isFinite(directAsk)
    || directAsk <= 0
  ) {
    return { ok: false, reason: "invalid_order_economics" };
  }
  if (directAsk > maxDirectContractCost + 1e-9) {
    return { ok: false, reason: "opposite_ask_above_cap" };
  }
  const contractCount = Math.floor((budgetDollars + 1e-9) / maxDirectContractCost);
  if (contractCount < 1) return { ok: false, reason: "budget_below_one_contract_at_limit" };
  const maxExposure = contractCount * maxDirectContractCost;
  if (maxExposure > budgetDollars + 1e-9) {
    return { ok: false, reason: "worst_case_exposure_exceeds_budget" };
  }
  return {
    ok: true,
    contractCount,
    yesLimitPrice: oppositeSide === "yes"
      ? maxDirectContractCost
      : 1 - maxDirectContractCost,
    maxExposure,
    hypotheticalAvgYesPrice: oppositeSide === "yes" ? directAsk : 1 - directAsk,
  };
}

export function computeContrarianPnl(input: {
  side: ContrarianSide;
  count: number;
  avgYesPrice: number;
  result: ContrarianSide;
}): number {
  const { side, count, avgYesPrice, result } = input;
  if (
    !Number.isFinite(count)
    || count <= 0
    || !Number.isFinite(avgYesPrice)
    || avgYesPrice <= 0
    || avgYesPrice >= 1
  ) {
    throw new Error("invalid contrarian settlement economics");
  }
  if (side === "yes") {
    return result === "yes"
      ? (1 - avgYesPrice) * count
      : -avgYesPrice * count;
  }
  return result === "no"
    ? avgYesPrice * count
    : -(1 - avgYesPrice) * count;
}

export function computeContrarianFillSpend(
  side: ContrarianSide,
  filledCount: number,
  avgYesFillPrice: number,
): number | null {
  if (
    !Number.isInteger(filledCount)
    || filledCount <= 0
    || !Number.isFinite(avgYesFillPrice)
    || avgYesFillPrice <= 0
    || avgYesFillPrice >= 1
  ) {
    return null;
  }
  const directCost = side === "yes" ? avgYesFillPrice : 1 - avgYesFillPrice;
  const spend = filledCount * directCost;
  return Number.isFinite(spend) && spend > 0 ? spend : null;
}

/** Strict allowlisted parser: internal breaker latch state is never patchable. */
export function parseContrarianConfigPatch(value: unknown):
  | { ok: true; value: ContrarianConfigPatch }
  | { ok: false; errors: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["config must be an object"] };
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    "enabled", "mode", "budgetDollars", "dailyCapDollars", "openCapDollars",
    "perWindowCapDollars", "maxDirectContractCost", "circuitBreakerEnabled",
  ]);
  const errors = Object.keys(raw).filter((key) => !allowed.has(key)).map((key) => `unknown field: ${key}`);
  const out: Partial<ContrarianConfigPatch> = {};
  if ("enabled" in raw) {
    if (typeof raw.enabled !== "boolean") errors.push("enabled must be boolean");
    else out.enabled = raw.enabled;
  }
  if ("circuitBreakerEnabled" in raw) {
    if (raw.circuitBreakerEnabled !== true) {
      errors.push("the experiment circuit breaker must remain enabled");
    } else {
      out.circuitBreakerEnabled = true;
    }
  }
  if ("mode" in raw) {
    if (raw.mode !== "paper" && raw.mode !== "live") errors.push("mode must be paper or live");
    else out.mode = raw.mode;
  }
  for (const key of ["budgetDollars", "dailyCapDollars", "openCapDollars", "perWindowCapDollars", "maxDirectContractCost"] as const) {
    if (key in raw) {
      const n = raw[key];
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
        errors.push(`${key} must be a finite positive number`);
      } else if (
        key === "maxDirectContractCost"
        && (
          n < CONTRARIAN_HARD_LIMITS.minDirectContractCost
          || n > CONTRARIAN_HARD_LIMITS.maxDirectContractCost
          || !isCentIncrement(n)
        )
      ) {
        errors.push(
          `${key} must be a whole-cent value between ${CONTRARIAN_HARD_LIMITS.minDirectContractCost} and ${CONTRARIAN_HARD_LIMITS.maxDirectContractCost}`,
        );
      } else if (
        key !== "maxDirectContractCost"
        && n > CONTRARIAN_HARD_LIMITS[key]
      ) {
        errors.push(`${key} exceeds the experiment hard limit`);
      } else {
        out[key] = n;
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out as ContrarianConfigPatch };
}

/** Synchronous mode-isolated exposure lookup for the normal final-submit path. */
export class ContrarianExposureRegistry {
  private readonly active = new Set<string>();
  private key(mode: ScalpMode, symbol: string, windowKey: string): string {
    return `${mode}:${symbol.toUpperCase()}:${windowKey}`;
  }
  replace(rows: Array<{ mode: ScalpMode; symbol: string; windowKey: string; status: string }>): void {
    this.active.clear();
    for (const row of rows) if (row.status === "submitting" || row.status === "unknown" || row.status === "filled") this.active.add(this.key(row.mode, row.symbol, row.windowKey));
  }
  has(mode: ScalpMode, symbol: string, windowKey: string): boolean {
    return this.active.has(this.key(mode, symbol, windowKey));
  }
  add(mode: ScalpMode, symbol: string, windowKey: string): void { this.active.add(this.key(mode, symbol, windowKey)); }
  remove(mode: ScalpMode, symbol: string, windowKey: string): void { this.active.delete(this.key(mode, symbol, windowKey)); }
}