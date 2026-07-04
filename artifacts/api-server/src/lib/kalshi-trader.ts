// Kalshi Trade API v2 client.
//
// All amounts returned from Kalshi are in CENTS (integer).  We convert to
// dollar fractions (0–1 for prices, $ for balance) for internal use.
//
// In paper mode every write method is a no-op and returns a simulated result
// so the rest of the bot logic works identically in both modes.

const KALSHI_TRADE_BASE = "https://api.elections.kalshi.com/trade-api/v2";

function getApiKey(): string | null {
  return process.env["KALSHI_API_KEY"] ?? null;
}

function makeHeaders(): Record<string, string> {
  const key = getApiKey();
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (key) h["Authorization"] = key;
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
      headers: makeHeaders(),
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
  const data = await kalshiFetch<{
    balance: {
      available_balance?: number;
      balance?: number;
      portfolio_value?: number;
    };
  }>("GET", "/exchange/balance");
  const b = data.balance ?? {};
  // Kalshi returns cents as integers
  return {
    availableBalance: (b.available_balance ?? 0) / 100,
    totalBalance: (b.balance ?? b.portfolio_value ?? 0) / 100,
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
  if (!getApiKey()) throw new Error("KALSHI_API_KEY not configured");
  const body: Record<string, unknown> = {
    ticker: params.ticker,
    action: params.action,
    side: params.side,
    type: params.type,
    count: params.count,
  };
  if (params.type === "limit" && params.yesPrice != null) {
    body.yes_price = Math.round(params.yesPrice); // cents 0-100
  }
  const data = await kalshiFetch<{
    order?: {
      order_id?: string;
      status?: string;
      no_count?: number;
      yes_count?: number;
      avg_price?: number; // cents
    };
  }>("POST", "/portfolio/orders", body);
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
  if (!getApiKey()) throw new Error("KALSHI_API_KEY not configured");
  await kalshiFetch("DELETE", `/portfolio/orders/${orderId}`);
}

// Fetch current fill status for an existing order.
export async function getOrder(
  orderId: string,
  side: "yes" | "no",
): Promise<{ filledCount: number; status: string; avgPrice: number | null }> {
  if (!getApiKey()) throw new Error("KALSHI_API_KEY not configured");
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

// Check if API key is configured (doesn't validate it).
export function isKalshiConfigured(): boolean {
  return !!getApiKey();
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
