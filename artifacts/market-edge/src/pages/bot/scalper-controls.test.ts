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

  it("renders an explicit enable switch and Paper/Live controls", () => {
    assert.match(panelSource, /role="switch"/);
    assert.match(panelSource, /Enable Scalper/);
    assert.match(panelSource, /\(\["paper", "live"\] as const\)\.map/);
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