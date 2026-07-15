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
// This module runs an independent setInterval that forces a fresh Kalshi API
// fetch for every conviction-eligible coin once per second.  It achieves this
// by deleting each coin's cache entry before calling fetchKalshiTarget so the
// 2 s TTL guard is bypassed.  The bot loop and tick continue to read from
// getKalshiCachedData as before — they just always find data that is ≤ 1 s old.
// ---------------------------------------------------------------------------

import { kalshiTargetCache, fetchKalshiTarget, KALSHI_SERIES } from "./crypto-kalshi";
import { S } from "./kalshi-bot-state";
import { logger } from "./logger";

const POLL_INTERVAL_MS = 1_000;

let pollerHandle: ReturnType<typeof setInterval> | null = null;

async function pollOnce(): Promise<void> {
  const syms = Object.keys(KALSHI_SERIES);
  await Promise.allSettled(
    syms.map(async (sym) => {
      // Delete cache entry to bypass the TTL guard — we need a live fetch every tick.
      kalshiTargetCache.delete(sym);
      await fetchKalshiTarget(sym);
    }),
  );
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
