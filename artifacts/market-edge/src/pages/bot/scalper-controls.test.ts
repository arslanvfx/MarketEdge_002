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

  it("surfaces distinct unresolved live attempts in the circuit-breaker banner", () => {
    assert.match(panelSource, /statusData\?\.unresolvedAttempts/);
    assert.match(panelSource, /list-scalper-unresolved-attempts/);
    // Records are grouped by attemptId for the count, but every unresolved
    // order record remains individually actionable.
    assert.match(panelSource, /groups\.get\(attempt\.attemptId\)/);
    assert.match(panelSource, /records\.map\(\(record, index\)/);
    // Each attempt shows its symbol, original window/time, and a readable reason.
    assert.match(panelSource, /text-scalper-unresolved-symbol-/);
    assert.match(panelSource, /wkToEstRange\(attempt\.windowKey\)/);
    assert.match(panelSource, /fmtDateTime\(attempt\.createdAt\)/);
    assert.match(panelSource, /text-scalper-unresolved-reason-/);
    assert.match(panelSource, /readableReason\(record\.reason\)/);
  });

  it("only offers Reconcile with Kalshi when an order record exists", () => {
    assert.match(panelSource, /record\.orderRecordId \? \(/);
    assert.match(panelSource, /button-scalper-reconcile-/);
    assert.match(panelSource, /Reconcile with Kalshi/);
    assert.match(panelSource, /No order to reconcile/);
  });

  it("posts the reconcile request with only the orderRecordId", () => {
    assert.match(
      panelSource,
      /authPost\(\s*"\/crypto\/scalper\/reconcile-order",\s*\{\s*orderRecordId: attempt\.orderRecordId,\s*\}\s*\)/,
    );
  });

  it("tracks reconcile busy state independently from the config/reset mutation state", () => {
    assert.match(panelSource, /reconcileBusyId, setReconcileBusyId/);
    assert.match(panelSource, /setReconcileBusyId\(attempt\.orderRecordId \?\? attempt\.attemptId\)/);
    assert.match(panelSource, /reconcileBusyId === busyKey \? "Reconciling…"/);
    // Reconcile buttons disable on reconcile state, not the config mutation state.
    assert.match(panelSource, /disabled=\{!canManage \|\| reconcileBusyId !== null\}/);
    // Reset stays gated only by the existing mutation state.
    assert.match(panelSource, /onClick=\{resetCircuitBreaker\}\s*\n\s*disabled=\{!canManage \|\| mutationBusy !== null\}/);
  });

  it("invalidates config, status, history, and performance after a successful reconcile", () => {
    const reconcileFn = panelSource.match(/async function reconcileAttempt[\s\S]*?\n  \}/);
    assert.ok(reconcileFn, "reconcileAttempt function must exist");
    const body = reconcileFn[0];
    assert.match(body, /invalidateQueries\(\{ queryKey: \["bot-scalper-config"\] \}\)/);
    assert.match(body, /invalidateQueries\(\{ queryKey: \["bot-scalper-status"\] \}\)/);
    assert.match(body, /invalidateQueries\(\{ queryKey: \["bot-scalper-history"\] \}\)/);
    assert.match(body, /invalidateQueries\(\{ queryKey: \["bot-scalper-perf"\] \}\)/);
  });

  it("does not render raw client, exchange, or order IDs in the UI", () => {
    assert.doesNotMatch(panelSource, /\{attempt\.clientOrderId\}/);
    assert.doesNotMatch(panelSource, /\{attempt\.exchangeOrderId\}/);
    assert.doesNotMatch(panelSource, /\{attempt\.orderRecordId\}/);
  });
});