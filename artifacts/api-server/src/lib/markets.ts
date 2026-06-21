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
// Verified by probing /trade-api/v2/markets for non-provisional open markets.
const KALSHI_SERIES = [
  // ── Crypto ──────────────────────────────────────────────────
  "KXBTC",           // Bitcoin price levels
  "KXETH",           // Ethereum price levels
  "KXBTCMAX100",     // Will Bitcoin hit $100k? (milestone)

  // ── Financials / Macro ───────────────────────────────────────
  "KXINX",           // S&P 500 / stock indices
  "KXFED",           // Federal Reserve rate decisions
  "KXCPI",           // Consumer Price Index / inflation
  "KXGDP",           // GDP growth
  "KXU3",            // US unemployment rate (U-3)
  "KXRECSSNBER",     // NBER recession call

  // ── Sports ──────────────────────────────────────────────────
  "KXNBA",           // NBA basketball season / playoffs
  "KXMLB",           // MLB baseball (regular season & playoffs)
  "KXNFLMVP",        // NFL Most Valuable Player award
  "KXNFLCOTY",       // NFL Coach of the Year award
  "KXNFLRETIRE",     // NFL player retirement predictions
  "KXNBARETIRE",     // NBA player retirement predictions
  "KXWCGAME",        // FIFA World Cup game results
  "KXWCTOTAL",       // FIFA World Cup totals (goals, corners…)

  // ── Elections / Politics ─────────────────────────────────────
  "KXMIDTERMVOTETURN", // 2026 midterm election voter turnout
  "KXMIDTERMMOV",      // 2026 midterm election margin of victory
];

interface KalshiEvent {
  series_ticker?: string;
}

interface DiscoveredSeriesCache {
  series: string[];
  fetchedAt: number;
}

/** 24-hour TTL for the auto-discovered series list — checked once per day. */
const SERIES_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

let discoveredSeriesCache: DiscoveredSeriesCache | null = null;

/**
 * Page through /events?status=open and extract every unique series_ticker.
 * Only series not already in the hardcoded KALSHI_SERIES are returned —
 * those are then probed in fetchAllKalshiSeries() before being used.
 *
 * Result is cached for 24 hours so discovery only runs once per day.
 */
async function discoverKalshiSeries(): Promise<string[]> {
  if (
    discoveredSeriesCache &&
    Date.now() - discoveredSeriesCache.fetchedAt < SERIES_DISCOVERY_TTL_MS
  ) {
    return discoveredSeriesCache.series;
  }

  const knownSeries = new Set(KALSHI_SERIES);
  const found = new Set<string>();
  let cursor: string | undefined;

  try {
    do {
      const params = new URLSearchParams({ limit: "200", status: "open" });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`${KALSHI_BASE}/events?${params}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) break;

      const data = (await res.json()) as {
        events?: KalshiEvent[];
        cursor?: string;
      };
      const events = data.events ?? [];

      for (const event of events) {
        if (event.series_ticker && !knownSeries.has(event.series_ticker)) {
          found.add(event.series_ticker);
        }
      }

      // The API returns an empty cursor or omits it when done
      cursor = events.length > 0 ? data.cursor : undefined;
    } while (cursor);
  } catch {
    // Network error or timeout — return whatever was accumulated
  }

  // Probe each candidate: only keep series that have ≥1 real non-provisional market
  const candidates = [...found];
  const probeResults = await Promise.allSettled(
    candidates.map(async (ticker) => {
      const markets = await fetchKalshiSeries(ticker);
      return markets.length > 0 ? ticker : null;
    }),
  );

  const confirmed = probeResults
    .filter(
      (r): r is PromiseFulfilledResult<string> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value);

  discoveredSeriesCache = { series: confirmed, fetchedAt: Date.now() };
  return confirmed;
}

interface KalshiMarket {
  ticker: string;
  title?: string;
  yes_ask_dollars?: string;
  yes_bid_dollars?: string;
  last_price_dollars?: string;
  /** Kalshi returns volume as a string decimal under volume_fp, not `volume` */
  volume_fp?: string;
  volume_24h_fp?: string;
  close_time?: string;
  /** Not present on market objects — derived from series ticker below */
  category?: string;
  event_ticker?: string;
  series_ticker?: string;
  is_provisional?: boolean;
}

/** Derive a human-readable category from the Kalshi series ticker prefix. */
function kalshiCategory(ticker: string, seriesTicker: string): string | null {
  const s = seriesTicker.toUpperCase();
  if (s.startsWith("KXBTC") || s.startsWith("KXETH") || s.startsWith("KXXRP") || s.startsWith("KXAVAX") || s.startsWith("KXNEAR")) return "Crypto";
  if (s.startsWith("KXINX") || s.startsWith("KXFED") || s.startsWith("KXCPI") || s.startsWith("KXGDP") || s === "KXU3" || s.startsWith("KXRECSSNBER") || s.startsWith("KXSAHM") || s.startsWith("KXRETAIL")) return "Economics";
  if (s.startsWith("KXNBA") || s.startsWith("KXMLB") || s.startsWith("KXNFL") || s.startsWith("KXWCGAME") || s.startsWith("KXWCTOTAL") || s.startsWith("KXWNBA") || s.startsWith("KXPGA") || s.startsWith("KXF1")) return "Sports";
  if (s.startsWith("KXMIDTERM") || s.startsWith("KXHOUSEPARTY") || s.startsWith("KXSENATE")) return "Elections";
  if (s.startsWith("KXOSCARS") || s.startsWith("KXEMMY") || s.startsWith("KXGRAMMY") || s.startsWith("KXVMA")) return "Entertainment";
  // Fall back to category on the ticker itself (usually absent) or null
  return null;
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

        // Kalshi returns volume as a string float under volume_fp, not `volume`
        const volumeRaw = m.volume_fp ?? m.volume_24h_fp;
        const volume = volumeRaw != null ? parseFloat(volumeRaw) : null;

        return {
          id: m.ticker,
          platform: "kalshi" as const,
          title: m.title ?? m.ticker,
          yesOdds,
          noOdds: Math.min(Math.max(1 - yesOdds, 0.01), 0.99),
          volume: volume != null && Number.isFinite(volume) ? volume : null,
          closeTime: m.close_time ?? null,
          url: `https://kalshi.com/markets/${m.ticker}`,
          category: kalshiCategory(m.ticker, m.series_ticker ?? seriesTicker),
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
  // Merge hardcoded seed list with auto-discovered series (cached 24 h).
  // discoverKalshiSeries() pages /events?status=open, probes candidates,
  // and returns only series with live non-provisional markets.
  const discovered = await discoverKalshiSeries();
  const allSeries = [...new Set([...KALSHI_SERIES, ...discovered])];

  const results = await Promise.allSettled(allSeries.map(fetchKalshiSeries));
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
