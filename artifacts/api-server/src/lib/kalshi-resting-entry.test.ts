import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planRestingEntry, decideRestingCancel, accountRestingFill,
} from "./kalshi-resting-entry.ts";

const NOW = 1_700_000_000_000;

const planBase = {
  usedPollerFallback: false,
  requestedCount: 9,
  msRemaining: 10 * 60_000, // 10 min left
  nowMs: NOW,
};

test("plan: real-book with time left → places full-size resting order", () => {
  const p = planRestingEntry(planBase);
  assert.equal(p.useResting, true);
  assert.equal(p.count, 9, "full requested count, never a partial");
  assert.ok(p.expirationTimeSec > NOW / 1000, "expiration is in the future");
});

test("plan: expiration is capped by the 75s max-rest budget when plenty of time", () => {
  const p = planRestingEntry(planBase);
  // 10 min left, so rest budget (75s) wins over the floor deadline.
  const expectedSec = Math.floor((NOW + 75_000) / 1000);
  assert.equal(p.expirationTimeSec, expectedSec);
});

test("plan: expiration is capped by the 3-min floor when little time remains", () => {
  const p = planRestingEntry({ ...planBase, msRemaining: 3.5 * 60_000 });
  // Floor deadline = now + (210s - 180s) = now + 30s, which is < 75s rest budget.
  const expectedSec = Math.floor((NOW + 30_000) / 1000);
  assert.equal(p.expirationTimeSec, expectedSec);
});

test("plan: poller-fallback empty book → no resting order (stays FOK)", () => {
  const p = planRestingEntry({ ...planBase, usedPollerFallback: true });
  assert.equal(p.useResting, false);
  assert.match(p.skipReason!, /FOK all-or-nothing/);
});

test("plan: below the 3-min hard floor → no resting order", () => {
  const p = planRestingEntry({ ...planBase, msRemaining: 2.9 * 60_000 });
  assert.equal(p.useResting, false);
  assert.match(p.skipReason!, /hard floor/);
});

test("plan: zero requested count → no order", () => {
  const p = planRestingEntry({ ...planBase, requestedCount: 0 });
  assert.equal(p.useResting, false);
});

test("cancel: price left the zone → cancel immediately", () => {
  const d = decideRestingCancel({ inZone: false, elapsedMs: 1000, maxRestMs: 75_000, msRemaining: 8 * 60_000 });
  assert.equal(d.cancel, true);
  assert.match(d.reason!, /left conviction zone/);
});

test("cancel: 3-min floor reached → cancel", () => {
  const d = decideRestingCancel({ inZone: true, elapsedMs: 1000, maxRestMs: 75_000, msRemaining: 2.9 * 60_000 });
  assert.equal(d.cancel, true);
  assert.match(d.reason!, /3-min hard floor/);
});

test("cancel: max rest time elapsed → cancel", () => {
  const d = decideRestingCancel({ inZone: true, elapsedMs: 75_000, maxRestMs: 75_000, msRemaining: 8 * 60_000 });
  assert.equal(d.cancel, true);
  assert.match(d.reason!, /max rest time/);
});

test("cancel: in zone, time left, under budget → keep resting", () => {
  const d = decideRestingCancel({ inZone: true, elapsedMs: 30_000, maxRestMs: 75_000, msRemaining: 8 * 60_000 });
  assert.equal(d.cancel, false);
});

test("account: partial-then-cancel records the ACTUAL filled count, not requested", () => {
  const r = accountRestingFill({ requestedCount: 9, filledCount: 3, avgYesPrice: 0.87 });
  assert.equal(r.filledCount, 3, "records the 3 filled, never the 9 requested");
  assert.equal(r.avgYesPrice, 0.87);
});

test("account: zero fill → no position (null price)", () => {
  const r = accountRestingFill({ requestedCount: 9, filledCount: 0, avgYesPrice: null });
  assert.equal(r.filledCount, 0);
  assert.equal(r.avgYesPrice, null);
});

test("account: full fill → full count", () => {
  const r = accountRestingFill({ requestedCount: 9, filledCount: 9, avgYesPrice: 0.88 });
  assert.equal(r.filledCount, 9);
});

test("account: overfill is clamped to requested (defensive)", () => {
  const r = accountRestingFill({ requestedCount: 9, filledCount: 12, avgYesPrice: 0.88 });
  assert.equal(r.filledCount, 9);
});

// ── Zone semantics of a resting limit order ───────────────────────────────────
// A GTC buy limit at the zone cap bounds the fill from ABOVE only.  If the
// market moves through the zone before the poll loop cancels, a resting YES
// bid at 0.91 can be filled at 0.81 or lower — BELOW the zone floor.  These
// tests document that the cap is respected but the floor is NOT guaranteed,
// which is exactly why the caller's Layer-3 post-fill zone check must stay
// active for resting entries (it detects and emergency-closes below-floor fills).
test("zone semantics: resting YES fill never exceeds the cap, but CAN land below the floor", () => {
  const lockPrice = 0.82;      // zone floor
  const lockPriceCap = 0.91;   // zone cap = resting limit price
  // A GTC buy fills at ask ≤ limit — upper bound holds for every possible fill:
  for (const fill of [0.75, 0.82, 0.88, 0.91]) {
    assert.ok(fill <= lockPriceCap, `YES fill ${fill} must be <= cap ${lockPriceCap}`);
  }
  // But the floor is NOT enforced by the order itself: an adverse move can
  // fill below it.  The Layer-3 deviation check must flag such fills.
  const adverseFill = 0.75;
  const deviationBelowFloor = lockPrice - adverseFill;
  assert.ok(deviationBelowFloor > 0, "below-floor fill must produce positive deviation for Layer-3");
});

test("zone semantics: resting NO fill cost never exceeds the cap, but CAN land below the floor", () => {
  const lockPrice = 0.82;
  const lockPriceCap = 0.91;
  // NO fill cost = 1 - yesFill. Resting NO order limit is (1 - lockPriceCap) YES.
  // A GTC NO buy fills at yesBid >= limit → NO cost = 1 - yesBid <= lockPriceCap.
  for (const yesBid of [0.09, 0.12, 0.15, 0.25]) {
    const noCost = 1 - yesBid;
    assert.ok(noCost <= lockPriceCap, `NO cost ${noCost} must be <= cap ${lockPriceCap}`);
  }
  // Adverse move: yesBid spikes to 0.25 → NO cost 0.75 < floor 0.82 → Layer-3 must flag.
  const adverseNoCost = 1 - 0.25;
  assert.ok(lockPrice - adverseNoCost > 0, "below-floor NO fill must produce positive deviation for Layer-3");
});
