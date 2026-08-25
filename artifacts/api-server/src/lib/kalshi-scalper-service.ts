// ---------------------------------------------------------------------------
// kalshi-scalper-service.ts — Isolated high-value Kalshi scalper service.
//
// Runs independently on a 250ms scan cadence with bounded authenticated work.
// Preflight warms readiness before the final window. A single authoritative
// authenticated quote is fetched concurrently with final guard inputs.
// Regular bot state is read-only; regular positions are never mutated.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { logger } from "./logger.ts";
import { CRYPTO_COINS, KALSHI_SERIES, currentWindowKey } from "./crypto.ts";
import { getKalshiCachedData, fetchOrderbookPrices, fetchKalshiTarget } from "./crypto-kalshi.ts";
// READ-ONLY imports from the protected regular-bot trader: balance + settlement
// reads only. The scalper's ORDER SUBMISSION path uses its own isolated exchange
// boundary (placeScalpOrderStrict) and NEVER imports/calls placeOrder.
import { getBalance, fetchKalshiMarketResult, fetchKalshiSettledMarkets } from "./kalshi-trader.ts";
import {
  isDefinitiveScalpOrderRejection,
  parseDefinitiveScalpOrderRejection,
  placeScalpOrderStrict,
  reconcileScalpOrderStrict,
  type ScalpReconciliationResult,
} from "./kalshi-scalper-exchange.ts";
import { getTicker } from "./crypto-data.ts";
import type {
  ScalpAttemptLatency,
  ScalpConfig,
  ScalpMode,
  ScalpOrder,
  ScalpIncident,
  ScalpPerformance,
  ScalpMarketStatus,
  ScalpPerMarketOverride,
  ScalpEntryGuardEvidence,
  ScalpSkipEvidence,
  ScalpShadowActualSummary,
  ScalpShadowStudyRecord,
  ScalpShadowStudyReport,
  ScalpWindowFunnelReport,
} from "./kalshi-scalper-types.ts";
import {
  DEFAULT_SCALP_CONFIG,
} from "./kalshi-scalper-types.ts";
import {
  resolveEffectiveParams,
  selectScalpSide,
  isInFinalWindow,
  resolveTimingPhase,
  secondsUntilEligible,
  computeLimitPrice,
  winningCostFromFill,
  validateOrderbookQuote,
  requalifyAuthenticatedScalpQuote,
  checkFreefallGuard,
  evaluateFreefallPreSubmitGuard,
  checkTargetProximityGuard,
  resolveScalpMarketState,
  computeScalpPnl,
  classifyScalpFillAgainstBand,
  classifyPlaceOrderResult,
  type PlaceOrderClassification,
  buildExecutionRiskSnapshot,
  compareRiskSnapshot,
  decideAuthenticatedQuoteRetry,
  sizeOrderWithinReservedBudget,
  evaluateScalpReservationRetry,
  describeScalpCircuitBreakerReason,
  preserveNewerScalpBreakerState,
  persistCircuitBreakerWithPolicy,
  SCALP_AUTH_RETRY_COOLDOWN_MS,
  SCALP_AUTHENTICATED_QUOTE_RETRY_MIN_REMAINING_MS,
  SCALP_GUARD_RETRY_COOLDOWN_MS,
  SCALP_MAX_AUTHENTICATED_QUOTE_RETRIES,
  SCALP_MAX_CONCURRENT_CANDIDATES,
  SCALP_MAX_CONCURRENT_BACKGROUND_SAMPLES,
  SCALP_MAX_SUBMISSIONS_PER_WINDOW,
  SCALP_PREFLIGHT_LEAD_SECONDS,
  SCALP_SCAN_INTERVAL_MS,
  FREEFALL_MAX_SAMPLE_AGE_MS,
  scalpPreflightRefreshMs,
  type FreefallSample,
  type ExecutionRiskSnapshot,
  type ScalpConfigPatch,
  type ScalpFillBandResult,
} from "./kalshi-scalper-policy.ts";
import {
  buildScalpWindowFunnelReport,
  createBoundedScalpFunnelRecorder,
  createCoalescedAsyncRunner,
  findSlowestScalpLatencyStage,
  prioritizeScalpCandidates,
  selectNextScalpSamplePriority,
  summarizeScalpAttemptLatencies,
} from "./kalshi-scalper-fast-path.ts";
import {
  createBoundedScalpShadowWriter,
  buildScalpShadowStudyReport,
  evaluateScalpShadowEntry,
  resolveScalpShadowVariantSeconds,
  resolveScalpShadowStudyScope,
  settleScalpShadowRecord,
} from "./kalshi-scalper-shadow.ts";
import {
  evaluateRegularPositionCompatibility,
  type RegularPositionCompatibility,
  type RegularPositionForScalperLayering,
} from "./kalshi-scalper-layering.ts";
import {
  initContrarianExperiment,
  triggerContrarianFromNormalGuard,
  contrarianExposureRegistry,
  setContrarianRegularExposureReader,
  evaluateContrarianLifecycle,
} from "./kalshi-scalper-contrarian-service.ts";
import {
  buildContrarianGuardOutcomeStudyPayload,
  ContrarianMonitorAttemptScheduler,
  evaluateContrarianGuardEligibility,
  isPinnedContrarianIdentityCurrent,
} from "./kalshi-scalper-contrarian.ts";
import {
  loadScalpConfigFromDB,
  saveScalpConfigToDB,
  runScalpMigrations,
  claimReservationAndCap,
  updateReservationStatus,
  countTodayReservations,
  getScalpCommittedTotals,
  insertScalpOrderIntent,
  finalizePaperOrderAndReleaseReservation,
  finalizeScalpOrder,
  finalizeOrderAndReleaseReservation,
  abortIntentAndReleaseReservation,
  updateScalpOrderSettlement,
  setScalpOrderIncident,
  getSubmittingScalpOrders,
  getUnsettledScalpOrders,
  getScalpOrders,
  getRecentScalpReservations,
  getTodayScalpSpend,
  getOpenScalpSpend,
  countUnresolvedLiveAttempts,
  releaseStalePreSubmitLiveReservations,
  getUnresolvedLiveAttempts,
  getScalpOrderById,
  getSiblingScalpExchangeOrderIds,
  reconcileScalpOrderAndReleaseReservation,
  insertScalpIncident,
  getScalpIncidents,
  getScalpOrdersForPerformance,
  getScalpPerformanceBaseline,
  getScalpWindowFunnelCounters,
  getScalpShadowStudyStartedAt,
  getScalpShadowStudyVariantSummaries,
  getRecentScalpShadowStudies,
  getUnsettledScalpShadowStudies,
  recordScalpFunnelEvent,
  resetScalpPerformanceWindow,
  upsertScalpShadowStudy,
  getScalpCalibrationEvidence,
  saveScalpCalibrationRecommendations,
  getLatestScalpCalibrationRecommendations,
  getActiveScalpCalibrationApplications,
  getScalpCalibrationRecommendationById,
  persistScalpCalibrationDecision,
} from "./kalshi-scalper-db.ts";
import { calculateScalpPerformance } from "./kalshi-scalper-performance.ts";
import {
  buildScalpCalibrationRecommendation,
  buildScalpCalibrationTimingOverride,
  scalpCalibrationSettingsEqual,
  type ScalpCalibrationRecommendation,
  type ScalpCalibrationReport,
  type ScalpCalibrationSettings,
} from "./kalshi-scalper-calibration.ts";

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let _config: ScalpConfig = { ...DEFAULT_SCALP_CONFIG };
let _configMutationTail: Promise<void> = Promise.resolve();
let _breakerVersion = 0;
let _breakerPersistRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _running = false;
let _scanInterval: ReturnType<typeof setInterval> | null = null;
let _lastScanAt: number | null = null;
let _lastError: string | null = null;

type ScalpPreflightState = "idle" | "warming" | "ready" | "blocked";
interface ScalpPreflightMarketStatusInternal {
  symbol: string;
  ready: boolean;
  reason: string | null;
}
interface ScalpPreflightStatusInternal {
  state: ScalpPreflightState;
  mode: ScalpMode;
  windowKey: string | null;
  checkedAt: number | null;
  startsInSeconds: number | null;
  readySymbols: number;
  totalSymbols: number;
  reason: string | null;
  availableBalance: number | null;
  dailyCommitted: number | null;
  openCommitted: number | null;
  markets: ScalpPreflightMarketStatusInternal[];
}

const _attemptsInFlight = new Set<string>();
const _terminalAttemptKeys = new Set<string>();
const _nextAttemptAt = new Map<string, number>();
const _preflightIdentityReady = new Set<string>();
const _preflightRegularPositions = new Map<string, RegularPositionForScalperLayering>();
let _regularBotReadView: {
  openPositions?: Map<string, RegularPositionForScalperLayering>;
  S?: { mode?: string };
} | null = null;
let _lastSampleCollectionAt = 0;
let _lastObservedWindowKey: string | null = null;

const _funnelRecorder = createBoundedScalpFunnelRecorder(
  ({ mode, windowKey, symbol, stage }) =>
    recordScalpFunnelEvent(mode, windowKey, symbol, stage),
);

const _shadowWriter = createBoundedScalpShadowWriter(
  upsertScalpShadowStudy,
);
const _shadowStates = new Map<string, ScalpShadowStudyRecord>();
let _lastShadowObservationAt = 0;
let _shadowSettlementInFlight = false;
let _shadowObservationQueued = false;

function _shadowKey(
  mode: ScalpMode,
  windowKey: string,
  symbol: string,
  variantSeconds: number,
): string {
  return `${mode}:${windowKey}:${symbol}:${variantSeconds}`;
}

function _queueShadowRecord(record: ScalpShadowStudyRecord): void {
  _shadowWriter.record({
    ...record,
    blockerCounts: { ...record.blockerCounts },
    entryEvidence: record.entryEvidence
      ? { ...record.entryEvidence }
      : null,
  });
}

function _finalizeShadowWindow(windowKey: string, nowMs: number): void {
  for (const [key, record] of _shadowStates) {
    if (record.windowKey !== windowKey || record.status === "settled") continue;
    record.status = record.firstSafeEntryAt
      ? "candidate_found"
      : "closed_no_candidate";
    record.updatedAt = new Date(nowMs).toISOString();
    _queueShadowRecord(record);
    _shadowStates.delete(key);
  }
}

/**
 * Read-only observation of standard 60s–180s counterfactuals plus every global
 * or override timing for every market. It reuses cached
 * public quotes and existing Scalper-owned underlying samples; no network,
 * reservation, cap, balance, intent, broker, or reconciliation path is called.
 */
function _observeShadowEntries(windowKey: string, nowMs: number): void {
  if (nowMs - _lastShadowObservationAt < 1_000) return;
  if (_attemptsInFlight.size > 0) return;
  _lastShadowObservationAt = nowMs;
  const expectedCloseTime = _currentWindowCloseTime(windowKey);
  if (!expectedCloseTime) return;
  const variantSecondsToObserve = resolveScalpShadowVariantSeconds({
    configuredWindowSeconds: _config.finalWindowSeconds,
    overrideWindowSeconds: _config.perMarketOverrides.map(
      (override) => override.windowSeconds,
    ),
  });

  for (const coin of CRYPTO_COINS) {
    const symbol = coin.symbol.toUpperCase();
    if (!KALSHI_SERIES[symbol]) continue;
    const params = resolveEffectiveParams(_config, symbol, "");
    const cached = getKalshiCachedData(symbol);
    const samples = _priceSamples.get(symbol) ?? [];

    for (const variantSeconds of variantSecondsToObserve) {
      const evaluation = evaluateScalpShadowEntry({
        nowMs,
        closeTime: cached?.closeTime ?? expectedCloseTime,
        variantSeconds,
        ticker: cached?.ticker ?? null,
        expectedCloseTime,
        yesAsk: cached?.yesAsk,
        yesBid: cached?.yesBid,
        targetPrice: cached?.value,
        samples,
        config: _config,
        params,
      });
      if (!evaluation.started || evaluation.closed) continue;

      const key = _shadowKey(_config.mode, windowKey, symbol, variantSeconds);
      let record = _shadowStates.get(key);
      let shouldPersist = false;
      if (!record) {
        const firstEligibleAt = new Date(
          Date.parse(expectedCloseTime) - variantSeconds * 1_000,
        ).toISOString();
        const observedAt = new Date(nowMs).toISOString();
        record = {
          mode: _config.mode,
          windowKey,
          symbol,
          ticker: cached?.ticker ?? "",
          variantSeconds,
          status: "observing",
          firstEligibleAt,
          firstSafeEntryAt: null,
          firstSafeSecondsRemaining: null,
          side: null,
          yesAsk: null,
          noAsk: null,
          winningAsk: null,
          hypotheticalContracts: 0,
          hypotheticalBudget: params.budgetDollars,
          lastBlocker: null,
          blockerCounts: {},
          entryEvidence: null,
          laterQuoteIssueObserved: false,
          laterQuoteIssueReason: null,
          settlementResult: null,
          outcome: null,
          hypotheticalPnl: null,
          createdAt: observedAt,
          updatedAt: observedAt,
          settledAt: null,
        };
        _shadowStates.set(key, record);
        shouldPersist = true;
      }

      if (cached?.ticker) record.ticker = cached.ticker;
      record.updatedAt = new Date(nowMs).toISOString();
      record.lastBlocker = evaluation.blocker;
      if (evaluation.blocker) {
        record.blockerCounts[evaluation.blocker] =
          (record.blockerCounts[evaluation.blocker] ?? 0) + 1;
      }

      if (evaluation.allowed && record.firstSafeEntryAt == null) {
        const contractCount = Math.floor(
          params.budgetDollars / (evaluation.winningAsk ?? Number.POSITIVE_INFINITY),
        );
        if (contractCount >= 1) {
          record.status = "candidate_found";
          record.firstSafeEntryAt = new Date(nowMs).toISOString();
          record.firstSafeSecondsRemaining = evaluation.secondsRemaining;
          record.side = evaluation.side;
          record.yesAsk = evaluation.yesAsk;
          record.noAsk = evaluation.noAsk;
          record.winningAsk = evaluation.winningAsk;
          record.hypotheticalContracts = contractCount;
          record.entryEvidence = evaluation.evidence;
          shouldPersist = true;
        } else {
          record.lastBlocker = "budget_below_one_contract";
          record.blockerCounts["budget_below_one_contract"] =
            (record.blockerCounts["budget_below_one_contract"] ?? 0) + 1;
        }
      } else if (
        record.firstSafeEntryAt != null
        && !record.laterQuoteIssueObserved
        && (
          evaluation.blocker === "quote_invalid"
          || evaluation.blocker === "quote_outside_band"
        )
      ) {
        record.laterQuoteIssueObserved = true;
        record.laterQuoteIssueReason =
          evaluation.blocker === "quote_invalid" ? "invalid" : "outside_band";
        shouldPersist = true;
      }

      if (shouldPersist) _queueShadowRecord(record);
    }
  }
}

/**
 * Shadow observation is read-only, but it still performs per-market guard
 * evaluation. Schedule it after the scan pass returns so it cannot extend the
 * live candidate-to-submit scheduling lane. The callback re-checks the active
 * window and in-flight set, skipping observation rather than competing with a
 * real execution attempt.
 */
function _scheduleShadowObservation(windowKey: string): void {
  if (_shadowObservationQueued) return;
  _shadowObservationQueued = true;
  const timer = setTimeout(() => {
    _shadowObservationQueued = false;
    if (currentWindowKey() !== windowKey || _attemptsInFlight.size > 0) return;
    _observeShadowEntries(windowKey, Date.now());
  }, 0);
  timer.unref?.();
}

async function _evaluateShadowSettlements(): Promise<void> {
  if (
    _shadowSettlementInFlight
    || _attemptsInFlight.size > 0
    || _running
  ) return;
  _shadowSettlementInFlight = true;
  try {
    const rows = await getUnsettledScalpShadowStudies(36);
    const first = rows.find((row) =>
      row.ticker
      && row.firstSafeEntryAt
      && row.side
      && row.winningAsk != null
      && row.hypotheticalContracts > 0
    );
    if (!first) return;
    const result = await fetchKalshiMarketResult(first.ticker).catch(() => null);
    if (result?.result !== "yes" && result?.result !== "no") return;

    for (const row of rows) {
      if (
        row.mode !== first.mode
        || row.windowKey !== first.windowKey
        || row.ticker !== first.ticker
        || !row.side
        || row.winningAsk == null
      ) continue;
      const settledAt = new Date().toISOString();
      _queueShadowRecord(
        settleScalpShadowRecord(row, result.result, settledAt),
      );
    }
  } catch (err) {
    logger.debug(
      { err },
      "[kalshi-scalper] shadow settlement skipped (non-fatal)",
    );
  } finally {
    _shadowSettlementInFlight = false;
  }
}

function _recordScalpFunnelEvent(
  mode: ScalpMode,
  windowKey: string,
  symbol: string,
  stage: "candidate" | "authenticated_eligible" | "final_quote_loss",
): void {
  _funnelRecorder.record({ mode, windowKey, symbol, stage });
}
let _preflightInFlight = false;
let _lastPreflightStartedAt = 0;
let _preflightStatus: ScalpPreflightStatusInternal = {
  state: "idle",
  mode: _config.mode,
  windowKey: null,
  checkedAt: null,
  startsInSeconds: null,
  readySymbols: 0,
  totalSymbols: 0,
  reason: null,
  availableBalance: null,
  dailyCommitted: null,
  openCommitted: null,
  markets: [],
};

// Per-symbol price samples for the scalper's own freefall guard (never shared)
const _priceSamples = new Map<string, FreefallSample[]>();
const MAX_PRICE_SAMPLES = 120;
type PriceSamplePriority = "authoritative" | "background";
interface PriceSampleJob {
  key: string;
  symbol: string;
  product: string;
  priority: PriceSamplePriority;
  started: boolean;
  promise: Promise<boolean>;
  resolve: (value: boolean) => void;
}
const _priceSampleJobs = new Map<string, PriceSampleJob>();
const _authoritativeSampleQueue: PriceSampleJob[] = [];
const _backgroundSampleQueue: PriceSampleJob[] = [];
let _activePriceSampleFetches = 0;
let _activeBackgroundPriceSampleFetches = 0;
let _fetchScalpUnderlyingPrice: typeof getTicker = getTicker;

interface MutableScalpAttemptLatency {
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  detectedAtMs: number;
  closeTimeMs: number | null;
  queueWaitMs: number | null;
  capClaimMs: number | null;
  identityRefreshMs: number | null;
  quoteRefreshMs: number | null;
  parallelRefreshMs: number | null;
  finalRequoteMs: number | null;
  intentWriteMs: number | null;
  brokerSubmitMs: number | null;
}
const _recentAttemptLatencies: ScalpAttemptLatency[] = [];
const _latestAttemptLatencyByKey = new Map<string, ScalpAttemptLatency>();
const MAX_RECENT_ATTEMPT_LATENCIES = 200;

function _attemptKey(mode: ScalpMode, symbol: string, windowKey: string): string {
  return `${mode}:${symbol}:${windowKey}`;
}

function _beginAttemptLatency(
  mode: ScalpMode,
  symbol: string,
  windowKey: string,
  detectedAtMs: number,
  closeTime: string,
): MutableScalpAttemptLatency {
  const startedAtMs = Date.now();
  const parsedCloseTimeMs = Date.parse(closeTime);
  return {
    mode,
    symbol,
    windowKey,
    detectedAtMs,
    closeTimeMs: Number.isFinite(parsedCloseTimeMs) ? parsedCloseTimeMs : null,
    queueWaitMs: Math.max(0, startedAtMs - detectedAtMs),
    capClaimMs: null,
    identityRefreshMs: null,
    quoteRefreshMs: null,
    parallelRefreshMs: null,
    finalRequoteMs: null,
    intentWriteMs: null,
    brokerSubmitMs: null,
  };
}

function _finishAttemptLatency(timing: MutableScalpAttemptLatency): void {
  const completedAtMs = Date.now();
  const windowRemainingAtDetectedMs = timing.closeTimeMs == null
    ? null
    : timing.closeTimeMs - timing.detectedAtMs;
  const windowRemainingAtCompletionMs = timing.closeTimeMs == null
    ? null
    : timing.closeTimeMs - completedAtMs;
  const totalMs = Math.max(0, completedAtMs - timing.detectedAtMs);
  const measuredSequentialMs = [
    timing.queueWaitMs,
    timing.capClaimMs,
    timing.parallelRefreshMs,
    timing.finalRequoteMs,
    timing.intentWriteMs,
    timing.brokerSubmitMs,
  ].reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const decisionFinalizeMs = Math.max(0, totalMs - measuredSequentialMs);
  const slowest = findSlowestScalpLatencyStage({
    ...timing,
    decisionFinalizeMs,
  });
  const completed: ScalpAttemptLatency = {
    mode: timing.mode,
    symbol: timing.symbol,
    windowKey: timing.windowKey,
    detectedAt: new Date(timing.detectedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    windowRemainingAtDetectedMs,
    windowRemainingAtCompletionMs,
    windowExpiredDuringAttempt:
      windowRemainingAtDetectedMs != null
      && windowRemainingAtDetectedMs > 0
      && (windowRemainingAtCompletionMs ?? 0) <= 0,
    totalMs,
    queueWaitMs: timing.queueWaitMs,
    capClaimMs: timing.capClaimMs,
    identityRefreshMs: timing.identityRefreshMs,
    quoteRefreshMs: timing.quoteRefreshMs,
    parallelRefreshMs: timing.parallelRefreshMs,
    finalRequoteMs: timing.finalRequoteMs,
    intentWriteMs: timing.intentWriteMs,
    brokerSubmitMs: timing.brokerSubmitMs,
    decisionFinalizeMs,
    slowestStage: slowest.stage,
    slowestStageMs: slowest.latencyMs,
  };
  _recentAttemptLatencies.push(completed);
  if (_recentAttemptLatencies.length > MAX_RECENT_ATTEMPT_LATENCIES) {
    _recentAttemptLatencies.splice(
      0,
      _recentAttemptLatencies.length - MAX_RECENT_ATTEMPT_LATENCIES,
    );
  }
  const key = _attemptKey(timing.mode, timing.symbol, timing.windowKey);
  _latestAttemptLatencyByKey.set(key, completed);
  if (_latestAttemptLatencyByKey.size > MAX_RECENT_ATTEMPT_LATENCIES) {
    const oldestKey = _latestAttemptLatencyByKey.keys().next().value;
    if (oldestKey) _latestAttemptLatencyByKey.delete(oldestKey);
  }
}

function _resetPreflightState(): void {
  _preflightIdentityReady.clear();
  _preflightRegularPositions.clear();
  _lastPreflightStartedAt = 0;
  _preflightStatus = {
    state: "idle",
    mode: _config.mode,
    windowKey: null,
    checkedAt: null,
    startsInSeconds: null,
    readySymbols: 0,
    totalSymbols: 0,
    reason: null,
    availableBalance: null,
    dailyCommitted: null,
    openCommitted: null,
    markets: [],
  };
}

function _getRegularBotReadView(): typeof _regularBotReadView {
  if (_regularBotReadView) return _regularBotReadView;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _regularBotReadView = require("./kalshi-bot-state") as NonNullable<typeof _regularBotReadView>;
    return _regularBotReadView;
  } catch {
    return null;
  }
}

function _warmRegularPositionReadView(mode: ScalpMode, windowKey: string): void {
  _preflightRegularPositions.clear();
  const positions = _getRegularBotReadView()?.openPositions;
  if (!positions) return;
  for (const [symbol, position] of positions) {
    if (position.entryMode === mode && position.windowKey === windowKey) {
      _preflightRegularPositions.set(symbol.toUpperCase(), { ...position });
    }
  }
}

function _regularPositionCompatibilitySync(
  mode: ScalpMode,
  symbol: string,
  windowKey: string,
  ticker: string,
  side: "yes" | "no",
): RegularPositionCompatibility {
  const position = _getRegularBotReadView()?.openPositions?.get(symbol.toUpperCase()) ?? null;
  return evaluateRegularPositionCompatibility(position, {
    mode,
    symbol,
    windowKey,
    ticker,
    side,
  });
}

// Read regular bot mode read-only for display metadata only.
function getRegularBotMode(): string | null {
  return _getRegularBotReadView()?.S?.mode ?? null;
}

// ---------------------------------------------------------------------------
// Circuit breaker — always set in-memory first, then persist
// ---------------------------------------------------------------------------

function _isCircuitBreakerBlocking(): boolean {
  return _config.circuitBreaker && _config.circuitBreakerEnabled;
}

async function _persistScalpConfigWithRetry(config: ScalpConfig): Promise<void> {
  const maxAttempts = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await saveScalpConfigToDB(config);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      }
    }
  }
  throw lastError;
}

/**
 * Serialize all persistent Scalper config writes. A breaker trip still updates
 * memory synchronously, then its monotonically increasing version forces any
 * in-flight stale config write to preserve the newest latch and reason.
 */
function _enqueueScalpConfigMutation(
  build: (current: ScalpConfig) => ScalpConfig | Promise<ScalpConfig>,
  resetPreflight: boolean,
  persist?: (next: ScalpConfig, current: ScalpConfig) => Promise<void>,
): Promise<ScalpConfig> {
  const execute = async (): Promise<ScalpConfig> => {
    const currentAtStart = _config;
    const breakerVersionAtStart = _breakerVersion;
    let next = await build(currentAtStart);

    // A trip can happen while an async builder (for example reset validation)
    // is running. Preserve it before the first persistent write.
    next = preserveNewerScalpBreakerState(
      next,
      _config,
      breakerVersionAtStart,
      _breakerVersion,
    );
    if (persist) {
      await persist(next, currentAtStart);
    } else {
      await _persistScalpConfigWithRetry(next);
    }

    // A trip can also happen while the DB write itself is in flight. Persist
    // the winning latch before exposing the mutation result.
    const finalConfig = preserveNewerScalpBreakerState(
      next,
      _config,
      breakerVersionAtStart,
      _breakerVersion,
    );
    if (
      finalConfig.circuitBreaker !== next.circuitBreaker
      || finalConfig.circuitBreakerReason !== next.circuitBreakerReason
    ) {
      await _persistScalpConfigWithRetry(finalConfig);
    }

    _config = finalConfig;
    if (resetPreflight) _resetPreflightState();
    return { ..._config };
  };

  const result = _configMutationTail.then(execute, execute);
  _configMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function _scheduleBreakerPersistenceRetry(): void {
  if (_breakerPersistRetryTimer || !_config.circuitBreaker) return;
  _breakerPersistRetryTimer = setTimeout(() => {
    _breakerPersistRetryTimer = null;
    if (!_config.circuitBreaker) return;
    const latestVersion = _breakerVersion;
    void _enqueueScalpConfigMutation(
      (current) => {
        if (!current.circuitBreaker || _breakerVersion !== latestVersion) {
          return current;
        }
        return {
          ...current,
          circuitBreaker: true,
          circuitBreakerReason: _config.circuitBreakerReason,
        };
      },
      false,
    ).catch((persistErr) => {
      logger.error(
        { persistErr, breakerVersion: _breakerVersion },
        "[kalshi-scalper] circuit-breaker persistence retry failed — will retry",
      );
      _scheduleBreakerPersistenceRetry();
    });
  }, 5_000);
}

async function _tripCircuitBreaker(reason: string, requireDurable = false): Promise<void> {
  // Always retain the event and reason, even when the operator has disabled
  // enforcement. Re-enabling protection will immediately respect this latch.
  const eventVersion = ++_breakerVersion;
  _config = { ..._config, circuitBreaker: true, circuitBreakerReason: reason };
  logger.error(
    { reason, enforced: _config.circuitBreakerEnabled },
    _config.circuitBreakerEnabled
      ? "[kalshi-scalper] CIRCUIT BREAKER TRIPPED — halting new scalp attempts"
      : "[kalshi-scalper] circuit-breaker event recorded — enforcement disabled, scans continue",
  );
  // Persist through the serialized writer. If a newer event arrived before
  // this queued operation began, leave its reason untouched.
  await persistCircuitBreakerWithPolicy(
    () => _enqueueScalpConfigMutation(
      (current) => _breakerVersion === eventVersion
        ? { ...current, circuitBreaker: true, circuitBreakerReason: reason }
        : current,
      false,
    ),
    (persistErr) => {
      // Keep in-memory breaker true and retry in the background until the
      // transient DB failure clears. Strict callers also receive the failure.
      logger.error(
        { persistErr, reason, eventVersion, requireDurable },
        "[kalshi-scalper] CRITICAL: circuit breaker persist FAILED — breaker active in memory; durable retry scheduled",
      );
      _scheduleBreakerPersistenceRetry();
    },
    requireDurable,
  );
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initScalper(): Promise<void> {
  await runScalpMigrations();
  setContrarianRegularExposureReader((mode, symbol, windowKey, ticker) =>
    _regularPositionCompatibilitySync(mode, symbol, windowKey, ticker, "yes").status !== "none"
    || _regularPositionCompatibilitySync(mode, symbol, windowKey, ticker, "no").status !== "none",
  );
  await initContrarianExperiment();
  _config = await loadScalpConfigFromDB();
  _resetPreflightState();
  logger.info(
    {
      enabled: _config.enabled,
      mode: _config.mode,
      dailyCapDollars: _config.dailyCapDollars,
      openCapDollars: _config.openCapDollars,
      circuitBreakerEnabled: _config.circuitBreakerEnabled,
      circuitBreaker: _config.circuitBreaker,
    },
    "[kalshi-scalper] initialized",
  );

  // Recover any submitting rows from a prior crash
  await _recoverSubmittingOrders().catch((err) =>
    logger.warn({ err }, "[kalshi-scalper] submitting-order recovery failed (non-fatal)"),
  );

  _startScanLoop();
  setInterval(() => { _evaluateSettlements().catch(() => {}); }, 30_000);
  setInterval(() => { _evaluateShadowSettlements().catch(() => {}); }, 30_000);
}

function _startScanLoop(): void {
  if (_scanInterval) clearInterval(_scanInterval);
  _scanInterval = setInterval(() => {
    _runScanTick().catch((err) =>
      logger.warn({ err }, "[kalshi-scalper] scan tick error (non-fatal)"),
    );
  }, SCALP_SCAN_INTERVAL_MS);
  logger.info(
    { intervalMs: SCALP_SCAN_INTERVAL_MS },
    "[kalshi-scalper] scan loop started",
  );
}

// ---------------------------------------------------------------------------
// Startup: recover stuck "submitting" rows
// ---------------------------------------------------------------------------

async function _recoverSubmittingOrders(): Promise<void> {
  const stuck = await getSubmittingScalpOrders();
  if (stuck.length === 0) return;
  for (const order of stuck) {
    const reconciliation = await _fetchScalpReconciliation(order);
    if (reconciliation.outcome !== "ambiguous") {
      await _applyScalpReconciliation(order, reconciliation);
      logger.warn(
        { id: order.id, symbol: order.symbol, outcome: reconciliation.outcome },
        "[kalshi-scalper] recovered submitting order from authoritative exchange history",
      );
      continue;
    }
    logger.warn(
      { id: order.id, symbol: order.symbol, mode: order.mode, reconciliationReason: reconciliation.reason },
      "[kalshi-scalper] found submitting order from prior crash — marking UNKNOWN, tripping breaker (reserved budget retained)",
    );
    // Mark order UNKNOWN (indeterminate fill), NOT error. Retain reserved budget.
    await finalizeScalpOrder(
      order.id, "unknown", 0, null, null, 0, order.orderId,
      "unknown_fill_state_after_crash",
      reconciliation.reason,
    ).catch(() => {});
    // Mark reservation unknown WITHOUT releasing reserved budget (fail-closed).
    await updateReservationStatus(
      order.mode, order.symbol, order.windowKey, "unknown",
      "unknown_fill_state_after_crash", false,
    ).catch(() => {});
    // Create incident
    const incidentId = crypto.randomUUID();
    const incident: ScalpIncident = {
      id: incidentId,
      orderId: order.id,
      mode: order.mode,
      symbol: order.symbol,
      windowKey: order.windowKey,
      ticker: order.ticker,
      severity: "high",
      description: "Order found in submitting state after restart — fill status unknown",
      expectedBandMin: 0,
      expectedBandMax: 1,
      actualWinningCost: 0,
      createdAt: new Date(),
    };
    await insertScalpIncident(incident).catch(() => {});
    await setScalpOrderIncident(order.id, incidentId).catch(() => {});
    await _tripCircuitBreaker("submitting_order_found_after_restart");
  }
}

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------

export function getScalpConfig(): ScalpConfig {
  return { ..._config };
}

/**
 * Apply a partial update. Persists the merged canonical config BEFORE replacing
 * in-memory. Validates both the partial input and the effective merged config.
 * Preserves explicit null for dailyCapDollars. Open exposure is mandatory.
 * Never allows overwriting server-owned circuitBreaker state via this path.
 */
/**
 * Merge a STRICTLY-PARSED, normalized config patch into the live config.
 *
 * The patch MUST already have been produced by parseScalpConfigPatch (typed,
 * range-checked, allowlisted). This function does no coercion; it only merges
 * present fields. The operator-owned enforcement toggle may change here;
 * circuitBreaker / circuitBreakerReason reset only via resetCircuitBreaker.
 */
export async function updateScalpConfig(patch: ScalpConfigPatch): Promise<ScalpConfig> {
  const updated = await _enqueueScalpConfigMutation((current) => {
    // Normalize parsed per-market overrides from the freshest serialized
    // config. Explicit null clears that override field.
    let mergedOverrides = current.perMarketOverrides;
    if (patch.perMarketOverrides !== undefined) {
      mergedOverrides = patch.perMarketOverrides.map((ov): ScalpPerMarketOverride => {
        const norm: ScalpPerMarketOverride = { symbol: ov.symbol };
        if (ov.paused !== undefined) norm.paused = ov.paused;
        if (typeof ov.minBand === "number") norm.minBand = ov.minBand;
        if (typeof ov.maxBand === "number") norm.maxBand = ov.maxBand;
        if (typeof ov.windowSeconds === "number") norm.windowSeconds = ov.windowSeconds;
        if (typeof ov.budgetDollars === "number") norm.budgetDollars = ov.budgetDollars;
        return norm;
      });
    }

    const merged: ScalpConfig = {
      ...current,
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
      mode: patch.mode !== undefined ? patch.mode : current.mode,
      globalBandMin: patch.globalBandMin !== undefined ? patch.globalBandMin : current.globalBandMin,
      globalBandMax: patch.globalBandMax !== undefined ? patch.globalBandMax : current.globalBandMax,
      finalWindowSeconds: patch.finalWindowSeconds !== undefined ? patch.finalWindowSeconds : current.finalWindowSeconds,
      budgetDollars: patch.budgetDollars !== undefined ? patch.budgetDollars : current.budgetDollars,
      dailyCapDollars: patch.dailyCapDollars !== undefined ? patch.dailyCapDollars : current.dailyCapDollars,
      openCapDollars: patch.openCapDollars !== undefined ? patch.openCapDollars : current.openCapDollars,
      freefallGuardEnabled: patch.freefallGuardEnabled !== undefined ? patch.freefallGuardEnabled : current.freefallGuardEnabled,
      freefallConsecutiveSeconds: patch.freefallConsecutiveSeconds !== undefined ? patch.freefallConsecutiveSeconds : current.freefallConsecutiveSeconds,
      favorableTrendConfirmationEnabled: patch.favorableTrendConfirmationEnabled !== undefined
        ? patch.favorableTrendConfirmationEnabled
        : current.favorableTrendConfirmationEnabled,
      coordinatedDirectionClearanceEnabled:
        patch.coordinatedDirectionClearanceEnabled !== undefined
          ? patch.coordinatedDirectionClearanceEnabled
          : current.coordinatedDirectionClearanceEnabled,
      freefallLookbackSeconds: patch.freefallLookbackSeconds !== undefined ? patch.freefallLookbackSeconds : current.freefallLookbackSeconds,
      freefallThresholdPct: patch.freefallThresholdPct !== undefined ? patch.freefallThresholdPct : current.freefallThresholdPct,
      rapidMoveGuardEnabled: patch.rapidMoveGuardEnabled !== undefined ? patch.rapidMoveGuardEnabled : current.rapidMoveGuardEnabled,
      rapidMoveLookbackSeconds: patch.rapidMoveLookbackSeconds !== undefined ? patch.rapidMoveLookbackSeconds : current.rapidMoveLookbackSeconds,
      rapidMoveThresholdPct: patch.rapidMoveThresholdPct !== undefined ? patch.rapidMoveThresholdPct : current.rapidMoveThresholdPct,
      targetProximityGuardEnabled: patch.targetProximityGuardEnabled !== undefined ? patch.targetProximityGuardEnabled : current.targetProximityGuardEnabled,
      targetProximityThresholdPct: patch.targetProximityThresholdPct !== undefined ? patch.targetProximityThresholdPct : current.targetProximityThresholdPct,
      circuitBreakerEnabled: patch.circuitBreakerEnabled !== undefined ? patch.circuitBreakerEnabled : current.circuitBreakerEnabled,
      perMarketOverrides: mergedOverrides,
      circuitBreaker: current.circuitBreaker,
      circuitBreakerReason: current.circuitBreakerReason,
    };

    if (merged.globalBandMin >= merged.globalBandMax) {
      throw new Error("Invalid scalp config: globalBandMin must be less than globalBandMax");
    }
    return merged;
  }, true);

  logger.info(
    {
      enabled: updated.enabled,
      mode: updated.mode,
      dailyCapDollars: updated.dailyCapDollars,
      openCapDollars: updated.openCapDollars,
      circuitBreakerEnabled: updated.circuitBreakerEnabled,
      targetProximityGuardEnabled: updated.targetProximityGuardEnabled,
      targetProximityThresholdPct: updated.targetProximityThresholdPct,
    },
    "[kalshi-scalper] config updated",
  );
  return updated;
}

/** Error thrown when a breaker reset is refused due to unresolved live attempts. */
export class UnresolvedAttemptsError extends Error {
  readonly unresolvedCount: number;
  readonly details: Awaited<ReturnType<typeof getUnresolvedLiveAttempts>>;
  constructor(count: number, details: Awaited<ReturnType<typeof getUnresolvedLiveAttempts>>) {
    super(
      `Cannot reset circuit breaker: ${count} unresolved live attempt(s) require reconciliation with Kalshi before reset.`,
    );
    this.name = "UnresolvedAttemptsError";
    this.unresolvedCount = count;
    this.details = details;
  }
}

export async function resetCircuitBreaker(): Promise<ScalpConfig> {
  const resetRequestedAtVersion = _breakerVersion;
  const updated = await _enqueueScalpConfigMutation(async (current) => {
    // A stale claimed reservation with no order-intent row never reached the
    // broker boundary. Release that provable pre-submit orphan before deciding
    // whether genuinely unresolved exchange exposure still blocks the reset.
    const releasedPreSubmit = await releaseStalePreSubmitLiveReservations();
    if (releasedPreSubmit.length > 0) {
      logger.warn(
        { releasedPreSubmit },
        "[kalshi-scalper] released stale pre-submit reservations with no order intent",
      );
    }
    // REFUSE while any unresolved live attempt exists — an operator must
    // authoritatively reconcile (out-of-band) before resuming. Fail-closed.
    const unresolved = await countUnresolvedLiveAttempts();
    if (unresolved > 0) {
      const details = await getUnresolvedLiveAttempts();
      logger.error(
        { unresolved },
        "[kalshi-scalper] circuit breaker reset REFUSED — unresolved live attempts require reconciliation",
      );
      throw new UnresolvedAttemptsError(unresolved, details);
    }
    if (_breakerVersion !== resetRequestedAtVersion) {
      throw new Error("A new Scalper safety event occurred while the reset was being checked. Review the latest reason before resetting again.");
    }
    return { ...current, circuitBreaker: false, circuitBreakerReason: null };
  }, true);

  if (updated.circuitBreaker) {
    throw new Error("A new Scalper safety event occurred while the reset was being saved. Review the latest reason before resetting again.");
  }
  logger.info("[kalshi-scalper] circuit breaker reset");
  return updated;
}

export class ScalpReconciliationError extends Error {
  readonly reason: string;
  readonly evidence: Record<string, unknown>;
  constructor(reason: string, evidence: Record<string, unknown>) {
    super(
      reason === "no_unique_exchange_order_match"
        ? "Kalshi did not return one uniquely matching terminal order. The attempt remains blocked."
        : "Kalshi evidence was incomplete or ambiguous. The attempt remains blocked.",
    );
    this.name = "ScalpReconciliationError";
    this.reason = reason;
    this.evidence = evidence;
  }
}

export async function reconcileUnresolvedScalpOrder(orderRecordId: string) {
  const order = await getScalpOrderById(orderRecordId);
  if (!order || order.mode !== "live") {
    throw new Error("Unresolved live Scalper order was not found");
  }
  if (!["submitting", "unknown"].includes(order.status)) {
    return {
      ok: true,
      alreadyResolved: true,
      outcome: order.status,
      message: "This Scalper order was already resolved.",
    };
  }
  const persistedRejection = parseDefinitiveScalpOrderRejection(
    order.errorMessage ?? order.exchangeResponseReason,
  );
  const result: ScalpReconciliationResult = persistedRejection == null
    ? await _fetchScalpReconciliation(order)
    : {
        outcome: "zero_fill",
        reason: `definitive_http_rejection_${persistedRejection.status}`,
        orderId: null,
        filledCount: 0,
        avgFillPrice: null,
        budgetSpent: 0,
        evidence: {
          source: "persisted_definitive_http_rejection",
          httpStatus: persistedRejection.status,
          exchangeCode: persistedRejection.code,
        },
      };
  if (result.outcome === "ambiguous") {
    throw new ScalpReconciliationError(result.reason, result.evidence);
  }
  const persistence = await _applyScalpReconciliation(order, result);
  logger.warn(
    {
      orderRecordId,
      symbol: order.symbol,
      windowKey: order.windowKey,
      outcome: result.outcome,
      exchangeOrderId: result.orderId,
      persistence,
    },
    "[kalshi-scalper] unresolved live order reconciled from authoritative exchange evidence",
  );
  return {
    ok: true,
    alreadyResolved: persistence === "already_resolved",
    reservationReleased: persistence !== "resolved_held",
    outcome: result.outcome,
    symbol: order.symbol,
    windowKey: order.windowKey,
    exchangeOrderId: result.orderId,
    filledCount: result.filledCount,
    avgFillPrice: result.avgFillPrice,
    message: persistence === "resolved_held"
      ? `${order.symbol} order was reconciled, but another order record in this attempt still needs reconciliation.`
      : result.outcome === "zero_fill"
        ? `${order.symbol} was authoritatively reconciled as zero fill.`
        : `${order.symbol} was reconciled as a ${result.filledCount}-contract fill.`,
  };
}

// ---------------------------------------------------------------------------
// Freefall guard price sample collection
// ---------------------------------------------------------------------------

/**
 * Collect one underlying price sample for a symbol.
 *
 * Returns true when a fresh, valid sample was appended; false when the fetch
 * failed or returned an unusable price. The boolean is AUTHORITATIVE: callers
 * that need a guaranteed-fresh sample (e.g. the final Freefall Guard) must treat
 * `false` as "no fresh data" and fail closed — existing old samples must NOT
 * mask a failed fresh fetch.
 */
function _removeQueuedSampleJob(queue: PriceSampleJob[], job: PriceSampleJob): void {
  const index = queue.indexOf(job);
  if (index >= 0) queue.splice(index, 1);
}

function _drainPriceSampleQueue(): void {
  while (_activePriceSampleFetches < SCALP_MAX_CONCURRENT_CANDIDATES) {
    const priority = selectNextScalpSamplePriority({
      activeTotal: _activePriceSampleFetches,
      activeBackground: _activeBackgroundPriceSampleFetches,
      maxTotal: SCALP_MAX_CONCURRENT_CANDIDATES,
      maxBackground: SCALP_MAX_CONCURRENT_BACKGROUND_SAMPLES,
      authoritativeQueued: _authoritativeSampleQueue.length,
      backgroundQueued: _backgroundSampleQueue.length,
    });
    if (!priority) return;
    const job = priority === "authoritative"
      ? _authoritativeSampleQueue.shift()
      : _backgroundSampleQueue.shift();
    if (!job) return;
    if (job.started) continue;
    job.started = true;
    _activePriceSampleFetches += 1;
    if (job.priority === "background") _activeBackgroundPriceSampleFetches += 1;
    void (async () => {
      try {
        // getTicker has its own AbortController-backed request timeout.
        const price = await _fetchScalpUnderlyingPrice(job.product);
        if (!Number.isFinite(price) || price <= 0) return false;
        const samples = _priceSamples.get(job.symbol) ?? [];
        samples.push({ price, at: Date.now() });
        if (samples.length > MAX_PRICE_SAMPLES) {
          samples.splice(0, samples.length - MAX_PRICE_SAMPLES);
        }
        _priceSamples.set(job.symbol, samples);
        return true;
      } catch {
        // Fetch failed — no fresh sample available.
        return false;
      }
    })()
      .then(job.resolve)
      .finally(() => {
        _activePriceSampleFetches -= 1;
        if (job.priority === "background") _activeBackgroundPriceSampleFetches -= 1;
        if (_priceSampleJobs.get(job.key) === job) {
          _priceSampleJobs.delete(job.key);
        }
        _drainPriceSampleQueue();
      });
  }
}

function _collectPriceSample(
  symbol: string,
  product: string,
  priority: PriceSamplePriority = "authoritative",
): Promise<boolean> {
  const key = symbol.toUpperCase();
  const existing = _priceSampleJobs.get(key);
  if (existing) {
    if (
      priority === "authoritative" &&
      existing.priority === "background" &&
      !existing.started
    ) {
      existing.priority = "authoritative";
      _removeQueuedSampleJob(_backgroundSampleQueue, existing);
      _authoritativeSampleQueue.push(existing);
      _drainPriceSampleQueue();
    }
    return existing.promise;
  }

  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  const job: PriceSampleJob = {
    key,
    symbol: key,
    product,
    priority,
    started: false,
    promise,
    resolve,
  };
  _priceSampleJobs.set(key, job);
  if (priority === "authoritative") {
    _authoritativeSampleQueue.push(job);
  } else {
    _backgroundSampleQueue.push(job);
  }
  _drainPriceSampleQueue();
  return promise;
}

interface ScalpPreflightTarget {
  symbol: string;
  product: string;
  closeTime: string;
  params: ReturnType<typeof resolveEffectiveParams>;
}

async function _runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        await worker(item);
      }
    }),
  );
}

function _currentWindowCloseTime(windowKey: string): string | null {
  const openMs = Date.parse(`${windowKey}:00.000Z`);
  if (!Number.isFinite(openMs)) return null;
  return new Date(openMs + 15 * 60_000).toISOString();
}

function _getPreflightTargets(windowKey: string, nowMs: number): {
  targets: ScalpPreflightTarget[];
  startsInSeconds: number | null;
} {
  const closeTime = _currentWindowCloseTime(windowKey);
  if (!closeTime) return { targets: [], startsInSeconds: null };
  const secondsRemaining = (Date.parse(closeTime) - nowMs) / 1_000;
  if (!Number.isFinite(secondsRemaining) || secondsRemaining <= 0) {
    return { targets: [], startsInSeconds: null };
  }

  const targets: ScalpPreflightTarget[] = [];
  let startsInSeconds: number | null = null;
  for (const coin of CRYPTO_COINS) {
    const symbol = coin.symbol.toUpperCase();
    if (!KALSHI_SERIES[symbol]) continue;
    const params = resolveEffectiveParams(_config, symbol, "");
    if (params.paused) continue;
    const startsIn = Math.max(0, secondsRemaining - params.finalWindowSeconds);
    startsInSeconds = startsInSeconds == null ? startsIn : Math.min(startsInSeconds, startsIn);
    if (startsIn <= SCALP_PREFLIGHT_LEAD_SECONDS) {
      targets.push({ symbol, product: coin.product, closeTime, params });
    }
  }
  return { targets, startsInSeconds };
}

async function _runPreflight(
  windowKey: string,
  targets: ScalpPreflightTarget[],
  startsInSeconds: number,
): Promise<void> {
  const mode = _config.mode;
  _warmRegularPositionReadView(mode, windowKey);
  const sampleTime = Date.now();
  const accountPromise = Promise.all([
    getScalpCommittedTotals(mode, windowKey),
    mode === "live"
      ? getBalance().then(
          (balance) => ({ available: balance.availableBalance, error: null as string | null }),
          (err) => ({ available: null, error: String(err) }),
        )
      : Promise.resolve({ available: null, error: null as string | null }),
  ]);

  const needsIdentity = targets.filter(
    (target) => !_preflightIdentityReady.has(`${windowKey}:${target.symbol}`),
  );
  await _runWithConcurrency(needsIdentity, SCALP_MAX_CONCURRENT_CANDIDATES, async (target) => {
    try {
      await fetchKalshiTarget(target.symbol, new Date(target.closeTime), true);
      const refreshed = getKalshiCachedData(target.symbol);
      if (
        refreshed?.ticker &&
        refreshed.closeTime &&
        Math.abs(Date.parse(refreshed.closeTime) - Date.parse(target.closeTime)) <= 30_000
      ) {
        _preflightIdentityReady.add(`${windowKey}:${target.symbol}`);
      }
    } catch (err) {
      logger.debug(
        { err, symbol: target.symbol, windowKey },
        "[kalshi-scalper] preflight identity warm-up failed",
      );
    }
  });

  const [{ dailyCommitted, openCommitted }, balance] = await accountPromise;
  if (windowKey !== currentWindowKey() || mode !== _config.mode) return;

  const marketStatuses = targets.map((target): ScalpPreflightMarketStatusInternal => {
    let reason: string | null = null;
    if (_isCircuitBreakerBlocking()) {
      reason = "circuit_breaker_active";
    } else if (mode === "live" && balance.error) {
      reason = "balance_unavailable";
    } else if (
      mode === "live" &&
      balance.available != null &&
      balance.available + 1e-9 < target.params.budgetDollars
    ) {
      reason = "insufficient_balance";
    } else if (
      _config.dailyCapDollars != null &&
      dailyCommitted + target.params.budgetDollars > _config.dailyCapDollars + 1e-9
    ) {
      reason = "daily_cap_reached";
    } else if (
      _config.openCapDollars != null &&
      openCommitted + target.params.budgetDollars > _config.openCapDollars + 1e-9
    ) {
      reason = "open_cap_reached";
    } else if (!_preflightIdentityReady.has(`${windowKey}:${target.symbol}`)) {
      reason = "market_identity_not_ready";
    }
    return { symbol: target.symbol, ready: reason == null, reason };
  });
  const readySymbols = marketStatuses.filter((market) => market.ready).length;
  const reason =
    readySymbols === targets.length
      ? null
      : readySymbols === 0
        ? marketStatuses[0]?.reason ?? "markets_not_ready"
        : `${targets.length - readySymbols}_markets_blocked_or_warming`;

  _preflightStatus = {
    state: readySymbols === 0 ? "blocked" : "ready",
    mode,
    windowKey,
    checkedAt: Date.now(),
    startsInSeconds,
    readySymbols,
    totalSymbols: targets.length,
    reason,
    availableBalance: balance.available,
    dailyCommitted,
    openCommitted,
    markets: marketStatuses,
  };
}

function _maybeStartPreflight(windowKey: string, nowMs: number): void {
  const plan = _getPreflightTargets(windowKey, nowMs);
  if (plan.targets.length === 0) {
    _preflightStatus = {
      ..._preflightStatus,
      state: "idle",
      mode: _config.mode,
      windowKey,
      startsInSeconds: plan.startsInSeconds,
      readySymbols: 0,
      totalSymbols: 0,
      markets: [],
      reason: null,
    };
    return;
  }

  const startsInSeconds = plan.startsInSeconds ?? 0;
  _preflightStatus = {
    ..._preflightStatus,
    state: _preflightInFlight ? "warming" : _preflightStatus.state,
    mode: _config.mode,
    windowKey,
    startsInSeconds,
    totalSymbols: plan.targets.length,
  };
  const preflightRefreshMs = scalpPreflightRefreshMs(startsInSeconds);
  if (_preflightInFlight || nowMs - _lastPreflightStartedAt < preflightRefreshMs) {
    return;
  }

  _preflightInFlight = true;
  _lastPreflightStartedAt = nowMs;
  _preflightStatus = {
    ..._preflightStatus,
    state: "warming",
    checkedAt: nowMs,
    reason: null,
  };
  void _runPreflight(windowKey, plan.targets, startsInSeconds)
    .catch((err) => {
      _preflightStatus = {
        ..._preflightStatus,
        state: "blocked",
        checkedAt: Date.now(),
        reason: `preflight_failed:${String(err)}`,
      };
      logger.warn({ err, windowKey }, "[kalshi-scalper] preflight failed");
    })
    .finally(() => {
      _preflightInFlight = false;
    });
}

// ---------------------------------------------------------------------------
// Main scan tick
// ---------------------------------------------------------------------------

async function _runScanTick(): Promise<void> {
  return _scanRunner.run();
}

async function _executeScanPass(): Promise<void> {
  _running = true;
  try {
    await _doScanTick();
    _lastScanAt = Date.now();
    _lastError = null;
  } catch (err) {
    _lastError = String(err);
    throw err;
  } finally {
    _running = false;
  }
}

const _scanRunner = createCoalescedAsyncRunner(_executeScanPass);
const _contrarianMonitorAttempts = new ContrarianMonitorAttemptScheduler();

async function _doScanTick(): Promise<void> {
  const wk = currentWindowKey();
  if (!wk) return;
  if (_lastObservedWindowKey !== wk) {
    if (_lastObservedWindowKey) {
      _finalizeShadowWindow(_lastObservedWindowKey, Date.now());
    }
    _lastObservedWindowKey = wk;
    _terminalAttemptKeys.clear();
    _nextAttemptAt.clear();
    _funnelRecorder.clearExceptWindow(wk);
    // A new market window owns a new real-time direction baseline. Preflight
    // samples from the previous market must never count toward eligibility.
    _priceSamples.clear();
    _contrarianMonitorAttempts.clearExceptWindow(wk);
    _resetPreflightState();
  }

  // Shadow observation remains useful when live/paper execution is disabled or
  // a symbol is operator-paused. Keep its existing underlying sample source
  // warm without making any additional Kalshi quote request.
  if (Date.now() - _lastSampleCollectionAt >= 1_000) {
    _lastSampleCollectionAt = Date.now();
    for (const coin of CRYPTO_COINS) {
      if (KALSHI_SERIES[coin.symbol]) {
        void _collectPriceSample(coin.symbol, coin.product, "background");
      }
    }
  }
  // This lane intentionally precedes the normal enabled/breaker/candidate
  // returns. It observes every supported final-two-minute market from existing
  // cache/sample state and never mutates normal Scalper ownership.
  _monitorStrictContrarianMarkets(wk, Date.now());

  if (!_config.enabled) {
    _scheduleShadowObservation(wk);
    _preflightStatus = {
      ..._preflightStatus,
      state: "idle",
      reason: "scalper_disabled",
      startsInSeconds: null,
      readySymbols: 0,
      totalSymbols: 0,
    };
    return;
  }

  const mode = _config.mode;

  _maybeStartPreflight(wk, Date.now());
  if (_isCircuitBreakerBlocking()) {
    _scheduleShadowObservation(wk);
    _preflightStatus = {
      ..._preflightStatus,
      state: "blocked",
      reason: "circuit_breaker_active",
    };
    logger.debug("[kalshi-scalper] circuit breaker active — scan suppressed");
    return;
  }

  // Quick scan using cached public quotes to find candidates.
  const candidates = _findCandidates(wk);
  if (candidates.length === 0) {
    _scheduleShadowObservation(wk);
    return;
  }
  for (const candidate of candidates) {
    _recordScalpFunnelEvent(mode, wk, candidate.symbol, "candidate");
  }

  await _runWithConcurrency(candidates, SCALP_MAX_CONCURRENT_CANDIDATES, async (candidate) => {
    await _evaluateCandidate(candidate, wk, mode);
  });
  _scheduleShadowObservation(wk);
}

function _monitorStrictContrarianMarkets(windowKey: string, nowMs: number): void {
  for (const coin of CRYPTO_COINS) {
    const symbol = coin.symbol.toUpperCase();
    if (!KALSHI_SERIES[symbol]) continue;
    const cached = getKalshiCachedData(symbol);
    const closeTime = cached?.closeTime;
    const ticker = cached?.ticker;
    const targetPrice = cached?.value;
    if (!closeTime || !ticker || targetPrice == null || !Number.isFinite(targetPrice)) continue;
    if (!isInFinalWindow(closeTime, nowMs, 120, windowKey)) continue;
    const makeDecision = (side: "yes" | "no", at: number, decisionTarget: number) => evaluateFreefallPreSubmitGuard({
      // Contrarian owns this monitoring lane. Normal Scalper guard toggles and
      // thresholds must not disable or reshape strict reversal detection.
      directionEnabled: true,
      hasProduct: true,
      freshSampleSucceeded: true,
      samples: _priceSamples.get(symbol) ?? [],
      side,
      nowMs: at,
      eligibilityStartMs: Date.parse(closeTime) - 120_000,
      consecutiveSeconds: 4,
      favorableTrendConfirmationEnabled: true,
      coordinatedDirectionClearanceEnabled: false,
      targetPrice: decisionTarget,
      targetProximityGuardEnabled: false,
      targetProximityThresholdPct: 0,
      secondsRemaining: Math.max(0, (Date.parse(closeTime) - at) / 1_000),
      rapidMoveEnabled: false,
      rapidMoveLookbackSeconds: 4,
      rapidMoveThresholdPct: 0.5,
    });
    for (const protectedSide of ["yes", "no"] as const) {
      if (!_contrarianMonitorAttempts.allow(_config.mode, symbol, windowKey, protectedSide, nowMs)) continue;
      const pinnedTarget = targetPrice;
      const decision = makeDecision(protectedSide, nowMs, pinnedTarget);
      void triggerContrarianFromNormalGuard({
        sourceMode: _config.mode, symbol, windowKey, ticker, closeTime, protectedSide, decision,
        refreshAndRevalidate: async () => {
          const [identity, book, sampled] = await Promise.all([
            fetchKalshiTarget(symbol, new Date(closeTime), true).catch(() => null),
            fetchOrderbookPrices(ticker).catch(() => null),
            _collectPriceSample(symbol, coin.product, "background"),
          ]);
          const fresh = getKalshiCachedData(symbol);
          const quote = book ? validateOrderbookQuote(book, ticker, closeTime) : null;
          if (!identity || !isPinnedContrarianIdentityCurrent({
            ticker: fresh?.ticker, closeTime: fresh?.closeTime, targetPrice: fresh?.value,
            pinnedTicker: ticker, pinnedCloseTime: closeTime, pinnedTargetPrice: pinnedTarget,
          }) || Math.abs(identity - pinnedTarget) > 1e-9 || !sampled || !quote) {
            return { ok: false, reason: !quote ? "fresh_authenticated_quote_invalid" : "fresh_revalidation_failed", decision: null, yesAsk: null, noAsk: null, targetPrice: identity, closeTime: fresh?.closeTime ?? null, evidence: { monitoringPhase: "independent_strict_monitor", sampled } };
          }
          return { ok: true, reason: null, decision: makeDecision(protectedSide, Date.now(), identity), yesAsk: quote.yesAsk, noAsk: quote.noAsk, targetPrice: identity, closeTime, evidence: { monitoringPhase: "independent_strict_monitor" } };
        },
        finalValidationSync: () => {
          const current = getKalshiCachedData(symbol);
          if (currentWindowKey() !== windowKey || !isPinnedContrarianIdentityCurrent({
            ticker: current?.ticker, closeTime: current?.closeTime, targetPrice: current?.value,
            pinnedTicker: ticker, pinnedCloseTime: closeTime, pinnedTargetPrice: pinnedTarget,
          }) || !isInFinalWindow(closeTime, Date.now(), 120, windowKey)) return "outside_strict_window_before_submit";
          const strict = evaluateContrarianGuardEligibility(
            makeDecision(protectedSide, Date.now(), pinnedTarget),
            protectedSide,
            {
              finalWindowSeconds: 120,
              minDirectAsk: 0.01,
              maxDirectAsk: 0.03,
              minRepeatedAdverseMoves: 4,
              requireTargetCrossingOrReachableProjection: true,
            },
          );
          return strict.eligible ? null : `final_strict_${strict.reason}`;
        },
      }).catch((error) => logger.warn({ error, symbol }, "[kalshi-scalper] strict contrarian monitor failed"));
    }
  }
}

interface Candidate {
  symbol: string;
  ticker: string;
  closeTime: string;
  detectedAtMs: number;
  cachedYesAsk: number | null;
  cachedNoAsk: number | null;
  side: "yes" | "no";
  winningAsk: number;
}

function _findCandidates(wk: string): Candidate[] {
  const candidates: Candidate[] = [];
  const now = Date.now();

  for (const coin of CRYPTO_COINS) {
    const sym = coin.symbol.toUpperCase();
    if (!KALSHI_SERIES[sym]) continue;
    const key = _attemptKey(_config.mode, sym, wk);
    if (
      _attemptsInFlight.has(key) ||
      _terminalAttemptKeys.has(key) ||
      (_nextAttemptAt.get(key) ?? 0) > now
    ) {
      continue;
    }

    const params = resolveEffectiveParams(_config, sym, "");
    if (params.paused) continue;

    const cached = getKalshiCachedData(sym);
    if (!cached?.ticker || !cached.closeTime) continue;

    // Quick timing check before expensive orderbook fetch
    if (!isInFinalWindow(cached.closeTime, now, params.finalWindowSeconds, wk)) continue;

    // Use cached quotes for initial candidate detection
    const yesAsk = cached.yesAsk ?? null;
    // noAsk from cache: noAsk = 1 - yesBid
    const yesBid = cached.yesBid ?? null;
    const noAsk = yesBid != null ? 1 - yesBid : null;

    const match = selectScalpSide(yesAsk, noAsk, params.bandMin, params.bandMax);
    if (!match) continue;

    candidates.push({
      symbol: sym,
      ticker: cached.ticker,
      closeTime: cached.closeTime,
      detectedAtMs: now,
      cachedYesAsk: yesAsk,
      cachedNoAsk: noAsk,
      side: match.side,
      winningAsk: match.winningAsk,
    });
  }

  // Keep every independently qualified symbol in the bounded execution queue.
  // Priority only chooses which symbol receives a lane first.
  return prioritizeScalpCandidates(candidates);
}

/** Marker error: an order intent has been persisted (live submit crossed the
 *  fail-closed boundary). The outer catch must NOT release the reserved budget. */
class OrderIntentExistsError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(`order intent exists — fail closed: ${String(cause)}`);
    this.name = "OrderIntentExistsError";
    this.cause = cause;
  }
}

/**
 * Marker error: a persistence failure occurred AFTER the broker call (i.e. the
 * finalize+release transaction threw). The reserved budget must be retained
 * (the failed transaction rolled back, so reserved_budget is unchanged) and the
 * outer catch must treat it exactly like OrderIntentExistsError — NEVER release.
 */
class PostSubmitPersistenceError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(`post-submit persistence failed — fail closed: ${String(cause)}`);
    this.name = "PostSubmitPersistenceError";
    this.cause = cause;
  }
}

function _rememberReservationOutcome(
  key: string,
  status: string,
  reason: string | null,
  submittedOrders: number,
  nowMs = Date.now(),
): void {
  const retry = evaluateScalpReservationRetry({
    status,
    reason,
    elapsedMs: 0,
    submittedOrders,
  });
  if (retry.retryAfterMs != null) {
    _nextAttemptAt.set(key, nowMs + retry.retryAfterMs);
    _terminalAttemptKeys.delete(key);
  } else {
    _nextAttemptAt.delete(key);
    _terminalAttemptKeys.add(key);
  }
}

/**
 * Shared fail-closed handling for a LIVE order result that cannot be fully
 * verified (placeOrder threw, a response field was untrustworthy, or a
 * post-submit persistence failure). Never releases the reserved budget.
 *
 * Steps (each best-effort, breaker set FIRST and in-memory):
 *   1. Trip the circuit breaker (in-memory immediately, then persist).
 *   2. Best-effort mark the order UNKNOWN.
 *   3. Best-effort mark the reservation UNKNOWN WITHOUT release (release=false).
 *   4. Best-effort high-severity incident + link to the order.
 */
async function _handleUnknownExposure(args: {
  orderRecordId: string;
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  ticker: string;
  bandMin: number;
  bandMax: number;
  reason: string;
  description: string;
  exchangeOrderId?: string | null;
  exchangeResponseReason?: string | null;
  entryGuardEvidence?: ScalpEntryGuardEvidence | null;
}): Promise<void> {
  const {
    orderRecordId, mode, symbol, windowKey, ticker, bandMin, bandMax,
    reason, description, exchangeOrderId, exchangeResponseReason,
    entryGuardEvidence,
  } = args;

  // 1. Breaker first (fail-closed) — sets in-memory true synchronously.
  await _tripCircuitBreaker(reason);

  // 2. Best-effort mark the order UNKNOWN (do not throw on failure).
  await finalizeScalpOrder(
    orderRecordId, "unknown", 0, null, null, 0,
    exchangeOrderId ?? null, description, exchangeResponseReason ?? reason,
    entryGuardEvidence ?? null,
  ).catch((e) => logger.error({ e, orderRecordId }, "[kalshi-scalper] failed to mark order unknown (breaker already tripped)"));

  // 3. Best-effort mark reservation UNKNOWN WITHOUT releasing reserved budget.
  await updateReservationStatus(mode, symbol, windowKey, "unknown", description, false)
    .catch((e) => logger.error({ e, symbol, windowKey }, "[kalshi-scalper] failed to mark reservation unknown (budget retained)"));

  // 4. Best-effort incident.
  const incidentId = crypto.randomUUID();
  const incident: ScalpIncident = {
    id: incidentId,
    orderId: orderRecordId,
    mode,
    symbol,
    windowKey,
    ticker,
    severity: "high",
    description,
    expectedBandMin: bandMin,
    expectedBandMax: bandMax,
    actualWinningCost: 0,
    createdAt: new Date(),
  };
  await insertScalpIncident(incident).catch((e) => logger.error({ e, orderRecordId }, "[kalshi-scalper] failed to persist unknown-exposure incident"));
  await setScalpOrderIncident(orderRecordId, incidentId).catch(() => {});
}

async function _fetchScalpReconciliation(order: ScalpOrder): Promise<ScalpReconciliationResult> {
  try {
    const excludeExchangeOrderIds = await getSiblingScalpExchangeOrderIds(
      order.mode,
      order.symbol,
      order.windowKey,
      order.id,
    );
    return reconcileScalpOrderStrict({
      ticker: order.ticker,
      side: order.side,
      count: order.contractCount,
      limitPrice: order.limitPrice,
      clientOrderId: order.clientOrderId,
      exchangeOrderId: order.orderId,
      createdAt: order.createdAt,
      excludeExchangeOrderIds,
    });
  } catch (err) {
    logger.error(
      { err, orderRecordId: order.id },
      "[kalshi-scalper] failed to prepare authoritative reconciliation lookup",
    );
    return {
      outcome: "ambiguous",
      reason: "local_reconciliation_lookup_failed",
      candidateCount: 0,
      evidence: { source: "local_reconciliation_preparation", lookupFailed: true },
    };
  }
}

async function _applyScalpReconciliation(
  order: ScalpOrder,
  result: Exclude<ScalpReconciliationResult, { outcome: "ambiguous" }>,
): Promise<"resolved" | "resolved_held" | "already_resolved"> {
  const isFill = result.outcome === "confirmed_fill";
  const budgetSpent = result.budgetSpent;
  const params = resolveEffectiveParams(_config, order.symbol, order.ticker);
  const fillBand = isFill
    ? classifyScalpFillAgainstBand(
        order.side,
        result.avgFillPrice,
        params.bandMin,
        params.bandMax,
      )
    : null;
  const winningContractCost = fillBand?.winningContractCost ?? null;
  const incident = fillBand == null || fillBand.classification === "within_band"
    ? null
    : _buildFillBandIncident({
        orderId: order.id,
        mode: order.mode,
        symbol: order.symbol,
        windowKey: order.windowKey,
        ticker: order.ticker,
        side: order.side,
        bandMin: params.bandMin,
        bandMax: params.bandMax,
        fillBand,
        reconciled: true,
      });
  if (fillBand?.classification === "adverse_limit_breach") {
    const breakerReason = _fillAboveCeilingBreakerReason(
      order.symbol,
      order.side,
      fillBand.winningContractCost,
      params.bandMax,
    );
    // Latch the breaker in memory before releasing any held reservation. If
    // persistence fails, reconciliation aborts and the reservation stays held.
    await _tripCircuitBreaker(breakerReason, true);
  }
  let resolution: "resolved" | "resolved_held" | "already_resolved";
  try {
    resolution = await reconcileScalpOrderAndReleaseReservation({
      orderRecordId: order.id,
      mode: order.mode,
      symbol: order.symbol,
      windowKey: order.windowKey,
      status: isFill ? "filled" : "zero_fill",
      filledCount: result.filledCount,
      avgFillPrice: result.avgFillPrice,
      winningContractCost,
      budgetSpent,
      exchangeOrderId: result.orderId,
      exchangeResponseReason: result.reason,
      evidence: {
        ...result.evidence,
        reconciledAt: new Date().toISOString(),
      },
      entryGuardEvidence: order.entryGuardEvidence,
      layeredRegularPositionId: order.layeredRegularPositionId,
      layeredRegularSide: order.layeredRegularSide,
      incident,
    });
  } catch (err) {
    // This function is used directly inside the post-submit uncertainty path.
    // Escalate through the existing protected error so the outer attempt catch
    // can never release a reservation after a live POST may have succeeded.
    throw new PostSubmitPersistenceError(err);
  }
  if (resolution !== "resolved_held") {
    _terminalAttemptKeys.add(`${order.mode}:${order.symbol}:${order.windowKey}`);
    _nextAttemptAt.delete(`${order.mode}:${order.symbol}:${order.windowKey}`);
  }
  return resolution;
}

function _fillAboveCeilingBreakerReason(
  symbol: string,
  side: "yes" | "no",
  winningContractCost: number,
  bandMax: number,
): string {
  return `fill_above_ceiling:${symbol}:${side}:cost=${winningContractCost.toFixed(4)}:ceiling=${bandMax}`;
}

function _buildFillBandIncident(input: {
  orderId: string;
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  ticker: string;
  side: "yes" | "no";
  bandMin: number;
  bandMax: number;
  fillBand: Exclude<ScalpFillBandResult, { classification: "within_band" }>;
  reconciled: boolean;
}): ScalpIncident {
  const favorable = input.fillBand.classification === "favorable_price_improvement";
  const prefix = input.reconciled ? "Reconciled " : "";
  return {
    id: crypto.randomUUID(),
    orderId: input.orderId,
    mode: input.mode,
    symbol: input.symbol,
    windowKey: input.windowKey,
    ticker: input.ticker,
    severity: favorable ? "info" : "high",
    description: favorable
      ? `${prefix}favorable price improvement: winning-contract cost ${input.fillBand.winningContractCost.toFixed(4)} below configured minimum ${input.bandMin} for ${input.side} side`
      : `${prefix}winning-contract cost ${input.fillBand.winningContractCost.toFixed(4)} above configured ceiling ${input.bandMax} for ${input.side} side`,
    expectedBandMin: input.bandMin,
    expectedBandMax: input.bandMax,
    actualWinningCost: input.fillBand.winningContractCost,
    createdAt: new Date(),
  };
}

async function _evaluateCandidate(
  candidate: Candidate,
  windowKey: string,
  mode: ScalpMode,
): Promise<void> {
  const { symbol, ticker, closeTime } = candidate;
  const key = _attemptKey(mode, symbol, windowKey);
  if (_attemptsInFlight.has(key)) return;
  _attemptsInFlight.add(key);
  const latency = _beginAttemptLatency(
    mode,
    symbol,
    windowKey,
    candidate.detectedAtMs,
    closeTime,
  );
  try {
    const params = resolveEffectiveParams(_config, symbol, ticker);
    // Pin the immutable execution-risk snapshot at claim time. Every sizing,
    // cap, band, window, freefall and balance decision downstream uses it.
    const snapshot: ExecutionRiskSnapshot = buildExecutionRiskSnapshot(
      _config,
      params,
      { symbol, windowKey, ticker, closeTime },
    );
    const budget = snapshot.budgetDollars;

    let claim: Awaited<ReturnType<typeof claimReservationAndCap>>;
    const claimStartedAtMs = Date.now();
    try {
      // Pass closeTime + finalWindowSeconds so claimReservationAndCap can enforce
      // the effective per-market final-window boundary atomically at claim time.
      claim = await claimReservationAndCap(
        crypto.randomUUID(), mode, symbol, windowKey, ticker, budget,
        snapshot.dailyCapDollars, snapshot.openCapDollars,
        closeTime, snapshot.finalWindowSeconds,
      );
    } catch (err) {
      latency.capClaimMs = Date.now() - claimStartedAtMs;
      _lastError = String(err);
      logger.warn({ err, symbol, windowKey, mode }, "[kalshi-scalper] claim-and-cap failed");
      return;
    }
    latency.capClaimMs = Date.now() - claimStartedAtMs;

    if (!claim.claimed) {
      if (claim.reason === "outside_window_at_claim") {
        // Window already closed by the time we got the lock — terminal for this window.
        _terminalAttemptKeys.add(key);
      } else if (claim.retryAfterMs != null) {
        _nextAttemptAt.set(key, Date.now() + claim.retryAfterMs);
      } else {
        _terminalAttemptKeys.add(key);
      }
      return;
    }
    if (!claim.allowed || !claim.reservationId) {
      _terminalAttemptKeys.add(key);
      logger.debug({ symbol, windowKey, reason: claim.reason }, "[kalshi-scalper] cap-denied, skipped");
      return;
    }

    try {
      await _executeScalpAttempt(
        claim.reservationId,
        candidate,
        windowKey,
        mode,
        snapshot,
        claim.submittedOrders,
        key,
        LIVE_SCALP_ATTEMPT_RUNTIME,
        latency,
      );
    } catch (err) {
      _lastError = String(err);
      if (err instanceof OrderIntentExistsError || err instanceof PostSubmitPersistenceError) {
        _terminalAttemptKeys.add(key);
        // FAIL-CLOSED: the broker was (or may have been) called. Do NOT release
        // the reserved budget here. Unknown handling already tripped the breaker.
        logger.error(
          { err: err.cause, kind: err.name, symbol, windowKey, mode },
          "[kalshi-scalper] post-intent failure — reserved budget retained (fail-closed)",
        );
        return;
      }
      // PRE-ORDER failure only: no intent persisted. Safe to release, but
      // arbitrary errors are terminal rather than blindly retried.
      logger.warn({ err, symbol, windowKey, mode }, "[kalshi-scalper] pre-order attempt error — releasing reservation");
      await updateReservationStatus(mode, symbol, windowKey, "error", String(err), true).catch(() => {});
      _terminalAttemptKeys.add(key);
    }
  } finally {
    _attemptsInFlight.delete(key);
    _finishAttemptLatency(latency);
  }
}

/**
 * SYNCHRONOUS authoritative final validation. Contains NO await so it can run in
 * the same synchronous turn immediately before an intent write or a placeOrder
 * call, with zero opportunity for `_config` / the current window / cached market
 * identity to change between the check and the guarded action.
 *
 * Re-resolves the freshest `_config` + effective params and re-compares the
 * IMMUTABLE pinned snapshot; also requires: not disabled (via snapshot.enabled
  * diff), circuit-breaker enforcement not blocking, and the current
  * window/identity still
 * matching the reservation. Returns a machine reason string on ANY change, or
 * null when it is safe to proceed.
 */
function _finalRiskValidationSync(
  snapshot: ExecutionRiskSnapshot,
  windowKey: string,
  symbol: string,
  ticker: string,
): string | null {
  // A latched breaker blocks only while operator enforcement is enabled.
  if (_isCircuitBreakerBlocking()) return "breaker_before_submit";

  // Window identity must still be current.
  const wkNow = currentWindowKey();
  if (!wkNow || wkNow !== windowKey) return "window_expired_before_submit";

  // Cached market identity must still match the reserved candidate exactly.
  const cached = getKalshiCachedData(symbol);
  if (!cached?.ticker || !cached.closeTime) return "identity_missing_before_submit";
  if (cached.ticker !== ticker || cached.closeTime !== snapshot.closeTime) {
    return "identity_changed_before_submit";
  }

  // Full immutable-snapshot diff against the freshest config + params.
  const params = resolveEffectiveParams(_config, symbol, ticker);
  const diff = compareRiskSnapshot(
    snapshot,
    _config,
    params,
    { symbol, windowKey, ticker, closeTime: cached.closeTime },
  );
  if (!diff.unchanged) return diff.reason ?? "risk_changed";

  // Refreshed close time must still fall in the current window.
  if (!isInFinalWindow(cached.closeTime, Date.now(), snapshot.finalWindowSeconds, wkNow)) {
    return "outside_window_before_submit";
  }
  // Experiment exposure is a separate live ledger, but is a synchronous
  // interlock here and therefore runs both before intent and post-intent.
  // Paper observations are never registered, preserving execution-mode
  // isolation.
  if (contrarianExposureRegistry.has(snapshot.mode, symbol, windowKey)) {
    return "contrarian_exposure_before_submit";
  }

  return null;
}

interface ScalpAttemptRuntime {
  nowMs: () => number;
  currentWindowKey: typeof currentWindowKey;
  fetchKalshiTarget: typeof fetchKalshiTarget;
  fetchOrderbookPrices: typeof fetchOrderbookPrices;
  collectPriceSample: typeof _collectPriceSample;
  getBalance: typeof getBalance;
  getKalshiCachedData: typeof getKalshiCachedData;
  updateReservationStatus: typeof updateReservationStatus;
  insertScalpOrderIntent: typeof insertScalpOrderIntent;
  finalizePaperOrderAndReleaseReservation: typeof finalizePaperOrderAndReleaseReservation;
  abortIntentAndReleaseReservation: typeof abortIntentAndReleaseReservation;
  placeScalpOrderStrict: typeof placeScalpOrderStrict;
  finalizeOrderAndReleaseReservation: typeof finalizeOrderAndReleaseReservation;
  finalRiskValidationSync: typeof _finalRiskValidationSync;
  regularPositionCompatibilitySync: typeof _regularPositionCompatibilitySync;
  recordFunnelEvent?: typeof _recordScalpFunnelEvent;
}
async function _executeScalpAttempt(
  reservationId: string,
  candidate: Candidate,
  windowKey: string,
  mode: ScalpMode,
  snapshot: ExecutionRiskSnapshot,
  priorSubmittedOrders: number,
  attemptKey: string,
  runtime: ScalpAttemptRuntime = LIVE_SCALP_ATTEMPT_RUNTIME,
  latency?: MutableScalpAttemptLatency,
): Promise<void> {
  const { symbol, ticker, closeTime, side: initialSide } = candidate;
  const attemptStartMs = runtime.nowMs();
  let identityRefreshMs: number | null = null;
  let quoteRefreshMs: number | null = null;
  let parallelRefreshMs: number | null = null;

  // NOTE: cap checks are NOT repeated here. They were performed atomically
  // inside claimReservationAndCap under the per-mode advisory lock, which
  // reserved snapshot.budgetDollars. Re-running getTodayScalpCommitted +
  // checkDailyCap here would double-count and reintroduce a cross-process race.

  // Sizing/exposure ALWAYS uses the durable reserved amount, never a re-resolved
  // params2 budget. This is the authoritative value throughout.
  const reservedBudget = snapshot.budgetDollars;

  // Helper: build base timing evidence from the close time at skip time.
  const _timingEvidence = (): ScalpSkipEvidence => {
    const nowMs = runtime.nowMs();
    const closeMs = new Date(closeTime).getTime();
    const secondsRemainingVal = Number.isFinite(closeMs)
      ? (closeMs - nowMs) / 1000
      : null;
    return {
      timingPhase: resolveTimingPhase(closeTime, nowMs, snapshot.finalWindowSeconds, SCALP_PREFLIGHT_LEAD_SECONDS),
      closeTimeIso: closeTime,
      secondsRemaining: secondsRemainingVal,
      effectiveWindowSeconds: snapshot.finalWindowSeconds,
      windowKey,
      reservedTicker: ticker,
      skippedAt: new Date(nowMs).toISOString(),
      elapsedMs: nowMs - attemptStartMs,
      identityRefreshMs,
      quoteRefreshMs,
      parallelRefreshMs,
    };
  };
  const _buildGuardOutcomeStudy = (
    decision: ReturnType<typeof evaluateFreefallPreSubmitGuard>,
    protectedSide: "yes" | "no",
    yesAsk: number | null,
    noAsk: number | null,
    observedAtMs: number,
    phase: string,
  ): NonNullable<ScalpSkipEvidence["guardOutcomeStudy"]> | null =>
    buildContrarianGuardOutcomeStudyPayload({
      sourceMode: mode,
      symbol,
      windowKey,
      ticker,
      closeTime,
      protectedSide,
      decision,
      yesAsk,
      noAsk,
      budgetDollars: reservedBudget,
      observedAtMs,
      evidence: { phase },
    });

  // ── FINAL PRE-SUBMIT BOUNDARY ─────────────────────────────────────────────
  // Identity, authenticated quote, balance, and fresh Freefall sample are
  // warmed concurrently. Every result remains mandatory and fail-closed.
  //
  // CONCURRENCY AUDIT: identityResult, orderbookResult, freshSampleResult, and
  // balanceResult are fetched via a single Promise.all() below — this is already
  // the optimal concurrent pattern. No serial latency exists in this path. The
  // identity refresh (fetchKalshiTarget) is independent of orderbook, freefall
  // samples, and balance; all four requests race in parallel. No further
  // optimization is possible without relaxing authenticated quote validation
  // (which we must not do). Evidence is recorded for the latency of the whole
  // concurrent fetch below.

  if (_isCircuitBreakerBlocking()) {
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "breaker_before_submit", true, _timingEvidence());
    return;
  }

  // Confirm window identity still matches
  const wkNow = runtime.currentWindowKey();
  if (!wkNow || wkNow !== windowKey) {
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "window_expired_before_submit", true, _timingEvidence());
    return;
  }

  const concurrentFetchStartMs = runtime.nowMs();
  const identityRefreshStartMs = runtime.nowMs();
  const quoteRefreshStartMs = runtime.nowMs();
  const coin = CRYPTO_COINS.find((item) => item.symbol.toUpperCase() === symbol);
  const priceGuardSampleRequested =
    snapshot.freefallGuardEnabled
    || snapshot.rapidMoveGuardEnabled
    || snapshot.targetProximityGuardEnabled;
  const [identityResult, orderbookResult, freshSampleResult, balanceResult] = await Promise.all([
    runtime.fetchKalshiTarget(symbol, new Date(closeTime), true).then(
      (target) => ({ ok: true as const, target, error: null as unknown, latencyMs: runtime.nowMs() - identityRefreshStartMs }),
      (error) => ({ ok: false as const, error, latencyMs: runtime.nowMs() - identityRefreshStartMs }),
    ),
    runtime.fetchOrderbookPrices(ticker).then(
      (orderbook) => ({ ok: true as const, orderbook, latencyMs: runtime.nowMs() - quoteRefreshStartMs }),
      (error) => ({ ok: false as const, orderbook: null, error, latencyMs: runtime.nowMs() - quoteRefreshStartMs }),
    ),
    priceGuardSampleRequested
      ? coin
        ? runtime.collectPriceSample(coin.symbol, coin.product)
        : Promise.resolve(false)
      : Promise.resolve(true),
    mode === "live"
      ? runtime.getBalance().then(
          (balance) => ({ ok: true as const, availableBalance: balance.availableBalance }),
          (error) => ({ ok: false as const, availableBalance: null, error }),
        )
      : Promise.resolve({ ok: true as const, availableBalance: null }),
  ]);
  const concurrentFetchMs = runtime.nowMs() - concurrentFetchStartMs;
  identityRefreshMs = identityResult.latencyMs;
  quoteRefreshMs = orderbookResult.latencyMs;
  parallelRefreshMs = concurrentFetchMs;
  if (latency) {
    latency.identityRefreshMs = identityRefreshMs;
    latency.quoteRefreshMs = quoteRefreshMs;
    latency.parallelRefreshMs = parallelRefreshMs;
  }

  // Re-resolve the authoritative ticker/closeTime and require an exact match
  // with the reserved candidate. Identity failure is terminal for this window.
  if (!identityResult.ok) {
    logger.warn(
      { err: identityResult.error, symbol },
      "[kalshi-scalper] identity force-refresh failed — skipping permanently",
    );
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "identity_refresh_failed", true, {
      ..._timingEvidence(),
      identityFetchOk: false,
      identityReason: "identity_refresh_failed",
    });
    _rememberReservationOutcome(attemptKey, "skipped", "identity_refresh_failed", priorSubmittedOrders, runtime.nowMs());
    return;
  }
  const refreshed = runtime.getKalshiCachedData(symbol);
  if (!refreshed?.ticker || !refreshed.closeTime) {
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "identity_missing_after_refresh", true, {
      ..._timingEvidence(),
      identityFetchOk: true,
      identityReason: "identity_missing_after_refresh",
    });
    return;
  }
  if (refreshed.ticker !== ticker || refreshed.closeTime !== closeTime) {
    logger.info(
      { symbol, reservedTicker: ticker, refreshedTicker: refreshed.ticker },
      "[kalshi-scalper] market identity changed after refresh — skipping permanently",
    );
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "identity_changed", true, {
      ..._timingEvidence(),
      identityFetchOk: true,
      identityReason: "identity_changed",
      refreshedTicker: refreshed.ticker,
      refreshedCloseTimeIso: refreshed.closeTime,
    });
    return;
  }

  // ── EARLY reject: DIFF freshest config/params against pinned snapshot ───────
  // This is an EARLY optimisation only — it lets us bail cheaply before the
  // second orderbook / freefall-sample / balance awaits. The AUTHORITATIVE
  // final validation runs synchronously AFTER all those awaits (and again after
  // live intent creation, immediately before placeOrder). ANY risk field change
  // (budget, caps, band, window, freefall, paused, enabled, mode) or identity
  // change → permanent skip + release BEFORE any intent.
  const params2 = resolveEffectiveParams(_config, symbol, ticker);
  const diff = compareRiskSnapshot(
    snapshot,
    _config,
    params2,
    { symbol, windowKey, ticker, closeTime: refreshed.closeTime },
  );
  if (!diff.unchanged) {
    logger.info(
      { symbol, windowKey, changed: diff.changedFields },
      "[kalshi-scalper] risk snapshot changed mid-flight (early) — skipping permanently (fail-closed, no resize)",
    );
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", diff.reason ?? "risk_changed", true, {
      ..._timingEvidence(),
      refreshedTicker: refreshed.ticker,
      refreshedCloseTimeIso: refreshed.closeTime,
    });
    return;
  }

  // Confirm the refreshed close time still falls in the current window (uses
  // the PINNED window seconds — already verified unchanged by the diff above).
  const postDiffNowMs = runtime.nowMs();
  const postDiffCloseMs = new Date(refreshed.closeTime).getTime();
  if (!isInFinalWindow(refreshed.closeTime, postDiffNowMs, snapshot.finalWindowSeconds, wkNow)) {
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "identity_outside_window", true, {
      ..._timingEvidence(),
      timingPhase: resolveTimingPhase(refreshed.closeTime, postDiffNowMs, snapshot.finalWindowSeconds, SCALP_PREFLIGHT_LEAD_SECONDS),
      closeTimeIso: refreshed.closeTime,
      secondsRemaining: (postDiffCloseMs - postDiffNowMs) / 1000,
      effectiveWindowSeconds: snapshot.finalWindowSeconds,
      identityFetchOk: true,
      identityReason: "identity_outside_window",
      refreshedTicker: refreshed.ticker,
      refreshedCloseTimeIso: refreshed.closeTime,
    });
    return;
  }

  // The one authoritative authenticated quote was fetched in parallel with
  // identity, balance, and the fresh Freefall sample.
  const quote2 = orderbookResult.ok && orderbookResult.orderbook
    ? validateOrderbookQuote(orderbookResult.orderbook, ticker, closeTime)
    : null;

  if (!quote2) {
    logger.warn(
      {
        symbol,
        ticker,
        err: orderbookResult.ok ? undefined : orderbookResult.error,
      },
      "[kalshi-scalper] final orderbook quote invalid — re-arming",
    );
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "final_quote_invalid", true, {
      ..._timingEvidence(),
      quoteFetchOk: orderbookResult.ok,
      quotedReason: "final_quote_invalid",
      quoteYesAsk: orderbookResult.ok ? orderbookResult.orderbook?.yesAsk ?? null : null,
      quoteNoAsk: orderbookResult.ok && orderbookResult.orderbook?.yesBid != null
        ? 1 - orderbookResult.orderbook.yesBid
        : null,
      bandMin: snapshot.bandMin,
      bandMax: snapshot.bandMax,
    });
    runtime.recordFunnelEvent?.(mode, windowKey, symbol, "final_quote_loss");
    _rememberReservationOutcome(attemptKey, "skipped", "final_quote_invalid", priorSubmittedOrders, runtime.nowMs());
    return;
  }

  // Revalidate window with second quote (pinned window seconds).
  const quoteWindowNowMs = runtime.nowMs();
  const quoteCloseMs = new Date(quote2.closeTime).getTime();
  if (!isInFinalWindow(quote2.closeTime, quoteWindowNowMs, snapshot.finalWindowSeconds, wkNow)) {
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "outside_window_second_quote", true, {
      ..._timingEvidence(),
      timingPhase: resolveTimingPhase(quote2.closeTime, quoteWindowNowMs, snapshot.finalWindowSeconds, SCALP_PREFLIGHT_LEAD_SECONDS),
      closeTimeIso: quote2.closeTime,
      secondsRemaining: (quoteCloseMs - quoteWindowNowMs) / 1000,
      effectiveWindowSeconds: snapshot.finalWindowSeconds,
      quoteFetchOk: true,
      quotedReason: "outside_window_second_quote",
      quoteYesAsk: quote2.yesAsk,
      quoteNoAsk: quote2.noAsk,
      bandMin: snapshot.bandMin,
      bandMax: snapshot.bandMax,
    });
    return;
  }

  // Band selection uses the PINNED snapshot band (verified unchanged above).
  const match2 = selectScalpSide(quote2.yesAsk, quote2.noAsk, snapshot.bandMin, snapshot.bandMax);
  if (!match2) {
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "final_quote_outside_band", true, {
      ..._timingEvidence(),
      quoteFetchOk: true,
      quotedReason: "final_quote_outside_band",
      quoteYesAsk: quote2.yesAsk,
      quoteNoAsk: quote2.noAsk,
      bandMin: snapshot.bandMin,
      bandMax: snapshot.bandMax,
    });
    runtime.recordFunnelEvent?.(mode, windowKey, symbol, "final_quote_loss");
    _rememberReservationOutcome(attemptKey, "skipped", "final_quote_outside_band", priorSubmittedOrders, runtime.nowMs());
    return;
  }

  // Side must remain consistent with initial candidate
  if (match2.side !== initialSide) {
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "side_flipped_final_quote", true, {
      ..._timingEvidence(),
      quoteFetchOk: true,
      quotedReason: "side_flipped_final_quote",
      quoteYesAsk: quote2.yesAsk,
      quoteNoAsk: quote2.noAsk,
      winningAsk: match2.winningAsk,
      selectedSide: match2.side,
      bandMin: snapshot.bandMin,
      bandMax: snapshot.bandMax,
    });
    runtime.recordFunnelEvent?.(mode, windowKey, symbol, "final_quote_loss");
    _rememberReservationOutcome(attemptKey, "skipped", "side_flipped_final_quote", priorSubmittedOrders, runtime.nowMs());
    return;
  }
  runtime.recordFunnelEvent?.(mode, windowKey, symbol, "authenticated_eligible");

  let effectiveSide = match2.side;
  let winningAsk = match2.winningAsk;
  const targetPriceNum = Number(identityResult.target);
  let authoritativeFreshSampleSucceeded = freshSampleResult;
  let finalPriceSamples = _priceSamples.get(symbol) ?? [];
  let latestFinalPriceSample =
    priceGuardSampleRequested && freshSampleResult
      ? finalPriceSamples[finalPriceSamples.length - 1] ?? null
      : null;
  let finalProximityResult = latestFinalPriceSample == null
    ? null
    : checkTargetProximityGuard(
        latestFinalPriceSample.price,
        targetPriceNum,
        snapshot.targetProximityThresholdPct,
      );
  const evaluatePinnedProximityAt = (nowMs: number): {
    allowed: boolean;
    reason: string | null;
    result: ReturnType<typeof checkTargetProximityGuard> | null;
    latestSample: FreefallSample | null;
  } => {
    if (!snapshot.targetProximityGuardEnabled) {
      return { allowed: true, reason: null, result: null, latestSample: null };
    }
    if (!coin) {
      return {
        allowed: false,
        reason: "target_proximity_unavailable_no_product",
        result: null,
        latestSample: null,
      };
    }
    const samples = _priceSamples.get(symbol) ?? [];
    const latestSample = samples[samples.length - 1] ?? null;
    if (
      latestSample == null
      || !Number.isFinite(latestSample.price)
      || latestSample.price <= 0
      || !Number.isFinite(latestSample.at)
      || latestSample.at > nowMs
      || nowMs - latestSample.at > FREEFALL_MAX_SAMPLE_AGE_MS
    ) {
      return {
        allowed: false,
        reason: "target_proximity_unavailable_stale",
        result: null,
        latestSample,
      };
    }
    const result = checkTargetProximityGuard(
      latestSample.price,
      targetPriceNum,
      snapshot.targetProximityThresholdPct,
    );
    return {
      allowed: result.evaluable && !result.blocked,
      reason: result.evaluable && !result.blocked
        ? null
        : result.reason ?? "target_proximity_blocked_final",
      result,
      latestSample,
    };
  };
  let regularLayerCompatibility = runtime.regularPositionCompatibilitySync(
    mode,
    symbol,
    windowKey,
    ticker,
    effectiveSide,
  );
  if (regularLayerCompatibility.status === "opposite_side") {
    await runtime.updateReservationStatus(
      mode,
      symbol,
      windowKey,
      "skipped",
      "opposite_regular_position",
      true,
      {
        ..._timingEvidence(),
        selectedSide: effectiveSide,
        regularPositionId: regularLayerCompatibility.position.id,
        regularPositionSide: regularLayerCompatibility.position.direction,
        layerDecision: "opposite_side_block",
      },
    );
    return;
  }

  // ── FINAL TARGET PROXIMITY GUARD — authoritative and side-independent ─────
  // The target came from the force-refresh above and the live underlying sample
  // was fetched concurrently. If either input is unavailable, the enabled guard
  // cannot prove the entry safe and fails closed.
  if (snapshot.targetProximityGuardEnabled) {
    if (!coin) {
      await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "target_proximity_unavailable_no_product", true, {
        ..._timingEvidence(),
        minimumPct: snapshot.targetProximityThresholdPct,
        targetPrice: Number.isFinite(targetPriceNum) ? targetPriceNum : null,
      });
      _rememberReservationOutcome(attemptKey, "skipped", "target_proximity_unavailable_no_product", priorSubmittedOrders, runtime.nowMs());
      return;
    }
    if (!freshSampleResult) {
      logger.info(
        { symbol, side: effectiveSide },
        "[kalshi-scalper] target proximity sample fetch failed — unavailable, skipping (fail-closed)",
      );
      await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "target_proximity_unavailable_fetch_failed", true, {
        ..._timingEvidence(),
        minimumPct: snapshot.targetProximityThresholdPct,
        targetPrice: Number.isFinite(targetPriceNum) ? targetPriceNum : null,
      });
      _rememberReservationOutcome(attemptKey, "skipped", "target_proximity_unavailable_fetch_failed", priorSubmittedOrders, runtime.nowMs());
      return;
    }
    const proximityFinal = finalProximityResult ?? checkTargetProximityGuard(
      null,
      targetPriceNum,
      snapshot.targetProximityThresholdPct,
    );
    if (!proximityFinal.evaluable || proximityFinal.blocked) {
      logger.info(
        {
          symbol,
          side: effectiveSide,
          evaluable: proximityFinal.evaluable,
          reason: proximityFinal.reason,
          distancePct: proximityFinal.distancePct,
          thresholdPct: snapshot.targetProximityThresholdPct,
        },
        "[kalshi-scalper] target proximity guard skip (final boundary)",
      );
      const proximityReason = proximityFinal.reason ?? "target_proximity_blocked_final";
      await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", proximityReason, true, {
        ..._timingEvidence(),
        distancePct: proximityFinal.distancePct,
        minimumPct: snapshot.targetProximityThresholdPct,
        targetPrice: Number.isFinite(targetPriceNum) ? targetPriceNum : null,
        underlyingPrice: latestFinalPriceSample?.price ?? null,
        selectedSide: effectiveSide,
      });
      _rememberReservationOutcome(attemptKey, "skipped", proximityReason, priorSubmittedOrders, runtime.nowMs());
      return;
    }
  }

  // ── FINAL FREEFALL GUARD — authoritative, at the exact pre-submit boundary ─
  // Fail closed: an AUTHORITATIVE fresh sample is REQUIRED. A failed fresh fetch
  // is "unavailable" and skips — existing old samples must NOT mask it. Then the
  // guard must be evaluable AND not blocked to proceed.
  let finalFreefallResult: ReturnType<typeof checkFreefallGuard> | null = null;
  let guardEvaluatedAtMs = runtime.nowMs();
  const evaluatePinnedFreefallAt = (nowMs: number) => evaluateFreefallPreSubmitGuard({
    directionEnabled: snapshot.freefallGuardEnabled,
    hasProduct: coin != null,
    freshSampleSucceeded: authoritativeFreshSampleSucceeded,
    samples: _priceSamples.get(symbol) ?? finalPriceSamples,
    side: effectiveSide,
    nowMs,
    eligibilityStartMs:
      Date.parse(snapshot.closeTime) - snapshot.finalWindowSeconds * 1_000,
    consecutiveSeconds: snapshot.freefallConsecutiveSeconds,
    favorableTrendConfirmationEnabled:
      snapshot.favorableTrendConfirmationEnabled,
    coordinatedDirectionClearanceEnabled:
      snapshot.coordinatedDirectionClearanceEnabled,
    targetPrice: targetPriceNum,
    targetProximityGuardEnabled: snapshot.targetProximityGuardEnabled,
    targetProximityThresholdPct: snapshot.targetProximityThresholdPct,
    secondsRemaining: Math.max(
      0,
      (Date.parse(snapshot.closeTime) - nowMs) / 1_000,
    ),
    rapidMoveEnabled: snapshot.rapidMoveGuardEnabled,
    rapidMoveLookbackSeconds: snapshot.rapidMoveLookbackSeconds,
    rapidMoveThresholdPct: snapshot.rapidMoveThresholdPct,
  });
  if (snapshot.freefallGuardEnabled || snapshot.rapidMoveGuardEnabled) {
    const ffNowMs = runtime.nowMs();
    guardEvaluatedAtMs = ffNowMs;
    const freefallDecision = evaluatePinnedFreefallAt(ffNowMs);
    finalFreefallResult = freefallDecision.guardResult;
    if (!freefallDecision.allowed) {
      const ffFinal = freefallDecision.guardResult;
      logger.info(
        {
          symbol,
          side: effectiveSide,
          evaluable: ffFinal?.evaluable ?? false,
          reason: freefallDecision.reason,
          adverseMovePct: ffFinal?.adverseMovePct ?? null,
          consecutiveWrongWayMoves: ffFinal?.consecutiveWrongWayMoves ?? null,
          consecutiveWrongWaySeconds: ffFinal?.consecutiveWrongWaySeconds ?? null,
          favorableTrendConfirmed: ffFinal?.favorableTrendConfirmed ?? null,
          favorableTrendReason: ffFinal?.favorableTrendReason ?? null,
          coordinatedDirectionClearanceEnabled:
            snapshot.coordinatedDirectionClearanceEnabled,
          coordinatedDirectionClearanceApplied:
            ffFinal?.coordinatedDirectionClearanceApplied ?? false,
          coordinatedDirectionClearanceSafe:
            ffFinal?.coordinatedDirectionClearanceSafe ?? null,
          coordinatedDirectionClearanceReason:
            ffFinal?.coordinatedDirectionClearanceReason ?? null,
          adversePacePctPerSecond:
            ffFinal?.adversePacePctPerSecond ?? null,
          projectedAdverseMovePct:
            ffFinal?.projectedAdverseMovePct ?? null,
          projectedDistancePct:
            ffFinal?.projectedDistancePct ?? null,
          projectedPrice: ffFinal?.projectedPrice ?? null,
          targetSideWindowConfirmed:
            ffFinal?.targetSideWindowConfirmed ?? null,
          targetSideViolationPrice:
            ffFinal?.targetSideViolationPrice ?? null,
          targetSideViolationAt:
            ffFinal?.targetSideViolationAt != null
              ? new Date(ffFinal.targetSideViolationAt).toISOString()
              : null,
          requiredConsecutiveMoves: ffFinal?.requiredConsecutiveMoves ?? null,
          rapidMoveBlocked: ffFinal?.rapidMoveBlocked ?? false,
          rapidMovePct: ffFinal?.rapidMovePct ?? null,
          samplesUsed: ffFinal?.samplesUsed ?? null,
        },
        "[kalshi-scalper] freefall guard skip (final boundary)",
      );
      const freefallReason = freefallDecision.reason ?? "freefall_blocked_final";
      const guardOutcomeStudy = _buildGuardOutcomeStudy(
        freefallDecision,
        effectiveSide,
        quote2.yesAsk,
        quote2.noAsk,
        ffNowMs,
        "initial_final_guard",
      );
      await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", freefallReason, true, {
        ..._timingEvidence(),
        adverseMovePct: ffFinal?.adverseMovePct ?? null,
        freefallConsecutiveSeconds: snapshot.freefallConsecutiveSeconds,
        consecutiveWrongWayMoves: ffFinal?.consecutiveWrongWayMoves ?? null,
        consecutiveWrongWaySeconds: ffFinal?.consecutiveWrongWaySeconds ?? null,
        directionalMovePct: ffFinal?.directionalMovePct ?? null,
        wrongWayResetCount: ffFinal?.wrongWayResetCount ?? null,
        lastWrongWayResetAt:
          ffFinal?.lastWrongWayResetAt != null
            ? new Date(ffFinal.lastWrongWayResetAt).toISOString()
            : null,
        favorableTrendConfirmationEnabled:
          snapshot.freefallGuardEnabled
          && snapshot.favorableTrendConfirmationEnabled,
        favorableTrendConfirmed: ffFinal?.favorableTrendConfirmed ?? null,
        favorableTrendReason: ffFinal?.favorableTrendReason ?? null,
        coordinatedDirectionClearanceEnabled:
          snapshot.coordinatedDirectionClearanceEnabled,
        coordinatedDirectionClearanceApplied:
          ffFinal?.coordinatedDirectionClearanceApplied ?? false,
        coordinatedDirectionClearanceSafe:
          ffFinal?.coordinatedDirectionClearanceSafe ?? null,
        coordinatedDirectionClearanceReason:
          ffFinal?.coordinatedDirectionClearanceReason ?? null,
        adversePacePctPerSecond:
          ffFinal?.adversePacePctPerSecond ?? null,
        projectedAdverseMovePct:
          ffFinal?.projectedAdverseMovePct ?? null,
        projectedDistancePct:
          ffFinal?.projectedDistancePct ?? null,
        projectedPrice: ffFinal?.projectedPrice ?? null,
        secondsRemaining: ffFinal?.secondsRemaining ?? null,
        targetSideWindowConfirmed:
          ffFinal?.targetSideWindowConfirmed ?? null,
        targetSideViolationPrice:
          ffFinal?.targetSideViolationPrice ?? null,
        targetSideViolationAt:
          ffFinal?.targetSideViolationAt != null
            ? new Date(ffFinal.targetSideViolationAt).toISOString()
            : null,
        rapidMoveBlocked: ffFinal?.rapidMoveBlocked ?? false,
        rapidMovePct: ffFinal?.rapidMovePct ?? null,
        rapidMoveThresholdPct: snapshot.rapidMoveThresholdPct,
        rapidMoveLookbackSeconds: snapshot.rapidMoveLookbackSeconds,
        distancePct: finalProximityResult?.distancePct ?? null,
        minimumPct: snapshot.targetProximityGuardEnabled
          ? snapshot.targetProximityThresholdPct
          : null,
        targetPrice: Number.isFinite(targetPriceNum) ? targetPriceNum : null,
        underlyingPrice: ffFinal?.latestPrice ?? null,
        samplesUsed: ffFinal?.samplesUsed ?? null,
        sampleCoverageMs: freefallDecision.sampleCoverageMs,
        protectedSide: effectiveSide,
        guardOutcomeStudy,
      });
      _rememberReservationOutcome(attemptKey, "skipped", freefallReason, priorSubmittedOrders, runtime.nowMs());
      // The normal reservation is now durably released. This is deliberately
      // isolated: lifecycle replay, not this execution path, consumes the
      // immutable outbox payload persisted in skip evidence.
      void triggerContrarianFromNormalGuard({
        sourceMode: mode,
        symbol,
        windowKey,
        ticker,
        closeTime,
        protectedSide: effectiveSide,
        decision: freefallDecision,
        refreshAndRevalidate: async () => {
          const refreshStartedAt = runtime.nowMs();
          const [identity, orderbook, freshSampleSucceeded] = await Promise.all([
            runtime.fetchKalshiTarget(symbol, new Date(closeTime), true).then(
              (target) => ({ ok: true as const, target }),
              (error) => ({ ok: false as const, target: null, error }),
            ),
            runtime.fetchOrderbookPrices(ticker).then(
              (value) => ({ ok: true as const, value }),
              (error) => ({ ok: false as const, value: null, error }),
            ),
            coin
              ? runtime.collectPriceSample(coin.symbol, coin.product)
              : Promise.resolve(false),
          ]);
          const cached = runtime.getKalshiCachedData(symbol);
          const baseEvidence = {
            refreshMs: runtime.nowMs() - refreshStartedAt,
            identityFetchOk: identity.ok,
            orderbookFetchOk: orderbook.ok,
            freshSampleSucceeded,
            refreshedTicker: cached?.ticker ?? null,
            refreshedCloseTime: cached?.closeTime ?? null,
            refreshedTarget: identity.target,
          };
          if (!identity.ok || identity.target == null) {
            return {
              ok: false,
              reason: "fresh_identity_unavailable",
              decision: null,
              yesAsk: null,
              noAsk: null,
              targetPrice: null,
              closeTime: cached?.closeTime ?? null,
              evidence: baseEvidence,
            };
          }
          if (
            !cached?.ticker
            || !cached.closeTime
            || cached.ticker !== ticker
            || cached.closeTime !== closeTime
            || Math.abs(identity.target - targetPriceNum) > 1e-9
          ) {
            return {
              ok: false,
              reason: "fresh_identity_changed",
              decision: null,
              yesAsk: null,
              noAsk: null,
              targetPrice: identity.target,
              closeTime: cached?.closeTime ?? null,
              evidence: baseEvidence,
            };
          }
          if (!freshSampleSucceeded) {
            return {
              ok: false,
              reason: "fresh_underlying_sample_unavailable",
              decision: null,
              yesAsk: null,
              noAsk: null,
              targetPrice: identity.target,
              closeTime: cached.closeTime,
              evidence: baseEvidence,
            };
          }
          const quote = orderbook.ok && orderbook.value
            ? validateOrderbookQuote(orderbook.value, ticker, closeTime)
            : null;
          if (!quote) {
            return {
              ok: false,
              reason: "fresh_authenticated_quote_invalid",
              decision: null,
              yesAsk: null,
              noAsk: null,
              targetPrice: identity.target,
              closeTime: cached.closeTime,
              evidence: baseEvidence,
            };
          }
          const decision = evaluatePinnedFreefallAt(runtime.nowMs());
          return {
            ok: true,
            reason: null,
            decision,
            yesAsk: quote.yesAsk,
            noAsk: quote.noAsk,
            targetPrice: identity.target,
            closeTime: cached.closeTime,
            evidence: {
              ...baseEvidence,
              guardReason: decision.reason,
            },
          };
        },
        finalValidationSync: () => {
          const currentKey = runtime.currentWindowKey();
          if (!currentKey || currentKey !== windowKey) {
            return "window_expired_before_submit";
          }
          const cached = runtime.getKalshiCachedData(symbol);
          if (
            !cached?.ticker
            || !cached.closeTime
            || cached.ticker !== ticker
            || cached.closeTime !== closeTime
            || cached.value == null
            || Math.abs(cached.value - targetPriceNum) > 1e-9
          ) {
            return "identity_changed_before_submit";
          }
          if (
            !isInFinalWindow(
              cached.closeTime,
              runtime.nowMs(),
              snapshot.finalWindowSeconds,
              windowKey,
            )
          ) {
            return "outside_window_before_submit";
          }
          const finalDecision = evaluatePinnedFreefallAt(runtime.nowMs());
          const finalEligibility = evaluateContrarianGuardEligibility(
            finalDecision,
            effectiveSide,
          );
          return finalEligibility.eligible
            ? null
            : `final_guard_${finalEligibility.reason}`;
        },
      }).catch((err) => logger.warn({ err, symbol }, "[kalshi-scalper] contrarian experiment evaluation failed"));
      return;
    }
  }
  // ── Size the order STRICTLY within the durable reserved budget ─────────────
  // Contract count = floor(reservedBudget / maxWinningCost); worst-case
  // exposure at the band-capped IOC limit is guaranteed <= reservedBudget.
  const sized = sizeOrderWithinReservedBudget(reservedBudget, winningAsk, snapshot.bandMax);
  if (!sized.ok) {
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", sized.reason ?? "sizing_failed", true, {
      ..._timingEvidence(),
    });
    return;
  }
  const { contractCount, maxWinningCost, maxExposure } = sized;

  // ── FINAL live balance check against ACTUAL worst-case submit exposure ─────
  if (mode === "live") {
    if (!balanceResult.ok || balanceResult.availableBalance == null) {
      logger.warn(
        { err: balanceResult.ok ? undefined : balanceResult.error, symbol },
        "[kalshi-scalper] final balance check failed — re-arming",
      );
      await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "balance_check_failed_final", true, {
        ..._timingEvidence(),
        availableBalance: balanceResult.availableBalance,
        maxExposure,
      });
      _rememberReservationOutcome(attemptKey, "skipped", "balance_check_failed_final", priorSubmittedOrders, runtime.nowMs());
      return;
    }
    if (balanceResult.availableBalance < maxExposure) {
      logger.warn(
        { symbol, available: balanceResult.availableBalance, maxExposure, contractCount, maxWinningCost },
        "[kalshi-scalper] insufficient balance for worst-case exposure (final) — re-arming",
      );
      await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", "insufficient_balance_final", true, {
        ..._timingEvidence(),
        availableBalance: balanceResult.availableBalance,
        maxExposure,
      });
      _rememberReservationOutcome(attemptKey, "skipped", "insufficient_balance_final", priorSubmittedOrders, runtime.nowMs());
      return;
    }
  }

  // The first authenticated quote overlaps identity, balance, and fresh guard
  // inputs. Once every other await is complete, requalify in the existing
  // bounded candidate lane immediately before the intent boundary. Only a
  // transient invalid/one-sided result may retry, at most twice, and only while
  // enough close-time budget remains. Valid out-of-band and side-flipped quotes
  // are real price decisions and remain terminal for this attempt.
  const finalRequoteStartedAtMs = runtime.nowMs();
  const quoteAttempts: NonNullable<ScalpSkipEvidence["quoteAttempts"]> = [];
  let quoteRetryCount = 0;
  let finalRequoteResult:
    | { ok: true; orderbook: Awaited<ReturnType<typeof fetchOrderbookPrices>> }
    | { ok: false; error: unknown; orderbook: null };
  let finalRequoteFreshSampleSucceeded = authoritativeFreshSampleSucceeded;
  let finalRequalification: ReturnType<typeof requalifyAuthenticatedScalpQuote>;
  let terminalQuoteReason:
    | "final_requote_invalid"
    | "final_requote_outside_band"
    | "side_flipped_final_requote"
    | "final_quote_above_cap"
    | "final_quote_below_floor"
    | "deadline_before_quote_retry"
    | "window_expired_before_quote_retry" = "final_requote_invalid";

  while (true) {
    const refreshUnderlyingForRetry =
      quoteRetryCount > 0
      && priceGuardSampleRequested
      && coin != null;
    const [quoteResult, retrySampleResult] = await Promise.all([
      runtime.fetchOrderbookPrices(ticker).then(
        (orderbook) => ({ ok: true as const, orderbook }),
        (error) => ({ ok: false as const, error, orderbook: null }),
      ),
      refreshUnderlyingForRetry && coin
        ? runtime.collectPriceSample(coin.symbol, coin.product)
        : Promise.resolve(authoritativeFreshSampleSucceeded),
    ]);
    finalRequoteResult = quoteResult;
    if (refreshUnderlyingForRetry) {
      finalRequoteFreshSampleSucceeded = retrySampleResult;
      authoritativeFreshSampleSucceeded = retrySampleResult;
      finalPriceSamples = _priceSamples.get(symbol) ?? finalPriceSamples;
      latestFinalPriceSample = retrySampleResult
        ? finalPriceSamples[finalPriceSamples.length - 1] ?? null
        : null;
      finalProximityResult = latestFinalPriceSample == null
        ? null
        : checkTargetProximityGuard(
            latestFinalPriceSample.price,
            targetPriceNum,
            snapshot.targetProximityThresholdPct,
          );
    }
    finalRequalification = finalRequoteResult.ok && finalRequoteResult.orderbook
      ? requalifyAuthenticatedScalpQuote({
          orderbook: finalRequoteResult.orderbook,
          ticker,
          closeTime,
          bandMin: snapshot.bandMin,
          bandMax: snapshot.bandMax,
          initialSide,
        })
      : {
          ok: false as const,
          reason: "final_requote_invalid" as const,
          quote: null,
          selectedSide: null,
          winningAsk: null,
        };
    const rawYesAsk = finalRequoteResult.ok
      ? finalRequoteResult.orderbook?.yesAsk ?? null
      : null;
    const rawNoAsk = finalRequoteResult.ok && finalRequoteResult.orderbook?.yesBid != null
      ? 1 - finalRequoteResult.orderbook.yesBid
      : null;
    quoteAttempts.push({
      attempt: quoteAttempts.length + 1,
      fetchedAt: new Date(runtime.nowMs()).toISOString(),
      fetchOk: finalRequoteResult.ok,
      yesAsk: finalRequalification.quote?.yesAsk ?? rawYesAsk,
      noAsk: finalRequalification.quote?.noAsk ?? rawNoAsk,
      reason: finalRequalification.ok ? null : finalRequalification.reason,
    });
    if (finalRequalification.ok) {
      break;
    }

    const secondsRemaining = (Date.parse(closeTime) - runtime.nowMs()) / 1_000;
    const retryDecision = decideAuthenticatedQuoteRetry({
      quoteReason: finalRequalification.reason,
      retryCount: quoteRetryCount,
      secondsRemaining,
      sameWindow: runtime.currentWindowKey() === windowKey,
    });
    if (!retryDecision.retry) {
      if (
        retryDecision.reason === "deadline_before_quote_retry"
        || retryDecision.reason === "window_expired_before_quote_retry"
      ) {
        terminalQuoteReason = retryDecision.reason;
      } else if (
        finalRequalification.reason === "final_requote_outside_band"
        && finalRequalification.quote
      ) {
        const directAsk = initialSide === "yes"
          ? finalRequalification.quote.yesAsk
          : finalRequalification.quote.noAsk;
        terminalQuoteReason = directAsk > snapshot.bandMax
          ? "final_quote_above_cap"
          : directAsk < snapshot.bandMin
            ? "final_quote_below_floor"
            : finalRequalification.reason;
      } else {
        terminalQuoteReason = finalRequalification.reason;
      }
      break;
    }
    quoteRetryCount += 1;
  }
  const finalRequoteMs = runtime.nowMs() - finalRequoteStartedAtMs;
  if (latency) latency.finalRequoteMs = finalRequoteMs;
  if (!finalRequalification.ok) {
    const lastQuoteAttempt = quoteAttempts[quoteAttempts.length - 1] ?? null;
    await runtime.updateReservationStatus(
      mode,
      symbol,
      windowKey,
      "skipped",
      terminalQuoteReason,
      true,
      {
        ..._timingEvidence(),
        quoteFetchOk: finalRequoteResult.ok,
        quotedReason: terminalQuoteReason,
        quoteYesAsk: lastQuoteAttempt?.yesAsk ?? null,
        quoteNoAsk: lastQuoteAttempt?.noAsk ?? null,
        winningAsk: finalRequalification.winningAsk,
        selectedSide: finalRequalification.selectedSide,
        bandMin: snapshot.bandMin,
        bandMax: snapshot.bandMax,
        quoteRefreshMs: finalRequoteMs,
        quoteAttempts,
        quoteRetryCount,
      },
    );
    runtime.recordFunnelEvent?.(mode, windowKey, symbol, "final_quote_loss");
    _rememberReservationOutcome(
      attemptKey,
      "skipped",
      terminalQuoteReason,
      priorSubmittedOrders,
      runtime.nowMs(),
    );
    return;
  }
  effectiveSide = finalRequalification.side;
  winningAsk = finalRequalification.winningAsk;
  const acceptedFinalQuoteEvidence = {
    quoteYesAsk: finalRequalification.quote.yesAsk,
    quoteNoAsk: finalRequalification.quote.noAsk,
    winningAsk,
    selectedSide: effectiveSide,
    bandMin: snapshot.bandMin,
    bandMax: snapshot.bandMax,
    quoteAttempts,
    quoteRetryCount,
  } satisfies ScalpSkipEvidence;

  // A successful retry has added awaited time after the original guard sample.
  // Pair each retry with the reserved authoritative underlying lane, then rerun
  // both target proximity and Freefall before any intent can be written.
  if (quoteRetryCount > 0 && priceGuardSampleRequested) {
    if (!finalRequoteFreshSampleSucceeded) {
      const reason = "stale_underlying_after_quote_retry";
      await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", reason, true, {
        ..._timingEvidence(),
        ...acceptedFinalQuoteEvidence,
        quotedReason: reason,
        targetPrice: Number.isFinite(targetPriceNum) ? targetPriceNum : null,
      });
      _rememberReservationOutcome(attemptKey, "skipped", reason, priorSubmittedOrders, runtime.nowMs());
      return;
    }

    const postRetryProximity = evaluatePinnedProximityAt(runtime.nowMs());
    if (!postRetryProximity.allowed) {
      const reason = postRetryProximity.reason ?? "target_proximity_blocked_after_quote_retry";
      await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", reason, true, {
        ..._timingEvidence(),
        ...acceptedFinalQuoteEvidence,
        quotedReason: reason,
        distancePct: postRetryProximity.result?.distancePct ?? null,
        minimumPct: snapshot.targetProximityThresholdPct,
        targetPrice: Number.isFinite(targetPriceNum) ? targetPriceNum : null,
        underlyingPrice: postRetryProximity.latestSample?.price ?? null,
      });
      _rememberReservationOutcome(attemptKey, "skipped", reason, priorSubmittedOrders, runtime.nowMs());
      return;
    }

    if (snapshot.freefallGuardEnabled || snapshot.rapidMoveGuardEnabled) {
      const postRetryFreefallAtMs = runtime.nowMs();
      const postRetryFreefall = evaluatePinnedFreefallAt(postRetryFreefallAtMs);
      finalFreefallResult = postRetryFreefall.guardResult;
      guardEvaluatedAtMs = postRetryFreefallAtMs;
      if (!postRetryFreefall.allowed) {
        const reason = postRetryFreefall.reason ?? "freefall_blocked_after_quote_retry";
        await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", reason, true, {
          ..._timingEvidence(),
          ...acceptedFinalQuoteEvidence,
          quotedReason: reason,
          adverseMovePct: postRetryFreefall.guardResult?.adverseMovePct ?? null,
          targetPrice: Number.isFinite(targetPriceNum) ? targetPriceNum : null,
          underlyingPrice: postRetryFreefall.guardResult?.latestPrice ?? null,
          samplesUsed: postRetryFreefall.guardResult?.samplesUsed ?? null,
          sampleCoverageMs: postRetryFreefall.sampleCoverageMs,
        });
        _rememberReservationOutcome(attemptKey, "skipped", reason, priorSubmittedOrders, runtime.nowMs());
        return;
      }
    }
  }

  // ── AUTHORITATIVE FINAL VALIDATION (post-await) ───────────────────────────
  // Every awaited pre-submit step (authenticated quote requalification,
  // Freefall sample, sizing, and final balance) is now complete. Re-run the
  // SYNCHRONOUS authoritative check
  // AFTER all that async work so a config/window/identity change during those
  // awaits fails closed here — before any intent is written or fill simulated.
  const finalReason1 = runtime.finalRiskValidationSync(snapshot, windowKey, symbol, ticker);
  if (finalReason1 !== null) {
    logger.info(
      { symbol, windowKey, reason: finalReason1 },
      "[kalshi-scalper] authoritative final validation failed (post-await) — skipping permanently",
    );
    await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", finalReason1, true, {
      ..._timingEvidence(),
      ...acceptedFinalQuoteEvidence,
      elapsedMs: runtime.nowMs() - attemptStartMs,
    });
    return;
  }
  regularLayerCompatibility = runtime.regularPositionCompatibilitySync(
    mode,
    symbol,
    windowKey,
    ticker,
    effectiveSide,
  );
  if (regularLayerCompatibility.status === "opposite_side") {
    await runtime.updateReservationStatus(
      mode,
      symbol,
      windowKey,
      "skipped",
      "opposite_regular_position",
      true,
      {
        ..._timingEvidence(),
        ...acceptedFinalQuoteEvidence,
        selectedSide: effectiveSide,
        regularPositionId: regularLayerCompatibility.position.id,
        regularPositionSide: regularLayerCompatibility.position.direction,
        layerDecision: "opposite_side_block",
        elapsedMs: runtime.nowMs() - attemptStartMs,
      },
    );
    return;
  }

  // Use the pinned band ceiling as a marketable IOC boundary, not the transient
  // quote. Kalshi may price-improve inside this hard maximum winning cost.
  const limitPrice = computeLimitPrice(effectiveSide, snapshot.bandMax);
  // Preserve the authoritative observed quote separately for diagnostics.
  const entryYesPrice = effectiveSide === "yes" ? winningAsk : 1 - winningAsk;
  const evidenceSamples = finalFreefallResult?.evaluatedSamples.length
    ? finalFreefallResult.evaluatedSamples
    : latestFinalPriceSample != null
      ? [latestFinalPriceSample]
      : [];
  const evidenceCoverageMs = evidenceSamples.length === 0
    ? null
    : evidenceSamples[evidenceSamples.length - 1].at - evidenceSamples[0].at;
  const entryGuardEvidence: ScalpEntryGuardEvidence = {
    schemaVersion: 1,
    phase: "final_pre_submit",
    evaluatedAt: new Date(guardEvaluatedAtMs).toISOString(),
    side: effectiveSide,
    directionGuardEnabled: snapshot.freefallGuardEnabled,
    favorableTrendConfirmationEnabled:
      snapshot.freefallGuardEnabled
      && snapshot.favorableTrendConfirmationEnabled,
    coordinatedDirectionClearanceEnabled:
      snapshot.freefallGuardEnabled
      && snapshot.favorableTrendConfirmationEnabled
      && snapshot.coordinatedDirectionClearanceEnabled,
    rapidMoveGuardEnabled: snapshot.rapidMoveGuardEnabled,
    targetProximityGuardEnabled: snapshot.targetProximityGuardEnabled,
    samples: evidenceSamples.map((sample) => ({
      at: new Date(sample.at).toISOString(),
      price: sample.price,
    })),
    sampleCoverageMs: evidenceCoverageMs,
    samplesUsed: evidenceSamples.length === 0 ? null : evidenceSamples.length,
    wrongWayResetCount: snapshot.freefallGuardEnabled
      ? finalFreefallResult?.wrongWayResetCount ?? null
      : null,
    lastWrongWayResetAt:
      snapshot.freefallGuardEnabled
      && finalFreefallResult?.lastWrongWayResetAt != null
        ? new Date(finalFreefallResult.lastWrongWayResetAt).toISOString()
        : null,
    consecutiveWrongWayMoves: snapshot.freefallGuardEnabled
      ? finalFreefallResult?.consecutiveWrongWayMoves ?? null
      : null,
    consecutiveWrongWaySeconds: snapshot.freefallGuardEnabled
      ? finalFreefallResult?.consecutiveWrongWaySeconds ?? null
      : null,
    directionalMovePct: snapshot.freefallGuardEnabled
      ? finalFreefallResult?.directionalMovePct ?? null
      : null,
    favorableTrendConfirmed:
      snapshot.freefallGuardEnabled
      && snapshot.favorableTrendConfirmationEnabled
        ? finalFreefallResult?.favorableTrendConfirmed ?? null
        : null,
    favorableTrendReason:
      snapshot.freefallGuardEnabled
      && snapshot.favorableTrendConfirmationEnabled
        ? finalFreefallResult?.favorableTrendReason ?? null
        : null,
    coordinatedDirectionClearanceApplied:
      finalFreefallResult?.coordinatedDirectionClearanceApplied ?? false,
    coordinatedDirectionClearanceSafe:
      finalFreefallResult?.coordinatedDirectionClearanceSafe ?? null,
    coordinatedDirectionClearanceReason:
      finalFreefallResult?.coordinatedDirectionClearanceReason ?? null,
    adversePacePctPerSecond:
      finalFreefallResult?.adversePacePctPerSecond ?? null,
    projectedAdverseMovePct:
      finalFreefallResult?.projectedAdverseMovePct ?? null,
    projectedDistancePct:
      finalFreefallResult?.projectedDistancePct ?? null,
    projectedPrice: finalFreefallResult?.projectedPrice ?? null,
    secondsRemaining: finalFreefallResult?.secondsRemaining ?? null,
    targetSideWindowConfirmed:
      snapshot.freefallGuardEnabled
      && snapshot.favorableTrendConfirmationEnabled
        ? finalFreefallResult?.targetSideWindowConfirmed ?? null
        : null,
    targetSideViolationPrice:
      snapshot.freefallGuardEnabled
      && snapshot.favorableTrendConfirmationEnabled
        ? finalFreefallResult?.targetSideViolationPrice ?? null
        : null,
    targetSideViolationAt:
      snapshot.freefallGuardEnabled
      && snapshot.favorableTrendConfirmationEnabled
      && finalFreefallResult?.targetSideViolationAt != null
        ? new Date(finalFreefallResult.targetSideViolationAt).toISOString()
        : null,
    freefallConsecutiveSeconds: snapshot.freefallGuardEnabled
      ? snapshot.freefallConsecutiveSeconds
      : null,
    rapidMovePct: snapshot.rapidMoveGuardEnabled
      ? finalFreefallResult?.rapidMovePct ?? null
      : null,
    rapidMoveThresholdPct: snapshot.rapidMoveGuardEnabled
      ? snapshot.rapidMoveThresholdPct
      : null,
    rapidMoveLookbackSeconds: snapshot.rapidMoveGuardEnabled
      ? snapshot.rapidMoveLookbackSeconds
      : null,
    distancePct: finalProximityResult?.distancePct ?? null,
    minimumPct: snapshot.targetProximityGuardEnabled
      ? snapshot.targetProximityThresholdPct
      : null,
    targetPrice: Number.isFinite(targetPriceNum) ? targetPriceNum : null,
    underlyingPrice: latestFinalPriceSample?.price ?? null,
  };
  const withDecisiveGuardEvidence = (
    base: ScalpEntryGuardEvidence,
    guardResult: ReturnType<typeof checkFreefallGuard>,
    evaluatedAtMs: number,
  ): ScalpEntryGuardEvidence => {
    const decisiveSamples = guardResult.evaluatedSamples.length > 0
      ? guardResult.evaluatedSamples
      : evidenceSamples;
    const decisiveCoverageMs = decisiveSamples.length === 0
      ? null
      : decisiveSamples[decisiveSamples.length - 1].at
        - decisiveSamples[0].at;
    return {
      ...base,
      evaluatedAt: new Date(evaluatedAtMs).toISOString(),
      samples: decisiveSamples.map((sample) => ({
        at: new Date(sample.at).toISOString(),
        price: sample.price,
      })),
      sampleCoverageMs: decisiveCoverageMs,
      samplesUsed:
        decisiveSamples.length === 0 ? null : decisiveSamples.length,
      wrongWayResetCount: snapshot.freefallGuardEnabled
        ? guardResult.wrongWayResetCount
        : null,
      lastWrongWayResetAt:
        snapshot.freefallGuardEnabled
        && guardResult.lastWrongWayResetAt != null
          ? new Date(guardResult.lastWrongWayResetAt).toISOString()
          : null,
      consecutiveWrongWayMoves: snapshot.freefallGuardEnabled
        ? guardResult.consecutiveWrongWayMoves
        : null,
      consecutiveWrongWaySeconds: snapshot.freefallGuardEnabled
        ? guardResult.consecutiveWrongWaySeconds
        : null,
      directionalMovePct: snapshot.freefallGuardEnabled
        ? guardResult.directionalMovePct
        : null,
      favorableTrendConfirmed:
        snapshot.freefallGuardEnabled
        && snapshot.favorableTrendConfirmationEnabled
          ? guardResult.favorableTrendConfirmed
          : null,
      favorableTrendReason:
        snapshot.freefallGuardEnabled
        && snapshot.favorableTrendConfirmationEnabled
          ? guardResult.favorableTrendReason
          : null,
      coordinatedDirectionClearanceApplied:
        guardResult.coordinatedDirectionClearanceApplied,
      coordinatedDirectionClearanceSafe:
        guardResult.coordinatedDirectionClearanceSafe,
      coordinatedDirectionClearanceReason:
        guardResult.coordinatedDirectionClearanceReason,
      adversePacePctPerSecond: guardResult.adversePacePctPerSecond,
      projectedAdverseMovePct: guardResult.projectedAdverseMovePct,
      projectedDistancePct: guardResult.projectedDistancePct,
      projectedPrice: guardResult.projectedPrice,
      secondsRemaining: guardResult.secondsRemaining,
      targetSideWindowConfirmed:
        snapshot.freefallGuardEnabled
        && snapshot.favorableTrendConfirmationEnabled
          ? guardResult.targetSideWindowConfirmed
          : null,
      targetSideViolationPrice:
        snapshot.freefallGuardEnabled
        && snapshot.favorableTrendConfirmationEnabled
          ? guardResult.targetSideViolationPrice
          : null,
      targetSideViolationAt:
        snapshot.freefallGuardEnabled
        && snapshot.favorableTrendConfirmationEnabled
        && guardResult.targetSideViolationAt != null
          ? new Date(guardResult.targetSideViolationAt).toISOString()
          : null,
      rapidMovePct: snapshot.rapidMoveGuardEnabled
        ? guardResult.rapidMovePct
        : null,
      underlyingPrice: guardResult.latestPrice,
    };
  };

  // ── Place order or simulate ───────────────────────────────────────────────
  const orderId_pre = mode === "paper" ? `paper-${crypto.randomUUID()}` : null;
  const clientOrderId = mode === "live" ? crypto.randomUUID() : null;

  // For live: persist "submitting" intent BEFORE the exchange call
  const orderRecord: ScalpOrder = {
    id: crypto.randomUUID(),
    mode,
    symbol,
    windowKey,
    ticker,
    side: effectiveSide,
    entryYesPrice,
    contractCount,
    budgetSpent: 0,
    clientOrderId,
    orderId: orderId_pre,
    exchangeResponseReason: null,
    filledCount: 0,
    avgFillPrice: null,
    limitPrice,
    winningContractCost: null,
    status: mode === "paper" ? "paper" : "submitting",
    errorMessage: null,
    settlementResult: null,
    outcome: null,
    pnl: null,
    incidentId: null,
    reconciledAt: null,
    reconciliationEvidence: null,
    layeredRegularPositionId: regularLayerCompatibility.status === "same_side"
      ? regularLayerCompatibility.position.id
      : null,
    layeredRegularSide: regularLayerCompatibility.status === "same_side"
      ? regularLayerCompatibility.position.direction
      : null,
    entryGuardEvidence,
    createdAt: new Date(),
    settledAt: null,
  };

  let filledCount = 0;
  let avgFillPrice: number | null = null;
  let orderId: string | null = orderId_pre;
  let orderError: string | null = null;
  let exchangeResponseReason: string | null = null;
  // Live outcome comes pre-classified from the strict exchange parser.
  let liveOutcome: PlaceOrderClassification = "unknown";

  if (mode === "paper") {
    // ── Paper post-await final validation (no intent exists yet) ──────────────
    // Simulating a fill is the paper equivalent of "submitting", so re-validate
    // synchronously immediately before it.
    const finalReasonPaper = runtime.finalRiskValidationSync(snapshot, windowKey, symbol, ticker);
    if (finalReasonPaper !== null) {
      logger.info(
        { symbol, windowKey, reason: finalReasonPaper },
        "[kalshi-scalper] paper final validation failed before simulate — skipping permanently",
      );
      await runtime.updateReservationStatus(mode, symbol, windowKey, "skipped", finalReasonPaper, true, {
        ..._timingEvidence(),
        ...acceptedFinalQuoteEvidence,
        elapsedMs: runtime.nowMs() - attemptStartMs,
      });
      return;
    }
    const finalLayerPaper = runtime.regularPositionCompatibilitySync(
      mode,
      symbol,
      windowKey,
      ticker,
      effectiveSide,
    );
    if (finalLayerPaper.status === "opposite_side") {
      await runtime.updateReservationStatus(
        mode,
        symbol,
        windowKey,
        "skipped",
        "opposite_regular_position",
        true,
        {
          ..._timingEvidence(),
          ...acceptedFinalQuoteEvidence,
          selectedSide: effectiveSide,
          regularPositionId: finalLayerPaper.position.id,
          regularPositionSide: finalLayerPaper.position.direction,
          layerDecision: "opposite_side_block",
          elapsedMs: runtime.nowMs() - attemptStartMs,
        },
      );
      return;
    }
    const finalProximityPaper = evaluatePinnedProximityAt(runtime.nowMs());
    if (!finalProximityPaper.allowed) {
      const reason = finalProximityPaper.reason ?? "target_proximity_blocked_final";
      await runtime.updateReservationStatus(
        mode,
        symbol,
        windowKey,
        "skipped",
        reason,
        true,
        {
          ..._timingEvidence(),
          ...acceptedFinalQuoteEvidence,
          distancePct: finalProximityPaper.result?.distancePct ?? null,
          minimumPct: snapshot.targetProximityThresholdPct,
          targetPrice: Number.isFinite(targetPriceNum) ? targetPriceNum : null,
          underlyingPrice: finalProximityPaper.latestSample?.price ?? null,
          elapsedMs: runtime.nowMs() - attemptStartMs,
        },
      );
      return;
    }
    const finalFreefallPaperAtMs = runtime.nowMs();
    const finalFreefallPaper =
      snapshot.freefallGuardEnabled || snapshot.rapidMoveGuardEnabled
        ? evaluatePinnedFreefallAt(finalFreefallPaperAtMs)
        : null;
    if (finalFreefallPaper && !finalFreefallPaper.allowed) {
      const guardOutcomeStudy = _buildGuardOutcomeStudy(
        finalFreefallPaper,
        effectiveSide,
        finalRequalification.quote.yesAsk,
        finalRequalification.quote.noAsk,
        finalFreefallPaperAtMs,
        "paper_final_guard",
      );
      await runtime.updateReservationStatus(
        mode,
        symbol,
        windowKey,
        "skipped",
        finalFreefallPaper.reason ?? "freefall_blocked_final",
        true,
        {
          ..._timingEvidence(),
          ...acceptedFinalQuoteEvidence,
          directionalMovePct:
            finalFreefallPaper.guardResult?.directionalMovePct ?? null,
          wrongWayResetCount:
            finalFreefallPaper.guardResult?.wrongWayResetCount ?? null,
          lastWrongWayResetAt:
            finalFreefallPaper.guardResult?.lastWrongWayResetAt != null
              ? new Date(
                  finalFreefallPaper.guardResult.lastWrongWayResetAt,
                ).toISOString()
              : null,
          favorableTrendConfirmationEnabled:
            snapshot.freefallGuardEnabled
            && snapshot.favorableTrendConfirmationEnabled,
          favorableTrendConfirmed:
            finalFreefallPaper.guardResult?.favorableTrendConfirmed ?? null,
          favorableTrendReason:
            finalFreefallPaper.guardResult?.favorableTrendReason ?? null,
          coordinatedDirectionClearanceEnabled:
            snapshot.coordinatedDirectionClearanceEnabled,
          coordinatedDirectionClearanceApplied:
            finalFreefallPaper.guardResult
              ?.coordinatedDirectionClearanceApplied ?? false,
          coordinatedDirectionClearanceSafe:
            finalFreefallPaper.guardResult
              ?.coordinatedDirectionClearanceSafe ?? null,
          coordinatedDirectionClearanceReason:
            finalFreefallPaper.guardResult
              ?.coordinatedDirectionClearanceReason ?? null,
          adversePacePctPerSecond:
            finalFreefallPaper.guardResult?.adversePacePctPerSecond ?? null,
          projectedAdverseMovePct:
            finalFreefallPaper.guardResult?.projectedAdverseMovePct ?? null,
          projectedDistancePct:
            finalFreefallPaper.guardResult?.projectedDistancePct ?? null,
          projectedPrice:
            finalFreefallPaper.guardResult?.projectedPrice ?? null,
          secondsRemaining:
            finalFreefallPaper.guardResult?.secondsRemaining ?? null,
          distancePct: finalProximityResult?.distancePct ?? null,
          minimumPct: snapshot.targetProximityGuardEnabled
            ? snapshot.targetProximityThresholdPct
            : null,
          targetPrice: Number.isFinite(targetPriceNum)
            ? targetPriceNum
            : null,
          targetSideWindowConfirmed:
            finalFreefallPaper.guardResult?.targetSideWindowConfirmed ?? null,
          targetSideViolationPrice:
            finalFreefallPaper.guardResult?.targetSideViolationPrice ?? null,
          targetSideViolationAt:
            finalFreefallPaper.guardResult?.targetSideViolationAt != null
              ? new Date(
                  finalFreefallPaper.guardResult.targetSideViolationAt,
                ).toISOString()
              : null,
          samplesUsed: finalFreefallPaper.guardResult?.samplesUsed ?? null,
          sampleCoverageMs: finalFreefallPaper.sampleCoverageMs,
          protectedSide: effectiveSide,
          guardOutcomeStudy,
        },
      );
      return;
    }
    if (finalFreefallPaper?.guardResult) {
      orderRecord.entryGuardEvidence = withDecisiveGuardEvidence(
        orderRecord.entryGuardEvidence ?? entryGuardEvidence,
        finalFreefallPaper.guardResult,
        finalFreefallPaperAtMs,
      );
    }
    orderRecord.layeredRegularPositionId = finalLayerPaper.status === "same_side"
      ? finalLayerPaper.position.id
      : null;
    orderRecord.layeredRegularSide = finalLayerPaper.status === "same_side"
      ? finalLayerPaper.position.direction
      : null;
    // Paper: simulate price improvement at the authoritative observed quote;
    // avgFillPrice remains YES-side while limitPrice records the hard IOC cap.
    filledCount = contractCount;
    avgFillPrice = entryYesPrice;
    logger.info(
      { symbol, side: effectiveSide, count: contractCount, observedWinningAsk: winningAsk, maxWinningCost, limitPrice, avgFillPrice, windowKey },
      "[kalshi-scalper] PAPER order simulated",
    );
  } else {
    // ── Live: persist the "submitting" intent BEFORE the exchange call ────────
    // insertScalpOrderIntent is awaited, so config could change DURING it.
    const intentWriteStartedAtMs = runtime.nowMs();
    try {
      await runtime.insertScalpOrderIntent(orderRecord);
    } finally {
      if (latency) latency.intentWriteMs = runtime.nowMs() - intentWriteStartedAtMs;
    }

    // ── FINAL synchronous re-validation AFTER intent creation, IMMEDIATELY ────
    // before placeOrder. There MUST be no await between this successful check and
    // the placeOrder call expression below. If it fails, the never-submitted
    // intent is atomically marked skipped and the reservation released (no broker
    // was called → RESOLVED, not unknown), then we abort before any exchange call.
    const finalReasonLive = runtime.finalRiskValidationSync(snapshot, windowKey, symbol, ticker);
    const finalLayerLive = runtime.regularPositionCompatibilitySync(
      mode,
      symbol,
      windowKey,
      ticker,
      effectiveSide,
    );
    const finalFreefallLiveAtMs = runtime.nowMs();
    const finalProximityLive = evaluatePinnedProximityAt(finalFreefallLiveAtMs);
    const finalFreefallLive =
      snapshot.freefallGuardEnabled || snapshot.rapidMoveGuardEnabled
        ? evaluatePinnedFreefallAt(finalFreefallLiveAtMs)
        : null;
    if (finalFreefallLive?.guardResult) {
      orderRecord.entryGuardEvidence = withDecisiveGuardEvidence(
        orderRecord.entryGuardEvidence ?? entryGuardEvidence,
        finalFreefallLive.guardResult,
        finalFreefallLiveAtMs,
      );
    }
    const finalAbortReason = finalReasonLive
      ?? (finalLayerLive.status === "opposite_side" ? "opposite_regular_position" : null)
      ?? (!finalProximityLive.allowed
        ? finalProximityLive.reason ?? "target_proximity_blocked_final"
        : null)
      ?? (
        finalFreefallLive && !finalFreefallLive.allowed
          ? finalFreefallLive.reason ?? "freefall_blocked_final"
          : null
      );
    if (finalAbortReason !== null) {
      logger.info(
        { symbol, windowKey, reason: finalAbortReason },
        "[kalshi-scalper] live final validation failed after intent, before submit — aborting intent + releasing (no broker call)",
      );
      const guardOutcomeStudy =
        finalReasonLive === null
        && finalLayerLive.status !== "opposite_side"
        && finalProximityLive.allowed
        && finalFreefallLive
        && !finalFreefallLive.allowed
          ? _buildGuardOutcomeStudy(
              finalFreefallLive,
              effectiveSide,
              finalRequalification.quote.yesAsk,
              finalRequalification.quote.noAsk,
              finalFreefallLiveAtMs,
              "live_final_guard",
            )
          : null;
      await runtime.abortIntentAndReleaseReservation({
        orderId: orderRecord.id, mode, symbol, windowKey,
        reason: `aborted_before_submit:${finalAbortReason}`,
        entryGuardEvidence: orderRecord.entryGuardEvidence,
        skipEvidence: {
          ..._timingEvidence(),
          ...acceptedFinalQuoteEvidence,
          regularPositionId: finalLayerLive.status === "opposite_side"
            ? finalLayerLive.position.id
            : null,
          regularPositionSide: finalLayerLive.status === "opposite_side"
            ? finalLayerLive.position.direction
            : null,
          layerDecision: finalLayerLive.status === "opposite_side"
            ? "opposite_side_block"
            : null,
          directionalMovePct:
            finalFreefallLive?.guardResult?.directionalMovePct ?? null,
          wrongWayResetCount:
            finalFreefallLive?.guardResult?.wrongWayResetCount ?? null,
          lastWrongWayResetAt:
            finalFreefallLive?.guardResult?.lastWrongWayResetAt != null
              ? new Date(
                  finalFreefallLive.guardResult.lastWrongWayResetAt,
                ).toISOString()
              : null,
          favorableTrendConfirmationEnabled:
            snapshot.freefallGuardEnabled
            && snapshot.favorableTrendConfirmationEnabled,
          favorableTrendConfirmed:
            finalFreefallLive?.guardResult?.favorableTrendConfirmed ?? null,
          favorableTrendReason:
            finalFreefallLive?.guardResult?.favorableTrendReason ?? null,
          coordinatedDirectionClearanceEnabled:
            snapshot.coordinatedDirectionClearanceEnabled,
          coordinatedDirectionClearanceApplied:
            finalFreefallLive?.guardResult
              ?.coordinatedDirectionClearanceApplied ?? false,
          coordinatedDirectionClearanceSafe:
            finalFreefallLive?.guardResult
              ?.coordinatedDirectionClearanceSafe ?? null,
          coordinatedDirectionClearanceReason:
            finalFreefallLive?.guardResult
              ?.coordinatedDirectionClearanceReason ?? null,
          adversePacePctPerSecond:
            finalFreefallLive?.guardResult?.adversePacePctPerSecond ?? null,
          projectedAdverseMovePct:
            finalFreefallLive?.guardResult?.projectedAdverseMovePct ?? null,
          projectedDistancePct:
            finalFreefallLive?.guardResult?.projectedDistancePct ?? null,
          projectedPrice:
            finalFreefallLive?.guardResult?.projectedPrice ?? null,
          secondsRemaining:
            finalFreefallLive?.guardResult?.secondsRemaining ?? null,
          distancePct:
            finalProximityLive.result?.distancePct
            ?? finalProximityResult?.distancePct
            ?? null,
          minimumPct: snapshot.targetProximityGuardEnabled
            ? snapshot.targetProximityThresholdPct
            : null,
          targetPrice: Number.isFinite(targetPriceNum)
            ? targetPriceNum
            : null,
          underlyingPrice: finalProximityLive.latestSample?.price ?? null,
          targetSideWindowConfirmed:
            finalFreefallLive?.guardResult?.targetSideWindowConfirmed ?? null,
          targetSideViolationPrice:
            finalFreefallLive?.guardResult?.targetSideViolationPrice ?? null,
          targetSideViolationAt:
            finalFreefallLive?.guardResult?.targetSideViolationAt != null
              ? new Date(
                  finalFreefallLive.guardResult.targetSideViolationAt,
                ).toISOString()
              : null,
          samplesUsed: finalFreefallLive?.guardResult?.samplesUsed ?? null,
          sampleCoverageMs: finalFreefallLive?.sampleCoverageMs ?? null,
          protectedSide: effectiveSide,
          guardOutcomeStudy,
        },
      });
      return;
    }
    orderRecord.layeredRegularPositionId = finalLayerLive.status === "same_side"
      ? finalLayerLive.position.id
      : null;
    orderRecord.layeredRegularSide = finalLayerLive.status === "same_side"
      ? finalLayerLive.position.direction
      : null;

    // Live: submit via the SCALPER-OWNED exchange boundary (never placeOrder).
    // Uses immediate_or_cancel + taker_at_cross with the exact YES-side
    // limitPrice, and STRICTLY parses the raw response (no zero-coercion).
    // NOTE: no await occurs between the successful check above and this call.
    const brokerSubmitStartedAtMs = runtime.nowMs();
    try {
      const result = await runtime.placeScalpOrderStrict({
        ticker,
        side: effectiveSide,
        limitPrice,
        count: contractCount,
        clientOrderId: clientOrderId!,
      });
      if (latency) latency.brokerSubmitMs = runtime.nowMs() - brokerSubmitStartedAtMs;
      // Strict parser already discriminated the outcome. A malformed body maps
      // to outcome "unknown" (never zero-coerced); use its validated fields.
      liveOutcome = result.outcome;
      exchangeResponseReason = result.reason;
      filledCount = result.filledCount ?? NaN; // null (unknown) → NaN sentinel
      avgFillPrice = result.avgFillPrice; // YES-side fraction or null
      orderId = result.orderId;
      logger.info(
        { symbol, side: effectiveSide, contractCount, outcome: result.outcome, reason: result.reason, filledCount: result.filledCount, avgFillPrice, observedWinningAsk: winningAsk, maxWinningCost, limitPrice, windowKey },
        "[kalshi-scalper] LIVE order submitted (strict)",
      );
    } catch (err) {
      if (latency) latency.brokerSubmitMs = runtime.nowMs() - brokerSubmitStartedAtMs;
      orderError = String(err);
      if (isDefinitiveScalpOrderRejection(err)) {
        const rejection = parseDefinitiveScalpOrderRejection(err)!;
        await _applyScalpReconciliation(orderRecord, {
          outcome: "zero_fill",
          reason: `definitive_http_rejection_${rejection.status}`,
          orderId: null,
          filledCount: 0,
          avgFillPrice: null,
          budgetSpent: 0,
          evidence: {
            source: "live_definitive_http_rejection",
            httpStatus: rejection.status,
            exchangeCode: rejection.code,
          },
        });
        logger.warn(
          {
            symbol,
            ticker,
            side: effectiveSide,
            httpStatus: rejection.status,
            exchangeCode: rejection.code,
          },
          "[kalshi-scalper] definitive exchange rejection — recorded zero fill without breaker",
        );
        return;
      }
      logger.error({ err, symbol, ticker, side: effectiveSide }, "[kalshi-scalper] LIVE strict submit THREW — fill state UNKNOWN");

      const reconciliation = await _fetchScalpReconciliation({
        ...orderRecord,
        exchangeResponseReason: "scalp_submit_threw",
      });
      if (reconciliation.outcome !== "ambiguous") {
        await _applyScalpReconciliation(orderRecord, reconciliation);
        logger.warn(
          { symbol, windowKey, outcome: reconciliation.outcome, orderId: reconciliation.orderId },
          "[kalshi-scalper] submit exception reconciled authoritatively before breaker latch",
        );
        return;
      }

      // Submit threw — fill state INDETERMINATE. Mark order UNKNOWN (not
      // error), keep the reservation's reserved budget (do NOT release), create
      // a high-severity incident, and trip the breaker. Never infer a fill.
      await _handleUnknownExposure({
        orderRecordId: orderRecord.id,
        mode, symbol, windowKey, ticker,
        bandMin: snapshot.bandMin, bandMax: snapshot.bandMax,
        reason: `scalp_submit_threw:${symbol}:${windowKey}`,
        description: `scalp submit threw (fill state unknown): ${orderError}`,
        exchangeResponseReason: reconciliation.reason,
        entryGuardEvidence: orderRecord.entryGuardEvidence,
      });
      // Signal the outer catch to NOT release budget (fail-closed).
      throw new OrderIntentExistsError(err);
    }
  }

  // ── EXACT result classification (fail-closed) ─────────────────────────────
  // LIVE outcomes come pre-classified from the strict parser (authoritative).
  // Paper always simulates a valid (0,1) fill; route it through the classifier
  // (with requestedCount) so behavior is uniform and tested.
  const classification =
    mode === "live"
      ? (liveOutcome as PlaceOrderClassification)
      : classifyPlaceOrderResult({ filledCount, avgFillPrice, requestedCount: contractCount });

  // ── (3) UNVERIFIED EXCHANGE RESPONSE ──────────────────────────────────────
  if (classification === "unknown") {
    if (mode === "live") {
      const parserReason = exchangeResponseReason ?? (
        liveOutcome === "unknown" ? "strict_response_untrusted" : "unknown_classification"
      );
      const reconciliation = await _fetchScalpReconciliation({
        ...orderRecord,
        orderId,
        exchangeResponseReason: parserReason,
      });
      if (reconciliation.outcome !== "ambiguous") {
        await _applyScalpReconciliation(
          { ...orderRecord, orderId, exchangeResponseReason: parserReason },
          reconciliation,
        );
        logger.warn(
          { symbol, windowKey, outcome: reconciliation.outcome, orderId: reconciliation.orderId },
          "[kalshi-scalper] malformed submit response reconciled authoritatively before breaker latch",
        );
        return;
      }
      // Fail closed: mark unknown, retain reserved budget, incident, breaker.
      await _handleUnknownExposure({
        orderRecordId: orderRecord.id,
        mode, symbol, windowKey, ticker,
        bandMin: snapshot.bandMin, bandMax: snapshot.bandMax,
        reason: `unverified_exchange_response:${symbol}:${windowKey}`,
        description:
          `Kalshi returned an order response the Scalper could not fully verify: ` +
          `parser=${parserReason}; filledCount=${filledCount} avgFillPrice=${String(avgFillPrice)}; ` +
          `reconciliation=${reconciliation.reason}. ` +
          `Reserved budget retained; authoritative reconciliation required.`,
        exchangeOrderId: orderId,
        exchangeResponseReason: parserReason,
        entryGuardEvidence: orderRecord.entryGuardEvidence,
      });
    } else {
      // Paper cannot reach here in practice (simulated price is always valid),
      // but if it did there is NO broker exposure — record explicitly + release.
      logger.error(
        { symbol, windowKey, filledCount, avgFillPrice },
        "[kalshi-scalper] PAPER unexpected unknown classification — recording error + releasing reservation",
      );
      await runtime.insertScalpOrderIntent({
        ...orderRecord, status: "error", filledCount, avgFillPrice, orderId,
        errorMessage: `paper_unknown_classification: filledCount=${filledCount} avgFillPrice=${String(avgFillPrice)}`,
      }).catch(() => {});
      await runtime.updateReservationStatus(mode, symbol, windowKey, "error", "paper_unknown_classification", true).catch(() => {});
    }
    // Never continue past a confirmed-exposure unknown.
    _terminalAttemptKeys.add(attemptKey);
    return;
  }

  // ── (1) Definite zero fill (filledCount === 0; avg may be null) ────────────
  if (classification === "zero_fill") {
    if (mode === "live") {
      // Atomic: finalize intent zero_fill + release reservation in one txn.
      // Post-submit persistence MUST fail closed — no .catch swallowing.
      try {
        await runtime.finalizeOrderAndReleaseReservation({
          orderId: orderRecord.id, mode, symbol, windowKey,
          status: "zero_fill", reservationStatus: "zero_fill",
          filledCount: 0, avgFillPrice: null, winningContractCost: null,
          budgetSpent: 0, exchangeOrderId: orderId, reason: "zero_fill",
          layeredRegularPositionId: orderRecord.layeredRegularPositionId,
          layeredRegularSide: orderRecord.layeredRegularSide,
          entryGuardEvidence: orderRecord.entryGuardEvidence,
        });
      } catch (persistErr) {
        // Broker returned zero fill, but we failed to persist that fact. The
        // transaction rolled back → reserved budget is intact. Fail closed:
        // do NOT release; trip breaker; best-effort mark unknown.
        await _onPostSubmitPersistenceFailure(persistErr, {
          orderRecordId: orderRecord.id, mode, symbol, windowKey, ticker,
          bandMin: snapshot.bandMin, bandMax: snapshot.bandMax,
          context: "zero_fill_finalize_failed",
          entryGuardEvidence: orderRecord.entryGuardEvidence,
        });
        throw new PostSubmitPersistenceError(persistErr);
      }
    } else {
      // Paper: persist the simulated outcome and release atomically.
      await runtime.finalizePaperOrderAndReleaseReservation(
        { ...orderRecord, status: "zero_fill", orderId },
        "zero_fill",
        "zero_fill",
      );
    }
    _rememberReservationOutcome(
      attemptKey,
      "zero_fill",
      "zero_fill",
      mode === "live" ? priorSubmittedOrders + 1 : priorSubmittedOrders,
      runtime.nowMs(),
    );
    logger.info(
      {
        symbol,
        windowKey,
        submission: priorSubmittedOrders + 1,
        maxSubmissions: SCALP_MAX_SUBMISSIONS_PER_WINDOW,
      },
      "[kalshi-scalper] confirmed zero fill — bounded retry policy applied",
    );
    return;
  }

  // ── (2) CONFIRMED FILL: filledCount>0 AND avgFillPrice finite in (0,1) ─────
  // (classification === "confirmed_fill"; avgFillPrice is narrowed non-null.)
  const confirmedAvg = avgFillPrice as number;
  const fillBand = classifyScalpFillAgainstBand(
    effectiveSide,
    confirmedAvg,
    snapshot.bandMin,
    snapshot.bandMax,
  );
  const winningContractCost = fillBand.winningContractCost;
  const actualSpent = winningContractCost * filledCount;
  const finalStatus = mode === "paper" ? "paper" as const : "filled" as const;

  if (mode === "live") {
    // Atomic: finalize intent filled + release reservation in one txn.
    // Post-submit persistence MUST fail closed — no .catch swallowing.
    try {
      await runtime.finalizeOrderAndReleaseReservation({
        orderId: orderRecord.id, mode, symbol, windowKey,
        status: finalStatus, reservationStatus: "filled",
        filledCount, avgFillPrice: confirmedAvg, winningContractCost,
        budgetSpent: actualSpent, exchangeOrderId: orderId, reason: null,
        layeredRegularPositionId: orderRecord.layeredRegularPositionId,
        layeredRegularSide: orderRecord.layeredRegularSide,
        entryGuardEvidence: orderRecord.entryGuardEvidence,
      });
    } catch (persistErr) {
      // Contracts were bought but we failed to persist the fill + release. The
      // transaction rolled back → reserved budget intact. Fail closed.
      await _onPostSubmitPersistenceFailure(persistErr, {
        orderRecordId: orderRecord.id, mode, symbol, windowKey, ticker,
        bandMin: snapshot.bandMin, bandMax: snapshot.bandMax,
        context: "fill_finalize_failed",
        entryGuardEvidence: orderRecord.entryGuardEvidence,
      });
      throw new PostSubmitPersistenceError(persistErr);
    }
  } else {
    // Paper: persist the simulated fill and release atomically. Never declare a
    // successful layer if either durable write fails.
    await runtime.finalizePaperOrderAndReleaseReservation(
      {
        ...orderRecord,
        status: finalStatus,
        filledCount,
        avgFillPrice: confirmedAvg,
        winningContractCost,
        budgetSpent: actualSpent,
        orderId,
      },
      "filled",
      null,
    );
  }
  _terminalAttemptKeys.add(attemptKey);
  _nextAttemptAt.delete(attemptKey);

  // Record both non-standard outcomes, but only an adverse above-ceiling fill
  // is high severity and allowed to halt execution.
  if (fillBand.classification !== "within_band") {
    const incident = _buildFillBandIncident({
      orderId: orderRecord.id,
      mode,
      symbol,
      windowKey,
      ticker,
      side: effectiveSide,
      bandMin: snapshot.bandMin,
      bandMax: snapshot.bandMax,
      fillBand,
      reconciled: false,
    });
    // Never swallow execution-record persist failures.
    await insertScalpIncident(incident);
    await setScalpOrderIncident(orderRecord.id, incident.id).catch(() => {});
    if (fillBand.classification === "adverse_limit_breach") {
      await _tripCircuitBreaker(
        _fillAboveCeilingBreakerReason(
          symbol,
          effectiveSide,
          winningContractCost,
          snapshot.bandMax,
        ),
      );
    }
  }
}

export interface ControlledFreefallServiceExerciseResult {
  steps: Array<{
    label:
      | "adverse"
      | "adverse_cooldown"
      | "fetch_failed"
      | "fetch_cooldown"
      | "stale"
      | "stale_cooldown"
      | "target_crossing"
      | "recovered"
      | "recovered_retry";
    state: "skipped" | "cooldown" | "submitted";
    reason: string | null;
    checkedAt: string;
    retryAfterMs: number | null;
    intentWrites: number;
    brokerSubmissions: number;
      paperSubmissions: number;
  }>;
  skippedAttempts: Array<{
    reason: string;
    skippedAt: string | null;
    evidence: ScalpSkipEvidence | null;
  }>;
  submittedEntryEvidence: ScalpEntryGuardEvidence | null;
  submittedEntryEvidences: ScalpEntryGuardEvidence[];
  abortedBeforeSubmitReasons: string[];
  abortedBeforeSubmitEvidences: ScalpSkipEvidence[];
  intentWrites: number;
  brokerSubmissions: number;
  paperSubmissions: number;
  quoteFetches: number;
  submittedLimitPrices: number[];
  submittedCounts: number[];
}

export interface ControlledFreefallServiceExerciseOptions {
  mode?: ScalpMode;
  side?: "yes" | "no";
  targetProximityGuardEnabled?: boolean;
  coordinatedDirectionClearanceEnabled?: boolean;
  /** Optional test-only complete-window prices for the adverse step. */
  adversePrices?: number[];
  runSecondSubmission?: boolean;
  /** Controlled clock advance while the durable live intent is being written. */
  intentWriteAdvanceMs?: number;
  /** Test-only authenticated orderbooks consumed in fetch order. */
  authenticatedQuoteSequence?: Array<{
    yesAsk: number | null;
    yesBid: number | null;
  }>;
  /** Controlled clock advance applied after every authenticated quote response. */
  quoteFetchAdvanceMs?: number;
  /** Start closer to expiry for deadline-boundary exercises. */
  startSecondsRemaining?: number;
  /** Run only the clear-path attempt rather than the full Freefall scenario. */
  onlyRecoveredStep?: boolean;
  /** Simulate a window rollover after this many quote fetches. */
  windowChangesAfterQuoteFetchCount?: number;
  /** Test-only underlying values consumed by authoritative sample fetches. */
  underlyingPriceSequence?: number[];
  /** Test-only success/failure sequence for authoritative sample fetches. */
  underlyingSampleSuccessSequence?: boolean[];
  /** Simulate an underlying move while the durable intent is being written. */
  intentWriteUnderlyingPrice?: number;
}

export interface ControlledSampleSchedulerExerciseResult {
  backgroundStartedBeforeAuthoritative: string[];
  authoritativeStartedBeforeBackgroundRelease: boolean;
  startOrder: string[];
  maxActiveObserved: number;
}
/**
 * Post-submit persistence failure handler. Called when a LIVE
 * finalizeOrderAndReleaseReservation transaction throws AFTER the broker call.
 *
 * Contract: the failed transaction rolled back, so reserved_budget is unchanged
 * (retained). This function MUST NOT release the reservation. It trips the
 * breaker (in-memory first), best-effort marks the intent + reservation unknown
 * WITHOUT release, and best-effort records an incident. It never throws — the
 * caller re-throws PostSubmitPersistenceError so the outer catch stops scanning.
 */
async function _onPostSubmitPersistenceFailure(
  err: unknown,
  args: {
    orderRecordId: string;
    mode: ScalpMode;
    symbol: string;
    windowKey: string;
    ticker: string;
    bandMin: number;
    bandMax: number;
    context: string;
    entryGuardEvidence?: ScalpEntryGuardEvidence | null;
  },
): Promise<void> {
  logger.error(
    { err, ...args },
    "[kalshi-scalper] POST-SUBMIT persistence FAILED — reserved budget retained, failing closed",
  );
  await _handleUnknownExposure({
    orderRecordId: args.orderRecordId,
    mode: args.mode,
    symbol: args.symbol,
    windowKey: args.windowKey,
    ticker: args.ticker,
    bandMin: args.bandMin,
    bandMax: args.bandMax,
    reason: `post_submit_persist_failed:${args.context}:${args.symbol}:${args.windowKey}`,
    description: `Post-submit persistence failed (${args.context}): ${String(err)}. Reserved budget retained; manual reconciliation required.`,
    entryGuardEvidence: args.entryGuardEvidence ?? null,
  }).catch((e) =>
    logger.error({ e, ...args }, "[kalshi-scalper] CRITICAL: unknown-exposure handling itself failed after post-submit persist failure"),
  );
}

// ---------------------------------------------------------------------------
// Settlement evaluation
// ---------------------------------------------------------------------------

async function _evaluateSettlements(): Promise<void> {
  try {
    const unsettled = await getUnsettledScalpOrders();
    for (const order of unsettled) {
      await _settleOrder(order).catch((err) =>
        logger.warn({ err, id: order.id }, "[kalshi-scalper] settle order error (non-fatal)"),
      );
    }
    await evaluateContrarianLifecycle().catch((err) =>
      logger.warn(
        { err },
        "[kalshi-scalper] contrarian lifecycle evaluation error (non-fatal)",
      ),
    );
  } catch (err) {
    logger.warn({ err }, "[kalshi-scalper] settlement eval error (non-fatal)");
  }
}

async function _settleOrder(order: ScalpOrder): Promise<void> {
  const result = await fetchKalshiMarketResult(order.ticker).catch(() => null);
  if (result?.result === "yes" || result?.result === "no") {
    await _applySettlement(order, result.result);
    return;
  }
  const series = order.ticker.split("-")[0];
  if (series) {
    const settled = await fetchKalshiSettledMarkets(series, 50).catch(
      (): Array<{ ticker: string; result: "yes" | "no"; closeTime: string; floorStrike: number }> => [],
    );
    const match = settled.find((m) => m.ticker === order.ticker);
    if (match) {
      await _applySettlement(order, match.result);
    }
  }
}

async function _applySettlement(order: ScalpOrder, result: "yes" | "no"): Promise<void> {
  if (order.avgFillPrice == null) return;
  const pnl = computeScalpPnl(order.mode, order.side, order.filledCount, order.avgFillPrice, result);
  const outcome: "win" | "loss" = pnl >= 0 ? "win" : "loss";
  await updateScalpOrderSettlement(order.id, result, outcome, pnl);
  logger.info(
    { id: order.id, symbol: order.symbol, side: order.side, result, outcome, pnl },
    "[kalshi-scalper] order settled",
  );
}

// ---------------------------------------------------------------------------
// Market status snapshot (for GET /status markets array)
// ---------------------------------------------------------------------------

function _buildMarketStatuses(wk: string): ScalpMarketStatus[] {
  return CRYPTO_COINS
    .filter((c) => KALSHI_SERIES[c.symbol])
    .map((coin) => {
      const sym = coin.symbol.toUpperCase();
      const params = resolveEffectiveParams(_config, sym, "");
      const cached = getKalshiCachedData(sym);
      const yesAsk = cached?.yesAsk ?? null;
      const yesBid = cached?.yesBid ?? null;
      const noAsk = yesBid != null ? 1 - yesBid : null;
      const closeTime = cached?.closeTime ?? null;
      const nowForStatus = Date.now();
      const secondsRemaining = closeTime
        ? Math.max(0, (new Date(closeTime).getTime() - nowForStatus) / 1000)
        : null;
      const inWindow = closeTime != null
        ? isInFinalWindow(closeTime, nowForStatus, params.finalWindowSeconds, wk)
        : false;
      const timingPhase = resolveTimingPhase(closeTime, nowForStatus, params.finalWindowSeconds, SCALP_PREFLIGHT_LEAD_SECONDS);
      const secsUntilEligible = secondsUntilEligible(closeTime, nowForStatus, params.finalWindowSeconds);

      let freefallBlocked = false;
      let freefallSamplesUsed = 0;
      let freefallRequiredSamples = Math.max(
        _config.freefallGuardEnabled ? _config.freefallConsecutiveSeconds : 0,
        _config.rapidMoveGuardEnabled ? _config.rapidMoveLookbackSeconds : 0,
      ) + 1;
      let freefallMovementPct: number | null = null;
      let rapidMoveBlocked = false;
      let targetProximityBlocked = false;
      let targetDistancePct: number | null = null;
      let reason: string | null = null;
      const match = yesAsk != null || noAsk != null
        ? selectScalpSide(yesAsk, noAsk, params.bandMin, params.bandMax)
        : null;

      // lastAsk = the SELECTED winning-contract ask (or null when out of band).
      const lastAsk = match ? match.winningAsk : null;

      if (
        match
        && (_config.freefallGuardEnabled || _config.rapidMoveGuardEnabled)
        && inWindow
      ) {
        const samples = _priceSamples.get(sym) ?? [];
        const ff = checkFreefallGuard({
          samples,
          side: match.side,
          nowMs: nowForStatus,
          directionEnabled: _config.freefallGuardEnabled,
          eligibilityStartMs:
            Date.parse(closeTime!) - params.finalWindowSeconds * 1_000,
          consecutiveSeconds: _config.freefallConsecutiveSeconds,
          favorableTrendConfirmationEnabled:
            _config.favorableTrendConfirmationEnabled,
          targetPrice: Number(cached?.value),
          rapidMoveEnabled: _config.rapidMoveGuardEnabled,
          rapidMoveLookbackSeconds: _config.rapidMoveLookbackSeconds,
          rapidMoveThresholdPct: _config.rapidMoveThresholdPct,
        });
        // Unavailable (not evaluable) is a fail-closed skip, NOT a clear signal:
        // surface it as blocked with its unavailability reason so the UI does not
        // imply the guard is passing when it actually cannot evaluate.
        freefallBlocked =
          !ff.evaluable
          || ff.directionalBlocked
          || ff.favorableTrendBlocked
          || ff.wrongTargetSide;
        freefallSamplesUsed = ff.samplesUsed;
        freefallRequiredSamples = ff.requiredSamples;
        freefallMovementPct = ff.evaluable ? ff.directionalMovePct : null;
        rapidMoveBlocked = ff.rapidMoveBlocked;
        reason = ff.reason;
      }

      if (match && _config.targetProximityGuardEnabled && inWindow) {
        const samples = _priceSamples.get(sym) ?? [];
        const latestSample = samples[samples.length - 1];
        const proximity = checkTargetProximityGuard(
          latestSample?.price,
          Number(cached?.value),
          _config.targetProximityThresholdPct,
        );
        targetProximityBlocked = proximity.blocked || !proximity.evaluable;
        targetDistancePct = proximity.distancePct;
        reason = reason ?? proximity.reason;
      }

      const state = resolveScalpMarketState({
        paused: params.paused,
        hasQuote: yesAsk != null || noAsk != null,
        hasMatch: match != null,
        inWindow,
        guardBlocked: freefallBlocked || rapidMoveBlocked || targetProximityBlocked,
      });
      if (state === "paused") reason = reason ?? "paused";
      else if (state === "no_quote") reason = reason ?? "no_quote";
      else if (state === "out_of_band") reason = reason ?? "out_of_band";
      else if (state === "ready") reason = reason ?? "awaiting_final_window";

      return {
        symbol: sym,
        state,
        timingPhase,
        effectiveBandMin: params.bandMin,
        effectiveBandMax: params.bandMax,
        effectiveWindowSeconds: params.finalWindowSeconds,
        effectiveBudgetDollars: params.budgetDollars,
        lastAsk,
        secondsRemaining: secondsRemaining != null ? Math.round(secondsRemaining) : null,
        secondsUntilEligible: secsUntilEligible != null ? Math.round(secsUntilEligible) : null,
        freefallBlocked,
        freefallSamplesUsed,
        freefallRequiredSamples,
        freefallObservationSeconds: _config.freefallConsecutiveSeconds,
        freefallMovementPct,
        rapidMoveBlocked,
        targetProximityBlocked,
        targetDistancePct,
        reason,
      };
    });
}

// ---------------------------------------------------------------------------
// Public read APIs
// ---------------------------------------------------------------------------

/** Serialize an order to the exact shape the frontend ScalpOrder type expects.
 *  Exposes `error` (alias of errorMessage) and includes winningContractCost.
 *  Dates are ISO strings. outcome is 'open' when filled but unsettled. */
function serializeScalpOrder(o: ScalpOrder) {
  const filledUnsettled = o.filledCount > 0 && o.outcome == null && o.settlementResult == null;
  return {
    id: o.id,
    mode: o.mode,
    symbol: o.symbol,
    windowKey: o.windowKey,
    ticker: o.ticker,
    side: o.side,
    entryYesPrice: o.entryYesPrice,
    contractCount: o.contractCount,
    budgetSpent: o.budgetSpent,
    orderId: o.orderId,
    filledCount: o.filledCount,
    avgFillPrice: o.avgFillPrice,
    limitPrice: o.limitPrice,
    winningContractCost: o.winningContractCost,
    status: o.status,
    error: o.errorMessage,          // frontend alias
    errorMessage: o.errorMessage,   // keep original too
    settlementResult: o.settlementResult,
    outcome: filledUnsettled ? "open" : o.outcome,
    pnl: o.pnl,
    incidentId: o.incidentId,
    layeredRegularPositionId: o.layeredRegularPositionId ?? null,
    layeredRegularSide: o.layeredRegularSide ?? null,
    entryGuardEvidence: o.entryGuardEvidence ?? null,
    createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : o.createdAt,
    settledAt: o.settledAt instanceof Date ? o.settledAt.toISOString() : o.settledAt,
  };
}

export async function getScalpStatus(requestedMode?: ScalpMode) {
  const mode = requestedMode ?? _config.mode;
  const wk = currentWindowKey() ?? "";
  const [dailySpend, openSpend, recentOrders, recentAttempts, incidents, todayRes, unresolvedAttempts] = await Promise.all([
    getTodayScalpSpend(mode),
    getOpenScalpSpend(mode, wk),
    getScalpOrders({ mode, limit: 20 }),
    getRecentScalpReservations({ mode, limit: 20 }),
    getScalpIncidents(10),
    countTodayReservations(mode),
    // Unresolved exposure is always live and must remain visible even if the
    // operator temporarily switches the Scalper UI to paper mode.
    getUnresolvedLiveAttempts(),
  ]);

  const markets = _buildMarketStatuses(wk);
  const latencySummary = summarizeScalpAttemptLatencies(
    _recentAttemptLatencies.filter((attempt) => attempt.mode === mode),
  );
  // getScalpOrders is newest-first. Keep the first row for attempts that used
  // bounded IOC retries so the dashboard explains the final submission.
  const recentOrderByAttemptKey = new Map<string, ScalpOrder>();
  for (const order of recentOrders) {
    const key = _attemptKey(order.mode, order.symbol, order.windowKey);
    if (!recentOrderByAttemptKey.has(key)) recentOrderByAttemptKey.set(key, order);
  }

  return {
    config: { ..._config },
    circuitBreaker: _config.circuitBreaker,
    circuitBreakerReason: _config.circuitBreakerReason,
    circuitBreakerMessage: describeScalpCircuitBreakerReason(_config.circuitBreakerReason),
    mode,
    totalReservationsToday: todayRes,
    openSpend,
    dailySpend,
    recentOrders: recentOrders.map(serializeScalpOrder),
    recentAttempts: recentAttempts.map((attempt) => {
      const retry = evaluateScalpReservationRetry({
        status: attempt.status,
        reason: attempt.reason,
        elapsedMs: Math.max(0, Date.now() - attempt.attemptedAt.getTime()),
        submittedOrders: attempt.submissionCount,
      });
      return {
        id: attempt.id,
        mode: attempt.mode,
        symbol: attempt.symbol,
        windowKey: attempt.windowKey,
        ticker: attempt.ticker,
        status: attempt.status,
        reason: attempt.reason ?? null,
        reservedBudget: attempt.reservedBudget,
        submissionCount: attempt.submissionCount,
        side: attempt.latestSide ?? null,
        observedWinningAsk: attempt.observedWinningAsk ?? null,
        executionWinningLimit: attempt.executionWinningLimit ?? null,
        submittedLimitPrice: attempt.submittedLimitPrice ?? null,
        layeredRegularPositionId: attempt.layeredRegularPositionId ?? null,
        layeredRegularSide: attempt.layeredRegularSide ?? null,
        skipEvidence: attempt.skipEvidence ?? null,
        entryGuardEvidence:
          recentOrderByAttemptKey.get(
            _attemptKey(attempt.mode, attempt.symbol, attempt.windowKey),
          )?.entryGuardEvidence ?? null,
        latency: _latestAttemptLatencyByKey.get(
          _attemptKey(attempt.mode, attempt.symbol, attempt.windowKey),
        ) ?? null,
        retryEligible: !retry.terminal,
        retryState:
          attempt.status === "claimed"
            ? "in_flight"
            : retry.terminal
              ? "terminal"
              : retry.retryableNow
                ? "ready"
                : "cooldown",
        retryAfterMs: retry.retryAfterMs,
        createdAt: attempt.createdAt.toISOString(),
        attemptedAt: attempt.attemptedAt.toISOString(),
      };
    }),
    unresolvedAttempts: unresolvedAttempts.map((attempt) => ({
      ...attempt,
      createdAt: attempt.createdAt.toISOString(),
    })),
    incidents,
    latency: latencySummary,
    scanHealth: {
      running: _scanRunner.isRunning(),
      followUpPending: _scanRunner.hasPendingRun(),
      attemptsInFlight: _attemptsInFlight.size,
      shadowObservationPending: _shadowObservationQueued,
    },
    // ISO string | null (not epoch)
    lastScanAt: _lastScanAt != null ? new Date(_lastScanAt).toISOString() : null,
    lastError: _lastError,
    preflight: {
      ..._preflightStatus,
      checkedAt: _preflightStatus.checkedAt != null
        ? new Date(_preflightStatus.checkedAt).toISOString()
        : null,
    },
    executionPolicy: {
      scanIntervalMs: SCALP_SCAN_INTERVAL_MS,
      authenticatedRetryCooldownMs: SCALP_AUTH_RETRY_COOLDOWN_MS,
      maxAuthenticatedQuoteRetries: SCALP_MAX_AUTHENTICATED_QUOTE_RETRIES,
      authenticatedQuoteRetryMinRemainingMs:
        SCALP_AUTHENTICATED_QUOTE_RETRY_MIN_REMAINING_MS,
      maxSubmissionsPerWindow: SCALP_MAX_SUBMISSIONS_PER_WINDOW,
      maxConcurrentCandidates: SCALP_MAX_CONCURRENT_CANDIDATES,
      maxConcurrentBackgroundSamples: SCALP_MAX_CONCURRENT_BACKGROUND_SAMPLES,
      preflightLeadSeconds: SCALP_PREFLIGHT_LEAD_SECONDS,
    },
    markets,
    regularBotMode: getRegularBotMode(),
  };
}

export async function getScalpHistory(opts: { mode?: ScalpMode; symbol?: string; limit?: number }) {
  const orders = await getScalpOrders(opts);
  return { orders: orders.map(serializeScalpOrder), total: orders.length };
}

export async function getScalpPerformance(mode: ScalpMode): Promise<ScalpPerformance> {
  const baseline = await getScalpPerformanceBaseline(mode);
  const orders = await getScalpOrdersForPerformance(mode, baseline.trackingSince);
  return calculateScalpPerformance(
    mode,
    baseline.trackingSince,
    baseline.trackingVersion,
    orders,
  );
}

/** Reporting-only rolling funnel; the fill target never participates in entry. */
export async function getScalpWindowFunnel(
  mode: ScalpMode,
  windows = 12,
): Promise<ScalpWindowFunnelReport> {
  const rows = await getScalpWindowFunnelCounters(mode, windows);
  return buildScalpWindowFunnelReport(mode, rows);
}

/** Reporting-only shadow study; never participates in entry decisions. */
export async function getScalpShadowStudy(
  mode: ScalpMode,
  limit = 48,
  trackingSince: string | null = null,
): Promise<ScalpShadowStudyReport> {
  const scopeEnd = new Date();
  const [baseline, studyStartedAt] = await Promise.all([
    getScalpPerformanceBaseline(mode),
    getScalpShadowStudyStartedAt(mode),
  ]);
  const scope = resolveScalpShadowStudyScope({
    performanceTrackingSince: baseline.trackingSince,
    studyStartedAt,
    requestedTrackingSince: trackingSince,
    scopeEnd,
  });
  const effectiveWindowSecondsBySymbol = Object.fromEntries(
    CRYPTO_COINS
      .map((coin) => coin.symbol.toUpperCase())
      .filter((symbol) => Boolean(KALSHI_SERIES[symbol]))
      .map((symbol) => [
        symbol,
        resolveEffectiveParams(_config, symbol, "").finalWindowSeconds,
      ]),
  );
  const variantSeconds = resolveScalpShadowVariantSeconds({
    configuredWindowSeconds: _config.finalWindowSeconds,
    overrideWindowSeconds: _config.perMarketOverrides.map(
      (override) => override.windowSeconds,
    ),
  });
  const [variantReport, recentRows, performanceOrders] = await Promise.all([
    getScalpShadowStudyVariantSummaries(
      mode,
      scope.scopeStart,
      scope.scopeEnd,
      variantSeconds,
    ),
    getRecentScalpShadowStudies(
      mode,
      limit,
      scope.scopeStart,
      scope.scopeEnd,
      variantSeconds,
    ),
    getScalpOrdersForPerformance(mode, baseline.trackingSince),
  ]);
  const boundedPerformanceOrders = performanceOrders.filter(
    (order) => order.createdAt.getTime() <= scope.scopeEnd.getTime(),
  );
  const actualPerformance = calculateScalpPerformance(
    mode,
    scope.scopeStart,
    baseline.trackingVersion,
    boundedPerformanceOrders,
  );
  const actualComparison: ScalpShadowActualSummary = {
    periodStart: scope.scopeStart.toISOString(),
    periodEnd: scope.scopeEnd.toISOString(),
    filledOrders: actualPerformance.filledOrders,
    settled: actualPerformance.settled,
    wins: actualPerformance.wins,
    losses: actualPerformance.losses,
    winRate: actualPerformance.winRate,
    totalPnl: actualPerformance.totalPnl,
    totalSpent: actualPerformance.totalSpent,
  };
  let actualOutsideShadowCoverage: ScalpShadowActualSummary | null = null;
  if (
    studyStartedAt
    && baseline.trackingSince.getTime() < studyStartedAt.getTime()
  ) {
    const outsideOrders = boundedPerformanceOrders.filter(
      (order) => order.createdAt.getTime() < studyStartedAt.getTime(),
    );
    const outsidePerformance = calculateScalpPerformance(
      mode,
      baseline.trackingSince,
      baseline.trackingVersion,
      outsideOrders,
    );
    actualOutsideShadowCoverage = {
      periodStart: baseline.trackingSince.toISOString(),
      periodEnd: studyStartedAt.toISOString(),
      filledOrders: outsidePerformance.filledOrders,
      settled: outsidePerformance.settled,
      wins: outsidePerformance.wins,
      losses: outsidePerformance.losses,
      winRate: outsidePerformance.winRate,
      totalPnl: outsidePerformance.totalPnl,
      totalSpent: outsidePerformance.totalSpent,
    };
  }
  return buildScalpShadowStudyReport(mode, recentRows, {
    configuredWindowSeconds: _config.finalWindowSeconds,
    effectiveWindowSecondsBySymbol,
    trackingSince,
    variantSeconds,
    variantSummaries: variantReport.variants,
    recentRows,
    studyStartedAt: studyStartedAt?.toISOString() ?? null,
    scopeStart: scope.scopeStart.toISOString(),
    scopeEnd: scope.scopeEnd.toISOString(),
    actualComparison,
    actualOutsideShadowCoverage,
    comparisonCoverage: variantReport.coverage,
  });
}

export async function resetScalpPerformance(mode: ScalpMode): Promise<ScalpPerformance> {
  const window = await resetScalpPerformanceWindow(mode);
  return calculateScalpPerformance(
    mode,
    window.trackingSince,
    window.trackingVersion,
    window.orders,
  );
}

const SCALP_CALIBRATION_ANALYSIS_DAYS = 60;

function _scalpCalibrationSymbols(): string[] {
  return CRYPTO_COINS
    .map((coin) => coin.symbol.toUpperCase())
    .filter((symbol) => Boolean(KALSHI_SERIES[symbol]));
}

function _getScalpOverrideSnapshot(
  config: ScalpConfig,
  symbol: string,
): ScalpPerMarketOverride | null {
  const found = config.perMarketOverrides.find(
    (override) => override.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  return found ? { ...found, symbol: symbol.toUpperCase() } : null;
}

function _scalpOverrideEqual(
  left: ScalpPerMarketOverride | null,
  right: ScalpPerMarketOverride | null,
): boolean {
  if (left == null || right == null) return left === right;
  return left.symbol.toUpperCase() === right.symbol.toUpperCase()
    && left.paused === right.paused
    && left.minBand === right.minBand
    && left.maxBand === right.maxBand
    && left.windowSeconds === right.windowSeconds
    && left.budgetDollars === right.budgetDollars;
}

function _scalpCalibrationSettings(
  config: ScalpConfig,
  symbol: string,
): ScalpCalibrationSettings {
  const effective = resolveEffectiveParams(config, symbol, "");
  return {
    bandMin: effective.bandMin,
    bandMax: effective.bandMax,
    windowSeconds: effective.finalWindowSeconds,
    budgetDollars: effective.budgetDollars,
  };
}

function _replaceScalpOverride(
  config: ScalpConfig,
  symbol: string,
  replacement: ScalpPerMarketOverride | null,
): ScalpConfig {
  const normalized = symbol.toUpperCase();
  const remaining = config.perMarketOverrides.filter(
    (override) => override.symbol.toUpperCase() !== normalized,
  );
  return {
    ...config,
    perMarketOverrides: replacement == null
      ? remaining
      : [...remaining, { ...replacement, symbol: normalized }],
  };
}

function _operatorFingerprint(userId: string): string {
  return crypto.createHash("sha256").update(userId).digest("hex");
}

export class ScalpCalibrationConflictError extends Error {
  readonly code:
    | "not_found"
    | "not_applicable"
    | "already_decided"
    | "config_changed";

  constructor(
    code: ScalpCalibrationConflictError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ScalpCalibrationConflictError";
    this.code = code;
  }
}

function _buildScalpCalibrationReport(
  mode: ScalpMode,
  latest: ScalpCalibrationRecommendation[],
  activeApplications: ScalpCalibrationRecommendation[],
): ScalpCalibrationReport {
  return {
    mode,
    analysisDays: SCALP_CALIBRATION_ANALYSIS_DAYS,
    generatedAt: latest.reduce<string | null>(
      (newest, row) =>
        newest == null || row.createdAt > newest ? row.createdAt : newest,
      null,
    ),
    recommendations: latest,
    activeApplications,
  };
}

export async function getScalpCalibrationReport(
  mode: ScalpMode,
): Promise<ScalpCalibrationReport> {
  const [latest, active] = await Promise.all([
    getLatestScalpCalibrationRecommendations(mode),
    getActiveScalpCalibrationApplications(mode),
  ]);
  return _buildScalpCalibrationReport(
    mode,
    latest.map((row) => row.recommendation),
    active.map((row) => row.recommendation),
  );
}

export async function refreshScalpCalibration(
  mode: ScalpMode,
): Promise<ScalpCalibrationReport> {
  const evidenceCutoff = new Date().toISOString();
  const analysisStart = new Date(
    Date.parse(evidenceCutoff) - SCALP_CALIBRATION_ANALYSIS_DAYS * 86_400_000,
  ).toISOString();
  const createdAt = evidenceCutoff;
  const symbols = _scalpCalibrationSymbols();
  const evidence = await getScalpCalibrationEvidence(
    mode,
    analysisStart,
    evidenceCutoff,
    symbols,
  );
  const configSnapshot = getScalpConfig();
  const pending = symbols.map((symbol) => {
    const priorOverride = _getScalpOverrideSnapshot(configSnapshot, symbol);
    const recommendation = buildScalpCalibrationRecommendation({
      id: crypto.randomUUID(),
      mode,
      symbol,
      currentSettings: _scalpCalibrationSettings(configSnapshot, symbol),
      analysisStart,
      evidenceCutoff,
      createdAt,
      realOrders: evidence.realOrders,
      reservations: evidence.reservations,
      funnelEvents: evidence.funnelEvents,
      shadowRecords: evidence.shadowRecords,
    });
    const proposedOverride = buildScalpCalibrationTimingOverride(
      priorOverride,
      symbol,
      recommendation.proposedSettings.windowSeconds,
    );
    return { recommendation, priorOverride, proposedOverride };
  });
  const stored = await saveScalpCalibrationRecommendations(pending);
  const active = await getActiveScalpCalibrationApplications(mode);
  return _buildScalpCalibrationReport(
    mode,
    stored.map((row) => row.recommendation),
    active.map((row) => row.recommendation),
  );
}

async function _decideScalpCalibration(
  id: string,
  decision: "apply" | "revert",
  operatorUserId: string,
): Promise<{
  config: ScalpConfig;
  recommendation: ScalpCalibrationRecommendation;
}> {
  const stored = await getScalpCalibrationRecommendationById(id);
  if (!stored) {
    throw new ScalpCalibrationConflictError(
      "not_found",
      "This Scalper recommendation no longer exists.",
    );
  }
  const expectedStatus = decision === "apply" ? "recommended" : "applied";
  if (stored.recommendation.status !== expectedStatus) {
    throw new ScalpCalibrationConflictError(
      stored.recommendation.status === "no_change"
      || stored.recommendation.status === "insufficient_data"
        ? "not_applicable"
        : "already_decided",
      decision === "apply"
        ? "Only a current recommendation can be applied."
        : "Only an applied recommendation can be reverted.",
    );
  }

  let decided: ScalpCalibrationRecommendation | null = null;
  const symbol = stored.recommendation.symbol;
  const nextConfig = await _enqueueScalpConfigMutation(
    (current) => {
      const currentOverride = _getScalpOverrideSnapshot(current, symbol);
      const expectedOverride = decision === "apply"
        ? stored.priorOverride
        : stored.proposedOverride;
      if (!_scalpOverrideEqual(currentOverride, expectedOverride)) {
        throw new ScalpCalibrationConflictError(
          "config_changed",
          `${symbol} settings changed after this recommendation. Refresh the analysis before changing them.`,
        );
      }
      const expectedSettings = decision === "apply"
        ? stored.recommendation.currentSettings
        : stored.recommendation.proposedSettings;
      if (!scalpCalibrationSettingsEqual(
        _scalpCalibrationSettings(current, symbol),
        expectedSettings,
      )) {
        throw new ScalpCalibrationConflictError(
          "config_changed",
          `${symbol} effective settings changed after this recommendation. Refresh the analysis first.`,
        );
      }
      return _replaceScalpOverride(
        current,
        symbol,
        decision === "apply"
          ? stored.proposedOverride
          : stored.priorOverride,
      );
    },
    true,
    async (next, current) => {
      try {
        const result = await persistScalpCalibrationDecision({
          id,
          expectedStatus,
          nextStatus: decision === "apply" ? "applied" : "reverted",
          expectedConfig: current,
          nextConfig: next,
          operatorFingerprint: _operatorFingerprint(operatorUserId),
        });
        decided = result.recommendation;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "calibration_not_found") {
          throw new ScalpCalibrationConflictError(
            "not_found",
            "This Scalper recommendation no longer exists.",
          );
        }
        if (
          message.startsWith("calibration_status_conflict")
          || message === "calibration_config_conflict"
        ) {
          throw new ScalpCalibrationConflictError(
            message === "calibration_config_conflict"
              ? "config_changed"
              : "already_decided",
            "The recommendation or Scalper settings changed while this request was being processed.",
          );
        }
        throw error;
      }
    },
  );
  if (!decided) {
    throw new Error("Scalper calibration decision was not persisted");
  }
  return { config: nextConfig, recommendation: decided };
}

export async function applyScalpCalibrationRecommendation(
  id: string,
  operatorUserId: string,
) {
  return _decideScalpCalibration(id, "apply", operatorUserId);
}

export async function revertScalpCalibrationRecommendation(
  id: string,
  operatorUserId: string,
) {
  return _decideScalpCalibration(id, "revert", operatorUserId);
}

// Re-export the unresolved query for route/reconciliation display.
export async function getUnresolvedLiveScalpAttempts() {
  return getUnresolvedLiveAttempts();
}

export async function applyScalpConfigUpdate(patch: ScalpConfigPatch): Promise<ScalpConfig> {
  return updateScalpConfig(patch);
}

const LIVE_SCALP_ATTEMPT_RUNTIME: ScalpAttemptRuntime = {
  nowMs: Date.now,
  currentWindowKey,
  fetchKalshiTarget,
  fetchOrderbookPrices,
  collectPriceSample: _collectPriceSample,
  getBalance,
  getKalshiCachedData,
  updateReservationStatus,
  insertScalpOrderIntent,
  finalizePaperOrderAndReleaseReservation,
  abortIntentAndReleaseReservation,
  placeScalpOrderStrict,
  finalizeOrderAndReleaseReservation,
  finalRiskValidationSync: _finalRiskValidationSync,
  regularPositionCompatibilitySync: _regularPositionCompatibilitySync,
  recordFunnelEvent: _recordScalpFunnelEvent,
};

export interface ControlledScalperLayeringExerciseResult {
  liveBoundaryConflict: {
    compatibilityChecks: number;
    intentWrites: number;
    brokerSubmissions: number;
    aborts: number;
    abortReason: string | null;
    conflictEvidence: ScalpSkipEvidence | null;
  };
  paperPersistenceFailure: {
    persistenceCalls: number;
    standaloneIntentWrites: number;
    standaloneReservationUpdates: number;
    surfacedError: string | null;
    layeredRegularPositionId: string | null;
    layeredRegularSide: "yes" | "no" | null;
  };
}

async function _runControlledLayeringScenario(
  mode: ScalpMode,
  paperPersistenceFails: boolean,
): Promise<ControlledScalperLayeringExerciseResult["liveBoundaryConflict"] | ControlledScalperLayeringExerciseResult["paperPersistenceFailure"]> {
  const originalConfig = _config;
  const windowKey = "2026-08-22T07:00";
  const ticker = "KXBTC15M-26AUG220700-15";
  const closeTime = "2026-08-22T07:15:00.000Z";
  const nowMs = Date.parse("2026-08-22T07:14:30.000Z");
  const attemptKey = _attemptKey(mode, "BTC", windowKey);
  let compatibilityChecks = 0;
  let intentWrites = 0;
  let brokerSubmissions = 0;
  let aborts = 0;
  let abortReason: string | null = null;
  let conflictEvidence: ScalpSkipEvidence | null = null;
  let persistenceCalls = 0;
  let standaloneReservationUpdates = 0;
  let persistedPaperOrder: ScalpOrder | null = null;

  _config = {
    ...DEFAULT_SCALP_CONFIG,
    enabled: true,
    mode,
    globalBandMin: 0.96,
    globalBandMax: 0.99,
    finalWindowSeconds: 60,
    budgetDollars: 2,
    freefallGuardEnabled: false,
    targetProximityGuardEnabled: false,
    circuitBreakerEnabled: true,
    circuitBreaker: false,
    circuitBreakerReason: null,
    perMarketOverrides: [],
  };
  const params = resolveEffectiveParams(_config, "BTC", ticker);
  const snapshot = buildExecutionRiskSnapshot(
    _config,
    params,
    { symbol: "BTC", windowKey, ticker, closeTime },
  );
  const candidate: Candidate = {
    symbol: "BTC",
    ticker,
    closeTime,
    detectedAtMs: nowMs,
    cachedYesAsk: 0.97,
    cachedNoAsk: 0.98,
    side: "yes",
    winningAsk: 0.97,
  };
  const samePosition: RegularPositionForScalperLayering = {
    id: "regular-position-same",
    symbol: "BTC",
    windowKey,
    ticker,
    direction: "yes",
    entryMode: mode,
  };
  const oppositePosition: RegularPositionForScalperLayering = {
    ...samePosition,
    id: "regular-position-opposite",
    direction: "no",
  };

  const runtime: ScalpAttemptRuntime = {
    nowMs: () => nowMs,
    currentWindowKey: () => windowKey,
    fetchKalshiTarget: async () => 100,
    fetchOrderbookPrices: async () => ({
      yesAsk: 0.97,
      yesBid: 0.02,
      yesDepth: [[0.02, 100]],
      noDepth: [[0.03, 100]],
    }),
    collectPriceSample: async () => true,
    getBalance: async () => ({ availableBalance: 100, totalBalance: 100 }),
    getKalshiCachedData: () => ({
      value: 100,
      ticker,
      closeTime,
      yesAsk: 0.97,
      yesBid: 0.02,
      noAsk: 0.98,
    }),
    updateReservationStatus: async () => {
      standaloneReservationUpdates += 1;
    },
    insertScalpOrderIntent: async () => {
      intentWrites += 1;
    },
    finalizePaperOrderAndReleaseReservation: async (order) => {
      persistenceCalls += 1;
      persistedPaperOrder = order;
      if (paperPersistenceFails) throw new Error("controlled_paper_persistence_failure");
    },
    abortIntentAndReleaseReservation: async (args) => {
      aborts += 1;
      abortReason = args.reason;
      conflictEvidence = args.skipEvidence ?? null;
    },
    placeScalpOrderStrict: async () => {
      brokerSubmissions += 1;
      return {
        outcome: "confirmed_fill",
        reason: "controlled_fill",
        orderId: "controlled-order",
        filledCount: 2,
        avgFillPrice: 0.97,
      };
    },
    finalizeOrderAndReleaseReservation: async () => {},
    finalRiskValidationSync: () => null,
    regularPositionCompatibilitySync: (_mode, _symbol, _windowKey, _ticker, side) => {
      compatibilityChecks += 1;
      const position =
        mode === "live" && compatibilityChecks >= 3
          ? oppositePosition
          : samePosition;
      return evaluateRegularPositionCompatibility(position, {
        mode,
        symbol: "BTC",
        windowKey,
        ticker,
        side: "yes",
      });
    },
  };

  _terminalAttemptKeys.delete(attemptKey);
  _nextAttemptAt.delete(attemptKey);
  let surfacedError: string | null = null;
  try {
    await _executeScalpAttempt(
      `controlled-layer-${mode}`,
      candidate,
      windowKey,
      mode,
      snapshot,
      0,
      attemptKey,
      runtime,
    );
  } catch (err) {
    surfacedError = String(err);
  } finally {
    _config = originalConfig;
    _terminalAttemptKeys.delete(attemptKey);
    _nextAttemptAt.delete(attemptKey);
  }

  if (mode === "live") {
    return {
      compatibilityChecks,
      intentWrites,
      brokerSubmissions,
      aborts,
      abortReason,
      conflictEvidence,
    };
  }
  return {
    persistenceCalls,
    standaloneIntentWrites: intentWrites,
    standaloneReservationUpdates,
    surfacedError,
    layeredRegularPositionId: persistedPaperOrder?.layeredRegularPositionId ?? null,
    layeredRegularSide: persistedPaperOrder?.layeredRegularSide ?? null,
  };
}

export async function runControlledScalperLayeringExercise(): Promise<ControlledScalperLayeringExerciseResult> {
  const liveBoundaryConflict = await _runControlledLayeringScenario("live", false);
  const paperPersistenceFailure = await _runControlledLayeringScenario("paper", true);
  return {
    liveBoundaryConflict: liveBoundaryConflict as ControlledScalperLayeringExerciseResult["liveBoundaryConflict"],
    paperPersistenceFailure: paperPersistenceFailure as ControlledScalperLayeringExerciseResult["paperPersistenceFailure"],
  };
}

/**
 * Controlled live-window proof that executes the real `_executeScalpAttempt`
 * reservation-to-submit path with in-memory DB/exchange boundaries.
 *
 * It can never reach the network or persistent database: every external sink
 * used by the attempt is replaced locally, while the production guard,
 * reservation retry state, sizing, intent ordering, and submit ordering remain
 * unchanged. This is intentionally exported only for the bundled integration
 * test; runtime application code never calls it.
 */
export async function runControlledFreefallServiceExercise(
  options: ControlledFreefallServiceExerciseOptions = {},
):
Promise<ControlledFreefallServiceExerciseResult> {
  const originalConfig = _config;
  const mode = options.mode ?? "live";
  const side = options.side ?? "yes";
  const symbol = "BTC";
  const ticker = "CONTROLLED-FREEFALL-BTC";
  const windowOpenMs = Date.UTC(2026, 7, 22, 7, 0, 0);
  const windowKey = "2026-08-22T07:00";
  const closeTime = new Date(windowOpenMs + 15 * 60_000).toISOString();
  const attemptKey = _attemptKey(mode, symbol, windowKey);
  const originalSamples = _priceSamples.get(symbol);
  const originalNextAttemptAt = _nextAttemptAt.get(attemptKey);
  const wasTerminal = _terminalAttemptKeys.has(attemptKey);
  let nowMs = windowOpenMs + 15 * 60_000
    - (options.startSecondsRemaining ?? 40) * 1_000;
  let freshSampleSucceeded = true;
  let currentSamples: FreefallSample[] = [];
  let intentWrites = 0;
  let brokerSubmissions = 0;
  let paperSubmissions = 0;
  let quoteFetches = 0;
  let underlyingSampleFetches = 0;
  const submittedLimitPrices: number[] = [];
  const submittedCounts: number[] = [];
  let submittedEntryEvidence: ScalpEntryGuardEvidence | null = null;
  const submittedEntryEvidences: ScalpEntryGuardEvidence[] = [];
  const abortedBeforeSubmitReasons: string[] = [];
  const abortedBeforeSubmitEvidences: ScalpSkipEvidence[] = [];
  const skippedAttempts: ControlledFreefallServiceExerciseResult["skippedAttempts"] = [];
  const steps: ControlledFreefallServiceExerciseResult["steps"] = [];

  const coveredSamples = (prices: number[], newestAgeMs = 0): FreefallSample[] => {
    const newestAt = nowMs - newestAgeMs;
    const oldestAt = newestAt - (prices.length - 1) * 1_000;
    return prices.map((price, index) => ({
      price,
      at: oldestAt + index * 1_000,
    }));
  };
  const setLatestControlledPrice = (price: number): void => {
    const samples = _priceSamples.get(symbol) ?? currentSamples;
    const next = samples.length > 0
      ? [...samples.slice(0, -1), { price, at: nowMs }]
      : [{ price, at: nowMs }];
    currentSamples = next;
    _priceSamples.set(symbol, next);
  };

  _config = {
    ...DEFAULT_SCALP_CONFIG,
    enabled: true,
    mode,
    globalBandMin: 0.96,
    globalBandMax: 0.99,
    finalWindowSeconds: 60,
    budgetDollars: 2,
    freefallGuardEnabled: true,
    freefallConsecutiveSeconds: 4,
    coordinatedDirectionClearanceEnabled:
      options.coordinatedDirectionClearanceEnabled ?? false,
    freefallLookbackSeconds: 30,
    freefallThresholdPct: 0.5,
    rapidMoveGuardEnabled: false,
    rapidMoveLookbackSeconds: 4,
    rapidMoveThresholdPct: 0.5,
    targetProximityGuardEnabled: options.targetProximityGuardEnabled ?? false,
    targetProximityThresholdPct: 0.05,
    circuitBreakerEnabled: true,
    circuitBreaker: false,
    circuitBreakerReason: null,
    perMarketOverrides: [],
  };
  const params = resolveEffectiveParams(_config, symbol, ticker);
  const snapshot = buildExecutionRiskSnapshot(
    _config,
    params,
    { symbol, windowKey, ticker, closeTime },
  );
  const candidate: Candidate = {
    symbol,
    ticker,
    closeTime,
    detectedAtMs: nowMs,
    cachedYesAsk: side === "yes" ? 0.97 : 0.03,
    cachedNoAsk: 0.98,
    side,
    winningAsk: side === "yes" ? 0.97 : 0.98,
  };

  const runtime: ScalpAttemptRuntime = {
    nowMs: () => nowMs,
    currentWindowKey: () =>
      options.windowChangesAfterQuoteFetchCount != null
      && quoteFetches >= options.windowChangesAfterQuoteFetchCount
        ? "2026-08-22T07:15"
        : windowKey,
    fetchKalshiTarget: async () => 100,
    fetchOrderbookPrices: async () => {
      const sequence = options.authenticatedQuoteSequence;
      const configured = sequence != null && sequence.length > 0
        ? sequence[quoteFetches] ?? sequence[sequence.length - 1]
        : undefined;
      quoteFetches += 1;
      nowMs += options.quoteFetchAdvanceMs ?? 0;
      return {
        yesAsk: configured ? configured.yesAsk : side === "yes" ? 0.97 : 0.03,
        yesBid: configured ? configured.yesBid : 0.02,
        yesDepth: [[0.02, 100]],
        noDepth: [[0.03, 100]],
      };
    },
    collectPriceSample: async () => {
      const fetchIndex = underlyingSampleFetches;
      underlyingSampleFetches += 1;
      const succeeded =
        options.underlyingSampleSuccessSequence?.[fetchIndex]
        ?? freshSampleSucceeded;
      const controlledPrice = options.underlyingPriceSequence?.[fetchIndex];
      if (succeeded && controlledPrice != null) {
        setLatestControlledPrice(controlledPrice);
      }
      return succeeded;
    },
    getBalance: async () => ({ availableBalance: 100, totalBalance: 100 }),
    getKalshiCachedData: () => ({
      value: 100,
      ticker,
      closeTime,
      yesAsk: side === "yes" ? 0.97 : 0.03,
      yesBid: 0.02,
      noAsk: 0.98,
    }),
    updateReservationStatus: async (_mode, _symbol, _windowKey, status, reason, _release, evidence) => {
      if (status !== "skipped") return;
      skippedAttempts.push({
        reason: reason ?? "unknown_skip",
        skippedAt: evidence?.skippedAt ?? null,
        evidence: evidence ?? null,
      });
    },
    insertScalpOrderIntent: async (order) => {
      intentWrites += 1;
      submittedEntryEvidence = order.entryGuardEvidence ?? null;
      if (order.entryGuardEvidence != null) {
        submittedEntryEvidences.push(order.entryGuardEvidence);
      }
      nowMs += options.intentWriteAdvanceMs ?? 0;
      if (options.intentWriteUnderlyingPrice != null) {
        setLatestControlledPrice(options.intentWriteUnderlyingPrice);
      }
    },
    finalizePaperOrderAndReleaseReservation: async (order) => {
      paperSubmissions += 1;
      submittedEntryEvidence = order.entryGuardEvidence ?? null;
      if (order.entryGuardEvidence != null) {
        submittedEntryEvidences.push(order.entryGuardEvidence);
      }
    },
    abortIntentAndReleaseReservation: async (args) => {
      abortedBeforeSubmitReasons.push(args.reason);
      if (args.skipEvidence != null) {
        abortedBeforeSubmitEvidences.push(args.skipEvidence);
      }
    },
    placeScalpOrderStrict: async (order) => {
      brokerSubmissions += 1;
      submittedLimitPrices.push(order.limitPrice);
      submittedCounts.push(order.count);
      return {
        outcome: "zero_fill",
        reason: "controlled_zero_fill",
        orderId: "controlled-order",
        filledCount: 0,
        avgFillPrice: null,
      };
    },
    finalizeOrderAndReleaseReservation: async (params) => {
      if (params.entryGuardEvidence != null) {
        submittedEntryEvidence = params.entryGuardEvidence;
        if (submittedEntryEvidences.length === 0) {
          submittedEntryEvidences.push(params.entryGuardEvidence);
        } else {
          submittedEntryEvidences[submittedEntryEvidences.length - 1] =
            params.entryGuardEvidence;
        }
      }
    },
    finalRiskValidationSync: () =>
      options.windowChangesAfterQuoteFetchCount != null
      && quoteFetches >= options.windowChangesAfterQuoteFetchCount
        ? "window_expired_before_submit"
        : null,
    regularPositionCompatibilitySync: () => ({ status: "none", position: null }),
  };

  const runStep = async (
    label: ControlledFreefallServiceExerciseResult["steps"][number]["label"],
    samples: FreefallSample[],
    fresh: boolean,
  ): Promise<void> => {
    const retryAt = _nextAttemptAt.get(attemptKey) ?? 0;
    if (retryAt > nowMs) {
      steps.push({
        label,
        state: "cooldown",
        reason: null,
        checkedAt: new Date(nowMs).toISOString(),
        retryAfterMs: retryAt - nowMs,
        intentWrites,
        brokerSubmissions,
        paperSubmissions,
      });
      return;
    }

    currentSamples = samples;
    freshSampleSucceeded = fresh;
    _priceSamples.set(symbol, currentSamples);
    const previousSkipCount = skippedAttempts.length;
    const previousSubmissions = brokerSubmissions;
    const previousPaperSubmissions = paperSubmissions;
    await _executeScalpAttempt(
      `controlled-reservation-${label}`,
      candidate,
      windowKey,
      mode,
      snapshot,
      0,
      attemptKey,
      runtime,
    );
    const skip = skippedAttempts.length > previousSkipCount
      ? skippedAttempts[skippedAttempts.length - 1]
      : null;
    steps.push({
      label,
      state:
        brokerSubmissions > previousSubmissions
        || paperSubmissions > previousPaperSubmissions
          ? "submitted"
          : "skipped",
      reason: skip?.reason ?? null,
      checkedAt: skip?.skippedAt ?? new Date(nowMs).toISOString(),
      retryAfterMs: skip ? Math.max(0, (_nextAttemptAt.get(attemptKey) ?? nowMs) - nowMs) : null,
      intentWrites,
      brokerSubmissions,
      paperSubmissions,
    });
  };

  _nextAttemptAt.delete(attemptKey);
  _terminalAttemptKeys.delete(attemptKey);
  try {
    const adversePrices = options.adversePrices ?? (side === "yes"
      ? [105, 104, 103, 103.5, 102]
      : [95, 96, 97, 96.5, 98]);
    const favorablePrices = side === "yes"
      ? [101, 102, 103, 104, 105]
      : [99, 98, 97, 96, 95];
    const targetCrossingPrices = side === "yes"
      ? [99, 101, 102, 103, 104]
      : [101, 99, 98, 97, 96];
    const retryPrices = side === "yes"
      ? [106, 107, 108, 109, 110]
      : [94, 93, 92, 91, 90];

    if (!options.onlyRecoveredStep) {
      await runStep("adverse", coveredSamples(adversePrices), true);
      nowMs += SCALP_GUARD_RETRY_COOLDOWN_MS - 1;
      await runStep("adverse_cooldown", coveredSamples(favorablePrices), true);

      nowMs += 1;
      await runStep("fetch_failed", coveredSamples(favorablePrices), false);
      nowMs += 250;
      await runStep("fetch_cooldown", coveredSamples(favorablePrices), true);

      nowMs += SCALP_GUARD_RETRY_COOLDOWN_MS - 250;
      await runStep("stale", coveredSamples(favorablePrices, 6_000), true);
      nowMs += SCALP_GUARD_RETRY_COOLDOWN_MS - 1;
      await runStep("stale_cooldown", coveredSamples(favorablePrices), true);

      nowMs += 1;
      await runStep("target_crossing", coveredSamples(targetCrossingPrices), true);
      nowMs += SCALP_GUARD_RETRY_COOLDOWN_MS;
    }
    await runStep("recovered", coveredSamples(favorablePrices), true);
    if (options.runSecondSubmission) {
      nowMs += SCALP_AUTH_RETRY_COOLDOWN_MS;
      await runStep("recovered_retry", coveredSamples(retryPrices), true);
    }

    return {
      steps,
      skippedAttempts,
      submittedEntryEvidence,
      submittedEntryEvidences,
      abortedBeforeSubmitReasons,
      abortedBeforeSubmitEvidences,
      intentWrites,
      brokerSubmissions,
      paperSubmissions,
      quoteFetches,
      submittedLimitPrices,
      submittedCounts,
    };
  } finally {
    _config = originalConfig;
    if (originalSamples === undefined) _priceSamples.delete(symbol);
    else _priceSamples.set(symbol, originalSamples);
    if (originalNextAttemptAt === undefined) _nextAttemptAt.delete(attemptKey);
    else _nextAttemptAt.set(attemptKey, originalNextAttemptAt);
    if (wasTerminal) _terminalAttemptKeys.add(attemptKey);
    else _terminalAttemptKeys.delete(attemptKey);
  }
}

/**
 * In-memory contention proof for the production sample queue. No network or DB
 * calls are possible: the underlying-price boundary is temporarily replaced by
 * deferred local promises and restored before returning.
 */
export async function runControlledSampleSchedulerExercise():
Promise<ControlledSampleSchedulerExerciseResult> {
  if (
    _activePriceSampleFetches !== 0
    || _authoritativeSampleQueue.length !== 0
    || _backgroundSampleQueue.length !== 0
  ) {
    throw new Error("sample scheduler exercise requires an idle queue");
  }

  const originalFetcher = _fetchScalpUnderlyingPrice;
  const products = ["CTRL-BG-1", "CTRL-BG-2", "CTRL-BG-3", "CTRL-AUTH"];
  const symbols = products.map((product) => product.replaceAll("-", ""));
  const releases = new Map<string, () => void>();
  const startOrder: string[] = [];
  const promises: Promise<boolean>[] = [];
  let maxActiveObserved = 0;
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

  _fetchScalpUnderlyingPrice = async (product: string) => {
    startOrder.push(product);
    maxActiveObserved = Math.max(maxActiveObserved, _activePriceSampleFetches);
    return new Promise<number>((resolve) => {
      releases.set(product, () => resolve(100));
    });
  };

  try {
    promises.push(
      _collectPriceSample(symbols[0]!, products[0]!, "background"),
      _collectPriceSample(symbols[1]!, products[1]!, "background"),
      _collectPriceSample(symbols[2]!, products[2]!, "background"),
    );
    await nextTurn();
    const backgroundStartedBeforeAuthoritative = [...startOrder];

    promises.push(_collectPriceSample(symbols[3]!, products[3]!, "authoritative"));
    await nextTurn();
    const authoritativeStartedBeforeBackgroundRelease = startOrder.includes("CTRL-AUTH");

    releases.get("CTRL-AUTH")?.();
    await nextTurn();
    releases.get("CTRL-BG-1")?.();
    releases.get("CTRL-BG-2")?.();
    await nextTurn();
    releases.get("CTRL-BG-3")?.();
    await Promise.all(promises);

    return {
      backgroundStartedBeforeAuthoritative,
      authoritativeStartedBeforeBackgroundRelease,
      startOrder: [...startOrder],
      maxActiveObserved,
    };
  } finally {
    for (const release of releases.values()) release();
    await Promise.allSettled(promises);
    _fetchScalpUnderlyingPrice = originalFetcher;
    for (const symbol of symbols) {
      _priceSamples.delete(symbol);
      _priceSampleJobs.delete(symbol);
    }
    for (const queue of [_authoritativeSampleQueue, _backgroundSampleQueue]) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (symbols.includes(queue[index]!.symbol)) queue.splice(index, 1);
      }
    }
  }
}
