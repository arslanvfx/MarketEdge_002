import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeDashboard2Quote,
  createDashboard2Policy,
  DEFAULT_DASHBOARD2_POLICY,
} from "./dashboard2-policy.ts";

test("Dashboard 2.0 rejects before 8:00 and accepts at 8:00", () => {
  assert.equal(authorizeDashboard2Quote({ elapsedMinutes: 7.999, sideCost: 0.82, contractCount: 1 }).authorized, false);
  assert.equal(authorizeDashboard2Quote({ elapsedMinutes: 8, sideCost: 0.82, contractCount: 1 }).authorized, true);
});

test("Dashboard 2.0 side-cost boundaries are inclusive and ceiling is absolute", () => {
  assert.equal(authorizeDashboard2Quote({ elapsedMinutes: 8, sideCost: 0.79, contractCount: 1 }).authorized, true);
  assert.equal(authorizeDashboard2Quote({ elapsedMinutes: 8, sideCost: 0.87, contractCount: 1 }).authorized, true);
  assert.deepEqual(
    authorizeDashboard2Quote({ elapsedMinutes: 8, sideCost: 0.870001, contractCount: 1 }),
    { authorized: false, action: "reject", reason: "side_cost_above_ceiling" },
  );
});

test("Dashboard 2.0 enforces quantity cap", () => {
  assert.equal(
    authorizeDashboard2Quote({
      elapsedMinutes: 8,
      sideCost: 0.82,
      contractCount: DEFAULT_DASHBOARD2_POLICY.maxContracts + 1,
    }).authorized,
    false,
  );
  assert.equal(createDashboard2Policy(0.9).maxContracts, 1);
  assert.equal(createDashboard2Policy(0.5).maxContracts, 0);
  assert.equal(Object.isFrozen(DEFAULT_DASHBOARD2_POLICY), true);
});

test("exchange improvement below floor is hold-not-sell", () => {
  assert.deepEqual(
    authorizeDashboard2Quote({
      elapsedMinutes: 9,
      sideCost: 0.78,
      contractCount: 1,
      phase: "exchange-price-improvement",
    }),
    { authorized: false, action: "hold-not-sell", reason: "exchange_price_improved_below_floor" },
  );
});