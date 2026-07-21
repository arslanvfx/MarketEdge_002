// Pure backtest approval function — zero dependencies, no I/O.
//
// Mirrors the live engine's gating rules (kalshi-bot-engine.ts) so that
// backtestModeApproval stays in sync with makeBotDecision as the engine evolves.
//
// Backtest question: "given the signals stored at bet time, would mode X have
// placed THIS specific bet in the same direction?"
//
// classic   — yes, always (all existing bets passed the classic cascade)
// ml_gate   — simplified three-tier formula: ML leads direction, Claude and
//             Stat are confidence modifiers (no hard veto),
//             all three signals required (see computeMLGateDecision)
// consensus — majority of [stat, claude, ml] must agree; tie = SKIP = rejected
// unanimous — all 3 of [stat, claude, ml] must be available and unanimously agree

import { CLAUDE_BOOST, CLAUDE_PENALTY, STAT_BOOST, STAT_PENALTY } from "./kalshi-bot-engine-core.ts";

/**
 * Returns true if the given decision mode would have approved the bet,
 * false if it would have skipped it or would have bet the opposite direction.
 *
 * @param mode          Decision mode to test
 * @param aboveExpected true when the actual bet was BET_YES, false for BET_NO
 * @param statAbove     Stat signal stored at bet time  (null = not available)
 * @param claudeAbove   Claude signal stored at bet time
 * @param mlAbove       ML signal stored at bet time
 * @param statConf      Stat confidence stored at bet time (null on older rows)
 * @param claudeConf    Claude confidence stored at bet time (null on older rows)
 * @param mlConf        ML confidence stored at bet time (null on older rows)
 * @param minConfidence Composite floor to simulate for ml_gate; null = skip the
 *                      composite gate (historical per-bet config is unknown)
 */
export function backtestModeApproval(
  mode: string,
  aboveExpected: boolean,
  statAbove: boolean | null,
  claudeAbove: boolean | null,
  mlAbove: boolean | null,
  statConf: number | null = null,
  claudeConf: number | null = null,
  mlConf: number | null = null,
  minConfidence: number | null = null,
): boolean {
  // ── classic ───────────────────────────────────────────────────────────────
  // All existing settled bets passed the classic cascade by definition.
  if (mode === "classic") return true;

  // ── ml_gate ───────────────────────────────────────────────────────────────
  // Mirrors computeMLGateDecision (kalshi-bot-engine-core.ts) — the simplified
  // three-tier formula:
  //   1. Gate 1: all three signals must be available (bot waits otherwise).
  //   2. Direction = ML's direction; must match the actual bet direction.
  //   3. Composite gate: mlConf + (Claude agrees ? +CLAUDE_BOOST : −CLAUDE_PENALTY)
  //                               + (Stat agrees   ? +STAT_BOOST  : −STAT_PENALTY)
  //      Only simulated when minConfidence provided AND mlConf known (older rows
  //      lack confidences; skipping avoids misattributing history).
  if (mode === "ml_gate") {
    if (statAbove === null || claudeAbove === null || mlAbove === null) {
      return false; // Gate 1: any missing signal → the bot would still be waiting
    }

    if (mlAbove !== aboveExpected) return false; // ML leads — opposite direction

    // Composite gate — only simulated when minConfidence provided AND mlConf known.
    // Older rows lack confidence values; skipping the gate avoids misattributing history.
    if (minConfidence !== null && mlConf !== null) {
      const composite =
        mlConf +
        (claudeAbove === mlAbove ? CLAUDE_BOOST : -CLAUDE_PENALTY) +
        (statAbove   === mlAbove ? STAT_BOOST   : -STAT_PENALTY);
      if (composite < minConfidence) return false;
    }

    return true;
  }

  // ── consensus ─────────────────────────────────────────────────────────────
  // Mirrors kalshi-bot-engine.ts ~lines 263-313:
  //   - Collect votes from [stat, claude, ml].
  //   - < 2 available signals → warm-up fallback to classic.
  //   - Tie (equal yes/no votes) → SKIP.
  //   - Majority direction must match actual bet direction.
  if (mode === "consensus") {
    const available = ([statAbove, claudeAbove, mlAbove] as Array<boolean | null>)
      .filter((v): v is boolean => v !== null);

    if (available.length < 2) return true; // warm-up: fall back to classic

    const yesCount = available.filter(v => v === true).length;
    const noCount  = available.filter(v => v === false).length;

    if (yesCount === noCount) return false; // tie → consensus SKIPs

    const majorityDir = yesCount > noCount; // true = YES, false = NO
    return majorityDir === aboveExpected;   // must match actual bet direction
  }

  // ── unanimous ─────────────────────────────────────────────────────────────
  // All 3 signals must be available AND all must agree on the same direction.
  // Any missing signal or any disagreement → SKIP (no warm-up fallback).
  if (mode === "unanimous") {
    if (statAbove === null || claudeAbove === null || mlAbove === null) {
      return false; // any unavailable signal → SKIP
    }
    // All three must agree with the actual bet direction
    return statAbove === aboveExpected && claudeAbove === aboveExpected && mlAbove === aboveExpected;
  }

  // ── stat_ml ───────────────────────────────────────────────────────────────
  // Mirrors computeStatMLDecision (kalshi-bot-engine-core.ts):
  //   1. Both stat and ML signals must be present.
  //   2. Both must meet their confidence floors (53% stat, 57% ML).
  //   3. Both must agree on direction (requireBothAgree = true default).
  //   4. Direction must match the actual bet direction.
  // Price-dependent gates (min-return, orderbook) are omitted — historical
  // entry prices are not reliable enough to replay those checks accurately.
  if (mode === "stat_ml") {
    if (statAbove === null || mlAbove === null) return false; // Gate 1: both required
    const sc = statConf ?? 0;
    const mc = mlConf  ?? 0;
    if (sc < 53) return false; // Gate 2: stat floor
    if (mc < 57) return false; // Gate 2: ML floor
    if (statAbove !== mlAbove) return false; // Gate 3: must agree
    return statAbove === aboveExpected; // Gate 4: direction must match
  }

  // Unknown mode — approve by default so new modes don't silently disappear.
  return true;
}

// ---------------------------------------------------------------------------
// stat_ml floor-grid backtest helper
// ---------------------------------------------------------------------------
//
// Mirrors the core of computeStatMLDecision (kalshi-bot-engine-core.ts) but
// omits price-dependent gates (min-return, orderbook) since historical entry
// prices are not reliable enough to replay those checks accurately.
//
// Used by getStatMLFloorAnalysis to sweep (statFloor × mlFloor) grid over
// all settled bets and find the per-coin combination that maximises win rate.
//
// Returns: "bet_yes" | "bet_no" | "skip"
//   - "bet_yes" / "bet_no" — the mode would have taken the bet in that direction
//   - "skip"               — the mode would have passed on this window

export function backtestStatMLFloorApproval(
  aboveExpected: boolean,   // true = actual bet was BET_YES
  statAbove: boolean | null,
  mlAbove: boolean | null,
  statConf: number | null,
  mlConf: number | null,
  statFloor: number,        // minimum stat confidence (e.g. 53)
  mlFloor: number,          // minimum ML confidence (e.g. 67)
  requireBothAgree = true,  // mirrors statMLRequireBothAgree default
  minConfidence = 60,       // composite gate
): boolean {
  // Gate 1: both signals must be present
  if (statAbove === null || mlAbove === null) return false;

  const sc = statConf ?? 0;
  const mc = mlConf  ?? 0;

  // Gate 2: per-signal confidence floors
  if (sc < statFloor) return false;
  if (mc < mlFloor)   return false;

  // Gate 3: direction resolution
  const agree = statAbove === mlAbove;
  let direction: boolean;
  if (agree) {
    direction = statAbove;
  } else if (requireBothAgree) {
    return false; // disagree → SKIP
  } else {
    // Follow higher-confidence signal; tie → Stat
    direction = sc >= mc ? statAbove : mlAbove;
  }

  // Direction must match the actual bet
  if (direction !== aboveExpected) return false;

  // Gate 4: composite confidence
  // High-conf boost mirrors: +5pp when stat ≥ 58 AND ml ≥ 73
  const boost = sc >= 58 && mc >= 73 ? 5 : 0;
  const composite = Math.round(Math.min(mc * 0.65 + sc * 0.35 + boost, 100));
  if (composite < minConfidence) return false;

  return true;
}
