import type {
  BinarySide,
  SmartExitConfig,
  SmartExitDecision,
  SmartExitEvidence,
  SmartExitPosition,
  SmartExitSensitivity,
  SmartExitState,
} from "./kalshi-smart-exit-types.ts";

export interface SmartExitSensitivityParameters {
  readonly debounceCount: number;
  readonly confirmationLevel: number;
  readonly minMarketLossFraction: number;
  readonly crossingReserveFraction: number;
}

const SMART_EXIT_SENSITIVITY_PRESETS: Readonly<Record<SmartExitSensitivity, SmartExitSensitivityParameters>> =
  Object.freeze({
    more_aggressive: Object.freeze({
      debounceCount: 2, confirmationLevel: 0.20,
      minMarketLossFraction: 0.15, crossingReserveFraction: 0.10,
    }),
    default: Object.freeze({
      debounceCount: 3, confirmationLevel: 0.35,
      minMarketLossFraction: 0.25, crossingReserveFraction: 0.20,
    }),
    less_aggressive: Object.freeze({
      debounceCount: 4, confirmationLevel: 0.50,
      minMarketLossFraction: 0.35, crossingReserveFraction: 0.30,
    }),
  });

/** Canonical immutable resolver. Unknown persisted values safely fall back to Default. */
export function resolveSmartExitSensitivity(value: unknown): Readonly<{
  sensitivity: SmartExitSensitivity;
  parameters: SmartExitSensitivityParameters;
}> {
  const sensitivity: SmartExitSensitivity =
    value === "more_aggressive" || value === "less_aggressive" || value === "default"
      ? value : "default";
  return Object.freeze({ sensitivity, parameters: SMART_EXIT_SENSITIVITY_PRESETS[sensitivity] });
}

export const DEFAULT_SMART_EXIT_CONFIG: SmartExitConfig = Object.freeze({
  enabled: false,
  mode: "shadow",
  sensitivity: "default",
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
  deepLossHoldThreshold: 0.80,
  terminalLossHoldThreshold: 0.90,
  deepLossRecoveryMinSeconds: 210,
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
export const SMART_EXIT_MAX_SUSTAINED_SAMPLE_GAP_SECONDS = 2.5;

export interface SmartExitCrossingRiskInput {
  readonly side: BinarySide;
  readonly underlyingPrice: number;
  readonly strikePrice: number;
  readonly remainingSeconds: number;
  readonly volatilityLogReturnPerSqrtSecond: number;
  readonly minVolatilityLogReturnPerSqrtSecond: number;
  readonly fatTailVolatilityMultiplier: number;
  readonly adverseVelocityPerSecond: number | null;
  readonly adverseAccelerationPerSecond2: number | null;
  readonly continuationScore: number | null;
  readonly confirmationLevel: number;
  readonly previousDirectionalCount: number;
  readonly sampleElapsedSeconds: number | null;
  readonly debounceCount: number;
  readonly crossingReserveFraction?: number;
  readonly minCrossingReserveSeconds?: number;
  readonly maxCrossingReserveSeconds?: number;
  readonly maxSampleGapSeconds?: number;
}

export interface SmartExitCrossingRisk {
  readonly targetAlreadyCrossed: boolean;
  readonly projectedCrossingSeconds: number | null;
  readonly projectedCrossBeforeExpiry: boolean | null;
  readonly volatilityReachableBeforeExpiry: boolean;
  readonly directionalCount: number;
  readonly crossingTrajectoryPlausible: boolean;
  readonly crossingRiskConfirmed: boolean;
}

export interface SmartExitDeepLossInput {
  readonly capitalLossFraction: number | null;
  readonly remainingSeconds: number;
  readonly recoveryReachable: boolean;
  readonly deepLossHoldThreshold: number;
  readonly terminalLossHoldThreshold: number;
  readonly recoveryMinSeconds: number;
}

export interface SmartExitDeepLossAssessment {
  readonly hold: boolean;
  readonly kind: "none" | "recovery" | "terminal";
}

/** Shared by live policy and replay so deep-loss handling cannot drift. */
export function assessSmartExitDeepLossHold(
  input: SmartExitDeepLossInput,
): SmartExitDeepLossAssessment {
  const loss = input.capitalLossFraction;
  if (loss == null || !Number.isFinite(loss)) return { hold: false, kind: "none" };
  if (loss + 1e-9 >= input.terminalLossHoldThreshold) {
    return { hold: true, kind: "terminal" };
  }
  if (
    loss + 1e-9 >= input.deepLossHoldThreshold
    && input.remainingSeconds + 1e-9 >= input.recoveryMinSeconds
    && input.recoveryReachable
  ) {
    return { hold: true, kind: "recovery" };
  }
  return { hold: false, kind: "none" };
}

/** The sole target-crossing projection used by both live policy and replay. */
export function assessSmartExitCrossingRisk(input: SmartExitCrossingRiskInput): SmartExitCrossingRisk {
  const remaining = Math.max(0, input.remainingSeconds);
  const targetAlreadyCrossed = input.side === "yes"
    ? input.underlyingPrice <= input.strikePrice
    : input.underlyingPrice >= input.strikePrice;
  const targetDistance = Math.abs(input.underlyingPrice - input.strikePrice);
  const decelerationLookahead = Math.min(5, Math.max(1, remaining * 0.1));
  const conservativeAdverseVelocity = input.adverseVelocityPerSecond != null
    && input.adverseVelocityPerSecond > 0
    ? input.adverseAccelerationPerSecond2 != null && input.adverseAccelerationPerSecond2 < 0
      ? Math.max(
          0,
          input.adverseVelocityPerSecond
            + input.adverseAccelerationPerSecond2 * decelerationLookahead,
        )
      : input.adverseVelocityPerSecond
    : null;
  const projectedCrossingSeconds = targetAlreadyCrossed
    ? 0
    : conservativeAdverseVelocity != null && conservativeAdverseVelocity > 0
      ? targetDistance / conservativeAdverseVelocity
      : null;
  const projectedCrossBeforeExpiry = projectedCrossingSeconds == null
    ? null
    : projectedCrossingSeconds <= remaining;
  const logTargetDistance = Math.abs(Math.log(input.underlyingPrice / input.strikePrice));
  const volatilityReach = Math.max(
    input.minVolatilityLogReturnPerSqrtSecond,
    input.volatilityLogReturnPerSqrtSecond,
  ) * Math.sqrt(remaining) * input.fatTailVolatilityMultiplier;
  const volatilityReachableBeforeExpiry = remaining > 0
    ? logTargetDistance <= volatilityReach
    : targetAlreadyCrossed;
  const continuationAdverse = input.continuationScore !== null
    && input.continuationScore >= input.confirmationLevel;
  const maxGap = input.maxSampleGapSeconds
    ?? SMART_EXIT_MAX_SUSTAINED_SAMPLE_GAP_SECONDS;
  const sustainedAdverseSample = input.adverseVelocityPerSecond !== null
    && input.adverseVelocityPerSecond > 0
    && continuationAdverse
    && input.sampleElapsedSeconds !== null
    && input.sampleElapsedSeconds > 0
    && input.sampleElapsedSeconds <= maxGap;
  const directionalCount = sustainedAdverseSample
    ? input.previousDirectionalCount + 1
    : 0;
  const crossingReserveSeconds = Math.min(
    input.maxCrossingReserveSeconds ?? 30,
    Math.max(
      input.minCrossingReserveSeconds ?? 5,
      remaining * (input.crossingReserveFraction ?? 0.2),
    ),
  );
  const actionableCrossingHorizon = Math.max(0, remaining - crossingReserveSeconds);
  const crossingTrajectoryPlausible = targetAlreadyCrossed || (
    projectedCrossingSeconds !== null
    && projectedCrossingSeconds <= actionableCrossingHorizon
    && volatilityReachableBeforeExpiry
  );
  const crossingRiskConfirmed = targetAlreadyCrossed || (
    crossingTrajectoryPlausible
    && directionalCount >= input.debounceCount
    && continuationAdverse
    && (
      input.adverseAccelerationPerSecond2 === null
      || input.adverseAccelerationPerSecond2 >= 0
      || projectedCrossingSeconds! <= actionableCrossingHorizon / 2
    )
  );
  return {
    targetAlreadyCrossed,
    projectedCrossingSeconds,
    projectedCrossBeforeExpiry,
    volatilityReachableBeforeExpiry,
    directionalCount,
    crossingTrajectoryPlausible,
    crossingRiskConfirmed,
  };
}

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
    capitalLossFraction: null,
    deepLossHoldActive: false,
    deepLossHoldKind: "none",
    highRisk: false,
    underlyingVelocityPerSecond: null,
    adverseVelocityPerSecond: null,
    adverseAccelerationPerSecond2: null,
    projectedCrossingSeconds: null,
    projectedCrossBeforeExpiry: null,
    crossingRiskConfirmed: false,
    targetAlreadyCrossed: false,
    volatilityReachableBeforeExpiry: null,
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
      config.deepLossHoldThreshold < 0 || config.deepLossHoldThreshold > 1 ||
      config.terminalLossHoldThreshold < config.deepLossHoldThreshold ||
      config.terminalLossHoldThreshold > 1 || config.deepLossRecoveryMinSeconds < 0 ||
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
  const sensitivity = resolveSmartExitSensitivity(config.sensitivity);
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
  const crossingRisk = assessSmartExitCrossingRisk({
    side: position.side,
    underlyingPrice: evidence.underlyingPrice!,
    strikePrice: position.strikePrice,
    remainingSeconds: remaining,
    volatilityLogReturnPerSqrtSecond: evidence.volatilityLogReturnPerSqrtSecond!,
    minVolatilityLogReturnPerSqrtSecond: config.minVolatilityLogReturnPerSqrtSecond,
    fatTailVolatilityMultiplier: config.fatTailVolatilityMultiplier,
    adverseVelocityPerSecond: adverseVelocity,
    adverseAccelerationPerSecond2: adverseAcceleration,
    continuationScore: continuation,
    confirmationLevel: sensitivity.parameters.confirmationLevel,
    previousDirectionalCount: state.adverseSampleCount,
    sampleElapsedSeconds: elapsed,
    debounceCount: sensitivity.parameters.debounceCount,
    crossingReserveFraction: resolveSmartExitSensitivity(config.sensitivity).parameters.crossingReserveFraction,
  });
  const {
    targetAlreadyCrossed: alreadyAcrossTarget,
    projectedCrossingSeconds,
    projectedCrossBeforeExpiry,
    volatilityReachableBeforeExpiry,
    directionalCount,
    crossingTrajectoryPlausible,
    crossingRiskConfirmed,
  } = crossingRisk;
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
  const fullSaleEvidenceReady = quoteFresh && marketBookFresh
    && finite(evidence.marketExecutablePrice) && evidence.marketExecutablePrice > 0
    && liquidityCoverage !== null && liquidityCoverage >= 1;
  const executionEvidenceReady = fullSaleEvidenceReady
    && minimumWinningPrice !== null && evidence.marketExecutablePrice + 1e-9 >= minimumWinningPrice
  const capitalLossFraction = fullSaleEvidenceReady
    && estimatedSaleValue !== null
    && Number.isFinite(position.entryStake)
    && position.entryStake > 0
    ? clamp((position.entryStake - estimatedSaleValue) / position.entryStake, 0, 1)
    : null;
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
    capitalLossFraction,
    deepLossHoldActive: false,
    deepLossHoldKind: "none" as const,
    highRisk,
    underlyingVelocityPerSecond: velocity,
    adverseVelocityPerSecond: adverseVelocity,
    adverseAccelerationPerSecond2: adverseAcceleration,
    projectedCrossingSeconds,
    projectedCrossBeforeExpiry,
    crossingRiskConfirmed: false,
    targetAlreadyCrossed: alreadyAcrossTarget,
    volatilityReachableBeforeExpiry,
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
  const fastDrop = state.previousModelProbability !== null && state.previousObservedAtSeconds !== null &&
    evidence.observedAtSeconds >= state.previousObservedAtSeconds &&
    evidence.observedAtSeconds - state.previousObservedAtSeconds <= config.hardStopWindowSeconds &&
    probability - state.previousModelProbability <= -config.hardStopProbabilityDrop;
  const economicExit = minimumWinningPrice !== null
    && evidence.marketExecutablePrice !== null
    && evidence.marketExecutablePrice + 1e-9 >= minimumWinningPrice;
  const continuationAdverse = continuation !== null
    && continuation >= sensitivity.parameters.confirmationLevel;
  const sustainedAdverseSample = directionalCount > 0;
  const nextBase: SmartExitState = {
    adverseSampleCount: directionalCount,
    holdUntilSeconds: state.holdUntilSeconds,
    previousModelProbability: probability,
    previousObservedAtSeconds: evidence.observedAtSeconds,
    previousUnderlyingPrice: evidence.underlyingPrice,
    previousUnderlyingAtSeconds: evidence.spotObservedAtSeconds,
    previousAdverseVelocity: adverseVelocity,
  };
  const shared = { ...common, crossingRiskConfirmed };
  const probabilityDeteriorated = drop !== null && drop < -threshold;
  const marketDeteriorated = marketLossFraction !== null
    && marketLossFraction >= sensitivity.parameters.minMarketLossFraction;
  const meaningfulDeterioration = alreadyAcrossTarget
    || probabilityDeteriorated || fastDrop || highRisk || marketDeteriorated;
  const exitReady = crossingRiskConfirmed
    && meaningfulDeterioration
    && (alreadyAcrossTarget || marketDeteriorated)
    && economicExit
    && executionEvidenceReady;
  const mayExecute = config.mode === "live-exit" && executionEvidenceReady;
  if (exitReady) {
    const deepLossHold = assessSmartExitDeepLossHold({
      capitalLossFraction,
      remainingSeconds: remaining,
      recoveryReachable: volatilityReachableBeforeExpiry,
      deepLossHoldThreshold: config.deepLossHoldThreshold,
      terminalLossHoldThreshold: config.terminalLossHoldThreshold,
      recoveryMinSeconds: config.deepLossRecoveryMinSeconds,
    });
    if (deepLossHold.hold) {
      return {
        disposition: "HOLD",
        reason: deepLossHold.kind === "terminal"
          ? "90%+ capital loss protection blocked an otherwise eligible exit — leave position to resolve"
          : "80–90% capital loss protection blocked an otherwise eligible exit — target remains reachable with at least 3:30 remaining",
        mayExecuteExit: false,
        riskStage: "hold",
        nextState: nextBase,
        ...shared,
        deepLossHoldActive: true,
        deepLossHoldKind: deepLossHold.kind,
      };
    }
    return {
      disposition: "EXIT_SIGNAL",
      reason: alreadyAcrossTarget
        ? "target crossed with fresh full-liquidity sale evidence"
        : "sustained adverse move can cross target before expiry; fresh full-liquidity sale dominates hold value",
      mayExecuteExit: mayExecute, riskStage: "exit", nextState: nextBase, ...shared,
    };
  }
  if (meaningfulDeterioration && crossingTrajectoryPlausible) {
    return {
      disposition: "PREPARE_EXIT",
      reason: !crossingRiskConfirmed
        ? "adverse move is near enough to threaten the target; awaiting sustained direction"
        : !executionEvidenceReady
          ? "crossing risk confirmed; awaiting fresh full-position executable liquidity"
          : !economicExit
            ? "crossing risk confirmed; current executable sale does not beat hold value"
            : "crossing risk confirmed; awaiting material Kalshi deterioration",
      mayExecuteExit: false, riskStage: "prepare_exit", nextState: nextBase, ...shared,
    };
  }
  if (nowSeconds < state.holdUntilSeconds) {
    return {
      disposition: "HOLD", reason: "hysteresis active", mayExecuteExit: false,
      riskStage: "hold", nextState: nextBase, ...shared,
    };
  }
  const nextState: SmartExitState = {
    ...nextBase,
    holdUntilSeconds: sustainedAdverseSample
      ? state.holdUntilSeconds
      : nowSeconds + config.hysteresisSeconds,
  };
  const watch = marketDeteriorated || probabilityDeteriorated || fastDrop || highRisk || sustainedAdverseSample;
  return {
    disposition: watch ? "WATCH" : "HOLD",
    reason: crossingTrajectoryPlausible
      ? "crossing trajectory is forming but deterioration is not yet actionable"
      : marketDeteriorated || highRisk
        ? "Kalshi repricing is under review; underlying target crossing is not plausible"
        : sustainedAdverseSample
          ? "adverse movement remains too far from target to justify preparing an exit"
          : "within tolerance or unconfirmed",
    mayExecuteExit: false, riskStage: watch ? "watch" : "hold", nextState, ...shared,
  };
}