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

import crypto from "crypto";
import { logger } from "./logger.ts";

const KALSHI_TRADE_BASE = "https://api.elections.kalshi.com/trade-api/v2";

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

  // The key is stored as raw base64 without PEM headers (common when pasted
  // directly from Kalshi's dashboard).  Reconstruct a proper PKCS#1 RSA PEM:
  //   -----BEGIN RSA PRIVATE KEY-----
  //   <base64, 64 chars per line>
  //   -----END RSA PRIVATE KEY-----
  // Strip any whitespace/newlines from the raw value first.
  const b64 = raw.replace(/\s+/g, "");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return [
    "-----BEGIN RSA PRIVATE KEY-----",
    ...lines,
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
}

function makeSignedHeaders(method: string, path: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const keyId = getKeyId();
  const privateKeyPem = getPrivateKey();
  if (!keyId || !privateKeyPem) return h;

  const timestampMs = Date.now().toString();
  // Signature message: timestamp + METHOD + /trade-api/v2 + path
  // Strip any query string from the path for signing
  const pathWithoutQuery = path.split("?")[0];
  const message = timestampMs + method.toUpperCase() + "/trade-api/v2" + pathWithoutQuery;

  const sign = crypto.createSign("SHA256");
  sign.update(message);
  sign.end();
  const signature = sign.sign(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING },
    "base64",
  );

  h["KALSHI-ACCESS-KEY"] = keyId;
  h["KALSHI-ACCESS-TIMESTAMP"] = timestampMs;
  h["KALSHI-ACCESS-SIGNATURE"] = signature;
  return h;
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
      floorStrike: typeof m.floor_strike === "number" ? m.floor_strike : null,
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
}

export async function getBalance(): Promise<KalshiBalance> {
  // GET /portfolio/balance — Kalshi trade-api v2.
  // Confirmed response shape (2026-07):
  //   { balance: <cents int>,          ← available CASH (what you can bet with)
  //     portfolio_value: <cents int>,  ← current mark-to-market position value
  //     balance_dollars: "<string>",   ← cash as a decimal string
  //     balance_breakdown: [...],      ← per-exchange breakdown
  //     updated_ts: <unix seconds> }
  //
  // Total portfolio = balance + portfolio_value (matches Kalshi app's Portfolio figure).
  // We expose "available cash" as availableBalance so balance guards work correctly.
  const raw = await kalshiFetch<Record<string, unknown>>("GET", "/portfolio/balance");

  const num = (key: string): number | null => {
    const v = raw[key];
    return typeof v === "number" ? v : null;
  };

  const cashCents = num("balance") ?? 0;
  const positionCents = num("portfolio_value") ?? 0;

  return {
    availableBalance: cashCents / 100,
    totalBalance: (cashCents + positionCents) / 100,
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
  // Kalshi v2 API uses abbreviated strings: "gtc" not "good_till_cancelled".
  timeInForce?: "fill_or_kill" | "immediate_or_cancel" | "good_till_cancelled" | "gtc";
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
}

export interface PlaceOrderResult {
  orderId: string | null;
  status: string;
  filledCount: number;
  avgPrice: number | null; // in fraction (0-1)
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

export async function placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  if (!getKeyId() || !getPrivateKey()) throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");

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
  // with time_in_force="fill_or_kill". We send an aggressive price that crosses
  // the spread; price-improvement means we never pay worse than the resting book,
  // and FOK guarantees the whole order fills at once or is killed (never rests).
  const clientOrderId = crypto.randomUUID();

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

  const body: Record<string, unknown> = {
    client_order_id: clientOrderId,
    ticker: params.ticker,
    side: bookSide, // BookSide: "bid" | "ask"
    count: String(params.count), // FixedPointCount string
    price, // required in v2 (YES-side)
    // Kalshi v2 API only accepts abbreviated TIF strings.
    // Map legacy long-form values defensively.
    time_in_force: (params.timeInForce === "good_till_cancelled" ? "gtc" : (params.timeInForce ?? "fill_or_kill")),
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
  const data = await kalshiFetch<{
    order_id?: string;
    fill_count?: string;
    remaining_count?: string;
    average_fill_price?: string; // fixed-point YES-side dollars
  }>("POST", "/portfolio/events/orders", body);

  const filled = data.fill_count != null ? parseFloat(data.fill_count) || 0 : 0;
  const avg = data.average_fill_price != null ? parseFloat(data.average_fill_price) : NaN;
  return {
    orderId: data.order_id ?? null,
    status: filled > 0 ? "filled" : "unfilled",
    filledCount: filled,
    avgPrice: Number.isFinite(avg) ? avg : null, // YES-side fraction 0-1
  };
}

// Cancel a resting order.  Returns true on 200/204 (cancelled), false on 404
// (order already gone — filled or expired), throws on other errors.
// NOTE: kalshiFetch is NOT used here because it always calls res.json(), which
// throws on a 204 No Content response (successful cancel with no body).
export async function cancelOrder(orderId: string): Promise<boolean> {
  if (!getKeyId() || !getPrivateKey()) throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
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
  if (!getKeyId() || !getPrivateKey()) throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
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
    const filled = side === "yes" ? Number(o.yes_count ?? 0) : Number(o.no_count ?? 0);
    const raw = (o.status ?? "").toLowerCase();
    const status: OrderStatus =
      raw.includes("rest")                         ? "resting"   :
      raw.includes("execut") || raw.includes("fill") ? "filled"  :
      raw.includes("cancel")                       ? "cancelled" : "unknown";
    const avgRaw = o.avg_price != null ? Number(o.avg_price) : null;
    return {
      filledCount: Number.isFinite(filled) ? Math.round(filled) : 0,
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
 * Place an immediate_or_cancel (IOC) entry order.
 *
 * IOC fills whatever resting contracts the book has at our limit price
 * right now and cancels the remainder — so a partial fill is perfectly fine.
 * The position is tracked by actual fill count, not the requested count.
 *
 * Why IOC instead of FOK:
 *   - FOK requires ALL requested contracts to be available simultaneously;
 *     a thin book causes a 409 that forces a multi-second retry loop.
 *   - IOC fills immediately with whatever the book offers — 3 out of 5
 *     contracts is a successful entry, not a failure. This is far faster
 *     and more reliable for time-sensitive 15-minute windows.
 *
 * Exits (buyYes/buyNo/sellYes/sellNo) still use FOK via placeOrder directly
 * so we never leave a partial position stranded on the exchange.
 */
export async function placeOrderWithRetry(
  params: PlaceOrderParams,
  _opts: PlaceOrderRetryOptions = {}, // kept for interface compat; no longer used
  placeFn: (p: PlaceOrderParams) => Promise<PlaceOrderResult> = placeOrder,
): Promise<PlaceOrderResult> {
  return placeFn({ ...params, timeInForce: "immediate_or_cancel" });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Check if API credentials are configured (doesn't validate them).
export function isKalshiConfigured(): boolean {
  return !!(getKeyId() && getPrivateKey());
}

// ---------------------------------------------------------------------------
// Cached balance fetch (10-second TTL)
// ---------------------------------------------------------------------------
// getBalance() makes a live Kalshi API call.  For per-bet guards we need a
// reasonably fresh balance without hammering the API on every tick.  10 s is
// tight enough to catch a real drain between consecutive bets in the same window.

let _balanceCache: { availableBalance: number; fetchedAt: number } | null = null;
const BALANCE_CACHE_TTL_MS = 10_000;

/** Return Kalshi available balance in dollars, cached for up to 10 seconds.
 *  On fetch failure, falls back to the stale cached value (if any) rather than
 *  aborting the trade — a transient Kalshi API timeout should not kill all bets
 *  when we already have a recent balance reading. */
export async function getCachedKalshiBalance(): Promise<number> {
  const now = Date.now();
  if (_balanceCache && now - _balanceCache.fetchedAt < BALANCE_CACHE_TTL_MS) {
    return _balanceCache.availableBalance;
  }
  try {
    const bal = await getBalance();
    _balanceCache = { availableBalance: bal.availableBalance, fetchedAt: now };
    return bal.availableBalance;
  } catch (err) {
    if (_balanceCache) {
      const staleAgeMs = now - _balanceCache.fetchedAt;
      // Use stale cache (up to 60 s old) rather than aborting the trade
      if (staleAgeMs < 60_000) {
        logger.warn({ err }, "[kalshi] balance fetch failed — using stale cache (%ds old)", Math.round(staleAgeMs / 1000));
        return _balanceCache.availableBalance;
      }
    }
    throw err;
  }
}

/** Invalidate the cached balance (call after a bet is placed so the next guard
 *  sees the post-fill balance, not a stale pre-fill value). */
export function invalidateBalanceCache(): void {
  _balanceCache = null;
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
export async function sellYes(ticker: string, count: number): Promise<PlaceOrderResult> {
  return placeOrder({ ticker, side: "yes", action: "sell", count, type: "market" });
}

// Sell (close) No contracts at market price.
export async function sellNo(ticker: string, count: number): Promise<PlaceOrderResult> {
  return placeOrder({ ticker, side: "no", action: "sell", count, type: "market" });
}
