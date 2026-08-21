// ---------------------------------------------------------------------------
// kalshi-scalper-exchange.ts — SCALPER-OWNED exchange boundary.
//
// This is a deliberately isolated, minimal duplicate of the Kalshi Trade API v2
// RSA-PSS signing + POST /portfolio/events/orders submission path. It exists so
// the scalper NEVER imports or calls the protected regular-bot placeOrder()
// (which coerces a malformed fill_count to zero). The regular bot's trader stays
// read-only from the scalper's perspective.
//
// This module ONLY submits (write). Balance/settlement READS are still sourced
// from the protected kalshi-trader.ts by the service. Nothing here is imported
// by any regular-bot file.
//
// Auth (identical protocol to the regular client, intentionally re-derived):
//   KALSHI-ACCESS-KEY        — the API key ID
//   KALSHI-ACCESS-TIMESTAMP  — current ms timestamp string
//   KALSHI-ACCESS-SIGNATURE  — base64(RSA-PSS-SHA256(timestamp + METHOD + path))
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { logger } from "./logger.ts";
import { parseScalpOrderResponse, type ParsedScalpFill } from "./kalshi-scalper-policy.ts";

const KALSHI_TRADE_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const ORDERS_PATH = "/portfolio/events/orders";

function getKeyId(): string | null {
  return process.env["KALSHI_API_KEY_ID"] ?? null;
}

function getPrivateKey(): string | null {
  const raw = process.env["KALSHI_PRIVATE_KEY"] ?? null;
  if (!raw) return null;

  // If the key already has a PEM header, normalise newlines and return as-is.
  if (raw.includes("-----BEGIN")) {
    return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  }

  // Raw base64 without PEM headers → reconstruct a PKCS#1 RSA PEM.
  const b64 = raw.replace(/\s+/g, "");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return [
    "-----BEGIN RSA PRIVATE KEY-----",
    ...lines,
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
}

/**
 * Build the signed headers for a request. THROWS if auth material is absent —
 * the scalper must never submit unsigned (fail closed).
 */
function makeSignedHeaders(method: string, path: string): Record<string, string> {
  const keyId = getKeyId();
  const privateKeyPem = getPrivateKey();
  if (!keyId || !privateKeyPem) {
    throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
  }

  const timestampMs = Date.now().toString();
  // Signature message: timestamp + METHOD + /trade-api/v2 + path (no query).
  const pathWithoutQuery = path.split("?")[0];
  const message = timestampMs + method.toUpperCase() + "/trade-api/v2" + pathWithoutQuery;

  const sign = crypto.createSign("SHA256");
  sign.update(message);
  sign.end();
  const signature = sign.sign(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
    "base64",
  );

  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

export interface ScalpSubmitParams {
  ticker: string;
  side: "yes" | "no";
  // Exact YES-side limit price as a fraction (0.01–0.99). Provided by the caller
  // (the service already computed and clamped it). Sent at cent resolution.
  limitPrice: number;
  // Integer contract count (> 0).
  count: number;
  /** Persisted by the service before this function is called. */
  clientOrderId: string;
  timeoutMs?: number;
}

/**
 * Submit a scalper entry order via a scalper-dedicated signed POST to
 * /portfolio/events/orders, then STRICTLY parse the raw response.
 *
 * Order semantics (fixed for the scalper entry path):
 *   - action is always BUY
 *   - side "yes"  → book "bid"   (acquire YES exposure)
 *     side "no"   → book "ask"   (acquire NO exposure)
 *   - price is the exact YES-side limitPrice at cent resolution
 *   - count is the integer contract count
 *   - time_in_force = "immediate_or_cancel"
 *   - self_trade_prevention_type = "taker_at_cross"
 *
 * THROWS on: auth absence, timeout/abort, transport failure, non-2xx status, or
 * invalid JSON. The service's catch treats any thrown submit as UNKNOWN.
 *
 * On HTTP success returns a strictly-parsed discriminated result — never a
 * zero-coerced fill. A malformed body resolves to outcome "unknown".
 */
export async function placeScalpOrderStrict(
  params: ScalpSubmitParams,
): Promise<ParsedScalpFill> {
  // Fail closed on missing auth BEFORE any network work.
  if (!getKeyId() || !getPrivateKey()) {
    throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
  }

  const { ticker, side, limitPrice, count, clientOrderId } = params;

  // Validate the request locally — the strict parser also enforces this, but a
  // bad count must never leave this module as a real submission.
  if (!Number.isFinite(count) || !Number.isInteger(count) || count <= 0) {
    throw new Error(`invalid scalp order count: ${String(count)}`);
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
    side: bookSide, // "bid" | "ask"
    action: "buy",
    count: String(count), // FixedPointCount string
    price, // YES-side FixedPointDollars string (cent resolution)
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
  };

  const timeoutMs = params.timeoutMs ?? 10_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${KALSHI_TRADE_BASE}${ORDERS_PATH}`, {
      method: "POST",
      headers: makeSignedHeaders("POST", ORDERS_PATH),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    // Transport failure or timeout/abort — indeterminate; the service treats a
    // thrown submit as UNKNOWN (never a zero fill).
    clearTimeout(timer);
    throw new Error(`scalp submit transport error: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kalshi POST ${ORDERS_PATH} → ${res.status}: ${text}`);
  }

  // Invalid JSON on a 2xx is indeterminate → THROW (caught as unknown).
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw new Error(`scalp submit invalid JSON response: ${String(err)}`);
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

// ---------------------------------------------------------------------------
// Authoritative read-side reconciliation
// ---------------------------------------------------------------------------

const LEGACY_MATCH_WINDOW_MS = 10_000;

export interface ScalpReconciliationInput {
  ticker: string;
  side: "yes" | "no";
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
      reason: "reconciled_terminal_zero_fill";
      orderId: string;
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

function orderDirectionMatches(order: Record<string, unknown>, side: "yes" | "no"): boolean {
  const outcomeSide = order["outcome_side"];
  const bookSide = order["book_side"];
  const expectedBookSide = side === "yes" ? "bid" : "ask";
  if (outcomeSide != null && outcomeSide !== side) return false;
  if (bookSide != null && bookSide !== expectedBookSide) return false;
  return outcomeSide === side || bookSide === expectedBookSide;
}

function orderIdentityMatches(
  order: Record<string, unknown>,
  input: ScalpReconciliationInput,
): boolean {
  if (order["ticker"] !== input.ticker) return false;
  if (!orderDirectionMatches(order, input.side)) return false;
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
      || !orderDirectionMatches(fill, input.side)
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

async function fetchSignedJson(path: string): Promise<unknown> {
  const res = await fetch(`${KALSHI_TRADE_BASE}${path}`, {
    method: "GET",
    headers: makeSignedHeaders("GET", path),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Kalshi GET ${path.split("?")[0]} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchAllPages(
  path: "/portfolio/orders" | "/historical/orders" | "/portfolio/fills" | "/historical/fills",
  params: Record<string, string>,
  arrayField: "orders" | "fills",
): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor = "";
  const seenCursors = new Set<string>();
  while (true) {
    const query = new URLSearchParams({ ...params, limit: "1000" });
    if (cursor) query.set("cursor", cursor);
    const raw = asObject(await fetchSignedJson(`${path}?${query.toString()}`));
    if (!raw || !Array.isArray(raw[arrayField])) {
      throw new Error(`Kalshi ${path} returned malformed ${arrayField} page`);
    }
    rows.push(...raw[arrayField] as unknown[]);
    cursor = typeof raw["cursor"] === "string" ? raw["cursor"] : "";
    if (!cursor) return rows;
    if (seenCursors.has(cursor)) {
      throw new Error(`Kalshi ${path} pagination repeated a cursor`);
    }
    seenCursors.add(cursor);
  }
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
      fetchAllPages("/portfolio/orders", orderParams, "orders"),
      fetchAllPages("/historical/orders", orderParams, "orders"),
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
      fetchAllPages("/portfolio/fills", fillParams, "fills"),
      fetchAllPages("/historical/fills", fillParams, "fills"),
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
