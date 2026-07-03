// ML training-data backfill — runs automatically on startup when any coin's
// model has been reset (e.g. after an N_FEATURES bump) or when legacy
// backfill data is detected (v1/v2 backfill had degenerate or incomplete features).
//
// v1 backfill (prefix "backfill:") used window-open features only:
//   - elapsed = 0.05, priceVsStrike ≈ 0, windowDrift = 0 (always)
//   - The model could NOT react to intra-window price moves in live inference.
//
// v2 backfill (prefix "backfill_v2:") uses a mid-window snap (T+7min):
//   - elapsed ≈ 0.47, real priceVsStrike, real windowDrift
//   - 14-feature vector — no stat/claude/wm signals (features 14-16 absent).
//
// v3 backfill (prefix "backfill_v3:") extends v2 to 17 features:
//   - Features 14-15 populated from prediction_records (stat/claude directions).
//   - Feature 16 = 0.5 (window-monitor not available in historical records).
//   - Training distribution now matches inference (ML sees real model signals).
//
// On startup: if any v1/v2 rows exist → wipe ALL ML data → re-run v3 backfill.

import { generateMLTrainingExamples } from "./backtest.ts";
import {
  getAllMLStatus,
  backfillFromExamples,
  hasLegacyBackfillRows,
  clearMLData,
} from "./ml-store.ts";
import { MIN_TRAINING_WINDOWS, N_FEATURES } from "./ml-model.ts";
import { applySignalAugmentation } from "./ml-features.ts";
import { logger } from "./logger.ts";
import { CRYPTO_COINS } from "./crypto.ts";
import { db, predictionRecordsTable } from "@workspace/db";
import { and, inArray, isNotNull } from "drizzle-orm";

/**
 * Check which coins are still warming and backfill them with historical data.
 * Also detects legacy (v1/v2) backfill rows and forces a clean re-backfill.
 *
 * @param windowCount  Number of historical 15-min windows to replay per coin.
 *                     96 ≈ 24 h — enough to well exceed the 30-window gate.
 */
export async function runMLBackfillIfNeeded(windowCount = 96): Promise<void> {
  // ── Step 1: detect and purge legacy v1/v2 backfill data ───────────────────
  // v1 rows had degenerate features; v2 rows lacked stat/claude signals (14 vs 17).
  // Both are detected by hasLegacyBackfillRows (NOT LIKE 'backfill_v3:%').
  const hasLegacy = await hasLegacyBackfillRows();
  if (hasLegacy) {
    logger.warn(
      "[ml-backfill] legacy v1/v2 backfill detected — wiping all ML data and re-initializing with v3 features",
    );
    await clearMLData(); // wipes DB + in-memory; models reset to 0/30
    logger.info("[ml-backfill] ML state cleared — proceeding with v3 backfill");
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
    "[ml-backfill] models warming — generating v3 historical training examples",
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

    // ── Step 3: augment features 14-16 from prediction_records ───────────────
    // The candle-replay backtest can't know what stat/claude predicted for each
    // historical window. We look them up in prediction_records (source=stat/claude)
    // and encode their directions as features 14-15. Feature 16 (wmRec) stays at
    // 0.5 because the window-monitor recommendation is not stored historically.
    //
    // windowId format: "backfill_v3:SYM:2026-06-29T06:00:00.000Z"
    // Split on ':' gives ["backfill_v3", "SYM", "2026-06-29T06", "00", "00.000Z"]
    // — rejoin parts 2+ to reconstruct the ISO date.
    try {
      const predRows = await db
        .select({
          symbol: predictionRecordsTable.symbol,
          targetTime: predictionRecordsTable.targetTime,
          source: predictionRecordsTable.source,
          predictedPrice: predictionRecordsTable.predictedPrice,
          kalshiTarget: predictionRecordsTable.kalshiTarget,
        })
        .from(predictionRecordsTable)
        .where(and(
          inArray(predictionRecordsTable.source, ["stat", "claude"]),
          isNotNull(predictionRecordsTable.kalshiTarget),
        ));

      // Key the map by window OPEN time because that's what r.windowIso records.
      // prediction_records.targetTime = window close (open + 15 min), so subtract.
      type SignalEntry = { statAbove: boolean | null; claudeAbove: boolean | null };
      const signalMap = new Map<string, SignalEntry>();
      for (const row of predRows) {
        const windowOpenMs = new Date(row.targetTime).getTime() - 15 * 60 * 1000;
        const key = `${row.symbol}:${new Date(windowOpenMs).toISOString()}`;
        if (!signalMap.has(key)) signalMap.set(key, { statAbove: null, claudeAbove: null });
        const entry = signalMap.get(key)!;
        if (row.kalshiTarget != null && row.predictedPrice != null) {
          const target = Number(row.kalshiTarget);
          const pred = Number(row.predictedPrice);
          const pct = target > 0 ? ((pred - target) / target) * 100 : 0;
          const above: boolean | null = pct > 0.05 ? true : pct < -0.05 ? false : null;
          if (row.source === "stat") entry.statAbove = above;
          else if (row.source === "claude") entry.claudeAbove = above;
        }
      }

      // generateMLTrainingExamples already calls extractMLFeatures (N_FEATURES elements),
      // with the last 3 slots = 0.5 (unknown stat/claude/wm signals).
      // We OVERWRITE those 3 slots with real historical values — never push.
      let augmented = 0;
      for (const ex of examples) {
        if (ex.features.length !== N_FEATURES) continue; // defensive: skip malformed
        // Reconstruct targetISO from windowId: "backfill_v3:SYM:ISO"
        const parts = ex.windowId.split(":");
        const targetISO = parts.slice(2).join(":");
        const key = `${ex.symbol}:${targetISO}`;
        const sig = signalMap.get(key);
        applySignalAugmentation(ex.features, sig?.statAbove, sig?.claudeAbove);
        if (sig?.statAbove != null || sig?.claudeAbove != null) augmented++;
      }
      logger.info(
        { total: examples.length, withSignals: augmented },
        "[ml-backfill] augmented examples with historical stat/claude signals",
      );
    } catch (augErr) {
      // Augmentation failure is non-fatal: features 14-16 remain 0.5 (already set
      // by extractMLFeatures defaults). Log and continue — model still trains on
      // features 0-13 plus the neutral synthesis placeholders.
      logger.warn({ err: augErr }, "[ml-backfill] stat/claude augmentation failed — features 14-16 stay at 0.5");
    }

    await backfillFromExamples(examples);

    // Per-coin result log.
    const afterStatuses = getAllMLStatus();
    for (const s of afterStatuses) {
      if (warmingCoins.includes(s.symbol)) {
        logger.info(
          { symbol: s.symbol, windows: s.windows, ready: s.ready },
          "[ml-backfill] coin backfilled (v3)",
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "[ml-backfill] backfill failed (non-fatal) — model will warm normally");
  }
}
