import type {
  ScalpAttemptLatency,
  ScalpLatencyStage,
  ScalpLatencySummary,
} from "./kalshi-scalper-types.ts";

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

const STAGES: ScalpLatencyStage[] = [
  "queue_wait",
  "cap_claim",
  "parallel_refresh",
  "intent_write",
  "broker_submit",
  "decision_finalize",
];

export function findSlowestScalpLatencyStage(
  latency: Pick<
    ScalpAttemptLatency,
    "queueWaitMs" | "capClaimMs" | "parallelRefreshMs" | "intentWriteMs" | "brokerSubmitMs" | "decisionFinalizeMs"
  >,
): { stage: ScalpLatencyStage | null; latencyMs: number | null } {
  const values: Record<ScalpLatencyStage, number | null> = {
    queue_wait: latency.queueWaitMs,
    cap_claim: latency.capClaimMs,
    parallel_refresh: latency.parallelRefreshMs,
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
  return {
    sampleSize: totals.length,
    p50Ms: percentile(totals, 0.5),
    p90Ms: percentile(totals, 0.9),
    p99Ms: percentile(totals, 0.99),
    maxMs: totals.length > 0 ? Math.round(Math.max(...totals) * 10) / 10 : null,
  };
}
