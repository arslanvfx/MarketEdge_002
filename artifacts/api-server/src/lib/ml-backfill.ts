// ML training-data backfill — runs automatically on startup when any coin's
// model has been reset (e.g. after an N_FEATURES bump) or when legacy
// backfill data is detected (v1 backfill had degenerate features).
//
// v1 backfill (prefix "backfill:") used window-open features only:
//   - elapsed = 0.05, priceVsStrike ≈ 0, windowDrift = 0 (always)
//   - The model could NOT react to intra-window price moves in live inference.
//
// v2 backfill (prefix "backfill_v2:") uses a mid-window snap (T+7min):
//   - elapsed ≈ 0.47, real priceVsStrike, real windowDrift
//   - Training distribution matches what the live endpoint actually sees.
//
// On startup: if any v1 rows exist → wipe ALL ML data → re-run v2 backfill.

import { generateMLTrainingExamples } from "./backtest.ts";
import {
  getAllMLStatus,
  backfillFromExamples,
  hasLegacyBackfillRows,
  clearMLData,
} from "./ml-store.ts";
import { MIN_TRAINING_WINDOWS } from "./ml-model.ts";
import { logger } from "./logger.ts";
import { CRYPTO_COINS } from "./crypto.ts";

/**
 * Check which coins are still warming and backfill them with historical data.
 * Also detects legacy (v1) backfill rows and forces a clean re-backfill.
 *
 * @param windowCount  Number of historical 15-min windows to replay per coin.
 *                     96 ≈ 24 h — enough to well exceed the 30-window gate.
 */
export async function runMLBackfillIfNeeded(windowCount = 96): Promise<void> {
  // ── Step 1: detect and purge legacy v1 backfill data ──────────────────────
  // v1 rows had priceVsStrike ≈ 0 and windowDrift = 0 for all examples,
  // which caused the model to ignore the most important live features.
  const hasLegacy = await hasLegacyBackfillRows();
  if (hasLegacy) {
    logger.warn(
      "[ml-backfill] legacy v1 backfill detected — wiping all ML data and re-initializing with improved features",
    );
    await clearMLData(); // wipes DB + in-memory; models reset to 0/30
    logger.info("[ml-backfill] ML state cleared — proceeding with v2 backfill");
  }

  // ── Step 2: decide which coins need backfilling ────────────────────────────
  const statuses = getAllMLStatus();
  const warmingCoins = statuses
    .filter((s) => s.windows < MIN_TRAINING_WINDOWS)
    .map((s) => s.symbol);

  // Coins not yet in coinState (new install or just cleared) always need fill.
  const seenSymbols = new Set(statuses.map((s) => s.symbol));
  for (const c of CRYPTO_COINS) {
    if (!seenSymbols.has(c.symbol)) warmingCoins.push(c.symbol);
  }

  if (warmingCoins.length === 0) {
    logger.info("[ml-backfill] all models ready — skipping backfill");
    return;
  }

  logger.info(
    { coins: warmingCoins, windowCount },
    "[ml-backfill] models warming — generating v2 historical training examples",
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

    // Per-coin result log.
    const afterStatuses = getAllMLStatus();
    for (const s of afterStatuses) {
      if (warmingCoins.includes(s.symbol)) {
        logger.info(
          { symbol: s.symbol, windows: s.windows, ready: s.ready },
          "[ml-backfill] coin backfilled (v2)",
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "[ml-backfill] backfill failed (non-fatal) — model will warm normally");
  }
}
