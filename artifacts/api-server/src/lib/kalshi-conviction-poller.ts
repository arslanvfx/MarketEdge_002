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
// ---------------------------------------------------------------------------

import { kalshiTargetCache, fetchKalshiTarget, KALSHI_SERIES } from "./crypto-kalshi";
import { S } from "./kalshi-bot-state";
import { logger } from "./logger";

const POLL_INTERVAL_MS = 1_000;
const LIVE_PRICE_TTL_MS = 1_500; // data older than this is considered stale

export interface ConvictionLivePrice {
  yesAsk: number | null;
  yesBid: number | null;
  fetchedAt: number;
}

// Dedicated per-symbol price map populated exclusively by this poller.
// Separated from kalshiTargetCache so staleness can be enforced with a tighter
// TTL independent of the shared cache's 2 s TTL.
const convictionPriceMap = new Map<string, ConvictionLivePrice>();

let pollerHandle: ReturnType<typeof setInterval> | null = null;

async function pollOnce(): Promise<void> {
  const syms = Object.keys(KALSHI_SERIES);
  await Promise.allSettled(
    syms.map(async (sym) => {
      // Delete the shared cache entry to bypass its 2 s TTL guard,
      // forcing fetchKalshiTarget to hit the Kalshi API live.
      kalshiTargetCache.delete(sym);
      await fetchKalshiTarget(sym);
      // Read back the freshly populated cache entry and mirror it into the
      // dedicated conviction price map with its own 1.5 s TTL.
      const entry = kalshiTargetCache.get(sym);
      if (entry && entry.yesAsk != null || entry?.yesBid != null) {
        convictionPriceMap.set(sym, {
          yesAsk: entry?.yesAsk ?? null,
          yesBid: entry?.yesBid ?? null,
          fetchedAt: entry?.at ?? Date.now(),
        });
      }
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
