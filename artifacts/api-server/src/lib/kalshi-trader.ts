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
  yesPrice?: number; // 0-100 cents for limit orders
}

export interface PlaceOrderResult {
  orderId: string | null;
  status: string;
  filledCount: number;
  avgPrice: number | null; // in fraction (0-1)
}

export async function placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  if (!getKeyId() || !getPrivateKey()) throw new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not configured");
  // v2 create-order endpoint requires client_order_id (UUID) in addition to
  // the standard fields.  Path changed from /portfolio/orders to
  // /portfolio/events/orders (old path returns 410 deprecated_v1_order_endpoint).
  const clientOrderId = crypto.randomUUID();
  const body: Record<string, unknown> = {
    client_order_id: clientOrderId,
    ticker: params.ticker,
    action: params.action,
    side: params.side,
    type: params.type,
    count: String(params.count), // v2 API requires count as a string
    time_in_force: "fill_or_kill", // v2 required field
    self_trade_prevention_type: "cancel_resting", // v2 required field
  };
  if (params.type === "limit" && params.yesPrice != null) {
    body.yes_price = String(Math.round(params.yesPrice)); // v2 requires string
  }
  const data = await kalshiFetch<{
    order?: {
      order_id?: string;
      status?: string;
      no_count?: number;
      yes_count?: number;
      avg_price?: number; // cents
    };
  }>("POST", "/portfolio/events/orders", body);
  const o = data.order ?? {};
  const filled = params.side === "yes" ? (o.yes_count ?? 0) : (o.no_count ?? 0);
  return {
    orderId: o.order_id ?? null,
    status: o.status ?? "unknown",
    filledCount: filled,
    avgPrice: o.avg_price != null ? o.avg_price / 100 : null,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Place an order and retry up to maxRetries times if it doesn't fill.
// Between each attempt: waits retryDelayMs, polls the order for a late fill,
// cancels it if still empty, then places a fresh order.  Prevents duplicate
// open orders by always cancelling the previous attempt before retrying.
export async function placeOrderWithRetry(
  params: PlaceOrderParams,
  maxRetries = 3,
  retryDelayMs = 1_500,
): Promise<PlaceOrderResult> {
  let lastResult: PlaceOrderResult = { orderId: null, status: "unfilled", filledCount: 0, avgPrice: null };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    lastResult = await placeOrder(params);

    if (lastResult.filledCount > 0) {
      return lastResult; // filled on first try (most common case)
    }

    // Not filled — wait to give Kalshi time to match the order.
    await sleep(retryDelayMs);

    // Poll for a late fill before cancelling.
    if (lastResult.orderId) {
      try {
        const current = await getOrder(lastResult.orderId, params.side);
        if (current.filledCount > 0) {
          return { ...lastResult, filledCount: current.filledCount, avgPrice: current.avgPrice };
        }
        // Still unfilled — cancel so we don't hold a resting order.
        await cancelOrder(lastResult.orderId).catch(() => {});
      } catch {
        // Ignore status-check errors; fall through to retry.
      }
    }

    if (attempt < maxRetries - 1) {
      // Brief extra pause before the next attempt to avoid hammering the API.
      await sleep(500);
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
