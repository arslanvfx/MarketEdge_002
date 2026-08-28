import assert from "node:assert/strict";
import test from "node:test";
import { dashboard2CircuitMetrics, dashboard2EtDayBounds, dashboard2EtHour, dashboard2FinalizedPosition, dashboard2IocOrderFromQuote, dashboard2IocSellOrderFromQuote, dashboard2LifecyclePnl, dashboard2ReservationAllowed, dashboard2RoiPct, dashboard2WhatIfPosition, parseDashboard2Config } from "./dashboard2-v2-pure.ts";

test("Dashboard2 V2 config has conservative immutable defaults", () => {
  const config = parseDashboard2Config({});
  assert.equal(config.enabled, false);
  assert.equal(config.liveActivation, false);
  assert.equal(config.maxContracts, 2);
  assert.equal(config.paperStartingBalance, 100);
  assert(Object.isFrozen(config));
});

test("Dashboard2 ET bounds honor the DST-short New York day", () => {
  const bounds = dashboard2EtDayBounds(new Date("2025-03-09T16:00:00Z"));
  assert.equal(bounds.dayStartAt.toISOString(), "2025-03-09T05:00:00.000Z");
  assert.equal(bounds.nextResetAt.toISOString(), "2025-03-10T04:00:00.000Z");
  assert.equal(dashboard2EtHour("2025-03-10T04:30:00Z"), 0);
  assert.equal(dashboard2EtHour("2025-03-10T17:30:00Z"), 13);
});

test("Dashboard2 performance finalizes partial exit plus settlement and classifies outcomes", () => {
  const partial = dashboard2FinalizedPosition({
    entryCost: .8, filledContracts: 2, settlementValue: 1, settledAt: "2025-01-03T12:00:00Z",
    exits: [{ filledContracts: 1, proceeds: .5, at: "2025-01-03T11:00:00Z" }],
  });
  const exited = dashboard2FinalizedPosition({
    entryCost: .8, filledContracts: 2, settlementValue: null, settledAt: null,
    exits: [{ filledContracts: 1, proceeds: .7, at: "2025-01-03T11:00:00Z" }, { filledContracts: 1, proceeds: .4, at: "2025-01-03T13:00:00Z" }],
  });
  assert.deepEqual(partial, { pnl: -.1, finalized: true, finalAt: new Date("2025-01-03T12:00:00Z"), filledContracts: 2 });
  assert.equal(exited.pnl, -.5);
  assert.equal(exited.finalAt?.toISOString(), "2025-01-03T13:00:00.000Z");
  assert.equal([partial.pnl, 0, 1].filter(pnl => pnl > 0).length, 1);
  assert.equal([partial.pnl, 0, 1].filter(pnl => pnl < 0).length, 1);
  assert.equal([partial.pnl, 0, 1].filter(pnl => pnl === 0).length, 1);
});

test("Dashboard2 what-if uses only whole contracts", () => {
  assert.deepEqual(dashboard2WhatIfPosition(.8, 2, .4, 2.01), {
    contracts: 2, actualStake: 1.6, actualPnl: .4, hypotheticalStake: 1.6, hypotheticalPnl: .4,
  });
  assert.equal(dashboard2WhatIfPosition(.8, 2, .4, .79).contracts, 0);
  assert.equal(dashboard2RoiPct(.2, 1.6), 12.5);
  assert.equal(dashboard2RoiPct(.4, 1.6) - dashboard2RoiPct(.2, 1.6), 12.5);
  assert.equal(dashboard2RoiPct(0, 0), null);
});

test("Dashboard2 V2 IOC command maps NO cost to YES-side limit", () => {
  const no = dashboard2IocOrderFromQuote({ ticker: "KXBTC", side: "no", sideCost: .8, marginalLimitCost: .823, visibleContracts: 2, seq: 1, updatedAt: 1, bookVersion: "1:1" }, 2, "order-1");
  const yes = dashboard2IocOrderFromQuote({ ticker: "KXBTC", side: "yes", sideCost: .8, marginalLimitCost: .823, visibleContracts: 2, seq: 1, updatedAt: 1, bookVersion: "1:1" }, 2, "order-2");
  assert.equal(no.limitPrice, .17);
  assert.equal(yes.limitPrice, .83);
  assert.equal(no.timeInForce, "immediate_or_cancel");
});

test("Dashboard2 stop IOC maps direct side proceeds to YES-side limit", () => {
  const base = { ticker: "KXBTC", sideProceeds: .47125, marginalLimitProceeds: .423,
    visibleContracts: 2, seq: 1, updatedAt: 1, bookVersion: "1:1" };
  // Weighted average is deliberately asymmetric and must never become either limit.
  assert.equal(dashboard2IocSellOrderFromQuote({ ...base, side: "yes" }, 2, "sell-1").limitPrice, .42);
  assert.equal(dashboard2IocSellOrderFromQuote({ ...base, side: "no" }, 2, "sell-2").limitPrice, .58);
  assert.throws(() => dashboard2IocSellOrderFromQuote({ ...base, side: "yes" }, 3, "sell-3"), /covered/);
});

test("Dashboard2 fully stopped trade contributes one finalized circuit result", () => {
  const lifecycle = dashboard2LifecyclePnl({
    entryCost: .82, filledContracts: 3,
    exits: [{ filledContracts: 1, proceeds: .50 }, { filledContracts: 2, proceeds: .40 }],
  });
  assert.deepEqual(lifecycle, { exitedContracts: 3, remainingContracts: 0, pnl: -1.16, finalized: true });
  assert.deepEqual(dashboard2CircuitMetrics([
    { settledAt: "2025-01-03T11:00:00Z", pnl: lifecycle.pnl },
  ], new Date("2025-01-03T12:00:00Z")), { dailyPnl: -1.16, consecutiveLosses: 1 });
});

test("Dashboard2 V2 config supports a strict partial patch", () => {
  const original = parseDashboard2Config({});
  const patched = parseDashboard2Config({ enabled: true, maxContracts: 1 }, original);
  assert.equal(patched.enabled, true);
  assert.equal(patched.maxContracts, 1);
  assert.equal(patched.minEntryMinute, original.minEntryMinute);
  assert.throws(() => parseDashboard2Config({ unexpected: true }), /unknown config field/);
  assert.throws(() => parseDashboard2Config({ liveActivation: true }), /cannot be enabled/);
  assert.throws(() => parseDashboard2Config({ sideCostFloor: 0.9, sideCostCeiling: 0.8 }), /must not exceed/);
});

test("Dashboard2 circuit metrics use ET day and trailing settled loss streak", () => {
  const now = new Date("2025-01-03T12:00:00.000Z");
  const metrics = dashboard2CircuitMetrics([
    { settledAt: "2025-01-03T11:00:00.000Z", pnl: -2 },
    { settledAt: "2025-01-03T10:00:00.000Z", pnl: -1 },
    { settledAt: "2025-01-03T09:00:00.000Z", pnl: 4 },
    { settledAt: "2025-01-02T23:00:00.000Z", pnl: -9 },
  ], now);
  assert.deepEqual(metrics, { dailyPnl: 1, consecutiveLosses: 2 });
});

test("Dashboard2 reservation charges pending intents at the cost ceiling", () => {
  assert.equal(dashboard2ReservationAllowed({
    duplicate: false, openPositions: 1, exposure: 8.31, requestedContracts: 2,
    sideCostCeiling: 0.85, maxConcurrentPositions: 2, maxTotalExposure: 10,
  }), false);
  assert.equal(dashboard2ReservationAllowed({
    duplicate: false, openPositions: 1, exposure: 8, requestedContracts: 2,
    sideCostCeiling: 0.85, maxConcurrentPositions: 2, maxTotalExposure: 10,
  }), true);
});