// Market-wide dynamic universe. Replaces reliance on the static hand-curated
// STOCK_UNIVERSE list: every 4 hours we pull ALL active tradable US equities
// from Alpaca (GET /v2/assets, ~8–11k symbols), then pre-filter via bulk
// snapshots to a tradeable candidate set:
//   - price $2–$500 (penny stocks and ultra-priced names excluded)
//   - session volume ≥ 200k shares (today's, or previous session pre-open)
//   - bid/ask spread < 1% (when a quote is available)
//
// The filtered list (typically ~1–3k symbols) is cached in memory for 4 hours.
// If the market-wide fetch fails, we fall back to the static universe so the
// scanner never goes dark. Sector labels come from the static universe when
// known, else "Other" — Alpaca's asset endpoint carries no sector metadata.

import { logger } from "../logger";
import { getAssets, getSnapshots, type StockSnapshot } from "./alpaca";
import { STOCK_UNIVERSE, lookupUniverse } from "./universe";
import { getConfig } from "./config";

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const SNAPSHOT_CHUNK = 500;              // symbols per snapshots call (URL length limit)
const MIN_PRICE = 2;
const MAX_PRICE = 500;
const MIN_VOLUME = 200_000;
const MAX_SPREAD_PCT = 1.0;

export interface UniverseCandidate {
  ticker: string;
  name: string;
  sector: string;
  snapshot: StockSnapshot;
}

interface UniverseCache {
  builtAt: number;
  totalAssets: number;
  candidates: UniverseCandidate[];
  source: "market" | "static-fallback";
}

let cache: UniverseCache | null = null;
let building: Promise<UniverseCache> | null = null;

export interface UniverseStatus {
  builtAt: number;
  totalAssets: number;
  candidateCount: number;
  source: "market" | "static-fallback" | "none";
  building: boolean;
}

export function getUniverseStatus(): UniverseStatus {
  return {
    builtAt: cache?.builtAt ?? 0,
    totalAssets: cache?.totalAssets ?? 0,
    candidateCount: cache?.candidates.length ?? 0,
    source: cache?.source ?? "none",
    building: building != null,
  };
}

function passesFilters(s: StockSnapshot): boolean {
  if (s.price < MIN_PRICE || s.price > MAX_PRICE) return false;
  const vol = Math.max(s.volume, s.prevVolume);
  if (vol < MIN_VOLUME) return false;
  // Spread filter only applies when we actually have a two-sided quote —
  // IEX quotes are sparse off-hours, and dropping every symbol without a
  // quote would empty the universe overnight.
  if (s.spreadPct != null && s.spreadPct > MAX_SPREAD_PCT) return false;
  return true;
}

async function buildMarketUniverse(): Promise<UniverseCache> {
  const cfg = getConfig();
  const assets = await getAssets(cfg.mode);
  logger.info({ assets: assets.length }, "[stock-universe] fetched market-wide asset list");

  const byTicker = new Map(assets.map((a) => [a.symbol, a]));
  const symbols = assets.map((a) => a.symbol);
  const candidates: UniverseCandidate[] = [];

  for (let i = 0; i < symbols.length; i += SNAPSHOT_CHUNK) {
    const chunk = symbols.slice(i, i + SNAPSHOT_CHUNK);
    try {
      const snaps = await getSnapshots(chunk);
      for (const [sym, snap] of Object.entries(snaps)) {
        if (!passesFilters(snap)) continue;
        const asset = byTicker.get(sym);
        const uni = lookupUniverse(sym);
        candidates.push({
          ticker: sym,
          name: uni?.name ?? asset?.name ?? sym,
          sector: uni?.sector ?? "Other",
          snapshot: snap,
        });
      }
    } catch (err) {
      logger.warn(
        { err, chunkStart: i, chunkSize: chunk.length },
        "[stock-universe] snapshot chunk failed (skipping)",
      );
    }
  }

  logger.info(
    { totalAssets: assets.length, candidates: candidates.length },
    "[stock-universe] market-wide universe built",
  );
  return { builtAt: Date.now(), totalAssets: assets.length, candidates, source: "market" };
}

function staticFallback(): UniverseCache {
  return {
    builtAt: Date.now(),
    totalAssets: STOCK_UNIVERSE.length,
    candidates: STOCK_UNIVERSE.map((e) => ({
      ticker: e.ticker,
      name: e.name,
      sector: e.sector,
      snapshot: {
        price: 0, prevClose: 0, changePct: 0, volume: 0, prevVolume: 0,
        bid: 0, ask: 0, bidSize: 0, askSize: 0, spreadPct: null,
      },
    })),
    source: "static-fallback",
  };
}

/**
 * The current pre-filtered market-wide candidate list. Rebuilds at most every
 * 4 hours; concurrent callers share one in-flight build. Never throws — on
 * failure it returns the static universe (and caches that fallback only
 * briefly so the next scan retries the market-wide fetch).
 */
export async function getMarketUniverse(): Promise<UniverseCandidate[]> {
  if (cache && Date.now() - cache.builtAt < CACHE_TTL_MS && cache.source === "market") {
    return cache.candidates;
  }
  // Stale-while-revalidate: keep serving a stale market cache if a rebuild is
  // already running.
  if (building) {
    if (cache) return cache.candidates;
    return building.then((c) => c.candidates);
  }
  building = buildMarketUniverse()
    .catch((err) => {
      logger.warn({ err }, "[stock-universe] market-wide build failed — using static fallback");
      const fb = staticFallback();
      // Short-lived fallback cache: retry the market-wide fetch on next scan.
      fb.builtAt = Date.now() - CACHE_TTL_MS + 10 * 60 * 1000;
      return fb;
    })
    .then((c) => {
      cache = c;
      return c;
    })
    .finally(() => {
      building = null;
    });
  if (cache) return cache.candidates; // serve stale during rebuild
  return (await building).candidates;
}
