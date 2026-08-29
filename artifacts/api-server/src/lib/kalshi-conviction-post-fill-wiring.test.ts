import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("out-of-band conviction fills are persisted at the actual price and immediately unwound", () => {
  const source = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  const postFillStart = source.indexOf("Layer 3: validate the authoritative fill");
  const postFillEnd = source.indexOf("// Slippage guard", postFillStart);
  const postFill = source.slice(postFillStart, postFillEnd);
  assert.match(postFill, /evaluateConvictionFillZone/);
  assert.match(postFill, /convictionOutOfBandFill =/);
  assert.doesNotMatch(postFill, /holding position|audit recorded/);
  assert.match(
    source,
    /authorizationConvictionZone[\s\S]*deriveConvictionZone\(effective\.lockPrice, effective\.lockPriceCap\)/,
  );

  assert.match(source, /entryYesPrice: actualFillYesPrice/);
  assert.match(
    source,
    /entryMode === "live" && convictionOutOfBandFill != null[\s\S]*closePosition\([\s\S]*"conviction_fill_outside_entry_band"[\s\S]*openPositions\.delete\(sym\)/,
  );
});

test("recovered out-of-band fills remain tagged for the position manager to unwind", () => {
  const reconcile = readFileSync(
    new URL("./kalshi-regular-order-reconcile.ts", import.meta.url),
    "utf8",
  );
  assert.match(reconcile, /evaluateConvictionFillZone/);
  assert.match(reconcile, /convictionOutOfBandFill: recoveredOutOfBandFill != null/);

  const tick = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  const managementStart = tick.indexOf("// ── POSITION MANAGEMENT");
  const managementEnd = tick.indexOf("// Use last known yes-price", managementStart);
  const management = tick.slice(managementStart, managementEnd);
  assert.match(management, /convictionOutOfBandFill/);
  assert.match(management, /closePosition\(pos, yesPrice, kalshiTarget, "conviction_fill_outside_entry_band"\)/);
});