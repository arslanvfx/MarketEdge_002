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
  yesPrice?: number; // reference YES price as a fraction (0-1); used to bound the marketable-limit price
}

export interface PlaceOrderResult {
  orderId: string | null;
  status: string;
  filledCount: number;
  avgPrice: number | null; // in fraction (0-1)
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
  // With a reference yesPrice we bound slippage to ±MARKETABLE_BUFFER; without
  // one (e.g. exits) we go fully aggressive to guarantee the fill.
  const MARKETABLE_BUFFER = 0.15;
  const ref =
    params.yesPrice != null && params.yesPrice > 0 && params.yesPrice < 1 ? params.yesPrice : null;
  const priceFrac =
    bookSide === "bid"
      ? ref != null
        ? Math.min(ref + MARKETABLE_BUFFER, 0.99)
        : 0.99
      : ref != null
        ? Math.max(ref - MARKETABLE_BUFFER, 0.01)
        : 0.01;
  const price = priceFrac.toFixed(4); // FixedPointDollars string

  const body: Record<string, unknown> = {
    client_order_id: clientOrderId,
    ticker: params.ticker,
    side: bookSide, // BookSide: "bid" | "ask"
    count: String(params.count), // FixedPointCount string
    price, // required in v2 (YES-side)
    time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
  };

  // CreateOrderV2Response is a FLAT object (not wrapped in { order: {} }).
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

export async function cancelOrder(orderId: string): Promise<void> {
  if (!getKeyId() || !getPrivateKey()) throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
  await kalshiFetch("DELETE", `/portfolio/orders/${orderId}`);
}

// Fetch current fill status for an existing order.
export async function getOrder(
  orderId: string,
  side: "yes" | "no",
): Promise<{ filledCount: number; status: string; avgPrice: number | null }> {
  if (!getKeyId() || !getPrivateKey()) throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
  const data = await kalshiFetch<{
    order?: {
      status?: string;
      yes_count?: number;
      no_count?: number;
      avg_price?: number;
    };
  }>("GET", `/portfolio/orders/${orderId}`);
  const o = data.order ?? {};
  const filled = side === "yes" ? (o.yes_count ?? 0) : (o.no_count ?? 0);
  return {
    filledCount: filled,
    status: o.status ?? "unknown",
    avgPrice: o.avg_price != null ? o.avg_price / 100 : null,
  };
}
// NOTE: getOrder is unused in the hot path — fill_or_kill orders resolve
// immediately in placeOrder's response, so there is no resting order to poll.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Place an order and retry up to maxRetries times if it doesn't fill.
// fill_or_kill orders never rest on the book — each attempt either fully fills
// immediately or is killed — so there is no resting order to poll or cancel
// between attempts. We simply re-place the order after a short delay.
export async function placeOrderWithRetry(
  params: PlaceOrderParams,
  maxRetries = 3,
  retryDelayMs = 1_500,
): Promise<PlaceOrderResult> {
  let lastResult: PlaceOrderResult = { orderId: null, status: "unfilled", filledCount: 0, avgPrice: null };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    lastResult = await placeOrder(params);

    if (lastResult.filledCount > 0) {
      return lastResult; // filled (most common case)
    }

    // Killed (unfilled) — wait briefly, then re-place a fresh order.
    if (attempt < maxRetries - 1) {
      await sleep(retryDelayMs);
    }
  }

  return lastResult;
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

/** Return Kalshi available balance in dollars, cached for up to 10 seconds. */
export async function getCachedKalshiBalance(): Promise<number> {
  const now = Date.now();
  if (_balanceCache && now - _balanceCache.fetchedAt < BALANCE_CACHE_TTL_MS) {
    return _balanceCache.availableBalance;
  }
  const bal = await getBalance();
  _balanceCache = { availableBalance: bal.availableBalance, fetchedAt: now };
  return bal.availableBalance;
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
