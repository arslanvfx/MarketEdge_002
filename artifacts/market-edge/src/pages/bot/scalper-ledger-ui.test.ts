import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardSource = readFileSync(join(here, "../bot-dashboard.tsx"), "utf8");
const activePositionsSource = readFileSync(join(here, "active-positions.tsx"), "utf8");
const transactionLogSource = readFileSync(join(here, "transaction-log.tsx"), "utf8");
const panelSource = readFileSync(join(here, "bot-scalper-panel.tsx"), "utf8");
const ledgerSource = readFileSync(join(here, "scalper-ledger.ts"), "utf8");

describe("unified Scalper ledger wiring", () => {
  it("merges Scalper history instead of rendering a separate log", () => {
    assert.match(dashboardSource, /normalizeScalpOrders/);
    assert.match(dashboardSource, /scalper\/history\?limit=500/);
    assert.doesNotMatch(dashboardSource, /ScalpTransactionLog/);
  });

  it("offers a dedicated Scalper history source filter and amber badge", () => {
    assert.match(transactionLogSource, /\["all", "bot", "manual", "scalper", "skips"\]/);
    assert.match(transactionLogSource, /> SCALPER/);
    assert.match(transactionLogSource, /ring-amber-500/);
  });

  it("marks active Scalper positions without enabling manual close", () => {
    assert.match(activePositionsSource, /const isScalper = pos\.source === "scalper"/);
    assert.match(activePositionsSource, />\s*SCALPER\s*</);
    assert.match(activePositionsSource, /\{isManual && \(\s*<button/);
    assert.doesNotMatch(activePositionsSource, /isScalper && \(\s*<button/);
  });

  it("explains preliminary candidates and renders durable attempt reasons", () => {
    assert.match(panelSource, /in-band scan is only a preliminary candidate/i);
    assert.match(panelSource, /recentAttempts/);
    assert.match(panelSource, /describeScalperAttempt/);
    assert.match(panelSource, /Guard checked \{fmtDateTime\(attempt\.attemptedAt\)\}/);
    assert.match(panelSource, /text-scalper-attempt-timestamp-/);
    assert.match(panelSource, /Show check details/);
    assert.match(panelSource, /button-scalper-check-details-/);
  });

  it("shows successful regular-position layers in unified history", () => {
    assert.match(transactionLogSource, /layered on regular/);
    assert.match(transactionLogSource, /layeredRegularPositionId/);
    assert.match(transactionLogSource, /regularIdsShownInLayeredCards/);
    assert.match(transactionLogSource, /history-layered-bet-/);
    assert.match(transactionLogSource, /Layered regular bet/);
    assert.match(panelSource, /describeScalperAttempt/);
  });

  it("styles standalone regular bet cards with the navy premium treatment", () => {
    assert.match(transactionLogSource, /const REGULAR_CARD_CLASS/);
    assert.match(transactionLogSource, /#07111f/);
    assert.match(transactionLogSource, /REGULAR_METRIC_CLASS/);
    assert.match(transactionLogSource, /> REGULAR/);
  });

  it("preserves entry guard evidence in unified Scalper history", () => {
    assert.match(ledgerSource, /entryGuardEvidence/);
    assert.match(transactionLogSource, /entryGuardEvidence/);
  });

  it("shows successful safety-check evidence in recent candidates", () => {
    assert.match(panelSource, /SAFETY CHECKS PASSED/);
    assert.match(panelSource, /text-emerald-400/);
  });

  it("renders pre-submit guard evidence in Scalper history cards", () => {
    assert.match(transactionLogSource, /describeEntryGuardEvidence/);
    assert.match(transactionLogSource, /text-scalper-entry-guard-evidence-/);
    assert.match(transactionLogSource, /SAFETY CHECKS PASSED/);
  });

  it("exports the pre-submit evidence formatter with post-fill separation", () => {
    assert.match(ledgerSource, /export function describeEntryGuardEvidence/);
    assert.match(ledgerSource, /samples exclude post-fill movement/);
  });
});
