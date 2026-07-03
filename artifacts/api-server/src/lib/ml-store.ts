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
import { eq, sql } from "drizzle-orm";
import { initWeights, N_FEATURES, type MLPrediction } from "./ml-model.ts";
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
  resetAllState,
} from "./ml-core.ts";

// Re-export types that callers need
export type { MLPrediction };

/**
 * One labeled training example for ML backfill — features + outcome already
 * known (from a historical backtest replay rather than a live window).
 */
export interface MLTrainingExample {
  symbol:          string;
  windowId:        string;  // e.g. "backfill:BTC:2026-06-29T06:00:00.000Z"
  features:        number[]; // N_FEATURES-length vector
  outcome:         0 | 1;   // 1 = actual above kalshiTarget, 0 = below
  elapsedFraction: number;
}

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

/** Return training status for every coin that has been seen so far. */
export function getAllMLStatus() {
  return getAllStatus();
}

/**
 * Load pre-labeled training examples (from a historical backtest replay)
 * into both in-memory state and the DB.  Used during startup when the model
 * has been reset (e.g. after an N_FEATURES bump) to avoid waiting 30+ live
 * windows before predictions resume.
 *
 * The caller must ensure features.length === N_FEATURES — examples that
 * don't match are silently skipped by applyLabeledSnapshot.
 */
export async function backfillFromExamples(examples: MLTrainingExample[]): Promise<void> {
  if (examples.length === 0) return;

  // 1. Load into in-memory training state.
  const symbolsAffected = new Set<string>();
  for (const ex of examples) {
    applyLabeledSnapshot(ex.symbol, ex.features, ex.outcome);
    symbolsAffected.add(ex.symbol);
  }

  // 2. Persist to DB so the examples survive future restarts.
  //    Batch in chunks of 200 to stay within pg parameter limits.
  const now = new Date();
  const CHUNK = 200;
  for (let i = 0; i < examples.length; i += CHUNK) {
    const chunk = examples.slice(i, i + CHUNK);
    await db
      .insert(mlWindowSnapshotsTable)
      .values(
        chunk.map((ex) => ({
          symbol:          ex.symbol,
          windowId:        ex.windowId,
          snapshotAt:      now,
          elapsedFraction: String(ex.elapsedFraction),
          features:        ex.features,
          outcome:         ex.outcome,
        })),
      )
      .catch(() => {}); // non-fatal — in-memory state is already updated
  }

  // 3. Reconcile each coin's window count from loaded examples, retrain,
  //    and persist model weights so they survive a restart.
  for (const sym of symbolsAffected) {
    reconcileStateFromExamples(sym);
    const s = getCoinState(sym);
    if (s) await persistModelState(sym, s).catch(() => {});
  }
}

/**
 * Returns true if any legacy v1 backfill rows (windowId LIKE 'backfill:%')
 * exist in the DB.  These rows have degenerate features (elapsed=0.05, all
 * drift=0) that bias the model.  Used by runMLBackfillIfNeeded to trigger a
 * fresh re-backfill with improved mid-window features.
 */
export async function hasLegacyBackfillRows(): Promise<boolean> {
  try {
    const rows = await db
      .select({ n: mlWindowSnapshotsTable.id })
      .from(mlWindowSnapshotsTable)
      .where(sql`window_id LIKE 'backfill%' AND window_id NOT LIKE 'backfill_v3:%'`)
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Wipe all ML training state from both DB and in-memory store.
 * Called when stale/biased backfill data is detected so the model can
 * re-learn from scratch with properly-formed training examples.
 */
export async function clearMLData(): Promise<void> {
  await Promise.all([
    db.delete(mlWindowSnapshotsTable).catch(() => {}),
    db.delete(mlModelStateTable).catch(() => {}),
  ]);
  resetAllState();
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

    // N_FEATURES guard: if stored examples have a different feature count than
    // the current N_FEATURES (e.g. after a feature-vector bump), all those rows
    // will be silently ignored by applyLabeledSnapshot — the model would then
    // restart from zero and re-backfill unnecessarily.  Detect this up-front:
    // find the first row with a non-empty feature array and compare its length.
    // If it doesn't match, wipe all ML data now; runMLBackfillIfNeeded will
    // re-seed from scratch with the correct N_FEATURES on the same startup.
    const firstWithFeatures = snapshots.find(r => Array.isArray(r.features) && (r.features as number[]).length > 0);
    if (firstWithFeatures) {
      const storedLen = (firstWithFeatures.features as number[]).length;
      if (storedLen !== N_FEATURES) {
        console.warn(
          `[ml-store] N_FEATURES mismatch: DB snapshots have ${storedLen} features but current N_FEATURES=${N_FEATURES}. Wiping ML data — backfill will re-seed with correct feature count.`,
        );
        await clearMLData();
        return; // runMLBackfillIfNeeded will run immediately after this call
      }
    }

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
