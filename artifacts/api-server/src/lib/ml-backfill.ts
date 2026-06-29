// ML training-data backfill — runs automatically on startup when any coin's
// model has been reset (e.g. after an N_FEATURES version bump).
//
// Replays historical 15-min windows via the backtest harness, generates a
// 14-feature vector for each window, and injects the labeled examples into
// the in-memory training set + DB.  After backfill, models that were warming
// at 0/30 will immediately show predictions (≥30 windows).
//
// The guard is simple: if a coin already has ≥ MIN_TRAINING_WINDOWS examples
// in memory after initMLFromDB(), we skip it — no double-write possible.

import { generateMLTrainingExamples } from "./backtest.ts";
import { getAllMLStatus, backfillFromExamples } from "./ml-store.ts";
import { MIN_TRAINING_WINDOWS } from "./ml-model.ts";
import { logger } from "./logger.ts";
import { CRYPTO_COINS } from "./crypto.ts";

/**
 * Check which coins are still warming and backfill them with historical data.
 *
 * @param windowCount  Number of historical 15-min windows to replay per coin.
 *                     96 ≈ 24 h — enough to well exceed the 30-window gate.
 */
export async function runMLBackfillIfNeeded(windowCount = 96): Promise<void> {
  const statuses = getAllMLStatus();
  const warmingCoins = statuses
    .filter((s) => s.windows < MIN_TRAINING_WINDOWS)
    .map((s) => s.symbol);

  // Also include coins that have no status yet (never seen any data).
  // These won't appear in getAllMLStatus() until their first snapshot.
  const allSymbols = new Set(CRYPTO_COINS.map((c) => c.symbol));
  const seenSymbols = new Set(statuses.map((s) => s.symbol));
  for (const sym of allSymbols) {
    if (!seenSymbols.has(sym)) warmingCoins.push(sym);
  }

  if (warmingCoins.length === 0) {
    logger.info("[ml-backfill] all models ready — skipping backfill");
    return;
  }

  logger.info(
    { coins: warmingCoins, windowCount },
    "[ml-backfill] models warming — generating historical training examples",
  );

  try {
    const examples = await generateMLTrainingExamples({
      coins: warmingCoins,
      windows: windowCount,
    });

    if (examples.length === 0) {
      logger.warn("[ml-backfill] no examples generated — check Coinbase data availability");
      return;
    }

    await backfillFromExamples(examples);

    // Log per-coin result.
    const afterStatuses = getAllMLStatus();
    for (const s of afterStatuses) {
      if (warmingCoins.includes(s.symbol)) {
        logger.info(
          { symbol: s.symbol, windows: s.windows, ready: s.ready },
          "[ml-backfill] coin backfilled",
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "[ml-backfill] backfill failed (non-fatal) — model will warm normally");
  }
}
