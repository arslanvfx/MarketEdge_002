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

test("one persisted false disables both regular direction guard checkpoints", () => {
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
    /evaluateRegularFreefallPreSubmitGuard\(\{\s*enabled: S\.config\.convictionDirectionGuardEnabled \?\? true,/,
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