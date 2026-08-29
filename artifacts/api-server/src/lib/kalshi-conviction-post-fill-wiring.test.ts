import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("out-of-band conviction fills are persisted before the 70-cent hold-or-unwind policy", () => {
  const source = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  const postFillStart = source.indexOf("Audit the authoritative fill");
  const postFillEnd = source.indexOf("// Slippage guard", postFillStart);
  const postFill = source.slice(postFillStart, postFillEnd);
  assert.match(postFill, /evaluateConvictionFillZone/);
  assert.match(postFill, /convictionOutOfBandFill =/);
  assert.match(postFill, /shouldEmergencyExitConvictionFill/);
  assert.match(postFill, /inside hold buffer/);
  assert.match(
    source,
    /authorizationConvictionZone[\s\S]*deriveConvictionZone\(effective\.lockPrice, effective\.lockPriceCap\)/,
  );

  assert.match(source, /entryYesPrice: actualFillYesPrice/);
  const holdStart = source.indexOf('if (entryMode === "live" && convictionOutOfBandFill != null)');
  const holdEnd = source.indexOf("// Shadow paper bet", holdStart);
  const holdBlock = source.slice(holdStart, holdEnd);
  assert.match(holdBlock, /shouldEmergencyExitConvictionFill\(convictionOutOfBandFill\.sideCost\)/);
  assert.match(holdBlock, /closePosition\([\s\S]*"conviction_fill_below_emergency_floor"/);
  assert.match(holdBlock, /openPositions\.delete\(sym\)/);
  assert.match(holdBlock, /within the 70¢\+ hold buffer — holding position/);
});

test("recovered out-of-band fills unwind only when the persisted side cost is below 70 cents", () => {
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
  assert.match(management, /convictionOutOfBandFillDetails/);
  assert.match(management, /shouldEmergencyExitConvictionFill\(recoveredSideCost\)/);
  assert.match(management, /conviction_fill_below_emergency_floor/);
});