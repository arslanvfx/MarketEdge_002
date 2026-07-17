// ---------------------------------------------------------------------------
// crypto-kalshi.ts — Kalshi 15-min target fetching, window context, ML cache
// ---------------------------------------------------------------------------

import crypto from "crypto";
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
  NEAR: "KXNEAR15M",
  ZEC:  "KXZEC15M",
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
// 2s so the conviction bot tick (which runs every 2 s) always reads prices that
// are at most one tick stale, ensuring brief 88–92¢ crossings aren't missed.
const KALSHI_TARGET_LIB_TTL = 2_000;

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

/**
 * Returns the UTC timestamp (ms) of the most recent 15-minute window boundary.
 * Kalshi 15-min markets align to XX:00, XX:15, XX:30, XX:45 UTC.
 * Using the actual boundary (not Date.now()) ensures minutesElapsed in
 * getKalshiWindowContext always reflects true elapsed time since window open,
 * regardless of when the Kalshi ticker was first confirmed by the prefetch.
 */
function getCurrentWindowOpenMs(): number {
  const WINDOW_MS = 15 * 60 * 1_000;
  return Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
}

export function updateKalshiWindowPrice(ticker: string | undefined, coinPrice: number): void {
  if (!ticker || coinPrice <= 0) return;
  const existing = kalshiWindowStore.get(ticker);
  if (!existing) {
    kalshiWindowStore.set(ticker, { priceAtOpen: coinPrice, openedAt: getCurrentWindowOpenMs() });
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

// ---------------------------------------------------------------------------
// Authenticated Kalshi orderbook fallback
// ---------------------------------------------------------------------------
// When the public /markets list returns a valid strike but no bid/ask/last_price
// (common during early-window periods before market makers post quotes) we
// attempt an authenticated GET /markets/{ticker}/orderbook call.  The signed
// request typically reveals the live best-bid/ask even when the public endpoint
// is stale or missing price fields.
// ---------------------------------------------------------------------------

export type OrderbookPrices = {
  yesAsk: number | null;
  yesBid: number | null;
  /** YES bids [price_dollars, quantity], ascending price (best bid = last).  Empty when unavailable. */
  yesDepth: Array<[number, number]>;
  /** NO bids [price_dollars, quantity], ascending price (best bid = last).  Empty when unavailable.
   *  YES ask at price P corresponds to the NO bid at (1-P). */
  noDepth: Array<[number, number]>;
};

export async function fetchOrderbookPrices(
  ticker: string,
): Promise<OrderbookPrices | null> {
  const keyId = process.env["KALSHI_API_KEY_ID"] ?? null;
  const rawKey = process.env["KALSHI_PRIVATE_KEY"] ?? null;
  if (!keyId || !rawKey) return null;

  // Reconstruct PEM (mirrors the pattern in kalshi-trader.ts)
  let pem: string;
  if (rawKey.includes("-----BEGIN")) {
    pem = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
  } else {
    const b64 = rawKey.replace(/\s+/g, "");
    const lines = b64.match(/.{1,64}/g) ?? [];
    pem = ["-----BEGIN RSA PRIVATE KEY-----", ...lines, "-----END RSA PRIVATE KEY-----"].join("\n");
  }

  const path = `/markets/${encodeURIComponent(ticker)}/orderbook`;
  const tsMs = Date.now().toString();
  const message = tsMs + "GET" + "/trade-api/v2" + path;
  let signature: string;
  try {
    const sign = crypto.createSign("SHA256");
    sign.update(message);
    sign.end();
    signature = sign.sign({ key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, "base64");
  } catch {
    return null;
  }

  try {
    const resp = await fetch(`https://api.elections.kalshi.com/trade-api/v2${path}`, {
      headers: {
        Accept: "application/json",
        "KALSHI-ACCESS-KEY": keyId,
        "KALSHI-ACCESS-TIMESTAMP": tsMs,
        "KALSHI-ACCESS-SIGNATURE": signature,
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) {
      logger.warn(
        { ticker, status: resp.status, statusText: resp.statusText },
        "[kalshi] fetchOrderbookPrices: non-OK response",
      );
      return null;
    }
    const body = (await resp.json()) as {
      // Legacy format (integer cents): orderbook.yes / orderbook.no
      orderbook?: { yes?: [number, number][]; no?: [number, number][] };
      // Current format (string dollars, ascending price):
      // orderbook_fp.yes_dollars / orderbook_fp.no_dollars
      orderbook_fp?: {
        yes_dollars?: [string, string][];
        no_dollars?: [string, string][];
      };
    };

    // ── Current format: orderbook_fp (dollars, ASCENDING price order) ──────
    // Each side lists resting BIDS for that side.  The best bid is the
    // HIGHEST price → the LAST element of the ascending array.
    //   best YES bid = last yes_dollars price
    //   best YES ask = 1 − last no_dollars price (best NO bid complement)
    const fp = body.orderbook_fp;
    if (fp) {
      const yesArr = fp.yes_dollars ?? [];
      const noArr  = fp.no_dollars  ?? [];

      // Parse depth arrays: [string_price, string_qty] → [number, number]
      const yesDepth: Array<[number, number]> = yesArr
        .map(([p, q]) => [Number(p), Number(q)] as [number, number])
        .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q));
      const noDepth: Array<[number, number]> = noArr
        .map(([p, q]) => [Number(p), Number(q)] as [number, number])
        .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q));

      if (yesArr.length === 0 && noArr.length === 0) {
        // Kalshi authenticated the request and confirmed the book — it is
        // simply illiquid at this moment (no resting limit orders on either
        // side).  Return { yesBid: null, yesAsk: null } so the caller can
        // distinguish "auth/network failure" (null) from "authenticated empty
        // book" and fall back to the freshly-cached conviction-poller price.
        logger.warn({ ticker }, "[kalshi] fetchOrderbookPrices: orderbook_fp authenticated but both sides empty — falling back to cached price");
        return { yesBid: null, yesAsk: null, yesDepth: [], noDepth: [] };
      }
      const bestYesBid = yesDepth.length > 0 ? yesDepth[yesDepth.length - 1][0] : null;
      const bestNoBid  = noDepth.length  > 0 ? noDepth[noDepth.length - 1][0]   : null;
      const yesBid = bestYesBid != null && Number.isFinite(bestYesBid) ? bestYesBid : null;
      const yesAsk = bestNoBid  != null && Number.isFinite(bestNoBid)  ? 1 - bestNoBid : null;
      if (yesBid == null && yesAsk == null) {
        logger.warn({ ticker }, "[kalshi] fetchOrderbookPrices: orderbook_fp present but all entries non-finite");
        return { yesBid: null, yesAsk: null, yesDepth: [], noDepth: [] };
      }
      return { yesBid, yesAsk, yesDepth, noDepth };
    }

    // ── Legacy format: orderbook (integer cents 0-100) ──────────────────────
    // Depth arrays not available from legacy format — only best bid/ask parsed.
    const ob = body.orderbook;
    const yesBids = ob?.yes ?? [];
    const noBids  = ob?.no  ?? [];
    const bestYesBidCents = yesBids.length > 0 ? yesBids[yesBids.length - 1][0] : null;
    const bestNoBidCents  = noBids.length  > 0 ? noBids[noBids.length - 1][0]  : null;
    if (bestYesBidCents == null && bestNoBidCents == null) {
      logger.warn(
        { ticker, keys: Object.keys(body) },
        "[kalshi] fetchOrderbookPrices: no parsable orderbook in response",
      );
      return null;
    }
    return {
      yesBid: bestYesBidCents != null ? bestYesBidCents / 100 : null,
      yesAsk: bestNoBidCents  != null ? (100 - bestNoBidCents) / 100 : null,
      yesDepth: [],
      noDepth: [],
    };
  } catch (err) {
    logger.warn(
      { ticker, err: err instanceof Error ? err.message : String(err) },
      "[kalshi] fetchOrderbookPrices: request failed",
    );
    return null;
  }
}

export async function fetchKalshiTarget(symbol: string, targetTime?: Date, forceRefresh = false): Promise<number | null> {
  const sym = symbol.toUpperCase();
  const series = KALSHI_SERIES[sym];
  if (!series) return null;

  if (!targetTime) {
    const hit = kalshiTargetCache.get(sym);
    const secIntoWindow = Math.floor(Date.now() / 1_000) % (15 * 60);
    const isNearBoundary = secIntoWindow < 90 || secIntoWindow > (15 * 60 - 90);
    const effectiveTTL = isNearBoundary ? 5_000 : KALSHI_TARGET_LIB_TTL;
    // forceRefresh=true: skip TTL check but do NOT delete the existing entry.
    // The old entry stays valid until the live fetch atomically overwrites it,
    // preventing a brief null gap in the shared cache during the in-flight request.
    if (!forceRefresh && hit && Date.now() - hit.at < effectiveTTL) {
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
      // Do NOT nuke an existing ticker-bearing cache entry when forceRefresh
      // fails (e.g. transient 429/500).  The conviction poller calls
      // forceRefresh every 1 s; a single failed call must not clear the ticker
      // that Phase 4 reads immediately after — otherwise runBotTickForCoin gets
      // kalshiTicker=null and silently returns before reaching the live-price gate.
      if (!targetTime && !forceRefresh) kalshiTargetCache.set(sym, { value: null, at: Date.now() });
      return null;
    }
    const body = (await resp.json()) as {
      markets?: {
        floor_strike?: number | string;
        ticker?: string;
        close_time?: string;
        // Current API: YES-side dollar strings (primary — confirmed present as of mid-2026)
        yes_ask_dollars?: string;
        yes_bid_dollars?: string;
        last_price_dollars?: string;
        // Current API: NO-side dollar strings (secondary — complement of YES)
        no_ask_dollars?: string;
        no_bid_dollars?: string;
        // Legacy integer-cent fields (removed from Kalshi API in mid-2026; kept for fallback)
        yes_ask?: number;
        yes_bid?: number;
        last_price?: number;
      }[];
    };

    const markets = (body.markets ?? []).filter(
      (m) => Number(m.floor_strike) > 0,
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
      // Parse a dollar-string (e.g. "0.6100") that the current Kalshi API returns.
      const parseDollar = (s: string | undefined | null): number | null => {
        if (!s) return null;
        const n = parseFloat(s);
        return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
      };
      // Legacy: integer cents (Kalshi used to return yes_ask/yes_bid as cents 0-100)
      const toFrac = (v: number | undefined | null) =>
        typeof v === "number" && v > 0 && v < 100 ? v / 100 : null;

      // Priority 1: direct YES-side dollar strings (current Kalshi API, mid-2026+)
      // Priority 2: NO-side dollar strings — YES is the complement (yes_ask = 1−no_bid)
      // Priority 3: legacy integer-cent fields (pre-mid-2026, kept as last resort)
      const noAsk = parseDollar(selected.no_ask_dollars);
      const noBid = parseDollar(selected.no_bid_dollars);

      const yesAsk =
        parseDollar(selected.yes_ask_dollars) ??
        (noBid != null ? 1 - noBid : null) ??
        toFrac(selected.yes_ask);
      const yesBid =
        parseDollar(selected.yes_bid_dollars) ??
        (noAsk != null ? 1 - noAsk : null) ??
        toFrac(selected.yes_bid);
      const lastP =
        parseDollar(selected.last_price_dollars) ??
        toFrac(selected.last_price);

      // Canary: if all price paths resolved null, log the actual field names present
      // so the next API format change is immediately diagnosable from logs alone.
      if (yesAsk == null && yesBid == null && lastP == null) {
        const priceFields = Object.keys(selected as object).filter(k =>
          k.includes("ask") || k.includes("bid") || k.includes("price") || k.includes("dollar")
        );
        logger.warn(
          { sym, ticker: selected.ticker, priceFields },
          "[kalshi] WARNING: all price fields resolved null — Kalshi API format may have changed. " +
          "Check the priceFields list above against the parser in crypto-kalshi.ts and update accordingly.",
        );
      }

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

      // ── Authenticated orderbook fallback ──────────────────────────────────
      // If the public market endpoint returned no bid/ask/last_price (empty order
      // book or market makers not yet active), try the authenticated orderbook
      // endpoint which has access to live resting orders even when the public
      // market summary is stale or missing price fields.
      if (yesPrice == null && selected.ticker) {
        const ob = await fetchOrderbookPrices(selected.ticker);
        if (ob != null) {
          const obYesAsk = ob.yesAsk;
          const obYesBid = ob.yesBid;
          const obPrice = obYesAsk != null && obYesBid != null
            ? (obYesAsk + obYesBid) / 2
            : obYesAsk ?? obYesBid ?? null;
          if (obPrice != null) {
            logger.info(
              { sym, ticker: selected.ticker, obYesBid, obYesAsk, obPrice },
              "[kalshi] orderbook fallback resolved price — was null from public API",
            );
            kalshiTargetCache.set(sym, {
              ...kalshiTargetCache.get(sym)!,
              yesPrice: obPrice,
              yesAsk: obYesAsk,
              yesBid: obYesBid,
            });
          }
        }
      }

      if (selected.ticker && !kalshiWindowStore.has(selected.ticker)) {
        kalshiWindowStore.set(selected.ticker, { priceAtOpen: null, openedAt: getCurrentWindowOpenMs() });
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

    // Same guard: a forceRefresh that finds no market must not erase an existing
    // valid cache entry — the market may have published on the previous tick.
    if (!targetTime && !forceRefresh) kalshiTargetCache.set(sym, { value: null, at: Date.now() });
    return null;
  } catch {
    return null;
  }
}
