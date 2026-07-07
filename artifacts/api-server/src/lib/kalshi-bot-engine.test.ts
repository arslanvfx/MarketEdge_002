// Unit tests for the ML-primary decision core.
//
// Tests the pure `computeCorePairDecision` function, which is the extracted
// decision logic with no I/O dependencies. This avoids needing to mock the
// crypto module.
//
// Signal priority order (highest → lowest):
//   PATH A — ML primary (mlConfidence ≥ ML_PRIMARY_MIN_CONFIDENCE)
//   PATH B — Claude primary (ML not ready, Claude available)
//   PATH C — Stat primary  (no ML, no Claude)
//
// Final gates: EV gate, minConfidence gate.
//
// NOTE: The "Claude-pending" guard (training coin + claudeAbove=null + <90 s elapsed →
// SKIP "Claude opening call pending") lives in `makeBotDecision` in
// kalshi-bot-engine.ts — the I/O wrapper layer — rather than in this pure
// function.  It is not tested here because testing it requires mocking the
// in-memory stores from crypto.ts.
//
// Run with:  pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeCorePairDecision,
  checkMinReturnGate,
  DEFAULT_BOT_CONFIG,
  BASE_CONFIDENCE_FULL_PAIR,
  BASE_CONFIDENCE_HALF_PAIR,
  CONFIDENCE_BOOST_PER_SIGNAL,
  ML_PRIMARY_MIN_CONFIDENCE,
  ML_SIGNAL_BOOST,
  DISSENT_PENALTY,
  isInQuietHours,
  applyBetOutcome,
  tickCircuitBreakerWindow,
  type CorePairInputs,
  type CircuitBreakerState,
} from "./kalshi-bot-engine-core.ts";

import {
  applyClaudeLiveOverride,
  applyStatPredCacheOverride,
  shouldDeferForLiveSignal,
} from "./kalshi-bot-engine-core.ts";

const DEFAULT_MIN_CONFIDENCE = 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inp(overrides: Partial<CorePairInputs> = {}): CorePairInputs {
  return {
    statAbove:         null,
    claudeAbove:       null,
    mlAbove:           null,
    wmDriftAbove:      null,
    wmRec:             null,
    wmReady:           false,
    yesPrice:          0.50,
    signalAccuracyPct: null,
    minutesElapsed:    2,
    statConfidence:    null,
    claudeConfidence:  null,
    mlConfidence:      null,
    kalshiTicker:      "KXBTC-123",
    minConfidence:     DEFAULT_MIN_CONFIDENCE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PATH A — ML primary
// ---------------------------------------------------------------------------

test("PATH A: ML ready, both Stat+Claude null → SKIP (ML cannot bet solo)", () => {
  // ML requires at least one confirming signal. With no validators the new veto
  // fires (mlHasConfirmation=false → mlLeadReady=false) before the old ML solo
  // guard is even reached — falls through to "No signals available".
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 68 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /No signals available/);
});

test("PATH A: ML ready, both Stat+Claude null → SKIP regardless of direction", () => {
  // New veto fires before the ML solo guard: no confirmation → mlLeadReady=false.
  // Falls through PATH B (no claude) → PATH C (no stat) → "No signals available".
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 65 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /No signals available/);
});

test("PATH A: ML base confidence = mlConfidence when Stat agrees (no Claude)", () => {
  // When ML leads and Stat agrees, ML's own confidence is the base; the Stat
  // agreement then adds +ML_SIGNAL_BOOST on top.  Testing the raw mlConfidence
  // baseline requires the gate to pass — provide Stat so ML isn't solo.
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: ML_PRIMARY_MIN_CONFIDENCE, statAbove: true }));
  assert.equal(r.confidence, ML_PRIMARY_MIN_CONFIDENCE + ML_SIGNAL_BOOST); // Stat agrees → +boost
});

test("PATH A: Claude agrees with ML → +ML_SIGNAL_BOOST", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: ML_PRIMARY_MIN_CONFIDENCE, claudeAbove: true }));
  assert.equal(r.confidence, ML_PRIMARY_MIN_CONFIDENCE + ML_SIGNAL_BOOST);
});

test("PATH A: Claude disagrees with ML → alignment gate → SKIP", () => {
  // ML at primary threshold (≥56% so meaningful dissent) → gate fires when claude≠ml
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: ML_PRIMARY_MIN_CONFIDENCE, claudeAbove: false }));
  assert.equal(r.action, "SKIP");
});

test("PATH A: Stat agrees with ML → +ML_SIGNAL_BOOST", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: ML_PRIMARY_MIN_CONFIDENCE, statAbove: true }));
  assert.equal(r.confidence, ML_PRIMARY_MIN_CONFIDENCE + ML_SIGNAL_BOOST);
});

test("PATH A: Stat disagrees with ML → −DISSENT_PENALTY (Claude confirms ML so veto doesn't fire)", () => {
  // Stat opposes ML but Claude agrees → mlHasConfirmation=true → no veto → ML leads.
  // Stat dissent still subtracts DISSENT_PENALTY from confidence.
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: ML_PRIMARY_MIN_CONFIDENCE, statAbove: false, claudeAbove: true }));
  assert.equal(r.confidence, ML_PRIMARY_MIN_CONFIDENCE + ML_SIGNAL_BOOST - DISSENT_PENALTY); // Claude agrees (+6), Stat disagrees (−6)
});

test("PATH A: WM agrees with ML → +ML_SIGNAL_BOOST (Stat also present as validator)", () => {
  // Stat must be present so ML isn't solo. WM then adds its own boost on top.
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: ML_PRIMARY_MIN_CONFIDENCE, statAbove: true, wmDriftAbove: true, wmRec: "bet", wmReady: true }));
  assert.equal(r.confidence, ML_PRIMARY_MIN_CONFIDENCE + ML_SIGNAL_BOOST + ML_SIGNAL_BOOST); // Stat+WM each add boost
});

test("PATH A: all three validators agree with ML → +3×ML_SIGNAL_BOOST", () => {
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: ML_PRIMARY_MIN_CONFIDENCE,
    claudeAbove: true, statAbove: true,
    wmDriftAbove: true, wmRec: "bet", wmReady: true,
  }));
  assert.equal(r.confidence, ML_PRIMARY_MIN_CONFIDENCE + 3 * ML_SIGNAL_BOOST);
});

test("PATH A veto: Stat+Claude both oppose ML → alignment gate fires first → SKIP", () => {
  // ML=YES(65%); Claude=NO → alignment gate fires before veto check → SKIP.
  // (Previously fell to PATH B BET_NO at 59; now blocked outright.)
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 65, claudeAbove: false, statAbove: false, minConfidence: 50 }));
  assert.equal(r.action, "SKIP");
});

test("PATH A: ML confidence below threshold → SKIP", () => {
  const belowThreshold = ML_PRIMARY_MIN_CONFIDENCE - 1;
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: belowThreshold }));
  assert.equal(r.action, "SKIP");
});

test("PATH A: reasoning string contains 'ML primary' (with Stat validator)", () => {
  // Provide Stat so the ML-solo gate doesn't block before we reach the reasoning.
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70, statAbove: true }));
  assert.match(r.reasoning, /ML primary/);
});

test("PATH A veto: Stat+Claude both YES, ML=NO → alignment gate fires first → SKIP", () => {
  // ML=NO(65%); Claude=YES → alignment gate fires before veto check → SKIP.
  // This is the exact loss pattern: Claude+Stat say YES, ML says NO → now blocked.
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 65, claudeAbove: true, statAbove: true, minConfidence: 50 }));
  assert.equal(r.action, "SKIP");
});

test("PATH A veto: ML=ABOVE, stat=BELOW, claude=null → no confirming signal → veto → PATH C → BET_NO", () => {
  // The DOGE bug: ML says ABOVE (even at sufficient confidence) but stat says BELOW
  // and Claude hasn't responded yet.  ML must not be allowed to solo-bet YES when
  // its only validator actively disagrees.  Falls through to PATH C → BET_NO.
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 70, // well above threshold
    statAbove: false,                // stat says BELOW
    claudeAbove: null,               // claude not yet available
    minConfidence: 50,
  }));
  assert.equal(r.action, "BET_NO"); // PATH C uses stat=BELOW → BET_NO
});

// ---------------------------------------------------------------------------
// 2-vs-1 override rule: both stat+claude oppose ML, but both are weak (< 60%)
// ---------------------------------------------------------------------------

test("2-vs-1 weak: ML=72%, stat=BELOW 55%, claude=BELOW 55% → ML overrides both weak signals → BET_YES at mlConfidence", () => {
  // Both signals oppose ML but are below STAT_CLAUDE_DOMINANCE_THRESHOLD (60%).
  // ML at 72% (≥ primary threshold 70%) overrides: alignment gate allows through,
  // veto is waived, no dissent penalty → confidence = mlConfidence = 72%.
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 72,
    statAbove: false, statConfidence: 55,
    claudeAbove: false, claudeConfidence: 55,
    minConfidence: 62,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, 72); // no boosts (both oppose), no penalties (both weak)
  assert.match(r.reasoning, /ML primary/);
});

test("2-vs-1 weak: ML=70% (exactly at threshold), stat=BELOW 59%, claude=BELOW 59% → BET_YES", () => {
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: ML_PRIMARY_MIN_CONFIDENCE,
    statAbove: false, statConfidence: 59,
    claudeAbove: false, claudeConfidence: 59,
    minConfidence: 62,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, ML_PRIMARY_MIN_CONFIDENCE);
});

test("2-vs-1 strong stat: ML=72%, stat=BELOW 62%, claude=BELOW 55% → stat is strong → SKIP", () => {
  // Stat is at 62% (≥ 60% threshold) — consensus beats ML regardless.
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 72,
    statAbove: false, statConfidence: 62,
    claudeAbove: false, claudeConfidence: 55,
    minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
});

test("2-vs-1 strong claude: ML=72%, stat=BELOW 55%, claude=BELOW 62% → claude is strong → SKIP", () => {
  // Claude at 62% (≥ 60%) — either signal being strong is enough to block ML.
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 72,
    statAbove: false, statConfidence: 55,
    claudeAbove: false, claudeConfidence: 62,
    minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
});

test("2-vs-1 null confidence: ML=72%, stat=BELOW (conf null), claude=BELOW (conf null) → null treated as strong → SKIP", () => {
  // Unknown confidence is treated conservatively as strong (≥ threshold).
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 72,
    statAbove: false, statConfidence: null,
    claudeAbove: false, claudeConfidence: null,
    minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
});

test("2-vs-1 ML not strong enough: ML=64% (below primary 65%), stat=BELOW 55%, claude=BELOW 55% → ML cannot override → SKIP", () => {
  // Both signals are weak, but ML itself is below ML_PRIMARY_MIN_CONFIDENCE (65%) — cannot lead.
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 64,
    statAbove: false, statConfidence: 55,
    claudeAbove: false, claudeConfidence: 55,
    minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
});

test("PATH A: ML=ABOVE, stat=ABOVE, claude=null → stat confirms → ML leads", () => {
  // When stat agrees with ML, the veto must NOT fire even with claude absent.
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 70,
    statAbove: true,
    claudeAbove: null,
  }));
  assert.equal(r.action, "BET_YES");
  assert.match(r.reasoning, /ML primary/);
});

test("PATH A veto: ML=ABOVE, stat=null, claude=null → no confirmation → veto (ML solo guard also fires)", () => {
  // Belt-and-suspenders: no validators at all → veto and ML solo guard both block.
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: 70,
    statAbove: null,
    claudeAbove: null,
  }));
  assert.equal(r.action, "SKIP");
});

// ---------------------------------------------------------------------------
// PATH B — Claude primary (ML not ready)
// ---------------------------------------------------------------------------

test("PATH B: Claude=YES, Stat agrees → BET_YES", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: true }));
  assert.equal(r.action, "BET_YES");
});

test("PATH B: Claude=NO, Stat agrees → BET_NO", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: false, statAbove: false }));
  assert.equal(r.action, "BET_NO");
});

test("PATH B: Claude+Stat agree → BASE_CONFIDENCE_FULL_PAIR", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: true }));
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

test("PATH B: Claude alone (Stat null) → BASE_CONFIDENCE_HALF_PAIR", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: false, statAbove: null }));
  assert.equal(r.confidence, BASE_CONFIDENCE_HALF_PAIR);
});

test("PATH B: Claude and Stat disagree, ML null → SKIP (no ML to arbitrate)", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: false, mlAbove: null }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /no ML to arbitrate/);
});

test("PATH B: Claude and Stat disagree, ML sides with Claude → BET (2-of-3 agreement)", () => {
  // Claude=YES, Stat=NO, ML=YES → ML+Claude (2) vs Stat (1) → proceed BET_YES
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: false, mlAbove: true, mlConfidence: 55 }));
  assert.equal(r.action, "BET_YES");
  // Confidence at half-pair level since Stat dissents
  assert.equal(r.confidence, BASE_CONFIDENCE_HALF_PAIR);
});

test("PATH B: Claude=NO, Stat=YES, ML=NO → ML sides with Claude → BET_NO", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: false, statAbove: true, mlAbove: false, mlConfidence: 55 }));
  assert.equal(r.action, "BET_NO");
  assert.equal(r.confidence, BASE_CONFIDENCE_HALF_PAIR);
});

test("PATH B: WM agrees with Claude → +CONFIDENCE_BOOST_PER_SIGNAL", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: true, wmDriftAbove: true, wmRec: "bet", wmReady: true }));
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR + CONFIDENCE_BOOST_PER_SIGNAL);
});

test("PATH B: reasoning string contains 'Claude primary'", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: true }));
  assert.match(r.reasoning, /Claude primary/);
});

// ML present but below confidence threshold → falls through to Claude path;
// ML actively disagrees → dissent penalty applies in PATH B.
test("PATH B: ML below threshold + Claude available + ML disagrees → alignment gate fires → SKIP", () => {
  const belowThreshold = ML_PRIMARY_MIN_CONFIDENCE - 1;
  // ML=NO (even below threshold) + Claude=YES → alignment gate fires on directional mismatch → SKIP.
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: belowThreshold, claudeAbove: true, statAbove: true, minConfidence: 50 }));
  assert.equal(r.action, "SKIP");
});

// ML below ML_PRIMARY_MIN_CONFIDENCE but ≥ ML_ALIGNMENT_GATE_MIN_CONFIDENCE → still meaningful →
// agreement boost applies (+ML_SIGNAL_BOOST), no penalty.
test("PATH B: ML below primary threshold but meaningful (≥56%) + Claude available + ML agrees → +ML_SIGNAL_BOOST", () => {
  const belowPrimary = ML_PRIMARY_MIN_CONFIDENCE - 1; // 69 — below PATH A gate but still meaningful
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: belowPrimary, claudeAbove: true, statAbove: true }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR + ML_SIGNAL_BOOST); // 65+6=71
});

// ── PATH B ML agreement boost — direction-symmetric tests ────────────────────
// The fix: ML agreement gives +ML_SIGNAL_BOOST in PATH B, just as in PATH A.
// Unanimous YES and unanimous NO must score identically so the confidence floor
// does not inadvertently filter one direction more than the other.

test("PATH B symmetry: unanimous NO (claude=false, stat=false, ml=false at 60%) → confidence = 71", () => {
  const r = computeCorePairDecision(inp({
    claudeAbove: false, statAbove: false,
    mlAbove: false, mlConfidence: 60,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_NO");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR + ML_SIGNAL_BOOST); // 65+6=71
  assert.match(r.reasoning, /ML:\+6/);
});

test("PATH B symmetry: unanimous YES (claude=true, stat=true, ml=true at 60%) → confidence = 71", () => {
  const r = computeCorePairDecision(inp({
    claudeAbove: true, statAbove: true,
    mlAbove: true, mlConfidence: 60,
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR + ML_SIGNAL_BOOST); // 65+6=71
  assert.match(r.reasoning, /ML:\+6/);
});

test("PATH B symmetry: NO with ml noise (<56%) → no boost → confidence stays at BASE_CONFIDENCE_FULL_PAIR", () => {
  const r = computeCorePairDecision(inp({
    claudeAbove: false, statAbove: false,
    mlAbove: false, mlConfidence: 52, // below ML_ALIGNMENT_GATE_MIN_CONFIDENCE (56)
    minConfidence: 60,
  }));
  assert.equal(r.action, "BET_NO");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR); // 65, no boost
});

test("PATH B symmetry: unanimous NO clears auto-tuned floor of 70 (65+6=71 > 70)", () => {
  // This is the production scenario: auto-tune raised minConfidence to 70.
  // Before fix, unanimous NO scored 65 → SKIP. After fix, 71 → BET_NO.
  const r = computeCorePairDecision(inp({
    claudeAbove: false, statAbove: false,
    mlAbove: false, mlConfidence: 60,
    minConfidence: 70,
  }));
  assert.equal(r.action, "BET_NO");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR + ML_SIGNAL_BOOST); // 71 > 70 → passes
});

test("PATH B: ML confidence null but mlAbove present and disagrees → gate does NOT fire (no conf) → no dissent penalty → BET_NO at full-pair confidence", () => {
  // When mlConfidence is null the alignment gate treats it as noise and does NOT block.
  // The dissent penalty is also skipped (ML is noise for all purposes when conf is absent).
  // PATH B proceeds: claude=false primary → BET_NO at BASE_CONFIDENCE_FULL_PAIR.
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: null, claudeAbove: false, statAbove: false, minConfidence: 50 }));
  assert.equal(r.action, "BET_NO");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

test("PATH B: ML at meaningful confidence (≥56%) and disagrees with Claude → alignment gate fires → SKIP", () => {
  // Even below ML_PRIMARY_MIN_CONFIDENCE, if ML confidence >= ML_ALIGNMENT_GATE_MIN_CONFIDENCE (56),
  // the alignment gate fires when claude and ml disagree — their conflict makes the bet unreliable.
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 60, claudeAbove: false, statAbove: false, minConfidence: 50 }));
  assert.equal(r.action, "SKIP");
});

// mlAbove null → no ML direction at all → no dissent penalty
test("PATH B: ML absent (mlAbove null) → no dissent penalty", () => {
  const r = computeCorePairDecision(inp({ mlAbove: null, mlConfidence: null, claudeAbove: true, statAbove: true }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

// ---------------------------------------------------------------------------
// New rule: weak ML dissent (50–55%) treated as noise — stat+claude win
// ---------------------------------------------------------------------------

test("Weak ML dissent (52%): stat+claude both agree, ML barely-above-random → gate does not fire → no penalty → BET_YES at full-pair confidence", () => {
  // ML at 52% is essentially a coin-flip. Below ML_ALIGNMENT_GATE_MIN_CONFIDENCE (56%)
  // ML is treated as noise: no alignment gate AND no dissent penalty.
  // Stat+claude both say YES → PATH B full pair (65) → BET_YES at 65.
  const r = computeCorePairDecision(inp({
    mlAbove: false, mlConfidence: 52,  // ML says NO at only 52% — noise
    claudeAbove: true, statAbove: true, // stat+claude both strongly say YES
    minConfidence: 62,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

test("Weak ML dissent (55%): at boundary — gate still does not fire (55 < 56) → stat+claude win", () => {
  const r = computeCorePairDecision(inp({
    mlAbove: false, mlConfidence: 55,
    claudeAbove: true, statAbove: true,
    minConfidence: 50,
  }));
  assert.equal(r.action, "BET_YES");
});

test("ML dissent at gate boundary (56%): gate fires → SKIP even when stat+claude agree", () => {
  // At exactly ML_ALIGNMENT_GATE_MIN_CONFIDENCE (56%), the dissent is considered meaningful.
  const r = computeCorePairDecision(inp({
    mlAbove: false, mlConfidence: 56,
    claudeAbove: true, statAbove: true,
    minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
});

// ---------------------------------------------------------------------------
// PATH C — Stat primary (no ML, no Claude)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dissent penalty — real-world scenario tests (23:15 window pattern)
// ---------------------------------------------------------------------------

// DOGE/BTC 23:15: stat=true, claude=false, ml=true → alignment gate fires (Claude≠ML) → SKIP
test("DISSENT: PATH A — ML+Stat agree but Claude actively opposes → alignment gate → SKIP", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 66, statAbove: true, claudeAbove: false }));
  assert.equal(r.action, "SKIP");
});

test("DISSENT: PATH A — ML+Claude agree but Stat actively opposes → net zero delta", () => {
  // Claude agrees (+ML_SIGNAL_BOOST), Stat disagrees (−DISSENT_PENALTY) → net 0 → confidence stays at base
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: ML_PRIMARY_MIN_CONFIDENCE, claudeAbove: true, statAbove: false }));
  assert.equal(r.confidence, ML_PRIMARY_MIN_CONFIDENCE);
});

test("DISSENT: PATH A — Claude opposes ML (Stat null) → alignment gate → SKIP", () => {
  // Claude=NO, ML=YES (even with Stat null, gate fires on Claude≠ML directional mismatch)
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 66, claudeAbove: false, statAbove: null }));
  assert.equal(r.action, "SKIP");
});

// HYPE 23:15: stat=true, claude=true, ml=false → PATH A veto fires (both oppose ML).
// Falls to PATH B. Claude leads YES. ML opposes → DISSENT_PENALTY applied.
// Result: BASE_CONFIDENCE_FULL_PAIR(65) − DISSENT_PENALTY(6) = 59.
// With DEFAULT_MIN_CONFIDENCE=60 in tests, 59 < 60 → SKIP (correctly blocked).
// In production with minConfidence=65+4pp doubt penalty=69, also SKIP.
test("DISSENT: PATH B — HYPE 23:15 pattern (stat+claude=YES, ml=NO) → alignment gate → SKIP", () => {
  // Claude=YES, ML=NO → alignment gate fires regardless of threshold
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 65, claudeAbove: true, statAbove: true }));
  assert.equal(r.action, "SKIP");
});

// Same pattern with a lower minConfidence: alignment gate still blocks when Claude≠ML
// (the gate fires before the threshold is checked — there is no edge to price in)
test("DISSENT: PATH B — ML opposes Claude → alignment gate blocks regardless of threshold", () => {
  const r = computeCorePairDecision(inp({
    mlAbove: false, mlConfidence: 65, claudeAbove: true, statAbove: true, minConfidence: 50,
  }));
  assert.equal(r.action, "SKIP");
});

// Sanity: when all three agree, no penalty, only boosts
test("DISSENT: all three agree → boosts only, no penalty", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: ML_PRIMARY_MIN_CONFIDENCE, claudeAbove: true, statAbove: true }));
  assert.equal(r.confidence, ML_PRIMARY_MIN_CONFIDENCE + 2 * ML_SIGNAL_BOOST);
});

test("PATH C: Stat=YES, no ML, no Claude → BET_YES", () => {
  const r = computeCorePairDecision(inp({ statAbove: true }));
  assert.equal(r.action, "BET_YES");
});

test("PATH C: Stat=NO, no ML, no Claude → BET_NO", () => {
  const r = computeCorePairDecision(inp({ statAbove: false }));
  assert.equal(r.action, "BET_NO");
});

test("PATH C: Stat primary base = BASE_CONFIDENCE_HALF_PAIR when statConfidence null", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, statConfidence: null }));
  assert.equal(r.confidence, BASE_CONFIDENCE_HALF_PAIR);
});

test("PATH C: Stat primary uses statConfidence when available", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, statConfidence: 63 }));
  assert.equal(r.confidence, 63);
});

test("PATH C: WM agrees with Stat → +CONFIDENCE_BOOST_PER_SIGNAL", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, wmDriftAbove: true, wmRec: "bet", wmReady: true }));
  assert.equal(r.confidence, BASE_CONFIDENCE_HALF_PAIR + CONFIDENCE_BOOST_PER_SIGNAL);
});

test("PATH C: reasoning string contains 'Stat primary'", () => {
  const r = computeCorePairDecision(inp({ statAbove: true }));
  assert.match(r.reasoning, /Stat primary/);
});

// ---------------------------------------------------------------------------
// No signals
// ---------------------------------------------------------------------------

test("No signals at all (ML null, Claude null, Stat null) → SKIP", () => {
  const r = computeCorePairDecision(inp());
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /No signals/);
});

test("ML+WM agree but mlConfidence null → SKIP (ML not ready, no Claude/Stat)", () => {
  const r = computeCorePairDecision(inp({ mlAbove: true, wmDriftAbove: true }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /No signals/);
});

// ---------------------------------------------------------------------------
// No Kalshi ticker
// ---------------------------------------------------------------------------

test("No Kalshi ticker → SKIP", () => {
  const r = computeCorePairDecision(inp({ statAbove: true, claudeAbove: true, kalshiTicker: null }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /No active Kalshi market/);
});

// ---------------------------------------------------------------------------
// EV gate — direction-aware (YES and NO on equal footing)
// Gate runs AFTER direction is decided; each side uses its own payoff formula:
//   BET_YES: EV = acc*(1−p)/p − (1−acc)
//   BET_NO:  EV = acc*p/(1−p) − (1−acc)
// ---------------------------------------------------------------------------

test("Negative EV fires when signalAccuracyPct is low (40% at 50¢ YES)", () => {
  // BET_YES: EV = 0.40*(0.50/0.50) − 0.60 = −0.20 < −0.05
  // claudeAbove provided so ML-solo gate doesn't fire before EV gate.
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70, claudeAbove: true, yesPrice: 0.50, signalAccuracyPct: 40 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Negative EV/);
});

test("Negative EV fires at 45% accuracy at 50¢ YES (borderline)", () => {
  // BET_YES: EV = 0.45*1 − 0.55 = −0.10 < −0.05
  // claudeAbove provided so ML-solo gate doesn't fire before EV gate.
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70, claudeAbove: true, yesPrice: 0.50, signalAccuracyPct: 45 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Negative EV/);
});

test("EV gate passes when signalAccuracyPct is 60% at 50¢ YES", () => {
  // BET_YES: EV = 0.60*1 − 0.40 = +0.20 ≥ −0.05 → proceeds
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70, claudeAbove: true, yesPrice: 0.50, signalAccuracyPct: 60 }));
  assert.equal(r.action, "BET_YES");
});

test("EV gate skipped when signalAccuracyPct is null (no history yet)", () => {
  // null acc → dirEV=null → gate doesn't fire
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70, claudeAbove: true, signalAccuracyPct: null }));
  assert.equal(r.action, "BET_YES");
});

test("EV gate symmetry: expensive NO (low yes_price) blocked just like bad YES", () => {
  // BET_NO at yes=0.08 (NO costs 0.92): EV = 0.40*(0.08/0.92) − 0.60 = −0.565 < −0.05
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, claudeAbove: false, yesPrice: 0.08, signalAccuracyPct: 40 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Negative EV/);
});

test("EV gate symmetry: cheap NO (high yes_price) passes despite low acc", () => {
  // BET_NO at yes=0.92 (NO costs 0.08): EV = 0.40*(0.92/0.08) − 0.60 = +4.0 ≥ −0.05
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, claudeAbove: false, yesPrice: 0.92, signalAccuracyPct: 40 }));
  assert.equal(r.action, "BET_NO");
});

test("EV gate: 50¢ market is identical for YES and NO at same accuracy", () => {
  // Both directions at 50¢ with 40% acc: EV = 0.40*1 − 0.60 = −0.20 → both block
  const rYes = computeCorePairDecision(inp({ mlAbove: true,  mlConfidence: 70, claudeAbove: true,  yesPrice: 0.50, signalAccuracyPct: 40 }));
  const rNo  = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, claudeAbove: false, yesPrice: 0.50, signalAccuracyPct: 40 }));
  assert.equal(rYes.action, "SKIP");
  assert.equal(rNo.action,  "SKIP");
  // Both should report the same EV magnitude (symmetric market)
  assert.ok(rYes.ev != null && rNo.ev != null && Math.abs(rYes.ev - rNo.ev) < 0.001, "EV symmetric at 50¢");
});

// ---------------------------------------------------------------------------
// Reversing-caution arithmetic (Phase 3 penalty applied externally)
// ---------------------------------------------------------------------------

test("Low-conviction: base 65 - 20 = 45 < minConfidence(60) → Phase 3 skips", () => {
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: true }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
  assert.ok(r.confidence - 20 < DEFAULT_MIN_CONFIDENCE, "penalized confidence falls below gate");
});

test("High-conviction: ML+Claude+Stat+WM all agree → 70+18=88 → 88-20=68 ≥ 60 → Phase 3 allows", () => {
  const r = computeCorePairDecision(inp({
    mlAbove: true, mlConfidence: ML_PRIMARY_MIN_CONFIDENCE,
    claudeAbove: true, statAbove: true,
    wmDriftAbove: true, wmRec: "bet", wmReady: true,
  }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, ML_PRIMARY_MIN_CONFIDENCE + 3 * ML_SIGNAL_BOOST);
  assert.ok(r.confidence - 20 >= DEFAULT_MIN_CONFIDENCE, "penalized confidence still clears gate");
});

// ---------------------------------------------------------------------------
// isInQuietHours — pure UTC gate
// ---------------------------------------------------------------------------

test("isInQuietHours: disabled when start === end", () => {
  for (const h of [0, 8, 12, 18, 23]) {
    assert.equal(isInQuietHours(h, 12, 12), false, `hour ${h} should not be blocked`);
  }
});

test("isInQuietHours: normal range (start < end) blocks hours in range", () => {
  assert.equal(isInQuietHours(12, 12, 18), true);
  assert.equal(isInQuietHours(17, 12, 18), true);
  assert.equal(isInQuietHours(11, 12, 18), false);
  assert.equal(isInQuietHours(18, 12, 18), false);
  assert.equal(isInQuietHours(0,  12, 18), false);
  assert.equal(isInQuietHours(23, 12, 18), false);
});

test("isInQuietHours: midnight-wrap range (start > end) blocks hours in range", () => {
  assert.equal(isInQuietHours(22, 22, 6), true);
  assert.equal(isInQuietHours(23, 22, 6), true);
  assert.equal(isInQuietHours(0,  22, 6), true);
  assert.equal(isInQuietHours(5,  22, 6), true);
  assert.equal(isInQuietHours(6,  22, 6), false);
  assert.equal(isInQuietHours(21, 22, 6), false);
});

// ---------------------------------------------------------------------------
// applyBetOutcome — circuit breaker trigger logic
// ---------------------------------------------------------------------------

const zeroCB: CircuitBreakerState = { consecutiveLosses: 0, circuitBreakerWindowsRemaining: 0 };

test("applyBetOutcome: win resets consecutive losses to 0", () => {
  const s: CircuitBreakerState = { consecutiveLosses: 2, circuitBreakerWindowsRemaining: 0 };
  const next = applyBetOutcome(s, true, 3, 2);
  assert.equal(next.consecutiveLosses, 0);
});

test("applyBetOutcome: win resets circuit-breaker windows remaining to 0", () => {
  const s: CircuitBreakerState = { consecutiveLosses: 2, circuitBreakerWindowsRemaining: 2 };
  const next = applyBetOutcome(s, true, 3, 2);
  assert.equal(next.circuitBreakerWindowsRemaining, 0, "win must cancel active cooldown");
});

test("applyBetOutcome: loss increments consecutive count", () => {
  const next = applyBetOutcome(zeroCB, false, 3, 2);
  assert.equal(next.consecutiveLosses, 1);
  assert.equal(next.circuitBreakerWindowsRemaining, 0);
});

test("applyBetOutcome: triggers circuit breaker at maxConsecutiveLosses", () => {
  let s = zeroCB;
  s = applyBetOutcome(s, false, 3, 2); // 1 loss
  s = applyBetOutcome(s, false, 3, 2); // 2 losses
  assert.equal(s.circuitBreakerWindowsRemaining, 0, "not triggered yet");
  s = applyBetOutcome(s, false, 3, 2); // 3rd loss → trigger
  assert.equal(s.consecutiveLosses, 3);
  assert.equal(s.circuitBreakerWindowsRemaining, 2, "circuit breaker should fire");
});

test("applyBetOutcome: circuit breaker does not re-trigger past max (stays at pauseWindows)", () => {
  const s: CircuitBreakerState = { consecutiveLosses: 3, circuitBreakerWindowsRemaining: 2 };
  const next = applyBetOutcome(s, false, 3, 2);
  assert.equal(next.consecutiveLosses, 4);
  assert.equal(next.circuitBreakerWindowsRemaining, 2);
});

test("applyBetOutcome: pauseWindows=0 means breaker never triggers", () => {
  let s = zeroCB;
  for (let i = 0; i < 10; i++) s = applyBetOutcome(s, false, 3, 0);
  assert.equal(s.circuitBreakerWindowsRemaining, 0);
});

test("applyBetOutcome: maxConsecutiveLosses=0 disables the circuit breaker entirely", () => {
  let s = zeroCB;
  for (let i = 0; i < 10; i++) s = applyBetOutcome(s, false, 0, 2);
  assert.equal(s.circuitBreakerWindowsRemaining, 0, "breaker must not trigger when maxConsecutiveLosses=0");
});

// ---------------------------------------------------------------------------
// tickCircuitBreakerWindow — countdown decrement
// ---------------------------------------------------------------------------

test("tickCircuitBreakerWindow: decrements remaining by 1", () => {
  const s: CircuitBreakerState = { consecutiveLosses: 3, circuitBreakerWindowsRemaining: 2 };
  const next = tickCircuitBreakerWindow(s);
  assert.equal(next.circuitBreakerWindowsRemaining, 1);
});

test("tickCircuitBreakerWindow: clamps at 0 — does not go negative", () => {
  const s: CircuitBreakerState = { consecutiveLosses: 0, circuitBreakerWindowsRemaining: 0 };
  const next = tickCircuitBreakerWindow(s);
  assert.equal(next.circuitBreakerWindowsRemaining, 0);
});

test("tickCircuitBreakerWindow: two ticks from 2 → 0", () => {
  let s: CircuitBreakerState = { consecutiveLosses: 3, circuitBreakerWindowsRemaining: 2 };
  s = tickCircuitBreakerWindow(s);
  s = tickCircuitBreakerWindow(s);
  assert.equal(s.circuitBreakerWindowsRemaining, 0);
});

test("Full circuit-breaker lifecycle: 3 losses → trigger → 2 ticks → re-enable", () => {
  let s = zeroCB;
  s = applyBetOutcome(s, false, 3, 2);
  s = applyBetOutcome(s, false, 3, 2);
  s = applyBetOutcome(s, false, 3, 2); // trigger
  assert.equal(s.circuitBreakerWindowsRemaining, 2, "breaker active");
  s = tickCircuitBreakerWindow(s);
  assert.equal(s.circuitBreakerWindowsRemaining, 1);
  s = tickCircuitBreakerWindow(s);
  assert.equal(s.circuitBreakerWindowsRemaining, 0, "breaker cleared");
});

// ---------------------------------------------------------------------------
// checkMomentumOverride tests
// ---------------------------------------------------------------------------

import { checkMomentumOverride, deriveRegime, buildStreakSnapshot, restoreStreakState, type CoinStreakEntry } from "./kalshi-bot-engine-core.ts";

test("checkMomentumOverride: returns false when insufficient data (fewer than windowCount+1 points)", () => {
  const strikes = [100, 101, 102];
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), false);
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: returns false when no clear trend (mixed moves)", () => {
  const strikes = [100, 102, 101, 103];
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), false);
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: returns false when move is below threshold", () => {
  // All rising but only 0.1% total move — below 0.5% threshold
  const strikes = [100.00, 100.03, 100.07, 100.10]; // ~0.1% total
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: blocks YES bet when price trending down with sufficient move", () => {
  const strikes = [100, 99.8, 99.5, 99.2]; // trending down ~0.8%
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), true);
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: blocks NO bet when price trending up with sufficient move", () => {
  const strikes = [100, 100.2, 100.5, 100.8]; // trending up ~0.8%
  assert.equal(checkMomentumOverride("no", strikes, 0.5, 3), true);
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

test("checkMomentumOverride: uses only the last windowCount+1 points", () => {
  // Older data is down, but recent 4 points are flat → no override
  const strikes = [95, 90, 85, 100, 100.1, 100.2, 100.3];
  assert.equal(checkMomentumOverride("yes", strikes, 0.5, 3), false);
});

// ---------------------------------------------------------------------------
// deriveRegime tests
// ---------------------------------------------------------------------------

test("deriveRegime: returns 'ranging' with fewer than 2 data points", () => {
  assert.equal(deriveRegime([]), "ranging");
  assert.equal(deriveRegime([100]), "ranging");
});

test("deriveRegime: returns 'trending_up' when all strikes increase", () => {
  assert.equal(deriveRegime([100, 101, 102, 103], 3), "trending_up");
});

test("deriveRegime: returns 'trending_down' when all strikes decrease", () => {
  assert.equal(deriveRegime([103, 102, 101, 100], 3), "trending_down");
});

test("deriveRegime: returns 'ranging' on mixed moves", () => {
  assert.equal(deriveRegime([100, 102, 101, 103], 3), "ranging");
});

test("deriveRegime: uses only last windowCount points", () => {
  // First half goes down, but last 3 go up → trending_up
  const strikes = [200, 150, 100, 101, 102, 103];
  assert.equal(deriveRegime(strikes, 3), "trending_up");
});

// ---------------------------------------------------------------------------
// buildStreakSnapshot — snapshot filter for persistence
// ---------------------------------------------------------------------------

test("buildStreakSnapshot: excludes entry with consecutiveLosses=0 and no pause (win-cleared)", () => {
  const state = new Map<string, CoinStreakEntry>([
    ["BTC", { consecutiveLosses: 0, pauseUntilWindowKey: null }],
  ]);
  const snap = buildStreakSnapshot(state);
  assert.deepEqual(snap, {}, "win-cleared entry must NOT appear in snapshot");
});

test("buildStreakSnapshot: includes entry with consecutiveLosses > 0", () => {
  const state = new Map<string, CoinStreakEntry>([
    ["ETH", { consecutiveLosses: 2, pauseUntilWindowKey: null }],
  ]);
  const snap = buildStreakSnapshot(state);
  assert.ok("ETH" in snap);
  assert.equal(snap["ETH"].consecutiveLosses, 2);
  assert.equal(snap["ETH"].pauseUntilWindowKey, null);
});

test("buildStreakSnapshot: includes entry with active pause even when consecutiveLosses=0", () => {
  const state = new Map<string, CoinStreakEntry>([
    ["DOGE", { consecutiveLosses: 0, pauseUntilWindowKey: "2099-01-01T00:00" }],
  ]);
  const snap = buildStreakSnapshot(state);
  assert.ok("DOGE" in snap);
  assert.equal(snap["DOGE"].pauseUntilWindowKey, "2099-01-01T00:00");
});

test("buildStreakSnapshot: mixed map — only non-trivial entries appear", () => {
  const state = new Map<string, CoinStreakEntry>([
    ["BTC",  { consecutiveLosses: 0, pauseUntilWindowKey: null }],
    ["ETH",  { consecutiveLosses: 1, pauseUntilWindowKey: null }],
    ["DOGE", { consecutiveLosses: 0, pauseUntilWindowKey: "2099-01-01T00:00" }],
  ]);
  const snap = buildStreakSnapshot(state);
  assert.ok(!("BTC" in snap),  "BTC (trivial) must be excluded");
  assert.ok("ETH" in snap,     "ETH (loss streak) must be included");
  assert.ok("DOGE" in snap,    "DOGE (paused) must be included");
});

// ---------------------------------------------------------------------------
// restoreStreakState — expiry logic on startup load
// ---------------------------------------------------------------------------

test("restoreStreakState: active pause (nowWindowKey <= pauseUntilWindowKey) is preserved", () => {
  const saved: Record<string, CoinStreakEntry> = {
    BTC: { consecutiveLosses: 3, pauseUntilWindowKey: "2026-07-03T10:15" },
  };
  const now = "2026-07-03T10:00"; // earlier than pause key
  const { state, clearedSyms } = restoreStreakState(saved, now);
  const entry = state.get("BTC");
  assert.ok(entry, "BTC must be present after restore");
  assert.equal(entry!.pauseUntilWindowKey, "2026-07-03T10:15", "active pause must be kept");
  assert.equal(entry!.consecutiveLosses, 3);
  assert.deepEqual(clearedSyms, [], "no syms should have been cleared");
});

test("restoreStreakState: pause at exact same window key as now is expired (boundary — nowKey === pauseKey)", () => {
  // Spec: expired = pauseUntilWindowKey <= currentWindowKey.
  // At equality the coin resumes betting this window → pause must be cleared.
  const saved: Record<string, CoinStreakEntry> = {
    ETH: { consecutiveLosses: 3, pauseUntilWindowKey: "2026-07-03T10:00" },
  };
  const now = "2026-07-03T10:00"; // equal → pause has expired
  const { state, clearedSyms } = restoreStreakState(saved, now);
  assert.equal(state.get("ETH")!.pauseUntilWindowKey, null, "pause at exact current window must be cleared");
  assert.ok(clearedSyms.includes("ETH"), "ETH must appear in clearedSyms");
});

test("restoreStreakState: expired pause (nowWindowKey > pauseUntilWindowKey) is auto-cleared", () => {
  const saved: Record<string, CoinStreakEntry> = {
    BTC: { consecutiveLosses: 3, pauseUntilWindowKey: "2026-07-03T09:45" },
  };
  const now = "2026-07-03T10:00"; // later than pause key → expired
  const { state, clearedSyms } = restoreStreakState(saved, now);
  const entry = state.get("BTC");
  assert.ok(entry, "BTC must still be present");
  assert.equal(entry!.pauseUntilWindowKey, null, "expired pause must be cleared");
  assert.ok(clearedSyms.includes("BTC"), "BTC must appear in clearedSyms");
});

test("restoreStreakState: multiple coins — active pauses kept, expired pauses cleared", () => {
  const saved: Record<string, CoinStreakEntry> = {
    BTC:  { consecutiveLosses: 3, pauseUntilWindowKey: "2026-07-03T10:15" }, // future → keep
    ETH:  { consecutiveLosses: 2, pauseUntilWindowKey: "2026-07-03T09:45" }, // past   → clear
    DOGE: { consecutiveLosses: 1, pauseUntilWindowKey: null },                // no pause
  };
  const now = "2026-07-03T10:00";
  const { state, clearedSyms } = restoreStreakState(saved, now);
  assert.equal(state.get("BTC")!.pauseUntilWindowKey,  "2026-07-03T10:15", "BTC pause must be kept");
  assert.equal(state.get("ETH")!.pauseUntilWindowKey,  null,               "ETH pause must be cleared");
  assert.equal(state.get("DOGE")!.pauseUntilWindowKey, null,               "DOGE has no pause");
  assert.ok(clearedSyms.includes("ETH"),  "ETH in clearedSyms");
  assert.ok(!clearedSyms.includes("BTC"), "BTC not in clearedSyms");
  assert.ok(!clearedSyms.includes("DOGE"), "DOGE not in clearedSyms");
});

test("restoreStreakState: symbol keys are uppercased on restore", () => {
  const saved: Record<string, CoinStreakEntry> = {
    btc: { consecutiveLosses: 2, pauseUntilWindowKey: null },
  };
  const { state } = restoreStreakState(saved, "2026-07-03T10:00");
  assert.ok(state.has("BTC"), "lowercase key must be uppercased");
  assert.ok(!state.has("btc"), "original case key must not be present");
});

test("restoreStreakState: entry with no pause and no losses is restored (not filtered)", () => {
  // restoreStreakState faithfully restores whatever was saved; filtering at persist time
  // is buildStreakSnapshot's job — it would never save this entry in the first place.
  const saved: Record<string, CoinStreakEntry> = {
    SOL: { consecutiveLosses: 0, pauseUntilWindowKey: null },
  };
  const { state } = restoreStreakState(saved, "2026-07-03T10:00");
  assert.ok(state.has("SOL"), "trivial entry in saved snapshot is still restored");
});


// ---------------------------------------------------------------------------
// Minimum-return (payout multiple) gate
// ---------------------------------------------------------------------------

test("min-return gate: off (undefined) allows deep-ITM BET_NO", () => {
  // yesPrice 0.08 → NO cost 0.92 → return ~1.09x. No gate → bet proceeds.
  // claudeAbove: false so ML has a validator (NO direction, both agree).
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, claudeAbove: false, yesPrice: 0.08 }));
  assert.equal(r.action, "BET_NO");
});

test("min-return gate: 1.44x skips deep-ITM BET_NO (cost 92c, ret 1.09x)", () => {
  // claudeAbove: false provides the required validator so ML-solo gate passes.
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, claudeAbove: false, yesPrice: 0.08, minReturnMultiple: 1.44 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /Return 1\.09x below minimum 1\.44x/);
});

test("min-return gate: 1.44x skips deep-ITM BET_YES (cost 92c)", () => {
  // claudeAbove: true provides the required validator so ML-solo gate passes.
  const r = computeCorePairDecision(inp({ mlAbove: true, mlConfidence: 70, claudeAbove: true, yesPrice: 0.92, minReturnMultiple: 1.44 }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /below minimum 1\.44x/);
});

test("min-return gate: 1.44x allows a cheap bet (cost 50c, ret 2x)", () => {
  // claudeAbove: false provides the required validator so ML-solo gate passes.
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, claudeAbove: false, yesPrice: 0.50, minReturnMultiple: 1.44 }));
  assert.equal(r.action, "BET_NO");
});

test("min-return gate: return exactly at threshold passes (2x floor, 2x bet)", () => {
  // yesPrice 0.50 → NO cost 0.50 → return exactly 2.0x, not below 2.0 → allowed.
  // claudeAbove: false provides the required validator so ML-solo gate passes.
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, claudeAbove: false, yesPrice: 0.50, minReturnMultiple: 2.0 }));
  assert.equal(r.action, "BET_NO");
});

test("min-return gate: floor of 1 is treated as off", () => {
  // claudeAbove: false provides the required validator so ML-solo gate passes.
  const r = computeCorePairDecision(inp({ mlAbove: false, mlConfidence: 70, claudeAbove: false, yesPrice: 0.08, minReturnMultiple: 1 }));
  assert.equal(r.action, "BET_NO");
});

// checkMinReturnGate — the shared pure helper used by every decision mode
// (classic, ml_gate, consensus, unanimous). Testing it directly proves the
// mode-level guards behave correctly without mocking the I/O wrapper.

test("checkMinReturnGate: floor ≤ 1 disables the gate", () => {
  assert.equal(checkMinReturnGate("BET_NO", 0.08, 1).blocked, false);
  assert.equal(checkMinReturnGate("BET_YES", 0.92, undefined).blocked, false);
});

test("checkMinReturnGate: SKIP action is never blocked", () => {
  assert.equal(checkMinReturnGate("SKIP", 0.92, 1.44).blocked, false);
});

test("checkMinReturnGate: blocks deep-ITM BET_NO below floor", () => {
  const g = checkMinReturnGate("BET_NO", 0.08, 1.44); // NO cost 0.92 → 1.09x
  assert.equal(g.blocked, true);
  assert.match(g.reason, /Return 1\.09x below minimum 1\.44x/);
});

test("checkMinReturnGate: allows a bet at/above the floor", () => {
  assert.equal(checkMinReturnGate("BET_NO", 0.50, 1.44).blocked, false); // 2x
  assert.equal(checkMinReturnGate("BET_NO", 0.50, 2.0).blocked, false);  // exactly 2x
});

test("checkMinReturnGate: null yes-price is NOT blocked even when gate is active", () => {
  // The decision-time cache price is frequently null; the market order fills at
  // the real price at placement time, so the gate must not skip on null.
  const g = checkMinReturnGate("BET_YES", null, 1.44);
  assert.equal(g.blocked, false);
});

test("checkMinReturnGate: null yes-price is allowed when gate is off", () => {
  assert.equal(checkMinReturnGate("BET_YES", null, 1).blocked, false);
});

// ---------------------------------------------------------------------------
// DEFAULT_BOT_CONFIG defaults
// ---------------------------------------------------------------------------

test("DEFAULT_BOT_CONFIG: minReturnMultiple default is 1.45", () => {
  assert.equal(DEFAULT_BOT_CONFIG.minReturnMultiple, 1.45);
});

test("DEFAULT_BOT_CONFIG: minNoEntryMinutes default is 1", () => {
  assert.equal(DEFAULT_BOT_CONFIG.minNoEntryMinutes, 1);
});

// ---------------------------------------------------------------------------
// applyClaudeLiveOverride — live direction cache override for Claude signal
// ---------------------------------------------------------------------------

test("applyClaudeLiveOverride: no cache entry → opening value, isLive=false, flipped=false", () => {
  const r = applyClaudeLiveOverride(true, 1000, undefined);
  assert.equal(r.claudeAbove, true);
  assert.equal(r.isLive, false);
  assert.equal(r.flipped, false);
});

test("applyClaudeLiveOverride: cache entry older than opening snap → not overridden", () => {
  const r = applyClaudeLiveOverride(
    true,
    2000, // opening snap at t=2000
    { at: 1500, result: { aboveKalshi: false } }, // cache at t=1500 (older)
  );
  assert.equal(r.claudeAbove, true); // opening preserved
  assert.equal(r.isLive, false);
  assert.equal(r.flipped, false);
});

test("applyClaudeLiveOverride: live result is null → not overridden", () => {
  const r = applyClaudeLiveOverride(
    true,
    1000,
    { at: 2000, result: { aboveKalshi: null } },
  );
  assert.equal(r.claudeAbove, true);
  assert.equal(r.isLive, false);
  assert.equal(r.flipped, false);
});

test("applyClaudeLiveOverride: live newer, same direction → isLive=true, flipped=false", () => {
  const r = applyClaudeLiveOverride(
    true,
    1000,
    { at: 2000, result: { aboveKalshi: true } },
  );
  assert.equal(r.claudeAbove, true);
  assert.equal(r.isLive, true);
  assert.equal(r.flipped, false);
});

test("applyClaudeLiveOverride: live newer, contradicts opening → isLive=true, flipped=true", () => {
  const r = applyClaudeLiveOverride(
    true,  // opening said above
    1000,
    { at: 2000, result: { aboveKalshi: false } }, // live says below
  );
  assert.equal(r.claudeAbove, false); // live wins
  assert.equal(r.isLive, true);
  assert.equal(r.flipped, true);
});

test("applyClaudeLiveOverride: opening null + live true → isLive=true, flipped=false (no opening to flip)", () => {
  const r = applyClaudeLiveOverride(
    null, // opening was absent
    0,
    { at: 2000, result: { aboveKalshi: true } },
  );
  assert.equal(r.claudeAbove, true);
  assert.equal(r.isLive, true);
  assert.equal(r.flipped, false); // null opening cannot produce a flip
});

test("applyClaudeLiveOverride: live exactly at opening snapAt timestamp → not overridden (must be strictly newer)", () => {
  const r = applyClaudeLiveOverride(
    true,
    5000,
    { at: 5000, result: { aboveKalshi: false } }, // same ms, not newer
  );
  assert.equal(r.claudeAbove, true); // opening preserved
  assert.equal(r.isLive, false);
});

// ---------------------------------------------------------------------------
// applyStatPredCacheOverride — mid-snap predCache override for stat signal
// ---------------------------------------------------------------------------

test("applyStatPredCacheOverride: no cache entry → opening value, isLive=false", () => {
  const now = Date.now();
  const r = applyStatPredCacheOverride(true, 0, undefined, 50000, now);
  assert.equal(r.statAbove, true);
  assert.equal(r.isLive, false);
  assert.equal(r.flipped, false);
});

test("applyStatPredCacheOverride: cache older than opening snap → not overridden", () => {
  const now = Date.now();
  const r = applyStatPredCacheOverride(
    true,
    now - 60_000, // opening snap 60s ago
    { at: now - 90_000, value: { price: 40000, kalshiTarget: 50000 } }, // cache even older
    null,
    now,
  );
  assert.equal(r.statAbove, true); // opening preserved
  assert.equal(r.isLive, false);
});

test("applyStatPredCacheOverride: cache too old (>10 min) → not overridden", () => {
  const now = Date.now();
  const r = applyStatPredCacheOverride(
    true,
    now - 12 * 60_000, // opening snap 12 min ago
    { at: now - 11 * 60_000, value: { price: 40000, kalshiTarget: 50000 } }, // cache 11 min old — over limit
    null,
    now,
  );
  assert.equal(r.statAbove, true);
  assert.equal(r.isLive, false);
});

test("applyStatPredCacheOverride: no kalshiTarget in entry or argument → not overridden", () => {
  const now = Date.now();
  const r = applyStatPredCacheOverride(
    true,
    now - 60_000,
    { at: now - 30_000, value: { price: 60000, kalshiTarget: null } },
    null, // also no fallback
    now,
  );
  assert.equal(r.statAbove, true);
  assert.equal(r.isLive, false);
});

test("applyStatPredCacheOverride: opening snap exists (non-null) → always returns opening value, isLive=false", () => {
  // The predCache stores the LIVE price, not a model forecast.  Once the stat
  // opening snap has fired (openingAbove !== null), trust the model prediction
  // and never override it with a raw livePrice >= target comparison.
  const now = Date.now();
  const rAbove = applyStatPredCacheOverride(
    true, // opening said ABOVE
    now - 60_000,
    { at: now - 30_000, value: { price: 60000, kalshiTarget: 59000 } },
    null,
    now,
  );
  assert.equal(rAbove.statAbove, true);   // opening preserved
  assert.equal(rAbove.isLive, false);     // not from live-price override
  assert.equal(rAbove.flipped, false);

  const rBelow = applyStatPredCacheOverride(
    true, // opening said ABOVE — predCache says below, but opening wins
    now - 60_000,
    { at: now - 30_000, value: { price: 58000, kalshiTarget: 59000 } }, // price < target
    null,
    now,
  );
  assert.equal(rBelow.statAbove, true);   // opening preserved despite contrary live price
  assert.equal(rBelow.isLive, false);
  assert.equal(rBelow.flipped, false);

  const rBelow2 = applyStatPredCacheOverride(
    false, // opening said BELOW — predCache says above, but opening wins
    now - 60_000,
    { at: now - 30_000, value: { price: 59000, kalshiTarget: 59000 } }, // price === target
    null,
    now,
  );
  assert.equal(rBelow2.statAbove, false);  // opening preserved
  assert.equal(rBelow2.isLive, false);
  assert.equal(rBelow2.flipped, false);
});

test("applyStatPredCacheOverride: uses entry.value.kalshiTarget when argument is null", () => {
  const now = Date.now();
  const r = applyStatPredCacheOverride(
    null,
    now - 60_000,
    { at: now - 30_000, value: { price: 60000, kalshiTarget: 59500, predictions: [{ predictedPrice: 60000 }] } },
    null, // no fallback target — must use entry's
    now,
  );
  assert.equal(r.statAbove, true); // 60000 > 59500
  assert.equal(r.isLive, true);
});

test("applyStatPredCacheOverride: opening null → flipped=false even when direction changes", () => {
  const now = Date.now();
  const r = applyStatPredCacheOverride(
    null, // no opening signal
    now - 60_000,
    { at: now - 30_000, value: { price: 59500, kalshiTarget: 59000, predictions: [{ predictedPrice: 58000 }] } },
    null,
    now,
  );
  assert.equal(r.statAbove, false); // predictedPrice 58000 < target 59000
  assert.equal(r.isLive, true);
  assert.equal(r.flipped, false); // null opening → no flip to detect
});

test("applyStatPredCacheOverride: opening null, no predictions in entry → statAbove null (no live-price fallback)", () => {
  // Before the snap fires, the predCache only has a live spot price.
  // Using live price as a stat signal diverges from the predictor page (which uses
  // the model's forward prediction).  Return null instead of a misleading live comparison.
  const now = Date.now();
  const r = applyStatPredCacheOverride(
    null,
    now - 60_000,
    { at: now - 30_000, value: { price: 60000, kalshiTarget: 59500 } }, // no predictions field
    null,
    now,
  );
  assert.equal(r.statAbove, null); // no forward prediction → no stat signal
  assert.equal(r.isLive, false);
});

test("applyStatPredCacheOverride: opening null, predictedPrice BELOW target → statAbove false", () => {
  // Model predicts fall below target even when live price is currently above.
  // The stat signal should match the model (BELOW), not the live position (ABOVE).
  const now = Date.now();
  const r = applyStatPredCacheOverride(
    null,
    now - 60_000,
    { at: now - 30_000, value: { price: 60200, kalshiTarget: 60000, predictions: [{ predictedPrice: 59800 }] } },
    null,
    now,
  );
  assert.equal(r.statAbove, false); // predictedPrice 59800 < target 60000
  assert.equal(r.isLive, true);
});

// ---------------------------------------------------------------------------
// shouldDeferForLiveSignal — staleness gate with max-defer fallback
// ---------------------------------------------------------------------------

const MAX_AGE_MS  = 2 * 60_000; // 2 min — production value
const MAX_DEFER_S = 90;          // 90 s past buffer — production value

test("shouldDeferForLiveSignal: fresh cache → no defer, no fallback", () => {
  const nowMs = Date.now();
  const entry = { at: nowMs - 30_000 }; // 30 s old → well within 2-min window
  const r = shouldDeferForLiveSignal(entry, nowMs, MAX_AGE_MS, 10, MAX_DEFER_S);
  assert.equal(r.defer, false);
  assert.equal(r.usedFallback, false);
});

test("shouldDeferForLiveSignal: cache exactly at age limit → still fresh (≤ boundary)", () => {
  const nowMs = Date.now();
  const entry = { at: nowMs - MAX_AGE_MS }; // exactly at limit → still ok
  const r = shouldDeferForLiveSignal(entry, nowMs, MAX_AGE_MS, 10, MAX_DEFER_S);
  assert.equal(r.defer, false, "boundary: at maxAgeMs is still fresh");
  assert.equal(r.usedFallback, false);
});

test("shouldDeferForLiveSignal: stale cache, well within defer window → defer=true (tick 1)", () => {
  // Simulates the first tick after buffer clears: cache 5 min old (well stale),
  // but only 5 s have elapsed since the buffer cleared → should defer once.
  const nowMs = Date.now();
  const entry = { at: nowMs - 5 * 60_000 }; // 5 min old — stale
  const r = shouldDeferForLiveSignal(entry, nowMs, MAX_AGE_MS, 5, MAX_DEFER_S);
  assert.equal(r.defer, true,  "first-tick defer: cache stale, within max-defer window");
  assert.equal(r.usedFallback, false);
});

test("shouldDeferForLiveSignal: stale cache, retry tick with now-fresh cache → proceeds (no defer)", () => {
  // Simulates the retry tick after Claude responds: cache updated 10 s ago → fresh.
  const nowMs = Date.now();
  const freshEntry = { at: nowMs - 10_000 }; // 10 s old — fresh
  const r = shouldDeferForLiveSignal(freshEntry, nowMs, MAX_AGE_MS, 35, MAX_DEFER_S);
  assert.equal(r.defer, false, "retry tick: fresh cache — proceed to decision");
  assert.equal(r.usedFallback, false);
});

test("shouldDeferForLiveSignal: no cache entry, within defer window → defer=true", () => {
  // Empty cache (Claude has never responded this window yet), early tick.
  const r = shouldDeferForLiveSignal(undefined, Date.now(), MAX_AGE_MS, 5, MAX_DEFER_S);
  assert.equal(r.defer, true);
  assert.equal(r.usedFallback, false);
});

test("shouldDeferForLiveSignal: permanently stale cache, beyond max-defer → fallback (no defer)", () => {
  // Claude API has been down since window open.  After 90 s past the buffer
  // the gate gives up and falls through so the bet is not blocked indefinitely.
  const nowMs = Date.now();
  const staleEntry = { at: nowMs - 10 * 60_000 }; // 10 min old — very stale
  const r = shouldDeferForLiveSignal(staleEntry, nowMs, MAX_AGE_MS, MAX_DEFER_S, MAX_DEFER_S);
  assert.equal(r.defer, false,       "max-defer elapsed — must not keep deferring");
  assert.equal(r.usedFallback, true, "usedFallback=true so caller can log the event");
});

test("shouldDeferForLiveSignal: empty cache, beyond max-defer → fallback (no defer)", () => {
  // No cache at all and max-defer elapsed — must fall through to opening snap.
  const r = shouldDeferForLiveSignal(undefined, Date.now(), MAX_AGE_MS, MAX_DEFER_S + 1, MAX_DEFER_S);
  assert.equal(r.defer, false);
  assert.equal(r.usedFallback, true);
});

test("shouldDeferForLiveSignal: stale cache, exactly at max-defer boundary → fallback fires", () => {
  // secondsPastBuffer === maxDeferSeconds → the >= boundary gives up immediately.
  const nowMs = Date.now();
  const entry = { at: nowMs - 5 * 60_000 };
  const r = shouldDeferForLiveSignal(entry, nowMs, MAX_AGE_MS, MAX_DEFER_S, MAX_DEFER_S);
  assert.equal(r.defer, false);
  assert.equal(r.usedFallback, true, "exactly at boundary triggers fallback");
});

test("shouldDeferForLiveSignal: stale cache, one second before max-defer → still deferring", () => {
  // One second shy of max-defer → should still defer this tick.
  const nowMs = Date.now();
  const entry = { at: nowMs - 5 * 60_000 };
  const r = shouldDeferForLiveSignal(entry, nowMs, MAX_AGE_MS, MAX_DEFER_S - 1, MAX_DEFER_S);
  assert.equal(r.defer, true,  "one second before max-defer — still deferring");
  assert.equal(r.usedFallback, false);
});

// ---------------------------------------------------------------------------
// Stat flip downstream effect on computeCorePairDecision
//
// These tests verify that applyStatPredCacheOverride's output, when fed into
// computeCorePairDecision, produces the correct bet decision — specifically
// that a mid-window stat flip never incorrectly blocks a bet that should go
// through via a tiebreaker signal.
// ---------------------------------------------------------------------------

test("stat flip downstream: flip above→below + Claude=below → BET_NO (agree on new direction)", () => {
  // Opening: stat=above.  Mid-snap flips stat to below.  Claude also says below.
  // Both signals agree on below → should BET_NO, not SKIP.
  const r = computeCorePairDecision(inp({ claudeAbove: false, statAbove: false }));
  assert.equal(r.action, "BET_NO", "agreed-below after flip must bet NO, not SKIP");
});

test("stat flip downstream: flip above→below + Claude=above, ML=null → SKIP (genuine disagreement)", () => {
  // Stat has flipped to below but Claude still says above.  No ML to arbitrate.
  // PATH B: Claude≠Stat, no ML → SKIP (correct — genuine conflicting reads).
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: false, mlAbove: null }));
  assert.equal(r.action, "SKIP");
  assert.match(r.reasoning, /no ML to arbitrate/);
});

test("stat flip downstream: flip above→below + Claude=above + ML=above → BET_YES (ML tiebreaker)", () => {
  // Stat has flipped to below, but Claude + ML both say above → 2-of-3 vote.
  // PATH B tiebreaker: ML sides with Claude → bet proceeds in the YES direction.
  // The stat flip must NOT block the entry when other signals have the quorum.
  const r = computeCorePairDecision(inp({
    claudeAbove: true,
    statAbove: false,  // stat has been flipped to below
    mlAbove: true,
    mlConfidence: 55,  // below ML_PRIMARY_MIN_CONFIDENCE → PATH B (Claude leads)
  }));
  assert.equal(r.action, "BET_YES", "ML tiebreaker with Claude must override a lone dissenting stat flip");
  assert.equal(r.confidence, BASE_CONFIDENCE_HALF_PAIR, "half-pair base since stat dissents");
});

test("stat flip downstream: no flip (stat stays above) + Claude=above → BET_YES unchanged", () => {
  // Sanity check: when stat does NOT flip, normal PATH B full-pair behaviour.
  const r = computeCorePairDecision(inp({ claudeAbove: true, statAbove: true }));
  assert.equal(r.action, "BET_YES");
  assert.equal(r.confidence, BASE_CONFIDENCE_FULL_PAIR);
});

test("stat flip downstream: flip above→below + ML=above (PATH A, stat dissents) → BET_YES with dissent penalty", () => {
  // ML leads (PATH A).  Stat has been flipped to below (dissents).
  // Expected: ML+Claude boost partially cancelled by stat dissent (net zero on those two).
  const r = computeCorePairDecision(inp({
    mlAbove: true,
    mlConfidence: ML_PRIMARY_MIN_CONFIDENCE,
    claudeAbove: true,   // Claude agrees with ML
    statAbove: false,    // stat has flipped to below (dissents)
  }));
  assert.equal(r.action, "BET_YES");
  // Claude agrees: +ML_SIGNAL_BOOST; Stat disagrees: −DISSENT_PENALTY; net = 0 → base stays
  assert.equal(r.confidence, ML_PRIMARY_MIN_CONFIDENCE, "ML_SIGNAL_BOOST and DISSENT_PENALTY cancel → net confidence = base");
});

// ---------------------------------------------------------------------------
// Stat flip → Claude re-check scenarios
// ---------------------------------------------------------------------------

test("applyStatPredCacheOverride: opening snap non-null → opening preserved even when mid-snap contradicts (Claude re-check uses tracker, not predCache)", () => {
  // With the live-price override removed for non-null openings, the predCache can no
  // longer silently flip the stat signal.  Claude re-checks are now driven by the
  // tracker's own divergence logic (crypto-tracker.ts), not by this function.
  const now = Date.now();
  const r = applyStatPredCacheOverride(
    true,            // opening: price was above strike
    now - 7 * 60_000, // opening snap 7 min ago
    { at: now - 30_000, value: { price: 97_000, kalshiTarget: 98_000 } }, // mid-snap: price < strike
    null,
    now,
  );
  assert.equal(r.statAbove, true);   // opening prediction preserved — no flip via predCache
  assert.equal(r.isLive, false);
  assert.equal(r.flipped, false);     // no flip detected
});

// ---------------------------------------------------------------------------
// checkSignalDivergenceCutout — pure divergence cutout logic
// ---------------------------------------------------------------------------

import {
  checkSignalDivergenceCutout,
  DIVERGENCE_MAX_MINUTES,
  DIVERGENCE_MIN_SIGNALS_FLIPPED,
  DIVERGENCE_PRICE_FLOOR_MULT,
} from "./kalshi-bot-engine-core.ts";

const defaultEntry = { statAbove: true, claudeAbove: true, mlAbove: true };
const ENTRY_PRICE = 0.60;

test("divergence: all three signals flip for YES bet → triggered", () => {
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: true, claudeAbove: true, mlAbove: true },
    false, false, false,
  );
  assert.equal(r.triggered, true);
  assert.match(r.reason, /Signal divergence/);
  assert.match(r.reason, /stat/);
  assert.match(r.reason, /claude/);
  assert.match(r.reason, /ml/);
});

test("divergence: exactly 2 signals flip → triggered", () => {
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: true, claudeAbove: true, mlAbove: true },
    false, false, true,
  );
  assert.equal(r.triggered, true);
});

test("divergence: only 1 signal flips → not triggered", () => {
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: true, claudeAbove: true, mlAbove: true },
    false, true, true,
  );
  assert.equal(r.triggered, false);
  assert.match(r.reason, /1\/2 signals flipped/);
});

test("divergence: minutesElapsed >= DIVERGENCE_MAX_MINUTES → not triggered", () => {
  const r = checkSignalDivergenceCutout(
    "yes", DIVERGENCE_MAX_MINUTES, 0.40, ENTRY_PRICE,
    defaultEntry, false, false, false,
  );
  assert.equal(r.triggered, false);
  assert.match(r.reason, /beyond early window/);
});

test("divergence: price below floor → not triggered even if signals flipped", () => {
  const floorPrice = ENTRY_PRICE * DIVERGENCE_PRICE_FLOOR_MULT - 0.01; // just below floor
  const r = checkSignalDivergenceCutout(
    "yes", 3, floorPrice, ENTRY_PRICE,
    defaultEntry, false, false, false,
  );
  assert.equal(r.triggered, false);
  assert.match(r.reason, /not enough value to exit/);
});

test("divergence: price at exactly floor → triggered (≥ floor means allowed to exit)", () => {
  const floorPrice = ENTRY_PRICE * DIVERGENCE_PRICE_FLOOR_MULT;
  const r = checkSignalDivergenceCutout(
    "yes", 3, floorPrice, ENTRY_PRICE,
    defaultEntry, false, false, false,
  );
  assert.equal(r.triggered, true, "at exactly floor contract value (not strictly below), exit is allowed");
});

test("divergence: price just above floor → triggered when signals flipped", () => {
  const aboveFloor = ENTRY_PRICE * DIVERGENCE_PRICE_FLOOR_MULT + 0.01;
  const r = checkSignalDivergenceCutout(
    "yes", 3, aboveFloor, ENTRY_PRICE,
    defaultEntry, false, false, false,
  );
  assert.equal(r.triggered, true);
});

test("divergence: null entry signal is ignored (cannot flip)", () => {
  // statAbove=null at entry → stat cannot count as flipped
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: null, claudeAbove: true, mlAbove: true },
    false, false, false,
  );
  // Only claude + ml flip (2) → triggered
  assert.equal(r.triggered, true);
});

test("divergence: null current signal is ignored (unknown state)", () => {
  // claudeAbove currently null → cannot assess, ignore
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: true, claudeAbove: true, mlAbove: true },
    false, null, false,
  );
  // stat + ml flip (2) → triggered
  assert.equal(r.triggered, true);
});

test("divergence: all entry signals null → nothing can flip → not triggered", () => {
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.40, ENTRY_PRICE,
    { statAbove: null, claudeAbove: null, mlAbove: null },
    false, false, false,
  );
  assert.equal(r.triggered, false);
});

test("divergence: NO bet — signals flip when entry was false and now true", () => {
  const r = checkSignalDivergenceCutout(
    "no", 3, 0.65, 0.35, // NO entry: yesPrice=0.35 → NO contract cost = 1-0.35 = 0.65
    { statAbove: false, claudeAbove: false, mlAbove: false },
    true, true, false,
  );
  // stat + claude flipped (were false, now true, against NO bet) → triggered
  assert.equal(r.triggered, true);
  assert.match(r.reason, /stat/);
  assert.match(r.reason, /claude/);
});

test("divergence: NO bet price floor uses NO contract value (1 - yesPrice)", () => {
  // NO entry: entryYesPrice = 0.30 → NO contract value = 0.70
  // floor = 0.70 * 0.50 = 0.35 (in NO terms)
  // If yesPrice is now 0.68 → NO value = 0.32 < 0.35 → below floor
  const r = checkSignalDivergenceCutout(
    "no", 3, 0.68, 0.30,
    { statAbove: false, claudeAbove: false, mlAbove: false },
    true, true, true,
  );
  assert.equal(r.triggered, false, "NO contract value below floor — should not trigger");
});

test("divergence: signal that was FOR bet and stays FOR bet → no flip counted", () => {
  // Stat stays supporting the YES bet (was true, still true)
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.50, ENTRY_PRICE,
    { statAbove: true, claudeAbove: true, mlAbove: true },
    true, false, false,
  );
  // Only claude + ml flipped → 2/2 → triggered
  assert.equal(r.triggered, true);
});

test("divergence: signal that was AGAINST bet at entry cannot flip (only supporting signals can flip)", () => {
  // Entry: statAbove=false for YES bet (was opposing already) — cannot flip against
  const r = checkSignalDivergenceCutout(
    "yes", 3, 0.50, ENTRY_PRICE,
    { statAbove: false, claudeAbove: true, mlAbove: true },
    false, false, false,
  );
  // stat was already against (entry false) → not counted; only claude+ml flipped → 2
  assert.equal(r.triggered, true);
  assert.match(r.reason, /claude/);
  assert.match(r.reason, /ml/);
});

test("divergence: currentYesPrice=null → not triggered (cannot verify price floor, must hold)", () => {
  const r = checkSignalDivergenceCutout(
    "yes", 3, null, ENTRY_PRICE,
    defaultEntry, false, false, false,
  );
  assert.equal(r.triggered, false, "null price → price floor unverifiable → hold, do not exit");
  assert.match(r.reason, /unavailable/);
});

test("stale Claude override from prior window is evicted when stat flips — applyClaudeLiveOverride ignores prior-window entry", () => {
  // Scenario: stat flips at T+7. The liveDirectionCache entry was written at
  // window-open (T+1) and is OLDER than the mid-snap opening-snap timestamp
  // we treat as the new reference point (the opening snap itself, taken at T+1).
  //
  // After the stat flip, crypto-tracker.ts deletes the liveDirectionCache entry.
  // Before that delete completes (or if it hasn't yet), applyClaudeLiveOverride
  // must NOT surface an entry whose timestamp predates the opening snap — it
  // falls back to the opening Claude value instead, effectively evicting stale data.
  const openingSnapAtMs = Date.now() - 7 * 60_000; // opening snap was 7 min ago

  // Prior-window Claude entry: written BEFORE the opening snap (from last window)
  const staleEntry = { at: openingSnapAtMs - 60_000, result: { aboveKalshi: true as boolean | null } };

  const r = applyClaudeLiveOverride(
    false,          // opening Claude call said below
    openingSnapAtMs,
    staleEntry,     // cache entry is older than opening snap → must not override
  );

  assert.equal(r.claudeAbove, false); // opening value preserved — stale entry evicted
  assert.equal(r.isLive, false);
  assert.equal(r.flipped, false);
});
