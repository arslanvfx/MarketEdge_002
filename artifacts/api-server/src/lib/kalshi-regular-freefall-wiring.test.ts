import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("paper and live share one regular freefall decision at pre-submit", () => {
  const source = readFileSync(
    new URL("./kalshi-bot-tick.ts", import.meta.url),
    "utf8",
  );
  const decision = source.indexOf(
    "const regularFreefall = evaluateRegularFreefallPreSubmitGuard",
  );
  const liveBoundary = source.indexOf('if (entryMode === "live")', decision);
  const intent = source.indexOf("claimRegularOrderIntent", decision);
  assert.ok(decision >= 0);
  assert.ok(decision < liveBoundary);
  assert.ok(liveBoundary < intent);
  assert.match(
    source.slice(decision, liveBoundary),
    /regularFreefallSignals[\s\S]*convictionDirectionGuardBlockedMap\.set/,
  );
  assert.match(source.slice(decision, liveBoundary), /advisory: entryMode === "paper"/);
  assert.doesNotMatch(source.slice(decision, liveBoundary), /setTickAbortReason/);
  assert.match(source.slice(liveBoundary, intent), /setTickAbortReason/);
  assert.match(source, /regularFreefall: regularFreefallSignals/);
  assert.match(
    source.slice(liveBoundary, intent),
    /if \(S\.config\.shadowPaperBets\) persistSkip\("paper"\)/,
  );
});

test("dashboard distinguishes paper advisory and exposes regular-mode guard status", () => {
  const source = readFileSync(
    new URL("../../../market-edge/src/pages/bot/coin-signal-board.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /Paper advisory: a live entry would be blocked/);
  assert.match(source, /\? "Would block live"/);
  assert.match(source, />Live guard</);
  assert.match(source, /status-regular-guard-/);
});

test("one persisted false disables every regular direction guard checkpoint including FastLane", () => {
  const tickSource = readFileSync(
    new URL("./kalshi-bot-tick.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    tickSource,
    /\(S\.config\.convictionDirectionGuardEnabled \?\? true\) &&\s*candles\.length >= 2/,
  );
  assert.match(
    tickSource,
    /const regularFreefallEnabled = S\.config\.convictionDirectionGuardEnabled \?\? true/,
  );
  assert.match(
    tickSource,
    /enabled: regularFreefallEnabled,\s*samples: regularFreefallEnabled \? \(convictionPriceTicks\.get\(sym\) \?\? \[\]\) : \[\]/,
  );

  const routeSource = readFileSync(
    new URL("../routes/kalshi-bot.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    routeSource,
    /typeof convictionDirectionGuardEnabled === "boolean"[\s\S]*partial\.convictionDirectionGuardEnabled = convictionDirectionGuardEnabled/,
  );
});

test("one persisted false disables the final proximity checkpoint for Conviction and FastLane", () => {
  const loopSource = readFileSync(
    new URL("./kalshi-bot-loop.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    loopSource,
    /isConviction\s*&& \(S\.config\.convictionProximityGuardEnabled \?\? true\)[\s\S]*computeStrikeProximityGate/,
  );

  const tickSource = readFileSync(
    new URL("./kalshi-bot-tick.ts", import.meta.url),
    "utf8",
  );
  const finalProximitySection = tickSource.slice(
    tickSource.indexOf("Price-triggered strike-proximity re-check (tick-time)"),
    tickSource.indexOf("Pipeline direction guard", tickSource.indexOf("Price-triggered strike-proximity re-check (tick-time)")),
  );
  assert.match(
    finalProximitySection,
    /isPriceTriggeredMode\s*&& \(S\.config\.convictionProximityGuardEnabled \?\? true\)/,
  );
  assert.match(finalProximitySection, /computeStrikeProximityGate/);

  const reservationSection = tickSource.slice(
    tickSource.indexOf("Conviction once-per-window lock"),
    tickSource.indexOf("CONVICTION LIVE-PRICE GATE"),
  );
  assert.match(
    reservationSection,
    /if \(S\.config\.decisionMode === "conviction" \|\| isFastLane\)[\s\S]*tryClaimEntryReservation/,
  );
  assert.doesNotMatch(reservationSection, /convictionProximityGuardEnabled/);
  assert.match(reservationSection, /tryClaimEntryReservation\(convictionFiredThisWindow/);

  const routeSource = readFileSync(
    new URL("../routes/kalshi-bot.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    routeSource,
    /typeof convictionProximityGuardEnabled === "boolean"[\s\S]*partial\.convictionProximityGuardEnabled = convictionProximityGuardEnabled/,
  );
});