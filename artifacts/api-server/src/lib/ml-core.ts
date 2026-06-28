// Pure in-memory ML state management — no DB imports.
//
// This module owns the CoinState map and all mutations to it.
// ml-store.ts is the DB-connected orchestrator that calls these functions
// and handles persistence.  Keeping the state logic here makes it fully
// unit-testable without a live database.

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
} from "./ml-model.ts";

export { MIN_TRAINING_WINDOWS };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingWindow {
  features:        number[];
  snapshotAt:      number;    // unix ms
  elapsedFraction: number;
}

export interface CoinState {
  pending:  Map<string, PendingWindow>; // windowId → unlabeled snapshot
  examples: TrainingExample[];          // all labeled training examples
  windows:  number;                     // count of labeled windows
  weights:  Weights;
  valAcc:   number | null;
}

// ── In-memory store ───────────────────────────────────────────────────────────

const coinState = new Map<string, CoinState>();

export function getOrCreate(symbol: string): CoinState {
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

/** Reset all coin state (used in tests to start fresh). */
export function resetAllState(): void {
  coinState.clear();
}

// ── Hydration helpers (called by initMLFromDB on startup) ─────────────────────

/**
 * Apply a persisted model row to in-memory state.
 * This restores weights + window count so predictions resume immediately.
 */
export function applyHydratedModel(
  symbol:  string,
  weights: number[],
  windows: number,
  valAcc:  number | null,
): void {
  const s    = getOrCreate(symbol);
  s.weights  = weights.length === N_FEATURES + 1 ? weights : initWeights();
  s.windows  = windows;
  s.valAcc   = valAcc;
}

/**
 * Apply a labeled snapshot row from the DB to the in-memory training set.
 */
export function applyLabeledSnapshot(
  symbol:   string,
  features: number[],
  label:    0 | 1,
): void {
  if (features.length !== N_FEATURES) return;
  const s = getOrCreate(symbol);
  s.examples.push({ features, label });
}

/**
 * Apply an unlabeled snapshot row from the DB to the pending map.
 * This ensures post-restart labeling still works for in-flight windows.
 */
export function applyPendingSnapshot(
  symbol:          string,
  windowId:        string,
  features:        number[],
  snapshotAt:      number,
  elapsedFraction: number,
): void {
  if (features.length !== N_FEATURES) return;
  const s = getOrCreate(symbol);
  if (!s.pending.has(windowId)) {
    s.pending.set(windowId, { features, snapshotAt, elapsedFraction });
  }
}

/**
 * Post-hydration reconciliation — called once per coin in initMLFromDB after
 * all DB rows are applied.
 *
 * Handles two failure modes that would otherwise leave the model dark:
 *   1. ml_model_state row is absent (new install, corrupt write, first run):
 *      windows=0 but examples>0 → derive windows from example count, retrain.
 *   2. ml_model_state.labeled_windows diverges from snapshot count (partial
 *      write, race): use examples.length as the ground truth, retrain.
 *
 * In the normal case (windows === examples.length) this is a no-op.
 *
 * Returns whether a retrain was performed and the authoritative window count.
 */
export function reconcileStateFromExamples(symbol: string): {
  retrained:       boolean;
  windows:         number;
  wasInconsistent: boolean;
} {
  const s            = getOrCreate(symbol);
  const exampleCount = s.examples.length;

  // No data to reconcile.
  if (exampleCount === 0) {
    return { retrained: false, windows: s.windows, wasInconsistent: false };
  }

  const wasInconsistent = s.windows !== exampleCount;
  if (wasInconsistent) {
    // Use labeled snapshot count as authoritative source of truth.
    s.windows        = exampleCount;
    const newWeights = trainModel(s.weights, s.examples);
    s.valAcc         = evalAccuracy(newWeights, s.examples.slice(-200));
    s.weights        = newWeights;
    return { retrained: true, windows: s.windows, wasInconsistent: true };
  }

  return { retrained: false, windows: s.windows, wasInconsistent: false };
}

// ── Snapshot lifecycle ────────────────────────────────────────────────────────

/**
 * Record a new feature snapshot for `windowId`.
 * Returns false if the window was already captured (idempotent).
 */
export function captureSnapshot(
  symbol:          string,
  windowId:        string,
  features:        number[],
  elapsedFraction: number,
): boolean {
  if (features.length !== N_FEATURES) return false;
  const s = getOrCreate(symbol);
  if (s.pending.has(windowId)) return false;
  s.pending.set(windowId, { features, snapshotAt: Date.now(), elapsedFraction });
  return true;
}

/**
 * Label a pending window, add it to the training set, and retrain.
 * Returns the pending snapshot that was labeled, or null if not found.
 */
export function labelAndRetrain(
  symbol:   string,
  windowId: string,
  outcome:  0 | 1,
): PendingWindow | null {
  const s    = getOrCreate(symbol);
  const snap = s.pending.get(windowId);
  if (!snap) return null;

  s.pending.delete(windowId);
  s.examples.push({ features: snap.features, label: outcome });
  s.windows++;

  const newWeights = trainModel(s.weights, s.examples);
  s.valAcc         = evalAccuracy(newWeights, s.examples.slice(-200));
  s.weights        = newWeights;

  return snap;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/** Get current ML prediction for a live feature vector. */
export function getPrediction(symbol: string, features: number[]): {
  prediction:  MLPrediction | null;
  windows:     number;
  samples:     number;
  ready:       boolean;
  minWindows:  number;
  valAccuracy: number | null;
} {
  const s     = getOrCreate(symbol);
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

/** Return training status for a coin (for status/debug endpoints). */
export function getStatus(symbol: string) {
  const s = coinState.get(symbol);
  if (!s) {
    return { windows: 0, samples: 0, ready: false, minWindows: MIN_TRAINING_WINDOWS, valAccuracy: null };
  }
  return {
    windows:     s.windows,
    samples:     s.examples.length,
    ready:       s.windows >= MIN_TRAINING_WINDOWS,
    minWindows:  MIN_TRAINING_WINDOWS,
    valAccuracy: s.valAcc != null ? Math.round(s.valAcc * 100) : null,
  };
}

/** Return a summary of all tracked coins — used in startup log and status endpoints. */
export function getAllStatus(): Array<{ symbol: string; windows: number; ready: boolean; valAccuracy: number | null }> {
  return Array.from(coinState.entries()).map(([symbol, s]) => ({
    symbol,
    windows:     s.windows,
    ready:       s.windows >= MIN_TRAINING_WINDOWS,
    valAccuracy: s.valAcc != null ? Math.round(s.valAcc * 100) : null,
  }));
}

/** Return current weights for a given coin (for DB persistence). */
export function getCoinState(symbol: string): CoinState | undefined {
  return coinState.get(symbol);
}
