// Unit tests for computeDynamicBetSize and computeKellyMultiplier.
//
// computeDynamicBetSize scales the target dollar bet between betSize (min, at
// minConfidence) and maxBetSize (max, at dynamicSizingMaxConfidence) using a
// cubic (Kelly³) curve: t = ((conf - floor) / (ceiling - floor))³.
// The curve hugs the minimum through moderate conviction, then accelerates
// steeply near the ceiling — on a $1–$10 range with a 65–90% window, the
// dollar midpoint ($5) requires ~85% confidence.
//
// computeKellyMultiplier applies a per-position Kelly fraction (p−q)/odds on
// top of the t³ result, shrinking bets at thin-edge prices (e.g. YES at 0.52)
// relative to high-value prices (YES at 0.70) for the same confidence.
//
// Together they must:
//   1. Return betSize unchanged when disabled (legacy behavior).
//   2. Return betSize at/below the confidence floor.
//   3. Approach maxBetSize at/above the confidence ceiling (subject to Kelly).
//   4. Interpolate cubically in between (midpoint conf → 12.5% of range, not 50%).
//   5. Never exceed maxBetSize nor drop below betSize, even for bad configs.
//   6. Scale the increment by the Kelly fraction when yesPrice+direction given.
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { computeDynamicBetSize, computeKellyMultiplier } from "./kalshi-bot-engine-core.ts";
import { computeMarketableLimitPrice } from "./kalshi-trader.ts";
import { checkMaxBetSizeGuard } from "./kalshi-bot-guards.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const base = {
  enableDynamicSizing: true,
  betSize: 1,
  maxBetSize: 2,
  minConfidence: 65,
  dynamicSizingMaxConfidence: 90,
};

test("disabled → always returns betSize", () => {
  assert.equal(computeDynamicBetSize(99, { ...base, enableDynamicSizing: false }), 1);
  assert.equal(computeDynamicBetSize(50, { ...base, enableDynamicSizing: false }), 1);
});

test("at or below the floor → minimum bet", () => {
  assert.equal(computeDynamicBetSize(65, base), 1);
  assert.equal(computeDynamicBetSize(40, base), 1);
});

test("at or above the ceiling → maximum bet", () => {
  assert.equal(computeDynamicBetSize(90, base), 2);
  assert.equal(computeDynamicBetSize(100, base), 2);
});

test("Kelly³: at the midpoint confidence, bet is only 12.5% of the range (not 50%)", () => {
  // Midpoint of [65, 90] is 77.5%: t = (12.5/25)³ = 0.5³ = 0.125
  // Bet = $1 + 0.125 × $1 = $1.125 — far below the $1.50 a linear curve gives.
  // This means on a $1–$10 scale you'd need ~85% confidence to unlock $5.
  assert.equal(computeDynamicBetSize(77.5, base), 1.125);
});

test("Kelly³: at 71.25% confidence, bet is only 1.5625% of the range above minimum", () => {
  // 71.25 is 25% of the way from 65→90: t = (6.25/25)³ = 0.25³ = 0.015625
  // Bet = $1 + 0.015625 × $1 = $1.015625 — nearly at the floor
  assert.equal(computeDynamicBetSize(71.25, base), 1.015625);
});

test("never exceeds maxBetSize nor drops below betSize", () => {
  for (let c = 0; c <= 100; c++) {
    const size = computeDynamicBetSize(c, base);
    assert.ok(size >= base.betSize, `size ${size} below min at conf ${c}`);
    assert.ok(size <= base.maxBetSize, `size ${size} above max at conf ${c}`);
  }
});

test("inverted range (betSize >= maxBetSize) → returns betSize", () => {
  assert.equal(computeDynamicBetSize(90, { ...base, betSize: 2, maxBetSize: 2 }), 2);
  assert.equal(computeDynamicBetSize(90, { ...base, betSize: 3, maxBetSize: 2 }), 3);
});

test("non-finite confidence (NaN/Infinity) → minimum bet", () => {
  assert.equal(computeDynamicBetSize(NaN, base), 1);
  assert.equal(computeDynamicBetSize(Infinity, base), 1);
  assert.equal(computeDynamicBetSize(-Infinity, base), 1);
});

test("degenerate confidence range (ceiling <= floor) → step at floor", () => {
  const cfg = { ...base, minConfidence: 80, dynamicSizingMaxConfidence: 80 };
  assert.equal(computeDynamicBetSize(79, cfg), 1);
  assert.equal(computeDynamicBetSize(80, cfg), 2);
  assert.equal(computeDynamicBetSize(95, cfg), 2);
});

// ===========================================================================
// computeKellyMultiplier — per-position Kelly fraction tests
//
// Formula: Kelly = (p − q) / odds
//   YES: odds = (1 − yesPrice) / yesPrice
//   NO:  odds = yesPrice / (1 − yesPrice)
// Result is clamped to [0, 1].
// ===========================================================================

test("Kelly multiplier: YES at 0.50 (even odds) with 90% confidence → 0.8", () => {
  // p=0.9, q=0.1, odds=1.0 → kelly=(0.9-0.1)/1.0=0.8
  const k = computeKellyMultiplier(90, 0.5, "yes");
  assert.ok(Math.abs(k - 0.8) < 1e-9, `expected 0.8, got ${k}`);
});

test("Kelly multiplier: YES at 0.70 (long shot) with 90% confidence → clamped to 1", () => {
  // p=0.9, q=0.1, odds=(0.30/0.70)≈0.4286 → kelly=0.8/0.4286≈1.867 → clamped to 1
  const k = computeKellyMultiplier(90, 0.7, "yes");
  assert.equal(k, 1);
});

test("Kelly multiplier: YES at 0.52 (thin edge) with 90% confidence → ≈0.867", () => {
  // p=0.9, q=0.1, odds=(0.48/0.52)≈0.9231 → kelly=0.8/0.9231≈0.867
  const k = computeKellyMultiplier(90, 0.52, "yes");
  const expected = 0.8 / (0.48 / 0.52);
  assert.ok(Math.abs(k - expected) < 1e-9, `expected ${expected}, got ${k}`);
  assert.ok(k < 1, "thin-edge YES should produce a multiplier below 1");
});

test("Kelly multiplier: NO at 0.50 (even odds) with 90% confidence → 0.8", () => {
  // p=0.9, q=0.1, odds=(0.50/0.50)=1.0 → kelly=0.8
  const k = computeKellyMultiplier(90, 0.5, "no");
  assert.ok(Math.abs(k - 0.8) < 1e-9, `expected 0.8, got ${k}`);
});

test("Kelly multiplier: NO at 0.30 yesPrice (good NO value) with 90% confidence → clamped to 1", () => {
  // p=0.9, q=0.1, odds=(0.30/0.70)≈0.4286 → kelly≈1.867 → clamped to 1
  const k = computeKellyMultiplier(90, 0.3, "no");
  assert.equal(k, 1);
});

test("Kelly multiplier: below-50% confidence produces 0 (clamped)", () => {
  // p=0.45, q=0.55: p-q < 0 → kelly < 0 → clamped to 0
  const k = computeKellyMultiplier(45, 0.5, "yes");
  assert.equal(k, 0);
});

test("Kelly multiplier: degenerate yesPrice (0 or 1) → neutral fallback of 1", () => {
  assert.equal(computeKellyMultiplier(90, 0, "yes"), 1);
  assert.equal(computeKellyMultiplier(90, 1, "yes"), 1);
  assert.equal(computeKellyMultiplier(90, 0, "no"), 1);
});

test("Kelly multiplier: non-finite yesPrice → neutral fallback of 1", () => {
  assert.equal(computeKellyMultiplier(90, NaN, "yes"), 1);
  assert.equal(computeKellyMultiplier(90, Infinity, "yes"), 1);
});

// ===========================================================================
// computeDynamicBetSize with yesPrice + direction — Kelly-scaled sizing tests
// ===========================================================================

test("sizing with Kelly: omitting yesPrice/direction preserves original behavior", () => {
  // No yesPrice → kellyMult defaults to 1 → unchanged result.
  assert.equal(computeDynamicBetSize(90, base), 2);
  // Midpoint of [65,90] is 77.5%: t=0.5³=0.125 → $1.125 (cubic curve).
  assert.equal(computeDynamicBetSize(77.5, base), 1.125);
});

test("sizing with Kelly: YES at 0.50 with 90% confidence → kelly=0.8 shrinks increment", () => {
  // At ceiling (90), kelly=0.8 → result = minBet + 0.8*(maxBet-minBet) = 1+0.8=1.8
  const size = computeDynamicBetSize(90, base, 0.5, "yes");
  assert.ok(Math.abs(size - 1.8) < 1e-9, `expected 1.8, got ${size}`);
});

test("sizing with Kelly: YES at 0.70 with 90% confidence → kelly=1 → full maxBet", () => {
  // odds=(0.30/0.70)→kelly>1→clamped to 1 → result = maxBet = 2
  const size = computeDynamicBetSize(90, base, 0.7, "yes");
  assert.equal(size, 2);
});

test("sizing with Kelly: at midpoint confidence, Kelly also shrinks the increment", () => {
  // conf=77.5 (midpoint), YES at 0.50: kelly=0.55, t³=0.125
  // result = 1 + 0.55 * 0.125 * 1 = 1.06875
  // p=0.775, q=0.225, odds=1.0 → kelly=(0.775-0.225)/1.0=0.55
  const size = computeDynamicBetSize(77.5, base, 0.5, "yes");
  const expected = 1 + 0.55 * 0.125 * 1;
  assert.ok(Math.abs(size - expected) < 1e-9, `expected ${expected}, got ${size}`);
  assert.ok(size < 1.125, "Kelly-scaled midpoint bet must be below the no-Kelly midpoint");
});

test("sizing with Kelly: thin-edge YES bets smaller than high-value YES at same confidence", () => {
  // At ceiling: thin-edge (0.52) < high-value (0.70)
  const thin = computeDynamicBetSize(90, base, 0.52, "yes");
  const highValue = computeDynamicBetSize(90, base, 0.7, "yes");
  assert.ok(thin < highValue, `thin-edge (${thin}) should be less than high-value (${highValue})`);
});

test("sizing with Kelly: never below betSize or above maxBetSize across all prices", () => {
  const prices = [0.10, 0.25, 0.40, 0.50, 0.52, 0.60, 0.70, 0.80, 0.90];
  for (const yp of prices) {
    for (const dir of ["yes", "no"] as const) {
      for (let c = 0; c <= 100; c++) {
        const size = computeDynamicBetSize(c, base, yp, dir);
        assert.ok(size >= base.betSize, `size ${size} below min at conf ${c} yp ${yp} dir ${dir}`);
        assert.ok(size <= base.maxBetSize, `size ${size} above max at conf ${c} yp ${yp} dir ${dir}`);
      }
    }
  }
});

// ===========================================================================
// Integration-style betting-path test — sizing flows into the order AND the
// hard maxBetSize safety cap trims any oversized bet.
//
// computeDynamicBetSize is unit-tested above in isolation, but that alone does
// not prove the scaled value actually reaches the order, nor that the hard cap
// in _runBotTick still fires last. This section reconstructs the exact
// sizing→cap pipeline from kalshi-bot.ts (the lines around placeBet / the
// SAFETY GUARD block) using the SAME real, exported helpers the bot uses:
//   1. expectedFillCost  = computeMarketableLimitPrice("bid",…) for YES,
//                          (1 − yesPrice) for NO
//   2. targetBetSize     = computeDynamicBetSize(confidence, config)
//   3. contractCount     = max(1, floor(targetBetSize / expectedFillCost))
//   4. betAmount         = contractCount × expectedFillCost
//   5. abort if checkMaxBetSizeGuard(betAmount, maxBetCap) is true
//
// A wiring source-check at the bottom guarantees the real code keeps step 5
// AFTER step 2/4 — the exact reorder the task is protecting against.
// ===========================================================================

/**
 * Faithful mirror of the _runBotTick sizing→cap subsection. Returns every
 * intermediate value plus whether the hard cap would abort the trade.
 *
 * `overrideTargetBetSize` lets a test simulate a future refactor bug where the
 * sizing step produces a value ABOVE maxBetSize (which computeDynamicBetSize
 * would never do on its own) to prove the hard cap is a genuine backstop.
 */
function runSizingPipeline(
  confidence: number,
  direction: "yes" | "no",
  yesPrice: number,
  config: typeof base & { minReturnMultiple?: number },
  overrideTargetBetSize?: number,
) {
  const sideCost = direction === "yes" ? yesPrice : 1 - yesPrice;
  const expectedFillCost =
    direction === "yes"
      ? computeMarketableLimitPrice("bid", yesPrice, config.minReturnMultiple)
      : sideCost;

  const targetBetSize =
    overrideTargetBetSize ?? computeDynamicBetSize(confidence, config);
  const contractCount = Math.max(1, Math.floor(targetBetSize / expectedFillCost));
  const betAmount = contractCount * expectedFillCost;

  const maxBetCap = config.maxBetSize ?? 2;
  const blocked = checkMaxBetSizeGuard(betAmount, maxBetCap);

  return { expectedFillCost, targetBetSize, contractCount, betAmount, blocked };
}

test("betting-path: higher confidence buys MORE contracts, still within the cap", () => {
  // NO bet, yesPrice 0.50 → cost 0.50/contract. betSize $1, maxBetSize $2.
  const cfg = { ...base, betSize: 1, maxBetSize: 2 };

  // Floor confidence → minimum $1 target → 2 contracts, $1.00 risked.
  const low = runSizingPipeline(65, "no", 0.5, cfg);
  assert.equal(low.targetBetSize, 1);
  assert.equal(low.contractCount, 2);
  assert.equal(low.betAmount, 1);
  assert.equal(low.blocked, false);

  // 85% — Kelly³ gives t=(20/25)³=0.512, target≈$1.51 → 3 contracts, $1.50 risked.
  // (Cubic curve keeps mid-range bets far lower than linear: $1.51 not $1.80.)
  const mid = runSizingPipeline(85, "no", 0.5, cfg);
  assert.equal(mid.contractCount, 3);
  assert.equal(mid.blocked, false);

  // Ceiling (90%) → $2.00 target → 4 contracts, $2.00 risked — interpolated size
  // reached the order (more contracts than the floor case) AND lands exactly on
  // the cap without tripping the guard.
  const high = runSizingPipeline(90, "no", 0.5, cfg);
  assert.equal(high.targetBetSize, 2);
  assert.equal(high.contractCount, 4);
  assert.equal(high.betAmount, 2);
  assert.equal(high.blocked, false);

  // Sanity: confidence strictly increased the number of contracts wagered.
  assert.ok(high.contractCount > mid.contractCount);
  assert.ok(mid.contractCount > low.contractCount);
});

test("betting-path: YES bet uses the marketable-limit fill cost for sizing", () => {
  // YES bet, yesPrice 0.50 → bid crosses to 0.65 (the ACTUAL worst-case cost).
  // At ceiling confidence (90%) the $2 target buys floor(2/0.65)=3 contracts = $1.95.
  const cfg = { ...base, betSize: 1, maxBetSize: 2 };
  const r = runSizingPipeline(90, "yes", 0.5, cfg);
  assert.equal(r.expectedFillCost, 0.65); // computeMarketableLimitPrice("bid",0.5)
  assert.equal(r.targetBetSize, 2);
  assert.equal(r.contractCount, 3);
  assert.ok(Math.abs(r.betAmount - 1.95) < 1e-9);
  assert.equal(r.blocked, false); // 1.95 ≤ 2.00 cap
});

test("betting-path/BOUNDARY: a single contract costlier than the cap is aborted", () => {
  // Tiny cap ($0.40) with a NO contract costing $0.70. contractCount is forced
  // to the 1-contract minimum, so betAmount ($0.70) unavoidably exceeds the cap.
  // The hard guard must abort — the bot never sends an oversized order.
  const cfg = { ...base, betSize: 0.4, maxBetSize: 0.4, enableDynamicSizing: false };
  const r = runSizingPipeline(85, "no", 0.3, cfg); // NO cost = 1 - 0.3 = 0.70
  assert.equal(r.contractCount, 1);
  assert.ok(Math.abs(r.betAmount - 0.7) < 1e-9);
  assert.equal(r.blocked, true, "hard cap must abort when even 1 contract exceeds maxBetSize");
});

test("betting-path/BOUNDARY: cap wins if a future bug inflates the size past maxBetSize", () => {
  // computeDynamicBetSize can never exceed maxBetSize, so simulate a refactor
  // regression: the sizing step yields $5 while maxBetSize stays $2.
  // NO cost 0.50 → 10 contracts → $5.00 betAmount. The hard cap MUST catch it.
  const cfg = { ...base, betSize: 1, maxBetSize: 2 };
  const r = runSizingPipeline(85, "no", 0.5, cfg, /* overrideTargetBetSize */ 5);
  assert.equal(r.targetBetSize, 5); // inflated (simulated bug)
  assert.equal(r.contractCount, 10);
  assert.equal(r.betAmount, 5);
  assert.equal(r.blocked, true, "hard maxBetSize cap is the backstop against oversized orders");

  // And the legitimate max-confidence bet with the SAME config is NOT blocked —
  // the cap only trips the oversized case, never the correctly-sized one.
  const ok = runSizingPipeline(90, "no", 0.5, cfg);
  assert.equal(ok.blocked, false);
  assert.ok(ok.betAmount <= cfg.maxBetSize + 0.01);
});

test("betting-path: cap never fires across the full confidence range (well-configured bot)", () => {
  // Exhaustive sweep: for a valid config, the dynamically-sized bet must always
  // stay within the cap. This proves the sizing helper and the cap agree.
  const cfg = { ...base, betSize: 1, maxBetSize: 2 };
  for (let c = 0; c <= 100; c++) {
    for (const dir of ["yes", "no"] as const) {
      const r = runSizingPipeline(c, dir, 0.5, cfg);
      assert.equal(r.blocked, false, `unexpected abort at conf ${c} dir ${dir}`);
      assert.ok(r.betAmount <= cfg.maxBetSize + 0.01, `betAmount ${r.betAmount} > cap at conf ${c}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Wiring check — the real _runBotTick must keep the sizing→cap ORDER.
//
// The task's core risk: "a future refactor could reorder the two steps and let
// an oversized bet slip through." This asserts, against the live source, that
// computeDynamicBetSize is called, contractCount is derived from it, and the
// checkMaxBetSizeGuard abort happens AFTER — with a `return` on block.
// ---------------------------------------------------------------------------
test("betting-path/wiring: kalshi-bot.ts sizes then applies the hard cap (in that order)", () => {
  const src = fs.readFileSync(path.join(__dirname, "kalshi-bot-tick.ts"), "utf8");

  const sizingIdx = src.indexOf("computeDynamicBetSize(decision.confidence, S.config, yesPrice, direction)");
  const contractIdx = src.indexOf("Math.floor(targetBetSize / expectedFillCost)");
  const capIdx = src.indexOf("checkMaxBetSizeGuard(betAmount, maxBetCap)");

  assert.ok(sizingIdx !== -1, "must call computeDynamicBetSize(decision.confidence, S.config, yesPrice, direction)");
  assert.ok(contractIdx !== -1, "contractCount must be derived from targetBetSize / expectedFillCost");
  assert.ok(capIdx !== -1, "must call checkMaxBetSizeGuard(betAmount, maxBetCap)");

  // Ordering guarantee: size first, derive contracts, THEN cap.
  assert.ok(sizingIdx < contractIdx, "computeDynamicBetSize must run before contractCount");
  assert.ok(contractIdx < capIdx, "the maxBetSize cap must run AFTER the sizing/contract math");

  // The cap must abort the trade (return) when it fires.
  // Keep enough source context for cleanup/logging that may run before return.
  const capBlock = src.slice(capIdx, capIdx + 800);
  assert.ok(capBlock.includes("return"), "the maxBetSize guard must return (abort) when it fires");
});

test("conviction cleanup releases only the lock owned by the current tick, even if mode changes", () => {
  const src = fs.readFileSync(path.join(__dirname, "kalshi-bot-tick.ts"), "utf8");

  assert.ok(
    src.includes("let entryReservationOwnership: EntryReservationOwnership"),
    "each tick must track reservation ownership locally",
  );
  assert.ok(
    src.includes("convictionFiredThisWindow.add(`${sym}:${windowKey}`);")
      && src.includes("convictionLockClaimed: true,"),
    "the tick must record ownership immediately after acquiring the lock",
  );

  const cleanupStart = src.indexOf("const releaseConvictionEntryReservation");
  const cleanupEnd = src.indexOf("// Stat regime boost", cleanupStart);
  const cleanup = src.slice(cleanupStart, cleanupEnd);
  assert.ok(cleanup.includes("releaseEntryReservationOwnership(entryReservationOwnership)"), "cleanup must key off local ownership");
  assert.ok(!cleanup.includes('S.config.decisionMode === "conviction"'), "cleanup must not depend on mutable global mode");

  const pipelineGuardStart = src.indexOf("// ── Pipeline direction guard");
  const pipelineGuardEnd = src.indexOf("[kalshi-bot] placing bet", pipelineGuardStart);
  const pipelineGuard = src.slice(pipelineGuardStart, pipelineGuardEnd);
  assert.ok(
    pipelineGuard.includes('releaseConvictionEntryReservation("pipeline direction guard")'),
    "the post-mode-switch pipeline guard must release the conviction tick's owned reservations",
  );
});
