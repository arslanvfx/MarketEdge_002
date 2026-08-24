// ---------------------------------------------------------------------------
// kalshi-scalper-shadow.ts — Pure, counterfactual earlier-entry evaluation.
//
// This module deliberately has no database, balance, reservation, order-intent,
// reconciliation, or exchange-submission imports.
// ---------------------------------------------------------------------------

import {
  checkTargetProximityGuard,
  computeScalpPnl,
  evaluateFreefallPreSubmitGuard,
  FREEFALL_MAX_SAMPLE_AGE_MS,
  selectScalpSide,
  type FreefallSample,
} from "./kalshi-scalper-policy.ts";
import type {
  EffectiveScalpParams,
  ScalpConfig,
  ScalpMode,
  ScalpShadowActualSummary,
  ScalpShadowStudyReport,
  ScalpShadowStudyRecord,
  ScalpShadowVariantSummary,
  ScalpShadowVariantSeconds,
} from "./kalshi-scalper-types.ts";
import { SCALP_SHADOW_VARIANT_SECONDS } from "./kalshi-scalper-types.ts";

export interface ScalpShadowEvaluation {
  started: boolean;
  closed: boolean;
  allowed: boolean;
  blocker: string | null;
  side: "yes" | "no" | null;
  yesAsk: number | null;
  noAsk: number | null;
  winningAsk: number | null;
  secondsRemaining: number;
  evidence: Record<string, unknown> | null;
}

function finitePrice(value: number | null | undefined): number | null {
  return Number.isFinite(value) && (value ?? 0) > 0 && (value ?? 0) < 1
    ? value!
    : null;
}

/**
 * Evaluate one 120s/105s/90s counterfactual with the same directional and
 * target-distance guard functions used at the live pre-submit boundary.
 *
 * eligibilityStartMs is variant-specific, so the guard must warm up from that
 * hypothetical opening boundary rather than borrowing older samples.
 */
export function evaluateScalpShadowEntry(input: {
  nowMs: number;
  closeTime: string;
  variantSeconds: ScalpShadowVariantSeconds;
  ticker: string | null;
  expectedCloseTime: string;
  yesAsk: number | null | undefined;
  yesBid: number | null | undefined;
  targetPrice: number | null | undefined;
  samples: FreefallSample[];
  config: ScalpConfig;
  params: EffectiveScalpParams;
}): ScalpShadowEvaluation {
  const cachedCloseMs = Date.parse(input.closeTime);
  const expectedCloseMs = Date.parse(input.expectedCloseTime);
  // The expected window boundary is the one and only study clock. A cached
  // close time may validate identity within tolerance, but can never shift
  // variant opening, guard warmup, or reported seconds remaining.
  const closeMs = expectedCloseMs;
  const secondsRemaining = Number.isFinite(expectedCloseMs)
    ? (expectedCloseMs - input.nowMs) / 1_000
    : Number.NaN;
  const base = {
    started: Number.isFinite(secondsRemaining)
      && secondsRemaining <= input.variantSeconds,
    closed: !Number.isFinite(secondsRemaining) || secondsRemaining <= 0,
    allowed: false,
    side: null,
    yesAsk: finitePrice(input.yesAsk),
    noAsk: finitePrice(
      finitePrice(input.yesBid) == null ? null : 1 - finitePrice(input.yesBid)!,
    ),
    winningAsk: null,
    secondsRemaining,
    evidence: null,
  } satisfies Omit<ScalpShadowEvaluation, "blocker">;

  if (!base.started) return { ...base, blocker: "before_variant_window" };
  if (base.closed) return { ...base, blocker: "window_closed" };
  if (
    !input.ticker
    || !Number.isFinite(cachedCloseMs)
    || !Number.isFinite(expectedCloseMs)
    || Math.abs(cachedCloseMs - expectedCloseMs) > 30_000
  ) {
    return { ...base, blocker: "market_identity_invalid" };
  }

  const match = selectScalpSide(
    base.yesAsk,
    base.noAsk,
    input.params.bandMin,
    input.params.bandMax,
  );
  if (!match) {
    const quotePresent = base.yesAsk != null || base.noAsk != null;
    return {
      ...base,
      blocker: quotePresent ? "quote_outside_band" : "quote_invalid",
      evidence: {
        schemaVersion: 1,
        quoteState: quotePresent ? "outside_band" : "invalid",
        bandMin: input.params.bandMin,
        bandMax: input.params.bandMax,
      },
    };
  }

  const latestSample = input.samples
    .filter((sample) =>
      Number.isFinite(sample.at)
      && sample.at <= input.nowMs
      && Number.isFinite(sample.price)
      && sample.price > 0
    )
    .at(-1) ?? null;
  const freshSampleSucceeded = latestSample != null
    && input.nowMs - latestSample.at <= FREEFALL_MAX_SAMPLE_AGE_MS;
  const targetPrice = Number(input.targetPrice);
  const guard = evaluateFreefallPreSubmitGuard({
    directionEnabled: input.config.freefallGuardEnabled,
    hasProduct: true,
    freshSampleSucceeded,
    samples: input.samples,
    side: match.side,
    nowMs: input.nowMs,
    eligibilityStartMs: closeMs - input.variantSeconds * 1_000,
    consecutiveSeconds: input.config.freefallConsecutiveSeconds,
    favorableTrendConfirmationEnabled:
      input.config.favorableTrendConfirmationEnabled,
    coordinatedDirectionClearanceEnabled:
      input.config.coordinatedDirectionClearanceEnabled,
    targetPrice,
    targetProximityGuardEnabled:
      input.config.targetProximityGuardEnabled,
    targetProximityThresholdPct:
      input.config.targetProximityThresholdPct,
    secondsRemaining,
    rapidMoveEnabled: input.config.rapidMoveGuardEnabled,
    rapidMoveLookbackSeconds: input.config.rapidMoveLookbackSeconds,
    rapidMoveThresholdPct: input.config.rapidMoveThresholdPct,
  });

  let targetAllowed = true;
  let targetReason: string | null = null;
  let targetDistancePct: number | null = null;
  if (input.config.targetProximityGuardEnabled) {
    const target = checkTargetProximityGuard(
      latestSample?.price,
      targetPrice,
      input.config.targetProximityThresholdPct,
    );
    targetAllowed = target.evaluable && !target.blocked;
    targetReason = targetAllowed
      ? null
      : target.reason ?? "target_proximity_blocked";
    targetDistancePct = target.distancePct;
  }

  const blocker = !guard.allowed
    ? guard.reason ?? "direction_guard_blocked"
    : !targetAllowed
      ? targetReason
      : null;
  return {
    ...base,
    allowed: blocker == null,
    blocker,
    side: match.side,
    winningAsk: match.winningAsk,
    evidence: {
      schemaVersion: 1,
      counterfactualOnly: true,
      cachedQuoteNotFillProof: true,
      evaluatedAt: new Date(input.nowMs).toISOString(),
      variantSeconds: input.variantSeconds,
      secondsRemaining,
      side: match.side,
      quoteState: "in_band",
      yesAsk: base.yesAsk,
      noAsk: base.noAsk,
      winningAsk: match.winningAsk,
      bandMin: input.params.bandMin,
      bandMax: input.params.bandMax,
      targetPrice: Number.isFinite(targetPrice) ? targetPrice : null,
      targetDistancePct,
      directionGuardAllowed: guard.allowed,
      directionGuardReason: guard.reason,
      directionGuardResult: guard.guardResult,
      targetGuardAllowed: targetAllowed,
      targetGuardReason: targetReason,
    },
  };
}

export interface BoundedScalpShadowWriter {
  record: (record: ScalpShadowStudyRecord) => boolean;
  pending: () => number;
}

export function settleScalpShadowRecord(
  record: ScalpShadowStudyRecord,
  settlementResult: "yes" | "no",
  settledAt = new Date().toISOString(),
): ScalpShadowStudyRecord {
  if (
    !record.side
    || record.winningAsk == null
    || record.hypotheticalContracts < 1
  ) {
    throw new Error("Shadow record has no hypothetical entry to settle");
  }
  const avgYesPrice = record.side === "yes"
    ? record.winningAsk
    : 1 - record.winningAsk;
  return {
    ...record,
    status: "settled",
    settlementResult,
    outcome: record.side === settlementResult ? "win" : "loss",
    hypotheticalPnl: computeScalpPnl(
      record.mode,
      record.side,
      record.hypotheticalContracts,
      avgYesPrice,
      settlementResult,
    ),
    updatedAt: settledAt,
    settledAt,
  };
}

export function resolveScalpShadowStudyScope(input: {
  performanceTrackingSince: Date;
  studyStartedAt: Date | null;
  requestedTrackingSince: string | null;
  scopeEnd: Date;
}): { scopeStart: Date; scopeEnd: Date } {
  const endMs = input.scopeEnd.getTime();
  if (!Number.isFinite(endMs)) {
    throw new Error("Invalid Shadow study scope end");
  }
  const requestedMs = input.requestedTrackingSince == null
    ? Number.NEGATIVE_INFINITY
    : Date.parse(input.requestedTrackingSince);
  const starts = [
    input.performanceTrackingSince.getTime(),
    input.studyStartedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    Number.isFinite(requestedMs) ? requestedMs : Number.NEGATIVE_INFINITY,
  ].filter(Number.isFinite);
  const latestStart = starts.length > 0 ? Math.max(...starts) : endMs;
  return {
    scopeStart: new Date(Math.min(latestStart, endMs)),
    scopeEnd: new Date(endMs),
  };
}

export function summarizeScalpShadowStudyRows(
  rows: readonly ScalpShadowStudyRecord[],
  variantSeconds: readonly number[],
): ScalpShadowVariantSummary[] {
  return variantSeconds.map((seconds) => {
    const variantRows = rows.filter(
      (row) => row.variantSeconds === seconds,
    );
    const candidates = variantRows.filter(
      (row) => row.firstSafeEntryAt != null,
    );
    const settled = candidates.filter(
      (row) => row.settlementResult != null,
    );
    const wins = settled.filter((row) => row.outcome === "win").length;
    const losses = settled.filter((row) => row.outcome === "loss").length;
    const firstSafeSeconds = candidates
      .map((row) => row.firstSafeSecondsRemaining)
      .filter((value): value is number => value != null);
    return {
      variantSeconds: seconds,
      observed: variantRows.length,
      candidates: candidates.length,
      settled: settled.length,
      wins,
      losses,
      winRate: settled.length > 0 ? (wins / settled.length) * 100 : null,
      candidatesBeforeLaterQuoteIssue: candidates.filter(
        (row) => row.laterQuoteIssueObserved,
      ).length,
      averageFirstSafeSecondsRemaining: firstSafeSeconds.length > 0
        ? firstSafeSeconds.reduce((sum, value) => sum + value, 0)
          / firstSafeSeconds.length
        : null,
      hypotheticalPnl: settled.reduce(
        (sum, row) => sum + (row.hypotheticalPnl ?? 0),
        0,
      ),
    };
  });
}

function emptyActualSummary(
  periodStart: string,
  periodEnd: string,
): ScalpShadowActualSummary {
  return {
    periodStart,
    periodEnd,
    filledOrders: 0,
    settled: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    totalPnl: 0,
    totalSpent: 0,
  };
}

export function buildScalpShadowStudyReport(
  mode: ScalpMode,
  rows: ScalpShadowStudyRecord[],
  options?: {
    configuredWindowSeconds?: number;
    effectiveWindowSecondsBySymbol?: Record<string, number>;
    trackingSince?: string | null;
    variantSeconds?: readonly number[];
    variantSummaries?: readonly ScalpShadowVariantSummary[];
    recentRows?: ScalpShadowStudyRecord[];
    studyStartedAt?: string | null;
    scopeStart?: string;
    scopeEnd?: string;
    actualComparison?: ScalpShadowActualSummary;
    actualOutsideShadowCoverage?: ScalpShadowActualSummary | null;
  },
): ScalpShadowStudyReport {
  const configuredWindowSeconds = options?.configuredWindowSeconds ?? 120;
  const effectiveWindowSecondsBySymbol =
    options?.effectiveWindowSecondsBySymbol ?? {};
  const variantSeconds = [
    ...new Set(
      options?.variantSeconds ?? [
        ...SCALP_SHADOW_VARIANT_SECONDS,
        configuredWindowSeconds,
        ...Object.values(effectiveWindowSecondsBySymbol),
        ...(options?.variantSummaries ?? []).map(
          (summary) => summary.variantSeconds,
        ),
      ],
    ),
  ]
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= 900)
    .sort((a, b) => a - b);
  const computedSummaries = summarizeScalpShadowStudyRows(rows, variantSeconds);
  const suppliedSummaries = new Map(
    (options?.variantSummaries ?? []).map(
      (summary) => [summary.variantSeconds, summary],
    ),
  );
  const variants = computedSummaries.map(
    (summary) => suppliedSummaries.get(summary.variantSeconds) ?? summary,
  );
  const observedDates = rows
    .flatMap((row) => [Date.parse(row.createdAt), Date.parse(row.updatedAt)])
    .filter(Number.isFinite);
  const fallbackStart = options?.trackingSince
    ?? (observedDates.length > 0
      ? new Date(Math.min(...observedDates)).toISOString()
      : new Date(0).toISOString());
  const fallbackEnd = observedDates.length > 0
    ? new Date(Math.max(...observedDates)).toISOString()
    : fallbackStart;
  const scopeStart = options?.scopeStart ?? fallbackStart;
  const scopeEnd = options?.scopeEnd ?? fallbackEnd;
  return {
    mode,
    configuredWindowSeconds,
    effectiveWindowSecondsBySymbol,
    trackingSince: options?.trackingSince ?? null,
    studyStartedAt: options?.studyStartedAt ?? (
      observedDates.length > 0
        ? new Date(Math.min(...observedDates)).toISOString()
        : null
    ),
    scopeStart,
    scopeEnd,
    actualComparison: options?.actualComparison
      ?? emptyActualSummary(scopeStart, scopeEnd),
    actualOutsideShadowCoverage:
      options?.actualOutsideShadowCoverage ?? null,
    variants,
    recent: (options?.recentRows ?? rows).slice(0, 48),
    disclaimer:
      "Counterfactual cached quotes only. Shadow timing cards and actual Scalper totals share the displayed time scope, but they are different bets. Passing the study does not prove an IOC order would have filled, and shadow rows never affect live execution or performance totals.",
  };
}

/**
 * Single-lane, coalescing, bounded best-effort writer. A full queue drops new
 * shadow work; it never back-pressures the live scan loop.
 */
export function createBoundedScalpShadowWriter(
  persist: (record: ScalpShadowStudyRecord) => Promise<void>,
  maxPending = 36,
): BoundedScalpShadowWriter {
  const pending = new Map<string, ScalpShadowStudyRecord>();
  let active = false;
  const keyOf = (record: ScalpShadowStudyRecord) =>
    `${record.mode}:${record.windowKey}:${record.symbol}:${record.variantSeconds}`;

  const drain = (): void => {
    if (active) return;
    const next = pending.entries().next().value as
      | [string, ScalpShadowStudyRecord]
      | undefined;
    if (!next) return;
    const [key, record] = next;
    pending.delete(key);
    active = true;
    void persist(record)
      .catch(() => {
        // Observational storage is explicitly best effort.
      })
      .finally(() => {
        active = false;
        drain();
      });
  };

  return {
    record(record) {
      const key = keyOf(record);
      if (!pending.has(key) && pending.size >= maxPending) return false;
      pending.set(key, record);
      drain();
      return true;
    },
    pending: () => pending.size + (active ? 1 : 0),
  };
}