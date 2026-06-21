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
  /**
   * Human-readable label for what the YES contract pays on. On Kalshi, many
   * markets share one title (e.g. "Senegal vs Iraq Winner?" has separate
   * Senegal / Iraq / Tie contracts), so the title alone is ambiguous — this is
   * the per-contract side (e.g. "Senegal", "Tie") from Kalshi's yes_sub_title.
   * Null for Polymarket, whose questions are already self-contained YES/NO.
   */
  yesSubtitle?: string | null;
  /**
   * Kalshi `event_ticker` (the underlying market, e.g. "KXWCTOTAL-26JUN27COLPOR").
   * Every outcome/threshold of one market shares it — used to block parlaying two
   * outcomes of the same market. Null for Polymarket (no event grouping in feed).
   */
  eventTicker?: string | null;
  /**
   * Stable id for the physical GAME a market belongs to (date + teams, e.g.
   * "26JUN27COLPOR"), shared across a game's different Kalshi series (winner,
   * totals, spread, corners, player props). This is what lets us build Kalshi's
   * native same-game combos. Null for non-game markets (outrights, futures,
   * economic thresholds) and all Polymarket markets.
   */
  gameKey?: string | null;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Map over items with a bounded number of in-flight promises. Firing dozens of
 * upstream requests at once trips Kalshi's rate limiter, which surfaces as
 * timeouts that silently drop whole series (e.g. the World Cup) from the pool.
 * Capping concurrency keeps every series fetch reliable.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
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
  // NBA — game props across all series (winner / spread / total / pts leader)
  "KXNBA",           // NBA game winner
  "KXNBASPREAD",     // NBA point spread
  "KXNBATOTAL",      // NBA game totals (over/under)
  "KXNBAPTS",        // NBA leading scorer (player props)
  // MLB
  "KXMLB",           // MLB baseball (regular season & playoffs)
  // NFL awards / futures
  "KXNFLMVP",        // NFL Most Valuable Player award
  "KXNFLCOTY",       // NFL Coach of the Year award
  "KXNFLRETIRE",     // NFL player retirement predictions
  "KXNBARETIRE",     // NBA player retirement predictions
  // FIFA 2026 World Cup — all game-level prop series for same-game combos
  "KXWCGAME",        // FIFA World Cup game winner
  "KXWCTOTAL",       // FIFA World Cup total goals
  "KXWCSPREAD",      // FIFA World Cup goal spread
  "KXWCBTTS",        // FIFA World Cup both teams to score
  "KXWCCORNERS",     // FIFA World Cup corners market

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

  // Probe each candidate: only keep series that have ≥1 real non-provisional
  // market. Bounded concurrency here matters too — probing dozens of candidates
  // at once is itself what trips the rate limiter and makes the seed series
  // (incl. the World Cup) time out moments later.
  const candidates = [...found];
  const probeResults = await mapWithConcurrency(
    candidates,
    KALSHI_FETCH_CONCURRENCY,
    async (ticker) => {
      const markets = await fetchKalshiSeries(ticker);
      return markets.length > 0 ? ticker : null;
    },
  );

  const confirmed = probeResults.filter((t): t is string => t !== null);

  discoveredSeriesCache = { series: confirmed, fetchedAt: Date.now() };
  return confirmed;
}

interface KalshiMarket {
  ticker: string;
  title?: string;
  /** The side the YES contract pays on, e.g. "Senegal" or "Tie". */
  yes_sub_title?: string;
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

/**
 * Classify a market into a granular, user-facing category from its TITLE.
 * The upstream APIs are unreliable here — Polymarket's Gamma feed returns no
 * category at all and Kalshi only exposes a coarse series prefix — so we infer
 * from the question text, which is descriptive on both platforms. `existing` is
 * any category the API did supply and is used only as a fallback.
 */
export function deriveCategory(title: string, existing: string | null): string {
  const t = title.toLowerCase();

  // ── Sports (specific) ──
  if (/world cup|fifa|premier league|la liga|uefa|champions league|\bmls\b|bundesliga|serie a|ballon d'or|\bsoccer\b/.test(t)) return "Soccer";
  if (/\bnba\b|\bwnba\b|basketball/.test(t)) return "Basketball";
  if (/\bnfl\b|super bowl|quarterback|\btouchdown/.test(t)) return "Football";
  if (/\bmlb\b|baseball|world series/.test(t)) return "Baseball";
  if (/\bnhl\b|hockey|stanley cup/.test(t)) return "Hockey";
  if (/tennis|wimbledon|roland garros|\batp\b|\bwta\b|grand slam/.test(t)) return "Tennis";
  if (/cricket|\bipl\b|test match|\bodi\b|\bt20\b/.test(t)) return "Cricket";
  if (/\bf1\b|formula 1|grand prix|nascar|motogp/.test(t)) return "Motorsport";
  if (/\bgolf\b|\bpga\b|ryder cup|the masters/.test(t)) return "Golf";
  if (/\bufc\b|\bmma\b|boxing|heavyweight|title fight/.test(t)) return "Combat Sports";

  // ── Gaming & esports ──
  if (/esports|league of legends|\bcs2\b|counter-strike|valorant|\bdota\b|overwatch|the international/.test(t)) return "Esports";
  if (/\bgta\b|video game|game award|nintendo|playstation|\bxbox\b|elden ring|call of duty|grand theft auto/.test(t)) return "Gaming";

  // ── Markets / money ──
  if (/bitcoin|\bbtc\b|ethereum|\beth\b|crypto|solana|\bxrp\b|dogecoin|\bnft\b|\bavax\b/.test(t)) return "Crypto";
  if (/\bcpi\b|inflation|interest rate|\bfed\b|\bgdp\b|unemployment|recession|jobs report|treasury|rate cut/.test(t)) return "Economics";
  if (/\bs&p\b|nasdaq|dow jones|stock market|\bipo\b|earnings/.test(t)) return "Stocks";

  // ── Politics ──
  if (/election|president|senate|congress|midterm|parliament|prime minister|governor|democrat|republican|\bgop\b|nominee|impeach|cabinet/.test(t)) return "Politics";

  // ── Tech ──
  if (/\bai\b|openai|chatgpt|\bgpt-|tesla|spacex|\bapple\b|google|nvidia|\bllm\b|gemini|anthropic/.test(t)) return "Tech";

  // ── Entertainment ──
  if (/oscar|grammy|emmy|box office|rotten tomatoes|spotify|billboard|album|taylor swift|movie|netflix/.test(t)) return "Entertainment";

  // ── Weather / climate ──
  if (/temperature|hurricane|\bweather\b|snowfall|rainfall|heat record/.test(t)) return "Weather";

  return existing ?? "Other";
}

/** Derive a human-readable category from the Kalshi series ticker prefix. */
function kalshiCategory(ticker: string, seriesTicker: string): string | null {
  const s = seriesTicker.toUpperCase();
  if (s.startsWith("KXBTC") || s.startsWith("KXETH") || s.startsWith("KXXRP") || s.startsWith("KXAVAX") || s.startsWith("KXNEAR")) return "Crypto";
  if (s.startsWith("KXINX") || s.startsWith("KXFED") || s.startsWith("KXCPI") || s.startsWith("KXGDP") || s === "KXU3" || s.startsWith("KXRECSSNBER") || s.startsWith("KXSAHM") || s.startsWith("KXRETAIL")) return "Economics";
  // Specific sports by series prefix so they don't collapse into a generic
  // "Sports" bucket (which otherwise swallows tennis, soccer, golf, etc.).
  if (s.startsWith("KXNBA") || s.startsWith("KXWNBA")) return "Basketball";
  if (s.startsWith("KXMLB")) return "Baseball";
  if (s.startsWith("KXNFL")) return "Football";
  if (s.startsWith("KXNHL")) return "Hockey";
  if (s.startsWith("KXWC") || s.startsWith("KXEPL") || s.startsWith("KXUCL") || s.startsWith("KXMLS") || s.startsWith("KXLALIGA")) return "Soccer";
  if (s.startsWith("KXPGA") || s.startsWith("KXGOLF") || s.startsWith("KXMASTERS")) return "Golf";
  if (s.startsWith("KXF1") || s.startsWith("KXNASCAR") || s.startsWith("KXMOTOGP")) return "Motorsport";
  if (s.startsWith("KXATP") || s.startsWith("KXWTA") || s.startsWith("KXTENNIS") || s.startsWith("KXWIMBLEDON") || s.startsWith("KXUSOPEN") || s.startsWith("KXAUSOPEN") || s.startsWith("KXFRENCHOPEN") || s.startsWith("KXROLANDGARROS")) return "Tennis";
  if (s.startsWith("KXUFC") || s.startsWith("KXMMA") || s.startsWith("KXBOXING")) return "Combat Sports";
  if (s.startsWith("KXCRICKET") || s.startsWith("KXIPL") || s.startsWith("KXT20")) return "Cricket";
  if (s.startsWith("KXMIDTERM") || s.startsWith("KXHOUSEPARTY") || s.startsWith("KXSENATE")) return "Elections";
  if (s.startsWith("KXOSCARS") || s.startsWith("KXEMMY") || s.startsWith("KXGRAMMY") || s.startsWith("KXVMA")) return "Entertainment";
  // Fall back to category on the ticker itself (usually absent) or null
  return null;
}

/**
 * Derive the physical-game id from a Kalshi event ticker by stripping the
 * series prefix. Only dated game tickers (e.g. series "KXWCTOTAL", event
 * "KXWCTOTAL-26JUN27COLPOR" → "26JUN27COLPOR") qualify; outrights, futures and
 * awards have no date-coded suffix and return null so they're never treated as
 * a comboable game leg.
 */
function kalshiGameKey(
  eventTicker: string | undefined,
  seriesTicker: string | undefined,
): string | null {
  if (!eventTicker || !seriesTicker) return null;
  const prefix = `${seriesTicker}-`;
  if (!eventTicker.startsWith(prefix)) return null;
  const suffix = eventTicker.slice(prefix.length);
  return /^\d{2}[A-Z]{3}\d{2}/.test(suffix) ? suffix : null;
}

async function fetchKalshiSeries(
  seriesTicker: string,
  attempt = 0,
): Promise<Market[]> {
  const MAX_ATTEMPTS = 3;
  try {
    const params = new URLSearchParams({ limit: "100", status: "open", series_ticker: seriesTicker });
    const url = `${KALSHI_BASE}/markets?${params}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      // Retry rate-limits (429) and transient server errors with backoff so a
      // momentary throttle doesn't drop the whole series from the pool.
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
        await sleep(300 * 2 ** attempt);
        return fetchKalshiSeries(seriesTicker, attempt + 1);
      }
      return [];
    }
    const data = await res.json() as { markets?: KalshiMarket[] };
    const markets = data.markets ?? [];

    return markets
      .filter((m) => !m.is_provisional)
      .map((m) => {
        const askDollars = parseFloat(m.yes_ask_dollars ?? "0");
        const bidDollars = parseFloat(m.yes_bid_dollars ?? "0");
        const lastDollars = parseFloat(m.last_price_dollars ?? "0");

        // Use last trade price if available; otherwise midpoint of ask/bid; else ask alone.
        // If NONE of these yield a real price, the market has no live odds — we
        // exclude it rather than fabricating a 50/50 price.
        let yesOdds: number | null;
        if (lastDollars > 0 && lastDollars < 1) {
          yesOdds = lastDollars;
        } else if (askDollars > 0 && bidDollars > 0) {
          yesOdds = (askDollars + bidDollars) / 2;
        } else if (askDollars > 0 && askDollars < 1) {
          yesOdds = askDollars;
        } else {
          yesOdds = null;
        }

        if (yesOdds === null) return null;
        yesOdds = Math.min(Math.max(yesOdds, 0.01), 0.99);

        // Kalshi returns volume as a string float under volume_fp, not `volume`
        const volumeRaw = m.volume_fp ?? m.volume_24h_fp;
        const volume = volumeRaw != null ? parseFloat(volumeRaw) : null;

        return {
          id: m.ticker,
          platform: "kalshi" as const,
          title: m.title ?? m.ticker,
          yesSubtitle: m.yes_sub_title?.trim() || null,
          yesOdds,
          noOdds: Math.min(Math.max(1 - yesOdds, 0.01), 0.99),
          volume: volume != null && Number.isFinite(volume) ? volume : null,
          closeTime: m.close_time ?? null,
          url: `https://kalshi.com/markets/${m.ticker}`,
          category: deriveCategory(
            m.title ?? m.ticker,
            kalshiCategory(m.ticker, m.series_ticker ?? seriesTicker),
          ),
          eventTicker: m.event_ticker ?? null,
          gameKey: kalshiGameKey(m.event_ticker, m.series_ticker ?? seriesTicker),
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
  } catch {
    // Network error or timeout (AbortError) — retry with backoff before giving
    // up, so a single slow response doesn't silently drop the series.
    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(300 * 2 ** attempt);
      return fetchKalshiSeries(seriesTicker, attempt + 1);
    }
    return [];
  }
}

async function fetchKalshiMarkets(): Promise<Market[]> {
  return fetchAllKalshiSeries();
}

// Cap simultaneous Kalshi requests — see mapWithConcurrency.
const KALSHI_FETCH_CONCURRENCY = 6;

async function fetchAllKalshiSeries(): Promise<Market[]> {
  // Merge hardcoded seed list with auto-discovered series (cached 24 h).
  // discoverKalshiSeries() pages /events?status=open, probes candidates,
  // and returns only series with live non-provisional markets.
  const discovered = await discoverKalshiSeries();
  const allSeries = [...new Set([...KALSHI_SERIES, ...discovered])];

  const results = await mapWithConcurrency(
    allSeries,
    KALSHI_FETCH_CONCURRENCY,
    fetchKalshiSeries,
  );
  const all: Market[] = [];
  for (const r of results) all.push(...r);
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
  /** Numeric Gamma market ID (e.g. "540817") — always present */
  id?: string;
  /**
   * Hex condition ID (e.g. "0x1fad72…").
   * The Gamma API returns this as `conditionId` (camelCase).
   * Typed under both names so the runtime value is captured whichever
   * serialisation the proxy happens to use.
   */
  conditionId?: string;
  condition_id?: string;
  /** JSON-encoded array of CLOB token IDs; index 0 = YES, index 1 = NO */
  clobTokenIds?: string;
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

/**
 * Maps any Polymarket market ID (numeric Gamma ID or hex conditionId) → CLOB YES token ID.
 * Populated eagerly during fetchPolymarketMarkets() so history lookups require no extra
 * round-trips to the Gamma API.
 */
const polymarketClobTokenCache = new Map<string, string>();

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

      // Use lastTradePrice as primary; midpoint of bestBid/bestAsk as secondary;
      // outcomePrices as fallback. If none yield a real price the market has no
      // live odds — exclude it rather than fabricating a 50/50 price.
      let yesOddsRaw: number | null;
      if (Number.isFinite(lastTrade) && lastTrade > 0 && lastTrade < 1) {
        yesOddsRaw = lastTrade;
      } else if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        yesOddsRaw = (bid + ask) / 2;
      } else if (outcomePricesYes != null && outcomePricesYes > 0) {
        yesOddsRaw = outcomePricesYes;
      } else {
        yesOddsRaw = null;
      }

      if (yesOddsRaw === null) return null;
      const yesOdds = Math.min(Math.max(yesOddsRaw, 0.01), 0.99);

      // The Gamma API returns the condition ID as `conditionId` (camelCase).
      // The interface also maps `condition_id` for any snake_case proxies.
      // Fall back to the numeric `id` only when neither is available.
      const id = m.conditionId ?? m.condition_id ?? m.id ?? String(Math.random());

      // Pre-populate the CLOB token cache while we have the data in hand.
      // clobTokenIds is a JSON string like '["<yesToken>","<noToken>"]'.
      if (m.clobTokenIds) {
        try {
          const tokens: string[] = JSON.parse(m.clobTokenIds);
          const yesToken = tokens[0];
          if (yesToken) {
            // Register under every known alias so history resolution always hits.
            polymarketClobTokenCache.set(id, yesToken);
            if (m.id && m.id !== id) polymarketClobTokenCache.set(m.id, yesToken);
            if (m.conditionId && m.conditionId !== id) polymarketClobTokenCache.set(m.conditionId, yesToken);
          }
        } catch {
          // ignore malformed clobTokenIds
        }
      }

      return {
        id,
        platform: "polymarket" as const,
        title: m.question ?? id,
        yesOdds,
        noOdds: Math.min(Math.max(1 - yesOdds, 0.01), 0.99),
        volume: m.volume != null ? Number(m.volume) : null,
        closeTime: m.endDateIso ?? m.end_date_iso ?? null,
        url: `https://polymarket.com/event/${id}`,
        category: deriveCategory(m.question ?? id, m.category ?? null),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
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

/**
 * Returns the complete cached market pool (both platforms) — no slicing.
 * Used internally by the smart-picks generator which needs the full pool.
 */
export async function fetchAllMarkets(): Promise<Market[]> {
  const cacheKey = "all";
  const cached = cache.get(cacheKey);
  if (cached && isFresh(cached)) return cached.data;

  const [kalshiResult, polyResult] = await Promise.allSettled([
    fetchKalshiMarkets(),
    fetchPolymarketMarkets(),
  ]);

  const kalshi = kalshiResult.status === "fulfilled" ? kalshiResult.value : [];
  const poly = polyResult.status === "fulfilled" ? polyResult.value : [];
  const all = [...kalshi, ...poly].sort((a, b) => {
    const aVol = a.volume ?? -1;
    const bVol = b.volume ?? -1;
    if (aVol !== bVol) return bVol - aVol;
    const aUncertainty = 1 - Math.abs(a.yesOdds - 0.5) * 2;
    const bUncertainty = 1 - Math.abs(b.yesOdds - 0.5) * 2;
    return bUncertainty - aUncertainty;
  });

  cache.set(cacheKey, { data: all, fetchedAt: Date.now() });
  return all;
}

/**
 * Returns the categories present in the live, genuinely-priced market pool along
 * with how many markets each has and their total traded volume — used to
 * populate the Smart Picks category filter (searchable list + trending chips).
 * Only categories with at least 2 markets are returned, since a combo needs at
 * least two legs. Sorted by total volume (hottest first).
 */
export async function listCategories(): Promise<
  Array<{ name: string; count: number; volume: number }>
> {
  const all = await fetchAllMarkets();
  const stats = new Map<string, { count: number; volume: number }>();
  for (const m of all) {
    if (m.yesOdds <= 0.02 || m.yesOdds >= 0.98 || (m.volume ?? 0) <= 0) continue;
    const name = m.category ?? "Other";
    const entry = stats.get(name) ?? { count: 0, volume: 0 };
    entry.count += 1;
    entry.volume += m.volume ?? 0;
    stats.set(name, entry);
  }
  // Only categories with at least 2 markets (a combo needs ≥2 legs). Sorted by
  // total traded volume so the frontend can surface the hottest categories first.
  return [...stats.entries()]
    .filter(([, s]) => s.count >= 2)
    .map(([name, s]) => ({ name, count: s.count, volume: Math.round(s.volume) }))
    .sort((a, b) => b.volume - a.volume);
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

// ─── History ─────────────────────────────────────────────────────────────────

export interface HistoryPoint {
  timestamp: string;
  yesOdds: number;
}

interface HistoryCacheEntry {
  data: HistoryPoint[];
  fetchedAt: number;
}

const historyCache = new Map<string, HistoryCacheEntry>();
const HISTORY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function isHistoryFresh(entry: HistoryCacheEntry): boolean {
  return Date.now() - entry.fetchedAt < HISTORY_CACHE_TTL_MS;
}

interface KalshiHistoryCandle {
  end_period_ts?: number;
  yes_price_dollars?: string;
  yes_ask_dollars?: string;
}

async function fetchKalshiHistory(marketId: string): Promise<HistoryPoint[]> {
  try {
    // 7 days of hourly candles
    const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const params = new URLSearchParams({
      min_ts: String(sevenDaysAgo),
      period_interval: "60", // 1-hour candles
    });
    const url = `${KALSHI_BASE}/markets/${encodeURIComponent(marketId)}/history?${params}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { history?: KalshiHistoryCandle[] };
    const history = data.history ?? [];

    return history
      .filter((c) => c.end_period_ts != null)
      .map((c) => {
        const priceDollars = parseFloat(c.yes_price_dollars ?? c.yes_ask_dollars ?? "0");
        const yesOdds = Math.min(Math.max(priceDollars > 0 ? priceDollars : 0.5, 0.01), 0.99);
        return {
          timestamp: new Date((c.end_period_ts as number) * 1000).toISOString(),
          yesOdds,
        };
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

interface PolymarketPricePoint {
  t?: number;
  p?: number;
}

/**
 * Resolves the Polymarket CLOB YES token ID for a given market ID.
 *
 * Resolution order:
 *  1. In-process cache populated during fetchPolymarketMarkets() — no extra HTTP call needed.
 *  2. Gamma API detail endpoint by numeric ID (e.g. "540817").
 *  3. Gamma API search by conditionId query param for hex IDs (e.g. "0x1fad72…").
 */
async function resolvePolymarketClobTokenId(marketId: string): Promise<string | null> {
  // 1. Fast path: cache hit (populated eagerly when markets list was fetched)
  const cached = polymarketClobTokenCache.get(marketId);
  if (cached) return cached;

  try {
    let clobTokenIdsJson: string | undefined;

    // 2. Numeric Gamma ID — direct detail endpoint
    if (/^\d+$/.test(marketId)) {
      const res = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = await res.json() as { clobTokenIds?: string };
        clobTokenIdsJson = data.clobTokenIds;
      }
    } else {
      // 3. Hex conditionId — search via query param
      const params = new URLSearchParams({ conditionId: marketId, limit: "1" });
      const res = await fetch(`https://gamma-api.polymarket.com/markets?${params}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = await res.json() as Array<{ clobTokenIds?: string }>;
        clobTokenIdsJson = Array.isArray(data) ? data[0]?.clobTokenIds : undefined;
      }
    }

    if (!clobTokenIdsJson) return null;
    const tokens: string[] = JSON.parse(clobTokenIdsJson);
    const yesToken = tokens[0] ?? null;
    if (yesToken) polymarketClobTokenCache.set(marketId, yesToken);
    return yesToken;
  } catch {
    return null;
  }
}

async function fetchPolymarketHistory(marketId: string): Promise<HistoryPoint[]> {
  try {
    // The CLOB prices-history endpoint requires a CLOB token ID (not the market/condition ID).
    // resolvePolymarketClobTokenId handles all ID formats with a pre-populated cache.
    const tokenId = await resolvePolymarketClobTokenId(marketId);
    if (!tokenId) return [];

    const params = new URLSearchParams({
      market: tokenId,
      interval: "1w",
      fidelity: "60", // hourly resolution
    });
    const url = `https://clob.polymarket.com/prices-history?${params}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { history?: PolymarketPricePoint[] };
    const history = data.history ?? [];

    return history
      .filter((p) => p.t != null && p.p != null)
      .map((p) => ({
        timestamp: new Date((p.t as number) * 1000).toISOString(),
        yesOdds: Math.min(Math.max(p.p as number, 0.01), 0.99),
      }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

export async function fetchMarketHistory(
  platform: "kalshi" | "polymarket",
  marketId: string,
): Promise<HistoryPoint[]> {
  const cacheKey = `${platform}:${marketId}`;
  const cached = historyCache.get(cacheKey);
  if (cached && isHistoryFresh(cached)) {
    return cached.data;
  }

  const points =
    platform === "kalshi"
      ? await fetchKalshiHistory(marketId)
      : await fetchPolymarketHistory(marketId);

  historyCache.set(cacheKey, { data: points, fetchedAt: Date.now() });
  return points;
}
