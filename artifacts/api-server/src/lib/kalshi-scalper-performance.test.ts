import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { calculateScalpPerformance } from "./kalshi-scalper-performance.ts";
import type { ScalpOrder } from "./kalshi-scalper-types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dbSource = readFileSync(join(here, "kalshi-scalper-db.ts"), "utf8");
const serviceSource = readFileSync(join(here, "kalshi-scalper-service.ts"), "utf8");

function exportedFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const nextExport = source.indexOf("\nexport ", start + 1);
  return source.slice(start, nextExport === -1 ? source.length : nextExport);
}

function makeOrder(overrides: Partial<ScalpOrder> = {}): ScalpOrder {
  return {
    id: "order-1",
    mode: "paper",
    symbol: "BTC",
    windowKey: "2026-08-22T12:00:00.000Z",
    ticker: "TEST",
    side: "yes",
    entryYesPrice: 0.95,
    contractCount: 2,
    budgetSpent: 1.9,
    clientOrderId: null,
    orderId: null,
    exchangeResponseReason: null,
    filledCount: 2,
    avgFillPrice: 0.95,
    limitPrice: 0.95,
    winningContractCost: 0.95,
    status: "paper",
    errorMessage: null,
    settlementResult: "yes",
    outcome: "win",
    pnl: 0.1,
    incidentId: null,
    reconciledAt: null,
    reconciliationEvidence: null,
    createdAt: new Date("2026-08-22T12:00:10.000Z"),
    settledAt: new Date("2026-08-22T12:15:00.000Z"),
    ...overrides,
  };
}

describe("calculateScalpPerformance", () => {
  it("separates Paper and Live reporting windows", () => {
    const baseline = new Date("2026-08-22T12:00:00.000Z");
    const paper = makeOrder({ id: "paper", mode: "paper" });
    const live = makeOrder({
      id: "live",
      mode: "live",
      symbol: "ETH",
      budgetSpent: 2.85,
      pnl: -2.85,
      outcome: "loss",
    });

    const paperPerf = calculateScalpPerformance("paper", baseline, 2, [paper, live]);
    const livePerf = calculateScalpPerformance("live", baseline, 5, [paper, live]);

    assert.equal(paperPerf.totalOrders, 1);
    assert.equal(paperPerf.trackingVersion, 2);
    assert.equal(paperPerf.wins, 1);
    assert.equal(paperPerf.totalPnl, 0.1);
    assert.deepEqual(paperPerf.bySymbol.map((row) => row.symbol), ["BTC"]);

    assert.equal(livePerf.totalOrders, 1);
    assert.equal(livePerf.trackingVersion, 5);
    assert.equal(livePerf.losses, 1);
    assert.equal(livePerf.totalPnl, -2.85);
    assert.deepEqual(livePerf.bySymbol.map((row) => row.symbol), ["ETH"]);
  });

  it("returns an empty visual measurement window immediately after reset", () => {
    const baseline = new Date("2026-08-22T12:01:00.000Z");
    const performance = calculateScalpPerformance("paper", baseline, 1, [
      makeOrder({ createdAt: new Date("2026-08-22T12:00:59.999Z") }),
    ]);

    assert.equal(performance.trackingSince, baseline.toISOString());
    assert.equal(performance.totalOrders, 0);
    assert.equal(performance.filledOrders, 0);
    assert.equal(performance.settled, 0);
    assert.equal(performance.totalPnl, 0);
    assert.equal(performance.totalSpent, 0);
    assert.equal(performance.winRate, null);
    assert.equal(performance.avgFillPrice, null);
    assert.deepEqual(performance.bySymbol, []);
  });

  it("excludes a pre-reset entry even when it settles after the reset", () => {
    const baseline = new Date("2026-08-22T12:10:00.000Z");
    const oldEntryLateSettlement = makeOrder({
      id: "old-entry",
      createdAt: new Date("2026-08-22T12:09:59.999Z"),
      settledAt: new Date("2026-08-22T12:20:00.000Z"),
      pnl: 10,
    });
    const newEntry = makeOrder({
      id: "new-entry",
      createdAt: new Date("2026-08-22T12:10:00.000Z"),
      settledAt: null,
      settlementResult: null,
      outcome: null,
      pnl: null,
    });

    const performance = calculateScalpPerformance(
      "paper",
      baseline,
      3,
      [oldEntryLateSettlement, newEntry],
    );

    assert.equal(performance.totalOrders, 1);
    assert.equal(performance.filledOrders, 1);
    assert.equal(performance.settled, 0);
    assert.equal(performance.totalPnl, 0);
    assert.equal(performance.totalSpent, newEntry.budgetSpent);
  });

  it("uses the newest baseline after repeated resets", () => {
    const firstReset = new Date("2026-08-22T12:05:00.000Z");
    const secondReset = new Date("2026-08-22T12:10:00.000Z");
    const afterFirst = makeOrder({
      id: "after-first",
      createdAt: new Date("2026-08-22T12:06:00.000Z"),
    });
    const afterSecond = makeOrder({
      id: "after-second",
      createdAt: new Date("2026-08-22T12:11:00.000Z"),
    });

    assert.equal(
      calculateScalpPerformance("paper", firstReset, 1, [afterFirst, afterSecond]).totalOrders,
      2,
    );
    assert.equal(
      calculateScalpPerformance("paper", secondReset, 2, [afterFirst, afterSecond]).totalOrders,
      1,
    );
  });
});

describe("Scalper performance reset persistence safety", () => {
  it("stores one durable baseline per mode and supports repeated resets", () => {
    assert.match(dbSource, /CREATE TABLE IF NOT EXISTS kalshi_scalp_performance_baselines/);
    assert.match(dbSource, /mode\s+TEXT PRIMARY KEY/);
    assert.match(dbSource, /CHECK \(mode IN \('paper', 'live'\)\)/);

    const resetSource = exportedFunctionSource(
      dbSource,
      "resetScalpPerformanceWindow",
    );
    assert.match(resetSource, /INSERT INTO kalshi_scalp_performance_baselines/);
    assert.match(resetSource, /ON CONFLICT \(mode\) DO UPDATE/);
    assert.match(resetSource, /version = kalshi_scalp_performance_baselines\.version \+ 1/);
    assert.match(resetSource, /RETURNING baseline_at, version/);
    assert.match(resetSource, /pg_advisory_xact_lock/);
    assert.match(resetSource, /await client\.query\("COMMIT"\)/);
  });

  it("filters by order creation time, never settlement time", () => {
    const querySource = exportedFunctionSource(
      dbSource,
      "getScalpOrdersForPerformance",
    );
    assert.match(querySource, /created_at >= \$2/);
    assert.doesNotMatch(querySource, /settled_at/);
  });

  it("cannot mutate the ledger or trading safety state", () => {
    const dbResetSource = exportedFunctionSource(
      dbSource,
      "resetScalpPerformanceWindow",
    );
    const serviceResetSource = exportedFunctionSource(
      serviceSource,
      "resetScalpPerformance",
    );
    const resetPath = `${dbResetSource}\n${serviceResetSource}`;

    assert.doesNotMatch(
      resetPath,
      /(?:DELETE FROM|UPDATE)\s+kalshi_scalp_(?:orders|reservations|incidents|config)/i,
    );
    assert.doesNotMatch(resetPath, /position|circuit.?breaker|balance/i);
    assert.match(serviceResetSource, /resetScalpPerformanceWindow\(mode\)/);
    assert.match(serviceResetSource, /window\.orders/);
  });
});