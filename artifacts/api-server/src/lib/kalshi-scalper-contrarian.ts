// Isolated pure policy for the optional contrarian spike experiment.  It has no
// dependency on normal reservations, orders, caps, or trader state.
import type {
  FreefallPreSubmitDecision,
  FreefallGuardResult,
} from "./kalshi-scalper-policy.ts";
import type {
  ScalpGuardOutcomeStudyRecoveryPayload,
  ScalpMode,
} from "./kalshi-scalper-types.ts";

export type ContrarianSide = "yes" | "no";
export type ContrarianMode = ScalpMode;

/** Persisted, deliberately narrow admission policy for reversal executions. */
export interface StrictContrarianEligibilityProfile {
  finalWindowSeconds: number;
  minDirectAsk: number;
  maxDirectAsk: number;
  minRepeatedAdverseMoves: number;
  requireTargetCrossingOrReachableProjection: true;
}

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
  strictEligibility: StrictContrarianEligibilityProfile;
}

export const CONTRARIAN_HARD_LIMITS = {
  budgetDollars: 1,
  dailyCapDollars: 10,
  openCapDollars: 2,
  perWindowCapDollars: 1,
  minDirectContractCost: 0.01,
  maxDirectContractCost: 0.03,
} as const;

export const DEFAULT_CONTRARIAN_CONFIG: ContrarianConfig = {
  enabled: false,
  mode: "paper",
  budgetDollars: 0.25,
  dailyCapDollars: 1,
  openCapDollars: 0.5,
  perWindowCapDollars: 0.25,
  maxDirectContractCost: 0.03,
  circuitBreakerEnabled: true,
  circuitBreaker: false,
  circuitBreakerReason: null,
  strictEligibility: {
    finalWindowSeconds: 120,
    minDirectAsk: 0.01,
    maxDirectAsk: 0.03,
    minRepeatedAdverseMoves: 4,
    requireTargetCrossingOrReachableProjection: true,
  },
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
  | "strictEligibility"
>>;

export type ContrarianEligibility =
  | { eligible: true; protectedSide: ContrarianSide; oppositeSide: ContrarianSide; reason: "target_crossed" | "projected_target_crossing"; guard: FreefallGuardResult }
  | { eligible: false; reason: string; evidence?: Record<string, unknown> };

/** Bounded, side-specific cadence gate for cache-only monitor observations. */
export class ContrarianMonitorAttemptScheduler {
  private readonly nextAt = new Map<string, number>();
  private readonly cooldownMs: number;
  constructor(cooldownMs = 3_000) {
    this.cooldownMs = cooldownMs;
  }
  allow(mode: ContrarianMode, symbol: string, windowKey: string, side: ContrarianSide, nowMs: number): boolean {
    const key = `${mode}:${symbol.toUpperCase()}:${windowKey}:${side}`;
    if ((this.nextAt.get(key) ?? 0) > nowMs) return false;
    this.nextAt.set(key, nowMs + this.cooldownMs);
    return true;
  }
  clearExceptWindow(windowKey: string): void {
    for (const key of this.nextAt.keys()) if (!key.includes(`:${windowKey}:`)) this.nextAt.delete(key);
  }
}

/** Shared fail-closed identity pin check used by independent monitor refreshes. */
export function isPinnedContrarianIdentityCurrent(input: {
  ticker: string | null | undefined;
  closeTime: string | null | undefined;
  targetPrice: number | null | undefined;
  pinnedTicker: string;
  pinnedCloseTime: string;
  pinnedTargetPrice: number;
}): boolean {
  return input.ticker === input.pinnedTicker
    && input.closeTime === input.pinnedCloseTime
    && Number.isFinite(input.targetPrice)
    && Math.abs((input.targetPrice as number) - input.pinnedTargetPrice) <= 1e-9;
}

/** Only directional adverse final-guard outcomes are eligible. */
export function evaluateContrarianGuardEligibility(
  decision: FreefallPreSubmitDecision,
  protectedSide: ContrarianSide,
  profile: StrictContrarianEligibilityProfile = DEFAULT_CONTRARIAN_CONFIG.strictEligibility,
): ContrarianEligibility {
  const guard = decision.guardResult;
  const evidence = guard ? {
    secondsRemaining: guard.secondsRemaining,
    consecutiveWrongWayMoves: guard.consecutiveWrongWayMoves,
    requiredConsecutiveMoves: guard.requiredConsecutiveMoves,
    targetPrice: guard.targetPrice,
    latestPrice: guard.latestPrice,
    projectedPrice: guard.projectedPrice,
    adversePacePctPerSecond: guard.adversePacePctPerSecond,
  } : undefined;
  if (!decision.allowed && guard == null) return { eligible: false, reason: "guard_evidence_missing", evidence };
  if (!guard || decision.allowed || !guard.evaluable || !guard.blocked) {
    return { eligible: false, reason: !guard?.evaluable ? "guard_unevaluable_or_stale" : "not_a_final_adverse_guard_block", evidence };
  }
  if (
    guard.secondsRemaining == null
    || !Number.isFinite(guard.secondsRemaining)
    || guard.secondsRemaining < 0
    || guard.secondsRemaining > profile.finalWindowSeconds
  ) {
    return { eligible: false, reason: "outside_strict_final_window", evidence };
  }
  if (
    !Number.isInteger(guard.consecutiveWrongWayMoves)
    || guard.consecutiveWrongWayMoves < profile.minRepeatedAdverseMoves
  ) {
    return { eligible: false, reason: "insufficient_repeated_adverse_movement", evidence };
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
    return { eligible: false, reason: "generic_or_wrong_direction_guard_block", evidence };
  }
  if (guard.targetPrice == null || guard.latestPrice == null) {
    return { eligible: false, reason: "target_evidence_missing", evidence };
  }
  const crossed = protectedSide === "yes"
    ? guard.latestPrice <= guard.targetPrice
    : guard.latestPrice >= guard.targetPrice;
  const projectedCrossed = guard.projectedPrice != null
    && guard.secondsRemaining > 0
    && guard.adversePacePctPerSecond != null
    && Number.isFinite(guard.adversePacePctPerSecond)
    && guard.adversePacePctPerSecond > 0
    && (protectedSide === "yes"
    ? guard.projectedPrice <= guard.targetPrice
    : guard.projectedPrice >= guard.targetPrice);
  if (!crossed && !projectedCrossed) {
    return { eligible: false, reason: "target_not_crossed_or_credibly_projected", evidence };
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
  const strict = config.strictEligibility;
  if (!strict || strict.requireTargetCrossingOrReachableProjection !== true) {
    errors.push("strictEligibility must require a target crossing or reachable projection");
  } else {
    if (!Number.isInteger(strict.finalWindowSeconds) || strict.finalWindowSeconds < 1 || strict.finalWindowSeconds > 120) errors.push("strictEligibility.finalWindowSeconds must be an integer from 1 to 120");
    if (strict.minDirectAsk !== 0.01) errors.push("strictEligibility.minDirectAsk must remain 0.01");
    if (!Number.isFinite(strict.maxDirectAsk) || strict.maxDirectAsk < strict.minDirectAsk || strict.maxDirectAsk > 0.03 || !isCentIncrement(strict.maxDirectAsk)) errors.push("strictEligibility.maxDirectAsk must be a whole-cent value from 0.01 to 0.03");
    if (!Number.isInteger(strict.minRepeatedAdverseMoves) || strict.minRepeatedAdverseMoves < 2) errors.push("strictEligibility.minRepeatedAdverseMoves must be at least 2");
  }
  if (config.maxDirectContractCost > config.strictEligibility.maxDirectAsk) errors.push("maxDirectContractCost cannot exceed strictEligibility.maxDirectAsk");
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
  minDirectContractCost?: number;
}): ContrarianOrderPlan {
  const { budgetDollars, maxDirectContractCost, directAsk, oppositeSide } = input;
  const minDirectContractCost = input.minDirectContractCost ?? 0.01;
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
  if (directAsk < minDirectContractCost - 1e-9) return { ok: false, reason: "opposite_ask_below_strict_floor" };
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

export interface ContrarianGuardOutcomeHypothesis {
  yesAsk: number | null;
  noAsk: number | null;
  oppositeAsk: number | null;
  quoteSupported: boolean;
  hypotheticalContracts: number;
  hypotheticalBudget: number;
  hypotheticalAvgYesPrice: number | null;
}

export interface ContrarianGuardOutcomeStudyTrigger {
  sourceMode: ScalpMode;
  symbol: string;
  windowKey: string;
  ticker: string;
  closeTime: string;
  protectedSide: ContrarianSide;
  decision: FreefallPreSubmitDecision;
  yesAsk: number | null;
  noAsk: number | null;
  budgetDollars: number;
  observedAtMs?: number;
  evidence?: Record<string, unknown>;
}

/**
 * Builds a quote-backed counterfactual using the normal Scalper's budget at the
 * guard boundary. This does not claim an IOC fill; it only prices the opposite
 * direction at the authenticated ask that was actually observed.
 */
export function buildContrarianGuardOutcomeHypothesis(input: {
  oppositeSide: ContrarianSide;
  yesAsk: number | null;
  noAsk: number | null;
  budgetDollars: number;
}): ContrarianGuardOutcomeHypothesis {
  const validAsk = (value: number | null): number | null =>
    value != null && Number.isFinite(value) && value > 0 && value < 1
      ? value
      : null;
  const yesAsk = validAsk(input.yesAsk);
  const noAsk = validAsk(input.noAsk);
  const oppositeAsk = input.oppositeSide === "yes" ? yesAsk : noAsk;
  if (
    oppositeAsk == null
    || !Number.isFinite(input.budgetDollars)
    || input.budgetDollars <= 0
  ) {
    return {
      yesAsk,
      noAsk,
      oppositeAsk,
      quoteSupported: false,
      hypotheticalContracts: 0,
      hypotheticalBudget: 0,
      hypotheticalAvgYesPrice: null,
    };
  }
  const hypotheticalContracts = Math.floor(
    (input.budgetDollars + 1e-9) / oppositeAsk,
  );
  if (hypotheticalContracts < 1) {
    return {
      yesAsk,
      noAsk,
      oppositeAsk,
      quoteSupported: false,
      hypotheticalContracts: 0,
      hypotheticalBudget: 0,
      hypotheticalAvgYesPrice: null,
    };
  }
  return {
    yesAsk,
    noAsk,
    oppositeAsk,
    quoteSupported: true,
    hypotheticalContracts,
    hypotheticalBudget: hypotheticalContracts * oppositeAsk,
    hypotheticalAvgYesPrice:
      input.oppositeSide === "yes" ? oppositeAsk : 1 - oppositeAsk,
  };
}

export function buildContrarianGuardOutcomeStudyPayload(
  input: ContrarianGuardOutcomeStudyTrigger,
): ScalpGuardOutcomeStudyRecoveryPayload | null {
  const eligibility = evaluateContrarianGuardEligibility(
    input.decision,
    input.protectedSide,
  );
  if (!eligibility.eligible) return null;
  const closeTime = new Date(input.closeTime);
  const observedAt = new Date(input.observedAtMs ?? Date.now());
  if (
    Number.isNaN(closeTime.valueOf())
    || Number.isNaN(observedAt.valueOf())
  ) {
    return null;
  }
  const hypothesis = buildContrarianGuardOutcomeHypothesis({
    oppositeSide: eligibility.oppositeSide,
    yesAsk: input.yesAsk,
    noAsk: input.noAsk,
    budgetDollars: input.budgetDollars,
  });
  const secondsRemaining = Number.isFinite(eligibility.guard.secondsRemaining)
    ? eligibility.guard.secondsRemaining
    : Math.max(0, (closeTime.valueOf() - observedAt.valueOf()) / 1_000);
  return {
    version: 1,
    mode: input.sourceMode,
    symbol: input.symbol.toUpperCase(),
    windowKey: input.windowKey,
    ticker: input.ticker,
    closeTime: closeTime.toISOString(),
    guardReason: eligibility.guard.reason ?? eligibility.reason,
    crossingType: eligibility.reason,
    protectedSide: input.protectedSide,
    oppositeSide: eligibility.oppositeSide,
    secondsRemaining,
    ...hypothesis,
    evidence: {
      guard: eligibility.guard,
      eligibilityReason: eligibility.reason,
      ...(input.evidence ?? {}),
    },
    observedAt: observedAt.toISOString(),
  };
}

export interface ContrarianGuardOutcomeOutboxRow {
  mode: ContrarianMode;
  symbol: string;
  windowKey: string;
  payload: ScalpGuardOutcomeStudyRecoveryPayload;
}

export async function replayContrarianGuardOutcomeRows(
  rows: ContrarianGuardOutcomeOutboxRow[],
  record: (
    payload: ScalpGuardOutcomeStudyRecoveryPayload,
  ) => Promise<boolean>,
): Promise<{
  attempted: number;
  inserted: number;
  deduplicated: number;
  failed: number;
}> {
  let inserted = 0;
  let deduplicated = 0;
  let failed = 0;
  for (const row of rows) {
    const payload = row.payload;
    if (
      payload.mode !== row.mode
      || payload.symbol.toUpperCase() !== row.symbol.toUpperCase()
      || payload.windowKey !== row.windowKey
    ) {
      failed += 1;
      continue;
    }
    try {
      if (await record(payload)) inserted += 1;
      else deduplicated += 1;
    } catch {
      failed += 1;
    }
  }
  return { attempted: rows.length, inserted, deduplicated, failed };
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
    "perWindowCapDollars", "maxDirectContractCost", "circuitBreakerEnabled", "strictEligibility",
  ]);
  const errors = Object.keys(raw).filter((key) => !allowed.has(key)).map((key) => `unknown field: ${key}`);
  const out: Partial<ContrarianConfigPatch> = {};
  if ("enabled" in raw) {
    if (typeof raw.enabled !== "boolean") errors.push("enabled must be boolean");
    else out.enabled = raw.enabled;
  }
  if ("strictEligibility" in raw) {
    const strict = raw.strictEligibility;
    if (!strict || typeof strict !== "object" || Array.isArray(strict)) {
      errors.push("strictEligibility must be an object");
    } else {
      const value = strict as Record<string, unknown>;
      const required = ["finalWindowSeconds", "minDirectAsk", "maxDirectAsk", "minRepeatedAdverseMoves", "requireTargetCrossingOrReachableProjection"];
      if (Object.keys(value).some((key) => !required.includes(key))) errors.push("strictEligibility contains unknown field");
      if (value.finalWindowSeconds !== 120 || value.minDirectAsk !== 0.01 || value.maxDirectAsk !== 0.03 || value.minRepeatedAdverseMoves !== 4 || value.requireTargetCrossingOrReachableProjection !== true) errors.push("strictEligibility is a fixed strict reversal profile");
      else out.strictEligibility = { ...DEFAULT_CONTRARIAN_CONFIG.strictEligibility };
    }
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