export const UTC_HOUR_MS = 60 * 60_000;

/**
 * Durable per-hour marker key for a given instant: the UTC calendar hour as
 * "YYYY-MM-DDTHH". Two instants in the same UTC hour produce the same key, so a
 * successful calibration this hour can be recognised after a restart and a
 * duplicate run within the same hour skipped.
 */
export function utcHourMarker(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 13);
}

/**
 * Pure decision for the restart catch-up: run Smart Hours calibration once on
 * startup when the current UTC hour has not already been calibrated. Calibration
 * stays fresh even while global mode is selected; this helper never changes the
 * selected mode.
 */
export function shouldRunSmartHoursCatchUp(
  _quietHoursMode: string | undefined,
  storedMarker: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  return storedMarker !== utcHourMarker(nowMs);
}

export function millisecondsUntilNextUtcHour(nowMs: number = Date.now()): number {
  const remainder = ((nowMs % UTC_HOUR_MS) + UTC_HOUR_MS) % UTC_HOUR_MS;
  return remainder === 0 ? UTC_HOUR_MS : UTC_HOUR_MS - remainder;
}

export function createNonOverlappingAsyncJob(
  job: () => Promise<void>,
): () => Promise<boolean> {
  let inFlight = false;
  let rerunRequested = false;
  return async () => {
    if (inFlight) {
      rerunRequested = true;
      return false;
    }
    inFlight = true;
    try {
      do {
        rerunRequested = false;
        await job();
      } while (rerunRequested);
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
 * exactly on a boundary. If a run spans the next boundary, one latest-hour run
 * is queued rather than silently dropped.
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
      // Arm the next exact boundary before starting the job so a long-running
      // calibration cannot suppress the following hour's timer.
      scheduleNextBoundary();
      void run();
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