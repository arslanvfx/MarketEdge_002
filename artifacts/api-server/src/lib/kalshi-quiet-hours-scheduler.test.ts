import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UTC_HOUR_MS,
  createNonOverlappingAsyncJob,
  createSerializedAsyncOperation,
  millisecondsUntilNextUtcHour,
  scheduleAtTopOfEveryUtcHour,
  utcHourMarker,
  isSmartHoursCalibrationCurrent,
  shouldRunSmartHoursCatchUp,
  shouldAttemptSmartHoursLoopRecovery,
} from "./kalshi-quiet-hours-scheduler.ts";

test("Smart Hours UTC marker is stable within an hour and changes at the boundary", () => {
  assert.equal(utcHourMarker(Date.parse("2026-08-19T14:00:00.000Z")), "2026-08-19T14");
  assert.equal(utcHourMarker(Date.parse("2026-08-19T14:59:59.999Z")), "2026-08-19T14");
  assert.equal(utcHourMarker(Date.parse("2026-08-19T15:00:00.000Z")), "2026-08-19T15");
});

test("Smart Hours readiness rejects a prior-hour marker at the exact boundary", () => {
  assert.equal(
    isSmartHoursCalibrationCurrent(
      "2026-08-19T14",
      Date.parse("2026-08-19T14:59:59.999Z"),
    ),
    true,
  );
  assert.equal(
    isSmartHoursCalibrationCurrent(
      "2026-08-19T14",
      Date.parse("2026-08-19T15:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    isSmartHoursCalibrationCurrent(
      "2026-08-19T15",
      Date.parse("2026-08-19T15:08:00.000Z"),
    ),
    true,
  );
});

test("restart catch-up runs when current UTC hour is uncalibrated in per_market mode", () => {
  const now = Date.parse("2026-08-19T15:20:00.000Z");
  // No marker at all → run.
  assert.equal(shouldRunSmartHoursCatchUp("per_market", undefined, now), true);
  // Marker for a previous hour → run.
  assert.equal(shouldRunSmartHoursCatchUp("per_market", "2026-08-19T14", now), true);
});

test("restart catch-up skips when the current UTC hour was already calibrated", () => {
  const now = Date.parse("2026-08-19T15:20:00.000Z");
  assert.equal(shouldRunSmartHoursCatchUp("per_market", "2026-08-19T15", now), false);
  // Even at the very end of the same hour, the same-hour marker still skips.
  assert.equal(
    shouldRunSmartHoursCatchUp("per_market", "2026-08-19T15", Date.parse("2026-08-19T15:59:59.999Z")),
    false,
  );
});

test("restart catch-up keeps per-market schedules fresh regardless of selected mode", () => {
  const now = Date.parse("2026-08-19T15:20:00.000Z");
  assert.equal(shouldRunSmartHoursCatchUp("global", undefined, now), true);
  assert.equal(shouldRunSmartHoursCatchUp(undefined, undefined, now), true);
  assert.equal(shouldRunSmartHoursCatchUp("global", "2026-08-19T14", now), true);
  assert.equal(shouldRunSmartHoursCatchUp("global", "2026-08-19T15", now), false);
});

test("bot-loop recovery runs when the durable hourly marker is stale", () => {
  const now = Date.parse("2026-08-19T15:02:00.000Z");
  assert.equal(shouldAttemptSmartHoursLoopRecovery("2026-08-19T14", 0, now), true);
  assert.equal(shouldAttemptSmartHoursLoopRecovery(undefined, 0, now), true);
});

test("bot-loop recovery does not duplicate a completed current-hour run", () => {
  const now = Date.parse("2026-08-19T15:20:00.000Z");
  assert.equal(
    shouldAttemptSmartHoursLoopRecovery("2026-08-19T15", 0, now),
    false,
  );
});

test("bot-loop recovery applies a bounded retry interval after an attempt", () => {
  const attemptedAt = Date.parse("2026-08-19T15:01:00.000Z");
  assert.equal(
    shouldAttemptSmartHoursLoopRecovery(
      "2026-08-19T14",
      attemptedAt,
      Date.parse("2026-08-19T15:05:59.999Z"),
    ),
    false,
  );
  assert.equal(
    shouldAttemptSmartHoursLoopRecovery(
      "2026-08-19T14",
      attemptedAt,
      Date.parse("2026-08-19T15:06:00.000Z"),
    ),
    true,
  );
});

test("bot-loop recovery retries after clock rollback instead of remaining stuck", () => {
  assert.equal(
    shouldAttemptSmartHoursLoopRecovery(
      "2026-08-19T14",
      Date.parse("2026-08-19T16:00:00.000Z"),
      Date.parse("2026-08-19T15:10:00.000Z"),
    ),
    true,
  );
});

test("hourly Smart Hours scheduler waits for the next exact UTC hour", () => {
  assert.equal(
    millisecondsUntilNextUtcHour(Date.parse("2026-08-19T14:37:15.250Z")),
    22 * 60_000 + 44_750,
  );
});

test("hourly Smart Hours scheduler does not run immediately after an exact-boundary restart", () => {
  assert.equal(
    millisecondsUntilNextUtcHour(Date.parse("2026-08-19T15:00:00.000Z")),
    UTC_HOUR_MS,
  );
});

test("hourly Smart Hours scheduler realigns after a delayed boundary callback", async () => {
  const timeoutCallbacks: Array<() => void> = [];
  const timeoutDelays: number[] = [];
  let now = Date.parse("2026-08-19T14:45:00.000Z");
  let runs = 0;

  scheduleAtTopOfEveryUtcHour(
    async () => { runs++; },
    {
      now: () => now,
      setTimeout: (callback, delayMs) => {
        timeoutCallbacks.push(callback);
        timeoutDelays.push(delayMs);
        return timeoutCallbacks.length;
      },
      clearTimeout: () => {},
    },
  );

  assert.equal(timeoutDelays[0], 15 * 60_000);
  assert.equal(runs, 0);
  now = Date.parse("2026-08-19T15:00:20.000Z");
  timeoutCallbacks[0]?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal(timeoutDelays[1], UTC_HOUR_MS - 20_000);
});

test("hourly Smart Hours scheduler queues one overlap and resumes after completion", async () => {
  let release: (() => void) | undefined;
  const firstJob = new Promise<void>(resolve => { release = resolve; });
  let runs = 0;
  const run = createNonOverlappingAsyncJob(async () => {
    runs++;
    if (runs === 1) await firstJob;
  });

  const first = run();
  assert.equal(await run(), false);
  assert.equal(runs, 1);
  release?.();
  assert.equal(await first, true);
  assert.equal(runs, 2);
  assert.equal(await run(), true);
  assert.equal(runs, 3);
});

test("serialized async operation preserves caller options and completion order", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const started: string[] = [];
  const operation = createSerializedAsyncOperation(async (label: string) => {
    started.push(label);
    if (label === "automatic") await firstGate;
    return `${label}:complete`;
  });

  const automatic = operation("automatic");
  const manual = operation("manual-60-percent");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ["automatic"]);

  releaseFirst?.();
  assert.equal(await automatic, "automatic:complete");
  assert.equal(await manual, "manual-60-percent:complete");
  assert.deepEqual(started, ["automatic", "manual-60-percent"]);
});

test("serialized async operation continues after a rejected caller", async () => {
  const operation = createSerializedAsyncOperation(async (label: string) => {
    if (label === "fail") throw new Error("controlled failure");
    return label;
  });
  await assert.rejects(operation("fail"), /controlled failure/);
  assert.equal(await operation("recovery"), "recovery");
});