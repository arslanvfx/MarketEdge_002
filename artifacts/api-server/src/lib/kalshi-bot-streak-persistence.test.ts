// Integration-style tests for the coinStreakState persistence lifecycle.
//
// These tests call the real `persistCoinStreakState()` and `loadCoinStreakState()`
// functions from kalshi-bot-streak-db.ts (the same code used by the live server)
// with an in-memory StreakDbStore stub in place of the real Drizzle/PostgreSQL DB.
//
// This verifies the full round-trip:
//   1. App builds state (Map<symbol, CoinStreakEntry>)
//   2. persistCoinStreakState() → buildStreakSnapshot() → stub DB upsert
//   3. Server restarts
//   4. loadCoinStreakState() → stub DB fetch → restoreStreakState() → Map
//
// Run with:  pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  persistCoinStreakState,
  loadCoinStreakState,
  type StreakDbStore,
} from "./kalshi-bot-streak-db.ts";
import type { CoinStreakEntry } from "./kalshi-bot-engine-core.ts";

// ---------------------------------------------------------------------------
// In-memory StreakDbStore stub
// ---------------------------------------------------------------------------

function makeStore(): StreakDbStore & { stored: Record<string, CoinStreakEntry> | null } {
  let stored: Record<string, CoinStreakEntry> | null = null;
  return {
    get stored() { return stored; },
    async upsert(snapshot) {
      stored = JSON.parse(JSON.stringify(snapshot)); // deep-copy via JSON (mirrors DB serialization)
    },
    async fetch() {
      return stored;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("persist+load: active pause (pauseUntilWindowKey > nowWindowKey) survives restart", async () => {
  const store = makeStore();
  const liveState = new Map<string, CoinStreakEntry>([
    ["BTC", { consecutiveLosses: 3, pauseUntilWindowKey: "2026-07-03T10:15" }],
  ]);

  await persistCoinStreakState(liveState, store);

  // Simulate restart — current window is before the pause expires
  const { state } = await loadCoinStreakState(store, "2026-07-03T10:00");
  const entry = state.get("BTC");
  assert.ok(entry, "BTC must be present after load");
  assert.equal(entry!.pauseUntilWindowKey, "2026-07-03T10:15", "active pause must survive restart");
  assert.equal(entry!.consecutiveLosses, 3);
});

test("persist+load: expired pause (pauseUntilWindowKey <= nowWindowKey) is auto-cleared after restart", async () => {
  const store = makeStore();
  const liveState = new Map<string, CoinStreakEntry>([
    ["ETH", { consecutiveLosses: 2, pauseUntilWindowKey: "2026-07-03T09:45" }],
  ]);

  await persistCoinStreakState(liveState, store);

  // Simulate restart after the pause window has passed
  const { state, clearedSyms } = await loadCoinStreakState(store, "2026-07-03T10:00");
  const entry = state.get("ETH");
  assert.ok(entry, "ETH must still be present in restored state");
  assert.equal(entry!.pauseUntilWindowKey, null, "expired pause must be auto-cleared on load");
  assert.ok(clearedSyms.includes("ETH"), "ETH must be reported as cleared");
});

test("persist+load: pause at exact same window key as now is treated as expired (boundary)", async () => {
  // Spec: expired = pauseUntilWindowKey <= currentWindowKey
  // At equality the coin resumes betting this window → pause is expired → clear.
  const store = makeStore();
  const liveState = new Map<string, CoinStreakEntry>([
    ["LINK", { consecutiveLosses: 3, pauseUntilWindowKey: "2026-07-03T10:00" }],
  ]);

  await persistCoinStreakState(liveState, store);

  const { state, clearedSyms } = await loadCoinStreakState(store, "2026-07-03T10:00");
  assert.equal(
    state.get("LINK")!.pauseUntilWindowKey,
    null,
    "pause at exact current window must be treated as expired and cleared",
  );
  assert.ok(clearedSyms.includes("LINK"), "LINK must appear in clearedSyms");
});

test("persist+load: win-cleared entry (consecutiveLosses=0, no pause) is NOT written to DB", async () => {
  const store = makeStore();
  const liveState = new Map<string, CoinStreakEntry>([
    ["DOGE", { consecutiveLosses: 0, pauseUntilWindowKey: null }],
  ]);

  await persistCoinStreakState(liveState, store);

  // The snapshot must be empty — win-cleared entries must not be persisted.
  assert.ok(store.stored !== null, "upsert was called");
  assert.ok(!("DOGE" in store.stored!), "win-cleared coin must not appear in persisted snapshot");

  // After load the restored Map must not contain DOGE.
  const { state } = await loadCoinStreakState(store, "2026-07-03T10:00");
  assert.ok(!state.has("DOGE"), "win-cleared entry must not be present after load");
});

test("persist+load: multiple coins — active pauses kept, expired cleared, win-cleared absent", async () => {
  const store = makeStore();
  const liveState = new Map<string, CoinStreakEntry>([
    ["BTC",  { consecutiveLosses: 3, pauseUntilWindowKey: "2026-07-03T10:15" }], // future  → keep
    ["ETH",  { consecutiveLosses: 2, pauseUntilWindowKey: "2026-07-03T09:45" }], // past    → clear
    ["SOL",  { consecutiveLosses: 1, pauseUntilWindowKey: null }],                // no pause, losses kept
    ["DOGE", { consecutiveLosses: 0, pauseUntilWindowKey: null }],                // win-cleared → not persisted
  ]);

  await persistCoinStreakState(liveState, store);

  assert.ok("BTC" in store.stored!,    "BTC must be persisted");
  assert.ok("ETH" in store.stored!,    "ETH must be persisted");
  assert.ok("SOL" in store.stored!,    "SOL must be persisted (has losses)");
  assert.ok(!("DOGE" in store.stored!), "DOGE must NOT be persisted (win-cleared)");

  const { state, clearedSyms } = await loadCoinStreakState(store, "2026-07-03T10:00");
  assert.equal(state.get("BTC")!.pauseUntilWindowKey, "2026-07-03T10:15", "BTC active pause kept");
  assert.equal(state.get("ETH")!.pauseUntilWindowKey, null,               "ETH expired pause cleared");
  assert.equal(state.get("SOL")!.consecutiveLosses,   1,                  "SOL loss count preserved");
  assert.ok(!state.has("DOGE"),                                            "DOGE absent after load");
  assert.ok(clearedSyms.includes("ETH"),   "ETH in clearedSyms");
  assert.ok(!clearedSyms.includes("BTC"),  "BTC not in clearedSyms");
  assert.ok(!clearedSyms.includes("DOGE"), "DOGE not in clearedSyms");
});

test("persist+load: no-op when DB is empty (fresh start)", async () => {
  const store = makeStore();
  const { state, clearedSyms } = await loadCoinStreakState(store, "2026-07-03T10:00");
  assert.equal(state.size, 0, "empty DB → empty state");
  assert.deepEqual(clearedSyms, [], "nothing to clear");
});

test("persist+load: consecutive losses survive restart with no pause set", async () => {
  const store = makeStore();
  const liveState = new Map<string, CoinStreakEntry>([
    ["XRP", { consecutiveLosses: 2, pauseUntilWindowKey: null }],
  ]);

  await persistCoinStreakState(liveState, store);

  const { state } = await loadCoinStreakState(store, "2026-07-03T10:00");
  const entry = state.get("XRP");
  assert.ok(entry, "XRP must be present");
  assert.equal(entry!.consecutiveLosses, 2, "loss count must survive restart");
  assert.equal(entry!.pauseUntilWindowKey, null);
});
