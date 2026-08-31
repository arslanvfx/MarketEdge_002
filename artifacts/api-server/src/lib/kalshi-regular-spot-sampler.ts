import { CRYPTO_COINS, getTickerFreshEvidence } from "./crypto-data";
import { convictionPriceTicks } from "./kalshi-bot-state";
import { logger } from "./logger";
import {
  collectRegularEntrySpotSample,
  collectRegularEntrySpotSamples,
  isRegularSpotSampleOwnerActive,
  shouldRunRegularSpotSampler,
} from "./kalshi-regular-spot-sampler-core";
import { PerKeyInFlight } from "./per-key-in-flight";
import {
  recordRegularSpotFetchAttempt,
  recordRegularSpotFetchFailure,
  recordRegularSpotFetchSuccess,
} from "./kalshi-regular-spot-telemetry";

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
const samplesInFlight = new PerKeyInFlight();

async function sampleOnce(): Promise<void> {
  const nowMs = Date.now();
  const windowStartMs = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  if (samplerWindowStartMs !== windowStartMs) {
    // Invalidate all prior-window callbacks before allowing the new owner to
    // launch, then clear only once at the window boundary.
    samplerGeneration += 1;
    samplesInFlight.clear();
    convictionPriceTicks.clear();
    samplerWindowStartMs = windowStartMs;
  }
  const generation = samplerGeneration;

  for (const product of CRYPTO_COINS) {
    const symbol = product.symbol.toUpperCase();
    void samplesInFlight.run(symbol, async () => {
      recordRegularSpotFetchAttempt(symbol, product.product, Date.now());
      const symbolSamples = new Map([
        [symbol, [...(convictionPriceTicks.get(symbol) ?? [])]],
      ]);
      try {
        await collectRegularEntrySpotSample({
          product,
          fetchFresh: getTickerFreshEvidence,
          samples: symbolSamples,
          nowMs,
          receiptClock: Date.now,
        });
      } catch (err) {
        recordRegularSpotFetchFailure({
          symbol,
          product: product.product,
          atMs: Date.now(),
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      // Publish this symbol immediately. A slow unrelated product cannot delay
      // it, while retired mode/window owners remain unable to repopulate state.
      if (!isRegularSpotSampleOwnerActive({
        capturedGeneration: generation,
        currentGeneration: samplerGeneration,
        samplerRunning: samplerHandle !== null,
        capturedWindowStartMs: windowStartMs,
        currentWindowStartMs: samplerWindowStartMs,
        clockWindowStartMs: Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS,
      })) return;
      const ticks = symbolSamples.get(symbol);
      if (ticks) {
        convictionPriceTicks.set(symbol, ticks);
        recordRegularSpotFetchSuccess({
          symbol,
          product: product.product,
          atMs: Date.now(),
          publishedAtMs: ticks[ticks.length - 1]?.oraclePublishedAtMs ?? null,
        });
      }
    }).catch((err) =>
      logger.debug({ err, symbol }, "[regular-spot-sampler] symbol sample failed"),
    );
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
  samplesInFlight.clear();
  convictionPriceTicks.clear();
}

export function isRegularSpotSamplerRunning(): boolean {
  return samplerHandle !== null;
}