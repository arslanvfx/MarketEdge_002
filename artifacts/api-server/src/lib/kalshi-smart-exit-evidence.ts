/**
 * A deliberately independent Coinbase REST evidence feed for Smart Exit.
 *
 * This module does not use crypto-data.ts (or any of its caches): an exit
 * decision must be auditable as a fresh ticker, tape, and L2 observation.
 * Coinbase's `side` in the public trades response is the *maker* order side.
 * We therefore normalize it to taker/aggressor flow: maker "sell" is an
 * aggressive buy, and maker "buy" is an aggressive sell.
 */
import type { SmartExitEvidence } from "./kalshi-smart-exit-types.ts";
import { isPythProduct } from "./market-defs.ts";

const COINBASE_REST = "https://api.exchange.coinbase.com";

export interface SmartExitEvidenceFetchResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type SmartExitEvidenceFetch = (
  url: string,
  init?: { readonly headers?: Readonly<Record<string, string>> },
) => Promise<SmartExitEvidenceFetchResponse>;

export interface SmartExitEvidenceCollectorOptions {
  /** Injectable clock, returning Unix milliseconds. */
  readonly now?: () => number;
  readonly fetch?: SmartExitEvidenceFetch;
  readonly maxPriceSamples?: number;
  readonly maxTradeSamples?: number;
  readonly priceHistorySeconds?: number;
  readonly tradeHistorySeconds?: number;
  readonly momentumWindowSeconds?: number;
  readonly bookLevels?: number;
  readonly tradeLimit?: number;
}

export interface SmartExitEvidenceCollectorHealth {
  readonly symbols: number;
  readonly priceSamples: number;
  readonly tradeSamples: number;
  readonly latestBySymbol: Readonly<Record<string, {
    readonly source: SmartExitEvidence["source"];
    readonly observedAtSeconds: number;
    readonly ready: boolean;
  }>>;
}

type PriceSample = { at: number; price: number };
type TradeSample = { id: string; at: number; price: number; size: number; aggressor: "buy" | "sell" };
type State = {
  prices: PriceSample[];
  trades: TradeSample[];
  seenTradeIds: Set<string>;
  latest: SmartExitEvidence | null;
};

const number = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const timestampSeconds = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1_000 : null;
};
const bounded = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const marketProbability = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

function emptyEvidence(
  source: SmartExitEvidence["source"],
  observedAtSeconds: number,
  marketWinProbability: number | null,
): SmartExitEvidence {
  return {
    source, observedAtSeconds, spotObservedAtSeconds: null, tapeObservedAtSeconds: null,
    bookObservedAtSeconds: null, underlyingPrice: null,
    volatilityLogReturnPerSqrtSecond: null, momentumLogReturn: null,
    momentumWindowSeconds: null, tradeFlowImbalance: null, bookImbalance: null,
    marketWinProbability,
  };
}

/** Stateless scheduling is intentional: callers decide when collection occurs. */
export class KalshiSmartExitEvidenceCollector {
  private readonly now: () => number;
  private readonly fetcher: SmartExitEvidenceFetch;
  private readonly maxPriceSamples: number;
  private readonly maxTradeSamples: number;
  private readonly priceHistorySeconds: number;
  private readonly tradeHistorySeconds: number;
  private readonly momentumWindowSeconds: number;
  private readonly bookLevels: number;
  private readonly tradeLimit: number;
  private readonly states = new Map<string, State>();

  constructor(options: SmartExitEvidenceCollectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init) as Promise<SmartExitEvidenceFetchResponse>);
    this.maxPriceSamples = Math.max(2, Math.floor(options.maxPriceSamples ?? 300));
    this.maxTradeSamples = Math.max(1, Math.floor(options.maxTradeSamples ?? 1_000));
    this.priceHistorySeconds = Math.max(1, options.priceHistorySeconds ?? 300);
    this.tradeHistorySeconds = Math.max(1, options.tradeHistorySeconds ?? 60);
    this.momentumWindowSeconds = Math.max(1, options.momentumWindowSeconds ?? 15);
    this.bookLevels = Math.max(1, Math.floor(options.bookLevels ?? 10));
    this.tradeLimit = Math.max(1, Math.floor(options.tradeLimit ?? 100));
  }

  private state(symbol: string): State {
    let state = this.states.get(symbol);
    if (!state) {
      state = { prices: [], trades: [], seenTradeIds: new Set(), latest: null };
      this.states.set(symbol, state);
    }
    return state;
  }

  private async json(url: string): Promise<unknown | null> {
    try {
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json", "User-Agent": "MarketEdge/1.0 (smart-exit)" },
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch one independent, bounded evidence sample. A bad subfeed affects only
   * fields derived from that subfeed; no cached quote or neutral value is used.
   */
  async collect(symbol: string, product: string, marketWinProbability: number | null): Promise<SmartExitEvidence> {
    const observedAtSeconds = this.now() / 1_000;
    const currentMarketProbability = marketProbability(marketWinProbability);
    if (isPythProduct(product)) {
      const evidence = emptyEvidence("unsupported", observedAtSeconds, currentMarketProbability);
      this.state(symbol).latest = evidence;
      return evidence;
    }

    const encoded = encodeURIComponent(product);
    const [tickerRaw, tradesRaw, bookRaw] = await Promise.all([
      this.json(`${COINBASE_REST}/products/${encoded}/ticker`),
      this.json(`${COINBASE_REST}/products/${encoded}/trades?limit=${this.tradeLimit}`),
      this.json(`${COINBASE_REST}/products/${encoded}/book?level=2`),
    ]);
    const state = this.state(symbol);
    const ticker = this.ticker(tickerRaw);
    const previous = state.latest;
    const tickerIsMonotonic = ticker?.at != null
      && (previous?.spotObservedAtSeconds == null || ticker.at >= previous.spotObservedAtSeconds);
    if (ticker && tickerIsMonotonic) {
      state.prices.push({ at: ticker.at!, price: ticker.price });
      this.prunePrices(state, observedAtSeconds);
    }
    const tapeObservedAtSeconds = this.addTrades(state, tradesRaw, observedAtSeconds);
    this.pruneTrades(state, observedAtSeconds);
    const tapePrices = state.trades
      .map((trade) => ({ at: trade.at, price: trade.price }))
      .sort((a, b) => a.at - b.at);
    const calculationPrices = ticker && tickerIsMonotonic
      ? [...tapePrices, { at: ticker.at!, price: ticker.price }].sort((a, b) => a.at - b.at)
      : tapePrices;
    const bookValid = this.bookIsValid(bookRaw);
    const evidence: SmartExitEvidence = {
      ...emptyEvidence("coinbase-rest", observedAtSeconds, currentMarketProbability),
      spotObservedAtSeconds: tickerIsMonotonic ? ticker!.at : null,
      tapeObservedAtSeconds,
      // Coinbase's REST L2 response has no exchange timestamp. Receipt time is
      // explicit and may be used only for this component.
      bookObservedAtSeconds: bookValid ? observedAtSeconds : null,
      underlyingPrice: tickerIsMonotonic ? ticker!.price : null,
      volatilityLogReturnPerSqrtSecond: tickerIsMonotonic ? this.volatility(calculationPrices) : null,
      momentumLogReturn: tickerIsMonotonic ? this.momentum(calculationPrices, observedAtSeconds) : null,
      momentumWindowSeconds: tickerIsMonotonic && this.momentum(calculationPrices, observedAtSeconds) !== null
        ? this.momentumWindowSeconds : null,
      tradeFlowImbalance: tapeObservedAtSeconds != null ? this.tradeFlow(state.trades) : null,
      bookImbalance: this.bookImbalance(bookRaw),
    };
    state.latest = evidence;
    return evidence;
  }

  latest(symbol: string): SmartExitEvidence | null {
    return this.states.get(symbol)?.latest ?? null;
  }

  health(): SmartExitEvidenceCollectorHealth {
    let priceSamples = 0;
    let tradeSamples = 0;
    const latestBySymbol: Record<string, { source: SmartExitEvidence["source"]; observedAtSeconds: number; ready: boolean }> = {};
    for (const [symbol, state] of this.states) {
      priceSamples += state.prices.length;
      tradeSamples += state.trades.length;
      if (state.latest) {
        latestBySymbol[symbol] = {
          source: state.latest.source, observedAtSeconds: state.latest.observedAtSeconds,
          ready: state.latest.underlyingPrice !== null && state.latest.volatilityLogReturnPerSqrtSecond !== null &&
            state.latest.momentumLogReturn !== null && state.latest.tradeFlowImbalance !== null && state.latest.bookImbalance !== null,
        };
      }
    }
    return { symbols: this.states.size, priceSamples, tradeSamples, latestBySymbol };
  }

  clear(symbol?: string): void {
    if (symbol === undefined) this.states.clear();
    else this.states.delete(symbol);
  }

  /** Alias for lifecycle callers; this collector owns no timer to stop. */
  stop(): void {
    this.clear();
  }

  private ticker(raw: unknown): { price: number; at: number | null } | null {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const price = number(value.price);
    return price !== null && price > 0 ? { price, at: timestampSeconds(value.time) } : null;
  }

  private addTrades(state: State, raw: unknown, receiptAt: number): number | null {
    if (!Array.isArray(raw)) return null;
    let newestValidAt: number | null = null;
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const trade = item as Record<string, unknown>;
      const id = typeof trade.trade_id === "string" || typeof trade.trade_id === "number" ? String(trade.trade_id) : null;
      const price = number(trade.price);
      const size = number(trade.size);
      const makerSide = trade.side;
      // Coinbase public `side` identifies the resting/maker order.
      const aggressor = makerSide === "sell" ? "buy" : makerSide === "buy" ? "sell" : null;
      if (!id || price === null || price <= 0 || size === null || size <= 0 || !aggressor) continue;
      const at = timestampSeconds(trade.time);
      if (at == null) continue;
      if (at < receiptAt - this.tradeHistorySeconds || at > receiptAt + 1) continue;
      newestValidAt = newestValidAt == null ? at : Math.max(newestValidAt, at);
      if (state.seenTradeIds.has(id)) continue;
      state.trades.push({ id, at, price, size, aggressor });
      state.seenTradeIds.add(id);
    }
    const previousAt = state.latest?.tapeObservedAtSeconds;
    return newestValidAt != null && (previousAt == null || newestValidAt >= previousAt)
      ? newestValidAt
      : null;
  }

  private bookIsValid(raw: unknown): boolean {
    return !!raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).bids) &&
      Array.isArray((raw as Record<string, unknown>).asks);
  }

  private prunePrices(state: State, now: number): void {
    state.prices = state.prices
      .filter((sample) => sample.at >= now - this.priceHistorySeconds)
      .sort((a, b) => a.at - b.at)
      .slice(-this.maxPriceSamples);
  }

  private pruneTrades(state: State, now: number): void {
    state.trades = state.trades.filter((trade) => trade.at >= now - this.tradeHistorySeconds).slice(-this.maxTradeSamples);
    state.seenTradeIds = new Set(state.trades.map((trade) => trade.id));
  }

  private volatility(prices: readonly PriceSample[]): number | null {
    const returns: number[] = [];
    for (let index = 1; index < prices.length; index += 1) {
      const elapsed = prices[index].at - prices[index - 1].at;
      if (elapsed > 0) returns.push(Math.log(prices[index].price / prices[index - 1].price) / Math.sqrt(elapsed));
    }
    if (returns.length < 2) return null;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length);
  }

  private momentum(prices: readonly PriceSample[], now: number): number | null {
    const current = prices.at(-1);
    const target = now - this.momentumWindowSeconds;
    const reference = [...prices].reverse().find((sample) => sample.at <= target);
    return current && reference && current.at > reference.at ? Math.log(current.price / reference.price) : null;
  }

  private tradeFlow(trades: readonly TradeSample[]): number | null {
    let buy = 0;
    let sell = 0;
    for (const trade of trades) {
      if (trade.aggressor === "buy") buy += trade.size;
      else sell += trade.size;
    }
    const total = buy + sell;
    return total > 0 ? bounded((buy - sell) / total, -1, 1) : null;
  }

  private bookImbalance(raw: unknown): number | null {
    if (!this.bookIsValid(raw)) return null;
    const book = raw as { bids: unknown[]; asks: unknown[] };
    const depth = (rows: unknown[]): number | null => {
      let total = 0;
      let valid = 0;
      for (const row of rows.slice(0, this.bookLevels)) {
        if (!Array.isArray(row)) continue;
        const price = number(row[0]);
        const size = number(row[1]);
        if (price === null || price <= 0 || size === null || size <= 0) continue;
        total += size;
        valid += 1;
      }
      return valid > 0 ? total : null;
    };
    const bids = depth(book.bids);
    const asks = depth(book.asks);
    return bids !== null && asks !== null && bids + asks > 0 ? bounded((bids - asks) / (bids + asks), -1, 1) : null;
  }
}

/** Short name for callers which do not need the Kalshi-specific prefix. */
export { KalshiSmartExitEvidenceCollector as SmartExitEvidenceCollector };
