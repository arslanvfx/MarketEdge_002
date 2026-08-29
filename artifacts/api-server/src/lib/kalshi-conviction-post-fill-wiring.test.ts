import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("out-of-band conviction fills are persisted at the actual price and held", () => {
  const source = readFileSync(new URL("./kalshi-bot-tick.ts", import.meta.url), "utf8");
  const postFillStart = source.indexOf("Audit the authoritative fill");
  const postFillEnd = source.indexOf("// Slippage guard", postFillStart);
  const postFill = source.slice(postFillStart, postFillEnd);
  assert.match(postFill, /evaluateConvictionFillZone/);
  assert.match(postFill, /convictionOutOfBandFill =/);
  assert.match(postFill, /audit recorded; position will be held/);
  assert.match(
    source,
    /authorizationConvictionZone[\s\S]*deriveConvictionZone\(effective\.lockPrice, effective\.lockPriceCap\)/,
  );

  assert.match(source, /entryYesPrice: actualFillYesPrice/);
  const holdStart = source.indexOf('if (entryMode === "live" && convictionOutOfBandFill != null)');
  const holdEnd = source.indexOf("// Shadow paper bet", holdStart);
  const holdBlock = source.slice(holdStart, holdEnd);
  assert.match(holdBlock, /holding position; no automatic unwind/);
  assert.doesNotMatch(holdBlock, /closePosition\(/);
  assert.doesNotMatch(holdBlock, /openPositions\.delete/);
});

test("recovered out-of-band fills remain tagged for audit but are not auto-unwound", () => {
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
  assert.doesNotMatch(management, /convictionOutOfBandFill/);
  assert.doesNotMatch(management, /conviction_fill_outside_entry_band/);
});