import assert from "node:assert/strict";
import test from "node:test";
import { selectDashboard2KalshiDirection } from "./dashboard2-kalshi-direction.ts";
import type { KalshiTopOfBook } from "./kalshi-orderbook-store.ts";

const snapshot = (overrides: Partial<KalshiTopOfBook> = {}): KalshiTopOfBook => ({
  ticker: "KXTEST",
  yesBid: 0.19,
  yesAsk: 0.8,
  noBid: 0.2,
  noAsk: 0.81,
  seq: 10,
  updatedAt: Date.now(),
  bookVersion: "1:10",
  ...overrides,
});

test("selects YES when only the direct YES ask is inside the entry band", () => {
  const selected = selectDashboard2KalshiDirection(
    snapshot({ yesAsk: 0.8, noAsk: 0.22 }),
    0.79,
    0.85,
  );
  assert.equal(selected?.side, "yes");
  assert.equal(selected?.ask, 0.8);
});

test("selects NO when only the direct NO ask is inside the entry band", () => {
  const selected = selectDashboard2KalshiDirection(
    snapshot({ yesAsk: 0.21, noAsk: 0.8 }),
    0.79,
    0.85,
  );
  assert.equal(selected?.side, "no");
  assert.equal(selected?.ask, 0.8);
});

test("fails closed when both opposite direct asks are inside the entry band", () => {
  assert.equal(selectDashboard2KalshiDirection(snapshot(), 0.79, 0.85), null);
});

test("nearest-side selection is display-only and execution remains out-of-band", () => {
  const quote = snapshot({ yesAsk: 0.7, noAsk: 0.9 });
  assert.equal(selectDashboard2KalshiDirection(quote, 0.79, 0.85), null);
  assert.equal(selectDashboard2KalshiDirection(quote, 0.79, 0.85, true)?.side, "no");
});