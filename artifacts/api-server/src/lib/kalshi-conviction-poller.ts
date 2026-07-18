// ---------------------------------------------------------------------------
// kalshi-conviction-poller.ts
// Dedicated 1-second price poller for conviction mode.
//
// In conviction mode the bot fires on a Kalshi YES-price crossing the lock
// threshold (default 90 ¢).  The shared kalshiTargetCache has a 2 s TTL that
// is fine for normal signal-based modes but too coarse for conviction: a coin
// can pass through the 88–92 ¢ zone and back out again within 1–2 s, so the
// bot trigger check sees the stale "91 ¢" reading while the live gate already
// sees 99.8 ¢ and aborts — producing constant "price moved outside window"
// log spam and never entering the position.
//
// This module:
//  1. Runs setInterval(1 s) forcing a fresh Kalshi API fetch for every
//     conviction-eligible coin.  It clears each cache entry before calling
//     fetchKalshiTarget so the 2 s TTL guard is bypassed.
//  2. Maintains a dedicated conviction price map with a 1.5 s TTL that the
//     bot loop reads via getConvictionLivePrice(sym).  If the poller data is
//     stale (>1.5 s) or absent, callers fall back to getKalshiCachedData.
//  3. Detects zone entry: when a coin's price enters [lockPrice, lockPriceCap],
//     the poller clears its convictionAbortCooldown entry so Phase 3 (running
//     every 1 s) evaluates the coin immediately rather than waiting up to 10 s
//     for the cooldown to expire.  The live-price gate in the tick always
//     performs a final authenticated orderbook check before any order is placed
//     — that is the true guard against out-of-zone fills.  The poller only
//     removes a throttle delay; it does not place orders itself.
// ---------------------------------------------------------------------------

import { kalshiTargetCache, fetchKalshiTarget, fetchOrderbookPrices, KALSHI_SERIES } from "./crypto-kalshi";
// kalshiTargetCache is imported read-only here — the poller never deletes or
// mutates it directly.  fetchKalshiTarget(sym, undefined, true) bypasses the
// TTL and atomically overwrites the entry once the live fetch returns, so the
// shared cache never has a transient null gap visible to other readers.
import { S, convictionAbortCooldown, convictionFiredThisWindow } from "./kalshi-bot-state";
import { deriveConvictionZone } from "./kalshi-bot-engine";
import { logger } from "./logger";

const POLL_INTERVAL_MS = 1_000;
const LIVE_PRICE_TTL_MS = 1_500; // data older than this is considered stale

export interface ConvictionLivePrice {
  yesAsk: number | null;
  yesBid: number | null;
  noAsk:  number | null;
  fetchedAt: number;
  /** The Kalshi market ticker this snapshot was fetched from (e.g. KXXRP15M-26JUL180045-45).
   *  The bot-tick cross-checks this against expectedTicker to reject drift to the next window. */
  ticker: string | undefined;
}

// Dedicated per-symbol price map populated exclusively by this poller.
// Separated from kalshiTargetCache so staleness can be enforced with a tighter
// TTL independent of the shared cache's 2 s TTL.
const convictionPriceMap = new Map<string, ConvictionLivePrice>();

let pollerHandle: ReturnType<typeof setInterval> | null = null;

async function pollOnce(): Promise<void> {
  const syms = Object.keys(KALSHI_SERIES);

  // Derive the conviction zone once per poll from the current config.
  // Matches the derivation in kalshi-bot-tick.ts exactly.
  const gateTarget   = S.config.kalshiLockPrice ?? 0.90;
  const { lockPrice, lockPriceCap } = deriveConvictionZone(gateTarget);

  // Current 15-min window key — used to form the cooldown Map key.
  const nowMs     = Date.now();
  const windowKey = new Date(Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000))
    .toISOString()
    .slice(0, 16);

  // Pin each fetch to the CURRENT window's market by passing its close time.
  // Without targetTime, fetchKalshiTarget picks whichever market is nearest
  // to the next 15-min boundary.  Kalshi pre-publishes the next window ~10 min
  // early, so ~5 min into each window the selector silently switches to it.
  // The freshly-published market has no market-maker quotes yet and returns
  // sentinel prices (yesAsk=0.001, yesBid=null or the reverse).  Those flow
  // into computeConvictionDecision as extreme prices (≥0.92 / ≤0.08), bypass
  // the lockPriceCap guard, and classify every coin as BET_YES or BET_NO —
  // causing constant dispatch + constant live-price-gate blocks = zero fills.
  // Passing windowCloseTime constrains the selector to markets closing within
  // 8 min of the CURRENT window's end, matching the bot-tick expectedTicker fix.
  const windowCloseTime = new Date(
    Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000) + 15 * 60_000,
  );

  await Promise.allSettled(
    syms.map(async (sym) => {
      // forceRefresh=true bypasses the TTL check without deleting the existing
      // cache entry.  The old entry stays readable to other callers until the
      // live fetch atomically overwrites it — no transient null gap.
      // windowCloseTime pins to the current window — prevents next-window drift.
      await fetchKalshiTarget(sym, windowCloseTime, true);
      // Read the freshly overwritten cache entry and mirror into the dedicated
      // conviction price map with its own 1.5 s TTL.
      const entry = kalshiTargetCache.get(sym);
      if (entry && (entry.yesAsk != null || entry.yesBid != null || entry.noAsk != null)) {
        convictionPriceMap.set(sym, {
          yesAsk: entry.yesAsk ?? null,
          yesBid: entry.yesBid ?? null,
          noAsk:  entry.noAsk  ?? null,
          fetchedAt: entry.at ?? nowMs,
          ticker: entry.ticker,
        });
      }

      // ── Zone-entry detection ──────────────────────────────────────────────
      // If this coin's price has entered [lockPrice, lockPriceCap] on either
      // side and no bet has been placed this window yet, clear the abort
      // cooldown so Phase 3 evaluates it on the very next 1 s tick.
      //
      // Phase 3 still runs all standard gates including the live-price gate
      // (which does a fresh authenticated orderbook fetch and enforces the
      // zone strictly).  No order is placed by the poller — it only removes
      // the 10 s throttle delay that would otherwise cause a brief zone visit
      // to be missed entirely.
      if (convictionFiredThisWindow.has(`${sym}:${windowKey}`)) {
        // Already bet this coin this window — nothing to do.
        return;
      }

      const { yesAsk, yesBid, noAsk: cachedNoAsk } = convictionPriceMap.get(sym) ?? { yesAsk: null, yesBid: null, noAsk: null };
      // Prefer noAsk (from no_ask_dollars) directly — the Kalshi API updates
      // no_ask_dollars and yes_bid_dollars independently; noAsk is faster to
      // reflect real-time NO pricing than the 1−yesBid complement.
      const noAsk = cachedNoAsk ?? (yesBid != null ? 1 - yesBid : null);

      const yesInZone = yesAsk != null && yesAsk >= lockPrice && yesAsk <= lockPriceCap;
      const noInZone  = noAsk  != null && noAsk  >= lockPrice && noAsk  <= lockPriceCap;

      if (yesInZone || noInZone) {
        const cooldownKey = `${sym}:${windowKey}`;
        const hadCooldown = convictionAbortCooldown.has(cooldownKey);
        if (hadCooldown) {
          convictionAbortCooldown.delete(cooldownKey);
          logger.info(
            {
              sym, windowKey,
              yesAsk: yesAsk != null ? +yesAsk.toFixed(4) : null,
              noAsk:  noAsk  != null ? +noAsk.toFixed(4)  : null,
              lockPrice, lockPriceCap,
              side: yesInZone ? "YES" : "NO",
            },
            "[conviction-poller] zone entry detected — cooldown cleared, Phase 3 will evaluate next tick",
          );
        }
      }
      // ─────────────────────────────────────────────────────────────────────
    }),
  );
}

/**
 * Returns poller-sourced YES ask/bid for `sym` if the data is ≤ 1.5 s old.
 * Returns null when the poller has never run for this symbol or the data is stale.
 * Callers must fall back to getKalshiCachedData when this returns null.
 */
export function getConvictionLivePrice(sym: string): ConvictionLivePrice | null {
  const entry = convictionPriceMap.get(sym.toUpperCase());
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > LIVE_PRICE_TTL_MS) return null;
  return entry;
}

/**
 * Start the conviction price poller.  Idempotent — calling multiple times
 * while already running is a no-op.
 */
export function startConvictionPoller(): void {
  if (pollerHandle !== null) return;
  logger.info("[conviction-poller] starting 1 s fresh-price poll");
  // Fire immediately so the first bot tick after mode switch has fresh data.
  pollOnce().catch(() => {});
  pollerHandle = setInterval(() => {
    pollOnce().catch((err) =>
      logger.debug({ err }, "[conviction-poller] poll error (non-fatal)"),
    );
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the conviction price poller.  Idempotent.
 */
export function stopConvictionPoller(): void {
  if (pollerHandle === null) return;
  clearInterval(pollerHandle);
  pollerHandle = null;
  convictionPriceMap.clear();
  logger.info("[conviction-poller] stopped");
}

/**
 * Sync poller running state to the current bot decision mode.
 * Call after any config change that may have altered decisionMode, and once
 * at startup after loadBotConfigFromDB.
 */
export function syncConvictionPoller(): void {
  if (S.config.decisionMode === "conviction") {
    startConvictionPoller();
  } else {
    stopConvictionPoller();
  }
}

export function isConvictionPollerRunning(): boolean {
  return pollerHandle !== null;
}

export interface ConvictionPollerStats {
  running: boolean;
  priceAgeMs: Record<string, number>;
}

/**
 * Returns poller health stats: whether it is running and, for each tracked
 * coin, how many milliseconds ago the most recent price was fetched.
 * Coins with no data yet are omitted from priceAgeMs.
 */
export function getPollerStats(): ConvictionPollerStats {
  const now = Date.now();
  const priceAgeMs: Record<string, number> = {};
  for (const [sym, entry] of convictionPriceMap.entries()) {
    priceAgeMs[sym] = now - entry.fetchedAt;
  }
  return { running: pollerHandle !== null, priceAgeMs };
}
