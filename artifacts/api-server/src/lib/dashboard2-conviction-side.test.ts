import assert from "node:assert/strict";
import test from "node:test";
import {
  selectDashboard2ConvictionSideFromSnapshot,
  type Dashboard2ConvictionSnapshot,
} from "./dashboard2-conviction-side.ts";

const snapshot = (
  overrides: Partial<Dashboard2ConvictionSnapshot> = {},
): Dashboard2ConvictionSnapshot => ({
  yesAsk: 0.8,
  yesBid: 0.19,
  noAsk: 0.81,
  fetchedAt: Date.now(),
  ticker: "KXTEST",
  target: 100,
  ...overrides,
});

test("Dashboard 2 uses Bot 1 conviction YES precedence when both sides are in band", () => {
  const selected = selectDashboard2ConvictionSideFromSnapshot(
    snapshot(),
    "KXTEST",
    0.79,
    0.85,
  );
  assert.equal(selected?.side, "yes");
  assert.equal(selected?.ask, 0.8);
});

test("Dashboard 2 selects NO only when Bot 1 conviction NO is the qualifying side", () => {
  const selected = selectDashboard2ConvictionSideFromSnapshot(
    snapshot({ yesAsk: 0.4, yesBid: 0.2, noAsk: 0.8 }),
    "KXTEST",
    0.79,
    0.85,
  );
  assert.equal(selected?.side, "no");
  assert.equal(selected?.ask, 0.8);
});

test("Dashboard 2 fails closed when the conviction ticker differs", () => {
  const selected = selectDashboard2ConvictionSideFromSnapshot(
    snapshot({ ticker: "KXOTHER" }),
    "KXTEST",
    0.79,
    0.85,
  );
  assert.equal(selected, null);
});

test("nearest-side selection is display-only and execution remains out-of-band", () => {
  const liveSelection = selectDashboard2ConvictionSideFromSnapshot(
    snapshot({ yesAsk: 0.7, noAsk: 0.9 }),
    "KXTEST",
    0.79,
    0.85,
  );
  const displaySelection = selectDashboard2ConvictionSideFromSnapshot(
    snapshot({ yesAsk: 0.7, noAsk: 0.9 }),
    "KXTEST",
    0.79,
    0.85,
    true,
  );
  assert.equal(liveSelection, null);
  assert.equal(displaySelection?.side, "no");
});