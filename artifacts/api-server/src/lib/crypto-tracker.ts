// ---------------------------------------------------------------------------
// crypto-tracker.ts — prediction tracker, AI mode, window signals, public API
// ---------------------------------------------------------------------------

import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { db, windowMonitorOutcomesTable, windowTimingSnapshotsTable } from "@workspace/db";
import {
  AUTOPILOT_MAX_ACTIVE,
  type AutoPilotDecision,
  claudeEnabledFor,
  computeAutoPilotDecisions,
} from "./autopilot";
import { isAiFeatureEnabled } from "./ai-spend";
import {
  CRYPTO_COINS,
  predCache,
  windowPredCache,
  PRED_TTL,
  currentWindowKey,
  getCandles,
  getStats,
  getTicker,
  get5mCandles,
  getOrderBook,
  getGeckoPrices,
  GECKO_ID,
  type Candle,
  type CoinPrediction,
  type CoinPrice,
} from "./crypto-data";
import { analyzeCoin, regimeFromER } from "./crypto-stat";
import {
  KALSHI_SERIES,
  fetchKalshiTarget,
  kalshiTargetCache,
  confirmedTargetStore,
  updateKalshiWindowPrice,
  getLastKalshiTicker,
  getKalshiWindowContext,
  getKalshiCachedData,
  lastMLAboveCache,
} from "./crypto-kalshi";
import {
  historyStore,
  snapInFlight,
  midSnapFired,
  recordId,
  dbInsertRecord,
  dbUpdateLiveDirection,
  initHistoryFromDB,
  pruneOldPredictionRecords,
  MAX_HISTORY,
  QUARTER_MS,
  TRAINING_COINS,
  type PredictionRecord,
} from "./crypto-history";
import { getPredictionAnalytics, computeEnsemble, calibrateConfidence } from "./crypto-analytics";
import {
  refineWithSelfConsistency,
  getSelfConsistencySamples,
  setSelfConsistencySamples as _setSelfConsistencySamples,
  fetchLiveDirection,
  liveDirectionCache,
  liveDirectionInFlight,
  liveDirectionLastAutoTrigger,
  LIVE_DIR_AUTO_COOLDOWN,
  type LiveDirectionResult,
} from "./crypto-claude";
import { computeStatWindowCall, mlSnapPrice } from "./prediction-utils";
import {
  captureMLSnapshot,
  labelWindowAndRetrain,
  initMLFromDB,
  wasMLInitSuccessful,
  getMLPrediction,
  getMLStatus,
} from "./ml-store";
import {
  extractMLFeatures,
  deriveMLSignalDirections,
  buildMLSnapshotInputs,
} from "./ml-features";
import { fetchKalshiSettledMarkets } from "./kalshi-trader";
import { intraWindowMetrics } from "./crypto-indicators";
import { logger } from "./logger";

export type { LiveDirectionResult };

export interface TrackerWindowCall {
  direction: "up" | "down" | "flat";
  aboveKalshi: boolean | null;
  predictedPrice: number;
  confidence: number;
  snappedAt: string;
  strikeProximityPct: number | null;
  // true when an actual DB record for the current window's target time was found;
  // false when the direction is extrapolated from prior-window regression data.
  // Only set on stat calls from getStatWindowCall; Claude calls omit this field.
  isCurrentWindowSnap?: boolean;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// Lock cache for Window Monitor "BET / STAY AWAY" signal.
const windowBetSignalLockCache = new Map<string, { windowKey: string; signal: WindowBetSignal }>();

// Tracks which window monitor signals have been persisted to DB.
const wmRecordedKeys = new Set<string>();

// Tracks which intra-window timing snapshots have been written this session.
const timingSnapshotWritten = new Set<string>();

// Tracks which window-open snaps have completed this session (keyed by sym:targetISO).
// Using a session-scoped Set (cleared on restart) instead of DB records so that a
// server restart always runs one snap immediately for the current window, ensuring
// predCache (and therefore ML features) are available from the first bot tick.
const snappedThisSession = new Set<string>();

// ---------------------------------------------------------------------------
// AI Mode Settings
// ---------------------------------------------------------------------------

let globalAiMode: "stat" | "claude" = "stat";
const claudeEnabledCoins = new Set<string>();

let autoPilotEnabled = true;
const autoPilotDecisions = new Map<string, AutoPilotDecision>();

// ---------------------------------------------------------------------------
// Auto-pilot
// ---------------------------------------------------------------------------

export function runAutoPilot(): void {
  if (!autoPilotEnabled) {
    autoPilotDecisions.clear();
    return;
  }
  const inputs = CRYPTO_COINS
    .filter(({ symbol }) => TRAINING_COINS.has(symbol))
    .map(({ symbol }) => {
      const a = getPredictionAnalytics(symbol);
      return {
        symbol,
        claudeAcc: a.bySource.claude.accuracyPct,
        statAcc:   a.bySource.stat.accuracyPct,
        claudeN:   a.bySource.claude.n,
        statN:     a.bySource.stat.n,
        wasActive: autoPilotDecisions.get(symbol)?.active ?? false,
      };
    });
  const decisions = computeAutoPilotDecisions(inputs);
  autoPilotDecisions.clear();
  for (const d of decisions) autoPilotDecisions.set(d.symbol, d);
}

export function getAiSettings(): {
  mode: "stat" | "claude";
  claudeCoins: string[];
  trainingCoins: string[];
  selfConsistencySamples: number;
  autoPilot: {
    enabled: boolean;
    maxActive: number;
    decisions: AutoPilotDecision[];
  };
} {
  return {
    mode: globalAiMode,
    claudeCoins: [...claudeEnabledCoins],
    trainingCoins: [...TRAINING_COINS],
    selfConsistencySamples: getSelfConsistencySamples(),
    autoPilot: {
      enabled:   autoPilotEnabled,
      maxActive: AUTOPILOT_MAX_ACTIVE,
      decisions: CRYPTO_COINS.map(({ symbol }) => {
        const stored = autoPilotDecisions.get(symbol);
        if (stored) return stored;
        const isTraining = TRAINING_COINS.has(symbol);
        return {
          symbol,
          active:           false,
          reason:           isTraining
            ? autoPilotEnabled ? "Evaluating…" : "Auto-pilot off"
            : "Stat only",
          exploring:        false,
          claudeAccuracyPct: null,
          statAccuracyPct:  null,
          claudeN:          0,
          statN:            0,
          marginPct:        null,
        };
      }),
    },
  };
}

export function setAutoPilot(enabled: boolean): boolean {
  autoPilotEnabled = enabled;
  if (enabled) runAutoPilot();
  else autoPilotDecisions.clear();
  return autoPilotEnabled;
}

export function setSelfConsistencySamples(n: number): number {
  return _setSelfConsistencySamples(n);
}

export function isAiGloballyEnabled(): boolean {
  return globalAiMode === "claude";
}

export function setGlobalAiMode(mode: "stat" | "claude"): void {
  globalAiMode = mode;
  if (mode === "stat") claudeEnabledCoins.clear();
}

export function setCoinClaudeEnabled(symbol: string, enabled: boolean): void {
  if (!TRAINING_COINS.has(symbol)) {
    claudeEnabledCoins.delete(symbol);
    return;
  }
  if (enabled) {
    claudeEnabledCoins.add(symbol);
    globalAiMode = "claude";
  } else {
    claudeEnabledCoins.delete(symbol);
    if (claudeEnabledCoins.size === 0) globalAiMode = "stat";
  }
}

export function isCoinClaudeEnabled(symbol: string): boolean {
  if (!TRAINING_COINS.has(symbol)) return false;
  return claudeEnabledFor({
    manualEnabled: claudeEnabledCoins.has(symbol),
    autoPilotEnabled,
    autoActive: autoPilotDecisions.get(symbol)?.active ?? false,
  });
}

// ---------------------------------------------------------------------------
// Tracker window calls
// ---------------------------------------------------------------------------

export function getTrackerWindowCall(symbol: string): TrackerWindowCall | null {
  const nowMs = Date.now();
  const sym = symbol.toUpperCase();
  const nextBoundary = new Date(Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS);
  const targetISO = nextBoundary.toISOString();
  const records = historyStore.get(sym) ?? [];
  const rec = records.find((r) => r.targetTime === targetISO && r.source === "claude");
  if (!rec) return null;
  const predPrice = Number(rec.predictedPrice);
  const kalshiTargetForComp = rec.kalshiTarget ?? getKalshiCachedData(sym)?.value ?? null;
  const aboveKalshi = kalshiTargetForComp != null ? predPrice >= kalshiTargetForComp : null;
  const strikeProximityPct =
    kalshiTargetForComp != null && rec.priceAtSnapshot != null && rec.priceAtSnapshot > 0
      ? Math.abs(rec.priceAtSnapshot - kalshiTargetForComp) / rec.priceAtSnapshot * 100
      : null;
  return {
    direction: rec.predictedDirection as "up" | "down" | "flat",
    aboveKalshi,
    predictedPrice: predPrice,
    confidence: rec.confidence,
    snappedAt: rec.snappedAt,
    strikeProximityPct,
  };
}

export function getStatWindowCall(symbol: string): TrackerWindowCall | null {
  const nowMs = Date.now();
  const sym = symbol.toUpperCase();
  const records = historyStore.get(sym) ?? [];
  const result = computeStatWindowCall(records, nowMs);
  if (!result) return null;
  const targetISO = new Date(Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS).toISOString();
  const rec = records.find((r) => r.targetTime === targetISO && r.source === "stat");
  let aboveKalshi = result.aboveKalshi;
  if (aboveKalshi === null && result.predictedPrice != null) {
    const liveTarget = getKalshiCachedData(sym)?.value ?? null;
    if (liveTarget !== null) {
      aboveKalshi = result.predictedPrice >= liveTarget;
    }
  }
  const kalshiTargetForProx = rec?.kalshiTarget ?? getKalshiCachedData(sym)?.value ?? null;
  const strikeProximityPct =
    kalshiTargetForProx != null && rec?.priceAtSnapshot != null && rec.priceAtSnapshot > 0
      ? Math.abs(rec.priceAtSnapshot - kalshiTargetForProx) / rec.priceAtSnapshot * 100
      : null;
  return { ...result, aboveKalshi, strikeProximityPct, isCurrentWindowSnap: rec != null };
}

// ---------------------------------------------------------------------------
// Window Monitor — BET / STAY AWAY / CAUTION signal
// ---------------------------------------------------------------------------

export interface WindowBetSignal {
  ready: boolean;
  minutesElapsed: number;
  recommendation: "bet" | "stay_away" | "caution";
  reason: string;
  preWindowER: number | null;
  factors: {
    efficiencyRatio: number;
    oscillationCount: number;
    spikeFlag: boolean;
    netDriftPct: number;
  };
}

export function computeWindowBetSignal(
  metrics: {
    efficiencyRatio: number;
    oscillationCount: number;
    spikeFlag: boolean;
    netDriftPct: number;
    preWindowER?: number;
    preWindowSpikeFlag?: boolean;
  },
  minutesElapsed: number,
): WindowBetSignal {
  const { efficiencyRatio: er, oscillationCount: osc, spikeFlag, netDriftPct,
          preWindowER, preWindowSpikeFlag } = metrics;
  const factors = { efficiencyRatio: er, oscillationCount: osc, spikeFlag, netDriftPct };
  const pER = preWindowER ?? null;
  const readyThreshold = pER !== null ? 2 : 5;

  if (minutesElapsed < readyThreshold) {
    return { ready: false, minutesElapsed, recommendation: "caution", reason: "Monitoring…", preWindowER: pER, factors };
  }

  let recommendation: WindowBetSignal["recommendation"];
  let reason: string;
  const pSpike = preWindowSpikeFlag ?? false;

  if (pER !== null) {
    const regimeBad  = pER < 0.25 || pSpike;
    const regimeGood = pER >= 0.30 && !pSpike;
    if (regimeBad) {
      if (osc >= 3) {
        recommendation = "stay_away";
        reason = "Choppy/spike pre-window regime confirmed by choppy first 5 min";
      } else {
        recommendation = "caution";
        reason = "Choppy or spike regime before window — proceed carefully";
      }
    } else if (regimeGood) {
      if (osc <= 3 && !spikeFlag) {
        recommendation = "bet";
        reason = "Trending pre-window regime with orderly opening — solid edge";
      } else {
        recommendation = "caution";
        reason = "Favorable pre-window regime but choppy opening — reduced confidence";
      }
    } else {
      recommendation = "caution";
      reason = "Borderline pre-window regime — insufficient directional clarity";
    }
  } else {
    if ((er < 0.25 && osc >= 4) || (er < 0.30 && osc >= 5)) {
      recommendation = "stay_away";
      reason = "Price flip-flopping — no clear direction in first 5 min";
    } else if (spikeFlag && osc >= 3) {
      recommendation = "stay_away";
      reason = "Erratic spike + reversals — unpredictable window";
    } else if (er >= 0.45 && osc <= 2) {
      recommendation = "bet";
      reason = "Clean intra-window trend — price moving consistently";
    } else {
      recommendation = "caution";
      reason = "Mixed signals — proceed with reduced confidence";
    }
  }

  return { ready: true, minutesElapsed, recommendation, reason, preWindowER: pER, factors };
}

export function getWindowBetSignal(symbol: string): WindowBetSignal | null {
  const sym = symbol.toUpperCase();
  const winCtx = getKalshiWindowContext(sym);
  if (!winCtx) return null;
  const { minutesElapsed } = winCtx;
  const wKey = getLastKalshiTicker(sym) ?? currentWindowKey(new Date());

  const locked = windowBetSignalLockCache.get(sym);
  if (locked?.windowKey === wKey && locked.signal.ready) {
    return { ...locked.signal, minutesElapsed };
  }

  const pred = getCachedPrediction(sym);
  if (!pred) return null;

  const nCandles = Math.min(Math.max(minutesElapsed, 1), 5);
  const iwm = intraWindowMetrics(pred.candles, nCandles);

  const signal = computeWindowBetSignal(
    {
      efficiencyRatio:   iwm.efficiencyRatio,
      oscillationCount:  iwm.oscillationCount,
      spikeFlag:         iwm.spikeFlag,
      netDriftPct:       iwm.netDriftPct,
      preWindowER:       pred.indicators.efficiencyRatio,
      preWindowSpikeFlag: pred.indicators.spikeFlag,
    },
    minutesElapsed,
  );

  if (signal.ready) {
    windowBetSignalLockCache.set(sym, { windowKey: wKey, signal });
  }

  return signal;
}

// ---------------------------------------------------------------------------
// startPredictionTracker
// ---------------------------------------------------------------------------

export function startPredictionTracker(
  onInitComplete?: () => void,
  onNewWindow?: (windowKey: string) => void,
  onMLRetrySuccess?: () => void,
): void {
  let lastTrackerWindowKey = "";

  const tick = async () => {
    const nowMs = Date.now();
    const nextBoundary = new Date(Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS);

    const currentWindowMs = Math.floor(nowMs / QUARTER_MS) * QUARTER_MS;
    const currentTrackerWindowKey = new Date(currentWindowMs).toISOString().slice(0, 16);
    if (currentTrackerWindowKey !== lastTrackerWindowKey) {
      lastTrackerWindowKey = currentTrackerWindowKey;
      onNewWindow?.(currentTrackerWindowKey);
    }

    runAutoPilot();

    await Promise.all(
      CRYPTO_COINS.map(async (coin) => {
        const sym = coin.symbol;
        if (!historyStore.has(sym)) historyStore.set(sym, []);
        const records = historyStore.get(sym)!;

        // 1. Evaluate pending records whose target time has passed.
        const pendingToEval = records.filter(
          (r) => r.status === "pending" && new Date(r.targetTime).getTime() <= nowMs,
        );
        let kalshiSettledMap = new Map<string, "yes" | "no">();
        if (pendingToEval.length > 0 && KALSHI_SERIES[sym]) {
          try {
            const settled = await fetchKalshiSettledMarkets(KALSHI_SERIES[sym], 20);
            for (const m of settled) {
              kalshiSettledMap.set(m.closeTime, m.result);
            }
          } catch {
            // non-fatal
          }
        }

        for (const rec of pendingToEval) {
          if (rec.status !== "pending") continue;
          try {
            const actual = await getTicker(coin.product);
            const snapshotPrice = rec.priceAtSnapshot;
            const actualDir: "up" | "down" | "flat" =
              actual > snapshotPrice * 1.0002 ? "up"
              : actual < snapshotPrice * 0.9998 ? "down"
              : "flat";
            const errorPct =
              Math.abs((actual - rec.predictedPrice) / rec.predictedPrice) * 100;
            let correct: boolean;

            if (rec.kalshiTarget !== null && rec.kalshiTarget !== undefined) {
              const kalshiResult = kalshiSettledMap.get(rec.targetTime);
              const actualAbove: boolean = kalshiResult != null
                ? kalshiResult === "yes"
                : actual >= rec.kalshiTarget;

              if (kalshiResult != null) {
                logger.debug(
                  { sym, targetTime: rec.targetTime, kalshiResult, actualAbove },
                  "[tracker] using Kalshi settlement result for prediction evaluation",
                );
              }

              const predictedAbove =
                (rec.source === "claude" || rec.source === "ensemble") &&
                rec.liveDirectionAbove !== null && rec.liveDirectionAbove !== undefined
                  ? rec.liveDirectionAbove
                  : rec.predictedPrice >= rec.kalshiTarget;
              correct = predictedAbove === actualAbove;

              if (rec.source === "stat") {
                labelWindowAndRetrain(sym, rec.targetTime, actualAbove ? 1 : 0);
              }

              // Score window-monitor outcomes and timing snapshots for this window.
              const wmKey = rec.targetTime.slice(0, 16).replace("T", " ").slice(0, 16);
              const wmId = `${sym}:${wmKey.slice(0, 10)}T${wmKey.slice(11, 16)}`;
              const wActualAbove = actualAbove;
              const wOutcome: "correct" | "incorrect" =
                wmRecordedKeys.has(`${sym}:${wmKey}`)
                  ? ((() => {
                      const wbs = getWindowBetSignal(sym);
                      if (!wbs) return "incorrect";
                      const statAbove = rec.predictedPrice >= rec.kalshiTarget;
                      if (wbs.recommendation === "bet") return statAbove === wActualAbove ? "correct" : "incorrect";
                      return wActualAbove !== statAbove ? "correct" : "incorrect";
                    })())
                  : "incorrect";
              db.update(windowMonitorOutcomesTable)
                .set({ actualAbove: wActualAbove, outcome: wOutcome, evaluatedAt: new Date() })
                .where(eq(windowMonitorOutcomesTable.id, wmId))
                .execute()
                .catch(() => {});

              const timingActualAbove = kalshiResult != null ? kalshiResult === "yes" : actual > rec.kalshiTarget;
              const wmKeyTs = new Date(rec.targetTime).getTime() - 15 * 60_000;
              const wmKeyIso = new Date(wmKeyTs).toISOString().slice(0, 16);
              db.update(windowTimingSnapshotsTable)
                .set({
                  actualAbove: timingActualAbove,
                  correct: sql`price_above = ${timingActualAbove}`,
                  evaluatedAt: new Date(),
                })
                .where(
                  and(
                    eq(windowTimingSnapshotsTable.symbol, sym),
                    eq(windowTimingSnapshotsTable.windowKey, wmKeyIso),
                    isNull(windowTimingSnapshotsTable.actualAbove),
                  ),
                )
                .execute()
                .catch(() => {});
            } else {
              const ACCURACY_THRESHOLD_PCT = 0.5;
              const directionCorrect =
                rec.predictedDirection === "flat"
                  ? actualDir === "flat"
                  : rec.predictedDirection === actualDir;
              correct = directionCorrect && errorPct <= ACCURACY_THRESHOLD_PCT;
            }

            rec.actualPrice  = actual;
            rec.errorPct     = errorPct;
            rec.correct      = correct;
            rec.evaluatedAt  = new Date().toISOString();
            rec.status       = "evaluated";

            // DB update via dbInsertRecord pattern (upsert)
            const { dbUpdateRecord } = await import("./crypto-history");
            dbUpdateRecord(rec);
          } catch {
            // retry on next tick
          }
        }

        // 2. Snapshot a new prediction for the next boundary if not already done.
        const targetISO = nextBoundary.toISOString();
        const timeToNext = nextBoundary.getTime() - nowMs;
        const snapKey = `${sym}:${targetISO}`;
        // Use session-scoped tracking instead of DB records so that a restart
        // always re-runs the snap for the current window, warming predCache
        // (and therefore ML) within one tick (~30 s) of startup.
        const alreadySnapped = snappedThisSession.has(snapKey);

        const TARGET_CONFIRM_BUFFER_MS = 5_000;
        const SNAP_GIVE_UP_MS         = 90_000;
        const SNAP_MAX_MS             = 12 * 60_000;
        const windowStartMs = nextBoundary.getTime() - 15 * 60_000;
        const timeIntoWindow = nowMs - windowStartMs;

        // 2b. Intra-window timing snapshots.
        {
          const TIMING_MARKS_S    = [60, 180, 360, 540, 720];
          const MARK_TOLERANCE_MS = 90_000;
          const timingWKey = new Date(windowStartMs).toISOString().slice(0, 16);
          const statRecTiming = records.find(
            (r) => r.source === "stat" && r.targetTime === targetISO && r.kalshiTarget != null,
          );
          if (statRecTiming?.kalshiTarget != null) {
            const kt = statRecTiming.kalshiTarget;
            const ensRecTiming = records.find(
              (r) => r.source === "ensemble" && r.targetTime === targetISO,
            );
            const statAboveTiming = statRecTiming.predictedPrice > kt;
            const ensAboveTiming  = ensRecTiming != null ? ensRecTiming.predictedPrice > kt : null;
            for (const markS of TIMING_MARKS_S) {
              const markMs   = markS * 1000;
              const lateness = timeIntoWindow - markMs;
              if (lateness >= 0 && lateness <= MARK_TOLERANCE_MS) {
                const timingKey = `${sym}:${timingWKey}:${markS}`;
                if (!timingSnapshotWritten.has(timingKey)) {
                  timingSnapshotWritten.add(timingKey);
                  getTicker(coin.product)
                    .then(async (livePrice) => {
                      const priceAbove = livePrice > kt;
                      if (KALSHI_SERIES[sym]) {
                        await fetchKalshiTarget(sym).catch(() => null);
                      }
                      const cachedKalshi = kalshiTargetCache.get(sym);
                      const yesPrice = cachedKalshi?.yesPrice != null
                        ? String(cachedKalshi.yesPrice)
                        : null;
                      db.insert(windowTimingSnapshotsTable)
                        .values({
                          id: timingKey,
                          symbol: sym,
                          windowKey: timingWKey,
                          targetTime: nextBoundary,
                          minuteMark: markS,
                          priceAbove,
                          kalshiTarget: String(kt),
                          currentPrice: String(livePrice),
                          kalshiYesPrice: yesPrice,
                          statAbove: statAboveTiming,
                          ensembleAbove: ensAboveTiming,
                          actualAbove: null,
                          correct: null,
                          evaluatedAt: null,
                        })
                        .onConflictDoNothing()
                        .execute()
                        .catch(() => { timingSnapshotWritten.delete(timingKey); });
                    })
                    .catch(() => { timingSnapshotWritten.delete(timingKey); });
                }
              }
            }
          }
        }

        const confirmedSnap = confirmedTargetStore.get(sym);
        const msSinceConfirmed = confirmedSnap ? nowMs - confirmedSnap.confirmedAt : null;
        const kalshiSnapReady = KALSHI_SERIES[sym]
          ? msSinceConfirmed !== null && msSinceConfirmed >= TARGET_CONFIRM_BUFFER_MS
          : timeIntoWindow >= 15_000;
        const snapFallback = KALSHI_SERIES[sym] && timeIntoWindow >= SNAP_GIVE_UP_MS;

        if (
          !alreadySnapped &&
          !snapInFlight.has(snapKey) &&
          timeToNext > 60_000 &&
          (kalshiSnapReady || snapFallback) &&
          timeIntoWindow < SNAP_MAX_MS
        ) {
          snapInFlight.add(snapKey);
          try {
            let kalshiTargetSnap = KALSHI_SERIES[sym]
              ? await fetchKalshiTarget(sym, nextBoundary).catch(() => null)
              : null;

            if (
              kalshiTargetSnap === null &&
              KALSHI_SERIES[sym] &&
              timeIntoWindow < SNAP_GIVE_UP_MS
            ) {
              // Kalshi market not published yet — retry next tick
            } else {
              const [candles, stats, tickerPrice, candles5m, orderBook] = await Promise.all([
                getCandles(coin.product),
                getStats(coin.product),
                getTicker(coin.product).catch(() => 0),
                get5mCandles(coin.product).catch(() => [] as Candle[]),
                getOrderBook(coin.product).catch(() => undefined),
              ]);
              const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
              const analysis = analyzeCoin(coin, candles, stats, new Date(nowMs), livePrice, orderBook);
              predCache.set(sym, { at: Date.now(), value: analysis });
              snappedThisSession.add(snapKey); // mark as done so this session doesn't re-snap

              const basePred =
                analysis.predictions.find((p) => p.target === targetISO) ??
                analysis.predictions[0];

              if (basePred) {
                updateKalshiWindowPrice(getLastKalshiTicker(sym), analysis.price);
                const winCtxSnap = getKalshiWindowContext(sym);
                const useAI = TRAINING_COINS.has(sym) && isAiFeatureEnabled("crypto_snap");
                const [ai, kalshiTarget] = await Promise.all([
                  useAI
                    ? refineWithSelfConsistency(analysis, basePred, {
                        candles5m,
                        orderBook,
                        kalshiTarget: kalshiTargetSnap,
                        windowOpenPrice: winCtxSnap?.priceAtOpen,
                        minutesElapsed: winCtxSnap?.minutesElapsed,
                      })
                    : Promise.resolve(null),
                  Promise.resolve(kalshiTargetSnap),
                ]);

                const er = analysis.indicators.efficiencyRatio;
                const regime = regimeFromER(er);
                const snappedAt = new Date(nowMs).toISOString();

                const common = {
                  symbol: sym,
                  snappedAt,
                  targetTime: targetISO,
                  targetLabel: basePred.label,
                  priceAtSnapshot: analysis.price,
                  kalshiTarget,
                  actualPrice:  null,
                  errorPct:     null,
                  correct:      null,
                  evaluatedAt:  null,
                  status:       "pending" as const,
                  efficiencyRatio: er,
                };
                const newRecs: PredictionRecord[] = [];

                // ── Proximity + time-of-day confidence adjustment ──
                let adjustedStatConf = basePred.confidence;
                if (kalshiTarget != null) {
                  const proximityPct =
                    Math.abs(analysis.price - kalshiTarget) / analysis.price * 100;
                  if (proximityPct > 0.1) {
                    const boost = Math.round(Math.min((proximityPct - 0.1) * 20, 6));
                    adjustedStatConf = Math.min(68, adjustedStatConf + boost);
                  } else if (proximityPct < 0.03) {
                    adjustedStatConf = Math.max(50, adjustedStatConf - 4);
                  }
                }
                const snapHourUTC = new Date(nowMs).getUTCHours();
                if (snapHourUTC === 19) {
                  adjustedStatConf = Math.min(68, adjustedStatConf + 4);
                }

                newRecs.push({
                  ...common,
                  id: recordId(sym, targetISO, "stat"),
                  predictedPrice:     basePred.predictedPrice,
                  predictedDirection: basePred.direction,
                  confidence:         adjustedStatConf,
                  source:             "stat",
                  abstained:          null,
                  rawConfidence:      null,
                  archivedAt:         null,
                  liveDirectionAbove: null,
                });

                if (ai) {
                  const claudeConfidence = calibrateConfidence(sym, ai.confidence);
                  newRecs.push({
                    ...common,
                    id:                 recordId(sym, targetISO, "claude"),
                    predictedPrice:     ai.predictedPrice,
                    predictedDirection: ai.direction,
                    confidence:         claudeConfidence,
                    source:             "claude",
                    abstained:          null,
                    rawConfidence:      ai.confidence,
                    archivedAt:         null,
                    liveDirectionAbove: null,
                  });

                  const dirRef = kalshiTargetSnap ?? analysis.price;
                  const dirFromPrice = (p: number): "up" | "down" | "flat" => {
                    const ch = dirRef > 0 ? ((p - dirRef) / dirRef) * 100 : 0;
                    return ch > 0.05 ? "up" : ch < -0.05 ? "down" : "flat";
                  };
                  const ens = computeEnsemble(
                    sym,
                    regime,
                    {
                      predictedPrice: basePred.predictedPrice,
                      direction:      dirFromPrice(basePred.predictedPrice),
                      confidence:     basePred.confidence,
                    },
                    {
                      predictedPrice: ai.predictedPrice,
                      direction:      dirFromPrice(ai.predictedPrice),
                      confidence:     claudeConfidence,
                    },
                    analysis.price,
                  );
                  newRecs.push({
                    ...common,
                    id:                 recordId(sym, targetISO, "ensemble"),
                    predictedPrice:     ens.predictedPrice,
                    predictedDirection: ens.direction,
                    confidence:         ens.confidence,
                    source:             "ensemble",
                    abstained:          ens.abstained,
                    rawConfidence:      null,
                    archivedAt:         null,
                    liveDirectionAbove: null,
                  });
                }

                // ── ML training snapshot ──
                {
                  if (kalshiTargetSnap != null) {
                    const elapsed = Math.min(timeIntoWindow / (15 * 60_000), 1);
                    const priceAtOpen = getKalshiWindowContext(sym)?.priceAtOpen ?? null;
                    const { features: snapFeatures } = buildMLSnapshotInputs(
                      analysis,
                      kalshiTargetSnap,
                      elapsed,
                      priceAtOpen,
                      basePred.predictedPrice,
                      ai?.predictedPrice ?? null,
                      null,
                    );
                    captureMLSnapshot(sym, targetISO, snapFeatures, elapsed);
                  }

                  const { mlStatAbove, mlClaudeAbove } = deriveMLSignalDirections(
                    basePred.predictedPrice,
                    ai?.predictedPrice ?? null,
                    kalshiTargetSnap ?? analysis.price,
                  );

                  if (kalshiTarget != null) {
                    const mlStatus = getMLStatus(sym);
                    if (mlStatus.ready) {
                      const elapsed = Math.min(timeIntoWindow / (15 * 60_000), 1);
                      const priceAtOpen = getKalshiWindowContext(sym)?.priceAtOpen ?? null;
                      const mlFeatures = extractMLFeatures(analysis, kalshiTarget, elapsed, priceAtOpen, mlStatAbove, mlClaudeAbove, null);
                      const mlResult = getMLPrediction(sym, mlFeatures);
                      if (mlResult.prediction?.above !== null && mlResult.prediction?.above !== undefined) {
                        const mlAbove = mlResult.prediction.above;
                        lastMLAboveCache.set(sym, mlAbove);
                        const mlPredPrice = mlSnapPrice(mlAbove, kalshiTarget);
                        newRecs.push({
                          ...common,
                          id:                 recordId(sym, targetISO, "ml"),
                          predictedPrice:     mlPredPrice,
                          predictedDirection: mlAbove ? "up" : "down",
                          confidence:         mlResult.prediction.confidence ?? 50,
                          source:             "ml",
                          abstained:          null,
                          rawConfidence:      mlResult.prediction.prob ?? null,
                          archivedAt:         null,
                          liveDirectionAbove: null,
                        });
                      }
                    }
                  }
                }

                for (const rec of newRecs) {
                  records.push(rec);
                  dbInsertRecord(rec);
                }
                if (records.length > MAX_HISTORY)
                  records.splice(0, records.length - MAX_HISTORY);
              }
            }
          } catch {
            // non-fatal
          } finally {
            snapInFlight.delete(snapKey);
          }
        }

        // ── Mid-window stat re-snap (T+7 min) ──
        {
          const MID_SNAP_MARK_MS   = 7 * 60_000;
          const MID_SNAP_WINDOW_MS = 90_000;
          const midKey = `${sym}:${targetISO}:mid`;
          if (
            alreadySnapped &&
            !midSnapFired.has(midKey) &&
            !snapInFlight.has(midKey) &&
            timeIntoWindow >= MID_SNAP_MARK_MS &&
            timeIntoWindow < MID_SNAP_MARK_MS + MID_SNAP_WINDOW_MS &&
            timeToNext > 60_000
          ) {
            midSnapFired.add(midKey);
            snapInFlight.add(midKey);
            const prevPredEntry = predCache.get(sym);
            (async () => {
              try {
                const [freshCandles, freshStats, freshTicker] = await Promise.all([
                  getCandles(coin.product),
                  getStats(coin.product),
                  getTicker(coin.product).catch(() => 0),
                ]);
                const freshPrice = freshTicker > 0 ? freshTicker : undefined;
                const freshAnalysis = analyzeCoin(coin, freshCandles, freshStats, new Date(nowMs), freshPrice);
                predCache.set(sym, { at: Date.now(), value: freshAnalysis });
                logger.info("[mid-snap] %s: predCache refreshed at T+%dmin", sym, Math.round(timeIntoWindow / 60_000));

                // ── Detect stat direction flip and auto-trigger Claude re-check ──
                const kal = freshAnalysis.kalshiTarget ?? prevPredEntry?.value?.kalshiTarget ?? getKalshiCachedData(sym)?.value ?? null;
                if (kal != null && prevPredEntry?.value?.price != null) {
                  const oldStatAbove = prevPredEntry.value.price >= kal;
                  const newStatAbove = freshAnalysis.price >= kal;
                  if (oldStatAbove !== newStatAbove && isCoinClaudeEnabled(sym) && isAiFeatureEnabled("crypto_live_dir")) {
                    logger.info(
                      "[mid-snap] %s: stat flipped %s→%s — triggering Claude re-check",
                      sym,
                      oldStatAbove,
                      newStatAbove,
                    );
                    liveDirectionCache.delete(sym);
                    fetchLiveDirection(sym, true).catch(() => {});
                  }
                }
              } catch {
                // non-fatal
              } finally {
                snapInFlight.delete(midKey);
              }
            })();
          }
        }

        // ── Auto-trigger live-direction re-check ──
        const LIVE_DIR_PERIODIC_MS = 5 * 60_000;
        if (isCoinClaudeEnabled(sym) && !liveDirectionInFlight.has(sym)) {
          const cached = liveDirectionCache.get(sym);
          const lastTrigger = liveDirectionLastAutoTrigger.get(sym) ?? 0;
          if (nowMs - lastTrigger > LIVE_DIR_AUTO_COOLDOWN) {
            let triggerReason: string | null = null;

            if (cached && cached.result.aboveKalshi !== null) {
              const statRec = records.slice().reverse().find(
                (r) => r.source === "stat" && r.kalshiTarget != null,
              );
              if (statRec?.kalshiTarget != null) {
                try {
                  const currentPrice = await getTicker(coin.product);
                  const priceAbove = currentPrice >= statRec.kalshiTarget;
                  if (priceAbove !== cached.result.aboveKalshi) {
                    triggerReason = `price ${currentPrice.toFixed(4)} crossed strike ${statRec.kalshiTarget}`;
                  }
                } catch {
                  // non-fatal
                }
              }
            }

            if (!triggerReason) {
              if (!cached) {
                const statSnappedThisWindow = records.find(
                  (r) => r.source === "stat" && r.targetTime === targetISO,
                );
                if (statSnappedThisWindow) {
                  triggerReason = "initial (stat snap ready)";
                }
              } else if (nowMs - cached.at > LIVE_DIR_PERIODIC_MS) {
                triggerReason = `periodic (${Math.round((nowMs - cached.at) / 60_000)}m since last)`;
              }
            }

            if (triggerReason && isAiFeatureEnabled("crypto_live_dir")) {
              const isInitialTrigger = triggerReason === "initial (stat snap ready)";
              liveDirectionInFlight.add(sym);
              liveDirectionLastAutoTrigger.set(sym, nowMs);
              logger.info("[live-dir] %s: %s — re-checking Claude", sym, triggerReason);
              fetchLiveDirection(sym, true)
                .then((result) => {
                  if (isInitialTrigger && result && result.aboveKalshi !== null) {
                    dbUpdateLiveDirection(sym, targetISO, result.aboveKalshi);
                  }
                })
                .catch(() => {})
                .finally(() => liveDirectionInFlight.delete(sym));
            }
          }
        }

        // 3. Record the Window Monitor signal once it locks.
        const wKeyMs = Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000);
        const currentWKey = new Date(wKeyMs).toISOString().slice(0, 16);
        const wmId = `${sym}:${currentWKey}`;
        if (!wmRecordedKeys.has(wmId)) {
          const wbs = getWindowBetSignal(sym);
          if (wbs?.ready) {
            const wTargetISO = nextBoundary.toISOString();
            const statRec = records.find(
              (r) => r.source === "stat" && r.targetTime === wTargetISO && r.kalshiTarget != null,
            );
            const wKalshiTarget = statRec?.kalshiTarget ?? null;
            if (wKalshiTarget != null) {
              wmRecordedKeys.add(wmId);
              const wStatPredAbove = statRec!.predictedPrice >= wKalshiTarget;
              db.insert(windowMonitorOutcomesTable)
                .values({
                  id: wmId,
                  symbol: sym,
                  windowKey: currentWKey,
                  targetTime: wTargetISO,
                  recommendation: wbs.recommendation,
                  factors: wbs.factors,
                  kalshiTarget: String(wKalshiTarget),
                  statPredictedAbove: wStatPredAbove,
                  actualAbove: null,
                  outcome: null,
                  lockedAt: new Date(nowMs),
                  evaluatedAt: null,
                })
                .onConflictDoNothing()
                .execute()
                .catch(() => { wmRecordedKeys.delete(wmId); });
            }
          }
        }
      }),
    );
  };

  // Background ML-init retry loop.
  // If initMLFromDB() fails (DB not yet ready at startup), we must not leave
  // ML permanently uninitialized — in ml_gate mode that blocks every bet
  // indefinitely.  This schedules automatic retries with exponential backoff,
  // without blocking tracker startup or the first tick.
  function scheduleMLInitRetry(attempt: number): void {
    const MAX_ATTEMPTS = 8;
    // Backoff: 5 s, 15 s, 30 s, 60 s, 120 s, then 5 min for remaining attempts.
    const DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000];
    if (attempt > MAX_ATTEMPTS) {
      logger.error(
        "[ml-store] ML init failed after %d attempts — ML gate will block all bets until next restart",
        MAX_ATTEMPTS,
      );
      return;
    }
    const delayMs = DELAYS_MS[attempt - 1] ?? 300_000;
    logger.warn(
      "[ml-store] scheduling ML init retry %d/%d in %ds",
      attempt, MAX_ATTEMPTS, Math.round(delayMs / 1000),
    );
    setTimeout(() => {
      logger.info("[ml-store] ML init retry %d/%d — attempting initMLFromDB", attempt, MAX_ATTEMPTS);
      initMLFromDB().then(() => {
        if (wasMLInitSuccessful()) {
          logger.info("[ml-store] ML init retry %d succeeded — triggering backfill check", attempt);
          onMLRetrySuccess?.();
        } else {
          scheduleMLInitRetry(attempt + 1);
        }
      }).catch(() => scheduleMLInitRetry(attempt + 1));
    }, delayMs);
  }

  Promise.all([
    initHistoryFromDB().catch(() => {}),
    initMLFromDB().catch(() => {}),
  ]).finally(() => {
    // If ML init failed, start the background retry loop before the first tick.
    if (!wasMLInitSuccessful()) {
      scheduleMLInitRetry(1);
    }
    recoverUnevaluatedTimingSnapshots().catch(() => {});
    tick().catch(() => {});
    setInterval(() => tick().catch(() => {}), 30_000);
    onInitComplete?.();
  });

  pruneOldPredictionRecords().catch(() => {});
  setInterval(() => pruneOldPredictionRecords().catch(() => {}), 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getCachedPrediction(symbol: string): CoinPrediction | null {
  return predCache.get(symbol)?.value ?? null;
}

export async function fetchCryptoPredictions(): Promise<{
  generatedAt: string;
  coins: CoinPrediction[];
}> {
  const now = new Date();
  const wk = currentWindowKey(now);

  const coins = await Promise.all(
    CRYPTO_COINS.map(async (coin) => {
      try {
        const kalshiTargetP = KALSHI_SERIES[coin.symbol]
          ? fetchKalshiTarget(coin.symbol).catch(() => null)
          : Promise.resolve(null);

        const hit = predCache.get(coin.symbol);
        if (hit && Date.now() - hit.at < PRED_TTL) {
          const wHit = windowPredCache.get(coin.symbol);
          const kalshiTarget = await kalshiTargetP;
          if (wHit?.windowKey === wk) {
            return { ...hit.value, predictions: wHit.predictions, kalshiTarget };
          }
          return { ...hit.value, kalshiTarget };
        }

        const [candles, stats, tickerPrice, orderBook] = await Promise.all([
          getCandles(coin.product),
          getStats(coin.product),
          getTicker(coin.product).catch(() => 0),
          getOrderBook(coin.product).catch(() => undefined),
        ]);
        const livePrice = tickerPrice > 0 ? tickerPrice : undefined;
        const result = analyzeCoin(coin, candles, stats, now, livePrice, orderBook);
        predCache.set(coin.symbol, { at: Date.now(), value: result });

        const wHit = windowPredCache.get(coin.symbol);
        if (!wHit || wHit.windowKey !== wk) {
          windowPredCache.set(coin.symbol, { windowKey: wk, predictions: result.predictions });
        }

        const lockedPreds = windowPredCache.get(coin.symbol)!.predictions;
        const kalshiTarget = await kalshiTargetP;
        return { ...result, predictions: lockedPreds, kalshiTarget };
      } catch {
        return null;
      }
    }),
  );
  return {
    generatedAt: now.toISOString(),
    coins: coins.filter((c) => c !== null) as CoinPrediction[],
  };
}

export async function fetchCryptoPrices(): Promise<{
  generatedAt: string;
  prices: CoinPrice[];
}> {
  const now = new Date();
  type GeckoEntry = { usd: number; usd_24h_change: number };
  type GeckoPrices = Record<string, GeckoEntry>;
  const gecko = await getGeckoPrices().catch(() => ({} as GeckoPrices));

  const prices = await Promise.all(
    CRYPTO_COINS.map(async (coin) => {
      try {
        const geckoEntry = (gecko as GeckoPrices)[GECKO_ID[coin.symbol] ?? ""];
        const [tickerPrice, stats] = await Promise.all([
          getTicker(coin.product),
          geckoEntry?.usd_24h_change == null ? getStats(coin.product) : Promise.resolve(null),
        ]);
        const change24hPct =
          geckoEntry?.usd_24h_change != null
            ? geckoEntry.usd_24h_change
            : stats
              ? stats.open > 0 ? ((tickerPrice - stats.open) / stats.open) * 100 : 0
              : 0;
        return {
          symbol: coin.symbol,
          product: coin.product,
          name: coin.name,
          price: tickerPrice,
          change24hPct,
        };
      } catch {
        try {
          const stats = await getStats(coin.product);
          const change24hPct =
            stats.open > 0 ? ((stats.last - stats.open) / stats.open) * 100 : 0;
          return {
            symbol: coin.symbol,
            product: coin.product,
            name: coin.name,
            price: stats.last,
            change24hPct,
          };
        } catch {
          return null;
        }
      }
    }),
  );
  return {
    generatedAt: now.toISOString(),
    prices: prices.filter((p): p is CoinPrice => p !== null),
  };
}

// ---------------------------------------------------------------------------
// Window Monitor outcome accuracy
// ---------------------------------------------------------------------------

export interface WMAccuracyStats {
  bet:       { total: number; correct: number; accuracy: number | null };
  stay_away: { total: number; correct: number; accuracy: number | null };
  caution:   { total: number; correct: number; accuracy: number | null };
  totalSamples: number;
  days: number;
}

export async function getWindowMonitorAccuracy(symbol: string, days = 7): Promise<WMAccuracyStats> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(windowMonitorOutcomesTable)
    .where(
      and(
        eq(windowMonitorOutcomesTable.symbol, symbol.toUpperCase()),
        gt(windowMonitorOutcomesTable.lockedAt, since),
        isNotNull(windowMonitorOutcomesTable.outcome),
      ),
    );

  const tally: Record<string, { total: number; correct: number }> = {
    bet:       { total: 0, correct: 0 },
    stay_away: { total: 0, correct: 0 },
    caution:   { total: 0, correct: 0 },
  };

  for (const row of rows) {
    const bucket = tally[row.recommendation];
    if (!bucket || !row.outcome) continue;
    bucket.total++;
    if (row.outcome === "correct") bucket.correct++;
  }

  const betBucket = tally.bet;
  if (betBucket.total >= 20) {
    const betAcc = betBucket.correct / betBucket.total;
    if (betAcc < 0.55) {
      logger.warn(
        { symbol, betAccuracy: betAcc.toFixed(3), samples: betBucket.total },
        "Window Monitor BET threshold may need re-tuning: accuracy below 55%",
      );
    }
  }

  const acc = (b: { total: number; correct: number }) =>
    b.total > 0 ? b.correct / b.total : null;

  return {
    bet:       { ...betBucket,       accuracy: acc(betBucket) },
    stay_away: { ...tally.stay_away, accuracy: acc(tally.stay_away) },
    caution:   { ...tally.caution,   accuracy: acc(tally.caution) },
    totalSamples: rows.length,
    days,
  };
}

// ---------------------------------------------------------------------------
// Timing analysis
// ---------------------------------------------------------------------------

const TIMING_MARK_LABELS: Record<number, string> = {
  60:  "1 min",
  180: "3 min",
  360: "6 min",
  540: "9 min",
  720: "12 min",
};

export interface TimingAnalysisRow {
  symbol: string | null;
  minuteMark: number;
  label: string;
  sampleCount: number;
  accuracy: number | null;
  avgYesPrice: number | null;
  avgReturn: number | null;
  ev: number | null;
}

async function recoverUnevaluatedTimingSnapshots(): Promise<void> {
  try {
    const pendingRows = await db.execute(sql`
      SELECT DISTINCT symbol, window_key, target_time, kalshi_target
      FROM   window_timing_snapshots
      WHERE  actual_above IS NULL
        AND  target_time < NOW()
    `);

    if (pendingRows.rows.length === 0) return;

    let recovered = 0;

    for (const row of pendingRows.rows as Array<Record<string, unknown>>) {
      const sym          = String(row.symbol);
      const windowKey    = String(row.window_key);
      const targetISO    = new Date(row.target_time as string).toISOString();
      const kalshiTarget = Number(row.kalshi_target);

      const priceRes = await db.execute(sql`
        SELECT actual_price
        FROM   prediction_records
        WHERE  symbol      = ${sym}
          AND  target_time = ${targetISO}::timestamptz
          AND  actual_price IS NOT NULL
        LIMIT 1
      `);

      if (priceRes.rows.length === 0) continue;

      const actualPrice = Number((priceRes.rows[0] as Record<string, unknown>).actual_price);
      if (!actualPrice || actualPrice <= 0) continue;

      const actualAbove = actualPrice > kalshiTarget;

      await db.execute(sql`
        UPDATE window_timing_snapshots
        SET  actual_above  = ${actualAbove},
             correct       = (price_above = ${actualAbove}),
             evaluated_at  = NOW()
        WHERE symbol      = ${sym}
          AND window_key  = ${windowKey}
          AND actual_above IS NULL
      `);

      recovered++;
    }

    if (recovered > 0) {
      logger.info(
        "[timing-recovery] back-filled %d unevaluated timing window(s) from closed prediction records",
        recovered,
      );
    }
  } catch (err) {
    logger.warn({ err }, "[timing-recovery] failed (non-fatal)");
  }
}

export async function getTimingAnalysis(symbol?: string, days?: number): Promise<TimingAnalysisRow[]> {
  const rawRows = await db.execute(
    symbol
      ? days != null
        ? sql`
            SELECT symbol, minute_mark,
              COUNT(*)::int                                            AS sample_count,
              COUNT(*) FILTER (WHERE correct = true)::int             AS correct_count,
              AVG(kalshi_yes_price::float)                            AS avg_yes_price
            FROM window_timing_snapshots
            WHERE actual_above IS NOT NULL
              AND symbol = ${symbol}
              AND evaluated_at >= NOW() - (${days} || ' days')::interval
            GROUP BY symbol, minute_mark
            ORDER BY minute_mark
          `
        : sql`
            SELECT symbol, minute_mark,
              COUNT(*)::int                                            AS sample_count,
              COUNT(*) FILTER (WHERE correct = true)::int             AS correct_count,
              AVG(kalshi_yes_price::float)                            AS avg_yes_price
            FROM window_timing_snapshots
            WHERE actual_above IS NOT NULL
              AND symbol = ${symbol}
            GROUP BY symbol, minute_mark
            ORDER BY minute_mark
          `
      : days != null
        ? sql`
            SELECT NULL AS symbol, minute_mark,
              COUNT(*)::int                                            AS sample_count,
              COUNT(*) FILTER (WHERE correct = true)::int             AS correct_count,
              AVG(kalshi_yes_price::float)                            AS avg_yes_price
            FROM window_timing_snapshots
            WHERE actual_above IS NOT NULL
              AND evaluated_at >= NOW() - (${days} || ' days')::interval
            GROUP BY minute_mark
            ORDER BY minute_mark
          `
        : sql`
            SELECT NULL AS symbol, minute_mark,
              COUNT(*)::int                                            AS sample_count,
              COUNT(*) FILTER (WHERE correct = true)::int             AS correct_count,
              AVG(kalshi_yes_price::float)                            AS avg_yes_price
            FROM window_timing_snapshots
            WHERE actual_above IS NOT NULL
            GROUP BY minute_mark
            ORDER BY minute_mark
          `,
  );

  return (rawRows.rows as Array<Record<string, unknown>>).map((row) => {
    const sampleCount  = Number(row.sample_count);
    const correctCount = Number(row.correct_count);
    const accuracy     = sampleCount > 0 ? correctCount / sampleCount : null;
    const avgYesPrice  = row.avg_yes_price != null ? Number(row.avg_yes_price) : null;
    const avgReturn    =
      avgYesPrice !== null && avgYesPrice > 0 ? (1 - avgYesPrice) / avgYesPrice : null;
    const ev =
      accuracy !== null && avgYesPrice !== null && avgYesPrice > 0
        ? accuracy * (1 / avgYesPrice) - (1 - accuracy)
        : null;
    const markNum = Number(row.minute_mark);
    return {
      symbol:     row.symbol != null ? String(row.symbol) : null,
      minuteMark: markNum,
      label:      TIMING_MARK_LABELS[markNum] ?? `${markNum / 60} min`,
      sampleCount,
      accuracy,
      avgYesPrice,
      avgReturn,
      ev,
    };
  });
}
