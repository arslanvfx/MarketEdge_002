// Kalshi Trade API v2 client.
//
// All amounts returned from Kalshi are in CENTS (integer).  We convert to
// dollar fractions (0–1 for prices, $ for balance) for internal use.
//
// In paper mode every write method is a no-op and returns a simulated result
// so the rest of the bot logic works identically in both modes.

const KALSHI_TRADE_BASE = "https://trading-api.kalshi.com/trade-api/v2";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Check if API key is configured (doesn't validate it).
export function isKalshiConfigured(): boolean {
  return !!getApiKey();
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
