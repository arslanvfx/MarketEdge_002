export const UTC_HOUR_MS = 60 * 60_000;
export const SMART_HOURS_SETTLEMENT_GRACE_MS = 2 * 60_000;

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
 * Smart Hours deliberately changes hours shortly after the UTC boundary, not
 * exactly on it. Bets from the window that just closed are evaluated
 * asynchronously and are not guaranteed to have outcome='win'/'loss' at
 * HH:00:00. Treat the previous schedule as current during this short settlement
 * grace, then require the new hour's calibration.
 */
export function smartHoursCalibrationMarker(nowMs: number = Date.now()): string {
  return utcHourMarker(nowMs - SMART_HOURS_SETTLEMENT_GRACE_MS);
}

export function isSmartHoursCalibrationCurrent(
  calibratedUtcHour: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  return calibratedUtcHour === smartHoursCalibrationMarker(nowMs);
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
  return storedMarker !== smartHoursCalibrationMarker(nowMs);
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
  if (storedMarker === smartHoursCalibrationMarker(nowMs)) return false;
  if (!Number.isFinite(lastAttemptAtMs) || lastAttemptAtMs <= 0) return true;
  const elapsedMs = nowMs - lastAttemptAtMs;
  return elapsedMs < 0 || elapsedMs >= retryIntervalMs;
}

export function millisecondsUntilNextUtcHour(nowMs: number = Date.now()): number {
  const remainder = ((nowMs % UTC_HOUR_MS) + UTC_HOUR_MS) % UTC_HOUR_MS;
  return remainder === 0 ? UTC_HOUR_MS : UTC_HOUR_MS - remainder;
}

export function millisecondsUntilNextSmartHoursCalibration(nowMs: number = Date.now()): number {
  const remainder = ((nowMs % UTC_HOUR_MS) + UTC_HOUR_MS) % UTC_HOUR_MS;
  const thisHourTarget = SMART_HOURS_SETTLEMENT_GRACE_MS;
  if (remainder < thisHourTarget) return thisHourTarget - remainder;
  return UTC_HOUR_MS - remainder + thisHourTarget;
}

export type SmartHoursEvaluationDrainDecision = "continue" | "ready" | "retry";

export function decideSmartHoursEvaluationDrain(
  evaluation: { selected: number; evaluated: number; failed: number; hadOuterError: boolean },
  automatic: boolean,
  batchSize: number,
): SmartHoursEvaluationDrainDecision {
  if (evaluation.hadOuterError) return "retry";
  if (evaluation.selected < batchSize) {
    if (!automatic) return "ready";
    return evaluation.failed === 0 && evaluation.evaluated === evaluation.selected
      ? "ready"
      : "retry";
  }
  if (evaluation.evaluated > 0) return "continue";
  return automatic ? "retry" : "ready";
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
  return scheduleHourly(job, millisecondsUntilNextUtcHour, timers);
}

/**
 * Schedule Smart Hours after the settlement grace each UTC hour. This prevents
 * the automatic pass from racing the outcome evaluator at HH:00 and then
 * suppressing a corrected pass for the rest of the hour.
 */
export function scheduleSmartHoursCalibrationHourly(
  job: () => Promise<void>,
  timers: HourlyTimerApi = systemTimers,
): { cancel: () => void } {
  return scheduleHourly(job, millisecondsUntilNextSmartHoursCalibration, timers);
}

function scheduleHourly(
  job: () => Promise<void>,
  nextDelay: (nowMs: number) => number,
  timers: HourlyTimerApi,
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
    }, nextDelay(timers.now()));
  };
  scheduleNextBoundary();

  return {
    cancel: () => {
      cancelled = true;
      timers.clearTimeout(timeoutHandle);
    },
  };
}