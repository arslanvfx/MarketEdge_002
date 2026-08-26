/**
 * Data-only contracts for the Smart Exit policy.  These are deliberately
 * independent of Kalshi clients, persistence, and clocks: callers supply an
 * explicit `nowSeconds` and immutable market evidence.
 */

export type SmartExitMode = "off" | "shadow" | "paper-exit" | "live-exit";
export type BinarySide = "yes" | "no";
export type UnderlyingKind = "crypto" | "commodity" | "other";
export type SmartExitOwnerKind = "regular" | "scalper";
export type SmartExitTradingMode = "paper" | "live";

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
}

export interface SmartExitConfig {
  readonly enabled: boolean;
  readonly mode: SmartExitMode;
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
}

export interface SmartExitState {
  readonly adverseSampleCount: number;
  readonly holdUntilSeconds: number;
  readonly previousModelProbability: number | null;
  readonly previousObservedAtSeconds: number | null;
}

export type SmartExitDisposition = "OFF" | "HOLD" | "EXIT_SIGNAL" | "UNAVAILABLE";

export interface SmartExitDecision {
  readonly disposition: SmartExitDisposition;
  readonly reason: string;
  /** True only for a live-exit mode signal; this policy never submits orders. */
  readonly mayExecuteExit: boolean;
  readonly modelWinProbability: number | null;
  readonly probabilityDropFromEntry: number | null;
  readonly threshold: number | null;
  readonly continuationScore: number | null;
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
  readonly recommendation: "off" | "hold" | "exit" | "unavailable";
  readonly reasonCode: string;
  readonly reason: string;
  readonly debounceProgress: number;
  readonly debounceTarget: number;
  readonly hysteresisUntil: string | null;
  readonly parameterVersion: string | null;
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
  readonly evidenceBySymbol: Readonly<Record<string, {
    readonly source: SmartExitEvidence["source"];
    readonly ready: boolean;
    readonly reason: string | null;
    readonly observedAt: string | null;
  }>>;
}