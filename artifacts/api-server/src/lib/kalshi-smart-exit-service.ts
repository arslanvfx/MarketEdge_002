import { randomUUID } from "node:crypto";
import { logger } from "./logger.ts";
import { CRYPTO_COINS } from "./market-defs.ts";
import {
  fetchOrderbookPrices,
  getKalshiCachedData,
  type OrderbookPrices,
} from "./crypto-kalshi.ts";
import { openPositions, type OpenPosition } from "./kalshi-bot-state.ts";
import {
  DEFAULT_SMART_EXIT_CONFIG,
  INITIAL_SMART_EXIT_STATE,
  evaluateSmartExit,
  modelWinProbability,
  resolveSmartExitSensitivity,
} from "./kalshi-smart-exit-policy.ts";
import { KalshiSmartExitEvidenceCollector } from "./kalshi-smart-exit-evidence.ts";
import {
  applyValidatedSmartExitParameterVersion,
  claimSmartExitRequest,
  deleteSmartExitHistory,
  getValidatedSmartExitParameterReport,
  getSmartExitReplayReportByIdentity,
  getSmartExitLifecycle,
  getSmartExitEvaluationsByIds,
  insertSmartExitEvaluation,
  insertSmartExitEvidence,
  insertSmartExitReplayReport,
  insertSmartExitRecoveryStudy,
  listLatestSmartExitEvaluationsPerPosition,
  listSmartExitCoverageEvaluations,
  listOpenScalperPositions,
  listSmartExitPositionStates,
  listSmartExitEvaluations,
  listSmartExitReplayReports,
  listSmartExitReplaySources,
  listSmartExitLifecycles,
  listUnsettledSmartExitLifecycles,
  loadSmartExitConfig,
  markSmartExitRequestUnknown,
  resolveSmartExitRequest,
  runSmartExitMigrations,
  saveSmartExitConfig,
  upsertSmartExitPositionState,
  upsertSmartExitLifecycle,
  type SmartExitHistoryDeleteCounts,
} from "./kalshi-smart-exit-db.ts";
import {
  buildCrossingRiskReplayLifecycles,
  calibrateSmartExit,
  summarizeSmartExitComparison,
} from "./kalshi-smart-exit-replay.ts";
import { fetchKalshiMarketResult } from "./kalshi-trader.ts";
import {
  requestSmartExitFromOwner,
} from "./kalshi-smart-exit-owners.ts";
import {
  combineSmartExitExecutionConstraints,
  type SmartExitExecutionConstraint,
} from "./kalshi-smart-exit-execution.ts";
import {
  authorizeSmartExitExecution,
  hasCompleteSmartExitParameterSnapshot,
  smartExitVersionKey,
} from "./kalshi-smart-exit-execution.ts";
import type {
  SmartExitAppliedVersion,
  SmartExitConfig,
  SmartExitEvaluationRecord,
  SmartExitEvidence,
  SmartExitHealth,
  SmartExitMode,
  SmartExitOwnerKind,
  SmartExitPosition,
  SmartExitLifecycleRecord,
  SmartExitCoverageRecord,
  SmartExitState,
} from "./kalshi-smart-exit-types.ts";

import {
  computeSmartExitEffectivenessFromProceeds,
  getSmartExitShadowProceeds,
  isSmartExitCounterfactualScoreable,
  normalizeSmartExitComponentHealth,
  smartExitModeIncludesPosition,
} from "./kalshi-smart-exit-types.ts";

interface SmartExitLifecycleAccounting {
  readonly triggered: number;
  readonly settled: number;
  readonly scoreable: number;
  readonly pending: number;
  readonly helped: number;
  readonly harmed: number;
  readonly grossMoneySaved: number;
  readonly grossMoneyForfeited: number;
  readonly netValue: number;
}

const HOT_SCHEDULER_MS = 500;
const SLOW_SCHEDULER_MS = 1_000;
const EVALUATION_PERSISTENCE_MS = 1_000;
const PRODUCT_BY_SYMBOL = new Map(CRYPTO_COINS.map((coin) => [coin.symbol, coin]));
const collector = new KalshiSmartExitEvidenceCollector();
const hotCollector = new KalshiSmartExitEvidenceCollector();
type BookSnapshot = OrderbookPrices & { receivedAtSeconds: number };

let config: SmartExitConfig = { ...DEFAULT_SMART_EXIT_CONFIG };
let interval: ReturnType<typeof setInterval> | null = null;
let hotInterval: ReturnType<typeof setInterval> | null = null;
let cycleInFlight = false;
let hotCycleInFlight = false;
let lastCycleAt: string | null = null;
let lastHotCycleAt: string | null = null;
let lastError: string | null = null;
let lastCycleDurationMs: number | null = null;
let lastHotCycleDurationMs: number | null = null;
let schedulerOverruns = 0;
let hotSchedulerOverruns = 0;
let maximumUsableSampleGapMs: number | null = null;
let prewarmCursor = 0;
let lifecycleReconcileInterval: ReturnType<typeof setInterval> | null = null;
const states = new Map<string, SmartExitState>();
const modelEntryBaselines = new Map<string, number | null>();
const latestEvaluations = new Map<string, SmartExitEvaluationRecord>();
const latestValidEvaluations = new Map<string, SmartExitEvaluationRecord>();
const lastEvidencePersistenceMs = new Map<string, number>();
const lastEvaluationPersistenceMs = new Map<string, number>();
const bookSnapshots = new Map<string, BookSnapshot>();
const bookRefreshes = new Map<string, Promise<void>>();
const hotSpotCollections = new Map<string, Promise<SmartExitEvidence>>();
const slowEvidenceCollections = new Map<string, Promise<SmartExitEvidence>>();
let cachedScalperPositions: Array<Record<string, unknown>> = [];
const evaluationPending = new Map<string, {
  position: SmartExitPosition;
  evidence: SmartExitEvidence;
}>();
const evaluationRunning = new Set<string>();
const lastScheduledSpotEventSeconds = new Map<string, number>();
const lastUsableSpotReceiptMs = new Map<string, number>();
type PersistenceItem = {
  position: SmartExitPosition;
  evidence: SmartExitEvidence;
  state: SmartExitState;
  record: SmartExitEvaluationRecord;
  notBeforeMs: number;
  completionResolvers: Array<() => void>;
};
const persistenceQueue = new Map<string, PersistenceItem>();
let persistenceWorkerRunning = false;
let persistenceWakeTimer: ReturnType<typeof setTimeout> | null = null;
let persistenceWakeAtMs: number | null = null;
const PREWARMABLE_COINS = CRYPTO_COINS.filter((coin) => coin.category !== "commodity");

function identityKey(owner: SmartExitOwnerKind, positionId: string): string {
  return `${owner}:${positionId}`;
}

function windowExpirySeconds(windowKey: string): number {
  const start = Date.parse(`${windowKey}:00Z`);
  return Number.isFinite(start) ? (start + 15 * 60_000) / 1_000 : 0;
}

function marketProbabilityForSide(
  side: "yes" | "no",
  yesProbability: number | null | undefined,
): number | null {
  return yesProbability != null && Number.isFinite(yesProbability)
    ? side === "yes" ? yesProbability : 1 - yesProbability
    : null;
}

function exactMarket(
  symbol: string,
  ticker: string,
  windowKey: string,
): ReturnType<typeof getKalshiCachedData> {
  const current = getKalshiCachedData(symbol);
  if (!current || current.ticker !== ticker) return null;
  const expiry = current.closeTime ? Date.parse(current.closeTime) : NaN;
  const expected = windowExpirySeconds(windowKey) * 1_000;
  if (Number.isFinite(expiry) && expected > 0 && Math.abs(expiry - expected) > 5_000) return null;
  return current;
}

async function refreshBook(ticker: string): Promise<void> {
  if (!ticker) return;
  const existing = bookRefreshes.get(ticker);
  if (existing) return existing;
  const refresh = fetchOrderbookPrices(ticker)
    .then((book) => {
      if (book) bookSnapshots.set(ticker, { ...book, receivedAtSeconds: Date.now() / 1_000 });
    })
    .catch((error) => logger.warn({ error, ticker }, "[kalshi-smart-exit] Kalshi book refresh failed"))
    .finally(() => bookRefreshes.delete(ticker));
  bookRefreshes.set(ticker, refresh);
  return refresh;
}

function requestBookRefresh(ticker: string): void {
  void refreshBook(ticker);
}

function mergeHotSpotWithSlowEvidence(
  symbol: string,
  hot: SmartExitEvidence,
): SmartExitEvidence {
  const slow = collector.latest(symbol);
  if (!slow) return hot;
  const nowSeconds = hot.observedAtSeconds;
  const slowSpotFresh = slow.spotReceivedAtSeconds != null
    && slow.spotObservedAtSeconds != null
    && nowSeconds - slow.spotReceivedAtSeconds >= 0
    && nowSeconds - slow.spotReceivedAtSeconds <= config.maxEvidenceAgeSeconds
    && nowSeconds - slow.spotObservedAtSeconds >= 0
    && nowSeconds - slow.spotObservedAtSeconds <= config.maxEvidenceAgeSeconds;
  const slowTapeFresh = slow.tapeReceivedAtSeconds != null
    && slow.tapeObservedAtSeconds != null
    && nowSeconds - slow.tapeReceivedAtSeconds >= 0
    && nowSeconds - slow.tapeReceivedAtSeconds <= config.maxEvidenceAgeSeconds
    && nowSeconds - slow.tapeObservedAtSeconds >= 0
    && nowSeconds - slow.tapeObservedAtSeconds <= config.maxEvidenceAgeSeconds;
  const slowBookFresh = slow.bookReceivedAtSeconds != null
    && slow.bookObservedAtSeconds != null
    && nowSeconds - slow.bookReceivedAtSeconds >= 0
    && nowSeconds - slow.bookReceivedAtSeconds <= config.maxEvidenceAgeSeconds
    && nowSeconds - slow.bookObservedAtSeconds >= 0
    && nowSeconds - slow.bookObservedAtSeconds <= config.maxEvidenceAgeSeconds;
  const useHotMomentum = hot.momentumLogReturn != null && hot.momentumWindowSeconds != null;
  return {
    ...slow,
    underlyingPrice: hot.underlyingPrice,
    spotReceivedAtSeconds: hot.spotReceivedAtSeconds,
    spotObservedAtSeconds: hot.spotObservedAtSeconds,
    observedAtSeconds: hot.observedAtSeconds,
    volatilityLogReturnPerSqrtSecond:
      hot.volatilityLogReturnPerSqrtSecond
        ?? (slowSpotFresh ? slow.volatilityLogReturnPerSqrtSecond : null),
    momentumLogReturn: useHotMomentum
      ? hot.momentumLogReturn
      : slowSpotFresh ? slow.momentumLogReturn : null,
    momentumWindowSeconds: useHotMomentum
      ? hot.momentumWindowSeconds
      : slowSpotFresh ? slow.momentumWindowSeconds : null,
    tapeReceivedAtSeconds: slowTapeFresh ? slow.tapeReceivedAtSeconds : null,
    tapeObservedAtSeconds: slowTapeFresh ? slow.tapeObservedAtSeconds : null,
    tradeFlowImbalance: slowTapeFresh ? slow.tradeFlowImbalance : null,
    bookReceivedAtSeconds: slowBookFresh ? slow.bookReceivedAtSeconds : null,
    bookObservedAtSeconds: slowBookFresh ? slow.bookObservedAtSeconds : null,
    bookImbalance: slowBookFresh ? slow.bookImbalance : null,
  };
}

function collectHotSpot(
  symbol: string,
  product: string,
): Promise<SmartExitEvidence> {
  const existing = hotSpotCollections.get(symbol);
  if (existing) return existing;
  const request = hotCollector.collectSpot(symbol, product, null)
    .finally(() => hotSpotCollections.delete(symbol));
  hotSpotCollections.set(symbol, request);
  return request;
}

function collectSlowEvidence(
  symbol: string,
  product: string,
): Promise<SmartExitEvidence> {
  const existing = slowEvidenceCollections.get(symbol);
  if (existing) return existing;
  const request = collector.collect(symbol, product, null)
    .finally(() => slowEvidenceCollections.delete(symbol));
  slowEvidenceCollections.set(symbol, request);
  return request;
}

function executableFromDepth(
  depth: readonly [number, number][],
  quantity: number,
): { price: number | null; quantity: number } {
  if (quantity <= 0 || depth.length === 0) return { price: null, quantity: 0 };
  let remaining = quantity;
  let filled = 0;
  let proceeds = 0;
  for (const [price, available] of [...depth].reverse()) {
    if (!(price > 0) || !(available > 0)) continue;
    const take = Math.min(remaining, available);
    proceeds += take * price;
    filled += take;
    remaining -= take;
    if (remaining <= 0) break;
  }
  return { price: filled > 0 ? proceeds / filled : null, quantity: filled };
}

function withMarketEvidence(
  evidence: SmartExitEvidence,
  position: Pick<SmartExitPosition, "side" | "remainingQuantity" | "ticker" | "symbol" | "windowKey">,
): SmartExitEvidence {
  const market = exactMarket(position.symbol, position.ticker, position.windowKey);
  const book = bookSnapshots.get(position.ticker);
  const depth = position.side === "yes" ? book?.yesDepth ?? [] : book?.noDepth ?? [];
  const executable = executableFromDepth(depth, position.remainingQuantity);
  const publicBid = position.side === "yes"
    ? market?.yesBid ?? null
    : market?.yesAsk == null ? null : 1 - market.yesAsk;
  const publicAsk = position.side === "yes"
    ? market?.yesAsk ?? null
    : market?.yesBid == null ? null : 1 - market.yesBid;
  const bookBid = position.side === "yes"
    ? book?.yesBid ?? null
    : book?.yesAsk == null ? null : 1 - book.yesAsk;
  const bookAsk = position.side === "yes"
    ? book?.yesAsk ?? null
    : book?.yesBid == null ? null : 1 - book.yesBid;
  return {
    ...evidence,
    marketWinProbability: marketProbabilityForSide(position.side, market?.yesPrice),
    marketQuoteObservedAtSeconds: market?.at == null ? null : market.at / 1_000,
    marketBookObservedAtSeconds: book?.receivedAtSeconds ?? null,
    marketBestBid: bookBid ?? publicBid,
    marketBestAsk: bookAsk ?? publicAsk,
    marketExecutablePrice: executable.price ?? bookBid ?? publicBid,
    marketExecutableQuantity: depth.length > 0 ? executable.quantity : null,
  };
}

function componentHealth(
  evidence: SmartExitEvidence,
  nowMs: number,
): SmartExitEvaluationRecord["componentHealth"] {
  const nowSeconds = nowMs / 1_000;
  const classify = (
    receivedAt: number | null,
    eventAt: number | null,
    quietAllowed = false,
  ): { status: "fresh" | "quiet" | "delayed" | "unavailable"; receiptAgeMs: number | null; eventAgeMs: number | null } => {
    const receiptAgeMs = receivedAt == null ? null : nowMs - receivedAt * 1_000;
    const eventAgeMs = eventAt == null ? null : nowMs - eventAt * 1_000;
    if (receivedAt == null) return { status: "unavailable", receiptAgeMs, eventAgeMs };
    if (receivedAt > nowSeconds || receiptAgeMs! > config.maxEvidenceAgeSeconds * 1_000) {
      return { status: "delayed", receiptAgeMs, eventAgeMs };
    }
    if (quietAllowed && (eventAt == null || eventAgeMs! > config.maxEvidenceAgeSeconds * 1_000)) {
      return { status: "quiet", receiptAgeMs, eventAgeMs };
    }
    return { status: "fresh", receiptAgeMs, eventAgeMs };
  };
  return {
    spot: classify(evidence.spotReceivedAtSeconds, evidence.spotObservedAtSeconds, true),
    tape: classify(evidence.tapeReceivedAtSeconds, evidence.tapeObservedAtSeconds, true),
    coinbaseBook: classify(evidence.bookReceivedAtSeconds, evidence.bookObservedAtSeconds),
    kalshiQuote: classify(evidence.marketQuoteObservedAtSeconds, evidence.marketQuoteObservedAtSeconds),
    kalshiBook: classify(evidence.marketBookObservedAtSeconds, evidence.marketBookObservedAtSeconds),
  };
}

function regularSnapshot(position: OpenPosition, evidence: SmartExitEvidence): SmartExitPosition {
  const symbol = position.symbol.toUpperCase();
  const market = exactMarket(symbol, position.ticker, position.windowKey);
  const key = identityKey("regular", position.id);
  const expirySeconds = windowExpirySeconds(position.windowKey);
  const baseline = modelEntryBaselines.get(key) ?? null;
  return {
    positionId: position.id,
    owner: { kind: "regular", tradingMode: position.entryMode },
    symbol,
    windowKey: position.windowKey,
    ticker: position.ticker,
    side: position.direction,
    underlyingKind: PRODUCT_BY_SYMBOL.get(symbol)?.category === "commodity" ? "commodity" : "crypto",
    remainingQuantity: position.contractCount,
    requestedQuantity: position.contractCount,
    entryStake: position.betAmount,
    exchangeIndex: market?.exchangeIndex ?? null,
    strikePrice: position.kalshiTarget,
    expirySeconds,
    openedAtSeconds: position.openedAt / 1_000,
    modelAtEntry: { winProbability: baseline ?? null, observedAtSeconds: position.openedAt / 1_000 },
    marketAtEntry: {
      winProbability: marketProbabilityForSide(position.direction, position.entryYesPrice) ?? 0,
      observedAtSeconds: position.openedAt / 1_000,
    },
  };
}

/**
 * Narrow fill notification from the regular owner. Disabled/off is a true
 * no-op. The independent collector captures the entry model once and persists
 * it; later evaluations never reconstruct entry probability from current vol.
 */
export function captureSmartExitRegularEntry(position: OpenPosition): void {
  if (!config.enabled || config.mode === "off") return;
  void (async () => {
    const symbol = position.symbol.toUpperCase();
    const definition = PRODUCT_BY_SYMBOL.get(symbol);
    if (!definition || definition.category === "commodity" || position.cryptoPriceAtEntry == null) return;
    const market = exactMarket(symbol, position.ticker, position.windowKey);
    const evidence = await collector.collect(
      symbol,
      definition.product,
      marketProbabilityForSide(position.direction, position.entryYesPrice),
    );
    const provisional = regularSnapshot(position, evidence);
    const baseline = modelWinProbability(
      provisional,
      { ...evidence, underlyingPrice: position.cryptoPriceAtEntry },
      config,
      position.openedAt / 1_000,
    );
    const key = identityKey("regular", position.id);
    modelEntryBaselines.set(key, baseline);
    await upsertSmartExitPositionState({
      owner: "regular",
      positionId: position.id,
      symbol,
      modelAtEntryProbability: baseline,
      state: INITIAL_SMART_EXIT_STATE,
    });
    const monitoredEvidence = withMarketEvidence(evidence, {
      side: position.direction,
      remainingQuantity: position.contractCount,
      ticker: position.ticker,
      symbol,
      windowKey: position.windowKey,
    });
    scheduleEvaluation(regularSnapshot(position, monitoredEvidence), monitoredEvidence);
  })().catch((error) =>
    logger.warn({ error, symbol: position.symbol }, "[kalshi-smart-exit] entry capture failed (non-fatal)"),
  );
}

function numeric(row: Record<string, unknown>, key: string): number | null {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : null;
}

function scalperSnapshot(
  row: Record<string, unknown>,
  evidence: SmartExitEvidence,
): SmartExitPosition {
  const symbol = String(row.symbol ?? "").toUpperCase();
  const positionId = String(row.id ?? "");
  const ticker = String(row.ticker ?? "");
  const windowKey = String(row.window_key ?? "");
  const side = row.side === "no" ? "no" : "yes";
  const market = exactMarket(symbol, ticker, windowKey);
  const openedAt = new Date(String(row.created_at ?? "")).getTime() / 1_000;
  const entryYesPrice = numeric(row, "entry_yes_price");
  const filledQuantity = numeric(row, "filled_count") ?? 0;
  const requestedQuantity = numeric(row, "contract_count") ?? filledQuantity;
  const winningContractCost = numeric(row, "winning_contract_cost");
  const avgFillPrice = numeric(row, "avg_fill_price");
  const exactWinningPrice = winningContractCost
    ?? marketProbabilityForSide(side, avgFillPrice)
    ?? marketProbabilityForSide(side, entryYesPrice)
    ?? 0;
  const guard = row.entry_guard_evidence && typeof row.entry_guard_evidence === "object"
    ? row.entry_guard_evidence as Record<string, unknown>
    : {};
  const entrySpot = Number(guard.underlyingPrice);
  const key = identityKey("scalper", positionId);
  let baseline = modelEntryBaselines.get(key);
  const provisional: SmartExitPosition = {
    positionId,
    owner: { kind: "scalper", tradingMode: row.mode === "live" ? "live" : "paper" },
    symbol,
    windowKey,
    ticker,
    side,
    underlyingKind: PRODUCT_BY_SYMBOL.get(symbol)?.category === "commodity" ? "commodity" : "crypto",
    remainingQuantity: filledQuantity,
    requestedQuantity,
    entryStake: exactWinningPrice * filledQuantity,
    exchangeIndex: market?.exchangeIndex ?? null,
    strikePrice: market?.value ?? 0,
    expirySeconds: windowExpirySeconds(windowKey),
    openedAtSeconds: Number.isFinite(openedAt) ? openedAt : 0,
    modelAtEntry: { winProbability: null, observedAtSeconds: openedAt },
    marketAtEntry: {
      winProbability: exactWinningPrice,
      observedAtSeconds: openedAt,
    },
  };
  if (!modelEntryBaselines.has(key)) {
    baseline = Number.isFinite(entrySpot) && entrySpot > 0
      ? modelWinProbability(
          provisional,
          { ...evidence, underlyingPrice: entrySpot },
          config,
          provisional.openedAtSeconds,
        )
      : null;
    modelEntryBaselines.set(key, baseline ?? null);
  }
  return { ...provisional, modelAtEntry: { winProbability: baseline ?? null, observedAtSeconds: openedAt } };
}

function reasonCode(disposition: string, reason: string): string {
  if (disposition === "OFF") return "disabled";
  if (disposition === "UNAVAILABLE") {
    if (reason.includes("commodity")) return "commodity_microstructure_unavailable";
    if (reason.includes("entry")) return "entry_baseline_unavailable";
    if (reason.includes("stale")) return "stale_evidence";
    return "incomplete_evidence";
  }
  if (reason.includes("catastrophic")) return "catastrophic_probability_drop";
  if (reason.includes("debounce")) return "debounce_pending";
  if (disposition === "WATCH") return "risk_watch";
  if (disposition === "PREPARE_EXIT") return "prepare_exit";
  if (disposition === "EXIT_SIGNAL") return "confirmed_target_crossing";
  return "hold";
}

function currentVersion(position: SmartExitPosition): SmartExitAppliedVersion | null {
  return config.appliedVersions[smartExitVersionKey(position.owner.kind, position.symbol)] ?? null;
}

function effectiveConfigForPosition(position: SmartExitPosition): SmartExitConfig {
  const applied = currentVersion(position);
  const selected = resolveSmartExitSensitivity(config.sensitivity);
  if (applied == null) return {
    ...config,
    sensitivity: selected.sensitivity,
    debounceCount: selected.parameters.debounceCount,
    confirmationLevel: selected.parameters.confirmationLevel,
  };
  if (!hasCompleteSmartExitParameterSnapshot(applied)) {
    return { ...config, mode: "shadow" };
  }
  const parameters = applied.parameters;
  return {
    ...config,
    sensitivity: parameters.sensitivity,
    debounceCount: parameters.debounceCount,
    confirmationLevel: parameters.confirmationLevel,
    minExitEdge: parameters.minExitEdge,
    deepLossHoldThreshold: parameters.deepLossHoldThreshold,
    terminalLossHoldThreshold: parameters.terminalLossHoldThreshold,
    deepLossRecoveryMinSeconds: parameters.deepLossRecoveryMinSeconds,
  };
}

function positionVersionAuthorized(
  position: SmartExitPosition,
  version: string,
): boolean {
  const applied = currentVersion(position);
  const authorization = authorizeSmartExitExecution({
    config,
    position,
    recommendation: "exit",
    appliedVersion: applied,
  });
  return authorization.authorized && authorization.parameterVersion === version;
}

async function executeAuthorizedExit(
  position: SmartExitPosition,
  evaluation: SmartExitEvaluationRecord,
): Promise<SmartExitEvaluationRecord> {
  const applied = currentVersion(position);
  const authorization = authorizeSmartExitExecution({
    config,
    position,
    recommendation: evaluation.recommendation,
    appliedVersion: applied,
  });
  if (!authorization.authorized) {
    const lifecycle = await getSmartExitLifecycle(position.owner.kind, position.positionId);
    if (lifecycle) await upsertSmartExitLifecycle({
      ...lifecycle, executionStatus: "blocked", reason: authorization.reason,
    });
    return { ...evaluation, executionStatus: "blocked" };
  }
  const definition = PRODUCT_BY_SYMBOL.get(position.symbol.toUpperCase());
  let finalRiskToken: {
    spotObservedAtSeconds: number;
    underlyingPrice: number;
    validatedAtMs: number;
  } | null = null;
  const revalidateRisk = async (): Promise<SmartExitExecutionConstraint | null> => {
    if (!definition || definition.category === "commodity") return null;
    const hot = await collectHotSpot(position.symbol.toUpperCase(), definition.product);
    await refreshBook(position.ticker);
    const finalEvidence = withMarketEvidence(
      mergeHotSpotWithSlowEvidence(position.symbol.toUpperCase(), hot),
      position,
    );
    if (
      finalEvidence.underlyingPrice == null
      || finalEvidence.spotObservedAtSeconds == null
      || finalEvidence.spotReceivedAtSeconds == null
    ) return null;
    const nowSeconds = Date.now() / 1_000;
    const finalDecision = evaluateSmartExit(
      position,
      finalEvidence,
      {
        ...INITIAL_SMART_EXIT_STATE,
        ...(states.get(identityKey(position.owner.kind, position.positionId)) ?? {}),
      },
      effectiveConfigForPosition(position),
      nowSeconds,
    );
    const valid = finalDecision.disposition === "EXIT_SIGNAL"
      && finalDecision.executionEvidenceReady
      && (config.mode === "paper-exit" || finalDecision.mayExecuteExit);
    if (
      !valid
      || finalDecision.minimumWinningPrice == null
      || finalEvidence.marketBookObservedAtSeconds == null
      || finalDecision.executionEvidenceExpiresAtSeconds == null
    ) return null;
    finalRiskToken = {
      spotObservedAtSeconds: finalEvidence.spotObservedAtSeconds,
      underlyingPrice: finalEvidence.underlyingPrice,
      validatedAtMs: Date.now(),
    };
    return {
      minimumWinningPrice: finalDecision.minimumWinningPrice,
      evaluatedBookObservedAtSeconds: finalEvidence.marketBookObservedAtSeconds,
      maximumEvidenceAgeSeconds: finalDecision.maximumExecutionEvidenceAgeSeconds,
      evidenceExpiresAtSeconds: finalDecision.executionEvidenceExpiresAtSeconds,
    };
  };
  const isRiskStillValid = (boundMinimumWinningPrice: number): boolean => {
    if (!finalRiskToken || Date.now() - finalRiskToken.validatedAtMs > HOT_SCHEDULER_MS * 2) return false;
    const latest = hotCollector.latest(position.symbol.toUpperCase());
    if (
      !latest
      || latest.underlyingPrice == null
      || latest.spotObservedAtSeconds == null
      || latest.spotReceivedAtSeconds == null
      || Date.now() / 1_000 - latest.spotReceivedAtSeconds
        > Math.min(1, evaluation.maximumExecutionEvidenceAgeSeconds ?? 1)
    ) return false;
    const currentEvidence = withMarketEvidence(
      mergeHotSpotWithSlowEvidence(position.symbol.toUpperCase(), latest),
      position,
    );
    const currentDecision = evaluateSmartExit(
      position,
      currentEvidence,
      {
        ...INITIAL_SMART_EXIT_STATE,
        ...(states.get(identityKey(position.owner.kind, position.positionId)) ?? {}),
      },
      effectiveConfigForPosition(position),
      Date.now() / 1_000,
    );
    return currentDecision.disposition === "EXIT_SIGNAL"
      && currentDecision.executionEvidenceReady
      && currentDecision.minimumWinningPrice !== null
      && currentDecision.minimumWinningPrice <= boundMinimumWinningPrice + 1e-9
      && (config.mode === "paper-exit" || currentDecision.mayExecuteExit);
  };
  if (
    evaluation.minimumWinningPrice == null
    || evaluation.marketBookAgeMs == null
    || evaluation.executionEvidenceExpiresAtSeconds == null
  ) {
    const lifecycle = await getSmartExitLifecycle(position.owner.kind, position.positionId);
    if (lifecycle) await upsertSmartExitLifecycle({
      ...lifecycle,
      executionStatus: "blocked",
      reason: "immutable economic execution constraint unavailable",
    });
    return { ...evaluation, executionStatus: "blocked" };
  }
  const revalidatedConstraint = await revalidateRisk();
  if (!revalidatedConstraint) {
    const lifecycle = await getSmartExitLifecycle(position.owner.kind, position.positionId);
    if (lifecycle) await upsertSmartExitLifecycle({
      ...lifecycle,
      executionStatus: "blocked",
      reason: "fresh spot trajectory or target risk no longer authorizes exit",
    });
    return { ...evaluation, executionStatus: "blocked" };
  }
  const executionConstraint: SmartExitExecutionConstraint =
    combineSmartExitExecutionConstraints({
      minimumWinningPrice: evaluation.minimumWinningPrice,
      evaluatedBookObservedAtSeconds:
        Date.now() / 1_000 - evaluation.marketBookAgeMs / 1_000,
      maximumEvidenceAgeSeconds: evaluation.maximumExecutionEvidenceAgeSeconds,
      evidenceExpiresAtSeconds: evaluation.executionEvidenceExpiresAtSeconds,
    }, revalidatedConstraint);
  const requestId = randomUUID();
  const claim = await claimSmartExitRequest({
    id: requestId,
    owner: position.owner.kind,
    positionId: position.positionId,
    symbol: position.symbol,
    payload: {
      evaluationId: evaluation.id,
      ticker: position.ticker,
      windowKey: position.windowKey,
      side: position.side,
      remainingQuantity: position.remainingQuantity,
      tradingMode: position.owner.tradingMode,
      exchangeIndex: position.exchangeIndex,
      parameterVersion: authorization.parameterVersion,
       minimumWinningPrice: executionConstraint.minimumWinningPrice,
       executionEvidenceExpiresAtSeconds: executionConstraint.evidenceExpiresAtSeconds,
       maximumExecutionEvidenceAgeSeconds: executionConstraint.maximumEvidenceAgeSeconds,
    },
  });
  if (!claim.claimed) {
    const existing = await getSmartExitLifecycle(position.owner.kind, position.positionId);
    if (existing) await upsertSmartExitLifecycle({
      ...existing, executionStatus: "blocked", reason: claim.reason ?? "execution request already claimed",
    });
    return { ...evaluation, executionStatus: "blocked" };
  }
  const lifecycle = await getSmartExitLifecycle(position.owner.kind, position.positionId);
  if (lifecycle) await upsertSmartExitLifecycle({
    ...lifecycle, requestId, executionStatus: "requested",
  });
  if (
    Date.now() / 1_000 > executionConstraint.evidenceExpiresAtSeconds
  ) {
    await resolveSmartExitRequest({
      id: requestId,
      status: "blocked",
      reason: "immutable economic execution constraint unavailable",
    });
    if (lifecycle) await upsertSmartExitLifecycle({
      ...lifecycle, requestId, executionStatus: "blocked",
      reason: "immutable economic execution constraint unavailable",
    });
    return { ...evaluation, executionStatus: "blocked" };
  }

  const result = await requestSmartExitFromOwner({
    position,
    parameterVersion: authorization.parameterVersion,
    executionConstraint,
    isVersionStillAuthorized: positionVersionAuthorized,
    revalidateRisk,
    isRiskStillValid,
  });
  if (result.outcome === "filled") {
    await resolveSmartExitRequest({ id: requestId, status: "filled", reason: result.reason });
    if (lifecycle) {
      const effectiveness = computeSmartExitEffectivenessFromProceeds({
        side: lifecycle.side,
        quantity: result.quantity,
        entryStake: lifecycle.entryStake
          ?? lifecycle.entryWinningPrice * result.quantity,
        exitProceeds: result.winningFillPrice * result.quantity,
        settlementResult: lifecycle.settlementResult,
      });
      await upsertSmartExitLifecycle({
        ...lifecycle, requestId, executionStatus: "filled", soldAt: result.soldAt,
        winningFillPrice: result.winningFillPrice,
        reason: lifecycle.reason ?? result.reason,
        ...effectiveness,
      });
    }
    return { ...evaluation, executed: true, executionStatus: "filled" };
  }
  if (result.outcome === "blocked") {
    await resolveSmartExitRequest({ id: requestId, status: "blocked", reason: result.reason });
    if (lifecycle) await upsertSmartExitLifecycle({
      ...lifecycle, requestId, executionStatus: "blocked", reason: result.reason,
    });
    return { ...evaluation, executionStatus: "blocked" };
  }
  if (result.outcome === "zero_fill") {
    await resolveSmartExitRequest({ id: requestId, status: "zero_fill", reason: result.reason });
    if (lifecycle) await upsertSmartExitLifecycle({
      ...lifecycle, requestId, executionStatus: "zero_fill", reason: result.reason,
    });
    return { ...evaluation, executionStatus: "zero_fill" };
  }
  await markSmartExitRequestUnknown(requestId, result.reason);
  if (lifecycle) await upsertSmartExitLifecycle({
    ...lifecycle, requestId, executionStatus: "unknown", reason: result.reason, verdict: "unknown",
  });
  return { ...evaluation, executionStatus: "unknown" };
}

async function recordLifecycleTrigger(
  position: SmartExitPosition,
  evaluation: SmartExitEvaluationRecord,
): Promise<void> {
  if (await getSmartExitLifecycle(position.owner.kind, position.positionId)) return;
  const advisoryOnly = config.mode === "shadow";
  const simulatedExitProceeds = getSmartExitShadowProceeds(
    evaluation,
    position.remainingQuantity,
  );
  await upsertSmartExitLifecycle({
    id: randomUUID(),
    owner: position.owner.kind,
    positionId: position.positionId,
    symbol: position.symbol,
    windowKey: position.windowKey,
    ticker: position.ticker,
    side: position.side,
    tradingMode: position.owner.tradingMode,
    quantity: position.remainingQuantity,
    requestedQuantity: position.requestedQuantity,
    entryWinningPrice: position.marketAtEntry.winProbability,
    entryPriceCents: position.marketAtEntry.winProbability * 100,
    entryStake: position.entryStake,
    simulatedExitProceeds,
    simulatedExitPnl: simulatedExitProceeds != null
      ? simulatedExitProceeds - position.entryStake
      : null,
    triggerEvaluationId: evaluation.id,
    triggeredAt: evaluation.timestamp,
    advisoryOnly,
    executionStatus: advisoryOnly ? "advisory" : "requested",
    requestId: null,
    soldAt: null,
    winningFillPrice: null,
    saleProceeds: null,
    actualExitPnl: null,
    settlementResult: null,
    settledAt: null,
    holdValue: null,
    holdPnl: null,
    valueSaved: null,
    verdict: "pending",
    reason: evaluation.reason,
  });
}

async function reconcileSmartExitLifecycles(): Promise<void> {
  const records = await listUnsettledSmartExitLifecycles(25);
  const recoveredEvaluations = await getSmartExitEvaluationsByIds(
    records
      .filter((record) =>
        isSmartExitCounterfactualScoreable(record)
        && record.simulatedExitProceeds == null)
      .map((record) => record.triggerEvaluationId),
  );
  const recoveredById = new Map(recoveredEvaluations.map((evaluation) => [evaluation.id, evaluation]));
  for (const record of records) {
    const settlementResult = record.settlementResult
      ?? (await fetchKalshiMarketResult(record.ticker)).result;
    if (settlementResult == null) continue;
    const entryStake = record.entryStake
      ?? record.entryWinningPrice * record.quantity;
    const simulatedExitProceeds = record.simulatedExitProceeds
      ?? getSmartExitShadowProceeds(recoveredById.get(record.triggerEvaluationId) ?? {
        executionEvidenceReady: false,
        estimatedSaleValue: null,
        liquidityCoverage: null,
        remainingQuantity: 0,
      }, record.quantity);
    const effectiveness = record.executionStatus === "filled"
      ? computeSmartExitEffectivenessFromProceeds({
          side: record.side,
          quantity: record.quantity,
          entryStake,
          exitProceeds: record.winningFillPrice == null
            ? record.saleProceeds
            : record.winningFillPrice * record.quantity,
          settlementResult,
        })
      : isSmartExitCounterfactualScoreable(record)
        ? computeSmartExitEffectivenessFromProceeds({
            side: record.side,
            quantity: record.quantity,
            entryStake,
            exitProceeds: simulatedExitProceeds,
            settlementResult,
          })
        : { saleProceeds: record.saleProceeds, actualExitPnl: record.actualExitPnl,
            holdValue: settlementResult === record.side ? record.quantity : 0,
            holdPnl: (settlementResult === record.side ? record.quantity : 0) - entryStake,
            valueSaved: null, verdict: record.verdict };
    await upsertSmartExitLifecycle({
      ...record,
      entryPriceCents: record.entryPriceCents ?? record.entryWinningPrice * 100,
      entryStake,
      requestedQuantity: record.requestedQuantity ?? record.quantity,
      simulatedExitProceeds,
      simulatedExitPnl: simulatedExitProceeds == null ? null : simulatedExitProceeds - entryStake,
      settlementResult,
      settledAt: new Date().toISOString(),
      ...effectiveness,
    });
  }
}

function recoveryStudy(
  decisionProbability: number | null,
  marketWinProbability: number | null,
): SmartExitEvaluationRecord["recoveryStudy"] {
  if (decisionProbability == null || marketWinProbability == null) return null;
  const oppositeProbability = 1 - decisionProbability;
  const oppositeMarket = 1 - marketWinProbability;
  const edgeAfterCosts = oppositeProbability - oppositeMarket - 0.02;
  const qualifies = oppositeProbability >= 0.95 && edgeAfterCosts >= 0.01;
  return {
    observedOnly: true,
    oppositeSideProbability: oppositeProbability,
    marketEdgeAfterCosts: edgeAfterCosts,
    qualifies,
    reason: qualifies
      ? "observational recovery candidate; submission prohibited"
      : "independent recovery edge requirements not met",
  };
}

async function persistEvaluationItem(item: PersistenceItem): Promise<void> {
  const { position, evidence, state, record } = item;
  await upsertSmartExitPositionState({
    owner: position.owner.kind,
    positionId: position.positionId,
    symbol: position.symbol,
    modelAtEntryProbability: position.modelAtEntry.winProbability,
    state,
  });
  const evidencePersistenceKey = `${position.owner.kind}:${position.symbol}`;
  const nowMs = Date.now();
  if (nowMs - (lastEvidencePersistenceMs.get(evidencePersistenceKey) ?? 0) >= 5_000) {
    await insertSmartExitEvidence({
      owner: position.owner.kind,
      symbol: position.symbol,
      evidence,
    });
    lastEvidencePersistenceMs.set(evidencePersistenceKey, nowMs);
  }
  await insertSmartExitEvaluation(record);
  if (record.recoveryStudy) {
    await insertSmartExitRecoveryStudy({
      id: record.id,
      owner: record.owner,
      positionId: record.positionId,
      symbol: record.symbol,
      payload: record.recoveryStudy,
      observedAt: record.timestamp,
    });
  }
  lastEvaluationPersistenceMs.set(
    identityKey(position.owner.kind, position.positionId),
    Date.parse(record.timestamp),
  );
}

function wakePersistenceWorker(delayMs = 0): void {
  if (persistenceWorkerRunning) return;
  const wakeAtMs = Date.now() + Math.max(0, delayMs);
  if (persistenceWakeTimer && persistenceWakeAtMs != null && persistenceWakeAtMs <= wakeAtMs) return;
  if (persistenceWakeTimer) clearTimeout(persistenceWakeTimer);
  persistenceWakeAtMs = wakeAtMs;
  persistenceWakeTimer = setTimeout(() => {
    persistenceWakeTimer = null;
    persistenceWakeAtMs = null;
    void drainPersistenceQueue();
  }, Math.max(0, delayMs));
  persistenceWakeTimer.unref?.();
}

async function drainPersistenceQueue(): Promise<void> {
  if (persistenceWorkerRunning) return;
  persistenceWorkerRunning = true;
  let nextDelayMs: number | null = null;
  try {
    while (persistenceQueue.size > 0) {
      const nowMs = Date.now();
      const ready = [...persistenceQueue.entries()]
        .filter(([, item]) => item.notBeforeMs <= nowMs)
        .sort((a, b) => a[1].notBeforeMs - b[1].notBeforeMs)[0];
      if (!ready) {
        const nextAt = Math.min(...[...persistenceQueue.values()].map((item) => item.notBeforeMs));
        nextDelayMs = Math.max(0, nextAt - nowMs);
        break;
      }
      const [key, item] = ready;
      persistenceQueue.delete(key);
      try {
        await persistEvaluationItem(item);
      } catch (error) {
        logger.warn({ error, key }, "[kalshi-smart-exit] persistence write failed (non-fatal)");
      } finally {
        for (const resolve of item.completionResolvers) resolve();
      }
    }
  } finally {
    persistenceWorkerRunning = false;
    if (persistenceQueue.size > 0) wakePersistenceWorker(nextDelayMs ?? 0);
  }
}

function enqueueEvaluationPersistence(
  position: SmartExitPosition,
  evidence: SmartExitEvidence,
  state: SmartExitState,
  record: SmartExitEvaluationRecord,
): Promise<void> | null {
  const key = identityKey(position.owner.kind, position.positionId);
  const force = record.recommendation === "exit";
  const lastPersisted = lastEvaluationPersistenceMs.get(key) ?? 0;
  const notBeforeMs = force
    ? Date.now()
    : Math.max(Date.now(), lastPersisted + EVALUATION_PERSISTENCE_MS);
  let completion: Promise<void> | null = null;
  const completionResolvers = persistenceQueue.get(key)?.completionResolvers ?? [];
  if (force) {
    completion = new Promise<void>((resolve) => completionResolvers.push(resolve));
  }
  persistenceQueue.set(key, {
    position,
    evidence,
    state,
    record,
    notBeforeMs,
    completionResolvers,
  });
  wakePersistenceWorker(Math.max(0, notBeforeMs - Date.now()));
  return completion;
}

function scheduleEvaluation(position: SmartExitPosition, evidence: SmartExitEvidence): void {
  const key = identityKey(position.owner.kind, position.positionId);
  const eventAt = evidence.spotObservedAtSeconds;
  if (eventAt != null && Number.isFinite(eventAt)) {
    const lastScheduled = lastScheduledSpotEventSeconds.get(key);
    if (lastScheduled != null && eventAt < lastScheduled) return;
    const pendingEventAt = evaluationPending.get(key)?.evidence.spotObservedAtSeconds;
    if (pendingEventAt != null && eventAt < pendingEventAt) return;
    lastScheduledSpotEventSeconds.set(key, eventAt);
  }
  evaluationPending.set(key, { position, evidence });
  if (evaluationRunning.has(key)) return;
  evaluationRunning.add(key);
  void (async () => {
    try {
      while (evaluationPending.has(key)) {
        const pending = evaluationPending.get(key)!;
        evaluationPending.delete(key);
        await evaluateOne(pending.position, pending.evidence);
      }
    } catch (error) {
      logger.warn({ error, key }, "[kalshi-smart-exit] keyed evaluation failed (non-fatal)");
    } finally {
      evaluationRunning.delete(key);
      if (evaluationPending.has(key)) scheduleEvaluation(
        evaluationPending.get(key)!.position,
        evaluationPending.get(key)!.evidence,
      );
    }
  })();
}

async function evaluateOne(position: SmartExitPosition, evidence: SmartExitEvidence): Promise<void> {
  const evaluationStartedAtMs = Date.now();
  const nowMs = evaluationStartedAtMs;
  const nowSeconds = nowMs / 1_000;
  const key = identityKey(position.owner.kind, position.positionId);
  const effectiveConfig = effectiveConfigForPosition(position);
  const previousState = {
    ...INITIAL_SMART_EXIT_STATE,
    ...(states.get(key) ?? {}),
  };
  const decision = evaluateSmartExit(
    position,
    evidence,
    previousState,
    effectiveConfig,
    nowSeconds,
  );
  states.set(key, decision.nextState);
  const market = exactMarket(position.symbol, position.ticker, position.windowKey);
  const marketWinProbability = marketProbabilityForSide(position.side, market?.yesPrice);
  const health = componentHealth(evidence, nowMs);
  let record: SmartExitEvaluationRecord = {
    id: `${key}:${nowMs}`,
    positionId: position.positionId,
    owner: position.owner.kind,
    tradingMode: position.owner.tradingMode,
    symbol: position.symbol,
    windowKey: position.windowKey,
    ticker: position.ticker,
    side: position.side,
    exchangeIndex: position.exchangeIndex,
    remainingQuantity: position.remainingQuantity,
    strikePrice: position.strikePrice,
    secondsRemaining: Math.max(0, position.expirySeconds - nowSeconds),
    timestamp: new Date(nowMs).toISOString(),
    source: evidence.source,
    evidenceAgeMs: Number.isFinite(evidence.observedAtSeconds) ? nowMs - evidence.observedAtSeconds * 1_000 : null,
    spotReceiptAgeMs: evidence.spotReceivedAtSeconds == null ? null : nowMs - evidence.spotReceivedAtSeconds * 1_000,
    tapeReceiptAgeMs: evidence.tapeReceivedAtSeconds == null ? null : nowMs - evidence.tapeReceivedAtSeconds * 1_000,
    bookReceiptAgeMs: evidence.bookReceivedAtSeconds == null ? null : nowMs - evidence.bookReceivedAtSeconds * 1_000,
    spotAgeMs: evidence.spotObservedAtSeconds == null ? null : nowMs - evidence.spotObservedAtSeconds * 1_000,
    tapeAgeMs: evidence.tapeObservedAtSeconds == null ? null : nowMs - evidence.tapeObservedAtSeconds * 1_000,
    bookAgeMs: evidence.bookObservedAtSeconds == null ? null : nowMs - evidence.bookObservedAtSeconds * 1_000,
    underlyingPrice: evidence.underlyingPrice,
    marketWinProbability,
    marketAtEntryProbability: position.marketAtEntry.winProbability,
    modelWinProbability: decision.modelWinProbability,
    modelAtEntryProbability: position.modelAtEntry.winProbability,
    probabilityDrop: decision.probabilityDropFromEntry,
    threshold: decision.threshold,
    volatilityLogReturnPerSqrtSecond: evidence.volatilityLogReturnPerSqrtSecond,
    momentumLogReturn: evidence.momentumLogReturn,
    momentumWindowSeconds: evidence.momentumWindowSeconds,
    tradeFlowImbalance: evidence.tradeFlowImbalance,
    bookImbalance: evidence.bookImbalance,
    continuationScore: decision.continuationScore,
    timeBand: decision.timeBand,
    adverseTargetDistanceFraction: decision.adverseTargetDistanceFraction,
    requiredAdverseTargetDistanceFraction: decision.requiredAdverseTargetDistanceFraction,
    previousMarketWinProbability: previousState.previousMarketWinProbability,
    marketProbabilityDelta: decision.marketProbabilityDelta,
    marketAdverseSlopePerSecond: decision.marketAdverseSlopePerSecond,
    marketDirection: decision.marketDirection,
    marketDirectionConfirmed: decision.marketDirectionConfirmed,
    marketDirectionSampleCount: decision.marketDirectionSampleCount,
    targetCrossedDurationSeconds: decision.targetCrossedDurationSeconds,
    marketExecutablePrice: decision.marketExecutablePrice,
    marketSpread: decision.marketSpread,
    marketPressureConfirmed: decision.marketPressureConfirmed,
    marketPressureSampleCount: decision.marketPressureSampleCount,
    marketPressureWindowSeconds: decision.marketPressureWindowSeconds,
    marketLowDurationSeconds: decision.marketLowDurationSeconds,
    marketCollapseLatchActive: decision.marketCollapseLatchActive,
    marketCollapseLatchExpiresAtSeconds: decision.marketCollapseLatchExpiresAtSeconds,
    valuePreservationTriggered: decision.valuePreservationTriggered,
    riskStage: decision.riskStage,
    marketLossFraction: decision.marketLossFraction,
    capitalLossFraction: decision.capitalLossFraction,
    deepLossHoldActive: decision.deepLossHoldActive,
    deepLossHoldKind: decision.deepLossHoldKind,
    highRisk: decision.highRisk,
    underlyingVelocityPerSecond: decision.underlyingVelocityPerSecond,
    adverseVelocityPerSecond: decision.adverseVelocityPerSecond,
    adverseAccelerationPerSecond2: decision.adverseAccelerationPerSecond2,
    trajectorySampleCount: decision.trajectorySampleCount,
    trajectoryWindowSeconds: decision.trajectoryWindowSeconds,
    adverseExcursionFraction: decision.adverseExcursionFraction,
    adverseLatchActive: decision.adverseLatchActive,
    adverseLatchExpiresAtSeconds: decision.adverseLatchExpiresAtSeconds,
    recoveryProgress: decision.recoveryProgress,
    spotEventAgeMs: evidence.spotObservedAtSeconds == null
      ? null : nowMs - evidence.spotObservedAtSeconds * 1_000,
    decisionLatencyMs: Date.now() - evaluationStartedAtMs,
    projectedCrossingSeconds: decision.projectedCrossingSeconds,
    projectedCrossBeforeExpiry: decision.projectedCrossBeforeExpiry,
    crossingRiskConfirmed: decision.crossingRiskConfirmed,
    targetAlreadyCrossed: decision.targetAlreadyCrossed,
    volatilityReachableBeforeExpiry: decision.volatilityReachableBeforeExpiry,
    marketBestBid: evidence.marketBestBid,
    marketBestAsk: evidence.marketBestAsk,
    marketQuoteAgeMs: evidence.marketQuoteObservedAtSeconds == null ? null : nowMs - evidence.marketQuoteObservedAtSeconds * 1_000,
    marketBookAgeMs: evidence.marketBookObservedAtSeconds == null ? null : nowMs - evidence.marketBookObservedAtSeconds * 1_000,
    estimatedSaleValue: decision.estimatedSaleValue,
    entryStake: Number.isFinite(position.entryStake) ? position.entryStake : null,
    expectedHoldValue: decision.expectedHoldValue,
    exitEdgePerContract: decision.exitEdgePerContract,
    executableQuantity: evidence.marketExecutableQuantity,
    liquidityCoverage: decision.liquidityCoverage,
    executionEvidenceReady: decision.executionEvidenceReady,
    minimumWinningPrice: decision.minimumWinningPrice,
    maximumExecutionEvidenceAgeSeconds: decision.maximumExecutionEvidenceAgeSeconds,
    executionEvidenceExpiresAtSeconds: decision.executionEvidenceExpiresAtSeconds,
    degradedComponents: decision.degradedComponents,
    componentHealth: health,
    recommendation: decision.disposition === "EXIT_SIGNAL"
      ? "exit"
      : decision.disposition === "PREPARE_EXIT"
        ? "prepare_exit"
        : decision.disposition === "WATCH"
          ? "watch"
      : decision.disposition === "UNAVAILABLE"
        ? "unavailable"
        : decision.disposition === "OFF" ? "off" : "hold",
    reasonCode: reasonCode(decision.disposition, decision.reason),
    reason: decision.reason,
    debounceProgress: decision.nextState.adverseSampleCount,
    debounceTarget: effectiveConfig.debounceCount,
    hysteresisUntil: decision.nextState.holdUntilSeconds > nowSeconds
      ? new Date(decision.nextState.holdUntilSeconds * 1_000).toISOString()
      : null,
    parameterVersion: currentVersion(position)?.version ?? null,
    effectiveSensitivity: effectiveConfig.sensitivity,
    executed: false,
    executionStatus: "not_requested",
    recoveryStudy: decision.disposition === "EXIT_SIGNAL"
      ? recoveryStudy(decision.modelWinProbability, marketWinProbability)
      : null,
  };

  if (
    decision.disposition === "EXIT_SIGNAL"
    && (config.mode === "paper-exit" || config.mode === "live-exit")
    && (config.mode === "paper-exit" || decision.mayExecuteExit)
  ) {
    await recordLifecycleTrigger(position, record);
    record = await executeAuthorizedExit(position, { ...record, executionStatus: "requested" });
  } else if (decision.disposition === "EXIT_SIGNAL") {
    await recordLifecycleTrigger(position, record);
  }
  latestEvaluations.set(key, record);
  if (record.recommendation !== "unavailable") latestValidEvaluations.set(key, record);
  if (record.recommendation === "exit") {
    await enqueueEvaluationPersistence(position, evidence, decision.nextState, record);
  } else {
    enqueueEvaluationPersistence(position, evidence, decision.nextState, record);
  }
}

async function runCycle(): Promise<void> {
  if (cycleInFlight) {
    schedulerOverruns += 1;
    return;
  }
  const cycleStartedAt = Date.now();
  cycleInFlight = true;
  try {
    if (!config.enabled || config.mode === "off") {
      const coin = PREWARMABLE_COINS[prewarmCursor % PREWARMABLE_COINS.length];
      if (coin) {
        prewarmCursor += 1;
        void collectSlowEvidence(coin.symbol, coin.product).catch((error) =>
          logger.debug({ error, symbol: coin.symbol }, "[kalshi-smart-exit] background prewarm failed"));
      }
      lastCycleAt = new Date().toISOString();
      lastError = null;
      return;
    }
    const regular = [...openPositions.values()].filter((position) =>
      smartExitModeIncludesPosition(config.mode, position.entryMode));
    const scalper = (await listOpenScalperPositions()).filter((position) =>
      smartExitModeIncludesPosition(
        config.mode,
        position.mode === "live" ? "live" : "paper",
      ));
    cachedScalperPositions = scalper;
    const entries = [
      ...regular.map((position) => ({ owner: "regular" as const, symbol: position.symbol.toUpperCase(), value: position })),
      ...scalper.map((position) => ({ owner: "scalper" as const, symbol: String(position.symbol ?? "").toUpperCase(), value: position })),
    ];
    const activeKeys = new Set(entries.map((entry) =>
      identityKey(entry.owner, String(entry.owner === "regular" ? (entry.value as OpenPosition).id : (entry.value as Record<string, unknown>).id)),
    ));
    for (const key of latestEvaluations.keys()) if (!activeKeys.has(key)) latestEvaluations.delete(key);
    for (const key of latestValidEvaluations.keys()) if (!activeKeys.has(key)) latestValidEvaluations.delete(key);
    for (const key of states.keys()) if (!activeKeys.has(key)) states.delete(key);
    for (const key of lastScheduledSpotEventSeconds.keys()) {
      if (!activeKeys.has(key)) lastScheduledSpotEventSeconds.delete(key);
    }

    for (const entry of entries) {
      const raw = entry.value;
      const ticker = entry.owner === "regular"
        ? (raw as OpenPosition).ticker
        : String((raw as Record<string, unknown>).ticker ?? "");
      requestBookRefresh(ticker);
    }
    const evidenceBySymbol = new Map<string, Promise<SmartExitEvidence>>();
    for (const entry of entries) {
      if (evidenceBySymbol.has(entry.symbol)) continue;
      const definition = PRODUCT_BY_SYMBOL.get(entry.symbol);
      if (!definition) continue;
      evidenceBySymbol.set(entry.symbol, collectSlowEvidence(entry.symbol, definition.product));
    }
    await Promise.all(entries.map(async (entry) => {
      const definition = PRODUCT_BY_SYMBOL.get(entry.symbol);
      if (!definition) return;
      const raw = entry.value;
      const side = entry.owner === "regular"
        ? (raw as OpenPosition).direction
        : (raw as Record<string, unknown>).side === "no" ? "no" : "yes";
      const ticker = entry.owner === "regular"
        ? (raw as OpenPosition).ticker
        : String((raw as Record<string, unknown>).ticker ?? "");
      const windowKey = entry.owner === "regular"
        ? (raw as OpenPosition).windowKey
        : String((raw as Record<string, unknown>).window_key ?? "");
      const baseEvidence = await evidenceBySymbol.get(entry.symbol)!;
      const partialPosition = {
        side,
        remainingQuantity: entry.owner === "regular"
          ? (raw as OpenPosition).contractCount
          : numeric(raw as Record<string, unknown>, "filled_count") ?? 0,
        ticker,
        symbol: entry.symbol,
        windowKey,
      };
      const evidence = withMarketEvidence(baseEvidence, partialPosition);
      const snapshot = entry.owner === "regular"
        ? regularSnapshot(raw as OpenPosition, evidence)
        : scalperSnapshot(raw as Record<string, unknown>, evidence);
      scheduleEvaluation(snapshot, evidence);
    }));
    const activeSymbols = new Set(entries.map((entry) => entry.symbol));
    const inactivePrewarmable = PREWARMABLE_COINS.filter((coin) =>
      !activeSymbols.has(coin.symbol.toUpperCase()));
    if (inactivePrewarmable.length > 0) {
      const coin = inactivePrewarmable[prewarmCursor % inactivePrewarmable.length]!;
      prewarmCursor += 1;
      void collectSlowEvidence(coin.symbol, coin.product).catch((error) =>
        logger.debug({ error, symbol: coin.symbol }, "[kalshi-smart-exit] background prewarm failed"));
    }
    lastCycleAt = new Date().toISOString();
    lastError = null;
  } catch (error) {
    lastError = String((error as Error)?.message ?? error).slice(0, 240);
    logger.warn({ error }, "[kalshi-smart-exit] evaluation cycle failed (non-fatal)");
  } finally {
    lastCycleDurationMs = Date.now() - cycleStartedAt;
    cycleInFlight = false;
  }
}

async function runHotCycle(): Promise<void> {
  if (hotCycleInFlight) {
    hotSchedulerOverruns += 1;
    return;
  }
  const cycleStartedAt = Date.now();
  hotCycleInFlight = true;
  try {
    if (!config.enabled || config.mode === "off") {
      lastHotCycleAt = new Date().toISOString();
      return;
    }
    const regular = [...openPositions.values()].filter((position) =>
      smartExitModeIncludesPosition(config.mode, position.entryMode));
    const scalper = cachedScalperPositions.filter((position) =>
      smartExitModeIncludesPosition(
        config.mode,
        position.mode === "live" ? "live" : "paper",
      ));
    const entries = [
      ...regular.map((position) => ({
        owner: "regular" as const,
        symbol: position.symbol.toUpperCase(),
        value: position as OpenPosition | Record<string, unknown>,
      })),
      ...scalper.map((position) => ({
        owner: "scalper" as const,
        symbol: String(position.symbol ?? "").toUpperCase(),
        value: position as OpenPosition | Record<string, unknown>,
      })),
    ];
    const evidenceBySymbol = new Map<string, Promise<SmartExitEvidence>>();
    for (const entry of entries) {
      const definition = PRODUCT_BY_SYMBOL.get(entry.symbol);
      if (!definition || definition.category === "commodity") continue;
      const ticker = entry.owner === "regular"
        ? (entry.value as OpenPosition).ticker
        : String((entry.value as Record<string, unknown>).ticker ?? "");
      requestBookRefresh(ticker);
      if (!evidenceBySymbol.has(entry.symbol)) {
        evidenceBySymbol.set(
          entry.symbol,
          collectHotSpot(entry.symbol, definition.product),
        );
      }
    }
    await Promise.all(entries.map(async (entry) => {
      const raw = entry.value;
      const hotEvidence = await evidenceBySymbol.get(entry.symbol);
      if (!hotEvidence) return;
      const baseEvidence = mergeHotSpotWithSlowEvidence(entry.symbol, hotEvidence);
      if (baseEvidence.spotReceivedAtSeconds != null) {
        const receiptMs = baseEvidence.spotReceivedAtSeconds * 1_000;
        const previousReceiptMs = lastUsableSpotReceiptMs.get(entry.symbol);
        if (previousReceiptMs != null && receiptMs >= previousReceiptMs) {
          const gap = receiptMs - previousReceiptMs;
          maximumUsableSampleGapMs = Math.max(maximumUsableSampleGapMs ?? 0, gap);
        }
        lastUsableSpotReceiptMs.set(entry.symbol, receiptMs);
      }
      const side = entry.owner === "regular"
        ? (raw as OpenPosition).direction
        : (raw as Record<string, unknown>).side === "no" ? "no" : "yes";
      const ticker = entry.owner === "regular"
        ? (raw as OpenPosition).ticker
        : String((raw as Record<string, unknown>).ticker ?? "");
      const windowKey = entry.owner === "regular"
        ? (raw as OpenPosition).windowKey
        : String((raw as Record<string, unknown>).window_key ?? "");
      const evidence = withMarketEvidence(baseEvidence, {
        side,
        remainingQuantity: entry.owner === "regular"
          ? (raw as OpenPosition).contractCount
          : numeric(raw as Record<string, unknown>, "filled_count") ?? 0,
        ticker,
        symbol: entry.symbol,
        windowKey,
      });
      const snapshot = entry.owner === "regular"
        ? regularSnapshot(raw as OpenPosition, evidence)
        : scalperSnapshot(raw as Record<string, unknown>, evidence);
      scheduleEvaluation(snapshot, evidence);
    }));
    lastHotCycleAt = new Date().toISOString();
  } catch (error) {
    lastError = String((error as Error)?.message ?? error).slice(0, 240);
    logger.warn({ error }, "[kalshi-smart-exit] hot risk cycle failed (non-fatal)");
  } finally {
    lastHotCycleDurationMs = Date.now() - cycleStartedAt;
    hotCycleInFlight = false;
  }
}

function stopScheduler(): void {
  if (interval) clearInterval(interval);
  if (hotInterval) clearInterval(hotInterval);
  interval = null;
  hotInterval = null;
}

function startScheduler(): void {
  if (!interval) {
    interval = setInterval(() => void runCycle(), SLOW_SCHEDULER_MS);
    interval.unref?.();
    void runCycle();
  }
  if (!hotInterval) {
    hotInterval = setInterval(() => void runHotCycle(), HOT_SCHEDULER_MS);
    hotInterval.unref?.();
    void runHotCycle();
  }
}

export async function initSmartExit(): Promise<void> {
  await runSmartExitMigrations();
  const loaded = { ...DEFAULT_SMART_EXIT_CONFIG, ...(await loadSmartExitConfig()) };
  const selected = resolveSmartExitSensitivity(loaded.sensitivity);
  config = {
    ...loaded,
    sensitivity: selected.sensitivity,
    debounceCount: selected.parameters.debounceCount,
    confirmationLevel: selected.parameters.confirmationLevel,
  };
  const persistedStates = await listSmartExitPositionStates();
  for (const persisted of persistedStates) {
    modelEntryBaselines.set(
      identityKey(persisted.owner, persisted.positionId),
      persisted.modelAtEntryProbability,
    );
    states.set(identityKey(persisted.owner, persisted.positionId), {
      ...INITIAL_SMART_EXIT_STATE,
      ...persisted.state,
    });
  }
  const prior = await listLatestSmartExitEvaluationsPerPosition({ limit: 1_000 });
  for (const evaluation of prior) {
    const key = identityKey(evaluation.owner, evaluation.positionId);
    latestEvaluations.set(key, evaluation);
    if (evaluation.recommendation !== "unavailable") latestValidEvaluations.set(key, evaluation);
  }
  await Promise.allSettled(PREWARMABLE_COINS.map((coin) =>
    collector.collect(coin.symbol, coin.product, null)));
  startScheduler();
  if (!lifecycleReconcileInterval) {
    lifecycleReconcileInterval = setInterval(() => {
      void reconcileSmartExitLifecycles().catch((error) =>
        logger.warn({ error }, "[kalshi-smart-exit] lifecycle reconciliation failed (non-fatal)"));
    }, 30_000);
    lifecycleReconcileInterval.unref?.();
    void reconcileSmartExitLifecycles().catch((error) =>
      logger.warn({ error }, "[kalshi-smart-exit] initial lifecycle reconciliation failed (non-fatal)"));
  }
  logger.info(
    { enabled: config.enabled, mode: config.mode },
    "[kalshi-smart-exit] initialized",
  );
}

export function getSmartExitConfig(): SmartExitConfig {
  return {
    ...config,
    continuationWeights: { ...config.continuationWeights },
    appliedVersions: { ...config.appliedVersions },
  };
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export async function updateSmartExitConfig(patch: Record<string, unknown>): Promise<SmartExitConfig> {
  const allowed = new Set([
    "mode", "sensitivity", "baseProbabilityDropThreshold",
    "hysteresisSeconds", "hardStopProbabilityDrop", "hardStopWindowSeconds",
    "maxEvidenceAgeSeconds", "minVolatilityLogReturnPerSqrtSecond",
    "fatTailVolatilityMultiplier", "probabilityShrinkage", "rapidLossRatio", "minExitEdge",
    "deepLossHoldThreshold", "terminalLossHoldThreshold", "deepLossRecoveryMinSeconds",
  ]);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`unsupported config field: ${key}`);
  const next: SmartExitConfig = { ...config };
  if (patch.sensitivity !== undefined) {
    if (!["more_aggressive", "default", "less_aggressive"].includes(String(patch.sensitivity))) {
      throw new Error("invalid sensitivity");
    }
    const selected = resolveSmartExitSensitivity(patch.sensitivity);
    Object.assign(next, {
      sensitivity: selected.sensitivity,
      debounceCount: selected.parameters.debounceCount,
      confirmationLevel: selected.parameters.confirmationLevel,
    });
  }
  if (patch.mode !== undefined) {
    const mode = patch.mode;
    if (!["off", "shadow", "paper-exit", "live-exit"].includes(String(mode))) throw new Error("invalid mode");
    Object.assign(next, { mode: mode as SmartExitMode, enabled: mode !== "off" });
  }
  const ranges: Record<string, [number, number]> = {
    baseProbabilityDropThreshold: [0.01, 0.8],
    confirmationLevel: [0, 5],
    debounceCount: [1, 20],
    hysteresisSeconds: [0, 60],
    hardStopProbabilityDrop: [0.05, 0.9],
    hardStopWindowSeconds: [1, 60],
    maxEvidenceAgeSeconds: [1, 15],
    minVolatilityLogReturnPerSqrtSecond: [0.00000001, 0.01],
    fatTailVolatilityMultiplier: [1, 5],
    probabilityShrinkage: [0, 0.9],
    rapidLossRatio: [0.1, 0.9],
    minExitEdge: [0, 0.25],
    deepLossHoldThreshold: [0, 1],
    terminalLossHoldThreshold: [0, 1],
    deepLossRecoveryMinSeconds: [0, 900],
  };
  for (const [name, range] of Object.entries(ranges)) {
    if (patch[name] !== undefined) Object.assign(next, { [name]: boundedNumber(patch[name], range[0], range[1], name) });
  }
  if (patch.debounceCount !== undefined) Object.assign(next, { debounceCount: Math.floor(next.debounceCount) });
  if (next.terminalLossHoldThreshold < next.deepLossHoldThreshold) {
    throw new Error("terminalLossHoldThreshold must be greater than or equal to deepLossHoldThreshold");
  }
  await saveSmartExitConfig(next);
  if (next.mode !== config.mode) {
    latestEvaluations.clear();
    latestValidEvaluations.clear();
  }
  config = next;
  startScheduler();
  return getSmartExitConfig();
}

export async function emergencyDisableSmartExit(): Promise<SmartExitConfig> {
  const next = { ...config, enabled: false, mode: "off" as const };
  await saveSmartExitConfig(next);
  config = next;
  startScheduler();
  return getSmartExitConfig();
}

export function getSmartExitHealth(): SmartExitHealth {
  const evidence = collector.health();
  const evidenceBySymbol: SmartExitHealth["evidenceBySymbol"] = Object.fromEntries(
    Object.entries(evidence.latestBySymbol).map(([symbol, item]) => [symbol, {
      source: item.source,
      ready: item.ready,
      reason: item.ready ? null : item.source === "unsupported"
        ? "qualifying futures tape/L2 provider unavailable"
        : "spot/tape/L2 evidence warming or incomplete",
      observedAt: Number.isFinite(item.observedAtSeconds)
        ? new Date(item.observedAtSeconds * 1_000).toISOString()
        : null,
    }]),
  );
  const readinessValues = Object.values(evidenceBySymbol);
  const dataReadiness = readinessValues.length === 0
    ? "unavailable"
    : readinessValues.every((item) => item.ready)
      ? "ready"
      : readinessValues.some((item) => item.ready) ? "degraded" : "unavailable";
  return {
    running: interval != null && hotInterval != null,
    schedulerActive: interval != null && hotInterval != null,
    mode: config.mode,
    dataReadiness,
    activeEvaluations: latestEvaluations.size,
    lastCycleAt,
    lastError,
    lastCycleDurationMs,
    schedulerOverruns,
    targetCadenceMs: HOT_SCHEDULER_MS,
    slowTargetCadenceMs: SLOW_SCHEDULER_MS,
    lastHotCycleAt,
    lastHotCycleDurationMs,
    hotSchedulerOverruns,
    maximumUsableSampleGapMs,
    pendingPersistenceWrites: persistenceQueue.size,
    evidenceBySymbol,
  };
}

export function getSmartExitStatus(): {
  config: SmartExitConfig;
  health: SmartExitHealth;
  evaluations: Array<SmartExitEvaluationRecord & {
    currentDataStatus: "fresh" | "degraded";
    currentObservationAt: string;
    currentUnavailableReason: string | null;
    liveComponentHealth: SmartExitEvaluationRecord["componentHealth"];
  }>;
} {
  const evaluations = [...latestEvaluations.entries()].map(([key, current]) => {
    const sticky = latestValidEvaluations.get(key) ?? current;
    return {
      ...sticky,
      currentDataStatus: current.recommendation === "unavailable" ? "degraded" as const : "fresh" as const,
      currentObservationAt: current.timestamp,
      currentUnavailableReason: current.recommendation === "unavailable" ? current.reason : null,
      liveComponentHealth: normalizeSmartExitComponentHealth(
        current.componentHealth ?? sticky.componentHealth,
      ),
    };
  });
  return {
    config: getSmartExitConfig(),
    health: getSmartExitHealth(),
    evaluations: evaluations.sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}

export async function getSmartExitHistory(limit = 50): Promise<SmartExitEvaluationRecord[]> {
  return listSmartExitEvaluations({ limit: Math.min(500, Math.max(1, limit)) });
}

export async function resetSmartExitHistory(): Promise<SmartExitHistoryDeleteCounts> {
  const deleted = await deleteSmartExitHistory();
  states.clear();
  modelEntryBaselines.clear();
  latestEvaluations.clear();
  latestValidEvaluations.clear();
  lastEvidencePersistenceMs.clear();
  return deleted;
}

export async function getSmartExitLifecycleLedger(limit = 100): Promise<{
  records: SmartExitLifecycleRecord[];
  coverage: SmartExitCoverageRecord[];
  summary: {
    triggered: number; sold: number; settled: number; helped: number; harmed: number;
    grossMoneySaved: number; grossMoneyForfeited: number; netValue: number;
    scoreable: number; pending: number; coverageTotal: number; unavailable: number;
    /** Legacy signed alias for netValue. */
    totalValueSaved: number;
    /** Confirmed filled exits only; never includes shadow simulations. */
    actual: SmartExitLifecycleAccounting;
    /** Observed advisory shadow economics, kept separate from actual fills. */
    shadowObserved: SmartExitLifecycleAccounting;
  };
}> {
  const [rawRecords, evaluations] = await Promise.all([
    listSmartExitLifecycles(limit),
    listSmartExitCoverageEvaluations({ limit: Math.min(1_000, Math.max(100, limit * 4)) }),
  ]);
  const missingTriggerIds = rawRecords
    .filter((record) =>
      isSmartExitCounterfactualScoreable(record)
      && record.simulatedExitProceeds == null)
    .map((record) => record.triggerEvaluationId);
  const triggerEvaluations = await getSmartExitEvaluationsByIds(missingTriggerIds);
  const triggerById = new Map(triggerEvaluations.map((evaluation) => [evaluation.id, evaluation]));
  const records = rawRecords.map((record) => {
    const trigger = triggerById.get(record.triggerEvaluationId);
    const entryStake = record.entryStake
      ?? record.entryWinningPrice * record.quantity;
    const simulatedExitProceeds = record.simulatedExitProceeds
      ?? (isSmartExitCounterfactualScoreable(record)
        ? getSmartExitShadowProceeds(trigger ?? {
            executionEvidenceReady: false,
            estimatedSaleValue: null,
            liquidityCoverage: null,
            remainingQuantity: 0,
          }, record.quantity)
        : null);
    const simulatedExitPnl = record.simulatedExitPnl
      ?? (simulatedExitProceeds == null ? null : simulatedExitProceeds - entryStake);
    const effectiveness = isSmartExitCounterfactualScoreable(record)
      && record.settlementResult != null
      && simulatedExitProceeds != null
      && record.valueSaved == null
      ? computeSmartExitEffectivenessFromProceeds({
          side: record.side,
          quantity: record.quantity,
          entryStake,
          exitProceeds: simulatedExitProceeds,
          settlementResult: record.settlementResult,
        })
      : {};
    return {
      ...record,
      entryPriceCents: record.entryPriceCents ?? record.entryWinningPrice * 100,
      entryStake,
      requestedQuantity: record.requestedQuantity ?? record.quantity,
      simulatedExitProceeds,
      simulatedExitPnl,
      ...effectiveness,
    };
  });
  const legacyBackfills = records.filter((record, index) => {
    const original = rawRecords[index]!;
    return isSmartExitCounterfactualScoreable(original)
      && original.simulatedExitProceeds == null
      && record.simulatedExitProceeds != null;
  });
  if (legacyBackfills.length > 0) {
    await Promise.all(legacyBackfills.map((record) => upsertSmartExitLifecycle(record)));
  }
  const triggeredKeys = new Set(records.map((record) => identityKey(record.owner, record.positionId)));
  const lifecycleByKey = new Map(records.map((record) => [
    identityKey(record.owner, record.positionId),
    record,
  ]));
  const coverage: SmartExitCoverageRecord[] = evaluations.map((evaluation) => {
    const key = identityKey(evaluation.owner, evaluation.positionId);
    const lifecycle = lifecycleByKey.get(key);
    const entryStake = evaluation.marketAtEntryProbability > 0
      ? evaluation.marketAtEntryProbability * evaluation.remainingQuantity
      : null;
    return {
      owner: evaluation.owner,
      positionId: evaluation.positionId,
      symbol: evaluation.symbol,
      side: evaluation.side,
      evaluatedAt: lifecycle?.triggeredAt ?? evaluation.timestamp,
      status: triggeredKeys.has(key)
        ? "triggered"
        : evaluation.recommendation === "unavailable" ? "unavailable" : "evaluated",
      reasonCode: lifecycle ? "exit_triggered" : evaluation.reasonCode,
      reason: lifecycle?.reason ?? evaluation.reason,
      entryPriceCents: evaluation.marketAtEntryProbability > 0
        ? evaluation.marketAtEntryProbability * 100
        : null,
      contractCount: evaluation.remainingQuantity,
      entryStake,
    };
  });
  const accounting = (included: SmartExitLifecycleRecord[]): SmartExitLifecycleAccounting => {
    const scoreable = included.filter((record) => record.valueSaved != null);
    const grossMoneySaved = scoreable.reduce((sum, record) => sum + Math.max(0, record.valueSaved!), 0);
    const grossMoneyForfeited = scoreable.reduce((sum, record) => sum + Math.max(0, -record.valueSaved!), 0);
    return {
      triggered: included.length,
      settled: included.filter((record) => record.settlementResult != null).length,
      scoreable: scoreable.length,
      pending: included.length - scoreable.length,
      helped: scoreable.filter((record) => record.valueSaved! > 0.005).length,
      harmed: scoreable.filter((record) => record.valueSaved! < -0.005).length,
      grossMoneySaved,
      grossMoneyForfeited,
      netValue: grossMoneySaved - grossMoneyForfeited,
    };
  };
  const actual = accounting(records.filter((record) => record.executionStatus === "filled"));
  const shadowObserved = accounting(records.filter((record) => record.advisoryOnly));
  const legacy = accounting(records);
  return {
    records,
    coverage,
    summary: {
      triggered: records.length,
      sold: records.filter((r) => r.executionStatus === "filled").length,
      settled: records.filter((r) => r.settlementResult != null).length,
      helped: legacy.helped,
      harmed: legacy.harmed,
      grossMoneySaved: legacy.grossMoneySaved,
      grossMoneyForfeited: legacy.grossMoneyForfeited,
      netValue: legacy.netValue,
      scoreable: legacy.scoreable,
      pending: legacy.pending,
      coverageTotal: coverage.length,
      unavailable: coverage.filter((item) => item.status === "unavailable").length,
      totalValueSaved: legacy.netValue,
      actual,
      shadowObserved,
    },
  };
}

let canonicalReplayRefresh: Promise<void> | null = null;

export async function getSmartExitReplayReports(): Promise<Array<Record<string, unknown>>> {
  let [reports, canonicalGlobal, lifecycles] = await Promise.all([
    listSmartExitReplayReports({ limit: 100 }),
    getSmartExitReplayReportByIdentity({
      owner: "regular",
      symbol: "GLOBAL",
      version: "global-counterfactual-v1",
    }),
    listSmartExitLifecycles(100),
  ]);
  const latestSettledAt = Math.max(
    0,
    ...lifecycles
      .filter((record) => record.settlementResult != null && record.settledAt != null)
      .map((record) => Date.parse(record.settledAt!))
      .filter(Number.isFinite),
  );
  const canonicalCreatedAt = canonicalGlobal?.createdAt == null
    ? 0
    : new Date(canonicalGlobal.createdAt).getTime();
  if (latestSettledAt > canonicalCreatedAt) {
    canonicalReplayRefresh ??= calibrateSmartExitFromDurableHistory()
      .then(() => undefined)
      .catch((error) => {
        logger.warn({ error }, "[kalshi-smart-exit] automatic counterfactual refresh failed");
      })
      .finally(() => {
        canonicalReplayRefresh = null;
      });
    await canonicalReplayRefresh;
    [reports, canonicalGlobal] = await Promise.all([
      listSmartExitReplayReports({ limit: 100 }),
      getSmartExitReplayReportByIdentity({
        owner: "regular",
        symbol: "GLOBAL",
        version: "global-counterfactual-v1",
      }),
    ]);
  }
  const ordered = canonicalGlobal
    ? [canonicalGlobal, ...reports.filter((report) => report.id !== canonicalGlobal.id)]
    : reports;
  return ordered.map((report) => ({ id: report.id, owner: report.owner, symbol: report.symbol,
    version: report.version, status: report.status, createdAt: report.createdAt, ...report.payload }));
}

/**
 * Builds advisory reports from persisted one-second evaluations and fresh,
 * authoritative Kalshi settlements. It never changes mode, config, applied
 * versions, owner authorization, or order state.
 */
export async function calibrateSmartExitFromDurableHistory(params: {
  owner?: SmartExitOwnerKind;
  symbol?: string;
  limitPositions?: number;
} = {}): Promise<Array<Record<string, unknown>>> {
  const sources = await listSmartExitReplaySources({
    owner: params.owner,
    symbol: params.symbol?.toUpperCase(),
    limitPositions: params.limitPositions,
  });
  const settledSources = sources.filter((source) =>
    source.expiryTimestampSeconds <= Date.now() / 1_000);
  const settlementByTicker = new Map<string, "yes" | "no" | null>();
  const tickers = [...new Set(settledSources.map((source) => source.ticker))];
  for (let index = 0; index < tickers.length; index += 5) {
    const batch = tickers.slice(index, index + 5);
    const results = await Promise.all(batch.map(async (ticker) => {
      try {
        const settlement = await fetchKalshiMarketResult(ticker);
        return [ticker, settlement.result === "yes" || settlement.result === "no"
          ? settlement.result
          : null] as const;
      } catch (error) {
        logger.warn({ error, ticker }, "[kalshi-smart-exit] replay settlement unavailable");
        return [ticker, null] as const;
      }
    }));
    for (const [ticker, result] of results) settlementByTicker.set(ticker, result);
  }
  const isUnfilteredCalibration = isSmartExitGlobalCalibration(params);
  const snapshotId = randomUUID();
  const hasScoreableEvidence = (source: (typeof settledSources)[number]) =>
    source.evaluations.some((evaluation) =>
      evaluation.executionEvidenceReady
      && evaluation.estimatedSaleValue != null
      && Number.isFinite(evaluation.estimatedSaleValue)
      && evaluation.remainingQuantity === source.quantity
      && evaluation.liquidityCoverage != null
      && evaluation.liquidityCoverage >= 1);
  const toSettlement = (source: (typeof settledSources)[number]) => {
    const settlementResult = settlementByTicker.get(source.ticker)!;
    const holdValue = settlementResult === source.side ? source.quantity : 0;
    return {
      owner: source.owner,
      positionId: source.positionId,
      symbol: source.symbol,
      regime: "unclassified",
      entryTimestampSeconds: source.entryTimestampSeconds,
      expiryTimestampSeconds: source.expiryTimestampSeconds,
      entryContractCost: source.entryContractCost,
      quantity: source.quantity,
      holdToExpiryPnl: holdValue - source.entryContractCost * source.quantity,
    };
  };
  const buildComparisons = (
    comparisonSettlements: ReturnType<typeof toSettlement>[],
    comparisonEvaluations: SmartExitEvaluationRecord[],
  ) => Object.fromEntries(([
    "more_aggressive",
    "default",
    "less_aggressive",
  ] as const).map((canonicalSensitivity) => {
    const modeLifecycles = buildCrossingRiskReplayLifecycles(
      comparisonSettlements,
      comparisonEvaluations,
      {
        sensitivity: canonicalSensitivity,
        minExitEdge: config.minExitEdge,
        minCrossingReserveSeconds: 5,
        maxCrossingReserveSeconds: 30,
        deepLossHoldThreshold: config.deepLossHoldThreshold,
        terminalLossHoldThreshold: config.terminalLossHoldThreshold,
        deepLossRecoveryMinSeconds: config.deepLossRecoveryMinSeconds,
      },
    );
    return [canonicalSensitivity, {
      sensitivity: canonicalSensitivity,
      ...summarizeSmartExitComparison(modeLifecycles),
    }];
  }));
  const authoritativeSnapshot = settledSources.filter((source) =>
    settlementByTicker.get(source.ticker) != null);
  const scoreableSnapshot = authoritativeSnapshot.filter(hasScoreableEvidence);
  const globalSettlements = scoreableSnapshot.map(toSettlement);
  const globalPeriod = {
    from: globalSettlements.length
      ? new Date(Math.min(...globalSettlements.map((item) => item.entryTimestampSeconds)) * 1_000).toISOString()
      : null,
    to: globalSettlements.length
      ? new Date(Math.max(...globalSettlements.map((item) => item.expiryTimestampSeconds)) * 1_000).toISOString()
      : null,
  };
  const globalComparison = {
    snapshotId,
    comparisons: buildComparisons(
      globalSettlements,
      scoreableSnapshot.flatMap((source) => source.evaluations),
    ),
    sharedCoverage: {
      eligible: globalSettlements.length,
      scoreable: globalSettlements.length,
      excluded: settledSources.length - globalSettlements.length,
      missingSettlement: settledSources.length - authoritativeSnapshot.length,
      insufficientEvidence: authoritativeSnapshot.length - scoreableSnapshot.length,
      period: globalPeriod,
    },
  };
  if (isUnfilteredCalibration) {
    await insertSmartExitReplayReport({
      id: "smart-exit:global-counterfactual-v1",
      owner: "regular",
      symbol: "GLOBAL",
      version: "global-counterfactual-v1",
      status: "insufficient_data",
      payload: {
        kind: "global_counterfactual",
        advisoryOnly: true,
        globalComparison,
      },
    });
  }
  const groups = new Map<string, typeof settledSources>();
  for (const source of settledSources) {
    const key = `${source.owner}:${source.symbol}`;
    (groups.get(key) ?? (() => {
      const value: typeof settledSources = [];
      groups.set(key, value);
      return value;
    })()).push(source);
  }
  const reports: Array<Record<string, unknown>> = [];
  if (isUnfilteredCalibration) {
    reports.push({
      owner: "regular",
      symbol: "GLOBAL",
      version: "global-counterfactual-v1",
      status: "insufficient_data",
      kind: "global_counterfactual",
      advisoryOnly: true,
      globalComparison,
    });
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    const authoritative = group.filter((source) => settlementByTicker.get(source.ticker) != null);
    const scoreableSources = authoritative.filter(hasScoreableEvidence);
    const settlements = scoreableSources.map(toSettlement);
    const evaluations = scoreableSources.flatMap((source) => source.evaluations);
    const sensitivity = resolveSmartExitSensitivity(config.sensitivity);
    const candidateParameters = {
      sensitivity: sensitivity.sensitivity,
      debounceCount: sensitivity.parameters.debounceCount,
      confirmationLevel: sensitivity.parameters.confirmationLevel,
      minMarketLossFraction: sensitivity.parameters.minMarketLossFraction,
      minExitEdge: config.minExitEdge,
      crossingReserveFraction: sensitivity.parameters.crossingReserveFraction,
      minCrossingReserveSeconds: 5,
      maxCrossingReserveSeconds: 30,
      deepLossHoldThreshold: config.deepLossHoldThreshold,
      terminalLossHoldThreshold: config.terminalLossHoldThreshold,
      deepLossRecoveryMinSeconds: config.deepLossRecoveryMinSeconds,
    } as const;
    const lifecycles = buildCrossingRiskReplayLifecycles(
      settlements,
      evaluations,
      candidateParameters,
    );
    const calibration = calibrateSmartExit(lifecycles, {
      slippageAssumptions: [{ cents: 1 }, { cents: 2 }],
      maxTotalPnlSacrifice: 0,
      maxSlippageTotalPnlSacrifice: 0,
    });
    const comparisons = buildComparisons(settlements, evaluations);
    const period = {
      from: settlements.length
        ? new Date(Math.min(...settlements.map((item) => item.entryTimestampSeconds)) * 1_000).toISOString()
        : null,
      to: settlements.length
        ? new Date(Math.max(...settlements.map((item) => item.expiryTimestampSeconds)) * 1_000).toISOString()
        : null,
    };
    const sharedCoverage = {
      eligible: settlements.length,
      scoreable: settlements.length,
      excluded: group.length - settlements.length,
      missingSettlement: group.length - authoritative.length,
      insufficientEvidence: authoritative.length - scoreableSources.length,
      period,
    };
    const version = [
      "crossing-risk-v2",
      sensitivity.sensitivity,
      `d${candidateParameters.debounceCount}`,
      `c${candidateParameters.confirmationLevel.toFixed(2)}`,
      `m${candidateParameters.minMarketLossFraction.toFixed(2)}`,
      `dl${candidateParameters.deepLossHoldThreshold.toFixed(2)}`,
      `tl${candidateParameters.terminalLossHoldThreshold.toFixed(2)}`,
      `r${candidateParameters.deepLossRecoveryMinSeconds}`,
    ].join("-");
    const payload = {
      totalEvaluated: lifecycles.length,
      exitsRecommended: lifecycles.filter((item) => item.candidateExit !== null).length,
      authoritativeSettlementCount: settlements.length,
      hypotheticalPnlSaved: calibration.report.overall.totalPnlDelta,
      calibrationScore: calibration.holdout?.totalPnlDelta ?? null,
      chronologicalHoldoutPassed: calibration.status === "validated",
      slippageSensitivityPassed: calibration.status === "validated",
      liveEligible: calibration.status === "validated",
      advisoryOnly: true,
      parameters: candidateParameters,
      reasons: calibration.reasons,
      overall: calibration.report.overall,
      training: calibration.training,
      holdout: calibration.holdout,
      slippage: calibration.report.slippage,
      comparisons,
      sharedCoverage,
    };
    await insertSmartExitReplayReport({
      id: `${first.owner}:${first.symbol}:${version}`,
      owner: first.owner,
      symbol: first.symbol,
      version,
      status: calibration.status,
      payload,
    });
    reports.push({
      owner: first.owner,
      symbol: first.symbol,
      version,
      status: calibration.status,
      ...payload,
    });
  }
  return reports;
}

/** Only a full, owner-and-symbol-unfiltered run may replace the global replay snapshot. */
export function isSmartExitGlobalCalibration(params: {
  owner?: SmartExitOwnerKind;
  symbol?: string;
  limitPositions?: number;
}): boolean {
  return params.owner === undefined
    && params.symbol === undefined
    && params.limitPositions === undefined;
}

export async function applySmartExitParameterVersion(params: {
  owner: SmartExitOwnerKind;
  symbol: string;
  version: string;
}): Promise<SmartExitConfig> {
  const symbol = params.symbol.toUpperCase();
  const report = await getValidatedSmartExitParameterReport(params.owner, symbol);
  if (!report || report.version !== params.version) {
    throw new Error("parameter version is not validated for this owner and symbol");
  }
  const payload = report.payload;
  const holdoutPassed = payload.chronologicalHoldoutPassed === true;
  const slippagePassed = payload.slippageSensitivityPassed === true;
  if (!holdoutPassed || !slippagePassed) {
    throw new Error("validated report lacks required holdout and slippage evidence");
  }
  const reportParameters = payload.parameters as Partial<NonNullable<SmartExitAppliedVersion["parameters"]>> | undefined;
  if (
    reportParameters == null
    || !Number.isFinite(reportParameters.debounceCount)
    || !Number.isFinite(reportParameters.confirmationLevel)
    || !Number.isFinite(reportParameters.minMarketLossFraction)
    || !Number.isFinite(reportParameters.crossingReserveFraction)
    || !Number.isFinite(reportParameters.minExitEdge)
    || !Number.isFinite(reportParameters.deepLossHoldThreshold)
    || !Number.isFinite(reportParameters.terminalLossHoldThreshold)
    || !Number.isFinite(reportParameters.deepLossRecoveryMinSeconds)
  ) {
    throw new Error("validated report lacks a complete immutable parameter snapshot");
  }
  const reportSensitivity = reportParameters.sensitivity;
  if (
    reportSensitivity !== "more_aggressive"
    && reportSensitivity !== "default"
    && reportSensitivity !== "less_aggressive"
  ) throw new Error("validated report lacks a valid frozen sensitivity");
  const canonical = resolveSmartExitSensitivity(reportSensitivity);
  if (
    reportParameters.debounceCount !== canonical.parameters.debounceCount
    || reportParameters.confirmationLevel !== canonical.parameters.confirmationLevel
    || reportParameters.minMarketLossFraction !== canonical.parameters.minMarketLossFraction
    || reportParameters.crossingReserveFraction !== canonical.parameters.crossingReserveFraction
  ) throw new Error("validated report sensitivity thresholds are malformed");
  const applied: SmartExitAppliedVersion = {
    owner: params.owner,
    symbol,
    version: params.version,
    liveEligible: payload.liveEligible === true,
    appliedAt: new Date().toISOString(),
    parameters: {
      sensitivity: reportSensitivity,
      debounceCount: Math.floor(reportParameters.debounceCount!),
      confirmationLevel: reportParameters.confirmationLevel!,
      minMarketLossFraction: reportParameters.minMarketLossFraction!,
      crossingReserveFraction: reportParameters.crossingReserveFraction!,
      minExitEdge: reportParameters.minExitEdge!,
      deepLossHoldThreshold: reportParameters.deepLossHoldThreshold!,
      terminalLossHoldThreshold: reportParameters.terminalLossHoldThreshold!,
      deepLossRecoveryMinSeconds: reportParameters.deepLossRecoveryMinSeconds!,
    },
  };
  const next: SmartExitConfig = {
    ...config,
    appliedVersions: { ...config.appliedVersions, [smartExitVersionKey(params.owner, symbol)]: applied },
  };
  const success = await applyValidatedSmartExitParameterVersion({
    owner: params.owner,
    symbol,
    version: params.version,
    config: next,
  });
  if (!success) throw new Error("parameter version changed before application");
  config = next;
  return getSmartExitConfig();
}