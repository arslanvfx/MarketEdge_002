// Pure, Scalper-only early-exit policy.  This deliberately does not share the
// regular Smart Exit policy: an entry scalp has a much shorter horizon and a
// separate, conservative confirmation contract.
export type ScalperExitMode = "off" | "shadow" | "paper-exit" | "live-exit";
export type ScalperExitSensitivity = "more_aggressive" | "default" | "less_aggressive";
export type ScalperExitSide = "yes" | "no";

export interface ScalperExitConfig {
  enabled: boolean;
  mode: ScalperExitMode;
  sensitivity: ScalperExitSensitivity;
  maxEvidenceAgeSeconds: number;
}

export const DEFAULT_SCALPER_EXIT_CONFIG: Readonly<ScalperExitConfig> = Object.freeze({
  enabled: false,
  mode: "shadow",
  sensitivity: "default",
  maxEvidenceAgeSeconds: 2,
});

/** Source fields are optional only for legacy replay evidence, never live execution. */
export interface ScalperExitSample {
  atMs: number;
  price: number;
  sourceAtMs?: number | null;
  sourceSequence?: string | null;
}
export interface ScalperExitInput {
  side: ScalperExitSide;
  target: number | null;
  samples: readonly ScalperExitSample[];
  nowMs: number;
  expiresAtMs: number;
  entryWinningProbability: number;
  currentWinningProbability: number | null;
  quoteAtMs: number | null;
  bookAtMs: number | null;
  executableQuantity: number;
  remainingQuantity: number;
  depthAtFloor: boolean;
  terminalStopLossExecutableQuantity: number;
  terminalStopLossWinningProbability: number | null;
  valuePreservingExecutableQuantity: number;
  valuePreservingWinningProbability: number | null;
  config: ScalperExitConfig;
  requireSourceTimestamps?: boolean;
}
export interface ScalperExitDecision {
  disposition: "off" | "blocked" | "watch" | "exit";
  reason: string;
  adverseVelocityPerSecond: number | null;
  adverseAccelerationPerSecond2: number | null;
  distancePct: number | null;
  projectedCrossingSeconds: number | null;
  secondsRemaining: number;
  marketDeterioration: number | null;
  confirmationCount: number;
  normalizedAdverseVelocityPctPerSecond: number | null;
  normalizedAdverseAccelerationPctPerSecond2: number | null;
  volatilityPctPerSecond: number | null;
  noiseFloorPctPerSecond: number | null;
  projectedPriceAtDeadline: number | null;
  reserveSeconds: number | null;
  sampleCount: number;
  latestGapMs: number | null;
  worstGapMs: number | null;
  sourceAgeMs: number | null;
  projectionMethod: string | null;
  projectionState: string | null;
  targetBreachConfirmationCount: number;
  targetBreachSpanMs: number | null;
  quoteLagProtectionEligible: boolean;
  quoteLagProtectionFloor: number | null;
  terminalStopLossEligible: boolean;
  terminalStopLossFloor: number | null;
}

export const MAX_SCALPER_EXIT_SAMPLE_GAP_MS = 15_000;
export const MAX_SCALPER_EXIT_SAMPLE_SPAN_MS = 30_000;
const QUOTE_LAG_PROTECTION_MIN_GAIN = 0.01;
export const SCALPER_TERMINAL_STOP_LOSS_FLOOR = 0.10;

function orderableSourceSequence(sequence: string | null | undefined): bigint | null {
  return sequence && /^\d+$/.test(sequence) ? BigInt(sequence) : null;
}

export function isScalperSourceSequenceRegression(
  priorSequence: string | null | undefined,
  nextSequence: string | null | undefined,
): boolean {
  const prior = orderableSourceSequence(priorSequence);
  const next = orderableSourceSequence(nextSequence);
  return prior != null && next != null && next <= prior;
}

function hasScalperSourceSequenceRegression(samples: readonly ScalperExitSample[]): boolean {
  let lastOrderable: bigint | null = null;
  for (const sample of samples) {
    const current = orderableSourceSequence(sample.sourceSequence);
    if (current == null) continue;
    if (lastOrderable != null && current <= lastOrderable) return true;
    lastOrderable = current;
  }
  return false;
}

const PRESETS: Readonly<Record<ScalperExitSensitivity, Readonly<{
  confirmations: number; minVelocityPctPerSecond: number;
  minAccelerationPctPerSecond2: number; minDeterioration: number; reserveSeconds: number;
  breachConfirmations: number; breachPersistenceMs: number;
}>>> = Object.freeze({
  // Faster than regular Smart Exit, but still requires two independent fresh
  // post-entry moves and a material Kalshi reprice.
  more_aggressive: Object.freeze({ confirmations: 2, minVelocityPctPerSecond: 0.015, minAccelerationPctPerSecond2: 0.002, minDeterioration: 0.12, reserveSeconds: 2, breachConfirmations: 2, breachPersistenceMs: 1_500 }),
  default: Object.freeze({ confirmations: 3, minVelocityPctPerSecond: 0.025, minAccelerationPctPerSecond2: 0.005, minDeterioration: 0.18, reserveSeconds: 3, breachConfirmations: 3, breachPersistenceMs: 2_000 }),
  less_aggressive: Object.freeze({ confirmations: 4, minVelocityPctPerSecond: 0.04, minAccelerationPctPerSecond2: 0.01, minDeterioration: 0.25, reserveSeconds: 5, breachConfirmations: 4, breachPersistenceMs: 3_000 }),
});

export function resolveScalperExitSensitivity(value: unknown): ScalperExitSensitivity {
  return value === "more_aggressive" || value === "less_aggressive" || value === "default" ? value : "default";
}

export function isScalperExitEvidenceFetchFresh(
  startedAtMs: number,
  receivedAtMs: number,
  maxEvidenceAgeSeconds: number,
): boolean {
  return Number.isFinite(startedAtMs)
    && Number.isFinite(receivedAtMs)
    && Number.isFinite(maxEvidenceAgeSeconds)
    && maxEvidenceAgeSeconds > 0
    && receivedAtMs >= startedAtMs
    && receivedAtMs - startedAtMs <= maxEvidenceAgeSeconds * 1_000;
}

export function computeScalperExitExecutableDepth(
  originalSide: ScalperExitSide,
  yesDepth: readonly [number, number][],
  noDepth: readonly [number, number][],
  quantity: number,
  minimumWinningPrice: number,
): { quantity: number; price: number | null } {
  if (!Number.isFinite(quantity) || quantity <= 0
    || !Number.isFinite(minimumWinningPrice)
    || minimumWinningPrice <= 0 || minimumWinningPrice >= 1) {
    return { quantity: 0, price: null };
  }
  const complementaryDepth = originalSide === "yes" ? noDepth : yesDepth;
  const winningLevels = complementaryDepth
    .map(([complementaryPrice, count]) =>
      [1 - complementaryPrice, count] as [number, number])
    .filter(([winningPrice, count]) =>
      Number.isFinite(winningPrice)
      && winningPrice > 0
      && winningPrice < 1
      && Number.isFinite(count)
      && count > 0
      && winningPrice + 1e-9 >= minimumWinningPrice)
    .sort((a, b) => b[0] - a[0]);
  let left = quantity;
  let filled = 0;
  let proceeds = 0;
  for (const [winningPrice, available] of winningLevels) {
    const take = Math.min(left, available);
    filled += take;
    proceeds += take * winningPrice;
    left -= take;
    if (left <= 1e-9) break;
  }
  return {
    quantity: filled,
    price: filled > 0 ? proceeds / filled : null,
  };
}

/** Positive adverse velocity always means movement toward loss, for YES and NO. */
export function evaluateScalperExit(input: ScalperExitInput): ScalperExitDecision {
  const empty = (disposition: ScalperExitDecision["disposition"], reason: string): ScalperExitDecision => ({
    disposition, reason, adverseVelocityPerSecond: null, adverseAccelerationPerSecond2: null,
    distancePct: null, projectedCrossingSeconds: null,
    secondsRemaining: Math.max(0, (input.expiresAtMs - input.nowMs) / 1_000),
    marketDeterioration: null, confirmationCount: 0,
    normalizedAdverseVelocityPctPerSecond: null, normalizedAdverseAccelerationPctPerSecond2: null,
    volatilityPctPerSecond: null, noiseFloorPctPerSecond: null, projectedPriceAtDeadline: null,
    reserveSeconds: null, sampleCount: 0, latestGapMs: null, worstGapMs: null,
    sourceAgeMs: null, projectionMethod: null, projectionState: null,
    targetBreachConfirmationCount: 0, targetBreachSpanMs: null,
    quoteLagProtectionEligible: false, quoteLagProtectionFloor: null,
    terminalStopLossEligible: false, terminalStopLossFloor: null,
  });
  if (!input.config.enabled || input.config.mode === "off") return empty("off", "scalper exit disabled");
  if (!Number.isFinite(input.expiresAtMs) || input.nowMs >= input.expiresAtMs) {
    return empty("blocked", "market already expired");
  }
  const age = input.config.maxEvidenceAgeSeconds * 1_000;
  if (!Number.isFinite(input.target) || input.target! <= 0) return empty("blocked", "missing authoritative target");
  if (input.samples.length < 4) return empty("blocked", "insufficient post-entry samples");
  if (input.quoteAtMs == null || input.bookAtMs == null || input.nowMs - input.quoteAtMs > age || input.nowMs - input.bookAtMs > age) {
    return empty("blocked", "stale or missing authenticated quote/book");
  }
  // A bounded window makes this pure policy insensitive to old replay history,
  // while retaining enough 250ms observations to reject a single bad tick.
  const samples = input.samples.slice(-28);
  if (samples.some((sample) => !Number.isFinite(sample.price) || sample.price <= 0
    || !Number.isFinite(sample.atMs) || sample.atMs > input.nowMs)
    || input.nowMs - samples[samples.length - 1]!.atMs > age) {
    return empty("blocked", "stale or invalid post-entry sample");
  }
  const gaps = samples.slice(1).map((sample, index) => sample.atMs - samples[index]!.atMs);
  const latestGapMs = gaps[gaps.length - 1] ?? null;
  const worstGapMs = gaps.length ? Math.max(...gaps) : null;
  if (gaps.some((gap) => gap <= 0 || gap > MAX_SCALPER_EXIT_SAMPLE_GAP_MS)
    || samples[samples.length - 1]!.atMs - samples[0]!.atMs > MAX_SCALPER_EXIT_SAMPLE_SPAN_MS) {
    return empty("blocked", "provider sample cadence is discontinuous");
  }
  const sourced = samples.filter((sample) => sample.sourceAtMs != null);
  if (input.requireSourceTimestamps && samples.some((sample) =>
    sample.sourceAtMs == null || !sample.sourceSequence)) {
    return empty("blocked", "authoritative source timestamp or update identity missing");
  }
  const sourceAgeMs = sourced.length ? input.nowMs - sourced[sourced.length - 1]!.sourceAtMs! : null;
  if (sourced.some((sample) => !Number.isFinite(sample.sourceAtMs) || sample.sourceAtMs! > input.nowMs
    || sample.sourceAtMs! > sample.atMs)
    || (sourceAgeMs != null && sourceAgeMs > age)
    || sourced.some((sample, index) => index > 0 && sample.sourceAtMs! < sourced[index - 1]!.sourceAtMs!)
    || hasScalperSourceSequenceRegression(samples)
    || samples.some((sample, index) => index > 0
      && sample.sourceAtMs === samples[index - 1]!.sourceAtMs
      && sample.sourceSequence != null
      && sample.sourceSequence === samples[index - 1]!.sourceSequence)) {
    return empty("blocked", "stale, future, or out-of-order source timestamp");
  }
  if (input.remainingQuantity <= 0) {
    return empty("blocked", "remaining quantity is invalid");
  }
  const anyAuthorizedDepthCoversPosition =
    (input.executableQuantity + 1e-9 >= input.remainingQuantity && input.depthAtFloor)
    || input.terminalStopLossExecutableQuantity + 1e-9 >= input.remainingQuantity
    || input.valuePreservingExecutableQuantity + 1e-9 >= input.remainingQuantity;
  if (!anyAuthorizedDepthCoversPosition) {
    return empty("blocked", "fresh depth does not cover remaining quantity at an authorized floor");
  }
  const last = samples[samples.length - 1]!;
  const direction = input.side === "yes" ? -1 : 1;
  const velocities = samples.slice(1).map((sample, index) =>
    direction * (sample.price - samples[index]!.price) / ((sample.atMs - samples[index]!.atMs) / 1_000));
  const weightedMedian = (values: readonly number[]): number => {
    const weighted = values.map((value, index) => ({ value, weight: index + 1 })).sort((a, b) => a.value - b.value);
    const half = weighted.reduce((sum, row) => sum + row.weight, 0) / 2;
    let total = 0;
    for (const row of weighted) { total += row.weight; if (total >= half) return row.value; }
    return weighted[weighted.length - 1]!.value;
  };
  const adverseVelocity = weightedMedian(velocities);
  const deviations = velocities.map((velocity) => Math.abs(velocity - adverseVelocity));
  // MAD is resistant to one print; the absolute floor prevents tiny monotonic
  // quote noise from being promoted to a trajectory.
  const volatility = weightedMedian(deviations) * 1.4826;
  const noiseFloor = Math.max(input.target! * 0.0005, volatility * 0.25);
  const isolatedOutlier = velocities.length >= 3
    && Math.abs(velocities[velocities.length - 1]! - adverseVelocity) > Math.max(noiseFloor * 4, input.target! * 0.02);
  const accelerations = velocities.slice(1).map((velocity, index) =>
    (velocity - velocities[index]!) / ((samples[index + 2]!.atMs - samples[index + 1]!.atMs) / 1_000));
  const measuredAcceleration = accelerations.length ? weightedMedian(accelerations) : 0;
  // Keep projections physical: acceleration is capped rather than allowing an
  // isolated interval to predict an arbitrary future price.
  const acceleration = Math.max(-input.target! * 0.08, Math.min(input.target! * 0.08, measuredAcceleration));
  const distance = input.side === "yes" ? last.price - input.target! : input.target! - last.price;
  const distancePct = Math.abs(distance) / input.target! * 100;
  const remaining = Math.max(0, (input.expiresAtMs - input.nowMs) / 1_000);
  const authoritativeWinningProbability = input.terminalStopLossWinningProbability
    ?? input.currentWinningProbability;
  const deterioration = authoritativeWinningProbability != null && input.entryWinningProbability > 0
    ? Math.max(0, (input.entryWinningProbability - authoritativeWinningProbability) / input.entryWinningProbability) : null;
  const preset = PRESETS[resolveScalperExitSensitivity(input.config.sensitivity)];
  let targetBreachConfirmationCount = 0;
  let firstTargetBreachAtMs: number | null = null;
  const distinctBreachUpdates = new Set<string>();
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index]!;
    const onLosingSide = input.side === "yes"
      ? sample.price <= input.target!
      : sample.price >= input.target!;
    if (!onLosingSide) break;
    const orderableSequence = orderableSourceSequence(sample.sourceSequence);
    const updateKey = orderableSequence != null
      ? `sequence:${orderableSequence}`
      : sample.sourceAtMs != null
        ? `source-time:${sample.sourceAtMs}`
        : `local-time:${sample.atMs}`;
    if (distinctBreachUpdates.has(updateKey)) continue;
    distinctBreachUpdates.add(updateKey);
    targetBreachConfirmationCount += 1;
    firstTargetBreachAtMs = sample.atMs;
  }
  const targetBreachSpanMs = firstTargetBreachAtMs == null
    ? null
    : last.atMs - firstTargetBreachAtMs;
  const quoteLagProtectionFloor = Math.min(
    0.99,
    input.entryWinningProbability + QUOTE_LAG_PROTECTION_MIN_GAIN,
  );
  const quoteLagProtectionEligible =
    input.valuePreservingExecutableQuantity + 1e-9 >= input.remainingQuantity
    && input.valuePreservingWinningProbability != null
    && input.valuePreservingWinningProbability + 1e-9 >= quoteLagProtectionFloor;
  const terminalStopLossEligible =
    input.terminalStopLossExecutableQuantity + 1e-9 >= input.remainingQuantity
    && input.terminalStopLossWinningProbability != null
    && input.terminalStopLossWinningProbability + 1e-9 >= SCALPER_TERMINAL_STOP_LOSS_FLOOR
    && deterioration !== null
    && deterioration >= preset.minDeterioration;
  const trajectoryDepthEligible = input.executableQuantity + 1e-9 >= input.remainingQuantity
    && input.depthAtFloor;
  const persistentTargetBreach = targetBreachConfirmationCount >= preset.breachConfirmations
    && targetBreachSpanMs != null
    && targetBreachSpanMs >= preset.breachPersistenceMs;
  // The conservative trajectory starts below robust velocity by its noise
  // allowance. Positive acceleration is useful but never required; negative
  // acceleration explicitly stops the projection when it runs out of speed.
  const projectedVelocity = Math.max(0, adverseVelocity - noiseFloor);
  const horizon = Math.max(0, remaining - preset.reserveSeconds);
  const stoppingDistance = acceleration < 0 ? projectedVelocity * projectedVelocity / (-2 * acceleration) : Infinity;
  let crossing: number | null = null;
  let projectionState = "no_adverse_trajectory";
  if (distance <= 0) { crossing = 0; projectionState = "already_at_target"; }
  else if (projectedVelocity > 0 && stoppingDistance + 1e-9 >= distance) {
    if (Math.abs(acceleration) < 1e-9) crossing = distance / projectedVelocity;
    else {
      const discriminant = projectedVelocity * projectedVelocity + 2 * acceleration * distance;
      if (discriminant >= 0) crossing = (-projectedVelocity + Math.sqrt(discriminant)) / acceleration;
    }
    projectionState = crossing == null || crossing < 0 ? "cannot_reach_target" : "quadratic_robust";
  } else if (acceleration < 0) projectionState = "decelerates_before_target";
  else projectionState = "below_noise_floor";
  const projectionHorizon = acceleration < 0
    ? Math.min(horizon, projectedVelocity / -acceleration)
    : horizon;
  const projectedProgress = projectedVelocity * projectionHorizon
    + 0.5 * acceleration * projectionHorizon * projectionHorizon;
  const projectedPrice = input.side === "yes"
    ? last.price - Math.max(0, projectedProgress)
    : last.price + Math.max(0, projectedProgress);
  let confirmations = 0;
  for (let index = samples.length - 1; index > 0; index--) {
    if (velocities[index - 1]! >= Math.max(noiseFloor, input.target! * preset.minVelocityPctPerSecond / 100)) confirmations++; else break;
  }
  const common = { adverseVelocityPerSecond: adverseVelocity, adverseAccelerationPerSecond2: acceleration, distancePct,
    projectedCrossingSeconds: crossing, secondsRemaining: remaining, marketDeterioration: deterioration, confirmationCount: confirmations,
    normalizedAdverseVelocityPctPerSecond: adverseVelocity / input.target! * 100,
    normalizedAdverseAccelerationPctPerSecond2: acceleration / input.target! * 100,
    volatilityPctPerSecond: volatility / input.target! * 100, noiseFloorPctPerSecond: noiseFloor / input.target! * 100,
    projectedPriceAtDeadline: projectedPrice, reserveSeconds: preset.reserveSeconds, sampleCount: samples.length,
    latestGapMs, worstGapMs, sourceAgeMs, projectionMethod: "weighted-median-mad-bounded-quadratic", projectionState };
  const enriched = {
    ...common,
    targetBreachConfirmationCount,
    targetBreachSpanMs,
    quoteLagProtectionEligible,
    quoteLagProtectionFloor,
    terminalStopLossEligible,
    terminalStopLossFloor: SCALPER_TERMINAL_STOP_LOSS_FLOOR,
  };
  if (persistentTargetBreach && quoteLagProtectionEligible) {
    return {
      disposition: "exit",
      reason: "persistent target breach with value-preserving authenticated depth",
      ...enriched,
    };
  }
  if (persistentTargetBreach && terminalStopLossEligible) {
    return {
      disposition: "exit",
      reason: "persistent target breach with authenticated full-position stop-loss depth",
      ...enriched,
    };
  }
  const crossingPlausible = remaining > preset.reserveSeconds
    && crossing !== null
    && crossing <= remaining - preset.reserveSeconds;
  // Preset velocity is a normalized, per-second minimum.  Acceleration is
  // telemetry/projection input, deliberately not an independent exit gate.
  const rapid = projectedVelocity / input.target! * 100 >= preset.minVelocityPctPerSecond;
  const deteriorated = deterioration !== null && deterioration >= preset.minDeterioration;
  if (trajectoryDepthEligible && rapid && crossingPlausible && deteriorated && confirmations >= preset.confirmations) {
    if (isolatedOutlier) {
      return { disposition: "watch", reason: "latest adverse print is an isolated trajectory outlier", ...enriched };
    }
    return { disposition: "exit", reason: "confirmed rapid adverse target-crossing with Kalshi deterioration", ...enriched };
  }
  return { disposition: "watch", reason: !crossingPlausible
    ? "target crossing not plausible before expiry"
    : !trajectoryDepthEligible && !terminalStopLossEligible && !quoteLagProtectionEligible
      ? "fresh depth does not cover remaining quantity at an authorized floor"
    : !rapid ? "adverse trajectory is below conservative signal floor"
      : persistentTargetBreach && !quoteLagProtectionEligible
        ? "target breach confirmed but executable value does not preserve entry"
        : targetBreachConfirmationCount > 0
          ? "awaiting persistent target-breach confirmation"
          : "awaiting repeated adverse confirmation or Kalshi deterioration", ...enriched };
}