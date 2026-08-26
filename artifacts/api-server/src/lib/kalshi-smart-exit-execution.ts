import type {
  SmartExitAppliedVersion,
  SmartExitConfig,
  SmartExitOwnerKind,
  SmartExitPosition,
} from "./kalshi-smart-exit-types.ts";

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

/**
 * The only policy gate allowed to cross from recommendation to owner request.
 * It is intentionally pure so off/shadow/non-matching behavior can be proven
 * without importing broker or database code.
 */
export function authorizeSmartExitExecution(params: {
  config: SmartExitConfig;
  position: SmartExitPosition;
  recommendation: "off" | "hold" | "exit" | "unavailable";
  appliedVersion: SmartExitAppliedVersion | null;
}): SmartExitExecutionAuthorization {
  const { config, position, recommendation, appliedVersion } = params;
  if (!config.enabled || config.mode === "off") return { authorized: false, reason: "disabled" };
  if (config.mode === "shadow") return { authorized: false, reason: "shadow mode never executes" };
  if (recommendation !== "exit") return { authorized: false, reason: "no exit recommendation" };
  if (!appliedVersion) return { authorized: false, reason: "no operator-applied parameter version" };
  if (
    appliedVersion.owner !== position.owner.kind
    || appliedVersion.symbol.toUpperCase() !== position.symbol.toUpperCase()
  ) return { authorized: false, reason: "parameter version scope mismatch" };
  if (position.owner.kind === "scalper") {
    return { authorized: false, reason: "scalper early-close lifecycle unavailable" };
  }
  if (config.mode === "paper-exit" && position.owner.tradingMode !== "paper") {
    return { authorized: false, reason: "paper-exit cannot close a live position" };
  }
  if (config.mode === "live-exit") {
    if (position.owner.tradingMode !== "live") {
      return { authorized: false, reason: "live-exit cannot close a paper position" };
    }
    if (!appliedVersion.liveEligible) {
      return { authorized: false, reason: "parameter version is not live eligible" };
    }
  }
  return { authorized: true, parameterVersion: appliedVersion.version };
}

export function smartExitVersionKey(owner: SmartExitOwnerKind, symbol: string): string {
  return `${owner}:${symbol.toUpperCase()}`;
}