// Unit tests for the pure ML state-management core (ml-core.ts).
//
// These lock in the restart-persistence behavior: after hydrating from DB rows,
// the in-memory state must exactly match what was saved, and predictions must
// be available immediately for coins that have hit the training gate.
//
// Run with:  pnpm --filter @workspace/api-server test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetAllState,
  applyHydratedModel,
  applyLabeledSnapshot,
  applyPendingSnapshot,
  reconcileStateFromExamples,
  captureSnapshot,
  labelAndRetrain,
  getPrediction,
  getStatus,
  getAllStatus,
  MIN_TRAINING_WINDOWS,
} from "./ml-core.ts";
import { N_FEATURES, initWeights } from "./ml-model.ts";

// Helper — build a feature vector of the right length filled with a value.
function fv(fill = 0.5): number[] {
  return new Array<number>(N_FEATURES).fill(fill);
}

// Helper — build an alternating label set to give the model signal.
function makeExamples(n: number): Array<{ features: number[]; label: 0 | 1 }> {
  return Array.from({ length: n }, (_, i) => ({
    features: fv(i % 2 === 0 ? 0.8 : 0.2),
    label:    (i % 2) as 0 | 1,
  }));
}

// Clear state before every test so tests are fully isolated.
beforeEach(() => resetAllState());

// ── applyHydratedModel ────────────────────────────────────────────────────────

test("applyHydratedModel: restores window count and valAccuracy", () => {
  applyHydratedModel("BTC", initWeights(), 42, 0.76);
  const s = getStatus("BTC");
  assert.equal(s.windows, 42);
  assert.equal(s.valAccuracy, 76); // stored as fraction, returned as integer %
});

test("applyHydratedModel: coin is immediately ready when windows >= MIN_TRAINING_WINDOWS", () => {
  applyHydratedModel("ETH", initWeights(), MIN_TRAINING_WINDOWS, 0.65);
  const s = getStatus("ETH");
  assert.equal(s.ready, true);
});

test("applyHydratedModel: coin is not ready when windows < MIN_TRAINING_WINDOWS", () => {
  applyHydratedModel("SOL", initWeights(), MIN_TRAINING_WINDOWS - 1, null);
  const s = getStatus("SOL");
  assert.equal(s.ready, false);
  assert.equal(s.valAccuracy, null);
});

test("applyHydratedModel: resets windows + weights when wrong length provided", () => {
  applyHydratedModel("BTC", [1, 2, 3], 10, null); // wrong length → full reset
  const s = getStatus("BTC");
  assert.equal(s.windows, 0); // window count discarded with stale weights
  assert.equal(s.ready, false);
});

// ── applyLabeledSnapshot ──────────────────────────────────────────────────────

test("applyLabeledSnapshot: populates training examples for a coin", () => {
  applyLabeledSnapshot("BTC", fv(0.7), 1);
  applyLabeledSnapshot("BTC", fv(0.3), 0);
  const s = getStatus("BTC");
  assert.equal(s.samples, 2);
});

test("applyLabeledSnapshot: ignores feature vectors of wrong length", () => {
  applyLabeledSnapshot("BTC", [0.5, 0.5], 1); // too short
  assert.equal(getStatus("BTC").samples, 0);
});

// ── applyPendingSnapshot ──────────────────────────────────────────────────────

test("applyPendingSnapshot: restores pending window for post-restart labeling", () => {
  applyPendingSnapshot("BTC", "win-1", fv(), Date.now(), 0.1);
  // After hydration the pending window must be label-able
  const snap = labelAndRetrain("BTC", "win-1", 1);
  assert.ok(snap !== null, "pending window should be restorable");
  assert.equal(getStatus("BTC").samples, 1);
});

test("applyPendingSnapshot: is idempotent (duplicate windowId is ignored)", () => {
  applyPendingSnapshot("BTC", "win-1", fv(0.5), Date.now(), 0.1);
  applyPendingSnapshot("BTC", "win-1", fv(0.9), Date.now(), 0.2); // same windowId
  labelAndRetrain("BTC", "win-1", 1);
  assert.equal(getStatus("BTC").samples, 1); // still just one example
});

// ── captureSnapshot ───────────────────────────────────────────────────────────

test("captureSnapshot: returns true on first capture", () => {
  const ok = captureSnapshot("BTC", "win-2", fv(), 0.1);
  assert.equal(ok, true);
});

test("captureSnapshot: returns false (idempotent) if window already captured", () => {
  captureSnapshot("BTC", "win-2", fv(), 0.1);
  const ok = captureSnapshot("BTC", "win-2", fv(), 0.2);
  assert.equal(ok, false);
});

test("captureSnapshot: rejects wrong-length features", () => {
  const ok = captureSnapshot("BTC", "win-x", [0.5], 0.1);
  assert.equal(ok, false);
});

// ── labelAndRetrain ───────────────────────────────────────────────────────────

test("labelAndRetrain: returns null when no matching pending window", () => {
  const result = labelAndRetrain("BTC", "nonexistent", 1);
  assert.equal(result, null);
});

test("labelAndRetrain: moves pending window to training set and increments windows", () => {
  captureSnapshot("BTC", "win-3", fv(), 0.2);
  labelAndRetrain("BTC", "win-3", 1);
  const s = getStatus("BTC");
  assert.equal(s.windows, 1);
  assert.equal(s.samples, 1);
});

test("labelAndRetrain: window is consumed (cannot be labeled twice)", () => {
  captureSnapshot("BTC", "win-3", fv(), 0.2);
  labelAndRetrain("BTC", "win-3", 1);
  const second = labelAndRetrain("BTC", "win-3", 0); // already consumed
  assert.equal(second, null);
  assert.equal(getStatus("BTC").windows, 1);
});

// ── getPrediction ─────────────────────────────────────────────────────────────

test("getPrediction: returns ready=false and null prediction before training gate", () => {
  const result = getPrediction("BTC", fv());
  assert.equal(result.ready, false);
  assert.equal(result.prediction, null);
  assert.equal(result.minWindows, MIN_TRAINING_WINDOWS);
});

test("getPrediction: returns ready=true and a prediction after model hydration", () => {
  // Simulate a warm restart: weights were persisted, windows count meets gate
  applyHydratedModel("BTC", initWeights(), MIN_TRAINING_WINDOWS, 0.72);
  const result = getPrediction("BTC", fv(0.6));
  assert.equal(result.ready, true);
  assert.ok(result.prediction !== null);
  assert.ok(typeof result.prediction.above === "boolean");
  assert.ok(result.prediction.confidence >= 50 && result.prediction.confidence <= 100);
});

// ── Simulated warm restart ────────────────────────────────────────────────────

test("warm restart: after hydration, a coin with 30+ windows is immediately ready", () => {
  // Step 1: simulate pre-restart — capture and label 30 windows
  const examples = makeExamples(MIN_TRAINING_WINDOWS);
  for (let i = 0; i < MIN_TRAINING_WINDOWS; i++) {
    captureSnapshot("BTC", `win-${i}`, examples[i].features, 0.5);
    labelAndRetrain("BTC", `win-${i}`, examples[i].label);
  }
  const preRestart = getStatus("BTC");
  assert.equal(preRestart.ready, true);
  assert.equal(preRestart.windows, MIN_TRAINING_WINDOWS);

  // Step 2: simulate restart — clear state and replay DB rows (as initMLFromDB would)
  resetAllState();
  assert.equal(getStatus("BTC").ready, false); // cold after reset

  applyHydratedModel("BTC", initWeights(), MIN_TRAINING_WINDOWS, 0.68);
  for (const ex of examples) {
    applyLabeledSnapshot("BTC", ex.features, ex.label);
  }

  // Step 3: assert immediate readiness after hydration
  const postRestart = getStatus("BTC");
  assert.equal(postRestart.ready, true, "coin must be ready immediately after restart hydration");
  assert.equal(postRestart.windows, MIN_TRAINING_WINDOWS);
  assert.equal(postRestart.samples, MIN_TRAINING_WINDOWS);

  // And predictions must work right away (no extra ticks needed)
  const pred = getPrediction("BTC", fv(0.5));
  assert.equal(pred.ready, true);
  assert.ok(pred.prediction !== null, "prediction must be non-null right after restart");
});

test("warm restart: pending windows from before restart can still be labeled post-restart", () => {
  // Pre-restart: capture a snapshot but don't resolve it yet
  captureSnapshot("ETH", "win-pending", fv(0.6), 0.3);
  resetAllState(); // simulate restart

  // Hydrate: model state + the unresolved pending window
  applyHydratedModel("ETH", initWeights(), 5, null);
  applyPendingSnapshot("ETH", "win-pending", fv(0.6), Date.now() - 60_000, 0.3);

  // Post-restart: the window resolves — labeling must still work
  const snap = labelAndRetrain("ETH", "win-pending", 1);
  assert.ok(snap !== null, "pending snapshot must survive restart and be label-able");
  assert.equal(getStatus("ETH").windows, 6); // 5 persisted + 1 newly labeled
});

// ── reconcileStateFromExamples ────────────────────────────────────────────────

test("reconcileStateFromExamples: no-op when examples is empty", () => {
  applyHydratedModel("BTC", initWeights(), 5, null);
  const r = reconcileStateFromExamples("BTC");
  assert.equal(r.retrained, false);
  assert.equal(r.wasInconsistent, false);
  assert.equal(r.windows, 5);
});

test("reconcileStateFromExamples: no-op when windows matches examples length", () => {
  applyHydratedModel("BTC", initWeights(), 3, null);
  for (let i = 0; i < 3; i++) applyLabeledSnapshot("BTC", fv(i * 0.1), (i % 2) as 0 | 1);
  const r = reconcileStateFromExamples("BTC");
  assert.equal(r.retrained, false);
  assert.equal(r.wasInconsistent, false);
  assert.equal(r.windows, 3);
});

test("reconcileStateFromExamples: ml_model_state absent → derives windows from examples and retrains", () => {
  // Simulate: ml_model_state row missing (windows=0), but 30+ snapshot rows exist
  for (let i = 0; i < MIN_TRAINING_WINDOWS; i++) {
    applyLabeledSnapshot("ETH", fv(i % 2 === 0 ? 0.8 : 0.2), (i % 2) as 0 | 1);
  }
  // No applyHydratedModel call → windows stays 0
  assert.equal(getStatus("ETH").windows, 0);
  assert.equal(getStatus("ETH").ready, false);

  const r = reconcileStateFromExamples("ETH");
  assert.equal(r.retrained, true);
  assert.equal(r.wasInconsistent, true);
  assert.equal(r.windows, MIN_TRAINING_WINDOWS);
  assert.equal(getStatus("ETH").ready, true,
    "coin must be ready after reconcile when snapshot count meets the gate");
  const pred = getPrediction("ETH", fv(0.5));
  assert.equal(pred.ready, true);
  assert.ok(pred.prediction !== null, "prediction must be non-null after reconcile-retrain");
});

test("reconcileStateFromExamples: labeled_windows mismatch → corrects to example count and retrains", () => {
  // model_state says 10 windows, but 15 labeled snapshots exist (partial write)
  applyHydratedModel("SOL", initWeights(), 10, null);
  for (let i = 0; i < 15; i++) applyLabeledSnapshot("SOL", fv(), (i % 2) as 0 | 1);

  const r = reconcileStateFromExamples("SOL");
  assert.equal(r.retrained, true);
  assert.equal(r.wasInconsistent, true);
  assert.equal(r.windows, 15);
  assert.equal(getStatus("SOL").windows, 15);
});

test("reconcileStateFromExamples: coin with 30+ snapshots but no model_state is immediately ready after reconcile", () => {
  // This is the core deploy-survival scenario: model_state row never written,
  // but snapshot table has full history → predictions must work right after startup.
  const examples = makeExamples(MIN_TRAINING_WINDOWS + 5); // 35 examples
  for (const ex of examples) applyLabeledSnapshot("XRP", ex.features, ex.label);

  reconcileStateFromExamples("XRP");

  const status = getStatus("XRP");
  assert.equal(status.ready, true, "coin must be ready after reconcile with 35 snapshots");
  assert.ok(status.valAccuracy !== null, "valAccuracy must be non-null after retrain");
  const pred = getPrediction("XRP", fv(0.6));
  assert.ok(pred.prediction !== null, "must predict without waiting for new windows");
});

// ── getAllStatus ──────────────────────────────────────────────────────────────

test("getAllStatus: returns entries for every coin that has been touched", () => {
  applyHydratedModel("BTC", initWeights(), 10, null);
  applyHydratedModel("ETH", initWeights(), 35, 0.7);
  const all = getAllStatus();
  assert.equal(all.length, 2);
  const btc = all.find(c => c.symbol === "BTC");
  const eth = all.find(c => c.symbol === "ETH");
  assert.ok(btc && !btc.ready,  "BTC should not be ready with 10 windows");
  assert.ok(eth &&  eth.ready,  "ETH should be ready with 35 windows");
});
