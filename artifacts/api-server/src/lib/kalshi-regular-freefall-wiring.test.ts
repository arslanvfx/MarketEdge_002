import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("paper and live enforce one profile-aware regular freefall decision at pre-submit", () => {
  const source = readFileSync(
    new URL("./kalshi-bot-tick.ts", import.meta.url),
    "utf8",
  );
  const decision = source.indexOf(
    "const regularFreefall = evaluateRegularFreefallPreSubmitGuard",
  );
  const blockedBoundary = source.indexOf("if (!regularFreefallPolicy.allowed)", decision);
  const intent = source.indexOf("claimRegularOrderIntent", decision);
  assert.ok(decision >= 0);
  assert.ok(decision < blockedBoundary);
  assert.ok(blockedBoundary < intent);
  assert.match(
    source.slice(decision, intent),
    /applyRegularFreefallSafetyProfile[\s\S]*regularFreefallSignals[\s\S]*convictionDirectionGuardBlockedMap\.set/,
  );
  assert.match(source.slice(decision, intent), /profile: S\.config\.entrySafetyProfile/);
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

test("dashboard exposes selected profile and relaxed regular-mode guard status", () => {
  const source = readFileSync(
    new URL("../../../market-edge/src/pages/bot/coin-signal-board.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /Advisory safety.*movement guard warning/);
  assert.match(source, /Safety:/);
  assert.match(source, /\? "Relaxed"/);
  assert.match(source, />Live guard</);
  assert.match(source, /status-regular-guard-/);
});

test("decision-mode presets cannot silently activate extreme-only", () => {
  const source = readFileSync(
    new URL("../routes/kalshi-bot.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /safePresets\[mode as DecisionMode\][\s\S]*stripEntrySafetyProfileFromModePreset\(preset\)/,
  );
  assert.match(
    source,
    /\[mode\]: stripEntrySafetyProfileFromModePreset\(config\)/,
  );
  assert.match(
    source,
    /Object\.assign\(partial, stripEntrySafetyProfileFromModePreset\(builtIn\)\)/,
  );
});