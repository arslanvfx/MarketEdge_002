// Online logistic regression for binary ABOVE/BELOW prediction.
//
// Trained after every resolved 15-min window.  Weights are persisted to DB
// so the model survives server restarts and never loses what it learned.
//
// Design notes:
//   - Pure functions — all state lives in the caller (ml-store.ts).
//   - L2 regularization prevents weight blow-up on small datasets.
//   - SGD shuffle + multiple epochs converge reliably for N<10k examples.
//   - MIN_TRAINING_WINDOWS = 30 keeps the model silent while data is thin.

export const N_FEATURES       = 17;
export const MIN_TRAINING_WINDOWS = 30;  // windows before predictions surface

const LEARNING_RATE = 0.05;
const L2_LAMBDA     = 0.01;
const EPOCHS        = 25;          // passes per retrain
const MAX_EXAMPLES  = 6_000;       // sliding window — discard very old data

export interface MLPrediction {
  above:      boolean;
  prob:       number;   // raw sigmoid output, 0→1
  confidence: number;   // 50→100 for UI display
}

export interface TrainingExample {
  features: number[];  // length === N_FEATURES
  label:    number;    // 1 = actual above strike, 0 = below
}

/** [bias, w1, …, w14] — length N_FEATURES + 1 */
export type Weights = number[];

export function initWeights(): Weights {
  return new Array<number>(N_FEATURES + 1).fill(0);
}

function sigmoid(z: number): number {
  if (z >  500) return 1 - 1e-9;
  if (z < -500) return 1e-9;
  return 1 / (1 + Math.exp(-z));
}

function forward(w: Weights, f: number[]): number {
  let z = w[0];
  for (let i = 0; i < N_FEATURES; i++) z += w[i + 1] * f[i];
  return sigmoid(z);
}

/** One full pass over shuffled examples, mutates and returns w. */
function runEpoch(w: Weights, examples: TrainingExample[]): Weights {
  const out = [...w];
  // Fisher–Yates shuffle copy
  const idx = examples.map((_, i) => i).sort(() => Math.random() - 0.5);
  for (const i of idx) {
    const { features: f, label: y } = examples[i];
    const p   = forward(out, f);
    const err = p - y;
    out[0] -= LEARNING_RATE * err;  // bias — no L2
    for (let j = 0; j < N_FEATURES; j++) {
      out[j + 1] = out[j + 1] * (1 - LEARNING_RATE * L2_LAMBDA)
                 - LEARNING_RATE * err * f[j];
    }
  }
  return out;
}

/**
 * Retrain from scratch on `examples`.
 * Uses the most recent MAX_EXAMPLES to avoid infinite drift on very long runs.
 */
export function trainModel(
  initW:    Weights,
  examples: TrainingExample[],
): Weights {
  if (examples.length === 0) return initW;
  const subset = examples.slice(-MAX_EXAMPLES);
  let w = [...initW];
  for (let e = 0; e < EPOCHS; e++) w = runEpoch(w, subset);
  return w;
}

/** Fraction of examples correctly classified by weights. */
export function evalAccuracy(w: Weights, examples: TrainingExample[]): number {
  if (examples.length === 0) return 0;
  let hits = 0;
  for (const { features: f, label: y } of examples) {
    if ((forward(w, f) >= 0.5 ? 1 : 0) === y) hits++;
  }
  return hits / examples.length;
}

/** Predict direction + confidence for a live feature vector. */
export function predict(w: Weights, features: number[]): MLPrediction {
  const prob  = forward(w, features);
  const above = prob >= 0.5;
  // Map [0.5, 1.0] symmetrically onto [50, 100] for display.
  const confidence = Math.round(Math.max(prob, 1 - prob) * 100);
  return { above, prob, confidence };
}
