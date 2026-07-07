// Behavioral tests for the clock-derived timing guards in the Phase-3 bot loop.
//
// These tests exercise the EXACT runtime logic extracted from kalshi-bot-loop.ts
// and simulate clock progression through a 15-minute window, confirming:
//
//   1. No coin transitions from SKIP to BET_* before clockElapsedS >= bufferS
//   2. The reason string counts down correctly across ticks
//   3. The late-floor guard fires at the right second
//   4. freeRunMode disables the entry buffer (so the bot can be tested at t=0)
//
// Architecture note:
//   The guard logic is inline in kalshi-bot-loop.ts; these tests replicate
//   the exact formula (including Math.max, Math.ceil, Math.floor) so any
//   drift between the test and the live code is caught by the wiring tests
//   in kalshi-bot-guards.test.ts which assert the source-string form.
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Pure helpers — identical to the inline logic in kalshi-bot-loop.ts so we
// can exercise the behaviour without importing the module (which has DB deps).
// ---------------------------------------------------------------------------

/**
 * Compute clockElapsedS exactly as the Phase-3 loop does.
 * windowBoundaryMs is new Date(windowKey).getTime(); nowMs is Date.now().
 */
function computeClockElapsedS(windowBoundaryMs: number, nowMs: number): number {
  return Math.max(0, (nowMs - windowBoundaryMs) / 1000);
}

/**
 * Simulate one Phase-3 entry-buffer evaluation for a single coin.
 * Returns an object mirroring the evalResult pushed by the loop.
 */
function evalEntryBuffer(opts: {
  clockElapsedS: number;
  entryBufferS: number;
  freeRunMode: boolean;
}): { action: "SKIP" | "CONTINUE"; reason: string | null } {
  const { clockElapsedS, entryBufferS, freeRunMode } = opts;
  if (!freeRunMode && clockElapsedS < entryBufferS) {
    const remaining = Math.ceil(entryBufferS - clockElapsedS);
    const elapsed   = Math.floor(clockElapsedS);
    return {
      action: "SKIP",
      reason: `window buffer (${remaining}s remaining \u2014 ${elapsed}s of ${entryBufferS}s elapsed)`,
    };
  }
  return { action: "CONTINUE", reason: null };
}

/**
 * Simulate the maxEntryMinutes ceiling check.
 */
function evalEntryCeiling(opts: {
  clockElapsedS: number;
  maxEntryMinutes: number;
}): { action: "SKIP" | "CONTINUE"; reason: string | null } {
  const { clockElapsedS, maxEntryMinutes } = opts;
  if (maxEntryMinutes > 0 && clockElapsedS > maxEntryMinutes * 60) {
    return {
      action: "SKIP",
      reason: `past entry ceiling (>${maxEntryMinutes}min elapsed, clock=${Math.floor(clockElapsedS)}s)`,
    };
  }
  return { action: "CONTINUE", reason: null };
}

/**
 * Simulate the minRemainingMinutes late-floor check.
 */
function evalLateFloor(opts: {
  clockElapsedS: number;
  minRemainingMinutes: number;
}): { action: "SKIP" | "CONTINUE"; reason: string | null } {
  const { clockElapsedS, minRemainingMinutes } = opts;
  if (minRemainingMinutes > 0 && 15 * 60 - clockElapsedS < minRemainingMinutes * 60) {
    return {
      action: "SKIP",
      reason: `min-remaining floor (<${minRemainingMinutes}min remaining, clock=${Math.floor(clockElapsedS)}s elapsed)`,
    };
  }
  return { action: "CONTINUE", reason: null };
}

// ===========================================================================
// clockElapsedS formula — boundary conditions
// ===========================================================================

test("clockElapsedS: at the exact window boundary → 0s elapsed", () => {
  const boundary = new Date("2026-07-07T07:30:00.000Z").getTime();
  assert.equal(computeClockElapsedS(boundary, boundary), 0);
});

test("clockElapsedS: 119s after boundary → 119s elapsed", () => {
  const boundary = new Date("2026-07-07T07:30:00.000Z").getTime();
  const result = computeClockElapsedS(boundary, boundary + 119_000);
  assert.ok(Math.abs(result - 119) < 0.001, `expected ~119 but got ${result}`);
});

test("clockElapsedS: 120s after boundary → 120s elapsed (buffer expiry)", () => {
  const boundary = new Date("2026-07-07T07:30:00.000Z").getTime();
  const result = computeClockElapsedS(boundary, boundary + 120_000);
  assert.ok(Math.abs(result - 120) < 0.001, `expected ~120 but got ${result}`);
});

test("clockElapsedS: clock skew (nowMs < boundary) → clamped to 0, never negative", () => {
  const boundary = new Date("2026-07-07T07:30:00.000Z").getTime();
  // Simulate clock that is 5s behind the window boundary
  assert.equal(computeClockElapsedS(boundary, boundary - 5_000), 0);
});

// ===========================================================================
// Entry buffer — SKIP before 120s, CONTINUE at and after 120s
// ===========================================================================

const BUFFER_S = 120;

test("entryBuffer: at t=0s → SKIP with full buffer remaining", () => {
  const result = evalEntryBuffer({ clockElapsedS: 0, entryBufferS: BUFFER_S, freeRunMode: false });
  assert.equal(result.action, "SKIP");
  assert.ok(result.reason?.includes("window buffer ("), "reason must start with 'window buffer ('");
  assert.ok(result.reason?.includes("120s remaining"), `expected '120s remaining' in: ${result.reason}`);
  assert.ok(result.reason?.includes("0s of 120s elapsed"), `expected '0s of 120s elapsed' in: ${result.reason}`);
});

test("entryBuffer: at t=60s → SKIP with 60s remaining", () => {
  const result = evalEntryBuffer({ clockElapsedS: 60, entryBufferS: BUFFER_S, freeRunMode: false });
  assert.equal(result.action, "SKIP");
  assert.ok(result.reason?.includes("60s remaining"), `expected '60s remaining' in: ${result.reason}`);
  assert.ok(result.reason?.includes("60s of 120s elapsed"), `expected '60s of 120s elapsed' in: ${result.reason}`);
});

test("entryBuffer: at t=119s → SKIP with 1s remaining", () => {
  const result = evalEntryBuffer({ clockElapsedS: 119, entryBufferS: BUFFER_S, freeRunMode: false });
  assert.equal(result.action, "SKIP");
  assert.ok(result.reason?.includes("1s remaining"), `expected '1s remaining' in: ${result.reason}`);
});

test("entryBuffer: at t=119.5s → SKIP, remaining rounds UP to 1s (Math.ceil)", () => {
  const result = evalEntryBuffer({ clockElapsedS: 119.5, entryBufferS: BUFFER_S, freeRunMode: false });
  assert.equal(result.action, "SKIP");
  // Math.ceil(120 - 119.5) = Math.ceil(0.5) = 1
  assert.ok(result.reason?.includes("1s remaining"), `expected '1s remaining' after Math.ceil: ${result.reason}`);
});

test("entryBuffer: at t=120s (exact expiry) → CONTINUE, buffer gate no longer fires", () => {
  const result = evalEntryBuffer({ clockElapsedS: 120, entryBufferS: BUFFER_S, freeRunMode: false });
  assert.equal(result.action, "CONTINUE");
  assert.equal(result.reason, null);
});

test("entryBuffer: at t=121s → CONTINUE (past buffer, entry permitted)", () => {
  const result = evalEntryBuffer({ clockElapsedS: 121, entryBufferS: BUFFER_S, freeRunMode: false });
  assert.equal(result.action, "CONTINUE");
});

test("entryBuffer: freeRunMode=true at t=0s → CONTINUE (buffer bypassed for testing)", () => {
  const result = evalEntryBuffer({ clockElapsedS: 0, entryBufferS: BUFFER_S, freeRunMode: true });
  assert.equal(result.action, "CONTINUE", "freeRunMode must bypass the entry buffer so the bot can be tested");
});

// ===========================================================================
// Entry buffer — countdown monotonicity across a full window simulation
//
// Simulates ticks every 30s from t=0 to t=150s and asserts:
//   • remaining seconds strictly decrease over time while buffer is active
//   • action flips from SKIP to CONTINUE exactly at t=120s
//   • no tick before 120s shows CONTINUE (no early-entry bug)
// ===========================================================================

test("entryBuffer/monotonicity: remaining decreases across ticks; no early CONTINUE before t=120s", () => {
  const ticksS = [0, 30, 60, 90, 119, 120, 121, 150];
  let prevRemaining = Infinity;

  for (const t of ticksS) {
    const result = evalEntryBuffer({ clockElapsedS: t, entryBufferS: BUFFER_S, freeRunMode: false });

    if (t < BUFFER_S) {
      assert.equal(result.action, "SKIP",
        `at t=${t}s: expected SKIP but got ${result.action} — early entry bug!`);
      // Parse remaining from reason string
      const match = result.reason?.match(/^window buffer \((\d+)s remaining/);
      assert.ok(match, `at t=${t}s: reason string must match 'window buffer (Ns remaining...' — got: ${result.reason}`);
      const remaining = parseInt(match![1], 10);
      assert.ok(remaining <= prevRemaining,
        `at t=${t}s: remaining=${remaining} must be <= previous=${prevRemaining} (not monotonically decreasing)`);
      prevRemaining = remaining;
    } else {
      assert.equal(result.action, "CONTINUE",
        `at t=${t}s: expected CONTINUE (buffer expired at ${BUFFER_S}s) but got SKIP — late-release bug!`);
    }
  }
});

test("entryBuffer/monotonicity: elapsed seconds in reason string increase across ticks (Math.floor)", () => {
  // Confirms the 'Xs of 120s elapsed' part increments in step with real time
  const samples = [0, 30, 60, 90, 119];
  let prevElapsed = -1;

  for (const t of samples) {
    const result = evalEntryBuffer({ clockElapsedS: t, entryBufferS: BUFFER_S, freeRunMode: false });
    const match = result.reason?.match(/\u2014 (\d+)s of 120s elapsed/);
    assert.ok(match, `at t=${t}s: elapsed part not found in reason: ${result.reason}`);
    const elapsed = parseInt(match![1], 10);
    assert.ok(elapsed >= prevElapsed,
      `at t=${t}s: elapsed=${elapsed} did not increase from previous=${prevElapsed}`);
    prevElapsed = elapsed;
  }
});

// ===========================================================================
// maxEntryMinutes ceiling guard — uses clockElapsedS (not secondsElapsed)
// ===========================================================================

test("entryCeiling: within 12 minutes → CONTINUE", () => {
  const result = evalEntryCeiling({ clockElapsedS: 12 * 60, maxEntryMinutes: 12 });
  assert.equal(result.action, "CONTINUE", "exactly at the ceiling should not block");
});

test("entryCeiling: one second past 12-minute ceiling → SKIP", () => {
  const result = evalEntryCeiling({ clockElapsedS: 12 * 60 + 1, maxEntryMinutes: 12 });
  assert.equal(result.action, "SKIP");
  assert.ok(result.reason?.includes("past entry ceiling (>12min elapsed"),
    `reason missing 'past entry ceiling': ${result.reason}`);
  assert.ok(result.reason?.includes("clock="), "ceiling reason must include clock= value");
});

test("entryCeiling: maxEntryMinutes=0 → ceiling disabled, always CONTINUE", () => {
  const result = evalEntryCeiling({ clockElapsedS: 900, maxEntryMinutes: 0 });
  assert.equal(result.action, "CONTINUE", "maxEntryMinutes=0 must disable the ceiling");
});

// ===========================================================================
// minRemainingMinutes late-floor guard — uses clockElapsedS
// ===========================================================================

test("lateFloor: at t=11min with 3min floor → 4min left → CONTINUE", () => {
  // 15 - 11 = 4 min remaining, floor is 3 min — should pass
  const result = evalLateFloor({ clockElapsedS: 11 * 60, minRemainingMinutes: 3 });
  assert.equal(result.action, "CONTINUE");
});

test("lateFloor: at t=12min01s with 3min floor → 2m59s left → SKIP", () => {
  // 15*60 - (12*60+1) = 179s remaining; 3*60 = 180s floor → 179 < 180 → SKIP
  const elapsed = 12 * 60 + 1;
  const result = evalLateFloor({ clockElapsedS: elapsed, minRemainingMinutes: 3 });
  assert.equal(result.action, "SKIP");
  assert.ok(result.reason?.includes("<3min remaining"), `expected '<3min remaining' in: ${result.reason}`);
  assert.ok(result.reason?.includes(`clock=${elapsed}s`), `reason must contain clock=${elapsed}s`);
});

test("lateFloor: at t=15min (window end) with any positive floor → SKIP", () => {
  const result = evalLateFloor({ clockElapsedS: 15 * 60, minRemainingMinutes: 1 });
  assert.equal(result.action, "SKIP");
});

test("lateFloor: minRemainingMinutes=0 → floor disabled, always CONTINUE", () => {
  const result = evalLateFloor({ clockElapsedS: 15 * 60, minRemainingMinutes: 0 });
  assert.equal(result.action, "CONTINUE", "minRemainingMinutes=0 must disable the floor");
});

// ===========================================================================
// Integration: entry buffer followed by late-floor across a full window
//
// Simulates the Phase-3 evaluation at every minute boundary for a 15-min
// window with buffer=120s and minRemaining=3min.  Verifies:
//   • buffer blocks entry for first 2 minutes
//   • entry is permitted from t=2min to t=12min
//   • late-floor blocks entry from t=12min onward
// ===========================================================================

test("full-window integration: buffer→open→late-floor transitions at correct boundaries", () => {
  const ENTRY_BUFFER   = 120;      // 2 min
  const MIN_REMAINING  = 3;        // 3 min floor  → blocks after t=12:00
  const WINDOW_LEN_S   = 15 * 60;  // 900s

  for (let minuteMark = 0; minuteMark <= 15; minuteMark++) {
    const clockElapsedS = minuteMark * 60;

    const buf   = evalEntryBuffer({ clockElapsedS, entryBufferS: ENTRY_BUFFER, freeRunMode: false });
    const floor = evalLateFloor({ clockElapsedS, minRemainingMinutes: MIN_REMAINING });

    const inBuffer    = clockElapsedS < ENTRY_BUFFER;
    const inLateFloor = WINDOW_LEN_S - clockElapsedS < MIN_REMAINING * 60;
    const entryOpen   = !inBuffer && !inLateFloor;

    if (inBuffer) {
      assert.equal(buf.action, "SKIP",
        `t=${minuteMark}min: should be in buffer (first 2 min) — expected SKIP, got ${buf.action}`);
    } else if (inLateFloor) {
      assert.equal(floor.action, "SKIP",
        `t=${minuteMark}min: should be past late-floor (last 3 min) — expected SKIP, got ${floor.action}`);
      assert.equal(buf.action, "CONTINUE",
        `t=${minuteMark}min: buffer should be cleared before late-floor kicks in`);
    } else {
      assert.ok(entryOpen, `t=${minuteMark}min: should be in open entry window`);
      assert.equal(buf.action, "CONTINUE",
        `t=${minuteMark}min: buffer must be CONTINUE during open window — got SKIP (early-entry bug!)`);
      assert.equal(floor.action, "CONTINUE",
        `t=${minuteMark}min: floor must be CONTINUE during open window — got SKIP (early-floor bug!)`);
    }
  }
});
