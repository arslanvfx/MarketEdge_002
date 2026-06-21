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
}

async function fetchKalshiMarkets(q?: string, limit = 100): Promise<Market[]> {
  try {
    const params = new URLSearchParams({ limit: String(Math.min(limit, 200)), status: "open" });
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

async function fetchPolymarketMarkets(q?: string, limit = 100): Promise<Market[]> {
  try {
    const params = new URLSearchParams({
      limit: String(Math.min(limit, 200)),
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

    return data.map((m) => {
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
}): Promise<{ markets: Market[]; total: number; hasMore: boolean; apiUnavailable?: boolean }> {
  const platform = opts.platform ?? "all";
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;
  const q = opts.q;

  const cacheKey = `${platform}:${q ?? ""}`;
  const cached = cache.get(cacheKey);
  let all: Market[];
  let apiUnavailable = false;

  if (cached && isFresh(cached)) {
    all = cached.data;
  } else {
    const [kalshiResult, polyResult] = await Promise.allSettled([
      platform === "all" || platform === "kalshi" ? fetchKalshiMarkets(q, 200) : Promise.resolve([]),
      platform === "all" || platform === "polymarket" ? fetchPolymarketMarkets(q, 200) : Promise.resolve([]),
    ]);

    const kalshi = kalshiResult.status === "fulfilled" ? kalshiResult.value : [];
    const poly = polyResult.status === "fulfilled" ? polyResult.value : [];
    all = [...kalshi, ...poly];

    if (all.length === 0) {
      apiUnavailable = true;
    }

    cache.set(cacheKey, { data: all, fetchedAt: Date.now() });
  }

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
  return { markets, total, hasMore: offset + limit < total, ...(apiUnavailable ? { apiUnavailable: true } : {}) };
}

export async function fetchMarketsForLegs(
  legs: Array<{ platform: string; marketId: string }>,
): Promise<{ markets: Market[] }> {
  const needsKalshi = legs.some((l) => l.platform === "kalshi");
  const needsPoly = legs.some((l) => l.platform === "polymarket");

  const [kalshiResult, polyResult] = await Promise.allSettled([
    needsKalshi ? fetchKalshiMarkets(undefined, 200) : Promise.resolve([]),
    needsPoly ? fetchPolymarketMarkets(undefined, 200) : Promise.resolve([]),
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
