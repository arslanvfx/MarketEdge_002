import {
  checkFreefallGuard,
  type FreefallPreSubmitDecision,
} from "./kalshi-scalper-policy.ts";

export const REGULAR_FREEFALL_CONSECUTIVE_SECONDS = 4;
export const REGULAR_FREEFALL_RAPID_LOOKBACK_SECONDS = 4;
export const REGULAR_FREEFALL_RAPID_THRESHOLD_PCT = 0.5;
export const REGULAR_FREEFALL_ADVERSE_EXCURSION_LOOKBACK_SECONDS = 5;
export const REGULAR_FREEFALL_ADVERSE_EXCURSION_THRESHOLD_PCT = 0.1;
export const REGULAR_FREEFALL_ADVERSE_EXCURSION_RECOVERY_SECONDS = 3;

export interface RegularFreefallGuardInput {
  samples: Array<{
    price: number;
    ts: number;
    oraclePublishedAtMs?: number | null;
    oracleAgeMs?: number | null;
  }>;
  side: "yes" | "no";
  nowMs: number;
  windowStartMs: number;
  closeTimeMs: number;
  targetPrice: number;
  hasProduct: boolean;
  authoritativeCommodityCadence?: boolean;
}

export interface RegularFreefallGuardDecision extends FreefallPreSubmitDecision {
  deferredUnavailable: boolean;
  secondsRemaining: number;
}

/**
 * Pure final regular-entry conviction boundary. It deliberately has no
 * retained observations: callers provide only samples from the active market
 * lifecycle and `windowStartMs` is forwarded as the policy's hard observation
 * boundary. Thus observations from a prior strike/window cannot make a new
 * regular entry look safe.
 *
 * Unlike the optional Scalper excursion layer, every regular detector is
 * mandatory. Missing product/strike/spot evidence, stale or warming samples,
 * and target-side violations are all machine-readable fail-closed verdicts.
 */
export function evaluateRegularFreefallPreSubmitGuard(
  input: RegularFreefallGuardInput,
): RegularFreefallGuardDecision {
  const secondsRemaining = Number.isFinite(input.closeTimeMs)
    ? Math.max(0, (input.closeTimeMs - input.nowMs) / 1_000)
    : 0;
  if (!input.hasProduct) {
    return {
      allowed: false,
      reason: "freefall_unavailable_no_product",
      guardResult: null,
      sampleCoverageMs: null,
      deferredUnavailable: false,
      secondsRemaining,
    };
  }

  // Use the shared evaluator directly rather than the Scalper pre-submit
  // adapter: that adapter intentionally makes an unavailable *optional*
  // adverse-excursion layer non-vetoing. Regular conviction requires this
  // complete evidence set before every submission.
  const guardResult = checkFreefallGuard({
    samples: input.samples.map((sample) => ({
      price: sample.price,
      at: sample.ts,
      oraclePublishedAtMs: sample.oraclePublishedAtMs,
      oracleAgeMs: sample.oracleAgeMs,
    })),
    side: input.side,
    nowMs: input.nowMs,
    directionEnabled: true,
    eligibilityStartMs: input.windowStartMs,
    consecutiveSeconds: REGULAR_FREEFALL_CONSECUTIVE_SECONDS,
    favorableTrendConfirmationEnabled: true,
    coordinatedDirectionClearanceEnabled: false,
    targetPrice: input.targetPrice,
    secondsRemaining,
    rapidMoveEnabled: true,
    rapidMoveLookbackSeconds: REGULAR_FREEFALL_RAPID_LOOKBACK_SECONDS,
    rapidMoveThresholdPct: REGULAR_FREEFALL_RAPID_THRESHOLD_PCT,
    adverseExcursionEnabled: true,
    adverseExcursionLookbackSeconds:
      REGULAR_FREEFALL_ADVERSE_EXCURSION_LOOKBACK_SECONDS,
    adverseExcursionThresholdPct:
      REGULAR_FREEFALL_ADVERSE_EXCURSION_THRESHOLD_PCT,
    adverseExcursionRecoverySeconds:
      REGULAR_FREEFALL_ADVERSE_EXCURSION_RECOVERY_SECONDS,
    requireDistinctOraclePublishTimes: input.authoritativeCommodityCadence,
    authoritativeCommodityCadence: input.authoritativeCommodityCadence,
  });

  return {
    allowed: guardResult.evaluable && !guardResult.blocked,
    reason: guardResult.evaluable && !guardResult.blocked
      ? null
      : guardResult.reason ?? "freefall_blocked_final",
    guardResult,
    sampleCoverageMs: guardResult.observedSpanMs || null,
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