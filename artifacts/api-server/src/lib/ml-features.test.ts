// Unit tests for ml-features.ts
//
// Coverage:
//  1. encodeSignalFeatures — true/false/null → 1/0/0.5 encoding for all three params
//  2. wmRec values: "bet"→1, "stay_away"→0, "caution"/null/unknown→0.5
//  3. N_FEATURES constant matches the array length returned by extractMLFeatures
//  4. applySignalAugmentation — backfill augmentation overwrites features[14-16]
//     correctly when stat/claude signals are present or absent in the signalMap
//
// Run with: pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  N_FEATURES,
  FEATURE_NAMES,
  extractMLFeatures,
  encodeSignalFeatures,
  applySignalAugmentation,
} from "./ml-features.ts";

// ---------------------------------------------------------------------------
// Minimal CoinPrediction stub — only the fields extractMLFeatures reads.
// ---------------------------------------------------------------------------

function makeCoin(overrides: {
  price?: number;
  efficiencyRatio?: number;
  bbPctB?: number;
  rsi?: number;
  netDriftPct?: number;
  oscillationCount?: number;
  spikeFlag?: boolean;
  atr14?: number;
  candles?: { c: number }[];
} = {}): Parameters<typeof extractMLFeatures>[0] {
  const {
    price = 60000,
    efficiencyRatio = 0.5,
    bbPctB = 50,
    rsi = 50,
    netDriftPct = 0,
    oscillationCount = 0,
    spikeFlag = false,
    atr14 = 300,
    candles = [{ c: 59900 }, { c: 60000 }],
  } = overrides;

  return {
    price,
    indicators: { efficiencyRatio, bbPctB, rsi, netDriftPct, oscillationCount, spikeFlag, atr14 },
    candles: candles as Parameters<typeof extractMLFeatures>[0]["candles"],
  } as Parameters<typeof extractMLFeatures>[0];
}

const STRIKE = 60000;
const ELAPSED = 0.5;

// ---------------------------------------------------------------------------
// 1. encodeSignalFeatures — statAbove encoding
// ---------------------------------------------------------------------------

test("encodeSignalFeatures: statAbove=true → statFeat=1", () => {
  const [stat] = encodeSignalFeatures(true, null, null);
  assert.equal(stat, 1);
});

test("encodeSignalFeatures: statAbove=false → statFeat=0", () => {
  const [stat] = encodeSignalFeatures(false, null, null);
  assert.equal(stat, 0);
});

test("encodeSignalFeatures: statAbove=null → statFeat=0.5", () => {
  const [stat] = encodeSignalFeatures(null, null, null);
  assert.equal(stat, 0.5);
});

test("encodeSignalFeatures: statAbove=undefined → statFeat=0.5", () => {
  const [stat] = encodeSignalFeatures(undefined, null, null);
  assert.equal(stat, 0.5);
});

// ---------------------------------------------------------------------------
// 1. encodeSignalFeatures — claudeAbove encoding
// ---------------------------------------------------------------------------

test("encodeSignalFeatures: claudeAbove=true → claudeFeat=1", () => {
  const [, claude] = encodeSignalFeatures(null, true, null);
  assert.equal(claude, 1);
});

test("encodeSignalFeatures: claudeAbove=false → claudeFeat=0", () => {
  const [, claude] = encodeSignalFeatures(null, false, null);
  assert.equal(claude, 0);
});

test("encodeSignalFeatures: claudeAbove=null → claudeFeat=0.5", () => {
  const [, claude] = encodeSignalFeatures(null, null, null);
  assert.equal(claude, 0.5);
});

// ---------------------------------------------------------------------------
// 2. encodeSignalFeatures — wmRec encoding
// ---------------------------------------------------------------------------

test("encodeSignalFeatures: wmRec='bet' → wmFeat=1", () => {
  const [, , wm] = encodeSignalFeatures(null, null, "bet");
  assert.equal(wm, 1);
});

test("encodeSignalFeatures: wmRec='stay_away' → wmFeat=0", () => {
  const [, , wm] = encodeSignalFeatures(null, null, "stay_away");
  assert.equal(wm, 0);
});

test("encodeSignalFeatures: wmRec='caution' → wmFeat=0.5", () => {
  const [, , wm] = encodeSignalFeatures(null, null, "caution");
  assert.equal(wm, 0.5);
});

test("encodeSignalFeatures: wmRec=null → wmFeat=0.5", () => {
  const [, , wm] = encodeSignalFeatures(null, null, null);
  assert.equal(wm, 0.5);
});

test("encodeSignalFeatures: wmRec=undefined → wmFeat=0.5", () => {
  const [, , wm] = encodeSignalFeatures(null, null, undefined);
  assert.equal(wm, 0.5);
});

test("encodeSignalFeatures: wmRec='unknown_value' → wmFeat=0.5", () => {
  const [, , wm] = encodeSignalFeatures(null, null, "some_other_value");
  assert.equal(wm, 0.5);
});

// ---------------------------------------------------------------------------
// 3. N_FEATURES constant vs actual array length
// ---------------------------------------------------------------------------

test("N_FEATURES equals the length of FEATURE_NAMES", () => {
  assert.equal(N_FEATURES, FEATURE_NAMES.length);
});

test("extractMLFeatures returns exactly N_FEATURES elements (all signals null)", () => {
  const features = extractMLFeatures(makeCoin(), STRIKE, ELAPSED);
  assert.equal(features.length, N_FEATURES);
});

test("extractMLFeatures returns exactly N_FEATURES elements (all signals provided)", () => {
  const features = extractMLFeatures(
    makeCoin(), STRIKE, ELAPSED, 59950, true, false, "bet",
  );
  assert.equal(features.length, N_FEATURES);
});

// ---------------------------------------------------------------------------
// 3. extractMLFeatures — features 14-16 reflect the signal params
// ---------------------------------------------------------------------------

test("extractMLFeatures feature[14]: statAbove=true → 1", () => {
  const f = extractMLFeatures(makeCoin(), STRIKE, ELAPSED, null, true, null, null);
  assert.equal(f[14], 1);
});

test("extractMLFeatures feature[14]: statAbove=false → 0", () => {
  const f = extractMLFeatures(makeCoin(), STRIKE, ELAPSED, null, false, null, null);
  assert.equal(f[14], 0);
});

test("extractMLFeatures feature[14]: statAbove=null → 0.5", () => {
  const f = extractMLFeatures(makeCoin(), STRIKE, ELAPSED, null, null, null, null);
  assert.equal(f[14], 0.5);
});

test("extractMLFeatures feature[15]: claudeAbove=true → 1", () => {
  const f = extractMLFeatures(makeCoin(), STRIKE, ELAPSED, null, null, true, null);
  assert.equal(f[15], 1);
});

test("extractMLFeatures feature[15]: claudeAbove=false → 0", () => {
  const f = extractMLFeatures(makeCoin(), STRIKE, ELAPSED, null, null, false, null);
  assert.equal(f[15], 0);
});

test("extractMLFeatures feature[15]: claudeAbove=null → 0.5", () => {
  const f = extractMLFeatures(makeCoin(), STRIKE, ELAPSED, null, null, null, null);
  assert.equal(f[15], 0.5);
});

test("extractMLFeatures feature[16]: wmRec='bet' → 1", () => {
  const f = extractMLFeatures(makeCoin(), STRIKE, ELAPSED, null, null, null, "bet");
  assert.equal(f[16], 1);
});

test("extractMLFeatures feature[16]: wmRec='stay_away' → 0", () => {
  const f = extractMLFeatures(makeCoin(), STRIKE, ELAPSED, null, null, null, "stay_away");
  assert.equal(f[16], 0);
});

test("extractMLFeatures feature[16]: wmRec='caution' → 0.5", () => {
  const f = extractMLFeatures(makeCoin(), STRIKE, ELAPSED, null, null, null, "caution");
  assert.equal(f[16], 0.5);
});

test("extractMLFeatures feature[16]: wmRec=null → 0.5", () => {
  const f = extractMLFeatures(makeCoin(), STRIKE, ELAPSED, null, null, null, null);
  assert.equal(f[16], 0.5);
});

// ---------------------------------------------------------------------------
// 4. applySignalAugmentation — backfill augmentation
// ---------------------------------------------------------------------------

function makeFeatures17(): number[] {
  return Array(17).fill(0.5);
}

test("applySignalAugmentation: stat=true, claude=true → features[14]=1, [15]=1, [16]=0.5", () => {
  const f = makeFeatures17();
  applySignalAugmentation(f, true, true);
  assert.equal(f[14], 1);
  assert.equal(f[15], 1);
  assert.equal(f[16], 0.5);
});

test("applySignalAugmentation: stat=false, claude=false → features[14]=0, [15]=0, [16]=0.5", () => {
  const f = makeFeatures17();
  applySignalAugmentation(f, false, false);
  assert.equal(f[14], 0);
  assert.equal(f[15], 0);
  assert.equal(f[16], 0.5);
});

test("applySignalAugmentation: stat=true, claude=false → features[14]=1, [15]=0", () => {
  const f = makeFeatures17();
  applySignalAugmentation(f, true, false);
  assert.equal(f[14], 1);
  assert.equal(f[15], 0);
});

test("applySignalAugmentation: stat=false, claude=true → features[14]=0, [15]=1", () => {
  const f = makeFeatures17();
  applySignalAugmentation(f, false, true);
  assert.equal(f[14], 0);
  assert.equal(f[15], 1);
});

test("applySignalAugmentation: stat absent (undefined) → feature[14]=0.5 (neutral)", () => {
  const f = makeFeatures17();
  applySignalAugmentation(f, undefined, true);
  assert.equal(f[14], 0.5);
  assert.equal(f[15], 1);
});

test("applySignalAugmentation: claude absent (undefined) → feature[15]=0.5 (neutral)", () => {
  const f = makeFeatures17();
  applySignalAugmentation(f, true, undefined);
  assert.equal(f[14], 1);
  assert.equal(f[15], 0.5);
});

test("applySignalAugmentation: both absent (signalMap miss) → all three features=0.5", () => {
  const f = makeFeatures17();
  applySignalAugmentation(f, undefined, undefined);
  assert.equal(f[14], 0.5);
  assert.equal(f[15], 0.5);
  assert.equal(f[16], 0.5);
});

test("applySignalAugmentation: stat=null, claude=null → features[14]=0.5, [15]=0.5", () => {
  const f = makeFeatures17();
  applySignalAugmentation(f, null, null);
  assert.equal(f[14], 0.5);
  assert.equal(f[15], 0.5);
});

test("applySignalAugmentation: wmRec always 0.5 regardless of stat/claude values", () => {
  const f = makeFeatures17();
  applySignalAugmentation(f, true, true);
  assert.equal(f[16], 0.5, "wmRec must always be 0.5 (not stored historically)");
});

test("applySignalAugmentation: does not alter features[0-13]", () => {
  const f = makeFeatures17();
  for (let i = 0; i < 14; i++) f[i] = i * 0.07; // distinct sentinel values
  const before = f.slice(0, 14);
  applySignalAugmentation(f, true, false);
  assert.deepEqual(f.slice(0, 14), before);
});
