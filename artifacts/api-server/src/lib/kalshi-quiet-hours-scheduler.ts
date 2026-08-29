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

export function isSmartHoursCalibrationCurrent(
  calibratedUtcHour: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  return calibratedUtcHour === utcHourMarker(nowMs);
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

/**
 * Recovery decision used by the recurring bot loop when the exact-boundary
 * timer did not complete. The durable UTC-hour marker is authoritative; the
 * local attempt timestamp only prevents a failing database from being retried
 * on every fast bot tick.
 */
export function shouldAttemptSmartHoursLoopRecovery(
  storedMarker: string | undefined,
  lastAttemptAtMs: number,
  nowMs: number = Date.now(),
  retryIntervalMs: number = 5 * 60_000,
): boolean {
  if (storedMarker === utcHourMarker(nowMs)) return false;
  if (!Number.isFinite(lastAttemptAtMs) || lastAttemptAtMs <= 0) return true;
  const elapsedMs = nowMs - lastAttemptAtMs;
  return elapsedMs < 0 || elapsedMs >= retryIntervalMs;
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

/**
 * Serialize an async operation while preserving every caller's arguments and
 * completion promise. A rejection does not poison the queue for later callers.
 */
export function createSerializedAsyncOperation<TArgs, TResult>(
  operation: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  let tail: Promise<void> = Promise.resolve();
  return (args: TArgs): Promise<TResult> => {
    const result = tail.then(
      () => operation(args),
      () => operation(args),
    );
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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