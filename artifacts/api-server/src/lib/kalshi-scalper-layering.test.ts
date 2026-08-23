import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateRegularPositionCompatibility,
  type RegularPositionForScalperLayering,
} from "./kalshi-scalper-layering.ts";

const here = dirname(fileURLToPath(import.meta.url));
const helperSource = readFileSync(join(here, "kalshi-scalper-layering.ts"), "utf8");
const serviceSource = readFileSync(join(here, "kalshi-scalper-service.ts"), "utf8");
const dbSource = readFileSync(join(here, "kalshi-scalper-db.ts"), "utf8");

function position(
  overrides: Partial<RegularPositionForScalperLayering> = {},
): RegularPositionForScalperLayering {
  return {
    id: "regular-position-1",
    symbol: "BTC",
    windowKey: "2026-08-22T18:00:00.000Z",
    ticker: "KXBTC15M-26AUG221400-15",
    direction: "yes",
    entryMode: "live",
    ...overrides,
  };
}

function query(
  overrides: Partial<Parameters<typeof evaluateRegularPositionCompatibility>[1]> = {},
) {
  return {
    mode: "live" as const,
    symbol: "BTC",
    windowKey: "2026-08-22T18:00:00.000Z",
    ticker: "KXBTC15M-26AUG221400-15",
    side: "yes" as const,
    ...overrides,
  };
}

describe("regular-position Scalper compatibility", () => {
  it("allows same-side YES and NO layers", () => {
    assert.equal(
      evaluateRegularPositionCompatibility(position(), query()).status,
      "same_side",
    );
    assert.equal(
      evaluateRegularPositionCompatibility(
        position({ direction: "no" }),
        query({ side: "no" }),
      ).status,
      "same_side",
    );
  });

  it("blocks an opposite-side Scalper candidate", () => {
    const result = evaluateRegularPositionCompatibility(
      position({ direction: "no" }),
      query({ side: "yes" }),
    );
    assert.equal(result.status, "opposite_side");
    assert.equal(result.position?.id, "regular-position-1");
  });

  it("keeps paper/live, ticker, and window scopes isolated", () => {
    assert.equal(
      evaluateRegularPositionCompatibility(position({ entryMode: "paper" }), query()).status,
      "none",
    );
    assert.equal(
      evaluateRegularPositionCompatibility(position({ ticker: "OTHER" }), query()).status,
      "none",
    );
    assert.equal(
      evaluateRegularPositionCompatibility(position({ windowKey: "OTHER" }), query()).status,
      "none",
    );
  });

  it("uses the current in-memory position at the final boundary", () => {
    let current = position({ direction: "yes" });
    assert.equal(evaluateRegularPositionCompatibility(current, query()).status, "same_side");
    current = position({ direction: "no" });
    assert.equal(evaluateRegularPositionCompatibility(current, query()).status, "opposite_side");
  });

  it("is a synchronous pure read with no I/O dependency", () => {
    const result = evaluateRegularPositionCompatibility(position(), query());
    assert.equal(result instanceof Promise, false);
    assert.doesNotMatch(helperSource, /\bawait\b|\bfetch\(|\.query\(|pool\.connect/);
  });
});

describe("Scalper layering execution wiring", () => {
  it("warms regular positions during preflight and rechecks before intent and submit", () => {
    assert.match(serviceSource, /_warmRegularPositionReadView\(mode, windowKey\)/);
    const authoritativeQuote = serviceSource.indexOf("const effectiveSide = match2.side");
    const firstCompatibility = serviceSource.indexOf(
      "runtime.regularPositionCompatibilitySync(",
      authoritativeQuote,
    );
    const intentInsert = serviceSource.indexOf("await runtime.insertScalpOrderIntent(orderRecord)");
    const finalCompatibility = serviceSource.indexOf(
      "const finalLayerLive = runtime.regularPositionCompatibilitySync(",
      intentInsert,
    );
    const brokerSubmit = serviceSource.indexOf("await runtime.placeScalpOrderStrict({", finalCompatibility);
    assert.ok(firstCompatibility > authoritativeQuote);
    assert.ok(firstCompatibility < intentInsert);
    assert.ok(finalCompatibility > intentInsert);
    assert.ok(finalCompatibility < brokerSubmit);
  });

  it("persists successful layer metadata without sharing regular order ownership", () => {
    assert.match(dbSource, /layered_regular_position_id/);
    assert.match(dbSource, /layered_regular_side/);
    assert.match(serviceSource, /layeredRegularPositionId: orderRecord\.layeredRegularPositionId/);
    assert.doesNotMatch(serviceSource, /regularBot.*(?:claimReservation|placeOrder|settlement)/i);
  });
});