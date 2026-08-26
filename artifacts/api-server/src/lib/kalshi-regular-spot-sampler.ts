import { CRYPTO_COINS, getTickerFreshEvidence } from "./crypto-data";
import { convictionPriceTicks } from "./kalshi-bot-state";
import { logger } from "./logger";
import {
  collectRegularEntrySpotSamples,
  shouldRunRegularSpotSampler,
} from "./kalshi-regular-spot-sampler-core";

export {
  collectRegularEntrySpotSamples,
  REGULAR_SPOT_SAMPLE_LIMIT,
  shouldRunRegularSpotSampler,
} from "./kalshi-regular-spot-sampler-core";

const SAMPLE_INTERVAL_MS = 1_000;
const WINDOW_MS = 15 * 60_000;

let samplerHandle: ReturnType<typeof setInterval> | null = null;
let samplerWindowStartMs: number | null = null;
let samplerGeneration = 0;
let sampleInFlight = false;

async function sampleOnce(): Promise<void> {
  if (sampleInFlight) return;
  sampleInFlight = true;
  const generation = samplerGeneration;
  const nowMs = Date.now();
  const windowStartMs = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  try {
    if (samplerWindowStartMs !== windowStartMs) {
      convictionPriceTicks.clear();
      samplerWindowStartMs = windowStartMs;
    }
    const nextSamples = new Map(
      [...convictionPriceTicks].map(([symbol, ticks]) => [symbol, [...ticks]]),
    );
    await collectRegularEntrySpotSamples({
      products: CRYPTO_COINS,
      fetchFresh: getTickerFreshEvidence,
      samples: nextSamples,
      nowMs,
      receiptClock: Date.now,
    });
    // A stop/mode transition may occur while network requests are in flight.
    // Never let that retired owner repopulate the shared map afterward.
    if (
      generation !== samplerGeneration
      || samplerHandle === null
      || samplerWindowStartMs !== windowStartMs
      || Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS !== windowStartMs
    ) return;
    convictionPriceTicks.clear();
    for (const [symbol, ticks] of nextSamples) {
      convictionPriceTicks.set(symbol, ticks);
    }
  } finally {
    sampleInFlight = false;
  }
}

export function startRegularSpotSampler(): void {
  if (samplerHandle !== null) return;
  // A new owner must never consume samples gathered under a prior mode/window.
  convictionPriceTicks.clear();
  samplerWindowStartMs = null;
  samplerGeneration += 1;
  samplerHandle = setInterval(() => {
    sampleOnce().catch((err) =>
      logger.debug({ err }, "[regular-spot-sampler] sample failed"),
    );
  }, SAMPLE_INTERVAL_MS);
  sampleOnce().catch(() => {});
  logger.info("[regular-spot-sampler] started 1 s regular-entry spot sampling");
}

export function stopRegularSpotSampler(): void {
  if (samplerHandle !== null) clearInterval(samplerHandle);
  samplerHandle = null;
  samplerWindowStartMs = null;
  samplerGeneration += 1;
  convictionPriceTicks.clear();
}

export function isRegularSpotSamplerRunning(): boolean {
  return samplerHandle !== null;
}