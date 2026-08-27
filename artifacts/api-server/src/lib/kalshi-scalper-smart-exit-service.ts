// Operational shell for the dedicated high-value Scalper exit subsystem.
// Monitoring/execution ownership is deliberately separate from regular Smart
// Exit; in particular this module never imports closePosition or regular state.
import { logger } from "./logger.ts";
import { randomUUID } from "node:crypto";
import { fetchKalshiTarget, fetchOrderbookPrices, getKalshiCachedData } from "./crypto-kalshi.ts";
import { getTickerFresh } from "./crypto-data.ts";
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
  finalizeSettledScalperExitLifecycles, getScalperExitFilledQuantity,
  getScalperExitLifecyclesByOrderIds,
  listPendingScalperExitRequests, listScalperExitLifecycles, loadScalperExitConfig,
  recordScalperExitEvaluation, releaseScalperExitLifecycle, resolveScalperExitRequest,
  runScalperExitMigrations,
  saveScalperExitConfig,
} from "./kalshi-scalper-smart-exit-db.ts";
import {
  computeScalperExitExecutableDepth, DEFAULT_SCALPER_EXIT_CONFIG,
  evaluateScalperExit, isScalperExitEvidenceFetchFresh,
  type ScalperExitConfig,
  type ScalperExitDecision, type ScalperExitInput, type ScalperExitSample,
  type ScalperExitSensitivity,
} from "./kalshi-scalper-smart-exit-policy.ts";
import { runClaimedScalperExitLifecycle } from "./kalshi-scalper-smart-exit-lifecycle.ts";
import type { ScalpOrder } from "./kalshi-scalper-types.ts";

let config: ScalperExitConfig = { ...DEFAULT_SCALPER_EXIT_CONFIG };
let version = 0;
let started = false;
let lastError: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
const samples = new Map<string, ScalperExitSample[]>();
const latestEvaluations = new Map<string, Record<string, unknown>>();
const PRODUCT_BY_SYMBOL = new Map(CRYPTO_COINS.map((coin) => [coin.symbol.toUpperCase(), coin.product]));
let lastReconciledAt = 0;
let lastSettlementAt = 0;

function numeric(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function expiry(windowKey: string): number { const at = Date.parse(`${windowKey}:00Z`); return Number.isFinite(at) ? at + 900_000 : 0; }
function modeIncludesOrder(order: ScalpOrder): boolean {
  if (config.mode === "shadow") return true;
  if (config.mode === "paper-exit") return order.mode === "paper";
  if (config.mode === "live-exit") return order.mode === "live";
  return false;
}
function appendSample(orderId: string, price: number, atMs = Date.now()): ScalperExitSample[] {
  const history = samples.get(orderId) ?? [];
  const prior = history[history.length - 1];
  if (!prior || atMs > prior.atMs) history.push({ atMs, price });
  while (history.length > 6) history.shift();
  samples.set(orderId, history);
  return history;
}

function buildInput(params: {
  order: ScalpOrder; target: number | null; history: ScalperExitSample[];
  book: Awaited<ReturnType<typeof fetchOrderbookPrices>>; remainingQuantity: number;
  entryWinningPrice: number; executableQuantity: number;
  executablePrice: number | null; nowMs: number;
}): ScalperExitInput {
  return {
    side: params.order.side,
    target: params.target,
    samples: params.history,
    nowMs: params.nowMs,
    expiresAtMs: expiry(params.order.windowKey),
    entryWinningProbability: params.entryWinningPrice,
    currentWinningProbability: params.executablePrice,
    quoteAtMs: params.nowMs,
    bookAtMs: params.nowMs,
    executableQuantity: params.executableQuantity,
    remainingQuantity: params.remainingQuantity,
    depthAtFloor: params.executableQuantity >= params.remainingQuantity,
    config,
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
  const pending = await listPendingScalperExitRequests();
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
      await resolveScalperExitRequest({
        id: String(row.id), status: "unknown",
        reason: "durable request identity is incomplete; reconciliation blocked",
        evidence: { source: "local_request_validation", blocked: true },
      });
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
      await resolveScalperExitRequest({
        id: String(row.id), status: "unknown", reason: result.reason,
        evidence: result.evidence,
      });
    } else if (result.outcome === "zero_fill") {
      await resolveScalperExitRequest({
        id: String(row.id), status: "zero_fill", reason: result.reason,
        exchangeOrderId: result.orderId, evidence: result.evidence,
      });
    } else {
      await resolveScalperExitRequest({
        id: String(row.id),
        status: result.filledCount + 1e-9 >= count ? "filled" : "partial",
        reason: result.reason,
        fillQuantity: result.filledCount,
        winningPrice: result.winningPrice,
        exchangeOrderId: result.orderId,
        evidence: result.evidence,
      });
    }
  }
}

async function executeExit(params: {
  order: ScalpOrder; lifecycleId: string; remainingQuantity: number;
  floor: number; history: ScalperExitSample[]; expectedExchangeIndex: number;
}): Promise<void> {
  const requestId = randomUUID();
  const clientOrderId = `scalp-exit-${requestId}`;
  const yesLimitPrice = computeScalpExitYesLimitPrice(params.order.side, params.floor);
  await runClaimedScalperExitLifecycle({
    revalidate: async () => {
      const latest = await loadScalperExitConfig();
      if (!latest.config.enabled || latest.config.mode !== config.mode || latest.version !== version) {
        return {
          ready: false as const,
          reason: "config version changed during final pre-submit validation",
          evidence: { stage: "pre_submit_config" },
        };
      }
      const fetchStartedAt = Date.now();
      const product = PRODUCT_BY_SYMBOL.get(params.order.symbol.toUpperCase());
      if (!product) {
        return {
          ready: false as const,
          reason: "final spot product identity is unavailable",
          evidence: { stage: "pre_submit_product_identity" },
        };
      }
      const [spot, target, book] = await Promise.all([
        getTickerFresh(product).catch(() => null),
        fetchKalshiTarget(params.order.symbol, new Date(expiry(params.order.windowKey)), true).catch(() => null),
        fetchOrderbookPrices(params.order.ticker).catch(() => null),
      ]);
      const refreshedMarket = getKalshiCachedData(params.order.symbol);
      const receiptAt = Date.now();
      const freshEvidence = isScalperExitEvidenceFetchFresh(
        fetchStartedAt,
        receiptAt,
        latest.config.maxEvidenceAgeSeconds,
      );
      if (spot == null || !book || !refreshedMarket || refreshedMarket.ticker !== params.order.ticker
        || refreshedMarket.exchangeIndex !== params.expectedExchangeIndex || !freshEvidence) {
        return {
          ready: false as const,
          reason: "final exact identity or fresh evidence revalidation failed",
          evidence: { stage: "pre_submit_identity", freshEvidence },
        };
      }
      const nowMs = Date.now();
      const finalHistory = appendSample(params.order.id, spot, nowMs);
      const executable = computeScalperExitExecutableDepth(
        params.order.side,
        book.yesDepth,
        book.noDepth,
        params.remainingQuantity,
        params.floor,
      );
      const entryWinningPrice = params.order.winningContractCost
        ?? (params.order.side === "yes" ? params.order.entryYesPrice : 1 - params.order.entryYesPrice);
      const finalDecision = evaluateScalperExit(buildInput({
        order: params.order, target, history: finalHistory, book,
        remainingQuantity: params.remainingQuantity, entryWinningPrice,
        executableQuantity: executable.quantity,
        executablePrice: executable.price,
        nowMs,
      }));
      if (finalDecision.disposition !== "exit" || executable.price == null) {
        return {
          ready: false as const,
          reason: `final policy revalidation: ${finalDecision.reason}`,
          evidence: { stage: "pre_submit_policy", finalDecision },
        };
      }
      return {
        ready: true as const,
        value: {
          executablePrice: executable.price,
          exchangeIndex: refreshedMarket.exchangeIndex,
          finalDecision,
        },
      };
    },
    release: (blocked) => releaseScalperExitLifecycle({
      id: params.lifecycleId,
      reason: blocked.reason,
      evidence: blocked.evidence,
    }),
    claimRequest: async () => {
      const request = await claimScalperExitRequest({
        id: requestId, lifecycleId: params.lifecycleId, clientOrderId,
        payload: {
          orderId: params.order.id, ticker: params.order.ticker, side: params.order.side,
          remainingQuantity: params.remainingQuantity, configVersion: version, yesLimitPrice,
          exchangeIndex: params.expectedExchangeIndex,
        },
      });
      return request.claimed;
    },
    submit: async (prepared) => {
      const submitConfig = await loadScalperExitConfig();
      if (!submitConfig.config.enabled || submitConfig.config.mode !== config.mode
        || submitConfig.version !== version) {
        await resolveScalperExitRequest({
          id: requestId,
          status: "blocked",
          reason: "config version changed after durable request claim, before submit",
          evidence: { stage: "durable_request_pre_submit" },
        });
        return;
      }
      if (config.mode === "paper-exit") {
        await resolveScalperExitRequest({
          id: requestId, status: "filled", reason: "paper simulated canonical executable fill",
          fillQuantity: params.remainingQuantity, winningPrice: prepared.executablePrice,
          evidence: { adapter: "paper", finalDecision: prepared.finalDecision },
        });
        return;
      }
      if (config.mode !== "live-exit") {
        await resolveScalperExitRequest({
          id: requestId, status: "blocked",
          reason: "execution adapter unavailable for current mode",
        });
        return;
      }
      try {
        const result = await placeScalpExitOrderStrict({
          ticker: params.order.ticker,
          exchangeIndex: prepared.exchangeIndex,
          originalSide: params.order.side,
          minimumWinningPrice: params.floor,
          count: params.remainingQuantity,
          clientOrderId,
        });
        await resolveScalperExitRequest({
          id: requestId,
          status: "unknown",
          reason: result.outcome === "confirmed_fill" || result.outcome === "zero_fill"
            ? `awaiting authenticated reconciliation after ${result.reason}`
            : result.reason,
          exchangeOrderId: result.orderId,
          evidence: { source: "submit_response", finalDecision: prepared.finalDecision },
        });
      } catch (error) {
        const definitive = parseDefinitiveScalpOrderRejection(error);
        await resolveScalperExitRequest(definitive ? {
          id: requestId, status: "zero_fill", reason: definitive.message,
          evidence: { source: "definitive_http_rejection", status: definitive.status, code: definitive.code },
        } : {
          id: requestId, status: "unknown", reason: `ambiguous transport: ${String(error)}`,
          evidence: { source: "submit_exception", ambiguous: true },
        });
      }
    },
  });
}

async function processOrder(order: ScalpOrder): Promise<void> {
  const previouslySold = await getScalperExitFilledQuantity(order.id);
  const remainingQuantity = Math.max(0, order.filledCount - previouslySold);
  if (remainingQuantity <= 0) return;
  const product = PRODUCT_BY_SYMBOL.get(order.symbol.toUpperCase());
  if (!product) throw new Error(`unsupported Scalper Smart Exit product: ${order.symbol}`);
  const fetchStartedAt = Date.now();
  const cachedMarket = getKalshiCachedData(order.symbol);
  const targetPromise = cachedMarket?.ticker === order.ticker
    ? Promise.resolve(cachedMarket.target)
    : fetchKalshiTarget(
        order.symbol,
        new Date(expiry(order.windowKey)),
        true,
      ).catch(() => null);
  const [spot, target, book] = await Promise.all([
    getTickerFresh(product).catch(() => null),
    targetPromise,
    fetchOrderbookPrices(order.ticker).catch(() => null),
  ]);
  const refreshedMarket = getKalshiCachedData(order.symbol);
  const receiptAt = Date.now();
  if (spot == null || !book || !refreshedMarket || refreshedMarket.ticker !== order.ticker
    || refreshedMarket.exchangeIndex == null
    || !isScalperExitEvidenceFetchFresh(
      fetchStartedAt,
      receiptAt,
      config.maxEvidenceAgeSeconds,
    )) return;
  const nowMs = Date.now();
  const history = appendSample(order.id, spot, nowMs);
  const entryWinningPrice = order.winningContractCost
    ?? (order.side === "yes" ? order.entryYesPrice : 1 - order.entryYesPrice);
  const floor = Math.max(0.01, Math.min(0.99, entryWinningPrice * 0.5));
  const executable = computeScalperExitExecutableDepth(
    order.side,
    book.yesDepth,
    book.noDepth,
    remainingQuantity,
    floor,
  );
  const input = buildInput({
    order, target, history, book, remainingQuantity, entryWinningPrice,
    executableQuantity: executable.quantity,
    executablePrice: executable.price,
    nowMs,
  });
  const decision = evaluateScalperExit(input);
  const evidence = {
    decision, input: { ...input, samples: history }, target,
    entryWinningPrice, executablePrice: executable.price, floor,
  };
  latestEvaluations.set(order.id, {
    orderId: order.id, symbol: order.symbol, ticker: order.ticker, side: order.side,
    mode: config.mode, remainingQuantity, ...decision, updatedAt: new Date(nowMs).toISOString(),
  });
  await recordScalperExitEvaluation({
    id: randomUUID(), scalpOrderId: order.id, mode: config.mode, symbol: order.symbol,
    ticker: order.ticker, windowKey: order.windowKey, side: order.side,
    remainingQuantity, evidence,
  });
  if (decision.disposition !== "exit") return;
  const lifecycle = await claimScalperExitLifecycle({
    id: randomUUID(), scalpOrderId: order.id, mode: config.mode, symbol: order.symbol,
    ticker: order.ticker, windowKey: order.windowKey, side: order.side, remainingQuantity,
    status: config.mode === "shadow" ? "advisory" : "requested",
    triggerReason: decision.reason, evidence, executableQuantity: executable.quantity,
    executablePrice: executable.price, entryWinningPrice, configVersion: version,
  });
  if (!lifecycle.id || config.mode === "shadow") return;
  if (!lifecycle.claimed && lifecycle.status !== "zero_fill") return;
  await executeExit({
    order, lifecycleId: lifecycle.id, remainingQuantity, floor, history,
    expectedExchangeIndex: refreshedMarket.exchangeIndex,
  });
}

async function monitor(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const now = Date.now();
    if (now - lastReconciledAt >= 5_000) {
      await reconcilePendingRequests();
      lastReconciledAt = now;
    }
    if (now - lastSettlementAt >= 30_000) {
      await finalizeSettledScalperExitLifecycles();
      lastSettlementAt = now;
    }
    if (!config.enabled || config.mode === "off") return;
    const orders = await getUnsettledScalpOrders();
    const activeOrders = orders.filter((order) =>
      (order.status === "filled" || order.status === "paper")
      && order.filledCount > 0
      && expiry(order.windowKey) > Date.now()
      && modeIncludesOrder(order));
    await Promise.allSettled(activeOrders.map((order) =>
      processOrder(order).catch((error) => {
        logger.warn({ error, orderId: order.id }, "[kalshi-scalper-exit] order evaluation failed closed");
        throw error;
      }),
    ));
    lastError = null;
  } catch (error) { lastError = String(error); logger.warn({ error }, "[kalshi-scalper-exit] monitor failed closed"); }
  finally { inFlight = false; }
}

export async function initScalperSmartExit(): Promise<void> {
  await runScalperExitMigrations();
  const loaded = await loadScalperExitConfig();
  config = loaded.config; version = loaded.version; started = true;
  await reconcilePendingRequests();
  await finalizeSettledScalperExitLifecycles();
  if (timer) clearInterval(timer);
  timer = setInterval(() => void monitor(), 1_000); timer.unref?.();
  // A future monitor is intentionally only scheduled when enabled. This keeps
  // the protected 250ms entry lane untouched while the exit subsystem is off.
  logger.info({ mode: config.mode, enabled: config.enabled }, "[kalshi-scalper-exit] initialized isolated subsystem");
}
export function getScalperSmartExitStatus() {
  return { started, config: { ...config }, configVersion: version, lastError, schedulerMs: 1_000,
    evaluations: [...latestEvaluations.values()],
    isolation: "dedicated_scalper_exit_ledger_and_exchange_boundary" };
}
export async function getScalperSmartExitLifecycle(limit?: number) {
  const records = (await listScalperExitLifecycles(limit)).map(serializeLifecycle);
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
  const rows = await getScalperExitLifecyclesByOrderIds(orderIds);
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
  const rows = await listScalperExitEvidenceForReplay();
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
  const saved = await saveScalperExitConfig({ ...config, ...patch });
  config = saved.config; version = saved.version;
  return { ...config };
}
export async function emergencyDisableScalperSmartExit() {
  const saved = await saveScalperExitConfig({ ...config, enabled: false, mode: "off" });
  config = saved.config; version = saved.version;
  return { ...config };
}