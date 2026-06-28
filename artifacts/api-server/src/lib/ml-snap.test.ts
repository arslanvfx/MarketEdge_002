// Unit tests for ML snap correctness — three paths:
//
//   1. Synthetic price encoding: mlAbove→price = target*1.001; !mlAbove→target*0.999.
//      Correctness = (predictedPrice ≥ target) matches (actualPrice ≥ target).
//
//   2. bySource.ml tally: hits / total / pct count match hand-counted records from
//      a mock evaluated set — same logic as the inline `tally()` in routes/crypto.ts.
//
//   3. getStatWindowCall core algorithm: finds the stat record whose targetTime is
//      the next 15-min quarter boundary, returning null for a previous window's record.
//
// All tests are pure — no DB imports, no in-memory store side effects.
// Run with: pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// 1. ML synthetic price encoding + correctness evaluation
// ---------------------------------------------------------------------------
// Mirrors crypto.ts lines 2815-2819:
//   mlPredPrice = mlAbove ? kalshiTarget * 1.001 : kalshiTarget * 0.999
// Correctness (scored later when actual price is known):
//   correct = (predictedPrice >= kalshiTarget) === (actualPrice >= kalshiTarget)

function mlSyntheticPrice(above: boolean, kalshiTarget: number): number {
  return above ? kalshiTarget * 1.001 : kalshiTarget * 0.999;
}

function evalCorrect(
  predictedPrice: number,
  kalshiTarget: number,
  actualPrice: number,
): boolean {
  return (predictedPrice >= kalshiTarget) === (actualPrice >= kalshiTarget);
}

test("ml synthetic price: above=true → price is 0.1% above strike", () => {
  assert.equal(mlSyntheticPrice(true, 100), 100.1);
  assert.equal(mlSyntheticPrice(true, 1.047), 1.047 * 1.001);
});

test("ml synthetic price: above=false → price is 0.1% below strike", () => {
  assert.equal(mlSyntheticPrice(false, 100), 99.9);
  assert.equal(mlSyntheticPrice(false, 1.047), 1.047 * 0.999);
});

test("ml correctness: above call correct when actual closes above target", () => {
  const pred = mlSyntheticPrice(true, 100); // 100.1
  assert.equal(evalCorrect(pred, 100, 100.5), true,  "actual 100.5 > 100 → Hit");
  assert.equal(evalCorrect(pred, 100,  99.5), false, "actual 99.5 < 100 → Miss");
});

test("ml correctness: below call correct when actual closes below target", () => {
  const pred = mlSyntheticPrice(false, 100); // 99.9
  assert.equal(evalCorrect(pred, 100,  99.5), true,  "actual 99.5 < 100 → Hit");
  assert.equal(evalCorrect(pred, 100, 100.5), false, "actual 100.5 > 100 → Miss");
});

test("ml correctness: exactly at strike is ABOVE (≥), call must match", () => {
  const predAbove = mlSyntheticPrice(true,  100); // 100.1 ≥ 100 → above
  const predBelow = mlSyntheticPrice(false, 100); // 99.9  < 100 → below
  // actual = exactly 100 → treated as ABOVE (≥)
  assert.equal(evalCorrect(predAbove, 100, 100), true,  "above call + actual=100 → Hit");
  assert.equal(evalCorrect(predBelow, 100, 100), false, "below call + actual=100 → Miss");
});

// ---------------------------------------------------------------------------
// 2. bySource.ml tally — mirrors routes/crypto.ts inline tally()
// ---------------------------------------------------------------------------
// tally(records) = { hits, total, pct }
// Only "evaluated" records (status === "evaluated") enter the tally; pending
// records are excluded (the route pre-filters with .filter(r => r.status === "evaluated")).

type MockRecord = { source: string; status: string; correct: boolean | null };

function tally(records: Pick<MockRecord, "correct">[]) {
  const hits = records.filter((r) => r.correct === true).length;
  return {
    hits,
    total: records.length,
    pct: records.length > 0 ? Math.round((hits / records.length) * 100) : null,
  };
}

function makeRecords(specs: { source: string; status: string; correct: boolean | null }[]): MockRecord[] {
  return specs;
}

test("bySource.ml tally: 3 hits out of 4 evaluated → 75%", () => {
  const records = makeRecords([
    { source: "ml", status: "evaluated", correct: true  },
    { source: "ml", status: "evaluated", correct: true  },
    { source: "ml", status: "evaluated", correct: true  },
    { source: "ml", status: "evaluated", correct: false },
  ]);
  const evaluated = records.filter((r) => r.status === "evaluated");
  const mlTally = tally(evaluated.filter((r) => r.source === "ml"));
  assert.equal(mlTally.hits,  3);
  assert.equal(mlTally.total, 4);
  assert.equal(mlTally.pct,  75);
});

test("bySource.ml tally: 0 evaluated records → pct is null", () => {
  const mlTally = tally([]);
  assert.equal(mlTally.hits,  0);
  assert.equal(mlTally.total, 0);
  assert.equal(mlTally.pct,  null);
});

test("bySource.ml tally: pending records excluded before tally", () => {
  const records = makeRecords([
    { source: "ml", status: "evaluated", correct: true  },
    { source: "ml", status: "pending",   correct: null  }, // must not count
    { source: "stat", status: "evaluated", correct: false }, // wrong source, must not count
  ]);
  const evaluated = records.filter((r) => r.status === "evaluated");
  const mlTally = tally(evaluated.filter((r) => r.source === "ml"));
  assert.equal(mlTally.hits,  1);
  assert.equal(mlTally.total, 1);
  assert.equal(mlTally.pct, 100);
});

test("bySource.ml tally: 2 hits, 2 misses → 50%", () => {
  const records = makeRecords([
    { source: "ml", status: "evaluated", correct: true  },
    { source: "ml", status: "evaluated", correct: true  },
    { source: "ml", status: "evaluated", correct: false },
    { source: "ml", status: "evaluated", correct: false },
  ]);
  const evaluated = records.filter((r) => r.status === "evaluated");
  const mlTally = tally(evaluated.filter((r) => r.source === "ml"));
  assert.equal(mlTally.hits,  2);
  assert.equal(mlTally.total, 4);
  assert.equal(mlTally.pct,  50);
});

// ---------------------------------------------------------------------------
// 3. getStatWindowCall algorithm — next-quarter-boundary lookup
// ---------------------------------------------------------------------------
// Mirrors crypto.ts lines 3170-3187:
//   nextBoundary = ceil(nowMs / QUARTER_MS) * QUARTER_MS
//   find record where targetTime === nextBoundary.toISOString() && source === "stat"
//   return null if absent; else return { aboveKalshi, predictedPrice, ... }

const QUARTER_MS = 15 * 60 * 1_000;

type StatRecord = {
  targetTime: string;
  source: string;
  predictedPrice: number;
  kalshiTarget: number | null;
  predictedDirection: string;
  confidence: number;
  snappedAt: string;
};

function findStatWindowCall(
  records: StatRecord[],
  nowMs: number,
): { aboveKalshi: boolean | null; predictedPrice: number; snappedAt: string } | null {
  const nextBoundary = new Date(Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS);
  const targetISO   = nextBoundary.toISOString();
  const rec = records.find((r) => r.targetTime === targetISO && r.source === "stat");
  if (!rec) return null;
  const predPrice  = rec.predictedPrice;
  const aboveKalshi =
    rec.kalshiTarget != null ? predPrice >= rec.kalshiTarget : null;
  return { aboveKalshi, predictedPrice: predPrice, snappedAt: rec.snappedAt };
}

// Convenience: build a stat record targeting the next quarter boundary from nowMs.
function statRecordForNextBoundary(nowMs: number, overrides: Partial<StatRecord> = {}): StatRecord {
  const nextBoundary = new Date(Math.ceil(nowMs / QUARTER_MS) * QUARTER_MS);
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

test("getStatWindowCall: returns stat record for the current window", () => {
  const now = Date.now();
  const rec = statRecordForNextBoundary(now, { predictedPrice: 101, kalshiTarget: 100 });
  const result = findStatWindowCall([rec], now);
  assert.ok(result !== null, "should find the record");
  assert.equal(result.predictedPrice, 101);
  assert.equal(result.aboveKalshi, true);  // 101 >= 100
});

test("getStatWindowCall: aboveKalshi=false when predicted below target", () => {
  const now = Date.now();
  const rec = statRecordForNextBoundary(now, { predictedPrice: 99, kalshiTarget: 100 });
  const result = findStatWindowCall([rec], now);
  assert.ok(result !== null);
  assert.equal(result.aboveKalshi, false); // 99 < 100
});

test("getStatWindowCall: returns null when no record for current window", () => {
  const now = Date.now();
  // Record targets a PREVIOUS boundary (now - QUARTER_MS)
  const prevBoundary = new Date(
    Math.ceil((now - QUARTER_MS) / QUARTER_MS) * QUARTER_MS,
  );
  const oldRec: StatRecord = {
    targetTime: prevBoundary.toISOString(),
    source: "stat",
    predictedPrice: 101,
    kalshiTarget: 100,
    predictedDirection: "up",
    confidence: 55,
    snappedAt: prevBoundary.toISOString(),
  };
  const result = findStatWindowCall([oldRec], now);
  assert.equal(result, null, "previous-window record should not be returned");
});

test("getStatWindowCall: ignores non-stat records for the current window", () => {
  const now = Date.now();
  const nextBoundary = new Date(Math.ceil(now / QUARTER_MS) * QUARTER_MS);
  const claudeRec: StatRecord = {
    targetTime: nextBoundary.toISOString(),
    source: "claude",           // wrong source
    predictedPrice: 105,
    kalshiTarget: 100,
    predictedDirection: "up",
    confidence: 60,
    snappedAt: new Date(now).toISOString(),
  };
  const result = findStatWindowCall([claudeRec], now);
  assert.equal(result, null, "claude record must not satisfy a stat lookup");
});

test("getStatWindowCall: aboveKalshi is null when kalshiTarget is null", () => {
  const now = Date.now();
  const rec = statRecordForNextBoundary(now, { kalshiTarget: null });
  const result = findStatWindowCall([rec], now);
  assert.ok(result !== null);
  assert.equal(result.aboveKalshi, null);
});
