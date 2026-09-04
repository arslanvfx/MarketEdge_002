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
import { S, convictionAbortCooldown, convictionAbortCooldownMs, CONVICTION_ABORT_COOLDOWN_MS, CONVICTION_OB_CACHE_TTL_MS, convictionFiredThisWindow, convictionPriceTicks, callConvictionZoneEntry, convictionObCache } from "./kalshi-bot-state";
import { deriveConvictionZone, getEffectiveConvictionZone, isPriceTriggeredDecisionMode } from "./kalshi-bot-engine";
import { CRYPTO_COINS, getTickerFreshEvidenceHistory } from "./crypto-data";
import { collectRegularEntrySpotSample } from "./kalshi-regular-spot-sampler-core";
import { logger } from "./logger";
import {
  prewarmRegularAccountSnapshot,
  prewarmRegularOrderExchangeIndex,
} from "./kalshi-trader";
import {
  startRegularSpotSampler,
  stopRegularSpotSampler,
  shouldRunRegularSpotSampler,
} from "./kalshi-regular-spot-sampler";
import { ConvictionOrderbookWarmupCoordinator } from "./kalshi-conviction-orderbook-warmup";
import { PerKeyInFlight } from "./per-key-in-flight";
import {
  recordRegularSpotFetchAttempt,
  recordRegularSpotFetchFailure,
  recordRegularSpotFetchSuccess,
} from "./kalshi-regular-spot-telemetry";

const POLL_INTERVAL_MS = 1_000;
const SPOT_SAMPLE_WINDOW_MS = 15 * 60_000;
export const CONVICTION_LIVE_PRICE_TTL_MS = 1_500; // data older than this is considered stale
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
let pollerGeneration = 0;
let spotSamplerHandle: ReturnType<typeof setInterval> | null = null;
const spotSamplesInFlight = new PerKeyInFlight();
const marketPollsInFlight = new PerKeyInFlight();

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
  /** Strike paired with ticker by the same forced-fresh market response. */
  target: number | null;
}

// Dedicated per-symbol price map populated exclusively by this poller.
// Separated from kalshiTargetCache so staleness can be enforced with a tighter
// TTL independent of the shared cache's 2 s TTL.
const convictionPriceMap = new Map<string, ConvictionLivePrice>();

let pollerHandle: ReturnType<typeof setInterval> | null = null;

// Retain completed outcomes briefly so a fast failure is still recognized as
// the prepared request and cannot trigger an immediate duplicate read.
const orderbookWarmups = new ConvictionOrderbookWarmupCoordinator();

/**
 * Join an exact-ticker warmup already started by the poller. The bounded wait
 * prevents a slow authenticated read from dominating entry latency; on timeout
 * the tick uses its strict poller-fallback validator instead of duplicating the
 * same request.
 */
export async function waitForConvictionOrderbookWarmup(
  sym: string,
  ticker: string,
  timeoutMs = 900,
): Promise<boolean> {
  return orderbookWarmups.wait(sym, ticker, timeoutMs);
}

function isActiveGeneration(generation: number): boolean {
  return generation === pollerGeneration && pollerHandle !== null;
}

async function refreshSpotTick(sym: string, product: string, generation: number): Promise<void> {
  const h = healthFor(sym);
  const requestedWindowStartMs =
    Math.floor(Date.now() / SPOT_SAMPLE_WINDOW_MS) * SPOT_SAMPLE_WINDOW_MS;
  recordRegularSpotFetchAttempt(sym, product, Date.now());
  try {
    const symbolSamples = new Map([
      [sym, [...(convictionPriceTicks.get(sym) ?? [])]],
    ]);
    await collectRegularEntrySpotSample({
      product: { symbol: sym, product },
      fetchFresh: getTickerFreshEvidenceHistory,
      samples: symbolSamples,
      nowMs: Date.now(),
      receiptClock: Date.now,
    });
    if (
      !isActiveGeneration(generation)
      || Math.floor(Date.now() / SPOT_SAMPLE_WINDOW_MS) * SPOT_SAMPLE_WINDOW_MS
        !== requestedWindowStartMs
    ) return;
    const ticks = symbolSamples.get(sym) ?? [];
    const latest = ticks[ticks.length - 1];
    if (latest) {
      const receivedAt = Date.now();
      convictionPriceTicks.set(sym, ticks);
      recordRegularSpotFetchSuccess({
        symbol: sym,
        product,
        atMs: receivedAt,
        publishedAtMs: latest.oraclePublishedAtMs ?? null,
      });
      h.okCount++;
      h.consecutiveFails = 0;
      h.lastOkAt = receivedAt;
    } else {
      // Invalid price (0/NaN) counts as a feed failure — no tick pushed.
      h.failCount++;
      h.consecutiveFails++;
    }
  } catch (err) {
    // No tick pushed on error.  The direction guard fails CLOSED when it
    // ends up with no usable source, so a feed outage blocks entries rather
    // than fabricating a fake decline OR silently passing.
    h.failCount++;
    h.consecutiveFails++;
    recordRegularSpotFetchFailure({
      symbol: sym,
      product,
      atMs: Date.now(),
      reason: err instanceof Error ? err.message : String(err),
    });
    if (h.consecutiveFails === 5 || h.consecutiveFails % 30 === 0) {
      logger.warn(
        { sym, consecutiveFails: h.consecutiveFails, lastOkAgoMs: h.lastOkAt != null ? Date.now() - h.lastOkAt : null },
        "[conviction-poller] fresh spot-price fetch failing repeatedly — direction guard tick feed degraded",
      );
    }
  }
}

async function sampleSpotsOnceImpl(generation: number): Promise<void> {
  await Promise.allSettled(
    Object.entries(COIN_PRODUCT).map(([sym, product]) =>
      spotSamplesInFlight.run(sym, () => refreshSpotTick(sym, product, generation))
    ),
  );
}

function sampleSpotsOnce(): Promise<void> {
  return sampleSpotsOnceImpl(pollerGeneration);
}

/**
 * Begin an authenticated warmup without putting it on the dispatch critical
 * path.  A result is published only when the currently prepared public-price
 * snapshot is still fresh and names the exact ticker that was queried.  The
 * tick independently applies the same ticker+TTL check before consuming it.
 */
function startOrderbookWarmup(sym: string, ticker: string, generation: number): boolean {
  const cached = convictionObCache.get(sym);
  if (
    cached &&
    cached.ticker === ticker &&
    Date.now() - cached.fetchedAt <= CONVICTION_OB_CACHE_TTL_MS
  ) {
    return false;
  }

  orderbookWarmups.start(sym, ticker, async () => {
    const ob = await fetchOrderbookPrices(ticker);
      if (ob === null || !isActiveGeneration(generation)) return;

      // Do not let a slow old-window request become a "prepared" snapshot.
      const prepared = convictionPriceMap.get(sym);
      if (
        !prepared ||
        prepared.ticker !== ticker ||
        Date.now() - prepared.fetchedAt > CONVICTION_LIVE_PRICE_TTL_MS
      ) {
        return;
      }

      // Empty authenticated books are meaningful and intentionally cached;
      // failures (null) are not.
      convictionObCache.set(sym, {
        yesAsk: ob.yesAsk,
        yesBid: ob.yesBid,
        fetchedAt: Date.now(),
        ticker,
      });
  });
  return true;
}

async function pollOnceImpl(generation = pollerGeneration): Promise<void> {
  const syms = Object.keys(KALSHI_SERIES);

  // NOTE: the conviction zone is now derived PER SYMBOL inside the per-symbol
  // callback via getEffectiveConvictionZone(sym, S.config) — see the
  // "Zone-entry detection" block below.  Per-market overrides
  // (perMarketConvictionConfig) allow each coin/commodity to use a different
  // [lockPrice, lockPriceCap] while still sharing the same 1-second poll.
  // The two-argument deriveConvictionZone(floor, cap) form is still used
  // downstream — the single-arg form must never be used here.

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

  // Start the shared authenticated account refresh before the slower per-symbol
  // market work. Eligible quotes consume this snapshot synchronously; they must
  // never wait for account I/O on the placement path.
  void prewarmRegularAccountSnapshot();

  for (const sym of syms) {
    void marketPollsInFlight.run(sym, async () => {
      // forceRefresh=true bypasses the TTL check without deleting the existing
      // cache entry.  The old entry stays readable to other callers until the
      // live fetch atomically overwrites it — no transient null gap.
      // windowCloseTime pins to the current window — prevents next-window drift.
      const targetFetchStartedAt = Date.now();
      await fetchKalshiTarget(sym, windowCloseTime, true);
      if (!isActiveGeneration(generation)) return;
      // Read the freshly overwritten cache entry and mirror into the dedicated
      // conviction price map with its own 1.5 s TTL.
      const entry = kalshiTargetCache.get(sym);
      // A failed force refresh leaves the previous shared-cache entry intact.
      // Never promote that old entry into a newly "prepared" poller snapshot:
      // dispatching on it would defeat the strict ticker+freshness guard.
      const prepared = entry != null
        && entry.ticker != null
        && entry.at >= targetFetchStartedAt
        && Date.now() - entry.at <= CONVICTION_LIVE_PRICE_TTL_MS
        && (entry.yesAsk != null || entry.yesBid != null || entry.noAsk != null);
      if (!prepared || !entry) return;
      const preparedTicker = entry.ticker;
      if (preparedTicker == null) return;
      convictionPriceMap.set(sym, {
        yesAsk: entry.yesAsk ?? null,
        yesBid: entry.yesBid ?? null,
        noAsk:  entry.noAsk  ?? null,
        fetchedAt: entry.at,
        ticker: preparedTicker,
        target: Number.isFinite(entry.value) ? entry.value : null,
      });
      // Routing is immutable for an exact ticker. Publish it while the target is
      // fresh so the final POST path does not need another market lookup.
      prewarmRegularOrderExchangeIndex(preparedTicker, entry.exchangeIndex, entry.at);
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

      // Derive the conviction zone for THIS symbol.  Per-market overrides in
      // perMarketConvictionConfig take priority over the global settings; if no
      // override is set the global kalshiLockPrice/kalshiLockPriceCap apply.
      // MUST use the two-argument deriveConvictionZone(floor, cap) form to stay
      // consistent with kalshi-bot-tick.ts and the dispatch-callback sanity check.
      const _symZoneRaw = getEffectiveConvictionZone(sym, S.config);
      const { lockPrice, lockPriceCap } = deriveConvictionZone(
        _symZoneRaw.lockPrice,
        _symZoneRaw.lockPriceCap,
      );

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
          // Start (but do not await) an authenticated orderbook warmup.  A
          // zone dispatch is latency-sensitive; waiting here used to add the
          // complete 0.5–2 s authenticated round-trip before the tick began.
          // The strict ticker+freshness check in startOrderbookWarmup means a
          // late result is usable only for this exact prepared market.
          const pollerEntry = convictionPriceMap.get(sym);
          const obPrewarming = S.config.decisionMode === "conviction" && pollerEntry?.ticker
            ? startOrderbookWarmup(sym, pollerEntry.ticker, generation)
            : false;

          logger.info(
            {
              sym, windowKey,
              yesAsk: yesAsk != null ? +yesAsk.toFixed(4) : null,
              noAsk:  noAsk  != null ? +noAsk.toFixed(4)  : null,
              lockPrice, lockPriceCap,
              side: yesInZone ? "YES" : "NO",
              obCached: convictionObCache.has(sym),
              obPrewarming,
            },
            "[conviction-poller] zone entry — dispatching tick immediately",
          );
          const target = pollerEntry?.target;
          if (pollerEntry?.ticker && target != null && Number.isFinite(target) && target > 0) {
            callConvictionZoneEntry(sym, yesAsk, noAsk, pollerEntry.ticker, target);
          }
        }
        // ─────────────────────────────────────────────────────────────────────
      }
      // ─────────────────────────────────────────────────────────────────────
    }).catch((err) => {
      logger.warn({ err, sym }, "[conviction-poller] per-symbol market poll failed");
    });
  }
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

function pollOnce(): Promise<void> {
  return pollOnceImpl(pollerGeneration);
}

/**
 * Returns poller-sourced YES ask/bid for `sym` if the data is ≤ 1.5 s old.
 * Returns null when the poller has never run for this symbol or the data is stale.
 * Callers must fall back to getKalshiCachedData when this returns null.
 */
export function getConvictionLivePrice(sym: string): ConvictionLivePrice | null {
  const entry = getConvictionLivePriceSnapshot(sym);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CONVICTION_LIVE_PRICE_TTL_MS) return null;
  return entry;
}

/**
 * Returns the most recent poller snapshot without filtering on age.
 * Safety gates use this to distinguish "unavailable" from "present but stale"
 * and then enforce CONVICTION_LIVE_PRICE_TTL_MS themselves.
 */
export function getConvictionLivePriceSnapshot(sym: string): ConvictionLivePrice | null {
  return convictionPriceMap.get(sym.toUpperCase()) ?? null;
}

/**
 * Start the conviction price poller.  Idempotent — calling multiple times
 * while already running is a no-op.
 */
export function startConvictionPoller(): void {
  // conviction owns the shared tick map while active; never permit two writers.
  stopRegularSpotSampler();
  if (pollerHandle !== null) return;
  pollerGeneration += 1;
  convictionPriceTicks.clear();
  logger.info("[conviction-poller] starting target poll and dedicated 1 s spot sampler");
  pollerHandle = setInterval(() => {
    pollOnce().catch((err) =>
      logger.debug({ err }, "[conviction-poller] poll error (non-fatal)"),
    );
  }, POLL_INTERVAL_MS);
  spotSamplerHandle = setInterval(() => {
    sampleSpotsOnce().catch((err) =>
      logger.debug({ err }, "[conviction-poller] spot sample error (non-fatal)"),
    );
  }, POLL_INTERVAL_MS);
  // Fire immediately so the first bot tick after mode switch has fresh data.
  // Install the handle first: generation guards treat a missing handle as
  // stopped and must not discard this initial cycle.
  pollOnce().catch(() => {});
  sampleSpotsOnce().catch(() => {});
}

/**
 * Stop the conviction price poller.  Idempotent.
 */
export function stopConvictionPoller(): void {
  pollerGeneration += 1;
  if (pollerHandle !== null) clearInterval(pollerHandle);
  if (spotSamplerHandle !== null) clearInterval(spotSamplerHandle);
  pollerHandle = null;
  spotSamplerHandle = null;
  spotSamplesInFlight.clear();
  marketPollsInFlight.clear();
  convictionPriceMap.clear();
  orderbookWarmups.clear();
  tickFeedHealth.clear();
  convictionPriceTicks.clear();
  logger.info("[conviction-poller] stopped");
}

/**
 * Sync poller running state to the current bot decision mode.
 * Call after any config change that may have altered decisionMode, and once
 * at startup after loadBotConfigFromDB.
 */
export function syncConvictionPoller(): void {
  if (isPriceTriggeredDecisionMode(S.config.decisionMode)) {
    startConvictionPoller();
  } else {
    stopConvictionPoller();
    if (shouldRunRegularSpotSampler({
      enabled: S.config.enabled,
      paused: S.paused,
      botMode: S.botMode,
      decisionMode: S.config.decisionMode,
    })) {
      startRegularSpotSampler();
    } else {
      stopRegularSpotSampler();
    }
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
