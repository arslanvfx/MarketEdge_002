import type {
  BinarySide,
  SmartExitConfig,
  SmartExitDecision,
  SmartExitEvidence,
  SmartExitPosition,
  SmartExitSensitivity,
  SmartExitState,
  SmartExitTimeBand,
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
  marketAdverseSampleCount: 0,
  holdUntilSeconds: 0,
  previousModelProbability: null,
  previousObservedAtSeconds: null,
  previousMarketWinProbability: null,
  previousMarketObservedAtSeconds: null,
  previousUnderlyingPrice: null,
  previousUnderlyingAtSeconds: null,
  previousAdverseVelocity: null,
  trajectorySamples: Object.freeze([]),
  adverseLatchUntilSeconds: 0,
  adverseExcursionFraction: 0,
  adverseRecoverySampleCount: 0,
  latchedAdverseVelocityPerSecond: null,
  latchedAdverseAccelerationPerSecond2: null,
});

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);
export const SMART_EXIT_MAX_SUSTAINED_SAMPLE_GAP_SECONDS = 2.5;

export interface SmartExitTimeBandParameters {
  readonly band: SmartExitTimeBand;
  readonly minimumDistanceFraction: number;
  readonly volatilityReachMultiplier: number;
  readonly underlyingConfirmationCount: number;
  readonly marketConfirmationCount: number;
  readonly minimumMarketLossFraction: number;
  readonly minimumAdverseExcursionFraction: number;
  readonly adverseLatchSeconds: number;
}

/**
 * Exact remaining-time bands for a 15-minute market. Entries may happen at
 * different times, so elapsed time is deliberately never inferred.
 */
export function resolveSmartExitTimeBand(remainingSeconds: number): SmartExitTimeBandParameters {
  const remaining = Math.max(0, remainingSeconds);
  if (remaining > 240) {
    return {
      band: "monitor", minimumDistanceFraction: 0.0025,
      volatilityReachMultiplier: 1.25, underlyingConfirmationCount: 4,
      marketConfirmationCount: 2, minimumMarketLossFraction: 0.35,
      minimumAdverseExcursionFraction: 0.0035, adverseLatchSeconds: 4,
    };
  }
  if (remaining > 180) {
    return {
      band: "escalation", minimumDistanceFraction: 0.0015,
      volatilityReachMultiplier: 0.75, underlyingConfirmationCount: 3,
      marketConfirmationCount: 2, minimumMarketLossFraction: 0.20,
      minimumAdverseExcursionFraction: 0.002, adverseLatchSeconds: 6,
    };
  }
  if (remaining > 60) {
    return {
      band: "urgent", minimumDistanceFraction: 0.00075,
      volatilityReachMultiplier: 0.35, underlyingConfirmationCount: 2,
      marketConfirmationCount: 2, minimumMarketLossFraction: 0.10,
      minimumAdverseExcursionFraction: 0.00075, adverseLatchSeconds: 8,
    };
  }
  return {
    band: "critical", minimumDistanceFraction: 0,
    volatilityReachMultiplier: 0, underlyingConfirmationCount: 1,
    marketConfirmationCount: 1, minimumMarketLossFraction: 0.05,
    minimumAdverseExcursionFraction: 0.0002, adverseLatchSeconds: 10,
  };
}

export interface SmartExitMarketDirectionAssessment {
  readonly direction: "adverse" | "recovering" | "flat" | "unknown";
  readonly probabilityDelta: number | null;
  readonly adverseSlopePerSecond: number | null;
  readonly sampleCount: number;
  readonly confirmed: boolean;
}

/** Current and previous values are both held-side winning probabilities. */
export function assessSmartExitMarketDirection(input: {
  readonly currentProbability: number | null;
  readonly currentObservedAtSeconds: number | null;
  readonly previousProbability: number | null | undefined;
  readonly previousObservedAtSeconds: number | null | undefined;
  readonly previousSampleCount: number | undefined;
  readonly maximumGapSeconds: number;
  readonly requiredSampleCount: number;
  readonly marketLossFraction: number | null;
  readonly minimumMarketLossFraction: number;
}): SmartExitMarketDirectionAssessment {
  const current = input.currentProbability;
  const previous = input.previousProbability;
  const currentAt = input.currentObservedAtSeconds;
  const previousAt = input.previousObservedAtSeconds;
  if (!finite(current) || current < 0 || current > 1
      || !finite(previous ?? null) || previous! < 0 || previous! > 1
      || !finite(currentAt) || !finite(previousAt ?? null)) {
    return {
      direction: "unknown", probabilityDelta: null, adverseSlopePerSecond: null,
      sampleCount: 0, confirmed: false,
    };
  }
  const elapsed = currentAt - previousAt!;
  const epsilon = 0.001;
  if (elapsed === 0 && Math.abs(current - previous!) <= epsilon) {
    const sampleCount = Math.max(0, input.previousSampleCount ?? 0);
    return {
      direction: "flat",
      probabilityDelta: current - previous!,
      adverseSlopePerSecond: 0,
      sampleCount,
      confirmed: false,
    };
  }
  if (elapsed <= 0 || elapsed > input.maximumGapSeconds) {
    return {
      direction: "unknown", probabilityDelta: null, adverseSlopePerSecond: null,
      sampleCount: 0, confirmed: false,
    };
  }
  const probabilityDelta = current - previous!;
  const adverseSlopePerSecond = -probabilityDelta / elapsed;
  const direction = probabilityDelta < -epsilon
    ? "adverse" as const
    : probabilityDelta > epsilon ? "recovering" as const : "flat" as const;
  const previousSampleCount = Math.max(0, input.previousSampleCount ?? 0);
  const sampleCount = direction === "adverse"
    ? previousSampleCount + 1
    : direction === "flat" ? Math.max(0, previousSampleCount - 1) : 0;
  const decisiveCollapse = direction === "adverse"
    && input.marketLossFraction !== null
    && input.marketLossFraction >= Math.max(0.50, input.minimumMarketLossFraction * 2);
  return {
    direction,
    probabilityDelta,
    adverseSlopePerSecond,
    sampleCount,
    confirmed: direction === "adverse"
      && (sampleCount >= input.requiredSampleCount || decisiveCollapse)
      && input.marketLossFraction !== null
      && input.marketLossFraction >= input.minimumMarketLossFraction,
  };
}

export interface SmartExitTrajectoryAssessment {
  readonly samples: SmartExitState["trajectorySamples"];
  readonly distinctSampleAdded: boolean;
  readonly sampleElapsedSeconds: number | null;
  readonly velocityPerSecond: number | null;
  readonly adverseVelocityPerSecond: number | null;
  readonly adverseAccelerationPerSecond2: number | null;
  readonly adverseExcursionFraction: number;
  readonly adverseLatchActive: boolean;
  readonly adverseLatchUntilSeconds: number;
  readonly recoveryProgress: number;
}

/**
 * Advances a bounded event-time trajectory. Repeated prices/timestamps preserve
 * a recent adverse move without manufacturing another directional sample.
 */
export function assessSmartExitTrajectory(input: {
  readonly side: BinarySide;
  readonly strikePrice: number;
  readonly price: number;
  readonly observedAtSeconds: number | null;
  readonly nowSeconds: number;
  readonly remainingSeconds: number;
  readonly previousState: SmartExitState;
  readonly maximumEventAgeSeconds: number;
}): SmartExitTrajectoryAssessment {
  const previous = input.previousState;
  const parameters = resolveSmartExitTimeBand(input.remainingSeconds);
  const valid = finite(input.observedAtSeconds)
    && finite(input.price)
    && input.price > 0
    && input.strikePrice > 0
    && input.observedAtSeconds <= input.nowSeconds
    && input.nowSeconds - input.observedAtSeconds <= input.maximumEventAgeSeconds;
  if (!valid) {
    return {
      samples: [],
      distinctSampleAdded: false,
      sampleElapsedSeconds: null,
      velocityPerSecond: null,
      adverseVelocityPerSecond: null,
      adverseAccelerationPerSecond2: null,
      adverseExcursionFraction: 0,
      adverseLatchActive: false,
      adverseLatchUntilSeconds: 0,
      recoveryProgress: 0,
    };
  }

  const observedAt = input.observedAtSeconds!;
  let samples = [...(previous.trajectorySamples ?? [])]
    .filter((sample) => finite(sample.observedAtSeconds)
      && finite(sample.price) && sample.price > 0
      && sample.observedAtSeconds >= observedAt - 12
      && sample.observedAtSeconds <= observedAt)
    .sort((a, b) => a.observedAtSeconds - b.observedAtSeconds)
    .slice(-23);
  if (
    samples.length === 0
    && finite(previous.previousUnderlyingAtSeconds)
    && finite(previous.previousUnderlyingPrice)
    && previous.previousUnderlyingPrice > 0
    && previous.previousUnderlyingAtSeconds < observedAt
    && observedAt - previous.previousUnderlyingAtSeconds
      <= SMART_EXIT_MAX_SUSTAINED_SAMPLE_GAP_SECONDS
  ) {
    samples.push({
      observedAtSeconds: previous.previousUnderlyingAtSeconds,
      price: previous.previousUnderlyingPrice,
    });
  }
  const priorLast = samples.at(-1);
  const gap = priorLast == null ? null : observedAt - priorLast.observedAtSeconds;
  if (gap !== null && gap > SMART_EXIT_MAX_SUSTAINED_SAMPLE_GAP_SECONDS) samples = [];
  const last = samples.at(-1);
  const sameEvent = last != null
    && last.observedAtSeconds === observedAt
    && Math.abs(last.price - input.price) <= Math.max(1e-12, input.price * 1e-12);
  const samePrice = last != null
    && Math.abs(last.price - input.price) <= Math.max(1e-12, input.price * 1e-12);
  const distinctSampleAdded = !sameEvent && !samePrice
    && (last == null || observedAt > last.observedAtSeconds);
  if (distinctSampleAdded) {
    samples.push({ observedAtSeconds: observedAt, price: input.price });
    samples = samples.slice(-24);
  } else if (samples.length === 0) {
    samples.push({ observedAtSeconds: observedAt, price: input.price });
  }

  const current = samples.at(-1)!;
  const previousDistinct = samples.at(-2);
  const beforePrevious = samples.at(-3);
  const sampleElapsedSeconds = previousDistinct == null
    ? null : current.observedAtSeconds - previousDistinct.observedAtSeconds;
  const velocityPerSecond = sampleElapsedSeconds != null && sampleElapsedSeconds > 0
    ? (current.price - previousDistinct!.price) / sampleElapsedSeconds : null;
  const adverseVelocity = velocityPerSecond == null
    ? null : input.side === "yes" ? -velocityPerSecond : velocityPerSecond;
  const priorElapsed = previousDistinct != null && beforePrevious != null
    ? previousDistinct.observedAtSeconds - beforePrevious.observedAtSeconds : null;
  const priorVelocity = priorElapsed != null && priorElapsed > 0
    ? (previousDistinct!.price - beforePrevious!.price) / priorElapsed : null;
  const priorAdverseVelocity = priorVelocity == null
    ? null : input.side === "yes" ? -priorVelocity : priorVelocity;
  const adverseAcceleration = adverseVelocity == null || priorAdverseVelocity == null
      || sampleElapsedSeconds == null || sampleElapsedSeconds <= 0
    ? null : (adverseVelocity - priorAdverseVelocity) / sampleElapsedSeconds;
  const favorableExtreme = input.side === "yes"
    ? Math.max(...samples.map((sample) => sample.price))
    : Math.min(...samples.map((sample) => sample.price));
  const adverseExcursionFraction = Math.max(0, input.side === "yes"
    ? (favorableExtreme - current.price) / input.strikePrice
    : (current.price - favorableExtreme) / input.strikePrice);
  const adverseDistinctMove = distinctSampleAdded && adverseVelocity !== null && adverseVelocity > 0;
  const recoveringDistinctMove = distinctSampleAdded && adverseVelocity !== null && adverseVelocity < 0;
  let recoveryProgress = recoveringDistinctMove
    ? Math.max(0, previous.adverseRecoverySampleCount ?? 0) + 1 : 0;
  let latchUntil = adverseDistinctMove
    ? input.nowSeconds + parameters.adverseLatchSeconds
    : previous.adverseLatchUntilSeconds ?? 0;
  const strongRecovery = recoveryProgress >= 2
    || ((previous.adverseExcursionFraction ?? 0) > 0
      && adverseExcursionFraction <= (previous.adverseExcursionFraction ?? 0) * 0.35);
  if (strongRecovery || input.nowSeconds > latchUntil) {
    latchUntil = 0;
    recoveryProgress = 0;
  }
  const adverseLatchActive = latchUntil >= input.nowSeconds
    && adverseExcursionFraction > 0;
  return {
    samples,
    distinctSampleAdded,
    sampleElapsedSeconds,
    velocityPerSecond,
    adverseVelocityPerSecond: adverseDistinctMove
      ? adverseVelocity
      : adverseLatchActive ? previous.latchedAdverseVelocityPerSecond ?? adverseVelocity : adverseVelocity,
    adverseAccelerationPerSecond2: adverseDistinctMove
      ? adverseAcceleration
      : adverseLatchActive
        ? previous.latchedAdverseAccelerationPerSecond2 ?? adverseAcceleration
        : adverseAcceleration,
    adverseExcursionFraction,
    adverseLatchActive,
    adverseLatchUntilSeconds: latchUntil,
    recoveryProgress,
  };
}

export interface SmartExitTimeScaledRisk {
  readonly timeBand: SmartExitTimeBand;
  readonly adverseTargetDistanceFraction: number;
  readonly requiredAdverseTargetDistanceFraction: number;
  readonly recoveryReachable: boolean;
  readonly underlyingConfirmed: boolean;
  readonly actionable: boolean;
}

/** Shared by live policy and durable replay. Positive distance is on the losing side. */
export function assessSmartExitTimeScaledRisk(input: {
  readonly side: BinarySide;
  readonly underlyingPrice: number;
  readonly strikePrice: number;
  readonly remainingSeconds: number;
  readonly volatilityLogReturnPerSqrtSecond: number;
  readonly fatTailVolatilityMultiplier: number;
  readonly directionalCount: number;
  readonly continuationAdverse: boolean;
  readonly targetAlreadyCrossed: boolean;
  readonly projectedCrossingConfirmed: boolean;
  readonly marketDirectionConfirmed: boolean;
  readonly trajectoryConfirmed?: boolean;
}): SmartExitTimeScaledRisk {
  const parameters = resolveSmartExitTimeBand(input.remainingSeconds);
  const signedDistance = input.side === "yes"
    ? (input.strikePrice - input.underlyingPrice) / input.strikePrice
    : (input.underlyingPrice - input.strikePrice) / input.strikePrice;
  const adverseTargetDistanceFraction = Math.max(0, signedDistance);
  const volatilityReach = Math.max(0, input.volatilityLogReturnPerSqrtSecond)
    * Math.sqrt(Math.max(0, input.remainingSeconds))
    * input.fatTailVolatilityMultiplier;
  const requiredAdverseTargetDistanceFraction = Math.max(
    parameters.minimumDistanceFraction,
    volatilityReach * parameters.volatilityReachMultiplier,
  );
  const recoveryReachable = adverseTargetDistanceFraction <= volatilityReach;
  const underlyingConfirmed = (
    input.directionalCount >= parameters.underlyingConfirmationCount
    || input.trajectoryConfirmed === true
  ) && input.continuationAdverse;
  const distanceConfirmed = adverseTargetDistanceFraction + 1e-12
    >= requiredAdverseTargetDistanceFraction;
  const actionable = input.marketDirectionConfirmed && (
    parameters.band === "critical"
      ? input.projectedCrossingConfirmed && underlyingConfirmed
      : input.targetAlreadyCrossed && underlyingConfirmed && distanceConfirmed
  );
  return {
    timeBand: parameters.band,
    adverseTargetDistanceFraction,
    requiredAdverseTargetDistanceFraction,
    recoveryReachable,
    underlyingConfirmed,
    actionable,
  };
}

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
  readonly adverseLatchActive?: boolean;
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
    : input.adverseLatchActive ? input.previousDirectionalCount : 0;
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
    timeBand: "monitor",
    adverseTargetDistanceFraction: 0,
    requiredAdverseTargetDistanceFraction: 0,
    marketDirection: "unknown",
    marketProbabilityDelta: null,
    marketAdverseSlopePerSecond: null,
    marketDirectionConfirmed: false,
    marketDirectionSampleCount: 0,
    marketLossFraction: null,
    capitalLossFraction: null,
    deepLossHoldActive: false,
    deepLossHoldKind: "none",
    highRisk: false,
    underlyingVelocityPerSecond: null,
    adverseVelocityPerSecond: null,
    adverseAccelerationPerSecond2: null,
    trajectorySampleCount: 0,
    trajectoryWindowSeconds: 0,
    adverseExcursionFraction: 0,
    adverseLatchActive: false,
    adverseLatchExpiresAtSeconds: null,
    recoveryProgress: 0,
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

function unavailable(
  reason: string,
  state: SmartExitState,
  degradedComponents: readonly string[] = [],
  timeBand: SmartExitTimeBand = "monitor",
): SmartExitDecision {
  return {
    disposition: "UNAVAILABLE", reason, mayExecuteExit: false,
    modelWinProbability: null, probabilityDropFromEntry: null, threshold: null,
    continuationScore: null, riskStage: "hold", nextState: state,
    ...emptyMetrics(), timeBand, degradedComponents,
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
  if (!finite(evidence.underlyingPrice)) return "spot evidence is missing";
  if (evidence.underlyingPrice <= 0
      || (finite(evidence.volatilityLogReturnPerSqrtSecond)
        && evidence.volatilityLogReturnPerSqrtSecond < 0)) return "evidence is invalid";
  return null;
}

export function missingSmartExitCrossingEvidence(
  evidence: Pick<
    SmartExitEvidence,
    "volatilityLogReturnPerSqrtSecond" | "momentumLogReturn" | "momentumWindowSeconds"
      | "tradeFlowImbalance" | "bookImbalance"
  >,
  options: { readonly tradeFlowOptional?: boolean } = {},
): string[] {
  const missing: string[] = [];
  if (!finite(evidence.volatilityLogReturnPerSqrtSecond)) missing.push("volatility");
  if (!finite(evidence.momentumLogReturn)
      || !finite(evidence.momentumWindowSeconds)
      || evidence.momentumWindowSeconds <= 0) missing.push("momentum");
  if (!options.tradeFlowOptional && !finite(evidence.tradeFlowImbalance)) missing.push("trade_flow");
  if (!finite(evidence.bookImbalance)) missing.push("book_imbalance");
  return missing;
}

export function evaluateSmartExit(
  position: SmartExitPosition,
  evidence: SmartExitEvidence,
  state: SmartExitState,
  config: SmartExitConfig,
  nowSeconds: number,
): SmartExitDecision {
  const sensitivity = resolveSmartExitSensitivity(config.sensitivity);
  const remaining = Math.max(0, position.expirySeconds - nowSeconds);
  const timeBandParameters = resolveSmartExitTimeBand(remaining);
  if (!config.enabled || config.mode === "off") {
    return {
      disposition: "OFF", reason: "smart exit is disabled", mayExecuteExit: false,
      modelWinProbability: null, probabilityDropFromEntry: null, threshold: null,
      continuationScore: null, riskStage: "hold", nextState: state, ...emptyMetrics(),
    };
  }
  const problem = evidenceProblem(position, evidence, config, nowSeconds);
  if (problem) return unavailable(problem, state, [], timeBandParameters.band);
  const tapeDirectionFresh =
    isFresh(evidence.tapeReceivedAtSeconds, nowSeconds, config.maxEvidenceAgeSeconds)
    && isFresh(evidence.tapeObservedAtSeconds, nowSeconds, config.maxEvidenceAgeSeconds);
  const bookDirectionFresh =
    isFresh(evidence.bookReceivedAtSeconds, nowSeconds, config.maxEvidenceAgeSeconds)
    && isFresh(evidence.bookObservedAtSeconds, nowSeconds, config.maxEvidenceAgeSeconds);
  const directionalEvidence: SmartExitEvidence = {
    ...evidence,
    tradeFlowImbalance: tapeDirectionFresh ? evidence.tradeFlowImbalance : null,
    bookImbalance: bookDirectionFresh ? evidence.bookImbalance : null,
  };
  const targetAlreadyCrossed = position.side === "yes"
    ? evidence.underlyingPrice! <= position.strikePrice
    : evidence.underlyingPrice! >= position.strikePrice;
  const missingAtCrossing = targetAlreadyCrossed
    ? missingSmartExitCrossingEvidence(directionalEvidence, {
        tradeFlowOptional: timeBandParameters.band === "critical",
      })
    : [];
  if (missingAtCrossing.length > 0) {
    return unavailable(
      `target crossed while mandatory crossing evidence is unavailable: ${missingAtCrossing.join(", ")}`,
      state,
      missingAtCrossing,
      timeBandParameters.band,
    );
  }
  const probability = modelWinProbability(position, evidence, config, nowSeconds);
  const continuation = adverseContinuationScore(position.side, directionalEvidence, config);
  if (probability === null) {
    return unavailable("model inputs are unavailable", state, [], timeBandParameters.band);
  }

  const modelEntryProbability = position.modelAtEntry.winProbability;
  const hasModelEntryBaseline = modelEntryProbability != null
    && Number.isFinite(modelEntryProbability)
    && modelEntryProbability >= 0
    && modelEntryProbability <= 1;
  const drop = hasModelEntryBaseline ? probability - modelEntryProbability : null;
  const threshold = probabilityDropThreshold(position.expirySeconds - nowSeconds, config);
  const trajectory = assessSmartExitTrajectory({
    side: position.side,
    strikePrice: position.strikePrice,
    price: evidence.underlyingPrice!,
    observedAtSeconds: evidence.spotObservedAtSeconds,
    nowSeconds,
    remainingSeconds: remaining,
    previousState: state,
    maximumEventAgeSeconds: config.maxEvidenceAgeSeconds,
  });
  const elapsed = trajectory.sampleElapsedSeconds;
  const velocity = trajectory.velocityPerSecond;
  const adverseVelocity = trajectory.adverseVelocityPerSecond;
  const adverseAcceleration = trajectory.adverseAccelerationPerSecond2;
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
    adverseLatchActive: trajectory.adverseLatchActive,
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
  const marketDirection = assessSmartExitMarketDirection({
    currentProbability: evidence.marketWinProbability,
    currentObservedAtSeconds: evidence.marketQuoteObservedAtSeconds,
    previousProbability: state.previousMarketWinProbability,
    previousObservedAtSeconds: state.previousMarketObservedAtSeconds,
    previousSampleCount: state.marketAdverseSampleCount,
    maximumGapSeconds: config.maxEvidenceAgeSeconds,
    requiredSampleCount: timeBandParameters.marketConfirmationCount,
    marketLossFraction,
    minimumMarketLossFraction: timeBandParameters.minimumMarketLossFraction,
  });
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
  if (!tapeDirectionFresh) degradedComponents.push("coinbase_tape");
  if (!bookDirectionFresh) degradedComponents.push("coinbase_book");
  if (!quoteFresh) degradedComponents.push("kalshi_quote");
  if (!marketBookFresh) degradedComponents.push("kalshi_book");
  if (!finite(directionalEvidence.tradeFlowImbalance)) degradedComponents.push("trade_flow");
  if (!finite(directionalEvidence.bookImbalance)) degradedComponents.push("book_imbalance");
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
    trajectorySampleCount: trajectory.samples.length,
    trajectoryWindowSeconds: trajectory.samples.length > 1
      ? trajectory.samples.at(-1)!.observedAtSeconds - trajectory.samples[0]!.observedAtSeconds
      : 0,
    adverseExcursionFraction: trajectory.adverseExcursionFraction,
    adverseLatchActive: trajectory.adverseLatchActive,
    adverseLatchExpiresAtSeconds: trajectory.adverseLatchActive
      ? trajectory.adverseLatchUntilSeconds : null,
    recoveryProgress: trajectory.recoveryProgress,
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
    marketAdverseSampleCount: marketDirection.sampleCount,
    holdUntilSeconds: state.holdUntilSeconds,
    previousModelProbability: probability,
    previousObservedAtSeconds: evidence.observedAtSeconds,
    previousMarketWinProbability: finite(evidence.marketWinProbability)
      ? evidence.marketWinProbability : null,
    previousMarketObservedAtSeconds: finite(evidence.marketWinProbability)
      ? evidence.marketQuoteObservedAtSeconds : null,
    previousUnderlyingPrice: evidence.underlyingPrice,
    previousUnderlyingAtSeconds: evidence.spotObservedAtSeconds,
    previousAdverseVelocity: adverseVelocity,
    trajectorySamples: trajectory.samples,
    adverseLatchUntilSeconds: trajectory.adverseLatchUntilSeconds,
    adverseExcursionFraction: trajectory.adverseExcursionFraction,
    adverseRecoverySampleCount: trajectory.recoveryProgress,
    latchedAdverseVelocityPerSecond: trajectory.adverseLatchActive
      ? adverseVelocity : null,
    latchedAdverseAccelerationPerSecond2: trajectory.adverseLatchActive
      ? adverseAcceleration : null,
  };
  const timeScaledRisk = assessSmartExitTimeScaledRisk({
    side: position.side,
    underlyingPrice: evidence.underlyingPrice!,
    strikePrice: position.strikePrice,
    remainingSeconds: remaining,
    volatilityLogReturnPerSqrtSecond: evidence.volatilityLogReturnPerSqrtSecond!,
    fatTailVolatilityMultiplier: config.fatTailVolatilityMultiplier,
    directionalCount,
    continuationAdverse,
    targetAlreadyCrossed: alreadyAcrossTarget,
    projectedCrossingConfirmed: crossingRiskConfirmed,
    marketDirectionConfirmed: marketDirection.confirmed,
    trajectoryConfirmed: trajectory.adverseLatchActive
      && trajectory.adverseExcursionFraction + 1e-12
        >= timeBandParameters.minimumAdverseExcursionFraction,
  });
  const shared = {
    ...common,
    crossingRiskConfirmed: timeScaledRisk.actionable,
    timeBand: timeScaledRisk.timeBand,
    adverseTargetDistanceFraction: timeScaledRisk.adverseTargetDistanceFraction,
    requiredAdverseTargetDistanceFraction: timeScaledRisk.requiredAdverseTargetDistanceFraction,
    marketDirection: marketDirection.direction,
    marketProbabilityDelta: marketDirection.probabilityDelta,
    marketAdverseSlopePerSecond: marketDirection.adverseSlopePerSecond,
    marketDirectionConfirmed: marketDirection.confirmed,
    marketDirectionSampleCount: marketDirection.sampleCount,
  };
  const probabilityDeteriorated = drop !== null && drop < -threshold;
  const marketDeteriorated = marketLossFraction !== null
    && marketLossFraction >= sensitivity.parameters.minMarketLossFraction;
  const meaningfulDeterioration = alreadyAcrossTarget
    || probabilityDeteriorated || fastDrop || highRisk || marketDeteriorated;
  const exitReady = timeScaledRisk.actionable
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
      reason: `${timeScaledRisk.timeBand} band: ${
        alreadyAcrossTarget
          ? "continued adverse target crossing"
          : "sharp adverse move can cross before expiry"
      }; fresh Kalshi direction and full-liquidity sale evidence confirm exit`,
      mayExecuteExit: mayExecute, riskStage: "exit", nextState: nextBase, ...shared,
    };
  }
  if (meaningfulDeterioration && crossingTrajectoryPlausible) {
    return {
      disposition: timeScaledRisk.timeBand === "monitor" ? "WATCH" : "PREPARE_EXIT",
      reason: !timeScaledRisk.underlyingConfirmed
        ? `${timeScaledRisk.timeBand} band: monitoring recovery; awaiting sustained adverse direction`
        : !marketDirection.confirmed
          ? `${timeScaledRisk.timeBand} band: underlying risk present; awaiting fresh adverse Kalshi direction`
          : !executionEvidenceReady
          ? "crossing risk confirmed; awaiting fresh full-position executable liquidity"
          : !economicExit
            ? "crossing risk confirmed; current executable sale does not beat hold value"
            : "crossing risk confirmed; awaiting material Kalshi deterioration",
      mayExecuteExit: false,
      riskStage: timeScaledRisk.timeBand === "monitor" ? "watch" : "prepare_exit",
      nextState: nextBase, ...shared,
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
    reason: marketDirection.direction === "recovering"
      ? `${timeScaledRisk.timeBand} band: held-side Kalshi probability is recovering`
      : crossingTrajectoryPlausible
      ? "crossing trajectory is forming but deterioration is not yet actionable"
      : marketDeteriorated || highRisk
        ? "Kalshi repricing is under review; underlying target crossing is not plausible"
        : sustainedAdverseSample
          ? "adverse movement remains too far from target to justify preparing an exit"
          : "within tolerance or unconfirmed",
    mayExecuteExit: false, riskStage: watch ? "watch" : "hold", nextState, ...shared,
  };
}