import assert from "node:assert/strict";
import { test } from "node:test";
import {
  retainDashboard2MarketDisplay,
  type Dashboard2MarketDisplaySnapshot,
} from "./dashboard2-display-retention.ts";

const snapshot = (sourceWindowKey: string): Dashboard2MarketDisplaySnapshot => ({
  sourceWindowKey,
  ticker: "KXBTC",
  target: 100,
  side: "yes",
  selectedAsk: 0.82,
  yesAsk: 0.82,
  noAsk: 0.19,
  executableCost: 0.825,
  visibleContracts: 12,
  bookVersion: "1:2",
  observedAt: 1_000,
});

test("retains same-window display values while the live book refreshes", () => {
  const previous = snapshot("2026-08-28T08:45");
  assert.deepEqual(
    retainDashboard2MarketDisplay(previous, null, "2026-08-28T08:45"),
    { snapshot: previous, state: "refreshing" },
  );
});

test("retains previous-window display values without presenting them as live", () => {
  const previous = snapshot("2026-08-28T08:45");
  assert.deepEqual(
    retainDashboard2MarketDisplay(previous, null, "2026-08-28T09:00"),
    { snapshot: previous, state: "previous_window" },
  );
});

test("a fresh snapshot atomically replaces retained display values", () => {
  const current = { ...snapshot("2026-08-28T09:00"), ticker: "KXBTC-NEXT", observedAt: 2_000 };
  assert.deepEqual(
    retainDashboard2MarketDisplay(snapshot("2026-08-28T08:45"), current, "2026-08-28T09:00"),
    { snapshot: current, state: "live" },
  );
});