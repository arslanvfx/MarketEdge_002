import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BOT_CONFIG } from "./kalshi-bot-engine-core.ts";
import { applyDashboard2CanonicalPolicy } from "./dashboard2-canonical-policy.ts";

const at = new Date("2025-01-06T12:00:00.000Z"); // Monday, ET
const decide = (patch: object, mode: "paper" | "live" = "paper", quantity = 10) =>
  applyDashboard2CanonicalPolicy({
    canonicalConfig: { ...DEFAULT_BOT_CONFIG, betSize: 10, ...patch }, symbol: "BTC", mode,
    sideCost: .8, dashboardBudget: 10, maxContracts: 10, intendedQuantity: quantity, now: at,
  });

test("Dashboard2 canonical policy blocks paused coins in paper and live", () => {
  for (const mode of ["paper", "live"] as const) {
    const decision = decide({ coinOverrides: { BTC: { paused: true } } }, mode);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "canonical_coin_paused");
  }
});

test("Dashboard2 canonical policy honors Smart Hours blocks and refuses live forced-paper", () => {
  const silent = decide({ quietHoursV2: { enabled: true, silencedUtcHours: [12], reducedBetUtcHours: {} } });
  assert.equal(silent.reason, "canonical_smart_hours_blocked");
  const bypass = decide({
    quietHoursV2: { enabled: true, silencedUtcHours: [12], reducedBetUtcHours: {} },
    shadowPaperIgnoreQuietHours: true,
  }, "live");
  assert.equal(bypass.reason, "canonical_smart_hours_forced_paper");
});

test("Dashboard2 canonical policy caps reduced, data-gathering, overrides, and contracts", () => {
  assert.equal(decide({
    quietHoursV2: { enabled: true, silencedUtcHours: [], reducedBetUtcHours: { "12": 50 } },
  }).cappedQuantity, 6); // $5 / $0.80
  const gathering = decide({
    quietHoursV2: { enabled: true, silencedUtcHours: [], reducedBetUtcHours: {}, dataGatheringByDow: { "1": [12] } },
    dataGatheringBetCap: 1.7,
  });
  assert.equal(gathering.cappedQuantity, 2);
  assert.equal(gathering.dataGatheringAmount, 1.7);
  assert.equal(decide({ coinOverrides: { BTC: { maxBetSize: 1.59 } } }).cappedQuantity, 1);
  assert.equal(decide({ betSize: 2 }).cappedQuantity, 2);
  assert.equal(decide({}, "paper", 10).cappedQuantity, 10);
  assert.equal(applyDashboard2CanonicalPolicy({
    canonicalConfig: { ...DEFAULT_BOT_CONFIG, betSize: 10 }, symbol: "BTC", mode: "paper", sideCost: .8,
    dashboardBudget: 10, maxContracts: 2, intendedQuantity: 10, now: at,
  }).cappedQuantity, 2);
});

test("Dashboard2 canonical policy blocks quantity below one and disabled data gathering", () => {
  assert.equal(decide({ coinOverrides: { BTC: { maxBetSize: .79 } } }).reason, "canonical_budget_below_one_contract");
  assert.equal(decide({
    quietHoursV2: { enabled: true, silencedUtcHours: [], reducedBetUtcHours: {}, dataGatheringByDow: { "1": [12] } },
    dataGatheringEnabled: false,
  }).reason, "canonical_smart_hours_blocked");
});