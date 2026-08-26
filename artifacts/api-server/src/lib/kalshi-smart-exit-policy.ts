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
  continuationWeights: Object.freeze({ momentum: 0.34, tradeFlow: 0.33, book: 0.33 }),
  appliedVersions: Object.freeze({}),
});

export const INITIAL_SMART_EXIT_STATE: SmartExitState = Object.freeze({
  adverseSampleCount: 0,
  holdUntilSeconds: 0,
  previousModelProbability: null,
  previousObservedAtSeconds: null,
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
  if (
    !finite(evidence.volatilityLogReturnPerSqrtSecond) ||
    !finite(evidence.momentumLogReturn) ||
    !finite(evidence.momentumWindowSeconds) ||
    !finite(evidence.tradeFlowImbalance) ||
    !finite(evidence.bookImbalance) ||
    evidence.momentumWindowSeconds <= 0
  ) return null;
  const sigma = Math.max(config.minVolatilityLogReturnPerSqrtSecond, evidence.volatilityLogReturnPerSqrtSecond);
  const momentumZ = evidence.momentumLogReturn / (sigma * Math.sqrt(evidence.momentumWindowSeconds));
  // A lower underlying hurts YES; a higher underlying hurts NO.
  const adverseSign = side === "yes" ? -1 : 1;
  const w = config.continuationWeights;
  return adverseSign * (w.momentum * momentumZ + w.tradeFlow * evidence.tradeFlowImbalance + w.book * evidence.bookImbalance);
}

function unavailable(reason: string, state: SmartExitState): SmartExitDecision {
  return { disposition: "UNAVAILABLE", reason, mayExecuteExit: false, modelWinProbability: null, probabilityDropFromEntry: null, threshold: null, continuationScore: null, nextState: state };
}

function evidenceProblem(position: SmartExitPosition, evidence: SmartExitEvidence, config: SmartExitConfig, now: number): string | null {
  if (position.underlyingKind === "commodity") return "commodity microstructure is unsupported";
  if (
    position.modelAtEntry.winProbability == null
    || !Number.isFinite(position.modelAtEntry.winProbability)
    || position.modelAtEntry.winProbability < 0
    || position.modelAtEntry.winProbability > 1
  ) return "model-at-entry baseline is unavailable";
  if (config.totalWindowSeconds <= 0 || config.minVolatilityLogReturnPerSqrtSecond <= 0 ||
      config.fatTailVolatilityMultiplier <= 0 || config.debounceCount < 1) return "configuration is invalid";
  if (now - evidence.observedAtSeconds > config.maxEvidenceAgeSeconds || evidence.observedAtSeconds > now) return "evidence is stale or clock-invalid";
  const componentTimes = [
    evidence.spotObservedAtSeconds,
    evidence.tapeObservedAtSeconds,
    evidence.bookObservedAtSeconds,
  ];
  if (componentTimes.some((at) => at == null)) return "spot, tape, and book timestamps are required";
  if (componentTimes.some((at) => now - at! > config.maxEvidenceAgeSeconds || at! > now)) {
    return "spot, tape, or book evidence is stale or clock-invalid";
  }
  if (!finite(evidence.underlyingPrice) || !finite(evidence.volatilityLogReturnPerSqrtSecond) ||
      !finite(evidence.momentumLogReturn) || !finite(evidence.momentumWindowSeconds) ||
      !finite(evidence.tradeFlowImbalance) || !finite(evidence.bookImbalance)) return "evidence is missing or incomplete";
  if (evidence.underlyingPrice <= 0 || evidence.volatilityLogReturnPerSqrtSecond < 0 || evidence.momentumWindowSeconds <= 0) return "evidence is invalid";
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
    return { disposition: "OFF", reason: "smart exit is disabled", mayExecuteExit: false, modelWinProbability: null, probabilityDropFromEntry: null, threshold: null, continuationScore: null, nextState: state };
  }
  const problem = evidenceProblem(position, evidence, config, nowSeconds);
  if (problem) return unavailable(problem, state);
  const probability = modelWinProbability(position, evidence, config, nowSeconds);
  const continuation = adverseContinuationScore(position.side, evidence, config);
  if (probability === null || continuation === null) return unavailable("model inputs are unavailable", state);

  const drop = probability - position.modelAtEntry.winProbability!;
  const threshold = probabilityDropThreshold(position.expirySeconds - nowSeconds, config);
  const nextBase: SmartExitState = {
    adverseSampleCount: 0, holdUntilSeconds: state.holdUntilSeconds,
    previousModelProbability: probability, previousObservedAtSeconds: evidence.observedAtSeconds,
  };
  const fastDrop = state.previousModelProbability !== null && state.previousObservedAtSeconds !== null &&
    evidence.observedAtSeconds >= state.previousObservedAtSeconds &&
    evidence.observedAtSeconds - state.previousObservedAtSeconds <= config.hardStopWindowSeconds &&
    probability - state.previousModelProbability <= -config.hardStopProbabilityDrop;
  if (fastDrop) return { disposition: "EXIT_SIGNAL", reason: "catastrophic probability drop", mayExecuteExit: config.mode === "live-exit", modelWinProbability: probability, probabilityDropFromEntry: drop, threshold, continuationScore: continuation, nextState: nextBase };
  if (nowSeconds < state.holdUntilSeconds) return { disposition: "HOLD", reason: "hysteresis active", mayExecuteExit: false, modelWinProbability: probability, probabilityDropFromEntry: drop, threshold, continuationScore: continuation, nextState: nextBase };
  const adverse = drop < -threshold && continuation >= config.confirmationLevel;
  const count = adverse ? state.adverseSampleCount + 1 : 0;
  const nextState: SmartExitState = { ...nextBase, adverseSampleCount: count, holdUntilSeconds: adverse ? state.holdUntilSeconds : nowSeconds + config.hysteresisSeconds };
  if (adverse && count >= config.debounceCount) return { disposition: "EXIT_SIGNAL", reason: "confirmed adverse probability decay", mayExecuteExit: config.mode === "live-exit", modelWinProbability: probability, probabilityDropFromEntry: drop, threshold, continuationScore: continuation, nextState };
  return { disposition: "HOLD", reason: adverse ? "awaiting debounce confirmation" : "within tolerance or unconfirmed", mayExecuteExit: false, modelWinProbability: probability, probabilityDropFromEntry: drop, threshold, continuationScore: continuation, nextState };
}