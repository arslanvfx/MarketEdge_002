import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backtestModeApproval } from "./kalshi-bot-backtest-core.ts";

// ---------------------------------------------------------------------------
// classic — always approves
// ---------------------------------------------------------------------------
describe("backtestModeApproval: classic", () => {
  it("approves when all signals agree", () => {
    assert.equal(backtestModeApproval("classic", true, true, true, true), true);
  });
  it("approves when signals disagree", () => {
    assert.equal(backtestModeApproval("classic", true, false, false, true), true);
  });
  it("approves when no signals at all", () => {
    assert.equal(backtestModeApproval("classic", true, null, null, null), true);
  });
});

// ---------------------------------------------------------------------------
// ml_gate — simplified three-tier formula (mirrors computeMLGateDecision):
//   all three signals required; ML leads direction; Claude and Stat are
//   confidence modifiers only (no hard veto).
// ---------------------------------------------------------------------------
describe("backtestModeApproval: ml_gate", () => {
  // Gate 1: all three signals required
  it("missing ML → rejected (bot would still be waiting)", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, true, null), false);
  });
  it("missing Claude → rejected", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, null, true), false);
  });
  it("missing Stat → rejected", () => {
    assert.equal(backtestModeApproval("ml_gate", true, null, true, true), false);
  });
  it("no signals at all → rejected", () => {
    assert.equal(backtestModeApproval("ml_gate", true, null, null, null), false);
  });

  // Direction: ML leads
  it("all three agree with bet direction → approved", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, true, true), true);
  });
  it("ML agrees with bet direction, Claude dissents → approved (Claude is modifier only)", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, false, true), true);
  });
  it("ML agrees with bet direction, Stat dissents → approved (Stat is modifier only)", () => {
    assert.equal(backtestModeApproval("ml_gate", true, false, true, true), true);
  });

  // Direction: ML opposes bet → always rejected regardless of confidences
  it("ML opposes bet direction (higher conf) → rejected (ML sets direction)", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, true, false, 55, 70, 80), false);
  });
  it("ML opposes bet direction (lower conf) → rejected (ML sets direction)", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, true, false, 55, 70, 60), false);
  });
  it("ML opposes bet direction (equal conf) → rejected (ML sets direction)", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, true, false, 55, 70, 70), false);
  });
  it("ML opposes bet direction, no confidences recorded → rejected (ML sets direction)", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, true, false), false);
  });

  // Composite gate — only simulated when minConfidence provided AND mlConf known
  it("composite below provided minConfidence → rejected", () => {
    // ml 60 + claude agrees +6 + stat dissents -4 = 62 < 65
    assert.equal(backtestModeApproval("ml_gate", true, false, true, true, 55, 58, 60, 65), false);
  });
  it("composite at provided minConfidence → approved (inclusive)", () => {
    // ml 60 + claude agrees +6 + stat agrees +4 = 70 >= 65
    assert.equal(backtestModeApproval("ml_gate", true, true, true, true, 55, 53, 60, 65), true);
  });
  it("minConfidence provided but mlConf missing (old row) → composite gate skipped", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, true, true, null, null, null, 65), true);
  });

  // BET_NO direction
  it("NO bet: all three NO → approved", () => {
    assert.equal(backtestModeApproval("ml_gate", false, false, false, false), true);
  });
  it("NO bet: ML says YES → rejected (direction mismatch)", () => {
    assert.equal(backtestModeApproval("ml_gate", false, false, false, true, 55, 60, 75), false);
  });
});

// ---------------------------------------------------------------------------
// consensus — majority of available signals must agree; tie = SKIP
// ---------------------------------------------------------------------------
describe("backtestModeApproval: consensus", () => {
  // fallback to classic when <2 signals
  it("0 signals → fall back to classic (approved)", () => {
    assert.equal(backtestModeApproval("consensus", true, null, null, null), true);
  });
  it("1 signal → fall back to classic (approved)", () => {
    assert.equal(backtestModeApproval("consensus", true, true, null, null), true);
  });

  // 2/3 agreement
  it("stat+claude agree YES, ML=NO → majority YES (2/3) → approved for YES bet", () => {
    assert.equal(backtestModeApproval("consensus", true, true, true, false), true);
  });
  it("stat+ML agree YES, claude=NO → 2/3 YES → approved for YES bet", () => {
    assert.equal(backtestModeApproval("consensus", true, true, false, true), true);
  });
  it("2/3 agree NO, bet=YES → majority NO, not approved", () => {
    assert.equal(backtestModeApproval("consensus", true, false, false, true), false);
  });
  it("3/3 agree YES → approved for YES bet", () => {
    assert.equal(backtestModeApproval("consensus", true, true, true, true), true);
  });
  it("3/3 agree NO → not approved for YES bet", () => {
    assert.equal(backtestModeApproval("consensus", true, false, false, false), false);
  });

  // tie
  it("2 signals in a 1-1 tie → SKIP → not approved", () => {
    assert.equal(backtestModeApproval("consensus", true, true, false, null), false);
  });

  // 2 available signals, both agree
  it("stat+claude both YES, ML null → 2 available, 2/2 agree → approved", () => {
    assert.equal(backtestModeApproval("consensus", true, true, true, null), true);
  });
  it("stat+claude both NO, ML null, bet=NO → approved", () => {
    assert.equal(backtestModeApproval("consensus", false, false, false, null), true);
  });
  it("stat=YES, claude=NO, ML null → 1-1 tie → SKIP", () => {
    assert.equal(backtestModeApproval("consensus", true, true, false, null), false);
  });
});

// ---------------------------------------------------------------------------
// unanimous — all 3 signals must be available and agree
// ---------------------------------------------------------------------------
describe("backtestModeApproval: unanimous", () => {
  // missing signals → always SKIP
  it("stat missing → not approved", () => {
    assert.equal(backtestModeApproval("unanimous", true, null, true, true), false);
  });
  it("claude missing → not approved", () => {
    assert.equal(backtestModeApproval("unanimous", true, true, null, true), false);
  });
  it("ml missing → not approved", () => {
    assert.equal(backtestModeApproval("unanimous", true, true, true, null), false);
  });
  it("all signals missing → not approved", () => {
    assert.equal(backtestModeApproval("unanimous", true, null, null, null), false);
  });

  // disagreement → SKIP
  it("stat disagrees (stat=NO, claude+ml=YES) → not approved", () => {
    assert.equal(backtestModeApproval("unanimous", true, false, true, true), false);
  });
  it("claude disagrees (claude=NO, stat+ml=YES) → not approved", () => {
    assert.equal(backtestModeApproval("unanimous", true, true, false, true), false);
  });
  it("ml disagrees (ml=NO, stat+claude=YES) → not approved", () => {
    assert.equal(backtestModeApproval("unanimous", true, true, true, false), false);
  });
  it("all disagree with bet direction (all NO, bet=YES) → not approved", () => {
    assert.equal(backtestModeApproval("unanimous", true, false, false, false), false);
  });

  // unanimous agreement
  it("all 3 agree YES, bet=YES → approved", () => {
    assert.equal(backtestModeApproval("unanimous", true, true, true, true), true);
  });
  it("all 3 agree NO, bet=NO → approved", () => {
    assert.equal(backtestModeApproval("unanimous", false, false, false, false), true);
  });
  it("all 3 agree YES, bet=NO → not approved (wrong direction)", () => {
    assert.equal(backtestModeApproval("unanimous", false, true, true, true), false);
  });
  it("all 3 agree NO, bet=YES → not approved (wrong direction)", () => {
    assert.equal(backtestModeApproval("unanimous", true, false, false, false), false);
  });
});
