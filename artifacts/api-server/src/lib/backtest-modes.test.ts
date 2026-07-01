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
// ml_gate — core pair (PATH B/C) must approve direction, then ML can veto
// ---------------------------------------------------------------------------
describe("backtestModeApproval: ml_gate", () => {
  // PATH B: claude primary
  it("PATH B: claude only, agrees → approved (no ML veto)", () => {
    assert.equal(backtestModeApproval("ml_gate", true, null, true, null), true);
  });
  it("PATH B: claude+stat both agree → approved", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, true, null), true);
  });
  it("PATH B: claude+stat disagree → SKIP (stat is tiebreaker, core pair fails)", () => {
    // claude=YES, stat=NO → no tiebreaker without ML → core pair SKIPs
    assert.equal(backtestModeApproval("ml_gate", true, false, true, null), false);
  });
  it("PATH B: claude=YES (agrees), stat=NO (disagrees) → SKIP", () => {
    assert.equal(backtestModeApproval("ml_gate", true, false, true, true), false);
  });

  // PATH C: stat primary (no claude)
  it("PATH C: stat only agrees → approved", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, null, null), true);
  });
  it("PATH C: stat only disagrees with bet direction → rejected", () => {
    assert.equal(backtestModeApproval("ml_gate", true, false, null, null), false);
  });

  // No core signals → SKIP
  it("no core signals → SKIP", () => {
    assert.equal(backtestModeApproval("ml_gate", true, null, null, true), false);
  });

  // ML veto
  it("core agrees, ML available and agrees → approved", () => {
    assert.equal(backtestModeApproval("ml_gate", true, true, true, true), true);
  });
  it("core agrees, ML available and disagrees → VETO (rejected)", () => {
    // claude=YES (agrees), stat=null, ML=NO (disagrees) → veto
    assert.equal(backtestModeApproval("ml_gate", true, null, true, false), false);
  });
  it("core agrees, ML not available → no veto (approved)", () => {
    assert.equal(backtestModeApproval("ml_gate", true, null, true, null), true);
  });

  // Classic PATH A bets (ML-primary): core pair may point opposite or be absent
  it("PATH A scenario: only ML available, no core signals → SKIP under ml_gate", () => {
    // classic PATH A could place YES via ML alone; ml_gate would SKIP
    assert.equal(backtestModeApproval("ml_gate", true, null, null, true), false);
  });
  it("PATH A scenario: ML=YES, stat=NO, claude=null → core=stat(NO) opposes bet(YES) → rejected", () => {
    // classic would bet YES via PATH A; ml_gate PATH C gives NO → rejected
    assert.equal(backtestModeApproval("ml_gate", true, false, null, true), false);
  });

  // BET_NO direction
  it("NO bet: claude=NO (agrees), stat=null, ML=null → approved", () => {
    assert.equal(backtestModeApproval("ml_gate", false, null, false, null), true);
  });
  it("NO bet: claude=NO (agrees), ML=YES (disagrees) → VETO", () => {
    assert.equal(backtestModeApproval("ml_gate", false, null, false, true), false);
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
