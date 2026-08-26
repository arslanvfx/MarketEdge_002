/**
 * Data-only contracts for the Smart Exit policy.  These are deliberately
 * independent of Kalshi clients, persistence, and clocks: callers supply an
 * explicit `nowSeconds` and immutable market evidence.
 */

export type SmartExitMode = "off" | "shadow" | "paper-exit" | "live-exit";

export function smartExitModeIncludesPosition(
  smartExitMode: SmartExitMode,
  positionMode: "paper" | "live",
): boolean {
  if (smartExitMode === "off") return false;
  if (smartExitMode === "paper-exit") return positionMode === "paper";
  if (smartExitMode === "live-exit") return positionMode === "live";
  return true;
}
export type BinarySide = "yes" | "no";
export type UnderlyingKind = "crypto" | "commodity" | "other";
export type SmartExitOwnerKind = "regular" | "scalper";
export type SmartExitTradingMode = "paper" | "live";
export type SmartExitRiskStage = "hold" | "watch" | "prepare_exit" | "exit";
export type SmartExitSensitivity = "more_aggressive" | "default" | "less_aggressive";
export type SmartExitComponentStatus = "fresh" | "quiet" | "delayed" | "unavailable";

export type SmartExitComponentHealthMap = Readonly<Record<string, {
  readonly status: SmartExitComponentStatus;
  readonly receiptAgeMs: number | null;
  readonly eventAgeMs: number | null;
}>>;

export function normalizeSmartExitComponentHealth(
  value: SmartExitComponentHealthMap | null | undefined,
): SmartExitComponentHealthMap {
  const unavailable = {
    status: "unavailable" as const,
    receiptAgeMs: null,
    eventAgeMs: null,
  };
  const source = value ?? {};
  return {
    spot: source["spot"] ?? unavailable,
    tape: source["tape"] ?? unavailable,
    coinbaseBook: source["coinbaseBook"] ?? unavailable,
    kalshiQuote: source["kalshiQuote"] ?? unavailable,
    kalshiBook: source["kalshiBook"] ?? unavailable,
  };
}

export interface SmartExitOwner {
  readonly kind: SmartExitOwnerKind;
  readonly tradingMode: SmartExitTradingMode;
}

/** Values captured at entry must never be substituted with a current quote. */
export interface SmartExitPosition {
  readonly positionId: string;
  readonly owner: SmartExitOwner;
  readonly symbol: string;
  readonly windowKey: string;
  readonly ticker: string;
  readonly side: BinarySide;
  readonly underlyingKind: UnderlyingKind;
  readonly remainingQuantity: number;
  /** Original requested quantity; may exceed the filled/remaining quantity. */
  readonly requestedQuantity: number;
  /** Actual dollars paid for the remaining contracts at entry. */
  readonly entryStake: number;
  readonly exchangeIndex: number | null;
  readonly strikePrice: number;
  readonly expirySeconds: number;
  readonly openedAtSeconds: number;
  readonly modelAtEntry: {
    readonly winProbability: number | null;
    readonly observedAtSeconds: number;
  };
  /** Winning-side Kalshi probability at entry (YES price for YES, 1-YES for NO). */
  readonly marketAtEntry: {
    readonly winProbability: number;
    readonly observedAtSeconds: number;
  };
}

/**
 * Underlying-feed evidence. Volatility is a log-return standard deviation per
 * sqrt(second), so it can be multiplied directly by sqrt(seconds remaining).
 * Momentum is the log return measured over `momentumWindowSeconds`.
 */
export interface SmartExitEvidence {
  readonly source: "coinbase-rest" | "unsupported";
  readonly observedAtSeconds: number;
  /** Receipt times prove transport freshness; exchange event times may be older in a quiet market. */
  readonly spotReceivedAtSeconds: number | null;
  readonly tapeReceivedAtSeconds: number | null;
  readonly bookReceivedAtSeconds: number | null;
  readonly spotObservedAtSeconds: number | null;
  readonly tapeObservedAtSeconds: number | null;
  readonly bookObservedAtSeconds: number | null;
  readonly underlyingPrice: number | null;
  readonly volatilityLogReturnPerSqrtSecond: number | null;
  readonly momentumLogReturn: number | null;
  readonly momentumWindowSeconds: number | null;
  /** (aggressive buy volume - sell volume) / total volume, in [-1, 1]. */
  readonly tradeFlowImbalance: number | null;
  /** (bid depth - ask depth) / total depth, in [-1, 1]. */
  readonly bookImbalance: number | null;
  /** Current winning-side market probability; retained for audit, not model entry. */
  readonly marketWinProbability: number | null;
  readonly marketQuoteObservedAtSeconds: number | null;
  readonly marketBookObservedAtSeconds: number | null;
  readonly marketBestBid: number | null;
  readonly marketBestAsk: number | null;
  readonly marketExecutablePrice: number | null;
  readonly marketExecutableQuantity: number | null;
}

export interface SmartExitConfig {
  readonly enabled: boolean;
  readonly mode: SmartExitMode;
  /** Operator-selected canonical crossing-risk preset. Missing legacy values resolve to default. */
  readonly sensitivity: SmartExitSensitivity;
  readonly totalWindowSeconds: number;
  readonly maxEvidenceAgeSeconds: number;
  readonly minVolatilityLogReturnPerSqrtSecond: number;
  /** Inflates Gaussian uncertainty before CDF calculation to account for tails. */
  readonly fatTailVolatilityMultiplier: number;
  /** Pulls model probabilities toward 0.5: 0=no shrink, 1=entirely 0.5. */
  readonly probabilityShrinkage: number;
  readonly baseProbabilityDropThreshold: number;
  readonly confirmationLevel: number;
  readonly debounceCount: number;
  readonly hysteresisSeconds: number;
  readonly hardStopProbabilityDrop: number;
  readonly hardStopWindowSeconds: number;
  /** Fraction of entry contract value lost before immediate high-risk review. */
  readonly rapidLossRatio: number;
  /** Minimum per-contract advantage required for selling over the model hold value. */
  readonly minExitEdge: number;
  /** Capital-loss fraction where recovery protection starts (default 80%). */
  readonly deepLossHoldThreshold: number;
  /** Capital-loss fraction where the position is always left to resolve (default 90%). */
  readonly terminalLossHoldThreshold: number;
  /** Minimum time required for the conditional 80–90% recovery hold. */
  readonly deepLossRecoveryMinSeconds: number;
  readonly continuationWeights: {
    readonly momentum: number;
    readonly tradeFlow: number;
    readonly book: number;
  };
  /** Owner/symbol keys use `regular:BTC` or `scalper:BTC`. */
  readonly appliedVersions: Readonly<Record<string, SmartExitAppliedVersion>>;
}

export interface SmartExitAppliedVersion {
  readonly owner: SmartExitOwnerKind;
  readonly symbol: string;
  readonly version: string;
  readonly liveEligible: boolean;
  readonly appliedAt: string;
  /** Immutable policy values validated for this owner/symbol. */
  readonly parameters?: {
    readonly sensitivity: SmartExitSensitivity;
    readonly debounceCount: number;
    readonly confirmationLevel: number;
    readonly minMarketLossFraction: number;
    readonly crossingReserveFraction: number;
    readonly minExitEdge: number;
    readonly deepLossHoldThreshold: number;
    readonly terminalLossHoldThreshold: number;
    readonly deepLossRecoveryMinSeconds: number;
  };
}

export interface SmartExitState {
  readonly adverseSampleCount: number;
  readonly holdUntilSeconds: number;
  readonly previousModelProbability: number | null;
  readonly previousObservedAtSeconds: number | null;
  readonly previousUnderlyingPrice: number | null;
  readonly previousUnderlyingAtSeconds: number | null;
  readonly previousAdverseVelocity: number | null;
}

export type SmartExitDisposition = "OFF" | "HOLD" | "WATCH" | "PREPARE_EXIT" | "EXIT_SIGNAL" | "UNAVAILABLE";

export interface SmartExitDecision {
  readonly disposition: SmartExitDisposition;
  readonly reason: string;
  /** True only for a live-exit mode signal; this policy never submits orders. */
  readonly mayExecuteExit: boolean;
  readonly modelWinProbability: number | null;
  readonly probabilityDropFromEntry: number | null;
  readonly threshold: number | null;
  readonly continuationScore: number | null;
  readonly riskStage: SmartExitRiskStage;
  readonly marketLossFraction: number | null;
  /** Loss on a fresh full-position executable sale versus actual remaining entry stake. */
  readonly capitalLossFraction: number | null;
  readonly deepLossHoldActive: boolean;
  readonly deepLossHoldKind: "none" | "recovery" | "terminal";
  readonly highRisk: boolean;
  readonly underlyingVelocityPerSecond: number | null;
  readonly adverseVelocityPerSecond: number | null;
  readonly adverseAccelerationPerSecond2: number | null;
  readonly projectedCrossingSeconds: number | null;
  readonly projectedCrossBeforeExpiry: boolean | null;
  /** True only when the shared target-crossing gate is satisfied. */
  readonly crossingRiskConfirmed: boolean;
  readonly targetAlreadyCrossed: boolean;
  readonly volatilityReachableBeforeExpiry: boolean | null;
  readonly estimatedSaleValue: number | null;
  readonly expectedHoldValue: number | null;
  readonly exitEdgePerContract: number | null;
  readonly liquidityCoverage: number | null;
  readonly executionEvidenceReady: boolean;
  readonly minimumWinningPrice: number | null;
  readonly maximumExecutionEvidenceAgeSeconds: number;
  readonly executionEvidenceExpiresAtSeconds: number | null;
  readonly degradedComponents: readonly string[];
  readonly nextState: SmartExitState;
}

export interface SmartExitEvaluationRecord {
  readonly id: string;
  readonly positionId: string;
  readonly owner: SmartExitOwnerKind;
  readonly tradingMode: SmartExitTradingMode;
  readonly symbol: string;
  readonly windowKey: string;
  readonly ticker: string;
  readonly side: BinarySide;
  readonly exchangeIndex: number | null;
  readonly remainingQuantity: number;
  readonly strikePrice: number;
  readonly secondsRemaining: number;
  readonly timestamp: string;
  readonly source: SmartExitEvidence["source"];
  readonly evidenceAgeMs: number | null;
  readonly spotReceiptAgeMs: number | null;
  readonly tapeReceiptAgeMs: number | null;
  readonly bookReceiptAgeMs: number | null;
  readonly spotAgeMs: number | null;
  readonly tapeAgeMs: number | null;
  readonly bookAgeMs: number | null;
  readonly underlyingPrice: number | null;
  readonly marketWinProbability: number | null;
  readonly marketAtEntryProbability: number;
  readonly modelWinProbability: number | null;
  readonly modelAtEntryProbability: number | null;
  readonly probabilityDrop: number | null;
  readonly threshold: number | null;
  readonly volatilityLogReturnPerSqrtSecond: number | null;
  readonly momentumLogReturn: number | null;
  readonly tradeFlowImbalance: number | null;
  readonly bookImbalance: number | null;
  readonly continuationScore: number | null;
  readonly recommendation: "off" | "hold" | "watch" | "prepare_exit" | "exit" | "unavailable";
  readonly riskStage: SmartExitRiskStage;
  readonly marketLossFraction: number | null;
  readonly capitalLossFraction: number | null;
  readonly deepLossHoldActive: boolean;
  readonly deepLossHoldKind: "none" | "recovery" | "terminal";
  readonly highRisk: boolean;
  readonly underlyingVelocityPerSecond: number | null;
  readonly adverseVelocityPerSecond: number | null;
  readonly adverseAccelerationPerSecond2: number | null;
  readonly projectedCrossingSeconds: number | null;
  readonly projectedCrossBeforeExpiry: boolean | null;
  readonly crossingRiskConfirmed: boolean;
  readonly targetAlreadyCrossed: boolean;
  readonly volatilityReachableBeforeExpiry: boolean | null;
  readonly marketBestBid: number | null;
  readonly marketBestAsk: number | null;
  readonly marketQuoteAgeMs: number | null;
  readonly marketBookAgeMs: number | null;
  readonly estimatedSaleValue: number | null;
  /** Actual remaining entry stake at evaluation time. */
  readonly entryStake: number | null;
  readonly expectedHoldValue: number | null;
  readonly exitEdgePerContract: number | null;
  readonly executableQuantity: number | null;
  readonly liquidityCoverage: number | null;
  readonly executionEvidenceReady: boolean;
  readonly minimumWinningPrice: number | null;
  readonly maximumExecutionEvidenceAgeSeconds: number;
  readonly executionEvidenceExpiresAtSeconds: number | null;
  readonly degradedComponents: readonly string[];
  readonly componentHealth: SmartExitComponentHealthMap;
  readonly reasonCode: string;
  readonly reason: string;
  readonly debounceProgress: number;
  readonly debounceTarget: number;
  readonly hysteresisUntil: string | null;
  readonly parameterVersion: string | null;
  readonly effectiveSensitivity: SmartExitSensitivity;
  readonly executed: boolean;
  readonly executionStatus: "not_requested" | "requested" | "filled" | "zero_fill" | "unknown" | "blocked";
  readonly recoveryStudy: {
    readonly observedOnly: true;
    readonly oppositeSideProbability: number | null;
    readonly marketEdgeAfterCosts: number | null;
    readonly qualifies: boolean;
    readonly reason: string;
  } | null;
}

export interface SmartExitHealth {
  readonly running: boolean;
  readonly schedulerActive: boolean;
  readonly mode: SmartExitMode;
  readonly dataReadiness: "ready" | "degraded" | "unavailable";
  readonly activeEvaluations: number;
  readonly lastCycleAt: string | null;
  readonly lastError: string | null;
  readonly lastCycleDurationMs: number | null;
  readonly schedulerOverruns: number;
  readonly targetCadenceMs: number;
  readonly evidenceBySymbol: Readonly<Record<string, {
    readonly source: SmartExitEvidence["source"];
    readonly ready: boolean;
    readonly reason: string | null;
    readonly observedAt: string | null;
  }>>;
}

export type SmartExitEffectivenessVerdict =
  | "saved_loss" | "reduced_profit" | "missed_win" | "no_difference" | "pending" | "unknown";

export interface SmartExitLifecycleRecord {
  readonly id: string;
  readonly owner: SmartExitOwnerKind;
  readonly positionId: string;
  readonly symbol: string;
  readonly windowKey: string;
  readonly ticker: string;
  readonly side: BinarySide;
  readonly tradingMode: SmartExitTradingMode;
  readonly quantity: number;
  readonly requestedQuantity?: number;
  readonly entryWinningPrice: number;
  readonly entryPriceCents?: number;
  readonly entryStake?: number;
  /** Frozen executable proceeds observed at a shadow trigger. */
  readonly simulatedExitProceeds?: number | null;
  readonly simulatedExitPnl?: number | null;
  readonly triggerEvaluationId: string;
  readonly triggeredAt: string;
  readonly advisoryOnly: boolean;
  readonly executionStatus: "advisory" | "requested" | "filled" | "zero_fill" | "blocked" | "unknown";
  readonly requestId: string | null;
  readonly soldAt: string | null;
  readonly winningFillPrice: number | null;
  readonly saleProceeds: number | null;
  readonly actualExitPnl: number | null;
  readonly settlementResult: BinarySide | null;
  readonly settledAt: string | null;
  readonly holdValue: number | null;
  readonly holdPnl: number | null;
  readonly valueSaved: number | null;
  readonly verdict: SmartExitEffectivenessVerdict;
  readonly reason: string | null;
}

export interface SmartExitCoverageRecord {
  readonly owner: SmartExitOwnerKind;
  readonly positionId: string;
  readonly symbol: string;
  readonly side: BinarySide;
  readonly evaluatedAt: string;
  readonly status: "triggered" | "evaluated" | "unavailable";
  readonly reasonCode: string;
  readonly reason: string;
  readonly entryPriceCents: number | null;
  readonly contractCount: number;
  readonly entryStake: number | null;
}

/** A shadow exit is economically scoreable only when the full position was executable. */
export function getSmartExitShadowProceeds(
  evaluation: Pick<SmartExitEvaluationRecord,
    "executionEvidenceReady" | "estimatedSaleValue" | "liquidityCoverage" | "remainingQuantity">,
  expectedQuantity: number,
): number | null {
  return evaluation.executionEvidenceReady
    && Number.isFinite(expectedQuantity)
    && expectedQuantity > 0
    && evaluation.liquidityCoverage !== null
    && evaluation.liquidityCoverage >= 1
    && evaluation.remainingQuantity === expectedQuantity
    && evaluation.estimatedSaleValue != null
    && Number.isFinite(evaluation.estimatedSaleValue)
    && evaluation.estimatedSaleValue >= 0
    ? evaluation.estimatedSaleValue
    : null;
}

export function isSmartExitCounterfactualScoreable(
  lifecycle: Pick<SmartExitLifecycleRecord, "advisoryOnly" | "executionStatus">,
): boolean {
  return lifecycle.advisoryOnly
    || lifecycle.executionStatus === "blocked"
    || lifecycle.executionStatus === "zero_fill";
}

export function computeSmartExitEffectivenessFromProceeds(params: {
  side: BinarySide;
  quantity: number;
  entryStake: number;
  exitProceeds: number | null;
  settlementResult: BinarySide | null;
}): Pick<SmartExitLifecycleRecord, "saleProceeds" | "actualExitPnl" | "holdValue" | "holdPnl" | "valueSaved" | "verdict"> {
  const saleProceeds = params.exitProceeds;
  const actualExitPnl = saleProceeds == null ? null : saleProceeds - params.entryStake;
  if (params.settlementResult == null || saleProceeds == null || actualExitPnl == null) {
    return { saleProceeds, actualExitPnl, holdValue: null, holdPnl: null, valueSaved: null, verdict: "pending" };
  }
  const won = params.settlementResult === params.side;
  const holdValue = won ? params.quantity : 0;
  const holdPnl = holdValue - params.entryStake;
  const valueSaved = actualExitPnl - holdPnl;
  const epsilon = 0.005;
  const verdict: SmartExitEffectivenessVerdict = Math.abs(valueSaved) < epsilon
    ? "no_difference"
    : valueSaved > 0
      ? won ? "reduced_profit" : "saved_loss"
      : won ? "missed_win" : "reduced_profit";
  return { saleProceeds, actualExitPnl, holdValue, holdPnl, valueSaved, verdict };
}

export function computeSmartExitEffectiveness(params: {
  side: BinarySide;
  quantity: number;
  entryWinningPrice: number;
  winningFillPrice: number | null;
  settlementResult: BinarySide | null;
}): Pick<SmartExitLifecycleRecord, "saleProceeds" | "actualExitPnl" | "holdValue" | "holdPnl" | "valueSaved" | "verdict"> {
  return computeSmartExitEffectivenessFromProceeds({
    side: params.side,
    quantity: params.quantity,
    entryStake: params.entryWinningPrice * params.quantity,
    exitProceeds: params.winningFillPrice == null ? null : params.winningFillPrice * params.quantity,
    settlementResult: params.settlementResult,
  });
}