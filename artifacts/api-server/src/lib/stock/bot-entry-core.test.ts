import { test } from "node:test";
import assert from "node:assert/strict";
import { selectEntryMode, heldKey } from "./bot-entry-core.ts";
import type { TradingMode } from "./types.ts";

const ALL: TradingMode[] = ["day", "swing", "long"];
const caps = { day: 3, swing: 3, long: 3 };
const zero = { day: 0, swing: 0, long: 0 };

function base(overrides: Partial<Parameters<typeof selectEntryMode>[0]> = {}) {
  return {
    ticker: "AAPL",
    horizon: null as TradingMode | null,
    held: new Set<string>(),
    modeCounts: { ...zero },
    caps,
    activeModes: ALL,
    pdtBlocked: false,
    ...overrides,
  };
}

test("same ticker can enter a second horizon while the first is held", () => {
  const held = new Set([heldKey("AAPL", "day")]);
  const r = selectEntryMode(base({ horizon: "swing", held }));
  assert.equal(r.mode, "swing");
  assert.equal(r.allHeld, false);
});

test("same ticker can hold all three horizons concurrently", () => {
  const held = new Set<string>();
  for (const h of ALL) {
    const r = selectEntryMode(base({ horizon: h, held }));
    assert.equal(r.mode, h);
    held.add(heldKey("AAPL", r.mode!));
  }
  assert.equal(held.size, 3);
});

test("duplicate entry in the same (ticker, horizon) is blocked", () => {
  const held = new Set([heldKey("AAPL", "swing")]);
  const r = selectEntryMode(base({ horizon: "swing", held }));
  assert.equal(r.mode, null);
  assert.equal(r.allHeld, true);
});

test("flexible candidate skips a held horizon and takes the next preference", () => {
  const held = new Set([heldKey("AAPL", "day")]);
  const r = selectEntryMode(base({ held }));
  assert.equal(r.mode, "swing");
});

test("flexible candidate with all horizons held returns null with allHeld=true", () => {
  const held = new Set(ALL.map((m) => heldKey("AAPL", m)));
  const r = selectEntryMode(base({ held }));
  assert.equal(r.mode, null);
  assert.equal(r.allHeld, true);
});

test("held guard is per-ticker: another ticker's position does not block", () => {
  const held = new Set([heldKey("MSFT", "day")]);
  const r = selectEntryMode(base({ horizon: "day", held }));
  assert.equal(r.mode, "day");
});

test("horizon capacity full returns null but allHeld=false (real capacity skip)", () => {
  const r = selectEntryMode(base({ horizon: "day", modeCounts: { ...zero, day: 3 } }));
  assert.equal(r.mode, null);
  assert.equal(r.allHeld, false);
});

test("inactive mode is not selectable", () => {
  const r = selectEntryMode(base({ horizon: "day", activeModes: ["swing", "long"] }));
  assert.equal(r.mode, null);
  assert.equal(r.allHeld, false);
});

test("PDT block prevents day entries but not other horizons", () => {
  const day = selectEntryMode(base({ horizon: "day", pdtBlocked: true }));
  assert.equal(day.mode, null);
  const flex = selectEntryMode(base({ pdtBlocked: true }));
  assert.equal(flex.mode, "swing");
});

test("research-driven candidate never falls back to another horizon", () => {
  const held = new Set([heldKey("AAPL", "long")]);
  const r = selectEntryMode(base({ horizon: "long", held }));
  assert.equal(r.mode, null);
  assert.equal(r.allHeld, true);
});
