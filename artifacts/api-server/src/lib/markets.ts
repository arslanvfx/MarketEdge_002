export interface Market {
  id: string;
  platform: "kalshi" | "polymarket";
  title: string;
  yesOdds: number;
  noOdds: number;
  volume: number | null;
  closeTime: string | null;
  url: string;
  category: string | null;
}

interface CacheEntry {
  data: Market[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

// ─── Kalshi ────────────────────────────────────────────────────────────────

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// Active series with real, liquid markets as of mid-2026
const KALSHI_SERIES = [
  "KXBTC",    // Bitcoin price
  "KXETH",    // Ethereum price
  "KXINX",    // S&P 500 / stock indices
  "KXFED",    // Federal Reserve rate decisions
  "KXCPI",    // Consumer Price Index / inflation
  "KXGDP",    // GDP growth
  "KXNBA",    // NBA basketball
  "KXWCGAME", // FIFA World Cup games
  "KXWCTOTAL",// FIFA World Cup totals
];

interface KalshiMarket {
  ticker: string;
  title?: string;
  yes_ask_dollars?: string;
  yes_bid_dollars?: string;
  last_price_dollars?: string;
  volume?: number;
  close_time?: string;
  category?: string;
  event_ticker?: string;
  is_provisional?: boolean;
}

async function fetchKalshiSeries(seriesTicker: string): Promise<Market[]> {
  try {
    const params = new URLSearchParams({ limit: "100", status: "open", series_ticker: seriesTicker });
    const url = `${KALSHI_BASE}/markets?${params}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];
    const data = await res.json() as { markets?: KalshiMarket[] };
    const markets = data.markets ?? [];

    return markets
      .filter((m) => !m.is_provisional)
      .map((m) => {
        const askDollars = parseFloat(m.yes_ask_dollars ?? "0");
        const bidDollars = parseFloat(m.yes_bid_dollars ?? "0");
        const lastDollars = parseFloat(m.last_price_dollars ?? "0");

        // Use last trade price if available; otherwise midpoint of ask/bid; else ask alone
        let yesOdds: number;
        if (lastDollars > 0 && lastDollars < 1) {
          yesOdds = lastDollars;
        } else if (askDollars > 0 && bidDollars > 0) {
          yesOdds = (askDollars + bidDollars) / 2;
        } else if (askDollars > 0 && askDollars < 1) {
          yesOdds = askDollars;
        } else {
          yesOdds = 0.5;
        }

        yesOdds = Math.min(Math.max(yesOdds, 0.01), 0.99);

        return {
          id: m.ticker,
          platform: "kalshi" as const,
          title: m.title ?? m.ticker,
          yesOdds,
          noOdds: Math.min(Math.max(1 - yesOdds, 0.01), 0.99),
          volume: m.volume ?? null,
          closeTime: m.close_time ?? null,
          url: `https://kalshi.com/markets/${m.ticker}`,
          category: m.category ?? null,
        };
      });
  } catch {
    return [];
  }
}

async function fetchKalshiMarkets(): Promise<Market[]> {
  return fetchAllKalshiSeries();
}

async function fetchAllKalshiSeries(): Promise<Market[]> {
  const results = await Promise.allSettled(KALSHI_SERIES.map(fetchKalshiSeries));
  const all: Market[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  // Deduplicate by id
  const seen = new Set<string>();
  return all.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

// ─── Polymarket ─────────────────────────────────────────────────────────────

interface PolymarketGammaMarket {
  id?: string;
  condition_id?: string;
  question?: string;
  bestAsk?: number;
  bestBid?: number;
  lastTradePrice?: number;
  outcomePrices?: string;
  volume?: string | number;
  endDateIso?: string;
  end_date_iso?: string;
  category?: string;
}

async function fetchPolymarketMarkets(): Promise<Market[]> {
  try {
    const params = new URLSearchParams({
      limit: "100",
      active: "true",
      closed: "false",
    });

    const url = `https://gamma-api.polymarket.com/markets?${params}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];
    const data = await res.json() as PolymarketGammaMarket[];
    if (!Array.isArray(data)) return [];

    return data.map((m) => {
      // outcomePrices is a JSON string like '["0.52","0.48"]' — index 0 is YES
      let outcomePricesYes: number | null = null;
      if (m.outcomePrices) {
        try {
          const parsed = JSON.parse(m.outcomePrices);
          outcomePricesYes = parsed[0] != null ? parseFloat(parsed[0]) : null;
        } catch {
          // ignore
        }
      }

      // Explicit numeric coercion — API may return strings for these fields
      const lastTrade = Number(m.lastTradePrice);
      const bid = Number(m.bestBid);
      const ask = Number(m.bestAsk);

      // Use lastTradePrice as primary; midpoint of bestBid/bestAsk as secondary; outcomePrices as fallback
      let yesOdds: number;
      if (Number.isFinite(lastTrade) && lastTrade > 0 && lastTrade < 1) {
        yesOdds = lastTrade;
      } else if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        yesOdds = (bid + ask) / 2;
      } else if (outcomePricesYes != null && outcomePricesYes > 0) {
        yesOdds = outcomePricesYes;
      } else {
        yesOdds = 0.5;
      }

      yesOdds = Math.min(Math.max(yesOdds, 0.01), 0.99);
      const id = m.condition_id ?? m.id ?? String(Math.random());

      return {
        id,
        platform: "polymarket" as const,
        title: m.question ?? id,
        yesOdds,
        noOdds: Math.min(Math.max(1 - yesOdds, 0.01), 0.99),
        volume: m.volume != null ? Number(m.volume) : null,
        closeTime: m.endDateIso ?? m.end_date_iso ?? null,
        url: `https://polymarket.com/event/${id}`,
        category: m.category ?? null,
      };
    });
  } catch {
    return [];
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function fetchMarkets(opts: {
  platform?: "kalshi" | "polymarket" | "all";
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<{ markets: Market[]; total: number; hasMore: boolean; apiUnavailable?: boolean }> {
  const platform = opts.platform ?? "all";
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;
  const q = opts.q;

  // Cache raw market snapshots by platform only — never include q in the key.
  // Text filtering is applied in-memory after the cache lookup so repeated
  // searches within the TTL window never trigger extra upstream fetches.
  const cacheKey = platform;
  const cached = cache.get(cacheKey);
  let all: Market[];

  if (cached && isFresh(cached)) {
    all = cached.data;
  } else {
    const [kalshiResult, polyResult] = await Promise.allSettled([
      platform === "all" || platform === "kalshi" ? fetchKalshiMarkets() : Promise.resolve([]),
      platform === "all" || platform === "polymarket" ? fetchPolymarketMarkets() : Promise.resolve([]),
    ]);

    const kalshi = kalshiResult.status === "fulfilled" ? kalshiResult.value : [];
    const poly = polyResult.status === "fulfilled" ? polyResult.value : [];
    // Sort by interest: high volume first, then by closeness to 50% odds
    all = [...kalshi, ...poly].sort((a, b) => {
      const aVol = a.volume ?? -1;
      const bVol = b.volume ?? -1;
      if (aVol !== bVol) return bVol - aVol;
      const aUncertainty = 1 - Math.abs(a.yesOdds - 0.5) * 2;
      const bUncertainty = 1 - Math.abs(b.yesOdds - 0.5) * 2;
      return bUncertainty - aUncertainty;
    });

    cache.set(cacheKey, { data: all, fetchedAt: Date.now() });
  }

  // In-memory text filter — safe to run on every request with no upstream cost
  let filtered = all;
  if (q) {
    const lower = q.toLowerCase();
    filtered = all.filter(
      (m) => m.title.toLowerCase().includes(lower) || m.id.toLowerCase().includes(lower),
    );
  }

  const total = filtered.length;
  const markets = filtered.slice(offset, offset + limit);
  const apiUnavailable = all.length === 0 || undefined;
  return { markets, total, hasMore: offset + limit < total, ...(apiUnavailable ? { apiUnavailable: true } : {}) };
}

export async function fetchMarketsForLegs(
  legs: Array<{ platform: string; marketId: string }>,
): Promise<{ markets: Market[] }> {
  const needsKalshi = legs.some((l) => l.platform === "kalshi");
  const needsPoly = legs.some((l) => l.platform === "polymarket");

  const [kalshiResult, polyResult] = await Promise.allSettled([
    needsKalshi ? fetchAllKalshiSeries() : Promise.resolve([]),
    needsPoly ? fetchPolymarketMarkets() : Promise.resolve([]),
  ]);

  const kalshi = kalshiResult.status === "fulfilled" ? kalshiResult.value : [];
  const poly = polyResult.status === "fulfilled" ? polyResult.value : [];
  const all = [...kalshi, ...poly];

  const requestedIds = new Set(legs.map((l) => `${l.platform}:${l.marketId}`));
  const markets = all.filter((m) => requestedIds.has(`${m.platform}:${m.id}`));

  return { markets };
}

export async function fetchMarketById(
  platform: "kalshi" | "polymarket",
  marketId: string,
): Promise<Market | null> {
  const { markets } = await fetchMarketsForLegs([{ platform, marketId }]);
  return markets[0] ?? null;
}
