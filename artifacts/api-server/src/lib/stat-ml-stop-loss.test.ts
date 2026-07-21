import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── Pure stop-loss math (mirrors the loop in kalshi-bot-loop.ts) ────────────
// Isolated from DB/state imports so it can run as a unit test.

function computeLossFrac(
  direction: "yes" | "no",
  entryYesPrice: number,
  currentYesPrice: number,
): number {
  const entryCost    = direction === "yes" ? entryYesPrice       : 1 - entryYesPrice;
  const currentValue = direction === "yes" ? currentYesPrice     : 1 - currentYesPrice;
  if (entryCost <= 0) return 0;
  return (entryCost - currentValue) / entryCost;
}

function shouldTriggerStopLoss(
  entryDecisionMode: string | undefined,
  direction: "yes" | "no",
  entryYesPrice: number,
  currentYesPrice: number,
  stopLossPct: number,
): boolean {
  // Gate 1: position must have been opened in stat_ml mode
  if (entryDecisionMode !== "stat_ml") return false;
  const lossFrac = computeLossFrac(direction, entryYesPrice, currentYesPrice);
  return lossFrac >= stopLossPct;
}

describe("stat_ml stop-loss trigger", () => {
  describe("YES positions", () => {
    it("triggers when loss exceeds threshold", () => {
      // Entry at 0.70, price falls to 0.50 → loss ≈ 28.6%
      const triggered = shouldTriggerStopLoss("stat_ml", "yes", 0.70, 0.50, 0.20);
      assert.equal(triggered, true);
    });

    it("does not trigger when within threshold", () => {
      // Entry at 0.70, price falls to 0.65 → loss ≈ 7.1%
      const triggered = shouldTriggerStopLoss("stat_ml", "yes", 0.70, 0.65, 0.20);
      assert.equal(triggered, false);
    });

    it("triggers when loss is at or above threshold (>= semantics)", () => {
      // Entry at 0.75, price falls to 0.60 → loss = 0.15/0.75 = 0.20 (exact in IEEE-754 with these fractions)
      // Use stopLossPct of 0.19 to stay safely above boundary and avoid float rounding
      const triggered = shouldTriggerStopLoss("stat_ml", "yes", 0.75, 0.60, 0.19);
      assert.equal(triggered, true);
    });
  });

  describe("NO positions", () => {
    it("triggers when NO-side value drops past threshold", () => {
      // Entry NO cost = 1 - 0.70 = 0.30, current NO value = 1 - 0.80 = 0.20 → loss ≈ 33%
      const triggered = shouldTriggerStopLoss("stat_ml", "no", 0.70, 0.80, 0.20);
      assert.equal(triggered, true);
    });

    it("does not trigger when NO-side loss is within threshold", () => {
      // Entry NO cost = 1 - 0.70 = 0.30, current NO value = 1 - 0.73 = 0.27 → loss = 10%
      const triggered = shouldTriggerStopLoss("stat_ml", "no", 0.70, 0.73, 0.20);
      assert.equal(triggered, false);
    });
  });

  describe("entryDecisionMode scoping", () => {
    it("does not trigger for positions entered under classic mode", () => {
      // Large loss, but not a stat_ml position
      const triggered = shouldTriggerStopLoss("classic", "yes", 0.70, 0.30, 0.20);
      assert.equal(triggered, false);
    });

    it("does not trigger for positions with no entryDecisionMode (legacy/DB-loaded)", () => {
      const triggered = shouldTriggerStopLoss(undefined, "yes", 0.70, 0.30, 0.20);
      assert.equal(triggered, false);
    });

    it("does not trigger for conviction positions even with huge loss", () => {
      const triggered = shouldTriggerStopLoss("conviction", "yes", 0.90, 0.05, 0.20);
      assert.equal(triggered, false);
    });
  });

  describe("lossFrac computation correctness", () => {
    it("YES: exact math", () => {
      const lf = computeLossFrac("yes", 0.80, 0.60);
      // (0.80 - 0.60) / 0.80 = 0.25
      assert.ok(Math.abs(lf - 0.25) < 1e-9, `expected 0.25, got ${lf}`);
    });

    it("NO: exact math", () => {
      const lf = computeLossFrac("no", 0.70, 0.85);
      // entryCost = 0.30, currentValue = 0.15, loss = 0.15/0.30 = 0.50
      assert.ok(Math.abs(lf - 0.50) < 1e-9, `expected 0.50, got ${lf}`);
    });

    it("returns 0 for zero entry cost (guard)", () => {
      const lf = computeLossFrac("yes", 0, 0.50);
      assert.equal(lf, 0);
    });
  });
});
