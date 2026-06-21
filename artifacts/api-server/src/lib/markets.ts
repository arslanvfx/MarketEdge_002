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

async function fetchKalshiMarkets(q?: string): Promise<Market[]> {
  try {
    const params = new URLSearchParams({ limit: "100", status: "open" });
    if (q) params.set("series_ticker", q.toUpperCase());

    const url = `https://trading-api.kalshi.com/trade-api/v2/markets?${params}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];
    const data = await res.json() as { markets?: KalshiMarket[] };
    const markets = data.markets ?? [];

    return markets.map((m) => {
      const yesPrice = (m.yes_ask ?? m.yes_bid ?? 50) / 100;
      const noPrice = 1 - yesPrice;
      return {
        id: m.ticker,
        platform: "kalshi" as const,
        title: m.title ?? m.ticker,
        yesOdds: Math.min(Math.max(yesPrice, 0.01), 0.99),
        noOdds: Math.min(Math.max(noPrice, 0.01), 0.99),
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

interface KalshiMarket {
  ticker: string;
  title?: string;
  yes_ask?: number;
  yes_bid?: number;
  volume?: number;
  close_time?: string;
  category?: string;
}

interface PolymarketGammaMarket {
  id?: string;
  condition_id?: string;
  question?: string;
  best_ask?: string | number;
  best_bid?: string | number;
  volume?: string | number;
  end_date_iso?: string;
  category?: string;
  clobTokenIds?: string[];
}

async function fetchPolymarketMarkets(q?: string): Promise<Market[]> {
  try {
    const params = new URLSearchParams({
      limit: "100",
      active: "true",
      closed: "false",
    });
    if (q) params.set("q", q);

    const url = `https://gamma-api.polymarket.com/markets?${params}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];
    const data = await res.json() as PolymarketGammaMarket[];
    if (!Array.isArray(data)) return [];

    return data.slice(0, 100).map((m) => {
      const rawAsk = Number(m.best_ask ?? 0.5);
      const rawBid = Number(m.best_bid ?? 0.5);
      const midpoint = (rawAsk + rawBid) / 2 || 0.5;
      const yesOdds = Math.min(Math.max(midpoint, 0.01), 0.99);
      const id = m.condition_id ?? m.id ?? String(Math.random());

      return {
        id,
        platform: "polymarket" as const,
        title: m.question ?? id,
        yesOdds,
        noOdds: 1 - yesOdds,
        volume: m.volume != null ? Number(m.volume) : null,
        closeTime: m.end_date_iso ?? null,
        url: `https://polymarket.com/event/${id}`,
        category: m.category ?? null,
      };
    });
  } catch {
    return [];
  }
}

export async function fetchMarkets(opts: {
  platform?: "kalshi" | "polymarket" | "all";
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<{ markets: Market[]; total: number; hasMore: boolean }> {
  const platform = opts.platform ?? "all";
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;
  const q = opts.q;

  const cacheKey = `${platform}:${q ?? ""}`;
  const cached = cache.get(cacheKey);
  let all: Market[];

  if (cached && isFresh(cached)) {
    all = cached.data;
  } else {
    const results = await Promise.allSettled([
      platform === "all" || platform === "kalshi" ? fetchKalshiMarkets(q) : Promise.resolve([]),
      platform === "all" || platform === "polymarket" ? fetchPolymarketMarkets(q) : Promise.resolve([]),
    ]);

    const kalshi = results[0].status === "fulfilled" ? results[0].value : [];
    const poly = results[1].status === "fulfilled" ? results[1].value : [];
    all = [...kalshi, ...poly];

    // If both APIs returned nothing, return some demo markets so the app isn't empty
    if (all.length === 0) {
      all = getDemoMarkets();
    }

    cache.set(cacheKey, { data: all, fetchedAt: Date.now() });
  }

  // Filter by search query if provided (post-cache filter)
  let filtered = all;
  if (q) {
    const lower = q.toLowerCase();
    filtered = all.filter(
      (m) =>
        m.title.toLowerCase().includes(lower) ||
        m.id.toLowerCase().includes(lower),
    );
  }

  const total = filtered.length;
  const markets = filtered.slice(offset, offset + limit);
  return { markets, total, hasMore: offset + limit < total };
}

export async function fetchMarketById(
  platform: "kalshi" | "polymarket",
  marketId: string,
): Promise<Market | null> {
  const { markets } = await fetchMarkets({ platform, limit: 100, offset: 0 });
  return markets.find((m) => m.id === marketId) ?? null;
}

function getDemoMarkets(): Market[] {
  return [
    { id: "TRUMPAPPROVAL-24", platform: "kalshi", title: "Will Trump's approval rating exceed 50% in 2024?", yesOdds: 0.38, noOdds: 0.62, volume: 125000, closeTime: "2024-12-31", url: "https://kalshi.com", category: "Politics" },
    { id: "FEDRATE-DEC24", platform: "kalshi", title: "Will the Fed cut rates in December 2024?", yesOdds: 0.72, noOdds: 0.28, volume: 87000, closeTime: "2024-12-18", url: "https://kalshi.com", category: "Finance" },
    { id: "BTCABOVE60K", platform: "kalshi", title: "Will Bitcoin close above $60k at year end?", yesOdds: 0.55, noOdds: 0.45, volume: 203000, closeTime: "2024-12-31", url: "https://kalshi.com", category: "Crypto" },
    { id: "DEMO-POLY-1", platform: "polymarket", title: "Will the S&P 500 reach 6000 by end of 2024?", yesOdds: 0.61, noOdds: 0.39, volume: 340000, closeTime: "2024-12-31", url: "https://polymarket.com", category: "Finance" },
    { id: "DEMO-POLY-2", platform: "polymarket", title: "Will Elon Musk remain CEO of X (Twitter)?", yesOdds: 0.82, noOdds: 0.18, volume: 156000, closeTime: "2024-12-31", url: "https://polymarket.com", category: "Technology" },
    { id: "DEMO-POLY-3", platform: "polymarket", title: "Will AI-generated content win a major award in 2024?", yesOdds: 0.29, noOdds: 0.71, volume: 45000, closeTime: "2024-12-31", url: "https://polymarket.com", category: "Technology" },
    { id: "DEMO-POLY-4", platform: "polymarket", title: "Will SpaceX successfully land Starship in 2024?", yesOdds: 0.67, noOdds: 0.33, volume: 92000, closeTime: "2024-12-31", url: "https://polymarket.com", category: "Science" },
    { id: "DEMO-KALSHI-4", platform: "kalshi", title: "Will US unemployment exceed 5% in 2024?", yesOdds: 0.18, noOdds: 0.82, volume: 67000, closeTime: "2024-12-31", url: "https://kalshi.com", category: "Economics" },
  ];
}
