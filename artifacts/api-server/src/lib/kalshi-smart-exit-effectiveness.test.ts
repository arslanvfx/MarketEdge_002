import assert from "node:assert/strict";
import test from "node:test";
import {
  computeSmartExitEffectiveness,
  computeSmartExitEffectivenessFromProceeds,
  getSmartExitShadowProceeds,
  isSmartExitCounterfactualScoreable,
} from "./kalshi-smart-exit-types.ts";

test("Smart Exit records loss saved for a losing YES exit", () => {
  const result = computeSmartExitEffectiveness({
    side: "yes", quantity: 10, entryWinningPrice: 0.8,
    winningFillPrice: 0.35, settlementResult: "no",
  });
  assert.equal(result.holdPnl, -8);
  assert.equal(result.actualExitPnl, -4.5);
  assert.equal(result.valueSaved, 3.5);
  assert.equal(result.verdict, "saved_loss");
});

test("Smart Exit records a missed win for a winning NO exit", () => {
  const result = computeSmartExitEffectiveness({
    side: "no", quantity: 5, entryWinningPrice: 0.7,
    winningFillPrice: 0.4, settlementResult: "no",
  });
  assert.equal(result.holdPnl, 1.5);
  assert.equal(result.actualExitPnl, -1.5);
  assert.equal(result.valueSaved, -3);
  assert.equal(result.verdict, "missed_win");
});

test("Smart Exit effectiveness stays pending without settlement or fill", () => {
  assert.equal(computeSmartExitEffectiveness({
    side: "yes", quantity: 2, entryWinningPrice: 0.6,
    winningFillPrice: null, settlementResult: "no",
  }).verdict, "pending");
});

test("shadow exit compares frozen simulated proceeds with a full losing settlement", () => {
  const result = computeSmartExitEffectivenessFromProceeds({
    side: "yes", quantity: 20, entryStake: 16,
    exitProceeds: 7, settlementResult: "no",
  });
  assert.equal(result.actualExitPnl, -9);
  assert.equal(result.holdPnl, -16);
  assert.equal(result.valueSaved, 7);
  assert.equal(result.verdict, "saved_loss");
});

test("shadow exit reports forfeited profit when the position ultimately wins", () => {
  const result = computeSmartExitEffectivenessFromProceeds({
    side: "no", quantity: 10, entryStake: 6,
    exitProceeds: 3, settlementResult: "no",
  });
  assert.equal(result.actualExitPnl, -3);
  assert.equal(result.holdPnl, 4);
  assert.equal(result.valueSaved, -7);
  assert.equal(result.verdict, "missed_win");
});

test("shadow proceeds require full executable evidence", () => {
  assert.equal(getSmartExitShadowProceeds({
    executionEvidenceReady: false,
    estimatedSaleValue: 7,
    liquidityCoverage: 1,
    remainingQuantity: 10,
  }, 10), null);
  assert.equal(getSmartExitShadowProceeds({
    executionEvidenceReady: true,
    estimatedSaleValue: 7,
    liquidityCoverage: 1,
    remainingQuantity: 10,
  }, 10), 7);
});

test("shadow, blocked, and zero-fill triggers remain counterfactually scoreable", () => {
  assert.equal(isSmartExitCounterfactualScoreable({
    advisoryOnly: true,
    executionStatus: "advisory",
  }), true);
  assert.equal(isSmartExitCounterfactualScoreable({
    advisoryOnly: false,
    executionStatus: "blocked",
  }), true);
  assert.equal(isSmartExitCounterfactualScoreable({
    advisoryOnly: false,
    executionStatus: "zero_fill",
  }), true);
  assert.equal(isSmartExitCounterfactualScoreable({
    advisoryOnly: false,
    executionStatus: "unknown",
  }), false);
});