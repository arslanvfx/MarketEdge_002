import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createCoalescedAsyncRunner,
  findSlowestScalpLatencyStage,
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
      totalMs,
      queueWaitMs: 10,
      capClaimMs: 20,
      identityRefreshMs: 30,
      quoteRefreshMs: 40,
      parallelRefreshMs: 50,
      intentWriteMs: null,
      brokerSubmitMs: null,
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
      p99Ms: 10_000,
      maxMs: 10_000,
    });
  });

  it("finds the slowest measured stage", () => {
    assert.deepEqual(findSlowestScalpLatencyStage({
      queueWaitMs: 15,
      capClaimMs: 81,
      parallelRefreshMs: 40,
      intentWriteMs: 6,
      brokerSubmitMs: 25,
      decisionFinalizeMs: 12,
    }), { stage: "cap_claim", latencyMs: 81 });
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
