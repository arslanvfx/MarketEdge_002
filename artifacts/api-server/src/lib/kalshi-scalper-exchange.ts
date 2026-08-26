// ---------------------------------------------------------------------------
// kalshi-scalper-exchange.ts — Scalper-specific order parsing and reconciliation.
//
// Submission uses the same authenticated CreateOrderV2 transport as regular
// bets. The Scalper still owns its IOC body, strict response parser, definitive
// rejection typing, and durable unknown-exposure lifecycle.
// ---------------------------------------------------------------------------

import { logger } from "./logger.ts";
import { parseScalpOrderResponse, type ParsedScalpFill } from "./kalshi-scalper-policy.ts";
import { fetchKalshiAuthenticatedHistoryPages } from "./kalshi-trader.ts";
import { submitKalshiCreateOrderV2 } from "./kalshi-trader.ts";

export interface ScalpSubmitParams {
  ticker: string;
  /** Authoritative market shard observed during final identity validation. */
  exchangeIndex: number;
  side: "yes" | "no";
  // Hard YES-side IOC boundary as a fraction (0.01–0.99). The caller derives it
  // from the pinned band ceiling; Kalshi may price-improve inside this limit.
  limitPrice: number;
  // Integer contract count (> 0).
  count: number;
  /** Persisted by the service before this function is called. */
  clientOrderId: string;
  timeoutMs?: number;
}

export interface DefinitiveScalpOrderRejection {
  status: number;
  code: string | null;
  message: string;
}

export class DefinitiveScalpOrderRejectionError extends Error {
  readonly kind = "definitive_scalp_order_rejection" as const;
  readonly status: number;
  readonly code: string | null;

  constructor(rejection: DefinitiveScalpOrderRejection) {
    super(rejection.message);
    this.name = "DefinitiveScalpOrderRejectionError";
    this.status = rejection.status;
    this.code = rejection.code;
  }
}

/**
 * A verified client rejection proves Kalshi did not accept the order. Network
 * failures, 5xx, 408, 425, and 429 remain indeterminate. A generic 409 may be a
 * duplicate client id, so only Kalshi's explicit no-liquidity rejection is safe.
 */
export function parseDefinitiveScalpOrderRejection(
  value: unknown,
): DefinitiveScalpOrderRejection | null {
  if (
    typeof value === "object"
    && value != null
    && (value as { kind?: string }).kind === "definitive_scalp_order_rejection"
  ) {
    const typed = value as DefinitiveScalpOrderRejectionError;
    return { status: typed.status, code: typed.code, message: typed.message };
  }
  const message = String(
    value instanceof Error ? value.message : value ?? "",
  );
  const status = Number(message.match(/→\s*(\d{3}):/)?.[1] ?? NaN);
  if (
    !Number.isInteger(status)
    || status < 400
    || status >= 500
    || [408, 425, 429].includes(status)
  ) {
    return null;
  }
  const code = message.match(/"code"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  if (
    status === 409
    && code !== "fill_or_kill_insufficient_resting_volume"
  ) {
    return null;
  }
  return { status, code, message };
}

export function isDefinitiveScalpOrderRejection(
  value: unknown,
): value is DefinitiveScalpOrderRejectionError {
  return parseDefinitiveScalpOrderRejection(value) != null;
}

/**
 * Submit a scalper entry order via a scalper-dedicated signed POST to
 * /portfolio/events/orders, then STRICTLY parse the raw response.
 *
 * Order semantics (fixed for the scalper entry path):
 *   - action is always BUY
 *   - side "yes"  → book "bid"   (acquire YES exposure)
 *     side "no"   → book "ask"   (acquire NO exposure)
 *   - price is the hard YES-side limitPrice at cent resolution
 *   - count is the integer contract count
 *   - time_in_force = "immediate_or_cancel"
 *   - self_trade_prevention_type = "taker_at_cross"
 *
 * THROWS on: auth absence, timeout/abort, transport failure, non-2xx status, or
 * invalid JSON. Verified client rejections use a typed throw so the service can
 * authoritatively record zero fill; all other submit throws remain UNKNOWN.
 *
 * On HTTP success returns a strictly-parsed discriminated result — never a
 * zero-coerced fill. A malformed body resolves to outcome "unknown".
 */
export async function placeScalpOrderStrict(
  params: ScalpSubmitParams,
): Promise<ParsedScalpFill> {
  const { ticker, exchangeIndex, side, limitPrice, count, clientOrderId } = params;

  // Validate the request locally — the strict parser also enforces this, but a
  // bad count must never leave this module as a real submission.
  if (!Number.isFinite(count) || !Number.isInteger(count) || count <= 0) {
    throw new Error(`invalid scalp order count: ${String(count)}`);
  }
  if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) {
    throw new Error(`invalid scalp order exchangeIndex: ${String(exchangeIndex)}`);
  }
  if (!Number.isFinite(limitPrice)) {
    throw new Error(`invalid scalp order limitPrice: ${String(limitPrice)}`);
  }
  if (typeof clientOrderId !== "string" || clientOrderId.length < 8 || clientOrderId.length > 100) {
    throw new Error("invalid persisted scalp clientOrderId");
  }

  // side "yes" → bid (YES exposure); "no" → ask (NO exposure).
  const bookSide = side === "yes" ? "bid" : "ask";

  // Cent-resolution YES-side price string, clamped to Kalshi's 0.01–0.99 range.
  const clamped = Math.min(0.99, Math.max(0.01, limitPrice));
  const price = clamped.toFixed(2);

  const body: Record<string, unknown> = {
    client_order_id: clientOrderId,
    ticker,
    // Match the proven regular-bet path: submit the explicit exchange index
    // from the final force-refreshed market identity.
    exchange_index: exchangeIndex,
    side: bookSide, // "bid" | "ask"
    count: String(count), // FixedPointCount string
    price, // YES-side FixedPointDollars string (cent resolution)
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  };

  const timeoutMs = params.timeoutMs ?? 10_000;
  let raw: unknown;
  try {
    raw = await submitKalshiCreateOrderV2(body, timeoutMs);
  } catch (err) {
    const definitive = parseDefinitiveScalpOrderRejection(err);
    if (definitive) {
      throw new DefinitiveScalpOrderRejectionError(definitive);
    }
    throw err;
  }

  // HTTP succeeded → STRICTLY parse. Never coerce a malformed fill to zero.
  const parsed = parseScalpOrderResponse(raw, count);
  if (parsed.outcome === "unknown") {
    logger.error(
      { ticker, side, count, reason: parsed.reason },
      "[kalshi-scalper] strict submit parse → UNKNOWN (retaining exposure, fail-closed)",
    );
  }
  return parsed;
}

export interface ScalpExitSubmitParams {
  ticker: string; exchangeIndex: number; originalSide: "yes" | "no";
  /** Minimum proceeds per held winning contract, represented in winning-side dollars. */
  minimumWinningPrice: number; count: number; clientOrderId: string; timeoutMs?: number;
}
export function computeScalpExitYesLimitPrice(
  originalSide: "yes" | "no",
  minimumWinningPrice: number,
): number {
  if (!Number.isFinite(minimumWinningPrice) || minimumWinningPrice <= 0 || minimumWinningPrice >= 1) {
    throw new Error("invalid scalp exit floor");
  }
  return originalSide === "yes"
    ? Math.ceil(minimumWinningPrice * 100) / 100
    : Math.floor((1 - minimumWinningPrice) * 100) / 100;
}

export function buildScalpExitOrderBody(
  params: ScalpExitSubmitParams,
): Record<string, unknown> {
  if (!Number.isInteger(params.exchangeIndex) || params.exchangeIndex < 0) {
    throw new Error("invalid scalp exit exchangeIndex");
  }
  const countHundredths = Math.round(params.count * 100);
  if (
    !Number.isFinite(params.count)
    || params.count <= 0
    || !Number.isSafeInteger(countHundredths)
    || Math.abs(params.count * 100 - countHundredths) > 1e-8
  ) throw new Error("invalid scalp exit count");
  if (typeof params.clientOrderId !== "string" || params.clientOrderId.length < 8 || params.clientOrderId.length > 100) {
    throw new Error("invalid persisted scalp exit clientOrderId");
  }
  const bookSide = params.originalSide === "yes" ? "ask" : "bid";
  const yesPrice = computeScalpExitYesLimitPrice(
    params.originalSide,
    params.minimumWinningPrice,
  );
  return {
    client_order_id: params.clientOrderId,
    ticker: params.ticker,
    exchange_index: params.exchangeIndex,
    side: bookSide,
    count: (countHundredths / 100).toFixed(2),
    price: yesPrice.toFixed(2),
    time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
  };
}
/**
 * Dedicated reducing exit boundary. Kalshi V2 has no action field: selling a
 * YES position is an ASK (acquire NO exposure), while selling a NO position is
 * a BID (acquire YES exposure). The YES-side limit preserves the winning-side
 * proceeds floor: YES sell -> yes price >= floor; NO sell -> yes price <= 1-floor.
 * Full authenticated depth is proven immediately before this all-or-nothing FOK
 * request. This boundary never imports regular closePosition.
 */
export async function placeScalpExitOrderStrict(params: ScalpExitSubmitParams): Promise<ParsedScalpFill> {
  const body = buildScalpExitOrderBody(params);
  let raw: unknown;
  try {
    raw = await submitKalshiCreateOrderV2(body, params.timeoutMs ?? 10_000);
  } catch (err) {
    const definitive = parseDefinitiveScalpOrderRejection(err);
    if (definitive) throw new DefinitiveScalpOrderRejectionError(definitive);
    throw err;
  }
  return parseScalpOrderResponse(raw, params.count);
}

// ---------------------------------------------------------------------------
// Authoritative read-side reconciliation
// ---------------------------------------------------------------------------

const LEGACY_MATCH_WINDOW_MS = 10_000;

export interface ScalpReconciliationInput {
  ticker: string;
  side: "yes" | "no";
  /** Defaults to the entry-side book direction. Exit reconciliation overrides both fields. */
  expectedBookSide?: "bid" | "ask";
  expectedOutcomeSide?: "yes" | "no";
  count: number;
  limitPrice: number;
  clientOrderId: string | null;
  exchangeOrderId: string | null;
  createdAt: Date;
  excludeExchangeOrderIds?: string[];
}

export type ScalpReconciliationResult =
  | {
      outcome: "zero_fill";
      reason: string;
      orderId: string | null;
      filledCount: 0;
      avgFillPrice: null;
      budgetSpent: 0;
      evidence: Record<string, unknown>;
    }
  | {
      outcome: "confirmed_fill";
      reason: "reconciled_authoritative_fills";
      orderId: string;
      filledCount: number;
      avgFillPrice: number;
      budgetSpent: number;
      evidence: Record<string, unknown>;
    }
  | {
      outcome: "ambiguous";
      reason: string;
      candidateCount: number;
      evidence: Record<string, unknown>;
    };

function fixedCountHundredths(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const units = Math.round(value * 100);
    if (!Number.isSafeInteger(units) || Math.abs(value * 100 - units) > 1e-8) return null;
    return BigInt(units);
  }
  if (typeof value !== "string") return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}

function fixedPriceMicros(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
    const units = Math.round(value * 1_000_000);
    if (!Number.isSafeInteger(units) || Math.abs(value * 1_000_000 - units) > 1e-6) return null;
    return BigInt(units);
  }
  if (typeof value !== "string") return null;
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  const micros = BigInt(match[1]!) * 1_000_000n
    + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  return micros <= 1_000_000n ? micros : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function orderDirectionMatches(
  order: Record<string, unknown>,
  side: "yes" | "no",
  expectedBookSide = side === "yes" ? "bid" : "ask",
  expectedOutcomeSide = side,
): boolean {
  const outcomeSide = order["outcome_side"];
  const bookSide = order["book_side"];
  if (outcomeSide != null && outcomeSide !== expectedOutcomeSide) return false;
  if (bookSide != null && bookSide !== expectedBookSide) return false;
  return outcomeSide === expectedOutcomeSide || bookSide === expectedBookSide;
}

function orderIdentityMatches(
  order: Record<string, unknown>,
  input: ScalpReconciliationInput,
): boolean {
  if (order["ticker"] !== input.ticker) return false;
  if (!orderDirectionMatches(
    order,
    input.side,
    input.expectedBookSide,
    input.expectedOutcomeSide,
  )) return false;
  const initialCount = fixedCountHundredths(order["initial_count_fp"]);
  const requestedCount = fixedCountHundredths(input.count);
  if (initialCount == null || requestedCount == null || initialCount !== requestedCount) return false;
  const orderPrice = fixedPriceMicros(order["yes_price_dollars"]);
  const requestedPrice = fixedPriceMicros(input.limitPrice);
  return orderPrice != null && requestedPrice != null && orderPrice === requestedPrice;
}

/**
 * Pure fail-closed reconciliation classifier. `orders` and `fills` must come
 * from fully paginated authenticated Kalshi responses.
 */
export function resolveScalpReconciliationEvidence(
  input: ScalpReconciliationInput,
  orders: unknown[],
  fills: unknown[],
): ScalpReconciliationResult {
  const excluded = new Set(input.excludeExchangeOrderIds ?? []);
  const validOrders = orders
    .map(asObject)
    .filter((order): order is Record<string, unknown> => order != null)
    .filter((order) => typeof order["order_id"] === "string" && !excluded.has(String(order["order_id"])))
    .filter((order) => orderIdentityMatches(order, input));

  let matchKind: "exchange_order_id" | "client_order_id" | "legacy_exact";
  let candidates: Record<string, unknown>[];
  if (input.exchangeOrderId) {
    matchKind = "exchange_order_id";
    candidates = validOrders.filter((order) => order["order_id"] === input.exchangeOrderId);
  } else if (input.clientOrderId) {
    matchKind = "client_order_id";
    candidates = validOrders.filter((order) => order["client_order_id"] === input.clientOrderId);
  } else {
    matchKind = "legacy_exact";
    const createdAtMs = input.createdAt.getTime();
    candidates = validOrders.filter((order) => {
      const exchangeCreatedAt = Date.parse(String(order["created_time"] ?? ""));
      return Number.isFinite(exchangeCreatedAt)
        && Math.abs(exchangeCreatedAt - createdAtMs) <= LEGACY_MATCH_WINDOW_MS;
    });
  }

  if (candidates.length !== 1) {
    return {
      outcome: "ambiguous",
      reason: candidates.length === 0 ? "no_unique_exchange_order_match" : "multiple_exchange_order_matches",
      candidateCount: candidates.length,
      evidence: {
        source: "kalshi_authenticated_history",
        matchKind,
        candidateCount: candidates.length,
      },
    };
  }

  const order = candidates[0]!;
  const orderId = String(order["order_id"]);
  const status = String(order["status"] ?? "");
  const initialCount = fixedCountHundredths(order["initial_count_fp"]);
  const remaining = fixedCountHundredths(order["remaining_count_fp"]);
  const orderFillCount = fixedCountHundredths(order["fill_count_fp"]);
  // Kalshi IOC semantics: after the unfilled remainder is canceled, a terminal
  // `canceled` order reports remaining_count_fp = 0.00. The canceled quantity
  // is therefore initial - fill, not `remaining_count_fp`. A fully executed
  // order must still account for the entire initial quantity.
  const terminalAccountingIsValid = status === "executed"
    ? remaining === 0n && orderFillCount === initialCount
    : status === "canceled"
      ? remaining === 0n && orderFillCount != null && initialCount != null && orderFillCount <= initialCount
      : false;
  if (
    initialCount == null
    || remaining == null
    || orderFillCount == null
    || !terminalAccountingIsValid
  ) {
    return {
      outcome: "ambiguous",
      reason: "exchange_order_not_terminal_or_unparseable",
      candidateCount: 1,
      evidence: { source: "kalshi_authenticated_history", matchKind, orderId, status },
    };
  }

  const baseEvidence = {
    source: "kalshi_authenticated_history",
    matchKind,
    orderId,
    clientOrderId: typeof order["client_order_id"] === "string" ? order["client_order_id"] : null,
    orderStatus: status,
    exchangeCreatedAt: typeof order["created_time"] === "string" ? order["created_time"] : null,
  };

  if (orderFillCount === 0n) {
    return {
      outcome: "zero_fill",
      reason: "reconciled_terminal_zero_fill",
      orderId,
      filledCount: 0,
      avgFillPrice: null,
      budgetSpent: 0,
      evidence: { ...baseEvidence, fillCount: "0.00" },
    };
  }

  const orderFills = fills
    .map(asObject)
    .filter((fill): fill is Record<string, unknown> => fill != null)
    .filter((fill) => fill["order_id"] === orderId);
  if (orderFills.length === 0) {
    return {
      outcome: "ambiguous",
      reason: "authoritative_fills_missing",
      candidateCount: 1,
      evidence: baseEvidence,
    };
  }

  let totalCount = 0n;
  let weightedYesPrice = 0n;
  const fillIds = new Set<string>();
  for (const fill of orderFills) {
    const fillId = typeof fill["fill_id"] === "string" ? fill["fill_id"] : null;
    const count = fixedCountHundredths(fill["count_fp"]);
    const yesPrice = fixedPriceMicros(fill["yes_price_dollars"]);
    if (
      !fillId
      || fillIds.has(fillId)
      || fill["ticker"] !== input.ticker
      || !orderDirectionMatches(
        fill,
        input.side,
        input.expectedBookSide,
        input.expectedOutcomeSide,
      )
      || count == null
      || count <= 0n
      || yesPrice == null
      || yesPrice <= 0n
      || yesPrice >= 1_000_000n
    ) {
      return {
        outcome: "ambiguous",
        reason: "invalid_or_duplicate_authoritative_fill",
        candidateCount: 1,
        evidence: { ...baseEvidence, observedFillCount: orderFills.length },
      };
    }
    fillIds.add(fillId);
    totalCount += count;
    weightedYesPrice += count * yesPrice;
  }
  if (totalCount !== orderFillCount) {
    return {
      outcome: "ambiguous",
      reason: "fill_total_does_not_match_order",
      candidateCount: 1,
      evidence: {
        ...baseEvidence,
        orderFillCountHundredths: orderFillCount.toString(),
        observedFillCountHundredths: totalCount.toString(),
      },
    };
  }

  if (
    totalCount > BigInt(Number.MAX_SAFE_INTEGER)
    || weightedYesPrice > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return {
      outcome: "ambiguous",
      reason: "reconciled_values_out_of_range",
      candidateCount: 1,
      evidence: baseEvidence,
    };
  }
  const filledCount = Number(totalCount) / 100;
  const avgFillPrice = Number(weightedYesPrice) / Number(totalCount) / 1_000_000;
  const yesCostDollars = Number(weightedYesPrice) / 100_000_000;
  const budgetSpent = input.side === "yes"
    ? yesCostDollars
    : filledCount - yesCostDollars;
  if (
    !Number.isFinite(filledCount)
    || !Number.isFinite(avgFillPrice)
    || !Number.isFinite(budgetSpent)
    || budgetSpent <= 0
  ) {
    return {
      outcome: "ambiguous",
      reason: "reconciled_values_out_of_range",
      candidateCount: 1,
      evidence: baseEvidence,
    };
  }
  return {
    outcome: "confirmed_fill",
    reason: "reconciled_authoritative_fills",
    orderId,
    filledCount,
    avgFillPrice,
    budgetSpent,
    evidence: {
      ...baseEvidence,
      fillCount: (Number(totalCount) / 100).toFixed(2),
      yesVwap: avgFillPrice.toFixed(8),
      yesCostDollars: yesCostDollars.toFixed(8),
      winningCostDollars: budgetSpent.toFixed(8),
      weightedYesPriceUnits: weightedYesPrice.toString(),
      countHundredths: totalCount.toString(),
      fillIds: [...fillIds],
    },
  };
}

/**
 * Fetch complete authenticated order/fill evidence and classify it. Any
 * transport, pagination, shape, identity, or terminal-state uncertainty remains
 * ambiguous and never releases a reservation.
 */
export async function reconcileScalpOrderStrict(
  input: ScalpReconciliationInput,
): Promise<ScalpReconciliationResult> {
  try {
    const createdAtSec = Math.floor(input.createdAt.getTime() / 1000);
    const orderParams = {
      ticker: input.ticker,
      min_ts: String(createdAtSec - 30),
      max_ts: String(createdAtSec + 30),
    };
    const [currentOrders, historicalOrders] = await Promise.all([
      fetchKalshiAuthenticatedHistoryPages("/portfolio/orders", orderParams, "orders"),
      fetchKalshiAuthenticatedHistoryPages("/historical/orders", orderParams, "orders"),
    ]);
    const orderMap = new Map<string, unknown>();
    for (const raw of [...currentOrders, ...historicalOrders]) {
      const obj = asObject(raw);
      const orderId = obj && typeof obj["order_id"] === "string" ? obj["order_id"] : null;
      if (orderId) orderMap.set(orderId, raw);
    }
    const orders = [...orderMap.values()];

    // Select the one order first; only then fetch its fills.
    const preliminary = resolveScalpReconciliationEvidence(input, orders, []);
    if (
      preliminary.outcome === "ambiguous"
      && preliminary.reason !== "authoritative_fills_missing"
    ) {
      return preliminary;
    }
    const matchedOrderId = preliminary.outcome === "zero_fill"
      ? preliminary.orderId
      : typeof preliminary.evidence["orderId"] === "string"
        ? preliminary.evidence["orderId"]
        : null;
    if (!matchedOrderId) return preliminary;
    if (preliminary.outcome === "zero_fill") return preliminary;

    const fillParams = { order_id: matchedOrderId };
    const [currentFills, historicalFills] = await Promise.all([
      fetchKalshiAuthenticatedHistoryPages("/portfolio/fills", fillParams, "fills"),
      fetchKalshiAuthenticatedHistoryPages("/historical/fills", fillParams, "fills"),
    ]);
    const fillMap = new Map<string, unknown>();
    for (const raw of [...currentFills, ...historicalFills]) {
      const obj = asObject(raw);
      const fillId = obj && typeof obj["fill_id"] === "string" ? obj["fill_id"] : null;
      if (fillId) fillMap.set(fillId, raw);
    }
    return resolveScalpReconciliationEvidence(input, orders, [...fillMap.values()]);
  } catch (err) {
    logger.error(
      { err, ticker: input.ticker, clientOrderId: input.clientOrderId, exchangeOrderId: input.exchangeOrderId },
      "[kalshi-scalper] authoritative reconciliation lookup failed",
    );
    return {
      outcome: "ambiguous",
      reason: "exchange_reconciliation_lookup_failed",
      candidateCount: 0,
      evidence: { source: "kalshi_authenticated_history", lookupFailed: true },
    };
  }
}

export interface ScalpExitReconciliationInput {
  ticker: string;
  exchangeIndex: number;
  originalSide: "yes" | "no";
  count: number;
  yesLimitPrice: number;
  clientOrderId: string;
  exchangeOrderId: string | null;
  createdAt: Date;
}

export type ScalpExitReconciliationResult =
  | {
      outcome: "zero_fill";
      reason: string;
      orderId: string | null;
      filledCount: 0;
      avgYesFillPrice: null;
      winningPrice: null;
      proceeds: 0;
      evidence: Record<string, unknown>;
    }
  | {
      outcome: "confirmed_fill";
      reason: string;
      orderId: string;
      filledCount: number;
      avgYesFillPrice: number;
      winningPrice: number;
      proceeds: number;
      evidence: Record<string, unknown>;
    }
  | {
      outcome: "ambiguous";
      reason: string;
      candidateCount: number;
      evidence: Record<string, unknown>;
    };

/**
 * Classifies a reducing exit from exact authenticated order/fill history.
 * Original YES is reduced by ASK/NO exposure; original NO by BID/YES exposure.
 */
export function resolveScalpExitReconciliationEvidence(
  input: ScalpExitReconciliationInput,
  orders: unknown[],
  fills: unknown[],
): ScalpExitReconciliationResult {
  const acquiredSide = input.originalSide === "yes" ? "no" : "yes";
  // Exit ownership is stricter than legacy entry recovery: when both durable
  // identifiers exist, both must match the same exchange row.
  const exactOrders = orders.filter((row) => {
    const order = asObject(row);
    return order != null
      && order["client_order_id"] === input.clientOrderId
      && Number(order["exchange_index"]) === input.exchangeIndex
      && (input.exchangeOrderId == null || order["order_id"] === input.exchangeOrderId);
  });
  const base = resolveScalpReconciliationEvidence({
    ticker: input.ticker,
    side: acquiredSide,
    expectedBookSide: input.originalSide === "yes" ? "ask" : "bid",
    expectedOutcomeSide: acquiredSide,
    count: input.count,
    limitPrice: input.yesLimitPrice,
    clientOrderId: input.clientOrderId,
    exchangeOrderId: input.exchangeOrderId,
    createdAt: input.createdAt,
  }, exactOrders, fills);
  if (base.outcome === "ambiguous") return base;
  if (base.outcome === "zero_fill") {
    return {
      ...base,
      avgYesFillPrice: null,
      winningPrice: null,
      proceeds: 0,
    };
  }
  const winningPrice = input.originalSide === "yes"
    ? base.avgFillPrice
    : 1 - base.avgFillPrice;
  return {
    outcome: "confirmed_fill",
    reason: base.reason,
    orderId: base.orderId,
    filledCount: base.filledCount,
    avgYesFillPrice: base.avgFillPrice,
    winningPrice,
    proceeds: winningPrice * base.filledCount,
    evidence: base.evidence,
  };
}

export async function reconcileScalpExitOrderStrict(
  input: ScalpExitReconciliationInput,
): Promise<ScalpExitReconciliationResult> {
  try {
    const createdAtSec = Math.floor(input.createdAt.getTime() / 1_000);
    const orderParams = {
      ticker: input.ticker,
      min_ts: String(createdAtSec - 30),
      max_ts: String(createdAtSec + 30),
    };
    const [currentOrders, historicalOrders] = await Promise.all([
      fetchKalshiAuthenticatedHistoryPages("/portfolio/orders", orderParams, "orders"),
      fetchKalshiAuthenticatedHistoryPages("/historical/orders", orderParams, "orders"),
    ]);
    const byOrderId = new Map<string, Record<string, unknown>>();
    for (const row of [...currentOrders, ...historicalOrders]) {
      if (typeof row["order_id"] === "string") byOrderId.set(row["order_id"], row);
    }
    const orders = [...byOrderId.values()];
    const preliminary = resolveScalpExitReconciliationEvidence(input, orders, []);
    if (
      preliminary.outcome === "ambiguous"
      && preliminary.reason !== "authoritative_fills_missing"
    ) return preliminary;
    if (preliminary.outcome === "zero_fill") return preliminary;
    const orderId = typeof preliminary.evidence["orderId"] === "string"
      ? preliminary.evidence["orderId"]
      : null;
    if (!orderId) return preliminary;
    const fillParams = { order_id: orderId };
    const [currentFills, historicalFills] = await Promise.all([
      fetchKalshiAuthenticatedHistoryPages("/portfolio/fills", fillParams, "fills"),
      fetchKalshiAuthenticatedHistoryPages("/historical/fills", fillParams, "fills"),
    ]);
    const byFillId = new Map<string, Record<string, unknown>>();
    for (const row of [...currentFills, ...historicalFills]) {
      if (typeof row["fill_id"] === "string") byFillId.set(row["fill_id"], row);
    }
    return resolveScalpExitReconciliationEvidence(
      input,
      orders,
      [...byFillId.values()],
    );
  } catch (err) {
    logger.error(
      { err, ticker: input.ticker, clientOrderId: input.clientOrderId },
      "[kalshi-scalper-exit] authoritative reconciliation lookup failed",
    );
    return {
      outcome: "ambiguous",
      reason: "exchange_reconciliation_lookup_failed",
      candidateCount: 0,
      evidence: { source: "kalshi_authenticated_history", lookupFailed: true },
    };
  }
}
