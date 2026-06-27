// ML pipeline orchestrator.
//
// Responsibilities:
//   captureMLSnapshot()       — store a feature vector for the active window
//   labelWindowAndRetrain()   — mark outcome when window closes, retrain model
//   getMLPrediction()         — run inference on current live features
//   initMLFromDB()            — reload labeled examples + weights on startup
//
// Persistence: labeled snapshots and model weights are written to PostgreSQL
// so nothing is lost across server restarts.

import { db, mlWindowSnapshotsTable, mlModelStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  N_FEATURES,
  MIN_TRAINING_WINDOWS,
  initWeights,
  trainModel,
  evalAccuracy,
  predict,
  type Weights,
  type TrainingExample,
  type MLPrediction,
} from "./ml-model";

// ── In-memory state ──────────────────────────────────────────────────────────

interface PendingWindow {
  features: number[];   // snapshot taken at window open
  snapshotAt: number;   // unix ms
  elapsedFraction: number;
}

interface CoinState {
  pending:  Map<string, PendingWindow>; // windowId → snapshot (not yet labeled)
  examples: TrainingExample[];          // all labeled examples for this coin
  windows:  number;                     // count of labeled windows
  weights:  Weights;
  valAcc:   number | null;
}

const coinState = new Map<string, CoinState>();

function getOrCreate(symbol: string): CoinState {
  if (!coinState.has(symbol)) {
    coinState.set(symbol, {
      pending:  new Map(),
      examples: [],
      windows:  0,
      weights:  initWeights(),
      valAcc:   null,
    });
  }
  return coinState.get(symbol)!;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a feature snapshot for `windowId`.  Called once per window at
 * prediction-snap time (~T+30-60s into the window).
 */
export function captureMLSnapshot(
  symbol:         string,
  windowId:       string,   // targetTime ISO
  features:       number[],
  elapsedFraction: number,
): void {
  if (features.length !== N_FEATURES) return;
  const s = getOrCreate(symbol);
  if (s.pending.has(windowId)) return; // already captured this window
  s.pending.set(windowId, { features, snapshotAt: Date.now(), elapsedFraction });

  // Persist snapshot to DB (outcome filled later)
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
  const s = getOrCreate(symbol);
  const snap = s.pending.get(windowId);
  if (!snap) return;                      // no snapshot for this window

  // Move from pending → labeled training set
  s.pending.delete(windowId);
  s.examples.push({ features: snap.features, label: outcome });
  s.windows++;

  // Update DB snapshot outcome
  db.update(mlWindowSnapshotsTable)
    .set({ outcome })
    .where(eq(mlWindowSnapshotsTable.windowId, windowId))
    .catch(() => {});

  // Retrain
  const newWeights = trainModel(s.weights, s.examples);
  // Eval on last 200 examples (out-of-bag would be better but this is fast)
  s.valAcc   = evalAccuracy(newWeights, s.examples.slice(-200));
  s.weights  = newWeights;

  // Persist model state
  persistModelState(symbol, s).catch(() => {});
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
  const s = getOrCreate(symbol);
  const ready = s.windows >= MIN_TRAINING_WINDOWS;
  return {
    prediction:  ready ? predict(s.weights, features) : null,
    windows:     s.windows,
    samples:     s.examples.length,
    ready,
    minWindows:  MIN_TRAINING_WINDOWS,
    valAccuracy: s.valAcc != null ? Math.round(s.valAcc * 100) : null,
  };
}

/** Return current training status for a coin (for status endpoint). */
export function getMLStatus(symbol: string) {
  const s = coinState.get(symbol);
  if (!s) return { windows: 0, samples: 0, ready: false, minWindows: MIN_TRAINING_WINDOWS, valAccuracy: null };
  return {
    windows:     s.windows,
    samples:     s.examples.length,
    ready:       s.windows >= MIN_TRAINING_WINDOWS,
    minWindows:  MIN_TRAINING_WINDOWS,
    valAccuracy: s.valAcc != null ? Math.round(s.valAcc * 100) : null,
  };
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function persistModelState(symbol: string, s: CoinState): Promise<void> {
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
 */
export async function initMLFromDB(): Promise<void> {
  try {
    // Restore model weights (fast)
    const savedModels = await db.select().from(mlModelStateTable);
    for (const row of savedModels) {
      const s = getOrCreate(row.symbol);
      s.weights  = (row.weights as number[]) ?? initWeights();
      s.windows  = row.labeledWindows ?? 0;
      s.valAcc   = row.valAccuracy != null ? Number(row.valAccuracy) : null;
    }

    // Restore labeled training examples (slow on first load — runs once)
    const snapshots = await db
      .select()
      .from(mlWindowSnapshotsTable)
      .orderBy(mlWindowSnapshotsTable.snapshotAt);

    for (const row of snapshots) {
      if (row.outcome === null) continue;  // unlabeled — skip
      const s = getOrCreate(row.symbol);
      const features = row.features as number[];
      if (!Array.isArray(features) || features.length !== N_FEATURES) continue;
      s.examples.push({ features, label: row.outcome });
    }

    console.info(`[ml-store] loaded ${savedModels.length} models, ${snapshots.filter(r => r.outcome !== null).length} labeled snapshots`);
  } catch (err) {
    console.warn("[ml-store] initMLFromDB failed (non-fatal):", err);
  }
}
