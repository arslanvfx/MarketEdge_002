import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("paper and live enforce one regular freefall decision at pre-submit", () => {
  const source = readFileSync(
    new URL("./kalshi-bot-tick.ts", import.meta.url),
    "utf8",
  );
  const decision = source.indexOf(
    "const regularFreefall = evaluateRegularFreefallPreSubmitGuard",
  );
  const blockedBoundary = source.indexOf("if (!regularFreefall.allowed)", decision);
  const intent = source.indexOf("claimRegularOrderIntent", decision);
  assert.ok(decision >= 0);
  assert.ok(decision < blockedBoundary);
  assert.ok(blockedBoundary < intent);
  assert.match(
    source.slice(decision, intent),
    /regularFreefallSignals[\s\S]*convictionDirectionGuardBlockedMap\.set/,
  );
  assert.doesNotMatch(source.slice(decision, intent), /advisory: entryMode === "paper"/);
  assert.match(source.slice(blockedBoundary, intent), /setTickAbortReason/);
  assert.match(source.slice(blockedBoundary, intent), /persistSkip\(entryMode\)/);
  assert.match(source.slice(blockedBoundary, intent), /return;/);
  assert.match(source, /regularFreefall: regularFreefallSignals/);
  assert.match(
    source.slice(blockedBoundary, intent),
    /entryMode === "live" && S\.config\.shadowPaperBets/,
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