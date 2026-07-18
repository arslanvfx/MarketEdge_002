// Unit tests for the Extreme Caution gate and related conviction-mode guards.
//
// These tests verify pure logic extracted from _runBotTick so regressions in
// any of the four guard conditions are caught before they reach production.
//
// Guards under test:
//   checkExtremeCautionEarlyGuard  — blocks YES re-entry when abort Set is populated
//   evaluateYesBidFloorAbort       — YES cross-check: abort + EC Set population decision
//   computeNoAskBounceThreshold    — NO cross-check: exact (1−lp) when EC on; +0.01 when off
//   computeExtremeCautionNoAskCeiling — YES EC complement: (1−lockPrice)+0.005 (EC only)
//   selectTimeBetBracket           — highest matching bracket wins; null on no match
//
// Run with:  pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkExtremeCautionEarlyGuard,
  evaluateYesBidFloorAbort,
  computeNoAskBounceThreshold,
  computeExtremeCautionNoAskCeiling,
  selectTimeBetBracket,
} from "./kalshi-bot-engine-core.ts";

// ---------------------------------------------------------------------------
// checkExtremeCautionEarlyGuard — early YES block
// ---------------------------------------------------------------------------

test("extremeCaution early guard: blocks when all four conditions hold", () => {
  const aborted = new Set(["BTC:2026-07-18T14:00"]);
  assert.equal(
    checkExtremeCautionEarlyGuard("conviction", true, "yes", aborted, "BTC", "2026-07-18T14:00"),
    true,
  );
});

test("extremeCaution early guard: does NOT block when extremeCautionEnabled=false", () => {
  const aborted = new Set(["BTC:2026-07-18T14:00"]);
  assert.equal(
    checkExtremeCautionEarlyGuard("conviction", false, "yes", aborted, "BTC", "2026-07-18T14:00"),
    false,
  );
});

test("extremeCaution early guard: does NOT block when decisionMode != conviction", () => {
  const aborted = new Set(["BTC:2026-07-18T14:00"]);
  assert.equal(
    checkExtremeCautionEarlyGuard("classic", true, "yes", aborted, "BTC", "2026-07-18T14:00"),
    false,
  );
});

test("extremeCaution early guard: does NOT block when direction=no", () => {
  const aborted = new Set(["BTC:2026-07-18T14:00"]);
  assert.equal(
    checkExtremeCautionEarlyGuard("conviction", true, "no", aborted, "BTC", "2026-07-18T14:00"),
    false,
  );
});

test("extremeCaution early guard: does NOT block when Set is empty (no abort recorded)", () => {
  const aborted = new Set<string>();
  assert.equal(
    checkExtremeCautionEarlyGuard("conviction", true, "yes", aborted, "BTC", "2026-07-18T14:00"),
    false,
  );
});

test("extremeCaution early guard: does NOT block when Set has a DIFFERENT sym:windowKey", () => {
  const aborted = new Set(["ETH:2026-07-18T14:00"]);
  assert.equal(
    checkExtremeCautionEarlyGuard("conviction", true, "yes", aborted, "BTC", "2026-07-18T14:00"),
    false,
  );
});

test("extremeCaution early guard: does NOT block when Set has same sym but different windowKey", () => {
  const aborted = new Set(["BTC:2026-07-18T13:45"]);
  assert.equal(
    checkExtremeCautionEarlyGuard("conviction", true, "yes", aborted, "BTC", "2026-07-18T14:00"),
    false,
  );
});

test("extremeCaution early guard: Set cleared at window transition (new key, guard off)", () => {
  // Abort Set was populated last window; on window transition it is cleared and
  // the new window key is NOT yet in the Set — guard does not fire.
  const aborted = new Set(["BTC:2026-07-18T14:15"]);
  assert.equal(
    checkExtremeCautionEarlyGuard("conviction", true, "yes", aborted, "BTC", "2026-07-18T14:00"),
    false,
  );
});

test("extremeCaution early guard: all four conditions are independently necessary", () => {
  const sym = "XRP";
  const wk = "2026-07-18T15:00";
  const aborted = new Set([`${sym}:${wk}`]);

  // Baseline: all four conditions → blocked
  assert.equal(checkExtremeCautionEarlyGuard("conviction", true, "yes", aborted, sym, wk), true);

  // Flip each condition in turn; result must be false each time.
  assert.equal(checkExtremeCautionEarlyGuard("ml_gate",    true,  "yes", aborted, sym, wk), false, "mode");
  assert.equal(checkExtremeCautionEarlyGuard("conviction", false, "yes", aborted, sym, wk), false, "enabled");
  assert.equal(checkExtremeCautionEarlyGuard("conviction", true,  "no",  aborted, sym, wk), false, "direction");
  assert.equal(checkExtremeCautionEarlyGuard("conviction", true,  "yes", new Set(), sym, wk), false, "set");
});

// ---------------------------------------------------------------------------
// evaluateYesBidFloorAbort — YES cross-check: abort + EC Set population
//
// This is the production logic used by tick.ts.  Tests here verify the same
// code path that runs in the bot, not a local simulation copy.
// ---------------------------------------------------------------------------

test("YES bid-floor abort: aborts and sets EC flag when bid < lockPrice and EC=true", () => {
  const result = evaluateYesBidFloorAbort(0.87, 0.88, false, true);
  assert.equal(result.abort, true);
  assert.equal(result.populateECSet, true);
});

test("YES bid-floor abort: aborts but does NOT set EC flag when EC=false", () => {
  const result = evaluateYesBidFloorAbort(0.87, 0.88, false, false);
  assert.equal(result.abort, true);
  assert.equal(result.populateECSet, false);
});

test("YES bid-floor abort: no abort when freshYesBid >= lockPrice (bid is in zone)", () => {
  // At exactly lockPrice, bid IS in zone — no abort.
  const atFloor = evaluateYesBidFloorAbort(0.88, 0.88, false, true);
  assert.equal(atFloor.abort, false);
  assert.equal(atFloor.populateECSet, false);

  // Above lockPrice — clearly in zone.
  const above = evaluateYesBidFloorAbort(0.90, 0.88, false, true);
  assert.equal(above.abort, false);
  assert.equal(above.populateECSet, false);
});

test("YES bid-floor abort: no abort on poller-fallback path even when bid < lockPrice", () => {
  // usedPollerFallback=true → authenticated book is empty; ask check already
  // confirmed fill price is in zone — bid floor is irrelevant.
  const result = evaluateYesBidFloorAbort(0.80, 0.88, true, true);
  assert.equal(result.abort, false);
  assert.equal(result.populateECSet, false);
});

test("YES bid-floor abort: EC=false on poller-fallback also produces no abort", () => {
  const result = evaluateYesBidFloorAbort(0.80, 0.88, true, false);
  assert.equal(result.abort, false);
  assert.equal(result.populateECSet, false);
});

test("YES bid-floor abort: populateECSet=true means caller MUST add sym:wk to Set", () => {
  // This test documents the caller contract: when populateECSet is true the
  // Set must be updated so checkExtremeCautionEarlyGuard can block later ticks.
  const aborted = new Set<string>();
  const result = evaluateYesBidFloorAbort(0.85, 0.88, false, true);
  assert.equal(result.abort, true);
  assert.equal(result.populateECSet, true);

  // Simulate what tick.ts does when populateECSet is true.
  if (result.populateECSet) aborted.add("BTC:2026-07-18T14:00");

  // Verify that the early guard now fires for subsequent ticks.
  assert.equal(
    checkExtremeCautionEarlyGuard("conviction", true, "yes", aborted, "BTC", "2026-07-18T14:00"),
    true,
    "early guard must block after abort is recorded",
  );
});

test("YES bid-floor abort: when EC=false, early guard must NOT fire even after abort", () => {
  const aborted = new Set<string>();
  const result = evaluateYesBidFloorAbort(0.85, 0.88, false, false);
  assert.equal(result.abort, true);
  assert.equal(result.populateECSet, false);

  // Caller does NOT add to Set when populateECSet=false.
  // Early guard must remain unblocked.
  assert.equal(
    checkExtremeCautionEarlyGuard("conviction", false, "yes", aborted, "BTC", "2026-07-18T14:00"),
    false,
    "early guard must not block when EC is disabled",
  );
});

// ---------------------------------------------------------------------------
// computeNoAskBounceThreshold — NO cross-check bifurcation
//
// EC ON  → exact (1 − lockPrice), no spread tolerance
// EC OFF → (1 − lockPrice) + 0.01  (1¢ spread room)
// ---------------------------------------------------------------------------

test("NO threshold EC=true: lockPrice=0.88 → exact 0.12 (no tolerance)", () => {
  assert.equal(computeNoAskBounceThreshold(0.88, true), 0.12);
});

test("NO threshold EC=false: lockPrice=0.88 → 0.13 (1¢ tolerance above 0.12)", () => {
  assert.equal(computeNoAskBounceThreshold(0.88, false), 0.13);
});

test("NO threshold EC=true: lockPrice=0.90 → exact 0.10", () => {
  assert.equal(computeNoAskBounceThreshold(0.90, true), 0.10);
});

test("NO threshold EC=false: lockPrice=0.90 → 0.11 (1¢ tolerance)", () => {
  assert.equal(computeNoAskBounceThreshold(0.90, false), 0.11);
});

test("NO threshold EC=true: lockPrice=0.91 → exact 0.09 (no IEEE 754 drift)", () => {
  // 1 − 0.91 = 0.09 exactly when rounded to 2 decimal places.
  assert.equal(computeNoAskBounceThreshold(0.91, true), 0.09);
});

test("NO threshold EC=false: lockPrice=0.91 → 0.10 (no IEEE 754 drift)", () => {
  // Raw: (1−0.91)+0.01 = 0.09+0.01; IEEE 754 gives 0.09999...
  // The formula must round to 0.10 to avoid false aborts at exactly 0.10.
  assert.equal(computeNoAskBounceThreshold(0.91, false), 0.10);
});

test("NO threshold EC=true: lockPrice=0.92 → exact 0.08", () => {
  assert.equal(computeNoAskBounceThreshold(0.92, true), 0.08);
});

test("NO threshold EC=false: lockPrice=0.92 → 0.09 (1¢ tolerance)", () => {
  assert.equal(computeNoAskBounceThreshold(0.92, false), 0.09);
});

test("NO threshold: EC=true threshold is always strictly tighter than EC=false", () => {
  for (const lockPrice of [0.88, 0.89, 0.90, 0.91, 0.92]) {
    const ecOn  = computeNoAskBounceThreshold(lockPrice, true);
    const ecOff = computeNoAskBounceThreshold(lockPrice, false);
    assert.ok(
      ecOn < ecOff,
      `lockPrice=${lockPrice}: EC-on threshold ${ecOn} must be < EC-off threshold ${ecOff}`,
    );
  }
});

test("NO threshold: EC=false matches the formula (1−lp)+0.01 for all common lockPrices", () => {
  for (const lockPrice of [0.88, 0.89, 0.90, 0.91, 0.92]) {
    const expected = Math.round(((1 - lockPrice) + 0.01) * 100) / 100;
    assert.equal(
      computeNoAskBounceThreshold(lockPrice, false),
      expected,
      `lockPrice=${lockPrice}`,
    );
  }
});

// ---------------------------------------------------------------------------
// computeExtremeCautionNoAskCeiling — YES EC complement check formula
// Applied only when extremeCautionEnabled (caller's responsibility).
// Ceiling = (1−lockPrice)+0.005, tighter than the NO gate's 0.01 tolerance.
// ---------------------------------------------------------------------------

test("computeExtremeCautionNoAskCeiling: lockPrice=0.88 → 0.125 (0.5¢ above 0.12)", () => {
  assert.equal(computeExtremeCautionNoAskCeiling(0.88), 0.125);
});

test("computeExtremeCautionNoAskCeiling: lockPrice=0.90 → 0.105", () => {
  assert.equal(computeExtremeCautionNoAskCeiling(0.90), 0.105);
});

test("computeExtremeCautionNoAskCeiling: lockPrice=0.91 → 0.095", () => {
  assert.equal(computeExtremeCautionNoAskCeiling(0.91), 0.095);
});

test("computeExtremeCautionNoAskCeiling: lockPrice=0.92 → 0.085", () => {
  assert.equal(computeExtremeCautionNoAskCeiling(0.92), 0.085);
});

test("EC NO-ask ceiling is tighter than NO bounce threshold (EC=false) for same lockPrice", () => {
  // EC ceiling (0.005 tolerance) < NO bounce threshold EC-off (0.01 tolerance).
  // This confirms the complement guard is always more conservative than the standard NO gate.
  for (const lockPrice of [0.88, 0.89, 0.90, 0.91, 0.92]) {
    const ceiling  = computeExtremeCautionNoAskCeiling(lockPrice);
    const noBounce = computeNoAskBounceThreshold(lockPrice, false);
    assert.ok(
      ceiling < noBounce,
      `lockPrice=${lockPrice}: EC ceiling ${ceiling} must be < NO bounce threshold (EC off) ${noBounce}`,
    );
  }
});

test("EC NO-ask ceiling: EC ceiling is also tighter than NO threshold EC=true", () => {
  // Even when EC is on and the NO threshold is exact (1-lp), the complement
  // ceiling (1-lp+0.005) is 0.5¢ wider — which is correct: the ceiling
  // allows a tiny spread while the NO threshold is strict.
  // Documenting the relationship explicitly.
  for (const lockPrice of [0.88, 0.89, 0.90, 0.91, 0.92]) {
    const ceiling  = computeExtremeCautionNoAskCeiling(lockPrice); // (1-lp)+0.005
    const noThresholdEcOn = computeNoAskBounceThreshold(lockPrice, true); // exact (1-lp)
    assert.ok(
      ceiling > noThresholdEcOn,
      `lockPrice=${lockPrice}: EC ceiling ${ceiling} > NO threshold EC=true ${noThresholdEcOn}`,
    );
  }
});

// ---------------------------------------------------------------------------
// selectTimeBetBracket — highest matching bracket wins; null on no match
// ---------------------------------------------------------------------------

const sched = [
  { minutesElapsed: 3,  betAmount: 1.0 },
  { minutesElapsed: 7,  betAmount: 2.0 },
  { minutesElapsed: 11, betAmount: 3.0 },
];

test("selectTimeBetBracket: returns null when elapsed < earliest bracket", () => {
  assert.equal(selectTimeBetBracket(sched, 1),   null);
  assert.equal(selectTimeBetBracket(sched, 2.9), null);
});

test("selectTimeBetBracket: matches first bracket at exactly its threshold", () => {
  const match = selectTimeBetBracket(sched, 3);
  assert.ok(match != null);
  assert.equal(match.minutesElapsed, 3);
  assert.equal(match.betAmount, 1.0);
});

test("selectTimeBetBracket: highest matching bracket wins between 3 and 7", () => {
  const match = selectTimeBetBracket(sched, 5);
  assert.ok(match != null);
  assert.equal(match.minutesElapsed, 3);
  assert.equal(match.betAmount, 1.0);
});

test("selectTimeBetBracket: steps up to second bracket at exactly its threshold", () => {
  const match = selectTimeBetBracket(sched, 7);
  assert.ok(match != null);
  assert.equal(match.minutesElapsed, 7);
  assert.equal(match.betAmount, 2.0);
});

test("selectTimeBetBracket: highest matching bracket wins between 7 and 11", () => {
  const match = selectTimeBetBracket(sched, 9);
  assert.ok(match != null);
  assert.equal(match.minutesElapsed, 7);
  assert.equal(match.betAmount, 2.0);
});

test("selectTimeBetBracket: steps up to third bracket at exactly its threshold", () => {
  const match = selectTimeBetBracket(sched, 11);
  assert.ok(match != null);
  assert.equal(match.minutesElapsed, 11);
  assert.equal(match.betAmount, 3.0);
});

test("selectTimeBetBracket: stays on highest bracket past the end (minute 14)", () => {
  const match = selectTimeBetBracket(sched, 14);
  assert.ok(match != null);
  assert.equal(match.minutesElapsed, 11);
  assert.equal(match.betAmount, 3.0);
});

test("selectTimeBetBracket: empty schedule always returns null", () => {
  assert.equal(selectTimeBetBracket([], 0),  null);
  assert.equal(selectTimeBetBracket([], 10), null);
});

test("selectTimeBetBracket: single bracket — null before, match at and after", () => {
  const single = [{ minutesElapsed: 5, betAmount: 1.5 }];
  assert.equal(selectTimeBetBracket(single, 4), null);
  assert.equal(selectTimeBetBracket(single, 5)?.minutesElapsed,  5);
  assert.equal(selectTimeBetBracket(single, 14)?.minutesElapsed, 5);
});

test("selectTimeBetBracket: correctly handles out-of-order schedule input", () => {
  const unsorted = [
    { minutesElapsed: 7,  betAmount: 2.0 },
    { minutesElapsed: 3,  betAmount: 1.0 },
    { minutesElapsed: 11, betAmount: 3.0 },
  ];
  const match5 = selectTimeBetBracket(unsorted, 5);
  assert.ok(match5 != null);
  assert.equal(match5.minutesElapsed, 3, "highest bracket ≤ 5 must be the 3-min bracket");

  const match8 = selectTimeBetBracket(unsorted, 8);
  assert.ok(match8 != null);
  assert.equal(match8.minutesElapsed, 7, "highest bracket ≤ 8 must be the 7-min bracket");
});

test("selectTimeBetBracket: does not mutate the input array", () => {
  const input = [
    { minutesElapsed: 7, betAmount: 2.0 },
    { minutesElapsed: 3, betAmount: 1.0 },
  ];
  const before = [...input];
  selectTimeBetBracket(input, 5);
  assert.deepEqual(input, before, "input array must not be mutated");
});
