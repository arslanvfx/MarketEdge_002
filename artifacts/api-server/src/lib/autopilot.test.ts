// Unit tests for the auto-pilot decision logic (pure module). These lock in the
// subtle guardrails so a future tweak can't silently break them:
//   • hysteresis (ON at +5 margin, stays ON until edge falls to -2 or below)
//   • the global cap (never more than AUTOPILOT_MAX_ACTIVE active at once)
//   • exploration (run Claude when it has fewer than the min samples)
//   • additive manual enablement (a manually enabled coin stays on regardless)
//
// Run with:  pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTOPILOT_EXPLORE_SAMPLES,
  AUTOPILOT_MAX_ACTIVE,
  AUTOPILOT_MIN_SAMPLES,
  AUTOPILOT_OFF_MARGIN,
  AUTOPILOT_ON_MARGIN,
  type AutoPilotInput,
  claudeEnabledFor,
  computeAutoPilotDecisions,
} from "./autopilot.ts";

// Build an input with sensible "proven" defaults (enough samples to skip the
// stat-baseline and exploration gates), overridable per test.
function input(overrides: Partial<AutoPilotInput> & { symbol: string }): AutoPilotInput {
  return {
    claudeAcc: 50,
    statAcc: 50,
    claudeN: AUTOPILOT_EXPLORE_SAMPLES,
    statN: AUTOPILOT_MIN_SAMPLES,
    wasActive: false,
    ...overrides,
  };
}

function decisionFor(inputs: AutoPilotInput[], symbol: string) {
  const d = computeAutoPilotDecisions(inputs).find((x) => x.symbol === symbol);
  assert.ok(d, `expected a decision for ${symbol}`);
  return d;
}

test("hysteresis: turns Claude ON only at or above the +5 ON margin", () => {
  // Margin exactly at ON threshold → activates from cold.
  const atThreshold = decisionFor(
    [input({ symbol: "BTC", claudeAcc: 50 + AUTOPILOT_ON_MARGIN, statAcc: 50, wasActive: false })],
    "BTC",
  );
  assert.equal(atThreshold.active, true);
  assert.equal(atThreshold.marginPct, AUTOPILOT_ON_MARGIN);

  // Just below ON threshold (+4) and not previously active → stays OFF.
  const belowThreshold = decisionFor(
    [input({ symbol: "BTC", claudeAcc: 54, statAcc: 50, wasActive: false })],
    "BTC",
  );
  assert.equal(belowThreshold.active, false);
  assert.match(belowThreshold.reason, /paused/);
});

test("hysteresis: an active coin stays ON until its edge falls to the OFF margin", () => {
  // Edge has eroded to +1 (below ON margin) but it was already active → stays ON.
  const stillOn = decisionFor(
    [input({ symbol: "BTC", claudeAcc: 51, statAcc: 50, wasActive: true })],
    "BTC",
  );
  assert.equal(stillOn.active, true);

  // Edge sits exactly at the OFF margin (-2). Rule is "stays ON until edge falls
  // to OFF_MARGIN or below" → at -2 it turns OFF.
  const atOff = decisionFor(
    [input({ symbol: "BTC", claudeAcc: 48, statAcc: 50, wasActive: true })],
    "BTC",
  );
  assert.equal(atOff.marginPct, AUTOPILOT_OFF_MARGIN);
  assert.equal(atOff.active, false);

  // Just above the OFF margin (-1) and previously active → still ON (in the band).
  const inBand = decisionFor(
    [input({ symbol: "BTC", claudeAcc: 49, statAcc: 50, wasActive: true })],
    "BTC",
  );
  assert.equal(inBand.active, true);
});

test("hysteresis: a coin in the band (between OFF and ON margins) does not flip on by itself", () => {
  // Margin +2: above OFF, below ON. If it wasn't active, it must not turn on.
  const cold = decisionFor(
    [input({ symbol: "BTC", claudeAcc: 52, statAcc: 50, wasActive: false })],
    "BTC",
  );
  assert.equal(cold.active, false);
  // Same margin, but already active → it should remain on (sticky).
  const warm = decisionFor(
    [input({ symbol: "BTC", claudeAcc: 52, statAcc: 50, wasActive: true })],
    "BTC",
  );
  assert.equal(warm.active, true);
});

test("exploration: runs Claude when it has fewer than the explore-sample minimum", () => {
  const d = decisionFor(
    [input({ symbol: "BTC", claudeN: AUTOPILOT_EXPLORE_SAMPLES - 1, claudeAcc: 0, statAcc: 50 })],
    "BTC",
  );
  assert.equal(d.active, true);
  assert.equal(d.exploring, true);
  assert.match(d.reason, /Gathering Claude data/);
});

test("exploration: a null Claude accuracy (no evaluated bets yet) still explores", () => {
  const d = decisionFor(
    [input({ symbol: "BTC", claudeN: 0, claudeAcc: null, statAcc: 50 })],
    "BTC",
  );
  assert.equal(d.active, true);
  assert.equal(d.exploring, true);
});

test("min-sample gating: a thin stat baseline blocks any Claude activation", () => {
  const d = decisionFor(
    [
      input({
        symbol: "BTC",
        statN: AUTOPILOT_MIN_SAMPLES - 1,
        statAcc: 50,
        claudeAcc: 99, // would crush stat, but baseline is too thin to trust
      }),
    ],
    "BTC",
  );
  assert.equal(d.active, false);
  assert.equal(d.exploring, false);
  assert.match(d.reason, /Building stat baseline/);
});

test("global cap: never activates more than AUTOPILOT_MAX_ACTIVE coins", () => {
  // Make 5 coins all clear winners that would each want to run.
  const inputs = ["BTC", "ETH", "SOL", "XRP", "DOGE"].map((symbol, i) =>
    input({ symbol, claudeAcc: 90 - i, statAcc: 50, wasActive: false }),
  );
  const decisions = computeAutoPilotDecisions(inputs);
  const active = decisions.filter((d) => d.active);
  assert.equal(active.length, AUTOPILOT_MAX_ACTIVE);

  // The highest-edge coins win the slots; the rest are explicitly capped.
  const activeSymbols = active.map((d) => d.symbol).sort();
  assert.deepEqual(activeSymbols, ["BTC", "ETH", "SOL"]);
  const capped = decisions.filter((d) => !d.active);
  for (const d of capped) assert.match(d.reason, /Capped/);
});

test("global cap: proven winners outrank explorers for the limited slots", () => {
  // 3 proven winners + 1 explorer; cap is 3, so the explorer must miss out.
  const inputs = [
    input({ symbol: "BTC", claudeAcc: 70, statAcc: 50 }),
    input({ symbol: "ETH", claudeAcc: 68, statAcc: 50 }),
    input({ symbol: "SOL", claudeAcc: 66, statAcc: 50 }),
    input({ symbol: "XRP", claudeN: 0, claudeAcc: null, statAcc: 50 }), // explorer
  ];
  const decisions = computeAutoPilotDecisions(inputs);
  assert.equal(decisionFor(inputs, "XRP").active, false);
  assert.equal(decisions.filter((d) => d.active).length, AUTOPILOT_MAX_ACTIVE);
  assert.deepEqual(
    decisions
      .filter((d) => d.active)
      .map((d) => d.symbol)
      .sort(),
    ["BTC", "ETH", "SOL"],
  );
});

test("additive: a manually enabled coin stays enabled regardless of auto-pilot", () => {
  // Manual on, auto-pilot off → enabled.
  assert.equal(
    claudeEnabledFor({ manualEnabled: true, autoPilotEnabled: false, autoActive: false }),
    true,
  );
  // Manual on, auto-pilot on but this coin not auto-active → still enabled.
  assert.equal(
    claudeEnabledFor({ manualEnabled: true, autoPilotEnabled: true, autoActive: false }),
    true,
  );
  // Manual off, auto-pilot active → enabled by auto-pilot.
  assert.equal(
    claudeEnabledFor({ manualEnabled: false, autoPilotEnabled: true, autoActive: true }),
    true,
  );
  // Manual off, auto-pilot enabled but not active for this coin → disabled.
  assert.equal(
    claudeEnabledFor({ manualEnabled: false, autoPilotEnabled: true, autoActive: false }),
    false,
  );
  // Everything off → disabled.
  assert.equal(
    claudeEnabledFor({ manualEnabled: false, autoPilotEnabled: false, autoActive: false }),
    false,
  );
});

test("decisions are returned one-per-input, in input order", () => {
  const inputs = ["BTC", "ETH", "SOL"].map((symbol) => input({ symbol }));
  const decisions = computeAutoPilotDecisions(inputs);
  assert.deepEqual(
    decisions.map((d) => d.symbol),
    ["BTC", "ETH", "SOL"],
  );
});
