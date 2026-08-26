import type {
  BinarySide,
  SmartExitConfig,
  SmartExitDecision,
  SmartExitEvidence,
  SmartExitPosition,
  SmartExitState,
} from "./kalshi-smart-exit-types.ts";

export const DEFAULT_SMART_EXIT_CONFIG: SmartExitConfig = Object.freeze({
  enabled: false,
  mode: "shadow",
  totalWindowSeconds: 900,
  maxEvidenceAgeSeconds: 3,
  minVolatilityLogReturnPerSqrtSecond: 0.000001,
  fatTailVolatilityMultiplier: 1.25,
  probabilityShrinkage: 0.15,
  baseProbabilityDropThreshold: 0.18,
  confirmationLevel: 0.35,
  debounceCount: 3,
  hysteresisSeconds: 3,
  hardStopProbabilityDrop: 0.30,
  hardStopWindowSeconds: 5,
  rapidLossRatio: 0.50,
  minExitEdge: 0.01,
  continuationWeights: Object.freeze({ momentum: 0.34, tradeFlow: 0.33, book: 0.33 }),
  appliedVersions: Object.freeze({}),
});

export const INITIAL_SMART_EXIT_STATE: SmartExitState = Object.freeze({
  adverseSampleCount: 0,
  holdUntilSeconds: 0,
  previousModelProbability: null,
  previousObservedAtSeconds: null,
  previousUnderlyingPrice: null,
  previousUnderlyingAtSeconds: null,
  previousAdverseVelocity: null,
});

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);

// Abramowitz-Stegun approximation; deterministic and dependency-free.
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)));
  return 0.5 * (1 + erf);
}

/** Calculates the conservative, side-aware probability of this position winning. */
export function modelWinProbability(
  position: SmartExitPosition,
  evidence: SmartExitEvidence,
  config: SmartExitConfig,
  nowSeconds: number,
): number | null {
  if (!finite(evidence.underlyingPrice) || !finite(evidence.volatilityLogReturnPerSqrtSecond)) return null;
  const remaining = position.expirySeconds - nowSeconds;
  if (remaining < 0 || evidence.underlyingPrice <= 0 || position.strikePrice <= 0) return null;
  // At the exact settlement second there is no future return interval to
  // invent. Resolve only from moneyness (an exact tie remains indeterminate).
  if (remaining === 0) {
    const raw = evidence.underlyingPrice === position.strikePrice
      ? 0.5
      : (position.side === "yes") === (evidence.underlyingPrice > position.strikePrice) ? 1 : 0;
    return clamp(0.5 + (raw - 0.5) * (1 - clamp(config.probabilityShrinkage, 0, 1)), 0, 1);
  }
  const sigma = Math.max(config.minVolatilityLogReturnPerSqrtSecond, evidence.volatilityLogReturnPerSqrtSecond);
  const denominator = sigma * Math.sqrt(remaining) * config.fatTailVolatilityMultiplier;
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const aboveProbability = normalCdf(Math.log(evidence.underlyingPrice / position.strikePrice) / denominator);
  const raw = position.side === "yes" ? aboveProbability : 1 - aboveProbability;
  return clamp(0.5 + (raw - 0.5) * (1 - clamp(config.probabilityShrinkage, 0, 1)), 0, 1);
}

export function probabilityDropThreshold(remainingSeconds: number, config: SmartExitConfig): number {
  return config.baseProbabilityDropThreshold * Math.sqrt(clamp(remainingSeconds, 0, config.totalWindowSeconds) / config.totalWindowSeconds);
}

/** Positive values always mean continuation adverse to the held YES/NO side. */
export function adverseContinuationScore(
  side: BinarySide,
  evidence: SmartExitEvidence,
  config: SmartExitConfig,
): number | null {
  const parts: Array<{ weight: number; value: number }> = [];
  if (
    finite(evidence.volatilityLogReturnPerSqrtSecond)
    && finite(evidence.momentumLogReturn)
    && finite(evidence.momentumWindowSeconds)
    && evidence.momentumWindowSeconds > 0
  ) {
    const sigma = Math.max(config.minVolatilityLogReturnPerSqrtSecond, evidence.volatilityLogReturnPerSqrtSecond);
    parts.push({
      weight: config.continuationWeights.momentum,
      value: evidence.momentumLogReturn / (sigma * Math.sqrt(evidence.momentumWindowSeconds)),
    });
  }
  if (finite(evidence.tradeFlowImbalance)) {
    parts.push({ weight: config.continuationWeights.tradeFlow, value: evidence.tradeFlowImbalance });
  }
  if (finite(evidence.bookImbalance)) {
    parts.push({ weight: config.continuationWeights.book, value: evidence.bookImbalance });
  }
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  if (totalWeight <= 0) return null;
  // A lower underlying hurts YES; a higher underlying hurts NO.
  const adverseSign = side === "yes" ? -1 : 1;
  return adverseSign * parts.reduce((sum, part) => sum + part.weight * part.value, 0) / totalWeight;
}

type DecisionMetrics = Omit<SmartExitDecision,
  "disposition" | "reason" | "mayExecuteExit" | "modelWinProbability"
  | "probabilityDropFromEntry" | "threshold" | "continuationScore" | "riskStage" | "nextState">;

function emptyMetrics(): DecisionMetrics {
  return {
    marketLossFraction: null,
    highRisk: false,
    underlyingVelocityPerSecond: null,
    adverseVelocityPerSecond: null,
    adverseAccelerationPerSecond2: null,
    projectedCrossingSeconds: null,
    projectedCrossBeforeExpiry: null,
    estimatedSaleValue: null,
    expectedHoldValue: null,
    exitEdgePerContract: null,
    liquidityCoverage: null,
    executionEvidenceReady: false,
    minimumWinningPrice: null,
    maximumExecutionEvidenceAgeSeconds: DEFAULT_SMART_EXIT_CONFIG.maxEvidenceAgeSeconds,
    executionEvidenceExpiresAtSeconds: null,
    degradedComponents: [],
  };
}

function unavailable(reason: string, state: SmartExitState, degradedComponents: readonly string[] = []): SmartExitDecision {
  return {
    disposition: "UNAVAILABLE", reason, mayExecuteExit: false,
    modelWinProbability: null, probabilityDropFromEntry: null, threshold: null,
    continuationScore: null, riskStage: "hold", nextState: state,
    ...emptyMetrics(), degradedComponents,
  };
}

function isFresh(receivedAt: number | null, now: number, maxAge: number): boolean {
  return receivedAt !== null && receivedAt <= now && now - receivedAt <= maxAge;
}

function evidenceProblem(position: SmartExitPosition, evidence: SmartExitEvidence, config: SmartExitConfig, now: number): string | null {
  if (position.underlyingKind === "commodity") return "commodity microstructure is unsupported";
  if (config.totalWindowSeconds <= 0 || config.minVolatilityLogReturnPerSqrtSecond <= 0 ||
      config.fatTailVolatilityMultiplier <= 0 || config.debounceCount < 1 ||
      config.rapidLossRatio <= 0 || config.rapidLossRatio > 1 || config.minExitEdge < 0) return "configuration is invalid";
  if (now - evidence.observedAtSeconds > config.maxEvidenceAgeSeconds || evidence.observedAtSeconds > now) return "evidence is stale or clock-invalid";
  if (!isFresh(evidence.spotReceivedAtSeconds, now, config.maxEvidenceAgeSeconds)) {
    return "spot transport is stale or unavailable";
  }
  if (!finite(evidence.underlyingPrice) || !finite(evidence.volatilityLogReturnPerSqrtSecond)) {
    return "spot or volatility evidence is missing";
  }
  if (evidence.underlyingPrice <= 0 || evidence.volatilityLogReturnPerSqrtSecond < 0) return "evidence is invalid";
  return null;
}

export function evaluateSmartExit(
  position: SmartExitPosition,
  evidence: SmartExitEvidence,
  state: SmartExitState,
  config: SmartExitConfig,
  nowSeconds: number,
): SmartExitDecision {
  if (!config.enabled || config.mode === "off") {
    return {
      disposition: "OFF", reason: "smart exit is disabled", mayExecuteExit: false,
      modelWinProbability: null, probabilityDropFromEntry: null, threshold: null,
      continuationScore: null, riskStage: "hold", nextState: state, ...emptyMetrics(),
    };
  }
  const problem = evidenceProblem(position, evidence, config, nowSeconds);
  if (problem) return unavailable(problem, state);
  const probability = modelWinProbability(position, evidence, config, nowSeconds);
  const continuation = adverseContinuationScore(position.side, evidence, config);
  if (probability === null) return unavailable("model inputs are unavailable", state);

  const modelEntryProbability = position.modelAtEntry.winProbability;
  const hasModelEntryBaseline = modelEntryProbability != null
    && Number.isFinite(modelEntryProbability)
    && modelEntryProbability >= 0
    && modelEntryProbability <= 1;
  const drop = hasModelEntryBaseline ? probability - modelEntryProbability : null;
  const threshold = probabilityDropThreshold(position.expirySeconds - nowSeconds, config);
  const elapsed = state.previousUnderlyingAtSeconds == null
    ? null
    : evidence.spotObservedAtSeconds == null
      ? null
      : evidence.spotObservedAtSeconds - state.previousUnderlyingAtSeconds;
  const velocity = elapsed != null && elapsed > 0 && state.previousUnderlyingPrice != null
    ? (evidence.underlyingPrice! - state.previousUnderlyingPrice) / elapsed
    : null;
  const adverseVelocity = velocity == null ? null : position.side === "yes" ? -velocity : velocity;
  const adverseAcceleration = adverseVelocity == null || state.previousAdverseVelocity == null || elapsed == null || elapsed <= 0
    ? null
    : (adverseVelocity - state.previousAdverseVelocity) / elapsed;
  const remaining = Math.max(0, position.expirySeconds - nowSeconds);
  const alreadyAcrossTarget = position.side === "yes"
    ? evidence.underlyingPrice! <= position.strikePrice
    : evidence.underlyingPrice! >= position.strikePrice;
  const targetDistance = Math.abs(evidence.underlyingPrice! - position.strikePrice);
  const projectedCrossingSeconds = alreadyAcrossTarget
    ? 0
    : adverseVelocity != null && adverseVelocity > 0
      ? targetDistance / adverseVelocity
      : null;
  const projectedCrossBeforeExpiry = projectedCrossingSeconds == null
    ? null
    : projectedCrossingSeconds <= remaining;
  const entryMarket = position.marketAtEntry.winProbability;
  const marketLossFraction = finite(evidence.marketWinProbability) && entryMarket > 0
    ? clamp((entryMarket - evidence.marketWinProbability) / entryMarket, 0, 1)
    : null;
  const highRisk = marketLossFraction != null && marketLossFraction >= config.rapidLossRatio;
  const quantity = Math.max(0, position.remainingQuantity);
  const estimatedSaleValue = finite(evidence.marketExecutablePrice)
    ? evidence.marketExecutablePrice * quantity : null;
  const expectedHoldValue = probability * quantity;
  const exitEdge = finite(evidence.marketExecutablePrice)
    ? evidence.marketExecutablePrice - probability : null;
  const liquidityCoverage = finite(evidence.marketExecutableQuantity) && quantity > 0
    ? evidence.marketExecutableQuantity / quantity : null;
  const minimumWinningPrice = probability + config.minExitEdge < 1
    ? Math.ceil((probability + config.minExitEdge) * 100) / 100
    : null;
  const mandatoryExecutionTimes = [
    evidence.spotReceivedAtSeconds,
    evidence.marketQuoteObservedAtSeconds,
    evidence.marketBookObservedAtSeconds,
  ];
  const executionEvidenceExpiresAtSeconds = mandatoryExecutionTimes.every((at) => at !== null)
    ? Math.min(...mandatoryExecutionTimes as number[]) + config.maxEvidenceAgeSeconds
    : null;
  const quoteFresh = isFresh(evidence.marketQuoteObservedAtSeconds, nowSeconds, config.maxEvidenceAgeSeconds);
  const marketBookFresh = isFresh(evidence.marketBookObservedAtSeconds, nowSeconds, config.maxEvidenceAgeSeconds);
  const executionEvidenceReady = quoteFresh && marketBookFresh
    && finite(evidence.marketExecutablePrice) && evidence.marketExecutablePrice > 0
    && minimumWinningPrice !== null && evidence.marketExecutablePrice + 1e-9 >= minimumWinningPrice
    && liquidityCoverage !== null && liquidityCoverage >= 1;
  const degradedComponents: string[] = [];
  if (!isFresh(evidence.tapeReceivedAtSeconds, nowSeconds, config.maxEvidenceAgeSeconds)) degradedComponents.push("coinbase_tape");
  if (!isFresh(evidence.bookReceivedAtSeconds, nowSeconds, config.maxEvidenceAgeSeconds)) degradedComponents.push("coinbase_book");
  if (!quoteFresh) degradedComponents.push("kalshi_quote");
  if (!marketBookFresh) degradedComponents.push("kalshi_book");
  if (!finite(evidence.tradeFlowImbalance)) degradedComponents.push("trade_flow");
  if (!finite(evidence.bookImbalance)) degradedComponents.push("book_imbalance");
  if (!hasModelEntryBaseline) degradedComponents.push("model_entry_baseline");
  const common = {
    modelWinProbability: probability,
    probabilityDropFromEntry: drop,
    threshold,
    continuationScore: continuation,
    marketLossFraction,
    highRisk,
    underlyingVelocityPerSecond: velocity,
    adverseVelocityPerSecond: adverseVelocity,
    adverseAccelerationPerSecond2: adverseAcceleration,
    projectedCrossingSeconds,
    projectedCrossBeforeExpiry,
    estimatedSaleValue,
    expectedHoldValue,
    exitEdgePerContract: exitEdge,
    liquidityCoverage,
    executionEvidenceReady,
    minimumWinningPrice,
    maximumExecutionEvidenceAgeSeconds: config.maxEvidenceAgeSeconds,
    executionEvidenceExpiresAtSeconds,
    degradedComponents,
  };
  const nextBase: SmartExitState = {
    adverseSampleCount: 0, holdUntilSeconds: state.holdUntilSeconds,
    previousModelProbability: probability, previousObservedAtSeconds: evidence.observedAtSeconds,
    previousUnderlyingPrice: evidence.underlyingPrice,
    previousUnderlyingAtSeconds: evidence.spotObservedAtSeconds,
    previousAdverseVelocity: adverseVelocity,
  };
  const fastDrop = state.previousModelProbability !== null && state.previousObservedAtSeconds !== null &&
    evidence.observedAtSeconds >= state.previousObservedAtSeconds &&
    evidence.observedAtSeconds - state.previousObservedAtSeconds <= config.hardStopWindowSeconds &&
    probability - state.previousModelProbability <= -config.hardStopProbabilityDrop;
  const economicExit = minimumWinningPrice !== null
    && evidence.marketExecutablePrice !== null
    && evidence.marketExecutablePrice + 1e-9 >= minimumWinningPrice;
  const continuationAdverse = continuation !== null && continuation >= config.confirmationLevel;
  const collapseExit = highRisk && economicExit && (
    projectedCrossBeforeExpiry === true
    || continuationAdverse
    || (evidence.marketWinProbability != null && evidence.marketWinProbability <= 0.25)
  );
  const mayExecute = config.mode === "live-exit" && executionEvidenceReady;
  if (collapseExit || (fastDrop && economicExit)) {
    return {
      disposition: "EXIT_SIGNAL",
      reason: collapseExit ? "rapid value loss with adverse crossing risk; selling dominates hold value" : "catastrophic probability drop; selling dominates hold value",
      mayExecuteExit: mayExecute, riskStage: "exit", nextState: nextBase, ...common,
    };
  }
  if (highRisk || fastDrop) {
    return {
      disposition: "PREPARE_EXIT",
      reason: economicExit
        ? "rapid loss detected; awaiting adverse crossing confirmation"
        : "rapid loss detected; current executable sale does not beat hold value",
      mayExecuteExit: false, riskStage: "prepare_exit", nextState: nextBase, ...common,
    };
  }
  if (nowSeconds < state.holdUntilSeconds) {
    return {
      disposition: "HOLD", reason: "hysteresis active", mayExecuteExit: false,
      riskStage: "hold", nextState: nextBase, ...common,
    };
  }
  const adverse = drop !== null && drop < -threshold && continuationAdverse;
  const count = adverse ? state.adverseSampleCount + 1 : 0;
  const nextState: SmartExitState = { ...nextBase, adverseSampleCount: count, holdUntilSeconds: adverse ? state.holdUntilSeconds : nowSeconds + config.hysteresisSeconds };
  if (adverse && count >= config.debounceCount) {
    if (economicExit) {
      return {
        disposition: "EXIT_SIGNAL", reason: "confirmed adverse probability decay; selling dominates hold value",
        mayExecuteExit: mayExecute, riskStage: "exit", nextState, ...common,
      };
    }
    return {
      disposition: "PREPARE_EXIT", reason: "adverse decay confirmed but current executable sale does not beat hold value",
      mayExecuteExit: false, riskStage: "prepare_exit", nextState, ...common,
    };
  }
  const watch = (marketLossFraction != null && marketLossFraction >= 0.25) || adverse;
  return {
    disposition: watch ? "WATCH" : "HOLD",
    reason: adverse ? "awaiting debounce confirmation" : watch ? "value deterioration under review" : "within tolerance or unconfirmed",
    mayExecuteExit: false, riskStage: watch ? "watch" : "hold", nextState, ...common,
  };
}