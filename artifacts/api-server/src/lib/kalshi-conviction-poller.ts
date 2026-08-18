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
import { S, convictionAbortCooldown, convictionAbortCooldownMs, CONVICTION_ABORT_COOLDOWN_MS, convictionFiredThisWindow, convictionPriceTicks, callConvictionZoneEntry, convictionObCache } from "./kalshi-bot-state";
import { deriveConvictionZone } from "./kalshi-bot-engine";
import { CRYPTO_COINS, getTickerFresh } from "./crypto-data";
import { logger } from "./logger";

const POLL_INTERVAL_MS = 1_000;
const LIVE_PRICE_TTL_MS = 1_500; // data older than this is considered stale
const HEALTH_LOG_INTERVAL_MS = 60_000; // periodic tick-feed health summary

// ── Fresh-tick feed health tracking ─────────────────────────────────────────
// Per-coin counters for the getTickerFresh spot-price fetch that feeds the
// direction guard's tick data.  A silent run of failures here means the guard
// is operating on candle fallback (or failing closed) — that state must be
// visible in production logs, not silent.
interface TickFeedHealth {
  okCount: number;         // successful fresh fetches since last health log
  failCount: number;       // failed/invalid fetches since last health log
  consecutiveFails: number;
  lastOkAt: number | null; // ts of last successful tick push
}
const tickFeedHealth = new Map<string, TickFeedHealth>();
let lastHealthLogAt = 0;

function healthFor(sym: string): TickFeedHealth {
  let h = tickFeedHealth.get(sym);
  if (!h) {
    h = { okCount: 0, failCount: 0, consecutiveFails: 0, lastOkAt: null };
    tickFeedHealth.set(sym, h);
  }
  return h;
}

// Symbol → Coinbase product id (e.g. "BTC" → "BTC-USD") for the live spot-price
// fetch that feeds the direction guard.  Built once from CRYPTO_COINS.
const COIN_PRODUCT: Record<string, string> = Object.fromEntries(
  CRYPTO_COINS.map((c) => [c.symbol.toUpperCase(), c.product]),
);

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
  // MUST use the two-argument (floor, cap) form — identical to the derivation
  // in kalshi-bot-tick.ts and kalshi-bot-engine.ts.  The legacy single-arg
  // form computes a different zone (target−2¢..target+3¢), which caused the
  // poller to dispatch ticks for prices OUTSIDE the real zone: every dispatch
  // aborted, transiently set convictionFiredThisWindow, and cleared the abort
  // cooldown — killing all bets (2026-08 regression).
  const { lockPrice, lockPriceCap } = deriveConvictionZone(
    S.config.kalshiLockPrice    ?? 0.82,
    S.config.kalshiLockPriceCap ?? 0.91,
  );

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
      // ── Live spot-price tick for the direction guard ──────────────────────
      // Fetch the REAL crypto spot price fresh (bypassing the 2 s ticker TTL)
      // and push it into convictionPriceTicks.  This is the ONLY writer of that
      // map — the direction guard reads it to detect consecutive-seconds adverse
      // movement.  Previously the bot loop populated it from getCachedPrediction,
      // whose predCache refreshes only every ~15 s, so every "tick" carried the
      // same frozen price → the guard's net slope was always ~0 (flat) → it
      // never blocked a wrong-way entry.  Fail-open: on fetch error or a 0/NaN
      // price we push nothing, so a feed outage cannot fabricate a fake decline
      // (the guard returns blocked=false when it has < 2 samples).
      const product = COIN_PRODUCT[sym];
      if (product) {
        const h = healthFor(sym);
        try {
          const spot = await getTickerFresh(product);
          if (Number.isFinite(spot) && spot > 0) {
            const ticks = convictionPriceTicks.get(sym) ?? [];
            ticks.push({ price: spot, ts: Date.now() });
            // Keep ~5 min of history at 1 s cadence; the guard filters to the
            // last few seconds via timestamp but deep history costs little.
            if (ticks.length > 300) ticks.splice(0, ticks.length - 300);
            convictionPriceTicks.set(sym, ticks);
            h.okCount++;
            h.consecutiveFails = 0;
            h.lastOkAt = Date.now();
          } else {
            // Invalid price (0/NaN) counts as a feed failure — no tick pushed.
            h.failCount++;
            h.consecutiveFails++;
          }
        } catch {
          // No tick pushed on error.  The direction guard fails CLOSED when it
          // ends up with no usable source, so a feed outage blocks entries
          // rather than fabricating a fake decline OR silently passing.
          h.failCount++;
          h.consecutiveFails++;
          if (h.consecutiveFails === 5 || h.consecutiveFails % 30 === 0) {
            logger.warn(
              { sym, consecutiveFails: h.consecutiveFails, lastOkAgoMs: h.lastOkAt != null ? Date.now() - h.lastOkAt : null },
              "[conviction-poller] fresh spot-price fetch failing repeatedly — direction guard tick feed degraded",
            );
          }
        }
      }

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

        // ── Abort-cooldown state ──────────────────────────────────────────────
        // The tick sets convictionAbortCooldown after a live-price gate miss.
        // We need to know both (a) whether a cooldown record exists and (b)
        // whether it is still ACTIVE (not yet expired).  Using only .has()
        // would treat an expired record as still-active and suppress dispatch.
        const abortedAt        = convictionAbortCooldown.get(cooldownKey);
        const storedCooldownMs = convictionAbortCooldownMs.get(cooldownKey) ?? CONVICTION_ABORT_COOLDOWN_MS;
        const cooldownActive   = abortedAt != null && Date.now() - abortedAt < storedCooldownMs;

        // Always clear the abort-cooldown record on zone re-entry so that the
        // 5-second loop can retry on its next evaluation even if we do not
        // dispatch here (e.g. because the cooldown is still active).
        if (abortedAt != null) {
          convictionAbortCooldown.delete(cooldownKey);
          if (cooldownActive) {
            logger.info(
              {
                sym, windowKey,
                yesAsk: yesAsk != null ? +yesAsk.toFixed(4) : null,
                noAsk:  noAsk  != null ? +noAsk.toFixed(4)  : null,
                lockPrice, lockPriceCap,
                side: yesInZone ? "YES" : "NO",
                remainingMs: Math.round(storedCooldownMs - (Date.now() - abortedAt)),
              },
              "[conviction-poller] zone entry — abort cooldown cleared (was active); loop will retry on next cycle",
            );
          }
        }

        // ── Pre-warm orderbook + immediate dispatch ───────────────────────────
        // Dispatch the tick immediately (instead of waiting up to 4.9 s for the
        // 5-second scheduler) ONLY when:
        //   1. No bet has been placed for this coin this window.
        //   2. There is no ACTIVE abort cooldown.  After a tick abort the
        //      cooldown period is intentional rate-limiting; we respect it by
        //      letting the 5-second loop handle the retry once the cooldown
        //      expires naturally.  Dispatching every 1 s while a cooldown is
        //      active would hammer the Kalshi OB API.
        //   3. The bot is enabled and not paused.
        // All standard gates (live-price, direction guard, candle slope, etc.)
        // still run inside runBotTickForCoin — nothing is bypassed here.
        if (
          !convictionFiredThisWindow.has(cooldownKey) &&
          !cooldownActive &&
          S.config.enabled &&
          !S.paused
        ) {
          // Pre-warm: fetch the authenticated orderbook now (same poll cycle)
          // so the live-price gate in the tick can read it from convictionObCache
          // and skip its own 0.5–2 s round-trip.
          const pollerEntry = convictionPriceMap.get(sym);
          if (pollerEntry?.ticker) {
            try {
              const ob = await fetchOrderbookPrices(pollerEntry.ticker);
              if (ob !== null) {
                // Cache the authenticated result.  Empty-book { yesAsk: null,
                // yesBid: null } is a valid response and is cached.  We do NOT
                // cache null (timeout/network error): the tick treats null as
                // "retry later" and must not be misled by a stale failure.
                convictionObCache.set(sym, {
                  yesAsk:    ob.yesAsk,
                  yesBid:    ob.yesBid,
                  fetchedAt: Date.now(),
                  ticker:    pollerEntry.ticker,
                });
              }
            } catch {
              // OB pre-fetch failed — the tick will fall back to its own call.
            }
          }

          logger.info(
            {
              sym, windowKey,
              yesAsk: yesAsk != null ? +yesAsk.toFixed(4) : null,
              noAsk:  noAsk  != null ? +noAsk.toFixed(4)  : null,
              lockPrice, lockPriceCap,
              side: yesInZone ? "YES" : "NO",
              obCached: convictionObCache.has(sym),
            },
            "[conviction-poller] zone entry — dispatching tick immediately",
          );
          callConvictionZoneEntry(sym, yesAsk, noAsk);
        }
        // ─────────────────────────────────────────────────────────────────────
      }
      // ─────────────────────────────────────────────────────────────────────
    }),
  );

  // ── Periodic tick-feed health summary ────────────────────────────────────
  // Once a minute, log per-coin ok/fail counts since the previous summary so
  // production logs always show whether the direction-guard tick feed is
  // healthy — without spamming a line per second.
  if (nowMs - lastHealthLogAt >= HEALTH_LOG_INTERVAL_MS) {
    lastHealthLogAt = nowMs;
    const summary: Record<string, { ok: number; fail: number; consecutiveFails: number; lastOkAgoMs: number | null }> = {};
    for (const [sym, h] of tickFeedHealth) {
      summary[sym] = {
        ok: h.okCount,
        fail: h.failCount,
        consecutiveFails: h.consecutiveFails,
        lastOkAgoMs: h.lastOkAt != null ? nowMs - h.lastOkAt : null,
      };
      h.okCount = 0;
      h.failCount = 0;
    }
    logger.info({ feeds: summary }, "[conviction-poller] tick-feed health (last 60 s)");
  }
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
  tickFeedHealth.clear();
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
  /** Direction-guard tick feed health: per-coin consecutive fresh-fetch
   *  failures and ms since the last successful spot-price tick. */
  tickFeed: Record<string, { consecutiveFails: number; lastOkAgoMs: number | null }>;
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
  const tickFeed: Record<string, { consecutiveFails: number; lastOkAgoMs: number | null }> = {};
  for (const [sym, h] of tickFeedHealth.entries()) {
    tickFeed[sym] = {
      consecutiveFails: h.consecutiveFails,
      lastOkAgoMs: h.lastOkAt != null ? now - h.lastOkAt : null,
    };
  }
  return { running: pollerHandle !== null, priceAgeMs, tickFeed };
}
