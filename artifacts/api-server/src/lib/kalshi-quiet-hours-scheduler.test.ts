import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UTC_HOUR_MS,
  createNonOverlappingAsyncJob,
  millisecondsUntilNextUtcHour,
  scheduleAtTopOfEveryUtcHour,
} from "./kalshi-quiet-hours-scheduler.ts";

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

test("hourly Smart Hours scheduler skips overlap and resumes after completion", async () => {
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
  assert.equal(await run(), true);
  assert.equal(runs, 2);
});