// Smart Hours clarity frontend regression tests — Task #681
//
// Verifies that:
//   1. bot-header.tsx never shows the global "Silenced" badge in per-market mode.
//   2. bot-header.tsx shows a blocked-symbol count in per-market mode.
//   3. bot-header.tsx uses "Entries blocked" / "Reduced entry" labels in global mode.
//   4. conditions-panel.tsx uses "Entry blocked" / "Reduced entry" / "Entries active" labels.
//   5. conditions-panel.tsx uses smartHoursScope + symbolSmartHoursModes from the server.
//   6. conditions-panel.tsx does not say "market availability" for Smart Hours states.
//   7. types.ts has the new additive fields as optional (backward-compatible).
//
// Run with:  pnpm --filter @workspace/market-edge test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const headerSource   = readFileSync(join(here, "bot-header.tsx"), "utf8");
const condSource     = readFileSync(join(here, "conditions-panel.tsx"), "utf8");
const typesSource    = readFileSync(join(here, "types.ts"), "utf8");
const perSymbolSource = readFileSync(join(here, "per-symbol-quiet-hours-panel.tsx"), "utf8");
const controlsSource = readFileSync(join(here, "smart-quiet-hours-controls.tsx"), "utf8");

// ---------------------------------------------------------------------------
// bot-header.tsx
// ---------------------------------------------------------------------------

describe("bot-header Smart Hours clarity", () => {
  it("checks smartHoursScope before deciding which badge to show", () => {
    // The header must branch on scope, not just quietHoursV2State.mode.
    assert.match(headerSource, /smartHoursScope/,
      "header must read smartHoursScope from status");
  });

  it("in per-market mode shows a blocked-symbol count, not a bare 'Silenced' badge", () => {
    // Should mention blockedCount in per-market branch
    assert.match(headerSource, /blockedCount/,
      "header must count blocked symbols in per-market mode");
    assert.match(headerSource, /entry blocked/i,
      "header must say 'entry blocked' in per-market mode");
  });

  it("in global mode uses 'Entries blocked' label for silenced state", () => {
    assert.match(headerSource, /Entries blocked/,
      "global mode silenced badge must say 'Entries blocked'");
  });

  it("in global mode uses 'Reduced entry' label for reduced state", () => {
    assert.match(headerSource, /Reduced entry/,
      "global mode reduced badge must say 'Reduced entry'");
  });

  it("does NOT show the old bare '🔇 Silenced' badge (which confused per-market with global)", () => {
    // The old badge was: 🔇 Silenced (with no scope qualification)
    // It must not appear — in global mode we now say 'Entries blocked'.
    assert.doesNotMatch(headerSource, />\s*🔇 Silenced\s*</,
      "Old bare '🔇 Silenced' badge must not appear in the header (was misleading in per-market mode)");
  });

  it("reads symbolSmartHoursModes for per-market badge", () => {
    assert.match(headerSource, /symbolSmartHoursModes/,
      "header must read symbolSmartHoursModes to compute per-market blocked count");
  });
});

// ---------------------------------------------------------------------------
// conditions-panel.tsx
// ---------------------------------------------------------------------------

describe("conditions-panel Smart Hours clarity", () => {
  it("reads smartHoursScope from conditions", () => {
    assert.match(condSource, /smartHoursScope/,
      "conditions panel must read smartHoursScope");
  });

  it("prefers server-provided symbolSmartHoursModes over client calculation", () => {
    assert.match(condSource, /symbolSmartHoursModes/,
      "conditions panel must use symbolSmartHoursModes from server");
    // hasServerSymModes guard before falling back to quietHoursV2State
    assert.match(condSource, /hasServerSymModes/,
      "conditions panel must check for server symbol modes before falling back");
  });

  it("labels per-symbol silenced state as 'Entry blocked'", () => {
    assert.match(condSource, /Entry blocked/,
      "conditions panel must use 'Entry blocked' label for Smart Hours silenced state");
  });

  it("labels per-symbol reduced state as 'Reduced entry'", () => {
    assert.match(condSource, /Reduced entry/,
      "conditions panel must use 'Reduced entry' label");
  });

  it("labels per-symbol active state as 'Entries active'", () => {
    assert.match(condSource, /Entries active/,
      "conditions panel must use 'Entries active' label");
  });

  it("shows a Smart Hours entry eligibility section for the per-symbol breakdown", () => {
    assert.match(condSource, /Smart Hours entry eligibility/,
      "conditions panel must show a 'Smart Hours entry eligibility' section");
  });

  it("does not label Smart Hours states as 'market availability'", () => {
    // The old code used quietHoursV2State for per-symbol display and could say "market availability".
    // This must not appear in any Smart Hours context.
    assert.doesNotMatch(condSource, /market availability/i,
      "Smart Hours entry state must not be described as 'market availability'");
  });

  it("shows the smart hours scope in the per-symbol section header", () => {
    // The per-symbol section must identify whether it's per-market or global.
    assert.match(condSource, /per-market/,
      "conditions panel Smart Hours section must identify per-market scope");
  });
});

// ---------------------------------------------------------------------------
// types.ts — additive (backward-compatible) fields
// ---------------------------------------------------------------------------

describe("types.ts Smart Hours clarity fields", () => {
  it("BotStatus has optional smartHoursScope field", () => {
    // Must be optional (?) for backward compatibility with older server responses.
    assert.match(typesSource, /smartHoursScope\?:\s*"global"\s*\|\s*"per_market"/,
      "BotStatus must have optional smartHoursScope field");
  });

  it("BotStatus has optional symbolSmartHoursModes field", () => {
    assert.match(typesSource, /symbolSmartHoursModes\?:/,
      "BotStatus must have optional symbolSmartHoursModes field");
  });

  it("BotStatus has optional symbolSmartHoursResolvedAt field", () => {
    assert.match(typesSource, /symbolSmartHoursResolvedAt\?:/,
      "BotStatus must have optional symbolSmartHoursResolvedAt field");
  });

  it("BotConditionsSnapshot has optional smartHoursScope field", () => {
    assert.match(typesSource, /smartHoursScope\?:/,
      "BotConditionsSnapshot must have optional smartHoursScope field");
  });

  it("BotConditionsSnapshot has optional symbolSmartHoursModes field", () => {
    // Check it appears in BotConditionsSnapshot (it also appears in BotStatus,
    // but we count 2 occurrences to verify both interfaces have it).
    const count = (typesSource.match(/symbolSmartHoursModes\?:/g) ?? []).length;
    assert.ok(count >= 2,
      "Both BotStatus and BotConditionsSnapshot must have symbolSmartHoursModes (found ${count} occurrences)");
  });

  it("SymbolSmartHoursMode type is exported", () => {
    assert.match(typesSource, /export type SymbolSmartHoursMode/,
      "SymbolSmartHoursMode must be exported from types.ts");
  });

  it("SymbolSmartHoursMode includes no-schedule variant", () => {
    assert.match(typesSource, /"no-schedule"/,
      "SymbolSmartHoursMode must include the 'no-schedule' variant");
  });
});

describe("per-market Smart Hours tabs", () => {
  it("color codes active, silenced, and reduced market tabs", () => {
    assert.match(perSymbolSource, /border-emerald-500/);
    assert.match(perSymbolSource, /border-red-500/);
    assert.match(perSymbolSource, /border-amber-400/);
    assert.match(perSymbolSource, /data-smart-hours-mode=\{mode\}/);
  });

  it("prefers canonical server-resolved market modes", () => {
    assert.match(perSymbolSource, /symbolSmartHoursModes\?\.\[symbol\]/);
  });

  it("loads the calibration threshold from persisted config instead of a hard-coded local default", () => {
    assert.match(controlsSource, /calibrationThreshold=\{merged\.quietHoursV2\?\.autoTuneThreshold \?\? 84\.5\}/);
    assert.match(perSymbolSource, /useState\(calibrationThreshold\)/);
    assert.doesNotMatch(perSymbolSource, /useState\(85\)/);
  });

  it("saves threshold changes so hourly calibration reuses the operator setting", () => {
    assert.match(perSymbolSource, /onCalibrationThresholdChange\?\.\(nextThreshold\)/);
    assert.match(controlsSource, /authPost\("\/crypto\/bot\/config", \{ quietHoursV2 \}\)/);
    assert.match(controlsSource, /autoTuneThreshold: threshold/);
  });
});
