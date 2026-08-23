import type {
  ScalpAttemptLatency,
  ScalpFunnelEventStage,
  ScalpLatencyStage,
  ScalpLatencyStageSummary,
  ScalpLatencySummary,
  ScalpMode,
  ScalpWindowFunnel,
  ScalpWindowFunnelReport,
} from "./kalshi-scalper-types.ts";

export interface ScalpFunnelEvent {
  mode: ScalpMode;
  windowKey: string;
  symbol: string;
  stage: ScalpFunnelEventStage;
}

/**
 * Deliver observational funnel events with bounded retries and process-safe
 * timers. The returned recorder is deliberately independent of trading state:
 * failures cannot change admission, ownership, exposure, or breaker behavior.
 */
export function createBoundedScalpFunnelRecorder(
  write: (event: ScalpFunnelEvent) => Promise<void>,
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    scheduleRetry?: (callback: () => void, delayMs: number) => void;
  } = {},
): {
  record: (event: ScalpFunnelEvent) => void;
  clearExceptWindow: (windowKey: string) => void;
} {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const retryDelayMs = Math.max(1, Math.floor(options.retryDelayMs ?? 250));
  // A key remains pending while a retry is scheduled. Once its bounded budget
  // is exhausted it becomes settled (dropped) for this window, just like a
  // persisted event, so a fast scan cannot create parallel retry sequences.
  const pending = new Set<string>();
  const settled = new Set<string>();
  const keyOf = (event: ScalpFunnelEvent) =>
    `${event.mode}:${event.windowKey}:${event.symbol}:${event.stage}`;
  const scheduleRetry = options.scheduleRetry ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
  });

  const attemptWrite = (event: ScalpFunnelEvent, attempt: number): void => {
    const key = keyOf(event);
    if (settled.has(key) || pending.has(key)) return;
    pending.add(key);
    void write(event)
      .then(() => {
        settled.add(key);
        pending.delete(key);
      })
      .catch(() => {
        if (attempt < maxAttempts) {
          scheduleRetry(
            () => {
              // Retain the pending claim across the scheduled gap while still
              // allowing this sole retry sequence to re-enter the writer.
              pending.delete(key);
              attemptWrite(event, attempt + 1);
            },
            retryDelayMs * attempt,
          );
        } else {
          settled.add(key);
          pending.delete(key);
        }
      });
  };

  return {
    record: (event) => attemptWrite(event, 1),
    clearExceptWindow: (windowKey) => {
      for (const key of settled) {
        if (!key.includes(`:${windowKey}:`)) settled.delete(key);
      }
    },
  };
}

export interface CoalescedAsyncRunner {
  run: () => Promise<void>;
  isRunning: () => boolean;
  hasPendingRun: () => boolean;
}

/**
 * Runs one async pass at a time and collapses any number of overlapping requests
 * into exactly one immediate follow-up pass. This prevents scan ticks from being
 * silently lost without allowing overlapping candidate execution.
 */
export function createCoalescedAsyncRunner(
  work: () => Promise<void>,
): CoalescedAsyncRunner {
  let inFlight: Promise<void> | null = null;
  let pending = false;

  const run = (): Promise<void> => {
    pending = true;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      while (pending) {
        pending = false;
        await work();
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    run,
    isRunning: () => inFlight != null,
    hasPendingRun: () => pending,
  };
}

export type ScalpSampleQueuePriority = "authoritative" | "background";

/**
 * Select the next sample class while keeping one execution lane unavailable to
 * background work. Authoritative work may use every lane.
 */
export function selectNextScalpSamplePriority(input: {
  activeTotal: number;
  activeBackground: number;
  maxTotal: number;
  maxBackground: number;
  authoritativeQueued: number;
  backgroundQueued: number;
}): ScalpSampleQueuePriority | null {
  if (input.activeTotal >= input.maxTotal) return null;
  if (input.authoritativeQueued > 0) return "authoritative";
  if (
    input.backgroundQueued > 0
    && input.activeBackground < input.maxBackground
  ) {
    return "background";
  }
  return null;
}

/**
 * Keep every independently-qualified symbol in the bounded execution queue,
 * while making the earliest-closing and most at-risk band quote run first.
 * This is scheduling only: it never admits an unqualified symbol or changes
 * the per-symbol/window reservation, cap, or guard rules.
 */
export function prioritizeScalpCandidates<T extends {
  symbol: string;
  closeTime: string;
  winningAsk: number;
}>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => (
    Date.parse(a.closeTime) - Date.parse(b.closeTime)
    || b.winningAsk - a.winningAsk
    || a.symbol.localeCompare(b.symbol)
  ));
}

/** Database-shaped counters kept separate from the pure report formatter. */
export interface ScalpWindowFunnelCounters {
  windowKey: string;
  candidateSymbols: number;
  eligibleQuotes: number;
  finalQuoteLoss: number;
  safetyBlocks: number;
  submissions: number;
  zeroFills: number;
  confirmedFills: number;
  lastActivityAt: Date;
}

function funnelCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Format durable funnel counters for the API. This remains intentionally pure
 * so quote churn and zero-fill accounting can be regression-tested without a
 * database or an exchange connection.
 */
export function buildScalpWindowFunnelReport(
  mode: ScalpMode,
  rows: readonly ScalpWindowFunnelCounters[],
): ScalpWindowFunnelReport {
  const windows: ScalpWindowFunnel[] = rows.map((row) => ({
    windowKey: row.windowKey,
    candidateSymbols: funnelCount(row.candidateSymbols),
    eligibleQuotes: funnelCount(row.eligibleQuotes),
    finalQuoteLoss: funnelCount(row.finalQuoteLoss),
    safetyBlocks: funnelCount(row.safetyBlocks),
    submissions: funnelCount(row.submissions),
    zeroFills: funnelCount(row.zeroFills),
    confirmedFills: funnelCount(row.confirmedFills),
    lastActivityAt: row.lastActivityAt.toISOString(),
  }));
  const activeWindows = windows.length;
  const totalFills = windows.reduce((total, window) => total + window.confirmedFills, 0);
  return {
    mode,
    targetMinFills: 2,
    targetMaxFills: 3,
    activeWindows,
    averageConfirmedFills: activeWindows > 0
      ? Math.round((totalFills / activeWindows) * 100) / 100
      : null,
    windowsAtTarget: windows.filter(
      (window) => window.confirmedFills >= 2 && window.confirmedFills <= 3,
    ).length,
    windows,
  };
}

const STAGES: ScalpLatencyStage[] = [
  "queue_wait",
  "cap_claim",
  "parallel_refresh",
  "final_requote",
  "intent_write",
  "broker_submit",
  "decision_finalize",
];

export function findSlowestScalpLatencyStage(
  latency: Pick<
    ScalpAttemptLatency,
    "queueWaitMs" | "capClaimMs" | "parallelRefreshMs" | "finalRequoteMs" | "intentWriteMs" | "brokerSubmitMs" | "decisionFinalizeMs"
  >,
): { stage: ScalpLatencyStage | null; latencyMs: number | null } {
  const values: Record<ScalpLatencyStage, number | null> = {
    queue_wait: latency.queueWaitMs,
    cap_claim: latency.capClaimMs,
    parallel_refresh: latency.parallelRefreshMs,
    final_requote: latency.finalRequoteMs,
    intent_write: latency.intentWriteMs,
    broker_submit: latency.brokerSubmitMs,
    decision_finalize: latency.decisionFinalizeMs,
  };
  let stage: ScalpLatencyStage | null = null;
  let latencyMs: number | null = null;
  for (const candidate of STAGES) {
    const value = values[candidate];
    if (value == null || !Number.isFinite(value)) continue;
    if (latencyMs == null || value > latencyMs) {
      stage = candidate;
      latencyMs = value;
    }
  }
  return { stage, latencyMs };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return Math.round(sorted[Math.min(rank, sorted.length - 1)] * 10) / 10;
}

export function summarizeScalpAttemptLatencies(
  attempts: readonly ScalpAttemptLatency[],
): ScalpLatencySummary {
  const totals = attempts
    .map((attempt) => attempt.totalMs)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const stages: ScalpLatencyStageSummary[] = STAGES.map((stage) => {
    const values = attempts
      .map((attempt) => {
        const stageValues: Record<ScalpLatencyStage, number | null> = {
          queue_wait: attempt.queueWaitMs,
          cap_claim: attempt.capClaimMs,
          parallel_refresh: attempt.parallelRefreshMs,
          final_requote: attempt.finalRequoteMs,
          intent_write: attempt.intentWriteMs,
          broker_submit: attempt.brokerSubmitMs,
          decision_finalize: attempt.decisionFinalizeMs,
        };
        return stageValues[stage];
      })
      .filter(
        (value): value is number =>
          value != null && Number.isFinite(value) && value >= 0,
      );
    return {
      stage,
      sampleSize: values.length,
      p50Ms: percentile(values, 0.5),
      p90Ms: percentile(values, 0.9),
      p99Ms: percentile(values, 0.99),
      maxMs: values.length > 0 ? Math.round(Math.max(...values) * 10) / 10 : null,
    };
  });
  const dominant = stages.reduce<ScalpLatencyStageSummary | null>((current, stage) => {
    if (stage.p90Ms == null) return current;
    if (current?.p90Ms == null || stage.p90Ms > current.p90Ms) return stage;
    return current;
  }, null);
  return {
    sampleSize: totals.length,
    p50Ms: percentile(totals, 0.5),
    p90Ms: percentile(totals, 0.9),
    p99Ms: percentile(totals, 0.99),
    maxMs: totals.length > 0 ? Math.round(Math.max(...totals) * 10) / 10 : null,
    stages,
    dominantStage: dominant?.stage ?? null,
    dominantStageP90Ms: dominant?.p90Ms ?? null,
  };
}
