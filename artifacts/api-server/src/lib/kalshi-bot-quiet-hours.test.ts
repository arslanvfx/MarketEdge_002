// Unit tests for Smart Quiet Hours V2 — two core behaviors:
//
//   1. V2 precedence: when quietHoursV2.enabled is true, the legacy quiet
//      hours range gate is skipped and V2 controls all hour-based entry gating.
//
//   2. Reduced-bet hard cap: the V2 reduced-bet cap is a hard ceiling applied
//      after all other sizing — including a matching time-bet schedule bracket —
//      so a reduced-bet hour cannot produce a bet larger than the cap regardless
//      of which other sizing path fired.
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BOT_CONFIG,
  isInQuietHours,
  shouldApplyLoopGlobalQuietHours,
  type BotConfig,
  type QuietHoursV2,
} from "./kalshi-bot-engine-core.ts";

// ---------------------------------------------------------------------------
// Helper: simulates the loop-level quiet-hours gating logic.
//
// Returns:
//   "legacy-blocked"  — the legacy range gate fired and would return early
//   "v2-silenced"     — V2 is enabled and the hour is in silencedUtcHours
//   "v2-reduced"      — V2 is enabled, not silenced, has a reduced-bet amount
//   "active"          — no gate fired; bot proceeds to entry normally
// ---------------------------------------------------------------------------

function simulateQuietHoursGate(
  config: BotConfig,
  utcHour: number,
): "legacy-blocked" | "v2-silenced" | "v2-reduced" | "active" {
  const freeRun = config.freeRunMode ?? false;

  // Legacy gate — compatibility only for configs that never adopted V2.
  // A present-but-disabled V2 object is the authoritative Smart Hours OFF state.
  if (!freeRun && config.quietHoursV2 == null && isInQuietHours(utcHour, config.quietHoursStart, config.quietHoursEnd)) {
    return "legacy-blocked";
  }

  // V2 gate
  const qhv2 = config.quietHoursV2;
  if (!freeRun && qhv2?.enabled) {
    if (qhv2.silencedUtcHours.includes(utcHour)) return "v2-silenced";
    const reduced = qhv2.reducedBetUtcHours[String(utcHour)];
    if (reduced != null && reduced > 0) return "v2-reduced";
  }

  return "active";
}

// ---------------------------------------------------------------------------
// Helper: simulates the tick-level reduced-bet cap logic.
//
// applyCap(targetBetSize, quietHoursV2ReducedBet) → final bet size
// ---------------------------------------------------------------------------

function applyReducedBetCap(
  targetBetSize: number,
  quietHoursV2ReducedBet: number | null,
): number {
  // Exact mirror of the tick code (cap is hard — no betScheduleApplied check)
  if (quietHoursV2ReducedBet != null && quietHoursV2ReducedBet > 0) {
    if (targetBetSize > quietHoursV2ReducedBet) return quietHoursV2ReducedBet;
  }
  return targetBetSize;
}

// ---------------------------------------------------------------------------
// Tests — V2 precedence over legacy gate
// ---------------------------------------------------------------------------

test("quiet-hours v2 precedence: legacy gate fires only when V2 is absent", () => {
  // Legacy range 08:00–16:00 UTC on an old config with no V2 object.
  const cfg: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    quietHoursStart: 8,
    quietHoursEnd: 16,
    quietHoursV2: undefined,
  };
  // UTC hour 10 is inside the legacy range
  assert.equal(simulateQuietHoursGate(cfg, 10), "legacy-blocked");
});

test("quiet-hours v2 precedence: disabled V2 master bypasses legacy", () => {
  const cfg: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    quietHoursStart: 8,
    quietHoursEnd: 16,
    quietHoursV2: { enabled: false, silencedUtcHours: [], reducedBetUtcHours: {} },
  };
  assert.equal(simulateQuietHoursGate(cfg, 10), "active");
});

test("quiet-hours v2 precedence: legacy gate is bypassed when V2 is enabled", () => {
  // Same legacy range, but V2 is enabled with hour 10 NOT silenced
  const cfg: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    quietHoursStart: 8,
    quietHoursEnd: 16,
    quietHoursV2: { enabled: true, silencedUtcHours: [], reducedBetUtcHours: {} },
  };
  // Hour 10 would be blocked by legacy, but V2 is enabled and doesn't silence it
  assert.equal(simulateQuietHoursGate(cfg, 10), "active");
});

test("quiet-hours v2 precedence: V2 silences hours the legacy range does not cover", () => {
  // Legacy range disabled (start === end = 7), V2 silences hour 22
  const cfg: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    quietHoursStart: 7,
    quietHoursEnd: 7,
    quietHoursV2: { enabled: true, silencedUtcHours: [22], reducedBetUtcHours: {} },
  };
  assert.equal(simulateQuietHoursGate(cfg, 22), "v2-silenced");
  // Hours not in the V2 silenced list are active
  assert.equal(simulateQuietHoursGate(cfg, 10), "active");
});

test("quiet-hours v2 precedence: legacy range AND V2 silenced hours can coexist — V2 wins", () => {
  // Hour 10 is inside legacy range AND silenced by V2; result is v2-silenced not legacy-blocked
  const cfg: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    quietHoursStart: 8,
    quietHoursEnd: 16,
    quietHoursV2: { enabled: true, silencedUtcHours: [10], reducedBetUtcHours: {} },
  };
  // V2 wins classification — v2-silenced (not legacy-blocked)
  assert.equal(simulateQuietHoursGate(cfg, 10), "v2-silenced");
});

test("quiet-hours v2 precedence: V2 reduced-bet hour is not silenced", () => {
  const cfg: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    quietHoursStart: 8,
    quietHoursEnd: 16,
    quietHoursV2: {
      enabled: true,
      silencedUtcHours: [],
      reducedBetUtcHours: { "10": 0.50 },
    },
  };
  // Hour 10 would be legacy-blocked, but V2 is active → reduced instead
  assert.equal(simulateQuietHoursGate(cfg, 10), "v2-reduced");
});

test("quiet-hours v2 precedence: freeRunMode bypasses both legacy and V2", () => {
  const cfg: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    freeRunMode: true,
    quietHoursStart: 0,
    quietHoursEnd: 23,
    quietHoursV2: { enabled: true, silencedUtcHours: Array.from({ length: 24 }, (_, i) => i), reducedBetUtcHours: {} },
  };
  // All hours silenced in V2 and legacy — freeRun overrides everything
  assert.equal(simulateQuietHoursGate(cfg, 12), "active");
});

test("loop quiet-hours optimization runs only in global mode", () => {
  assert.equal(shouldApplyLoopGlobalQuietHours({ quietHoursMode: "global" }), true);
  assert.equal(shouldApplyLoopGlobalQuietHours({ quietHoursMode: undefined }), true);
  assert.equal(shouldApplyLoopGlobalQuietHours({ quietHoursMode: "per_market" }), false);
});

// ---------------------------------------------------------------------------
// Tests — reduced-bet hard cap (no betScheduleApplied bypass)
// ---------------------------------------------------------------------------

test("reduced-bet cap: caps target when target exceeds reduced amount", () => {
  assert.equal(applyReducedBetCap(2.00, 0.50), 0.50);
});

test("reduced-bet cap: does not increase target when target is already below cap", () => {
  assert.equal(applyReducedBetCap(0.25, 0.50), 0.25);
});

test("reduced-bet cap: no-op when quietHoursV2ReducedBet is null", () => {
  assert.equal(applyReducedBetCap(3.00, null), 3.00);
});

test("reduced-bet cap: no-op when quietHoursV2ReducedBet is zero", () => {
  assert.equal(applyReducedBetCap(3.00, 0), 3.00);
});

test("reduced-bet cap: applies even when time-bet schedule has set a higher amount (schedule-bypass regression)", () => {
  // Simulate: time-bet schedule set targetBetSize to 1.50
  // reduced-bet cap is 0.75 → cap must still fire
  const afterSchedule = 1.50;
  const reducedCap = 0.75;
  assert.equal(applyReducedBetCap(afterSchedule, reducedCap), 0.75,
    "V2 reduced cap must override time-bet schedule amount");
});

test("reduced-bet cap: exact boundary — target equals cap → no change", () => {
  assert.equal(applyReducedBetCap(1.00, 1.00), 1.00);
});

test("reduced-bet cap: target one cent above cap → capped", () => {
  const result = applyReducedBetCap(1.01, 1.00);
  assert.ok(result <= 1.00, `Expected cap 1.00, got ${result}`);
});

// ---------------------------------------------------------------------------
// ET-day resolution for byDow rules (regression: UI day tabs are ET days,
// cells are UTC hours — enforcement must resolve "today" in ET, not UTC,
// or every ET-evening rule (UTC hours 0–4) lands under the wrong day).
// ---------------------------------------------------------------------------

import { getEtDow, resolveQuietHoursV2State } from "./kalshi-bot-engine-core.ts";

test("getEtDow: 1:00 UTC Monday is still Sunday in ET", () => {
  // 2026-08-10T01:30Z — Monday in UTC, Sunday 9:30 PM EDT
  const d = new Date("2026-08-10T01:30:00Z");
  assert.equal(d.getUTCDay(), 1);
  assert.equal(getEtDow(d), 0);
});

test("getEtDow: midday UTC matches UTC day", () => {
  const d = new Date("2026-08-10T15:00:00Z"); // Monday both in UTC and ET
  assert.equal(getEtDow(d), 1);
});

test("resolveQuietHoursV2State: Sunday-ET evening reducedByDow rule fires at 1:00 UTC Monday", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    reducedByDow: { "0": { "1": 50 } }, // Sunday ET, 1:00 UTC → 50%
  };
  const st = resolveQuietHoursV2State(qhv2, new Date("2026-08-10T01:30:00Z"));
  assert.equal(st.mode, "reduced");
  assert.equal(st.reducedBetAmount, 50);
});

test("resolveQuietHoursV2State: dow entry is exclusive — flat list ignored for that day", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: { "1": 25 }, // flat all-days 25% at hour 1
    reducedByDow: { "0": {} },       // Sunday ET has its own (empty) rule set
  };
  const st = resolveQuietHoursV2State(qhv2, new Date("2026-08-10T01:30:00Z"));
  assert.equal(st.mode, "active");
});

test("resolveQuietHoursV2State: silencedByDow keyed by ET day fires across UTC midnight", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "0": [2] }, // Sunday ET, 2:00 UTC (10 PM EDT Sunday)
  };
  const st = resolveQuietHoursV2State(qhv2, new Date("2026-08-10T02:15:00Z"));
  assert.equal(st.mode, "silenced");
});

test("resolveQuietHoursV2State: disabled → active regardless of rules", () => {
  const qhv2: QuietHoursV2 = {
    enabled: false,
    silencedUtcHours: [1],
    reducedBetUtcHours: { "1": 50 },
  };
  assert.equal(resolveQuietHoursV2State(qhv2, new Date("2026-08-10T01:30:00Z")).mode, "active");
});

test("resolveQuietHoursV2State: data-gathering percentage remains enforced after a cell becomes active", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    dataGatheringByDow: { "1": [] },
    dataGatheringOverrides: {
      "1": { "15": { type: "percent", pct: 35 } },
    },
  };
  const st = resolveQuietHoursV2State(qhv2, new Date("2026-08-10T15:30:00Z"));
  assert.equal(st.mode, "reduced");
  assert.equal(st.reducedBetAmount, 35);
  assert.notEqual(st.isDataGathering, true);
});

// ---------------------------------------------------------------------------
// Placement-time entry gate (resolveEntryQuietHoursDecision) — the tick-level,
// path-independent Smart Hours check.  Regression for the direct-dispatch
// bypass: entry paths that never pass through the loop gates (pipeline
// trigger, bet-delay timer, conviction dispatch) call this at entry AND again
// immediately before order submission, so a live order can never be placed in
// a silenced hour regardless of dispatch path.
// ---------------------------------------------------------------------------

import { resolveEntryQuietHoursDecision, resolveEntryQuietHoursDecisionForSymbol, applyQuietHoursAutoTuneDeltas, applyPlacementTimeReducedPct } from "./kalshi-bot-engine-core.ts";

// Monday 2026-08-10 15:30 UTC = Monday 11:30 AM EDT (ET dow = 1, UTC hour 15).
const MON_11AM_ET = new Date("2026-08-10T15:30:00Z");

function qhCfg(qhv2: QuietHoursV2 | undefined, extra?: Partial<BotConfig>) {
  return {
    freeRunMode: false,
    quietHoursStart: 7,
    quietHoursEnd: 7, // legacy range disabled (start === end)
    shadowPaperIgnoreQuietHours: false,
    quietHoursV2: qhv2,
    ...extra,
  };
}

test("entry gate: silenced hour blocks a live entry (direct-dispatch bypass regression)", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [15] }, // Monday ET, 15:00 UTC = 11 AM EDT
  };
  const d = resolveEntryQuietHoursDecision(qhCfg(qhv2), "live", MON_11AM_ET);
  assert.equal(d.action, "block");
  assert.equal(d.qhMode, "silenced");
});

test("entry gate: silenced hour blocks paper entries too (no bypass flag)", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [15],
    reducedBetUtcHours: {},
  };
  const d = resolveEntryQuietHoursDecision(qhCfg(qhv2), "paper", MON_11AM_ET);
  assert.equal(d.action, "block");
});

test("entry gate: shadow bypass demotes live to paper — NEVER allows a live order in a silenced hour", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [15] },
  };
  const d = resolveEntryQuietHoursDecision(
    qhCfg(qhv2, { shadowPaperIgnoreQuietHours: true }), "live", MON_11AM_ET,
  );
  assert.equal(d.action, "proceed");
  assert.equal(d.entryMode, "paper", "silenced-hour live entry must be demoted to paper");
  assert.equal(d.forcedPaper, true);
});

test("entry gate: shadow bypass in paper mode still blocks (bypass is live-only)", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [15],
    reducedBetUtcHours: {},
  };
  const d = resolveEntryQuietHoursDecision(
    qhCfg(qhv2, { shadowPaperIgnoreQuietHours: true }), "paper", MON_11AM_ET,
  );
  assert.equal(d.action, "block");
});

test("entry gate: reduced hour proceeds live with reducedPct set", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    reducedByDow: { "1": { "15": 25 } },
  };
  const d = resolveEntryQuietHoursDecision(qhCfg(qhv2), "live", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.entryMode, "live");
  assert.equal(d.reducedPct, 25);
  assert.equal(d.qhMode, "reduced");
});

test("entry gate: hour-boundary transition — reduced at :59, silenced at :00 next hour", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [16] },
    reducedByDow:  { "1": { "15": 50 } },
  };
  const cfg = qhCfg(qhv2);
  const before = resolveEntryQuietHoursDecision(cfg, "live", new Date("2026-08-10T15:59:59Z"));
  assert.equal(before.action, "proceed");
  assert.equal(before.reducedPct, 50);
  const after = resolveEntryQuietHoursDecision(cfg, "live", new Date("2026-08-10T16:00:01Z"));
  assert.equal(after.action, "block", "crossing into a silenced hour must block at placement time");
});

test("entry gate: legacy range enforced only when V2 is ABSENT — bypass demotes to paper", () => {
  // V2 config entirely absent (old config) is the only case that falls back to legacy.
  const cfg = qhCfg(
    undefined,
    { quietHoursStart: 14, quietHoursEnd: 18, shadowPaperIgnoreQuietHours: true },
  );
  const d = resolveEntryQuietHoursDecision(cfg, "live", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.entryMode, "paper");
  assert.equal(d.qhMode, "legacy-silenced");
});

test("entry gate: legacy range blocks without the bypass flag (V2 absent)", () => {
  const cfg = qhCfg(
    undefined,
    { quietHoursStart: 14, quietHoursEnd: 18 },
  );
  assert.equal(resolveEntryQuietHoursDecision(cfg, "live", MON_11AM_ET).action, "block");
});

test("entry gate: disabled Smart Hours master bypasses the legacy range entirely", () => {
  // V2 present but disabled = authoritative master OFF. A legacy range that WOULD
  // silence this hour must NOT be applied — disabling Smart Hours disables ALL
  // schedule enforcement with no hidden legacy fallback.
  const cfg = qhCfg(
    { enabled: false, silencedUtcHours: [], reducedBetUtcHours: {} },
    { quietHoursStart: 14, quietHoursEnd: 18 },
  );
  const d = resolveEntryQuietHoursDecision(cfg, "live", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.entryMode, "live");
  assert.equal(d.qhMode, "active");
});

test("entry gate: freeRunMode bypasses everything", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: Array.from({ length: 24 }, (_, i) => i),
    reducedBetUtcHours: {},
  };
  const d = resolveEntryQuietHoursDecision(qhCfg(qhv2, { freeRunMode: true }), "live", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.entryMode, "live");
});

test("entry gate: active hour proceeds live untouched", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [3],
    reducedBetUtcHours: {},
  };
  const d = resolveEntryQuietHoursDecision(qhCfg(qhv2), "live", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.entryMode, "live");
  assert.equal(d.reducedPct, null);
});

test("entry gate: sparse hour is capped only while data collection is enabled", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    dataGatheringByDow: { "1": [15] },
  };
  const d = resolveEntryQuietHoursDecision(
    qhCfg(qhv2, { dataGatheringEnabled: true }),
    "live",
    MON_11AM_ET,
  );
  assert.equal(d.action, "proceed");
  assert.equal(d.isDataGathering, true);
});

test("entry gate: turning off data collection blocks sparse hours instead of promoting them to active", () => {
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    dataGatheringByDow: { "1": [15] },
  };
  const d = resolveEntryQuietHoursDecision(
    qhCfg(qhv2, { dataGatheringEnabled: false }),
    "live",
    MON_11AM_ET,
  );
  assert.equal(d.action, "block");
  assert.equal(d.qhMode, "silenced");
});

// ---------------------------------------------------------------------------
// Auto-tune merge-safe writes (applyQuietHoursAutoTuneDeltas) — a concurrent
// manual toggle saved between auto-tune's read and write must survive.
// ---------------------------------------------------------------------------

test("auto-tune merge: applies silence/unsilence deltas per-cell", () => {
  const merged = applyQuietHoursAutoTuneDeltas(
    { "1": [10, 15] },
    { "1": { silence: [16], unsilence: [10] } },
    [],
  );
  assert.deepEqual(merged.silencedByDow["1"], [15, 16]);
});

test("auto-tune merge: concurrent manual toggle on ANOTHER cell survives", () => {
  // Auto-tune snapshot saw Monday=[15]. While its query ran, the operator
  // manually silenced Tuesday 12 → freshest map is { "1": [15], "2": [12] }.
  // Auto-tune's delta only touches Monday — Tuesday's manual change must survive.
  const merged = applyQuietHoursAutoTuneDeltas(
    { "1": [15], "2": [12] },          // freshest config at write time
    { "1": { silence: [16], unsilence: [] } }, // deltas computed from stale snapshot
    [],
  );
  assert.deepEqual(merged.silencedByDow["1"], [15, 16]);
  assert.deepEqual(merged.silencedByDow["2"], [12], "manual Tuesday toggle must not be clobbered");
});

test("auto-tune merge: concurrent manual silence on the SAME day, different hour survives", () => {
  // Snapshot: Monday=[15]. Operator adds Monday 20 while query runs.
  // Delta unsilences 15. Result must keep the manual 20.
  const merged = applyQuietHoursAutoTuneDeltas(
    { "1": [15, 20] },
    { "1": { silence: [], unsilence: [15] } },
    [],
  );
  assert.deepEqual(merged.silencedByDow["1"], [20]);
});

test("auto-tune merge: idempotent — re-silencing an already-silenced hour is a no-op", () => {
  const merged = applyQuietHoursAutoTuneDeltas(
    { "1": [15] },
    { "1": { silence: [15], unsilence: [] } },
    [],
  );
  assert.deepEqual(merged.silencedByDow["1"], [15]);
});

test("auto-tune merge: flat fallback = intersection of all configured days", () => {
  const merged = applyQuietHoursAutoTuneDeltas(
    { "0": [3, 15], "1": [15] },
    { "1": { silence: [3], unsilence: [] } },
    [99],
  );
  // After merge: Sun=[3,15], Mon=[3,15] → intersection = [3,15]
  assert.deepEqual(merged.silencedUtcHours, [3, 15]);
});

test("auto-tune merge: no configured days → flat list passes through unchanged", () => {
  const merged = applyQuietHoursAutoTuneDeltas({}, {}, [5, 6]);
  assert.deepEqual(merged.silencedUtcHours, [5, 6]);
  assert.deepEqual(merged.silencedByDow, {});
});

// ---------------------------------------------------------------------------
// Placement-time reduced-% rescale (applyPlacementTimeReducedPct) — a tick
// that sizes in an active (or milder-reduced) hour and reaches order
// submission after crossing into a stricter reduced hour must NOT submit the
// full-size contract count.
// ---------------------------------------------------------------------------

test("reduced rescale: active→reduced crossing shrinks the sized count", () => {
  // Sized 10 contracts with no reduction; hour turned reduced-25% before placement.
  assert.equal(applyPlacementTimeReducedPct(10, null, 25), 2);
});

test("reduced rescale: milder→stricter reduction rescales relative to what was applied", () => {
  // Sizing applied 50% (10 contracts already reflect it); placement hour says 25%.
  // Effective bet must end at 25% of full → 10 × (25/50) = 5.
  assert.equal(applyPlacementTimeReducedPct(10, 50, 25), 5);
});

test("reduced rescale: reduced→active crossing never inflates the bet back up", () => {
  assert.equal(applyPlacementTimeReducedPct(3, 25, null), 3);
});

test("reduced rescale: same percentage at both points is a no-op", () => {
  assert.equal(applyPlacementTimeReducedPct(7, 25, 25), 7);
});

test("reduced rescale: stricter hour can push the count to 0 → caller must reject the order", () => {
  // 1 contract sized full; hour turned reduced-10% → floor(1 × 0.10) = 0.
  assert.equal(applyPlacementTimeReducedPct(1, null, 10), 0);
});

test("reduced rescale: placement-time pct equal or milder keeps the (smaller) sized count", () => {
  // Sizing applied 25%; placement hour is milder 50% — keep the conservative count.
  assert.equal(applyPlacementTimeReducedPct(4, 25, 50), 4);
});

test("entry gate + rescale integration: hour boundary active→reduced between sizing and placement", () => {
  // Simulates the tick timeline the code follows:
  //   sizing at 15:59 (active) → full count; placement at 16:00 (reduced 25%).
  const qhv2: QuietHoursV2 = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    reducedByDow: { "1": { "16": 25 } }, // Monday ET, 16:00 UTC reduced to 25%
  };
  const cfg = qhCfg(qhv2);
  const atSizing = resolveEntryQuietHoursDecision(cfg, "live", new Date("2026-08-10T15:59:50Z"));
  assert.equal(atSizing.reducedPct, null, "sizing hour is active — full size");
  const sizedCount = 8; // full-size contracts computed from targetBetSize
  const atPlacement = resolveEntryQuietHoursDecision(cfg, "live", new Date("2026-08-10T16:00:05Z"));
  assert.equal(atPlacement.reducedPct, 25);
  const submitted = applyPlacementTimeReducedPct(sizedCount, atSizing.reducedPct, atPlacement.reducedPct);
  assert.equal(submitted, 2, "submitted count must honour the placement-time 25% cap");
});

// ---------------------------------------------------------------------------
// Per-market entry gate (resolveEntryQuietHoursDecisionForSymbol) — the global
// quietHoursV2.enabled flag is the AUTHORITATIVE master switch for per_market
// mode too. Master OFF disables ALL per-symbol enforcement (no per-symbol,
// global, or legacy fallback). Master ON enforces the symbol's own schedule;
// a missing/disabled symbol schedule proceeds active.
// ---------------------------------------------------------------------------

// A per-symbol schedule that silences Monday 15:00 UTC for BTC.
const BTC_SILENCED_SCHEDULE: QuietHoursV2 = {
  enabled: true,
  silencedUtcHours: [],
  reducedBetUtcHours: {},
  silencedByDow: { "1": [15] },
};

test("per-market: master OFF bypasses an enabled symbol schedule → proceeds active", () => {
  const cfg = qhCfg(
    { enabled: false, silencedUtcHours: [], reducedBetUtcHours: {} }, // global master OFF
    {
      quietHoursMode: "per_market",
      perSymbolQuietHours: { BTC: BTC_SILENCED_SCHEDULE }, // would silence, but master is off
    },
  );
  const d = resolveEntryQuietHoursDecisionForSymbol(cfg, "live", "BTC", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.entryMode, "live");
  assert.equal(d.qhMode, "active");
});

test("per-market: master OFF also bypasses the legacy range (no hidden fallback)", () => {
  const cfg = qhCfg(
    { enabled: false, silencedUtcHours: [], reducedBetUtcHours: {} },
    {
      quietHoursMode: "per_market",
      quietHoursStart: 14,
      quietHoursEnd: 18, // legacy would silence 15:00 UTC
      perSymbolQuietHours: {},
    },
  );
  const d = resolveEntryQuietHoursDecisionForSymbol(cfg, "live", "BTC", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.qhMode, "active");
});

test("per-market: master ON enforces the symbol's own silenced schedule → blocks live", () => {
  const cfg = qhCfg(
    { enabled: true, silencedUtcHours: [], reducedBetUtcHours: {} }, // global master ON
    {
      quietHoursMode: "per_market",
      perSymbolQuietHours: { BTC: BTC_SILENCED_SCHEDULE },
    },
  );
  const d = resolveEntryQuietHoursDecisionForSymbol(cfg, "live", "BTC", MON_11AM_ET);
  assert.equal(d.action, "block");
  assert.equal(d.qhMode, "silenced");
});

test("per-market: master ON + shadow bypass demotes the symbol's silenced live entry to paper", () => {
  const cfg = qhCfg(
    { enabled: true, silencedUtcHours: [], reducedBetUtcHours: {} },
    {
      quietHoursMode: "per_market",
      shadowPaperIgnoreQuietHours: true,
      perSymbolQuietHours: { BTC: BTC_SILENCED_SCHEDULE },
    },
  );
  const d = resolveEntryQuietHoursDecisionForSymbol(cfg, "live", "BTC", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.entryMode, "paper");
  assert.equal(d.forcedPaper, true);
});

test("per-market: master ON but symbol schedule MISSING → proceeds active (no global/legacy fallback)", () => {
  const cfg = qhCfg(
    { enabled: true, silencedUtcHours: [15], reducedBetUtcHours: {} }, // global would silence 15:00
    {
      quietHoursMode: "per_market",
      quietHoursStart: 14,
      quietHoursEnd: 18, // legacy would silence too
      perSymbolQuietHours: { ETH: BTC_SILENCED_SCHEDULE }, // nothing for BTC
    },
  );
  const d = resolveEntryQuietHoursDecisionForSymbol(cfg, "live", "BTC", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.entryMode, "live");
  assert.equal(d.qhMode, "active");
});

test("per-market: master ON but symbol schedule DISABLED → proceeds active", () => {
  const cfg = qhCfg(
    { enabled: true, silencedUtcHours: [15], reducedBetUtcHours: {} },
    {
      quietHoursMode: "per_market",
      perSymbolQuietHours: {
        BTC: { enabled: false, silencedUtcHours: [15], reducedBetUtcHours: {}, silencedByDow: { "1": [15] } },
      },
    },
  );
  const d = resolveEntryQuietHoursDecisionForSymbol(cfg, "live", "BTC", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.entryMode, "live");
  assert.equal(d.qhMode, "active");
});

test("per-market: master ON enforces the symbol's reduced schedule", () => {
  const cfg = qhCfg(
    { enabled: true, silencedUtcHours: [], reducedBetUtcHours: {} },
    {
      quietHoursMode: "per_market",
      perSymbolQuietHours: {
        BTC: {
          enabled: true,
          silencedUtcHours: [],
          reducedBetUtcHours: {},
          reducedByDow: { "1": { "15": 25 } },
        },
      },
    },
  );
  const d = resolveEntryQuietHoursDecisionForSymbol(cfg, "live", "BTC", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.reducedPct, 25);
  assert.equal(d.qhMode, "reduced");
});

test("per-market: freeRunMode bypasses everything even with an enabled symbol schedule", () => {
  const cfg = qhCfg(
    { enabled: true, silencedUtcHours: [], reducedBetUtcHours: {} },
    {
      freeRunMode: true,
      quietHoursMode: "per_market",
      perSymbolQuietHours: { BTC: BTC_SILENCED_SCHEDULE },
    },
  );
  const d = resolveEntryQuietHoursDecisionForSymbol(cfg, "live", "BTC", MON_11AM_ET);
  assert.equal(d.action, "proceed");
  assert.equal(d.entryMode, "live");
});

test("per-market: symbol lookup is case-insensitive (uppercased)", () => {
  const cfg = qhCfg(
    { enabled: true, silencedUtcHours: [], reducedBetUtcHours: {} },
    {
      quietHoursMode: "per_market",
      perSymbolQuietHours: { BTC: BTC_SILENCED_SCHEDULE },
    },
  );
  const d = resolveEntryQuietHoursDecisionForSymbol(cfg, "live", "btc", MON_11AM_ET);
  assert.equal(d.action, "block");
  assert.equal(d.qhMode, "silenced");
});
