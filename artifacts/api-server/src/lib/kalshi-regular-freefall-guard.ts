import {
  FREEFALL_MAX_SAMPLE_AGE_MS,
  evaluateFreefallPreSubmitGuard,
  type FreefallPreSubmitDecision,
} from "./kalshi-scalper-policy.ts";

export const REGULAR_FREEFALL_FAIL_CLOSED_SECONDS = 120;

export interface RegularFreefallGuardInput {
  samples: Array<{ price: number; ts: number }>;
  side: "yes" | "no";
  nowMs: number;
  windowStartMs: number;
  closeTimeMs: number;
  targetPrice: number;
  hasProduct: boolean;
}

export interface RegularFreefallGuardDecision extends FreefallPreSubmitDecision {
  deferredUnavailable: boolean;
  secondsRemaining: number;
}

/**
 * Regular-bot adapter for the Scalper policy. The policy itself remains
 * unchanged: only regular entries outside the last two minutes may defer an
 * unavailable/warming result. Any evaluable rejection remains authoritative.
 */
export function evaluateRegularFreefallPreSubmitGuard(
  input: RegularFreefallGuardInput,
): RegularFreefallGuardDecision {
  const secondsRemaining = Number.isFinite(input.closeTimeMs)
    ? Math.max(0, (input.closeTimeMs - input.nowMs) / 1_000)
    : 0;
  const newestAt = input.samples.reduce(
    (latest, sample) =>
      Number.isFinite(sample.ts) && sample.ts <= input.nowMs
        ? Math.max(latest, sample.ts)
        : latest,
    Number.NEGATIVE_INFINITY,
  );
  const freshSampleSucceeded =
    Number.isFinite(newestAt)
    && input.nowMs - newestAt <= FREEFALL_MAX_SAMPLE_AGE_MS;

  const decision = evaluateFreefallPreSubmitGuard({
    directionEnabled: true,
    hasProduct: input.hasProduct,
    freshSampleSucceeded,
    samples: input.samples.map(({ price, ts }) => ({ price, at: ts })),
    side: input.side,
    nowMs: input.nowMs,
    eligibilityStartMs: input.windowStartMs,
    consecutiveSeconds: 4,
    favorableTrendConfirmationEnabled: true,
    coordinatedDirectionClearanceEnabled: false,
    targetPrice: input.targetPrice,
    secondsRemaining,
    rapidMoveEnabled: true,
    rapidMoveLookbackSeconds: 4,
    rapidMoveThresholdPct: 0.5,
  });

  if (
    !decision.allowed
    && decision.guardResult?.evaluable !== true
    && secondsRemaining > REGULAR_FREEFALL_FAIL_CLOSED_SECONDS
  ) {
    return {
      ...decision,
      allowed: true,
      deferredUnavailable: true,
      secondsRemaining,
    };
  }

  return {
    ...decision,
    deferredUnavailable: false,
    secondsRemaining,
  };
}

export function describeRegularFreefallDecision(
  decision: RegularFreefallGuardDecision,
): string {
  const result = decision.guardResult;
  return [
    `regular freefall guard: ${decision.reason ?? "blocked"}`,
    `remaining=${decision.secondsRemaining.toFixed(1)}s`,
    `samples=${result?.samplesUsed ?? 0}/${result?.requiredSamples ?? 5}`,
    result?.latestPrice != null ? `latest=${result.latestPrice}` : null,
    result?.targetPrice != null ? `target=${result.targetPrice}` : null,
    result?.directionalMovePct != null
      ? `directional=${result.directionalMovePct.toFixed(6)}%`
      : null,
    result?.rapidMovePct != null
      ? `rapid=${result.rapidMovePct.toFixed(6)}%`
      : null,
  ].filter((part): part is string => part != null).join("; ");
}