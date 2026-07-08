// Unit tests for crypto-signals — predCache freshness and stat signal logic.
//
// Coverage:
//   1. resolvePredEntry  — 10-min freshness gate (the guard that prevents the
//      bot from betting on a stale or stalled predictor snapshot)
//   2. resolveStatSignal — stat model comparison: predictedPrice vs the CURRENT
//      Kalshi target, horizon-matched prediction selection, and the documented
//      "prior-window pred, new-window target" behavior
//   3. PRED_MAX_AGE_MS   — constant value locked to 10 minutes
//   4. Wiring checks     — confirm getLatestCoinSignals in crypto-signals.ts
//      delegates to the two pure helpers and uses the exported constant
//
// Pure helpers live in crypto-signals-pure.ts (zero-dependency) so tests run
// without any DB, API, or crypto-tracker module setup.
//
// Run with: pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRED_MAX_AGE_MS,
  resolvePredEntry,
  resolveStatSignal,
} from "./crypto-signals-pure.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readSrc(file: string): string {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

// ---------------------------------------------------------------------------
// Minimal stubs — only the fields the pure helpers actually read
// ---------------------------------------------------------------------------

function makePredEntry(overrides: {
  at?: number;
  predictedPrice?: number;
  confidence?: number;
  minutesAhead?: number;
} = {}): { at: number; value: { predictions: Array<{ minutesAhead: number; predictedPrice: number; confidence: number }> } } {
  const {
    at = Date.now(),
    predictedPrice = 98_000,
    confidence = 62,
    minutesAhead = 5,
  } = overrides;
  return {
    at,
    value: { predictions: [{ minutesAhead, predictedPrice, confidence }] } as any,
  };
}

function makePredictions(
  items: Array<{ minutesAhead: number; predictedPrice: number; confidence?: number }>,
): Array<{ minutesAhead: number; predictedPrice: number; confidence: number }> {
  return items.map(({ minutesAhead, predictedPrice, confidence = 60 }) => ({
    minutesAhead,
    predictedPrice,
    confidence,
  }));
}

// ---------------------------------------------------------------------------
// PRED_MAX_AGE_MS — must be exactly 10 minutes
// ---------------------------------------------------------------------------

test("PRED_MAX_AGE_MS: equals exactly 10 minutes in milliseconds", () => {
  assert.equal(PRED_MAX_AGE_MS, 10 * 60 * 1000);
});

// ---------------------------------------------------------------------------
// resolvePredEntry — freshness gate
// ---------------------------------------------------------------------------

test("resolvePredEntry: undefined entry → null (no predCache hit)", () => {
  assert.equal(resolvePredEntry(undefined, Date.now()), null);
});

test("resolvePredEntry: entry age exactly 0ms → returns value (fresh)", () => {
  const now = Date.now();
  const entry = makePredEntry({ at: now });
  assert.notEqual(resolvePredEntry(entry, now), null);
});

test("resolvePredEntry: entry age well within limit → returns value", () => {
  const now = Date.now();
  const entry = makePredEntry({ at: now - 5 * 60_000 }); // 5 min old
  assert.notEqual(resolvePredEntry(entry, now), null);
});

test("resolvePredEntry: entry age exactly at limit (10 min) → null (strict <)", () => {
  const now = Date.now();
  const entry = makePredEntry({ at: now - PRED_MAX_AGE_MS });
  assert.equal(
    resolvePredEntry(entry, now),
    null,
    "entry exactly at the 10-min boundary must be rejected (condition is strict <)",
  );
});

test("resolvePredEntry: entry age 1ms under limit → returns value (boundary)", () => {
  const now = Date.now();
  const entry = makePredEntry({ at: now - (PRED_MAX_AGE_MS - 1) });
  assert.notEqual(resolvePredEntry(entry, now), null);
});

test("resolvePredEntry: entry age just over limit → null (stale)", () => {
  const now = Date.now();
  const entry = makePredEntry({ at: now - (PRED_MAX_AGE_MS + 1_000) });
  assert.equal(resolvePredEntry(entry, now), null);
});

test("resolvePredEntry: entry from 20 min ago → null (predictor snap loop likely stalled)", () => {
  const now = Date.now();
  const entry = makePredEntry({ at: now - 20 * 60_000 });
  assert.equal(resolvePredEntry(entry, now), null);
});

test("resolvePredEntry: returns the same value object when fresh", () => {
  const now = Date.now();
  const entry = makePredEntry({ at: now - 1_000 });
  assert.strictEqual(resolvePredEntry(entry, now), entry.value);
});

// ---------------------------------------------------------------------------
// resolveStatSignal — stat model comparison logic
// ---------------------------------------------------------------------------

test("resolveStatSignal: empty predictions array → null", () => {
  assert.equal(resolveStatSignal([], 98_000, null), null);
});

test("resolveStatSignal: predictedPrice === 0 → null (invalid snapshot)", () => {
  const preds = makePredictions([{ minutesAhead: 5, predictedPrice: 0 }]);
  assert.equal(resolveStatSignal(preds, 98_000, null), null);
});

test("resolveStatSignal: predictedPrice < 0 → null (invalid snapshot)", () => {
  const preds = makePredictions([{ minutesAhead: 5, predictedPrice: -1 }]);
  assert.equal(resolveStatSignal(preds, 98_000, null), null);
});

test("resolveStatSignal: predictedPrice > target → statAbove true", () => {
  const preds = makePredictions([{ minutesAhead: 5, predictedPrice: 98_001 }]);
  const result = resolveStatSignal(preds, 98_000, null);
  assert.ok(result !== null);
  assert.equal(result.statAbove, true);
});

test("resolveStatSignal: predictedPrice === target → statAbove true (at-or-above)", () => {
  const preds = makePredictions([{ minutesAhead: 5, predictedPrice: 98_000 }]);
  const result = resolveStatSignal(preds, 98_000, null);
  assert.ok(result !== null);
  assert.equal(result.statAbove, true);
});

test("resolveStatSignal: predictedPrice < target → statAbove false", () => {
  const preds = makePredictions([{ minutesAhead: 5, predictedPrice: 97_999 }]);
  const result = resolveStatSignal(preds, 98_000, null);
  assert.ok(result !== null);
  assert.equal(result.statAbove, false);
});

test("resolveStatSignal: confidence is forwarded in result", () => {
  const preds = makePredictions([{ minutesAhead: 5, predictedPrice: 98_001, confidence: 71 }]);
  const result = resolveStatSignal(preds, 98_000, null);
  assert.ok(result !== null);
  assert.equal(result.statConfidence, 71);
});

test("resolveStatSignal: no minutesRemaining → uses last prediction in array", () => {
  // With minutesRemaining=null we skip the reduce and use the last entry.
  const preds = makePredictions([
    { minutesAhead: 5,  predictedPrice: 97_000 },  // below target
    { minutesAhead: 10, predictedPrice: 99_000 },  // above target  ← last
  ]);
  const result = resolveStatSignal(preds, 98_000, null);
  assert.ok(result !== null);
  assert.equal(result.statAbove, true, "last prediction (99_000) is used when minutesRemaining=null");
});

test("resolveStatSignal: minutesRemaining=0 → falls back to last entry", () => {
  const preds = makePredictions([
    { minutesAhead: 5,  predictedPrice: 97_000 },
    { minutesAhead: 10, predictedPrice: 99_000 },
  ]);
  const result = resolveStatSignal(preds, 98_000, 0);
  assert.ok(result !== null);
  assert.equal(result.statAbove, true, "minutesRemaining=0 also uses last entry");
});

test("resolveStatSignal: picks prediction closest to minutesRemaining", () => {
  const preds = makePredictions([
    { minutesAhead: 3,  predictedPrice: 97_000 },  // below — delta 5 from 8
    { minutesAhead: 7,  predictedPrice: 99_000 },  // above  — delta 1 from 8 ← closest
    { minutesAhead: 12, predictedPrice: 97_500 },  // below  — delta 4 from 8
  ]);
  const result = resolveStatSignal(preds, 98_000, 8);
  assert.ok(result !== null);
  assert.equal(result.statAbove, true, "minutesAhead=7 pred (99_000) is closest to 8 min remaining");
});

test("resolveStatSignal: tie-breaking keeps first equidistant entry (stable reduce)", () => {
  // Both minutesAhead=3 and minutesAhead=7 are delta=2 from minutesRemaining=5.
  // The reduce uses strict < so the first entry wins on ties.
  const preds = makePredictions([
    { minutesAhead: 3, predictedPrice: 97_000 },  // below — tie, wins
    { minutesAhead: 7, predictedPrice: 99_000 },  // above — tie, loses
  ]);
  const result = resolveStatSignal(preds, 98_000, 5);
  assert.ok(result !== null);
  assert.equal(result.statAbove, false, "tie: first equidistant entry (97_000, below target) is selected");
});

// ---------------------------------------------------------------------------
// Prior-window predCache entry — documented behavior
// ---------------------------------------------------------------------------
//
// Scenario A — "fresh-by-timestamp but old-window snapshot":
//   The predictor's snap loop wrote a predCache entry at minute 14 of window
//   W (Kalshi target=98_000). The window then rolled to W+1, publishing a new
//   Kalshi target=99_000.  For up to PRED_MAX_AGE_MS after the snapshot was
//   taken, resolvePredEntry still returns the pred value (it is "fresh" by
//   timestamp).  resolveStatSignal ALWAYS compares predictedPrice against the
//   CURRENT kalshiTarget (99_000, passed in by the caller), not the old one.
//
//   Intended design: the bot always uses the live strike.  The up-to-10-min
//   survival window for a prior-window snapshot is an accepted trade-off; after
//   that the entry goes null and no entry is possible.
//
// Scenario B — "snapshot >10 min old":
//   resolvePredEntry returns null regardless of the current Kalshi target.
//   The bot cannot see the pred; stat and ML are null; the all-signals gate
//   blocks any entry.

test("prior-window / scenario A: entry 9 min old is still fresh", () => {
  const now = Date.now();
  const entry = makePredEntry({ at: now - 9 * 60_000, predictedPrice: 98_500 });
  const pred = resolvePredEntry(entry, now);
  assert.ok(pred !== null, "entry 9 min old is within PRED_MAX_AGE_MS — must be returned");
});

test("prior-window / scenario A: resolveStatSignal uses CURRENT target, not the old one", () => {
  // At snapshot time: predictedPrice=98_500, old target=98_000 → would be statAbove=true.
  // After window rollover: new target=99_000 → statAbove must be false (98_500 < 99_000).
  const preds = makePredictions([{ minutesAhead: 5, predictedPrice: 98_500 }]);
  const withOldTarget = resolveStatSignal(preds, 98_000, 5);
  const withNewTarget = resolveStatSignal(preds, 99_000, 5);
  assert.ok(withOldTarget !== null && withNewTarget !== null);
  assert.equal(withOldTarget.statAbove, true,  "98_500 ≥ 98_000 (old target) → true");
  assert.equal(withNewTarget.statAbove, false, "98_500 < 99_000 (current target) → direction flips");
});

test("prior-window / scenario B: stale entry (>10 min) → resolvePredEntry returns null", () => {
  const now = Date.now();
  const entry = makePredEntry({ at: now - 11 * 60_000 });
  assert.equal(
    resolvePredEntry(entry, now),
    null,
    "snapshot > 10 min old must be rejected — stat and ML cannot run",
  );
});

test("prior-window / scenario B: stale predCache + any Kalshi target → stat null (no bet possible)", () => {
  // Simulates the full data flow: stale pred → resolved=null → stat logic
  // never runs → statAbove stays null → all-signals gate blocks the entry.
  const now = Date.now();
  const staleEntry = makePredEntry({ at: now - 15 * 60_000 });
  const resolved = resolvePredEntry(staleEntry, now);
  const statResult = resolved
    ? resolveStatSignal(resolved.predictions as any, 99_000, 7)
    : null;
  assert.equal(statResult, null, "stale predCache + any Kalshi target = null stat → entry blocked");
});

// ---------------------------------------------------------------------------
// Wiring checks — confirm getLatestCoinSignals uses the pure helpers
// ---------------------------------------------------------------------------

test("wiring: crypto-signals-pure.ts exports PRED_MAX_AGE_MS as 10 * 60_000", () => {
  const src = readSrc("crypto-signals-pure.ts");
  assert.ok(
    src.includes("export const PRED_MAX_AGE_MS = 10 * 60_000"),
    "PRED_MAX_AGE_MS must be exported and set to 10 * 60_000 in the pure module",
  );
});

test("wiring: crypto-signals.ts re-exports PRED_MAX_AGE_MS, resolvePredEntry, resolveStatSignal", () => {
  const src = readSrc("crypto-signals.ts");
  assert.ok(
    src.includes("PRED_MAX_AGE_MS") && src.includes("resolvePredEntry") && src.includes("resolveStatSignal"),
    "crypto-signals.ts must re-export all three pure helpers from the pure module",
  );
});

test("wiring: getLatestCoinSignals delegates freshness check to resolvePredEntry", () => {
  const src = readSrc("crypto-signals.ts");
  assert.ok(
    src.includes("resolvePredEntry(predCache.get(sym), Date.now())"),
    "getLatestCoinSignals must call resolvePredEntry(predCache.get(sym), Date.now())",
  );
});

test("wiring: getLatestCoinSignals delegates stat computation to resolveStatSignal", () => {
  const src = readSrc("crypto-signals.ts");
  assert.ok(
    src.includes("resolveStatSignal(pred.predictions, kalshiTarget, minutesRemaining)"),
    "getLatestCoinSignals must call resolveStatSignal — stat logic must not be inlined",
  );
});

test("wiring: both stat and ML paths gate on the same resolved pred variable", () => {
  const src = readSrc("crypto-signals.ts");
  // Stat uses a ternary (`pred && kalshiTarget`), ML uses `if (pred &&`.
  // Both must gate on the same `pred` variable returned by resolvePredEntry.
  const ternaryGate = src.includes("pred && kalshiTarget != null");
  const ifGate = src.includes("if (pred && kalshiTarget != null)");
  assert.ok(
    ternaryGate && ifGate,
    "stat path must use `pred && kalshiTarget != null` ternary and ML path must use `if (pred && kalshiTarget != null)` — both gating on the same resolved pred",
  );
});
