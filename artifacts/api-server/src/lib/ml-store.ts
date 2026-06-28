// ML pipeline orchestrator.
//
// Responsibilities:
//   captureMLSnapshot()       — store a feature vector for the active window
//   labelWindowAndRetrain()   — mark outcome when window closes, retrain model
//   getMLPrediction()         — run inference on current live features
//   getMLStatus()             — return training status for a coin
//   initMLFromDB()            — reload labeled examples + weights on startup
//
// Persistence: labeled snapshots and model weights are written to PostgreSQL
// so nothing is lost across server restarts.
//
// Pure in-memory state lives in ml-core.ts (fully unit-testable without DB).

import { db, mlWindowSnapshotsTable, mlModelStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { initWeights, type MLPrediction } from "./ml-model.ts";
import {
  applyHydratedModel,
  applyLabeledSnapshot,
  applyPendingSnapshot,
  reconcileStateFromExamples,
  captureSnapshot,
  labelAndRetrain,
  getPrediction,
  getStatus,
  getAllStatus,
  getCoinState,
} from "./ml-core.ts";

// Re-export types that callers need
export type { MLPrediction };

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a feature snapshot for `windowId`.  Called once per window at
 * prediction-snap time (~T+30-60s into the window).
 */
export function captureMLSnapshot(
  symbol:          string,
  windowId:        string,   // targetTime ISO
  features:        number[],
  elapsedFraction: number,
): void {
  const captured = captureSnapshot(symbol, windowId, features, elapsedFraction);
  if (!captured) return; // already captured this window

  // Persist snapshot to DB (outcome filled later by labelWindowAndRetrain)
  db.insert(mlWindowSnapshotsTable)
    .values({
      symbol,
      windowId,
      snapshotAt:      new Date(),
      elapsedFraction: String(elapsedFraction),
      features,
      outcome:         null,
    })
    .onConflictDoNothing()
    .catch(() => {});
}

/**
 * Label a resolved window with its actual outcome, add to training set,
 * retrain the model.  Called right after a stat record is evaluated.
 *
 * @param outcome  1 if actual price was ≥ kalshiTarget, else 0
 */
export function labelWindowAndRetrain(
  symbol:   string,
  windowId: string,
  outcome:  0 | 1,
): void {
  const snap = labelAndRetrain(symbol, windowId, outcome);
  if (!snap) return; // no snapshot for this window

  // Update DB snapshot outcome
  db.update(mlWindowSnapshotsTable)
    .set({ outcome })
    .where(eq(mlWindowSnapshotsTable.windowId, windowId))
    .catch(() => {});

  // Persist updated model weights
  const s = getCoinState(symbol);
  if (s) persistModelState(symbol, s).catch(() => {});
}

/** Get current ML prediction for the live feature vector. */
export function getMLPrediction(symbol: string, features: number[]): {
  prediction:  MLPrediction | null;
  windows:     number;
  samples:     number;
  ready:       boolean;
  minWindows:  number;
  valAccuracy: number | null;
} {
  return getPrediction(symbol, features);
}

/** Return current training status for a coin (for status endpoint). */
export function getMLStatus(symbol: string) {
  return getStatus(symbol);
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function persistModelState(
  symbol: string,
  s: { examples: { features: number[]; label: number }[]; windows: number; weights: number[]; valAcc: number | null },
): Promise<void> {
  await db
    .insert(mlModelStateTable)
    .values({
      symbol,
      weights:         s.weights,
      trainingSamples: s.examples.length,
      labeledWindows:  s.windows,
      lastTrainedAt:   new Date(),
      valAccuracy:     s.valAcc != null ? String(s.valAcc) : null,
    })
    .onConflictDoUpdate({
      target: mlModelStateTable.symbol,
      set: {
        weights:         s.weights,
        trainingSamples: s.examples.length,
        labeledWindows:  s.windows,
        lastTrainedAt:   new Date(),
        valAccuracy:     s.valAcc != null ? String(s.valAcc) : null,
        updatedAt:       new Date(),
      },
    });
}

/**
 * Load persisted labeled snapshots and model weights on server startup.
 * Called once from startPredictionTracker() before the first tick.
 *
 * After this call, any coin that has accumulated ≥ MIN_TRAINING_WINDOWS
 * labeled windows will immediately serve predictions — no wait needed.
 */
export async function initMLFromDB(): Promise<void> {
  try {
    // 1. Restore model weights first (fast — one row per coin).
    //    This gives the model working weights immediately so predictions
    //    are available as soon as the window count gate is met.
    const savedModels = await db.select().from(mlModelStateTable);
    for (const row of savedModels) {
      applyHydratedModel(
        row.symbol,
        (row.weights as number[]) ?? initWeights(),
        row.labeledWindows ?? 0,
        row.valAccuracy != null ? Number(row.valAccuracy) : null,
      );
    }

    // 2. Restore labeled training examples so the model can retrain
    //    incrementally after restart without starting from zero.
    const snapshots = await db
      .select()
      .from(mlWindowSnapshotsTable)
      .orderBy(mlWindowSnapshotsTable.snapshotAt);

    let labeledCount = 0;
    let pendingCount = 0;
    for (const row of snapshots) {
      const features = row.features as number[];
      if (row.outcome === null) {
        // Restore unlabeled snapshot to pending so post-restart labeling works.
        applyPendingSnapshot(
          row.symbol,
          row.windowId,
          features,
          new Date(row.snapshotAt).getTime(),
          Number(row.elapsedFraction),
        );
        pendingCount++;
      } else {
        applyLabeledSnapshot(row.symbol, features, row.outcome as 0 | 1);
        labeledCount++;
      }
    }

    // 3. Reconcile each coin's state against its labeled snapshots.
    //    This covers two failure modes:
    //      a) ml_model_state row was absent (first run / corrupt) → derive
    //         windows from example count and retrain so predictions surface
    //         immediately without waiting for 30 new windows.
    //      b) labeled_windows in model_state diverges from snapshot count
    //         (partial write / race) → use examples as source of truth.
    //    In the normal case (counts match) this is a fast no-op.
    const coinSymbols = new Set<string>(
      (await db.select({ symbol: mlWindowSnapshotsTable.symbol }).from(mlWindowSnapshotsTable))
        .map(r => r.symbol),
    );
    for (const sym of coinSymbols) {
      const r = reconcileStateFromExamples(sym);
      if (r.wasInconsistent) {
        console.info(`[ml-store] reconciled ${sym}: windows set to ${r.windows} from labeled snapshots (retrained)`);
      }
    }

    // 4. Log hydration summary — shows which coins are immediately ready
    //    (predictions available right now) vs still accumulating data.
    const allStatus = getAllStatus();
    const readyCoins  = allStatus.filter(c => c.ready).map(c => `${c.symbol}(${c.valAccuracy ?? "?"}%)`);
    const warmingCoins = allStatus.filter(c => !c.ready).map(c => `${c.symbol}(${c.windows}/${30})`);

    console.info(
      `[ml-store] hydrated ${savedModels.length} models, ${labeledCount} labeled + ${pendingCount} pending snapshots` +
      (readyCoins.length  ? `; ready: ${readyCoins.join(", ")}`          : "") +
      (warmingCoins.length ? `; warming: ${warmingCoins.join(", ")}`      : ""),
    );
  } catch (err) {
    console.warn("[ml-store] initMLFromDB failed (non-fatal):", err);
  }
}
