import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildScalpCalibrationRecommendation,
  buildScalpCalibrationTimingOverride,
  scalpCalibrationSettingsEqual,
  type BuildScalpCalibrationRecommendationInput,
} from "./kalshi-scalper-calibration.ts";
import { resolveEffectiveParams } from "./kalshi-scalper-policy.ts";
import { DEFAULT_SCALP_CONFIG, SCALP_SHADOW_VARIANT_SECONDS } from "./kalshi-scalper-types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const engineSource = readFileSync(join(here, "kalshi-scalper-calibration.ts"), "utf8");
const serviceSource = readFileSync(join(here, "kalshi-scalper-service.ts"), "utf8");
const dbSource = readFileSync(join(here, "kalshi-scalper-db.ts"), "utf8");
const routeSource = readFileSync(join(here, "..", "routes", "kalshi-scalper.ts"), "utf8");

const settings = { bandMin: .91, bandMax: .98, windowSeconds: 90, budgetDollars: 2 };
function input(
  symbol = "GOLD",
  currentSettings = settings,
  candidateVariant = 120,
): BuildScalpCalibrationRecommendationInput {
  const windows = Array.from({ length: 12 }, (_, i) => `w${i}`);
  const shadow = (variant: number, extraCandidate = false) => Array.from({ length: 18 }, (_, i) => ({
    mode: "paper" as const, symbol, windowKey: `s${i}`, variantSeconds: variant,
    observedAt: `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    candidate: i < 16 || (extraCandidate && i >= 16), settledAt: i < 16 ? "2025-02-01T00:00:00.000Z" : null,
    hypotheticalPnl: i < 16 ? 1 : null,
  }));
  return { mode: "paper", symbol, currentSettings, analysisStart: "2025-01-01T00:00:00.000Z", evidenceCutoff: "2025-03-01T00:00:00.000Z", createdAt: "2025-03-02T00:00:00.000Z",
    realOrders: windows.slice(0, 8).map((windowKey, i) => ({ mode: "paper" as const, symbol, windowKey, attemptedAt: "2025-01-01T00:00:00.000Z", settledAt: "2025-01-02T00:00:00.000Z", pnl: i ? 1 : 0 })),
    reservations: windows.slice(8).map((windowKey) => ({ mode: "paper" as const, symbol, windowKey, createdAt: "2025-01-01T00:00:00.000Z", blocker: null })),
    funnelEvents: [{ mode: "paper", symbol, windowKey: "w0", occurredAt: "2025-01-01T00:00:00.000Z", blocker: "quote_invalid" }],
    shadowRecords: [
      ...shadow(currentSettings.windowSeconds),
      ...(candidateVariant === currentSettings.windowSeconds
        ? []
        : shadow(candidateVariant, true)),
    ],
  };
}

test("handles all-market-neutral symbols including GOLD and WTI", () => {
  for (const symbol of ["GOLD", "WTI"]) assert.equal(buildScalpCalibrationRecommendation(input(symbol)).status, "recommended");
});
test("reports explicit insufficient evidence and isolates supplied mode rows", () => {
  const value = input(); value.realOrders = value.realOrders.slice(0, 2);
  value.reservations = []; value.funnelEvents = [];
  value.realOrders.push({ ...value.realOrders[0]!, mode: "live", windowKey: "live-only" });
  const result = buildScalpCalibrationRecommendation(value);
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.evidence.attemptedUniqueWindows, 2);
  assert.ok(result.rationale.includes("requires_at_least_12_attempted_unique_windows"));
});
test("rejects a candidate whose chronological holdout loses", () => {
  const value = input();
  for (const row of value.shadowRecords.filter((x) => x.variantSeconds === 120).slice(13, 18)) { row.candidate = true; row.settledAt = "2025-02-01T00:00:00.000Z"; row.hypotheticalPnl = -1; }
  assert.equal(buildScalpCalibrationRecommendation(value).status, "no_change");
});
test("recommends valid earlier timing and never changes band or budget", () => {
  const result = buildScalpCalibrationRecommendation(input());
  assert.equal(result.status, "recommended"); assert.equal(result.proposedSettings.windowSeconds, 120);
  assert.equal(result.proposedSettings.bandMin, settings.bandMin); assert.equal(result.proposedSettings.budgetDollars, settings.budgetDollars);
  assert.equal(scalpCalibrationSettingsEqual(settings, result.currentSettings), true);
});
test("returns no_change when earlier coverage does not improve", () => {
  const value = input(); for (const row of value.shadowRecords) if (row.variantSeconds === 120) row.candidate = row.observedAt < "2025-01-17";
  assert.equal(buildScalpCalibrationRecommendation(value).status, "no_change");
});

test("can recommend an earlier production shadow variant from the default 120-second config", () => {
  const defaultSettings = {
    bandMin: DEFAULT_SCALP_CONFIG.globalBandMin,
    bandMax: DEFAULT_SCALP_CONFIG.globalBandMax,
    windowSeconds: DEFAULT_SCALP_CONFIG.finalWindowSeconds,
    budgetDollars: DEFAULT_SCALP_CONFIG.budgetDollars,
  };
  const candidateVariant = 150;
  assert.ok(SCALP_SHADOW_VARIANT_SECONDS.includes(candidateVariant));
  const result = buildScalpCalibrationRecommendation(
    input("BTC", defaultSettings, candidateVariant),
  );
  assert.equal(result.status, "recommended");
  assert.equal(result.currentSettings.windowSeconds, 120);
  assert.equal(result.proposedSettings.windowSeconds, candidateVariant);
  assert.equal(Number.isFinite(result.proposedSettings.bandMin), true);
  assert.equal(Number.isFinite(result.proposedSettings.bandMax), true);
  assert.equal(result.proposedSettings.bandMin, defaultSettings.bandMin);
  assert.equal(result.proposedSettings.bandMax, defaultSettings.bandMax);
});

test("keeps a default market in need-data state until an earlier production variant has evidence", () => {
  const defaultSettings = {
    bandMin: DEFAULT_SCALP_CONFIG.globalBandMin,
    bandMax: DEFAULT_SCALP_CONFIG.globalBandMax,
    windowSeconds: DEFAULT_SCALP_CONFIG.finalWindowSeconds,
    budgetDollars: DEFAULT_SCALP_CONFIG.budgetDollars,
  };
  const result = buildScalpCalibrationRecommendation(
    input("BTC", defaultSettings, defaultSettings.windowSeconds),
  );
  assert.equal(result.status, "insufficient_data");
  assert.ok(result.rationale.includes("requires_shadow_training_and_holdout_evidence"));
});

test("a timing proposal without a prior override keeps band and budget inherited", () => {
  const proposed = buildScalpCalibrationTimingOverride(null, "btc", 150);
  assert.deepEqual(proposed, { symbol: "BTC", windowSeconds: 150 });

  const changedGlobals = {
    ...DEFAULT_SCALP_CONFIG,
    globalBandMin: 0.93,
    globalBandMax: 0.99,
    budgetDollars: 7,
    perMarketOverrides: [proposed],
  };
  const effective = resolveEffectiveParams(changedGlobals, "BTC", "");
  assert.equal(effective.bandMin, 0.93);
  assert.equal(effective.bandMax, 0.99);
  assert.equal(effective.budgetDollars, 7);
  assert.equal(effective.finalWindowSeconds, 150);
});

test("a timing proposal preserves only the exact prior partial override fields", () => {
  const prior = {
    symbol: "ETH",
    paused: true,
    minBand: 0.94,
  };
  const proposed = buildScalpCalibrationTimingOverride(prior, "eth", 165);
  assert.deepEqual(proposed, {
    symbol: "ETH",
    paused: true,
    minBand: 0.94,
    windowSeconds: 165,
  });

  const changedGlobals = {
    ...DEFAULT_SCALP_CONFIG,
    globalBandMax: 0.97,
    budgetDollars: 9,
    perMarketOverrides: [proposed],
  };
  const effective = resolveEffectiveParams(changedGlobals, "ETH", "");
  assert.equal(effective.paused, true);
  assert.equal(effective.bandMin, 0.94);
  assert.equal(effective.bandMax, 0.97);
  assert.equal(effective.budgetDollars, 9);
  assert.equal(effective.finalWindowSeconds, 165);
});

test("reports no change at the 180-second calibration boundary instead of waiting for impossible evidence", () => {
  const boundarySettings = {
    ...settings,
    windowSeconds: 180,
  };
  const result = buildScalpCalibrationRecommendation(
    input("BTC", boundarySettings, 180),
  );
  assert.equal(result.status, "no_change");
  assert.equal(result.proposedSettings.windowSeconds, 180);
  assert.match(result.rationale[0] ?? "", /60–180 second calibration range/);
});

test("keeps the calibration engine isolated from execution and hard safety policy", () => {
  assert.doesNotMatch(
    engineSource,
    /kalshi-scalper-(?:service|db|exchange|policy)\.ts/,
  );
  assert.match(serviceSource, /resolveEffectiveParams\(config, symbol, ""\)/);
  assert.match(serviceSource, /stored\.priorOverride/);
  assert.match(serviceSource, /stored\.proposedOverride/);
  assert.match(serviceSource, /buildScalpCalibrationTimingOverride\(/);
});

test("requires signed-in explicit refresh, apply, and revert actions", () => {
  assert.match(
    routeSource,
    /router\.post\("\/crypto\/scalper\/calibration\/refresh", requireScalpAdmin/,
  );
  assert.match(
    routeSource,
    /router\.post\("\/crypto\/scalper\/calibration\/:id\/apply", requireScalpAdmin/,
  );
  assert.match(
    routeSource,
    /router\.post\("\/crypto\/scalper\/calibration\/:id\/revert", requireScalpAdmin/,
  );
});

test("persists config and recommendation decisions in one transaction", () => {
  assert.match(
    dbSource,
    /async function persistScalpCalibrationDecision[\s\S]*await client\.query\("BEGIN"\)/,
  );
  assert.match(
    dbSource,
    /UPDATE kalshi_scalp_config[\s\S]*UPDATE kalshi_scalp_calibration_recommendations[\s\S]*await client\.query\("COMMIT"\)/,
  );
  assert.match(dbSource, /config = \$2::jsonb/);
});