export const UTC_HOUR_MS = 60 * 60_000;

export function millisecondsUntilNextUtcHour(nowMs: number = Date.now()): number {
  const remainder = ((nowMs % UTC_HOUR_MS) + UTC_HOUR_MS) % UTC_HOUR_MS;
  return remainder === 0 ? UTC_HOUR_MS : UTC_HOUR_MS - remainder;
}

export function createNonOverlappingAsyncJob(
  job: () => Promise<void>,
): () => Promise<boolean> {
  let inFlight = false;
  return async () => {
    if (inFlight) return false;
    inFlight = true;
    try {
      await job();
      return true;
    } finally {
      inFlight = false;
    }
  };
}

interface HourlyTimerApi {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const systemTimers: HourlyTimerApi = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Schedule an async job for the next exact UTC hour boundary and every hour
 * after that. A restart never runs the job immediately, even if startup lands
 * exactly on a boundary, and overlapping invocations are skipped.
 */
export function scheduleAtTopOfEveryUtcHour(
  job: () => Promise<void>,
  timers: HourlyTimerApi = systemTimers,
): { cancel: () => void } {
  const run = createNonOverlappingAsyncJob(job);
  let cancelled = false;
  let timeoutHandle: unknown;

  const scheduleNextBoundary = () => {
    if (cancelled) return;
    timeoutHandle = timers.setTimeout(() => {
      void run().finally(scheduleNextBoundary);
    }, millisecondsUntilNextUtcHour(timers.now()));
  };
  scheduleNextBoundary();

  return {
    cancel: () => {
      cancelled = true;
      timers.clearTimeout(timeoutHandle);
    },
  };
}