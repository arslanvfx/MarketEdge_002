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

  // Legacy gate — skipped entirely when V2 is enabled
  if (!freeRun && !(config.quietHoursV2?.enabled) && isInQuietHours(utcHour, config.quietHoursStart, config.quietHoursEnd)) {
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

test("quiet-hours v2 precedence: legacy gate fires when V2 is disabled", () => {
  // Legacy range 08:00–16:00 UTC, V2 disabled
  const cfg: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    quietHoursStart: 8,
    quietHoursEnd: 16,
    quietHoursV2: { enabled: false, silencedUtcHours: [], reducedBetUtcHours: {} },
  };
  // UTC hour 10 is inside the legacy range
  assert.equal(simulateQuietHoursGate(cfg, 10), "legacy-blocked");
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
