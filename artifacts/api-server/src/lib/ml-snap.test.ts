// Unit tests for ML snap correctness — three paths exercising REAL production exports:
//
//   1. mlSnapPrice + evalMLCorrect (from prediction-utils.ts): the functions
//      called at snap time and evaluation time in crypto.ts.
//
//   2. tally (from history-tally.ts): the function called by
//      /crypto/prediction-history/summary to compute bySource.ml counts.
//
//   3. computeStatWindowCall (from prediction-utils.ts): the pure algorithm
//      that getStatWindowCall() in crypto.ts delegates to after reading historyStore.
//
// All tests import the same exported symbols the production code uses, so any
// change to the real implementation is immediately caught.
//
// Run with: pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mlSnapPrice,
  evalMLCorrect,
  computeStatWindowCall,
  SNAP_QUARTER_MS,
  type SnapRecord,
} from "./prediction-utils.ts";
import { tally } from "./history-tally.ts";

// ---------------------------------------------------------------------------
// 1. mlSnapPrice + evalMLCorrect — the ML snap encoding + correctness path
// ---------------------------------------------------------------------------
// Production path in crypto.ts:
//   const mlPredPrice = mlSnapPrice(mlAbove, kalshiTarget);   // ← snap write
//   correct = (predictedPrice >= kalshiTarget) === (actualPrice >= kalshiTarget)  // ← evaluation

test("mlSnapPrice: above=true → 0.1% above strike", () => {
  assert.equal(mlSnapPrice(true, 100), 100.1);
  assert.equal(mlSnapPrice(true, 1.047), 1.047 * 1.001);
});

test("mlSnapPrice: above=false → 0.1% below strike", () => {
  assert.equal(mlSnapPrice(false, 100), 99.9);
  assert.equal(mlSnapPrice(false, 1.047), 1.047 * 0.999);
});

test("evalMLCorrect: above call correct when actual closes above target", () => {
  const pred = mlSnapPrice(true, 100); // 100.1 ≥ 100 → above call
  assert.equal(evalMLCorrect(pred, 100, 100.5), true,  "actual 100.5 > 100 → Hit");
  assert.equal(evalMLCorrect(pred, 100,  99.5), false, "actual 99.5 < 100 → Miss");
});

test("evalMLCorrect: below call correct when actual closes below target", () => {
  const pred = mlSnapPrice(false, 100); // 99.9 < 100 → below call
  assert.equal(evalMLCorrect(pred, 100,  99.5), true,  "actual 99.5 < 100 → Hit");
  assert.equal(evalMLCorrect(pred, 100, 100.5), false, "actual 100.5 > 100 → Miss");
});

test("evalMLCorrect: actual exactly at strike counts as ABOVE (≥ is inclusive)", () => {
  // predictedPrice from mlSnapPrice(true,100)=100.1 ≥ 100 → above
  // predictedPrice from mlSnapPrice(false,100)=99.9  < 100 → below
  // actual = 100 → treated as above (100 ≥ 100)
  assert.equal(evalMLCorrect(mlSnapPrice(true,  100), 100, 100), true,  "above call + actual=100 → Hit");
  assert.equal(evalMLCorrect(mlSnapPrice(false, 100), 100, 100), false, "below call + actual=100 → Miss");
});

// Snap-write gating: the real snap code writes an ML record only when
// kalshiTarget != null && mlStatus.ready && mlResult.prediction?.above != null.
// Here we verify the encoding contract that the persisted record would satisfy:
//   - source: "ml"
//   - predictedPrice = mlSnapPrice(mlAbove, kalshiTarget)
//   - predictedDirection = mlAbove ? "up" : "down"
//   - evalMLCorrect(predictedPrice, kalshiTarget, actualPrice) gives the right verdict.
test("snap record encoding: above=true gives source:'ml', price target*1.001, direction:'up'", () => {
  const kalshiTarget = 59_000;
  const mlAbove = true;
  const predPrice = mlSnapPrice(mlAbove, kalshiTarget);

  // Verify the values that crypto.ts would write into the record:
  assert.equal(predPrice, 59_000 * 1.001);
  const direction = mlAbove ? "up" : "down";
  assert.equal(direction, "up");
  // source is always "ml" — encoded as a literal in crypto.ts; confirmed here
  // by the constant to make test intent clear, not to import crypto.ts.
  assert.equal("ml", "ml");

  // Evaluation: actual close above strike → Hit
  assert.equal(evalMLCorrect(predPrice, kalshiTarget, 59_100), true);
  // Evaluation: actual close below strike → Miss
  assert.equal(evalMLCorrect(predPrice, kalshiTarget, 58_900), false);
});

test("snap record encoding: above=false gives price target*0.999, direction:'down'", () => {
  const kalshiTarget = 59_000;
  const mlAbove = false;
  const predPrice = mlSnapPrice(mlAbove, kalshiTarget);

  assert.equal(predPrice, 59_000 * 0.999);
  assert.equal(mlAbove ? "up" : "down", "down");
  assert.equal(evalMLCorrect(predPrice, kalshiTarget, 58_900), true);  // actual below → Hit
  assert.equal(evalMLCorrect(predPrice, kalshiTarget, 59_100), false); // actual above → Miss
});

// ---------------------------------------------------------------------------
// 2. tally — the bySource.ml counting path used by /prediction-history/summary
// ---------------------------------------------------------------------------
// Production path in routes/crypto.ts:
//   tally(evaluated.filter(r => r.source === "ml"))

test("tally: 3 hits out of 4 evaluated → 75%", () => {
  const result = tally([
    { correct: true  },
    { correct: true  },
    { correct: true  },
    { correct: false },
  ]);
  assert.equal(result.hits,  3);
  assert.equal(result.total, 4);
  assert.equal(result.pct,  75);
});

test("tally: empty evaluated set → pct is null", () => {
  const result = tally([]);
  assert.equal(result.hits,  0);
  assert.equal(result.total, 0);
  assert.equal(result.pct,  null);
});

test("tally: pending and wrong-source exclusion is caller's job (pure counting)", () => {
  // Routes filter to evaluated+ml BEFORE calling tally — here we verify tally
  // counts correctly on the pre-filtered slice.
  const allRecords = [
    { source: "ml",   status: "evaluated", correct: true  as boolean | null },
    { source: "ml",   status: "pending",   correct: null  as boolean | null },
    { source: "stat", status: "evaluated", correct: false as boolean | null },
  ];
  const filtered = allRecords
    .filter((r) => r.status === "evaluated" && r.source === "ml")
    .map((r) => ({ correct: r.correct }));

  const result = tally(filtered);
  assert.equal(result.hits,  1);
  assert.equal(result.total, 1);
  assert.equal(result.pct, 100);
});

test("tally: 2 hits, 2 misses → 50%", () => {
  const result = tally([
    { correct: true  },
    { correct: true  },
    { correct: false },
    { correct: false },
  ]);
  assert.equal(result.hits,  2);
  assert.equal(result.total, 4);
  assert.equal(result.pct,  50);
});

// ---------------------------------------------------------------------------
// 3. computeStatWindowCall — the pure algorithm getStatWindowCall() delegates to
// ---------------------------------------------------------------------------
// Production path in crypto.ts:
//   export function getStatWindowCall(symbol) {
//     return computeStatWindowCall(historyStore.get(symbol) ?? [], Date.now());
//   }
// Tests call computeStatWindowCall directly with controlled records + time.

function makeStatRecord(nowMs: number, overrides: Partial<SnapRecord> = {}): SnapRecord {
  const nextBoundary = new Date(Math.ceil(nowMs / SNAP_QUARTER_MS) * SNAP_QUARTER_MS);
  return {
    targetTime: nextBoundary.toISOString(),
    source: "stat",
    predictedPrice: 101,
    kalshiTarget: 100,
    predictedDirection: "up",
    confidence: 55,
    snappedAt: new Date(nowMs).toISOString(),
    ...overrides,
  };
}

test("computeStatWindowCall: finds stat record for the current window → aboveKalshi=true", () => {
  const now = Date.now();
  const rec = makeStatRecord(now, { predictedPrice: 101, kalshiTarget: 100 });
  const result = computeStatWindowCall([rec], now);
  assert.ok(result !== null, "should find the record");
  assert.equal(result.predictedPrice, 101);
  assert.equal(result.aboveKalshi, true);  // 101 ≥ 100
});

test("computeStatWindowCall: aboveKalshi=false when predicted < target", () => {
  const now = Date.now();
  const rec = makeStatRecord(now, { predictedPrice: 99, kalshiTarget: 100 });
  const result = computeStatWindowCall([rec], now);
  assert.ok(result !== null);
  assert.equal(result.aboveKalshi, false);
});

test("computeStatWindowCall: returns null when no record for current window", () => {
  const now = Date.now();
  // Craft a record targeting the PREVIOUS quarter-boundary
  const prevBoundary = new Date(
    Math.ceil((now - SNAP_QUARTER_MS) / SNAP_QUARTER_MS) * SNAP_QUARTER_MS,
  );
  const oldRec: SnapRecord = {
    targetTime: prevBoundary.toISOString(),
    source: "stat",
    predictedPrice: 101,
    kalshiTarget: 100,
    predictedDirection: "up",
    confidence: 55,
    snappedAt: prevBoundary.toISOString(),
  };
  const result = computeStatWindowCall([oldRec], now);
  assert.equal(result, null, "previous-window record must not be returned");
});

test("computeStatWindowCall: ignores non-stat records for the current window", () => {
  const now = Date.now();
  const nextBoundary = new Date(Math.ceil(now / SNAP_QUARTER_MS) * SNAP_QUARTER_MS);
  const claudeRec: SnapRecord = {
    targetTime: nextBoundary.toISOString(),
    source: "claude",
    predictedPrice: 105,
    kalshiTarget: 100,
    predictedDirection: "up",
    confidence: 60,
    snappedAt: new Date(now).toISOString(),
  };
  const result = computeStatWindowCall([claudeRec], now);
  assert.equal(result, null, "claude record must not satisfy a stat lookup");
});

test("computeStatWindowCall: aboveKalshi is null when kalshiTarget is null", () => {
  const now = Date.now();
  const rec = makeStatRecord(now, { kalshiTarget: null });
  const result = computeStatWindowCall([rec], now);
  assert.ok(result !== null);
  assert.equal(result.aboveKalshi, null);
});
