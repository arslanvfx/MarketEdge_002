import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const panelSource = readFileSync(join(here, "bot-scalper-panel.tsx"), "utf8");

describe("Scalper control wiring", () => {
  it("does not accept or use the regular bot activeMode", () => {
    assert.doesNotMatch(panelSource, /\bactiveMode\b/);
    assert.match(panelSource, /const scalperMode = cfg\?\.mode \?\? "paper"/);
  });

  it("queries status and performance using the Scalper's own mode", () => {
    assert.match(panelSource, /scalper\/status\?mode=\$\{scalperMode\}/);
    assert.match(panelSource, /scalper\/performance\?mode=\$\{scalperMode\}/);
  });

  it("labels in-band scanner results as preliminary candidates", () => {
    assert.match(panelSource, /in-band scan is only a preliminary candidate/i);
    assert.match(panelSource, /candidate ·/);
  });

  it("renders an explicit enable switch and Paper/Live controls", () => {
    assert.match(panelSource, /role="switch"/);
    assert.match(panelSource, /Enable Scalper/);
    assert.match(panelSource, /\(\["paper", "live"\] as const\)\.map/);
  });

  it("offers independent circuit-breaker protection with a risk warning", () => {
    assert.match(panelSource, /switch-scalper-circuit-breaker/);
    assert.match(panelSource, /Circuit-breaker protection is off/);
    assert.match(panelSource, /will no longer pause new Scalper attempts/);
  });

  it("shows the server's plain-English circuit-breaker explanation instead of its raw code", () => {
    assert.match(panelSource, /statusData\?\.circuitBreakerMessage/);
    assert.doesNotMatch(panelSource, /\{merged\.circuitBreakerReason/);
  });

  it("uses signed-in access without a separate secret or role-claim step", () => {
    assert.match(panelSource, /Signed-in access verified/);
    assert.doesNotMatch(panelSource, /\/crypto\/scalper\/admin\/claim/);
    assert.doesNotMatch(panelSource, /canClaimAdmin/);
    assert.doesNotMatch(panelSource, /BOT_ADMIN_CLERK_USER_ID/);
  });

  it("retains draft settings when a save throws", () => {
    const catchBlock = panelSource.match(/async function applyConfigPatch[\s\S]*?catch \(error\) \{([\s\S]*?)\n    \} finally/);
    assert.ok(catchBlock, "applyConfigPatch catch block must exist");
    assert.doesNotMatch(catchBlock[1], /setConfigDraft\(\{\}\)/);
  });
});