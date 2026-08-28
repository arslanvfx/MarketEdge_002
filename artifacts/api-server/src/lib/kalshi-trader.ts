// Kalshi Trade API v2 client.
//
// All amounts returned from Kalshi are in CENTS (integer).  We convert to
// dollar fractions (0–1 for prices, $ for balance) for internal use.
//
// In paper mode every write method is a no-op and returns a simulated result
// so the rest of the bot logic works identically in both modes.
//
// Auth: Kalshi elections API uses RSA-PSS request signing.
// Each request must include:
//   KALSHI-ACCESS-KEY    — the API key ID (UUID)
//   KALSHI-ACCESS-TIMESTAMP — current ms timestamp as string
//   KALSHI-ACCESS-SIGNATURE — base64(RSA-PSS-SHA256(timestamp + method + path))

import { logger } from "./logger.ts";
import {
  hasKalshiCredentials,
  makeKalshiSignedHeaders,
} from "./kalshi-auth.ts";
import {
  formatRegularFixedPointCount,
  parseRegularFixedPointCount,
  regularCountHundredths,
} from "./kalshi-regular-fixed-point.ts";
import {
  planKalshiRouteTransfers,
  type KalshiRouteFundingTarget,
} from "./kalshi-shard-allocation.ts";

export {
  formatRegularFixedPointCount,
  parseRegularFixedPointCount,
  regularCountHundredths,
} from "./kalshi-regular-fixed-point.ts";

const KALSHI_TRADE_BASE = "https://api.elections.kalshi.com/trade-api/v2";

function makeSignedHeaders(method: string, path: string): Record<string, string> {
  return makeKalshiSignedHeaders(method, "/trade-api/v2" + path);
}

async function kalshiFetch<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${KALSHI_TRADE_BASE}${path}`, {
      method,
      headers: makeSignedHeaders(method, path),
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kalshi ${method} ${path} → ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read every page from one authenticated Kalshi portfolio history endpoint.
 * This is a narrow read-only primitive for regular-bot reconciliation; it
 * never submits, cancels, or mutates an exchange order.
 */
export async function fetchKalshiAuthenticatedHistoryPages(
  path: "/portfolio/orders" | "/historical/orders" | "/portfolio/fills" | "/historical/fills",
  params: Record<string, string | number | undefined>,
  listKey: "orders" | "fills",
): Promise<Array<Record<string, unknown>>> {
  let cursor: string | undefined;
  const out: Array<Record<string, unknown>> = [];
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value != null) query.set(key, String(value));
    }
    query.set("limit", "100");
    if (cursor) query.set("cursor", cursor);
    const data = await kalshiFetch<Record<string, unknown>>(
      "GET",
      `${path}?${query.toString()}`,
      undefined,
      10_000,
    );
    const rows = data[listKey];
    if (!Array.isArray(rows)) {
      throw new Error(`Kalshi ${path} response missing ${listKey} array`);
    }
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`Kalshi ${path} returned malformed ${listKey} evidence`);
      }
      out.push(row as Record<string, unknown>);
    }
    const next = typeof data["cursor"] === "string" ? data["cursor"] : "";
    if (!next) return out;
    cursor = next;
  }
  throw new Error(`Kalshi ${path} pagination exceeded 100 pages`);
}

// ---------------------------------------------------------------------------
// Market Settlement
// ---------------------------------------------------------------------------

export interface KalshiMarketResult {
  result: "yes" | "no" | null;   // null = not yet settled or unknown
  status: string | null;          // "open" | "closed" | "settled" | etc.
  floorStrike: number | null;
}

/**
 * Fetch the settled result for a specific Kalshi market ticker.
 * Returns { result: "yes" | "no" } when settled, or { result: null }
 * if the market is still open/not-yet-settled, or on any error.
 *
 * This is the authoritative source for bet outcome evaluation —
 * Kalshi settles using CF Benchmarks RTI which differs from Coinbase
 * candle close prices.  Always prefer this over price comparison.
 */
export async function fetchKalshiMarketResult(ticker: string): Promise<KalshiMarketResult> {
  try {
    const data = await kalshiFetch<{
      market?: { status?: string; result?: string; floor_strike?: number };
    }>("GET", `/markets/${encodeURIComponent(ticker)}`, undefined, 8_000);

    const m = data.market;
    if (!m) return { result: null, status: null, floorStrike: null };

    const result =
      m.result === "yes" ? "yes"
      : m.result === "no" ? "no"
      : null;

    return {
      result,
      status: typeof m.status === "string" ? m.status : null,
      floorStrike: Number.isFinite(Number(m.floor_strike)) ? Number(m.floor_strike) : null,
    };
  } catch {
    return { result: null, status: null, floorStrike: null };
  }
}

/**
 * Fetch recently settled markets for a series.
 * Returns an array of { ticker, result, closeTime, floorStrike }.
 * closeTime matches the target_time stored in prediction_records, enabling
 * retroactive re-evaluation of model accuracy against the true settlement.
 */
export async function fetchKalshiSettledMarkets(
  seriesTicker: string,
  limit = 100,
): Promise<Array<{ ticker: string; result: "yes" | "no"; closeTime: string; floorStrike: number }>> {
  try {
    const data = await kalshiFetch<{
      markets?: Array<{
        ticker?: string;
        result?: string;
        close_time?: string;
        floor_strike?: number;
      }>;
    }>("GET", `/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=settled&limit=${limit}`, undefined, 10_000);

    return (data.markets ?? [])
      .filter(
        (m): m is typeof m & { ticker: string; result: "yes" | "no"; close_time: string; floor_strike: number } =>
          typeof m.ticker === "string" &&
          (m.result === "yes" || m.result === "no") &&
          typeof m.close_time === "string" &&
          typeof m.floor_strike === "number",
      )
      .map((m) => ({
        ticker: m.ticker,
        result: m.result,
        closeTime: m.close_time,
        floorStrike: m.floor_strike,
      }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface KalshiBalance {
  availableBalance: number; // in dollars
  totalBalance: number;     // in dollars
  balanceBreakdown?: KalshiBalanceBreakdown[];
}
export interface RegularAccountSnapshot {
  availableBalance: number;
  availableBalanceByExchange: ReadonlyMap<number, number>;
  fetchedAt: number;
}

export interface KalshiBalanceBreakdown {
  exchangeIndex: number;
  availableBalance: number;
}

export interface KalshiShardTransferPlan {
  sourceExchangeIndex: number;
  destinationExchangeIndex: number;
  amountCenticents: number;
}

export interface KalshiShardRebalanceResult {
  aggregateAvailableBalance: number;
  destinationAvailableBalance: number;
  targetAvailableBalance: number;
  transfers: Array<KalshiShardTransferPlan & { transferId: string }>;
}

export interface KalshiRouteRebalanceResult {
  aggregateAvailableBalance: number;
  availableBalanceByExchange: Map<number, number>;
  targetAvailableBalanceByExchange: Map<number, number>;
  transfers: Array<KalshiShardTransferPlan & { transferId: string }>;
}

export interface KalshiShardRebalanceOptions {
  deadlineMs?: number;
  claimTransfer?: (transfer: KalshiShardTransferPlan) => Promise<boolean>;
  recordTransferAccepted?: (
    transfer: KalshiShardTransferPlan,
    transferId: string,
  ) => Promise<void>;
}

interface KalshiShardTransferRecord {
  transferId: string;
  destinationExchangeIndex: number;
  status: "pending" | "complete";
}

export function buildKalshiBalancePath(exchangeIndex?: number): string {
  if (exchangeIndex == null) return "/portfolio/balance";
  if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) {
    throw new Error(`Kalshi balance exchange_index must be a non-negative integer: ${String(exchangeIndex)}`);
  }
  return `/portfolio/balance?exchange_index=${exchangeIndex}`;
}

export async function getBalance(
  exchangeIndex?: number,
  timeoutMs = 10_000,
): Promise<KalshiBalance> {
  // GET /portfolio/balance — Kalshi trade-api v2.
  // Confirmed response shape (2026-07):
  //   { balance: <cents int>,          ← available CASH (what you can bet with)
  //     portfolio_value: <cents int>,  ← current mark-to-market position value
  //     balance_dollars: "<string>",   ← cash as a decimal string
  //     balance_breakdown: [...],      ← per-exchange breakdown
  //     updated_ts: <unix seconds> }
  //
  // Without exchange_index Kalshi returns an aggregate across every exchange.
  // The Scalper uses that aggregate breakdown only during preflight funding;
  // eligible order execution performs no balance read or local balance gate.
  const raw = await kalshiFetch<Record<string, unknown>>(
    "GET",
    buildKalshiBalancePath(exchangeIndex),
    undefined,
    timeoutMs,
  );
  return parseKalshiBalanceResponse(raw);
}

export function parseKalshiBalanceResponse(
  raw: Record<string, unknown>,
): KalshiBalance {
  const num = (key: string): number | null => {
    const v = raw[key];
    return typeof v === "number" ? v : null;
  };

  const cashCents = num("balance") ?? 0;
  const positionCents = num("portfolio_value") ?? 0;
  const balanceBreakdown = Array.isArray(raw["balance_breakdown"])
    ? raw["balance_breakdown"].flatMap((entry): KalshiBalanceBreakdown[] => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const row = entry as Record<string, unknown>;
        const rawExchangeIndex = row["exchange_index"];
        const parsedExchangeIndex =
          typeof rawExchangeIndex === "number"
            ? rawExchangeIndex
            : typeof rawExchangeIndex === "string" && rawExchangeIndex.trim() !== ""
              ? Number(rawExchangeIndex)
              : NaN;
        const rawBalance = row["balance"];
        const parsedBalance =
          typeof rawBalance === "number"
            ? rawBalance
            : typeof rawBalance === "string" && rawBalance.trim() !== ""
              ? Number(rawBalance)
              : NaN;
        if (
          !Number.isInteger(parsedExchangeIndex)
          || parsedExchangeIndex < 0
          || !Number.isFinite(parsedBalance)
          || parsedBalance < 0
        ) {
          return [];
        }
        return [{
          exchangeIndex: parsedExchangeIndex,
          availableBalance: parsedBalance,
        }];
      })
    : undefined;

  return {
    availableBalance: cashCents / 100,
    totalBalance: (cashCents + positionCents) / 100,
    balanceBreakdown,
  };
}

async function getRecentKalshiShardTransfers(
  timeoutMs = 10_000,
): Promise<KalshiShardTransferRecord[]> {
  const raw = await kalshiFetch<Record<string, unknown>>(
    "GET",
    "/portfolio/intra_exchange_instance_transfers?limit=100",
    undefined,
    timeoutMs,
  );
  const rows = raw["transfers"];
  if (!Array.isArray(rows)) {
    throw new Error("Kalshi transfer history response missing transfers array");
  }
  return rows.flatMap((entry): KalshiShardTransferRecord[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const transferId = row["transfer_id"];
    const destinationExchangeIndex = Number(row["destination_exchange_shard"]);
    const status = row["status"];
    if (
      typeof transferId !== "string"
      || transferId.trim() === ""
      || !Number.isInteger(destinationExchangeIndex)
      || destinationExchangeIndex < 0
      || (status !== "pending" && status !== "complete")
    ) {
      return [];
    }
    return [{ transferId, destinationExchangeIndex, status }];
  });
}

export function planKalshiShardRebalance(
  balance: KalshiBalance,
  destinationExchangeIndex: number,
  targetFraction: number,
): KalshiShardTransferPlan[] {
  if (!Number.isInteger(destinationExchangeIndex) || destinationExchangeIndex < 0) {
    throw new Error("Kalshi rebalance destination exchange index must be a non-negative integer");
  }
  if (!Number.isFinite(targetFraction) || targetFraction <= 0 || targetFraction > 1) {
    throw new Error("Kalshi rebalance target fraction must be in (0, 1]");
  }
  const breakdown = balance.balanceBreakdown;
  if (!breakdown || breakdown.length === 0) {
    throw new Error("Kalshi aggregate balance response missing exchange balance breakdown");
  }

  const totalCenticents = Math.max(
    0,
    Math.floor(balance.availableBalance * 10_000 + 1e-6),
  );
  const targetCenticents = Math.floor(totalCenticents * targetFraction);
  const destinationCenticents = breakdown
    .filter((entry) => entry.exchangeIndex === destinationExchangeIndex)
    .reduce(
      (sum, entry) =>
        sum + Math.max(0, Math.floor(entry.availableBalance * 10_000 + 1e-6)),
      0,
    );
  let neededCenticents = Math.max(0, targetCenticents - destinationCenticents);
  if (neededCenticents === 0) return [];

  const transfers: KalshiShardTransferPlan[] = [];
  const sources = breakdown
    .filter(
      (entry) =>
        entry.exchangeIndex !== destinationExchangeIndex
        && Number.isFinite(entry.availableBalance)
        && entry.availableBalance > 0,
    )
    .map((entry) => ({
      exchangeIndex: entry.exchangeIndex,
      availableCenticents: Math.max(
        0,
        Math.floor(entry.availableBalance * 10_000 + 1e-6),
      ),
    }))
    .sort((a, b) => b.availableCenticents - a.availableCenticents);

  for (const source of sources) {
    if (neededCenticents <= 0) break;
    const amountCenticents = Math.min(
      source.availableCenticents,
      neededCenticents,
    );
    if (amountCenticents <= 0) continue;
    transfers.push({
      sourceExchangeIndex: source.exchangeIndex,
      destinationExchangeIndex,
      amountCenticents,
    });
    neededCenticents -= amountCenticents;
  }
  if (neededCenticents > 0) {
    throw new Error("Kalshi exchange balance breakdown cannot fund requested shard allocation");
  }
  return transfers;
}

export function buildKalshiShardTransferBody(
  transfer: KalshiShardTransferPlan,
): Record<string, unknown> {
  if (
    !Number.isSafeInteger(transfer.amountCenticents)
    || transfer.amountCenticents <= 0
  ) {
    throw new Error("Kalshi shard transfer amount must be positive integer centicents");
  }
  return {
    source: "event_contract",
    destination: "event_contract",
    amount: transfer.amountCenticents,
    source_exchange_shard: transfer.sourceExchangeIndex,
    destination_exchange_shard: transfer.destinationExchangeIndex,
    source_subaccount: 0,
    destination_subaccount: 0,
  };
}

export async function rebalanceKalshiCashToShard(
  destinationExchangeIndex: number,
  targetFraction: number,
  options: KalshiShardRebalanceOptions = {},
): Promise<KalshiShardRebalanceResult> {
  const remainingBeforeDeadline = (): number => {
    if (options.deadlineMs == null) return 10_000;
    const remaining = Math.floor(options.deadlineMs - Date.now());
    if (remaining <= 0) {
      throw new Error("Kalshi shard funding deadline passed before transfer");
    }
    return Math.min(10_000, remaining);
  };
  const balance = await getBalance(undefined, remainingBeforeDeadline());
  const plan = planKalshiShardRebalance(
    balance,
    destinationExchangeIndex,
    targetFraction,
  );
  const destinationAvailableBalance =
    balance.balanceBreakdown
      ?.filter((entry) => entry.exchangeIndex === destinationExchangeIndex)
      .reduce((sum, entry) => sum + entry.availableBalance, 0)
    ?? 0;
  if (plan.length > 0) {
    const pendingTransfer = (
      await getRecentKalshiShardTransfers(remainingBeforeDeadline())
    ).find(
      (transfer) =>
        transfer.destinationExchangeIndex === destinationExchangeIndex
        && transfer.status === "pending",
    );
    if (pendingTransfer) {
      throw new Error(
        `Kalshi shard ${destinationExchangeIndex} funding transfer is still pending`,
      );
    }
  }
  const transfers: KalshiShardRebalanceResult["transfers"] = [];
  for (const transfer of plan) {
    remainingBeforeDeadline();
    if (options.claimTransfer && !(await options.claimTransfer(transfer))) {
      continue;
    }
    const transferTimeoutMs = remainingBeforeDeadline();
    const raw = await kalshiFetch<Record<string, unknown>>(
      "POST",
      "/portfolio/intra_exchange_instance_transfer",
      buildKalshiShardTransferBody(transfer),
      transferTimeoutMs,
    );
    const transferId = raw["transfer_id"];
    if (typeof transferId !== "string" || transferId.trim() === "") {
      throw new Error("Kalshi shard transfer response missing transfer_id");
    }
    await options.recordTransferAccepted?.(transfer, transferId);
    transfers.push({ ...transfer, transferId });
  }
  return {
    aggregateAvailableBalance: balance.availableBalance,
    destinationAvailableBalance,
    targetAvailableBalance: Math.floor(
      balance.availableBalance * targetFraction * 10_000,
    ) / 10_000,
    transfers,
  };
}

export async function rebalanceKalshiCashToRoutes(
  targets: readonly KalshiRouteFundingTarget[],
  options: KalshiShardRebalanceOptions = {},
): Promise<KalshiRouteRebalanceResult> {
  const remainingBeforeDeadline = (): number => {
    if (options.deadlineMs == null) return 10_000;
    const remaining = Math.floor(options.deadlineMs - Date.now());
    if (remaining <= 0) {
      throw new Error("Kalshi route funding deadline passed before transfer");
    }
    return Math.min(10_000, remaining);
  };
  const balance = await getBalance(undefined, remainingBeforeDeadline());
  if (!balance.balanceBreakdown || balance.balanceBreakdown.length === 0) {
    throw new Error("Kalshi aggregate balance response missing exchange balance breakdown");
  }
  const plan = planKalshiRouteTransfers(
    balance.availableBalance,
    balance.balanceBreakdown,
    targets,
  );
  if (plan.length > 0) {
    const pendingTransfers = await getRecentKalshiShardTransfers(
      remainingBeforeDeadline(),
    );
    const pendingDestinations = new Set(
      pendingTransfers
        .filter((transfer) => transfer.status === "pending")
        .map((transfer) => transfer.destinationExchangeIndex),
    );
    if (plan.some((transfer) =>
      pendingDestinations.has(transfer.destinationExchangeIndex)
    )) {
      throw new Error("Kalshi route funding transfer is still pending");
    }
  }

  const transfers: KalshiRouteRebalanceResult["transfers"] = [];
  for (const transfer of plan) {
    remainingBeforeDeadline();
    if (options.claimTransfer && !(await options.claimTransfer(transfer))) {
      continue;
    }
    const raw = await kalshiFetch<Record<string, unknown>>(
      "POST",
      "/portfolio/intra_exchange_instance_transfer",
      buildKalshiShardTransferBody(transfer),
      remainingBeforeDeadline(),
    );
    const transferId = raw["transfer_id"];
    if (typeof transferId !== "string" || transferId.trim() === "") {
      throw new Error("Kalshi route transfer response missing transfer_id");
    }
    await options.recordTransferAccepted?.(transfer, transferId);
    transfers.push({ ...transfer, transferId });
  }

  return {
    aggregateAvailableBalance: balance.availableBalance,
    availableBalanceByExchange: new Map(
      balance.balanceBreakdown.map((entry) => [
        entry.exchangeIndex,
        entry.availableBalance,
      ]),
    ),
    targetAvailableBalanceByExchange: new Map(
      targets.map((target) => [
        target.exchangeIndex,
        target.targetAvailableBalance,
      ]),
    ),
    transfers,
  };
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export interface KalshiPosition {
  ticker: string;
  side: "yes" | "no";
  position: number;   // net contract count (positive = long)
  marketValue: number; // in dollars
  resting_orders_count?: number;
}

export async function getPositions(): Promise<KalshiPosition[]> {
  const data = await kalshiFetch<{
    market_positions?: Array<{
      ticker: string;
      position: number;
      market_exposure?: number;
      fees_paid?: number;
    }>;
  }>("GET", "/portfolio/positions");
  return (data.market_positions ?? [])
    .filter((p) => p.position !== 0)
    .map((p) => ({
      ticker: p.ticker,
      side: p.position > 0 ? "yes" : "no",
      position: Math.abs(p.position),
      marketValue: (p.market_exposure ?? 0) / 100,
    }));
}

// ---------------------------------------------------------------------------
// Portfolio Fills
// ---------------------------------------------------------------------------

export interface KalshiFill {
  fillId: string;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  count: number;
  /** YES price in 0–1 dollar format (e.g. 0.88 = 88 ¢). */
  yesPrice: number;
  createdTime: string;
  tradeId: string;
}

/**
 * Fetch fills from the authenticated Kalshi portfolio.
 * Returns fills in reverse-chronological order (newest first).
 * Use `ticker` to filter to a specific market; `cursor` to paginate.
 *
 * This is the account-level authoritative source for actual fills —
 * combine with fetchKalshiMarketResult / fetchKalshiSettledMarkets to
 * confirm win/loss for markets where GET /markets/{ticker} is slow to settle.
 */
export async function fetchPortfolioFills(opts: {
  ticker?: string;
  limit?: number;
  cursor?: string;
  /** ISO date string — converted to unix-ms for the API query param. */
  minTs?: string;
  maxTs?: string;
} = {}): Promise<{ fills: KalshiFill[]; cursor: string | null }> {
  const params = new URLSearchParams();
  if (opts.ticker) params.set("ticker",  opts.ticker);
  if (opts.limit)  params.set("limit",   String(opts.limit));
  if (opts.cursor) params.set("cursor",  opts.cursor);
  if (opts.minTs)  params.set("min_ts",  String(new Date(opts.minTs).getTime()));
  if (opts.maxTs)  params.set("max_ts",  String(new Date(opts.maxTs).getTime()));
  const qs = params.toString();

  const data = await kalshiFetch<{
    fills?: Array<{
      fill_id?:      string;
      ticker?:       string;
      side?:         string;
      action?:       string;
      count?:        number;
      yes_price?:    string | number;
      no_price?:     string | number;
      created_time?: string;
      trade_id?:     string;
    }>;
    cursor?: string;
  }>("GET", `/portfolio/fills${qs ? `?${qs}` : ""}`, undefined, 10_000);

  const fills: KalshiFill[] = (data.fills ?? [])
    .filter((f): f is typeof f & { fill_id: string; ticker: string } =>
      typeof f.fill_id === "string" && typeof f.ticker === "string")
    .map((f) => ({
      fillId:      f.fill_id,
      ticker:      f.ticker,
      side:        f.side === "no" ? "no" : "yes",
      action:      f.action === "sell" ? "sell" : "buy",
      count:       typeof f.count === "number" ? f.count : 0,
      yesPrice:    Number(f.yes_price ?? 0),
      createdTime: f.created_time ?? "",
      tradeId:     f.trade_id ?? "",
    }));

  return { fills, cursor: data.cursor ?? null };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface PlaceOrderParams {
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  count: number;
  type: "market" | "limit";
  // Execution policy for this order.
  //   "fill_or_kill"       — all contracts must fill immediately or the order is cancelled.
  //                          Used for exits so we never leave a partial position open.
  //   "immediate_or_cancel"— fill whatever the book has at this price right now,
  //                          cancel the rest. Used for entries: a partial fill is
  //                          accepted and the position is tracked by actual fill count.
  // Defaults to "fill_or_kill" so existing callers (buyYes/buyNo/sellYes/sellNo) are unchanged.
  // Kalshi v2 only accepts "fill_or_kill" and "immediate_or_cancel".
  // "gtc" and "good_till_cancelled" both return 400 (oneof failure) — do not use.
  timeInForce?: "fill_or_kill" | "immediate_or_cancel";
  yesPrice?: number; // reference YES price as a fraction (0-1); used to bound the marketable-limit price
  // Minimum payout multiple (1/cost). When > 1, the marketable-limit price is
  // capped so a contract can NEVER fill at a cost whose payout multiple falls
  // below this floor. fill_or_kill then kills the order if the real book can't
  // meet the cap — the authoritative, execution-time enforcement of the floor
  // (the decision-time cache price is frequently null and can't be trusted).
  minReturnMultiple?: number;
  // Extra cents to cross further into the book; kept for backward compat.
  priceImprovementCents?: number;
  // When provided, this YES-side price is used directly as the order limit
  // price instead of computing it from yesPrice + MARKETABLE_BUFFER + return-
  // floor cap. Use when the caller has already fetched the live ask and wants
  // to place at exactly that price. priceImprovementCents still escalates from
  // this baseline. minReturnMultiple is ignored when limitPrice is set.
  limitPrice?: number;
  /** Optional caller-owned idempotency key. Live entry callers persist this
   * exact ID before POST so an uncertain result can be reconciled durably. */
  clientOrderId?: string;
  /** Synchronous caller authorization checked at the exact pre-POST boundary. */
  preSubmitGuard?: () => boolean;
  /** Regular-bot hot path only: require an already prewarmed exact-ticker
   * exchange route. This deliberately forbids a candidate-time market GET. */
  requirePreparedRoute?: boolean;
}

export interface PlaceOrderResult {
  orderId: string | null;
  status: string;
  filledCount: number;
  avgPrice: number | null; // in fraction (0-1)
}

/**
 * Shared authenticated CreateOrderV2 transport used by every Kalshi strategy.
 * Strategy-specific modules own sizing, TIF, parsing, and durable lifecycle,
 * but must not duplicate signing, endpoint selection, or HTTP behavior.
 */
export async function submitKalshiCreateOrderV2(
  body: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<unknown> {
  if (!hasKalshiCredentials()) {
    throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
  }
  return kalshiFetch<unknown>(
    "POST",
    "/portfolio/events/orders",
    body,
    timeoutMs,
  );
}

export class OrderSubmissionRevokedError extends Error {
  constructor() {
    super("order submission revoked before broker POST");
    this.name = "OrderSubmissionRevokedError";
  }
}

export async function submitAuthorizedKalshiCreateOrderV2(
  body: Record<string, unknown>,
  preSubmitGuard?: () => boolean,
  submitFn: (body: Record<string, unknown>) => Promise<unknown> = submitKalshiCreateOrderV2,
): Promise<unknown> {
  if (preSubmitGuard && !preSubmitGuard()) {
    throw new OrderSubmissionRevokedError();
  }
  return submitFn(body);
}

// ---------------------------------------------------------------------------
// Strict regular-order response parsing (pure, fail-closed)
// ---------------------------------------------------------------------------
//
// The regular Kalshi bot's order boundary MUST NEVER (a) coerce a malformed
// fill_count to 0, or (b) let a confirmed fill fall back to a cached decision
// yesPrice. A confirmed fill must carry a finite fixed-point dollar fill price
// strictly inside (0, 1). Any ambiguity resolves to "unknown" (indeterminate
// live exposure) — never a zero fill.
//
// This is a DELIBERATE, independent re-implementation of the same invariants the
// scalper enforces (see kalshi-scalper-policy.ts parseScalpOrderResponse). It is
// intentionally NOT imported from the scalper: the scalper's execution lifecycle
// must never be pulled into the regular bot, and vice versa. The invariants are
// duplicated as pure code so each subsystem owns its own boundary.

export type RegularOrderOutcome = "zero_fill" | "confirmed_fill" | "unknown";

export interface ParsedRegularOrder {
  outcome: RegularOrderOutcome;
  reason: string;             // machine-readable reason code
  orderId: string | null;    // non-empty string only when trusted
  filledCount: number | null; // validated nonnegative centi-contract count, else null
  avgPrice: number | null;    // validated (0,1) YES-side fraction, else null
}

/**
 * Typed error thrown by placeOrder when an HTTP-2xx response body is malformed
 * or otherwise indeterminate. Carries the generated client_order_id so the
 * caller can reconcile the possible live exposure. Treat ANY throw of this as
 * UNKNOWN LIVE EXPOSURE — never a zero fill, never a retry.
 */
export class UncertainOrderError extends Error {
  readonly clientOrderId: string;
  readonly reason: string;
  readonly kind = "uncertain_order" as const;
  constructor(clientOrderId: string, reason: string) {
    super(`kalshi order outcome uncertain (${reason}) — client_order_id=${clientOrderId}`);
    this.name = "UncertainOrderError";
    this.clientOrderId = clientOrderId;
    this.reason = reason;
  }
}

/** Narrowing helper for callers that must treat uncertain outcomes specially. */
export function isUncertainOrderError(err: unknown): err is UncertainOrderError {
  return err instanceof UncertainOrderError ||
    (typeof err === "object" && err != null && (err as { kind?: string }).kind === "uncertain_order");
}

/**
 * Backward-compatible export retained for callers/tests that used the old name.
 * The exchange now returns FixedPointCount values with up to two fractional
 * digits, so valid centi-contract quantities are intentionally accepted.
 */
export function parseRegularFixedPointInteger(v: unknown): number | null {
  return parseRegularFixedPointCount(v);
}

/**
 * Parse a value Kalshi accepts as a numeric price field (fixed-point YES-side
 * dollars). Accepts a finite number or a canonical finite numeric string.
 * Range is NOT enforced here — the caller applies the (0,1) rule.
 */
export function parseRegularFixedPointNumber(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === "string") {
    if (v.length === 0) return null;
    if (!/^-?\d+(?:\.\d+)?$/.test(v)) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Strictly parse a raw Kalshi CreateOrderV2 response body (HTTP already 2xx).
 *
 * Fail-closed contract:
 *   - top-level must be a plain object (reject null/array/primitive)
 *   - order_id must be a NON-EMPTY string for any trusted outcome
 *   - fill_count/fill_count_fp must be PRESENT and a finite nonnegative
 *     FixedPointCount at centi-contract precision; malformed values → unknown
 *   - filledCount must be <= requestedCount; requestedCount must be positive
 *   - validated 0 → zero_fill (avg may be absent/null)
 *   - positive fill → average_fill_price(_dollars) must be present, parseable,
 *     finite, and strictly inside (0,1); else unknown (CONFIRMED EXPOSURE at an
 *     indeterminate price — never zero-fill it, never fall back to cached price)
 */
export function parseRegularOrderResponse(
  raw: unknown,
  requestedCount: number,
): ParsedRegularOrder {
  const fail = (reason: string): ParsedRegularOrder => ({
    outcome: "unknown",
    reason,
    orderId: null,
    filledCount: null,
    avgPrice: null,
  });

  const requestedUnits = regularCountHundredths(requestedCount);
  if (requestedUnits == null || requestedUnits <= 0n) {
    return fail("bad_requested_count");
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("non_object_response");
  }
  const obj = raw as Record<string, unknown>;

  const rawOrderId = obj["order_id"];
  if (typeof rawOrderId !== "string" || rawOrderId.length === 0) {
    return fail("missing_order_id");
  }
  const orderId = rawOrderId;

  const rawFillFp = obj["fill_count_fp"];
  const rawFillLegacy = obj["fill_count"];
  if (rawFillFp == null && rawFillLegacy == null) return fail("missing_fill_count");
  const fillFpUnits = rawFillFp == null ? null : regularCountHundredths(rawFillFp);
  const fillLegacyUnits = rawFillLegacy == null ? null : regularCountHundredths(rawFillLegacy);
  if (
    (rawFillFp != null && fillFpUnits == null)
    || (rawFillLegacy != null && fillLegacyUnits == null)
  ) return fail("unparseable_fill_count");
  if (fillFpUnits != null && fillLegacyUnits != null && fillFpUnits !== fillLegacyUnits) {
    return fail("conflicting_fill_count");
  }
  const filledUnits = fillFpUnits ?? fillLegacyUnits;
  const filledCount = filledUnits == null ? null : Number(filledUnits) / 100;
  if (filledCount == null) return fail("unparseable_fill_count");
  if (filledUnits == null || filledUnits > requestedUnits) return fail("overfill_count");

  if (filledCount === 0) {
    return { outcome: "zero_fill", reason: "zero_fill", orderId, filledCount: 0, avgPrice: null };
  }

  const rawAvgDollars = obj["average_fill_price_dollars"];
  const rawAvgLegacy = obj["average_fill_price"];
  if (rawAvgDollars == null && rawAvgLegacy == null) return fail("missing_avg_price");
  const avgDollars = rawAvgDollars == null ? null : parseRegularFixedPointNumber(rawAvgDollars);
  const avgLegacy = rawAvgLegacy == null ? null : parseRegularFixedPointNumber(rawAvgLegacy);
  if (
    (rawAvgDollars != null && avgDollars == null)
    || (rawAvgLegacy != null && avgLegacy == null)
  ) return fail("invalid_avg_price");
  if (avgDollars != null && avgLegacy != null && Math.abs(avgDollars - avgLegacy) > 1e-9) {
    return fail("conflicting_avg_price");
  }
  const avg = avgDollars ?? avgLegacy;
  if (avg == null || avg <= 0 || avg >= 1) return fail("invalid_avg_price");

  return { outcome: "confirmed_fill", reason: "confirmed_fill", orderId, filledCount, avgPrice: avg };
}

/**
 * Compute the YES-side marketable-limit price (fraction 0.01–0.99) for a buy.
 * Pure and testable — no I/O.
 *
 * Base behaviour: with a reference `yesPrice` we cross the spread by
 * MARKETABLE_BUFFER (0.15) to guarantee a fill while bounding slippage; without
 * one we go fully aggressive (0.99 bid / 0.01 ask).
 *
 * Return-floor cap: when `minReturnMultiple > 1`, cap the price so the contract
 * cost can never exceed `1 / minReturnMultiple` (payout multiple = 1/cost):
 *   - bid  (buy YES): cost = price          → price ≤ maxCost
 *   - ask  (buy NO) : cost = 1 - price      → price ≥ 1 - maxCost
 * Combined with fill_or_kill, an order that can't fill within the cap is killed
 * rather than filling a low-return bet.
 */
export function computeMarketableLimitPrice(
  bookSide: "bid" | "ask",
  yesPrice: number | null | undefined,
  minReturnMultiple?: number | null,
  improvementCents?: number | null,
): number {
  const MARKETABLE_BUFFER = 0.15;
  const ref = yesPrice != null && yesPrice > 0 && yesPrice < 1 ? yesPrice : null;
  let priceFrac =
    bookSide === "bid"
      ? ref != null
        ? Math.min(ref + MARKETABLE_BUFFER, 0.99)
        : 0.99
      : ref != null
        ? Math.max(ref - MARKETABLE_BUFFER, 0.01)
        : 0.01;

  // Option-2 price improvement: when a fill_or_kill order is repeatedly killed
  // for insufficient resting volume, cross FURTHER into the book to capture
  // volume resting past our marketable price. Applied BEFORE the return-floor
  // cap below so an improved price can never breach the payout floor.
  //   bid (buy YES): pay more  → price + improvement
  //   ask (buy NO) : cost=1-price, pay more → price - improvement
  const improve = Math.max(0, improvementCents ?? 0) / 100;
  if (improve > 0) {
    priceFrac =
      bookSide === "bid"
        ? Math.min(priceFrac + improve, 0.99)
        : Math.max(priceFrac - improve, 0.01);
  }

  const minReturn = minReturnMultiple ?? 0;
  if (minReturn > 1) {
    const maxCost = 1 / minReturn;
    priceFrac =
      bookSide === "bid"
        ? Math.min(priceFrac, maxCost) // YES cost ≤ maxCost
        : Math.max(priceFrac, 1 - maxCost); // NO cost (1-price) ≤ maxCost
  }

  // Round to cent precision (Kalshi only accepts prices at 1-cent resolution).
  // Bid: round down so we never exceed the maxCost cap.
  // Ask: round up  so we never fall below the price floor (NO cost stays ≤ maxCost).
  const rounded =
    bookSide === "bid"
      ? Math.floor(priceFrac * 100) / 100
      : Math.ceil(priceFrac * 100) / 100;
  return Math.min(0.99, Math.max(0.01, rounded));
}

/**
 * Exact-ticker routing evidence published before an eligible regular quote.
 */
const regularOrderRouteCache = new Map<string, { exchangeIndex: number; preparedAt: number }>();
export const REGULAR_ORDER_ROUTE_TTL_MS = 2 * 60_000;

/**
 * Publish routing evidence fetched with the exact market snapshot during the
 * waiting period. Ticker identity is the cache key; malformed evidence is
 * ignored and can never replace a valid route.
 */
export function prewarmRegularOrderExchangeIndex(
  ticker: string,
  exchangeIndex: number | undefined,
  preparedAt = Date.now(),
): void {
  if (
    typeof ticker !== "string"
    || ticker.length === 0
    || !Number.isInteger(exchangeIndex)
    || (exchangeIndex ?? -1) < 0
    || !Number.isFinite(preparedAt)
  ) return;
  regularOrderRouteCache.set(ticker, { exchangeIndex: exchangeIndex!, preparedAt });
}

/** Synchronous, fail-closed route read for the regular entry critical path. */
export function getPreparedRegularOrderExchangeIndex(ticker: string): number | null {
  const cached = regularOrderRouteCache.get(ticker);
  if (!cached || Date.now() - cached.preparedAt > REGULAR_ORDER_ROUTE_TTL_MS) {
    return null;
  }
  return cached.exchangeIndex;
}

/** Exact worst-case cash reserved by an entry at its submitted YES-side limit. */
export function computeRegularWorstCaseRouteCost(
  side: "yes" | "no",
  submittedYesLimit: number,
  count: number,
): number | null {
  if (
    !Number.isFinite(submittedYesLimit)
    || submittedYesLimit < 0.01
    || submittedYesLimit > 0.99
    || regularCountHundredths(count) == null
    || count <= 0
  ) return null;
  const perContract = side === "yes" ? submittedYesLimit : 1 - submittedYesLimit;
  return perContract * count;
}

export async function resolveRegularOrderExchangeIndex(ticker: string): Promise<number> {
  const cached = getPreparedRegularOrderExchangeIndex(ticker);
  if (cached != null) return cached;
  const path = `/markets/${encodeURIComponent(ticker)}`;
  let raw: unknown;
  try {
    raw = await kalshiFetch<unknown>("GET", path, undefined, 8_000);
  } catch (err) {
    throw new Error(
      `Kalshi regular order routing lookup failed before POST for ${ticker}: ${String((err as Error)?.message ?? err)}`,
    );
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Kalshi regular order routing lookup returned malformed JSON for ${ticker}`);
  }
  const market = (raw as Record<string, unknown>)["market"];
  if (market == null || typeof market !== "object" || Array.isArray(market)) {
    throw new Error(`Kalshi regular order routing lookup missing market for ${ticker}`);
  }
  const resolvedTicker = (market as Record<string, unknown>)["ticker"];
  if (resolvedTicker !== ticker) {
    throw new Error(
      `Kalshi regular order routing ticker mismatch: requested ${ticker}, received ${String(resolvedTicker)}`,
    );
  }
  const rawExchangeIndex = (market as Record<string, unknown>)["exchange_index"];
  const exchangeIndex =
    typeof rawExchangeIndex === "number"
      ? rawExchangeIndex
      : typeof rawExchangeIndex === "string" && rawExchangeIndex.trim() !== ""
        ? Number(rawExchangeIndex)
        : NaN;
  if (!Number.isInteger(exchangeIndex) || exchangeIndex < 0) {
    throw new Error(`Kalshi regular order routing exchange_index invalid for ${ticker}`);
  }
  return exchangeIndex;
}

export async function placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  if (!hasKalshiCredentials()) throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
  const formattedCount = formatRegularFixedPointCount(params.count);
  const requestedUnits = regularCountHundredths(params.count);
  if (formattedCount == null || requestedUnits == null || requestedUnits <= 0n) {
    throw new Error("Kalshi order count must be a positive FixedPointCount with at most two decimal places");
  }

  // Kalshi Trade API v2: POST /portfolio/events/orders  (CreateOrderV2).
  // The legacy /portfolio/orders path returns 410 deprecated_v1_order_endpoint.
  //
  // The v2 endpoint quotes EVERYTHING from the YES side of the book:
  //   side="bid"  → acquire YES exposure  (buy yes, or sell/close a no position)
  //   side="ask"  → acquire NO  exposure  (buy no,  or sell/close a yes position)
  // Selling YES is economically buying NO at (1 - price); a "yes bid at 7¢" is
  // the same as a "no ask at 93¢".
  //
  // There is NO "market" order type in v2 — a market order is a marketable LIMIT
  // with an immediate time-in-force. We send an aggressive price that crosses
  // the spread; price-improvement means we never pay worse than the resting
  // book, and IOC/FOK guarantees the unfilled quantity never rests.
  const clientOrderId = params.clientOrderId?.trim() || crypto.randomUUID();

  // Which side of the YES book acquires the exposure we want.
  const wantYesExposure =
    (params.action === "buy" && params.side === "yes") ||
    (params.action === "sell" && params.side === "no");
  const bookSide = wantYesExposure ? "bid" : "ask";

  // Marketable limit price (fixed-point YES-side dollars, clamped 0.01–0.99).
  //
  // Two modes:
  //   a) limitPrice provided — caller already has the live ask; use it directly
  //      plus any priceImprovementCents escalation. No buffer, no return-floor cap.
  //   b) yesPrice provided — legacy midpoint mode: add MARKETABLE_BUFFER to cross
  //      the spread and optionally cap by minReturnMultiple.
  let priceFrac: number;
  if (params.limitPrice != null) {
    const improve = Math.max(0, params.priceImprovementCents ?? 0) / 100;
    const raw = bookSide === "bid"
      ? params.limitPrice + improve   // YES: pay more to fill
      : params.limitPrice - improve;  // NO (ask side): price lower to cross the bid
    // cent-precision rounding: bid floors, ask ceils (mirrors computeMarketableLimitPrice)
    priceFrac = bookSide === "bid"
      ? Math.floor(raw * 100) / 100
      : Math.ceil(raw * 100) / 100;
    priceFrac = Math.min(0.99, Math.max(0.01, priceFrac));
  } else {
    priceFrac = computeMarketableLimitPrice(
      bookSide,
      params.yesPrice,
      params.action === "buy" ? params.minReturnMultiple : undefined,
      params.priceImprovementCents,
    );
  }
  const price = priceFrac.toFixed(2); // FixedPointDollars string — cent resolution required by Kalshi
  // The regular bot's conviction path never performs a candidate-time
  // GET /markets/{ticker}; its exact route was published by the poller while
  // preparing the quote. Other callers retain the safe lookup behavior.
  const preparedRoute = params.requirePreparedRoute
    ? getPreparedRegularOrderExchangeIndex(params.ticker)
    : null;
  if (params.requirePreparedRoute && preparedRoute == null) {
    throw new Error(`Kalshi regular order route is absent or stale for ${params.ticker}; refusing candidate-time lookup`);
  }
  // Lookup is deliberately outside POST uncertainty handling: a failure proves
  // no submission occurred and must not become unknown exposure.
  const exchangeIndex = preparedRoute ?? await resolveRegularOrderExchangeIndex(params.ticker);

  const body: Record<string, unknown> = {
    client_order_id: clientOrderId,
    ticker: params.ticker,
    exchange_index: exchangeIndex,
    side: bookSide, // BookSide: "bid" | "ask"
    count: formattedCount, // FixedPointCount string, exact to centi-contracts
    price, // required in v2 (YES-side)
    // Kalshi only accepts "fill_or_kill" and "immediate_or_cancel".
    // "gtc" and "good_till_cancelled" both return 400 (oneof tag failure).
    time_in_force: (params.timeInForce ?? "fill_or_kill"),
    self_trade_prevention_type: "taker_at_cross",
  };

  // CreateOrderV2Response is a FLAT object (not wrapped in { order: {} }).
  //
  // NOTE: a fill_or_kill order killed for insufficient resting volume surfaces
  // as a THROWN 409 here — and that is intentional. Exit paths (sellYes/sellNo →
  // closePosition) rely on the throw to keep a live position OPEN and retry the
  // exit next tick; swallowing it here would strand a real position on the
  // exchange. The FOK "no fill, retry" behavior is handled ONLY in
  // placeOrderWithRetry (the entry path), which opts into retrying.
  // Raw response is parsed as an unknown object and passed to the STRICT parser.
  // A fill_or_kill 409 for insufficient resting volume is still THROWN by
  // kalshiFetch (non-2xx) — preserving the exit path's throw-to-keep-position-open
  // semantics (see .agents/memory/fok-retry-split.md). We only reach here on 2xx.
  //
  // Transport-ambiguity handling (Task #667 req #2): a definite HTTP rejection
  // carries a "→ <status>:" marker (the server answered — no fill accepted,
  // safe to retry / for the volume-retry helper to inspect). An abort/timeout/
  // network error has NO such marker: the request may have reached the exchange
  // and filled, so it is AMBIGUOUS and must surface as UNKNOWN LIVE EXPOSURE.
  let raw: unknown;
  try {
    raw = await submitAuthorizedKalshiCreateOrderV2(body, params.preSubmitGuard);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (err instanceof OrderSubmissionRevokedError) throw err;
    if (isUncertainOrderError(err)) throw err;
    const httpStatus = Number(msg.match(/→\s*(\d{3}):/)?.[1] ?? NaN);
    // Only verified client-side rejections are definite no-order outcomes.
    // 5xx/408/425/429 can be emitted by a proxy after the POST reached Kalshi;
    // treating those as zero and retrying can duplicate a real fill.
    const definitiveClientRejection =
      Number.isInteger(httpStatus) &&
      httpStatus >= 400 &&
      httpStatus < 500 &&
      ![408, 425, 429].includes(httpStatus) &&
      (httpStatus !== 409 || isInsufficientVolumeError(err));
    if (definitiveClientRejection) throw err;
    // No verified rejection ⇒ transport/timeout/ambiguous HTTP failure AFTER
    // send. The order may exist, so preserve the client id and halt.
    logger.error(
      { ticker: params.ticker, side: params.side, count: params.count, clientOrderId, httpStatus, err: msg },
      "[kalshi-trader] order POST result ambiguous — indeterminate outcome (possible live exposure)",
    );
    throw new UncertainOrderError(
      clientOrderId,
      Number.isInteger(httpStatus) ? `ambiguous_http_${httpStatus}` : "transport_or_timeout",
    );
  }

  // STRICT parse — never coerce a malformed fill_count to 0, and never let a
  // confirmed fill fall back to a cached price. An indeterminate result is
  // surfaced as UNKNOWN LIVE EXPOSURE via a typed throw carrying client_order_id.
  const parsed = parseRegularOrderResponse(raw, params.count);
  if (parsed.outcome === "unknown") {
    logger.error(
      { ticker: params.ticker, side: params.side, count: params.count, reason: parsed.reason, clientOrderId },
      "[kalshi-trader] strict order parse → UNKNOWN (indeterminate live exposure; not treating as zero fill)",
    );
    throw new UncertainOrderError(clientOrderId, parsed.reason);
  }
  if (
    parsed.outcome === "confirmed_fill" &&
    parsed.avgPrice != null &&
    (
      (bookSide === "bid" && parsed.avgPrice > priceFrac + 1e-9) ||
      (bookSide === "ask" && parsed.avgPrice < priceFrac - 1e-9)
    )
  ) {
    logger.error(
      { ticker: params.ticker, side: params.side, avgPrice: parsed.avgPrice, limitPrice: priceFrac, clientOrderId },
      "[kalshi-trader] confirmed fill contradicts submitted limit — UNKNOWN exposure; halting",
    );
    throw new UncertainOrderError(clientOrderId, "fill_breached_submitted_limit");
  }

  return {
    orderId: parsed.orderId,
    status: parsed.outcome === "confirmed_fill" ? "filled" : "unfilled",
    filledCount: parsed.filledCount ?? 0,
    // For zero_fill avgPrice is null; for confirmed_fill it is a validated (0,1)
    // fraction — never a cached fallback.
    avgPrice: parsed.avgPrice, // YES-side fraction 0-1, or null on zero fill
  };
}

// Cancel a resting order.  Returns true on 200/204 (cancelled), false on 404
// (order already gone — filled or expired), throws on other errors.
// NOTE: kalshiFetch is NOT used here because it always calls res.json(), which
// throws on a 204 No Content response (successful cancel with no body).
export async function cancelOrder(orderId: string): Promise<boolean> {
  if (!hasKalshiCredentials()) throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
  const path = `/portfolio/orders/${orderId}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${KALSHI_TRADE_BASE}${path}`, {
      method: "DELETE",
      headers: makeSignedHeaders("DELETE", path),
      signal: ctrl.signal,
    });
    if (res.status === 200 || res.status === 204) return true;
    if (res.status === 404) return false; // order already gone — not an error
    const text = await res.text().catch(() => "");
    throw new Error(`Kalshi DELETE ${path} → ${res.status}: ${text}`);
  } finally {
    clearTimeout(timer);
  }
}

// Normalized fill status returned by getOrder.
export type OrderStatus = "resting" | "filled" | "cancelled" | "unknown";

// Fetch current fill status for a resting order.
// Returns null when the order is not found (404 — expired or already cleared).
// NOTE: kalshiFetch is NOT used here so 404 can be handled non-fatally and the
// response shape can tolerate fields being strings or numbers (Kalshi type drift).
export async function getOrder(
  orderId: string,
  side: "yes" | "no",
): Promise<{ filledCount: number; status: OrderStatus; avgPrice: number | null } | null> {
  if (!hasKalshiCredentials()) throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
  const path = `/portfolio/orders/${orderId}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${KALSHI_TRADE_BASE}${path}`, {
      method: "GET",
      headers: makeSignedHeaders("GET", path),
      signal: ctrl.signal,
    });
    if (res.status === 404) return null; // order cleared by exchange — non-fatal
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kalshi GET ${path} → ${res.status}: ${text}`);
    }
    const data = (await res.json()) as {
      order?: {
        status?: string;
        yes_count?: number | string;
        no_count?: number | string;
        avg_price?: number | string;
      };
    };
    const o = data.order ?? {};
    // Number() handles both numeric and string fields (Kalshi type drift)
    const filled = parseRegularFixedPointCount(side === "yes" ? o.yes_count ?? 0 : o.no_count ?? 0);
    const raw = (o.status ?? "").toLowerCase();
    const status: OrderStatus =
      raw.includes("rest")                         ? "resting"   :
      raw.includes("execut") || raw.includes("fill") ? "filled"  :
      raw.includes("cancel")                       ? "cancelled" : "unknown";
    const avgRaw = o.avg_price != null ? Number(o.avg_price) : null;
    return {
      filledCount: filled ?? 0,
      status,
      avgPrice: avgRaw != null && Number.isFinite(avgRaw) ? avgRaw / 100 : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
// NOTE: getOrder is unused in the hot path — fill_or_kill orders resolve
// immediately in placeOrder's response, so there is no resting order to poll.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Kept for interface compatibility with existing callers; options are no longer used.
export interface PlaceOrderRetryOptions {
  immediateAttempts?: number;
  immediateDelayMs?: number;
  priceImprovementMaxCents?: number;
  priceImprovementDelayMs?: number;
  maxDurationMs?: number;
}

/**
 * Place an entry order, defaulting to immediate_or_cancel (IOC) unless the
 * caller explicitly supplies a timeInForce.
 *
 * IOC fills whatever resting contracts the book has at our limit price
 * right now and cancels the remainder — so a partial fill is perfectly fine.
 * The position is tracked by actual fill count, not the requested count.
 *
 * Regular conviction entries use IOC so immediately available contracts create
 * a position even when the full requested size is not resting at once.
 *
 * Exits (buyYes/buyNo/sellYes/sellNo) still use FOK via placeOrder directly
 * so we never leave a partial position stranded on the exchange.
 */
export async function placeOrderWithRetry(
  params: PlaceOrderParams,
  _opts: PlaceOrderRetryOptions = {}, // kept for interface compat; no longer used
  placeFn: (p: PlaceOrderParams) => Promise<PlaceOrderResult> = placeOrder,
): Promise<PlaceOrderResult> {
  // Respect caller-provided timeInForce; fall back to IOC for callers that
  // don't specify (preserves existing behaviour for non-conviction entry paths).
  return placeFn({ ...params, timeInForce: params.timeInForce ?? "immediate_or_cancel" });
}

/** True when the error is Kalshi's 409 for a FOK/IOC order that could not be
 *  matched against enough immediately-available resting volume. */
export function isInsufficientVolumeError(err: unknown): boolean {
  return String((err as Error)?.message ?? err).includes("insufficient_resting_volume");
}

/**
 * Entry-order placement with a single half-size fallback.
 *
 * Why: at $1 bet size (1 contract) FOK almost always matched; at $10+ (12–18
 * contracts) an all-or-nothing FOK is rejected with 409
 * fill_or_kill_insufficient_resting_volume even when MOST of the contracts are
 * available. Burning every per-window attempt at the same size guarantees zero
 * fills on thin books.
 *
 * Behaviour:
 *   1. Place the order at the requested count with the caller's timeInForce
 *      (defaults to IOC — partial fills accepted, tracked by actual fill count).
 *   2. If the exchange rejects it for insufficient resting volume AND count > 1,
 *      retry ONCE at floor(count/2) (min 1).
 *   3. If the halved retry is also volume-rejected — or count was already 1 —
 *      return a synthetic 0-fill result instead of throwing, so the caller's
 *      existing zero-fill accounting (attempt counter → window block) applies.
 *
 * Any non-volume error is re-thrown unchanged: auth failures, invalid tickers,
 * timeouts etc. must surface to the caller's error path, never be masked as
 * "no fill". Exits must NOT use this helper — they rely on the 409 throw to
 * keep a live position open for retry (see placeOrder note).
 */
export async function placeEntryOrderWithSizeFallback(
  params: PlaceOrderParams,
  placeFn: (p: PlaceOrderParams) => Promise<PlaceOrderResult> = placeOrder,
  opts?: { disableHalfSizeRetry?: boolean },
): Promise<PlaceOrderResult & { attemptedCount: number }> {
  const timeInForce = params.timeInForce ?? "immediate_or_cancel";
  try {
    const r = await placeFn({ ...params, timeInForce });
    return { ...r, attemptedCount: params.count };
  } catch (err) {
    if (!isInsufficientVolumeError(err)) throw err;
    if (opts?.disableHalfSizeRetry) {
      // Single-attempt mode (used by the one-shot IOC remainder re-attempt):
      // a volume rejection is FINAL — report 0 fills, place no further orders.
      logger.warn(
        { ticker: params.ticker, side: params.side, count: params.count, timeInForce },
        "[kalshi-trader] entry volume-rejected in single-attempt mode — reporting 0 fills (no half-size retry)",
      );
      return { orderId: null, status: "unfilled", filledCount: 0, avgPrice: null, attemptedCount: params.count };
    }
    const halved = Math.max(1, Math.floor(params.count / 2));
    if (halved >= params.count) {
      // Already at 1 contract — nothing smaller to try. Synthetic 0-fill.
      logger.warn(
        { ticker: params.ticker, side: params.side, count: params.count, timeInForce },
        "[kalshi-trader] entry rejected — insufficient resting volume at minimum size (1 contract)",
      );
      return { orderId: null, status: "unfilled", filledCount: 0, avgPrice: null, attemptedCount: params.count };
    }
    logger.warn(
      { ticker: params.ticker, side: params.side, requested: params.count, halved, timeInForce },
      "[kalshi-trader] entry rejected — insufficient resting volume; retrying once at half size",
    );
    try {
      const r2 = await placeFn({ ...params, count: halved, timeInForce });
      return { ...r2, attemptedCount: halved };
    } catch (err2) {
      if (!isInsufficientVolumeError(err2)) throw err2;
      logger.warn(
        { ticker: params.ticker, side: params.side, halved, timeInForce },
        "[kalshi-trader] half-size entry also volume-rejected — reporting 0 fills to caller",
      );
      return { orderId: null, status: "unfilled", filledCount: 0, avgPrice: null, attemptedCount: halved };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Check if API credentials are configured (doesn't validate them).
export function isKalshiConfigured(): boolean {
  return hasKalshiCredentials();
}

// ---------------------------------------------------------------------------
// Cached balance fetch (10-second TTL)
// ---------------------------------------------------------------------------
// getBalance() makes a live Kalshi API call.  For per-bet guards we need a
// reasonably fresh balance without hammering the API on every tick.  10 s is
// tight enough to catch a real drain between consecutive bets in the same window.

const _balanceCache = new Map<string, { availableBalance: number; fetchedAt: number }>();
const _balanceInflight = new Map<string, Promise<number>>();
let _regularAccountSnapshot: RegularAccountSnapshot | null = null;
let _regularAccountPrewarmInflight: Promise<void> | null = null;
let _regularAccountSnapshotGeneration = 0;
const _regularRouteFundingHolds = new Map<string, {
  ticker: string;
  exchangeIndex: number;
  reservedCost: number;
}>();
const BALANCE_CACHE_TTL_MS = 10_000;
// The authenticated GET itself may consume its full 10 s timeout. The previous
// 10 s usable TTL plus an 8 s refresh point guaranteed a dead zone from t=10
// until a slow replacement completed at up to t=18. Keep the last authoritative
// snapshot usable for one bounded 30 s window while refreshing every 5 s.
// At 30 s without a successful refresh, live entry still fails closed.
export const REGULAR_ACCOUNT_SNAPSHOT_TTL_MS = 30_000;
export const REGULAR_ACCOUNT_REFRESH_INTERVAL_MS = 5_000;

/** Keep the authenticated aggregate account snapshot hot before a regular
 * conviction quote becomes eligible. Coalescing is provided by the balance
 * cache; callers intentionally do not await this on the hot path. */
export function prewarmRegularAccountSnapshot(): Promise<void> {
  const snapshot = _regularAccountSnapshot;
  if (
    snapshot &&
    Date.now() - snapshot.fetchedAt < REGULAR_ACCOUNT_REFRESH_INTERVAL_MS
  ) {
    return Promise.resolve();
  }
  if (_regularAccountPrewarmInflight) return _regularAccountPrewarmInflight;
  // Retain all shard balances from the one authenticated aggregate response;
  // quote-time must never fetch either aggregate or route-specific balance.
  const generation = _regularAccountSnapshotGeneration;
  let request!: Promise<void>;
  request = getBalance()
    .then((balance) => {
      // A post-fill invalidation wins over an older in-flight response.
      if (generation !== _regularAccountSnapshotGeneration) return;
      const fetchedAt = Date.now();
      _balanceCache.set("aggregate", { availableBalance: balance.availableBalance, fetchedAt });
      _regularAccountSnapshot = {
        availableBalance: balance.availableBalance,
        availableBalanceByExchange: new Map(
          (balance.balanceBreakdown ?? []).map((entry) => [entry.exchangeIndex, entry.availableBalance]),
        ),
        fetchedAt,
      };
    })
    .catch((err) => {
      logger.debug({ err }, "[kalshi] regular account snapshot prewarm failed");
    })
    .finally(() => {
      if (_regularAccountPrewarmInflight === request) {
        _regularAccountPrewarmInflight = null;
      }
    });
  _regularAccountPrewarmInflight = request;
  return request;
}

/** Synchronous fail-closed read used after quote eligibility. */
export function getFreshRegularAccountSnapshot(): number | null {
  const snapshot = getFreshRegularAccountSnapshotForRoute();
  return snapshot?.availableBalance ?? null;
}

/** Exact-route synchronous snapshot read. Missing shard evidence is unsafe. */
export function getFreshRegularAccountSnapshotForRoute(exchangeIndex?: number): RegularAccountSnapshot | null {
  const snapshot = _regularAccountSnapshot;
  if (!snapshot || Date.now() - snapshot.fetchedAt > REGULAR_ACCOUNT_SNAPSHOT_TTL_MS) {
    return null;
  }
  if (exchangeIndex != null && !snapshot.availableBalanceByExchange.has(exchangeIndex)) return null;
  return snapshot;
}

export function getRegularAccountSnapshotDiagnostics(): {
  available: boolean;
  ageMs: number | null;
  refreshInFlight: boolean;
  usableTtlMs: number;
  activeFundingHolds: number;
} {
  return {
    available: _regularAccountSnapshot != null,
    ageMs: _regularAccountSnapshot == null ? null : Math.max(0, Date.now() - _regularAccountSnapshot.fetchedAt),
    refreshInFlight: _regularAccountPrewarmInflight != null,
    usableTtlMs: REGULAR_ACCOUNT_SNAPSHOT_TTL_MS,
    activeFundingHolds: _regularRouteFundingHolds.size,
  };
}

/** Synchronous exact-route funding predicate for the pre-fetch hot path. */
export function hasFreshRegularPreparedRouteFunding(ticker: string, requiredCost: number): boolean {
  if (!Number.isFinite(requiredCost) || requiredCost <= 0) return false;
  const exchangeIndex = getPreparedRegularOrderExchangeIndex(ticker);
  const snapshot = exchangeIndex == null
    ? null
    : getFreshRegularAccountSnapshotForRoute(exchangeIndex);
  const routeBalance = exchangeIndex == null
    ? null
    : snapshot?.availableBalanceByExchange.get(exchangeIndex) ?? null;
  return routeBalance != null && routeBalance + 1e-9 >= requiredCost;
}

function heldRegularRouteCost(exchangeIndex: number): number {
  let total = 0;
  for (const hold of _regularRouteFundingHolds.values()) {
    if (hold.exchangeIndex === exchangeIndex) total += hold.reservedCost;
  }
  return total;
}

/**
 * Reserve exact-route cash in memory after the durable DB intent is claimed.
 * This closes the gap where parallel live ticks could all authorize against the
 * same prepared shard balance before any of their fills update the account.
 */
export function claimRegularRouteFundingHold(
  ticker: string,
  reservationId: string,
  requiredCost: number,
): boolean {
  if (!reservationId || !Number.isFinite(requiredCost) || requiredCost <= 0) return false;
  const existing = _regularRouteFundingHolds.get(reservationId);
  if (existing) {
    return existing.ticker === ticker && Math.abs(existing.reservedCost - requiredCost) < 1e-9;
  }
  const exchangeIndex = getPreparedRegularOrderExchangeIndex(ticker);
  if (exchangeIndex == null) return false;
  const snapshot = getFreshRegularAccountSnapshotForRoute(exchangeIndex);
  const routeBalance = snapshot?.availableBalanceByExchange.get(exchangeIndex) ?? null;
  if (routeBalance == null || routeBalance - heldRegularRouteCost(exchangeIndex) + 1e-9 < requiredCost) {
    return false;
  }
  _regularRouteFundingHolds.set(reservationId, { ticker, exchangeIndex, reservedCost: requiredCost });
  return true;
}

/** Final synchronous authorization at the exact broker-POST boundary. */
export function hasAuthorizedRegularRouteFundingHold(
  ticker: string,
  reservationId: string,
): boolean {
  const hold = _regularRouteFundingHolds.get(reservationId);
  if (!hold || hold.ticker !== ticker) return false;
  if (getPreparedRegularOrderExchangeIndex(ticker) !== hold.exchangeIndex) return false;
  const snapshot = getFreshRegularAccountSnapshotForRoute(hold.exchangeIndex);
  const routeBalance = snapshot?.availableBalanceByExchange.get(hold.exchangeIndex) ?? null;
  return routeBalance != null && routeBalance + 1e-9 >= heldRegularRouteCost(hold.exchangeIndex);
}

export function releaseRegularRouteFundingHold(reservationId: string): void {
  _regularRouteFundingHolds.delete(reservationId);
}

/**
 * Convert a confirmed order's temporary hold into a conservative local debit.
 * The debit prevents subsequent entries from reusing cash while the background
 * authoritative refresh is slow. Any pre-fill response already in flight is
 * generation-revoked so it cannot overwrite the debit.
 */
export function commitRegularRouteFundingHold(
  reservationId: string,
  actualCost: number,
): boolean {
  const hold = _regularRouteFundingHolds.get(reservationId);
  if (!hold || !Number.isFinite(actualCost) || actualCost < 0) return false;
  const snapshot = _regularAccountSnapshot;
  if (!snapshot) return false;

  const debit = Math.min(Math.max(actualCost, 0), hold.reservedCost);
  const byExchange = new Map(snapshot.availableBalanceByExchange);
  const routeBalance = byExchange.get(hold.exchangeIndex);
  if (routeBalance == null) return false;
  _regularRouteFundingHolds.delete(reservationId);
  byExchange.set(hold.exchangeIndex, Math.max(0, routeBalance - debit));

  _regularAccountSnapshotGeneration++;
  _regularAccountSnapshot = {
    availableBalance: Math.max(0, snapshot.availableBalance - debit),
    availableBalanceByExchange: byExchange,
    fetchedAt: snapshot.fetchedAt,
  };
  _balanceCache.clear();
  _balanceCache.set("aggregate", {
    availableBalance: _regularAccountSnapshot.availableBalance,
    fetchedAt: snapshot.fetchedAt,
  });
  void prewarmRegularAccountSnapshot();
  return true;
}

/** Return Kalshi available balance in dollars, cached for up to 10 seconds.
 *  On fetch failure, falls back to the stale cached value (if any) rather than
 *  aborting the trade — a transient Kalshi API timeout should not kill all bets
 *  when we already have a recent balance reading. */
export async function getCachedKalshiBalance(exchangeIndex?: number): Promise<number> {
  const now = Date.now();
  const cacheKey = exchangeIndex == null ? "aggregate" : `exchange:${exchangeIndex}`;
  const cached = _balanceCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < BALANCE_CACHE_TTL_MS) {
    return cached.availableBalance;
  }
  const existing = _balanceInflight.get(cacheKey);
  if (existing) return existing;
  const regularSnapshotGeneration = _regularAccountSnapshotGeneration;
  let request!: Promise<number>;
  request = (async () => {
    try {
      const bal = await getBalance(exchangeIndex);
      const fetchedAt = Date.now();
      _balanceCache.set(cacheKey, { availableBalance: bal.availableBalance, fetchedAt });
      if (exchangeIndex == null && regularSnapshotGeneration === _regularAccountSnapshotGeneration) {
        _regularAccountSnapshot = {
          availableBalance: bal.availableBalance,
          availableBalanceByExchange: new Map(
            (bal.balanceBreakdown ?? []).map((entry) => [entry.exchangeIndex, entry.availableBalance]),
          ),
          fetchedAt,
        };
      }
      return bal.availableBalance;
    } catch (err) {
      if (cached) {
        const staleAgeMs = now - cached.fetchedAt;
        // Use stale cache (up to 60 s old) rather than aborting the trade
        if (staleAgeMs < 60_000) {
          logger.warn({ err }, "[kalshi] balance fetch failed — using stale cache (%ds old)", Math.round(staleAgeMs / 1000));
          return cached.availableBalance;
        }
      }
      throw err;
    } finally {
      if (_balanceInflight.get(cacheKey) === request) _balanceInflight.delete(cacheKey);
    }
  })();
  _balanceInflight.set(cacheKey, request);
  return request;
}

/** Invalidate the cached balance (call after a bet is placed so the next guard
 *  sees the post-fill balance, not a stale pre-fill value). */
export function invalidateBalanceCache(exchangeIndex?: number): void {
  if (exchangeIndex == null) {
    _balanceCache.clear();
    _regularAccountSnapshotGeneration++;
    _regularAccountSnapshot = null;
    return;
  }
  _balanceCache.delete(`exchange:${exchangeIndex}`);
}

// Buy Yes contracts at market price.
// Returns null on paper mode (caller handles the no-op).
export async function buyYes(ticker: string, count: number): Promise<PlaceOrderResult> {
  return placeOrder({ ticker, side: "yes", action: "buy", count, type: "market" });
}

// Buy No contracts at market price.
export async function buyNo(ticker: string, count: number): Promise<PlaceOrderResult> {
  return placeOrder({ ticker, side: "no", action: "buy", count, type: "market" });
}

// Sell (close) Yes contracts at market price.
export async function sellYes(
  ticker: string,
  count: number,
  clientOrderId?: string,
  limitPrice?: number,
  preSubmitGuard?: () => boolean,
): Promise<PlaceOrderResult> {
  return placeOrder({
    ticker, side: "yes", action: "sell", count, type: "market",
    clientOrderId, limitPrice, preSubmitGuard,
  });
}

// Sell (close) No contracts at market price.
export async function sellNo(
  ticker: string,
  count: number,
  clientOrderId?: string,
  limitPrice?: number,
  preSubmitGuard?: () => boolean,
): Promise<PlaceOrderResult> {
  return placeOrder({
    ticker, side: "no", action: "sell", count, type: "market",
    clientOrderId, limitPrice, preSubmitGuard,
  });
}
