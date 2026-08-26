import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearRegularFreefallTelemetryCoalescing,
  shouldPersistRegularFreefallSkip,
} from "./kalshi-freefall-telemetry.ts";

test("freefall skip telemetry persists transitions and refreshes every 30 seconds", () => {
  clearRegularFreefallTelemetryCoalescing();
  const base = {
    symbol: "BTC",
    windowKey: "2026-01-01T00:00",
    mode: "live" as const,
    reason: "freefall_unavailable_warming",
  };
  assert.equal(shouldPersistRegularFreefallSkip({ ...base, nowMs: 0 }), true);
  assert.equal(shouldPersistRegularFreefallSkip({ ...base, nowMs: 29_999 }), false);
  assert.equal(shouldPersistRegularFreefallSkip({ ...base, nowMs: 30_000 }), true);
  assert.equal(shouldPersistRegularFreefallSkip({
    ...base,
    reason: "freefall_consecutive_falling",
    nowMs: 30_001,
  }), true);
  assert.equal(shouldPersistRegularFreefallSkip({
    ...base,
    mode: "paper",
    nowMs: 30_001,
  }), true);
});

test("freefall telemetry coalescing clears on window transition", () => {
  clearRegularFreefallTelemetryCoalescing();
  const input = {
    symbol: "ETH",
    windowKey: "window",
    mode: "live" as const,
    reason: "freefall_unavailable_warming",
    nowMs: 1,
  };
  assert.equal(shouldPersistRegularFreefallSkip(input), true);
  assert.equal(shouldPersistRegularFreefallSkip({ ...input, nowMs: 2 }), false);
  clearRegularFreefallTelemetryCoalescing();
  assert.equal(shouldPersistRegularFreefallSkip({ ...input, nowMs: 3 }), true);
});