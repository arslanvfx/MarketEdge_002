import { logger } from "./logger";
import { evalClosedBets } from "./kalshi-bot-eval";
import {
  runSmartHoursCalibrationCore,
} from "./kalshi-bot-db";
import { S } from "./kalshi-bot-state";
import {
  createSerializedAsyncOperation,
  decideSmartHoursEvaluationDrain,
  shouldRunSmartHoursCatchUp,
  smartHoursCalibrationMarker,
} from "./kalshi-quiet-hours-scheduler";

type SmartHoursCalibrationOptions = NonNullable<Parameters<typeof runSmartHoursCalibrationCore>[0]>;
type SmartHoursCalibrationResult = Awaited<ReturnType<typeof runSmartHoursCalibrationCore>>;
const EVAL_BATCH_SIZE = 20;
const MAX_EVAL_DRAIN_PASSES = 25;

/**
 * The only public Smart Hours refresh operation.
 *
 * Every caller first joins the shared closed-bet evaluation pass and only then
 * calibrates. Serializing this whole sequence prevents the hourly timer,
 * startup catch-up, bot-loop recovery, and manual button from racing one
 * another around a UTC-hour transition.
 */
const _enqueueEvaluateThenCalibrate = createSerializedAsyncOperation(
  async (opts: SmartHoursCalibrationOptions): Promise<SmartHoursCalibrationResult> => {
    const nowMs = opts.nowMs ?? Date.now();
    const isAutomaticRequest = opts.thresholdOverride === undefined;
    if (
      isAutomaticRequest
      && S.config.smartHoursCalibratedUtcHour === smartHoursCalibrationMarker(nowMs)
    ) {
      return {
        skipped: false,
        perSymbolQuietHours: S.config.perSymbolQuietHours ?? {},
        calibratedSymbols: Object.keys(S.config.perSymbolQuietHours ?? {}),
        skippedSymbols: [],
      };
    }

    // Drain every full evaluator batch before querying schedule history. One
    // pass is capped at 20 rows because each row may perform a network lookup;
    // stopping after that first batch recreates the stale-hour bug after a
    // restart or any busy boundary with more than 20 unresolved positions.
    let drained = false;
    for (let pass = 0; pass < MAX_EVAL_DRAIN_PASSES; pass++) {
      const evaluation = await evalClosedBets();
      const decision = decideSmartHoursEvaluationDrain(
        evaluation,
        isAutomaticRequest,
        EVAL_BATCH_SIZE,
      );
      if (decision === "ready") {
        drained = true;
        break;
      }
      if (decision === "retry") {
        // A full batch made no progress. Automatic callers must leave the
        // hourly marker stale so loop recovery retries after settlement data
        // becomes available. A manual threshold refresh remains available as
        // an operator override for permanently malformed historical rows.
        throw new Error("Smart Hours outcome backlog is not ready for calibration");
      }
    }
    if (!drained && isAutomaticRequest) {
      throw new Error("Smart Hours outcome backlog exceeded the bounded drain");
    }
    return runSmartHoursCalibrationCore(opts);
  },
);

export function runSmartHoursCalibration(
  opts: SmartHoursCalibrationOptions = {},
): Promise<SmartHoursCalibrationResult> {
  return _enqueueEvaluateThenCalibrate(opts);
}

/**
 * Current-hour readiness barrier used by the bot-loop recovery path.
 */
export async function ensureSmartHoursCalibrationCurrent(nowMs: number = Date.now()): Promise<boolean> {
  const marker = smartHoursCalibrationMarker(nowMs);
  if (S.config.smartHoursCalibratedUtcHour === marker) return true;

  await runSmartHoursCalibration({ nowMs, queueIfBusy: true }).catch(() => null);
  return S.config.smartHoursCalibratedUtcHour === marker;
}

/**
 * Startup catch-up: refresh once when the effective Smart Hours hour has not
 * already been calibrated.
 */
export async function runSmartHoursCalibrationCatchUpIfNeeded(
  nowMs: number = Date.now(),
): Promise<boolean> {
  const marker = smartHoursCalibrationMarker(nowMs);
  if (!shouldRunSmartHoursCatchUp(
    S.config.quietHoursMode,
    S.config.smartHoursCalibratedUtcHour,
    nowMs,
  )) {
    logger.info(
      { marker },
      "[qh-per-symbol] startup catch-up skipped — current UTC hour already calibrated",
    );
    return false;
  }

  logger.info(
    { marker },
    "[qh-per-symbol] startup catch-up: current UTC hour not calibrated — evaluating then calibrating",
  );
  const res = await runSmartHoursCalibration({ nowMs, queueIfBusy: true });
  logger.info(
    {
      calibratedSymbols: res.calibratedSymbols,
      skippedSymbols: res.skippedSymbols,
      marker,
    },
    "[qh-per-symbol] startup catch-up calibration complete",
  );
  return true;
}