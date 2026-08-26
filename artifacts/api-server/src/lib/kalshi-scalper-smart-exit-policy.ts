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

export interface ScalperExitSample { atMs: number; price: number; }
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
  config: ScalperExitConfig;
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
}

const PRESETS: Readonly<Record<ScalperExitSensitivity, Readonly<{
  confirmations: number; minVelocityPctPerSecond: number;
  minAccelerationPctPerSecond2: number; minDeterioration: number; reserveSeconds: number;
}>>> = Object.freeze({
  // Faster than regular Smart Exit, but still requires two independent fresh
  // post-entry moves and a material Kalshi reprice.
  more_aggressive: Object.freeze({ confirmations: 2, minVelocityPctPerSecond: 0.015, minAccelerationPctPerSecond2: 0.002, minDeterioration: 0.12, reserveSeconds: 2 }),
  default: Object.freeze({ confirmations: 3, minVelocityPctPerSecond: 0.025, minAccelerationPctPerSecond2: 0.005, minDeterioration: 0.18, reserveSeconds: 3 }),
  less_aggressive: Object.freeze({ confirmations: 4, minVelocityPctPerSecond: 0.04, minAccelerationPctPerSecond2: 0.01, minDeterioration: 0.25, reserveSeconds: 5 }),
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
  });
  if (!input.config.enabled || input.config.mode === "off") return empty("off", "scalper exit disabled");
  const age = input.config.maxEvidenceAgeSeconds * 1_000;
  if (!Number.isFinite(input.target) || input.target! <= 0) return empty("blocked", "missing authoritative target");
  if (input.samples.length < 3) return empty("blocked", "insufficient post-entry samples");
  if (input.quoteAtMs == null || input.bookAtMs == null || input.nowMs - input.quoteAtMs > age || input.nowMs - input.bookAtMs > age) {
    return empty("blocked", "stale or missing authenticated quote/book");
  }
  const samples = input.samples.slice(-6);
  if (samples.some((sample) => !Number.isFinite(sample.price) || sample.price <= 0 || sample.atMs > input.nowMs)
    || input.nowMs - samples[samples.length - 1]!.atMs > age) {
    return empty("blocked", "stale or invalid post-entry sample");
  }
  if (input.remainingQuantity <= 0 || input.executableQuantity < input.remainingQuantity || !input.depthAtFloor) {
    return empty("blocked", "fresh depth does not cover remaining quantity at floor");
  }
  const last = samples[samples.length - 1]!;
  const prior = samples[samples.length - 2]!;
  const first = samples[0]!;
  const dt = (last.atMs - prior.atMs) / 1_000;
  const fullDt = (last.atMs - first.atMs) / 1_000;
  if (dt <= 0 || dt > 2.5 || fullDt <= 0) return empty("blocked", "sample cadence is discontinuous");
  const rawVelocity = (last.price - prior.price) / dt;
  const adverseVelocity = input.side === "yes" ? -rawVelocity : rawVelocity;
  const priorVelocity = (prior.price - samples[samples.length - 3]!.price) / ((prior.atMs - samples[samples.length - 3]!.atMs) / 1_000);
  const adversePriorVelocity = input.side === "yes" ? -priorVelocity : priorVelocity;
  const acceleration = (adverseVelocity - adversePriorVelocity) / dt;
  const distance = input.side === "yes" ? last.price - input.target! : input.target! - last.price;
  const distancePct = Math.abs(distance) / input.target! * 100;
  const crossing = distance <= 0 ? 0 : adverseVelocity > 0 ? distance / adverseVelocity : null;
  const remaining = Math.max(0, (input.expiresAtMs - input.nowMs) / 1_000);
  const deterioration = input.currentWinningProbability != null && input.entryWinningProbability > 0
    ? Math.max(0, (input.entryWinningProbability - input.currentWinningProbability) / input.entryWinningProbability) : null;
  const preset = PRESETS[resolveScalperExitSensitivity(input.config.sensitivity)];
  let confirmations = 0;
  for (let index = samples.length - 1; index > 0; index--) {
    const a = samples[index - 1]!, b = samples[index]!;
    const velocity = (b.price - a.price) / ((b.atMs - a.atMs) / 1_000);
    if ((input.side === "yes" ? -velocity : velocity) > 0) confirmations++; else break;
  }
  const common = { adverseVelocityPerSecond: adverseVelocity, adverseAccelerationPerSecond2: acceleration, distancePct,
    projectedCrossingSeconds: crossing, secondsRemaining: remaining, marketDeterioration: deterioration, confirmationCount: confirmations };
  const crossingPlausible = crossing !== null && crossing <= Math.max(0, remaining - preset.reserveSeconds);
  const rapid = adverseVelocity / input.target! * 100 >= preset.minVelocityPctPerSecond;
  const accelerating = acceleration / input.target! * 100 >= preset.minAccelerationPctPerSecond2;
  const deteriorated = deterioration !== null && deterioration >= preset.minDeterioration;
  if (rapid && accelerating && crossingPlausible && deteriorated && confirmations >= preset.confirmations) {
    return { disposition: "exit", reason: "confirmed rapid adverse target-crossing with Kalshi deterioration", ...common };
  }
  return { disposition: "watch", reason: !crossingPlausible
    ? "target crossing not plausible before expiry"
    : !accelerating
      ? "adverse movement is not accelerating"
      : "awaiting repeated adverse confirmation or Kalshi deterioration", ...common };
}