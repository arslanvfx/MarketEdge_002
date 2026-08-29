// Unit tests for bot config persistence (decisionMode survival across restarts).
//
// The concern: DEFAULT_BOT_CONFIG.decisionMode is "classic". If an admin sets
// it to "ml_gate" or "consensus" and the server restarts, the config must be
// restored from the DB row — not reset to the default.
//
// loadBotConfigFromDB() does:
//   config = { ...DEFAULT_BOT_CONFIG, ...saved }
// where `saved` is the JSONB blob parsed back to an object.
//
// These tests confirm:
//   1. Every non-default decisionMode survives a JSON serialize/deserialize
//      roundtrip followed by the DEFAULT_BOT_CONFIG spread.
//   2. A saved config with no decisionMode field correctly falls back to the
//      DEFAULT_BOT_CONFIG value (backward compat with pre-decisionMode rows).
//   3. The updateBotConfig snapshot always includes decisionMode (i.e. it is
//      present on BotConfig, not an optional field that could be omitted).
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BOT_CONFIG,
  type BotConfig,
  type DecisionMode,
} from "./kalshi-bot-engine-core.ts";

// ---------------------------------------------------------------------------
// Helper: simulate what the DB does (jsonb column stores/retrieves as plain
// JSON). JSON.stringify → JSON.parse is an exact replica of JSONB roundtrip.
// ---------------------------------------------------------------------------

function jsonRoundtrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Helper: simulate what loadBotConfigFromDB does when a row is found.
function applyStoredConfig(stored: Record<string, unknown>): BotConfig {
  const saved = stored as Partial<BotConfig>;
  return { ...DEFAULT_BOT_CONFIG, ...saved };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("DEFAULT_BOT_CONFIG.decisionMode is 'classic'", () => {
  assert.equal(DEFAULT_BOT_CONFIG.decisionMode, "classic");
});

test("existing persisted configurations fall back to the legacy live execution gateway", () => {
  const restored = { ...DEFAULT_BOT_CONFIG, betSize: 2 };
  assert.equal(restored.liveExecutionGateway, "legacy");
});

test("disabled regular direction/freefall guard survives persistence and restart", () => {
  const original: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    convictionDirectionGuardEnabled: false,
  };
  const stored = jsonRoundtrip(original);
  const restored = applyStoredConfig(stored as unknown as Record<string, unknown>);

  assert.equal(restored.convictionDirectionGuardEnabled, false);
});

test("conviction proximity guard defaults on and an explicit false survives persistence", () => {
  assert.equal(DEFAULT_BOT_CONFIG.convictionProximityGuardEnabled, true);
  const original: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    convictionProximityGuardEnabled: false,
  };
  const stored = jsonRoundtrip(original);
  const restored = applyStoredConfig(stored as unknown as Record<string, unknown>);

  assert.equal(restored.convictionProximityGuardEnabled, false);
});

test("ml_gate survives JSON roundtrip + DEFAULT_BOT_CONFIG spread", () => {
  const original: BotConfig = { ...DEFAULT_BOT_CONFIG, decisionMode: "ml_gate" };
  const stored = jsonRoundtrip(original);
  const restored = applyStoredConfig(stored as unknown as Record<string, unknown>);

  assert.equal(restored.decisionMode, "ml_gate" satisfies DecisionMode);
});

test("consensus survives JSON roundtrip + DEFAULT_BOT_CONFIG spread", () => {
  const original: BotConfig = { ...DEFAULT_BOT_CONFIG, decisionMode: "consensus" };
  const stored = jsonRoundtrip(original);
  const restored = applyStoredConfig(stored as unknown as Record<string, unknown>);

  assert.equal(restored.decisionMode, "consensus" satisfies DecisionMode);
});

test("classic survives JSON roundtrip + DEFAULT_BOT_CONFIG spread", () => {
  const original: BotConfig = { ...DEFAULT_BOT_CONFIG, decisionMode: "classic" };
  const stored = jsonRoundtrip(original);
  const restored = applyStoredConfig(stored as unknown as Record<string, unknown>);

  assert.equal(restored.decisionMode, "classic" satisfies DecisionMode);
});

test("saved config without decisionMode falls back to DEFAULT_BOT_CONFIG value", () => {
  // Simulate a DB row saved before decisionMode was added — the field will be
  // absent from the JSON blob. The spread must fall back to the default.
  const legacyStored: Record<string, unknown> = jsonRoundtrip({
    betSize: 1.0,
    dailyLossLimit: 20,
    minConfidence: 52,
    // decisionMode intentionally omitted
  });
  const restored = applyStoredConfig(legacyStored);

  assert.equal(restored.decisionMode, DEFAULT_BOT_CONFIG.decisionMode);
});

test("decisionMode is a required (non-optional) field on BotConfig — always included in snapshot", () => {
  // If decisionMode were optional (decisionMode?: DecisionMode), a snapshot
  // built via { ...config } could silently drop it. Verify that every key in
  // DEFAULT_BOT_CONFIG — including decisionMode — is present in a spread copy.
  const snapshot: BotConfig = { ...DEFAULT_BOT_CONFIG };

  assert.ok(
    Object.prototype.hasOwnProperty.call(snapshot, "decisionMode"),
    "decisionMode must be an own property of the config snapshot",
  );
  assert.equal(typeof snapshot.decisionMode, "string");
});

test("full config roundtrip: all non-default fields survive alongside decisionMode", () => {
  const original: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    decisionMode: "ml_gate",
    betSize: 2.50,
    minConfidence: 58,
    enabled: false,
  };
  const restored = applyStoredConfig(jsonRoundtrip(original) as unknown as Record<string, unknown>);

  assert.equal(restored.decisionMode, "ml_gate");
  assert.equal(restored.betSize, 2.50);
  assert.equal(restored.minConfidence, 58);
  assert.equal(restored.enabled, false);
});
