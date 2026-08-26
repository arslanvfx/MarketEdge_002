import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectRegularSmartExitHistory } from "./kalshi-smart-exit-history.ts";
import type { SmartExitLifecycleRecord } from "./kalshi-smart-exit-types.ts";

const lifecycle = {
  id: "lifecycle-1",
  owner: "regular",
  positionId: "position-1",
  symbol: "BTC",
  windowKey: "2025-01-01T00:00",
  ticker: "KXBTC",
  side: "yes",
  tradingMode: "paper",
  quantity: 4,
  requestedQuantity: 5,
  entryWinningPrice: 0.8,
  entryStake: 3.2,
  triggerEvaluationId: "evaluation-1",
  triggeredAt: "2025-01-01T00:10:00.000Z",
  advisoryOnly: false,
  executionStatus: "filled",
  requestId: "request-1",
  soldAt: "2025-01-01T00:11:00.000Z",
  winningFillPrice: 0.4,
  saleProceeds: 1.6,
  actualExitPnl: -1.6,
  settlementResult: "no",
  settledAt: "2025-01-01T00:15:00.000Z",
  holdValue: 0,
  holdPnl: -3.2,
  valueSaved: 1.6,
  verdict: "saved_loss",
  reason: "confirmed target crossing",
} satisfies SmartExitLifecycleRecord;

test("regular transaction projection uses exact durable position identity", () => {
  const rows = [
    { id: "position-1", ticker: "KXBTC", exitReason: "ordinary exit" },
    { id: "legacy", ticker: "KXBTC", exitReason: "smart-looking generic text" },
  ];
  const projected = projectRegularSmartExitHistory(rows, [lifecycle]);
  assert.deepEqual(projected[0].smartExit, lifecycle);
  assert.equal(projected[1].smartExit, undefined);
});

test("projection never attaches a scalper lifecycle to regular history", () => {
  const projected = projectRegularSmartExitHistory(
    [{ id: "position-1" }],
    [{ ...lifecycle, owner: "scalper" }],
  );
  assert.equal(projected[0].smartExit, undefined);
});

test("owner close persists an explicit Smart Exit stop-loss reason", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const source = readFileSync(join(here, "kalshi-smart-exit-owners.ts"), "utf8");
  assert.match(source, /position\.owner\.tradingMode === "paper"/);
  assert.match(source, /`smart_exit_stop_loss:\$\{parameterVersion\}`/);
  assert.match(source, /`smart_exit:\$\{parameterVersion\}`/);
});