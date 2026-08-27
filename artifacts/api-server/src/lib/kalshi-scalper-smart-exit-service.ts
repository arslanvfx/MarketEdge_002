// Operational shell for the dedicated high-value Scalper exit subsystem.
// Monitoring/execution ownership is deliberately separate from regular Smart
// Exit; in particular this module never imports closePosition or regular state.
import { logger } from "./logger.ts";
import { randomUUID } from "node:crypto";
import { fetchKalshiTarget, fetchOrderbookPrices, getKalshiCachedData } from "./crypto-kalshi.ts";
import { getTickerFreshEvidence } from "./crypto-data.ts";
import { CRYPTO_COINS } from "./market-defs.ts";
import { getUnsettledScalpOrders } from "./kalshi-scalper-db.ts";
import {
  computeScalpExitYesLimitPrice,
  parseDefinitiveScalpOrderRejection,
  placeScalpExitOrderStrict,
  reconcileScalpExitOrderStrict,
} from "./kalshi-scalper-exchange.ts";
import {
  claimScalperExitLifecycle, claimScalperExitRequest, listScalperExitEvidenceForReplay,
  finalizeSettledScalperExitLifecycles, getScalperExitOrderStates,
  getScalperExitLifecyclesByOrderIds,
  listPendingScalperExitRequests, listScalperExitLifecycles, loadScalperExitConfig,
  recordScalperExitEvaluation, releaseScalperExitLifecycle, resolveScalperExitRequest,
  runScalperExitMigrations,
  saveScalperExitConfig,
} from "./kalshi-scalper-smart-exit-db.ts";
import {
  computeScalperExitExecutableDepth, DEFAULT_SCALPER_EXIT_CONFIG,
  evaluateScalperExit, isScalperExitEvidenceFetchFresh,
  SCALPER_TERMINAL_STOP_LOSS_FLOOR,
  type ScalperExitConfig,
  type ScalperExitDecision, type ScalperExitInput, type ScalperExitSample,
  type ScalperExitSensitivity,
} from "./kalshi-scalper-smart-exit-policy.ts";
import { runClaimedScalperExitLifecycle } from "./kalshi-scalper-smart-exit-lifecycle.ts";
import {
  advanceScalperExitSamples,
  AbortableRequestRegistry,
  type AbortableCoalescedRequest,
  ScalperHotCadenceTracker,
  ScalperExitPriorityGate,
  type ScalperExitWorkPriority,
  selectScalperHotCandidates,
} from "./kalshi-scalper-smart-exit-scheduler.ts";
import type { ScalpOrder } from "./kalshi-scalper-types.ts";

let config: ScalperExitConfig = { ...DEFAULT_SCALPER_EXIT_CONFIG };
let version = 0;
let started = false;
let lastError: string | null = null;
let hotTimer: ReturnType<typeof setInterval> | null = null;
let discoveryTimer: ReturnType<typeof setInterval> | null = null;
let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
const samples = new Map<string, ScalperExitSample[]>();
const latestEvaluations = new Map<string, Record<string, unknown>>();
const PRODUCT_BY_SYMBOL = new Map(CRYPTO_COINS.map((coin) => [coin.symbol.toUpperCase(), coin.product]));
let lastReconciledAt = 0;
let lastSettlementAt = 0;
let lastEvaluationFlushAt = 0;
let discoveryInFlight = false;
let maintenanceInFlight = false;
const hotOrdersInFlight = new Set<string>();
const activeOrders = new Map<string, { order: ScalpOrder; remainingQuantity: number }>();
const pendingEvaluationWrites = new Map<string, Parameters<typeof recordScalperExitEvaluation>[0]>();
const HOT_SCHEDULER_MS = 250;
const DISCOVERY_SCHEDULER_MS = 500;
const MAINTENANCE_SCHEDULER_MS = 1_000;
const MAX_HOT_CONCURRENCY = Math.max(16, CRYPTO_COINS.length * 2);
const HOT_EVIDENCE_DEADLINE_MS = 700;
const MAX_SAMPLE_HISTORY = 32;
let latestHotTickGapMs: number | null = null;
let worstRecentHotTickGapMs: number | null = null;
const hotCadence = new ScalperHotCadenceTracker();
let coalescedHotOrderPasses = 0;
let completedHotOrderPasses = 0;
let lastDiscoveryAtMs: number | null = null;
let hotEvidenceDeadlineBreaches = 0;
let hotOverloadBreaches = 0;
let lastHotOverloadAtMs: number | null = null;
type HotReceipt<T> = { value: T; receivedAtMs: number };
type HotSpotEvidence = Awaited<ReturnType<typeof getTickerFreshEvidence>>;
type HotBookEvidence = NonNullable<Awaited<ReturnType<typeof fetchOrderbookPrices>>>;
const hotSpotRequests = new AbortableRequestRegistry<HotReceipt<HotSpotEvidence> | null>();
const hotBookRequests = new AbortableRequestRegistry<HotReceipt<HotBookEvidence> | null>();
const hotTargetRequests = new AbortableRequestRegistry<number | null>();
// The process-wide PostgreSQL pool has five connections. Smart Exit may use at
// most two concurrently, so entry-critical reservation/cap work always retains
// capacity. Lifecycle writes outrank observational history/reporting work.
const smartExitDbGate = new ScalperExitPriorityGate(2);

function runSmartExitDb<T>(
  work: () => Promise<T>,
  priority: ScalperExitWorkPriority = "critical",
): Promise<T> {
  return smartExitDbGate.run(work, priority);
}

function numeric(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function expiry(windowKey: string): number { const at = Date.parse(`${windowKey}:00Z`); return Number.isFinite(at) ? at + 900_000 : 0; }
function isBeforeExpiry(order: ScalpOrder, nowMs = Date.now()): boolean {
  const expiresAtMs = expiry(order.windowKey);
  return expiresAtMs > 0 && nowMs < expiresAtMs;
}
function modeIncludesOrder(order: ScalpOrder): boolean {
  if (config.mode === "shadow") return true;
  if (config.mode === "paper-exit") return order.mode === "paper";
  if (config.mode === "live-exit") return order.mode === "live";
  return false;
}
function appendSample(
  orderId: string,
  price: number,
  atMs = Date.now(),
  sourceAtMs: number | null = null,
  sourceSequence: string | null = null,
): ScalperExitSample[] {
  const history = advanceScalperExitSamples(
    samples.get(orderId) ?? [],
    { atMs, price, sourceAtMs, sourceSequence },
    MAX_SAMPLE_HISTORY,
  );
  samples.set(orderId, history);
  return history;
}

function getHotSpotReceipt(
  product: string,
): AbortableCoalescedRequest<HotReceipt<HotSpotEvidence> | null> {
  return hotSpotRequests.getOrCreate(product, (signal) =>
    getTickerFreshEvidence(product, signal)
    .then((value) => ({ value, receivedAtMs: Date.now() }))
    .catch(() => null));
}

function getHotBookReceipt(
  ticker: string,
): AbortableCoalescedRequest<HotReceipt<HotBookEvidence> | null> {
  return hotBookRequests.getOrCreate(ticker, (signal) =>
    fetchOrderbookPrices(ticker, signal)
    .then((value) => value == null ? null : ({ value, receivedAtMs: Date.now() }))
    .catch(() => null));
}

function getHotTarget(
  order: ScalpOrder,
  cachedMarket: ReturnType<typeof getKalshiCachedData>,
): AbortableCoalescedRequest<number | null> {
  if (cachedMarket?.ticker === order.ticker) {
    return { promise: Promise.resolve(cachedMarket.value), abort: () => {} };
  }
  return hotTargetRequests.getOrCreate(order.ticker, (signal) => fetchKalshiTarget(
    order.symbol,
    new Date(expiry(order.windowKey)),
    true,
    signal,
  ).catch(() => null));
}

async function withinHotEvidenceDeadline<T>(
  work: Promise<T>,
  startedAtMs: number,
  onTimeout?: () => void,
): Promise<{ ready: true; value: T } | { ready: false }> {
  const remainingMs = HOT_EVIDENCE_DEADLINE_MS - (Date.now() - startedAtMs);
  if (remainingMs <= 0) return { ready: false };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ ready: false }>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve({ ready: false });
    }, remainingMs);
    timer.unref?.();
  });
  const result = await Promise.race([
    work.then((value) => ({ ready: true as const, value })),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

function publishHotBlock(
  order: ScalpOrder,
  remainingQuantity: number,
  reason: string,
  slaBreached: boolean,
): void {
  const nowMs = Date.now();
  latestEvaluations.set(order.id, {
    orderId: order.id,
    symbol: order.symbol,
    ticker: order.ticker,
    side: order.side,
    mode: config.mode,
    remainingQuantity,
    disposition: "blocked",
    reason,
    secondsRemaining: Math.max(0, (expiry(order.windowKey) - nowMs) / 1_000),
    sampleCount: samples.get(order.id)?.length ?? 0,
    latestGapMs: null,
    worstGapMs: null,
    sourceAgeMs: null,
    schedulerGapMs: latestHotTickGapMs,
    slaBreached,
    updatedAt: new Date(nowMs).toISOString(),
  });
}

function buildInput(params: {
  order: ScalpOrder; target: number | null; history: ScalperExitSample[];
  book: Awaited<ReturnType<typeof fetchOrderbookPrices>>; remainingQuantity: number;
  entryWinningPrice: number; executableQuantity: number;
  executablePrice: number | null; nowMs: number;
  terminalStopLossExecutableQuantity?: number;
  terminalStopLossWinningProbability?: number | null;
  valuePreservingExecutableQuantity?: number;
  valuePreservingWinningProbability?: number | null;
  evaluationConfig?: ScalperExitConfig;
  quoteAtMs?: number;
  bookAtMs?: number;
}): ScalperExitInput {
  return {
    side: params.order.side,
    target: params.target,
    samples: params.history,
    nowMs: params.nowMs,
    expiresAtMs: expiry(params.order.windowKey),
    entryWinningProbability: params.entryWinningPrice,
    currentWinningProbability: params.executablePrice,
    quoteAtMs: params.quoteAtMs ?? params.nowMs,
    bookAtMs: params.bookAtMs ?? params.nowMs,
    executableQuantity: params.executableQuantity,
    remainingQuantity: params.remainingQuantity,
    depthAtFloor: params.executableQuantity >= params.remainingQuantity,
    terminalStopLossExecutableQuantity:
      params.terminalStopLossExecutableQuantity ?? params.executableQuantity,
    terminalStopLossWinningProbability:
      params.terminalStopLossWinningProbability ?? params.executablePrice,
    valuePreservingExecutableQuantity:
      params.valuePreservingExecutableQuantity ?? params.executableQuantity,
    valuePreservingWinningProbability:
      params.valuePreservingWinningProbability ?? params.executablePrice,
    config: params.evaluationConfig ?? config,
    requireSourceTimestamps: true,
  };
}

function serializeLifecycle(row: Record<string, unknown>): Record<string, unknown> {
  const numberOrNull = (key: string) => row[key] == null ? null : Number(row[key]);
  return {
    id: String(row.id),
    scalpOrderId: String(row.scalp_order_id),
    mode: String(row.mode),
    symbol: String(row.symbol),
    ticker: String(row.ticker),
    windowKey: String(row.window_key),
    side: String(row.side),
    quantity: numberOrNull("remaining_quantity"),
    status: String(row.status),
    triggerReason: row.trigger_reason == null ? null : String(row.trigger_reason),
    evidence: row.evidence ?? null,
    executableQuantity: numberOrNull("executable_quantity"),
    executablePrice: numberOrNull("executable_price"),
    exitFillQuantity: numberOrNull("exit_fill_quantity"),
    exitWinningPrice: numberOrNull("exit_winning_price"),
    proceeds: numberOrNull("proceeds"),
    exitPnl: numberOrNull("exit_pnl"),
    entryWinningPrice: numberOrNull("entry_winning_price"),
    entryStake: numberOrNull("entry_stake"),
    settlementResult: row.settlement_result ?? null,
    holdValue: numberOrNull("hold_value"),
    holdPnl: numberOrNull("hold_pnl"),
    valueSaved: numberOrNull("value_saved"),
    verdict: row.verdict ?? "pending",
    triggeredAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    soldAt: row.sold_at == null ? null : row.sold_at instanceof Date ? row.sold_at.toISOString() : String(row.sold_at),
    settledAt: row.settled_at == null ? null : row.settled_at instanceof Date ? row.settled_at.toISOString() : String(row.settled_at),
  };
}

async function reconcilePendingRequests(): Promise<void> {
  const pending = await runSmartExitDb(
    () => listPendingScalperExitRequests(),
    "background",
  );
  for (const row of pending) {
    const payload = row.payload && typeof row.payload === "object"
      ? row.payload as Record<string, unknown>
      : {};
    const count = numeric(payload.remainingQuantity);
    const yesLimitPrice = numeric(payload.yesLimitPrice);
    const exchangeIndex = numeric(payload.exchangeIndex);
    const originalSide = row.side === "yes" || row.side === "no" ? row.side : null;
    const createdAt = row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at));
    if (!originalSide || count == null || count <= 0 || yesLimitPrice == null
      || exchangeIndex == null || !Number.isInteger(exchangeIndex)
      || !Number.isFinite(createdAt.getTime())) {
      await runSmartExitDb(() => resolveScalperExitRequest({
        id: String(row.id), status: "unknown",
        reason: "durable request identity is incomplete; reconciliation blocked",
        evidence: { source: "local_request_validation", blocked: true },
      }));
      continue;
    }
    const result = await reconcileScalpExitOrderStrict({
      ticker: String(row.ticker),
      exchangeIndex,
      originalSide,
      count,
      yesLimitPrice,
      clientOrderId: String(row.client_order_id),
      exchangeOrderId: row.exchange_order_id == null ? null : String(row.exchange_order_id),
      createdAt,
    });
    if (result.outcome === "ambiguous") {
      await runSmartExitDb(() => resolveScalperExitRequest({
        id: String(row.id), status: "unknown", reason: result.reason,
        evidence: result.evidence,
      }));
    } else if (result.outcome === "zero_fill") {
      await runSmartExitDb(() => resolveScalperExitRequest({
        id: String(row.id), status: "zero_fill", reason: result.reason,
        exchangeOrderId: result.orderId, evidence: result.evidence,
      }));
    } else {
      await runSmartExitDb(() => resolveScalperExitRequest({
        id: String(row.id),
        status: result.filledCount + 1e-9 >= count ? "filled" : "partial",
        reason: result.reason,
        fillQuantity: result.filledCount,
        winningPrice: result.winningPrice,
        exchangeOrderId: result.orderId,
        evidence: result.evidence,
      }));
    }
  }
}

async function executeExit(params: {
  order: ScalpOrder; lifecycleId: string; remainingQuantity: number;
  floor: number; history: ScalperExitSample[]; expectedExchangeIndex: number;
  configVersion: number; exitMode: ScalperExitConfig["mode"];
  authorization: "trajectory" | "quote_lag" | "terminal_stop";
}): Promise<void> {
  const requestId = randomUUID();
  const clientOrderId = `scalp-exit-${requestId}`;
  const yesLimitPrice = computeScalpExitYesLimitPrice(params.order.side, params.floor);
  await runClaimedScalperExitLifecycle({
    revalidate: async () => {
      if (!isBeforeExpiry(params.order)) {
        return {
          ready: false as const,
          reason: "market expired before final revalidation",
          evidence: { stage: "pre_submit_expiry" },
        };
      }
      const latest = await runSmartExitDb(() => loadScalperExitConfig());
      if (!latest.config.enabled || latest.config.mode !== params.exitMode
        || latest.version !== params.configVersion) {
        return {
          ready: false as const,
          reason: "config version changed during final pre-submit validation",
          evidence: { stage: "pre_submit_config" },
        };
      }
      if (!isBeforeExpiry(params.order)) {
        return {
          ready: false as const,
          reason: "market expired while loading final configuration",
          evidence: { stage: "post_config_expiry" },
        };
      }
      const fetchStartedAt = Date.now();
      const finalEvidenceController = new AbortController();
      const product = PRODUCT_BY_SYMBOL.get(params.order.symbol.toUpperCase());
      if (!product) {
        return {
          ready: false as const,
          reason: "final spot product identity is unavailable",
          evidence: { stage: "pre_submit_product_identity" },
        };
      }
      const finalBatch = await withinHotEvidenceDeadline(Promise.all([
        getTickerFreshEvidence(product, finalEvidenceController.signal).catch(() => null),
        fetchKalshiTarget(
          params.order.symbol,
          new Date(expiry(params.order.windowKey)),
          true,
          finalEvidenceController.signal,
        ).catch(() => null),
        fetchOrderbookPrices(params.order.ticker, finalEvidenceController.signal).catch(() => null),
      ]), fetchStartedAt, () => finalEvidenceController.abort());
      if (!finalBatch.ready) {
        return {
          ready: false as const,
          reason: `final evidence exceeded ${HOT_EVIDENCE_DEADLINE_MS}ms deadline`,
          evidence: { stage: "pre_submit_evidence_deadline" },
        };
      }
      const [spotEvidence, target, book] = finalBatch.value;
      const refreshedMarket = getKalshiCachedData(params.order.symbol);
      const receiptAt = Date.now();
      if (!isBeforeExpiry(params.order, receiptAt)) {
        return {
          ready: false as const,
          reason: "market expired during final evidence fetch",
          evidence: { stage: "post_fetch_expiry" },
        };
      }
      const freshEvidence = isScalperExitEvidenceFetchFresh(
        fetchStartedAt,
        receiptAt,
        latest.config.maxEvidenceAgeSeconds,
      );
      if (!spotEvidence || !book || !refreshedMarket || refreshedMarket.ticker !== params.order.ticker
        || refreshedMarket.exchangeIndex !== params.expectedExchangeIndex || !freshEvidence) {
        return {
          ready: false as const,
          reason: "final exact identity or fresh evidence revalidation failed",
          evidence: { stage: "pre_submit_identity", freshEvidence },
        };
      }
      const nowMs = Date.now();
      const finalHistory = appendSample(
        params.order.id,
        spotEvidence.price,
        nowMs,
      spotEvidence.publishedAtMs == null
        ? null
        : Math.min(spotEvidence.publishedAtMs, nowMs),
      spotEvidence.sourceSequence ?? null,
      );
      const entryWinningPrice = params.order.winningContractCost
        ?? (params.order.side === "yes" ? params.order.entryYesPrice : 1 - params.order.entryYesPrice);
      const trajectoryFloor = Math.max(0.01, Math.min(0.99, entryWinningPrice * 0.5));
      const executable = computeScalperExitExecutableDepth(
        params.order.side,
        book.yesDepth,
        book.noDepth,
        params.remainingQuantity,
        trajectoryFloor,
      );
      const terminalStopLossExecutable = computeScalperExitExecutableDepth(
        params.order.side,
        book.yesDepth,
        book.noDepth,
        params.remainingQuantity,
        SCALPER_TERMINAL_STOP_LOSS_FLOOR,
      );
      const valuePreservingFloor = Math.min(0.99, entryWinningPrice + 0.01);
      const valuePreservingExecutable = computeScalperExitExecutableDepth(
        params.order.side,
        book.yesDepth,
        book.noDepth,
        params.remainingQuantity,
        valuePreservingFloor,
      );
      const finalDecision = evaluateScalperExit(buildInput({
        order: params.order, target, history: finalHistory, book,
        remainingQuantity: params.remainingQuantity, entryWinningPrice,
        executableQuantity: executable.quantity,
        executablePrice: executable.price,
        terminalStopLossExecutableQuantity: terminalStopLossExecutable.quantity,
        terminalStopLossWinningProbability: terminalStopLossExecutable.price,
        valuePreservingExecutableQuantity: valuePreservingExecutable.quantity,
        valuePreservingWinningProbability: valuePreservingExecutable.price,
        nowMs,
        evaluationConfig: latest.config,
      }));
      if (finalDecision.disposition !== "exit") {
        return {
          ready: false as const,
          reason: `final policy revalidation: ${finalDecision.reason}`,
          evidence: { stage: "pre_submit_policy", finalDecision },
        };
      }
      const finalUsesQuoteLagProtection = finalDecision.reason
        === "persistent target breach with value-preserving authenticated depth";
      const finalUsesTerminalStopLoss = finalDecision.reason
        === "persistent target breach with authenticated full-position stop-loss depth";
      const finalAuthorization = finalUsesQuoteLagProtection
        ? "quote_lag"
        : finalUsesTerminalStopLoss ? "terminal_stop" : "trajectory";
      if (finalAuthorization !== params.authorization) {
        return {
          ready: false as const,
          reason: "final policy authorization changed before submission",
          evidence: {
            stage: "pre_submit_policy_floor",
            finalDecision,
            expectedAuthorization: params.authorization,
            finalAuthorization,
          },
        };
      }
      const selectedExecutable = params.authorization === "quote_lag"
        ? valuePreservingExecutable
        : params.authorization === "terminal_stop"
          ? terminalStopLossExecutable
          : executable;
      if (selectedExecutable.price == null
        || selectedExecutable.quantity + 1e-9 < params.remainingQuantity) {
        return {
          ready: false as const,
          reason: "final authorized depth does not cover the remaining position",
          evidence: { stage: "pre_submit_authorized_depth", finalDecision },
        };
      }
      return {
        ready: true as const,
        value: {
          executablePrice: selectedExecutable.price,
          exchangeIndex: refreshedMarket.exchangeIndex,
          finalDecision,
        },
      };
    },
    release: (blocked) => runSmartExitDb(() => releaseScalperExitLifecycle({
      id: params.lifecycleId,
      reason: blocked.reason,
      evidence: blocked.evidence,
    })),
    claimRequest: async () => {
      if (!isBeforeExpiry(params.order)) {
        await runSmartExitDb(() => releaseScalperExitLifecycle({
          id: params.lifecycleId,
          reason: "market expired before durable request claim",
          evidence: { stage: "request_claim_expiry" },
        }));
        return false;
      }
      const request = await runSmartExitDb(() => claimScalperExitRequest({
        id: requestId, lifecycleId: params.lifecycleId, clientOrderId,
        payload: {
          orderId: params.order.id, ticker: params.order.ticker, side: params.order.side,
          remainingQuantity: params.remainingQuantity, configVersion: params.configVersion, yesLimitPrice,
          exchangeIndex: params.expectedExchangeIndex,
        },
      }));
      return request.claimed;
    },
    submit: async (prepared) => {
      const submitConfig = await runSmartExitDb(() => loadScalperExitConfig());
      if (!submitConfig.config.enabled || submitConfig.config.mode !== params.exitMode
        || submitConfig.version !== params.configVersion) {
        await runSmartExitDb(() => resolveScalperExitRequest({
          id: requestId,
          status: "blocked",
          reason: "config version changed after durable request claim, before submit",
          evidence: { stage: "durable_request_pre_submit" },
        }));
        return;
      }
      if (!isBeforeExpiry(params.order)) {
        await runSmartExitDb(() => resolveScalperExitRequest({
          id: requestId,
          status: "blocked",
          reason: "market expired after durable request claim, before broker submit",
          evidence: { stage: "broker_submit_expiry" },
        }));
        return;
      }
      if (params.exitMode === "paper-exit") {
        await runSmartExitDb(() => resolveScalperExitRequest({
          id: requestId, status: "filled", reason: "paper simulated canonical executable fill",
          fillQuantity: params.remainingQuantity, winningPrice: prepared.executablePrice,
          evidence: { adapter: "paper", finalDecision: prepared.finalDecision },
        }));
        return;
      }
      if (params.exitMode !== "live-exit") {
        await runSmartExitDb(() => resolveScalperExitRequest({
          id: requestId, status: "blocked",
          reason: "execution adapter unavailable for current mode",
        }));
        return;
      }
      try {
        if (!isBeforeExpiry(params.order)) {
          await runSmartExitDb(() => resolveScalperExitRequest({
            id: requestId,
            status: "blocked",
            reason: "market expired at final broker boundary",
            evidence: { stage: "final_broker_boundary_expiry" },
          }));
          return;
        }
        const result = await placeScalpExitOrderStrict({
          ticker: params.order.ticker,
          exchangeIndex: prepared.exchangeIndex,
          originalSide: params.order.side,
          minimumWinningPrice: params.floor,
          count: params.remainingQuantity,
          clientOrderId,
        });
        await runSmartExitDb(() => resolveScalperExitRequest({
          id: requestId,
          status: "unknown",
          reason: result.outcome === "confirmed_fill" || result.outcome === "zero_fill"
            ? `awaiting authenticated reconciliation after ${result.reason}`
            : result.reason,
          exchangeOrderId: result.orderId,
          evidence: { source: "submit_response", finalDecision: prepared.finalDecision },
        }));
      } catch (error) {
        const definitive = parseDefinitiveScalpOrderRejection(error);
        await runSmartExitDb(() => resolveScalperExitRequest(definitive ? {
          id: requestId, status: "zero_fill", reason: definitive.message,
          evidence: { source: "definitive_http_rejection", status: definitive.status, code: definitive.code },
        } : {
          id: requestId, status: "unknown", reason: `ambiguous transport: ${String(error)}`,
          evidence: { source: "submit_exception", ambiguous: true },
        }));
      }
    },
  });
}

async function processOrder(
  order: ScalpOrder,
  remainingQuantity: number,
  evaluationConfig: ScalperExitConfig,
  evaluationVersion: number,
): Promise<void> {
  if (remainingQuantity <= 0) return;
  if (!isBeforeExpiry(order)) {
    publishHotBlock(order, remainingQuantity, "market already expired", false);
    return;
  }
  const product = PRODUCT_BY_SYMBOL.get(order.symbol.toUpperCase());
  if (!product) throw new Error(`unsupported Scalper Smart Exit product: ${order.symbol}`);
  const fetchStartedAt = Date.now();
  const cachedMarket = getKalshiCachedData(order.symbol);
  const spotRequest = getHotSpotReceipt(product);
  const targetRequest = getHotTarget(order, cachedMarket);
  const bookRequest = getHotBookReceipt(order.ticker);
  const evidenceBatch = await withinHotEvidenceDeadline(Promise.all([
    spotRequest.promise,
    targetRequest.promise,
    bookRequest.promise,
  ]), fetchStartedAt, () => {
    spotRequest.abort();
    targetRequest.abort();
    bookRequest.abort();
  });
  if (!evidenceBatch.ready) {
    hotEvidenceDeadlineBreaches += 1;
    publishHotBlock(
      order,
      remainingQuantity,
      `hot evidence exceeded ${HOT_EVIDENCE_DEADLINE_MS}ms deadline`,
      true,
    );
    return;
  }
  const [spotReceipt, target, bookReceipt] = evidenceBatch.value;
  const refreshedMarket = getKalshiCachedData(order.symbol);
  const receiptAt = Date.now();
  if (!spotReceipt || !bookReceipt?.value || !refreshedMarket || refreshedMarket.ticker !== order.ticker
    || refreshedMarket.exchangeIndex == null
    || !isScalperExitEvidenceFetchFresh(
      fetchStartedAt,
      receiptAt,
      evaluationConfig.maxEvidenceAgeSeconds,
    )) {
    publishHotBlock(order, remainingQuantity, "hot evidence unavailable or exact identity changed", false);
    return;
  }
  const history = appendSample(
    order.id,
    spotReceipt.value.price,
    spotReceipt.receivedAtMs,
    spotReceipt.value.publishedAtMs == null
      ? null
      : Math.min(spotReceipt.value.publishedAtMs, spotReceipt.receivedAtMs),
    spotReceipt.value.sourceSequence ?? null,
  );
  const entryWinningPrice = order.winningContractCost
    ?? (order.side === "yes" ? order.entryYesPrice : 1 - order.entryYesPrice);
  const floor = Math.max(0.01, Math.min(0.99, entryWinningPrice * 0.5));
  const executable = computeScalperExitExecutableDepth(
    order.side,
    bookReceipt.value.yesDepth,
    bookReceipt.value.noDepth,
    remainingQuantity,
    floor,
  );
  const valuePreservingFloor = Math.min(0.99, entryWinningPrice + 0.01);
  const valuePreservingExecutable = computeScalperExitExecutableDepth(
    order.side,
    bookReceipt.value.yesDepth,
    bookReceipt.value.noDepth,
    remainingQuantity,
    valuePreservingFloor,
  );
  const terminalStopLossExecutable = computeScalperExitExecutableDepth(
    order.side,
    bookReceipt.value.yesDepth,
    bookReceipt.value.noDepth,
    remainingQuantity,
    SCALPER_TERMINAL_STOP_LOSS_FLOOR,
  );
  const nowMs = receiptAt;
  const input = buildInput({
    order, target, history, book: bookReceipt.value, remainingQuantity, entryWinningPrice,
    executableQuantity: executable.quantity,
    executablePrice: executable.price,
    terminalStopLossExecutableQuantity: terminalStopLossExecutable.quantity,
    terminalStopLossWinningProbability: terminalStopLossExecutable.price,
    valuePreservingExecutableQuantity: valuePreservingExecutable.quantity,
    valuePreservingWinningProbability: valuePreservingExecutable.price,
    nowMs,
    evaluationConfig,
    quoteAtMs: spotReceipt.receivedAtMs,
    bookAtMs: bookReceipt.receivedAtMs,
  });
  const decision = evaluateScalperExit(input);
  const evidence = {
    decision, input: { ...input, samples: history }, target,
    entryWinningPrice, executablePrice: executable.price, floor,
    scheduler: {
      schedulerMs: HOT_SCHEDULER_MS,
      latestHotTickGapMs,
      worstRecentHotTickGapMs,
      coalescedHotOrderPasses,
    },
  };
  latestEvaluations.set(order.id, {
    orderId: order.id, symbol: order.symbol, ticker: order.ticker, side: order.side,
    mode: evaluationConfig.mode, remainingQuantity, ...decision,
    sampleGapMs: decision.latestGapMs,
    schedulerGapMs: latestHotTickGapMs,
    updatedAt: new Date(nowMs).toISOString(),
  });
  pendingEvaluationWrites.set(order.id, {
    id: randomUUID(), scalpOrderId: order.id, mode: evaluationConfig.mode, symbol: order.symbol,
    ticker: order.ticker, windowKey: order.windowKey, side: order.side,
    remainingQuantity, evidence,
  });
  if (decision.disposition !== "exit") return;
  if (version !== evaluationVersion || config.mode !== evaluationConfig.mode
    || !config.enabled) return;
  if (!isBeforeExpiry(order)) {
    publishHotBlock(order, remainingQuantity, "market expired before ownership claim", false);
    return;
  }
  const quoteLagAuthorization = decision.reason
    === "persistent target breach with value-preserving authenticated depth";
  const terminalStopAuthorization = decision.reason
    === "persistent target breach with authenticated full-position stop-loss depth";
  const authorizedFloor = quoteLagAuthorization
    ? valuePreservingFloor
    : terminalStopAuthorization ? SCALPER_TERMINAL_STOP_LOSS_FLOOR : floor;
  const authorizedExecutable = quoteLagAuthorization
    ? valuePreservingExecutable
    : terminalStopAuthorization ? terminalStopLossExecutable : executable;
  const lifecycle = await runSmartExitDb(() => claimScalperExitLifecycle({
    id: randomUUID(), scalpOrderId: order.id, mode: evaluationConfig.mode, symbol: order.symbol,
    ticker: order.ticker, windowKey: order.windowKey, side: order.side, remainingQuantity,
    status: evaluationConfig.mode === "shadow" ? "advisory" : "requested",
    triggerReason: decision.reason, evidence, executableQuantity: authorizedExecutable.quantity,
    executablePrice: authorizedExecutable.price, entryWinningPrice, configVersion: evaluationVersion,
  }));
  if (!lifecycle.id || evaluationConfig.mode === "shadow") return;
  if (!lifecycle.claimed && lifecycle.status !== "zero_fill") return;
  await executeExit({
    order, lifecycleId: lifecycle.id, remainingQuantity, floor: authorizedFloor, history,
    expectedExchangeIndex: refreshedMarket.exchangeIndex,
    configVersion: evaluationVersion,
    exitMode: evaluationConfig.mode,
    authorization: quoteLagAuthorization
      ? "quote_lag" : terminalStopAuthorization ? "terminal_stop" : "trajectory",
  });
}

async function refreshActiveOrders(): Promise<void> {
  if (discoveryInFlight) return;
  discoveryInFlight = true;
  try {
    if (!config.enabled || config.mode === "off") {
      activeOrders.clear();
      return;
    }
    const orders = await runSmartExitDb(
      () => getUnsettledScalpOrders(),
      "background",
    );
    const eligible = orders.filter((order) =>
      (order.status === "filled" || order.status === "paper")
      && order.filledCount > 0
      && expiry(order.windowKey) > Date.now()
      && modeIncludesOrder(order));
    const statesByOrder = await runSmartExitDb(
      () => getScalperExitOrderStates(eligible.map((order) => order.id)),
      "background",
    );
    const nextIds = new Set<string>();
    for (const order of eligible) {
      const orderState = statesByOrder.get(order.id);
      if (orderState?.hasUnresolvedOwner
        || (config.mode === "shadow" && orderState?.hasShadowAdvisory)) {
        continue;
      }
      const remainingQuantity = Math.max(
        0,
        order.filledCount - (orderState?.filledQuantity ?? 0),
      );
      if (remainingQuantity <= 0) continue;
      nextIds.add(order.id);
      activeOrders.set(order.id, { order, remainingQuantity });
    }
    for (const orderId of activeOrders.keys()) {
      if (!nextIds.has(orderId)) {
        activeOrders.delete(orderId);
        samples.delete(orderId);
        latestEvaluations.delete(orderId);
        pendingEvaluationWrites.delete(orderId);
      }
    }
    lastDiscoveryAtMs = Date.now();
    lastError = null;
  } catch (error) {
    lastError = String(error);
    logger.warn({ error }, "[kalshi-scalper-exit] active-order discovery failed closed");
  } finally {
    discoveryInFlight = false;
  }
}

function noteHotTick(nowMs: number): void {
  const cadence = hotCadence.recordTick(nowMs);
  latestHotTickGapMs = cadence.latestGapMs;
  worstRecentHotTickGapMs = cadence.worstRecentGapMs;
}

function runHotMonitorPass(): void {
  noteHotTick(Date.now());
  if (!config.enabled || config.mode === "off") return;
  const evaluationConfig = { ...config };
  const evaluationVersion = version;
  const selection = selectScalperHotCandidates(
    [...activeOrders.values()].map((candidate) => ({
      ...candidate,
      id: candidate.order.id,
      lastSampleAtMs: samples.get(candidate.order.id)?.at(-1)?.atMs ?? 0,
    })),
    hotOrdersInFlight,
    MAX_HOT_CONCURRENCY,
  );
  if (activeOrders.size > MAX_HOT_CONCURRENCY) {
    hotOverloadBreaches += 1;
    lastHotOverloadAtMs = Date.now();
    const selectedIds = new Set(selection.selected.map((candidate) => candidate.id));
    for (const candidate of activeOrders.values()) {
      if (!selectedIds.has(candidate.order.id)
        && !hotOrdersInFlight.has(candidate.order.id)) {
        publishHotBlock(
          candidate.order,
          candidate.remainingQuantity,
          "hot-lane capacity exceeded; evaluation deferred by oldest-sample priority",
          true,
        );
      }
    }
  }
  for (const candidate of selection.selected) {
    hotOrdersInFlight.add(candidate.order.id);
    void processOrder(
      candidate.order,
      candidate.remainingQuantity,
      evaluationConfig,
      evaluationVersion,
    ).catch((error) => {
      lastError = String(error);
      logger.warn(
        { error, orderId: candidate.order.id },
        "[kalshi-scalper-exit] hot order evaluation failed closed",
      );
    }).finally(() => {
      completedHotOrderPasses += 1;
      hotOrdersInFlight.delete(candidate.order.id);
    });
  }
  coalescedHotOrderPasses += selection.coalescedCount;
}

async function flushEvaluationWrites(): Promise<void> {
  if (pendingEvaluationWrites.size === 0) return;
  const writes = [...pendingEvaluationWrites.values()];
  pendingEvaluationWrites.clear();
  const results = await Promise.allSettled(writes.map((write) =>
    runSmartExitDb(
      () => recordScalperExitEvaluation(write),
      "background",
    )));
  for (let index = 0; index < results.length; index++) {
    if (results[index]!.status === "rejected") {
      pendingEvaluationWrites.set(writes[index]!.scalpOrderId, writes[index]!);
    }
  }
}

async function runMaintenance(): Promise<void> {
  if (maintenanceInFlight) return;
  maintenanceInFlight = true;
  try {
    const now = Date.now();
    if (now - lastEvaluationFlushAt >= 1_000) {
      await flushEvaluationWrites();
      lastEvaluationFlushAt = now;
    }
    if (now - lastReconciledAt >= 5_000) {
      await reconcilePendingRequests();
      lastReconciledAt = now;
    }
    if (now - lastSettlementAt >= 30_000) {
      await runSmartExitDb(
        () => finalizeSettledScalperExitLifecycles(),
        "background",
      );
      lastSettlementAt = now;
    }
  } catch (error) {
    lastError = String(error);
    logger.warn({ error }, "[kalshi-scalper-exit] maintenance lane failed closed");
  } finally {
    maintenanceInFlight = false;
  }
}

export async function initScalperSmartExit(): Promise<void> {
  await runSmartExitDb(() => runScalperExitMigrations());
  const loaded = await runSmartExitDb(() => loadScalperExitConfig());
  config = loaded.config; version = loaded.version; started = true;
  await reconcilePendingRequests();
  await runSmartExitDb(
    () => finalizeSettledScalperExitLifecycles(),
    "background",
  );
  await refreshActiveOrders();
  if (hotTimer) clearInterval(hotTimer);
  if (discoveryTimer) clearInterval(discoveryTimer);
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  hotTimer = setInterval(runHotMonitorPass, HOT_SCHEDULER_MS); hotTimer.unref?.();
  discoveryTimer = setInterval(() => void refreshActiveOrders(), DISCOVERY_SCHEDULER_MS);
  discoveryTimer.unref?.();
  maintenanceTimer = setInterval(() => void runMaintenance(), MAINTENANCE_SCHEDULER_MS);
  maintenanceTimer.unref?.();
  logger.info({
    mode: config.mode,
    enabled: config.enabled,
    hotSchedulerMs: HOT_SCHEDULER_MS,
    discoverySchedulerMs: DISCOVERY_SCHEDULER_MS,
  }, "[kalshi-scalper-exit] initialized isolated sub-second subsystem");
}
export function getScalperSmartExitStatus() {
  return { started, config: { ...config }, configVersion: version, lastError,
    schedulerMs: HOT_SCHEDULER_MS,
    scheduler: {
      hotSchedulerMs: HOT_SCHEDULER_MS,
      discoverySchedulerMs: DISCOVERY_SCHEDULER_MS,
      activeOrders: activeOrders.size,
      activeEvaluations: hotOrdersInFlight.size,
      latestHotTickGapMs,
      worstRecentHotTickGapMs,
      coalescedHotOrderPasses,
      completedHotOrderPasses,
      evidenceDeadlineMs: HOT_EVIDENCE_DEADLINE_MS,
      evidenceDeadlineBreaches: hotEvidenceDeadlineBreaches,
      overloadBreaches: hotOverloadBreaches,
      lastOverloadAt: lastHotOverloadAtMs == null
        ? null
        : new Date(lastHotOverloadAtMs).toISOString(),
      lastDiscoveryAt: lastDiscoveryAtMs == null ? null : new Date(lastDiscoveryAtMs).toISOString(),
      sharedDbLane: smartExitDbGate.snapshot(),
    },
    evaluations: [...latestEvaluations.values()],
    isolation: "dedicated_scalper_exit_ledger_and_exchange_boundary" };
}
export async function getScalperSmartExitLifecycle(limit?: number) {
  const records = (await runSmartExitDb(
    () => listScalperExitLifecycles(limit),
    "background",
  )).map(serializeLifecycle);
  type Accounting = {
    triggered: number; settled: number; scoreable: number; pending: number;
    helped: number; harmed: number; grossMoneySaved: number;
    grossMoneyForfeited: number; netValue: number;
  };
  const accounting = (rows: Record<string, unknown>[]) => rows.reduce<Accounting>((summary, row) => {
    const value = numeric(row.valueSaved);
    summary.triggered += 1;
    if (row.settledAt) summary.settled += 1; else summary.pending += 1;
    if (value != null) {
      summary.scoreable += 1;
      if (value > 0) { summary.helped += 1; summary.grossMoneySaved += value; }
      if (value < 0) { summary.harmed += 1; summary.grossMoneyForfeited += Math.abs(value); }
      summary.netValue += value;
    }
    return summary;
  }, { triggered: 0, settled: 0, scoreable: 0, pending: 0, helped: 0, harmed: 0, grossMoneySaved: 0, grossMoneyForfeited: 0, netValue: 0 });
  return {
    records,
    summary: {
      actual: accounting(records.filter((row) => row.status !== "advisory")),
      shadowObserved: accounting(records.filter((row) => row.status === "advisory")),
    },
  };
}
export async function getScalperSmartExitHistoryProjection(orderIds: readonly string[]) {
  const rows = await runSmartExitDb(
    () => getScalperExitLifecyclesByOrderIds(orderIds),
    "background",
  );
  const byOrderId = new Map<string, Record<string, unknown>>();
  const aggregates = new Map<string, { fill: number; exitPnl: number }>();
  for (const row of rows) {
    const orderId = String(row.scalp_order_id);
    if (!byOrderId.has(orderId)) byOrderId.set(orderId, serializeLifecycle(row));
    const aggregate = aggregates.get(orderId) ?? { fill: 0, exitPnl: 0 };
    aggregate.fill += Number(row.exit_fill_quantity) || 0;
    aggregate.exitPnl += Number(row.exit_pnl) || 0;
    aggregates.set(orderId, aggregate);
  }
  for (const [orderId, projection] of byOrderId) {
    const aggregate = aggregates.get(orderId)!;
    projection.totalExitFillQuantity = aggregate.fill;
    projection.totalExitPnl = aggregate.exitPnl;
  }
  return byOrderId;
}
export async function getScalperSmartExitReplay() {
  const rows = await runSmartExitDb(
    () => listScalperExitEvidenceForReplay(),
    "background",
  );
  const sensitivities: ScalperExitSensitivity[] = ["more_aggressive", "default", "less_aggressive"];
  const byOrder = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const id = String(row.scalp_order_id);
    const list = byOrder.get(id) ?? [];
    list.push(row);
    byOrder.set(id, list);
  }
  const reports = sensitivities.map((sensitivity) => {
    let triggered = 0, helped = 0, harmed = 0, unchanged = 0;
    let grossMoneySaved = 0, grossMoneyForfeited = 0, netValue = 0, excluded = 0;
    for (const snapshots of byOrder.values()) {
      let scored = false;
      for (const row of snapshots) {
        const evidence = row.evidence && typeof row.evidence === "object"
          ? row.evidence as Record<string, unknown>
          : null;
        const rawInput = evidence?.input;
        if (!rawInput || typeof rawInput !== "object") { excluded += 1; break; }
        const input = rawInput as ScalperExitInput;
        const decision = evaluateScalperExit({
          ...input,
          config: { ...input.config, enabled: true, mode: "shadow", sensitivity },
        });
        if (decision.disposition !== "exit") continue;
        const exitPrice = numeric(evidence?.executablePrice);
        const entryPrice = numeric(evidence?.entryWinningPrice);
        const quantity = numeric(row.remaining_quantity);
        const settlement = row.settlement_result === "yes" || row.settlement_result === "no"
          ? row.settlement_result
          : null;
        const side = row.side === "yes" || row.side === "no" ? row.side : null;
        if (exitPrice == null || entryPrice == null || quantity == null || !settlement || !side) {
          excluded += 1; break;
        }
        const exitPnl = (exitPrice - entryPrice) * quantity;
        const holdPnl = (settlement === side ? 1 - entryPrice : -entryPrice) * quantity;
        const value = exitPnl - holdPnl;
        triggered += 1;
        if (value > 0) { helped += 1; grossMoneySaved += value; }
        else if (value < 0) { harmed += 1; grossMoneyForfeited += Math.abs(value); }
        else unchanged += 1;
        netValue += value;
        scored = true;
        break;
      }
      if (!scored) unchanged += 1;
    }
    return {
      sensitivity, triggered, helped, harmed, unchanged,
      grossMoneySaved, grossMoneyForfeited, netValue,
      sharedCoverage: { eligibleOrders: byOrder.size, excludedSnapshots: excluded },
    };
  });
  return {
    snapshot: "identical_persisted_evaluation_set",
    reports,
    disclaimer: "Replay uses only persisted authenticated executable snapshots. Historical positions without post-entry evidence, including the August 26 ETH and DOGE losses, are excluded rather than assigned fabricated savings.",
  };
}
export async function updateScalperSmartExitConfig(patch: Record<string, unknown>) {
  const allowed = new Set(["enabled", "mode", "sensitivity", "maxEvidenceAgeSeconds"]);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`unsupported scalper exit config field: ${key}`);
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled must be boolean");
  if (patch.mode !== undefined && !["off", "shadow", "paper-exit", "live-exit"].includes(String(patch.mode))) throw new Error("invalid exit mode");
  if (patch.sensitivity !== undefined && !["more_aggressive", "default", "less_aggressive"].includes(String(patch.sensitivity))) throw new Error("invalid sensitivity");
  if (patch.maxEvidenceAgeSeconds !== undefined && (typeof patch.maxEvidenceAgeSeconds !== "number" || patch.maxEvidenceAgeSeconds < 1 || patch.maxEvidenceAgeSeconds > 5)) throw new Error("maxEvidenceAgeSeconds must be 1..5");
  // No update promotes to live implicitly: live requires the explicit mode and
  // enabled fields in the same authenticated operator request.
  if (patch.mode === "live-exit" && patch.enabled !== true) throw new Error("live-exit requires enabled=true in the same authenticated request");
  const saved = await runSmartExitDb(
    () => saveScalperExitConfig({ ...config, ...patch }),
  );
  config = saved.config; version = saved.version;
  return { ...config };
}
export async function emergencyDisableScalperSmartExit() {
  const saved = await runSmartExitDb(
    () => saveScalperExitConfig({ ...config, enabled: false, mode: "off" }),
  );
  config = saved.config; version = saved.version;
  return { ...config };
}