import type {
  SmartExitAppliedVersion,
  SmartExitConfig,
  SmartExitOwnerKind,
  SmartExitPosition,
} from "./kalshi-smart-exit-types.ts";

export interface SmartExitExecutionConstraint {
  readonly authorization: import("./kalshi-smart-exit-types.ts").SmartExitExecutionAuthorization;
  readonly minimumWinningPrice: number;
  readonly evaluatedBookObservedAtSeconds: number;
  readonly maximumEvidenceAgeSeconds: number;
  readonly evidenceExpiresAtSeconds: number;
}

export function combineSmartExitExecutionConstraints(
  original: SmartExitExecutionConstraint,
  revalidated: SmartExitExecutionConstraint,
): SmartExitExecutionConstraint {
  if (original.authorization !== revalidated.authorization) {
    throw new Error("smart_exit_authorization_changed");
  }
  return {
    authorization: original.authorization,
    minimumWinningPrice: Math.max(
      original.minimumWinningPrice,
      revalidated.minimumWinningPrice,
    ),
    evaluatedBookObservedAtSeconds: revalidated.evaluatedBookObservedAtSeconds,
    maximumEvidenceAgeSeconds: Math.min(
      original.maximumEvidenceAgeSeconds,
      revalidated.maximumEvidenceAgeSeconds,
    ),
    evidenceExpiresAtSeconds: Math.min(
      original.evidenceExpiresAtSeconds,
      revalidated.evidenceExpiresAtSeconds,
    ),
  };
}
import { resolveSmartExitSensitivity } from "./kalshi-smart-exit-policy.ts";

export function computeSmartExitExecutionLimit(params: {
  side: "yes" | "no";
  quantity: number;
  minimumWinningPrice: number;
  yesDepth: readonly [number, number][];
  noDepth: readonly [number, number][];
}): {
  allowed: boolean;
  yesSideLimitPrice: number | null;
  executableQuantity: number;
  reason: string;
} {
  const { side, quantity, minimumWinningPrice } = params;
  if (
    !Number.isFinite(quantity) || quantity <= 0
    || !Number.isFinite(minimumWinningPrice)
    || minimumWinningPrice <= 0
    || minimumWinningPrice >= 1
  ) {
    return { allowed: false, yesSideLimitPrice: null, executableQuantity: 0, reason: "invalid_constraint" };
  }
  const winningDepth = side === "yes" ? params.yesDepth : params.noDepth;
  const executableQuantity = winningDepth.reduce(
    (sum, [price, available]) =>
      Number.isFinite(price) && Number.isFinite(available)
      && price + 1e-9 >= minimumWinningPrice && available > 0
        ? sum + available
        : sum,
    0,
  );
  if (executableQuantity + 1e-9 < quantity) {
    return {
      allowed: false,
      yesSideLimitPrice: null,
      executableQuantity,
      reason: "insufficient_depth_at_floor",
    };
  }
  const yesSideLimitPrice = side === "yes"
    ? Math.ceil(minimumWinningPrice * 100) / 100
    : Math.floor((1 - minimumWinningPrice) * 100) / 100;
  if (!(yesSideLimitPrice > 0 && yesSideLimitPrice < 1)) {
    return { allowed: false, yesSideLimitPrice: null, executableQuantity, reason: "invalid_limit" };
  }
  return { allowed: true, yesSideLimitPrice, executableQuantity, reason: "authorized" };
}

export interface SmartExitExecutionIdentity {
  positionId: string;
  symbol: string;
  windowKey: string;
  ticker: string;
  side: "yes" | "no";
  tradingMode: "paper" | "live";
  remainingQuantity: number;
}

export function smartExitIdentityMatches(
  current: SmartExitExecutionIdentity | null | undefined,
  expected: SmartExitPosition,
): boolean {
  return current != null
    && current.positionId === expected.positionId
    && current.symbol.toUpperCase() === expected.symbol.toUpperCase()
    && current.windowKey === expected.windowKey
    && current.ticker === expected.ticker
    && current.side === expected.side
    && current.tradingMode === expected.owner.tradingMode
    && current.remainingQuantity === expected.remainingQuantity;
}

export type SmartExitExecutionAuthorization =
  | { authorized: true; parameterVersion: string }
  | { authorized: false; reason: string };

export const BASELINE_SMART_EXIT_PARAMETER_VERSION = "built-in-default";

export function hasCompleteSmartExitParameterSnapshot(
  appliedVersion: SmartExitAppliedVersion,
): appliedVersion is SmartExitAppliedVersion & {
  parameters: NonNullable<SmartExitAppliedVersion["parameters"]>;
} {
  const parameters = appliedVersion.parameters;
  const canonical = parameters == null ? null : resolveSmartExitSensitivity(parameters.sensitivity);
  return parameters != null
    && Number.isInteger(parameters.debounceCount)
    && parameters.debounceCount >= 1
    && (parameters.sensitivity === "more_aggressive"
      || parameters.sensitivity === "default"
      || parameters.sensitivity === "less_aggressive")
    && Number.isFinite(parameters.confirmationLevel)
    && parameters.confirmationLevel >= 0
    && Number.isFinite(parameters.minMarketLossFraction)
    && parameters.minMarketLossFraction >= 0
    && parameters.minMarketLossFraction <= 1
    && Number.isFinite(parameters.crossingReserveFraction)
    && parameters.crossingReserveFraction >= 0
    && parameters.crossingReserveFraction <= 1
    && parameters.debounceCount === canonical!.parameters.debounceCount
    && parameters.confirmationLevel === canonical!.parameters.confirmationLevel
    && parameters.minMarketLossFraction === canonical!.parameters.minMarketLossFraction
    && parameters.crossingReserveFraction === canonical!.parameters.crossingReserveFraction
    && Number.isFinite(parameters.minExitEdge)
    && parameters.minExitEdge >= 0
    && Number.isFinite(parameters.deepLossHoldThreshold)
    && parameters.deepLossHoldThreshold >= 0
    && parameters.deepLossHoldThreshold <= 1
    && Number.isFinite(parameters.terminalLossHoldThreshold)
    && parameters.terminalLossHoldThreshold >= parameters.deepLossHoldThreshold
    && parameters.terminalLossHoldThreshold <= 1
    && Number.isFinite(parameters.deepLossRecoveryMinSeconds)
    && parameters.deepLossRecoveryMinSeconds >= 0;
}

/**
 * The only policy gate allowed to cross from recommendation to owner request.
 * It is intentionally pure so off/shadow/non-matching behavior can be proven
 * without importing broker or database code.
 */
export function authorizeSmartExitExecution(params: {
  config: SmartExitConfig;
  position: SmartExitPosition;
  recommendation: "off" | "hold" | "watch" | "prepare_exit" | "exit" | "unavailable";
  appliedVersion: SmartExitAppliedVersion | null;
}): SmartExitExecutionAuthorization {
  const { config, position, recommendation, appliedVersion } = params;
  if (!config.enabled || config.mode === "off") return { authorized: false, reason: "disabled" };
  if (config.mode === "shadow") return { authorized: false, reason: "shadow mode never executes" };
  if (recommendation !== "exit") return { authorized: false, reason: "no exit recommendation" };
  if (position.owner.kind === "scalper") {
    return { authorized: false, reason: "scalper early-close lifecycle unavailable" };
  }
  if (config.mode === "paper-exit" && position.owner.tradingMode !== "paper") {
    return { authorized: false, reason: "paper-exit cannot close a live position" };
  }
  if (config.mode === "live-exit" && position.owner.tradingMode !== "live") {
    return { authorized: false, reason: "live-exit cannot close a paper position" };
  }
  // The built-in policy selected by the operator is a complete executable
  // policy. Applied versions are optional calibrated overrides, not a
  // prerequisite that silently disables every baseline paper/live exit.
  if (!appliedVersion) {
    return { authorized: true, parameterVersion: BASELINE_SMART_EXIT_PARAMETER_VERSION };
  }
  if (!hasCompleteSmartExitParameterSnapshot(appliedVersion)) {
    return { authorized: false, reason: "parameter version lacks an immutable policy snapshot" };
  }
  if (
    appliedVersion.owner !== position.owner.kind
    || appliedVersion.symbol.toUpperCase() !== position.symbol.toUpperCase()
  ) return { authorized: false, reason: "parameter version scope mismatch" };
  if (config.mode === "live-exit") {
    if (!appliedVersion.liveEligible) {
      return { authorized: false, reason: "parameter version is not live eligible" };
    }
  }
  return { authorized: true, parameterVersion: appliedVersion.version };
}

export function smartExitVersionKey(owner: SmartExitOwnerKind, symbol: string): string {
  return `${owner}:${symbol.toUpperCase()}`;
}