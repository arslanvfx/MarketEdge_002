import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createCoalescedAsyncRunner,
  buildScalpWindowFunnelReport,
  createBoundedScalpFunnelRecorder,
  findSlowestScalpLatencyStage,
  prioritizeScalpCandidates,
  selectNextScalpSamplePriority,
  summarizeScalpAttemptLatencies,
} from "./kalshi-scalper-fast-path.ts";
import type { ScalpAttemptLatency } from "./kalshi-scalper-types.ts";
import {
  SCALP_PREFLIGHT_EARLY_REFRESH_MS,
  SCALP_PREFLIGHT_LEAD_SECONDS,
  SCALP_PREFLIGHT_REFRESH_MS,
  scalpPreflightRefreshMs,
} from "./kalshi-scalper-policy.ts";

describe("createCoalescedAsyncRunner", () => {
  it("turns overlapping scan requests into one immediate follow-up pass", async () => {
    let releaseFirst!: () => void;
    const firstPassBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let passes = 0;
    const runner = createCoalescedAsyncRunner(async () => {
      passes += 1;
      if (passes === 1) await firstPassBlocked;
    });

    const first = runner.run();
    const second = runner.run();
    const third = runner.run();
    assert.equal(runner.isRunning(), true);
    assert.equal(runner.hasPendingRun(), true);

    releaseFirst();
    await Promise.all([first, second, third]);
    assert.equal(passes, 2);
    assert.equal(runner.isRunning(), false);
    assert.equal(runner.hasPendingRun(), false);
  });
});

describe("createBoundedScalpFunnelRecorder", () => {
  it("retries a failed terminal-stage write without holding the process open", async () => {
    let writes = 0;
    const delivered: string[] = [];
    const scheduled: Array<() => void> = [];
    const recorder = createBoundedScalpFunnelRecorder(
      async (event) => {
        writes += 1;
        if (writes === 1) throw new Error("transient database failure");
        delivered.push(`${event.symbol}:${event.stage}`);
      },
      {
        maxAttempts: 3,
        retryDelayMs: 1,
        scheduleRetry: (callback) => scheduled.push(callback),
      },
    );
    recorder.record({
      mode: "live",
      windowKey: "W-terminal",
      symbol: "BTC",
      stage: "final_quote_loss",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(scheduled.length, 1);
    scheduled.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writes, 2);
    assert.deepEqual(delivered, ["BTC:final_quote_loss"]);
  });

  it("coalesces repeated outage reports into one bounded retry sequence", async () => {
    let writes = 0;
    const scheduled: Array<() => void> = [];
    const recorder = createBoundedScalpFunnelRecorder(
      async () => {
        writes += 1;
        throw new Error("database unavailable");
      },
      {
        maxAttempts: 3,
        retryDelayMs: 1,
        scheduleRetry: (callback) => scheduled.push(callback),
      },
    );
    const event = {
      mode: "paper" as const,
      windowKey: "W-outage",
      symbol: "ETH",
      stage: "authenticated_eligible" as const,
    };

    recorder.record(event);
    for (let i = 0; i < 20; i += 1) recorder.record(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writes, 1);
    assert.equal(scheduled.length, 1);

    while (scheduled.length > 0) {
      scheduled.shift()?.();
      for (let i = 0; i < 20; i += 1) recorder.record(event);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(writes, 3);

    for (let i = 0; i < 20; i += 1) recorder.record(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writes, 3);
  });
});

describe("prioritizeScalpCandidates", () => {
  it("keeps multiple independently-qualified symbols while ordering the most urgent first", () => {
    const candidates = prioritizeScalpCandidates([
      { symbol: "SOL", closeTime: "2026-08-23T12:15:00.000Z", winningAsk: 0.92 },
      { symbol: "BTC", closeTime: "2026-08-23T12:15:00.000Z", winningAsk: 0.97 },
      { symbol: "ETH", closeTime: "2026-08-23T12:14:00.000Z", winningAsk: 0.93 },
    ]);
    assert.deepEqual(candidates.map((candidate) => candidate.symbol), ["ETH", "BTC", "SOL"]);
    assert.equal(candidates.length, 3);
  });

  it("gives a re-armed authenticated candidate the next bounded lane", () => {
    const candidates = prioritizeScalpCandidates([
      { symbol: "BTC", closeTime: "2026-08-23T12:15:00.000Z", winningAsk: 0.99 },
      { symbol: "WTI", closeTime: "2026-08-23T12:15:00.000Z", winningAsk: 0.95, retryReady: true },
    ]);
    assert.deepEqual(candidates.map((candidate) => candidate.symbol), ["WTI", "BTC"]);
  });
});

describe("buildScalpWindowFunnelReport", () => {
  it("retains quote churn alongside a later confirmed fill", () => {
    const report = buildScalpWindowFunnelReport("live", [{
      windowKey: "W1",
      candidateSymbols: 3,
      preparationStarted: 3,
      claimsAcquired: 2,
      eligibleQuotes: 2,
      finalQuoteLoss: 1,
      guardRejected: 0,
      intentsPersisted: 2,
      brokerRequestsStarted: 2,
      safetyBlocks: 0,
      submissions: 2,
      zeroFills: 1,
      confirmedFills: 1,
      lastActivityAt: new Date("2026-08-23T12:15:00.000Z"),
    }]);
    assert.equal(report.windows[0]?.finalQuoteLoss, 1);
    assert.equal(report.windows[0]?.eligibleQuotes, 2);
    assert.equal(report.windows[0]?.zeroFills, 1);
    assert.equal(report.windows[0]?.confirmedFills, 1);
    assert.equal(report.averageConfirmedFills, 1);
  });

  it("reports a zero-fill window without manufacturing a confirmed fill", () => {
    const report = buildScalpWindowFunnelReport("paper", [{
      windowKey: "W2",
      candidateSymbols: 2,
      preparationStarted: 2,
      claimsAcquired: 1,
      eligibleQuotes: 2,
      finalQuoteLoss: 0,
      guardRejected: 1,
      intentsPersisted: 1,
      brokerRequestsStarted: 1,
      safetyBlocks: 1,
      submissions: 1,
      zeroFills: 1,
      confirmedFills: 0,
      lastActivityAt: new Date("2026-08-23T12:30:00.000Z"),
    }]);
    assert.equal(report.windowsAtTarget, 0);
    assert.equal(report.windows[0]?.zeroFills, 1);
    assert.equal(report.windows[0]?.confirmedFills, 0);
  });
});

describe("selectNextScalpSamplePriority", () => {
  it("reserves one lane from background work", () => {
    assert.equal(selectNextScalpSamplePriority({
      activeTotal: 2,
      activeBackground: 2,
      maxTotal: 3,
      maxBackground: 2,
      authoritativeQueued: 0,
      backgroundQueued: 10,
    }), null);
  });

  it("starts authoritative work in the reserved lane immediately", () => {
    assert.equal(selectNextScalpSamplePriority({
      activeTotal: 2,
      activeBackground: 2,
      maxTotal: 3,
      maxBackground: 2,
      authoritativeQueued: 1,
      backgroundQueued: 10,
    }), "authoritative");
  });

  it("always selects authoritative work before background work", () => {
    assert.equal(selectNextScalpSamplePriority({
      activeTotal: 0,
      activeBackground: 0,
      maxTotal: 3,
      maxBackground: 2,
      authoritativeQueued: 2,
      backgroundQueued: 2,
    }), "authoritative");
  });
});

describe("Scalper latency summaries", () => {
  function latency(totalMs: number): ScalpAttemptLatency {
    return {
      mode: "paper",
      symbol: "BTC",
      windowKey: "W",
      detectedAt: "2026-08-22T00:00:00.000Z",
      completedAt: "2026-08-22T00:00:01.000Z",
      windowRemainingAtDetectedMs: 60_000,
      windowRemainingAtCompletionMs: 59_000,
      windowExpiredDuringAttempt: false,
      totalMs,
      queueWaitMs: 10,
      capClaimMs: 20,
      identityRefreshMs: 30,
      routedBalanceMs: 35,
      quoteRefreshMs: 40,
      parallelRefreshMs: 50,
      guardReadinessMs: 15,
      finalRequoteMs: 25,
      intentWriteMs: null,
      brokerSubmitMs: null,
      candidateToBrokerRequestMs: null,
      decisionFinalizeMs: 10,
      slowestStage: "parallel_refresh",
      slowestStageMs: 50,
    };
  }

  it("computes nearest-rank p50/p90/p99 without smoothing away tail latency", () => {
    const summary = summarizeScalpAttemptLatencies(
      [100, 200, 300, 400, 500, 600, 700, 800, 900, 10_000].map(latency),
    );
    assert.deepEqual(summary, {
      sampleSize: 10,
      p50Ms: 500,
      p90Ms: 900,
      p95Ms: 10_000,
      p99Ms: 10_000,
      maxMs: 10_000,
      stages: [
        { stage: "queue_wait", sampleSize: 10, p50Ms: 10, p90Ms: 10, p95Ms: 10, p99Ms: 10, maxMs: 10 },
        { stage: "cap_claim", sampleSize: 10, p50Ms: 20, p90Ms: 20, p95Ms: 20, p99Ms: 20, maxMs: 20 },
        { stage: "identity_refresh", sampleSize: 10, p50Ms: 30, p90Ms: 30, p95Ms: 30, p99Ms: 30, maxMs: 30 },
        { stage: "routed_balance", sampleSize: 10, p50Ms: 35, p90Ms: 35, p95Ms: 35, p99Ms: 35, maxMs: 35 },
        { stage: "authenticated_quote", sampleSize: 10, p50Ms: 40, p90Ms: 40, p95Ms: 40, p99Ms: 40, maxMs: 40 },
        { stage: "parallel_refresh", sampleSize: 10, p50Ms: 50, p90Ms: 50, p95Ms: 50, p99Ms: 50, maxMs: 50 },
        { stage: "guard_readiness", sampleSize: 10, p50Ms: 15, p90Ms: 15, p95Ms: 15, p99Ms: 15, maxMs: 15 },
        { stage: "final_requote", sampleSize: 10, p50Ms: 25, p90Ms: 25, p95Ms: 25, p99Ms: 25, maxMs: 25 },
        { stage: "intent_write", sampleSize: 0, p50Ms: null, p90Ms: null, p95Ms: null, p99Ms: null, maxMs: null },
        { stage: "broker_submit", sampleSize: 0, p50Ms: null, p90Ms: null, p95Ms: null, p99Ms: null, maxMs: null },
        { stage: "decision_finalize", sampleSize: 10, p50Ms: 10, p90Ms: 10, p95Ms: 10, p99Ms: 10, maxMs: 10 },
      ],
      dominantStage: "parallel_refresh",
      dominantStageP90Ms: 50,
      brokerRequestSampleSize: 0,
      brokerRequestStartP50Ms: null,
      brokerRequestStartP95Ms: null,
      brokerRequestStartP99Ms: null,
    });
  });

  it("finds the slowest measured stage", () => {
    assert.deepEqual(findSlowestScalpLatencyStage({
      queueWaitMs: 15,
      capClaimMs: 81,
      identityRefreshMs: 34,
      routedBalanceMs: 22,
      quoteRefreshMs: 28,
      parallelRefreshMs: 40,
      guardReadinessMs: 20,
      finalRequoteMs: 35,
      intentWriteMs: 6,
      brokerSubmitMs: 25,
      decisionFinalizeMs: 12,
    }), { stage: "cap_claim", latencyMs: 81 });
  });

  it("reports the controlled candidate-to-broker p95 against the one-second SLO", () => {
    const attempts = [410, 455, 480, 505, 530, 570, 610, 675, 740, 920]
      .map((candidateToBrokerRequestMs) => ({
        ...latency(candidateToBrokerRequestMs + 80),
        mode: "live" as const,
        candidateToBrokerRequestMs,
        intentWriteMs: 18,
        brokerSubmitMs: 80,
      }));
    const summary = summarizeScalpAttemptLatencies(attempts);
    assert.equal(summary.brokerRequestSampleSize, 10);
    assert.equal(summary.brokerRequestStartP50Ms, 530);
    assert.equal(summary.brokerRequestStartP95Ms, 920);
    assert.ok((summary.brokerRequestStartP95Ms ?? Infinity) < 1_000);
  });
});

describe("Scalper preflight cadence", () => {
  it("warms three minutes early but uses the fast cadence only near entry", () => {
    assert.equal(SCALP_PREFLIGHT_LEAD_SECONDS, 180);
    assert.equal(scalpPreflightRefreshMs(120), SCALP_PREFLIGHT_EARLY_REFRESH_MS);
    assert.equal(scalpPreflightRefreshMs(30), SCALP_PREFLIGHT_REFRESH_MS);
    assert.equal(scalpPreflightRefreshMs(0), SCALP_PREFLIGHT_REFRESH_MS);
  });
});
