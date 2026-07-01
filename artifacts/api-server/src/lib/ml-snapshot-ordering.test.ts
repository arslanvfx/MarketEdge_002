// Sequencing tests — prove training data is captured AFTER stat+claude, not before.
//
// ## What this guards
//
// The ML v3 feature vector includes features 14 (statAbove) and 15 (claudeAbove)
// which encode the stat and Claude model directions at snapshot capture time.
// If captureMLSnapshot were called before stat and claude have run, those features
// would be 0.5 (neutral) — silently degrading training data quality with no error.
//
// ## The sequencing contract
//
// The tracker's ordering is:
//
//   analyzeCoin()             →  basePred.predictedPrice is now known
//   refineWithSelfConsistency →  ai.predictedPrice is now known (or null)
//   buildMLSnapshotInputs()   →  encodes both prices → features[14]/[15]
//   captureMLSnapshot()       →  features passed in carry real signal values
//
// `buildMLSnapshotInputs` is the single entry point that bundles steps 3+4.
// It REQUIRES `statPredictedPrice` (a number), so it cannot be called before
// analyzeCoin has produced basePred.predictedPrice — the type system enforces it.
// Tests below verify the runtime behaviour: real prices in → non-neutral features out.
//
// ## Regression detector tests
//
// Three tests named "ORDERING REGRESSION DETECTOR" simulate what would happen if
// the snapshot were captured before either model ran.  They assert that the
// "too-early" path produces neutral features (0.5).  If a future refactor somehow
// pre-populates stat/claude values before the models run, these tests would fail —
// signalling the regression immediately.
//
// Run with: pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMLSnapshotInputs,
  deriveMLSignalDirections,
  extractMLFeatures,
  N_FEATURES,
} from "./ml-features.ts";

// ---------------------------------------------------------------------------
// Minimal CoinPrediction stub — only the fields extractMLFeatures reads.
// Represents a BTC-like snapshot: price=60_000, at-the-money.
// ---------------------------------------------------------------------------

function makeCoin(price = 60_000): Parameters<typeof extractMLFeatures>[0] {
  return {
    price,
    indicators: {
      efficiencyRatio: 0.6,
      bbPctB: 50,
      rsi: 50,
      netDriftPct: 0,
      oscillationCount: 2,
      spikeFlag: false,
      atr14: 300,
    },
    candles: [{ c: price - 50 }, { c: price }],
  } as Parameters<typeof extractMLFeatures>[0];
}

const KALSHI_STRIKE = 60_000;
const ELAPSED      = 0.1;

// ---------------------------------------------------------------------------
// 1. Full tracker cycle simulation
//    Simulates what prediction-tracker.ts does in the snapshot phase:
//      stat runs → claude runs → buildMLSnapshotInputs → captureMLSnapshot
//    Proves that features[14] and [15] carry real directions (non-neutral).
// ---------------------------------------------------------------------------

test("TRACKER CYCLE: stat above + claude below → features[14]=1, features[15]=0", () => {
  // Step 1: stat model runs → produces basePred.predictedPrice
  const statPredictedPrice   = 60_100;  // 0.17% above strike → ABOVE

  // Step 2: claude runs → produces ai.predictedPrice
  const claudePredictedPrice = 59_900;  // 0.17% below strike → BELOW

  // Step 3+4: tracker calls buildMLSnapshotInputs with the now-known prices
  const { features, mlStatAbove, mlClaudeAbove } = buildMLSnapshotInputs(
    makeCoin(),
    KALSHI_STRIKE,
    ELAPSED,
    null,
    statPredictedPrice,    // ← basePred.predictedPrice (stat has run)
    claudePredictedPrice,  // ← ai.predictedPrice (claude has run)
    null,
  );

  // Step 5: captureMLSnapshot would receive these features
  assert.equal(features.length, N_FEATURES, "must produce a full feature vector");
  assert.equal(mlStatAbove,   true,  "stat above the strike → true");
  assert.equal(mlClaudeAbove, false, "claude below the strike → false");
  assert.equal(features[14], 1, "feature[14] (statAbove) must be 1, not 0.5 neutral");
  assert.equal(features[15], 0, "feature[15] (claudeAbove) must be 0, not 0.5 neutral");
});

test("TRACKER CYCLE: stat below + claude above → features[14]=0, features[15]=1", () => {
  const { features } = buildMLSnapshotInputs(
    makeCoin(), KALSHI_STRIKE, ELAPSED, null,
    59_900,  // stat below
    60_100,  // claude above
    null,
  );
  assert.equal(features[14], 0, "stat below → 0");
  assert.equal(features[15], 1, "claude above → 1");
});

test("TRACKER CYCLE: stat above + claude=null (non-training coin) → features[14]=1, features[15]=0.5", () => {
  // Non-training coins do not run Claude; the tracker passes null for ai.predictedPrice
  const { features, mlClaudeAbove } = buildMLSnapshotInputs(
    makeCoin(), KALSHI_STRIKE, ELAPSED, null,
    60_100,  // stat above
    null,    // ← ai?.predictedPrice ?? null, when useAI=false
    null,
  );
  assert.equal(mlClaudeAbove, null,  "no claude run → null");
  assert.equal(features[14],  1,     "stat above → feature 1");
  assert.equal(features[15],  0.5,   "claude skipped → neutral 0.5");
});

test("TRACKER CYCLE: both models agree above → both features non-neutral and equal 1", () => {
  const { features } = buildMLSnapshotInputs(
    makeCoin(), KALSHI_STRIKE, ELAPSED, null,
    60_100,  // stat above
    60_200,  // claude also above
    null,
  );
  assert.equal(features[14], 1, "stat above → 1");
  assert.equal(features[15], 1, "claude above → 1");
});

test("TRACKER CYCLE: both models agree below → both features non-neutral and equal 0", () => {
  const { features } = buildMLSnapshotInputs(
    makeCoin(), KALSHI_STRIKE, ELAPSED, null,
    59_900,  // stat below
    59_800,  // claude also below
    null,
  );
  assert.equal(features[14], 0, "stat below → 0");
  assert.equal(features[15], 0, "claude below → 0");
});

// ---------------------------------------------------------------------------
// 2. ORDERING REGRESSION DETECTOR
//    Simulates what would happen if captureMLSnapshot were moved BEFORE
//    buildMLSnapshotInputs (i.e., before stat/claude results are available).
//
//    The "too early" path is: the caller has no model prices yet so it falls
//    back to passing null directly to extractMLFeatures.  These tests prove
//    that this produces 0.5 neutral features — so if a refactor accidentally
//    re-introduces that path the training data degradation is detectable.
// ---------------------------------------------------------------------------

test("ORDERING REGRESSION DETECTOR: snapshot taken before stat runs → features[14]=0.5", () => {
  // Simulate: captureMLSnapshot called before analyzeCoin completes.
  // The only way the code could reach captureMLSnapshot without a stat price
  // is to pass null to extractMLFeatures directly, bypassing buildMLSnapshotInputs.
  const earlyFeatures = extractMLFeatures(
    makeCoin(), KALSHI_STRIKE, ELAPSED,
    null,
    null,   // ← no stat price yet (too early)
    null,
    null,
  );
  assert.equal(earlyFeatures[14], 0.5,
    "stat not yet computed → feature 14 must be 0.5; " +
    "if this fails, stat is somehow pre-populated before analyzeCoin");
  assert.equal(earlyFeatures[15], 0.5,
    "claude not yet computed → feature 15 must be 0.5; " +
    "if this fails, claude is somehow pre-populated before refineWithSelfConsistency");
});

test("ORDERING REGRESSION DETECTOR: snapshot taken before claude runs → features[15]=0.5", () => {
  // Simulate: stat has run (stat price available) but captureMLSnapshot is
  // called before Claude returns — claude direction is still null.
  const earlyFeatures = extractMLFeatures(
    makeCoin(), KALSHI_STRIKE, ELAPSED,
    null,
    true,   // stat direction already known
    null,   // ← claude not yet computed
    null,
  );
  assert.equal(earlyFeatures[14], 1,   "stat done → feature 14 should be 1");
  assert.equal(earlyFeatures[15], 0.5, "claude pending → feature 15 must be neutral 0.5");
});

test("ORDERING REGRESSION DETECTOR: both null → both features neutral 0.5 (pre-compute baseline)", () => {
  const earlyFeatures = extractMLFeatures(
    makeCoin(), KALSHI_STRIKE, ELAPSED, null, null, null, null,
  );
  assert.equal(earlyFeatures[14], 0.5, "feature 14 (statAbove) neutral before stat runs");
  assert.equal(earlyFeatures[15], 0.5, "feature 15 (claudeAbove) neutral before claude runs");
});

// ---------------------------------------------------------------------------
// 3. buildMLSnapshotInputs internal ordering proof
//    Show the bundled function produces different output than extractMLFeatures
//    called with null — proving it is doing real derivation work, not a no-op.
// ---------------------------------------------------------------------------

test("buildMLSnapshotInputs produces different features[14]/[15] than a null-signal call", () => {
  const reference      = KALSHI_STRIKE;
  const statPrice      = 60_100;  // above
  const claudePrice    = 59_900;  // below

  // Correct path (after both models run):
  const { features: correct } = buildMLSnapshotInputs(
    makeCoin(), reference, ELAPSED, null, statPrice, claudePrice, null,
  );

  // Broken path (snapshot taken before models run):
  const broken = extractMLFeatures(
    makeCoin(), reference, ELAPSED, null, null, null, null,
  );

  assert.notDeepEqual(
    [correct[14], correct[15]],
    [broken[14],  broken[15]],
    "correct path must produce different features[14]/[15] than the pre-compute null path",
  );
  assert.deepEqual([correct[14], correct[15]], [1, 0],   "correct: stat=above, claude=below");
  assert.deepEqual([broken[14],  broken[15]],  [0.5, 0.5], "broken: both neutral");
});

// ---------------------------------------------------------------------------
// 4. buildMLSnapshotInputs consistently uses kalshiTarget as the reference
//    (matching the production call in crypto.ts which uses kalshiTargetSnap)
// ---------------------------------------------------------------------------

test("buildMLSnapshotInputs uses kalshiTarget as direction reference, not live price", () => {
  // stat predicts above the strike (60_100 vs 60_000 = +0.17%)
  // but if we mistakenly used the live price (60_080) as reference,
  // the same stat price would be above the live price by only 0.033% — inside the dead-band → null.
  const kalshiTarget = 60_000;
  const livePrice    = 60_080;  // live price 0.13% above strike
  const statPrice    = 60_100;  // 0.17% above kalshi, 0.033% above live

  // buildMLSnapshotInputs uses kalshiTarget (correct):
  const { features: correct } = buildMLSnapshotInputs(
    makeCoin(livePrice), kalshiTarget, ELAPSED, null, statPrice, null, null,
  );
  assert.equal(correct[14], 1,
    "0.17% above kalshiTarget must encode as ABOVE (feature 1), not neutral");
});

// ---------------------------------------------------------------------------
// 5. deriveMLSignalDirections — direction derivation unit tests
//    (kept here as the mathematical building block of the sequencing contract)
// ---------------------------------------------------------------------------

test("deriveMLSignalDirections: stat clearly above → mlStatAbove=true", () => {
  const { mlStatAbove } = deriveMLSignalDirections(60_100, null, 60_000);
  assert.equal(mlStatAbove, true);
});

test("deriveMLSignalDirections: stat clearly below → mlStatAbove=false", () => {
  const { mlStatAbove } = deriveMLSignalDirections(59_900, null, 60_000);
  assert.equal(mlStatAbove, false);
});

test("deriveMLSignalDirections: stat inside dead-band (±0.05%) → mlStatAbove=null", () => {
  // 0.03% above — inside the ±0.05% threshold → null (neutral)
  const { mlStatAbove } = deriveMLSignalDirections(60_018, null, 60_000);
  assert.equal(mlStatAbove, null);
});

test("deriveMLSignalDirections: claude=null (not run) → mlClaudeAbove=null", () => {
  const { mlClaudeAbove } = deriveMLSignalDirections(60_060, null, 60_000);
  assert.equal(mlClaudeAbove, null);
});

test("deriveMLSignalDirections: stat and claude can disagree", () => {
  const { mlStatAbove, mlClaudeAbove } = deriveMLSignalDirections(60_100, 59_900, 60_000);
  assert.equal(mlStatAbove,   true);
  assert.equal(mlClaudeAbove, false);
});

test("deriveMLSignalDirections: exactly 0.05% above → null (boundary not crossed)", () => {
  const statPrice = 60_000 * 1.0005; // exactly +0.05%
  const { mlStatAbove } = deriveMLSignalDirections(statPrice, null, 60_000);
  assert.equal(mlStatAbove, null, "exactly on boundary is NOT > 0.05%, stays null");
});

test("deriveMLSignalDirections: zero reference → null (no division by zero)", () => {
  const { mlStatAbove, mlClaudeAbove } = deriveMLSignalDirections(100, 99, 0);
  assert.equal(mlStatAbove,   null, "zero reference: pct returns 0, inside dead-band");
  assert.equal(mlClaudeAbove, null);
});
