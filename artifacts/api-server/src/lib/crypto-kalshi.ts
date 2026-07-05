// ---------------------------------------------------------------------------
// crypto-kalshi.ts — Kalshi 15-min target fetching, window context, ML cache
// ---------------------------------------------------------------------------

import { logger } from "./logger";

// Map of symbol → Kalshi series ticker for coins that have 15-min markets.
export const KALSHI_SERIES: Record<string, string> = {
  BTC:  "KXBTC15M",
  ETH:  "KXETH15M",
  SOL:  "KXSOL15M",
  XRP:  "KXXRP15M",
  HYPE: "KXHYPE15M",
  BNB:  "KXBNB15M",
  DOGE: "KXDOGE15M",
};

// Per-symbol cache so each coin's Kalshi target is fetched independently.
// Stores the event ticker so window transitions can be detected by callers.
export const kalshiTargetCache = new Map<string, {
  value: number | null;
  ticker?: string;
  at: number;
  closeTime?: string;
  yesPrice?: number | null;
  yesAsk?: number | null;
  yesBid?: number | null;
}>();
// Reduced to 5s so bid/ask data used at order time is always ≤5s stale,
// matching the near-boundary TTL that was already applied at window edges.
const KALSHI_TARGET_LIB_TTL = 5_000;

// Tracks when each symbol's new-window Kalshi target was first confirmed.
export const confirmedTargetStore = new Map<string, { ticker: string; confirmedAt: number; target: number }>();

export function getConfirmedTargetMs(symbol: string): number | null {
  return confirmedTargetStore.get(symbol.toUpperCase())?.confirmedAt ?? null;
}

// Returns the most-recently-seen event ticker for a symbol.
export function getLastKalshiTicker(symbol: string): string | undefined {
  return kalshiTargetCache.get(symbol.toUpperCase())?.ticker;
}

// Tracks the coin price when each Kalshi window opened, keyed by event ticker.
export const kalshiWindowStore = new Map<string, { priceAtOpen: number | null; openedAt: number }>();

export function updateKalshiWindowPrice(ticker: string | undefined, coinPrice: number): void {
  if (!ticker || coinPrice <= 0) return;
  const existing = kalshiWindowStore.get(ticker);
  if (!existing) {
    kalshiWindowStore.set(ticker, { priceAtOpen: coinPrice, openedAt: Date.now() });
  } else if (existing.priceAtOpen === null) {
    existing.priceAtOpen = coinPrice;
  }
}

// Cache of the most recently computed ML above/below prediction per symbol.
export const lastMLAboveCache = new Map<string, boolean | null>();

export function getLastMLAbove(symbol: string): boolean | null {
  return lastMLAboveCache.get(symbol.toUpperCase()) ?? null;
}

export function getKalshiWindowContext(symbol: string): {
  priceAtOpen: number | null;
  minutesElapsed: number;
  secondsElapsed: number;
} | null {
  const ticker = getLastKalshiTicker(symbol);
  if (!ticker) return null;
  const entry = kalshiWindowStore.get(ticker);
  if (!entry) return null;
  const msElapsed = Math.max(0, Date.now() - entry.openedAt);
  return {
    priceAtOpen: entry.priceAtOpen,
    minutesElapsed: Math.floor(msElapsed / 60_000),
    secondsElapsed: Math.floor(msElapsed / 1_000),
  };
}

// Returns the current in-memory Kalshi target cache entry for a symbol.
export function getKalshiCachedData(symbol: string): {
  value: number | null;
  ticker?: string;
  yesPrice?: number | null;
  yesAsk?: number | null;
  yesBid?: number | null;
  closeTime?: string;
} | null {
  return kalshiTargetCache.get(symbol.toUpperCase()) ?? null;
}

export async function fetchKalshiTarget(symbol: string, targetTime?: Date): Promise<number | null> {
  const sym = symbol.toUpperCase();
  const series = KALSHI_SERIES[sym];
  if (!series) return null;

  if (!targetTime) {
    const hit = kalshiTargetCache.get(sym);
    const secIntoWindow = Math.floor(Date.now() / 1_000) % (15 * 60);
    const isNearBoundary = secIntoWindow < 90 || secIntoWindow > (15 * 60 - 90);
    const effectiveTTL = isNearBoundary ? 5_000 : KALSHI_TARGET_LIB_TTL;
    if (hit && Date.now() - hit.at < effectiveTTL) {
      const ct = hit.closeTime;
      if (!ct || new Date(ct).getTime() > Date.now()) return hit.value;
    }
  }

  try {
    const resp = await fetch(
      `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${series}&status=open&limit=10`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) {
      if (!targetTime) kalshiTargetCache.set(sym, { value: null, at: Date.now() });
      return null;
    }
    const body = (await resp.json()) as {
      markets?: {
        floor_strike?: number;
        ticker?: string;
        close_time?: string;
        yes_ask?: number;
        yes_bid?: number;
        last_price?: number;
      }[];
    };

    const markets = (body.markets ?? []).filter(
      (m) => typeof m.floor_strike === "number" && (m.floor_strike as number) > 0,
    );

    let selected: (typeof markets)[0] | undefined;

    if (targetTime) {
      const targetMs = targetTime.getTime();
      const marketsWithCloseTime = markets.filter((m) => m.close_time);
      if (marketsWithCloseTime.length > 0) {
        let bestDiff = Infinity;
        for (const m of marketsWithCloseTime) {
          const diff = Math.abs(new Date(m.close_time!).getTime() - targetMs);
          if (diff < 8 * 60_000 && diff < bestDiff) { bestDiff = diff; selected = m; }
        }
        if (!selected) {
          logger.info("[kalshi] %s: no market within 8 min of %s — will retry", sym, targetTime.toISOString());
          return null;
        }
      } else {
        selected = markets[0];
        if (selected) {
          logger.warn({ sym, floor_strike: selected.floor_strike }, "[kalshi] close_time absent from API response — using first market. Consider checking the API format.");
        }
      }
    } else {
      selected = markets[0];
    }

    if (selected) {
      const toFrac = (v: number | undefined | null) =>
        typeof v === "number" && v > 0 ? v / 100 : null;
      const yesAsk   = toFrac(selected.yes_ask);
      const yesBid   = toFrac(selected.yes_bid);
      const lastP    = toFrac(selected.last_price);
      const yesPrice =
        yesAsk !== null && yesBid !== null ? (yesAsk + yesBid) / 2
        : yesAsk ?? yesBid ?? lastP ?? null;
      kalshiTargetCache.set(sym, {
        value: selected.floor_strike!,
        ticker: selected.ticker,
        at: Date.now(),
        closeTime: (selected as Record<string, unknown>).close_time as string | undefined,
        yesPrice,
        yesAsk,
        yesBid,
      });
      if (selected.ticker && !kalshiWindowStore.has(selected.ticker)) {
        kalshiWindowStore.set(selected.ticker, { priceAtOpen: null, openedAt: Date.now() });
      }
      if (selected.ticker) {
        const prevConf = confirmedTargetStore.get(sym);
        if (!prevConf || prevConf.ticker !== selected.ticker) {
          confirmedTargetStore.set(sym, {
            ticker: selected.ticker,
            confirmedAt: Date.now(),
            target: selected.floor_strike!,
          });
        }
      }
      return selected.floor_strike!;
    }

    if (!targetTime) kalshiTargetCache.set(sym, { value: null, at: Date.now() });
    return null;
  } catch {
    return null;
  }
}
